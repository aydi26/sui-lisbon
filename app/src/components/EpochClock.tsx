// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §4 (timing is mechanical), §3 (SUBMIT_CUTOFF_MS)
// @spec       aphotic.md §7.3 (06:00 / 18:00 UTC, settle every pass)
// @rules      G7 G10
// @depends    ../lib/cadence.ts (F1) · ../config.ts (F1) · ../theme.css
// @facts      The countdown is a PURE FUNCTION OF AN INJECTED CLOCK. `nowMs` is a
// @facts        prop; the ticking is a thin `useEffect` around it. That is what
// @facts        makes the boundary vectors (exactly-on / just-before / just-after)
// @facts        testable without faking timers.
// @facts      Two phases inside one window:
// @facts        OPEN     — submits accepted
// @facts        CUT-OFF  — the last 60 s; submits refused so none can race an
// @facts                   early Seal key release caused by key-server skew
// @facts      ⚠ This clock is DISPLAY ONLY. `close_batch` checks the on-chain
// @facts        `Clock`, so the transition is exact regardless of browser skew.
// @facts        Never gate a transaction on this component's output.
// @implements export function EpochClock(props: EpochClockProps): JSX.Element
//             export function epochClockState(nowMs, cutoffMs?): EpochClockState
// @forbidden  claiming a batch closes when this hits zero — the chain decides
// @forbidden  a local-time rendering of the boundary — batches are UTC
// @invariant  1. With `nowMs` supplied the component performs no timing side
//                effects at all: same input, same DOM.
// @invariant  2. The countdown never renders a negative value.
// @invariant  3. The phase label and the countdown always agree (both derive from
//                one call to epochClockState).
// @ac         boundary vectors: exactly-on, just-before, just-after.
// @verify     cd app && npm test -- epochClock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

import { config } from '../config';
import {
  formatBoundaryUtc,
  formatCountdown,
  msUntilNextBoundary,
  nextBoundaryMs,
  previousBoundaryMs,
} from '../lib/cadence';

export type EpochPhase = 'open' | 'cutoff';

export interface EpochClockState {
  /** Unix ms of the boundary being counted down to. Strictly in the future. */
  readonly nextCloseMs: number;
  /** Unix ms of the boundary this window opened on. */
  readonly openedMs: number;
  /** Milliseconds remaining. Always > 0. */
  readonly remainingMs: number;
  /** `HH:MM:SS`. */
  readonly countdown: string;
  /** `2026-07-26 18:00 UTC`. */
  readonly closeLabel: string;
  /** 'cutoff' inside the last `cutoffMs`, when submits are refused. */
  readonly phase: EpochPhase;
}

/**
 * The whole clock as one pure value. Exported so a screen can key its own copy
 * off the same numbers the clock shows, instead of recomputing and drifting.
 */
export function epochClockState(
  nowMs: number,
  cutoffMs: number = config.constants.submitCutoffMs,
): EpochClockState {
  const nextCloseMs = nextBoundaryMs(nowMs);
  const remainingMs = msUntilNextBoundary(nowMs);
  return {
    nextCloseMs,
    openedMs: previousBoundaryMs(nowMs),
    remainingMs,
    countdown: formatCountdown(remainingMs),
    closeLabel: formatBoundaryUtc(nextCloseMs),
    phase: remainingMs <= cutoffMs ? 'cutoff' : 'open',
  };
}

export interface EpochClockProps {
  /**
   * The clock, injected. Omit it and the component ticks off `Date.now()` once a
   * second; supply it and the component is a pure function of its props, which
   * is how every test drives it.
   */
  readonly nowMs?: number;
  /** Tick interval when `nowMs` is not supplied. */
  readonly tickMs?: number;
  /** 'full' = the panel. 'inline' = a single line for the header. */
  readonly variant?: 'full' | 'inline';
}

export function EpochClock({ nowMs, tickMs = 1000, variant = 'full' }: EpochClockProps) {
  const controlled = nowMs !== undefined;
  const [tick, setTick] = useState<number>(() => nowMs ?? Date.now());

  useEffect(() => {
    if (controlled) return;
    const id = window.setInterval(() => setTick(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [controlled, tickMs]);

  const state = epochClockState(controlled ? nowMs : tick);
  const cutoff = state.phase === 'cutoff';

  if (variant === 'inline') {
    return (
      <span className="ap-chip" title={`Next uniform-price clearing: ${state.closeLabel}`}>
        <span className="ap-chip-dot" aria-hidden="true" />
        <span className="ap-num">{state.countdown}</span> to clearing
      </span>
    );
  }

  return (
    <section className="aphotic-card ap-clock" aria-label="Next clearing">
      <span className="ap-eyebrow">Next uniform-price clearing</span>
      <div className="ap-clock-value ap-num">{state.countdown}</div>
      <span className="aphotic-muted">
        {state.closeLabel} · every 06:00 and 18:00 UTC, with or without pending orders
      </span>
      <p className="ap-reason" style={{ margin: 0 }}>
        {cutoff
          ? 'Submission cut-off. Nothing new is accepted in the last 60 seconds of a window, so a submit can never race an early key release caused by key-server clock skew.'
          : 'The cadence is mechanical, not operator-chosen. A full batch does not close early — closing on fullness would hand a spammer exactly the timing lever uniform-price clearing exists to remove.'}
      </p>
      <span className="aphotic-muted">
        This countdown is display only. <code>close_batch</code> checks the on-chain{' '}
        <code>Clock</code>, so the transition is exact whatever this browser thinks the time is.
      </span>
    </section>
  );
}

export default EpochClock;
