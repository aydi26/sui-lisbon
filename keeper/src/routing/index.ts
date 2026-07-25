// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE   (barrel only — book/deepbook/route/taker are all DONE as of T2.7)
// @spec       docs/KEEPER.md §1 (top-level layout), §4 (routing/)
// @rules      G4 G5 G7 G9
// @depends    ./book.ts · ./deepbook.ts · ./route.ts · ./taker.ts
// @facts      Layer split: ./book.ts = PURE maths · ./deepbook.ts = the ONLY transport (simulation
// @facts        of `pool::get_level2_range`, never the hosted indexer) · ./route.ts = PURE maker/IOC
// @facts        split · ./taker.ts = the deterministic book seeder (a hard requirement, R10).
// @facts      G4: DeepBook only. No Cetus taker leg, no CLMM ranges — no Cetus hBTC pool exists.
// @implements export * from './book.js' | './deepbook.js' | './route.js' | './taker.js'
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) anywhere under routing/
// @forbidden  any non-DeepBook venue leg, and any concentrated-liquidity range logic (G4, gates.ps1 g4)
// @invariant  1. Re-export surface only; this file contains no logic.
// @verify     npm run test -- routing
// └── END CONTRACT ───────────────────────────────────────────────────────────

export * from './book.js';
export * from './deepbook.js';
export * from './route.js';
export * from './taker.js';
