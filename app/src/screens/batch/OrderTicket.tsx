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
// @implements export function OrderTicket(props): JSX.Element
// @forbidden  a free-form amount OR price field
// @forbidden  submitting anything that was not sealed
// @invariant  1. Every failure that can be known before the wallet opens is stated
//                on the disabled control.
// @invariant  2. The cut-off reason names the contract rule, not a UI preference.
// @ac         renders unconfigured with submit disabled and the reason stated.
// @verify     cd app && npm test -- batchScreen
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
              ? 'No batch has been opened yet. Opening one is permissionless — anyone can, and the close time is not theirs to choose.'
              : batch.state !== 0
                ? `This batch is ${['OPEN', 'SEALED', 'CLEARING', 'SETTLED'][batch.state] ?? batch.state}, so it no longer accepts orders.`
                : insideCutoff
                  ? 'Submission is closed for the last 60 seconds before the boundary. The contract asserts it — a submit landing there would abort ESubmitWindowClosed — so that no submit can race an early key release caused by key-server clock skew.'
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
              ? 'You pay at most par minus this discount. Orders strictly inside the cross fill fully; orders exactly at the clearing price are pro-rated.'
              : 'You accept at least par minus this discount. Limit safety is asserted per fill, not merely by construction.'}{' '}
            The price ladder is coarse for the same reason the size ladder is: a precise limit price
            fingerprints an order just as effectively as a precise amount. Par is one quote sat per
            base sat — {formatSats(priceForDiscountBps(0n))} at the contract&rsquo;s price scale.
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
            Keep nothing: after close, anyone can fetch that blob, obtain the key shares and reveal
            it for you.
          </p>
        )}

        <p className="ap-reason">
          Nothing you choose here is written on chain in the clear. What lands is a commitment to
          the plaintext order, a Walrus blob id, and a reference to your internal balance — no
          amount, no side, no price. The commitment binds the plaintext rather than the ciphertext,
          so nobody can publish one blob and later claim a different order decrypted from it.
        </p>
      </div>
    </section>
  );
}

export default OrderTicket;
