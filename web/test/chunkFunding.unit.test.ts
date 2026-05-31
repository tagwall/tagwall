import { describe, expect, it } from 'vitest'

import { allocateChunkFunding } from '../src/lib/chunkFunding'
import type { PaintChunk } from '../src/lib/chunkDraft'

/**
 * Pure-arithmetic teeth for the multi-chunk funding fix. No chain needed:
 * these pin down allocateChunkFunding, which is exactly where the
 * PriceAboveMax regression lived. The anvil suite then proves the live
 * `chunkCostWeights` feeds it the right per-chunk quotes against a real
 * Canvas.
 *
 * The scenario throughout: a stamp that chunks into a FRESH top band and a
 * heavily-overwritten (expensive) bottom band. The contract charges each
 * chunk the sum of its pixels' quotes, so the bottom band can cost far more
 * than its pixel-count share of the total.
 */

const ETH = 10n ** 18n
const FINNEY = 10n ** 15n // 0.001 ETH, a convenient round wei magnitude

/** Minimal PaintChunk; only `pixels` matters to the count-weighted path. */
function chunk(pixels: number): PaintChunk {
  return { x: 0, y: 0, w: pixels, h: 1, colors: [], pixels }
}

/** Sum a funding field across all chunks. */
function sum(arr: { value: bigint; maxTotalCost: bigint }[], key: 'value' | 'maxTotalCost'): bigint {
  return arr.reduce((s, f) => s + f[key], 0n)
}

describe('allocateChunkFunding', () => {
  // Two chunks: fresh top (1500 px, cheap) + hot bottom (500 px, pricey).
  // Live quotes (what chunkCostWeights returns): top 0.012 ETH, bottom 0.22 ETH.
  const topQuote = 12n * FINNEY //  0.012 ETH for 1500 fresh pixels
  const bottomQuote = 220n * FINNEY // 0.220 ETH for 500 overwritten pixels
  const sumQuotes = topQuote + bottomQuote // 0.232 ETH
  // The frontend approves total = quote * 1.10 (10% slippage buffer).
  const approvedTotal = (sumQuotes * 11n) / 10n // 0.2552 ETH
  const chunks = [chunk(1500), chunk(500)]
  const costWeights = [topQuote, bottomQuote]
  const countWeights = chunks.map((c) => BigInt(c.pixels))

  it('cost-weighted: every chunk is funded at or above its real quote', () => {
    const funding = allocateChunkFunding({
      chunks,
      weights: costWeights,
      value: approvedTotal,
      maxTotalCost: approvedTotal,
    })
    // The whole point: the expensive bottom band must get enough headroom.
    expect(funding[0].maxTotalCost).toBeGreaterThanOrEqual(topQuote)
    expect(funding[1].maxTotalCost).toBeGreaterThanOrEqual(bottomQuote)
    expect(funding[0].value).toBeGreaterThanOrEqual(topQuote)
    expect(funding[1].value).toBeGreaterThanOrEqual(bottomQuote)
  })

  it('conserves the approved total exactly (no wei created or stranded)', () => {
    const funding = allocateChunkFunding({
      chunks,
      weights: costWeights,
      value: approvedTotal,
      maxTotalCost: approvedTotal,
    })
    expect(sum(funding, 'value')).toBe(approvedTotal)
    expect(sum(funding, 'maxTotalCost')).toBe(approvedTotal)
  })

  it('REGRESSION: pixel-count weighting under-funds the expensive band', () => {
    // This is the exact bug. The old code split by pixel count, so the
    // bottom band (25% of pixels but ~95% of the cost) got only ~25% of the
    // funds and the contract reverted PriceAboveMax even though the user
    // sent more than enough in aggregate.
    const funding = allocateChunkFunding({
      chunks,
      weights: countWeights,
      value: approvedTotal,
      maxTotalCost: approvedTotal,
    })
    // The bottom chunk's cap lands BELOW its real quote → on-chain revert.
    expect(funding[1].maxTotalCost).toBeLessThan(bottomQuote)
    // ...while the cheap top chunk is wildly over-funded, confirming the
    // funds were there, just misallocated.
    expect(funding[0].maxTotalCost).toBeGreaterThan(topQuote)
  })

  it('last chunk absorbs the floor-division remainder', () => {
    // 10 split by weights [3,3,3]: floor gives 3,3 and the last gets 10-6=4.
    const three = [chunk(3), chunk(3), chunk(3)]
    const funding = allocateChunkFunding({
      chunks: three,
      weights: [3n, 3n, 3n],
      value: 10n,
      maxTotalCost: 10n,
    })
    expect(funding.map((f) => f.value)).toEqual([3n, 3n, 4n])
    expect(sum(funding, 'value')).toBe(10n)
  })

  it('single chunk receives the entire total', () => {
    const funding = allocateChunkFunding({
      chunks: [chunk(2000)],
      weights: [999n],
      value: ETH,
      maxTotalCost: ETH,
    })
    expect(funding).toHaveLength(1)
    expect(funding[0]).toEqual({ value: ETH, maxTotalCost: ETH })
  })

  it('three-band mixed prices: each band funded above its quote, total conserved', () => {
    // top fresh, middle warm, bottom hot.
    const q = [10n * FINNEY, 40n * FINNEY, 300n * FINNEY]
    const total = ((q[0] + q[1] + q[2]) * 11n) / 10n
    const bands = [chunk(1000), chunk(400), chunk(100)]
    const funding = allocateChunkFunding({ chunks: bands, weights: q, value: total, maxTotalCost: total })
    funding.forEach((f, i) => expect(f.maxTotalCost).toBeGreaterThanOrEqual(q[i]))
    expect(sum(funding, 'maxTotalCost')).toBe(total)
  })
})
