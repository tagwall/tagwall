// Solana client layer tests: discriminators recomputed from first
// principles, account layouts locked with synthetic byte fixtures,
// instruction encoding cross-checked against the program's borsh
// shapes. Pure offline; the devnet end-to-end check lives in
// solanaDevnet.e2e.test.ts behind SOLANA_E2E=1.

import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'

import {
  DISC,
  PROGRAM_ID,
  TILE_ACCOUNT_SIZE,
  bs58Encode,
  buildInitTileIx,
  buildPaintIx,
  canvasPda,
  decodeCanvasConfig,
  decodeLink,
  decodeTile,
  linkPda,
  tilePda,
  vaultPda,
} from '../src/solana/client'

function anchorDisc(name: string): number[] {
  return [...createHash('sha256').update(name).digest().subarray(0, 8)]
}

describe('discriminators', () => {
  it('hardcoded discriminators match sha256 derivation', () => {
    expect([...DISC.tile]).toEqual(anchorDisc('account:Tile'))
    expect([...DISC.canvasConfig]).toEqual(anchorDisc('account:CanvasConfig'))
    expect([...DISC.link]).toEqual(anchorDisc('account:Link'))
    expect([...DISC.linkHash]).toEqual(anchorDisc('account:LinkHash'))
    expect([...DISC.initTile]).toEqual(anchorDisc('global:init_tile'))
    expect([...DISC.registerLink]).toEqual(anchorDisc('global:register_link'))
    expect([...DISC.paint]).toEqual(anchorDisc('global:paint'))
    expect([...DISC.paintFill]).toEqual(anchorDisc('global:paint_fill'))
    expect([...DISC.paintPalette]).toEqual(anchorDisc('global:paint_palette'))
  })

  it('bs58Encode round-trips against PublicKey base58', () => {
    const key = canvasPda()
    expect(bs58Encode(key.toBytes())).toBe(key.toBase58())
  })
})

describe('PDAs', () => {
  // Golden values from the live devnet deployment (LOCALNET.md /
  // bootstrap output). If these move, the seeds or program id drifted.
  it('derives the deployed canvas + vault PDAs', () => {
    expect(canvasPda().toBase58()).toBe('zVi6pzVyZA5Qq1LQLoCCz4f8o2ALmwmVfxo1jFCzFDJ')
    expect(vaultPda().toBase58()).toBe('7wRW6aNDscY2tmBZxUXN4k4gVShhuCMLV2khFLZpUdku')
  })

  it('tile PDA varies with coordinates', () => {
    expect(tilePda(0, 0).toBase58()).not.toBe(tilePda(0, 1).toBase58())
    expect(tilePda(1, 0).toBase58()).not.toBe(tilePda(0, 1).toBase58())
  })
})

/* ------------------------- decode fixtures ------------------------- */

function syntheticTile(tileX: number, tileY: number): Buffer {
  const buf = Buffer.alloc(TILE_ACCOUNT_SIZE)
  buf.set(DISC.tile, 0)
  buf.writeUInt8(254, 8) // bump
  buf.writeUInt16LE(tileX, 10)
  buf.writeUInt16LE(tileY, 12)
  // Pixel 0: price 100000, red, t=1700000000, link 1
  let off = 16
  buf.writeBigUInt64LE(100_000n, off)
  buf.writeUInt32LE(0xff0000, off + 8)
  buf.writeUInt32LE(1_700_000_000, off + 12)
  buf.writeUInt32LE(1, off + 16)
  // Pixel 399 (last): price 2^40, blue, no link
  off = 16 + 399 * 24
  buf.writeBigUInt64LE(1n << 40n, off)
  buf.writeUInt32LE(0x0000ff, off + 8)
  buf.writeUInt32LE(1_800_000_000, off + 12)
  return buf
}

describe('decodeTile', () => {
  it('decodes coordinates and pixel fields at exact offsets', () => {
    const t = decodeTile(syntheticTile(7, 24))
    expect(t.tileX).toBe(7)
    expect(t.tileY).toBe(24)
    expect(t.pixels).toHaveLength(400)
    expect(t.pixels[0]).toEqual({
      lastPrice: 100_000n,
      color: 0xff0000,
      lastPaintedAt: 1_700_000_000,
      linkId: 1,
    })
    expect(t.pixels[399].lastPrice).toBe(1n << 40n)
    expect(t.pixels[399].color).toBe(0x0000ff)
    expect(t.pixels[1].lastPrice).toBe(0n) // untouched = virgin
  })

  it('rejects wrong size and wrong discriminator', () => {
    expect(() => decodeTile(Buffer.alloc(100))).toThrow(/not a Tile/)
    const bad = syntheticTile(0, 0)
    bad[0] ^= 0xff
    expect(() => decodeTile(bad)).toThrow(/not a Tile/)
  })
})

describe('decodeCanvasConfig', () => {
  it('decodes the borsh layout at exact offsets', () => {
    const treasury = new PublicKey('H3adprNfDdJaTciMgnaNM4cqW97Lecf6ASL1UxPc7y3Q')
    const buf = Buffer.alloc(8 + 1 + 8 + 8 + 8 + 32 + 8 + 4 + 28)
    buf.set(DISC.canvasConfig, 0)
    buf.writeUInt8(255, 8) // bump
    buf.writeBigUInt64LE(100_000n, 9) // starting_price
    buf.writeBigUInt64LE(1_000n, 17) // decay bps
    buf.writeBigInt64LE(7_776_000n, 25) // freeze (90 days)
    treasury.toBuffer().copy(buf, 33)
    buf.writeBigUInt64LE(18n, 65) // stamp_count
    buf.writeUInt32LE(1, 73) // link_count
    const cfg = decodeCanvasConfig(buf)
    expect(cfg.startingPrice).toBe(100_000n)
    expect(cfg.decayPerMonthBps).toBe(1_000n)
    expect(cfg.freezePeriodSeconds).toBe(7_776_000n)
    expect(cfg.treasury.toBase58()).toBe(treasury.toBase58())
    expect(cfg.stampCount).toBe(18n)
    expect(cfg.linkCount).toBe(1)
  })
})

describe('decodeLink', () => {
  it('decodes id + length-prefixed url', () => {
    const url = 'https://tagwall.io/'
    const buf = Buffer.alloc(8 + 4 + 4 + url.length)
    buf.set(DISC.link, 0)
    buf.writeUInt32LE(1, 8)
    buf.writeUInt32LE(url.length, 12)
    buf.write(url, 16)
    expect(decodeLink(buf)).toEqual({ id: 1, url })
  })
})

/* ----------------------- instruction encoding ---------------------- */

describe('buildPaintIx', () => {
  const painter = new PublicKey('8vKA37eGwhBhs8UcSa7otBPbPvTsHFz8nBoErH6nRVkf')
  const treasury = new PublicKey('H3adprNfDdJaTciMgnaNM4cqW97Lecf6ASL1UxPc7y3Q')
  const common = {
    painter,
    treasury,
    linkId: 0,
    metadataHash: new Uint8Array(32),
    maxTotalCost: 1_000_000n,
    reserveMultiplierBps: 10_000n,
  }

  it('fill chunk: discriminator + borsh field offsets', () => {
    const ix = buildPaintIx(
      { format: 'fill', x: 100, y: 40, w: 30, h: 30, color: 0xa8ff2e },
      common,
    )
    expect([...ix.data.subarray(0, 8)]).toEqual([...DISC.paintFill])
    expect(ix.data.readUInt32LE(8)).toBe(100) // x
    expect(ix.data.readUInt32LE(20)).toBe(30) // h
    expect(ix.data.readUInt32LE(24)).toBe(0xa8ff2e) // color
    expect(ix.data.readUInt32LE(28)).toBe(0) // link_id
    expect(ix.data.readBigUInt64LE(64)).toBe(1_000_000n) // max_total_cost
    expect(ix.data.readBigUInt64LE(72)).toBe(10_000n) // multiplier
    expect(ix.data.length).toBe(8 + 16 + 4 + 4 + 32 + 8 + 8)

    // Accounts: painter, canvas, treasury, referrer(=painter),
    // link(None=program id), system, then 4 tiles row-major.
    expect(ix.keys[0].pubkey.toBase58()).toBe(painter.toBase58())
    expect(ix.keys[4].pubkey.toBase58()).toBe(PROGRAM_ID.toBase58())
    expect(ix.keys).toHaveLength(6 + 4)
    expect(ix.keys[6].pubkey.toBase58()).toBe(tilePda(5, 2).toBase58())
    expect(ix.keys[7].pubkey.toBase58()).toBe(tilePda(6, 2).toBase58())
    expect(ix.keys[8].pubkey.toBase58()).toBe(tilePda(5, 3).toBase58())
    expect(ix.keys[9].pubkey.toBase58()).toBe(tilePda(6, 3).toBase58())
  })

  it('palette chunk: packed 3-byte entries, both vec length prefixes', () => {
    const ix = buildPaintIx(
      {
        format: 'palette',
        x: 0,
        y: 0,
        w: 3,
        h: 1,
        palette: [0xff0000, 0x0000ff],
        indices: new Uint8Array([0, 255, 1]),
      },
      { ...common, linkId: 1 },
    )
    expect([...ix.data.subarray(0, 8)]).toEqual([...DISC.paintPalette])
    expect(ix.data.readUInt32LE(24)).toBe(6) // palette byte len (2 entries * 3)
    expect([...ix.data.subarray(28, 34)]).toEqual([0xff, 0, 0, 0, 0, 0xff])
    expect(ix.data.readUInt32LE(34)).toBe(3) // indices len
    expect(ix.data[39]).toBe(255) // transparent marker survives
    // link account present when linkId > 0
    expect(ix.keys[4].pubkey.toBase58()).toBe(linkPda(1).toBase58())
  })

  it('u32 chunk: colors vec encodes verbatim', () => {
    const ix = buildPaintIx(
      {
        format: 'u32',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        colors: new Uint32Array([0x123456, 0xffffffff]),
      },
      common,
    )
    expect([...ix.data.subarray(0, 8)]).toEqual([...DISC.paint])
    expect(ix.data.readUInt32LE(24)).toBe(2)
    expect(ix.data.readUInt32LE(28)).toBe(0x123456)
    expect(ix.data.readUInt32LE(32)).toBe(0xffffffff)
  })
})

describe('buildInitTileIx', () => {
  it('encodes coords + bear_rent and the five accounts', () => {
    const payer = new PublicKey('8vKA37eGwhBhs8UcSa7otBPbPvTsHFz8nBoErH6nRVkf')
    const ix = buildInitTileIx(payer, 5, 7, true)
    expect([...ix.data.subarray(0, 8)]).toEqual([...DISC.initTile])
    expect(ix.data.readUInt16LE(8)).toBe(5)
    expect(ix.data.readUInt16LE(10)).toBe(7)
    expect(ix.data[12]).toBe(1)
    expect(ix.keys[2].pubkey.toBase58()).toBe(tilePda(5, 7).toBase58())
    expect(ix.keys[3].pubkey.toBase58()).toBe(vaultPda().toBase58())
  })
})
