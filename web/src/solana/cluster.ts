/**
 * THE cluster switch. Everything cluster-dependent (wallet chain tag,
 * default RPC, explorer links, UI label, program id) derives from
 * VITE_SOLANA_CLUSTER so flipping one Cloudflare dashboard var (plus
 * filling the mainnet program id on deploy day) moves the whole
 * frontend. Defaults to devnet: a missing var can never point dev
 * builds at mainnet.
 */

export type SolanaCluster = 'devnet' | 'mainnet-beta'

export const SOLANA_CLUSTER: SolanaCluster =
  import.meta.env.VITE_SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet'

const IS_MAINNET = SOLANA_CLUSTER === 'mainnet-beta'

/** Wallet-standard chain identifier (mainnet's id is 'solana:mainnet',
 *  without the '-beta'). */
export const SOLANA_WALLET_CHAIN = IS_MAINNET ? 'solana:mainnet' : 'solana:devnet'

/**
 * Default read/write RPC when VITE_SOLANA_RPC_URL is unset. Mainnet
 * default is PublicNode: probed 2026-06-12 from a tagwall.io origin
 * for CORS preflight, getProgramAccounts, getSignaturesForAddress and
 * sendTransaction, all open without a key. The official
 * api.mainnet-beta.solana.com endpoint passed the same probes and is
 * the documented fallback (swap via the env var, no code change).
 */
export const SOLANA_DEFAULT_RPC_URL = IS_MAINNET
  ? 'https://solana-rpc.publicnode.com'
  : 'https://api.devnet.solana.com'

/** Query-string suffix for explorer.solana.com links ('' on mainnet). */
export const SOLANA_EXPLORER_SUFFIX = IS_MAINNET ? '' : '?cluster=devnet'

/** Chain-selector label; the cluster qualifier only appears off-mainnet. */
export const SOLANA_CHAIN_LABEL = IS_MAINNET ? 'Solana' : 'Solana · devnet'

const PROGRAM_IDS: Record<SolanaCluster, string> = {
  devnet: 'CYwhGVP23rvMtBKdBcjmcmWh1SiWteM944Vt7EeCR64u',
  // Filled on deploy day (launch runbook Phase B) from the fresh
  // mainnet program keypair. The empty string crashes loudly at
  // import if the cluster is flipped before the id exists, which is
  // the correct failure mode.
  'mainnet-beta': '',
}

export const SOLANA_PROGRAM_ID = PROGRAM_IDS[SOLANA_CLUSTER]
