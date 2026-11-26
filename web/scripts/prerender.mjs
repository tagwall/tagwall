// Post-build step: write static HTML for the article pages, the home page's
// head and intro, sitemap.xml, robots.txt and llms.txt.
//
// Runs after `vite build` (the client bundle in dist/) and
// `vite build --ssr src/prerender.tsx` (dist-ssr/). For each article route it
// takes dist/index.html, swaps in that page's title, description, canonical
// and link-preview tags, and puts the rendered article inside #root.
//
// File layout matters on Workers Static Assets: /articles/<slug> is served
// from articles/<slug>.html with no redirect, whereas articles/<slug>/index.html
// would 307 to a trailing slash first.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from 'vite'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(WEB, 'dist')
const SSR = join(WEB, 'dist-ssr')
// Mirror operators: set SITE_URL at build time so canonicals point at you.
const SITE = (process.env.SITE_URL || 'https://tagwall.io').replace(/\/+$/, '')

const { pages, homeIntroHtml, homeChains } = await import(pathToFileURL(join(SSR, 'prerender.js')).href)
const template = readFileSync(join(DIST, 'index.html'), 'utf8')

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(p) {
  const url = SITE + p.path
  const head = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="${esc(p.ogType ?? 'article')}" />`,
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

// Home page. dist/index.html is both "/" and the SPA fallback for every
// route without its own file (/pixel/..., /founders, ?chain= links), so the
// canonical points at "/"; AppLayout corrects it in the browser for pages
// that aren't the canvas. The intro goes inside #root so crawlers that don't
// run JavaScript can read it; the app replaces it on mount and renders the
// same component under the canvas.
const homeTitle = template.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'tagwall'
const homeDesc = template.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ''
const homeHead = [
  `<link rel="canonical" href="${esc(SITE + '/')}" />`,
  `<meta property="og:type" content="website" />`,
  `<meta property="og:site_name" content="tagwall" />`,
  `<meta property="og:title" content="${homeTitle}" />`,
  `<meta property="og:description" content="${homeDesc}" />`,
  `<meta property="og:url" content="${esc(SITE + '/')}" />`,
].join('\n    ')
const home = template
  .replace(/(<meta name="description"[^>]*>)/, (m) => `${m}\n    ${homeHead}`)
  .replace('<div id="root"></div>', () => `<div id="root">${homeIntroHtml()}</div>`)
if (!home.includes('rel="canonical"') || home.includes('<div id="root"></div>')) {
  throw new Error('prerender: could not place the home canonical or intro in index.html')
}
writeFileSync(join(DIST, 'index.html'), home)

// <lastmod> is the date of the last commit touching each page's source, or
// the build date when git isn't available or the source is uncommitted.
const today = new Date().toISOString().slice(0, 10)
function lastmod(...paths) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...paths], {
      cwd: WEB,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || today
  } catch {
    return today
  }
}
const articleFiles = readdirSync(join(WEB, 'content', 'articles')).filter((f) => f.endsWith('.md'))
function sourceOf(path) {
  if (path === '/') return ['index.html', 'src']
  if (path === '/articles') return ['content/articles', 'src/pages/ArticlesPage.tsx']
  if (path === '/replay') return ['src/pages/ReplayPage.tsx', 'src/components/ReplayIntro.tsx']
  const slug = path.replace('/articles/', '')
  const file = articleFiles.find((f) => f.replace(/^\d+-/, '').replace(/\.md$/, '') === slug)
  if (!file) throw new Error(`prerender: no source file for ${path}`)
  return [join('content', 'articles', file)]
}

const urls = ['/', ...all.map((p) => p.path)]
writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(SITE + u)}</loc><lastmod>${lastmod(...sourceOf(u))}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
)
// /api/ stays disallowed: every request there is a paid Worker invocation
// and none of it is page content.
writeFileSync(
  join(DIST, 'robots.txt'),
  `User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`,
)

// llms.txt (llmstxt.org): plain facts for AI assistants, built from the same
// sources as the pages so it can't drift from them.
const env = loadEnv('production', WEB, 'VITE_')
const chainList = `${homeChains.slice(0, -1).join(', ')} and ${homeChains[homeChains.length - 1]}`
const llms = [
  '# tagwall',
  '',
  `> tagwall is an on-chain graffiti wall of 1,000,000 pixels. Anyone with a wallet can pick a spot, upload an image and paint it for a few cents a pixel, paid in the chain's native token. Painting over an existing tag costs 10% more than its last price; after three months untouched, that price starts drifting back down toward the floor. The wall is live on ${chainList}. The contract has no owner, no admin key and no upgrade path, there is no token, and the code is open source. It is made for fun, not as an investment.`,
  '',
  '## Key pages',
  '',
  `- [Home: the live wall](${SITE}/)`,
  `- [Wall replay: play back the wall's history, whole or one area](${SITE}/replay)`,
  `- [Articles: how and why tagwall was built](${SITE}/articles)`,
  ...all
    .filter((p) => p.path.startsWith('/articles/'))
    .map((p) => `- [${p.title.replace(/ · tagwall$/, '')}](${SITE}${p.path}): ${p.description}`),
  '- [Source code](https://github.com/tagwall/tagwall)',
  '',
  '## Contact',
  '',
  env.VITE_TAGWALL_TWITTER_URL ? `- X: ${env.VITE_TAGWALL_TWITTER_URL}` : '',
  env.VITE_TAGWALL_TELEGRAM_URL ? `- Telegram: ${env.VITE_TAGWALL_TELEGRAM_URL}` : '',
  '',
]
  .filter((line, i, a) => line !== '' || a[i - 1] !== '')
  .join('\n')
writeFileSync(join(DIST, 'llms.txt'), llms)

rmSync(SSR, { recursive: true, force: true })
console.log(`prerender: ${all.length} article pages, home intro, sitemap with ${urls.length} URLs, robots.txt, llms.txt`)
