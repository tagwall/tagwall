/**
 * The "building tagwall" article series, imported at build time from
 * marketing/articles/*.md (Vite `?raw` glob, no runtime fetch). Each file is:
 *
 *   # title
 *   **subtitle:** ...  **read time:** ...  **cover spec:** ...  **series:** ...
 *   ---
 *   body (markdown)
 *   ---
 *   tweet sections (announcement, pull quotes, facts used)  <- never rendered
 *
 * Only the header and the body make it to the site; everything after the
 * second `---` is marketing scaffolding and is dropped here so it can't
 * leak into the page. Covers live in web/public/articles/cover-NN.png
 * (copied from marketing/renders, which is gitignored).
 */

export interface Article {
  /** URL slug: filename minus the `NN-` prefix and `.md`. */
  slug: string
  /** 1-based position in the series (from the filename prefix). */
  part: number
  title: string
  subtitle: string
  readTime: string
  series: string
  /** Public URL of the 5:2 cover image. */
  cover: string
  /** Markdown body only (between the first and second `---`). */
  body: string
}

const RAW = import.meta.glob('../../../marketing/articles/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function meta(header: string, key: string): string {
  const m = header.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`))
  return m ? m[1].trim() : ''
}

function parse(path: string, raw: string): Article | null {
  const file = path.split('/').pop() ?? ''
  const m = file.match(/^(\d+)-(.+)\.md$/)
  if (!m) return null
  const part = Number(m[1])
  const slug = m[2]
  // Split on horizontal rules that sit on their own line.
  const sections = raw.split(/\r?\n---\r?\n/)
  const header = sections[0] ?? ''
  const body = (sections[1] ?? '').trim()
  const title = header.match(/^#\s+(.+)$/m)?.[1].trim() ?? slug
  return {
    slug,
    part,
    title,
    subtitle: meta(header, 'subtitle'),
    readTime: meta(header, 'read time'),
    series: meta(header, 'series'),
    cover: `/articles/cover-${String(part).padStart(2, '0')}.png`,
    body,
  }
}

export const ARTICLES: Article[] = Object.entries(RAW)
  .map(([path, raw]) => parse(path, raw))
  .filter((a): a is Article => a !== null)
  .sort((a, b) => a.part - b.part)

export function articleBySlug(slug: string | undefined): Article | undefined {
  if (!slug) return undefined
  return ARTICLES.find((a) => a.slug === slug)
}
