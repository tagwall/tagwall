import { useEffect, useMemo } from 'react'
import { keccak256, stringToBytes } from 'viem'

import { useStaticFilterList } from '../hooks/useStaticFilterList'
import { useUrlSafety } from '../hooks/useUrlSafety'

interface Props {
  url: string | null
  onClose: () => void
}

/**
 * Safety interstitial shown before any outbound navigation from a pixel's
 * attached link (PRD §6: "Click-through interstitial when a user clicks a
 * pixel's link, shows destination URL, 'you are leaving tagwall' warning,
 * proceed/cancel"). The user confirms destination before the browser
 * actually navigates.
 *
 * Canvas links are user-attributed, immutable, and not reviewed by the
 * operator. This interstitial makes that clear and gives the user a look
 * at the URL before committing.
 *
 * Two layers of safety:
 *   1. Protocol guard. The contract enforces `https://` on write
 *      (Canvas.sol::_registerLink), but the modal is the last line before
 *      `window.open`, so we re-validate. Any non-https URL (javascript:,
 *      data:, vbscript:, file:, blank) is rejected outright.
 *   2. Hostname safety check via Cloudflare Security DNS (see
 *      `web/src/lib/urlSafety.ts`). Free public DoH endpoint, no API
 *      key. Fails open: while the check is in flight or if the network
 *      is unavailable, we still show the standard "leaving tagwall"
 *      warning rather than blocking the user from a legitimate link.
 */
function isSafeHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

export function OutboundLinkModal({ url, onClose }: Props) {
  // Close on Escape key so users never get trapped.
  useEffect(() => {
    if (!url) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url, onClose])

  const protocolSafe = url ? isSafeHttpsUrl(url) : false
  // Only consult the DoH check for protocol-passable URLs; non-https
  // is already rejected and there's nothing to look up.
  const { safety, isChecking } = useUrlSafety(protocolSafe ? url : null)

  // Static-list linkHash check (cpa-brief.md §2.1, Phase C). Hashes the
  // URL's UTF-8 bytes the same way Canvas.sol::_registerLink does, so an
  // operator can copy the linkHash from chain events and add it to the
  // static list without recomputing.
  const staticList = useStaticFilterList()
  const linkHashBlocked = useMemo(() => {
    if (!url || !protocolSafe) return false
    if (staticList.blockedLinkHashes.size === 0) return false
    try {
      const hash = keccak256(stringToBytes(url)).toLowerCase()
      return staticList.blockedLinkHashes.has(hash)
    } catch {
      return false
    }
  }, [url, protocolSafe, staticList])

  if (!url) return null

  // Block unconditionally if the URL fails the protocol guard, Cloudflare
  // flags the hostname, OR the operator's static list has the linkHash.
  // Anything else (safe, unknown, checking) renders the standard
  // "leaving tagwall" interstitial.
  const blocked = !protocolSafe || safety === 'blocked' || linkHashBlocked

  let hostname = ''
  if (protocolSafe) {
    hostname = new URL(url).hostname
  }

  function handleProceed() {
    if (!url || blocked) {
      onClose()
      return
    }
    // rel=noopener strips the opener reference; noreferrer also strips the
    // Referer header so tagwall isn't auto-reported to the destination.
    window.open(url, '_blank', 'noopener,noreferrer')
    onClose()
  }

  return (
    <div className="outbound-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="outbound-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{blocked ? 'Blocked: unsafe link' : "You're leaving tagwall"}</h3>
        <p className="outbound-modal-body">
          {!protocolSafe ? (
            <>
              This pixel's link is not a standard <code>https://</code> URL.
              For your safety, tagwall refuses to open it.
            </>
          ) : linkHashBlocked ? (
            <>
              This URL is on the tagwall block list (manual operator
              takedown). The on-chain link is unchanged; this frontend
              refuses to open it. Mirror operators may apply a different
              list — see <code>cpa-brief.md</code> §2.5.
            </>
          ) : safety === 'blocked' ? (
            <>
              Cloudflare's security DNS does not resolve <code>{hostname}</code>.
              The hostname may be on a malware or phishing block list, or the
              domain may no longer exist. tagwall refuses to open it.
            </>
          ) : (
            <>
              Canvas links are placed by anyone who painted a pixel. tagwall does
              not review or endorse destinations. Proceed only if you trust the site.
              {isChecking ? ' (Checking hostname safety…)' : ''}
            </>
          )}
        </p>
        <div className="outbound-modal-url">
          <span className="pixel-label">Destination</span>
          <code className="pixel-hex outbound-modal-fullurl">{url}</code>
          {protocolSafe ? (
            <span className="pixel-label outbound-modal-host">{hostname}</span>
          ) : null}
        </div>
        <div className="outbound-modal-actions">
          <button className="link-btn" onClick={onClose}>
            {blocked ? 'Close' : 'Cancel'}
          </button>
          {!blocked ? (
            <button className="wallet-btn" onClick={handleProceed} disabled={isChecking}>
              {isChecking ? 'Checking…' : 'Proceed'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
