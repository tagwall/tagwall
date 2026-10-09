import { useQuery } from '@tanstack/react-query'

import { OPS_CHAINS } from './useCrossChainLive'

/**
 * All-time canvas coverage for EVERY chain, for the operator's /ops page.
 *
 * Built from the Worker's paint snapshots (/api/canvas/<chainId>/snapshot,
 * the same KV snapshot the canvas renders from): one request per chain.
 *
 * It used to walk every chain's Painted log from the deploy block through
 * /api/rpc. That was about 10,000 Worker requests per page load (BSC alone
 * is ~5,200 log chunks) and ran for about an hour, so an /ops tab left open,
 * or reloaded a few times, used up the Workers free plan's 100,000 requests
 * a day and took the site down for visitors from 5 to 9 Oct 2026. Never put
 * a full-history scan behind the Worker again.
 *
 * Trade-off: the snapshot trails the chain by up to one cron run (5 min),
 * and a chain whose snapshot is still backfilling is flagged `partial`.
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
  /** True while the chain's snapshot is still backfilling history, so the
   *  counts are a lower bound. */
  partial: boolean
}

interface SnapshotGeometry {
  complete?: boolean
  snapshotBlock?: number | null
  regions?: { x: number; y: number; w: number; h: number }[]
}

async function scanCoverage(c: (typeof OPS_CHAINS)[number]): Promise<ChainCoverage> {
  const res = await fetch(`/api/canvas/${c.id}/snapshot`)
  if (!res.ok) throw new Error(`snapshot ${c.id}: HTTP ${res.status}`)
  const snap = (await res.json()) as SnapshotGeometry
  if (snap.snapshotBlock == null) throw new Error(`snapshot ${c.id}: not built yet`)

  const regions = (snap.regions ?? []).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }))

  let area = 0
  for (const r of regions) area += r.w * r.h

  const base = { chainId: c.id, name: c.name, ok: true, stamps: regions.length, partial: snap.complete !== true }

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
    // Six snapshot fetches; no need to poll a 5-minute-old number.
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
          partial: false,
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
