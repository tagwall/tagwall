import { useEffect, useState } from 'react'

import {
  LAUNCH_CHAIN_COLOR,
  LAUNCH_CHAIN_ID,
  LAUNCH_CHAIN_NAME,
  LAUNCH_DISMISS_KEY,
  launchActive,
} from '../lib/launch'
import { useSetViewerChain, useViewerChainId } from '../lib/viewerChain'

/**
 * Prominent launch-announcement bar for a freshly deployed chain, mounted
 * above the competition banner on the canvas page. Robinhood-green so it
 * reads as its own thing, not the brand-lime contest bar below it.
 *
 * Self-hides when: the launch window has passed (see lib/launch.ts), the
 * viewer is already looking at the launched chain, or the viewer dismissed
 * it (persisted in localStorage). Clicking "view the wall" switches the
 * canvas to the new chain via the same ?chain= param the switcher writes,
 * so it works with no wallet connected.
 */
export function LaunchBanner() {
  const [dismissed, setDismissed] = useState(true)
  const [, setTick] = useState(0)
  const viewerChainId = useViewerChainId()
  const setViewerChain = useSetViewerChain()

  // Read the dismissal flag once on mount (SSR-safe guard on window).
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(LAUNCH_DISMISS_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  // Re-evaluate the window every 60s so it disappears at LAUNCH_END_MS
  // without a page reload during a long-open tab.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  if (!launchActive()) return null
  if (dismissed) return null
  // Already on the launched chain's canvas: nothing to promote.
  if (viewerChainId === LAUNCH_CHAIN_ID) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(LAUNCH_DISMISS_KEY, '1')
    } catch {
      /* private mode / storage disabled: banner just reappears next load */
    }
  }

  const style = { ['--tw-launch' as string]: LAUNCH_CHAIN_COLOR }

  return (
    <div className="launch-banner" style={style} role="region" aria-label="New chain launch">
      <button
        type="button"
        className="launch-banner-main"
        onClick={() => setViewerChain(LAUNCH_CHAIN_ID)}
      >
        <span className="launch-banner-tag">just launched</span>
        <span className="launch-banner-text">
          the wall is now live on <strong>{LAUNCH_CHAIN_NAME}</strong>. all 1,000,000 pixels open,
          genesis ranks unclaimed
        </span>
        <span className="launch-banner-cta">view the wall →</span>
      </button>
      <button
        type="button"
        className="launch-banner-close"
        onClick={dismiss}
        aria-label="Dismiss launch announcement"
      >
        ✕
      </button>
    </div>
  )
}
