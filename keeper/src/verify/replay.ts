// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line)
// @status     STUB
// @spec       docs/KEEPER.md §9.1 (decision replay, TWO honest tiers), §13 A3/A10
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.3)
// @rules      G4 G5 G7 G8
// @depends    ./limiter.ts (T4.3) · ../journal/schema.ts (T4.2) · ../strategy/evaluate.ts (T2.6) ·
//             ../routing/route.ts (T2.7) · ../storage/walrus.ts (T2.9)
// @facts      ★ WHAT REPLAY PROVES: re-run the PUBLISHED `evaluate`/`route` against each record's
// @facts        RECORDED inputs (book, oracle, hashi, jitterSeed) and report any decision that fails
// @facts        to reproduce. Determinism is the product (docs/KEEPER.md §0).
// @facts      ★★ TWO TIERS — STATE BOTH HONESTLY (G8):
// @facts        1. ROUTING tier — given the recorded Decision + book, is the Plan correct?
// @facts           PUBLICLY checkable by anyone, NO keys, NO strategy plaintext.
// @facts        2. TRIGGER tier — given the parameters, was the Decision itself correct?
// @facts           Requires the strategy plaintext: the owner, or a Seal version-epoch disclosure.
// @facts        Never present tier 1 as if it proved tier 2.
// @facts      Jitter reproduces because `Decision.jitterSeed` is journaled and the PRNG is seeded
// @facts        SplitMix64 (../util/rng.ts) — same seed, same draw, forever.
// @facts      The limiter reading fed back into the replay is the TRUSTLESS one (./limiter.ts), and
// @facts        `--limiter` additionally asserts the trajectory matches the journal's recorded
// @facts        readings — proving "the bridge was tightening when we pulled quotes" is
// @facts        re-derivable from Hashi's own events, not merely logged (G5).
// @facts      Segments are fetched from Walrus by blob id (content-derived ⇒ self-certifying) with
// @facts        the on-chain `DecisionRecorded` events as the authoritative pointer list.
// @implements export type VerifyTier / export interface Mismatch / ReplayReport / ReplayOptions
// @implements export function replayRecord(record: DecisionRecord, params: StrategyParams | undefined, ctx: RulesetContext, routeCtx: RouteContext): ReplayedTick
// @implements export function replaySegment(segment: DecisionSegment, opts: ReplayOptions): ReplayReport
// @implements export function compareLimiter(recorded: readonly LimiterSample[], derived: LimiterTrajectory): readonly Mismatch[]
// @forbidden  claiming the routing tier proves trigger correctness (G8)
// @forbidden  re-running with LIVE inputs instead of the recorded ones — that proves nothing
// @forbidden  any wall-clock read — every tick's time comes from the record
// @invariant  1. PURE: records in, report out. Fetching is the caller's job (./index.ts).
// @invariant  2. Tier 1 runs with `params === undefined` and still produces a verdict.
// @invariant  3. A mismatch NAMES the field and prints both values — never a bare boolean.
// @invariant  4. Zero mismatches over a mock run is a hard CI gate (A3).
// @ac         docs/KEEPER.md §13 A3 — `verify --vault <ID> --from-epoch 0` reports 0 mismatches
// @verify     npm run test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { DecisionSegment } from '../journal/schema.js';
import type { RouteContext } from '../routing/route.js';
import type { RulesetContext } from '../strategy/evaluate.js';
import type { StrategyParams } from '../strategy/params.js';
import type { Decision, DecisionRecord, LimiterSample, Millis, Plan } from '../types.js';

import type { LimiterTrajectory } from './limiter.js';

/** Tier 1 needs no keys; tier 2 needs the strategy plaintext. Never conflate them (G8). */
export type VerifyTier = 'routing' | 'trigger';

export interface Mismatch {
  readonly tickMs: Millis;
  readonly tier: VerifyTier;
  /** e.g. 'decision.bidPx', 'plan.iocOrders[0].sz', 'limiter.tokens'. */
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ReplayedTick {
  readonly tickMs: Millis;
  /** Recomputed from the recorded inputs. Undefined at tier 1 (no parameters available). */
  readonly decision?: Decision;
  readonly plan: Plan;
  readonly mismatches: readonly Mismatch[];
}

export interface ReplayOptions {
  /** Absent ⇒ tier 1 (routing only). Present ⇒ tier 2 (trigger correctness too). */
  readonly params?: StrategyParams;
  readonly ruleset: RulesetContext;
  readonly route: RouteContext;
  /** When set, `--limiter`: also compare the recorded readings to the re-derived trajectory. */
  readonly limiterTrajectory?: LimiterTrajectory;
}

export interface ReplayReport {
  readonly tier: VerifyTier;
  readonly ticks: number;
  readonly mismatches: readonly Mismatch[];
  /** True iff `mismatches.length === 0`. */
  readonly reproduced: boolean;
}

/** Re-run one journaled tick against its OWN recorded inputs. PURE. */
// TODO(T4.3): tier 1 = route(record.decision, record.book) vs record.plan;
//             tier 2 = evaluate(params, recordedInputs) vs record.decision (jitter from jitterSeed).
export function replayRecord(
  _record: DecisionRecord,
  _params: StrategyParams | undefined,
  _ctx: RulesetContext,
  _routeCtx: RouteContext,
): ReplayedTick {
  throw new Error('TODO(T4.3): replayRecord not implemented');
}

/** Replay every record in a segment and aggregate the verdict. PURE. */
// TODO(T4.3): map replayRecord over segment.records; fold mismatches; set tier from opts.params.
export function replaySegment(_segment: DecisionSegment, _opts: ReplayOptions): ReplayReport {
  throw new Error('TODO(T4.3): replaySegment not implemented');
}

/**
 * `--limiter`: assert the journal's recorded limiter readings equal the trajectory re-derived from
 * Hashi's own `WithdrawalSigned` stream (G5). Any drift means the keeper's claim was unverifiable.
 */
// TODO(T4.3): pair each recorded sample with the derived boundary at the same atMs; diff tokens
//             and queueDepth; report 'unresolved' boundaries explicitly rather than passing them.
export function compareLimiter(
  _recorded: readonly LimiterSample[],
  _derived: LimiterTrajectory,
): readonly Mismatch[] {
  throw new Error('TODO(T4.3): compareLimiter not implemented');
}
