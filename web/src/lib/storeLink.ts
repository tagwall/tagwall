/**
 * Recognise App Store / Google Play links so the leaderboard + ticker can
 * show "Ching Ching for iOS" instead of the bare "apps.apple.com" host.
 *
 * iOS names: the short share link (apps.apple.com/app/id123) carries no
 * name, only an id, so the readable name is fetched from Apple's iTunes
 * Lookup API (see useAppStoreName — JSONP, since that API has no CORS
 * header). The long link (…/app/ching-ching/id123) already has the name in
 * its slug, so it resolves with zero network.
 *
 * Android names: Google Play has no first-party CORS/JSONP lookup, so we
 * fall back to humanising the package tail (best effort) or a generic label.
 */

export type StorePlatform = 'ios' | 'android'

export interface StoreLink {
  platform: StorePlatform
  appId?: string // iOS numeric track id
  slug?: string // iOS url slug, present only on the long share link
  packageId?: string // Android package name
}

const APPLE_HOSTS = new Set(['apps.apple.com', 'itunes.apple.com'])

/** Parse a URL into a store link, or null if it isn't one. */
export function parseStoreLink(rawUrl: string): StoreLink | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  if (APPLE_HOSTS.has(host)) {
    const appId = u.pathname.match(/\/id(\d+)/)?.[1]
    const slug = u.pathname.match(/\/app\/([^/]+)\/id\d+/)?.[1]
    return { platform: 'ios', appId, slug }
  }
  if (host === 'play.google.com' && u.pathname.startsWith('/store/apps')) {
    return { platform: 'android', packageId: u.searchParams.get('id') ?? undefined }
  }
  return null
}

const PLATFORM_LABEL: Record<StorePlatform, string> = { ios: 'iOS', android: 'Android' }

/** "Ching Ching for iOS". */
export function storeLabelWithName(platform: StorePlatform, name: string): string {
  return `${name} for ${PLATFORM_LABEL[platform]}`
}

/** Turn a slug or package tail into a display name. "ching-ching" ->
 *  "Ching Ching"; "com.foo.chingChing" -> "Ching Ching". Best effort. */
function humanize(s: string): string {
  const tail = s.includes('.') ? (s.split('.').pop() ?? s) : s
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Label available without any network call. Returns null only for the iOS
 * id-only short link, where the name must come from useAppStoreName.
 */
export function storeLinkLabelSync(link: StoreLink): string | null {
  if (link.platform === 'ios') {
    return link.slug ? storeLabelWithName('ios', humanize(link.slug)) : null
  }
  return link.packageId ? storeLabelWithName('android', humanize(link.packageId)) : 'Android app'
}
