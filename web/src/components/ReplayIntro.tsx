/**
 * Plain-text intro for /replay. Rendered on the page and prerendered into
 * dist/replay.html (src/prerender.tsx) so search engines and link previews
 * get real text. Keep it free of wallet, RPC and router state.
 */
export function ReplayIntro() {
  return (
    <header className="replay-intro">
      <h1>Wall replay</h1>
      <p>
        Every paint on tagwall is stored on chain, so the wall&apos;s whole history can be
        played back exactly, one paint at a time. Pick a chain at the top, drag across the
        wall to replay just one area, narrow it to a date range, and copy a link that opens
        that exact view.
      </p>
    </header>
  )
}
