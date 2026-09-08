import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useReadContract } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import { useViewerChainId } from '../lib/viewerChain'
import { usePaintedRegions } from './usePaintedRegions'
import { TILE_SIZE } from './useTilePixels'

// How often to ask the chain whether anything has been painted. One tiny
// `stampCount()` eth_call against a direct endpoint; the Worker proxy never
// sees it. New paints show up within this interval.
const STAMP_POLL_MS = 15_000

// Periodic backstop re-scan interval. The stampCount poll above catches new
// paints; this only covers the case where the RPC dropped a log out of a
// scan. Gentle on purpose, and guarded so it never overlaps an in-flight scan.
const PERIODIC_REFRESH_MS = 90_000

/**
 * Keeps the canvas live: when a new paint lands on the viewed chain,
 * invalidates the regions + leaderboard queries and only the tile queries
 * the new paint touches.
 *
 * Detection is a `stampCount()` poll rather than an event subscription. The
 * previous version used wagmi's `useWatchContractEvent`, which on chains
 * whose RPCs do not serve `eth_newFilter` (PulseChain among them) degrades
 * to an `eth_getLogs` poll every 4 seconds. getLogs is routed through the
 * Worker proxy and a head-anchored range is uncacheable, so every open tab
 * cost ~15 Worker requests a minute for as long as it stayed open, which
 * was the largest sustained drain on the request quota. `stampCount` is
 * monotonic and increments on every paint, so polling it is an exact signal
 * at a fraction of the cost, and it goes to the direct endpoints.
 *
 * Tile invalidation stays targeted. Invalidating every tile on every paint
 * meant 70 concurrent refetches per paint and was the main tab-memory leak
 * on busy chains. Here the regions list is diffed after each refetch and
 * only tiles intersecting newly arrived regions are invalidated.
 *
 * Mount once at the app root (and once in the embed page).
 */
export function useLivePaintedRefresh() {
  const queryClient = useQueryClient()
  // Tie everything to the viewer's chain, not wagmi's default: a no-wallet
  // visitor browsing `?chain=base` must see Base paints, and a connected user
  // whose wallet sits on a different chain from the dropdown must still
  // follow the dropdown.
  const chainId = useViewerChainId()
  const address = canvasAddress(chainId)

  // Guarded periodic backstop: re-scan painted-regions on an interval, but
  // SKIP the tick if a scan (regions or any tile) is still in flight. Only
  // invalidates the lightweight regions + leaderboard queries (not every
  // tile) so it stays cheap.
  useEffect(() => {
    const id = window.setInterval(() => {
      const inFlight =
        queryClient.isFetching({ queryKey: ['painted-regions'] }) +
        queryClient.isFetching({ queryKey: ['tile-pixels'] })
      if (inFlight > 0) return
      queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
      queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })
    }, PERIODIC_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [queryClient])

  // New-paint detector.
  const stamps = useReadContract({
    address,
    abi: canvasAbi,
    functionName: 'stampCount',
    chainId,
    query: {
      enabled: !!address,
      refetchInterval: STAMP_POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: STAMP_POLL_MS,
    },
  })
  const lastCount = useRef<{ chainId: number; count: bigint } | null>(null)
  useEffect(() => {
    const count = stamps.data
    if (typeof count !== 'bigint') return
    const prev = lastCount.current
    lastCount.current = { chainId, count }
    // First reading for this chain is the baseline, not a paint.
    if (!prev || prev.chainId !== chainId) return
    if (count === prev.count) return
    queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
    // Leaderboard thumbnails depend on which regions are top-spenders;
    // a new paint can bump a region into or out of the top-10. Cheap.
    queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })
    // The header multicall (useCanvasHeader) carries stampCount and
    // linkCount for the nav strip. Refresh just that batch, not every
    // readContracts query (links() results are immutable).
    queryClient.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey
        if (!Array.isArray(k) || k[0] !== 'readContracts') return false
        const p = k[1] as { contracts?: Array<{ functionName?: string }> } | undefined
        return !!p?.contracts?.some((c) => c.functionName === 'stampCount')
      },
    })
  }, [stamps.data, chainId, queryClient])

  // Targeted tile invalidation. Shares the regions query (same key, no extra
  // fetch); when the list grows, only tiles intersecting the new regions are
  // refetched. Uses rawData (unfiltered) so a filtered-out paint still
  // refreshes whatever it covered.
  const regions = usePaintedRegions().rawData
  const seen = useRef<{ chainId: number; keys: Set<string> } | null>(null)
  useEffect(() => {
    if (!regions) return
    const prev = seen.current
    const keys = new Set<string>()
    const pendingTiles = new Set<string>()
    for (const r of regions) {
      const k = `${r.txHash}:${r.logIndex}`
      keys.add(k)
      if (prev && prev.chainId === chainId && prev.keys.has(k)) continue
      const tx0 = Math.floor(r.x / TILE_SIZE)
      const ty0 = Math.floor(r.y / TILE_SIZE)
      const tx1 = Math.ceil((r.x + r.w) / TILE_SIZE)
      const ty1 = Math.ceil((r.y + r.h) / TILE_SIZE)
      for (let ty = ty0; ty < ty1; ty++) {
        for (let tx = tx0; tx < tx1; tx++) pendingTiles.add(`${tx},${ty}`)
      }
    }
    seen.current = { chainId, keys }
    // The first list for a chain is the initial render; tiles are fetched
    // fresh for it anyway, so there is nothing to invalidate.
    if (!prev || prev.chainId !== chainId) return
    if (pendingTiles.size === 0) return
    queryClient.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey
        if (!Array.isArray(k) || k[0] !== 'tile-pixels') return false
        // tile-pixels key shape: ['tile-pixels', chainId, addr, tx, ty]
        const tx = k[3]
        const ty = k[4]
        if (typeof tx !== 'number' || typeof ty !== 'number') return false
        return pendingTiles.has(`${tx},${ty}`)
      },
    })
  }, [regions, chainId, queryClient])
}
