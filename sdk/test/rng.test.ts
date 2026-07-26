// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L2 (seeded RNG; the purity gate forbids Math.random())
// @rules      G5 G7
// @depends    ../src/rng.ts
// @facts      ★ The vectors below were captured from keeper/src/util/rng.ts's SplitMix64 stream.
// @facts        If either implementation drifts, this file fails — which is the point: the
// @facts        keeper's journal records a SEED, and a seed only means something if the stream
// @facts        derived from it is stable across packages and across time.
// @implements describe('createRng')
// @verify     npx vitest run rng
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { createRng, seedFrom } from '../src/rng.js';
import { U64_MAX } from '../src/math.js';

describe('seedFrom (FNV-1a 64)', () => {
  it('is deterministic and mixes every part', () => {
    expect(seedFrom('a')).toBe(seedFrom('a'));
    expect(seedFrom('a')).not.toBe(seedFrom('b'));
    expect(seedFrom('a', 'b')).not.toBe(seedFrom('ab'));
    expect(seedFrom(1)).toBe(seedFrom('1'));
  });

  it('stays inside u64', () => {
    for (const s of ['', 'x', 'aphotic', 'a'.repeat(500)]) {
      const h = seedFrom(s);
      expect(h >= 0n && h <= U64_MAX).toBe(true);
    }
  });
});

describe('createRng (SplitMix64)', () => {
  it('produces byte-identical streams for the same seed', () => {
    const a = createRng('aphotic');
    const b = createRng('aphotic');
    for (let i = 0; i < 500; i++) expect(a.nextU64()).toBe(b.nextU64());
  });

  it('produces different streams for different seeds', () => {
    const a = createRng('aphotic');
    const b = createRng('aphotic2');
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU64() === b.nextU64()) same++;
    expect(same).toBe(0);
  });

  it('matches the SplitMix64 stream for the bare seed 0 — the reference vector', () => {
    // SplitMix64 with state 0: the first outputs are fixed by the algorithm, not by us.
    const r = createRng(0n);
    expect(r.nextU64()).toBe(0xe220a8397b1dcdafn);
    expect(r.nextU64()).toBe(0x6e789e6aa1b965f4n);
    expect(r.nextU64()).toBe(0x06c45d188009454fn);
  });

  it('nextU64 stays inside [0, 2^64)', () => {
    const r = createRng('bounds');
    for (let i = 0; i < 5000; i++) {
      const v = r.nextU64();
      expect(v >= 0n && v <= U64_MAX).toBe(true);
    }
  });

  it('nextBelow is uniform enough that no bucket of 8 is starved over 80k draws', () => {
    const r = createRng('uniformity');
    const counts = new Array<number>(8).fill(0);
    const n = 80_000;
    for (let i = 0; i < n; i++) counts[Number(r.nextBelow(8n))]! += 1;
    for (const c of counts) {
      // Expected 10_000 each; a ±8% band is far outside plausible noise for a fixed seed.
      expect(c).toBeGreaterThan(9_200);
      expect(c).toBeLessThan(10_800);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
  });

  it('rejects degenerate bounds', () => {
    const r = createRng('bad');
    expect(() => r.nextBelow(0n)).toThrow(/n > 0/);
    expect(() => r.nextBelow(-1n)).toThrow(/n > 0/);
    expect(() => r.nextInt(0)).toThrow(/positive integer/);
    expect(() => r.nextInt(1.5)).toThrow(/positive integer/);
    expect(() => r.pick([])).toThrow(/non-empty/);
    expect(() => r.hex(0)).toThrow(/positive integer/);
    expect(() => r.bytes(-1)).toThrow(/n >= 0/);
  });

  it('hex and bytes are the right length and deterministic', () => {
    const a = createRng('bytes');
    const b = createRng('bytes');
    expect(a.hex(7)).toHaveLength(14);
    expect(b.hex(7)).toHaveLength(14);
    expect(a.bytes(33)).toEqual(b.bytes(33));
    expect(a.bytes(0)).toEqual(new Uint8Array(0));
  });

  it('pick draws every element of a small array over enough trials', () => {
    const r = createRng('pick');
    const xs = ['a', 'b', 'c'];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(r.pick(xs));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });
});
