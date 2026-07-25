// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §5.4 (exit — the pinned-destination burn→withdraw), §1.2 (`exit` cmd)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.5) · CUT LINE item 3 (the LIVE exit PTB)
// @spec       docs/MOVE-PACKAGE.md §6.2 (`gateway::exit_to_bitcoin`) · docs/FACTS.md#hashi-move-api
// @rules      G1 G2 G3 G6 G7 G8
// @depends    ../hashi/adapter.ts (T0.5) · ../config.ts · ../sui/client.ts · aphotic::gateway (T1.3)
// @facts      ★★ THE KEEPER NEVER PASSES A BITCOIN DESTINATION. THIS IS THE WHOLE THESIS (G2).
// @facts        public fun aphotic::gateway::exit_to_bitcoin(vault: &mut Vault, hashi: &mut Hashi,
// @facts            shares_to_burn: u64, book_mid: u128, params: &mut EnvelopeParams,
// @facts            clock: &Clock, ctx: &mut TxContext)
// @facts        Move reads the destination from the vault's write-once per-depositor record and
// @facts        composes hashi::withdraw::request_withdrawal inside the SAME PTB. A fully
// @facts        compromised keeper can neither steal nor redirect (docs/KEEPER.md §11).
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 (cfg.hashi.withdrawalMinimumSats). Below it the
// @facts        Move side POOLS the amount per-user instead of submitting (G3 small-exit pooling)
// @facts        and emits ExitPooled — so a successful PTB may yield NO Hashi request id.
// @facts      Destination byte lengths: 20 (P2WPKH) | 32 (P2TR). Validated on-chain at REGISTRATION
// @facts        (gateway::register_exit_address), not here.
// @facts      G1: burn → split → request_withdrawal is INSTANT on Sui (one checkpoint). The
// @facts        ~1.5–2 h latency is entirely INSIDE Hashi, after this PTB returns.
// @facts      G6: never live-demo the settlement. Surface the request id instantly; display an
// @facts        EARLIER, already-confirmed signet txid from a pre-broadcast exit.
// @facts      G3: an over-capacity batch is REJECTED (`RateLimitExceeded`), never queued — you
// @facts        cannot buy priority. Ration our OWN egress rate; that is all we control.
// @facts      PTB shared inputs: Vault (cfg.aphotic.vaultId), Hashi (cfg.hashi.objectId /
// @facts        initialSharedVersion cfg.hashi.objectInitialSharedVersion), Clock 0x6.
// @implements export interface ExitDeps / ExitRequest / ExitResult
// @implements export function buildExitTx(cfg: Config, req: ExitRequest): Transaction
// @implements export async function exit(deps: ExitDeps, req: ExitRequest): Promise<ExitResult>
// @implements export async function trackExit(deps: ExitDeps, requestId: string, opts?: TrackOptions): Promise<WithdrawalView>
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  a bitcoin-destination PARAMETER on any function in this file — G2, gates.ps1 g2
// @forbidden  calling adapter.requestWithdrawal from the vault exit path — that is UX/mock surface only
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. The PTB contains exactly ONE moveCall: `<aphotic>::gateway::exit_to_bitcoin`.
// @invariant  2. NO argument of that call is a Bitcoin destination — Move reads the pinned one.
// @invariant  3. A sub-minimum exit resolves to `pooled: true` with no Hashi request id, never an error.
// @invariant  4. `trackExit` NEVER blocks the demo path (G6) — it is polled out-of-band.
// @ac         docs/KEEPER.md §13 A6 — grep proves no keeper-chosen destination exists anywhere
// @ac         docs/BUILD-PLAN.md T2.5 — builds the gateway PTB, surfaces the signet txid
// @verify     npm run test -- exit
// @verify     powershell -NoProfile -File scripts/gates.ps1 g2
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { HashiAdapter } from '../hashi/index.js';
import type { WithdrawalView } from '../hashi/types.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis, ObjectId, Sats } from '../types.js';

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

/**
 * Build the one-PTB exit. The destination is NOT an input — `gateway::exit_to_bitcoin` reads the
 * write-once address pinned on-chain at the depositor's first deposit (G2).
 */
// TODO(T2.5): one moveCall `${cfg.aphotic.packageId}::gateway::exit_to_bitcoin` with
//             [vault, hashi(shared,mut), pure u64 sharesToBurn, pure u128 bookMid, envelopeParams, clock].
//             NO destination argument. Assert exactly one moveCall before returning.
export function buildExitTx(_cfg: Config, _req: ExitRequest): Transaction {
  throw new Error('TODO(T2.5): buildExitTx not implemented');
}

/**
 * Execute the exit. Instant on Sui (G1); everything slow happens inside Hashi afterwards (G6).
 */
// TODO(T2.5): build + sign + execute; parse ExitRequested / ExitPooled from the effects to decide
//             `pooled`; join the Hashi WithdrawalRequested event for the request id.
export async function exit(_deps: ExitDeps, _req: ExitRequest): Promise<ExitResult> {
  throw new Error('TODO(T2.5): exit not implemented');
}

/**
 * Follow a submitted exit to a terminal state and surface the signet txid.
 *
 * ⚠ G6: ~1.5–2 h end-to-end. NEVER put this on the demo critical path — the demo shows an
 * earlier, already-confirmed signet transaction.
 */
// TODO(T2.5): drive deps.hashi.waitForWithdrawal(requestId, { timeoutMs }) and surface signetTxid.
export async function trackExit(
  _deps: ExitDeps,
  _requestId: string,
  _opts: TrackOptions = {},
): Promise<WithdrawalView> {
  throw new Error('TODO(T2.5): trackExit not implemented');
}
