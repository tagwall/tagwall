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
 *   3. `eth_getLogs` succeeds over a recent window at the chunk size
 *      deployBlocks.ts actually uses for that chain (the live path), and,
 *      reported separately, over the deploy-block window (cold scan, which
 *      only a mirror running without the Worker snapshot depends on)
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
  base: { id: 8453, address: V1, deployBlock: 46399049, chunk: 2000, urls: [
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org',
    'https://developer-access-mainnet.base.org',
  ]},
  bsc: { id: 56, address: V1, deployBlock: 100071283, chunk: 5000, urls: [
    'https://bsc-rpc.publicnode.com',
    'https://rpc-bsc.48.club',
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

/** Generous, because a slow endpoint is still a working one and a false
 *  failure here sends someone hunting a problem that does not exist. Every
 *  endpoint currently in the table answers in under two seconds; the headroom
 *  is for the next one that does not. */
const TIMEOUT_MS = 30_000

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

  // Two different questions, and they have different answers on several
  // chains, so ask both rather than collapsing them into one verdict.
  //
  //   live    getLogs over a *recent* window at the chain's chunk size. This
  //           is what the canvas actually does: usePaintedRegions scans from
  //           `snapshotBlock + 1`, so the live path only asks for the tail.
  //           An endpoint that fails this is useless to the app.
  //   archive getLogs over the *deploy-block* window. Only a deployment with
  //           no Worker snapshot needs this, i.e. a self-hosted mirror doing
  //           a cold scan. Failing it is a documented limitation on some
  //           chains, not a broken endpoint.
  const head = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
  if (head.fail) return { url, ok: false, why: head.fail }
  if (head.json?.error) return { url, ok: false, why: errText(head.json.error) }
  const headBlock = parseInt(head.json.result, 16)

  // Back off from head before asking for the window. Anchoring on the head
  // block races the node's own view: an endpoint that has just reported a
  // height can still answer "block range extends beyond current head" for
  // that same block a moment later.
  const tip = headBlock - 10
  const live = await getLogsWindow(url, cfg, tip - (cfg.chunk - 1), tip)
  if (live.why) return { url, ok: false, why: `live getLogs: ${live.why}` }

  const archive = await getLogsWindow(url, cfg, cfg.deployBlock, cfg.deployBlock + cfg.chunk - 1)

  return {
    url,
    ok: true,
    archive: !archive.why,
    why: archive.why ? `live ok; no archive (${archive.why})` : `${archive.count} logs, archive ok`,
    ms: live.ms,
  }
}

async function getLogsWindow(url, cfg, fromBlock, toBlock) {
  const logs = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{
    address: cfg.address,
    topics: [PAINTED_TOPIC],
    fromBlock: '0x' + Math.max(0, fromBlock).toString(16),
    toBlock: '0x' + toBlock.toString(16),
  }] })
  if (logs.fail) return { why: logs.fail }
  if (logs.json?.error) return { why: errText(logs.json.error) }
  if (!Array.isArray(logs.json?.result)) return { why: 'no result array' }
  return { count: logs.json.result.length, ms: logs.ms }
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
  const archiving = results.filter((r) => r.archive).length
  const note = passing < 2 ? '  <- no redundancy, see the pool comment in rpcPool.ts' : ''
  console.log(`  ${passing}/${results.length} usable for the live scan${note}`)
  if (passing > 0 && archiving === 0) {
    console.log('       none can cold-scan from the deploy block: fine for tagwall.io,')
    console.log('       which scans from the snapshot, but a mirror without one is stuck')
  }
}

console.log(failures ? `\n${failures} endpoint(s) failed` : '\nall configured endpoints usable')
process.exit(failures ? 1 : 0)
