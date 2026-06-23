import { useMemo } from 'react'
import { formatEther } from 'viem'

import type { PaintedRegion } from '../hooks/usePaintedRegions'
import { Thumbnail, useLinkUrls, useThumbnailPixels } from './Leaderboard'
import { LinkLabel } from './LinkLabel'

/**
 * Stock-ticker-style continuously-scrolling strip of the top leaderboard
 * entries. Sits between the global chrome (ConnectBar) and the page
 * content so it's visible regardless of which tab/route the user is on.
 *
 * Mechanics:
 *   - Pulls regions via the same `usePaintedRegions` hook as Leaderboard
 *     (react-query dedupes the read), sorts top-N by `pricePaid`, and
 *     renders each as a row in a flex track.
 *   - The track contains the items duplicated end-to-end. A CSS
 *     `@keyframes ticker-scroll` animates the track from `translateX(0)`
 *     to `translateX(-50%)`, then loops. Because the second half is an
 *     exact copy of the first, the loop reset is visually seamless: as
 *     the first half finishes scrolling off the left, the second half
 *     occupies the same screen position and we snap back to 0.
 *   - Pauses on hover so users can read an entry without it sliding away.
 *
 * Renders nothing when there are zero painted regions — the ticker would
 * be just an empty bar.
 *
 * Fields: rank, thumbnail, link, price. (Painter address omitted, per
 * operator preference.)
 */

/** Magnitude-aware native amount formatter. Mirrors `formatNative` in
 *  Leaderboard.tsx — keep in sync if the leaderboard's number style
 *  changes. */
function formatNative(wei: bigint): string {
  const ether = Number(formatEther(wei))
  if (!Number.isFinite(ether) || ether === 0) return '0'
  if (ether >= 1000) return ether.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (ether >= 1) return ether.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (ether >= 0.001) return ether.toFixed(4)
  if (ether >= 0.000001) return ether.toFixed(6)
  return ether.toExponential(2)
}

const MAX_TICKER_ITEMS = 10

interface Props {
  regions: readonly PaintedRegion[] | undefined
  nativeSymbol: string
  /** Routes link clicks through the parent's OutboundLinkModal so the
   *  user gets the same click-through interstitial + scheme check that
   *  the Leaderboard and ActivityFeed link cells use. */
  onRequestOutbound: (url: string) => void
  /** Pre-resolved linkId -> URL map for non-EVM chain families
   *  (Solana feeds this from useSolanaLinkUrls). When provided it
   *  replaces the internal wagmi-based resolution entirely and the
   *  EVM contract reads are disabled. Absent on EVM chains. */
  linkUrlsOverride?: Map<number, string>
}

export function LeaderboardTicker({ regions, nativeSymbol, onRequestOutbound, linkUrlsOverride }: Props) {
  const top = useMemo(() => {
    if (!regions || regions.length === 0) return []
    return [...regions]
      .sort((a, b) => (b.pricePaid > a.pricePaid ? 1 : b.pricePaid < a.pricePaid ? -1 : 0))
      .slice(0, MAX_TICKER_ITEMS)
  }, [regions])

  // Override (non-EVM chain families) replaces the wagmi lookup; the
  // shared Leaderboard hook is disabled in that case so no EVM reads
  // fire. EVM callers keep sharing Leaderboard's wagmi cache key.
  const evmLinkUrls = useLinkUrls(top.map((r) => r.linkId), !linkUrlsOverride)
  const linkUrls = linkUrlsOverride ?? evmLinkUrls
  const { data: thumbPixels } = useThumbnailPixels(top)

  if (top.length === 0) return null

  // Duplicate the items so the @keyframes loop has identical content
  // either side of the wrap point — without this the scroll visibly
  // snaps when it restarts.
  const looped = [...top, ...top]

  return (
    <div className="lb-ticker" role="marquee" aria-label="Top leaderboard entries">
      <div className="lb-ticker-track">
        {looped.map((r, i) => {
          const isClone = i >= top.length
          const rank = (i % top.length) + 1
          const url = linkUrls.get(r.linkId) ?? null
          const regionKey = `${r.blockNumber}-${r.logIndex}`
          const pixels = thumbPixels?.get(regionKey)
          return (
            <div
              key={`${regionKey}-${i}`}
              className="lb-ticker-item"
              aria-hidden={isClone ? 'true' : undefined}
            >
              <span className="lb-ticker-rank">#{rank}</span>
              <Thumbnail region={r} pixels={pixels} />
              {url ? (
                // Real <button>, not an <a href>: a raw href lets
                // middle-click / cmd-click / "open in new tab" bypass the
                // outbound interstitial modal (PRD §6) and its blocklist
                // checks entirely.
                <button
                  type="button"
                  className="lb-ticker-link"
                  title={url}
                  onClick={() => {
                    // Don't open links from the duplicated tail; the
                    // visible scroll position decides which copy the
                    // user clicked, but for screen readers the clone
                    // copies are aria-hidden, so suppress them at the
                    // event layer too. (Without this, two clones
                    // could fire two modal opens on rapid clicks.)
                    if (!isClone) onRequestOutbound(url)
                  }}
                >
                  <LinkLabel
                    url={url}
                    fallback={(() => {
                      try {
                        return new URL(url).hostname
                      } catch {
                        return url
                      }
                    })()}
                  />
                </button>
              ) : (
                <span className="lb-ticker-link lb-ticker-link-empty">no link</span>
              )}
              <span className="lb-ticker-price">
                {formatNative(r.pricePaid)}
                <span className="lb-ticker-price-unit"> {nativeSymbol}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
