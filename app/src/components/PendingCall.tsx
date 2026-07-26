// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §11 (build sequence — the Move package lands in phases)
// @rules      G6 G8
// @depends    ../theme.css (F1)
// @facts      THE HOUSE RULE THIS COMPONENT EXISTS TO ENFORCE: no mock data is
// @facts        ever presented as live. A panel with no backing data says so, in
// @facts        its own words, naming the exact Move entry it is waiting on.
// @facts      Used wherever a screen needs a call whose signature does not exist
// @facts        yet, so the layout, the copy and the explanation can all ship and
// @facts        be reviewed now, and only the call has to be filled in later.
// @implements export function PendingCall(props: PendingCallProps): JSX.Element
// @forbidden  rendering a plausible-looking number inside this panel — that is
//             precisely the thing it replaces
// @forbidden  an enabled control inside this panel
// @invariant  1. The panel always names the module::function it is waiting on.
// @invariant  2. The panel is visually distinct from a panel showing real data.
// @ac         renders the target and the reason; contains no interactive control.
// @verify     cd app && npm test -- components
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

export interface PendingCallProps {
  /** What the panel will show once it is wired. */
  readonly title: string;
  /** Move entry points this panel needs, e.g. `vault::request_deposit`. */
  readonly targets: readonly string[];
  /**
   * Why it is not wired yet, in the author's own words. Defaults to the honest
   * general case: the entry exists in the design but not yet in the package.
   */
  readonly reason?: string;
  /** Copy that IS accurate today — the explanation, the mechanism, the caveat. */
  readonly children?: ReactNode;
}

export function PendingCall({ title, targets, reason, children }: PendingCallProps) {
  return (
    <section className="aphotic-card ap-pending" aria-label={`${title} — not wired yet`}>
      <div className="ap-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>{title}</strong>
        <span className="ap-chip ap-chip--warn">
          <span className="ap-chip-dot" aria-hidden="true" />
          no data yet
        </span>
      </div>

      {children}

      <p className="ap-reason ap-reason--warn" style={{ margin: 0 }}>
        {reason ??
          'This panel has no backing data. Rather than render a plausible-looking number, it names what it is waiting for.'}
      </p>

      <ul className="ap-pending-targets">
        {targets.map((t) => (
          <li key={t}>
            <code>{t}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default PendingCall;
