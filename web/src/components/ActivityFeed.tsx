import { useMemo, useState } from 'react'
import { formatEther } from 'viem'
import { useChainId, useReadContracts } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import type { PaintedRegion } from '../hooks/usePaintedRegions'

interface Props {
  regions: readonly PaintedRegion[] | undefined
  isLoading: boolean
  /** Native-wei per-pixel floor price, used to estimate effective multiplier. */
  startingPrice: bigint | null
  /** Active-chain native ticker ("PLS", "ETH", etc.). */
  nativeSymbol?: string
  /** Block timestamps keyed by block number, if available. Used to render
   *  "time since paint". Passed in so the lookup can be shared across
   *  Leaderboard / ActivityFeed. Optional, we fall back to block number
   *  when missing. */
  blockTimestamps?: Map<bigint, number>
  /** Outbound-link gate. Required: every link click in the feed routes
   *  through the parent's OutboundLinkModal so users get a click-through
   *  interstitial (PRD §6) and a defense-in-depth scheme check. */
  onRequestOutbound: (url: string) => void
}

type SortKey = 'time' | 'painter' | 'region' | 'size' | 'price' | 'multiplier'
type SortDir = 'asc' | 'desc'

function shortenAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** Magnitude-aware native amount formatter for the price column.
 *  Adds thousand-separator commas above 1k so PLS-scale numbers
 *  read as 6,700 / 13,400 instead of running together. Mirrors the
 *  formatter in Leaderboard + PaintControls so all three displays
 *  agree on style. Centralise into lib/format.ts when a fourth caller
 *  appears. */
function formatActivityPrice(wei: bigint): string {
  const num = Number(formatEther(wei))
  if (!Number.isFinite(num) || num === 0) return '0'
  if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (num >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (num >= 0.001) return num.toFixed(4)
  if (num >= 0.000001) return num.toFixed(6)
  return num.toExponential(2)
}

function effectiveMultiplier(r: PaintedRegion, startingPrice: bigint | null): number | null {
  if (!startingPrice || startingPrice === 0n || r.pixelsPainted === 0) return null
  const baseline = BigInt(r.pixelsPainted) * startingPrice
  if (baseline === 0n) return null
  const x1000 = (r.pricePaid * 1_000n) / baseline
  return Number(x1000) / 1000
}

function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/**
 * Fetch link URLs for any region with linkId > 0. Batched via multicall so
 * the feed doesn't fire one RPC per row.
 */
function useLinkUrls(linkIds: number[]): Map<number, string> {
  const unique = useMemo(() => Array.from(new Set(linkIds.filter((n) => n > 0))), [linkIds])
  const address = canvasAddress(useChainId())
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: unique.map((id) => ({
      address,
      abi: canvasAbi,
      functionName: 'links' as const,
      args: [id],
    })),
    query: { enabled: unique.length > 0, staleTime: 60_000 },
  })
  return useMemo(() => {
    const out = new Map<number, string>()
    unique.forEach((id, i) => {
      const r = data?.[i]
      if (r && r.status === 'success' && typeof r.result === 'string' && r.result) {
        out.set(id, r.result)
      }
    })
    return out
  }, [unique, data])
}

/**
 * Recent Painted events rendered as a sortable, filterable table. Modelled
 * on DexScreener's trade feeds: column headers are clickable to sort, and
 * a top-of-table search box filters by painter address or linked URL.
 * Live refresh (new paints appearing at the top) is wired globally via
 * `useLivePaintedRefresh` invalidating the query, which propagates here
 * through TanStack Query.
 */
export function ActivityFeed({
  regions,
  isLoading,
  startingPrice,
  nativeSymbol = 'native',
  blockTimestamps,
  onRequestOutbound,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('time')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filter, setFilter] = useState('')

  const linkUrls = useLinkUrls(regions?.map((r) => r.linkId) ?? [])

  const nowSec = Math.floor(Date.now() / 1000)

  const rows = useMemo(() => {
    if (!regions) return []
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? regions.filter((r) => {
          if (r.painter.toLowerCase().includes(q)) return true
          const url = r.linkId > 0 ? linkUrls.get(r.linkId)?.toLowerCase() : undefined
          if (url && url.includes(q)) return true
          return false
        })
      : regions
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'time':
          // Chain order: (blockNumber, logIndex). Equivalent to timestamp order.
          if (a.blockNumber !== b.blockNumber) cmp = a.blockNumber < b.blockNumber ? -1 : 1
          else cmp = a.logIndex - b.logIndex
          break
        case 'painter':
          cmp = a.painter.toLowerCase().localeCompare(b.painter.toLowerCase())
          break
        case 'region':
          // Sort by (x, y) — pure positional ordering. Size moved to
          // its own column / sort key.
          cmp = a.x - b.x
          if (cmp === 0) cmp = a.y - b.y
          break
        case 'size':
          // Sort by stamp pixel area (w*h, equivalent to pixelsPainted).
          cmp = a.pixelsPainted - b.pixelsPainted
          if (cmp === 0) cmp = a.w - b.w
          break
        case 'price':
          cmp = a.pricePaid < b.pricePaid ? -1 : a.pricePaid > b.pricePaid ? 1 : 0
          break
        case 'multiplier': {
          const ma = effectiveMultiplier(a, startingPrice) ?? 0
          const mb = effectiveMultiplier(b, startingPrice) ?? 0
          cmp = ma < mb ? -1 : ma > mb ? 1 : 0
          break
        }
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted.slice(0, 50)
  }, [regions, filter, sortKey, sortDir, startingPrice, linkUrls])

  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'time' ? 'desc' : 'desc')
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  return (
    <section className="activity-feed">
      <header className="activity-feed-header">
        <h3>Activity</h3>
        <div className="activity-feed-tools">
          <input
            type="search"
            className="activity-filter"
            placeholder="Filter painter or URL…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="activity-count">
            {regions ? `${regions.length} tag${regions.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      </header>

      {isLoading && !regions && <p className="pixel-placeholder">Loading tags…</p>}
      {regions && regions.length === 0 && (
        <p className="pixel-placeholder">No tags on this chain yet. Be first.</p>
      )}

      {rows.length > 0 && (
        <div className="activity-table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <SortableTh label="Time" active={sortKey === 'time'} dir={sortDir} onClick={() => onSort('time')}>{sortIndicator('time')}</SortableTh>
                <SortableTh label="Region" active={sortKey === 'region'} dir={sortDir} onClick={() => onSort('region')}>{sortIndicator('region')}</SortableTh>
                <SortableTh label="Size" active={sortKey === 'size'} dir={sortDir} onClick={() => onSort('size')}>{sortIndicator('size')}</SortableTh>
                <SortableTh label="Painter" active={sortKey === 'painter'} dir={sortDir} onClick={() => onSort('painter')}>{sortIndicator('painter')}</SortableTh>
                <SortableTh label="Price" active={sortKey === 'price'} dir={sortDir} onClick={() => onSort('price')} align="right">{sortIndicator('price')}</SortableTh>
                <SortableTh label="× floor" active={sortKey === 'multiplier'} dir={sortDir} onClick={() => onSort('multiplier')} align="right">{sortIndicator('multiplier')}</SortableTh>
                <th className="activity-th activity-th-link">Link</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mult = effectiveMultiplier(r, startingPrice)
                const ts = blockTimestamps?.get(r.blockNumber)
                const rel = ts !== undefined ? formatRelative(Math.max(0, nowSec - ts)) : `#${r.blockNumber}`
                const url = r.linkId > 0 ? linkUrls.get(r.linkId) : undefined
                return (
                  <tr key={`${r.blockNumber}-${r.logIndex}`} className="activity-tr">
                    <td className="activity-td activity-td-time" title={`Block ${r.blockNumber}`}>{rel}</td>
                    <td className="activity-td activity-td-region">
                      <code>({r.x},{r.y})</code>
                    </td>
                    <td className="activity-td activity-td-size">
                      <code>{r.w}×{r.h}</code>
                    </td>
                    <td className="activity-td activity-td-painter" title={r.painter}>
                      {shortenAddress(r.painter)}
                    </td>
                    <td className="activity-td activity-td-price" title={`${formatEther(r.pricePaid)} ${nativeSymbol}`}>
                      <code>{formatActivityPrice(r.pricePaid)} <span className="token">{nativeSymbol}</span></code>
                    </td>
                    <td className="activity-td activity-td-mult">
                      {mult !== null ? `${mult.toFixed(1)}×` : '—'}
                    </td>
                    <td className="activity-td activity-td-link">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={url}
                          onClick={(e) => {
                            // Route through the outbound interstitial modal
                            // (PRD §6) so users see a "leaving Tagwall"
                            // warning and we re-validate the URL scheme as
                            // defense-in-depth against a non-https link
                            // ever reaching the frontend.
                            e.preventDefault()
                            onRequestOutbound(url)
                          }}
                        >
                          {url.replace(/^https?:\/\//, '').slice(0, 24)}
                        </a>
                      ) : (
                        <span className="pixel-muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {regions && regions.length > rows.length && (
        <p className="pixel-placeholder">…showing {rows.length} of {regions.length}. Refine the filter.</p>
      )}
    </section>
  )
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align = 'left',
  children,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: 'left' | 'right'
  children?: React.ReactNode
}) {
  return (
    <th
      className={`activity-th activity-th-sortable ${active ? 'activity-th-active' : ''}`}
      onClick={onClick}
      role="button"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
    >
      {label}{children}
    </th>
  )
}
