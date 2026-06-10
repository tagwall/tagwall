/* ------------------------------------------------------------------ *
 * Single source of truth for the referral-contest window. Both the
 * /competition page and the home-page banner read from here so the
 * dates, chain, and floor never drift apart. Retune here only.
 * ------------------------------------------------------------------ */

export const CONTEST_CHAIN = 369 // PulseChain
export const CONTEST_START_MS = Date.parse('2026-06-22T00:00:00Z')
export const CONTEST_END_MS = Date.parse('2026-06-29T00:00:00Z') // exactly 7 days
export const CONTEST_FLOOR_PLS = 5_000_000 // guaranteed minimum pool

export type ContestPhase = 'upcoming' | 'live' | 'ended'

/** Where the contest sits relative to `nowMs` (defaults to now). */
export function contestPhase(nowMs: number = Date.now()): ContestPhase {
  if (nowMs < CONTEST_START_MS) return 'upcoming'
  if (nowMs < CONTEST_END_MS) return 'live'
  return 'ended'
}
