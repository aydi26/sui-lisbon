// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.read
// @phase      2
// @status     DONE
// @spec       move/sources/batch.move — the public read surface (`cadence_ms`, `offset_ms`,
//             `policy_version`, `max_batch_size`, `registry_submit_cutoff_ms`,
//             `registry_reveal_grace_ms`, `next_batch_id`, `live_batches`, `state`, `close_ms`,
//             `closed_at_ms`, `order_count`, `revealed_count`, `sealed_order_at`, `is_revealed_at`)
// @spec       ../schedule/index.ts — `BatchSnapshot` is defined there; this module FILLS it
// @rules      G10
// @depends    ../vault/context.ts · ../schedule/index.ts
// @facts      ★ THE SNAPSHOT SHAPE IS `schedule/BatchSnapshot`, deliberately. `dueActions` already
// @facts        decides what is callable from exactly these fields and is already tested; a second
// @facts        shape here would be a second, untested opinion about the same state machine.
// @facts      ★ Batch states: 0 OPEN · 1 SEALED · 2 CLEARING · 3 SETTLED. Monotonic — `set_state`
// @facts        asserts `next > state`, so nothing ever returns toward OPEN.
// @facts      ★ THE REGISTRY'S CADENCE IS READ, NOT ASSUMED. `DEFAULT_CADENCE` is 12 h / 6 h, but
// @facts        `set_cadence` is a governed parameter. A keeper that predicted the boundary from a
// @facts        constant while the chain used another would compute a close time that is wrong in
// @facts        exactly one direction, silently.
// @facts      ⚠ `sealed_order_at` returns a `SealedOrder` BY VALUE. BCS layout, field order verbatim:
// @facts          address submitter ‖ vector<u8> commitment ‖ vector<u8> ct_hash
// @facts          ‖ vector<u8> blob_id ‖ u64 submitted_at_ms
// @facts      ⚠ Order reads are CHUNKED. A 256-order batch is 512 commands, and the batch is read
// @facts        for its own sake — a read that trips a per-transaction ceiling is a read that fails
// @facts        exactly when the batch is busiest.
// @implements export interface RegistryState / SealedOrderRow
// @implements export const DEFAULT_ORDER_READ_CHUNK
// @implements export async function readRegistry(deps, d): Promise<RegistryState>
// @implements export async function readBatch(deps, d, batchId): Promise<BatchSnapshot & {...}>
// @implements export async function readSealedOrders(deps, d, batchId, count, opts): Promise<SealedOrderRow[]>
// @forbidden  assuming the cadence instead of reading it
// @forbidden  a partial snapshot escaping a failed read
// @invariant  1. `state` is narrowed to the four legal values or the read fails.
// @invariant  2. `readSealedOrders` returns exactly `count` rows, index-aligned, or throws.
// @ac         test/batchread.test.ts — snapshot decode, state narrowing, chunked order reads
// @verify     npm run test -- batchread
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import {
  STATE_CLEARING,
  STATE_OPEN,
  STATE_SEALED,
  STATE_SETTLED,
  type BatchSnapshot,
  type BatchState,
  type CadenceParams,
} from '../schedule/index.js';
import type { ObjectId, SuiAddress } from '../types.js';
import { AphoticError } from '../util/errors.js';
import {
  applySender,
  decodeAddress,
  decodeBool,
  decodeU64,
  decodeU8,
  inspect,
  returnValue,
  type ChainDeps,
  type Deployment,
} from '../vault/context.js';

/** Two commands per order; 64 orders per simulation keeps every read well inside the ceilings. */
export const DEFAULT_ORDER_READ_CHUNK = 64;

export interface RegistryState {
  readonly vaultId: ObjectId;
  readonly cadence: CadenceParams;
  readonly policyVersion: bigint;
  readonly maxBatchSize: bigint;
  readonly submitCutoffMs: bigint;
  readonly revealGraceMs: bigint;
  readonly nextBatchId: bigint;
  readonly liveBatches: bigint;
}

/** A batch snapshot plus the two fields the Seal identity needs. */
export interface BatchState_ extends BatchSnapshot {
  readonly objectId: ObjectId;
  readonly vaultId: ObjectId;
  readonly policyVersion: bigint;
  readonly openedAtMs: bigint;
}

export interface SealedOrderRow {
  readonly index: number;
  readonly submitter: SuiAddress;
  readonly commitment: Uint8Array;
  readonly ctHash: Uint8Array;
  /** Raw `vector<u8>` as stored on chain. See ./reveal.ts for how it becomes a Walrus id. */
  readonly blobId: Uint8Array;
  readonly submittedAtMs: bigint;
  readonly isRevealed: boolean;
}

const SEALED_ORDER_BCS = bcs.struct('SealedOrder', {
  submitter: bcs.Address,
  commitment: bcs.vector(bcs.u8()),
  ct_hash: bcs.vector(bcs.u8()),
  blob_id: bcs.vector(bcs.u8()),
  submitted_at_ms: bcs.u64(),
});

const REGISTRY_GETTERS = [
  'registry_vault_id',
  'cadence_ms',
  'offset_ms',
  'policy_version',
  'max_batch_size',
  'registry_submit_cutoff_ms',
  'registry_reveal_grace_ms',
  'next_batch_id',
  'live_batches',
] as const;

export async function readRegistry(deps: ChainDeps, d: Deployment): Promise<RegistryState> {
  const tx = new Transaction();
  for (const fn of REGISTRY_GETTERS) {
    tx.moveCall({
      target: `${d.packageId}::batch::${fn}`,
      arguments: [tx.object(d.registryId)],
    });
  }
  const returns = await inspect(deps, applySender(deps, tx), 'batch registry read');
  const u64 = (i: number): bigint => {
    const what = `batch::${REGISTRY_GETTERS[i] as string}`;
    return decodeU64(returnValue(returns, i, what), what);
  };

  return {
    vaultId: decodeAddress(
      returnValue(returns, 0, 'batch::registry_vault_id'),
      'batch::registry_vault_id',
    ),
    cadence: { cadenceMs: u64(1), offsetMs: u64(2) },
    policyVersion: u64(3),
    maxBatchSize: u64(4),
    submitCutoffMs: u64(5),
    revealGraceMs: u64(6),
    nextBatchId: u64(7),
    liveBatches: u64(8),
  };
}

const BATCH_GETTERS = [
  'batch_vault_id',
  'batch_id',
  'state',
  'batch_policy_version',
  'opened_at_ms',
  'close_ms',
  'closed_at_ms',
  'max_orders',
  'submit_cutoff_ms',
  'reveal_grace_ms',
  'order_count',
  'revealed_count',
] as const;

/** Invariant 1: an out-of-range state is a failure, never coerced. */
export function narrowState(raw: number): BatchState {
  switch (raw) {
    case STATE_OPEN:
      return STATE_OPEN;
    case STATE_SEALED:
      return STATE_SEALED;
    case STATE_CLEARING:
      return STATE_CLEARING;
    case STATE_SETTLED:
      return STATE_SETTLED;
    default:
      throw new AphoticError(
        'BadBatchState',
        `batch::state returned ${raw}, which is outside 0..3 — refusing to guess what the ` +
          'state machine is doing',
      );
  }
}

export async function readBatch(
  deps: ChainDeps,
  d: Deployment,
  batchObjectId: ObjectId,
): Promise<BatchState_> {
  const tx = new Transaction();
  for (const fn of BATCH_GETTERS) {
    tx.moveCall({
      target: `${d.packageId}::batch::${fn}`,
      arguments: [tx.object(batchObjectId)],
    });
  }
  const returns = await inspect(deps, applySender(deps, tx), `batch read ${batchObjectId}`);
  const u64 = (i: number): bigint => {
    const what = `batch::${BATCH_GETTERS[i] as string}`;
    return decodeU64(returnValue(returns, i, what), what);
  };

  return {
    objectId: batchObjectId,
    vaultId: decodeAddress(returnValue(returns, 0, 'batch::batch_vault_id'), 'batch::batch_vault_id'),
    batchId: u64(1),
    state: narrowState(decodeU8(returnValue(returns, 2, 'batch::state'), 'batch::state')),
    policyVersion: u64(3),
    openedAtMs: u64(4),
    closeMs: u64(5),
    closedAtMs: u64(6),
    maxOrders: Number(u64(7)),
    submitCutoffMs: u64(8),
    revealGraceMs: u64(9),
    orderCount: Number(u64(10)),
    revealedCount: Number(u64(11)),
  };
}

/** Every sealed order, index-aligned, read in bounded chunks (invariant 2). */
export async function readSealedOrders(
  deps: ChainDeps,
  d: Deployment,
  batchObjectId: ObjectId,
  count: number,
  chunkSize: number = DEFAULT_ORDER_READ_CHUNK,
): Promise<SealedOrderRow[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`order read chunk must be >= 1 — got ${chunkSize}`);
  }
  const rows: SealedOrderRow[] = [];

  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(start + chunkSize, count);
    const tx = new Transaction();
    for (let i = start; i < end; i += 1) {
      tx.moveCall({
        target: `${d.packageId}::batch::sealed_order_at`,
        arguments: [tx.object(batchObjectId), tx.pure.u64(i)],
      });
      tx.moveCall({
        target: `${d.packageId}::batch::is_revealed_at`,
        arguments: [tx.object(batchObjectId), tx.pure.u64(i)],
      });
    }
    const returns = await inspect(deps, applySender(deps, tx), `sealed orders [${start},${end})`);

    for (let i = start; i < end; i += 1) {
      const at = (i - start) * 2;
      const raw = SEALED_ORDER_BCS.parse(
        returnValue(returns, at, `batch::sealed_order_at(${i})`),
      );
      rows.push({
        index: i,
        submitter: raw.submitter,
        commitment: Uint8Array.from(raw.commitment),
        ctHash: Uint8Array.from(raw.ct_hash),
        blobId: Uint8Array.from(raw.blob_id),
        submittedAtMs: BigInt(raw.submitted_at_ms),
        isRevealed: decodeBool(
          returnValue(returns, at + 1, `batch::is_revealed_at(${i})`),
          `batch::is_revealed_at(${i})`,
        ),
      });
    }
  }

  if (rows.length !== count) {
    throw new AphoticError(
      'ShortOrderRead',
      `expected ${count} sealed orders, decoded ${rows.length} — refusing to clear a partial book`,
    );
  }
  return rows;
}
