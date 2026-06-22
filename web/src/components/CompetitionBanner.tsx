import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { CONTEST_FLOOR_PLS, contestPhase, nominationLive } from '../lib/contest'

const FLOOR_PLS_LABEL = CONTEST_FLOOR_PLS.toLocaleString('en-US')

/**
 * Slim promo bar for the active competition, mounted directly above the
 * leaderboard ticker on the canvas page. Solid brand-lime background
 * with dark, high-contrast text. While the nomination contest is live it
 * promotes that; otherwise it falls through to the referral contest
 * (teaser before it opens, "live now" once open, hidden once ended).
 * Re-evaluates every 30s so it flips state without a page reload.
 */
export function CompetitionBanner() {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // Nomination contest takes the banner while it's live.
  if (nominationLive()) {
    return (
      <Link
        to="/competition"
        className="comp-banner comp-banner-live"
        aria-label="Nomination contest details"
      >
        <span className="comp-banner-tag">live now</span>
        <span className="comp-banner-text">
          nominate your favourite pulsechain project, the 10 most-nominated get painted onto
          the wall, free
        </span>
        <span className="comp-banner-cta">enter →</span>
      </Link>
    )
  }

  // Otherwise, the referral contest.
  const phase = contestPhase()
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
          : `referral contest, ${FLOOR_PLS_LABEL} PLS minimum pool. share your link, top 3 referrers split it`}
      </span>
      <span className="comp-banner-cta">{live ? 'enter →' : 'details →'}</span>
    </Link>
  )
}
