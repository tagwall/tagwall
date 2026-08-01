import {
  createTransport,
  http,
  shouldThrow,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from 'viem'

/**
 * Per-chain RPC pools and the rotating transport that spreads reads across
 * them.
 *
 * Why this exists (2026-08-01): the previous two-deep `fallback()` stack in
 * wagmi.ts had rotted to the point where four of six chains could not render
 * the canvas at all. Two upstream policy changes did most of the damage:
 *
 *   - Allnodes put every free `*.publicnode.com` endpoint behind an archive
 *     token. `eth_getLogs` now returns -32602 "Archive requests require a
 *     personal token" even for a 500-block window at chain head. That killed
 *     the PulseChain and Ethereum secondaries and the Base *primary*.
 *   - `eth.merkle.io` (the Ethereum primary) dropped `eth_getLogs` entirely
 *     and answers -32601 "Method not found", while still serving every other
 *     method. So the header stats kept rendering and only the wall went blank,
 *     which is what made the failure so confusing to diagnose.
 *
 * Every URL below was probed on 2026-08-01 for: correct `eth_chainId`, an
 * `Access-Control-Allow-Origin` that admits tagwall.io, and a real
 * `eth_getLogs` over the chain's deploy-block window at the chunk size
 * `deployBlocks.ts` actually uses. Endpoints that prune logs, cap ranges
 * below our chunk, demand a token, or no longer resolve were rejected.
 * Re-run `node web/scripts/probe-rpcs.mjs` before editing this table. Mirror
 * operators running their own deployment should do the same: these are free
 * public endpoints and the landscape shifts without notice.
 *
 * PulseChain, BSC and Robinhood are short of the four-deep target because no
 * free public endpoint survives the probe: the rest of the landscape either
 * prunes logs after ~24h, caps `eth_getLogs` at 10-50 blocks, or has no DNS
 * record any more. The Worker proxy is the practical fourth entry for those
 * chains, and swapping a dead upstream there needs no frontend redeploy.
 */

/** Same-origin proxy served by web/worker/index.js. Rotates across a
 *  server-side pool and edge-caches historical `eth_getLogs` windows, which
 *  are immutable once they are behind the reorg horizon. */
export function workerRpcUrl(chainId: number): string {
  return `/api/rpc/${chainId}`
}

/**
 * Directly-dialled endpoints, in preferred order. Rotation means the order
 * here is a starting point, not a priority: over a session every entry takes
 * its turn as the first one tried.
 */
export const DIRECT_RPCS: Record<number, readonly string[]> = {
  // PulseChain (369). g4mm4 and the official RPC are the only two survivors.
  369: ['https://rpc-pulsechain.g4mm4.io', 'https://rpc.pulsechain.com'],
  // Ethereum (1). merkle.io is gone from this list: getLogs is -32601 there.
  1: [
    'https://rpc.mevblocker.io',
    'https://eth.drpc.org',
    'https://0xrpc.io/eth',
    'https://eth.api.onfinality.io/public',
  ],
  // Base (8453). base-rpc.publicnode.com was the primary and is archive-gated
  // now; mainnet.base.org and its developer-access sibling are both Coinbase,
  // so tenderly and lava carry the operator diversity.
  8453: [
    'https://base.gateway.tenderly.co',
    'https://mainnet.base.org',
    'https://base.lava.build',
    'https://developer-access-mainnet.base.org',
  ],
  // BSC (56). Bloxroute remains the only public endpoint that will serve a
  // deploy-block `eth_getLogs` at all, and it takes 15-24s per 9.5k chunk.
  // BSC therefore depends on the snapshot endpoint for a usable cold load;
  // see useCanvasSnapshot. Everything else free either prunes (dataseeds,
  // publicnode), caps at 10 blocks (blastapi), or rate-limits (drpc).
  56: ['https://bsc.rpc.blxrbdn.com'],
  // HyperEVM (999). The one chain with a healthy free landscape. All five
  // serve getLogs at the 1000-block chunk the chain's RPCs cap at.
  999: [
    'https://rpc.hypurrscan.io',
    'https://hyperliquid.rpc.blxrbdn.com',
    'https://rpc.purroofgroup.com',
    'https://hyperliquid-json-rpc.stakely.io',
    'https://rpc.hyperlend.finance',
  ],
  // Robinhood Chain (4663). Official RPC only. robinhood.drpc.org exists but
  // caps getLogs at 10k blocks, well under the 500k chunk this chain needs to
  // keep its cold-scan call count sane, so it is not a usable substitute.
  4663: ['https://rpc.mainnet.chain.robinhood.com'],
  // PulseChain v4 testnet (943). Dev convenience only, not a launch chain.
  943: ['https://rpc-testnet-pulsechain.g4mm4.io'],
}

/**
 * Full dial list per chain: the Worker proxy plus every direct endpoint.
 * Exposed so `wallet_addEthereumChain` can hand MetaMask a real URL (the
 * proxy is same-origin and useless to a wallet, so it is excluded there).
 */
export function directRpcs(chainId: number): readonly string[] {
  return DIRECT_RPCS[chainId] ?? []
}

/**
 * Rotation cursor. Advanced by `advanceRpcRotation()` on every canvas
 * refresh, so consecutive refreshes start on different operators instead of
 * pinning the first entry forever. Spreading matters more than it sounds: a
 * full-canvas tile load is hundreds of `eth_call`s, and concentrating those
 * on one free endpoint is what gets an IP rate-limited.
 */
let rotation = 0

/** Called by the refresh handler so the next pass starts on a new endpoint. */
export function advanceRpcRotation(): void {
  rotation = (rotation + 1) % 1_000_000
}

/** Current cursor. Exported for tests. */
export function rpcRotation(): number {
  return rotation
}

/**
 * Dial order for one request.
 *
 * `eth_getLogs` prefers the Worker proxy: historical windows are immutable,
 * so the proxy answers from Cloudflare's edge cache after the first visitor
 * warms it, which is the difference between a 300ms chunk and a 15-24s one on
 * BSC. Everything else (overwhelmingly `eth_call` from the tile fetcher)
 * starts on the rotated direct endpoints, because those responses are not
 * cacheable and spreading them is the whole point of the pool. The proxy is
 * still appended as a last resort so a chain whose direct endpoints are all
 * failing degrades to "slow" rather than "blank".
 */
export function dialOrder(method: string, directCount: number, cursor = rotation): number[] {
  // Index 0 is the proxy; 1..directCount are the direct endpoints.
  const direct: number[] = []
  for (let i = 0; i < directCount; i++) {
    direct.push(1 + ((cursor + i) % directCount))
  }
  return method === 'eth_getLogs' ? [0, ...direct] : [...direct, 0]
}

export interface RotatingConfig {
  /**
   * Per-attempt timeout. viem's `http()` default is 10s, which this app blew
   * through constantly: a full-canvas tile load is ~200 concurrent multicalls,
   * and on a modest uplink every one of them aborted at 10s, fell through the
   * pool, aborted again, and left the loading scanner running forever. 30s
   * gives a slow connection room to finish while still failing over on a
   * genuinely dead endpoint.
   */
  timeout?: number
  /** Retries *after* the whole pool has been walked once. */
  retryCount?: number
}

/**
 * A rotating, failing-over transport over [proxy, ...direct].
 *
 * Deliberately not viem's `fallback()`: that walks its list in fixed order
 * from index 0 every time, so the first endpoint absorbs every request until
 * it errors. Failover semantics are otherwise identical - `shouldThrow` is
 * viem's own, so a reverted `eth_call` or a user-rejected request throws
 * straight through instead of being retried against every endpoint in turn.
 */
export function rotatingTransport(chainId: number, config: RotatingConfig = {}): Transport {
  const timeout = config.timeout ?? 30_000
  const urls = [workerRpcUrl(chainId), ...directRpcs(chainId)]
  return ((params) => {
    const instances = urls.map((url) =>
      http(url, { timeout, retryCount: 0 })({ ...params, retryCount: 0, timeout }),
    )
    // Typed loosely then cast: viem's `EIP1193RequestFn` is generic over the
    // RPC schema, and a hand-written `request` cannot satisfy that variance
    // without reproducing the whole schema machinery. The runtime contract
    // (take {method, params}, return the result) is what matters here.
    const request = (async ({ method, params: rpcParams }: EIP1193Parameters) => {
      const order = dialOrder(method, urls.length - 1)
      let lastError: unknown
      for (const index of order) {
        try {
          return await instances[index].request({ method, params: rpcParams } as EIP1193Parameters)
        } catch (error) {
          if (shouldThrow(error as Error)) throw error
          lastError = error
        }
      }
      throw lastError
    }) as EIP1193RequestFn

    return createTransport({
      key: 'rotating',
      name: 'Rotating RPC pool',
      type: 'rotating',
      timeout,
      retryCount: config.retryCount ?? 1,
      request,
    })
  }) as Transport
}
