// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.1 (<DecisionLogViewer/>), §4.4 (decisionLog state)
// @spec       docs/KEEPER.md §8 (journal record schema: oracle · book · hashi ·
//             strategy_blob · ruleset · decision · plan · result), §9.1 (replay)
// @rules      G5 G8 G9 G10
// @depends    ./display.ts ./verifyClient.ts ./transparency.css (T5.2)
//             ../../fixtures (T0.4) · ../../lib/format.ts (T0.4)
//             ../../lib/explorer.ts (T0.4) · ../../config.ts (T0.4)
// @facts      One DecisionRecord per keeper tick, appended to a Walrus segment;
// @facts        the SEGMENT blob id is emitted on-chain by aphotic::journal
// @facts        (self-certifying, content-addressed pointer).
// @facts      ⚠ VITE_APHOTIC_PACKAGE_ID is EMPTY — aphotic::journal is not
// @facts        published yet, so no segment pointer exists to link. Say so; do
// @facts        not invent a blob id.
// @facts      The log is published on a LAG (LOG_PUBLISH_LAG_MS) so a live log
// @facts        cannot front-run our own resting maker orders.
// @facts      `result` is a Sui tx digest (or a reason no tx was issued), NOT a
// @facts        Walrus blob id. Label it as a digest.
// @facts      NAV is valued at the DeepBook MID; the Pyth BETA reading is the
// @facts        divergence-breaker input only (G9).
// @facts      Every sats/USD figure is a bigint — no `number` money (G10).
// @implements export function DecisionLogViewer(props): JSX.Element
// @forbidden  presenting the Pyth price as the NAV basis — G9
// @forbidden  showing a decision as "verified" without a verifier answer — G8
// @forbidden  a canonical id literal here — G7
// @invariant  1. Each row is independently expandable and shows inputs, decision,
//                result and provenance.
// @invariant  2. A failed re-run renders the verbatim endpoint failure.
// @ac         docs/APP.md §7 A7 A9
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';

import { config, isMock } from '../../config';
import type { DecisionRecord } from '../../fixtures';
import { suiTxUrl } from '../../lib/explorer';
import { formatSats, truncateMiddle } from '../../lib/format';
import { divergenceBps, formatBps, formatUsd8, formatUtc } from './display';
import { describeVerifyFailure, equivalentCli, rerunDecision, type DecisionReplay } from './verifyClient';

type RerunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'answered'; readonly replay: DecisionReplay }
  | { readonly kind: 'failed'; readonly message: string };

function ReplayVerdict({ state }: { state: RerunState }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'running') {
    return <p className="tx-note">Asking the keeper verifier…</p>;
  }

  if (state.kind === 'failed') {
    return (
      <div className="tx-callout tx-callout--warn" role="status">
        <strong style={{ color: 'var(--amber)' }}>keeper verify endpoint unreachable</strong>
        <br />
        <span className="tx-mono tx-dim">{state.message}</span>
        <br />
        The verifier is a separate process and it is not running. Nothing is asserted about this
        decision until it answers — run it yourself:
        <br />
        <span className="tx-mono">{equivalentCli()}</span>
      </div>
    );
  }

  const { replay } = state;
  return (
    <div
      className={replay.reproduced ? 'tx-callout' : 'tx-callout tx-callout--err'}
      role="status"
    >
      <strong style={{ color: replay.reproduced ? 'var(--green)' : 'var(--red)' }}>
        {replay.reproduced ? 'Reproduced' : 'Did NOT reproduce'}
      </strong>{' '}
      <span className="tx-dim">
        ({replay.tier} tier · {replay.durationMs} ms)
      </span>
      {replay.recomputed !== undefined ? (
        <>
          <br />
          <span className="tx-mono">{replay.recomputed}</span>
        </>
      ) : null}
      {replay.mismatches.length > 0 ? (
        <ul className="tx-list" style={{ marginTop: 'var(--space-2)' }}>
          {replay.mismatches.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DecisionRow({ record }: { record: DecisionRecord }) {
  const [state, setState] = useState<RerunState>({ kind: 'idle' });

  const rerun = () => {
    setState({ kind: 'running' });
    rerunDecision(record).then(
      (replay) => setState({ kind: 'answered', replay }),
      (err: unknown) => setState({ kind: 'failed', message: describeVerifyFailure(err) }),
    );
  };

  const bps = divergenceBps(record.oracleUsd8, record.bookMidUsd8);
  const published = config.aphotic.packageId !== '';

  return (
    <details className="tx-row">
      <summary>
        <span className="tx-row-seq">#{record.seq}</span>
        <span className="tx-row-decision">{record.decision}</span>
        <span className="tx-row-caret" aria-hidden="true">
          +
        </span>
      </summary>

      <div className="tx-row-body">
        <div>
          <p className="tx-section-k">Inputs, as recorded</p>
          <dl className="tx-kv">
            <dt>Tick</dt>
            <dd className="tx-mono">{formatUtc(record.timestampMs)}</dd>

            <dt>Book mid</dt>
            <dd>
              <span className="tx-mono">{formatUsd8(record.bookMidUsd8)}</span>{' '}
              <span className="tx-dim">— DeepBook hBTC/DBUSDC. NAV is valued here.</span>
            </dd>

            <dt>Oracle</dt>
            <dd>
              <span className="tx-mono">{formatUsd8(record.oracleUsd8)}</span>{' '}
              <span className="tx-dim">— Pyth BETA BTC/USD, breaker input only.</span>{' '}
              <span className="tx-chip">{formatBps(bps)}</span>
            </dd>

            <dt>L2 book</dt>
            <dd className="tx-mono tx-dim">{truncateMiddle(record.l2SnapshotRef, 10)}</dd>

            <dt>Bridge</dt>
            <dd>
              limiter {formatSats(record.hashi.limiterCapacitySats)} · queue{' '}
              {record.hashi.queueDepth} · pending mint {formatSats(record.hashi.pendingMintSats)}
              <br />
              <span className="tx-dim">
                The limiter figure is the re-derived one, not a Guardian API read.
              </span>
            </dd>

            <dt>Buffer</dt>
            <dd>
              {formatSats(record.hashi.redemptionBufferSats)} held back from deployment for
              redemptions.
            </dd>
          </dl>
        </div>

        <div>
          <p className="tx-section-k">Decision and result</p>
          <dl className="tx-kv">
            <dt>Decision</dt>
            <dd>{record.decision}</dd>

            <dt>Result</dt>
            <dd className="tx-mono">
              {isMock() ? (
                truncateMiddle(record.resultDigest, 10)
              ) : (
                <a href={suiTxUrl(record.resultDigest)} target="_blank" rel="noreferrer">
                  {truncateMiddle(record.resultDigest, 10)}
                </a>
              )}{' '}
              <span className="tx-dim">Sui tx digest</span>
            </dd>
          </dl>
        </div>

        <div>
          <p className="tx-section-k">Provenance</p>
          <dl className="tx-kv">
            <dt>Strategy</dt>
            <dd className="tx-mono tx-dim">{truncateMiddle(record.strategyBlobId, 10)}</dd>

            <dt>Ruleset</dt>
            <dd className="tx-mono tx-dim">{truncateMiddle(record.rulesetHash, 10)}</dd>

            <dt>On-chain</dt>
            <dd>
              {published ? (
                <span>
                  Walrus segment blob id emitted by <code>aphotic::journal</code>.
                </span>
              ) : (
                <span className="tx-dim">
                  <code>aphotic::journal</code> is not published yet
                  (VITE_APHOTIC_PACKAGE_ID is empty), so there is no on-chain segment pointer to
                  show. We will not invent one.
                </span>
              )}
            </dd>
          </dl>
        </div>

        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <button
            type="button"
            className="tx-btn"
            onClick={rerun}
            disabled={state.kind === 'running'}
          >
            {state.kind === 'running' ? 'Re-running…' : 'Re-run this decision'}
          </button>
          <ReplayVerdict state={state} />
        </div>
      </div>
    </details>
  );
}

export interface DecisionLogViewerProps {
  records: readonly DecisionRecord[];
}

export function DecisionLogViewer({ records }: DecisionLogViewerProps) {
  const ordered = [...records].sort((a, b) => b.seq - a.seq);

  return (
    <section className="tx-panel" aria-label="Decision log">
      <div className="tx-panel-head">
        <span className="tx-eyebrow">Journal · Walrus</span>
        <h2 className="tx-panel-title">Every decision, with the inputs that caused it</h2>
        <p className="tx-panel-sub">
          One record per keeper tick: the book, the oracle and the bridge as they were read, the
          decision that followed, and the transaction it produced. Published on a lag so a live
          log cannot front-run our own resting orders.
        </p>
      </div>

      {ordered.length === 0 ? (
        <div className="tx-callout tx-callout--warn">
          No decision records yet. The keeper writes one per tick; nothing is synthesised here to
          fill the gap.
        </div>
      ) : (
        <div className="tx-log">
          {ordered.map((record) => (
            <DecisionRow key={record.seq} record={record} />
          ))}
        </div>
      )}

      <p className="tx-note">
        Expand a row to see the recorded inputs, then press <em>Re-run this decision</em> to make
        the keeper&rsquo;s verifier recompute it from those same inputs. The routing tier needs no
        keys at all.
      </p>
    </section>
  );
}

export default DecisionLogViewer;
