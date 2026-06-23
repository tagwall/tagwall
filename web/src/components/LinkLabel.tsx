import { useMemo } from 'react'

import { useAppStoreName } from '../hooks/useAppStoreName'
import { parseStoreLink, storeLabelWithName, storeLinkLabelSync } from '../lib/storeLink'

/**
 * Renders the human-readable label for a painted link. For App Store /
 * Google Play URLs it shows "<App Name> for iOS/Android" (resolving the
 * name via Apple's lookup for id-only links); for everything else it falls
 * back to the caller's default text (hostname, truncated url, etc.).
 *
 * A component (not a hook) so the per-row App Store lookup obeys the rules
 * of hooks when used inside the ticker/leaderboard maps.
 */
export function LinkLabel({ url, fallback }: { url: string; fallback: string }) {
  const link = useMemo(() => parseStoreLink(url), [url])
  // Always called (id is undefined for non-iOS / non-store), so hook order
  // is stable across rows.
  const fetchedName = useAppStoreName(link?.platform === 'ios' ? link.appId : undefined)

  if (!link) return <>{fallback}</>

  if (fetchedName) return <>{storeLabelWithName(link.platform, fetchedName)}</>
  const sync = storeLinkLabelSync(link)
  if (sync) return <>{sync}</>
  // iOS id-only link whose name hasn't resolved yet.
  return <>{link.platform === 'ios' ? 'iOS app' : 'Android app'}</>
}
