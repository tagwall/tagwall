import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js'
import { useQuery } from '@tanstack/react-query'

import {
  SOLANA_CANVAS_HEIGHT,
  SOLANA_CANVAS_WIDTH,
  SOLANA_TRANSPARENT,
  WIRE_LEGACY,
  WIRE_V0_ALT,
} from '../solana/constants'
import {
  TILE_ACCOUNT_SIZE,
  buildInitTileIx,
  buildPaintIx,
  buildRegisterLinkIx,
  buildV0Transaction,
  fetchAltTables,
  canvasPda,
  computeBudgetIx,
  decodeCanvasConfig,
  decodeLinkHash,
  linkHashPda,
  tilePda,
  vaultPda,
} from '../solana/client'
import { encodeStamp, decodePlan, type StampPlan } from '../solana/encodeStamp'
import { quotePlan, tileKey, withSlippage } from '../solana/quote'
import {
  solanaConnection,
  useSolanaCanvas,
  useSolanaRegions,
} from '../hooks/useSolanaCanvas'
import { useSolanaLinkUrls } from '../hooks/useSolanaLinkUrls'
import { isValidSolanaAddress, useSolanaReferrer } from '../hooks/useSolanaReferrer'
import { maskUnchangedPixels } from '../solana/maskUnchanged'
import { SOLANA_PSEUDO_CHAIN_ID } from '../lib/usdPrice'
import { SOLANA_EXPLORER_SUFFIX } from '../solana/cluster'
import { useSolanaWallet } from '../solana/SolanaWalletProvider'
import { usePaintDraft } from '../hooks/usePaintDraft'
import { CompetitionBanner } from '../components/CompetitionBanner'
import { LeaderboardTicker } from '../components/LeaderboardTicker'
import { Leaderboard } from '../components/Leaderboard'
import { ActivityFeed } from '../components/ActivityFeed'
import { OutboundLinkModal } from '../components/OutboundLinkModal'
import { PaintControls } from '../components/PaintControls'
import { SolanaCanvasView } from '../components/SolanaCanvasView'
import { SolanaStatsCards } from '../components/SolanaStatsCards'

/** Solana chunks per-transaction, so the EVM single-tx gas ceiling
 *  doesn't apply; the cap only bounds client-side encode work and
 *  signature count. 250 keeps a full-quality 250x250 stamp possible. */
const MAX_STAMP_SIDE = 250
/** Program pixel cap (sanity bound; chunking happens in encodeStamp). */
const MAX_PIXELS_PER_TX = 1500

/** Display scale: shared components format with 18-dec formatEther,
 *  lamports are 9-dec, so multiply by 1e9 for exact SOL rendering. */
const LAMPORTS_TO_DISPLAY = 1_000_000_000n

type PaintPhase =
  | { step: 'idle' }
  | { step: 'preparing' }
  | { step: 'signing'; txCount: number }
  | { step: 'sending'; done: number; total: number }
  | { step: 'success'; signatures: string[] }
  | { step: 'error'; message: string }

/** Render a plan's exact decoded pixels. The trust contract: what this
 *  shows is byte-identical to what the chain will store. */
function PlanPreview({
  plan,
  bounds,
  label,
  txs,
  selected,
  onSelect,
}: {
  plan: StampPlan
  bounds: { x: number; y: number; w: number; h: number }
  label: string
  txs: number
  selected: boolean
  onSelect: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pixels = decodePlan(plan, bounds)
    const img = ctx.createImageData(bounds.w, bounds.h)
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]
      if (p === SOLANA_TRANSPARENT) {
        img.data[i * 4 + 3] = 0
      } else {
        img.data[i * 4 + 0] = (p >> 16) & 0xff
        img.data[i * 4 + 1] = (p >> 8) & 0xff
        img.data[i * 4 + 2] = p & 0xff
        img.data[i * 4 + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [plan, bounds])

  return (
    <button
      type="button"
      className={`sol-plan-option${selected ? ' sol-plan-selected' : ''}`}
      onClick={onSelect}
    >
      <canvas ref={ref} width={bounds.w} height={bounds.h} className="sol-plan-canvas" />
      <span className="sol-plan-label">
        {selected ? '⦿' : '◯'} {label} · {txs} tx{txs === 1 ? '' : 's'}
      </span>
    </button>
  )
}

export default function SolanaPage() {
  const { config, tiles, tileMap, vaultLamports, paintedPixels, isLoading, error, refetch } =
    useSolanaCanvas()
  // Stagger: history only starts after the canvas state has settled
  // (success or failure), halving the mount burst against the rate-
  // limited public RPC.
  const { regions, isLoading: regionsLoading } = useSolanaRegions({
    enabled: !isLoading,
  })
  const wallet = useSolanaWallet()
  // Registry URLs for every linkId in the feed; the shared dock
  // components consume the map via linkUrlsOverride, and the canvas
  // hover tooltip resolves through the same cache.
  const linkUrls = useSolanaLinkUrls(regions?.map((r) => r.linkId) ?? [])
  // ?ref= referral capture (base58), mirroring the EVM useSharedReferrer.
  const sharedReferrer = useSolanaReferrer()
  const paint = usePaintDraft({
    canvasWidth: SOLANA_CANVAS_WIDTH,
    canvasHeight: SOLANA_CANVAS_HEIGHT,
    maxStampSide: MAX_STAMP_SIDE,
    regions,
  })
  const { draft } = paint

  const [zoom, setZoom] = useState(1)
  const [phase, setPhase] = useState<PaintPhase>({ step: 'idle' })
  const [fidelity, setFidelity] = useState<'standard' | 'full'>('standard')
  const [outboundUrl, setOutboundUrl] = useState<string | null>(null)

  /* --------------------------- plan + quote -------------------------- */

  // Published address-lookup tables for this cluster. With ALTs loaded,
  // account refs cost 1 byte instead of 32, so chunks fit ~40% more
  // pixels; the encoder and the tx builder MUST use the same profile,
  // which is why both read from this one query. Until (or unless) the
  // tables load, everything runs on the legacy profile; a stamp planned
  // under legacy still fits under v0, never the reverse.
  const { data: altTables } = useQuery<AddressLookupTableAccount[]>({
    queryKey: ['solana', 'alt-tables'],
    queryFn: () => fetchAltTables(solanaConnection()),
    staleTime: Infinity,
    retry: 1,
  })
  const wireProfile = altTables && altTables.length > 0 ? WIRE_V0_ALT : WIRE_LEGACY

  const encoded = useMemo(() => {
    if (!draft) return null
    try {
      return encodeStamp(
        {
          x: draft.x,
          y: draft.y,
          w: draft.w,
          h: draft.h,
          pixels: Uint32Array.from(draft.colors),
        },
        64,
        wireProfile,
      )
    } catch {
      return null
    }
  }, [draft, wireProfile])

  const selectedPlan: StampPlan | null = useMemo(() => {
    if (!encoded) return null
    if (encoded.kind === 'lossless') return encoded.plan
    return fidelity === 'standard' ? encoded.standard : encoded.full
  }, [encoded, fidelity])

  const quote = useMemo(() => {
    if (!selectedPlan || !config) return null
    return quotePlan(selectedPlan.chunks, tileMap, config, Math.floor(Date.now() / 1000))
  }, [selectedPlan, tileMap, config])

  // Tile-init transactions for the draft's bounding box (lazy tiles the
  // stamp touches that don't exist yet, batched 6 per tx). Identical
  // for every plan of the same draft, so it adds uniformly to the
  // fidelity-radio labels and the signature caption. A brand-new link
  // can add one more tx at submit time; the wallet shows the final
  // count either way.
  const initTxCount = useMemo(() => {
    if (!draft) return 0
    let missing = 0
    for (let ty = Math.floor(draft.y / 20); ty <= Math.floor((draft.y + draft.h - 1) / 20); ty++) {
      for (let tx = Math.floor(draft.x / 20); tx <= Math.floor((draft.x + draft.w - 1) / 20); tx++) {
        if (!tileMap.has(tileKey(tx, ty))) missing++
      }
    }
    return Math.ceil(missing / 6)
  }, [draft, tileMap])

  /* ---------------------------- paint flow --------------------------- */

  const busy = phase.step !== 'idle' && phase.step !== 'success' && phase.step !== 'error'
  const canPaint = !!wallet.publicKey && !!selectedPlan && !!config && !!quote && !busy

  const submit = useCallback(
    async (
      linkUrl: string,
      reserveMultiplierBps: bigint,
      referrerRaw?: string,
      skipUnchanged?: boolean,
    ) => {
      if (!wallet.publicKey || !selectedPlan || !config || !quote || !draft) return
      const conn = solanaConnection()
      const painter = wallet.publicKey
      setPhase({ step: 'preparing' })
      try {
        // Retry-without-repaying: mask every pixel whose on-chain color
        // already matches the draft, then re-plan and re-quote on the
        // masked stamp. Matching pixels become transparent and are
        // never charged (the EVM flow's skipUnchanged semantics).
        let plan = selectedPlan
        let planQuote = quote
        if (skipUnchanged) {
          const masked = maskUnchangedPixels(
            { x: draft.x, y: draft.y, w: draft.w, h: draft.h, pixels: Uint32Array.from(draft.colors) },
            tileMap,
          )
          let res
          try {
            res = encodeStamp(
              { x: draft.x, y: draft.y, w: draft.w, h: draft.h, pixels: masked },
              64,
              wireProfile,
            )
          } catch {
            setPhase({
              step: 'error',
              message: 'every pixel already matches the canvas; nothing to repaint',
            })
            return
          }
          plan = res.kind === 'lossless' ? res.plan : fidelity === 'standard' ? res.standard : res.full
          planQuote = quotePlan(plan.chunks, tileMap, config, Math.floor(Date.now() / 1000))
        }

        const referrer =
          referrerRaw && isValidSolanaAddress(referrerRaw)
            ? new PublicKey(referrerRaw)
            : sharedReferrer

        // Instruction groups, one per eventual transaction. Deps (tile
        // inits + link registration) must land before any paint; paints
        // are mutually independent. Materialized below as v0 when the
        // cluster's lookup tables are loaded (the profile the plan was
        // chunked against), else legacy.
        const depGroups: TransactionInstruction[][] = []
        const paintGroups: TransactionInstruction[][] = []

        // 1. Missing tiles: vault reimburses rent when funded; the
        //    painter opts into bearing it (bear_rent) when it can't.
        const tileCoords = new Map<string, { tx: number; ty: number }>()
        for (const c of plan.chunks) {
          for (let ty = Math.floor(c.y / 20); ty <= Math.floor((c.y + c.h - 1) / 20); ty++) {
            for (let tx = Math.floor(c.x / 20); tx <= Math.floor((c.x + c.w - 1) / 20); tx++) {
              tileCoords.set(tileKey(tx, ty), { tx, ty })
            }
          }
        }
        const coords = [...tileCoords.values()]
        const infos = await conn.getMultipleAccountsInfo(
          coords.map((c) => tilePda(c.tx, c.ty)),
        )
        const missing = coords.filter((_, i) => infos[i] === null)
        if (missing.length > 0) {
          const tileRent = BigInt(
            await conn.getMinimumBalanceForRentExemption(TILE_ACCOUNT_SIZE),
          )
          const vaultBalance = BigInt(await conn.getBalance(vaultPda()))
          const bearRent = vaultBalance < tileRent * BigInt(missing.length) + 1_000_000n
          for (let i = 0; i < missing.length; i += 6) {
            depGroups.push(
              missing.slice(i, i + 6).map((m) => buildInitTileIx(painter, m.tx, m.ty, bearRent)),
            )
          }
        }

        // 2. Link: reuse a registered id via the hash index, else
        //    register as link_count + 1 (read fresh to avoid staleness).
        let linkId = 0
        if (linkUrl !== '') {
          const urlHash = new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(linkUrl)),
          )
          const existing = await conn.getAccountInfo(linkHashPda(urlHash))
          if (existing) {
            linkId = decodeLinkHash(existing.data).linkId
          } else {
            const freshConfig = await conn.getAccountInfo(canvasPda())
            if (!freshConfig) throw new Error('canvas config unreadable')
            linkId = decodeCanvasConfig(freshConfig.data).linkCount + 1
            depGroups.push([buildRegisterLinkIx(painter, linkId, linkUrl, urlHash)])
          }
        }

        // 3. One transaction per chunk, slippage-capped per chunk with
        //    the chosen reserve multiplier applied.
        for (let i = 0; i < plan.chunks.length; i++) {
          const chunkCost = (planQuote.perChunk[i] * reserveMultiplierBps) / 10_000n
          paintGroups.push([
            computeBudgetIx(),
            buildPaintIx(plan.chunks[i], {
              painter,
              treasury: config.treasury,
              linkId,
              metadataHash: new Uint8Array(32),
              maxTotalCost: withSlippage(chunkCost) + 1n,
              reserveMultiplierBps,
              referrer,
            }),
          ])
        }

        const tables = wireProfile === WIRE_V0_ALT ? (altTables ?? []) : []
        type Blockhash = { blockhash: string; lastValidBlockHeight: number }
        const materialize = (ixs: TransactionInstruction[], bh: Blockhash) => {
          if (tables.length > 0) return buildV0Transaction(ixs, painter, bh.blockhash, tables)
          const tx = new Transaction().add(...ixs)
          tx.feePayer = painter
          tx.recentBlockhash = bh.blockhash
          return tx
        }

        const total = depGroups.length + paintGroups.length
        let done = 0
        const sendOne = async (
          tx: Transaction | VersionedTransaction,
          bh: Blockhash,
        ) => {
          const sig = await conn.sendRawTransaction(tx.serialize())
          await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
          done++
          setPhase({ step: 'sending', done, total })
          return sig
        }

        // TWO signing phases when the stamp needs new tiles. Wallets
        // simulate each transaction against current chain state, so a
        // paint signed alongside the init that creates its tile fails
        // simulation and triggers a scary blocked-request screen
        // (observed in Phantom on devnet). Deps therefore sign + land
        // first; the paints then simulate cleanly in a second popup.
        // Stamps on existing tiles keep the single-popup flow.
        const signatures: string[] = []
        if (depGroups.length > 0) {
          const depBh: Blockhash = await conn.getLatestBlockhash()
          const depTxs = depGroups.map((g) => materialize(g, depBh))
          setPhase({ step: 'signing', txCount: depTxs.length })
          const signedDeps = await wallet.signAllTransactions(depTxs)
          setPhase({ step: 'sending', done, total })
          for (const tx of signedDeps) signatures.push(await sendOne(tx, depBh))
        }

        // Paints go out IN PARALLEL since each touches disjoint state,
        // collapsing an n-chunk stamp's wait to one confirmation.
        const paintBh: Blockhash = await conn.getLatestBlockhash()
        const paintTxs = paintGroups.map((g) => materialize(g, paintBh))
        setPhase({ step: 'signing', txCount: paintTxs.length })
        const signedPaints = await wallet.signAllTransactions(paintTxs)
        setPhase({ step: 'sending', done, total })
        const settled = await Promise.allSettled(
          signedPaints.map((tx) => sendOne(tx, paintBh)),
        )
        const failures: string[] = []
        for (const r of settled) {
          if (r.status === 'fulfilled') signatures.push(r.value)
          else failures.push((r.reason as Error)?.message ?? String(r.reason))
        }
        if (failures.length > 0) {
          throw new Error(
            `${failures.length} of ${signedPaints.length} paint transactions failed ` +
              `(${signatures.length - depGroups.length} landed; "retry, skip unchanged" ` +
              `repaints only what's missing): ${failures[0]}`,
          )
        }

        setPhase({ step: 'success', signatures })
        paint.clear()
        refetch()
      } catch (e) {
        const raw = (e as Error).message ?? String(e)
        // A transaction is only valid ~60-90s after its blockhash; a
        // long pause inside the wallet popup expires the whole batch.
        // Expired transactions never execute, so nothing was charged.
        const message = raw.includes('Blockhash not found')
          ? 'wallet approval took too long and the transactions expired ' +
            'before sending. Nothing was charged; submit again and ' +
            'approve within a minute.'
          : raw
        setPhase({ step: 'error', message })
      }
    },
    [wallet, selectedPlan, config, quote, draft, paint, refetch, tileMap, fidelity, sharedReferrer, wireProfile, altTables],
  )

  /* ------------------------------ render ----------------------------- */

  const bounds = draft ? { x: draft.x, y: draft.y, w: draft.w, h: draft.h } : null

  // PaintControls phase mapping (its EVM vocabulary).
  const submitStatus =
    phase.step === 'preparing' || phase.step === 'signing'
      ? ('pending' as const)
      : phase.step === 'sending'
        ? ('confirming' as const)
        : phase.step === 'success'
          ? ('success' as const)
          : phase.step === 'error'
            ? ('error' as const)
            : ('idle' as const)

  const zoomIn = useCallback(() => setZoom((z) => Math.min(16, z * 2)), [])
  const zoomOut = useCallback(() => setZoom((z) => Math.max(1, z / 2)), [])
  const zoomReset = useCallback(() => setZoom(1), [])

  return (
    <>
      <CompetitionBanner />
      <LeaderboardTicker
        regions={regions}
        nativeSymbol="SOL"
        onRequestOutbound={setOutboundUrl}
        linkUrlsOverride={linkUrls}
      />
      {error && <p className="sol-error">canvas load failed: {error}</p>}
      <div className="canvas-wrap">
        <div className="canvas-col">
          <div data-mobile-panel="paint" className="mobile-panel-wrap">
            <PaintControls
              draft={draft}
              error={paint.error}
              pixelCount={paint.pixelCount}
              maxPixelsPerTx={MAX_PIXELS_PER_TX}
              maxStampSide={MAX_STAMP_SIDE}
              maxWidth={paint.maxWidth}
              onLoad={paint.load}
              onResize={paint.resize}
              onClear={paint.clear}
              quoteTotal={quote ? quote.total * LAMPORTS_TO_DISPLAY : null}
              quoteLoading={!!draft && !quote && !error}
              quoteError={
                !!draft && !quote && error
                  ? 'canvas state unavailable (RPC busy), retrying'
                  : null
              }
              canSubmit={canPaint}
              submitStatus={submitStatus}
              submitError={phase.step === 'error' ? phase.message : null}
              batchProgress={
                phase.step === 'sending'
                  ? { done: phase.done, total: phase.total }
                  : null
              }
              nativeSymbol="SOL"
              chainId={SOLANA_PSEUDO_CHAIN_ID}
              defaultReferrer={sharedReferrer?.toBase58()}
              referrerValidator={isValidSolanaAddress}
              referrerPlaceholder="referrer Solana address (optional)"
              onSubmit={async (args) => {
                // value/maxTotalCost arrive in the 1e9 display scale;
                // the submit flow re-quotes per chunk in lamports with
                // its own slippage caps, so only link, multiplier,
                // referrer and the retry mask are taken from the form.
                await submit(
                  args.link,
                  args.reserveMultiplierBps,
                  args.referrerRaw,
                  args.skipUnchanged,
                )
              }}
              disabledReason={
                !wallet.publicKey
                  ? wallet.available
                    ? 'Connect your Solana wallet (top bar) to paint.'
                    : 'Install a Solana wallet (Phantom, Solflare, MetaMask) to paint.'
                  : undefined
              }
              regions={regions}
              canvasWidth={SOLANA_CANVAS_WIDTH}
              canvasHeight={SOLANA_CANVAS_HEIGHT}
              chunkCountOverride={
                selectedPlan ? selectedPlan.chunks.length + initTxCount : null
              }
              zoom={zoom}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onZoomReset={zoomReset}
              onRefresh={refetch}
              refreshing={isLoading}
            />
            {/* Fidelity choice: only rendered when the stamp exceeds
                255 colors, previewing the EXACT decoded bytes of each
                plan. Lossless stamps never show this. */}
            {encoded?.kind === 'choice' && bounds && (
              <div className="sol-plan-row">
                <PlanPreview
                  plan={encoded.standard}
                  bounds={bounds}
                  label="Standard"
                  txs={encoded.standard.chunks.length + initTxCount}
                  selected={fidelity === 'standard'}
                  onSelect={() => setFidelity('standard')}
                />
                <PlanPreview
                  plan={encoded.full}
                  bounds={bounds}
                  label="Full color"
                  txs={encoded.full.chunks.length + initTxCount}
                  selected={fidelity === 'full'}
                  onSelect={() => setFidelity('full')}
                />
              </div>
            )}
            {phase.step === 'success' && (
              <p className="sol-success">
                painted in {phase.signatures.length} tx
                {phase.signatures.length === 1 ? '' : 's'} ·{' '}
                <a
                  href={`https://explorer.solana.com/tx/${phase.signatures[phase.signatures.length - 1]}${SOLANA_EXPLORER_SUFFIX}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  last tx ↗
                </a>
              </p>
            )}
          </div>

          <SolanaCanvasView
            tiles={tiles}
            tileMap={tileMap}
            config={config}
            draft={draft}
            onDraftMove={paint.moveTo}
            onDraftResize={paint.resizeAt}
            onRequestOutbound={setOutboundUrl}
            resolveLink={(id) => linkUrls.get(id)}
            onRefresh={refetch}
            refreshing={isLoading}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        </div>
      </div>

      <div className="activity-dock" data-mobile-panel="activity">
        <Leaderboard
          regions={regions}
          nativeSymbol="SOL"
          chainId={SOLANA_PSEUDO_CHAIN_ID}
          onRequestOutbound={setOutboundUrl}
          linkUrlsOverride={linkUrls}
        />
        <ActivityFeed
          regions={regions}
          isLoading={regionsLoading}
          startingPrice={config ? config.startingPrice * LAMPORTS_TO_DISPLAY : null}
          nativeSymbol="SOL"
          onRequestOutbound={setOutboundUrl}
          linkUrlsOverride={linkUrls}
        />
      </div>

      <SolanaStatsCards
        config={config}
        paintedPixels={paintedPixels}
        vaultLamports={vaultLamports}
      />

      <OutboundLinkModal url={outboundUrl} onClose={() => setOutboundUrl(null)} />
    </>
  )
}
