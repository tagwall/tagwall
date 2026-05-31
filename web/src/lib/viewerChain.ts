import { useSearchParams } from 'react-router-dom'
import { useAccount, useChainId } from 'wagmi'

/**
 * Union of configured chain ids — mirrors `wagmi.ts`. Kept hand-maintained
 * here (rather than derived from the wagmi config) to avoid the circular
 * import that would result from `viewerChain.ts ↔ wagmi.ts`. If a new
 * chain is added to the wagmi config, add it here too.
 */
export type ChainId = 1 | 369 | 8453 | 56 | 999 | 31337 | 943

/**
 * Chain selector for "view-only" browsing.
 *
 * The default tagwall.io behaviour ties the active chain to the connected
 * wallet (via wagmi's useChainId). That works when a wallet is connected,
 * but a passer-by with no wallet installed can't choose a chain to look at,
 * so the dropdown effectively did nothing for them.
 *
 * This module decouples "which chain's canvas am I looking at" from
 * "which chain is my wallet on". When a wallet is connected, those stay
 * tied (the wallet's chain wins, so the paint UX matches what the wallet
 * will sign). When disconnected, the chain comes from a `?chain=` URL
 * search param, which means:
 *   - Shareable: tagwall.io/?chain=base shows the Base canvas to anyone
 *   - No-wallet preview works without MetaMask
 *   - The dropdown click writes the URL param, so it's reactive
 *
 * Slug ↔ chain-id table is intentionally small. Add a row when shipping
 * a new chain; the canonical id is what gets used everywhere downstream.
 */

const CHAIN_BY_SLUG: Record<string, number> = {
  pulse: 369,
  pulsechain: 369,
  eth: 1,
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  bsc: 56,
  hyperevm: 999,
  hyperliquid: 999,
  hype: 999,
  anvil: 31337,
}

const SLUG_BY_CHAIN: Record<number, string> = {
  369: 'pulse',
  1: 'eth',
  8453: 'base',
  56: 'bsc',
  999: 'hyperevm',
  31337: 'anvil',
}

/**
 * Chain id for canvas reads (`usePaintedRegions`, `useTilePixels`,
 * `useCanvasDeployed`, etc.). Falls back to wagmi's chainId when neither
 * URL param nor wallet is decisive, so wagmi's default-first-chain
 * behaviour still applies.
 */
export function useViewerChainId(): ChainId {
  const { isConnected } = useAccount()
  const walletChainId = useChainId()
  const [searchParams] = useSearchParams()

  // Connected wallet wins: keep view + wallet aligned so the user
  // doesn't sign on a chain different from what they're seeing.
  if (isConnected) return walletChainId as ChainId

  // Disconnected: URL param drives the view. Lowercased so
  // `?chain=Base` still resolves.
  const slug = searchParams.get('chain')?.toLowerCase()
  if (slug && CHAIN_BY_SLUG[slug]) return CHAIN_BY_SLUG[slug] as ChainId

  // No URL hint, no wallet: wagmi's default (first chain in config).
  return walletChainId as ChainId
}

/**
 * Writes the viewer chain to the URL. Use when the dropdown is clicked
 * by a disconnected user; the connected path should still call wagmi's
 * `switchChain` because the wallet's chain must match what gets signed.
 */
export function useSetViewerChain(): (chainId: number) => void {
  const [, setSearchParams] = useSearchParams()
  return (chainId: number) => {
    const slug = SLUG_BY_CHAIN[chainId]
    if (!slug) return
    setSearchParams(
      (prev) => {
        prev.set('chain', slug)
        return prev
      },
      { replace: false },
    )
  }
}
