import { useCallback, useEffect, useRef, useState } from 'react'
import { SOLANA_CHAIN_LABEL } from '../solana/cluster'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import {
  useAccount,
  useBalance,
  useChainId,
  useChains,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from 'wagmi'
import { Link, NavLink, useSearchParams } from 'react-router-dom'

import { useCanvasDeployed } from '../hooks/useCanvasDeployed'
import { competitionFeatured } from '../lib/contest'
import { shortenAddress } from '../lib/format'
import { useViewerChainId, useSetViewerChain } from '../lib/viewerChain'
import { useActiveChain, useSelectSolana } from '../lib/activeChain'
import { useSolanaWallet } from '../solana/SolanaWalletProvider'
import { solanaConnection } from '../hooks/useSolanaCanvas'
import { NavMetrics } from './NavMetrics'
import { ShareReferralButton } from './ShareReferralButton'

// Recovery target for the "not yet deployed on this chain" banner.
// PulseChain v4 testnet is the only chain with the canvas live as of
// 2026-05-04. Update or remove the banner once mainnets ship.
const FALLBACK_DEPLOYED_CHAIN_ID = 943
const FALLBACK_DEPLOYED_CHAIN_NAME = 'PulseChain v4 testnet'

/**
 * Native-token balance for the wallet's current chain. Right-sized for
 * a toolbar chip — values >= 1000 round to the nearest whole, between
 * 1-1000 show 2 decimals, sub-1 shows 4 decimals so a freshly-faucet
 * tester at 0.0123 PLS still sees a real number rather than "0".
 */
function formatNativeBalance(value: bigint, decimals: number): string {
  const num = Number(formatUnits(value, decimals))
  if (num === 0) return '0'
  if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (num >= 1) return num.toFixed(2)
  if (num >= 0.001) return num.toFixed(4)
  return num.toExponential(2)
}

/**
 * Global chrome: brand, main nav menu, chain picker dropdown, wallet connect.
 * Mounted by the layout shell so every route gets consistent navigation +
 * chain state.
 */
export function ConnectBar() {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const { connectAsync, connectors, error, isPending } = useConnect()
  // Suppress noisy non-fatal connect errors that confuse users:
  //   - "already pending"   → wallet_requestPermissions race when the
  //                            user double-clicks Connect before
  //                            MetaMask's popup mounts. Original request
  //                            still resolves.
  //   - "already connected" → wagmi v3 connector-state quirk after
  //                            disconnect+reconnect. handleConnect()
  //                            below catches and force-resets, so by
  //                            the time it would surface here it's
  //                            already been handled (or the user is
  //                            mid-flow on the retry).
  const visibleError =
    error && !/already pending|already connected/i.test(error.message)
      ? error
      : null
  const { disconnect, disconnectAsync } = useDisconnect()

  // Wagmi v3.x has a known race: after `disconnect()` the connector's
  // internal state can stay "connected" even though the React state
  // says disconnected. The next `connect()` then throws "Connector
  // already connected" and the Connect button looks frozen. Detect
  // that error, force the connector to reset via `disconnectAsync`,
  // then retry the connect once. Real errors (UserRejected, no
  // provider, chain mismatch) still bubble normally.
  const handleConnect = async () => {
    const c = connectors[0]
    if (!c) return
    try {
      await connectAsync({ connector: c })
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? ''
      if (/already connected/i.test(msg)) {
        try {
          await disconnectAsync()
        } catch {
          /* swallow — best-effort reset */
        }
        // Tiny gate so the connector's onDisconnect listener fires
        // before we re-request. 50ms is empirical; longer made the
        // UI feel laggy, shorter raced the same error again.
        await new Promise((r) => setTimeout(r, 50))
        try {
          await connectAsync({ connector: c })
        } catch {
          /* second failure: let wagmi's error state handle it */
        }
      }
    }
  }
  const chainId = useChainId()
  const chains = useChains()
  const { switchChain } = useSwitchChain()
  const currentChain = chains.find((c) => c.id === chainId)
  // Viewer chain: what the user is currently looking at. Equals
  // `chainId` (wallet's chain) when connected; falls back to a URL
  // `?chain=` param when disconnected so a no-wallet visitor can still
  // browse any chain's canvas. The dropdown's label + active row read
  // from this so disconnected switches show up immediately.
  const viewerChainId = useViewerChainId()
  const viewerChain = chains.find((c) => c.id === viewerChainId)
  const setViewerChain = useSetViewerChain()

  // Chain-family state: Solana is a first-class entry in the same
  // picker. `solanaActive` swaps the picker label + the wallet control
  // to the Solana family. Picking an EVM chain clears the ?chain=solana
  // param so the dispatch flips back.
  const active = useActiveChain()
  const solanaActive = active.family === 'solana'
  const selectSolana = useSelectSolana()
  const solWallet = useSolanaWallet()
  const [solWalletMenuOpen, setSolWalletMenuOpen] = useState(false)
  // SOL balance chip, mirroring the EVM useBalance chip. lamports are
  // 9-decimal, so the shared formatter is reused with decimals = 9.
  const solBalance = useQuery({
    queryKey: ['solana-balance', solWallet.publicKey?.toBase58() ?? null],
    enabled: solanaActive && !!solWallet.publicKey,
    refetchInterval: 30_000,
    queryFn: async () =>
      BigInt(await solanaConnection().getBalance(solWallet.publicKey!)),
  })
  const [, setSearchParams] = useSearchParams()
  const clearSolanaParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        if (prev.get('chain')?.toLowerCase() === 'solana') prev.delete('chain')
        return prev
      },
      { replace: false },
    )
  }, [setSearchParams])

  // Global "refresh canvas data" button (operator preference 2026-05-25:
  // there's a refresh on the minimap overlay too, but a second one in
  // the global chrome makes it discoverable without finding the
  // minimap first). Invalidates the same react-query keys HomePage's
  // own refresh handler does — react-query dedupes the refetches.
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['painted-regions'] }),
        queryClient.invalidateQueries({ queryKey: ['tile-pixels'] }),
        queryClient.invalidateQueries({ queryKey: ['leaderboard-pixels'] }),
      ])
    } finally {
      setTimeout(() => setRefreshing(false), 250)
    }
  }, [queryClient, refreshing])

  // Native-token balance on the connected chain. Auto-disabled when no
  // address. Refetches on chain switch automatically because wagmi keys
  // the query on chainId.
  const { data: balance } = useBalance({
    address,
    query: { enabled: !!address },
  })

  // Wrong-chain detection. Canvas is the same CREATE2 address on every
  // supported chain (PulseChain, Ethereum, Base, plus testnets), so users
  // can paint on whichever chain their wallet is on; what we DON'T support
  // is a chain we never deployed to (e.g. wallet on Polygon). Detection
  // must use the wallet's REAL chain from useAccount(): wagmi's
  // useChainId() clamps to configured chains, so the old `!currentChain`
  // check could never fire and paints could target a codeless address.
  const onUnsupportedChain =
    isConnected && !chains.some((c) => c.id === walletChainId)
  const recoveryChain = chains[0]

  // Not-deployed-on-this-chain detection. Distinct from wrong-chain: the
  // chain IS in our supported list, but the canvas hasn't been deployed
  // there yet (mainnet deploys gated on the treasury key ceremony, see
  // contracts/script/README.md). Calling paint() against an address with
  // no code is a value transfer, so funds would be lost permanently;
  // banner blocks the user before they reach for the paint button.
  const deployedStatus = useCanvasDeployed()
  const showNotDeployedBanner =
    !solanaActive &&
    !!currentChain &&
    deployedStatus === 'not-deployed' &&
    chainId !== FALLBACK_DEPLOYED_CHAIN_ID
  const fallbackInList = chains.find((c) => c.id === FALLBACK_DEPLOYED_CHAIN_ID)

  // Chain dropdown: click-to-toggle, click-outside-to-close.
  const [chainMenuOpen, setChainMenuOpen] = useState(false)
  const chainBtnRef = useRef<HTMLButtonElement>(null)
  const chainMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!chainMenuOpen) return
    function onDocDown(e: MouseEvent) {
      const target = e.target as Node
      if (chainBtnRef.current?.contains(target)) return
      if (chainMenuRef.current?.contains(target)) return
      setChainMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [chainMenuOpen])

  return (
    <header className="connect-bar">
      {!solanaActive && onUnsupportedChain && recoveryChain && (
        <div className="wrong-chain-banner" role="status">
          <span>
            Your wallet is on chain {walletChainId ?? 'unknown'}, which Tagwall does not deploy to.
            Switch to {recoveryChain.name} to paint.
          </span>
          <button
            type="button"
            className="wallet-btn"
            onClick={() => switchChain({ chainId: recoveryChain.id })}
          >
            Switch to {recoveryChain.name}
          </button>
        </div>
      )}
      {showNotDeployedBanner && (
        <div className="wrong-chain-banner" role="status">
          <span>
            Tagwall is not yet deployed on {currentChain?.name ?? `chain ${chainId}`}.
            Switch to {FALLBACK_DEPLOYED_CHAIN_NAME} to paint.
          </span>
          {fallbackInList && isConnected && (
            <button
              type="button"
              className="wallet-btn"
              onClick={() => switchChain({ chainId: FALLBACK_DEPLOYED_CHAIN_ID })}
            >
              Switch to {FALLBACK_DEPLOYED_CHAIN_NAME}
            </button>
          )}
        </div>
      )}
      <Link to="/" className="brand" aria-label="tagwall.io home">
        <span className="brand-mark" aria-hidden /> tagwall.io
      </Link>

      {/* Share CTA sits right of the brand. Visible always: when
          connected it opens a pre-filled-tweet popover; when not, it
          links to /share where users paste an address manually. */}
      <ShareReferralButton address={address} />

      {/* Founders link: the per-chain "be early, provably" surface. Kept
          in the primary nav (not the footer) because the scarcity counter
          there is a core acquisition hook, not a secondary page. NavLink
          so the current page gets the `.active` highlight. */}
      <NavLink to="/founders" className="nav-link">
        Founders
      </NavLink>

      {/* Competition link: only while a contest is featured (nomination live,
          or referral upcoming/live). Auto-drops once both are over, the same
          date-driven check the home banner uses; /competition stays reachable
          for final standings. */}
      {competitionFeatured() && (
        <NavLink to="/competition" className="nav-link">
          Competition
        </NavLink>
      )}

      <div className="connect-bar-right">
        {/* Canvas metrics live in the nav bar (left of chain) so the
            canvas itself can claim the vertical space the old metric
            strip ate. EVM-only: they read wagmi contract state, and the
            Solana page surfaces its own floor/stamps/painted in-header. */}
        <NavMetrics />
        <button
          type="button"
          className={`global-refresh-btn${refreshing ? ' is-spinning' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh canvas data from the chain"
          aria-label="Refresh canvas"
        >
          ↻
        </button>
        <div className="chain-dropdown">
          <button
            ref={chainBtnRef}
            type="button"
            className="chain-dropdown-trigger"
            onClick={() => setChainMenuOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={chainMenuOpen}
            title={isConnected ? 'Switch chain' : 'Browse a chain (no wallet needed)'}
          >
            <span className="chain-dropdown-label">
              {solanaActive ? SOLANA_CHAIN_LABEL : (viewerChain?.name ?? `Chain ${viewerChainId}`)}
            </span>
            <span className="chain-dropdown-caret" aria-hidden>▾</span>
          </button>
          {chainMenuOpen && (
            <div ref={chainMenuRef} className="chain-dropdown-menu" role="listbox">
              {chains.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={!solanaActive && c.id === viewerChainId}
                  className={`chain-dropdown-item ${!solanaActive && c.id === viewerChainId ? 'chain-dropdown-item-active' : ''}`}
                  onClick={() => {
                    // Leaving Solana? Drop the ?chain=solana param so the
                    // canvas dispatch flips back to EVM. Then connected
                    // wallet: prompt the wallet so paint UX stays aligned
                    // with what gets signed; disconnected: write the URL
                    // ?chain= param so the canvas reads switch without a
                    // wallet at all.
                    if (solanaActive) clearSolanaParam()
                    if (isConnected) switchChain({ chainId: c.id })
                    else setViewerChain(c.id)
                    setChainMenuOpen(false)
                  }}
                  title={isConnected ? `Switch wallet to ${c.name}` : `View the ${c.name} canvas`}
                >
                  <span>{c.name}</span>
                  <span className="chain-dropdown-item-sub">{c.nativeCurrency.symbol}</span>
                </button>
              ))}
              {/* Solana: a different chain family, but the same picker.
                  Selecting it writes ?chain=solana; CanvasRouter swaps
                  to the Solana canvas + the Solana wallet control. */}
              <button
                type="button"
                role="option"
                aria-selected={solanaActive}
                className={`chain-dropdown-item ${solanaActive ? 'chain-dropdown-item-active' : ''}`}
                onClick={() => {
                  selectSolana()
                  setChainMenuOpen(false)
                }}
                title="View the Solana canvas"
              >
                <span>{SOLANA_CHAIN_LABEL}</span>
                <span className="chain-dropdown-item-sub">SOL</span>
              </button>
            </div>
          )}
        </div>

        <div className="wallet">
          {solanaActive ? (
            // Solana family: one Connect control, same slot. Wallets
            // come from Wallet Standard discovery (Phantom, Solflare,
            // Backpack, MetaMask's Solana support, ...), never a
            // hardcoded brand.
            solWallet.publicKey ? (
              <>
                <div className="wallet-info">
                  <span className="addr" title={solWallet.walletName ?? undefined}>
                    {solWallet.publicKey.toBase58().slice(0, 4)}…
                    {solWallet.publicKey.toBase58().slice(-4)}
                  </span>
                  {solBalance.data != null ? (
                    <span
                      className="wallet-balance"
                      title={`${formatNativeBalance(solBalance.data, 9)} SOL`}
                    >
                      {formatNativeBalance(solBalance.data, 9)}{' '}
                      <span className="wallet-balance-symbol">SOL</span>
                    </span>
                  ) : null}
                </div>
                <button className="wallet-btn" onClick={() => void solWallet.disconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              // One Connect control regardless of how many wallets were
              // discovered: the menu lists them (or an install hint when
              // none registered). Mirrors the EVM button's plain label.
              <div className="chain-dropdown">
                <button
                  type="button"
                  className="wallet-btn"
                  onClick={() => setSolWalletMenuOpen((o) => !o)}
                  disabled={solWallet.connecting}
                  aria-haspopup="listbox"
                  aria-expanded={solWalletMenuOpen}
                >
                  {solWallet.connecting ? 'Connecting…' : 'Connect'}
                </button>
                {solWalletMenuOpen && (
                  <div className="chain-dropdown-menu" role="listbox">
                    {solWallet.wallets.length === 0 ? (
                      <div className="chain-dropdown-item" role="note">
                        <span>
                          No Solana wallet found. Install Phantom, Solflare,
                          Backpack, or enable Solana in MetaMask.
                        </span>
                      </div>
                    ) : (
                      solWallet.wallets.map((w) => (
                        <button
                          key={w.name}
                          type="button"
                          role="option"
                          className="chain-dropdown-item"
                          onClick={() => {
                            setSolWalletMenuOpen(false)
                            void solWallet.connect(w.name)
                          }}
                        >
                          <img src={w.icon} alt="" width={16} height={16} />
                          <span>{w.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          ) : isConnected && address ? (
            <>
              <div className="wallet-info">
                <span className="addr">{shortenAddress(address)}</span>
                {balance ? (
                  <span className="wallet-balance" title={`${formatNativeBalance(balance.value, balance.decimals)} ${balance.symbol}`}>
                    {formatNativeBalance(balance.value, balance.decimals)}{' '}
                    <span className="wallet-balance-symbol">{balance.symbol}</span>
                  </span>
                ) : null}
              </div>
              <button className="wallet-btn" onClick={() => disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              {/* Single Connect button. wagmi may surface multiple
                  connectors (Injected + EIP-6963-discovered MetaMask),
                  but the user-facing affordance is one — pick the first
                  available connector and let the wallet's own dialog
                  disambiguate from there. */}
              {connectors[0] && (
                <button
                  className="wallet-btn"
                  onClick={handleConnect}
                  disabled={isPending}
                  aria-busy={isPending}
                >
                  {isPending ? 'Connecting…' : 'Connect'}
                </button>
              )}
              {visibleError && <span className="err">{visibleError.message}</span>}
            </>
          )}
        </div>
      </div>
    </header>
  )
}
