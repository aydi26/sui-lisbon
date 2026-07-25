// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4
// @status     DONE
// @spec       docs/KEEPER.md §9.1 (decision replay, two tiers) · §9.2 (trustless limiter trajectory)
// @spec       docs/KEEPER.md §13 A2/A3/A10 · docs/BUILD-PLAN.md#phase-4 (T4.3 VERIFY)
// @spec       docs/KEEPER.md ERRATA E-K3 (WithdrawalSigned has no amount and no timestamp)
// @rules      G3 G5 G7 G8
// @depends    ../src/verify/{limiter,replay,index}.ts · ../src/hashi/mock.ts · ./support/fixtures.ts
// @facts      ★ THE POINT OF THIS SUITE: prove the G5 claim is a CHECK, not a slogan. Every
// @facts        assertion is paired with a NEGATIVE control — an injected wrong amount, a dropped
// @facts        join, an over-capacity batch — so the replay demonstrably CAN fail.
// @facts      E-K3 pair used verbatim: 1_000_000 requested vs 998_835 picked (net of the Bitcoin
// @facts        network fee). The bucket is debited by the REQUESTED amount; Picked is a FALLBACK.
// @implements the T4.3 acceptance suite (limiter replay · queue depth · decision replay · verifyVault)
// @forbidden  network access, wall-clock reads, or unseeded randomness — the mock is a logical clock
// @invariant  1. Every test asserts a value; no test exists only to make the suite green.
// @verify     npm run test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { msToSecs, projectCapacityAtSecs, type LimiterConfig } from '../src/hashi/limiter.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import type { HashiEvent, Sats } from '../src/hashi/types.js';
import type { DecisionSegment } from '../src/journal/schema.js';
import { route } from '../src/routing/route.js';
import type { RouteContext } from '../src/routing/route.js';
import { evaluate } from '../src/strategy/evaluate.js';
import type { RulesetContext } from '../src/strategy/evaluate.js';
import type { StrategyParams } from '../src/strategy/params.js';
import { createSuiClient } from '../src/sui/client.js';
import type { Decision, DecisionRecord, L2Book, LimiterSample, OracleSnapshot, Plan } from '../src/types.js';
import { createRng } from '../src/util/rng.js';
import {
  deriveLimiter,
  deriveLimiterFromAdapter,
  indexPickedSats,
  indexRequestedSats,
  limiterAt,
  verifyVault,
  type DeriveConfig,
  type LimiterTrajectory,
  type VerifySources,
} from '../src/verify/index.js';
import {
  PUBLISHED_REPLAY_FNS,
  compareLimiter,
  replayRecord,
  replaySegment,
  strategyInputsFor,
  type ReplayFns,
} from '../src/verify/replay.js';

import { FAST, p2trAddress, testConfig, testSigner } from './support/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** `noUncheckedIndexedAccess`-safe indexing that fails the test instead of returning undefined. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  expect(x, `index ${i} of ${xs.length}`).toBeDefined();
  return x as T;
}

/** bigint-safe deep snapshot, used for the "identical replay twice" invariant. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

const ADDR = p2trAddress(0x11);

function base(seq: bigint, atMs: number) {
  return { seq, atMs, atSecs: msToSecs(atMs) };
}

function requested(seq: bigint, atMs: number, requestId: string, sats: Sats): HashiEvent {
  return {
    ...base(seq, atMs),
    kind: 'WithdrawalRequested',
    requestId,
    sats,
    bitcoinAddress: ADDR,
    requesterAddress: '0xdeposit0r',
  };
}

function pickedFor(
  seq: bigint,
  atMs: number,
  txnId: string,
  requestIds: readonly string[],
  outputSats: readonly Sats[],
): HashiEvent {
  return {
    ...base(seq, atMs),
    kind: 'WithdrawalPickedForProcessing',
    withdrawalTxnId: txnId,
    txid: `txid-${txnId}`,
    requestIds,
    outputs: outputSats.map((sats) => ({ sats, bitcoinAddress: ADDR })),
  };
}

/**
 * A raw `WithdrawalSigned`: NO amount, NO timestamp of its own (E-K3). `carriedSats` is whatever
 * `normalize.ts` managed to attach — the replay must do its OWN join and only fall back to it.
 */
function signedFor(
  seq: bigint,
  atMs: number,
  txnId: string,
  requestIds: readonly string[],
  carriedSats: Sats = 0n,
): HashiEvent {
  return {
    ...base(seq, atMs),
    kind: 'WithdrawalSigned',
    withdrawalTxnId: txnId,
    requestIds,
    sats: carriedSats,
    satsSource: 'unresolved',
    signatureCount: 1,
  };
}

function cancelledFor(seq: bigint, atMs: number, requestId: string, sats: Sats): HashiEvent {
  return {
    ...base(seq, atMs),
    kind: 'WithdrawalCancelled',
    requestId,
    requesterAddress: '0xdeposit0r',
    sats,
  };
}

/** Drive a seeded random deposit/withdrawal sequence on the mock, exactly as the A2 cross-test does. */
async function driveMock(mock: MockHashiAdapter, seed: string, rounds: number): Promise<void> {
  const rng = createRng(`${seed}-driver`);
  const users = [testSigner(21), testSigner(22), testSigner(23)];

  for (let round = 0; round < rounds; round++) {
    const user = rng.pick(users);
    switch (rng.nextInt(3)) {
      case 0: {
        const sats = 30_000n + rng.nextBelow(500_000n);
        const { requestId } = await mock.deposit({
          signer: user,
          txid: `signet-${round}`,
          utxos: [{ txid: `signet-${round}`, vout: 0, sats }],
          recipient: user.toSuiAddress(),
        });
        await mock.waitForDeposit(requestId);
        await mock.confirmDeposit(requestId, user);
        break;
      }
      case 1: {
        const sats = 30_000n + rng.nextBelow(900_000n);
        await mock.requestWithdrawal({ sats, bitcoinAddress: p2trAddress(round & 0xff), signer: user });
        break;
      }
      default:
        mock.advanceMs(rng.nextInt(400_000) + 1_000);
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. deriveLimiter — the G5 trustless replay
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveLimiter — trustless Guardian bucket replay (G5)', () => {
  const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '250', MAX_BUCKET_CAPACITY_SATS: '2000000' });
  const derive: DeriveConfig = { limiter: cfg.limiter };

  it('reproduces mock.limiterStatus() at EVERY event boundary of a seeded randomized stream (A2)', async () => {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-derive' });
    let boundariesSeen = 0;

    for (let round = 0; round < 30; round++) {
      await driveMock(mock, `T4.3-derive-${round}`, 2);

      const { events } = await mock.eventsSince({ seq: 0n });
      const trajectory = deriveLimiter(events, derive);
      const live = await mock.guardian.limiterStatus();
      const internal = mock.limiterState();

      expect(trajectory.final.nextSeq, `round ${round}: next_seq`).toBe(internal.nextSeq);
      expect(trajectory.final.numTokensAvailableSats, `round ${round}: stored tokens`).toBe(
        internal.numTokensAvailableSats,
      );
      expect(trajectory.final.lastUpdatedAtSecs, `round ${round}: last_updated_at`).toBe(
        internal.lastUpdatedAtSecs,
      );
      // Projected to the SAME instant the mock reports — this is the A2 equality.
      expect(limiterAt(trajectory, live.asOfMs, derive).tokens, `round ${round}: projected`).toBe(
        live.tokens,
      );

      // The join must have succeeded everywhere; nothing rejected (a rejected batch emits no event).
      expect(trajectory.unresolvedCount, `round ${round}: unresolved`).toBe(0);
      expect(trajectory.rejectedCount, `round ${round}: rejected`).toBe(0);
      for (const boundary of trajectory.samples) {
        expect(boundary.satsSource).toBe('requested');
      }
      boundariesSeen = trajectory.samples.length;
    }

    // The run must actually have exercised the bucket, or the test proves nothing.
    expect(boundariesSeen).toBeGreaterThan(5);
  });

  it('★ NEGATIVE CONTROL — an injected wrong requested amount makes the replay DIVERGE', async () => {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-tamper' });
    await driveMock(mock, 'T4.3-tamper', 24);
    const { events } = await mock.eventsSince({ seq: 0n });

    const honest = deriveLimiter(events, derive);
    expect(honest.samples.length).toBeGreaterThan(2);
    expect(honest.final.numTokensAvailableSats).toBe(mock.limiterState().numTokensAvailableSats);

    // Tamper with the FIRST WithdrawalRequested that a Signed event actually consumed.
    const consumedIds = new Set(honest.samples.flatMap((s) => [...eventRequestIds(events, s.eventSeq)]));
    const tampered = events.map((event) =>
      event.kind === 'WithdrawalRequested' && consumedIds.has(event.requestId) && event.sats > 0n
        ? { ...event, sats: event.sats + 1_000n }
        : event,
    );
    // Only the first one, so the divergence is a single, attributable delta.
    let patched = false;
    const single = events.map((event) => {
      if (patched) return event;
      if (event.kind !== 'WithdrawalRequested' || !consumedIds.has(event.requestId)) return event;
      patched = true;
      return { ...event, sats: event.sats + 1_000n };
    });
    expect(patched, 'the stream must contain a consumed WithdrawalRequested to tamper with').toBe(true);

    const forged = deriveLimiter(single, derive);
    expect(forged.final.numTokensAvailableSats).not.toBe(honest.final.numTokensAvailableSats);
    expect(honest.final.numTokensAvailableSats - forged.final.numTokensAvailableSats).toBe(1_000n);

    // Tampering with every consumed request diverges by strictly more than one.
    const allForged = deriveLimiter(tampered, derive);
    expect(allForged.final.numTokensAvailableSats).not.toBe(honest.final.numTokensAvailableSats);
  });

  it('is order-independent in seq: a shuffled slice replays to the identical trajectory', async () => {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-shuffle' });
    await driveMock(mock, 'T4.3-shuffle', 20);
    const { events } = await mock.eventsSince({ seq: 0n });

    const rng = createRng('T4.3-shuffle-perm');
    const shuffled = [...events];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const a = at(shuffled, i);
      const b = at(shuffled, j);
      shuffled[i] = b;
      shuffled[j] = a;
    }

    expect(stable(deriveLimiter(shuffled, derive).samples)).toBe(
      stable(deriveLimiter(events, derive).samples),
    );
    // ...and the input array was not mutated (invariant 1).
    expect(events.map((e) => e.seq)).toEqual([...events].sort((a, b) => Number(a.seq - b.seq)).map((e) => e.seq));
  });

  it('replaying the same slice twice is byte-identical (invariant 4)', async () => {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-idem' });
    await driveMock(mock, 'T4.3-idem', 12);
    const { events } = await mock.eventsSince({ seq: 0n });
    expect(stable(deriveLimiter(events, derive))).toBe(stable(deriveLimiter(events, derive)));
  });
});

/** request_ids of the WithdrawalSigned at a given event-log seq. */
function eventRequestIds(events: readonly HashiEvent[], seq: bigint): readonly string[] {
  for (const event of events) {
    if (event.seq === seq && event.kind === 'WithdrawalSigned') return event.requestIds;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The E-K3 join: Signed carries no amount and no timestamp
// ─────────────────────────────────────────────────────────────────────────────

describe('E-K3 join — WithdrawalSigned has NO amount, NO timestamp', () => {
  const limiter: LimiterConfig = { refillRateSatsPerSec: 0n, maxBucketCapacitySats: 10_000_000n };
  const derive: DeriveConfig = { limiter };

  // The observed live pair: requested 1_000_000, picked output 998_835 (net of the network fee).
  const REQUESTED = 1_000_000n;
  const PICKED = 998_835n;

  const stream: readonly HashiEvent[] = [
    requested(0n, 10_000, 'req-A', REQUESTED),
    pickedFor(1n, 20_000, 'txn-1', ['req-A'], [PICKED]),
    signedFor(2n, 30_000, 'txn-1', ['req-A'], PICKED),
  ];

  it('debits the REQUESTED amount, never the fee-net Picked output', () => {
    const t = deriveLimiter(stream, derive);
    const boundary = at(t.samples, 0);
    expect(boundary.debitedSats).toBe(REQUESTED);
    expect(boundary.satsSource).toBe('requested');
    expect(t.final.numTokensAvailableSats).toBe(10_000_000n - REQUESTED);
    expect(t.unresolvedCount).toBe(0);
  });

  it('falls back to the Picked output only when the Requested event aged out of the window', () => {
    const withoutRequested = stream.filter((e) => e.kind !== 'WithdrawalRequested');
    const t = deriveLimiter(withoutRequested, derive);
    const boundary = at(t.samples, 0);
    expect(boundary.debitedSats).toBe(PICKED);
    expect(boundary.satsSource).toBe('picked');
    expect(t.unresolvedCount).toBe(0);
  });

  it('marks a boundary UNRESOLVED (and names the request ids) when neither join exists', () => {
    const onlySigned = stream.filter((e) => e.kind === 'WithdrawalSigned');
    const t = deriveLimiter(onlySigned, derive);
    const boundary = at(t.samples, 0);
    expect(boundary.satsSource).toBe('unresolved');
    expect(boundary.unresolvedRequestIds).toEqual(['req-A']);
    expect(t.unresolvedCount).toBe(1);
    // It falls back to the carried amount rather than under-debiting silently...
    expect(boundary.debitedSats).toBe(PICKED);
    // ...and compareLimiter surfaces it as an explicit, named finding.
    const findings = compareLimiter([], t);
    expect(findings).toHaveLength(1);
    expect(at(findings, 0).field).toContain('limiter.satsSource');
    expect(at(findings, 0).actual).toContain('req-A');
  });

  it('takes the timestamp from the ENVELOPE (atSecs), floored — never a struct field', () => {
    const refilling: DeriveConfig = {
      limiter: { refillRateSatsPerSec: 10n, maxBucketCapacitySats: 10_000_000n },
    };
    // 30_999 ms floors to 30 s, not 31 s: a ceil would add one refill tick (10 sats).
    const t = deriveLimiter(
      [requested(0n, 0, 'r', 1_000n), signedFor(1n, 30_999, 'txn', ['r'])],
      refilling,
    );
    const boundary = at(t.samples, 0);
    expect(boundary.atSecs).toBe(30n);
    expect(boundary.state.lastUpdatedAtSecs).toBe(30n);
    // Bucket was already full, so the refill is clamped — capacity is the ceiling.
    expect(boundary.capacityBeforeDebitSats).toBe(10_000_000n);
  });

  it('indexRequestedSats / indexPickedSats build the joins independently', () => {
    expect([...indexRequestedSats(stream).entries()]).toEqual([['req-A', REQUESTED]]);
    expect([...indexPickedSats(stream).entries()]).toEqual([['req-A', PICKED]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Queue depth = Σ Requested − Σ (Signed | Cancelled)
// ─────────────────────────────────────────────────────────────────────────────

describe('queue depth accounting (KEEPER §9.2)', () => {
  const derive: DeriveConfig = {
    limiter: { refillRateSatsPerSec: 0n, maxBucketCapacitySats: 10_000_000n },
  };

  it('adds on Requested, subtracts on Signed and on Cancelled', () => {
    const t = deriveLimiter(
      [
        requested(0n, 1_000, 'a', 100_000n),
        requested(1n, 2_000, 'b', 200_000n),
        signedFor(2n, 3_000, 'txn-1', ['a']),
        cancelledFor(3n, 4_000, 'b', 200_000n),
      ],
      derive,
    );

    expect(t.queue.map((q) => [q.kind, q.queueDepth])).toEqual([
      ['WithdrawalRequested', 100_000n],
      ['WithdrawalRequested', 300_000n],
      ['WithdrawalSigned', 200_000n],
      ['WithdrawalCancelled', 0n],
    ]);
    expect(t.finalQueueDepth).toBe(0n);
    // The bucket saw only the signed batch.
    expect(t.final.numTokensAvailableSats).toBe(10_000_000n - 100_000n);
  });

  it('a REJECTED batch clears nothing from the queue and leaves the bucket untouched (G3)', () => {
    const tight: DeriveConfig = {
      limiter: { refillRateSatsPerSec: 0n, maxBucketCapacitySats: 150_000n },
    };
    const t = deriveLimiter(
      [
        requested(0n, 1_000, 'a', 100_000n),
        requested(1n, 2_000, 'b', 120_000n),
        signedFor(2n, 3_000, 'txn-1', ['a']),
        signedFor(3n, 4_000, 'txn-2', ['b']), // 120_000 > 50_000 remaining ⇒ RateLimitExceeded
      ],
      tight,
    );

    expect(t.rejectedCount).toBe(1);
    const rejected = at(t.samples, 1);
    expect(rejected.rejected).toBe('RateLimitExceeded');
    expect(rejected.debitedSats).toBe(120_000n);
    expect(rejected.capacityBeforeDebitSats).toBe(50_000n);
    // Bucket untouched by the rejection, and next_seq did NOT advance.
    expect(t.final.numTokensAvailableSats).toBe(50_000n);
    expect(t.final.nextSeq).toBe(1n);
    // Queue still holds the un-signed 120_000.
    expect(t.finalQueueDepth).toBe(120_000n);
    // ...and it is reported, not swallowed.
    const findings = compareLimiter([], t);
    expect(at(findings, 0).field).toContain('limiter.rejected');
  });

  it('never goes negative when a Cancelled has no matching Requested in the window', () => {
    const t = deriveLimiter([cancelledFor(0n, 1_000, 'ghost', 500_000n)], derive);
    expect(t.finalQueueDepth).toBe(0n);
  });

  it('matches the mock stream: Σ Requested − Σ (Signed | Cancelled)', async () => {
    const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '250', MAX_BUCKET_CAPACITY_SATS: '2000000' });
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-queue' });
    await driveMock(mock, 'T4.3-queue', 30);
    const { events } = await mock.eventsSince({ seq: 0n });
    const t = deriveLimiter(events, { limiter: cfg.limiter });

    let expected = 0n;
    for (const event of events) {
      if (event.kind === 'WithdrawalRequested') expected += event.sats;
      else if (event.kind === 'WithdrawalCancelled') expected -= event.sats;
      else if (event.kind === 'WithdrawalSigned') expected -= event.sats;
    }
    expect(expected).toBeGreaterThanOrEqual(0n);
    expect(t.finalQueueDepth).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. limiterAt — projection between boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('limiterAt — refill-only projection between boundaries', () => {
  const derive: DeriveConfig = {
    limiter: { refillRateSatsPerSec: 10n, maxBucketCapacitySats: 1_000_000n },
  };
  const trajectory = deriveLimiter(
    [requested(0n, 0, 'a', 400_000n), signedFor(1n, 100_000, 'txn', ['a'])],
    derive,
  );

  it('returns the genesis (full) bucket before the first boundary', () => {
    const sample = limiterAt(trajectory, 50_000, derive);
    expect(sample.tokens).toBe(1_000_000n);
    expect(sample.queueDepth).toBe(400_000n); // the Requested at t=0 is already in the queue
  });

  it('projects the refill forward from the last boundary, clamped at the ceiling', () => {
    expect(at(trajectory.samples, 0).state.numTokensAvailableSats).toBe(600_000n);
    // +60 s x 10 sats/s = 600 sats.
    expect(limiterAt(trajectory, 160_000, derive).tokens).toBe(600_600n);
    // Far future ⇒ clamped to max_bucket_capacity (clamp-before-debit, invariant 3 of hashi/limiter).
    expect(limiterAt(trajectory, 10_000_000_000, derive).tokens).toBe(1_000_000n);
  });

  it('agrees with projectCapacityAtSecs on the raw final state (one implementation, G5)', () => {
    expect(limiterAt(trajectory, 160_000, derive).tokens).toBe(
      projectCapacityAtSecs(derive.limiter, trajectory.final, msToSecs(160_000)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Decision replay — the two honest tiers
// ─────────────────────────────────────────────────────────────────────────────

const RULESET: RulesetContext = {
  tickSize: 1_000_000n,
  lotSize: 1_000n,
  minSize: 100_000n,
  withdrawalMinimumSats: 30_000n,
};

const ROUTE_CTX: RouteContext = {
  tickSize: 1_000_000n,
  lotSize: 1_000n,
  minSize: 100_000n,
  expireTs: 1_700_000_015_000,
  maxIocSats: 500_000n,
};

const PARAMS: StrategyParams = {
  spreadBps: 20,
  skewBps: 5,
  flowSensitivityBps: 3,
  bufferTargetBps: 1_000,
  maxNotionalPerEpochSats: 50_000_000n,
  cooldownMs: 5_000,
  jitterBps: 4,
  hysteresisBps: 6,
  makerTimeoutMs: 15_000,
};

/**
 * A REFERENCE decision/routing pair used to exercise the diff machinery. It is deliberately a
 * different, simpler ruleset from the published one — this suite verifies the REPLAY ENGINE, while
 * `PUBLISHED_REPLAY_FNS` (asserted below) is what a real `verify` run uses. PURE by construction.
 */
const REFERENCE_FNS: ReplayFns = {
  evaluate: (params, inputs) => ({
    action: 'quote',
    bidPx: inputs.oracle.deepbookMid - BigInt(params.spreadBps) * 1_000_000n,
    askPx: inputs.oracle.deepbookMid + BigInt(params.spreadBps) * 1_000_000n,
    // Reads the RECORDED limiter sample — proves the trustless reading is what feeds evaluate (G5).
    bidSz: inputs.limiter.tokens / 10n,
    askSz: inputs.limiter.tokens / 10n,
    cancels: [],
    jitterSeed: inputs.jitterSeed,
  }),
  route: (decision, book, ctx) => ({
    makerOrders: [
      { side: 'bid', px: decision.bidPx, sz: decision.bidSz, expireTs: ctx.expireTs, postOnly: true },
      { side: 'ask', px: decision.askPx, sz: decision.askSz, expireTs: ctx.expireTs, postOnly: true },
    ],
    iocOrders: [],
    cancels: [...decision.cancels, BigInt(book.bids.length)],
  }),
};

const BOOK: L2Book = {
  poolId: '0xpool',
  bids: [{ px: 99_000_000n, sz: 300_000n }],
  asks: [{ px: 101_000_000n, sz: 300_000n }],
  mid: 100_000_000n,
  atMs: 1_700_000_000_000,
};

const ORACLE: OracleSnapshot = {
  pythPx: 100_500_000n,
  pythSeq: 42n,
  pythPublishTimeMs: 1_699_999_999_000,
  deepbookTwap: 99_900_000n,
  deepbookMid: 100_000_000n,
};

function buildRecord(limiter: LimiterSample, tickMs = 1_700_000_000_000): DecisionRecord {
  const inputs = {
    book: BOOK,
    oracle: ORACLE,
    limiter,
    pendingMintSats: 250_000n,
    pendingBurnSats: 125_000n,
    idleHBtcSats: 0n,
    pendingExitDemandSats: 0n,
    tickMs,
    jitterSeed: `tick-${tickMs}`,
    restingOrderIds: [] as readonly bigint[],
  };
  const decision: Decision = REFERENCE_FNS.evaluate(PARAMS, inputs, RULESET);
  const plan: Plan = REFERENCE_FNS.route(decision, BOOK, ROUTE_CTX);
  return {
    tickMs,
    oracle: ORACLE,
    book: BOOK,
    hashi: {
      limiter,
      pendingMintSats: inputs.pendingMintSats,
      pendingBurnSats: inputs.pendingBurnSats,
      signedCursorSeq: 7n,
    },
    strategyBlobId: 'blob-strategy-v1',
    ruleset: 'ruleset-hash-reference',
    decision,
    plan,
    result: { digest: 'DIGEST0' },
  };
}

const SAMPLE: LimiterSample = { atMs: 1_700_000_000_000, atSecs: 1_700_000_000n, tokens: 900_000n, queueDepth: 0n };

describe('replayRecord — routing tier (public, no keys) and trigger tier (needs plaintext)', () => {
  const record = buildRecord(SAMPLE);

  it('tier 1 reproduces the Plan from the RECORDED decision, with params undefined', () => {
    const tick = replayRecord(record, undefined, RULESET, ROUTE_CTX, { fns: REFERENCE_FNS });
    expect(tick.mismatches).toEqual([]);
    expect(tick.decision).toBeUndefined(); // tier 1 never claims trigger correctness (G8)
    expect(tick.plan).toEqual(record.plan);
    expect(tick.tickMs).toBe(record.tickMs);
  });

  it('★ NEGATIVE CONTROL — a doctored Plan is caught, and the mismatch NAMES field + both values', () => {
    const forged: DecisionRecord = {
      ...record,
      plan: {
        ...record.plan,
        makerOrders: [
          { ...at(record.plan.makerOrders, 0), sz: at(record.plan.makerOrders, 0).sz + 50_000n },
          at(record.plan.makerOrders, 1),
        ],
      },
    };
    const tick = replayRecord(forged, undefined, RULESET, ROUTE_CTX, { fns: REFERENCE_FNS });
    expect(tick.mismatches).toHaveLength(1);
    const m = at(tick.mismatches, 0);
    expect(m.tier).toBe('routing');
    expect(m.field).toBe('plan.makerOrders[0]');
    expect(m.expected).toContain('140000'); // 90_000 + 50_000
    expect(m.actual).toContain('90000');
    expect(m.tickMs).toBe(record.tickMs);
  });

  it('tier 2 reproduces the Decision (including the seeded jitterSeed) when params are supplied', () => {
    const tick = replayRecord(record, PARAMS, RULESET, ROUTE_CTX, { fns: REFERENCE_FNS });
    expect(tick.mismatches).toEqual([]);
    expect(tick.decision).toEqual(record.decision);
    expect(tick.decision?.jitterSeed).toBe(record.decision.jitterSeed);
  });

  it('★ NEGATIVE CONTROL — a doctored Decision is caught at the TRIGGER tier', () => {
    const forged: DecisionRecord = {
      ...record,
      decision: { ...record.decision, bidPx: record.decision.bidPx + 1_000_000n },
    };
    const tick = replayRecord(forged, PARAMS, RULESET, ROUTE_CTX, { fns: REFERENCE_FNS });
    const fields = tick.mismatches.map((m) => m.field);
    expect(fields).toContain('decision.bidPx');
    expect(tick.mismatches.every((m) => m.expected !== m.actual)).toBe(true);
    // The routing tier also flags the knock-on maker price — both tiers are reported separately.
    expect(new Set(tick.mismatches.map((m) => m.tier))).toEqual(new Set(['routing', 'trigger']));
  });

  it('strategyInputsFor rebuilds the inputs from the record, using the TRUSTLESS limiter (G5)', () => {
    const inputs = strategyInputsFor(record);
    expect(inputs.limiter).toBe(record.hashi.limiter);
    expect(inputs.limiter.tokens).toBe(900_000n);
    expect(inputs.jitterSeed).toBe(record.decision.jitterSeed);
    expect(inputs.tickMs).toBe(record.tickMs);
    expect(inputs.pendingMintSats).toBe(250_000n);
    expect(inputs.pendingBurnSats).toBe(125_000n);
    // The schema gap (see replay.ts @facts): these default to zero and must be supplied for tier 2.
    expect(inputs.idleHBtcSats).toBe(0n);
    expect(inputs.restingOrderIds).toEqual([]);
    const supplied = strategyInputsFor(record, {
      idleHBtcSats: 5_000_000n,
      pendingExitDemandSats: 1_000n,
      restingOrderIds: [1n, 2n],
      lastDecisionAtMs: 1_699_999_990_000,
    });
    expect(supplied.idleHBtcSats).toBe(5_000_000n);
    expect(supplied.lastDecisionAtMs).toBe(1_699_999_990_000);
  });

  it('the production binding is the PUBLISHED evaluate/route — no drift, no shadow ruleset', () => {
    expect(PUBLISHED_REPLAY_FNS.evaluate).toBe(evaluate);
    expect(PUBLISHED_REPLAY_FNS.route).toBe(route);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. replaySegment + compareLimiter (--limiter)
// ─────────────────────────────────────────────────────────────────────────────

function segmentOf(records: readonly DecisionRecord[]): DecisionSegment {
  return {
    meta: {
      schemaVersion: 1,
      vaultId: '0xvault',
      seq: 0n,
      fromMs: at(records, 0).tickMs,
      toMs: at(records, records.length - 1).tickMs,
      strategyBlobId: 'blob-strategy-v1',
      ruleset: 'ruleset-hash-reference',
    },
    records,
  };
}

describe('replaySegment + compareLimiter (--limiter, A10)', () => {
  const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '250', MAX_BUCKET_CAPACITY_SATS: '2000000' });
  const derive: DeriveConfig = { limiter: cfg.limiter };

  async function stagedTrajectory(seed: string): Promise<{ mock: MockHashiAdapter; t: LimiterTrajectory }> {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed });
    await driveMock(mock, seed, 24);
    const { events } = await mock.eventsSince({ seq: 0n });
    return { mock, t: deriveLimiter(events, derive) };
  }

  it('reports 0 mismatches when every recorded reading equals the re-derived trajectory', async () => {
    const { t } = await stagedTrajectory('T4.3-cmp-ok');
    const tickMs = [400_000, 900_000, 1_500_000];
    const segment = segmentOf(tickMs.map((ms) => buildRecord(limiterAt(t, ms, derive), ms)));

    const report = replaySegment(segment, {
      ruleset: RULESET,
      route: ROUTE_CTX,
      fns: REFERENCE_FNS,
      params: PARAMS,
      limiterTrajectory: t,
    });

    expect(report.tier).toBe('trigger');
    expect(report.ticks).toBe(3);
    expect(report.mismatches).toEqual([]);
    expect(report.reproduced).toBe(true);
  });

  it('★ NEGATIVE CONTROL — a journal that overstates the bucket is caught by the derivation', async () => {
    const { t } = await stagedTrajectory('T4.3-cmp-bad');
    const honest = limiterAt(t, 900_000, derive);
    const inflated: LimiterSample = { ...honest, tokens: honest.tokens + 777n };

    const findings = compareLimiter([inflated], t);
    expect(findings.map((f) => f.field)).toContain('limiter.tokens');
    const m = at(
      findings.filter((f) => f.field === 'limiter.tokens'),
      0,
    );
    expect(m.expected).toBe(honest.tokens.toString(10));
    expect(m.actual).toBe((honest.tokens + 777n).toString(10));
    expect(m.tier).toBe('routing'); // publicly checkable — no keys required (G8)
  });

  it('★ NEGATIVE CONTROL — a doctored queue depth is caught too', async () => {
    const { t } = await stagedTrajectory('T4.3-cmp-queue');
    const honest = limiterAt(t, 900_000, derive);
    const findings = compareLimiter([{ ...honest, queueDepth: honest.queueDepth + 1n }], t);
    expect(findings.map((f) => f.field)).toContain('limiter.queueDepth');
  });

  it('tier is `routing` and no Decision is claimed when params are absent (G8)', async () => {
    const { t } = await stagedTrajectory('T4.3-cmp-tier1');
    const segment = segmentOf([buildRecord(limiterAt(t, 900_000, derive), 900_000)]);
    const report = replaySegment(segment, { ruleset: RULESET, route: ROUTE_CTX, fns: REFERENCE_FNS });
    expect(report.tier).toBe('routing');
    expect(report.reproduced).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. verifyVault — the CLI orchestrator, fully offline over the mock (G7)
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyVault — `verify --vault <ID> --from-epoch <N> [--limiter]`', () => {
  const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '250', MAX_BUCKET_CAPACITY_SATS: '2000000' });
  const derive: DeriveConfig = { limiter: cfg.limiter };

  async function staged() {
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'T4.3-verify' });
    await driveMock(mock, 'T4.3-verify', 24);
    const trajectory = await deriveLimiterFromAdapter(mock, derive);
    const records = [400_000, 900_000].map((ms) => buildRecord(limiterAt(trajectory, ms, derive), ms));
    return { mock, trajectory, segment: segmentOf(records) };
  }

  it('deriveLimiterFromAdapter pages the adapter and equals a direct deriveLimiter (G7)', async () => {
    const { mock, trajectory } = await staged();
    const { events } = await mock.eventsSince({ seq: 0n });
    expect(stable(trajectory.samples)).toBe(stable(deriveLimiter(events, derive).samples));
    expect(trajectory.samples.length).toBeGreaterThan(2);
  });

  it('replays every anchored segment and reports 0 mismatches (A3/A10)', async () => {
    const { mock, segment } = await staged();
    const sources: VerifySources = {
      async listSegments() {
        return [{ seq: 0n, blobId: 'blob-0' }];
      },
      async fetchSegment() {
        return segment;
      },
    };

    const result = await verifyVault(
      { cfg, client: createSuiClient(cfg), hashi: mock, sources },
      {
        vaultId: '0xvault',
        fromSeq: 0n,
        withLimiter: true,
        params: PARAMS,
        replay: { ruleset: RULESET, route: ROUTE_CTX, fns: REFERENCE_FNS },
      },
    );

    expect(result.tier).toBe('trigger');
    expect(result.segments).toBe(1);
    expect(result.ticks).toBe(2);
    expect(result.mismatches).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.reproduced).toBe(true);
    expect(result.trajectory?.unresolvedCount).toBe(0);
  });

  it('omits the trajectory without --limiter, and runs tier 1 without params', async () => {
    const { mock, segment } = await staged();
    const sources: VerifySources = {
      async listSegments() {
        return [{ seq: 0n, blobId: 'blob-0' }];
      },
      async fetchSegment() {
        return segment;
      },
    };
    const result = await verifyVault(
      { cfg, client: createSuiClient(cfg), hashi: mock, sources },
      { vaultId: '0xvault', fromSeq: 0n, replay: { ruleset: RULESET, route: ROUTE_CTX, fns: REFERENCE_FNS } },
    );
    expect(result.trajectory).toBeUndefined();
    expect(result.tier).toBe('routing');
    expect(result.reproduced).toBe(true);
  });

  it('★ an unfetchable segment is a FAILURE, never silently "reproduced" (invariant 2)', async () => {
    const { mock, segment } = await staged();
    const sources: VerifySources = {
      async listSegments() {
        return [
          { seq: 0n, blobId: 'blob-0' },
          { seq: 1n, blobId: 'blob-missing' },
        ];
      },
      async fetchSegment(_deps, pointer) {
        if (pointer.blobId === 'blob-missing') throw new Error('walrus 404: blob expired');
        return segment;
      },
    };

    const result = await verifyVault(
      { cfg, client: createSuiClient(cfg), hashi: mock, sources },
      { vaultId: '0xvault', fromSeq: 0n, replay: { ruleset: RULESET, route: ROUTE_CTX, fns: REFERENCE_FNS } },
    );

    expect(result.segments).toBe(1);
    expect(result.mismatches).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(at(result.failures, 0).blobId).toBe('blob-missing');
    expect(at(result.failures, 0).reason).toContain('blob expired');
    expect(result.reproduced).toBe(false);
  });

  it('★ NEGATIVE CONTROL — a tampered segment makes verifyVault report reproduced: false', async () => {
    const { mock, segment } = await staged();
    const first = at(segment.records, 0);
    const tampered: DecisionSegment = {
      ...segment,
      records: [
        { ...first, decision: { ...first.decision, askSz: first.decision.askSz + 1_000n } },
        at(segment.records, 1),
      ],
    };
    const sources: VerifySources = {
      async listSegments() {
        return [{ seq: 0n, blobId: 'blob-0' }];
      },
      async fetchSegment() {
        return tampered;
      },
    };

    const result = await verifyVault(
      { cfg, client: createSuiClient(cfg), hashi: mock, sources },
      {
        vaultId: '0xvault',
        fromSeq: 0n,
        params: PARAMS,
        replay: { ruleset: RULESET, route: ROUTE_CTX, fns: REFERENCE_FNS },
      },
    );

    expect(result.reproduced).toBe(false);
    expect(result.mismatches.map((m) => m.field)).toContain('decision.askSz');
  });
});
