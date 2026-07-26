// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      4
// @status     DONE
// @spec       docs/DESIGN-V2.md §5.6 (root = blake2b256 Merkle over
//             blake2b256(0x00 ‖ bcs(FillLeaf)), canonical order, odd nodes
//             duplicated; an empty fill set roots to 32 ZERO bytes)
// @spec       move/sources/clearing.move — `struct Fill`, `fill_leaf_hash`,
//             `hash_pair`, `zero_root`, `compute_root`, `verify_fill`
// @rules      G7 G8 G10
// @depends    @aphotic/sdk/bcs · @aphotic/sdk/hash · ./batch.ts (FillRow)
// @facts      THE DEPLOYED LEAF, field for field:
// @facts        Fill { batch_id: u64, order_index: u64, submitter: address,
// @facts                is_bid: bool, base_sats: u64, quote_sats: u64, price: u64 }
// @facts        leaf = blake2b256(0x00 ‖ bcs(Fill))   — LEAF_TAG = 0x00
// @facts        node = blake2b256(0x01 ‖ left ‖ right) — NODE_TAG = 0x01
// @facts      ⚠ `sdk/src/clearing.ts::encodeFillLeaf` encodes a DIFFERENT leaf —
// @facts        `u64 index ‖ address ‖ u8 side ‖ u128 price ‖ u64 qty ‖ u64 quote
// @facts        ‖ u64 fee` (docs/DESIGN-V2 §5bis(d)) — with no batch_id and a fee
// @facts        term the Move struct does not carry. The two roots can never
// @facts        agree. This module mirrors the DEPLOYED struct, because the thing
// @facts        a user proves against is the root the contract published.
// @facts        ⇒ REPORTED as an sdk↔Move parity break. The TAGS are the sdk's and
// @facts        do agree (0x00 leaf / 0x01 node), so `hashLeafBytes` and
// @facts        `hashNodeBytes` are imported rather than re-written.
// @facts      ODD-NODE DUPLICATION, not zero-padding: a level of odd length hashes
// @facts        its last node with ITSELF. The proof path must duplicate the same
// @facts        way or it folds to a root nobody published.
// @implements export function encodeFillLeaf · fillLeafHash · fillsRoot
// @implements export function fillSiblings · rootFromFillPath
// @forbidden  a second blake2b — the sdk owns the primitive
// @forbidden  proving against a root this browser computed instead of the one the
//             contract published: `verify_fill` compares against `c.fills_root`,
//             and so must every claim this app makes
// @invariant  1. fillsRoot([]) is 32 zero bytes, matching `zero_root()`.
// @invariant  2. rootFromFillPath(leaf_i, i, fillSiblings(fills, i)) == fillsRoot(fills)
//                for every i and every length, odd lengths included.
// @ac         app/test/fills.test.ts — the empty root, odd-length duplication, and
//             every index of a 1..9-fill tree folding back to the root.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- fills
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { BcsWriter } from '@aphotic/sdk/bcs';
import { hashLeafBytes, hashNodeBytes } from '@aphotic/sdk/hash';

import type { FillRow } from './batch';

/** `bcs(Fill)` — the deployed struct's field order, exactly. */
export function encodeFillLeaf(fill: FillRow): Uint8Array {
  return new BcsWriter()
    .u64(fill.batchId)
    .u64(fill.orderIndex)
    .address(fill.submitter)
    .bool(fill.isBid)
    .u64(fill.baseSats)
    .u64(fill.quoteSats)
    .u64(fill.price)
    .toBytes();
}

/** `blake2b256(0x00 ‖ bcs(Fill))`. */
export function fillLeafHash(fill: FillRow): Uint8Array {
  return hashLeafBytes(encodeFillLeaf(fill));
}

/** `clearing::compute_root` — odd nodes duplicated, empty set ⇒ 32 zero bytes. */
export function fillsRoot(fills: readonly FillRow[]): Uint8Array {
  if (fills.length === 0) return new Uint8Array(32);
  let level = fills.map(fillLeafHash);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // the odd node is hashed with ITSELF
      next.push(hashNodeBytes(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** The sibling path for one fill, duplicating odd nodes the same way the tree does. */
export function fillSiblings(fills: readonly FillRow[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= fills.length) {
    throw new RangeError(`fill index ${index} is outside the ${fills.length} published fills`);
  }
  const siblings: Uint8Array[] = [];
  let level = fills.map(fillLeafHash);
  let idx = index;
  while (level.length > 1) {
    const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(level[pair] ?? level[idx]!); // no right neighbour ⇒ itself
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashNodeBytes(level[i]!, level[i + 1] ?? level[i]!));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return siblings;
}

/** The twin of `verify_fill`'s fold, so the browser can check before it asks the chain. */
export function rootFromFillPath(
  leaf: Uint8Array,
  index: number,
  siblings: readonly Uint8Array[],
): Uint8Array {
  let current = leaf;
  let idx = index;
  for (const sibling of siblings) {
    current = idx % 2 === 0 ? hashNodeBytes(current, sibling) : hashNodeBytes(sibling, current);
    idx = Math.floor(idx / 2);
  }
  return current;
}
