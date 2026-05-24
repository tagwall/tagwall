/**
 * Chainalysis Sanctions Oracle integration.
 *
 * Free, on-chain oracles published by Chainalysis that return whether a
 * given address is on the OFAC SDN list (or other sanctions lists they
 * track). The oracle is read-only and live; we batch reads via wagmi's
 * `useReadContracts` (multicall under the hood) and cache for 24h since
 * sanctions don't churn minute-to-minute.
 *
 * Reference: https://go.chainalysis.com/api-sanctions-oracle.html
 *
 * Operator action before mainnet launch: confirm each address on the
 * Chainalysis docs page above. The oracle is CREATE2-deployed at the same
 * address on most chains (`0x40C5...8fb`), but Base lives at a separate
 * address. Chains without a published oracle (PulseChain mainnet/testnet,
 * Anvil) degrade to no-op: the OFAC filter has nothing to query, so all
 * paints render through unfiltered.
 */
import type { Address } from 'viem'

/**
 * chainId → Chainalysis oracle address. Chains not in the map have no
 * Chainalysis coverage and the OFAC filter falls back to "no-op (unfiltered)"
 * for that chain. PRD §11 risk #3 (constructive-knowledge) accepts this gap:
 * the operator-side abuse-report SLA covers chains without an oracle.
 */
export const OFAC_ORACLES: Record<number, Address> = {
  // Ethereum mainnet
  1: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  // BNB Smart Chain mainnet
  56: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  // Base mainnet (different address per Chainalysis)
  8453: '0x3A91A31cB3dC49b4db9Ce721F50a9D519c5C7E0F',
}

export const OFAC_ORACLE_ABI = [
  {
    type: 'function',
    name: 'isSanctioned',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

export function ofacOracleFor(chainId: number | undefined): Address | undefined {
  if (chainId === undefined) return undefined
  return OFAC_ORACLES[chainId]
}
