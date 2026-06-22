/**
 * Retry-without-repaying for Solana: the port of the EVM
 * maskUnchangedPixels pre-flight (hooks/usePaintSubmitBatch.ts). Any
 * draft pixel whose CURRENT on-chain color already matches the draft
 * target (regardless of who painted it) is masked to the transparent
 * sentinel, which the program skips with zero charge. A retry after a
 * partial paint then pays only for the pixels that actually changed.
 *
 * Pure function over already-fetched tile state: Solana needs no
 * extra RPC round-trip here because useSolanaCanvas already holds
 * every lazy tile (the EVM version had to multicall pixelAt).
 */

import type { SolanaTile } from './client'
import { SOLANA_TILE_SIZE, SOLANA_TRANSPARENT } from './constants'
import { tileKey } from './quote'

export interface MaskableDraft {
  x: number
  y: number
  w: number
  h: number
  /** Row-major 0xRRGGBB values; SOLANA_TRANSPARENT marks skipped pixels. */
  pixels: Uint32Array
}

/**
 * Returns a COPY of draft.pixels where every pixel that is already
 * painted on-chain (lastPrice > 0; virgin pixels must still be paid
 * for even if the default color happens to match) with the draft's
 * exact color becomes SOLANA_TRANSPARENT. Pixels already transparent
 * in the draft stay transparent. Mirrors the EVM semantics: 24-bit
 * RGB comparison, current chain color vs draft target color.
 */
export function maskUnchangedPixels(
  draft: MaskableDraft,
  tileMap: Map<string, SolanaTile>,
): Uint32Array {
  const out = Uint32Array.from(draft.pixels)
  for (let dy = 0; dy < draft.h; dy++) {
    for (let dx = 0; dx < draft.w; dx++) {
      const idx = dy * draft.w + dx
      const target = out[idx]
      if (target === SOLANA_TRANSPARENT) continue // already skipped + unpaid
      const x = draft.x + dx
      const y = draft.y + dy
      const tile = tileMap.get(
        tileKey(Math.floor(x / SOLANA_TILE_SIZE), Math.floor(y / SOLANA_TILE_SIZE)),
      )
      if (!tile) continue // lazy tile = virgin pixel; must repaint
      const p = tile.pixels[(y % SOLANA_TILE_SIZE) * SOLANA_TILE_SIZE + (x % SOLANA_TILE_SIZE)]
      if (p.lastPrice === 0n) continue // virgin; must repaint
      // 24-bit RGB comparison, matching the EVM mask (high bytes are
      // sentinel/marker space, never stored color).
      if ((p.color & 0xffffff) === (target & 0xffffff)) {
        out[idx] = SOLANA_TRANSPARENT // program skips it, charges nothing
      }
    }
  }
  return out
}
