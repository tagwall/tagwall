import { useReadContract, useReadContracts } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import { useViewerChainId } from '../lib/viewerChain'

export interface PixelInfo {
  x: number
  y: number
  /** 24-bit RGB. 0 is black, also the default for unpainted; use `isPainted` to disambiguate. */
  color: number
  /** Last price paid per pixel at this cell, in native wei. Zero iff unpainted. */
  lastPrice: bigint
  /** Registry id of the attached URL; 0 means no link. */
  linkId: number
  /** Current replace-price (what you'd pay right now to overwrite this single pixel), native wei. */
  replacePrice: bigint
  /** Convenience: true iff anyone has ever painted this pixel. */
  isPainted: boolean
}

/**
 * Fetches a single pixel's current state + live replace quote from the
 * Canvas contract. Call site is expected to debounce the (x, y) input so
 * we don't spam the RPC on mousemove.
 *
 * Returns `null` for `data` until both reads settle successfully. Reverts
 * bubble up through `error`.
 */
export function usePixelInfo(coord: { x: number; y: number } | null) {
  // Read on the viewer chain (matches usePaintedRegions/useTilePixels) so
  // hover info reflects the canvas being looked at, not the wallet chain.
  const chainId = useViewerChainId()
  const address = canvasAddress(chainId)
  const enabled = coord !== null && !!address

  // Batched read: pixel state + live quote for a 1x1 region at the same
  // coordinate. One multicall hop per hover.
  const {
    data: bulk,
    isLoading: bulkLoading,
    error: bulkError,
  } = useReadContracts({
    contracts: enabled
      ? [
          {
            address,
            abi: canvasAbi,
            chainId,
            functionName: 'pixelAt',
            args: [coord!.x, coord!.y],
          },
          {
            address,
            abi: canvasAbi,
            chainId,
            functionName: 'quote',
            args: [coord!.x, coord!.y, 1, 1],
          },
        ]
      : [],
    // gcTime: 30s. Every hover on a new pixel creates a fresh cache entry
    // (queryKey includes the coord). At default 5 min gcTime, a minute of
    // exploring would leave hundreds of entries retained. 30s is plenty
    // for the user to hover back onto a recent pixel without refetching,
    // but prevents unbounded growth during long browsing sessions.
    query: { enabled, gcTime: 30_000 },
  })

  // linkId is only known after the pixelAt result settles. We reach for the
  // URL string in a second read so it's cache-hit for subsequent hovers on
  // the same link.
  const linkId = bulk && bulk[0]?.status === 'success'
    ? (bulk[0].result as readonly [number, bigint, number])[2]
    : 0

  const {
    data: linkUrl,
    isLoading: linkLoading,
  } = useReadContract({
    address,
    abi: canvasAbi,
    chainId,
    functionName: 'links',
    args: [BigInt(linkId)],
    // Link URLs are small, but same gcTime applies: one entry per unique
    // linkId. 5 min retention across long hover sessions adds up.
    query: { enabled: enabled && linkId > 0, gcTime: 60_000 },
  })

  if (!enabled) return { data: null, url: '', isLoading: false, error: null }

  const info: PixelInfo | null =
    bulk && bulk[0]?.status === 'success' && bulk[1]?.status === 'success'
      ? (() => {
          const [color, lastPrice, lid] = bulk[0].result as readonly [number, bigint, number]
          const [total] = bulk[1].result as readonly [bigint, number]
          return {
            x: coord!.x,
            y: coord!.y,
            color,
            lastPrice,
            linkId: lid,
            replacePrice: total,
            isPainted: lastPrice > 0n,
          }
        })()
      : null

  return {
    data: info,
    url: (linkUrl as string | undefined) ?? '',
    isLoading: bulkLoading || linkLoading,
    error: bulkError,
  }
}
