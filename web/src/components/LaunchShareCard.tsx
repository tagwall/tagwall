import { useCallback, useEffect, useRef, useState } from 'react'

import { chainColorTokens } from '../lib/chainColor'

/** 16:9 at 1200×675, matching FounderShareCard so the brand reads as one set. */
const CARD_W = 1200
const CARD_H = 675

const BG = '#07070b'
const GENESIS_GOLD = '#ffd66b'
const LIME = '#A8FF2E'
const TEXT_DIM = '#9aa0b4'

const FAM =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/**
 * Right-side motif. Defaults to the 100-slot Genesis grid (launch
 * graphics). Per-paint queue graphics use `region` to plot where on the
 * 1250×800 wall the paint landed; `none` leaves the space empty.
 */
export type LaunchMotif =
  | { kind: 'genesis' }
  | { kind: 'region'; x: number; y: number; w: number; h: number }
  | { kind: 'none' }

export interface LaunchGraphic {
  /** Chain id for the accent + top-right tag. Omit for a multi-chain gold announcement. */
  chainId?: number
  chainName?: string
  eyebrow: string
  hero: string
  heroSub: string
  subline: string
  /** Slug for the download filename. */
  slug: string
  /** Footer line. Defaults to the founders pitch. */
  footer?: string
  /** Right-side motif. Defaults to the Genesis grid. */
  motif?: LaunchMotif
}

/** Wall dimensions, mirrored from the deployed Canvas (1,000,000 px). */
const WALL_W = 1250
const WALL_H = 800

interface Props {
  graphic: LaunchGraphic
}

/**
 * A branded launch/announcement graphic rendered to a 1200×675 canvas and
 * offered as a PNG download. Same visual language as the founder share
 * card (accent rail, lime wordmark, 10×10 Genesis-slot grid motif) but
 * parameterised so each launch tweet gets its own matching image. The
 * operator attaches the PNG when posting, since X can't auto-attach via
 * the compose URL.
 */
export function LaunchShareCard({ graphic }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [downloaded, setDownloaded] = useState(false)

  const accent = graphic.chainId ? chainColorTokens(graphic.chainId).hex : GENESIS_GOLD

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    el.width = CARD_W
    el.height = CARD_H
    const ctx = el.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = BG
    ctx.fillRect(0, 0, CARD_W, CARD_H)

    // Accent rail + hairline frame.
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, 12, CARD_H)
    ctx.strokeStyle = '#1c1c28'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, CARD_W - 2, CARD_H - 2)

    const padX = 72

    // Wordmark (top-left) + optional chain tag (top-right).
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = LIME
    ctx.font = `700 34px ${FAM}`
    ctx.fillText('tagwall.io', padX, 86)

    if (graphic.chainName) {
      ctx.textAlign = 'right'
      ctx.fillStyle = accent
      ctx.font = `600 26px ${FAM}`
      const label = graphic.chainName.toUpperCase()
      ctx.fillText(label, CARD_W - padX, 84)
      const chainW = ctx.measureText(label).width
      ctx.beginPath()
      ctx.arc(CARD_W - padX - chainW - 22, 76, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.textAlign = 'left'
    }

    // Eyebrow.
    ctx.fillStyle = accent
    ctx.font = `700 38px ${FAM}`
    ctx.fillText(graphic.eyebrow.toUpperCase(), padX, 250)

    // Hero (the big number / cost).
    ctx.fillStyle = '#ffffff'
    ctx.font = `800 168px ${FAM}`
    ctx.fillText(graphic.hero, padX - 4, 420)

    // Hero sub.
    ctx.fillStyle = TEXT_DIM
    ctx.font = `500 30px ${FAM}`
    ctx.fillText(graphic.heroSub, padX, 472)

    // Subline (accent).
    ctx.fillStyle = accent
    ctx.font = `600 30px ${FAM}`
    ctx.fillText(graphic.subline, padX, 566)

    // Footer.
    ctx.fillStyle = TEXT_DIM
    ctx.font = `500 24px ${FAM}`
    ctx.fillText(
      graphic.footer ?? 'Paint one pixel · about 5¢ · tagwall.io/founders',
      padX,
      618,
    )

    const motif = graphic.motif ?? { kind: 'genesis' }
    if (motif.kind === 'genesis') {
      // 10×10 Genesis-slot grid motif (right). 100 cells = the 100 Genesis
      // slots. A handful are filled to read as "claimed, most still open";
      // it's a stylised motif, not a live count.
      const cell = 26
      const gap = 4
      const cols = 10
      const gridSize = cols * cell + (cols - 1) * gap
      const gx = CARD_W - padX - gridSize
      const gy = (CARD_H - gridSize) / 2 + 20
      for (let i = 0; i < 100; i++) {
        const cx = gx + (i % cols) * (cell + gap)
        const cy = gy + Math.floor(i / cols) * (cell + gap)
        if (i < 7) {
          ctx.fillStyle = accent
          ctx.fillRect(cx, cy, cell, cell)
        } else {
          ctx.fillStyle = '#13131d'
          ctx.fillRect(cx, cy, cell, cell)
          ctx.strokeStyle = `${accent}33`
          ctx.lineWidth = 1
          ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1)
        }
      }
      ctx.fillStyle = TEXT_DIM
      ctx.font = `500 22px ${FAM}`
      ctx.textAlign = 'center'
      ctx.fillText('100 Genesis slots', gx + gridSize / 2, gy + gridSize + 40)
      ctx.textAlign = 'left'
    } else if (motif.kind === 'region') {
      // Mini wall (1250×800 aspect) with the painted region plotted, so a
      // per-paint flex shows *where* on the canvas it landed.
      const boxW = 300
      const boxH = Math.round((boxW * WALL_H) / WALL_W)
      const bx = CARD_W - padX - boxW
      const by = (CARD_H - boxH) / 2 + 20
      ctx.fillStyle = '#13131d'
      ctx.fillRect(bx, by, boxW, boxH)
      ctx.strokeStyle = `${accent}33`
      ctx.lineWidth = 1
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1)

      const sx = boxW / WALL_W
      const sy = boxH / WALL_H
      const rw = Math.max(motif.w * sx, 4)
      const rh = Math.max(motif.h * sy, 4)
      const rx = bx + Math.min(motif.x * sx, boxW - rw)
      const ry = by + Math.min(motif.y * sy, boxH - rh)
      ctx.fillStyle = accent
      ctx.fillRect(rx, ry, rw, rh)

      ctx.fillStyle = TEXT_DIM
      ctx.font = `500 22px ${FAM}`
      ctx.textAlign = 'center'
      ctx.fillText(`at ${motif.x}, ${motif.y} on the wall`, bx + boxW / 2, by + boxH + 40)
      ctx.textAlign = 'left'
    }

    setDownloaded(false)
  }, [graphic, accent])

  const download = useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    el.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tagwall-launch-${graphic.slug}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setDownloaded(true)
    }, 'image/png')
  }, [graphic.slug])

  return (
    <div className="launch-graphic">
      <canvas
        ref={canvasRef}
        className="launch-graphic-canvas"
        aria-label={`${graphic.eyebrow} launch graphic`}
      />
      <button type="button" className="share-btn share-btn-secondary" onClick={download}>
        {downloaded ? 'Image saved ✓' : 'Download image'}
      </button>
    </div>
  )
}
