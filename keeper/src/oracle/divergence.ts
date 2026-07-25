// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     STUB
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
// @implements export class OracleDivergenceError extends AphoticError
// @implements export function divergenceBps(referencePx: bigint, observedPx: bigint): Bps
// @implements export function assertNoDivergence(cfg: Config, snapshot: OracleSnapshot, nowMs: Millis): void
// @implements export function isDivergent(cfg: Config, snapshot: OracleSnapshot): boolean
// @forbidden  valuing NAV/collateral at the Pyth price instead of the DeepBook mid (G9)
// @forbidden  floating-point bps maths — bigint only
// @forbidden  swallowing the throw — `evaluate` must observe it and record cause='oracle-divergence'
// @invariant  1. PURE + total apart from the deliberate throw in `assertNoDivergence`.
// @invariant  2. A zero/absent reference price is DIVERGENT (fail closed), never a division error.
// @invariant  3. The thrown error carries both prices + the computed bps for the journal.
// @ac         docs/KEEPER.md §13 A7 — breaker trips on injected divergence, yields noop
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Bps, Millis, OracleSnapshot } from '../types.js';
import { AphoticError } from '../util/errors.js';

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

/** `|reference − observed| * 10_000 / reference`, bigint-exact. A zero reference is max divergence. */
// TODO(T2.8): bigint abs-diff, scale by 10_000n, divide by reference; reference 0n ⇒ Number.MAX_SAFE_INTEGER.
export function divergenceBps(_referencePx: bigint, _observedPx: bigint): Bps {
  throw new Error('TODO(T2.8): divergenceBps not implemented');
}

/** Non-throwing predicate — for UI/telemetry. The trading path uses {@link assertNoDivergence}. */
// TODO(T2.8): divergenceBps(snapshot.pythPx, snapshot.deepbookTwap) > cfg.pyth.divergenceBps.
export function isDivergent(_cfg: Config, _snapshot: OracleSnapshot): boolean {
  throw new Error('TODO(T2.8): isDivergent not implemented');
}

/**
 * The breaker. Throws {@link OracleDivergenceError} so `evaluate` returns
 * `noop` with `cause='oracle-divergence'` (docs/KEEPER.md §6).
 *
 * Fails CLOSED: a stale Pyth reading or an undefined TWAP is a failure, not a pass.
 */
// TODO(T2.8): assertFresh(cfg, price, nowMs) first, then compare Pyth vs DeepBook TWAP.
export function assertNoDivergence(
  _cfg: Config,
  _snapshot: OracleSnapshot,
  _nowMs: Millis,
): void {
  throw new Error('TODO(T2.8): assertNoDivergence not implemented');
}
