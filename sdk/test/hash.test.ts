// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (blake2b256 + 0x00/0x01 domain tags)
// @rules      G10
// @depends    ../src/hash.ts · node:crypto (TEST ONLY)
// @facts      Two independent proofs, because a wrong hash is silent:
// @facts        1. KATs for blake2b256("") and blake2b256("abc") — pins the digest-length path.
// @facts        2. 512 fuzzed inputs compared against OpenSSL blake2b512 — pins the entire
// @facts           compression function, the 128-byte block boundary and the final-block flag.
// @implements describe('blake2b')
// @verify     npx vitest run hash
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  blake2b,
  blake2b256,
  bytesEqual,
  DOMAIN_LEAF,
  DOMAIN_NODE,
  fromHex,
  hashLeafBytes,
  hashNodeBytes,
  toHex,
  ZERO32,
} from '../src/hash.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('blake2b256 known-answer tests', () => {
  it('matches the published vector for the empty string', () => {
    expect(toHex(blake2b256(new Uint8Array(0)))).toBe(
      '0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
    );
  });

  it('matches the published vector for "abc"', () => {
    expect(toHex(blake2b256(utf8('abc')))).toBe(
      '0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });

  it('always returns 32 bytes', () => {
    for (const n of [0, 1, 63, 64, 127, 128, 129, 1000]) {
      expect(blake2b256(new Uint8Array(n)).length).toBe(32);
    }
  });
});

describe('blake2b parity with OpenSSL blake2b512', () => {
  it('agrees on 512 fuzzed inputs spanning the block boundary', () => {
    let checked = 0;
    for (let i = 0; i < 512; i++) {
      // Lengths deliberately walk across 128 and 256 — the multi-block path.
      const n = i < 300 ? i : (i * 7) % 1024;
      const input = randomBytes(n);
      const mine = toHex(blake2b(input, 64)).slice(2);
      const ref = createHash('blake2b512').update(input).digest('hex');
      expect(mine).toBe(ref);
      checked++;
    }
    expect(checked).toBe(512);
  });

  it('agrees on the exact 128-byte block boundary and one byte either side', () => {
    for (const n of [127, 128, 129, 255, 256, 257]) {
      const input = new Uint8Array(n).fill(0xab);
      expect(toHex(blake2b(input, 64)).slice(2)).toBe(
        createHash('blake2b512').update(input).digest('hex'),
      );
    }
  });
});

describe('domain separation', () => {
  it('uses 0x00 for leaves and 0x01 for nodes', () => {
    expect(DOMAIN_LEAF).toBe(0x00);
    expect(DOMAIN_NODE).toBe(0x01);
  });

  it('hashLeafBytes(x) is blake2b256(0x00 || x)', () => {
    const payload = utf8('payload');
    const manual = new Uint8Array(1 + payload.length);
    manual[0] = 0x00;
    manual.set(payload, 1);
    expect(toHex(hashLeafBytes(payload))).toBe(toHex(blake2b256(manual)));
  });

  it('hashNodeBytes(l, r) is blake2b256(0x01 || l || r)', () => {
    const l = blake2b256(utf8('l'));
    const r = blake2b256(utf8('r'));
    const manual = new Uint8Array(65);
    manual[0] = 0x01;
    manual.set(l, 1);
    manual.set(r, 33);
    expect(toHex(hashNodeBytes(l, r))).toBe(toHex(blake2b256(manual)));
  });

  it('a 64-byte leaf preimage never collides with the node hash of its two halves', () => {
    // Without the tags these two would hash the SAME 64 bytes. This is the second-preimage
    // attack across levels that docs/DESIGN-V2.md §11 introduces the tags to prevent.
    const l = blake2b256(utf8('left'));
    const r = blake2b256(utf8('right'));
    const joined = new Uint8Array(64);
    joined.set(l, 0);
    joined.set(r, 32);
    expect(toHex(hashLeafBytes(joined))).not.toBe(toHex(hashNodeBytes(l, r)));
  });

  it('rejects a node hash of anything but two 32-byte digests', () => {
    expect(() => hashNodeBytes(new Uint8Array(31), new Uint8Array(32))).toThrow(/32-byte/);
    expect(() => hashNodeBytes(new Uint8Array(32), new Uint8Array(33))).toThrow(/32-byte/);
  });
});

describe('hex helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const b = randomBytes(37);
    expect(bytesEqual(fromHex(toHex(b)), b)).toBe(true);
  });

  it('accepts bare hex and rejects malformed hex', () => {
    expect(toHex(fromHex('0a0b'))).toBe('0x0a0b');
    expect(() => fromHex('0x0')).toThrow(/odd length/);
    expect(() => fromHex('0x1z')).toThrow(/not hex/);
    // parseInt('1z', 16) silently returns 1 — the regex guard is why this throws.
    expect(() => fromHex('1z')).toThrow(/not hex/);
  });

  it('ZERO32 is 32 zero bytes and is never mutated by a hash', () => {
    expect(ZERO32.length).toBe(32);
    hashLeafBytes(ZERO32);
    expect(toHex(ZERO32)).toBe(`0x${'00'.repeat(32)}`);
  });
});

describe('purity', () => {
  it('returns a fresh array every call — no shared scratch escapes', () => {
    const a = blake2b256(utf8('x'));
    const b = blake2b256(utf8('y'));
    a[0] = 0xff;
    expect(toHex(blake2b256(utf8('y')))).toBe(toHex(b));
  });

  it('is deterministic across 100 repetitions', () => {
    const input = utf8('aphotic');
    const first = toHex(blake2b256(input));
    for (let i = 0; i < 100; i++) expect(toHex(blake2b256(input))).toBe(first);
  });
});
