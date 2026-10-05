// Copy the article series from marketing/articles/*.md into web/content/articles/,
// keeping only what the site renders: the title, the subtitle / read time /
// series lines, and the body. Everything after the body's closing `---` (tweet
// copy, pull quotes, facts used) and the cover spec stay behind.
//
// Why a copy: the public repo that Cloudflare builds from only ships web/, so a
// build that globbed ../marketing/articles found nothing and /articles went out
// empty. The copy lives inside web/ and is committed. Run on every local build;
// in the public checkout marketing/ doesn't exist and this is a no-op.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(WEB, '..', 'marketing', 'articles')
const OUT = join(WEB, 'content', 'articles')

if (!existsSync(SRC)) {
  console.log('sync-articles: no marketing/articles here, keeping web/content/articles as is')
  process.exit(0)
}

const KEEP = ['subtitle', 'read time', 'series']
const files = readdirSync(SRC).filter((f) => /^\d+-.+\.md$/.test(f)).sort()

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const file of files) {
  const raw = readFileSync(join(SRC, file), 'utf8')
  const sections = raw.split(/\r?\n---\r?\n/)
  const header = sections[0] ?? ''
  const body = (sections[1] ?? '').trim()
  const title = header.match(/^#\s+(.+)$/m)?.[1].trim()
  if (!title || !body) throw new Error(`sync-articles: ${file} has no title or body`)
  const meta = KEEP.map((key) => header.match(new RegExp(`^\\*\\*${key}:\\*\\*.*$`, 'm'))?.[0])
    .filter(Boolean)
    .join('\n')
  writeFileSync(join(OUT, file), `# ${title}\n\n${meta}\n\n---\n\n${body}\n\n---\n`)
}

console.log(`sync-articles: ${files.length} articles -> web/content/articles`)
