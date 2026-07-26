// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#3 (bcs u64 LITTLE-ENDIAN; leftovers MUST be empty)
// @rules      G10
// @depends    ../src/bcs.ts · ../src/address.ts
// @facts      Every assertion here exists because F1 is an endianness bug that fails SILENTLY.
// @implements describe('BCS integers') · describe('BcsReader leftovers')
// @verify     npx vitest run bcs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BcsReader,
  BcsWriter,
  concatBytes,
  encodeU128LE,
  encodeU64BE,
  encodeU64LE,
  uleb128,
} from '../src/bcs.js';
import { toHex } from '../src/hash.js';
import { U128_MAX, U64_MAX } from '../src/math.js';

describe('BCS integers are LITTLE-ENDIAN', () => {
  it('encodes u64 1 as 01 00 00 00 00 00 00 00', () => {
    expect(toHex(encodeU64LE(1n))).toBe('0x0100000000000000');
  });

  it('encodes u64 0x0102030405060708 with the LOW byte first', () => {
    expect(toHex(encodeU64LE(0x0102030405060708n))).toBe('0x0807060504030201');
  });

  it('encodes u128 1 as 01 followed by 15 zero bytes', () => {
    expect(toHex(encodeU128LE(1n))).toBe(`0x01${'00'.repeat(15)}`);
  });

  it('encodes the maxima', () => {
    expect(toHex(encodeU64LE(U64_MAX))).toBe(`0x${'ff'.repeat(8)}`);
    expect(toHex(encodeU128LE(U128_MAX))).toBe(`0x${'ff'.repeat(16)}`);
  });

  it('rejects out-of-range integers', () => {
    expect(() => encodeU64LE(U64_MAX + 1n)).toThrow(/u64/);
    expect(() => encodeU128LE(U128_MAX + 1n)).toThrow(/u128/);
    expect(() => encodeU64LE(-1n)).toThrow(/u64/);
  });

  it('encodeU64BE is the exact reverse — and is NOT BCS', () => {
    const n = 0x0102030405060708n;
    const le = encodeU64LE(n);
    const be = encodeU64BE(n);
    expect(toHex(be)).toBe('0x0102030405060708');
    expect([...be]).toEqual([...le].reverse());
  });
});

describe('ULEB128', () => {
  it('is one byte below 128', () => {
    expect(toHex(uleb128(0))).toBe('0x00');
    expect(toHex(uleb128(1))).toBe('0x01');
    expect(toHex(uleb128(127))).toBe('0x7f');
  });

  it('is two bytes from 128', () => {
    expect(toHex(uleb128(128))).toBe('0x8001');
    expect(toHex(uleb128(300))).toBe('0xac02');
  });

  it('is three bytes from 16384', () => {
    expect(toHex(uleb128(16384))).toBe('0x808001');
  });

  it('rejects a negative or fractional length', () => {
    expect(() => uleb128(-1)).toThrow();
    expect(() => uleb128(1.5)).toThrow();
  });
});

describe('BcsWriter', () => {
  it('lays fields out in call order', () => {
    const b = new BcsWriter().u8(0x01).u64(2n).bool(true).toBytes();
    expect(toHex(b)).toBe('0x010200000000000000' + '01');
  });

  it('writes an address as 32 RAW bytes with no length prefix', () => {
    const b = new BcsWriter().address('0x1').toBytes();
    expect(b.length).toBe(32);
    expect(toHex(b)).toBe(`0x${'00'.repeat(31)}01`);
  });

  it('writes vector<u8> with a ULEB128 length prefix', () => {
    const b = new BcsWriter().bytes(Uint8Array.of(0xaa, 0xbb)).toBytes();
    expect(toHex(b)).toBe('0x02aabb');
  });

  it('writes fixedBytes with NO length prefix', () => {
    const b = new BcsWriter().fixedBytes(Uint8Array.of(0xaa, 0xbb)).toBytes();
    expect(toHex(b)).toBe('0xaabb');
  });

  it('rejects an out-of-range u8', () => {
    expect(() => new BcsWriter().u8(256)).toThrow(/u8 out of range/);
    expect(() => new BcsWriter().u8(-1)).toThrow(/u8 out of range/);
  });

  it('copies its inputs — mutating the source afterwards does not change the output', () => {
    const src = Uint8Array.of(1, 2, 3);
    const w = new BcsWriter().bytes(src);
    src[0] = 0xff;
    expect(toHex(w.toBytes())).toBe('0x03010203');
  });
});

describe('BcsReader — the MANDATORY leftovers check', () => {
  it('round-trips every scalar type', () => {
    const addr = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    const bytes = new BcsWriter().u8(9).u64(1234n).u128(U128_MAX).address(addr).toBytes();
    const r = new BcsReader(bytes);
    expect(r.u8()).toBe(9);
    expect(r.u64()).toBe(1234n);
    expect(r.u128()).toBe(U128_MAX);
    expect(r.address()).toBe(addr);
    expect(() => r.finish()).not.toThrow();
  });

  it('throws when even ONE byte is left over', () => {
    const bytes = concatBytes(encodeU64LE(1n), Uint8Array.of(0x00));
    const r = new BcsReader(bytes);
    expect(r.u64()).toBe(1n);
    expect(r.remaining()).toBe(1);
    expect(() => r.finish('inner id')).toThrow(/1 trailing byte\(s\)/);
  });

  it('throws when the buffer is short', () => {
    const r = new BcsReader(Uint8Array.of(1, 2, 3));
    expect(() => r.u64()).toThrow(/need 8 bytes/);
  });

  it('decodes exactly what encodeU64LE wrote, for 500 random u64s', () => {
    for (let i = 0; i < 500; i++) {
      const n = BigInt(i) * 0x0123456789abcdefn % (U64_MAX + 1n);
      const r = new BcsReader(encodeU64LE(n));
      expect(r.u64()).toBe(n);
      expect(() => r.finish()).not.toThrow();
    }
  });
});

describe('concatBytes', () => {
  it('joins in order and allocates fresh', () => {
    const a = Uint8Array.of(1, 2);
    const out = concatBytes(a, Uint8Array.of(3));
    a[0] = 0xff;
    expect(toHex(out)).toBe('0x010203');
  });

  it('handles zero parts', () => {
    expect(concatBytes().length).toBe(0);
  });
});
