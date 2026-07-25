// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/RECON.md#r9 (golden vectors 1–7 + the verbatim Rust algorithm)
// @spec       docs/KEEPER.md §2.4 (canonical projectCapacity arg order)
// @rules      G3 G5
// @depends    ../src/hashi/limiter.ts (T0.5)
// @facts      These SAME vectors are shared with move/tests/envelope_tests.move — if you change a
// @facts        number here, change it there (docs/RECON.md R9 "Golden vectors").
// @facts      ⚠ ERRATUM — docs/RECON.md R9 rows #1 and #7 print `105_000`, but the algorithm in the
// @facts        SAME section (and the verbatim Rust at
// @facts        .hashi_src/crates__hashi-types__src__guardian__limiter.rs) yields
// @facts        100_000 + 15 s x 10 sats/s = 100_150. The ALGORITHM is authoritative; the table's
// @facts        arithmetic is not. Rows #2–#6 are correct exactly as printed.
// @implements the 7 RECON R9 golden vectors, each named `R9 vector #n — …`
// @implements the 3 upstream Rust unit tests (test_basic / test_limits / wrong-seq+old-ts)
// @invariant  1. No vector may be "fixed" by changing limiter.ts — limiter.ts mirrors Rust.
// @verify     npm test -- limiter.golden
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  consume,
  genesis,
  projectCapacity,
  projectCapacityAtSecs,
  type LimiterConfig,
  type LimiterState,
} from '../src/hashi/limiter.js';
import { U64_MAX } from '../src/util/bigint.js';

const cfg = (refillRateSatsPerSec: bigint, maxBucketCapacitySats: bigint): LimiterConfig => ({
  refillRateSatsPerSec,
  maxBucketCapacitySats,
});

const state = (numTokensAvailableSats: bigint, lastUpdatedAtSecs: bigint, nextSeq: bigint): LimiterState => ({
  numTokensAvailableSats,
  lastUpdatedAtSecs,
  nextSeq,
});

describe('hashi/limiter — docs/RECON.md R9 golden vectors', () => {
  it('R9 vector #1 — capacity at t=15s: {tokens 100_000, refill 10/s, last 0, cap 2_000_000} => 100_150 (RECON table prints 105_000; ERRATUM)', () => {
    const c = cfg(10n, 2_000_000n);
    const s = state(100_000n, 0n, 0n);
    // 100_000 + (15 - 0) * 10 = 100_150, min(2_000_000) = 100_150
    expect(projectCapacityAtSecs(c, s, 15n)).toBe(100_150n);
  });

  it('R9 vector #2 — capacity at t=u64::MAX saturates to the cap (2_000_000) and does NOT abort', () => {
    const c = cfg(10n, 2_000_000n);
    const s = state(100_000n, 0n, 0n);
    expect(projectCapacityAtSecs(c, s, U64_MAX)).toBe(2_000_000n);
  });

  it('R9 vector #3 — consume(seq 42, ts 100, 80_000) from {tokens 100_000, refill 0, next_seq 42} => ok {20_000, 100, 43}', () => {
    const c = cfg(0n, 2_000_000n);
    const s = state(100_000n, 0n, 42n);
    const result = consume(c, s, 42n, 100n, 80_000n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual({
      numTokensAvailableSats: 20_000n,
      lastUpdatedAtSecs: 100n,
      nextSeq: 43n,
    });
  });

  it('R9 vector #4 — consume(seq 7, ts 10, 80_000) with only 10_000 available => RateLimitExceeded (REJECTED, never queued — G3)', () => {
    const c = cfg(0n, 2_000_000n);
    const s = state(10_000n, 0n, 7n);
    const result = consume(c, s, 7n, 10n, 80_000n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('RateLimitExceeded');
    expect(result.capacitySats).toBe(10_000n);
  });

  it('R9 vector #5 — consume(seq 1, …) against genesis (next_seq 0) => InvalidInputs (seq mismatch)', () => {
    const c = cfg(1_000n, 2_000_000n);
    const s = genesis(c);
    expect(s).toEqual({ numTokensAvailableSats: 2_000_000n, lastUpdatedAtSecs: 0n, nextSeq: 0n });
    const result = consume(c, s, 1n, 0n, 0n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('InvalidInputs');
    expect(result.reason).toContain('seq mismatch');
  });

  it('R9 vector #6 — after consume(0, ts 100, 1000), consume(1, ts 50, 1000) => InvalidInputs (stale timestamp)', () => {
    const c = cfg(1_000n, 2_000_000n);
    const first = consume(c, state(0n, 0n, 0n), 0n, 100n, 1_000n);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state).toEqual({ numTokensAvailableSats: 99_000n, lastUpdatedAtSecs: 100n, nextSeq: 1n });

    const second = consume(c, first.state, 1n, 50n, 1_000n);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('InvalidInputs');
    expect(second.reason).toContain('timestamp');
  });

  it('R9 vector #7 — projectCapacity(100_000n, 10n, 2_000_000n, 15_999) floors 15_999 ms to 15 s => 100_150 (RECON table prints 105_000; ERRATUM)', () => {
    expect(projectCapacity(100_000n, 10n, 2_000_000n, 15_999)).toBe(100_150n);
    // The POINT of the vector: it must floor to 15 s, not round up to 16 s.
    expect(projectCapacity(100_000n, 10n, 2_000_000n, 16_000)).toBe(100_160n);
    expect(projectCapacity(100_000n, 10n, 2_000_000n, 15_999)).not.toBe(
      projectCapacity(100_000n, 10n, 2_000_000n, 16_000),
    );
  });
});

describe('hashi/limiter — upstream Rust unit tests (crates/hashi-types/src/guardian/limiter.rs)', () => {
  const c = cfg(1_000n, 2_000_000n);

  it('test_basic — a target that needs N seconds fails at N and succeeds at N+1', () => {
    let s = state(0n, 0n, 0n);
    const first = consume(c, s, 0n, 1n, c.refillRateSatsPerSec);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    s = first.state;

    const target = 1_000_000n;
    const secsRequired = (target + c.refillRateSatsPerSec - 1n) / c.refillRateSatsPerSec; // div_ceil
    expect(consume(c, s, 1n, secsRequired, target).ok).toBe(false);
    expect(consume(c, s, 1n, 1n + secsRequired, target).ok).toBe(true);
  });

  it('test_limits — cap + 1 is rejected at t=u64::MAX, exactly cap is accepted', () => {
    const s = state(0n, 0n, 0n);
    expect(consume(c, s, 0n, U64_MAX, c.maxBucketCapacitySats + 1n).ok).toBe(false);
    expect(consume(c, s, 0n, U64_MAX, c.maxBucketCapacitySats).ok).toBe(true);
  });

  it('test_rejects_wrong_seq_and_old_timestamp', () => {
    const s = state(0n, 0n, 0n);
    expect(consume(c, s, 1n, 0n, 0n).ok).toBe(false);
    const advanced = consume(c, s, 0n, 100n, 1_000n);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(consume(c, advanced.state, 1n, 50n, 1_000n).ok).toBe(false);
  });
});
