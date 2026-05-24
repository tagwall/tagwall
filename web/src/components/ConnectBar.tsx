import { useEffect, useRef, useState } from 'react'
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
import { Link } from 'react-router-dom'

import { useCanvasDeployed } from '../hooks/useCanvasDeployed'
import { shortenAddress } from '../lib/format'
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
  const { address, isConnected } = useAccount()
  const { connect, connectors, error, isPending } = useConnect()
  // Suppress the "wallet_requestPermissions already pending" race that fires
  // when a user double-clicks Connect before MetaMask's popup mounts. It's
  // not a real failure (the wallet will still resolve the original request),
  // and surfacing it as red error text just confuses people. Real errors
  // (UserRejected, NoEthereumProvider, etc) still display.
  const visibleError =
    error && !/already pending/i.test(error.message) ? error : null
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const chains = useChains()
  const { switchChain } = useSwitchChain()
  const currentChain = chains.find((c) => c.id === chainId)

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
  // is a chain we never deployed to (e.g. wallet on Polygon). Without this
  // banner, the next paint reverts deep in viem with an opaque error.
  const onUnsupportedChain = isConnected && !currentChain
  const recoveryChain = chains[0]

  // Not-deployed-on-this-chain detection. Distinct from wrong-chain: the
  // chain IS in our supported list, but the canvas hasn't been deployed
  // there yet (mainnet deploys gated on the treasury key ceremony, see
  // contracts/script/README.md). Calling paint() against an address with
  // no code is a value transfer, so funds would be lost permanently;
  // banner blocks the user before they reach for the paint button.
  const deployedStatus = useCanvasDeployed()
  const showNotDeployedBanner =
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
      {onUnsupportedChain && recoveryChain && (
        <div className="wrong-chain-banner" role="status">
          <span>
            Your wallet is on chain {chainId}, which Tagwall does not deploy to.
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

      <div className="connect-bar-right">
        {/* Canvas metrics live in the nav bar (left of chain) so the
            canvas itself can claim the vertical space the old metric
            strip ate. */}
        <NavMetrics />
        <div className="chain-dropdown">
          <button
            ref={chainBtnRef}
            type="button"
            className="chain-dropdown-trigger"
            onClick={() => setChainMenuOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={chainMenuOpen}
            title={isConnected ? 'Switch chain' : 'Connect a wallet to switch chains'}
          >
            <span className="chain-dropdown-label">{currentChain?.name ?? `Chain ${chainId}`}</span>
            <span className="chain-dropdown-caret" aria-hidden>▾</span>
          </button>
          {chainMenuOpen && (
            <div ref={chainMenuRef} className="chain-dropdown-menu" role="listbox">
              {chains.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === chainId}
                  className={`chain-dropdown-item ${c.id === chainId ? 'chain-dropdown-item-active' : ''}`}
                  onClick={() => {
                    if (isConnected) switchChain({ chainId: c.id })
                    setChainMenuOpen(false)
                  }}
                  disabled={!isConnected && c.id !== chainId}
                  title={!isConnected ? 'Connect a wallet first' : `Switch to ${c.name}`}
                >
                  <span>{c.name}</span>
                  <span className="chain-dropdown-item-sub">{c.nativeCurrency.symbol}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="wallet">
          {isConnected && address ? (
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
                  onClick={() => connect({ connector: connectors[0] })}
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
