// Re-export so existing imports keep resolving. The wallet state now
// lives in a context provider (one connection shared by the top-bar
// chrome and the canvas body); see src/solana/SolanaWalletProvider.tsx.
export { useSolanaWallet, type SolanaWallet } from '../solana/SolanaWalletProvider'
