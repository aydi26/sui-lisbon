// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.0
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (parity levels L1 golden / L2 property / L3 devInspect)
// @rules      G5
// @facts      L2 runs 10_000 property cases ⇒ the default 5 s per-test timeout is too small.
// @facts      NO test in this package may open a socket: every algorithm here is pure.
// @implements export default defineConfig({...})
// @forbidden  a network-touching test — the whole suite must run offline
// @verify     npx vitest run
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The property suite (L2) is CPU-bound: 10_000 clearings, each hashed twice.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    sequence: { shuffle: false },
    reporters: ['default'],
  },
});
