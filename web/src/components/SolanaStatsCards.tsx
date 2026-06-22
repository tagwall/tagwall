import { formatEther } from 'viem'

import {
  SOLANA_CANVAS_HEIGHT,
  SOLANA_CANVAS_WIDTH,
  SOLANA_MAX_PIXELS_PER_TX,
} from '../solana/constants'
import type { SolanaCanvasConfig } from '../solana/client'

/** lamports (9 dec) -> the 18-dec scale formatEther expects. Exact
 *  integer multiply, display-only; mirrors solana/history.ts. */
const LAMPORTS_TO_DISPLAY = 1_000_000_000n

interface Props {
  /** From useSolanaCanvas, passed in so the page's existing query is
   *  reused instead of refetching. null while the config loads. */
  config: SolanaCanvasConfig | null
  /** Pixels with lastPrice > 0 across all tiles (useSolanaCanvas). */
  paintedPixels: number
  /** Rent-vault balance in lamports (useSolanaCanvas). */
  vaultLamports: bigint
}

/**
 * Solana twin of StatsCards: aggregate canvas stats rendered with the
 * same stat-card chrome. Purely presentational; all data arrives as
 * props from useSolanaCanvas, so mounting this adds no RPC traffic.
 */
export function SolanaStatsCards({ config, paintedPixels, vaultLamports }: Props) {
  if (!config) return null

  const totalPixels = SOLANA_CANVAS_WIDTH * SOLANA_CANVAS_HEIGHT
  const coverage = (paintedPixels / totalPixels) * 100

  return (
    <div className="stats-grid">
      <StatCard
        label="Starting price"
        value={`${formatEther(config.startingPrice * LAMPORTS_TO_DISPLAY)} SOL`}
      />
      <StatCard
        label="Per-tx pixel cap"
        value={SOLANA_MAX_PIXELS_PER_TX.toLocaleString()}
        hint="Program-level cap. A single transaction's 1,232-byte wire limit caps full-color stamps at 196 px; fills and palette stamps go far higher."
      />
      <StatCard label="Total stamps" value={config.stampCount.toString()} emphasis />
      <StatCard
        label="Painted pixels"
        value={`${paintedPixels.toLocaleString()} (${coverage.toFixed(2)}%)`}
        hint="Pixels painted at least once, read from live tile state. Each pixel counts once even if repainted."
        emphasis
      />
      <StatCard
        label="Canvas dimensions"
        value={`${SOLANA_CANVAS_WIDTH.toLocaleString()} × ${SOLANA_CANVAS_HEIGHT.toLocaleString()}`}
      />
      <StatCard
        label="Vault balance"
        value={`${formatEther(vaultLamports * LAMPORTS_TO_DISPLAY)} SOL`}
        hint="Rent vault that reimburses tile-account rent for painters on lazily created tiles."
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: string
  hint?: string
  emphasis?: boolean
}) {
  return (
    <div className={emphasis ? 'stat-card stat-card-emphasis' : 'stat-card'}>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {hint && <div className="stat-card-hint">{hint}</div>}
    </div>
  )
}
