import { useMemo } from 'react'
import { formatEther } from 'viem'

import { useCanvasHeader } from '../hooks/useCanvasHeader'
import type { PaintedRegion } from '../hooks/usePaintedRegions'
import { founderStatsFromCount } from '../lib/founders'

interface Props {
  /** Regions from usePaintedRegions, passed in so HomePage's existing query
   *  is reused instead of refetching. */
  regions: readonly PaintedRegion[] | undefined
}

/**
 * Aggregate canvas stats, extracted from the old /stats page and inlined
 * on the canvas page per the 2026-04-23 UX pass. Cards cover pricing
 * knobs, activity totals, coverage, and URL count. Reads chain state;
 * renders nothing if the canvas header isn't deployed yet.
 */
export function StatsCards({ regions }: Props) {
  const { data: header, isLoading: headerLoading } = useCanvasHeader()

  const width = header?.[0]?.status === 'success' ? (header[0].result as number) : undefined
  const height = header?.[1]?.status === 'success' ? (header[1].result as number) : undefined
  const startingPrice = header?.[2]?.status === 'success' ? (header[2].result as bigint) : undefined
  const stampCount = header?.[4]?.status === 'success' ? (header[4].result as bigint) : undefined
  const freezePeriod = header?.[5]?.status === 'success' ? (header[5].result as number) : undefined
  const decayPerMonthBps = header?.[6]?.status === 'success' ? (header[6].result as number) : undefined
  const maxPixelsPerTx = header?.[7]?.status === 'success' ? (header[7].result as number) : undefined
  const linkCount = header?.[8]?.status === 'success' ? (header[8].result as bigint) : undefined

  const totalPixels = width !== undefined && height !== undefined ? width * height : undefined

  // Union of all rectangle coordinates: a pixel painted N times counts
  // once. This is the "true coverage" the user cares about, not the
  // gross-pixels double-count.
  const derived = useMemo(() => {
    if (!regions || width === undefined || height === undefined) return null
    const painters = new Set<string>()
    const uniqueKeys = new Set<number>()
    let grossPixels = 0
    let reservedStamps = 0
    for (const r of regions) {
      painters.add(r.painter.toLowerCase())
      grossPixels += r.pixelsPainted
      if (startingPrice && r.pricePaid > (BigInt(r.pixelsPainted) * startingPrice * 105n) / 100n) {
        reservedStamps++
      }
      for (let dy = 0; dy < r.h; dy++) {
        for (let dx = 0; dx < r.w; dx++) {
          uniqueKeys.add((r.y + dy) * width + (r.x + dx))
        }
      }
    }
    return {
      uniquePainters: painters.size,
      grossPixels,
      reservedStamps,
      uniquePixels: uniqueKeys.size,
    }
  }, [regions, width, height, startingPrice])

  const coverage = useMemo(() => {
    if (!derived || !totalPixels) return null
    return derived.uniquePixels / totalPixels
  }, [derived, totalPixels])

  // Founder window: unique painters == claimed founder slots (capped at
  // 1000). Surface whichever scarcity is currently biting as the value.
  const founder = useMemo(
    () => (derived ? founderStatsFromCount(derived.uniquePainters) : null),
    [derived],
  )

  if (headerLoading) return null
  if (header?.some((r) => r.status === 'failure')) return null

  return (
    <div className="stats-grid">
      <StatCard
        label="Starting price"
        value={startingPrice ? `${formatEther(startingPrice)} native` : '—'}
      />
      <StatCard label="Per-tx pixel cap" value={maxPixelsPerTx?.toString() ?? '—'} />
      <StatCard label="Freeze period" value={freezePeriod ? `${Math.round(freezePeriod / 86_400)} days` : '—'} />
      <StatCard
        label="Decay rate"
        value={decayPerMonthBps ? `${(decayPerMonthBps / 100).toFixed(2)}%/month` : '—'}
      />

      <StatCard label="Total stamps" value={stampCount?.toString() ?? '—'} emphasis />
      <StatCard label="Unique painters" value={derived?.uniquePainters?.toString() ?? '—'} emphasis />
      <StatCard
        label={founder && founder.genesisLeft > 0 ? 'Genesis spots left' : 'Founder spots left'}
        value={
          founder
            ? (founder.genesisLeft > 0 ? founder.genesisLeft : founder.totalLeft).toLocaleString()
            : '—'
        }
        hint="Founder rank = your position in the chain's paint order, recorded on-chain. See the Founders page."
        emphasis
      />
      <StatCard
        label="Gross pixels painted"
        value={derived ? derived.grossPixels.toLocaleString() : '—'}
        hint="Sum of pixelsPainted across all Painted events. Overpaints counted multiple times."
        emphasis
      />
      <StatCard
        label="% coverage"
        value={coverage !== null ? `${(coverage * 100).toFixed(2)}%` : '—'}
        hint="Fraction of the canvas painted at least once. Each pixel counts once even if repainted."
        emphasis
      />
      <StatCard
        label="Reserved stamps"
        value={derived ? `${derived.reservedStamps} / ${regions?.length ?? 0}` : '—'}
        hint="Stamps whose cost exceeded 1.05× the floor. Includes overwrites + reserveMultiplier paints."
      />
      <StatCard
        label="Unique URLs registered"
        value={linkCount ? (linkCount - 1n).toString() : '—'}
        hint="Excludes the index-0 empty sentinel."
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: string
  hint?: string
  emphasis?: boolean
}) {
  return (
    <div className={emphasis ? 'stat-card stat-card-emphasis' : 'stat-card'}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {hint && <div className="stat-card-hint">{hint}</div>}
    </div>
  )
}
