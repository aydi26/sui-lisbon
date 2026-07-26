// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8
// @phase      2
// @status     DONE
// @spec       docs/DESIGN-V2.md §3 (the seal_approve entry, byte layout), F1
// @spec       aphotic.md §7.5 (a committee without Enoki)
// @rules      G7 G8
// @depends    ../src/privacy/seal.ts · ../src/privacy/session.ts
// @facts      ★ THIS FILE EXISTS BECAUSE OF A BUG THAT WAS ALREADY IN THE REPO.
// @facts        The deleted v1 `vault.move` decoded the Seal identity epoch with
// @facts        `epoch = (epoch << 8) + byte` — BIG-endian — and keeper's seal.ts
// @facts        documented it to match. Both sides agreed, so both were wrong
// @facts        together and nothing ever complained.
// @facts        v2's policy parses with `bcs::peel_u64`, which reads LITTLE-endian.
// @facts        Emit big-endian and the key servers decline forever: the batch never
// @facts        reveals, and there is NO error anywhere to read. Same silent failure
// @facts        class as RECON R14's Bitcoin txid byte order.
// @facts      ⚠ A round-trip test would NOT have caught it — encode and decode with
// @facts        the same wrong convention and it passes. Only a HAND-BUILT byte
// @facts        vector, written from the Move side's reading, can catch this. That is
// @facts        why the expectations below are literal bytes and not computed.
// @implements the F1 regression guard
// @forbidden  asserting via the encoder's own output — that is what let the bug live
// @invariant  1. close_ms and policy_version are LITTLE-endian at offsets 0 and 8.
//             2. The batch id is LEFT-padded into [16..48), as Sui renders object ids.
//             3. The identity is exactly 48 bytes — Move rejects trailing bytes, so
//                the length is exact, not a minimum.
//             4. The big-endian encoding of the SAME input differs. If this ever
//                stops being true, the encoder has silently changed convention.
// @ac         a hand-built LE vector matches; its BE twin does not.
// @verify     cd keeper && npm test -- seal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  SEAL_IDENTITY_LEN,
  SEAL_ID_BATCH_LEN,
  SEAL_ID_CLOSE_MS_LEN,
  sealIdentity,
  sealIdentityBigEndianWRONG,
} from '../src/privacy/seal.js';
import { assertUsable, isExpired, redactSession, type SealSession } from '../src/privacy/session.js';

/** A real 06:00 UTC boundary: 2026-01-27T06:00:00.000Z. */
const CLOSE_MS = 1_769_493_600_000;
const BATCH = `0x${'00'.repeat(31)}ab`;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('seal identity — the little-endian trap', () => {
  it('is exactly 48 bytes', () => {
    expect(SEAL_IDENTITY_LEN).toBe(48);
    expect(sealIdentity({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 1 })).toHaveLength(48);
  });

  it('writes close_ms LITTLE-endian at offset 0', () => {
    const id = sealIdentity({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 1 });
    // 1_769_493_600_000 = 0x0000019BFE099700, derived by hand, then written low
    // byte first. Deliberately NOT computed from the encoder: an expectation built
    // by the thing under test agrees with itself in either convention, which is
    // exactly how the v1 big-endian bug survived having tests.
    expect(hex(id.subarray(0, SEAL_ID_CLOSE_MS_LEN))).toBe('009709fe9b010000');
  });

  it('writes policy_version LITTLE-endian at offset 8', () => {
    const id = sealIdentity({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 7 });
    expect(hex(id.subarray(8, 16))).toBe('0700000000000000');
  });

  it('LEFT-pads the batch id into [16..48)', () => {
    const id = sealIdentity({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 1 });
    expect(hex(id.subarray(16))).toBe(`${'00'.repeat(31)}ab`);
    expect(SEAL_ID_BATCH_LEN).toBe(32);
  });

  it('differs from the big-endian encoding of the SAME input', () => {
    const args = { batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 1 };
    const le = sealIdentity(args);
    const be = sealIdentityBigEndianWRONG(args);
    expect(hex(le)).not.toBe(hex(be));
    // And the difference is where it must be: the two u64s, not the id.
    expect(hex(le.subarray(16))).toBe(hex(be.subarray(16)));
  });

  it('decoding the big-endian bytes as little-endian yields an absurd timestamp', () => {
    // This is the failure mode made visible: the key servers do not error, they
    // simply never open, because the deadline lands far beyond any clock.
    const be = sealIdentityBigEndianWRONG({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: 1 });
    const asRead = new DataView(be.buffer, be.byteOffset).getBigUint64(0, true);
    expect(asRead).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('refuses inputs it cannot encode faithfully rather than guessing', () => {
    expect(() => sealIdentity({ batchId: '', closeMs: CLOSE_MS, policyVersion: 1 })).toThrow();
    expect(() => sealIdentity({ batchId: BATCH, closeMs: -1, policyVersion: 1 })).toThrow();
    expect(() => sealIdentity({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion: -1 })).toThrow();
    expect(() => sealIdentity({ batchId: 'not-hex', closeMs: CLOSE_MS, policyVersion: 1 })).toThrow();
  });
});

describe('seal session — the versioning tle.move does not have', () => {
  const session: SealSession = {
    policyVersion: 3,
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
    key: { secret: 'never-logged' },
  };
  const idAt = (policyVersion: number) => ({ batchId: BATCH, closeMs: CLOSE_MS, policyVersion });

  it('accepts a session minted under the current policy version', () => {
    expect(() => assertUsable(session, idAt(3), 2_000)).not.toThrow();
  });

  it('refuses a session minted under an older policy version', () => {
    // Enforcing this LOCALLY matters: relying on the key servers to decline would
    // make a stale session look like a network problem instead of a bumped policy.
    expect(() => assertUsable(session, idAt(4), 2_000)).toThrow(/policy version/i);
  });

  it('refuses an expired session, at the boundary', () => {
    expect(() => assertUsable(session, idAt(3), 61_000)).toThrow(/expired/i);
    expect(isExpired(session, 60_999)).toBe(false);
    expect(isExpired(session, 61_000)).toBe(true);
  });

  it('never returns key material from the redacted projection', () => {
    expect(JSON.stringify(redactSession(session))).not.toContain('never-logged');
  });
});
