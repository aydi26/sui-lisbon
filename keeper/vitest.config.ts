// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3
// @phase      0
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.3 VERIFY: `cd keeper && npm test`)
// @spec       docs/KEEPER.md §13 (acceptance A1: `HASHI_ADAPTER=mock npm test`)
// @rules      G7
// @facts      HASHI_ADAPTER defaults to `mock` — CI/dev NEVER touch live Hashi (G7).
// @implements export default defineConfig({...})
// @forbidden  any test that opens a network socket — the whole suite must run offline
// @verify     npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // G7: the default adapter is the deterministic MOCK. No test may reach the network.
    env: {
      HASHI_ADAPTER: 'mock',
    },
    // Deterministic ordering — these suites are pure/logical-clock based.
    sequence: { shuffle: false },
    reporters: ['verbose'],
  },
});
