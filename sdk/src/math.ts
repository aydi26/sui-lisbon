// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#5 (integer only, no floats anywhere, not even intermediately)
// @spec       docs/DESIGN-V2.md#6 (mul_div widens to u128 BEFORE dividing, always rounds DOWN)
// @rules      G10
// @depends    (nothing) — behavioural twin of keeper/src/util/bigint.ts
// @facts      U64_MAX  = 2^64  - 1 = 18_446_744_073_709_551_615
// @facts      U128_MAX = 2^128 - 1 = 340_282_366_920_938_463_463_374_607_431_768_211_455
// @facts      BPS_DENOM = 10_000
// @facts      ★ Saturating helpers reproduce the Rust guardian bit-for-bit and are the exact
// @facts        twins of keeper/src/util/bigint.ts {satAdd,satMul,satSub,satMin,satMax,clampU64}.
// @facts        Re-implemented here (not imported) so `sdk/` has zero cross-package coupling;
// @facts        test/math.test.ts pins the identical behaviour.
// @facts      ⚠ Move u64 add/mul ABORT on overflow; the Rust guardian SATURATES. `nextBoundary`
// @facts        mirrors the guardian form because docs/DESIGN-V2.md §4 spells it that way.
// @implements export const U64_MAX: bigint
// @implements export const U128_MAX: bigint
// @implements export const BPS_DENOM: bigint
// @implements export function clampU64(a: bigint): bigint
// @implements export function satAdd(a: bigint, b: bigint): bigint
// @implements export function satMul(a: bigint, b: bigint): bigint
// @implements export function satSub(a: bigint, b: bigint): bigint
// @implements export function satMin(a: bigint, b: bigint): bigint
// @implements export function satMax(a: bigint, b: bigint): bigint
// @implements export function isU64(a: bigint): boolean
// @implements export function isU128(a: bigint): boolean
// @implements export function assertU64(a: bigint, what: string): bigint
// @implements export function assertU128(a: bigint, what: string): bigint
// @implements export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint
// @implements export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint
// @implements export function largestRemainder(total: bigint, weights: readonly bigint[]): bigint[]
// @forbidden  Number / float arithmetic on any money quantity — bigint only
// @forbidden  Math.round / Math.floor on a value derived from sats
// @invariant  1. Every saturating helper returns a value in [0, U64_MAX] and never throws
//                for in-range inputs.
// @invariant  2. mulDivFloor(a,b,c) <= a*b/c <= mulDivCeil(a,b,c), and both are exact when c | a*b.
// @invariant  3. largestRemainder: Σ out == total, and out[i] <= weights[i] for every i,
//                given 0 <= total <= Σ weights.
// @invariant  4. largestRemainder ties are broken by ASCENDING array index — the caller must
//                pass the array already in CANONICAL order (docs/DESIGN-V2.md §5.3).
// @ac         test/math.test.ts — saturation, rounding direction, remainder distribution
// @verify     npx vitest run math
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** Largest value representable by a Move `u64`. */
export const U64_MAX = 18_446_744_073_709_551_615n;
/** Largest value representable by a Move `u128`. */
export const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
/** Basis-point denominator. */
export const BPS_DENOM = 10_000n;

/** Clamp into `[0, U64_MAX]` — the saturating cast the Rust guardian performs implicitly. */
export function clampU64(a: bigint): bigint {
  if (a < 0n) return 0n;
  if (a > U64_MAX) return U64_MAX;
  return a;
}

/** `u64::saturating_add` */
export function satAdd(a: bigint, b: bigint): bigint {
  return clampU64(clampU64(a) + clampU64(b));
}

/** `u64::saturating_mul` */
export function satMul(a: bigint, b: bigint): bigint {
  return clampU64(clampU64(a) * clampU64(b));
}

/** `u64::saturating_sub` */
export function satSub(a: bigint, b: bigint): bigint {
  const x = clampU64(a);
  const y = clampU64(b);
  return x > y ? x - y : 0n;
}

/** `u64::min` */
export function satMin(a: bigint, b: bigint): bigint {
  const x = clampU64(a);
  const y = clampU64(b);
  return x < y ? x : y;
}

/** `u64::max` */
export function satMax(a: bigint, b: bigint): bigint {
  const x = clampU64(a);
  const y = clampU64(b);
  return x > y ? x : y;
}

/** True when `a` fits in a Move `u64`. */
export function isU64(a: bigint): boolean {
  return a >= 0n && a <= U64_MAX;
}

/** True when `a` fits in a Move `u128`. */
export function isU128(a: bigint): boolean {
  return a >= 0n && a <= U128_MAX;
}

/** Assert `a` fits in a `u64`, returning it unchanged. Use at every trust boundary. */
export function assertU64(a: bigint, what: string): bigint {
  if (!isU64(a)) throw new RangeError(`${what} is not a u64: ${a}`);
  return a;
}

/** Assert `a` fits in a `u128`, returning it unchanged. */
export function assertU128(a: bigint, what: string): bigint {
  if (!isU128(a)) throw new RangeError(`${what} is not a u128: ${a}`);
  return a;
}

/**
 * `mul_div` rounding DOWN — the Move form widens to `u128`/`u256` BEFORE dividing so the
 * product never overflows. bigint is unbounded, so the widening is implicit here; what
 * matters for parity is the ROUNDING DIRECTION (docs/DESIGN-V2.md §6 step 7).
 */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new RangeError('mulDivFloor: division by zero');
  if (a < 0n || b < 0n || c < 0n) throw new RangeError('mulDivFloor: negative operand');
  return (a * b) / c;
}

/** `mul_div` rounding UP. Used only where docs/DESIGN-V2.md §5.5 rounds TOWARD THE VAULT. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new RangeError('mulDivCeil: division by zero');
  if (a < 0n || b < 0n || c < 0n) throw new RangeError('mulDivCeil: negative operand');
  const p = a * b;
  const q = p / c;
  return p % c === 0n ? q : q + 1n;
}

/**
 * Largest-remainder (Hamilton) apportionment — docs/DESIGN-V2.md §5.3.
 *
 *     floor_i = floor(total * w_i / Σw)
 *     the `total - Σ floor_i` leftover units go one at a time to the LARGEST fractional
 *     remainder, ties broken by ASCENDING index (= canonical position).
 *
 * Callers MUST supply `weights` already sorted into canonical order, because the index tie-break
 * IS the canonical tie-break. Requires `0 <= total <= Σ weights`.
 */
export function largestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  const n = weights.length;
  const out = new Array<bigint>(n).fill(0n);
  if (n === 0) {
    if (total !== 0n) throw new RangeError(`largestRemainder: total ${total} with no weights`);
    return out;
  }
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (w < 0n) throw new RangeError(`largestRemainder: negative weight at ${i}`);
    sum += w;
  }
  if (total < 0n || total > sum) {
    throw new RangeError(`largestRemainder: total ${total} outside [0, ${sum}]`);
  }
  if (sum === 0n) return out;

  const remainders = new Array<bigint>(n);
  let assigned = 0n;
  for (let i = 0; i < n; i++) {
    const p = total * weights[i]!;
    const q = p / sum;
    out[i] = q;
    remainders[i] = p % sum;
    assigned += q;
  }
  let leftover = total - assigned;
  if (leftover === 0n) return out;

  // Only entries with a non-zero remainder can receive a unit; for those, floor_i < w_i,
  // so `+1` can never push an allocation above its own weight.
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (remainders[i]! > 0n) order.push(i);
  order.sort((x, y) => {
    const rx = remainders[x]!;
    const ry = remainders[y]!;
    if (rx !== ry) return rx > ry ? -1 : 1; // larger remainder first
    return x - y; // then canonical position, ascending
  });
  for (const i of order) {
    if (leftover === 0n) break;
    out[i] = out[i]! + 1n;
    leftover -= 1n;
  }
  if (leftover !== 0n) {
    throw new Error(`largestRemainder: ${leftover} units undistributed (unreachable)`);
  }
  return out;
}
