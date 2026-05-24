/**
 * Central source of truth for the operator's social URLs.
 *
 * Both the holding page and the main app footer read from here, so the
 * operator updates one set of build-time env vars and both surfaces stay
 * in sync. Empty values render the button as a non-link styling so the
 * placeholder doesn't accidentally go to "#" and break tab/scroll
 * behaviour.
 */
export const TWITTER_URL = (import.meta.env.VITE_TAGWALL_TWITTER_URL ?? '').trim()
export const TELEGRAM_URL = (import.meta.env.VITE_TAGWALL_TELEGRAM_URL ?? '').trim()
