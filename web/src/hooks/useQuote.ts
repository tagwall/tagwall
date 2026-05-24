import { useReadContract } from 'wagmi'

import { CANVAS_ADDRESS, canvasAbi } from '../contracts/canvas'

/**
 * Live cost quote for a rectangular region via `canvas.quote()`. Returns the
 * total native-wei cost and pixel count; refetches when the region changes
 * and when any paint lands (TanStack Query invalidates by staleTime).
 *
 * Disabled when no region is provided.
 */
export function useQuote(region: { x: number; y: number; w: number; h: number } | null) {
  const enabled = !!region
  const { data, isLoading, error } = useReadContract({
    address: CANVAS_ADDRESS,
    abi: canvasAbi,
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
