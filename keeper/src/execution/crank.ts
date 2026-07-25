// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.3
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §5.2 (`confirm_deposit` crank — the public good), §1.2 (`crank [--all]`)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.3) · CUT LINE item 1 (the LIVE on-screen crank)
// @spec       docs/FACTS.md#confirm-deposit · docs/RECON.md#r6 #r7
// @rules      G1 G2 G6 G7 G8
// @depends    ../hashi/adapter.ts (T0.5) · ../hashi/watcher.ts (T2.2) · ../config.ts · ../sui/client.ts
// @facts      ★ entry fun hashi::deposit::confirm_deposit(hashi: &mut Hashi, request_id: address,
// @facts        clock: &Clock, ctx: &mut TxContext)   — visibility=Private, isEntry=true.
// @facts        ⇒ callable from a PTB COMMAND only; NOT composable from Move (docs/FACTS.md E-M9).
// @facts        It must therefore never appear as a moveCall inside gateway.move (G7).
// @facts      PERMISSIONLESS: anyone may crank. The keeper cranks for EVERY pending deposit, not
// @facts        only vault users — that is the "public good" framing (docs/KEEPER.md §5.2).
// @facts      It mints Coin<BTC> to the recipient encoded in the UTXO DERIVATION PATH ⇒ the keeper
// @facts        cannot redirect the mint (G2). `treasury::Minted<T>` carries NO recipient field.
// @facts      Eligibility: status Approved AND now >= approvalTimestampMs + HASHI_DEPOSIT_TIME_DELAY_MS.
// @facts        HASHI_DEPOSIT_TIME_DELAY_MS = 600_000 (live on-chain, cfg.hashi.depositTimeDelayMs).
// @facts        Calling early ABORTS on-chain — gate off-chain, never spend gas on a known abort.
// @facts      PTB inputs: Hashi shared object (cfg.hashi.objectId, initialSharedVersion
// @facts        cfg.hashi.objectInitialSharedVersion) + Clock (0x6) + request_id as `address`.
// @facts      G6: the ~70 min deposit leg is NEVER live-demoable. The crank itself IS demoable —
// @facts        it is the one real, fast BTC-side state transition we show live (pre-staged deposits).
// @implements export interface CrankDeps / CrankOptions / CrankOutcome / CrankResult
// @implements export function selectCrankable(deposits: readonly DepositView[], nowMs: Millis, delayMs: Millis): readonly DepositView[]
// @implements export function buildConfirmDepositTx(cfg: Config, requestId: string): Transaction
// @implements export async function crank(deps: CrankDeps, opts?: CrankOptions): Promise<CrankResult>
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  a recipient argument of any kind — the mint destination is fixed in the derivation path (G2)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. IDEMPOTENT: cranking an already-Confirmed request is a no-op, never an error.
// @invariant  2. Never submits a request whose delay has not elapsed (would abort on-chain).
// @invariant  3. One PTB per request — a failed request never poisons the rest of the batch.
// @invariant  4. `selectCrankable` is PURE (nowMs is an argument, never read from a clock).
// @ac         docs/BUILD-PLAN.md T2.3 — idempotent; skips not-yet-eligible; runs for ALL users
// @verify     npm run test -- crank
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { DepositView } from '../hashi/types.js';
import type { HashiAdapter } from '../hashi/index.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis } from '../types.js';

export interface CrankDeps {
  readonly cfg: Config;
  readonly hashi: HashiAdapter;
  readonly client: AnySuiClient;
  /** Pays gas for the public-good crank. Holds no capability beyond the DeepBook TradeCap (G2). */
  readonly signer: Signer;
}

export interface CrankOptions {
  /** Crank every eligible pending deposit, not just this vault's users. Default: true. */
  readonly all?: boolean;
  /** Restrict to specific Hashi deposit request ids. */
  readonly requestIds?: readonly string[];
  /** Logical "now". Supplied by the caller so the selection stays replayable. */
  readonly nowMs: Millis;
  /** Cap the batch size for one invocation. */
  readonly limit?: number;
}

export type CrankStatus = 'confirmed' | 'skipped-not-eligible' | 'skipped-already-confirmed' | 'failed';

export interface CrankOutcome {
  readonly requestId: string;
  readonly status: CrankStatus;
  readonly digest?: Digest;
  /** Present for `skipped-not-eligible`: when the on-chain delay elapses. */
  readonly eligibleAtMs?: Millis;
  readonly reason?: string;
}

export interface CrankResult {
  readonly attempted: number;
  readonly outcomes: readonly CrankOutcome[];
}

/**
 * Which pending deposits may be cranked right now.
 *
 * PURE — `nowMs` and `delayMs` are arguments so `verify/` can reproduce the selection exactly.
 * A deposit is eligible iff `status === 'Approved'` and `nowMs >= confirmableAtMs`
 * (approval + `bitcoin_deposit_time_delay_ms`). Anything earlier aborts on-chain.
 */
// TODO(T2.3): filter by status Approved + confirmableAtMs; already-Confirmed and Expired drop out.
export function selectCrankable(
  _deposits: readonly DepositView[],
  _nowMs: Millis,
  _delayMs: Millis,
): readonly DepositView[] {
  throw new Error('TODO(T2.3): selectCrankable not implemented');
}

/**
 * One PTB containing exactly one command: the PERMISSIONLESS `confirm_deposit` entry.
 *
 * Not a `moveCall` into our package — `confirm_deposit` is an `entry` on the Hashi package and
 * cannot be composed from Move (docs/FACTS.md E-M9), so the PTB targets Hashi directly.
 */
// TODO(T2.3): tx.moveCall({ target: `${cfg.hashi.packageId}::deposit::confirm_deposit`,
//             arguments: [sharedObject(cfg.hashi.objectId, initialSharedVersion, mutable), pure address(requestId), object(SUI_CLOCK)] })
export function buildConfirmDepositTx(_cfg: Config, _requestId: string): Transaction {
  throw new Error('TODO(T2.3): buildConfirmDepositTx not implemented');
}

/**
 * Run the crank over every eligible pending deposit.
 *
 * Public good (docs/KEEPER.md §5.2): the keeper advances OTHER people's deposits too. It can do
 * this safely precisely because it cannot influence where the mint lands (G2).
 */
// TODO(T2.3): list pending deposits via deps.hashi.view/eventsSince, selectCrankable, then one
//             signed PTB per request; classify failures instead of throwing the batch away.
export async function crank(_deps: CrankDeps, _opts: CrankOptions): Promise<CrankResult> {
  throw new Error('TODO(T2.3): crank not implemented');
}
