import { useEffect, useMemo, useRef } from 'react'
import { decodeFunctionData, formatEther, type Hex } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient, useReadContracts } from 'wagmi'

import { CANVAS_ADDRESS, canvasAbi } from '../contracts/canvas'
import { useNativeUsdPrice } from '../hooks/useNativeUsdPrice'
import type { PaintedRegion } from '../hooks/usePaintedRegions'
import type { PixelState } from '../hooks/useTilePixels'
import { formatUsd, weiToUsdRate } from '../lib/usdPrice'

interface Props {
  regions: readonly PaintedRegion[] | undefined
  nativeSymbol?: string
  /** Active chain id, used to convert wei → USD for the cost column.
   *  Falls back to a magnitude-aware native formatter when null. */
  chainId?: number | null
  /** Outbound-link gate. Required: every link click in the leaderboard
   *  routes through the parent's OutboundLinkModal so users get a
   *  click-through interstitial (PRD §6) and a defense-in-depth scheme
   *  check before navigation. */
  onRequestOutbound: (url: string) => void
}

/** Magnitude-aware formatter for native amounts. The previous toFixed(0)
 *  collapsed any sub-1-token cost to "0" — fine when the floor was 1 ETH
 *  and stamps cost hundreds, but every paint reads "0 ETH" with a 20k
 *  gwei floor. Picks precision so small amounts stay readable, and
 *  thousand-separator commas above 1k so PLS-scale numbers like
 *  6700 / 13400 read as 6,700 / 13,400 instead of running together. */
function formatNative(wei: bigint): string {
  const ether = Number(formatEther(wei))
  if (!Number.isFinite(ether) || ether === 0) return '0'
  if (ether >= 1000) return ether.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (ether >= 1) return ether.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (ether >= 0.001) return ether.toFixed(4)
  if (ether >= 0.000001) return ether.toFixed(6)
  return ether.toExponential(2)
}

/** Stable per-region identity key used to address the thumbnail-pixel map. */
function regionKey(r: PaintedRegion): string {
  return `${r.blockNumber}-${r.logIndex}`
}

/**
 * Fetches the per-pixel colour state for the given leaderboard regions
 * *as painted*, i.e. the historical colours the painter submitted, not
 * the current canvas state.
 *
 * Why not `pixelAt`: each leaderboard entry is one Painted event with
 * its own `pricePaid`. When a pixel is later overwritten, the older
 * entry still earns its rank from the original spend, but `pixelAt`
 * returns the new colour. The thumbnail then misrepresents the entry —
 * e.g. the genesis (0,0) grey paint shows up green after an overwrite.
 *
 * Source of truth: the `paint(x, y, w, h, colors[], …)` calldata of the
 * paint transaction. We fetch each region's tx, decode the input, and
 * map `colors[dy*w + dx]` (row-major, matches the submit path in
 * usePaintDraft.ts) onto canvas coordinates. One RPC per region beats
 * w*h pixelAt reads, so this is also much cheaper than the previous
 * per-pixel multicall.
 */
export function useThumbnailPixels(regions: readonly PaintedRegion[]) {
  const publicClient = usePublicClient()

  return useQuery({
    queryKey: [
      'leaderboard-pixels',
      publicClient?.chain.id,
      CANVAS_ADDRESS,
      regions.map((r) => `${regionKey(r)}:${r.txHash}`).join(','),
    ],
    enabled: !!publicClient && regions.length > 0,
    // Calldata is immutable, so once decoded the result never changes.
    // Long stale window keeps Leaderboard + Ticker sharing one cache.
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, PixelState[]>> => {
      if (!publicClient || regions.length === 0) return new Map()

      const txs = await Promise.all(
        regions.map((r) =>
          publicClient
            .getTransaction({ hash: r.txHash as Hex })
            .then(
              (tx) => ({ region: r, input: tx.input as Hex }),
              () => ({ region: r, input: null as Hex | null }),
            ),
        ),
      )

      const map = new Map<string, PixelState[]>()
      for (const { region: r, input } of txs) {
        if (!input) continue
        let colors: readonly number[]
        try {
          const decoded = decodeFunctionData({ abi: canvasAbi, data: input })
          if (decoded.functionName !== 'paint') continue
          // paint(x, y, w, h, colors, link, referrer, metadataHash, …)
          colors = decoded.args[4] as readonly number[]
        } catch {
          continue
        }
        const expected = r.w * r.h
        if (colors.length !== expected) continue
        const key = regionKey(r)
        const list: PixelState[] = []
        for (let dy = 0; dy < r.h; dy++) {
          for (let dx = 0; dx < r.w; dx++) {
            const color = colors[dy * r.w + dx]
            // 0xFFFFFFFF is the transparent sentinel (Canvas.sol skips
            // these pixels and doesn't charge for them). Omit from the
            // list so Thumbnail's backdrop shows through, matching the
            // behaviour of the previous lastPrice===0 skip.
            if ((color >>> 0) === 0xffffffff) continue
            list.push({
              x: r.x + dx,
              y: r.y + dy,
              color,
              // Historical lastPrice / linkId aren't carried in calldata
              // and aren't read by Thumbnail; placeholders preserve the
              // PixelState shape for other consumers.
              lastPrice: r.pricePaid,
              linkId: r.linkId,
            })
          }
        }
        if (list.length > 0) map.set(key, list)
      }
      return map
    },
  })
}

function shortenAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function colorToHex(c: number): string {
  // Transparent sentinel (high byte = 0xFF) renders as the panel background.
  if ((c & 0xff000000) !== 0) return '#0a0a10'
  return `#${c.toString(16).padStart(6, '0')}`
}

/** Fetches the URL for each unique linkId in the top regions.
 *  Exported so `LeaderboardTicker` can reuse the same wagmi cache key
 *  and avoid double-fetching. */
export function useLinkUrls(linkIds: number[]) {
  const unique = useMemo(() => Array.from(new Set(linkIds.filter((n) => n > 0))), [linkIds])
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: unique.map((id) => ({
      address: CANVAS_ADDRESS,
      abi: canvasAbi,
      functionName: 'links' as const,
      args: [id],
    })),
    query: { enabled: unique.length > 0, staleTime: 60_000 },
  })
  const map = useMemo(() => {
    const out = new Map<number, string>()
    unique.forEach((id, i) => {
      const r = data?.[i]
      if (r && r.status === 'success' && typeof r.result === 'string' && r.result) {
        out.set(id, r.result)
      }
    })
    return out
  }, [unique, data])
  return map
}

/** Mini canvas showing the stamp's actual pixel data. Exported so
 *  `LeaderboardTicker` (and any future "leaderboard slice" UI) can render
 *  the same pixel preview without duplicating the canvas-paint logic. */
export function Thumbnail({ region, pixels }: { region: PaintedRegion; pixels: readonly PixelState[] | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.width = region.w
    el.height = region.h
    const ctx = el.getContext('2d')
    if (!ctx) return
    // Fill backdrop so unrendered pixels don't leave transparent gaps
    // that show the page background.
    ctx.fillStyle = '#07070b'
    ctx.fillRect(0, 0, region.w, region.h)
    if (!pixels) return
    // Pixels are already scoped to this region by useThumbnailPixels, so
    // no bbox filter is needed.
    for (const p of pixels) {
      ctx.fillStyle = colorToHex(p.color)
      ctx.fillRect(p.x - region.x, p.y - region.y, 1, 1)
    }
  }, [region, pixels])

  return (
    <canvas
      ref={ref}
      className="leaderboard-thumb"
      aria-label={`Thumbnail of stamp at (${region.x},${region.y}) size ${region.w}×${region.h}`}
    />
  )
}

/**
 * Top-spenders leaderboard. Sorts all regions by `pricePaid` descending,
 * surfaces the top 10 with a mini-canvas thumbnail, spend, coords, painter,
 * and (if present) outbound link. Useful for the "whose flag is planted
 * hardest" view: highlights the most-reserved logos above the activity
 * feed's strictly-chronological stream.
 */
export function Leaderboard({ regions, nativeSymbol = 'native', chainId = null, onRequestOutbound }: Props) {
  const usdRate = useNativeUsdPrice(chainId)
  const top = useMemo(() => {
    if (!regions || regions.length === 0) return []
    return [...regions]
      .sort((a, b) => (b.pricePaid > a.pricePaid ? 1 : b.pricePaid < a.pricePaid ? -1 : 0))
      .slice(0, 10)
  }, [regions])

  const linkUrls = useLinkUrls(top.map((r) => r.linkId))
  const { data: thumbPixels } = useThumbnailPixels(top)

  if (!regions || regions.length === 0) return null

  return (
    <section className="leaderboard">
      <header className="leaderboard-header">
        <h3>Leaderboard</h3>
        <span className="leaderboard-sub">Top {top.length} by spend</span>
      </header>
      <ol className="leaderboard-list">
        {top.map((r, i) => {
          const link = r.linkId > 0 ? linkUrls.get(r.linkId) : undefined
          return (
            <li key={`${r.blockNumber}-${r.logIndex}`} className="leaderboard-row">
              <span className="leaderboard-rank">#{i + 1}</span>
              <Thumbnail region={r} pixels={thumbPixels?.get(regionKey(r))} />
              <div className="leaderboard-meta">
                {link ? (
                  <a
                    className="leaderboard-link"
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={link}
                    onClick={(e) => {
                      // Route through the outbound interstitial modal
                      // (PRD §6). Defense-in-depth: the modal re-validates
                      // that the URL is https:// before opening.
                      e.preventDefault()
                      onRequestOutbound(link)
                    }}
                  >
                    {link.replace(/^https?:\/\//, '').slice(0, 30)}
                  </a>
                ) : (
                  <span className="leaderboard-link-empty">— no link —</span>
                )}
                <span className="leaderboard-painter" title={r.painter}>
                  {shortenAddress(r.painter)}
                </span>
              </div>
              <code
                className="leaderboard-cost"
                title={
                  weiToUsdRate(r.pricePaid, usdRate) > 0
                    ? `${formatEther(r.pricePaid)} ${nativeSymbol} ≈ ${formatUsd(weiToUsdRate(r.pricePaid, usdRate))}`
                    : `${formatEther(r.pricePaid)} ${nativeSymbol}`
                }
              >
                {formatNative(r.pricePaid)} <span className="token">{nativeSymbol}</span>
              </code>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
