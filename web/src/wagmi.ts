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
// BSC stack rebuilt 2026-05-25 after the canvas hit "history has been
// pruned" errors from publicnode and 400/408s from drpc.org. BSC's free
// public RPCs are unusable for `eth_getLogs` across most of the public
// landscape: publicnode + dataseeds prune logs after ~24h, dataseed1-4
// rate-limit, blast caps at 10 blocks, drpc.org caps at 10k blocks (but
// also flaps with 400s under load), nodies.app caps at 500 blocks. The
// only public BSC endpoint that actually returns canvas-deploy-block
// logs without arbitrary range caps or pruning is Bloxroute's
// bsc.rpc.blxrbdn.com (also CORS-clean and fast: 35-120ms).
//
// Secondary is drpc.org despite the flake risk — its 10k-block range
// limit is above our 9.5k paginated chunk, and it's at least functional
// for write-side RPC calls (eth_sendRawTransaction, eth_call). When
// Bloxroute is up (the common case), drpc never gets hit.
const BSC_RPC_URLS = [
  'https://bsc.rpc.blxrbdn.com',
  'https://bsc.drpc.org',
] as const
// HyperEVM (chain 999) RPCs, both free/public (no paid service). Primary is
// Bloxroute, the same operator we use for BSC: CORS-clean, fast, and
// critically returns canvas-deploy-block eth_getLogs without the arbitrary
// range caps or log pruning that hobble most free endpoints. drpc is the
// secondary — its ~10k-block range cap sits above our 9.5k paginated chunk,
// so it's a functional fallback for reads + write-side RPC. We deliberately
// avoid rpc.hyperliquid.xyz/evm as a primary: the official endpoint is
// rate-limited to 100 req/min/IP (since 2026-08), which the read-heavy canvas
// refresh would exhaust.
const HYPEREVM_RPC_URLS = [
  'https://hyperliquid.rpc.blxrbdn.com',
  'https://hyperliquid.drpc.org',
] as const
// Robinhood Chain (4663) is young enough that the official RPC is the only
// public endpoint we've verified (CORS-clean, no observed eth_getLogs range
// cap even at 6M blocks, probed 2026-07-12). Single-operator fragility is a
// known gap; add a second independent operator here as soon as one exists.
const ROBINHOOD_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
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
  // viem's bscDefault.name is "BNB Smart Chain", which most users don't
  // recognise on sight. Override to "BSC" (the operator's preferred
  // short form, also used as the chain key in chainColor and in the
  // tweets bot config). Native token symbol stays "BNB" since the
  // chain still pays in BNB.
  name: 'BSC',
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

// HyperEVM (Hyperliquid L1), chain 999. Native token HYPE. Multicall3 is
// present at the canonical address (verified on-chain 2026-05-30), so
// publicClient.multicall batches reads here like the other chains. The
// Canvas deployed here is the v1.1 build at a DIFFERENT CREATE2 address
// than the four live mainnets (the constructor gained a 999 branch, which
// shifts the init-code hash); canvas.ts resolves the right address per chain.
const hyperevm = defineChain({
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { name: 'Hyperliquid', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: HYPEREVM_RPC_URLS } },
  blockExplorers: {
    default: { name: 'HyperScan', url: 'https://www.hyperscan.com' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})

// Robinhood Chain (Arbitrum Orbit L2), chain 4663. Native token ETH.
// Multicall3 is present at the canonical address (verified on-chain
// 2026-07-11). Runs the v1.2 Canvas build at its own CREATE2 address
// (the chain-4663 constructor branch shifts the init-code hash);
// canvas.ts resolves the right address per chain. ~0.1s blocks.
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ROBINHOOD_RPC_URLS } },
  blockExplorers: {
    default: {
      name: 'Robinhood Chain Explorer',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})

const isDev = import.meta.env.DEV

// Chain order controls the default network shown to new users. PulseChain
// mainnet is the marketing-primary target for Day 0 (per PRD §10), even
// though deploys land on all three mainnets the same day. Anvil prepends
// in dev only, so `preview_start web` + `scripts/seed-local.sh` gives a
// fully-working UI without touching any public chain.
const chains = isDev
  ? ([anvilLocal, pulsechain, mainnet, base, bsc, hyperevm, robinhood, pulsechainV4] as const)
  : ([pulsechain, mainnet, base, bsc, hyperevm, robinhood, pulsechainV4] as const)

export const config = createConfig({
  chains,
  transports: {
    [anvilLocal.id]: http('http://127.0.0.1:8545'),
    [pulsechain.id]: fallback(PULSECHAIN_RPC_URLS.map((u) => http(u))),
    [mainnet.id]: fallback(ETHEREUM_RPC_URLS.map((u) => http(u))),
    [base.id]: fallback(BASE_RPC_URLS.map((u) => http(u))),
    [bsc.id]: fallback(BSC_RPC_URLS.map((u) => http(u))),
    [hyperevm.id]: fallback(HYPEREVM_RPC_URLS.map((u) => http(u))),
    [robinhood.id]: fallback(ROBINHOOD_RPC_URLS.map((u) => http(u))),
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
