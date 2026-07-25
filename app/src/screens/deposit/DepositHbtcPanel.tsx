// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T5.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit), §2.3 (React Query drives reads)
// @spec       move/sources/vault.move deposit_btc (T1.1, DONE) · docs/DEPLOYED.md v3
// @rules      G1 G2 G6 G7 G8 G9 G10
// @depends    ./depositPtb.ts · ./useHbtcCoins.ts · ./useVaultPosition.ts
//             ./useBookMid.ts (all T3.1) · ../../lib/tx.ts (T3.4)
//             ../exit/CallPreview.tsx (T3.2 — one preview component, both screens)
// @facts      THE SUI LEG, and the only write on this screen. hBTC is a fungible
// @facts        Coin<BTC>: an address that already holds it can deposit into the
// @facts        vault in ONE checkpoint, with no bridge and no Bitcoin latency at
// @facts        all (G1). The ~70-minute wait above is how hBTC is MINTED, not how
// @facts        it moves once it exists.
// @facts      Move asserts this button must respect (vault.move deposit_btc):
// @facts        EPaused      — a paused vault refuses deposits (it still allows exits)
// @facts        EZeroDeposit — amount must be > 0
// @facts        EZeroNav     — only once total_shares > 0 AND nav_before == 0
// @facts        EZeroShares  — a deposit too small to round to one share
// @facts      book_mid: while the vault holds zero DBUSDC, nav_sats returns before
// @facts        the price assert, so the argument is provably unused — we still pass
// @facts        the real DeepBook mid when one exists, and NEVER a Pyth number in
// @facts        its place (G9). The panel says which of the two it sent.
// @implements export function DepositHbtcPanel(): JSX.Element
// @forbidden  a canonical on-chain id literal — everything from config (G7)
// @forbidden  `number` for sats — bigint only (G10)
// @forbidden  a clickable-and-silent control: every disabled state names its reason
// @invariant  1. The button is enabled ONLY when a send can actually succeed;
//                otherwise it is disabled and `reason` is rendered beside it.
//             2. Every figure shown is read from chain, or is absent. No fixture.
//             3. After a success the balance and the position are re-read, so the
//                screen never keeps showing pre-transaction numbers.
// @ac         docs/APP.md §7 A4 A6 A9 A10 A11
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';

import { config } from '../../config';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { suiTxUrl } from '../../lib/explorer';
import { useAphoticTx } from '../../lib/tx';
import { useAphoticSession } from '../../session/useSession';
import { CallPreview } from '../exit/CallPreview';

import { buildDepositBtcTx, describeDepositCall, missingDepositTargets } from './depositPtb';
import { useBookMid } from './useBookMid';
import { useHbtcCoins } from './useHbtcCoins';
import { sharePriceScaled, useVaultPosition } from './useVaultPosition';

/** Digits only, with human separators tolerated. Never `number`. */
function parseSats(text: string): bigint | null {
  const cleaned = text.replace(/[\s,_]/g, '');
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null;
  return BigInt(cleaned);
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="dep-figure">
      <span className="dep-figure-k">{label}</span>
      <span className="dep-figure-v ap-num">{value}</span>
      {note === undefined ? null : <span className="dep-figure-n">{note}</span>}
    </div>
  );
}

export function DepositHbtcPanel() {
  const session = useAphoticSession();
  const owner = session.address;

  const coins = useHbtcCoins(owner);
  const mid = useBookMid(owner !== null);
  const position = useVaultPosition(owner, mid.deepbookMid);
  const tx = useAphoticTx();

  const [amountText, setAmountText] = useState('');
  const [okDigest, setOkDigest] = useState<string | null>(null);

  const missing = missingDepositTargets();
  const amountSats = parseSats(amountText);
  const bookMid = mid.deepbookMid;

  const call = useMemo(
    () =>
      describeDepositCall({
        coinIds: coins.coins.map((coin) => coin.objectId),
        amountSats: amountSats ?? 0n,
        totalSats: coins.totalSats,
        bookMid,
      }),
    [coins.coins, coins.totalSats, amountSats, bookMid],
  );

  // ── the one reason this button is not clickable ───────────────────────────
  const reason: string | null =
    missing.length > 0
      ? `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} empty in this build — there is no published vault to deposit into.`
      : tx.disabledReason !== null
        ? tx.disabledReason
        : coins.isLoading
          ? 'Reading your hBTC balance from chain…'
          : coins.error !== null
            ? `Your hBTC balance could not be read: ${coins.error}`
            : coins.totalSats === 0n
              ? 'This address holds no hBTC. Bridge native BTC in first — that is the ~70-minute leg above.'
              : position.position?.paused === true
                ? 'The vault is paused: vault::deposit_btc asserts !paused (EPaused). Exits are deliberately still open.'
                : amountSats === null
                  ? 'Enter an amount in satoshis.'
                  : amountSats === 0n
                    ? 'Amount must be greater than zero (EZeroDeposit).'
                    : amountSats > coins.totalSats
                      ? `You hold ${formatSats(coins.totalSats)}; that is the most you can deposit.`
                      : null;

  const canSend = reason === null && !tx.isPending;

  /** Why the percentage shortcuts are inert. Null when they work. */
  const presetReason: string | null =
    owner === null
      ? 'Sign in to read your hBTC balance'
      : coins.isLoading
        ? 'Still reading your balance from chain'
        : coins.totalSats === 0n
          ? 'This address holds no hBTC yet'
          : null;

  const onDeposit = () => {
    if (amountSats === null) return;
    setOkDigest(null);
    void tx
      .send(() =>
        buildDepositBtcTx({
          coinIds: coins.coins.map((coin) => coin.objectId),
          amountSats,
          totalSats: coins.totalSats,
          bookMid,
        }),
      )
      .then((result) => {
        if (result.status === 'success') {
          setOkDigest(result.digest);
          setAmountText('');
          coins.refetch();
          position.refetch();
        }
      });
  };

  const preset = (numerator: bigint, denominator: bigint) => {
    setAmountText(((coins.totalSats * numerator) / denominator).toString());
  };

  const pos = position.position;
  const sharePrice = pos === null ? null : sharePriceScaled(pos.navSats, pos.totalShares);

  return (
    <section className="aphotic-card dep-step">
      <div className="dep-step-head">
        <span className="dep-step-num">03</span>
        <span className="dep-step-title">Deposit hBTC you already hold</span>
        <span className="dep-step-note">sui · one checkpoint</span>
      </div>

      <p className="dep-lede" style={{ fontSize: 'var(--text-sm)' }}>
        Once hBTC exists it is an ordinary fungible <code>Coin&lt;BTC&gt;</code>. Moving it into the
        vault takes one checkpoint and touches no bridge — the slow leg above is how it is{' '}
        <em>minted</em>, not how it moves. This is the same call the sponsored sweep makes for you
        after a bridged deposit; it is here so you can make it yourself.
      </p>

      {/* ── what is actually on chain right now ──────────────────────────── */}
      <div className="dep-figures">
        <Figure
          label="Your hBTC"
          value={
            owner === null
              ? '—'
              : coins.isLoading
                ? '…'
                : coins.error !== null
                  ? 'unreadable'
                  : formatSats(coins.totalSats)
          }
          note={
            owner === null
              ? 'sign in to read'
              : coins.error !== null
                ? coins.error
                : `${coins.coins.length} coin object${coins.coins.length === 1 ? '' : 's'}`
          }
        />
        <Figure
          label="Your shares"
          value={pos === null ? (position.isLoading ? '…' : '—') : pos.myShares.toString()}
          note={pos === null ? 'read with your position' : 'credited to ctx.sender()'}
        />
        <Figure
          label="Vault NAV"
          value={
            pos === null
              ? position.isLoading
                ? '…'
                : '—'
              : pos.navSats === null
                ? 'unvaluable'
                : formatSats(pos.navSats)
          }
          note={
            pos === null
              ? 'read from vault::nav_sats'
              : pos.navSats === null
                ? 'the vault holds DBUSDC and the book has no mid — Move would abort EZeroNav'
                : pos.quoteValue === 0n
                  ? 'base-only vault: valued exactly, with no price at all'
                  : 'valued at the DeepBook mid, never at a raw oracle'
          }
        />
        <Figure
          label="Total shares"
          value={pos === null ? (position.isLoading ? '…' : '—') : pos.totalShares.toString()}
          note={
            sharePrice === null
              ? pos !== null && pos.totalShares === 0n
                ? 'empty vault — the first deposit mints 1 share per sat'
                : 'no share price yet'
              : `${(Number(sharePrice) / 1e8).toFixed(6)} sats per share`
          }
        />
      </div>

      {position.error !== null ? (
        <p className="ap-reason ap-reason--error">
          The vault could not be read: {position.error}
        </p>
      ) : null}

      {/* ── the amount ──────────────────────────────────────────────────── */}
      <div className="dep-form">
        <label className="dep-label" htmlFor="dep-amount">
          Amount to deposit, in satoshis
        </label>
        <input
          id="dep-amount"
          className="dep-input ap-num"
          inputMode="numeric"
          autoComplete="off"
          placeholder="0"
          value={amountText}
          onChange={(event) => {
            setAmountText(event.target.value);
            setOkDigest(null);
          }}
        />

        <div className="ap-row">
          <button
            type="button"
            className="ap-btn ap-btn--ghost"
            disabled={coins.totalSats === 0n}
            title={presetReason ?? 'A quarter of your hBTC balance'}
            onClick={() => preset(1n, 4n)}
          >
            25%
          </button>
          <button
            type="button"
            className="ap-btn ap-btn--ghost"
            disabled={coins.totalSats === 0n}
            title={presetReason ?? 'Half of your hBTC balance'}
            onClick={() => preset(1n, 2n)}
          >
            50%
          </button>
          <button
            type="button"
            className="ap-btn ap-btn--ghost"
            disabled={coins.totalSats === 0n}
            title={presetReason ?? 'Your whole hBTC balance'}
            onClick={() => setAmountText(coins.totalSats.toString())}
          >
            Everything
          </button>
          {amountSats !== null && amountSats > 0n ? (
            <span className="ap-reason">{formatBtc(amountSats)}</span>
          ) : null}
        </div>

        <div className="ap-row">
          <button
            type="button"
            className="ap-btn ap-btn--primary"
            disabled={!canSend}
            title={
              reason ??
              (tx.isPending
                ? 'Waiting for your wallet to sign'
                : 'Merges your hBTC, splits the exact amount and calls vault::deposit_btc')
            }
            onClick={onDeposit}
          >
            {tx.isPending
              ? 'Signing…'
              : amountSats !== null && amountSats > 0n
                ? `Deposit ${formatSats(amountSats)} into the vault`
                : 'Deposit into the vault'}
          </button>
          <button
            type="button"
            className="ap-btn ap-btn--ghost"
            disabled={owner === null || coins.isFetching || position.isFetching}
            onClick={() => {
              coins.refetch();
              position.refetch();
              mid.refetch();
            }}
            title={owner === null ? 'Sign in first' : 'Re-read balance, vault and book from chain'}
          >
            {coins.isFetching || position.isFetching ? 'Re-reading…' : 'Re-read from chain'}
          </button>
        </div>

        {reason !== null ? <p className="ap-reason ap-reason--warn">{reason}</p> : null}

        {tx.last !== null && tx.last.status === 'error' ? (
          <p className="ap-reason ap-reason--error" role="alert">
            {tx.last.message}
          </p>
        ) : null}

        {okDigest !== null ? (
          <p className="ap-reason ap-reason--ok" role="status">
            Deposited. Shares credited to your address in one checkpoint —{' '}
            <a href={suiTxUrl(okDigest)} target="_blank" rel="noreferrer">
              {truncateMiddle(okDigest, 8)}
            </a>
            . Nothing about this transaction can move your coins anywhere but back to your pinned
            Bitcoin address.
          </p>
        ) : null}
      </div>

      {/* ── the exact call ──────────────────────────────────────────────── */}
      <CallPreview call={call} caption="The transaction you are about to sign" />

      <p className="ap-reason">
        <strong style={{ color: 'var(--text-secondary)' }}>book_mid:</strong>{' '}
        {bookMid === 0n
          ? `no DeepBook mid exists — the ${config.deepbook.poolId === '' ? 'pool' : 'hBTC/DBUSDC book'} is empty on both sides, so try_book_mid returns none. That is exact while the vault holds no DBUSDC: nav_sats returns before the price assert.`
          : `read from the on-chain book at 1e9 scaling (${bookMid.toString()}).`}
        {mid.pythUsd === null
          ? ''
          : ` Pyth Beta reads BTC/USD ≈ ${mid.pythUsd.toFixed(0)} — shown as a reference, never used to value the vault (G9).`}
      </p>
    </section>
  );
}

export default DepositHbtcPanel;
