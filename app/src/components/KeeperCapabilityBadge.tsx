// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §4.1 (<KeeperCapabilityBadge/>)
// @spec       docs/GOLDEN-RULES.md G2
// @rules      G2
// @depends    ../theme.css (T0.4)
// @facts      The keeper holds a DeepBook `TradeCap` ONLY — never `WithdrawCap`,
// @facts        never `DepositCap`. This is the entire non-custodial thesis.
// @facts      ⚠ hashi::withdraw::cancel_withdrawal asserts
// @facts        request.sender == ctx.sender() ⇒ gateway::reclaim_stalled_exit is
// @facts        DEPOSITOR-callable only; the keeper can NEVER call it. (RECON R7)
// @implements export function KeeperCapabilityBadge(): JSX.Element
// @forbidden  copy implying the keeper can move, redirect or reclaim funds — G2
// @invariant  1. The badge names the capability it HOLDS and the ones it does NOT.
// @ac         docs/APP.md §7 A8 (reachable), §0 GR2 row
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

export function KeeperCapabilityBadge() {
  return (
    <div
      className="aphotic-card"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
    >
      <span
        style={{
          color: 'var(--accent)',
          fontSize: 'var(--text-xs)',
          letterSpacing: 'var(--tracking-wide)',
          textTransform: 'uppercase',
        }}
      >
        Keeper capability
      </span>
      <strong style={{ fontSize: 'var(--text-md)' }}>
        DeepBook <code>TradeCap</code> only
      </strong>
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Never <code>WithdrawCap</code>. Never <code>DepositCap</code>. It can place and cancel
        orders; it can never move funds out. Exits are composed in Move to an address pinned
        on-chain at deposit, and the reclaim path is depositor-callable only.
      </span>
    </div>
  );
}

export default KeeperCapabilityBadge;
