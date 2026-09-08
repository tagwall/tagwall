import { useReadContracts } from 'wagmi'

import { canvasAddress, canvasAbi } from '../contracts/canvas'
import { useViewerChainId, type ChainId } from '../lib/viewerChain'

/**
 * Canonical batched read of the Canvas's constant header state. Used by
 * multiple views (stats strip on home, whole stats page, embed chrome).
 * Share the hook so wagmi + TanStack Query dedupe across views.
 *
 * Returned tuple is positionally stable; callers destructure by index.
 * Kept as a tuple (not a named-keys object) because wagmi's
 * useReadContracts returns a positional array.
 *
 * Defaults to the viewer chain (dropdown selection, or the wallet chain
 * once connected) so a no-wallet visitor browsing `?chain=base` reads
 * Base's header, and so every mounted copy of this hook builds the same
 * query key. Earlier, callers that omitted `chainId` fell back to wagmi's
 * first configured chain, which both mismatched the dropdown on
 * no-wallet sessions and produced a second, identical multicall alongside
 * the callers that did pass it.
 */
export function useCanvasHeader(chainId?: ChainId) {
  const viewer = useViewerChainId()
  const id = chainId ?? viewer
  const address = canvasAddress(id)
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
  return useReadContracts({
    contracts: calls.map((c) => ({ ...c, chainId: id })),
    // Constructor constants plus two slow-moving counters. The counters are
    // refreshed on explicit invalidation like everything else; nothing here
    // needs focus/mount refetching.
    query: { staleTime: 60_000, refetchOnWindowFocus: false },
  })
}
