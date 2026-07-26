// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §2 (hard constraints), §13 (limitations are published)
// @rules      G2 G3 G5 G6 G7 G8
// @depends    ./package.json · ./vite.config.ts (mirrored, NOT imported — vitest
//             ignores vite.config.ts once this file exists)
// @facts      Vitest 3 loads THIS file INSTEAD of vite.config.ts, so the react
// @facts        plugin and `define: { global: 'globalThis' }` are repeated here.
// @facts      Default environment is `node`: the pure modules under test (bech32,
// @facts        format, depositAddress, hashi adapter, enoki) have no DOM. Files
// @facts        that render React opt in with `// @vitest-environment jsdom`.
// @facts      `test.env` PINS every VITE_* the suite reads so a developer's
// @facts        app/.env.local (gitignored, machine-specific) can never change a
// @facts        result. Determinism is the point (G6).
// @implements export default defineConfig({ test: { … } })
// @forbidden  a network call from any test — the suite must be fully offline
// @invariant  1. Tests never mutate app/src; they only import it.
// @ac         cd app && npm test
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  // No .env* file lives under test/, so nothing ambient leaks into the suite.
  envDir: 'test',
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Pinned so `.env.local` cannot influence the suite. Every id-bearing var
    // the app reads is listed here EXPLICITLY, empty, so the suite always
    // exercises the worst configuration: a build that shipped without them.
    env: {
      VITE_ENOKI_API_KEY: '',
      VITE_ZKLOGIN_CLIENT_ID: '',
      VITE_ENOKI_REDIRECT_URL: '',
      VITE_APHOTIC_PACKAGE_ID: '',
      VITE_APHOTIC_ORIGINAL_PACKAGE_ID: '',
      VITE_VAULT_ID: '',
      VITE_GOVERNANCE_ID: '',
      VITE_BATCH_REGISTRY_ID: '',
      VITE_NOTE_TREE_ID: '',
      VITE_NULLIFIER_SET_ID: '',
      VITE_BALANCE_LEDGER_ID: '',
      VITE_ADAPTER_ALLOWLIST_ID: '',
      VITE_SEAL_KEY_SERVER_IDS: '',
      VITE_SEAL_KEY_SERVER_URLS: '',
      VITE_WALRUS_PUBLISHER: '',
      VITE_CUSTODY_MULTISIG: '',
      VITE_REDEMPTION_ADDRESS: '',
    },
    restoreMocks: true,
  },
});
