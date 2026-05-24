import { formatEther } from 'viem'
import { useAccount, useChainId, useChains } from 'wagmi'

import { useCanvasHeader } from '../hooks/useCanvasHeader'
import { useNativeUsdPrice } from '../hooks/useNativeUsdPrice'
import { useOwnedByYou } from '../hooks/useOwnedByYou'
import { usePaintedRegions } from '../hooks/usePaintedRegions'
import { formatUsd, weiToUsdRate } from '../lib/usdPrice'

const DEFAULT_W = 1_250
const DEFAULT_H = 800

/**
 * Top-bar metrics: Floor / Tags / Owned by you, rendered to the left of
 * the chain dropdown. Replaces the old metric strip below the paint
 * bar so the canvas can sit higher in the viewport. The hooks share
 * react-query cache with HomePage's own reads, so mounting them here
 * doesn't double-fetch.
 */
export function NavMetrics() {
  const header = useCanvasHeader()
  const { data: regions } = usePaintedRegions()
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const chains = useChains()
  const activeChain = chains.find((c) => c.id === chainId)
  const nativeSymbol = activeChain?.nativeCurrency.symbol ?? 'native'

  const startingPrice = (header.data?.[2]?.result as bigint | undefined) ?? null
  const totalStamps = (header.data?.[4]?.result as bigint | undefined) ?? null
  const canvasWidth = Number((header.data?.[0]?.result as bigint | undefined) ?? DEFAULT_W)
  const canvasHeight = Number((header.data?.[1]?.result as bigint | undefined) ?? DEFAULT_H)

  const ownedByYou = useOwnedByYou(
    regions,
    isConnected ? address : undefined,
    canvasWidth,
    canvasHeight,
  )

  const usdRate = useNativeUsdPrice(chainId)
  const floorUsd =
    startingPrice !== null ? weiToUsdRate(startingPrice, usdRate) : 0

  return (
    <div className="nav-metrics" role="toolbar" aria-label="Canvas metrics">
      <div
        className="nav-metric"
        title={
          floorUsd > 0
            ? `Floor: ${startingPrice !== null ? formatEther(startingPrice) : '—'} ${nativeSymbol} ≈ ${formatUsd(floorUsd)} per pixel`
            : 'Floor price per unpainted pixel.'
        }
      >
        <span className="nav-metric-label">Floor</span>
        <strong className="nav-metric-value">
          {startingPrice !== null ? formatEther(startingPrice) : '—'}
          <span className="nav-metric-unit">{nativeSymbol}</span>
        </strong>
      </div>
      <div className="nav-metric-divider" aria-hidden />
      <div className="nav-metric" title="Total tags painted on this canvas.">
        <span className="nav-metric-label">Tags</span>
        <strong className="nav-metric-value">
          {totalStamps !== null ? totalStamps.toString() : '—'}
        </strong>
      </div>
      <div className="nav-metric-divider" aria-hidden />
      <div
        className="nav-metric"
        title={
          isConnected
            ? 'Pixels currently owned by your connected wallet.'
            : 'Connect a wallet to see your owned pixels.'
        }
      >
        <span className="nav-metric-label">Yours</span>
        <strong className="nav-metric-value nav-metric-accent">
          {ownedByYou !== null ? ownedByYou.toLocaleString() : '—'}
          <span className="nav-metric-unit nav-metric-unit-dim">px</span>
        </strong>
      </div>
    </div>
  )
}
