import { useMemo } from 'react'
import { PublicKey } from '@solana/web3.js'

/**
 * Loose-but-safe base58 pubkey check for user-supplied referrer
 * strings. Length bounds reject obvious junk cheaply (a 32-byte key
 * is 32-44 base58 chars); `new PublicKey` then does the real base58
 * decode + 32-byte validation. No curve check: referrers are plain
 * lamport recipients, so off-curve (PDA) addresses are acceptable,
 * matching what the program itself enforces (nothing).
 */
export function isValidSolanaAddress(s: string): boolean {
  const t = s.trim()
  if (t.length < 32 || t.length > 44) return false
  try {
    return new PublicKey(t).toBytes().length === 32
  } catch {
    return false
  }
}

/**
 * Solana analogue of HomePage's useSharedReferrer: reads ?ref= from
 * the URL and returns it as a PublicKey when it parses as a valid
 * base58 pubkey, undefined otherwise (including malformed values,
 * which are silently dropped just like invalid EVM ?ref= addresses).
 */
export function useSolanaReferrer(): PublicKey | undefined {
  return useMemo(() => {
    if (typeof window === 'undefined') return undefined
    const v = new URLSearchParams(window.location.search).get('ref')
    if (!v || !isValidSolanaAddress(v)) return undefined
    return new PublicKey(v.trim())
  }, [])
}
