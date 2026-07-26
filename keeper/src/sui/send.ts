// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.keeper.send
// @phase      1
// @status     DONE
// @spec       aphotic.md §9 ("devInspect-before-send. Simulate every transaction; catch reverts
//             off-chain, never broadcast them.")
// @spec       aphotic.md §9 ("Fail-soft. Exponential backoff, no crash on transient errors")
// @spec       docs/CONVENTIONS.md §6 — gate `send`: `signAndExecute` may appear in THIS FILE ONLY
// @rules      G2 G7
// @depends    ./client.ts (the single client factory) · ../util/backoff.ts · ../util/errors.ts
// @facts      ★ THIS FILE IS THE ONLY PLACE IN keeper/src THAT MAY BROADCAST. `gates.ps1 send`
// @facts        greps for the literal `signAndExecute` across keeper/src and sdk/src and fails on
// @facts        any hit outside this path. A second broadcast site is a path that can send blind.
// @facts      ★ ORDER OF OPERATIONS, always:
// @facts          1. simulate  (client.core.simulateTransaction)
// @facts          2. if the simulation reports a failure  ⇒  throw PreflightRevert, DO NOT SEND
// @facts          3. only then sign and execute
// @facts        Both `$kind === 'FailedTransaction'` AND `Transaction.status.success === false`
// @facts        are treated as a revert. The two are separate upstream shapes and checking only
// @facts        one lets a revert through — the exact hole this wrapper exists to close.
// @facts      ★ `PreflightRevert` is classified FATAL by ../util/backoff.ts: a transaction that
// @facts        deterministically aborts will abort identically on the next attempt. Retrying it
// @facts        burns gas budget and hides the bug. Transport failures around it are transient and
// @facts        DO retry.
// @facts      ⚠ A simulation is not a guarantee. State can move between the simulation and the
// @facts        execution (someone else's `close_batch`, a NAV epoch bump). The wrapper narrows
// @facts        the window; it does not close it. Never describe it as a guarantee.
// @facts      Structural client surface (declared here, not imported): @mysten/sui@2.22.1 types
// @facts        `simulateTransaction` and `signAndExecuteTransaction` are generic in different
// @facts        `Include` parameters, so calling them off the `AnySuiClient` union does not
// @facts        typecheck. ../oracle/deepbook.ts uses the same narrowing for the same reason.
// @implements export interface PreflightResult / SendResult / SendDeps / SendOptions
// @implements export class PreflightRevertError extends AphoticError
// @implements export async function preflight(deps, tx, opts): Promise<PreflightResult>
// @implements export async function sendChecked(deps, tx, opts): Promise<SendResult>
// @forbidden  `signAndExecute` anywhere else in keeper/src — gates.ps1 send
// @forbidden  broadcasting without a preceding simulation — that IS the rule
// @forbidden  constructing a Sui client here — ./client.ts is the single site (gates.ps1 transport)
// @forbidden  swallowing a preflight failure into a retry loop
// @invariant  1. `sendChecked` calls `signAndExecuteTransaction` at most once per invocation, and
//                never at all when the preflight reported a revert.
// @invariant  2. A preflight revert surfaces as PreflightRevertError, whose `code` classifies as
//                'fatal', so ../util/backoff.ts will not retry it.
// @invariant  3. `dryRun: true` never broadcasts, whatever the preflight said.
// @ac         test/send.test.ts — revert is never broadcast; success broadcasts exactly once
// @verify     npm run test -- send
// @verify     powershell -NoProfile -File scripts/gates.ps1 send
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import { AphoticError } from '../util/errors.js';

import type { AnySuiClient } from './client.js';

/** Thrown when the simulation says the transaction would abort. Classified 'fatal'. */
export class PreflightRevertError extends AphoticError {
  readonly what: string;
  readonly detail: string;

  constructor(what: string, detail: string) {
    super('PreflightRevert', `refusing to broadcast ${what}: simulation reverted — ${detail}`);
    this.what = what;
    this.detail = detail;
  }
}

/** The minimal simulation/execution surface. See the @facts note on why it is declared, not imported. */
interface TxCore {
  simulateTransaction(input: {
    transaction: Transaction;
    include: { effects: true; commandResults: true };
  }): Promise<{
    readonly $kind: string;
    readonly Transaction?: { readonly status?: { success: boolean; error?: unknown } } | undefined;
    readonly FailedTransaction?:
      | { readonly status?: { success: boolean; error?: unknown } }
      | undefined;
    readonly commandResults?:
      | readonly { readonly returnValues: readonly { readonly bcs: Uint8Array }[] }[]
      | undefined;
  }>;
  signAndExecuteTransaction(input: {
    transaction: Transaction;
    signer: Signer;
  }): Promise<{
    readonly $kind: string;
    readonly Transaction?: { readonly digest: string } | undefined;
    readonly FailedTransaction?: { readonly digest: string } | undefined;
  }>;
}

export interface SendDeps {
  readonly client: AnySuiClient;
}

export interface SendOptions {
  /** Names the operation in errors and logs. */
  readonly what: string;
  readonly signer: Signer;
  /** `true` ⇒ simulate and report, never broadcast (invariant 3). */
  readonly dryRun?: boolean;
}

export interface PreflightResult {
  readonly ok: boolean;
  /** Present when `ok` is false — the upstream error, stringified. */
  readonly error?: string;
  /** BCS return values of each command, for callers that simulate a pure read. */
  readonly commandReturns: readonly (readonly Uint8Array[])[];
}

export interface SendResult {
  readonly preflight: PreflightResult;
  /** Absent when `dryRun` was set. */
  readonly digest?: string;
  readonly broadcast: boolean;
}

function describeError(value: unknown): string {
  if (value === null || value === undefined) return 'no error detail reported';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Simulate `tx` and report whether it would succeed. Never signs, never broadcasts.
 *
 * A revert is a RESULT here (`ok: false`), not an exception — `sendChecked` is the layer that
 * turns it into a refusal. Reads that only want return values call this directly.
 */
export async function preflight(
  deps: SendDeps,
  tx: Transaction,
  what: string,
): Promise<PreflightResult> {
  const core = deps.client.core as unknown as TxCore;
  const sim = await core.simulateTransaction({
    transaction: tx,
    include: { effects: true, commandResults: true },
  });

  const commandReturns = (sim.commandResults ?? []).map((c) =>
    c.returnValues.map((v) => v.bcs),
  );

  // BOTH shapes mean "this would abort". Checking only one is the hole (see @facts).
  if (sim.$kind === 'FailedTransaction') {
    const detail = describeError(sim.FailedTransaction?.status?.error);
    return { ok: false, error: `${what}: ${detail}`, commandReturns };
  }
  const status = sim.Transaction?.status;
  if (status !== undefined && status.success === false) {
    return { ok: false, error: `${what}: ${describeError(status.error)}`, commandReturns };
  }

  return { ok: true, commandReturns };
}

/**
 * devInspect-before-send (aphotic.md §9). Simulate; refuse on a revert; otherwise broadcast once.
 *
 * ⚠ Narrowing, not a guarantee: state can move between the two calls. See the @facts block.
 */
export async function sendChecked(
  deps: SendDeps,
  tx: Transaction,
  opts: SendOptions,
): Promise<SendResult> {
  const result = await preflight(deps, tx, opts.what);

  if (!result.ok) {
    // Invariant 1/2: refuse, loudly, and classify as fatal so no retry loop re-broadcasts it.
    throw new PreflightRevertError(opts.what, result.error ?? 'unknown');
  }

  if (opts.dryRun === true) {
    return { preflight: result, broadcast: false };
  }

  const core = deps.client.core as unknown as TxCore;
  const executed = await core.signAndExecuteTransaction({ transaction: tx, signer: opts.signer });

  if (executed.$kind === 'FailedTransaction') {
    const digest = executed.FailedTransaction?.digest ?? '';
    throw new AphoticError(
      'ExecutionFailed',
      `${opts.what} passed simulation but failed on chain (digest ${digest}) — the state moved ` +
        'between the simulation and the execution',
    );
  }

  const digest = executed.Transaction?.digest ?? '';
  return { preflight: result, digest, broadcast: true };
}
