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
// @implements export const BPS_DENOMINATOR: 10_000
// @implements export interface StrategyParams
// @implements export const STRATEGY_PARAM_KEYS: readonly (keyof StrategyParams)[]
// @implements export function defaultParams(cfg: Config): StrategyParams
// @implements export function validateParams(params: StrategyParams, cfg: Config): StrategyParams
// @implements export function paramsFingerprint(params: StrategyParams): string
// @forbidden  logging, journaling, or serializing these values in plaintext anywhere (G8)
// @forbidden  `number` for any satoshi amount — bps/ms only
// @forbidden  a venue/DEX parameter — the venue is fixed by G4
// @invariant  1. Every field is present and finite; `validateParams` rejects partial objects.
// @invariant  2. Bounds: 0 < spreadBps <= 10_000; |skewBps| <= spreadBps; jitterBps <= spreadBps/2.
// @invariant  3. `paramsFingerprint` is a HASH — it must never be invertible back to the values.
// @invariant  4. The struct is FLAT and fixed-arity so serialize.ts can pad it to a constant length.
// @ac         docs/KEEPER.md §13 A4 — constant-length serialization across strategy families
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type { Config } from '../config.js';
import type { Bps, Millis, Sats } from '../types.js';
import { ConfigError } from '../util/errors.js';

import { serialize } from './serialize.js';

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
