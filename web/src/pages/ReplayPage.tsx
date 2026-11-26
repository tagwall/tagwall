import { useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ReplayIntro } from '../components/ReplayIntro'
import { useBlockTimestamps } from '../hooks/useBlockTimestamps'
import { useCanvasHeader } from '../hooks/useCanvasHeader'
import { usePaintedRegions, type PaintedRegion } from '../hooks/usePaintedRegions'
import { shortenAddress } from '../lib/format'
import { chainSlug, useViewerChainId } from '../lib/viewerChain'

/**
 * /replay: plays the wall's history back one paint at a time, for the whole
 * wall or a chosen area, and keeps the view in the URL so it can be shared:
 *
 *   /replay?chain=pulse&area=x,y,w,h&from=<unix s>&to=<unix s>
 *
 * Data is the same filtered region list the main wall renders
 * (usePaintedRegions: the Worker's KV snapshot plus a short forward scan,
 * with the sanctions and signed filter lists applied), so nothing here scans
 * history per page view, and the replay hides exactly what the wall hides.
 * Colours come from the snapshot, which decodes them from each paint's own
 * calldata. The last few minutes of paints (found by the forward scan, not
 * yet in the snapshot) have no colours yet and join after the next cron run.
 */

const DEFAULT_W = 1_250
const DEFAULT_H = 800
/** Unpainted pixels: same backdrop as the minimap. */
const EMPTY_R = 0x0b
const EMPTY_G = 0x0b
const EMPTY_B = 0x10
/** Canvas.sol's TRANSPARENT sentinel: the painter skipped this pixel. */
const TRANSPARENT = 0xffffffff
/** Paints per second. */
const SPEEDS = [1, 2, 5, 10] as const

interface Area {
  x: number
  y: number
  w: number
  h: number
}

interface Paint {
  region: PaintedRegion
  pixels: Uint32Array
  /** Unix seconds, or null while the block's timestamp is unknown. */
  ts: number | null
}

function parseArea(raw: string | null, wallW: number, wallH: number): Area | null {
  if (!raw) return null
  const parts = raw.split(',').map((n) => Number.parseInt(n, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const x = Math.min(Math.max(parts[0], 0), wallW - 1)
  const y = Math.min(Math.max(parts[1], 0), wallH - 1)
  const w = Math.min(Math.max(parts[2], 1), wallW - x)
  const h = Math.min(Math.max(parts[3], 1), wallH - y)
  return { x, y, w, h }
}

function parseTs(raw: string | null): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function intersects(r: PaintedRegion, a: Area): boolean {
  return r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y
}

/** Unix seconds -> YYYY-MM-DD in UTC, for <input type="date">. */
function toDateInput(ts: number | null): string {
  return ts === null ? '' : new Date(ts * 1000).toISOString().slice(0, 10)
}

/** YYYY-MM-DD (UTC) -> unix seconds at the start, or end, of that day. */
function fromDateInput(value: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function formatDate(ts: number | null): string {
  if (ts === null) return 'date pending'
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Paints `paint` into `img`, which covers `view` of the wall. */
function applyPaint(img: ImageData, view: Area, paint: Paint) {
  const { x, y, w, h } = paint.region
  const x0 = Math.max(x, view.x)
  const y0 = Math.max(y, view.y)
  const x1 = Math.min(x + w, view.x + view.w)
  const y1 = Math.min(y + h, view.y + view.h)
  const data = img.data
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const c = paint.pixels[(py - y) * w + (px - x)]
      if (c === undefined || c === TRANSPARENT) continue
      const o = ((py - view.y) * view.w + (px - view.x)) * 4
      data[o] = (c >> 16) & 0xff
      data[o + 1] = (c >> 8) & 0xff
      data[o + 2] = c & 0xff
      data[o + 3] = 0xff
    }
  }
}

export default function ReplayPage() {
  const chainId = useViewerChainId()
  const header = useCanvasHeader(chainId)
  const wallW = Number((header.data?.[0]?.result as bigint | undefined) ?? DEFAULT_W)
  const wallH = Number((header.data?.[1]?.result as bigint | undefined) ?? DEFAULT_H)

  const { data: regions, isPending } = usePaintedRegions()
  const timestamps = useBlockTimestamps(regions)
  const [params, setParams] = useSearchParams()

  const area = parseArea(params.get('area'), wallW, wallH)
  const from = parseTs(params.get('from'))
  const to = parseTs(params.get('to'))
  const view: Area = area ?? { x: 0, y: 0, w: wallW, h: wallH }

  // Every paint that has colours, in chain order.
  const { paints, colourless } = useMemo(() => {
    const out: Paint[] = []
    let missing = 0
    for (const region of regions ?? []) {
      if (!(region.pixels instanceof Uint32Array)) {
        missing += 1
        continue
      }
      out.push({
        region,
        pixels: region.pixels,
        ts: region.blockTimestamp ?? timestamps.get(region.blockNumber) ?? null,
      })
    }
    out.sort((a, b) =>
      a.region.blockNumber === b.region.blockNumber
        ? a.region.logIndex - b.region.logIndex
        : a.region.blockNumber < b.region.blockNumber
          ? -1
          : 1,
    )
    return { paints: out, colourless: missing }
  }, [regions, timestamps])

  // Paints before `from` are the starting picture; the ones inside the range
  // are the frames; anything after `to` is left out.
  const viewKey = `${view.x},${view.y},${view.w},${view.h}`
  const { base, frames } = useMemo(() => {
    const base: Paint[] = []
    const frames: Paint[] = []
    for (const p of paints) {
      if (!intersects(p.region, view)) continue
      if (from !== null && p.ts !== null && p.ts < from) base.push(p)
      else if (to !== null && p.ts !== null && p.ts > to) continue
      else frames.push(p)
    }
    return { base, frames }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewKey stands in for `view`
  }, [paints, viewKey, from, to])

  // Playhead: how many frames are on the wall. Starts at the end so a shared
  // link opens on the finished picture for its range.
  const [shown, setShown] = useState<number | null>(null)
  const count = shown === null ? frames.length : Math.min(shown, frames.length)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2)

  // A new chain, view or range starts over at the finished picture. Reset
  // while rendering (React's "adjust state on prop change" pattern) rather
  // than in an effect, so the stale playhead never paints.
  const resetKey = `${chainId}|${viewKey}|${from}|${to}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setShown(null)
    setPlaying(false)
  }

  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setShown((s) => {
        const next = (s ?? 0) + 1
        if (next >= frames.length) {
          setPlaying(false)
          return frames.length
        }
        return next
      })
    }, 1000 / speed)
    return () => window.clearInterval(id)
  }, [playing, speed, frames.length])

  // Draw the wall as of `count` frames.
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    el.width = view.w
    el.height = view.h
    const ctx = el.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(view.w, view.h)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      d[i] = EMPTY_R
      d[i + 1] = EMPTY_G
      d[i + 2] = EMPTY_B
      d[i + 3] = 0xff
    }
    for (const p of base) applyPaint(img, view, p)
    for (let i = 0; i < count; i++) applyPaint(img, view, frames[i])
    ctx.putImageData(img, 0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewKey stands in for `view`
  }, [base, frames, count, viewKey])

  const current = count > 0 ? frames[count - 1] : null

  // The prerendered replay.html carries this title for direct loads; set it
  // here too for in-app navigation, and restore the previous one on leave.
  useEffect(() => {
    const previous = document.title
    document.title = 'wall replay · tagwall'
    return () => {
      document.title = previous
    }
  }, [])

  // Drag-to-select an area, in wall coordinates.
  const [selecting, setSelecting] = useState(false)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const toWall = (e: React.PointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const fx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    const fy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    return {
      x: Math.min(view.x + Math.floor(fx * view.w), view.x + view.w - 1),
      y: Math.min(view.y + Math.floor(fy * view.h), view.y + view.h - 1),
    }
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (!selecting) return
    const p = toWall(e)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = toWall(e)
    if (p) setDrag({ ...drag, x1: p.x, y1: p.y })
  }
  const onPointerUp = () => {
    if (!drag) return
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const w = Math.abs(drag.x1 - drag.x0) + 1
    const h = Math.abs(drag.y1 - drag.y0) + 1
    setDrag(null)
    setSelecting(false)
    if (w < 2 || h < 2) return // a click, not a drag
    updateParams({ area: `${x},${y},${w},${h}` })
  }

  const updateParams = (patch: Record<string, string | null>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace: true },
    )
  }

  // Share link: always names the chain, even when it came from the wallet.
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    const url = new URL(window.location.href)
    const slug = chainSlug(chainId)
    if (slug) url.searchParams.set('chain', slug)
    try {
      await navigator.clipboard.writeText(url.toString())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link', url.toString())
    }
  }

  const pct = (n: number, of: number) => `${(n / of) * 100}%`
  const outline =
    current && intersects(current.region, view)
      ? {
          left: pct(Math.max(current.region.x, view.x) - view.x, view.w),
          top: pct(Math.max(current.region.y, view.y) - view.y, view.h),
          width: pct(
            Math.min(current.region.x + current.region.w, view.x + view.w) -
              Math.max(current.region.x, view.x),
            view.w,
          ),
          height: pct(
            Math.min(current.region.y + current.region.h, view.y + view.h) -
              Math.max(current.region.y, view.y),
            view.h,
          ),
        }
      : null
  const dragBox = drag
    ? {
        left: pct(Math.min(drag.x0, drag.x1) - view.x, view.w),
        top: pct(Math.min(drag.y0, drag.y1) - view.y, view.h),
        width: pct(Math.abs(drag.x1 - drag.x0) + 1, view.w),
        height: pct(Math.abs(drag.y1 - drag.y0) + 1, view.h),
      }
    : null

  const play = () => {
    if (count >= frames.length) setShown(0)
    setPlaying(true)
  }

  return (
    <div className="shell-measure replay-page">
      <ReplayIntro />

      <div className="replay-toolbar" role="group" aria-label="Replay controls">
        {playing ? (
          <button type="button" className="wallet-btn" onClick={() => setPlaying(false)}>
            Pause
          </button>
        ) : (
          <button
            type="button"
            className="wallet-btn"
            onClick={play}
            disabled={frames.length === 0}
          >
            {count >= frames.length && frames.length > 0 ? 'Replay' : 'Play'}
          </button>
        )}
        <button
          type="button"
          className="replay-step"
          aria-label="Previous paint"
          onClick={() => {
            setPlaying(false)
            setShown(Math.max(count - 1, 0))
          }}
          disabled={count === 0}
        >
          ◀
        </button>
        <button
          type="button"
          className="replay-step"
          aria-label="Next paint"
          onClick={() => {
            setPlaying(false)
            setShown(Math.min(count + 1, frames.length))
          }}
          disabled={count >= frames.length}
        >
          ▶
        </button>
        <input
          className="replay-scrub"
          type="range"
          min={0}
          max={frames.length}
          value={count}
          onChange={(e) => {
            setPlaying(false)
            setShown(Number(e.target.value))
          }}
          aria-label="Paints shown"
          disabled={frames.length === 0}
        />
        <label className="replay-speed">
          <span>Speed</span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s} / s
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="replay-status" aria-live="polite">
        {isPending && frames.length === 0
          ? 'Loading the wall’s history…'
          : frames.length === 0
            ? 'No paints in this area and date range.'
            : current
              ? `Paint ${count} of ${frames.length} · ${formatDate(current.ts)} · ${shortenAddress(current.region.painter)} · ${current.region.pixelsPainted.toLocaleString()} px`
              : `${frames.length} paint${frames.length === 1 ? '' : 's'} to replay`}
      </p>

      <div
        className={`replay-stage${selecting ? ' is-selecting' : ''}`}
        ref={stageRef}
        // Fit the width, but never taller than 72vh: capping the width (not
        // the height) keeps the pixels square at any area shape.
        style={{
          aspectRatio: `${view.w} / ${view.h}`,
          width: `min(100%, calc(72vh * ${view.w / view.h}))`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <canvas ref={canvasRef} className="replay-canvas" aria-label="Wall replay" />
        {outline && <div className="replay-outline" style={outline} aria-hidden />}
        {dragBox && <div className="replay-drag" style={dragBox} aria-hidden />}
      </div>

      <div className="replay-options">
        <div className="replay-area">
          <span className="replay-label">Area</span>
          <span className="replay-value">
            {area ? `${area.w}×${area.h} at (${area.x}, ${area.y})` : `whole wall, ${wallW}×${wallH}`}
          </span>
          <button
            type="button"
            className={`replay-link-btn${selecting ? ' is-active' : ''}`}
            onClick={() => setSelecting((s) => !s)}
          >
            {selecting ? 'Drag across the wall…' : 'Select an area'}
          </button>
          {area && (
            <button
              type="button"
              className="replay-link-btn"
              onClick={() => updateParams({ area: null })}
            >
              Whole wall
            </button>
          )}
        </div>
        <div className="replay-range">
          <label>
            <span className="replay-label">From</span>
            <input
              type="date"
              value={toDateInput(from)}
              onChange={(e) =>
                updateParams({ from: fromDateInput(e.target.value, false)?.toString() ?? null })
              }
            />
          </label>
          <label>
            <span className="replay-label">To</span>
            <input
              type="date"
              value={toDateInput(to)}
              onChange={(e) =>
                updateParams({ to: fromDateInput(e.target.value, true)?.toString() ?? null })
              }
            />
          </label>
          <span className="replay-hint">dates in UTC</span>
        </div>
        <div className="replay-share">
          <button type="button" className="wallet-btn" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link to this view'}
          </button>
          <Link to="/" className="replay-link-btn">
            Back to the wall
          </Link>
        </div>
      </div>

      {colourless > 0 && (
        <p className="replay-hint">
          {colourless} paint{colourless === 1 ? '' : 's'} from the last few minutes will join the
          replay after the next snapshot, within about five minutes.
        </p>
      )}
    </div>
  )
}
