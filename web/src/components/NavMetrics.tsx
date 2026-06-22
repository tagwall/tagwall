import { formatEther } from 'viem'
import { useAccount, useChains } from 'wagmi'

import { useCanvasHeader } from '../hooks/useCanvasHeader'
import { useNativeUsdPrice } from '../hooks/useNativeUsdPrice'
import { useOwnedByYou } from '../hooks/useOwnedByYou'
import { usePaintedRegions } from '../hooks/usePaintedRegions'
import { useSolanaCanvas, useSolanaRegions } from '../hooks/useSolanaCanvas'
import { useActiveChain } from '../lib/activeChain'
import { useViewerChainId } from '../lib/viewerChain'
import { formatUsd, weiToUsdRate, SOLANA_PSEUDO_CHAIN_ID } from '../lib/usdPrice'
import {
  SOLANA_CANVAS_HEIGHT,
  SOLANA_CANVAS_WIDTH,
} from '../solana/constants'
import { useSolanaWallet } from '../solana/SolanaWalletProvider'

const DEFAULT_W = 1_250
const DEFAULT_H = 800

/** lamports (9 dec) -> the 18-dec scale formatEther expects (exact
 *  integer multiply, display-only; mirrors solana/history.ts). */
const LAMPORTS_TO_DISPLAY = 1_000_000_000n

/**
 * Top-bar metrics, rendered to the left of the chain dropdown.
 * Family-aware: dispatches to an EVM or Solana variant so the bar can
 * stay mounted on every canvas. The branch is a component swap (not
 * hooks behind conditions), so each family's hooks only run while that
 * family is active; nothing Solana fetches on an EVM canvas and vice
 * versa.
 */
export function NavMetrics() {
  const active = useActiveChain()
  if (active.family === 'solana') return <SolanaNavMetrics />
  return <EvmNavMetrics />
}

/**
 * EVM metrics: Floor / Tags / Owned by you. Replaces the old metric
 * strip below the paint bar so the canvas can sit higher in the
 * viewport. The hooks share react-query cache with HomePage's own
 * reads, so mounting them here doesn't double-fetch.
 */
function EvmNavMetrics() {
  // Viewer chain drives the metrics so a no-wallet visitor sees the
  // floor / tag-count / native symbol for whichever chain they're
  // browsing via the dropdown. Without this NavMetrics displayed
  // wagmi's default-chain ETH instead of the URL-selected PulseChain
  // PLS for disconnected viewers.
  const chainId = useViewerChainId()
  const header = useCanvasHeader(chainId)
  const { data: regions } = usePaintedRegions()
  const { isConnected, address } = useAccount()
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

/** The Solana canvas is 1250 x 800 = 1,000,000 pixels, same as EVM. */
const SOLANA_TOTAL_PIXELS = SOLANA_CANVAS_WIDTH * SOLANA_CANVAS_HEIGHT

/**
 * Solana metrics: Floor / Tags / Coverage / Owned by you, from the same
 * queries the Solana canvas already runs (react-query dedupes, so this
 * adds no RPC traffic). Only mounted while `?chain=solana` is active.
 */
function SolanaNavMetrics() {
  const { config, paintedPixels, isLoading } = useSolanaCanvas()
  // Stagger history behind the canvas query, same as SolanaPage, so the
  // mount burst stays under the public RPC's rate limit.
  const { regions } = useSolanaRegions({ enabled: !isLoading })
  const { publicKey } = useSolanaWallet()

  const startingPrice =
    config !== null ? config.startingPrice * LAMPORTS_TO_DISPLAY : null
  const totalStamps = config !== null ? config.stampCount : null
  const coveragePct =
    config !== null ? (paintedPixels / SOLANA_TOTAL_PIXELS) * 100 : null

  // Owned-by-you over the synthesized regions: painter strings are
  // base58 pubkeys, compared via the same case-folded equality the EVM
  // path uses (exact matches stay exact; both sides fold identically).
  const ownedByYou = useOwnedByYou(
    regions,
    publicKey?.toBase58(),
    SOLANA_CANVAS_WIDTH,
    SOLANA_CANVAS_HEIGHT,
  )

  const usdRate = useNativeUsdPrice(SOLANA_PSEUDO_CHAIN_ID)
  const floorUsd =
    startingPrice !== null ? weiToUsdRate(startingPrice, usdRate) : 0
  const isConnected = publicKey !== null

  return (
    <div className="nav-metrics" role="toolbar" aria-label="Canvas metrics">
      <div
        className="nav-metric"
        title={
          floorUsd > 0
            ? `Floor: ${startingPrice !== null ? formatEther(startingPrice) : '—'} SOL ≈ ${formatUsd(floorUsd)} per pixel`
            : 'Floor price per unpainted pixel.'
        }
      >
        <span className="nav-metric-label">Floor</span>
        <strong className="nav-metric-value">
          {startingPrice !== null ? formatEther(startingPrice) : '—'}
          <span className="nav-metric-unit">SOL</span>
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
        title="Share of the 1,000,000-pixel wall painted at least once."
      >
        <span className="nav-metric-label">Coverage</span>
        <strong className="nav-metric-value">
          {coveragePct !== null ? `${coveragePct.toFixed(2)}%` : '—'}
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
