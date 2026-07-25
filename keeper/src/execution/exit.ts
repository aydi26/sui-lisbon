// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.4 (exit — the pinned-destination burn→withdraw), §1.2 (`exit` cmd)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.5) · CUT LINE item 3 (the LIVE exit PTB)
// @spec       docs/MOVE-PACKAGE.md §6.2 (`gateway::exit_to_bitcoin`) · docs/FACTS.md#hashi-move-api
// @rules      G1 G2 G3 G6 G7 G8
// @depends    ../hashi/adapter.ts (T0.5) · ../config.ts · ../sui/client.ts · aphotic::gateway (T1.3)
// @facts      ★★ THE KEEPER NEVER PASSES A BITCOIN DESTINATION. THIS IS THE WHOLE THESIS (G2).
// @facts        VERBATIM from move/sources/gateway.move (T1.3/T1.4, DONE):
// @facts        public fun aphotic::gateway::exit_to_bitcoin<Q>(vault: &mut Vault<BTC, Q>,
// @facts            hashi: &mut Hashi, shares_to_burn: u64, book_mid: u128,
// @facts            clock: &Clock, ctx: &mut TxContext)
// @facts        ⚠ ERRATUM vs the skeleton banner, which listed a `params: &mut EnvelopeParams`
// @facts        argument: the shipped Move function has NO such parameter — the envelope lives
// @facts        INSIDE the Vault (`vault.envelope`), and `envelope` is the intra-package LEAF.
// @facts        The Move source wins. ONE type argument (Q); B is pinned to the bridge coin.
// @facts        Move reads the destination from the vault's write-once per-depositor record and
// @facts        composes the bridge withdrawal inside the SAME PTB. A fully compromised keeper can
// @facts        neither steal nor redirect (docs/KEEPER.md §11).
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 (cfg.hashi.withdrawalMinimumSats). Below it the
// @facts        Move side POOLS the amount per-user instead of submitting (G3 small-exit pooling)
// @facts        and emits ExitPooled — so a successful PTB may yield NO Hashi request id.
// @facts      Vault-side receipts, decoded from event BCS (docs/MOVE-PACKAGE.md §6.5):
// @facts        gateway::ExitRequested { vault_id: ID, who: address, amount_sats: u64, addr_len: u64 }
// @facts        gateway::ExitPooled { vault_id: ID, who: address, amount_sats: u64,
// @facts                              pooled_total_sats: u64 }
// @facts      Destination byte lengths: 20 (P2WPKH) | 32 (P2TR). Validated on-chain at REGISTRATION
// @facts        (gateway::register_exit_address), not here.
// @facts      G1: burn → split → the bridge request is INSTANT on Sui (one checkpoint). The
// @facts        ~1.5–2 h latency is entirely INSIDE the bridge, after this PTB returns.
// @facts      G6: never live-demo the settlement. Surface the request id instantly; display an
// @facts        EARLIER, already-confirmed signet txid from a pre-broadcast exit.
// @facts      G3: an over-capacity batch is REJECTED (`RateLimitExceeded`), never queued — you
// @facts        cannot buy priority. Ration our OWN egress rate; that is all we control.
// @facts      PTB shared inputs: Vault (cfg.aphotic.vaultId), Hashi (cfg.hashi.objectId /
// @facts        initialSharedVersion cfg.hashi.objectInitialSharedVersion), Clock 0x6.
// @implements export interface ExitDeps / ExitRequest / ExitResult / TrackOptions
// @implements export function buildExitTx(cfg: Config, req: ExitRequest): Transaction
// @implements export async function exit(deps: ExitDeps, req: ExitRequest): Promise<ExitResult>
// @implements export async function trackExit(deps: ExitDeps, requestId: string, opts?: TrackOptions): Promise<WithdrawalView>
// @implements ⚠ DELTAS vs the skeleton banner, all additive and deliberate:
// @implements   (a) export function assertNoPinnedDestinationArgument(tx) — the STRUCTURAL proof of
// @implements       invariant 2: it walks the built PTB's pure inputs and rejects any 20/32-byte
// @implements       witness program. The G2 claim becomes a machine check, not a comment.
// @implements   (b) export const ExitRequestedEvent / ExitPooledEvent + decodeExitReceipt().
// @implements   (c) ExitRequest gains `who?` — the depositor whose receipt to match when a PTB
// @implements       carries more than one. Defaults to the signer.
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  a bitcoin-destination PARAMETER on any function in this file — G2, gates.ps1 g2
// @forbidden  calling adapter.requestWithdrawal from the vault exit path — that is UX/mock surface only
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. The PTB contains exactly ONE moveCall: `<aphotic>::gateway::exit_to_bitcoin`.
// @invariant  2. NO argument of that call is a Bitcoin destination — Move reads the pinned one.
//                Enforced structurally by `assertNoPinnedDestinationArgument`, not by convention.
// @invariant  3. A sub-minimum exit resolves to `pooled: true` with no Hashi request id, never an error.
// @invariant  4. `trackExit` NEVER blocks the demo path (G6) — it is polled out-of-band.
// @ac         docs/KEEPER.md §13 A6 — grep proves no keeper-chosen destination exists anywhere
// @ac         docs/BUILD-PLAN.md T2.5 — builds the gateway PTB, surfaces the signet txid
// @verify     npm run test -- exit
// @verify     powershell -NoProfile -File scripts/gates.ps1 g2
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';

import type { Config } from '../config.js';
import type { HashiAdapter } from '../hashi/index.js';
import { EVENT_CURSOR_GENESIS, type EventCursor, type WithdrawalView } from '../hashi/types.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis, ObjectId, Sats, SuiAddress } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

export interface ExitDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  readonly hashi: HashiAdapter;
  /**
   * Signs the exit PTB. In production this is the DEPOSITOR's zkLogin session (they own the
   * shares). The keeper may also trigger it — it still cannot choose where the BTC goes (G2).
   */
  readonly signer: Signer;
}

export interface ExitRequest {
  readonly vaultId: ObjectId;
  /** Shares to burn (sats-denominated ledger). */
  readonly sharesToBurn: Sats;
  /** DeepBook mid for the NAV conversion (G9) — from routing/book.ts, never raw Pyth. */
  readonly bookMid: bigint;
  /** Whose receipt to match in the effects (delta (c)). Defaults to the signer's address. */
  readonly who?: SuiAddress;
}

export interface ExitResult {
  readonly digest: Digest;
  /** Sats the burned shares resolved to. */
  readonly sats: Sats;
  /**
   * `true` ⇒ below the 30_000-sat Hashi minimum, so Move pooled it per-user (G3) and no
   * Hashi withdrawal exists yet. `false` ⇒ a Hashi `WithdrawalRequested` was emitted.
   */
  readonly pooled: boolean;
  /** Hashi withdrawal request id. Absent when `pooled`. */
  readonly requestId?: string;
}

export interface TrackOptions {
  /** Poll budget. Default cfg.hashi.waitTimeoutMs (generous — G6, never on the demo path). */
  readonly timeoutMs?: Millis;
}

// ── vault-side receipts (G10) ────────────────────────────────────────────────

export const ExitRequestedEvent = bcs.struct('ExitRequested', {
  vault_id: bcs.Address,
  who: bcs.Address,
  amount_sats: bcs.u64(),
  addr_len: bcs.u64(),
});

export const ExitPooledEvent = bcs.struct('ExitPooled', {
  vault_id: bcs.Address,
  who: bcs.Address,
  amount_sats: bcs.u64(),
  pooled_total_sats: bcs.u64(),
});

/** Minimal event shape both transports return (`SuiClientTypes.Event`). */
export interface ExitEvent {
  readonly eventType: string;
  readonly bcs: Uint8Array;
  readonly json?: Record<string, unknown> | null;
}

/** What the vault-side receipts say happened. */
export interface ExitReceipt {
  readonly pooled: boolean;
  readonly sats: Sats;
}

interface ExecutedShape {
  readonly digest: string;
  readonly events?: readonly ExitEvent[] | undefined;
}

/** The execution surface both transports expose on `.core` (no client is constructed here). */
interface ExecutionCore {
  signAndExecuteTransaction(input: {
    transaction: Transaction;
    signer: Signer;
    include: { events: true };
  }): Promise<{
    readonly $kind: 'Transaction' | 'FailedTransaction';
    readonly Transaction?: ExecutedShape;
    readonly FailedTransaction?: ExecutedShape;
  }>;
}

/** Witness-program byte lengths the bridge accepts (docs/RECON.md R7). */
const WITNESS_PROGRAM_LENGTHS = [20, 32] as const;

/** Bound on the post-exit event join. */
const MAX_JOIN_ROUNDS = 1_000;

/**
 * Build the one-PTB exit. The destination is NOT an input — `gateway::exit_to_bitcoin` reads the
 * write-once address pinned on-chain at the depositor's first deposit (G2).
 *
 * Five arguments, none of which is a destination: the Vault, the bridge shared object, the share
 * count, the DeepBook mid and the Clock. That absence IS the non-custodial claim, so it is
 * asserted structurally before the transaction leaves this function (invariant 2).
 */
export function buildExitTx(cfg: Config, req: ExitRequest): Transaction {
  assertPublished(cfg);
  if (req.sharesToBurn <= 0n) {
    throw new AphoticError('ZeroExit', `sharesToBurn must be > 0, got ${req.sharesToBurn}`);
  }

  const tx = new Transaction();
  tx.moveCall({
    // ONE type argument: the Move signature is exit_to_bitcoin<Q>(vault: &mut Vault<BTC, Q>, ...),
    // i.e. the base asset is already pinned to the bridge coin inside gateway.move (G7).
    target: `${cfg.aphotic.packageId}::gateway::exit_to_bitcoin`,
    typeArguments: [cfg.deepbook.dbusdcCoinType],
    arguments: [
      tx.object(req.vaultId),
      tx.sharedObjectRef({
        objectId: cfg.hashi.objectId,
        initialSharedVersion: cfg.hashi.objectInitialSharedVersion,
        mutable: true,
      }),
      tx.pure.u64(req.sharesToBurn),
      tx.pure.u128(req.bookMid),
      tx.object.clock(),
    ],
  });

  assertSingleGatewayCall(cfg, tx);
  assertNoPinnedDestinationArgument(tx);
  return tx;
}

/**
 * ★ THE G2 CHECK, MECHANISED.
 *
 * Walks every pure input of the built PTB and rejects anything that could be a Bitcoin witness
 * program (a BCS `vector<u8>` of 20 or 32 bytes). If a destination ever reappeared as an argument
 * — through a refactor, a merge, or a compromised builder — this throws before the transaction
 * can be signed. Convention is not a guarantee; this is (invariant 2).
 */
export function assertNoPinnedDestinationArgument(tx: Transaction): void {
  for (const input of tx.getData().inputs) {
    if (input.$kind === 'UnresolvedPure') {
      const value = input.UnresolvedPure.value;
      if (Array.isArray(value) && (WITNESS_PROGRAM_LENGTHS as readonly number[]).includes(value.length)) {
        throw new AphoticError(
          'DestinationArgumentForbidden',
          `the exit PTB carries a ${value.length}-byte vector argument — the destination is READ FROM THE VAULT, never passed (G2)`,
        );
      }
      continue;
    }
    if (input.$kind !== 'Pure') continue;

    const bytes = fromBase64(input.Pure.bytes);
    for (const len of WITNESS_PROGRAM_LENGTHS) {
      // BCS `vector<u8>` of length n < 128 is one ULEB byte (n) followed by n bytes.
      if (bytes.length === len + 1 && bytes[0] === len) {
        throw new AphoticError(
          'DestinationArgumentForbidden',
          `the exit PTB carries a ${len}-byte witness program argument — the destination is READ FROM THE VAULT, never passed (G2)`,
        );
      }
    }
  }
}

/**
 * Execute the exit. Instant on Sui (G1); everything slow happens inside the bridge afterwards (G6).
 *
 * The vault-side receipt decides `pooled`: `ExitPooled` means the proceeds were below the 30 000-sat
 * bridge minimum and Move earmarked them per-user instead of submitting (G3 — the bridge REJECTS
 * sub-minimum amounts, it does not queue them). That is a SUCCESS, not an error (invariant 3).
 */
export async function exit(deps: ExitDeps, req: ExitRequest): Promise<ExitResult> {
  const tx = buildExitTx(deps.cfg, req);
  const who = req.who ?? deps.signer.toSuiAddress();

  // Captured BEFORE execution so the request-id join can never pick up an older withdrawal.
  const resumeCursor = await endCursor(deps.hashi);

  const core = deps.client.core as unknown as ExecutionCore;
  const result = await core.signAndExecuteTransaction({
    transaction: tx,
    signer: deps.signer,
    include: { events: true },
  });

  const executed = result.Transaction ?? result.FailedTransaction;
  if (executed === undefined) {
    throw new AphoticError('ExitExecutionFailed', 'signAndExecuteTransaction returned no transaction');
  }
  if (result.$kind === 'FailedTransaction') {
    throw new AphoticError('ExitExecutionFailed', `exit PTB failed on chain (digest ${executed.digest})`);
  }

  const events = executed.events ?? [];
  const receipt = decodeExitReceipt(events, who);
  if (receipt === undefined) {
    throw new AphoticError(
      'ExitReceiptMissing',
      `exit ${executed.digest} emitted neither ExitRequested nor ExitPooled for ${who}`,
    );
  }

  if (receipt.pooled) {
    // G3: pooled, so there is no bridge request id to surface — and there must not be one.
    return { digest: executed.digest, sats: receipt.sats, pooled: true };
  }

  const requestId = requestIdFromEvents(events) ?? (await joinRequestId(deps, resumeCursor, who, receipt.sats));
  return {
    digest: executed.digest,
    sats: receipt.sats,
    pooled: false,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * Decode the vault-side receipt of an exit.
 *
 * Matched on the `::gateway::<Struct>` suffix rather than the full type: the `packageId` an event
 * carries is the ORIGINAL package id, which diverges from `cfg.aphotic.packageId` the first time
 * the package is upgraded. The module path is the stable part.
 */
export function decodeExitReceipt(events: readonly ExitEvent[], who: SuiAddress): ExitReceipt | undefined {
  for (const event of events) {
    if (event.eventType.endsWith('::gateway::ExitPooled')) {
      const parsed = ExitPooledEvent.parse(event.bcs);
      if (!sameAddress(parsed.who, who)) continue;
      return { pooled: true, sats: BigInt(parsed.amount_sats) };
    }
    if (event.eventType.endsWith('::gateway::ExitRequested')) {
      const parsed = ExitRequestedEvent.parse(event.bcs);
      if (!sameAddress(parsed.who, who)) continue;
      return { pooled: false, sats: BigInt(parsed.amount_sats) };
    }
  }
  return undefined;
}

/**
 * Follow a submitted exit to a terminal state and surface the signet txid.
 *
 * ⚠ G6: ~1.5–2 h end-to-end. NEVER put this on the demo critical path — the demo shows an
 * earlier, already-confirmed signet transaction. The default budget is deliberately generous
 * (`cfg.hashi.waitTimeoutMs`, 2.5 h) because the honest thing to do is wait, not to pretend.
 */
export async function trackExit(
  deps: ExitDeps,
  requestId: string,
  opts: TrackOptions = {},
): Promise<WithdrawalView> {
  const timeoutMs = opts.timeoutMs ?? deps.cfg.hashi.waitTimeoutMs;
  return await deps.hashi.waitForWithdrawal(requestId, { timeoutMs });
}

/** The signet txid of a settled exit, once the bridge broadcast it. `undefined` before that. */
export function signetTxidOf(view: WithdrawalView): string | undefined {
  return view.signetTxid;
}

// ─────────────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly ONE moveCall, and it is the gateway exit (invariant 1). */
function assertSingleGatewayCall(cfg: Config, tx: Transaction): void {
  const commands = tx.getData().commands;
  const calls = commands.filter((command) => command.$kind === 'MoveCall');
  if (commands.length !== 1 || calls.length !== 1) {
    throw new AphoticError(
      'ExitPtbShape',
      `the exit PTB must contain exactly one command (the gateway call), found ${commands.length}`,
    );
  }
  const call = calls[0]?.MoveCall;
  if (call === undefined || call.package !== cfg.aphotic.packageId || call.module !== 'gateway' || call.function !== 'exit_to_bitcoin') {
    throw new AphoticError('ExitPtbShape', 'the exit PTB must call <aphotic>::gateway::exit_to_bitcoin');
  }
}

/** Where the public event stream currently ends — the resume point for the request-id join. */
async function endCursor(hashi: HashiAdapter): Promise<EventCursor> {
  let cursor: EventCursor = EVENT_CURSOR_GENESIS;
  for (let round = 0; round < MAX_JOIN_ROUNDS; round++) {
    const page = await hashi.eventsSince(cursor);
    if (page.next.seq <= cursor.seq) return cursor;
    cursor = page.next;
  }
  return cursor;
}

/**
 * Best-effort request id straight out of the PTB's own events.
 *
 * The bridge's `withdrawal_queue::WithdrawalRequested` struct layout is not pinned by our BCS
 * schemas, so this reads the JSON projection and tolerates its absence — the event-stream join
 * below is the reliable path.
 */
function requestIdFromEvents(events: readonly ExitEvent[]): string | undefined {
  for (const event of events) {
    if (!event.eventType.endsWith('::withdrawal_queue::WithdrawalRequested')) continue;
    const value = event.json?.['request_id'];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Join the bridge's own `WithdrawalRequested` stream for the id our PTB just produced.
 *
 * Scoped to events AFTER the pre-execution cursor and matched on (requester, sats), so a
 * concurrent exit by someone else can never be mistaken for ours.
 */
async function joinRequestId(
  deps: ExitDeps,
  from: EventCursor,
  who: SuiAddress,
  sats: Sats,
): Promise<string | undefined> {
  let cursor = from;
  for (let round = 0; round < MAX_JOIN_ROUNDS; round++) {
    const page = await deps.hashi.eventsSince(cursor, { kinds: ['WithdrawalRequested'] });
    for (const event of page.events) {
      if (event.kind !== 'WithdrawalRequested') continue;
      if (event.sats === sats && sameAddress(event.requesterAddress, who)) return event.requestId;
    }
    if (page.next.seq <= cursor.seq) return undefined;
    cursor = page.next;
  }
  return undefined;
}

function sameAddress(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}

function normalizeAddress(address: string): string {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  return `0x${hex.toLowerCase().padStart(64, '0')}`;
}

/** `gateway::exit_to_bitcoin` lives in the published `aphotic` package; without its id no target. */
function assertPublished(cfg: Config): void {
  const missing: string[] = [];
  if (cfg.aphotic.packageId === '') missing.push('APHOTIC_PACKAGE_ID');
  if (cfg.hashi.objectId === '') missing.push('HASHI_OBJECT_ID');
  if (missing.length > 0) {
    throw new ConfigError(`cannot build an exit PTB without ${missing.join(', ')}`, missing);
  }
}
