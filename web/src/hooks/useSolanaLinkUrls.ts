import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fetchLinkUrls } from '../solana/links'
import { SOLANA_RPC_URL, solanaConnection } from './useSolanaCanvas'

const EMPTY = new Map<number, string>()

/**
 * Resolve Solana registry linkIds to URLs for the shared dock
 * components (Leaderboard / ActivityFeed / LeaderboardTicker take the
 * result via their `linkUrlsOverride` prop). Keyed by the sorted
 * unique id set so reordered or duplicated inputs share one cache
 * entry; registered URLs are immutable on-chain, so a 5-minute
 * staleTime only bounds how long a brand-new registration can lag.
 */
export function useSolanaLinkUrls(linkIds: number[]): Map<number, string> {
  const unique = useMemo(
    () =>
      Array.from(new Set(linkIds.filter((n) => Number.isInteger(n) && n > 0))).sort(
        (a, b) => a - b,
      ),
    // Key on contents, not array identity: callers map fresh arrays
    // every render and we don't want to recompute / refetch for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkIds.join(',')],
  )
  const query = useQuery({
    queryKey: ['solana-link-urls', SOLANA_RPC_URL, unique.join(',')],
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () => fetchLinkUrls(solanaConnection(), unique),
  })
  return query.data ?? EMPTY
}
