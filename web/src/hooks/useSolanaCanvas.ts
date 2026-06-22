import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Connection } from '@solana/web3.js'

import {
  canvasPda,
  decodeCanvasConfig,
  fetchAllTiles,
  vaultPda,
  type SolanaCanvasConfig,
  type SolanaTile,
} from '../solana/client'
import { fetchPaintedRegions } from '../solana/history'
import { tileMapOf } from '../solana/quote'
import type { PaintedRegion } from './usePaintedRegions'

import { SOLANA_DEFAULT_RPC_URL } from '../solana/cluster'

/** Env override first, then the cluster's probed default (cluster.ts). */
export const SOLANA_RPC_URL: string =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? SOLANA_DEFAULT_RPC_URL

let sharedConnection: Connection | null = null
export function solanaConnection(): Connection {
  if (!sharedConnection) {
    sharedConnection = new Connection(SOLANA_RPC_URL, 'confirmed')
  }
  return sharedConnection
}

export interface SolanaCanvasState {
  config: SolanaCanvasConfig | null
  tiles: SolanaTile[]
  tileMap: Map<string, SolanaTile>
  vaultLamports: bigint
  paintedPixels: number
  isLoading: boolean
  error: string | null
  refetch: () => void
}

/**
 * The whole Solana canvas in two RPC calls: config + every lazy tile
 * (virgin canvas needs no data at all). Polls every 60s; paint flows
 * call `refetch()` on success for an immediate refresh.
 */
export function useSolanaCanvas(): SolanaCanvasState {
  const query = useQuery({
    queryKey: ['solana-canvas', SOLANA_RPC_URL],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    // The public RPC rate-limits bursts; retry patiently with backoff
    // so a 429 on first load self-heals instead of leaving the page
    // configless (which the paint panel shows as a missing quote).
    retry: 6,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
    queryFn: async () => {
      const conn = solanaConnection()
      const [configInfo, tiles, vaultBalance] = await Promise.all([
        conn.getAccountInfo(canvasPda()),
        fetchAllTiles(conn),
        conn.getBalance(vaultPda()),
      ])
      if (!configInfo) throw new Error('canvas not initialized on this cluster')
      return {
        config: decodeCanvasConfig(configInfo.data),
        tiles,
        vaultLamports: BigInt(vaultBalance),
      }
    },
  })

  const tileMap = useMemo(
    () => tileMapOf(query.data?.tiles ?? []),
    [query.data?.tiles],
  )
  const paintedPixels = useMemo(
    () =>
      (query.data?.tiles ?? []).reduce(
        (n, t) => n + t.pixels.filter((p) => p.lastPrice > 0n).length,
        0,
      ),
    [query.data?.tiles],
  )

  return {
    config: query.data?.config ?? null,
    tiles: query.data?.tiles ?? [],
    tileMap,
    vaultLamports: query.data?.vaultLamports ?? 0n,
    paintedPixels,
    isLoading: query.isLoading,
    error: query.error ? String((query.error as Error).message ?? query.error) : null,
    refetch: () => void query.refetch(),
  }
}

/**
 * Painted-event history synthesized into the EVM PaintedRegion shape,
 * so the shared ticker/leaderboard/activity components render Solana
 * stamps unchanged. Display-only data (prices pre-scaled for the
 * shared 18-decimal formatters; see solana/history.ts).
 */
export function useSolanaRegions(options?: { enabled?: boolean }): {
  regions: PaintedRegion[] | undefined
  isLoading: boolean
} {
  const query = useQuery({
    queryKey: ['solana-regions', SOLANA_RPC_URL],
    // History is the heaviest fetch (one tx-batch call per 5 stamps);
    // poll it half as often as the canvas state and let the caller
    // stagger it behind the canvas query so the mount burst doesn't
    // trip the public RPC's rate limit.
    refetchInterval: 120_000,
    refetchOnWindowFocus: false,
    retry: 4,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
    enabled: options?.enabled ?? true,
    queryFn: () => fetchPaintedRegions(solanaConnection()),
  })
  return { regions: query.data, isLoading: query.isLoading }
}
