import { describe, expect, it } from 'vitest'

import { twitterHandleLabel } from '../src/lib/socialHandle'

/**
 * Pure label extraction for x.com / twitter.com painted links. Drives the
 * "@username" rendering in the leaderboard ticker and leaderboard
 * (LinkLabel). No chain or DOM needed.
 */
describe('twitterHandleLabel', () => {
  it('extracts the handle from an x.com profile URL', () => {
    expect(twitterHandleLabel('https://x.com/imshillgates')).toBe('@imshillgates')
  })

  it('ignores a trailing query string (e.g. a ref code)', () => {
    expect(twitterHandleLabel('https://x.com/imshillgates?ref=22222P')).toBe('@imshillgates')
  })

  it('handles twitter.com, www., and mobile. hosts', () => {
    expect(twitterHandleLabel('https://twitter.com/jack')).toBe('@jack')
    expect(twitterHandleLabel('https://www.x.com/jack')).toBe('@jack')
    expect(twitterHandleLabel('https://mobile.twitter.com/jack')).toBe('@jack')
  })

  it('takes the profile from a status/sub-path URL', () => {
    expect(twitterHandleLabel('https://x.com/jack/status/123456')).toBe('@jack')
  })

  it('strips a leading @ in the path', () => {
    expect(twitterHandleLabel('https://x.com/@jack')).toBe('@jack')
  })

  it('returns null for reserved (non-username) paths', () => {
    expect(twitterHandleLabel('https://x.com/i/status/123')).toBeNull()
    expect(twitterHandleLabel('https://x.com/home')).toBeNull()
    expect(twitterHandleLabel('https://x.com/search?q=foo')).toBeNull()
  })

  it('labels an X community URL as "X Community"', () => {
    expect(twitterHandleLabel('https://x.com/i/communities/2032676625603534861')).toBe('X Community')
    expect(twitterHandleLabel('https://twitter.com/i/communities/123')).toBe('X Community')
  })

  it('does not treat a non-numeric /i/communities/ path as a community', () => {
    expect(twitterHandleLabel('https://x.com/i/communities/foo')).toBeNull()
  })

  it('returns null for the bare domain (no handle)', () => {
    expect(twitterHandleLabel('https://x.com')).toBeNull()
    expect(twitterHandleLabel('https://x.com/')).toBeNull()
  })

  it('returns null for handles that violate the 1-15 char / charset rule', () => {
    expect(twitterHandleLabel('https://x.com/this_name_is_way_too_long')).toBeNull()
    expect(twitterHandleLabel('https://x.com/bad-dash')).toBeNull()
  })

  it('returns null for non-twitter hosts and malformed input', () => {
    expect(twitterHandleLabel('https://pmint.win/?ref=22222P')).toBeNull()
    expect(twitterHandleLabel('https://example.com/jack')).toBeNull()
    expect(twitterHandleLabel('not a url')).toBeNull()
  })
})
