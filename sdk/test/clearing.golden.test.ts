// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move <- ★ THE AUTHORITY these cases now pin
// @spec       docs/DESIGN-V2.md#9 L1 (shared golden fixtures — the same JSON drives the Move
//             generator and clearing-rs, so a fixture edit updates every side or fails)
// @spec       docs/DESIGN-V2.md#5 (every clause of the algorithm)
// @rules      G5 G10
// @depends    ../src/clearing.ts · ../fixtures/clearing.golden.json
// @facts      47 cases. Every scalar and every fill row was HAND-DERIVED from clearing.move; the
// @facts        fixture generator verifies them and only ever writes `fillsRoot`.
// @facts      ⚠ The fill `quote` column is the PUBLISHED quote_sats — an ask's is NET of its fee —
// @facts        and `fee` is the un-committed audit column. feeQuote is Move's residual and
// @facts        absorbs the dust, so `Σ fill.fee + dustQuote == feeQuote` is the identity to
// @facts        assert, NOT `Σ fill.fee == feeQuote`.
// @implements describe('clearing golden fixtures')
// @verify     npx vitest run clearing.golden
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  canonicalOrder,
  clear,
  discoverPrice,
  encodeFillLeaf,
  feeForAsk,
  FILL_LEAF_LEN,
  fillsRoot,
  hashFillLeaf,
  HARD_MAX_BATCH_SIZE,
  MAX_BATCH_SIZE,
  PRICE_SCALE,
  quoteForAsk,
  quoteForBid,
  SIDE_ASK,
  SIDE_BID,
  type Fill,
  type RevealedOrder,
} from '../src/clearing.js';
import { hashLeafBytes, toHex, ZERO32 } from '../src/hash.js';
import { binaryRootDuplicatingOdd } from '../src/merkle.js';
import {
  buildInput,
  expectedFills,
  loadClearingGolden,
} from './support/clearingFixtures.js';

const golden = loadClearingGolden();

describe('constants', () => {
  it('pins the price scale and the batch-size ceilings', () => {
    // The PRODUCTION scale must equal aphotic::clearing::price_scale(). Move is the
    // authority — it is the deployed contract — and 1e8 is sats-natural for an
    // 8-decimal asset. This constant was 1e9 here while Move and the keeper were
    // both 1e8: a three-way implementation with two scales, which §9 calls a
    // release blocker.
    expect(PRICE_SCALE).toBe(100_000_000n);
    // The fixtures deliberately run at their OWN scale, passed explicitly to
    // clear(). That makes them pin the algorithm's scale-independence instead of
    // silently re-pinning whatever the default happens to be — which is how the
    // divergence above survived having 46 green fixtures.
    expect(golden.priceScale).not.toBe(PRICE_SCALE.toString());
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
      'batch-id-is-committed-to-the-leaf',
    ]) {
      expect(names).toContain(needle);
    }
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
  });
});

describe('clearing golden fixtures', () => {
  for (const c of golden.cases) {
    it(`${c.name} — ${c.why.slice(0, 90)}`, () => {
      // ONE decoder builds the input — the same one gen-golden.mjs uses, so the two
      // verifiers cannot be checking the fixtures at two different price scales.
      const input = buildInput(c, golden);

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
      const input = buildInput(c, golden);
      const orders = input.orders;
      const scale = BigInt(golden.priceScale);
      const r = clear(input);

      let bidBase = 0n;
      let askBase = 0n;
      let bidQuote = 0n;
      let askCredit = 0n;
      let feeSum = 0n;
      let grossSum = 0n;
      for (const f of r.fills) {
        expect(f.price).toBe(r.price);
        expect(f.batchId).toBe(input.batchId);
        expect(f.qtyBase).toBeGreaterThan(0n);
        const o = orders.find((x) => x.index === f.index)!;
        if (f.side === SIDE_BID) {
          expect(r.price).toBeLessThanOrEqual(o.limitPrice);
          expect(f.fee).toBe(0n);
          bidBase += f.qtyBase;
          bidQuote += f.quote;
          expect(f.quote).toBe(quoteForBid(f.qtyBase, r.price, scale));
        } else {
          expect(r.price).toBeGreaterThanOrEqual(o.limitPrice);
          askBase += f.qtyBase;
          // ⚠ `quote` is already NET on an ask — the gross is quote + fee.
          const gross = quoteForAsk(f.qtyBase, r.price, scale);
          expect(f.fee).toBe(feeForAsk(gross, input.feeMatchedBps));
          expect(f.quote).toBe(gross - f.fee);
          askCredit += f.quote;
          feeSum += f.fee;
          grossSum += gross;
        }
      }

      expect(bidBase).toBe(askBase);
      expect(bidBase).toBe(r.matchedBase);
      expect(grossSum).toBe(r.matchedQuote);
      expect(bidQuote).toBe(r.quotePaid);
      expect(askCredit).toBe(r.quoteRecv);
      expect(r.dustQuote).toBeGreaterThanOrEqual(0n);
      // Move's fee is the RESIDUAL and absorbs the dust — there is no fourth term.
      expect(feeSum + r.dustQuote).toBe(r.feeQuote);
      expect(bidQuote).toBe(askCredit + r.feeQuote);
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

describe('the fill leaf is bcs(aphotic::clearing::Fill), 73 bytes', () => {
  const sample: Fill = {
    batchId: 1n,
    index: 2,
    submitter: '0xb0b',
    side: SIDE_BID,
    qtyBase: 0x0102_0304_0506_0708n,
    quote: 990_000n,
    price: 99_000_000n,
    fee: 0n,
  };

  it('is 73 bytes, not the 81 the old §5bis layout produced', () => {
    expect(FILL_LEAF_LEN).toBe(73);
    expect(8 + 8 + 32 + 1 + 8 + 8 + 8).toBe(73);
    expect(encodeFillLeaf(sample).length).toBe(73);
    // The old layout was u64 ‖ address ‖ u8 side ‖ u128 price ‖ u64 ‖ u64 ‖ u64 = 81. While
    // that stood, no root comparison against Move could ever have succeeded.
    expect(FILL_LEAF_LEN).not.toBe(8 + 32 + 1 + 16 + 8 + 8 + 8);
  });

  /**
   * Built BY HAND from the BCS rules, field by field, so this cannot pass by agreeing with a
   * mistake in `encodeFillLeaf`. It is the exact twin of the Rust `matches_a_hand_built_preimage`
   * vector in clearing-rs/clearing/src/bcs.rs.
   */
  it('matches a hand-built pre-image, field by field', () => {
    const want = [
      // batch_id: u64 = 1, LITTLE-endian.
      0x01, 0, 0, 0, 0, 0, 0, 0,
      // order_index: u64 = 2, LITTLE-endian.
      0x02, 0, 0, 0, 0, 0, 0, 0,
      // submitter: @0xb0b — 32 bytes, BIG-endian, right-aligned.
      ...new Array<number>(30).fill(0), 0x0b, 0x0b,
      // is_bid: SIDE_BID ⇒ the BOOL true ⇒ 0x01, even though SIDE_BID is the number 0.
      0x01,
      // base_sats: 0x0102030405060708 reversed by the little-endian rule.
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
      // quote_sats: 990_000 = 0x0F1B30.
      0x30, 0x1b, 0x0f, 0, 0, 0, 0, 0,
      // price: 99_000_000 = 0x05E69EC0.
      0xc0, 0x9e, 0xe6, 0x05, 0, 0, 0, 0,
    ];
    expect(want.length).toBe(73);
    expect([...encodeFillLeaf(sample)]).toEqual(want);
  });

  it('writes the BOOL is_bid, so a BID is 0x01 and an ASK is 0x00', () => {
    // The inversion trap: SIDE_BID is 0 but the leaf byte is 1. Writing `side` into that byte
    // would flip every leaf in the tree with nothing red anywhere.
    expect(encodeFillLeaf(sample)[48]).toBe(0x01);
    expect(encodeFillLeaf({ ...sample, side: SIDE_ASK })[48]).toBe(0x00);
    expect(SIDE_BID).toBe(0);
  });
});

describe('the fills root', () => {
  const base: Fill = {
    batchId: 3n,
    index: 1,
    submitter: '0x1',
    side: SIDE_BID,
    qtyBase: 2n,
    quote: 3n,
    price: 10n,
    fee: 0n,
  };

  it('is 32 zero bytes for an empty fill set', () => {
    expect(toHex(fillsRoot([]))).toBe(toHex(ZERO32));
  });

  it('hashes 0x00 || bcs(Fill) and roots with odd-node duplication', () => {
    const three = [base, base, base];
    expect(toHex(hashFillLeaf(base))).toBe(toHex(hashLeafBytes(encodeFillLeaf(base))));
    expect(toHex(fillsRoot(three))).toBe(toHex(binaryRootDuplicatingOdd(three.map(hashFillLeaf))));
  });

  it('changes when ANY COMMITTED field of ANY fill changes', () => {
    const root = toHex(fillsRoot([base]));
    expect(toHex(fillsRoot([{ ...base, batchId: 4n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, index: 2 }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, submitter: '0x2' }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, side: SIDE_ASK }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, price: 11n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, qtyBase: 3n }]))).not.toBe(root);
    expect(toHex(fillsRoot([{ ...base, quote: 4n }]))).not.toBe(root);
  });

  /**
   * ⚠ Stated as a positive claim rather than left as an absence: `fee` is NOT committed, because
   * `aphotic::clearing::Fill` has no fee field and the struct is frozen by the `compatible`
   * upgrade policy. The old 81-byte leaf DID commit to it, and asserting the old direction here
   * is what would silently reintroduce the divergence.
   */
  it('does NOT change when the un-committed `fee` changes', () => {
    expect(toHex(fillsRoot([{ ...base, fee: 1n }]))).toBe(toHex(fillsRoot([base])));
  });

  it('is order-sensitive — the canonical order is part of the commitment', () => {
    const b = { ...base, index: 2 };
    expect(toHex(fillsRoot([base, b]))).not.toBe(toHex(fillsRoot([b, base])));
  });
});

describe('quote conversion rounds TOWARD THE VAULT', () => {
  // These deliberately exercise the DEFAULT scale — that is the point of the block,
  // so the quantities are chosen to divide NON-exactly at PRICE_SCALE = 1e8. They
  // were tuned for 1e9 before, which made them pass by accident at the wrong scale.
  it('bids round up and asks round down', () => {
    // 150_000_000 * 1 / 1e8 = 1.5 — the only interesting case is a real remainder.
    expect(quoteForBid(150_000_000n, 1n)).toBe(2n);
    expect(quoteForAsk(150_000_000n, 1n)).toBe(1n);
  });

  it('agree when the division is exact', () => {
    // 1e6 * 1e9 / 1e8 = 1e7, exactly — no remainder, so no direction to choose.
    expect(quoteForBid(1_000_000n, 1_000_000_000n)).toBe(10_000_000n);
    expect(quoteForAsk(1_000_000n, 1_000_000_000n)).toBe(10_000_000n);
  });

  it('the bid quote is never below the ask quote — dust can never be negative', () => {
    for (let q = 0n; q < 200n; q++) {
      for (const p of [1n, 7n, 999_999_999n, 1_000_000_001n]) {
        expect(quoteForBid(q, p)).toBeGreaterThanOrEqual(quoteForAsk(q, p));
      }
    }
  });
});
