import { useQuery } from '@tanstack/react-query'
import { nativeUsdPrice, SOLANA_PSEUDO_CHAIN_ID } from '../lib/usdPrice'

// CoinGecko simple price API — free tier, no key, ~30 req/min rate limit.
// Each chain maps to the CoinGecko token ID for its native currency.
const COINGECKO_IDS: Partial<Record<number, string>> = {
  1:     'ethereum',
  8453:  'ethereum',  // Base: ETH-denominated
  56:    'binancecoin',
  369:   'pulsechain',
  943:   'pulsechain',  // PulseChain v4 testnet, same token
  999:   'hyperliquid', // HyperEVM: HYPE-denominated
  4663:  'ethereum',    // Robinhood Chain: ETH-denominated
  31337: 'ethereum',   // Anvil dev chain
  [SOLANA_PSEUDO_CHAIN_ID]: 'solana', // Solana canvas (pseudo chain id)
}

const STALE_MS = 5 * 60 * 1_000  // 5 min

async function fetchPrice(geckoId: string): Promise<number> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, { usd?: number }>
  const price = json[geckoId]?.usd
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error(`no price for ${geckoId}`)
  }
  return price
}

/**
 * Live USD per 1 native token for the given chain. Fetches from CoinGecko
 * and refreshes every 5 minutes. Falls back to the hardcoded fixture in
 * usdPrice.ts when the network call fails or the chain has no mapping.
 * Returns 0 for chains with no fixture and no live price.
 */
export function useNativeUsdPrice(chainId: number | undefined | null): number {
  const geckoId = chainId != null ? COINGECKO_IDS[chainId] : undefined
  const fallback = nativeUsdPrice(chainId)

  const { data } = useQuery({
    queryKey: ['native-usd-price', geckoId],
    queryFn: () => fetchPrice(geckoId!),
    enabled: !!geckoId,
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
    retry: 1,
    // Show hardcoded value while the first fetch is in-flight so there's
    // no flicker to $0 on mount.
    placeholderData: fallback > 0 ? fallback : undefined,
  })

  return data ?? fallback
}
