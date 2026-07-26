// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#3 ("The commitment binds the PLAINTEXT, not the ciphertext":
//             commitment = blake2b256(bcs(Order)); ct_hash and blob_id exist only so a third
//             party can FIND the ciphertext)
// @spec       aphotic.md §7.2 step 1 (on-chain: a ciphertext hash and a balance reference —
//             no amount, no side, no price)
// @rules      G10
// @depends    ./bcs.ts · ./hash.ts · ./clearing.ts (Side)
// @facts      Order bcs = u8 side ‖ u128 limit_price ‖ u64 qty_base ‖ vector<u8> salt
// @facts      SealedOrder bcs = address submitter ‖ vector<u8> commitment ‖ vector<u8> ct_hash
// @facts                        ‖ vector<u8> blob_id ‖ u64 submitted_ms
// @facts      SALT_LEN = 32. The salt is what stops a brute-force scan of the (side, price, qty)
// @facts        product space from re-identifying a commitment — the space is small and public.
// @facts      ⚠ WHY plaintext-binding: if only ct_hash were binding, a submitter could publish
// @facts        one ciphertext and later claim a different plaintext decrypted from it. Binding
// @facts        the plaintext closes that and does NOT reintroduce commit-reveal's grief
// @facts        problem, because after close_ms ANYONE can fetch the Seal shares and reveal.
// @implements export const SALT_LEN: number
// @implements export interface Order
// @implements export interface SealedOrder
// @implements export function encodeOrder(order: Order): Uint8Array
// @implements export function decodeOrder(bytes: Uint8Array): Order
// @implements export function commitment(order: Order): Uint8Array
// @implements export function encodeSealedOrder(s: SealedOrder): Uint8Array
// @implements export function verifyReveal(sealed: SealedOrder, order: Order): boolean
// @forbidden  committing to the CIPHERTEXT — docs/DESIGN-V2.md §3 explains exactly why
// @forbidden  an amount, side or price field on SealedOrder — that is the leak the design exists
//             to close (aphotic.md §2.3, §2.4)
// @invariant  1. decodeOrder(encodeOrder(o)) deep-equals o, and rejects trailing bytes.
// @invariant  2. commitment is collision-sensitive in EVERY field, salt included.
// @invariant  3. verifyReveal(s, o) is true iff blake2b256(bcs(o)) == s.commitment.
// @ac         test/order.test.ts — round-trip, per-field sensitivity, trailing-byte rejection
// @verify     npx vitest run order
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { BcsReader, BcsWriter } from './bcs.js';
import { blake2b256, bytesEqual } from './hash.js';
import { SIDE_ASK, SIDE_BID, type Side } from './clearing.js';

/** The salt is 32 bytes — the (side, price, qty) space is small and public. */
export const SALT_LEN = 32;

/** The PLAINTEXT order. Encrypted client-side under the Seal time-lock; never on chain. */
export interface Order {
  readonly side: Side;
  /** u128, scaled by `clearing.PRICE_SCALE`. */
  readonly limitPrice: bigint;
  /** u64 base units. */
  readonly qtyBase: bigint;
  /** 32 bytes of client entropy. */
  readonly salt: Uint8Array;
}

/** What `submit_order` actually writes on chain. Carries no amount, no side, no price. */
export interface SealedOrder {
  readonly submitter: string;
  /** `blake2b256(bcs(Order))` — binds the PLAINTEXT. */
  readonly commitment: Uint8Array;
  /** `blake2b256(ciphertext)` — a locator, NOT a binding. */
  readonly ctHash: Uint8Array;
  /** Walrus blob id holding the ciphertext — a locator, NOT a binding. */
  readonly blobId: Uint8Array;
  readonly submittedMs: bigint;
}

/** `bcs(Order)` — the exact bytes the commitment hashes. */
export function encodeOrder(order: Order): Uint8Array {
  if (order.side !== SIDE_BID && order.side !== SIDE_ASK) {
    throw new RangeError(`EBadSide: ${String(order.side)}`);
  }
  return new BcsWriter()
    .u8(order.side)
    .u128(order.limitPrice)
    .u64(order.qtyBase)
    .bytes(order.salt)
    .toBytes();
}

/** Inverse of {@link encodeOrder}. Rejects trailing bytes. */
export function decodeOrder(bytes: Uint8Array): Order {
  const r = new BcsReader(bytes);
  const side = r.u8();
  if (side !== SIDE_BID && side !== SIDE_ASK) throw new RangeError(`EBadSide: ${side}`);
  const limitPrice = r.u128();
  const qtyBase = r.u64();
  const saltLen = r.u8(); // ULEB128 — salts are < 128 bytes, so one byte, always
  if (saltLen > 0x7f) throw new RangeError('ESaltTooLong: multi-byte ULEB128 salt length');
  const salt = r.fixedBytes(saltLen);
  r.finish('Order');
  return { side, limitPrice, qtyBase, salt };
}

/** THE commitment: `blake2b256(bcs(Order))`. Binds the plaintext (docs/DESIGN-V2.md §3). */
export function commitment(order: Order): Uint8Array {
  return blake2b256(encodeOrder(order));
}

/** `bcs(SealedOrder)` — for the on-chain object and for journal digests. */
export function encodeSealedOrder(s: SealedOrder): Uint8Array {
  return new BcsWriter()
    .address(s.submitter)
    .bytes(s.commitment)
    .bytes(s.ctHash)
    .bytes(s.blobId)
    .u64(s.submittedMs)
    .toBytes();
}

/** True iff `order` is the plaintext `sealed` committed to. This is what `reveal_order` checks. */
export function verifyReveal(sealed: SealedOrder, order: Order): boolean {
  return bytesEqual(commitment(order), sealed.commitment);
}
