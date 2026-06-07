import { useEffect, useMemo, useRef, useState } from 'react'
import { formatEther, isAddress, getAddress } from 'viem'
import type { Address } from 'viem'

import type { PaintDraft } from '../hooks/usePaintDraft'
import { useNativeUsdPrice } from '../hooks/useNativeUsdPrice'
import type { PaintedRegion } from '../hooks/usePaintedRegions'
import { formatUsd, weiToUsdRate } from '../lib/usdPrice'
import {
  needsBigBlocks,
  isHyperEVM,
  SMALL_BLOCK_PIXEL_LIMIT,
  HYPEREVM_BIG_BLOCKS_DOC_URL,
} from '../lib/hyperevmBigBlocks'
import { Minimap } from './Minimap'

// Slippage buffer applied to the quoted cost when building `maxTotalCost`
// and `msg.value`. Protects against a concurrent paint landing in the same
// block and shifting per-pixel prices up. 10% matches the overwrite premium
// so a single-block race can always be covered; anything multi-block is a
// user-retry scenario anyway.
const SLIPPAGE_BPS = 1_000n
const BPS = 10_000n

// Reserve-multiplier bounds. Mirrors Canvas.sol constants: BPS (10000 = 1.0x
// minimum, enforced by the contract) to MAX_RESERVE_MULTIPLIER_BPS (1000000
// = 100x, the hard cap). Step of 1000 gives 0.1x granularity, enough for
// users to feel the knob without overwhelming them with precision.
const MULTIPLIER_MIN_BPS = 10_000
const MULTIPLIER_MAX_BPS = 1_000_000
const MULTIPLIER_STEP_BPS = 1_000

function fmtMultiplier(bps: number): string {
  return `${(bps / 10_000).toFixed(1)}x`
}

interface Props {
  draft: PaintDraft | null
  error: string | null
  pixelCount: number
  /** On-chain per-transaction pixel cap (Canvas.maxPixelsPerTx, currently 1500). */
  maxPixelsPerTx: number
  /** Frontend UI cap on each stamp side in pixels. */
  maxStampSide: number
  maxWidth: number
  onLoad: (file: File) => void
  onResize: (targetW: number) => void
  onClear: () => void

  // Cost quote + submit wiring.
  quoteTotal: bigint | null
  quoteLoading: boolean
  quoteError: string | null

  canSubmit: boolean
  submitStatus: 'idle' | 'pending' | 'confirming' | 'success' | 'error'
  submitError: string | null
  txHash?: `0x${string}`
  /** Chunk progress during a multi-tx sequential paint. Null on single-tx paths. */
  batchProgress?: { done: number; total: number } | null
  /** True when the connected wallet + chain support EIP-5792 atomic batching. */
  canAtomicBatch?: boolean
  /** Native-token ticker for the active chain (e.g. "PLS", "ETH"). */
  nativeSymbol: string
  onSubmit: (args: {
    link: string
    referrer?: Address
    maxTotalCost: bigint
    value: bigint
    reserveMultiplierBps: bigint
    /** When true, the submit hook reads current pixel state and masks
     *  any pixel whose color already matches the draft as transparent
     *  so the contract skips them with no charge. Used by the
     *  "Retry without re-paying" affordance after a failed paint. */
    skipUnchanged?: boolean
  }) => Promise<void> | void
  disabledReason?: string
  /** Optionally prefills the referrer field with a share link (e.g. ?ref=0x...). */
  defaultReferrer?: Address
  /**
   * Address of the connected wallet, used to block self-referral. The contract
   * strips referrer == painter (the referral slice is redirected to the
   * treasury; see Canvas.sol _settle and test_SelfReferral_routesReferralSliceToTreasury),
   * so a self-referral earns nothing on-chain anyway. We block it in the UX too:
   * it looks like either a mistake (wrong address pasted) or a failed attempt to
   * farm the referral slice. Neither case warrants submitting.
   */
  connectedAddress?: Address
  /** True while a file is being dragged anywhere on the page. Lights up the
   *  empty-state Zone 1 tile + collapses Zone 2 to a single helper line per
   *  the docs/design_handoff_upload_tile spec. */
  isDragging?: boolean
  /** Filename + size for the dragged file, when the browser exposes pre-drop
   *  metadata. Renders below the active dropzone copy stack. */
  dragFileHint?: { name: string; size: number } | null
  /** Active chain id, used to convert wei → USD for the indicative cost
   *  subline. `null` hides the USD readout. */
  chainId?: number | null
  /** Current canvas zoom factor. Renders inside Zone 4 below the
   *  Tag-it button so the canvas doesn't need its own toolbar row. */
  zoom?: number
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomReset?: () => void
  /** Force-refresh: invalidate region + tile + leaderboard caches. */
  onRefresh?: () => void
  /** True while a refresh is in flight (button spins, disabled). */
  refreshing?: boolean
  /** All Painted events for the current chain — passed through to the
   *  paint-bar minimap so users see where their draft lands relative
   *  to the rest of the canvas. */
  regions?: readonly PaintedRegion[]
  /** Canvas dimensions; the minimap derives its scale from these. */
  canvasWidth?: number
  canvasHeight?: number
}

function shortenHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`
}

/** Cheap URL sanity check. Real validation is on-chain. */
function isPlausibleHttpsUrl(s: string): boolean {
  if (!s) return true // empty = "no link" is fine
  if (!s.startsWith('https://')) return false
  if (s.length <= 8 || s.length > 256) return false
  return true
}

/** "2.1 MB" / "428 KB" — human-readable byte size for the dropzone hint. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const KB = 1024
  const MB = KB * 1024
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`
  return `${bytes} B`
}

/** 4 sf keeps token values readable (e.g. "962.0" not "962.06500123").
 *  Thousand-separator commas above 1k so PLS-scale numbers
 *  (6,700 / 13,400 / 100,000) don't run together as a digit blob. */
function formatCost(wei: bigint): string {
  const ether = formatEther(wei)
  const num = Number(ether)
  if (!Number.isFinite(num)) return ether
  if (num === 0) return '0'
  if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (num >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (num >= 0.01) return num.toFixed(4)
  return num.toPrecision(2)
}

export function PaintControls({
  draft,
  error,
  pixelCount,
  maxPixelsPerTx,
  maxStampSide,
  maxWidth,
  onLoad,
  onResize,
  onClear,
  quoteTotal,
  quoteLoading,
  quoteError,
  canSubmit,
  submitStatus,
  submitError,
  txHash,
  onSubmit,
  disabledReason,
  defaultReferrer,
  batchProgress,
  canAtomicBatch,
  nativeSymbol,
  connectedAddress,
  isDragging = false,
  dragFileHint = null,
  chainId = null,
  zoom = 1,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onRefresh,
  refreshing = false,
  regions,
  canvasWidth = 1250,
  canvasHeight = 800,
}: Props) {
  const usdRate = useNativeUsdPrice(chainId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState('')
  const [reserveBps, setReserveBps] = useState<number>(MULTIPLIER_MIN_BPS)
  // Referrer is optional; empty string = no referrer = 0x0...0 on-chain.
  // Seed from the ?ref= query param when present (embed + share-link use).
  const [referrer, setReferrer] = useState<string>(defaultReferrer ?? '')

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onLoad(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const linkValid = isPlausibleHttpsUrl(link)
  const referrerTrim = referrer.trim()
  const referrerFormatValid = referrerTrim === '' || isAddress(referrerTrim)
  const referrerResolved: Address | undefined =
    referrerFormatValid && referrerTrim !== '' ? getAddress(referrerTrim) : undefined
  // Self-referral check: referrer can't be the connected wallet. The contract
  // strips it (slice goes to treasury, earns the painter nothing); UX refuses
  // it outright so the user doesn't waste a paint expecting a rebate.
  const referrerIsSelf = Boolean(
    referrerResolved &&
      connectedAddress &&
      referrerResolved.toLowerCase() === connectedAddress.toLowerCase(),
  )
  const referrerValid = referrerFormatValid && !referrerIsSelf
  const referrerErrorMessage = !referrerFormatValid
    ? 'Must be a valid 0x… address or blank.'
    : referrerIsSelf
    ? "Referrer can't be your own wallet."
    : null

  // Chunking: a stamp bigger than the per-tx cap will require N transactions.
  // Single-tx paint works today; multi-chunk submits land with EIP-5792
  // batch-sign (next commit). For now we compute the number so the UI can
  // surface it; submit is disabled when chunks > 1 until batching ships.
  const chunksRequired = pixelCount > 0 ? Math.ceil(pixelCount / maxPixelsPerTx) : 0
  const needsBatching = chunksRequired > 1

  // Applied cost at the chosen multiplier. The on-chain paint() recomputes
  // this per-pixel so the number shown here must match the contract's math
  // exactly: `minQuote * reserveMultiplierBps / BPS` per pixel, summed.
  // Summing scalar-multiplies, so the batch calculation collapses to
  // `quoteTotal * reserveMultiplierBps / BPS`.
  const reserveBpsBig = BigInt(reserveBps)

  // Transparent pixels (the 0xFFFFFFFF sentinel) are skipped by the contract
  // with no charge, but quote(rect) prices the whole rectangle — so a logo
  // with transparency over-quotes (e.g. a 32×32 logo that's mostly
  // transparent quotes 1024 px but only pays for ~250). Scale the quote by
  // the opaque fraction so the displayed cost AND the maxTotalCost we
  // send/hold match what paint() actually charges. Exact on a virgin area
  // (uniform floor price), a close approximation over mixed/overwrite areas.
  // Skipped entirely for fully-opaque drafts (opaqueCount === pixelCount).
  const opaqueCount = useMemo(() => {
    if (!draft) return 0
    let n = 0
    for (let i = 0; i < draft.colors.length; i++) {
      if ((draft.colors[i] >>> 0) !== 0xffffffff) n++
    }
    return n
  }, [draft])
  const effectiveQuoteTotal =
    quoteTotal !== null && pixelCount > 0 && opaqueCount < pixelCount
      ? (quoteTotal * BigInt(opaqueCount)) / BigInt(pixelCount)
      : quoteTotal

  const liveScaledCost =
    effectiveQuoteTotal !== null ? (effectiveQuoteTotal * reserveBpsBig) / BPS : null

  // Stable display value: keep the last successful quote on screen during
  // re-fetches so dragging the stamp around doesn't make the price column
  // visibly collapse to "…" between every reposition. Effect runs post-
  // render so the ref always trails the most-recent successful render
  // by one — the next loading render reads it as the prior value.
  const lastScaledCostRef = useRef<bigint | null>(null)
  useEffect(() => {
    if (liveScaledCost !== null) lastScaledCostRef.current = liveScaledCost
  }, [liveScaledCost])
  // Reset the cached value when the draft is cleared so we don't show
  // a stale price for a brand-new upload.
  useEffect(() => {
    if (!draft) lastScaledCostRef.current = null
  }, [draft])

  const scaledCost = liveScaledCost ?? lastScaledCostRef.current

  const maxTotalCost =
    scaledCost !== null ? (scaledCost * (BPS + SLIPPAGE_BPS)) / BPS : null

  // Indicative USD subline. Hidden when the chain has no fixture so we
  // don't mislead users with a $0 readout on chains we can't price.
  const scaledCostUsd =
    scaledCost !== null ? weiToUsdRate(scaledCost, usdRate) : 0
  const scaledCostUsdLabel = scaledCostUsd > 0 ? formatUsd(scaledCostUsd) : ''

  async function handleSubmit(opts?: { skipUnchanged?: boolean }) {
    if (!draft || maxTotalCost === null) return
    await onSubmit({
      link,
      referrer: referrerResolved,
      skipUnchanged: opts?.skipUnchanged,
      maxTotalCost,
      value: maxTotalCost,
      reserveMultiplierBps: reserveBpsBig,
    })
  }

  const submitDisabled =
    !canSubmit ||
    !draft ||
    quoteTotal === null ||
    quoteLoading ||
    !linkValid ||
    !referrerValid ||
    submitStatus === 'pending' ||
    submitStatus === 'confirming'

  let submitLabel = 'Tag it'
  if (submitStatus === 'pending') submitLabel = 'Confirm in wallet…'
  else if (submitStatus === 'confirming') submitLabel = 'Pending transaction…'
  else if (submitStatus === 'success') submitLabel = 'Tagged. Go again?'

  // Busy = paint in flight (awaiting wallet confirm, or broadcast and
  // waiting for a block). The button is disabled in these states, so it
  // gets a spinner + "working" styling rather than reading as a dead,
  // greyed-out box.
  const isBusy = submitStatus === 'pending' || submitStatus === 'confirming'

  // Priority ordering for the single inline status line. "Painted." success
  // is intentionally NOT handled here; it's surfaced via a toast popover
  // owned by the parent (HomePage) so it doesn't take row space and can
  // auto-dismiss. Lower-priority items fall through when higher ones are
  // absent.
  let statusLine: { kind: 'err' | 'info'; text: string } | null = null
  if (submitError) statusLine = { kind: 'err', text: submitError }
  else if (!linkValid) statusLine = { kind: 'err', text: 'Link must start with https:// and be ≤ 256 bytes.' }
  // Referrer errors render inline under the referrer input (pc-field-err),
  // not in the shared status line; that way the user sees the message right
  // where they typed the bad value.
  else if (submitStatus === 'confirming' && txHash)
    statusLine = { kind: 'info', text: `Tx ${shortenHash(txHash)} broadcast; waiting for a block.` }
  else if (batchProgress && batchProgress.total > 1 && submitStatus !== 'idle' && submitStatus !== 'success')
    statusLine = { kind: 'info', text: `Submitting chunk ${batchProgress.done} of ${batchProgress.total}…` }
  else if (disabledReason && submitStatus === 'idle')
    statusLine = { kind: 'info', text: disabledReason }

  // Signature-count caption under the cost line in the CTA zone.
  // Always shown when there's a draft (operator preference 2026-05-24:
  // "Needs 1 signature" is informative for first-time painters even
  // when no batching is needed, so the single-chunk path shouldn't
  // hide it). Multi-chunk paints distinguish between atomic-batch
  // wallets (1 signature for N txs via EIP-5792) and serial-sign
  // wallets (N signatures for N txs).
  const chunksMessage =
    chunksRequired > 0
      ? needsBatching
        ? canAtomicBatch
          ? `Needs ${chunksRequired} txs, 1 signature`
          : `Needs ${chunksRequired} signatures`
        : 'Needs 1 signature'
      : null

  const scaled = draft && (draft.sourceW !== draft.w || draft.sourceH !== draft.h)

  // The empty-state is now a full 3-zone bar (Image / How it works / CTA)
  // instead of the original 1-button row — needs the same vertical room
  // as the draft-loaded open state. Treat both as "open" for layout; the
  // closed-collapsed style is no longer reachable post-redesign.
  return (
    <section className="paint-controls paint-controls-open" aria-live="polite">
      {!draft && (
        <div className={`paint-bar paint-bar-empty${isDragging ? ' is-dragging' : ''}`}>
          {/* Zone 1 — image dropzone tile. <label> wraps a hidden <input>
              so click anywhere triggers the native file picker. */}
          <div className="pz peb-image">
            <div className={`pz-label peb-zone-label${isDragging ? ' peb-zone-label-active' : ''}`}>
              {isDragging ? '01 · Image · Drop to upload' : '01 · Image'}
            </div>
            <label
              className={`peb-tile${isDragging ? ' peb-tile-active' : ''}`}
              title="Upload an image to paint on the canvas"
            >
              <span className="peb-tile-icon" aria-hidden>
                {isDragging ? '↓' : '↑'}
              </span>
              <span className="peb-tile-copy">
                {isDragging ? (
                  <>
                    <span className="peb-tile-primary peb-tile-primary-active">
                      Release to upload
                    </span>
                    <span className="peb-tile-secondary peb-tile-secondary-active">
                      {dragFileHint
                        ? `${dragFileHint.name} · ${formatBytes(dragFileHint.size)}`
                        : 'image · waiting…'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="peb-tile-primary">
                      Drop an image or <span className="peb-tile-browse">browse</span>
                    </span>
                    <span className="peb-tile-secondary">
                      PNG&nbsp;·&nbsp;JPG&nbsp;·&nbsp;GIF&nbsp;&nbsp;·&nbsp;&nbsp;any size
                    </span>
                  </>
                )}
              </span>
              <input
                ref={fileInputRef}
                id="paint-upload-input"
                type="file"
                accept="image/png,image/jpeg,image/gif"
                onChange={handleFile}
              />
            </label>
            {error && <span className="paint-err peb-err">{error}</span>}
          </div>

          {/* Zone 2 — How it works. 3-step explainer in idle, single line
              when dragging (the canvas overlay carries the message). */}
          <div className="pz peb-howto">
            <div className="pz-label">How it works</div>
            {isDragging ? (
              <p className="peb-howto-line">
                Drop anywhere on the page — we'll auto-scale your image to
                fit within{' '}
                <span className="peb-howto-accent">
                  {maxStampSide} × {maxStampSide} px
                </span>
                .
              </p>
            ) : (
              <ol className="peb-steps">
                <li className="peb-step">
                  <span className="peb-step-num">1</span>
                  <span className="peb-step-body">
                    <span className="peb-step-head">Upload</span>
                    <span className="peb-step-sub">PNG / JPG / GIF — any size</span>
                  </span>
                </li>
                <li className="peb-step">
                  <span className="peb-step-num">2</span>
                  <span className="peb-step-body">
                    <span className="peb-step-head">Auto-scaled</span>
                    <span className="peb-step-sub">
                      Fit to {maxStampSide} × {maxStampSide} px · split across txs as needed
                    </span>
                  </span>
                </li>
                <li className="peb-step">
                  <span className="peb-step-num">3</span>
                  <span className="peb-step-body">
                    <span className="peb-step-head">Paint</span>
                    <span className="peb-step-sub">
                      Larger pieces? Paint multiple sections
                    </span>
                  </span>
                </li>
              </ol>
            )}
          </div>

          {/* Zone 3 — disabled CTA. Hidden in dragging state because the
              canvas itself becomes the drop target; preserve cell padding
              so grid height doesn't jump. */}
          <div className="pz peb-cta-zone">
            {!isDragging && (
              <button
                type="button"
                className="peb-cta"
                aria-disabled
                disabled
                title="Upload an image first"
              >
                Upload to tag
              </button>
            )}
          </div>

          {/* Zone 4 (empty-state) — Minimap + zoom controls. Mirrors
              the open-state Zone 5 so the canvas overview + zoom are
              reachable before the user uploads anything. Label dropped
              the "04 ·" prefix 2026-05-24 (operator preference: the
              numeric prefixes feel over-templated for this single-word
              zone). */}
          <div className="pz pz-minimap">
            <div className="pz-label">Zoom</div>
            <Minimap
              regions={regions}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              draft={null}
            />
            {(onZoomIn || onZoomOut || onZoomReset || onRefresh) && (
              <div className="pz-zoom" role="toolbar" aria-label="Canvas zoom">
                <button
                  type="button"
                  className="pz-zoom-btn"
                  onClick={onZoomOut}
                  disabled={!onZoomOut || zoom <= 1}
                  title="Zoom out (Ctrl+scroll on canvas)"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="pz-zoom-level" aria-live="polite">
                  {zoom.toFixed(1)}×
                </span>
                <button
                  type="button"
                  className="pz-zoom-btn"
                  onClick={onZoomIn}
                  disabled={!onZoomIn || zoom >= 8}
                  title="Zoom in (Ctrl+scroll on canvas)"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className="pz-zoom-btn pz-zoom-fit"
                  onClick={onZoomReset}
                  disabled={!onZoomReset || zoom === 1}
                  title="Reset zoom to fit"
                >
                  Fit
                </button>
                {onRefresh && (
                  <button
                    type="button"
                    className={`pz-zoom-btn pz-zoom-refresh${refreshing ? ' pz-zoom-refresh-spinning' : ''}`}
                    onClick={onRefresh}
                    disabled={refreshing}
                    title="Refresh canvas data from the chain"
                    aria-label="Refresh canvas"
                  >
                    ↻
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {draft && (
        <div className="paint-bar">
          {/* Zone 1 — Image. Thumb + filename + dims. The X (clear) is
              the entire start-over affordance; replacing means clearing
              and re-uploading via the empty-state dropzone. */}
          <div className="pz pz-image">
            <div className="pz-label">01 · Image</div>
            <div className="pz-image-row">
              <img className="pz-thumb" src={draft.thumbUrl} alt="Current paint preview" />
              <div className="pz-image-meta">
                <div className="pz-filename" title={draft.name}>{draft.name}</div>
                <div className="pz-dims">
                  {scaled
                    ? `${draft.sourceW}×${draft.sourceH} → ${draft.w}×${draft.h} px`
                    : `${draft.w}×${draft.h} px`}
                </div>
              </div>
              <button className="pz-clear" onClick={onClear} title="Clear this draft" aria-label="Clear draft">×</button>
            </div>
            {/* Scale slider lives in Image zone — it's a sizing control,
                conceptually part of the uploaded image's staging. */}
            <label className="pz-scale" htmlFor="paint-resize">
              <span className="pz-scale-label">Scale</span>
              <input
                id="paint-resize"
                type="range"
                min={1}
                max={Math.max(1, maxWidth)}
                value={draft.w}
                onChange={(e) => onResize(Number(e.target.value))}
                className="pz-slider"
              />
            </label>
          </div>

          {/* Zone 2 — Metadata. LINK + REFERRER inline rows with left-label pill. */}
          <div className="pz pz-metadata">
            <div className="pz-label">02 · Metadata</div>
            <div className={`pz-field ${!linkValid ? 'pz-field-invalid' : ''}`}>
              <span className="pz-field-pill">Link</span>
              <input
                id="paint-link"
                className="pz-field-input"
                type="url"
                placeholder="https://example.com (optional)"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </div>
            <div className={`pz-field ${!referrerValid ? 'pz-field-invalid' : ''}`}>
              <span className="pz-field-pill">Referrer</span>
              <input
                id="paint-referrer"
                className="pz-field-input"
                type="text"
                placeholder="0x… address (optional, earns 5%)"
                value={referrer}
                onChange={(e) => setReferrer(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!referrerValid}
                aria-describedby={referrerErrorMessage ? 'paint-referrer-err' : undefined}
              />
            </div>
            {referrerErrorMessage && (
              <span id="paint-referrer-err" className="pz-field-err">
                {referrerErrorMessage}
              </span>
            )}
          </div>

          {/* Zone 3 — Pricing. Order top-to-bottom: cost value + USD
              subline, then Premium slider, then a one-line explainer
              about what the multiplier does (operator preference
              2026-05-24: caption belongs UNDER the control it
              describes, not above it). */}
          <div className="pz pz-pricing">
            <div className="pz-label">03 · Pricing</div>
            <div className="pz-cost">
              <div className="pz-cost-line pz-cost-line-primary">
                <span className="pz-cost-value">
                  {quoteLoading
                    ? '…'
                    : quoteError
                    ? 'err'
                    : scaledCost !== null
                    ? formatCost(scaledCost)
                    : '—'}
                </span>
                <span className="pz-cost-unit">{nativeSymbol}</span>
              </div>
              {scaledCostUsdLabel && (
                <div className="pz-cost-line pz-cost-usd">
                  ≈ {scaledCostUsdLabel}
                </div>
              )}
            </div>
            <div className="pz-premium">
              <span className="pz-premium-label">Premium</span>
              <input
                id="paint-reserve"
                type="range"
                min={MULTIPLIER_MIN_BPS}
                max={MULTIPLIER_MAX_BPS}
                step={MULTIPLIER_STEP_BPS}
                value={reserveBps}
                onChange={(e) => setReserveBps(Number(e.target.value))}
                className="pz-slider"
              />
              <span className="pz-premium-value">{fmtMultiplier(reserveBps)}</span>
            </div>
            <div className="pz-premium-explainer">
              Premium multiplier deters tags being overwritten
            </div>
          </div>

          {/* Zone 4 — Tag-it CTA, then slippage cap + signature count
              below it (operator preference 2026-05-03), then tx status
              + smart-retry option. */}
          <div className="pz pz-cta">
            <button
              className={`pz-tag-btn${isBusy ? ' pz-tag-btn-busy' : ''}`}
              disabled={submitDisabled}
              onClick={() => handleSubmit()}
              aria-busy={isBusy}
            >
              {isBusy && <span className="pz-tag-spinner" aria-hidden="true" />}
              {submitLabel}
              {!submitDisabled && submitStatus === 'idle' && ' →'}
            </button>
            {(maxTotalCost !== null || chunksMessage) && (
              <div className="pz-cta-meta">
                {maxTotalCost !== null && (
                  <div className={`pz-cta-meta-line ${needsBatching ? 'pz-cost-warn' : ''}`}>
                    up to {formatCost(maxTotalCost)} <span className="token">{nativeSymbol}</span> w/ 10% slip
                  </div>
                )}
                {chunksMessage && (
                  <div className={`pz-cta-meta-line ${needsBatching ? 'pz-cost-warn' : ''}`}>
                    {chunksMessage}
                  </div>
                )}
              </div>
            )}
            {/* After a failed paint, offer a smart-retry that pre-
                reads the chain state for the draft's pixels and skips
                any whose color already matches. The contract treats
                the masked pixels as transparent (no charge), so a
                partial paint can be finished without re-paying for
                the chunks that already landed. */}
            {submitStatus === 'error' && !submitDisabled && (
              <button
                type="button"
                className="pz-tag-btn pz-tag-btn-secondary"
                onClick={() => handleSubmit({ skipUnchanged: true })}
                title="Re-reads pixel state from the chain and only pays for pixels that don't already match your draft."
              >
                Finish paint
              </button>
            )}
            {statusLine && (
              <div
                className={`pz-status pz-status-${statusLine.kind}${
                  isBusy && statusLine.kind === 'info' ? ' pz-status-busy' : ''
                }`}
                aria-live="polite"
              >
                {statusLine.text}
              </div>
            )}
            {/* HyperEVM (chain 999): paints over the small-block limit need
                "big blocks" enabled on the wallet (a one-time HyperCore
                setup). Surface it proactively before the paint, and again
                if a paint errors (a likely cause on chain 999). See
                lib/hyperevmBigBlocks.ts. */}
            {needsBigBlocks(chainId, pixelCount) && submitStatus === 'idle' && (
              <div className="pz-status pz-status-info">
                HyperEVM: paints over ~{SMALL_BLOCK_PIXEL_LIMIT} px need{' '}
                <strong>big blocks</strong> enabled on your wallet (one-time).
                You need a HyperCore account first — move a little HYPE to Core,
                then enable big blocks.{' '}
                <a
                  href={HYPEREVM_BIG_BLOCKS_DOC_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  How to enable →
                </a>
              </div>
            )}
            {submitStatus === 'error' && isHyperEVM(chainId) && (
              <div className="pz-status pz-status-info">
                On HyperEVM, a paint this size won&rsquo;t go through until{' '}
                <strong>big blocks</strong> are enabled on your wallet (one-time,
                needs a HyperCore account).{' '}
                <a
                  href={HYPEREVM_BIG_BLOCKS_DOC_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  How to enable →
                </a>
              </div>
            )}
          </div>

          {/* Zone 5 — Minimap + zoom controls. Label dropped the
              "05 ·" prefix 2026-05-24 to match the empty-state zone. */}
          <div className="pz pz-minimap">
            <div className="pz-label">Zoom</div>
            <Minimap
              regions={regions}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              draft={draft ? { x: draft.x, y: draft.y, w: draft.w, h: draft.h } : null}
            />
            {(onZoomIn || onZoomOut || onZoomReset || onRefresh) && (
              <div className="pz-zoom" role="toolbar" aria-label="Canvas zoom">
                <button
                  type="button"
                  className="pz-zoom-btn"
                  onClick={onZoomOut}
                  disabled={!onZoomOut || zoom <= 1}
                  title="Zoom out (Ctrl+scroll on canvas)"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="pz-zoom-level" aria-live="polite">
                  {zoom.toFixed(1)}×
                </span>
                <button
                  type="button"
                  className="pz-zoom-btn"
                  onClick={onZoomIn}
                  disabled={!onZoomIn || zoom >= 8}
                  title="Zoom in (Ctrl+scroll on canvas)"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className="pz-zoom-btn pz-zoom-fit"
                  onClick={onZoomReset}
                  disabled={!onZoomReset || zoom === 1}
                  title="Reset zoom to fit"
                >
                  Fit
                </button>
                {onRefresh && (
                  <button
                    type="button"
                    className={`pz-zoom-btn pz-zoom-refresh${refreshing ? ' pz-zoom-refresh-spinning' : ''}`}
                    onClick={onRefresh}
                    disabled={refreshing}
                    title="Refresh canvas data from the chain"
                    aria-label="Refresh canvas"
                  >
                    ↻
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
