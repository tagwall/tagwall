import type { PaintedRegion } from '../hooks/usePaintedRegions'

/**
 * Founder status: a frontend + social construct derived entirely from
 * on-chain paint order. Nothing here touches the contract; rank is the
 * 1-indexed position of an address's FIRST paint on a given chain, read
 * from the immutable Painted event log. Because the log is permanent and
 * publicly verifiable, "Genesis #12 on PulseChain" is a durable, provable
 * claim, the same flex as a low ENS name or an early block address.
 *
 * Two tiers, per chain:
 *   - Genesis: the first 100 unique painters.
 *   - Founder: the next 900 (ranks 101..1000).
 * Beyond rank 1000 the founder window is closed, no badge.
 *
 * Caps are deliberately committed numbers (operator decision 2026-06-01):
 * the window closing is what creates the scarcity, so they must not drift.
 */
export const GENESIS_CAP = 100
export const FOUNDER_CAP = 1000

export type FounderTier = 'genesis' | 'founder'

export interface FounderRank {
  /** 1-indexed ordinal of this address's first paint on the chain. */
  rank: number
  tier: FounderTier
}

export interface FounderEntry extends FounderRank {
  /** Lower-cased on input? No, preserves the painter's checksummed/raw
   *  address as it appeared in the event for display + linking. */
  painter: string
  /** The painter's FIRST paint region, used for the board thumbnail. */
  region: PaintedRegion
}

export interface FounderStats {
  /** Unique painters holding a founder slot (capped at FOUNDER_CAP). */
  claimed: number
  /** Filled Genesis slots (<= GENESIS_CAP). */
  genesisClaimed: number
  /** Filled Founder-tier slots, i.e. ranks 101..1000 (<= 900). */
  founderClaimed: number
  /** Remaining Genesis slots. */
  genesisLeft: number
  /** Remaining Founder-tier slots. */
  founderLeft: number
  /** Remaining slots until the whole window (1000) is full. */
  totalLeft: number
}

/** The tier a 1-indexed rank falls into, or null once past FOUNDER_CAP. */
export function tierForRank(rank: number): FounderTier | null {
  if (rank < 1) return null
  if (rank <= GENESIS_CAP) return 'genesis'
  if (rank <= FOUNDER_CAP) return 'founder'
  return null
}

export function tierLabel(tier: FounderTier): string {
  return tier === 'genesis' ? 'Genesis' : 'Founder'
}

/**
 * Walk regions in chain order, assigning each address its founder rank at
 * the moment of its FIRST paint. `regions` MUST be pre-sorted ascending by
 * (blockNumber, logIndex); `usePaintedRegions` already guarantees this.
 * Stops once the window is full so a busy chain doesn't scan forever.
 */
export function founderEntriesFromRegions(
  regions: readonly PaintedRegion[] | undefined,
): FounderEntry[] {
  const out: FounderEntry[] = []
  if (!regions) return out
  const seen = new Set<string>()
  let next = 1
  for (const r of regions) {
    const key = r.painter.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const tier = tierForRank(next)
    if (!tier) break
    out.push({ rank: next, tier, painter: r.painter, region: r })
    next++
    if (next > FOUNDER_CAP) break
  }
  return out
}

/** Address (lower-cased) → founder rank, for O(1) badge lookups. */
export function founderRanksFromRegions(
  regions: readonly PaintedRegion[] | undefined,
): Map<string, FounderRank> {
  const out = new Map<string, FounderRank>()
  for (const e of founderEntriesFromRegions(regions)) {
    out.set(e.painter.toLowerCase(), { rank: e.rank, tier: e.tier })
  }
  return out
}

export function founderStatsFromCount(claimed: number): FounderStats {
  const capped = Math.min(claimed, FOUNDER_CAP)
  const genesisClaimed = Math.min(capped, GENESIS_CAP)
  const founderClaimed = Math.max(0, capped - GENESIS_CAP)
  return {
    claimed: capped,
    genesisClaimed,
    founderClaimed,
    genesisLeft: Math.max(0, GENESIS_CAP - capped),
    founderLeft: Math.max(0, FOUNDER_CAP - GENESIS_CAP - founderClaimed),
    totalLeft: Math.max(0, FOUNDER_CAP - capped),
  }
}
