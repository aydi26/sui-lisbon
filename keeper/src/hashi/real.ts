// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.1
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §2.3 (REAL implementation)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.1)
// @spec       docs/RECON.md#r12 (@mysten/hashi 0.6.0), #r5 (ids), #r6 (live config), #r8 (events)
// @rules      G2 G3 G5 G6 G7
// @depends    ./adapter.ts (T0.5) · ./normalize.ts (T0.5) · ./eventTypes.ts (T0.5) ·
//             ./limiter.ts (T0.5) · ../sui/client.ts (T0.3) · ../config.ts (T0.6)
// @facts      ★ THIS IS THE ONLY FILE IN THE REPO ALLOWED TO IMPORT '@mysten/hashi' (G7).
// @facts      SDK v0.6.0, ESM-only, peer @mysten/sui ^2.22.1. Wiring: `client.$extend(hashi())`,
// @facts        which is `hashi(opts).register(client)` — used verbatim below.
// @facts      ★ VERIFIED SDK SURFACE (read from node_modules/@mysten/hashi@0.6.0/dist/*.d.mts):
// @facts        index    : HashiClient · hashi() · generateDepositAddress · deriveChildPubkey ·
// @facts                   twoOfTwoTaprootScriptPathAddress · arkworksToSec1Compressed ·
// @facts                   bitcoinAddressToWitnessProgram · witnessProgramToAddress ·
// @facts                   projectCapacity · estimateWaitSecs · fetchGuardianInfo · 7 error classes
// @facts        HashiClient.generateDepositAddress({suiAddress, bitcoinNetwork?}) -> string
// @facts        HashiClient.deposit/requestWithdrawal/cancelWithdrawal({signer, ...})  (sign+execute)
// @facts        HashiClient.tx.{deposit,requestWithdrawal,cancelWithdrawal}(...)       (unsigned)
// @facts        HashiClient.call.{deposit,requestWithdrawal,cancelWithdrawal}(...)     (PTB fragments)
// @facts        HashiClient.view.{all,paused,balance,depositStatus,withdrawalStatus,
// @facts                          transactionHistory,findUsedUtxos,mpcPublicKey,…}
// @facts        HashiClient.waitForDeposit/waitForWithdrawal(suiTxDigest, opts)
// @facts        HashiClient.guardian.{info,limiterStatus,canWithdraw}
// @facts      ⚠ ERRATUM E-K8 — the four HARD gaps between that surface and HashiAdapter (T0.5):
// @facts        1. `view.depositStatus` / `view.withdrawalStatus` / `waitFor*` are keyed by the
// @facts           SUI TX DIGEST, not by `request_id`. There is NO request-id lookup in 0.6.0.
// @facts           ⇒ this adapter keeps a requestId->digest index built from the EVENT LOG.
// @facts        2. There is NO `confirm_deposit` binding — `dist/contracts/hashi/deposit.mjs`
// @facts           exports only `deposit`. ⇒ raw `moveCall` (docs/FACTS.md#confirm-deposit):
// @facts           entry hashi::deposit::confirm_deposit(&mut Hashi, address, &Clock, &mut TxContext)
// @facts        3. There is NO event API at all. gRPC v2 (`@mysten/sui/grpc`) has NO event-query
// @facts           RPC either — LedgerService/StateService/SubscriptionService expose objects,
// @facts           transactions, checkpoints only. ⇒ events come from JSON-RPC `queryEvents`
// @facts           against the verified MIRRORS (docs/RECON.md R1), filtered by
// @facts           `MoveEventModule` (NOT `MoveModule` — that filters the EMITTING module and
// @facts           returns zero rows for withdrawal_queue::*; scripts/verify-onchain.mjs P5).
// @facts        4. `view.balance` returns `HbtcBalance{totalBalance, coinObjectCount}`, not Sats.
// @facts      ⚠ Do NOT use the SDK's `projectCapacity` — the canonical one is ./limiter.ts, which
// @facts        adds u64 SATURATION so it matches the Rust enclave at the extremes (G5).
// @facts      ⚠ ERRATUM E-K9 — `guardian_url` is behind an ALB that rejects HTTP/1.1 with 464, so
// @facts        the SDK's `fetchGuardianInfo` (global fetch) CANNOT work. This file speaks
// @facts        `node:http2` (ALPN h2) instead, and on ANY failure returns a typed UNAVAILABLE
// @facts        reading rather than throwing — it is only an UNVERIFIED HINT anyway (G5).
// @facts      ⚠ guardian.* is an UNVERIFIED HINT. The authoritative bucket is the event replay.
// @facts      HASHI_PACKAGE_ID / HASHI_OBJECT_ID come from Config — never hardcode (G7).
// @facts      Event reads: filter by module using ./eventTypes.ts, normalize via ./normalize.ts
// @facts        (which performs the request_ids -> sats join for WithdrawalSigned).
// @facts      Latencies (G6): deposit ~70 min, withdraw ~1.5–2 h ⇒ generous waitFor* timeouts.
// @implements export class UnsupportedByUpstreamError
// @implements export interface RealHashiDeps / HashiSdkClient / RawEventPage / EventQuery
// @implements export interface RealLimiterStatus + isLimiterHintAvailable
// @implements export const HASHI_SDK_SURFACE_0_6_0
// @implements export function createRealHashiAdapter(cfg: Config, deps?: RealHashiDeps): HashiAdapter
// @forbidden  giving the keeper any capability beyond DeepBook TradeCap (G2)
// @forbidden  wiring requestWithdrawal/cancelWithdrawal into the vault exit path — the production
//             exit is Move `gateway::exit_to_bitcoin` to the PINNED address (G2)
// @forbidden  sourcing limiter state from guardian.* for anything but a sanity hint (G5)
// @forbidden  a SECOND copy of projectCapacity/consume — this file IMPORTS ./limiter.ts (G5)
// @forbidden  constructing a Sui client here — ../sui/client.ts is the single factory
// @invariant  1. Every method either works against live testnet or throws a TYPED error
//                (UnsupportedByUpstreamError / NotFoundError / …) — never a silent stub.
// @invariant  2. Behavioural parity with hashi/mock.ts is contract-tested (T2.1 VERIFY).
// @invariant  3. `guardian.limiterStatus()` NEVER throws: an unreachable guardian yields
//                `{available:false, source:'sdk-hint'}`.
// @invariant  4. `eventsSince` is monotonic + idempotent: re-reading a cursor replays the same
//                normalized events with the same `seq`.
// @ac         docs/BUILD-PLAN.md T2.1 — same interface, swappable for the mock
// @verify     npm run test -- hashi.real
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { connect as http2Connect } from 'node:http2';

import {
  bitcoinAddressToWitnessProgram,
  hashi as hashiExtension,
  witnessProgramToAddress,
  type BitcoinNetwork,
  type GovernanceConfig,
  type HashiClient,
} from '@mysten/hashi';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import type { Config } from '../config.js';
import { createJsonRpcClient, createSuiClient, isGrpc, type AnySuiClient } from '../sui/client.js';
import type { Millis, SuiAddress } from '../types.js';
import { assertBtcWitnessProgram } from '../util/bytes.js';
import {
  AphoticError,
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  NotFoundError,
  TimeoutError,
} from '../util/errors.js';

import type {
  BridgeConfig,
  DepositArgs,
  EventsSinceOptions,
  HashiAdapter,
  HashiGuardianViews,
  HashiViews,
  RequestWithdrawalArgs,
  WaitOptions,
} from './adapter.js';
import { parseHashiEventKind } from './eventTypes.js';
import { consume, msToSecs, projectCapacityAtSecs, type LimiterState } from './limiter.js';
import { createNormalizeContext, normalizeEvents, type NormalizeContext, type RawSuiEvent } from './normalize.js';
import {
  HASHI_EVENT_MODULE,
  type DepositAddress,
  type DepositStatus,
  type DepositView,
  type EventCursor,
  type HashiEvent,
  type HashiEventKind,
  type HashiEventOf,
  type LimiterStatus,
  type Sats,
  type WithdrawalStatus,
  type WithdrawalView,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A capability the T0.5 `HashiAdapter` declares that `@mysten/hashi@0.6.0` (and the transport it
 * runs on) genuinely cannot provide. It is NOT a stub marker: every use site names the exact
 * missing upstream API and the fallback that was tried first (E-K8).
 */
export class UnsupportedByUpstreamError extends AphoticError {
  readonly what: string;

  constructor(what: string, reason: string) {
    super('UnsupportedByUpstream', `${what} is not supported by @mysten/hashi@0.6.0 / the configured transport: ${reason}`);
    this.what = what;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The upstream surface, as VERIFIED (not as documented)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exact export list of `@mysten/hashi@0.6.0`, transcribed from its `dist/index.d.mts`.
 * Kept as data so a version bump that removes a symbol fails a test instead of a demo (E-K8).
 */
export const HASHI_SDK_SURFACE_0_6_0 = Object.freeze({
  version: '0.6.0',
  values: Object.freeze([
    'HashiClient',
    'hashi',
    'generateDepositAddress',
    'deriveChildPubkey',
    'twoOfTwoTaprootScriptPathAddress',
    'arkworksToSec1Compressed',
    'bitcoinAddressToWitnessProgram',
    'witnessProgramToAddress',
    'projectCapacity',
    'estimateWaitSecs',
    'fetchGuardianInfo',
    'AmountBelowMinimumError',
    'HashiConfigError',
    'HashiFetchError',
    'HashiGuardianError',
    'HashiPausedError',
    'InvalidBitcoinAddressError',
    'InvalidParamsError',
  ] as const),
  /** Capabilities `HashiAdapter` needs that the SDK does NOT expose at all (E-K8). */
  missing: Object.freeze([
    'lookup by request_id (view.* and waitFor* are keyed by the Sui tx digest)',
    'confirm_deposit binding (contracts/hashi/deposit.mjs exports only `deposit`)',
    'any event query (and gRPC v2 has no event RPC either)',
  ] as const),
});

/**
 * The narrow slice of `HashiClient` this adapter actually calls.
 *
 * Declaring it structurally does three jobs: it documents the REAL 0.6.0 surface, it lets the
 * contract test drive the adapter with a fake (no network, G7), and it makes a breaking SDK
 * change a compile error at {@link buildSdkClient} rather than a runtime surprise.
 */
export interface HashiSdkClient {
  generateDepositAddress(args: { suiAddress: string; bitcoinNetwork?: BitcoinNetwork }): Promise<string>;
  readonly view: {
    all(): Promise<GovernanceConfig>;
    balance(owner: string): Promise<{ readonly totalBalance: bigint; readonly coinObjectCount: number }>;
    depositStatus(suiTxDigest: string): Promise<SdkDepositInfo | null>;
    withdrawalStatus(suiTxDigest: string): Promise<SdkWithdrawalInfo | null>;
    transactionHistory(suiAddress: string): Promise<readonly SdkHistoryItem[]>;
  };
  readonly tx: {
    deposit(params: {
      txid: string;
      utxos: readonly { vout: number; amountSats: bigint }[];
      recipient: string;
    }): Transaction;
    requestWithdrawal(options: { amount: bigint; bitcoinAddress: Uint8Array }): Transaction;
    cancelWithdrawal(options: { requestId: string; recipient: string }): Transaction;
  };
}

/** `HashiClient.view.depositStatus` result (subset). */
export interface SdkDepositInfo {
  readonly requestId: string;
  readonly amountSats: bigint;
  readonly recipient: string | null;
  readonly approvalTimestampMs: bigint | null;
  readonly confirmableAtMs: bigint | null;
  readonly status: 'pending' | 'confirmed' | 'expired' | 'unknown';
  readonly suiTxDigest: string;
}

/** `HashiClient.view.withdrawalStatus` result (subset). */
export interface SdkWithdrawalInfo {
  readonly requestId: string;
  readonly btcAmountSats: bigint;
  readonly bitcoinAddress: Uint8Array;
  readonly status: 'Requested' | 'Approved' | 'Processing' | 'Signed' | 'Confirmed' | 'cancelled';
  readonly btcTxid: string | null;
}

/** `HashiClient.view.transactionHistory` entry (subset). */
export type SdkHistoryItem =
  | {
      readonly kind: 'deposit';
      readonly requestId: string;
      readonly sender: string;
      readonly amountSats: bigint;
      readonly approved: boolean;
      readonly confirmableAtMs: bigint | null;
    }
  | {
      readonly kind: 'withdrawal';
      readonly requestId: string;
      readonly sender: string;
      readonly btcAmountSats: bigint;
      readonly bitcoinAddress: Uint8Array;
      readonly status: 'Requested' | 'Approved' | 'Processing' | 'Signed' | 'Confirmed';
      readonly btcTxid: string | null;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Injected transport seams (so T2.1 is testable with ZERO network — G7)
// ─────────────────────────────────────────────────────────────────────────────

/** One page of raw Sui events, transport-shaped (JSON-RPC `queryEvents` or an injected fake). */
export interface RawEventPage {
  readonly data: readonly RawSuiEvent[];
  readonly nextCursor: EventPageCursor | null;
  readonly hasNextPage: boolean;
}

/** JSON-RPC event cursor (`{txDigest, eventSeq}`). Opaque to everything but the query fn. */
export interface EventPageCursor {
  readonly txDigest: string;
  readonly eventSeq: string;
}

/** Pull one page of raw events emitted by `<hashiPackage>::<module>`, oldest-first. */
export type EventQuery = (req: {
  readonly packageId: string;
  readonly module: string;
  readonly cursor: EventPageCursor | null;
  readonly limit: number;
}) => Promise<RawEventPage>;

/** Sign + execute a PTB. Returns the transport's raw result; parsed structurally below. */
export type SignAndExecute = (input: {
  readonly signer: Signer;
  readonly transaction: Transaction;
}) => Promise<unknown>;

/** Fetch the guardian `/info` payload. Default speaks HTTP/2 (E-K9). */
export type GuardianInfoFetch = (origin: string) => Promise<unknown>;

/** Everything T2.1 can be driven by. All optional — production wires the real ones lazily. */
export interface RealHashiDeps {
  /** Result of `createSuiClient(cfg)` — never construct a client in here (transport gate). */
  readonly client?: AnySuiClient;
  /** Pre-built SDK client. Default: `hashi({...}).register(client)` — i.e. `client.$extend(hashi())`. */
  readonly sdk?: HashiSdkClient;
  /** Event pager. Default: JSON-RPC `queryEvents` against `cfg.sui.jsonRpcUrl` (E-K8 gap #3). */
  readonly eventQuery?: EventQuery;
  /** PTB executor. Default: the Sui client's `signAndExecuteTransaction`. */
  readonly signAndExecute?: SignAndExecute;
  /** Guardian `/info` reader. Default: {@link fetchGuardianInfoOverHttp2} (E-K9). */
  readonly guardianInfo?: GuardianInfoFetch;
  /** Clock. Injected so `waitFor*` and the limiter hint are testable without wall time. */
  readonly nowMs?: () => Millis;
  /** Sleep between `waitFor*` polls. Injected so tests never actually sleep (G6). */
  readonly sleep?: (ms: Millis) => Promise<void>;
  /** Page size for event reads. Default 50. */
  readonly eventPageLimit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guardian limiter hint (UNVERIFIED — G5 says the replay is the authority)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `LimiterStatus` widened with an explicit availability flag.
 *
 * E-K9: the guardian endpoint is frequently unreachable (HTTP/1.1 → 464; HTTP/2 may still fail
 * on a fresh deployment). Throwing would make an UNVERIFIED HINT able to break the keeper loop,
 * so the real adapter degrades instead: `available:false` with a zeroed bucket and a reason.
 * Callers MUST NOT feed an unavailable hint into `strategy.evaluate()` — they must not feed an
 * available one either (G5); the authority is `verify.deriveLimiter` over `WithdrawalSigned`.
 */
export interface RealLimiterStatus extends LimiterStatus {
  readonly source: 'sdk-hint';
  /** `false` ⇒ every numeric field is a placeholder, not a reading. */
  readonly available: boolean;
  /** Why the guardian read failed. Present iff `available === false`. */
  readonly unavailableReason?: string;
}

/** Narrow a `LimiterStatus` to a hint that actually carries a reading. */
export function isLimiterHintAvailable(status: LimiterStatus): status is RealLimiterStatus & { available: true } {
  return (status as RealLimiterStatus).available === true;
}

/**
 * Read `GET {origin}/info` over HTTP/2.
 *
 * ⚠ E-K9: the guardian sits behind an ALB that answers HTTP/1.1 with status **464**, so Node's
 * global `fetch`, `curl` AND the SDK's own `fetchGuardianInfo` all fail. `node:http2` with ALPN
 * `h2` is the only client that gets a response.
 */
export async function fetchGuardianInfoOverHttp2(origin: string, timeoutMs = 10_000): Promise<unknown> {
  const url = new URL('/info', origin);
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const session = http2Connect(url.origin, { ALPNProtocols: ['h2'] });

    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        session.close();
      } catch {
        /* the session may already be destroyed */
      }
      if (err !== null) reject(err);
      else resolve(value);
    };

    session.on('error', (err) => finish(err));

    const req = session.request({ ':path': url.pathname, ':method': 'GET', accept: 'application/json' });
    req.setTimeout(timeoutMs, () => finish(new TimeoutError(`guardian ${url.href}`, timeoutMs)));

    let status = 0;
    const chunks: Buffer[] = [];
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('error', (err) => finish(err));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (status < 200 || status >= 300) {
        finish(new Error(`guardian ${url.href} returned HTTP ${status}`));
        return;
      }
      try {
        finish(null, JSON.parse(body));
      } catch (cause) {
        finish(new Error(`guardian ${url.href} returned non-JSON body`, { cause }));
      }
    });
    req.end();
  });
}

/**
 * Pull `{state, config}` out of a guardian `/info` payload.
 *
 * The wire shape is UNVERIFIED (the endpoint was unreachable during recon), so both camelCase
 * and snake_case spellings are accepted. Returns `undefined` when the guardian has no limiter
 * yet — an unprovisioned guardian is a normal state, not an error.
 */
export function parseGuardianLimiter(
  payload: unknown,
): { readonly state: LimiterState; readonly cap: Sats; readonly refillRate: Sats } | undefined {
  const root = asRecord(payload);
  const limiter = asRecord(root?.['limiter']);
  if (limiter === undefined) return undefined;
  const state = asRecord(limiter['state']);
  const config = asRecord(limiter['config']);
  if (state === undefined || config === undefined) return undefined;

  const tokens = pickBigInt(state, ['numTokensAvailableSats', 'num_tokens_available_sats', 'num_tokens_available']);
  const last = pickBigInt(state, ['lastUpdatedAtSecs', 'last_updated_at_secs', 'last_updated_at']);
  const nextSeq = pickBigInt(state, ['nextSeq', 'next_seq']);
  const refillRate = pickBigInt(config, ['refillRateSatsPerSec', 'refill_rate_sats_per_sec', 'refill_rate']);
  const cap = pickBigInt(config, ['maxBucketCapacitySats', 'max_bucket_capacity_sats', 'max_bucket_capacity']);
  if (tokens === undefined || refillRate === undefined || cap === undefined) return undefined;

  return {
    state: { numTokensAvailableSats: tokens, lastUpdatedAtSecs: last ?? 0n, nextSeq: nextSeq ?? 0n },
    cap,
    refillRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REAL adapter over `@mysten/hashi` 0.6.0 + on-chain event reads.
 *
 * Selected by `HASHI_ADAPTER=real`. It is behaviour-compatible with `hashi/mock.ts`: same method
 * surface, same error taxonomy (`BelowMinimum*`, `InvalidBitcoinAddress`, `NotFound`, `Timeout`,
 * `RateLimitExceeded`), same `EventCursor` semantics. Anything 0.6.0 genuinely cannot do raises
 * {@link UnsupportedByUpstreamError} naming the missing API — never a silent stub.
 *
 * Nothing here is constructed eagerly: building the adapter performs ZERO I/O, so `HASHI_ADAPTER`
 * can be flipped in a config file without a live endpoint (G7).
 */
export function createRealHashiAdapter(cfg: Config, deps: RealHashiDeps = {}): HashiAdapter {
  /** Every diagnostic reports the exact bridge deployment (all ids come from Config, G7). */
  const at = (what: string): string => `${what} [Hashi ${cfg.hashi.packageId} @ ${cfg.hashi.objectId}]`;

  const nowMs = deps.nowMs ?? ((): Millis => Date.now());
  const sleep = deps.sleep ?? ((ms: Millis) => new Promise<void>((r) => setTimeout(r, ms)));
  const pageLimit = deps.eventPageLimit ?? 50;
  const btcNetwork = bitcoinNetworkFor(cfg);

  // ── lazily-built transports ────────────────────────────────────────────────

  let suiClient: AnySuiClient | undefined = deps.client;
  function client(): AnySuiClient {
    suiClient ??= createSuiClient(cfg);
    return suiClient;
  }

  let sdkClient: HashiSdkClient | undefined = deps.sdk;
  function sdk(): HashiSdkClient {
    sdkClient ??= buildSdkClient(cfg, client());
    return sdkClient;
  }

  let eventQuery: EventQuery | undefined = deps.eventQuery;
  function events(): EventQuery {
    eventQuery ??= buildJsonRpcEventQuery(cfg);
    return eventQuery;
  }

  const signAndExecute: SignAndExecute =
    deps.signAndExecute ??
    (async ({ signer, transaction }) => {
      // The two transports spell "give me the events back" differently, and we NEED the events:
      // `deposit`/`request_withdrawal` return nothing, so the emitted event is the only receipt.
      const c = client();
      return isGrpc(c)
        ? await c.signAndExecuteTransaction({ signer, transaction, include: { events: true, effects: true } })
        : await c.signAndExecuteTransaction({
            signer,
            transaction,
            options: { showEvents: true, showEffects: true },
          });
    });

  const guardianInfo: GuardianInfoFetch = deps.guardianInfo ?? ((origin) => fetchGuardianInfoOverHttp2(origin));

  // ── the normalized event log (E-K8 gap #3) ─────────────────────────────────
  //
  // `EventCursor.seq` is an index into THIS log, exactly as in the mock, so `verify/` and the
  // watcher cannot tell the two adapters apart. The log is append-only and the RPC cursors are
  // per-module, which is what makes `eventsSince` monotonic and idempotent (invariant 4).

  const log: HashiEvent[] = [];
  const ctx: NormalizeContext = createNormalizeContext();
  /** requestId -> Sui tx digest. The ONLY way to reach the SDK's digest-keyed views (gap #1). */
  const digestOfRequest = new Map<string, string>();
  const moduleCursors = new Map<string, EventPageCursor | null>();
  const exhausted = new Set<string>();

  const EVENT_MODULES: readonly string[] = [...new Set(Object.values(HASHI_EVENT_MODULE))];

  function indexRequestDigest(event: HashiEvent): void {
    if (event.txDigest === undefined) return;
    if ('requestId' in event && event.requestId !== '' && !digestOfRequest.has(event.requestId)) {
      digestOfRequest.set(event.requestId, event.txDigest);
    }
    if ('requestIds' in event) {
      for (const id of event.requestIds) {
        if (id !== '' && !digestOfRequest.has(id)) digestOfRequest.set(id, event.txDigest);
      }
    }
  }

  /**
   * Fetch one page from every Hashi module, merge them into a single deterministic order and
   * append. Merge key = (envelope ms, txDigest, eventSeq) — the same total order any replayer
   * derives from the chain, so two keepers reading the same range build identical logs.
   */
  async function fetchMore(): Promise<number> {
    const query = events();
    const batch: RawSuiEvent[] = [];

    for (const module of EVENT_MODULES) {
      if (exhausted.has(module)) continue;
      const page = await query({
        packageId: cfg.hashi.packageId,
        module,
        cursor: moduleCursors.get(module) ?? null,
        limit: pageLimit,
      });
      for (const raw of page.data) batch.push(raw);
      moduleCursors.set(module, page.nextCursor);
      if (!page.hasNextPage) exhausted.add(module);
    }

    if (batch.length === 0) return 0;
    batch.sort(compareRawEvents);

    const before = log.length;
    for (const event of normalizeEvents(cfg, batch, BigInt(log.length), ctx)) {
      log.push(event);
      indexRequestDigest(event);
    }
    return log.length - before;
  }

  /** Grow the log until it holds `want` events or the chain has nothing left. */
  async function fillTo(want: number): Promise<void> {
    while (log.length < want) {
      if (EVENT_MODULES.every((m) => exhausted.has(m))) return;
      if ((await fetchMore()) === 0 && EVENT_MODULES.every((m) => exhausted.has(m))) return;
    }
  }

  async function readEvents(
    cursor: EventCursor,
    opts?: EventsSinceOptions,
  ): Promise<{ events: readonly HashiEvent[]; next: EventCursor }> {
    const start = cursor.seq < 0n ? 0 : Number(cursor.seq);
    const limit = opts?.limit;
    const kinds = opts?.kinds;

    // Without a kind filter the page size bounds the read; with one we may have to walk further.
    await fillTo(limit === undefined ? start + pageLimit : start + limit);

    const out: HashiEvent[] = [];
    let i = start;
    for (; i < log.length; i++) {
      const event = log[i] as HashiEvent;
      if (kinds === undefined || kinds.includes(event.kind)) out.push(event);
      if (limit !== undefined && out.length >= limit) {
        i++;
        break;
      }
    }
    return { events: out, next: { seq: BigInt(i) } };
  }

  /** Resolve a `request_id` to the Sui digest the SDK's digest-keyed views need (gap #1). */
  async function digestFor(requestId: string): Promise<string> {
    const known = digestOfRequest.get(requestId);
    if (known !== undefined) return known;
    // Walk forward until the whole stream has been indexed — the id may be older than our log.
    for (;;) {
      const grew = await fetchMore();
      const found = digestOfRequest.get(requestId);
      if (found !== undefined) return found;
      if (grew === 0 && EVENT_MODULES.every((m) => exhausted.has(m))) break;
    }
    throw new NotFoundError(at(`request ${requestId} (no Hashi event references it)`));
  }

  // ── views ──────────────────────────────────────────────────────────────────

  const view: HashiViews = {
    /** `view.balance` returns `{totalBalance, coinObjectCount}` — we surface the sats (gap #4). */
    async balance(suiAddress: SuiAddress): Promise<Sats> {
      const balance = await sdk().view.balance(suiAddress);
      return balance.totalBalance;
    },

    async depositStatus(requestId: string): Promise<DepositView> {
      const info = await sdk().view.depositStatus(await digestFor(requestId));
      if (info === null) throw new NotFoundError(at(`deposit ${requestId}`));
      return depositViewOf(info);
    },

    async withdrawalStatus(requestId: string): Promise<WithdrawalView> {
      const info = await sdk().view.withdrawalStatus(await digestFor(requestId));
      if (info === null) throw new NotFoundError(at(`withdrawal ${requestId}`));
      return withdrawalViewOf(info);
    },

    async all(
      suiAddress: SuiAddress,
    ): Promise<{ deposits: readonly DepositView[]; withdrawals: readonly WithdrawalView[] }> {
      const history = await sdk().view.transactionHistory(suiAddress);
      const deposits: DepositView[] = [];
      const withdrawals: WithdrawalView[] = [];
      for (const item of history) {
        if (item.kind === 'deposit') {
          deposits.push({
            requestId: item.requestId,
            status: item.approved ? 'Approved' : 'Requested',
            sats: item.amountSats,
            recipient: item.sender,
            ...(item.confirmableAtMs === null ? {} : { confirmableAtMs: Number(item.confirmableAtMs) }),
          });
        } else {
          withdrawals.push({
            requestId: item.requestId,
            status: item.status === 'Processing' ? 'PickedForProcessing' : item.status,
            sats: item.btcAmountSats,
            bitcoinAddress: item.bitcoinAddress,
            ...(item.btcTxid === null ? {} : { signetTxid: item.btcTxid }),
          });
        }
      }
      return { deposits, withdrawals };
    },
  };

  // ── guardian (HINT ONLY — G5) ──────────────────────────────────────────────

  /**
   * Replay the bucket from the on-chain `WithdrawalSigned` stream.
   *
   * G5: this uses the CANONICAL `consume`/`projectCapacityAtSecs` from `./limiter.ts` — there is
   * no second copy of the algorithm here. `verify.deriveLimiter()` (T4.3) is the authoritative,
   * journal-facing replay; this fold exists only so `canWithdraw` never has to trust the
   * guardian hint. A batch whose sats could not be joined (`satsSource === 'unresolved'`) makes
   * the replay incomplete, so we stop and report what we had — never a silent under-debit.
   */
  async function replayBucket(): Promise<{ state: LimiterState; complete: boolean }> {
    let state: LimiterState = {
      numTokensAvailableSats: cfg.limiter.maxBucketCapacitySats,
      lastUpdatedAtSecs: 0n,
      nextSeq: 0n,
    };
    let cursor: EventCursor = { seq: 0n };
    for (;;) {
      const page = await adapter.signedEventsSince(cursor);
      if (page.events.length === 0) return { state, complete: true };
      for (const event of page.events) {
        if (event.satsSource === 'unresolved') return { state, complete: false };
        const result = consume(cfg.limiter, state, state.nextSeq, event.atSecs, event.sats);
        // A rejected batch never advanced the real bucket either (G3) — skip it, keep going.
        if (result.ok) state = result.state;
      }
      if (page.next.seq === cursor.seq) return { state, complete: true };
      cursor = page.next;
    }
  }

  const guardian: HashiGuardianViews = {
    /**
     * ⚠⚠ UNVERIFIED HINT (G5) and NEVER a throw (invariant 3). E-K9: HTTP/2 only.
     * The projection uses OUR saturating `projectCapacityAtSecs`, not the SDK's.
     */
    async limiterStatus(): Promise<RealLimiterStatus> {
      const asOfMs = nowMs();
      const asOfSecs = msToSecs(asOfMs);
      const unavailable = (reason: string): RealLimiterStatus => ({
        tokens: 0n,
        refillRate: cfg.limiter.refillRateSatsPerSec,
        maxBucketCapacity: cfg.limiter.maxBucketCapacitySats,
        asOfMs,
        asOfSecs,
        nextSeq: 0n,
        source: 'sdk-hint',
        available: false,
        unavailableReason: reason,
      });

      let payload: unknown;
      try {
        payload = await guardianInfo(cfg.hashi.guardianUrl);
      } catch (err) {
        return unavailable(err instanceof Error ? err.message : String(err));
      }

      const limiter = parseGuardianLimiter(payload);
      if (limiter === undefined) {
        return unavailable(`guardian ${cfg.hashi.guardianUrl}/info carries no limiter (unprovisioned?)`);
      }

      return {
        tokens: projectCapacityAtSecs(
          { refillRateSatsPerSec: limiter.refillRate, maxBucketCapacitySats: limiter.cap },
          limiter.state,
          asOfSecs,
        ),
        refillRate: limiter.refillRate,
        maxBucketCapacity: limiter.cap,
        asOfMs,
        asOfSecs,
        nextSeq: limiter.state.nextSeq,
        source: 'sdk-hint',
        available: true,
      };
    },

    /**
     * Pre-exit UX check. Answers from the REPLAY, never from the hint (G5).
     *
     * ⚠ G3: `false` means "do not submit yet". `true` never means "you have a slot" — you cannot
     * buy priority in Hashi's global queue and an over-capacity batch is REJECTED, not queued.
     */
    async canWithdraw(sats: Sats): Promise<boolean> {
      if (sats < cfg.hashi.withdrawalMinimumSats) return false;
      const { state, complete } = await replayBucket();
      if (!complete) return false;
      return projectCapacityAtSecs(cfg.limiter, state, msToSecs(nowMs())) >= sats;
    },
  };

  // ── the adapter ────────────────────────────────────────────────────────────

  const adapter: HashiAdapter & { kind: 'real' } = {
    kind: 'real',
    view,
    guardian,

    /** Live governance snapshot (`view.all()`), plus the two limiter genesis scalars from Config. */
    async bridgeConfig(): Promise<BridgeConfig> {
      const snap = await sdk().view.all();
      return {
        adapter: 'real',
        packageId: cfg.hashi.packageId,
        objectId: cfg.hashi.objectId,
        hbtcCoinType: cfg.hashi.hbtcCoinType,
        guardianUrl: snap.guardianUrl ?? cfg.hashi.guardianUrl,
        depositTimeDelayMs: Number(snap.bitcoinDepositTimeDelayMs),
        depositMinimumSats: snap.bitcoinDepositMinimum,
        withdrawalMinimumSats: snap.bitcoinWithdrawalMinimum,
        confirmationThreshold: Number(snap.bitcoinConfirmationThreshold),
        cancellationCooldownMs: Number(snap.withdrawalCancellationCooldownMs),
        dustFloorSats: cfg.hashi.dustFloorSats,
        paused: snap.paused,
        // G5: the trust anchors stay CONFIGURED. The bridge does not publish them on-chain.
        limiter: cfg.limiter,
      };
    },

    /** CLIENT-SIDE P2TR derivation — no server, no network beyond the two on-chain pubkeys. */
    async generateDepositAddress(suiAddress: SuiAddress): Promise<DepositAddress> {
      const p2tr = await sdk().generateDepositAddress({ suiAddress, bitcoinNetwork: btcNetwork });
      return { p2tr, suiAddress };
    },

    /**
     * Register Bitcoin UTXOs against a deposit. The mint is bound to `recipient` through the UTXO
     * derivation path, so no later step (including our own crank) can redirect it (G2).
     */
    async deposit(args: DepositArgs): Promise<{ requestId: string }> {
      const sats = args.utxos.reduce<Sats>((sum, u) => sum + u.sats, 0n);
      // Mirror the mock (and the Move abort) BEFORE spending gas.
      if (sats < cfg.hashi.depositMinimumSats) {
        throw new BelowMinimumDepositError(sats, cfg.hashi.depositMinimumSats);
      }
      const transaction = sdk().tx.deposit({
        txid: args.txid,
        utxos: args.utxos.map((u) => ({ vout: u.vout, amountSats: u.sats })),
        recipient: args.recipient,
      });
      const result = await signAndExecute({ signer: args.signer, transaction });
      return { requestId: requireEventField(result, cfg, 'DepositRequested', 'request_id', at('deposit')) };
    },

    /**
     * The PERMISSIONLESS `confirm_deposit` crank — a public good the keeper runs for EVERYONE.
     *
     * E-K8 gap #2: 0.6.0 ships no binding, so this is a raw `moveCall` against
     * `entry hashi::deposit::confirm_deposit(&mut Hashi, address, &Clock, &mut TxContext)`
     * (docs/FACTS.md#confirm-deposit). It is `entry`, hence a PTB command and NEVER a Move call
     * from `gateway.move` (E-M9). It aborts on-chain before
     * `approval + bitcoin_deposit_time_delay_ms`; we do not pre-check, so the abort is the truth.
     */
    async confirmDeposit(requestId: string, signer: Signer): Promise<{ digest: string }> {
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
          tx.sharedObjectRef({ objectId: SUI_CLOCK_OBJECT_ID, initialSharedVersion: 1, mutable: false }),
        ],
      });
      const result = await signAndExecute({ signer, transaction: tx });
      const digest = txDigestOf(result);
      if (digest === undefined) throw new NotFoundError(at(`confirm_deposit(${requestId}) digest`));
      return { digest };
    },

    /**
     * ⚠⚠ UX / MOCK SURFACE ONLY — NOT the vault exit path (G2).
     *
     * The vault's exit is composed in Move: `gateway::exit_to_bitcoin` reads the PINNED Bitcoin
     * address off the Vault and calls `hashi::withdraw::request_withdrawal` itself. The keeper
     * NEVER passes a Bitcoin address. This method exists so the app can simulate a withdrawal
     * and so `real` stays swappable with `mock`. Do not wire it into `run`/`exit`.
     */
    async requestWithdrawal(args: RequestWithdrawalArgs): Promise<{ requestId: string }> {
      // Same order as hashi::withdraw::request_withdrawal (docs/RECON.md R7) and the mock.
      if (args.sats < cfg.hashi.withdrawalMinimumSats) {
        throw new BelowMinimumWithdrawalError(args.sats, cfg.hashi.withdrawalMinimumSats);
      }
      assertBtcWitnessProgram(args.bitcoinAddress);
      const transaction = sdk().tx.requestWithdrawal({
        amount: args.sats,
        bitcoinAddress: args.bitcoinAddress,
      });
      const result = await signAndExecute({ signer: args.signer, transaction });
      return {
        requestId: requireEventField(result, cfg, 'WithdrawalRequested', 'request_id', at('requestWithdrawal')),
      };
    },

    /**
     * ⚠⚠ Also UX/mock surface only, and DEPOSITOR-CALLABLE ONLY.
     *
     * `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()`
     * (docs/RECON.md R7.3) ⇒ THE KEEPER CAN NEVER CALL IT. The production path is
     * `gateway::reclaim_stalled_exit`, signed by the depositor.
     */
    async cancelWithdrawal(requestId: string, signer: Signer): Promise<{ sats: Sats }> {
      const transaction = sdk().tx.cancelWithdrawal({ requestId, recipient: signer.toSuiAddress() });
      const result = await signAndExecute({ signer, transaction });
      const sats = requireEventField(result, cfg, 'WithdrawalCancelled', 'btc_amount', at('cancelWithdrawal'));
      return { sats: BigInt(sats) };
    },

    /**
     * ⚠ G6: deposit is ~70 min end-to-end and is NEVER on the demo critical path. Resolves once
     * nothing but the permissionless crank is left to do — exactly the mock's rule.
     */
    async waitForDeposit(requestId: string, opts?: WaitOptions): Promise<DepositView> {
      const timeoutMs = opts?.timeoutMs ?? cfg.hashi.waitTimeoutMs;
      const deadlineMs = nowMs() + timeoutMs;
      for (;;) {
        const d = await view.depositStatus(requestId);
        if (d.status === 'Confirmed' || d.status === 'Expired') return d;
        if (d.status === 'Approved' && d.confirmableAtMs !== undefined && nowMs() >= d.confirmableAtMs) return d;
        if (nowMs() >= deadlineMs) throw new TimeoutError(at(`waitForDeposit(${requestId})`), timeoutMs);
        await sleep(cfg.hashi.eventPollIntervalMs);
      }
    },

    /** ⚠ G6: ~1.5–2 h end-to-end. Same rule as {@link waitForDeposit}. */
    async waitForWithdrawal(requestId: string, opts?: WaitOptions): Promise<WithdrawalView> {
      const timeoutMs = opts?.timeoutMs ?? cfg.hashi.waitTimeoutMs;
      const deadlineMs = nowMs() + timeoutMs;
      for (;;) {
        const w = await view.withdrawalStatus(requestId);
        if (w.status === 'Confirmed' || w.status === 'Cancelled') return w;
        if (nowMs() >= deadlineMs) throw new TimeoutError(at(`waitForWithdrawal(${requestId})`), timeoutMs);
        await sleep(cfg.hashi.eventPollIntervalMs);
      }
    },

    /**
     * The G5 trust anchor. Raw events → `normalize.ts` → the same `HashiEvent` log the mock emits.
     * Never the SDK's convenience readers: the whole point is that the limiter is re-derivable
     * from the public stream.
     */
    async eventsSince(
      cursor: EventCursor,
      opts?: EventsSinceOptions,
    ): Promise<{ events: readonly HashiEvent[]; next: EventCursor }> {
      return await readEvents(cursor, opts);
    },

    /** The `WithdrawalSigned` sub-stream — the ONLY events that advance the bucket (G5). */
    async signedEventsSince(
      cursor: EventCursor,
    ): Promise<{ events: readonly HashiEventOf<'WithdrawalSigned'>[]; next: EventCursor }> {
      const page = await readEvents(cursor, { kinds: ['WithdrawalSigned'] satisfies readonly HashiEventKind[] });
      return {
        events: page.events.filter((e): e is HashiEventOf<'WithdrawalSigned'> => e.kind === 'WithdrawalSigned'),
        next: page.next,
      };
    },
  };

  return adapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `client.$extend(hashi({...}))` — the documented wiring, spelled as the registration call so it
 * type-checks against both transports without a cast. All ids come from Config (G7).
 */
export function buildSdkClient(cfg: Config, client: AnySuiClient): HashiSdkClient {
  const registration = hashiExtension({
    hashiObjectId: cfg.hashi.objectId,
    packageId: cfg.hashi.packageId,
    bitcoinNetwork: bitcoinNetworkFor(cfg),
    guardianUrl: cfg.hashi.guardianUrl,
  });
  // Typed as `HashiClient` first so a breaking 0.6.x change is a COMPILE error here, not a
  // runtime surprise on the demo floor; the structural narrowing to HashiSdkClient is implicit.
  const sdk: HashiClient = registration.register(client);
  return sdk;
}

/**
 * The Bitcoin network that pairs with the Sui network in force.
 *
 * Sui **testnet** ⇒ Bitcoin **signet** (docs/FACTS.md). There is no env var for this: it is a
 * property of the deployment, not a tunable.
 */
export function bitcoinNetworkFor(cfg: Config): BitcoinNetwork {
  return cfg.sui.network === 'mainnet' ? 'mainnet' : 'signet';
}

/**
 * Default event pager: JSON-RPC `suix_queryEvents`, oldest-first, filtered by **MoveEventModule**.
 *
 * ⚠ E-K8 gap #3 + RECON R1: gRPC v2 has no event RPC, and `fullnode.testnet.sui.io` serves ONLY
 * gRPC, so this deliberately targets `cfg.sui.jsonRpcUrl` (a verified mirror) even when the
 * keeper's default transport is gRPC.
 * ⚠ `MoveModule` filters the EMITTING module and returns ZERO rows for `withdrawal_queue::*`
 * (they are emitted from module `withdraw`). `MoveEventModule` filters where the struct is
 * DEFINED — verified live by scripts/verify-onchain.mjs P5.
 */
export function buildJsonRpcEventQuery(cfg: Config): EventQuery {
  if (cfg.sui.jsonRpcUrl === '') {
    throw new UnsupportedByUpstreamError(
      'eventsSince',
      'gRPC v2 exposes no event-query RPC and SUI_JSON_RPC_URL is empty — set a verified JSON-RPC mirror or inject RealHashiDeps.eventQuery',
    );
  }
  const rpc = createJsonRpcClient(cfg);
  return async ({ packageId, module, cursor, limit }) => {
    const page = await rpc.queryEvents({
      query: { MoveEventModule: { package: packageId, module } },
      cursor: cursor === null ? null : { txDigest: cursor.txDigest, eventSeq: cursor.eventSeq },
      limit,
      order: 'ascending',
    });
    return {
      data: page.data as unknown as readonly RawSuiEvent[],
      nextCursor:
        page.nextCursor === null || page.nextCursor === undefined
          ? null
          : { txDigest: page.nextCursor.txDigest, eventSeq: page.nextCursor.eventSeq },
      hasNextPage: page.hasNextPage,
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping + parsing (transport-shape tolerant: gRPC and JSON-RPC differ)
// ─────────────────────────────────────────────────────────────────────────────

/** SDK `DepositInfo` -> our `DepositView`. 'pending' splits on whether the committee approved. */
export function depositViewOf(info: SdkDepositInfo): DepositView {
  const status: DepositStatus =
    info.status === 'confirmed'
      ? 'Confirmed'
      : info.status === 'expired'
        ? 'Expired'
        : info.approvalTimestampMs === null
          ? 'Requested'
          : 'Approved';
  return {
    requestId: info.requestId,
    status,
    sats: info.amountSats,
    recipient: info.recipient ?? '',
    ...(info.confirmableAtMs === null ? {} : { confirmableAtMs: Number(info.confirmableAtMs) }),
  };
}

/** SDK `WithdrawalInfo` -> our `WithdrawalView`. 'Processing' is the SDK's name for the pick. */
export function withdrawalViewOf(info: SdkWithdrawalInfo): WithdrawalView {
  const status: WithdrawalStatus =
    info.status === 'Processing' ? 'PickedForProcessing' : info.status === 'cancelled' ? 'Cancelled' : info.status;
  return {
    requestId: info.requestId,
    status,
    sats: info.btcAmountSats,
    bitcoinAddress: info.bitcoinAddress,
    ...(info.btcTxid === null ? {} : { signetTxid: info.btcTxid }),
  };
}

/**
 * Total order over raw events: (envelope ms, txDigest, eventSeq).
 *
 * Three module streams are merged into one log, so the ordering has to be a pure function of the
 * events themselves — otherwise two keepers reading the same range would assign different `seq`
 * and their replays would diverge (G5).
 */
export function compareRawEvents(a: RawSuiEvent, b: RawSuiEvent): number {
  const at = millisOf(a.timestampMs);
  const bt = millisOf(b.timestampMs);
  if (at !== bt) return at - bt;
  const ad = a.transactionDigest ?? a.id?.txDigest ?? '';
  const bd = b.transactionDigest ?? b.id?.txDigest ?? '';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const as = Number(a.id?.eventSeq ?? 0);
  const bs = Number(b.id?.eventSeq ?? 0);
  return as - bs;
}

/** `$kind`-tagged execution result -> digest, for both gRPC and JSON-RPC shapes. */
export function txDigestOf(result: unknown): string | undefined {
  const root = asRecord(result);
  if (root === undefined) return undefined;
  const inner = asRecord(root['Transaction']) ?? asRecord(root['FailedTransaction']) ?? root;
  const digest = inner['digest'];
  return typeof digest === 'string' ? digest : undefined;
}

/** Events emitted by an execution result, normalized to the `{type, parsedJson}` shape. */
export function txEventsOf(result: unknown): readonly RawSuiEvent[] {
  const root = asRecord(result);
  if (root === undefined) return [];
  const inner = asRecord(root['Transaction']) ?? asRecord(root['FailedTransaction']) ?? root;
  const raw = inner['events'];
  // gRPC nests as `{events: {events: [...]}}`; JSON-RPC and the core client return a bare array.
  const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw)?.['events']) ? asRecord(raw)?.['events'] : undefined;
  if (!Array.isArray(list)) return [];
  const out: RawSuiEvent[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const type = rec['type'] ?? rec['eventType'];
    if (typeof type !== 'string') continue;
    out.push({
      type,
      parsedJson: rec['parsedJson'] ?? rec['json'] ?? {},
      timestampMs: asTimestamp(rec['timestampMs']),
      ...(typeof rec['transactionDigest'] === 'string' ? { transactionDigest: rec['transactionDigest'] } : {}),
    });
  }
  return out;
}

/**
 * Pull one field out of the first event of `kind` in an execution result.
 *
 * The requestId is only available this way: `request_withdrawal`/`deposit` return nothing, so the
 * emitted event IS the receipt. A missing event means the transaction did not do what we asked.
 */
function requireEventField(
  result: unknown,
  cfg: Config,
  kind: HashiEventKind,
  field: string,
  what: string,
): string {
  for (const raw of txEventsOf(result)) {
    if (parseHashiEventKind(cfg, raw.type) !== kind) continue;
    const value = asRecord(raw.parsedJson)?.[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  throw new NotFoundError(`${what}: no ${kind}.${field} in the execution result`);
}

// ── tiny structural helpers (no `any`, no transport-specific types) ──────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function millisOf(value: string | number | null | undefined): Millis {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function asTimestamp(value: unknown): string | number | null {
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  return null;
}

function pickBigInt(record: Record<string, unknown>, keys: readonly string[]): bigint | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-exported Bitcoin address codecs (both REQUIRE the network argument — E-K10).
 *
 * G7: `@mysten/hashi` may only be imported here, so anything that needs bech32(m) <-> witness
 * program has to come through this door. `BtcAddress` in our types is ALWAYS the raw witness
 * program; these are the only sanctioned conversions to and from the display form.
 */
export const btcAddressCodec = Object.freeze({
  toWitnessProgram: bitcoinAddressToWitnessProgram,
  fromWitnessProgram: witnessProgramToAddress,
});

/** Re-exported for T2.1 so the implementer sees which config the adapter is pinned to. */
export type RealHashiConfig = Config['hashi'];
