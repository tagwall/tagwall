/**
 * Per-chain effective max-pixels-per-paint cap.
 *
 * The Canvas contract enforces a single hard ceiling (`maxPixelsPerTx`,
 * currently 1500). That ceiling is identical on every chain because the
 * contract is bytecode-identical across deploys — the CREATE2 address
 * parity guarantee depends on it. But the chain itself enforces a
 * separate per-transaction gas cap that varies wildly, and a 1500-pixel
 * paint at ~35.6M gas is way over the binding cap on chains that have
 * adopted EIP-7825 (Ethereum, BSC) — submitting it produces a mempool
 * rejection that the user sees as a cryptic wallet error, with no clue
 * that splitting into smaller stamps would have worked.
 *
 * This table lets the frontend chunk a stamp into N transactions sized
 * to fit the connected chain's actual constraint. Numbers are derived
 * from gas measurement plus an 80% safety margin against the chain's
 * binding cap:
 *
 *   pixels = floor((per_tx_cap * 0.80 − fixed_overhead) / gas_per_pixel)
 *
 * with fixed_overhead ~341,601 gas (worst case: cold opaque + 256-byte
 * link registration) and gas_per_pixel ~23,695 from the .gas-snapshot
 * regression.
 *
 * | Chain        | Per-tx gas cap | Source                                    | Eff. max pixels |
 * | Ethereum (1) | 16,777,216     | EIP-7825 (Fusaka, 2025-12-03)             | 552             |
 * | BSC (56)     | 16,777,216     | BEP-652 (Osaka/Mendel, 2026-04-28)        | 552             |
 * | Base (8453)  | ~25,000,000    | Sequencer soft-cap (OP-Stack, May 2026)   | 1000            |
 * | PulseChain   | none (block-   | Pre-Fusaka fork; 45M block limit; paint    | 1500 (contract  |
 * |   (369)      |  limit bound)  | uses ~78% of a block — high but accepted   |  ceiling)       |
 * | PulseChain   | none           | v4 testnet, same EVM rules as mainnet      | 1500            |
 * |   testnet    |                |                                            |                 |
 * |   (943)      |                |                                            |                 |
 * | Local anvil  | none           | forge test / forge script                  | 1500            |
 * |   (31337)    |                |                                            |                 |
 * | (other)      | unknown        | Conservative default for unknown chains    | 552             |
 *
 * When a chain's per-tx cap changes (e.g. Base activates EIP-7825 in a
 * future OP-Stack upgrade, or PulseChain ports Fusaka), updating this
 * single table is the entire patch. The contract stays unchanged — its
 * 1500 ceiling is just a sanity bound, never the binding constraint.
 *
 * Mirror operators forking this UI should review this table whenever a
 * supported chain ships a hardfork.
 */

const ETHEREUM = 1
const BSC = 56
const PULSECHAIN = 369
const PULSECHAIN_TESTNET = 943
const BASE = 8453
const LOCAL_ANVIL = 31337
const LOCAL_HARDHAT = 1337

const CONSERVATIVE_DEFAULT = 552

const CHAIN_PIXEL_CAP: Record<number, number> = {
  [ETHEREUM]: 552,
  [BSC]: 552,
  [BASE]: 1000,
  [PULSECHAIN]: 1500,
  [PULSECHAIN_TESTNET]: 1500,
  [LOCAL_ANVIL]: 1500,
  [LOCAL_HARDHAT]: 1500,
}

/**
 * Pixels-per-tx ceiling that the frontend will chunk against for the
 * given chain. Always <= the contract's own `maxPixelsPerTx`. When the
 * chainId is undefined (wallet not connected) or unknown, returns a
 * conservative default sized for the tightest known per-tx cap so a
 * later mempool-rejection surprise can't happen.
 */
export function chainPixelCap(chainId: number | undefined, contractCap: number): number {
  if (chainId === undefined) return Math.min(CONSERVATIVE_DEFAULT, contractCap)
  const cap = CHAIN_PIXEL_CAP[chainId] ?? CONSERVATIVE_DEFAULT
  return Math.min(cap, contractCap)
}

/**
 * True if the chain's frontend chunk cap is strictly tighter than the
 * on-chain contract ceiling. Used by the UI to explain why a stamp got
 * chunked on this chain when the contract would in theory accept it
 * whole on a looser chain.
 */
export function isChainCapTighterThanContract(
  chainId: number | undefined,
  contractCap: number,
): boolean {
  return chainPixelCap(chainId, contractCap) < contractCap
}
