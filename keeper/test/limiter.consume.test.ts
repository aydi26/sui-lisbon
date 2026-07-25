// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/RECON.md#r9 (consume semantics), docs/GOLDEN-RULES.md#g3
// @rules      G3 G5
// @depends    ../src/hashi/limiter.ts (T0.5) · ../src/util/errors.ts
// @facts      consume order of checks: seq -> timestamp -> project(+clamp) -> compare -> debit.
// @facts      CLAMP BEFORE DEBIT: capacity is min(cap, tokens + elapsed*rate) BEFORE subtracting.
// @facts      Over-capacity is REJECTED (RateLimitExceeded) and leaves the bucket UNTOUCHED (G3).
// @implements seq mismatch · stale timestamp · RateLimitExceeded · clamp-before-debit · genesis
// @invariant  1. A rejected consume never mutates or advances anything.
// @verify     npm test -- limiter.consume
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  consume,
  consumeOrThrow,
  genesis,
  msToSecs,
  projectCapacityAtSecs,
  type LimiterConfig,
  type LimiterState,
} from '../src/hashi/limiter.js';
import { InvalidInputsError, RateLimitExceededError } from '../src/util/errors.js';

const CFG: LimiterConfig = { refillRateSatsPerSec: 1_000n, maxBucketCapacitySats: 100_000n };

describe('hashi/limiter — consume()', () => {
  it('genesis() is a FULL bucket at t=0 with next_seq 0', () => {
    expect(genesis(CFG)).toEqual({
      numTokensAvailableSats: CFG.maxBucketCapacitySats,
      lastUpdatedAtSecs: 0n,
      nextSeq: 0n,
    });
  });

  it('rejects a seq mismatch with InvalidInputs and leaves the state untouched', () => {
    const before: LimiterState = { numTokensAvailableSats: 50_000n, lastUpdatedAtSecs: 10n, nextSeq: 5n };
    const result = consume(CFG, before, 6n, 20n, 1_000n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('InvalidInputs');
    // The caller's state object is unchanged (the function is pure).
    expect(before).toEqual({ numTokensAvailableSats: 50_000n, lastUpdatedAtSecs: 10n, nextSeq: 5n });
  });

  it('rejects a stale timestamp (ts < last_updated_at) with InvalidInputs', () => {
    const before: LimiterState = { numTokensAvailableSats: 50_000n, lastUpdatedAtSecs: 100n, nextSeq: 5n };
    const result = consume(CFG, before, 5n, 99n, 1n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('InvalidInputs');
    expect(result.reason).toContain('99');
  });

  it('accepts ts === last_updated_at (elapsed 0) — only STRICTLY earlier is invalid', () => {
    const before: LimiterState = { numTokensAvailableSats: 50_000n, lastUpdatedAtSecs: 100n, nextSeq: 5n };
    const result = consume(CFG, before, 5n, 100n, 50_000n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.numTokensAvailableSats).toBe(0n);
  });

  it('REJECTS an over-capacity batch (G3: rejected, never queued) and does not partially debit', () => {
    const before: LimiterState = { numTokensAvailableSats: 10_000n, lastUpdatedAtSecs: 0n, nextSeq: 0n };
    const result = consume(CFG, before, 0n, 0n, 10_001n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('RateLimitExceeded');
    expect(result.capacitySats).toBe(10_000n);
    expect(before.numTokensAvailableSats).toBe(10_000n);
    expect(before.nextSeq).toBe(0n);
  });

  it('CLAMPS BEFORE DEBIT — a huge elapsed refills only up to the cap, then subtracts', () => {
    const before: LimiterState = { numTokensAvailableSats: 50_000n, lastUpdatedAtSecs: 0n, nextSeq: 0n };
    // Raw refill would be 1_000_000 * 1_000 = 1e9 sats; the bucket ceiling is 100_000.
    expect(projectCapacityAtSecs(CFG, before, 1_000_000n)).toBe(100_000n);
    const result = consume(CFG, before, 0n, 1_000_000n, 40_000n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 100_000 (clamped) - 40_000 = 60_000. Debit-before-clamp would give a wildly larger number.
    expect(result.state.numTokensAvailableSats).toBe(60_000n);
    expect(result.state.lastUpdatedAtSecs).toBe(1_000_000n);
    expect(result.state.nextSeq).toBe(1n);
  });

  it('advances next_seq by exactly 1 per successful consume (no gaps ⇒ replay can assign seq = index)', () => {
    let s = genesis(CFG);
    for (let i = 0n; i < 5n; i++) {
      const result = consume(CFG, s, i, i, 1_000n);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      s = result.state;
    }
    expect(s.nextSeq).toBe(5n);
  });

  it('consumeOrThrow raises the mirrored Guardian errors', () => {
    const s: LimiterState = { numTokensAvailableSats: 1n, lastUpdatedAtSecs: 0n, nextSeq: 0n };
    expect(() => consumeOrThrow(CFG, s, 0n, 0n, 2n)).toThrow(RateLimitExceededError);
    expect(() => consumeOrThrow(CFG, s, 9n, 0n, 1n)).toThrow(InvalidInputsError);
    expect(consumeOrThrow(CFG, s, 0n, 0n, 1n).numTokensAvailableSats).toBe(0n);
  });

  it('msToSecs floors and clamps at zero — the ONLY sanctioned ms->s conversion', () => {
    expect(msToSecs(0)).toBe(0n);
    expect(msToSecs(999)).toBe(0n);
    expect(msToSecs(1_000)).toBe(1n);
    expect(msToSecs(15_999)).toBe(15n);
    expect(msToSecs(-5_000)).toBe(0n);
    expect(() => msToSecs(Number.NaN)).toThrow(RangeError);
  });
});
