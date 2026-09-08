import { useEffect } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'

import { Markdown } from '../components/Markdown'
import { ARTICLES, articleBySlug } from '../lib/articles'

/**
 * /articles          index of the "building tagwall" series
 * /articles/:slug    one article, rendered from its markdown body
 *
 * Content is compiled in from marketing/articles/*.md (see lib/articles.ts),
 * so publishing an article is a rebuild, not a deploy of anything dynamic.
 * The page needs no wallet and makes no RPC calls: it is the non-X
 * destination for Show HN / Reddit traffic.
 */
export default function ArticlesPage() {
  const { slug } = useParams()
  const article = articleBySlug(slug)

  useEffect(() => {
    const prev = document.title
    document.title = article ? `${article.title} · tagwall` : 'articles · tagwall'
    return () => {
      document.title = prev
    }
  }, [article])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [slug])

  if (slug && !article) return <Navigate to="/articles" replace />

  if (!article) {
    return (
      <div className="shell-measure articles-page">
        <header className="articles-header">
          <p className="articles-kicker">building tagwall</p>
          <h1>articles</h1>
          <p>
            how and why the wall was built: the design, the contract, and the part that was
            harder than the contract. written by the builder.
          </p>
        </header>
        <ol className="articles-list">
          {ARTICLES.map((a) => (
            <li key={a.slug} className="articles-item">
              <Link to={`/articles/${a.slug}`} className="articles-item-link">
                <img src={a.cover} alt="" className="articles-item-cover" loading="lazy" />
                <div className="articles-item-text">
                  <span className="articles-item-part">part {a.part} of {ARTICLES.length}</span>
                  <h2>{a.title}</h2>
                  <p>{a.subtitle}</p>
                  {a.readTime ? <span className="articles-item-meta">{a.readTime} read</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    )
  }

  const idx = ARTICLES.findIndex((a) => a.slug === article.slug)
  const prev = idx > 0 ? ARTICLES[idx - 1] : undefined
  const next = idx < ARTICLES.length - 1 ? ARTICLES[idx + 1] : undefined

  return (
    <div className="shell-measure articles-page">
      <article className="article">
        <p className="articles-kicker">
          <Link to="/articles">building tagwall</Link> · part {article.part} of {ARTICLES.length}
        </p>
        <h1>{article.title}</h1>
        {article.subtitle ? <p className="article-subtitle">{article.subtitle}</p> : null}
        {article.readTime ? <p className="article-meta">{article.readTime} read</p> : null}
        <img src={article.cover} alt="" className="article-cover" />
        <div className="article-body">
          <Markdown source={article.body} />
        </div>
        <footer className="article-footer">
          <p>
            the wall is live. <Link to="/">paint a pixel</Link>, or{' '}
            <Link to="/founders">see who got there first</Link>.
          </p>
          <nav className="article-nav" aria-label="series navigation">
            {prev ? (
              <Link to={`/articles/${prev.slug}`} className="article-nav-link">
                <span>previous</span>
                {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link to={`/articles/${next.slug}`} className="article-nav-link article-nav-next">
                <span>next</span>
                {next.title}
              </Link>
            ) : null}
          </nav>
        </footer>
      </article>
    </div>
  )
}
