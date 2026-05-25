import { useEffect, useRef, useState } from 'react'

import type { PaintedRegion } from '../hooks/usePaintedRegions'
import { Minimap } from './Minimap'

interface Props {
  regions: readonly PaintedRegion[] | undefined
  canvasWidth: number
  canvasHeight: number
  draft?: { x: number; y: number; w: number; h: number } | null
  zoom: number
  /** Ref to the canvas-scroll container. The overlay is a sibling of
   *  canvas-stack INSIDE this container (so it stays anchored to the
   *  visible viewport when the user pans a zoomed canvas), and the
   *  drag-clamp + viewport-rect math both read from this ref's
   *  clientWidth / clientHeight / scrollLeft / scrollTop. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Ref to the canvas-stack container — used only for stack
   *  dimensions in the viewport-rect math (the visible viewport is a
   *  fraction of the stack's scaled size). */
  stackRef: React.RefObject<HTMLDivElement | null>
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomReset?: () => void
  onRefresh?: () => void
  refreshing?: boolean
}

/**
 * Floating minimap overlay that sits on top of the canvas (instead of
 * in the paint rail). Three jobs:
 *
 *   1. Compact thumbnail of painted regions + draft (same as the
 *      original `Minimap` component, reused as-is below).
 *   2. Visible-viewport rectangle drawn over the thumbnail when the
 *      canvas is zoomed, so users see WHERE they are in the canvas as
 *      they pan a zoomed view.
 *   3. Draggable by the user to any position within the canvas display
 *      area — operator preference 2026-05-25, "should be possible to
 *      move the map around within the canvas parameters".
 *
 * Default position: bottom-right of the canvas with 12px margin —
 * standard game-minimap convention so it doesn't fight the upper-left
 * (where most painted activity starts at (0,0)).
 *
 * Pointer events on the overlay stopPropagation so clicks on the
 * minimap don't bleed through to the canvas underneath (which would
 * otherwise treat them as paint clicks at the wrong coordinates).
 */

const MAP_W = 200 // CSS px; canvas-internal buffer is 220 (see Minimap.tsx)
const MAP_H = 128 // ≈ MAP_W * 16/25
const CTRL_H = 34 // zoom-controls strip below the minimap canvas
const OVERLAY_H = MAP_H + CTRL_H
const MARGIN = 12 // initial distance from the canvas corner

export function MinimapOverlay({
  regions,
  canvasWidth,
  canvasHeight,
  draft,
  zoom,
  scrollContainerRef,
  stackRef,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onRefresh,
  refreshing,
}: Props) {
  // Position state in (x, y) px relative to the canvas-stack's top-left.
  // Initialised lazily in an effect once we can measure the stack.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const dragRef = useRef<{
    startMouseX: number
    startMouseY: number
    startPosX: number
    startPosY: number
  } | null>(null)
  // Separate drag state for "drag the viewport rect on the minimap to
  // pan the canvas". Distinct from `dragRef` (which moves the WHOLE
  // overlay widget). Pan-drag starts only when the pointer-down lands
  // on the viewport-rect element. Math: minimap-px delta → canvas-px
  // delta (× canvas/MAP ratio) → scroll-px delta (× zoom).
  const panDragRef = useRef<{
    startMouseX: number
    startMouseY: number
    startScrollX: number
    startScrollY: number
  } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const gripRef = useRef<HTMLDivElement>(null)
  const viewportRectRef = useRef<HTMLDivElement>(null)

  // Initial placement: bottom-right of the canvas viewport with
  // MARGIN padding. The overlay is now a sibling of `.canvas-scroll`
  // inside a non-scrolling `.canvas-frame` wrapper, so scroll events
  // can't drift it off-viewport — no scroll listener needed.
  //
  // Operator's hard rules 2026-05-25:
  //   1. The minimap is always shown on the screen within the bounds
  //      of the canvas (initial placement + drag clamping enforce this).
  //   2. The minimap floats on top of the canvas, not attached to it
  //      (sibling of canvas-scroll, NOT child — does not move when
  //      the canvas-stack inside canvas-scroll scrolls).
  //   3. The minimap does not move unless the user does a click+drag
  //      on it (no scroll listener, no resize-induced corner snap;
  //      ResizeObserver only fires to set initial position once when
  //      `pos === null`, never to re-snap a user-placed overlay).
  useEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller) return
    let placed = false
    const update = () => {
      if (placed) return // rule 3: don't ever move it after first placement
      const r = scroller.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return // not laid out yet
      setPos({
        x: Math.max(0, r.width - MAP_W - MARGIN),
        y: Math.max(0, r.height - OVERLAY_H - MARGIN),
      })
      placed = true
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [scrollContainerRef])

  // Viewport-rect computation. When zoom = 1 the canvas-stack fits
  // exactly inside canvas-scroll (no scrolling possible), so the
  // visible rect is the entire canvas — we hide the indicator in
  // that case to avoid drawing a useless full-perimeter outline.
  // When zoom > 1, canvas-stack is larger than canvas-scroll;
  // scrollLeft/scrollTop tell us how the user has panned, and
  // clientWidth/clientHeight tell us how much they can currently see.
  useEffect(() => {
    const scroller = scrollContainerRef.current
    const stack = stackRef.current
    if (!scroller || !stack) return

    const compute = () => {
      // Read from `stack` so the math works even before the wagmi
      // chain ID load completes (stack is laid out from CSS, not data).
      const stackRect = stack.getBoundingClientRect()
      if (stackRect.width === 0 || stackRect.height === 0) return
      if (zoom <= 1.0001) {
        setViewport(null)
        return
      }
      const fx = scroller.scrollLeft / stackRect.width
      const fy = scroller.scrollTop / stackRect.height
      const fw = scroller.clientWidth / stackRect.width
      const fh = scroller.clientHeight / stackRect.height
      setViewport({
        x: fx * canvasWidth,
        y: fy * canvasHeight,
        w: fw * canvasWidth,
        h: fh * canvasHeight,
      })
    }

    compute()
    scroller.addEventListener('scroll', compute, { passive: true })
    window.addEventListener('resize', compute)
    return () => {
      scroller.removeEventListener('scroll', compute)
      window.removeEventListener('resize', compute)
    }
  }, [scrollContainerRef, stackRef, zoom, canvasWidth, canvasHeight])

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!pos) return
    e.stopPropagation()
    e.preventDefault()
    // Capture on the grip element specifically so the pointer follows
    // the grip for the duration of the drag — even if the cursor
    // wanders off the grip's tiny footprint mid-drag, we still get
    // pointermove events here instead of losing them to whatever else
    // the cursor is over (a button, the canvas, the rail).
    gripRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    e.stopPropagation()
    const scroller = scrollContainerRef.current
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    const dx = e.clientX - dragRef.current.startMouseX
    const dy = e.clientY - dragRef.current.startMouseY
    const nextX = dragRef.current.startPosX + dx
    const nextY = dragRef.current.startPosY + dy
    // Clamp to the visible canvas area (scroller's bounding rect ==
    // canvas-frame's bounding rect since canvas-scroll fills the
    // frame). Position is now in canvas-frame coords (which match
    // viewport coords because the frame doesn't scroll).
    setPos({
      x: Math.max(0, Math.min(scrollerRect.width - MAP_W, nextX)),
      y: Math.max(0, Math.min(scrollerRect.height - OVERLAY_H, nextY)),
    })
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    e.stopPropagation()
    gripRef.current?.releasePointerCapture(e.pointerId)
    dragRef.current = null
  }

  // Viewport-rect drag handlers: when the user grabs the lime rect on
  // the minimap, scrolling the underlying canvas should track the
  // gesture. Only active when zoom > 1 (no scrollable area at zoom=1).
  function onPanPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const scroller = scrollContainerRef.current
    if (!scroller || zoom <= 1.0001) return
    e.stopPropagation()
    e.preventDefault()
    viewportRectRef.current?.setPointerCapture(e.pointerId)
    panDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startScrollX: scroller.scrollLeft,
      startScrollY: scroller.scrollTop,
    }
  }

  function onPanPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!panDragRef.current) return
    e.stopPropagation()
    const scroller = scrollContainerRef.current
    const stack = stackRef.current
    if (!scroller || !stack) return
    const stackRect = stack.getBoundingClientRect()
    const dmmX = e.clientX - panDragRef.current.startMouseX
    const dmmY = e.clientY - panDragRef.current.startMouseY
    // minimap-px delta → scroll-px delta. The visible viewport rect on
    // the minimap is at scale (MAP_W / stackRect.width) of the actual
    // canvas-stack, so moving the rect by dmm px should move the scroll
    // position by dmm × (stackRect.width / MAP_W) px.
    const dscrollX = dmmX * (stackRect.width / MAP_W)
    const dscrollY = dmmY * (stackRect.height / MAP_H)
    scroller.scrollLeft = panDragRef.current.startScrollX + dscrollX
    scroller.scrollTop = panDragRef.current.startScrollY + dscrollY
  }

  function onPanPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!panDragRef.current) return
    e.stopPropagation()
    viewportRectRef.current?.releasePointerCapture(e.pointerId)
    panDragRef.current = null
  }

  if (!pos) return null

  // Viewport rect in minimap px coords (the underlying Minimap canvas
  // is MAP_W × MAP_H; convert canvas-pixel coords → minimap-pixel
  // coords by scaling by MAP_W / canvasWidth and MAP_H / canvasHeight).
  const vpStyle = viewport
    ? {
        left: (viewport.x / canvasWidth) * MAP_W,
        top: (viewport.y / canvasHeight) * MAP_H,
        width: (viewport.w / canvasWidth) * MAP_W,
        height: (viewport.h / canvasHeight) * MAP_H,
      }
    : null

  // Event handler used by every overlay control button. Stops
  // propagation so a button click never bleeds through to:
  //   - the drag handlers above (which would treat a button click as
  //     an aborted drag-start)
  //   - the canvas underneath (paint-click at the wrong coordinate)
  function buttonClick<T>(fn?: () => T) {
    return (e: React.MouseEvent | React.PointerEvent) => {
      e.stopPropagation()
      fn?.()
    }
  }

  return (
    <div
      ref={overlayRef}
      className="minimap-overlay"
      style={{
        left: pos.x,
        top: pos.y,
        width: MAP_W,
        height: OVERLAY_H,
      }}
      // Block click-through to the canvas underneath so a click on a
      // minimap button doesn't also paint-click the pixel below.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="region"
      aria-label="Canvas overview minimap"
    >
      {/* Tiny dedicated drag handle (operator preference 2026-05-25:
          "move the drag mechanic to just a small drag area within the
          minimap"). The grip is the ONLY element that initiates a
          whole-overlay drag — clicks anywhere else (minimap canvas,
          viewport rect, control buttons) behave as their own
          affordance without accidentally moving the overlay. */}
      <div
        ref={gripRef}
        className="minimap-overlay-grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to move the minimap"
        aria-label="Minimap drag handle"
      >
        <span aria-hidden>⋮⋮</span>
      </div>
      <div className="minimap-overlay-map">
        <Minimap
          regions={regions}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          draft={draft ?? null}
        />
        {vpStyle && (
          <div
            ref={viewportRectRef}
            className="minimap-overlay-viewport"
            style={vpStyle}
            onPointerDown={onPanPointerDown}
            onPointerMove={onPanPointerMove}
            onPointerUp={onPanPointerUp}
            onPointerCancel={onPanPointerUp}
            title="Drag to pan the canvas"
          />
        )}
      </div>
      {/* Compact zoom + fit + refresh control strip. Replaces the
          rail's old MAP zone — keeps all canvas-view controls on the
          minimap widget where they conceptually belong. */}
      <div className="minimap-overlay-ctrls" role="toolbar" aria-label="Canvas zoom">
        <button
          type="button"
          className="minimap-overlay-btn"
          onClick={buttonClick(onZoomOut)}
          disabled={!onZoomOut || zoom <= 1}
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
          onClick={buttonClick(onZoomIn)}
          disabled={!onZoomIn || zoom >= 8}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="minimap-overlay-btn minimap-overlay-fit"
          onClick={buttonClick(onZoomReset)}
          disabled={!onZoomReset || zoom === 1}
          title="Reset zoom to fit"
        >
          Fit
        </button>
        {onRefresh && (
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
        )}
      </div>
    </div>
  )
}
