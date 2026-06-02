import { useEffect, useMemo, useState } from 'react'
import { formatEther } from 'viem'

import { chainColorTokens } from '../lib/chainColor'
import { useViewerChainId } from '../lib/viewerChain'
import { usePaintedRegions } from '../hooks/usePaintedRegions'
import { GENESIS_CAP, FOUNDER_CAP } from '../lib/founders'
import { OPS_CHAINS, useCrossChainLive, type ChainLive } from '../hooks/useCrossChainLive'
import { ReferrersLeaderboard } from '../components/ReferrersLeaderboard'

/**
 * /ops: operator cross-chain stats dashboard.
 *
 * Public route, intentionally unlinked from nav (same posture as /tweets):
 * everything here is derived from public chain state or the tweets bot's
 * already-public JSON, so there's nothing private to gate, but it's an
 * operator tool so it stays known-by-URL.
 *
 * Three data sources, each chosen so the page is cheap on page load:
 *
 *   1. useCrossChainLive(): one eth_call per value across all 5 mainnets
 *      for the LIVE all-time figures (stampCount, per-pixel floor, treasury
 *      address + balance). No log scans, so the fan-out is safe on load.
 *   2. /summary.json (tweets bot, every 30 min): the WINDOWED metrics that
 *      need a full log scan, namely 7-day unique painters, Gini
 *      concentration, overpaint counts, and the daily-activity trend
 *      series. The bot does the scan server-side; the browser reads the
 *      rollup.
 *   3. summary.founders[] (tweets bot): per-chain Genesis/Founder fill for
 *      EVERY chain, so the operator sees founder scarcity on one page
 *      without switching wallets. The bot already tracks distinct painters
 *      incrementally (founders_state.json) for the scarcity tweets, so this
 *      rollup is free; a chain still cold-scanning is flagged "scanning".
 *   4. usePaintedRegions(): VIEWER-CHAIN-ONLY canvas coverage, computed
 *      client-side for free because the regions are already loaded for the
 *      canvas on that chain.
 *
 * The one metric deliberately NOT cross-chain is all-time coverage. That
 * needs a full multi-chain log scan the browser shouldn't do on load, and
 * the founders scanner caps at 1000 painters without geometry. Coverage is
 * shown live for the viewer's chain only; the 7-day trend stands in for
 * cross-chain momentum.
 */

const WALL_W = 1250
const WALL_H = 800
const TOTAL_PIXELS = WALL_W * WALL_H

/** Daily-activity point as written by the bot's rollup. */
interface DailyPoint {
  date: string
  paints: number
}

interface AllChainsRollup {
  chainCount: number
  totalPaints: number
  totalOverpaints: number
  uniquePainters: number
  weeklyActivePainters: number
  gini: number
  dailyActivity: DailyPoint[]
}

interface ChainSummary {
  chain: string
  chainId: number
  native: string
  paintCount: number
  overpaintCount: number
  uniquePainters: number
  uniqueReferrers?: number
  totalVolumeFormatted: string
  gini?: number
  dailyActivity?: DailyPoint[]
}

/**
 * Per-chain founder fill, as emitted by the bot's build_founders_rollup.
 * Field names mirror compute_founder_stats / founderStatsFromCount exactly,
 * so the board, the tweets, and the on-canvas badge can never disagree.
 * `caughtUp` is false while a cold backfill is still walking history (the
 * count is a lower bound until it flips true), which the board surfaces as
 * a "scanning" tag rather than implying a final figure.
 */
interface FounderRollupEntry {
  chainId: number
  chain: string
  native: string
  caughtUp: boolean
  claimed: number
  genesisClaimed: number
  founderClaimed: number
  genesisLeft: number
  founderLeft: number
  totalLeft: number
}

interface SummaryPayload {
  generatedAt: string
  windowDays: number
  allChains?: AllChainsRollup
  founders?: FounderRollupEntry[]
  chains: ChainSummary[]
}

/**
 * Format a wei amount in native units for an operator reading the table.
 * Picks a sensible precision by magnitude (big balances round to whole
 * tokens, sub-1 amounts keep enough digits to read a floor price). Number
 * precision loss on huge PLS balances is fine: this is a display proxy,
 * not accounting.
 */
function fmtNative(wei: bigint | null, native: string): string {
  if (wei === null) return '—'
  const n = Number(formatEther(wei))
  if (n === 0) return `0 ${native}`
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 6
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits })} ${native}`
}

/**
 * Plain-English read on the unique-painter Gini coefficient. High Gini means
 * a few wallets drove most paints (vanity / whale-driven); low means broad
 * participation, which is the north-star the PRD optimises for.
 */
function giniLabel(g: number): { word: string; tone: 'good' | 'mid' | 'warn' } {
  if (g <= 0.4) return { word: 'broad', tone: 'good' }
  if (g <= 0.6) return { word: 'healthy', tone: 'good' }
  if (g <= 0.8) return { word: 'concentrated', tone: 'mid' }
  return { word: 'whale-driven', tone: 'warn' }
}

/** Merged per-chain row: live on-chain figures + windowed bot figures. */
interface OpsRow {
  chainId: number
  name: string
  native: string
  ok: boolean
  stampCount: bigint | null
  startingPrice: bigint | null
  treasuryBalance: bigint | null
  // windowed (may be absent if summary.json is stale / missing)
  w7paints: number | null
  w7overpaints: number | null
  w7painters: number | null
  gini: number | null
}

type SortKey =
  | 'name'
  | 'stampCount'
  | 'startingPrice'
  | 'treasuryBalance'
  | 'w7paints'
  | 'w7overpaints'
  | 'w7painters'
  | 'gini'

function compareRows(a: OpsRow, b: OpsRow, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name)
    case 'stampCount':
    case 'startingPrice':
    case 'treasuryBalance': {
      const av = a[key]
      const bv = b[key]
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return av < bv ? -1 : av > bv ? 1 : 0
    }
    default: {
      const av = a[key]
      const bv = b[key]
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return av - bv
    }
  }
}

/**
 * Viewer-chain coverage, computed from the regions already loaded for the
 * canvas. Walks each stamp's cells into a Map<cell, paintCount> so we can
 * report both unique covered pixels and pixels painted 2+ times (the PRD's
 * "overwritten at least once" co-primary metric).
 *
 * Guarded by a cell budget: if the summed stamp area is implausibly large
 * (a chain with millions of painted cells), we bail rather than allocate a
 * huge Map, and the UI falls back to the cheap summed figure. At launch
 * stage this guard never trips.
 */
function useViewerCoverage() {
  const { data: regions } = usePaintedRegions()
  return useMemo(() => {
    if (!regions || regions.length === 0) {
      return { covered: 0, overwritten: 0, stamps: 0, exact: true }
    }
    const budget = 400_000
    let area = 0
    for (const r of regions) area += r.w * r.h
    if (area > budget) {
      // Too large to grid exactly; report the summed area as an upper bound.
      return { covered: area, overwritten: 0, stamps: regions.length, exact: false }
    }
    const cells = new Map<number, number>()
    for (const r of regions) {
      for (let dy = 0; dy < r.h; dy++) {
        const row = (r.y + dy) * WALL_W
        for (let dx = 0; dx < r.w; dx++) {
          const key = row + (r.x + dx)
          cells.set(key, (cells.get(key) ?? 0) + 1)
        }
      }
    }
    let overwritten = 0
    for (const count of cells.values()) if (count >= 2) overwritten++
    return { covered: cells.size, overwritten, stamps: regions.length, exact: true }
  }, [regions])
}

interface KpiProps {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'mid' | 'warn'
  title?: string
}

function Kpi({ label, value, sub, tone, title }: KpiProps) {
  return (
    <div className={`ops-kpi ${tone ? `ops-kpi-${tone}` : ''}`} title={title}>
      <div className="ops-kpi-value">{value}</div>
      <div className="ops-kpi-label">{label}</div>
      {sub && <div className="ops-kpi-sub">{sub}</div>}
    </div>
  )
}

/**
 * Inline SVG bar chart of cross-chain paints per day over the summary
 * window. Pure presentational, no chart lib: 7-ish bars, brand lime, with
 * the busiest day labelled. Empty/flat windows still render a baseline so
 * the operator can see "yes the trend pipe is wired, it's just quiet".
 */
function TrendChart({ series }: { series: DailyPoint[] }) {
  if (series.length === 0) {
    return <p className="ops-trend-empty">No daily activity in the window yet.</p>
  }
  const W = 640
  const H = 140
  const padB = 22
  const max = Math.max(1, ...series.map((d) => d.paints))
  const n = series.length
  const gap = 6
  const barW = (W - gap * (n - 1)) / n
  const peak = series.reduce((m, d) => (d.paints > m.paints ? d : m), series[0])

  return (
    <svg
      className="ops-trend-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Paints per day over the last ${n} days, peak ${peak.paints} on ${peak.date}`}
      preserveAspectRatio="none"
    >
      {series.map((d, i) => {
        const h = Math.round(((H - padB) * d.paints) / max)
        const x = i * (barW + gap)
        const y = H - padB - h
        const isPeak = d === peak && d.paints > 0
        const dayNum = d.date.slice(8)
        return (
          <g key={d.date}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, d.paints > 0 ? 2 : 0)}
              rx={2}
              fill={isPeak ? '#A8FF2E' : '#3a7a14'}
            >
              <title>{`${d.date}: ${d.paints} paint${d.paints === 1 ? '' : 's'}`}</title>
            </rect>
            <text x={x + barW / 2} y={H - 6} className="ops-trend-axis" textAnchor="middle">
              {dayNum}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function OpsStatsPage() {
  const live = useCrossChainLive()
  const [summary, setSummary] = useState<SummaryPayload | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('stampCount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const viewerChainId = useViewerChainId()
  const coverage = useViewerCoverage()
  const viewerChain = OPS_CHAINS.find((c) => c.id === viewerChainId)

  // Fetch /summary.json on mount (cache-bust to the minute, matching the
  // bot cadence and the other pages). Missing/stale summary is non-fatal:
  // the live on-chain figures still render.
  useEffect(() => {
    let cancelled = false
    const bust = Math.floor(Date.now() / 60_000)
    fetch(`/summary.json?t=${bust}`, { cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as SummaryPayload
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        // Non-fatal; page renders from live reads only.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const summaryByChain = useMemo(() => {
    const m = new Map<number, ChainSummary>()
    for (const c of summary?.chains ?? []) m.set(c.chainId, c)
    return m
  }, [summary])

  const liveByChain = useMemo(() => {
    const m = new Map<number, ChainLive>()
    for (const c of live.chains) m.set(c.chainId, c)
    return m
  }, [live.chains])

  const rows = useMemo<OpsRow[]>(() => {
    const base = OPS_CHAINS.map((c): OpsRow => {
      const l = liveByChain.get(c.id)
      const s = summaryByChain.get(c.id)
      return {
        chainId: c.id,
        name: c.name,
        native: c.native,
        ok: l?.ok ?? false,
        stampCount: l?.stampCount ?? null,
        startingPrice: l?.startingPrice ?? null,
        treasuryBalance: l?.treasuryBalance ?? null,
        w7paints: s?.paintCount ?? null,
        w7overpaints: s?.overpaintCount ?? null,
        w7painters: s?.uniquePainters ?? null,
        gini: s?.gini ?? null,
      }
    })
    const sorted = [...base].sort((a, b) => compareRows(a, b, sortKey))
    return sortDir === 'asc' ? sorted : sorted.reverse()
  }, [liveByChain, summaryByChain, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Names read best ascending; numbers default to biggest-first.
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const roll = summary?.allChains
  const okCount = live.chains.filter((c) => c.ok).length
  const gLabel = roll ? giniLabel(roll.gini) : null

  const founderBoard = summary?.founders ?? []
  const coveragePct = (coverage.covered / TOTAL_PIXELS) * 100

  return (
    <div className="shell-measure share-page ops-page">
      <header className="share-page-header">
        <h1>Operator stats</h1>
        <p>
          Cross-chain health at a glance. Live all-time figures are read straight from
          each chain's contract (one call per value, no scans). The 7-day windowed
          metrics, painter concentration, and the trend below come from the tweets bot's{' '}
          <code>summary.json</code>, refreshed every 30 min. Coverage is live for the
          chain you're viewing.
        </p>
        <p className="share-page-note">
          Public route, unlinked from nav. Everything here is derivable from public
          chain state, so there's nothing to gate, but it's an operator tool.
        </p>
      </header>

      {/* KPI strip: live all-time totals + windowed health. */}
      <section className="ops-kpis" aria-label="Headline metrics">
        <Kpi
          label="paints all-time"
          value={live.totalPaints !== null ? live.totalPaints.toLocaleString() : '—'}
          sub="across all chains, live"
          title="Sum of stampCount() across every chain that responded"
        />
        <Kpi
          label="chains live"
          value={`${okCount}/${OPS_CHAINS.length}`}
          sub={okCount === OPS_CHAINS.length ? 'all responding' : 'some RPCs flaky'}
          tone={okCount === OPS_CHAINS.length ? 'good' : 'mid'}
        />
        <Kpi
          label={`active painters · ${summary?.windowDays ?? 7}d`}
          value={roll ? roll.weeklyActivePainters.toLocaleString() : '—'}
          sub="unique wallets, all chains"
          title="Distinct painter wallets across all chains in the window (true union, deduped)"
        />
        <Kpi
          label="painter concentration"
          value={roll ? roll.gini.toFixed(2) : '—'}
          sub={gLabel ? `Gini · ${gLabel.word}` : 'Gini coefficient'}
          tone={gLabel?.tone}
          title="Unique-painter Gini over the window. 0 = everyone painted equally, 1 = one wallet did everything. Lower is healthier."
        />
      </section>

      {/* Cross-chain daily trend (the operator-chosen trend chart). */}
      <section className="ops-section ops-trend" aria-label="Daily activity trend">
        <header className="ops-section-head">
          <h2>Daily activity · last {summary?.windowDays ?? 7} days</h2>
          <span className="ops-section-sub">
            {roll
              ? `${roll.totalPaints.toLocaleString()} paints · ${roll.totalOverpaints.toLocaleString()} overpaints in window`
              : 'waiting on summary.json'}
          </span>
        </header>
        <TrendChart series={roll?.dailyActivity ?? []} />
      </section>

      {/* Per-chain comparison table (sortable). */}
      <section className="ops-section" aria-label="Per-chain comparison">
        <header className="ops-section-head">
          <h2>Per-chain comparison</h2>
          <span className="ops-section-sub">
            live figures · 7-day columns from the bot · click a header to sort
          </span>
        </header>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <SortableTh label="Chain" col="name" {...{ sortKey, sortDir, toggleSort }} align="left" />
                <SortableTh label="Paints (all-time)" col="stampCount" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Floor / px" col="startingPrice" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Treasury" col="treasuryBalance" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Paints 7d" col="w7paints" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Overpaints 7d" col="w7overpaints" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Painters 7d" col="w7painters" {...{ sortKey, sortDir, toggleSort }} />
                <SortableTh label="Gini 7d" col="gini" {...{ sortKey, sortDir, toggleSort }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tint = chainColorTokens(r.chainId).hex
                return (
                  <tr key={r.chainId} className={r.ok ? '' : 'ops-row-down'}>
                    <td className="ops-td-chain">
                      <span className="ops-chain-dot" style={{ background: tint }} />
                      {r.name}
                      {!r.ok && <span className="ops-chain-down" title="RPC didn't respond">offline</span>}
                    </td>
                    <td className="ops-td-num">
                      {r.stampCount !== null ? r.stampCount.toLocaleString() : '—'}
                    </td>
                    <td className="ops-td-num">{fmtNative(r.startingPrice, r.native)}</td>
                    <td className="ops-td-num">{fmtNative(r.treasuryBalance, r.native)}</td>
                    <td className="ops-td-num">
                      {r.w7paints !== null ? r.w7paints.toLocaleString() : '—'}
                    </td>
                    <td className="ops-td-num">
                      {r.w7overpaints !== null ? r.w7overpaints.toLocaleString() : '—'}
                    </td>
                    <td className="ops-td-num">
                      {r.w7painters !== null ? r.w7painters.toLocaleString() : '—'}
                    </td>
                    <td className="ops-td-num">{r.gini !== null ? r.gini.toFixed(2) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="ops-table-foot">
          Floor and treasury are in each chain's native token, so they aren't summed.
          Treasury balance is a proxy for cumulative net revenue (95% of every paint),
          minus whatever's been spent on ops.
        </p>
      </section>

      {/* Founder scarcity across EVERY chain on one page, from the bot's
          per-chain rollup (no wallet switching). Counts are exact; a chain
          still cold-scanning history shows a "scanning" tag. */}
      <section className="ops-section ops-founders" aria-label="Founder scarcity">
        <header className="ops-section-head">
          <h2>Founder scarcity · all chains</h2>
          <span className="ops-section-sub">
            Genesis = first {GENESIS_CAP} painters · Founder = first {FOUNDER_CAP} · from the bot, every 30 min
          </span>
        </header>
        {founderBoard.length > 0 ? (
          <div className="ops-founder-board">
            {founderBoard.map((f) => (
              <ChainFounderRow key={f.chainId} entry={f} />
            ))}
          </div>
        ) : (
          <p className="ops-trend-empty">Waiting on summary.json for founder counts.</p>
        )}
      </section>

      {/* Canvas coverage stays viewer-chain-only: an exact cross-chain
          figure needs a full multi-chain log scan the browser shouldn't run
          on load, so this reflects the chain you're connected to. */}
      <section className="ops-section ops-founders" aria-label="Canvas coverage">
        <header className="ops-section-head">
          <h2>Canvas coverage</h2>
          <span className="ops-section-sub">
            live for {viewerChain?.name ?? 'your chain'} only · exact, client-side
          </span>
        </header>
        <div className="ops-coverage">
          <div className="ops-coverage-stat">
            <span className="ops-coverage-num">
              {coverage.exact ? `${coveragePct.toFixed(coveragePct < 1 ? 3 : 1)}%` : '—'}
            </span>
            <span className="ops-coverage-label">
              canvas coverage{coverage.exact ? '' : ' (too large to grid)'}
            </span>
          </div>
          <div className="ops-coverage-stat">
            <span className="ops-coverage-num">{coverage.covered.toLocaleString()}</span>
            <span className="ops-coverage-label">pixels painted</span>
          </div>
          <div className="ops-coverage-stat">
            <span className="ops-coverage-num">{coverage.overwritten.toLocaleString()}</span>
            <span className="ops-coverage-label">overwritten ≥ once</span>
          </div>
          <div className="ops-coverage-stat">
            <span className="ops-coverage-num">{coverage.stamps.toLocaleString()}</span>
            <span className="ops-coverage-label">stamps</span>
          </div>
        </div>
      </section>

      {/* Reuse the cross-chain referrer board verbatim. */}
      <section className="ops-section" aria-label="Top referrers">
        <ReferrersLeaderboard />
      </section>
    </div>
  )
}

interface SortableThProps {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  toggleSort: (key: SortKey) => void
  align?: 'left' | 'right'
}

function SortableTh({ label, col, sortKey, sortDir, toggleSort, align = 'right' }: SortableThProps) {
  const active = sortKey === col
  return (
    <th
      className={`ops-th ops-th-${align} ${active ? 'ops-th-active' : ''}`}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="ops-th-btn" onClick={() => toggleSort(col)}>
        {label}
        <span className="ops-th-caret">{active ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  )
}

/**
 * One chain's founder fill: a single 0..FOUNDER_CAP bar with the Genesis
 * threshold marked, plus "N Genesis left / N Founder spots left" footnotes.
 * Drawn from the bot rollup so every chain renders without a wallet switch.
 */
function ChainFounderRow({ entry }: { entry: FounderRollupEntry }) {
  const tint = chainColorTokens(entry.chainId).hex
  const pct = Math.min((entry.claimed / FOUNDER_CAP) * 100, 100)
  // Genesis cap as a fraction of the founder window, for the marker line.
  const genesisMark = (GENESIS_CAP / FOUNDER_CAP) * 100
  const genesisFull = entry.genesisLeft === 0
  const founderFull = entry.totalLeft === 0
  return (
    <div className="ops-founder-row">
      <div className="ops-founder-row-head">
        <span className="ops-founder-row-name">
          <span className="ops-chain-dot" style={{ background: tint }} />
          {entry.chain}
          {!entry.caughtUp && (
            <span className="ops-chain-down" title="cold backfill still walking history; count is a lower bound">
              scanning
            </span>
          )}
        </span>
        <span className="ops-founder-row-count">
          {entry.claimed.toLocaleString()} / {FOUNDER_CAP.toLocaleString()}
        </span>
      </div>
      <div className="ops-founder-bar-track">
        <div className="ops-founder-bar-fill" style={{ width: `${pct}%`, background: tint }} />
        {!founderFull && (
          <span
            className="ops-founder-genesis-mark"
            style={{ left: `${genesisMark}%` }}
            title={`Genesis cap (${GENESIS_CAP})`}
          />
        )}
      </div>
      <div className="ops-founder-row-foot">
        <span className={genesisFull ? 'ops-founder-foot-full' : ''}>
          {genesisFull ? 'Genesis full' : `${entry.genesisLeft.toLocaleString()} Genesis left`}
        </span>
        <span className={founderFull ? 'ops-founder-foot-full' : ''}>
          {founderFull
            ? 'Founder window closed'
            : `${entry.totalLeft.toLocaleString()} Founder spots left`}
        </span>
      </div>
    </div>
  )
}
