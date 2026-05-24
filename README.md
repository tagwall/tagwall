# Tagwall

A 1,000,000-pixel on-chain graffiti wall. Immutable. No admin. No moderator. No ads.

Live at **[tagwall.io](https://tagwall.io)** since 2026-05-24.

## Chains

CREATE2 deploy, identical bytecode, same address on every chain:

| Chain | Canvas address | Starting price per pixel |
|---|---|---|
| PulseChain | `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415` | 6,700 PLS (~$0.05) |
| Ethereum | `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415` | 21,700 gwei (~$0.05) |
| Base | `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415` | 21,700 gwei (~$0.05) |
| BSC | `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415` | 81,000 gwei (~$0.05) |

Per-pixel overwrite premium: 1.10× the last paid price. After 90 days, painted pixels decay 10% per month back toward the floor.

## What's in this repo

This is the public mirror of the official frontend. The contract is fully immutable; this frontend is interchangeable with any fork.

| Path | Purpose |
|---|---|
| `web/` | React + Vite + wagmi/viem canvas app (the live frontend) |
| `holding/` | Pre-launch static placeholder (archived, no longer served) |
| `wrangler.toml` | Cloudflare Workers Static Assets config |
| `LICENSE` | MIT |

## Running your own mirror

```bash
git clone https://github.com/tagwall/tagwall.git
cd tagwall/web
npm ci
npm run build
# Deploy web/dist/ to any static host (Cloudflare Pages, Vercel,
# Netlify, GitHub Pages, S3, a $5 VPS, anywhere).
```

Customise chain RPCs, theme, and (optionally) the URL filter list in `web/src/` before building. The Canvas contract address is the same on every chain so the same bundle works for all four; just point your dropdown at whichever chains you support.

## Filter policy

The official frontend at tagwall.io applies third-party hash lists only:

- Cloudflare CSAM scanning
- Chainalysis OFAC oracle (sanctioned addresses)
- Google Safe Browsing (malicious URLs)

It does not curate an internal block list. Mirrors are free to filter more strictly, apply no filter, or substitute their own lists. The chain has no opinion; each frontend chooses.

If a filtered link belongs to you and you believe it was hit in error, email `abuse@tagwall.io`. The on-chain paint stays; only the official frontend's display is affected.

## Hosting

The live tagwall.io is hosted on Cloudflare Workers via the platform's Git integration. Any push to `main` triggers a build (`npm --prefix web ci && npm --prefix web run build`) and serves `./web/dist/`.

## License

[MIT](LICENSE). Use, fork, modify, mirror, monetise. No restrictions on the frontend code. The contract is its own permanent on-chain artifact.

## Links

- [tagwall.io](https://tagwall.io)
- [@tagwall_io](https://x.com/tagwall_io) on X
