/**
 * SolanaCanvasView: fully interactive canvas for the Solana chain
 * family, mirroring the EVM CanvasView in HomePage.tsx (zoom, pan,
 * draft drag + corner resize, hover tooltip, floating minimap).
 *
 * Data flows differently from the EVM side: tiles arrive as decoded
 * account state (SolanaTile, 20x20 pixels each) instead of streamed
 * tile queries, so the base render composites ALL tiles into one
 * offscreen canvas, cached by `tiles` identity. Interactions redraw
 * via drawImage only; the per-pixel loop runs once per tiles refresh.
 *
 * Styling reuses the generic classes from styles.css (canvas-frame,
 * canvas-scroll, canvas-stack, tagwall-canvas, pixel-tooltip*,
 * minimap-overlay*, draft-outline-label) so the Solana canvas is
 * visually identical to the EVM one without duplicating CSS.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import type { SolanaCanvasConfig, SolanaPixel, SolanaTile } from '../solana/client'
import {
  SOLANA_CANVAS_HEIGHT,
  SOLANA_CANVAS_WIDTH,
  SOLANA_TILE_SIZE,
  SOLANA_TRANSPARENT,
} from '../solana/constants'
import { quoteOnePixel, tileKey } from '../solana/quote'
import type { PaintDraft } from '../hooks/usePaintDraft'
import { colorToHex } from '../lib/format'

/* ------------------------------ tuning ------------------------------- */

const MAJOR_GRIDLINE_EVERY = 100
/** Virgin backdrop, matches the on-chain "never painted" render. */
const VIRGIN_RGB: [number, number, number] = [16, 16, 19] // rgb(16,16,19)
const GRIDLINE_RGB: [number, number, number] = [29, 29, 38] // #1d1d26, EVM parity
const ACCENT = '#a8ff2e'

export const SOLANA_MIN_ZOOM = 1
export const SOLANA_MAX_ZOOM = 16

// Minimap geometry, mirrors MinimapOverlay.tsx so the widget reads
// identically across chain families.
const MAP_W = 200
const MAP_H = 128
const CTRL_H = 34
const OVERLAY_H = MAP_H + CTRL_H
const MARGIN = 12
// Internal raster buffer for the minimap thumbnail (1/5 canvas scale,
// CSS downscales to MAP_W). drawImage from the composite keeps it cheap.
const MAP_BUF_W = 250
const MAP_BUF_H = 160

/* --------------------------- pure helpers ---------------------------- */
/* Exported for test/solanaCanvasView.test.ts (node env, no jsdom). */

/** Clamp a zoom level to the supported [1, 16] range. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return SOLANA_MIN_ZOOM
  return Math.max(SOLANA_MIN_ZOOM, Math.min(SOLANA_MAX_ZOOM, z))
}

/**
 * Look up the pixel state at canvas coords (x, y). Tiles are
 * lazy-created on chain, so a missing tile means the whole 20x20
 * region is virgin and we return null.
 */
export function solanaPixelAt(
  tileMap: Map<string, SolanaTile>,
  x: number,
  y: number,
): SolanaPixel | null {
  if (x < 0 || y < 0 || x >= SOLANA_CANVAS_WIDTH || y >= SOLANA_CANVAS_HEIGHT) return null
  const t = tileMap.get(
    tileKey(Math.floor(x / SOLANA_TILE_SIZE), Math.floor(y / SOLANA_TILE_SIZE)),
  )
  if (!t) return null
  const lx = x % SOLANA_TILE_SIZE
  const ly = y % SOLANA_TILE_SIZE
  return t.pixels[ly * SOLANA_TILE_SIZE + lx]
}

/**
 * Exact lamports -> SOL display string. Integer division keeps full
 * 9-decimal lamport precision; trailing zeros are trimmed so common
 * prices read short ("0.05" not "0.050000000").
 */
export function formatSol(lamports: bigint): string {
  const ONE_SOL = 1_000_000_000n
  const neg = lamports < 0n
  const abs = neg ? -lamports : lamports
  const whole = abs / ONE_SOL
  const frac = abs % ONE_SOL
  const sign = neg ? '-' : ''
  if (frac === 0n) return `${sign}${whole}`
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '')
  return `${sign}${whole}.${fracStr}`
}

export interface CornerHit {
  corner: 'tl' | 'tr' | 'bl' | 'br'
  /** Fractional anchor (opposite corner) for usePaintDraft.resizeAt. */
  anchor: { fx: number; fy: number }
}

/**
 * Hit-test a canvas-space point against the draft's corner handles.
 * Anchor mapping mirrors usePaintDraft.resizeAt docs: the anchor is
 * the corner that stays put, i.e. the opposite of the grabbed handle.
 * Handles only exist on stamps >= 10x10 (same threshold as the EVM
 * overlay draw, so the hit-test never outpaces the visual).
 */
export function hitDraftCorner(
  d: { x: number; y: number; w: number; h: number },
  cx: number,
  cy: number,
): CornerHit | null {
  if (d.w < 10 || d.h < 10) return null
  const r = 5 // hit radius in canvas pixels, generous vs the 3 px visual
  const corners: Array<CornerHit & { cx: number; cy: number }> = [
    { cx: d.x, cy: d.y, corner: 'tl', anchor: { fx: 1, fy: 1 } },
    { cx: d.x + d.w, cy: d.y, corner: 'tr', anchor: { fx: 0, fy: 1 } },
    { cx: d.x, cy: d.y + d.h, corner: 'bl', anchor: { fx: 1, fy: 0 } },
    { cx: d.x + d.w, cy: d.y + d.h, corner: 'br', anchor: { fx: 0, fy: 0 } },
  ]
  for (const c of corners) {
    if (Math.abs(cx - c.cx) <= r && Math.abs(cy - c.cy) <= r) {
      return { corner: c.corner, anchor: c.anchor }
    }
  }
  return null
}

/* ----------------------------- tooltip ------------------------------- */

/**
 * Floating hover tooltip, Solana flavour of HomePage's
 * PixelHoverTooltip. Same class names so styles.css covers it; the
 * price column is the locally-computed overwrite quote in SOL (the
 * program has no view call, see solana/quote.ts).
 */
function SolPixelTooltip({
  anchor,
  painted,
  color,
  price,
  linkUrl,
  startingPrice,
  onRequestOutbound,
}: {
  anchor: { clientX: number; clientY: number; x: number; y: number }
  painted: boolean
  color: number
  price: bigint | null
  linkUrl: string | undefined
  startingPrice: bigint | null
  onRequestOutbound: (url: string) => void
}) {
  // Offset bottom-right of the cursor; flip on viewport edges.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768
  const tooltipW = 260
  const tooltipH = 140
  const flipX = anchor.clientX + tooltipW + 16 > viewportW
  const flipY = anchor.clientY + tooltipH + 16 > viewportH
  const left = flipX ? anchor.clientX - tooltipW - 12 : anchor.clientX + 12
  const top = flipY ? anchor.clientY - tooltipH - 12 : anchor.clientY + 12

  return (
    <div
      className="pixel-tooltip"
      style={{ left: `${left}px`, top: `${top}px`, width: `${tooltipW}px` }}
      role="status"
      aria-live="polite"
    >
      <div className="pixel-tooltip-coord">
        Pixel <code>({anchor.x}, {anchor.y})</code>
      </div>
      <div className="pixel-tooltip-row">
        <span
          className="pixel-tooltip-swatch"
          style={{
            background: painted ? colorToHex(color) : 'transparent',
            borderStyle: painted ? 'solid' : 'dashed',
          }}
        />
        <code className="pixel-tooltip-hex">{painted ? colorToHex(color) : 'unpainted'}</code>
        <code className="pixel-tooltip-price">
          {price !== null ? formatSol(price) : '…'} <span className="token">SOL</span>
        </code>
      </div>
      {painted && linkUrl && (
        <button
          type="button"
          className="pixel-tooltip-link"
          onClick={() => onRequestOutbound(linkUrl)}
          title="Opens a confirmation dialog before leaving Tagwall"
        >
          {linkUrl}
        </button>
      )}
      {!painted && startingPrice !== null && (
        <p className="pixel-tooltip-hint">
          Unpainted. First tag clears at {formatSol(startingPrice)}{' '}
          <span className="token">SOL</span>/pixel.
        </p>
      )}
    </div>
  )
}

/* ----------------------------- component ----------------------------- */

export interface SolanaCanvasViewProps {
  tiles: SolanaTile[]
  tileMap: Map<string, SolanaTile>
  config: SolanaCanvasConfig | null
  draft: PaintDraft | null
  onDraftMove: (x: number, y: number) => void
  onDraftResize: (targetW: number, anchor: { fx: number; fy: number }) => void
  onRequestOutbound: (url: string) => void
  /** Sync link-registry cache lookup; absent while the cache warms. */
  resolveLink?: (linkId: number) => string | undefined
  onRefresh: () => void
  refreshing: boolean
  /** Controlled zoom so PaintControls' zoom buttons stay in sync. */
  zoom: number
  onZoomChange: (zoom: number) => void
}

export function SolanaCanvasView({
  tiles,
  tileMap,
  config,
  draft,
  onDraftMove,
  onDraftResize,
  onRequestOutbound,
  resolveLink,
  onRefresh,
  refreshing,
  zoom,
  onZoomChange,
}: SolanaCanvasViewProps): JSX.Element {
  const W = SOLANA_CANVAS_WIDTH
  const H = SOLANA_CANVAS_HEIGHT

  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)

  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [cursorClient, setCursorClient] = useState<{ clientX: number; clientY: number } | null>(
    null,
  )
  // Draft body drag offset (cursor minus stamp origin, canvas px).
  const [draftDrag, setDraftDrag] = useState<{ dx: number; dy: number } | null>(null)
  // Active corner-resize; anchor is the opposite corner's fx/fy.
  const [resizing, setResizing] = useState<CornerHit | null>(null)
  // Canvas-pan in progress (pointer held down on empty canvas). State
  // (not just ref) so the tooltip + cursor react.
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{
    startClientX: number
    startClientY: number
    startScrollLeft: number
    startScrollTop: number
    moved: number
  } | null>(null)
  // Hide the "Drag to move" pill after the first interaction with the
  // current draft; a fresh upload (new name) resets it. EVM parity.
  const [draftTouched, setDraftTouched] = useState(false)
  const draftName = draft?.name ?? null
  useEffect(() => {
    setDraftTouched(false)
  }, [draftName])

  // Controlled-zoom mirrors for native (non-React) event handlers.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange

  /* ------------------------- base composite -------------------------- */

  // Full-canvas composite of all tiles over the virgin backdrop, plus
  // EVM-style major gridlines (painted pixels overwrite them). Cached
  // by `tiles` identity: pointer interactions never re-run this loop,
  // they only drawImage the cached canvas (parity checklist item 6).
  const composite = useMemo(() => {
    if (typeof document === 'undefined') return null
    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const ctx = off.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(W, H)
    const data = img.data
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      data[o] = VIRGIN_RGB[0]
      data[o + 1] = VIRGIN_RGB[1]
      data[o + 2] = VIRGIN_RGB[2]
      data[o + 3] = 255
    }
    // Major gridlines every 100 px, same cadence + colour as the EVM
    // canvas so zoomed navigation has the same landmarks.
    for (let x = 0; x <= W; x += MAJOR_GRIDLINE_EVERY) {
      const gx = Math.min(x, W - 1)
      for (let y = 0; y < H; y++) {
        const o = (y * W + gx) * 4
        data[o] = GRIDLINE_RGB[0]
        data[o + 1] = GRIDLINE_RGB[1]
        data[o + 2] = GRIDLINE_RGB[2]
      }
    }
    for (let y = 0; y <= H; y += MAJOR_GRIDLINE_EVERY) {
      const gy = Math.min(y, H - 1)
      for (let x = 0; x < W; x++) {
        const o = (gy * W + x) * 4
        data[o] = GRIDLINE_RGB[0]
        data[o + 1] = GRIDLINE_RGB[1]
        data[o + 2] = GRIDLINE_RGB[2]
      }
    }
    for (const t of tiles) {
      const baseX = t.tileX * SOLANA_TILE_SIZE
      const baseY = t.tileY * SOLANA_TILE_SIZE
      for (let ly = 0; ly < SOLANA_TILE_SIZE; ly++) {
        for (let lx = 0; lx < SOLANA_TILE_SIZE; lx++) {
          const p = t.pixels[ly * SOLANA_TILE_SIZE + lx]
          if (p.lastPrice === 0n) continue // virgin slot in an existing tile
          const o = ((baseY + ly) * W + baseX + lx) * 4
          data[o] = (p.color >> 16) & 0xff
          data[o + 1] = (p.color >> 8) & 0xff
          data[o + 2] = p.color & 0xff
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    return off
  }, [tiles, W, H])

  // Blit the composite into the visible base canvas when it changes.
  useEffect(() => {
    const el = baseRef.current
    if (!el || !composite) return
    el.width = W
    el.height = H
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.drawImage(composite, 0, 0)
  }, [composite, W, H])

  /* -------------------------- draft overlay -------------------------- */

  // Separate overlay canvas so drag ticks never redraw the base.
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    el.width = W
    el.height = H
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, W, H)
    if (!draft) return
    const d = draft
    for (let dy = 0; dy < d.h; dy++) {
      for (let dx = 0; dx < d.w; dx++) {
        const c = d.colors[dy * d.w + dx]
        if (c === SOLANA_TRANSPARENT) continue
        ctx.fillStyle = colorToHex(c)
        ctx.fillRect(d.x + dx, d.y + dy, 1, 1)
      }
    }
    // Dashed accent outline so the stamp is locatable on a busy canvas.
    ctx.strokeStyle = ACCENT
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    ctx.strokeRect(d.x - 0.5, d.y - 0.5, d.w + 1, d.h + 1)
    ctx.setLineDash([])

    // Corner handles: 3x3 squares centred on each corner, only on
    // stamps >= 10x10 so they don't cover the artwork. Must stay in
    // sync with hitDraftCorner's threshold.
    if (d.w >= 10 && d.h >= 10) {
      ctx.fillStyle = '#ffffff'
      const hs = 3
      const corners: Array<[number, number]> = [
        [d.x, d.y],
        [d.x + d.w, d.y],
        [d.x, d.y + d.h],
        [d.x + d.w, d.y + d.h],
      ]
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2)
      }
    }
  }, [draft, W, H])

  /* ------------------------- pointer handlers ------------------------ */

  /** Map clientX/Y to canvas pixel coordinates. */
  function eventToCoord(e: { clientX: number; clientY: number }) {
    const el = baseRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return
    const c = eventToCoord(e)
    if (!c) return

    if (draft) {
      // Corner handle wins over stamp body, otherwise a click in a
      // corner region would start a drag-move.
      const handle = hitDraftCorner(draft, c.x, c.y)
      if (handle) {
        setResizing(handle)
        setDraftTouched(true)
        e.currentTarget.setPointerCapture(e.pointerId)
        e.preventDefault()
        return
      }
      const insideX = c.x >= draft.x && c.x < draft.x + draft.w
      const insideY = c.y >= draft.y && c.y < draft.y + draft.h
      if (insideX && insideY) {
        setDraftDrag({ dx: c.x - draft.x, dy: c.y - draft.y })
        setDraftTouched(true)
        e.currentTarget.setPointerCapture(e.pointerId)
        e.preventDefault()
        return
      }
    }

    // Empty canvas (or outside the draft): start a pan. At zoom = 1
    // there's nothing to scroll, but we still track movement so the
    // pointer-up click detection works.
    const scroller = scrollRef.current
    if (!scroller) return
    panRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollLeft: scroller.scrollLeft,
      startScrollTop: scroller.scrollTop,
      moved: 0,
    }
    setPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = eventToCoord(e)
    if (!c) return

    if (resizing && draft) {
      // Anchor in canvas space is the opposite corner of the grabbed
      // handle; target width is the aspect-aware distance to the cursor.
      const anchorX = draft.x + draft.w * resizing.anchor.fx
      const anchorY = draft.y + draft.h * resizing.anchor.fy
      const dx = Math.abs(c.x - anchorX)
      const dy = Math.abs(c.y - anchorY)
      const ratio = draft.sourceW / draft.sourceH
      onDraftResize(Math.max(dx, dy * ratio), resizing.anchor)
      return
    }

    if (draftDrag && draft) {
      onDraftMove(c.x - draftDrag.dx, c.y - draftDrag.dy)
      return
    }

    const pan = panRef.current
    if (pan) {
      const scroller = scrollRef.current
      if (!scroller) return
      const dx = e.clientX - pan.startClientX
      const dy = e.clientY - pan.startClientY
      pan.moved = Math.max(pan.moved, Math.hypot(dx, dy))
      scroller.scrollLeft = pan.startScrollLeft - dx
      scroller.scrollTop = pan.startScrollTop - dy
      return
    }

    const xi = Math.floor(c.x)
    const yi = Math.floor(c.y)
    if (xi >= 0 && xi < W && yi >= 0 && yi < H) {
      setHover({ x: xi, y: yi })
      setCursorClient({ clientX: e.clientX, clientY: e.clientY })
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (resizing) setResizing(null)
    if (draftDrag) setDraftDrag(null)
    const pan = panRef.current
    if (pan) {
      panRef.current = null
      setPanning(false)
      // Sub-threshold movement = a click. With no draft in play, a
      // click on a linked pixel routes through the outbound modal
      // (button semantics, never a raw anchor). EVM parity.
      if (pan.moved < 4 && !draft) {
        const c = eventToCoord(e)
        if (c) {
          const p = solanaPixelAt(tileMap, Math.floor(c.x), Math.floor(c.y))
          if (p && p.lastPrice > 0n && p.linkId > 0) {
            const url = resolveLink?.(p.linkId)
            if (url) onRequestOutbound(url)
          }
        }
      }
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    setResizing(null)
    setDraftDrag(null)
    panRef.current = null
    setPanning(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function onPointerLeave() {
    // Captured drags keep receiving moves; this only clears the idle
    // hover state when the cursor wanders off the canvas.
    if (!resizing && !draftDrag && !panRef.current) {
      setHover(null)
      setCursorClient(null)
    }
  }

  /* ----------------------- wheel zoom (cursor-centred) --------------- */

  // Where the zoom should hold steady, expressed as a fraction of the
  // (pre-zoom) stack plus the cursor's client position. Stashed by the
  // wheel/button handlers and consumed by the layout effect below once
  // the new zoom has re-rendered the stack at its new size.
  const pendingAnchorRef = useRef<{
    clientX: number
    clientY: number
    fx: number
    fy: number
  } | null>(null)

  function stashAnchor(clientX: number, clientY: number) {
    const scroller = scrollRef.current
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const stackW = scroller.clientWidth * zoomRef.current
    const stackH = stackW * (H / W)
    if (stackW <= 0 || stackH <= 0) return
    pendingAnchorRef.current = {
      clientX,
      clientY,
      fx: (scroller.scrollLeft + clientX - rect.left) / stackW,
      fy: (scroller.scrollTop + clientY - rect.top) / stackH,
    }
  }

  // Native non-passive listener: React's onWheel can land passive on
  // some browsers, and we must preventDefault to stop page scroll.
  // Plain wheel zooms about the cursor (maps/Figma model: wheel =
  // zoom, drag = pan); trackpad pinch arrives as ctrlKey wheel events
  // with small deltas, so the same multiplicative path covers pinch.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      const next = clampZoom(zoomRef.current * factor)
      if (next === zoomRef.current) return
      stashAnchor(e.clientX, e.clientY)
      onZoomChangeRef.current(next)
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  // After a zoom change re-renders the stack, restore the stashed
  // anchor so the canvas point under the cursor stays under it.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const a = pendingAnchorRef.current
    pendingAnchorRef.current = null
    if (!scroller || !a) return
    const rect = scroller.getBoundingClientRect()
    const stackW = scroller.clientWidth * zoom
    const stackH = stackW * (H / W)
    scroller.scrollLeft = a.fx * stackW - (a.clientX - rect.left)
    scroller.scrollTop = a.fy * stackH - (a.clientY - rect.top)
  }, [zoom, W, H])

  function zoomBy(factor: number) {
    const next = clampZoom(zoomRef.current * factor)
    if (next === zoomRef.current) return
    // Anchor button zooms on the viewport centre.
    const scroller = scrollRef.current
    if (scroller) {
      const rect = scroller.getBoundingClientRect()
      stashAnchor(rect.left + scroller.clientWidth / 2, rect.top + scroller.clientHeight / 2)
    }
    onZoomChange(next)
  }

  function zoomFit() {
    scrollRef.current?.scrollTo({ left: 0, top: 0 })
    onZoomChange(1)
  }

  /* --------------------------- hover quote --------------------------- */

  const hoverPixel = hover ? solanaPixelAt(tileMap, hover.x, hover.y) : null
  const hoverPainted = !!hoverPixel && hoverPixel.lastPrice > 0n
  const hoverPrice = useMemo(() => {
    if (!hover || !config) return null
    const p = hoverPixel
    return quoteOnePixel(
      p?.lastPrice ?? 0n,
      p?.lastPaintedAt ?? 0,
      Math.floor(Date.now() / 1000),
      {
        startingPrice: config.startingPrice,
        decayPerMonthBps: config.decayPerMonthBps,
        freezePeriodSeconds: config.freezePeriodSeconds,
      },
    )
  }, [hover, hoverPixel, config])
  const hoverLinkUrl =
    hoverPainted && hoverPixel.linkId > 0 ? resolveLink?.(hoverPixel.linkId) : undefined

  /* ----------------------------- minimap ----------------------------- */

  // Floating minimap overlay: same widget anatomy as MinimapOverlay.tsx
  // (grip drag, viewport rect, zoom strip) but the thumbnail is a cheap
  // drawImage of the cached composite instead of region rects.
  const [mapPos, setMapPos] = useState<{ x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const mapCanvasRef = useRef<HTMLCanvasElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const viewportRectRef = useRef<HTMLDivElement>(null)
  const mapAreaRef = useRef<HTMLDivElement>(null)
  const gripDragRef = useRef<{
    startMouseX: number
    startMouseY: number
    startPosX: number
    startPosY: number
  } | null>(null)
  const mapPanRef = useRef<{
    startMouseX: number
    startMouseY: number
    startScrollX: number
    startScrollY: number
  } | null>(null)

  // Initial placement: bottom-right with margin, set once (operator
  // hard rule: the minimap never moves unless the user drags it).
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let placed = false
    const update = () => {
      if (placed) return
      const r = scroller.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      setMapPos({
        x: Math.max(0, r.width - MAP_W - MARGIN),
        y: Math.max(0, r.height - OVERLAY_H - MARGIN),
      })
      placed = true
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [])

  // Thumbnail: composite scaled into the buffer, draft as accent rect.
  useEffect(() => {
    const el = mapCanvasRef.current
    if (!el) return
    el.width = MAP_BUF_W
    el.height = MAP_BUF_H
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, MAP_BUF_W, MAP_BUF_H)
    if (composite) ctx.drawImage(composite, 0, 0, MAP_BUF_W, MAP_BUF_H)
    if (draft) {
      const sx = MAP_BUF_W / W
      const sy = MAP_BUF_H / H
      const dx = draft.x * sx
      const dy = draft.y * sy
      const dw = Math.max(2, draft.w * sx)
      const dh = Math.max(2, draft.h * sy)
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh)
      ctx.fillStyle = `${ACCENT}33`
      ctx.fillRect(dx, dy, dw, dh)
    }
  }, [composite, draft, W, H])

  // Visible-viewport rect: hidden at zoom = 1 (whole canvas visible),
  // tracks scroll + zoom otherwise. Same math as MinimapOverlay.
  useEffect(() => {
    const scroller = scrollRef.current
    const stack = stackRef.current
    if (!scroller || !stack) return
    const compute = () => {
      const stackRect = stack.getBoundingClientRect()
      if (stackRect.width === 0 || stackRect.height === 0) return
      if (zoom <= 1.0001) {
        setViewport(null)
        return
      }
      setViewport({
        x: (scroller.scrollLeft / stackRect.width) * W,
        y: (scroller.scrollTop / stackRect.height) * H,
        w: (scroller.clientWidth / stackRect.width) * W,
        h: (scroller.clientHeight / stackRect.height) * H,
      })
    }
    compute()
    scroller.addEventListener('scroll', compute, { passive: true })
    window.addEventListener('resize', compute)
    return () => {
      scroller.removeEventListener('scroll', compute)
      window.removeEventListener('resize', compute)
    }
  }, [zoom, W, H])

  function onGripPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!mapPos) return
    e.stopPropagation()
    e.preventDefault()
    gripRef.current?.setPointerCapture(e.pointerId)
    gripDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: mapPos.x,
      startPosY: mapPos.y,
    }
  }

  function onGripPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!gripDragRef.current) return
    e.stopPropagation()
    const scroller = scrollRef.current
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const nextX = gripDragRef.current.startPosX + e.clientX - gripDragRef.current.startMouseX
    const nextY = gripDragRef.current.startPosY + e.clientY - gripDragRef.current.startMouseY
    setMapPos({
      x: Math.max(0, Math.min(rect.width - MAP_W, nextX)),
      y: Math.max(0, Math.min(rect.height - OVERLAY_H, nextY)),
    })
  }

  function onGripPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!gripDragRef.current) return
    e.stopPropagation()
    gripRef.current?.releasePointerCapture(e.pointerId)
    gripDragRef.current = null
  }

  // Drag the lime viewport rect to pan the zoomed canvas.
  function onVpPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const scroller = scrollRef.current
    if (!scroller || zoom <= 1.0001) return
    e.stopPropagation()
    e.preventDefault()
    viewportRectRef.current?.setPointerCapture(e.pointerId)
    mapPanRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startScrollX: scroller.scrollLeft,
      startScrollY: scroller.scrollTop,
    }
  }

  function onVpPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!mapPanRef.current) return
    e.stopPropagation()
    const scroller = scrollRef.current
    const stack = stackRef.current
    if (!scroller || !stack) return
    const stackRect = stack.getBoundingClientRect()
    // Minimap-px delta scales to scroll-px by the stack/minimap ratio.
    scroller.scrollLeft =
      mapPanRef.current.startScrollX +
      (e.clientX - mapPanRef.current.startMouseX) * (stackRect.width / MAP_W)
    scroller.scrollTop =
      mapPanRef.current.startScrollY +
      (e.clientY - mapPanRef.current.startMouseY) * (stackRect.height / MAP_H)
  }

  function onVpPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!mapPanRef.current) return
    e.stopPropagation()
    viewportRectRef.current?.releasePointerCapture(e.pointerId)
    mapPanRef.current = null
  }

  // Click anywhere on the thumbnail to centre the viewport there. The
  // rect's own pointer handlers stopPropagation, so this only fires on
  // bare-map clicks.
  function onMapPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const scroller = scrollRef.current
    const stack = stackRef.current
    const mapEl = mapAreaRef.current
    if (!scroller || !stack || !mapEl || zoom <= 1.0001) return
    e.stopPropagation()
    const mapRect = mapEl.getBoundingClientRect()
    if (mapRect.width === 0 || mapRect.height === 0) return
    const stackRect = stack.getBoundingClientRect()
    const fx = (e.clientX - mapRect.left) / mapRect.width
    const fy = (e.clientY - mapRect.top) / mapRect.height
    scroller.scrollLeft = fx * stackRect.width - scroller.clientWidth / 2
    scroller.scrollTop = fy * stackRect.height - scroller.clientHeight / 2
  }

  /** Stops button clicks bleeding into drag handlers or the canvas. */
  function buttonClick(fn?: () => void) {
    return (e: React.MouseEvent) => {
      e.stopPropagation()
      fn?.()
    }
  }

  /* ------------------------------ render ------------------------------ */

  const vpStyle = viewport
    ? {
        left: (viewport.x / W) * MAP_W,
        top: (viewport.y / H) * MAP_H,
        width: (viewport.w / W) * MAP_W,
        height: (viewport.h / H) * MAP_H,
      }
    : null

  const canvasCursor = draft
    ? resizing
      ? resizing.corner === 'tl' || resizing.corner === 'br'
        ? 'nwse-resize'
        : 'nesw-resize'
      : draftDrag
        ? 'grabbing'
        : 'crosshair'
    : panning
      ? 'grabbing'
      : hoverLinkUrl
        ? 'pointer'
        : 'crosshair'

  return (
    <div className="canvas-frame">
      <div className={`canvas-scroll${zoom > 1 ? ' canvas-scroll-zoomed' : ''}`} ref={scrollRef}>
        <div className="canvas-stack" ref={stackRef} style={{ width: `${zoom * 100}%` }}>
          <canvas
            ref={baseRef}
            className="tagwall-canvas base"
            role="img"
            aria-label={`Tagwall Solana canvas, ${W} by ${H} pixels`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerLeave={onPointerLeave}
            style={{ touchAction: 'none', cursor: canvasCursor }}
          />
          <canvas ref={overlayRef} className="tagwall-canvas overlay" aria-hidden />
          {draft && !draftTouched && (
            // Label-only anchor over the draft rect; the outline itself
            // is the dashed accent stroke on the overlay canvas.
            <div
              style={{
                position: 'absolute',
                left: `${(draft.x / W) * 100}%`,
                top: `${(draft.y / H) * 100}%`,
                width: `${(draft.w / W) * 100}%`,
                height: `${(draft.h / H) * 100}%`,
                pointerEvents: 'none',
              }}
              aria-hidden
            >
              <span className="draft-outline-label">Drag to move</span>
            </div>
          )}
        </div>
      </div>

      {/* Floating minimap: sibling of canvas-scroll inside the
          non-scrolling frame, so panning can't drift it. */}
      {mapPos && (
        <div
          className="minimap-overlay"
          style={{ left: mapPos.x, top: mapPos.y, width: MAP_W, height: OVERLAY_H }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          role="region"
          aria-label="Canvas overview minimap"
        >
          <div
            ref={gripRef}
            className="minimap-overlay-grip"
            onPointerDown={onGripPointerDown}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
            title="Drag to move the minimap"
            aria-label="Minimap drag handle"
          >
            <span aria-hidden>⋮⋮</span>
          </div>
          <div className="minimap-overlay-map" ref={mapAreaRef} onPointerDown={onMapPointerDown}>
            <canvas
              ref={mapCanvasRef}
              className="paint-minimap"
              aria-label="Canvas overview minimap"
            />
            {vpStyle && (
              <div
                ref={viewportRectRef}
                className="minimap-overlay-viewport"
                style={vpStyle}
                onPointerDown={onVpPointerDown}
                onPointerMove={onVpPointerMove}
                onPointerUp={onVpPointerUp}
                onPointerCancel={onVpPointerUp}
                title="Drag to pan the canvas"
              />
            )}
          </div>
          <div className="minimap-overlay-ctrls" role="toolbar" aria-label="Canvas zoom">
            <button
              type="button"
              className="minimap-overlay-btn"
              onClick={buttonClick(() => zoomBy(1 / 1.5))}
              disabled={zoom <= SOLANA_MIN_ZOOM}
              title="Zoom out"
              aria-label="Zoom out"
            >
              −
            </button>
            <span className="minimap-overlay-level" aria-live="polite">
              {zoom.toFixed(1)}×
            </span>
            <button
              type="button"
              className="minimap-overlay-btn"
              onClick={buttonClick(() => zoomBy(1.5))}
              disabled={zoom >= SOLANA_MAX_ZOOM}
              title="Zoom in"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="minimap-overlay-btn minimap-overlay-fit"
              onClick={buttonClick(zoomFit)}
              disabled={zoom === 1}
              title="Reset zoom to fit"
            >
              Fit
            </button>
            <button
              type="button"
              className={`minimap-overlay-btn minimap-overlay-refresh${refreshing ? ' is-spinning' : ''}`}
              onClick={buttonClick(onRefresh)}
              disabled={refreshing}
              title="Refresh canvas data from the chain"
              aria-label="Refresh canvas"
            >
              ↻
            </button>
          </div>
        </div>
      )}

      {/* Hover tooltip, hidden while a draft is placed or a pan is in
          flight (placement UX shouldn't fight the inspector). */}
      {cursorClient && hover && !draft && !panning && (
        <SolPixelTooltip
          anchor={{ ...cursorClient, x: hover.x, y: hover.y }}
          painted={hoverPainted}
          color={hoverPixel?.color ?? 0}
          price={hoverPrice}
          linkUrl={hoverLinkUrl}
          startingPrice={config?.startingPrice ?? null}
          onRequestOutbound={onRequestOutbound}
        />
      )}
    </div>
  )
}
