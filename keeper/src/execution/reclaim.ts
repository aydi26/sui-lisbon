// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2
// @status     DONE
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
// @facts      VERBATIM from move/sources/gateway.move (T1.4, DONE):
// @facts        public fun aphotic::gateway::reclaim_stalled_exit<Q>(vault: &mut Vault<BTC, Q>,
// @facts            hashi: &mut Hashi, request_id: address, book_mid: u128,
// @facts            clock: &Clock, ctx: &mut TxContext)
// @facts        ⚠ ERRATUM vs the skeleton banner, which listed a `who: address` argument: the
// @facts        shipped Move function takes NO `who` — it uses `ctx.sender()` and asserts
// @facts        `who == ctx.sender()` internally, which is precisely what makes a third-party
// @facts        reclaim impossible. The Move source wins. ONE type argument (Q).
// @facts        It wraps cancel_withdrawal, returns Balance<BTC> to idle, re-credits shares.
// @facts      Cancellable ONLY pre-commit: status Requested | Approved. Past
// @facts        PickedForProcessing it aborts ECannotCancelProcessingWithdrawal.
// @facts      WITHDRAWAL_CANCELLATION_COOLDOWN_MS = 3_600_000 (cfg.hashi.cancellationCooldownMs):
// @facts        now >= created_ms + 1 h, else ECooldownNotElapsed.
// @facts      G3: reclaim is the ONLY recourse on a stall. There is no way to buy queue priority.
// @implements export interface StalledExit / ReclaimRequest / TrackedWithdrawal
// @implements export function findStalledExits(withdrawals: readonly TrackedWithdrawal[], nowMs: Millis, cfg: Config): readonly StalledExit[]
// @implements export function isReclaimable(view: TrackedWithdrawal, createdAtMs: Millis, nowMs: Millis, cooldownMs: Millis): boolean
// @implements export function buildReclaimTx(cfg: Config, req: ReclaimRequest): Transaction
// @implements ⚠ DELTAS vs the skeleton banner, all additive and deliberate:
// @implements   (a) `TrackedWithdrawal` widens `WithdrawalView` with the two facts the cooldown
// @implements       needs and the view does not carry: `createdAtMs` and `requester`. A plain
// @implements       `WithdrawalView[]` is still assignable, so the declared signature still holds.
// @implements       It deliberately does NOT restate the destination field — a reclaim never
// @implements       touches a destination (G2, gates.ps1 g2).
// @implements   (b) export function trackWithdrawals(events): readonly TrackedWithdrawal[] — folds
// @implements       the public event stream into exactly those facts, so `findStalledExits` has a
// @implements       real input. The requester comes from `WithdrawalRequested.requester_address`,
// @implements       which is the ONLY address the upstream cancel accepts.
// @implements   (c) `ReclaimTx` is `Transaction` — an unsigned PTB is the whole deliverable; there
// @implements       is no wrapper type to add, and adding one would only invite a `sign()` on it.
// @forbidden  signing or executing anything in this file — no Signer parameter exists ON PURPOSE (G2)
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  a keeper `reclaim` command that submits — the CLI must PRINT the unsigned PTB
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. No function here takes a Signer or returns a digest. Building only.
// @invariant  2. `sender` of the built tx is the DEPOSITOR (`req.depositor`), never the keeper.
// @invariant  3. Detection is PURE: `nowMs` is an argument, never a clock read.
// @invariant  4. Hashi's own aborts are surfaced verbatim by the chain — never swallowed here.
// @ac         docs/KEEPER.md ERRATA E-K7 — keeper detects stalls, depositor executes them
// @verify     npm run test -- exit
// @verify     ⚠ the skeleton banner said `npm run test -- reclaim`. There is no `reclaim.test.ts`:
// @verify        T2.5's tests live in keeper/test/exit.test.ts (one task, one suite), and a
// @verify        filter that matches NO file passes by vacuum — the exact trap docs/STATUS.md B5
// @verify        records. `npm run test -- exit` runs them.
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { HashiEvent, WithdrawalStatus } from '../hashi/types.js';
import type { Millis, ObjectId, Sats, SuiAddress } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

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

/**
 * A withdrawal plus the two facts the cooldown arithmetic needs (delta (a)).
 *
 * `WithdrawalView` carries neither a creation time nor a requester, and both are load-bearing:
 * the cooldown is measured from `created_ms`, and the requester is the only address the upstream
 * `cancel_withdrawal` accepts. A `WithdrawalView` is still assignable here — it simply arrives
 * with both fields absent, which is treated as "cannot prove the cooldown elapsed" (invariant 4).
 */
export interface TrackedWithdrawal {
  readonly requestId: string;
  readonly status: WithdrawalStatus;
  readonly sats: Sats;
  /** `created_ms` — when `request_withdrawal` landed. The cooldown clock starts here. */
  readonly createdAtMs?: Millis;
  /** `WithdrawalRequested.requester_address`. The ONLY signer the upstream cancel accepts. */
  readonly requester?: SuiAddress;
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

/** The statuses `cancel_withdrawal` still accepts. Past these it aborts (docs/RECON.md R7.3). */
const PRE_COMMIT_STATUSES: readonly WithdrawalStatus[] = ['Requested', 'Approved'];

/**
 * Pre-commit status + cooldown elapsed. Mirrors the two on-chain asserts exactly.
 *
 * PURE (invariant 3). It does NOT mirror the third assert (`request.sender == ctx.sender()`) —
 * that one is about who SIGNS, and this module never signs.
 */
export function isReclaimable(
  view: TrackedWithdrawal,
  createdAtMs: Millis,
  nowMs: Millis,
  cooldownMs: Millis,
): boolean {
  return PRE_COMMIT_STATUSES.includes(view.status) && nowMs >= createdAtMs + cooldownMs;
}

/**
 * Detect stalls the keeper may SURFACE (never execute).
 *
 * PURE. Only pre-commit statuses (`Requested` | `Approved`) qualify; anything at
 * `PickedForProcessing` or beyond is committed and aborts on cancel.
 *
 * A withdrawal with no known `createdAtMs` is NOT reported: the cooldown cannot be proven
 * elapsed, and offering the depositor a PTB that aborts `ECooldownNotElapsed` would be worse than
 * saying nothing (invariant 4 — we never paper over an upstream abort).
 */
export function findStalledExits(
  withdrawals: readonly TrackedWithdrawal[],
  nowMs: Millis,
  cfg: Config,
): readonly StalledExit[] {
  const cooldownMs = cfg.hashi.cancellationCooldownMs;
  const out: StalledExit[] = [];

  for (const w of withdrawals) {
    const createdAtMs = w.createdAtMs;
    if (createdAtMs === undefined) continue;
    if (!isReclaimable(w, createdAtMs, nowMs, cooldownMs)) continue;
    out.push({
      requestId: w.requestId,
      sats: w.sats,
      requester: w.requester ?? '',
      stalledForMs: nowMs - createdAtMs,
      reclaimableAtMs: createdAtMs + cooldownMs,
    });
  }

  return out;
}

/**
 * Fold the public withdrawal stream into `TrackedWithdrawal`s (delta (b)).
 *
 * PURE and order-preserving. `createdAtMs` is the Sui event-envelope timestamp of
 * `WithdrawalRequested` — the same instant the on-chain `created_ms` records, and the one the
 * cooldown is measured from.
 */
export function trackWithdrawals(events: readonly HashiEvent[]): readonly TrackedWithdrawal[] {
  const byId = new Map<string, TrackedWithdrawal>();

  const patch = (requestId: string, next: Partial<TrackedWithdrawal>): void => {
    const prev = byId.get(requestId);
    const createdAtMs = next.createdAtMs ?? prev?.createdAtMs;
    const requester = next.requester ?? prev?.requester;
    byId.set(requestId, {
      requestId,
      status: next.status ?? prev?.status ?? 'Requested',
      sats: next.sats ?? prev?.sats ?? 0n,
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
      ...(requester === undefined ? {} : { requester }),
    });
  };

  for (const event of events) {
    switch (event.kind) {
      case 'WithdrawalRequested':
        patch(event.requestId, {
          status: 'Requested',
          sats: event.sats,
          createdAtMs: event.atMs,
          requester: event.requesterAddress,
        });
        break;
      case 'WithdrawalApproved':
        patch(event.requestId, { status: 'Approved' });
        break;
      case 'WithdrawalPickedForProcessing':
        for (const id of event.requestIds) patch(id, { status: 'PickedForProcessing' });
        break;
      case 'WithdrawalSigned':
        for (const id of event.requestIds) patch(id, { status: 'Signed' });
        break;
      case 'WithdrawalConfirmed':
        for (const id of event.requestIds) patch(id, { status: 'Confirmed' });
        break;
      case 'WithdrawalCancelled':
        patch(event.requestId, { status: 'Cancelled', sats: event.sats, requester: event.requesterAddress });
        break;
      default:
        break;
    }
  }

  return [...byId.values()];
}

/**
 * Build the UNSIGNED reclaim PTB for the depositor to sign.
 *
 * ⚠ Returning an unsigned `Transaction` is the point: if this module could sign, the keeper would
 * be able to move funds, and the non-custodial claim would be false (G2). The sender is set to the
 * depositor because `cancel_withdrawal` asserts `request.sender == ctx.sender()` — a keeper
 * signature over these very bytes would abort `EUnauthorizedCancellation` on chain, by design.
 */
export function buildReclaimTx(cfg: Config, req: ReclaimRequest): Transaction {
  assertPublished(cfg);
  if (req.depositor === '') {
    throw new AphoticError(
      'ReclaimNeedsDepositor',
      'a reclaim PTB has no sender but the depositor — the keeper can never sign it (E-K7)',
    );
  }

  const tx = new Transaction();
  // Invariant 2: the DEPOSITOR is the sender. Sponsored gas would be fine (sponsorship changes
  // who PAYS, not who the sender is), but the signature must be theirs.
  tx.setSender(req.depositor);
  tx.moveCall({
    target: `${cfg.aphotic.packageId}::gateway::reclaim_stalled_exit`,
    typeArguments: [cfg.deepbook.dbusdcCoinType],
    arguments: [
      tx.object(req.vaultId),
      tx.sharedObjectRef({
        objectId: cfg.hashi.objectId,
        initialSharedVersion: cfg.hashi.objectInitialSharedVersion,
        mutable: true,
      }),
      tx.pure.address(req.hashiRequestId),
      tx.pure.u128(req.bookMid),
      tx.object.clock(),
    ],
  });

  return tx;
}

// ─────────────────────────────────────────────────────────────────────────────

function assertPublished(cfg: Config): void {
  const missing: string[] = [];
  if (cfg.aphotic.packageId === '') missing.push('APHOTIC_PACKAGE_ID');
  if (cfg.hashi.objectId === '') missing.push('HASHI_OBJECT_ID');
  if (missing.length > 0) {
    throw new ConfigError(`cannot build a reclaim PTB without ${missing.join(', ')}`, missing);
  }
}
