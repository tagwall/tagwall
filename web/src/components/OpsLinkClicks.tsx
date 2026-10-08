import { useEffect, useState } from 'react'

import { OPS_CHAINS } from '../hooks/useCrossChainLive'
import { SOLANA_CHAIN_LABEL } from '../solana/cluster'

/**
 * /ops "Link clicks" section. Reads GET /api/ops/clicks with the operator
 * session cookie the Worker set when this wallet signed in to /ops (see the
 * operator sign-in section of web/worker/index.js). Without a session the
 * page itself isn't served, so the only failure here is an expired one.
 */

interface LinkRow {
  chain: string
  url: string
  total: number
  last7: number
  last30: number
  firstDay: string
  lastDay: string
}

interface ClickStats {
  generatedAt: string
  since: string | null
  total: number
  last7: number
  last30: number
  daily: { day: string; clicks: number }[]
  links: LinkRow[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; stats: ClickStats }

function chainName(chain: string): string {
  if (chain === 'solana') return SOLANA_CHAIN_LABEL
  if (chain === '943') return 'PulseChain testnet'
  return OPS_CHAINS.find((c) => String(c.id) === chain)?.name ?? `Chain ${chain}`
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return u.hostname.replace(/^www\./, '') + (rest.length > 28 ? `${rest.slice(0, 27)}…` : rest)
  } catch {
    return url
  }
}

async function fetchStats(): Promise<State> {
  try {
    const res = await fetch('/api/ops/clicks', { cache: 'no-store', credentials: 'same-origin' })
    if (res.status === 401) return { kind: 'error', message: 'Your sign-in has expired. Reload the page to sign in again.' }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      return { kind: 'error', message: body?.error ?? `The click endpoint answered ${res.status}.` }
    }
    return { kind: 'ok', stats: (await res.json()) as ClickStats }
  } catch {
    return { kind: 'error', message: "Couldn't reach /api/ops/clicks." }
  }
}

export function OpsLinkClicks() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  // A refresh counter so the Refresh button can re-run the effect.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    void fetchStats().then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [nonce])

  function refresh() {
    setState({ kind: 'loading' })
    setNonce((n) => n + 1)
  }

  return (
    <section className="ops-section" aria-label="Link clicks">
      <header className="ops-section-head">
        <h2>Link clicks · private</h2>
        <span className="ops-section-sub">
          confirmed "Proceed" clicks on painted links, per day, nothing about the viewer
        </span>
      </header>

      {state.kind === 'error' ? (
        <p className="ops-trend-empty">{state.message}</p>
      ) : state.kind === 'loading' ? (
        <p className="ops-trend-empty">Loading click counts…</p>
      ) : (
        <>
          <div className="ops-kpis">
            <div className="ops-kpi">
              <div className="ops-kpi-value">{state.stats.last7.toLocaleString()}</div>
              <div className="ops-kpi-label">clicks, last 7 days</div>
            </div>
            <div className="ops-kpi">
              <div className="ops-kpi-value">{state.stats.last30.toLocaleString()}</div>
              <div className="ops-kpi-label">clicks, last 30 days</div>
            </div>
            <div className="ops-kpi">
              <div className="ops-kpi-value">{state.stats.total.toLocaleString()}</div>
              <div className="ops-kpi-label">clicks, all time</div>
              <div className="ops-kpi-sub">
                {state.stats.since ? `counting since ${state.stats.since}` : 'no clicks counted yet'}
              </div>
            </div>
          </div>

          {state.stats.links.length > 0 ? (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th className="ops-th ops-th-left">Link</th>
                    <th className="ops-th ops-th-left">Chain</th>
                    <th className="ops-th ops-th-right">7d</th>
                    <th className="ops-th ops-th-right">30d</th>
                    <th className="ops-th ops-th-right">All time</th>
                    <th className="ops-th ops-th-right">Last click</th>
                  </tr>
                </thead>
                <tbody>
                  {state.stats.links.map((r) => (
                    <tr key={`${r.chain}|${r.url}`}>
                      <td className="ops-td-chain" title={r.url}>
                        {shortUrl(r.url)}
                      </td>
                      <td className="ops-td-chain">{chainName(r.chain)}</td>
                      <td className="ops-td-num">{r.last7.toLocaleString()}</td>
                      <td className="ops-td-num">{r.last30.toLocaleString()}</td>
                      <td className="ops-td-num">{r.total.toLocaleString()}</td>
                      <td className="ops-td-num">{r.lastDay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ops-trend-empty">No clicks counted yet.</p>
          )}

          <p className="ops-table-foot">
            Counts aren't verified against the chain, so a script can inflate them. Treat
            them as a signal of which tags get clicked, not as an audited figure.{' '}
            <button type="button" className="link-btn" onClick={refresh}>
              Refresh
            </button>
          </p>
        </>
      )}
    </section>
  )
}
