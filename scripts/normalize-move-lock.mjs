#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       ops — cross-platform build, no BUILD-PLAN unit id
// @phase      ops
// @status     DONE
// @spec       PR #1 "build off Windows" · CLAUDE.md blocker B8
// @rules      G7
// @facts      ★ THE BUG. `Move.lock` pins each git dependency with a `subdir`.
// @facts        The Windows Move toolchain writes that path with BACKSLASHES:
// @facts        `subdir = 'crates\sui-framework\packages\move-stdlib'`. Off Windows
// @facts        the resolver treats the whole thing as ONE literal directory name
// @facts        and dies with `Invalid directory`. The package then does not build
// @facts        AT ALL on macOS or Linux — no build, no test, no publish. Forward
// @facts        slashes are valid on every platform, Windows included.
// @facts      ★ WHY THIS FILE EXISTS RATHER THAN A ONE-OFF EDIT. `sui move build`
// @facts        REWRITES the lock every time it runs on Windows, so a hand-fix
// @facts        survives exactly until the next build. Observed 2026-07-26: the fix
// @facts        landed, `scripts/verify-all.ps1` ran, and the backslashes were back
// @facts        within the minute. This is idempotent and safe to run repeatedly;
// @facts        the `movelock` gate FAILS while any backslash remains, so the
// @facts        regression is loud instead of silent.
// @facts      ⚠ Only `subdir = '...'` values are touched. A `rev`, a URL or a digest
// @facts        is never rewritten — this must not be able to change what is pinned.
// @implements node scripts/normalize-move-lock.mjs [--check]
// @forbidden  rewriting anything but a `subdir` value
// @invariant  1. Idempotent: a second run reports zero changes.
// @invariant  2. `--check` mutates nothing and exits non-zero if a fix is needed.
// @verify     node scripts/normalize-move-lock.mjs --check
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKS = [join(REPO, 'move', 'Move.lock'), join(REPO, 'lending', 'Move.lock')];
const CHECK = process.argv.includes('--check');

// `subdir = 'a\b\c'` or `subdir = "a\b\c"`. Only the VALUE is rewritten, and only
// its separators — never a rev, a URL or a manifest digest.
const SUBDIR = /subdir\s*=\s*(['"])([^'"]*)\1/g;

let offenders = 0;

for (const path of LOCKS) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.log(`  skip   ${path} (absent)`);
    continue;
  }

  const changed = [];
  const fixed = text.replace(SUBDIR, (whole, _quote, value) => {
    if (!value.includes('\\')) return whole;
    const normalized = value.replaceAll('\\', '/');
    changed.push(`${value} → ${normalized}`);
    // Always emit double quotes: that is what the non-Windows toolchain writes,
    // so a lock normalised here is byte-identical to one produced on macOS.
    return `subdir = "${normalized}"`;
  });

  if (changed.length === 0) {
    console.log(`  ok     ${path}`);
    continue;
  }

  offenders += changed.length;
  for (const c of changed) console.log(`  ${CHECK ? 'BAD  ' : 'fix  '}  ${path}: ${c}`);
  if (!CHECK) writeFileSync(path, fixed, 'utf8');
}

if (offenders === 0) {
  console.log('\n  Move.lock subdirs are forward-slashed — builds on macOS and Linux.\n');
  process.exit(0);
}

if (CHECK) {
  console.error(
    `\n  ✗ ${offenders} backslashed subdir(s). The package will NOT build off Windows.\n` +
      '    Fix:  node scripts/normalize-move-lock.mjs\n' +
      '    Cause: `sui move build` on Windows rewrites Move.lock. Re-run this after every build.\n',
  );
  process.exit(1);
}

console.log(`\n  ✓ normalised ${offenders} subdir(s). Commit the lockfile.\n`);
