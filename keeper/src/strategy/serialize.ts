// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §3.2 (padded serializer), §13 A4 (round-trip + constant length)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6)
// @rules      G7 G8 G10
// @depends    ./params.ts (T2.6) · ../util/errors.ts (AphoticError)
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
// @facts      ZIG-ZAG (16-bit): enc(n) = n >= 0 ? 2n : -2n - 1 ⇒ n ∈ [-32_768, 32_767] maps onto
// @facts        [0, 65_535]. bps values are bounded by ±10_000 so the field never saturates.
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

import { AphoticError } from '../util/errors.js';

import type { StrategyParams } from './params.js';

/** Fixed frame size. Changing this is a breaking format change — bump the version too. */
export const SERIALIZED_PARAMS_BYTES = 128 as const;

/** Format version, byte 0 of the frame. */
export const SERIALIZED_PARAMS_VERSION = 1 as const;

// ── Frame layout (see the @facts block; offsets are load-bearing) ─────────────

const OFF_VERSION = 0;
const OFF_SPREAD_BPS = 1;
const OFF_SKEW_BPS = 3;
const OFF_FLOW_SENSITIVITY_BPS = 5;
const OFF_BUFFER_TARGET_BPS = 7;
const OFF_MAX_NOTIONAL_SATS = 9;
const OFF_COOLDOWN_MS = 17;
const OFF_JITTER_BPS = 25;
const OFF_HYSTERESIS_BPS = 27;
const OFF_MAKER_TIMEOUT_MS = 29;
/** First byte of the zero tail. 128 − 37 = 91 padding bytes. */
const OFF_PADDING = 37;

const U16_MAX = 0xffff;
const ZIGZAG16_MIN = -32_768;
const ZIGZAG16_MAX = 32_767;
const U64_CEIL = 1n << 64n;

/** Thrown for a malformed frame or an out-of-range field. Stable `code` for tests. */
function frameError(message: string): AphoticError {
  return new AphoticError('EBadStrategyFrame', message);
}

function zigzag16(n: number): number {
  if (!Number.isInteger(n) || n < ZIGZAG16_MIN || n > ZIGZAG16_MAX) {
    throw frameError(`zig-zag field out of range [${ZIGZAG16_MIN}, ${ZIGZAG16_MAX}]: ${n}`);
  }
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag16(u: number): number {
  return u % 2 === 0 ? u / 2 : -((u + 1) / 2);
}

function assertU16(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
    throw frameError(`${field} must be an integer in [0, ${U16_MAX}] — got ${String(value)}`);
  }
  return value;
}

function assertU64(field: string, value: bigint): bigint {
  if (typeof value !== 'bigint') {
    throw frameError(`${field} must be a bigint (sats/ms are never \`number\`) — got ${typeof value}`);
  }
  if (value < 0n || value >= U64_CEIL) {
    throw frameError(`${field} must fit an unsigned 64-bit integer — got ${value}`);
  }
  return value;
}

function assertMillisU64(field: string, value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw frameError(`${field} must be a non-negative safe integer number of ms — got ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * Encode parameters into the constant-length frame described in the @facts layout.
 * Big-endian; `skewBps` is zig-zag encoded because it may be negative.
 *
 * PURE: the same parameters produce byte-identical output on every machine, forever
 * (invariant 3) — that is what lets `verify/` prove one plaintext produced one blob.
 */
export function serialize(params: StrategyParams): Uint8Array {
  const buf = new ArrayBuffer(SERIALIZED_PARAMS_BYTES);
  const view = new DataView(buf);

  view.setUint8(OFF_VERSION, SERIALIZED_PARAMS_VERSION);
  view.setUint16(OFF_SPREAD_BPS, assertU16('spreadBps', params.spreadBps), false);
  view.setUint16(OFF_SKEW_BPS, zigzag16(params.skewBps), false);
  view.setUint16(OFF_FLOW_SENSITIVITY_BPS, assertU16('flowSensitivityBps', params.flowSensitivityBps), false);
  view.setUint16(OFF_BUFFER_TARGET_BPS, assertU16('bufferTargetBps', params.bufferTargetBps), false);
  view.setBigUint64(
    OFF_MAX_NOTIONAL_SATS,
    assertU64('maxNotionalPerEpochSats', params.maxNotionalPerEpochSats),
    false,
  );
  view.setBigUint64(OFF_COOLDOWN_MS, assertMillisU64('cooldownMs', params.cooldownMs), false);
  view.setUint16(OFF_JITTER_BPS, assertU16('jitterBps', params.jitterBps), false);
  view.setUint16(OFF_HYSTERESIS_BPS, assertU16('hysteresisBps', params.hysteresisBps), false);
  view.setBigUint64(OFF_MAKER_TIMEOUT_MS, assertMillisU64('makerTimeoutMs', params.makerTimeoutMs), false);

  // Bytes [OFF_PADDING, SERIALIZED_PARAMS_BYTES) stay ZERO — `new ArrayBuffer` is zero-filled
  // and we never touch them. Random padding here would destroy ciphertext reproducibility (G5).
  return new Uint8Array(buf);
}

/** Inverse of {@link serialize}. Rejects a wrong length or an unknown version (invariant 4). */
export function deserialize(bytes: Uint8Array): StrategyParams {
  if (!(bytes instanceof Uint8Array)) {
    throw frameError('strategy frame must be a Uint8Array');
  }
  if (bytes.length !== SERIALIZED_PARAMS_BYTES) {
    throw frameError(
      `strategy frame must be exactly ${SERIALIZED_PARAMS_BYTES} bytes — got ${bytes.length}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(OFF_VERSION);
  if (version !== SERIALIZED_PARAMS_VERSION) {
    throw frameError(
      `unknown strategy frame version ${version} (this build reads ${SERIALIZED_PARAMS_VERSION})`,
    );
  }

  const cooldownMs = view.getBigUint64(OFF_COOLDOWN_MS, false);
  const makerTimeoutMs = view.getBigUint64(OFF_MAKER_TIMEOUT_MS, false);
  if (cooldownMs > BigInt(Number.MAX_SAFE_INTEGER) || makerTimeoutMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw frameError('cooldownMs/makerTimeoutMs exceed the safe-integer millisecond range');
  }

  return {
    spreadBps: view.getUint16(OFF_SPREAD_BPS, false),
    skewBps: unzigzag16(view.getUint16(OFF_SKEW_BPS, false)),
    flowSensitivityBps: view.getUint16(OFF_FLOW_SENSITIVITY_BPS, false),
    bufferTargetBps: view.getUint16(OFF_BUFFER_TARGET_BPS, false),
    maxNotionalPerEpochSats: view.getBigUint64(OFF_MAX_NOTIONAL_SATS, false),
    cooldownMs: Number(cooldownMs),
    jitterBps: view.getUint16(OFF_JITTER_BPS, false),
    hysteresisBps: view.getUint16(OFF_HYSTERESIS_BPS, false),
    makerTimeoutMs: Number(makerTimeoutMs),
  };
}

/** Byte offset of the zero tail — exported so a test can assert the padding really is zero. */
export const SERIALIZED_PARAMS_PADDING_OFFSET = OFF_PADDING;
