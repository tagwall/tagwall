/**
 * Display-label helper for x.com / twitter.com painted links.
 *
 * If `rawUrl` points at an x.com / twitter.com profile (or a status under a
 * profile), return the handle formatted as "@username"; if it points at an
 * X community (/i/communities/<id>), return "X Community". Otherwise null.
 *
 * Used by LinkLabel so a painted x.com link reads as "@username" (or
 * "X Community") in the leaderboard ticker and the leaderboard, instead of a
 * bare "x.com" hostname. Does not change the outbound link target, only the label.
 */

const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])

// First path segments on x.com / twitter.com that are NOT usernames.
const RESERVED_SEGMENTS = new Set([
  'i', 'home', 'explore', 'notifications', 'messages', 'settings',
  'search', 'hashtag', 'intent', 'share', 'compose', 'login', 'signup',
  'logout', 'account', 'tos', 'privacy', 'about', 'jobs', 'help', 'download',
])

/** "@username" for an x.com/twitter.com profile URL, else null. */
export function twitterHandleLabel(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  if (!TWITTER_HOSTS.has(host)) return null

  const segs = u.pathname.split('/').filter(Boolean)

  // X Communities live at /i/communities/<numeric id> — no username in the
  // URL, and the community's name isn't fetchable (X blocks unauthenticated
  // reads), so label it generically. Still clearer than a bare "x.com"
  // hostname, and it reads as intentional rather than a broken link.
  if (segs[0] === 'i' && segs[1] === 'communities' && /^\d+$/.test(segs[2] ?? '')) {
    return 'X Community'
  }

  // First non-empty path segment is the handle (query/extra path ignored,
  // so e.g. /imshillgates?ref=22222P and /jack/status/123 both resolve).
  const seg = segs[0]
  if (!seg) return null

  const handle = seg.startsWith('@') ? seg.slice(1) : seg
  if (RESERVED_SEGMENTS.has(handle.toLowerCase())) return null
  // Real X handles are 1-15 chars, letters/digits/underscore only.
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null

  return `@${handle}`
}
