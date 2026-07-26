// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (L2 — TS property test, 10 000 cases, seeded RNG)
// @spec       docs/KEEPER.md §0 ("no Math.random()" — the `purity` gate)
// @rules      G5 G7
// @depends    ./math.ts (U64_MAX)
// @facts      Algorithm = SplitMix64 · seed derivation = FNV-1a 64.
// @facts      ★ BEHAVIOURAL TWIN of keeper/src/util/rng.ts. Same seed ⇒ byte-identical stream.
// @facts        Re-implemented (not imported) so `sdk/` stays dependency-free; the identity is
// @facts        pinned by test/rng.test.ts against hard-coded vectors taken from the twin.
// @implements export interface Rng
// @implements export function createRng(seed: string | bigint | number): Rng
// @implements export function seedFrom(...parts: (string | number | bigint)[]): bigint
// @forbidden  Math.random() anywhere in this package — determinism IS the product
// @forbidden  Date.now() anywhere in this package
// @invariant  1. createRng(s) twice yields byte-identical streams.
// @invariant  2. nextBelow(n) is exactly uniform on [0, n) — rejection sampling, no modulo bias.
// @ac         test/rng.test.ts — reproducibility, uniformity bounds, twin vectors
// @verify     npx vitest run rng
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { U64_MAX } from './math.js';

const MASK64 = U64_MAX;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

export interface Rng {
  /** Uniform in `[0, 2^64)`. */
  nextU64(): bigint;
  /** Uniform in `[0, n)`. Throws for `n <= 0`. */
  nextBelow(n: bigint): bigint;
  /** Uniform in `[0, n)` as a JS number. Indices/counts ONLY — never sats. */
  nextInt(n: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** `bytes` bytes of deterministic lowercase hex (no `0x` prefix). */
  hex(bytes: number): string;
  /** `n` deterministic bytes. */
  bytes(n: number): Uint8Array;
}

/** Deterministic 64-bit seed from any mix of strings/numbers/bigints (FNV-1a 64). */
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
    const limit = (MASK64 / n) * n; // rejection sampling keeps the distribution exact
    for (;;) {
      const v = nextU64();
      if (v < limit) return v % n;
    }
  };

  const nextInt = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`nextInt requires a positive integer, got ${n}`);
    }
    return Number(nextBelow(BigInt(n)));
  };

  const pick = <T,>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new RangeError('pick requires a non-empty array');
    return xs[nextInt(xs.length)] as T;
  };

  const hex = (bytes: number): string => {
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new RangeError(`hex requires a positive integer, got ${bytes}`);
    }
    let out = '';
    while (out.length < bytes * 2) out += nextU64().toString(16).padStart(16, '0');
    return out.slice(0, bytes * 2);
  };

  const bytes = (n: number): Uint8Array => {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`bytes requires n >= 0, got ${n}`);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = nextInt(256);
    return out;
  };

  return { nextU64, nextBelow, nextInt, pick, hex, bytes };
}
