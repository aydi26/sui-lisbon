// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line)
// @status     DONE
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
// @facts      ⚠ THE PUBLISHED FUNCTIONS ARE THE DEFAULT AND THE ONLY PRODUCTION BINDING.
// @facts        `PUBLISHED_REPLAY_FNS` closes over the real `strategy.evaluate` / `routing.route`.
// @facts        `ReplayFns` exists so the diff machinery can be exercised against a reference
// @facts        implementation in tests — it is NEVER a way to verify against a different ruleset.
// @facts      ⚠ SCHEMA GAP (owner: T0.3 `types.ts` / T4.2 `journal/`): `DecisionRecord` journals
// @facts        `oracle`, `book`, `hashi{limiter,pendingMint,pendingBurn,cursor}`, `decision`, `plan`
// @facts        — but NOT `idleHBtcSats`, `pendingExitDemandSats`, `restingOrderIds` or
// @facts        `lastDecisionAtMs`, all of which `StrategyInputs` requires. A tier-2 verifier must
// @facts        therefore SUPPLY them (`ReplayFnOptions.unrecordedInputs`); the default is
// @facts        `ZERO_UNRECORDED_INPUTS`. Tier 1 is unaffected — routing needs none of them.
// @implements export type VerifyTier / export interface Mismatch / ReplayReport / ReplayOptions
// @implements export interface ReplayFns / ReplayFnOptions / UnrecordedInputs
// @implements export const PUBLISHED_REPLAY_FNS / ZERO_UNRECORDED_INPUTS
// @implements export function strategyInputsFor(record, unrecorded): StrategyInputs
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
import { route, type RouteContext } from '../routing/route.js';
import { evaluate, type RulesetContext, type StrategyInputs } from '../strategy/evaluate.js';
import type { StrategyParams } from '../strategy/params.js';
import type { Decision, DecisionRecord, L2Book, LimiterSample, Millis, Plan } from '../types.js';

import { limiterAt, type LimiterTrajectory } from './limiter.js';

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

/**
 * The two published pure functions the replay re-runs. The production binding is
 * {@link PUBLISHED_REPLAY_FNS}; a caller may only substitute a REFERENCE implementation while
 * testing the diff machinery itself (see the @facts note — never to verify a different ruleset).
 */
export interface ReplayFns {
  readonly evaluate: (params: StrategyParams, inputs: StrategyInputs, ctx: RulesetContext) => Decision;
  readonly route: (decision: Decision, book: L2Book, ctx: RouteContext) => Plan;
}

/** ★ The real, published decision + routing functions. */
export const PUBLISHED_REPLAY_FNS: ReplayFns = Object.freeze({ evaluate, route });

/**
 * The `StrategyInputs` fields the journal does NOT carry (see the @facts SCHEMA GAP note).
 * A tier-2 verifier supplies them; tier 1 never touches them.
 */
export type UnrecordedInputs = Pick<
  StrategyInputs,
  'idleHBtcSats' | 'pendingExitDemandSats' | 'restingOrderIds' | 'lastDecisionAtMs'
>;

/** Honest default: zeros. If the strategy used these, tier 2 WILL report a mismatch — as it should. */
export const ZERO_UNRECORDED_INPUTS: UnrecordedInputs = Object.freeze({
  idleHBtcSats: 0n,
  pendingExitDemandSats: 0n,
  restingOrderIds: Object.freeze([] as bigint[]),
});

export interface ReplayFnOptions {
  /** Defaults to {@link PUBLISHED_REPLAY_FNS}. */
  readonly fns?: ReplayFns;
  /** Defaults to {@link ZERO_UNRECORDED_INPUTS} for every record. */
  readonly unrecordedInputs?: (record: DecisionRecord) => UnrecordedInputs;
}

export interface ReplayOptions extends ReplayFnOptions {
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

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — invariant 3: a mismatch NAMES the field and prints BOTH values.
// ─────────────────────────────────────────────────────────────────────────────

function fmt(value: unknown): string {
  if (value === undefined) return '(absent)';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return `[${value.map(fmt).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}: ${fmt(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return String(value);
}

function diffScalar(
  out: Mismatch[],
  tickMs: Millis,
  tier: VerifyTier,
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (fmt(expected) === fmt(actual)) return;
  out.push({ tickMs, tier, field, expected: fmt(expected), actual: fmt(actual) });
}

function diffList<T>(
  out: Mismatch[],
  tickMs: Millis,
  tier: VerifyTier,
  field: string,
  expected: readonly T[],
  actual: readonly T[],
): void {
  if (expected.length !== actual.length) {
    diffScalar(out, tickMs, tier, `${field}.length`, expected.length, actual.length);
  }
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    diffScalar(out, tickMs, tier, `${field}[${i}]`, expected[i], actual[i]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input reconstruction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the exact `StrategyInputs` a tick consumed, from the RECORD alone (plus whatever the
 * schema does not carry — see the @facts SCHEMA GAP). PURE: no clock, no fetch (invariant 1).
 */
export function strategyInputsFor(
  record: DecisionRecord,
  unrecorded: UnrecordedInputs = ZERO_UNRECORDED_INPUTS,
): StrategyInputs {
  return {
    book: record.book,
    oracle: record.oracle,
    // ★ The TRUSTLESS replay sample the tick actually ran on — never an SDK hint (G5).
    limiter: record.hashi.limiter,
    pendingMintSats: record.hashi.pendingMintSats,
    pendingBurnSats: record.hashi.pendingBurnSats,
    idleHBtcSats: unrecorded.idleHBtcSats,
    pendingExitDemandSats: unrecorded.pendingExitDemandSats,
    tickMs: record.tickMs,
    // Recorded on the Decision, which is exactly why the seeded jitter reproduces.
    jitterSeed: record.decision.jitterSeed,
    restingOrderIds: unrecorded.restingOrderIds,
    ...(unrecorded.lastDecisionAtMs === undefined ? {} : { lastDecisionAtMs: unrecorded.lastDecisionAtMs }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay
// ─────────────────────────────────────────────────────────────────────────────

/** Re-run one journaled tick against its OWN recorded inputs. PURE. */
export function replayRecord(
  record: DecisionRecord,
  params: StrategyParams | undefined,
  ctx: RulesetContext,
  routeCtx: RouteContext,
  opts: ReplayFnOptions = {},
): ReplayedTick {
  const fns = opts.fns ?? PUBLISHED_REPLAY_FNS;
  const mismatches: Mismatch[] = [];
  const tickMs = record.tickMs;

  // ── TIER 1 — routing. No keys, no strategy plaintext. Anyone can run this. ──
  // The RECORDED decision is the input; we only re-derive the Plan it should have produced.
  const plan = fns.route(record.decision, record.book, routeCtx);
  diffList(mismatches, tickMs, 'routing', 'plan.makerOrders', record.plan.makerOrders, plan.makerOrders);
  diffList(mismatches, tickMs, 'routing', 'plan.iocOrders', record.plan.iocOrders, plan.iocOrders);
  diffList(mismatches, tickMs, 'routing', 'plan.cancels', record.plan.cancels, plan.cancels);

  // ── TIER 2 — trigger. Needs the strategy plaintext (owner / Seal disclosure). ──
  if (params === undefined) return { tickMs, plan, mismatches };

  const unrecorded = opts.unrecordedInputs?.(record) ?? ZERO_UNRECORDED_INPUTS;
  const decision = fns.evaluate(params, strategyInputsFor(record, unrecorded), ctx);

  diffScalar(mismatches, tickMs, 'trigger', 'decision.action', record.decision.action, decision.action);
  diffScalar(mismatches, tickMs, 'trigger', 'decision.bidPx', record.decision.bidPx, decision.bidPx);
  diffScalar(mismatches, tickMs, 'trigger', 'decision.askPx', record.decision.askPx, decision.askPx);
  diffScalar(mismatches, tickMs, 'trigger', 'decision.bidSz', record.decision.bidSz, decision.bidSz);
  diffScalar(mismatches, tickMs, 'trigger', 'decision.askSz', record.decision.askSz, decision.askSz);
  diffScalar(mismatches, tickMs, 'trigger', 'decision.cause', record.decision.cause, decision.cause);
  diffScalar(
    mismatches,
    tickMs,
    'trigger',
    'decision.jitterSeed',
    record.decision.jitterSeed,
    decision.jitterSeed,
  );
  diffList(mismatches, tickMs, 'trigger', 'decision.cancels', record.decision.cancels, decision.cancels);

  return { tickMs, decision, plan, mismatches };
}

/** Replay every record in a segment and aggregate the verdict. PURE. */
export function replaySegment(segment: DecisionSegment, opts: ReplayOptions): ReplayReport {
  const tier: VerifyTier = opts.params === undefined ? 'routing' : 'trigger';
  const mismatches: Mismatch[] = [];

  for (const record of segment.records) {
    const tick = replayRecord(record, opts.params, opts.ruleset, opts.route, {
      ...(opts.fns === undefined ? {} : { fns: opts.fns }),
      ...(opts.unrecordedInputs === undefined ? {} : { unrecordedInputs: opts.unrecordedInputs }),
    });
    mismatches.push(...tick.mismatches);
  }

  if (opts.limiterTrajectory !== undefined) {
    mismatches.push(
      ...compareLimiter(
        segment.records.map((record) => record.hashi.limiter),
        opts.limiterTrajectory,
      ),
    );
  }

  return {
    tier,
    ticks: segment.records.length,
    mismatches,
    reproduced: mismatches.length === 0,
  };
}

/**
 * `--limiter`: assert the journal's recorded limiter readings equal the trajectory re-derived from
 * Hashi's own `WithdrawalSigned` stream (G5). Any drift means the keeper's claim was unverifiable.
 *
 * The limiter tier needs NO keys — it is publicly checkable, so its mismatches are tier 'routing'.
 */
export function compareLimiter(
  recorded: readonly LimiterSample[],
  derived: LimiterTrajectory,
): readonly Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const sample of recorded) {
    const expected = limiterAt(derived, sample.atMs, derived.cfg);
    diffScalar(mismatches, sample.atMs, 'routing', 'limiter.tokens', expected.tokens, sample.tokens);
    diffScalar(
      mismatches,
      sample.atMs,
      'routing',
      'limiter.queueDepth',
      expected.queueDepth,
      sample.queueDepth,
    );
    diffScalar(mismatches, sample.atMs, 'routing', 'limiter.atSecs', expected.atSecs, sample.atSecs);
  }

  // Invariant 3 of ./limiter.ts: an unjoinable boundary is REPORTED, never quietly passed.
  for (const boundary of derived.samples) {
    if (boundary.satsSource === 'unresolved') {
      mismatches.push({
        tickMs: boundary.atMs,
        tier: 'routing',
        field: `limiter.satsSource[seq ${boundary.eventSeq}]`,
        expected: "'requested'",
        actual: `'unresolved' (request_ids ${fmt(boundary.unresolvedRequestIds ?? [])} carry no joinable amount)`,
      });
    }
    if (boundary.rejected !== undefined) {
      mismatches.push({
        tickMs: boundary.atMs,
        tier: 'routing',
        field: `limiter.rejected[seq ${boundary.eventSeq}]`,
        // G3: a rejected batch emits NO WithdrawalSigned, so seeing one in the replay means the
        // derivation and the chain disagree — the amount join or a genesis scalar is wrong.
        expected: 'accepted (a rejected batch emits no WithdrawalSigned — G3)',
        actual: `${boundary.rejected} on ${fmt(boundary.debitedSats)} sats with capacity ${fmt(boundary.capacityBeforeDebitSats)}`,
      });
    }
  }

  return mismatches;
}
