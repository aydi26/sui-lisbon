// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6, T5.1
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE   (barrel; params/serialize/evaluate/pegflow behind it are all DONE — T2.6/T5.1)
// @spec       docs/KEEPER.md §1 (top-level layout), §3 (strategy/)
// @rules      G4 G5 G7 G8
// @depends    ./params.ts · ./serialize.ts · ./evaluate.ts · ./pegflow.ts
// @facts      The strategy layer is PURE end-to-end: nothing here reads a clock, a socket, or an
// @facts        adapter. Inputs arrive as arguments so `verify/` can replay every decision (G5).
// @facts      Seal encrypt/decrypt of these parameters lives in ../privacy/, NOT here — this layer
// @facts        never touches key material.
// @implements export * from './evaluate.js' | './params.js' | './pegflow.js' | './serialize.js'
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) anywhere under strategy/
// @forbidden  a Cetus/CLMM code path — the venue is fixed by G4
// @invariant  1. Re-export surface only; this file contains no logic.
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

export * from './evaluate.js';
export * from './params.js';
export * from './pegflow.js';
export * from './serialize.js';
