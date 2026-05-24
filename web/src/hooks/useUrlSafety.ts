import { useQuery } from '@tanstack/react-query'

import { checkUrlSafety, type UrlSafety } from '../lib/urlSafety'

const FILTER_ENABLED = import.meta.env.VITE_FILTER_URL_SAFETY_ENABLED !== 'false'

/**
 * Async URL safety lookup against Cloudflare's security DoH endpoint.
 * Cached per URL for 24h via react-query so a user repeatedly hovering
 * the same pixel only triggers one network call.
 *
 * Returns one of:
 *   'safe'    — Cloudflare resolves the hostname normally
 *   'blocked' — Cloudflare flags the hostname (malware/phishing/NXDOMAIN)
 *   'unknown' — query in flight, network error, or filter disabled
 *
 * Callers should fail-open on 'unknown': when the filter can't reach
 * Cloudflare, fall back to the existing protocol guard in
 * OutboundLinkModal. We don't want the modal to wedge on Cloudflare
 * being slow / down.
 *
 * `enabled=false` short-circuits to 'unknown' (caller treats as safe).
 */
export function useUrlSafety(url: string | null): { safety: UrlSafety; isChecking: boolean } {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['url-safety', url ?? ''],
    enabled: FILTER_ENABLED && !!url,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      if (!url) return 'unknown' as UrlSafety
      return checkUrlSafety(url, signal)
    },
  })

  const safety: UrlSafety = data ?? 'unknown'
  return { safety, isChecking: isLoading || isFetching }
}
