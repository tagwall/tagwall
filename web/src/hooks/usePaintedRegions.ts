import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { getAddress, parseAbiItem } from 'viem'
import { usePublicClient } from 'wagmi'

import { CANVAS_ADDRESS } from '../contracts/canvas'
import { deployBlockFor } from '../lib/deployBlocks'
import { rectsIntersect } from '../lib/filterList'
import { getLogsPaginated } from '../lib/paginatedLogs'
import { useOfacSanctioned } from './useOfacSanctioned'
import { useStaticFilterList } from './useStaticFilterList'

/**
 * A single paint region resolved from a Painted event. Matches the on-chain
 * stamp rectangle, not per-pixel state (per-pixel colors need a follow-up
 * `pixelAt` read via useRegionPixels).
 */
export interface PaintedRegion {
  blockNumber: bigint
  logIndex: number
  txHash: string
  painter: string
  referrer: string
  metadataHash: string
  x: number
  y: number
  w: number
  h: number
  pixelsPainted: number
  pricePaid: bigint
  linkId: number
}

// Explicit ABI item: keeps the getLogs return type narrow and lets us avoid
// pulling the entire ABI into the query key.
const PAINTED_EVENT = parseAbiItem(
  'event Painted(address indexed painter, address indexed referrer, bytes32 indexed metadataHash, uint32 x, uint32 y, uint32 w, uint32 h, uint32 pixelsPainted, uint256 pricePaid, uint32 linkId)',
)

/**
 * Fetches historical Painted events from the current chain and returns them
 * as paint regions sorted by (blockNumber, logIndex). "Current" means the
 * last event wins for any overlapping pixel, so region iteration in order
 * reconstructs the canvas's live state.
 *
 * Pagination:
 *   - Default fromBlock is the chain's recorded deploy block from
 *     `web/src/lib/deployBlocks.ts`. Caller can override via the option.
 *     Walking from genesis on a chain with millions of blocks is the
 *     pathological case that pagination is designed to make survivable,
 *     not a happy path — operators should update deployBlocks.ts at
 *     deploy time.
 *   - `getLogsPaginated` splits the [fromBlock, currentBlock] range into
 *     ~9_500-block chunks so public RPCs that cap eth_getLogs at 10k
 *     don't silently fail. On per-chunk failure the chunk size is halved
 *     and retried down to 500 blocks; if a range stays unrecoverable
 *     the helper drops it (logs to console) and continues so the rest
 *     of the canvas still renders rather than going blank.
 */
export function usePaintedRegions(options?: { fromBlock?: bigint }) {
  const publicClient = usePublicClient()
  const chainId = publicClient?.chain.id
  const fromBlock = options?.fromBlock ?? deployBlockFor(chainId)

  const query = useQuery({
    queryKey: ['painted-regions', chainId, CANVAS_ADDRESS, String(fromBlock)],
    enabled: !!publicClient,
    // Regions list mutates only when a new Painted event lands, which
    // useLivePaintedRefresh invalidates explicitly. No reason to auto-
    // refetch on window focus (a common UX pattern that was churning
    // the 431-event getLogs call every time the tab regained focus —
    // each refetch seeded 70 tile queries and ~1GB of transient heap).
    // Infinity staleTime means the only refetch paths are explicit
    // invalidation or a full reload.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    gcTime: 60_000,
    queryFn: async (): Promise<PaintedRegion[]> => {
      if (!publicClient) return []
      // Resolve toBlock once to keep all chunks anchored to the same
      // head and avoid duplicate events that could land if `latest`
      // advances mid-scan.
      const toBlock = await publicClient.getBlockNumber()
      const logs = await getLogsPaginated({
        publicClient,
        address: CANVAS_ADDRESS as Hex,
        event: PAINTED_EVENT,
        fromBlock,
        toBlock,
      })

      return logs
        .map((log): PaintedRegion => ({
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          txHash: log.transactionHash!,
          painter: log.args.painter!,
          referrer: log.args.referrer!,
          metadataHash: log.args.metadataHash!,
          x: Number(log.args.x),
          y: Number(log.args.y),
          w: Number(log.args.w),
          h: Number(log.args.h),
          pixelsPainted: Number(log.args.pixelsPainted),
          pricePaid: log.args.pricePaid!,
          linkId: Number(log.args.linkId),
        }))
        .sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
          return a.logIndex - b.logIndex
        })
    },
  })

  // Two-source render-time filter (cpa-brief.md §2.1):
  //
  //   1. OFAC oracle (`useOfacSanctioned`) — Chainalysis on-chain
  //      sanctions list. Live, free, no operator side-channel.
  //   2. Static signed list (`useStaticFilterList`) — operator-
  //      published JSON of address / pixelRect / linkHash entries.
  //      Hides regions whose painter/referrer is listed, or whose
  //      stamp rectangle intersects a listed pixelRect.
  //
  // Both sources fail open (load, network error, no oracle on chain).
  // Static-list signature mismatches fail closed in the verify step,
  // so we never apply a tampered list to render. Implemented at the
  // source so every consumer (canvas tiles, ActivityFeed, Leaderboard,
  // NavMetrics, etc.) inherits the same filtered view automatically.
  const addresses = useMemo<Address[]>(() => {
    if (!query.data) return []
    const out: Address[] = []
    for (const r of query.data) {
      try { out.push(getAddress(r.painter)) } catch { /* skip malformed */ }
      try { out.push(getAddress(r.referrer)) } catch { /* skip malformed */ }
    }
    return out
  }, [query.data])

  const sanctioned = useOfacSanctioned(addresses)
  const staticList = useStaticFilterList()

  const filtered = useMemo(() => {
    if (!query.data) return query.data
    const noFilters =
      sanctioned.size === 0 &&
      staticList.blockedAddresses.size === 0 &&
      staticList.blockedPixelRects.length === 0
    if (noFilters) return query.data
    return query.data.filter((r) => {
      try {
        const painter = getAddress(r.painter)
        const referrer = getAddress(r.referrer)
        if (sanctioned.has(painter)) return false
        if (sanctioned.has(referrer)) return false
        if (staticList.blockedAddresses.has(painter.toLowerCase())) return false
        if (staticList.blockedAddresses.has(referrer.toLowerCase())) return false
      } catch {
        // malformed address → conservatively keep (we couldn't check)
      }
      const stampRect = { x: r.x, y: r.y, w: r.w, h: r.h }
      for (const blocked of staticList.blockedPixelRects) {
        if (rectsIntersect(stampRect, blocked)) return false
      }
      return true
    })
  }, [query.data, sanctioned, staticList])

  return { ...query, data: filtered }
}
