// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §0 (GR8 row), §4.1 (<TrustModelDisclosure/>), §7 A8
// @spec       docs/GOLDEN-RULES.md G8 + "Pitch honesty" lines
// @rules      G8
// @depends    ../theme.css (T0.4)
// @facts      hBTC IS custodial-threshold wrapped BTC: MPC threshold Schnorr +
// @facts        Guardian 2-of-2 + a ~60-day recovery leaf. SAY THIS PLAINLY.
// @facts      mpc_threshold_in_basis_points = 3334 · committee epoch 1171,
// @facts        19 committees / 84 members.                      (RECON R6, live)
// @facts      The differentiation is composing the bridge's ON-CHAIN machinery:
// @facts        Move-pinned exits · trustlessly-replayable limiter envelope ·
// @facts        the permissionless deposit crank · the peg-flow signal.
// @facts      A Mysten judge WILL test whether we understand our own dependency;
// @facts        honesty here is a credibility asset, not a weakness.
// @implements export function TrustModelDisclosure(props: { variant?: 'line' | 'expander' }): JSX.Element
// @forbidden  any wording that calls hBTC trustless or non-custodial — G8
// @forbidden  claiming the differentiation is the TOKEN rather than the machinery
// @invariant  1. Rendered on EVERY route, including the landing page (A8).
// @invariant  2. The custodial sentence is always visible without interaction —
//                only the detail is collapsible.
// @ac         docs/APP.md §7 A8 — presence test across routes
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

export interface TrustModelDisclosureProps {
  /** 'line' = the persistent one-liner. 'expander' = the full G8 panel. */
  variant?: 'line' | 'expander';
}

/** The exact sentence G8 requires. Do not soften it. */
export const TRUST_MODEL_LINE =
  'hBTC is custodial-threshold wrapped BTC (MPC threshold Schnorr + Guardian 2-of-2). We do not hide that — our edge is composing the bridge’s on-chain machinery, not the token’s trust model.';

export function TrustModelDisclosure({ variant = 'line' }: TrustModelDisclosureProps) {
  if (variant === 'line') {
    return (
      <footer
        className="aphotic-container"
        style={{
          borderTop: '1px solid var(--border-soft)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-xs)',
          paddingTop: 'var(--space-4)',
          paddingBottom: 'var(--space-4)',
        }}
      >
        {TRUST_MODEL_LINE}
      </footer>
    );
  }

  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)' }}>Trust model, stated plainly</h3>
      <p style={{ color: 'var(--text-secondary)' }}>{TRUST_MODEL_LINE}</p>
      <ul style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', paddingLeft: '1.1rem' }}>
        <li>Custody of the native BTC sits with Hashi’s threshold committee — not with us.</li>
        <li>
          What we add is on-chain: exits are pinned in Move at deposit, the bridge’s congestion
          envelope is replayable from Hashi’s own events, and the deposit crank is permissionless.
        </li>
        <li>
          The keeper holds a DeepBook <code>TradeCap</code> and nothing else. It can trade; it can
          never take.
        </li>
      </ul>
    </section>
  );
}

export default TrustModelDisclosure;
