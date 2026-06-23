/**
 * Cloudflare Worker entrypoint.
 *
 * Serves the static canvas app through the ASSETS binding (Workers Static
 * Assets), and adds one small server-side endpoint, /api/app-name, so the
 * frontend can label App Store / Google Play links ("Ching Ching for iOS")
 * without injecting a third-party script into the browser. Apple's iTunes
 * Lookup sends no CORS header, so the lookup has to happen off-origin; doing
 * it here (server-side) keeps the page free of JSONP.
 */

const CORS_HEADERS = { 'access-control-allow-origin': '*' }
const DAY = 86400

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/app-name') {
      return handleAppName(url)
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
