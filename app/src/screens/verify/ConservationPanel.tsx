// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §10 (invariants: note value in the tree equals custodied
//             minus deployed; supply × nav ≤ assets)
// @spec       docs/DESIGN-V2.md F3/D7 (escrow is a separate balance sheet),
//             §6 (committed_supply is the correct solvency denominator)
// @spec       move/sources/notes.move `assert_note_backing` ·
//             move/sources/vault.move `assert_solvent` · balance.move `assert_solvent`
// @rules      G7 G8
// @depends    ./checks.ts (F4 — the arithmetic) · ../../lib/vault.ts (the reads)
//             · ../../lib/moveRead.ts · ../../lib/useAsyncAction.ts
// @facts      EVERY NUMBER ON THIS PANEL IS RECOMPUTED IN THIS BROWSER from
// @facts        scalars the contract exposes. Nothing here is a claim we make; it
// @facts        is arithmetic you can redo, and a mismatch renders LOUDLY.
// @facts      THE ARITHMETIC LIVES IN ./checks.ts, not here. One module owns the
// @facts        identities and their `ok | bad | na` verdicts, so a panel cannot
// @facts        drift from what the tests pin — and 'na' is NEVER rendered as a
// @facts        pass.
// @facts      ⚠ WHAT IS *NOT* RE-DERIVABLE, stated rather than glossed: the
// @facts        BalanceBook's `total_credited` has NO public accessor in the
// @facts        deployed package, so `total_credited == custody_value` can only be
// @facts        asserted by the contract on every mutation, not recomputed from
// @facts        outside. It renders as 'na' with that exact reason.
// @facts      What this panel CAN add on top of the arithmetic is to ask the CHAIN
// @facts        to run `vault::assert_solvent` by simulation. It aborts if the
// @facts        identity does not hold, so a completed simulation is the
// @facts        contract's own verdict on its own current state.
// @implements export function ConservationPanel(): JSX.Element
// @forbidden  presenting a recomputed number that was not actually recomputed
// @forbidden  rendering 'na' as a green tick
// @invariant  1. A mismatch is red, unmissable, and states both sides.
// @invariant  2. A leg we cannot re-derive says so instead of showing a tick.
// @ac         renders unconfigured, reads nothing, names the missing variable.
// @verify     cd app && npm test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { toHex } from '@aphotic/sdk/hash';

import { config } from '../../config';
import { formatBtc } from '../../lib/format';
import { aphoticTarget, readMove, wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';
import { readVaultSnapshot, readVaultTypeArgs, type VaultSnapshot } from '../../lib/vault';
import { conservationChecks, worstVerdict, type Check, type CheckVerdict } from './checks';

interface ConservationRead {
  readonly snapshot: VaultSnapshot;
  /** Whether the chain's own `vault::assert_solvent` completed under simulation. */
  readonly assertSolvent: { readonly ok: boolean; readonly detail: string };
}

const BADGE: Readonly<Record<CheckVerdict, string>> = {
  ok: 'ap-badge ap-badge--live',
  bad: 'ap-badge ap-badge--warn',
  na: 'ap-badge',
};

const MARK: Readonly<Record<CheckVerdict, string>> = {
  ok: '✓ holds',
  bad: '✗ MISMATCH',
  na: 'not computable',
};

function CheckRow({ check }: { readonly check: Check }) {
  return (
    <li>
      <div className="ap-rowline">
        <span className={BADGE[check.verdict]}>{MARK[check.verdict]}</span>
        <span className="ap-wallet-name">
          {check.label}
          <br />
          <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
            {check.verdict === 'na'
              ? check.identity
              : `${check.left} ${check.verdict === 'ok' ? '=' : '≠'} ${check.right}`}
          </span>
          <br />
          <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
            {check.note} <em>({check.abort})</em>
          </span>
        </span>
      </div>
    </li>
  );
}

export function ConservationPanel() {
  const read = useAsyncAction<ConservationRead>();
  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_VAULT_ID', config.aphotic.vaultId],
  ]);

  const load = async (): Promise<ConservationRead> => {
    const typeArgs = await readVaultTypeArgs();
    const snapshot = await readVaultSnapshot(typeArgs);
    let assertSolvent = {
      ok: true,
      detail: 'the contract’s own assertion completed under simulation',
    };
    try {
      await readMove((tx) => {
        tx.moveCall({
          target: aphoticTarget('vault', 'assert_solvent'),
          typeArguments: [...typeArgs],
          arguments: [tx.object(config.aphotic.vaultId)],
        });
      });
    } catch (err) {
      assertSolvent = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    return { snapshot, assertSolvent };
  };

  const data = read.state.data;
  const snapshot = data?.snapshot ?? null;
  const checks = snapshot === null ? [] : conservationChecks(snapshot);
  const worst = checks.length === 0 ? null : worstVerdict(checks);

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Conservation, recomputed here</h3>
        <div className="ap-row">
          {worst === null ? null : (
            <span className={BADGE[worst]}>
              {worst === 'ok'
                ? 'every computable identity holds'
                : worst === 'bad'
                  ? 'an identity does NOT hold'
                  : 'one leg is not computable'}
            </span>
          )}
          <button
            type="button"
            className="ap-btn ap-btn--primary"
            disabled={gap !== null || read.state.status === 'loading'}
            title={gap ?? 'Read the scalars and redo the arithmetic in this browser'}
            onClick={() => void read.run(load)}
          >
            {read.state.status === 'loading' ? 'Reading…' : 'Recompute'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {read.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{read.state.error}</p>
        ) : null}

        {snapshot === null || data === null ? (
          <p className="ap-reason">
            No wallet is needed and none is asked for. This panel reads public scalars and redoes
            the vault&rsquo;s own identities in your browser — the point is that you do not have to
            take the tick on trust, because you can see both sides of every equation. A leg that
            cannot be recomputed from the published read surface says so; it never gets a tick.
          </p>
        ) : (
          <>
            <ul className="ap-rows ap-gate-rows">
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
              <li>
                <div className="ap-rowline">
                  <span className={data.assertSolvent.ok ? BADGE.ok : BADGE.bad}>
                    {data.assertSolvent.ok ? '✓ holds' : '✗ ABORTED'}
                  </span>
                  <span className="ap-wallet-name">
                    The contract&rsquo;s own assertion, run by simulation
                    <br />
                    <span className="aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                      vault::assert_solvent
                    </span>
                    <br />
                    <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                      {data.assertSolvent.detail}
                    </span>
                  </span>
                </div>
              </li>
            </ul>

            <div className="ap-grid ap-grid--2">
              <div className="ap-metric">
                <span className="ap-metric-label">Escrow custody (base)</span>
                <span className="ap-metric-value">
                  {formatBtc(snapshot.escrowBaseCustody, { suffix: true })}
                </span>
                <span className="ap-metric-sub">
                  held OUTSIDE NAV, so a settlement cannot move assets between propose and approve
                </span>
              </div>
              <div className="ap-metric">
                <span className="ap-metric-label">Note tree root</span>
                <span
                  className="aphotic-mono"
                  style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}
                >
                  {toHex(snapshot.noteRoot)}
                </span>
                <span className="ap-metric-sub">
                  depth 20 · every membership proof folds to one of the last 32 published roots
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default ConservationPanel;
