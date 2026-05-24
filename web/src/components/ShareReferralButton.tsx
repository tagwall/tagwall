import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Address } from 'viem'

/**
 * "Share & earn 5%" CTA mounted in the connect bar next to the brand.
 *
 * Two modes depending on whether a wallet is connected:
 *
 *   - Connected: opens a popover with Tweet (Twitter Web Intent
 *     pre-filled with the §8 plain template), Copy referral link, and
 *     a "More templates →" link to /share.
 *   - Disconnected: renders as a plain link to /share, where the user
 *     can paste their address manually and pick a template.
 *
 * The referral URL is `<origin>/?ref=<address>`; PaintControls reads
 * the param on mount and prefills the contract's `referrer` calldata
 * field, which the canvas pays 5% to atomically per paint (Canvas.sol
 * splitBps).
 *
 * No analytics, no auth, no signup. The button is purely a friction
 * remover for the existing on-chain affiliate program.
 */
export function ShareReferralButton({ address }: { address?: Address }) {
  // Disconnected: there's no address to bake into a link, so the
  // popover would be empty. Send users to /share where they can paste
  // an address and access all six templates instead.
  if (!address) {
    return (
      <div className="share-ref">
        <Link className="share-ref-trigger" to="/share">
          Share &amp; earn 5%
        </Link>
      </div>
    )
  }
  return <ShareReferralPopover address={address} />
}

function ShareReferralPopover({ address }: { address: Address }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Build via window.location.origin so dev (localhost), preview, and
  // prod (tagwall.io) all produce a working link without env-var plumbing.
  const refUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?ref=${address}`
      : `https://tagwall.io/?ref=${address}`

  // Copy stays consistent with marketing-plan.md §8 (plain template),
  // tense-neutral so it works whether or not the user has painted yet.
  // The user can edit in the Twitter compose dialog before posting.
  const tweetText =
    `on-chain graffiti wall on tagwall.io 🎨\n\n` +
    `1,000,000 pixels. immutable. paint where you want, attach a link, ` +
    `sits there until someone pays 10% more to overwrite.\n\n` +
    `paint via my link: ${refUrl}\n` +
    `(I earn 5% in native token, you don't pay extra)`
  const tweetHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function copy() {
    try {
      await navigator.clipboard.writeText(refUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API fails in some insecure contexts. Silently no-op;
      // the user can still long-press the rendered URL below to copy.
    }
  }

  return (
    <div className="share-ref">
      <button
        ref={btnRef}
        type="button"
        className="share-ref-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Share your referral link, earn 5% on every paint"
      >
        Share & earn 5%
      </button>
      {open && (
        <div ref={menuRef} className="share-ref-menu" role="menu">
          <div className="share-ref-blurb">
            Your referral link earns 5% (native token, on-chain) on every paint someone makes from it.
          </div>
          <a
            className="share-ref-action"
            href={tweetHref}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Tweet a pre-filled post
          </a>
          <button
            type="button"
            className="share-ref-action share-ref-action-btn"
            role="menuitem"
            onClick={copy}
          >
            {copied ? 'Link copied ✓' : 'Copy referral link'}
          </button>
          <div className="share-ref-link" title={refUrl}>{refUrl}</div>
          <a
            className="share-ref-more"
            href="/share"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            More templates →
          </a>
        </div>
      )}
    </div>
  )
}
