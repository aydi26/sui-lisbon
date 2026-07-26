// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      4
// @status     DONE
// @spec       docs/DESIGN-V2.md §5 (clearing; push, not claim — `verify_fill` is
//             the transparency surface the claim story was actually for), §5.6
// @spec       move/sources/clearing.move — `fill_at`, `verify_fill`, `fills_root`
// @rules      G7 G8
// @depends    ../../lib/batch.ts · ../../lib/fills.ts · ../../lib/useAsyncAction.ts
// @facts      FILLS ARE PUSHED, NOT CLAIMED. A pull model leaves an unbounded
// @facts        unclaimed liability that must be excluded from NAV and reconciled
// @facts        forever; pushing makes settlement terminal. `verify_fill` is what
// @facts        the claim story was actually for.
// @facts      THE PROOF IS BUILT IN THIS BROWSER. The Merkle path comes from the
// @facts        published fill list, is folded locally first, and is then handed
// @facts        to `clearing::verify_fill` by simulation — the contract's own
// @facts        check, against the root the contract itself published. Two
// @facts        verdicts are shown because they answer different questions: the
// @facts        local one says the arithmetic works, the on-chain one says the
// @facts        chain agrees.
// @facts      ⚠ ODD NODES ARE DUPLICATED, not zero-padded. A path built the other
// @facts        way folds to a root nobody published.
// @facts      A batch with no revealed orders still settles: price 0, an EMPTY
// @facts        root of 32 zero bytes, zero debits and credits. The cadence
// @facts        settles every pass, with or without orders.
// @implements export function FillsPanel(): JSX.Element
// @forbidden  proving against a root computed here instead of the published one
// @forbidden  a read on mount
// @invariant  1. A fill row appears only after the fill list was read.
// @invariant  2. The two verdicts are reported separately and never merged.
// @ac         renders unconfigured, naming the missing variable.
// @verify     cd app && npm test -- batchScreen
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import { bytesEqual, toHex } from '@aphotic/sdk/hash';

import { config } from '../../config';
import {
  discoverClearing,
  proveFill,
  readClearing,
  readFills,
  type ClearingSnapshot,
  type FillRow,
} from '../../lib/batch';
import { fillLeafHash, fillSiblings, rootFromFillPath } from '../../lib/fills';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import { discountBpsForPrice } from '../../lib/order';
import { useAsyncAction } from '../../lib/useAsyncAction';

interface ClearingRead {
  readonly clearing: ClearingSnapshot;
  readonly fills: readonly FillRow[];
}

interface Verdict {
  readonly index: number;
  readonly local: boolean;
  readonly onChain: boolean | null;
  readonly note: string;
}

export function FillsPanel() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const clearing = useAsyncAction<ClearingRead>();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [proving, setProving] = useState<number | null>(null);

  const gap = wiringGap([['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId]]);

  const load = async (): Promise<ClearingRead> => {
    const objectId = await discoverClearing();
    if (objectId === null) {
      throw new Error(
        'No batch has been cleared on this package yet, so there is no root to prove against.',
      );
    }
    const snapshot = await readClearing(objectId);
    const fills = await readFills(objectId, Number(snapshot.fillCount));
    return { clearing: snapshot, fills };
  };

  const prove = async (fill: FillRow) => {
    const data = clearing.state.data;
    if (data === null) return;
    setProving(fill.index);
    setVerdict(null);
    try {
      const siblings = fillSiblings(data.fills, fill.index);
      const local = bytesEqual(
        rootFromFillPath(fillLeafHash(fill), fill.index, siblings),
        data.clearing.fillsRoot,
      );
      let onChain: boolean | null = null;
      let note = '';
      try {
        onChain = await proveFill(data.clearing.objectId, fill.index, siblings);
        note = onChain
          ? 'clearing::verify_fill returned true against the root it published.'
          : 'clearing::verify_fill returned FALSE. The published root does not admit this leaf.';
      } catch (err) {
        note = `The chain could not be asked: ${err instanceof Error ? err.message : String(err)}`;
      }
      setVerdict({ index: fill.index, local, onChain, note });
    } finally {
      setProving(null);
    }
  };

  const data = clearing.state.data;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Fills, and proving one</h3>
        <div className="ap-row">
          {data === null ? null : (
            <span className="ap-badge">
              batch {data.clearing.batchId.toString()} · {data.clearing.fillCount.toString()} fills
            </span>
          )}
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || clearing.state.status === 'loading'}
            title={gap ?? 'Find the most recent clearing and read its published fills'}
            onClick={() => void clearing.run(load)}
          >
            {clearing.state.status === 'loading' ? 'Reading…' : 'Read the fills'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {clearing.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{clearing.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            A fill is provable against the published root by a Merkle path, so you can check your
            own execution without downloading everyone else&rsquo;s — and without us being able to
            show you a different list from the one we settled.
          </p>
        ) : (
          <>
            <div className="ap-grid ap-grid--2">
              <div className="ap-metric">
                <span className="ap-metric-label">Uniform clearing price</span>
                <span className="ap-metric-value">{formatSats(data.clearing.clearingPrice)}</span>
                <span className="ap-metric-sub">
                  {data.clearing.clearingPrice === 0n
                    ? 'no cross — a batch with no crossing orders still settles'
                    : `${discountBpsForPrice(data.clearing.clearingPrice).toString()} bps below par`}
                </span>
              </div>
              <div className="ap-metric">
                <span className="ap-metric-label">Matched</span>
                <span className="ap-metric-value">
                  {formatBtc(data.clearing.matchedBaseSats, { suffix: true })}
                </span>
                <span className="ap-metric-sub">
                  debits {formatSats(data.clearing.totalDebits)} · credits{' '}
                  {formatSats(data.clearing.totalCredits)} · fee{' '}
                  {formatSats(data.clearing.feeQuoteSats)}
                </span>
              </div>
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">Published root</span>
              <p className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', margin: 0, wordBreak: 'break-all' }}>
                {toHex(data.clearing.fillsRoot)}
              </p>
              {data.fills.length === 0 ? (
                <p className="ap-reason">
                  No fills. An empty fill set roots to 32 zero bytes — not to a hash of nothing —
                  and that is what is printed above.
                </p>
              ) : null}
            </div>

            {data.fills.length === 0 ? null : (
              <ul className="ap-rows ap-gate-rows">
                {data.fills.map((fill) => (
                  <li key={fill.index}>
                    <div className="ap-rowline">
                      <span className="ap-badge">{fill.isBid ? 'bid' : 'ask'}</span>
                      <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                        {truncateMiddle(fill.submitter)}
                        {fill.submitter === address ? ' (you)' : ''}
                      </span>
                      <span className="aphotic-muted">
                        {formatBtc(fill.baseSats, { suffix: true })} @ {formatSats(fill.price)}
                      </span>
                      <button
                        type="button"
                        className="ap-btn"
                        disabled={proving !== null}
                        title="Rebuild this fill's Merkle path here, then ask the contract to check it"
                        onClick={() => void prove(fill)}
                      >
                        {proving === fill.index ? 'Proving…' : 'Prove'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {verdict === null ? null : (
              <p
                className={
                  verdict.local && verdict.onChain === true
                    ? 'ap-reason ap-reason--ok'
                    : 'ap-reason ap-reason--error'
                }
              >
                Fill #{verdict.index}:{' '}
                {verdict.local
                  ? 'the path rebuilt in this browser folds to the published root'
                  : 'the path rebuilt in this browser does NOT fold to the published root'}
                . {verdict.note}
              </p>
            )}
          </>
        )}

        <p className="ap-reason">
          Settlement is value-preserving or it reverts, and the fee is an explicit third term rather
          than a silent shortfall: debits equal credits plus fee. Under-funded accounts are handled
          by a rule, not by a rejection — the ledger freezes at close and any fill an account cannot
          cover is truncated deterministically, with the counterparty recomputed symmetrically from
          the same frozen snapshot.
        </p>
      </div>
    </section>
  );
}

export default FillsPanel;
