// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.drive
// @phase      2
// @status     DONE
// @spec       move/sources/clearing.move — `public fun begin<B,Q,S>(r: &BatchRegistry,
//             b: &mut Batch, v: &mut Vault<B,Q,S>, clock: &Clock, ctx: &mut TxContext): Clearing`
//             · `public fun share_clearing(c: Clearing)`
//             · `public fun step<B,Q,S>(c: &mut Clearing, b: &mut Batch, r: &mut BatchRegistry,
//                v: &mut Vault<B,Q,S>, budget: u64)`
// @spec       docs/DESIGN-V2.md §5 (clearing — determinism is the product) · §2 (the ceilings)
// @spec       aphotic.md §9 (liveness is not a privilege — every step is permissionless)
// @rules      G5 G10
// @depends    ./read.ts · ../vault/context.ts · ../schedule/index.ts · ../sui/send.ts
// @facts      ★★ THERE IS ONE PUBLIC DRIVER, `clearing::step`, NOT THREE. The build brief named
// @facts        `sort_step` / `price_step` / `settle_step`; in the shipped module those are PRIVATE
// @facts        stage handlers dispatched by `step` off `c.stage`. Seven stages exist — LOADING,
// @facts        PRICING, ALLOC_FULL, ALLOC_PRORATA, ALLOC_REMAINDER, ROOTING, SETTLING — and
// @facts        calling one directly is not possible from outside the package. Driving `step` in a
// @facts        loop is the same work through the door that exists.
// @facts      ★ THE CURSOR IS WHY A BIG BATCH COSTS TRANSACTIONS, NOT A REDESIGN. `step` advances
// @facts        by at most `budget` units and is SAFE TO CALL after the clearing has finished —
// @facts        STAGE_DONE falls through doing nothing. So an over-long loop wastes gas; it can
// @facts        never corrupt a settled clearing.
// @facts      ★ `begin` CONSUMES THE CLOCK AND NOTHING ELSE DOES. Nothing in the match itself reads
// @facts        a clock, which is half of why the result is reproducible off-chain. It also calls
// @facts        `batch::to_clearing`, which requires every order revealed OR the reveal grace
// @facts        expired — so a clearing can never start against a half-revealed book.
// @facts      ★ PERMISSIONLESS. `step` is on the KeeperCap list in DESIGN-V2 §7 as a BUDGET HINT
// @facts        only; the function takes no capability, and this client passes none. If the keeper
// @facts        is down anyone drives the clearing.
// @facts      ⚠ THE LOOP IS BOUNDED. `--max-steps` stops it and REPORTS the stage it stopped in.
// @facts        An unbounded retry against a stuck stage is how a keeper burns a gas budget
// @facts        overnight and reports success in the morning.
// @implements export const CLEARING_STAGES / DEFAULT_BUDGET / DEFAULT_MAX_STEPS
// @implements export interface DriveOptions / DriveReport / ClearingSnapshot
// @implements export function buildBeginTx(d, typeArgs, batchObjectId): Transaction
// @implements export function buildStepTx(d, typeArgs, ids, budget): Transaction
// @implements export async function readClearing(deps, d, clearingId): Promise<ClearingSnapshot>
// @implements export async function runDrive(deps, d, opts): Promise<DriveReport>
// @forbidden  calling a private stage handler — `step` is the only public driver
// @forbidden  an unbounded step loop
// @forbidden  a capability argument on this path
// @invariant  1. `step` is never sent with `budget == 0` (clearing.move asserts budget > 0).
// @invariant  2. The loop stops at STAGE_DONE or at `maxSteps`, and the report says which.
// @invariant  3. `begin` runs only when the batch is SEALED; otherwise the existing clearing is used.
// @ac         test/drive.test.ts — PTB shape, budget guard, loop termination and its report
// @verify     npm run test -- drive
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { STATE_SEALED } from '../schedule/index.js';
import { sendChecked } from '../sui/send.js';
import type { ObjectId } from '../types.js';
import { AphoticError } from '../util/errors.js';
import {
  applySender,
  decodeBool,
  decodeBytes,
  decodeU64,
  decodeU8,
  findCreatedObject,
  inspect,
  returnValue,
  type ChainDeps,
  type Deployment,
  type VaultTypeArgs,
} from '../vault/context.js';

import { readBatch } from './read.js';

/**
 * `clearing.move` stage ids, INDEXED BY THE ON-CHAIN NUMBER — not by pipeline order.
 *
 * ⚠ 8–11 are appended, not inserted, and that is deliberate on the Move side: ids
 * 0–7 keep exactly the meaning package v1 published, so an id is a wire format
 * rather than a position. Renumbering to read prettily here would silently
 * relabel every historical `ClearingStepped` event.
 *
 * The four tail stages exist because D4 was fixed: truncation moved from load
 * time to AFTER price discovery, so a run now prices the submitted book, then
 * truncates against the frozen funding snapshot, then re-runs the SAME
 * allocation rule against the reduced matched volume. Hence a second
 * FULL/PRORATA/REMAINDER trio.
 */
export const CLEARING_STAGES = [
  'LOADING',
  'PRICING',
  'ALLOC_FULL',
  'ALLOC_PRORATA',
  'ALLOC_REMAINDER',
  'ROOTING',
  'SETTLING',
  'DONE',
  'TRUNCATE',
  'REALLOC_FULL',
  'REALLOC_PRORATA',
  'REALLOC_REMAINDER',
] as const;

/** Units of work per transaction. Conservative; raise it when a batch is measured, not before. */
export const DEFAULT_BUDGET = 64n;
/** Loop bound (invariant 2). Enough for a 256-order batch at the default budget, with headroom. */
export const DEFAULT_MAX_STEPS = 64;

export interface ClearingSnapshot {
  readonly objectId: ObjectId;
  readonly stage: number;
  readonly stageName: string;
  readonly isDone: boolean;
  readonly batchId: bigint;
  readonly clearingPrice: bigint;
  readonly matchedBaseSats: bigint;
  readonly fillCount: bigint;
  readonly fillsRoot: Uint8Array;
}

export interface DriveOptions {
  readonly signer: Signer;
  readonly typeArgs: VaultTypeArgs;
  readonly batchObjectId: ObjectId;
  /** An existing shared `Clearing`. Absent ⇒ `begin` is sent first (invariant 3). */
  readonly clearingObjectId?: ObjectId;
  readonly budget?: bigint;
  readonly maxSteps?: number;
  readonly dryRun?: boolean;
}

export interface DriveReport {
  readonly clearingObjectId?: ObjectId;
  readonly began: boolean;
  readonly steps: number;
  readonly digests: readonly string[];
  readonly final?: ClearingSnapshot;
  /** True when the loop hit `maxSteps` with work left — say so, never imply completion. */
  readonly exhausted: boolean;
  readonly broadcast: boolean;
}

export function stageName(stage: number): string {
  return CLEARING_STAGES[stage] ?? `UNKNOWN(${stage})`;
}

/** SEALED → CLEARING, then share the `Clearing` so anyone can step it. */
export function buildBeginTx(
  d: Deployment,
  typeArgs: VaultTypeArgs,
  batchObjectId: ObjectId,
): Transaction {
  const tx = new Transaction();
  const clearing = tx.moveCall({
    target: `${d.packageId}::clearing::begin`,
    typeArguments: [...typeArgs],
    arguments: [
      tx.object(d.registryId),
      tx.object(batchObjectId),
      tx.object(d.vaultId),
      tx.object.clock(),
    ],
  });
  tx.moveCall({
    target: `${d.packageId}::clearing::share_clearing`,
    typeArguments: [],
    arguments: [clearing],
  });
  return tx;
}

/** One `step`. Argument order is `(c, b, r, v, budget)` — verbatim from clearing.move. */
export function buildStepTx(
  d: Deployment,
  typeArgs: VaultTypeArgs,
  ids: { readonly clearingObjectId: ObjectId; readonly batchObjectId: ObjectId },
  budget: bigint,
): Transaction {
  if (budget <= 0n) {
    // Invariant 1 — clearing.move asserts `budget > 0` (EBadParam).
    throw new AphoticError('EBadParam', `step budget must be > 0 — got ${budget}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${d.packageId}::clearing::step`,
    typeArguments: [...typeArgs],
    arguments: [
      tx.object(ids.clearingObjectId),
      tx.object(ids.batchObjectId),
      tx.object(d.registryId),
      tx.object(d.vaultId),
      tx.pure.u64(budget),
    ],
  });
  return tx;
}

const CLEARING_GETTERS = [
  'stage',
  'is_done',
  'clearing_batch_id',
  'clearing_price',
  'matched_base_sats',
  'fill_count',
  'fills_root',
] as const;

export async function readClearing(
  deps: ChainDeps,
  d: Deployment,
  clearingObjectId: ObjectId,
): Promise<ClearingSnapshot> {
  const tx = new Transaction();
  for (const fn of CLEARING_GETTERS) {
    tx.moveCall({
      target: `${d.packageId}::clearing::${fn}`,
      arguments: [tx.object(clearingObjectId)],
    });
  }
  const returns = await inspect(deps, applySender(deps, tx), `clearing read ${clearingObjectId}`);
  const u64 = (i: number): bigint => {
    const what = `clearing::${CLEARING_GETTERS[i] as string}`;
    return decodeU64(returnValue(returns, i, what), what);
  };

  const stage = decodeU8(returnValue(returns, 0, 'clearing::stage'), 'clearing::stage');
  return {
    objectId: clearingObjectId,
    stage,
    stageName: stageName(stage),
    isDone: decodeBool(returnValue(returns, 1, 'clearing::is_done'), 'clearing::is_done'),
    batchId: u64(2),
    clearingPrice: u64(3),
    matchedBaseSats: u64(4),
    fillCount: u64(5),
    fillsRoot: decodeBytes(returnValue(returns, 6, 'clearing::fills_root'), 'clearing::fills_root'),
  };
}

export async function runDrive(
  deps: ChainDeps,
  d: Deployment,
  opts: DriveOptions,
): Promise<DriveReport> {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`--max-steps must be >= 1 — got ${maxSteps}`);
  }

  const digests: string[] = [];
  let broadcast = false;
  let clearingObjectId = opts.clearingObjectId;
  let began = false;

  if (clearingObjectId === undefined) {
    const batch = await readBatch(deps, d, opts.batchObjectId);
    if (batch.state !== STATE_SEALED) {
      // Invariant 3: `begin` asserts SEALED via `batch::to_clearing`. Anything else means the
      // caller already has a Clearing object and simply did not pass it.
      throw new AphoticError(
        'EBadState',
        `batch ${batch.batchId} is in state ${batch.state}, not SEALED, and no --clearing was ` +
          'given. `begin` only moves SEALED → CLEARING; if the clearing already started, pass ' +
          'its shared object id with --clearing.',
      );
    }

    const beginTx = buildBeginTx(d, opts.typeArgs, opts.batchObjectId);
    beginTx.setSender(opts.signer.toSuiAddress());
    const result = await sendChecked({ client: deps.client }, beginTx, {
      what: 'clearing::begin',
      signer: opts.signer,
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    began = true;
    broadcast = broadcast || result.broadcast;
    if (result.digest !== undefined) digests.push(result.digest);

    if (!result.broadcast) {
      // Dry run: there is no shared Clearing to step. Report that honestly rather than
      // pretending the loop ran.
      return { began, steps: 0, digests, exhausted: false, broadcast };
    }
    clearingObjectId = await findCreatedObject(deps, result.digest ?? '', 'clearing', 'Clearing');
    if (clearingObjectId === undefined) {
      throw new AphoticError(
        'ClearingNotFound',
        `clearing::begin landed (digest ${result.digest ?? 'unknown'}) but no ` +
          '`clearing::Clearing` appears among the created objects. Re-run with --clearing once ' +
          'the id is known; the object exists, this client simply could not identify it.',
      );
    }
  }

  let steps = 0;
  let snapshot = await readClearing(deps, d, clearingObjectId);

  while (!snapshot.isDone && steps < maxSteps) {
    const tx = buildStepTx(d, opts.typeArgs, { clearingObjectId, batchObjectId: opts.batchObjectId }, budget);
    tx.setSender(opts.signer.toSuiAddress());
    const result = await sendChecked({ client: deps.client }, tx, {
      what: `clearing::step (${snapshot.stageName}, budget ${budget})`,
      signer: opts.signer,
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    steps += 1;
    broadcast = broadcast || result.broadcast;
    if (result.digest !== undefined) digests.push(result.digest);

    if (!result.broadcast) break; // dry run: one simulated step is the whole answer
    snapshot = await readClearing(deps, d, clearingObjectId);
  }

  return {
    clearingObjectId,
    began,
    steps,
    digests,
    final: snapshot,
    // Invariant 2: hitting the bound with work left is REPORTED, never rounded up to success.
    exhausted: !snapshot.isDone && steps >= maxSteps,
    broadcast,
  };
}
