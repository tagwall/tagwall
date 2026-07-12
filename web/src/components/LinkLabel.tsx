import { useMemo } from 'react'

import { useStoreAppName } from '../hooks/useStoreAppName'
import { twitterHandleLabel } from '../lib/socialHandle'
import {
  parseStoreLink,
  storeLabelWithName,
  storeLinkFallbackLabel,
  storeLinkLabelSync,
} from '../lib/storeLink'

/**
 * Renders the human-readable label for a painted link. For App Store /
 * Google Play URLs it shows "<App Name> for iOS/Android" (resolving the
 * name server-side via /api/app-name for links that don't carry it in the
 * URL); for everything else it falls back to the caller's default text
 * (hostname, truncated url, etc.).
 *
 * A component (not a hook) so the per-row name lookup obeys the rules of
 * hooks when used inside the ticker/leaderboard maps.
 */
export function LinkLabel({ url, fallback }: { url: string; fallback: string }) {
  const link = useMemo(() => parseStoreLink(url), [url])
  // Reliable, no-network label (iOS long link only); null means "ask the
  // server". The lookup hook is always called (null link disables it) so
  // hook order stays stable across rows.
  const syncLabel = link ? storeLinkLabelSync(link) : null
  const fetchedName = useStoreAppName(link && !syncLabel ? link : null)

  // Not a store link: show "@username" for x.com/twitter links, else the
  // caller's fallback. twitterHandleLabel is a pure fn (no hook), so calling
  // it here keeps hook order stable across rows.
  if (!link) return <>{twitterHandleLabel(url) ?? fallback}</>
  if (syncLabel) return <>{syncLabel}</>
  if (fetchedName) return <>{storeLabelWithName(link.platform, fetchedName)}</>
  return <>{storeLinkFallbackLabel(link)}</>
}
