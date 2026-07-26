// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.nav
// @phase      2
// @status     DONE
// @spec       docs/CONVENTIONS.md §1 (one barrel per module directory)
// @spec       docs/DESIGN-V2.md §7 (the KeeperCap surface — propose only, never approve)
// @rules      G2 G10
// @implements export * from './propose.js'
// @forbidden  exporting an approve path from this directory — that is the admin multisig's leg
// @verify     npm run typecheck
// └── END CONTRACT ───────────────────────────────────────────────────────────

export * from './propose.js';
