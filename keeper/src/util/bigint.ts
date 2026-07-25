// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/RECON.md#r9 (Rust limiter: saturating_add / saturating_mul / checked_sub)
// @spec       docs/KEEPER.md §0 ("Sats everywhere" — bigint, never number)
// @rules      G5 G10
// @facts      U64_MAX = 2^64 - 1 = 18_446_744_073_709_551_615
// @facts      Move u64 add/mul ABORT on overflow; the Rust guardian SATURATES.
// @facts        The TS mirror must saturate to reproduce the guardian bit-for-bit
// @facts        (golden vector #2: capacity at t = u64::MAX saturates to `cap`, no throw).
// @implements export const U64_MAX: bigint
// @implements export function satAdd(a: bigint, b: bigint): bigint
// @implements export function satMul(a: bigint, b: bigint): bigint
// @implements export function satSub(a: bigint, b: bigint): bigint
// @implements export function satMin(a: bigint, b: bigint): bigint
// @implements export function satMax(a: bigint, b: bigint): bigint
// @implements export function clampU64(a: bigint): bigint
// @implements export function isU64(a: bigint): boolean
// @implements export function assertU64(a: bigint, what: string): bigint
// @forbidden  `number` for any satoshi amount anywhere in the keeper
// @invariant  1. Every helper returns a value in [0, U64_MAX].
// @invariant  2. No helper ever throws for in-range u64 inputs (saturation, not overflow).
// @verify     npm test -- limiter.golden
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** Largest value representable by a Move/Rust `u64`. */
export const U64_MAX = 18_446_744_073_709_551_615n; // 2n ** 64n - 1n

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

/** `u64::saturating_sub` (also covers Rust's `checked_sub().expect(...)` in the guardian, which is guarded upstream). */
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

/** True when `a` fits in a Move/Rust `u64`. */
export function isU64(a: bigint): boolean {
  return a >= 0n && a <= U64_MAX;
}

/** Assert `a` fits in a `u64`, returning it unchanged. Use at trust boundaries (env parsing, event decode). */
export function assertU64(a: bigint, what: string): bigint {
  if (!isU64(a)) {
    throw new RangeError(`${what} is not a u64: ${a}`);
  }
  return a;
}
