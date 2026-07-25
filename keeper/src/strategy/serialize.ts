// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §3.2 (padded serializer), §13 A4 (round-trip + constant length)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6)
// @rules      G7 G8 G10
// @depends    ./params.ts (T2.6) · ../util/bytes.ts (hex helpers)
// @facts      PURPOSE: ciphertext LENGTH must never leak which strategy family is deployed.
// @facts        ⇒ fixed-length encoding BEFORE Seal encryption. Deterministic, big-endian, u64 sats.
// @facts      SERIALIZED_PARAMS_BYTES = 128 — a fixed frame with room for future fields, so adding
// @facts        a parameter later does NOT change the on-wire length (and therefore leaks nothing
// @facts        about vault vintage). Any change to this constant is a BREAKING format change:
// @facts        bump SERIALIZED_PARAMS_VERSION with it.
// @facts      Layout (offset:len, big-endian, all unsigned):
// @facts        0:1  version (SERIALIZED_PARAMS_VERSION)
// @facts        1:2  spreadBps          3:2  skewBps (zig-zag encoded — skew may be negative)
// @facts        5:2  flowSensitivityBps 7:2  bufferTargetBps
// @facts        9:8  maxNotionalPerEpochSats (u64)
// @facts        17:8 cooldownMs (u64)   25:2 jitterBps   27:2 hysteresisBps
// @facts        29:8 makerTimeoutMs (u64)
// @facts        37:91 ZERO PADDING to SERIALIZED_PARAMS_BYTES — deterministic, never random.
// @facts      ⚠ Padding is ZERO, not random: the ciphertext must be a deterministic function of the
// @facts        parameters so `verify/` can prove the same plaintext produced the same blob.
// @implements export const SERIALIZED_PARAMS_BYTES: 128
// @implements export const SERIALIZED_PARAMS_VERSION: 1
// @implements export function serialize(params: StrategyParams): Uint8Array
// @implements export function deserialize(bytes: Uint8Array): StrategyParams
// @forbidden  JSON — variable length leaks the field set (that is the whole point of this module)
// @forbidden  random padding — it breaks reproducibility of the ciphertext (G5)
// @forbidden  `number` for sats — the u64 fields are bigint on both sides of the round trip
// @invariant  1. serialize(p).length === SERIALIZED_PARAMS_BYTES for EVERY valid p.
// @invariant  2. deserialize(serialize(p)) deep-equals p (round trip, A4).
// @invariant  3. serialize is a pure function — same p ⇒ byte-identical output, forever.
// @invariant  4. deserialize rejects a wrong length or an unknown version rather than guessing.
// @ac         docs/KEEPER.md §13 A4 — round-trips and is constant-length across strategy families
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { StrategyParams } from './params.js';

/** Fixed frame size. Changing this is a breaking format change — bump the version too. */
export const SERIALIZED_PARAMS_BYTES = 128 as const;

/** Format version, byte 0 of the frame. */
export const SERIALIZED_PARAMS_VERSION = 1 as const;

/**
 * Encode parameters into the constant-length frame described in the @facts layout.
 * Big-endian; `skewBps` is zig-zag encoded because it may be negative.
 */
// TODO(T2.6): write the fixed layout into a 128-byte buffer, zero-padded to the tail.
export function serialize(_params: StrategyParams): Uint8Array {
  throw new Error('TODO(T2.6): serialize not implemented');
}

/** Inverse of {@link serialize}. Rejects a wrong length or an unknown version. */
// TODO(T2.6): assert bytes.length === SERIALIZED_PARAMS_BYTES && bytes[0] === SERIALIZED_PARAMS_VERSION,
//             then decode the layout (zig-zag decode skewBps).
export function deserialize(_bytes: Uint8Array): StrategyParams {
  throw new Error('TODO(T2.6): deserialize not implemented');
}
