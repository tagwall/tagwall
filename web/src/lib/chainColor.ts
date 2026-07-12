/**
 * Chain color tokens — see docs/design_handoff_chain_palette/README.md.
 *
 * Chain colors are a context signal that rides on the wallet chip dot,
 * the network badge (chain dropdown trigger), and tx-link affordances.
 * Lime (`--tw-accent`) stays reserved for the brand: CTA, heatmap, and
 * "you / owned" surfaces. The Anvil entry intentionally aliases the
 * brand lime so dev mode reads as native chrome.
 */
export const CHAIN_COLORS = {
  // active
  anvil: '#A8FF2E',
  ethereum: '#7C9BFF',
  pulse: '#FF5BD0',
  base: '#3DC9FF',
  solana: '#B47BFF',
  hyperevm: '#50D2C1',
  robinhood: '#00C805',
  // reserved — wire up when chain ships
  arbitrum: '#5BD9C5',
  optimism: '#FF5C5C',
  polygon: '#9B5CFF',
  avalanche: '#FF7849',
  sui: '#5BB8FF',
  bnb: '#FFD63D',
} as const

export type ChainKey = keyof typeof CHAIN_COLORS

/**
 * Map wagmi/viem chain ids to a key in CHAIN_COLORS. PulseChain testnet
 * (943) reuses the mainnet `pulse` color since the visual identity is
 * the same network family. Unknown ids return null; the caller falls
 * back to the brand lime.
 */
export function chainKeyById(id: number | undefined | null): ChainKey | null {
  switch (id) {
    case 31337:
      return 'anvil'
    case 1:
      return 'ethereum'
    case 369:
    case 943:
      return 'pulse'
    case 8453:
      return 'base'
    case 56:
      return 'bnb'
    case 999:
      return 'hyperevm'
    case 4663:
      return 'robinhood'
    // Solana isn't an EVM chain id; it would land via a separate
    // connector that hands us a `'solana'` key directly. Reserved
    // chains (arbitrum, optimism, …) wire up at chain id 42161, 10,
    // 137, 43114 etc. when those networks ship.
    default:
      return null
  }
}

interface ChainColorTokens {
  /** The key, e.g. 'ethereum'. null when unknown. */
  key: ChainKey | null
  /** Opaque hex (`#7C9BFF`). Falls back to the brand lime for unknown. */
  hex: string
  /** 53% alpha hex — chip dot box-shadow per the alpha ladder. */
  dotGlow: string
  /** 33% alpha hex — network badge border. */
  badge: string
  /** 20% alpha hex — CTA fill box-shadow (chain-CTAs only; primary
   *  Tag-it CTA stays lime always per the handoff usage rules). */
  ctaGlow: string
}

const ACCENT_FALLBACK: ChainColorTokens = {
  key: null,
  hex: '#A8FF2E',
  dotGlow: '#A8FF2E88',
  badge: '#A8FF2E55',
  ctaGlow: '#A8FF2E33',
}

/**
 * Resolve a chain id to its color tokens. Pre-connect or unknown chain
 * returns the brand lime so chrome stays coherent until a wallet
 * confirms a network.
 */
export function chainColorTokens(chainId: number | undefined | null): ChainColorTokens {
  const key = chainKeyById(chainId)
  if (!key) return ACCENT_FALLBACK
  const hex = CHAIN_COLORS[key]
  return {
    key,
    hex,
    dotGlow: `${hex}88`,
    badge: `${hex}55`,
    ctaGlow: `${hex}33`,
  }
}
