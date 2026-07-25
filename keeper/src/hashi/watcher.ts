// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.2
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
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
// @facts        That instantiation lives in ./eventTypes.ts and is applied by the ADAPTER, not here.
// @facts      Flow signal (docs/KEEPER.md §3.1 / docs/FACTS.md#events):
// @facts        pendingMintSats = Σ DepositApproved.sats − Σ DepositConfirmed.sats  (mint is telegraphed
// @facts          ~10 min before it lands — this is the PUBLIC half of the peg-flow signal, G8)
// @facts        pendingBurnSats = Σ WithdrawalRequested.sats − Σ (WithdrawalConfirmed | WithdrawalCancelled)
// @facts        queueDepthSats  = Σ Requested − Σ (Signed | Cancelled)   (docs/KEEPER.md §9.2)
// @facts      ⚠ `WithdrawalConfirmed` carries `request_ids` but NO amount (docs/RECON.md R8), so
// @facts        its burn credit is JOINED from the `WithdrawalRequested` events in the same fold.
// @facts        `WithdrawalCancelled` and `WithdrawalSigned` DO carry sats (the latter synthesised
// @facts        by ./normalize.ts) — only Confirmed needs the join.
// @facts      `EventCursor.seq` is the EVENT-LOG cursor, NOT the limiter's `next_seq` — never conflate.
// @implements export const WATCHED_EVENT_KINDS: readonly HashiEventKind[]
// @implements export const FLOW_STATE_ZERO: FlowState
// @implements export interface WatcherOptions / FlowState / Watcher / WatcherCheckpoint
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
// @invariant  5. The retained log is seq-ordered and deduplicated: an event whose `seq` was already
//                folded in is dropped, so a re-poll from a stale cursor cannot double-count.
// @ac         docs/BUILD-PLAN.md T2.2 — normalized log, deterministic under the mock
// @verify     npm run test -- watcher
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Millis, Sats } from '../types.js';

import type { HashiAdapter } from './adapter.js';
import {
  EVENT_CURSOR_GENESIS,
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
  /**
   * Resume the flow accumulator alongside `startCursor`. Default {@link FLOW_STATE_ZERO}.
   * Only meaningful with `retainLog: false` — a retained log is re-folded from scratch, which
   * is exact by construction.
   */
  readonly startFlow?: FlowState;
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

/** Everything needed to resume a watcher in a later process. Plain data — JSON/BCS friendly. */
export interface WatcherCheckpoint {
  readonly cursor: EventCursor;
  readonly flow: FlowState;
}

export interface Watcher {
  /** Next event-log index to read (inclusive). */
  readonly cursor: EventCursor;
  /** Pull the next batch and fold it into the flow state. Advances the cursor. */
  poll(): Promise<readonly HashiEvent[]>;
  /** The retained normalized log, seq-ordered. Empty when `retainLog` is false. */
  log(): readonly HashiEvent[];
  /** Current flow accumulator. */
  flow(): FlowState;
  /** Serializable resume point: feed it back as `startCursor` + `startFlow`. */
  checkpoint(): WatcherCheckpoint;
  /**
   * The `WithdrawalSigned` sub-stream — the ONLY events that advance the Guardian bucket.
   * `verify.deriveLimiter()` consumes exactly this (G5).
   */
  signedSince(
    cursor: EventCursor,
  ): Promise<{ events: readonly HashiEventOf<'WithdrawalSigned'>[]; next: EventCursor }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The fold
// ─────────────────────────────────────────────────────────────────────────────

/** Saturating subtraction — invariant 4: a counter never goes negative. */
function minus(a: Sats, b: Sats): Sats {
  return a > b ? a - b : 0n;
}

/**
 * Fold a batch of normalized events into the flow accumulator.
 *
 * PURE — no clock, no I/O. `atMs` is supplied by the caller (the last event's envelope
 * timestamp) so a replay reproduces the same state at the same boundary.
 *
 * Ordering is NOT assumed: the committee leader picks batches at its discretion ("generally
 * FIFO, not strict", G3), so every counter saturates at `0n` rather than trusting that a
 * Requested always precedes its Confirmed inside a given window.
 *
 * ⚠ `WithdrawalConfirmed` carries no amount (docs/RECON.md R8). Its burn credit is joined from
 * the `WithdrawalRequested` / `WithdrawalPickedForProcessing` events PRESENT IN `events`. A
 * Confirmed whose Requested fell outside this batch therefore credits 0 — which is why
 * {@link createWatcher} re-folds the whole retained log instead of accumulating page by page.
 */
export function applyFlow(prev: FlowState, events: readonly HashiEvent[], atMs: Millis): FlowState {
  // Local join table, built from exactly the events handed in (purity: no hidden state).
  const requestedSats = new Map<string, Sats>();
  for (const event of events) {
    if (event.kind === 'WithdrawalRequested') {
      if (!requestedSats.has(event.requestId)) requestedSats.set(event.requestId, event.sats);
    } else if (event.kind === 'WithdrawalPickedForProcessing') {
      // Positional fallback, same rule normalize.ts uses for the G5 join.
      event.requestIds.forEach((id, i) => {
        const out = event.outputs[i];
        if (out !== undefined && !requestedSats.has(id)) requestedSats.set(id, out.sats);
      });
    }
  }

  let pendingMintSats = prev.pendingMintSats;
  let pendingBurnSats = prev.pendingBurnSats;
  let queueDepthSats = prev.queueDepthSats;

  for (const event of events) {
    switch (event.kind) {
      // ── mint side: approval telegraphs the mint ~10 min before it lands (G8) ──
      case 'DepositApproved':
        pendingMintSats += event.sats;
        break;
      case 'DepositConfirmed':
        pendingMintSats = minus(pendingMintSats, event.sats);
        break;

      // ── burn side + global queue depth ─────────────────────────────────────
      case 'WithdrawalRequested':
        pendingBurnSats += event.sats;
        queueDepthSats += event.sats;
        break;
      case 'WithdrawalSigned':
        // Signed leaves the queue (the bucket has been debited) but the burn is not settled
        // on the Bitcoin side until Confirmed — so only queue depth moves here.
        queueDepthSats = minus(queueDepthSats, event.sats);
        break;
      case 'WithdrawalConfirmed': {
        let sats = 0n;
        for (const id of event.requestIds) sats += requestedSats.get(id) ?? 0n;
        pendingBurnSats = minus(pendingBurnSats, sats);
        break;
      }
      case 'WithdrawalCancelled':
        pendingBurnSats = minus(pendingBurnSats, event.sats);
        queueDepthSats = minus(queueDepthSats, event.sats);
        break;

      // Minted/Burned/DepositRequested/ExpiredDepositDeleted/WithdrawalApproved/
      // WithdrawalInputsSigned/WithdrawalPresigsReassigned carry no flow signal:
      // they either duplicate a transition already counted or have no amount at all.
      default:
        break;
    }
  }

  return { pendingMintSats, pendingBurnSats, queueDepthSats, atMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// The watcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the event watcher over an adapter (mock or real — identical behaviour, G7).
 *
 * Resumable: `startCursor` (+ `startFlow` when the log is not retained) restores a previous run.
 * Seq-ordered and deduplicated: a batch is sorted by `seq` and anything at or below the highest
 * already-folded seq is dropped, so replaying a stale cursor is a no-op rather than a double
 * count (invariants 2 and 5).
 */
export function createWatcher(adapter: HashiAdapter, opts: WatcherOptions = {}): Watcher {
  const kinds: readonly HashiEventKind[] = opts.kinds ?? WATCHED_EVENT_KINDS;
  const retainLog = opts.retainLog ?? true;
  const batchLimit = opts.batchLimit;

  let cursor: EventCursor = opts.startCursor ?? EVENT_CURSOR_GENESIS;
  let flowState: FlowState = opts.startFlow ?? FLOW_STATE_ZERO;
  /** Highest `seq` already folded in, or -1n before anything has been seen. */
  let highWaterSeq = cursor.seq > 0n ? cursor.seq - 1n : -1n;

  const retained: HashiEvent[] = [];

  const watcher: Watcher = {
    get cursor(): EventCursor {
      return cursor;
    },

    async poll(): Promise<readonly HashiEvent[]> {
      const page = await adapter.eventsSince(cursor, {
        kinds,
        ...(batchLimit === undefined ? {} : { limit: batchLimit }),
      });

      // Deterministic order + dedup. The adapter should already be seq-ordered; sorting makes
      // that a guarantee rather than a hope, and costs nothing at these volumes.
      const fresh = [...page.events]
        .sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))
        .filter((event) => event.seq > highWaterSeq);

      for (const event of fresh) {
        if (event.seq > highWaterSeq) highWaterSeq = event.seq;
        if (retainLog) retained.push(event);
      }

      // The cursor only ever moves forward (invariant 2).
      const nextSeq = page.next.seq > cursor.seq ? page.next.seq : cursor.seq;
      cursor = { seq: nextSeq > highWaterSeq + 1n ? nextSeq : highWaterSeq + 1n };

      if (fresh.length > 0) {
        const last = fresh[fresh.length - 1] as HashiEvent;
        flowState = retainLog
          ? // Exact: re-folding the whole log resolves cross-batch joins (see applyFlow).
            applyFlow(FLOW_STATE_ZERO, retained, last.atMs)
          : applyFlow(flowState, fresh, last.atMs);
      }

      return fresh;
    },

    log(): readonly HashiEvent[] {
      return retained;
    },

    flow(): FlowState {
      return flowState;
    },

    checkpoint(): WatcherCheckpoint {
      return { cursor, flow: flowState };
    },

    async signedSince(from: EventCursor) {
      return await adapter.signedEventsSince(from);
    },
  };

  return watcher;
}
