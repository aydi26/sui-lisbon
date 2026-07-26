// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §7.2 (batch state machine), docs/DESIGN-V2.md §6
//             (the NAV epoch: propose → approve → claim)
// @rules      G1 G6
// @depends    ../theme.css (F1)
// @facts      Time classes and their tokens:
// @facts        'bitcoin' → var(--time-bitcoin)  slow: signet confs / MPC batching
// @facts        'delay'   → var(--amber)         fixed 600_000 ms Hashi delay
// @facts        'sui'     → var(--time-sui)      INSTANT: one checkpoint (G1)
// @facts      Deposit total for stages 1-4 ≈ 70 min. NEVER label the total fast.
// @implements export function LifecycleStepper(props: LifecycleStepperProps): JSX.Element
// @forbidden  a spinner or progress bar that BLOCKS on a Bitcoin confirmation — G6
// @forbidden  omitting the per-stage time-class label — A2/A3 assert on it
// @invariant  1. Renders exactly `stages.length` steps, in order.
// @invariant  2. Every step shows its time class verbatim.
// @ac         docs/APP.md §7 A2 (six stages, correct time classes), A3
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

/**
 * How long a stage takes, by CLASS rather than by number. The distinction is the
 * point: a Sui state transition is one checkpoint, a Bitcoin confirmation is not,
 * and a UI that renders them in the same colour teaches the wrong model.
 */
export type TimeClass = 'bitcoin' | 'delay' | 'sui';

export interface LifecycleStage {
  /** 1-based position in the flow. */
  readonly index: number;
  readonly label: string;
  /** What is actually observed when this stage completes. */
  readonly signal: string;
  /** Honest expectation, e.g. "~10 min" or "one checkpoint". */
  readonly expected: string;
  readonly timeClass: TimeClass;
}

export interface LifecycleStepperProps {
  stages: readonly LifecycleStage[];
  /** 1-based index of the stage currently in flight. */
  current: number;
  /** Optional per-stage detail, e.g. "3 / 6 confirmations". */
  detail?: Partial<Record<number, string>>;
  /**
   * Optional per-stage control rendered inside the step — the affordance that
   * actually advances it (e.g. the UTXO registration, the permissionless crank).
   * A stage nobody can advance is a stage the user is stranded on (RECON R14).
   */
  action?: Partial<Record<number, ReactNode>>;
}

const TIME_CLASS_COLOR: Record<TimeClass, string> = {
  bitcoin: 'var(--time-bitcoin)',
  delay: 'var(--amber)',
  sui: 'var(--time-sui)',
};

const TIME_CLASS_LABEL: Record<TimeClass, string> = {
  bitcoin: 'Bitcoin — slow',
  delay: 'Fixed delay',
  sui: 'Sui — instant',
};

export function LifecycleStepper({ stages, current, detail, action }: LifecycleStepperProps) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
      {stages.map((stage) => {
        const done = stage.index < current;
        const active = stage.index === current;
        const color = TIME_CLASS_COLOR[stage.timeClass];
        return (
          <li
            key={stage.index}
            className="aphotic-card"
            style={{
              padding: 'var(--space-3) var(--space-4)',
              borderColor: active ? color : 'var(--border-soft)',
              opacity: done || active ? 1 : 0.55,
              display: 'grid',
              gap: 'var(--space-1)',
            }}
          >
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}>
              <span style={{ color, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                {done ? '✓' : String(stage.index).padStart(2, '0')}
              </span>
              <strong style={{ fontSize: 'var(--text-base)' }}>{stage.label}</strong>
              <span
                style={{
                  marginLeft: 'auto',
                  color,
                  fontSize: 'var(--text-xs)',
                  letterSpacing: 'var(--tracking-wide)',
                  textTransform: 'uppercase',
                }}
              >
                {TIME_CLASS_LABEL[stage.timeClass]}
              </span>
            </div>
            <span className="aphotic-muted">{stage.signal}</span>
            <span className="aphotic-muted">
              {stage.expected}
              {detail?.[stage.index] ? ` · ${detail[stage.index]}` : ''}
            </span>
            {action?.[stage.index] ?? null}
          </li>
        );
      })}
    </ol>
  );
}

export default LifecycleStepper;
