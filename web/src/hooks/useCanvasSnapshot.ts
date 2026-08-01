import { useQuery } from '@tanstack/react-query'

import { useViewerChainId } from '../lib/viewerChain'

/**
 * Paint snapshot served by the Worker at /api/canvas/<chainId>/snapshot.
 *
 * Reconstructing the canvas purely from chain state means two expensive
 * walks: a serial `eth_getLogs` paginate from the deploy block, then a
 * `pixelAt` read for every painted pixel. Both aged out of viability as the
 * chains grew. Measured 2026-08-01: BSC needed 1,385 log chunks at 15-24s
 * each (the only public endpoint that serves deploy-block logs at all), and
 * HyperEVM 5,359 chunks at its 1000-block cap. The pixel read-back was
 * issuing ~200 concurrent multicalls carrying ~40 MB of calldata for a canvas
 * holding ~21k painted pixels.
 *
 * The snapshot removes both. Pixel colours are already in each paint's own
 * transaction calldata, so the Worker decodes them once and serves regions
 * with their colours inlined. The browser renders everything at or below
 * `snapshotBlock` from this single fetch, and only scans chain state forward
 * from there.
 *
 * Failure is soft by design. A missing, pending, or partial snapshot just
 * means `snapshotBlock` is null or older, and `usePaintedRegions` scans from
 * the deploy block exactly as it did before. Self-hosted mirrors that serve
 * no /api route get the old behaviour automatically.
 */
export interface SnapshotRegion {
  blockNumber: number
  logIndex: number
  txHash: string
  painter: string
  referrer: string
  metadataHash: string | null
  x: number
  y: number
  w: number
  h: number
  pixelsPainted: number
  pricePaid: string
  linkId: number
  /** Row-major w*h colours, or null when the paint's calldata could not be
   *  decoded (e.g. submitted via a router). Null falls back to a chain read. */
  pixels: Uint32Array | null
}

export interface CanvasSnapshot {
  chainId: number
  /** Last block covered. Null when nothing has been built for this chain. */
  snapshotBlock: number | null
  /** False while the Worker's cron is still backfilling history. */
  complete: boolean
  regions: SnapshotRegion[]
}

const EMPTY: CanvasSnapshot = { chainId: 0, snapshotBlock: null, complete: false, regions: [] }

/** base64 of big-endian uint32 words -> Uint32Array. */
function decodePixels(b64: string): Uint32Array {
  const binary = atob(b64)
  const out = new Uint32Array(binary.length / 4)
  for (let i = 0; i < out.length; i++) {
    const o = i * 4
    out[i] =
      ((binary.charCodeAt(o) << 24) |
        (binary.charCodeAt(o + 1) << 16) |
        (binary.charCodeAt(o + 2) << 8) |
        binary.charCodeAt(o + 3)) >>>
      0
  }
  return out
}

export function useCanvasSnapshot(): CanvasSnapshot {
  const chainId = useViewerChainId()
  const query = useQuery({
    queryKey: ['canvas-snapshot', chainId],
    // The heavy history inside a snapshot does not change; what changes is the
    // tail, and `usePaintedRegions` covers that by scanning forward. So this
    // is refetched on the same explicit-invalidation cadence as the regions
    // query rather than polled.
    staleTime: 60_000,
    gcTime: 300_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async ({ signal }): Promise<CanvasSnapshot> => {
      const res = await fetch(`/api/canvas/${chainId}/snapshot`, { signal })
      if (!res.ok) return { ...EMPTY, chainId }
      const body = await res.json()
      if (!body || !Array.isArray(body.regions)) return { ...EMPTY, chainId }
      return {
        chainId,
        snapshotBlock: typeof body.snapshotBlock === 'number' ? body.snapshotBlock : null,
        complete: !!body.complete,
        regions: body.regions.map(
          (r: Record<string, unknown>): SnapshotRegion => ({
            ...(r as unknown as SnapshotRegion),
            pixels: typeof r.pixels === 'string' ? decodePixels(r.pixels) : null,
          }),
        ),
      }
    },
  })
  return query.data ?? { ...EMPTY, chainId }
}
