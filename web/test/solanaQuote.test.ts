// Quote parity tests: the exact vectors of the Rust unit suite
// (quote_one_tests in solana/programs/tagwall/src/instructions/paint.rs).
// If these drift from the program, painters see wrong prices and can
// hit PriceAboveMax reverts, so every Rust vector is mirrored 1:1.

import { describe, expect, it } from 'vitest'

import {
  quoteChunk,
  quoteOnePixel,
  quotePlan,
  tileMapOf,
  withSlippage,
} from '../src/solana/quote'
import type { SolanaCanvasConfig, SolanaTile } from '../src/solana/client'
import { PublicKey } from '@solana/web3.js'

const CFG = {
  startingPrice: 100n,
  decayPerMonthBps: 1_000n,
  freezePeriodSeconds: 90n * 24n * 3_600n,
}
const FREEZE = 90 * 24 * 3_600
const MONTH = 30 * 24 * 3_600

describe('quoteOnePixel (Rust vector parity)', () => {
  it('fresh pixel quotes starting price', () => {
    expect(quoteOnePixel(0n, 0, 0, CFG)).toBe(100n)
  })

  it('immediate repaint charges premium above last price', () => {
    expect(quoteOnePixel(100n, 1, 0, CFG)).toBe(110n)
  })

  it('repaint inside freeze does not decay', () => {
    expect(quoteOnePixel(200n, 1, FREEZE - 1, CFG)).toBe(220n)
  })

  it('decay after freeze targets headroom then applies premium', () => {
    // 200 last, floor 100, one month past freeze: decayed 190, * 1.1 = 209.
    expect(quoteOnePixel(200n, 1, 1 + FREEZE + MONTH, CFG)).toBe(209n)
  })

  it('decay floors at starting price then premium applies', () => {
    expect(quoteOnePixel(100n, 1, FREEZE + 365 * 24 * 3_600, CFG)).toBe(110n)
  })

  it('long decay caps decayed at floor then premium', () => {
    expect(quoteOnePixel(200n, 1, FREEZE + 100 * MONTH, CFG)).toBe(110n)
  })

  it('freeze boundary inclusive: no decay at exactly elapsed == freeze', () => {
    expect(quoteOnePixel(200n, 1, FREEZE, CFG)).toBe(220n)
  })

  it('corrupt pixel with zero timestamp treats as fresh', () => {
    expect(quoteOnePixel(500n, 0, 1_000_000, CFG)).toBe(100n)
  })

  it('clock skew (lastPaintedAt in the future) clamps elapsed to zero', () => {
    expect(quoteOnePixel(200n, 1_000, 500, CFG)).toBe(220n)
  })
})

describe('quoteChunk / quotePlan', () => {
  function virginTiles(): Map<string, SolanaTile> {
    return tileMapOf([])
  }

  const cfg: SolanaCanvasConfig = {
    ...CFG,
    treasury: new PublicKey('H3adprNfDdJaTciMgnaNM4cqW97Lecf6ASL1UxPc7y3Q'),
    stampCount: 0n,
    linkCount: 0,
  }

  it('fresh fill chunk quotes px * starting price', () => {
    const q = quoteChunk(
      { format: 'fill', x: 0, y: 0, w: 10, h: 10, color: 0xff0000 },
      virginTiles(),
      cfg,
      0,
    )
    expect(q).toBe(100n * 100n)
  })

  it('palette transparent markers do not pay', () => {
    const q = quoteChunk(
      {
        format: 'palette',
        x: 0,
        y: 0,
        w: 3,
        h: 1,
        palette: [0xff0000],
        indices: new Uint8Array([0, 255, 0]),
      },
      virginTiles(),
      cfg,
      0,
    )
    expect(q).toBe(200n) // 2 opaque pixels
  })

  it('painted pixels quote the premium via tile state', () => {
    const pixels = Array.from({ length: 400 }, () => ({
      lastPrice: 0n,
      color: 0,
      lastPaintedAt: 0,
      linkId: 0,
    }))
    pixels[0] = { lastPrice: 100n, color: 1, lastPaintedAt: 1, linkId: 0 }
    const tiles = tileMapOf([{ tileX: 0, tileY: 0, pixels }])
    const q = quoteChunk(
      {
        format: 'u32',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        colors: new Uint32Array([0x111111, 0x222222]),
      },
      tiles,
      cfg,
      10,
    )
    expect(q).toBe(110n + 100n) // repaint premium + fresh neighbour
  })

  it('plan total sums chunks and slippage adds 10%', () => {
    const chunks = [
      { format: 'fill' as const, x: 0, y: 0, w: 5, h: 1, color: 1 },
      { format: 'fill' as const, x: 0, y: 1, w: 5, h: 1, color: 1 },
    ]
    const { perChunk, total } = quotePlan(chunks, virginTiles(), cfg, 0)
    expect(perChunk).toEqual([500n, 500n])
    expect(total).toBe(1_000n)
    expect(withSlippage(total)).toBe(1_100n)
  })
})
