// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.close
// @phase      2
// @status     DONE
// @spec       move/sources/batch.move — `public fun close_batch(b: &mut Batch, clock: &Clock)`
//             (`assert!(now >= b.close_ms, ETooEarly)`)
// @spec       aphotic.md §9 (liveness is not a privilege — closing is permissionless)
// @spec       docs/DESIGN-V2.md §4 (a full batch does NOT close early)
// @rules      G5 G10
// @depends    ./read.ts · ../schedule/index.ts · ../sui/send.ts · ../vault/context.ts
// @facts      ★ THE BOUNDARY IS `>=`. A transaction landing in the exact millisecond of `close_ms`
// @facts        succeeds. `dueActions` in ../schedule mirrors this, and the two must agree: an
// @facts        off-by-one in either direction is either a wasted transaction or a missed close.
// @facts      ★ CHECK THE CLOCK LOCALLY FIRST. `close_batch` reverts before the scheduled instant,
// @facts        so sending early buys a gas receipt and an abort code. The refusal here names the
// @facts        exact wait in ms, which is the thing the operator actually needs.
// @facts      ★ A FULL BATCH DOES NOT CLOSE EARLY. There is no fullness branch here at all —
// @facts        closing on fullness would hand a spammer the timing lever uniform-price clearing
// @facts        exists to remove.
// @facts      ⚠ THE LOCAL CLOCK IS NOT THE CHAIN CLOCK. `nowMs` is injected and used only to
// @facts        decide whether to try; the on-chain `Clock` is what actually decides. Near the
// @facts        boundary the honest behaviour is to attempt and let devInspect answer, which is
// @facts        why `--force` exists — it skips the local refusal, never the simulation.
// @facts      ⚠ Permissionless: the PTB carries no capability of any kind.
// @implements export interface CloseOptions / CloseReport
// @implements export function buildCloseBatchTx(d, batchObjectId): Transaction
// @implements export async function runClose(deps, d, opts): Promise<CloseReport>
// @forbidden  closing a batch because it is full
// @forbidden  a capability argument on this path
// @forbidden  broadcasting before `close_ms` without an explicit `--force`
// @invariant  1. The PTB is exactly one `close_batch` command.
// @invariant  2. `nowMs < close_ms` refuses locally unless `force` is set, and the refusal states
//                the remaining wait.
// @invariant  3. A batch not in OPEN is refused with its actual state named.
// @ac         test/close.test.ts — early refusal, boundary equality, wrong-state refusal
// @verify     npm run test -- close
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { STATE_OPEN } from '../schedule/index.js';
import { sendChecked } from '../sui/send.js';
import type { Millis, ObjectId } from '../types.js';
import { AphoticError } from '../util/errors.js';
import type { ChainDeps, Deployment } from '../vault/context.js';

import { readBatch, type BatchState_ } from './read.js';

export interface CloseOptions {
  readonly signer: Signer;
  readonly batchObjectId: ObjectId;
  /** Injected clock (ms epoch) — the schedule module takes it as an argument for the same reason. */
  readonly nowMs: Millis;
  /** Skip the LOCAL earliness refusal. Never skips the simulation. */
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface CloseReport {
  readonly batch: BatchState_;
  readonly digest?: string;
  readonly broadcast: boolean;
}

/** Invariant 1. */
export function buildCloseBatchTx(d: Deployment, batchObjectId: ObjectId): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${d.packageId}::batch::close_batch`,
    arguments: [tx.object(batchObjectId), tx.object.clock()],
  });
  return tx;
}

/** Human-readable state names, so a refusal says SEALED rather than 1. */
const STATE_NAMES = ['OPEN', 'SEALED', 'CLEARING', 'SETTLED'] as const;

export async function runClose(
  deps: ChainDeps,
  d: Deployment,
  opts: CloseOptions,
): Promise<CloseReport> {
  const batch = await readBatch(deps, d, opts.batchObjectId);

  if (batch.state !== STATE_OPEN) {
    // Invariant 3. `close_batch` asserts STATE_OPEN; naming the real state is the useful answer.
    throw new AphoticError(
      'EBadState',
      `batch ${batch.batchId} is ${STATE_NAMES[batch.state] ?? batch.state}, not OPEN — ` +
        'close_batch would abort EBadState. Nothing to close.',
    );
  }

  const now = BigInt(opts.nowMs);
  if (now < batch.closeMs && opts.force !== true) {
    // Invariant 2. The boundary is `>=`; this branch is strictly earlier than that.
    throw new AphoticError(
      'ETooEarly',
      `batch ${batch.batchId} closes at ${batch.closeMs} (${new Date(Number(batch.closeMs)).toISOString()}); ` +
        `local clock says ${now} — ${batch.closeMs - now} ms early. close_batch asserts ` +
        'now >= close_ms and would abort ETooEarly. The cadence is mechanical: nothing here can ' +
        'move that instant. Pass --force to let the CHAIN clock decide instead of this one.',
    );
  }

  const tx = buildCloseBatchTx(d, opts.batchObjectId);
  tx.setSender(opts.signer.toSuiAddress());

  const result = await sendChecked({ client: deps.client }, tx, {
    what: `batch::close_batch ${batch.batchId}`,
    signer: opts.signer,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });

  return {
    batch,
    ...(result.digest === undefined ? {} : { digest: result.digest }),
    broadcast: result.broadcast,
  };
}
