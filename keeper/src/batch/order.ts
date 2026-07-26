// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.order
// @phase      2
// @status     DONE
// @spec       move/sources/batch.move — `public struct Order`, `public fun new_order`,
//             `public fun order_commitment(o: &Order): vector<u8>` = `blake2b256(bcs::to_bytes(o))`
// @spec       docs/DESIGN-V2.md §3 ("The commitment binds the PLAINTEXT, not the ciphertext")
// @rules      G10
// @depends    @mysten/sui/bcs · ../clearing/bytes.ts (blake2b256 — the exact sui::hash::blake2b256)
// @facts      ★ THE COMMITMENT BINDS THE PLAINTEXT. If only `ct_hash` were binding, a submitter
// @facts        could publish one ciphertext and later claim a different plaintext decrypted from
// @facts        it. Binding to `bcs(Order)` closes that, and it does NOT reintroduce commit–reveal
// @facts        grief: after `close_ms` anyone can fetch the Seal shares and produce the reveal.
// @facts      ★ BCS LAYOUT, field order VERBATIM from `public struct Order`:
// @facts          address submitter (32 RAW bytes, no length prefix)
// @facts        ‖ bool    is_bid    (1 byte, 0x00/0x01)
// @facts        ‖ u64     limit_price (8, LITTLE-ENDIAN)
// @facts        ‖ u64     qty_sats    (8, LITTLE-ENDIAN)
// @facts        ‖ vector<u8> salt    (ULEB128 length ‖ bytes; SALT_LEN is fixed at 32)
// @facts        = 82 bytes, CONSTANT. The constant length is not an accident: it is why a
// @facts        ciphertext leaks nothing about the order, and why no extra padding frame is needed.
// @facts      ⚠ `new_order` asserts `salt.length() == 32`, `qty_sats > 0` and `limit_price > 0`.
// @facts        Every one of those is checked HERE too, so a bad order is refused before it costs
// @facts        gas rather than after.
// @facts      ⚠ Decoding re-encodes canonically before hashing. A non-canonical BCS encoding that
// @facts        parsed but re-encoded differently would produce a commitment mismatch — which is
// @facts        exactly the outcome we want, surfaced as a mismatch rather than as an on-chain abort.
// @implements export const SALT_LEN / ORDER_BCS_LEN
// @implements export interface PlainOrder
// @implements export function encodeOrder(o: PlainOrder): Uint8Array
// @implements export function decodeOrder(bytes: Uint8Array): PlainOrder
// @implements export function orderCommitment(o: PlainOrder): Uint8Array
// @implements export function assertOrderUsable(o: PlainOrder): PlainOrder
// @forbidden  a big-endian u64 anywhere here — Move BCS is little-endian
// @forbidden  hashing the ciphertext instead of the plaintext
// @invariant  1. `encodeOrder` is exactly ORDER_BCS_LEN bytes for every valid order.
// @invariant  2. `decodeOrder(encodeOrder(o))` deep-equals `o`.
// @invariant  3. `orderCommitment` equals `batch::order_commitment` byte for byte.
// @ac         test/reveal.test.ts — round trip, a hand-built pre-image, and salt-length refusal
// @verify     npm run test -- reveal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';

import { blake2b256 } from '../clearing/bytes.js';
import type { SuiAddress } from '../types.js';
import { AphoticError } from '../util/errors.js';

/** `batch.move` SALT_LEN. */
export const SALT_LEN = 32;
/** 32 + 1 + 8 + 8 + 1 (ULEB for 32) + 32. Constant by construction. */
export const ORDER_BCS_LEN = 82;

export interface PlainOrder {
  readonly submitter: SuiAddress;
  readonly isBid: boolean;
  readonly limitPrice: bigint;
  readonly qtySats: bigint;
  readonly salt: Uint8Array;
}

const ORDER_BCS = bcs.struct('Order', {
  submitter: bcs.Address,
  is_bid: bcs.bool(),
  limit_price: bcs.u64(),
  qty_sats: bcs.u64(),
  salt: bcs.vector(bcs.u8()),
});

/** The three `new_order` / `reveal_order` asserts, checked before a byte of gas is spent. */
export function assertOrderUsable(o: PlainOrder): PlainOrder {
  if (o.salt.length !== SALT_LEN) {
    throw new AphoticError(
      'EBadOrder',
      `salt must be exactly ${SALT_LEN} bytes — got ${o.salt.length}; batch::new_order aborts EBadOrder`,
    );
  }
  if (o.qtySats <= 0n) {
    throw new AphoticError('EBadOrder', `qty_sats must be > 0 — got ${o.qtySats}`);
  }
  if (o.limitPrice <= 0n) {
    throw new AphoticError('EBadOrder', `limit_price must be > 0 — got ${o.limitPrice}`);
  }
  return o;
}

/** `bcs::to_bytes(&Order)`, byte-identical to what Move hashes (invariant 1). */
export function encodeOrder(o: PlainOrder): Uint8Array {
  assertOrderUsable(o);
  return ORDER_BCS.serialize({
    submitter: o.submitter,
    is_bid: o.isBid,
    limit_price: o.limitPrice,
    qty_sats: o.qtySats,
    salt: Array.from(o.salt),
  }).toBytes();
}

/**
 * Parse a decrypted order frame.
 *
 * Trailing bytes are REFUSED rather than ignored: the frame is a constant 82 bytes, so anything
 * longer is a different payload than the one the commitment was taken over, and silently
 * truncating it would turn a substituted ciphertext into a successful reveal.
 */
export function decodeOrder(bytes: Uint8Array): PlainOrder {
  if (bytes.length !== ORDER_BCS_LEN) {
    throw new AphoticError(
      'EBadOrder',
      `decrypted order frame is ${bytes.length} bytes, expected exactly ${ORDER_BCS_LEN}`,
    );
  }
  const raw = ORDER_BCS.parse(bytes);
  return assertOrderUsable({
    submitter: raw.submitter,
    isBid: raw.is_bid,
    limitPrice: BigInt(raw.limit_price),
    qtySats: BigInt(raw.qty_sats),
    salt: Uint8Array.from(raw.salt),
  });
}

/** `batch::order_commitment` — `blake2b256(bcs(Order))` (invariant 3). */
export function orderCommitment(o: PlainOrder): Uint8Array {
  return blake2b256(encodeOrder(o));
}
