import { useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { useWatchContractEvent } from 'wagmi'

import { CANVAS_ADDRESS, canvasAbi } from '../contracts/canvas'
import { TILE_SIZE } from './useTilePixels'

/**
 * Subscribes to the Canvas `Painted` event and invalidates TanStack Query
 * caches when a new paint lands. Each region is mapped to the tile(s) it
 * intersects, and only those tile queries are invalidated — previously we
 * invalidated every `tile-pixels` entry on every paint, which on a canvas
 * with 70+ visible tiles caused 70 parallel refetches per paint. The
 * resulting memory pressure (react-query retains the previous PixelState[]
 * as placeholderData alongside the new fetch) was the main tab-memory
 * leak users saw on active chains.
 *
 * Mount once at the app root. Cheaper than polling the full event log and
 * responsive in ~seconds (limited by the RPC's subscription latency).
 */
export function useLivePaintedRefresh() {
  const queryClient = useQueryClient()
  const pendingTiles = useRef<Set<string>>(new Set())
  const timerRef = useRef<number | null>(null)

  useWatchContractEvent({
    address: CANVAS_ADDRESS,
    abi: canvasAbi,
    eventName: 'Painted',
    onLogs(logs) {
      // Bail on heartbeat polls with no matching events. wagmi fires
      // `onLogs` every filter poll; on many chains (and on anvil) the
      // callback runs with logs.length == 0 when nothing new has
      // happened. Without this guard, every heartbeat schedules an
      // invalidation 750ms later, which cascades to a full
      // `painted-regions` refetch (and the 70 tile queries it seeds).
      // That was the principal source of idle CPU/memory churn: tiles
      // never settled because every few seconds a heartbeat re-
      // invalidated the world.
      if (logs.length === 0) return

      // Accumulate the tile set across bursting events so we only issue
      // one invalidation per debounce window, not one per log.
      for (const log of logs) {
        const { x, y, w, h } = log.args as { x?: number; y?: number; w?: number; h?: number }
        if (x === undefined || y === undefined || w === undefined || h === undefined) continue
        const tx0 = Math.floor(x / TILE_SIZE)
        const ty0 = Math.floor(y / TILE_SIZE)
        const tx1 = Math.ceil((x + w) / TILE_SIZE)
        const ty1 = Math.ceil((y + h) / TILE_SIZE)
        for (let ty = ty0; ty < ty1; ty++) {
          for (let tx = tx0; tx < tx1; tx++) {
            pendingTiles.current.add(`${tx},${ty}`)
          }
        }
      }

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
        // Leaderboard thumbnails depend on which regions are top-spenders;
        // a new paint can bump a region into or out of the top-10. Cheap.
        queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })

        // Targeted tile invalidation: walk react-query's index and only
        // hit entries whose (tx, ty) key is in our pending set.
        const pending = pendingTiles.current
        pendingTiles.current = new Set()
        if (pending.size > 0) {
          queryClient.invalidateQueries({
            predicate: (q) => {
              const k = q.queryKey
              if (!Array.isArray(k) || k[0] !== 'tile-pixels') return false
              // tile-pixels key shape: ['tile-pixels', chainId, addr, tx, ty, fp]
              const tx = k[3]
              const ty = k[4]
              if (typeof tx !== 'number' || typeof ty !== 'number') return false
              return pending.has(`${tx},${ty}`)
            },
          })
        }
      }, 750)
    },
  })
}
