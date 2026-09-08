import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'

import { useViewerChainId } from '../lib/viewerChain'
import type { PaintedRegion } from './usePaintedRegions'

/**
 * Resolve unix timestamps for the blocks behind a set of paint regions so
 * the activity feed can render human-readable "time since paint" instead of
 * raw block numbers.
 *
 * Regions that came from the Worker snapshot already carry
 * `blockTimestamp`, resolved once server-side, and cost nothing here. Only
 * blocks the snapshot has not covered (paints newer than it, or a snapshot
 * written before timestamps were added) are fetched, one getBlock per unique
 * block. On a warm snapshot that is zero RPC calls; before this the feed
 * issued one getBlock per row on every page load.
 *
 * Bounded to the most recent MAX_BLOCKS so a wall with thousands of paints
 * can't fan out into thousands of RPC calls: the activity feed only shows
 * the newest ~50 rows, so older blocks (which fall back to the block number)
 * are off-screen anyway.
 */
const MAX_BLOCKS = 120

export function useBlockTimestamps(
  regions: readonly PaintedRegion[] | undefined,
): Map<bigint, number> {
  // Target the same chain as usePaintedRegions (the viewer chain), not the
  // wallet's connected chain, so block lookups resolve against the chain the
  // paints actually came from.
  const chainId = useViewerChainId()
  const publicClient = usePublicClient({ chainId })

  // Split into what the snapshot already knows and what still needs a read.
  const { known, missing } = useMemo(() => {
    const known = new Map<bigint, number>()
    const missingSet = new Set<string>()
    for (const r of regions ?? []) {
      if (typeof r.blockTimestamp === 'number') known.set(r.blockNumber, r.blockTimestamp)
      else missingSet.add(r.blockNumber.toString())
    }
    // A block known from any region covers every region in that block.
    for (const k of [...missingSet]) if (known.has(BigInt(k))) missingSet.delete(k)
    const missing = [...missingSet]
      .map((s) => BigInt(s))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // newest first
      .slice(0, MAX_BLOCKS)
    return { known, missing }
  }, [regions])

  const { data } = useQuery({
    queryKey: ['block-timestamps', chainId, missing.map(String).join(',')],
    enabled: !!publicClient && missing.length > 0,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // Keys are strings (block numbers) so the cached value stays
    // JSON-shaped; the consumer map below converts back to bigint.
    queryFn: async (): Promise<Record<string, number>> => {
      if (!publicClient) return {}
      const entries = await Promise.all(
        missing.map(async (bn) => {
          try {
            const blk = await publicClient.getBlock({ blockNumber: bn })
            return [bn.toString(), Number(blk.timestamp)] as const
          } catch {
            return null
          }
        }),
      )
      const out: Record<string, number> = {}
      for (const e of entries) if (e) out[e[0]] = e[1]
      return out
    },
  })

  return useMemo(() => {
    const map = new Map<bigint, number>(known)
    if (data) for (const [k, v] of Object.entries(data)) map.set(BigInt(k), v)
    return map
  }, [known, data])
}
