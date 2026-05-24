import { useMemo } from 'react'

import type { PaintedRegion } from './usePaintedRegions'

/**
 * Counts pixels currently owned by `painter`. "Currently" means after
 * applying every Painted event in (block, logIndex) order: pixels the
 * painter laid but were later overwritten by someone else are excluded.
 *
 * Algorithm: walk regions in chronological order, writing the region's
 * 1-based index into a per-pixel `Int32Array` (last write wins). Then
 * scan the array and count slots whose region's painter equals the
 * target. Memoised on (regions reference, painter, dimensions); the
 * regions reference only changes when a new Painted event lands.
 *
 * Cost: O(sum of region areas + canvas pixels). For a 1M canvas with
 * ~10k stamps averaging 100 pixels each that's ~2M operations and a
 * 4 MB transient `Int32Array` (kept inside the useMemo cache, so it's
 * allocated once and held until inputs change).
 *
 * Returns `null` while inputs aren't ready (no painter yet, dims still
 * loading). The metric slot then renders `—`.
 */
export function useOwnedByYou(
  regions: PaintedRegion[] | undefined,
  painter: string | undefined,
  canvasWidth: number | null,
  canvasHeight: number | null,
): number | null {
  return useMemo(() => {
    if (!painter) return null
    if (!canvasWidth || !canvasHeight) return null
    if (!regions || regions.length === 0) return 0

    const target = painter.toLowerCase()
    const W = canvasWidth
    const H = canvasHeight
    const owners = new Int32Array(W * H)

    for (let r = 0; r < regions.length; r++) {
      const region = regions[r]
      const slot = r + 1 // shift so 0 means "unpainted"
      // Clamp defensively in case a malformed event ever shows up; the
      // contract guards against out-of-bounds, but the frontend should
      // not crash on a bad RPC response.
      const x0 = Math.max(0, region.x)
      const y0 = Math.max(0, region.y)
      const x1 = Math.min(W, region.x + region.w)
      const y1 = Math.min(H, region.y + region.h)
      for (let y = y0; y < y1; y++) {
        const rowStart = y * W
        for (let x = x0; x < x1; x++) {
          owners[rowStart + x] = slot
        }
      }
    }

    let count = 0
    for (let i = 0; i < owners.length; i++) {
      const slot = owners[i]
      if (slot > 0 && regions[slot - 1].painter.toLowerCase() === target) {
        count++
      }
    }
    return count
  }, [regions, painter, canvasWidth, canvasHeight])
}
