// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4  (post-cut-line)
// @status     DONE
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
// @facts        The codec below is SCHEMA-AWARE: each field has one encoder and one decoder, so a
// @facts        decimal string is revived as a bigint iff the schema says that field is money/time.
// @facts      ⚠ Encoding must be CANONICAL: sorted keys, no incidental whitespace, so the segment
// @facts        hash is stable across machines and re-runs (self-certifying blob ids, G5).
// @facts      `strategyBlobId` is the blob id of the strategy VERSION IN FORCE at that tick, not
// @facts        the current one — that is what makes historical replay meaningful.
// @facts      `ruleset` is the content hash of the compiled decision function (strategy/evaluate.ts
// @facts        `rulesetHash`), so a verifier knows WHICH rules ran without seeing the parameters (G8).
// @facts      Blob ids are content-derived; the on-chain `journal::record(vault, cursor, keeper_cap,
// @facts        blob_id, seq, ctx)` anchors the pointer so it cannot be substituted afterwards.
// @facts      GENESIS SEQ = 1: `aphotic::journal::assert_monotonic_seq` is STRICT (`>`) against a
// @facts        fresh cursor's `last_seq = 0`, so segment numbering is 1-based and seq 0 is invalid.
// @implements export const JOURNAL_SCHEMA_VERSION: 1
// @implements export interface DecisionSegment / SegmentMeta
// @implements export class JournalSchemaError
// @implements export function encodeSegment(segment: DecisionSegment): Uint8Array
// @implements export function decodeSegment(bytes: Uint8Array): DecisionSegment
// @implements export function segmentHash(segment: DecisionSegment): string
// @implements export function assertReplayable(record: DecisionRecord): void
// @implements export function canonicalJson(value: JsonValue): string
// @forbidden  emitting a bigint through JSON.stringify — encode decimal strings
// @forbidden  Number()/parseInt on a decoded numeric string — precision loss on u64
// @forbidden  putting strategy PARAMETERS (plaintext) in a record — only the blob id + ruleset hash (G8)
// @invariant  1. decodeSegment(encodeSegment(s)) deep-equals s, bigints included.
// @invariant  2. Encoding is canonical: same segment ⇒ byte-identical output on any machine.
// @invariant  3. `seq` is monotonically increasing per vault (matches the on-chain assertion);
//                a segment's own `seq` must be >= 1 (genesis cursor `last_seq = 0`, strict `>`).
// @invariant  4. Every record carries enough input to re-run evaluate/route with no extra fetch —
//                enforced at WRITE time by `assertReplayable`, which `encodeSegment` runs.
// @ac         docs/BUILD-PLAN.md T4.2 — records include the hashi fields; blob ids emitted on-chain
// @verify     npm run test -- journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type {
  Decision,
  DecisionAction,
  DecisionRecord,
  Digest,
  L2Book,
  L2Level,
  LimiterSample,
  Millis,
  ObjectId,
  OracleSnapshot,
  Plan,
  Side,
} from '../types.js';
import { AphoticError } from '../util/errors.js';

/** Bump on ANY layout change — `decodeSegment` refuses an unknown version. */
export const JOURNAL_SCHEMA_VERSION = 1 as const;

/** The on-chain cursor starts at 0 and the assertion is strict, so segment 1 is the first legal one. */
export const GENESIS_SEQ = 1n;

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

/** A record or segment that cannot be replayed. `path` names the offending field. */
export class JournalSchemaError extends AphoticError {
  readonly path: string;

  constructor(path: string, detail: string) {
    super('JournalSchema', `journal schema violation at \`${path}\`: ${detail}`);
    this.path = path;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON
// ─────────────────────────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Deterministic serialization (invariant 2): keys sorted lexicographically at every depth, no
 * incidental whitespace, no bigints (they are already decimal strings by the time they get here).
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JournalSchemaError('<number>', `non-finite number ${String(value)} is not encodable`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
  }
  return `{${parts.join(',')}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators — every one names the failing path (invariant 4)
// ─────────────────────────────────────────────────────────────────────────────

function req(value: unknown, path: string): unknown {
  if (value === undefined || value === null) {
    throw new JournalSchemaError(path, 'missing (a record without it cannot be replayed)');
  }
  return value;
}

function obj(value: unknown, path: string): Record<string, unknown> {
  const v = req(value, path);
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new JournalSchemaError(path, `expected an object, got ${typeName(v)}`);
  }
  return v as Record<string, unknown>;
}

function arr(value: unknown, path: string): readonly unknown[] {
  const v = req(value, path);
  if (!Array.isArray(v)) throw new JournalSchemaError(path, `expected an array, got ${typeName(v)}`);
  return v as readonly unknown[];
}

function str(value: unknown, path: string, { allowEmpty = false } = {}): string {
  const v = req(value, path);
  if (typeof v !== 'string') throw new JournalSchemaError(path, `expected a string, got ${typeName(v)}`);
  if (!allowEmpty && v === '') throw new JournalSchemaError(path, 'must not be empty');
  return v;
}

/** Millisecond timestamps and counts stay `number` (Millis); money never does. */
function ms(value: unknown, path: string): Millis {
  const v = req(value, path);
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    throw new JournalSchemaError(path, `expected a non-negative integer millisecond value, got ${String(v)}`);
  }
  return v;
}

/** ENCODE side: a bigint in, a decimal string out. Never `JSON.stringify(bigint)` (it throws). */
function encBig(value: unknown, path: string): string {
  const v = req(value, path);
  if (typeof v !== 'bigint') {
    throw new JournalSchemaError(path, `expected a bigint (money/u64 is never \`number\`, G10), got ${typeName(v)}`);
  }
  if (v < 0n) throw new JournalSchemaError(path, `expected a non-negative u64, got ${v.toString()}`);
  return v.toString(10);
}

/** DECODE side: a decimal string in, a bigint out. Never Number()/parseInt (u64 precision). */
function decBig(value: unknown, path: string): bigint {
  const v = req(value, path);
  if (typeof v !== 'string') {
    throw new JournalSchemaError(
      path,
      `expected a DECIMAL STRING (u64 through Number() loses precision), got ${typeName(v)}`,
    );
  }
  if (!/^\d+$/.test(v)) throw new JournalSchemaError(path, `not a decimal u64 string: ${JSON.stringify(v)}`);
  return BigInt(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field codecs — one encoder + one decoder per shape, so the two can never drift
// ─────────────────────────────────────────────────────────────────────────────

function encLevel(value: unknown, path: string): JsonValue {
  const l = obj(value, path);
  return { px: encBig(l['px'], `${path}.px`), sz: encBig(l['sz'], `${path}.sz`) };
}

function decLevel(value: unknown, path: string): L2Level {
  const l = obj(value, path);
  return { px: decBig(l['px'], `${path}.px`), sz: decBig(l['sz'], `${path}.sz`) };
}

function encLevels(value: unknown, path: string): JsonValue {
  return arr(value, path).map((l, i) => encLevel(l, `${path}[${i}]`));
}

function decLevels(value: unknown, path: string): readonly L2Level[] {
  return arr(value, path).map((l, i) => decLevel(l, `${path}[${i}]`));
}

function encOracle(value: unknown, path: string): JsonValue {
  const o = obj(value, path);
  return {
    pythPx: encBig(o['pythPx'], `${path}.pythPx`),
    pythSeq: encBig(o['pythSeq'], `${path}.pythSeq`),
    pythPublishTimeMs: ms(o['pythPublishTimeMs'], `${path}.pythPublishTimeMs`),
    deepbookTwap: encBig(o['deepbookTwap'], `${path}.deepbookTwap`),
    // G9: the VALUATION reference is the DeepBook mid, never raw Pyth — so it is mandatory.
    deepbookMid: encBig(o['deepbookMid'], `${path}.deepbookMid`),
  };
}

function decOracle(value: unknown, path: string): OracleSnapshot {
  const o = obj(value, path);
  return {
    pythPx: decBig(o['pythPx'], `${path}.pythPx`),
    pythSeq: decBig(o['pythSeq'], `${path}.pythSeq`),
    pythPublishTimeMs: ms(o['pythPublishTimeMs'], `${path}.pythPublishTimeMs`),
    deepbookTwap: decBig(o['deepbookTwap'], `${path}.deepbookTwap`),
    deepbookMid: decBig(o['deepbookMid'], `${path}.deepbookMid`),
  };
}

function encBook(value: unknown, path: string): JsonValue {
  const b = obj(value, path);
  return {
    poolId: str(b['poolId'], `${path}.poolId`),
    bids: encLevels(b['bids'], `${path}.bids`),
    asks: encLevels(b['asks'], `${path}.asks`),
    mid: encBig(b['mid'], `${path}.mid`),
    atMs: ms(b['atMs'], `${path}.atMs`),
  };
}

function decBook(value: unknown, path: string): L2Book {
  const b = obj(value, path);
  return {
    poolId: str(b['poolId'], `${path}.poolId`),
    bids: decLevels(b['bids'], `${path}.bids`),
    asks: decLevels(b['asks'], `${path}.asks`),
    mid: decBig(b['mid'], `${path}.mid`),
    atMs: ms(b['atMs'], `${path}.atMs`),
  };
}

function encLimiter(value: unknown, path: string): JsonValue {
  const l = obj(value, path);
  return {
    atMs: ms(l['atMs'], `${path}.atMs`),
    atSecs: encBig(l['atSecs'], `${path}.atSecs`),
    tokens: encBig(l['tokens'], `${path}.tokens`),
    queueDepth: encBig(l['queueDepth'], `${path}.queueDepth`),
  };
}

function decLimiter(value: unknown, path: string): LimiterSample {
  const l = obj(value, path);
  return {
    atMs: ms(l['atMs'], `${path}.atMs`),
    atSecs: decBig(l['atSecs'], `${path}.atSecs`),
    tokens: decBig(l['tokens'], `${path}.tokens`),
    queueDepth: decBig(l['queueDepth'], `${path}.queueDepth`),
  };
}

/** The bridge block — the thing that makes this an Aphotic × HASHI record (BUILD-PLAN T4.2 AC). */
function encHashi(value: unknown, path: string): JsonValue {
  const h = obj(value, path);
  return {
    limiter: encLimiter(h['limiter'], `${path}.limiter`),
    pendingMintSats: encBig(h['pendingMintSats'], `${path}.pendingMintSats`),
    pendingBurnSats: encBig(h['pendingBurnSats'], `${path}.pendingBurnSats`),
    signedCursorSeq: encBig(h['signedCursorSeq'], `${path}.signedCursorSeq`),
  };
}

function decHashi(value: unknown, path: string): DecisionRecord['hashi'] {
  const h = obj(value, path);
  return {
    limiter: decLimiter(h['limiter'], `${path}.limiter`),
    pendingMintSats: decBig(h['pendingMintSats'], `${path}.pendingMintSats`),
    pendingBurnSats: decBig(h['pendingBurnSats'], `${path}.pendingBurnSats`),
    signedCursorSeq: decBig(h['signedCursorSeq'], `${path}.signedCursorSeq`),
  };
}

const DECISION_ACTIONS: readonly DecisionAction[] = ['quote', 'requote', 'derisk', 'noop'];
const SIDES: readonly Side[] = ['bid', 'ask'];

function encOrderIds(value: unknown, path: string): JsonValue {
  return arr(value, path).map((id, i) => encBig(id, `${path}[${i}]`));
}

function decOrderIds(value: unknown, path: string): readonly bigint[] {
  return arr(value, path).map((id, i) => decBig(id, `${path}[${i}]`));
}

function encDecision(value: unknown, path: string): JsonValue {
  const d = obj(value, path);
  const action = str(d['action'], `${path}.action`);
  if (!DECISION_ACTIONS.includes(action as DecisionAction)) {
    throw new JournalSchemaError(`${path}.action`, `unknown action ${JSON.stringify(action)}`);
  }
  const out: { [k: string]: JsonValue } = {
    action,
    bidPx: encBig(d['bidPx'], `${path}.bidPx`),
    askPx: encBig(d['askPx'], `${path}.askPx`),
    bidSz: encBig(d['bidSz'], `${path}.bidSz`),
    askSz: encBig(d['askSz'], `${path}.askSz`),
    cancels: encOrderIds(d['cancels'], `${path}.cancels`),
    // The seed IS the replay: without it `verify/` cannot reproduce the jitter (A3).
    jitterSeed: str(d['jitterSeed'], `${path}.jitterSeed`),
  };
  if (d['cause'] !== undefined) out['cause'] = str(d['cause'], `${path}.cause`);
  return out;
}

function decDecision(value: unknown, path: string): Decision {
  const d = obj(value, path);
  const action = str(d['action'], `${path}.action`);
  if (!DECISION_ACTIONS.includes(action as DecisionAction)) {
    throw new JournalSchemaError(`${path}.action`, `unknown action ${JSON.stringify(action)}`);
  }
  const base: Decision = {
    action: action as DecisionAction,
    bidPx: decBig(d['bidPx'], `${path}.bidPx`),
    askPx: decBig(d['askPx'], `${path}.askPx`),
    bidSz: decBig(d['bidSz'], `${path}.bidSz`),
    askSz: decBig(d['askSz'], `${path}.askSz`),
    cancels: decOrderIds(d['cancels'], `${path}.cancels`),
    jitterSeed: str(d['jitterSeed'], `${path}.jitterSeed`),
  };
  return d['cause'] === undefined ? base : { ...base, cause: str(d['cause'], `${path}.cause`) };
}

function side(value: unknown, path: string): Side {
  const s = str(value, path);
  if (!SIDES.includes(s as Side)) throw new JournalSchemaError(path, `unknown side ${JSON.stringify(s)}`);
  return s as Side;
}

function encPlan(value: unknown, path: string): JsonValue {
  const p = obj(value, path);
  const makerOrders = arr(p['makerOrders'], `${path}.makerOrders`).map((o, i) => {
    const m = obj(o, `${path}.makerOrders[${i}]`);
    if (m['postOnly'] !== true) {
      // G4: the maker leg is DeepBook POST_ONLY. A maker order that is not post-only is a bug.
      throw new JournalSchemaError(`${path}.makerOrders[${i}].postOnly`, 'maker orders must be POST_ONLY');
    }
    return {
      side: side(m['side'], `${path}.makerOrders[${i}].side`),
      px: encBig(m['px'], `${path}.makerOrders[${i}].px`),
      sz: encBig(m['sz'], `${path}.makerOrders[${i}].sz`),
      expireTs: ms(m['expireTs'], `${path}.makerOrders[${i}].expireTs`),
      postOnly: true,
    };
  });
  const iocOrders = arr(p['iocOrders'], `${path}.iocOrders`).map((o, i) => {
    const io = obj(o, `${path}.iocOrders[${i}]`);
    if (io['ioc'] !== true) {
      throw new JournalSchemaError(`${path}.iocOrders[${i}].ioc`, 'residual orders must be IOC');
    }
    return {
      side: side(io['side'], `${path}.iocOrders[${i}].side`),
      px: encBig(io['px'], `${path}.iocOrders[${i}].px`),
      sz: encBig(io['sz'], `${path}.iocOrders[${i}].sz`),
      ioc: true,
    };
  });
  return { makerOrders, iocOrders, cancels: encOrderIds(p['cancels'], `${path}.cancels`) };
}

function decPlan(value: unknown, path: string): Plan {
  const p = obj(value, path);
  const makerOrders = arr(p['makerOrders'], `${path}.makerOrders`).map((o, i) => {
    const m = obj(o, `${path}.makerOrders[${i}]`);
    if (m['postOnly'] !== true) {
      throw new JournalSchemaError(`${path}.makerOrders[${i}].postOnly`, 'maker orders must be POST_ONLY');
    }
    return {
      side: side(m['side'], `${path}.makerOrders[${i}].side`),
      px: decBig(m['px'], `${path}.makerOrders[${i}].px`),
      sz: decBig(m['sz'], `${path}.makerOrders[${i}].sz`),
      expireTs: ms(m['expireTs'], `${path}.makerOrders[${i}].expireTs`),
      postOnly: true as const,
    };
  });
  const iocOrders = arr(p['iocOrders'], `${path}.iocOrders`).map((o, i) => {
    const io = obj(o, `${path}.iocOrders[${i}]`);
    if (io['ioc'] !== true) {
      throw new JournalSchemaError(`${path}.iocOrders[${i}].ioc`, 'residual orders must be IOC');
    }
    return {
      side: side(io['side'], `${path}.iocOrders[${i}].side`),
      px: decBig(io['px'], `${path}.iocOrders[${i}].px`),
      sz: decBig(io['sz'], `${path}.iocOrders[${i}].sz`),
      ioc: true as const,
    };
  });
  return { makerOrders, iocOrders, cancels: decOrderIds(p['cancels'], `${path}.cancels`) };
}

function encResult(value: unknown, path: string): JsonValue {
  const r = obj(value, path);
  if (r['digest'] !== undefined) return { digest: str(r['digest'], `${path}.digest`) };
  if (r['skipped'] !== undefined) return { skipped: str(r['skipped'], `${path}.skipped`) };
  throw new JournalSchemaError(path, 'must carry either a tx `digest` or a `skipped` reason');
}

function decResult(value: unknown, path: string): DecisionRecord['result'] {
  const r = obj(value, path);
  if (r['digest'] !== undefined) return { digest: str(r['digest'], `${path}.digest`) };
  if (r['skipped'] !== undefined) return { skipped: str(r['skipped'], `${path}.skipped`) };
  throw new JournalSchemaError(path, 'must carry either a tx `digest` or a `skipped` reason');
}

function encRecord(value: unknown, path: string): JsonValue {
  const r = obj(value, path);
  return {
    tickMs: ms(r['tickMs'], `${path}.tickMs`),
    oracle: encOracle(r['oracle'], `${path}.oracle`),
    book: encBook(r['book'], `${path}.book`),
    hashi: encHashi(r['hashi'], `${path}.hashi`),
    strategyBlobId: str(r['strategyBlobId'], `${path}.strategyBlobId`),
    ruleset: str(r['ruleset'], `${path}.ruleset`),
    decision: encDecision(r['decision'], `${path}.decision`),
    plan: encPlan(r['plan'], `${path}.plan`),
    result: encResult(r['result'], `${path}.result`),
  };
}

function decRecord(value: unknown, path: string): DecisionRecord {
  const r = obj(value, path);
  return {
    tickMs: ms(r['tickMs'], `${path}.tickMs`),
    oracle: decOracle(r['oracle'], `${path}.oracle`),
    book: decBook(r['book'], `${path}.book`),
    hashi: decHashi(r['hashi'], `${path}.hashi`),
    strategyBlobId: str(r['strategyBlobId'], `${path}.strategyBlobId`),
    ruleset: str(r['ruleset'], `${path}.ruleset`),
    decision: decDecision(r['decision'], `${path}.decision`),
    plan: decPlan(r['plan'], `${path}.plan`),
    result: decResult(r['result'], `${path}.result`),
  };
}

function encMeta(value: unknown, path: string): JsonValue {
  const m = obj(value, path);
  const schemaVersion = m['schemaVersion'];
  if (schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalSchemaError(
      `${path}.schemaVersion`,
      `expected ${JOURNAL_SCHEMA_VERSION}, got ${String(schemaVersion)}`,
    );
  }
  const seq = req(m['seq'], `${path}.seq`);
  if (typeof seq !== 'bigint' || seq < GENESIS_SEQ) {
    throw new JournalSchemaError(
      `${path}.seq`,
      `segment seq must be a bigint >= ${GENESIS_SEQ} (the on-chain cursor starts at 0 and asserts strict \`>\`), got ${String(seq)}`,
    );
  }
  const fromMs = ms(m['fromMs'], `${path}.fromMs`);
  const toMs = ms(m['toMs'], `${path}.toMs`);
  if (toMs < fromMs) throw new JournalSchemaError(`${path}.toMs`, `toMs ${toMs} precedes fromMs ${fromMs}`);
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    vaultId: str(m['vaultId'], `${path}.vaultId`),
    seq: seq.toString(10),
    fromMs,
    toMs,
    strategyBlobId: str(m['strategyBlobId'], `${path}.strategyBlobId`),
    ruleset: str(m['ruleset'], `${path}.ruleset`),
  };
}

function decMeta(value: unknown, path: string): SegmentMeta {
  const m = obj(value, path);
  if (m['schemaVersion'] !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalSchemaError(
      `${path}.schemaVersion`,
      `unknown journal schema version ${String(m['schemaVersion'])} — this build understands ${JOURNAL_SCHEMA_VERSION}`,
    );
  }
  const seq = decBig(m['seq'], `${path}.seq`);
  if (seq < GENESIS_SEQ) {
    throw new JournalSchemaError(`${path}.seq`, `segment seq must be >= ${GENESIS_SEQ}, got ${seq.toString()}`);
  }
  const fromMs = ms(m['fromMs'], `${path}.fromMs`);
  const toMs = ms(m['toMs'], `${path}.toMs`);
  if (toMs < fromMs) throw new JournalSchemaError(`${path}.toMs`, `toMs ${toMs} precedes fromMs ${fromMs}`);
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    vaultId: str(m['vaultId'], `${path}.vaultId`),
    seq,
    fromMs,
    toMs,
    strategyBlobId: str(m['strategyBlobId'], `${path}.strategyBlobId`),
    ruleset: str(m['ruleset'], `${path}.ruleset`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guard: a record must carry EVERY input `evaluate`/`route` consumed, or `verify/` will report a
 * mismatch that is really a logging bug. Fail loudly at write time instead (invariant 4).
 */
export function assertReplayable(record: DecisionRecord): void {
  encRecord(record, 'record');
}

/** Canonical, deterministic encoding. bigints become decimal strings; keys are sorted. */
export function encodeSegment(segment: DecisionSegment): Uint8Array {
  const s = obj(segment, 'segment');
  const meta = encMeta(s['meta'], 'segment.meta');
  const records = arr(s['records'], 'segment.records');

  let previousTickMs = -1;
  const encodedRecords: JsonValue[] = [];
  for (let i = 0; i < records.length; i++) {
    const path = `segment.records[${i}]`;
    const encoded = encRecord(records[i], path);
    const tickMs = ms((records[i] as Record<string, unknown>)['tickMs'], `${path}.tickMs`);
    if (tickMs < previousTickMs) {
      throw new JournalSchemaError(
        `${path}.tickMs`,
        `records must be tick-ordered for replay: ${tickMs} follows ${previousTickMs}`,
      );
    }
    previousTickMs = tickMs;
    encodedRecords.push(encoded);
  }

  const root: { [k: string]: JsonValue } = { meta, records: encodedRecords };
  if (s['anchorDigest'] !== undefined) {
    root['anchorDigest'] = str(s['anchorDigest'], 'segment.anchorDigest');
  }

  return new TextEncoder().encode(canonicalJson(root));
}

/** Inverse of {@link encodeSegment}. Rejects an unknown `schemaVersion`. */
export function decodeSegment(bytes: Uint8Array): DecisionSegment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new JournalSchemaError(
      'segment',
      `not a decodable UTF-8 JSON segment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = obj(parsed, 'segment');
  const meta = decMeta(root['meta'], 'segment.meta');
  const records = arr(root['records'], 'segment.records').map((r, i) =>
    decRecord(r, `segment.records[${i}]`),
  );

  const segment: DecisionSegment = { meta, records };
  return root['anchorDigest'] === undefined
    ? segment
    : { ...segment, anchorDigest: str(root['anchorDigest'], 'segment.anchorDigest') };
}

/** Stable hash of the canonical encoding — the local twin of the Walrus content-derived id. */
export function segmentHash(segment: DecisionSegment): string {
  return createHash('sha256').update(encodeSegment(segment)).digest('hex');
}
