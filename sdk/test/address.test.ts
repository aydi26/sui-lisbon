// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#5.1 (canonical tie-break is submitter BYTES ascending)
// @rules      G10
// @depends    ../src/address.ts · ../src/rng.ts
// @facts      The clearing sort compares NORMALISED HEX STRINGS. This file proves that is
// @facts        equivalent to memcmp on the 32 raw bytes, which is what Move compares.
// @implements describe('normalizeAddress') · describe('compareAddress')
// @verify     npx vitest run address
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  ADDRESS_LEN,
  addressBytes,
  addressFromBytes,
  compareAddress,
  normalizeAddress,
} from '../src/address.js';
import { createRng } from '../src/rng.js';

describe('normalizeAddress', () => {
  it('left-pads short forms to 32 bytes', () => {
    expect(normalizeAddress('0x1')).toBe(`0x${'0'.repeat(63)}1`);
    expect(normalizeAddress('0x2a')).toBe(`0x${'0'.repeat(62)}2a`);
  });

  it('lowercases and accepts a bare (0x-less) form', () => {
    expect(normalizeAddress('0xAB')).toBe(`0x${'0'.repeat(62)}ab`);
    expect(normalizeAddress('ab')).toBe(`0x${'0'.repeat(62)}ab`);
  });

  it('is idempotent', () => {
    const a = normalizeAddress('0xDeadBeef');
    expect(normalizeAddress(a)).toBe(a);
  });

  it('rejects non-hex and over-long input', () => {
    expect(() => normalizeAddress('0xzz')).toThrow(/not a hex address/);
    expect(() => normalizeAddress(`0x${'a'.repeat(65)}`)).toThrow(/longer than 32 bytes/);
  });

  it('agrees that 0x1 and the padded form are the SAME address', () => {
    expect(compareAddress('0x1', `0x${'0'.repeat(63)}1`)).toBe(0);
  });
});

describe('addressBytes', () => {
  it('is 32 raw bytes', () => {
    expect(ADDRESS_LEN).toBe(32);
    expect(addressBytes('0x1').length).toBe(32);
  });

  it('round-trips through addressFromBytes', () => {
    const a = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    expect(addressFromBytes(addressBytes(a))).toBe(a);
  });

  it('rejects a wrong-length byte array', () => {
    expect(() => addressFromBytes(new Uint8Array(31))).toThrow(/must be 32 bytes/);
  });
});

describe('compareAddress is memcmp on the raw bytes', () => {
  it('orders 0x…01 before 0xff…00 — NOT numerically by any suffix', () => {
    const lo = `0x${'0'.repeat(63)}1`;
    const hi = `0xff${'0'.repeat(62)}`;
    expect(compareAddress(lo, hi)).toBeLessThan(0);
  });

  function memcmp(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return 0;
  }

  it('has the same sign as memcmp on 4000 random pairs', () => {
    const rng = createRng('address-order');
    for (let i = 0; i < 4000; i++) {
      const x = addressFromBytes(rng.bytes(32));
      const y = addressFromBytes(rng.bytes(32));
      const mine = Math.sign(compareAddress(x, y));
      const ref = Math.sign(memcmp(addressBytes(x), addressBytes(y)));
      expect(mine).toBe(ref);
    }
  });

  it('sorts a list identically to a byte-wise sort', () => {
    const rng = createRng('address-sort');
    const list: string[] = [];
    for (let i = 0; i < 200; i++) list.push(addressFromBytes(rng.bytes(32)));
    const byString = [...list].sort(compareAddress);
    const byBytes = [...list].sort((a, b) => memcmp(addressBytes(a), addressBytes(b)));
    expect(byString).toEqual(byBytes);
  });
});
