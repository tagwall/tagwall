import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeAll, describe, expect, it } from 'vitest'

// Local anvil deploys the current source = the v1.1 build (adds chain 999),
// which lands at CANVAS_ADDRESS_V1_1. Alias it so the rest of the test reads
// naturally.
import { CANVAS_ADDRESS_V1_1 as CANVAS_ADDRESS, canvasAbi } from '../src/contracts/canvas'
import { chunkDraft } from '../src/lib/chunkDraft'
import { allocateChunkFunding, chunkCostWeights } from '../src/lib/chunkFunding'
import type { PaintDraft } from '../src/hooks/usePaintDraft'

/**
 * End-to-end proof of the multi-chunk funding fix against a real Canvas on a
 * local anvil. Unlike a Solidity Foundry test (which would re-derive the
 * weights in Solidity and pass even on the OLD buggy frontend), this exercises
 * the SHIPPING TypeScript path: the live `chunkCostWeights` multicall and the
 * `allocateChunkFunding` split that usePaintSubmitBatch uses verbatim.
 *
 * Prereq: a local anvil with Canvas + Multicall3 deployed. The repo's
 * `scripts/seed-local.sh` does exactly that (and the `test:anvil` npm script
 * runs it first). If no such chain is reachable, every test here self-skips so
 * `vitest run` stays green in CI without a node.
 *
 * Scenario: paint a stamp that chunks into a large FRESH top band and a small,
 * heavily-overwritten (expensive) bottom band. Pixel-count weighting (the bug)
 * starves the bottom band; cost weighting funds it correctly.
 */

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
// Anvil's first default dev key (public, ephemeral-chain-only; 10000 ETH).
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const account = privateKeyToAccount(DEV_KEY)

const anvil = defineChain({
  id: 31337,
  name: 'Anvil (test)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: MULTICALL3 } },
})

const publicClient: PublicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
const walletClient: WalletClient = createWalletClient({ account, chain: anvil, transport: http(RPC) })

// Fresh test region, clear of every seed paint in SeedPaints.s.sol.
const X0 = 300
const Y0 = 400
const W = 40
const H = 40 // 1600 px → two bands at cap 1500: 40x37 (1480) + 40x3 (120)
const MAX_PX = 1500
const NEW_COLOR = 0x3366ff
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const
const BPS = 10_000n

let ready = false

async function hasCode(address: `0x${string}`): Promise<boolean> {
  try {
    const code = await publicClient.getCode({ address })
    return !!code && code !== '0x'
  } catch {
    return false
  }
}

function makeDraft(): PaintDraft {
  return {
    name: 'test',
    sourceW: W,
    sourceH: H,
    w: W,
    h: H,
    x: X0,
    y: Y0,
    colors: new Array(W * H).fill(NEW_COLOR),
    thumbUrl: '',
  }
}

async function quoteTotal(x: number, y: number, w: number, h: number): Promise<bigint> {
  const res = (await publicClient.readContract({
    address: CANVAS_ADDRESS,
    abi: canvasAbi,
    functionName: 'quote',
    args: [x, y, w, h],
  })) as readonly [bigint, number]
  return res[0]
}

async function paint(args: {
  x: number
  y: number
  w: number
  h: number
  colors: number[]
  value: bigint
  maxTotalCost: bigint
  reserveBps: bigint
}): Promise<'success' | 'reverted'> {
  const hash = await walletClient.writeContract({
    account,
    chain: anvil,
    address: CANVAS_ADDRESS,
    abi: canvasAbi,
    functionName: 'paint',
    args: [
      args.x,
      args.y,
      args.w,
      args.h,
      args.colors,
      '',
      ZERO_ADDR,
      ZERO_HASH,
      args.maxTotalCost,
      args.reserveBps,
    ],
    value: args.value,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  return receipt.status
}

beforeAll(async () => {
  const chainOk = await publicClient.getChainId().then(() => true).catch(() => false)
  ready = chainOk && (await hasCode(CANVAS_ADDRESS)) && (await hasCode(MULTICALL3))
  if (!ready) {
    console.warn(
      `\n[anvil suite skipped] No ready chain at ${RPC} ` +
        `(need Canvas @ ${CANVAS_ADDRESS} + Multicall3). ` +
        'Run `npm run test:anvil` (which boots scripts/seed-local.sh first).\n',
    )
  }
})

describe('multi-chunk funding against a live Canvas', () => {
  it('cost-weighted allocation lands every chunk; pixel-count weighting would not', async (ctx) => {
    if (!ready) return ctx.skip()

    const draft = makeDraft()
    const chunks = chunkDraft(draft, MAX_PX)
    expect(chunks.length).toBe(2)
    const bottom = chunks[chunks.length - 1]

    // 1) Inflate the small bottom band so it costs far more PER PIXEL than the
    //    fresh top band. Idempotent across re-runs: only inflate when it isn't
    //    already hot, so repeated runs don't compound the price into overflow.
    const bottomPerPixel = (await quoteTotal(bottom.x, bottom.y, bottom.w, bottom.h)) / BigInt(bottom.pixels)
    const topPerPixel = (await quoteTotal(X0, Y0, W, 1)) / BigInt(W)
    if (bottomPerPixel < 5n * topPerPixel) {
      const base = await quoteTotal(bottom.x, bottom.y, bottom.w, bottom.h)
      const status = await paint({
        x: bottom.x,
        y: bottom.y,
        w: bottom.w,
        h: bottom.h,
        colors: new Array(bottom.pixels).fill(0x112233),
        // reserve 30x → pricePaid ≈ base*30; pad maxTotalCost/value to 31x.
        value: base * 31n,
        maxTotalCost: base * 31n,
        reserveBps: 30n * BPS,
      })
      expect(status, 'pre-paint of hot band').toBe('success')
    }

    // 2) Confirm the heterogeneity the bug needs: bottom now far pricier/px.
    const hotBottomPerPixel =
      (await quoteTotal(bottom.x, bottom.y, bottom.w, bottom.h)) / BigInt(bottom.pixels)
    expect(hotBottomPerPixel).toBeGreaterThan(5n * topPerPixel)

    // 3) Per-chunk quotes the SHIPPING code sees: live multicall weighting.
    const weights = await chunkCostWeights(publicClient, chunks, CANVAS_ADDRESS)
    // Cross-check the multicall weights against individual quote() reads:
    // proves chunkCostWeights returns each chunk's real quote, in order.
    const individual: bigint[] = []
    for (const c of chunks) individual.push(await quoteTotal(c.x, c.y, c.w, c.h))
    expect(weights).toEqual(individual)

    const sumQuotes = individual.reduce((s, q) => s + q, 0n)
    const approvedTotal = (sumQuotes * 11n) / 10n // frontend's 10% slippage buffer

    // 4) The fix: allocate by cost weight. Assert each chunk's cap clears its
    //    real quote BEFORE we spend gas submitting.
    const funding = allocateChunkFunding({
      chunks,
      weights,
      value: approvedTotal,
      maxTotalCost: approvedTotal,
    })
    funding.forEach((f, i) => {
      expect(f.maxTotalCost, `chunk ${i} cap covers its quote`).toBeGreaterThanOrEqual(individual[i])
    })
    expect(funding.reduce((s, f) => s + f.value, 0n)).toBe(approvedTotal)

    // 5) Negative control: the OLD pixel-count weighting under-funds the hot
    //    bottom chunk → it would revert PriceAboveMax on-chain.
    const oldFunding = allocateChunkFunding({
      chunks,
      weights: chunks.map((c) => BigInt(c.pixels)),
      value: approvedTotal,
      maxTotalCost: approvedTotal,
    })
    expect(
      oldFunding[oldFunding.length - 1].maxTotalCost,
      'pixel-count weighting starves the hot chunk',
    ).toBeLessThan(individual[individual.length - 1])

    // 6) Actually submit every chunk with the cost-weighted funding and assert
    //    all land. This is the end-to-end win: the same paint the old code
    //    couldn't fund now confirms.
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const status = await paint({
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        colors: c.colors,
        value: funding[i].value,
        maxTotalCost: funding[i].maxTotalCost,
        reserveBps: BPS, // 1x: normal paint
      })
      expect(status, `chunk ${i} paint`).toBe('success')
    }

    // 7) The canvas reflects the new color in both bands.
    for (const [sx, sy] of [
      [X0, Y0], // top band
      [bottom.x, bottom.y], // bottom band
    ] as const) {
      const px = (await publicClient.readContract({
        address: CANVAS_ADDRESS,
        abi: canvasAbi,
        functionName: 'pixelAt',
        args: [sx, sy],
      })) as readonly [number, bigint, number]
      expect(px[0]).toBe(NEW_COLOR)
    }
  })
})
