// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      4
// @status     DONE
// @spec       docs/DESIGN-V2.md §5.6 (the root, odd nodes duplicated, empty set
//             roots to 32 ZERO bytes)
// @spec       move/sources/clearing.move — `fill_leaf_hash`, `hash_pair`,
//             `zero_root`, `compute_root`, `verify_fill`
// @rules      G8
// @depends    ../src/lib/fills.ts (F3)
// @facts      THE LEAF IS 73 BYTES: u64 batch_id ‖ u64 order_index ‖ 32B address
// @facts        ‖ bool ‖ u64 base ‖ u64 quote ‖ u64 price = 8+8+32+1+8+8+8. The
// @facts        §5bis(d) layout in the sdk is 81 and carries a fee term the Move
// @facts        struct does not — which is exactly why the two roots can never
// @facts        agree, and why this app hashes the DEPLOYED struct.
// @facts      ODD NODES ARE DUPLICATED, not zero-padded. Every odd length below is
// @facts        tested at EVERY index, because the duplication rule is only
// @facts        exercised at the last node of an odd level and a path builder that
// @facts        pads instead is wrong exactly there.
// @implements the client-side Merkle prover's correctness
// @forbidden  a network call — this suite is pure arithmetic
// @invariant  1. fillsRoot([]) is 32 zero bytes.
// @invariant  2. Every index of every length 1..9 folds back to the root.
// @invariant  3. Changing any field of a fill changes the root.
// @ac         cd app && npm test -- fills
// @verify     cd app && npm test -- fills
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { bytesEqual, toHex } from '@aphotic/sdk/hash';

import type { FillRow } from '../src/lib/batch';
import {
  encodeFillLeaf,
  fillLeafHash,
  fillSiblings,
  fillsRoot,
  rootFromFillPath,
} from '../src/lib/fills';

function fill(index: number, over: Partial<FillRow> = {}): FillRow {
  return {
    index,
    batchId: 7n,
    orderIndex: BigInt(index),
    submitter: `0x${String(index + 1).padStart(64, '0')}`,
    isBid: index % 2 === 0,
    baseSats: 1_000_000n * BigInt(index + 1),
    quoteSats: 999_000n * BigInt(index + 1),
    price: 99_900_000n,
    ...over,
  };
}

const fills = (n: number): FillRow[] => Array.from({ length: n }, (_, i) => fill(i));

describe('the deployed fill leaf', () => {
  it('serialises to exactly 73 bytes', () => {
    // 8 + 8 + 32 + 1 + 8 + 8 + 8. If this changes, every published root changes.
    expect(encodeFillLeaf(fill(0))).toHaveLength(73);
  });

  it('is sensitive to every field, one at a time', () => {
    const base = toHex(fillLeafHash(fill(0)));
    const mutations: Partial<FillRow>[] = [
      { batchId: 8n },
      { orderIndex: 1n },
      { submitter: `0x${'ab'.repeat(32)}` },
      { isBid: false },
      { baseSats: 1n },
      { quoteSats: 1n },
      { price: 1n },
    ];
    for (const mutation of mutations) {
      const field = Object.keys(mutation)[0] ?? "?";
      expect(toHex(fillLeafHash(fill(0, mutation))), field).not.toBe(base);
    }
  });
});

describe('the published root', () => {
  it('is 32 ZERO bytes for an empty fill set, not a hash of nothing', () => {
    const root = fillsRoot([]);
    expect(root).toHaveLength(32);
    expect(root.every((b) => b === 0)).toBe(true);
  });

  it('is the leaf hash itself for a single fill', () => {
    const one = fills(1);
    expect(bytesEqual(fillsRoot(one), fillLeafHash(one[0]!))).toBe(true);
  });

  it('changes when any fill in the set changes', () => {
    const set = fills(5);
    const before = toHex(fillsRoot(set));
    const after = toHex(fillsRoot([...set.slice(0, 3), fill(3, { baseSats: 42n }), set[4]!]));
    expect(after).not.toBe(before);
  });
});

describe('the sibling path', () => {
  for (let n = 1; n <= 9; n += 1) {
    it(`folds back to the root at every index of a ${n}-fill tree`, () => {
      const set = fills(n);
      const root = fillsRoot(set);
      for (let i = 0; i < n; i += 1) {
        const siblings = fillSiblings(set, i);
        const folded = rootFromFillPath(fillLeafHash(set[i]!), i, siblings);
        expect(bytesEqual(folded, root), `index ${i} of ${n}`).toBe(true);
      }
    });
  }

  it('refuses an index outside the published fills', () => {
    expect(() => fillSiblings(fills(3), 3)).toThrow(/outside/);
    expect(() => fillSiblings([], 0)).toThrow(/outside/);
  });

  it('does NOT fold to the root when the leaf is tampered with', () => {
    const set = fills(4);
    const root = fillsRoot(set);
    const siblings = fillSiblings(set, 2);
    // Same path, a fill claiming one more sat than it was awarded.
    const forged = fillLeafHash(fill(2, { baseSats: fill(2).baseSats + 1n }));
    expect(bytesEqual(rootFromFillPath(forged, 2, siblings), root)).toBe(false);
  });

  it('duplicates the odd node rather than padding with zeros', () => {
    // A 3-leaf tree: level 0 is [a, b, c] and c has no partner. The rule is
    // hash(c, c). A path builder that padded with 32 zero bytes would produce a
    // different root for index 2 — and only for index 2.
    const set = fills(3);
    const siblings = fillSiblings(set, 2);
    expect(bytesEqual(siblings[0]!, fillLeafHash(set[2]!))).toBe(true);
    expect(siblings[0]!.every((b) => b === 0)).toBe(false);
  });
});
