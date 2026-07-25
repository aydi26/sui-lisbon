// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line — but this is the STRONGEST claim in the project)
// @status     STUB
// @spec       docs/KEEPER.md §9.2 (`deriveLimiter`) + ERRATA E-K3 (Signed has no amount/timestamp)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.3) · docs/GOLDEN-RULES.md#g5
// @spec       docs/FACTS.md#guardian-limiter · docs/RECON.md#r8 #r9
// @rules      G3 G5 G7 G8
// @depends    ../hashi/limiter.ts (T0.5) ★ THE ONE IMPLEMENTATION · ../hashi/types.ts · ../types.ts
// @facts      ★★ ONE IMPLEMENTATION, NO DRIFT (G5). This module IMPORTS `projectCapacity`,
// @facts        `projectCapacityAtSecs`, `consume`, `genesis` and `msToSecs` from ../hashi/limiter.ts
// @facts        and RE-EXPORTS them. It must NEVER re-implement the arithmetic. The MOCK imports the
// @facts        same functions — that is what makes the mock↔replay cross-test meaningful instead of
// @facts        comparing two things we wrote.
// @facts      ★ THE CLAIM: the Guardian bucket is trustlessly replayable from Hashi's OWN on-chain
// @facts        events. Trust anchors are exactly TWO genesis scalars (cfg.limiter.refillRateSatsPerSec,
// @facts        cfg.limiter.maxBucketCapacitySats), both observationally boundable. Everything else is
// @facts        derived. `adapter.guardian.limiterStatus()` is a HINT and is never an input here.
// @facts      ★★ `WithdrawalSigned { withdrawal_txn_id, request_ids, signatures, guardian_signatures }`
// @facts        CARRIES NO AMOUNT AND NO TIMESTAMP — yet it is THE event that advances the bucket.
// @facts        Therefore the replay MUST:
// @facts          sats = Σ over `request_ids` of `WithdrawalRequested.btc_amount`  (the REQUESTED
// @facts            amount — `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount` is NET of
// @facts            the Bitcoin network fee, observed 1_000_000 requested vs 998_835 output, and the
// @facts            bucket is debited by the REQUESTED amount. Picked is a FALLBACK only.)
// @facts          timestamp = the SUI EVENT ENVELOPE `timestampMs` (camelCase, a decimal STRING over
// @facts            JSON-RPC ⇒ BigInt(...), never parseInt). The struct's own `timestamp_ms`, where it
// @facts            exists at all, differs (observed 701 ms apart) — always prefer the envelope.
// @facts        ⇒ the requestId→sats index must be built from the `WithdrawalRequested` stream BEFORE
// @facts          walking `Signed`. Fetch both, or fetch by module and partition.
// @facts        ../hashi/normalize.ts already performs this join and records `satsSource`
// @facts        ('requested' | 'picked' | 'unresolved'). 'unresolved' ⇒ the replay is INCOMPLETE at
// @facts        that boundary and must be reported, never silently under-debited.
// @facts      ★ ALGORITHM (verbatim, docs/FACTS.md#guardian-limiter):
// @facts        project_capacity = min(cap, tokens SAT+ (ts SAT- last) SAT* refill_rate)   [SECONDS]
// @facts        consume(seq, ts, amount): seq mismatch ⇒ InvalidInputs · ts < last ⇒ InvalidInputs ·
// @facts          capacity < amount ⇒ RateLimitExceeded (REJECTED, NEVER QUEUED — G3) ·
// @facts          else tokens = capacity − amount (CLAMP BEFORE DEBIT); last = ts; next_seq += 1.
// @facts        genesis = { tokens: max_bucket_capacity, last_updated_at: 0, next_seq: 0 }.
// @facts      ★ TIME BASE IS UNIX SECONDS. Envelope ms ⇒ `msToSecs` (FLOOR). Rounding up drifts by a
// @facts        refill tick per event and the trajectory stops matching.
// @facts      queueDepth = Σ Requested − Σ (Signed | Cancelled)  (docs/KEEPER.md §9.2).
// @facts      ORDERING is committee-leader-discretionary, "generally FIFO, not strict" (G3). The
// @facts        TOKEN TOTAL is order-independent; queue IDENTITY ordering is not. Never assume strict
// @facts        FIFO for correctness.
// @facts      ⚠ HONESTY (G8): live testnet scalars are refill 115_740 sats/s and cap 10_000_000_000
// @facts        sats (100 BTC/day). An Aphotic-sized exit will essentially never be rate-limited. The
// @facts        value here is VERIFIABILITY, not scarcity. Do not pitch congestion.
// @implements export { consume, genesis, msToSecs, projectCapacity, projectCapacityAtSecs }  // re-export, G5
// @implements export interface DeriveConfig / LimiterTrajectory / LimiterBoundary
// @implements export function indexRequestedSats(events: readonly HashiEvent[]): ReadonlyMap<string, Sats>
// @implements export function deriveLimiter(events: readonly HashiEvent[], cfg: DeriveConfig): LimiterTrajectory
// @implements export function limiterAt(trajectory: LimiterTrajectory, atMs: Millis, cfg: DeriveConfig): LimiterSample
// @forbidden  a SECOND copy of projectCapacity/consume anywhere — G5, this is the drift the rule exists for
// @forbidden  using `adapter.guardian.limiterStatus()` as an input — it is an UNVERIFIED HINT
// @forbidden  debiting from `WithdrawalPickedForProcessing` amounts when a Requested join exists
// @forbidden  parseInt/Number on an envelope timestamp — BigInt only
// @forbidden  assuming strict FIFO ordering (G3)
// @invariant  1. PURE: no clock, no I/O, no adapter. Events in, trajectory out.
// @invariant  2. Uses ONLY ../hashi/limiter.ts arithmetic — zero local maths on the bucket.
// @invariant  3. A `satsSource === 'unresolved'` boundary is REPORTED, never silently skipped.
// @invariant  4. Replaying the same event slice twice yields byte-identical samples.
// @invariant  5. An over-capacity batch is a REJECTION that leaves the bucket untouched (G3).
// @ac         docs/KEEPER.md §13 A2 — mock.limiterStatus() === deriveLimiter(mock.signedEvents) at EVERY boundary
// @ac         docs/KEEPER.md §13 A10 — `verify --limiter` matches the journal's recorded readings
// @verify     npm run test -- verify
// @verify     npm test -- limiter.cross
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  consume,
  genesis,
  msToSecs,
  projectCapacity,
  projectCapacityAtSecs,
  type LimiterConfig,
  type LimiterState,
} from '../hashi/limiter.js';
import type { HashiEvent, SatsSource } from '../hashi/types.js';
import type { LimiterSample, Millis, Sats } from '../types.js';

/**
 * ★ G5 — ONE implementation, no drift. `verify/` and `hashi/mock.ts` share EXACTLY these functions.
 * Re-exported (rather than re-implemented) so any future edit lands in a single file.
 */
export { consume, genesis, msToSecs, projectCapacity, projectCapacityAtSecs };
export type { LimiterConfig, LimiterState };

export interface DeriveConfig {
  /** The two trust anchors — the ONLY inputs not derived from on-chain events. */
  readonly limiter: LimiterConfig;
  /** Start state. Defaults to `genesis(cfg.limiter)`: full bucket, last=0s, next_seq=0. */
  readonly genesisState?: LimiterState;
}

/** One event boundary of the replay. */
export interface LimiterBoundary extends LimiterSample {
  /** Event-log seq of the `WithdrawalSigned` that produced this boundary. */
  readonly eventSeq: bigint;
  /** Sats debited at this boundary (the joined REQUESTED total). */
  readonly debitedSats: Sats;
  /** How the debit amount was resolved. 'unresolved' ⇒ do not trust this boundary. */
  readonly satsSource: SatsSource;
  /** Set when the guardian would have REJECTED the batch (G3: rejected, never queued). */
  readonly rejected?: 'RateLimitExceeded' | 'InvalidInputs';
}

export interface LimiterTrajectory {
  readonly samples: readonly LimiterBoundary[];
  /** Bucket state after the last event. */
  readonly final: LimiterState;
  /** Count of boundaries whose amount could not be joined — the replay is incomplete there. */
  readonly unresolvedCount: number;
  /** Batches the algorithm says would have been rejected (G3). */
  readonly rejectedCount: number;
}

/**
 * Build the `requestId → btc_amount` index from the `WithdrawalRequested` stream.
 * Must run BEFORE walking `Signed` events — those carry no amount (E-K3).
 */
// TODO(T4.3): fold WithdrawalRequested into a Map<requestId, sats>; keep Picked as a fallback map.
export function indexRequestedSats(_events: readonly HashiEvent[]): ReadonlyMap<string, Sats> {
  throw new Error('TODO(T4.3): indexRequestedSats not implemented');
}

/**
 * Re-derive the ENTIRE Guardian bucket trajectory + global queue depth from on-chain events.
 *
 * PURE. Walks the seq-ordered stream, refilling via `projectCapacityAtSecs` and debiting on each
 * `WithdrawalSigned` (joined amount, envelope timestamp floored to seconds), emitting one sample per
 * boundary. This is the trustless replay the whole G5 claim rests on.
 */
// TODO(T4.3): index requested sats; walk events in seq order; use consume() from ../hashi/limiter.js
//             for every debit; track queueDepth = ΣRequested − Σ(Signed|Cancelled); mark
//             'unresolved' boundaries and rejections instead of silently continuing.
export function deriveLimiter(
  _events: readonly HashiEvent[],
  _cfg: DeriveConfig,
): LimiterTrajectory {
  throw new Error('TODO(T4.3): deriveLimiter not implemented');
}

/**
 * Project the trajectory to an arbitrary instant BETWEEN boundaries (refill only, no debit).
 * This is what `strategy.evaluate()` consumes as its `limiter` input — never the SDK hint.
 */
// TODO(T4.3): find the last boundary <= atMs, then projectCapacityAtSecs to msToSecs(atMs).
export function limiterAt(
  _trajectory: LimiterTrajectory,
  _atMs: Millis,
  _cfg: DeriveConfig,
): LimiterSample {
  throw new Error('TODO(T4.3): limiterAt not implemented');
}
