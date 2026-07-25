// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.2
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.2 — "normalized event log; deterministic under the mock")
// @spec       docs/KEEPER.md §2.2 (event stream), §3.1 (pendingMint/pendingBurn), §9.2 (queue depth)
// @spec       docs/RECON.md#r8 (the REAL 14 event names — no `utxo_pool` family)
// @rules      G1 G3 G5 G7
// @depends    ../src/hashi/watcher.ts (T2.2) · ../src/hashi/mock.ts (T0.5) · ./support/fixtures.ts
// @facts      Everything here runs on the deterministic MOCK's logical clock or on a hand-built
// @facts        static adapter. Zero network, zero wall clock (G7).
// @facts      ⚠ `WithdrawalConfirmed` carries NO amount (docs/RECON.md R8) — its burn credit is
// @facts        joined from `WithdrawalRequested`. The clamp-at-zero tests pin that behaviour.
// @implements the 14 watched kinds (no utxo_pool) · applyFlow purity + clamping + the Confirmed
//             join · cursor monotonicity · dedup on re-poll · retainLog on/off · checkpoint
//             resume · signedSince passthrough · byte-identical logs across two mock runs
// @invariant  1. No test opens a socket and none reads Date.now().
// @verify     npm run test -- watcher
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import type { EventsSinceOptions, HashiAdapter } from '../src/hashi/adapter.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import {
  EVENT_CURSOR_GENESIS,
  HASHI_EVENT_KINDS,
  type EventCursor,
  type HashiEvent,
  type HashiEventOf,
} from '../src/hashi/types.js';
import {
  FLOW_STATE_ZERO,
  WATCHED_EVENT_KINDS,
  applyFlow,
  createWatcher,
  type FlowState,
} from '../src/hashi/watcher.js';

import { FAST, p2trAddress, testConfig, testSigner } from './support/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** `Omit` that distributes over the union so the `kind` discriminant survives (as in mock.ts). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<HashiEvent, 'seq' | 'atMs' | 'atSecs'>;

/** Build a normalized event without going near a chain. `seq`/`atMs` are explicit. */
function ev(seq: number, atMs: number, draft: EventDraft): HashiEvent {
  return { ...draft, seq: BigInt(seq), atMs, atSecs: BigInt(Math.floor(atMs / 1000)) } as HashiEvent;
}

/**
 * A minimal `HashiAdapter` serving a fixed log. Only the two stream methods are real; every other
 * member throws, which is what we want — the watcher must NEVER reach for anything else (G7).
 */
function staticAdapter(events: readonly HashiEvent[]): HashiAdapter & { reads: number } {
  const unreachable = (what: string) => (): never => {
    throw new Error(`watcher must not call ${what}`);
  };
  const adapter = {
    kind: 'mock' as const,
    reads: 0,
    bridgeConfig: unreachable('bridgeConfig'),
    generateDepositAddress: unreachable('generateDepositAddress'),
    deposit: unreachable('deposit'),
    confirmDeposit: unreachable('confirmDeposit'),
    requestWithdrawal: unreachable('requestWithdrawal'),
    cancelWithdrawal: unreachable('cancelWithdrawal'),
    waitForDeposit: unreachable('waitForDeposit'),
    waitForWithdrawal: unreachable('waitForWithdrawal'),
    view: {
      balance: unreachable('view.balance'),
      depositStatus: unreachable('view.depositStatus'),
      withdrawalStatus: unreachable('view.withdrawalStatus'),
      all: unreachable('view.all'),
    },
    guardian: {
      limiterStatus: unreachable('guardian.limiterStatus'),
      canWithdraw: unreachable('guardian.canWithdraw'),
    },
    async eventsSince(cursor: EventCursor, opts?: EventsSinceOptions) {
      adapter.reads += 1;
      const start = cursor.seq < 0n ? 0 : Number(cursor.seq);
      const out: HashiEvent[] = [];
      let i = start;
      for (; i < events.length; i++) {
        const event = events[i] as HashiEvent;
        if (opts?.kinds === undefined || opts.kinds.includes(event.kind)) out.push(event);
        if (opts?.limit !== undefined && out.length >= opts.limit) {
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
  return adapter as unknown as HashiAdapter & { reads: number };
}

/** Drive a whole deposit + withdrawal lifecycle on the deterministic mock. */
async function runMockLifecycle(cfg: Config): Promise<MockHashiAdapter> {
  const mock = createMockHashiAdapter(cfg, FAST);
  const user = testSigner(1);
  const addr = user.toSuiAddress();

  const { requestId } = await mock.deposit({
    signer: user,
    txid: 'signet-txid-1',
    utxos: [{ txid: 'signet-txid-1', vout: 0, sats: 500_000n }],
    recipient: addr,
  });
  await mock.waitForDeposit(requestId);
  await mock.confirmDeposit(requestId, user);

  const exit = await mock.requestWithdrawal({ sats: 120_000n, bitcoinAddress: p2trAddress(), signer: user });
  await mock.waitForWithdrawal(exit.requestId);
  return mock;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('hashi/watcher — the watched families (docs/RECON.md R8 erratum)', () => {
  it('subscribes to the authoritative 14 kinds — three families, and NO utxo_pool', () => {
    expect(WATCHED_EVENT_KINDS).toEqual(HASHI_EVENT_KINDS);
    expect(WATCHED_EVENT_KINDS).toHaveLength(14);
    // BUILD-PLAN T2.2 says "six families … utxo_pool::UtxoSpent". That family does not exist.
    expect(WATCHED_EVENT_KINDS.some((k) => String(k).includes('Utxo'))).toBe(false);
    expect(WATCHED_EVENT_KINDS).toContain('WithdrawalPickedForProcessing');
    expect(WATCHED_EVENT_KINDS).not.toContain('WithdrawalPicked' as never);
  });
});

describe('hashi/watcher — applyFlow is a PURE fold (invariant 1)', () => {
  it('accumulates pendingMint from DepositApproved and releases it on DepositConfirmed', () => {
    const events = [
      ev(0, 1_000, { kind: 'DepositApproved', requestId: 'd1', sats: 120_000n, approvalTimestampMs: 1_000 }),
      ev(1, 2_000, { kind: 'DepositApproved', requestId: 'd2', sats: 80_000n, approvalTimestampMs: 2_000 }),
      ev(2, 3_000, { kind: 'DepositConfirmed', requestId: 'd1', sats: 120_000n }),
    ];
    const flow = applyFlow(FLOW_STATE_ZERO, events, 3_000);
    expect(flow.pendingMintSats).toBe(80_000n);
    expect(flow.atMs).toBe(3_000);
  });

  it('tracks pendingBurn and queueDepth with the WithdrawalConfirmed join (no amount on chain)', () => {
    const events = [
      ev(0, 1_000, { kind: 'WithdrawalRequested', requestId: 'w1', sats: 50_000n, bitcoinAddress: p2trAddress(), requesterAddress: '0x1' }),
      ev(1, 1_500, { kind: 'WithdrawalRequested', requestId: 'w2', sats: 70_000n, bitcoinAddress: p2trAddress(), requesterAddress: '0x1' }),
      ev(2, 2_000, { kind: 'WithdrawalSigned', withdrawalTxnId: 't1', requestIds: ['w1'], sats: 50_000n, satsSource: 'requested', signatureCount: 1 }),
      // WithdrawalConfirmed carries request_ids ONLY — the 50_000 comes from the join.
      ev(3, 3_000, { kind: 'WithdrawalConfirmed', withdrawalTxnId: 't1', txid: 'btc', requestIds: ['w1'] }),
    ];
    const flow = applyFlow(FLOW_STATE_ZERO, events, 3_000);
    expect(flow.pendingBurnSats).toBe(70_000n); // 120_000 requested − 50_000 confirmed
    expect(flow.queueDepthSats).toBe(70_000n); // 120_000 requested − 50_000 signed
  });

  it('credits a cancellation to BOTH pendingBurn and queueDepth (the request leaves the queue)', () => {
    const events = [
      ev(0, 1_000, { kind: 'WithdrawalRequested', requestId: 'w1', sats: 50_000n, bitcoinAddress: p2trAddress(), requesterAddress: '0x1' }),
      ev(1, 2_000, { kind: 'WithdrawalCancelled', requestId: 'w1', requesterAddress: '0x1', sats: 50_000n }),
    ];
    const flow = applyFlow(FLOW_STATE_ZERO, events, 2_000);
    expect(flow.pendingBurnSats).toBe(0n);
    expect(flow.queueDepthSats).toBe(0n);
  });

  it('clamps every counter at 0n when a settlement arrives with no matching request (invariant 4)', () => {
    // Leader ordering is discretionary (G3): never assume the Requested came first.
    const orphans = [
      ev(0, 1_000, { kind: 'DepositConfirmed', requestId: 'd9', sats: 999_999n }),
      ev(1, 2_000, { kind: 'WithdrawalCancelled', requestId: 'w9', requesterAddress: '0x1', sats: 999_999n }),
      ev(2, 3_000, { kind: 'WithdrawalSigned', withdrawalTxnId: 't9', requestIds: ['w9'], sats: 999_999n, satsSource: 'requested', signatureCount: 1 }),
    ];
    const flow = applyFlow(FLOW_STATE_ZERO, orphans, 3_000);
    expect(flow.pendingMintSats).toBe(0n);
    expect(flow.pendingBurnSats).toBe(0n);
    expect(flow.queueDepthSats).toBe(0n);
  });

  it('ignores the kinds that carry no flow signal, and never mutates its input', () => {
    const noise = [
      ev(0, 1_000, { kind: 'Minted', coinType: '0x2::btc::BTC', sats: 500_000n }),
      ev(1, 1_100, { kind: 'Burned', coinType: '0x2::btc::BTC', sats: 500_000n }),
      ev(2, 1_200, { kind: 'DepositRequested', requestId: 'd1', sats: 500_000n, requesterAddress: '0x1' }),
      ev(3, 1_300, { kind: 'ExpiredDepositDeleted', requestId: 'd1' }),
      ev(4, 1_400, { kind: 'WithdrawalApproved', requestId: 'w1' }),
      ev(5, 1_500, { kind: 'WithdrawalInputsSigned', withdrawalTxnId: 't1', signedCount: 1n, numInputs: 1n }),
      ev(6, 1_600, { kind: 'WithdrawalPresigsReassigned', withdrawalTxnId: 't1', epoch: 1n, presigStartIndex: 0n }),
    ];
    const before = { ...FLOW_STATE_ZERO };
    const flow = applyFlow(FLOW_STATE_ZERO, noise, 1_600);
    expect(flow.pendingMintSats).toBe(0n);
    expect(flow.pendingBurnSats).toBe(0n);
    expect(flow.queueDepthSats).toBe(0n);
    expect(FLOW_STATE_ZERO).toEqual(before);
  });

  it('is deterministic: identical inputs give an identical FlowState, every time', () => {
    const events = [
      ev(0, 1_000, { kind: 'DepositApproved', requestId: 'd1', sats: 7n, approvalTimestampMs: 1_000 }),
      ev(1, 2_000, { kind: 'WithdrawalRequested', requestId: 'w1', sats: 9n, bitcoinAddress: p2trAddress(), requesterAddress: '0x1' }),
    ];
    const a = applyFlow(FLOW_STATE_ZERO, events, 2_000);
    const b = applyFlow(FLOW_STATE_ZERO, events, 2_000);
    expect(a).toEqual(b);
    // And folding in two halves matches folding the whole (no hidden per-call state).
    const split = applyFlow(applyFlow(FLOW_STATE_ZERO, events.slice(0, 1), 1_000), events.slice(1), 2_000);
    expect(split).toEqual(a);
  });
});

describe('hashi/watcher — cursor, dedup and the retained log (invariants 2 & 5)', () => {
  const stream = (): HashiEvent[] => [
    ev(0, 1_000, { kind: 'DepositApproved', requestId: 'd1', sats: 100_000n, approvalTimestampMs: 1_000 }),
    ev(1, 2_000, { kind: 'WithdrawalRequested', requestId: 'w1', sats: 60_000n, bitcoinAddress: p2trAddress(), requesterAddress: '0x1' }),
    ev(2, 3_000, { kind: 'WithdrawalSigned', withdrawalTxnId: 't1', requestIds: ['w1'], sats: 60_000n, satsSource: 'requested', signatureCount: 1 }),
  ];

  it('drains the stream, folds the flow and then polls empty without moving backwards', async () => {
    const watcher = createWatcher(staticAdapter(stream()));
    expect(watcher.cursor).toEqual(EVENT_CURSOR_GENESIS);

    const first = await watcher.poll();
    expect(first.map((e) => e.kind)).toEqual(['DepositApproved', 'WithdrawalRequested', 'WithdrawalSigned']);
    expect(watcher.cursor.seq).toBe(3n);
    expect(watcher.flow()).toEqual({
      pendingMintSats: 100_000n,
      pendingBurnSats: 60_000n,
      queueDepthSats: 0n,
      atMs: 3_000,
    } satisfies FlowState);

    const second = await watcher.poll();
    expect(second).toEqual([]);
    expect(watcher.cursor.seq).toBe(3n);
    expect(watcher.log()).toHaveLength(3);
  });

  it('deduplicates: an adapter that replays already-seen seqs cannot double-count', async () => {
    const events = stream();
    // This adapter always answers from seq 0, whatever cursor it is given.
    const replaying: HashiAdapter = {
      ...staticAdapter(events),
      async eventsSince() {
        return { events, next: { seq: 0n } };
      },
      async signedEventsSince() {
        return { events: [], next: { seq: 0n } };
      },
    };

    const watcher = createWatcher(replaying);
    const a = await watcher.poll();
    expect(a).toHaveLength(3);
    const b = await watcher.poll();
    expect(b).toEqual([]); // every seq was already folded in
    expect(watcher.log()).toHaveLength(3);
    expect(watcher.flow().pendingMintSats).toBe(100_000n); // NOT 200_000n
    expect(watcher.cursor.seq).toBe(3n); // never dragged back to 0
  });

  it('honours batchLimit and resumes exactly at the next seq', async () => {
    const watcher = createWatcher(staticAdapter(stream()), { batchLimit: 2 });
    expect((await watcher.poll()).map((e) => Number(e.seq))).toEqual([0, 1]);
    expect(watcher.cursor.seq).toBe(2n);
    expect((await watcher.poll()).map((e) => Number(e.seq))).toEqual([2]);
    expect(watcher.cursor.seq).toBe(3n);
  });

  it('restricts the subscription when `kinds` is given', async () => {
    const watcher = createWatcher(staticAdapter(stream()), { kinds: ['WithdrawalSigned'] });
    const batch = await watcher.poll();
    expect(batch.map((e) => e.kind)).toEqual(['WithdrawalSigned']);
    expect(watcher.log()).toHaveLength(1);
  });

  it('retainLog:false keeps no log and folds incrementally instead', async () => {
    const watcher = createWatcher(staticAdapter(stream()), { retainLog: false, batchLimit: 1 });
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    expect(watcher.log()).toEqual([]);
    expect(watcher.flow().pendingMintSats).toBe(100_000n);
    expect(watcher.flow().queueDepthSats).toBe(0n);
  });

  it('checkpoint() round-trips: a fresh watcher resumes without re-reading history', async () => {
    const events = stream();
    const first = createWatcher(staticAdapter(events), { batchLimit: 2, retainLog: false });
    await first.poll();
    const checkpoint = first.checkpoint();
    expect(checkpoint.cursor.seq).toBe(2n);

    const resumed = createWatcher(staticAdapter(events), {
      startCursor: checkpoint.cursor,
      startFlow: checkpoint.flow,
      retainLog: false,
    });
    const tail = await resumed.poll();
    expect(tail.map((e) => Number(e.seq))).toEqual([2]);
    // 100_000 approved (carried in the checkpoint) survived the process boundary.
    expect(resumed.flow().pendingMintSats).toBe(100_000n);
    expect(resumed.flow().queueDepthSats).toBe(0n);
  });

  it('a stale startCursor cannot rewind the high-water mark', async () => {
    const events = stream();
    const watcher = createWatcher(staticAdapter(events), { startCursor: { seq: 2n } });
    const batch = await watcher.poll();
    expect(batch.map((e) => Number(e.seq))).toEqual([2]);
    expect(watcher.cursor.seq).toBe(3n);
  });

  it('signedSince passes straight through to the adapter sub-stream (G5)', async () => {
    const watcher = createWatcher(staticAdapter(stream()));
    const { events } = await watcher.signedSince({ seq: 0n });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('WithdrawalSigned');
    expect(events[0]?.sats).toBe(60_000n);
  });
});

describe('hashi/watcher — deterministic under the MOCK (T2.2 acceptance, invariant 3)', () => {
  it('two independent mock runs produce byte-identical normalized logs and flow states', async () => {
    const cfg = testConfig();
    const runA = await runMockLifecycle(cfg);
    const runB = await runMockLifecycle(cfg);

    const drain = async (mock: MockHashiAdapter) => {
      const watcher = createWatcher(mock);
      for (let i = 0; i < 20; i++) {
        if ((await watcher.poll()).length === 0) break;
      }
      return watcher;
    };

    const a = await drain(runA);
    const b = await drain(runB);

    const shape = (events: readonly HashiEvent[]) =>
      events.map((e) => `${e.seq}:${e.kind}:${e.atMs}:${e.atSecs}`);

    expect(shape(a.log())).toEqual(shape(b.log()));
    expect(a.log().length).toBeGreaterThan(0);
    expect(a.flow()).toEqual(b.flow());
    expect(a.cursor).toEqual(b.cursor);
  });

  it('reconstructs the mock lifecycle: mint released on confirm, burn still open until Confirmed', async () => {
    const cfg = testConfig();
    const mock = await runMockLifecycle(cfg);
    const watcher = createWatcher(mock);
    for (let i = 0; i < 20; i++) {
      if ((await watcher.poll()).length === 0) break;
    }

    const kinds = watcher.log().map((e) => e.kind);
    expect(kinds).toContain('DepositApproved');
    expect(kinds).toContain('DepositConfirmed');
    expect(kinds).toContain('WithdrawalRequested');
    expect(kinds).toContain('WithdrawalSigned');
    expect(kinds).toContain('WithdrawalConfirmed');

    const flow = watcher.flow();
    // The deposit was cranked to Confirmed, so nothing is pending on the mint side.
    expect(flow.pendingMintSats).toBe(0n);
    // The withdrawal reached Confirmed, so the burn settled and the queue drained.
    expect(flow.pendingBurnSats).toBe(0n);
    expect(flow.queueDepthSats).toBe(0n);
  });

  it('folding the whole retained log reproduces the incremental flow exactly', async () => {
    const cfg = testConfig();
    const mock = await runMockLifecycle(cfg);
    const watcher = createWatcher(mock, { batchLimit: 2 });
    for (let i = 0; i < 40; i++) {
      if ((await watcher.poll()).length === 0) break;
    }
    const log = watcher.log();
    const last = log[log.length - 1] as HashiEvent;
    expect(applyFlow(FLOW_STATE_ZERO, log, last.atMs)).toEqual(watcher.flow());
  });

  it('mid-stream: the queue depth is non-zero between Requested and Signed (G3 congestion signal)', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(2);
    await mock.requestWithdrawal({ sats: 200_000n, bitcoinAddress: p2trAddress(), signer: user });

    const watcher = createWatcher(mock);
    await watcher.poll();
    expect(watcher.flow().queueDepthSats).toBe(200_000n);
    expect(watcher.flow().pendingBurnSats).toBe(200_000n);

    // FAST timings: approval +20 s, batch +20 s, sign +20 s, confirm +60 s. Land between the
    // last two so the bucket has debited but the Bitcoin side has not settled yet.
    mock.advanceMs(70_000);
    await watcher.poll();
    const kinds = watcher.log().map((e) => e.kind);
    expect(kinds).toContain('WithdrawalSigned');
    expect(kinds).not.toContain('WithdrawalConfirmed');
    expect(watcher.flow().queueDepthSats).toBe(0n);
    // Still pending on the Bitcoin side until WithdrawalConfirmed lands.
    expect(watcher.flow().pendingBurnSats).toBe(200_000n);
  });
});
