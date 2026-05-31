import { useChainId, useReadContracts } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'

/**
 * Canonical batched read of the Canvas's constant header state. Used by
 * multiple views (stats strip on home, whole stats page, embed chrome).
 * Share the hook so wagmi + TanStack Query dedupe across views.
 *
 * Returned tuple is positionally stable; callers destructure by index.
 * Kept as a tuple (not a named-keys object) because wagmi's
 * useReadContracts returns a positional array.
 *
 * The optional `chainId` arg pins the read to a specific chain so
 * callers (e.g. NavMetrics) can follow the viewer chain even when
 * disconnected. Without it, wagmi falls back to the first chain in
 * config which mismatched the dropdown's chain on no-wallet sessions.
 */
export function useCanvasHeader(chainId?: number) {
  const connected = useChainId()
  const address = canvasAddress(chainId ?? connected)
  const calls = [
    { address, abi: canvasAbi, functionName: 'width' as const },
    { address, abi: canvasAbi, functionName: 'height' as const },
    { address, abi: canvasAbi, functionName: 'startingPrice' as const },
    { address, abi: canvasAbi, functionName: 'treasury' as const },
    { address, abi: canvasAbi, functionName: 'stampCount' as const },
    { address, abi: canvasAbi, functionName: 'freezePeriod' as const },
    { address, abi: canvasAbi, functionName: 'decayPerMonthBps' as const },
    { address, abi: canvasAbi, functionName: 'maxPixelsPerTx' as const },
    { address, abi: canvasAbi, functionName: 'linkCount' as const },
  ]
  return useReadContracts(
    chainId !== undefined
      ? { contracts: calls.map((c) => ({ ...c, chainId })) }
      : { contracts: calls },
  )
}
