// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line — but this is the STRONGEST claim in the project)
// @status     DONE
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
// @facts      ⚠ The seq handed to `consume` is `state.nextSeq`, exactly as the guardian does. In a
// @facts        well-formed stream that is IDENTICAL to the index in the `WithdrawalSigned` sub-stream
// @facts        (a REJECTED batch emits no event, so the stream is gap-free — G3); using the state's
// @facts        own counter simply avoids a spurious InvalidInputs cascade after a divergence.
// @implements export { consume, genesis, msToSecs, projectCapacity, projectCapacityAtSecs }  // re-export, G5
// @implements export interface DeriveConfig / LimiterTrajectory / LimiterBoundary / QueueSample
// @implements export function indexRequestedSats(events: readonly HashiEvent[]): ReadonlyMap<string, Sats>
// @implements export function indexPickedSats(events: readonly HashiEvent[]): ReadonlyMap<string, Sats>
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
import type { LimiterSample, Millis, Sats, Secs } from '../types.js';
import { satAdd, satSub } from '../util/bigint.js';

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
  /**
   * Bucket state AFTER this boundary. Carried so {@link limiterAt} can project forward exactly:
   * a REJECTED boundary leaves `lastUpdatedAtSecs` behind `atSecs`, and reconstructing the state
   * from `(tokens, atSecs)` alone would silently swallow the refill that is still owed.
   */
  readonly state: LimiterState;
  /** Capacity at `atSecs` BEFORE the debit (the clamp-before-debit value). */
  readonly capacityBeforeDebitSats: Sats;
  /** `request_ids` that could not be joined to any amount. Non-empty ⇒ `satsSource: 'unresolved'`. */
  readonly unresolvedRequestIds?: readonly string[];
}

/** One change of the GLOBAL queue depth: Σ Requested − Σ (Signed | Cancelled). */
export interface QueueSample {
  readonly eventSeq: bigint;
  readonly atMs: Millis;
  readonly atSecs: Secs;
  readonly kind: 'WithdrawalRequested' | 'WithdrawalSigned' | 'WithdrawalCancelled';
  /** Signed delta applied at this event (positive on Requested, negative otherwise). */
  readonly deltaSats: bigint;
  /** Depth AFTER applying the delta, clamped at 0 (a counter never goes negative). */
  readonly queueDepth: Sats;
}

export interface LimiterTrajectory {
  readonly samples: readonly LimiterBoundary[];
  /** Bucket state after the last event. */
  readonly final: LimiterState;
  /** Count of boundaries whose amount could not be joined — the replay is incomplete there. */
  readonly unresolvedCount: number;
  /** Batches the algorithm says would have been rejected (G3). */
  readonly rejectedCount: number;
  /** Queue-depth trace, one entry per Requested/Signed/Cancelled event. */
  readonly queue: readonly QueueSample[];
  /** Queue depth after the last event. */
  readonly finalQueueDepth: Sats;
  /** The trust anchors this trajectory was derived under — carried so it is self-describing. */
  readonly cfg: DeriveConfig;
}

/**
 * Build the `requestId → btc_amount` index from the `WithdrawalRequested` stream.
 * Must run BEFORE walking `Signed` events — those carry no amount (E-K3).
 *
 * This is the AUTHORITATIVE amount: the bucket is debited by the REQUESTED sats, not by the
 * `WithdrawalPickedForProcessing` output (which is net of the Bitcoin network fee).
 */
export function indexRequestedSats(events: readonly HashiEvent[]): ReadonlyMap<string, Sats> {
  const index = new Map<string, Sats>();
  for (const event of events) {
    if (event.kind !== 'WithdrawalRequested') continue;
    // First writer wins: request ids are unique on-chain, and a duplicate would mean a
    // re-org/duplicated page — never silently take the later (possibly different) amount.
    if (!index.has(event.requestId)) index.set(event.requestId, event.sats);
  }
  return index;
}

/**
 * FALLBACK index only (E-K3): `requestId → WithdrawalPickedForProcessing.outputs[i].amount`,
 * paired POSITIONALLY with `requestIds[i]`. These amounts are NET of the Bitcoin network fee, so
 * they are used only when the matching `WithdrawalRequested` has aged out of the fetched window.
 */
export function indexPickedSats(events: readonly HashiEvent[]): ReadonlyMap<string, Sats> {
  const index = new Map<string, Sats>();
  for (const event of events) {
    if (event.kind !== 'WithdrawalPickedForProcessing') continue;
    for (let i = 0; i < event.requestIds.length; i++) {
      const requestId = event.requestIds[i];
      const output = event.outputs[i];
      if (requestId === undefined || output === undefined) continue;
      if (!index.has(requestId)) index.set(requestId, output.sats);
    }
  }
  return index;
}

interface Resolved {
  readonly sats: Sats;
  readonly source: SatsSource;
  readonly missing: readonly string[];
}

/**
 * Join one `WithdrawalSigned` to its debit amount. Requested wins, Picked is the fallback, and a
 * request id present in neither makes the whole boundary 'unresolved' (invariant 3) — we then fall
 * back to whatever amount the normalizer carried on the event rather than under-debiting silently.
 */
function resolveDebit(
  requestIds: readonly string[],
  carriedSats: Sats,
  requested: ReadonlyMap<string, Sats>,
  picked: ReadonlyMap<string, Sats>,
): Resolved {
  const missing: string[] = [];
  let total = 0n;
  let usedPicked = false;

  for (const requestId of requestIds) {
    const fromRequested = requested.get(requestId);
    if (fromRequested !== undefined) {
      total = satAdd(total, fromRequested);
      continue;
    }
    const fromPicked = picked.get(requestId);
    if (fromPicked !== undefined) {
      total = satAdd(total, fromPicked);
      usedPicked = true;
      continue;
    }
    missing.push(requestId);
  }

  if (missing.length > 0 || requestIds.length === 0) {
    return { sats: carriedSats, source: 'unresolved', missing };
  }
  return { sats: total, source: usedPicked ? 'picked' : 'requested', missing: [] };
}

/** Seq-order a slice without mutating the caller's array (invariant 1/4). */
function seqOrdered(events: readonly HashiEvent[]): readonly HashiEvent[] {
  return [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

/**
 * Re-derive the ENTIRE Guardian bucket trajectory + global queue depth from on-chain events.
 *
 * PURE. Walks the seq-ordered stream, refilling via `projectCapacityAtSecs` and debiting on each
 * `WithdrawalSigned` (joined amount, envelope timestamp floored to seconds), emitting one sample per
 * boundary. This is the trustless replay the whole G5 claim rests on.
 */
export function deriveLimiter(
  events: readonly HashiEvent[],
  cfg: DeriveConfig,
): LimiterTrajectory {
  const ordered = seqOrdered(events);
  const requested = indexRequestedSats(ordered);
  const picked = indexPickedSats(ordered);

  let state: LimiterState = cfg.genesisState ?? genesis(cfg.limiter);
  let queueDepth: Sats = 0n;

  const samples: LimiterBoundary[] = [];
  const queue: QueueSample[] = [];
  let unresolvedCount = 0;
  let rejectedCount = 0;

  function pushQueue(
    event: HashiEvent,
    kind: QueueSample['kind'],
    deltaSats: bigint,
  ): void {
    queueDepth = deltaSats >= 0n ? satAdd(queueDepth, deltaSats) : satSub(queueDepth, -deltaSats);
    queue.push({
      eventSeq: event.seq,
      atMs: event.atMs,
      atSecs: event.atSecs,
      kind,
      deltaSats,
      queueDepth,
    });
  }

  for (const event of ordered) {
    if (event.kind === 'WithdrawalRequested') {
      pushQueue(event, 'WithdrawalRequested', event.sats);
      continue;
    }

    if (event.kind === 'WithdrawalCancelled') {
      pushQueue(event, 'WithdrawalCancelled', -event.sats);
      continue;
    }

    if (event.kind !== 'WithdrawalSigned') continue;

    // ── ★ the bucket-advancing boundary ──────────────────────────────────────
    const debit = resolveDebit(event.requestIds, event.sats, requested, picked);
    if (debit.source === 'unresolved') unresolvedCount++;

    const capacityBeforeDebitSats = projectCapacityAtSecs(cfg.limiter, state, event.atSecs);
    // seq = the guardian's own counter; ts = the ENVELOPE second (already floored by normalize).
    const result = consume(cfg.limiter, state, state.nextSeq, event.atSecs, debit.sats);

    if (result.ok) {
      state = result.state;
      // The queue only clears for a batch the guardian actually signed.
      pushQueue(event, 'WithdrawalSigned', -debit.sats);
    } else {
      // G3: an over-capacity batch is REJECTED and the bucket is left EXACTLY as it was.
      rejectedCount++;
    }

    samples.push({
      eventSeq: event.seq,
      atMs: event.atMs,
      atSecs: event.atSecs,
      // Available capacity AT that instant: after an accepted debit this equals the stored
      // balance; after a rejection it is the (unspent, still refilling) projected capacity.
      tokens: projectCapacityAtSecs(cfg.limiter, state, event.atSecs),
      queueDepth,
      debitedSats: debit.sats,
      satsSource: debit.source,
      state,
      capacityBeforeDebitSats,
      ...(result.ok ? {} : { rejected: result.error }),
      ...(debit.missing.length === 0 ? {} : { unresolvedRequestIds: debit.missing }),
    });
  }

  return {
    samples,
    final: state,
    unresolvedCount,
    rejectedCount,
    queue,
    finalQueueDepth: queueDepth,
    cfg,
  };
}

/**
 * Project the trajectory to an arbitrary instant BETWEEN boundaries (refill only, no debit).
 * This is what `strategy.evaluate()` consumes as its `limiter` input — never the SDK hint.
 */
export function limiterAt(
  trajectory: LimiterTrajectory,
  atMs: Millis,
  cfg: DeriveConfig,
): LimiterSample {
  const atSecs = msToSecs(atMs);

  let state: LimiterState = cfg.genesisState ?? genesis(cfg.limiter);
  for (const sample of trajectory.samples) {
    if (sample.atMs > atMs) break;
    state = sample.state;
  }

  let queueDepth: Sats = 0n;
  for (const entry of trajectory.queue) {
    if (entry.atMs > atMs) break;
    queueDepth = entry.queueDepth;
  }

  return {
    atMs,
    atSecs,
    tokens: projectCapacityAtSecs(cfg.limiter, state, atSecs),
    queueDepth,
  };
}
