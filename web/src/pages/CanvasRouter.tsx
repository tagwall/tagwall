import { useIsSolanaActive } from '../lib/activeChain'
import HomePage from './HomePage'
import SolanaPage from './SolanaPage'

/**
 * The single canvas route. Dispatches by chain FAMILY: the EVM canvas
 * (HomePage, live on 5 mainnets, untouched) or the Solana canvas
 * (SolanaPage, devnet), both under the shared AppLayout chrome and the
 * one chain picker in the top bar. Only one mounts at a time, so the
 * EVM wagmi hooks never run while Solana is active and vice versa.
 */
export default function CanvasRouter() {
  return useIsSolanaActive() ? <SolanaPage /> : <HomePage />
}
