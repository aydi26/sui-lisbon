// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §6.2 (NAV: two PARTIES, not two scopes), §7.7 (the legs
//             and the honest gap)
// @spec       docs/DESIGN-V2.md §6 (approve_nav, the O(1) form — the ten checks)
// @spec       move/sources/vault.move — `NavProposal`, `proposal_digest`,
//             `approve_nav` steps 1-5
// @rules      G7 G8
// @depends    ../../lib/vault.ts (F2) · ../../lib/useAsyncAction.ts
// @facts      THE MOST DIFFERENTIATING SURFACE IN THE PRODUCT, so it is itemised
// @facts        rather than summarised. NAV is a keeper PROPOSAL and an admin
// @facts        APPROVAL — two parties, not two scopes of one automation key.
// @facts      THE FOUR LEGS: idle + deployed + in-flight + native BTC.
// @facts        · idle is the one leg MOVE CHECKS ITSELF: `approve_nav` asserts
// @facts          `p.idle_sats == v.base.value()` (EIdleMismatch).
// @facts        · native BTC is NOT VERIFIABLE BY MOVE — Sui has no Bitcoin light
// @facts          client. The contract caps it at the on-Sui withdrawal claims
// @facts          behind it (ENavLegUncapped). That cap is the honest bound and is
// @facts          printed beside the greyed leg, never rounded off.
// @facts      THE DIGEST IS RECOMPUTED HERE. `blake2b256(bcs(NavProposal))` over
// @facts        the ten fields the contract exposes, compared byte-for-byte with
// @facts        `current_proposal_digest`. That is what the multisig signs, so a
// @facts        keeper cannot swap different numbers in between the signature and
// @facts        the transaction — and you do not have to take our word for it.
// @facts      APPROVAL STATE is derived, not asserted: `approve_nav` clears the
// @facts        proposal and bumps the epoch, so "a proposal is outstanding" means
// @facts        exactly "the admin multisig has not approved it yet".
// @implements export function NavPanel(): JSX.Element
// @forbidden  presenting the native-BTC leg as verified, or dropping its cap
// @forbidden  a read on mount
// @invariant  1. The unverifiable leg is visually distinct AND annotated.
// @invariant  2. The digest comparison is a real byte comparison, or it says it
//                could not be made.
// @ac         renders unconfigured, reads nothing, and says why.
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bytesEqual, toHex } from '@aphotic/sdk/hash';

import { config } from '../../config';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';
import {
  proposalDigest,
  proposalNavAssets,
  readProposal,
  readVaultSnapshot,
  readVaultTypeArgs,
  type VaultProposal,
  type VaultSnapshot,
} from '../../lib/vault';

interface NavRead {
  readonly snapshot: VaultSnapshot;
  readonly proposal: VaultProposal | null;
}

function Leg({
  label,
  sats,
  note,
  unverifiable = false,
}: {
  label: string;
  sats: bigint;
  note: string;
  unverifiable?: boolean;
}) {
  return (
    <li>
      <div className="ap-rowline" style={unverifiable ? { opacity: 0.55 } : undefined}>
        <span className="ap-wallet-name">
          {label}
          {unverifiable ? <span className="ap-badge ap-badge--warn"> not verifiable by Move</span> : null}
          <br />
          <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
            {note}
          </span>
        </span>
        <span className="ap-num">{formatBtc(sats, { suffix: true })}</span>
      </div>
    </li>
  );
}

export function NavPanel() {
  const nav = useAsyncAction<NavRead>();
  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_VAULT_ID', config.aphotic.vaultId],
  ]);

  const load = async (): Promise<NavRead> => {
    const typeArgs = await readVaultTypeArgs();
    const snapshot = await readVaultSnapshot(typeArgs);
    const proposal = snapshot.hasProposal ? await readProposal(typeArgs) : null;
    return { snapshot, proposal };
  };

  const data = nav.state.data;
  const proposal = data?.proposal ?? null;
  const recomputed = proposal === null ? null : proposalDigest(proposal);
  const digestAgrees =
    proposal === null || recomputed === null ? null : bytesEqual(recomputed, proposal.digest);

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">The valuation, itemised</h3>
        <div className="ap-row">
          {data === null ? null : (
            <span className={proposal === null ? 'ap-badge' : 'ap-badge ap-badge--warn'}>
              {proposal === null ? 'no proposal outstanding' : 'awaiting admin approval'}
            </span>
          )}
          <button
            type="button"
            className="ap-btn"
            disabled={gap !== null || nav.state.status === 'loading'}
            title={gap ?? 'Read the vault’s NAV legs and any outstanding proposal'}
            onClick={() => void nav.run(load)}
          >
            {nav.state.status === 'loading' ? 'Reading…' : 'Read from chain'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {nav.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{nav.state.error}</p>
        ) : null}

        {data === null ? (
          <p className="ap-reason">
            NAV is a keeper <strong>proposal</strong> and an admin <strong>approval</strong> — two
            parties, not two scopes of one automation key. Read it and every leg appears
            separately, with the one leg Move cannot verify greyed and capped.
          </p>
        ) : proposal === null ? (
          <>
            <p className="ap-reason">
              No proposal is outstanding. The vault is at epoch{' '}
              <strong>{data.snapshot.epoch.toString()}</strong>, and the last approved price was{' '}
              {data.snapshot.lastNavSupply === 0n
                ? 'par — no shares exist yet'
                : `${formatSats(data.snapshot.lastNavAssets)} assets over ${formatSats(data.snapshot.lastNavSupply)} shares`}
              {data.snapshot.lastNavAtMs === 0n
                ? '.'
                : `, approved ${new Date(Number(data.snapshot.lastNavAtMs)).toUTCString()}.`}
            </p>
            <ul className="ap-rows ap-gate-rows">
              <Leg
                label="Idle hBTC"
                sats={data.snapshot.idleSats}
                note="read directly from the vault's own balance — the one leg approve_nav checks itself (EIdleMismatch)"
              />
              <Leg
                label="Deployed"
                sats={data.snapshot.deployedSats}
                note="lending-adapter positions, converted from shares to assets"
              />
              <Leg
                label="In flight"
                sats={data.snapshot.inFlightSats}
                note="withdrawal transactions referencing our own request ids"
              />
              <Leg
                label="Native BTC"
                sats={data.snapshot.nativeBtcSats}
                unverifiable
                note={`Sui has no Bitcoin light client. Capped at the on-Sui claim of ${formatSats(
                  data.snapshot.hashiClaimsSats,
                )} sats — the contract asserts native_btc ≤ hashi_claims and reverts otherwise.`}
              />
            </ul>
          </>
        ) : (
          <>
            <p className="ap-reason ap-reason--warn">
              A proposal is outstanding for epoch <strong>{proposal.epoch.toString()}</strong>,
              recorded by <span className="aphotic-mono">{truncateMiddle(proposal.proposer)}</span>{' '}
              at {new Date(Number(proposal.proposedAtMs)).toUTCString()}. It commits nothing until
              the admin multisig approves this exact digest.
            </p>

            <ul className="ap-rows ap-gate-rows">
              <Leg
                label="Idle hBTC"
                sats={proposal.idleSats}
                note={
                  proposal.idleSats === data.snapshot.idleSats
                    ? 'matches the vault’s own balance — the leg Move checks itself'
                    : `DISAGREES with the vault’s balance of ${formatSats(data.snapshot.idleSats)} sats; approve_nav would abort EIdleMismatch`
                }
              />
              <Leg label="Deployed" sats={proposal.deployedSats} note="lending-adapter positions" />
              <Leg label="In flight" sats={proposal.inFlightSats} note="withdrawals in flight" />
              <Leg
                label="Native BTC"
                sats={proposal.nativeBtcSats}
                unverifiable
                note={`Not readable by Move — capped at the on-Sui claim of ${formatSats(
                  proposal.hashiClaimsSats,
                )} sats.`}
              />
              <li>
                <div className="ap-rowline">
                  <span className="ap-wallet-name">
                    <strong>Total NAV</strong>
                    <br />
                    <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                      summed in this browser from the four legs above
                    </span>
                  </span>
                  <span className="ap-num">
                    {formatBtc(proposalNavAssets(proposal), { suffix: true })}
                  </span>
                </div>
              </li>
            </ul>

            <div className="ap-gate-section">
              <span className="ap-label">The digest the multisig signs</span>
              <p className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', margin: 0, wordBreak: 'break-all' }}>
                {toHex(proposal.digest)}
              </p>
              <p className={digestAgrees === true ? 'ap-reason ap-reason--ok' : 'ap-reason ap-reason--error'}>
                {digestAgrees === true
                  ? 'Recomputed in your browser from the ten fields above — blake2b256 over the BCS of the proposal — and it matches the digest the contract holds, byte for byte.'
                  : 'The digest recomputed here does NOT match the one on chain. That means the fields shown do not serialise to the digest the multisig would be signing; do not approve it.'}
              </p>
              {digestAgrees === true ? null : (
                <p className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', margin: 0, wordBreak: 'break-all' }}>
                  recomputed: {recomputed === null ? '—' : toHex(recomputed)}
                </p>
              )}
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">What approval will re-check</span>
              <ul className="ap-rows ap-gate-rows">
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">Proposal age</span>
                    <span className="aphotic-muted">
                      must be ≤ {(Number(data.snapshot.maxProposalAgeMs) / 60_000).toFixed(0)} min
                    </span>
                  </div>
                </li>
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">NAV jump</span>
                    <span className="aphotic-muted">
                      ≤ {data.snapshot.maxNavJumpBps.toString()} bps against the last approved price
                    </span>
                  </div>
                </li>
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">Clearing price vs book mid</span>
                    <span className="aphotic-muted">
                      ≤ {data.snapshot.maxPriceDevBps.toString()} bps ·{' '}
                      {proposal.bookMid === 0n
                        ? 'no reference this epoch (an empty book is a defined state, not a brick)'
                        : `mid ${formatSats(proposal.bookMid)}`}
                    </span>
                  </div>
                </li>
                <li>
                  <div className="ap-rowline">
                    <span className="ap-wallet-name">Native-BTC cap</span>
                    <span className="aphotic-muted">
                      {proposal.nativeBtcSats <= proposal.hashiClaimsSats ? 'within' : 'EXCEEDS'} the
                      on-Sui claims behind it
                    </span>
                  </div>
                </li>
              </ul>
            </div>
          </>
        )}

        <p className="ap-reason">
          Approval is not a rubber stamp on a number the keeper chose. The multisig signs an exact
          digest and the contract re-checks that digest, the proposal&rsquo;s age, the relative NAV
          jump, the clearing-versus-mid deviation and the cap on the native-BTC leg — then asserts
          solvency against <em>committed</em> supply, which is the correct denominator because total
          supply undercounts owed-but-unminted shares.
        </p>
      </div>
    </section>
  );
}

export default NavPanel;
