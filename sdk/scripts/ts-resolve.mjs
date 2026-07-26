// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.10
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (no build step: consumers read src/*.ts directly)
// @rules      G7
// @facts      TypeScript's NodeNext ESM rules REQUIRE `./x.js` specifiers in `.ts` sources.
// @facts        Node's own type-stripping does NOT rewrite them, so plain
// @facts        `node script.mjs` cannot import this package's sources. Vitest can (Vite
// @facts        resolves the extension), which is why the TESTS work without this shim and the
// @facts        fixture GENERATORS need it.
// @facts      Node >= 23.6 strips types by default; older Node needs --experimental-strip-types.
// @implements export async function resolve(specifier, context, next)
// @forbidden  using this in any runtime path — it exists only for scripts/ and only offline
// @invariant  1. Only rewrites `./x.js` / `../x.js` when `x.js` is ABSENT and `x.ts` is present.
// @verify     node --import ./scripts/register-ts.mjs scripts/gen-golden.mjs --check
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL
  ) {
    const jsUrl = new URL(specifier, context.parentURL);
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
    const tsUrl = new URL(tsSpecifier, context.parentURL);
    if (!existsSync(fileURLToPath(jsUrl)) && existsSync(fileURLToPath(tsUrl))) {
      return next(tsSpecifier, context);
    }
  }
  return next(specifier, context);
}
