import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import { useViewerChainId } from '../lib/viewerChain'
import type { PaintedRegion } from './usePaintedRegions'

/** Tile edge length in canvas pixels. 128 keeps a full tile at 16,384 px,
 *  which fits in two 8,192-entry Multicall3 sub-batches (matches the
 *  batchSize in the multicall() call). Smaller tiles multiply the query
 *  count for no bandwidth benefit; larger tiles delay the first visible
 *  blit because more pixels must land before the tile renders. */
export const TILE_SIZE = 128

export interface PixelState {
  x: number
  y: number
  color: number
  lastPrice: bigint
  linkId: number
}

/**
 * Packed tile pixel data. A row-major Uint32Array sized `w * h` where each
 * entry encodes either:
 *   - 0                              → unpainted (transparent sentinel)
 *   - (color & 0xffffff) | 0x1000000 → painted, high byte marks "present"
 *
 * 4 bytes per pixel vs ~80 bytes for a { x, y, color, lastPrice: bigint,
 * linkId } object. A full 128×128 tile is 64KB packed versus ~1.3MB as
 * PixelState[]; on invalidation bursts react-query's cache holds far less
 * before gc, which was the principal tab-memory leak in the earlier shape.
 *
 * The canvas already reads only `color` during the render pass; `lastPrice`
 * and `linkId` weren't consumed by any tile renderer anyway. Hover-info
 * reads pull those via usePixelInfo's per-cell multicall.
 */
export interface TilePixelData {
  /** Tile origin in canvas-pixel coords. */
  x: number
  y: number
  /** Tile extent in canvas-pixel coords (clamped to canvas bounds). */
  w: number
  h: number
  /** Row-major pixel colour buffer, length `w * h`. */
  colors: Uint32Array
}

export interface TileCoord {
  tx: number
  ty: number
}

export function tileKey(tx: number, ty: number): string {
  return `${tx},${ty}`
}

/** Tile indices (tx, ty) intersecting the given canvas-space rectangle,
 *  optionally padded with `buffer` tiles on each side so pan momentum can
 *  reveal without a round-trip. Clamps to the canvas bounds. */
export function tilesForRect(
  x: number,
  y: number,
  w: number,
  h: number,
  canvasWidth: number,
  canvasHeight: number,
  buffer = 0,
): TileCoord[] {
  const tx0 = Math.max(0, Math.floor(x / TILE_SIZE) - buffer)
  const ty0 = Math.max(0, Math.floor(y / TILE_SIZE) - buffer)
  const tx1 = Math.min(
    Math.ceil(canvasWidth / TILE_SIZE),
    Math.ceil((x + w) / TILE_SIZE) + buffer,
  )
  const ty1 = Math.min(
    Math.ceil(canvasHeight / TILE_SIZE),
    Math.ceil((y + h) / TILE_SIZE) + buffer,
  )
  const out: TileCoord[] = []
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      out.push({ tx, ty })
    }
  }
  return out
}

export interface TilePixelsEntry {
  data: TilePixelData | undefined
  isLoading: boolean
  isFetched: boolean
}

export type TilePixelsMap = Map<string, TilePixelsEntry>

/**
 * Viewport-tiled pixel fetcher. Replaces the canvas-wide `useRegionPixels`
 * that capped at 600k pixels (dropping tail regions silently). Each tile
 * owns its own react-query entry keyed by (chainId, canvas address,
 * tile coords, regions fingerprint); tiles scroll-out-of-view and get GC'd
 * by react-query after `gcTime`, keeping memory bounded.
 *
 * The hook accepts the *visible* tile set so that at high zoom levels only
 * a handful of tiles are in flight. Callers compute visibility from scroll
 * + zoom state (see HomePage). Whole-canvas views (EmbedPage) can pass
 * every tile intersecting the canvas; the per-tile cap keeps individual
 * multicalls small.
 *
 * Invalidation: `['tile-pixels']` query-key prefix. Live-refresh and
 * successful-paint hooks invalidate by this prefix to force all visible
 * tiles to re-fetch.
 */
export function useTilePixels(
  visibleTiles: readonly TileCoord[],
  regions: readonly PaintedRegion[] | undefined,
  canvasWidth: number,
  canvasHeight: number,
): TilePixelsMap {
  // Pin to viewer chain so the tile fetch follows the user's chain
  // selection even when no wallet is connected.
  const chainId = useViewerChainId()
  const publicClient = usePublicClient({ chainId })
  const address = canvasAddress(chainId)

  // queryKey DOES NOT include a regions fingerprint. An earlier version
  // did, reasoning that a new region should refresh the tile — but with
  // a single global fingerprint shared by all 70 tiles, any region
  // update busted every tile's queryKey, turning one paint into 70
  // concurrent multicall refetches and driving the tab past 4 GB. Each
  // tile's queryFn reads `regions` from this hook's latest render
  // closure; cache freshness is driven by targeted `invalidateQueries`
  // calls in useLivePaintedRefresh + usePaintSubmitBatch (which know
  // exactly which tiles the new paint touches).

  const queries = useQueries({
    queries: visibleTiles.map(({ tx, ty }) => {
      const x0 = tx * TILE_SIZE
      const y0 = ty * TILE_SIZE
      const x1 = Math.min(x0 + TILE_SIZE, canvasWidth)
      const y1 = Math.min(y0 + TILE_SIZE, canvasHeight)

      const tileW = x1 - x0
      const tileH = y1 - y0

      return {
        queryKey: [
          'tile-pixels',
          publicClient?.chain.id,
          address,
          tx,
          ty,
        ] as const,
        enabled: !!publicClient && !!regions,
        // Same reasoning as usePaintedRegions: tile data only changes
        // when a Painted event intersects the tile, which is handled by
        // the targeted invalidation in useLivePaintedRefresh. Auto-
        // refetch on focus/mount would kick off 70 concurrent multicalls
        // against anvil every time the tab regained focus, and anvil
        // would serialise them — each in-flight buffer holding a few
        // hundred KB. Disable all the automatic paths.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        gcTime: 15_000,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TilePixelData> => {
          const colors = new Uint32Array(tileW * tileH)
          if (!publicClient || !regions || regions.length === 0) {
            return { x: x0, y: y0, w: tileW, h: tileH, colors }
          }

          // Intersect every region with this tile's rect, collecting the
          // unique local (dx, dy) positions that fall inside. `pixelAt`
          // returns the live chain state at (x, y), which is always the
          // latest write — so overpainted pixels only need one read.
          const seen = new Uint8Array(tileW * tileH)
          const coords: Array<{ x: number; y: number; local: number }> = []
          for (const r of regions) {
            const rx0 = Math.max(r.x, x0)
            const ry0 = Math.max(r.y, y0)
            const rx1 = Math.min(r.x + r.w, x1)
            const ry1 = Math.min(r.y + r.h, y1)
            if (rx0 >= rx1 || ry0 >= ry1) continue
            for (let yi = ry0; yi < ry1; yi++) {
              for (let xi = rx0; xi < rx1; xi++) {
                const local = (yi - y0) * tileW + (xi - x0)
                if (seen[local]) continue
                seen[local] = 1
                coords.push({ x: xi, y: yi, local })
              }
            }
          }
          if (coords.length === 0) {
            return { x: x0, y: y0, w: tileW, h: tileH, colors }
          }

          const calls = coords.map(({ x, y }) => ({
            address,
            abi: canvasAbi,
            functionName: 'pixelAt' as const,
            args: [x, y] as const,
          }))

          // If react-query already cancelled this fetch (e.g. another
          // invalidation fired), bail before the RPC round-trip instead of
          // charging through to allocate a full result set that'll be
          // discarded. Without this, rapid invalidations stack dozens of
          // concurrent multicalls in flight — the principal cause of the
          // tab-memory blow-up seen under live-refresh bursts.
          if (signal.aborted) throw new Error('aborted')

          let tuples: Array<readonly [number, bigint, number] | null>
          try {
            const results = await publicClient.multicall({
              contracts: calls,
              allowFailure: true,
              batchSize: 8192,
            })
            // Drop this fetch's work if we were superseded while the RPC
            // was in flight — prevents a late-arriving response from
            // overwriting a newer one, and lets the GC reclaim the large
            // result array immediately.
            if (signal.aborted) throw new Error('aborted')
            if (results.length === 0 && coords.length > 0) {
              throw new Error('multicall empty, falling back')
            }
            tuples = results.map((r) =>
              r.status === 'success'
                ? (r.result as unknown as readonly [number, bigint, number])
                : null,
            )
          } catch (e) {
            if (signal.aborted) throw e
            // Multicall3-less chain (e.g. default anvil): parallel reads.
            // Per-tile volume is bounded at TILE_SIZE^2 = 16,384 reads so
            // the fallback stays tractable.
            const chunkSize = 200
            tuples = []
            for (let i = 0; i < calls.length; i += chunkSize) {
              if (signal.aborted) throw new Error('aborted')
              const slice = calls.slice(i, i + chunkSize)
              const batch = await Promise.all(
                slice.map((c) =>
                  publicClient
                    .readContract(c)
                    .then(
                      (r) => r as unknown as readonly [number, bigint, number],
                      () => null,
                    ),
                ),
              )
              tuples.push(...batch)
            }
            if (signal.aborted) throw new Error('aborted')
          }

          for (let i = 0; i < tuples.length; i++) {
            const tuple = tuples[i]
            if (!tuple) continue
            const [color, lastPrice] = tuple
            // lastPrice == 0 means the pixel was submitted as the transparent
            // sentinel and skipped on-chain; leave the 0 entry.
            if (lastPrice === 0n) continue
            // Sentinel bit 0x01000000 distinguishes "painted black (0)"
            // from "unpainted (0)" when the renderer reads back.
            colors[coords[i].local] = (color & 0xffffff) | 0x01000000
          }
          return { x: x0, y: y0, w: tileW, h: tileH, colors }
        },
      }
    }),
  })

  return useMemo(() => {
    const map: TilePixelsMap = new Map()
    visibleTiles.forEach((t, i) => {
      const q = queries[i]
      map.set(tileKey(t.tx, t.ty), {
        data: q.data,
        isLoading: q.isLoading,
        isFetched: q.isFetched,
      })
    })
    return map
  // queries is a new array every render but its entries are stable refs
  // when unchanged. Stringifying the visible-tile list keeps the memo
  // consistent; the queries spread is intentional.
  }, [queries, visibleTiles])
}
