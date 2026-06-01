import { useCallback, useEffect, useRef, useState } from 'react'

import type { PixelState } from '../hooks/useTilePixels'
import type { FounderEntry, FounderStats } from '../lib/founders'
import { GENESIS_CAP, FOUNDER_CAP, tierLabel } from '../lib/founders'

/** Fixed export resolution. 16:9 reads cleanly as an in-stream image on X. */
const CARD_W = 1200
const CARD_H = 675

const BG = '#07070b'
const PANEL = '#0e0e16'
const GENESIS_GOLD = '#ffd66b'
const LIME = '#A8FF2E'
const TEXT_DIM = '#9aa0b4'

function shorten(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function colorToHex(c: number): string {
  if ((c & 0xff000000) !== 0) return BG
  return `#${c.toString(16).padStart(6, '0')}`
}

/**
 * Draw the painter's actual tag into a square box, nearest-neighbour
 * scaled and centred, so a 1×1 genesis dot and a 50×50 logo both read.
 */
function drawTag(
  ctx: CanvasRenderingContext2D,
  entry: FounderEntry,
  pixels: readonly PixelState[] | undefined,
  box: { x: number; y: number; size: number },
) {
  const { w, h } = entry.region
  const scale = Math.max(1, Math.floor(box.size / Math.max(w, h)))
  const drawW = w * scale
  const drawH = h * scale
  const ox = box.x + (box.size - drawW) / 2
  const oy = box.y + (box.size - drawH) / 2

  ctx.fillStyle = BG
  ctx.fillRect(ox, oy, drawW, drawH)
  if (pixels) {
    for (const p of pixels) {
      ctx.fillStyle = colorToHex(p.color)
      ctx.fillRect(ox + (p.x - entry.region.x) * scale, oy + (p.y - entry.region.y) * scale, scale, scale)
    }
  }
}

interface Props {
  entry: FounderEntry
  stats: FounderStats
  chainName: string
  accent: string
  pixels: readonly PixelState[] | undefined
}

/**
 * The shareable founder card. Renders the viewer's claimed slot to an
 * offscreen-resolution canvas (1200×675) with the number front and
 * centre, their real tag, and the live scarcity line, then offers a PNG
 * download + an X compose prefill. This is the artefact a founder posts:
 * claiming a number should produce something worth sharing.
 */
export function FounderShareCard({ entry, stats, chainName, accent, pixels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [downloaded, setDownloaded] = useState(false)

  const tier = entry.tier
  const tierColor = tier === 'genesis' ? GENESIS_GOLD : accent
  const cap = tier === 'genesis' ? GENESIS_CAP : FOUNDER_CAP
  const left = tier === 'genesis' ? stats.genesisLeft : stats.totalLeft
  const scarcity =
    left > 0
      ? `${left.toLocaleString('en-US')} ${tierLabel(tier)} spot${left === 1 ? '' : 's'} left on ${chainName}`
      : `${tierLabel(tier)} window full on ${chainName}`

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    el.width = CARD_W
    el.height = CARD_H
    const ctx = el.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = BG
    ctx.fillRect(0, 0, CARD_W, CARD_H)

    // Accent rail down the left edge.
    ctx.fillStyle = tierColor
    ctx.fillRect(0, 0, 12, CARD_H)

    // Hairline frame.
    ctx.strokeStyle = '#1c1c28'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, CARD_W - 2, CARD_H - 2)

    const padX = 72
    const fam =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

    // Wordmark + chain tag (top row).
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = LIME
    ctx.font = `700 34px ${fam}`
    ctx.fillText('tagwall.io', padX, 86)

    ctx.textAlign = 'right'
    ctx.fillStyle = accent
    ctx.font = `600 26px ${fam}`
    ctx.fillText(chainName.toUpperCase(), CARD_W - padX, 84)
    ctx.beginPath()
    const chainW = ctx.measureText(chainName.toUpperCase()).width
    ctx.arc(CARD_W - padX - chainW - 22, 76, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.textAlign = 'left'

    // Tier eyebrow.
    ctx.fillStyle = tierColor
    ctx.font = `700 40px ${fam}`
    ctx.fillText(tierLabel(tier).toUpperCase(), padX, 250)

    // The number: the hero element.
    ctx.fillStyle = '#ffffff'
    ctx.font = `800 180px ${fam}`
    ctx.fillText(`#${entry.rank}`, padX - 6, 410)

    // Sub: "of N <tier>".
    ctx.fillStyle = TEXT_DIM
    ctx.font = `500 30px ${fam}`
    ctx.fillText(`of ${cap.toLocaleString('en-US')} ${tierLabel(tier)} slots`, padX, 460)

    // Scarcity line.
    ctx.fillStyle = tierColor
    ctx.font = `600 30px ${fam}`
    ctx.fillText(scarcity, padX, 560)

    // Footer: painter + permanence note.
    ctx.fillStyle = TEXT_DIM
    ctx.font = `500 24px ${fam}`
    ctx.fillText(`${shorten(entry.painter)}  ·  first painters, recorded on-chain forever`, padX, 614)

    // Tag panel (right).
    const panel = { x: CARD_W - 360, y: 168, size: 300 }
    ctx.fillStyle = PANEL
    ctx.fillRect(panel.x - 16, panel.y - 16, panel.size + 32, panel.size + 32)
    ctx.strokeStyle = '#23232f'
    ctx.lineWidth = 2
    ctx.strokeRect(panel.x - 16, panel.y - 16, panel.size + 32, panel.size + 32)
    ctx.imageSmoothingEnabled = false
    drawTag(ctx, entry, pixels, panel)

    // Coord caption under the tag.
    ctx.fillStyle = TEXT_DIM
    ctx.font = `500 22px ${fam}`
    ctx.textAlign = 'center'
    ctx.fillText(`(${entry.region.x}, ${entry.region.y})`, panel.x + panel.size / 2, panel.y + panel.size + 48)
    ctx.textAlign = 'left'

    setDownloaded(false)
  }, [entry, tier, tierColor, accent, chainName, scarcity, cap, pixels])

  const fileName = `tagwall-${tier}-${entry.rank}-${chainName.toLowerCase().replace(/\s+/g, '-')}.png`

  const download = useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    el.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setDownloaded(true)
    }, 'image/png')
  }, [fileName])

  // X can't attach an image via the intent URL, so the flow is: grab the
  // PNG first, then open compose with the text prefilled and a nudge to
  // attach. Download fires alongside so the image is already in hand.
  const tweet = useCallback(() => {
    download()
    const text =
      `I'm ${tierLabel(tier)} #${entry.rank} on @tagwall_paints (${chainName}).\n\n` +
      `The first ${FOUNDER_CAP.toLocaleString('en-US')} painters on each chain hold a numbered founder slot, ` +
      `read straight off the on-chain paint order. ${scarcity}.\n\n` +
      `Paint one pixel, claim yours: tagwall.io/founders`
    const href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [download, tier, entry.rank, chainName, scarcity])

  return (
    <section className="founder-card" aria-label="Your founder card">
      <div className="founder-card-canvas-wrap">
        <canvas ref={canvasRef} className="founder-card-canvas" aria-label={`${tierLabel(tier)} number ${entry.rank} share card`} />
      </div>
      <div className="founder-card-actions">
        <button type="button" className="founder-card-btn" onClick={tweet}>
          Tweet my card
        </button>
        <button type="button" className="founder-card-btn founder-card-btn-secondary" onClick={download}>
          {downloaded ? 'Saved ✓' : 'Download PNG'}
        </button>
        <p className="founder-card-hint">
          X can't auto-attach images. Downloading happens automatically, so drag the saved PNG into
          your tweet before posting.
        </p>
      </div>
    </section>
  )
}
