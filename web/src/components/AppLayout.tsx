import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import type * as React from 'react'
import { useAccount, useChainId } from 'wagmi'

import { canvasAddress } from '../contracts/canvas'
import { useLivePaintedRefresh } from '../hooks/useLivePaintedRefresh'
import { chainColorTokens } from '../lib/chainColor'
import { TELEGRAM_URL, TWITTER_URL } from '../lib/socials'
import { ConnectBar } from './ConnectBar'
import { SprayTrail } from './SprayTrail'

/**
 * Shared chrome for every route: ConnectBar at the top, page content via
 * <Outlet />, footer at the bottom. Mounts useLivePaintedRefresh once so
 * incoming Painted events invalidate region + pixel caches across routes.
 *
 * Chain-aware accent: when a wallet is connected, --tw-accent /
 * --accent / --accent-2 are overridden at the .app scope so EVERY
 * accent surface (CTAs, brand mark, leaderboard rank-1, slider thumb,
 * lime number badges, etc.) flips together. Pre-connect falls back to
 * the brand lime via the :root defaults.
 */
export function AppLayout() {
  useLivePaintedRefresh()
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const tokens = chainColorTokens(isConnected ? chainId : null)
  // Memory-leak fix: when the user switches chains, remove every cached
  // query whose chain id doesn't match the active chain. Without this,
  // each tile's react-query entry (chainId is in the queryKey) survived
  // for gcTime (15s) holding a Uint32Array + the multicall response
  // buffer; rapidly cycling chains stacked 70 tile queries × N chains'
  // worth of buffers up to several GB. Eager removal drops them
  // immediately when the user is no longer looking at that chain.
  const queryClient = useQueryClient()
  useEffect(() => {
    queryClient.removeQueries({
      predicate: (q) => {
        const k = q.queryKey
        if (!Array.isArray(k)) return false
        const head = k[0]
        // Chain-scoped query keys we know to scrub. The chainId lives at
        // index 1 for both 'painted-regions' and 'tile-pixels'; same
        // rule for any future chain-keyed query — extend the list when
        // adding one. Keys without a chain id (e.g. UI-only state) are
        // left alone.
        if (head !== 'painted-regions' && head !== 'tile-pixels' && head !== 'leaderboard-pixels') return false
        const keyChainId = k[1]
        return typeof keyChainId === 'number' && keyChainId !== chainId
      },
    })
  }, [chainId, queryClient])

  // Tint the favicon to match the connected chain. Browsers' favicon
  // implementations don't honour CSS / `currentColor` reliably, so we
  // generate a fresh SVG data URL each time `tokens.hex` changes and
  // swap it onto the existing <link rel="icon">. Fast: ~150 bytes of
  // markup, no network round-trip.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="60" height="60">` +
      `<rect x="5" y="5" width="50" height="50" fill="${tokens.hex}"/>` +
      `</svg>`
    link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }, [tokens.hex])

  return (
    <main
      className="app"
      style={
        {
          '--tw-accent': tokens.hex,
          '--accent': tokens.hex,
          // Hover variant, ~15% darker than the base. color-mix lets
          // the rule live in CSS-land without a precomputed hex per
          // chain.
          '--accent-2': `color-mix(in srgb, ${tokens.hex}, #000 15%)`,
        } as React.CSSProperties
      }
    >
      <SprayTrail />
      <ConnectBar />
      {/* LeaderboardTicker is rendered by HomePage (it needs the
          `regions` prop, which HomePage already owns from its own
          `usePaintedRegions` call). Mounting it here in AppLayout was
          tried but the parallel `usePaintedRegions` instances landed
          in different react-query buckets (StrictMode + hook ordering)
          and the AppLayout copy never received data. Keeping it in
          HomePage avoids that. */}
      <Outlet />
      <footer className="site-footer">
        <div className="site-footer-left">
          <small>
            Tagwall is an immutable 1,000,000-pixel on-chain graffiti wall.
            Canvas at <code>{canvasAddress(chainId)}</code>.
          </small>
        </div>
        <div className="site-footer-socials" aria-label="Socials">
          {/* Both URLs come from VITE_TAGWALL_*_URL build env vars (see
              web/.env.example + web/src/lib/socials.ts). Empty values
              hide the link entirely so the operator's "not yet
              claimed" state never produces a broken `href="#"`. */}
          {TWITTER_URL ? (
            <a
              className="site-footer-social"
              href={TWITTER_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Tagwall on X (Twitter)"
              title="X / Twitter"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M12.12 1.5h2.38l-5.2 5.93L15.4 14.5h-4.78l-3.75-4.9-4.28 4.9H.2l5.56-6.34L.34 1.5h4.9l3.4 4.48 3.48-4.48zm-.83 11.57h1.32L4.76 2.86H3.35l7.94 10.2z"/>
              </svg>
            </a>
          ) : null}
          {TELEGRAM_URL ? (
            <a
              className="site-footer-social"
              href={TELEGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Tagwall on Telegram"
              title="Telegram"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M14.76 2.18 1.9 7.19c-.88.34-.87.82-.16 1.04l3.3 1.03 7.64-4.82c.36-.22.69-.1.42.14L6.92 10.2l-.24 3.57c.34 0 .49-.16.67-.35l1.6-1.56 3.32 2.45c.61.34 1.05.16 1.2-.56L15.7 3.3c.22-.89-.33-1.29-.94-1.12z"/>
              </svg>
            </a>
          ) : null}
        </div>
      </footer>
    </main>
  )
}
