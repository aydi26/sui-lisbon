// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.10
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9
// @rules      G7
// @facts      Entry point for `node --import ./scripts/register-ts.mjs ...`.
// @implements register('./ts-resolve.mjs', import.meta.url)
// @verify     node --import ./scripts/register-ts.mjs scripts/gen-golden.mjs --check
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
