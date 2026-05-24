/**
 * Signed static filter list (cpa-brief.md §2.1, Phase C).
 *
 * The frontend fetches a JSON document at boot, verifies its ed25519
 * signature against the operator's public key (compiled into the bundle
 * via VITE_FILTER_PUBKEY), and applies the entries to the render path:
 *
 *   - kind: 'address'  — drop any painted region whose painter or
 *                        referrer matches. Layered on top of the OFAC
 *                        oracle filter (web/src/hooks/useOfacSanctioned.ts).
 *   - kind: 'pixelRect' — drop any painted region whose stamp rectangle
 *                         intersects the listed rectangle. Slightly
 *                         over-blocks (whole stamp goes, not just the
 *                         overlapping pixels) but that's fine for
 *                         moderation: the operator who flagged the rect
 *                         can also flag the painter address if the rest
 *                         of their work is unobjectionable.
 *   - kind: 'linkHash' — replace the URL in OutboundLinkModal with a
 *                        block message. Hash is keccak256-style over
 *                        the URL bytes; matches Canvas.sol's linkIdOf
 *                        index so an operator can copy-paste from chain
 *                        events.
 *
 * Failure model:
 *   - Network error fetching the list → fail open (no entries applied).
 *     We trust the rest of the filter posture (OFAC + Cloudflare DoH)
 *     to cover most cases; missing static entries just means manual
 *     takedowns aren't enforced for that session.
 *   - Signature verification failure → fail closed (refuse the list,
 *     log to console). A rotated or compromised signing key should
 *     never silently override the operator's intended posture.
 *   - Malformed JSON → fail closed (same reasoning).
 *
 * Signing: see `scripts/sign-filter-list.mjs` for the operator tool.
 * The signed payload is the canonical-JSON encoding of every field
 * except `signature`. Canonicalisation is recursive alphabetical key
 * sort; both signer and verifier use the function below.
 */
import { ed25519 } from '@noble/curves/ed25519.js'

/* ----------------------------- types -------------------------------- */

export type FilterReason =
  | 'imda-takedown'
  | 'ncmec-csam'
  | 'ofac-fallback'
  | 'malicious-url'
  | 'user-report'
  | 'operator-discretion'

export interface FilterEntryAddress {
  kind: 'address'
  value: `0x${string}`
  reason: FilterReason
  addedAt: string // ISO-8601
  id: string
}

export interface FilterEntryPixelRect {
  kind: 'pixelRect'
  value: { x: number; y: number; w: number; h: number }
  reason: FilterReason
  addedAt: string
  id: string
}

export interface FilterEntryLinkHash {
  kind: 'linkHash'
  value: `0x${string}` // 32-byte keccak256 of the URL bytes
  reason: FilterReason
  addedAt: string
  id: string
}

export type FilterEntry = FilterEntryAddress | FilterEntryPixelRect | FilterEntryLinkHash

export interface SignedFilterList {
  version: 1
  publishedAt: string
  publisher: string
  entries: FilterEntry[]
  signature: `0x${string}`
}

export interface AppliedFilterSets {
  blockedAddresses: Set<string> // lowercased
  blockedPixelRects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>
  blockedLinkHashes: Set<string> // lowercased 0x-prefixed
}

export const EMPTY_FILTER_SETS: AppliedFilterSets = {
  blockedAddresses: new Set(),
  blockedPixelRects: [],
  blockedLinkHashes: new Set(),
}

/* ------------------------- canonicalisation ------------------------- */

/**
 * RFC 8785-lite: recursive alphabetical key sort, no whitespace, JSON
 * primitives. Both signer and verifier produce identical bytes for the
 * same logical value, so the signature is reproducible across
 * implementations as long as both use this function.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize(obj[k]),
  )
  return '{' + parts.join(',') + '}'
}

/* ------------------------- pubkey parsing --------------------------- */

/**
 * Parse a `VITE_FILTER_PUBKEY` value into raw bytes. Accepts either:
 *   - "ed25519:<64-hex>" (the recommended human-readable form)
 *   - "<64-hex>"          (raw hex, no prefix)
 *
 * Returns null for empty / malformed input so the caller can disable the
 * static filter cleanly when no key is configured.
 */
export function parsePubKey(raw: string | undefined): Uint8Array | null {
  if (!raw) return null
  let hex = raw.trim()
  if (hex.startsWith('ed25519:')) hex = hex.slice('ed25519:'.length)
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
  if (hex.length !== 64) return null
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function parseHexBytes(value: string): Uint8Array | null {
  let hex = value.trim()
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/* ------------------------------ verify ------------------------------ */

/**
 * Verify a fetched list against the operator's pubkey. Returns the
 * parsed list on success, null on any failure (signature invalid,
 * malformed JSON, missing fields). Failure intentionally swallows the
 * error to avoid leaking signing details; check the console for the
 * surfaced reason during development.
 */
export async function verifyFilterList(
  raw: unknown,
  pubKey: Uint8Array,
): Promise<SignedFilterList | null> {
  if (!raw || typeof raw !== 'object') {
    console.warn('[filterList] reject: payload is not an object')
    return null
  }
  const list = raw as Partial<SignedFilterList>
  if (
    list.version !== 1 ||
    typeof list.publishedAt !== 'string' ||
    typeof list.publisher !== 'string' ||
    !Array.isArray(list.entries) ||
    typeof list.signature !== 'string'
  ) {
    console.warn('[filterList] reject: missing or wrongly-typed top-level fields')
    return null
  }

  const sigBytes = parseHexBytes(list.signature)
  if (!sigBytes || sigBytes.length !== 64) {
    console.warn('[filterList] reject: signature is not 64 bytes hex')
    return null
  }

  const { signature: _ignored, ...rest } = list as SignedFilterList
  const message = new TextEncoder().encode(canonicalize(rest))

  let valid: boolean
  try {
    valid = await ed25519.verify(sigBytes, message, pubKey)
  } catch (err) {
    console.warn('[filterList] verify threw', err)
    return null
  }
  if (!valid) {
    console.warn('[filterList] reject: signature does not match pubkey')
    return null
  }

  return list as SignedFilterList
}

/* ------------------------- entry projection ------------------------- */

/**
 * Project a verified list into the rendering-friendly sets the hooks
 * actually consume. Single pass, O(entries).
 */
export function projectFilterSets(list: SignedFilterList | null): AppliedFilterSets {
  if (!list) return EMPTY_FILTER_SETS
  const blockedAddresses = new Set<string>()
  const blockedPixelRects: { x: number; y: number; w: number; h: number }[] = []
  const blockedLinkHashes = new Set<string>()
  for (const e of list.entries) {
    if (e.kind === 'address') blockedAddresses.add(e.value.toLowerCase())
    else if (e.kind === 'pixelRect') blockedPixelRects.push(e.value)
    else if (e.kind === 'linkHash') blockedLinkHashes.add(e.value.toLowerCase())
  }
  return { blockedAddresses, blockedPixelRects, blockedLinkHashes }
}

/* ------------------------- rect intersection ------------------------ */

/**
 * Two axis-aligned rectangles overlap iff each axis range overlaps.
 * Used by usePaintedRegions to drop stamps that intersect any blocked
 * pixelRect.
 */
export function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}
