/**
 * Solana program constants, mirrored from
 * solana/programs/tagwall/src/constants.rs. Keep in sync by hand; a
 * drift here produces wrong PDAs or rejected transactions, not silent
 * corruption (the program validates everything).
 */

// Program id + cluster config live in cluster.ts (per-cluster).
export { SOLANA_PROGRAM_ID } from './cluster'

export const SOLANA_TILE_SIZE = 20
export const SOLANA_CANVAS_WIDTH = 1250
export const SOLANA_CANVAS_HEIGHT = 800

/** Program-level per-paint pixel cap (sanity bound; mirrors EVM). */
export const SOLANA_MAX_PIXELS_PER_TX = 1500

/** Matches the EVM TRANSPARENT sentinel and constants.rs exactly. */
export const SOLANA_TRANSPARENT = 0xffff_ffff

/** paint_palette: index 255 = transparent, so max 255 palette entries. */
export const PALETTE_TRANSPARENT_INDEX = 255
export const PALETTE_MAX_COLORS = 255

/* ------------------- transaction budget model ----------------------
 *
 * Solana transactions are capped at 1,232 bytes. Devnet soak
 * (2026-06-10, solana/scripts/devnet-soak.ts) measured the real
 * capacities AFTER the heap-leak fix (the earlier "132 px ceiling"
 * was the eager-error allocation bug, not tx size):
 *
 *   - paint (u32) 196 px single-tile lands; 80 + 4*196 = 864 bytes of
 *     instruction data, implying ~368 bytes of envelope (signature,
 *     header, 8 account keys, blockhash, compute-budget ix).
 *   - palette 600 px @ 8 colors across 4 tiles lands (716 data bytes
 *     + 4-tile envelope ~467).
 *
 * The model: ENVELOPE_BASE covers a 1-tile transaction; each extra
 * tile account costs 33 bytes (32-byte key + 1 index byte). A safety
 * margin absorbs blockhash/ALT/wallet variance; raise it if a wallet
 * adds memo instructions or similar.
 */
export const SOLANA_MAX_TX_BYTES = 1232
export const SOLANA_TX_ENVELOPE_BASE = 380
export const SOLANA_TX_PER_EXTRA_TILE = 33
export const SOLANA_TX_SAFETY_MARGIN = 24

/**
 * Wire-budget profile: legacy vs v0-with-lookup-tables. With ALTs the
 * 6 fixed accounts and every tile PDA reference cost 1 byte instead of
 * 32, plus ~34 bytes per referenced table (address + index arrays).
 * The page selects the profile by whether the cluster's ALT set loaded;
 * the encoder chunks against the SAME profile the builder sends with,
 * so a fallback to legacy never produces oversized transactions.
 */
export interface WireProfile {
  envelopeBase: number
  perExtraTile: number
}
export const WIRE_LEGACY: WireProfile = {
  envelopeBase: SOLANA_TX_ENVELOPE_BASE,
  perExtraTile: SOLANA_TX_PER_EXTRA_TILE,
}
/** v0 + ALT profile, devnet-measured 2026-06-12
 *  (solana/scripts/soak-v0.ts): an 800 px palette paint across 4
 *  tiles landed at 1,205 bytes, envelope 297 = 291 base + 2/extra
 *  tile. The base includes TWO table references (fixed accounts live
 *  in table 0, tiles in their own table). envelopeBase carries +10 on
 *  the measurement so that, together with SOLANA_TX_SAFETY_MARGIN, a
 *  stamp whose tile span crosses a 256-slot table boundary (a third
 *  table reference, ~35 bytes) can never overflow. */
export const WIRE_V0_ALT: WireProfile = {
  envelopeBase: 301,
  perExtraTile: 2,
}

/** Borsh fixed bytes per format: discriminator (8) + rect (16) +
 *  link_id (4) + metadata_hash (32) + max_total_cost (8) +
 *  reserve_multiplier_bps (8), plus per-format extras. */
export const ARGS_FIXED_U32 = 8 + 16 + 4 + 32 + 8 + 8 + 4 // + colors vec len prefix
export const ARGS_FIXED_FILL = 8 + 16 + 4 + 4 + 32 + 8 + 8 // + color u32
export const ARGS_FIXED_PALETTE = 8 + 16 + 4 + 4 + 32 + 8 + 8 + 4 + 4 // + both vec len prefixes

/** Compute budget: measured ~535 CU/px amortized + entry overhead;
 *  the full 1,500 px fill used 803k of the 1.4M cap. Clients request
 *  this limit for any multi-hundred-pixel stamp. */
export const SOLANA_COMPUTE_UNIT_LIMIT = 1_400_000
