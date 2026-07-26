// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md §3 ("the commitment binds the PLAINTEXT, not the
//             ciphertext"), §5 (price denomination)
// @spec       aphotic.md §7.2 step 1 · §7.4 (what is and is not hidden)
// @spec       move/sources/batch.move — `struct Order` and `order_commitment`
// @rules      G7 G8 G10
// @depends    @aphotic/sdk/bcs · @aphotic/sdk/hash · @aphotic/sdk/clearing
//             (PRICE_SCALE) · ./notes.ts (randomBytes)
// @facts      ★ THE SHIPPED Move `Order` IS NOT `sdk/src/order.ts`'s Order. ★
// @facts        move/sources/batch.move declares
// @facts          Order { submitter: address, is_bid: bool, limit_price: u64,
// @facts                  qty_sats: u64, salt: vector<u8> }
// @facts        so bcs(Order) = 32B address ‖ 1B bool ‖ u64 LE ‖ u64 LE ‖ ULEB
// @facts        length ‖ salt.  `sdk/src/order.ts` encodes
// @facts          u8 side ‖ u128 limit_price ‖ u64 qty ‖ vector salt
// @facts        — no submitter, a u8 side, a u128 price. Its commitment can never
// @facts        equal `batch::order_commitment`, so a reveal built from it would
// @facts        abort ECommitmentMismatch and the order would go unfilled with no
// @facts        way to correct it. This module therefore encodes the DEPLOYED
// @facts        struct, using the sdk's BcsWriter and blake2b256 — the primitives,
// @facts        not a second commitment scheme.
// @facts        ⇒ REPORTED as an sdk↔Move parity break (same class as notes.ts).
// @facts      SALT_LEN = 32, asserted by `new_order` and by `reveal_order`. The
// @facts        salt is what stops a brute-force scan of the small, public
// @facts        (side, price, qty) product space from re-identifying a commitment.
// @facts      PRICE: `limit_price` is quote-sats per 1e8 base-sats, PRICE_SCALE =
// @facts        100_000_000 (`clearing::price_scale()`, and the sdk agrees). PAR is
// @facts        therefore exactly PRICE_SCALE: one quote sat per base sat. The
// @facts        redemption carry trades a DISCOUNT to par, so the ladder is
// @facts        expressed in bps below par and converts exactly — every rung lands
// @facts        on an integer.
// @facts      ⚠ THE PRICE LADDER IS COARSE ON PURPOSE. A size ladder plus an
// @facts        arbitrarily precise limit price still fingerprints the order, and a
// @facts        fingerprinted order in a uniform batch has an anonymity set of one.
// @implements export const SALT_LEN · PAR_PRICE · DISCOUNT_STEPS_BPS
// @implements export interface PlainOrder
// @implements export function encodeOrder · orderCommitment · newSalt
// @implements export function priceForDiscountBps · discountBpsForPrice
// @implements export function encodeOrderPlaintext · decodeOrderPlaintext
// @forbidden  a free-form limit-price control anywhere in app/
// @forbidden  committing to the ciphertext instead of the plaintext
// @invariant  1. orderCommitment is byte-identical to `batch::order_commitment`.
// @invariant  2. decodeOrderPlaintext(encodeOrderPlaintext(o)) deep-equals o.
// @invariant  3. Every ladder rung converts to an exact integer price.
// @ac         app/test/order.test.ts — layout, per-field sensitivity, ladder exactness
// @verify     cd app && npm run build
// @verify     cd app && npm test -- order
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { BcsWriter } from '@aphotic/sdk/bcs';
import { PRICE_SCALE } from '@aphotic/sdk/clearing';
import { blake2b256, fromHex, toHex } from '@aphotic/sdk/hash';

import { randomBytes } from './notes';

/** `batch.move`'s SALT_LEN. Asserted by `new_order` and by `reveal_order`. */
export const SALT_LEN = 32;

/** One quote sat per base sat. The carry is priced as a discount to this. */
export const PAR_PRICE: bigint = PRICE_SCALE;

/**
 * The limit ladder, in basis points below par. Coarse for the same reason the
 * size ladder is — see the banner.
 */
export const DISCOUNT_STEPS_BPS: readonly bigint[] = Object.freeze([0n, 5n, 10n, 25n, 50n, 100n]);

/** The plaintext order. Encrypted client-side; never on chain until reveal. */
export interface PlainOrder {
  readonly submitter: string;
  readonly isBid: boolean;
  /** u64, quote-sats per 1e8 base-sats. */
  readonly limitPrice: bigint;
  /** u64 sats of hBTC. Always a ladder denomination. */
  readonly qtySats: bigint;
  /** 32 bytes of client entropy. */
  readonly salt: Uint8Array;
}

/** `bcs(Order)` — the exact bytes `order_commitment` hashes. */
export function encodeOrder(order: PlainOrder): Uint8Array {
  if (order.salt.length !== SALT_LEN) {
    throw new RangeError(`salt must be ${SALT_LEN} bytes, got ${order.salt.length}`);
  }
  return new BcsWriter()
    .address(order.submitter)
    .bool(order.isBid)
    .u64(order.limitPrice)
    .u64(order.qtySats)
    .bytes(order.salt)
    .toBytes();
}

/** `blake2b256(bcs(Order))` — binds the PLAINTEXT (docs/DESIGN-V2.md §3). */
export function orderCommitment(order: PlainOrder): Uint8Array {
  return blake2b256(encodeOrder(order));
}

/** 32 fresh bytes from the platform CSPRNG. */
export function newSalt(): Uint8Array {
  return randomBytes(SALT_LEN);
}

/** `PAR × (10_000 − bps) / 10_000`. Exact for every rung of the ladder. */
export function priceForDiscountBps(bps: bigint): bigint {
  if (bps < 0n || bps > 10_000n) throw new RangeError(`discount out of range: ${bps} bps`);
  return (PAR_PRICE * (10_000n - bps)) / 10_000n;
}

/** The inverse, for rendering a price read back off chain. */
export function discountBpsForPrice(price: bigint): bigint {
  if (price >= PAR_PRICE) return 0n;
  return ((PAR_PRICE - price) * 10_000n) / PAR_PRICE;
}

// ── the ciphertext payload ──────────────────────────────────────────────────
// What is sealed is the whole plaintext order, so that ANYONE who obtains the
// key shares after close can reveal it — the property that kills grief-by-
// non-revelation. It is JSON rather than BCS on purpose: the reveal path is
// permissionless, so the payload has to be readable by a third party who has
// only the blob and the public key material, with no schema handshake.

interface WireOrder {
  readonly v: 1;
  readonly submitter: string;
  readonly isBid: boolean;
  readonly limitPrice: string;
  readonly qtySats: string;
  readonly saltHex: string;
}

export function encodeOrderPlaintext(order: PlainOrder): Uint8Array {
  const wire: WireOrder = {
    v: 1,
    submitter: order.submitter,
    isBid: order.isBid,
    limitPrice: order.limitPrice.toString(),
    qtySats: order.qtySats.toString(),
    saltHex: toHex(order.salt),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

export function decodeOrderPlaintext(bytes: Uint8Array): PlainOrder {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('order payload is not an object');
  const w = parsed as Partial<WireOrder>;
  if (
    typeof w.submitter !== 'string' ||
    typeof w.isBid !== 'boolean' ||
    typeof w.limitPrice !== 'string' ||
    typeof w.qtySats !== 'string' ||
    typeof w.saltHex !== 'string'
  ) {
    throw new Error('order payload is missing a field — refusing to reveal a half-parsed order');
  }
  return {
    submitter: w.submitter,
    isBid: w.isBid,
    limitPrice: BigInt(w.limitPrice),
    qtySats: BigInt(w.qtySats),
    salt: fromHex(w.saltHex),
  };
}
