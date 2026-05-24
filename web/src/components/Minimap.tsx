import { useEffect, useRef } from 'react'

import type { PaintedRegion } from '../hooks/usePaintedRegions'

interface Props {
  regions: readonly PaintedRegion[] | undefined
  canvasWidth: number
  canvasHeight: number
  /** Optional draft rect — drawn as a chain-accent outline so the user
   *  sees where their pending paint will land relative to the rest. */
  draft?: { x: number; y: number; w: number; h: number } | null
}

// Bumped 160 → 220 to match the wider Map column (244px column width
// minus 12+12 padding ≈ 220 visible). Keeps the rasterised minimap
// pixel-crisp at the new size; .paint-minimap CSS width:100% upscales
// fine but starts to blur once the column is much larger than the buffer.
const MAP_WIDTH = 220
const MAP_HEIGHT = 141 // ≈ MAP_WIDTH * 16/25 for the 25:16 canvas aspect.

/**
 * Compact thumbnail of the canvas: every painted region as a filled
 * rect, the user's pending draft as a chain-accent outline. Reads
 * `var(--tw-accent)` from computed style so the highlight tracks the
 * connected chain. Lives in the new Zone 5 of the paint bar; replaces
 * what would have been a separate side rail.
 *
 * Renders to a single 2D canvas element. Skips per-pixel color (too
 * fine at thumbnail scale); each region paints as a single dim rect.
 * That's enough to convey density / where the activity is.
 */
export function Minimap({ regions, canvasWidth, canvasHeight, draft }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.width = MAP_WIDTH
    el.height = MAP_HEIGHT
    const ctx = el.getContext('2d')
    if (!ctx) return

    // Backdrop matches the canvas-stack color so the minimap reads as
    // a literal mini-canvas rather than a separate panel.
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT)

    if (canvasWidth <= 0 || canvasHeight <= 0) return
    const sx = MAP_WIDTH / canvasWidth
    const sy = MAP_HEIGHT / canvasHeight

    // Painted regions — a 33%-alpha-ish fill so dense areas darken
    // visibly without obliterating the backdrop.
    if (regions) {
      ctx.fillStyle = 'rgba(168, 174, 188, 0.55)'
      for (const r of regions) {
        const x = r.x * sx
        const y = r.y * sy
        const w = Math.max(1, r.w * sx)
        const h = Math.max(1, r.h * sy)
        ctx.fillRect(x, y, w, h)
      }
    }

    // Draft outline — chain accent. Read from computed style so it
    // tracks the chain palette via the global --tw-accent override.
    if (draft) {
      const accent =
        getComputedStyle(el).getPropertyValue('--tw-accent').trim() || '#A8FF2E'
      const dx = draft.x * sx
      const dy = draft.y * sy
      const dw = Math.max(2, draft.w * sx)
      const dh = Math.max(2, draft.h * sy)
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh)
      // Small fill so a 1-pixel draft is still visible at thumbnail
      // scale. 20% alpha keeps the underlying region visible.
      ctx.fillStyle = `${accent}33`
      ctx.fillRect(dx, dy, dw, dh)
    }
  }, [regions, canvasWidth, canvasHeight, draft])

  return (
    <canvas
      ref={ref}
      className="paint-minimap"
      aria-label="Canvas overview minimap"
    />
  )
}
