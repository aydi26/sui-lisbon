// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §1 (sealed-order batch auction), §7.2 (the batch),
//             §7.3 (cadence), §7.4 (what is and is not hidden)
// @spec       docs/DESIGN-V2.md §3 (the seal_approve entry, the cut-off), §4
//             (timing), §5 (clearing), §11 (the ladder), D8, D9
// @rules      G7 G8
// @depends    ../../components (F1) · ../../config.ts (F1) · ../../lib/batch.ts
// @facts      THIS SCREEN IS A SECONDARY SURFACE. The vault leads; the auction is
// @facts        the second product and reads as one — no pitch, no lifecycle
// @facts        essay, no committee dashboard. WHY the auction exists (the public
// @facts        `WithdrawalRequestQueue`, uniform-price clearing, the Seal
// @facts        committee, the four states) is TEACHING and now lives on /docs.
// @facts        What stays here is DOING plus the disclosures that belong beside
// @facts        the control that acts on them. If a sentence would sit equally
// @facts        well on /docs, it does not belong on this screen.
// @facts      WHAT MAY NEVER LEAVE THIS ROUTE, however short it gets:
// @facts        · no free-form amount OR price control anywhere (the denomination
// @facts          ladder IS the product — a `Balance<BTC>` carries a publicly
// @facts          readable value, so an exact-amount field would make encrypting
// @facts          the order pointless; a precise limit price fingerprints it just
// @facts          as well, which is why that ladder is coarse too);
// @facts        · the note secret shown ONCE, downloadable, with an unmissable
// @facts          warning that losing it makes the note unspendable by anyone;
// @facts        · ⚠ D8 — v1 note spends are LINKABLE. The Merkle path is public,
// @facts          so the leaf index names the note: uniformity, NOT unlinkability.
// @facts          It renders UNCONDITIONALLY — no wallet, no read, no config;
// @facts        · ⚠ D9 — never claim an order is encrypted unless it was. With no
// @facts          Seal committee wired the ticket refuses; there is no plaintext
// @facts          path and no degraded mode;
// @facts        · submission greys 60 s before close, with the reason stated.
// @facts      TIMING: cadence 12 h, offset 6 h ⇒ 06:00 / 18:00 UTC, governed on
// @facts        the registry rather than chosen per batch. The countdown lives in
// @facts        the app shell, so this screen does not repeat it.
// @implements export function BatchScreen(): JSX.Element
// @forbidden  a free-form amount or limit-price field
// @forbidden  claiming an order is encrypted before the Seal committee is wired
// @forbidden  re-teaching the auction here — link the reader to /docs instead
// @invariant  1. No enabled control can submit anything while the package is unset.
// @invariant  2. The cut-off state disables submission and says why.
// @invariant  3. The linkability disclosure renders unconditionally.
// @invariant  4. The route still reaches the custodial-threshold statement.
// @ac         renders with no wallet and no published package.
// @ac         app/test/batch.test.tsx — the 1e8 price scale, the plaintext
//             binding, both refusals (Seal, Walrus), the cut-off, the
//             unconditional linkability disclosure, and that the trim did not
//             take any of them with it.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';

import { LimitationsPanel } from '../../components';
import { config } from '../../config';
import { readLiveBatch, type LiveBatch } from '../../lib/batch';
import { wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';
import { readVaultTypeArgs, type VaultTypeArgs } from '../../lib/vault';
import FillsPanel from './FillsPanel';
import LifecyclePanel from './LifecyclePanel';
import NotePanel from './NotePanel';
import OrderTicket from './OrderTicket';

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

  const registry = live.state.data?.registry ?? null;

  return (
    <div className="ap-page">
      <header className="ap-screen-head">
        <h1>Sealed-order batch auction</h1>
        {/* One line of why, and no more. Hashi's queue being a public Move object
            is the whole argument for this product, so it stays — as a caption.
            The argument itself is on Docs. */}
        <p>
          The redemption queue is a public Move object, so a desk unwinding is watched forming.
          Orders here stay sealed until close and clear at one price, which makes front-running
          meaningless rather than merely hard. Why, in full, on Docs.
        </p>
      </header>

      <section className="ap-panel">
        <div className="ap-panel-head">
          <h3 className="ap-panel-title">The batch, as it stands</h3>
          <div className="ap-row">
            {registry === null ? null : (
              <span className="ap-badge">
                policy v{registry.policyVersion.toString()} · {registry.liveBatches.toString()} live
              </span>
            )}
            <button
              type="button"
              className="ap-btn ap-btn--primary"
              disabled={registryGap !== null || live.state.status === 'loading'}
              title={registryGap ?? 'Read the registry and find the batch that was last opened'}
              onClick={reload}
            >
              {live.state.status === 'loading' ? 'Reading…' : 'Read the live batch'}
            </button>
          </div>
        </div>
        <div className="ap-panel-body">
          {registryGap !== null ? (
            <p className="ap-reason ap-reason--warn">{registryGap}</p>
          ) : live.state.error !== null ? (
            <p className="ap-reason ap-reason--error">{live.state.error}</p>
          ) : registry === null ? (
            <p className="ap-reason">Nothing here reads on load. One press fetches the batch.</p>
          ) : (
            <p className="ap-reason">
              06:00 and 18:00 UTC — cadence {(Number(registry.cadenceMs) / 3_600_000).toFixed(0)} h,
              offset {(Number(registry.offsetMs) / 3_600_000).toFixed(0)} h. Submission stops{' '}
              {(Number(registry.submitCutoffMs) / 1000).toFixed(0)} s before close; reveal runs for{' '}
              {(Number(registry.revealGraceMs) / 60_000).toFixed(0)} minutes after it. Governed on
              the registry, not chosen per batch.
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

      {/* 'custodial' leads deliberately. The app frame carries no trust-model
          footer, so this panel is the ONLY place /batch states what hBTC is —
          and 'linkable' is the D8 disclosure in its uppercase, unsoftened form.
          Dropping either would leave the screen that talks most about privacy
          silent on what it is built upon. */}
      <LimitationsPanel
        title="What this auction does not do"
        only={['custodial', 'linkable', 'seal-threshold', 'anonymity-set']}
      />
    </div>
  );
}

export default BatchScreen;
