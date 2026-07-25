// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2, T5.3
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4 (Screen 3 — Transparency), ERRATA E-A7 (empty book)
// @spec       docs/GOLDEN-RULES.md G5 G8 G9 · docs/DEPLOYED.md v3
// @rules      G2 G5 G6 G7 G8 G9 G10
// @depends    ./chainRead.ts (T5.2) · ./transparency.css · ../../lib/format.ts
// @facts      This is the panel that makes the screen's title true: every number
// @facts        here is read out of the shared Vault object, the DeepBook pool and
// @facts        the journal event stream, by this browser, on a click.
// @facts      ⚠ Click-driven, not mounted-driven: the screen makes ZERO network
// @facts        calls until the reader asks (G6, TransparencyScreen invariant 4).
// @facts      ⚠ The hBTC/DBUSDC book is empty on BOTH sides. `readBookDepth` uses
// @facts        get_level2_range, which SUCCEEDS and returns ([], []) — "no book" is
// @facts        a first-class rendered state, never an error (E-A7). pool::mid_price
// @facts        would abort EEmptyOrderbook and is never called.
// @facts      ⚠ An empty journal is the honest state until the keeper has run. It
// @facts        is rendered as "nothing has been journalled yet", never as a
// @facts        failure and never back-filled from fixtures.
// @facts      The two limiter genesis scalars are shown as what they are: envelope
// @facts        parameters WE configured, which keeper verify/ replays against the
// @facts        bridge's own event stream (G5). They are not a bridge read.
// @implements export interface ChainSnapshot · export function useChainSnapshot()
//             export function LiveVaultPanel(props): JSX.Element
// @forbidden  a canonical id literal — every id comes from config (G7)
// @forbidden  rendering a fixture in this panel under any circumstance
// @forbidden  pool::mid_price — it aborts on an empty book
// @invariant  1. Nothing is fetched before the reader clicks.
//             2. Every failure renders the verbatim endpoint + reason.
//             3. A figure is either read from chain or shown as absent — never
//                substituted.
// @ac         docs/APP.md §7 A7 A9 A11
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';

import { config } from '../../config';
import { suiObjectUrl, suiTxUrl } from '../../lib/explorer';
import { formatSats, truncateMiddle } from '../../lib/format';

import {
  describeBlobId,
  readBookDepth,
  readJournal,
  readVaultOnChain,
  type BookDepth,
  type JournalEntry,
  type VaultOnChain,
} from './chainRead';

export interface ChainSnapshot {
  readonly vault: VaultOnChain | null;
  readonly book: BookDepth | null;
  readonly journal: readonly JournalEntry[] | null;
  readonly vaultError: string | null;
  readonly bookError: string | null;
  readonly journalError: string | null;
  readonly reading: boolean;
  readonly readAtMs: number | null;
  readonly read: () => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One click, three independent public reads. They are deliberately independent:
 * a pool that cannot be read must not hide the vault, and vice versa.
 */
export function useChainSnapshot(): ChainSnapshot {
  const [vault, setVault] = useState<VaultOnChain | null>(null);
  const [book, setBook] = useState<BookDepth | null>(null);
  const [journal, setJournal] = useState<readonly JournalEntry[] | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readAtMs, setReadAtMs] = useState<number | null>(null);

  const read = useCallback(() => {
    setReading(true);
    setVaultError(null);
    setBookError(null);
    setJournalError(null);

    const jobs = [
      readVaultOnChain().then(
        (value) => setVault(value),
        (err: unknown) => {
          setVault(null);
          setVaultError(messageOf(err));
        },
      ),
      readBookDepth().then(
        (value) => setBook(value),
        (err: unknown) => {
          setBook(null);
          setBookError(messageOf(err));
        },
      ),
      readJournal().then(
        (value) => setJournal(value),
        (err: unknown) => {
          setJournal(null);
          setJournalError(messageOf(err));
        },
      ),
    ];

    void Promise.allSettled(jobs).then(() => {
      setReading(false);
      setReadAtMs(Date.now());
    });
  }, []);

  return {
    vault,
    book,
    journal,
    vaultError,
    bookError,
    journalError,
    reading,
    readAtMs,
    read,
  };
}

function Row({ k, v, note }: { k: string; v: React.ReactNode; note?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {v}
        {note === undefined ? null : <div className="tx-note">{note}</div>}
      </dd>
    </>
  );
}

export function LiveVaultPanel({ snapshot }: { snapshot: ChainSnapshot }) {
  const { vault, book, journal } = snapshot;

  return (
    <section className="tx-panel" aria-label="Live on-chain state">
      <div className="tx-panel-head">
        <span className="tx-eyebrow">On chain · read by this browser</span>
        <h2 className="tx-panel-title">The vault, as the chain has it</h2>
        <p className="tx-panel-sub">
          Nothing below is cached, staged or ours to shape. It is one{' '}
          <code>getObject</code> of the shared Vault, one <code>get_level2_range</code> of the
          DeepBook pool, and the journal event stream — the same three calls anyone can make.
        </p>
      </div>

      <div className="ap-row">
        <button
          type="button"
          className="ap-btn ap-btn--primary"
          disabled={snapshot.reading || config.aphotic.vaultId === ''}
          onClick={snapshot.read}
          title={
            config.aphotic.vaultId === ''
              ? 'VITE_VAULT_ID is empty in this build — there is no object to read'
              : `Read ${config.sui.network} now`
          }
        >
          {snapshot.reading ? 'Reading the chain…' : 'Read the vault from chain'}
        </button>
        <span className="ap-reason">
          {config.aphotic.vaultId === ''
            ? 'Disabled: VITE_VAULT_ID is empty in this build, so there is no object to read.'
            : snapshot.readAtMs === null
              ? 'Not read yet — this page fires no request until you ask it to.'
              : `Read at ${new Date(snapshot.readAtMs).toISOString().replace('T', ' ').slice(0, 19)}Z. Not polled.`}
        </span>
      </div>

      {snapshot.vaultError !== null ? (
        <div className="ap-state ap-state--error">
          <span className="ap-state-title">The vault could not be read</span>
          <p style={{ margin: 0 }}>{snapshot.vaultError}</p>
        </div>
      ) : null}

      {vault !== null ? (
        <dl className="tx-kv">
          <Row
            k="Vault"
            v={
              <a
                className="tx-mono"
                href={suiObjectUrl(vault.objectId)}
                target="_blank"
                rel="noreferrer"
              >
                {truncateMiddle(vault.objectId, 10)}
              </a>
            }
            note={`version ${vault.version} · shared at ${vault.initialSharedVersion ?? 'unknown'}`}
          />
          <Row
            k="NAV"
            v={
              <span className="ap-num">
                {vault.navSats === null ? 'unvaluable' : formatSats(vault.navSats)}
              </span>
            }
            note={
              vault.navSats === null
                ? 'the vault holds a quote leg and the book has no mid — Move itself would abort EZeroNav rather than guess (G9)'
                : vault.quoteValue === 0n
                  ? 'base-only vault: exact, and no price is involved at all'
                  : 'valued at the DeepBook mid, never at a raw oracle price'
            }
          />
          <Row
            k="Idle / free"
            v={
              <span className="ap-num">
                {formatSats(vault.idleBtcSats)} / {formatSats(vault.freeBtcSats)}
              </span>
            }
            note={`${formatSats(vault.totalPendingExitSats)} earmarked for pooled exits and not spendable by the keeper`}
          />
          <Row
            k="Shares"
            v={<span className="ap-num">{vault.totalShares.toString()}</span>}
            note={`${vault.depositorCount} depositor record${vault.depositorCount === 1 ? '' : 's'}`}
          />
          <Row
            k="Keeper"
            v={<span className="tx-mono">{truncateMiddle(vault.keeper, 8)}</span>}
            note="holds a DeepBook TradeCap and nothing else — it cannot withdraw, and it cannot choose where BTC goes"
          />
          <Row
            k="Owner"
            v={<span className="tx-mono">{truncateMiddle(vault.owner, 8)}</span>}
            note="can pause trading and rotate the keeper; the v3 package has no owner withdraw at all"
          />
          <Row
            k="Paused"
            v={vault.paused ? 'yes' : 'no'}
            note="a paused vault still lets depositors leave — burn_shares_for_btc is deliberately not gated on it"
          />
          <Row
            k="Strategy"
            v={<span className="tx-mono">{describeBlobId(vault.strategyBlobId).display}</span>}
            note={`${vault.strategyCiphertextBytes.toLocaleString('en-US')} bytes of ciphertext on chain · Seal identity is namespaced to this vault at version epoch ${vault.versionEpoch}`}
          />
          <Row
            k="Envelope"
            v={
              <span className="ap-num">
                {vault.envelope.maxSlippageBps} bps slip · {vault.envelope.bufferRatioBps} bps buffer
              </span>
            }
            note={`max ${formatSats(vault.envelope.maxNotionalPerEpochSats)} per ${Math.round(vault.envelope.epochLenMs / 3_600_000)}h epoch (${formatSats(vault.envelope.epochNotionalUsedSats)} used) · ${Math.round(vault.envelope.minCooldownMs / 1000)}s cooldown · breaker at ${vault.envelope.maxDivergenceBps} bps divergence`}
          />
          <Row
            k="Limiter scalars"
            v={
              <span className="ap-num">
                {vault.envelope.limiterRefillRatePerSec.toString()} sat/s · cap{' '}
                {formatSats(vault.envelope.limiterMaxCapacitySats)}
              </span>
            }
            note="our configured mirror of the guardian's bucket. It is not a bridge read: keeper verify/ replays project_capacity() over Hashi's own event stream and the two must agree (G5)."
          />
        </dl>
      ) : null}

      {/* ── the book ──────────────────────────────────────────────────────── */}
      <hr className="tx-rule" />
      <p className="tx-section-k">DeepBook hBTC/DBUSDC</p>

      {snapshot.bookError !== null ? (
        <p className="ap-reason ap-reason--error">{snapshot.bookError}</p>
      ) : book === null ? (
        <p className="tx-note">Not read yet.</p>
      ) : book.empty ? (
        <p className="tx-note">
          The book is empty on both sides — {book.bids.length} bids, {book.asks.length} asks. That
          is a read, not a failure: <code>get_level2_range</code> succeeded and returned nothing.
          There is no mid, so there is no price to quote, and every panel on this page says so
          instead of inventing one. We can mint neither asset on testnet, so we cannot seed it.
        </p>
      ) : (
        <p className="tx-note">
          {book.bids.length} bid level{book.bids.length === 1 ? '' : 's'}, {book.asks.length} ask
          level{book.asks.length === 1 ? '' : 's'}. Best bid{' '}
          <span className="ap-num">{book.bids[0]?.priceRaw.toString() ?? '—'}</span>, best ask{' '}
          <span className="ap-num">{book.asks[0]?.priceRaw.toString() ?? '—'}</span> (raw DeepBook
          scaling).
        </p>
      )}

      {/* ── the journal ───────────────────────────────────────────────────── */}
      <hr className="tx-rule" />
      <p className="tx-section-k">Journal · decision blobs certified on chain</p>

      {snapshot.journalError !== null ? (
        <p className="ap-reason ap-reason--error">{snapshot.journalError}</p>
      ) : journal === null ? (
        <p className="tx-note">Not read yet.</p>
      ) : journal.length === 0 ? (
        <p className="tx-note">
          Nothing has been journalled yet: <code>aphotic::journal</code> has emitted no events for
          this vault. The keeper writes one blob id per decision, so an empty journal means it has
          not traded — which is exactly what an empty book implies. We would rather show you a
          blank ledger than a populated one you cannot check.
        </p>
      ) : (
        <ul className="tx-list">
          {journal.map((entry) => (
            <li key={`${entry.seq}-${entry.txDigest}`}>
              <span className="ap-num">#{entry.seq}</span>{' '}
              <span className="tx-mono">{describeBlobId(entry.blobId).display}</span>{' '}
              <a href={suiTxUrl(entry.txDigest)} target="_blank" rel="noreferrer">
                {truncateMiddle(entry.txDigest, 6)}
              </a>{' '}
              <span className="tx-dim">
                {new Date(entry.timestampMs).toISOString().replace('T', ' ').slice(0, 16)}Z
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default LiveVaultPanel;
