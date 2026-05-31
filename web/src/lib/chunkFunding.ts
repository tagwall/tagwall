import type { Address, PublicClient } from 'viem'

import { canvasAbi } from '../contracts/canvas'
import type { PaintChunk } from './chunkDraft'

/**
 * Per-chunk funding logic for multi-transaction paints.
 *
 * Split out of usePaintSubmitBatch so it can be exercised without a React
 * render: `chunkCostWeights` is an integration-testable on-chain read and
 * `allocateChunkFunding` is a pure function with no wagmi/React dependency.
 * The hook is a thin orchestration layer over these two.
 */

/** Per-chunk msg.value + maxTotalCost allocation, in native wei. */
export interface ChunkFunding {
  value: bigint
  maxTotalCost: bigint
}

/**
 * Per-chunk cost weights for proportional value/maxTotalCost allocation.
 *
 * The contract charges each chunk the SUM of its pixels' individual quotes,
 * which varies across an overwrite region: a fresh pixel costs startingPrice
 * while a recently-painted one costs lastPrice * 1.10. Weighting the caller's
 * total by pixel COUNT (the previous strategy) starves any band that happens
 * to cover pricier pixels, reverting PriceAboveMax even when the aggregate
 * funding is more than enough. We weight by each chunk's live on-chain quote
 * instead, fetched in a single multicall.
 *
 * `quote(x,y,w,h)` is additive over the disjoint bands chunkDraft produces, so
 * the weights sum to (approximately) the whole-rect quote the caller already
 * priced against; allocating `total * weight[i] / sum(weight)` keeps the user's
 * approved total intact while giving each chunk a share that matches its real
 * cost at submit time.
 *
 * Falls back to pixel-count weights (correct on a uniformly-priced or fresh
 * region) when there's no public client, only one chunk, or the multicall
 * doesn't fully succeed — never mixing the two scales, which would mis-weight.
 */
export async function chunkCostWeights(
  publicClient: PublicClient | undefined,
  chunks: PaintChunk[],
  canvasAddr: Address,
): Promise<bigint[]> {
  const fallback = chunks.map((c) => BigInt(c.pixels))
  if (!publicClient || chunks.length <= 1) return fallback
  try {
    const results = (await publicClient.multicall({
      contracts: chunks.map((c) => ({
        address: canvasAddr,
        abi: canvasAbi,
        functionName: 'quote' as const,
        args: [c.x, c.y, c.w, c.h] as const,
      })),
      allowFailure: true,
    })) as ReadonlyArray<{ status: 'success' | 'failure'; result?: unknown }>
    // All-or-nothing: a partial result would mix quote-scale weights (~1e13
    // wei) with pixel-count weights (~1e3), collapsing the count-weighted
    // chunks to a near-zero share. If any chunk quote failed, use the
    // uniform pixel-count fallback for every chunk.
    if (!results.every((r) => r && r.status === 'success')) return fallback
    const weights = results.map((r, i) => {
      const total = (r.result as readonly [bigint, number])[0]
      // quote() returns >= startingPrice * pixels (always > 0) for a valid
      // rect; the guard is pure defense against an unexpected 0.
      return total > 0n ? total : fallback[i]
    })
    return weights
  } catch {
    return fallback
  }
}

/**
 * Allocate a slippage-capped total `value`/`maxTotalCost` across chunks in
 * proportion to `weights`. Pure: same inputs always yield the same split.
 *
 * The split is against the CONSTANT total weight (not a running remainder) so
 * the per-chunk shares sum to the caller-supplied total within floor rounding;
 * the LAST chunk is handed whatever's left so the few-wei floor-division
 * residue is never stranded (sum of allocations === input total, exactly).
 *
 * Throws if any allocation goes negative — that can only happen if a caller
 * passes a malformed weights array, and silently forwarding a negative bigint
 * would underflow to a huge uint256 in the wallet. Fail loud instead.
 */
export function allocateChunkFunding(params: {
  chunks: PaintChunk[]
  weights: bigint[]
  value: bigint
  maxTotalCost: bigint
}): ChunkFunding[] {
  const { chunks, weights, value, maxTotalCost } = params
  const totalWeight = weights.reduce((s, w) => s + w, 0n)
  let remainingValue = value
  let remainingMax = maxTotalCost

  return chunks.map((_, i) => {
    const isLast = i === chunks.length - 1
    // totalWeight is > 0 whenever chunks is non-empty (pixel-count fallback is
    // always >= 1 per chunk, live quotes are always > 0), so the non-last
    // branch never divides by zero. The isLast branch sidesteps it regardless.
    const chunkValue = isLast ? remainingValue : (value * weights[i]) / totalWeight
    const chunkMax = isLast ? remainingMax : (maxTotalCost * weights[i]) / totalWeight
    if (chunkValue < 0n || chunkMax < 0n) {
      throw new Error(
        `Internal: chunk ${i} value allocation negative (value=${chunkValue}, max=${chunkMax}). ` +
          'This should not happen; please re-quote and retry.',
      )
    }
    remainingValue -= chunkValue
    remainingMax -= chunkMax
    return { value: chunkValue, maxTotalCost: chunkMax }
  })
}
