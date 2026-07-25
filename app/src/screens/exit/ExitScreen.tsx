// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/APP.md §3 (Screen 2 — Exit, L109-L154)
// @spec       docs/BUILD-PLAN.md Phase 3 T3.2 · docs/MOVE-PACKAGE.md#gateway
// @spec       docs/RECON.md R7 (withdraw.move) · R6 (live config)
// @rules      G2 G3 G6 G7
// @depends    ../../components (T0.4) · ../../fixtures (T0.4) · ../../config.ts (T0.4)
//             aphotic::gateway (T1.3, T1.4)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · dust floor 546
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000
// @facts      Pinned address is 20 B (P2WPKH) or 32 B (P2TR); anything else aborts
// @facts        with EInvalidBitcoinAddress.
// @facts      ⚠ gateway::exit_to_bitcoin takes NO bitcoin-address argument. The
// @facts        destination is read from Vault.btc_exit_address (G2).
// @facts      ⚠ hashi::withdraw::cancel_withdrawal asserts
// @facts        request.sender == ctx.sender() ⇒ reclaim is DEPOSITOR-callable
// @facts        only; the keeper can never call it. (RECON R7)
// @facts      ⚠ Over-capacity batches are REJECTED (RateLimitExceeded), never
// @facts        queued. There is no priority to offer. (G3)
// @facts      Phase A = one Sui checkpoint. Phase B ≈ 1.5-2 h on signet and is
// @facts        ALWAYS pre-staged in the demo (G6).
// @external   public fun hashi::withdraw::request_withdrawal(
//                 hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                 bitcoin_address: vector<u8>, ctx: &mut TxContext)
//             view.withdrawalStatus({ requestId }) · waitForWithdrawal({ requestId })
//             guardian.limiterStatus / canWithdraw   (ADVISORY only — G3/G5)
// @implements export function ExitScreen(): JSX.Element
// @forbidden  ANY editable destination field — G2, A4
// @forbidden  a priority / fast / expedite control — G3, A6
// @forbidden  a live progress bar blocking on Bitcoin during judging — G6
// @forbidden  a canonical id literal in this file — G7, A10
// @invariant  1. The pinned address renders as immutable, with <PinningExplainer/>.
// @invariant  2. Amounts below 30_000 sats route to the pending pool, never to
//                request_withdrawal.
// @invariant  3. The signet txid shown is an EARLIER, already-confirmed exit.
// @ac         docs/APP.md §7 A4 A5 A6
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import { AddressPill, LifecycleStepper, PinningExplainer } from '../../components';
import { EXIT_PHASES, exitFixtures, prestagedConfirmedExit } from '../../fixtures';
import { classifyExitAmount, formatSats } from '../../lib/format';
import { signetTxUrl } from '../../lib/explorer';

function ExitCongestionNote() {
  return (
    <p className="aphotic-muted" style={{ margin: 0 }}>
      If the Guardian bucket is over capacity, a batch is <strong>rejected</strong> (
      <code>RateLimitExceeded</code>) — it is not held in an orderable queue, and no amount of
      anything buys a place in one. We ration our own egress rate; that is the only lever that
      exists.
    </p>
  );
}

function ExitRequestForm() {
  // TODO(T3.2): controlled bigint sats input; validate against
  //   config.hashi.withdrawalMinSats and config.constants.dustFloorSats via
  //   classifyExitAmount(); build the exit_to_bitcoin PTB with zkLogin +
  //   sponsored gas. NO destination field — ever (G2).
  const pooledExample = exitFixtures[2]!;
  const klass = classifyExitAmount(
    pooledExample.amountSats,
    config.hashi.withdrawalMinSats,
    config.constants.dustFloorSats,
  );

  return (
    <div className="aphotic-stub" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <span>TODO(T3.2) — exit amount form (sats, bigint)</span>
      <span className="aphotic-muted">
        Minimum {formatSats(config.hashi.withdrawalMinSats)}. Below that an exit is{' '}
        <strong>{klass}</strong>: it accumulates in your pending pool until it clears the Hashi
        minimum, or you take it as hBTC on Sui.
      </span>
    </div>
  );
}

export function ExitScreen() {
  // TODO(T3.2): read Vault.btc_exit_address on-chain via lib/suiClient.ts and
  // render it through renderPinnedAddress(); drive phase B from
  // waitForWithdrawal({ requestId }).
  const live = exitFixtures[1]!;
  const prestaged = prestagedConfirmedExit;

  return (
    <div className="aphotic-container" style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <header>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>Exit to Bitcoin</h1>
        <p className="aphotic-muted">
          Your shares burn and Hashi’s <code>request_withdrawal</code> is composed in the same
          transaction, to the address pinned when you deposited.
        </p>
      </header>

      <div style={{ display: 'grid', gap: 'var(--space-5)', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <section style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <AddressPill
            label={`Pinned exit address (${live.pinnedAddressKind}) — immutable`}
            value={live.pinnedAddressBech32}
            immutable
          />
          <PinningExplainer />
          <ExitRequestForm />
          <ExitCongestionNote />
        </section>

        <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <LifecycleStepper
            stages={EXIT_PHASES}
            current={live.phase === 'A' ? 1 : 2}
            detail={{ 1: `burn ${formatSats(live.amountSats)}` }}
          />

          <div className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span className="aphotic-muted">
              Pre-staged: an earlier exit, already broadcast and confirmed on signet (G6).
            </span>
            {prestaged.signetTxid ? (
              <a
                className="aphotic-mono"
                href={signetTxUrl(prestaged.signetTxid)}
                target="_blank"
                rel="noreferrer"
              >
                {prestaged.signetTxid}
              </a>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default ExitScreen;
