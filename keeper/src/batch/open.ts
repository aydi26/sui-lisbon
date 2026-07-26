// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.open
// @phase      2
// @status     DONE
// @spec       move/sources/batch.move — `public fun open_batch(r: &mut BatchRegistry,
//             clock: &Clock, ctx: &mut TxContext): Batch` · `public fun share_batch(b: Batch)`
// @spec       docs/DESIGN-V2.md §4 ("`open_batch` takes NO timestamp parameter; close_ms is derived")
// @spec       aphotic.md §9 (liveness is not a privilege — opening is permissionless)
// @rules      G5 G10
// @depends    ./read.ts · ../vault/context.ts · ../schedule/index.ts · ../sui/send.ts
// @facts      ★★ `open_batch` TAKES NO TIMESTAMP. `close_ms = next_boundary(clock.timestamp_ms(),
// @facts        cadence, offset)`, derived on chain. There is no flag on this command that could
// @facts        move a close time, and there must never be one: an operator who could pick when a
// @facts        batch closes could advantage selected orders, which is the exact attack
// @facts        uniform-price clearing exists to remove.
// @facts      ★ PERMISSIONLESS. No capability appears in the PTB. If the keeper is down, anyone
// @facts        runs this at the scheduled time — the CLI is an optimisation, not a gatekeeper.
// @facts      ★ `open_batch` returns the `Batch` BY VALUE and it must be SHARED in the same
// @facts        transaction, or the object is stranded in the transaction's result and the call
// @facts        does not typecheck at all. The two commands are one atomic unit by construction.
// @facts      ⚠ `live_batches == 0` is asserted on chain (EBatchAlreadyLive). It is checked here
// @facts        first so the answer is "a batch is already live, here is its id" rather than a gas
// @facts        receipt for an abort code.
// @facts      ⚠ THE NEW BATCH ID IS DISCOVERED FROM EFFECTS, not predicted. A Sui object id is
// @facts        derived from the transaction digest and a creation counter; guessing it is not
// @facts        possible, and printing a wrong one would send the operator to the wrong object for
// @facts        the rest of the cycle.
// @implements export interface OpenReport
// @implements export function buildOpenBatchTx(d): Transaction
// @implements export async function runOpen(deps, d, opts): Promise<OpenReport>
// @forbidden  a `--close-ms` flag, or any operator-supplied close time, ever
// @forbidden  a capability argument on this path
// @invariant  1. The PTB is exactly `open_batch` then `share_batch`, with no third command.
// @invariant  2. The predicted `close_ms` is computed from the REGISTRY's cadence, not a constant.
// @invariant  3. Refuses locally when a batch is already live.
// @ac         test/open.test.ts — PTB shape, derived close time, already-live refusal
// @verify     npm run test -- open
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { nextBoundary } from '../schedule/index.js';
import { sendChecked } from '../sui/send.js';
import type { Millis, ObjectId } from '../types.js';
import { AphoticError } from '../util/errors.js';
import { findCreatedObject, type ChainDeps, type Deployment } from '../vault/context.js';

import { readRegistry, type RegistryState } from './read.js';

export interface OpenOptions {
  readonly signer: Signer;
  /** Injected clock (ms epoch). Supplied by the caller so a run is replayable. */
  readonly nowMs: Millis;
  readonly dryRun?: boolean;
}

export interface OpenReport {
  readonly registry: RegistryState;
  /** What `next_boundary` will derive on chain for this `nowMs` (invariant 2). */
  readonly predictedCloseMs: bigint;
  readonly digest?: string;
  /** The shared `Batch`, read out of the transaction's effects. */
  readonly batchObjectId?: ObjectId;
  readonly broadcast: boolean;
}

/** Invariant 1: two commands, no capability, no timestamp. */
export function buildOpenBatchTx(d: Deployment): Transaction {
  const tx = new Transaction();
  const batch = tx.moveCall({
    target: `${d.packageId}::batch::open_batch`,
    arguments: [tx.object(d.registryId), tx.object.clock()],
  });
  tx.moveCall({
    target: `${d.packageId}::batch::share_batch`,
    arguments: [batch],
  });
  return tx;
}

export async function runOpen(
  deps: ChainDeps,
  d: Deployment,
  opts: OpenOptions,
): Promise<OpenReport> {
  const registry = await readRegistry(deps, d);

  if (registry.liveBatches > 0n) {
    // Invariant 3. The chain would abort EBatchAlreadyLive; saying so costs nothing.
    throw new AphoticError(
      'EBatchAlreadyLive',
      `the registry reports ${registry.liveBatches} live batch(es). ` +
        'batch::open_batch asserts live_batches == 0, so this would abort. Close and settle the ' +
        'live batch first — `close` then `drive`.',
    );
  }

  const predictedCloseMs = nextBoundary(BigInt(opts.nowMs), registry.cadence);

  const tx = buildOpenBatchTx(d);
  tx.setSender(opts.signer.toSuiAddress());

  const result = await sendChecked({ client: deps.client }, tx, {
    what: 'batch::open_batch',
    signer: opts.signer,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });

  const base = { registry, predictedCloseMs, broadcast: result.broadcast } as const;
  if (!result.broadcast || result.digest === undefined) return base;

  const batchObjectId = await findCreatedObject(deps, result.digest, 'batch', 'Batch');
  return {
    ...base,
    digest: result.digest,
    ...(batchObjectId === undefined ? {} : { batchObjectId }),
  };
}
