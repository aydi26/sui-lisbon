// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     DONE
// @spec       docs/KEEPER.md §6 (divergence breaker = ALSO the hBTC-depeg circuit breaker)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.8) · docs/FACTS.md#pyth-oracle
// @rules      G7 G8 G9
// @depends    ./pyth.ts (T2.8) · ./twap.ts (T2.8) · ../types.ts (OracleSnapshot)
// @facts      ★ BREAKER: |pythBtcUsd − deepbookImpliedBtcUsd| / pythBtcUsd > cfg.pyth.divergenceBps
// @facts        ⇒ throw ⇒ `strategy.evaluate` yields `noop` with cause='oracle-divergence'.
// @facts        cfg.pyth.divergenceBps default 200 (2%).
// @facts      ★ THIS IS ALSO THE hBTC-DEPEG BREAKER (G9). hBTC is custodial-threshold wrapped BTC
// @facts        (G8) and CAN trade below BTC on a thin book — especially while exits are throttled.
// @facts        Valuing NAV at raw Pyth would hide exactly that. NAV is the DeepBook mid; Pyth is
// @facts        only the reference we diverge FROM.
// @facts      ★ BOTH prices are journaled (DecisionRecord.oracle) so the breaker decision is
// @facts        PUBLICLY REPRODUCIBLE — a verifier re-computes the bps from the record (G5).
// @facts      Fail closed: a missing/stale Pyth price or an undefined TWAP (empty book, R10) is a
// @facts        divergence failure, not a pass.
// @facts      bps arithmetic is bigint-exact: bps = |a − b| * 10_000n / a. No floats.
// @facts      HYSTERESIS (Schmitt trigger): trip at cfg.pyth.divergenceBps, re-arm only at HALF
// @facts        that AND after one full cfg.pyth.twapWindowMs — the TWAP must have completely
// @facts        refreshed before we trade again, so a price sitting on the threshold cannot
// @facts        chatter the breaker open/closed every tick.
// @implements export class OracleDivergenceError extends AphoticError
// @implements export class OracleUnavailableError extends AphoticError
// @implements export function divergenceBps(referencePx: bigint, observedPx: bigint): Bps
// @implements export function assertNoDivergence(cfg: Config, snapshot: OracleSnapshot, nowMs: Millis): void
// @implements export function isDivergent(cfg: Config, snapshot: OracleSnapshot): boolean
// @implements export function createBreaker(): BreakerState
// @implements export function stepBreaker(cfg: Config, state: BreakerState, snapshot: OracleSnapshot, nowMs: Millis): BreakerState
// @forbidden  valuing NAV/collateral at the Pyth price instead of the DeepBook mid (G9)
// @forbidden  floating-point bps maths — bigint only
// @forbidden  swallowing the throw — `evaluate` must observe it and record cause='oracle-divergence'
// @invariant  1. PURE + total apart from the deliberate throw in `assertNoDivergence`.
// @invariant  2. A zero/absent reference price is DIVERGENT (fail closed), never a division error.
// @invariant  3. The thrown error carries both prices + the computed bps for the journal.
// @invariant  4. A tripped breaker re-arms only below HALF the trip threshold and after one full
//                TWAP window has elapsed (hysteresis — no chatter on a borderline price).
// @ac         docs/KEEPER.md §13 A7 — breaker trips on injected divergence, yields noop
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Bps, Millis, OracleSnapshot } from '../types.js';
import { AphoticError } from '../util/errors.js';

import { StaleOracleError, isStale } from './pyth.js';

/** The `Decision.cause` the run loop records when this breaker fires (docs/KEEPER.md §6). */
export const ORACLE_DIVERGENCE_CAUSE = 'oracle-divergence';

/** Divergence measured as an unbounded number of bps saturates here (invariant 2, fail closed). */
export const MAX_DIVERGENCE_BPS: Bps = Number.MAX_SAFE_INTEGER;

/**
 * The circuit-breaker rejection. Carries both prices so the journal record makes the decision
 * publicly reproducible (G5) — a verifier recomputes the bps and gets the same answer.
 */
export class OracleDivergenceError extends AphoticError {
  readonly referencePx: bigint;
  readonly observedPx: bigint;
  readonly bps: Bps;
  readonly limitBps: Bps;

  constructor(referencePx: bigint, observedPx: bigint, bps: Bps, limitBps: Bps) {
    super(
      'OracleDivergence',
      `oracle divergence ${bps}bps exceeds ${limitBps}bps (reference ${referencePx}, observed ${observedPx})`,
    );
    this.referencePx = referencePx;
    this.observedPx = observedPx;
    this.bps = bps;
    this.limitBps = limitBps;
  }
}

/**
 * One side of the reading is missing entirely — most often the DeepBook book is empty on testnet
 * (docs/RECON.md R10) so there is no mid and no TWAP. Distinct from a divergence: nothing diverged,
 * we simply have no price. Both fail CLOSED.
 */
export class OracleUnavailableError extends AphoticError {
  readonly what: string;

  constructor(what: string, detail: string) {
    super('OracleUnavailable', `oracle input unavailable (${what}): ${detail}`);
    this.what = what;
  }
}

/** `|reference − observed| * 10_000 / reference`, bigint-exact. A zero reference is max divergence. */
export function divergenceBps(referencePx: bigint, observedPx: bigint): Bps {
  // Invariant 2: absence of a reference is not a division error, it is total divergence.
  if (referencePx <= 0n || observedPx <= 0n) return MAX_DIVERGENCE_BPS;

  const diff = referencePx > observedPx ? referencePx - observedPx : observedPx - referencePx;
  const bps = (diff * 10_000n) / referencePx;

  return bps >= BigInt(MAX_DIVERGENCE_BPS) ? MAX_DIVERGENCE_BPS : Number(bps);
}

/**
 * Divergence of the snapshot, in bps. Both fields carry the SAME fixed-point scale
 * (see `oracle/index.ts::deepbookPriceToUsdFixed`); bps is a ratio, so the scale cancels.
 */
export function snapshotDivergenceBps(snapshot: OracleSnapshot): Bps {
  return divergenceBps(snapshot.pythPx, snapshot.deepbookTwap);
}

/** Non-throwing predicate — for UI/telemetry. The trading path uses {@link assertNoDivergence}. */
export function isDivergent(cfg: Config, snapshot: OracleSnapshot): boolean {
  return snapshotDivergenceBps(snapshot) > cfg.pyth.divergenceBps;
}

/**
 * The breaker. Throws {@link OracleDivergenceError} so `evaluate` returns
 * `noop` with `cause='oracle-divergence'` (docs/KEEPER.md §6).
 *
 * Fails CLOSED: a stale Pyth reading or an undefined TWAP is a failure, not a pass.
 *
 * ⚠ `snapshot.deepbookMid` remains the NAV/collateral reference (G9). This function never
 * substitutes `pythPx` for it — Pyth is only the reference we diverge FROM.
 */
export function assertNoDivergence(cfg: Config, snapshot: OracleSnapshot, nowMs: Millis): void {
  // 1. Freshness first — a stale reference makes the comparison meaningless.
  if (isStale(cfg, snapshot.pythPublishTimeMs, nowMs)) {
    throw new StaleOracleError(snapshot.pythPublishTimeMs, nowMs, cfg.pyth.maxStalenessMs);
  }

  // 2. Then divergence. A non-positive price on either side saturates to MAX (invariant 2).
  const bps = snapshotDivergenceBps(snapshot);
  if (bps > cfg.pyth.divergenceBps) {
    throw new OracleDivergenceError(snapshot.pythPx, snapshot.deepbookTwap, bps, cfg.pyth.divergenceBps);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hysteresis — the stateful breaker the run loop carries across ticks
// ─────────────────────────────────────────────────────────────────────────────

/** Immutable breaker state. The run loop threads it tick to tick; `verify/` replays it. */
export interface BreakerState {
  readonly tripped: boolean;
  /** Divergence observed on the most recent step, in bps. */
  readonly lastBps: Bps;
  /** Logical time of the most recent TRIP (undefined while it has never tripped). */
  readonly trippedAtMs: Millis | undefined;
  /** `ORACLE_DIVERGENCE_CAUSE` while tripped, else undefined — copied straight into `Decision.cause`. */
  readonly cause: string | undefined;
}

/** A closed (trading-enabled) breaker that has never observed anything. */
export function createBreaker(): BreakerState {
  return Object.freeze({ tripped: false, lastBps: 0, trippedAtMs: undefined, cause: undefined });
}

/**
 * Re-arm threshold: HALF the trip threshold. A 2:1 Schmitt ratio is the standard choice — it is
 * wide enough that ordinary noise around the limit cannot flip the breaker every tick.
 */
export function resetBps(cfg: Config): Bps {
  return Math.floor(cfg.pyth.divergenceBps / 2);
}

/**
 * Minimum time a trip is held: one full TWAP window. Below that, the TWAP still contains samples
 * from the divergent period, so "recovered" would be an artefact of our own averaging.
 */
export function recoveryMs(cfg: Config): Millis {
  return cfg.pyth.twapWindowMs;
}

/**
 * Advance the breaker by one tick. PURE — `nowMs` is an argument, the state is returned, nothing
 * is mutated, so `verify/` reproduces the exact trip/reset sequence from the journal (G5).
 *
 * Trip:  divergence > cfg.pyth.divergenceBps, OR the Pyth reading is stale, OR a side is missing.
 * Reset: divergence <= resetBps(cfg) AND at least recoveryMs(cfg) has elapsed since the trip.
 */
export function stepBreaker(
  cfg: Config,
  state: BreakerState,
  snapshot: OracleSnapshot,
  nowMs: Millis,
): BreakerState {
  // Fail closed: staleness is treated as unbounded divergence, exactly like a missing price.
  const bps = isStale(cfg, snapshot.pythPublishTimeMs, nowMs)
    ? MAX_DIVERGENCE_BPS
    : snapshotDivergenceBps(snapshot);

  if (!state.tripped) {
    if (bps > cfg.pyth.divergenceBps) {
      return Object.freeze({
        tripped: true,
        lastBps: bps,
        trippedAtMs: nowMs,
        cause: ORACLE_DIVERGENCE_CAUSE,
      });
    }
    return Object.freeze({ tripped: false, lastBps: bps, trippedAtMs: undefined, cause: undefined });
  }

  const heldMs = state.trippedAtMs === undefined ? Number.POSITIVE_INFINITY : nowMs - state.trippedAtMs;
  const recovered = bps <= resetBps(cfg) && heldMs >= recoveryMs(cfg);
  if (recovered) {
    return Object.freeze({ tripped: false, lastBps: bps, trippedAtMs: undefined, cause: undefined });
  }

  // Still tripped. A fresh excursion above the limit RE-ARMS the hold timer.
  const trippedAtMs = bps > cfg.pyth.divergenceBps ? nowMs : state.trippedAtMs;
  return Object.freeze({
    tripped: true,
    lastBps: bps,
    trippedAtMs,
    cause: ORACLE_DIVERGENCE_CAUSE,
  });
}
