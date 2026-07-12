/* ------------------------------------------------------------------ *
 * Single source of truth for the contest calendar. Both the
 * /competition page and the home-page banner read from here so the
 * dates, chain, and floor never drift apart. Retune here only.
 *
 * Calendar: the NOMINATION contest runs first (reply-on-X, top 10
 * projects painted free), closing Sunday midnight UTC. The REFERRAL
 * contest (on-chain PLS pool) opens at that same instant and stays the
 * long-running one. The phase checks are strict (<), so nomination is
 * already over when referral goes live: the site still only ever
 * features one competition at a time, with no overlap.
 * ------------------------------------------------------------------ */

export const CONTEST_CHAIN = 369 // PulseChain

// Referral contest (on-chain leaderboard, PLS pool). On ice until Monday.
export const CONTEST_START_MS = Date.parse('2026-06-22T00:00:00Z')
export const CONTEST_END_MS = Date.parse('2026-06-29T00:00:00Z') // exactly 7 days
export const CONTEST_FLOOR_PLS = 7_777_777 // guaranteed minimum pool

// Nomination contest (reply-on-X, top 10 projects painted free). Live now,
// closes Sunday 21 Jun midnight UTC, the same instant the referral
// contest opens (no Sun-night gap; winners are painted after close).
export const NOMINATION_END_MS = Date.parse('2026-06-22T00:00:00Z') // Sun 24:00 UTC
export const NOMINATION_TWEET_URL =
  'https://x.com/tagwall_io/status/2066428441243881700'

/** True while the nomination contest is the active, featured competition. */
export function nominationLive(nowMs: number = Date.now()): boolean {
  return nowMs < NOMINATION_END_MS
}

export type ContestPhase = 'upcoming' | 'live' | 'ended'

/** Where the referral contest sits relative to `nowMs` (defaults to now). */
export function contestPhase(nowMs: number = Date.now()): ContestPhase {
  if (nowMs < CONTEST_START_MS) return 'upcoming'
  if (nowMs < CONTEST_END_MS) return 'live'
  return 'ended'
}

/**
 * True while there is a competition worth surfacing in the main nav and
 * banner: the nomination contest is live, or the referral contest is
 * upcoming/live. Once both are over this returns false, so the
 * "Competition" nav link and the home banner auto-drop (date-driven, no
 * manual toggle). The /competition route stays reachable for final standings.
 */
export function competitionFeatured(nowMs: number = Date.now()): boolean {
  return nominationLive(nowMs) || contestPhase(nowMs) !== 'ended'
}
