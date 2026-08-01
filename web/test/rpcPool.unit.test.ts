import { describe, expect, it } from 'vitest'

import { DIRECT_RPCS, advanceRpcRotation, dialOrder, rpcRotation } from '../src/lib/rpcPool'

/**
 * Guards the two properties the pool exists to provide: reads spread across
 * operators instead of pinning the first one, and `eth_getLogs` prefers the
 * Worker proxy so it lands on the edge cache.
 *
 * Index 0 is always the proxy; 1..n are the direct endpoints.
 */
describe('dialOrder', () => {
  it('puts the proxy first for eth_getLogs so the edge cache is hit', () => {
    expect(dialOrder('eth_getLogs', 4, 0)[0]).toBe(0)
    expect(dialOrder('eth_getLogs', 4, 3)[0]).toBe(0)
  })

  it('starts eth_call on a direct endpoint and keeps the proxy as last resort', () => {
    const order = dialOrder('eth_call', 4, 0)
    expect(order[0]).not.toBe(0)
    expect(order[order.length - 1]).toBe(0)
  })

  it('rotates the starting direct endpoint with the cursor', () => {
    const first = (cursor: number) => dialOrder('eth_call', 4, cursor)[0]
    expect([first(0), first(1), first(2), first(3)]).toEqual([1, 2, 3, 4])
    // Wraps rather than running off the end.
    expect(first(4)).toBe(1)
  })

  it('always dials every endpoint exactly once', () => {
    for (const method of ['eth_call', 'eth_getLogs']) {
      for (let cursor = 0; cursor < 6; cursor++) {
        const order = dialOrder(method, 4, cursor)
        expect(order).toHaveLength(5)
        expect(new Set(order).size).toBe(5)
      }
    }
  })

  it('handles a single-endpoint chain (BSC, Robinhood) without duplicating', () => {
    const order = dialOrder('eth_call', 1, 7)
    expect(order).toEqual([1, 0])
  })

  it('advanceRpcRotation moves the shared cursor', () => {
    const before = rpcRotation()
    advanceRpcRotation()
    expect(rpcRotation()).toBe((before + 1) % 1_000_000)
  })
})

describe('DIRECT_RPCS', () => {
  it('covers every chain the app offers', () => {
    for (const chainId of [1, 56, 369, 943, 999, 4663, 8453]) {
      expect(DIRECT_RPCS[chainId]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('lists only https endpoints, with no duplicates within a chain', () => {
    for (const [chainId, urls] of Object.entries(DIRECT_RPCS)) {
      expect(new Set(urls).size, `chain ${chainId} has a duplicate endpoint`).toBe(urls.length)
      for (const url of urls) expect(url.startsWith('https://'), url).toBe(true)
    }
  })

  it('excludes endpoints known to refuse eth_getLogs', () => {
    // publicnode went archive-token-gated and merkle.io dropped getLogs
    // entirely (2026-08-01). Both answer other methods fine, so a partial
    // re-add would look healthy while leaving the canvas blank.
    const banned = ['publicnode.com', 'eth.merkle.io']
    for (const urls of Object.values(DIRECT_RPCS)) {
      for (const url of urls) {
        for (const bad of banned) expect(url.includes(bad), `${url} is known-bad`).toBe(false)
      }
    }
  })
})
