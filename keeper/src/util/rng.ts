// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §0 ("no Math.random() except the bounded jitter drawn
//             from a SEEDED PRNG whose seed is recorded in the journal")
// @spec       docs/KEEPER.md §2.4 (MOCK is deterministic + seeded)
// @rules      G5 G7
// @facts      Algorithm = SplitMix64 (64-bit, bigint) — reproducible in Move/Rust/TS if ever needed.
// @facts      The MOCK and every jitter draw MUST come from here; wall-clock/entropy is banned.
// @implements export interface Rng { nextU64(): bigint; nextBelow(n: bigint): bigint; nextInt(n: number): number; pick<T>(xs: readonly T[]): T; hex(bytes: number): string; }
// @implements export function createRng(seed: string | bigint | number): Rng
// @implements export function seedFrom(...parts: (string | number | bigint)[]): bigint
// @forbidden  Math.random() anywhere in src/ — determinism is the product (G5)
// @forbidden  Date.now() inside the MOCK — it runs on a LOGICAL clock
// @invariant  1. createRng(s) twice yields byte-identical streams.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { U64_MAX } from './bigint.js';

const MASK64 = U64_MAX;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

export interface Rng {
  /** Uniform in `[0, 2^64)`. */
  nextU64(): bigint;
  /** Uniform in `[0, n)`. Throws for `n <= 0`. */
  nextBelow(n: bigint): bigint;
  /** Uniform in `[0, n)` as a JS number. Only for indices/counts — NEVER for sats. */
  nextInt(n: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** `bytes` bytes of deterministic lowercase hex (no `0x` prefix). */
  hex(bytes: number): string;
}

/** Deterministic 64-bit seed derived from any mix of strings/numbers/bigints (FNV-1a 64). */
export function seedFrom(...parts: (string | number | bigint)[]): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const part of parts) {
    const s = typeof part === 'string' ? part : part.toString();
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i) & 0xff);
      h = (h * prime) & MASK64;
    }
    h ^= 0xffn;
    h = (h * prime) & MASK64;
  }
  return h;
}

function mix64(z0: bigint): bigint {
  let z = z0 & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** SplitMix64. Same seed ⇒ same stream, on every platform, forever. */
export function createRng(seed: string | bigint | number): Rng {
  let state = (typeof seed === 'bigint' ? seed : seedFrom(seed)) & MASK64;

  const nextU64 = (): bigint => {
    state = (state + GOLDEN_GAMMA) & MASK64;
    return mix64(state);
  };

  const nextBelow = (n: bigint): bigint => {
    if (n <= 0n) throw new RangeError(`nextBelow requires n > 0, got ${n}`);
    // Rejection sampling keeps the distribution exactly uniform.
    const limit = (MASK64 / n) * n;
    for (;;) {
      const v = nextU64();
      if (v < limit) return v % n;
    }
  };

  const nextInt = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError(`nextInt requires a positive integer, got ${n}`);
    return Number(nextBelow(BigInt(n)));
  };

  const pick = <T,>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new RangeError('pick requires a non-empty array');
    const item = xs[nextInt(xs.length)];
    // `noUncheckedIndexedAccess` — the index is provably in range.
    return item as T;
  };

  const hex = (bytes: number): string => {
    if (!Number.isInteger(bytes) || bytes <= 0) throw new RangeError(`hex requires a positive integer, got ${bytes}`);
    let out = '';
    while (out.length < bytes * 2) {
      out += nextU64().toString(16).padStart(16, '0');
    }
    return out.slice(0, bytes * 2);
  };

  return { nextU64, nextBelow, nextInt, pick, hex };
}
