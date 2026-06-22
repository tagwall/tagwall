// End-to-end check of the client layer against the LIVE devnet
// deployment: fetches the real canvas config, all tiles, and link 1,
// and asserts the state the bootstrap + soak runs left behind.
//
// Network-gated so CI and normal `vitest run` stay offline:
//   SOLANA_E2E=1 npx vitest run test/solanaDevnet.e2e.test.ts

import { describe, expect, it } from 'vitest'
import { Connection } from '@solana/web3.js'

import {
  canvasPda,
  decodeCanvasConfig,
  decodeLink,
  fetchAllTiles,
  linkPda,
} from '../src/solana/client'

const RPC = 'https://api.devnet.solana.com'
const run = process.env.SOLANA_E2E === '1' ? describe : describe.skip

run('devnet e2e', () => {
  it('decodes the live canvas config', async () => {
    const conn = new Connection(RPC, 'confirmed')
    const info = await conn.getAccountInfo(canvasPda())
    expect(info).not.toBeNull()
    const cfg = decodeCanvasConfig(info!.data)
    expect(cfg.startingPrice).toBe(100_000n)
    expect(cfg.decayPerMonthBps).toBe(1_000n)
    expect(cfg.freezePeriodSeconds).toBe(90n * 24n * 60n * 60n)
    expect(cfg.treasury.toBase58()).toBe(
      'H3adprNfDdJaTciMgnaNM4cqW97Lecf6ASL1UxPc7y3Q',
    )
    expect(cfg.linkCount).toBeGreaterThanOrEqual(1)
    expect(cfg.stampCount).toBeGreaterThanOrEqual(18n) // bootstrap + soaks
    console.log(`devnet stamp_count: ${cfg.stampCount}, links: ${cfg.linkCount}`)
  }, 30_000)

  it('fetches and decodes every live tile in one call', async () => {
    const conn = new Connection(RPC, 'confirmed')
    const tiles = await fetchAllTiles(conn)
    // Bootstrap + soak created tiles (0..2, 0..1) at least, plus (5,5),
    // (7,7), (8,8) from earlier sessions.
    expect(tiles.length).toBeGreaterThanOrEqual(6)
    const t00 = tiles.find((t) => t.tileX === 0 && t.tileY === 0)
    expect(t00).toBeDefined()
    // Pixel (0,0) was painted by every soak pass; the last writer was
    // the pass-3 palette stamp whose palette[0] is color 0 (black).
    expect(t00!.pixels[0].lastPrice).toBeGreaterThan(0n)
    expect(t00!.pixels[0].lastPaintedAt).toBeGreaterThan(1_700_000_000)
    const painted = tiles.reduce(
      (n, t) => n + t.pixels.filter((p) => p.lastPrice > 0n).length,
      0,
    )
    console.log(`devnet tiles: ${tiles.length}, painted pixels: ${painted}`)
    expect(painted).toBeGreaterThan(1_500) // the 50x30 fill alone
  }, 30_000)

  it('decodes the bootstrap link', async () => {
    const conn = new Connection(RPC, 'confirmed')
    const info = await conn.getAccountInfo(linkPda(1))
    expect(info).not.toBeNull()
    expect(decodeLink(info!.data)).toEqual({ id: 1, url: 'https://tagwall.io/' })
  }, 30_000)
})
