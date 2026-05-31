import { defineConfig } from 'vitest/config'

// Tests live in test/ (outside src/) so the app build's `tsc -b` never
// type-checks them. The unit suite is pure and runs anywhere; the anvil
// suite self-skips when no local chain is reachable (see its beforeAll),
// so `vitest run` is safe in CI without a node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The anvil integration test pre-paints a band several times and waits
    // on real receipts; give it room beyond the 5s default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
