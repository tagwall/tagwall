import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { formatEther, getAddress, parseAbiItem, zeroAddress } from 'viem'
import { usePublicClient } from 'wagmi'

import { canvasAddress } from '../contracts/canvas'
import {
  CONTEST_CHAIN,
  CONTEST_END_MS as END_MS,
  CONTEST_FLOOR_PLS,
  CONTEST_START_MS as START_MS,
  NOMINATION_END_MS,
  NOMINATION_TWEET_URL,
  nominationLive,
} from '../lib/contest'
import { deployBlockFor, logsChunkSizeFor } from '../lib/deployBlocks'
import { getLogsPaginated } from '../lib/paginatedLogs'

/* ------------------------------------------------------------------ *
 * Page-specific contest config (the window + chain + floor live in
 * lib/contest.ts so the banner stays in sync). Retune split here.
 * ------------------------------------------------------------------ */
const POOL_BPS = 8000n // 80% of referred-paint revenue
const FLOOR_WEI = BigInt(CONTEST_FLOOR_PLS) * 10n ** 18n // guaranteed minimum pool
const FLOOR_PLS_LABEL = CONTEST_FLOOR_PLS.toLocaleString('en-US') // e.g. "7,777,777"
const SPLIT = [50, 30, 20] // % of pool to ranks 1/2/3

const PAINTED_EVENT = parseAbiItem(
  'event Painted(address indexed painter, address indexed referrer, bytes32 indexed metadataHash, uint32 x, uint32 y, uint32 w, uint32 h, uint32 pixelsPainted, uint256 pricePaid, uint32 linkId)',
)

type Status = 'upcoming' | 'live' | 'ended'
interface BoardRow {
  addr: string
  volume: bigint
  count: number
}
interface ContestData {
  status: Status
  poolWei: bigint
  revenueWei: bigint
  board: BoardRow[]
}

/** First block whose timestamp is >= targetSec, searched in [lo, hi]. */
async function blockAtTimestamp(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  targetSec: bigint,
  lo: bigint,
  hi: bigint,
): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const blk = await client.getBlock({ blockNumber: mid })
    if (blk.timestamp < targetSec) lo = mid + 1n
    else hi = mid
  }
  return lo
}

function fmtPls(wei: bigint): string {
  const n = Number(formatEther(wei))
  if (n >= 1e6) return (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M'
  if (n >= 1e3) return (n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'K'
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function useCountdown(targetMs: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  let s = Math.max(0, Math.floor((targetMs - now) / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return `${d}d ${h}h ${m}m ${s}s`
}

export default function CompetitionPage() {
  const client = usePublicClient({ chainId: CONTEST_CHAIN })

  const { data, isLoading } = useQuery<ContestData | null>({
    queryKey: ['referral-contest', CONTEST_CHAIN],
    enabled: !!client,
    refetchInterval: 120_000,
    staleTime: 60_000,
    queryFn: async (): Promise<ContestData | null> => {
      if (!client) return null
      const nowSec = BigInt(Math.floor(Date.now() / 1000))
      const startSec = BigInt(Math.floor(START_MS / 1000))
      const endSec = BigInt(Math.floor(END_MS / 1000))

      if (nowSec < startSec) {
        return { status: 'upcoming', poolWei: FLOOR_WEI, revenueWei: 0n, board: [] }
      }

      const head = await client.getBlockNumber()
      const deploy = deployBlockFor(CONTEST_CHAIN)
      const startBlock = await blockAtTimestamp(client, startSec, deploy, head)
      const ended = nowSec >= endSec
      const toBlock = ended ? await blockAtTimestamp(client, endSec, deploy, head) : head
      const status: Status = ended ? 'ended' : 'live'

      if (toBlock <= startBlock) {
        return { status, poolWei: FLOOR_WEI, revenueWei: 0n, board: [] }
      }

      const { logs } = await getLogsPaginated({
        publicClient: client,
        address: canvasAddress(CONTEST_CHAIN) as Hex,
        event: PAINTED_EVENT,
        fromBlock: startBlock,
        toBlock,
        chunkSize: logsChunkSizeFor(CONTEST_CHAIN),
      })

      let revenue = 0n
      const map = new Map<string, BoardRow>()
      for (const log of logs) {
        const ref = log.args.referrer
        if (!ref || ref === zeroAddress) continue // only referred paints count
        const paid = log.args.pricePaid ?? 0n
        revenue += paid
        const key = getAddress(ref)
        const cur = map.get(key) ?? { addr: key, volume: 0n, count: 0 }
        cur.volume += paid
        cur.count += 1
        map.set(key, cur)
      }
      const computed = (revenue * POOL_BPS) / 10000n
      const poolWei = computed > FLOOR_WEI ? computed : FLOOR_WEI
      const board = [...map.values()].sort((a, b) =>
        b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0,
      )
      return { status, poolWei, revenueWei: revenue, board }
    },
  })

  const status: Status = data?.status ?? (Date.now() < START_MS ? 'upcoming' : 'live')
  const pool = data?.poolWei ?? FLOOR_WEI
  const board = data?.board ?? []
  const atFloor = pool <= FLOOR_WEI
  const countdown = useCountdown(status === 'upcoming' ? START_MS : END_MS)

  const statusLabel =
    status === 'upcoming' ? 'starts in' : status === 'live' ? 'ends in' : 'ended'

  // While the nomination contest is live it is the featured competition;
  // the referral contest below takes over once it closes (Mon 06-22).
  if (nominationLive()) return <NominationContest />

  return (
    <div className="shell-measure comp-page">
      <header className="comp-header">
        {status === 'upcoming' && <div className="comp-soon">coming soon · opens 22 Jun</div>}
        <h1>referral contest</h1>
        <p>
          share your tagwall link and every paint through it earns you 5% on the spot. on top of
          that, the top 3 referrers this week split the prize pool. the pool is 80% of all referred
          paint volume during the week, so it grows with every paint.
        </p>
        <p className="comp-window">22 Jun 00:00 UTC → 29 Jun 00:00 UTC</p>
      </header>

      <section className="comp-pool">
        <div className="comp-pool-label">{atFloor ? 'minimum prize pool' : 'prize pool'}</div>
        <div className="comp-pool-value">
          {fmtPls(pool)} <span className="comp-pool-unit">PLS</span>
        </div>
        <div className="comp-pool-sub">
          {atFloor
            ? `${FLOOR_PLS_LABEL} PLS guaranteed minimum, and that is just the floor. once it opens, the pool is 80% of every referred paint, so it only grows.`
            : `80% of referred-paint volume so far, on a ${FLOOR_PLS_LABEL} PLS minimum. it grows with every referred paint.`}
        </div>
        <div className="comp-status">
          {statusLabel}
          {status !== 'ended' && <span className="comp-countdown"> {countdown}</span>}
        </div>
        <div className="comp-payouts">
          {SPLIT.map((pct, i) => (
            <div key={i} className="comp-payout">
              <span className="comp-rank">#{i + 1}</span>
              <span className="comp-payout-amt">
                {fmtPls((pool * BigInt(pct)) / 100n)} PLS
              </span>
              <span className="comp-payout-pct">{pct}%</span>
            </div>
          ))}
        </div>
      </section>

      <section className="comp-board">
        <h2>top referrers {status === 'upcoming' ? '(opens 22 Jun)' : ''}</h2>
        {isLoading && <p className="comp-muted">loading on-chain standings…</p>}
        {!isLoading && board.length === 0 && (
          <p className="comp-muted">
            {status === 'upcoming'
              ? 'no entries yet. share your link to be first when it opens.'
              : 'no referred paints yet. grab your link and be first on the board.'}
          </p>
        )}
        {board.length > 0 && (
          <ol className="comp-list">
            {board.slice(0, 25).map((r, i) => (
              <li key={r.addr} className={`comp-row ${i < 3 ? 'comp-row-top' : ''}`}>
                <span className="comp-row-rank">#{i + 1}</span>
                <span className="comp-row-addr" title={r.addr}>
                  {shortAddr(r.addr)}
                </span>
                <span className="comp-row-vol">{fmtPls(r.volume)} PLS referred</span>
                <span className="comp-row-count">{r.count} paints</span>
                {i < 3 && (
                  <span className="comp-row-prize">
                    {fmtPls((pool * BigInt(SPLIT[i])) / 100n)} PLS
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="comp-rules">
        <h2>how to enter</h2>
        <ol>
          <li>connect your wallet on the wall and hit "share &amp; earn 5%" to get your referral link.</li>
          <li>share it. anyone who paints through your link earns you 5% instantly.</li>
          <li>every referred paint also climbs you up this board. top 3 at the deadline split the pool.</li>
        </ol>
        <p className="comp-fine">
          standings and pool are read live from on-chain Painted events (PulseChain). self-referral
          does not count. winners are the top 3 by referred paint volume at 29 Jun 00:00 UTC.
        </p>
        <p className="comp-cta">
          <Link to="/" className="comp-cta-link">
            go to the wall and grab your link →
          </Link>
        </p>
      </section>
    </div>
  )
}

/**
 * Nomination contest view: a reply-on-X contest (no on-chain pool/board).
 * The 10 most-nominated PulseChain projects get painted onto the wall for
 * free. Reuses the comp-* layout so it matches the referral page.
 */
function NominationContest() {
  const countdown = useCountdown(NOMINATION_END_MS)

  return (
    <div className="shell-measure comp-page">
      <header className="comp-header">
        <div className="comp-soon">live now · closes sunday night</div>
        <h1>nominate your favourite pulsechain project</h1>
        <p>
          reply to the pinned post on @tagwall_io with your favourite pulsechain project. the 10
          most-nominated get painted onto the wall permanently, on-chain, free. tag them so they
          know you repped them.
        </p>
        <p className="comp-window">closes sun 21 jun (night) · winners painted mon 22 jun</p>
      </header>

      <section className="comp-pool">
        <div className="comp-pool-label">the prize</div>
        <div className="comp-pool-value">
          10 <span className="comp-pool-unit">permanent tags</span>
        </div>
        <div className="comp-pool-sub">
          the 10 most-nominated projects get a permanent spot on the wall, painted free. no token,
          no entry fee, it stays on-chain until someone pays to overwrite it.
        </div>
        <div className="comp-status">
          closes in<span className="comp-countdown"> {countdown}</span>
        </div>
      </section>

      <section className="comp-rules">
        <h2>how to enter</h2>
        <ol>
          <li>find the pinned nomination post on @tagwall_io.</li>
          <li>reply with your favourite pulsechain project.</li>
          <li>tag the project so they know you nominated them.</li>
        </ol>
        <p className="comp-fine">
          the 10 most-nominated projects win. obvious spam, self-nominations, and brigading do not
          count. winners are painted free on monday 22 jun, then revealed one per day.
        </p>
        <p className="comp-cta">
          <a className="comp-cta-link" href={NOMINATION_TWEET_URL} target="_blank" rel="noreferrer">
            nominate on X →
          </a>
        </p>
        <p className="comp-muted">
          next up: the referral contest opens mon 22 jun, {FLOOR_PLS_LABEL} PLS minimum pool.
        </p>
      </section>
    </div>
  )
}
