import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import EmbedPage from './pages/EmbedPage'
import HoldingPage from './pages/HoldingPage'
import HomePage from './pages/HomePage'
import SharePage from './pages/SharePage'
import './styles.css'

/**
 * Pre-launch holding-page mode. When `VITE_HOLDING_PAGE_MODE=true` at
 * build time, every route resolves to the holding page — no canvas, no
 * embed, no router-driven UX. Flip to false (or unset) to ship the
 * full app. Keeping this as one bundle (not a separate site) means
 * the Day-0 launch is one rebuild + one deploy, not a domain cutover.
 */
const HOLDING_MODE = import.meta.env.VITE_HOLDING_PAGE_MODE === 'true'

/**
 * Route map for the Tagwall frontend:
 *   /        main canvas view — canvas + paint controls + activity +
 *            leaderboard + inline stats cards. The Stats page was merged
 *            in here on 2026-04-23: no separate route, no nav menu.
 *   /pixel/  shareable permalink; opens canvas focused on a pixel.
 *   /embed   mirror-friendly minimal view without the layout chrome.
 */
export default function App() {
  if (HOLDING_MODE) return <HoldingPage />
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/embed" element={<EmbedPage />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/pixel/:coord" element={<HomePage />} />
          {/* Legacy /stats links still resolve to the canvas page; the
              stats content now lives inline below the canvas. */}
          <Route path="/stats" element={<HomePage />} />
          <Route path="/share" element={<SharePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
