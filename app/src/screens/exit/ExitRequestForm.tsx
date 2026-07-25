// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<ExitRequestForm/>), §3.3 (Move calls), §7 A4 A5 A6
// @spec       move/sources/gateway.move stage_exit (T1.3) · vault.move burn_shares_for_btc
// @rules      G2 G3 G6 G10
// @depends    ./model.ts · ./ptb.ts · ./CallPreview.tsx · ../../lib/format.ts · ../../config.ts
// @facts      The input is SHARES, because shares are what Move burns. The sats figure
// @facts        is derived with the exact Move formula
// @facts        `floor(shares × nav_sats / total_shares)` (vault::burn_shares_for_btc
// @facts        → mul_div), so the number on screen is the number the PTB pays out.
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · DUST_FLOOR_SATS = 546.
// @facts      Below 30_000 sats `stage_exit` POOLS the proceeds inside Move and submits
// @facts        NOTHING to the bridge (gateway.move @invariant 3). That is a defined,
// @facts        deliberate branch — not a failure, and not a queue position (G3).
// @facts      ⚠ book_mid is only load-bearing once the vault holds a quote leg: v3's
// @facts        nav_sats returns free_btc_sats verbatim while `quote == 0`. It is still
// @facts        passed, and still shown, because it is what the vault WILL use.
// @implements export interface ExitRequestFormProps
//             export function ExitRequestForm(props): JSX.Element
// @forbidden  a destination / bitcoin-address field of any kind — G2, A4
// @forbidden  a priority / expedite / fee-bump control — over-capacity batches are
//             REJECTED, never queued, and priority cannot be bought (G3)
// @forbidden  a clickable-and-silent button: every disabled state carries its reason
// @forbidden  `number` for sats or shares — bigint only (G10)
// @invariant  1. The submit button is disabled unless a positive, affordable share
//                count resolves to at least the Bitcoin dust floor.
// @invariant  2. When the amount lands below the bridge minimum, the copy says it will
//                POOL, and the button says so too — it never implies a bridge submission.
// @ac         docs/APP.md §7 A5 A6
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from 'react';

import { config } from '../../config';
import { classifyExitAmount, formatBtc, formatSats } from '../../lib/format';
import CallPreview from './CallPreview';
import { describeExitCall } from './ptb';
import { satsForShares, type VaultView } from './model';

export interface ExitRequestFormProps {
  readonly view: VaultView;
  /**
   * vault::free_btc_sats — idle base minus the pooled earmark. `burn_shares_for_btc`
   * asserts the payout fits inside it (EInsufficientIdle), so we check it here
   * rather than let the wallet surface an abort.
   */
  readonly freeBtcSats: bigint;
  /** DeepBook-scaled mid handed to the PTB, or null when no price could be read. */
  readonly bookMid: bigint | null;
  /**
   * `willPool` is true when Move will pool the proceeds instead of submitting
   * them, so the caller can report what actually happened rather than assuming a
   * bridge submission that never took place.
   */
  readonly onExit: (sharesToBurn: bigint, willPool: boolean) => void;
  readonly busy: boolean;
  /** Non-null ⇒ the action cannot run, and this is the honest one-line reason. */
  readonly blockedReason: string | null;
  /** Rendered after a SUCCESSFUL submit. */
  readonly result: ReactNode | null;
  /** Rendered after a FAILED submit. Never styled as success. */
  readonly errorText?: ReactNode | null;
}

const PRESETS = [
  { label: '25%', num: 1n, den: 4n },
  { label: '50%', num: 1n, den: 2n },
  { label: 'Everything', num: 1n, den: 1n },
] as const;

function parseShares(raw: string): bigint | null {
  const trimmed = raw.trim().replace(/[\s,_]/g, '');
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

export function ExitRequestForm({
  view,
  freeBtcSats,
  bookMid,
  onExit,
  busy,
  blockedReason,
  result,
  errorText = null,
}: ExitRequestFormProps) {
  const [raw, setRaw] = useState('');

  const shares = useMemo(() => parseShares(raw), [raw]);
  const sats = useMemo(() => (shares === null ? 0n : satsForShares(shares, view)), [shares, view]);

  const klass = classifyExitAmount(sats, config.hashi.withdrawalMinSats, config.constants.dustFloorSats);

  const inputError =
    raw.trim().length === 0
      ? null
      : shares === null
        ? 'Enter a whole number of shares — shares are indivisible u64 units, not a decimal.'
        : shares === 0n
          ? 'Zero shares would burn nothing.'
          : shares > view.myShares
            ? `You hold ${formatSats(view.myShares).replace(' sats', '')} shares; you cannot burn ${formatSats(shares).replace(' sats', '')}.`
            : sats === 0n
              ? 'That many shares round down to zero sats at the current NAV.'
              : klass === 'dust'
                ? `${formatSats(sats)} is below Bitcoin's ${formatSats(config.constants.dustFloorSats)} dust floor — the output would be unspendable.`
                : sats > freeBtcSats
                  ? `The vault's free idle balance is ${formatSats(freeBtcSats)}; the rest is deployed on the order book. burn_shares_for_btc aborts EInsufficientIdle above that, so exit in parts or wait for the keeper to unwind — your claim on the vault is unchanged either way.`
                  : null;

  const ready = shares !== null && shares > 0n && inputError === null;
  const pooling = ready && klass === 'pooled';

  return (
    <section className="xt-panel">
      <div className="xt-panel-head">
        <h2 className="xt-panel-title">Exit to Bitcoin</h2>
        <span className="xt-badge xt-badge--lock">no destination field, by design</span>
      </div>

      <p className="xt-copy">
        Burn shares. <code>gateway::exit_to_bitcoin</code> converts them at the current NAV and hands
        the balance to Hashi&rsquo;s <code>request_withdrawal</code> in the same transaction, addressed
        to the address pinned above. One transaction, one checkpoint.
      </p>

      {view.paused ? (
        <p className="xt-msg xt-msg--ok">
          The vault is currently <strong>paused</strong> and this button still works.{' '}
          <code>vault::burn_shares_for_btc</code> is deliberately not gated on the pause flag: an
          owner can stop the keeper trading, and cannot stop you leaving.
        </p>
      ) : null}

      <dl className="xt-kv">
        <div className="xt-kv-row">
          <dt className="xt-kv-key">Your shares</dt>
          <dd className="xt-kv-val xt-kv-val--accent">
            {view.myShares.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          </dd>
        </div>
        <div className="xt-kv-row">
          <dt className="xt-kv-key">Redeemable right now</dt>
          <dd className="xt-kv-val">{formatSats(satsForShares(view.myShares, view))}</dd>
        </div>
        <div className="xt-kv-row">
          <dt className="xt-kv-key">Vault NAV / total shares</dt>
          <dd className="xt-kv-val">
            {formatSats(view.navSats)} over{' '}
            {view.totalShares.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} shares
          </dd>
        </div>
      </dl>

      <div className="xt-field">
        <label className="xt-label" htmlFor="xt-shares">
          Shares to burn
        </label>
        <input
          id="xt-shares"
          className={`xt-input${inputError === null ? '' : ' xt-input--bad'}`}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="0"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          disabled={view.myShares === 0n}
        />
      </div>

      {view.myShares > 0n ? (
        <div className="xt-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="xt-chip"
              onClick={() => setRaw(((view.myShares * preset.num) / preset.den).toString())}
            >
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}

      {inputError === null ? null : <p className="xt-msg xt-msg--bad">{inputError}</p>}

      {ready ? (
        <>
          <dl className="xt-kv">
            <div className="xt-kv-row">
              <dt className="xt-kv-key">Move pays out</dt>
              <dd className="xt-kv-val xt-kv-val--btc">
                {formatSats(sats)} · {formatBtc(sats)}
              </dd>
            </div>
            <div className="xt-kv-row">
              <dt className="xt-kv-key">Bridge minimum</dt>
              <dd className="xt-kv-val">{formatSats(config.hashi.withdrawalMinSats)}</dd>
            </div>
          </dl>

          {pooling ? (
            <p className="xt-msg xt-msg--pool">
              This lands below the bridge minimum, so <code>stage_exit</code> will <strong>pool</strong>{' '}
              it inside the Vault and submit nothing. Hashi aborts sub-minimum withdrawals
              (<code>EBelowMinimumWithdrawal</code>) — pooling is how we respect that instead of
              failing your transaction. Top the pool up to {formatSats(config.hashi.withdrawalMinSats)}{' '}
              and flush it, or take it back as hBTC on Sui at any time.
            </p>
          ) : null}

          <CallPreview
            call={describeExitCall({ sharesToBurn: shares, bookMid: bookMid ?? 0n })}
            caption="The transaction you are about to sign"
          />
        </>
      ) : (
        <p className="xt-hint">
          Amounts at or above {formatSats(config.hashi.withdrawalMinSats)} go to the bridge. Below that
          they pool inside the Vault until they clear the minimum — there is no fast lane to buy, for
          anyone.
        </p>
      )}

      {blockedReason === null ? null : <p className="xt-msg xt-msg--warn">{blockedReason}</p>}

      <div className="xt-actions">
        <button
          type="button"
          className="xt-btn xt-btn--primary"
          disabled={!ready || busy || blockedReason !== null}
          // Same reason as the warning above, carried on the control itself so the
          // disabled state is never silent on hover.
          title={
            busy
              ? 'Waiting for your wallet to sign'
              : (blockedReason ??
                (inputError ??
                  (shares === null || shares === 0n
                    ? 'Enter how many shares to burn'
                    : 'Burns your shares and composes the withdrawal to your pinned address')))
          }
          onClick={() => {
            if (shares !== null) onExit(shares, pooling);
          }}
        >
          {busy
            ? 'Signing…'
            : pooling
              ? `Burn ${formatSats(sats)} into the pool`
              : `Exit ${formatSats(sats)} to Bitcoin`}
        </button>
      </div>

      {result === null ? null : <p className="xt-msg xt-msg--ok">{result}</p>}
      {errorText === null ? null : <p className="xt-msg xt-msg--bad">{errorText}</p>}
    </section>
  );
}

export default ExitRequestForm;
