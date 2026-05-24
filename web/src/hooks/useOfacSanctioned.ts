import { useMemo } from 'react'
import type { Address } from 'viem'
import { getAddress } from 'viem'
import { useReadContracts } from 'wagmi'

import { OFAC_ORACLE_ABI, ofacOracleFor } from '../lib/ofacOracles'
import { useViewerChainId } from '../lib/viewerChain'

/**
 * Returns the subset of `addresses` that the Chainalysis sanctions oracle
 * marks as sanctioned on the connected chain. Order-insensitive; addresses
 * are deduped + checksum-normalised before query.
 *
 * Behaviour when the filter cannot run:
 *   - `VITE_FILTER_OFAC_ENABLED=false` build flag → returns empty set
 *   - chain has no Chainalysis oracle (PulseChain, Anvil) → returns empty
 *     set; treat as "no addresses sanctioned" so render passes through
 *   - oracle query in flight → returns whatever has resolved so far
 *     (fail-open during load; consistent with cpa-brief.md "best effort")
 *
 * Cache: 24h staleTime + gcTime. Sanctions lists update at most a few
 * times a week. A page reload picks up changes; in-session updates also
 * arrive when wagmi's tile-pixels invalidation fires.
 */
const FILTER_ENABLED = import.meta.env.VITE_FILTER_OFAC_ENABLED !== 'false'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

export function useOfacSanctioned(addresses: readonly Address[]): Set<Address> {
  // Use viewer chain so the right oracle is queried even when no wallet
  // is connected (a Base-viewing visitor should hit the Base Chainalysis
  // oracle, not the wagmi default chain).
  const chainId = useViewerChainId()
  const oracle = ofacOracleFor(chainId)

  // Dedupe + checksum-normalise. Filter out the zero address (no-referrer
  // sentinel) since querying it just wastes a multicall slot.
  const unique = useMemo(() => {
    const set = new Set<Address>()
    for (const a of addresses) {
      if (!a) continue
      try {
        const c = getAddress(a)
        if (c === ZERO_ADDRESS) continue
        set.add(c)
      } catch {
        // skip malformed; nothing to query
      }
    }
    return Array.from(set)
  }, [addresses])

  const enabled = FILTER_ENABLED && !!oracle && unique.length > 0

  const { data } = useReadContracts({
    contracts: enabled
      ? unique.map((addr) => ({
          address: oracle!,
          abi: OFAC_ORACLE_ABI,
          functionName: 'isSanctioned',
          args: [addr],
        }))
      : [],
    query: {
      enabled,
      staleTime: 24 * 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  })

  return useMemo(() => {
    const flagged = new Set<Address>()
    if (!data) return flagged
    data.forEach((result, i) => {
      if (result.status === 'success' && result.result === true) {
        flagged.add(unique[i])
      }
    })
    return flagged
  }, [data, unique])
}
