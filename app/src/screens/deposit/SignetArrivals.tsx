// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T5.3
// @phase      3
// @status     DONE
// @spec       docs/APP.md §2.2 (the six stages), §7 A5 (signet link)
// @spec       docs/RECON.md R14 (deposit registration; txid byte order; 6 confs)
// @rules      G1 G6 G7 G8
// @depends    ./useSignetArrivals.ts · ./hashiDeposit.ts (T3.1)
//             ../../lib/explorer.ts · ../../lib/format.ts (T0.4)
// @facts      Stages 1–2 of the six ARE observable from the browser: mempool.space's
// @facts        signet REST API is public, so where the depositor's BTC actually is
// @facts        can be READ instead of staged. Stage 3 onward lives inside Hashi.
// @facts      ⚠ Registration is NOT offered here. It is `scripts/register-deposit.ps1`
// @facts        / the keeper's job, it needs >= 6 confirmations (an unconfirmed txid
// @facts        can be RBF-replaced out of existence and registering against it fails
// @facts        SILENTLY — R14.3), and the app has no business holding that key.
// @facts        The panel therefore reports readiness; it never offers a button it
// @facts        cannot honestly wire.
// @facts      NOT polled. A 70-minute wait polled every few seconds is background
// @facts        traffic in a demo and teaches nothing a "check now" button does not
// @facts        (G6). The last-checked age is stated instead of implying live.
// @implements export function SignetArrivals(props: { address: string | null }): JSX.Element
// @forbidden  a poll interval — refresh is user-initiated (G6)
// @forbidden  treating "no transactions yet" as an error
// @forbidden  a canonical id literal — config only (G7)
// @invariant  1. No request is issued until the user asks, and never while the
//                deposit address is undetermined.
//             2. "Not seen yet", "seen but shallow" and "explorer unreachable" are
//                three DIFFERENT rendered states.
// @ac         docs/APP.md §7 A5 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import { signetTxUrl } from '../../lib/explorer';
import { formatSats, truncateMiddle } from '../../lib/format';

import { useSignetArrivals } from './useSignetArrivals';

function ageOf(updatedAt: number | null): string {
  if (updatedAt === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function SignetArrivals({ address }: { address: string | null }) {
  const arrivals = useSignetArrivals(address);
  const threshold = config.hashi.confirmations;

  return (
    <div className="dep-arrivals">
      <div className="ap-row">
        <button
          type="button"
          className="ap-btn ap-btn--btc"
          disabled={address === null || arrivals.isFetching}
          onClick={arrivals.refetch}
          title={
            address === null
              ? 'Your deposit address has to be derived first'
              : 'Read this address on signet, once, now'
          }
        >
          {arrivals.isFetching ? 'Reading signet…' : 'Check signet for arrivals'}
        </button>
        <span className="ap-reason">
          {address === null
            ? 'Sign in to derive your address — there is nothing to look up yet.'
            : `Public read of mempool.space. Last checked ${ageOf(arrivals.updatedAt)}; not polled.`}
        </span>
      </div>

      {arrivals.error !== null ? (
        <p className="ap-reason ap-reason--error">
          The signet explorer could not be reached: {arrivals.error}. Your BTC is unaffected — this
          is a read of a public chain, not of us.
        </p>
      ) : null}

      {arrivals.updatedAt !== null && arrivals.utxos.length === 0 && arrivals.error === null ? (
        <p className="ap-reason">
          Nothing has paid this address yet
          {arrivals.tipHeight === null ? '' : ` (signet tip ${arrivals.tipHeight})`}. That is a
          normal state, not a failure — a signet block is ~10 minutes and Hashi wants {threshold} of
          them.
        </p>
      ) : null}

      {arrivals.utxos.length > 0 ? (
        <ul className="dep-arrival-list">
          {arrivals.utxos.map((utxo) => {
            const ready = utxo.confirmations >= threshold;
            return (
              <li className="dep-arrival" key={`${utxo.txid}:${utxo.vout}`}>
                <span className="dep-arrival-amount ap-num">{formatSats(utxo.sats)}</span>
                <a
                  className="aphotic-mono"
                  href={signetTxUrl(utxo.txid)}
                  target="_blank"
                  rel="noreferrer"
                  title={`${utxo.txid}:${utxo.vout}`}
                >
                  {truncateMiddle(utxo.txid, 8)}:{utxo.vout}
                </a>
                <span className={ready ? 'dep-tag dep-tag-sui' : 'dep-tag dep-tag-btc'}>
                  {utxo.confirmed
                    ? `${utxo.confirmations} / ${threshold} confirmations`
                    : 'in the mempool — replaceable'}
                </span>
                <span className="ap-reason">
                  {ready
                    ? 'Deep enough to register with Hashi. The keeper picks it up; the app never holds that key.'
                    : utxo.confirmed
                      ? 'Registering this early fails silently at the bridge, so nobody does it.'
                      : 'An unconfirmed txid can still be replaced, so it cannot be registered against.'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export default SignetArrivals;
