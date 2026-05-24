import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  parsePubKey,
  projectFilterSets,
  verifyFilterList,
  type AppliedFilterSets,
} from '../lib/filterList'

const STATIC_LIST_URL = (import.meta.env.VITE_FILTER_STATIC_LIST_URL ?? '').trim()
const STATIC_LIST_PUBKEY_RAW = import.meta.env.VITE_FILTER_PUBKEY ?? ''

/**
 * Fetches and verifies the operator's signed static filter list, returns
 * the projected sets of blocked addresses / pixel rects / link hashes.
 *
 * Disabled (returns EMPTY_FILTER_SETS without fetching) when:
 *   - VITE_FILTER_STATIC_LIST_URL is unset / empty
 *   - VITE_FILTER_PUBKEY is unset / malformed
 *
 * This is the dynamic-feed counterpart to the OFAC oracle: same
 * fail-open posture during load + on network error, but fail-closed on
 * signature mismatch (we never trust an unsigned or tampered list).
 *
 * Cache: 1h staleTime. Mirrors that update their list more often can
 * tighten via build flag; the default lines up with the operator's
 * stated abuse-response SLA in cpa-brief.md §2.2.
 */
export function useStaticFilterList(): AppliedFilterSets {
  const pubKey = useMemo(() => parsePubKey(STATIC_LIST_PUBKEY_RAW), [])
  const enabled = !!STATIC_LIST_URL && !!pubKey

  const { data } = useQuery({
    queryKey: ['static-filter-list', STATIC_LIST_URL],
    enabled,
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetch(STATIC_LIST_URL, { signal, cache: 'no-store' })
      if (!r.ok) {
        console.warn('[filterList] fetch failed', r.status, r.statusText)
        return null
      }
      const raw = await r.json()
      // pubKey is non-null when enabled is true (guard above).
      return verifyFilterList(raw, pubKey!)
    },
  })

  return useMemo(() => projectFilterSets(data ?? null), [data])
}
