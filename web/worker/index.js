/**
 * Cloudflare Worker entrypoint.
 *
 * Serves the static canvas app through the ASSETS binding (Workers Static
 * Assets), plus two small server-side endpoints:
 *   - /api/app-name   resolves App Store / Play names for the link labels
 *                     ("Ching Ching for iOS"), so the page needs no JSONP.
 *   - /api/tag-image  renders a painted tag (decoded from its paint tx
 *                     calldata) as an upscaled PNG, used to embed the image
 *                     in the paint-alert GitHub Discussions.
 */

const CORS_HEADERS = { 'access-control-allow-origin': '*' }
const DAY = 86400

/**
 * Per-chain upstream RPC pools (public endpoints, read-only).
 *
 * Mirrors web/src/lib/rpcPool.ts — keep the two in step. Every URL was probed
 * on 2026-08-01 for correct chainId, CORS, and a real `eth_getLogs` at the
 * deploy-block window. The previous single-URL map here had rotted:
 * eth.llamarpc.com now answers Cloudflare 521, and bsc-dataseed.binance.org
 * prunes logs, so /api/tag-image was already failing on Ethereum and BSC.
 *
 * Maintaining the pool here as well as in the frontend is deliberate: a dead
 * upstream can be swapped by redeploying the Worker alone, with no frontend
 * build, and browsers dialling /api/rpc pick the change up immediately.
 */
const RPC_POOL = {
  '369': ['https://rpc-pulsechain.g4mm4.io', 'https://rpc.pulsechain.com'],
  '1': [
    'https://rpc.mevblocker.io',
    'https://eth.drpc.org',
    'https://0xrpc.io/eth',
    'https://eth.api.onfinality.io/public',
  ],
  '8453': [
    'https://base.gateway.tenderly.co',
    'https://mainnet.base.org',
    'https://base.lava.build',
    'https://developer-access-mainnet.base.org',
  ],
  '56': ['https://bsc.rpc.blxrbdn.com'],
  '999': [
    'https://rpc.hypurrscan.io',
    'https://hyperliquid.rpc.blxrbdn.com',
    'https://rpc.purroofgroup.com',
    'https://hyperliquid-json-rpc.stakely.io',
    'https://rpc.hyperlend.finance',
  ],
  '4663': ['https://rpc.mainnet.chain.robinhood.com'],
  '943': ['https://rpc-testnet-pulsechain.g4mm4.io'],
}

/**
 * Methods /api/rpc will forward. The proxy is a public endpoint on
 * tagwall.io, so it stays read-only: no `eth_sendRawTransaction`, no
 * `personal_*`, no `debug_*`. Paints are signed and broadcast by the user's
 * own wallet provider, never through this path, so nothing legitimate needs
 * write access here.
 */
const RPC_METHOD_ALLOWLIST = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
])

/** Body cap. A full tile multicall is ~120 KB of aggregate3 calldata; 2 MB
 *  leaves generous headroom without letting the proxy be used as a pipe. */
const MAX_RPC_BODY = 2 * 1024 * 1024

/** Blocks behind head that we treat as reorg-safe. A getLogs window entirely
 *  below head - this can never change, so it is cached immutably at the edge.
 *  Deliberately generous: a stale-but-correct cache entry costs nothing, a
 *  cached reorged log would be wrong forever. */
const REORG_DEPTH = 128

/** Rotation cursor for upstream selection, per isolate. */
let poolCursor = 0
const PAINT_SELECTOR = '67640514' // paint(uint32,uint32,uint32,uint32,uint32[],string,address,bytes32,uint256,uint256)
const TRANSPARENT = 0xffffffff

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/api/app-name') {
      return handleAppName(url)
    }
    if (url.pathname === '/api/tag-image') {
      return handleTagImage(url)
    }
    const rpcMatch = url.pathname.match(/^\/api\/rpc\/(\d+)$/)
    if (rpcMatch) {
      return handleRpc(request, rpcMatch[1], ctx)
    }
    const snapMatch = url.pathname.match(/^\/api\/canvas\/(\d+)\/snapshot$/)
    if (snapMatch) {
      return handleSnapshot(snapMatch[1], env)
    }
    if (url.pathname === '/api/canvas/status') {
      return handleSnapshotStatus(env)
    }
    // Everything else: static assets (with SPA not-found handling).
    return env.ASSETS.fetch(request)
  },

  /** Cron entrypoint: advances each chain's paint snapshot. See buildSnapshot. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshSnapshots(env))
  },
}

/* ------------------------------------------------------------------ *
 * POST /api/rpc/<chainId>
 *
 * Same-origin, read-only JSON-RPC proxy over the chain's upstream pool.
 * Exists for three reasons:
 *
 *   1. Rotation and failover happen server-side, so a dead upstream can be
 *      swapped by redeploying the Worker with no frontend build.
 *   2. Historical `eth_getLogs` windows are immutable once they sit below the
 *      reorg horizon, so they are cached at Cloudflare's edge. The first
 *      visitor to a chain warms it for everyone else. On BSC, whose only
 *      usable public endpoint takes 15-24s per 9.5k-block chunk, this is the
 *      difference between an unusable cold load and a fast one.
 *   3. It gives chains with a thin public landscape (PulseChain, BSC,
 *      Robinhood) an extra dial target that is not a single point of failure
 *      in the same way a lone direct endpoint is.
 * ------------------------------------------------------------------ */
async function handleRpc(request, chainId, ctx) {
  const preflight = {
    ...CORS_HEADERS,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: preflight })
  if (request.method !== 'POST') {
    return json({ error: 'POST only' }, 405)
  }
  const upstreams = RPC_POOL[chainId]
  if (!upstreams) return json({ error: `unsupported chain ${chainId}` }, 404)

  const raw = await request.text()
  if (raw.length > MAX_RPC_BODY) return json({ error: 'body too large' }, 413)

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }
  // Batch requests are not forwarded: they would let one call fan out past
  // the allowlist check and complicate cacheability for no benefit here.
  if (Array.isArray(body)) return rpcError(null, -32600, 'Batch requests not supported')
  const method = body?.method
  if (typeof method !== 'string' || !RPC_METHOD_ALLOWLIST.has(method)) {
    return rpcError(body?.id ?? null, -32601, `Method not supported: ${method}`)
  }

  const cacheKey = await immutableCacheKey(chainId, method, body.params, upstreams)
  if (cacheKey) {
    const hit = await caches.default.match(cacheKey)
    if (hit) return withCors(hit, 'HIT')
  }

  const upstreamResponse = await poolFetch(upstreams, raw)
  if (!upstreamResponse) {
    return rpcError(body?.id ?? null, -32603, 'All upstream RPCs failed')
  }
  const text = await upstreamResponse.text()

  const response = new Response(text, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheKey ? `public, max-age=${DAY}, immutable` : 'no-store',
      ...CORS_HEADERS,
    },
  })
  // Only cache successful, error-free payloads. A cached -32602 would pin an
  // upstream's policy error in front of every visitor for a day.
  if (cacheKey && !text.includes('"error"')) {
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()))
  }
  return withCors(response, cacheKey ? 'MISS' : 'BYPASS')
}

function withCors(response, cacheStatus) {
  const out = new Response(response.body, response)
  out.headers.set('access-control-allow-origin', '*')
  out.headers.set('x-tagwall-cache', cacheStatus)
  return out
}

function rpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

/**
 * Cache key for a request whose answer can never change, or null if it can.
 *
 * Only `eth_getLogs` over a window that ends below the reorg horizon
 * qualifies. Everything else (`eth_call` at latest, head queries) is served
 * fresh. Determining the horizon costs one `eth_blockNumber`, which is itself
 * cheap and heavily deduplicated by the edge.
 */
async function immutableCacheKey(chainId, method, params, upstreams) {
  if (method !== 'eth_getLogs') return null
  const filter = params?.[0]
  const toBlock = filter?.toBlock
  if (typeof toBlock !== 'string' || !toBlock.startsWith('0x')) return null
  const head = await currentHead(chainId, upstreams)
  if (head === null || parseInt(toBlock, 16) > head - REORG_DEPTH) return null
  // Key on the semantic content, not the raw body, so differing whitespace or
  // JSON-RPC ids still hit the same entry.
  const canonical = JSON.stringify({ chainId, method, filter })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return new Request(`https://tagwall.io/__rpccache/${chainId}/${hex}`)
}

const headCache = new Map()

/** Chain head, memoised for 12s per isolate so a burst of tile requests does
 *  not turn into a burst of eth_blockNumber calls. */
async function currentHead(chainId, upstreams) {
  const cached = headCache.get(chainId)
  if (cached && Date.now() - cached.at < 12_000) return cached.head
  const res = await poolFetch(
    upstreams,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  )
  if (!res) return null
  try {
    const result = (await res.json())?.result
    if (typeof result !== 'string') return null
    const head = parseInt(result, 16)
    headCache.set(chainId, { head, at: Date.now() })
    return head
  } catch {
    return null
  }
}

/**
 * POST `body` to the pool, rotating the starting upstream and failing over on
 * transport errors or JSON-RPC errors. Returns the first clean response, or
 * null if every upstream failed.
 *
 * Failing over on a JSON-RPC *error* (not just a transport failure) is the
 * point: the endpoints that broke this app returned HTTP 200 with a -32602 or
 * -32601 body. A proxy that only failed over on network errors would have
 * dutifully served those through.
 */
async function poolFetch(upstreams, body, { timeoutMs = 25_000 } = {}) {
  const start = poolCursor++ % upstreams.length
  let lastOk = null
  for (let i = 0; i < upstreams.length; i++) {
    const url = upstreams[(start + i) % upstreams.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue
      const text = await res.text()
      if (text.includes('"error"')) {
        // Keep it as a last resort: an execution revert is a legitimate answer
        // and should be returned if no upstream does better.
        lastOk = text
        continue
      }
      return new Response(text, { headers: { 'content-type': 'application/json' } })
    } catch {
      // try the next upstream
    }
  }
  return lastOk ? new Response(lastOk, { headers: { 'content-type': 'application/json' } }) : null
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${DAY}`,
      ...CORS_HEADERS,
    },
  })
}

/**
 * GET /api/app-name?platform=ios&id=<trackId>
 * GET /api/app-name?platform=android&id=<packageName>
 * -> { name: string | null }
 */
async function handleAppName(url) {
  const platform = url.searchParams.get('platform')
  const id = url.searchParams.get('id') || ''

  try {
    if (platform === 'ios') {
      if (!/^\d+$/.test(id)) return json({ name: null })
      const res = await fetch(
        `https://itunes.apple.com/lookup?id=${id}`,
        { cf: { cacheTtl: DAY, cacheEverything: true } },
      )
      const data = await res.json()
      const name = data?.results?.[0]?.trackName
      return json({ name: typeof name === 'string' && name ? name : null })
    }

    if (platform === 'android') {
      // No first-party Play lookup API; parse the store page's og:title.
      // Best effort, package id is sanitised to the allowed charset.
      if (!/^[A-Za-z0-9._]+$/.test(id)) return json({ name: null })
      const res = await fetch(
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}&hl=en`,
        { cf: { cacheTtl: DAY, cacheEverything: true } },
      )
      const html = await res.text()
      const m =
        html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
        html.match(/<title>([^<]+)<\/title>/i)
      let name = m ? m[1].trim() : null
      if (name) name = name.replace(/\s*[-–]\s*Apps on Google Play\s*$/i, '').trim()
      return json({ name: name || null })
    }
  } catch {
    // fall through
  }
  return json({ name: null })
}

/* ------------------------------------------------------------------ *
 * /api/tag-image?chain=<id>&tx=<hash>
 *
 * Reads the paint transaction's calldata, decodes the submitted pixel
 * colours, and returns the stamp as a nearest-neighbour-upscaled PNG. Used
 * to embed the painted image in the paint-alert GitHub Discussions. Cached
 * a day (a paint is immutable).
 * ------------------------------------------------------------------ */
const MAX_OUT = 480 // cap the longest upscaled side

async function handleTagImage(url) {
  const chain = url.searchParams.get('chain') || ''
  const tx = (url.searchParams.get('tx') || '').toLowerCase()
  const rpc = RPC_BY_CHAIN[chain]
  if (!rpc || !/^0x[0-9a-f]{64}$/.test(tx)) {
    return new Response('bad request', { status: 400, headers: CORS_HEADERS })
  }
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [tx] }),
    })
    const input = (await res.json())?.result?.input
    const decoded = decodePaint(input)
    if (!decoded) return new Response('not a paint', { status: 404, headers: CORS_HEADERS })
    const png = await renderPng(decoded)
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        'cache-control': `public, max-age=${DAY}, immutable`,
        ...CORS_HEADERS,
      },
    })
  } catch {
    return new Response('render failed', { status: 500, headers: CORS_HEADERS })
  }
}

/** Decode paint() calldata -> { w, h, colors: Uint32Array }. */
function decodePaint(inputHex) {
  if (typeof inputHex !== 'string') return null
  let hex = inputHex.startsWith('0x') ? inputHex.slice(2) : inputHex
  if (hex.slice(0, 8).toLowerCase() !== PAINT_SELECTOR) return null
  const args = hexToBytes(hex.slice(8))
  // ABI word reader (big-endian, value taken from the low 6 bytes — enough
  // for our uint32 dims/colours and the small dynamic offsets).
  const word = (i) => {
    let v = 0
    for (let b = 26; b < 32; b++) v = v * 256 + args[i * 32 + b]
    return v
  }
  const w = word(2)
  const h = word(3)
  if (w <= 0 || h <= 0 || w * h > 4_000_000) return null
  const colorsOff = word(4) // byte offset into args
  const n = readUint(args, colorsOff)
  if (n !== w * h) return null
  const colors = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    // each colour is a uint32 in the low 4 bytes of its 32-byte word
    const base = colorsOff + 32 + i * 32 + 28
    colors[i] = ((args[base] << 24) | (args[base + 1] << 16) | (args[base + 2] << 8) | args[base + 3]) >>> 0
  }
  return { w, h, colors }
}

function readUint(bytes, byteOffset) {
  let v = 0
  for (let b = 26; b < 32; b++) v = v * 256 + bytes[byteOffset + b]
  return v
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/** Build an upscaled RGB raster and PNG-encode it. */
async function renderPng({ w, h, colors }) {
  const scale = Math.max(1, Math.floor(MAX_OUT / Math.max(w, h)))
  const W = w * scale
  const H = h * scale
  // PNG raw: each row prefixed with a filter byte (0 = none), then RGB.
  const stride = W * 3 + 1
  const raw = new Uint8Array(stride * H)
  const BG = [11, 11, 16] // #0b0b10 backdrop for transparent pixels
  for (let oy = 0; oy < H; oy++) {
    const sy = (oy / scale) | 0
    let p = oy * stride + 1 // skip filter byte (already 0)
    for (let ox = 0; ox < W; ox++) {
      const sx = (ox / scale) | 0
      const c = colors[sy * w + sx]
      let r, g, b
      if ((c & 0xffffffff) === TRANSPARENT) {
        r = BG[0]; g = BG[1]; b = BG[2]
      } else {
        r = (c >>> 16) & 0xff; g = (c >>> 8) & 0xff; b = c & 0xff
      }
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, W)
  dv.setUint32(4, H)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  // 10,11,12 = compression/filter/interlace = 0
  const idat = await zlibDeflate(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))])
}

async function zlibDeflate(bytes) {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concat(arrays) {
  let len = 0
  for (const a of arrays) len += a.length
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/* ------------------------------------------------------------------ *
 * GET /api/canvas/<chainId>/snapshot
 *
 * The cold-load fix.
 *
 * Reconstructing the canvas from chain state alone means walking every
 * Painted event from the deploy block (a serial `eth_getLogs` paginate) and
 * then reading every painted pixel back with `pixelAt`. Both halves have aged
 * badly: on BSC the log walk is 1,385 chunks at 15-24s each, and a full-canvas
 * tile load was issuing ~200 concurrent multicalls holding ~40 MB of calldata.
 *
 * Neither is necessary. A paint's pixel colours are already in its own
 * transaction calldata, which `decodePaint` above has always known how to
 * read. So a cron job walks the logs once, decodes each paint's colours, and
 * parks the result in KV. The browser fetches one JSON, renders the whole
 * historical canvas from it, and only scans chain state forward from
 * `snapshotBlock`.
 *
 * Progress is incremental and resumable. Each cron run advances the scan by a
 * bounded number of subrequests and writes back what it got, so a chain whose
 * backfill needs hundreds of calls converges over successive runs instead of
 * blowing the per-invocation subrequest limit. Partial snapshots are served
 * happily: the frontend just scans forward from whatever `snapshotBlock` it
 * is given, so a half-built snapshot is strictly better than none.
 * ------------------------------------------------------------------ */

/** Painted(address,address,bytes32,uint32,uint32,uint32,uint32,uint32,uint256,uint32) */
const PAINTED_TOPIC = '0x5d25316e707ac9e251fa4433187862ac94eb0cae501474a1473bee69e546f899'

/** Canvas address and deploy block per chain. Mirrors web/src/contracts/canvas.ts
 *  and web/src/lib/deployBlocks.ts. */
const CANVAS_BY_CHAIN = {
  '1': { address: '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415', deployBlock: 25161961, chunk: 9500 },
  '56': { address: '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415', deployBlock: 100071283, chunk: 9500 },
  '369': { address: '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415', deployBlock: 26606708, chunk: 9500 },
  '8453': { address: '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415', deployBlock: 46399049, chunk: 9500 },
  '999': { address: '0xbe682DB4c67F723Ad52a2f7Ba7Bc982C8BBDC5A4', deployBlock: 36585579, chunk: 1000 },
  '4663': { address: '0x280f4b7AD154109B35B550D8caBfAc98Fa02Fa4C', deployBlock: 7648180, chunk: 500000 },
}

/**
 * Subrequest budget for one cron invocation, shared across all chains.
 *
 * Workers caps subrequests per invocation at 50 on the free plan and 1000 on
 * Workers Paid. 45 is the safe figure; raise it toward ~900 on Paid and the
 * backfills finish in a couple of runs instead of over an hour. The budget is
 * spent on `eth_getLogs` chunks plus one `eth_getTransactionByHash` per newly
 * seen paint.
 */
const CRON_SUBREQUEST_BUDGET = 45

/**
 * Wall-clock budget for one cron pass, milliseconds.
 *
 * A run only writes KV once, at the end of `advanceSnapshot`, so anything the
 * platform kills mid-pass is work thrown away. BSC's sole usable endpoint
 * answers a 9.5k-block chunk in 15-24s, so a full 45-subrequest pass there
 * would run ~15 minutes and sit right on the invocation limit. Stopping at 20s
 * and persisting what we have keeps every pass durable: the next run resumes
 * from the stored cursor.
 */
const CRON_TIME_BUDGET_MS = 120_000

/**
 * Concurrent `eth_getLogs` chunks per backfill pass.
 *
 * Sequential scanning cannot finish BSC. Its only usable endpoint answers a
 * 9.5k window in 10-24s and refuses wider ranges (a 50k window hits the
 * node's own 30s timeout), so one chunk per 20s against 1,385 chunks is a
 * multi-day backfill.
 *
 * Probed 2026-08-01: that endpoint serves 4 concurrent chunks cleanly (all
 * four returned inside 20s) and collapses at 8, where half time out. So 4 is
 * the measured ceiling, not a guess. The other chains are far faster and
 * nowhere near any limit at this width.
 */
const SCAN_CONCURRENCY = 4

async function handleSnapshot(chainId, env) {
  if (!CANVAS_BY_CHAIN[chainId]) return json({ error: `unsupported chain ${chainId}` }, 404)
  if (!env.SNAPSHOTS) return json({ error: 'snapshot store not bound' }, 503)
  const stored = await env.SNAPSHOTS.get(`snapshot:${chainId}`)
  if (!stored) {
    // Nothing built yet. Not an error: the frontend falls back to scanning
    // from the deploy block, exactly as it did before snapshots existed.
    return json({ chainId: Number(chainId), snapshotBlock: null, regions: [], pending: true })
  }
  return new Response(stored, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short TTL: a new paint should show up quickly. The heavy history
      // inside is what we are avoiding refetching, not the freshness.
      'cache-control': 'public, max-age=30',
      ...CORS_HEADERS,
    },
  })
}

/**
 * One cron pass.
 *
 * Two-phase, because the two jobs have very different costs. Keeping a
 * finished snapshot current costs about two calls (head, plus one log chunk
 * covering the reorg window). Backfilling one from the deploy block costs
 * hundreds, and on BSC over a thousand. Interleaving them naively let the
 * first chain in the map swallow the whole budget every run, so the rest
 * never started at all.
 *
 * So: top up every complete chain first, then hand the entire remaining
 * budget to a single backfilling chain, rotating which one across runs. That
 * finishes backfills as fast as the budget allows instead of advancing six of
 * them a few chunks at a time, while never letting a long backfill stall the
 * freshness of the chains that are already done.
 */
/**
 * GET /api/canvas/status
 *
 * Backfill progress for every chain, without the region payloads. Answers
 * "is the snapshot for chain X built yet, and if not how far along is it",
 * which is otherwise invisible: the cron runs detached and a failing chain
 * looks identical to one that has not had its turn.
 */
async function handleSnapshotStatus(env) {
  if (!env.SNAPSHOTS) return json({ error: 'snapshot store not bound' }, 503)
  const chains = {}
  for (const chainId of Object.keys(CANVAS_BY_CHAIN)) {
    const raw = await env.SNAPSHOTS.get(`snapshot:${chainId}`)
    const state = raw ? safeParse(raw) : null
    chains[chainId] = state
      ? {
          snapshotBlock: state.snapshotBlock,
          cursor: state.cursor,
          complete: state.complete,
          regionCount: state.regionCount,
          pixelsPending: (state.regions ?? []).filter((r) => !r.pixels && !r.pixelsUnavailable).length,
          generatedAt: state.generatedAt,
          lastError: state.lastError ?? null,
        }
      : null
  }
  return json({ turn: Number((await env.SNAPSHOTS.get('snapshot:turn')) ?? '0'), chains })
}

/**
 * Is this chain close enough to head that one cheap pass keeps it current?
 *
 * True for a complete snapshot, and for one whose remaining backlog fits in a
 * single pass. Uses the head recorded on the last pass, so it costs nothing.
 */
function isNearHead(chainId, state) {
  if (state.complete) return true
  const cfg = CANVAS_BY_CHAIN[chainId]
  if (!cfg || typeof state.head !== 'number' || typeof state.snapshotBlock !== 'number') return false
  return state.head - state.snapshotBlock <= cfg.chunk * SCAN_CONCURRENCY
}

async function refreshSnapshots(env) {
  if (!env.SNAPSHOTS) return
  let budget = CRON_SUBREQUEST_BUDGET

  const chains = Object.keys(CANVAS_BY_CHAIN)
  const states = []
  for (const chainId of chains) {
    const raw = await env.SNAPSHOTS.get(`snapshot:${chainId}`)
    states.push([chainId, raw ? safeParse(raw) : null])
  }

  // Phase 1: keep caught-up snapshots fresh, every run.
  //
  // "Caught up" deliberately includes chains that are merely close to head,
  // not just complete ones. A single transient getLogs failure sets complete
  // to false, and on a strict reading that demoted a finished chain into the
  // backfill rotation behind BSC's thousand-chunk walk, where it waited turns
  // to recover from a blip it could have cleared in one pass.
  for (const [chainId, state] of states) {
    if (!state || !isNearHead(chainId, state)) continue
    if (budget <= 2) return
    budget -= await advanceSnapshot(chainId, state, env, Math.min(budget, 8))
  }

  // Phase 2: one real backfill, rotated so every chain gets its turn.
  const pending = states.filter(([chainId, state]) => !state || !isNearHead(chainId, state))
  if (!pending.length || budget <= 2) return
  const turn = Number((await env.SNAPSHOTS.get('snapshot:turn')) ?? '0')
  await env.SNAPSHOTS.put('snapshot:turn', String((turn + 1) % 1_000_000))
  const [chainId, state] = pending[turn % pending.length]
  await advanceSnapshot(chainId, state, env, budget)
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Advance one chain's snapshot. Returns the number of subrequests spent.
 *
 * Regions are appended in (blockNumber, logIndex) order, which is also the
 * order the canvas must be replayed in: for any overlapping pixel the later
 * paint wins, so a consumer painting regions in array order lands on the same
 * state the chain is in.
 */
async function advanceSnapshot(chainId, state, env, budget, deadline = Date.now() + CRON_TIME_BUDGET_MS) {
  const cfg = CANVAS_BY_CHAIN[chainId]
  const upstreams = RPC_POOL[chainId]
  if (!cfg || !upstreams) return 0

  let spent = 0
  const head = await currentHead(chainId, upstreams)
  spent += 1
  if (head === null) {
    // Persist the failure rather than returning silently: without this a chain
    // whose upstreams are all down is indistinguishable from one that simply
    // has not had its rotation turn yet. Surfaced by /api/canvas/status.
    await env.SNAPSHOTS.put(
      `snapshot:${chainId}`,
      JSON.stringify({
        ...(state ?? { chainId: Number(chainId), regions: [], complete: false, snapshotBlock: null }),
        lastError: `no head from ${upstreams.length} upstream(s)`,
        generatedAt: new Date().toISOString(),
      }),
    )
    return spent
  }

  const regions = state?.regions ?? []
  let cursor = state?.cursor ?? cfg.deployBlock
  // Rewind a little each pass so a paint that landed near the previous run's
  // head, and could still have been reorged out, is re-resolved.
  //
  // The rewind may only ever move the cursor BACKWARDS. Setting it to
  // `head - REORG_DEPTH * 4` outright skipped blocks on a fast chain:
  // Robinhood mints ~600 blocks a minute and the cron runs every two, so each
  // pass jumped ~1,200 blocks forward while rewinding only 512, silently
  // leaving ~700 unscanned. A paint landing in that gap would never appear.
  cursor = Math.min(cursor, Math.max(cfg.deployBlock, head - REORG_DEPTH * 4))
  const seen = new Set(regions.map((r) => `${r.txHash}:${r.logIndex}`))

  let scannedTo = state?.snapshotBlock ?? cfg.deployBlock - 1
  // Scan in concurrent batches. The batch advances `scannedTo` only as far as
  // its longest unbroken run of successes, so a failure mid-batch rewinds the
  // cursor to just before it rather than leaving a hole that nothing revisits.
  scan: while (cursor <= head && spent < budget - 1 && Date.now() < deadline) {
    const windows = []
    for (let i = 0; i < SCAN_CONCURRENCY && cursor <= head && spent < budget - 1; i++) {
      const to = Math.min(cursor + cfg.chunk - 1, head)
      windows.push({ from: cursor, to })
      spent += 1
      cursor = to + 1
    }
    if (!windows.length) break

    const responses = await Promise.all(windows.map((w) => poolFetch(
      upstreams,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          address: cfg.address,
          topics: [PAINTED_TOPIC],
          fromBlock: '0x' + w.from.toString(16),
          toBlock: '0x' + w.to.toString(16),
        }],
      }),
    )))

    for (let i = 0; i < windows.length; i++) {
      const res = responses[i]
      const logs = res ? (await res.json())?.result : null
      if (!Array.isArray(logs)) {
        // Resume from this window next pass and drop the rest of the batch.
        cursor = windows[i].from
        break scan
      }
      for (const log of logs) {
        const key = `${log.transactionHash}:${parseInt(log.logIndex, 16)}`
        if (seen.has(key)) continue
        seen.add(key)
        const region = decodePaintedLog(log)
        if (region) regions.push(region)
      }
      scannedTo = windows[i].to
    }
  }

  // Fill in pixel colours for regions that do not have them yet, newest first
  // so a fresh paint becomes renderable before an old backfill completes.
  const missing = regions.filter((r) => !r.pixels && !r.pixelsUnavailable)
  missing.sort((a, b) => b.blockNumber - a.blockNumber)
  for (let i = 0; i < missing.length; i += SCAN_CONCURRENCY) {
    if (spent >= budget || Date.now() >= deadline) break
    const batch = missing.slice(i, i + SCAN_CONCURRENCY)
    spent += batch.length
    const responses = await Promise.all(batch.map((region) => poolFetch(
      upstreams,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [region.txHash] }),
    )))
    for (let j = 0; j < batch.length; j++) {
      const res = responses[j]
      if (!res) continue
      const input = (await res.json())?.result?.input
      const decoded = decodePaint(input)
      // A paint tx submitted through a router or multicall would not decode
      // here; leaving pixels null is fine, the frontend reads those from chain
      // state as before. Marking it unavailable stops us retrying it forever.
      if (decoded && decoded.w === batch[j].w && decoded.h === batch[j].h) {
        batch[j].pixels = base64FromUint32(decoded.colors)
      } else {
        batch[j].pixels = null
        batch[j].pixelsUnavailable = true
      }
    }
  }

  regions.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

  const complete = cursor > head
  const payload = {
    chainId: Number(chainId),
    address: cfg.address,
    snapshotBlock: scannedTo,
    cursor,
    complete,
    // Chain head as of this pass. Lets the scheduler judge how far behind a
    // chain is without spending a subrequest to ask.
    head,
    generatedAt: new Date().toISOString(),
    regionCount: regions.length,
    regions,
  }
  await env.SNAPSHOTS.put(`snapshot:${chainId}`, JSON.stringify(payload))
  return spent
}

/** Painted log -> region record. Data layout is the non-indexed tail:
 *  x, y, w, h, pixelsPainted, pricePaid, linkId. */
function decodePaintedLog(log) {
  const data = typeof log.data === 'string' ? log.data.slice(2) : ''
  if (data.length < 7 * 64) return null
  const word = (i) => parseInt(data.slice(i * 64, (i + 1) * 64), 16)
  const topicAddress = (t) => '0x' + String(t).slice(26)
  const w = word(2)
  const h = word(3)
  if (!(w > 0 && h > 0)) return null
  return {
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
    txHash: log.transactionHash,
    painter: topicAddress(log.topics?.[1]),
    referrer: topicAddress(log.topics?.[2]),
    metadataHash: log.topics?.[3] ?? null,
    x: word(0),
    y: word(1),
    w,
    h,
    pixelsPainted: word(4),
    // pricePaid can exceed Number.MAX_SAFE_INTEGER in wei, so keep it as the
    // hex string and let the consumer BigInt it.
    pricePaid: '0x' + data.slice(5 * 64, 6 * 64).replace(/^0+/, ''),
    linkId: word(6),
    pixels: null,
  }
}

/** uint32 colours -> base64 of big-endian 4-byte words. */
function base64FromUint32(colors) {
  const bytes = new Uint8Array(colors.length * 4)
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i] >>> 0
    bytes[i * 4] = (c >>> 24) & 0xff
    bytes[i * 4 + 1] = (c >>> 16) & 0xff
    bytes[i * 4 + 2] = (c >>> 8) & 0xff
    bytes[i * 4 + 3] = c & 0xff
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
