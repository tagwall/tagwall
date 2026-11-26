/**
 * Short plain-text intro under the canvas: what tagwall is, where it runs
 * and what a pixel costs. The canvas itself gives search engines nothing
 * to read, so this is the page text that matches "tagwall" and "tag wall".
 *
 * Also rendered at build time into dist/index.html (src/prerender.tsx), so
 * crawlers that don't run JavaScript see the same words. Keep it free of
 * wallet, RPC and router state so it renders on the server.
 */
import { HOME_CHAINS } from '../lib/homeChains'

export function HomeIntro() {
  const chains = `${HOME_CHAINS.slice(0, -1).join(', ')} and ${HOME_CHAINS[HOME_CHAINS.length - 1]}`
  return (
    <section className="home-intro" aria-labelledby="home-intro-title">
      <h1 id="home-intro-title">tagwall, the on-chain graffiti wall</h1>
      <p>
        tagwall is a tag wall of 1,000,000 pixels that lives on chain. Pick a spot, upload an
        image and paint it for a few cents a pixel. Anyone can paint over your tag, at a price
        that starts 10% above what you paid, but nobody can erase that you painted it.
      </p>
      <p>
        The wall is live on {chains}. There's no owner, no admin key and no token, and the code
        is open source. You can watch every paint so far in the{' '}
        <a href="/replay">wall replay</a>.
      </p>
    </section>
  )
}
