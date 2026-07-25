// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4  (post-cut-line)
// @status     DONE
// @spec       docs/KEEPER.md §8 (one DecisionRecord per tick; publish on a LAG), §1.2 (run loop)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.2) · docs/MOVE-PACKAGE.md §9 (`journal::record`)
// @rules      G2 G5 G7 G8 G10
// @depends    ./schema.ts (T4.2) · ../storage/walrus.ts (T2.9) · ../config.ts · aphotic::journal (T4.2)
// @facts      ★ public fun aphotic::journal::record<B, Q>(vault: &Vault<B, Q>,
// @facts          cursor: &mut JournalCursor, keeper_cap: &KeeperCap,
// @facts          blob_id: vector<u8>, seq: u64, ctx: &mut TxContext)
// @facts        emits DecisionRecorded { vault_id, seq, blob_id }. KEEPER-GATED (KeeperCap) — this
// @facts        is one of the very few things the keeper key may sign, and it moves no funds (G2).
// @facts        ⚠ DELTA vs the original stub banner: `record` is GENERIC over the vault's asset
// @facts        pair and takes a `&mut JournalCursor` (move/sources/journal.move holds the
// @facts        per-vault `last_seq`; a leaf module cannot hang state on the Vault's UID). The PTB
// @facts        therefore passes THREE objects, and the type arguments are <hBTC, DBUSDC>.
// @facts      ★ GENESIS SEQ = 1. `assert_monotonic_seq` is strict (`>`) against a fresh cursor's
// @facts        `last_seq = 0`, so segment numbering is 1-based and seq 0 can never be anchored.
// @facts      ★ PUBLISH ON A LAG: cfg.loop.logPublishLagMs (default 60_000). A live decision log
// @facts        would let anyone front-run our resting maker orders. The lag is a design decision,
// @facts        not latency — say so in the pitch (docs/KEEPER.md §8).
// @facts      Blob ids are CONTENT-DERIVED and self-certifying; anchoring the id on-chain means the
// @facts        off-chain record cannot be substituted later (that is the whole point of §9).
// @facts      A Walrus blob id is a 32-byte value rendered in URL-SAFE BASE64 (43 chars), e.g.
// @facts        `GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM` (DAY-ONE-RESULTS §D8). `journal.move`
// @facts        takes it as OPAQUE `vector<u8>` and never parses it, so the wire form is a choice.
// @facts        WE ANCHOR THE UTF-8 BYTES OF THE CANONICAL ID STRING (43 bytes), not the 32 decoded
// @facts        bytes: it round-trips through the Sui event envelope with no re-encoding step, and
// @facts        it is the form `keeper/src/verify/` reads back (`TextDecoder` over `blob_id`).
// @facts        Changing it would silently orphan every previously anchored pointer.
// @facts      BLOB_ID_CHARSET = /^[A-Za-z0-9_-]+$/  (url-safe base64, no padding)
// @facts      Encrypt-before-upload applies to strategy material only: decision RECORDS are meant to
// @facts        be public (that is the transparency claim, G8). They must contain no plaintext
// @facts        parameters — only the strategy blob id + ruleset hash. Hence `payload: 'decision-log'`.
// @facts      One record per tick, appended to the current segment; the segment is flushed to
// @facts        Walrus and anchored when it fills or the lag window closes.
// @implements export interface JournalDeps / BuildRecordInput / AnchorObjectRefs / PublishResult
// @implements export function openSegment(input: OpenSegmentInput): DecisionSegment
// @implements export function buildRecord(input: BuildRecordInput): DecisionRecord
// @implements export function appendRecord(segment: DecisionSegment, record: DecisionRecord): DecisionSegment
// @implements export function markAnchored(segment: DecisionSegment, anchorDigest: Digest): DecisionSegment
// @implements export function isPublishDue(segment: DecisionSegment, nowMs: Millis, lagMs: Millis, maxRecords: number): boolean
// @implements export function blobIdToBytes(blobId: string): Uint8Array
// @implements export function bytesToBlobId(bytes: Uint8Array): string
// @implements export function buildAnchorTx(cfg: Config, blobId: string, seq: bigint, refs: AnchorObjectRefs): Transaction
// @implements export async function publishSegment(deps: JournalDeps, segment: DecisionSegment, nowMs?: Millis): Promise<PublishResult>
// @forbidden  publishing a segment before `logPublishLagMs` has elapsed (anti-front-run, §8)
// @forbidden  writing strategy parameters (plaintext) into a record (G8)
// @forbidden  emitting a bigint through JSON.stringify — ./schema.ts owns the canonical encoding
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @invariant  1. Exactly ONE record per tick, including `noop` ticks (a refusal is a decision).
// @invariant  2. `buildRecord`/`appendRecord`/`isPublishDue` are PURE — `nowMs` arrives as an argument.
// @invariant  3. The anchoring PTB contains exactly one moveCall: `<aphotic>::journal::record`,
//                and none of its arguments is a Bitcoin address (G2).
// @invariant  4. A publish failure never drops records: every function here is non-mutating, so a
//                throwing `publishSegment` leaves the caller's segment intact for a later retry.
// @ac         docs/KEEPER.md §13 A9 — one DecisionRecord per tick; blob id emitted on-chain
// @verify     npm run test -- journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import { put, type FetchLike, type PutResult } from '../storage/walrus.js';
import type {
  Decision,
  DecisionRecord,
  Digest,
  L2Book,
  LimiterSample,
  Millis,
  ObjectId,
  OracleSnapshot,
  Plan,
  Sats,
} from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import {
  JOURNAL_SCHEMA_VERSION,
  assertReplayable,
  encodeSegment,
  type DecisionSegment,
} from './schema.js';

/** Walrus blob ids are url-safe base64, unpadded (DAY-ONE-RESULTS §D8). */
export const BLOB_ID_CHARSET = /^[A-Za-z0-9_-]+$/;

// ── deps / inputs ────────────────────────────────────────────────────────────

/** The three on-chain objects `aphotic::journal::record` consumes. None of them holds funds. */
export interface AnchorObjectRefs {
  /** Shared `Vault<B, Q>`. Defaults to `cfg.aphotic.vaultId` when omitted. */
  readonly vaultId?: ObjectId;
  /** Shared `JournalCursor` owning this vault's `last_seq`. */
  readonly journalCursorId: ObjectId;
  /** The keeper's `KeeperCap`. It gates the log; it moves nothing (G2). */
  readonly keeperCapId: ObjectId;
}

export interface JournalDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** KEEPER_KEY — signs `journal::record` only. It moves no funds (G2). */
  readonly signer: Signer;
  readonly refs: AnchorObjectRefs;
  /** Injected Walrus transport (tests pass an in-memory one; production omits it). */
  readonly fetch?: FetchLike;
  /** Walrus publisher endpoints override, in order. */
  readonly publishers?: readonly string[];
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

export interface OpenSegmentInput {
  readonly vaultId: ObjectId;
  /** 1-based; the on-chain cursor starts at 0 and asserts a strict increase. */
  readonly seq: bigint;
  readonly strategyBlobId: string;
  readonly ruleset: string;
}

export interface PublishResult {
  readonly blobId: string;
  readonly seq: bigint;
  /** Digest of the on-chain anchor tx. */
  readonly anchorDigest: Digest;
  /** The Walrus write receipt — the renewal task needs its lifetime window. */
  readonly receipt: PutResult;
}

// ── errors ───────────────────────────────────────────────────────────────────

/** The anti-front-run gate (§8): the lag window has not closed yet. */
export class PublishTooEarlyError extends AphoticError {
  constructor(dueInMs: number, lagMs: number) {
    super(
      'PublishTooEarly',
      `decision log is published on a ${lagMs}ms lag so a live log cannot front-run our resting ` +
        `maker orders — ${dueInMs}ms still to go`,
    );
  }
}

/** The on-chain anchor transaction failed; the segment is NOT anchored (invariant 4: retry it). */
export class AnchorFailedError extends AphoticError {
  constructor(blobId: string, detail: string) {
    super('AnchorFailed', `journal::record failed to anchor blob ${blobId}: ${detail}`);
  }
}

// ── pure segment algebra (invariant 2) ───────────────────────────────────────

/** A fresh, empty segment. `fromMs`/`toMs` are set by the first `appendRecord`. */
export function openSegment(input: OpenSegmentInput): DecisionSegment {
  return {
    meta: {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      vaultId: input.vaultId,
      seq: input.seq,
      fromMs: 0,
      toMs: 0,
      strategyBlobId: input.strategyBlobId,
      ruleset: input.ruleset,
    },
    records: [],
  };
}

/**
 * Assemble the per-tick record. PURE.
 *
 * Every field `evaluate`/`route` consumed goes in — including the bridge block, which is what
 * makes the limiter reading replayable (G5) rather than a claim.
 */
export function buildRecord(input: BuildRecordInput): DecisionRecord {
  const record: DecisionRecord = {
    tickMs: input.tickMs,
    oracle: input.oracle,
    book: input.book,
    hashi: {
      limiter: input.limiter,
      pendingMintSats: input.pendingMintSats,
      pendingBurnSats: input.pendingBurnSats,
      signedCursorSeq: input.signedCursorSeq,
    },
    strategyBlobId: input.strategyBlobId,
    ruleset: input.ruleset,
    decision: input.decision,
    plan: input.plan,
    result: input.result,
  };
  // Fail at WRITE time, not at replay time, where it would look like a strategy mismatch.
  assertReplayable(record);
  return record;
}

/** Append to the open segment, widening its `[fromMs, toMs]`. PURE — returns a NEW segment. */
export function appendRecord(segment: DecisionSegment, record: DecisionRecord): DecisionSegment {
  assertReplayable(record);

  const last = segment.records.at(-1);
  if (last !== undefined && record.tickMs < last.tickMs) {
    throw new AphoticError(
      'JournalOutOfOrder',
      `tick ${record.tickMs} precedes the segment's last tick ${last.tickMs}; the decision log is ` +
        `the replay ordering verify/ depends on (G5)`,
    );
  }

  const isFirst = segment.records.length === 0;
  return {
    ...segment,
    meta: {
      ...segment.meta,
      fromMs: isFirst ? record.tickMs : segment.meta.fromMs,
      toMs: isFirst ? record.tickMs : Math.max(segment.meta.toMs, record.tickMs),
    },
    records: [...segment.records, record],
  };
}

/** Attach the on-chain anchor digest. PURE — returns a NEW segment. */
export function markAnchored(segment: DecisionSegment, anchorDigest: Digest): DecisionSegment {
  return { ...segment, anchorDigest };
}

/** Flush gate: the lag window has closed, or the segment is full. PURE. An empty segment is never due. */
export function isPublishDue(
  segment: DecisionSegment,
  nowMs: Millis,
  lagMs: Millis,
  maxRecords: number,
): boolean {
  if (segment.records.length === 0) return false;
  if (segment.records.length >= maxRecords) return true;
  return nowMs - segment.meta.toMs >= lagMs;
}

// ── blob id ↔ bytes ──────────────────────────────────────────────────────────

/**
 * The opaque `vector<u8>` `journal::record` anchors: the UTF-8 bytes of the canonical blob-id
 * string. See the @facts note — `verify/` reads it back with `TextDecoder`, so this encoding is
 * part of the on-chain contract, not an implementation detail.
 */
export function blobIdToBytes(blobId: string): Uint8Array {
  if (!BLOB_ID_CHARSET.test(blobId)) {
    throw new AphoticError(
      'InvalidBlobId',
      `not a Walrus blob id (url-safe base64, unpadded): ${JSON.stringify(blobId)}`,
    );
  }
  return new TextEncoder().encode(blobId);
}

/** Inverse of {@link blobIdToBytes}. */
export function bytesToBlobId(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ── the anchoring PTB (invariant 3) ──────────────────────────────────────────

/**
 * The on-chain anchor: EXACTLY one moveCall into `aphotic::journal::record`.
 *
 * It carries a blob id and a sequence number. No coin, no balance, no capability transfer — this
 * is the one thing the keeper key signs that a compromised keeper could not turn into a theft (G2).
 */
export function buildAnchorTx(
  cfg: Config,
  blobId: string,
  seq: bigint,
  refs: AnchorObjectRefs,
): Transaction {
  const packageId = requireId(cfg.aphotic.packageId, 'APHOTIC_PACKAGE_ID');
  const vaultId = requireId(refs.vaultId ?? cfg.aphotic.vaultId, 'VAULT_ID');
  const cursorId = requireId(refs.journalCursorId, 'JOURNAL_CURSOR_ID');
  const keeperCapId = requireId(refs.keeperCapId, 'KEEPER_CAP_ID');
  if (seq < 1n) {
    throw new ConfigError(`journal seq must be >= 1 (the on-chain cursor asserts a strict increase) — got ${seq}`, []);
  }

  const tx = new Transaction();
  if (cfg.sui.keeperAddress !== '') tx.setSender(cfg.sui.keeperAddress);
  tx.moveCall({
    target: `${packageId}::journal::record`,
    // Vault<B, Q> is generic over the pair; only the type ARGUMENTS name hBTC (G7 keeps the
    // bridge type out of vault.move itself).
    typeArguments: [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType],
    arguments: [
      tx.object(vaultId),
      tx.object(cursorId),
      tx.object(keeperCapId),
      tx.pure.vector('u8', Array.from(blobIdToBytes(blobId))),
      tx.pure.u64(seq),
    ],
  });
  return tx;
}

// ── publish ──────────────────────────────────────────────────────────────────

/** Structural view of the one client method used here — both Sui clients expose `core` (RECON R1). */
interface AnchorExecutor {
  readonly core: {
    signAndExecuteTransaction(input: {
      transaction: Transaction;
      signer: Signer;
    }): Promise<{ $kind: string; Transaction?: { digest: string } | undefined }>;
  };
}

/**
 * Encode → Walrus put (explicit epochs) → anchor the blob id on-chain.
 *
 * Pass `nowMs` to enforce the anti-front-run publish lag; omit it only when the caller has already
 * gated on {@link isPublishDue}. Nothing here mutates `segment`, so a failure at any step leaves
 * the caller free to retry with the identical bytes — and, because blob ids are content-derived,
 * a retried upload yields the identical id (invariant 4).
 */
export async function publishSegment(
  deps: JournalDeps,
  segment: DecisionSegment,
  nowMs?: Millis,
): Promise<PublishResult> {
  const { cfg } = deps;

  if (nowMs !== undefined) {
    const lagMs = cfg.loop.logPublishLagMs;
    const elapsed = nowMs - segment.meta.toMs;
    if (segment.records.length === 0 || elapsed < lagMs) {
      throw new PublishTooEarlyError(Math.max(0, lagMs - elapsed), lagMs);
    }
  }

  const bytes = encodeSegment(segment);
  const receipt = await put(cfg, bytes, {
    // A1/A8: never the 1-epoch default; always the configured window.
    epochs: cfg.walrus.epochs,
    // Decision records are PUBLIC by design (G8) — they carry no plaintext strategy parameters,
    // only the strategy blob id and the ruleset hash.
    payload: 'decision-log',
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.publishers === undefined ? {} : { endpoints: deps.publishers }),
  });

  const tx = buildAnchorTx(cfg, receipt.blobId, segment.meta.seq, deps.refs);

  let result: { $kind: string; Transaction?: { digest: string } | undefined };
  try {
    result = await (deps.client as unknown as AnchorExecutor).core.signAndExecuteTransaction({
      transaction: tx,
      signer: deps.signer,
    });
  } catch (error) {
    throw new AnchorFailedError(
      receipt.blobId,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }

  const digest = result.Transaction?.digest;
  if (result.$kind !== 'Transaction' || digest === undefined || digest === '') {
    throw new AnchorFailedError(receipt.blobId, `execution returned ${result.$kind}`);
  }

  return { blobId: receipt.blobId, seq: segment.meta.seq, anchorDigest: digest, receipt };
}

function requireId(value: string, envVar: string): string {
  if (value === '') {
    throw new ConfigError(`${envVar} is not set — the journal cannot anchor without it`, [envVar]);
  }
  return value;
}
