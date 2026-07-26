// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.0
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (no build step: "exports": { "./*": "./src/*.ts" })
// @rules      G7
// @depends    every module in this package
// @facts      Consumers import per-module — `@aphotic/sdk/clearing`, `@aphotic/sdk/seal/identity`
// @facts        — via the keeper's tsconfig `paths` and the app's vite `resolve.alias`.
// @facts        This barrel exists for convenience and for the "one import, everything" test;
// @facts        it is NOT the only entry point and must never become one.
// @implements export * from './...'  (every public module)
// @forbidden  adding side-effectful code here — importing the barrel must stay free
// @invariant  1. Importing this file executes no I/O and reads no clock.
// @ac         test/index.test.ts — the barrel re-exports every documented symbol
// @verify     npx vitest run index
// └── END CONTRACT ───────────────────────────────────────────────────────────

export * from './address.js';
export * from './bcs.js';
export * from './cadence.js';
export * from './clearing.js';
export * from './hash.js';
export * from './math.js';
export * from './merkle.js';
export * from './nav.js';
export * from './rng.js';
export * from './seal/committee.js';
export * from './seal/identity.js';

// `notes` and `order` both export a `commitment` — namespaced to keep the barrel unambiguous.
export * as notes from './notes.js';
export * as order from './order.js';
