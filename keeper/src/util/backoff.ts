// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.keeper.backoff
// @phase      1
// @status     DONE
// @spec       aphotic.md §9 ("Fail-soft. Exponential backoff, no crash on transient errors, and
//             specifically no crash across Hashi reconfiguration windows when withdrawals are
//             paused")
// @spec       aphotic.md §4.6 ("Withdrawals pause during reconfiguration, triggered at each Sui
//             epoch boundary (24 h)")
// @rules      G3 G5
// @depends    ./errors.ts · ./rng.ts (SEEDED jitter — never Math.random)
// @facts      ★ A RECONFIGURATION WINDOW IS NOT AN ERROR. Hashi pauses withdrawals at every Sui
// @facts        epoch boundary. A keeper that exits on `EPaused` / `RateLimitExceeded` is a keeper
// @facts        that is down for the most interesting hour of the day. Those two are classified
// @facts        `paused`, which retries FOREVER, never exhausting attempts.
// @facts      ★ G3 — `RateLimitExceeded` is a REJECTION, not a queue position. Retrying is correct
// @facts        (capacity refills); "retrying harder" buys nothing, so the delay still backs off.
// @facts      Classification (the ONLY three outcomes):
// @facts        'fatal'     — a programming/config error. Rethrown immediately, never retried.
// @facts        'transient' — network/5xx/timeout. Retried up to `maxAttempts`.
// @facts        'paused'    — bridge reconfiguration or limiter rejection. Retried WITHOUT limit,
// @facts                      capped at `maxDelayMs`, until `deadlineMs`.
// @facts      Delay = min(maxDelayMs, baseDelayMs · 2^(attempt-1)) ± jitter, jitter drawn from the
// @facts        SEEDED SplitMix64 in ./rng.ts so a replayed run reproduces the exact schedule.
// @facts      `sleep` is INJECTED. Nothing here reads a clock or opens a timer of its own, so the
// @facts        whole suite runs on a logical clock with no wall-time cost.
// @implements export type FailureClass = 'fatal' | 'transient' | 'paused'
// @implements export interface BackoffPolicy / RetryContext / RetryDeps / Attempt
// @implements export const DEFAULT_BACKOFF: BackoffPolicy
// @implements export const PAUSE_CODES: readonly string[]
// @implements export function classify(error: unknown): FailureClass
// @implements export function delayForAttempt(policy: BackoffPolicy, attempt: number, jitter: bigint): number
// @implements export async function withRetry<T>(fn, opts): Promise<T>
// @forbidden  Math.random() for the jitter — the schedule must be reproducible
// @forbidden  exiting the process on a 'paused' classification (aphotic.md §9)
// @forbidden  swallowing a 'fatal' error into a retry loop — a config bug must surface at once
// @invariant  1. classify is TOTAL: every value maps to exactly one of the three classes.
// @invariant  2. delayForAttempt is monotone non-decreasing in `attempt` and never exceeds
//                `maxDelayMs + policy.jitterMs`.
// @invariant  3. A 'paused' failure never exhausts `maxAttempts`; only `deadlineMs` stops it.
// @invariant  4. withRetry with the same seed produces the identical delay sequence.
// @ac         test/backoff.test.ts
// @verify     npm run test -- backoff
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { AphoticError, ConfigError, RateLimitExceededError } from './errors.js';
import { createRng, type Rng } from './rng.js';

/** How a failure is treated. Exactly three outcomes — see the banner. */
export type FailureClass = 'fatal' | 'transient' | 'paused';

/**
 * Error codes that mean "the bridge is not accepting work right now".
 *
 * `RateLimitExceeded` is here deliberately: G3 says an over-capacity batch is REJECTED rather
 * than queued, so the only correct response is to wait for the bucket to refill — which is a
 * pause, not a failure.
 */
export const PAUSE_CODES: readonly string[] = Object.freeze([
  'RateLimitExceeded',
  'EPaused',
  'EVersionNotEnabled',
  'HashiPaused',
  'Reconfiguration',
  'ReconfigurationInProgress',
  'NotReady',
]);

/** Codes that are our own bug or our own misconfiguration. Never retried. */
const FATAL_CODES: readonly string[] = Object.freeze([
  'ConfigError',
  'NotImplemented',
  'EBelowMinimumWithdrawal',
  'EBelowMinimumDeposit',
  'EInvalidBitcoinAddress',
  'EUnauthorizedCancellation',
  'BadLevel2Decode',
  'ClearingParityMismatch',
  'PreflightRevert',
]);

export interface BackoffPolicy {
  /** First delay, in ms. */
  readonly baseDelayMs: number;
  /** Ceiling for the exponential term. */
  readonly maxDelayMs: number;
  /** Attempts allowed for a 'transient' failure. A 'paused' failure ignores this (invariant 3). */
  readonly maxAttempts: number;
  /** Full width of the additive jitter window, in ms. 0 disables jitter. */
  readonly jitterMs: number;
}

/**
 * 30 s base doubling to 15 min. The upper bound is deliberately larger than one Hashi
 * reconfiguration window: the keeper must idle politely through it, not hammer it.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseDelayMs: 30_000,
  maxDelayMs: 900_000,
  maxAttempts: 8,
  jitterMs: 5_000,
});

export interface Attempt {
  /** 1-based. */
  readonly attempt: number;
  readonly classification: FailureClass;
  readonly delayMs: number;
  readonly code: string;
  readonly message: string;
}

export interface RetryDeps {
  /** Injected so tests advance a LOGICAL clock and the suite never actually waits. */
  sleep(ms: number): Promise<void>;
  /** Injected logical "now" for the deadline check. Also never a wall clock in tests. */
  now(): number;
}

export interface RetryContext {
  /** Names the operation in errors and in the attempt log. */
  readonly what: string;
  readonly policy?: BackoffPolicy;
  readonly deps: RetryDeps;
  /** Seed for the jitter stream. Same seed ⇒ same schedule (invariant 4). */
  readonly seed?: string;
  /** Absolute ms epoch after which even a 'paused' failure gives up. */
  readonly deadlineMs?: number;
  /** Observability hook. Called once per failed attempt, before sleeping. */
  readonly onAttempt?: (a: Attempt) => void;
}

function codeOf(error: unknown): string {
  if (error instanceof AphoticError) return error.code;
  // Read `code` off the widened shape rather than re-asserting on `Error`:
  // `Error` has no `code`, so a direct cast is a type error, and narrowing it
  // twice is what makes the intent obvious — we are probing a duck-typed field
  // that Node's own errors carry but the DOM lexicon does not.
  const code = (error as { code?: unknown }).code;
  if (error instanceof Error && typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'Unknown';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Total classification of any thrown value (invariant 1).
 *
 * The message is consulted only as a fallback: upstream SDK errors carry no stable `code`, and
 * "the guardian is reconfiguring" arriving as a plain `Error` must still not kill the keeper.
 */
export function classify(error: unknown): FailureClass {
  if (error instanceof ConfigError) return 'fatal';
  if (error instanceof RateLimitExceededError) return 'paused';

  const code = codeOf(error);
  if (PAUSE_CODES.includes(code)) return 'paused';
  if (FATAL_CODES.includes(code)) return 'fatal';

  const text = messageOf(error).toLowerCase();
  if (
    text.includes('reconfigur') ||
    text.includes('withdrawals are paused') ||
    text.includes('bridge is paused') ||
    text.includes('rate limit')
  ) {
    return 'paused';
  }
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
    return 'fatal';
  }
  return 'transient';
}

/**
 * `min(maxDelayMs, baseDelayMs · 2^(attempt-1))` plus `jitter` ms.
 *
 * `jitter` is supplied by the caller (drawn from the seeded RNG) rather than sampled here, so
 * this function stays pure and the schedule is exactly reproducible.
 */
export function delayForAttempt(policy: BackoffPolicy, attempt: number, jitter: bigint): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`delayForAttempt requires attempt >= 1, got ${attempt}`);
  }
  // Cap the exponent before shifting so a long-lived pause cannot overflow into Infinity.
  const shift = Math.min(attempt - 1, 40);
  const raw = policy.baseDelayMs * 2 ** shift;
  const capped = Math.min(policy.maxDelayMs, raw);
  return capped + Number(jitter);
}

function drawJitter(rng: Rng, policy: BackoffPolicy): bigint {
  if (policy.jitterMs <= 0) return 0n;
  return rng.nextBelow(BigInt(Math.trunc(policy.jitterMs)) + 1n);
}

/**
 * Run `fn`, retrying per the classification of whatever it throws.
 *
 * Fail-soft, precisely: a 'transient' failure is retried `maxAttempts` times and then rethrown;
 * a 'paused' failure is retried without an attempt limit until `deadlineMs` (default: never), so
 * a Hashi reconfiguration window can never take the keeper down (aphotic.md §9).
 */
export async function withRetry<T>(fn: () => Promise<T>, ctx: RetryContext): Promise<T> {
  const policy = ctx.policy ?? DEFAULT_BACKOFF;
  const rng = createRng(ctx.seed ?? ctx.what);
  let transientAttempts = 0;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const classification = classify(error);
      if (classification === 'fatal') throw error;

      attempt += 1;
      if (classification === 'transient') {
        transientAttempts += 1;
        if (transientAttempts >= policy.maxAttempts) throw error;
      }

      const delayMs = delayForAttempt(policy, attempt, drawJitter(rng, policy));

      if (ctx.deadlineMs !== undefined && ctx.deps.now() + delayMs > ctx.deadlineMs) {
        throw error;
      }

      ctx.onAttempt?.({
        attempt,
        classification,
        delayMs,
        code: codeOf(error),
        message: messageOf(error),
      });

      await ctx.deps.sleep(delayMs);
    }
  }
}
