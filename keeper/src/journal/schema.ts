// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4  (post-cut-line)
// @status     STUB
// @spec       docs/KEEPER.md §8 (DecisionRecord schema table), §9.1 (verify/ replays THESE records)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.2) · docs/MOVE-PACKAGE.md §9 (`journal::record`)
// @rules      G5 G7 G8 G10
// @depends    ../types.ts (DecisionRecord/Decision/Plan/L2Book/OracleSnapshot/LimiterSample)
// @facts      ★ THE RECORD IS THE PRODUCT. `verify/` re-runs `evaluate`/`route` against the RECORDED
// @facts        inputs, so anything not in the record cannot be replayed — and any non-determinism
// @facts        in the encoding shows up as a false mismatch.
// @facts      Fields (docs/KEEPER.md §8): oracle · book · hashi{limiter, queue depths, pendingMint,
// @facts        pendingBurn, WithdrawalSigned cursor} · strategy_blob · ruleset · decision · plan · result.
// @facts      ⚠ `JSON.stringify` THROWS on bigint. Every satoshi/price field must be encoded as a
// @facts        DECIMAL STRING and parsed back with `BigInt(...)` — never Number(), never parseInt.
// @facts        This is the same rule the Sui event envelope forces on us (docs/FACTS.md#events).
// @facts      ⚠ Encoding must be CANONICAL: sorted keys, no incidental whitespace, so the segment
// @facts        hash is stable across machines and re-runs (self-certifying blob ids, G5).
// @facts      `strategyBlobId` is the blob id of the strategy VERSION IN FORCE at that tick, not
// @facts        the current one — that is what makes historical replay meaningful.
// @facts      `ruleset` is the content hash of the compiled decision function (strategy/evaluate.ts
// @facts        `rulesetHash`), so a verifier knows WHICH rules ran without seeing the parameters (G8).
// @facts      Blob ids are content-derived; the on-chain `journal::record(vault, keeper_cap, blob_id,
// @facts        seq, ctx)` anchors the pointer so it cannot be substituted afterwards.
// @implements export const JOURNAL_SCHEMA_VERSION: 1
// @implements export interface DecisionSegment / SegmentMeta
// @implements export function encodeSegment(segment: DecisionSegment): Uint8Array
// @implements export function decodeSegment(bytes: Uint8Array): DecisionSegment
// @implements export function segmentHash(segment: DecisionSegment): string
// @implements export function assertReplayable(record: DecisionRecord): void
// @forbidden  emitting a bigint through JSON.stringify — encode decimal strings
// @forbidden  Number()/parseInt on a decoded numeric string — precision loss on u64
// @forbidden  putting strategy PARAMETERS (plaintext) in a record — only the blob id + ruleset hash (G8)
// @invariant  1. decodeSegment(encodeSegment(s)) deep-equals s, bigints included.
// @invariant  2. Encoding is canonical: same segment ⇒ byte-identical output on any machine.
// @invariant  3. `seq` is monotonically increasing per vault (matches the on-chain assertion).
// @invariant  4. Every record carries enough input to re-run evaluate/route with no extra fetch.
// @ac         docs/BUILD-PLAN.md T4.2 — records include the hashi fields; blob ids emitted on-chain
// @verify     npm run test -- journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { DecisionRecord, Digest, Millis, ObjectId } from '../types.js';

/** Bump on ANY layout change — `decodeSegment` refuses an unknown version. */
export const JOURNAL_SCHEMA_VERSION = 1 as const;

export interface SegmentMeta {
  readonly schemaVersion: number;
  readonly vaultId: ObjectId;
  /** Monotonic segment sequence — mirrors the `seq` asserted by `journal::record`. */
  readonly seq: bigint;
  /** Tick time of the first and last record in the segment. */
  readonly fromMs: Millis;
  readonly toMs: Millis;
  /** Content hash of the strategy VERSION in force across this segment. */
  readonly strategyBlobId: string;
  /** Content hash of the compiled decision function (strategy/evaluate.ts). */
  readonly ruleset: string;
}

/** One Walrus blob: a batch of per-tick decision records plus their metadata. */
export interface DecisionSegment {
  readonly meta: SegmentMeta;
  readonly records: readonly DecisionRecord[];
  /** Digest of the on-chain `journal::record` anchoring this segment, once published. */
  readonly anchorDigest?: Digest;
}

/** Canonical, deterministic encoding. bigints become decimal strings; keys are sorted. */
// TODO(T4.2): canonical JSON (sorted keys, bigint → decimal string) → UTF-8 bytes.
export function encodeSegment(_segment: DecisionSegment): Uint8Array {
  throw new Error('TODO(T4.2): encodeSegment not implemented');
}

/** Inverse of {@link encodeSegment}. Rejects an unknown `schemaVersion`. */
// TODO(T4.2): UTF-8 → JSON → revive every numeric string with BigInt(); assert schemaVersion.
export function decodeSegment(_bytes: Uint8Array): DecisionSegment {
  throw new Error('TODO(T4.2): decodeSegment not implemented');
}

/** Stable hash of the canonical encoding — the local twin of the Walrus content-derived id. */
// TODO(T4.2): sha256(encodeSegment(segment)) hex.
export function segmentHash(_segment: DecisionSegment): string {
  throw new Error('TODO(T4.2): segmentHash not implemented');
}

/**
 * Guard: a record must carry EVERY input `evaluate`/`route` consumed, or `verify/` will report a
 * mismatch that is really a logging bug. Fail loudly at write time instead.
 */
// TODO(T4.2): assert oracle/book/hashi/decision/plan present, jitterSeed non-empty, cursor set.
export function assertReplayable(_record: DecisionRecord): void {
  throw new Error('TODO(T4.2): assertReplayable not implemented');
}
