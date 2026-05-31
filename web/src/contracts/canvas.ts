/**
 * Canvas contract integration.
 *
 * Address is the CREATE2-predicted address from Deploy.s.sol with salt
 * keccak256("tagwall.canvas.v1") and Arachnid's deterministic deployment
 * proxy. Identical on every supported chain because Canvas has an argless
 * constructor and chainid dispatch (contracts/script/README.md).
 */
import type { Address } from 'viem'

// Two Canvas builds exist, at two CREATE2 addresses:
//
//   v1   (0xd58D…6415) — the original 4-chain build: PulseChain, Ethereum,
//        Base, BSC + PulseChain v4 testnet. Deployed Day-0, immutable.
//   v1.1 (0xbe68…C5A4) — adds the HyperEVM (chain 999) branch to the
//        constructor's chainid dispatch and bumps version() to
//        "tagwall.canvas.v1.1". The extra branch shifts the init-code hash,
//        so CREATE2 lands at a different address. This is the build used on
//        HyperEVM and on any fresh local/anvil deploy (which compiles from
//        current source).
//
// The salt is unchanged (keccak256("tagwall.canvas.v1")); the address moves
// only because the init code changed. The four live mainnets + testnet stay
// at v1 forever (immutable). Resolve the right address per connected chain
// via canvasAddress(chainId) — there is intentionally no single CANVAS_ADDRESS
// constant, so every on-chain call site must pass the chain it's reading.
//
// (evm_version stays shanghai, not prague, so the auto-getter for the dynamic
// `links` array doesn't emit MCOPY, which PulseChain v4 testnet rejects.)
export const CANVAS_ADDRESS_V1: Address =
  '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415'
export const CANVAS_ADDRESS_V1_1: Address =
  '0xbe682DB4c67F723Ad52a2f7Ba7Bc982C8BBDC5A4'

const ADDRESS_BY_CHAIN: Record<number, Address> = {
  369: CANVAS_ADDRESS_V1, // PulseChain mainnet
  1: CANVAS_ADDRESS_V1, // Ethereum
  8453: CANVAS_ADDRESS_V1, // Base
  56: CANVAS_ADDRESS_V1, // BSC
  943: CANVAS_ADDRESS_V1, // PulseChain v4 testnet
  999: CANVAS_ADDRESS_V1_1, // HyperEVM
  31337: CANVAS_ADDRESS_V1_1, // local anvil (fresh build = v1.1)
  1337: CANVAS_ADDRESS_V1_1, // local hardhat
}

/**
 * Canvas contract address for the connected chain. Defaults to the live v1
 * address for unknown/undefined chains so a wallet on an unexpected network
 * still points at the canonical deployment rather than a dead address.
 */
export function canvasAddress(chainId: number | undefined): Address {
  if (chainId === undefined) return CANVAS_ADDRESS_V1
  return ADDRESS_BY_CHAIN[chainId] ?? CANVAS_ADDRESS_V1
}

// Read-only ABI subset. Paint + write methods land in a later commit when
// the upload/quantize/submit flow is wired up.
export const canvasAbi = [
  { type: 'function', name: 'width',          stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'height',         stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'startingPrice',  stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'treasury',       stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'freezePeriod',   stateMutability: 'view', inputs: [], outputs: [{ type: 'uint40' }] },
  { type: 'function', name: 'decayPerMonthBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'maxPixelsPerTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'stampCount',     stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'linkCount',      stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'pixelAt',
    stateMutability: 'view',
    inputs: [{ name: 'x', type: 'uint32' }, { name: 'y', type: 'uint32' }],
    outputs: [
      { name: 'color', type: 'uint24' },
      { name: 'lastPrice', type: 'uint256' },
      { name: 'linkId', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'view',
    inputs: [
      { name: 'x', type: 'uint32' },
      { name: 'y', type: 'uint32' },
      { name: 'w', type: 'uint32' },
      { name: 'h', type: 'uint32' },
    ],
    outputs: [
      { name: 'total', type: 'uint256' },
      { name: 'pixelsAffected', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'splitBps',
    stateMutability: 'pure',
    inputs: [],
    outputs: [
      { name: 'burn', type: 'uint256' },
      { name: 'referral', type: 'uint256' },
      { name: 'treasuryMin', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'links',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  // The one write method on Canvas. All paints go through this.
  {
    type: 'function',
    name: 'paint',
    stateMutability: 'payable',
    inputs: [
      { name: 'x', type: 'uint32' },
      { name: 'y', type: 'uint32' },
      { name: 'w', type: 'uint32' },
      { name: 'h', type: 'uint32' },
      { name: 'colors', type: 'uint32[]' },
      { name: 'link', type: 'string' },
      { name: 'referrer', type: 'address' },
      { name: 'metadataHash', type: 'bytes32' },
      { name: 'maxTotalCost', type: 'uint256' },
      { name: 'reserveMultiplierBps', type: 'uint256' },
    ],
    outputs: [],
  },
  // Painted(painter, referrer, metadataHash indexed; x, y, w, h, pixelsPainted, pricePaid, linkId)
  {
    type: 'event',
    name: 'Painted',
    inputs: [
      { name: 'painter', type: 'address', indexed: true },
      { name: 'referrer', type: 'address', indexed: true },
      { name: 'metadataHash', type: 'bytes32', indexed: true },
      { name: 'x', type: 'uint32', indexed: false },
      { name: 'y', type: 'uint32', indexed: false },
      { name: 'w', type: 'uint32', indexed: false },
      { name: 'h', type: 'uint32', indexed: false },
      { name: 'pixelsPainted', type: 'uint32', indexed: false },
      { name: 'pricePaid', type: 'uint256', indexed: false },
      { name: 'linkId', type: 'uint32', indexed: false },
    ],
  },
  // Canvas custom errors. Needed in the ABI so viem can decode revert data
  // into (name, args) for the frontend decoder. Mirrors errors.sol.
  { type: 'error', name: 'OutOfBounds', inputs: [] },
  { type: 'error', name: 'InvalidStamp', inputs: [] },
  { type: 'error', name: 'MaxPixelsExceeded', inputs: [
    { name: 'attempted', type: 'uint256' },
    { name: 'cap', type: 'uint256' },
  ]},
  { type: 'error', name: 'InvalidColor', inputs: [{ name: 'value', type: 'uint32' }] },
  { type: 'error', name: 'InvalidLink', inputs: [] },
  { type: 'error', name: 'PriceAboveMax', inputs: [
    { name: 'quoted', type: 'uint256' },
    { name: 'max', type: 'uint256' },
  ]},
  { type: 'error', name: 'InsufficientPayment', inputs: [
    { name: 'quoted', type: 'uint256' },
    { name: 'sent', type: 'uint256' },
  ]},
  { type: 'error', name: 'EmptyStamp', inputs: [] },
  { type: 'error', name: 'PriceOverflow', inputs: [] },
  { type: 'error', name: 'InvalidReserveMultiplier', inputs: [
    { name: 'multiplierBps', type: 'uint256' },
  ]},
  { type: 'error', name: 'TimestampOverflow', inputs: [] },
  { type: 'error', name: 'UnsupportedChain', inputs: [{ name: 'chainid', type: 'uint256' }] },
  { type: 'error', name: 'LinkRegistryFull', inputs: [] },
] as const
