// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.8
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#4 (next_boundary — the exact Move twin)
// @spec       aphotic.md §2.7 · §7.3
// @rules      G10
// @depends    ../src/cadence.ts · ../fixtures/cadence.golden.json
// @facts      Beyond the fixtures, every boundary is independently re-derived from a Date, so a
// @facts        wrong offset could not survive by being wrong in both the code and the fixture.
// @implements describe('nextBoundary golden') · describe('06:00 / 18:00 UTC')
// @verify     npx vitest run cadence
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  boundariesBetween,
  CADENCE_MS,
  isBoundary,
  MS_PER_DAY,
  nextBoundary,
  OFFSET_MS,
} from '../src/cadence.js';
import { U64_MAX } from '../src/math.js';
import { createRng } from '../src/rng.js';

interface Golden {
  cadenceMs: string;
  offsetMs: string;
  vectors: { name: string; nowMs: string; nextBoundary: string; nextBoundaryIso: string }[];
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/cadence.golden.json', import.meta.url)), 'utf8'),
) as Golden;

describe('constants', () => {
  it('is a 12-hour cadence offset by 6 hours', () => {
    expect(CADENCE_MS).toBe(43_200_000n);
    expect(OFFSET_MS).toBe(21_600_000n);
    expect(MS_PER_DAY).toBe(86_400_000n);
    expect(CADENCE_MS * 2n).toBe(MS_PER_DAY);
    expect(golden.cadenceMs).toBe(CADENCE_MS.toString());
    expect(golden.offsetMs).toBe(OFFSET_MS.toString());
  });
});

describe('golden vectors', () => {
  it('reproduces every one', () => {
    expect(golden.vectors.length).toBeGreaterThanOrEqual(12);
    for (const v of golden.vectors) {
      expect(nextBoundary(BigInt(v.nowMs)).toString()).toBe(v.nextBoundary);
    }
  });

  it('every boundary lands on exactly 06:00:00.000 or 18:00:00.000 UTC', () => {
    for (const v of golden.vectors) {
      const d = new Date(Number(v.nextBoundary));
      expect([6, 18]).toContain(d.getUTCHours());
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
      expect(d.getUTCMilliseconds()).toBe(0);
      expect(d.toISOString()).toBe(v.nextBoundaryIso);
    }
  });

  it('pins the epoch-zero quirk the Move source has (FINDING)', () => {
    // `since` saturates below the offset, so 1970-01-01 00:00 UTC resolves to 18:00, NOT 06:00.
    // Replicated deliberately — the twin must be exact, not improved on one side only.
    const v = golden.vectors.find((x) => x.name === 'epoch-zero-skips-the-first-boundary');
    expect(v).toBeDefined();
    expect(nextBoundary(0n)).toBe(64_800_000n);
    expect(new Date(64_800_000).toISOString()).toBe('1970-01-01T18:00:00.000Z');
  });
});

describe('boundary semantics', () => {
  const morning = BigInt(Date.parse('2026-07-26T06:00:00Z'));
  const evening = BigInt(Date.parse('2026-07-26T18:00:00Z'));
  const nextMorning = BigInt(Date.parse('2026-07-27T06:00:00Z'));

  it('is STRICTLY next — standing on a boundary returns the following one', () => {
    expect(nextBoundary(morning)).toBe(evening);
    expect(nextBoundary(evening)).toBe(nextMorning);
  });

  it('one ms before a boundary returns that boundary', () => {
    expect(nextBoundary(morning - 1n)).toBe(morning);
    expect(nextBoundary(evening - 1n)).toBe(evening);
  });

  it('one ms after a boundary returns the following one', () => {
    expect(nextBoundary(morning + 1n)).toBe(evening);
    expect(nextBoundary(evening + 1n)).toBe(nextMorning);
  });

  it('nextBoundary(t) > t for every t at or above the offset', () => {
    const rng = createRng('cadence-monotone');
    for (let i = 0; i < 5000; i++) {
      const t = OFFSET_MS + rng.nextBelow(10n ** 13n);
      expect(nextBoundary(t)).toBeGreaterThan(t);
    }
  });

  it('the gap to the next boundary is never more than the cadence', () => {
    const rng = createRng('cadence-gap');
    for (let i = 0; i < 5000; i++) {
      const t = OFFSET_MS + rng.nextBelow(10n ** 13n);
      expect(nextBoundary(t) - t).toBeLessThanOrEqual(CADENCE_MS);
      expect(nextBoundary(t) - t).toBeGreaterThan(0n);
    }
  });

  it('every result is a boundary, and only boundaries are', () => {
    const rng = createRng('cadence-isBoundary');
    for (let i = 0; i < 2000; i++) {
      const t = OFFSET_MS + rng.nextBelow(10n ** 13n);
      const b = nextBoundary(t);
      expect(isBoundary(b)).toBe(true);
      expect(isBoundary(b + 1n)).toBe(false);
      expect(isBoundary(b - 1n)).toBe(false);
    }
    expect(isBoundary(0n)).toBe(false);
    expect(isBoundary(OFFSET_MS)).toBe(true);
  });

  it('lands on 06:00 or 18:00 UTC for 3000 random instants across 30 years', () => {
    const rng = createRng('cadence-clock');
    const start = BigInt(Date.parse('2020-01-01T00:00:00Z'));
    for (let i = 0; i < 3000; i++) {
      const t = start + rng.nextBelow(30n * 365n * MS_PER_DAY);
      const d = new Date(Number(nextBoundary(t)));
      expect([6, 18]).toContain(d.getUTCHours());
      expect(d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds()).toBe(0);
    }
  });
});

describe('robustness', () => {
  it('saturates instead of throwing at the u64 ceiling', () => {
    expect(nextBoundary(U64_MAX)).toBe(U64_MAX);
    expect(() => nextBoundary(U64_MAX)).not.toThrow();
  });

  it('rejects a zero cadence — Move would abort on the division', () => {
    expect(() => nextBoundary(1n, 0n, 0n)).toThrow(/EZeroCadence/);
    expect(() => isBoundary(1n, 0n, 0n)).toThrow(/EZeroCadence/);
  });

  it('rejects non-u64 inputs', () => {
    expect(() => nextBoundary(U64_MAX + 1n)).toThrow(/u64/);
    expect(() => nextBoundary(-1n)).toThrow(/u64/);
  });

  it('honours a custom cadence and offset', () => {
    // Hourly on the half hour.
    const hour = 3_600_000n;
    const half = 1_800_000n;
    expect(nextBoundary(half, hour, half)).toBe(half + hour);
    expect(nextBoundary(half + 1n, hour, half)).toBe(half + hour);
  });
});

describe('boundariesBetween', () => {
  const morning = BigInt(Date.parse('2026-07-26T06:00:00Z'));

  it('lists every boundary in (from, to]', () => {
    const out = boundariesBetween(morning - 1n, morning + 3n * CADENCE_MS);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(morning);
    for (const b of out) expect(isBoundary(b)).toBe(true);
  });

  it('is empty when the window is empty or inverted', () => {
    expect(boundariesBetween(morning, morning)).toEqual([]);
    expect(boundariesBetween(morning + 10n, morning)).toEqual([]);
  });

  it('is empty when the window contains no boundary', () => {
    expect(boundariesBetween(morning + 1n, morning + 2n)).toEqual([]);
  });

  it('backfills a two-week outage without drifting', () => {
    const out = boundariesBetween(morning, morning + 14n * MS_PER_DAY);
    expect(out).toHaveLength(28);
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBe(CADENCE_MS);
  });
});
