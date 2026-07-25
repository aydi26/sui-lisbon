// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §3.1 (the encrypted parameter set), §3.3 (Seal identity + rotation)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · CUT LINE item 2 (encrypted strategy)
// @spec       "README (8).md" (base Aphotic: the strategy is the secret, the envelope is public)
// @rules      G4 G5 G7 G8 G9 G10
// @depends    ../config.ts · ../types.ts (Bps/Sats/Millis)
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

import type { Config } from '../config.js';
import type { Bps, Millis, Sats } from '../types.js';

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

/**
 * Non-secret defaults so the MOCK/e2e path runs with no Seal round trip (G7).
 * A real vault always ships operator-chosen values.
 */
// TODO(T2.6): derive makerTimeoutMs from cfg.loop.makerTimeoutMs; pick conservative venue-safe bounds.
export function defaultParams(_cfg: Config): StrategyParams {
  throw new Error('TODO(T2.6): defaultParams not implemented');
}

/** Enforce invariant 2 and reject partial/NaN input. Returns the same object when valid. */
// TODO(T2.6): assert presence + bounds for every STRATEGY_PARAM_KEYS entry; throw ConfigError-style.
export function validateParams(_params: StrategyParams, _cfg: Config): StrategyParams {
  throw new Error('TODO(T2.6): validateParams not implemented');
}

/**
 * Stable, NON-INVERTIBLE fingerprint of a parameter set — safe to publish in the journal so a
 * verifier can prove "the same parameters were in force" without learning them (G8).
 */
// TODO(T2.6): hash the padded serialization (serialize.ts), hex-encode; never expose field values.
export function paramsFingerprint(_params: StrategyParams): string {
  throw new Error('TODO(T2.6): paramsFingerprint not implemented');
}
