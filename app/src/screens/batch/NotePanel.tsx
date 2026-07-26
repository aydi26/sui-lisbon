// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.1 (notes), §7.2 (escrow is topped up independently of
//             trading), §4.2 (the leak we route around)
// @spec       docs/DESIGN-V2.md §11 (the ladder), D8 (v1 spends are LINKABLE)
// @rules      G7 G8 G10
// @depends    ../../lib/notes.ts (F3) · ../../lib/batch.ts · ../../lib/vault.ts
//             · ../../lib/tx.ts · ../../components (F1)
// @facts      THE SECRET IS SHOWN ONCE AND NEVER TRANSMITTED. It is 32 bytes from
// @facts        crypto.getRandomValues, held in this browser's localStorage and in
// @facts        whatever file you download. Nothing on chain can reconstruct it:
// @facts        the contract only ever sees blake2b256(0x01 ‖ denom ‖ secret ‖ r).
// @facts        Lose it and the note is unspendable BY ANYONE, permanently — which
// @facts        is exactly why the warning is unmissable rather than a footnote.
// @facts      THE MERKLE PATH IS BUILT IN THIS BROWSER from the public leaf list
// @facts        (the `NoteCommitted` event stream), then checked against the root
// @facts        the vault actually published BEFORE the transaction is offered. A
// @facts        proof that folds to a root nobody published aborts EUnknownRoot,
// @facts        and finding that out locally costs nothing.
// @facts      ⚠ D8 — v1 note spends are LINKABLE. The path is supplied in the
// @facts        clear, so `leaf_index` names the leaf and the spend is joinable to
// @facts        the deposit that funded it. v1 delivers UNIFORMITY, not
// @facts        unlinkability. This panel says so where the spend happens.
// @facts      Escrow is topped up INDEPENDENTLY of trading on purpose: funding at
// @facts        order time leaks timing even when denominations hide size.
// @implements export function NotePanel(props): JSX.Element
// @forbidden  a free-form amount field — the ladder is the only size control
// @forbidden  an <input> anywhere on this route (there is a test)
// @forbidden  sending `secret` or `r` to any server, log or blob
// @invariant  1. The secret is rendered once, with a download, and a warning that
//                is not dismissible.
// @invariant  2. A spend is never offered unless the locally rebuilt path folds to
//                the published root.
// @ac         renders unconfigured with every control disabled and stated.
// @verify     cd app && npm test -- batchScreen
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import { fromHex, toHex } from '@aphotic/sdk/hash';

import { DenominationLadder, type Denomination } from '../../components';
import { config } from '../../config';
import { buildDepositNote, buildSpendNote, buildTopUpBase } from '../../lib/batch';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import {
  NOTE_TREE_DEPTH,
  forgetNote,
  leafArray,
  loadNotes,
  newNote,
  noteBackupBlob,
  noteRandomness,
  noteSecret,
  pathMatchesRoot,
  saveNote,
  readNoteLeaves,
  siblingsFor,
  updateNote,
  type StoredNote,
} from '../../lib/notes';
import { useAphoticTx } from '../../lib/tx';
import { useAsyncAction } from '../../lib/useAsyncAction';
import { listCoinsOf, readEscrowOf, readVaultSnapshot, type VaultTypeArgs } from '../../lib/vault';

export interface NotePanelProps {
  readonly typeArgs: VaultTypeArgs | null;
  readonly onChanged: () => void;
}

interface EscrowRead {
  readonly base: bigint;
  readonly quote: bigint;
  readonly walletSats: bigint;
  readonly noteRoot: Uint8Array;
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function NotePanel({ typeArgs, onChanged }: NotePanelProps) {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const tx = useAphoticTx();
  const escrow = useAsyncAction<EscrowRead>();
  const [notes, setNotes] = useState<readonly StoredNote[]>(() => loadNotes());
  const [denom, setDenom] = useState<Denomination | null>(null);
  const [fresh, setFresh] = useState<StoredNote | null>(null);
  const [spendNote, setSpendNote] = useState<string | null>(null);

  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_VAULT_ID', config.aphotic.vaultId],
  ]);

  const load = async (): Promise<EscrowRead> => {
    if (typeArgs === null) throw new Error('the vault’s type parameters have not been read yet');
    if (address === null) throw new Error('no address connected');
    const [balances, snapshot, coins] = await Promise.all([
      readEscrowOf(typeArgs, address),
      readVaultSnapshot(typeArgs),
      listCoinsOf(address, typeArgs[0]),
    ]);
    return {
      base: balances.base,
      quote: balances.quote,
      walletSats: coins.reduce((s, c) => s + c.balance, 0n),
      noteRoot: snapshot.noteRoot,
    };
  };

  const data = escrow.state.data;
  const busy = escrow.state.status === 'loading' || tx.isPending;
  const mine = notes.filter((n) => n.vaultId === config.aphotic.vaultId && n.spentAtMs === null);

  const create = () => {
    if (denom === null) return;
    const note = newNote(denom.index, config.aphotic.vaultId, Date.now());
    setFresh(note);
    setNotes(saveNote(note));
  };

  const depositFresh = async () => {
    if (fresh === null || typeArgs === null || address === null) return;
    const coins = await listCoinsOf(address, typeArgs[0]);
    const denomSats = config.constants.denominationsSats[fresh.denomIndex];
    if (denomSats === undefined) return;
    const result = await tx.send((t) =>
      buildDepositNote(t, {
        typeArgs,
        denomIndex: fresh.denomIndex,
        sats: denomSats,
        commitment: fromHex(fresh.commitmentHex),
        coinIds: coins.map((c) => c.objectId),
      }),
    );
    if (result.status === 'success') {
      // The leaf index is assigned by `append_commitment`; recover it from the
      // public leaf list rather than guessing at the next index.
      try {
        const leaves = await readNoteLeaves();
        const match = leaves.find((l) => toHex(l.commitment) === fresh.commitmentHex);
        if (match !== undefined) setNotes(updateNote(fresh.commitmentHex, { leafIndex: match.leafIndex }));
      } catch {
        // The deposit landed; only the index lookup failed. The note stays in the
        // wallet without one and the spend path will look it up again.
      }
      setFresh(null);
      onChanged();
      await escrow.run(load);
    }
  };

  const spend = async (note: StoredNote) => {
    if (typeArgs === null || data === null) return;
    setSpendNote(note.commitmentHex);
    try {
      const leaves = await readNoteLeaves();
      const array = leafArray(leaves);
      const index =
        note.leafIndex ?? leaves.find((l) => toHex(l.commitment) === note.commitmentHex)?.leafIndex ?? -1;
      if (index < 0) {
        throw new Error(
          'this note’s commitment is not in the published leaf list — its deposit has not landed',
        );
      }
      const siblings = siblingsFor(array, index, NOTE_TREE_DEPTH);
      if (!pathMatchesRoot(array[index]!, index, siblings, data.noteRoot)) {
        throw new Error(
          'the path rebuilt here does not fold to the root the vault published. Re-read the ' +
            'panel: the tree may have grown since this page loaded.',
        );
      }
      const result = await tx.send((t) =>
        buildSpendNote(t, {
          typeArgs,
          denomIndex: note.denomIndex,
          secret: noteSecret(note),
          randomness: noteRandomness(note),
          leafIndex: BigInt(index),
          siblings,
        }),
      );
      if (result.status === 'success') {
        setNotes(updateNote(note.commitmentHex, { spentAtMs: Date.now(), leafIndex: index }));
        onChanged();
        await escrow.run(load);
      }
    } catch (err) {
      // Surfaced through the same classifier the send path uses.
      await escrow.run(async () => {
        throw err;
      });
    } finally {
      setSpendNote(null);
    }
  };

  const topUp = async () => {
    if (denom === null || typeArgs === null || address === null) return;
    const coins = await listCoinsOf(address, typeArgs[0]);
    const result = await tx.send((t) =>
      buildTopUpBase(t, { typeArgs, sats: denom.sats, coinIds: coins.map((c) => c.objectId) }),
    );
    if (result.status === 'success') {
      onChanged();
      await escrow.run(load);
    }
  };

  const blocked =
    gap !== null
      ? gap
      : typeArgs === null
        ? 'Read the live batch first — every call here needs the vault’s type parameters.'
        : address === null
          ? 'Connect an address first.'
          : null;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Your internal balance</h3>
        <button
          type="button"
          className="ap-btn"
          disabled={blocked !== null || busy}
          title={blocked ?? 'Read your escrow balance and the note tree’s root'}
          onClick={() => void escrow.run(load)}
        >
          {escrow.state.status === 'loading' ? 'Reading…' : 'Read from chain'}
        </button>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {blocked !== null ? <p className="ap-reason ap-reason--warn">{blocked}</p> : null}
        {escrow.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{escrow.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            Orders draw on a persistent internal balance topped up independently of trading. That is
            not a convenience: funding escrow at order time leaks timing even when the denominations
            hide size. Escrow custody also sits outside the vault&rsquo;s NAV, so a settlement
            cannot move assets between the moment a NAV is proposed and the moment it is approved.
          </p>
        ) : (
          <div className="ap-grid ap-grid--2">
            <div className="ap-metric">
              <span className="ap-metric-label">Internal balance (base)</span>
              <span className="ap-metric-value">{formatBtc(data.base, { suffix: true })}</span>
              <span className="ap-metric-sub">what an order can be drawn against</span>
            </div>
            <div className="ap-metric">
              <span className="ap-metric-label">Internal balance (quote)</span>
              <span className="ap-metric-value">{formatSats(data.quote)}</span>
              <span className="ap-metric-sub">
                {formatBtc(data.walletSats, { suffix: true })} hBTC still in your wallet
              </span>
            </div>
          </div>
        )}

        <div className="ap-gate-section">
          <span className="ap-label">Denomination</span>
          <DenominationLadder selected={denom?.index ?? null} onSelect={setDenom} label="Note size" />
          <div className="ap-row">
            <button
              type="button"
              className="ap-btn ap-btn--primary"
              disabled={denom === null || blocked !== null || busy}
              title={
                blocked ??
                (denom === null
                  ? 'Choose a denomination first'
                  : 'Generate a secret and its commitment, in this browser')
              }
              onClick={create}
            >
              Create a note
            </button>
            <button
              type="button"
              className="ap-btn"
              disabled={denom === null || blocked !== null || busy || !tx.canSend}
              title={
                blocked ??
                tx.disabledReason ??
                'Add to the internal balance directly — no note, and the amount is public'
              }
              onClick={() => void topUp()}
            >
              Top up directly
            </button>
          </div>
        </div>

        {fresh === null ? null : (
          <div className="ap-gate-section">
            <p className="ap-reason ap-reason--error" style={{ fontSize: 'var(--text-sm)' }}>
              <strong>This is the only time this secret is shown.</strong> It exists in this browser
              and nowhere else — the contract sees only its commitment, and nothing on chain can
              reconstruct it. If you lose it, this note is unspendable by you, by us, and by
              everyone, permanently. Download it before you go any further.
            </p>
            <ul className="ap-rows ap-gate-rows">
              <li>
                <div className="ap-rowline">
                  <span className="ap-wallet-name">secret</span>
                  <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                    {fresh.secretHex}
                  </span>
                </div>
              </li>
              <li>
                <div className="ap-rowline">
                  <span className="ap-wallet-name">randomness</span>
                  <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                    {fresh.randomnessHex}
                  </span>
                </div>
              </li>
              <li>
                <div className="ap-rowline">
                  <span className="ap-wallet-name">commitment</span>
                  <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
                    {fresh.commitmentHex}
                  </span>
                </div>
              </li>
            </ul>
            <div className="ap-row">
              <button
                type="button"
                className="ap-btn ap-btn--primary"
                onClick={() => download(`aphotic-note-${fresh.commitmentHex.slice(0, 12)}.json`, noteBackupBlob([fresh]))}
                title="Download the secret. Treat the file as bearer: anyone holding it can spend the note."
              >
                Download the secret
              </button>
              <button
                type="button"
                className="ap-btn"
                disabled={busy || !tx.canSend || blocked !== null}
                title={blocked ?? tx.disabledReason ?? 'Pay the denomination and append the commitment'}
                onClick={() => void depositFresh()}
              >
                Escrow it
              </button>
              <button
                type="button"
                className="ap-btn ap-btn--ghost"
                onClick={() => {
                  setNotes(forgetNote(fresh.commitmentHex));
                  setFresh(null);
                }}
                title="Discard this note. It has not been escrowed, so nothing is lost."
              >
                Discard
              </button>
            </div>
          </div>
        )}

        <div className="ap-gate-section">
          <span className="ap-label">Notes held in this browser</span>
          {mine.length === 0 ? (
            <p className="ap-reason">
              None. Notes live in this browser&rsquo;s storage and in the files you downloaded —
              never on a server of ours.
            </p>
          ) : (
            <ul className="ap-rows ap-gate-rows">
              {mine.map((note) => (
                <li key={note.commitmentHex}>
                  <div className="ap-rowline">
                    <span className="ap-badge">
                      {formatBtc(config.constants.denominationsSats[note.denomIndex] ?? 0n)} hBTC
                    </span>
                    <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                      {truncateMiddle(note.commitmentHex, 8)}
                    </span>
                    <span className="aphotic-muted">
                      {note.leafIndex === null ? 'not escrowed yet' : `leaf ${note.leafIndex}`}
                    </span>
                    <button
                      type="button"
                      className="ap-btn"
                      disabled={busy || data === null || !tx.canSend || spendNote !== null}
                      title={
                        data === null
                          ? 'Read the panel first — the path is checked against the published root'
                          : tx.disabledReason ?? 'Retire this note into your internal balance'
                      }
                      onClick={() => void spend(note)}
                    >
                      {spendNote === note.commitmentHex ? 'Proving…' : 'Spend'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="ap-reason ap-reason--warn">
            A spend publishes the Merkle path in the clear, so <strong>the leaf index names the
            note</strong> and the spend is linkable to the deposit that funded it. v1 delivers
            uniformity, not unlinkability — the commitment and nullifier machinery earns its keep by
            making the zero-knowledge upgrade a verifier swap, not a redesign.
          </p>
        </div>

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

export default NotePanel;
