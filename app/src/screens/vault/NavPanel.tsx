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
// @facts      THE MOST DIFFERENTIATING SURFACE IN THE PRODUCT, so it is the one
// @facts        panel here that stays itemised rather than summarised: the keeper's
// @facts        proposal leg by leg, the digest, and who has signed it.
// @facts      NAV IS TWO PARTIES, NOT TWO SCOPES: `propose_nav` (keeper, records
// @facts        only) and `approve_nav` (admin multisig, commits). That sentence is
// @facts        load-bearing and stays on screen in both states.
// @facts      THE FOUR LEGS: idle + deployed + in-flight + native BTC.
// @facts        · idle is the one leg MOVE CHECKS ITSELF: `approve_nav` asserts
// @facts          `p.idle_sats == v.base.value()` (EIdleMismatch).
// @facts        · native BTC is NOT VERIFIABLE BY MOVE — Sui has no Bitcoin light
// @facts          client. The contract caps it at the on-Sui withdrawal claims
// @facts          behind it (ENavLegUncapped). That cap is the honest bound: the
// @facts          leg is greyed, badged and printed with its cap, never rounded off.
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
// @forbidden  restating the mechanism in prose — that moved to /docs
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

function Check({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <div className="ap-rowline">
        <span className="ap-wallet-name">{label}</span>
        <span className="aphotic-muted">{value}</span>
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

        <p className="ap-reason">
          Two <strong>parties</strong>, not two scopes of one automation key: the keeper writes a{' '}
          <strong>proposal</strong> that commits nothing, an admin multisig signs the{' '}
          <strong>approval</strong> that does.
        </p>
        <p className="ap-reason">
          Four legs — idle, deployed, in flight, native BTC. The last is{' '}
          <strong>not verifiable by Move</strong> and is capped at the on-Sui withdrawal claims
          behind it.
        </p>

        {data === null ? null : proposal === null ? (
          <>
            <ul className="ap-rows ap-gate-rows">
              <Leg
                label="Idle hBTC"
                sats={data.snapshot.idleSats}
                note="the vault’s own balance — the one leg approve_nav checks itself"
              />
              <Leg
                label="Deployed"
                sats={data.snapshot.deployedSats}
                note="lending-adapter shares, converted to assets"
              />
              <Leg
                label="In flight"
                sats={data.snapshot.inFlightSats}
                note="withdrawals referencing our own request ids"
              />
              <Leg
                label="Native BTC"
                sats={data.snapshot.nativeBtcSats}
                unverifiable
                note={`Capped at the on-Sui claim of ${formatSats(
                  data.snapshot.hashiClaimsSats,
                )} sats — the contract reverts above it.`}
              />
            </ul>
            <p className="ap-reason">
              No proposal outstanding at epoch <strong>{data.snapshot.epoch.toString()}</strong>.
              Last approved{' '}
              {data.snapshot.lastNavAtMs === 0n
                ? 'never'
                : new Date(Number(data.snapshot.lastNavAtMs)).toUTCString()}
              .
            </p>
          </>
        ) : (
          <>
            <ul className="ap-rows ap-gate-rows">
              <Leg
                label="Idle hBTC"
                sats={proposal.idleSats}
                note={
                  proposal.idleSats === data.snapshot.idleSats
                    ? 'matches the vault’s own balance — the leg Move checks itself'
                    : `DISAGREES with the vault’s ${formatSats(data.snapshot.idleSats)} sats; approve_nav would abort EIdleMismatch`
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
                      summed in this browser from the four legs — it is not a signed field
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
                  ? 'Recomputed here from the ten fields above and matched byte for byte.'
                  : 'Recomputed here and it does NOT match the digest on chain. Do not approve it.'}
              </p>
              {digestAgrees === true ? null : (
                <p className="aphotic-mono" style={{ fontSize: 'var(--text-xs)', margin: 0, wordBreak: 'break-all' }}>
                  recomputed: {recomputed === null ? '—' : toHex(recomputed)}
                </p>
              )}
            </div>

            <div className="ap-gate-section">
              <span className="ap-label">
                What approve_nav re-checks · proposed by {truncateMiddle(proposal.proposer)} at{' '}
                {new Date(Number(proposal.proposedAtMs)).toUTCString()}
              </span>
              <ul className="ap-rows ap-gate-rows">
                <Check
                  label="Proposal age"
                  value={`≤ ${(Number(data.snapshot.maxProposalAgeMs) / 60_000).toFixed(0)} min`}
                />
                <Check
                  label="NAV jump"
                  value={`≤ ${data.snapshot.maxNavJumpBps.toString()} bps on the last approved price`}
                />
                <Check
                  label="Clearing vs book mid"
                  value={`≤ ${data.snapshot.maxPriceDevBps.toString()} bps · ${
                    proposal.bookMid === 0n
                      ? 'no reference this epoch'
                      : `mid ${formatSats(proposal.bookMid)}`
                  }`}
                />
                <Check
                  label="Native-BTC cap"
                  value={`${
                    proposal.nativeBtcSats <= proposal.hashiClaimsSats ? 'within' : 'EXCEEDS'
                  } the on-Sui claims behind it`}
                />
                <Check label="Solvency" value="against committed supply, not total supply" />
              </ul>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default NavPanel;
