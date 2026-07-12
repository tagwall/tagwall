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
const HYPEREVM = 999
const ROBINHOOD = 4663
const LOCAL_ANVIL = 31337
const LOCAL_HARDHAT = 1337

const CHAIN_DEPLOY_BLOCK: Record<number, bigint> = {
  // Production chains (Day-0 launch 2026-05-24). Canvas address is the
  // same on every chain: 0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415.
  // Frontend scans Painted events from these blocks forward.
  [ETHEREUM]: 25_161_961n,
  [BSC]: 100_071_283n,
  [BASE]: 46_399_049n,
  [PULSECHAIN]: 26_606_708n,
  // PulseChain v4 testnet has had several test deploys. Replace with the
  // current deploy block when the CANVAS_ADDRESS in canvas.ts changes.
  [PULSECHAIN_TESTNET]: 0n,
  // HyperEVM (v1.1 build, 0xbe68…). Deployed 2026-05-31, tx 0x8b8b7f6d….
  [HYPEREVM]: 36_585_579n,
  // Robinhood Chain (v1.2 build, 0x280f…). Deployed 2026-07-12,
  // tx 0x43148827…, block 7,648,180.
  [ROBINHOOD]: 7_648_180n,
  // Local chains: every test fixture deploys fresh, so 0n is the right
  // default. Operator's anvil runs are short-lived.
  [LOCAL_ANVIL]: 0n,
  [LOCAL_HARDHAT]: 0n,
}

export function deployBlockFor(chainId: number | undefined): bigint {
  if (chainId === undefined) return 0n
  return CHAIN_DEPLOY_BLOCK[chainId] ?? 0n
}

/**
 * Per-chunk eth_getLogs block range by chain. Most public RPCs accept the
 * paginator's ~9.5k default. HyperEVM (999) is the exception: its public
 * RPCs cap getLogs at 1000 blocks ("query exceeds max block range 1000"),
 * so it needs a tighter chunk. A 1000n chunk yields a 999-block span
 * (fromBlock..fromBlock+999), which sits at/under the cap. Chains not
 * listed return undefined → the paginator uses its default.
 *
 * Note: HyperEVM mints ~1 block/s, so deploy-block→head grows ~600k
 * blocks/week. At 1000-block chunks a cold full scan costs ~600 getLogs
 * calls/week of history. usePaintedRegions only runs on mount/invalidation
 * (staleTime Infinity), so this is bearable while the canvas is young; a
 * future indexer/snapshot would cap the cold-load cost if HyperEVM gets busy.
 */
const LOGS_CHUNK_BY_CHAIN: Record<number, bigint> = {
  [HYPEREVM]: 1_000n,
  // Robinhood mints ~10 blocks/s (~6M blocks/week), so the paginator's
  // ~9.5k default would cost ~630 getLogs calls per week of history. The
  // official RPC accepted a 6M-block range without complaint when probed
  // (2026-07-12), so use a wide chunk to keep cold-scan call counts low;
  // Nitro caps results (not ranges), and Painted events stay sparse while
  // the canvas is young. Revisit with an indexer if the chain gets busy.
  [ROBINHOOD]: 500_000n,
}

export function logsChunkSizeFor(chainId: number | undefined): bigint | undefined {
  if (chainId === undefined) return undefined
  return LOGS_CHUNK_BY_CHAIN[chainId]
}
