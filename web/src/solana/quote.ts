/**
 * Client-side quote math: a TypeScript port of the program's
 * `quote_one` (solana/programs/tagwall/src/instructions/paint.rs).
 * The program has no view function (Solana has no eth_call analogue
 * for arbitrary returns without simulation), so the frontend computes
 * quotes from fetched tile state + the canvas config.
 *
 * test/solanaQuote.test.ts pins this against the exact vectors of the
 * Rust unit tests; a drift means painters get wrong price displays and
 * possibly PriceAboveMax reverts.
 */

import { SOLANA_TILE_SIZE, SOLANA_TRANSPARENT } from './constants'
import type { SolanaCanvasConfig, SolanaTile } from './client'
import type { StampChunk } from './encodeStamp'

const BPS = 10_000n
const OVERWRITE_PREMIUM_BPS = 1_000n
const MONTH_SECONDS = 30n * 24n * 60n * 60n

export interface QuoteParams {
  startingPrice: bigint
  decayPerMonthBps: bigint
  freezePeriodSeconds: bigint
}

/** Quote one pixel. Mirrors quote_one() in paint.rs exactly. */
export function quoteOnePixel(
  lastPrice: bigint,
  lastPaintedAt: number,
  nowSec: number,
  cfg: QuoteParams,
): bigint {
  if (lastPrice === 0n || lastPaintedAt === 0) return cfg.startingPrice

  const floor = cfg.startingPrice
  let decayed = lastPrice
  // Rust saturating_sub: clock skew can put lastPaintedAt in our future.
  const elapsed = nowSec > lastPaintedAt ? BigInt(nowSec - lastPaintedAt) : 0n

  if (elapsed > cfg.freezePeriodSeconds && lastPrice > floor) {
    const decaySeconds = elapsed - cfg.freezePeriodSeconds
    const headroom = lastPrice - floor
    const decayAmount =
      (headroom * cfg.decayPerMonthBps * decaySeconds) / (MONTH_SECONDS * BPS)
    decayed = decayed > decayAmount ? decayed - decayAmount : 0n
    if (decayed < floor) decayed = floor
  }

  return (decayed * (BPS + OVERWRITE_PREMIUM_BPS)) / BPS
}

/** Key for the tile lookup map: "tx,ty". */
export function tileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`
}

export function tileMapOf(tiles: SolanaTile[]): Map<string, SolanaTile> {
  return new Map(tiles.map((t) => [tileKey(t.tileX, t.tileY), t]))
}

function pixelState(
  tiles: Map<string, SolanaTile>,
  x: number,
  y: number,
): { lastPrice: bigint; lastPaintedAt: number } {
  const t = tiles.get(
    tileKey(Math.floor(x / SOLANA_TILE_SIZE), Math.floor(y / SOLANA_TILE_SIZE)),
  )
  if (!t) return { lastPrice: 0n, lastPaintedAt: 0 } // lazy tile = virgin
  const lx = x % SOLANA_TILE_SIZE
  const ly = y % SOLANA_TILE_SIZE
  const p = t.pixels[ly * SOLANA_TILE_SIZE + lx]
  return { lastPrice: p.lastPrice, lastPaintedAt: p.lastPaintedAt }
}

/**
 * Quote one encoder chunk against current tile state. Transparent
 * pixels are skipped (they don't paint and don't pay), matching the
 * program loop. Chunks of one plan never overlap, so summing chunk
 * quotes gives the stamp total without compounding concerns.
 */
export function quoteChunk(
  chunk: StampChunk,
  tiles: Map<string, SolanaTile>,
  cfg: SolanaCanvasConfig,
  nowSec: number,
): bigint {
  const params: QuoteParams = {
    startingPrice: cfg.startingPrice,
    decayPerMonthBps: cfg.decayPerMonthBps,
    freezePeriodSeconds: cfg.freezePeriodSeconds,
  }
  let total = 0n
  for (let row = 0; row < chunk.h; row++) {
    for (let col = 0; col < chunk.w; col++) {
      const idx = row * chunk.w + col
      let opaque: boolean
      if (chunk.format === 'fill') {
        opaque = true
      } else if (chunk.format === 'palette') {
        opaque = chunk.indices[idx] !== 255
      } else {
        opaque = chunk.colors[idx] !== SOLANA_TRANSPARENT
      }
      if (!opaque) continue
      const p = pixelState(tiles, chunk.x + col, chunk.y + row)
      total += quoteOnePixel(p.lastPrice, p.lastPaintedAt, nowSec, params)
    }
  }
  return total
}

/** Per-chunk quotes plus the stamp total. */
export function quotePlan(
  chunks: StampChunk[],
  tiles: Map<string, SolanaTile>,
  cfg: SolanaCanvasConfig,
  nowSec: number,
): { perChunk: bigint[]; total: bigint } {
  const perChunk = chunks.map((c) => quoteChunk(c, tiles, cfg, nowSec))
  return { perChunk, total: perChunk.reduce((a, b) => a + b, 0n) }
}

/** The 10% slippage headroom the EVM frontend also applies. */
export function withSlippage(quote: bigint): bigint {
  return (quote * 11n) / 10n
}
