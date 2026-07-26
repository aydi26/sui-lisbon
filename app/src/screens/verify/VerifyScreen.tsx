// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     PARTIAL
// @spec       aphotic.md §2 constraint 5 (clearing is deterministic and
//             reproducible), §9 (keeper: clearing parity is a release blocker),
//             §10 (invariants), §13 (limitations)
// @spec       docs/DESIGN-V2.md §5 (clearing, exactly), §9 (why sdk/ is
//             structural; parity at three levels), §6 (approve_nav checks)
// @rules      G5 G7 G8
// @depends    ../../components (F1) · ../../config.ts (F1) · ../../lib/explorer.ts
// @facts      THE CLAIM THIS SCREEN HAS TO EARN: same order set, same price,
// @facts        always — and anyone can recompute it. Determinism is the product,
// @facts        so the verification surface is not a nicety.
// @facts      CLEARING, EXACTLY:
// @facts        1. Canonical order — bids by (limit DESC, submitter ASC, index
// @facts           ASC), asks by (limit ASC, submitter ASC, index ASC). Ties fully
// @facts           broken ⇒ zero implementation freedom.
// @facts        2. Price — candidates are the distinct limit prices present;
// @facts           vol(p) = min(demand(p), supply(p)); choose max vol, tie-break
// @facts           min |demand − supply|, tie-break lowest p. Integer only.
// @facts        3. Allocation — strictly-inside orders fill fully; orders at
// @facts           exactly p* are pro-rated floor(residual × qty_i / Σqty), with
// @facts           the remainder distributed one sat at a time by largest
// @facts           fractional remainder, tie-broken by canonical position.
// @facts        4. Limit safety asserted PER FILL, not merely by construction.
// @facts        5. Quote conversion rounds TOWARD THE VAULT so the dust residual
// @facts           can never be negative.
// @facts        6. Root — blake2b256 Merkle over blake2b256(0x00 ‖ bcs(FillLeaf))
// @facts           in canonical order, odd nodes duplicated.
// @facts      The fee is an EXPLICIT THIRD TERM, never a silent shortfall:
// @facts        Σdebits == Σcredits + fee.
// @facts      Solvency at settlement WITHOUT leaking size: no margin field exists
// @facts        on a sealed order, because a margin would leak size at submit time.
// @facts        Instead close_batch freezes the ledger and settlement
// @facts        deterministically truncates any fill an account cannot cover to
// @facts        min(fill, balance), recomputing the counterparty symmetrically from
// @facts        the same rule.
// @facts      ⚠ G5 — the Guardian limiter is TRUSTLESSLY REPLAYABLE:
// @facts        project_capacity() = min(cap, tokens + elapsed × refill_rate) over
// @facts        the on-chain WithdrawalSigned stream. It is re-derived from events,
// @facts        NOT read from a trusted SDK call.
// @facts      ⚠ The clearing algorithm must exist in exactly ONE place and be
// @facts        imported by Move, keeper and app alike. A second copy in this
// @facts        screen would reintroduce the drift the parity tests exist to catch.
// @implements export function VerifyScreen(): JSX.Element
// @forbidden  a second implementation of clearing, the Merkle tree or the Seal
//             identity encoding in app/ — import the shared one or render
//             <PendingCall/>
// @forbidden  presenting a recomputed number that was not actually recomputed
// @invariant  1. Every panel that cannot verify anything yet says so.
// @invariant  2. The wiring census shows what this build actually points at,
//                including the empty entries.
// @ac         renders with no wallet and no published package.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  LimitationsPanel,
  PendingCall,
  PinningExplainer,
} from '../../components';
import { config } from '../../config';
import { suiObjectUrl } from '../../lib/explorer';

interface WiringRow {
  readonly label: string;
  readonly value: string;
  /** True when the value is a Sui object/package id worth linking. */
  readonly link?: boolean;
  readonly note?: string;
}

function wiringRows(): readonly WiringRow[] {
  const a = config.aphotic;
  return [
    { label: 'Aphotic package', value: a.packageId, link: true, note: 'moveCall target' },
    {
      label: 'Aphotic package (original)',
      value: a.originalPackageId,
      link: true,
      note: 'type-argument origin — diverges from the target the moment we upgrade',
    },
    { label: 'Vault', value: a.vaultId, link: true },
    { label: 'Governance', value: a.governanceId, link: true },
    { label: 'BatchRegistry', value: a.batchRegistryId, link: true },
    { label: 'NoteTree', value: a.noteTreeId, link: true },
    { label: 'NullifierSet', value: a.nullifierSetId, link: true },
    {
      label: 'BalanceLedger',
      value: a.balanceLedgerId,
      link: true,
      note: 'escrow custody, deliberately outside vault NAV',
    },
    { label: 'AdapterAllowlist', value: a.adapterAllowlistId, link: true },
    { label: 'Hashi package', value: config.hashi.packageId, link: true },
    { label: 'Hashi object', value: config.hashi.objectId, link: true },
    { label: 'hBTC type', value: config.hashi.hbtcType },
    {
      label: 'DeepBook pool',
      value: config.deepbook.poolId,
      link: true,
      note: 'reference mid for the NAV deviation check',
    },
    { label: 'Walrus aggregator', value: config.walrus.aggregatorUrl },
    { label: 'Walrus publisher', value: config.walrus.publisherUrl },
    {
      label: 'Seal committee',
      value:
        config.seal.keyServerIds.length > 0
          ? `${config.seal.threshold} of ${config.seal.keyServerIds.length} operators`
          : '',
    },
    { label: 'Custody multisig', value: config.custody.multisigAddress, link: true },
    { label: 'Redemption address', value: config.custody.redemptionAddress },
  ];
}

function WiringCensus() {
  const rows = wiringRows();
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>What this build points at</h3>
      <p className="aphotic-muted" style={{ marginTop: 0 }}>
        Read from the bundle, not from a document. These values are inlined at build time, so this
        table is the only reliable way to know what a deployed page is actually talking to — an
        empty row means the build shipped without it.
      </p>
      <ul className="ap-kv">
        {rows.map((row) => (
          <li key={row.label}>
            <span>{row.label}</span>
            {row.value.length === 0 ? (
              <span className="aphotic-muted">not configured</span>
            ) : row.link === true ? (
              <a
                className="aphotic-mono"
                href={suiObjectUrl(row.value)}
                target="_blank"
                rel="noreferrer"
              >
                {row.value}
              </a>
            ) : (
              <span className="aphotic-mono">{row.value}</span>
            )}
            {row.note !== undefined ? <span className="aphotic-muted">{row.note}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeterminismPanel() {
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>The rule, in full</h3>
      <p className="aphotic-muted" style={{ marginTop: 0 }}>
        Written out because a verification surface that asks you to trust the summary is not a
        verification surface. Every tie below is broken, so there is no implementation freedom left
        for two honest implementations to disagree over.
      </p>
      <ol style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', paddingLeft: '1.2rem' }}>
        <li>
          <strong>Canonical order.</strong> Bids by limit price descending, then submitter bytes
          ascending, then submission index. Asks the same with price ascending.
        </li>
        <li>
          <strong>Price discovery.</strong> The candidates are the distinct limit prices actually
          present. For each, executable volume is the smaller of demand and supply. Take the maximum
          volume; break ties by the smallest imbalance; break remaining ties by the lowest price.
          Integer arithmetic throughout — there is no floating point anywhere in the path.
        </li>
        <li>
          <strong>Allocation.</strong> Orders strictly inside the cross fill completely. Orders
          exactly at the clearing price share the residual pro-rata, rounded down, and the leftover
          sats go one at a time to the largest fractional remainders, ties broken by canonical
          position.
        </li>
        <li>
          <strong>Limit safety.</strong> Asserted per fill rather than assumed from the construction:
          a bid never pays above its limit, an ask never sells below its.
        </li>
        <li>
          <strong>Rounding.</strong> Quote conversion rounds toward the vault, so the dust residual
          can never be negative.
        </li>
        <li>
          <strong>The root.</strong> A blake2b256 Merkle tree over domain-separated fill leaves in
          canonical order, odd nodes duplicated. Publishing the root is what makes an individual
          fill provable without publishing a list.
        </li>
      </ol>
      <p className="ap-reason">
        Settlement is value-preserving or it reverts, and the fee is an explicit third term rather
        than a silent shortfall: debits equal credits plus fee. Under-funded accounts are handled by
        a rule, not by a rejection — the ledger freezes at close and any fill an account cannot cover
        is truncated deterministically, with the counterparty recomputed symmetrically from the same
        frozen snapshot.
      </p>
      <p className="ap-reason">
        Fills are pushed rather than claimed. A pull model would leave an unbounded unclaimed
        liability that has to be excluded from NAV and reconciled forever; pushing makes settlement
        terminal, and the proof-of-fill button below is what the claim story was actually for.
      </p>
    </section>
  );
}

export function VerifyScreen() {
  return (
    <div className="ap-page">
      <header className="ap-screen-head">
        <h1>Recompute it yourself</h1>
        <p>
          Same order set, same price, always. Everything on this page is either something you can
          check without trusting us, or a statement that we cannot yet let you check it.
        </p>
      </header>

      <DeterminismPanel />

      <div className="ap-grid ap-grid--2">
        {/* TODO(F4): fetch a settled batch's revealed orders, run the SHARED
            clearing implementation locally, and compare the price and the fills
            root byte-for-byte against the on-chain BatchSettled event. The
            algorithm must be imported, never re-implemented here. */}
        <PendingCall
          title="Recompute a batch"
          targets={['clearing::begin_clearing', 'clearing::price_step', 'clearing::compute_for_inspect']}
          reason="There is no settled batch to recompute, and the clearing implementation lives in one shared place by design — a second copy in this screen is exactly the drift the parity tests exist to catch."
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
            When this is wired it fetches the revealed order set, runs the same algorithm the
            contract runs, and compares the clearing price and the Merkle root byte-for-byte. A
            divergence between the two implementations is a release blocker, not a warning.
          </p>
        </PendingCall>

        {/* TODO(F4): verify_fill — prove one fill against the published
            fills_root without downloading the whole fill list. */}
        <PendingCall
          title="Prove a fill"
          targets={['clearing::verify_fill']}
          reason="No settled batch exists yet, so there is no root to prove against."
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
            A fill is provable against the published root by a Merkle path, so you can check your
            own execution without downloading everyone else&rsquo;s — and without us being able to
            show you a different list from the one we settled.
          </p>
        </PendingCall>
      </div>

      <div className="ap-grid ap-grid--2">
        {/* TODO(F4): re-derive the Guardian limiter from the on-chain
            WithdrawalSigned event stream —
            project_capacity() = min(cap, tokens + elapsed × refill_rate) — using
            the shared implementation, and show it beside the advisory SDK read. */}
        <PendingCall
          title="Re-derive the queue limiter"
          targets={['hashi withdrawal event stream', 'oracle::project_capacity']}
          reason="This build does not stream Hashi events yet. The number matters too much to show from a trusted read in the meantime."
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
            The Guardian&rsquo;s rate limiter is a token bucket, and its state is a deterministic
            projection of an event stream that is already on-chain: capacity is the smaller of the
            cap and the tokens plus elapsed time times the refill rate. That makes it{' '}
            <strong>replayable by anyone</strong> rather than something you take on faith from an
            SDK call — which is the whole reason the latency model can be audited at all.
          </p>
        </PendingCall>

        {/* TODO(F4): read the last approved epoch price and the proposal digest,
            and show the five approve_nav checks against their governed bounds. */}
        <PendingCall
          title="Check the last valuation"
          targets={['vault::propose_nav', 'vault::approve_nav']}
          reason="No vault is configured in this build, so there is no epoch price and no proposal digest to check."
        >
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
            Approval is not a rubber stamp on a number the keeper chose. The multisig signs an exact
            digest, and the contract re-checks that digest, the proposal&rsquo;s age, the relative
            NAV jump, the deviation between the clearing price and the book mid, and the cap on the
            native-BTC leg — then asserts solvency against committed supply, which is the correct
            denominator because total supply undercounts owed-but-unminted shares.
          </p>
        </PendingCall>
      </div>

      <PinningExplainer />

      <WiringCensus />

      <LimitationsPanel />
    </div>
  );
}

export default VerifyScreen;
