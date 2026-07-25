// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<ExitLifecycle/>, <SignetTxLink/>, <ReclaimButton/>)
// @spec       docs/APP.md §3.2 (two-phase exit lifecycle), §5 (pre-staged vs live)
// @spec       docs/RECON.md R7 (the three cancel asserts) · E-A3 / E-K7 / E-M8 · E-A9
// @rules      G1 G2 G3 G6
// @depends    ./model.ts (T3.2) · ./ptb.ts (T3.2) · ./CallPreview.tsx (T3.2)
//             ../../components/LifecycleStepper.tsx (T0.4) · ../../lib/explorer.ts (T0.4)
// @facts      Phase A is ONE Sui checkpoint — shares burned and the bridge request
// @facts        composed in the SAME PTB. Instant (G1).
// @facts      Phase B belongs to the bridge. Measured on a quiet signet (E-A9):
// @facts        Requested → Approved +10 s · → PickedForProcessing +5.1 min
// @facts        → Signed +5.4 min · → Confirmed +57.9 min. Planning figure stays the
// @facts        conservative ~1.5-2 h; it is ONE sample. Never live-demoed (G6).
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000 (RECON R6).
// @facts      ⚠ cancel_withdrawal asserts request.sender == ctx.sender(), so the
// @facts        reclaim must be signed by the DEPOSITOR's own session. The keeper can
// @facts        only BUILD the unsigned PTB. Sponsored gas is fine — sponsorship
// @facts        changes who PAYS, never who the SENDER is. (E-A3 / E-K7 / E-M8)
// @implements export function ExitTimeline(props: ExitTimelineProps): JSX.Element
// @forbidden  one spinner/progress element spanning both legs — G6
// @forbidden  a "speed this up" / priority control — over-capacity batches are
//             REJECTED, never queued, and priority cannot be bought (G3)
// @forbidden  a fabricated digest or txid behind an explorer link — G6
// @invariant  1. Phase A is rendered as already settled the moment the PTB lands.
// @invariant  2. Phase B never blocks the UI and is never polled during the demo.
// @invariant  3. The reclaim control states, in copy, that the depositor signs it.
// @ac         docs/APP.md §7 A5 A6
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

import { LifecycleStepper } from '../../components/LifecycleStepper';
import { EXIT_PHASES } from '../../fixtures';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { signetTxUrl, suiTxUrl } from '../../lib/explorer';
import CallPreview from './CallPreview';
import { describeReclaimCall } from './ptb';
import { formatAge, formatDuration, reclaimState, type ExitRecord } from './model';

/** Measured once on a quiet signet — E-A9. One sample, quoted as such. */
const BRIDGE_MILESTONES = [
  'WithdrawalApproved — about 10 s after the request',
  'WithdrawalPickedForProcessing — about 5 min (batching)',
  'WithdrawalSigned — about 5.5 min (Guardian + MPC threshold signature)',
  'WithdrawalConfirmed — about 58 min (broadcast + 6 signet confirmations)',
];

export interface ExitTimelineProps {
  readonly records: readonly ExitRecord[];
  readonly nowMs: number;
  /** DeepBook mid used to re-credit shares, or null when the book is empty. */
  readonly bookMid: bigint | null;
  readonly onReclaim: (record: ExitRecord) => void;
  readonly reclaimingId: string | null;
  /** Non-null ⇒ reclaim cannot be submitted, and this is the honest reason. */
  readonly blockedReason: string | null;
  /** Rendered after a SUCCESSFUL reclaim. */
  readonly reclaimResult: ReactNode | null;
  /** Rendered after a FAILED reclaim. Never styled as success. */
  readonly reclaimError?: ReactNode | null;
  /** Rendered above the list when the history itself could not be read. */
  readonly historyNote?: ReactNode | null;
}

function phaseIndex(record: ExitRecord): number {
  return record.phase === 'A' ? 1 : 2;
}

export function ExitTimeline({
  records,
  nowMs,
  bookMid,
  onReclaim,
  reclaimingId,
  blockedReason,
  reclaimResult,
  reclaimError = null,
  historyNote = null,
}: ExitTimelineProps) {
  const active = records.find((r) => r.phase !== 'done') ?? records[0];

  return (
    <section className="xt-panel">
      <div className="xt-panel-head">
        <h2 className="xt-panel-title">Two legs, two clocks</h2>
        <span className="xt-badge">never one progress bar</span>
      </div>

      <p className="xt-copy">
        The Sui leg is <strong>done in one checkpoint</strong>: your shares burn and Hashi&rsquo;s{' '}
        <code>request_withdrawal</code> is composed in the same transaction. The Bitcoin leg then
        runs on the bridge&rsquo;s clock — batching, a threshold signature, broadcast and six signet
        confirmations. We show them separately because they are separate, and we never make you
        watch the second one.
      </p>

      {active === undefined ? null : (
        <LifecycleStepper
          stages={EXIT_PHASES}
          current={phaseIndex(active)}
          detail={{ 1: `burn ${formatSats(active.amountSats)}` }}
        />
      )}

      <hr className="xt-rule" />

      {historyNote === null ? null : <p className="xt-msg xt-msg--warn">{historyNote}</p>}

      <ul className="xt-list">
        {records.map((record) => {
          const reclaim = reclaimState(record, nowMs);
          return (
            <li className="xt-item" key={record.requestId}>
              <div className="xt-item-head">
                <span className="xt-item-amount">{formatSats(record.amountSats)}</span>
                <span className="xt-hint">{formatBtc(record.amountSats)}</span>
                <span
                  className={`xt-badge ${record.phase === 'done' ? 'xt-badge--ok' : 'xt-badge--btc'}`}
                >
                  {record.phase === 'done' ? 'confirmed on signet' : 'with the bridge'}
                </span>
              </div>

              <div className="xt-phase xt-phase--sui">
                <div className="xt-phase-head">
                  <span className="xt-phase-name">Phase A · Sui</span>
                  <span className="xt-badge xt-badge--lock">settled · one checkpoint</span>
                </div>
                <span className="xt-hint">
                  Shares burned and <code>withdrawal_queue::WithdrawalRequested</code> emitted,
                  atomically, {formatAge(nowMs - record.requestedAtMs)}.
                </span>
                {record.burnDigest === null ? (
                  <span className="xt-hint">
                    Simulated in mock mode — nothing was signed and nothing is on chain, so there is
                    no digest to link. We would rather show you that than a dead link.
                  </span>
                ) : (
                  <a
                    className="xt-link"
                    href={suiTxUrl(record.burnDigest)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncateMiddle(record.burnDigest, 10)} ↗
                  </a>
                )}
              </div>

              <div className="xt-phase xt-phase--btc">
                <div className="xt-phase-head">
                  <span className="xt-phase-name">Phase B · Bitcoin</span>
                  <span className="xt-badge xt-badge--btc">~1.5–2 h · never live</span>
                </div>
                <ul className="xt-milestones">
                  {BRIDGE_MILESTONES.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                {record.signetTxid === null ? (
                  <span className="xt-hint">
                    Not polled during the demo. The bridge decides when this batch goes out, and no
                    amount of anything moves it up the queue.
                  </span>
                ) : (
                  <a
                    className="xt-link"
                    href={signetTxUrl(record.signetTxid)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    signet txid {truncateMiddle(record.signetTxid, 10)} ↗
                  </a>
                )}
              </div>

              <div className="xt-phase">
                <div className="xt-phase-head">
                  <span className="xt-phase-name">Reclaim</span>
                  {reclaim.kind === 'eligible' ? (
                    <span className="xt-badge xt-badge--ok">available to you</span>
                  ) : (
                    <span className="xt-badge">
                      {reclaim.kind === 'cooldown'
                        ? `cooldown · ${formatDuration(reclaim.remainingMs)} left`
                        : reclaim.kind === 'processing'
                          ? 'past the point of no return'
                          : reclaim.kind === 'unresolved'
                            ? 'request id unread'
                            : reclaim.kind === 'simulated'
                              ? 'nothing on chain to cancel'
                              : 'already broadcast'}
                    </span>
                  )}
                </div>

                <span className="xt-hint">
                  {reclaim.kind === 'eligible'
                    ? 'The 1-hour cooldown has elapsed and the batch has not been picked up. You can cancel it and have your shares re-credited at the current NAV.'
                    : reclaim.kind === 'cooldown'
                      ? 'Hashi enforces a 1-hour cooldown before a request can be cancelled (ECooldownNotElapsed).'
                      : reclaim.kind === 'processing'
                        ? 'The batch is already being processed — cancel_withdrawal aborts ECannotCancelProcessingWithdrawal. We surface that instead of retrying behind your back.'
                        : reclaim.kind === 'unresolved'
                          ? 'We could not read this exit’s bridge request_id from the event stream, and reclaim_stalled_exit takes exactly that id. Rather than build a transaction addressed to something else, we offer no button. Re-read from chain — the event may simply not have been indexed yet.'
                          : reclaim.kind === 'simulated'
                            ? 'This exit was simulated locally, so there is no bridge request to cancel.'
                            : 'Already broadcast to Bitcoin. Nothing to reclaim.'}
                </span>

                <p className="xt-copy">
                  <strong>You sign this, not us.</strong> Hashi&rsquo;s{' '}
                  <code>cancel_withdrawal</code> asserts{' '}
                  <code>request.sender == ctx.sender()</code>, so the reclaim is only ever valid
                  from your own session. The keeper can build the unsigned transaction and can never
                  submit it — which is exactly why a compromised keeper cannot strand your exit.
                </p>

                {reclaim.kind === 'eligible' && record.bridgeRequestId !== null ? (
                  <>
                    <CallPreview
                      call={describeReclaimCall({
                        requestId: record.bridgeRequestId,
                        bookMid: bookMid ?? 0n,
                      })}
                      caption="The transaction your session signs"
                    />
                    {blockedReason === null ? null : (
                      <p className="xt-msg xt-msg--warn">{blockedReason}</p>
                    )}
                    <div className="xt-actions">
                      <button
                        type="button"
                        className="xt-btn"
                        disabled={reclaimingId !== null || blockedReason !== null}
                        onClick={() => onReclaim(record)}
                      >
                        {reclaimingId === record.requestId
                          ? 'Signing…'
                          : 'Reclaim this exit (signed by you)'}
                      </button>
                    </div>
                    {reclaimResult === null ? null : (
                      <p className="xt-msg xt-msg--ok">{reclaimResult}</p>
                    )}
                    {reclaimError === null ? null : (
                      <p className="xt-msg xt-msg--bad">{reclaimError}</p>
                    )}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {records.length === 0 ? (
        <p className="xt-hint">No exits yet. The lifecycle appears here the moment one lands.</p>
      ) : null}
    </section>
  );
}

export default ExitTimeline;
