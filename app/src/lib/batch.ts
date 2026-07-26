// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.2 (the batch), §7.3 (cadence), §9 (liveness is not a
//             privilege)
// @spec       docs/DESIGN-V2.md §3 (seal_approve + skew tolerance), §4 (timing),
//             §5 (clearing)
// @spec       move/sources/batch.move · move/sources/clearing.move — every
//             signature below was read there.
// @rules      G7 G8 G10
// @depends    ./moveRead.ts (F2) · ./vault.ts (F2) · ./suiClient.ts · ../config.ts
// @facts      ENTRY SIGNATURES, verbatim:
// @facts        batch::open_batch(&mut BatchRegistry, &Clock, ctx) -> Batch
// @facts        batch::share_batch(Batch)
// @facts        batch::submit_order(&mut Batch, commitment: vector<u8>,
// @facts                            ct_hash: vector<u8>, blob_id: vector<u8>,
// @facts                            &Clock, &TxContext)
// @facts        batch::close_batch(&mut Batch, &Clock)
// @facts        batch::new_order(submitter: address, is_bid: bool,
// @facts                         limit_price: u64, qty_sats: u64,
// @facts                         salt: vector<u8>) -> Order
// @facts        batch::reveal_order(&mut Batch, index: u64, Order, &Clock)
// @facts        clearing::begin<B,Q,S>(&BatchRegistry, &mut Batch, &mut Vault,
// @facts                               &Clock, ctx) -> Clearing
// @facts        clearing::step<B,Q,S>(&mut Clearing, &mut Batch,
// @facts                              &mut BatchRegistry, &mut Vault, budget: u64)
// @facts        clearing::verify_fill(&Clearing, &Fill, index: u64,
// @facts                              &vector<vector<u8>>) -> bool
// @facts        clearing::fill_at(&Clearing, i: u64) -> Fill
// @facts      EVERY ONE OF THEM IS PERMISSIONLESS. open/close/reveal/begin/step
// @facts        take no capability: the schedule and the commitments ARE the
// @facts        authorization, so a keeper that is down cannot strand a batch.
// @facts      ⚠ `submit_order` asserts `now + submit_cutoff_ms <= close_ms`, so
// @facts        the last 60 s of a window rejects submits on chain — the greyed
// @facts        button mirrors a contract rule, it does not invent one.
// @facts      ⚠ `reveal_order` asserts state == SEALED and
// @facts        `now <= closed_at_ms + reveal_grace_ms` (10 min). Reveal is a
// @facts        WINDOW, not a deadline you can miss quietly.
// @facts      ⚠ THE BATCH OBJECT ID IS NOT IN ANY VITE_* VAR and cannot be: a
// @facts        `Batch` is created and shared by whoever calls `open_batch`. It is
// @facts        DISCOVERED — the last `BatchOpened` event names the transaction,
// @facts        and that transaction's object changes name the shared object.
// @facts      ⚠ gRPC v2 exposes no event query, so discovery and the history log
// @facts        run over the verified JSON-RPC mirror (RECON R1). Stated, not hidden.
// @implements export interface RegistrySnapshot · BatchSnapshot · SealedOrderRow
//             · RevealedOrderRow · ClearingSnapshot · FillRow · BatchHistoryRow
// @implements export async function readRegistry · readBatch · readSealedOrders
//             · readClearing · readFills · readBatchHistory · discoverLiveBatch
//             · discoverClearing
// @implements export function buildDepositNote · buildSpendNote · buildTopUpBase
//             · buildWithdrawBase · buildSubmitOrder · buildRevealOrder
//             · buildOpenBatch · buildCloseBatch
// @implements export async function proveFill(...)
// @forbidden  inventing a batch id, a batch object id or an order count
// @forbidden  a read on mount
// @invariant  1. Every builder targets a `public fun` that exists in the module.
// @invariant  2. Nothing here decrypts, encrypts or touches a note secret — that
//                is seal.ts and notes.ts.
// @ac         app/test/batch.test.ts — snapshots decode from injected BCS; the
//             submit builder carries exactly three byte vectors and a clock.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Transaction } from '@mysten/sui/transactions';

import { config } from '../config';
import {
  CLOCK_ID,
  aphoticTarget,
  decode,
  first,
  nth,
  readMove,
  requireWired,
  type ReadOptions,
} from './moveRead';
import { getJsonRpcClient } from './suiClient';
import type { VaultTypeArgs } from './vault';

const BYTES = bcs.vector(bcs.u8());
const BYTE_VECS = bcs.vector(bcs.vector(bcs.u8()));

// ── registry ────────────────────────────────────────────────────────────────

export interface RegistrySnapshot {
  readonly cadenceMs: bigint;
  readonly offsetMs: bigint;
  readonly policyVersion: bigint;
  readonly maxBatchSize: bigint;
  readonly submitCutoffMs: bigint;
  readonly revealGraceMs: bigint;
  readonly nextBatchId: bigint;
  readonly liveBatches: bigint;
}

const REGISTRY_ACCESSORS = [
  'cadence_ms',
  'offset_ms',
  'policy_version',
  'max_batch_size',
  'registry_submit_cutoff_ms',
  'registry_reveal_grace_ms',
  'next_batch_id',
  'live_batches',
] as const;

export async function readRegistry(opts?: ReadOptions): Promise<RegistrySnapshot> {
  requireWired([['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId]]);
  const values = await readMove((tx) => {
    for (const fn of REGISTRY_ACCESSORS) {
      tx.moveCall({
        target: aphoticTarget('batch', fn),
        arguments: [tx.object(config.aphotic.batchRegistryId)],
      });
    }
  }, opts);
  const u = (i: number) => decode.u64(first(values, i));
  return {
    cadenceMs: u(0),
    offsetMs: u(1),
    policyVersion: u(2),
    maxBatchSize: u(3),
    submitCutoffMs: u(4),
    revealGraceMs: u(5),
    nextBatchId: u(6),
    liveBatches: u(7),
  };
}

// ── the live batch ──────────────────────────────────────────────────────────

export const STATE_OPEN = 0;
export const STATE_SEALED = 1;
export const STATE_CLEARING = 2;
export const STATE_SETTLED = 3;

export function stateLabel(state: number): string {
  return (
    { 0: 'OPEN', 1: 'SEALED', 2: 'CLEARING', 3: 'SETTLED' }[state] ?? `UNKNOWN(${state})`
  );
}

export interface BatchSnapshot {
  readonly objectId: string;
  readonly batchId: bigint;
  readonly state: number;
  readonly policyVersion: bigint;
  readonly openedAtMs: bigint;
  readonly closeMs: bigint;
  readonly closedAtMs: bigint;
  readonly maxOrders: bigint;
  readonly submitCutoffMs: bigint;
  readonly revealGraceMs: bigint;
  readonly orderCount: bigint;
  readonly revealedCount: bigint;
}

const BATCH_ACCESSORS: readonly (readonly [keyof BatchSnapshot, string, 'u64' | 'u8'])[] = [
  ['batchId', 'batch_id', 'u64'],
  ['state', 'state', 'u8'],
  ['policyVersion', 'batch_policy_version', 'u64'],
  ['openedAtMs', 'opened_at_ms', 'u64'],
  ['closeMs', 'close_ms', 'u64'],
  ['closedAtMs', 'closed_at_ms', 'u64'],
  ['maxOrders', 'max_orders', 'u64'],
  ['submitCutoffMs', 'submit_cutoff_ms', 'u64'],
  ['revealGraceMs', 'reveal_grace_ms', 'u64'],
  ['orderCount', 'order_count', 'u64'],
  ['revealedCount', 'revealed_count', 'u64'],
];

export async function readBatch(batchObjectId: string, opts?: ReadOptions): Promise<BatchSnapshot> {
  const values = await readMove((tx) => {
    for (const [, fn] of BATCH_ACCESSORS) {
      tx.moveCall({ target: aphoticTarget('batch', fn), arguments: [tx.object(batchObjectId)] });
    }
  }, opts);
  const out: Record<string, unknown> = { objectId: batchObjectId };
  BATCH_ACCESSORS.forEach(([key, , kind], i) => {
    const raw = first(values, i);
    out[key] = kind === 'u8' ? decode.u8(raw) : decode.u64(raw);
  });
  return out as unknown as BatchSnapshot;
}

export interface SealedOrderRow {
  readonly index: number;
  readonly submitter: string;
  readonly commitment: Uint8Array;
  readonly ctHash: Uint8Array;
  readonly blobId: Uint8Array;
  readonly submittedAtMs: bigint;
  readonly revealed: boolean;
}

/**
 * The sealed order book. Everything here is public from the moment of submission
 * and none of it says how much, which side, or at what price.
 */
export async function readSealedOrders(
  batchObjectId: string,
  count: number,
  opts?: ReadOptions,
): Promise<readonly SealedOrderRow[]> {
  if (count === 0) return [];
  const values = await readMove((tx) => {
    for (let i = 0; i < count; i += 1) {
      const batch = tx.object(batchObjectId);
      const sealed = tx.moveCall({
        target: aphoticTarget('batch', 'sealed_order_at'),
        arguments: [batch, tx.pure.u64(BigInt(i))],
      });
      for (const fn of [
        'sealed_submitter',
        'sealed_commitment',
        'sealed_ct_hash',
        'sealed_blob_id',
        'sealed_submitted_at_ms',
      ]) {
        tx.moveCall({ target: aphoticTarget('batch', fn), arguments: [sealed] });
      }
      tx.moveCall({
        target: aphoticTarget('batch', 'is_revealed_at'),
        arguments: [batch, tx.pure.u64(BigInt(i))],
      });
    }
  }, opts);

  const rows: SealedOrderRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * 7; // 1 sealed_order_at + 5 accessors + 1 is_revealed_at
    rows.push({
      index: i,
      submitter: decode.address(first(values, base + 1)),
      commitment: decode.bytes(first(values, base + 2)),
      ctHash: decode.bytes(first(values, base + 3)),
      blobId: decode.bytes(first(values, base + 4)),
      submittedAtMs: decode.u64(first(values, base + 5)),
      revealed: decode.bool(first(values, base + 6)),
    });
  }
  return rows;
}

export interface RevealedOrderRow {
  readonly index: number;
  readonly submitter: string;
  readonly isBid: boolean;
  readonly limitPrice: bigint;
  readonly qtySats: bigint;
}

/** The plaintext of the orders that HAVE been revealed. Call only for those indices. */
export async function readRevealedOrders(
  batchObjectId: string,
  indices: readonly number[],
  opts?: ReadOptions,
): Promise<readonly RevealedOrderRow[]> {
  if (indices.length === 0) return [];
  const values = await readMove((tx) => {
    for (const i of indices) {
      const order = tx.moveCall({
        target: aphoticTarget('batch', 'revealed_at'),
        arguments: [tx.object(batchObjectId), tx.pure.u64(BigInt(i))],
      });
      for (const fn of ['order_submitter', 'order_is_bid', 'order_limit_price', 'order_qty_sats']) {
        tx.moveCall({ target: aphoticTarget('batch', fn), arguments: [order] });
      }
    }
  }, opts);
  return indices.map((index, k) => {
    const base = k * 5;
    return {
      index,
      submitter: decode.address(first(values, base + 1)),
      isBid: decode.bool(first(values, base + 2)),
      limitPrice: decode.u64(first(values, base + 3)),
      qtySats: decode.u64(first(values, base + 4)),
    };
  });
}

// ── clearing ────────────────────────────────────────────────────────────────

export interface ClearingSnapshot {
  readonly objectId: string;
  readonly stage: number;
  readonly done: boolean;
  readonly batchId: bigint;
  readonly clearingPrice: bigint;
  readonly matchedBaseSats: bigint;
  readonly fillsRoot: Uint8Array;
  readonly fillCount: bigint;
  readonly totalDebits: bigint;
  readonly totalCredits: bigint;
  readonly feeQuoteSats: bigint;
}

export async function readClearing(
  clearingId: string,
  opts?: ReadOptions,
): Promise<ClearingSnapshot> {
  const accessors: readonly (readonly [string, 'u64' | 'u8' | 'bool' | 'bytes'])[] = [
    ['stage', 'u8'],
    ['is_done', 'bool'],
    ['clearing_batch_id', 'u64'],
    ['clearing_price', 'u64'],
    ['matched_base_sats', 'u64'],
    ['fills_root', 'bytes'],
    ['fill_count', 'u64'],
    ['total_debits', 'u64'],
    ['total_credits', 'u64'],
    ['fee_quote_sats', 'u64'],
  ];
  const values = await readMove((tx) => {
    for (const [fn] of accessors) {
      tx.moveCall({ target: aphoticTarget('clearing', fn), arguments: [tx.object(clearingId)] });
    }
  }, opts);
  return {
    objectId: clearingId,
    stage: decode.u8(first(values, 0)),
    done: decode.bool(first(values, 1)),
    batchId: decode.u64(first(values, 2)),
    clearingPrice: decode.u64(first(values, 3)),
    matchedBaseSats: decode.u64(first(values, 4)),
    fillsRoot: decode.bytes(first(values, 5)),
    fillCount: decode.u64(first(values, 6)),
    totalDebits: decode.u64(first(values, 7)),
    totalCredits: decode.u64(first(values, 8)),
    feeQuoteSats: decode.u64(first(values, 9)),
  };
}

/** One published fill — this is the Merkle leaf, field for field. */
export interface FillRow {
  readonly index: number;
  readonly batchId: bigint;
  readonly orderIndex: bigint;
  readonly submitter: string;
  readonly isBid: boolean;
  readonly baseSats: bigint;
  readonly quoteSats: bigint;
  readonly price: bigint;
}

const FILL_ACCESSORS: readonly (readonly [keyof FillRow, string, 'u64' | 'bool' | 'address'])[] = [
  ['batchId', 'fill_batch_id', 'u64'],
  ['orderIndex', 'fill_order_index', 'u64'],
  ['submitter', 'fill_submitter', 'address'],
  ['isBid', 'fill_is_bid', 'bool'],
  ['baseSats', 'fill_base_sats', 'u64'],
  ['quoteSats', 'fill_quote_sats', 'u64'],
  ['price', 'fill_price', 'u64'],
];

export async function readFills(
  clearingId: string,
  count: number,
  opts?: ReadOptions,
): Promise<readonly FillRow[]> {
  if (count === 0) return [];
  const values = await readMove((tx) => {
    for (let i = 0; i < count; i += 1) {
      const fill = tx.moveCall({
        target: aphoticTarget('clearing', 'fill_at'),
        arguments: [tx.object(clearingId), tx.pure.u64(BigInt(i))],
      });
      for (const [, fn] of FILL_ACCESSORS) {
        tx.moveCall({ target: aphoticTarget('clearing', fn), arguments: [fill] });
      }
    }
  }, opts);

  const rows: FillRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * (FILL_ACCESSORS.length + 1);
    const row: Record<string, unknown> = { index: i };
    FILL_ACCESSORS.forEach(([key, , kind], k) => {
      const raw = first(values, base + 1 + k);
      row[key] =
        kind === 'u64' ? decode.u64(raw) : kind === 'bool' ? decode.bool(raw) : decode.address(raw);
    });
    rows.push(row as unknown as FillRow);
  }
  return rows;
}

/**
 * `clearing::verify_fill` by simulation — the contract's own check, run against
 * a path this browser built. It touches no balance and signs nothing.
 */
export async function proveFill(
  clearingId: string,
  fillIndex: number,
  siblings: readonly Uint8Array[],
  opts?: ReadOptions,
): Promise<boolean> {
  const values = await readMove((tx) => {
    const clearing = tx.object(clearingId);
    const fill = tx.moveCall({
      target: aphoticTarget('clearing', 'fill_at'),
      arguments: [clearing, tx.pure.u64(BigInt(fillIndex))],
    });
    tx.moveCall({
      target: aphoticTarget('clearing', 'verify_fill'),
      arguments: [
        clearing,
        fill,
        tx.pure.u64(BigInt(fillIndex)),
        tx.pure(BYTE_VECS.serialize(siblings.map((s) => Array.from(s))).toBytes()),
      ],
    });
  }, opts);
  return decode.bool(first(values, 1));
}

// ── discovery + history, over the JSON-RPC mirror ───────────────────────────

export interface EventRow {
  readonly type: string;
  readonly txDigest: string;
  readonly timestampMs: number | null;
  readonly json: Record<string, unknown>;
}

/** Injected so the offline suite never opens a socket. */
export type EventQueryFn = (
  moveEventType: string,
  order: 'ascending' | 'descending',
  limit: number,
) => Promise<readonly EventRow[]>;

function liveEventQuery(): EventQueryFn {
  return async (moveEventType, order, limit) => {
    const response = await getJsonRpcClient().queryEvents({
      query: { MoveEventType: moveEventType },
      order,
      limit,
    });
    return response.data.map((e) => ({
      type: e.type,
      txDigest: e.id.txDigest,
      timestampMs: e.timestampMs === null || e.timestampMs === undefined ? null : Number(e.timestampMs),
      json: (e.parsedJson ?? {}) as Record<string, unknown>,
    }));
  };
}

export function eventType(moduleName: string, structName: string): string {
  requireWired([['VITE_APHOTIC_ORIGINAL_PACKAGE_ID', config.aphotic.originalPackageId]]);
  return `${config.aphotic.originalPackageId}::${moduleName}::${structName}`;
}

/** Object changes of one transaction, as `[objectId, type]` pairs. Injected in tests. */
export type ObjectChangesFn = (
  txDigest: string,
) => Promise<readonly { readonly objectId: string; readonly objectType: string }[]>;

function liveObjectChanges(): ObjectChangesFn {
  return async (digest) => {
    const response = await getJsonRpcClient().getTransactionBlock({
      digest,
      options: { showObjectChanges: true },
    });
    const changes = response.objectChanges ?? [];
    const out: { objectId: string; objectType: string }[] = [];
    for (const change of changes) {
      if (change.type === 'created' || change.type === 'mutated') {
        out.push({ objectId: change.objectId, objectType: change.objectType });
      }
    }
    return out;
  };
}

async function discoverByEvent(
  moveEventType: string,
  objectTypeSuffix: string,
  opts?: { readonly events?: EventQueryFn; readonly objectChanges?: ObjectChangesFn },
): Promise<string | null> {
  const query = opts?.events ?? liveEventQuery();
  const rows = await query(moveEventType, 'descending', 1);
  const latest = rows[0];
  if (latest === undefined) return null;
  const changes = await (opts?.objectChanges ?? liveObjectChanges())(latest.txDigest);
  const match = changes.find((c) => c.objectType.startsWith(objectTypeSuffix));
  return match?.objectId ?? null;
}

/**
 * The shared `Batch` id, discovered rather than configured.
 *
 * `BatchOpened` carries the numeric batch id, not the object id — so we take the
 * transaction that emitted it and read the shared object it created. Null means
 * "no batch has ever been opened", which is a state, not a failure.
 */
export async function discoverLiveBatch(opts?: {
  readonly events?: EventQueryFn;
  readonly objectChanges?: ObjectChangesFn;
}): Promise<string | null> {
  return discoverByEvent(
    eventType('events', 'BatchOpened'),
    `${config.aphotic.originalPackageId}::batch::Batch`,
    opts,
  );
}

/** The shared `Clearing` for the most recently cleared batch. Same discovery shape. */
export async function discoverClearing(opts?: {
  readonly events?: EventQueryFn;
  readonly objectChanges?: ObjectChangesFn;
}): Promise<string | null> {
  return discoverByEvent(
    eventType('events', 'BatchCleared'),
    `${config.aphotic.originalPackageId}::clearing::Clearing`,
    opts,
  );
}

export interface LiveBatch {
  readonly registry: RegistrySnapshot;
  /** Null when no batch has ever been opened — a state, not a failure. */
  readonly batch: BatchSnapshot | null;
}

/**
 * The registry plus whatever batch was most recently opened.
 *
 * Two round trips by construction: the object id has to be discovered from an
 * event before the batch can be read at all.
 */
export async function readLiveBatch(
  opts?: ReadOptions & {
    readonly events?: EventQueryFn;
    readonly objectChanges?: ObjectChangesFn;
  },
): Promise<LiveBatch> {
  const registry = await readRegistry(opts);
  const objectId = await discoverLiveBatch(opts);
  const batch = objectId === null ? null : await readBatch(objectId, opts);
  return { registry, batch };
}

export interface BatchHistoryRow {
  readonly batchId: bigint;
  readonly openedAtMs: number | null;
  readonly closeAtMs: bigint | null;
  readonly orders: bigint | null;
  readonly clearingPrice: bigint | null;
  readonly matchedSats: bigint | null;
  readonly fillRoot: Uint8Array | null;
  readonly debitsSats: bigint | null;
  readonly creditsSats: bigint | null;
  /** The transaction each stage landed in — every row links to its own receipt. */
  readonly digests: Readonly<Record<string, string>>;
}

function bigOrNull(v: unknown): bigint | null {
  if (v === undefined || v === null) return null;
  try {
    return BigInt(String(v));
  } catch {
    return null;
  }
}

/**
 * Every batch that has ever run, assembled from its four events. Nothing is
 * interpolated: a stage that never happened stays null and renders as a dash.
 */
export async function readBatchHistory(opts?: {
  readonly events?: EventQueryFn;
  readonly limit?: number;
}): Promise<readonly BatchHistoryRow[]> {
  const query = opts?.events ?? liveEventQuery();
  const limit = opts?.limit ?? 50;
  const [opened, closed, cleared, settled] = await Promise.all([
    query(eventType('events', 'BatchOpened'), 'descending', limit),
    query(eventType('events', 'BatchClosed'), 'descending', limit),
    query(eventType('events', 'BatchCleared'), 'descending', limit),
    query(eventType('events', 'BatchSettled'), 'descending', limit),
  ]);

  const rows = new Map<string, BatchHistoryRow>();
  const touch = (id: bigint): BatchHistoryRow => {
    const key = id.toString();
    const existing = rows.get(key);
    if (existing !== undefined) return existing;
    const fresh: BatchHistoryRow = {
      batchId: id,
      openedAtMs: null,
      closeAtMs: null,
      orders: null,
      clearingPrice: null,
      matchedSats: null,
      fillRoot: null,
      debitsSats: null,
      creditsSats: null,
      digests: {},
    };
    rows.set(key, fresh);
    return fresh;
  };
  const patch = (id: bigint, next: Partial<BatchHistoryRow>, stage: string, digest: string) => {
    const base = touch(id);
    rows.set(id.toString(), {
      ...base,
      ...next,
      digests: { ...base.digests, [stage]: digest },
    });
  };

  for (const e of opened) {
    const id = bigOrNull(e.json.batch_id);
    if (id === null) continue;
    patch(
      id,
      { openedAtMs: e.timestampMs, closeAtMs: bigOrNull(e.json.close_at_ms) },
      'opened',
      e.txDigest,
    );
  }
  for (const e of closed) {
    const id = bigOrNull(e.json.batch_id);
    if (id === null) continue;
    patch(id, { orders: bigOrNull(e.json.orders) }, 'closed', e.txDigest);
  }
  for (const e of cleared) {
    const id = bigOrNull(e.json.batch_id);
    if (id === null) continue;
    const root = Array.isArray(e.json.fill_root) ? Uint8Array.from(e.json.fill_root as number[]) : null;
    patch(
      id,
      {
        clearingPrice: bigOrNull(e.json.clearing_price),
        matchedSats: bigOrNull(e.json.matched_sats),
        fillRoot: root,
      },
      'cleared',
      e.txDigest,
    );
  }
  for (const e of settled) {
    const id = bigOrNull(e.json.batch_id);
    if (id === null) continue;
    patch(
      id,
      {
        debitsSats: bigOrNull(e.json.debits_sats),
        creditsSats: bigOrNull(e.json.credits_sats),
      },
      'settled',
      e.txDigest,
    );
  }

  return [...rows.values()].sort((a, b) => (a.batchId === b.batchId ? 0 : a.batchId > b.batchId ? -1 : 1));
}

// ── PTB builders ────────────────────────────────────────────────────────────

function pureBytes(tx: Transaction, bytes: Uint8Array) {
  return tx.pure(BYTES.serialize(Array.from(bytes)).toBytes());
}

/**
 * Escrow one note: pay exactly its denomination and append its commitment.
 *
 * The contract never sees `secret` or `randomness` — only the commitment, and
 * `denom_index`, which a fixed-denomination deposit reveals anyway.
 */
export function buildDepositNote(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly denomIndex: number;
    readonly sats: bigint;
    readonly commitment: Uint8Array;
    readonly coinIds: readonly string[];
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  if (args.coinIds.length === 0) throw new Error('no hBTC coin to fund the note from');
  const [primary, ...rest] = args.coinIds;
  const coin = tx.object(primary!);
  if (rest.length > 0) tx.mergeCoins(coin, rest.map((id) => tx.object(id)));
  const [payment] = tx.splitCoins(coin, [tx.pure.u64(args.sats)]);
  tx.moveCall({
    target: aphoticTarget('vault', 'escrow_deposit_note'),
    typeArguments: [...args.typeArgs],
    arguments: [
      tx.object(config.aphotic.vaultId),
      payment!,
      tx.pure.u8(args.denomIndex),
      pureBytes(tx, args.commitment),
    ],
  });
  return tx;
}

/**
 * Retire a note into the internal balance, proving membership with a path this
 * browser built.
 *
 * ⚠ D8: the path is public, so this spend is LINKABLE to the deposit that
 * created the leaf. v1 delivers uniformity, not unlinkability.
 */
export function buildSpendNote(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly denomIndex: number;
    readonly secret: Uint8Array;
    readonly randomness: Uint8Array;
    readonly leafIndex: bigint;
    readonly siblings: readonly Uint8Array[];
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const witness = tx.moveCall({
    target: aphoticTarget('notes', 'new_membership_witness'),
    arguments: [
      tx.pure.u8(args.denomIndex),
      pureBytes(tx, args.secret),
      pureBytes(tx, args.randomness),
      tx.pure.u64(args.leafIndex),
      tx.pure(BYTE_VECS.serialize(args.siblings.map((s) => Array.from(s))).toBytes()),
    ],
  });
  tx.moveCall({
    target: aphoticTarget('vault', 'escrow_spend_note'),
    typeArguments: [...args.typeArgs],
    arguments: [tx.object(config.aphotic.vaultId), witness],
  });
  return tx;
}

/** Top the internal balance up directly, without a note. Leaks size; offered anyway
 *  because funding at order time leaks TIMING, which is worse. */
export function buildTopUpBase(
  tx: Transaction,
  args: { readonly typeArgs: VaultTypeArgs; readonly sats: bigint; readonly coinIds: readonly string[] },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  if (args.coinIds.length === 0) throw new Error('no hBTC coin to top up from');
  const [primary, ...rest] = args.coinIds;
  const coin = tx.object(primary!);
  if (rest.length > 0) tx.mergeCoins(coin, rest.map((id) => tx.object(id)));
  const [payment] = tx.splitCoins(coin, [tx.pure.u64(args.sats)]);
  tx.moveCall({
    target: aphoticTarget('vault', 'escrow_top_up_base'),
    typeArguments: [...args.typeArgs],
    arguments: [tx.object(config.aphotic.vaultId), payment!],
  });
  return tx;
}

/** Withdraw from the internal balance. Refused on chain while a clearing is in flight. */
export function buildWithdrawBase(
  tx: Transaction,
  args: { readonly typeArgs: VaultTypeArgs; readonly sats: bigint; readonly sender: string },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const coin = tx.moveCall({
    target: aphoticTarget('vault', 'escrow_withdraw_base'),
    typeArguments: [...args.typeArgs],
    arguments: [tx.object(config.aphotic.vaultId), tx.pure.u64(args.sats)],
  });
  tx.transferObjects([coin], tx.pure.address(args.sender));
  return tx;
}

/** Open the next window. Permissionless — anyone may, and `close_ms` is derived. */
export function buildOpenBatch(tx: Transaction): Transaction {
  requireWired([['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId]]);
  const batch = tx.moveCall({
    target: aphoticTarget('batch', 'open_batch'),
    arguments: [tx.object(config.aphotic.batchRegistryId), tx.object(CLOCK_ID)],
  });
  tx.moveCall({ target: aphoticTarget('batch', 'share_batch'), arguments: [batch] });
  return tx;
}

/** Close it. Reverts before `close_ms`; permissionless at or after. */
export function buildCloseBatch(tx: Transaction, batchObjectId: string): Transaction {
  tx.moveCall({
    target: aphoticTarget('batch', 'close_batch'),
    arguments: [tx.object(batchObjectId), tx.object(CLOCK_ID)],
  });
  return tx;
}

/** A commitment, a ciphertext hash and a blob id. No amount, no side, no price. */
export function buildSubmitOrder(
  tx: Transaction,
  args: {
    readonly batchObjectId: string;
    readonly commitment: Uint8Array;
    readonly ctHash: Uint8Array;
    readonly blobId: Uint8Array;
  },
): Transaction {
  tx.moveCall({
    target: aphoticTarget('batch', 'submit_order'),
    arguments: [
      tx.object(args.batchObjectId),
      pureBytes(tx, args.commitment),
      pureBytes(tx, args.ctHash),
      pureBytes(tx, args.blobId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/**
 * Publish one order's plaintext. Permissionless: after the time-lock opens,
 * anyone who can fetch the Seal shares can reveal, which is exactly what removes
 * grief-by-non-revelation.
 */
export function buildRevealOrder(
  tx: Transaction,
  args: {
    readonly batchObjectId: string;
    readonly index: number;
    readonly submitter: string;
    readonly isBid: boolean;
    readonly limitPrice: bigint;
    readonly qtySats: bigint;
    readonly salt: Uint8Array;
  },
): Transaction {
  const order = tx.moveCall({
    target: aphoticTarget('batch', 'new_order'),
    arguments: [
      tx.pure.address(args.submitter),
      tx.pure.bool(args.isBid),
      tx.pure.u64(args.limitPrice),
      tx.pure.u64(args.qtySats),
      pureBytes(tx, args.salt),
    ],
  });
  tx.moveCall({
    target: aphoticTarget('batch', 'reveal_order'),
    arguments: [tx.object(args.batchObjectId), tx.pure.u64(BigInt(args.index)), order, tx.object(CLOCK_ID)],
  });
  return tx;
}

/** `nth` is re-exported so a caller reading a `(u64, u64)` accessor need not import moveRead. */
export { nth };
