// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §13 (known limitations), §6.2 (two parties, not two scopes)
// @spec       docs/DESIGN-V2.md §7 (what KeeperCap may call · INV-C1)
// @rules      G8
// @depends    ../theme.css (F1)
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
          What we add is on-chain: uniform-price clearing runs in Move and anyone can recompute it,
          the redemption queue we route around is a public object, and the schedule is mechanical
          rather than operator-chosen.
        </li>
        <li>
          The keeper holds no discretion. Every function it can call is safe for anyone to call at
          the scheduled time, and none of them takes an address parameter — so no keeper call can
          send assets anywhere but the pinned allowlist.
        </li>
        <li>
          Valuation is split across two <em>parties</em>, not two scopes: the keeper proposes a NAV
          and records nothing else, and an admin multisig approves the exact digest it signed.
        </li>
      </ul>
    </section>
  );
}

export default TrustModelDisclosure;
