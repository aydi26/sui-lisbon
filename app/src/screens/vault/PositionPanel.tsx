// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §1 (async request/settle), §6.2, §7.7
// @spec       docs/DESIGN-V2.md §6 (approve_nav prices BOTH legs at one price;
//             claim_deposit recomputes the same round-down mul_div per receipt)
// @rules      G7 G8 G10
// @depends    ../../lib/vault.ts (F2) · ../../lib/tx.ts · ../../lib/useAsyncAction.ts
//             · ../../components (F1)
// @facts      THE DOING SURFACE OF /vault, in the order a holder needs it: what you
// @facts        hold, then the one control that changes it, then what you can claim.
// @facts        The protocol explanation lives in /docs; this panel keeps captions.
// @facts      THE ASYNCHRONY IS THE PRODUCT, so it stays on screen rather than
// @facts        hidden behind a spinner: you REQUEST, an epoch prices, then you
// @facts        CLAIM. The button says "Request" and never "Deposit", because
// @facts        nothing is deposited at a price until the admin multisig approves
// @facts        one — and it never says "Redeem" either, for the same reason.
// @facts      ONE LADDER, TWO DIRECTIONS. A direction toggle in front of a single
// @facts        VaultSizeLadder, rather than two ladders stacked. The toggle labels
// @facts        avoid the words "deposit" and "redeem" so no enabled control ever
// @facts        reads as a write.
// @facts      ⚠ THAT LADDER IS **NOT** DenominationLadder, AND THE SWAP WAS A BUG FIX.
// @facts        This panel used the NOTE ladder, whose floor is 1_000_000 sats
// @facts        (0.01 hBTC), while the live vault's `min_deposit_sats` is 1_000 —
// @facts        the screen demanded a THOUSAND TIMES what the contract does. Since a
// @facts        testnet faucet pays far less than 0.01 hBTC, every tier was
// @facts        unaffordable and every control disabled: /vault looked broken while
// @facts        the chain was fine (observed 2026-07-26, wallet 663_717 sats).
// @facts        The note ladder was never wrong — it is for a different object. G9
// @facts        fixes NOTE denominations because escrow must not leak order size; a
// @facts        vault request publishes its amount in the receipt and in
// @facts        `pending_deposit_assets`, so there was no size to hide and the
// @facts        borrowed floor bought nothing. DENOMINATIONS is untouched.
// @facts      A receipt is claimable iff `receipt.epoch < vault.epoch`. Before
// @facts        that the row says "prices at epoch N" and offers no control — the
// @facts        contract would abort ENotYetPriced, and an enabled button that
// @facts        cannot complete is the thing this app refuses to ship.
// @facts      The claim PREVIEW uses the same round-down mul_div the contract
// @facts        runs. Round-down is subadditive, so Σ per-receipt ≤ the epoch
// @facts        total: the dust stays with the vault, never with a claimant. The
// @facts        preview can therefore never overstate what you will receive.
// @facts      ⚠ A PAUSED VAULT STILL LETS HOLDERS LEAVE. `request_redeem` and
// @facts        `claim_redeem` are not pause-gated; only the deposit request is.
// @facts      THE EPOCH TOTALS ARE THE WINDOW'S, NOT YOURS. `pending_deposit_assets`
// @facts        and `pending_redeem_shares` are the vault's own running sums for the
// @facts        open epoch, and `approve_nav` prices BOTH legs at the ONE price it
// @facts        writes — which is exactly what removes the incentive to time a
// @facts        request against the boundary. Labelled as the epoch's, in one line.
// @implements export function PositionPanel(): JSX.Element
// @forbidden  a free-form amount field — the ladder is the only size control
// @forbidden  a read on mount — the panel reads when the user asks
// @forbidden  showing a share balance, an epoch or a claim before it was read
// @forbidden  a disabled control whose reason is only beside it and not on it
// @invariant  1. Nothing numeric renders until a read returned it.
// @invariant  2. No enabled control can abort for a reason we already know, and
//                every disabled one carries that reason in its own `title`.
// @ac         renders unconfigured with the read disabled and the reason stated.
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import { VaultSizeLadder, type VaultSize } from '../../components';
import { config } from '../../config';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import { useAphoticTx } from '../../lib/tx';
import { useAsyncAction } from '../../lib/useAsyncAction';
import {
  assetsForShares,
  buildClaimDeposit,
  buildClaimRedeem,
  buildRequestDeposit,
  buildRequestRedeem,
  listCoinsOf,
  listReceipts,
  readEpochPrice,
  readVaultSnapshot,
  readVaultTypeArgs,
  sharesForAssets,
  totalBalance,
  type CoinRow,
  type ReceiptRow,
  type VaultSnapshot,
  type VaultTypeArgs,
} from '../../lib/vault';

interface Position {
  readonly typeArgs: VaultTypeArgs;
  readonly snapshot: VaultSnapshot;
  readonly receipts: readonly ReceiptRow[];
  readonly baseCoins: readonly CoinRow[];
  readonly shareCoins: readonly CoinRow[];
  /** Epoch → (nav_assets, nav_supply), for every priced receipt held. */
  readonly prices: ReadonlyMap<string, { readonly navAssets: bigint; readonly navSupply: bigint }>;
}

/** Which way the one ladder points. Neither label may read as a write verb. */
type Direction = 'in' | 'out';

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ap-metric">
      <span className="ap-metric-label">{label}</span>
      <span className="ap-metric-value">{value}</span>
      {sub === undefined ? null : <span className="ap-metric-sub">{sub}</span>}
    </div>
  );
}

const METRIC_ROW = {
  display: 'grid',
  gap: 'var(--space-5)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
} as const;

export function PositionPanel() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const tx = useAphoticTx();
  const position = useAsyncAction<Position>();
  const [direction, setDirection] = useState<Direction>('in');
  const [size, setSize] = useState<VaultSize | null>(null);

  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_VAULT_ID', config.aphotic.vaultId],
  ]);

  const load = async (): Promise<Position> => {
    if (address === null) throw new Error('no address connected');
    const typeArgs = await readVaultTypeArgs();
    const [snapshot, receipts, baseCoins, shareCoins] = await Promise.all([
      readVaultSnapshot(typeArgs),
      listReceipts(address),
      listCoinsOf(address, typeArgs[0]),
      listCoinsOf(address, typeArgs[2]),
    ]);
    // Only PRICED epochs have an entry; asking for an unpriced one aborts.
    const priced = [...new Set(receipts.filter((r) => r.epoch < snapshot.epoch).map((r) => r.epoch))];
    const prices = new Map<string, { navAssets: bigint; navSupply: bigint }>();
    for (const epoch of priced) {
      prices.set(epoch.toString(), await readEpochPrice(typeArgs, epoch));
    }
    return { typeArgs, snapshot, receipts, baseCoins, shareCoins, prices };
  };

  const data = position.state.data;
  const busy = position.state.status === 'loading' || tx.isPending;

  const send = async (build: Parameters<typeof tx.send>[0]) => {
    const result = await tx.send(build);
    if (result.status === 'success') await position.run(load);
  };

  const request = async () => {
    if (data === null || address === null || size === null) return;
    await send((t) =>
      direction === 'in'
        ? buildRequestDeposit(t, {
            typeArgs: data.typeArgs,
            sender: address,
            sats: size.sats,
            coinIds: data.baseCoins.map((c) => c.objectId),
          })
        : buildRequestRedeem(t, {
            typeArgs: data.typeArgs,
            sender: address,
            shares: size.sats,
            coinIds: data.shareCoins.map((c) => c.objectId),
          }),
    );
  };

  const claim = async (row: ReceiptRow) => {
    if (data === null || address === null) return;
    await send((t) =>
      row.kind === 'deposit'
        ? buildClaimDeposit(t, { typeArgs: data.typeArgs, sender: address, receiptId: row.objectId })
        : buildClaimRedeem(t, { typeArgs: data.typeArgs, sender: address, receiptId: row.objectId }),
    );
  };

  const baseHeld = data === null ? 0n : totalBalance(data.baseCoins);
  const sharesHeld = data === null ? 0n : totalBalance(data.shareCoins);

  /**
   * What the ladder is measured in, and against what. Both are `null` until a read
   * returns them: the floor is the vault's own `min_deposit_sats`, never a constant
   * in this app, and a holding of `0` is not the same claim as "not read yet".
   */
  const minSats = data === null ? null : data.snapshot.minDepositSats;
  const heldUnits = data === null ? null : direction === 'in' ? baseHeld : sharesHeld;

  /** The one reason string. It goes on the control, not only beside it. */
  const blocked =
    data === null
      ? 'Read your position first — the request needs the vault’s type parameters and your coins.'
      : size === null
        ? 'Choose a size.'
        : direction === 'in'
          ? data.snapshot.paused
            ? 'The vault is paused, so no new deposit is accepted. Leaving still works.'
            : // Belt and braces: the ladder is anchored ON this value, so a tier can
              // never fall below it. Kept so a future ladder change cannot silently
              // start offering a size that aborts EBelowMinDeposit.
              size.sats < data.snapshot.minDepositSats
              ? `Below the vault’s minimum of ${formatSats(data.snapshot.minDepositSats)}.`
              : baseHeld < size.sats
                ? `You hold ${formatBtc(baseHeld)} hBTC, less than this size.`
                : null
          : sharesHeld < size.sats
            ? `You hold ${formatSats(sharesHeld)} share units, less than this size.`
            : null;

  const caption =
    size === null
      ? 'No size chosen.'
      : direction === 'in'
        ? `${size.label} in → a receipt, priced at the next approval`
        : `${size.sats.toLocaleString('en-US')} share units out → burned at the next approved NAV`;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Your position</h3>
        <div className="ap-row">
          {data === null ? null : (
            <span className="ap-badge">epoch {data.snapshot.epoch.toString()}</span>
          )}
          {data !== null && data.snapshot.paused ? (
            <span className="ap-badge ap-badge--warn">paused · exits open</span>
          ) : null}
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || busy || address === null}
            title={gap ?? (address === null ? 'Connect an address first' : 'Read the vault and your receipts')}
            onClick={() => void position.run(load)}
          >
            {position.state.status === 'loading' ? 'Reading…' : 'Read from chain'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}

        {position.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{position.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            Nothing here reads on load. Press <strong>Read from chain</strong> for your shares, your
            receipts and the epoch each one settles at.
          </p>
        ) : (
          <>
            <div style={METRIC_ROW}>
              <Metric
                label="Shares held"
                value={formatSats(sharesHeld)}
                sub={`${formatSats(data.snapshot.committedSupply)} committed supply`}
              />
              <Metric
                label="hBTC in your wallet"
                value={formatBtc(baseHeld, { suffix: true })}
                sub={`${data.baseCoins.length} coin object(s)`}
              />
              <Metric
                label="Vault NAV"
                value={formatBtc(data.snapshot.navAssets, { suffix: true })}
                sub="four legs, itemised below"
              />
              <Metric
                label="Last approved price"
                value={
                  data.snapshot.lastNavSupply === 0n
                    ? 'par'
                    : `${formatSats(data.snapshot.lastNavAssets)} / ${formatSats(data.snapshot.lastNavSupply)}`
                }
                sub={
                  data.snapshot.lastNavAtMs === 0n
                    ? 'never approved — no shares yet'
                    : new Date(Number(data.snapshot.lastNavAtMs)).toUTCString()
                }
              />
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">This epoch, so far</span>
              <ul className="ap-rows ap-gate-rows">
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">Pending deposits</span>
                    <span className="ap-num">
                      {formatBtc(data.snapshot.pendingDepositAssets, { suffix: true })}
                    </span>
                  </div>
                </li>
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">Pending redemptions</span>
                    <span className="ap-num">
                      {formatSats(data.snapshot.pendingRedeemShares)} shares
                    </span>
                  </div>
                </li>
              </ul>
              <p className="ap-reason">
                The window&rsquo;s totals, not yours: <code>approve_nav</code> prices both legs at
                the one price it writes.
              </p>
            </div>
          </>
        )}

        {/* ── the one size control, pointed either way ── */}
        <div className="ap-gate-section">
          <span className="ap-label">Request</span>
          <div className="ap-row" role="group" aria-label="Direction">
            <button
              type="button"
              className={direction === 'in' ? 'ap-btn ap-btn--primary' : 'ap-btn'}
              aria-pressed={direction === 'in'}
              title="Move hBTC into the vault and take a receipt"
              onClick={() => setDirection('in')}
            >
              hBTC → shares
            </button>
            <button
              type="button"
              className={direction === 'out' ? 'ap-btn ap-btn--primary' : 'ap-btn'}
              aria-pressed={direction === 'out'}
              title="Surrender shares into escrow and take a receipt"
              onClick={() => setDirection('out')}
            >
              shares → hBTC
            </button>
          </div>

          <VaultSizeLadder
            selected={size?.index ?? null}
            onSelect={setSize}
            minSats={minSats}
            heldUnits={heldUnits}
            unit={direction === 'in' ? 'sats' : 'shares'}
            label={direction === 'in' ? 'Amount' : 'Shares'}
          />

          <div className="ap-row">
            <button
              type="button"
              className="ap-btn ap-btn--primary"
              disabled={blocked !== null || busy || !tx.canSend}
              title={
                blocked ??
                tx.disabledReason ??
                (direction === 'in'
                  ? 'Move your hBTC into the pending balance and take a receipt'
                  : 'Surrender shares now; they burn at the next approved NAV')
              }
              onClick={() => void request()}
            >
              Request
            </button>
            <span className="aphotic-muted">{caption}</span>
          </div>

          <p className="ap-reason">
            {blocked ??
              tx.disabledReason ??
              'No shares are minted and none are burned until the admin multisig approves a price for this epoch.'}
          </p>
        </div>

        {/* ── receipts ── */}
        <div className="ap-gate-section">
          <span className="ap-label">Your receipts</span>
          {data === null ? (
            <p className="ap-reason">Not read yet.</p>
          ) : data.receipts.length === 0 ? (
            <p className="ap-reason">
              This address holds no receipts. A receipt is a bearer object, so this lists what you
              own rather than what you once asked for.
            </p>
          ) : (
            <ul className="ap-rows ap-gate-rows">
              {data.receipts.map((row) => {
                const priced = row.epoch < data.snapshot.epoch;
                const price = data.prices.get(row.epoch.toString());
                const preview =
                  price === undefined
                    ? null
                    : row.kind === 'deposit'
                      ? `${formatSats(sharesForAssets(row.amount, price.navAssets, price.navSupply))} shares`
                      : `${formatBtc(assetsForShares(row.amount, price.navAssets, price.navSupply), { suffix: true })}`;
                return (
                  <li key={row.objectId}>
                    <div className="ap-rowline">
                      <span className="ap-badge">{row.kind}</span>
                      <span className="ap-wallet-name">
                        <span className="aphotic-mono">{truncateMiddle(row.objectId)}</span>{' '}
                        <span className="aphotic-muted">
                          {row.kind === 'deposit'
                            ? `${formatBtc(row.amount, { suffix: true })} in`
                            : `${formatSats(row.amount)} shares in`}
                        </span>
                      </span>
                      {priced ? (
                        <>
                          <span className="ap-num">{preview ?? '—'}</span>
                          <button
                            type="button"
                            className="ap-btn ap-btn--primary"
                            disabled={busy || !tx.canSend}
                            title={tx.disabledReason ?? `Settle at the epoch ${row.epoch.toString()} price`}
                            onClick={() => void claim(row)}
                          >
                            Claim
                          </button>
                        </>
                      ) : (
                        <span className="aphotic-muted">
                          prices at epoch {row.epoch.toString()} — not yet approved
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="ap-reason">
            Previewed in your browser with the contract&rsquo;s own round-down <code>mul_div</code>,
            so it can never overstate: the dust stays with the vault.
          </p>
        </div>

        {tx.last === null ? null : tx.last.status === 'success' ? (
          <p className="ap-reason ap-reason--ok">
            Sent. <span className="aphotic-mono">{truncateMiddle(tx.last.digest, 8)}</span>
            {tx.last.confirmed ? ' — confirmed on the read node.' : ' — not yet visible on the read node.'}
          </p>
        ) : (
          <p className="ap-reason ap-reason--error">{tx.last.message}</p>
        )}
      </div>
    </section>
  );
}

export default PositionPanel;
