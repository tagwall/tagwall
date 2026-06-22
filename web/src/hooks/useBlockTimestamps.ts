import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'

import { useViewerChainId } from '../lib/viewerChain'

/**
 * Resolve unix timestamps for a set of block numbers so the activity feed
 * can render human-readable "time since paint" instead of raw block
 * numbers. A mined block's timestamp never changes, so results are cached
 * forever. One getBlock per unique block, batched.
 *
 * Bounded to the most recent MAX_BLOCKS so a wall with thousands of paints
 * can't fan out into thousands of RPC calls: the activity feed only shows
 * the newest ~50 rows, so older blocks (which fall back to the block number)
 * are off-screen anyway.
 */
const MAX_BLOCKS = 120

export function useBlockTimestamps(
  blockNumbers: readonly bigint[],
): Map<bigint, number> {
  // Target the same chain as usePaintedRegions (the viewer chain), not the
  // wallet's connected chain, so block lookups resolve against the chain the
  // paints actually came from.
  const chainId = useViewerChainId()
  const publicClient = usePublicClient({ chainId })

  const unique = useMemo(() => {
    const set = new Set(blockNumbers.map((b) => b.toString()))
    return [...set]
      .map((s) => BigInt(s))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // newest first
      .slice(0, MAX_BLOCKS)
  }, [blockNumbers])

  const { data } = useQuery({
    queryKey: ['block-timestamps', publicClient?.chain.id, unique.map(String).join(',')],
    enabled: !!publicClient && unique.length > 0,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // Keys are strings (block numbers) so the cached value stays
    // JSON-shaped; the consumer map below converts back to bigint.
    queryFn: async (): Promise<Record<string, number>> => {
      if (!publicClient) return {}
      const entries = await Promise.all(
        unique.map(async (bn) => {
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
    const map = new Map<bigint, number>()
    if (data) for (const [k, v] of Object.entries(data)) map.set(BigInt(k), v)
    return map
  }, [data])
}
