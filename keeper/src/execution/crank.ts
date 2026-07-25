// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.3
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
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
// @facts      There is no bridge-wide "list every pending deposit" read: the SDK's views are
// @facts        keyed by Sui tx digest and `view.all()` is per-address (E-K8 gap #1). The whole-
// @facts        bridge candidate set is therefore FOLDED FROM THE EVENT STREAM — the same public
// @facts        stream the G5 limiter replay consumes.
// @implements export interface CrankDeps / CrankOptions / CrankOutcome / CrankResult
// @implements export function selectCrankable(deposits: readonly DepositView[], nowMs: Millis, delayMs: Millis): readonly DepositView[]
// @implements export function buildConfirmDepositTx(cfg: Config, requestId: string): Transaction
// @implements export async function crank(deps: CrankDeps, opts?: CrankOptions): Promise<CrankResult>
// @implements ⚠ DELTAS vs the skeleton banner, all additive and deliberate:
// @implements   (a) export function confirmableAtMs(d, nowMs, delayMs): Millis — the shared
// @implements       eligibility clock used by both `selectCrankable` and the outcome reporting.
// @implements   (b) export function foldDepositViews(events, delayMs): readonly DepositView[] —
// @implements       the whole-bridge candidate set, folded from the public event stream.
// @implements   (c) export const DEPOSIT_EVENT_KINDS — the four deposit-lifecycle kinds.
// @implements   (d) CrankOptions gains `maxAttempts` / `retryBackoffMs` / `sleep`: `confirm_deposit`
// @implements       aborts while the bridge is paused/reconfiguring or when the committee rotated
// @implements       after approval, so a transient abort is RETRIED with backoff. `sleep` is
// @implements       injected so the suite never actually waits.
// @implements   (e) the PTB is submitted through `deps.hashi.confirmDeposit` — the adapter is the
// @implements       single Hashi choke point (G7) and the only thing that keeps the crank runnable
// @implements       against the deterministic mock. `buildConfirmDepositTx` is the same PTB in
// @implements       inspectable form (the app builds it for a user-signed crank).
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
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { HashiAdapter } from '../hashi/index.js';
import {
  EVENT_CURSOR_GENESIS,
  type DepositView,
  type EventCursor,
  type HashiEvent,
  type HashiEventKind,
} from '../hashi/types.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis, SuiAddress } from '../types.js';
import { AphoticError, ConfigError, NotReadyError } from '../util/errors.js';

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
  /**
   * Attempts per request before it is reported `failed` (delta (d)). `confirm_deposit` aborts
   * while the bridge is paused or reconfiguring, and when the committee rotated after approval —
   * all transient. Default {@link DEFAULT_MAX_ATTEMPTS}.
   */
  readonly maxAttempts?: number;
  /** First backoff step in ms; doubles per retry. Default {@link DEFAULT_RETRY_BACKOFF_MS}. */
  readonly retryBackoffMs?: Millis;
  /** Injected so tests never sleep. Default: `setTimeout`. */
  readonly sleep?: (ms: Millis) => Promise<void>;
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

/** Attempts per request before it is reported `failed`. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** First backoff step, doubled on each retry. */
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** The deposit lifecycle, verbatim Move struct names (docs/RECON.md R8). */
export const DEPOSIT_EVENT_KINDS = [
  'DepositRequested',
  'DepositApproved',
  'DepositConfirmed',
  'ExpiredDepositDeleted',
] as const satisfies readonly HashiEventKind[];

/** Bound on the event-stream drain, so a misbehaving transport cannot spin the keeper forever. */
const MAX_DRAIN_ROUNDS = 10_000;

/**
 * When `confirm_deposit` becomes callable for this deposit.
 *
 * PURE. The adapter reports `confirmableAtMs` (approval + `bitcoin_deposit_time_delay_ms`)
 * whenever it knows the approval instant. When it does NOT, the approval could have happened as
 * late as right now, so the earliest provable eligibility is `nowMs + delayMs` — i.e. NOT yet.
 * Assuming otherwise would spend gas on a known abort (invariant 2).
 */
export function confirmableAtMs(deposit: DepositView, nowMs: Millis, delayMs: Millis): Millis {
  return deposit.confirmableAtMs ?? nowMs + delayMs;
}

/**
 * Which pending deposits may be cranked right now.
 *
 * PURE — `nowMs` and `delayMs` are arguments so `verify/` can reproduce the selection exactly.
 * A deposit is eligible iff `status === 'Approved'` and `nowMs >= confirmableAtMs`
 * (approval + `bitcoin_deposit_time_delay_ms`). Anything earlier aborts on-chain.
 */
export function selectCrankable(
  deposits: readonly DepositView[],
  nowMs: Millis,
  delayMs: Millis,
): readonly DepositView[] {
  return deposits.filter(
    (d) => d.status === 'Approved' && nowMs >= confirmableAtMs(d, nowMs, delayMs),
  );
}

/**
 * Fold the public deposit-event stream into the CURRENT view of every deposit on the bridge.
 *
 * This is what makes the crank a public good rather than a vault feature: there is no
 * "list all pending deposits" read anywhere in the SDK (E-K8 gap #1), so the candidate set comes
 * from the same public event stream the G5 limiter replay consumes. PURE and order-preserving:
 * deposits come back in first-seen order, so a replay produces the same batch.
 */
export function foldDepositViews(events: readonly HashiEvent[], delayMs: Millis): readonly DepositView[] {
  const byId = new Map<string, DepositView>();

  const put = (requestId: string, patch: Partial<DepositView>): void => {
    const prev = byId.get(requestId);
    const readyAt = patch.confirmableAtMs ?? prev?.confirmableAtMs;
    const next: DepositView = {
      requestId,
      status: patch.status ?? prev?.status ?? 'Requested',
      sats: patch.sats ?? prev?.sats ?? 0n,
      recipient: patch.recipient ?? prev?.recipient ?? '',
      ...(readyAt === undefined ? {} : { confirmableAtMs: readyAt }),
    };
    byId.set(requestId, next);
  };

  for (const event of events) {
    switch (event.kind) {
      case 'DepositRequested': {
        // `Minted<T>` has no recipient (R8) — the binding lives in the UTXO derivation path,
        // which is exactly why the crank cannot redirect anyone's mint (G2).
        const recipient: SuiAddress = event.derivationPath ?? event.requesterAddress;
        put(event.requestId, { status: 'Requested', sats: event.sats, recipient });
        break;
      }
      case 'DepositApproved':
        put(event.requestId, {
          status: 'Approved',
          sats: event.sats,
          confirmableAtMs: event.approvalTimestampMs + delayMs,
        });
        break;
      case 'DepositConfirmed':
        put(event.requestId, { status: 'Confirmed', sats: event.sats });
        break;
      case 'ExpiredDepositDeleted':
        put(event.requestId, { status: 'Expired' });
        break;
      default:
        break;
    }
  }

  return [...byId.values()];
}

/**
 * One PTB containing exactly one command: the PERMISSIONLESS `confirm_deposit` entry.
 *
 * Not a `moveCall` into our package — `confirm_deposit` is an `entry` on the Hashi package and
 * cannot be composed from Move (docs/FACTS.md E-M9), so the PTB targets Hashi directly.
 *
 * The sender is deliberately NOT set: the crank is permissionless, so whoever signs pays. That is
 * also why this builder is a pure function of `(cfg, requestId)` and byte-identical on replay.
 */
export function buildConfirmDepositTx(cfg: Config, requestId: string): Transaction {
  if (cfg.hashi.packageId === '') {
    throw new ConfigError('cannot build confirm_deposit without HASHI_PACKAGE_ID', ['HASHI_PACKAGE_ID']);
  }
  if (cfg.hashi.objectId === '') {
    throw new ConfigError('cannot build confirm_deposit without HASHI_OBJECT_ID', ['HASHI_OBJECT_ID']);
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${cfg.hashi.packageId}::deposit::confirm_deposit`,
    arguments: [
      tx.sharedObjectRef({
        objectId: cfg.hashi.objectId,
        initialSharedVersion: cfg.hashi.objectInitialSharedVersion,
        mutable: true,
      }),
      tx.pure.address(requestId),
      tx.object.clock(),
    ],
  });
  return tx;
}

/**
 * Run the crank over every eligible pending deposit.
 *
 * Public good (docs/KEEPER.md §5.2): the keeper advances OTHER people's deposits too. It can do
 * this safely precisely because it cannot influence where the mint lands (G2).
 *
 * One PTB per request (invariant 3): a paused bridge, a rotated committee or a plain RPC hiccup
 * takes down exactly that request, and the batch keeps going.
 */
export async function crank(deps: CrankDeps, opts: CrankOptions): Promise<CrankResult> {
  const delayMs = deps.cfg.hashi.depositTimeDelayMs;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  const { deposits, outcomes } = await collectCandidates(deps, opts, delayMs);
  let attempted = 0;

  for (const deposit of deposits) {
    if (deposit.status === 'Confirmed') {
      // Invariant 1: already done is a no-op, never an error.
      outcomes.push({
        requestId: deposit.requestId,
        status: 'skipped-already-confirmed',
        reason: 'deposit already Confirmed',
      });
      continue;
    }

    const readyAtMs = confirmableAtMs(deposit, opts.nowMs, delayMs);
    if (deposit.status !== 'Approved' || opts.nowMs < readyAtMs) {
      // Invariant 2: calling early (or before approval) aborts on-chain — never spend the gas.
      outcomes.push({
        requestId: deposit.requestId,
        status: 'skipped-not-eligible',
        eligibleAtMs: readyAtMs,
        reason:
          deposit.status === 'Approved'
            ? `bitcoin_deposit_time_delay_ms not elapsed (${readyAtMs - opts.nowMs}ms remaining)`
            : `status ${deposit.status}`,
      });
      continue;
    }

    if (attempted >= limit) break;
    attempted += 1;
    outcomes.push(await confirmOne(deps, deposit, opts));
  }

  return { attempted, outcomes };
}

// ─────────────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The candidate set.
 *
 * `requestIds` narrows to specific deposits (a `NotFound` becomes a `failed` outcome instead of
 * killing the batch). Otherwise — the default, and the public-good path — every deposit the
 * public event stream knows about.
 */
async function collectCandidates(
  deps: CrankDeps,
  opts: CrankOptions,
  delayMs: Millis,
): Promise<{ deposits: readonly DepositView[]; outcomes: CrankOutcome[] }> {
  const outcomes: CrankOutcome[] = [];

  if (opts.requestIds !== undefined) {
    const deposits: DepositView[] = [];
    for (const requestId of opts.requestIds) {
      try {
        deposits.push(await deps.hashi.view.depositStatus(requestId));
      } catch (err) {
        outcomes.push({ requestId, status: 'failed', reason: reasonOf(err) });
      }
    }
    return { deposits, outcomes };
  }

  // `all: false` without an explicit id list has no scope to run over — do nothing rather than
  // guess which deposits are "ours" (the mint recipient is never keeper-chosen, G2).
  if (opts.all === false) return { deposits: [], outcomes };

  const events = await drainEvents(deps.hashi, DEPOSIT_EVENT_KINDS);
  return { deposits: foldDepositViews(events, delayMs), outcomes };
}

/** Read the whole public event stream for the given kinds. Cursor-driven, bounded, idempotent. */
async function drainEvents(
  hashi: HashiAdapter,
  kinds: readonly HashiEventKind[],
): Promise<readonly HashiEvent[]> {
  const out: HashiEvent[] = [];
  let cursor: EventCursor = EVENT_CURSOR_GENESIS;

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const page = await hashi.eventsSince(cursor, { kinds });
    out.push(...page.events);
    // An empty PAGE is not the end of the stream; a cursor that stops advancing is.
    if (page.next.seq <= cursor.seq) return out;
    cursor = page.next;
  }

  throw new AphoticError(
    'CrankDrainUnbounded',
    `deposit event drain exceeded ${MAX_DRAIN_ROUNDS} rounds — the event cursor is not converging`,
  );
}

/**
 * Submit ONE `confirm_deposit`, retrying only the transient aborts.
 *
 * The bridge aborts this entry when it is paused, mid-reconfiguration, or when the committee
 * rotated after the deposit was approved. None of those is a property of OUR request, so they are
 * retried with exponential backoff. `NotReady` is not retried — the delay is a clock fact, and the
 * outcome reports exactly when it elapses.
 */
async function confirmOne(deps: CrankDeps, deposit: DepositView, opts: CrankOptions): Promise<CrankOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const requestId = deposit.requestId;
  let lastReason = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { digest } = await deps.hashi.confirmDeposit(requestId, deps.signer);
      return { requestId, status: 'confirmed', digest };
    } catch (err) {
      lastReason = reasonOf(err);

      if (err instanceof NotReadyError) {
        return {
          requestId,
          status: 'skipped-not-eligible',
          eligibleAtMs: err.readyAtMs,
          reason: lastReason,
        };
      }
      if (codeOf(err) === 'NotFound') {
        return { requestId, status: 'failed', reason: lastReason };
      }
      if (attempt + 1 < maxAttempts) await sleep(backoffMs * 2 ** attempt);
    }
  }

  return { requestId, status: 'failed', reason: lastReason };
}

function defaultSleep(ms: Millis): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function codeOf(err: unknown): string | undefined {
  return err instanceof AphoticError ? err.code : undefined;
}

function reasonOf(err: unknown): string {
  if (err instanceof AphoticError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
