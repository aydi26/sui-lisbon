// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.1 (<EncryptedStrategyBlob/>), §4.3 (Walrus GET)
// @spec       docs/ULTRACODE-BRIEF.md E-K12 (Walrus read path + the certified-epoch trap)
// @rules      G7 G8
// @depends    ../../config.ts (T0.4)
// @facts      Read path: GET {aggregator}/v1/blobs/{blobId}. Write path (keeper
// @facts        only): PUT {publisher}/v1/blobs?epochs=N with N explicit.
// @facts      VITE_WALRUS_AGGREGATOR default = https://aggregator.walrus-testnet
// @facts        .walrus.space (resolved by DAY-ONE D8; it may be '' if overridden
// @facts        to empty — degrade, never crash).
// @facts      ⚠ A freshly published blob reads back certifiedEpoch: null and
// @facts        deletable: true. An availability predicate that demands certified
// @facts        + non-deletable REJECTS OUR OWN WRITES. Availability here means
// @facts        "the aggregator serves the bytes", nothing stronger.
// @facts      ⚠ In DEMO_MODE=mock the blob ids are SYNTHETIC (fixtures/synthetic.ts)
// @facts        and no probe is issued at all — the screen must make zero network
// @facts        calls in mock mode (A11).
// @implements export type BlobAvailability
//             export async function probeBlob(blobId, signal?): Promise<BlobAvailability>
//             export function blobUrl(blobId: string): string
// @forbidden  probing on mount — the check is user-initiated only (G6/A11)
// @forbidden  hardcoding an aggregator URL — it comes from config (G7)
// @invariant  1. Never throws; every outcome is a value the UI can render.
// @ac         docs/APP.md §7 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';

const PROBE_TIMEOUT_MS = 5_000;

export type BlobAvailabilityState =
  | 'unchecked'
  | 'checking'
  | 'available'
  | 'not-found'
  | 'unreachable'
  | 'unconfigured'
  | 'fixture';

export interface BlobAvailability {
  readonly state: BlobAvailabilityState;
  readonly detail: string;
}

export function blobUrl(blobId: string): string {
  const base = config.walrus.aggregatorUrl.replace(/\/+$/, '');
  return `${base}/v1/blobs/${blobId}`;
}

/**
 * Ask the configured Walrus aggregator whether it currently serves this blob.
 * "Available" means the aggregator returned the bytes — deliberately weaker than
 * "certified and non-deletable", which would reject a freshly published blob.
 */
export async function probeBlob(blobId: string, signal?: AbortSignal): Promise<BlobAvailability> {
  if (config.walrus.aggregatorUrl === '') {
    return {
      state: 'unconfigured',
      detail: 'VITE_WALRUS_AGGREGATOR is empty — nothing to ask.',
    };
  }

  const url = blobUrl(blobId);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  if (signal !== undefined) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (res.status === 404) {
      return { state: 'not-found', detail: `${url} → HTTP 404` };
    }
    if (!res.ok) {
      return { state: 'unreachable', detail: `${url} → HTTP ${res.status}` };
    }
    const bytes = (await res.arrayBuffer()).byteLength;
    return { state: 'available', detail: `${url} → ${bytes} bytes served` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { state: 'unreachable', detail: `${url} → ${detail}` };
  } finally {
    window.clearTimeout(timer);
  }
}
