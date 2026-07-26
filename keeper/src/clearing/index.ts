// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P3.clearing
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md §9 (clearing parity is a RELEASE BLOCKER)
// @rules      G5 G10
// @depends    ./bytes.ts · ./engine.ts
// @facts      The keeper's clearing surface. `engine.clear` is THE local implementation the
// @facts        keeper predicts settlement with; `./bytes.ts` is the byte layer both it and the
// @facts        Merkle proofs share.
// @implements export * from './bytes.js'
// @implements export * from './engine.js'
// @forbidden  a second copy of the algorithm anywhere in keeper/src
// @verify     npm run test -- clearing
// └── END CONTRACT ───────────────────────────────────────────────────────────

export * from './bytes.js';
export * from './engine.js';
