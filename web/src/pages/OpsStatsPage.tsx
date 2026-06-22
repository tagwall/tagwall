import { useEffect, useMemo, useState } from 'react'
import { SOLANA_CHAIN_LABEL } from '../solana/cluster'
import { formatEther } from 'viem'

import { chainColorTokens } from '../lib/chainColor'
import { GENESIS_CAP, FOUNDER_CAP } from '../lib/founders'
import { OPS_CHAINS, useCrossChainLive, type ChainLive } from '../hooks/useCrossChainLive'
import { useSolanaCanvas } from '../hooks/useSolanaCanvas'
import { useAllChainsCoverage, type ChainCoverage } from '../hooks/useAllChainsCoverage'
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
 *   4. useAllChainsCoverage(): all-time canvas coverage for EVERY chain,
 *      computed client-side by scanning each chain's Painted log. This is
 *      the expensive metric (one eth_call can't return distinct pixels), so
 *      it lives only on this operator page, runs once per session, and each
 *      chain fails soft to an offline row. See the hook for the rationale.
 *
 * The 7-day trend stands in for cross-chain momentum.
 */

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

interface KpiProps {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'mid' | 'warn'
  title?: string
}

function SolanaOpsCards() {
  const { config, paintedPixels, vaultLamports, isLoading } = useSolanaCanvas()
  const sol = (lamports: bigint) => {
    const n = Number(lamports) / 1e9
    return n !== 0 && n < 0.001 ? n.toPrecision(2) : n.toFixed(3)
  }
  return (
    <section className="ops-section" aria-label="Solana">
      <header className="ops-section-head">
        <h2>{SOLANA_CHAIN_LABEL}</h2>
        <span className="ops-section-sub">
          live program reads (pre-mainnet test surface)
        </span>
      </header>
      <div className="ops-kpis">
        <Kpi
          label="stamps"
          value={config ? config.stampCount.toString() : isLoading ? '…' : '—'}
          sub="all-time paints"
        />
        <Kpi
          label="painted px"
          value={config ? paintedPixels.toLocaleString() : '—'}
          sub="live tile scan"
        />
        <Kpi
          label="floor"
          value={config ? `${sol(config.startingPrice)} SOL` : '—'}
          sub="per pixel"
        />
        <Kpi
          label="rent vault"
          value={config ? `${sol(vaultLamports)} SOL` : '—'}
          sub="tile-init reimbursements"
        />
      </div>
    </section>
  )
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

  const coverage = useAllChainsCoverage()

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

  // Treasury EOA tripwire: the treasury must never carry code (a 7702
  // delegation that reverts or runs past Canvas's 50k gas budget would
  // burn the 95% slice of every paint to 0xdEaD). See useCrossChainLive.
  const treasuryCodeChains = live.chains.filter((c) => c.treasuryHasCode === true)

  const founderBoard = summary?.founders ?? []

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

      {treasuryCodeChains.length > 0 && (
        <section
          role="alert"
          style={{
            border: '2px solid #ff5050',
            borderRadius: 8,
            padding: '12px 16px',
            margin: '0 0 16px',
            background: 'rgba(255, 80, 80, 0.08)',
          }}
        >
          <strong>URGENT: treasury address has contract code on{' '}
            {treasuryCodeChains.map((c) => c.name).join(', ')}.</strong>{' '}
          The treasury must stay a plain EOA. With code present (e.g. an EIP-7702
          smart-account delegation), a receive() that reverts or exceeds the
          contract's 50k gas budget makes Canvas burn the 95% treasury slice of
          every paint to 0xdEaD, permanently. Remove the delegation from the
          treasury wallet now and watch for TreasurySendFailed alerts in the
          tweets-bot queue.
        </section>
      )}

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

      {/* Solana (devnet) live reads. Separate from the EVM table:
          different units (SOL/lamports), different read path (tile
          accounts + program events), and devnet state besides. Becomes
          a real table row when mainnet-beta ships. */}
      <SolanaOpsCards />

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

      {/* Canvas coverage for EVERY chain, scanned client-side on this
          operator page (one Painted-log walk per chain, cached for the
          session). Each chain fails soft to an "offline" row. */}
      <section className="ops-section" aria-label="Canvas coverage">
        <header className="ops-section-head">
          <h2>Canvas coverage · all chains</h2>
          <span className="ops-section-sub">
            {coverage.isLoading
              ? 'scanning every chain…'
              : `${(coverage.totalCovered ?? 0).toLocaleString()} pixels painted across chains · exact, client-side`}
          </span>
        </header>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th className="ops-th ops-th-left">Chain</th>
                <th className="ops-th ops-th-right">Coverage</th>
                <th className="ops-th ops-th-right">Pixels painted</th>
                <th className="ops-th ops-th-right">Overwritten ≥ once</th>
                <th className="ops-th ops-th-right">Stamps</th>
              </tr>
            </thead>
            <tbody>
              {coverage.chains.length === 0 && coverage.isLoading ? (
                <tr>
                  <td className="ops-td-chain" colSpan={5}>
                    Scanning each chain's paint history…
                  </td>
                </tr>
              ) : (
                coverage.chains.map((c) => <CoverageRow key={c.chainId} row={c} />)
              )}
            </tbody>
          </table>
        </div>
        <p className="ops-table-foot">
          Coverage is the share of the 1,000,000-pixel wall touched at least once.
          Overwrite counts pixels painted two or more times (the PRD's "overwritten at
          least once" co-primary metric). Figures are raw on-chain geometry, unfiltered.
        </p>
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

/** One chain's coverage row in the all-chains coverage table. */
function CoverageRow({ row }: { row: ChainCoverage }) {
  const tint = chainColorTokens(row.chainId).hex
  const pct = row.coveragePct
  const pctText = !row.ok
    ? '—'
    : row.exact
      ? `${pct.toFixed(pct < 1 ? 3 : 1)}%`
      : `~${pct.toFixed(1)}%`
  return (
    <tr className={row.ok ? '' : 'ops-row-down'}>
      <td className="ops-td-chain">
        <span className="ops-chain-dot" style={{ background: tint }} />
        {row.name}
        {!row.ok && (
          <span className="ops-chain-down" title="RPC didn't respond">
            offline
          </span>
        )}
      </td>
      <td className="ops-td-num" title={row.exact ? '' : 'stamp area too large to grid exactly; upper bound'}>
        {pctText}
      </td>
      <td className="ops-td-num">{row.ok ? row.covered.toLocaleString() : '—'}</td>
      <td className="ops-td-num">{row.ok ? row.overwritten.toLocaleString() : '—'}</td>
      <td className="ops-td-num">{row.ok ? row.stamps.toLocaleString() : '—'}</td>
    </tr>
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
