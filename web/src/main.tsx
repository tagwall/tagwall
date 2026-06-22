import { Buffer } from 'buffer'

// @solana/web3.js feature-detects globalThis.Buffer at runtime; without
// this shim it can fall back to broken paths in the browser. Must run
// before any Solana module loads (import order puts it first here).
const g = globalThis as { Buffer?: typeof Buffer }
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'

import App from './App.tsx'
import { config } from './wagmi.ts'
import { SolanaWalletProvider } from './solana/SolanaWalletProvider'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <SolanaWalletProvider>
          <App />
        </SolanaWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
