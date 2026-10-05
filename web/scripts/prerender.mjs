// Post-build step: write static HTML for the article pages and the sitemap.
//
// Runs after `vite build` (the client bundle in dist/) and
// `vite build --ssr src/prerender.tsx` (dist-ssr/). For each article route it
// takes dist/index.html, swaps in that page's title, description, canonical
// and link-preview tags, and puts the rendered article inside #root.
//
// File layout matters on Workers Static Assets: /articles/<slug> is served
// from articles/<slug>.html with no redirect, whereas articles/<slug>/index.html
// would 307 to a trailing slash first.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(WEB, 'dist')
const SSR = join(WEB, 'dist-ssr')
// Mirror operators: set SITE_URL at build time so canonicals point at you.
const SITE = (process.env.SITE_URL || 'https://tagwall.io').replace(/\/+$/, '')

const { pages } = await import(pathToFileURL(join(SSR, 'prerender.js')).href)
const template = readFileSync(join(DIST, 'index.html'), 'utf8')

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(p) {
  const url = SITE + p.path
  const head = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="tagwall" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    p.image ? `<meta property="og:image" content="${esc(SITE + p.image)}" />` : '',
    `<meta name="twitter:card" content="summary_large_image" />`,
  ]
    .filter(Boolean)
    .join('\n    ')

  let html = template
    .replace(/<title>[\s\S]*?<\/title>/, () => '')
    .replace(/<meta name="description"[^>]*>/, () => head)
    .replace('<div id="root"></div>', () => `<div id="root">${p.html}</div>`)
  if (!html.includes(p.html)) throw new Error(`prerender: #root not found in index.html for ${p.path}`)
  return html
}

const all = pages()
for (const p of all) {
  const file = join(DIST, `${p.path.replace(/^\//, '')}.html`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, page(p))
}

const urls = ['/', ...all.map((p) => p.path)]
writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(SITE + u)}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
)
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`)

rmSync(SSR, { recursive: true, force: true })
console.log(`prerender: ${all.length} article pages, sitemap with ${urls.length} URLs, robots.txt`)
