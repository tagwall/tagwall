import { Link } from 'react-router-dom'

import { FoundersBoard } from '../components/FoundersBoard'

/**
 * /founders: the founder leaderboard + live scarcity counter for the
 * viewer's current chain. Switch chains from the top bar to see each
 * chain's own founder window (every chain has its own Genesis 100 /
 * Founder 1000).
 */
export default function FoundersPage() {
  return (
    <div className="shell-measure founders-page">
      <header className="founders-page-header">
        <h1>Founders</h1>
        <p>
          Being early on an immutable wall is provable and permanent. The first painters on
          each chain hold a numbered founder slot, read straight from the on-chain paint
          order. There is no other way to earn one once the window closes.
        </p>
        <p className="founders-page-cta">
          <Link to="/" className="founders-page-cta-link">
            Paint a pixel to claim your number →
          </Link>
        </p>
      </header>
      <FoundersBoard />
    </div>
  )
}
