// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §3.1 (the encrypted parameter set), §3.3 (Seal identity + rotation)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · CUT LINE item 2 (encrypted strategy)
// @spec       "README (8).md" (base Aphotic: the strategy is the secret, the envelope is public)
// @rules      G4 G5 G7 G8 G9 G10
// @depends    ../config.ts · ../types.ts (Bps/Sats/Millis) · ./serialize.ts (T2.6)
// @facts      These parameters are the ONLY secret in the system. They live Seal-encrypted in
// @facts        Walrus; the vault holds the ciphertext + blob id. Never on-chain in plaintext.
// @facts      Parameter set (docs/KEEPER.md §3.1): spread · skew · flowSensitivity · bufferTarget ·
// @facts        maxNotionalPerEpoch · cooldownMs · jitterBounds · hysteresisBands · makerTimeoutMs.
// @facts      Sats fields are bigint (u64 on-chain). Rate/ratio fields are BASIS POINTS (u16-ish
// @facts        `number`) — bps are counts, not money, so `number` is correct there and ONLY there.
// @facts      Venue is fixed by G4: DeepBook Pool<hBTC,DBUSDC> maker POST_ONLY + IOC on the SAME
// @facts        book. There is NO venue parameter to tune — no Cetus pool exists.
// @facts      DEFAULTS ARE NOT SECRETS. `defaultParams()` exists so the mock/e2e path runs with no
// @facts        Seal round trip; a real vault always ships operator-chosen values.
// @facts      Tick/lot alignment is a VENUE constant, not a parameter: tick 1_000_000 · lot 1_000 ·
// @facts        min_size 100_000 (cfg.deepbook.*) — quoting must round INTO the spread, never through it.
// @facts      BPS_DENOMINATOR = 10_000 (a unit, not an id — safe outside config.ts).
// @facts      ★ EXECUTION PARAMETERS (T2.7 addition — laddered quoting + deterministic slicing):
// @facts        ladderLevels · ladderStepBps · ladderDecayBps · sliceCount. They are STRATEGY, so
// @facts        they are SECRET and ride in the SAME Seal frame as the rest — they are written into
// @facts        the zero tail of the 128-byte frame (`serialize.ts` pads bytes 37..127), so the
// @facts        sealed payload LENGTH is unchanged (A4: no size oracle) and an old frame still
// @facts        deserializes exactly as before. `embedExecutionParams` / `extractExecutionParams`
// @facts        own that tail; `serialize()`/`deserialize()` are untouched.
// @facts        EXECUTION_PARAMS_EXT_OFFSET = SERIALIZED_PARAMS_PADDING_OFFSET (37), length 16:
// @facts          0:1 version(=1) · 1:2 ladderLevels · 3:2 ladderStepBps · 5:2 ladderDecayBps ·
// @facts          7:2 sliceCount · 9:7 zero padding.
// @facts        An ALL-ZERO tail means "no extension present" ⇒ extract returns undefined and the
// @facts        caller falls back to defaultExecutionParams() — never a silent wrong ladder.
// @facts      Bounds: 1 <= ladderLevels <= MAX_LADDER_LEVELS (8, routing/route.ts — the venue-shaped
// @facts        cap on orders per side per tick); (levels−1)·stepBps < 10_000 so the deepest BID rung
// @facts        stays a positive price; levels > 1 requires stepBps >= 1 (rungs must be distinct);
// @facts        0 <= decayBps <= 10_000; 1 <= sliceCount <= MAX_SLICE_COUNT (64).
// @implements export const BPS_DENOMINATOR: 10_000
// @implements export interface StrategyParams / ExecutionParams
// @implements export const STRATEGY_PARAM_KEYS: readonly (keyof StrategyParams)[]
// @implements export const EXECUTION_PARAM_KEYS: readonly (keyof ExecutionParams)[]
// @implements export const EXECUTION_PARAMS_EXT_BYTES: 16 · EXECUTION_PARAMS_EXT_OFFSET · MAX_SLICE_COUNT: 64
// @implements export function defaultParams(cfg: Config): StrategyParams
// @implements export function validateParams(params: StrategyParams, cfg: Config): StrategyParams
// @implements export function paramsFingerprint(params: StrategyParams): string
// @implements export function defaultExecutionParams(): ExecutionParams
// @implements export function validateExecutionParams(x: ExecutionParams): ExecutionParams
// @implements export function encodeExecutionExtension(x: ExecutionParams): Uint8Array
// @implements export function decodeExecutionExtension(bytes: Uint8Array): ExecutionParams | undefined
// @implements export function embedExecutionParams(frame: Uint8Array, x: ExecutionParams): Uint8Array
// @implements export function extractExecutionParams(frame: Uint8Array): ExecutionParams | undefined
// @implements export function executionParamsFingerprint(x: ExecutionParams): string
// @forbidden  logging, journaling, or serializing these values in plaintext anywhere (G8)
// @forbidden  `number` for any satoshi amount — bps/ms only
// @forbidden  a venue/DEX parameter — the venue is fixed by G4
// @invariant  1. Every field is present and finite; `validateParams` rejects partial objects.
// @invariant  2. Bounds: 0 < spreadBps <= 10_000; |skewBps| <= spreadBps; jitterBps <= spreadBps/2.
// @invariant  3. `paramsFingerprint` is a HASH — it must never be invertible back to the values.
// @invariant  4. The struct is FLAT and fixed-arity so serialize.ts can pad it to a constant length.
// @invariant  5. `embedExecutionParams` NEVER changes the frame length (128) and never touches a
//                byte below EXECUTION_PARAMS_EXT_OFFSET — `deserialize()` of an embedded frame
//                returns exactly the same StrategyParams as before the embed.
// @invariant  6. `extractExecutionParams(serialize(p))` is `undefined` — a plain frame carries no
//                extension, and absence is reported, never guessed.
// @ac         docs/KEEPER.md §13 A4 — constant-length serialization across strategy families
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type { Config } from '../config.js';
import { MAX_LADDER_LEVELS } from '../routing/route.js';
import type { Bps, Millis, Sats } from '../types.js';
import { ConfigError } from '../util/errors.js';

import { serialize, SERIALIZED_PARAMS_BYTES, SERIALIZED_PARAMS_PADDING_OFFSET } from './serialize.js';

/** 100 % in basis points. A UNIT, not a tunable — never a strategy parameter. */
export const BPS_DENOMINATOR = 10_000 as const;

/**
 * The Seal-encrypted strategy parameters. FLAT and fixed-arity by construction — `serialize.ts`
 * pads this to a constant byte length so ciphertext size never leaks the strategy family.
 */
export interface StrategyParams {
  /** Half-spread around the DeepBook mid, in bps. */
  readonly spreadBps: Bps;
  /** Static inventory skew, bps. Positive skews the quote toward selling hBTC. */
  readonly skewBps: Bps;
  /** How hard telegraphed peg-flow (pendingMint − pendingBurn) moves the quote, bps per BTC. */
  readonly flowSensitivityBps: Bps;
  /** Idle-hBTC floor as bps of NAV — the redemption buffer target (G3 risk input, not scarcity). */
  readonly bufferTargetBps: Bps;
  /** Hard cap on notional deployed per epoch, sats. Mirrors the on-chain envelope bound. */
  readonly maxNotionalPerEpochSats: Sats;
  /** Minimum gap between requotes, ms. */
  readonly cooldownMs: Millis;
  /** Bounded jitter, bps — drawn from the SEEDED PRNG whose seed is journaled (G5). */
  readonly jitterBps: Bps;
  /** Dead-band that suppresses requotes below this move, bps. */
  readonly hysteresisBps: Bps;
  /** Cancel-and-IOC-reroute window for unfilled makers, ms. */
  readonly makerTimeoutMs: Millis;
}

/** Canonical field order. `serialize.ts` and the padded encoding depend on it. */
export const STRATEGY_PARAM_KEYS = [
  'spreadBps',
  'skewBps',
  'flowSensitivityBps',
  'bufferTargetBps',
  'maxNotionalPerEpochSats',
  'cooldownMs',
  'jitterBps',
  'hysteresisBps',
  'makerTimeoutMs',
] as const satisfies readonly (keyof StrategyParams)[];

/** Which fields are sats (bigint) rather than bps/ms (number). G10: money is NEVER `number`. */
const SATS_KEYS: ReadonlySet<string> = new Set<keyof StrategyParams>(['maxNotionalPerEpochSats']);

/**
 * Non-secret defaults so the MOCK/e2e path runs with no Seal round trip (G7).
 * A real vault always ships operator-chosen values.
 *
 * Venue-safe by construction: `maxNotionalPerEpochSats` is far above `cfg.deepbook.minSize`
 * (100_000 sats) so a default-configured vault can actually place a legal order, and the
 * jitter band is half the half-spread so a jittered quote can never cross the mid.
 */
export function defaultParams(cfg: Config): StrategyParams {
  const params: StrategyParams = {
    spreadBps: 30,
    skewBps: 0,
    flowSensitivityBps: 50,
    bufferTargetBps: 1_000,
    // 0.5 BTC per epoch — conservative, and ~5_000x the venue minimum order size.
    maxNotionalPerEpochSats: 50_000_000n,
    // A third of the maker timeout: requote often enough to stay at top of book, not so often
    // that the cooldown never binds.
    cooldownMs: Math.max(1_000, Math.floor(cfg.loop.makerTimeoutMs / 3)),
    jitterBps: 5,
    hysteresisBps: 10,
    // Derived from config (G7) — the loop cancels-and-rerouted unfilled makers on this window.
    makerTimeoutMs: cfg.loop.makerTimeoutMs,
  };
  return validateParams(params, cfg);
}

/** Enforce invariant 2 and reject partial/NaN input. Returns the same object when valid. */
export function validateParams(params: StrategyParams, cfg: Config): StrategyParams {
  const bad: string[] = [];
  const why: string[] = [];

  const fail = (key: string, reason: string): void => {
    bad.push(key);
    why.push(`  - ${key}: ${reason}`);
  };

  // Runtime guard: `validateParams` is a trust boundary (decrypted bytes, operator JSON),
  // so it must not assume the static type actually holds.
  const raw: unknown = params;
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('strategy parameters must be an object', [...STRATEGY_PARAM_KEYS]);
  }

  // Invariant 1 — presence + type, every key, before any bound check.
  for (const key of STRATEGY_PARAM_KEYS) {
    const value: unknown = params[key];
    if (value === undefined || value === null) {
      fail(key, 'missing');
      continue;
    }
    if (SATS_KEYS.has(key)) {
      if (typeof value !== 'bigint') fail(key, `sats must be bigint, got ${typeof value}`);
      else if (value < 0n) fail(key, `sats must be >= 0, got ${value}`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      fail(key, `must be a finite integer, got ${String(value)}`);
    }
  }

  if (bad.length > 0) {
    throw new ConfigError(`invalid strategy parameters:\n${why.join('\n')}`, bad);
  }

  // Invariant 2 — the bounds that keep a quote legal on the venue.
  if (params.spreadBps <= 0 || params.spreadBps > BPS_DENOMINATOR) {
    fail('spreadBps', `must satisfy 0 < spreadBps <= ${BPS_DENOMINATOR}, got ${params.spreadBps}`);
  }
  if (Math.abs(params.skewBps) > params.spreadBps) {
    fail('skewBps', `|skewBps| must be <= spreadBps (${params.spreadBps}), got ${params.skewBps}`);
  }
  if (params.jitterBps < 0 || params.jitterBps > Math.floor(params.spreadBps / 2)) {
    fail(
      'jitterBps',
      `must satisfy 0 <= jitterBps <= spreadBps/2 (${Math.floor(params.spreadBps / 2)}), got ${params.jitterBps}`,
    );
  }
  if (params.flowSensitivityBps < 0 || params.flowSensitivityBps > BPS_DENOMINATOR) {
    fail('flowSensitivityBps', `must be in [0, ${BPS_DENOMINATOR}], got ${params.flowSensitivityBps}`);
  }
  if (params.bufferTargetBps < 0 || params.bufferTargetBps > BPS_DENOMINATOR) {
    fail('bufferTargetBps', `must be in [0, ${BPS_DENOMINATOR}], got ${params.bufferTargetBps}`);
  }
  if (params.hysteresisBps < 0 || params.hysteresisBps > BPS_DENOMINATOR) {
    fail('hysteresisBps', `must be in [0, ${BPS_DENOMINATOR}], got ${params.hysteresisBps}`);
  }
  if (params.cooldownMs < 0) fail('cooldownMs', `must be >= 0, got ${params.cooldownMs}`);
  if (params.makerTimeoutMs <= 0) fail('makerTimeoutMs', `must be > 0, got ${params.makerTimeoutMs}`);

  // Venue floor (G4/G7 — the value comes from config, never a literal): a per-epoch cap below
  // `min_size` makes every legal order impossible, which would silently pin the vault to `noop`.
  if (params.maxNotionalPerEpochSats < cfg.deepbook.minSize) {
    fail(
      'maxNotionalPerEpochSats',
      `must be >= the venue min_size (${cfg.deepbook.minSize} sats), got ${params.maxNotionalPerEpochSats}`,
    );
  }

  if (bad.length > 0) {
    throw new ConfigError(`invalid strategy parameters:\n${why.join('\n')}`, bad);
  }

  return params;
}

/**
 * Stable, NON-INVERTIBLE fingerprint of a parameter set — safe to publish in the journal so a
 * verifier can prove "the same parameters were in force" without learning them (G8).
 *
 * SHA-256 over the CONSTANT-LENGTH padded frame (serialize.ts), so the fingerprint leaks neither
 * the values (pre-image resistance, invariant 3) nor the field count (constant length).
 */
export function paramsFingerprint(params: StrategyParams): string {
  return createHash('sha256').update(serialize(params)).digest('hex');
}

// ── EXECUTION PARAMETERS — laddered quoting + deterministic slicing (T2.7) ────

/**
 * How the decided size is WORKED on the book. Secret, like the rest of the parameter set: the
 * ladder geometry is only revealed once the rungs are actually resting.
 *
 * FLAT and fixed-arity for the same reason `StrategyParams` is — it rides in the constant-length
 * Seal frame (see the @facts layout), so adding it changes no ciphertext length.
 */
export interface ExecutionParams {
  /** Maker rungs per side, 1..MAX_LADDER_LEVELS. 1 ⇒ the classic single level. */
  readonly ladderLevels: number;
  /** Spacing between rungs, bps of the decided price, stepping AWAY from the mid. */
  readonly ladderStepBps: Bps;
  /** Geometric size decay per rung, bps: sz_k ∝ (1 − decay/10_000)^k. */
  readonly ladderDecayBps: Bps;
  /** Slices a large notional is worked in. 1 ⇒ send the whole decided size this tick. */
  readonly sliceCount: number;
}

/** Canonical field order. The extension frame layout depends on it. */
export const EXECUTION_PARAM_KEYS = [
  'ladderLevels',
  'ladderStepBps',
  'ladderDecayBps',
  'sliceCount',
] as const satisfies readonly (keyof ExecutionParams)[];

/** Upper bound on slices — beyond this a slice is smaller than the venue min_size in practice. */
export const MAX_SLICE_COUNT = 64 as const;

/** Length of the extension block written into the strategy frame's zero tail. */
export const EXECUTION_PARAMS_EXT_BYTES = 16 as const;

/** Where the block starts inside the 128-byte frame — the first byte of `serialize.ts`'s padding. */
export const EXECUTION_PARAMS_EXT_OFFSET = SERIALIZED_PARAMS_PADDING_OFFSET;

/** Extension format version, byte 0 of the block. A ZERO here means "no extension present". */
export const EXECUTION_PARAMS_EXT_VERSION = 1 as const;

const EXT_OFF_VERSION = 0;
const EXT_OFF_LADDER_LEVELS = 1;
const EXT_OFF_LADDER_STEP_BPS = 3;
const EXT_OFF_LADDER_DECAY_BPS = 5;
const EXT_OFF_SLICE_COUNT = 7;

/**
 * Non-secret defaults (G7 — the mock/e2e path must run with no Seal round trip).
 *
 * Three rungs 15 bps apart with a 30 % decay: on the near-EMPTY hBTC/DBUSDC book (docs/RECON.md
 * R10) a single level is one point of no-fill, while three rungs hold a ~30 bps price range for
 * the same inventory. Four slices keep any single tick's footprint a quarter of the notional.
 */
export function defaultExecutionParams(): ExecutionParams {
  return validateExecutionParams({
    ladderLevels: 3,
    ladderStepBps: 15,
    ladderDecayBps: 3_000,
    sliceCount: 4,
  });
}

/** Enforce the bounds in the @facts block. Returns the same object when valid. */
export function validateExecutionParams(x: ExecutionParams): ExecutionParams {
  const bad: string[] = [];
  const why: string[] = [];
  const fail = (key: string, reason: string): void => {
    bad.push(key);
    why.push(`  - ${key}: ${reason}`);
  };

  const raw: unknown = x;
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('execution parameters must be an object', [...EXECUTION_PARAM_KEYS]);
  }

  for (const key of EXECUTION_PARAM_KEYS) {
    const value: unknown = x[key];
    if (value === undefined || value === null) {
      fail(key, 'missing');
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      fail(key, `must be a finite integer, got ${String(value)}`);
    }
  }
  if (bad.length > 0) {
    throw new ConfigError(`invalid execution parameters:\n${why.join('\n')}`, bad);
  }

  if (x.ladderLevels < 1 || x.ladderLevels > MAX_LADDER_LEVELS) {
    fail('ladderLevels', `must be in [1, ${MAX_LADDER_LEVELS}], got ${x.ladderLevels}`);
  }
  if (x.ladderStepBps < 0 || x.ladderStepBps > BPS_DENOMINATOR) {
    fail('ladderStepBps', `must be in [0, ${BPS_DENOMINATOR}], got ${x.ladderStepBps}`);
  }
  if (x.ladderLevels > 1 && x.ladderStepBps < 1) {
    // Rungs must be distinct prices; a zero step collapses the whole ladder onto one tick.
    fail('ladderStepBps', 'must be >= 1 when ladderLevels > 1 — rungs must be distinct prices');
  }
  if ((x.ladderLevels - 1) * x.ladderStepBps >= BPS_DENOMINATOR) {
    // The deepest BID rung is basePx·(1 − (levels−1)·step/10_000); at/over 100 % it is not a price.
    fail(
      'ladderStepBps',
      `(ladderLevels-1)*ladderStepBps must be < ${BPS_DENOMINATOR}, got ${(x.ladderLevels - 1) * x.ladderStepBps}`,
    );
  }
  if (x.ladderDecayBps < 0 || x.ladderDecayBps > BPS_DENOMINATOR) {
    fail('ladderDecayBps', `must be in [0, ${BPS_DENOMINATOR}], got ${x.ladderDecayBps}`);
  }
  if (x.sliceCount < 1 || x.sliceCount > MAX_SLICE_COUNT) {
    fail('sliceCount', `must be in [1, ${MAX_SLICE_COUNT}], got ${x.sliceCount}`);
  }

  if (bad.length > 0) {
    throw new ConfigError(`invalid execution parameters:\n${why.join('\n')}`, bad);
  }
  return x;
}

/** Encode the 16-byte extension block. Big-endian, zero-padded, deterministic (never random). */
export function encodeExecutionExtension(x: ExecutionParams): Uint8Array {
  validateExecutionParams(x);
  const buf = new ArrayBuffer(EXECUTION_PARAMS_EXT_BYTES);
  const view = new DataView(buf);
  view.setUint8(EXT_OFF_VERSION, EXECUTION_PARAMS_EXT_VERSION);
  view.setUint16(EXT_OFF_LADDER_LEVELS, x.ladderLevels, false);
  view.setUint16(EXT_OFF_LADDER_STEP_BPS, x.ladderStepBps, false);
  view.setUint16(EXT_OFF_LADDER_DECAY_BPS, x.ladderDecayBps, false);
  view.setUint16(EXT_OFF_SLICE_COUNT, x.sliceCount, false);
  // Bytes [9, 16) stay ZERO — reproducibility, exactly as in serialize.ts (G5).
  return new Uint8Array(buf);
}

/**
 * Inverse of {@link encodeExecutionExtension}. Returns `undefined` when the block is absent
 * (version byte 0 — a plain frame), and THROWS on a block that is present but malformed:
 * guessing a ladder from a corrupt frame is how a keeper quotes a strategy nobody chose.
 */
export function decodeExecutionExtension(bytes: Uint8Array): ExecutionParams | undefined {
  if (!(bytes instanceof Uint8Array)) {
    throw new ConfigError('execution extension must be a Uint8Array', [...EXECUTION_PARAM_KEYS]);
  }
  if (bytes.length < EXECUTION_PARAMS_EXT_BYTES) {
    throw new ConfigError(
      `execution extension must be at least ${EXECUTION_PARAMS_EXT_BYTES} bytes — got ${bytes.length}`,
      [...EXECUTION_PARAM_KEYS],
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, EXECUTION_PARAMS_EXT_BYTES);
  const version = view.getUint8(EXT_OFF_VERSION);
  if (version === 0) return undefined; // no extension present (invariant 6)
  if (version !== EXECUTION_PARAMS_EXT_VERSION) {
    throw new ConfigError(
      `unknown execution extension version ${version} (this build reads ${EXECUTION_PARAMS_EXT_VERSION})`,
      [...EXECUTION_PARAM_KEYS],
    );
  }

  return validateExecutionParams({
    ladderLevels: view.getUint16(EXT_OFF_LADDER_LEVELS, false),
    ladderStepBps: view.getUint16(EXT_OFF_LADDER_STEP_BPS, false),
    ladderDecayBps: view.getUint16(EXT_OFF_LADDER_DECAY_BPS, false),
    sliceCount: view.getUint16(EXT_OFF_SLICE_COUNT, false),
  });
}

/**
 * Write the execution parameters into the strategy frame's zero tail, returning a NEW frame.
 *
 * The length never changes (invariant 5) — that is the whole point: the Seal payload stays 128
 * bytes, so ciphertext size still leaks nothing about which strategy family is deployed (A4), and
 * `deserialize()` reads the identical StrategyParams it read before.
 */
export function embedExecutionParams(frame: Uint8Array, x: ExecutionParams): Uint8Array {
  if (frame.length !== SERIALIZED_PARAMS_BYTES) {
    throw new ConfigError(
      `strategy frame must be exactly ${SERIALIZED_PARAMS_BYTES} bytes — got ${frame.length}`,
      [...EXECUTION_PARAM_KEYS],
    );
  }
  const out = Uint8Array.from(frame);
  out.set(encodeExecutionExtension(x), EXECUTION_PARAMS_EXT_OFFSET);
  return out;
}

/** Read the execution parameters back out of a 128-byte strategy frame. */
export function extractExecutionParams(frame: Uint8Array): ExecutionParams | undefined {
  if (frame.length !== SERIALIZED_PARAMS_BYTES) {
    throw new ConfigError(
      `strategy frame must be exactly ${SERIALIZED_PARAMS_BYTES} bytes — got ${frame.length}`,
      [...EXECUTION_PARAM_KEYS],
    );
  }
  return decodeExecutionExtension(
    frame.subarray(EXECUTION_PARAMS_EXT_OFFSET, EXECUTION_PARAMS_EXT_OFFSET + EXECUTION_PARAMS_EXT_BYTES),
  );
}

/**
 * Stable, NON-INVERTIBLE fingerprint of the execution parameters — publishable in the journal so
 * a verifier can prove which ladder/slice schedule was in force without learning it (G8).
 */
export function executionParamsFingerprint(x: ExecutionParams): string {
  return createHash('sha256').update(encodeExecutionExtension(x)).digest('hex');
}
