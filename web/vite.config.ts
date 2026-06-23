import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
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
