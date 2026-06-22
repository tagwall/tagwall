import { useSearchParams } from 'react-router-dom'

import { useViewerChainId, type ChainId } from './viewerChain'
import { SOLANA_CLUSTER, type SolanaCluster } from '../solana/cluster'

/**
 * The single source of truth for "which canvas am I looking at",
 * spanning chain FAMILIES (EVM + Solana), not just EVM chain ids.
 *
 * Why a layer above `useViewerChainId`: that hook returns a numeric
 * EVM chain id and ties the view to a connected EVM wallet. Solana is
 * a different family with a different wallet, so it can't be a number
 * in that union. The rule here: an explicit `?chain=solana` selects
 * the Solana family REGARDLESS of any connected EVM wallet (so an EVM
 * wallet user can still browse/paint Solana); everything else defers
 * to the existing EVM viewer logic unchanged.
 */
export type ActiveChain =
  | { family: 'evm'; chainId: ChainId }
  | { family: 'solana'; cluster: SolanaCluster }

/** The `?chain=` slug that selects the Solana family. */
export const SOLANA_SLUG = 'solana'

export function useActiveChain(): ActiveChain {
  const [searchParams] = useSearchParams()
  const evmChainId = useViewerChainId()
  const slug = searchParams.get('chain')?.toLowerCase()
  if (slug === SOLANA_SLUG) return { family: 'solana', cluster: SOLANA_CLUSTER }
  return { family: 'evm', chainId: evmChainId }
}

/** True when the Solana canvas should render. Cheap convenience. */
export function useIsSolanaActive(): boolean {
  return useActiveChain().family === 'solana'
}

/**
 * Select the Solana family. Writes `?chain=solana`; the EVM wallet (if
 * any) is left alone since Solana paints go through the Solana wallet.
 */
export function useSelectSolana(): () => void {
  const [, setSearchParams] = useSearchParams()
  return () =>
    setSearchParams(
      (prev) => {
        prev.set('chain', SOLANA_SLUG)
        return prev
      },
      { replace: false },
    )
}
