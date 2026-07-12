/**
 * USD per native token by chain. Fallback fixtures used when the live
 * CoinGecko feed (useNativeUsdPrice) is unavailable. Values are
 * intentionally rounded; they exist to give the user a rough sense of
 * "$X" while offline or on first load. The contract charges the native
 * amount; USD is purely informational.
 */
/**
 * Pseudo chain id for the Solana canvas in chain-id-keyed lookups (USD
 * fixtures, the CoinGecko mapping, /ops rows). Solana has no EVM chain
 * id, so a negative sentinel keeps it out of every real id range; -501
 * nods to Solana's SLIP-44 coin type (501).
 */
export const SOLANA_PSEUDO_CHAIN_ID = -501

const NATIVE_USD: Record<number, number> = {
  // Ethereum mainnet
  1: 2_300,
  // Optimism, Arbitrum, Base — all priced in ETH
  10: 2_300,
  8453: 2_300,
  42_161: 2_300,
  // PulseChain mainnet (PLS), per the Tagwall PRD baseline.
  369: 0.000008148,
  // PulseChain testnet v4 (also PLS).
  943: 0.000008148,
  // BNB Smart Chain (BNB).
  56: 500,
  // HyperEVM (HYPE). Fallback ~ the 2026-05-30 deploy snapshot ($66.87).
  999: 67,
  // Robinhood Chain — priced in ETH like the other ETH-denominated chains.
  4663: 2_300,
  // Anvil dev chain — uses ETH currency by default.
  31337: 2_300,
  // Solana (SOL), via the pseudo chain id. Rough 2026-06 ballpark; the
  // live CoinGecko feed overrides this whenever it's reachable. Solana
  // amounts arrive pre-scaled lamports*1e9 (18-dec), so the shared
  // weiToUsd/weiToUsdRate math works unchanged.
  [SOLANA_PSEUDO_CHAIN_ID]: 150,
}

/**
 * Returns USD per 1 unit of the chain's native token. Falls back to 0
 * for unknown chain ids (caller should hide the USD readout instead of
 * showing $0).
 */
export function nativeUsdPrice(chainId: number | undefined | null): number {
  if (chainId == null) return 0
  return NATIVE_USD[chainId] ?? 0
}

/**
 * Formats a USD amount for the metric-strip / cost-line subline. Picks a
 * precision based on magnitude so a $2,300 floor reads cleanly while a
 * sub-cent PLS amount still shows a few significant figures.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  if (usd >= 1_000) return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toPrecision(2)}`
}

/**
 * Convenience: convert a native-token amount expressed in wei (bigint)
 * into a USD float using a chain-id lookup (fallback fixture). Returns 0
 * when the chain has no fixture. Prefer weiToUsdRate when a live rate
 * from useNativeUsdPrice is available.
 */
export function weiToUsd(wei: bigint, chainId: number | undefined | null): number {
  const rate = nativeUsdPrice(chainId)
  if (rate === 0) return 0
  // `wei` can be attacker-controlled (pricePaid from event logs); a value
  // past float range would otherwise propagate Infinity into the UI.
  const ether = Number(wei) / 1e18
  if (!Number.isFinite(ether)) return 0
  return ether * rate
}

/**
 * Convert a native-token wei amount into USD using an explicit rate.
 * Use this alongside useNativeUsdPrice so the display reflects live
 * spot instead of the hardcoded fixture.
 */
export function weiToUsdRate(wei: bigint, usdPerNative: number): number {
  if (usdPerNative <= 0) return 0
  // Same attacker-controlled-bigint guard as weiToUsd; formatUsd hides
  // the readout when this returns 0.
  const ether = Number(wei) / 1e18
  if (!Number.isFinite(ether)) return 0
  return ether * usdPerNative
}
