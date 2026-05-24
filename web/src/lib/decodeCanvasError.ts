import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  formatEther,
} from 'viem'

/**
 * Result of attempting to decode an error thrown by a Canvas write call.
 *
 * - `name` is the custom error name when the revert matches an ABI entry.
 * - `friendly` is the human-grade sentence shown to the user. Always set.
 * - `raw` is the underlying error message, useful for debug / logging.
 */
export interface DecodedCanvasError {
  name?: string
  args?: readonly unknown[]
  friendly: string
  raw: string
}

/** Format a native-wei amount for display. */
function fmt(v: unknown): string {
  if (typeof v !== 'bigint') return String(v)
  return `${formatEther(v)} native`
}

/**
 * Decode an error thrown by a Canvas write (paint) call into something the UI
 * can render directly. Handles three layers:
 *
 * 1. User rejected in wallet (MetaMask "reject" button).
 * 2. Contract-level revert with a known custom error (PriceAboveMax,
 *    MaxPixelsExceeded, etc.). We map these to sentences that tell the user
 *    what to do about it.
 * 3. Anything else (RPC timeout, insufficient funds, network hiccup).
 */
export function decodeCanvasError(err: unknown): DecodedCanvasError {
  const raw = err instanceof Error ? err.message : String(err)

  if (!(err instanceof BaseError)) {
    return { friendly: raw, raw }
  }

  // User rejected in wallet. Short message like "User rejected the request."
  // is what we want; fall through to BaseError's shortMessage.
  const rejected = err.walk((e) => e instanceof UserRejectedRequestError)
  if (rejected) {
    return { friendly: 'You rejected the transaction in your wallet.', raw }
  }

  // Contract-level custom error.
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | null
  if (revert && revert.data) {
    const name = revert.data.errorName
    const args = revert.data.args
    return { name, args, friendly: friendlyFor(name, args) ?? err.shortMessage, raw }
  }

  // Non-contract failure. Use viem's shortMessage which trims stack noise.
  return { friendly: err.shortMessage || raw, raw }
}

function friendlyFor(name: string | undefined, args: readonly unknown[] | undefined): string | null {
  switch (name) {
    case 'OutOfBounds':
      return 'Stamp extends past the canvas edge. Drag it back inside.'

    case 'InvalidStamp':
      return 'Stamp width/height must be positive and the pixel array has to match. Re-upload the image.'

    case 'MaxPixelsExceeded': {
      const [attempted, cap] = (args ?? [0n, 0n]) as [bigint, bigint]
      return `Stamp has ${attempted} pixels; the per-transaction cap is ${cap}. Shrink the stamp and retry.`
    }

    case 'InvalidColor':
      return 'A pixel has a color value the contract won\'t accept. Re-upload the image.'

    case 'InvalidLink':
      return 'Link must start with "https://" and be between 9 and 256 bytes. Fix the link field and retry.'

    case 'PriceAboveMax': {
      const [quoted, max] = (args ?? [0n, 0n]) as [bigint, bigint]
      return `Someone painted here between your quote and submit. New cost is ${fmt(quoted)} but you capped at ${fmt(max)}. Re-quote and retry.`
    }

    case 'InsufficientPayment': {
      const [quoted, sent] = (args ?? [0n, 0n]) as [bigint, bigint]
      return `Wallet sent ${fmt(sent)} but the canvas needed ${fmt(quoted)}. Try again; the slippage buffer usually covers this.`
    }

    case 'EmptyStamp':
      return 'Every pixel in your stamp is transparent. There is nothing to paint.'

    case 'PriceOverflow':
      return 'A pixel in this region has been overwritten so many times that further overwrites would overflow. Pick a different region.'

    case 'InvalidReserveMultiplier':
      return 'Reserve multiplier must be between 1x and 100x (10000-1000000 bps).'

    case 'TimestampOverflow':
      return 'Block timestamp exceeded uint40. Defensive guard; not expected to trigger before year 36,812.'

    case 'UnsupportedChain': {
      const [cid] = (args ?? [0n]) as [bigint]
      return `Canvas is not configured for chain id ${cid}. Switch to a supported chain.`
    }

    case 'LinkRegistryFull':
      return 'The link registry is full (2^32 unique URLs). Use an existing URL or contact the operator.'

    default:
      return null
  }
}
