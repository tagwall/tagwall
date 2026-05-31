import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'

import { canvasAddress } from '../contracts/canvas'
import { useViewerChainId } from '../lib/viewerChain'

/**
 * Reports whether the Canvas contract has bytecode at CANVAS_ADDRESS on
 * the currently-selected chain. Used to gate the paint button + show a
 * "not deployed on this chain" banner.
 *
 * Background: the Canvas address is a CREATE2-predicted address, identical
 * across the v1 chains (PulseChain/Ethereum/Base/BSC + testnet) and a
 * distinct v1.1 address on HyperEVM; canvasAddress(chainId) resolves it.
 * Identical address ≠ identical deployment status — until the operator
 * runs `forge script Deploy`
 * against a chain's RPC, that chain just has an EOA-shaped void at the
 * address. Calling `paint()` against a non-contract sends value as a
 * plain transfer; the funds go to a non-controllable address and are
 * permanently lost.
 *
 * This hook plus the banner wired into ConnectBar prevent that footgun
 * end-to-end. As mainnet deploys land, the hook switches to 'deployed'
 * with no code change.
 *
 * Cached for 5 min per chain via react-query; eth_getBytecode is cheap
 * but bytecode never changes for a given address+chain so we don't need
 * to refetch on every render.
 */
export type CanvasDeployedStatus = 'unknown' | 'deployed' | 'not-deployed'

export function useCanvasDeployed(): CanvasDeployedStatus {
  const chainId = useViewerChainId()
  // Pin the client to the viewer chain so this check is correct even
  // when no wallet is connected (a passer-by browsing tagwall.io/?chain=base
  // should see Base's deployment status, not the default-chain fallback).
  const client = usePublicClient({ chainId })
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas-deployed', chainId],
    queryFn: async (): Promise<boolean> => {
      if (!client) return false
      const code = await client.getCode({ address: canvasAddress(chainId) })
      // viem's getCode returns `undefined` for an address with no code,
      // and a hex string starting with 0x for one with code. '0x' alone
      // is empty; treat as not-deployed.
      return !!code && code !== '0x'
    },
    enabled: !!client,
    staleTime: 1000 * 60 * 5,
    // Don't retry if the RPC says "no code" — that's a successful
    // answer, not a transient failure.
    retry: 1,
  })

  if (isLoading) return 'unknown'
  if (isError) return 'unknown'
  return data ? 'deployed' : 'not-deployed'
}
