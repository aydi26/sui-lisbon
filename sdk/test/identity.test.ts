// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.6
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#F1 (the endianness trap) · #3 (the 48-byte inner id) · F2 (no
//             sender check)
// @rules      G7 G10
// @depends    ../src/seal/identity.ts · ../fixtures/seal.identity.golden.json
// @facts      ★ The failure this file exists to catch is SILENT: a big-endian identity produces
// @facts        a policy the key servers simply decline, so the batch never reveals and nothing
// @facts        logs an error. Only a byte-level assertion catches it.
// @implements describe('inner id golden vectors') · describe('LE vs BE') · describe('checkPolicy')
// @verify     npx vitest run identity
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeU64LE } from '../src/bcs.js';
import { fromHex, toHex } from '../src/hash.js';
import { U64_MAX } from '../src/math.js';
import {
  BATCH_ID_OFFSET,
  checkPolicy,
  CLOSE_MS_OFFSET,
  decodeInnerId,
  encodeInnerId,
  encodeInnerIdBigEndianWRONG,
  fullIdentity,
  INNER_ID_LEN,
  POLICY_VERSION_OFFSET,
  REVEAL_GRACE_MS,
  SUBMIT_CUTOFF_MS,
} from '../src/seal/identity.js';
import { normalizeAddress } from '../src/address.js';

interface Vector {
  name: string;
  why: string;
  closeMs: string;
  policyVersion: string;
  batchId: string;
  le: string;
  beWRONG: string;
  differs: boolean;
  fullIdentity: string;
}
interface Golden {
  innerIdLen: number;
  packageId: string;
  vectors: Vector[];
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/seal.identity.golden.json', import.meta.url)),
    'utf8',
  ),
) as Golden;

describe('layout constants', () => {
  it('pins the 48-byte layout', () => {
    expect(INNER_ID_LEN).toBe(48);
    expect(CLOSE_MS_OFFSET).toBe(0);
    expect(POLICY_VERSION_OFFSET).toBe(8);
    expect(BATCH_ID_OFFSET).toBe(16);
    expect(golden.innerIdLen).toBe(INNER_ID_LEN);
  });

  it('pins the skew tolerances of docs/DESIGN-V2.md §3', () => {
    expect(SUBMIT_CUTOFF_MS).toBe(60_000n);
    expect(REVEAL_GRACE_MS).toBe(600_000n);
  });
});

describe('golden vectors', () => {
  it('has at least six vectors and every one is 48 bytes', () => {
    expect(golden.vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of golden.vectors) {
      expect(fromHex(v.le).length).toBe(48);
      expect(fromHex(v.beWRONG).length).toBe(48);
    }
  });

  it('reproduces every LE vector exactly', () => {
    for (const v of golden.vectors) {
      const built = encodeInnerId(BigInt(v.closeMs), BigInt(v.policyVersion), v.batchId);
      expect(toHex(built)).toBe(v.le);
    }
  });

  it('reproduces every BE vector exactly', () => {
    for (const v of golden.vectors) {
      const built = encodeInnerIdBigEndianWRONG(
        BigInt(v.closeMs),
        BigInt(v.policyVersion),
        v.batchId,
      );
      expect(toHex(built)).toBe(v.beWRONG);
    }
  });

  it('round-trips every vector through decodeInnerId', () => {
    for (const v of golden.vectors) {
      const d = decodeInnerId(fromHex(v.le));
      expect(d.closeMs).toBe(BigInt(v.closeMs));
      expect(d.policyVersion).toBe(BigInt(v.policyVersion));
      expect(d.batchId).toBe(normalizeAddress(v.batchId));
    }
  });

  it('reproduces every full IBE identity (packageId || inner, 80 bytes)', () => {
    for (const v of golden.vectors) {
      const full = fullIdentity(golden.packageId, fromHex(v.le));
      expect(full.length).toBe(80);
      expect(toHex(full)).toBe(v.fullIdentity);
    }
  });
});

describe('LITTLE-ENDIAN vs the BIG-ENDIAN trap (F1)', () => {
  it('the two encodings differ for every non-palindromic vector', () => {
    let differing = 0;
    for (const v of golden.vectors) {
      if (v.differs) {
        expect(v.le).not.toBe(v.beWRONG);
        differing++;
      } else {
        // Documented: all-zero and all-ones are byte-palindromic per field.
        expect(v.le).toBe(v.beWRONG);
      }
    }
    expect(differing).toBeGreaterThanOrEqual(4);
  });

  it('le[0..8] reversed IS beWRONG[0..8], for every vector', () => {
    for (const v of golden.vectors) {
      const le = fromHex(v.le);
      const be = fromHex(v.beWRONG);
      expect([...le.subarray(0, 8)].reverse()).toEqual([...be.subarray(0, 8)]);
      expect([...le.subarray(8, 16)].reverse()).toEqual([...be.subarray(8, 16)]);
      // The address half is RAW bytes and must be byte-identical in both.
      expect([...le.subarray(16, 48)]).toEqual([...be.subarray(16, 48)]);
    }
  });

  it('the LE encoding is what bcs::peel_u64 reads — byte 0 carries the LOW byte', () => {
    const id = encodeInnerId(0x0102030405060708n, 0n, '0x0');
    expect(id[0]).toBe(0x08);
    expect(id[7]).toBe(0x01);
    expect(toHex(id.subarray(0, 8))).toBe(toHex(encodeU64LE(0x0102030405060708n)));
  });

  it('a BE identity for a PAST close does NOT satisfy the policy that its LE twin satisfies', () => {
    // This is the whole failure mode, in one assertion.
    const closeMs = 1_785_088_800_000n;
    const now = closeMs + 1_000n;
    const le = encodeInnerId(closeMs, 3n, '0x2a');
    const be = encodeInnerIdBigEndianWRONG(closeMs, 3n, '0x2a');
    expect(checkPolicy(le, 3n, now)).toBe(true);
    expect(checkPolicy(be, 3n, now)).toBe(false);
  });

  it('decoding a BE identity yields a nonsense close_ms far in the future', () => {
    const closeMs = 1_785_088_800_000n;
    const decoded = decodeInnerId(encodeInnerIdBigEndianWRONG(closeMs, 0n, '0x0'));
    expect(decoded.closeMs).not.toBe(closeMs);
    // The BE bytes 00 00 01 9f 9f 95 75 00 read little-endian are 33_097_085_075_128_320 ms —
    // about 1.05 million years from now. The time-lock would never open, and nothing logs it.
    expect(decoded.closeMs).toBe(33_097_085_075_128_320n);
    expect(decoded.closeMs).toBeGreaterThan(10n ** 15n);
  });
});

describe('decodeInnerId rejects malformed ids', () => {
  it('throws on 47 bytes', () => {
    expect(() => decodeInnerId(new Uint8Array(47))).toThrow(/EBadIdentityLength/);
  });

  it('throws on 49 bytes — leftovers MUST be empty', () => {
    expect(() => decodeInnerId(new Uint8Array(49))).toThrow(/EBadIdentityLength/);
  });

  it('throws on an empty buffer', () => {
    expect(() => decodeInnerId(new Uint8Array(0))).toThrow(/EBadIdentityLength/);
  });

  it('checkPolicy returns false (never throws) for a malformed id', () => {
    expect(checkPolicy(new Uint8Array(49), 0n, 0n)).toBe(false);
    expect(checkPolicy(new Uint8Array(0), 0n, 0n)).toBe(false);
  });
});

describe('checkPolicy (F2 — no sender check)', () => {
  const closeMs = 1_000_000n;
  const id = encodeInnerId(closeMs, 7n, '0x2a');

  it('denies before close and allows at exactly close', () => {
    expect(checkPolicy(id, 7n, closeMs - 1n)).toBe(false);
    expect(checkPolicy(id, 7n, closeMs)).toBe(true);
    expect(checkPolicy(id, 7n, closeMs + 1n)).toBe(true);
  });

  it('denies a wrong policy version — the versioning tle.move omits', () => {
    expect(checkPolicy(id, 6n, closeMs + 1n)).toBe(false);
    expect(checkPolicy(id, 8n, closeMs + 1n)).toBe(false);
  });

  it('takes no sender argument at all — anyone may satisfy it after T', () => {
    // A time-lock that checked the sender would reintroduce grief-by-non-revelation.
    expect(checkPolicy.length).toBe(3);
  });

  it('is pure — 100 calls do not change the answer or the id', () => {
    const before = toHex(id);
    for (let i = 0; i < 100; i++) expect(checkPolicy(id, 7n, closeMs)).toBe(true);
    expect(toHex(id)).toBe(before);
  });
});

describe('encodeInnerId input validation', () => {
  it('accepts the u64 boundary and rejects one past it', () => {
    expect(encodeInnerId(U64_MAX, U64_MAX, '0x0').length).toBe(48);
    expect(() => encodeInnerId(U64_MAX + 1n, 0n, '0x0')).toThrow(/u64/);
    expect(() => encodeInnerId(0n, U64_MAX + 1n, '0x0')).toThrow(/u64/);
  });

  it('normalises a short batch id to 32 bytes', () => {
    expect(decodeInnerId(encodeInnerId(0n, 0n, '0x2a')).batchId).toBe(normalizeAddress('0x2a'));
  });

  it('fullIdentity rejects an inner id of the wrong length', () => {
    expect(() => fullIdentity('0x1', new Uint8Array(47))).toThrow(/48 bytes/);
  });
});
