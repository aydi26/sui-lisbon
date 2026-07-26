// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.2 (the batch), §7.4 (what is and is not hidden)
// @spec       docs/DESIGN-V2.md §3 (the identity, the cut-off, plaintext binding), D9
// @rules      G7 G8 G10
// @depends    ../../lib/order.ts · ../../lib/seal.ts · ../../lib/walrus.ts
//             · ../../lib/batch.ts · ../../components (F1)
// @facts      WHAT LANDS ON CHAIN: a commitment to the PLAINTEXT, a hash of the
// @facts        ciphertext, and a Walrus blob id. No amount, no side, no price.
// @facts        The commitment binds the plaintext — blake2b256(bcs(Order)) — so
// @facts        nobody can publish one blob and later claim a different order
// @facts        decrypted from it. `ct_hash` and `blob_id` only say where to look.
// @facts      THE ORDER IS SEALED BEFORE IT IS PUBLISHED, in that order, and the
// @facts        submit transaction is built only after Walrus returns an id. If
// @facts        any step fails the transaction is never offered — there is no path
// @facts        through this component that submits an unsealed order (D9).
// @facts      THE SUBMIT BUTTON GREYS 60 s BEFORE CLOSE because the CONTRACT
// @facts        refuses there: `submit_order` asserts
// @facts        `now + submit_cutoff_ms <= close_ms` (ESubmitWindowClosed). The
// @facts        window exists so a submit can never race an early key release
// @facts        caused by key-server clock skew.
// @facts      BOTH LADDERS ARE COARSE. A precise limit price fingerprints an order
// @facts        as effectively as a precise amount, and a fingerprinted order in a
// @facts        uniform batch has an anonymity set of one.
// @facts      TRIMMED (2026-07-26): the reasoning behind the ladders, the
// @facts        commitment and the cut-off is TEACHING and lives on /docs. This
// @facts        ticket keeps one-line captions and the refusals — a caption is
// @facts        what a control needs; a lecture is what a docs page is for.
// @facts      ⚠ THE SEAL LINE IS UNCONDITIONAL AND IS THE ONLY PLACE THIS ROUTE
// @facts        STATES D9 SINCE THE COMMITTEE DASHBOARD MOVED TO /verify: an
// @facts        order that cannot be sealed is not submitted, and we never fall
// @facts        back to plaintext. Do not gate it on a wallet or a read.
// @implements export function OrderTicket(props): JSX.Element
// @forbidden  a free-form amount OR price field
// @forbidden  submitting anything that was not sealed
// @invariant  1. Every failure that can be known before the wallet opens is stated
//                on the disabled control.
// @invariant  2. The cut-off reason names the contract rule, not a UI preference.
// @invariant  3. The no-plaintext-fallback line renders unconditionally.
// @ac         renders unconfigured with submit disabled and the reason stated.
// @verify     cd app && npm test -- batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import { toHex } from '@aphotic/sdk/hash';

import { DenominationLadder, type Denomination } from '../../components';
import { config } from '../../config';
import { buildSubmitOrder, type LiveBatch } from '../../lib/batch';
import { formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import {
  DISCOUNT_STEPS_BPS,
  encodeOrderPlaintext,
  newSalt,
  orderCommitment,
  priceForDiscountBps,
  type PlainOrder,
} from '../../lib/order';
import { encryptOrder, sealConfigured } from '../../lib/seal';
import { describeTxError, useAphoticTx } from '../../lib/tx';
import { blobIdBytes, ciphertextHash, putBlob, walrusConfigured } from '../../lib/walrus';

export interface OrderTicketProps {
  readonly live: LiveBatch | null;
  readonly nowMs: number;
  readonly onSubmitted: () => void;
}

type Side = 'bid' | 'ask';

export function OrderTicket({ live, nowMs, onSubmitted }: OrderTicketProps) {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const tx = useAphoticTx();
  const [side, setSide] = useState<Side>('bid');
  const [denom, setDenom] = useState<Denomination | null>(null);
  const [discountBps, setDiscountBps] = useState<bigint>(DISCOUNT_STEPS_BPS[1] ?? 0n);
  const [stage, setStage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ commitment: string; blobId: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId],
  ]);

  const batch = live?.batch ?? null;
  const cutoffMs = batch === null ? BigInt(config.constants.submitCutoffMs) : batch.submitCutoffMs;
  const closeMs = batch === null ? 0n : batch.closeMs;
  const insideCutoff = batch !== null && BigInt(nowMs) + cutoffMs > closeMs;

  const blocked =
    gap !== null
      ? gap
      : !sealConfigured()
        ? `Only ${config.seal.keyServerIds.length} Seal key server(s) are configured for a threshold of ${config.seal.threshold}. The order cannot be sealed, and we never submit one in the clear.`
        : !walrusConfigured()
          ? 'VITE_WALRUS_PUBLISHER is empty, so the ciphertext has nowhere to go and the blob id on chain would be a fiction.'
          : live === null
            ? 'Read the live batch first.'
            : batch === null
              ? 'No batch is open. Opening one is permissionless.'
              : batch.state !== 0
                ? `This batch is ${['OPEN', 'SEALED', 'CLEARING', 'SETTLED'][batch.state] ?? batch.state}, so it no longer accepts orders.`
                : insideCutoff
                  ? 'Submission is closed for the last 60 s before the boundary — the contract asserts it (ESubmitWindowClosed), so no submit can race an early key release.'
                  : denom === null
                    ? 'Choose a size.'
                    : address === null
                      ? 'Connect an address first.'
                      : null;

  const submit = async () => {
    if (blocked !== null || batch === null || denom === null || address === null) return;
    setReceipt(null);
    setFailure(null);
    try {
      const order: PlainOrder = {
        submitter: address,
        isBid: side === 'bid',
        limitPrice: priceForDiscountBps(discountBps),
        qtySats: denom.sats,
        salt: newSalt(),
      };
      const commitment = orderCommitment(order);

      setStage('Sealing under the batch’s time-lock identity…');
      const sealed = await encryptOrder({
        closeMs: batch.closeMs,
        batchObjectId: batch.objectId,
        plaintext: encodeOrderPlaintext(order),
      });

      setStage('Publishing the ciphertext to Walrus…');
      const blobId = await putBlob(sealed.ciphertext);

      setStage('Submitting the commitment…');
      const result = await tx.send((t) =>
        buildSubmitOrder(t, {
          batchObjectId: batch.objectId,
          commitment,
          ctHash: ciphertextHash(sealed.ciphertext),
          blobId: blobIdBytes(blobId),
        }),
      );
      if (result.status === 'success') {
        setReceipt({ commitment: toHex(commitment), blobId });
        onSubmitted();
      }
    } catch (err) {
      // The send path never throws; the seal and Walrus legs can, and a thrown
      // error here would be an unhandled rejection nobody sees. It is rendered.
      setFailure(describeTxError(err).message);
    } finally {
      setStage(null);
    }
  };

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Place a sealed order</h3>
        {batch === null ? null : (
          <span className={insideCutoff || batch.state !== 0 ? 'ap-badge ap-badge--warn' : 'ap-badge'}>
            {/* The badge reports the batch's ACTUAL state. Saying "open" over a
                SEALED batch would be the one thing this screen must never do:
                describe a window as available when the contract has closed it. */}
            {batch.state !== 0
              ? `batch ${batch.batchId.toString()} ${['open', 'sealed', 'clearing', 'settled'][batch.state] ?? 'unknown'}`
              : insideCutoff
                ? 'submission closed'
                : `batch ${batch.batchId.toString()} open`}
          </span>
        )}
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        <div className="ap-row" role="group" aria-label="Side">
          {(['bid', 'ask'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={side === s ? 'ap-btn ap-btn--primary' : 'ap-btn'}
              aria-pressed={side === s}
              onClick={() => setSide(s)}
            >
              {s === 'bid' ? 'Buy hBTC' : 'Sell hBTC'}
            </button>
          ))}
        </div>

        <DenominationLadder selected={denom?.index ?? null} onSelect={setDenom} label="Size" />

        <div className="ap-ladder">
          <span className="ap-eyebrow">Limit · discount to par</span>
          <div className="ap-ladder-row">
            {DISCOUNT_STEPS_BPS.map((bps) => (
              <button
                key={bps.toString()}
                type="button"
                className={discountBps === bps ? 'ap-btn ap-btn--primary' : 'ap-btn'}
                aria-pressed={discountBps === bps}
                onClick={() => setDiscountBps(bps)}
              >
                <span className="ap-num">{bps === 0n ? 'par' : `−${bps.toString()} bps`}</span>
                <span className="ap-ladder-sub">{formatSats(priceForDiscountBps(bps))}</span>
              </button>
            ))}
          </div>
          <p className="ap-reason">
            {side === 'bid'
              ? 'You pay at most par minus this discount.'
              : 'You accept at least par minus this discount.'}{' '}
            Coarse on purpose: a precise price fingerprints an order as well as a precise amount.
          </p>
        </div>

        <div className="ap-row">
          <button
            type="button"
            className="ap-btn ap-btn--primary"
            disabled={blocked !== null || tx.isPending || stage !== null || !tx.canSend}
            title={blocked ?? tx.disabledReason ?? 'Seal the order, publish the ciphertext, submit the commitment'}
            onClick={() => void submit()}
          >
            {stage === null ? 'Seal and send' : 'Working…'}
          </button>
          <span className="aphotic-muted">
            {denom === null
              ? 'Choose a denomination.'
              : `${denom.label} · ${side === 'bid' ? 'buy' : 'sell'} · ${discountBps === 0n ? 'par' : `−${discountBps.toString()} bps`}`}
          </span>
        </div>

        {stage === null ? null : <p className="ap-reason">{stage}</p>}
        {blocked === null ? null : <p className="ap-reason ap-reason--warn">{blocked}</p>}
        {failure === null ? null : <p className="ap-reason ap-reason--error">{failure}</p>}
        {tx.last !== null && tx.last.status === 'error' ? (
          <p className="ap-reason ap-reason--error">{tx.last.message}</p>
        ) : null}

        {receipt === null ? null : (
          <p className="ap-reason ap-reason--ok">
            Submitted. Commitment{' '}
            <span className="aphotic-mono">{truncateMiddle(receipt.commitment, 8)}</span>, ciphertext
            at Walrus blob <span className="aphotic-mono">{truncateMiddle(receipt.blobId, 8)}</span>.
          </p>
        )}

        {/* Two lines, both load-bearing: what lands on chain, and the refusal.
            Neither is gated on a wallet, a read or a config — the second one is
            this route's only statement of D9. */}
        <p className="ap-reason">
          What lands on chain is a commitment that binds the plaintext, a blob id and a reference to
          your internal balance: no amount, no side, no price.
        </p>
        <p className="ap-reason">
          The order is sealed to the {config.seal.threshold}-of-
          {Math.max(config.seal.keyServerIds.length, 5)} Seal committee before it is published. With
          no committee wired this control refuses — we never fall back to plaintext.
        </p>
      </div>
    </section>
  );
}

export default OrderTicket;
