import { useEffect, useState } from 'react'

interface FounderEntry {
  chainId: number
  chain: string
  genesisLeft: number
  caughtUp: boolean
}

/**
 * Genesis spots left on a chain, from the tweets bot's public rollup
 * (/summary.json, refreshed every 30 min). A static asset, so this costs
 * no Worker request. Null until loaded, while the bot is still catching up
 * on that chain, or once the genesis tier is full.
 */
export function useGenesisLeft(chainId: number | null | undefined): number | null {
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!chainId) return
    let cancelled = false
    fetch(`/summary.json?t=${Math.floor(Date.now() / 600_000)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { founders?: FounderEntry[] } | null) => {
        if (cancelled) return
        const f = data?.founders?.find((e) => e.chainId === chainId)
        setLeft(f && f.caughtUp && f.genesisLeft > 0 ? f.genesisLeft : null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [chainId])
  return left
}
