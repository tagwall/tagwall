/**
 * Paginated `eth_getLogs` over a [fromBlock, toBlock] range.
 *
 * Public RPCs commonly cap the per-request block range at 10,000 blocks
 * (Alchemy, Infura free tier) or even 5,000 (Ankr, some PulseChain
 * gateways). A single getLogs call that walks from genesis to head
 * silently fails on any of these. This helper splits the range into
 * chunks small enough to fit the strictest caps and stitches results
 * back together in caller order.
 *
 * On a per-chunk failure the helper halves the chunk size and retries
 * up to MIN_CHUNK; if even MIN_CHUNK fails the chunk is dropped and a
 * warning is logged, so the rest of the scan still returns useful
 * data. The alternative — failing the whole fetch on a single bad
 * chunk — leaves the canvas blank on a transient RPC blip.
 */

import type { Abi, AbiEvent, Address, GetLogsReturnType } from 'viem'

/**
 * Structural subset of viem's PublicClient that this helper actually
 * uses. Keeps the helper compatible with wagmi's extended client (which
 * is structurally compatible but nominally a different type after the
 * Optimism / OP-Stack extensions land in the type graph) without a cast.
 */
export interface GetLogsClient {
  getLogs: (args: {
    address: Address
    event: AbiEvent
    fromBlock: bigint
    toBlock: bigint
  }) => Promise<readonly unknown[]>
}

/**
 * Default per-chunk block range. 9_500 instead of 10_000 because some
 * gateways (Alchemy historical) treat the cap as inclusive-exclusive
 * inconsistently and reject exactly-10k.
 */
const DEFAULT_CHUNK_SIZE = 9_500n

/** Smallest chunk the helper will try before giving up on a range. */
const MIN_CHUNK_SIZE = 500n

export interface PaginatedLogsArgs<E extends AbiEvent> {
  publicClient: GetLogsClient
  address: Address
  event: E
  fromBlock: bigint
  toBlock: bigint
  /**
   * Optional per-chunk size override. Use a smaller value (e.g. 2_000n)
   * on chains whose RPC providers cap below the default.
   */
  chunkSize?: bigint
}

/**
 * Fetch logs in paginated chunks. Returns logs in the order each chunk
 * returned them; the caller is responsible for sorting (Painted events
 * sort by (blockNumber, logIndex) in usePaintedRegions).
 */
export async function getLogsPaginated<E extends AbiEvent>(
  args: PaginatedLogsArgs<E>,
): Promise<GetLogsReturnType<E, [E], false>> {
  const { publicClient, address, event, fromBlock, toBlock } = args
  const initialChunk = args.chunkSize ?? DEFAULT_CHUNK_SIZE

  if (toBlock < fromBlock) {
    return [] as unknown as GetLogsReturnType<E, [E], false>
  }

  const out: unknown[] = []
  let cursor = fromBlock

  while (cursor <= toBlock) {
    // Try the current chunk size, halve on failure down to MIN_CHUNK_SIZE.
    let chunkSize = initialChunk
    let succeeded = false
    while (chunkSize >= MIN_CHUNK_SIZE) {
      const chunkEnd = cursor + chunkSize - 1n > toBlock ? toBlock : cursor + chunkSize - 1n
      try {
        const logs = await publicClient.getLogs({
          address,
          event,
          fromBlock: cursor,
          toBlock: chunkEnd,
        })
        out.push(...logs)
        cursor = chunkEnd + 1n
        succeeded = true
        break
      } catch (err) {
        // Halve the chunk and retry. Many provider errors here are
        // "range too large" or transient; halving usually clears the
        // first class without retries on the second.
        const next = chunkSize / 2n
        if (next < MIN_CHUNK_SIZE) {
          console.warn(
            `[paginatedLogs] dropping range [${cursor}, ${chunkEnd}] after exhausting retries`,
            err,
          )
          // Give up on this specific range, advance past it so we don't loop.
          cursor = chunkEnd + 1n
          break
        }
        chunkSize = next
      }
    }
    // If we exited the inner loop without success, the outer guard above
    // already advanced `cursor` past the failed range. Continue.
    if (!succeeded) continue
  }

  return out as GetLogsReturnType<E, [E], false>
}

// Re-export so a single import in usePaintedRegions covers the helper
// + the Abi types it usually wants. Not strictly required.
export type { Abi }
