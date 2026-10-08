import type { ActiveChain } from './activeChain'

/**
 * Count one confirmed outbound link click (POST /api/click, see the click
 * counter section of web/worker/index.js). Sends only the chain and the
 * link: nothing about the viewer. A beacon, so it survives the new tab
 * opening and never delays it; any failure is silently dropped.
 */
export function recordLinkClick(chain: ActiveChain, url: string): void {
  const body = JSON.stringify({
    chain: chain.family === 'solana' ? 'solana' : String(chain.chainId),
    url,
  })
  try {
    // text/plain keeps it a "simple" request: no preflight, nothing to wait on.
    const blob = new Blob([body], { type: 'text/plain' })
    if (navigator.sendBeacon?.('/api/click', blob)) return
    void fetch('/api/click', { method: 'POST', body: blob, keepalive: true }).catch(() => {})
  } catch {
    // Counting is best-effort; the click itself must never fail because of it.
  }
}
