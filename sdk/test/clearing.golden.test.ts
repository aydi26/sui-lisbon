// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L1 (shared golden fixtures — the same JSON drives the Move
//             generator, so a fixture edit updates both sides or fails)
// @spec       docs/DESIGN-V2.md#5 (every clause of the algorithm)
// @rules      G5 G10
// @depends    ../src/clearing.ts · ../fixtures/clearing.golden.json
// @facts      46 cases. Every scalar and every fill row was HAND-DERIVED from §5; the fixture
// @facts        generator verifies them and only ever writes `fillsRoot`.
// @implements describe('clearing golden fixtures')
// @verify     npx vitest run clearing.golden
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  canonicalOrder,
  clear,
  discoverPrice,
  encodeFillLeaf,
  fillsRoot,
  hashFillLeaf,
  HARD_MAX_BATCH_SIZE,
  MAX_BATCH_SIZE,
  PRICE_SCALE,
  quoteForAsk,
  quoteForBid,
  SIDE_ASK,
  SIDE_BID,
  type RevealedOrder,
} from '../src/clearing.js';
import { hashLeafBytes, toHex, ZERO32 } from '../src/hash.js';
import { binaryRootDuplicatingOdd } from '../src/merkle.js';
import {
  buildBalances,
  buildOrders,
  expectedFills,
  loadClearingGolden,
} from './support/clearingFixtures.js';

const golden = loadClearingGolden();

describe('constants', () => {
  it('pins the price scale and the batch-size ceilings', () => {
    expect(PRICE_SCALE).toBe(1_000_000_000n);
    expect(golden.priceScale).toBe(PRICE_SCALE.toString());
    expect(MAX_BATCH_SIZE).toBe(256);
    expect(HARD_MAX_BATCH_SIZE).toBe(512);
    expect(SIDE_BID).toBe(0);
    expect(SIDE_ASK).toBe(1);
  });

  it('covers every scenario docs/DESIGN-V2.md §9 L1 names', () => {
    const names = golden.cases.map((c) => c.name).join(' ');
    for (const needle of [
      'empty-batch',
      'all-bids',
      'all-asks',
      'no-cross',
      'exact-touch',
      'single-crossing-pair',
      'every-order-at-the-same-price-full-prorata',
      'largest-remainder',
      'duplicate-prices-from-one-submitter',
      'index-tiebreak',
      'underfunded',
      'u64-boundary',
      'u128',
      'batch-256',
    ]) {
      expect(names).toContain(needle);
    }
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
  });
});

describe('clearing golden fixtures', () => {
  for (const c of golden.cases) {
    it(`${c.name} — ${c.why.slice(0, 90)}`, () => {
      const orders = buildOrders(c, golden.addresses);
      const balances = buildBalances(c, golden.addresses);
      const input = { orders, balances, feeMatchedBps: BigInt(c.feeMatchedBps) };

      if (c.expectThrow) {
        expect(() => clear(input)).toThrow(c.expectThrow);
        return;
      }

      const e = c.expect!;
      const r = clear(input);

      expect(r.cleared).toBe(e.cleared);
      expect(r.price.toString()).toBe(e.price);
      expect(r.matchedBase.toString()).toBe(e.matchedBase);
      expect(r.matchedQuote.toString()).toBe(e.matchedQuote);
      expect(r.feeQuote.toString()).toBe(e.feeQuote);
      expect(r.dustQuote.toString()).toBe(e.dustQuote);
      expect(r.matchedBaseBeforeTruncation.toString()).toBe(e.matchedBaseBeforeTruncation);
      expect(toHex(r.fillsRoot)).toBe(e.fillsRoot);

      const want = expectedFills(c, golden.addresses);
      expect(want).toBeDefined();
      expect(r.fills).toEqual(want);
      if (e.fillsCount !== undefined) expect(r.fills).toHaveLength(e.fillsCount);

      // Re-running must be bit-identical — docs/DESIGN-V2.md §5, idempotence.
      const again = clear(input);
      expect(again.price).toBe(r.price);
      expect(toHex(again.fillsRoot)).toBe(toHex(r.fillsRoot));
      expect(again.fills).toEqual(r.fills);
    });
  }
});

describe('per-case value conservation', () => {
  for (const c of golden.cases) {
    if (c.expectThrow) continue;
    it(`${c.name} preserves value`, () => {
      const orders = buildOrders(c, golden.addresses);
      const r = clear({
        orders,
        balances: buildBalances(c, golden.addresses),
        feeMatchedBps: BigInt(c.feeMatchedBps),
      });

      let bidBase = 0n;
      let askBase = 0n;
      let bidQuote = 0n;
      let askCredit = 0n;
      let feeSum = 0n;
      for (const f of r.fills) {
        expect(f.price).toBe(r.price);
        expect(f.qtyBase).toBeGreaterThan(0n);
        const o = orders.find((x) => x.index === f.index)!;
        if (f.side === SIDE_BID) {
          expect(r.price).toBeLessThanOrEqual(o.limitPrice);
          expect(f.fee).toBe(0n);
          bidBase += f.qtyBase;
          bidQuote += f.quote;
          expect(f.quote).toBe(quoteForBid(f.qtyBase, r.price));
        } else {
          expect(r.price).toBeGreaterThanOrEqual(o.limitPrice);
          askBase += f.qtyBase;
          askCredit += f.quote - f.fee;
          feeSum += f.fee;
          expect(f.quote).toBe(quoteForAsk(f.qtyBase, r.price));
          expect(f.fee).toBeLessThanOrEqual(f.quote);
        }
      }

      expect(bidBase).toBe(askBase);
      expect(bidBase).toBe(r.matchedBase);
      expect(feeSum).toBe(r.feeQuote);
      expect(r.dustQuote).toBeGreaterThanOrEqual(0n);
      expect(bidQuote).toBe(askCredit + r.feeQuote + r.dustQuote);
      expect(r.fills.length).toBeLessThanOrEqual(orders.length);
    });
  }
});

describe('canonicalOrder', () => {
  const o = (index: number, submitter: string, side: 0 | 1, price: bigint): RevealedOrder => ({
    index,
    submitter,
    side,
    limitPrice: price,
    qtyBase: 1n,
  });

  it('sorts bids by price DESC then submitter ASC then index ASC', () => {
    const sorted = canonicalOrder([
      o(3, '0x2', SIDE_BID, 10n),
      o(1, '0x2', SIDE_BID, 10n),
      o(2, '0x1', SIDE_BID, 10n),
      o(0, '0x9', SIDE_BID, 20n),
    ]);
    expect(sorted.map((x) => x.index)).toEqual([0, 2, 1, 3]);
  });

  it('sorts asks by price ASC then submitter ASC then index ASC', () => {
    const sorted = canonicalOrder([
      o(3, '0x2', SIDE_ASK, 10n),
      o(1, '0x2', SIDE_ASK, 10n),
      o(2, '0x1', SIDE_ASK, 10n),
      o(0, '0x9', SIDE_ASK, 5n),
    ]);
    expect(sorted.map((x) => x.index)).toEqual([0, 2, 1, 3]);
  });

  it('puts every bid before every ask', () => {
    const sorted = canonicalOrder([o(0, '0x1', SIDE_ASK, 5n), o(1, '0x1', SIDE_BID, 5n)]);
    expect(sorted.map((x) => x.side)).toEqual([SIDE_BID, SIDE_ASK]);
  });

  it('is a total order — no input permutation changes the output', () => {
    const orders = [
      o(0, '0x3', SIDE_BID, 10n),
      o(1, '0x1', SIDE_BID, 10n),
      o(2, '0x2', SIDE_BID, 12n),
      o(3, '0x1', SIDE_ASK, 8n),
    ];
    const ref = canonicalOrder(orders).map((x) => x.index);
    for (const perm of [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]) {
      expect(canonicalOrder(perm.map((i) => orders[i]!)).map((x) => x.index)).toEqual(ref);
    }
  });
});

describe('discoverPrice', () => {
  const o = (index: number, side: 0 | 1, price: bigint, qty: bigint): RevealedOrder => ({
    index,
    submitter: '0x1',
    side,
    limitPrice: price,
    qtyBase: qty,
  });

  it('reports the candidate set as the distinct prices present, ascending', () => {
    const d = discoverPrice([o(0, SIDE_BID, 10n, 1n), o(1, SIDE_ASK, 5n, 1n), o(2, SIDE_BID, 10n, 1n)]);
    expect(d.candidates).toEqual([5n, 10n]);
  });

  it('reports demand and supply at the chosen price', () => {
    const d = discoverPrice([o(0, SIDE_BID, 10n, 100n), o(1, SIDE_ASK, 10n, 40n)]);
    expect(d.price).toBe(10n);
    expect(d.demand).toBe(100n);
    expect(d.supply).toBe(40n);
    expect(d.matchedBase).toBe(40n);
  });

  it('does not clear on an empty or one-sided book', () => {
    expect(discoverPrice([]).cleared).toBe(false);
    expect(discoverPrice([o(0, SIDE_BID, 10n, 1n)]).cleared).toBe(false);
    expect(discoverPrice([o(0, SIDE_ASK, 10n, 1n)]).cleared).toBe(false);
  });
});

describe('the fills root', () => {
  it('is 32 zero bytes for an empty fill set', () => {
    expect(toHex(fillsRoot([]))).toBe(toHex(ZERO32));
  });

  it('hashes 0x00 || bcs(FillLeaf) and roots with odd-node duplication', () => {
    const fill = {
      index: 7,
      submitter: '0x2a',
      side: SIDE_ASK,
      price: 10_000_000_000n,
      qtyBase: 100n,
      quote: 1000n,
      fee: 3n,
    };
    const leaf = encodeFillLeaf(fill);
    expect(leaf.length).toBe(8 + 32 + 1 + 16 + 8 + 8 + 8);
    expect(toHex(hashFillLeaf(fill))).toBe(toHex(hashLeafBytes(leaf)));
    expect(toHex(fillsRoot([fill, fill, fill]))).toBe(
      toHex(binaryRootDuplicatingOdd([fill, fill, fill].map(hashFillLeaf))),
    );
  });

  it('changes when ANY field of ANY fill changes', () => {
    const base = {
      index: 1,
      submitter: '0x1',
      side: SIDE_BID,
      price: 10n,
      qtyBase: 2n,
      quote: 3n,
      fee: 0n,
    };
    const root = toHex(fillsRoot([base]));
    expect(toHex(fillsRoot([{ ...base, index: 2 }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, submitter: '0x2' }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, side: SIDE_ASK }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, price: 11n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, qtyBase: 3n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, quote: 4n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, fee: 1n }]))).not.toBe(root);
  });

  it('is order-sensitive — the canonical order is part of the commitment', () => {
    const a = { index: 1, submitter: '0x1', side: SIDE_BID, price: 10n, qtyBase: 1n, quote: 1n, fee: 0n };
    const b = { ...a, index: 2 };
    expect(toHex(fillsRoot([a, b]))).not.toBe(toHex(fillsRoot([b, a])));
  });
});

describe('quote conversion rounds TOWARD THE VAULT', () => {
  it('bids round up and asks round down', () => {
    expect(quoteForBid(1_500_000_000n, 1n)).toBe(2n);
    expect(quoteForAsk(1_500_000_000n, 1n)).toBe(1n);
  });

  it('agree when the division is exact', () => {
    expect(quoteForBid(1_000_000n, 10_000_000_000n)).toBe(10_000_000n);
    expect(quoteForAsk(1_000_000n, 10_000_000_000n)).toBe(10_000_000n);
  });

  it('the bid quote is never below the ask quote — dust can never be negative', () => {
    for (let q = 0n; q < 200n; q++) {
      for (const p of [1n, 7n, 999_999_999n, 1_000_000_001n]) {
        expect(quoteForBid(q, p)).toBeGreaterThanOrEqual(quoteForAsk(q, p));
      }
    }
  });
});
