/**
 * Solana link registry resolution: linkId -> URL via the Link PDA
 * accounts. The EVM dock components resolve linkIds with a multicall
 * against the canvas contract; this is the Solana analogue, batched
 * through getMultipleAccountsInfo so a leaderboard of N links costs
 * ceil(N / 100) RPC calls instead of N.
 *
 * URLs are ATTACKER-CONTROLLED: the program validates only the
 * https:// prefix and a length cap (see decodeLink in client.ts).
 * Callers must keep routing these through the outbound interstitial
 * and never raw-interpolate them into the DOM.
 */

import type { Connection } from '@solana/web3.js'

import { decodeLink, linkPda } from './client'

/** getMultipleAccountsInfo caps at 100 accounts per request. */
const CHUNK = 100

/**
 * Resolve registry URLs for the given linkIds. Ids <= 0 (the "no
 * link" sentinel) are ignored; ids whose PDA is missing or fails to
 * decode are simply absent from the result. A failed RPC chunk is
 * tolerated (logged + skipped) so one bad batch can't blank every
 * link in the dock.
 */
export async function fetchLinkUrls(
  connection: Connection,
  linkIds: number[],
): Promise<Map<number, string>> {
  const unique = Array.from(new Set(linkIds.filter((n) => Number.isInteger(n) && n > 0)))
  const out = new Map<number, string>()
  for (let start = 0; start < unique.length; start += CHUNK) {
    const ids = unique.slice(start, start + CHUNK)
    let infos: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>
    try {
      infos = await connection.getMultipleAccountsInfo(ids.map((id) => linkPda(id)))
    } catch (e) {
      console.warn('[solana/links] link account fetch failed, skipping chunk', e)
      continue
    }
    for (let i = 0; i < ids.length; i++) {
      const info = infos[i]
      if (!info) continue // unregistered id: no link to show
      try {
        const { url } = decodeLink(info.data)
        if (url) out.set(ids[i], url)
      } catch {
        // Not a Link account (or corrupt); skip this id only.
      }
    }
  }
  return out
}
