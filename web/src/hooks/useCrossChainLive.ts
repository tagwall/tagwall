import { useQuery } from '@tanstack/react-query'
import { getBalance, getBytecode, readContract } from '@wagmi/core'
import type { Address } from 'viem'

import { config } from '../wagmi'
import { canvasAbi, canvasAddress } from '../contracts/canvas'

/**
 * Live cross-chain on-chain reads for the operator stats view (/ops).
 *
 * Everything here is a single eth_call per value (no log scans), so the
 * whole 5-chain fan-out is cheap and safe to run on page load:
 *   - stampCount()    all-time paint count on that chain
 *   - startingPrice() current per-pixel floor (immutable)
 *   - treasury()      treasury EOA address (immutable)
 *   - getBalance()    treasury float, a proxy for cumulative net revenue
 *
 * Coverage / overwritten-pixel counts are deliberately NOT here: those
 * need a full log scan, which the tweets bot does server-side. The /ops
 * page reads them from summary.json (windowed) and computes a live
 * all-time figure for the viewer's connected chain only (regions are
 * already loaded for the canvas there).
 *
 * Each chain is wrapped in allSettled so one flaky RPC degrades to a
 * single "—" cell instead of blanking the whole table.
 */

/**
 * Chain ids /ops reads. Typed as a literal union (not `number`) so the
 * `chainId` flows into wagmi's `readContract`/`getBalance` params, which
 * require one of the config's configured chain ids rather than any number.
 */
export type OpsChainId = 369 | 999 | 4663 | 1 | 8453 | 56

interface OpsChain {
  id: OpsChainId
  name: string
  native: string
}

/** Mainnet chains shown on /ops, in marketing-priority order. */
export const OPS_CHAINS: ReadonlyArray<OpsChain> = [
  { id: 369, name: 'PulseChain', native: 'PLS' },
  { id: 4663, name: 'Robinhood', native: 'ETH' },
  { id: 999, name: 'HyperEVM', native: 'HYPE' },
  { id: 1, name: 'Ethereum', native: 'ETH' },
  { id: 8453, name: 'Base', native: 'ETH' },
  { id: 56, name: 'BSC', native: 'BNB' },
]

export interface ChainLive {
  chainId: number
  name: string
  native: string
  ok: boolean
  /** All-time paint count (number of stamps). */
  stampCount: bigint | null
  /** Current per-pixel floor, in wei. */
  startingPrice: bigint | null
  /** Treasury EOA address for the chain. */
  treasury: Address | null
  /** Treasury native balance, in wei (proxy for cumulative net revenue). */
  treasuryBalance: bigint | null
  /**
   * True when eth_getCode(treasury) is non-empty. The treasury MUST stay a
   * plain EOA: Canvas sends its 95% slice with a 50k gas budget and burns
   * it to 0xdEaD on failure, so a 7702 delegation (or any code) on the
   * treasury address whose receive() reverts or exceeds the budget would
   * silently burn all revenue, on every chain it is delegated on. This is
   * the contract's only off-chain tripwire besides the TreasurySendFailed
   * event (which the tweets bot also alerts on). null = check unavailable.
   */
  treasuryHasCode: boolean | null
}

async function readChain(c: OpsChain): Promise<ChainLive> {
  const address = canvasAddress(c.id)
  if (!address) throw new Error(`no canvas address for chain ${c.id}`)
  const base = { address, abi: canvasAbi, chainId: c.id } as const

  const [stamp, price, treasury] = await Promise.all([
    readContract(config, { ...base, functionName: 'stampCount' }),
    readContract(config, { ...base, functionName: 'startingPrice' }),
    readContract(config, { ...base, functionName: 'treasury' }),
  ])

  const treasuryAddr = treasury as Address
  const [bal, code] = await Promise.all([
    getBalance(config, { address: treasuryAddr, chainId: c.id }),
    getBytecode(config, { address: treasuryAddr, chainId: c.id })
      .then((v) => (v != null && v !== '0x' ? true : false))
      // Best effort: a flaky getCode must not sink the whole row.
      .catch(() => null),
  ])

  return {
    chainId: c.id,
    name: c.name,
    native: c.native,
    ok: true,
    stampCount: stamp as bigint,
    startingPrice: price as bigint,
    treasury: treasuryAddr,
    treasuryBalance: bal.value,
    treasuryHasCode: code,
  }
}

export interface CrossChainLive {
  chains: ChainLive[]
  /** Sum of stampCount across chains; null until at least one chain loads. */
  totalPaints: bigint | null
  isLoading: boolean
  isError: boolean
}

export function useCrossChainLive(): CrossChainLive {
  const query = useQuery({
    queryKey: ['ops', 'cross-chain-live'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ChainLive[]> => {
      const settled = await Promise.allSettled(OPS_CHAINS.map(readChain))
      return settled.map((res, i) => {
        if (res.status === 'fulfilled') return res.value
        const c = OPS_CHAINS[i]
        return {
          chainId: c.id,
          name: c.name,
          native: c.native,
          ok: false,
          stampCount: null,
          startingPrice: null,
          treasury: null,
          treasuryBalance: null,
          treasuryHasCode: null,
        }
      })
    },
  })

  const chains = query.data ?? []
  const okChains = chains.filter((c) => c.ok && c.stampCount !== null)
  const totalPaints = okChains.length
    ? okChains.reduce((sum, c) => sum + (c.stampCount ?? 0n), 0n)
    : null

  return {
    chains,
    totalPaints,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
