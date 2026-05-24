/**
 * USD per native token by chain. Fallback fixtures used when the live
 * CoinGecko feed (useNativeUsdPrice) is unavailable. Values are
 * intentionally rounded; they exist to give the user a rough sense of
 * "$X" while offline or on first load. The contract charges the native
 * amount; USD is purely informational.
 */
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
  // Anvil dev chain — uses ETH currency by default.
  31337: 2_300,
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
  const ether = Number(wei) / 1e18
  return ether * rate
}

/**
 * Convert a native-token wei amount into USD using an explicit rate.
 * Use this alongside useNativeUsdPrice so the display reflects live
 * spot instead of the hardcoded fixture.
 */
export function weiToUsdRate(wei: bigint, usdPerNative: number): number {
  if (usdPerNative <= 0) return 0
  const ether = Number(wei) / 1e18
  return ether * usdPerNative
}
