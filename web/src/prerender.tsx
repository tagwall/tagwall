import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import ArticlesPage from './pages/ArticlesPage'
import { ARTICLES } from './lib/articles'

/**
 * Build-time entry for the static article pages (scripts/prerender.mjs).
 * The app itself is client-rendered, so without this every /articles URL is
 * an empty <div id="root"> until the bundle runs, which is what crawlers and
 * link previews see. Only the article routes are rendered here: they need no
 * wallet, no RPC and no layout state. The client still mounts with
 * createRoot and replaces this markup on load.
 */

export interface PrerenderPage {
  /** URL path, e.g. /articles/the-contract-was-the-easy-part */
  path: string
  title: string
  description: string
  /** Site-relative image path for link previews. */
  image: string
  html: string
}

function render(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/articles" element={<ArticlesPage />} />
        <Route path="/articles/:slug" element={<ArticlesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

export function pages(): PrerenderPage[] {
  const index: PrerenderPage = {
    path: '/articles',
    title: 'articles · tagwall',
    description:
      'How and why tagwall was built: the design, the contract, and the part that was harder than the contract.',
    image: ARTICLES[0]?.cover ?? '',
    html: render('/articles'),
  }
  return [
    index,
    ...ARTICLES.map((a) => ({
      path: `/articles/${a.slug}`,
      title: `${a.title} · tagwall`,
      description: a.subtitle,
      image: a.cover,
      html: render(`/articles/${a.slug}`),
    })),
  ]
}
