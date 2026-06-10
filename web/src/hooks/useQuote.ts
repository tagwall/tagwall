import { useReadContract } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import { useViewerChainId } from '../lib/viewerChain'

/**
 * Live cost quote for a rectangular region via `canvas.quote()`. Returns the
 * total native-wei cost and pixel count; refetches when the region changes
 * and when any paint lands (TanStack Query invalidates by staleTime).
 *
 * Priced on the viewer chain: usePaintSubmitBatch forces wallet == viewer
 * before any tx goes out, so this is the chain the user will actually pay on.
 *
 * Disabled when no region is provided or the chain has no canvas.
 */
export function useQuote(region: { x: number; y: number; w: number; h: number } | null) {
  const chainId = useViewerChainId()
  const address = canvasAddress(chainId)
  const enabled = !!region && !!address
  const { data, isLoading, error } = useReadContract({
    address,
    abi: canvasAbi,
    chainId,
    functionName: 'quote',
    args: enabled ? [region!.x, region!.y, region!.w, region!.h] : undefined,
    query: {
      enabled,
      // Re-quote every 8s while a draft sits still so a concurrent paint from
      // someone else doesn't leave the user looking at a stale cost.
      refetchInterval: 8_000,
      staleTime: 4_000,
    },
  })

  const total = (data as readonly [bigint, number] | undefined)?.[0] ?? null
  const pixelsAffected = (data as readonly [bigint, number] | undefined)?.[1] ?? null

  return { total, pixelsAffected, isLoading, error }
}
