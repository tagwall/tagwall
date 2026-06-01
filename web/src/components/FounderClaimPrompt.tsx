import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useChains } from 'wagmi'

import { useFounders } from '../hooks/useFounders'
import { chainColorTokens } from '../lib/chainColor'
import { useViewerChainId } from '../lib/viewerChain'
import { useThumbnailPixels } from './Leaderboard'
import { FounderShareCard } from './FounderShareCard'

/** Stop waiting for the entry to index after this long, then close quietly. */
const RESOLVE_TIMEOUT_MS = 30_000

interface Props {
  /** The connected painter's address, or undefined when disconnected. */
  painter: string | undefined
  /** A new non-null value (the success tx hash) arms the prompt once. */
  triggerKey: string | null
}

/**
 * Post-paint founder prompt. Fires at the moment of highest intent: right
 * after a painter's tx lands, if that paint just claimed them a founder
 * number, surface the shareable card in a modal. Only arms on a FIRST
 * claim (the painter was not already a founder when the paint landed), so
 * repeat paints by an existing founder stay silent. The founder entry
 * indexes a few seconds after the paint (live-refresh debounce + RPC), so
 * we arm on the trigger and open once the viewer's entry resolves.
 */
export function FounderClaimPrompt({ painter, triggerKey }: Props) {
  const { entries, stats } = useFounders()
  const chainId = useViewerChainId()
  const chains = useChains()
  const chainName = chains.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`
  const accent = chainColorTokens(chainId).hex

  // Armed = waiting for this painter's new founder entry to index. We only
  // arm when a fresh trigger arrives AND the painter wasn't already a
  // founder at that instant, so an existing founder repainting sees nothing.
  const [armed, setArmed] = useState(false)
  const [open, setOpen] = useState(false)
  const lastTrigger = useRef<string | null>(null)

  const lower = painter?.toLowerCase()
  const myEntry = useMemo(() => {
    if (!lower) return undefined
    return entries.find((e) => e.painter.toLowerCase() === lower)
  }, [lower, entries])

  useEffect(() => {
    if (!triggerKey || triggerKey === lastTrigger.current) return
    lastTrigger.current = triggerKey
    if (!lower) return
    // Already a founder before this paint indexed → repeat paint, stay quiet.
    const alreadyFounder = entries.some((e) => e.painter.toLowerCase() === lower)
    if (alreadyFounder) return
    setArmed(true)
  }, [triggerKey, lower, entries])

  // Once armed, open as soon as the entry resolves; give up after a while so
  // a non-founder paint (past rank 1000) doesn't leave us armed forever.
  useEffect(() => {
    if (!armed) return
    if (myEntry) {
      setOpen(true)
      setArmed(false)
      return
    }
    const timer = setTimeout(() => setArmed(false), RESOLVE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [armed, myEntry])

  const { data: thumbPixels } = useThumbnailPixels(
    open && myEntry ? [myEntry.region] : [],
  )

  if (!open || !myEntry) return null

  const key = `${myEntry.region.blockNumber}-${myEntry.region.logIndex}`

  return (
    <div className="founder-claim-backdrop" role="dialog" aria-modal="true" aria-label="You claimed a founder number">
      <div className="founder-claim-modal">
        <button
          type="button"
          className="founder-claim-close"
          aria-label="Close"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
        <p className="founder-claim-eyebrow">You just claimed</p>
        <FounderShareCard
          entry={myEntry}
          stats={stats}
          chainName={chainName}
          accent={accent}
          pixels={thumbPixels?.get(key)}
        />
        <Link to="/founders" className="founder-claim-board-link" onClick={() => setOpen(false)}>
          See the full founders board →
        </Link>
      </div>
    </div>
  )
}
