import type { PaintDraft } from '../hooks/usePaintDraft'

/**
 * One piece of a multi-transaction paint. Every chunk covers a contiguous,
 * non-overlapping sub-rectangle of the original stamp; tiled together they
 * exactly reconstruct the stamp.
 */
export interface PaintChunk {
  /** Absolute canvas coordinates for this chunk's rectangle. */
  x: number
  y: number
  w: number
  h: number
  /** Row-major RGB colors for this chunk, length `w * h`. */
  colors: number[]
  /** Total pixel count, mirrors `w * h`. Redundant but convenient. */
  pixels: number
}

/**
 * Split a stamp into horizontal bands that each fit under `maxPixelsPerTx`.
 *
 * Band height is maximised so that `w * bandH <= cap`, minimising the
 * number of chunks. For a 33×60 stamp at cap=1500: maxBandH = 45,
 * producing one 33×45 chunk (1485 px) and one 33×15 chunk (495 px).
 *
 * Guarantees:
 *   - Every chunk satisfies `chunk.w * chunk.h <= maxPixelsPerTx`.
 *   - Concatenating chunks in order reconstructs the stamp exactly.
 *   - Chunk count is `ceil(stamp.h / floor(cap / stamp.w))`.
 *
 * Throws if a single full-width row exceeds the cap (i.e. `stamp.w > cap`),
 * which for the current 60-side UI cap is impossible (60 << 1500).
 */
export function chunkDraft(draft: PaintDraft, maxPixelsPerTx: number): PaintChunk[] {
  const { x, y, w, h, colors } = draft

  if (w > maxPixelsPerTx) {
    throw new Error(
      `Stamp width ${w} exceeds per-tx cap ${maxPixelsPerTx}; cannot chunk into horizontal bands.`,
    )
  }

  if (w * h <= maxPixelsPerTx) {
    return [{ x, y, w, h, colors, pixels: w * h }]
  }

  const maxBandH = Math.floor(maxPixelsPerTx / w)
  const chunks: PaintChunk[] = []
  let dy = 0
  while (dy < h) {
    const bandH = Math.min(maxBandH, h - dy)
    const sliceStart = dy * w
    const sliceEnd = (dy + bandH) * w
    chunks.push({
      x,
      y: y + dy,
      w,
      h: bandH,
      colors: colors.slice(sliceStart, sliceEnd),
      pixels: w * bandH,
    })
    dy += bandH
  }
  return chunks
}
