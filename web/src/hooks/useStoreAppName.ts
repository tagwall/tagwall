import { useQuery } from '@tanstack/react-query'

import type { StoreLink } from '../lib/storeLink'

/**
 * Resolve a store app's display name from the server-side /api/app-name
 * endpoint (Cloudflare Worker in web/worker/index.js). Doing the lookup
 * server-side keeps Apple's no-CORS iTunes API (and the Play page parse)
 * off the browser, no third-party script injection.
 *
 * Returns undefined until resolved (or when there's nothing to look up);
 * cached for the session since app names don't change.
 */
export function useStoreAppName(link: StoreLink | null | undefined): string | undefined {
  const id =
    link?.platform === 'ios'
      ? link.appId
      : link?.platform === 'android'
        ? link.packageId
        : undefined
  const platform = link?.platform

  const { data } = useQuery({
    queryKey: ['app-name', platform, id],
    enabled: !!platform && !!id,
    staleTime: Infinity,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const res = await fetch(
        `/api/app-name?platform=${platform}&id=${encodeURIComponent(id as string)}`,
      )
      if (!res.ok) return null
      const body = (await res.json()) as { name?: string | null }
      return body.name ?? null
    },
  })

  return data ?? undefined
}
