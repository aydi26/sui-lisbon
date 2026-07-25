// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §5.5 + ERRATA E-K7 (a keeper-side reclaim is WRONG AS SPECIFIED)
// @spec       docs/MOVE-PACKAGE.md §6.3 (`gateway::reclaim_stalled_exit`) + ERRATA E-M8
// @spec       docs/FACTS.md#cancel-withdrawal · docs/RECON.md#r7 (R7.3)
// @rules      G2 G3 G6 G7
// @depends    ./exit.ts (T2.5) · ../hashi/adapter.ts (T0.5) · ../config.ts · aphotic::gateway (T1.4)
// @facts      ★★ DEPOSITOR-SIGNED ONLY. THE KEEPER CAN NEVER CALL THIS.
// @facts        public fun hashi::withdraw::cancel_withdrawal(hashi, request_id, clock, ctx): Balance<BTC>
// @facts        asserts request.sender == ctx.sender()   EUnauthorizedCancellation
// @facts        The "sender" is whoever signed the PTB that called request_withdrawal — i.e. the
// @facts        depositor who signed `gateway::exit_to_bitcoin`. A keeper-signed reclaim ABORTS.
// @facts        ⇒ this module is a PTB BUILDER + a stall DETECTOR. It never signs, never submits.
// @facts        The app hands the built bytes to the depositor's zkLogin session (docs/FACTS.md#zklogin).
// @facts      public fun aphotic::gateway::reclaim_stalled_exit(vault: &mut Vault, hashi: &mut Hashi,
// @facts          request_id: address, who: address, book_mid: u128, clock: &Clock, ctx: &mut TxContext)
// @facts        wraps cancel_withdrawal, returns Balance<BTC> to idle, re-credits shares.
// @facts      Cancellable ONLY pre-commit: status Requested | Approved. Past
// @facts        PickedForProcessing it aborts ECannotCancelProcessingWithdrawal.
// @facts      WITHDRAWAL_CANCELLATION_COOLDOWN_MS = 3_600_000 (cfg.hashi.cancellationCooldownMs):
// @facts        now >= created_ms + 1 h, else ECooldownNotElapsed.
// @facts      G3: reclaim is the ONLY recourse on a stall. There is no way to buy queue priority.
// @implements export interface StalledExit / ReclaimRequest / ReclaimTx
// @implements export function findStalledExits(withdrawals: readonly WithdrawalView[], nowMs: Millis, cfg: Config): readonly StalledExit[]
// @implements export function isReclaimable(view: WithdrawalView, createdAtMs: Millis, nowMs: Millis, cooldownMs: Millis): boolean
// @implements export function buildReclaimTx(cfg: Config, req: ReclaimRequest): Transaction
// @forbidden  signing or executing anything in this file — no Signer parameter exists ON PURPOSE (G2)
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  a keeper `reclaim` command that submits — the CLI must PRINT the unsigned PTB
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. No function here takes a Signer or returns a digest. Building only.
// @invariant  2. `sender` of the built tx is the DEPOSITOR (`req.depositor`), never the keeper.
// @invariant  3. Detection is PURE: `nowMs` is an argument, never a clock read.
// @invariant  4. Hashi's own aborts are surfaced verbatim by the chain — never swallowed here.
// @ac         docs/KEEPER.md ERRATA E-K7 — keeper detects stalls, depositor executes them
// @verify     npm run test -- reclaim
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { WithdrawalView } from '../hashi/types.js';
import type { Millis, ObjectId, Sats, SuiAddress } from '../types.js';

/** A pre-commit withdrawal that has sat past the cooldown and can be reclaimed by its depositor. */
export interface StalledExit {
  readonly requestId: string;
  readonly sats: Sats;
  /** The original requester — the ONLY address whose signature `cancel_withdrawal` accepts. */
  readonly requester: SuiAddress;
  readonly stalledForMs: Millis;
  /** ms epoch at which the 1 h cancellation cooldown elapsed. */
  readonly reclaimableAtMs: Millis;
}

export interface ReclaimRequest {
  readonly vaultId: ObjectId;
  /** The stalled Hashi withdrawal request id (a Sui `address`). */
  readonly hashiRequestId: string;
  /** Depositor to re-credit AND the required tx sender (G2). */
  readonly depositor: SuiAddress;
  /** DeepBook mid for the re-credit share math (G9). */
  readonly bookMid: bigint;
}

/**
 * Detect stalls the keeper may SURFACE (never execute).
 *
 * PURE. Only pre-commit statuses (`Requested` | `Approved`) qualify; anything at
 * `PickedForProcessing` or beyond is committed and aborts on cancel.
 */
// TODO(T2.5): filter pre-commit statuses, apply cfg.hashi.cancellationCooldownMs, compute lag.
export function findStalledExits(
  _withdrawals: readonly WithdrawalView[],
  _nowMs: Millis,
  _cfg: Config,
): readonly StalledExit[] {
  throw new Error('TODO(T2.5): findStalledExits not implemented');
}

/** Pre-commit status + cooldown elapsed. Mirrors the two on-chain asserts exactly. */
// TODO(T2.5): status ∈ {Requested, Approved} && nowMs >= createdAtMs + cooldownMs.
export function isReclaimable(
  _view: WithdrawalView,
  _createdAtMs: Millis,
  _nowMs: Millis,
  _cooldownMs: Millis,
): boolean {
  throw new Error('TODO(T2.5): isReclaimable not implemented');
}

/**
 * Build the UNSIGNED reclaim PTB for the depositor to sign.
 *
 * ⚠ Returning an unsigned `Transaction` is the point: if this module could sign, the keeper would
 * be able to move funds, and the non-custodial claim would be false (G2).
 */
// TODO(T2.5): tx.setSender(req.depositor); one moveCall
//             `${cfg.aphotic.packageId}::gateway::reclaim_stalled_exit`
//             with [vault, hashi(shared,mut), pure address(hashiRequestId), pure address(depositor),
//             pure u128 bookMid, clock]. NEVER attach a keeper signature.
export function buildReclaimTx(_cfg: Config, _req: ReclaimRequest): Transaction {
  throw new Error('TODO(T2.5): buildReclaimTx not implemented');
}
