// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P3.clearing
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move — `fill_leaf_hash`, `hash_pair`, `zero_root`, `compute_root`
// @spec       aphotic.md §2.5 (clearing is deterministic and reproducible; anyone must be able to
//             recompute and verify) · §10 Settlement
// @rules      G10
// @depends    @noble/hashes/blake2 (blake2b-256, the exact `sui::hash::blake2b256`)
// @facts      ★ EVERY BYTE HERE IS PINNED BY move/sources/clearing.move. A change on one side
// @facts        without the other is a silent parity break, which docs/DESIGN-V2.md §9 makes a
// @facts        RELEASE BLOCKER.
// @facts      LEAF_TAG = 0x00 · NODE_TAG = 0x01   (clearing.move; NOT the notes.move tags, which
// @facts        are 0x00/0x01/0x03 over a different domain — do not cross-import them)
// @facts      leaf  = blake2b256(0x00 ‖ bcs(Fill))
// @facts      node  = blake2b256(0x01 ‖ left ‖ right), ODD NODE DUPLICATED
// @facts      empty = 32 ZERO BYTES — not the hash of nothing (clearing.move::zero_root)
// @facts      bcs(Fill), 73 bytes, field order VERBATIM from `public struct Fill`:
// @facts        u64 batch_id ‖ u64 order_index ‖ address submitter(32 raw) ‖ bool is_bid(1)
// @facts        ‖ u64 base_sats ‖ u64 quote_sats ‖ u64 price
// @facts      ⚠ Move `bcs::to_bytes` writes u64 LITTLE-ENDIAN and `bool` as 0x00/0x01. The Seal
// @facts        identity trap (docs/DESIGN-V2.md F1) is the same class of bug in a neighbouring
// @facts        file; write the endianness down and test it against a hand-built pre-image.
// @facts      ⚠ A Sui `address` is 32 RAW bytes with NO length prefix in BCS.
// @implements export const LEAF_TAG / NODE_TAG / DIGEST_LEN / ADDRESS_LEN / FILL_BCS_LEN
// @implements export function blake2b256(data: Uint8Array): Uint8Array
// @implements export function writeU64Le(value: bigint): Uint8Array
// @implements export function addressBytes(address: string): Uint8Array
// @implements export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array
// @implements export function hashLeaf(bcsBytes: Uint8Array): Uint8Array
// @implements export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array
// @implements export function zeroRoot(): Uint8Array
// @implements export function merkleRootDuplicatingOdd(leaves: readonly Uint8Array[]): Uint8Array
// @forbidden  a big-endian u64 anywhere in this file — Move BCS is little-endian
// @forbidden  hashing an empty leaf set into anything but 32 zero bytes
// @invariant  1. writeU64Le is exactly 8 bytes and rejects anything outside [0, 2^64).
// @invariant  2. addressBytes is exactly 32 bytes, LEFT-padded, exactly as Sui renders an id.
// @invariant  3. merkleRootDuplicatingOdd([]) === 32 zero bytes.
// @invariant  4. A single leaf roots to ITSELF (Move's loop does not run for length 1).
// @ac         test/clearing.test.ts — hand-built pre-image vectors, not self-comparison
// @verify     npm run test -- clearing
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { blake2b } from '@noble/hashes/blake2.js';

import { hexToBytes } from '../util/bytes.js';

/** `clearing.move` LEAF_TAG. */
export const LEAF_TAG = 0x00;
/** `clearing.move` NODE_TAG. */
export const NODE_TAG = 0x01;
export const DIGEST_LEN = 32;
export const ADDRESS_LEN = 32;
/** 8 + 8 + 32 + 1 + 8 + 8 + 8. */
export const FILL_BCS_LEN = 73;

const U64_CEIL = 1n << 64n;

/** `sui::hash::blake2b256`. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: DIGEST_LEN });
}

/** Move `bcs::to_bytes(&u64)` — 8 bytes, LITTLE-ENDIAN. */
export function writeU64Le(value: bigint): Uint8Array {
  if (value < 0n || value >= U64_CEIL) {
    throw new RangeError(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A Sui address in BCS: 32 raw bytes, no length prefix, left-padded. */
export function addressBytes(address: string): Uint8Array {
  const raw = hexToBytes(address);
  if (raw.length > ADDRESS_LEN) {
    throw new RangeError(`address must be at most ${ADDRESS_LEN} bytes, got ${raw.length}`);
  }
  const out = new Uint8Array(ADDRESS_LEN);
  out.set(raw, ADDRESS_LEN - raw.length);
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `blake2b256(0x00 ‖ bcs)`. */
export function hashLeaf(bcsBytes: Uint8Array): Uint8Array {
  return blake2b256(concatBytes(Uint8Array.of(LEAF_TAG), bcsBytes));
}

/** `blake2b256(0x01 ‖ l ‖ r)`. */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(concatBytes(Uint8Array.of(NODE_TAG), left, right));
}

/** `clearing.move::zero_root` — 32 zero bytes, NOT a hash. */
export function zeroRoot(): Uint8Array {
  return new Uint8Array(DIGEST_LEN);
}

/**
 * `clearing.move::compute_root` — pairwise blake2b with the ODD NODE DUPLICATED, bottom up.
 * An empty leaf set roots to {@link zeroRoot} (invariant 3); a single leaf is its own root.
 */
export function merkleRootDuplicatingOdd(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return zeroRoot();
  let level: Uint8Array[] = [...leaves];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const l = level[j] as Uint8Array;
      const r = (level[j + 1] ?? l) as Uint8Array;
      next.push(hashNode(l, r));
    }
    level = next;
  }
  return level[0] as Uint8Array;
}
