/**
 * Solana on-chain client layer: PDA derivation, account decoding, and
 * instruction building from encoder plans. Layouts mirror
 * solana/programs/tagwall/src/state.rs byte for byte; a drift produces
 * garbage decodes, so test/solanaClient.test.ts locks every layout
 * with synthetic fixtures and recomputed discriminators.
 *
 * Byte handling is DataView/Uint8Array throughout; the `buffer`
 * polyfill appears only at the web3.js TransactionInstruction boundary
 * (its type defs are too weak for arithmetic use in the strict build).
 */

import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js'

import {
  SOLANA_COMPUTE_UNIT_LIMIT,
  SOLANA_PROGRAM_ID,
  SOLANA_TILE_SIZE,
} from './constants'
import type { StampChunk } from './encodeStamp'

export const PROGRAM_ID = new PublicKey(SOLANA_PROGRAM_ID)

/* -------------------------- discriminators -------------------------- */
// Anchor: sha256("account:<Name>")[..8] / sha256("global:<ix_name>")[..8].
// Hardcoded so the browser bundle needs no sync sha256; the vitest
// suite recomputes them with node crypto and asserts equality.

export const DISC = {
  tile: Uint8Array.from([95, 45, 214, 228, 61, 172, 201, 208]),
  canvasConfig: Uint8Array.from([151, 139, 161, 138, 84, 8, 253, 20]),
  link: Uint8Array.from([90, 57, 179, 207, 13, 91, 161, 190]),
  linkHash: Uint8Array.from([54, 135, 201, 243, 213, 180, 249, 204]),
  initTile: Uint8Array.from([175, 114, 177, 162, 220, 12, 153, 115]),
  registerLink: Uint8Array.from([107, 165, 116, 196, 1, 176, 74, 123]),
  paint: Uint8Array.from([43, 67, 254, 42, 131, 222, 81, 241]),
  paintFill: Uint8Array.from([235, 70, 191, 209, 72, 222, 139, 103]),
  paintPalette: Uint8Array.from([47, 137, 1, 174, 145, 197, 177, 18]),
} as const

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

/* ------------------------------- PDAs -------------------------------- */

function u16le(v: number): Uint8Array {
  return Uint8Array.from([v & 0xff, (v >> 8) & 0xff])
}

function u32le(v: number): Uint8Array {
  return Uint8Array.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
}

const enc = new TextEncoder()

export function canvasPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode('canvas')], PROGRAM_ID)[0]
}

export function vaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode('vault')], PROGRAM_ID)[0]
}

export function tilePda(tileX: number, tileY: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('tile'), u16le(tileX), u16le(tileY)],
    PROGRAM_ID,
  )[0]
}

export function linkPda(linkId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('link'), u32le(linkId)],
    PROGRAM_ID,
  )[0]
}

export function linkHashPda(sha256OfUrl: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('linkhash'), sha256OfUrl],
    PROGRAM_ID,
  )[0]
}

/* --------------------------- account decode -------------------------- */

export interface SolanaPixel {
  lastPrice: bigint
  color: number
  lastPaintedAt: number
  linkId: number
}

export interface SolanaTile {
  tileX: number
  tileY: number
  pixels: SolanaPixel[]
}

/** state.rs Tile: 8 disc + {bump u8, pad u8, tile_x u16, tile_y u16,
 *  pad u16} + 400 * Pixel{last_price u64, color u32, last_painted_at
 *  u32, link_id u32, pad u32} = 9,616 bytes. */
export const TILE_ACCOUNT_SIZE = 8 + 8 + 400 * 24

export function decodeTile(data: Uint8Array): SolanaTile {
  if (data.length !== TILE_ACCOUNT_SIZE || !bytesEqual(data.subarray(0, 8), DISC.tile)) {
    throw new Error('not a Tile account')
  }
  const v = viewOf(data)
  const tileX = v.getUint16(10, true)
  const tileY = v.getUint16(12, true)
  const pixels: SolanaPixel[] = new Array(400)
  let off = 16
  for (let i = 0; i < 400; i++) {
    pixels[i] = {
      lastPrice: v.getBigUint64(off, true),
      color: v.getUint32(off + 8, true),
      lastPaintedAt: v.getUint32(off + 12, true),
      linkId: v.getUint32(off + 16, true),
    }
    off += 24
  }
  return { tileX, tileY, pixels }
}

export interface SolanaCanvasConfig {
  startingPrice: bigint
  decayPerMonthBps: bigint
  freezePeriodSeconds: bigint
  treasury: PublicKey
  stampCount: bigint
  linkCount: number
}

export function decodeCanvasConfig(data: Uint8Array): SolanaCanvasConfig {
  if (!bytesEqual(data.subarray(0, 8), DISC.canvasConfig)) {
    throw new Error('not a CanvasConfig account')
  }
  const v = viewOf(data)
  return {
    startingPrice: v.getBigUint64(9, true),
    decayPerMonthBps: v.getBigUint64(17, true),
    freezePeriodSeconds: v.getBigInt64(25, true),
    treasury: new PublicKey(data.subarray(33, 65)),
    stampCount: v.getBigUint64(65, true),
    linkCount: v.getUint32(73, true),
  }
}

export function decodeLink(data: Uint8Array): { id: number; url: string } {
  if (!bytesEqual(data.subarray(0, 8), DISC.link)) {
    throw new Error('not a Link account')
  }
  const v = viewOf(data)
  const id = v.getUint32(8, true)
  const len = v.getUint32(12, true)
  // ATTACKER-CONTROLLED bytes: only the https:// prefix and length were
  // validated on-chain. Render through the same URL hardening the EVM
  // links use (parse + re-serialize, never raw interpolation).
  const url = new TextDecoder().decode(data.subarray(16, 16 + len))
  return { id, url }
}

export function decodeLinkHash(data: Uint8Array): { linkId: number } {
  if (!bytesEqual(data.subarray(0, 8), DISC.linkHash)) {
    throw new Error('not a LinkHash account')
  }
  return { linkId: viewOf(data).getUint32(8, true) }
}

/* --------------------------- canvas fetch ---------------------------- */

/**
 * Fetch every existing tile in one getProgramAccounts call (tiles are
 * lazy-created, so this returns only painted regions' tiles; the rest
 * of the canvas is implicitly virgin).
 */
export async function fetchAllTiles(connection: Connection): Promise<SolanaTile[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: TILE_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58Encode(DISC.tile) } },
    ],
  })
  return accounts.map((a) => decodeTile(a.account.data))
}

// Minimal base58 encode for the 8-byte memcmp filter (avoids a bs58
// dependency; fine for tiny inputs).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function bs58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

/* ------------------------ instruction building ----------------------- */

export interface PaintCommon {
  painter: PublicKey
  treasury: PublicKey
  linkId: number
  metadataHash: Uint8Array // 32 bytes
  maxTotalCost: bigint
  reserveMultiplierBps: bigint
  referrer?: PublicKey
}

function tilesForRect(x: number, y: number, w: number, h: number): PublicKey[] {
  const out: PublicKey[] = []
  const ty0 = Math.floor(y / SOLANA_TILE_SIZE)
  const ty1 = Math.floor((y + h - 1) / SOLANA_TILE_SIZE)
  const tx0 = Math.floor(x / SOLANA_TILE_SIZE)
  const tx1 = Math.floor((x + w - 1) / SOLANA_TILE_SIZE)
  // Row-major (ty, tx), the order the program walks the bounding box.
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) out.push(tilePda(tx, ty))
  }
  return out
}

/** Incremental little-endian byte writer for instruction data. */
class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private off = 0

  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }

  bytes(b: Uint8Array): this {
    this.buf.set(b, this.off)
    this.off += b.length
    return this
  }

  u8(v: number): this {
    this.view.setUint8(this.off, v)
    this.off += 1
    return this
  }

  u16(v: number): this {
    this.view.setUint16(this.off, v, true)
    this.off += 2
    return this
  }

  u32(v: number): this {
    this.view.setUint32(this.off, v, true)
    this.off += 4
    return this
  }

  u64(v: bigint): this {
    this.view.setBigUint64(this.off, v, true)
    this.off += 8
    return this
  }

  done(): Uint8Array {
    if (this.off !== this.buf.length) {
      throw new Error(`writer underfill: ${this.off} of ${this.buf.length}`)
    }
    return this.buf
  }
}

function writeRectAndTail(
  w: ByteWriter,
  chunk: { x: number; y: number; w: number; h: number },
  c: PaintCommon,
  middle: (w: ByteWriter) => void,
): Uint8Array {
  w.u32(chunk.x).u32(chunk.y).u32(chunk.w).u32(chunk.h)
  middle(w)
  w.u32(c.linkId).bytes(c.metadataHash).u64(c.maxTotalCost).u64(c.reserveMultiplierBps)
  return w.done()
}

const TAIL_BYTES = 4 + 32 + 8 + 8
const RECT_BYTES = 16

/**
 * Build the program instruction for one encoder chunk. Callers prepend
 * computeBudgetIx() and handle tile init separately (buildInitTileIx).
 */
export function buildPaintIx(chunk: StampChunk, c: PaintCommon): TransactionInstruction {
  let data: Uint8Array
  if (chunk.format === 'fill') {
    const w = new ByteWriter(8 + RECT_BYTES + 4 + TAIL_BYTES)
    w.bytes(DISC.paintFill)
    data = writeRectAndTail(w, chunk, c, (b) => b.u32(chunk.color))
  } else if (chunk.format === 'palette') {
    // Program v2.2 wire format: the table is packed 3-byte RGB
    // entries (Vec<u8> of length 3 * entries) instead of u32s.
    const w = new ByteWriter(
      8 + RECT_BYTES + 4 + 3 * chunk.palette.length + 4 + chunk.indices.length + TAIL_BYTES,
    )
    w.bytes(DISC.paintPalette)
    data = writeRectAndTail(w, chunk, c, (b) => {
      b.u32(3 * chunk.palette.length)
      for (const col of chunk.palette) {
        b.u8((col >> 16) & 0xff).u8((col >> 8) & 0xff).u8(col & 0xff)
      }
      b.u32(chunk.indices.length).bytes(chunk.indices)
    })
  } else {
    const w = new ByteWriter(8 + RECT_BYTES + 4 + 4 * chunk.colors.length + TAIL_BYTES)
    w.bytes(DISC.paint)
    data = writeRectAndTail(w, chunk, c, (b) => {
      b.u32(chunk.colors.length)
      for (const col of chunk.colors) b.u32(col)
    })
  }

  const referrer = c.referrer ?? c.painter // self-referral routes to treasury
  const keys = [
    { pubkey: c.painter, isSigner: true, isWritable: true },
    { pubkey: canvasPda(), isSigner: false, isWritable: true },
    { pubkey: c.treasury, isSigner: false, isWritable: true },
    { pubkey: referrer, isSigner: false, isWritable: true },
    // Optional link account: Anchor encodes None as the program id.
    {
      pubkey: c.linkId === 0 ? PROGRAM_ID : linkPda(c.linkId),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...tilesForRect(chunk.x, chunk.y, chunk.w, chunk.h).map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
  ]
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  })
}

export function buildInitTileIx(
  payer: PublicKey,
  tileX: number,
  tileY: number,
  bearRent = false,
): TransactionInstruction {
  const w = new ByteWriter(8 + 2 + 2 + 1)
  w.bytes(DISC.initTile).u16(tileX).u16(tileY).u8(bearRent ? 1 : 0)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: canvasPda(), isSigner: false, isWritable: false },
      { pubkey: tilePda(tileX, tileY), isSigner: false, isWritable: true },
      { pubkey: vaultPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(w.done()),
  })
}

/**
 * Register a URL in the link registry. `linkId` must be the canvas
 * config's link_count + 1 (the program enforces the sequence);
 * `urlHash` is sha256(url), recomputed and verified on-chain.
 */
export function buildRegisterLinkIx(
  payer: PublicKey,
  linkId: number,
  url: string,
  urlHash: Uint8Array,
): TransactionInstruction {
  const urlBytes = enc.encode(url)
  const w = new ByteWriter(8 + 4 + 4 + urlBytes.length + 32)
  w.bytes(DISC.registerLink).u32(linkId).u32(urlBytes.length).bytes(urlBytes).bytes(urlHash)
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: canvasPda(), isSigner: false, isWritable: true },
      { pubkey: linkPda(linkId), isSigner: false, isWritable: true },
      { pubkey: linkHashPda(urlHash), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(w.done()),
  })
}

export function computeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({
    units: SOLANA_COMPUTE_UNIT_LIMIT,
  })
}

/* ----------------------- v0 + lookup tables -------------------------- */

import {
  AddressLookupTableAccount,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ALT_FIXED_PREFIX,
  ALT_TABLE_CAPACITY,
  ALT_TABLES,
} from './alts.generated'
import { SOLANA_CLUSTER } from './cluster'

const TILES_X = 63 // ceil(1250 / 20); mirrors setup-alts.ts layout

/** The active cluster's published ALT addresses. Empty until
 *  setup-alts.ts has run for the cluster. */
export function altAddressesForCluster(): string[] {
  return [...((ALT_TABLES as Record<string, readonly string[]>)[SOLANA_CLUSTER] ?? [])]
}

/**
 * Which tables of the published set a given tile set needs. Tile
 * (tx, ty) lives at global slot ALT_FIXED_PREFIX + ty * TILES_X + tx;
 * table k holds slots [k * 256, (k + 1) * 256). Table 0 (fixed
 * accounts) is always included.
 */
export function altTablesForTiles(
  tiles: { tx: number; ty: number }[],
): Set<number> {
  const needed = new Set<number>([0])
  for (const t of tiles) {
    const slot = ALT_FIXED_PREFIX + t.ty * TILES_X + t.tx
    needed.add(Math.floor(slot / ALT_TABLE_CAPACITY))
  }
  return needed
}

/**
 * Compile instructions into a v0 transaction against the loaded
 * lookup tables. The compiler pulls every address it can from the
 * tables (1-byte refs) and keeps the rest static; signing and
 * sending work exactly like legacy.
 */
export function buildV0Transaction(
  ixs: TransactionInstruction[],
  payer: PublicKey,
  recentBlockhash: string,
  tables: AddressLookupTableAccount[],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: ixs,
  }).compileToV0Message(tables)
  return new VersionedTransaction(message)
}

/** Fetch + cache-warm the cluster's lookup tables. Returns [] when the
 *  cluster has none published (callers fall back to legacy txs). */
export async function fetchAltTables(
  connection: Connection,
): Promise<AddressLookupTableAccount[]> {
  const addrs = altAddressesForCluster()
  if (addrs.length === 0) return []
  const out: AddressLookupTableAccount[] = []
  for (const a of addrs) {
    const res = await connection.getAddressLookupTable(new PublicKey(a))
    if (!res.value) return [] // any missing table = fall back wholesale
    out.push(res.value)
  }
  return out
}
