// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §2 constraint 5 (deterministic and reproducible), §6.2
// @spec       docs/DESIGN-V2.md §5 (clearing), §6 (approve_nav)
// @spec       move/sources/events.move — BatchOpened · BatchClosed · BatchCleared
//             · BatchSettled · NavProposed · NavApproved
// @rules      G7 G8
// @depends    ../../lib/batch.ts · ../../lib/vault.ts · ../../lib/explorer.ts
// @facts      THE HISTORY IS ASSEMBLED FROM EVENTS, one row per batch, and NOTHING
// @facts        IS INTERPOLATED: a stage that never happened stays a dash. Each
// @facts        cell links to the transaction that produced it, so every number on
// @facts        the row is one click from its own receipt.
// @facts      ⚠ gRPC v2 has no event query, so this reads over the verified
// @facts        JSON-RPC mirror (RECON R1). Said out loud, not hidden.
// @facts      THE NAV LOG carries the APPROVAL DIGEST for the live proposal —
// @facts        recomputed in this browser from the ten fields and compared with
// @facts        the contract's own `current_proposal_digest`. For HISTORICAL
// @facts        approvals the digest was an ARGUMENT to `approve_nav` and is not
// @facts        in the event, so the row links to the approving transaction rather
// @facts        than printing a digest we would have had to invent.
// @implements export function HistoryPanel(): JSX.Element
// @forbidden  a fabricated digest for a historical approval
// @forbidden  a read on mount
// @invariant  1. Every rendered figure came from an event or from a live read.
// @ac         renders unconfigured and names the missing variable.
// @verify     cd app && npm test -- verifyScreen
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bytesEqual, toHex } from '@aphotic/sdk/hash';

import { config } from '../../config';
import { eventType, readBatchHistory, type BatchHistoryRow, type EventRow } from '../../lib/batch';
import { suiTxUrl } from '../../lib/explorer';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';
import {
  proposalDigest,
  readProposal,
  readVaultSnapshot,
  readVaultTypeArgs,
  type VaultProposal,
} from '../../lib/vault';
import { getJsonRpcClient } from '../../lib/suiClient';

interface HistoryRead {
  readonly batches: readonly BatchHistoryRow[];
  readonly navLog: readonly EventRow[];
  readonly proposal: VaultProposal | null;
}

async function queryEvents(moveEventType: string, limit: number): Promise<readonly EventRow[]> {
  const response = await getJsonRpcClient().queryEvents({
    query: { MoveEventType: moveEventType },
    order: 'descending',
    limit,
  });
  return response.data.map((e) => ({
    type: e.type,
    txDigest: e.id.txDigest,
    timestampMs: e.timestampMs === null || e.timestampMs === undefined ? null : Number(e.timestampMs),
    json: (e.parsedJson ?? {}) as Record<string, unknown>,
  }));
}

function whenLabel(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toUTCString();
}

export function HistoryPanel() {
  const history = useAsyncAction<HistoryRead>();
  const gap = wiringGap([
    ['VITE_APHOTIC_ORIGINAL_PACKAGE_ID', config.aphotic.originalPackageId],
    ['VITE_VAULT_ID', config.aphotic.vaultId],
  ]);

  const load = async (): Promise<HistoryRead> => {
    const [batches, proposed, approved] = await Promise.all([
      readBatchHistory({ limit: 25 }),
      queryEvents(eventType('events', 'NavProposed'), 25),
      queryEvents(eventType('events', 'NavApproved'), 25),
    ]);
    const navLog = [...proposed, ...approved].sort(
      (a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0),
    );
    const typeArgs = await readVaultTypeArgs();
    const snapshot = await readVaultSnapshot(typeArgs);
    const proposal = snapshot.hasProposal ? await readProposal(typeArgs) : null;
    return { batches, navLog, proposal };
  };

  const data = history.state.data;
  const proposal = data?.proposal ?? null;
  const digestAgrees =
    proposal === null ? null : bytesEqual(proposalDigest(proposal), proposal.digest);

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Batch history and the NAV log</h3>
        <button
          type="button"
          className="ap-btn"
          disabled={gap !== null || history.state.status === 'loading'}
          title={gap ?? 'Read the event streams for every batch and every valuation'}
          onClick={() => void history.run(load)}
        >
          {history.state.status === 'loading' ? 'Reading…' : 'Read the log'}
        </button>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {history.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{history.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            Not read yet. Every batch, assembled from its four events, each stage linking to its
            transaction. Nothing is interpolated: a stage that never happened stays a dash.
          </p>
        ) : (
          <>
            <div className="ap-gate-section">
              <span className="ap-label">Batches</span>
              {data.batches.length === 0 ? (
                <p className="ap-reason">No batch has ever been opened on this package.</p>
              ) : (
                <ul className="ap-rows ap-gate-rows">
                  {data.batches.map((row) => (
                    <li key={row.batchId.toString()}>
                      <div className="ap-rowline">
                        <span className="ap-badge">#{row.batchId.toString()}</span>
                        <span className="ap-wallet-name">
                          {whenLabel(row.openedAtMs)}
                          <br />
                          <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                            {row.orders === null ? 'not closed' : `${row.orders.toString()} orders`} ·{' '}
                            {row.clearingPrice === null
                              ? 'not cleared'
                              : `cleared at ${formatSats(row.clearingPrice)}`}{' '}
                            ·{' '}
                            {row.matchedSats === null
                              ? '—'
                              : `${formatBtc(row.matchedSats, { suffix: true })} matched`}
                            {row.debitsSats === null || row.creditsSats === null
                              ? ''
                              : ` · debits ${formatSats(row.debitsSats)} vs credits ${formatSats(row.creditsSats)}`}
                          </span>
                          <br />
                          <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                            {row.fillRoot === null ? 'no root' : `root ${truncateMiddle(toHex(row.fillRoot), 8)}`}
                          </span>
                        </span>
                        <span className="ap-row" style={{ gap: 'var(--space-2)' }}>
                          {Object.entries(row.digests).map(([stage, digest]) => (
                            <a
                              key={stage}
                              className="ap-badge"
                              href={suiTxUrl(digest)}
                              target="_blank"
                              rel="noreferrer"
                              title={`${stage}: ${digest}`}
                            >
                              {stage}
                            </a>
                          ))}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">Valuations</span>
              {proposal === null ? (
                <p className="ap-reason">
                  No proposal outstanding, so there is no live digest to check. A digest is an{' '}
                  <em>argument</em> to <code>approve_nav</code> and is not in the event, so the rows
                  below link to their transactions instead of printing one.
                </p>
              ) : (
                <p className={digestAgrees === true ? 'ap-reason ap-reason--ok' : 'ap-reason ap-reason--error'}>
                  Live proposal for epoch {proposal.epoch.toString()}, digest{' '}
                  <span className="aphotic-mono">{truncateMiddle(toHex(proposal.digest), 10)}</span>.{' '}
                  {digestAgrees === true
                    ? 'Recomputed here from its ten fields and identical, byte for byte — that is the number the multisig signs.'
                    : 'It does NOT match the digest recomputed here from the fields the contract reports. Do not approve it.'}
                </p>
              )}
              {data.navLog.length === 0 ? (
                <p className="ap-reason">No valuation has been proposed or approved yet.</p>
              ) : (
                <ul className="ap-rows ap-gate-rows">
                  {data.navLog.map((row, i) => {
                    const approved = row.type.endsWith('NavApproved');
                    return (
                      <li key={`${row.txDigest}-${i}`}>
                        <div className="ap-rowline">
                          <span className={approved ? 'ap-badge ap-badge--live' : 'ap-badge'}>
                            {approved ? 'approved' : 'proposed'}
                          </span>
                          <span className="ap-wallet-name">
                            {formatBtc(BigInt(String(row.json.nav_sats ?? '0')), { suffix: true })}
                            <br />
                            <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                              {whenLabel(row.timestampMs)}
                              {approved && row.json.previous_nav_sats !== undefined
                                ? ` · previously ${formatBtc(BigInt(String(row.json.previous_nav_sats)), { suffix: true })}`
                                : ''}
                            </span>
                          </span>
                          <a
                            className="ap-badge"
                            href={suiTxUrl(row.txDigest)}
                            target="_blank"
                            rel="noreferrer"
                            title={row.txDigest}
                          >
                            receipt
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default HistoryPanel;
