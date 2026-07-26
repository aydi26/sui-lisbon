// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §7 (what KeeperCap may call — the complete list)
// @spec       aphotic.md §6.1 (capabilities), §9 (liveness is not privileged)
// @rules      G2 G8
// @depends    ../theme.css (F1)
// @facts      KeeperCap may call EXACTLY: vault::propose_nav · vault::attest_limiter
// @facts        · allocate::allocate / deallocate · carry::place_carry_bid /
// @facts        cancel_carry_bid · clearing::settle_step (a gas hint only).
// @facts      DELIBERATELY NOT keeper-gated, because liveness must not be a
// @facts        privilege: open_batch · close_batch · reveal_order · begin_clearing
// @facts        · sort_step · price_step · settle_step · claim_deposit ·
// @facts        claim_redeem. The schedule and the commitments ARE the
// @facts        authorization.
// @facts      INV-C1 IS ENFORCED STRUCTURALLY: the keeper-gated functions have NO
// @facts        `address` PARAMETER AT ALL, so there is no argument through which a
// @facts        destination could be smuggled. A gate greps for one.
// @facts      Pause asymmetry, honestly: Move cannot read a multisig's threshold,
// @facts        so the asymmetry is enforced off-chain by the multisig config. What
// @facts        Move DOES enforce: pause is one transaction, unpause needs
// @facts        arm_unpause in an EARLIER transaction plus a delay.
// @implements export function KeeperCapabilityBadge(): JSX.Element
// @forbidden  copy implying the keeper can move funds to an address of its choosing
// @forbidden  copy implying the keeper is required for liveness — it is not
// @invariant  1. The badge names what the cap MAY call and what it may NOT.
// @invariant  2. The badge states that liveness is permissionless.
// @ac         renders both lists and the no-address-parameter claim.
// @verify     cd app && npm test -- components
// └── END CONTRACT ───────────────────────────────────────────────────────────

export function KeeperCapabilityBadge() {
  return (
    <div className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <span className="ap-eyebrow">Keeper capability</span>
      <strong style={{ fontSize: 'var(--text-md)' }}>
        <code>KeeperCap</code> — trigger, never decide
      </strong>

      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        It may propose a NAV (which commits nothing), attest the bridge limiter within admin-set
        bounds, allocate and deallocate idle capital to a <em>pinned allowlist</em>, place and
        cancel carry bids behind a value-preservation floor, and hint gas at settlement.
      </span>

      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        It may <strong>not</strong> approve a NAV, mint, burn, rotate a capability, or change a
        parameter. None of its functions takes an <code>address</code> argument at all — there is no
        parameter through which a destination could be smuggled, which is a stronger statement than
        a runtime check.
      </span>

      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        And it is not a gatekeeper: opening, closing, revealing, clearing, settling and claiming are{' '}
        <strong>permissionless</strong>. If the keeper is down, anyone can run the schedule at or
        after the scheduled time. The keeper is an optimisation.
      </span>
    </div>
  );
}

export default KeeperCapabilityBadge;
