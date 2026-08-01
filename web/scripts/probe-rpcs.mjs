#!/usr/bin/env node
/**
 * Probe every configured RPC endpoint for canvas-scan fitness.
 *
 * Run this before editing the pools in web/src/lib/rpcPool.ts or the mirror in
 * web/worker/index.js. An endpoint passes only if it gets all four right:
 *
 *   1. `eth_chainId` matches the chain we think we are dialling
 *   2. `Access-Control-Allow-Origin` admits tagwall.io (browsers dial these
 *      directly, so a CORS-less endpoint is useless no matter how fast)
 *   3. `eth_getLogs` succeeds over the deploy-block window, at the chunk size
 *      deployBlocks.ts actually uses for that chain
 *   4. it answers inside the timeout
 *
 * Point 3 is the one that matters and the one that is easy to miss. The
 * outage this script was written after (2026-08-01) came from endpoints that
 * passed every other check: publicnode put `eth_getLogs` behind an archive
 * token and eth.merkle.io dropped the method entirely, while both kept
 * serving `eth_call` and `eth_blockNumber` perfectly. The result was a site
 * whose header stats rendered fine and whose wall stayed permanently blank.
 *
 * Usage:
 *   node web/scripts/probe-rpcs.mjs                  # probe the configured pools
 *   node web/scripts/probe-rpcs.mjs <chain> <url>... # also probe candidate URLs
 *
 * Exit code is non-zero if any configured endpoint fails, so this can gate CI.
 */

const PAINTED_TOPIC = '0x5d25316e707ac9e251fa4433187862ac94eb0cae501474a1473bee69e546f899'
const V1 = '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415'
const V1_1 = '0xbe682DB4c67F723Ad52a2f7Ba7Bc982C8BBDC5A4'
const V1_2 = '0x280f4b7AD154109B35B550D8caBfAc98Fa02Fa4C'

/** Keep in step with web/src/lib/rpcPool.ts and web/worker/index.js. */
const CHAINS = {
  pulsechain: { id: 369, address: V1, deployBlock: 26606708, chunk: 9500, urls: [
    'https://rpc-pulsechain.g4mm4.io',
    'https://rpc.pulsechain.com',
  ]},
  ethereum: { id: 1, address: V1, deployBlock: 25161961, chunk: 9500, urls: [
    'https://rpc.mevblocker.io',
    'https://eth.drpc.org',
    'https://0xrpc.io/eth',
    'https://eth.api.onfinality.io/public',
  ]},
  base: { id: 8453, address: V1, deployBlock: 46399049, chunk: 9500, urls: [
    'https://base.gateway.tenderly.co',
    'https://mainnet.base.org',
    'https://base.lava.build',
    'https://developer-access-mainnet.base.org',
  ]},
  bsc: { id: 56, address: V1, deployBlock: 100071283, chunk: 9500, urls: [
    'https://bsc.rpc.blxrbdn.com',
  ]},
  hyperevm: { id: 999, address: V1_1, deployBlock: 36585579, chunk: 1000, urls: [
    'https://rpc.hypurrscan.io',
    'https://hyperliquid.rpc.blxrbdn.com',
    'https://rpc.purroofgroup.com',
    'https://hyperliquid-json-rpc.stakely.io',
    'https://rpc.hyperlend.finance',
  ]},
  robinhood: { id: 4663, address: V1_2, deployBlock: 7648180, chunk: 500000, urls: [
    'https://rpc.mainnet.chain.robinhood.com',
  ]},
}

/** BSC's only usable endpoint answers a 9.5k window in 15-24s, so the timeout
 *  has to clear that or the probe reports a false failure. */
const TIMEOUT_MS = 35_000

async function rpc(url, body) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://tagwall.io' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const cors = res.headers.get('access-control-allow-origin')
    const text = await res.text()
    try {
      return { json: JSON.parse(text), cors, ms: Date.now() - started }
    } catch {
      return { fail: `non-JSON: ${text.slice(0, 48)}`, ms: Date.now() - started }
    }
  } catch (err) {
    return { fail: String(err).slice(0, 56), ms: Date.now() - started }
  }
}

async function probe(cfg, url) {
  const id = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
  if (id.fail) return { url, ok: false, why: id.fail }
  if (id.json?.error) return { url, ok: false, why: errText(id.json.error) }

  const got = parseInt(id.json.result, 16)
  if (got !== cfg.id) return { url, ok: false, why: `wrong chain: ${got} != ${cfg.id}` }
  if (id.cors !== '*' && id.cors !== 'https://tagwall.io') {
    return { url, ok: false, why: `no CORS for tagwall.io (ACAO=${id.cors})` }
  }

  const logs = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{
    address: cfg.address,
    topics: [PAINTED_TOPIC],
    fromBlock: '0x' + cfg.deployBlock.toString(16),
    toBlock: '0x' + (cfg.deployBlock + cfg.chunk - 1).toString(16),
  }] })
  if (logs.fail) return { url, ok: false, why: `getLogs: ${logs.fail}` }
  if (logs.json?.error) return { url, ok: false, why: `getLogs: ${errText(logs.json.error)}` }
  if (!Array.isArray(logs.json?.result)) return { url, ok: false, why: 'getLogs: no result array' }

  return { url, ok: true, why: `${logs.json.result.length} logs`, ms: logs.ms }
}

function errText(error) {
  return String(error?.message ?? JSON.stringify(error)).slice(0, 60)
}

const [argChain, ...argUrls] = process.argv.slice(2)
const selected = argChain
  ? { [argChain]: { ...CHAINS[argChain], urls: argUrls.length ? argUrls : CHAINS[argChain]?.urls } }
  : CHAINS

if (argChain && !CHAINS[argChain]) {
  console.error(`unknown chain "${argChain}". known: ${Object.keys(CHAINS).join(', ')}`)
  process.exit(2)
}

let failures = 0
for (const [name, cfg] of Object.entries(selected)) {
  console.log(`\n${name} (chain ${cfg.id})`)
  const results = await Promise.all(cfg.urls.map((url) => probe(cfg, url)))
  for (const r of results) {
    if (!r.ok) failures++
    const mark = r.ok ? 'PASS' : 'FAIL'
    const ms = r.ms ? `${String(r.ms).padStart(6)}ms` : ' '.repeat(8)
    console.log(`  ${mark} ${ms}  ${r.url.padEnd(46)} ${r.why}`)
  }
  const passing = results.filter((r) => r.ok).length
  const note = passing < 2 ? '  <- no redundancy, see the pool comment in rpcPool.ts' : ''
  console.log(`  ${passing}/${results.length} usable${note}`)
}

console.log(failures ? `\n${failures} endpoint(s) failed` : '\nall configured endpoints usable')
process.exit(failures ? 1 : 0)
