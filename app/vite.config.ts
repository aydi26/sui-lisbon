// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.app
// @phase      0
// @status     DONE
// @spec       docs/BUILD-PLAN.md "Cross-cutting units" (X.app — the app build)
// @spec       docs/RECON.md R13 (landing deps: globe.gl ^2.45.3 + three ^0.183.2)
// @rules      G7
// @depends    package.json (X.app)
// @facts      BUILD_OUTDIR = 'dist'
// @facts      GLOBE_CHUNK = { three, three-globe, globe.gl } — ~1.2 MB, must not
// @facts        enter the entry chunk or the 3 vault screens pay for the hero.
// @facts      `global: 'globalThis'` — some browser-shimmed deps in the Sui/Walrus
// @facts        lineage reference `global`; Vite does not define it by default.
// @implements export default defineConfig({...})
// @forbidden  hardcoding any canonical on-chain ID here — G7 (only src/config.ts,
//             .env.example, keeper/src/config.ts, move/Move.toml may hold them)
// @invariant  1. Nothing under src/landing/ is imported statically from the entry —
//                the landing page is ALWAYS React.lazy'd (see src/routes.tsx).
// @ac         docs/BUILD-PLAN.md "Cross-cutting units" X.app — `cd app && npm run
//             build && npm test` is the unit's VERIFY, so the build must be clean
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Packages that make up the 3D hero. Split out so the vault screens never load them. */
const GLOBE_PACKAGES = ['three', 'three-globe', 'globe.gl'];

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          const normalized = id.replace(/\\/g, '/');
          for (const pkg of GLOBE_PACKAGES) {
            if (normalized.includes(`/node_modules/${pkg}/`)) return 'globe';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
