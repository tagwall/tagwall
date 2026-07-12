import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { formatEther, isAddress, getAddress } from 'viem'
import type { Address } from 'viem'
import { useAccount, useChains } from 'wagmi'

import { useViewerChainId } from '../lib/viewerChain'

import { ActivityFeed } from '../components/ActivityFeed'
import { Leaderboard } from '../components/Leaderboard'
import { CompetitionBanner } from '../components/CompetitionBanner'
import { LaunchBanner } from '../components/LaunchBanner'
import { LeaderboardTicker } from '../components/LeaderboardTicker'
import { ReferrersLeaderboard } from '../components/ReferrersLeaderboard'
import { MinimapOverlay } from '../components/MinimapOverlay'
import { StatsCards } from '../components/StatsCards'
import { OutboundLinkModal } from '../components/OutboundLinkModal'
import { FounderClaimPrompt } from '../components/FounderClaimPrompt'
import { PaintControls } from '../components/PaintControls'
import { useCanvasDeployed } from '../hooks/useCanvasDeployed'
import { useCanvasHeader } from '../hooks/useCanvasHeader'
import { useDebounced } from '../hooks/useDebounced'
import { usePaintDraft } from '../hooks/usePaintDraft'
import { usePaintedRegions } from '../hooks/usePaintedRegions'
import { useBlockTimestamps } from '../hooks/useBlockTimestamps'
import { usePaintSubmitBatch } from '../hooks/usePaintSubmitBatch'
import { usePixelInfo } from '../hooks/usePixelInfo'
import { useWindowDragUpload } from '../hooks/useWindowDragUpload'
import type { PixelInfo } from '../hooks/usePixelInfo'
import { useQuote } from '../hooks/useQuote'
import {
  tilesForRect,
  useTilePixels,
  type TileCoord,
} from '../hooks/useTilePixels'
import { chainPixelCap } from '../lib/chainCaps'
import { colorToHex } from '../lib/format'

const MAJOR_GRIDLINE_EVERY = 100
const MINOR_GRIDLINE_EVERY = 50
// Two-tier grid on the near-black canvas (#0b0b10): a light hairline every
// 50px, and an ever-so-slightly darker one every 100px so the lattice reads
// as even rather than the old sparse 100-only grid.
const MINOR_GRIDLINE_COLOR = '#1d1d26'
const MAJOR_GRIDLINE_COLOR = '#191921'
const HOVER_DEBOUNCE_MS = 200

/** Human-readable byte size for the drop-target overlay subline. Mirrors
 *  PaintControls' formatBytes so the two readouts agree. */
function formatDropBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const KB = 1024
  const MB = KB * 1024
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`
  return `${bytes} B`
}

/**
 * Floating tooltip that follows the cursor when hovering a pixel. Replaces
 * the old sticky sidebar panel; the wall IS the UI.
 *
 * Positioning: an absolute div inside the scroll wrapper, placed at (x, y)
 * in viewport coords via `left`/`top`. The container `position: relative`
 * pins it; we clamp against the wrapper rect so it doesn't fall off-edge.
 */
function PixelHoverTooltip({
  anchor,
  info,
  linkUrl,
  loading,
  startingPrice,
  nativeSymbol,
  onRequestOutbound,
}: {
  anchor: { clientX: number; clientY: number; x: number; y: number } | null
  info: PixelInfo | null
  linkUrl: string
  loading: boolean
  startingPrice: bigint | null
  nativeSymbol: string
  onRequestOutbound: (url: string) => void
}) {
  if (!anchor) return null

  // Offset so the tooltip sits to the bottom-right of the cursor and
  // doesn't occlude the pixel itself. On right-edge we flip to the left.
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
      {loading && !info && <p className="pixel-tooltip-placeholder">Reading chain…</p>}
      {info && (
        <>
          <div className="pixel-tooltip-row">
            <span
              className="pixel-tooltip-swatch"
              style={{
                background: info.isPainted ? colorToHex(info.color) : 'transparent',
                borderStyle: info.isPainted ? 'solid' : 'dashed',
              }}
            />
            <code className="pixel-tooltip-hex">
              {info.isPainted ? colorToHex(info.color) : 'unpainted'}
            </code>
            <code className="pixel-tooltip-price">
              {formatEther(info.replacePrice)} <span className="token">{nativeSymbol}</span>
            </code>
          </div>
          {info.isPainted && info.linkId > 0 && linkUrl && (
            <button
              type="button"
              className="pixel-tooltip-link"
              onClick={() => onRequestOutbound(linkUrl)}
              title="Opens a confirmation dialog before leaving Tagwall"
            >
              {linkUrl}
            </button>
          )}
          {!info.isPainted && startingPrice !== null && (
            <p className="pixel-tooltip-hint">
              Unpainted. First tag clears at {formatEther(startingPrice)} <span className="token">{nativeSymbol}</span>/pixel.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// Canvas.sol's on-chain per-transaction cap. Mirrored here as a literal
// (not a chain read) so the upload UI can reject oversized single-tx
// stamps before an RPC round-trip. Keep in sync with Canvas.sol.
//
// This is the contract's sanity ceiling, not the binding per-paint cap
// on every chain. Each connected chain may have a tighter per-tx gas
// cap (Ethereum and BSC enforce EIP-7825 / BEP-652 at 2^24 gas, which
// caps a single paint at ~552 pixels). The frontend chunks against the
// per-chain cap from `chainCaps.ts` — see `effectiveMaxPixels` below.
const MAX_PIXELS_PER_TX = 1_500

// Frontend-side maximum stamp side in pixels. Chosen so the largest stamp
// fits in one transaction on every chain: 38x38 = 1444 px <= 1500 px/tx
// contract cap. Anything larger would require chunking, which creates
// multi-signature UX that we'd rather avoid — painters who want more
// canvas coverage paint multiple deliberate stamps instead. Bumping this
// above 38 re-enables the chunked-submit path in usePaintSubmitBatch.
// Frontend cap on the longer side of a stamp. The on-chain per-tx
// pixel cap (`maxPixelsPerTx = 1500`) used to dictate a 38×38 ceiling,
// but chunked submit ships any stamp larger than that as a multi-tx
// batch (atomic via EIP-5792 when supported). 100 lets portraits and
// landscapes use the full range; the resulting chunk count is
// surfaced in the cost line so users see the tradeoff.
const MAX_STAMP_SIDE = 100

// Stable empty reference so useBlockTimestamps doesn't see a new array
// identity every render while regions are still loading.
const EMPTY_BLOCKS: bigint[] = []

function CanvasView({
  startingPrice,
  canvasWidth,
  canvasHeight,
  sharedReferrer,
  initialHover,
}: {
  startingPrice: bigint | null
  canvasWidth: number
  canvasHeight: number
  /** Referrer pre-filled from the URL (`?ref=0x...`) for embed + share-link flows. */
  sharedReferrer?: Address
  /** Deep-linked pixel (from `/pixel/x,y`), opens the info panel on mount. */
  initialHover?: { x: number; y: number } | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(initialHover ?? null)
  // Client-space cursor position for the hover tooltip. Tracked separately
  // from the canvas coord so the tooltip can position itself in viewport
  // px without needing canvas math on every render.
  const [cursorClient, setCursorClient] = useState<{ clientX: number; clientY: number } | null>(null)
  // CSS-based zoom. 1 = fit-to-container, higher = larger with pan via the
  // wrapping scroll area. Integers keep gridline rendering clean.
  const [zoom, setZoom] = useState(1)
  // Mobile bottom-sheet tab. Below ~720px viewport the paint / scores
  // / activity panels stack into a tabbed sheet under the canvas so
  // the canvas remains the hero above the fold. Above 720px the tabs
  // are hidden entirely and the desktop layout is restored.
  const [mobileTab, setMobileTab] = useState<'paint' | 'scores' | 'activity'>('paint')
  const canvasScrollRef = useRef<HTMLDivElement>(null)
  // Ref to the inner canvas-stack so the MinimapOverlay can measure
  // its container bounds (for clamping drag) and the visible-viewport
  // rect math.
  const canvasStackRef = useRef<HTMLDivElement>(null)

  // Sync with route changes: moving from /pixel/123,456 to /pixel/200,200
  // (or dropping the route) re-applies the deep-linked hover.
  useEffect(() => {
    if (initialHover) setHover(initialHover)
  }, [initialHover?.x, initialHover?.y])

  // Deep link (/pixel/x-y): zoom in and scroll so the linked tag is
  // centred in the viewport. Previously the route only set an off-screen
  // hover, so the link appeared to "do nothing". The timeout lets the
  // zoom re-render settle before we read the post-zoom stack size for the
  // scroll math.
  useEffect(() => {
    if (!initialHover) return
    setZoom((z) => (z < 3 ? 3 : z))
    const id = window.setTimeout(() => {
      const scroller = canvasScrollRef.current
      const stack = canvasStackRef.current
      if (!scroller || !stack) return
      const sr = stack.getBoundingClientRect()
      if (!sr.width || !sr.height) return
      const left =
        ((initialHover.x + 16) / canvasWidth) * sr.width - scroller.clientWidth / 2
      const top =
        ((initialHover.y + 16) / canvasHeight) * sr.height - scroller.clientHeight / 2
      scroller.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' })
    }, 150)
    return () => window.clearTimeout(id)
  }, [initialHover?.x, initialHover?.y, canvasWidth, canvasHeight])

  const debouncedHover = useDebounced(hover, HOVER_DEBOUNCE_MS)
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null)
  // Once the user has touched the draft (clicked / dragged / resized
  // it), the "DRAG TO MOVE" pill has done its job and just becomes
  // noise covering the canvas. Flip this and the label hides for the
  // rest of the draft's lifetime. A fresh upload resets the flag
  // (effect below, once `paint` is declared).
  const [draftTouched, setDraftTouched] = useState(false)
  // Active corner-resize. `corner` identifies which corner is being dragged
  // (and implicitly the anchor fx/fy = opposite corner). `anchor` is the
  // canvas-space position of the opposite corner, pinned throughout the drag.
  const [resizing, setResizing] = useState<{
    corner: 'tl' | 'tr' | 'bl' | 'br'
    anchor: { fx: number; fy: number }
  } | null>(null)

  // `regions` is used below for the random free-slot placement, so we
  // declare it ahead of usePaintDraft. usePaintDraft holds it via a ref
  // internally, so subsequent region-list updates are picked up without
  // forcing the draft to re-load.
  const { data: regions, isLoading: regionsLoading, isFetching: regionsFetching } = usePaintedRegions()
  // Block timestamps for the activity feed's human-readable "time since
  // paint" column. Empty array (not undefined) keeps the hook order stable.
  const blockTimestamps = useBlockTimestamps(regions?.map((r) => r.blockNumber) ?? EMPTY_BLOCKS)

  const paint = usePaintDraft({
    canvasWidth,
    canvasHeight,
    maxStampSide: MAX_STAMP_SIDE,
    regions,
    // Constrain random placement to the visible viewport when the user
    // is zoomed in (operator preference 2026-05-25). At zoom = 1 the
    // user sees the whole canvas, so return null and pickFreeSlot
    // falls back to its canvas-wide sampling.
    getViewport: () => {
      const scroller = canvasScrollRef.current
      const stack = canvasStackRef.current
      if (!scroller || !stack) return null
      const stackRect = stack.getBoundingClientRect()
      if (stackRect.width === 0 || stackRect.height === 0) return null
      // No effective zoom → no constraint (whole canvas visible).
      if (zoom <= 1.0001) return null
      return {
        x: (scroller.scrollLeft / stackRect.width) * canvasWidth,
        y: (scroller.scrollTop / stackRect.height) * canvasHeight,
        w: (scroller.clientWidth / stackRect.width) * canvasWidth,
        h: (scroller.clientHeight / stackRect.height) * canvasHeight,
      }
    },
  })
  const draftName = paint.draft?.name ?? null
  useEffect(() => {
    // Reset the "touched" flag on every draft load (distinct name or
    // null → name transition). Stays true once the user has clicked
    // the current draft at least once.
    setDraftTouched(false)
  }, [draftName])
  const quote = useQuote(paint.draft)
  const submit = usePaintSubmitBatch()
  const { isConnected, address: connectedAddress, chainId: walletChainId } = useAccount()
  const isDeployed = useCanvasDeployed() === 'deployed'
  // OwnedByYou now lives in the NavMetrics component (top bar). The
  // hook is mounted there and shares the same react-query cache as
  // HomePage's region/tile reads, so there's no duplicate fetch.
  // Window-level drag-and-drop; mounted once at the page level so both
  // the empty-state tile and the canvas overlay can react. Per
  // docs/design_handoff_upload_tile, the canvas itself is a valid drop
  // target during drag — not just the tile in Zone 1.
  const dragUpload = useWindowDragUpload({ onFile: paint.load })
  // Native-token ticker for the currently-selected chain. Derived from
  // the chain picker's selection rather than the connected wallet, so
  // the cost line shows the right ticker ("PLS", "ETH", etc.) even
  // before the user connects a wallet. Viewer chain id falls back to
  // wagmi's chainId when connected, so paint UX stays aligned with
  // what the wallet will sign.
  const chainId = useViewerChainId()
  const chains = useChains()
  const activeChain = chains.find((c) => c.id === chainId)
  const nativeSymbol = activeChain?.nativeCurrency.symbol ?? 'native'
  // Painting requires the wallet's REAL chain (useAccount().chainId, not
  // wagmi's clamped useChainId) to be a configured chain AND to match the
  // viewer chain the quote was priced on. usePaintSubmitBatch re-asserts
  // this at submit time; gating here keeps the button honest.
  const walletChainSupported = chains.some((c) => c.id === walletChainId)
  const walletMatchesViewer = walletChainId === chainId
  // Per-paint chunk cap for the active chain. Tighter than the on-chain
  // ceiling on chains that have adopted a per-tx gas cap (Ethereum
  // EIP-7825, BSC BEP-652) — the contract would accept a 1500-pixel
  // paint on those chains, but the chain's mempool rejects it. Frontend
  // chunks against this number so stamps split into mempool-acceptable
  // transactions before the user signs.
  const effectiveMaxPixels = chainPixelCap(chainId, MAX_PIXELS_PER_TX)
  // Floor USD lives in NavMetrics now; HomePage no longer surfaces it
  // directly. PaintControls receives chainId and computes its own USD
  // subline for the cost line.

  // Manual canvas refresh: invalidate every chain-data query so the
  // user can pull fresh state without reloading the whole tab. The
  // existing live-refresh handler covers new paints automatically;
  // this is for the "I want to make sure I'm seeing latest" case
  // (e.g. after a tx landed in a different tab).
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  // Re-fetch regions + tiles + leaderboard as a short burst rather than a
  // single shot. Public RPCs are load-balanced, so a read fired right after
  // a paint confirms can land on a node that hasn't indexed it yet and
  // return the pre-paint tile; the staggered retries catch the state once it
  // propagates (TanStack structural sharing makes the no-change refetches a
  // cheap no-op for the canvas). Used by both the manual refresh button and
  // the post-paint auto-refresh below.
  const burstRefresh = useCallback(async () => {
    const invalidateAll = () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['painted-regions'] }),
        queryClient.invalidateQueries({ queryKey: ['tile-pixels'] }),
        queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] }),
      ])
    await invalidateAll()
    await new Promise((r) => setTimeout(r, 2500))
    await invalidateAll()
    await new Promise((r) => setTimeout(r, 3500))
    await invalidateAll()
  }, [queryClient])
  const onRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await burstRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [burstRefresh, refreshing])
  const [outboundUrl, setOutboundUrl] = useState<string | null>(null)
  // Success toast: shown briefly after a paint lands, auto-dismisses.
  // Holds the last successful tx hash so the toast keeps its content
  // even after usePaintSubmit's state rolls forward.
  const [successToast, setSuccessToast] = useState<`0x${string}` | null>(null)

  // Dismissing the success toast (manual × or the 6s auto-timeout) also
  // re-scans painted regions. By the time the toast clears the RPC has
  // almost always indexed the paint, so this is a reliable refresh point
  // that complements the post-submit retry invalidations. Light touch
  // (regions + leaderboard, not every tile) to avoid the all-tiles
  // refetch cost on each paint.
  const dismissSuccessToast = useCallback(() => {
    setSuccessToast(null)
    queryClient.invalidateQueries({ queryKey: ['painted-regions'] })
    queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] })
  }, [queryClient])

  // On successful submit, surface a popover + clear the draft (removes
  // the overlay preview + resize handles) + auto-refresh the canvas so the
  // new tag reveals itself without the user touching the refresh button.
  useEffect(() => {
    if (submit.status !== 'success' || !submit.hash) return
    setSuccessToast(submit.hash)
    paint.clear()
    submit.reset()
    void burstRefresh()
    const timer = setTimeout(dismissSuccessToast, 6000)
    return () => clearTimeout(timer)
  }, [submit.status, submit.hash, dismissSuccessToast, burstRefresh])

  // Remember which pixels we've already revealed this session so the canvas
  // accumulates painted state. Previously this was a Map<string, number>
  // keyed by "x,y" — which leaked ~100 bytes per pixel and grew unbounded
  // across refetches. Now a fixed-size Uint32Array sized to the canvas:
  // O(width*height*4) bytes total (4MB for a 1000x1000 canvas), allocated
  // once at mount, never grows. Entry 0 = "not revealed"; any paint stores
  // (color | 0x01000000) so black (0x000000) isn't confused with missing.
  // Use `UNPAINTED_SENTINEL = 0` and encode paint as `color | 0x1000000`.
  const revealedRef = useRef<Uint32Array | null>(null)

  const { data: info, url: linkUrl, isLoading: pixelInfoLoading } = usePixelInfo(debouncedHover)

  // Viewport-tracked set of tiles that are currently visible (with a small
  // pan buffer). Recomputed on scroll + zoom + window-resize. At zoom=1
  // the full canvas fits, so `visibleTiles` enumerates every tile; at
  // zoom>1 only the clipped subset streams in as the user pans.
  const [visibleTiles, setVisibleTiles] = useState<TileCoord[]>(() =>
    tilesForRect(0, 0, canvasWidth, canvasHeight, canvasWidth, canvasHeight),
  )
  useEffect(() => {
    const scrollEl = canvasScrollRef.current
    if (!scrollEl) return

    let rafId: number | null = null
    function recompute() {
      const el = canvasScrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const clientW = rect.width
      if (clientW <= 0) return
      // Canvas CSS width is `zoom * 100%` of the scroll container; height
      // follows from the canvas aspect ratio. CSS-to-canvas-pixel scale
      // is (containerW * zoom) / canvasWidth.
      const scale = (clientW * zoom) / canvasWidth
      if (scale <= 0) return
      const vx0 = el.scrollLeft / scale
      const vy0 = el.scrollTop / scale
      const vx1 = (el.scrollLeft + clientW) / scale
      const vy1 = (el.scrollTop + rect.height) / scale
      const next = tilesForRect(
        vx0,
        vy0,
        vx1 - vx0,
        vy1 - vy0,
        canvasWidth,
        canvasHeight,
        1,
      )
      // Shallow-compare against previous list to avoid re-rendering every
      // scroll tick when nothing changed. Stringified compare is fine for
      // <100 tile entries (full canvas 1250x800 = 70 tiles worst case).
      setVisibleTiles((prev) => {
        if (prev.length === next.length) {
          let same = true
          for (let i = 0; i < prev.length; i++) {
            if (prev[i].tx !== next[i].tx || prev[i].ty !== next[i].ty) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return next
      })
    }

    // rAF-throttle: coalesce scroll bursts into one recompute per frame.
    // Without this a momentum-scroll would fire 60+ scroll events per
    // second, each allocating a fresh tile-list array even when the
    // shallow-compare returns prev. At 70 tile entries the allocation
    // adds up to MB/minute on sustained scroll.
    function schedule() {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        recompute()
      })
    }

    recompute()
    scrollEl.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scrollEl)
    window.addEventListener('resize', schedule)
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      scrollEl.removeEventListener('scroll', schedule)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [canvasWidth, canvasHeight, zoom])

  const tilePixels = useTilePixels(visibleTiles, regions, canvasWidth, canvasHeight)
  // Loading = any visible tile hasn't resolved yet. `isLoading` from
  // react-query is only true during an active fetch; for disabled
  // queries (regions not yet available, publicClient not yet resolved)
  // it returns false, which would hide the scanner during wagmi/RPC
  // initialization. `!isFetched` covers both the "idle because disabled"
  // and "actively fetching" cases, so the scanner shows from first mount
  // through tile resolution without a gap.
  const tilesLoading = useMemo(() => {
    for (const v of tilePixels.values()) if (!v.isFetched) return true
    return false
  }, [tilePixels])
  // Until `regions` is defined, the canvas has no data to render. React
  // Query's `isLoading` on `usePaintedRegions` is also false while the
  // query is disabled (pre-publicClient), so check the data directly.
  const dataNotReady = !regions
  // Scanner shows while ANY chain fetch is in flight: initial load,
  // chain switch (cache invalidate triggers isFetching=true even with
  // cached data already present), or tile pixel reads. `isFetching`
  // catches the chain-switch case where `isLoading` would be false on
  // a refetch of an already-resolved query key.
  const showScanner = dataNotReady || regionsLoading || regionsFetching || tilesLoading

  // Paint the base grid on mount and whenever dimensions OR chain change.
  // chainId is in the deps so a chain switch (e.g. testnet → mainnet) drops
  // the previous chain's revealed-pixel buffer and resets the canvas to the
  // empty grid — otherwise pixels painted on chain A would linger as ghost
  // colour while chain B's tiles fade in, which the user reported as "I see
  // aspects of the old while it loads".
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    el.width = canvasWidth
    el.height = canvasHeight

    // Always allocate a fresh buffer on this effect run. Reusing the prior
    // buffer across a chain switch would mean tiles whose new-chain state
    // is "unpainted" never explicitly clear their old-chain colour.
    revealedRef.current = new Uint32Array(canvasWidth * canvasHeight)

    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    ctx.lineWidth = 1
    // Minor grid every 50px (skip the 100s; they're drawn as majors below
    // so the stronger colour wins at the shared lines).
    ctx.strokeStyle = MINOR_GRIDLINE_COLOR
    for (let i = 0; i <= canvasWidth; i += MINOR_GRIDLINE_EVERY) {
      if (i % MAJOR_GRIDLINE_EVERY === 0) continue
      ctx.beginPath()
      ctx.moveTo(i + 0.5, 0)
      ctx.lineTo(i + 0.5, canvasHeight)
      ctx.stroke()
    }
    for (let i = 0; i <= canvasHeight; i += MINOR_GRIDLINE_EVERY) {
      if (i % MAJOR_GRIDLINE_EVERY === 0) continue
      ctx.beginPath()
      ctx.moveTo(0, i + 0.5)
      ctx.lineTo(canvasWidth, i + 0.5)
      ctx.stroke()
    }
    // Major grid every 100px.
    ctx.strokeStyle = MAJOR_GRIDLINE_COLOR
    for (let i = 0; i <= canvasWidth; i += MAJOR_GRIDLINE_EVERY) {
      ctx.beginPath()
      ctx.moveTo(i + 0.5, 0)
      ctx.lineTo(i + 0.5, canvasHeight)
      ctx.stroke()
    }
    for (let i = 0; i <= canvasHeight; i += MAJOR_GRIDLINE_EVERY) {
      ctx.beginPath()
      ctx.moveTo(0, i + 0.5)
      ctx.lineTo(canvasWidth, i + 0.5)
      ctx.stroke()
    }

    // No revealed-pixel replay here: we just allocated a fresh buffer
    // above. Tiles will repaint via the tile-pixels effect once the new
    // chain's data lands.
  }, [canvasWidth, canvasHeight, chainId])

  // Tracks which tile Uint32Array has been committed to the canvas. The
  // value is the buffer reference itself — react-query returns stable
  // data references when the query result is unchanged, so comparing by
  // `===` skips any cost for tiles that didn't change. Previously we
  // computed a painted-pixel count as the fingerprint, which walked
  // 16k entries per tile on every render (~1M ops per render for a
  // 70-tile canvas). That was pinning the main thread under React's
  // re-render cadence and showed up as multi-GB heap + pegged CPU.
  const drawnTilesRef = useRef<Map<string, Uint32Array>>(new Map())

  // Tile render: stream new/changed tiles into the canvas as their pixel
  // data resolves. Each tile blits a small ImageData (≤128×128) scoped to
  // its own rectangle, keeping per-tile cost tiny and avoiding a full-
  // canvas getImageData on every update. The `revealed` buffer is kept in
  // sync so the hover-reveal and gridline-replay paths stay correct.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const revealed = revealedRef.current
    if (!revealed) return

    const drawn = drawnTilesRef.current

    tilePixels.forEach((entry, key) => {
      const tile = entry.data
      if (!entry.isFetched || !tile) return
      // Reference-identity fingerprint: react-query keeps data refs
      // stable while the cache entry is unchanged, so buf === drawn is
      // O(1) and skips the effect body on renders where nothing changed.
      // (The old count-painted-pixels fingerprint walked 16k entries per
      // tile, ~1M ops per render for a full-canvas viewport — enough to
      // pin the main thread under React's re-render cadence.)
      const buf = tile.colors
      if (drawn.get(key) === buf) return

      const { x: x0, y: y0, w: tileW, h: tileH } = tile
      if (tileW <= 0 || tileH <= 0) return

      // Pull the current tile contents (includes base colour + gridlines),
      // overlay painted pixels, write back. Only reads/writes tileW*tileH
      // bytes, not the full canvas.
      const img = ctx.getImageData(x0, y0, tileW, tileH)
      const data = img.data
      for (let i = 0; i < buf.length; i++) {
        const encoded = buf[i]
        if (encoded === 0) continue // unpainted
        const color = encoded & 0xffffff
        const lx = i % tileW
        const ly = Math.floor(i / tileW)
        const idx = (y0 + ly) * canvasWidth + (x0 + lx)
        revealed[idx] = encoded
        const j = i * 4
        data[j] = (color >>> 16) & 0xff
        data[j + 1] = (color >>> 8) & 0xff
        data[j + 2] = color & 0xff
        data[j + 3] = 0xff
      }
      ctx.putImageData(img, x0, y0)
      drawn.set(key, buf)
    })
  }, [tilePixels, canvasWidth, canvasHeight])

  // Invalidate drawn-tile fingerprints when the canvas is rebuilt (e.g.
  // dimension change). Without this, switching chains would leave the
  // canvas with stale blits because the fingerprint map thinks every
  // tile is already drawn at the matching pixel count.
  useEffect(() => {
    drawnTilesRef.current.clear()
  }, [canvasWidth, canvasHeight])

  // Lazy reveal: on successful hover pixelAt read, paint that pixel.
  useEffect(() => {
    if (!info || !info.isPainted) return
    const revealed = revealedRef.current
    if (!revealed) return
    const idx = info.y * canvasWidth + info.x
    const encoded = (info.color & 0xffffff) | 0x01000000
    if (revealed[idx] === encoded) return
    revealed[idx] = encoded

    const el = canvasRef.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = colorToHex(info.color)
    ctx.fillRect(info.x, info.y, 1, 1)
  }, [info, canvasWidth])

  // Overlay render: redraw the draft stamp whenever it changes. Uses a
  // separate canvas so the base (gridlines + painted-pixel reveals) doesn't
  // have to redraw on every drag tick.
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    el.width = canvasWidth
    el.height = canvasHeight
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    // Deep-link marker: frame the linked tag in lime so a /pixel/x-y
    // visitor sees exactly which tag they were sent to (drawn even with no
    // draft loaded). Seed tags are 32×32 from the linked top-left.
    if (initialHover) {
      ctx.strokeStyle = '#A8FF2E'
      ctx.lineWidth = 2
      ctx.strokeRect(initialHover.x - 1, initialHover.y - 1, 34, 34)
    }
    if (!paint.draft) return
    const d = paint.draft
    for (let dy = 0; dy < d.h; dy++) {
      for (let dx = 0; dx < d.w; dx++) {
        const c = d.colors[dy * d.w + dx]
        if (c === 0xffffffff) continue // transparent
        ctx.fillStyle = colorToHex(c)
        ctx.fillRect(d.x + dx, d.y + dy, 1, 1)
      }
    }
    // Thin highlight border so the stamp is locatable against a busy canvas.
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1
    ctx.strokeRect(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1)

    // Corner handles: 3×3 canvas-pixel squares centred on each corner. Only
    // drawn on stamps at least 10×10 so the handles don't cover the stamp.
    if (d.w >= 10 && d.h >= 10) {
      ctx.fillStyle = '#ffffff'
      const hs = 3
      const corners: Array<[number, number]> = [
        [d.x, d.y],               // TL
        [d.x + d.w, d.y],         // TR
        [d.x, d.y + d.h],         // BL
        [d.x + d.w, d.y + d.h],   // BR
      ]
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2)
      }
    }
  }, [paint.draft, canvasWidth, canvasHeight, initialHover?.x, initialHover?.y])

  /** Hit-test: is the canvas-space point (cx, cy) on one of the stamp's corners? */
  function hitCornerHandle(cx: number, cy: number): {
    corner: 'tl' | 'tr' | 'bl' | 'br'
    anchor: { fx: number; fy: number }
  } | null {
    const d = paint.draft
    if (!d || d.w < 10 || d.h < 10) return null
    const r = 5 // hit radius in canvas pixels (a bit generous vs the 3-px visual)
    const corners = [
      { cx: d.x, cy: d.y, corner: 'tl' as const, anchor: { fx: 1, fy: 1 } },
      { cx: d.x + d.w, cy: d.y, corner: 'tr' as const, anchor: { fx: 0, fy: 1 } },
      { cx: d.x, cy: d.y + d.h, corner: 'bl' as const, anchor: { fx: 1, fy: 0 } },
      { cx: d.x + d.w, cy: d.y + d.h, corner: 'br' as const, anchor: { fx: 0, fy: 0 } },
    ]
    for (const c of corners) {
      if (Math.abs(cx - c.cx) <= r && Math.abs(cy - c.cy) <= r) {
        return { corner: c.corner, anchor: c.anchor }
      }
    }
    return null
  }

  /** Map clientX/Y to canvas pixel coordinates. */
  function eventToCoord(e: React.MouseEvent<HTMLCanvasElement> | MouseEvent) {
    const el = canvasRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * canvasWidth
    const y = ((e.clientY - rect.top) / rect.height) * canvasHeight
    return { x, y }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = eventToCoord(e)
    if (!c) return

    if (resizing && paint.draft) {
      // Anchor position in canvas-space (opposite corner of the grabbed handle).
      const d = paint.draft
      const anchorX = d.x + d.w * resizing.anchor.fx
      const anchorY = d.y + d.h * resizing.anchor.fy
      // Target width: aspect-aware diagonal distance from anchor to cursor.
      const dx = Math.abs(c.x - anchorX)
      const dy = Math.abs(c.y - anchorY)
      const ratio = d.sourceW / d.sourceH
      const targetW = Math.max(dx, dy * ratio)
      paint.resizeAt(targetW, resizing.anchor)
      return
    }

    if (dragOffset && paint.draft) {
      paint.moveTo(c.x - dragOffset.dx, c.y - dragOffset.dy)
      return
    }

    const xi = Math.floor(c.x)
    const yi = Math.floor(c.y)
    if (xi >= 0 && xi < canvasWidth && yi >= 0 && yi < canvasHeight) {
      setHover({ x: xi, y: yi })
      setCursorClient({ clientX: e.clientX, clientY: e.clientY })
    }
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!paint.draft) return
    const c = eventToCoord(e)
    if (!c) return

    // Priority: corner handle before stamp body. Otherwise a click in a
    // corner region would start a drag-move.
    const handle = hitCornerHandle(c.x, c.y)
    if (handle) {
      setResizing(handle)
      setDraftTouched(true)
      e.preventDefault()
      return
    }

    const d = paint.draft
    const insideX = c.x >= d.x && c.x < d.x + d.w
    const insideY = c.y >= d.y && c.y < d.y + d.h
    if (!insideX || !insideY) return
    setDragOffset({ dx: c.x - d.x, dy: c.y - d.y })
    setDraftTouched(true)
    e.preventDefault()
  }

  function onMouseUp() {
    if (dragOffset) setDragOffset(null)
    if (resizing) setResizing(null)
  }

  /**
   * Canvas click → request outbound navigation to the painted pixel's URL.
   *
   * Fires only when (a) no draft is being placed (otherwise click = place
   * intent, not navigate) and (b) the hovered pixel has a link. Routes
   * through the OutboundLinkModal (PRD §6) so users see a "leaving Tagwall"
   * interstitial and the URL scheme is re-validated as defense-in-depth
   * before any window.open call.
   */
  function onClickPixel() {
    // Ignore clicks while placing / dragging / resizing a draft.
    if (paint.draft || dragOffset || resizing) return
    if (!linkUrl) return
    setOutboundUrl(linkUrl)
  }

  function zoomIn() {
    setZoom((z) => Math.min(z * 1.5, 8))
  }
  function zoomOut() {
    setZoom((z) => Math.max(z / 1.5, 1))
  }
  function zoomReset() {
    setZoom(1)
  }

  // Ctrl/Cmd + wheel zooms; plain wheel scrolls (browser default) when zoomed.
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const delta = -Math.sign(e.deltaY)
    setZoom((z) => {
      const next = delta > 0 ? z * 1.2 : z / 1.2
      return Math.max(1, Math.min(8, next))
    })
  }

  return (
    <section className="canvas-section" data-mobile-tab={mobileTab}>
      {/* New-chain launch announcement. Sits at the very top; self-hides
          after the launch window, on dismiss, or when already viewing the
          launched chain (see LaunchBanner + lib/launch.ts). */}
      <LaunchBanner />
      {/* Referral-contest promo bar. Sits above the ticker; self-hides
          once the contest is over (see CompetitionBanner). */}
      <CompetitionBanner />
      {/* Stock-ticker-style scroller of the top leaderboard entries.
          Rendered here (not in AppLayout) so it can receive the
          `regions` prop that HomePage already owns from its single
          `usePaintedRegions` call — avoids a duplicate query that
          tripped on StrictMode in AppLayout. Self-hides when zero
          regions (fresh-chain or filtered-empty). */}
      <LeaderboardTicker regions={regions} nativeSymbol={nativeSymbol} onRequestOutbound={setOutboundUrl} />
      <div className="canvas-wrap">
        <div className="canvas-col">
        <div data-mobile-panel="paint" className="mobile-panel-wrap">
          <PaintControls
            draft={paint.draft}
            error={paint.error}
            pixelCount={paint.pixelCount}
            maxPixelsPerTx={effectiveMaxPixels}
            maxStampSide={MAX_STAMP_SIDE}
            maxWidth={paint.maxWidth}
            onLoad={paint.load}
            onResize={paint.resize}
            onClear={() => {
              paint.clear()
              submit.reset()
            }}
            quoteTotal={quote.total}
            quoteLoading={quote.isLoading}
            quoteError={quote.error ? quote.error.message : null}
            canSubmit={isConnected && isDeployed && walletChainSupported && walletMatchesViewer}
            submitStatus={submit.status}
            submitError={submit.decodedError?.friendly ?? null}
            txHash={submit.hash ?? undefined}
            onSubmit={async ({ link, referrer, maxTotalCost, value, reserveMultiplierBps, skipUnchanged }) => {
              if (!paint.draft) return
              try {
                await submit.submit({
                  draft: paint.draft,
                  link,
                  referrer,
                  maxTotalCost,
                  value,
                  reserveMultiplierBps,
                  maxPixelsPerTx: effectiveMaxPixels,
                  skipUnchanged,
                })
              } catch {
                // error is surfaced via submit.status/submit.error
              }
            }}
            batchProgress={submit.progress}
            canAtomicBatch={submit.canAtomicBatch}
            disabledReason={
              !isConnected
                ? 'Connect your wallet to paint.'
                : !walletChainSupported
                  ? `Your wallet is on chain ${walletChainId ?? 'unknown'}, which Tagwall does not deploy to. Switch chains to paint.`
                  : !walletMatchesViewer
                    ? 'Your wallet chain does not match the canvas you are viewing. Switch your wallet to this chain to paint.'
                    : !isDeployed
                      ? 'Tagwall is not yet deployed on this chain. Switch to PulseChain v4 testnet to paint.'
                      : undefined
            }
            defaultReferrer={sharedReferrer}
            nativeSymbol={nativeSymbol}
            connectedAddress={connectedAddress}
            isDragging={dragUpload.isDragging && !paint.draft}
            dragFileHint={dragUpload.fileHint}
            chainId={chainId}
            zoom={zoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            onRefresh={onRefresh}
            refreshing={refreshing}
            regions={regions}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
          />
        </div>
          {/* canvas-frame: non-scrolling positioned wrapper around
              canvas-scroll. The minimap overlay is a sibling of
              canvas-scroll inside this frame — that way the overlay
              isn't a child of the scrolling container, so it can't
              scroll-drift even at zoom > 1. Operator hard rule
              2026-05-25 ("minimap floats on top, not attached"). */}
          <div className="canvas-frame">
          <div
            className={`canvas-scroll${zoom > 1 ? ' canvas-scroll-zoomed' : ''}`}
            ref={canvasScrollRef}
            onWheel={onWheel}
          >
          <div
            className="canvas-stack"
            ref={canvasStackRef}
            style={{ width: `${zoom * 100}%` }}
          >
            <canvas
              ref={canvasRef}
              className="tagwall-canvas base"
              onMouseMove={onMouseMove}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onClick={onClickPixel}
              onMouseLeave={() => {
                setHover(null)
                setCursorClient(null)
                if (dragOffset) setDragOffset(null)
                if (resizing) setResizing(null)
              }}
              style={
                paint.draft
                  ? {
                      cursor: resizing
                        ? resizing.corner === 'tl' || resizing.corner === 'br'
                          ? 'nwse-resize'
                          : 'nesw-resize'
                        : dragOffset
                        ? 'grabbing'
                        : 'crosshair',
                    }
                  : linkUrl
                  ? { cursor: 'pointer' }
                  : undefined
              }
            />
            <canvas
              ref={overlayRef}
              className="tagwall-canvas overlay"
              aria-hidden
            />
            {paint.draft && (
              <div
                className="draft-outline"
                style={{
                  left: `${(paint.draft.x / canvasWidth) * 100}%`,
                  top: `${(paint.draft.y / canvasHeight) * 100}%`,
                  width: `${(paint.draft.w / canvasWidth) * 100}%`,
                  height: `${(paint.draft.h / canvasHeight) * 100}%`,
                }}
                aria-hidden
              >
                {!draftTouched && (
                  <span className="draft-outline-label">Drag to move</span>
                )}
                <span className="draft-coord">
                  {paint.draft.x}, {paint.draft.y}
                  <span className="draft-coord-size">{paint.draft.w}×{paint.draft.h}</span>
                </span>
              </div>
            )}
            {dragUpload.isDragging && !paint.draft && (
              <div className="paint-drop-overlay" aria-hidden>
                <div className="paint-drop-card">
                  <div className="paint-drop-headline">DROP ANYWHERE</div>
                  <div className="paint-drop-sub">
                    {dragUpload.fileHint
                      ? `${dragUpload.fileHint.name} — ${formatDropBytes(dragUpload.fileHint.size)}`
                      : 'image — waiting for drop'}
                  </div>
                </div>
              </div>
            )}
            {showScanner && (
              <div
                className="canvas-loading-scanner"
                aria-label="Loading painted pixels"
                role="status"
              >
                {/*
                  Horizontal Knight-Rider rows. Each row is a 50px band with
                  a rainbow beam that sweeps left-to-right. Rows are
                  staggered via animation-delay so the sweep cascades down
                  the canvas. Fixed row count (20) covers any reasonable
                  viewport height; overflow is clipped by the parent.
                */}
                {Array.from({ length: 20 }, (_, i) => (
                  <span
                    key={i}
                    className="scanner-row"
                    style={{
                      top: `${i * 50}px`,
                      // Top-down cascade: row i starts its sweep i * 0.05s
                      // after row 0. All 20 rows are in motion within
                      // ~1s (the cycle is 1.4s — see CSS), so the wave
                      // reads as "loading from top to bottom" without
                      // leaving bottom rows visibly frozen.
                      animationDelay: `${(i * 0.05).toFixed(2)}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          </div>{/* /canvas-scroll */}
          {/* Floating minimap overlay — sibling of canvas-scroll
              inside the non-scrolling canvas-frame. Does not move
              when the canvas-stack inside canvas-scroll scrolls. */}
          <MinimapOverlay
            regions={regions}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            draft={paint.draft ? { x: paint.draft.x, y: paint.draft.y, w: paint.draft.w, h: paint.draft.h } : null}
            zoom={zoom}
            scrollContainerRef={canvasScrollRef}
            stackRef={canvasStackRef}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            onRefresh={onRefresh}
            refreshing={refreshing}
          />
          </div>{/* /canvas-frame */}
        </div>

        {/* Leaderboard previously lived in a `<aside.canvas-side>` rail
            to the right of the canvas, but that ate ~360px of horizontal
            space the canvas wanted, AND the rail's full-height border
            ran past the leaderboard card and looked like an orphan line.
            Moved 2026-05-24 below the canvas alongside Activity (operator
            preference: more canvas, less side-chrome). Mobile-tabs "Scores"
            target still works because the new home in `.activity-dock` keeps
            the same component instance. */}
      </div>

      {/* Mobile tab strip (Phase 3) — visible only at <720px via CSS.
          Switches which of the Paint / Scores / Activity panels renders
          in the bottom sheet below the canvas. Canvas itself stays
          pinned at the top as the hero of every tab. */}
      <nav className="mobile-tabs" role="tablist" aria-label="Mobile panels">
        <button
          role="tab"
          aria-selected={mobileTab === 'paint'}
          className={`mt-btn ${mobileTab === 'paint' ? 'mt-btn-active' : ''}`}
          onClick={() => setMobileTab('paint')}
        >
          Paint
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === 'scores'}
          className={`mt-btn ${mobileTab === 'scores' ? 'mt-btn-active' : ''}`}
          onClick={() => setMobileTab('scores')}
        >
          Leaderboard
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === 'activity'}
          className={`mt-btn ${mobileTab === 'activity' ? 'mt-btn-active' : ''}`}
          onClick={() => setMobileTab('activity')}
        >
          Activity
        </button>
      </nav>

      {/* Below-canvas dock. Wide viewports: 2-column [Leaderboard |
          ActivityFeed] with StatsCards spanning below. Narrow: stacks
          to a single column. Replaces the canvas-side rail layout
          where the leaderboard sat next to the canvas (2026-05-24).
          The `data-mobile-panel` on the wrapper still drives mobile
          tab selection; "scores" and "activity" both render content
          inside this dock now. */}
      <div className="activity-dock" data-mobile-panel="activity">
        <Leaderboard
          regions={regions}
          nativeSymbol={nativeSymbol}
          chainId={chainId}
          onRequestOutbound={setOutboundUrl}
        />
        <ActivityFeed
          regions={regions}
          isLoading={regionsLoading}
          startingPrice={startingPrice}
          nativeSymbol={nativeSymbol}
          blockTimestamps={blockTimestamps}
          onRequestOutbound={setOutboundUrl}
        />
        {/* Sibling to the per-paint Leaderboard. Data source is entirely
            independent — the tweets bot computes it server-side from
            cross-chain Painted events and ENS reverse lookups, so this
            component has zero RPC / wagmi coupling and renders the same
            regardless of the connected chain. Third column of the dock row;
            shares the "scores" mobile tab as the per-paint board. */}
        <ReferrersLeaderboard />
        <StatsCards regions={regions} />
      </div>
      <OutboundLinkModal url={outboundUrl} onClose={() => setOutboundUrl(null)} />

      {/* Floating hover tooltip, positioned in viewport coords. Disabled
          while the user is placing / dragging / resizing a draft stamp
          (the placement UX shouldn't fight with the inspector). */}
      {cursorClient && hover && !paint.draft && (
        <PixelHoverTooltip
          anchor={{ ...cursorClient, x: hover.x, y: hover.y }}
          info={info}
          linkUrl={linkUrl}
          loading={pixelInfoLoading}
          startingPrice={startingPrice}
          nativeSymbol={nativeSymbol}
          onRequestOutbound={setOutboundUrl}
        />
      )}

      {successToast && (
        <div className="paint-toast" role="status">
          <span>Tag painted.</span>
          <code>{successToast.slice(0, 10)}…{successToast.slice(-6)}</code>
          <button
            onClick={dismissSuccessToast}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <FounderClaimPrompt painter={connectedAddress} triggerKey={successToast} />
    </section>
  )
}

// Fallback dimensions used before the chain reads resolve, and when the
// canvas is absent on the current chain. Matches Canvas.sol v3.2 (1250x800)
// so the pre-load grid lines look right and the layout stays stable.
const DEFAULT_CANVAS_WIDTH = 1250
const DEFAULT_CANVAS_HEIGHT = 800

/**
 * Read the `/pixel/x-y` route param into a coord, if the current route
 * matches. Returns null when not on that route or when the param is
 * malformed. Deep-link entry point: https://tagwall.io/pixel/123-456
 * opens the canvas with the info panel focused on pixel (123, 456).
 *
 * Accepts either a hyphen (`123-456`, preferred — survives tweet/DM URL
 * auto-linking) or a comma (`123,456`, legacy — clients truncate the link
 * at the comma, so don't share these). Coords are non-negative, so the
 * hyphen is unambiguous.
 */
function useDeepLinkedPixel(): { x: number; y: number } | null {
  const { coord } = useParams()
  return useMemo(() => {
    if (!coord) return null
    const [xs, ys] = coord.split(/[,-]/)
    const x = Number(xs)
    const y = Number(ys)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null
    return { x: Math.floor(x), y: Math.floor(y) }
  }, [coord])
}

function useSharedReferrer(): Address | undefined {
  return useMemo(() => {
    if (typeof window === 'undefined') return undefined
    const v = new URLSearchParams(window.location.search).get('ref')
    // Non-strict so lowercase and wrong-checksum mixed-case ?ref= values
    // are accepted; getAddress() re-checksums. Matches the share-side
    // validation in SharePage so a link it produces is never dropped.
    if (!v || !isAddress(v, { strict: false })) return undefined
    try {
      return getAddress(v)
    } catch {
      return undefined
    }
  }, [])
}

export default function HomePage() {
  // Pull dimensions + starting price + total stamps from the header read
  // so rendering uses real chain values where possible, and falls back to
  // the compiled-in defaults before the first RPC round-trip.
  const { data: header } = useCanvasHeader()
  const sharedReferrer = useSharedReferrer()
  const deepLinkedPixel = useDeepLinkedPixel()

  const canvasWidth =
    header && header[0]?.status === 'success'
      ? (header[0].result as number)
      : DEFAULT_CANVAS_WIDTH
  const canvasHeight =
    header && header[1]?.status === 'success'
      ? (header[1].result as number)
      : DEFAULT_CANVAS_HEIGHT
  const startingPrice =
    header && header[2]?.status === 'success' ? (header[2].result as bigint) : null

  // Discard a deep-linked pixel that lies outside the canvas. Without
  // this clamp, /pixel/9999999,9999999 ends up indexing past the
  // revealedRef Uint32Array bounds and lights up nothing useful.
  const safeDeepLink =
    deepLinkedPixel &&
    deepLinkedPixel.x < canvasWidth &&
    deepLinkedPixel.y < canvasHeight
      ? deepLinkedPixel
      : null

  return (
    <CanvasView
      startingPrice={startingPrice}
      canvasWidth={canvasWidth}
      canvasHeight={canvasHeight}
      sharedReferrer={sharedReferrer}
      initialHover={safeDeepLink}
    />
  )
}
