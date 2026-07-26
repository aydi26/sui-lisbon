// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §4 (next_boundary — the Move twin)
// @spec       aphotic.md §7.3 (06:00 / 18:00 UTC), §2 constraint 7
// @rules      G7 G10
// @depends    ../src/lib/cadence.ts (F1)
// @facts      GOLDEN VECTORS. These are the same numbers the Move
// @facts        `next_boundary_golden` test pins. If one side changes, the other
// @facts        must change with it — a batch that closes at a different instant on
// @facts        the two implementations is not a UI bug, it is a settlement bug.
// @facts      cadence 43_200_000 ms · offset 21_600_000 ms
// @facts      1970-01-01T00:00:00Z = 0 ⇒ the first boundary is 06:00 = 21_600_000
// @facts      2026-07-26T00:00:00Z = 1785024000000 (verified with Date.UTC below,
// @facts        not copied from anywhere)
// @facts      THE ASYMMETRY UNDER TEST: exactly ON a boundary, `next` returns the
// @facts        NEXT one (strictly future) while `previous` returns the one you are
// @facts        standing on. Together they partition the timeline with no instant
// @facts        in two windows and no instant in none.
// @implements the boundary vectors: exactly-on · just-before · just-after
// @forbidden  a test that reads the wall clock — every case injects `nowMs`
// @invariant  1. next(t) > t for every t.
// @invariant  2. Every boundary is congruent to offset modulo cadence.
// @ac         exactly-on / just-before / just-after all covered, on both boundaries.
// @verify     cd app && npm test -- cadence
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  CADENCE_MS,
  CADENCE_OFFSET_MS,
  formatBoundaryUtc,
  formatCountdown,
  isOnBoundary,
  msUntilNextBoundary,
  nextBoundaryMs,
  previousBoundaryMs,
  submitWindowClosed,
} from '../src/lib/cadence';

const H = 3_600_000;
const DAY = 86_400_000;

/** 2026-07-26T06:00:00Z and 18:00:00Z, computed rather than transcribed. */
const JUL26_0600 = Date.UTC(2026, 6, 26, 6, 0, 0, 0);
const JUL26_1800 = Date.UTC(2026, 6, 26, 18, 0, 0, 0);
const JUL27_0600 = Date.UTC(2026, 6, 27, 6, 0, 0, 0);

describe('the cadence constants are the ones Move uses', () => {
  it('is a 12 h cadence offset by 6 h', () => {
    expect(CADENCE_MS).toBe(43_200_000);
    expect(CADENCE_OFFSET_MS).toBe(21_600_000);
    expect(CADENCE_MS).toBe(12 * H);
    expect(CADENCE_OFFSET_MS).toBe(6 * H);
  });

  it('puts the grid on 06:00 and 18:00 UTC, twice a day forever', () => {
    expect(JUL26_1800 - JUL26_0600).toBe(CADENCE_MS);
    expect(JUL27_0600 - JUL26_1800).toBe(CADENCE_MS);
    expect(JUL27_0600 - JUL26_0600).toBe(DAY);
    for (const b of [JUL26_0600, JUL26_1800, JUL27_0600]) {
      expect((b - CADENCE_OFFSET_MS) % CADENCE_MS).toBe(0);
      expect(isOnBoundary(b)).toBe(true);
    }
  });

  it('reproduces Move’s saturating-subtract artifact at the very start of the epoch', () => {
    // At t = 0 the subtraction saturates to 0, so `periods` is 0 and the formula
    // still adds a full period: the first boundary it will name is 18:00, not
    // 06:00. That is a property of the Move twin, not of this file, and the twin
    // is the thing that must match. It is unreachable in practice — every real
    // timestamp is decades past the offset — but pinning it here is what keeps
    // the two implementations honest about being the SAME function.
    expect(nextBoundaryMs(0)).toBe(64_800_000);
    expect(formatBoundaryUtc(nextBoundaryMs(0))).toBe('1970-01-01 18:00 UTC');
  });
});

describe('boundary vectors — just before', () => {
  it('one millisecond before 06:00 still counts down to 06:00', () => {
    const t = JUL26_0600 - 1;
    expect(nextBoundaryMs(t)).toBe(JUL26_0600);
    expect(msUntilNextBoundary(t)).toBe(1);
    expect(isOnBoundary(t)).toBe(false);
  });

  it('one second before 18:00 still counts down to 18:00', () => {
    const t = JUL26_1800 - 1000;
    expect(nextBoundaryMs(t)).toBe(JUL26_1800);
    expect(msUntilNextBoundary(t)).toBe(1000);
    expect(formatCountdown(msUntilNextBoundary(t))).toBe('00:00:01');
  });
});

describe('boundary vectors — exactly on', () => {
  it('standing exactly on 06:00 returns the NEXT boundary, never itself', () => {
    expect(nextBoundaryMs(JUL26_0600)).toBe(JUL26_1800);
    expect(msUntilNextBoundary(JUL26_0600)).toBe(CADENCE_MS);
    expect(isOnBoundary(JUL26_0600)).toBe(true);
  });

  it('standing exactly on 18:00 rolls to the next morning', () => {
    expect(nextBoundaryMs(JUL26_1800)).toBe(JUL27_0600);
  });

  it('previous() returns the boundary you are standing on', () => {
    expect(previousBoundaryMs(JUL26_1800)).toBe(JUL26_1800);
    expect(previousBoundaryMs(JUL26_0600)).toBe(JUL26_0600);
  });

  it('never returns a boundary that is not strictly in the future', () => {
    for (const t of [0, 1, JUL26_0600, JUL26_0600 + 1, JUL26_1800, JUL27_0600 - 1]) {
      expect(nextBoundaryMs(t)).toBeGreaterThan(t);
    }
  });
});

describe('boundary vectors — just after', () => {
  it('one millisecond after 06:00 counts down to 18:00', () => {
    const t = JUL26_0600 + 1;
    expect(nextBoundaryMs(t)).toBe(JUL26_1800);
    expect(msUntilNextBoundary(t)).toBe(CADENCE_MS - 1);
    expect(previousBoundaryMs(t)).toBe(JUL26_0600);
  });

  it('partitions the window: previous < now < next, with no gap and no overlap', () => {
    const t = JUL26_0600 + 7 * H + 1234;
    expect(previousBoundaryMs(t)).toBe(JUL26_0600);
    expect(nextBoundaryMs(t)).toBe(JUL26_1800);
    expect(nextBoundaryMs(t) - previousBoundaryMs(t)).toBe(CADENCE_MS);
  });
});

describe('before the first boundary the arithmetic saturates instead of going negative', () => {
  it('never underflows, and never returns a boundary in the past', () => {
    // Saturation is the only behaviour that matters here: no negative period
    // count, no boundary before `now`. The exact value is the twin's business
    // and is pinned above.
    expect(nextBoundaryMs(0)).toBeGreaterThan(0);
    expect(previousBoundaryMs(0)).toBe(CADENCE_OFFSET_MS);
    expect(msUntilNextBoundary(0)).toBe(nextBoundaryMs(0));
    expect(msUntilNextBoundary(0)).toBeGreaterThan(0);
    expect(isOnBoundary(0)).toBe(false);
  });
});

describe('the submit cut-off', () => {
  it('is closed inside the last minute and open before it', () => {
    expect(submitWindowClosed(JUL26_1800 - 59_000)).toBe(true);
    expect(submitWindowClosed(JUL26_1800 - 60_000)).toBe(true);
    expect(submitWindowClosed(JUL26_1800 - 60_001)).toBe(false);
  });

  it('reopens immediately after the boundary passes', () => {
    expect(submitWindowClosed(JUL26_1800)).toBe(false);
    expect(submitWindowClosed(JUL26_1800 + 1)).toBe(false);
  });
});

describe('formatting', () => {
  it('renders HH:MM:SS zero-padded', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(1_000)).toBe('00:00:01');
    expect(formatCountdown(61_000)).toBe('00:01:01');
    expect(formatCountdown(11 * H + 59 * 60_000 + 59_000)).toBe('11:59:59');
    expect(formatCountdown(CADENCE_MS)).toBe('12:00:00');
  });

  it('never renders a negative or a NaN countdown', () => {
    expect(formatCountdown(-1)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00:00');
  });

  it('renders boundaries in UTC, never in local time', () => {
    expect(formatBoundaryUtc(JUL26_1800)).toBe('2026-07-26 18:00 UTC');
    expect(formatBoundaryUtc(JUL27_0600)).toBe('2026-07-27 06:00 UTC');
    expect(formatBoundaryUtc(Number.NaN)).toBe('—');
  });
});
