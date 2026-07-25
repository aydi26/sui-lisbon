// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/APP.md §2 (Screen 1 — Deposit, L56-L106)
// @spec       docs/BUILD-PLAN.md Phase 3 T3.1/T3.3
// @spec       docs/RECON.md R6 (live Hashi config), R7 (deposit/confirm_deposit)
// @rules      G1 G6 G7 G8
// @depends    ../../components (T0.4) · ../../fixtures (T0.4) · ../../config.ts (T0.4)
//             keeper/src/execution/sweep.ts (T2.4) · keeper/src/execution/crank.ts (T2.3)
// @facts      bitcoin_deposit_minimum = 30_000 sats · dust floor 546 sats
// @facts      bitcoin_confirmation_threshold = 6
// @facts      bitcoin_deposit_time_delay_ms = 600_000
// @facts      Six stages; 1-4 are Bitcoin/slow (~70 min total), 5-6 are Sui-instant.
// @facts      ⚠ entry fun hashi::deposit::confirm_deposit(hashi, request_id, clock,
// @facts        ctx) is PERMISSIONLESS — our keeper cranks it for EVERYONE, not
// @facts        only for our depositors. That is a demo asset. (RECON R7)
// @facts      ⚠ Do NOT call hashi deposit registration from the app — the
// @facts        `deposit({signer, txid, utxos, recipient})` path lives in the
// @facts        keeper. The app's role is derive-address + observe + surface-sweep.
// @external   generateDepositAddress({ suiAddress })  // @mysten/hashi, CLIENT-SIDE
//             view.depositStatus({ … }) · waitForDeposit({ … }) · view.balance({ suiAddress })
// @implements export function DepositScreen(): JSX.Element
// @forbidden  a server round-trip for address derivation — A1 intercepts network
// @forbidden  presenting the ~70-min BTC path as fast — G1/G6, A3
// @forbidden  a canonical id literal in this file — G7, A10
// @invariant  1. <LifecycleStepper/> renders exactly six stages with their time
//                classes (A2).
// @invariant  2. <DepositRealityBanner/> copy is always present (A3).
// @invariant  3. In DEMO_MODE=mock nothing here touches signet or RPC (A11).
// @ac         docs/APP.md §7 A1 A2 A3 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import { AddressPill, LifecycleStepper, QrCode } from '../../components';
import { DEPOSIT_STAGES, warmDeposit } from '../../fixtures';
import { formatSats } from '../../lib/format';

/** GR1/GR6 copy. Never softened. */
function DepositRealityBanner() {
  return (
    <div
      role="note"
      style={{
        border: '1px solid var(--btc-dim)',
        background: 'var(--btc-dim)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
      }}
    >
      <strong style={{ color: 'var(--btc)', fontSize: 'var(--text-sm)' }}>
        The Bitcoin side takes about 70 minutes.
      </strong>{' '}
      <span className="aphotic-muted">
        Six signet confirmations, a committee approval and a fixed 10-minute delay. It is pre-staged
        for the demo. Everything after that — the permissionless <code>confirm_deposit</code> crank
        and the sponsored sweep into shares — settles on Sui in one checkpoint.
      </span>
    </div>
  );
}

function ZkLoginButton() {
  // TODO(T3.3): Google OAuth → ephemeral key + zkProof → Sui address; configure
  // the sponsored-tx client here so the first deposit needs zero user SUI.
  return (
    <button type="button" className="aphotic-stub" disabled>
      TODO(T3.3) — Sign in with Google (zkLogin)
    </button>
  );
}

function ConfirmDepositCrankNote() {
  return (
    <p className="aphotic-muted" style={{ margin: 0 }}>
      Confirmation is <strong>permissionless</strong> — our keeper cranks{' '}
      <code>confirm_deposit</code> for everyone in the queue, not just for our depositors.
    </p>
  );
}

export function DepositScreen() {
  // TODO(T3.1): replace the fixture with
  //   generateDepositAddress({ suiAddress })   (client-side P2TR, no server)
  //   + useQuery(view.depositStatus, { refetchInterval: 10_000 })
  //   + waitForDeposit() to flip to "minted".
  // TODO(T3.4 in keeper): surface the sponsored sweep digest from execution/sweep.ts.
  const deposit = warmDeposit;

  return (
    <div className="aphotic-container" style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <header>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>Deposit native BTC</h1>
        <p className="aphotic-muted">
          One Bitcoin transaction in. No wallet, no SUI for gas, and the address your BTC will
          eventually come back to is pinned on-chain right here.
        </p>
      </header>

      <DepositRealityBanner />

      <div style={{ display: 'grid', gap: 'var(--space-5)', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <section className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <ZkLoginButton />
          <QrCode value={deposit.depositAddress} />
          <AddressPill label="Your deposit address (P2TR, derived in your browser)" value={deposit.depositAddress} />
          <span className="aphotic-muted">
            Minimum {formatSats(config.hashi.depositMinSats)} · Bitcoin dust floor{' '}
            {formatSats(config.constants.dustFloorSats)}
          </span>
          <ConfirmDepositCrankNote />
        </section>

        <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <LifecycleStepper
            stages={DEPOSIT_STAGES}
            current={deposit.stage}
            detail={{ 2: `${deposit.confs} / ${config.hashi.confirmations} confirmations` }}
          />
        </section>
      </div>
    </div>
  );
}

export default DepositScreen;
