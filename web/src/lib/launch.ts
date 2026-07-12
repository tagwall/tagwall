/* ------------------------------------------------------------------ *
 * Single source of truth for the "new chain just launched" home-page
 * banner. Mirrors lib/contest.ts: the LaunchBanner component reads
 * everything from here so the chain, dates, and copy never drift.
 *
 * The banner is a launch-window promo, not a permanent fixture. It
 * self-hides after LAUNCH_END_MS so a stale "just launched" line can't
 * linger for weeks. To announce the next chain, retune this file.
 * ------------------------------------------------------------------ */

/** The freshly launched chain the banner promotes. */
export const LAUNCH_CHAIN_ID = 4663 // Robinhood Chain
export const LAUNCH_CHAIN_NAME = 'Robinhood Chain'
/** Chain accent (mirrors CHAIN_COLORS.robinhood in lib/chainColor.ts). */
export const LAUNCH_CHAIN_COLOR = '#00C805'

/** Launch instant. Canvas v1.2 deployed + genesis-tagged 2026-07-12. */
export const LAUNCH_START_MS = Date.parse('2026-07-12T00:00:00Z')
/** Banner auto-hides after this (2-week rotation window). */
export const LAUNCH_END_MS = Date.parse('2026-07-27T00:00:00Z')

/** localStorage key so a viewer who dismisses the banner keeps it hidden. */
export const LAUNCH_DISMISS_KEY = 'tw.launch.dismissed.robinhood'

/** True while the launch banner should be offered (inside the window). */
export function launchActive(nowMs: number = Date.now()): boolean {
  return nowMs >= LAUNCH_START_MS && nowMs < LAUNCH_END_MS
}
