// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.1 (<EncryptedStrategyBlob/>), §4.4 (strategy state)
// @spec       docs/MOVE-PACKAGE.md#vault (seal_approve gate + version epoch)
// @spec       docs/KEEPER.md §9.1 (two-tier verification honesty)
// @rules      G7 G8
// @depends    ./display.ts ./walrus.ts ./transparency.css (T5.2)
//             ../../components/AddressPill.tsx (T0.4) · ../../fixtures (T0.4)
// @facts      The blob shown is CIPHERTEXT. Seal-gated by
// @facts        aphotic::vault::seal_approve; the identity is namespaced to the
// @facts        VAULT OBJECT ID + a VERSION EPOCH. rotate_keeper increments the
// @facts        epoch, which invalidates every previously derived key share.
// @facts      Walrus blobs are PUBLIC and content-addressed ⇒ encrypt BEFORE
// @facts        upload, always. Publishing the blob id is safe; publishing the
// @facts        parameters would be the whole game.
// @facts      Seal threshold is 2 key servers (E-K12). @mysten/seal 1.3.4 no
// @facts        longer exports getAllowlistedKeyServers — server configs are
// @facts        passed explicitly by the keeper. The app never decrypts.
// @facts      ⚠ VITE_VAULT_ID is EMPTY until the package is published (DAY-ONE),
// @facts        so the identity namespace must render an honest placeholder.
// @implements export function EncryptedStrategyPanel(props): JSX.Element
// @forbidden  rendering any plaintext strategy parameter — that is the point
// @forbidden  a canonical id literal here — values arrive from config/fixtures (G7)
// @forbidden  a network call on mount — the availability probe is click-driven
// @invariant  1. Only ciphertext, blob id, size and epoch are shown.
// @invariant  2. The copy states that rotating the keeper revokes old key shares.
// @invariant  3. Mock mode issues zero requests (A11).
// @ac         docs/APP.md §7 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';

import { AddressPill } from '../../components/AddressPill';
import { config, isMock } from '../../config';
import type { StrategyBlobFixture } from '../../fixtures';
import { hostOf } from './display';
import { probeBlob, type BlobAvailability } from './walrus';

const CHIP_CLASS: Record<BlobAvailability['state'], string> = {
  unchecked: 'tx-chip',
  checking: 'tx-chip',
  available: 'tx-chip tx-chip--ok',
  'not-found': 'tx-chip tx-chip--warn',
  unreachable: 'tx-chip tx-chip--err',
  unconfigured: 'tx-chip tx-chip--warn',
  fixture: 'tx-chip tx-chip--warn',
};

const CHIP_LABEL: Record<BlobAvailability['state'], string> = {
  unchecked: 'not checked',
  checking: 'checking…',
  available: 'served by aggregator',
  'not-found': 'not on the aggregator',
  unreachable: 'aggregator unreachable',
  unconfigured: 'aggregator not configured',
  fixture: 'fixture blob — not fetched',
};

export interface EncryptedStrategyPanelProps {
  strategy: StrategyBlobFixture;
}

export function EncryptedStrategyPanel({ strategy }: EncryptedStrategyPanelProps) {
  const mock = isMock();
  const [availability, setAvailability] = useState<BlobAvailability>(
    mock
      ? {
          state: 'fixture',
          detail:
            'Deterministic fixture blob id. This screen makes zero network calls in mock mode.',
        }
      : { state: 'unchecked', detail: `Ask ${hostOf(config.walrus.aggregatorUrl)} for the bytes.` },
  );

  const check = () => {
    setAvailability({ state: 'checking', detail: 'GET /v1/blobs/…' });
    void probeBlob(strategy.blobId).then(setAvailability);
  };

  const vaultId = config.aphotic.vaultId;

  return (
    <section className="tx-panel" aria-label="Encrypted strategy">
      <div className="tx-panel-head">
        <span className="tx-eyebrow">Strategy · sealed</span>
        <h2 className="tx-panel-title">What runs the vault stays encrypted</h2>
        <p className="tx-panel-sub">
          The parameters live on Walrus as ciphertext. A Move function decides who may ever
          decrypt them — not a server, not us.
        </p>
      </div>

      <AddressPill label="Walrus blob id (in force)" value={strategy.blobId} />

      <div>
        <p className="tx-section-k">Ciphertext, first bytes</p>
        <div className="tx-cipher">{strategy.ciphertextPreview}…</div>
        <p className="tx-note" style={{ marginTop: 'var(--space-2)' }}>
          {strategy.sizeBytes.toLocaleString('en-US')} bytes total. This is everything the public
          sees of the strategy, and it is everything the keeper&rsquo;s host machine ever holds at
          rest.
        </p>
      </div>

      <hr className="tx-rule" />

      <dl className="tx-kv">
        <dt>Gate</dt>
        <dd>
          <code>aphotic::vault::seal_approve</code>
        </dd>

        <dt>Identity</dt>
        <dd className="tx-mono">
          {vaultId === '' ? (
            <span className="tx-dim">
              &lt;vault id&gt; ‖ epoch {strategy.versionEpoch} — VITE_VAULT_ID is empty until the
              package is published
            </span>
          ) : (
            `${vaultId} ‖ epoch ${strategy.versionEpoch}`
          )}
        </dd>

        <dt>Epoch</dt>
        <dd>
          v{strategy.versionEpoch} — rotating the keeper increments this and invalidates every key
          share derived under the old epoch.
        </dd>

        <dt>Key servers</dt>
        <dd>Threshold 2. The app never holds a share and never decrypts.</dd>

        <dt>Availability</dt>
        <dd>
          <div className="tx-chiprow">
            <span className={CHIP_CLASS[availability.state]}>{CHIP_LABEL[availability.state]}</span>
            {mock ? null : (
              <button
                type="button"
                className="tx-btn"
                onClick={check}
                disabled={availability.state === 'checking'}
              >
                Check the aggregator
              </button>
            )}
          </div>
          <p className="tx-note" style={{ marginTop: 'var(--space-2)' }}>
            {availability.detail}
          </p>
        </dd>
      </dl>

      <hr className="tx-rule" />

      <div>
        <p className="tx-section-k">Sealed from everyone, including you</p>
        <ul className="tx-list tx-list--sealed">
          <li>Half-spread, size ladder and skew.</li>
          <li>The inventory and buffer thresholds that trigger a widen.</li>
          <li>The peg-flow weighting applied to bridge conditions.</li>
        </ul>
      </div>

      <div>
        <p className="tx-section-k">Checkable by anyone, with no keys</p>
        <ul className="tx-list tx-list--open">
          <li>
            Every decision names the strategy blob and a ruleset hash, so you can prove one
            ciphertext produced the whole log.
          </li>
          <li>
            Given a record&rsquo;s own book snapshot, the routing it produced is re-computable —
            that tier needs no plaintext.
          </li>
          <li>
            The bridge inputs it reacted to are re-derivable from Hashi&rsquo;s events, which is
            the panel on the right.
          </li>
        </ul>
        <p className="tx-note" style={{ marginTop: 'var(--space-3)' }}>
          Checking that a <em>trigger</em> fired correctly does need the plaintext. That is an
          owner action, or a Seal disclosure scoped to one historical version epoch — never a
          blanket key.
        </p>
      </div>
    </section>
  );
}

export default EncryptedStrategyPanel;
