// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §4.1 (<EncryptedStrategyBlob/>, <DecisionLogViewer/>)
// @spec       docs/KEEPER.md#journal (decision record fields incl. `hashi`)
// @rules      G5 G8 G9
// @depends    ./types.ts · ./synthetic.ts
// @facts      NAV/collateral is valued at the DeepBook MID, never at raw Pyth —
// @facts        hBTC depeg defence (G9). Pyth is the divergence breaker input.
// @facts      Walrus blob ids are content-derived and self-certifying; blobs are
// @facts        PUBLIC — the strategy is encrypted BEFORE upload, always.
// @facts      Seal identity is namespaced to the vault object + a version epoch;
// @facts        rotate_keeper increments the epoch and invalidates old shares.
// @facts      The decision log is published on a LAG (front-run defence).
// @implements export const strategyFixture: StrategyBlobFixture
//             export const decisionFixtures: readonly DecisionRecord[]
// @forbidden  a fixture that reveals plaintext strategy parameters — the blob is
//             ciphertext by construction
// @invariant  1. Every decision record carries the four `hashi` fields.
// @invariant  2. bookMidUsd8 (not oracleUsd8) is what NAV is derived from (G9).
// @ac         docs/APP.md §7 A7 A9
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { synthDigest, synthHex, synthId } from './synthetic';
import type { DecisionRecord, StrategyBlobFixture } from './types';

export const strategyFixture: StrategyBlobFixture = {
  blobId: synthDigest('strategy-blob-v3'),
  versionEpoch: 3,
  ciphertextPreview: synthHex(0x9c, 24),
  sizeBytes: 4096,
};

const USD8 = 100_000_000n;

export const decisionFixtures: readonly DecisionRecord[] = [
  {
    seq: 41,
    timestampMs: 1_753_400_000_000,
    oracleUsd8: 118_400n * USD8,
    bookMidUsd8: 118_260n * USD8,
    l2SnapshotRef: synthDigest('l2-41'),
    strategyBlobId: strategyFixture.blobId,
    rulesetHash: synthId(0x11),
    decision: 'QUOTE maker POST_ONLY both sides, 18 bps half-spread',
    resultDigest: synthDigest('result-41'),
    hashi: {
      limiterCapacitySats: 1_820_000n,
      queueDepth: 2,
      pendingMintSats: 415_000n,
      redemptionBufferSats: 900_000n,
    },
  },
  {
    // The "we de-risked because the bridge was tightening" trace (G5).
    seq: 42,
    timestampMs: 1_753_400_600_000,
    oracleUsd8: 118_050n * USD8,
    bookMidUsd8: 117_640n * USD8,
    l2SnapshotRef: synthDigest('l2-42'),
    strategyBlobId: strategyFixture.blobId,
    rulesetHash: synthId(0x11),
    decision:
      'WIDEN to 46 bps + raise redemption buffer: re-derived limiter capacity fell below the pending-exit envelope',
    resultDigest: synthDigest('result-42'),
    hashi: {
      limiterCapacitySats: 105_000n,
      queueDepth: 1,
      pendingMintSats: 60_000n,
      redemptionBufferSats: 1_400_000n,
    },
  },
  {
    seq: 43,
    timestampMs: 1_753_401_200_000,
    oracleUsd8: 118_120n * USD8,
    bookMidUsd8: 117_980n * USD8,
    l2SnapshotRef: synthDigest('l2-43'),
    strategyBlobId: strategyFixture.blobId,
    rulesetHash: synthId(0x11),
    decision: 'HOLD — Pyth/DeepBook TWAP divergence inside threshold',
    resultDigest: synthDigest('result-43'),
    hashi: {
      limiterCapacitySats: 260_000n,
      queueDepth: 1,
      pendingMintSats: 60_000n,
      redemptionBufferSats: 1_250_000n,
    },
  },
];
