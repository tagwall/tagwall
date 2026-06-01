import { tierLabel, type FounderTier } from '../lib/founders'

interface Props {
  rank: number
  tier: FounderTier
  /** 'sm' for inline table use, 'md' for the board / standalone surfaces. */
  size?: 'sm' | 'md'
}

/**
 * Founder status pill. Shows tier + rank ("Genesis #12", "Founder #347").
 * Tier drives the colour: Genesis reads as the rarer, gold-tinted tier;
 * Founder rides the chain accent. The title spells out what it means so a
 * first-time viewer understands the flex without leaving the page.
 */
export function FounderBadge({ rank, tier, size = 'sm' }: Props) {
  return (
    <span
      className={`founder-badge founder-badge-${tier} founder-badge-${size}`}
      title={`${tierLabel(tier)} #${rank}, among the first ${tier === 'genesis' ? '100' : '1000'} painters on this chain, recorded permanently on-chain`}
    >
      <span className="founder-badge-tier">{tierLabel(tier)}</span>
      <span className="founder-badge-rank">#{rank}</span>
    </span>
  )
}
