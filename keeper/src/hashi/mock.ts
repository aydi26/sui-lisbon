// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §2.4 (MOCK — deterministic, no network, logical clock)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.5 acceptance)
// @spec       docs/RECON.md#r6 (live bridge config the mock is seeded from), #r7 (Move aborts), #r9 (limiter)
// @rules      G1 G2 G3 G5 G6 G7
// @depends    ./adapter.ts · ./limiter.ts · ./types.ts · ../util/{rng,bytes,errors}.ts · ../config.ts
// @facts      Seeded from the LIVE on-chain Hashi config (docs/RECON.md R6):
// @facts        bitcoin_deposit_time_delay_ms      = 600_000
// @facts        bitcoin_deposit_minimum            = 30_000 sats
// @facts        bitcoin_withdrawal_minimum         = 30_000 sats
// @facts        bitcoin_confirmation_threshold     = 6
// @facts        withdrawal_cancellation_cooldown_ms= 3_600_000
// @facts      Limiter genesis = full bucket, last_updated_at 0, next_seq 0 (docs/RECON.md R9).
// @facts      Real latencies modelled (G6): deposit ~70 min, withdrawal ~1.5–2 h. Compressible
// @facts        via MockOptions for tests; the DEFAULTS are the real ones.
// @facts      ⚠ `confirm_deposit` is PERMISSIONLESS and EXPLICIT — the mock never auto-confirms
// @facts        a deposit. That crank is the live, fast, on-camera step of the demo.
// @implements export interface MockOptions
// @implements export interface MockHashiAdapter extends HashiAdapter
// @implements export function createMockHashiAdapter(cfg: Config, overrides?: Partial<MockOptions>): MockHashiAdapter
// @implements export function defaultMockOptions(cfg: Config): MockOptions
// @forbidden  Date.now() / Math.random() / any I/O anywhere in this file — the mock is a
//             LOGICAL-clock simulation; determinism is the product (G5)
// @forbidden  importing '@mysten/hashi' (G7)
// @forbidden  queueing an over-capacity batch — it is REJECTED and the bucket is untouched (G3)
// @invariant  1. The bucket advances ONLY through `consume()` from ./limiter.ts, once per emitted
//                WithdrawalSigned, with seq === state.nextSeq. No gaps ⇒ a replay that assigns
//                seq = index reproduces the state exactly.
// @invariant  2. RateLimitExceeded ⇒ NO WithdrawalSigned is emitted and the state is untouched;
//                the batch is retried later, never prioritised (G3).
// @invariant  3. guardian.limiterStatus() at logical t === deriveLimiter(signedEventsSince(0)) at t.
// @invariant  4. Every emitted event's atMs is its EXACT transition time, so results do not depend
//                on how coarsely the caller advances the clock.
// @invariant  5. Event `seq` equals the event's index in the log.
// @ac         docs/KEEPER.md §13 A1 (offline end-to-end) + A2 (mock ↔ replay parity)
// @verify     npm test -- hashi.mock
// @verify     npm test -- limiter.cross
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Config } from '../config.js';
import type { Millis, SuiAddress } from '../types.js';
import { assertBtcWitnessProgram } from '../util/bytes.js';
import {
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  CannotCancelProcessingWithdrawalError,
  CooldownNotElapsedError,
  NotFoundError,
  NotReadyError,
  TimeoutError,
  UnauthorizedCancellationError,
} from '../util/errors.js';
import { createRng, seedFrom, type Rng } from '../util/rng.js';

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
import { consume, genesis, msToSecs, projectCapacityAtSecs, type LimiterState } from './limiter.js';
import type {
  BtcAddress,
  DepositAddress,
  DepositStatus,
  DepositView,
  EventCursor,
  HashiEvent,
  HashiEventKind,
  HashiEventOf,
  LimiterStatus,
  Sats,
  WithdrawalStatus,
  WithdrawalView,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface MockOptions {
  /** Any string. Same seed ⇒ byte-identical run. */
  readonly seed: string;
  /** Logical t0 in ms. The bucket's genesis `last_updated_at` is 0 s regardless. */
  readonly startMs: Millis;
  /** Requested -> Approved: 6 signet confirmations + committee approval (G6: ~60 min real). */
  readonly depositApprovalDelayMs: Millis;
  /** Approved -> crank-eligible: the on-chain `bitcoin_deposit_time_delay_ms`. */
  readonly depositConfirmDelayMs: Millis;
  /** Requested -> Approved for withdrawals. */
  readonly withdrawalApprovalDelayMs: Millis;
  /** Approved -> PickedForProcessing (batch window, ~10 min real). */
  readonly withdrawalBatchDelayMs: Millis;
  /** PickedForProcessing -> Signed (MPC + guardian signing). */
  readonly withdrawalSignDelayMs: Millis;
  /** Signed -> Confirmed (broadcast + 6 confirmations). */
  readonly withdrawalConfirmDelayMs: Millis;
  /** Retry cadence after a RateLimitExceeded rejection. G3: retry, NEVER prioritise. */
  readonly signRetryIntervalMs: Millis;
  /** After this many rejected sign attempts the leader drops the batch (it is never queued, G3). */
  readonly maxSignRetries: number;
  /**
   * Ordering is committee-leader-discretionary — "generally FIFO, NOT strict" (G3).
   * Deterministic per-request pick jitter in `[0, leaderReorderWindow)` ms. 0 = strict FIFO.
   */
  readonly leaderReorderWindow: Millis;
  /** Clock step used by `waitFor*`. The mock advances a LOGICAL clock; it never sleeps. */
  readonly stepMs: Millis;
  /** Safety valve for the discrete-event pump. */
  readonly maxPumpIterations: number;
}

/** Real-latency defaults, seeded from the live on-chain config (docs/RECON.md R6). */
export function defaultMockOptions(cfg: Config): MockOptions {
  return {
    seed: 'aphotic-hashi-mock',
    startMs: 0,
    depositApprovalDelayMs: 3_600_000, // ~6 signet blocks + approval ≈ 60 min
    depositConfirmDelayMs: cfg.hashi.depositTimeDelayMs, // 600_000 — the on-chain delay
    withdrawalApprovalDelayMs: 600_000,
    withdrawalBatchDelayMs: 600_000,
    withdrawalSignDelayMs: 600_000,
    withdrawalConfirmDelayMs: 3_600_000,
    signRetryIntervalMs: 600_000,
    maxSignRetries: 32,
    leaderReorderWindow: 0,
    stepMs: 60_000,
    maxPumpIterations: 100_000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────

interface MockDeposit {
  readonly requestId: string;
  readonly recipient: SuiAddress;
  readonly sats: Sats;
  readonly requestedAtMs: Millis;
  readonly index: number;
  status: DepositStatus;
  approvedAtMs?: Millis;
  confirmedAtMs?: Millis;
}

interface MockWithdrawal {
  readonly requestId: string;
  readonly requester: SuiAddress;
  readonly sats: Sats;
  readonly bitcoinAddress: BtcAddress;
  readonly requestedAtMs: Millis;
  readonly index: number;
  /** Deterministic per-request pick jitter (leader discretion, G3). */
  readonly pickJitterMs: Millis;
  status: WithdrawalStatus;
  approvedAtMs?: Millis;
  pickedAtMs?: Millis;
  signedAtMs?: Millis;
  /** Next sign attempt after a RateLimitExceeded rejection. */
  nextSignAttemptAtMs?: Millis;
  /** Rejected sign attempts so far (G3: rejection + retry, never a priority queue). */
  signAttempts: number;
  /** The leader gave up on this batch — schedule nothing further. */
  signAbandoned?: boolean;
  withdrawalTxnId?: string;
  signetTxid?: string;
}

/** `Omit` that distributes over a union so the discriminant survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<HashiEvent, 'seq' | 'atMs' | 'atSecs'>;

interface PendingTransition {
  readonly atMs: Millis;
  /** Deterministic tie-break within the same millisecond. */
  readonly order: number;
  readonly apply: (atMs: Millis) => void;
}

export interface MockHashiAdapter extends HashiAdapter {
  readonly kind: 'mock';
  readonly options: MockOptions;
  /** Current LOGICAL time. Never wall-clock. */
  nowMs(): Millis;
  /** Advance the logical clock and run every transition that becomes due. */
  advanceMs(deltaMs: Millis): void;
  /** Jump the logical clock to an absolute ms. Never moves backwards. */
  setNowMs(atMs: Millis): void;
  /** The internal bucket. Exposed for the mock↔replay parity assertion (A2). */
  limiterState(): LimiterState;
  /** The full deterministic event log, seq-ordered. */
  eventLog(): readonly HashiEvent[];
  /** Credit hBTC directly — for staging vault fixtures without a full deposit lifecycle. */
  creditBalance(suiAddress: SuiAddress, sats: Sats): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMockHashiAdapter(cfg: Config, overrides: Partial<MockOptions> = {}): MockHashiAdapter {
  const options: MockOptions = { ...defaultMockOptions(cfg), ...overrides };

  const rng: Rng = createRng(seedFrom(options.seed));
  const events: HashiEvent[] = [];
  const deposits = new Map<string, MockDeposit>();
  const withdrawals = new Map<string, MockWithdrawal>();
  const balances = new Map<SuiAddress, Sats>();

  let nowMs: Millis = options.startMs;
  let limiter: LimiterState = genesis(cfg.limiter);
  let depositCount = 0;
  let withdrawalCount = 0;

  // ── event log ──────────────────────────────────────────────────────────────

  function emit(draft: EventDraft, atMs: Millis): void {
    // The cast re-attaches the base fields onto whichever union member `draft` is.
    events.push({ ...draft, seq: BigInt(events.length), atMs, atSecs: msToSecs(atMs) } as HashiEvent);
  }

  function mockId(): string {
    return `0x${rng.hex(32)}`;
  }

  function mockDigest(): string {
    return `MOCK${rng.hex(16)}`;
  }

  function credit(address: SuiAddress, sats: Sats): void {
    balances.set(address, (balances.get(address) ?? 0n) + sats);
  }

  function debit(address: SuiAddress, sats: Sats): void {
    const current = balances.get(address) ?? 0n;
    balances.set(address, current > sats ? current - sats : 0n);
  }

  // ── discrete-event pump ────────────────────────────────────────────────────

  function collectTransitions(): PendingTransition[] {
    const pending: PendingTransition[] = [];

    for (const d of deposits.values()) {
      if (d.status === 'Requested') {
        pending.push({
          atMs: d.requestedAtMs + options.depositApprovalDelayMs,
          order: d.index * 2,
          apply: (atMs) => {
            d.status = 'Approved';
            d.approvedAtMs = atMs;
            emit({ kind: 'DepositApproved', requestId: d.requestId, sats: d.sats, approvalTimestampMs: atMs }, atMs);
          },
        });
      }
      // Approved -> Confirmed is NOT automatic: `confirm_deposit` is a permissionless,
      // explicitly-cranked entry function (G7 demo beat). See confirmDeposit().
    }

    for (const w of withdrawals.values()) {
      const order = 1_000_000 + w.index * 4;
      if (w.status === 'Requested') {
        pending.push({
          atMs: w.requestedAtMs + options.withdrawalApprovalDelayMs,
          order,
          apply: (atMs) => {
            w.status = 'Approved';
            w.approvedAtMs = atMs;
            emit({ kind: 'WithdrawalApproved', requestId: w.requestId }, atMs);
          },
        });
      } else if (w.status === 'Approved' && w.approvedAtMs !== undefined) {
        pending.push({
          atMs: w.approvedAtMs + options.withdrawalBatchDelayMs + w.pickJitterMs,
          order: order + 1,
          apply: (atMs) => {
            w.status = 'PickedForProcessing';
            w.pickedAtMs = atMs;
            w.withdrawalTxnId = mockId();
            emit(
              {
                kind: 'WithdrawalPickedForProcessing',
                withdrawalTxnId: w.withdrawalTxnId,
                txid: mockId(),
                requestIds: [w.requestId],
                outputs: [{ sats: w.sats, bitcoinAddress: w.bitcoinAddress }],
              },
              atMs,
            );
          },
        });
      } else if (w.status === 'PickedForProcessing' && w.pickedAtMs !== undefined && w.signAbandoned !== true) {
        const dueAtMs = w.nextSignAttemptAtMs ?? w.pickedAtMs + options.withdrawalSignDelayMs;
        pending.push({ atMs: dueAtMs, order: order + 2, apply: (atMs) => attemptSign(w, atMs) });
      } else if (w.status === 'Signed' && w.signedAtMs !== undefined) {
        pending.push({
          atMs: w.signedAtMs + options.withdrawalConfirmDelayMs,
          order: order + 3,
          apply: (atMs) => {
            w.status = 'Confirmed';
            w.signetTxid = rng.hex(32);
            emit(
              {
                kind: 'WithdrawalConfirmed',
                withdrawalTxnId: w.withdrawalTxnId ?? '',
                txid: w.signetTxid,
                requestIds: [w.requestId],
              },
              atMs,
            );
          },
        });
      }
    }

    return pending;
  }

  /**
   * ★ THE bucket advance (G5). One `consume` per emitted `WithdrawalSigned`, at the
   * event's exact transition second, with `seq === limiter.nextSeq`.
   *
   * G3: on `RateLimitExceeded` the batch is REJECTED — no event, bucket untouched — and simply
   * retried later. It is never queued and it never buys priority.
   */
  function attemptSign(w: MockWithdrawal, atMs: Millis): void {
    const result = consume(cfg.limiter, limiter, limiter.nextSeq, msToSecs(atMs), w.sats);

    if (!result.ok) {
      w.signAttempts += 1;
      const retryable =
        result.error === 'RateLimitExceeded' &&
        w.sats <= cfg.limiter.maxBucketCapacitySats &&
        w.signAttempts < options.maxSignRetries;
      if (retryable) {
        w.nextSignAttemptAtMs = atMs + options.signRetryIntervalMs;
        return;
      }
      // The amount can never fit the bucket, or the leader gave up. It is DROPPED, not queued (G3).
      w.nextSignAttemptAtMs = undefined;
      w.signAbandoned = true;
      return;
    }

    limiter = result.state;
    w.status = 'Signed';
    w.signedAtMs = atMs;
    w.nextSignAttemptAtMs = undefined;

    emit(
      {
        kind: 'WithdrawalInputsSigned',
        withdrawalTxnId: w.withdrawalTxnId ?? '',
        signedCount: 1n,
        numInputs: 1n,
      },
      atMs,
    );
    emit(
      {
        kind: 'WithdrawalSigned',
        withdrawalTxnId: w.withdrawalTxnId ?? '',
        requestIds: [w.requestId],
        // Synthesised exactly as normalize.ts does on a real stream: joined from the request.
        sats: w.sats,
        satsSource: 'requested',
        signatureCount: 1,
      },
      atMs,
    );
    // Batch commit burns the hBTC.
    emit({ kind: 'Burned', coinType: cfg.hashi.hbtcCoinType, sats: w.sats }, atMs);
  }

  /**
   * Run every transition whose due time is <= the logical clock, in (time, order) sequence.
   * Emitted timestamps are exact transition times ⇒ results do not depend on step size.
   */
  function pump(): void {
    for (let i = 0; i < options.maxPumpIterations; i++) {
      const pending = collectTransitions().filter((t) => t.atMs <= nowMs);
      if (pending.length === 0) return;
      let next = pending[0] as PendingTransition;
      for (const candidate of pending) {
        if (candidate.atMs < next.atMs || (candidate.atMs === next.atMs && candidate.order < next.order)) {
          next = candidate;
        }
      }
      next.apply(next.atMs);
    }
    throw new Error(`mock pump exceeded ${options.maxPumpIterations} iterations — non-terminating simulation`);
  }

  function setNowMs(atMs: Millis): void {
    if (atMs > nowMs) nowMs = atMs;
    pump();
  }

  function advanceMs(deltaMs: Millis): void {
    setNowMs(nowMs + Math.max(0, deltaMs));
  }

  // ── views ──────────────────────────────────────────────────────────────────

  function depositOf(requestId: string): MockDeposit {
    const d = deposits.get(requestId);
    if (d === undefined) throw new NotFoundError(`deposit ${requestId}`);
    return d;
  }

  function withdrawalOf(requestId: string): MockWithdrawal {
    const w = withdrawals.get(requestId);
    if (w === undefined) throw new NotFoundError(`withdrawal ${requestId}`);
    return w;
  }

  function confirmableAtMs(d: MockDeposit): Millis | undefined {
    return d.approvedAtMs === undefined ? undefined : d.approvedAtMs + options.depositConfirmDelayMs;
  }

  function depositView(d: MockDeposit): DepositView {
    const readyAt = confirmableAtMs(d);
    return {
      requestId: d.requestId,
      status: d.status,
      sats: d.sats,
      recipient: d.recipient,
      ...(readyAt === undefined ? {} : { confirmableAtMs: readyAt }),
    };
  }

  function withdrawalView(w: MockWithdrawal): WithdrawalView {
    return {
      requestId: w.requestId,
      status: w.status,
      sats: w.sats,
      bitcoinAddress: w.bitcoinAddress,
      ...(w.signetTxid === undefined ? {} : { signetTxid: w.signetTxid }),
    };
  }

  const view: HashiViews = {
    async balance(suiAddress) {
      pump();
      return balances.get(suiAddress) ?? 0n;
    },
    async depositStatus(requestId) {
      pump();
      return depositView(depositOf(requestId));
    },
    async withdrawalStatus(requestId) {
      pump();
      return withdrawalView(withdrawalOf(requestId));
    },
    async all(suiAddress) {
      pump();
      return {
        deposits: [...deposits.values()].filter((d) => d.recipient === suiAddress).map(depositView),
        withdrawals: [...withdrawals.values()].filter((w) => w.requester === suiAddress).map(withdrawalView),
      };
    },
  };

  const guardian: HashiGuardianViews = {
    async limiterStatus(): Promise<LimiterStatus> {
      pump();
      const asOfSecs = msToSecs(nowMs);
      return {
        tokens: projectCapacityAtSecs(cfg.limiter, limiter, asOfSecs),
        refillRate: cfg.limiter.refillRateSatsPerSec,
        maxBucketCapacity: cfg.limiter.maxBucketCapacitySats,
        asOfMs: nowMs,
        asOfSecs,
        nextSeq: limiter.nextSeq,
        // The mock's bucket IS the replay of its own emitted signed stream (invariant 3).
        source: 'replay',
      };
    },
    async canWithdraw(sats) {
      pump();
      if (sats < cfg.hashi.withdrawalMinimumSats) return false;
      return projectCapacityAtSecs(cfg.limiter, limiter, msToSecs(nowMs)) >= sats;
    },
  };

  // ── the adapter ────────────────────────────────────────────────────────────

  const adapter: MockHashiAdapter = {
    kind: 'mock',
    options,
    view,
    guardian,

    nowMs: () => nowMs,
    advanceMs,
    setNowMs,
    limiterState: () => limiter,
    eventLog: () => events,
    creditBalance: (suiAddress, sats) => credit(suiAddress, sats),

    async bridgeConfig(): Promise<BridgeConfig> {
      return {
        adapter: 'mock',
        packageId: cfg.hashi.packageId,
        objectId: cfg.hashi.objectId,
        hbtcCoinType: cfg.hashi.hbtcCoinType,
        guardianUrl: cfg.hashi.guardianUrl,
        depositTimeDelayMs: cfg.hashi.depositTimeDelayMs,
        depositMinimumSats: cfg.hashi.depositMinimumSats,
        withdrawalMinimumSats: cfg.hashi.withdrawalMinimumSats,
        confirmationThreshold: cfg.hashi.confirmationThreshold,
        cancellationCooldownMs: cfg.hashi.cancellationCooldownMs,
        dustFloorSats: cfg.hashi.dustFloorSats,
        paused: false,
        limiter: cfg.limiter,
      };
    },

    /**
     * Deterministic stand-in for the SDK's client-side P2TR derivation. It is NOT a real
     * bech32m taproot address — real derivation lives in hashi/real.ts (T2.1). Same Sui
     * address ⇒ same mock deposit address, forever.
     */
    async generateDepositAddress(suiAddress): Promise<DepositAddress> {
      const local = createRng(seedFrom(options.seed, 'deposit-address', suiAddress));
      const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      let body = '';
      for (let i = 0; i < 58; i++) body += charset[local.nextInt(charset.length)] ?? 'q';
      return { p2tr: `tb1p${body}`, suiAddress };
    },

    async deposit(args: DepositArgs): Promise<{ requestId: string }> {
      pump();
      const sats = args.utxos.reduce<Sats>((sum, u) => sum + u.sats, 0n);
      if (sats < cfg.hashi.depositMinimumSats) {
        throw new BelowMinimumDepositError(sats, cfg.hashi.depositMinimumSats);
      }
      const requestId = mockId();
      const d: MockDeposit = {
        requestId,
        recipient: args.recipient,
        sats,
        requestedAtMs: nowMs,
        index: depositCount++,
        status: 'Requested',
      };
      deposits.set(requestId, d);
      emit(
        { kind: 'DepositRequested', requestId, sats, requesterAddress: args.signer.toSuiAddress(), derivationPath: args.recipient },
        nowMs,
      );
      return { requestId };
    },

    /**
     * The PERMISSIONLESS crank. Anyone may call it for anyone's deposit; the mint lands at
     * the recipient encoded in the derivation path, so the caller cannot redirect it (G2).
     * Throws NotReady before `approval + bitcoin_deposit_time_delay_ms`, exactly like the
     * on-chain abort.
     */
    async confirmDeposit(requestId, _signer: Signer): Promise<{ digest: string }> {
      pump();
      const d = depositOf(requestId);
      if (d.status === 'Confirmed') return { digest: mockDigest() };
      if (d.status !== 'Approved' || d.approvedAtMs === undefined) {
        throw new NotReadyError(
          `deposit ${requestId} (status ${d.status})`,
          d.requestedAtMs + options.depositApprovalDelayMs + options.depositConfirmDelayMs,
          nowMs,
        );
      }
      const readyAt = d.approvedAtMs + options.depositConfirmDelayMs;
      if (nowMs < readyAt) throw new NotReadyError(`deposit ${requestId}`, readyAt, nowMs);

      d.status = 'Confirmed';
      d.confirmedAtMs = nowMs;
      credit(d.recipient, d.sats);
      emit({ kind: 'DepositConfirmed', requestId, sats: d.sats }, nowMs);
      emit({ kind: 'Minted', coinType: cfg.hashi.hbtcCoinType, sats: d.sats }, nowMs);
      return { digest: mockDigest() };
    },

    async requestWithdrawal(args: RequestWithdrawalArgs): Promise<{ requestId: string }> {
      pump();
      // Order mirrors hashi::withdraw::request_withdrawal (docs/RECON.md R7).
      if (args.sats < cfg.hashi.withdrawalMinimumSats) {
        throw new BelowMinimumWithdrawalError(args.sats, cfg.hashi.withdrawalMinimumSats);
      }
      assertBtcWitnessProgram(args.bitcoinAddress);

      const requester = args.signer.toSuiAddress();
      const requestId = mockId();
      const pickJitterMs =
        options.leaderReorderWindow > 0 ? rng.nextInt(options.leaderReorderWindow) : 0;
      const w: MockWithdrawal = {
        requestId,
        requester,
        sats: args.sats,
        bitcoinAddress: args.bitcoinAddress,
        requestedAtMs: nowMs,
        index: withdrawalCount++,
        pickJitterMs,
        signAttempts: 0,
        status: 'Requested',
      };
      withdrawals.set(requestId, w);
      debit(requester, args.sats);
      emit(
        {
          kind: 'WithdrawalRequested',
          requestId,
          sats: args.sats,
          bitcoinAddress: args.bitcoinAddress,
          requesterAddress: requester,
        },
        nowMs,
      );
      return { requestId };
    },

    async cancelWithdrawal(requestId, signer: Signer): Promise<{ sats: Sats }> {
      pump();
      const w = withdrawalOf(requestId);
      const caller = signer.toSuiAddress();
      // ⚠ RECON R7.3: sender-bound. The keeper can NEVER cancel someone else's withdrawal.
      if (caller !== w.requester) throw new UnauthorizedCancellationError(w.requester, caller);
      if (w.status !== 'Requested' && w.status !== 'Approved') {
        throw new CannotCancelProcessingWithdrawalError(requestId, w.status);
      }
      const readyAt = w.requestedAtMs + cfg.hashi.cancellationCooldownMs;
      if (nowMs < readyAt) throw new CooldownNotElapsedError(readyAt, nowMs);

      w.status = 'Cancelled';
      credit(w.requester, w.sats);
      emit({ kind: 'WithdrawalCancelled', requestId, requesterAddress: w.requester, sats: w.sats }, nowMs);
      return { sats: w.sats };
    },

    /**
     * Resolves when nothing but the PERMISSIONLESS crank is left to do: `Confirmed`/`Expired`,
     * or `Approved` past its `bitcoin_deposit_time_delay_ms` (i.e. crank-eligible). The mock
     * advances its LOGICAL clock in `stepMs` increments; it never sleeps (G6).
     */
    async waitForDeposit(requestId, opts?: WaitOptions): Promise<DepositView> {
      pump();
      const timeoutMs = opts?.timeoutMs ?? cfg.hashi.waitTimeoutMs;
      const deadlineMs = nowMs + timeoutMs;
      for (;;) {
        const d = depositOf(requestId);
        const readyAt = confirmableAtMs(d);
        if (d.status === 'Confirmed' || d.status === 'Expired') return depositView(d);
        if (d.status === 'Approved' && readyAt !== undefined && nowMs >= readyAt) return depositView(d);
        if (nowMs >= deadlineMs) throw new TimeoutError(`waitForDeposit(${requestId})`, timeoutMs);
        setNowMs(Math.min(nowMs + Math.max(1, options.stepMs), deadlineMs));
      }
    },

    /** Resolves at `Confirmed` or `Cancelled`. Logical clock only — never sleeps (G6). */
    async waitForWithdrawal(requestId, opts?: WaitOptions): Promise<WithdrawalView> {
      pump();
      const timeoutMs = opts?.timeoutMs ?? cfg.hashi.waitTimeoutMs;
      const deadlineMs = nowMs + timeoutMs;
      for (;;) {
        const w = withdrawalOf(requestId);
        if (w.status === 'Confirmed' || w.status === 'Cancelled') return withdrawalView(w);
        if (nowMs >= deadlineMs) throw new TimeoutError(`waitForWithdrawal(${requestId})`, timeoutMs);
        setNowMs(Math.min(nowMs + Math.max(1, options.stepMs), deadlineMs));
      }
    },

    async eventsSince(cursor: EventCursor, opts?: EventsSinceOptions) {
      pump();
      const kinds: readonly HashiEventKind[] | undefined = opts?.kinds;
      const limit = opts?.limit;
      const out: HashiEvent[] = [];
      let i = Number(cursor.seq < 0n ? 0n : cursor.seq);
      for (; i < events.length; i++) {
        const event = events[i] as HashiEvent;
        if (kinds === undefined || kinds.includes(event.kind)) out.push(event);
        if (limit !== undefined && out.length >= limit) {
          i++;
          break;
        }
      }
      return { events: out, next: { seq: BigInt(i) } };
    },

    async signedEventsSince(cursor: EventCursor) {
      const page = await adapter.eventsSince(cursor, { kinds: ['WithdrawalSigned'] });
      return {
        events: page.events.filter((e): e is HashiEventOf<'WithdrawalSigned'> => e.kind === 'WithdrawalSigned'),
        next: page.next,
      };
    },
  };

  return adapter;
}
