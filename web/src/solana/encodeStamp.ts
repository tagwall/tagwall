/**
 * Solana stamp encoder: turns a paint draft into a transaction plan
 * using the cheapest wire format the stamp allows, chunked against the
 * measured 1,232-byte transaction budget (see constants.ts).
 *
 * Format selection (the "simple UX" contract):
 *   - 1 unique color            → paint_fill, lossless, no choice.
 *   - <= 255 unique colors      → paint_palette, lossless, no choice.
 *   - > 255 unique colors       → TWO plans: "standard" (median-cut
 *     quantize to 64 colors, palette format) and "full" (u32 format).
 *     The UI shows one radio and previews the EXACT decoded pixels of
 *     each plan via decodePlan(), so fidelity is judged by eye on the
 *     bytes that will actually land on-chain, never on trust.
 *
 * Pure TypeScript, no Solana deps: this module only does bytes math
 * and pixel transforms, so it unit-tests in vitest without a cluster.
 */

import {
  ARGS_FIXED_FILL,
  ARGS_FIXED_PALETTE,
  ARGS_FIXED_U32,
  PALETTE_MAX_COLORS,
  PALETTE_TRANSPARENT_INDEX,
  SOLANA_MAX_PIXELS_PER_TX,
  SOLANA_MAX_TX_BYTES,
  SOLANA_TILE_SIZE,
  SOLANA_TRANSPARENT,
  SOLANA_TX_SAFETY_MARGIN,
  WIRE_LEGACY,
  type WireProfile,
} from './constants'

export interface StampInput {
  x: number
  y: number
  w: number
  h: number
  /** Row-major 0xRRGGBB values; SOLANA_TRANSPARENT marks skipped pixels. */
  pixels: Uint32Array
}

export type StampChunk =
  | { format: 'fill'; x: number; y: number; w: number; h: number; color: number }
  | {
      format: 'palette'
      x: number
      y: number
      w: number
      h: number
      palette: number[]
      indices: Uint8Array
    }
  | { format: 'u32'; x: number; y: number; w: number; h: number; colors: Uint32Array }

export interface StampPlan {
  chunks: StampChunk[]
  /** Total opaque pixels across all chunks (transparent never pays). */
  opaquePixels: number
}

export type EncodeResult =
  | { kind: 'lossless'; plan: StampPlan }
  | { kind: 'choice'; standard: StampPlan; full: StampPlan }

/* ------------------------------ helpers ----------------------------- */

function tileCount(x: number, y: number, w: number, h: number): number {
  const tx0 = Math.floor(x / SOLANA_TILE_SIZE)
  const tx1 = Math.floor((x + w - 1) / SOLANA_TILE_SIZE)
  const ty0 = Math.floor(y / SOLANA_TILE_SIZE)
  const ty1 = Math.floor((y + h - 1) / SOLANA_TILE_SIZE)
  return (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
}

/** Instruction-data + envelope bytes for a chunk under a format. */
export function chunkBytes(
  format: StampChunk['format'],
  px: number,
  tiles: number,
  paletteLen = 0,
  profile: WireProfile = WIRE_LEGACY,
): number {
  const envelope =
    profile.envelopeBase + profile.perExtraTile * Math.max(0, tiles - 1)
  // Palette entries are packed 3-byte RGB on the wire (program v2.2).
  const args =
    format === 'fill'
      ? ARGS_FIXED_FILL
      : format === 'palette'
        ? ARGS_FIXED_PALETTE + 3 * paletteLen + px
        : ARGS_FIXED_U32 + 4 * px
  return envelope + args + SOLANA_TX_SAFETY_MARGIN
}

function fits(
  format: StampChunk['format'],
  px: number,
  tiles: number,
  paletteLen = 0,
  profile: WireProfile = WIRE_LEGACY,
): boolean {
  if (px > SOLANA_MAX_PIXELS_PER_TX) return false
  return chunkBytes(format, px, tiles, paletteLen, profile) <= SOLANA_MAX_TX_BYTES
}

function sliceRows(s: StampInput, y0: number, rows: number): Uint32Array {
  return s.pixels.subarray((y0 - s.y) * s.w, (y0 - s.y + rows) * s.w)
}

function uniqueOpaqueColors(pixels: Uint32Array): number[] {
  const set = new Set<number>()
  for (const p of pixels) if (p !== SOLANA_TRANSPARENT) set.add(p)
  return [...set]
}

/* --------------------------- quantization --------------------------- */

/**
 * Median-cut quantization over OPAQUE pixels only (transparent pixels
 * keep their mask and never enter the palette; this is the bug class
 * the EVM-side render comparison caught: composite-onto-black before
 * quantizing poisons the palette with edge colors).
 */
export function medianCutQuantize(
  pixels: Uint32Array,
  maxColors: number,
): Map<number, number> {
  const colors = uniqueOpaqueColors(pixels)
  const mapping = new Map<number, number>()
  if (colors.length <= maxColors) {
    for (const c of colors) mapping.set(c, c)
    return mapping
  }

  type Bucket = number[]
  let buckets: Bucket[] = [colors]
  while (buckets.length < maxColors) {
    // Split the bucket with the widest channel range.
    let bestIdx = -1
    let bestRange = -1
    let bestShift = 16
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (b.length < 2) continue
      for (const shift of [16, 8, 0]) {
        let lo = 255
        let hi = 0
        for (const c of b) {
          const v = (c >> shift) & 0xff
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo
          bestIdx = i
          bestShift = shift
        }
      }
    }
    if (bestIdx < 0) break // every bucket is a single color
    const b = buckets[bestIdx]
    b.sort((a, c) => (((a >> bestShift) & 0xff) - ((c >> bestShift) & 0xff)))
    const mid = b.length >> 1
    buckets.splice(bestIdx, 1, b.slice(0, mid), b.slice(mid))
  }

  for (const b of buckets) {
    let r = 0
    let g = 0
    let bl = 0
    for (const c of b) {
      r += (c >> 16) & 0xff
      g += (c >> 8) & 0xff
      bl += c & 0xff
    }
    const avg =
      ((Math.round(r / b.length) & 0xff) << 16) |
      ((Math.round(g / b.length) & 0xff) << 8) |
      (Math.round(bl / b.length) & 0xff)
    for (const c of b) mapping.set(c, avg)
  }
  return mapping
}

export function applyMapping(
  pixels: Uint32Array,
  mapping: Map<number, number>,
): Uint32Array {
  const out = new Uint32Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]
    out[i] = p === SOLANA_TRANSPARENT ? SOLANA_TRANSPARENT : (mapping.get(p) ?? p)
  }
  return out
}

/* ----------------------------- chunking ----------------------------- */

/**
 * Greedy horizontal band chunking: grow each band row by row while the
 * chunk still fits its format's byte + pixel budgets. Mirrors the EVM
 * chunkDraft band approach so the canvas paints top-down.
 *
 * Palette chunks carry a PER-CHUNK table holding only the colors that
 * band actually uses. A global table can be structurally unfittable
 * (e.g. 200 colors = 800 bytes of table leaves negative pixel budget),
 * and no amount of spatial splitting fixes that; per-chunk tables make
 * every band independently optimal and guarantee termination (a 1x1
 * chunk has a 1-color table, which always fits).
 *
 * Wide stamps whose single row can't fit are split into column groups
 * at tile boundaries first (a 1,250-px-wide u32 row is ~5 KB of colors
 * plus ~63 tile accounts; nothing fits that).
 */
function bandChunks(
  s: StampInput,
  format: 'u32' | 'palette',
  profile: WireProfile,
): StampChunk[] {
  const out: StampChunk[] = []

  const paletteLenFor = (px: Uint32Array): number =>
    format === 'palette' ? uniqueOpaqueColors(px).length : 0

  // Column split first if a single row can't fit (wide stamps).
  const oneRow = sliceRows(s, s.y, 1)
  if (
    s.w > 1 &&
    !fits(format, s.w, tileCount(s.x, s.y, s.w, 1), paletteLenFor(oneRow), profile)
  ) {
    // Split at a tile boundary near the middle and recurse. leftW is
    // clamped to [1, w-1] so both halves shrink: termination is
    // guaranteed because a 1-px chunk always fits either format.
    const midCol = Math.floor(s.w / 2)
    const aligned =
      Math.floor((s.x + midCol) / SOLANA_TILE_SIZE) * SOLANA_TILE_SIZE - s.x
    const leftW = Math.min(Math.max(aligned, 1), s.w - 1)
    const left: StampInput = {
      x: s.x,
      y: s.y,
      w: leftW,
      h: s.h,
      pixels: cropPixels(s, s.x, s.y, leftW, s.h),
    }
    const right: StampInput = {
      x: s.x + leftW,
      y: s.y,
      w: s.w - leftW,
      h: s.h,
      pixels: cropPixels(s, s.x + leftW, s.y, s.w - leftW, s.h),
    }
    return [...bandChunks(left, format, profile), ...bandChunks(right, format, profile)]
  }

  let y = s.y
  while (y < s.y + s.h) {
    let rows = 1
    while (y + rows < s.y + s.h) {
      const candidate = sliceRows(s, y, rows + 1)
      const k = paletteLenFor(candidate)
      if (
        k > PALETTE_MAX_COLORS ||
        !fits(
          format,
          s.w * (rows + 1),
          tileCount(s.x, y, s.w, rows + 1),
          k,
          profile,
        )
      ) {
        break
      }
      rows++
    }
    const px = sliceRows(s, y, rows)
    if (format === 'u32') {
      out.push({ format, x: s.x, y, w: s.w, h: rows, colors: new Uint32Array(px) })
    } else {
      const palette = uniqueOpaqueColors(px)
      const indexOf = new Map(palette.map((c, i) => [c, i]))
      const indices = new Uint8Array(px.length)
      for (let i = 0; i < px.length; i++) {
        indices[i] =
          px[i] === SOLANA_TRANSPARENT
            ? PALETTE_TRANSPARENT_INDEX
            : indexOf.get(px[i])!
      }
      out.push({ format, x: s.x, y, w: s.w, h: rows, palette, indices })
    }
    y += rows
  }
  return out
}

function cropPixels(
  s: StampInput,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint32Array {
  const out = new Uint32Array(w * h)
  for (let row = 0; row < h; row++) {
    const srcStart = (y - s.y + row) * s.w + (x - s.x)
    out.set(s.pixels.subarray(srcStart, srcStart + w), row * w)
  }
  return out
}

function fillChunks(s: StampInput, color: number, profile: WireProfile): StampChunk[] {
  // Pixel cap + tile-account bound. Wide stamps split into column
  // groups first so the tile span stays under the account budget.
  const out: StampChunk[] = []
  const maxTiles = Math.floor(
    (SOLANA_MAX_TX_BYTES - profile.envelopeBase - ARGS_FIXED_FILL - SOLANA_TX_SAFETY_MARGIN) /
      profile.perExtraTile,
  )
  const splitW = Math.min(s.w, Math.max(SOLANA_TILE_SIZE, (maxTiles - 2) * SOLANA_TILE_SIZE))
  for (let cx = s.x; cx < s.x + s.w; cx += splitW) {
    const w = Math.min(splitW, s.x + s.w - cx)
    let y = s.y
    while (y < s.y + s.h) {
      let rows = 1
      while (
        y + rows < s.y + s.h &&
        w * (rows + 1) <= SOLANA_MAX_PIXELS_PER_TX &&
        tileCount(cx, y, w, rows + 1) <= maxTiles
      ) {
        rows++
      }
      out.push({ format: 'fill', x: cx, y, w, h: rows, color })
      y += rows
    }
  }
  return out
}

/* ------------------------------ planning ---------------------------- */

function buildPaletteOrU32Plan(
  s: StampInput,
  colors: number[],
  profile: WireProfile,
): StampPlan {
  let chunks: StampChunk[]
  if (colors.length === 1 && !s.pixels.includes(SOLANA_TRANSPARENT)) {
    // Uniform stamps without transparency are pure fills; uniform WITH
    // transparency still needs per-pixel data, so they take palette.
    chunks = fillChunks(s, colors[0], profile)
  } else if (colors.length <= PALETTE_MAX_COLORS) {
    // Both encodings are lossless here; palette usually wins (1 B/px
    // + table) but loses when a band's colors are nearly all unique
    // (table ~4 B/px + 1 B/px index beats u32's flat 4 B/px only when
    // colors repeat). Take whichever needs fewer transactions.
    const viaPalette = bandChunks(s, 'palette', profile)
    const viaU32 = bandChunks(s, 'u32', profile)
    chunks = viaPalette.length <= viaU32.length ? viaPalette : viaU32
  } else {
    chunks = bandChunks(s, 'u32', profile)
  }
  let opaque = 0
  for (const p of s.pixels) if (p !== SOLANA_TRANSPARENT) opaque++
  return { chunks, opaquePixels: opaque }
}

/**
 * Encode a stamp. Returns either a single lossless plan (no user
 * choice needed: nothing is lost) or a standard/full pair for stamps
 * whose color count exceeds the palette range.
 */
export function encodeStamp(
  s: StampInput,
  standardColors = 64,
  profile: WireProfile = WIRE_LEGACY,
): EncodeResult {
  if (s.pixels.length !== s.w * s.h) {
    throw new Error(`pixels length ${s.pixels.length} != ${s.w}x${s.h}`)
  }
  const colors = uniqueOpaqueColors(s.pixels)
  if (colors.length === 0) {
    throw new Error('stamp has no opaque pixels')
  }

  if (colors.length <= PALETTE_MAX_COLORS) {
    return { kind: 'lossless', plan: buildPaletteOrU32Plan(s, colors, profile) }
  }

  const mapping = medianCutQuantize(s.pixels, standardColors)
  const quantized: StampInput = { ...s, pixels: applyMapping(s.pixels, mapping) }
  return {
    kind: 'choice',
    standard: buildPaletteOrU32Plan(quantized, uniqueOpaqueColors(quantized.pixels), profile),
    full: buildPaletteOrU32Plan(s, colors, profile),
  }
}

/**
 * Decode a plan back into the exact pixels the chain will store. THIS
 * is what the preview renders: the decoded bytes, not the source
 * image, so what the painter approves is byte-identical to what gets
 * painted.
 */
export function decodePlan(
  plan: StampPlan,
  bounds: { x: number; y: number; w: number; h: number },
): Uint32Array {
  const out = new Uint32Array(bounds.w * bounds.h).fill(SOLANA_TRANSPARENT)
  for (const c of plan.chunks) {
    for (let row = 0; row < c.h; row++) {
      for (let col = 0; col < c.w; col++) {
        const idx = c.w * row + col
        let color: number
        if (c.format === 'fill') {
          color = c.color
        } else if (c.format === 'palette') {
          const pi = c.indices[idx]
          color =
            pi === PALETTE_TRANSPARENT_INDEX ? SOLANA_TRANSPARENT : c.palette[pi]
        } else {
          color = c.colors[idx]
        }
        const ox = c.x - bounds.x + col
        const oy = c.y - bounds.y + row
        out[oy * bounds.w + ox] = color
      }
    }
  }
  return out
}
