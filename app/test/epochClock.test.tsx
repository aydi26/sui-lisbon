// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §4 (timing), §3 (SUBMIT_CUTOFF_MS = 60_000)
// @rules      G6 G7
// @depends    ../src/components/EpochClock.tsx (F1) · ../src/lib/cadence.ts (F1)
// @facts      The component takes an INJECTED clock, so these cases need no fake
// @facts        timers and no wall-clock tolerance: same nowMs, same DOM.
// @facts      Boundary vectors under test, on BOTH daily boundaries:
// @facts        exactly-on   → the countdown reads a full 12:00:00, not 00:00:00
// @facts        just-before  → still counting down to the SAME boundary
// @facts        just-after   → counting down to the NEXT one
// @implements the rendered half of the boundary vectors
// @forbidden  a test that depends on Date.now() — it would be flaky twice a day,
//             which is exactly when it matters
// @invariant  1. The countdown never renders negative.
// @invariant  2. The phase label and the countdown derive from one state value.
// @ac         exactly-on, just-before, just-after; open vs cut-off phase.
// @verify     cd app && npm test -- epochClock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EpochClock, epochClockState } from '../src/components/EpochClock';

afterEach(cleanup);

const JUL26_0600 = Date.UTC(2026, 6, 26, 6, 0, 0, 0);
const JUL26_1800 = Date.UTC(2026, 6, 26, 18, 0, 0, 0);
const JUL27_0600 = Date.UTC(2026, 6, 27, 6, 0, 0, 0);

describe('epochClockState — the pure value behind the component', () => {
  it('exactly on a boundary counts down to the NEXT one, a full window', () => {
    const s = epochClockState(JUL26_0600);
    expect(s.nextCloseMs).toBe(JUL26_1800);
    expect(s.countdown).toBe('12:00:00');
    expect(s.closeLabel).toBe('2026-07-26 18:00 UTC');
    expect(s.phase).toBe('open');
  });

  it('just before a boundary still points at that boundary', () => {
    const s = epochClockState(JUL26_1800 - 1000);
    expect(s.nextCloseMs).toBe(JUL26_1800);
    expect(s.countdown).toBe('00:00:01');
    expect(s.phase).toBe('cutoff');
  });

  it('just after a boundary points at the next one and re-opens submission', () => {
    const s = epochClockState(JUL26_1800 + 1);
    expect(s.nextCloseMs).toBe(JUL27_0600);
    expect(s.openedMs).toBe(JUL26_1800);
    expect(s.phase).toBe('open');
  });

  it('flips to cut-off exactly at 60 s and not a millisecond earlier', () => {
    expect(epochClockState(JUL26_1800 - 60_001).phase).toBe('open');
    expect(epochClockState(JUL26_1800 - 60_000).phase).toBe('cutoff');
  });

  it('never reports a non-positive remaining time', () => {
    for (const t of [0, JUL26_0600, JUL26_1800, JUL26_1800 + 1, JUL27_0600 - 1]) {
      expect(epochClockState(t).remainingMs).toBeGreaterThan(0);
    }
  });
});

describe('<EpochClock/> — controlled by an injected clock', () => {
  it('renders the countdown and the UTC boundary label', () => {
    const { container } = render(<EpochClock nowMs={JUL26_0600 + 3_600_000} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/11:00:00/);
    expect(text).toMatch(/2026-07-26 18:00 UTC/);
    expect(text).toMatch(/06:00 and 18:00 UTC/);
  });

  it('is a pure function of its props — same instant, same DOM', () => {
    const a = render(<EpochClock nowMs={JUL26_1800 - 5_000} />).container.textContent;
    cleanup();
    const b = render(<EpochClock nowMs={JUL26_1800 - 5_000} />).container.textContent;
    expect(a).toBe(b);
  });

  it('states the cut-off rule inside the last minute', () => {
    const { container } = render(<EpochClock nowMs={JUL26_1800 - 30_000} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/cut-off/i);
    expect(text).toMatch(/60 seconds/i);
  });

  it('states the no-early-close rule while the window is open', () => {
    const { container } = render(<EpochClock nowMs={JUL26_0600 + 60_000} />);
    expect(container.textContent ?? '').toMatch(/does not close early/i);
  });

  it('never claims the browser clock decides — the chain does', () => {
    const { container } = render(<EpochClock nowMs={JUL26_0600} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/display only/i);
    expect(text).toMatch(/close_batch/);
  });

  it('renders an inline variant for the header', () => {
    const { container } = render(<EpochClock nowMs={JUL26_0600} variant="inline" />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/12:00:00/);
    expect(text).toMatch(/to clearing/i);
  });
});
