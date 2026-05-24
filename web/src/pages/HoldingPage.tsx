import { TELEGRAM_URL, TWITTER_URL } from '../lib/socials'

/**
 * Pre-launch holding page. Rendered in place of the full app when
 * `VITE_HOLDING_PAGE_MODE=true` at build time. Same brand chrome as
 * the live app (dark bg, lime accent, monospace headlines) so the
 * tagwall.io eventual transition from "soon" → live feels continuous.
 *
 * Hint copy is deliberately vague: enough to set context (1M pixels,
 * on-chain, immutable, multi-chain), light on specifics. The Twitter
 * and Telegram links are the real CTAs — anyone curious enough to land
 * on the page can convert into a follower.
 */
export default function HoldingPage() {
  return (
    <main className="holding">
      <div className="holding-stack">
        <div className="holding-brand">
          <span className="brand-mark" aria-hidden />
          <span className="holding-brand-text">tagwall.io</span>
        </div>

        <div className="holding-eyebrow">— soon —</div>

        <h1 className="holding-headline">
          Immutable. On chain. Forever.
        </h1>

        <p className="holding-body">
          A graffiti wall. Pick a square. Make it permanent.
          <br />
          Coming to PulseChain, Ethereum, Base, and BSC the same day.
        </p>

        <div className="holding-chains">
          <span>PulseChain</span>
          <span>·</span>
          <span>Ethereum</span>
          <span>·</span>
          <span>Base</span>
          <span>·</span>
          <span>BSC</span>
        </div>

        <div className="holding-socials">
          <a
            className="holding-social holding-social-primary"
            href={TWITTER_URL || undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!TWITTER_URL}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M12.12 1.5h2.38l-5.2 5.93L15.4 14.5h-4.78l-3.75-4.9-4.28 4.9H.2l5.56-6.34L.34 1.5h4.9l3.4 4.48 3.48-4.48zm-.83 11.57h1.32L4.76 2.86H3.35l7.94 10.2z" />
            </svg>
            <span>Follow for launch</span>
          </a>
          {TELEGRAM_URL ? (
            <a
              className="holding-social"
              href={TELEGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M14.76 2.18 1.9 7.19c-.88.34-.87.82-.16 1.04l3.3 1.03 7.64-4.82c.36-.22.69-.1.42.14L6.92 10.2l-.24 3.57c.34 0 .49-.16.67-.35l1.6-1.56 3.32 2.45c.61.34 1.05.16 1.2-.56L15.7 3.3c.22-.89-.33-1.29-.94-1.12z" />
              </svg>
              <span>Telegram</span>
            </a>
          ) : null}
        </div>
      </div>
    </main>
  )
}
