// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/RECON.md#r9 (Guardian limiter — EXACT Rust algorithm + golden vectors)
// @spec       docs/KEEPER.md §2.4 (canonical `projectCapacity` arg order), §9.2 (verify/ imports THIS)
// @spec       docs/GOLDEN-RULES.md#g5
// @rules      G3 G5 G7
// @depends    ../util/bigint.ts (saturating u64) · ../config.ts (LimiterConfig)
// @facts      ★ TIME BASE IS UNIX **SECONDS**. `refill_rate` is sats/SECOND, `last_updated_at`
// @facts        is seconds. Sui `Clock` is ms ⇒ divide by 1000 at the boundary (msToSecs).
// @facts      project_capacity(cfg, state, ts) =
// @facts        min(cap, state.tokens SAT+ (ts SAT- state.last) SAT* cfg.refill_rate)
// @facts      consume(seq, ts, amount):
// @facts        seq != next_seq            -> InvalidInputs
// @facts        ts  <  last_updated_at     -> InvalidInputs
// @facts        capacity < amount          -> RateLimitExceeded   (REJECTED, NEVER queued — G3)
// @facts        else tokens = capacity - amount ; last = ts ; next_seq += 1   (CLAMP BEFORE DEBIT)
// @facts      genesis = { tokens: max_bucket_capacity, last_updated_at: 0, next_seq: 0 }
// @facts      Rust SATURATES (saturating_add / saturating_mul); Move u64 ABORTS ⇒ Move must
// @facts        emulate saturation explicitly, and TS must use bigint + util/bigint helpers.
// @facts      Trust anchors: ONLY the two genesis scalars (refill_rate, max_bucket_capacity).
// @facts        Live testnet values are UNPUBLISHED (U1) — the config defaults are a BOUND,
// @facts        not a fact (docs/RECON.md R9, docs/FACTS.md#unknowns).
// @facts      ⚠ ERRATUM vs docs/RECON.md R9 golden-vector TABLE: rows #1 and #7 print
// @facts        `105_000` where the stated algorithm yields `100_150`
// @facts        (100_000 + 15 s x 10 sats/s). The ALGORITHM (verbatim Rust, also present at
// @facts        .hashi_src/crates__hashi-types__src__guardian__limiter.rs) is authoritative;
// @facts        the table's arithmetic is not. test/limiter.golden.test.ts encodes the
// @facts        algorithm's values and names the erratum. Rows #2–#6 are correct as printed.
// @implements export interface LimiterState
// @implements export function genesis(cfg: LimiterConfig): LimiterState
// @implements export function msToSecs(ms: number): Secs
// @implements export function projectCapacityAtSecs(cfg: LimiterConfig, state: LimiterState, tsSecs: Secs): Sats
// @implements export function projectCapacity(tokens: Sats, refillRate: Sats, cap: Sats, elapsedMs: number): Sats
// @implements export function consume(cfg: LimiterConfig, state: LimiterState, seq: bigint, tsSecs: Secs, amountSats: Sats): ConsumeResult
// @implements export function consumeOrThrow(cfg, state, seq, tsSecs, amountSats): LimiterState
// @forbidden  reading the limiter from `@mysten/hashi`'s guardian.* — that is an UNVERIFIED HINT.
//             The authoritative bucket is THIS function replayed over on-chain WithdrawalSigned (G5).
// @forbidden  a SECOND copy of this algorithm anywhere. hashi/mock.ts AND verify/ import THIS module.
// @forbidden  queueing an over-capacity batch — it is REJECTED (G3)
// @invariant  1. Pure: no clock, no I/O, no mutation of the input state.
// @invariant  2. Every arithmetic op saturates into [0, u64::MAX] — never throws on overflow.
// @invariant  3. Capacity is clamped to `cap` BEFORE the debit (clamp-before-debit).
// @invariant  4. On any error the caller's state is returned untouched (the batch is rejected whole).
// @ac         docs/KEEPER.md §13 A2 — mock.limiterStatus() === replay of its own signed stream
// @verify     npm test -- limiter.golden
// @verify     npm test -- limiter.consume
// @verify     npm test -- limiter.cross
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { LimiterConfig } from '../config.js';
import type { Sats, Secs } from '../types.js';
import { satAdd, satMin, satMul, satSub } from '../util/bigint.js';
import { InvalidInputsError, RateLimitExceededError } from '../util/errors.js';

export type { LimiterConfig };

/**
 * Serializable token-bucket state. Field names match `@mysten/hashi`'s
 * `GuardianLimiterState` so the shapes are interchangeable WITHOUT importing the SDK (G7).
 */
export interface LimiterState {
  /** Available tokens in sats. */
  readonly numTokensAvailableSats: Sats;
  /** Last refill timestamp, unix SECONDS. */
  readonly lastUpdatedAtSecs: Secs;
  /** Next expected withdrawal sequence number. */
  readonly nextSeq: bigint;
}

export type LimiterErrorCode = 'InvalidInputs' | 'RateLimitExceeded';

export interface ConsumeOk {
  readonly ok: true;
  /** The NEXT state. The input state is never mutated. */
  readonly state: LimiterState;
  /** Capacity at `tsSecs` BEFORE the debit. */
  readonly capacitySats: Sats;
}

export interface ConsumeErr {
  readonly ok: false;
  readonly error: LimiterErrorCode;
  readonly reason: string;
  /** Capacity at `tsSecs` (0n when the inputs were rejected before projection). */
  readonly capacitySats: Sats;
}

export type ConsumeResult = ConsumeOk | ConsumeErr;

/**
 * Genesis state for a freshly bootstrapped enclave: a FULL bucket, no consumes yet,
 * no refill timestamp. Verbatim `LimiterState::genesis` (docs/RECON.md R9).
 */
export function genesis(cfg: LimiterConfig): LimiterState {
  return {
    numTokensAvailableSats: cfg.maxBucketCapacitySats,
    lastUpdatedAtSecs: 0n,
    nextSeq: 0n,
  };
}

/**
 * THE ONLY sanctioned ms -> s conversion in the keeper.
 *
 * Sui `Clock` and every Hashi event envelope are milliseconds; the Guardian limiter is
 * unix SECONDS. Truncating (flooring) here is what makes the TS replay agree with the
 * Rust enclave — round-half-up or ceil would drift by up to one refill tick per event.
 */
export function msToSecs(ms: number): Secs {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`msToSecs requires a finite number of milliseconds, got ${ms}`);
  }
  if (ms <= 0) return 0n;
  return BigInt(Math.floor(ms / 1000));
}

/**
 * Seconds-native, exact mirror of the Rust guardian:
 *
 *     let elapsed  = ts.saturating_sub(state.last_updated_at);
 *     let refilled = elapsed.saturating_mul(cfg.refill_rate);
 *     state.num_tokens_available.saturating_add(refilled).min(cfg.max_bucket_capacity)
 *
 * A `tsSecs` at or before `lastUpdatedAtSecs` yields the stored balance (elapsed saturates to 0).
 */
export function projectCapacityAtSecs(cfg: LimiterConfig, state: LimiterState, tsSecs: Secs): Sats {
  const elapsed = satSub(tsSecs, state.lastUpdatedAtSecs);
  const refilled = satMul(elapsed, cfg.refillRateSatsPerSec);
  return satMin(satAdd(state.numTokensAvailableSats, refilled), cfg.maxBucketCapacitySats);
}

/**
 * ★ CANONICAL ARGUMENT ORDER, mandated by docs/KEEPER.md §2.4 and G5:
 * `projectCapacity(tokens, refillRate, cap, elapsedMs)`.
 *
 * `elapsedMs` is a DURATION in milliseconds (not a timestamp); it is floored to whole
 * seconds via {@link msToSecs} to match the on-chain/enclave granularity exactly.
 *
 * This is the function `hashi/mock.ts` and `verify/limiter.ts` MUST both import — one
 * implementation, no drift (G5).
 */
export function projectCapacity(tokens: Sats, refillRate: Sats, cap: Sats, elapsedMs: number): Sats {
  return projectCapacityAtSecs(
    { refillRateSatsPerSec: refillRate, maxBucketCapacitySats: cap },
    { numTokensAvailableSats: tokens, lastUpdatedAtSecs: 0n, nextSeq: 0n },
    msToSecs(elapsedMs),
  );
}

/**
 * Pure token-bucket consume. Returns the NEXT state, or a typed rejection.
 *
 * G3: an over-capacity batch is **REJECTED** (`RateLimitExceeded`) — it is NOT queued and it
 * does NOT partially debit. On any error the bucket is left exactly as it was, so a caller
 * that drops the whole batch stays bit-identical to a replay of the emitted event stream.
 */
export function consume(
  cfg: LimiterConfig,
  state: LimiterState,
  seq: bigint,
  tsSecs: Secs,
  amountSats: Sats,
): ConsumeResult {
  if (seq !== state.nextSeq) {
    return {
      ok: false,
      error: 'InvalidInputs',
      reason: `seq mismatch: expected ${state.nextSeq}, got ${seq}`,
      capacitySats: 0n,
    };
  }
  if (tsSecs < state.lastUpdatedAtSecs) {
    return {
      ok: false,
      error: 'InvalidInputs',
      reason: `timestamp ${tsSecs} < last_updated_at ${state.lastUpdatedAtSecs}`,
      capacitySats: 0n,
    };
  }

  // Refill, then CLAMP to the bucket ceiling — before any debit.
  const capacitySats = projectCapacityAtSecs(cfg, state, tsSecs);

  if (capacitySats < amountSats) {
    return {
      ok: false,
      error: 'RateLimitExceeded',
      reason: `capacity ${capacitySats} < amount ${amountSats}`,
      capacitySats,
    };
  }

  return {
    ok: true,
    capacitySats,
    state: {
      numTokensAvailableSats: capacitySats - amountSats,
      lastUpdatedAtSecs: tsSecs,
      nextSeq: state.nextSeq + 1n,
    },
  };
}

/** {@link consume}, raising the mirrored Guardian errors instead of returning a result. */
export function consumeOrThrow(
  cfg: LimiterConfig,
  state: LimiterState,
  seq: bigint,
  tsSecs: Secs,
  amountSats: Sats,
): LimiterState {
  const result = consume(cfg, state, seq, tsSecs, amountSats);
  if (result.ok) return result.state;
  if (result.error === 'RateLimitExceeded') {
    throw new RateLimitExceededError(amountSats, result.capacitySats);
  }
  throw new InvalidInputsError(result.reason);
}
