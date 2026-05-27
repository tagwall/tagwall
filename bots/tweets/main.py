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
  5. Commits any changed files back to the public repo. CF Worker
     watches `web/**` and rebuilds tagwall.io on the next push.

Env (all optional; only CANVAS_ADDRESS is strictly required):
  CANVAS_ADDRESS         — CREATE2 address, identical on every chain
  PULSECHAIN_RPC_URL     — override for PulseChain (default rpc.pulsechain.com)
  ETHEREUM_RPC_URL       — override for Ethereum (default eth.drpc.org)
  BASE_RPC_URL           — override for Base (default base.publicnode.com)
  BSC_RPC_URL            — override for BSC (default bsc-dataseed.binance.org)
  TAGWALL_BASE_URL       — defaults to https://tagwall.io
  TWEETS_MIN_PIXELS      — defaults to 100 (alias: MANUAL_QUEUE_MIN_PIXELS)
  TWEETS_MAX_PER_RUN     — defaults to 50  (alias: MANUAL_QUEUE_MAX_PER_RUN)
  SKIP_SUMMARY           — '1' to skip the weekly summary scan
  DRY_RUN                — '1' to scan-and-print without writing or pushing
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from web3 import Web3
from web3.exceptions import ContractLogicError

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
    },
    {
        "id": 56,
        "name": "BSC",
        "rpc_env": "BSC_RPC_URL",
        "rpc_default": "https://bsc-dataseed.binance.org",
        "native": "BNB",
        "explorer_tx": "https://bscscan.com/tx/",
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
CHAIN_BLOCK_TIME_S = {369: 10, 1: 12, 8453: 2, 56: 3}
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
scanning all four EVM chains for `Painted` events at or above
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
    the existing tail. No-op if new_entries is empty.
    """
    if not new_entries:
        return
    head, tail = read_existing_queue()
    body = "\n".join(new_entries)
    QUEUE_FILE.write_text(f"{head}\n{body}\n{tail}")


def write_queue_json(new_entries_json: list[dict], now_iso: str) -> None:
    """Prepend new_entries_json (already newest-first) to the existing
    queue.json, trim to JSON_QUEUE_KEEP, write to web/public/queue.json.
    No-op if new_entries_json is empty.

    Note: we *do* update generatedAt only when the entry list changes,
    so a no-op run leaves the file byte-identical and the CF Pages
    'watch web/**' rule doesn't trigger a deploy.
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

    canvas_address = Web3.to_checksum_address(os.environ["CANVAS_ADDRESS"])
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
        blocks_back = SUMMARY_WINDOW_SECONDS // block_time
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
        to_block = min(latest, cur + LOGS_WINDOW)
        try:
            events = get_logs_with_retry(
                contract.events.Painted, cur, to_block, chain["name"],
            )
        except (ContractLogicError, ValueError, requests.exceptions.RequestException) as err:
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


def compute_weekly_summary(chain: dict) -> dict | None:
    """Scan the trailing SUMMARY_WINDOW_SECONDS of Painted events on
    this chain and return aggregate stats. Returns None if the RPC is
    unavailable. An empty window (no paints this week) still returns a
    summary with paintCount: 0 so the frontend can render "no activity
    yet" instead of hiding the chain entirely.

    Note: this is a fresh scan every run. Not incremental. With a
    LOGS_WINDOW of 5,000 it's ~12 calls/week on PulseChain (~10s block
    time), more on Base/BSC (faster blocks). Acceptable for a cron that
    runs every 30 min; if it becomes a bottleneck, switch to a rolling
    state-cached aggregator.
    """
    rpc = os.environ.get(chain["rpc_env"]) or chain["rpc_default"]
    if not rpc:
        print(f"[{chain['name']}] summary: no RPC configured")
        return None

    w3 = Web3(Web3.HTTPProvider(rpc))
    try:
        latest = w3.eth.block_number
    except Exception as err:
        print(f"[{chain['name']}] summary: RPC unreachable: {err}", file=sys.stderr)
        return None

    canvas_address = Web3.to_checksum_address(os.environ["CANVAS_ADDRESS"])
    contract = w3.eth.contract(address=canvas_address, abi=PAINTED_EVENT_ABI)
    view_contract = w3.eth.contract(address=canvas_address, abi=CANVAS_VIEW_ABI)
    try:
        floor_wei = view_contract.functions.startingPrice().call()
    except Exception:
        floor_wei = 0

    block_time = CHAIN_BLOCK_TIME_S.get(chain["id"], 10)
    blocks_back = SUMMARY_WINDOW_SECONDS // block_time
    from_block = max(0, latest - blocks_back)

    paint_count = 0
    overpaint_count = 0
    total_volume_wei = 0
    unique_painters: set[str] = set()
    # Each "biggest" tracks (sort-key, args-dict, tx-hash-hex) for the
    # winning event. Updated in place during the scan; None until the
    # first event is seen.
    biggest_by_pixels: tuple[int, dict, str] | None = None
    biggest_by_price: tuple[int, dict, str] | None = None

    cur = from_block
    while cur <= latest:
        to = min(latest, cur + LOGS_WINDOW)
        try:
            events = get_logs_with_retry(
                contract.events.Painted, cur, to, chain["name"],
            )
        except (ContractLogicError, ValueError, requests.exceptions.RequestException) as err:
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
            unique_painters.add(args["painter"].lower())
            if is_overpaint(args["pricePaid"], args["pixelsPainted"], floor_wei):
                overpaint_count += 1
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

    print(
        f"[{chain['name']}] summary: {paint_count} paints, "
        f"{overpaint_count} overpaints, {len(unique_painters)} unique painters"
    )

    return {
        "chain": chain["name"],
        "chainId": chain["id"],
        "native": chain["native"],
        "windowStartBlock": from_block,
        "windowEndBlock": latest,
        "paintCount": paint_count,
        "overpaintCount": overpaint_count,
        "uniquePainters": len(unique_painters),
        "totalVolumeFormatted": format_price(total_volume_wei, chain["native"]),
        "biggestByPixels": fmt_peak(biggest_by_pixels),
        "biggestByPrice": fmt_peak(biggest_by_price),
    }


def write_summary(summaries: list[dict], now_iso: str) -> None:
    """Always overwrite summary.json with the current snapshot. Unlike
    queue.json, summary stats are stateless: every run recomputes from
    scratch, so a no-op run still produces a fresh `generatedAt` but
    likely identical chain stats. CF Pages's content-aware build-skip
    will catch the case where nothing actually changed.
    """
    payload = {
        "generatedAt": now_iso,
        "windowDays": SUMMARY_WINDOW_SECONDS // 86400,
        "chains": summaries,
    }
    SUMMARY_JSON_FILE.parent.mkdir(parents=True, exist_ok=True)
    with SUMMARY_JSON_FILE.open("w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def main() -> int:
    state = load_state()
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
    # the cost is bounded and the output drives the /queue page's
    # summary cards.
    summaries: list[dict] = []
    if os.environ.get("SKIP_SUMMARY") not in {"1", "true", "yes"}:
        for chain in CHAINS:
            s = compute_weekly_summary(chain)
            if s is not None:
                summaries.append(s)
    else:
        print("SKIP_SUMMARY set; skipping weekly summary scan")

    if dry_run:
        for entry in md_entries:
            print("---")
            print(entry)
        for entry in json_entries:
            print("[json] " + json.dumps(entry))
        for s in summaries:
            print("[summary] " + json.dumps(s))
    else:
        write_queue(md_entries)
        write_queue_json(json_entries, now_iso)
        if summaries:
            write_summary(summaries, now_iso)
        save_state(state)

    print(f"queued {len(md_entries)} paint(s) this run; summarised {len(summaries)} chain(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
