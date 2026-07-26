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
// @facts      THE ASYNCHRONY IS THE PRODUCT, so it is on screen rather than hidden
// @facts        behind a spinner: you REQUEST, an epoch prices, then you CLAIM.
// @facts        The button says "Request" and never "Deposit", because nothing is
// @facts        deposited at a price until the admin multisig approves one.
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
// @facts        request against the boundary. Shown beside the countdown for that
// @facts        reason, and labelled as the epoch's rather than the address's.
// @implements export function PositionPanel(): JSX.Element
// @forbidden  a free-form amount field — the ladder is the only size control
// @forbidden  a read on mount — the panel reads when the user asks
// @forbidden  showing a share balance, an epoch or a claim before it was read
// @invariant  1. Nothing numeric renders until a read returned it.
// @invariant  2. No enabled control can abort for a reason we already know.
// @ac         renders unconfigured with the read disabled and the reason stated.
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import { DenominationLadder, type Denomination } from '../../components';
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

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ap-metric">
      <span className="ap-metric-label">{label}</span>
      <span className="ap-metric-value">{value}</span>
      {sub === undefined ? null : <span className="ap-metric-sub">{sub}</span>}
    </div>
  );
}

export function PositionPanel() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const tx = useAphoticTx();
  const position = useAsyncAction<Position>();
  const [depositDenom, setDepositDenom] = useState<Denomination | null>(null);
  const [redeemDenom, setRedeemDenom] = useState<Denomination | null>(null);

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

  const requestDeposit = async () => {
    if (data === null || address === null || depositDenom === null) return;
    await send((t) =>
      buildRequestDeposit(t, {
        typeArgs: data.typeArgs,
        sender: address,
        sats: depositDenom.sats,
        coinIds: data.baseCoins.map((c) => c.objectId),
      }),
    );
  };

  const requestRedeem = async () => {
    if (data === null || address === null || redeemDenom === null) return;
    await send((t) =>
      buildRequestRedeem(t, {
        typeArgs: data.typeArgs,
        sender: address,
        shares: redeemDenom.sats,
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

  const depositBlocked =
    data === null
      ? 'Read your position first — the deposit needs the vault’s type parameters and your coins.'
      : depositDenom === null
        ? 'Choose a denomination.'
        : data.snapshot.paused
          ? 'The vault is paused, so no new deposit is accepted. Redeeming and claiming still work.'
          : depositDenom.sats < data.snapshot.minDepositSats
            ? `Below the vault’s minimum of ${formatSats(data.snapshot.minDepositSats)} sats.`
            : baseHeld < depositDenom.sats
              ? `You hold ${formatBtc(baseHeld)} hBTC, which is less than this denomination.`
              : null;

  const redeemBlocked =
    data === null
      ? 'Read your position first.'
      : redeemDenom === null
        ? 'Choose a size.'
        : sharesHeld < redeemDenom.sats
          ? `You hold ${formatSats(sharesHeld)} share units, which is less than this size.`
          : null;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Your position</h3>
        <div className="ap-row">
          {data === null ? null : (
            <span className="ap-badge">epoch {data.snapshot.epoch.toString()}</span>
          )}
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
        {gap !== null ? (
          <p className="ap-reason ap-reason--warn">
            {gap} Every value on this panel would have to be invented, so none is shown. The
            variables are inlined at build time — this is a deploy-time gap, not a runtime one.
          </p>
        ) : null}

        {position.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{position.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            Nothing here reads on load. Press <strong>Read from chain</strong> and this panel shows
            your share balance, your outstanding receipts and the epoch price each one settles at —
            and nothing before then.
          </p>
        ) : (
          <>
            <div className="ap-grid ap-grid--2">
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
                sub="idle + deployed + in flight + native BTC"
              />
              <Metric
                label="This epoch’s pending legs"
                value={`${formatBtc(data.snapshot.pendingDepositAssets)} in`}
                sub={`${formatSats(data.snapshot.pendingRedeemShares)} shares out — the WINDOW's totals, not yours; approve_nav prices both legs at the one price`}
              />
              <Metric
                label="Last approved price"
                value={
                  data.snapshot.lastNavSupply === 0n
                    ? 'par (no shares yet)'
                    : `${formatSats(data.snapshot.lastNavAssets)} / ${formatSats(data.snapshot.lastNavSupply)}`
                }
                sub={
                  data.snapshot.lastNavAtMs === 0n
                    ? 'never approved'
                    : new Date(Number(data.snapshot.lastNavAtMs)).toUTCString()
                }
              />
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">This epoch, so far</span>
              <ul className="ap-rows ap-gate-rows">
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">
                      Pending deposits
                      <br />
                      <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                        hBTC in the vault, not yet priced and not yet backing a share
                      </span>
                    </span>
                    <span className="ap-num">
                      {formatBtc(data.snapshot.pendingDepositAssets, { suffix: true })}
                    </span>
                  </div>
                </li>
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">
                      Pending redemptions
                      <br />
                      <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                        shares surrendered into escrow, burned at the next approval
                      </span>
                    </span>
                    <span className="ap-num">
                      {formatSats(data.snapshot.pendingRedeemShares)} shares
                    </span>
                  </div>
                </li>
              </ul>
              <p className="ap-reason">
                Both totals are the whole epoch&rsquo;s, not yours — every request in the window
                prices at the <em>same</em> approved NAV, which is what removes the incentive to
                time a deposit against the boundary. They clear together when the admin multisig
                approves, and epoch{' '}
                <strong>{data.snapshot.epoch.toString()}</strong> becomes epoch{' '}
                {(data.snapshot.epoch + 1n).toString()}.
              </p>
            </div>

            {data.snapshot.paused ? (
              <p className="ap-reason ap-reason--warn">
                The vault is <strong>paused</strong>. New deposits are refused; redeeming and
                claiming are not. Pausing stops new risk, not the exit — that asymmetry is in the
                contract, not in this screen.
              </p>
            ) : null}
          </>
        )}

        {/* ── request a deposit ── */}
        <div className="ap-gate-section">
          <span className="ap-label">Request a deposit</span>
          <DenominationLadder selected={depositDenom?.index ?? null} onSelect={setDepositDenom} label="Amount" />
          <div className="ap-row">
            <button
              type="button"
              className="ap-btn ap-btn--primary"
              disabled={depositBlocked !== null || busy || !tx.canSend}
              title={depositBlocked ?? tx.disabledReason ?? 'Move your hBTC into the pending balance and take a receipt'}
              onClick={() => void requestDeposit()}
            >
              Request
            </button>
            <span className="aphotic-muted">
              {depositDenom === null ? 'No size chosen.' : `${depositDenom.label} → a receipt, priced next epoch`}
            </span>
          </div>
          <p className="ap-reason">
            {depositBlocked ?? tx.disabledReason ?? (
              <>
                Your hBTC moves into the vault&rsquo;s pending balance and you hold a receipt. No
                shares are minted yet: they are minted at the price the admin multisig approves for
                this epoch, which is what makes the request/settle split real rather than cosmetic.
              </>
            )}
          </p>
        </div>

        {/* ── request a redemption ── */}
        <div className="ap-gate-section">
          <span className="ap-label">Request a redemption</span>
          <DenominationLadder selected={redeemDenom?.index ?? null} onSelect={setRedeemDenom} label="Shares" />
          <div className="ap-row">
            <button
              type="button"
              className="ap-btn"
              disabled={redeemBlocked !== null || busy || !tx.canSend}
              title={redeemBlocked ?? tx.disabledReason ?? 'Surrender shares now; they burn at the next approved NAV'}
              onClick={() => void requestRedeem()}
            >
              Request
            </button>
            <span className="aphotic-muted">
              {redeemDenom === null ? 'No size chosen.' : `${formatSats(redeemDenom.sats)} share units`}
            </span>
          </div>
          <p className="ap-reason">
            {redeemBlocked ??
              'Shares are surrendered now and burned at the next approved NAV. This path is deliberately not pause-gated.'}
          </p>
        </div>

        {/* ── receipts ── */}
        <div className="ap-gate-section">
          <span className="ap-label">Your receipts</span>
          {data === null ? (
            <p className="ap-reason">Not read yet.</p>
          ) : data.receipts.length === 0 ? (
            <p className="ap-reason">
              This address holds no receipts. A receipt is a bearer object — whoever holds it claims
              it — which is why this lists what you own rather than what you once asked for.
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
                          <span className="aphotic-muted">{preview ?? '—'}</span>
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
            The amount beside a claimable receipt is computed here, in your browser, with the same
            rounding-down <code>mul_div</code> the contract runs. Round-down is subadditive, so the
            sum of the individual claims can never exceed the epoch total — the dust stays with the
            vault and never with a claimant.
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
