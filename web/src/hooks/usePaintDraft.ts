import { useCallback, useMemo, useRef, useState } from 'react'

import type { PaintedRegion } from './usePaintedRegions'

/**
 * In-progress paint not yet submitted to the chain. Holds the quantized
 * RGB grid plus the (x, y) position on the canvas.
 */
export interface PaintDraft {
  /** Original image filename for display. */
  name: string
  /** Natural pixel width of the uploaded image. */
  sourceW: number
  /** Natural pixel height of the uploaded image. */
  sourceH: number
  /** Stamp width in canvas pixels. */
  w: number
  /** Stamp height in canvas pixels. */
  h: number
  /** Left edge on the canvas. */
  x: number
  /** Top edge on the canvas. */
  y: number
  /**
   * Row-major flat RGB array, length `w * h`. Each entry is a 24-bit colour
   * 0x00RRGGBB or the transparent sentinel 0xFFFFFFFF (matches
   * Canvas.sol's TRANSPARENT). Passed directly as the `colors[]` argument
   * to `paint()`.
   */
  colors: number[]
  /** Thumbnail data-URL for the control panel preview chip. */
  thumbUrl: string
}

export interface PaintDraftParams {
  /** Canvas width in pixels, needed for clamping `x`. */
  canvasWidth: number
  /** Canvas height in pixels, needed for clamping `y`. */
  canvasHeight: number
  /**
   * Hard cap on stamp side length (in canvas pixels). Enforced by the UI
   * independently of the per-tx pixel cap. See MAX_STAMP_SIDE in App.tsx.
   */
  maxStampSide: number
  /**
   * Currently-painted regions, used to pick an initial position that
   * doesn't overlap existing stamps. Optional; missing = fall back to
   * canvas-centre placement.
   */
  regions?: readonly PaintedRegion[]
  /**
   * Callback that returns the currently-visible canvas viewport rect
   * in CANVAS pixel coords (x, y, w, h), or null if the user is at
   * zoom = 1 and seeing the whole canvas. Called inside `load()` so a
   * draft uploaded while zoomed in lands within the visible area.
   * Without this, a random placement could land far outside the
   * user's view and they wouldn't see their draft until they scroll.
   * Operator preference 2026-05-25.
   */
  getViewport?: () => { x: number; y: number; w: number; h: number } | null
}

/**
 * Pick an initial (x, y) for a newly-loaded draft that doesn't overlap
 * any existing painted region. Samples random positions up to `maxTries`;
 * if every sample overlaps (canvas is saturated), returns a random
 * position anyway so the user has something to drag. Returns canvas-
 * centre if there are no regions to dodge.
 *
 * When the user is zoomed in and only seeing a sub-rect of the canvas,
 * passing `viewport` constrains the candidate positions to land WITHIN
 * the visible area. Without this, a randomly-placed stamp could land
 * far outside what the user is looking at, requiring them to scroll
 * around to find their own draft. Operator preference 2026-05-25.
 */
function pickFreeSlot(
  w: number,
  h: number,
  canvasWidth: number,
  canvasHeight: number,
  regions: readonly PaintedRegion[] | undefined,
  viewport?: { x: number; y: number; w: number; h: number } | null,
): { x: number; y: number } {
  // Constrain the sampling box to the visible viewport (if any),
  // intersected with the canvas extents. The stamp's top-left corner
  // must land in [minX, maxX] × [minY, maxY] for the stamp to fit
  // entirely within the constraint box.
  const minX = viewport ? Math.max(0, Math.floor(viewport.x)) : 0
  const minY = viewport ? Math.max(0, Math.floor(viewport.y)) : 0
  const constraintMaxX = viewport
    ? Math.min(canvasWidth, Math.ceil(viewport.x + viewport.w)) - w
    : canvasWidth - w
  const constraintMaxY = viewport
    ? Math.min(canvasHeight, Math.ceil(viewport.y + viewport.h)) - h
    : canvasHeight - h
  const maxX = Math.max(minX, constraintMaxX)
  const maxY = Math.max(minY, constraintMaxY)

  if (!regions || regions.length === 0) {
    // No regions to dodge: pick the centre of the constraint box.
    return {
      x: minX + Math.floor((maxX - minX) / 2),
      y: minY + Math.floor((maxY - minY) / 2),
    }
  }

  function overlapsAny(px: number, py: number): boolean {
    for (const r of regions!) {
      if (px + w <= r.x) continue
      if (r.x + r.w <= px) continue
      if (py + h <= r.y) continue
      if (r.y + r.h <= py) continue
      return true
    }
    return false
  }

  // 50 tries is enough: at 60% canvas coverage the hit rate of a free
  // slot is ~40% per sample, so 50 tries yields < (0.6)^50 ≈ 8e-12
  // probability of failing the sampling — negligible. We still fall back
  // to a random position if we somehow miss, so the stamp always appears.
  for (let i = 0; i < 50; i++) {
    const x = minX + Math.floor(Math.random() * (maxX - minX + 1))
    const y = minY + Math.floor(Math.random() * (maxY - minY + 1))
    if (!overlapsAny(x, y)) return { x, y }
  }
  return {
    x: minX + Math.floor(Math.random() * (maxX - minX + 1)),
    y: minY + Math.floor(Math.random() * (maxY - minY + 1)),
  }
}

/**
 * Largest (w, h) that preserves the source aspect ratio and fits within
 * `maxSide` on each side. Independent of the per-tx pixel cap; a chunked
 * paint can cover up to maxSide × maxSide pixels total.
 */
function fitToSide(sourceW: number, sourceH: number, maxSide: number): { w: number; h: number } {
  let w = sourceW
  let h = sourceH
  if (w <= maxSide && h <= maxSide) return { w: Math.max(1, w), h: Math.max(1, h) }
  const s = Math.min(maxSide / sourceW, maxSide / sourceH)
  w = Math.max(1, Math.floor(sourceW * s))
  h = Math.max(1, Math.floor(sourceH * s))
  return { w, h }
}

/** Letterbox the source into a maxSide × maxSide frame. Returns the outer
 *  frame dims (always maxSide × maxSide) and the inner image dims within
 *  that frame (preserving aspect). Pixels outside the image are filled
 *  with the transparent sentinel, so they skip on-chain. */
function letterboxDims(sourceW: number, sourceH: number, maxSide: number) {
  const inner = fitToSide(sourceW, sourceH, maxSide)
  return {
    outerW: maxSide,
    outerH: maxSide,
    innerW: inner.w,
    innerH: inner.h,
    offsetX: Math.floor((maxSide - inner.w) / 2),
    offsetY: Math.floor((maxSide - inner.h) / 2),
  }
}

/**
 * Quantize a source bitmap into a (frameW, frameH) output. If
 * `letterbox` is provided, the bitmap is drawn at innerW × innerH centred
 * inside the frame, with the surrounding pixels transparent (skipped on
 * chain). Otherwise the bitmap fills the whole frame.
 */
function quantize(
  bitmap: ImageBitmap,
  frameW: number,
  frameH: number,
  letterbox?: { innerW: number; innerH: number; offsetX: number; offsetY: number },
): { colors: number[]; thumbUrl: string } | null {
  const off = document.createElement('canvas')
  off.width = frameW
  off.height = frameH
  const ctx = off.getContext('2d')
  if (!ctx) return null

  // Transparent background; drawImage overwrites only the inner rect.
  ctx.clearRect(0, 0, frameW, frameH)

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (letterbox) {
    ctx.drawImage(
      bitmap,
      letterbox.offsetX,
      letterbox.offsetY,
      letterbox.innerW,
      letterbox.innerH,
    )
  } else {
    ctx.drawImage(bitmap, 0, 0, frameW, frameH)
  }

  const pixelData = ctx.getImageData(0, 0, frameW, frameH).data
  const colors: number[] = new Array(frameW * frameH)
  for (let i = 0; i < frameW * frameH; i++) {
    const r = pixelData[i * 4 + 0]
    const g = pixelData[i * 4 + 1]
    const b = pixelData[i * 4 + 2]
    const a = pixelData[i * 4 + 3]
    // Alpha < 128 becomes transparent, matches Canvas.sol's 0xFFFFFFFF
    // sentinel (which skips the pixel and doesn't charge for it).
    colors[i] = a < 128 ? 0xffffffff : (r << 16) | (g << 8) | b
  }

  return { colors, thumbUrl: off.toDataURL('image/png') }
}

/**
 * Loads an image file at its natural size (clamped to the per-tx pixel cap
 * if necessary, aspect ratio preserved). Exposes `resize` so the user can
 * shrink or enlarge the stamp while keeping the aspect ratio fixed to the
 * source image.
 */
export function usePaintDraft({
  canvasWidth,
  canvasHeight,
  maxStampSide,
  regions,
  getViewport,
}: PaintDraftParams) {
  const [draft, setDraft] = useState<PaintDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Hold regions in a ref so load() callers pick up the latest list
  // without re-memoising the callback on every region change.
  const regionsRef = useRef<readonly PaintedRegion[] | undefined>(regions)
  regionsRef.current = regions
  // Same ref pattern for the viewport getter so load() can read the
  // current zoom-aware viewport without re-memoising the callback on
  // every scroll/zoom change.
  const getViewportRef = useRef(getViewport)
  getViewportRef.current = getViewport
  // When true, the stamp is laid out in a square frame with the image
  // centered inside and the rest transparent. Useful for extreme-aspect
  // uploads (panoramas, portrait photos) where the default scale leaves
  // the stamp an unusably thin strip. Transparent pixels are skipped on
  // chain (0xFFFFFFFF sentinel), so letterboxing doesn't cost extra.
  const [letterbox, setLetterboxState] = useState(false)

  // Hold the source bitmap so re-quantization on resize doesn't need the
  // original File again. Cleared on `clear()` and replaced on `load()`.
  const sourceBitmapRef = useRef<ImageBitmap | null>(null)

  const disposeSource = useCallback(() => {
    if (sourceBitmapRef.current) {
      sourceBitmapRef.current.close()
      sourceBitmapRef.current = null
    }
  }, [])

  const load = useCallback(
    async (file: File) => {
      setError(null)
      if (!file.type.startsWith('image/')) {
        setError(`File is ${file.type || 'unknown type'}; please choose an image.`)
        return
      }

      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(file)
      } catch (e) {
        setError(`Could not decode image: ${(e as Error).message}`)
        return
      }

      const sourceW = bitmap.width
      const sourceH = bitmap.height

      let w: number
      let h: number
      let q: { colors: number[]; thumbUrl: string } | null
      if (letterbox) {
        const lb = letterboxDims(sourceW, sourceH, maxStampSide)
        w = lb.outerW
        h = lb.outerH
        q = quantize(bitmap, lb.outerW, lb.outerH, {
          innerW: lb.innerW,
          innerH: lb.innerH,
          offsetX: lb.offsetX,
          offsetY: lb.offsetY,
        })
      } else {
        const fit = fitToSide(sourceW, sourceH, maxStampSide)
        w = fit.w
        h = fit.h
        q = quantize(bitmap, fit.w, fit.h)
      }

      if (!q) {
        setError('2D canvas context unavailable')
        bitmap.close()
        return
      }

      // Swap in the new source bitmap, disposing the previous one.
      disposeSource()
      sourceBitmapRef.current = bitmap

      const viewport = getViewportRef.current?.() ?? null
      const { x, y } = pickFreeSlot(w, h, canvasWidth, canvasHeight, regionsRef.current, viewport)

      setDraft({
        name: file.name,
        sourceW,
        sourceH,
        w,
        h,
        x,
        y,
        colors: q.colors,
        thumbUrl: q.thumbUrl,
      })
    },
    [canvasWidth, canvasHeight, maxStampSide, disposeSource, letterbox],
  )

  /**
   * Resize the stamp, preserving the source aspect ratio.
   *
   * `targetW` is the desired stamp width; height is derived from the source
   * aspect ratio. Both dimensions clamp to >= 1 and to `maxStampSide` on
   * each side. If `targetW` is too small the shorter dimension would round
   * to zero, we ratchet up until both are >= 1.
   */
  const resize = useCallback(
    (targetW: number) => {
      setDraft((d) => {
        if (!d) return d
        const bitmap = sourceBitmapRef.current
        if (!bitmap) return d

        let w: number
        let h: number
        let q: { colors: number[]; thumbUrl: string } | null
        if (letterbox) {
          // In letterbox mode, the stamp is always a square frame; `targetW`
          // is the side. Inner image scales proportionally to fit.
          const side = Math.max(1, Math.min(maxStampSide, Math.round(targetW)))
          const inner = fitToSide(d.sourceW, d.sourceH, side)
          const offsetX = Math.floor((side - inner.w) / 2)
          const offsetY = Math.floor((side - inner.h) / 2)
          w = side
          h = side
          q = quantize(bitmap, side, side, {
            innerW: inner.w,
            innerH: inner.h,
            offsetX,
            offsetY,
          })
        } else {
          // Find a (w, h) that preserves the source ratio and fits the UI cap.
          let tw = Math.max(1, Math.round(targetW))
          let th = Math.max(1, Math.round(tw * (d.sourceH / d.sourceW)))
          if (th < 1) th = 1
          const fitted = fitToSide(tw, th, maxStampSide)
          w = fitted.w
          h = fitted.h
          q = quantize(bitmap, w, h)
        }

        if (w === d.w && h === d.h) return d
        if (!q) return d

        // Keep the stamp's top-left in place, but clamp if the new size
        // would push it off-canvas.
        const x = Math.min(Math.max(0, d.x), canvasWidth - w)
        const y = Math.min(Math.max(0, d.y), canvasHeight - h)

        return { ...d, w, h, x, y, colors: q.colors, thumbUrl: q.thumbUrl }
      })
    },
    [canvasWidth, canvasHeight, maxStampSide, letterbox],
  )

  /**
   * Resize the stamp, preserving aspect ratio, while holding an anchor point
   * fixed. `anchor` is expressed as fractional coordinates within the stamp
   * (0,0 = top-left, 1,1 = bottom-right). Used by the corner-handle drag:
   *   - drag top-left handle  → anchor = (1, 1)  (bottom-right stays put)
   *   - drag top-right handle → anchor = (0, 1)  (bottom-left stays put)
   *   - drag bot-left handle  → anchor = (1, 0)  (top-right stays put)
   *   - drag bot-right handle → anchor = (0, 0)  (top-left stays put)
   */
  const resizeAt = useCallback(
    (targetW: number, anchor: { fx: number; fy: number }) => {
      setDraft((d) => {
        if (!d) return d
        const bitmap = sourceBitmapRef.current
        if (!bitmap) return d

        let w: number
        let h: number
        let q: { colors: number[]; thumbUrl: string } | null
        if (letterbox) {
          const side = Math.max(1, Math.min(maxStampSide, Math.round(targetW)))
          const inner = fitToSide(d.sourceW, d.sourceH, side)
          const offsetX = Math.floor((side - inner.w) / 2)
          const offsetY = Math.floor((side - inner.h) / 2)
          w = side
          h = side
          q = quantize(bitmap, side, side, {
            innerW: inner.w,
            innerH: inner.h,
            offsetX,
            offsetY,
          })
        } else {
          let tw = Math.max(1, Math.round(targetW))
          let th = Math.max(1, Math.round(tw * (d.sourceH / d.sourceW)))
          const fitted = fitToSide(tw, th, maxStampSide)
          w = fitted.w
          h = fitted.h
          q = quantize(bitmap, w, h)
        }
        if (w === d.w && h === d.h) return d
        if (!q) return d

        // Anchor position in absolute canvas coords (unchanged by resize).
        const anchorX = d.x + d.w * anchor.fx
        const anchorY = d.y + d.h * anchor.fy
        const newX = Math.max(0, Math.min(canvasWidth - w, Math.round(anchorX - w * anchor.fx)))
        const newY = Math.max(0, Math.min(canvasHeight - h, Math.round(anchorY - h * anchor.fy)))

        return { ...d, w, h, x: newX, y: newY, colors: q.colors, thumbUrl: q.thumbUrl }
      })
    },
    [canvasWidth, canvasHeight, maxStampSide, letterbox],
  )

  /** Shift the draft to `(x, y)`. Clamped so the stamp stays on-canvas. */
  const moveTo = useCallback(
    (x: number, y: number) => {
      setDraft((d) => {
        if (!d) return d
        const clampedX = Math.max(0, Math.min(canvasWidth - d.w, Math.round(x)))
        const clampedY = Math.max(0, Math.min(canvasHeight - d.h, Math.round(y)))
        if (clampedX === d.x && clampedY === d.y) return d
        return { ...d, x: clampedX, y: clampedY }
      })
    },
    [canvasWidth, canvasHeight],
  )

  const clear = useCallback(() => {
    setDraft(null)
    setError(null)
    disposeSource()
  }, [disposeSource])

  /**
   * Toggle the letterbox layout. Re-quantises the current draft so the
   * stamp flips between natural-aspect and centered-in-square without
   * needing a re-upload. On turn-on for an already-loaded draft, the
   * outer frame becomes maxStampSide × maxStampSide; on turn-off, the
   * outer frame drops back to the aspect-preserving fit.
   */
  const setLetterbox = useCallback((value: boolean) => {
    setLetterboxState(value)
    setDraft((d) => {
      if (!d) return d
      const bitmap = sourceBitmapRef.current
      if (!bitmap) return d
      let w: number
      let h: number
      let q: { colors: number[]; thumbUrl: string } | null
      if (value) {
        const lb = letterboxDims(d.sourceW, d.sourceH, maxStampSide)
        w = lb.outerW
        h = lb.outerH
        q = quantize(bitmap, lb.outerW, lb.outerH, {
          innerW: lb.innerW,
          innerH: lb.innerH,
          offsetX: lb.offsetX,
          offsetY: lb.offsetY,
        })
      } else {
        const fit = fitToSide(d.sourceW, d.sourceH, maxStampSide)
        w = fit.w
        h = fit.h
        q = quantize(bitmap, fit.w, fit.h)
      }
      if (!q) return d
      // Keep centered on current position, clamped to canvas bounds.
      const x = Math.min(Math.max(0, d.x), canvasWidth - w)
      const y = Math.min(Math.max(0, d.y), canvasHeight - h)
      return { ...d, w, h, x, y, colors: q.colors, thumbUrl: q.thumbUrl }
    })
  }, [canvasWidth, canvasHeight, maxStampSide])

  const pixelCount = useMemo(() => (draft ? draft.w * draft.h : 0), [draft])

  /**
   * Max width such that the stamp still fits under the UI side cap.
   * Useful for the resize slider's upper bound.
   *
   * In letterbox mode: the frame is square, so the max side is simply
   * `maxStampSide` regardless of source aspect.
   *
   * In default (aspect-preserving) mode: w * (sourceH/sourceW) must stay
   * within maxStampSide; solve for w.
   */
  const maxWidth = useMemo(() => {
    if (!draft) return 1
    if (letterbox) return maxStampSide
    const r = draft.sourceW / draft.sourceH
    if (r >= 1) {
      // Wider than tall (or square). Width is the binding side.
      return Math.max(1, maxStampSide)
    } else {
      // Taller than wide. Height is the binding side: h = w / r <= maxStampSide
      // → w <= maxStampSide * r.
      return Math.max(1, Math.floor(maxStampSide * r))
    }
  }, [draft, maxStampSide, letterbox])

  return {
    draft,
    error,
    pixelCount,
    maxWidth,
    letterbox,
    load,
    moveTo,
    resize,
    resizeAt,
    setLetterbox,
    clear,
  }
}
