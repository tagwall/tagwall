import { http, createConfig } from 'wagmi'
import {
  mainnet as mainnetDefault,
  base as baseDefault,
  bsc as bscDefault,
  pulsechain as pulsechainDefault,
  pulsechainV4 as pulsechainV4Default,
} from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { defineChain } from 'viem'

import { directRpcs, rotatingTransport } from './lib/rpcPool'

// Per-chain RPC pools live in lib/rpcPool.ts, which also owns the rotating
// transport that spreads reads across them. The lists there are the ones
// MetaMask sees via `wallet_addEthereumChain` (the Worker proxy is
// same-origin and therefore useless to a wallet, so `directRpcs` excludes
// it) as well as the ones the app itself dials.
const PULSECHAIN_RPC_URLS = directRpcs(369)
const PULSECHAIN_V4_RPC_URLS = directRpcs(943)
const ETHEREUM_RPC_URLS = directRpcs(1)
const BASE_RPC_URLS = directRpcs(8453)
const BSC_RPC_URLS = directRpcs(56)
const HYPEREVM_RPC_URLS = directRpcs(999)
const ROBINHOOD_RPC_URLS = directRpcs(4663)

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
    [pulsechain.id]: rotatingTransport(pulsechain.id),
    [mainnet.id]: rotatingTransport(mainnet.id),
    [base.id]: rotatingTransport(base.id),
    [bsc.id]: rotatingTransport(bsc.id),
    [hyperevm.id]: rotatingTransport(hyperevm.id),
    [robinhood.id]: rotatingTransport(robinhood.id),
    [pulsechainV4.id]: rotatingTransport(pulsechainV4.id),
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
