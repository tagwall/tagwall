/**
 * Painted-event history for the Solana canvas: fetches the program's
 * recent transactions and decodes Anchor `Painted` events from their
 * logs, then synthesizes the SAME PaintedRegion shape the EVM canvas
 * uses so the shared presentational surfaces (LeaderboardTicker,
 * Leaderboard, ActivityFeed) render Solana history with zero changes.
 *
 * The one deliberate trick: those components format prices with
 * 18-decimal formatEther, so pricePaid is scaled lamports * 1e9 here.
 * The scaling is exact (integer multiply) and display-only; nothing
 * transactional reads these synthesized regions.
 */

import type { Connection } from '@solana/web3.js'

import type { PaintedRegion } from '../hooks/usePaintedRegions'
import { PROGRAM_ID } from './client'

/** sha256("event:Painted")[..8]; verified by recompute in tests. */
export const EVENT_DISC_PAINTED = Uint8Array.from([122, 87, 190, 84, 224, 53, 34, 178])

/** Borsh layout of the Painted event (lib.rs field order). */
export interface SolanaPaintedEvent {
  painter: Uint8Array // 32
  referrer: Uint8Array // 32
  x: number
  y: number
  w: number
  h: number
  totalCostLamports: bigint
  opaquePixels: bigint
  metadataHash: Uint8Array // 32
  stampIndex: bigint
  linkId: number
}

export function decodePaintedEvent(bytes: Uint8Array): SolanaPaintedEvent | null {
  if (bytes.length < 8 + 32 + 32 + 16 + 16 + 32 + 8 + 4) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== EVENT_DISC_PAINTED[i]) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 8
  const painter = bytes.subarray(o, o + 32)
  o += 32
  const referrer = bytes.subarray(o, o + 32)
  o += 32
  const x = v.getUint32(o, true)
  const y = v.getUint32(o + 4, true)
  const w = v.getUint32(o + 8, true)
  const h = v.getUint32(o + 12, true)
  o += 16
  const totalCostLamports = v.getBigUint64(o, true)
  const opaquePixels = v.getBigUint64(o + 8, true)
  o += 16
  const metadataHash = bytes.subarray(o, o + 32)
  o += 32
  const stampIndex = v.getBigUint64(o, true)
  const linkId = v.getUint32(o + 8, true)
  return {
    painter,
    referrer,
    x,
    y,
    w,
    h,
    totalCostLamports,
    opaquePixels,
    metadataHash,
    stampIndex,
    linkId,
  }
}

/** Pull every Anchor "Program data:" payload out of a tx's log lines. */
export function paintedEventsFromLogs(logs: readonly string[]): SolanaPaintedEvent[] {
  const out: SolanaPaintedEvent[] = []
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/)
    if (!m) continue
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))
    } catch {
      continue
    }
    const ev = decodePaintedEvent(bytes)
    if (ev) out.push(ev)
  }
  return out
}

// Local base58 for painter/referrer display (mirrors client.bs58Encode,
// re-declared to keep this module importable without a cycle concern).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58(bytes: Uint8Array): string {
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

function hex(bytes: Uint8Array): string {
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toRegion(
  ev: SolanaPaintedEvent,
  slot: number,
  logIndex: number,
  signature: string,
): PaintedRegion {
  return {
    blockNumber: BigInt(slot),
    logIndex,
    txHash: signature,
    painter: bs58(ev.painter),
    referrer: bs58(ev.referrer),
    metadataHash: hex(ev.metadataHash),
    x: ev.x,
    y: ev.y,
    w: ev.w,
    h: ev.h,
    pixelsPainted: Number(ev.opaquePixels),
    // lamports (9 dec) -> the 18-dec scale the shared formatters expect.
    pricePaid: ev.totalCostLamports * 1_000_000_000n,
    // Real Solana registry id. The shared dock components resolve it
    // via their `linkUrlsOverride` prop (fed by useSolanaLinkUrls over
    // the Link PDAs), never against an EVM contract.
    linkId: ev.linkId,
  }
}

/**
 * Fetch and decode the program's paint history. Devnet-scale (one
 * getSignaturesForAddress page); mainnet gets a proper indexer or
 * pagination before launch.
 */
export async function fetchPaintedRegions(connection: Connection): Promise<PaintedRegion[]> {
  const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 1000 })
  const ok = sigs.filter((s) => !s.err)
  const regions: PaintedRegion[] = []
  // RPC quirks both ways: the public endpoint rejects LARGE batches
  // ("Too many requests for a specific RPC call") and Helius's free
  // tier rejects ALL JSON-RPC batches (403 "Batch requests are only
  // available for paid plans"). Try small batches first; on failure
  // fall back to sequential single getTransaction calls for the group.
  const BATCH = 5
  for (let start = 0; start < ok.length; start += BATCH) {
    const group = ok.slice(start, start + BATCH)
    let txs: Awaited<ReturnType<Connection['getTransactions']>>
    try {
      txs = await connection.getTransactions(
        group.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      )
    } catch {
      try {
        txs = []
        for (const sig of group) {
          txs.push(
            await connection.getTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          )
        }
      } catch (e) {
        console.warn('[solana/history] tx fetch failed, skipping group', e)
        continue
      }
    }
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i]
      if (!tx?.meta?.logMessages) continue
      const events = paintedEventsFromLogs(tx.meta.logMessages)
      events.forEach((ev, j) => {
        regions.push(toRegion(ev, tx.slot, j, group[i].signature))
      })
    }
    if (start + BATCH < ok.length) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  // Ascending (blockNumber, logIndex), the order usePaintedRegions
  // guarantees and founder/board logic assumes.
  regions.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  )
  return regions
}
