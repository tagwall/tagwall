# Tagwall

Pre-launch placeholder for [tagwall.io](https://tagwall.io).

This repo currently contains only the holding page that lives at
tagwall.io. The full canvas frontend will be published here at launch.

## Files

- `holding/index.html` — the static placeholder served at tagwall.io
- `holding/favicon.svg` — lime square favicon
- `wrangler.toml` — Cloudflare Workers Static Assets config

## Hosting

Deployed to Cloudflare Workers via the platform's Git integration. Any
push to `main` triggers a rebuild + deploy. Build command is a no-op
(no compilation needed for static HTML); the `wrangler deploy` step
uploads `./holding/`.

## License

[MIT](LICENSE).
