import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { getAddress, parseAbiItem } from 'viem'
import { usePublicClient } from 'wagmi'

import { canvasAddress } from '../contracts/canvas'
import { deployBlockFor, logsChunkSizeFor } from '../lib/deployBlocks'
import { rectsIntersect } from '../lib/filterList'
import { getLogsPaginated, type DroppedRange } from '../lib/paginatedLogs'
import { useViewerChainId } from '../lib/viewerChain'
import { useCanvasSnapshot, type SnapshotRegion } from './useCanvasSnapshot'
import { useOfacSanctioned } from './useOfacSanctioned'
import { useStaticFilterList } from './useStaticFilterList'

/**
 * A single paint region resolved from a Painted event. Matches the on-chain
 * stamp rectangle, not per-pixel state (per-pixel colors need a follow-up
 * `pixelAt` read via useRegionPixels).
 */
export interface PaintedRegion {
  blockNumber: bigint
  logIndex: number
  txHash: string
  painter: string
  referrer: string
  metadataHash: string
  x: number
  y: number
  w: number
  h: number
  pixelsPainted: number
  pricePaid: bigint
  linkId: number
  /**
   * Row-major w*h colours when this region came from the Worker snapshot,
   * which decodes them from the paint's own transaction calldata. Undefined
   * for regions resolved by scanning chain state, whose colours useTilePixels
   * still reads back with `pixelAt`.
   */
  pixels?: Uint32Array | null
}

// Explicit ABI item: keeps the getLogs return type narrow and lets us avoid
// pulling the entire ABI into the query key.
const PAINTED_EVENT = parseAbiItem(
  'event Painted(address indexed painter, address indexed referrer, bytes32 indexed metadataHash, uint32 x, uint32 y, uint32 w, uint32 h, uint32 pixelsPainted, uint256 pricePaid, uint32 linkId)',
)

// Ranges getLogsPaginated dropped on an earlier scan, keyed by chainId.
// The 90s backstop in useLivePaintedRefresh invalidates this query, which
// re-runs queryFn; each pass retries what's queued here so a transient
// RPC failure can't permanently hide a slice of paint history. Module
// level (not hook state) so every mounted instance shares one queue.
const droppedRangesByChain = new Map<number, DroppedRange[]>()

/** Snapshot JSON (numbers, hex strings) -> PaintedRegion (bigints). */
function toRegion(r: SnapshotRegion): PaintedRegion {
  return {
    blockNumber: BigInt(r.blockNumber),
    logIndex: r.logIndex,
    txHash: r.txHash,
    painter: r.painter,
    referrer: r.referrer,
    metadataHash: r.metadataHash ?? '0x',
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    pixelsPainted: r.pixelsPainted,
    // The Worker strips leading zeroes, so "0x" is a legitimate encoding of 0.
    pricePaid: BigInt(r.pricePaid === '0x' ? '0x0' : r.pricePaid),
    linkId: r.linkId,
    pixels: r.pixels,
  }
}

/**
 * Fetches historical Painted events from the current chain and returns them
 * as paint regions sorted by (blockNumber, logIndex). "Current" means the
 * last event wins for any overlapping pixel, so region iteration in order
 * reconstructs the canvas's live state.
 *
 * Pagination:
 *   - Default fromBlock is the chain's recorded deploy block from
 *     `web/src/lib/deployBlocks.ts`. Caller can override via the option.
 *     Walking from genesis on a chain with millions of blocks is the
 *     pathological case that pagination is designed to make survivable,
 *     not a happy path — operators should update deployBlocks.ts at
 *     deploy time.
 *   - `getLogsPaginated` splits the [fromBlock, currentBlock] range into
 *     ~9_500-block chunks so public RPCs that cap eth_getLogs at 10k
 *     don't silently fail. On per-chunk failure the chunk size is halved
 *     and retried down to 500 blocks; if a range stays unrecoverable
 *     the helper drops it (logs to console) and continues so the rest
 *     of the canvas still renders rather than going blank.
 */
export function usePaintedRegions(options?: { fromBlock?: bigint }) {
  // Pin the client to the viewer's chain so a no-wallet visitor can
  // browse any chain's canvas via `?chain=base` etc. When connected,
  // useViewerChainId returns the wallet chain so paint UX stays aligned.
  const chainId = useViewerChainId()
  const publicClient = usePublicClient({ chainId })
  const address = canvasAddress(chainId)

  // Snapshot covers history up to `snapshotBlock`; we only scan forward from
  // there. When there is no snapshot (mirror deployments, a chain the cron has
  // not reached yet, /api unavailable) this falls back to the deploy block and
  // the behaviour is exactly what it was before snapshots existed.
  const snapshot = useCanvasSnapshot()
  const snapshotFrom =
    snapshot.snapshotBlock !== null ? BigInt(snapshot.snapshotBlock) + 1n : undefined
  const fromBlock = options?.fromBlock ?? snapshotFrom ?? deployBlockFor(chainId)

  const query = useQuery({
    queryKey: ['painted-regions', chainId, address, String(fromBlock)],
    enabled: !!publicClient && !!address,
    // Regions list mutates only when a new Painted event lands, which
    // useLivePaintedRefresh invalidates explicitly. No reason to auto-
    // refetch on window focus (a common UX pattern that was churning
    // the 431-event getLogs call every time the tab regained focus —
    // each refetch seeded 70 tile queries and ~1GB of transient heap).
    // Infinity staleTime means the only refetch paths are explicit
    // invalidation or a full reload.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    gcTime: 60_000,
    queryFn: async (): Promise<PaintedRegion[]> => {
      if (!publicClient || !address) return []
      // Resolve toBlock once to keep all chunks anchored to the same
      // head and avoid duplicate events that could land if `latest`
      // advances mid-scan.
      const toBlock = await publicClient.getBlockNumber()
      const { logs, droppedRanges } = await getLogsPaginated({
        publicClient,
        address: address as Hex,
        event: PAINTED_EVENT,
        fromBlock,
        toBlock,
        // HyperEVM caps getLogs at 1000 blocks; pass a tighter chunk so we
        // don't burn ~4 failed calls per chunk halving down from the 9.5k
        // default. undefined elsewhere → paginator default.
        chunkSize: logsChunkSizeFor(chainId),
      })

      // Drain ranges dropped on earlier passes. The main scan above
      // already re-covers anything inside [fromBlock, toBlock], so only
      // ranges outside that window (e.g. queued under a caller override)
      // need an explicit retry; everything still failing re-queues for
      // the next backstop pass.
      const allLogs = [...logs]
      const stillDropped = [...droppedRanges]
      for (const range of droppedRangesByChain.get(chainId) ?? []) {
        if (range.fromBlock >= fromBlock && range.toBlock <= toBlock) continue
        const retry = await getLogsPaginated({
          publicClient,
          address: address as Hex,
          event: PAINTED_EVENT,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          chunkSize: logsChunkSizeFor(chainId),
        })
        allLogs.push(...retry.logs)
        stillDropped.push(...retry.droppedRanges)
      }
      droppedRangesByChain.set(chainId, stillDropped)

      return allLogs
        .map((log): PaintedRegion => ({
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          txHash: log.transactionHash!,
          painter: log.args.painter!,
          referrer: log.args.referrer!,
          metadataHash: log.args.metadataHash!,
          x: Number(log.args.x),
          y: Number(log.args.y),
          w: Number(log.args.w),
          h: Number(log.args.h),
          pixelsPainted: Number(log.args.pixelsPainted),
          pricePaid: log.args.pricePaid!,
          linkId: Number(log.args.linkId),
        }))
        .sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
          return a.logIndex - b.logIndex
        })
    },
  })

  // Two-source render-time filter (cpa-brief.md §2.1):
  //
  //   1. OFAC oracle (`useOfacSanctioned`) — Chainalysis on-chain
  //      sanctions list. Live, free, no operator side-channel.
  //   2. Static signed list (`useStaticFilterList`) — operator-
  //      published JSON of address / pixelRect / linkHash entries.
  //      Hides regions whose painter/referrer is listed, or whose
  //      stamp rectangle intersects a listed pixelRect.
  //
  // Both sources fail open (load, network error, no oracle on chain).
  // Static-list signature mismatches fail closed in the verify step,
  // so we never apply a tampered list to render. Implemented at the
  // source so every consumer (canvas tiles, ActivityFeed, Leaderboard,
  // NavMetrics, etc.) inherits the same filtered view automatically.
  // Snapshot history + the forward scan, in one chain-ordered list.
  //
  // Merged here rather than inside queryFn so that a snapshot arriving (or
  // gaining decoded pixels on a later cron pass) flows straight through
  // without waiting for a refetch. Deduped by (txHash, logIndex) because the
  // scan's fromBlock and the snapshot's coverage can overlap by a block on a
  // reorg re-resolve.
  const merged = useMemo<PaintedRegion[] | undefined>(() => {
    if (!query.data) return snapshot.regions.length ? snapshot.regions.map(toRegion) : undefined
    if (!snapshot.regions.length) return query.data
    const out = snapshot.regions.map(toRegion)
    const seen = new Set(out.map((r) => `${r.txHash}:${r.logIndex}`))
    for (const r of query.data) {
      if (seen.has(`${r.txHash}:${r.logIndex}`)) continue
      out.push(r)
    }
    return out.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
      return a.logIndex - b.logIndex
    })
  }, [query.data, snapshot.regions])

  const addresses = useMemo<Address[]>(() => {
    if (!merged) return []
    const out: Address[] = []
    for (const r of merged) {
      try { out.push(getAddress(r.painter)) } catch { /* skip malformed */ }
      try { out.push(getAddress(r.referrer)) } catch { /* skip malformed */ }
    }
    return out
  }, [merged])

  const sanctioned = useOfacSanctioned(addresses)
  const staticList = useStaticFilterList()

  const filtered = useMemo(() => {
    if (!merged) return merged
    const noFilters =
      sanctioned.size === 0 &&
      staticList.blockedAddresses.size === 0 &&
      staticList.blockedPixelRects.length === 0
    if (noFilters) return merged
    return merged.filter((r) => {
      try {
        const painter = getAddress(r.painter)
        const referrer = getAddress(r.referrer)
        if (sanctioned.has(painter)) return false
        if (sanctioned.has(referrer)) return false
        if (staticList.blockedAddresses.has(painter.toLowerCase())) return false
        if (staticList.blockedAddresses.has(referrer.toLowerCase())) return false
      } catch {
        // malformed address → conservatively keep (we couldn't check)
      }
      const stampRect = { x: r.x, y: r.y, w: r.w, h: r.h }
      for (const blocked of staticList.blockedPixelRects) {
        if (rectsIntersect(stampRect, blocked)) return false
      }
      return true
    })
  }, [merged, sanctioned, staticList])

  // `rawData` is the unfiltered chain order (same array reference as the
  // query result, no duplication). Founder ranks are computed from it so
  // a filter-list change can't shift anyone's "Genesis #N"; everything
  // user-facing should keep consuming the filtered `data`.
  return { ...query, data: filtered, rawData: merged }
}
