// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L1 ("A generator emits move/tests/clearing_golden_tests.move
//             from the SAME JSON, so a fixture edit updates both sides or fails to compile")
// @rules      G5
// @depends    ../fixtures/clearing.golden.json · ../test/support/clearingFixtures.ts
// @facts      ★ This script PRINTS TO STDOUT. It does NOT write into `move/tests/` — that
// @facts        directory belongs to another agent. Redirect it yourself:
// @facts          node --import ./scripts/register-ts.mjs scripts/gen-move-fixtures.mjs \
// @facts            > ../move/tests/clearing_golden_tests.move
// @facts      ★ The emitted module assumes ONE test-only helper on `aphotic::clearing`, spelled
// @facts        out in the generated header. Everything else it uses is standard Move 2024.
// @facts        If the Move surface differs, change THIS generator — never hand-edit the
// @facts        generated file, or the two sides drift and B6 happens again.
// @facts      Cases carrying `expectThrow` become `#[expected_failure]` tests. Abort CODES are
// @facts        deliberately NOT guessed: the generated test asserts only that it aborts, with
// @facts        the TS error name in a comment for whoever wires the constants.
// @implements node --import ./scripts/register-ts.mjs scripts/gen-move-fixtures.mjs
// @forbidden  writing anywhere inside move/ — print, redirect, review
// @invariant  1. Deterministic: same JSON in, byte-identical Move out.
// @invariant  2. Every case in the fixture produces exactly one #[test] function.
// @verify     node --import ./scripts/register-ts.mjs scripts/gen-move-fixtures.mjs | head -60
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { clear } from '../src/clearing.ts';
import { toHex } from '../src/hash.ts';
import {
  buildBalances,
  buildInput,
  buildOrders,
  loadClearingGolden,
} from '../test/support/clearingFixtures.ts';

const file = loadClearingGolden();
const out = [];
const w = (s = '') => out.push(s);

function ident(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function vec(values, suffix = '') {
  if (values.length === 0) return 'vector[]';
  return `vector[${values.map((v) => `${v}${suffix}`).join(', ')}]`;
}

function vecWrapped(values, suffix, indent) {
  const flat = vec(values, suffix);
  if (flat.length <= 96) return flat;
  const pad = ' '.repeat(indent);
  const items = values.map((v) => `${v}${suffix}`);
  const lines = [];
  let line = '';
  for (const it of items) {
    if (line.length + it.length + 2 > 92) {
      lines.push(line);
      line = '';
    }
    line += (line === '' ? '' : ' ') + `${it},`;
  }
  if (line !== '') lines.push(line);
  return `vector[\n${lines.map((l) => pad + l).join('\n')}\n${' '.repeat(indent - 4)}]`;
}

w('// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────');
w('// @task       T6.3 (generated)');
w('// @phase      3  [CUT-LINE CRITICAL]');
w('// @status     DONE');
w('// @spec       docs/DESIGN-V2.md#9 L1 — the shared golden fixtures');
w('// @facts      ★★ GENERATED FILE — DO NOT EDIT BY HAND. ★★');
w('// @facts        Source of truth: sdk/fixtures/clearing.golden.json');
w('// @facts        Regenerate:      node --import ./scripts/register-ts.mjs \\');
w('// @facts                           scripts/gen-move-fixtures.mjs > move/tests/clearing_golden_tests.move');
w('// @facts        Editing this file instead of the JSON reintroduces blocker B6 — a second');
w('// @facts        copy of the clearing expectations that can drift from the TS twin.');
w('// @facts      ASSUMED MOVE SURFACE (implement on aphotic::clearing, #[test_only]):');
w('// @facts        public struct GoldenOutcome has drop {');
w('// @facts            cleared: bool, price: u64, matched_base: u64, matched_quote: u64,');
w('// @facts            fee_quote: u64, dust_quote: u64, fills_root: vector<u8>,');
w('// @facts            ⚠ fill_quote is the PUBLISHED quote_sats — an ASK\'s is NET of its own');
w('// @facts            fee — and fill_fee is NOT a field of aphotic::clearing::Fill at all; it');
w('// @facts            is emitted for audit. fee_quote is quote_paid − quote_recv, dust included.');
w('// @facts            fill_index: vector<u64>, fill_side: vector<u8>, fill_qty: vector<u64>,');
w('// @facts            fill_quote: vector<u64>, fill_fee: vector<u64>,');
w('// @facts            matched_base_before_truncation: u64,');
w('// @facts        }');
w('// @facts        public fun clear_golden(');
w('// @facts            indices: vector<u64>, submitters: vector<address>, sides: vector<u8>,');
w('// @facts            prices: vector<u64>, qtys: vector<u64>,');
w('// @facts            has_balances: bool, bal_who: vector<address>,');
w('// @facts            bal_base: vector<u64>, bal_quote: vector<u64>,');
w('// @facts            fee_matched_bps: u64,');
w('// @facts        ): GoldenOutcome');
w('// @facts      PRICE_SCALE = 1_000_000_000. quote = qty_base * price / PRICE_SCALE.');
w('// @facts      Cases that abort in TS are #[expected_failure] here; the TS error name is in a');
w('// @facts        comment so the abort constant can be pinned once clearing.move defines it.');
w('// @verify     sui move test clearing_golden');
w('// └── END CONTRACT ───────────────────────────────────────────────────────────');
w('');
w('#[test_only]');
w('module aphotic::clearing_golden_tests;');
w('');
w('use aphotic::clearing;');
w('');

let emitted = 0;
let expectedFailures = 0;

for (const c of file.cases) {
  const orders = buildOrders(c, file.addresses);
  const balances = buildBalances(c, file.addresses);
  const feeBps = BigInt(c.feeMatchedBps);

  const indices = orders.map((o) => o.index.toString());
  const submitters = orders.map((o) => `@${o.submitter}`);
  const sides = orders.map((o) => o.side.toString());
  const prices = orders.map((o) => o.limitPrice.toString());
  const qtys = orders.map((o) => o.qtyBase.toString());

  const hasBalances = balances !== undefined;
  const balWho = (balances ?? []).map((b) => `@${b.submitter}`);
  const balBase = (balances ?? []).map((b) => b.base.toString());
  const balQuote = (balances ?? []).map((b) => b.quote.toString());

  const fn = ident(c.name);

  w(`// ── ${c.name} ${'─'.repeat(Math.max(0, 70 - c.name.length))}`);
  for (const line of wrapComment(c.why, 96)) w(`// ${line}`);

  if (c.expectThrow) {
    expectedFailures++;
    w(`// TS aborts with: ${c.expectThrow}`);
    w('// TODO(move): replace `expected_failure` with the matching abort constant once');
    w('//            clearing.move defines it, e.g. #[expected_failure(abort_code = clearing::EBatchTooLarge)]');
    w('#[test]');
    w('#[expected_failure]');
  } else {
    w('#[test]');
  }
  w(`fun ${fn}() {`);
  w(`    let outcome = clearing::clear_golden(`);
  w(`        ${vecWrapped(indices, '', 12)},`);
  w(`        ${vecWrapped(submitters, '', 12)},`);
  w(`        ${vecWrapped(sides, 'u8', 12)},`);
  w(`        ${vecWrapped(prices, '', 12)},`);
  w(`        ${vecWrapped(qtys, '', 12)},`);
  w(`        ${hasBalances},`);
  w(`        ${vecWrapped(balWho, '', 12)},`);
  w(`        ${vecWrapped(balBase, '', 12)},`);
  w(`        ${vecWrapped(balQuote, '', 12)},`);
  w(`        ${feeBps.toString()},`);
  w('    );');

  if (c.expectThrow) {
    w('    // Unreachable: the call above must abort.');
    w('    let _ = outcome;');
    w('}');
    w('');
    emitted++;
    continue;
  }

  // Recompute from the TS implementation so the emitted Move expectations can never drift
  // from the fixture the TS suite asserts.
  // ⚠ THROUGH `buildInput`, so this generator clears at the FIXTURE's price scale and batch id.
  // It used to build its own input and omit both, which silently evaluated every case at the
  // 1e8 default while the vitest suite evaluated the same case at 1e9.
  const r = clear(buildInput(c, file));
  const e = c.expect;
  if (toHex(r.fillsRoot) !== e.fillsRoot) {
    throw new Error(
      `${c.name}: fixture fillsRoot ${e.fillsRoot} != clear() ${toHex(r.fillsRoot)} — run scripts/gen-golden.mjs first`,
    );
  }

  w(`    assert!(clearing::golden_cleared(&outcome) == ${r.cleared}, 0);`);
  w(`    assert!(clearing::golden_price(&outcome) == ${r.price.toString()}, 1);`);
  w(`    assert!(clearing::golden_matched_base(&outcome) == ${r.matchedBase.toString()}, 2);`);
  w(`    assert!(clearing::golden_matched_quote(&outcome) == ${r.matchedQuote.toString()}, 3);`);
  w(`    assert!(clearing::golden_fee_quote(&outcome) == ${r.feeQuote.toString()}, 4);`);
  w(`    assert!(clearing::golden_dust_quote(&outcome) == ${r.dustQuote.toString()}, 5);`);
  w(
    `    assert!(clearing::golden_matched_base_before_truncation(&outcome) == ${r.matchedBaseBeforeTruncation.toString()}, 6);`,
  );
  w(`    assert!(clearing::golden_fill_count(&outcome) == ${r.fills.length}, 7);`);
  w(`    assert!(clearing::golden_fill_indices(&outcome) == ${vecWrapped(r.fills.map((f) => f.index.toString()), '', 12)}, 8);`);
  w(`    assert!(clearing::golden_fill_sides(&outcome) == ${vecWrapped(r.fills.map((f) => f.side.toString()), 'u8', 12)}, 9);`);
  w(`    assert!(clearing::golden_fill_qtys(&outcome) == ${vecWrapped(r.fills.map((f) => f.qtyBase.toString()), '', 12)}, 10);`);
  w(`    assert!(clearing::golden_fill_quotes(&outcome) == ${vecWrapped(r.fills.map((f) => f.quote.toString()), '', 12)}, 11);`);
  w(`    assert!(clearing::golden_fill_fees(&outcome) == ${vecWrapped(r.fills.map((f) => f.fee.toString()), '', 12)}, 12);`);
  w(`    assert!(clearing::golden_fills_root(&outcome) == x"${toHex(r.fillsRoot).slice(2)}", 13);`);
  w('}');
  w('');
  emitted++;
}

w(`// ${emitted} generated tests · ${expectedFailures} of them #[expected_failure].`);
w('// Source: sdk/fixtures/clearing.golden.json — edit THAT, then regenerate.');

function wrapComment(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = '';
    }
    line += (line === '' ? '' : ' ') + word;
  }
  if (line !== '') lines.push(line);
  return lines;
}

process.stdout.write(`${out.join('\n')}\n`);
