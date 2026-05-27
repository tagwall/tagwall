import { useEffect, useMemo, useState } from 'react'

import { chainColorTokens } from '../lib/chainColor'

/**
 * /tweets — copy-ready tweets for @tagwall_io_bot.
 *
 * Three classes of tweet, all shown on this single page:
 *
 *   1. Cross-chain 7-day summary (1 tweet, top of page).
 *   2. Per-chain 7-day weekly recap (one per chain, in the summary
 *      cards).
 *   3. Per-paint notable-event tweets (the original "queue", from the
 *      tweets bot's scan of recent Painted events).
 *
 * Reads /queue.json (per-paint candidates) and /summary.json (7-day
 * aggregates), both written every 30 min by the tweets-bot GitHub
 * Actions workflow scanning all four EVM chains. The page renders
 * everything client-side with Copy buttons; per-paint entries can be
 * marked "posted" (localStorage; doesn't sync across devices).
 *
 * Route was originally /queue; renamed to /tweets to match operator
 * mental model ("which tweet should I copy?"). /queue still works as
 * a redirect.
 *
 * Public route. The data is just notable paints on an immutable public
 * canvas; anyone could derive the same list from chain logs. The page
 * isn't linked from site nav (operator tool); known by URL.
 */

interface QueueEntry {
  id: string                // tx hash, unique per paint
  chain: string             // 'PulseChain' | 'Ethereum' | 'Base' | 'BSC'
  chainId: number
  queuedAt: string          // ISO timestamp from the bot run
  painter: string           // full 0x address
  painterShort: string      // '0x1bBe…685B'
  x: number
  y: number
  w: number
  h: number
  pixels: number
  priceFormatted: string    // e.g. '7,500 PLS'
  pricePerPixelFormatted?: string  // e.g. '5.00 PLS'; old entries may lack
  native: string            // 'PLS' | 'ETH' | 'BNB'
  wasOverpaint?: boolean    // true when at least one pixel was overwritten
  tweet: string             // ready-to-paste tweet text
  txUrl: string             // block explorer link
  pixelUrl: string          // tagwall.io/pixel/X,Y
}

interface QueuePayload {
  generatedAt: string
  entries: QueueEntry[]
}

interface SummaryPeak {
  x: number; y: number; w: number; h: number
  pixels: number
  priceFormatted: string
  painter: string
  painterShort: string
  pixelUrl: string
  txUrl: string
}

interface ChainSummary {
  chain: string
  chainId: number
  native: string
  windowStartBlock: number
  windowEndBlock: number
  paintCount: number
  overpaintCount: number
  uniquePainters: number
  totalVolumeFormatted: string
  biggestByPixels: SummaryPeak | null
  biggestByPrice: SummaryPeak | null
}

interface SummaryPayload {
  generatedAt: string
  windowDays: number
  chains: ChainSummary[]
}

const POSTED_KEY = 'tagwall.queue.posted'

function loadPosted(): Set<string> {
  try {
    const raw = localStorage.getItem(POSTED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function savePosted(posted: Set<string>): void {
  try {
    localStorage.setItem(POSTED_KEY, JSON.stringify(Array.from(posted)))
  } catch {
    // ignore (storage disabled / quota)
  }
}

function formatQueuedAt(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * Build the per-chain weekly recap tweet body. ~180-280 chars depending
 * on activity. Skips the "biggest" line for 1-pixel paints (they're
 * test/reservation paints, not impressive recap content). When the
 * chain is quiet, emits a short "open invitation" tweet rather than
 * an empty one.
 */
function chainWeeklyTweet(c: ChainSummary, windowDays: number): string {
  const lines: string[] = [`🎨 tagwall.io · ${c.chain} last ${windowDays} days`]
  if (c.paintCount === 0) {
    lines.push(`quiet week. canvas wide open for the next tag.`)
    lines.push(`https://tagwall.io`)
    return lines.join('\n')
  }
  const paintLine = c.overpaintCount > 0
    ? `${c.paintCount} paint${c.paintCount === 1 ? '' : 's'} (${c.overpaintCount} overpaint${c.overpaintCount === 1 ? '' : 's'})`
    : `${c.paintCount} paint${c.paintCount === 1 ? '' : 's'}`
  lines.push(paintLine)
  lines.push(
    `${c.uniquePainters} unique painter${c.uniquePainters === 1 ? '' : 's'} · ${c.totalVolumeFormatted} volume`
  )
  // Skip "biggest" if it's a 1-pixel paint — that's almost always a
  // test/reservation, not a flex. Surface it only when there's a real
  // region behind it.
  if (c.biggestByPixels && c.biggestByPixels.pixels > 1) {
    lines.push(
      `biggest: ${c.biggestByPixels.w}×${c.biggestByPixels.h} (${c.biggestByPixels.pixels.toLocaleString()} px) for ${c.biggestByPixels.priceFormatted}`
    )
  }
  lines.push(`https://tagwall.io`)
  return lines.join('\n')
}

/**
 * Build the cross-chain 7-day comparison tweet. We can't sum volumes
 * (different native tokens), so each chain gets its own line. Chains
 * with zero activity collapse to "quiet" to save chars.
 */
function crossChainTweet(summary: SummaryPayload): string {
  const lines: string[] = [`📊 tagwall.io · last ${summary.windowDays}-day recap`]
  for (const c of summary.chains) {
    if (c.paintCount === 0) {
      lines.push(`${c.chain}: quiet`)
    } else {
      lines.push(`${c.chain}: ${c.paintCount} paints · ${c.totalVolumeFormatted}`)
    }
  }
  const totalPaints = summary.chains.reduce((n, c) => n + c.paintCount, 0)
  const totalOverpaints = summary.chains.reduce((n, c) => n + c.overpaintCount, 0)
  const footer = totalOverpaints > 0
    ? `${totalPaints} paints · ${totalOverpaints} overpaints`
    : `${totalPaints} paints`
  lines.push(footer)
  lines.push(`https://tagwall.io`)
  return lines.join('\n')
}

interface SummarySectionProps {
  summary: SummaryPayload
  copiedId: string | null
  onCopy: (text: string, id: string) => void
}

/**
 * 7-day summary section above the per-paint list. Renders:
 *   - Cross-chain totals strip with a "Copy summary tweet" button.
 *   - One card per chain with paint count, overpaint count, unique
 *     painters, total volume, biggest paints, and a "Copy weekly
 *     tweet" button.
 *
 * Chains with zero activity in the window still render a card; that's
 * useful at launch where one chain might be quiet while another is hot.
 */
function SummarySection({ summary, copiedId, onCopy }: SummarySectionProps) {
  // Aggregate totals across chains. Volume isn't summed (different
  // native tokens; would be misleading without a USD oracle). Painter
  // uniqueness across chains isn't computable from the per-chain
  // counts alone — same wallet can paint on multiple chains, so we
  // show the per-chain max as a lower bound rather than a sum.
  const totalPaints = summary.chains.reduce((n, c) => n + c.paintCount, 0)
  const totalOverpaints = summary.chains.reduce((n, c) => n + c.overpaintCount, 0)
  const maxUniquePainters = summary.chains.reduce(
    (n, c) => Math.max(n, c.uniquePainters), 0
  )

  const crossChainText = crossChainTweet(summary)
  const isCrossChainCopied = copiedId === 'tweet:cross-chain'

  return (
    <section className="queue-summary" aria-label={`Trailing ${summary.windowDays}-day summary`}>
      <header className="queue-summary-header">
        <h2>Last {summary.windowDays} days</h2>
        <span className="queue-summary-totals">
          <strong>{totalPaints.toLocaleString()}</strong> paints across all chains
          {totalOverpaints > 0 && (
            <>
              {' · '}
              <strong>{totalOverpaints.toLocaleString()}</strong> overpaints
            </>
          )}
          {maxUniquePainters > 0 && (
            <>
              {' · '}
              <strong>≥ {maxUniquePainters.toLocaleString()}</strong> unique painters
            </>
          )}
        </span>
        <button
          type="button"
          className="share-btn"
          onClick={() => onCopy(crossChainText, 'tweet:cross-chain')}
        >
          {isCrossChainCopied ? 'Copied ✓' : 'Copy summary tweet'}
        </button>
      </header>

      <pre className="share-template-body queue-summary-tweet">{crossChainText}</pre>

      <div className="queue-summary-grid">
        {summary.chains.map((c) => (
          <ChainSummaryCard
            key={c.chainId}
            chain={c}
            windowDays={summary.windowDays}
            copiedId={copiedId}
            onCopy={onCopy}
          />
        ))}
      </div>
    </section>
  )
}

interface ChainSummaryCardProps {
  chain: ChainSummary
  windowDays: number
  copiedId: string | null
  onCopy: (text: string, id: string) => void
}

function ChainSummaryCard({ chain: c, windowDays, copiedId, onCopy }: ChainSummaryCardProps) {
  const tint = chainColorTokens(c.chainId).hex
  const isEmpty = c.paintCount === 0
  const weeklyText = chainWeeklyTweet(c, windowDays)
  const copyId = `tweet:weekly-${c.chainId}`
  const isCopied = copiedId === copyId
  return (
    <article
      className={`queue-summary-card ${isEmpty ? 'queue-summary-card-empty' : ''}`}
      style={{ borderTopColor: tint }}
    >
      <header className="queue-summary-card-head">
        <span className="queue-chain-pill" style={{ background: tint }}>
          {c.chain}
        </span>
        <span className="queue-summary-card-native">{c.native}</span>
      </header>

      <div className="queue-summary-card-stats">
        <div>
          <div className="queue-summary-card-stat-num">{c.paintCount.toLocaleString()}</div>
          <div className="queue-summary-card-stat-label">paints</div>
        </div>
        <div>
          <div className="queue-summary-card-stat-num">{c.overpaintCount.toLocaleString()}</div>
          <div className="queue-summary-card-stat-label">overpaints</div>
        </div>
        <div>
          <div className="queue-summary-card-stat-num">{c.uniquePainters.toLocaleString()}</div>
          <div className="queue-summary-card-stat-label">painters</div>
        </div>
      </div>

      <div className="queue-summary-card-volume">
        <span className="queue-summary-card-stat-label">total volume</span>
        <span className="queue-summary-card-volume-num">{c.totalVolumeFormatted}</span>
      </div>

      {isEmpty ? (
        <p className="queue-summary-card-quiet">no activity this week</p>
      ) : (
        <div className="queue-summary-card-peaks">
          {c.biggestByPixels && (
            <a className="queue-summary-card-peak" href={c.biggestByPixels.txUrl} target="_blank" rel="noopener noreferrer">
              <span className="queue-summary-card-peak-label">biggest by pixels</span>
              <span className="queue-summary-card-peak-detail">
                {c.biggestByPixels.w}×{c.biggestByPixels.h} · {c.biggestByPixels.pixels.toLocaleString()} px ·{' '}
                {c.biggestByPixels.priceFormatted}
              </span>
            </a>
          )}
          {c.biggestByPrice && c.biggestByPrice.txUrl !== c.biggestByPixels?.txUrl && (
            <a className="queue-summary-card-peak" href={c.biggestByPrice.txUrl} target="_blank" rel="noopener noreferrer">
              <span className="queue-summary-card-peak-label">biggest by price</span>
              <span className="queue-summary-card-peak-detail">
                {c.biggestByPrice.w}×{c.biggestByPrice.h} · {c.biggestByPrice.pixels.toLocaleString()} px ·{' '}
                {c.biggestByPrice.priceFormatted}
              </span>
            </a>
          )}
        </div>
      )}

      <pre className="share-template-body queue-summary-card-tweet">{weeklyText}</pre>

      <button
        type="button"
        className="share-btn share-btn-secondary"
        onClick={() => onCopy(weeklyText, copyId)}
      >
        {isCopied ? 'Copied ✓' : 'Copy weekly tweet'}
      </button>
    </article>
  )
}

export default function TweetsPage() {
  const [payload, setPayload] = useState<QueuePayload | null>(null)
  const [summary, setSummary] = useState<SummaryPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [posted, setPostedState] = useState<Set<string>>(() => loadPosted())
  const [showPosted, setShowPosted] = useState<boolean>(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Fetch /queue.json + /summary.json on mount. Cache-bust with the
  // current minute so navigation sees fresh data but two reloads inside
  // the same minute are served from cache. Summary is optional — if
  // it's missing (e.g. older deploy), the page still renders the queue.
  useEffect(() => {
    let cancelled = false
    const bust = Math.floor(Date.now() / 60_000)
    fetch(`/queue.json?t=${bust}`, { cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as QueuePayload
        if (!cancelled) setPayload(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoadError(msg)
      })
    fetch(`/summary.json?t=${bust}`, { cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) return  // missing summary is non-fatal
        const data = (await res.json()) as SummaryPayload
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        // Non-fatal; queue page renders without the summary section.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 1.5s "Copied" toast feedback, matches the SharePage pattern.
  useEffect(() => {
    if (!copiedId) return
    const t = setTimeout(() => setCopiedId(null), 1500)
    return () => clearTimeout(t)
  }, [copiedId])

  function markPosted(id: string): void {
    const next = new Set(posted)
    next.add(id)
    setPostedState(next)
    savePosted(next)
  }

  function unmarkPosted(id: string): void {
    const next = new Set(posted)
    next.delete(id)
    setPostedState(next)
    savePosted(next)
  }

  async function copy(text: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
    } catch {
      // ignore; user can long-press to copy from rendered text
    }
  }

  const { visible, hiddenCount } = useMemo(() => {
    if (!payload) return { visible: [] as QueueEntry[], hiddenCount: 0 }
    if (showPosted) return { visible: payload.entries, hiddenCount: 0 }
    const visible = payload.entries.filter((e) => !posted.has(e.id))
    return { visible, hiddenCount: payload.entries.length - visible.length }
  }, [payload, posted, showPosted])

  return (
    <div className="shell-measure share-page queue-page">
      <header className="share-page-header">
        <h1>Tweets</h1>
        <p>
          Copy-ready tweets for <code>@tagwall_io_bot</code>. Includes a cross-chain
          7-day summary, per-chain weekly recaps, and individual notable-paint
          announcements. Refreshes every 30 min via a cron job that scans all four
          EVM chains for new <code>Painted</code> events.
        </p>
        <p className="share-page-note">
          Copy a tweet, edit if you want, post it from the bot account. For per-paint
          entries you can also mark them posted; the marker lives in this browser's
          localStorage so it isn't shared across devices.
        </p>
      </header>

      {summary && (
        <SummarySection summary={summary} copiedId={copiedId} onCopy={copy} />
      )}

      <section className="queue-toolbar" aria-label="Queue controls">
        <div className="queue-toolbar-stats">
          {payload ? (
            <>
              <span>
                <strong>{visible.length}</strong> waiting
              </span>
              {hiddenCount > 0 && (
                <span className="queue-toolbar-dim"> · {hiddenCount} marked posted</span>
              )}
              <span className="queue-toolbar-dim">
                {' '}
                · updated {formatQueuedAt(payload.generatedAt)}
              </span>
            </>
          ) : loadError ? (
            <span className="share-form-status-err">
              Couldn't load /queue.json: {loadError}
            </span>
          ) : (
            <span className="queue-toolbar-dim">Loading queue…</span>
          )}
        </div>
        <label className="queue-toolbar-toggle">
          <input
            type="checkbox"
            checked={showPosted}
            onChange={(e) => setShowPosted(e.target.checked)}
          />
          Show posted
        </label>
      </section>

      {payload && visible.length === 0 && (
        <p className="queue-empty">
          {hiddenCount > 0
            ? 'Everything in the queue has been marked posted.'
            : 'No notable paints in the queue yet. Come back after the next cron tick (every 30 min).'}
        </p>
      )}

      <section className="queue-list" aria-label="Queued paints">
        {visible.map((e) => {
          const isPosted = posted.has(e.id)
          return (
            <article
              key={e.id}
              className={`share-template queue-entry ${isPosted ? 'queue-entry-posted' : ''}`}
            >
              <div className="queue-entry-meta">
                <span
                  className="queue-chain-pill"
                  style={{ background: chainColorTokens(e.chainId).hex }}
                >
                  {e.chain}
                </span>
                {e.wasOverpaint && (
                  <span
                    className="queue-overpaint-pill"
                    title="At least one pixel was painted over (price > floor × 1.05)"
                  >
                    overpaint
                  </span>
                )}
                <span>
                  {e.w}×{e.h} · {e.pixels.toLocaleString()} px · {e.priceFormatted}
                  {e.pricePerPixelFormatted && (
                    <span className="queue-entry-meta-dim">
                      {' '}({e.pricePerPixelFormatted}/px)
                    </span>
                  )}
                </span>
                <span className="queue-entry-meta-dim">
                  by {e.painterShort} · queued {formatQueuedAt(e.queuedAt)}
                </span>
              </div>

              {!isPosted && (
                <pre className="share-template-body queue-entry-tweet">{e.tweet}</pre>
              )}

              <div className="share-template-actions queue-entry-actions">
                {!isPosted && (
                  <button
                    type="button"
                    className="share-btn"
                    onClick={() => copy(e.tweet, e.id)}
                  >
                    {copiedId === e.id ? 'Copied ✓' : 'Copy tweet'}
                  </button>
                )}
                <a
                  className="share-btn share-btn-secondary"
                  href={e.pixelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View pixel
                </a>
                <a
                  className="share-btn share-btn-secondary"
                  href={e.txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Tx
                </a>
                {isPosted ? (
                  <button
                    type="button"
                    className="share-btn share-btn-secondary"
                    onClick={() => unmarkPosted(e.id)}
                  >
                    Unmark posted
                  </button>
                ) : (
                  <button
                    type="button"
                    className="share-btn share-btn-secondary"
                    onClick={() => markPosted(e.id)}
                  >
                    Mark posted
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}
