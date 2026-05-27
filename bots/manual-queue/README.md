# Tagwall manual tweet queue

Replaces the original auto-posting `twitter-paints` bot. X moved to a paid
pay-per-use API in Feb 2026 (~$0.20 per tweet because every Tagwall
tweet includes a deep-link URL, which lands in the URL-surcharge tier).
Rather than burn $30–$600/month on auto-posts, this version surfaces
notable paints in a Markdown queue that the operator reviews on
github.com and posts by hand from `@tagwall_io_bot`.

## How it works

- `.github/workflows/manual-queue.yml` — cron every 30 min + manual dispatch.
- `main.py` — single-shot script. Reads `state.json` for the last block
  processed per chain, queries each chain for new `Painted` events,
  filters to "notable" paints (≥ `MANUAL_QUEUE_MIN_PIXELS` pixels),
  formats each as a ready-to-paste tweet, prepends them to **both**
  `QUEUE.md` (Markdown for git-side review) and `web/public/queue.json`
  (consumed by the `/tweets` page on tagwall.io).
- `QUEUE.md` — Markdown queue, newest paints at the top. Each entry has
  a checkbox and a fenced code block with the tweet text. The bot only
  ever prepends; it never modifies or removes existing entries.
- `../../web/public/queue.json` — JSON queue rendered by `tagwall.io/tweets`
  (see `web/src/pages/TweetsPage.tsx`). Trimmed to the most recent 200
  entries so the served file doesn't grow without bound.
- `state.json` — `{ chainId: lastProcessedBlock }`. Committed back to the
  repo by the workflow after each successful run, so the cron is
  effectively stateful without an external KV store.

## Operator workflow

Two surfaces, same data — pick whichever fits the moment:

**Web (recommended for routine use):** `https://tagwall.io/tweets`

1. Open the page in any browser. Newest paint at the top.
2. For each entry: click **Copy tweet**, optionally edit, post manually
   from `@tagwall_io_bot` on X, then click **Mark posted** to dim and
   collapse it. Posted state is per-browser localStorage.

**Git (when you want a permanent paper trail):**
`bots/manual-queue/QUEUE.md` on the repo web UI.

1. Open the file. Newest paint at the top, fenced code block per entry.
2. Copy → post → tick the checkbox (the web UI commits the edit) or
   delete the entry.

No X API key, no developer account, no metered API spend.

## Architecture

The bot runs on **GitHub Actions** against the public mirror
`github.com/tagwall/tagwall`. Bot commits — both new queue entries and
incremental `state.json` advances — land directly on the public repo.
The Cloudflare Worker watches `web/**` paths on that repo and rebuilds
`tagwall.io` when `web/public/queue.json` or `web/public/summary.json`
change, so the site stays in sync without any second-hop publish step.

The operator's private Git host holds the full project (PRD, council
notes, contracts, audits) but runs no automation. A separate publish
script syncs the public-safe slice from the private side → local
staging → this public GitHub repo when the operator changes anything
outside what the bot owns (e.g. frontend edits, contract changes that
affect the published files). The bot's data files (`queue.json`,
`summary.json`, `state.json`, `QUEUE.md`) are excluded from that
rsync so a publish never clobbers fresh bot output with stale local
copies.

## Configuration (on GitHub: tagwall/tagwall → Settings → Secrets and variables → Actions)

### Repository variables

| Name | Value |
|---|---|
| `CANVAS_ADDRESS` | the deployed Canvas address (CREATE2; same on every chain). `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415` for the launch deployment. |
| `PULSECHAIN_RPC_URL` | optional override of `rpc.pulsechain.com` |
| `BASE_RPC_URL` | optional override of `mainnet.base.org` |
| `BSC_RPC_URL` | optional override of `bsc-dataseed.binance.org` (consider Bloxroute `bsc.rpc.blxrbdn.com` to dodge log pruning) |
| `TAGWALL_BASE_URL` | optional, defaults to `https://tagwall.io` |
| `MANUAL_QUEUE_MIN_PIXELS` | optional, defaults to `100` |
| `MANUAL_QUEUE_MAX_PER_RUN` | optional, defaults to `50` |

### Repository secrets

| Name | Value |
|---|---|
| `ETHEREUM_RPC_URL` | Alchemy / paid provider URL (public Ethereum RPC won't survive the 7-day backfill scan) |

The Twitter / X secrets from the old `bots/twitter-paints/` bot
(`TWITTER_API_KEY`, etc.) are no longer used. They were never on the
public repo to begin with, so nothing to clean up there.

No GitHub PAT is needed. The workflow uses the built-in `GITHUB_TOKEN`
(scoped to this repo, `contents: write` granted by the workflow's
`permissions:` block) to push the bot's commits back.

### First run

Trigger manually from GitHub Actions → "Manual tweet queue" → **Run
workflow**. On the first run, `state.json` doesn't exist, so the bot
backfills the trailing 7 days of blocks on each chain (chain-aware:
~60k blocks on PulseChain, ~300k on Base — the run loops through
`LOGS_WINDOW`-sized chunks until caught up). Subsequent cron ticks
every 30 min are incremental from `state.json`.

Use the `dry_run` workflow input first to see what would land in the
queue without writing any files or pushing.

### Cloudflare Worker: restrict build watch paths

tagwall.io is served by a Workers Static Assets project (see
`wrangler.toml` at the repo root). The git integration rebuilds and
redeploys on every push to `main` by default. This bot commits to main
every 30 min on the cron, so without filtering the Worker would rebuild
~48 times/day.

In the Cloudflare dashboard, under **Workers → tagwall → Settings →
Build → Build watch paths**, set:

- **Include paths**: `web/**`
- **Exclude paths**: (leave empty)

That tells the Worker to skip a build unless the commit's diff touches
something under `web/`. State-only commits (just `state.json` and
`QUEUE.md`, both outside `web/`) become no-ops for the site. Only
commits that update `web/public/queue.json` or `web/public/summary.json`
(i.e., new notable paints actually surfaced to the page) trigger a
deploy. Practical rebuild rate: a handful per day in busy weeks, zero
on quiet days.

If you also want config edits (`wrangler.toml`) to redeploy automatically,
add it to the Include paths.

Common pitfall: the dashboard's default is **Include `*` / Exclude
`web/**`**, which is the opposite of what we want — it builds on every
bot state commit but skips the queue commits that actually need to ship.
Make sure the values are flipped.

## Tuning

### Queue length

`MANUAL_QUEUE_MIN_PIXELS=100` (default) is the original Twitter-bot
threshold. Raise to 500 or 1,000 if the queue is too noisy. Single-
pixel reservation paints are always skipped.

`MANUAL_QUEUE_MAX_PER_RUN=50` (default) caps a runaway first-run flood.
Cron ticks every 30 min, so even in a busy week the queue can't grow by
more than ~2,400 entries/day at the absolute ceiling. In practice the
`MIN_PIXELS` filter trims that to a handful per run.

### Tweet copy

Four phrasing variants picked deterministically by tx-hash, identical
to the original twitter-paints bot. Edit `TWEET_VARIANTS` and
`format_referrer_suffix()` in `main.py` to change. Operator can also
freely edit any individual tweet before posting; the variant is just a
starting point.

When the paint had a non-zero, non-self referrer, the bot appends a
suffix surfacing the on-chain affiliate program:

```
… ↪ ref 0xa12b…e7d1 +375 PLS
```

### Reorg sensitivity

The script doesn't lag from `latest` for finality, so a few-block
reorg between cron ticks could miss a paint or duplicate one in the
queue. Duplicates are operator-visible and easy to delete. If reorgs
become a real issue, change `latest` to `latest - 12` in `process_chain`
for finality lag.

## Reverting to auto-posting

If X API pricing ever drops back into the affordable range, the
original auto-posting bot is preserved in `bots/twitter-paints/`. Its
workflow at `.github/workflows/twitter-bot.yml` is disabled (the cron
trigger is removed; only manual dispatch remains). To re-enable:

1. Restore the `schedule:` block in `twitter-bot.yml`.
2. Restore the Twitter secrets from the original README.
3. Disable the cron on `manual-queue.yml` (or delete it).

The two systems use independent `state.json` files so they won't
interfere if you ever run them in parallel.
