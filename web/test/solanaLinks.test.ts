// Link-registry resolution + referrer validation tests.
//
// fetchLinkUrls is exercised against a mocked Connection whose
// getMultipleAccountsInfo returns synthetic Link accounts built with
// the exact state.rs layout (disc + id u32 + len u32 + url bytes), so
// chunking, per-chunk failure tolerance, and decode hardening are all
// pinned without a cluster.

import { describe, expect, it, vi } from 'vitest'
import { PublicKey, type Connection } from '@solana/web3.js'

import { DISC, linkPda } from '../src/solana/client'
import { fetchLinkUrls } from '../src/solana/links'
import { isValidSolanaAddress } from '../src/hooks/useSolanaReferrer'

/** Synthetic Link account bytes: 8 disc + u32 id + u32 len + utf8 url. */
function linkAccountData(id: number, url: string): Uint8Array {
  const urlBytes = new TextEncoder().encode(url)
  const data = new Uint8Array(8 + 4 + 4 + urlBytes.length)
  data.set(DISC.link, 0)
  const v = new DataView(data.buffer)
  v.setUint32(8, id, true)
  v.setUint32(12, urlBytes.length, true)
  data.set(urlBytes, 16)
  return data
}

/** Connection mock serving accounts from an id-keyed registry map. */
function mockConnection(registry: Map<number, Uint8Array | null>) {
  // Reverse index: pda base58 -> link id, so the mock can answer for
  // whatever pubkey order fetchLinkUrls asks in.
  const byPda = new Map<string, number>()
  for (const id of registry.keys()) byPda.set(linkPda(id).toBase58(), id)
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
    keys.map((k) => {
      const id = byPda.get(k.toBase58())
      const data = id !== undefined ? registry.get(id) : undefined
      return data ? { data } : null
    }),
  )
  return {
    conn: { getMultipleAccountsInfo } as unknown as Connection,
    getMultipleAccountsInfo,
  }
}

describe('fetchLinkUrls', () => {
  it('resolves registered ids and skips id 0, negatives, and duplicates', async () => {
    const { conn, getMultipleAccountsInfo } = mockConnection(
      new Map([
        [1, linkAccountData(1, 'https://tagwall.io')],
        [7, linkAccountData(7, 'https://example.com/x')],
      ]),
    )
    const map = await fetchLinkUrls(conn, [0, 1, 7, 7, -3, 1])
    expect(map.get(1)).toBe('https://tagwall.io')
    expect(map.get(7)).toBe('https://example.com/x')
    expect(map.size).toBe(2)
    // One chunk, deduped: exactly 2 pubkeys requested in 1 call.
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1)
    expect(getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(2)
  })

  it('omits unregistered ids (null accounts) without failing the rest', async () => {
    const { conn } = mockConnection(
      new Map<number, Uint8Array | null>([
        [1, linkAccountData(1, 'https://a.example')],
        [2, null],
      ]),
    )
    const map = await fetchLinkUrls(conn, [1, 2])
    expect(map.get(1)).toBe('https://a.example')
    expect(map.has(2)).toBe(false)
  })

  it('skips accounts whose bytes are not a Link account', async () => {
    const corrupt = linkAccountData(3, 'https://evil.example')
    corrupt.set(DISC.tile, 0) // wrong discriminator
    const { conn } = mockConnection(
      new Map([
        [3, corrupt],
        [4, linkAccountData(4, 'https://ok.example')],
      ]),
    )
    const map = await fetchLinkUrls(conn, [3, 4])
    expect(map.has(3)).toBe(false)
    expect(map.get(4)).toBe('https://ok.example')
  })

  it('chunks requests at 100 accounts', async () => {
    const registry = new Map<number, Uint8Array | null>()
    const ids: number[] = []
    for (let id = 1; id <= 250; id++) {
      registry.set(id, linkAccountData(id, `https://link.example/${id}`))
      ids.push(id)
    }
    const { conn, getMultipleAccountsInfo } = mockConnection(registry)
    const map = await fetchLinkUrls(conn, ids)
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(3)
    expect(getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(100)
    expect(getMultipleAccountsInfo.mock.calls[1][0]).toHaveLength(100)
    expect(getMultipleAccountsInfo.mock.calls[2][0]).toHaveLength(50)
    expect(map.size).toBe(250)
    expect(map.get(101)).toBe('https://link.example/101')
    expect(map.get(250)).toBe('https://link.example/250')
  })

  it('tolerates a failed chunk and still returns the others', async () => {
    const registry = new Map<number, Uint8Array | null>()
    const ids: number[] = []
    for (let id = 1; id <= 150; id++) {
      registry.set(id, linkAccountData(id, `https://link.example/${id}`))
      ids.push(id)
    }
    const { conn, getMultipleAccountsInfo } = mockConnection(registry)
    getMultipleAccountsInfo.mockRejectedValueOnce(new Error('429 too many requests'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const map = await fetchLinkUrls(conn, ids)
      // First chunk (ids 1..100) lost, second (101..150) survives.
      expect(map.size).toBe(50)
      expect(map.has(1)).toBe(false)
      expect(map.get(150)).toBe('https://link.example/150')
    } finally {
      warn.mockRestore()
    }
  })

  it('returns attacker-controlled URLs verbatim (caller hardens rendering)', async () => {
    const nasty = 'https://x.example/"><img src=x onerror=alert(1)>'
    const { conn } = mockConnection(new Map([[9, linkAccountData(9, nasty)]]))
    const map = await fetchLinkUrls(conn, [9])
    // No sanitization at this layer; the dock components route through
    // the outbound interstitial and never raw-interpolate.
    expect(map.get(9)).toBe(nasty)
  })

  it('returns an empty map for an empty or all-invalid id list', async () => {
    const { conn, getMultipleAccountsInfo } = mockConnection(new Map())
    expect((await fetchLinkUrls(conn, [])).size).toBe(0)
    expect((await fetchLinkUrls(conn, [0, -1])).size).toBe(0)
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled()
  })
})

describe('isValidSolanaAddress', () => {
  it('accepts valid base58 pubkeys', () => {
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true) // system program
    expect(isValidSolanaAddress(PublicKey.default.toBase58())).toBe(true)
    expect(isValidSolanaAddress(linkPda(1).toBase58())).toBe(true) // off-curve PDA is fine
    expect(isValidSolanaAddress(`  ${linkPda(2).toBase58()}  `)).toBe(true) // trims
  })

  it('rejects non-pubkey strings', () => {
    expect(isValidSolanaAddress('')).toBe(false)
    expect(isValidSolanaAddress('0xF42d62490a0Eaa1eDC7a02738a14CB80Ef880FE9')).toBe(false) // EVM
    expect(isValidSolanaAddress('abc')).toBe(false) // too short
    expect(isValidSolanaAddress('I'.repeat(40))).toBe(false) // I is not base58
    expect(isValidSolanaAddress('0OIl'.repeat(10))).toBe(false) // excluded chars
    expect(isValidSolanaAddress(`${linkPda(1).toBase58()}1111111111111`)).toBe(false) // too long
  })
})
