import { http, createConfig } from 'wagmi'
import {
  mainnet as mainnetDefault,
  base as baseDefault,
  bsc as bscDefault,
  pulsechain as pulsechainDefault,
  pulsechainV4 as pulsechainV4Default,
} from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { defineChain, fallback } from 'viem'

// Two-deep RPC stack per chain. Public RPCs flap; a single-URL config
// turns any operator outage into a frontend outage. Each pair is two
// independent operators so a single-vendor problem doesn't down both.
//
// Both URLs are listed on the chain's `rpcUrls.default.http` so MetaMask
// gets a working URL when adding the network via `wallet_addEthereumChain`,
// and stacked in a viem `fallback` transport so a mid-session flap on
// the primary falls through to the secondary transparently.
//
// Latencies measured 2026-05-04; reorder in this list if one operator
// becomes consistently faster or more reliable.
const PULSECHAIN_RPC_URLS = [
  'https://rpc-pulsechain.g4mm4.io',
  'https://pulsechain-rpc.publicnode.com',
] as const
const PULSECHAIN_V4_RPC_URLS = [
  'https://rpc-testnet-pulsechain.g4mm4.io',
  'https://pulsechain-testnet-rpc.publicnode.com',
] as const
// Ethereum primary swapped 2026-05-24 (Day-0): cloudflare-eth.com was
// rate-limiting (429) with no CORS headers, blocking browser access
// entirely. eth.merkle.io (Flashbots-operated) returns CORS=* and has
// solid uptime per public dashboards.
const ETHEREUM_RPC_URLS = [
  'https://eth.merkle.io',
  'https://ethereum-rpc.publicnode.com',
] as const
// Base secondary swapped 2026-05-24 (Day-0): base.llamarpc.com was
// returning HTTP 526 (Cloudflare bad-origin) with no CORS. base.drpc.org
// mirrors the BSC primary pattern (bsc.drpc.org) for consistency.
const BASE_RPC_URLS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
] as const
const BSC_RPC_URLS = [
  'https://bsc.drpc.org',
  'https://bsc-rpc.publicnode.com',
] as const

// Per-chain RPC overrides. wagmi/chains ships single-URL defaults for
// each chain that all suffer the same single-vendor-flap fragility; we
// replace `rpcUrls.default.http` with the multi-operator stacks above
// so `wallet_addEthereumChain` lands a working URL even when one
// vendor is down.
const pulsechain = {
  ...pulsechainDefault,
  rpcUrls: { default: { http: PULSECHAIN_RPC_URLS } },
} as const

// wagmi/chains ships PulseChain v4 with `nativeCurrency.symbol = 'v4PLS'`,
// but the testnet's actual token ticker (per faucet, explorer, and bridge
// UIs) is `tPLS`. Override locally so the chain switcher and balance
// displays match what users see everywhere else.
const pulsechainV4 = {
  ...pulsechainV4Default,
  nativeCurrency: { ...pulsechainV4Default.nativeCurrency, symbol: 'tPLS' },
  rpcUrls: { default: { http: PULSECHAIN_V4_RPC_URLS } },
} as const

const mainnet = {
  ...mainnetDefault,
  rpcUrls: { default: { http: ETHEREUM_RPC_URLS } },
} as const

const base = {
  ...baseDefault,
  rpcUrls: { default: { http: BASE_RPC_URLS } },
} as const

const bsc = {
  ...bscDefault,
  rpcUrls: { default: { http: BSC_RPC_URLS } },
} as const

// Local Anvil for dev-only end-to-end testing against a simulated EVM.
// Same chainid and pre-loaded deterministic deployer as the Deploy.s.sol
// anvil run (contracts/script/README.md). Enabled only on dev builds so
// production users don't see "Anvil" in the chain switcher.
//
// `contracts.multicall3` declares the address of Multicall3 so viem's
// `publicClient.multicall` batches pixel reads into a single RPC instead
// of falling back to per-call eth_calls (which turned heavy-canvas
// refresh into a 2+ minute wait). scripts/seed-local.sh installs
// Multicall3 at this canonical address via `anvil_setCode`; production
// chains already have it there.
const anvilLocal = defineChain({
  id: 31337,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
})

const isDev = import.meta.env.DEV

// Chain order controls the default network shown to new users. PulseChain
// mainnet is the marketing-primary target for Day 0 (per PRD §10), even
// though deploys land on all three mainnets the same day. Anvil prepends
// in dev only, so `preview_start web` + `scripts/seed-local.sh` gives a
// fully-working UI without touching any public chain.
const chains = isDev
  ? ([anvilLocal, pulsechain, mainnet, base, bsc, pulsechainV4] as const)
  : ([pulsechain, mainnet, base, bsc, pulsechainV4] as const)

export const config = createConfig({
  chains,
  transports: {
    [anvilLocal.id]: http('http://127.0.0.1:8545'),
    [pulsechain.id]: fallback(PULSECHAIN_RPC_URLS.map((u) => http(u))),
    [mainnet.id]: fallback(ETHEREUM_RPC_URLS.map((u) => http(u))),
    [base.id]: fallback(BASE_RPC_URLS.map((u) => http(u))),
    [bsc.id]: fallback(BSC_RPC_URLS.map((u) => http(u))),
    [pulsechainV4.id]: fallback(PULSECHAIN_V4_RPC_URLS.map((u) => http(u))),
  },
  connectors: [
    // `injected` picks up MetaMask and other EIP-6963-compatible wallets.
    // WalletConnect is a v1.1 item (PRD §6); MetaMask-only for v1.
    injected({ shimDisconnect: true }),
  ],
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
