/**
 * Canvas contract integration.
 *
 * Address is the CREATE2-predicted address from Deploy.s.sol with salt
 * keccak256("tagwall.canvas.v1") and Arachnid's deterministic deployment
 * proxy. Identical on every supported chain because Canvas has an argless
 * constructor and chainid dispatch (contracts/script/README.md).
 */
import type { Address } from 'viem'

// Real-treasury + version() CREATE2 address for the 1250x800 canvas with
// maxPixelsPerTx=1500 (PRD v3.2+, decision 50). Init code embeds the
// operator hardware-wallet EOA as the treasury on every chain (PRD
// decision 57, supersedes per-chain decision 53). version() view added
// 2026-05-17 to give a future frontend a clean way to discriminate
// this v1 from any hypothetical future v2 deployment at a different
// CREATE2 address (returns bytes32("tagwall.canvas.v1")). The
// version() addition shifted the init-code hash, moving the CREATE2
// predicted address from 0xf75aA027333Af16E0210edd2d86c9b2889fE09DB
// to the value below. evm_version pinned to shanghai (was prague) so
// the auto-getter for the dynamic `links` array doesn't emit MCOPY,
// which PulseChain v4 testnet rejects with `invalid opcode: MCOPY`.
export const CANVAS_ADDRESS: Address =
  '0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415'

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
