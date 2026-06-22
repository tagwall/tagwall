// Solana stamp encoder tests. Pure-TS: no cluster, no web3.js.
//
// The invariants that matter:
//   1. decodePlan(encodeStamp(s)) round-trips EXACTLY for lossless
//      plans and for the "full" plan of high-color stamps (the
//      preview-is-the-truth contract).
//   2. Every chunk respects the measured 1,232-byte tx budget and the
//      1,500 px program cap.
//   3. Quantized "standard" plans stay within the color budget and
//      never disturb the transparency mask.

import { describe, expect, it } from 'vitest'

import {
  PALETTE_MAX_COLORS,
  SOLANA_MAX_PIXELS_PER_TX,
  SOLANA_MAX_TX_BYTES,
  SOLANA_TRANSPARENT,
} from '../src/solana/constants'
import {
  chunkBytes,
  decodePlan,
  encodeStamp,
  type StampInput,
  type StampPlan,
} from '../src/solana/encodeStamp'

function tileCountOf(c: { x: number; y: number; w: number; h: number }): number {
  const t = 20
  return (
    (Math.floor((c.x + c.w - 1) / t) - Math.floor(c.x / t) + 1) *
    (Math.floor((c.y + c.h - 1) / t) - Math.floor(c.y / t) + 1)
  )
}

function assertBudgets(plan: StampPlan) {
  for (const c of plan.chunks) {
    const px = c.w * c.h
    expect(px).toBeLessThanOrEqual(SOLANA_MAX_PIXELS_PER_TX)
    const bytes = chunkBytes(
      c.format,
      px,
      tileCountOf(c),
      c.format === 'palette' ? c.palette.length : 0,
    )
    expect(bytes, `${c.format} ${c.w}x${c.h} @(${c.x},${c.y})`).toBeLessThanOrEqual(
      SOLANA_MAX_TX_BYTES,
    )
  }
}

function stamp(
  x: number,
  y: number,
  w: number,
  h: number,
  colorAt: (i: number) => number,
): StampInput {
  const pixels = new Uint32Array(w * h)
  for (let i = 0; i < pixels.length; i++) pixels[i] = colorAt(i)
  return { x, y, w, h, pixels }
}

describe('encodeStamp', () => {
  it('uniform rect becomes a lossless fill plan, one chunk under the cap', () => {
    const s = stamp(100, 40, 30, 30, () => 0xa8ff2e)
    const res = encodeStamp(s)
    expect(res.kind).toBe('lossless')
    if (res.kind !== 'lossless') return
    expect(res.plan.chunks).toHaveLength(1)
    expect(res.plan.chunks[0].format).toBe('fill')
    expect(res.plan.opaquePixels).toBe(900)
    assertBudgets(res.plan)
    expect(decodePlan(res.plan, s)).toEqual(s.pixels)
  })

  it('a 50x30 = 1500 px uniform rect still fits one fill chunk (the program cap)', () => {
    const s = stamp(0, 0, 50, 30, () => 0x123456)
    const res = encodeStamp(s)
    if (res.kind !== 'lossless') throw new Error('expected lossless')
    expect(res.plan.chunks).toHaveLength(1)
    assertBudgets(res.plan)
  })

  it('uniform color WITH transparency takes palette, mask preserved exactly', () => {
    const s = stamp(10, 10, 10, 10, (i) =>
      i % 3 === 0 ? SOLANA_TRANSPARENT : 0xff0000,
    )
    const res = encodeStamp(s)
    if (res.kind !== 'lossless') throw new Error('expected lossless')
    expect(res.plan.chunks.every((c) => c.format === 'palette')).toBe(true)
    expect(decodePlan(res.plan, s)).toEqual(s.pixels)
    assertBudgets(res.plan)
  })

  it('a <=255-color stamp round-trips losslessly through palette chunks', () => {
    // 38x38 logo-like stamp with 200 colors + transparent corners.
    const s = stamp(60, 60, 38, 38, (i) => {
      const col = i % 38
      const row = Math.floor(i / 38)
      const r2 = (col - 19) ** 2 + (row - 19) ** 2
      if (r2 > 19 ** 2) return SOLANA_TRANSPARENT // round logo mask
      return (i % 200) * 81 // 200 distinct colors
    })
    const res = encodeStamp(s)
    expect(res.kind).toBe('lossless')
    if (res.kind !== 'lossless') return
    expect(decodePlan(res.plan, s)).toEqual(s.pixels)
    assertBudgets(res.plan)
    // Worst-case synthetic: 200 cycling colors make per-band palette
    // tables nearly band-sized, and the 2x2-tile span shrinks u32
    // bands to ~150 px, so BOTH encodings land at 10 chunks and the
    // planner just has to not do worse. Real logos repeat colors
    // heavily and land around 3-6 chunks at this size.
    expect(res.plan.chunks.length).toBeLessThanOrEqual(10)
  })

  it('a >255-color stamp yields standard + full plans; full is exact', () => {
    // Smooth gradient: every pixel a distinct color (38x38 = 1,444).
    const s = stamp(0, 0, 38, 38, (i) => i | ((i * 7) << 8))
    const res = encodeStamp(s)
    expect(res.kind).toBe('choice')
    if (res.kind !== 'choice') return

    // Full plan: exact round-trip, u32 chunks.
    expect(decodePlan(res.full, s)).toEqual(s.pixels)
    expect(res.full.chunks.every((c) => c.format === 'u32')).toBe(true)
    assertBudgets(res.full)

    // Standard plan: <=64 colors after quantize, mask untouched,
    // and meaningfully fewer transactions.
    const decoded = decodePlan(res.standard, s)
    const colors = new Set<number>()
    for (const p of decoded) if (p !== SOLANA_TRANSPARENT) colors.add(p)
    expect(colors.size).toBeLessThanOrEqual(64)
    assertBudgets(res.standard)
    expect(res.standard.chunks.length).toBeLessThan(res.full.chunks.length)
  })

  it('quantization never moves the transparency mask', () => {
    const s = stamp(0, 0, 40, 40, (i) =>
      i % 7 === 0 ? SOLANA_TRANSPARENT : (i * 1103) & 0xffffff,
    )
    const res = encodeStamp(s)
    if (res.kind !== 'choice') throw new Error('expected choice')
    const decoded = decodePlan(res.standard, s)
    for (let i = 0; i < s.pixels.length; i++) {
      expect(decoded[i] === SOLANA_TRANSPARENT).toBe(
        s.pixels[i] === SOLANA_TRANSPARENT,
      )
    }
  })

  it('canvas-width fill splits into column groups within the account budget', () => {
    const s = stamp(0, 100, 1250, 4, () => 0x00aa00)
    const res = encodeStamp(s)
    if (res.kind !== 'lossless') throw new Error('expected lossless')
    assertBudgets(res.plan)
    // Every chunk's tile span must stay paintable.
    for (const c of res.plan.chunks) {
      expect(tileCountOf(c)).toBeLessThanOrEqual(20)
    }
    // Reassembles exactly.
    expect(decodePlan(res.plan, s)).toEqual(s.pixels)
  })

  it('wide u32 stamps column-split until a row fits', () => {
    // 400-wide full-color band: a single row at 400 px = 1,600 B of
    // colors, over budget, so the encoder must split columns.
    const s = stamp(0, 0, 400, 2, (i) => i | 0x010000)
    const res = encodeStamp(s)
    if (res.kind !== 'choice') throw new Error('expected choice')
    assertBudgets(res.full)
    expect(decodePlan(res.full, s)).toEqual(s.pixels)
  })

  it('rejects empty and mismatched stamps', () => {
    expect(() =>
      encodeStamp({ x: 0, y: 0, w: 2, h: 2, pixels: new Uint32Array(3) }),
    ).toThrow(/length/)
    expect(() =>
      encodeStamp(stamp(0, 0, 2, 2, () => SOLANA_TRANSPARENT)),
    ).toThrow(/no opaque/)
  })

  it('palette plans honour the 255-entry ceiling', () => {
    const s = stamp(0, 0, 30, 30, (i) => (i % PALETTE_MAX_COLORS) * 3)
    const res = encodeStamp(s)
    if (res.kind !== 'lossless') throw new Error('expected lossless')
    for (const c of res.plan.chunks) {
      if (c.format === 'palette') {
        expect(c.palette.length).toBeLessThanOrEqual(PALETTE_MAX_COLORS)
        for (const idx of c.indices) {
          expect(idx === 255 || idx < c.palette.length).toBe(true)
        }
      }
    }
  })
})
