import { useQuery } from '@tanstack/react-query'
import { getPublicClient } from '@wagmi/core'
import type { Hex } from 'viem'
import { parseAbiItem } from 'viem'

import { config } from '../wagmi'
import { canvasAddress } from '../contracts/canvas'
import { deployBlockFor, logsChunkSizeFor } from '../lib/deployBlocks'
import { getLogsPaginated, type GetLogsClient } from '../lib/paginatedLogs'
import { OPS_CHAINS } from './useCrossChainLive'

/**
 * All-time canvas coverage for EVERY chain, computed client-side on the
 * operator's /ops page.
 *
 * This is the one cross-chain metric the original /ops design deliberately
 * left viewer-chain-only, because reconstructing coverage needs a full
 * Painted-event log scan per chain (one eth_call can't return distinct
 * painted pixels). It lives HERE, not on the main canvas, precisely because
 * /ops is an operator tool: a regular visitor never pays this cost, and the
 * page already fans out a 5-chain live read, so a 5-chain log scan is in
 * keeping. react-query caches the result for the session (staleTime 5 min,
 * no auto-refetch) so it runs once per visit, and each chain is wrapped in
 * allSettled so one flaky RPC degrades to a single offline row.
 *
 * Counts are raw on-chain geometry (no OFAC / static-list filtering, unlike
 * the rendered canvas): an operator coverage stat should reflect what's
 * actually on-chain, not the filtered view.
 */

const WALL_W = 1250
const WALL_H = 800
const TOTAL_PIXELS = WALL_W * WALL_H

/**
 * Cell budget for the exact gridding pass. The whole canvas is 1,000,000
 * cells; allow a little headroom for overlapping stamps that re-cover the
 * same pixels. Above this we report the summed stamp area as an upper bound
 * and flag the row inexact rather than allocating an oversized Map.
 */
const CELL_BUDGET = 1_300_000

const PAINTED_EVENT = parseAbiItem(
  'event Painted(address indexed painter, address indexed referrer, bytes32 indexed metadataHash, uint32 x, uint32 y, uint32 w, uint32 h, uint32 pixelsPainted, uint256 pricePaid, uint32 linkId)',
)

export interface ChainCoverage {
  chainId: number
  name: string
  ok: boolean
  /** Distinct painted pixels (unique cells touched by any stamp). */
  covered: number
  /** Pixels painted 2+ times (the PRD's "overwritten at least once"). */
  overwritten: number
  /** Number of Painted events (stamps). */
  stamps: number
  /** covered / 1,000,000, as a percentage. */
  coveragePct: number
  /** False when the stamp area blew the budget and `covered` is an upper bound. */
  exact: boolean
}

async function scanCoverage(c: (typeof OPS_CHAINS)[number]): Promise<ChainCoverage> {
  const client = getPublicClient(config, { chainId: c.id })
  if (!client) throw new Error(`no public client for chain ${c.id}`)

  const toBlock = await client.getBlockNumber()
  const logs = await getLogsPaginated({
    publicClient: client as unknown as GetLogsClient,
    address: canvasAddress(c.id) as Hex,
    event: PAINTED_EVENT,
    fromBlock: deployBlockFor(c.id),
    toBlock,
    chunkSize: logsChunkSizeFor(c.id),
  })

  const regions = logs.map((l) => ({
    x: Number(l.args.x),
    y: Number(l.args.y),
    w: Number(l.args.w),
    h: Number(l.args.h),
  }))

  let area = 0
  for (const r of regions) area += r.w * r.h

  const base = { chainId: c.id, name: c.name, ok: true, stamps: regions.length }

  if (area > CELL_BUDGET) {
    const upper = Math.min(area, TOTAL_PIXELS)
    return {
      ...base,
      covered: upper,
      overwritten: 0,
      coveragePct: (upper / TOTAL_PIXELS) * 100,
      exact: false,
    }
  }

  // Order doesn't matter for coverage counts: we only need distinct cells
  // and which were touched 2+ times, so no (block, logIndex) sort needed.
  const cells = new Map<number, number>()
  for (const r of regions) {
    for (let dy = 0; dy < r.h; dy++) {
      const row = (r.y + dy) * WALL_W
      for (let dx = 0; dx < r.w; dx++) {
        const key = row + (r.x + dx)
        cells.set(key, (cells.get(key) ?? 0) + 1)
      }
    }
  }
  let overwritten = 0
  for (const count of cells.values()) if (count >= 2) overwritten++

  return {
    ...base,
    covered: cells.size,
    overwritten,
    coveragePct: (cells.size / TOTAL_PIXELS) * 100,
    exact: true,
  }
}

export interface AllChainsCoverage {
  chains: ChainCoverage[]
  /** Sum of distinct painted pixels across chains; null until one loads. */
  totalCovered: number | null
  isLoading: boolean
  isError: boolean
}

export function useAllChainsCoverage(): AllChainsCoverage {
  const query = useQuery({
    queryKey: ['ops', 'all-chains-coverage'],
    // Expensive scan: cache hard for the operator's session, no polling.
    staleTime: 300_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ChainCoverage[]> => {
      const settled = await Promise.allSettled(OPS_CHAINS.map(scanCoverage))
      return settled.map((res, i) => {
        if (res.status === 'fulfilled') return res.value
        const c = OPS_CHAINS[i]
        return {
          chainId: c.id,
          name: c.name,
          ok: false,
          covered: 0,
          overwritten: 0,
          stamps: 0,
          coveragePct: 0,
          exact: true,
        }
      })
    },
  })

  const chains = query.data ?? []
  const ok = chains.filter((c) => c.ok)
  const totalCovered = ok.length ? ok.reduce((sum, c) => sum + c.covered, 0) : null

  return {
    chains,
    totalCovered,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
