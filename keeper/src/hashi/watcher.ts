// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.2
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §1.2 (`run` loop: `hashi.eventsSince(cursor)`), §2.2 (event stream),
//             §3.1 (pendingMint/pendingBurn inputs), §9.2 (the Signed sub-stream feeds the replay)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.2 event watcher)
// @spec       docs/RECON.md#r8 · docs/FACTS.md#events (REAL struct names + normalization rules)
// @rules      G1 G3 G5 G7
// @depends    ./adapter.ts (T0.5) · ./types.ts (T0.5) · ./normalize.ts (T0.5) · ../types.ts
// @facts      The watcher NEVER talks to the chain itself — it drives `HashiAdapter.eventsSince`,
// @facts        so `mock` and `real` produce the SAME normalized log (G7).
// @facts      ⚠ ERRATUM vs docs/BUILD-PLAN.md T2.2, which names "six families … `utxo_pool::UtxoSpent`":
// @facts        there is NO `utxo_pool` event family (docs/RECON.md R8, docs/FACTS.md#events).
// @facts        The real families are THREE: `treasury` (Minted/Burned), `deposit` (4), `withdrawal_queue` (8).
// @facts        `HASHI_EVENT_KINDS` (./types.ts) is the authoritative 14-kind list.
// @facts      ⚠ `treasury::Minted<T>`/`Burned<T>` are GENERIC — a filter must include the type
// @facts        argument `<pkg>::btc::BTC` or it matches nothing (docs/FACTS.md#events rule 3).
// @facts      Flow signal (docs/KEEPER.md §3.1 / docs/FACTS.md#events):
// @facts        pendingMintSats = Σ DepositApproved.sats − Σ DepositConfirmed.sats  (mint is telegraphed
// @facts          ~10 min before it lands — this is the PUBLIC half of the peg-flow signal, G8)
// @facts        pendingBurnSats = Σ WithdrawalRequested.sats − Σ (WithdrawalConfirmed | WithdrawalCancelled)
// @facts        queueDepthSats  = Σ Requested − Σ (Signed | Cancelled)   (docs/KEEPER.md §9.2)
// @facts      `EventCursor.seq` is the EVENT-LOG cursor, NOT the limiter's `next_seq` — never conflate.
// @implements export const WATCHED_EVENT_KINDS: readonly HashiEventKind[]
// @implements export const FLOW_STATE_ZERO: FlowState
// @implements export interface WatcherOptions / FlowState / Watcher
// @implements export function applyFlow(prev: FlowState, events: readonly HashiEvent[], atMs: Millis): FlowState
// @implements export function createWatcher(adapter: HashiAdapter, opts?: WatcherOptions): Watcher
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — the adapter owns transport (gates.ps1 transport)
// @forbidden  `number` for sats — all money is bigint
// @forbidden  assuming strict FIFO in the queue: ordering is leader-discretionary (G3)
// @invariant  1. `applyFlow` is PURE: same (prev, events) ⇒ same FlowState. No clock read inside.
// @invariant  2. The cursor only ever moves forward; a re-poll from the same cursor is idempotent.
// @invariant  3. Under the MOCK the whole log is byte-identical across runs (seeded, logical clock).
// @invariant  4. Counters never go negative — a Confirmed with no matching Requested clamps at 0n.
// @ac         docs/BUILD-PLAN.md T2.2 — normalized log, deterministic under the mock
// @verify     npm run test -- watcher
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Millis, Sats } from '../types.js';

import type { HashiAdapter } from './adapter.js';
import {
  HASHI_EVENT_KINDS,
  type EventCursor,
  type HashiEvent,
  type HashiEventKind,
  type HashiEventOf,
} from './types.js';

/**
 * Every kind the watcher subscribes to — the authoritative 14 (docs/RECON.md R8).
 * NOT six, and there is no `utxo_pool::UtxoSpent` (see the @facts ERRATUM above).
 */
export const WATCHED_EVENT_KINDS: readonly HashiEventKind[] = HASHI_EVENT_KINDS;

export interface WatcherOptions {
  /** Restrict the subscription. Default: {@link WATCHED_EVENT_KINDS}. */
  readonly kinds?: readonly HashiEventKind[];
  /** Max events per `poll()`. */
  readonly batchLimit?: number;
  /** Resume point. Default `EVENT_CURSOR_GENESIS`. */
  readonly startCursor?: EventCursor;
  /** Keep the full normalized log in memory (needed by `verify/`); default true. */
  readonly retainLog?: boolean;
}

/**
 * The public, pre-book flow signal (G8: the SIGNAL is public, the RESPONSE stays Seal-encrypted).
 * Fed into `strategy.evaluate()` as `pendingMint` / `pendingBurn`.
 */
export interface FlowState {
  /** Σ approved-but-not-yet-minted deposits. Telegraphs supply +. */
  readonly pendingMintSats: Sats;
  /** Σ requested-but-not-yet-settled withdrawals. Telegraphs supply −. */
  readonly pendingBurnSats: Sats;
  /** Σ Requested − Σ (Signed | Cancelled) — the GLOBAL queue depth (docs/KEEPER.md §9.2). */
  readonly queueDepthSats: Sats;
  /** Event-envelope ms of the last event folded in. */
  readonly atMs: Millis;
}

/** Empty accumulator. `applyFlow(FLOW_STATE_ZERO, wholeLog)` reconstructs any point in the stream. */
export const FLOW_STATE_ZERO: FlowState = Object.freeze({
  pendingMintSats: 0n,
  pendingBurnSats: 0n,
  queueDepthSats: 0n,
  atMs: 0,
});

export interface Watcher {
  /** Next event-log index to read (inclusive). */
  readonly cursor: EventCursor;
  /** Pull the next batch and fold it into the flow state. Advances the cursor. */
  poll(): Promise<readonly HashiEvent[]>;
  /** The retained normalized log, seq-ordered. Empty when `retainLog` is false. */
  log(): readonly HashiEvent[];
  /** Current flow accumulator. */
  flow(): FlowState;
  /**
   * The `WithdrawalSigned` sub-stream — the ONLY events that advance the Guardian bucket.
   * `verify.deriveLimiter()` consumes exactly this (G5).
   */
  signedSince(
    cursor: EventCursor,
  ): Promise<{ events: readonly HashiEventOf<'WithdrawalSigned'>[]; next: EventCursor }>;
}

/**
 * Fold a batch of normalized events into the flow accumulator.
 *
 * PURE — no clock, no I/O. `atMs` is supplied by the caller (the last event's envelope
 * timestamp) so a replay reproduces the same state at the same boundary.
 */
// TODO(T2.2): fold Deposit{Approved,Confirmed} + Withdrawal{Requested,Signed,Confirmed,Cancelled};
//             clamp every counter at 0n; never assume strict FIFO ordering (G3).
export function applyFlow(_prev: FlowState, _events: readonly HashiEvent[], _atMs: Millis): FlowState {
  throw new Error('TODO(T2.2): applyFlow not implemented');
}

/**
 * Build the event watcher over an adapter (mock or real — identical behaviour, G7).
 */
// TODO(T2.2): cursor bookkeeping, batch polling via adapter.eventsSince, log retention,
//             flow accumulation via applyFlow, signedSince passthrough to adapter.signedEventsSince.
export function createWatcher(_adapter: HashiAdapter, _opts: WatcherOptions = {}): Watcher {
  throw new Error('TODO(T2.2): createWatcher not implemented');
}
