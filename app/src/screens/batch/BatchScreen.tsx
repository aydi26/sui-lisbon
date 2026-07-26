// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     PARTIAL
// @spec       aphotic.md §1 (sealed-order batch auction), §4.2 (the leak we route
//             around), §7.1 (notes), §7.2 (the batch), §7.3 (cadence),
//             §7.4 (what is and is not hidden), §7.5 (Seal committee)
// @spec       docs/DESIGN-V2.md §3 (the seal_approve entry, skew tolerance),
//             §4 (timing), §5 (clearing), §11 (the ladder), D8, D9
// @rules      G7 G8
// @depends    ../../components (F1) · ../../config.ts (F1) · ../../lib/cadence.ts
// @facts      WHY THE AUCTION EXISTS — put this on screen, it is the pitch:
// @facts        Hashi's `WithdrawalRequestQueue` is a PUBLIC Move object, and every
// @facts        pending `WithdrawalRequest` exposes `sender`, `btc_amount`,
// @facts        `bitcoin_address` and `created_timestamp_ms`. A desk unwinding a
// @facts        position is watched forming in real time. Aphotic crosses flow
// @facts        BEFORE it reaches the queue.
// @facts      Uniform-price clearing does not make front-running HARD, it makes it
// @facts        MEANINGLESS: everyone executes at the same price at the same
// @facts        instant. The time-lock supplies the confidentiality that makes the
// @facts        batch fair.
// @facts      SUBMIT carries NO amount, NO side, NO price on-chain: a ciphertext
// @facts        hash, a Walrus blob id and a reference to the internal balance.
// @facts        The commitment binds the PLAINTEXT — blake2b256(bcs(Order)) — not
// @facts        the ciphertext, because binding only the ciphertext would let a
// @facts        submitter publish one blob and later claim a different plaintext.
// @facts      Escrow uses FIXED DENOMINATIONS because a `Balance<BTC>` carries a
// @facts        publicly readable amount and would leak order size regardless of
// @facts        encryption. And participants hold a PERSISTENT internal balance
// @facts        topped up independently of trading, because funding escrow at order
// @facts        time leaks timing even when it does not leak size.
// @facts      TIMING: cadence 12 h, offset 6 h ⇒ 06:00 / 18:00 UTC. `open_batch`
// @facts        takes NO timestamp parameter; `close_ms` is derived. A FULL BATCH
// @facts        DOES NOT CLOSE EARLY — closing on fullness would hand a spammer
// @facts        exactly the timing lever uniform-price clearing exists to remove.
// @facts        SUBMIT_CUTOFF_MS = 60_000 · REVEAL_GRACE_MS = 600_000.
// @facts      ⚠ D9 — Seal committee n = 5 across 5 DISTINCT OPERATORS, t = 3.
// @facts        Count operators, not servers. Refuse to open a batch below t live.
// @facts        NEVER fall back to plaintext.
// @facts      ⚠ D8 — v1 note spends are LINKABLE (the Merkle path is in the clear).
// @facts      ⚠ MAX_BATCH_SIZE is governed at 256, hard cap 512 — the binding
// @facts        limits are 1 000 store entries and 1 024 events per transaction,
// @facts        neither of which can be raised by paying more gas.
// @implements export function BatchScreen(): JSX.Element
// @forbidden  a free-form amount field — the denomination ladder IS the product
// @forbidden  a free-form limit-price field: a size ladder plus an arbitrarily
//             precise price still fingerprints the order. The price ladder is
//             coarse for the same reason the size ladder is.
// @forbidden  claiming an order is encrypted before the Seal committee is wired
// @invariant  1. No enabled control can submit anything while the package is unset.
// @invariant  2. The cut-off state disables submission and says why.
// @invariant  3. The linkability disclosure renders unconditionally.
// @ac         renders with no wallet and no published package.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';

import {
  EpochClock,
  LifecycleStepper,
  LimitationsPanel,
  type LifecycleStage,
} from '../../components';
import { config } from '../../config';
import { readLiveBatch, type LiveBatch } from '../../lib/batch';
import { wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';
import { readVaultTypeArgs, type VaultTypeArgs } from '../../lib/vault';
import FillsPanel from './FillsPanel';
import LifecyclePanel from './LifecyclePanel';
import NotePanel from './NotePanel';
import OrderTicket from './OrderTicket';

const BATCH_STAGES: readonly LifecycleStage[] = [
  {
    index: 1,
    label: 'OPEN — submit',
    signal:
      'A ciphertext hash, a blob id and a reference to your internal balance. No amount, no side, no price touches the chain.',
    expected: 'Until 60 s before the boundary',
    timeClass: 'sui',
  },
  {
    index: 2,
    label: 'SEALED — close',
    signal:
      'close_batch checks the on-chain Clock and freezes the ledger. It reverts if called early, and a full batch still waits for the boundary.',
    expected: 'Exactly on 06:00 / 18:00 UTC',
    timeClass: 'delay',
  },
  {
    index: 3,
    label: 'CLEARING — reveal and match',
    signal:
      'The Seal time-lock becomes satisfiable, anyone fetches the key shares, orders are revealed against their commitments and the uniform price is computed on-chain.',
    expected: '10 min reveal grace',
    timeClass: 'delay',
  },
  {
    index: 4,
    label: 'SETTLED — push',
    signal:
      'Fills are pushed, not claimed, so settlement is terminal and no unclaimed liability lingers outside NAV. Every fill stays provable against the published root.',
    expected: 'One or more checkpoints, budget-driven',
    timeClass: 'sui',
  },
];

function WhyPanel() {
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Why this exists</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Hashi&rsquo;s withdrawal queue is a <strong>public Move object</strong>. Every pending
        request exposes who sent it, how much, to which Bitcoin address, and since when. A desk
        unwinding a position is not merely visible after the fact — it is watched forming, request
        by request, in real time.
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Aphotic crosses that flow <strong>before it reaches the queue</strong>. Orders are encrypted
        client-side under a time-lock and cannot be read by the operator, the keeper, or any single
        key server until the batch closes. Then everything clears at one price, at one instant.
      </p>
      <p className="ap-reason">
        Uniform-price clearing does not make front-running <em>hard</em>. It makes it{' '}
        <strong>meaningless</strong>: there is no better price to jump to, and no earlier instant to
        take it at. That is a structural answer rather than a latency race, and it is why the
        cadence is mechanical — an operator who could choose when a batch closes could advantage
        selected orders, which is exactly the attack this design removes.
      </p>
    </section>
  );
}

function SealCommitteePanel() {
  const { keyServerIds, keyServerUrls, threshold, policyVersion } = config.seal;
  const wired = keyServerIds.length > 0;

  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>The committee that holds the keys</h3>

      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Confidentiality before close is a <strong>{threshold}-of-n threshold</strong>, not a proof. n
        is counted in <strong>distinct operators</strong>, never in servers — two servers run by one
        party are one failure domain. The intended shape is 5 operators with a threshold of 3.
      </p>

      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        The committee deliberately excludes our zkLogin salt provider. Using one party for both
        identity and decryption would hand it linkage <em>and</em> plaintext, which is precisely the
        combination the design refuses.
      </p>

      {wired ? (
        <ul className="ap-kv">
          {keyServerIds.map((id, i) => (
            <li key={id}>
              <span className="aphotic-mono">{id}</span>
              <span className="aphotic-muted">{keyServerUrls[i] ?? 'url not configured'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ap-reason ap-reason--warn">
          No key servers are configured in this build (<code>VITE_SEAL_KEY_SERVER_IDS</code> is
          empty), so nothing here can be encrypted. That is a refusal, not a degraded mode: we never
          fall back to plaintext, and a batch does not open below the threshold of live servers.
        </p>
      )}

      {/* TODO(F3): probe /v1/service on each configured server and render live
          health. The probe needs BOTH a Client-Sdk-Version header and a
          ?service_id= query param or it answers 400. */}
      <p className="ap-reason">
        Policy version {policyVersion}. The identity a batch is encrypted under carries the close
        timestamp, the policy version and the batch id; bumping the version invalidates every
        outstanding identity at once. Liveness of the individual servers is not probed by this build
        yet, so nothing on this panel should be read as "these servers are up".
      </p>
    </section>
  );
}

export function BatchScreen() {
  const live = useAsyncAction<LiveBatch>();
  const typeArgs = useAsyncAction<VaultTypeArgs>();
  // The submit cut-off is a CONTRACT rule, so the controls that depend on it need
  // a clock. One tick a second, and only while this screen is mounted.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const registryGap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId],
  ]);

  const reload = useCallback(() => {
    void live.run(readLiveBatch);
    void typeArgs.run(readVaultTypeArgs);
  }, [live, typeArgs]);

  return (
    <div className="ap-page">
      <header className="ap-screen-head">
        <h1>Sealed-order batch auction</h1>
        <p>
          Orders are encrypted client-side under a time-lock and clear at a single uniform price
          twice a day. Opposing orders cross directly and never touch the public redemption queue.
        </p>
      </header>

      <div className="ap-grid ap-grid--2">
        <EpochClock />
        <WhyPanel />
      </div>

      <section className="ap-panel">
        <div className="ap-panel-head">
          <h3 className="ap-panel-title">The batch, as it stands</h3>
          <div className="ap-row">
            {live.state.data?.registry === undefined ? null : (
              <span className="ap-badge">
                policy v{live.state.data.registry.policyVersion.toString()} ·{' '}
                {live.state.data.registry.liveBatches.toString()} live
              </span>
            )}
            <button
              type="button"
              className="ap-btn ap-btn--primary"
              disabled={registryGap !== null || live.state.status === 'loading'}
              title={registryGap ?? 'Read the registry and find the batch that was last opened'}
              onClick={() => void live.run(readLiveBatch)}
            >
              {live.state.status === 'loading' ? 'Reading…' : 'Read the live batch'}
            </button>
          </div>
        </div>
        <div className="ap-panel-body">
          {registryGap !== null ? (
            <p className="ap-reason ap-reason--warn">
              {registryGap} The countdown above is a property of the calendar and is honest on its
              own; everything else on this screen waits for a registry to read.
            </p>
          ) : live.state.error !== null ? (
            <p className="ap-reason ap-reason--error">{live.state.error}</p>
          ) : live.state.data === null ? (
            <p className="ap-reason">
              Nothing on this screen reads on load. One press fetches the registry, discovers the
              batch object from the last <code>BatchOpened</code> event, and reads its state — after
              which the panels below can act.
            </p>
          ) : (
            <p className="ap-reason">
              Cadence {(Number(live.state.data.registry.cadenceMs) / 3_600_000).toFixed(0)} h, offset{' '}
              {(Number(live.state.data.registry.offsetMs) / 3_600_000).toFixed(0)} h — 06:00 and
              18:00 UTC. Submission stops{' '}
              {(Number(live.state.data.registry.submitCutoffMs) / 1000).toFixed(0)} s before close and
              the reveal window runs{' '}
              {(Number(live.state.data.registry.revealGraceMs) / 60_000).toFixed(0)} minutes after
              it. None of those is chosen per batch; they are governed parameters on the registry.
            </p>
          )}
        </div>
      </section>

      <div className="ap-grid ap-grid--2">
        <OrderTicket live={live.state.data} nowMs={nowMs} onSubmitted={reload} />
        <NotePanel typeArgs={typeArgs.state.data} onChanged={reload} />
      </div>

      <LifecyclePanel live={live.state.data} nowMs={nowMs} onChanged={reload} />

      <FillsPanel />

      <section className="aphotic-card">
        <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>One window, four states</h3>
        <p className="aphotic-muted" style={{ marginTop: 0 }}>
          Transitions are monotonic — no path returns to OPEN — and every one of them is
          permissionless. If the keeper is down, anyone can close, reveal, clear and settle at or
          after the scheduled time. The schedule and the commitments are the authorization.
        </p>
        <LifecycleStepper stages={BATCH_STAGES} current={1} />
      </section>

      <SealCommitteePanel />

      <section className="aphotic-card">
        <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>What is hidden, and for how long</h3>
        <ul style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', paddingLeft: '1.1rem' }}>
          <li>
            <strong>Before close:</strong> size, price and side, hidden from everyone — subject to
            the Seal threshold.
          </li>
          <li>
            <strong>After close:</strong> order contents are hidden from <strong>nobody</strong>,
            including unfilled orders.
          </li>
          <li>
            <strong>Always public:</strong> the clearing price and the aggregate volume, by design.
          </li>
          <li>
            <strong>Never hidden:</strong> the final redemption through Hashi. That queue is public
            and we do not claim otherwise.
          </li>
        </ul>
      </section>

      {/* 'custodial' leads deliberately. The app frame used to carry a one-line
          hBTC trust-model footer on every route; it is gone, so a screen that
          filters this panel is now the ONLY place that route states the trust
          model. Dropping it here would leave /batch — the screen that talks most
          about privacy — silent on what it is built upon. */}
      <LimitationsPanel
        title="What this auction does not do"
        only={['custodial', 'linkable', 'seal-threshold', 'anonymity-set']}
      />
    </div>
  );
}

export default BatchScreen;
