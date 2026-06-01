import { useMemo } from 'react'

import { usePaintedRegions } from './usePaintedRegions'
import {
  founderEntriesFromRegions,
  founderRanksFromRegions,
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
 * so this adds no network cost). Per-chain automatically: regions are
 * already scoped to the viewer chain and filtered (sanctioned / blocked
 * painters don't consume a founder slot in the official frontend).
 */
export function useFounders(): UseFounders {
  const { data: regions, isLoading } = usePaintedRegions()

  const entries = useMemo(() => founderEntriesFromRegions(regions), [regions])
  const ranks = useMemo(() => founderRanksFromRegions(regions), [regions])
  const stats = useMemo(() => founderStatsFromCount(entries.length), [entries.length])

  return { entries, ranks, stats, isLoading }
}
