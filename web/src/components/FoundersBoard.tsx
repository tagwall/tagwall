import { useMemo, useState } from 'react'
import { useAccount, useChains } from 'wagmi'

import { useFounders } from '../hooks/useFounders'
import { GENESIS_CAP, FOUNDER_CAP } from '../lib/founders'
import { chainColorTokens } from '../lib/chainColor'
import { shortenAddress } from '../lib/format'
import { useViewerChainId } from '../lib/viewerChain'
import { Thumbnail, useThumbnailPixels, useLinkUrls } from './Leaderboard'
import { FounderBadge } from './FounderBadge'
import { FounderShareCard } from './FounderShareCard'
import { OutboundLinkModal } from './OutboundLinkModal'

/** Stable key matching useThumbnailPixels' internal regionKey. */
function regionKey(blockNumber: bigint, logIndex: number): string {
  return `${blockNumber}-${logIndex}`
}

function ProgressRow({
  label,
  filled,
  cap,
  tone,
}: {
  label: string
  filled: number
  cap: number
  tone: 'genesis' | 'founder'
}) {
  const pct = Math.min(100, (filled / cap) * 100)
  return (
    <div className={`founders-progress founders-progress-${tone}`}>
      <div className="founders-progress-head">
        <span className="founders-progress-label">{label}</span>
        <span className="founders-progress-count">
          {filled.toLocaleString('en-US')} / {cap.toLocaleString('en-US')}
        </span>
      </div>
      <div className="founders-progress-track" role="progressbar" aria-valuenow={filled} aria-valuemin={0} aria-valuemax={cap}>
        <span className="founders-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/**
 * The Founders board for the viewer's current chain. Header surfaces the
 * live scarcity counter ("N Genesis spots left" / "claim yours"), then a
 * ranked list of every founder so far with their first-paint thumbnail,
 * tier badge, address, and link. This is the surface the founding-painters
 * event points at, and the place a claimed founder number becomes visible.
 */
export function FoundersBoard() {
  const { entries, stats, isLoading } = useFounders()
  const chainId = useViewerChainId()
  const chains = useChains()
  const chainName = chains.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`
  const accent = chainColorTokens(chainId).hex

  const { address: connectedAddress } = useAccount()

  const regions = useMemo(() => entries.map((e) => e.region), [entries])
  const { data: thumbPixels } = useThumbnailPixels(regions)
  const linkUrls = useLinkUrls(regions.map((r) => r.linkId))

  // The viewer's own claimed slot, if their connected wallet is a founder
  // on this chain. Surfaces the shareable card above the list.
  const myEntry = useMemo(() => {
    if (!connectedAddress) return undefined
    const lower = connectedAddress.toLowerCase()
    return entries.find((e) => e.painter.toLowerCase() === lower)
  }, [connectedAddress, entries])

  const [outboundUrl, setOutboundUrl] = useState<string | null>(null)

  // The headline counter: while Genesis has open slots, push Genesis;
  // once it's full, push the remaining Founder window. This is the call
  // to action, so it leads with whichever scarcity is currently biting.
  const headline =
    stats.genesisLeft > 0
      ? { n: stats.genesisLeft, label: 'Genesis spots left', tier: 'genesis' as const }
      : { n: stats.totalLeft, label: 'Founder spots left', tier: 'founder' as const }

  return (
    <section className="founders-board">
      <header className="founders-board-header">
        <div className="founders-headline">
          <span className={`founders-headline-num founders-headline-${headline.tier}`}>
            {headline.n.toLocaleString('en-US')}
          </span>
          <span className="founders-headline-label">
            {headline.label} on {chainName}
          </span>
        </div>
        <p className="founders-board-sub">
          The first {FOUNDER_CAP.toLocaleString('en-US')} painters on each chain are its
          founders, recorded permanently on-chain in the order they painted. The first{' '}
          {GENESIS_CAP} are Genesis. Paint a single pixel before the window closes and your
          number is yours forever.
        </p>
        <div className="founders-progress-grid">
          <ProgressRow label="Genesis" filled={stats.genesisClaimed} cap={GENESIS_CAP} tone="genesis" />
          <ProgressRow label="Founder" filled={stats.claimed} cap={FOUNDER_CAP} tone="founder" />
        </div>
      </header>

      {myEntry && (
        <FounderShareCard
          entry={myEntry}
          stats={stats}
          chainName={chainName}
          accent={accent}
          pixels={thumbPixels?.get(regionKey(myEntry.region.blockNumber, myEntry.region.logIndex))}
        />
      )}

      {isLoading && entries.length === 0 && (
        <p className="pixel-placeholder">Reading the chain for founders…</p>
      )}
      {!isLoading && entries.length === 0 && (
        <p className="founders-empty">
          No founders on {chainName} yet. The very first painter takes <strong>Genesis #1</strong>.
        </p>
      )}

      {entries.length > 0 && (
        <ol className="founders-list">
          {entries.map((e) => {
            const link = e.region.linkId > 0 ? linkUrls.get(e.region.linkId) : undefined
            return (
              <li key={`${e.painter}-${e.rank}`} className={`founders-row founders-row-${e.tier}`}>
                <FounderBadge rank={e.rank} tier={e.tier} size="md" />
                <Thumbnail region={e.region} pixels={thumbPixels?.get(regionKey(e.region.blockNumber, e.region.logIndex))} />
                <div className="founders-row-meta">
                  <span className="founders-row-painter" title={e.painter}>
                    {shortenAddress(e.painter)}
                  </span>
                  {link ? (
                    <button
                      type="button"
                      className="founders-row-link"
                      title={link}
                      onClick={() => setOutboundUrl(link)}
                    >
                      {link.replace(/^https?:\/\//, '').slice(0, 30)}
                    </button>
                  ) : (
                    <span className="founders-row-link-empty">no link</span>
                  )}
                </div>
                <code className="founders-row-coord">
                  ({e.region.x},{e.region.y})
                </code>
              </li>
            )
          })}
        </ol>
      )}

      <OutboundLinkModal url={outboundUrl} onClose={() => setOutboundUrl(null)} />
    </section>
  )
}
