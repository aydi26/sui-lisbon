// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.4
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#3 (the commitment binds the PLAINTEXT, not the ciphertext)
// @rules      G10
// @depends    ../src/order.ts
// @facts      The attack this file guards: publish one ciphertext, later claim a DIFFERENT
// @facts        plaintext decrypted from it. Binding the plaintext closes it — and the test
// @facts        below proves the commitment does not move when ct_hash or blob_id change.
// @implements describe('Order codec') · describe('commitment binds the plaintext')
// @verify     npx vitest run order
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { SIDE_ASK, SIDE_BID } from '../src/clearing.js';
import { blake2b256, toHex } from '../src/hash.js';
import { U128_MAX, U64_MAX } from '../src/math.js';
import {
  commitment,
  decodeOrder,
  encodeOrder,
  encodeSealedOrder,
  SALT_LEN,
  verifyReveal,
  type Order,
  type SealedOrder,
} from '../src/order.js';
import { createRng } from '../src/rng.js';

const salt = (fill: number): Uint8Array => new Uint8Array(SALT_LEN).fill(fill);

const base: Order = {
  side: SIDE_BID,
  limitPrice: 45_000_000_000n,
  qtyBase: 1_000_000n,
  salt: salt(0xab),
};

describe('Order BCS codec', () => {
  it('lays the fields out as u8 || u128 LE || u64 LE || uleb-prefixed salt', () => {
    const bytes = encodeOrder(base);
    expect(bytes.length).toBe(1 + 16 + 8 + 1 + 32);
    expect(bytes[0]).toBe(SIDE_BID);
    // 45e9 = 0x0a7a358200 -> 16 LE bytes, LOW byte first
    expect(toHex(bytes.subarray(1, 17))).toBe('0x0082357a0a0000000000000000000000');
    // 1e6 = 0x0f4240 -> 8 LE bytes
    expect(toHex(bytes.subarray(17, 25))).toBe('0x40420f0000000000');
    expect(bytes[25]).toBe(SALT_LEN); // ULEB128 of 32 is a single byte, at offset 1+16+8
  });

  it('round-trips', () => {
    expect(decodeOrder(encodeOrder(base))).toEqual(base);
  });

  it('round-trips the extremes', () => {
    const extreme: Order = {
      side: SIDE_ASK,
      limitPrice: U128_MAX,
      qtyBase: U64_MAX,
      salt: salt(0xff),
    };
    expect(decodeOrder(encodeOrder(extreme))).toEqual(extreme);
  });

  it('round-trips 500 random orders', () => {
    const rng = createRng('order-roundtrip');
    for (let i = 0; i < 500; i++) {
      const o: Order = {
        side: rng.nextInt(2) === 0 ? SIDE_BID : SIDE_ASK,
        limitPrice: rng.nextU64() * rng.nextU64(),
        qtyBase: rng.nextU64(),
        salt: rng.bytes(32),
      };
      expect(decodeOrder(encodeOrder(o))).toEqual(o);
    }
  });

  it('rejects trailing bytes', () => {
    const bytes = encodeOrder(base);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => decodeOrder(padded)).toThrow(/trailing byte/);
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeOrder(encodeOrder(base).subarray(0, 20))).toThrow(/need/);
  });

  it('rejects a bad side on both encode and decode', () => {
    expect(() => encodeOrder({ ...base, side: 2 as never })).toThrow(/EBadSide/);
    const bytes = encodeOrder(base);
    bytes[0] = 7;
    expect(() => decodeOrder(bytes)).toThrow(/EBadSide/);
  });

  it('rejects a multi-byte ULEB128 salt length', () => {
    const bytes = encodeOrder(base);
    bytes[25] = 0x80; // ULEB128 continuation bit set on the salt length
    expect(() => decodeOrder(bytes)).toThrow(/ESaltTooLong/);
  });
});

describe('commitment binds the PLAINTEXT', () => {
  it('is blake2b256(bcs(Order))', () => {
    expect(toHex(commitment(base))).toBe(toHex(blake2b256(encodeOrder(base))));
  });

  it('changes when the side changes', () => {
    expect(toHex(commitment(base))).not.toBe(toHex(commitment({ ...base, side: SIDE_ASK })));
  });

  it('changes when the price changes by one unit', () => {
    expect(toHex(commitment(base))).not.toBe(
      toHex(commitment({ ...base, limitPrice: base.limitPrice + 1n })),
    );
  });

  it('changes when the quantity changes by one sat', () => {
    expect(toHex(commitment(base))).not.toBe(
      toHex(commitment({ ...base, qtyBase: base.qtyBase + 1n })),
    );
  });

  it('changes when the salt changes — without it, the (side, price, qty) space is brute-forcible', () => {
    expect(toHex(commitment(base))).not.toBe(toHex(commitment({ ...base, salt: salt(0xac) })));
  });

  it('does NOT move when ct_hash or blob_id change — those are locators, not bindings', () => {
    const c = commitment(base);
    const s1: SealedOrder = {
      submitter: '0x1',
      commitment: c,
      ctHash: blake2b256(Uint8Array.of(1)),
      blobId: Uint8Array.of(1, 2, 3),
      submittedMs: 1n,
    };
    const s2: SealedOrder = { ...s1, ctHash: blake2b256(Uint8Array.of(2)), blobId: Uint8Array.of(9) };
    expect(verifyReveal(s1, base)).toBe(true);
    expect(verifyReveal(s2, base)).toBe(true);
    // ...but the SealedOrder bytes do change, so the locators are still authenticated on chain.
    expect(toHex(encodeSealedOrder(s1))).not.toBe(toHex(encodeSealedOrder(s2)));
  });

  it('verifyReveal rejects a different plaintext claimed against the same commitment', () => {
    const sealed: SealedOrder = {
      submitter: '0x1',
      commitment: commitment(base),
      ctHash: new Uint8Array(32),
      blobId: new Uint8Array(0),
      submittedMs: 0n,
    };
    expect(verifyReveal(sealed, base)).toBe(true);
    expect(verifyReveal(sealed, { ...base, qtyBase: 999n })).toBe(false);
    expect(verifyReveal(sealed, { ...base, side: SIDE_ASK })).toBe(false);
    expect(verifyReveal(sealed, { ...base, salt: salt(0x00) })).toBe(false);
  });

  it('produces 1000 distinct commitments from 1000 distinct salts', () => {
    const rng = createRng('order-commitments');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(toHex(commitment({ ...base, salt: rng.bytes(32) })));
    expect(seen.size).toBe(1000);
  });
});

describe('SealedOrder carries no size, side or price', () => {
  it('has exactly the five locator/identity fields', () => {
    const sealed: SealedOrder = {
      submitter: '0x2a',
      commitment: commitment(base),
      ctHash: blake2b256(Uint8Array.of(0)),
      blobId: new TextEncoder().encode('blob'),
      submittedMs: 1785088800000n,
    };
    expect(Object.keys(sealed).sort()).toEqual([
      'blobId',
      'commitment',
      'ctHash',
      'submittedMs',
      'submitter',
    ]);
    expect(encodeSealedOrder(sealed).length).toBe(32 + 1 + 32 + 1 + 32 + 1 + 4 + 8);
  });
});
