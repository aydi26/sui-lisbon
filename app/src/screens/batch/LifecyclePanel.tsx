// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.2, §7.3 (cadence), §9 (liveness is not a privilege)
// @spec       docs/DESIGN-V2.md §3 (REVEAL_GRACE_MS = 600_000; F2 — no sender
//             check, so reveal is satisfiable by ANYONE after close)
// @rules      G7 G8 G10
// @depends    ../../lib/batch.ts · ../../lib/seal.ts · ../../lib/walrus.ts
//             · ../../lib/order.ts · ../../lib/tx.ts
// @facts      EVERY CONTROL ON THIS PANEL IS PERMISSIONLESS. open_batch,
// @facts        close_batch and reveal_order take no capability of any kind. If
// @facts        the keeper is down, anyone can advance the batch at or after the
// @facts        scheduled time — the schedule and the commitments ARE the
// @facts        authorization.
// @facts      ★ "REVEAL ALL" IS THE POINT, not a convenience. A commit–reveal
// @facts        scheme dies to grief-by-non-revelation: one participant goes
// @facts        offline and the batch cannot clear. Here the time-lock policy has
// @facts        NO SENDER CHECK (DESIGN-V2 F2), so after `close_ms` any passer-by
// @facts        can fetch the key shares, decrypt every order and reveal them —
// @facts        including orders that are not theirs, and against the submitter's
// @facts        wishes. That is why the button exists and why it is not framed as
// @facts        altruism.
// @facts      REVEAL CHECKS THE COMMITMENT BEFORE IT SENDS. `reveal_order` aborts
// @facts        ECommitmentMismatch if the plaintext does not hash to what was
// @facts        submitted, so a blob whose contents were swapped is detected here
// @facts        and named, rather than costing gas to discover.
// @facts      A SESSION KEY IS A SIGNATURE OVER A PERSONAL MESSAGE, not a
// @facts        transaction. It authorises the key servers to answer THIS browser
// @facts        for a bounded time; it moves nothing and can sign nothing.
// @facts      TRIMMED (2026-07-26): the four-state walkthrough and the reveal
// @facts        essay moved to /docs; the panel keeps the controls, the state it
// @facts        actually read, and ONE line saying reveal is permissionless —
// @facts        which is not decoration, it is why "Reveal all" may touch orders
// @facts        that are not yours.
// @implements export function LifecyclePanel(props): JSX.Element
// @forbidden  claiming an order is revealed before the transaction succeeded
// @forbidden  decrypting before close — the policy would deny, and pretending
//             otherwise would misrepresent when confidentiality ends
// @invariant  1. Reveal is offered only in SEALED, only inside the grace window.
// @invariant  2. A plaintext whose commitment does not match is never submitted.
// @ac         renders unconfigured with every control disabled and stated.
// @verify     cd app && npm test -- batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit';
import type { SessionKey } from '@mysten/seal';

import { bytesEqual, toHex } from '@aphotic/sdk/hash';

import { config } from '../../config';
import {
  buildCloseBatch,
  buildOpenBatch,
  buildRevealOrder,
  readSealedOrders,
  stateLabel,
  type LiveBatch,
  type SealedOrderRow,
} from '../../lib/batch';
import { truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import { decodeOrderPlaintext, orderCommitment } from '../../lib/order';
import { createSessionKey, decryptOrder, innerIdentity, sealConfigured } from '../../lib/seal';
import { describeTxError, useAphoticTx } from '../../lib/tx';
import { useAsyncAction } from '../../lib/useAsyncAction';
import { blobIdFromBytes, getBlob } from '../../lib/walrus';

export interface LifecyclePanelProps {
  readonly live: LiveBatch | null;
  readonly nowMs: number;
  readonly onChanged: () => void;
}

export function LifecyclePanel({ live, nowMs, onChanged }: LifecyclePanelProps) {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const tx = useAphoticTx();
  const orders = useAsyncAction<readonly SealedOrderRow[]>();
  const sessionRef = useRef<SessionKey | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId],
  ]);

  const batch = live?.batch ?? null;
  const rows = orders.state.data ?? [];
  const busy = tx.isPending || work !== null || orders.state.status === 'loading';

  const canClose = batch !== null && batch.state === 0 && BigInt(nowMs) >= batch.closeMs;
  const revealDeadline = batch === null ? 0n : batch.closedAtMs + batch.revealGraceMs;
  const canReveal = batch !== null && batch.state === 1 && BigInt(nowMs) <= revealDeadline;

  const loadOrders = async (): Promise<readonly SealedOrderRow[]> => {
    if (batch === null) throw new Error('no batch to read');
    return readSealedOrders(batch.objectId, Number(batch.orderCount));
  };

  /** One personal-message signature, reused for every reveal in this session. */
  const session = async (): Promise<SessionKey> => {
    if (sessionRef.current !== null && !sessionRef.current.isExpired()) return sessionRef.current;
    if (address === null) throw new Error('connect an address to request key shares');
    const key = await createSessionKey(address);
    const { signature } = await signPersonalMessage({ message: key.getPersonalMessage() });
    await key.setPersonalMessageSignature(signature);
    sessionRef.current = key;
    return key;
  };

  /** Fetch, decrypt and check ONE order. Returns null when it cannot be trusted. */
  const recover = async (row: SealedOrderRow, key: SessionKey) => {
    if (batch === null) return null;
    const blobId = blobIdFromBytes(row.blobId);
    const ciphertext = await getBlob(blobId);
    const plaintext = await decryptOrder({
      ciphertext,
      sessionKey: key,
      innerId: innerIdentity(batch.closeMs, batch.objectId),
    });
    const order = decodeOrderPlaintext(plaintext);
    if (!bytesEqual(orderCommitment(order), row.commitment)) return null;
    return order;
  };

  const revealMany = async (targets: readonly SealedOrderRow[]) => {
    setFailure(null);
    if (batch === null || targets.length === 0) return;
    try {
      setWork('Requesting key shares…');
      const key = await session();
      const recovered: { row: SealedOrderRow; order: Awaited<ReturnType<typeof recover>> }[] = [];
      for (const row of targets) {
        setWork(`Decrypting order ${row.index + 1} of ${targets.length}…`);
        recovered.push({ row, order: await recover(row, key) });
      }
      const usable = recovered.filter((r) => r.order !== null);
      const broken = recovered.length - usable.length;
      if (usable.length === 0) {
        setFailure(
          'None of the ciphertexts decrypted to an order matching its commitment. The commitment ' +
            'binds the plaintext, so those orders cannot be revealed by anyone — they will simply ' +
            'go unfilled.',
        );
        return;
      }
      setWork('Publishing the plaintexts…');
      const result = await tx.send((t) => {
        for (const { row, order } of usable) {
          if (order === null) continue;
          buildRevealOrder(t, {
            batchObjectId: batch.objectId,
            index: row.index,
            submitter: order.submitter,
            isBid: order.isBid,
            limitPrice: order.limitPrice,
            qtySats: order.qtySats,
            salt: order.salt,
          });
        }
      });
      if (result.status === 'success') {
        if (broken > 0) {
          setFailure(
            `${broken} order(s) were skipped: their ciphertext did not hash to the commitment on ` +
              'chain, so revealing them would abort ECommitmentMismatch.',
          );
        }
        onChanged();
        await orders.run(loadOrders);
      }
    } catch (err) {
      setFailure(describeTxError(err).message);
    } finally {
      setWork(null);
    }
  };

  const advance = async (build: Parameters<typeof tx.send>[0]) => {
    const result = await tx.send(build);
    if (result.status === 'success') onChanged();
  };

  const unrevealed = rows.filter((r) => !r.revealed);
  const mineUnrevealed = unrevealed.filter((r) => r.submitter === address);

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">The live batch</h3>
        <div className="ap-row">
          {batch === null ? null : (
            <span className="ap-badge">
              {stateLabel(batch.state)} · {batch.orderCount.toString()}/{batch.maxOrders.toString()}
            </span>
          )}
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || batch === null || busy}
            title={gap ?? (batch === null ? 'No batch has been opened' : 'Read the sealed order book')}
            onClick={() => void orders.run(loadOrders)}
          >
            {orders.state.status === 'loading' ? 'Reading…' : 'Read the book'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {orders.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{orders.state.error}</p>
        ) : null}
        {failure === null ? null : <p className="ap-reason ap-reason--error">{failure}</p>}

        {live === null ? (
          <p className="ap-reason">
            Not read yet. A batch holds at most {config.constants.maxBatchSize} orders.
          </p>
        ) : batch === null ? (
          <p className="ap-reason">
            No batch has ever been opened on this registry. Opening one is permissionless.
          </p>
        ) : (
          <div className="ap-grid ap-grid--2">
            <div className="ap-metric">
              <span className="ap-metric-label">State</span>
              <span className="ap-metric-value">{stateLabel(batch.state)}</span>
              <span className="ap-metric-sub">
                closes {new Date(Number(batch.closeMs)).toUTCString()}
              </span>
            </div>
            <div className="ap-metric">
              <span className="ap-metric-label">Revealed</span>
              <span className="ap-metric-value">
                {batch.revealedCount.toString()} / {batch.orderCount.toString()}
              </span>
              <span className="ap-metric-sub">
                {batch.state === 1
                  ? `grace ends ${new Date(Number(revealDeadline)).toUTCString()}`
                  : 'reveal opens once the batch is sealed'}
              </span>
            </div>
          </div>
        )}

        <div className="ap-row">
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || busy || !tx.canSend || (batch !== null && batch.state < 3)}
            title={
              gap ??
              tx.disabledReason ??
              (batch !== null && batch.state < 3
                ? 'A batch is already live. Only one window runs at a time.'
                : 'Open the next window. Permissionless — and the close time is not yours to choose.')
            }
            onClick={() => void advance((t) => buildOpenBatch(t))}
          >
            Open a window
          </button>
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || busy || !tx.canSend || !canClose}
            title={
              gap ??
              tx.disabledReason ??
              (canClose
                ? 'Seal the batch and freeze the ledger'
                : 'The batch cannot be closed before its scheduled instant — the contract asserts it (ETooEarly).')
            }
            onClick={() => void advance((t) => buildCloseBatch(t, batch!.objectId))}
          >
            Close the window
          </button>
        </div>

        {rows.length === 0 ? null : (
          <div className="ap-gate-section">
            <span className="ap-label">The sealed book</span>
            <ul className="ap-rows ap-gate-rows">
              {rows.map((row) => (
                <li key={row.index}>
                  <div className="ap-rowline">
                    <span className="ap-badge">#{row.index}</span>
                    <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                      {truncateMiddle(row.submitter)}
                      {row.submitter === address ? ' (you)' : ''}
                    </span>
                    <span className="aphotic-muted aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                      ct {truncateMiddle(toHex(row.ctHash), 6)}
                    </span>
                    <span className={row.revealed ? 'ap-badge ap-badge--live' : 'ap-badge'}>
                      {row.revealed ? 'revealed' : 'sealed'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="ap-reason">
              Public from the moment of submission, and none of it says how much, which side, or at
              what price. After close, nothing stays hidden — including unfilled orders.
            </p>
          </div>
        )}

        <div className="ap-row">
          <button
            type="button"
            className="ap-btn"
            disabled={!canReveal || busy || !tx.canSend || mineUnrevealed.length === 0 || !sealConfigured()}
            title={
              !sealConfigured()
                ? 'No Seal committee is configured in this build, so nothing can be decrypted.'
                : !canReveal
                  ? 'Reveal is open only while the batch is SEALED and inside the ten-minute grace window.'
                  : mineUnrevealed.length === 0
                    ? 'You have no unrevealed orders in this batch.'
                    : 'Fetch the key shares, decrypt your own orders and publish their plaintexts'
            }
            onClick={() => void revealMany(mineUnrevealed)}
          >
            Reveal mine
          </button>
          <button
            type="button"
            className="ap-btn ap-btn--primary"
            disabled={!canReveal || busy || !tx.canSend || unrevealed.length === 0 || !sealConfigured()}
            title={
              !canReveal
                ? 'Reveal is open only while the batch is SEALED and inside the grace window.'
                : unrevealed.length === 0
                  ? 'Every order in this batch is already revealed.'
                  : 'Reveal every outstanding order, including other people’s — the policy has no sender check'
            }
            onClick={() => void revealMany(unrevealed)}
          >
            Reveal all
          </button>
          {work === null ? null : <span className="aphotic-muted">{work}</span>}
        </div>

        {/* One line, but not an optional one: it is why "Reveal all" acts on
            other people's orders, and it is the answer to the obvious objection. */}
        <p className="ap-reason">
          Reveal is permissionless — the policy has no sender check — so nobody can grief a batch by
          going offline.
        </p>

        {tx.last === null ? null : tx.last.status === 'success' ? (
          <p className="ap-reason ap-reason--ok">
            Sent. <span className="aphotic-mono">{truncateMiddle(tx.last.digest, 8)}</span>
          </p>
        ) : (
          <p className="ap-reason ap-reason--error">{tx.last.message}</p>
        )}

      </div>
    </section>
  );
}

export default LifecyclePanel;
