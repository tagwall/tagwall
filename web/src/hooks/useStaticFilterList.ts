import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  parsePubKey,
  projectFilterSets,
  verifyFilterList,
  type AppliedFilterSets,
  type SignedFilterList,
} from '../lib/filterList'

const STATIC_LIST_URL = (import.meta.env.VITE_FILTER_STATIC_LIST_URL ?? '').trim()
const STATIC_LIST_PUBKEY_RAW = import.meta.env.VITE_FILTER_PUBKEY ?? ''

// Last accepted (signature-verified) list, kept so a server that replays an
// OLDER validly-signed list (a downgrade attack resurrecting since-blocked
// content) cannot roll the client back: we keep whichever list is newer.
// The cached copy is re-verified on load; localStorage is same-origin
// writable, so it is never trusted without a fresh signature check.
const CACHE_KEY = 'tagwall.filterList.lastAccepted'

function publishedAtMs(list: SignedFilterList): number {
  const t = Date.parse(list.publishedAt)
  return Number.isFinite(t) ? t : 0
}

function readCachedList(): unknown | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function writeCachedList(list: SignedFilterList): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list))
  } catch {
    // Quota / disabled storage: replay protection degrades to per-session.
  }
}

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
      // pubKey is non-null when enabled is true (guard above).
      let fetched: SignedFilterList | null = null
      const r = await fetch(STATIC_LIST_URL, { signal, cache: 'no-store' })
      if (!r.ok) {
        console.warn('[filterList] fetch failed', r.status, r.statusText)
      } else {
        fetched = await verifyFilterList(await r.json(), pubKey!)
      }

      // Downgrade guard: prefer the newer of (fetched, cached), both
      // signature-verified. Also keeps the last-good list usable when the
      // fetch fails, which only ever ADDS filtering vs the fail-open
      // baseline.
      const cachedRaw = readCachedList()
      const cached = cachedRaw ? await verifyFilterList(cachedRaw, pubKey!) : null
      let winner = fetched
      if (cached && (!fetched || publishedAtMs(cached) > publishedAtMs(fetched))) {
        if (fetched) {
          console.warn(
            '[filterList] fetched list is older than last accepted; keeping the newer cached list',
          )
        }
        winner = cached
      }
      if (winner && winner !== cached) writeCachedList(winner)
      return winner
    },
  })

  return useMemo(() => projectFilterSets(data ?? null), [data])
}
