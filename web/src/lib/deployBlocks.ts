/**
 * Block at which the Canvas contract was deployed on each chain.
 *
 * Frontend uses these as the lower bound for `eth_getLogs` queries so
 * Painted-event scanning doesn't have to walk every block since genesis.
 * Walking from 0 on a chain with millions of blocks pages out the RPC,
 * burns time, and isn't free even on chains that allow it.
 *
 * The values here are deploy-day artifacts. Operator updates this table
 * the same way `CANVAS_ADDRESS` gets updated in canvas.ts: replace the
 * placeholder once a real deploy lands and ships a known block number.
 *
 * When a chain isn't in the table (because Tagwall hasn't shipped there
 * yet) we fall back to block 0n — the scanner paginates correctly but
 * the first fetch is slow. Once the chain ships, add the deploy block
 * here.
 *
 * Mirror frontends that fork this UI should override these to their own
 * (re)deploy blocks if they're tracking a different deployment.
 */

const ETHEREUM = 1
const BSC = 56
const PULSECHAIN = 369
const PULSECHAIN_TESTNET = 943
const BASE = 8453
const LOCAL_ANVIL = 31337
const LOCAL_HARDHAT = 1337

const CHAIN_DEPLOY_BLOCK: Record<number, bigint> = {
  // Production chains: not deployed yet; replace with real deploy block at
  // launch. Until then the scanner walks from 0n, which is fine because
  // there are no Painted events to find anyway.
  [ETHEREUM]: 0n,
  [BSC]: 0n,
  [BASE]: 0n,
  [PULSECHAIN]: 0n,
  // PulseChain v4 testnet has had several test deploys. Replace with the
  // current deploy block when the CANVAS_ADDRESS in canvas.ts changes.
  [PULSECHAIN_TESTNET]: 0n,
  // Local chains: every test fixture deploys fresh, so 0n is the right
  // default. Operator's anvil runs are short-lived.
  [LOCAL_ANVIL]: 0n,
  [LOCAL_HARDHAT]: 0n,
}

export function deployBlockFor(chainId: number | undefined): bigint {
  if (chainId === undefined) return 0n
  return CHAIN_DEPLOY_BLOCK[chainId] ?? 0n
}
