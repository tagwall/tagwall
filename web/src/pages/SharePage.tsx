import { useEffect, useMemo, useState } from 'react'
import { isAddress, getAddress } from 'viem'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'

/**
 * /share — copy bank for affiliates.
 *
 * Visitors paste (or auto-fill from their connected wallet) their
 * address, and every template + the rendered referral URL update live.
 * Every card has "Tweet this" (opens X compose dialog) and "Copy text"
 * (clipboard). No backend, no analytics, fully static.
 *
 * Templates are pulled verbatim from marketing/marketing-plan.md §8. When
 * editing copy, edit it here AND in the marketing plan to keep the
 * single-source-of-truth honest.
 */

const STORAGE_KEY = 'tagwall.share.address'

interface Template {
  id: string
  audience: string
  /** Short note on when to reach for this template. */
  use: string
  /** Body. {URL} is replaced with the user's referral URL.
   *  Bracketed placeholders like [Project] are shown to the user
   *  with a callout asking them to edit before posting. */
  body: string
  /** Whether the body contains placeholders the user must edit. */
  needsEdit?: boolean
  /** Optional guidance shown beneath the card (e.g., "attach a screenshot"). */
  imageHint?: string
}

const TEMPLATES: Template[] = [
  {
    id: 'plain',
    audience: 'Plain affiliate',
    use: 'Default. Works for any community member who wants to share.',
    body:
      `🎨 just painted my tag on tagwall.io\n\n` +
      `it sits there until someone pays more to take it.\n` +
      `$0.05/pixel to start. immutable on PulseChain.\n\n` +
      `if you paint, use my link: {URL}\n` +
      `(I get 5% in native token, you don't pay extra)`,
    imageHint: 'Pair with a zoomed screenshot of your tag.',
  },
  {
    id: 'project-flag',
    audience: 'Project flag-plant',
    use: 'When a project (DAO, token, app) is announcing their region. Replace [Project] and (X,Y) before posting.',
    needsEdit: true,
    body:
      `[Project] is now on the wall.\n\n` +
      `tagwall.io is a 1,000,000-pixel on-chain canvas. We took a region and dropped our logo on it. Permanent until someone overwrites it.\n\n` +
      `tagwall.io/pixel/X,Y to see ours.\n` +
      `{URL} to paint your own (5% to us, supports the project).`,
    imageHint: 'Pair with a screenshot of your region zoomed in.',
  },
  {
    id: 'ct-alpha',
    audience: 'CT alpha caller / influencer',
    use: 'Lead with the affiliate angle, not the canvas. Frames it as a passive-income surface.',
    body:
      `Found a clean affiliate angle.\n\n` +
      `tagwall.io: on-chain canvas, immutable, 5% of every paint goes to whoever sent the painter. Pays in native token, settles on-chain, no signup.\n\n` +
      `My link: {URL}\n\n` +
      `Drop yours and let's race.`,
  },
  {
    id: 'defend',
    audience: 'Defending a region',
    use: 'Reactive. Use after someone overwrites you and you took the pixels back at +10%. Replace (X,Y).',
    needsEdit: true,
    body:
      `Someone tried to paint over [project's region]. Got it back at 1.1x.\n\n` +
      `This is the mechanic working. Every overwrite makes the next one more expensive. Every defense is a public commitment.\n\n` +
      `tagwall.io/pixel/X,Y`,
    imageHint: 'Pair with a before/after screenshot of the contested pixels.',
  },
  {
    id: 'quote-bot',
    audience: 'Quote-tweet of the bot',
    use: 'Reply or quote-tweet @tagwall_paints when it announces a notable paint. Keep it short.',
    body:
      `this is the trade of the week. paid for [W]x[H] pixels at ([X],[Y]).\n\n` +
      `cheaper than a tier 4 testnet sponsorship and the canvas can't ban you.\n\n` +
      `{URL}`,
    needsEdit: true,
  },
  {
    id: 'image-bait',
    audience: 'Image-bait',
    use: 'Any tier. Lean on the visual. The screenshot does the work.',
    body:
      `my pixel block.\n` +
      `permanent until someone pays 10% more to take it.\n` +
      `on-chain, on PulseChain, can't be moderated, can't be deleted.\n\n` +
      `{URL}`,
    imageHint: 'Required: a screenshot of your region. The tweet is image-led.',
  },
]

function buildTweetHref(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
}

function renderBody(body: string, refUrl: string): string {
  return body.replace(/\{URL\}/g, refUrl)
}

export default function SharePage() {
  const { address: connectedAddress } = useAccount()

  // Address state: priority is (1) typed input, (2) connected wallet,
  // (3) localStorage from a prior visit. The user can override at any time.
  // Persist the last-confirmed address so a returning visitor doesn't
  // have to retype.
  const [input, setInput] = useState<string>('')
  useEffect(() => {
    if (input) return
    if (connectedAddress) {
      setInput(connectedAddress)
      return
    }
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      // Non-strict + getAddress so an older lowercase-stored value still
      // restores; matches the live input validation below.
      if (stored && isAddress(stored, { strict: false })) setInput(getAddress(stored))
    } catch {
      // localStorage can be disabled; safe to ignore.
    }
    // We intentionally only run this on the FIRST mount + the moment a
    // wallet first connects. Subsequent typing in the field shouldn't
    // re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAddress])

  // Validate the input. Empty string is valid (means "no address yet"),
  // anything non-empty must parse as an address. Use non-strict mode so
  // pastes from any source (including all-lowercase or non-checksummed
  // addresses) accept; getAddress() then re-checksums for display. The
  // on-chain contract doesn't care about EIP-55 case, so being strict
  // here would reject perfectly valid addresses for no benefit.
  const validated: Address | null = useMemo(() => {
    const trimmed = input.trim()
    if (!trimmed) return null
    if (!isAddress(trimmed, { strict: false })) return null
    try {
      return getAddress(trimmed)
    } catch {
      return null
    }
  }, [input])

  // Persist on every successful validation so a refresh keeps the value.
  useEffect(() => {
    if (!validated) return
    try {
      localStorage.setItem(STORAGE_KEY, validated)
    } catch {
      // ignore
    }
  }, [validated])

  // Build the referral URL using the current origin so dev / preview /
  // prod all produce a working link without env-var plumbing.
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://tagwall.io'
  const refUrl = validated ? `${origin}/?ref=${validated}` : null

  // Embed snippet, with a 200×200 region as a defensible default.
  const embedSnippet = validated
    ? `<iframe\n  src="${origin}/embed?x=400&y=300&w=200&h=200&ref=${validated}"\n  width="600"\n  height="450"\n  style="border:0"\n  loading="lazy"\n  referrerpolicy="no-referrer-when-downgrade"\n  title="tagwall"\n></iframe>`
    : null

  // Track the last copied template-id (or 'url' / 'embed') for the
  // "Copied" toast feedback. 1.5s timer.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  useEffect(() => {
    if (!copiedId) return
    const t = setTimeout(() => setCopiedId(null), 1500)
    return () => clearTimeout(t)
  }, [copiedId])

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
    } catch {
      // ignore; user can long-press to copy from rendered text
    }
  }

  return (
    <div className="shell-measure share-page">
      <header className="share-page-header">
        <h1>Share &amp; earn 5%</h1>
        <p>
          Every paint pays 5% to the address in <code>?ref=</code> at click-time, settled
          on-chain in the chain's native token. Drop your address below and copy a template.
        </p>
        <p className="share-page-note">
          The 5% is sourced once from the URL the painter arrives on. Tweets are one-shot
          surfaces (paid per click-through). Embeds are persistent surfaces (every paint
          from that embed pays the embed host, indefinitely). See the embed snippet at the
          bottom of this page.
        </p>
      </header>

      <section className="share-form">
        <label className="share-form-label" htmlFor="share-addr">
          Your wallet address
        </label>
        <input
          id="share-addr"
          className="share-form-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="share-form-status">
          {input.trim() === '' ? (
            <span className="share-form-status-dim">
              Paste an address, or connect a wallet to auto-fill.
            </span>
          ) : validated ? (
            <span className="share-form-status-ok">Valid address ✓</span>
          ) : (
            <span className="share-form-status-err">
              That doesn't look like an Ethereum address.
            </span>
          )}
        </div>

        {refUrl && (
          <div className="share-form-url-row">
            <code className="share-form-url" title={refUrl}>
              {refUrl}
            </code>
            <button
              type="button"
              className="share-btn share-btn-secondary"
              onClick={() => copy(refUrl, 'url')}
            >
              {copiedId === 'url' ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        )}
      </section>

      <section className="share-templates" aria-label="Tweet templates">
        {TEMPLATES.map((t) => {
          const text = refUrl
            ? renderBody(t.body, refUrl)
            : renderBody(t.body, '<add your link first>')
          const tweetHref = refUrl ? buildTweetHref(text) : null
          return (
            <article key={t.id} className="share-template">
              <div className="share-template-head">
                <h2 className="share-template-audience">{t.audience}</h2>
                <p className="share-template-use">{t.use}</p>
              </div>
              <pre className="share-template-body">{text}</pre>
              {t.needsEdit && (
                <p className="share-template-edit-note">
                  Edit the bracketed placeholders before posting. The Tweet button opens
                  the X compose dialog so you can edit there.
                </p>
              )}
              {t.imageHint && (
                <p className="share-template-image-hint">📎 {t.imageHint}</p>
              )}
              <div className="share-template-actions">
                {tweetHref ? (
                  <a
                    className="share-btn"
                    href={tweetHref}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Tweet this
                  </a>
                ) : (
                  <button type="button" className="share-btn" disabled>
                    Tweet this
                  </button>
                )}
                <button
                  type="button"
                  className="share-btn share-btn-secondary"
                  onClick={() => copy(text, t.id)}
                  disabled={!refUrl}
                >
                  {copiedId === t.id ? 'Copied ✓' : 'Copy text'}
                </button>
              </div>
            </article>
          )
        })}
      </section>

      <section className="share-embed" aria-label="Embed snippet">
        <h2>Embed tagwall on your site</h2>
        <p>
          The most durable affiliate surface. Paste this into any HTML page and every paint
          from that embed pays your address, indefinitely. Adjust <code>x</code>,{' '}
          <code>y</code>, <code>w</code>, <code>h</code> to centre on your region.
        </p>
        {embedSnippet ? (
          <>
            <pre className="share-template-body share-embed-snippet">{embedSnippet}</pre>
            <div className="share-template-actions">
              <button
                type="button"
                className="share-btn share-btn-secondary"
                onClick={() => copy(embedSnippet, 'embed')}
              >
                {copiedId === 'embed' ? 'Copied ✓' : 'Copy embed snippet'}
              </button>
            </div>
          </>
        ) : (
          <p className="share-form-status-dim">Add your address above to see the snippet.</p>
        )}
      </section>
    </div>
  )
}
