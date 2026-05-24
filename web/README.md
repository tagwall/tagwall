# Tagwall Reference Frontend

Vite + React + TypeScript + wagmi/viem. The canonical client served at
`tagwall.io` post-launch; also the reference implementation that mirrors
and embeds build on.

## What's in v0 (this commit)

- Wagmi providers wired for all 4 supported chains (PulseChain mainnet +
  testnet, Ethereum mainnet, Base mainnet) with an `injected` connector
  that picks up MetaMask.
- Connect bar with chain switcher and address display.
- Canvas header reads: `width`, `height`, `startingPrice`, `treasury`,
  `freezePeriod`, `decayPerMonthBps`, `stampCount` from the Canvas
  contract via `useReadContracts`.
- 1000×1000 render target (HTML canvas) with major gridlines every 100px.
  Pixel-level rendering from chain state is next.
- Coordinate readout on mouse hover and a sticky pixel-info panel with
  placeholders for the per-pixel data.
- Graceful "Canvas not deployed on chain N" message when reads fail
  (hits any chain where `CANVAS_ADDRESS` has no code, including during
  pre-deploy development).

## What's next, in rough priority order

1. **Per-pixel read + render.** `pixelAt(x,y)` via `useReadContract`,
   drawn via `ctx.fillRect` on hover. Batch reads for a region once we
   wire `quote()` for the cost panel.
2. **Upload + quantize + drag-position UI.** Image picker, per-pixel
   24-bit RGB quantization, drag to position, drag corners to resize.
3. **Paint flow.** `paint(...)` with `maxTotalCost` slippage, retry on
   overpainting, revert-reason decoder mapping each custom error to a
   friendly message.
4. **Pixel info panel.** Color + link + replace-price (PRD §6: no
   history shown).
5. **Reserve-multiplier slider.** 1x-100x (the contract cap), shows
   approximate duration the multiplier reserves against decay.
6. **Activity feed.** `Painted` event log via `useWatchContractEvent`;
   big stamps, hot regions, reserved paints highlighted.
7. **Embed iframe.** `/embed?x&y&w&h&ref=` with auto-propagating referrer.
8. **Stats page.** `/stats` reads directly from chain.
9. **Client-side filter** (gated on legal). Loads a signed JSON block
   list and renders those rectangles as black. Empty list by default.

Per PLAN.md, only items 9 + public deploy + TOS page are gated on the
Singapore legal consult; everything else can ship early.

## Dev

```bash
npm install
npm run dev    # vite dev server on :5173
npm run build  # tsc + vite build
npm run lint   # eslint
```

## Canvas address

`CANVAS_ADDRESS` in `src/contracts/canvas.ts` is hardcoded to the current
CREATE2-predicted address (`0x3c7FC0d2A425C744854f15567F9Dfec45351E68e`)
for the placeholder-treasury build of `Canvas.sol`. When real
hardware-wallet EOA addresses replace the placeholders in
`contracts/src/Canvas.sol` (PRD decision 53), the init-code hash changes
and this constant moves. See `contracts/script/README.md > Deploy-day
protocol` for the sequencing.

For local anvil development, deploy Canvas via:

```bash
cd ../contracts
anvil --chain-id 31337 &
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
```

The resulting address matches `CANVAS_ADDRESS` because anvil is chainid
31337 and the CREATE2 salt is constant.
