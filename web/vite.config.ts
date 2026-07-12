import { execFileSync } from 'node:child_process'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Short commit of the build, for the footer version string. Prefer git
// (the CI checkout is a repo); fall back to the CI-provided SHA, then
// 'local' for a plain dev build. Static argv, no shell — no injection surface.
function buildCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()
  } catch {
    // ignore — fall through to CI env / local
  }
  const sha =
    process.env.WORKERS_CI_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA
  return sha ? sha.slice(0, 7) : 'local'
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [react()],
  resolve: {
    // Resolve deps via the symlink path, not the realpath. Locally,
    // `node_modules` is a symlink -> `node_modules.nosync` (the .nosync
    // suffix keeps iCloud from syncing/corrupting the deps). Without this,
    // vite dev canonicalizes to `node_modules.nosync/...`, which lacks the
    // literal `/node_modules/` segment, so its oxc transform tries to
    // compile deps (e.g. viem) as project source and fails with
    // TSCONFIG_ERROR. Inert in CI/prod where node_modules is a real dir
    // (no symlinks), and safe for npm's flat node_modules.
    preserveSymlinks: true,
    alias: {
      // Bare `import 'buffer'` must resolve to the npm polyfill, not
      // Vite's externalized node-builtin stub (which is empty in the
      // browser and intermittently broke @solana/web3.js depending on
      // the prebundle cache). The trailing slash forces the package.
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  server: {
    // /api/* is served by the Cloudflare Worker (web/worker/index.js) in
    // prod. In `vite dev` there's no Worker, so proxy /api to a local
    // `wrangler dev` (default below) when it's running; otherwise these
    // calls just fail and the UI falls back to a generic label.
    proxy: {
      '/api': { target: 'http://localhost:8799', changeOrigin: true },
    },
  },
})
