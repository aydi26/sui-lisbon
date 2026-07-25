// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     STUB
// @spec       docs/APP.md §4 (Screen 3 — Transparency, L158-L211)
// @spec       docs/BUILD-PLAN.md Phase 5 T5.2 · docs/KEEPER.md#verify #journal
// @rules      G2 G5 G8 G9
// @depends    ../../components (T0.4) · ../../fixtures (T0.4) · ../../config.ts (T0.4)
//             keeper/src/verify/ (T4.3) · keeper/src/journal/ (T4.2)
// @facts      The strategy blob shown is CIPHERTEXT. Seal-gated by
// @facts        aphotic::vault::seal_approve; identity namespaced to the vault
// @facts        object + version epoch. rotate_keeper increments the epoch.
// @facts      Walrus blobs are PUBLIC and content-addressed — encrypt before
// @facts        upload, always. Decision log is published on a LAG (front-run
// @facts        defence).
// @facts      NAV is valued at the DeepBook MID, never raw Pyth (G9).
// @facts      ⚠ WALRUS_AGGREGATOR is UNKNOWN (U7 / DAY-ONE D8). config.walrus
// @facts        .aggregatorUrl is '' until then — the viewer must degrade, not
// @facts        crash.
// @facts      ⚠ The hosted DeepBook indexer does NOT list hBTC/DBUSDC — never read
// @facts        the book from it. Simulate pool::mid_price / get_level2_range
// @facts        instead. (RECON R10)
// @implements export function TransparencyScreen(): JSX.Element
// @forbidden  framing the limiter as a trusted SDK read — G5
// @forbidden  a canonical id literal in this file — G7, A10
// @invariant  1. <BridgeColumn/> shows SDK read and replay side by side.
// @invariant  2. <KeeperCapabilityBadge/> and <TrustModelDisclosure/> are present.
// @invariant  3. The strategy blob is never rendered as plaintext.
// @ac         docs/APP.md §7 A7 A8 A9
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';

import {
  BridgeColumn,
  KeeperCapabilityBadge,
  StaleBanner,
  TrustModelDisclosure,
} from '../../components';
import { bridgeFixture, decisionFixtures, demoFixtures, strategyFixture } from '../../fixtures';
import type { LimiterReading } from '../../fixtures';
import { formatSats, truncateMiddle } from '../../lib/format';

function EncryptedStrategyBlob() {
  return (
    <section className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <span className="aphotic-muted">In-force strategy — ciphertext</span>
      <span className="aphotic-mono">{truncateMiddle(strategyFixture.blobId, 10)}</span>
      <span className="aphotic-mono" style={{ color: 'var(--text-muted)' }}>
        {strategyFixture.ciphertextPreview}…
      </span>
      <span className="aphotic-muted">
        Version epoch {strategyFixture.versionEpoch} · {strategyFixture.sizeBytes} bytes ·
        Seal-gated by <code>aphotic::vault::seal_approve</code>, identity namespaced to the vault
        object and this epoch. Rotating the keeper increments the epoch and invalidates every
        previously derived key share.
      </span>
    </section>
  );
}

function DecisionLogViewer() {
  // TODO(T5.2): paginate real records fetched from config.walrus.aggregatorUrl
  // (UNKNOWN until DAY-ONE D8 — degrade to fixtures, never crash) and link each
  // blob id emitted on-chain by aphotic::journal.
  return (
    <section className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <span className="aphotic-muted">Decision log (published on a lag)</span>
      {decisionFixtures.map((d) => (
        <div key={d.seq} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <span className="aphotic-mono" style={{ color: 'var(--accent)' }}>
              #{d.seq}
            </span>
            <span style={{ fontSize: 'var(--text-sm)' }}>{d.decision}</span>
          </div>
          <span className="aphotic-muted">
            limiter {formatSats(d.hashi.limiterCapacitySats)} · queue {d.hashi.queueDepth} · pending
            mint {formatSats(d.hashi.pendingMintSats)} · buffer{' '}
            {formatSats(d.hashi.redemptionBufferSats)}
          </span>
        </div>
      ))}
    </section>
  );
}

export function TransparencyScreen() {
  const [replay, setReplay] = useState<LimiterReading | null>(null);
  const [replaying, setReplaying] = useState(false);

  const onReplay = () => {
    // TODO(T5.2): call rederiveCongestion() (keeper verify/ bridge-replay). In
    // DEMO_MODE=mock resolve from bridgeFixture.expectedReplay — zero network.
    setReplaying(true);
    setReplay(bridgeFixture.expectedReplay);
    setReplaying(false);
  };

  return (
    <div className="aphotic-container" style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <header>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>Transparency</h1>
        <p className="aphotic-muted">
          The strategy stays private. Every decision it produced, and every bridge condition it
          reacted to, is replayable by anyone.
        </p>
      </header>

      <StaleBanner tripped={demoFixtures.breakerTripped} />

      <div style={{ display: 'grid', gap: 'var(--space-5)', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <EncryptedStrategyBlob />
          <DecisionLogViewer />
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <BridgeColumn
            bridge={bridgeFixture}
            replay={replay}
            replaying={replaying}
            onReplay={onReplay}
          />
          <KeeperCapabilityBadge />
          <TrustModelDisclosure variant="expander" />
        </div>
      </div>
    </div>
  );
}

export default TransparencyScreen;
