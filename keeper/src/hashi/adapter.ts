// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §2 / §2.2 (THE adapter — centerpiece), §2.3 (REAL), §2.4 (MOCK)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.5 acceptance: the exact method surface)
// @spec       docs/RECON.md#r6 (live bridge config), #r7 (Move surface + cancel sender-binding)
// @rules      G2 G3 G5 G6 G7
// @depends    ./types.ts · ./limiter.ts · ../config.ts
// @facts      ONE interface, TWO implementations: `mock` (deterministic, default everywhere)
// @facts        and `real` (SDK + on-chain reads). Selected by HASHI_ADAPTER.
// @facts      Live bridge config (docs/RECON.md R6): deposit delay 600_000 ms · deposit min 30_000 ·
// @facts        withdrawal min 30_000 · confirmations 6 · cancel cooldown 3_600_000 ms · paused=false
// @facts      ⚠ ERRATUM vs docs/KEEPER.md §2.2, which flattens these as `viewBalance`/`limiterStatus`:
// @facts        this interface uses the NESTED `view.*` / `guardian.*` namespaces required by
// @facts        docs/BUILD-PLAN.md T0.5 (and matching the `@mysten/hashi` SDK shape).
// @implements export interface HashiAdapter
// @implements export interface BridgeConfig
// @implements export interface HashiViews / HashiGuardianViews
// @implements export type AdapterKind
// @forbidden  importing '@mysten/hashi' in this file or any implementation but hashi/real.ts (G7)
// @forbidden  wiring `requestWithdrawal`/`cancelWithdrawal` into the vault exit path (G2)
// @invariant  1. NOTHING outside hashi/ constructs a Hashi call; everything goes through here.
// @invariant  2. Every satoshi amount is `Sats` (bigint).
// @invariant  3. `guardian.limiterStatus()` is a HINT; the authority is the event replay (G5).
// @ac         docs/BUILD-PLAN.md T0.5 — the mock implements this surface with no network
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Millis, SuiAddress } from '../types.js';

import type { LimiterConfig } from './limiter.js';
import type {
  BtcAddress,
  DepositAddress,
  DepositView,
  EventCursor,
  HashiEvent,
  HashiEventKind,
  HashiEventOf,
  LimiterStatus,
  Sats,
  Utxo,
  WithdrawalView,
} from './types.js';

export type AdapterKind = 'mock' | 'real';

/** The bridge parameters an adapter is pinned to. Mirrors the live on-chain `Hashi` config. */
export interface BridgeConfig {
  readonly adapter: AdapterKind;
  readonly packageId: string;
  readonly objectId: string;
  readonly hbtcCoinType: string;
  readonly guardianUrl: string;
  /** `bitcoin_deposit_time_delay_ms` — the mandatory wait before `confirm_deposit`. */
  readonly depositTimeDelayMs: Millis;
  readonly depositMinimumSats: Sats;
  /** ⚠ `bitcoin_withdrawal_minimum()` is public(package) on-chain ⇒ this value is INJECTED. */
  readonly withdrawalMinimumSats: Sats;
  readonly confirmationThreshold: number;
  readonly cancellationCooldownMs: Millis;
  readonly dustFloorSats: Sats;
  readonly paused: boolean;
  /** The two limiter genesis scalars — the ONLY trust anchors of the G5 replay. */
  readonly limiter: LimiterConfig;
}

export interface WaitOptions {
  readonly timeoutMs?: Millis;
}

export interface EventsSinceOptions {
  readonly kinds?: readonly HashiEventKind[];
  readonly limit?: number;
}

export interface DepositArgs {
  readonly signer: Signer;
  readonly txid: string;
  readonly utxos: readonly Utxo[];
  /** Sui address the mint is bound to. Encoded in the UTXO derivation path — NOT keeper-chosen (G2). */
  readonly recipient: SuiAddress;
}

export interface RequestWithdrawalArgs {
  readonly sats: Sats;
  /** 20-byte P2WPKH or 32-byte P2TR witness program. */
  readonly bitcoinAddress: BtcAddress;
  readonly signer: Signer;
}

/** Read-only views. */
export interface HashiViews {
  /** hBTC balance of a Sui address, in sats. */
  balance(suiAddress: SuiAddress): Promise<Sats>;
  depositStatus(requestId: string): Promise<DepositView>;
  withdrawalStatus(requestId: string): Promise<WithdrawalView>;
  all(suiAddress: SuiAddress): Promise<{ deposits: readonly DepositView[]; withdrawals: readonly WithdrawalView[] }>;
}

/** Guardian limiter surface. */
export interface HashiGuardianViews {
  /**
   * ⚠⚠ UNVERIFIED HINT — NOT the source of truth (G5).
   *
   * On the REAL adapter this is an off-chain guardian/SDK read. The AUTHORITATIVE limiter is
   * `verify.deriveLimiter()`, which replays `projectCapacity` over the on-chain
   * `WithdrawalRequested / PickedForProcessing / Signed` stream. The `run` loop feeds the
   * REPLAY into `strategy.evaluate()` and the journal; this method is at most a sanity check.
   * Its `source` field says which you are holding.
   */
  limiterStatus(): Promise<LimiterStatus>;

  /**
   * Pre-exit UX check only.
   *
   * ⚠ G3: you CANNOT buy priority in Hashi's global withdrawal queue. An over-capacity batch is
   * REJECTED (`RateLimitExceeded`), not queued. `false` here means "do not submit yet"; it never
   * means "you have a slot".
   */
  canWithdraw(sats: Sats): Promise<boolean>;
}

/**
 * THE single choke point for every Hashi touchpoint (G7).
 *
 * Nothing outside `keeper/src/hashi/` may import `@mysten/hashi` or reference a `hashi::` Move
 * function; on-chain Hashi calls are confined to `move/sources/gateway.move`.
 */
export interface HashiAdapter {
  /** Which implementation this is. */
  readonly kind: AdapterKind;

  /** The bridge parameters in force (live read for `real`, seeded constants for `mock`). */
  bridgeConfig(): Promise<BridgeConfig>;

  // ── onboarding (client-side P2TR derivation; no server) ────────────────────
  generateDepositAddress(suiAddress: SuiAddress): Promise<DepositAddress>;

  // ── deposit registration + the PERMISSIONLESS crank ────────────────────────
  deposit(args: DepositArgs): Promise<{ requestId: string }>;

  /**
   * The permissionless `confirm_deposit` entry — a public good the keeper cranks for EVERYONE,
   * not just vault users. It mints `Coin<BTC>` to the recipient encoded in the UTXO derivation
   * path, so the keeper cannot redirect it (G2). Aborts on-chain if called before
   * `approval + bitcoin_deposit_time_delay_ms`.
   */
  confirmDeposit(requestId: string, signer: Signer): Promise<{ digest: string }>;

  // ── withdrawal: UX / MOCK SURFACE ONLY ─────────────────────────────────────
  /**
   * ⚠⚠ NOT the production exit path (G2).
   *
   * The vault's exit is composed in Move: `gateway::exit_to_bitcoin` burns shares, splits
   * `Balance<BTC>` and calls `hashi::withdraw::request_withdrawal(..., PINNED_ADDR, ...)` where
   * the destination is read from the Vault — the keeper NEVER passes a Bitcoin address.
   * This method exists only for the app/UX simulation and the deterministic mock. Do not wire
   * it into `run`/`exit`.
   */
  requestWithdrawal(args: RequestWithdrawalArgs): Promise<{ requestId: string }>;

  /**
   * ⚠⚠ Also UX/mock surface only, and DEPOSITOR-CALLABLE ONLY.
   *
   * `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()`
   * (docs/RECON.md R7.3) ⇒ the KEEPER CAN NEVER CALL IT. The production path is
   * `gateway::reclaim_stalled_exit`, invoked by the depositor. Pre-commit states only,
   * after the 1 h `withdrawal_cancellation_cooldown_ms`.
   */
  cancelWithdrawal(requestId: string, signer: Signer): Promise<{ sats: Sats }>;

  // ── views ──────────────────────────────────────────────────────────────────
  readonly view: HashiViews;
  readonly guardian: HashiGuardianViews;

  // ── waiters ────────────────────────────────────────────────────────────────
  /**
   * ⚠ G6: deposit is ~70 min end-to-end and is NEVER live-demoable. Pre-stage confirmed
   * deposits; the demo shows the fast, real `confirm_deposit` crank and an EARLIER signet tx.
   * The MOCK satisfies this on a LOGICAL clock and never sleeps.
   */
  waitForDeposit(requestId: string, opts?: WaitOptions): Promise<DepositView>;

  /** ⚠ G6: withdrawal is ~1.5–2 h end-to-end. Same rule as {@link waitForDeposit}. */
  waitForWithdrawal(requestId: string, opts?: WaitOptions): Promise<WithdrawalView>;

  // ── event stream (drives the peg-flow signal AND the G5 replay) ─────────────
  eventsSince(
    cursor: EventCursor,
    opts?: EventsSinceOptions,
  ): Promise<{ events: readonly HashiEvent[]; next: EventCursor }>;

  /**
   * The `WithdrawalSigned` sub-stream — the ONLY events that advance the Guardian bucket.
   * `verify.deriveLimiter()` consumes exactly this (G5).
   */
  signedEventsSince(
    cursor: EventCursor,
  ): Promise<{ events: readonly HashiEventOf<'WithdrawalSigned'>[]; next: EventCursor }>;
}
