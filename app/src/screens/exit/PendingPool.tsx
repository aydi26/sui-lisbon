// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (pooled small exits), §7 A6
// @spec       move/sources/gateway.move stage_flush / take_pending_as_hbtc (T1.4, DONE)
// @rules      G1 G2 G3 G8 G10
// @depends    ./ptb.ts · ./CallPreview.tsx · ../../lib/format.ts · ../../config.ts
// @facts      `Depositor.pending_exit_sats` is an EARMARK against the vault's idle
// @facts        balance, not a second balance — the shares behind it are ALREADY burned
// @facts        (vault.move @invariant 10), which is why vault::free_btc_sats subtracts it.
// @facts      Two exits, and only two:
// @facts        flush_pending_exit  — self-service, submits the pool to the bridge once it
// @facts          clears 30_000 sats. `stage_flush` asserts who == ctx.sender() (E-M8),
// @facts          because cancel_withdrawal is sender-bound and a third-party flush would
// @facts          make that third party the only party able to reclaim.
// @facts        take_pending_as_hbtc — takes the earmark back as Coin<hBTC> on Sui.
// @facts          One checkpoint, no bridge surface at all (G1).
// @facts      ⚠ G3: the pool is a MINIMUM-SIZE mechanism, never a queue and never a
// @facts        priority ladder. Hashi's bucket rejects over-capacity batches outright.
// @facts      ⚠ G8: what you take back is hBTC — custodial-threshold wrapped BTC held by
// @facts        Hashi's committee. The copy says so.
// @implements export interface PendingPoolProps · export function PendingPool(props): JSX.Element
// @forbidden  a priority / expedite control (G3)
// @forbidden  wording that implies the bridge is congested or that waiting buys anything
// @forbidden  a clickable-and-silent button: every disabled state carries its reason
// @invariant  1. Flush is offered ONLY when the pool clears the bridge minimum; below
//                that the button is disabled with the shortfall stated in sats.
// @invariant  2. Take-as-hBTC is always available while the pool is non-empty — the
//                depositor is never trapped waiting for the pool to fill.
// @ac         docs/APP.md §7 A6
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

import { config } from '../../config';
import { formatBtc, formatSats } from '../../lib/format';
import CallPreview from './CallPreview';
import { describeFlushCall, describeTakeCall } from './ptb';

export interface PendingPoolProps {
  readonly who: string;
  readonly pendingExitSats: bigint;
  readonly onFlush: () => void;
  readonly onTake: () => void;
  /** 'flush' | 'take' while that action is in flight. */
  readonly busy: 'flush' | 'take' | null;
  /** Non-null ⇒ neither action can run, and this is the honest reason. */
  readonly blockedReason: string | null;
  /** Rendered after a SUCCESSFUL submit. */
  readonly result: ReactNode | null;
  /** Rendered after a FAILED submit. Never styled as success. */
  readonly errorText?: ReactNode | null;
}

export function PendingPool({
  who,
  pendingExitSats,
  onFlush,
  onTake,
  busy,
  blockedReason,
  result,
  errorText = null,
}: PendingPoolProps) {
  const min = config.hashi.withdrawalMinSats;
  const clears = pendingExitSats >= min;
  const shortfall = clears ? 0n : min - pendingExitSats;
  const pct = min === 0n ? 100 : Number((pendingExitSats * 100n) / min);

  return (
    <section className="xt-panel xt-panel--warn">
      <div className="xt-panel-head">
        <h2 className="xt-panel-title">Your pooled exit</h2>
        <span className="xt-badge xt-badge--btc">below the bridge minimum</span>
      </div>

      <p className="xt-copy">
        These sats are earmarked inside the Vault. The shares behind them are already burned, so the
        vault&rsquo;s spendable balance already excludes them — nothing here is at risk and nothing
        here is trading.
      </p>

      <dl className="xt-kv">
        <div className="xt-kv-row">
          <dt className="xt-kv-key">Pooled</dt>
          <dd className="xt-kv-val xt-kv-val--btc">
            {formatSats(pendingExitSats)} · {formatBtc(pendingExitSats)}
          </dd>
        </div>
        <div className="xt-kv-row">
          <dt className="xt-kv-key">Bridge minimum</dt>
          <dd className="xt-kv-val">{formatSats(min)}</dd>
        </div>
      </dl>

      <div className="xt-meter" aria-hidden="true">
        <div className="xt-meter-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>

      {clears ? (
        <p className="xt-msg xt-msg--ok">
          The pool clears the minimum. You can submit it to the bridge yourself — nobody else can,
          because <code>stage_flush</code> asserts the flusher is you.
        </p>
      ) : (
        <p className="xt-hint">
          {formatSats(shortfall)} short of the minimum Hashi accepts. Waiting buys nothing and costs
          nothing; taking it back as hBTC is instant.
        </p>
      )}

      {blockedReason === null ? null : <p className="xt-msg xt-msg--warn">{blockedReason}</p>}

      <CallPreview
        call={clears ? describeFlushCall({ who }) : describeTakeCall({ recipient: who })}
        caption={clears ? 'Flush — the transaction you would sign' : 'Take it back — the transaction you would sign'}
      />

      <div className="xt-actions">
        <button
          type="button"
          className="xt-btn xt-btn--primary"
          disabled={!clears || busy !== null || blockedReason !== null}
          title={clears ? undefined : `${formatSats(shortfall)} short of the bridge minimum`}
          onClick={onFlush}
        >
          {busy === 'flush' ? 'Signing…' : 'Flush the pool to Bitcoin'}
        </button>
        <button
          type="button"
          className="xt-btn"
          disabled={pendingExitSats === 0n || busy !== null || blockedReason !== null}
          onClick={onTake}
        >
          {busy === 'take' ? 'Signing…' : 'Take it as hBTC instead'}
        </button>
      </div>

      <p className="xt-hint">
        Taking it as hBTC settles in one checkpoint and never touches the bridge. What you receive is
        hBTC — custodial-threshold wrapped BTC held by Hashi&rsquo;s committee — not native BTC.
      </p>

      {result === null ? null : <p className="xt-msg xt-msg--ok">{result}</p>}
      {errorText === null ? null : <p className="xt-msg xt-msg--bad">{errorText}</p>}
    </section>
  );
}

export default PendingPool;
