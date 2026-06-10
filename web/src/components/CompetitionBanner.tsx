import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { contestPhase } from '../lib/contest'

/**
 * Slim promo bar for the referral contest, mounted directly above the
 * leaderboard ticker on the canvas page. Solid brand-lime background
 * with dark, high-contrast text. Self-hides once the contest is over
 * ('ended'); shows a teaser before it opens and a "live now" pull once
 * the window is open. Re-evaluates every 30s so it flips state (and
 * disappears at the deadline) without a page reload.
 */
export function CompetitionBanner() {
  const [phase, setPhase] = useState(() => contestPhase())

  useEffect(() => {
    const id = window.setInterval(() => setPhase(contestPhase()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // Disabled when the competition is over.
  if (phase === 'ended') return null

  const live = phase === 'live'

  return (
    <Link
      to="/competition"
      className={`comp-banner${live ? ' comp-banner-live' : ''}`}
      aria-label="Referral contest details"
    >
      <span className="comp-banner-tag">{live ? 'live now' : 'soon'}</span>
      <span className="comp-banner-text">
        {live
          ? 'referral contest is live, share your link and the top 3 referrers split the pool'
          : 'referral contest, 5,000,000 PLS minimum pool. share your link, top 3 referrers split it'}
      </span>
      <span className="comp-banner-cta">{live ? 'enter →' : 'details →'}</span>
    </Link>
  )
}
