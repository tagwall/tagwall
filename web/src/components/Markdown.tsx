import type { ReactNode } from 'react'

/**
 * A deliberately small markdown renderer for the article bodies. Covers
 * what the series actually uses (h2/h3, paragraphs, fenced code, bullet
 * and numbered lists, inline code, bold, italics, links) and nothing else,
 * so we don't ship a markdown library for five static pages. Output is
 * React elements, never innerHTML, so the content is inert by construction.
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  for (const part of text.split(INLINE)) {
    if (!part) continue
    const key = `${keyBase}-${i++}`
    if (part.startsWith('`') && part.endsWith('`')) {
      out.push(<code key={key}>{part.slice(1, -1)}</code>)
    } else if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else if (part.startsWith('[')) {
      const m = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
      if (m && /^(https?:\/\/|\/|#)/.test(m[2])) {
        const external = m[2].startsWith('http')
        out.push(
          <a
            key={key}
            href={m[2]}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {m[1]}
          </a>,
        )
      } else {
        out.push(part)
      }
    } else {
      out.push(part)
    }
  }
  return out
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0

  const para: string[] = []
  const flushPara = () => {
    if (para.length === 0) return
    const text = para.join(' ').trim()
    para.length = 0
    if (text) blocks.push(<p key={`p${k++}`}>{inline(text, `p${k}`)}</p>)
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('```')) {
      flushPara()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++ // closing fence
      blocks.push(
        <pre key={`c${k++}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      flushPara()
      const level = h[1].length
      const content = inline(h[2], `h${k}`)
      if (level <= 2) blocks.push(<h2 key={`h${k++}`}>{content}</h2>)
      else blocks.push(<h3 key={`h${k++}`}>{content}</h3>)
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i++
      }
      const children = items.map((it, n) => <li key={n}>{inline(it, `li${k}-${n}`)}</li>)
      blocks.push(ordered ? <ol key={`l${k++}`}>{children}</ol> : <ul key={`l${k++}`}>{children}</ul>)
      continue
    }

    if (line.startsWith('>')) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={`q${k++}`}>{inline(quote.join(' '), `q${k}`)}</blockquote>)
      continue
    }

    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }
  flushPara()
  return <>{blocks}</>
}
