/**
 * Outbound-URL safety check via Cloudflare Security DNS-over-HTTPS.
 *
 * Cloudflare's `1.1.1.2` resolver (and its DoH endpoint at
 * `https://security.cloudflare-dns.com/dns-query`) returns NXDOMAIN for
 * hostnames on Cloudflare's malware/phishing block lists. This is a free,
 * public, no-API-key endpoint with CORS enabled — exactly the constraint
 * a self-hostable mirror needs. Compare to Google Safe Browsing (free
 * tier exists but requires per-operator API key registration), which
 * defeats the "download the bundle, run it" property.
 *
 * Reference:
 *   https://developers.cloudflare.com/1.1.1.1/setup/#1112-malware-blocking-only
 *   https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/
 *
 * Mirror operators with stronger compliance posture can layer additional
 * checks on top (e.g. plumb in their own Google Safe Browsing key). The
 * default ships with no external dependencies beyond the Cloudflare DoH
 * endpoint and a small in-memory cache.
 */

export type UrlSafety = 'safe' | 'blocked' | 'unknown'

/**
 * Resolve a hostname via Cloudflare's security DoH endpoint.
 *
 * Returns 'safe' if Cloudflare resolves the hostname to at least one A
 * record. Returns 'blocked' if Cloudflare answers NXDOMAIN, REFUSED, or
 * any non-NOERROR status (which is how the security tier signals a
 * malware/phishing match). Returns 'unknown' for network errors or
 * unexpected responses — callers fail-open on 'unknown' to avoid
 * punishing users for our outage.
 *
 * One subtle case: a typo'd or genuinely-dead domain also resolves as
 * 'blocked' (the resolver can't tell us why something doesn't exist).
 * From the user's perspective this is fine: a click-through warning to
 * a non-existent destination is a helpful warning, not a false positive.
 */
export async function checkHostnameSafety(hostname: string, signal?: AbortSignal): Promise<UrlSafety> {
  try {
    const url =
      'https://security.cloudflare-dns.com/dns-query?name=' +
      encodeURIComponent(hostname) +
      '&type=A'
    const r = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal,
    })
    if (!r.ok) return 'unknown'
    const j = (await r.json()) as { Status?: number; Answer?: unknown[] }
    if (j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0) return 'safe'
    // 3 = NXDOMAIN; 5 = REFUSED. Either way, Cloudflare won't resolve it.
    return 'blocked'
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return 'unknown'
    return 'unknown'
  }
}

/**
 * Convenience: extract the hostname from a URL string and check it. Returns
 * 'unknown' for malformed URLs (the protocol-level guard in OutboundLinkModal
 * has already rejected non-https URLs by the time we get here, so a
 * URL-parse failure at this layer is an edge case).
 */
export async function checkUrlSafety(rawUrl: string, signal?: AbortSignal): Promise<UrlSafety> {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname
  } catch {
    return 'unknown'
  }
  if (!hostname) return 'unknown'
  return checkHostnameSafety(hostname, signal)
}
