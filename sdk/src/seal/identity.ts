// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.6
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#F1 (THE endianness trap — the deleted vault.move:698-703 decoded
//             BIG-ENDIAN and keeper/src/privacy/seal.ts still DOCUMENTS it as BIG-ENDIAN)
// @spec       docs/DESIGN-V2.md#3 (the 48-byte inner id, exactly)
// @rules      G7 G10
// @depends    ../bcs.ts · ../address.ts
// @facts      ★★ THE HIGHEST-RISK FILE IN THIS PACKAGE. ★★
// @facts      Inner id, 48 bytes:
// @facts        [ 0..8 )  bcs u64  close_ms        LITTLE-ENDIAN
// @facts        [ 8..16)  bcs u64  policy_version  LITTLE-ENDIAN
// @facts        [16..48)  bcs address batch id     32 RAW bytes
// @facts        leftovers MUST be empty — `prepared.into_remainder_bytes().length() == 0` is
// @facts        MANDATORY in check_policy, not optional.
// @facts      Full IBE identity = bytes(packageId) ‖ inner (80 bytes). `seal_approve` receives
// @facts        ONLY the inner 48.
// @facts      ⚠⚠ `bcs::peel_u64` reads LITTLE-ENDIAN. The old code did
// @facts          `epoch = (epoch << 8) + (byte as u64)` — that is BIG-ENDIAN. Copying it
// @facts          produces a policy that NEVER OPENS, and it fails SILENTLY: the key server
// @facts          simply declines and the batch never reveals. Structural twin of RECON R14's
// @facts          reversed-txid trap — wrong in one direction only, with no error on the bad path.
// @facts      ⚠ F2 — a time-lock seal_approve must NOT check the sender. Anyone may satisfy it
// @facts        after T. That is what makes reveal permissionless and kills grief-by-non-
// @facts        revelation. Nothing in this file encodes a sender, and nothing may.
// @facts      SUBMIT_CUTOFF_MS = 60_000 · REVEAL_GRACE_MS = 600_000 (skew tolerance, §3)
// @implements export const INNER_ID_LEN: number
// @implements export const CLOSE_MS_OFFSET: number
// @implements export const POLICY_VERSION_OFFSET: number
// @implements export const BATCH_ID_OFFSET: number
// @implements export const SUBMIT_CUTOFF_MS: bigint
// @implements export const REVEAL_GRACE_MS: bigint
// @implements export interface InnerId
// @implements export function encodeInnerId(closeMs: bigint, policyVersion: bigint, batchId: string): Uint8Array
// @implements export function decodeInnerId(bytes: Uint8Array): InnerId
// @implements export function encodeInnerIdBigEndianWRONG(closeMs: bigint, policyVersion: bigint, batchId: string): Uint8Array
// @implements export function fullIdentity(packageId: string, inner: Uint8Array): Uint8Array
// @implements export function checkPolicy(inner: Uint8Array, policyVersion: bigint, nowMs: bigint): boolean
// @forbidden  a BIG-ENDIAN inner id in any production path — `encodeInnerIdBigEndianWRONG` exists
//             ONLY so the golden test can prove the two differ. Never call it to build an identity.
// @forbidden  a sender / owner / keeper address anywhere in this encoding — F2
// @forbidden  accepting a 49th byte — leftovers must be empty
// @invariant  1. decodeInnerId(encodeInnerId(t, v, b)) === { t, v, b }, for every t, v, b.
// @invariant  2. encodeInnerId(...) !== encodeInnerIdBigEndianWRONG(...) for every close_ms
//                that is not byte-palindromic (i.e. for every realistic ms timestamp).
// @invariant  3. encodeInnerId always returns exactly 48 bytes.
// @invariant  4. decodeInnerId THROWS on 47 bytes and on 49 bytes — never silently truncates.
// @invariant  5. checkPolicy never reads a sender and never mutates anything.
// @ac         fixtures/seal.identity.golden.json — every vector carries BOTH the LE bytes and
//             the BE bytes of the same timestamp, so the difference is explicit and testable
// @verify     npx vitest run identity
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { addressBytes } from '../address.js';
import { BcsReader, concatBytes, encodeU64BE, encodeU64LE } from '../bcs.js';

/** The `seal_approve` argument is exactly 48 bytes. */
export const INNER_ID_LEN = 48;

export const CLOSE_MS_OFFSET = 0;
export const POLICY_VERSION_OFFSET = 8;
export const BATCH_ID_OFFSET = 16;

/** No submit lands within a minute of close, so a submit cannot race an early key release. */
export const SUBMIT_CUTOFF_MS = 60_000n;
/** 10 minutes of reveal window — two orders of magnitude more than observed key-server skew. */
export const REVEAL_GRACE_MS = 600_000n;

export interface InnerId {
  readonly closeMs: bigint;
  readonly policyVersion: bigint;
  readonly batchId: string;
}

/**
 * THE inner identity. **LITTLE-ENDIAN**, because `bcs::peel_u64` reads little-endian.
 *
 * Getting this backwards produces a policy that never opens and fails silently — see the
 * banner. One file owns this encoding; the Move decoder, the app encoder and the keeper
 * encoder all agree with it or the golden test fails.
 */
export function encodeInnerId(closeMs: bigint, policyVersion: bigint, batchId: string): Uint8Array {
  const out = concatBytes(encodeU64LE(closeMs), encodeU64LE(policyVersion), addressBytes(batchId));
  if (out.length !== INNER_ID_LEN) {
    throw new RangeError(`inner id must be ${INNER_ID_LEN} bytes, built ${out.length}`);
  }
  return out;
}

/** Round-trips {@link encodeInnerId}. Throws unless the input is EXACTLY 48 bytes. */
export function decodeInnerId(bytes: Uint8Array): InnerId {
  if (bytes.length !== INNER_ID_LEN) {
    throw new RangeError(
      `EBadIdentityLength: inner id must be ${INNER_ID_LEN} bytes, got ${bytes.length}`,
    );
  }
  const r = new BcsReader(bytes);
  const closeMs = r.u64();
  const policyVersion = r.u64();
  const batchId = r.address();
  r.finish('inner id'); // the MANDATORY leftovers check
  return { closeMs, policyVersion, batchId };
}

/**
 * ⚠ **DELIBERATELY WRONG.** The BIG-ENDIAN encoding the deleted `vault.move` used and that
 * `keeper/src/privacy/seal.ts` still documents. It exists for ONE purpose: so
 * `fixtures/seal.identity.golden.json` and `test/identity.test.ts` can prove, in bytes, that
 * it differs from {@link encodeInnerId} — and so the Move twin can assert that feeding it to
 * `seal_approve` ABORTS.
 *
 * Calling this to build a real identity yields a policy that never opens, silently.
 */
export function encodeInnerIdBigEndianWRONG(
  closeMs: bigint,
  policyVersion: bigint,
  batchId: string,
): Uint8Array {
  return concatBytes(encodeU64BE(closeMs), encodeU64BE(policyVersion), addressBytes(batchId));
}

/** `bytes(packageId) ‖ inner` — the full IBE identity. `seal_approve` sees only `inner`. */
export function fullIdentity(packageId: string, inner: Uint8Array): Uint8Array {
  if (inner.length !== INNER_ID_LEN) {
    throw new RangeError(`inner id must be ${INNER_ID_LEN} bytes, got ${inner.length}`);
  }
  return concatBytes(addressBytes(packageId), inner);
}

/**
 * The TS twin of `check_policy` (docs/DESIGN-V2.md §3). Pure; reads no sender (F2).
 *
 * Returns false — rather than throwing — for a malformed id, because that is what the Move
 * `check_policy` predicate does before `seal_approve` turns it into an abort.
 */
export function checkPolicy(inner: Uint8Array, policyVersion: bigint, nowMs: bigint): boolean {
  let decoded: InnerId;
  try {
    decoded = decodeInnerId(inner);
  } catch {
    return false; // includes the leftovers case
  }
  return decoded.policyVersion === policyVersion && nowMs >= decoded.closeMs;
}
