// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L2 (TS property test, 10 000 cases, every commit, seeded RNG)
// @spec       docs/DESIGN-V2.md#10 (`no fill outside limit, 10k sets` — the named KP test)
// @spec       aphotic.md §10 Settlement invariants
// @rules      G5 G10
// @depends    ../src/clearing.ts · ../src/rng.ts
// @facts      10 000 cases across FOUR adversarial families, 2 500 each:
// @facts        1. broad      — 8 price levels, wide quantities: the ordinary book.
// @facts        2. tie-dense  — 2 price levels, mostly EQUAL quantities: maximises pro-rata,
// @facts                        remainder ties and (price, submitter) collisions.
// @facts        3. one-sided  — 90 % of the flow on one side: rationing, and no-cross.
// @facts        4. underfunded— a frozen ledger where a third of the accounts cannot cover.
// @facts      n is uniform on [0, 256]. Bounds keep every quote inside u64 so an overflow abort
// @facts        never masks an invariant failure — the overflow path has its own L1 fixtures.
// @facts      The RNG is the package's own seeded SplitMix64. Math.random() is banned.
// @implements describe('L2 property — 10 000 cases')
// @forbidden  Math.random() · Date.now() · any I/O
// @invariant  1. No fill outside its limit price.
// @invariant  2. Σ quote debits == Σ quote credits (asks NET) + feeQuote — Move's
//                `total_debits == total_credits`, with NO fourth term. `feeQuote` itself splits
//                into `Σ fill.fee + dustQuote`, which is asserted separately.
// @invariant  3. n_fills <= n_revealed.
// @invariant  4. Re-running gives an identical (price, root).
// @invariant  5. Truncation is monotone in the frozen balance.
// @verify     npx vitest run clearing.property
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  clear,
  feeForAsk,
  PRICE_SCALE,
  quoteForAsk,
  quoteForBid,
  SIDE_ASK,
  SIDE_BID,
  type ClearingInput,
  type FrozenBalance,
  type RevealedOrder,
  type Side,
} from '../src/clearing.js';
import { toHex } from '../src/hash.js';
import { U64_MAX } from '../src/math.js';
import { createRng, type Rng } from '../src/rng.js';

type Family = 'broad' | 'tie-dense' | 'one-sided' | 'underfunded';

const CASES_PER_FAMILY = 2_500;
const SUBMITTERS = 16;

/** Bounded so no product can leave u64: 256 * 1e6 * 1e12 / 1e9 = 2.56e11 << 1.8e19. */
const MAX_QTY = 1_000_000n;
const MAX_PRICE = 1_000_000_000_000n;

function submitter(i: number): string {
  return `0x${(i + 1).toString(16).padStart(64, '0')}`;
}

function priceLadder(rng: Rng, levels: number): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < levels; i++) out.push(rng.nextBelow(MAX_PRICE) + 1n);
  return out;
}

function makeBatch(rng: Rng, family: Family): ClearingInput {
  const n = rng.nextInt(257); // [0, 256]
  const levels = family === 'tie-dense' ? 2 : 8;
  const prices = priceLadder(rng, levels);
  const commonQty = rng.nextBelow(MAX_QTY) + 1n;

  const orders: RevealedOrder[] = [];
  for (let i = 0; i < n; i++) {
    let side: Side;
    if (family === 'one-sided') {
      side = rng.nextInt(10) === 0 ? SIDE_ASK : SIDE_BID;
    } else {
      side = rng.nextInt(2) === 0 ? SIDE_BID : SIDE_ASK;
    }
    // tie-dense: 80 % of orders share the exact same quantity, so pro-rata remainders tie.
    const qty =
      family === 'tie-dense' && rng.nextInt(10) < 8 ? commonQty : rng.nextBelow(MAX_QTY) + 1n;
    orders.push({
      index: i,
      submitter: submitter(rng.nextInt(SUBMITTERS)),
      side,
      limitPrice: rng.pick(prices),
      qtyBase: qty,
    });
  }

  let balances: FrozenBalance[] | undefined;
  if (family === 'underfunded') {
    balances = [];
    for (let i = 0; i < SUBMITTERS; i++) {
      // A third of the accounts are deliberately short; some are flat zero.
      const poor = rng.nextInt(3) === 0;
      const zero = poor && rng.nextInt(4) === 0;
      balances.push({
        submitter: submitter(i),
        base: zero ? 0n : rng.nextBelow(poor ? MAX_QTY : MAX_QTY * 300n),
        quote: zero ? 0n : rng.nextBelow(poor ? 10n ** 9n : 10n ** 15n),
      });
    }
  }

  return { orders, balances, feeMatchedBps: BigInt(rng.nextInt(1001)) };
}

/**
 * Hand the event loop back. This suite is CPU-bound and would otherwise block the worker
 * thread past vitest's RPC deadline, which surfaces as a spurious "Timeout calling
 * onTaskUpdate" and makes an otherwise-green run report an error.
 */
const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Every structural invariant Move will also assert. Returns the fill count. */
function assertInvariants(input: ClearingInput, r: ReturnType<typeof clear>): number {
  const byIndex = new Map(input.orders.map((o) => [o.index, o]));

  let bidBase = 0n;
  let askBase = 0n;
  let bidQuote = 0n;
  let askCredit = 0n;
  let feeSum = 0n;
  let grossSum = 0n;
  const seen = new Set<number>();

  for (const f of r.fills) {
    // INV 3: at most one fill per revealed order, and it must BE a revealed order.
    expect(seen.has(f.index)).toBe(false);
    seen.add(f.index);
    const o = byIndex.get(f.index);
    expect(o).toBeDefined();
    expect(f.submitter).toBe(o!.submitter);
    expect(f.side).toBe(o!.side);

    // A zero-quantity fill is never emitted, and the price is uniform.
    expect(f.qtyBase).toBeGreaterThan(0n);
    expect(f.qtyBase).toBeLessThanOrEqual(o!.qtyBase);
    expect(f.price).toBe(r.price);

    // The leaf commits to the batch, and every fill in one clearing shares it.
    expect(f.batchId).toBe(input.batchId ?? 0n);

    // INV 1: nobody is filled outside their limit price.
    if (f.side === SIDE_BID) {
      expect(f.price).toBeLessThanOrEqual(o!.limitPrice);
      expect(f.fee).toBe(0n);
      expect(f.quote).toBe(quoteForBid(f.qtyBase, r.price, PRICE_SCALE));
      bidBase += f.qtyBase;
      bidQuote += f.quote;
    } else {
      expect(f.price).toBeGreaterThanOrEqual(o!.limitPrice);
      // ⚠ `quote` is the PUBLISHED value and is already NET on an ask. Asserting it equals the
      // gross would silently reinstate the pre-D3 leaf.
      const gross = quoteForAsk(f.qtyBase, r.price, PRICE_SCALE);
      expect(f.fee).toBe(feeForAsk(gross, input.feeMatchedBps));
      expect(f.quote).toBe(gross - f.fee);
      askBase += f.qtyBase;
      askCredit += f.quote;
      feeSum += f.fee;
      grossSum += gross;
    }
    expect(f.quote).toBeLessThanOrEqual(U64_MAX);
  }

  // INV 2, base leg: what sellers deliver is exactly what buyers receive.
  expect(bidBase).toBe(askBase);
  expect(bidBase).toBe(r.matchedBase);

  // INV 2, quote leg: Move's `total_debits == total_credits`, the fee being one credit.
  expect(bidQuote).toBe(r.quotePaid);
  expect(askCredit).toBe(r.quoteRecv);
  expect(bidQuote).toBe(askCredit + r.feeQuote);
  // The fee credit ABSORBS the dust — one term on chain, two in the report.
  expect(r.dustQuote).toBeGreaterThanOrEqual(0n);
  expect(feeSum + r.dustQuote).toBe(r.feeQuote);
  expect(grossSum).toBe(r.matchedQuote);

  // INV 3: n_fills <= n_revealed.
  expect(r.fills.length).toBeLessThanOrEqual(input.orders.length);

  // Truncation can only ever reduce.
  expect(r.matchedBase).toBeLessThanOrEqual(r.matchedBaseBeforeTruncation);
  if (input.balances === undefined) {
    expect(r.matchedBase).toBe(r.matchedBaseBeforeTruncation);
  }

  // Fills are emitted bids-first, then asks — the canonical order that roots the tree.
  let sawAsk = false;
  for (const f of r.fills) {
    if (f.side === SIDE_ASK) sawAsk = true;
    else expect(sawAsk).toBe(false);
  }

  if (!r.cleared) {
    expect(r.fills).toHaveLength(0);
    expect(r.price).toBe(0n);
    expect(r.matchedBase).toBe(0n);
  }
  return r.fills.length;
}

describe('L2 property test — 10 000 seeded cases', () => {
  const families: Family[] = ['broad', 'tie-dense', 'one-sided', 'underfunded'];
  // Chunked so no single `it` blocks the worker long enough for vitest's RPC to time out.
  // Each chunk carries its own seed, so a failure is reproducible in isolation.
  const CHUNKS = 5;
  const PER_CHUNK = CASES_PER_FAMILY / CHUNKS;

  for (const family of families) {
    const tally = { cleared: 0, fills: 0, truncated: 0, cases: 0 };

    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      it(`${family} [${chunk + 1}/${CHUNKS}]: ${PER_CHUNK} cases hold every structural invariant`, async () => {
        const rng = createRng(`aphotic-clearing-${family}-${chunk}`);
        for (let i = 0; i < PER_CHUNK; i++) {
          if (i % 25 === 0) await yieldToLoop();
          const input = makeBatch(rng, family);
          const r = clear(input);
          tally.fills += assertInvariants(input, r);
          tally.cases++;
          if (r.cleared) tally.cleared++;
          if (r.matchedBase < r.matchedBaseBeforeTruncation) tally.truncated++;

          // INV 4: re-running the SAME set gives an identical price and root.
          const again = clear(input);
          expect(again.price).toBe(r.price);
          expect(toHex(again.fillsRoot)).toBe(toHex(r.fillsRoot));
          expect(again.matchedBase).toBe(r.matchedBase);
          expect(again.fills.length).toBe(r.fills.length);
        }
      });
    }

    it(`${family}: the ${CASES_PER_FAMILY} cases were not vacuous`, () => {
      // A property suite that never produced a crossing book would pass every invariant
      // while proving nothing. These floors make that impossible to miss.
      expect(tally.cases).toBe(CASES_PER_FAMILY);
      expect(tally.cleared).toBeGreaterThan(CASES_PER_FAMILY / 4);
      expect(tally.fills).toBeGreaterThan(CASES_PER_FAMILY);
      if (family === 'underfunded') {
        expect(tally.truncated).toBeGreaterThan(CASES_PER_FAMILY / 10);
      }
    });
  }
});

describe('INV 4 — order-independence: a shuffled batch clears identically', () => {
  it('holds for 400 batches', async () => {
    const rng = createRng('aphotic-clearing-shuffle');
    for (let i = 0; i < 400; i++) {
      if (i % 25 === 0) await yieldToLoop();
      const input = makeBatch(rng, 'broad');
      const ref = clear(input);
      const shuffled = [...input.orders];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = rng.nextInt(j + 1);
        const tmp = shuffled[j]!;
        shuffled[j] = shuffled[k]!;
        shuffled[k] = tmp;
      }
      const out = clear({ ...input, orders: shuffled });
      expect(out.price).toBe(ref.price);
      expect(out.matchedBase).toBe(ref.matchedBase);
      expect(toHex(out.fillsRoot)).toBe(toHex(ref.fillsRoot));
      expect(out.fills).toEqual(ref.fills);
    }
  });
});

describe('INV 5 — truncation is monotone in the frozen balance', () => {
  it('raising ONE account’s frozen balance never lowers the matched volume, 1500 cases', async () => {
    const rng = createRng('aphotic-clearing-monotone');
    let strictlyIncreased = 0;
    for (let i = 0; i < 1500; i++) {
      if (i % 25 === 0) await yieldToLoop();
      const input = makeBatch(rng, 'underfunded');
      const before = clear(input).matchedBase;

      const target = rng.nextInt(SUBMITTERS);
      const bumped = input.balances!.map((b, j) =>
        j === target
          ? { ...b, base: b.base + rng.nextBelow(MAX_QTY * 50n), quote: b.quote + rng.nextBelow(10n ** 14n) }
          : b,
      );
      const after = clear({ ...input, balances: bumped }).matchedBase;
      expect(after).toBeGreaterThanOrEqual(before);
      if (after > before) strictlyIncreased++;
    }
    // The property would be vacuous if bumping never mattered.
    expect(strictlyIncreased).toBeGreaterThan(50);
  });

  it('raising EVERY balance to unlimited reproduces the untruncated clearing, 800 cases', async () => {
    const rng = createRng('aphotic-clearing-unlimited');
    for (let i = 0; i < 800; i++) {
      if (i % 25 === 0) await yieldToLoop();
      const input = makeBatch(rng, 'underfunded');
      const rich = input.balances!.map((b) => ({ ...b, base: U64_MAX, quote: U64_MAX }));
      const withRich = clear({ ...input, balances: rich });
      const withNone = clear({ ...input, balances: undefined });
      expect(withRich.matchedBase).toBe(withNone.matchedBase);
      expect(toHex(withRich.fillsRoot)).toBe(toHex(withNone.fillsRoot));
    }
  });

  it('a frozen ledger of zeros settles nothing but still records the price', async () => {
    const rng = createRng('aphotic-clearing-broke');
    let clearedButEmpty = 0;
    for (let i = 0; i < 400; i++) {
      if (i % 25 === 0) await yieldToLoop();
      const input = makeBatch(rng, 'broad');
      const broke = Array.from({ length: SUBMITTERS }, (_, j) => ({
        submitter: submitter(j),
        base: 0n,
        quote: 0n,
      }));
      const r = clear({ ...input, balances: broke });
      expect(r.matchedBase).toBe(0n);
      expect(r.fills).toHaveLength(0);
      if (r.cleared) {
        expect(r.price).toBeGreaterThan(0n);
        expect(r.matchedBaseBeforeTruncation).toBeGreaterThan(0n);
        clearedButEmpty++;
      }
    }
    expect(clearedButEmpty).toBeGreaterThan(100);
  });
});
