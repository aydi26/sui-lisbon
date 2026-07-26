// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#5.2 (integer only) · #5.3 (largest remainder) · #6 (round DOWN)
// @rules      G5 G10
// @depends    ../src/math.ts · ../src/rng.ts
// @facts      The saturating helpers must behave IDENTICALLY to keeper/src/util/bigint.ts.
// @facts        The vectors below are the same ones limiter.golden.test.ts exercises there.
// @implements describe('saturating u64') · describe('mulDiv') · describe('largestRemainder')
// @verify     npx vitest run math
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  assertU128,
  assertU64,
  BPS_DENOM,
  clampU64,
  isU128,
  isU64,
  largestRemainder,
  mulDivCeil,
  mulDivFloor,
  satAdd,
  satMax,
  satMin,
  satMul,
  satSub,
  U128_MAX,
  U64_MAX,
} from '../src/math.js';
import { createRng } from '../src/rng.js';

describe('saturating u64 — the twin of keeper/src/util/bigint.ts', () => {
  it('pins the constants', () => {
    expect(U64_MAX).toBe(2n ** 64n - 1n);
    expect(U128_MAX).toBe(2n ** 128n - 1n);
    expect(BPS_DENOM).toBe(10_000n);
  });

  it('clamps instead of throwing', () => {
    expect(clampU64(-1n)).toBe(0n);
    expect(clampU64(0n)).toBe(0n);
    expect(clampU64(U64_MAX + 1n)).toBe(U64_MAX);
  });

  it('satAdd saturates at the ceiling', () => {
    expect(satAdd(1n, 2n)).toBe(3n);
    expect(satAdd(U64_MAX, 1n)).toBe(U64_MAX);
    expect(satAdd(U64_MAX, U64_MAX)).toBe(U64_MAX);
  });

  it('satMul saturates at the ceiling — golden vector #2 of the Rust guardian', () => {
    expect(satMul(3n, 4n)).toBe(12n);
    expect(satMul(U64_MAX, 2n)).toBe(U64_MAX);
    expect(satMul(U64_MAX, 0n)).toBe(0n);
  });

  it('satSub floors at zero', () => {
    expect(satSub(5n, 3n)).toBe(2n);
    expect(satSub(3n, 5n)).toBe(0n);
    expect(satSub(0n, U64_MAX)).toBe(0n);
  });

  it('satMin / satMax clamp their arguments first', () => {
    expect(satMin(3n, 5n)).toBe(3n);
    expect(satMax(3n, 5n)).toBe(5n);
    expect(satMin(-4n, 5n)).toBe(0n);
    expect(satMax(U64_MAX + 99n, 5n)).toBe(U64_MAX);
  });

  it('never throws for any in-range or out-of-range input', () => {
    const rng = createRng('math-saturation');
    for (let i = 0; i < 2000; i++) {
      const a = rng.nextU64();
      const b = rng.nextU64();
      for (const f of [satAdd, satMul, satSub, satMin, satMax]) {
        const v = f(a, b);
        expect(v >= 0n && v <= U64_MAX).toBe(true);
      }
    }
  });

  it('range predicates and asserts agree', () => {
    expect(isU64(U64_MAX)).toBe(true);
    expect(isU64(U64_MAX + 1n)).toBe(false);
    expect(isU64(-1n)).toBe(false);
    expect(isU128(U128_MAX)).toBe(true);
    expect(isU128(U128_MAX + 1n)).toBe(false);
    expect(assertU64(7n, 'x')).toBe(7n);
    expect(assertU128(7n, 'x')).toBe(7n);
    expect(() => assertU64(U64_MAX + 1n, 'qty')).toThrow(/qty is not a u64/);
    expect(() => assertU128(U128_MAX + 1n, 'price')).toThrow(/price is not a u128/);
  });
});

describe('mulDiv rounding direction', () => {
  it('floor and ceil bracket the exact value', () => {
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n); // 10.5
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n);
  });

  it('agree exactly when the division is exact', () => {
    expect(mulDivFloor(6n, 4n, 3n)).toBe(8n);
    expect(mulDivCeil(6n, 4n, 3n)).toBe(8n);
  });

  it('widen before dividing — a u64 * u64 product never overflows', () => {
    expect(mulDivFloor(U64_MAX, U64_MAX, U64_MAX)).toBe(U64_MAX);
  });

  it('rejects a zero divisor and negative operands', () => {
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(/division by zero/);
    expect(() => mulDivCeil(1n, 1n, 0n)).toThrow(/division by zero/);
    expect(() => mulDivFloor(-1n, 1n, 1n)).toThrow(/negative operand/);
  });

  it('floor <= exact <= ceil, and ceil - floor <= 1, over 5000 random triples', () => {
    const rng = createRng('muldiv');
    for (let i = 0; i < 5000; i++) {
      const a = rng.nextBelow(10n ** 12n);
      const b = rng.nextBelow(10n ** 12n);
      const c = rng.nextBelow(10n ** 9n) + 1n;
      const f = mulDivFloor(a, b, c);
      const g = mulDivCeil(a, b, c);
      expect(f * c <= a * b).toBe(true);
      expect(g * c >= a * b).toBe(true);
      expect(g - f <= 1n).toBe(true);
    }
  });
});

describe('largestRemainder (Hamilton apportionment)', () => {
  it('distributes an exact division with no leftover', () => {
    expect(largestRemainder(150n, [100n, 100n])).toEqual([75n, 75n]);
  });

  it('gives leftovers to the largest remainder', () => {
    // total 71 over 50/30/20: floors 35/21/14 (=70), remainders 50/30/20 -> the 1 goes to index 0
    expect(largestRemainder(71n, [50n, 30n, 20n])).toEqual([36n, 21n, 14n]);
  });

  it('breaks a remainder tie by ASCENDING index — the canonical position', () => {
    // total 101 over 100/100/100: floors 33 each, all remainders equal 200, two leftovers
    expect(largestRemainder(101n, [100n, 100n, 100n])).toEqual([34n, 34n, 33n]);
  });

  it('never allocates more than a weight', () => {
    const rng = createRng('apportion');
    for (let i = 0; i < 3000; i++) {
      const n = rng.nextInt(12) + 1;
      const weights: bigint[] = [];
      for (let j = 0; j < n; j++) weights.push(rng.nextBelow(1_000_000n));
      const sum = weights.reduce((a, b) => a + b, 0n);
      const total = sum === 0n ? 0n : rng.nextBelow(sum + 1n);
      const out = largestRemainder(total, weights);
      expect(out.reduce((a, b) => a + b, 0n)).toBe(total);
      for (let j = 0; j < n; j++) expect(out[j]!).toBeLessThanOrEqual(weights[j]!);
    }
  });

  it('handles the degenerate shapes', () => {
    expect(largestRemainder(0n, [])).toEqual([]);
    expect(largestRemainder(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(largestRemainder(5n, [5n])).toEqual([5n]);
    expect(() => largestRemainder(1n, [])).toThrow(/no weights/);
    expect(() => largestRemainder(11n, [10n])).toThrow(/outside/);
    expect(() => largestRemainder(-1n, [10n])).toThrow(/outside/);
    expect(() => largestRemainder(1n, [-1n, 5n])).toThrow(/negative weight/);
  });

  it('is deterministic — identical input, identical output, 100 times', () => {
    const weights = [7n, 11n, 13n, 17n, 19n];
    const first = largestRemainder(37n, weights);
    for (let i = 0; i < 100; i++) expect(largestRemainder(37n, weights)).toEqual(first);
  });
});
