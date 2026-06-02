#!/usr/bin/env python3
"""
Tagwall tweets bot.

Replaces the original auto-posting `twitter-paints` bot. X moved to a
paid pay-per-use API in Feb 2026 (~$0.20 per tweet because every
Tagwall tweet has a deep-link URL), so instead of posting from a bot
account we surface ready-to-post tweet copy on tagwall.io/tweets and
let the operator paste-and-post from @tagwall_io_bot by hand. The bot
itself is fully automated; only the final post-to-X step is manual.

Was called `manual-queue` through the May 2026 launch when the
automation around it didn't yet exist. Renamed once the rest of the
pipeline (cron, summaries, auto-publish, frontend page) was online.

Run on a 30-minute GitHub Actions cron. Each tick:
  1. Reads `state.json` for the last block scanned per chain.
  2. Queries each chain for new Painted events since then.
  3. Filters notable ones (>= TWEETS_MIN_PIXELS, default 100) into
     QUEUE.md (Markdown) and web/public/queue.json (consumed by the
     frontend).
  4. Computes a trailing-7-day per-chain summary into
     web/public/summary.json.
  5. Tracks distinct painters per chain from the deploy block (in
     founders_state.json) and emits founder scarcity + milestone tweet
     candidates into the same queue (W1/W2 marketing automation).
  6. Commits any changed files back to the public repo. CF Worker
     watches `web/**` and rebuilds tagwall.io on the next push.

Env (all optional; only CANVAS_ADDRESS is strictly required):
  CANVAS_ADDRESS         — CREATE2 address, identical on the four original
                           mainnets. HyperEVM (999) overrides this with its
                           own v1.1 address baked into the CHAINS table.
  PULSECHAIN_RPC_URL     — override for PulseChain (default rpc.pulsechain.com)
  ETHEREUM_RPC_URL       — override for Ethereum (default eth.drpc.org)
  BASE_RPC_URL           — override for Base (default base.publicnode.com)
  BSC_RPC_URL            — override for BSC (default bsc-dataseed.binance.org)
  HYPEREVM_RPC_URL       — override for HyperEVM (default hyperliquid.rpc.blxrbdn.com)
  TAGWALL_BASE_URL       — defaults to https://tagwall.io
  TWEETS_MIN_PIXELS      — defaults to 100 (alias: MANUAL_QUEUE_MIN_PIXELS)
  TWEETS_MAX_PER_RUN     — defaults to 50  (alias: MANUAL_QUEUE_MAX_PER_RUN)
  SKIP_SUMMARY           — '1' to skip the weekly summary scan
  SKIP_FOUNDERS          — '1' to skip the founder scarcity/milestone scan
  DRY_RUN                — '1' to scan-and-print without writing or pushing
"""
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from web3 import Web3
from web3.exceptions import ContractLogicError, Web3RPCError

PAINTED_EVENT_ABI = [{
    "type": "event",
    "name": "Painted",
    "anonymous": False,
    "inputs": [
        {"name": "painter",       "type": "address", "indexed": True},
        {"name": "referrer",      "type": "address", "indexed": True},
        {"name": "metadataHash",  "type": "bytes32", "indexed": True},
        {"name": "x",             "type": "uint32",  "indexed": False},
        {"name": "y",             "type": "uint32",  "indexed": False},
        {"name": "w",             "type": "uint32",  "indexed": False},
        {"name": "h",             "type": "uint32",  "indexed": False},
        {"name": "pixelsPainted", "type": "uint32",  "indexed": False},
        {"name": "pricePaid",     "type": "uint256", "indexed": False},
        {"name": "linkId",        "type": "uint32",  "indexed": False},
    ],
}]

# Per-chain floor price view used for overpaint detection and the
# weekly summary's "blank vs overpaint" split.
CANVAS_VIEW_ABI = [
    {"type": "function", "name": "startingPrice", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
]

CHAINS = [
    {
        "id": 369,
        "name": "PulseChain",
        "rpc_env": "PULSECHAIN_RPC_URL",
        "rpc_default": "https://rpc.pulsechain.com",
        "native": "PLS",
        "explorer_tx": "https://otter.pulsechain.com/tx/",
        # Canvas deploy block (Day-0 launch 2026-05-24). Lower bound for the
        # founder-count scan so it never walks from genesis-of-chain.
        # Mirrors web/src/lib/deployBlocks.ts; keep the two in sync.
        "deploy_block": 26_606_708,
    },
    {
        "id": 1,
        "name": "Ethereum",
        "rpc_env": "ETHEREUM_RPC_URL",
        # dRPC's public Ethereum endpoint. Free tier, no key required.
        # Survives the bot's 7-day backfill (~11 get_logs calls per run
        # at LOGS_WINDOW=5000 on a chain with 12s block times). Operator
        # can override via ETHEREUM_RPC_URL if they want a paid provider
        # for headroom; current load doesn't justify it.
        "rpc_default": "https://eth.drpc.org",
        "native": "ETH",
        "explorer_tx": "https://etherscan.io/tx/",
        "deploy_block": 25_161_961,
    },
    {
        "id": 8453,
        "name": "Base",
        "rpc_env": "BASE_RPC_URL",
        # PublicNode's Base endpoint. Survives the first-run 7-day
        # backfill burst (~60 chunks at LOGS_WINDOW=5000 over 300k
        # blocks @ 2s/block) — benchmark showed 3 chunks in 0.85s
        # without rate-limit, vs mainnet.base.org's 429 after ~30
        # rapid requests and base.drpc.org's intermittent 408 timeouts.
        # Operator can override via BASE_RPC_URL if needed.
        "rpc_default": "https://base.publicnode.com",
        "native": "ETH",
        "explorer_tx": "https://basescan.org/tx/",
        "deploy_block": 46_399_049,
    },
    {
        "id": 56,
        "name": "BSC",
        "rpc_env": "BSC_RPC_URL",
        # Bloxroute is the only public BSC RPC that doesn't prune logs
        # (the operator's pre-launch survey found dataseed1-4 and
        # publicnode all return "history has been pruned" after ~24h,
        # and most others cap eth_getLogs at 500-block ranges). The
        # frontend uses the same endpoint for the same reason.
        # bsc.drpc.org is a flake-prone secondary; not used as default
        # because intermittent 400s would burn the bot's retry budget.
        "rpc_default": "https://bsc.rpc.blxrbdn.com",
        "native": "BNB",
        "explorer_tx": "https://bscscan.com/tx/",
        "deploy_block": 100_071_283,
    },
    {
        "id": 999,
        "name": "HyperEVM",
        "rpc_env": "HYPEREVM_RPC_URL",
        # Bloxroute, same endpoint the frontend + BSC use: CORS-clean,
        # fast, and returns canvas-deploy-block logs without the range
        # caps or pruning that hobble most public HyperEVM RPCs.
        "rpc_default": "https://hyperliquid.rpc.blxrbdn.com",
        "native": "HYPE",
        "explorer_tx": "https://www.hyperscan.com/tx/",
        # HyperEVM runs the v1.1 Canvas build at a DIFFERENT CREATE2
        # address than the four original mainnets (the chain-999
        # constructor branch shifts the init-code hash). Override the
        # shared CANVAS_ADDRESS env with this chain's real address.
        "canvas_address": "0xbe682DB4c67F723Ad52a2f7Ba7Bc982C8BBDC5A4",
        # v1.1 deploy block (2026-05-31, tx 0x8b8b7f6d…).
        "deploy_block": 36_585_579,
        # HyperEVM RPCs cap eth_getLogs at a 1000-block range, unlike the
        # ~10k the others allow. A span of [cur, cur+999] is 1000 blocks
        # inclusive, which the blxrbdn node rejects as "invalid block
        # range" (-32602) at the boundary, so we leave headroom at 900.
        # Web3RPCError is now in both scan loops' caught set, so even an
        # over-range chunk skips instead of crashing the whole run (which
        # used to freeze every chain's data, not just HyperEVM's).
        "logs_window": 900,
    },
]

HERE = Path(__file__).parent
STATE_FILE = HERE / "state.json"
QUEUE_FILE = HERE / "QUEUE.md"
# Sibling JSON output, picked up by the Vite frontend at /queue.json.
# Files in web/public/ are copied verbatim into the production build, so
# the queue page can fetch this without a backend.
QUEUE_JSON_FILE = (HERE / ".." / ".." / "web" / "public" / "queue.json").resolve()
# Weekly summary written alongside queue.json. Frontend renders a card
# per chain plus a cross-chain comparison row above the queue list.
SUMMARY_JSON_FILE = (HERE / ".." / ".." / "web" / "public" / "summary.json").resolve()
# When trimming the JSON queue (so the served file doesn't grow without
# bound), we keep this many of the most recent entries. Markdown queue
# is never auto-trimmed; the operator manages that file by hand.
JSON_QUEUE_KEEP = 200
# Weekly summary window: trailing 7 days. Chain-specific block times
# are below so we can convert the window to a from_block per chain.
SUMMARY_WINDOW_SECONDS = 7 * 24 * 60 * 60
# Approximate seconds-per-block per chain. Used only to translate the
# 7-day window into a starting block; the actual scan still uses block
# numbers, so a wrong estimate just means the window is slightly off,
# not data loss.
#
# BSC is set to 0.5s (not 3s as documented historically) because the
# Maxwell upgrade dropped BNB Chain mainnet block time below 1s.
# Empirically measured ~0.46s in late May 2026: a paint at block
# 100_082_391 (~Day 0) is 751,588 blocks back as of 100_833_979.
# Underestimating block time only shortens the effective window —
# the previous 3s value meant the BSC summary scan covered ~42 hours
# instead of the intended 7 days, so any paint older than that was
# silently invisible (the only existing BSC paint was missed for
# exactly this reason; user-reported as a "BSC bug" 2026-05-28).
# Erring small here costs more RPC chunks but never drops events.
CHAIN_BLOCK_TIME_S = {369: 10, 1: 12, 8453: 2, 56: 0.5, 999: 1}
# Overpaint heuristic threshold: if a paint's pricePerPixel is more than
# this multiple of the chain's startingPrice (floor), at least one
# pixel was painted over (compounded at +10% per overwrite). 1.05 gives
# a 5% buffer for rounding / multi-pixel mixed paints.
OVERPAINT_RATIO = 1.05

# `os.environ.get(name, default)` only returns `default` when the name
# is absent; an EMPTY-STRING value bypasses the default and gets
# returned as "". That bites under GitHub Actions, where unset
# `vars.X` references still render as `env: X: ''` in the workflow, so
# every "optional" knob arrived as "" and int("") tanked the run on
# the first cron tick. Use `or` to treat empty-string the same as
# absent, matching the pattern already used for the per-chain
# rpc_default lookup.
# MANUAL_QUEUE_* kept as alias names so any GitHub variable an operator
# set under the old labels keeps working through the rename.
MIN_PIXELS = int(
    os.environ.get("TWEETS_MIN_PIXELS")
    or os.environ.get("MANUAL_QUEUE_MIN_PIXELS")
    or "100"
)
MAX_PER_RUN = int(
    os.environ.get("TWEETS_MAX_PER_RUN")
    or os.environ.get("MANUAL_QUEUE_MAX_PER_RUN")
    or "50"
)
BACKFILL_BLOCKS = 1_000   # on first run, look back this far
LOGS_WINDOW = 5_000       # cap each get_logs call to stay under public-RPC limits
INTER_CHUNK_SLEEP_S = 0.2 # courtesy pause between get_logs chunks; without
                          # this, a 60-chunk first-run Base backfill bursts
                          # ~30 requests/sec and trips the free-tier 429s
RETRY_MAX_ATTEMPTS = 5    # for transient HTTP errors (429, 503)
RETRY_INITIAL_DELAY_S = 1.0
RETRY_MAX_DELAY_S = 30.0
TAGWALL_BASE_URL = (os.environ.get("TAGWALL_BASE_URL") or "https://tagwall.io").rstrip("/")

# --- Founder status (W1 scarcity pulse + W2 milestones) -------------------
# Founder rank = 1-indexed order of an address's FIRST paint on a chain,
# derived from the immutable Painted log. Two tiers per chain: Genesis is
# the first GENESIS_CAP painters, Founder is the next slice up to
# FOUNDER_CAP. These caps MUST match web/src/lib/founders.ts — the window
# closing is the scarcity, so they cannot drift between bot and frontend.
GENESIS_CAP = 100
FOUNDER_CAP = 1000
# Per-chain distinct-painter set + milestone bookkeeping. Bot-written
# operational state, authoritative on GitHub like state.json (excluded
# from publish-public.sh so an operator publish never clobbers it).
FOUNDERS_STATE_FILE = HERE / "founders_state.json"
# Founders board the scarcity/milestone tweets link to.
FOUNDERS_URL = f"{TAGWALL_BASE_URL}/founders"
# The founder scan walks deploy-block→head the first time it runs for a
# chain, which is a large one-off backfill on a fast chain like HyperEVM
# (~1 block/s). Cap chunks per chain per run so a cold backfill spans
# several runs instead of risking the 30-min scheduled-run cancel window;
# the per-chain lastBlock advances each run so it resumes cleanly. Steady
# state (30 min of new blocks) is a handful of chunks, far under this.
FOUNDERS_MAX_CHUNKS_PER_RUN = 200


# Header injected at the top of QUEUE.md the first time the file is
# created or when it has been trimmed to empty. The bot prepends new
# entries between the marker line and the existing entries, so the
# header survives across runs.
QUEUE_HEADER = """# Tagwall tweet queue

Notable paints awaiting manual posting from `@tagwall_io_bot`.

For each entry below: copy the tweet text from the code fence, post it
manually from the bot account on X, then tick the checkbox (GitHub auto-
commits the change) or delete the entry to keep this file short. The
bot only ever prepends; it never edits or deletes existing entries.

The queue is generated every 30 min by `.github/workflows/tweets.yml`
scanning all five EVM chains for `Painted` events at or above
`TWEETS_MIN_PIXELS` pixels.

<!-- queue:start -->
"""


# HTTP status codes worth retrying. All represent transient failures —
# rate limits, upstream timeouts, gateway hiccups, momentary 5xx — not
# bad requests we should give up on.
RETRYABLE_HTTP_STATUS = {408, 429, 500, 502, 503, 504, 522, 524}


def get_logs_with_retry(
    painted_event, from_block: int, to_block: int, chain_name: str,
) -> list:
    """Wrap contract.events.Painted.get_logs with retry-on-transient-error.
    Public RPCs (default PulseChain, Base, etc.) burst-cap at ~30
    req/min or time out under sustained log queries, both of which the
    first-run 7-day backfill blows past in seconds.

    Exponential backoff with a 30s cap, 5 attempts total. Network-level
    errors (ConnectionError, ReadTimeout) also retry. On final-attempt
    failure, raises so the caller can decide whether to skip the chunk
    or abort the chain. ContractLogicError / ValueError are NOT
    handled here — they indicate a bad request (e.g. range too large)
    and the caller treats them as fatal-for-this-chunk.
    """
    delay = RETRY_INITIAL_DELAY_S
    for attempt in range(RETRY_MAX_ATTEMPTS):
        try:
            return painted_event.get_logs(from_block=from_block, to_block=to_block)
        except requests.exceptions.HTTPError as err:
            status = err.response.status_code if err.response is not None else None
            if status in RETRYABLE_HTTP_STATUS and attempt < RETRY_MAX_ATTEMPTS - 1:
                print(
                    f"[{chain_name}] RPC HTTP {status} on [{from_block},{to_block}]; "
                    f"backing off {delay:.1f}s (attempt {attempt + 1}/{RETRY_MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                time.sleep(delay)
                delay = min(delay * 2, RETRY_MAX_DELAY_S)
                continue
            raise
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as err:
            if attempt < RETRY_MAX_ATTEMPTS - 1:
                print(
                    f"[{chain_name}] RPC {type(err).__name__} on [{from_block},{to_block}]; "
                    f"backing off {delay:.1f}s (attempt {attempt + 1}/{RETRY_MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                time.sleep(delay)
                delay = min(delay * 2, RETRY_MAX_DELAY_S)
                continue
            raise
    # Loop body always either returns or raises; this is unreachable.
    return []


def load_state() -> dict[str, int]:
    if not STATE_FILE.exists():
        return {}
    with STATE_FILE.open() as f:
        return json.load(f)


def save_state(state: dict[str, int]) -> None:
    with STATE_FILE.open("w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")


def shorten_address(addr: str) -> str:
    return f"{addr[:6]}…{addr[-4:]}"


def format_price(wei: int, native_symbol: str) -> str:
    eth = wei / 1e18
    if eth >= 1_000:
        return f"{eth:,.0f} {native_symbol}"
    if eth >= 1:
        return f"{eth:.2f} {native_symbol}"
    if eth >= 0.0001:
        return f"{eth:.4f} {native_symbol}"
    return f"{eth:.6f} {native_symbol}"


# Tweet variants. Identical to the original twitter-paints bot. Kept as
# four phrasings (deterministic pick per tx-hash) so that if X usage
# ever resumes, the queue copy and the auto-posted copy match exactly.
# Operator can freely edit before posting; the variant just sets the
# starting point.
TWEET_VARIANTS = [
    "🎨 {painter} painted {w}×{h} on {chain} for {price} ({pixels:,} px). {link}",
    "🟦 {chain}: {w}×{h} by {painter}, {pixels:,} px for {price}. {link}",
    "📍 paint drop on {chain}: {painter} took {w}×{h} for {price} ({pixels:,} px). {link}",
    "💸 {price} on {chain} for a {w}×{h} region by {painter}, {pixels:,} px. {link}",
]

REFERRAL_BPS = 500
BPS = 10_000


def _pick_variant(tx_hash: bytes) -> str:
    return TWEET_VARIANTS[int.from_bytes(tx_hash, "big") % len(TWEET_VARIANTS)]


def format_referrer_suffix(referrer: str, painter: str, price_wei: int, native: str) -> str:
    if not referrer or int(referrer, 16) == 0:
        return ""
    if referrer.lower() == painter.lower():
        return ""
    ref_wei = price_wei * REFERRAL_BPS // BPS
    return f" ↪ ref {shorten_address(referrer)} +{format_price(ref_wei, native)}"


def format_tweet(args: dict, chain: dict, tx_hash: bytes) -> str:
    painter = shorten_address(args["painter"])
    w, h = args["w"], args["h"]
    pixels = args["pixelsPainted"]
    price = format_price(args["pricePaid"], chain["native"])
    link = f"{TAGWALL_BASE_URL}/pixel/{args['x']},{args['y']}"
    body = _pick_variant(tx_hash).format(
        painter=painter, w=w, h=h, chain=chain["name"],
        price=price, pixels=pixels, link=link,
    )
    suffix = format_referrer_suffix(
        args.get("referrer", ""), args["painter"], args["pricePaid"], chain["native"],
    )
    return body + suffix


def is_overpaint(price_wei: int, pixels: int, floor_wei: int) -> bool:
    """Return True if at least one pixel in this paint was overwriting a
    previously-painted pixel. Heuristic: pricePerPixel > floor × 1.05.
    The contract charges floor for blank pixels and lastPrice × 1.1 for
    overwrites, so anything materially above floor implies an overpaint.
    Returns False if floor is unknown (can't decide; better than a false
    positive on every paint).
    """
    if pixels <= 0 or floor_wei <= 0:
        return False
    price_per_pixel = price_wei / pixels
    return price_per_pixel >= floor_wei * OVERPAINT_RATIO


def format_queue_json_entry(
    args: dict, chain: dict, tx_hash_hex: str, tweet: str, now_iso: str,
    floor_wei: int,
) -> dict:
    """Structured per-paint payload for the /queue page. Mirrors the
    Markdown entry but keeps numeric + URL fields broken out so the
    frontend can render its own layout without re-parsing the tweet.
    """
    pixels = args["pixelsPainted"]
    price_per_pixel_wei = args["pricePaid"] // pixels if pixels else 0
    return {
        "id": tx_hash_hex,
        "chain": chain["name"],
        "chainId": chain["id"],
        "queuedAt": now_iso,
        "painter": args["painter"],
        "painterShort": shorten_address(args["painter"]),
        "x": args["x"],
        "y": args["y"],
        "w": args["w"],
        "h": args["h"],
        "pixels": pixels,
        "priceFormatted": format_price(args["pricePaid"], chain["native"]),
        "pricePerPixelFormatted": format_price(price_per_pixel_wei, chain["native"]),
        "native": chain["native"],
        "wasOverpaint": is_overpaint(args["pricePaid"], pixels, floor_wei),
        "tweet": tweet,
        "txUrl": f"{chain['explorer_tx']}{tx_hash_hex}",
        "pixelUrl": f"{TAGWALL_BASE_URL}/pixel/{args['x']},{args['y']}",
    }


def format_queue_entry(args: dict, chain: dict, tx_hash_hex: str, tweet: str) -> str:
    """One Markdown block per paint, designed for the GitHub web UI:

    - Checkbox on the leading bullet so the operator can tick it in the
      web UI (GitHub treats it as an inline edit and auto-commits).
    - Tweet text in a fenced code block so GitHub renders the "Copy"
      button on hover (desktop) or a long-press copy on mobile.
    - Minimal metadata line: chain, dims, pixels, price, tx link, pixel
      link. No coordinates in the visible tweet text per operator
      decision 2026-05-03 (deep link still resolves to the pixel).
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    explorer_url = f"{chain['explorer_tx']}{tx_hash_hex}"
    pixel_url = f"{TAGWALL_BASE_URL}/pixel/{args['x']},{args['y']}"
    price = format_price(args["pricePaid"], chain["native"])

    return (
        f"- [ ] **{chain['name']}** · {now} · "
        f"{args['w']}×{args['h']} · {args['pixelsPainted']:,} px · {price} · "
        f"[tx]({explorer_url}) · [pixel]({pixel_url})\n"
        f"\n"
        f"  ```text\n"
        f"  {tweet}\n"
        f"  ```\n"
    )


def is_notable(args: dict) -> bool:
    return args["pixelsPainted"] >= MIN_PIXELS


def read_existing_queue() -> tuple[str, str]:
    """Return (header, tail) where tail is everything after the
    <!-- queue:start --> marker. If the file doesn't exist or doesn't
    contain the marker, return the canonical header and an empty tail.
    """
    if not QUEUE_FILE.exists():
        return QUEUE_HEADER, ""
    content = QUEUE_FILE.read_text()
    marker = "<!-- queue:start -->"
    if marker not in content:
        # File exists but is malformed; preserve its content under a
        # quarantine fence and start a fresh queue above it.
        return QUEUE_HEADER, f"\n<!-- pre-existing content preserved below -->\n{content}\n"
    head, _, tail = content.partition(marker)
    return head + marker + "\n", tail.lstrip("\n")


def write_queue(new_entries: list[str]) -> None:
    """Prepend new_entries (newest first) between the header marker and
    the existing tail.

    Always writes the file, even when new_entries is empty. This makes
    the file exist on disk after every real (non-dry-run) bot run,
    which is required by the workflow's `git diff --quiet` check (that
    command errors on a pathspec that doesn't exist in either HEAD or
    the working tree). On an empty-entries run with no pre-existing
    tail, the file ends up as just the header — same as the initial
    template, which leaves no diff against HEAD.
    """
    head, tail = read_existing_queue()
    if new_entries:
        body = "\n".join(new_entries) + "\n"
    else:
        body = ""
    QUEUE_FILE.write_text(f"{head}\n{body}{tail}")


def write_queue_json(new_entries_json: list[dict], now_iso: str) -> None:
    """Prepend new_entries_json (already newest-first) to the existing
    queue.json, trim to JSON_QUEUE_KEEP, write to web/public/queue.json.
    No-op when new_entries_json is empty: rewriting the file with only
    `generatedAt` updated would change `web/public/queue.json`'s git
    blob on every cron tick and trip the Cloudflare Worker's
    `Build watch paths: web/**` rebuild trigger 48x/day for no
    user-visible change. The file already exists in HEAD from the
    initial publish so it doesn't need to be created here.
    """
    if not new_entries_json:
        return
    existing: list[dict] = []
    if QUEUE_JSON_FILE.exists():
        try:
            with QUEUE_JSON_FILE.open() as f:
                payload = json.load(f)
            existing = payload.get("entries", [])
        except (json.JSONDecodeError, OSError) as err:
            print(f"queue.json unreadable, starting fresh: {err}", file=sys.stderr)

    # De-dupe by id: if the bot reprocesses the same tx (e.g. after a
    # reorg or a manual rerun), don't double-list it.
    new_ids = {e["id"] for e in new_entries_json}
    kept = [e for e in existing if e["id"] not in new_ids]
    combined = new_entries_json + kept
    combined = combined[:JSON_QUEUE_KEEP]

    payload = {"generatedAt": now_iso, "entries": combined}
    QUEUE_JSON_FILE.parent.mkdir(parents=True, exist_ok=True)
    with QUEUE_JSON_FILE.open("w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def process_chain(
    chain: dict, state: dict[str, int], remaining_quota: int, now_iso: str,
) -> tuple[list[str], list[dict]]:
    """Return (markdown_entries, json_entries) for new notable paints on
    this chain. Advances state[chain_id] to the next unscanned block.
    Both lists are aligned: same entry at the same index in both.
    """
    rpc = os.environ.get(chain["rpc_env"]) or chain["rpc_default"]
    if not rpc:
        print(f"[{chain['name']}] skip: no RPC configured (set {chain['rpc_env']})")
        return [], []

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        latest = w3.eth.block_number
    except Exception as err:
        print(f"[{chain['name']}] RPC unreachable: {err}", file=sys.stderr)
        return [], []

    canvas_address = Web3.to_checksum_address(
        chain.get("canvas_address") or os.environ["CANVAS_ADDRESS"]
    )
    contract = w3.eth.contract(address=canvas_address, abi=PAINTED_EVENT_ABI)
    view_contract = w3.eth.contract(address=canvas_address, abi=CANVAS_VIEW_ABI)
    try:
        floor_wei = view_contract.functions.startingPrice().call()
    except Exception as err:
        # Non-fatal: overpaint detection just degrades to "unknown" for
        # this chain on this run.
        print(f"[{chain['name']}] startingPrice() failed, overpaint flag disabled: {err}", file=sys.stderr)
        floor_wei = 0

    cid_key = str(chain["id"])
    if cid_key in state:
        from_block = state[cid_key]
    else:
        # First-run backfill: scan the trailing summary window (7 days)
        # so the queue isn't empty just because the last few hundred
        # blocks happened to be quiet. Subsequent runs are incremental
        # from state.json.
        block_time = CHAIN_BLOCK_TIME_S.get(chain["id"], 10)
        blocks_back = int(SUMMARY_WINDOW_SECONDS / block_time)
        from_block = max(0, latest - blocks_back)
        print(f"[{chain['name']}] first run, backfilling from block {from_block} (~{blocks_back} blocks)")

    if from_block > latest:
        print(f"[{chain['name']}] state ahead of head; resetting to latest")
        state[cid_key] = latest
        return [], []
    if from_block == latest:
        print(f"[{chain['name']}] up to date at block {latest}")
        return [], []

    # Loop through LOGS_WINDOW-sized chunks until we either catch up to
    # `latest` or exhaust the per-run quota. Each successful chunk
    # advances state[cid_key] so a mid-loop crash resumes cleanly.
    md_entries: list[str] = []
    json_entries: list[dict] = []
    cur = from_block
    while cur < latest and len(md_entries) < remaining_quota:
        to_block = min(latest, cur + chain.get("logs_window", LOGS_WINDOW))
        try:
            events = get_logs_with_retry(
                contract.events.Painted, cur, to_block, chain["name"],
            )
        except (ContractLogicError, ValueError, Web3RPCError, requests.exceptions.RequestException) as err:
            print(
                f"[{chain['name']}] get_logs failed in [{cur},{to_block}]: {err}",
                file=sys.stderr,
            )
            # Skip this chunk and advance; we'll reattempt the next run
            # if the failure was transient (state hasn't moved past
            # to_block yet).
            cur = to_block + 1
            time.sleep(INTER_CHUNK_SLEEP_S)
            continue

        if events:
            print(f"[{chain['name']}] {len(events)} events in [{cur}, {to_block}]")
        for ev in events:
            if len(md_entries) >= remaining_quota:
                print(f"[{chain['name']}] hit MAX_PER_RUN; remaining events deferred to next run")
                state[cid_key] = ev["blockNumber"]
                return md_entries, json_entries
            args = ev["args"]
            if not is_notable(args):
                continue
            tx_hash_bytes = bytes(ev["transactionHash"])
            tx_hash_hex = "0x" + tx_hash_bytes.hex()
            tweet = format_tweet(args, chain, tx_hash_bytes)
            md_entries.append(format_queue_entry(args, chain, tx_hash_hex, tweet))
            json_entries.append(
                format_queue_json_entry(args, chain, tx_hash_hex, tweet, now_iso, floor_wei)
            )
        cur = to_block + 1
        state[cid_key] = cur
        # Courtesy pause between chunks so the next iteration doesn't
        # burst-trip the public RPC's rate limit.
        if cur < latest:
            time.sleep(INTER_CHUNK_SLEEP_S)

    return md_entries, json_entries


def gini_coefficient(values: list[int]) -> float:
    """Gini of a paints-per-painter distribution. 0 = everyone painted
    equally; 1 = one wallet did everything. Secondary north-star metric
    (PRD council refinement #4): a high Gini means activity is
    whale-driven, so a rising paint count with a rising Gini is a vanity
    signal, not real breadth. Returns 0.0 for an empty/zero distribution.
    """
    vals = sorted(v for v in values if v > 0)
    n = len(vals)
    total = sum(vals)
    if n == 0 or total == 0:
        return 0.0
    # Mean-absolute-difference form: sum_i (2*(i+1) - n - 1) * x_i over n*total.
    weighted = sum((2 * (i + 1) - n - 1) * v for i, v in enumerate(vals))
    return round(weighted / (n * total), 4)


def daily_buckets(
    counts_by_date: dict[str, int], window_days: int, end_date: datetime,
) -> list[dict]:
    """Dense per-day series ending at `end_date` (UTC), zero-filled so the
    frontend sparkline has one bucket per day even on quiet days.
    """
    series: list[dict] = []
    for back in range(window_days - 1, -1, -1):
        day = (end_date - timedelta(days=back)).strftime("%Y-%m-%d")
        series.append({"date": day, "paints": counts_by_date.get(day, 0)})
    return series


def compute_weekly_summary(chain: dict) -> tuple[dict | None, dict[str, dict], dict]:
    """Scan the trailing SUMMARY_WINDOW_SECONDS of Painted events on
    this chain and return (summary_stats, referrer_earnings) where:

      summary_stats: aggregate dict for one chain's summary card, or
        None if the RPC is unreachable. An empty window (no paints
        this week) still returns a dict with paintCount: 0 so the
        frontend can render "no activity yet" instead of hiding the
        chain entirely.

      referrer_earnings: dict[lowercased_address, {earnings_wei,
        paint_count, native}] tracking per-referrer aggregates on this
        chain. main() rolls these up across chains for the leaderboard.
        Self-referrals and zero-address referrals are excluded.

    Note: this is a fresh scan every run. Not incremental. With a
    LOGS_WINDOW of 5,000 it's ~12 calls/week on PulseChain (~10s block
    time), more on Base/BSC (faster blocks). Acceptable for a cron that
    runs every 30 min; if it becomes a bottleneck, switch to a rolling
    state-cached aggregator.
    """
    rpc = os.environ.get(chain["rpc_env"]) or chain["rpc_default"]
    if not rpc:
        print(f"[{chain['name']}] summary: no RPC configured")
        return None, {}, {}

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        latest_block = w3.eth.get_block("latest")
        latest = latest_block["number"]
        latest_ts = latest_block["timestamp"]
    except Exception as err:
        print(f"[{chain['name']}] summary: RPC unreachable: {err}", file=sys.stderr)
        return None, {}, {}

    canvas_address = Web3.to_checksum_address(
        chain.get("canvas_address") or os.environ["CANVAS_ADDRESS"]
    )
    contract = w3.eth.contract(address=canvas_address, abi=PAINTED_EVENT_ABI)
    view_contract = w3.eth.contract(address=canvas_address, abi=CANVAS_VIEW_ABI)
    try:
        floor_wei = view_contract.functions.startingPrice().call()
    except Exception:
        floor_wei = 0

    block_time = CHAIN_BLOCK_TIME_S.get(chain["id"], 10)
    blocks_back = int(SUMMARY_WINDOW_SECONDS / block_time)
    from_block = max(0, latest - blocks_back)

    paint_count = 0
    overpaint_count = 0
    total_volume_wei = 0
    # Paints per painter (for the unique count + Gini distribution) and
    # paints per calendar day (for the activity sparkline). The block
    # timestamp is approximated from the block number to avoid an extra
    # getBlock per event: ts ~= latest_ts - (latest - block) * block_time.
    painter_counts: Counter = Counter()
    daily_counts: dict[str, int] = {}
    unique_referrers: set[str] = set()
    # Per-referrer aggregates on THIS chain. Keyed lowercased so the
    # cross-chain rollup in main() can merge without case mismatches.
    # earnings_wei is computed as pricePaid * REFERRAL_BPS / BPS,
    # mirroring Canvas.sol's splitBps math.
    referrer_data: dict[str, dict] = {}
    # Each "biggest" tracks (sort-key, args-dict, tx-hash-hex) for the
    # winning event. Updated in place during the scan; None until the
    # first event is seen.
    biggest_by_pixels: tuple[int, dict, str] | None = None
    biggest_by_price: tuple[int, dict, str] | None = None

    cur = from_block
    while cur <= latest:
        to = min(latest, cur + chain.get("logs_window", LOGS_WINDOW))
        try:
            events = get_logs_with_retry(
                contract.events.Painted, cur, to, chain["name"],
            )
        except (ContractLogicError, ValueError, Web3RPCError, requests.exceptions.RequestException) as err:
            print(
                f"[{chain['name']}] summary chunk [{cur},{to}] failed: {err}",
                file=sys.stderr,
            )
            cur = to + 1
            time.sleep(INTER_CHUNK_SLEEP_S)
            continue
        for ev in events:
            args = ev["args"]
            paint_count += 1
            total_volume_wei += args["pricePaid"]
            painter_counts[args["painter"].lower()] += 1
            approx_ts = latest_ts - (latest - ev["blockNumber"]) * block_time
            day = datetime.fromtimestamp(approx_ts, timezone.utc).strftime("%Y-%m-%d")
            daily_counts[day] = daily_counts.get(day, 0) + 1
            if is_overpaint(args["pricePaid"], args["pixelsPainted"], floor_wei):
                overpaint_count += 1

            # Referrer tracking. Skip zero-address and self-referral
            # (matches Canvas.sol's splitBps() which routes the slice
            # to treasury in those cases — no actual referrer was
            # paid).
            ref = args.get("referrer") or ""
            if ref and int(ref, 16) != 0 and ref.lower() != args["painter"].lower():
                ref_lower = ref.lower()
                unique_referrers.add(ref_lower)
                earn_wei = args["pricePaid"] * REFERRAL_BPS // BPS
                slot = referrer_data.setdefault(
                    ref_lower,
                    {
                        "address": Web3.to_checksum_address(ref),
                        "earningsByNative": {},
                        "paintCount": 0,
                    },
                )
                slot["paintCount"] += 1
                slot["earningsByNative"][chain["native"]] = (
                    slot["earningsByNative"].get(chain["native"], 0) + earn_wei
                )

            tx_hash_hex = "0x" + bytes(ev["transactionHash"]).hex()
            if biggest_by_pixels is None or args["pixelsPainted"] > biggest_by_pixels[0]:
                biggest_by_pixels = (args["pixelsPainted"], dict(args), tx_hash_hex)
            if biggest_by_price is None or args["pricePaid"] > biggest_by_price[0]:
                biggest_by_price = (args["pricePaid"], dict(args), tx_hash_hex)
        cur = to + 1
        if cur <= latest:
            time.sleep(INTER_CHUNK_SLEEP_S)

    def fmt_peak(peak: tuple[int, dict, str] | None) -> dict | None:
        if peak is None:
            return None
        _, args, tx_hash_hex = peak
        return {
            "x": args["x"], "y": args["y"], "w": args["w"], "h": args["h"],
            "pixels": args["pixelsPainted"],
            "priceFormatted": format_price(args["pricePaid"], chain["native"]),
            "painter": args["painter"],
            "painterShort": shorten_address(args["painter"]),
            "pixelUrl": f"{TAGWALL_BASE_URL}/pixel/{args['x']},{args['y']}",
            "txUrl": f"{chain['explorer_tx']}{tx_hash_hex}",
        }

    window_days = SUMMARY_WINDOW_SECONDS // 86400
    gini = gini_coefficient(list(painter_counts.values()))

    print(
        f"[{chain['name']}] summary: {paint_count} paints, "
        f"{overpaint_count} overpaints, {len(painter_counts)} unique painters, "
        f"{len(unique_referrers)} unique referrers, gini {gini}"
    )

    summary_stats = {
        "chain": chain["name"],
        "chainId": chain["id"],
        "native": chain["native"],
        "windowStartBlock": from_block,
        "windowEndBlock": latest,
        "paintCount": paint_count,
        "overpaintCount": overpaint_count,
        "uniquePainters": len(painter_counts),
        "uniqueReferrers": len(unique_referrers),
        "gini": gini,
        "totalVolumeFormatted": format_price(total_volume_wei, chain["native"]),
        "dailyActivity": daily_buckets(daily_counts, window_days, datetime.now(timezone.utc)),
        "biggestByPixels": fmt_peak(biggest_by_pixels),
        "biggestByPrice": fmt_peak(biggest_by_price),
    }
    # Third element feeds the cross-chain roll-up in main(): the painter
    # distribution (for a true dedup union + combined Gini) and the raw
    # per-day counts (for a combined sparkline). Not serialised per chain.
    rollup_parts = {"painterCounts": painter_counts, "dailyCounts": daily_counts}
    return summary_stats, referrer_data, rollup_parts


def build_all_chains_rollup(
    summaries: list[dict], rollup_parts: list[dict], window_days: int,
) -> dict:
    """Cross-chain roll-up for the /ops headline strip. Unique painters is
    a TRUE union (a wallet active on PulseChain and HyperEVM counts once),
    which can't be derived from the per-chain counts alone. Gini is on the
    combined paints-per-painter distribution. Daily activity sums each
    chain's per-day counts so the sparkline reflects all chains at once.
    """
    combined_counts: Counter = Counter()
    combined_daily: dict[str, int] = {}
    for parts in rollup_parts:
        combined_counts.update(parts.get("painterCounts", {}))
        for day, n in parts.get("dailyCounts", {}).items():
            combined_daily[day] = combined_daily.get(day, 0) + n
    total_paints = sum(s["paintCount"] for s in summaries)
    total_overpaints = sum(s["overpaintCount"] for s in summaries)
    return {
        "chainCount": len(summaries),
        "totalPaints": total_paints,
        "totalOverpaints": total_overpaints,
        # Window is 7 days, so "unique painters" == "weekly-active painters".
        # Surfaced under both names so the frontend can label either way.
        "uniquePainters": len(combined_counts),
        "weeklyActivePainters": len(combined_counts),
        "gini": gini_coefficient(list(combined_counts.values())),
        "dailyActivity": daily_buckets(
            combined_daily, window_days, datetime.now(timezone.utc)
        ),
    }


def build_founders_rollup(founders_state: dict, caught_up: dict[str, bool]) -> list[dict]:
    """Per-chain founder fill for the /ops dashboard, one entry per chain
    in CHAINS order. Lets the operator see every chain's Genesis/Founder
    progress on a single page without switching wallets.

    Counts come from the same founders_state the scarcity tweets read, so
    the board and the tweet copy can never disagree. `caughtUp` is False
    while a cold backfill is still walking history (the count is a lower
    bound until it flips True or the window closes), so the frontend can
    mark a chain as still scanning rather than imply a final figure.
    """
    out: list[dict] = []
    for chain in CHAINS:
        cid = str(chain["id"])
        slot = founders_state.get(cid) or {}
        count = int(slot.get("count", 0))
        done = bool(slot.get("done"))
        out.append({
            "chainId": chain["id"],
            "chain": chain["name"],
            "native": chain["native"],
            "caughtUp": done or caught_up.get(cid, False),
            **compute_founder_stats(count),
        })
    return out


def write_summary(
    summaries: list[dict], all_chains: dict, founders: list[dict], now_iso: str,
) -> None:
    """Always overwrite summary.json with the current snapshot. Unlike
    queue.json, summary stats are stateless: every run recomputes from
    scratch, so a no-op run still produces a fresh `generatedAt` but
    likely identical chain stats. CF Pages's content-aware build-skip
    will catch the case where nothing actually changed.

    Includes the operator-facing minPixels threshold so the frontend
    can render an exact "≥ N px" line in the empty-state copy without
    needing its own copy of the env-var default.
    """
    payload = {
        "generatedAt": now_iso,
        "windowDays": SUMMARY_WINDOW_SECONDS // 86400,
        "minPixels": MIN_PIXELS,
        "allChains": all_chains,
        "founders": founders,
        "chains": summaries,
    }
    SUMMARY_JSON_FILE.parent.mkdir(parents=True, exist_ok=True)
    with SUMMARY_JSON_FILE.open("w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


# Top-N cap on the referrer leaderboard. ENS reverse lookups cost an
# Ethereum RPC round-trip per address (cap is a soft budget; lookups
# are fast on dRPC's free tier). Frontend renders all of them; tighten
# this if the leaderboard JSON gets too chatty.
LEADERBOARD_TOP_N = 20

# Where the cross-chain referrer leaderboard JSON lives, served at
# tagwall.io/leaderboard.json. Same publish/serve pipeline as queue.json
# and summary.json (operator publishes web/public/ via the standard
# build, the bot writes here directly under GitHub Actions).
LEADERBOARD_JSON_FILE = (HERE / ".." / ".." / "web" / "public" / "leaderboard.json").resolve()


def build_referrer_leaderboard(
    per_chain_referrer_data: list[dict[str, dict]],
    chains_by_native: dict[str, dict],
) -> list[dict]:
    """Merge per-chain referrer dicts into a sorted cross-chain
    leaderboard. Each row carries the referrer's address, total paint
    count credited to them across all chains, and per-native-token
    earnings (we can't sum across native tokens without a USD oracle,
    so each row breaks the earnings out per token). Rows are sorted
    by total paint count descending (a reasonable proxy for "most
    active referrer" that doesn't require token-value normalisation);
    the frontend can re-sort however it likes.

    Truncates to LEADERBOARD_TOP_N before any ENS resolution so the
    operator's ENS-RPC budget stays bounded.
    """
    merged: dict[str, dict] = {}
    for per_chain in per_chain_referrer_data:
        for addr_lower, payload in per_chain.items():
            slot = merged.setdefault(
                addr_lower,
                {
                    "address": payload["address"],
                    "paintCount": 0,
                    "earningsByNative": {},
                },
            )
            slot["paintCount"] += payload["paintCount"]
            for native, wei in payload["earningsByNative"].items():
                slot["earningsByNative"][native] = (
                    slot["earningsByNative"].get(native, 0) + wei
                )

    # Sort by total paint count, tiebreak by address for determinism.
    rows = sorted(
        merged.values(),
        key=lambda r: (-r["paintCount"], r["address"]),
    )[:LEADERBOARD_TOP_N]

    # Format earnings for display + drop the lowercase address key from
    # the public payload (we keep the checksummed `address` field).
    formatted = []
    for r in rows:
        earnings = []
        for native, wei in sorted(r["earningsByNative"].items()):
            earnings.append({
                "native": native,
                "wei": str(wei),
                "formatted": format_price(wei, native),
            })
        formatted.append({
            "address": r["address"],
            "addressShort": shorten_address(r["address"]),
            "paintCount": r["paintCount"],
            "earnings": earnings,
            # name field is filled in later by resolve_ens_names; left
            # as None here so callers can run leaderboard build without
            # ENS resolution (e.g. during a dry run or if ENS fails).
            "name": None,
        })
    return formatted


def resolve_ens_names(leaderboard: list[dict]) -> None:
    """Resolve each row's ENS name in place by reverse-lookup on
    Ethereum mainnet. ENS only lives on Ethereum, but addresses are
    chain-agnostic, so a name set on mainnet applies cross-chain. Best
    effort: any failure (RPC unreachable, ens package missing, no
    primary name set) leaves `name` as None and the frontend falls
    back to the shortened address.
    """
    if not leaderboard:
        return
    try:
        from ens import ENS  # bundled with web3.py 7.x
    except ImportError:
        print("ens package not available; skipping ENS resolution", file=sys.stderr)
        return

    eth_rpc = (
        os.environ.get("ETHEREUM_RPC_URL")
        or next(c for c in CHAINS if c["id"] == 1)["rpc_default"]
    )
    try:
        w3_eth = Web3(Web3.HTTPProvider(eth_rpc))
        ns = ENS.from_web3(w3_eth)
    except Exception as err:
        print(f"ENS setup failed, skipping resolution: {err}", file=sys.stderr)
        return

    for row in leaderboard:
        try:
            name = ns.name(row["address"])
        except Exception as err:
            print(f"ENS lookup failed for {row['address']}: {err}", file=sys.stderr)
            continue
        if name:
            row["name"] = name


def write_leaderboard(leaderboard: list[dict], now_iso: str) -> None:
    """Always overwrite leaderboard.json. Same trade-off as summary.json:
    rewriting with a fresh generatedAt every run changes the file's
    git blob, but since CF Pages's content-aware skip won't see a
    meaningful diff when rows are identical, the rebuild storm risk
    is bounded to actual leaderboard movement.
    """
    payload = {
        "generatedAt": now_iso,
        "windowDays": SUMMARY_WINDOW_SECONDS // 86400,
        "topN": LEADERBOARD_TOP_N,
        "referrers": leaderboard,
    }
    LEADERBOARD_JSON_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LEADERBOARD_JSON_FILE.open("w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


# --- Founder scarcity (W1) + milestones (W2) ------------------------------
#
# Founder rank is the order of an address's FIRST paint on a chain. To turn
# that into "N of 100 Genesis slots left" copy, the bot needs the count of
# DISTINCT painters from the contract's deploy block to head — every paint,
# any size (a 1-pixel paint claims a slot). That's a different scan than the
# 7-day summary, so it gets its own incremental state in founders_state.json:
# we persist the distinct-painter set per chain and only scan new blocks
# each run. Once a chain hits FOUNDER_CAP the window is closed, so we drop
# the set and stop scanning that chain entirely.


def load_founders_state() -> dict:
    if not FOUNDERS_STATE_FILE.exists():
        return {}
    with FOUNDERS_STATE_FILE.open() as f:
        return json.load(f)


def save_founders_state(fstate: dict) -> None:
    with FOUNDERS_STATE_FILE.open("w") as f:
        json.dump(fstate, f, indent=2, sort_keys=True)
        f.write("\n")


def compute_founder_stats(count: int) -> dict:
    """Mirror of web/src/lib/founders.ts founderStatsFromCount. Keep the
    two in lockstep so bot copy and the on-site board never disagree."""
    capped = min(count, FOUNDER_CAP)
    genesis_claimed = min(capped, GENESIS_CAP)
    founder_claimed = max(0, capped - GENESIS_CAP)
    return {
        "claimed": capped,
        "genesisClaimed": genesis_claimed,
        "founderClaimed": founder_claimed,
        "genesisLeft": max(0, GENESIS_CAP - capped),
        "founderLeft": max(0, FOUNDER_CAP - GENESIS_CAP - founder_claimed),
        "totalLeft": max(0, FOUNDER_CAP - capped),
    }


def scan_founders(chain: dict, fstate: dict) -> bool:
    """Advance this chain's distinct-painter count toward head, persisting
    progress in fstate. Returns True when the count is current to head (so
    candidate copy can trust it), False when a cold backfill is still
    catching up (chunk budget exhausted this run; resumes next run).

    Mutates fstate[str(chain_id)] in place: lastBlock, painters, count, done.
    """
    cid = str(chain["id"])
    slot = fstate.setdefault(cid, {})
    if slot.get("done"):
        return True  # window closed; stored count is final, no scan needed

    rpc = os.environ.get(chain["rpc_env"]) or chain["rpc_default"]
    if not rpc:
        print(f"[{chain['name']}] founders: no RPC configured")
        return False

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        latest = w3.eth.block_number
    except Exception as err:
        print(f"[{chain['name']}] founders: RPC unreachable: {err}", file=sys.stderr)
        return False

    canvas_address = Web3.to_checksum_address(
        chain.get("canvas_address") or os.environ["CANVAS_ADDRESS"]
    )
    contract = w3.eth.contract(address=canvas_address, abi=PAINTED_EVENT_ABI)

    last = slot.get("lastBlock")
    from_block = chain.get("deploy_block", 0) if last is None else last + 1
    if from_block > latest:
        return True  # already current

    painters = set(slot.get("painters", []))
    window = chain.get("logs_window", LOGS_WINDOW)
    cur = from_block
    chunks = 0
    while cur <= latest:
        if chunks >= FOUNDERS_MAX_CHUNKS_PER_RUN:
            break  # budget spent; remaining blocks resume next run
        to = min(latest, cur + window)
        try:
            events = get_logs_with_retry(
                contract.events.Painted, cur, to, chain["name"],
            )
        except (ContractLogicError, ValueError, Web3RPCError, requests.exceptions.RequestException) as err:
            print(f"[{chain['name']}] founders chunk [{cur},{to}] failed: {err}", file=sys.stderr)
            cur = to + 1
            chunks += 1
            time.sleep(INTER_CHUNK_SLEEP_S)
            continue
        for ev in events:
            painters.add(ev["args"]["painter"].lower())
        slot["lastBlock"] = to  # persist progress per chunk so we resume cleanly
        cur = to + 1
        chunks += 1
        if len(painters) >= FOUNDER_CAP:
            break  # window full; count can't climb past the cap
        if cur <= latest:
            time.sleep(INTER_CHUNK_SLEEP_S)

    count = min(len(painters), FOUNDER_CAP)
    slot["count"] = count
    caught_up = cur > latest
    if count >= FOUNDER_CAP:
        slot["done"] = True
        slot["painters"] = []  # set no longer needed once the window is closed
        caught_up = True
    else:
        slot["painters"] = sorted(painters)
    print(
        f"[{chain['name']}] founders: {count} claimed, scanned to block "
        f"{slot.get('lastBlock', from_block)}, caughtUp={caught_up}"
    )
    return caught_up


# Milestone ladder, ascending significance. `reached` is monotonic in the
# claimed count, so once a threshold fires it stays fired. We mark every
# newly-crossed milestone as fired but only post the single most-significant
# one per chain per run, so a burst of paints never dumps a backlog of posts.
FOUNDER_MILESTONES = [
    {"key": "genesis-75",  "reached": lambda s: s["genesisClaimed"] >= 75},
    {"key": "genesis-90",  "reached": lambda s: s["genesisClaimed"] >= 90},
    {"key": "genesis-95",  "reached": lambda s: s["genesisClaimed"] >= 95},
    {"key": "genesis-full", "reached": lambda s: s["claimed"] >= GENESIS_CAP},
    {"key": "founder-50",  "reached": lambda s: s["founderClaimed"] >= 450},
    {"key": "founder-90",  "reached": lambda s: s["founderClaimed"] >= 810},
    {"key": "founder-full", "reached": lambda s: s["claimed"] >= FOUNDER_CAP},
]

_FOUNDER_TIER_RANGE = f"{GENESIS_CAP + 1}-{FOUNDER_CAP}"


def milestone_tweet(key: str, chain: dict, stats: dict) -> str:
    name = chain["name"]
    g_left = stats["genesisLeft"]
    f_left = stats["founderLeft"]
    pct = stats["genesisClaimed"]  # Genesis cap is 100, so claimed == percent
    if key in ("genesis-75", "genesis-90", "genesis-95"):
        return (
            f"Genesis is {pct}% claimed on {name}. Only {g_left} of {GENESIS_CAP} "
            f"founder slots left. Paint one pixel to claim a permanent on-chain "
            f"number. {FOUNDERS_URL}"
        )
    if key == "genesis-full":
        return (
            f"Genesis is FULL on {name}. All {GENESIS_CAP} founding slots are "
            f"claimed and permanent on-chain. Founder tier (ranks "
            f"{_FOUNDER_TIER_RANGE}) is now open. {FOUNDERS_URL}"
        )
    if key == "founder-50":
        return (
            f"The Founder window on {name} is half claimed. {f_left} of "
            f"{FOUNDER_CAP - GENESIS_CAP} Founder slots remain. {FOUNDERS_URL}"
        )
    if key == "founder-90":
        return (
            f"Only {f_left} Founder slots left on {name} before the window "
            f"closes for good. {FOUNDERS_URL}"
        )
    # founder-full
    return (
        f"The founder window has closed on {name}. All {FOUNDER_CAP} slots are "
        f"claimed, permanent and verifiable on-chain. {FOUNDERS_URL}"
    )


def scarcity_tweet(chain: dict, stats: dict) -> str | None:
    """Daily-pulse copy. None once the window is fully closed."""
    name = chain["name"]
    if stats["genesisLeft"] > 0:
        return (
            f"{stats['genesisLeft']} of {GENESIS_CAP} Genesis founder slots left "
            f"on {name}. Paint one pixel, claim a permanent on-chain founder "
            f"number. {FOUNDERS_URL}"
        )
    if stats["founderLeft"] > 0:
        return (
            f"Genesis is full on {name}. {stats['founderLeft']} Founder slots "
            f"remain (ranks {_FOUNDER_TIER_RANGE}). Paint a pixel to claim "
            f"yours, forever on-chain. {FOUNDERS_URL}"
        )
    return None


def founder_label(stats: dict) -> str:
    if stats["genesisLeft"] > 0:
        return f"{stats['genesisLeft']} of {GENESIS_CAP} Genesis left"
    if stats["founderLeft"] > 0:
        return f"{stats['founderLeft']} Founder slots left"
    return "Founder window closed"


def format_founder_md(chain: dict, kind: str, tweet: str) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"- [ ] **{chain['name']}** · {now} · founder {kind} · "
        f"[founders]({FOUNDERS_URL})\n"
        f"\n"
        f"  ```text\n"
        f"  {tweet}\n"
        f"  ```\n"
    )


def format_founder_json(
    eid: str, kind: str, chain: dict, stats: dict, tweet: str, now_iso: str,
) -> dict:
    return {
        "id": eid,
        "kind": kind,  # 'scarcity' | 'milestone'; paint entries omit this
        "chain": chain["name"],
        "chainId": chain["id"],
        "queuedAt": now_iso,
        "tier": "genesis" if stats["genesisLeft"] > 0 else "founder",
        "label": founder_label(stats),
        "tweet": tweet,
        "foundersUrl": FOUNDERS_URL,
    }


def generate_founder_candidates(
    chain: dict, fstate: dict, now_iso: str,
) -> tuple[list[str], list[dict]]:
    """At most one milestone (W2) and/or one daily scarcity pulse (W1) per
    chain per run. A milestone suppresses that run's scarcity pulse so the
    same chain isn't tweeted about twice in one tick.
    """
    cid = str(chain["id"])
    slot = fstate.get(cid, {})
    count = slot.get("count", 0)
    md: list[str] = []
    js: list[dict] = []
    # Need a real number to show. count == 0 means nobody's painted yet;
    # "be the first" launch copy is a manual/launch push, not the auto pulse.
    if count < 1:
        return md, js

    stats = compute_founder_stats(count)
    today = now_iso[:10]
    fired = set(slot.setdefault("milestonesFired", []))

    newly = [m for m in FOUNDER_MILESTONES if m["reached"](stats) and m["key"] not in fired]
    emitted_milestone = False
    if newly:
        for m in newly:
            fired.add(m["key"])
        slot["milestonesFired"] = sorted(fired)
        top = newly[-1]  # most significant crossed this run
        tweet = milestone_tweet(top["key"], chain, stats)
        eid = f"milestone-{chain['id']}-{top['key']}"
        md.append(format_founder_md(chain, "milestone", tweet))
        js.append(format_founder_json(eid, "milestone", chain, stats, tweet, now_iso))
        emitted_milestone = True

    if not emitted_milestone and slot.get("lastScarcityDate") != today:
        tweet = scarcity_tweet(chain, stats)
        if tweet:
            slot["lastScarcityDate"] = today
            eid = f"scarcity-{chain['id']}-{today}"
            md.append(format_founder_md(chain, "scarcity", tweet))
            js.append(format_founder_json(eid, "scarcity", chain, stats, tweet, now_iso))

    return md, js


def main() -> int:
    state = load_state()
    founders_state = load_founders_state()
    dry_run = os.environ.get("DRY_RUN", "").lower() in {"1", "true", "yes"}
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if dry_run:
        print("[DRY_RUN] QUEUE.md and queue.json will not be written")

    md_entries: list[str] = []
    json_entries: list[dict] = []
    for chain in CHAINS:
        remaining = MAX_PER_RUN - len(md_entries)
        if remaining <= 0:
            print("global per-run cap exhausted; deferring remaining chains to next run")
            break
        chain_md, chain_json = process_chain(chain, state, remaining, now_iso)
        md_entries.extend(chain_md)
        json_entries.extend(chain_json)

    # Newest first: reverse so the most recent paint across all chains
    # lands at the top of the queue. Within a chain, events are in block
    # order (oldest first); reversing the whole list inverts that. The
    # markdown and JSON lists are reversed in lockstep so they stay
    # aligned.
    md_entries.reverse()
    json_entries.reverse()

    # Weekly summary scan runs every cron tick. Independent of the
    # incremental queue scan: it always covers the trailing 7 days
    # regardless of state.json. Slightly redundant on quiet weeks, but
    # the cost is bounded and the output drives the /tweets page's
    # summary cards + the cross-chain referrer leaderboard.
    summaries: list[dict] = []
    per_chain_referrers: list[dict[str, dict]] = []
    rollup_parts: list[dict] = []
    if os.environ.get("SKIP_SUMMARY") not in {"1", "true", "yes"}:
        for chain in CHAINS:
            # One chain's RPC blowing up (e.g. HyperEVM's eth_getLogs
            # range cap) must never sink the whole run: a crash here
            # would skip write_summary entirely and freeze every chain's
            # data. Isolate each chain so the others still publish.
            try:
                s, referrers, parts = compute_weekly_summary(chain)
            except Exception as err:
                print(f"[{chain['name']}] summary scan crashed, skipping: {err}", file=sys.stderr)
                continue
            if s is not None:
                summaries.append(s)
                per_chain_referrers.append(referrers)
                rollup_parts.append(parts)
    else:
        print("SKIP_SUMMARY set; skipping weekly summary scan")

    # Roll up per-chain referrer data into a cross-chain leaderboard.
    # ENS resolution happens against Ethereum mainnet; we kick it
    # whether or not Ethereum was in the scan (the leaderboard is
    # chain-agnostic).
    chains_by_native = {c["native"]: c for c in CHAINS}
    leaderboard = build_referrer_leaderboard(per_chain_referrers, chains_by_native)
    if leaderboard:
        print(f"resolving ENS names for {len(leaderboard)} leaderboard row(s)")
        resolve_ens_names(leaderboard)
        with_names = sum(1 for r in leaderboard if r.get("name"))
        print(f"  {with_names}/{len(leaderboard)} resolved to a primary ENS name")

    # Founder scarcity (W1) + milestones (W2). Each chain's distinct-painter
    # count is advanced incrementally (resumable cold backfill), then turned
    # into at most one milestone and/or one daily scarcity candidate. These
    # land at the TOP of the queue (prepended after the paint reverse) so the
    # operator sees the timely founder copy first. Isolated per chain like
    # the summary scan so one chain's RPC can't sink the rest.
    founder_md: list[str] = []
    founder_json: list[dict] = []
    founder_caught_up: dict[str, bool] = {}
    if os.environ.get("SKIP_FOUNDERS") not in {"1", "true", "yes"}:
        for chain in CHAINS:
            try:
                caught_up = scan_founders(chain, founders_state)
            except Exception as err:
                print(f"[{chain['name']}] founder scan crashed, skipping: {err}", file=sys.stderr)
                continue
            founder_caught_up[str(chain["id"])] = caught_up
            if not caught_up:
                continue  # cold backfill still catching up; don't post a partial count
            try:
                fmd, fjs = generate_founder_candidates(chain, founders_state, now_iso)
            except Exception as err:
                print(f"[{chain['name']}] founder candidate gen failed: {err}", file=sys.stderr)
                continue
            founder_md.extend(fmd)
            founder_json.extend(fjs)
    else:
        print("SKIP_FOUNDERS set; skipping founder scan")

    # Prepend so founder candidates sit above paints in the freshly-reversed
    # (newest-first) queue.
    md_entries = founder_md + md_entries
    json_entries = founder_json + json_entries

    summary_window_days = SUMMARY_WINDOW_SECONDS // 86400
    all_chains = build_all_chains_rollup(summaries, rollup_parts, summary_window_days)
    founders_rollup = build_founders_rollup(founders_state, founder_caught_up)

    if dry_run:
        for entry in md_entries:
            print("---")
            print(entry)
        for entry in json_entries:
            print("[json] " + json.dumps(entry))
        for s in summaries:
            print("[summary] " + json.dumps(s))
        print("[allChains] " + json.dumps(all_chains))
        print("[founders] " + json.dumps(founders_rollup))
        for row in leaderboard:
            print("[leaderboard] " + json.dumps(row))
    else:
        write_queue(md_entries)
        write_queue_json(json_entries, now_iso)
        if summaries:
            write_summary(summaries, all_chains, founders_rollup, now_iso)
        write_leaderboard(leaderboard, now_iso)
        save_state(state)
        save_founders_state(founders_state)

    print(
        f"queued {len(md_entries) - len(founder_md)} paint(s) + "
        f"{len(founder_md)} founder candidate(s) this run; "
        f"summarised {len(summaries)} chain(s); "
        f"leaderboard has {len(leaderboard)} referrer(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
