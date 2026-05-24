import { useReadContracts } from 'wagmi'

import { CANVAS_ADDRESS, canvasAbi } from '../contracts/canvas'

/**
 * Canonical batched read of the Canvas's constant header state. Used by
 * multiple views (stats strip on home, whole stats page, embed chrome).
 * Share the hook so wagmi + TanStack Query dedupe across views.
 *
 * Returned tuple is positionally stable; callers destructure by index.
 * Kept as a tuple (not a named-keys object) because wagmi's
 * useReadContracts returns a positional array.
 */
export function useCanvasHeader() {
  return useReadContracts({
    contracts: [
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'width' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'height' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'startingPrice' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'treasury' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'stampCount' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'freezePeriod' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'decayPerMonthBps' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'maxPixelsPerTx' },
      { address: CANVAS_ADDRESS, abi: canvasAbi, functionName: 'linkCount' },
    ],
  })
}
