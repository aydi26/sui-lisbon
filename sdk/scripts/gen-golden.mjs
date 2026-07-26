// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L1 (the shared golden fixtures)
// @rules      G5
// @depends    ../fixtures/clearing.golden.json · ../test/support/clearingFixtures.ts
// @facts      This script does TWO things and must never do a third:
// @facts        1. VERIFY every hand-derived field in the fixture against clear(). A mismatch is
// @facts           a hard failure — it means either the hand arithmetic or the algorithm is
// @facts           wrong, and both are worth knowing about loudly.
// @facts        2. WRITE the one field that cannot be hand-computed: `fillsRoot` (plus `fills`
// @facts           for cases marked "pinned", i.e. the 256/512-order batches).
// @facts      ★ It NEVER overwrites a hand-written scalar or fill row. If it disagrees, it
// @facts        REPORTS and exits 1. That asymmetry is the whole value of the file.
// @implements node --import ./scripts/register-ts.mjs scripts/gen-golden.mjs [--check]
// @forbidden  silently "fixing" a fixture to match the code — that inverts the test
// @invariant  1. --check never writes.
// @invariant  2. Exit code 0 iff every case verified.
// @verify     node --import ./scripts/register-ts.mjs scripts/gen-golden.mjs --check
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { clear } from '../src/clearing.ts';
import { toHex } from '../src/hash.ts';
import { buildBalances, buildOrders, expectedFills } from '../test/support/clearingFixtures.ts';

const CHECK_ONLY = process.argv.includes('--check');
const PATH = fileURLToPath(new URL('../fixtures/clearing.golden.json', import.meta.url));

const raw = readFileSync(PATH, 'utf8');
const file = JSON.parse(raw);

const problems = [];
let wrote = 0;

function cmp(caseName, field, actual, expected) {
  if (expected === undefined || expected === null) return false; // nothing hand-written
  if (String(actual) !== String(expected)) {
    problems.push(`${caseName}: ${field} — fixture says ${expected}, clear() says ${actual}`);
  }
  return true;
}

for (const c of file.cases) {
  const orders = buildOrders(c, file.addresses);
  const balances = buildBalances(c, file.addresses);
  const input = { orders, balances, feeMatchedBps: BigInt(c.feeMatchedBps) };

  if (c.expectThrow) {
    let threw = null;
    try {
      clear(input);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    if (threw === null) {
      problems.push(`${c.name}: expected a throw matching "${c.expectThrow}", got a result`);
    } else if (!threw.includes(c.expectThrow)) {
      problems.push(`${c.name}: expected a throw matching "${c.expectThrow}", got "${threw}"`);
    }
    continue;
  }

  let r;
  try {
    r = clear(input);
  } catch (e) {
    problems.push(`${c.name}: clear() threw unexpectedly — ${e instanceof Error ? e.message : e}`);
    continue;
  }

  const e = c.expect;
  if (!e) {
    problems.push(`${c.name}: no \`expect\` block and no \`expectThrow\``);
    continue;
  }

  cmp(c.name, 'cleared', r.cleared, e.cleared);
  cmp(c.name, 'price', r.price, e.price);
  cmp(c.name, 'matchedBase', r.matchedBase, e.matchedBase);
  cmp(c.name, 'matchedQuote', r.matchedQuote, e.matchedQuote);
  cmp(c.name, 'feeQuote', r.feeQuote, e.feeQuote);
  cmp(c.name, 'dustQuote', r.dustQuote, e.dustQuote);
  cmp(c.name, 'matchedBaseBeforeTruncation', r.matchedBaseBeforeTruncation, e.matchedBaseBeforeTruncation);

  if (e.fillsCount !== undefined && r.fills.length !== e.fillsCount) {
    problems.push(`${c.name}: fillsCount — fixture says ${e.fillsCount}, clear() says ${r.fills.length}`);
  }

  const want = expectedFills(c, file.addresses);
  if (want) {
    if (want.length !== r.fills.length) {
      problems.push(`${c.name}: ${want.length} expected fills, clear() produced ${r.fills.length}`);
    } else {
      for (let i = 0; i < want.length; i++) {
        const w = want[i];
        const g = r.fills[i];
        const same =
          w.index === g.index &&
          w.side === g.side &&
          w.submitter === g.submitter &&
          w.price === g.price &&
          w.qtyBase === g.qtyBase &&
          w.quote === g.quote &&
          w.fee === g.fee;
        if (!same) {
          problems.push(
            `${c.name}: fill[${i}] — fixture [${w.index},${w.side},${w.qtyBase},${w.quote},${w.fee}] ` +
              `vs clear() [${g.index},${g.side},${g.qtyBase},${g.quote},${g.fee}]`,
          );
        }
      }
    }
  } else if (c.pinned) {
    // Not hand-writable (256/512 rows). Pin it as a regression lock.
    const rows = r.fills.map((f) => [
      f.index,
      f.side,
      f.qtyBase.toString(),
      f.quote.toString(),
      f.fee.toString(),
    ]);
    if (JSON.stringify(e.fills) !== JSON.stringify(rows)) {
      e.fills = rows;
      wrote++;
    }
    if (e.fillsCount === undefined) {
      e.fillsCount = rows.length;
      wrote++;
    }
  }

  const root = toHex(r.fillsRoot);
  if (e.fillsRoot === null || e.fillsRoot === undefined) {
    e.fillsRoot = root;
    wrote++;
  } else if (e.fillsRoot !== root) {
    problems.push(`${c.name}: fillsRoot — fixture says ${e.fillsRoot}, clear() says ${root}`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} fixture problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\nNothing was written.');
  process.exit(1);
}

if (CHECK_ONLY) {
  const missing = file.cases.filter((c) => !c.expectThrow && !c.expect?.fillsRoot).length;
  if (missing > 0) {
    console.error(`✗ ${missing} case(s) still have a null fillsRoot — run without --check.`);
    process.exit(1);
  }
  console.log(`✓ ${file.cases.length} clearing golden cases verified (check-only, nothing written).`);
  process.exit(0);
}

if (wrote > 0) {
  writeFileSync(PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`✓ ${file.cases.length} cases verified · ${wrote} generated field(s) written.`);
} else {
  console.log(`✓ ${file.cases.length} cases verified · nothing to write.`);
}
