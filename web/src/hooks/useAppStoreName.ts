import { useEffect, useState } from 'react'

/**
 * Resolve an App Store app's display name from its numeric track id via
 * Apple's iTunes Lookup API.
 *
 * That API sends no `Access-Control-Allow-Origin` header, so a normal fetch
 * is blocked cross-origin; it does support JSONP (its content-type is
 * text/javascript and it honours a `callback` param). So this injects a
 * one-shot <script> with a private callback. It only ever points at
 * itunes.apple.com (Apple first-party), and the id is validated to digits
 * before use, so there's no arbitrary-URL / injection surface.
 *
 * Returns undefined until resolved (callers fall back to a generic label).
 * Results are memoised process-wide so each id is fetched at most once.
 */
const nameCache = new Map<string, string>()
let callbackSeq = 0

export function useAppStoreName(appId: string | undefined): string | undefined {
  const [name, setName] = useState<string | undefined>(() =>
    appId ? nameCache.get(appId) : undefined,
  )

  useEffect(() => {
    if (!appId || !/^\d+$/.test(appId)) {
      setName(undefined)
      return
    }
    const cached = nameCache.get(appId)
    if (cached !== undefined) {
      setName(cached)
      return
    }

    let done = false
    const cbName = `__itunesLookup_${appId}_${callbackSeq++}`
    const script = document.createElement('script')

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[cbName]
      script.remove()
      window.clearTimeout(timer)
    }
    const timer = window.setTimeout(cleanup, 8000)

    ;(window as unknown as Record<string, unknown>)[cbName] = (payload: unknown) => {
      if (!done) {
        done = true
        const results = (payload as { results?: Array<{ trackName?: unknown }> })?.results
        const track = results?.[0]?.trackName
        if (typeof track === 'string' && track) {
          nameCache.set(appId, track)
          setName(track)
        }
      }
      cleanup()
    }

    script.src = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&callback=${cbName}`
    script.async = true
    script.onerror = cleanup
    document.head.appendChild(script)

    return cleanup
  }, [appId])

  return name
}
