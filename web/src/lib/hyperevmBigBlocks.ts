/**
 * HyperEVM (chain 999) "big blocks" guidance.
 *
 * HyperEVM produces two block types: small blocks (~1s, 3M gas) by default,
 * and big blocks (~1min, 30M gas) a wallet opts into. A paint over
 * SMALL_BLOCK_PIXEL_LIMIT pixels exceeds the 3M small-block limit and will not
 * be included until the painter has big blocks enabled.
 *
 * Enabling big blocks is a HyperCore action (`evmUserModify`,
 * usingBigBlocks=true), NOT an EVM transaction: it requires the wallet to have
 * a HyperCore account (move a little HYPE EVM->Core first), then a signed
 * action to the exchange API. The flag persists until unset, so it's one-time
 * setup. Most HyperEVM contract deployers already have it on, since deploying
 * a contract itself requires big blocks.
 *
 * v1 (this module) surfaces the requirement as guidance + a link to the
 * official Hyperliquid docs. A future enhancement can sign the evmUserModify
 * action in-app via a Hyperliquid SDK — deliberately deferred because the
 * signing can't be validated until deploy-time against a funded wallet, and
 * the SDK's exact browser-wallet API needs to be pinned down first.
 */

export const HYPEREVM_CHAIN_ID = 999

export function isHyperEVM(chainId: number | null | undefined): boolean {
  return chainId === HYPEREVM_CHAIN_ID
}

/**
 * A paint up to this many pixels fits a 3M small block. Above it the painter
 * needs big blocks. Derived from the gas model in chainCaps.ts:
 * floor((3,000,000 - 341,601 fixed overhead) / 23,695 gas-per-pixel) ~= 112;
 * rounded down to 110 for a little margin. This is the threshold for *nudging*
 * the user, not an on-chain cap.
 */
export const SMALL_BLOCK_PIXEL_LIMIT = 110

/**
 * Official Hyperliquid docs for the dual-block model (verified URL). Used as
 * the "how to enable big blocks" link. Intentionally NOT a third-party
 * block-toggle tool (phishing/squatting risk) or a guessed app deep link.
 */
export const HYPEREVM_BIG_BLOCKS_DOC_URL =
  'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture'

/** True when a paint of `pixelCount` on `chainId` needs big blocks enabled. */
export function needsBigBlocks(chainId: number | null | undefined, pixelCount: number): boolean {
  return isHyperEVM(chainId) && pixelCount > SMALL_BLOCK_PIXEL_LIMIT
}
