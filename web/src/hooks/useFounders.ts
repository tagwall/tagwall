import { useMemo } from 'react'

import { usePaintedRegions } from './usePaintedRegions'
import {
  founderEntriesFromRegions,
  founderStatsFromCount,
  type FounderEntry,
  type FounderRank,
  type FounderStats,
} from '../lib/founders'

interface UseFounders {
  /** Founders in rank order (rank 1 first). Capped at FOUNDER_CAP. */
  entries: FounderEntry[]
  /** Lower-cased address → rank, for badge lookups. */
  ranks: Map<string, FounderRank>
  stats: FounderStats
  isLoading: boolean
}

/**
 * Founder status for the viewer's current chain, derived from the same
 * `usePaintedRegions` query the canvas already runs (react-query dedupes,
 * so this adds no network cost). Per-chain automatically.
 *
 * Ranks are assigned from the UNFILTERED on-chain paint order (rawData),
 * because "Genesis #N" is marketed as a durable claim read straight off
 * the immutable event log: a client filter-list update must never shift
 * anyone's number. Filtered painters still consume their slot; they just
 * get no badge and no board row in the official frontend.
 */
export function useFounders(): UseFounders {
  const { data: regions, rawData, isLoading } = usePaintedRegions()

  const allEntries = useMemo(() => founderEntriesFromRegions(rawData), [rawData])

  // Painters with at least one region surviving the client filter. null
  // when nothing was filtered out, to skip the set walk entirely.
  const visible = useMemo(() => {
    if (!regions || !rawData || regions.length === rawData.length) return null
    const out = new Set<string>()
    for (const r of regions) out.add(r.painter.toLowerCase())
    return out
  }, [regions, rawData])

  const entries = useMemo(
    () => (visible ? allEntries.filter((e) => visible.has(e.painter.toLowerCase())) : allEntries),
    [allEntries, visible],
  )
  const ranks = useMemo(() => {
    const out = new Map<string, FounderRank>()
    for (const e of entries) out.set(e.painter.toLowerCase(), { rank: e.rank, tier: e.tier })
    return out
  }, [entries])
  // Stats count consumed slots, so they come from the unfiltered list.
  const stats = useMemo(() => founderStatsFromCount(allEntries.length), [allEntries.length])

  return { entries, ranks, stats, isLoading }
}
