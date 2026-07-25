// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4  (post-cut-line)
// @status     STUB
// @spec       docs/KEEPER.md §8 (one DecisionRecord per tick; publish on a LAG), §1.2 (run loop)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.2) · docs/MOVE-PACKAGE.md §9 (`journal::record`)
// @rules      G2 G5 G7 G8 G10
// @depends    ./schema.ts (T4.2) · ../storage/walrus.ts (T2.9) · ../config.ts · aphotic::journal (T4.2)
// @facts      ★ public fun aphotic::journal::record(vault: &Vault, keeper_cap: &KeeperCap,
// @facts          blob_id: vector<u8>, seq: u64, ctx: &mut TxContext)
// @facts        emits DecisionRecorded { vault_id, seq, blob_id }. KEEPER-GATED (KeeperCap) — this
// @facts        is one of the very few things the keeper key may sign, and it moves no funds (G2).
// @facts      ★ PUBLISH ON A LAG: cfg.loop.logPublishLagMs (default 60_000). A live decision log
// @facts        would let anyone front-run our resting maker orders. The lag is a design decision,
// @facts        not latency — say so in the pitch (docs/KEEPER.md §8).
// @facts      Blob ids are CONTENT-DERIVED and self-certifying; anchoring the id on-chain means the
// @facts        off-chain record cannot be substituted later (that is the whole point of §9).
// @facts      `seq` is monotonically increasing per vault and is asserted on-chain.
// @facts      Encrypt-before-upload applies to strategy material only: decision RECORDS are meant to
// @facts        be public (that is the transparency claim, G8). They must contain no plaintext
// @facts        parameters — only the strategy blob id + ruleset hash.
// @facts      One record per tick, appended to the current segment; the segment is flushed to
// @facts        Walrus and anchored when it fills or the lag window closes.
// @implements export interface JournalDeps / BuildRecordInput / AppendResult / PublishResult
// @implements export function buildRecord(input: BuildRecordInput): DecisionRecord
// @implements export function appendRecord(segment: DecisionSegment, record: DecisionRecord): DecisionSegment
// @implements export function isPublishDue(segment: DecisionSegment, nowMs: Millis, lagMs: Millis, maxRecords: number): boolean
// @implements export function buildAnchorTx(cfg: Config, blobId: string, seq: bigint): Transaction
// @implements export async function publishSegment(deps: JournalDeps, segment: DecisionSegment): Promise<PublishResult>
// @forbidden  publishing a segment before `logPublishLagMs` has elapsed (anti-front-run, §8)
// @forbidden  writing strategy parameters (plaintext) into a record (G8)
// @forbidden  emitting a bigint through JSON.stringify — ./schema.ts owns the canonical encoding
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @invariant  1. Exactly ONE record per tick, including `noop` ticks (a refusal is a decision).
// @invariant  2. `buildRecord`/`appendRecord` are PURE — `nowMs` arrives as an argument.
// @invariant  3. The anchoring PTB contains exactly one moveCall: `<aphotic>::journal::record`.
// @invariant  4. A publish failure never drops records — the segment is retried, not discarded.
// @ac         docs/KEEPER.md §13 A9 — one DecisionRecord per tick; blob id emitted on-chain
// @verify     npm run test -- journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type {
  Decision,
  DecisionRecord,
  Digest,
  L2Book,
  LimiterSample,
  Millis,
  OracleSnapshot,
  Plan,
  Sats,
} from '../types.js';

import type { DecisionSegment } from './schema.js';

export interface JournalDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** KEEPER_KEY — signs `journal::record` only. It moves no funds (G2). */
  readonly signer: Signer;
}

/** Everything one tick produced. Assembled by the run loop, never fetched here. */
export interface BuildRecordInput {
  readonly tickMs: Millis;
  readonly oracle: OracleSnapshot;
  readonly book: L2Book;
  /** ★ The TRUSTLESS replay sample (verify/limiter.ts), not an SDK hint (G5). */
  readonly limiter: LimiterSample;
  readonly pendingMintSats: Sats;
  readonly pendingBurnSats: Sats;
  /** Cursor into the `WithdrawalSigned` stream this limiter reading was derived from. */
  readonly signedCursorSeq: bigint;
  /** Blob id of the strategy VERSION in force — not the current one. */
  readonly strategyBlobId: string;
  /** Content hash of the compiled decision function. */
  readonly ruleset: string;
  readonly decision: Decision;
  readonly plan: Plan;
  readonly result: { readonly digest: Digest } | { readonly skipped: string };
}

export interface PublishResult {
  readonly blobId: string;
  readonly seq: bigint;
  /** Digest of the on-chain anchor tx. */
  readonly anchorDigest: Digest;
}

/** Assemble the per-tick record. PURE. */
// TODO(T4.2): map BuildRecordInput onto DecisionRecord; run schema.assertReplayable before returning.
export function buildRecord(_input: BuildRecordInput): DecisionRecord {
  throw new Error('TODO(T4.2): buildRecord not implemented');
}

/** Append to the open segment, widening its `toMs`. PURE — returns a NEW segment. */
// TODO(T4.2): push the record, update meta.fromMs/toMs, keep records tick-ordered.
export function appendRecord(
  _segment: DecisionSegment,
  _record: DecisionRecord,
): DecisionSegment {
  throw new Error('TODO(T4.2): appendRecord not implemented');
}

/** Flush gate: the lag window has closed, or the segment is full. PURE. */
// TODO(T4.2): nowMs - segment.meta.toMs >= lagMs || segment.records.length >= maxRecords.
export function isPublishDue(
  _segment: DecisionSegment,
  _nowMs: Millis,
  _lagMs: Millis,
  _maxRecords: number,
): boolean {
  throw new Error('TODO(T4.2): isPublishDue not implemented');
}

/** The on-chain anchor: exactly one moveCall into `aphotic::journal::record`. */
// TODO(T4.2): tx.moveCall({ target: `${cfg.aphotic.packageId}::journal::record`,
//             arguments: [vault, keeperCap, pure vector<u8> blobId, pure u64 seq] }).
export function buildAnchorTx(_cfg: Config, _blobId: string, _seq: bigint): Transaction {
  throw new Error('TODO(T4.2): buildAnchorTx not implemented');
}

/**
 * Encode → Walrus put (explicit epochs) → anchor the blob id on-chain.
 * Respects the publish lag; never drops records on failure (invariant 4).
 */
// TODO(T4.2): schema.encodeSegment → storage.put(cfg, bytes, { epochs: cfg.walrus.epochs })
//             → buildAnchorTx → sign + execute → PublishResult.
export async function publishSegment(
  _deps: JournalDeps,
  _segment: DecisionSegment,
): Promise<PublishResult> {
  throw new Error('TODO(T4.2): publishSegment not implemented');
}
