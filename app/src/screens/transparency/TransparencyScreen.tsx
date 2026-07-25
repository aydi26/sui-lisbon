// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4 (Screen 3 — Transparency, L158-L211)
// @spec       docs/APP.md ERRATA E-A6 (bridge column honesty), E-A7 (empty book)
// @spec       docs/BUILD-PLAN.md Phase 5 T5.2 · docs/KEEPER.md#verify #journal
// @rules      G2 G5 G6 G8 G9
// @depends    ./EncryptedStrategyPanel.tsx ./DecisionLogViewer.tsx
//             ./verifyClient.ts ./display.ts ./transparency.css (T5.2)
//             ../../components (T0.4) · ../../fixtures (T0.4) · ../../config.ts (T0.4)
//             ../../session/useSession.ts (T3.3)
//             keeper/src/verify/ (T4.3) · keeper/src/journal/ (T4.2)
// @facts      The strategy blob shown is CIPHERTEXT. Seal-gated by
// @facts        aphotic::vault::seal_approve; identity namespaced to the vault
// @facts        object + version epoch. rotate_keeper increments the epoch.
// @facts      Walrus blobs are PUBLIC and content-addressed — encrypt before
// @facts        upload, always. Decision log is published on a LAG (front-run
// @facts        defence).
// @facts      NAV is valued at the DeepBook MID, never raw Pyth (G9).
// @facts      ⚠ The hBTC/DBUSDC book is EMPTY on both sides and the hosted indexer
// @facts        does not even list the pool — "no book" is a first-class rendered
// @facts        state, never an error boundary. (RECON R10, E-A7)
// @facts      ⚠ VITE_APHOTIC_PACKAGE_ID / VITE_VAULT_ID are empty until the
// @facts        package is published; missingLiveConfig() names what is missing.
// @facts      ⚠ Enoki has no auth provider / allowed origin registered yet, so
// @facts        useAphoticSession().status === 'unconfigured'. This screen needs
// @facts        NO session at all — verification is permissionless — but it must
// @facts        say so and surface the problems rather than hide them.
// @facts      FRESHNESS_THRESHOLD_MS = 300_000 — past that, <StaleBanner/> says
// @facts        the age out loud instead of dressing fixtures up as live data.
// @implements export function TransparencyScreen(): JSX.Element
// @forbidden  framing the limiter as a trusted SDK read — G5
// @forbidden  congestion / scarcity copy — the live bucket is ~100 BTC/day (E-A6)
// @forbidden  a canonical id literal in this file — G7, A10
// @invariant  1. <BridgeColumn/> shows SDK read and replay side by side.
// @invariant  2. <KeeperCapabilityBadge/> and <TrustModelDisclosure/> are present.
// @invariant  3. The strategy blob is never rendered as plaintext.
// @invariant  4. Zero network on mount in either mode; every call is click-driven.
// @ac         docs/APP.md §7 A7 A8 A9 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';

import { KeeperCapabilityBadge, StaleBanner, TrustModelDisclosure } from '../../components';
import {
  BridgeColumn,
  rederiveCongestion,
  type ReplayOutcome,
} from '../../components/BridgeColumn';
import { config, isMock, missingLiveConfig } from '../../config';
import { bridgeFixture, decisionFixtures, demoFixtures, strategyFixture } from '../../fixtures';
import { useAphoticSession } from '../../session/useSession';
import { DecisionLogViewer } from './DecisionLogViewer';
import { EncryptedStrategyPanel } from './EncryptedStrategyPanel';
import { LiveVaultPanel, useChainSnapshot } from './LiveVaultPanel';
import { describeBlobId } from './chainRead';
import { formatAge, hostOf } from './display';
import { describeVerifyFailure, equivalentCli } from './verifyClient';
import './transparency.css';

/** Past this, displayed figures are announced as stale rather than shown as fresh. */
const FRESHNESS_THRESHOLD_MS = 300_000;

function StripItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="tx-strip-item">
      <span className="tx-strip-k">{label}</span>
      <span className="tx-strip-v">{value}</span>
    </div>
  );
}

export function TransparencyScreen() {
  const [replay, setReplay] = useState<ReplayOutcome | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const session = useAphoticSession();
  const mock = isMock();
  const missing = missingLiveConfig();

  // One click, three public reads. Nothing fires on mount (invariant 4).
  const snapshot = useChainSnapshot();

  // The strategy panel shows the LIVE blob id and ciphertext size once the vault
  // has been read; before that it shows the pre-staged sample and says so.
  const strategy = useMemo(() => {
    if (snapshot.vault === null) return strategyFixture;
    const blob = describeBlobId(snapshot.vault.strategyBlobId);
    return {
      blobId: blob.display,
      versionEpoch: snapshot.vault.versionEpoch,
      ciphertextPreview: snapshot.vault.strategyCiphertextPreviewHex,
      sizeBytes: snapshot.vault.strategyCiphertextBytes,
    };
  }, [snapshot.vault]);

  // Stable per mount: the screen does not poll, so it must not pretend to.
  const renderedAtMs = useMemo(() => Date.now(), []);
  const newestRecordMs = useMemo(
    () => decisionFixtures.reduce((max, d) => (d.timestampMs > max ? d.timestampMs : max), 0),
    [],
  );
  const dataAgeMs = newestRecordMs === 0 ? 0 : renderedAtMs - newestRecordMs;
  const stale = newestRecordMs !== 0 && dataAgeMs > FRESHNESS_THRESHOLD_MS;

  const onReplay = () => {
    setReplaying(true);
    setReplayError(null);
    void rederiveCongestion(bridgeFixture)
      .then(
        (outcome) => {
          setReplay(outcome);
        },
        (err: unknown) => {
          setReplay(null);
          setReplayError(describeVerifyFailure(err));
        },
      )
      .finally(() => setReplaying(false));
  };

  return (
    <div className="ap-page tx-screen">
      <header>
        <p className="tx-eyebrow">Transparency</p>
        <h1 className="tx-title">Verify us. Don&rsquo;t trust us.</h1>
        <p className="tx-lede">
          The strategy stays sealed — that is the product. Everything else is open: every decision
          the keeper made, the inputs it read, and the bridge conditions it reacted to, all
          re-derivable from public data by someone who does not believe a word we say.
        </p>
      </header>

      <StaleBanner
        tripped={stale}
        reason="data-age"
        ageMs={dataAgeMs}
        thresholdMs={FRESHNESS_THRESHOLD_MS}
        subject={
          mock
            ? 'This screen is rendering pre-staged fixtures, and the newest record'
            : 'The newest decision record'
        }
      />

      <StaleBanner tripped={demoFixtures.breakerTripped} reason="divergence" />

      <div className="tx-strip">
        <StripItem
          label="Vault state"
          value={
            snapshot.vault !== null
              ? 'read from chain'
              : snapshot.vaultError !== null
                ? 'unreadable'
                : 'not read yet'
          }
        />
        <StripItem
          label="Decision log"
          value={`${decisionFixtures.length} pre-staged records`}
        />
        <StripItem
          label="Newest record"
          value={newestRecordMs === 0 ? '—' : `${formatAge(dataAgeMs)} old`}
        />
        <StripItem label="Verifier" value={hostOf(config.keeper.verifyUrl)} />
        <StripItem label="Walrus" value={hostOf(config.walrus.aggregatorUrl)} />
        <StripItem
          label="Vault object"
          value={config.aphotic.vaultId === '' ? 'not published' : 'published'}
        />
      </div>

      {/* The one panel on this page that is chain, not staging. */}
      <LiveVaultPanel snapshot={snapshot} />

      {missing.length > 0 ? (
        <div className="tx-callout tx-callout--warn">
          <strong style={{ color: 'var(--amber)' }}>Live reads are not wired yet.</strong> Missing
          config: <span className="tx-mono">{missing.join(', ')}</span>.{' '}
          {mock
            ? 'In mock mode that is expected — every panel below renders from deterministic fixtures and makes no requests until you press a button.'
            : 'In live mode nothing below can be trusted until these are filled.'}
        </div>
      ) : null}

      <div className="tx-callout">
        <strong>No live mid to read.</strong> The hBTC/DBUSDC order book is empty on both sides
        and the hosted DeepBook indexer does not even list the pool, so there is no mid to quote
        against yet. Every price in the log below is the one recorded at decision time, not a live
        quote — and NAV is always valued at the book mid, never at the raw oracle.
      </div>

      {session.status === 'unconfigured' ? (
        <div className="tx-callout tx-callout--warn">
          <strong style={{ color: 'var(--amber)' }}>zkLogin is not configured.</strong> Nothing on
          this screen needs it — verification is permissionless and there is no sign-in button
          here to be broken — but the deposit and exit screens do. Outstanding:
          <ul className="tx-list" style={{ marginTop: 'var(--space-2)' }}>
            {session.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="tx-columns">
        <div className="tx-col">
          <EncryptedStrategyPanel strategy={strategy} />
          <p className="tx-note">
            {snapshot.vault === null
              ? 'Pre-staged sample. Press “Read the vault from chain” above and this panel switches to the blob id, version epoch and ciphertext bytes actually held in the Vault object.'
              : 'Read from the Vault object above — blob id, version epoch and the first bytes of the ciphertext that is really on chain.'}
          </p>
        </div>

        <div className="tx-col">
          <DecisionLogViewer records={decisionFixtures} />
          <p className="tx-note">
            These records are <strong>pre-staged</strong>, not read from chain: the keeper has not
            traded, because the hBTC/DBUSDC book is empty on both sides and we can mint neither
            asset on testnet. The journal panel above shows the real, currently empty, on-chain
            ledger. We would rather label this than let it pass as live.
          </p>
        </div>

        <div className="tx-col tx-col--bridge">
          <BridgeColumn
            bridge={bridgeFixture}
            replay={replay}
            replaying={replaying}
            error={replayError}
            onReplay={onReplay}
          />
          <KeeperCapabilityBadge />
          <TrustModelDisclosure variant="expander" />
        </div>
      </div>

      <footer style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <p className="tx-section-k">Do it yourself</p>
        <p className="tx-note">
          Every button on this page wraps a command you can run against public data. The bridge
          replay is this one:
        </p>
        <div className="tx-cipher" style={{ color: 'var(--text-secondary)' }}>
          {equivalentCli()}
        </div>
        <p className="tx-note">
          It reads Hashi&rsquo;s own <code>WithdrawalRequested</code> /{' '}
          <code>PickedForProcessing</code> / <code>Signed</code> events from the chain, replays{' '}
          <code>project_capacity()</code> over them, and prints the same trajectory this page
          shows. If the two ever disagree, believe the chain.
        </p>
      </footer>
    </div>
  );
}

export default TransparencyScreen;
