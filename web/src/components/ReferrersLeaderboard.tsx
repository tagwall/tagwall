import { useEffect, useState } from 'react'

/**
 * ReferrersLeaderboard — cross-chain top-N referrer board.
 *
 * Data source: /leaderboard.json, written every 30 min by the tweets
 * bot (bots/tweets/main.py → build_referrer_leaderboard → write_leaderboard).
 * The bot does the chain-scanning and the ENS reverse-lookup work, so
 * this component is purely presentational — no wagmi calls, no
 * react-query, no chain-id awareness needed.
 *
 * Renders rank → name-or-address → paint count → per-native earnings
 * stack. The component sits alongside the per-paint Leaderboard in
 * the activity dock on HomePage; same card chrome (var(--bg-panel),
 * 1px border, 10px radius) so they read as siblings.
 *
 * Empty state: when the bot hasn't written any referrers yet (fresh
 * deploy, or no paints have come through a non-self non-zero ref),
 * the card still renders with a "no referrals yet" line + a nudge
 * pointing at the /share page so the operator's audience knows how
 * to participate.
 */

interface ReferrerEarning {
  native: string         // 'PLS' | 'ETH' | 'BNB' | etc.
  wei: string            // serialized big int (JSON can't carry bigint)
  formatted: string      // pre-formatted '7,500 PLS' / '0.42 BNB'
}

interface ReferrerRow {
  address: string        // checksummed 0x address
  addressShort: string   // '0x1bBe…685B'
  paintCount: number     // total paints referred across all chains
  earnings: ReferrerEarning[]
  /** ENS primary name resolved by the bot on Ethereum mainnet, or
   *  null if no name was set / lookup failed. */
  name: string | null
}

interface LeaderboardPayload {
  generatedAt: string
  windowDays: number
  topN: number
  referrers: ReferrerRow[]
}

export function ReferrersLeaderboard() {
  const [data, setData] = useState<LeaderboardPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Cache-bust to the current minute, matching the cadence the bot
    // could possibly have updated this file. Aligns with TweetsPage's
    // queue/summary fetch behaviour.
    const bust = Math.floor(Date.now() / 60_000)
    fetch(`/leaderboard.json?t=${bust}`, { cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = (await res.json()) as LeaderboardPayload
        if (!cancelled) setData(payload)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoadError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="leaderboard referrers-leaderboard">
      <div className="leaderboard-header">
        <h3>Top referrers</h3>
        <span className="leaderboard-sub">
          {data ? `last ${data.windowDays} days` : loadError ? 'unavailable' : 'loading…'}
        </span>
      </div>

      {data && data.referrers.length === 0 && (
        <p className="referrers-empty">
          No referrals yet. Drop your <code>?ref=&lt;wallet&gt;</code> link and you'll
          appear here once someone paints through it. <a href="/share">Get your link →</a>
        </p>
      )}

      {data && data.referrers.length > 0 && (
        <ol className="leaderboard-list referrers-list">
          {data.referrers.map((r, i) => (
            <li key={r.address} className="leaderboard-row referrers-row">
              <span className="leaderboard-rank">{i + 1}</span>
              <div className="referrers-identity">
                {r.name ? (
                  <>
                    <span className="referrers-name" title={r.address}>{r.name}</span>
                    <span className="referrers-address-dim">{r.addressShort}</span>
                  </>
                ) : (
                  <span className="referrers-address" title={r.address}>{r.addressShort}</span>
                )}
              </div>
              <div className="referrers-count" title={`${r.paintCount} paint${r.paintCount === 1 ? '' : 's'} referred`}>
                {r.paintCount.toLocaleString()}
                <span className="referrers-count-label">{r.paintCount === 1 ? 'paint' : 'paints'}</span>
              </div>
              <div className="referrers-earnings">
                {r.earnings.map((e) => (
                  <div key={e.native} className="referrers-earnings-row">
                    {e.formatted}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
