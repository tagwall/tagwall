import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatEther, isAddress, getAddress } from 'viem'

import { useCanvasHeader } from '../hooks/useCanvasHeader'
import { useLivePaintedRefresh } from '../hooks/useLivePaintedRefresh'
import { usePaintedRegions } from '../hooks/usePaintedRegions'
import { tilesForRect, useTilePixels } from '../hooks/useTilePixels'
import { colorToHex } from '../lib/format'

/**
 * Mirror-friendly embed view, designed to be iframed by partners.
 *
 * Query params:
 *   x, y, w, h   the region to focus on. If absent/invalid, the embed
 *                shows the whole canvas.
 *   ref          painter address that'll be filled into any paint
 *                initiated from this embed. See PRD §6: "`ref`
 *                parameter auto-propagates as referrer to any paints
 *                initiated from the embed." The propagation itself
 *                happens via a deep link to /?ref=<addr>&x&y&w&h so
 *                the embed's Paint button opens the full app with
 *                the right referrer; the embed itself is read-only.
 *
 * No connect bar, no activity feed, no pixel panel. The whole point is
 * a minimal rectangle that a mirror site can drop into their page.
 */
export default function EmbedPage() {
  useLivePaintedRefresh()
  const [params] = useSearchParams()

  const ref = useMemo(() => {
    const v = params.get('ref')
    if (!v || !isAddress(v)) return null
    return getAddress(v)
  }, [params])

  const { data: header } = useCanvasHeader()
  const canvasWidth =
    header && header[0]?.status === 'success' ? (header[0].result as number) : 1250
  const canvasHeight =
    header && header[1]?.status === 'success' ? (header[1].result as number) : 800
  const startingPrice =
    header && header[2]?.status === 'success' ? (header[2].result as bigint) : null

  // Region from query params, clamped to canvas dimensions. An iframe
  // embed is on the open web, so a hostile referrer can pass any
  // ?w=999999 or ?x=-1 they like; without a clamp the canvas element
  // allocates at the requested size and the host browser tab can OOM.
  const region = useMemo(() => {
    const x = Number(params.get('x'))
    const y = Number(params.get('y'))
    const w = Number(params.get('w'))
    const h = Number(params.get('h'))
    if (
      !Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(w) || !Number.isFinite(h) ||
      !Number.isInteger(x) || !Number.isInteger(y) ||
      !Number.isInteger(w) || !Number.isInteger(h) ||
      x < 0 || y < 0 || w <= 0 || h <= 0 ||
      x >= canvasWidth || y >= canvasHeight ||
      x + w > canvasWidth || y + h > canvasHeight
    ) {
      return null
    }
    return { x, y, w, h }
  }, [params, canvasWidth, canvasHeight])

  const { data: regions } = usePaintedRegions()

  // Fetch only the tiles that intersect the embed's region (or the full
  // canvas if no region was supplied). Embeds are typically small crops,
  // so this trims the fetch considerably versus loading the whole canvas.
  const embedRect = region ?? { x: 0, y: 0, w: canvasWidth, h: canvasHeight }
  const visibleTiles = useMemo(
    () => tilesForRect(embedRect.x, embedRect.y, embedRect.w, embedRect.h, canvasWidth, canvasHeight),
    [embedRect.x, embedRect.y, embedRect.w, embedRect.h, canvasWidth, canvasHeight],
  )
  const tilePixels = useTilePixels(visibleTiles, regions, canvasWidth, canvasHeight)

  const baseRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLCanvasElement>(null)

  // Draw the embed region's painted state onto a hidden full-resolution
  // canvas, then crop to the requested region (if any) onto the visible
  // one. Rendering everything first lets us reuse the same buffer for
  // re-cropping if the query params change without a reload.
  useEffect(() => {
    const base = baseRef.current
    if (!base) return
    base.width = canvasWidth
    base.height = canvasHeight
    const ctx = base.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    for (const entry of tilePixels.values()) {
      const tile = entry.data
      if (!tile) continue
      const buf = tile.colors
      for (let i = 0; i < buf.length; i++) {
        const encoded = buf[i]
        if (encoded === 0) continue
        const lx = i % tile.w
        const ly = Math.floor(i / tile.w)
        ctx.fillStyle = colorToHex(encoded & 0xffffff)
        ctx.fillRect(tile.x + lx, tile.y + ly, 1, 1)
      }
    }
  }, [canvasWidth, canvasHeight, tilePixels])

  // Crop into the viewport canvas. If no region given, show the full thing.
  useEffect(() => {
    const base = baseRef.current
    const view = viewportRef.current
    if (!base || !view) return
    const ctx = view.getContext('2d')
    if (!ctx) return
    const r = region ?? { x: 0, y: 0, w: canvasWidth, h: canvasHeight }
    view.width = r.w
    view.height = r.h
    ctx.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    // Thin outline around the region so it's framed inside the iframe.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, r.w - 1, r.h - 1)
  }, [region, canvasWidth, canvasHeight, tilePixels])

  const paintHref = useMemo(() => {
    const q = new URLSearchParams()
    if (ref) q.set('ref', ref)
    if (region) {
      q.set('x', String(region.x))
      q.set('y', String(region.y))
      q.set('w', String(region.w))
      q.set('h', String(region.h))
    }
    const qs = q.toString()
    return qs ? `/?${qs}` : '/'
  }, [ref, region])

  const regionLabel = region
    ? `(${region.x}, ${region.y}) ${region.w}×${region.h}`
    : `full canvas ${canvasWidth}×${canvasHeight}`

  return (
    <div className="embed">
      <canvas ref={baseRef} style={{ display: 'none' }} aria-hidden />
      <canvas ref={viewportRef} className="embed-canvas" aria-label={`Tagwall region ${regionLabel}`} />
      <footer className="embed-footer">
        <span className="embed-region">{regionLabel}</span>
        {startingPrice !== null && (
          <span className="embed-price">floor {formatEther(startingPrice)} native</span>
        )}
        <a
          className="embed-paint"
          href={paintHref}
          target="_top"
          rel="noopener"
          title={ref ? `Paint (referral: ${ref})` : 'Paint this region on Tagwall'}
        >
          Paint on Tagwall ↗
        </a>
        <Link to="/" target="_top" className="embed-brand">Tagwall</Link>
      </footer>
    </div>
  )
}
