// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1, F4
// @phase      0
// @status     DONE
// @spec       aphotic.md §6.3 (the one boundary Move cannot enforce), §3 (the
//             rejected shared-vault-holds-queue-positions design), §7.7 (NAV)
// @rules      G2 G8
// @depends    ../config.ts (F1) · ./AddressPill.tsx · ../theme.css
// @facts      ⚠⚠ THE HONEST VERSION. Hashi's `create_withdrawal` sets
// @facts        `sender: ctx.sender()`, which on Sui is the TRANSACTION SIGNER,
// @facts        never the calling module — so a shared object can never be the
// @facts        sender, and `cancel_withdrawal` asserts
// @facts        `request_sender() == ctx.sender()`. A vault that holds queue
// @facts        positions is custodial BY CONSTRUCTION. That design is rejected.
// @facts      ⇒ The carry exit runs through a Sui 2-of-2 multisig (keeper + an
// @facts        independent policy co-signer) and the returning BTC lands at a
// @facts        Bitcoin address no Move code controls.
// @facts      ⇒ Pinning is enforced AT SIGNING, not by Move. The co-signer signs
// @facts        `request_withdrawal` only when `bitcoin_address` equals the pinned
// @facts        vault address, and only within a rate limit.
// @facts      The three mitigations, in order of strength: publish and pin the
// @facts        address · cap NAV attribution to the sum of on-Sui-readable
// @facts        withdrawal claims · a Bitcoin header relay (roadmap).
// @implements export function PinningExplainer(): JSX.Element
// @forbidden  claiming Move enforces the destination — it does not, and saying so
//             would be the single most damaging false claim in this app (G8)
// @forbidden  an editable destination field anywhere in the UI
// @invariant  1. The copy states plainly that the enforcement is off-chain.
// @invariant  2. When no redemption address is configured, the panel says so
//                rather than rendering a blank or a placeholder address.
// @ac         the panel names the multisig, the co-signer rule and the NAV cap.
// @verify     cd app && npm test -- components
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';
import { AddressPill } from './AddressPill';

export function PinningExplainer() {
  const { redemptionAddress, multisigAddress } = config.custody;

  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>
        The one boundary Move cannot enforce
      </h3>

      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Hashi&rsquo;s <code>create_withdrawal</code> sets <code>sender: ctx.sender()</code>, and on
        Sui that is the <em>transaction signer</em>, never the calling module. A shared object can
        therefore never be the sender, and <code>cancel_withdrawal</code> asserts that the canceller
        is that same sender. A vault that held queue positions would be custodial by construction —
        so we do not build one.
      </p>

      <ol
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
          paddingLeft: '1.1rem',
          margin: 0,
        }}
      >
        <li>
          The redemption exit is signed by a Sui <strong>2-of-2 multisig</strong>: the keeper plus an
          independent policy co-signer.
        </li>
        <li>
          The co-signer signs <code>request_withdrawal</code> only when the{' '}
          <code>bitcoin_address</code> equals the pinned address below, and only within a rate
          limit.
        </li>
        <li>
          <strong>That check happens at signing, not in Move.</strong> We will not dress it up as an
          on-chain guarantee. It is the same trust shape the venue already asks users to accept.
        </li>
        <li>
          The pinned address is published, so every redemption is auditable on Bitcoin by anyone,
          without asking us.
        </li>
        <li>
          NAV attributed to native BTC at that address is <strong>capped</strong> at the sum of
          on-Sui-readable withdrawal claims that produced it. The unverifiable component can never
          exceed the verifiable claim behind it.
        </li>
      </ol>

      {redemptionAddress.length > 0 ? (
        <AddressPill value={redemptionAddress} label="Pinned Bitcoin redemption address" immutable />
      ) : (
        <p className="ap-reason ap-reason--warn">
          No redemption address is configured in this build (<code>VITE_REDEMPTION_ADDRESS</code> is
          empty), so there is nothing to publish here yet. We would rather show this line than a
          plausible-looking placeholder.
        </p>
      )}

      {multisigAddress.length > 0 ? (
        <AddressPill value={multisigAddress} label="Custody multisig (Sui, 2-of-2)" />
      ) : null}
    </section>
  );
}

export default PinningExplainer;
