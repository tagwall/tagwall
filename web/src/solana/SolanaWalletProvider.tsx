import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getWallets } from '@wallet-standard/app'
import { SOLANA_WALLET_CHAIN as SOLANA_CHAIN } from './cluster'
import type { Wallet, WalletAccount } from '@wallet-standard/base'

/**
 * Solana wallet state via WALLET STANDARD discovery: every wallet with
 * Solana support (Phantom, Solflare, Backpack, MetaMask's Solana
 * accounts, ...) registers itself with the page and shows up in
 * `wallets` automatically. No brand is hardcoded anywhere; the
 * ConnectBar renders whatever was discovered.
 *
 * Lifted to context so the top-bar chrome and the canvas body observe
 * ONE connection. The official @solana/wallet-adapter stack remains an
 * option for mainnet, but wallet-standard is the layer it's built on,
 * so this covers the same wallets with a fraction of the surface.
 */

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>
}
interface DisconnectFeature {
  disconnect(): Promise<void>
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: { transaction: Uint8Array; account: WalletAccount; chain: string }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>
}


function solanaWalletsOf(all: readonly Wallet[]): Wallet[] {
  return all.filter(
    (w) =>
      'standard:connect' in w.features &&
      'solana:signTransaction' in w.features &&
      w.chains.some((c) => c.startsWith('solana:')),
  )
}

export interface DiscoveredWallet {
  name: string
  /** Data-URI icon straight from the wallet's registration. */
  icon: string
}

export interface SolanaWallet {
  /** Wallets discovered via wallet-standard, in registration order. */
  wallets: DiscoveredWallet[]
  /** Convenience: at least one Solana-capable wallet exists. */
  available: boolean
  /** Name of the connected wallet, when connected. */
  walletName: string | null
  publicKey: PublicKey | null
  connecting: boolean
  /** Connect a specific wallet by name (from `wallets`). */
  connect: (name: string) => Promise<void>
  disconnect: () => Promise<void>
  signAllTransactions: <T extends Transaction | VersionedTransaction>(
    txs: T[],
  ) => Promise<T[]>
  error: string | null
}

const SolanaWalletContext = createContext<SolanaWallet | null>(null)

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => getWallets())
  const [discovered, setDiscovered] = useState<Wallet[]>(() =>
    solanaWalletsOf(registry.get()),
  )
  const [connected, setConnected] = useState<{
    wallet: Wallet
    account: WalletAccount
  } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Wallets can register after page load (extensions inject async).
  useEffect(() => {
    const offRegister = registry.on('register', () =>
      setDiscovered(solanaWalletsOf(registry.get())),
    )
    const offUnregister = registry.on('unregister', () =>
      setDiscovered(solanaWalletsOf(registry.get())),
    )
    return () => {
      offRegister()
      offUnregister()
    }
  }, [registry])

  const connect = useCallback(
    async (name: string) => {
      const wallet = discovered.find((w) => w.name === name)
      if (!wallet) {
        setError(`wallet "${name}" not found`)
        return
      }
      setConnecting(true)
      setError(null)
      try {
        const { accounts } = await (
          wallet.features['standard:connect'] as ConnectFeature
        ).connect()
        // Prefer an account scoped to our cluster; fall back to the
        // first Solana account (wallets vary in chain tagging).
        const account =
          accounts.find((a) => a.chains.includes(SOLANA_CHAIN)) ??
          accounts.find((a) => a.chains.some((c) => c.startsWith('solana:')))
        if (!account) throw new Error('wallet returned no Solana account')
        setConnected({ wallet, account })
      } catch (e) {
        setError((e as Error).message ?? 'connect rejected')
      } finally {
        setConnecting(false)
      }
    },
    [discovered],
  )

  const disconnect = useCallback(async () => {
    if (connected && 'standard:disconnect' in connected.wallet.features) {
      await (
        connected.wallet.features['standard:disconnect'] as DisconnectFeature
      )
        .disconnect()
        .catch(() => undefined)
    }
    setConnected(null)
  }, [connected])

  const signAllTransactions = useCallback(
    async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      if (!connected) throw new Error('wallet not connected')
      const feature = connected.wallet.features[
        'solana:signTransaction'
      ] as SignTransactionFeature
      const outputs = await feature.signTransaction(
        ...txs.map((t) => ({
          transaction:
            t instanceof VersionedTransaction
              ? t.serialize()
              : new Uint8Array(
                  t.serialize({ requireAllSignatures: false, verifySignatures: false }),
                ),
          account: connected.account,
          chain: SOLANA_CHAIN,
        })),
      )
      return outputs.map((o, i) =>
        txs[i] instanceof VersionedTransaction
          ? (VersionedTransaction.deserialize(o.signedTransaction) as T)
          : (Transaction.from(o.signedTransaction) as T),
      )
    },
    [connected],
  )

  const value = useMemo<SolanaWallet>(
    () => ({
      wallets: discovered.map((w) => ({ name: w.name, icon: w.icon })),
      available: discovered.length > 0,
      walletName: connected?.wallet.name ?? null,
      publicKey: connected ? new PublicKey(connected.account.publicKey) : null,
      connecting,
      connect,
      disconnect,
      signAllTransactions,
      error,
    }),
    [discovered, connected, connecting, connect, disconnect, signAllTransactions, error],
  )

  return (
    <SolanaWalletContext.Provider value={value}>{children}</SolanaWalletContext.Provider>
  )
}

export function useSolanaWallet(): SolanaWallet {
  const ctx = useContext(SolanaWalletContext)
  if (!ctx) throw new Error('useSolanaWallet must be used within SolanaWalletProvider')
  return ctx
}
