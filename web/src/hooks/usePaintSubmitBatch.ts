import { useCallback, useEffect, useRef, useState } from 'react'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import {
  useAccount,
  useCapabilities,
  usePublicClient,
  useSendCalls,
  useWaitForCallsStatus,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'

import { CANVAS_ADDRESS, canvasAbi } from '../contracts/canvas'
import { chunkDraft, type PaintChunk } from '../lib/chunkDraft'
import { decodeCanvasError, type DecodedCanvasError } from '../lib/decodeCanvasError'
import type { PaintDraft } from './usePaintDraft'
import { TILE_SIZE } from './useTilePixels'

// Matches Canvas.sol's BPS = 10_000.
const BPS = 10_000n

export interface PaintSubmitBatchArgs {
  draft: PaintDraft
  link: string
  referrer?: Address
  /**
   * Slippage-capped max TOTAL cost across every chunk, in native wei. The
   * hook divides this proportionally by pixel count to cap each chunk's
   * msg.value and maxTotalCost.
   */
  maxTotalCost: bigint
  /** Must equal `maxTotalCost`; total sent across all chunks. */
  value: bigint
  reserveMultiplierBps?: bigint
  /**
   * Hard chunk cap. Mirrored from Canvas.maxPixelsPerTx. Passed in rather
   * than hardcoded so raising the on-chain cap is a one-liner here.
   */
  maxPixelsPerTx: number
  /**
   * When true, pre-flight reads pixelAt for every pixel in the draft and
   * masks any pixel whose current on-chain color matches the draft as
   * transparent (high byte 0xFF). The contract skips transparent pixels
   * with no charge, so a retry after a partial paint pays only for the
   * pixels that actually changed. Worth the multicall round-trip when
   * the user is intentionally retrying; default off for fresh paints
   * where every pixel is dirty by definition.
   */
  skipUnchanged?: boolean
}

/**
 * Paint submission that handles both single-chunk and multi-chunk stamps.
 *
 *   - Stamp fits in one tx → useWriteContract path (one signature, one tx).
 *   - Stamp needs chunking → wallet capability check:
 *       - EIP-5792 `atomic: 'supported'` on this chain → useSendCalls (one
 *         signature, N txs broadcast as an atomic batch where the chain
 *         allows it).
 *       - Otherwise → sequential useWriteContract loop (N signatures).
 *
 * Progress is exposed so the UI can show "submitting chunk 3 of 7" for the
 * sequential path; the atomic path lands in one observable step.
 */
/**
 * Pre-flight: read pixelAt for every pixel in the draft and return a
 * new colors array where any pixel whose current on-chain color matches
 * the draft is masked transparent (high byte 0xFF). The contract skips
 * those pixels with no charge, making retries after partial paints
 * pay only for actually-dirty pixels.
 *
 * Cost: one multicall over (w*h) pixelAt reads. Multicall3 batches
 * them into a single RPC; for a 38x38 stamp (1,444 pixels) latency is
 * typically 200–500ms over a fast RPC.
 *
 * Note: this checks color match only. URL match would require resolving
 * the chain's linkId for our retry URL, which the registry doesn't
 * expose as a public view. If the user changed the URL between
 * attempts the unchanged-color pixels will still be masked transparent
 * — the chain's existing linkId stays attached, which is correct
 * (those pixels aren't being repainted, so their link is whatever was
 * already there). The masked pixels get NO link change. Pixels that
 * DO get repainted use the user's new link as part of the paint call.
 */
async function maskUnchangedPixels(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  draft: PaintDraft,
): Promise<{ colors: number[]; skipped: number }> {
  const { x, y, w, h, colors } = draft
  const reads = []
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      reads.push({
        address: CANVAS_ADDRESS,
        abi: canvasAbi,
        functionName: 'pixelAt' as const,
        args: [x + dx, y + dy] as const,
      })
    }
  }

  // multicall returns Result<T>[] where each entry is a status + value.
  // viem's wagmi-bundled multicall handles batching against Multicall3
  // automatically when the chain has it.
  const results = await publicClient.multicall({
    contracts: reads,
    allowFailure: true,
  })

  const masked = colors.slice()
  let skipped = 0
  for (let i = 0; i < masked.length; i++) {
    const r = results[i]
    if (!r || r.status !== 'success') continue
    // pixelAt returns (uint24 color, uint256 lastPrice, uint32 linkId).
    // An earlier version of this code assumed a fourth `lastPaintedAt`
    // field and read tuple[2] as if it were a timestamp — that's actually
    // linkId, so pixels with no link looked unpainted and pixels with a
    // link looked painted regardless of state. The right "is unpainted"
    // signal is lastPrice === 0n: the contract only stores a non-zero
    // lastPrice when a pixel has been written.
    const tuple = r.result as readonly [number, bigint, number]
    const currentColor = tuple[0]
    const lastPrice = tuple[1]
    if (lastPrice === 0n) continue // unpainted; must repaint
    // Compare 24-bit RGB only; high byte is the contract's transparency
    // marker and not stored.
    if ((currentColor & 0x00ffffff) === (masked[i] & 0x00ffffff)) {
      masked[i] = masked[i] | 0xff000000 // mark transparent → contract skips
      skipped++
    }
  }
  return { colors: masked, skipped }
}

export function usePaintSubmitBatch() {
  const { address, chainId } = useAccount()
  const queryClient = useQueryClient()
  const publicClient = usePublicClient()

  // Single-tx path (always available).
  const {
    writeContractAsync,
    data: writeHash,
    error: writeError,
    isPending: writePending,
    reset: resetWrite,
  } = useWriteContract()

  // Wait for the broadcast tx to actually mine. Previously we treated
  // "hash returned" as terminal success, which meant the UI skipped the
  // broadcast→mined window entirely — the button flipped from
  // "Confirm in wallet…" straight to "Tagged. Go again?" before the
  // transaction had even been included in a block. Now:
  //   writePending === true    → wallet prompt is open (status: 'pending')
  //   writeHash set + tx mining → status: 'confirming'
  //   receipt.isSuccess         → status: 'success'
  //   receipt.isError           → status: 'error'
  const {
    data: writeReceipt,
    isLoading: writeReceiptLoading,
    isSuccess: writeReceiptSuccess,
    error: writeReceiptError,
  } = useWaitForTransactionReceipt({
    hash: writeHash,
    query: { enabled: !!writeHash },
  })
  const writeConfirming = !!writeHash && writeReceiptLoading
  const writeConfirmed = !!writeHash && writeReceiptSuccess
  const writeConfirmError = writeError ?? writeReceiptError ?? null

  // Multi-tx path (EIP-5792). The hook is initialised even when we don't
  // need it; wagmi handles the no-op case.
  const {
    sendCallsAsync,
    data: sendCallsId,
    error: sendCallsError,
    isPending: sendCallsPending,
    reset: resetSendCalls,
  } = useSendCalls()

  const {
    data: callsStatus,
    isLoading: callsStatusLoading,
    error: callsStatusError,
  } = useWaitForCallsStatus({
    id: sendCallsId?.id,
  })

  // Feature-detect EIP-5792 + atomic support for the connected chain.
  // wagmi types `useCapabilities` as `{[chainId: string]: Capabilities}` or
  // (in some paths) per-chain; index by chainId after casting to a string.
  const { data: capabilities } = useCapabilities({
    account: address,
    chainId,
    query: { enabled: !!address && !!chainId },
  })
  const canAtomicBatch =
    chainId !== undefined &&
    (capabilities as Record<string | number, { atomic?: { status?: string } }> | undefined)?.[chainId]
      ?.atomic?.status === 'supported'

  const [state, setState] = useState<{
    status: 'idle' | 'pending' | 'confirming' | 'success' | 'error'
    progress: { done: number; total: number } | null
    hash: Hex | null
    decodedError: DecodedCanvasError | null
  }>({
    status: 'idle',
    progress: null,
    hash: null,
    decodedError: null,
  })

  // Sync single-tx (writeContract) state → hook state.
  useEffect(() => {
    if (writePending) {
      setState((s) => ({ ...s, status: 'pending' }))
    } else if (writeError) {
      setState((s) => ({ ...s, status: 'error', decodedError: decodeCanvasError(writeError) }))
    } else if (writeReceipt?.status === 'reverted') {
      setState((s) => ({
        ...s,
        status: 'error',
        decodedError: {
          friendly: 'Transaction reverted on-chain. Re-quote and retry; the canvas state may have shifted.',
          raw: `tx ${writeReceipt.transactionHash} reverted`,
        },
      }))
    } else if (writeConfirmed) {
      setState((s) => ({ ...s, status: 'success', hash: writeHash ?? null }))
    } else if (writeConfirming) {
      setState((s) => ({ ...s, status: 'confirming', hash: writeHash ?? null }))
    } else if (writeConfirmError) {
      setState((s) => ({ ...s, status: 'error', decodedError: decodeCanvasError(writeConfirmError) }))
    }
  }, [
    writePending,
    writeConfirming,
    writeConfirmed,
    writeError,
    writeConfirmError,
    writeReceipt,
    writeHash,
  ])

  // Sync EIP-5792 (sendCalls) state → hook state.
  useEffect(() => {
    if (sendCallsPending) {
      setState((s) => ({ ...s, status: 'pending' }))
    } else if (sendCallsError) {
      setState((s) => ({ ...s, status: 'error', decodedError: decodeCanvasError(sendCallsError) }))
    }
  }, [sendCallsPending, sendCallsError])

  useEffect(() => {
    if (callsStatusLoading) {
      setState((s) => ({ ...s, status: 'confirming' }))
    } else if (callsStatus?.status === 'success') {
      setState((s) => ({ ...s, status: 'success' }))
    } else if (callsStatus?.status === 'failure') {
      setState((s) => ({
        ...s,
        status: 'error',
        decodedError: {
          friendly: 'Batch paint failed on-chain. Some chunks may not have landed; re-quote and retry.',
          raw: 'atomic batch failed',
        },
      }))
    } else if (callsStatusError) {
      setState((s) => ({ ...s, status: 'error', decodedError: decodeCanvasError(callsStatusError) }))
    }
  }, [callsStatus, callsStatusLoading, callsStatusError])

  // Remember the submitted stamp rect so the success-invalidation path
  // can scope tile refetches to just the tiles the paint touched. Writing
  // this in a ref (not state) keeps the submit() flow from causing a
  // re-render loop: we set it before the tx lands and read it when the
  // success effect fires.
  const lastSubmittedRect = useRef<
    { x: number; y: number; w: number; h: number } | null
  >(null)

  // Invalidate caches after any successful paint so the canvas + feed
  // catch up without a page reload. Tile invalidation is TARGETED —
  // only tiles whose rect overlaps the just-painted region are
  // refetched. Previously we invalidated all 70 tiles, which on a
  // fully-loaded canvas kicked off 70 concurrent multicalls and drove
  // the tab past 4 GB every time a paint landed.
  useEffect(() => {
    if (state.status !== 'success') return
    queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
    queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })

    const rect = lastSubmittedRect.current
    if (rect) {
      const tx0 = Math.floor(rect.x / TILE_SIZE)
      const ty0 = Math.floor(rect.y / TILE_SIZE)
      const tx1 = Math.ceil((rect.x + rect.w) / TILE_SIZE)
      const ty1 = Math.ceil((rect.y + rect.h) / TILE_SIZE)
      const pending = new Set<string>()
      for (let ty = ty0; ty < ty1; ty++) {
        for (let tx = tx0; tx < tx1; tx++) pending.add(`${tx},${ty}`)
      }
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey
          if (!Array.isArray(k) || k[0] !== 'tile-pixels') return false
          const tx = k[3]
          const ty = k[4]
          if (typeof tx !== 'number' || typeof ty !== 'number') return false
          return pending.has(`${tx},${ty}`)
        },
      })
    }
  }, [state.status, queryClient])

  const submit = useCallback(
    async (args: PaintSubmitBatchArgs) => {
      if (!address) throw new Error('Wallet not connected')

      // Stash the draft rect so the success effect can scope its tile
      // invalidation to only the tiles this paint touches.
      lastSubmittedRect.current = {
        x: args.draft.x,
        y: args.draft.y,
        w: args.draft.w,
        h: args.draft.h,
      }

      // Smart-retry pre-flight: when caller asks to skip unchanged,
      // read current pixelAt for every draft pixel and mask any whose
      // color already matches as transparent. Contract treats high-
      // byte 0xFF as transparent and skips them with zero charge.
      let workingDraft = args.draft
      if (args.skipUnchanged && publicClient) {
        try {
          const { colors: masked } = await maskUnchangedPixels(publicClient, args.draft)
          workingDraft = { ...args.draft, colors: masked }
        } catch (e) {
          // If the pre-flight fails (RPC blip, multicall not present),
          // fall back to the unmodified draft. The user pays for
          // everything; unfortunate but better than failing the retry.
          console.warn('skipUnchanged pre-flight failed, falling back:', e)
        }
      }

      const chunks = chunkDraft(workingDraft, args.maxPixelsPerTx)
      const totalPixels = chunks.reduce((s, c) => s + c.pixels, 0)
      const reserveBps = args.reserveMultiplierBps ?? BPS

      // Proportional allocation of max cost + msg.value per chunk. We split
      // against the CONSTANT total pixel count (not a running remainder) so
      // the per-chunk shares sum to the caller-supplied total within floor
      // rounding. The last chunk gets whatever's left to absorb the few-wei
      // rounding residue. An earlier version divided by `remainingPixels`,
      // which produced ballooning shares on chunks 2+ and a negative
      // residue for the last chunk in 3+-chunk paints, corrupting
      // letterboxed uploads bigger than 2x the per-tx cap.
      let remainingValue = args.value
      let remainingMax = args.maxTotalCost

      const chunkCalls = chunks.map((chunk, i) => {
        const isLast = i === chunks.length - 1
        const chunkValue = isLast
          ? remainingValue
          : (args.value * BigInt(chunk.pixels)) / BigInt(totalPixels)
        const chunkMax = isLast
          ? remainingMax
          : (args.maxTotalCost * BigInt(chunk.pixels)) / BigInt(totalPixels)
        // Defensive: if allocation ever goes negative we'd silently send a
        // huge uint256 to the wallet. Fail fast with a clear error so the
        // user retries instead of the paint corrupting.
        if (chunkValue < 0n || chunkMax < 0n) {
          throw new Error(
            `Internal: chunk ${i} value allocation negative (value=${chunkValue}, max=${chunkMax}). ` +
            'This should not happen; please re-quote and retry.',
          )
        }
        remainingValue -= chunkValue
        remainingMax -= chunkMax

        const data = encodeFunctionData({
          abi: canvasAbi,
          functionName: 'paint',
          args: [
            chunk.x,
            chunk.y,
            chunk.w,
            chunk.h,
            chunk.colors as readonly number[],
            args.link,
            args.referrer ?? ('0x0000000000000000000000000000000000000000' as Address),
            '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
            chunkMax,
            reserveBps,
          ],
        })

        return {
          chunk,
          data,
          value: chunkValue,
          maxTotalCost: chunkMax,
        }
      })

      resetWrite()
      resetSendCalls()
      setState({
        status: 'pending',
        progress: { done: 0, total: chunkCalls.length },
        hash: null,
        decodedError: null,
      })

      // Fast path: single chunk, use writeContract for a clean UX.
      if (chunkCalls.length === 1) {
        const c = chunkCalls[0]
        try {
          await writeContractAsync({
            address: CANVAS_ADDRESS,
            abi: canvasAbi,
            functionName: 'paint',
            args: [
              c.chunk.x,
              c.chunk.y,
              c.chunk.w,
              c.chunk.h,
              c.chunk.colors as readonly number[],
              args.link,
              args.referrer ?? ('0x0000000000000000000000000000000000000000' as Address),
              '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
              c.maxTotalCost,
              reserveBps,
            ],
            value: c.value,
          })
        } catch (e) {
          setState({
            status: 'error',
            progress: null,
            hash: null,
            decodedError: decodeCanvasError(e),
          })
        }
        return
      }

      // Multi-chunk path. EIP-5792 if the chain+wallet support atomic;
      // otherwise sequential signatures.
      if (canAtomicBatch) {
        try {
          await sendCallsAsync({
            calls: chunkCalls.map((c) => ({
              to: CANVAS_ADDRESS,
              data: c.data,
              value: c.value,
            })),
          })
          // useWaitForCallsStatus picks up the id and transitions state.
        } catch (e) {
          setState({
            status: 'error',
            progress: null,
            hash: null,
            decodedError: decodeCanvasError(e),
          })
        }
        return
      }

      // Sequential fallback: N signatures, one per chunk. Track which
      // chunks were broadcast so a mid-stream cancel can scope its
      // tile invalidation to the partial set + tell the user which
      // chunks landed and which never went out.
      const broadcastChunks: PaintChunk[] = []
      for (let i = 0; i < chunkCalls.length; i++) {
        const c = chunkCalls[i]
        setState((s) => ({
          ...s,
          status: 'pending',
          progress: { done: i, total: chunkCalls.length },
        }))
        try {
          const hash = await writeContractAsync({
            address: CANVAS_ADDRESS,
            abi: canvasAbi,
            functionName: 'paint',
            args: [
              c.chunk.x,
              c.chunk.y,
              c.chunk.w,
              c.chunk.h,
              c.chunk.colors as readonly number[],
              args.link,
              args.referrer ?? ('0x0000000000000000000000000000000000000000' as Address),
              '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
              c.maxTotalCost,
              reserveBps,
            ],
            value: c.value,
          })
          broadcastChunks.push(c.chunk)
          setState((s) => ({
            ...s,
            status: 'confirming',
            hash,
            progress: { done: i + 1, total: chunkCalls.length },
          }))
        } catch (e) {
          // Mid-stream cancel handling: re-decode the error, then
          // rewrite the friendly message to reflect partial progress
          // when chunks 0..i-1 already broadcast. The vanilla "You
          // rejected the transaction in your wallet" message hides
          // the fact that some chunks ARE going to land — users were
          // refreshing into a half-painted canvas with no warning.
          const decoded = decodeCanvasError(e)
          const isUserCancel =
            decoded.friendly === 'You rejected the transaction in your wallet.'
          const done = broadcastChunks.length
          const total = chunkCalls.length
          let friendly = decoded.friendly
          if (isUserCancel && done > 0) {
            friendly =
              `You cancelled at chunk ${done + 1} of ${total}. ` +
              `Chunks 1–${done} are already broadcast and will likely land — ` +
              `the canvas may show a partial paint. Retry to finish the remaining ${total - done}.`
          } else if (!isUserCancel && done > 0) {
            friendly =
              `${decoded.friendly} ` +
              `Chunks 1–${done} of ${total} were already broadcast.`
          }
          setState({
            status: 'error',
            progress: { done, total },
            hash: null,
            decodedError: { ...decoded, friendly },
          })
          // The chunks that DID broadcast still mutate the canvas; tile
          // caches need invalidation for those rects so the UI stops
          // showing stale "no paint here" state once the txs mine. Build
          // a union rect from the broadcast chunks and let the success-
          // effect's invalidator handle it via lastSubmittedRect.
          if (broadcastChunks.length > 0) {
            const minX = Math.min(...broadcastChunks.map((c) => c.x))
            const minY = Math.min(...broadcastChunks.map((c) => c.y))
            const maxX = Math.max(...broadcastChunks.map((c) => c.x + c.w))
            const maxY = Math.max(...broadcastChunks.map((c) => c.y + c.h))
            lastSubmittedRect.current = {
              x: minX,
              y: minY,
              w: maxX - minX,
              h: maxY - minY,
            }
            // Don't flip status to success — that's a lie. Just kick the
            // refetch directly so painted-regions / tiles catch up when
            // the broadcast txs mine.
            queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
            queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })
          }
          return
        }
      }
      setState((s) => ({ ...s, status: 'success' }))
    },
    [address, canAtomicBatch, publicClient, queryClient, writeContractAsync, sendCallsAsync, resetWrite, resetSendCalls],
  )

  const reset = useCallback(() => {
    resetWrite()
    resetSendCalls()
    setState({ status: 'idle', progress: null, hash: null, decodedError: null })
  }, [resetWrite, resetSendCalls])

  return {
    submit,
    status: state.status,
    progress: state.progress,
    hash: state.hash,
    decodedError: state.decodedError,
    canAtomicBatch,
    reset,
  }
}

/**
 * Previous single-call API. Kept as a thin wrapper over the batch hook so
 * callers that only submit one paint don't need to pass chunk info.
 */
export type { PaintChunk }
