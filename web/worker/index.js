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

// Per-chain RPC for reading paint calldata (public endpoints; read-only).
const RPC_BY_CHAIN = {
  '369': 'https://rpc.pulsechain.com',
  '1': 'https://eth.llamarpc.com',
  '8453': 'https://mainnet.base.org',
  '56': 'https://bsc-dataseed.binance.org',
  '999': 'https://rpc.hyperliquid.xyz/evm',
  '4663': 'https://rpc.mainnet.chain.robinhood.com',
}
const PAINT_SELECTOR = '67640514' // paint(uint32,uint32,uint32,uint32,uint32[],string,address,bytes32,uint256,uint256)
const TRANSPARENT = 0xffffffff

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/app-name') {
      return handleAppName(url)
    }
    if (url.pathname === '/api/tag-image') {
      return handleTagImage(url)
    }
    // Everything else: static assets (with SPA not-found handling).
    return env.ASSETS.fetch(request)
  },
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
