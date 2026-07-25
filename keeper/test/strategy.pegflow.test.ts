// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.1
// @phase      5
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-5 (T5.1) · docs/KEEPER.md §3.1
// @rules      G1 G3 G5 G8
// @depends    ../src/strategy/pegflow.ts · ../src/hashi/types.ts · ./support/fixtures.ts
// @facts      Events are built by hand (not by the mock) so each settlement join is asserted in
// @facts        isolation. Every timestamp is an ARGUMENT — no clock is read anywhere (G5).
// @facts      ⚠ `WithdrawalConfirmed` carries `requestIds` and NO amount (docs/RECON.md R8) ⇒
// @facts        settlement is matched by REQUEST ID; a test that summed settle-side amounts
// @facts        would be asserting a field that does not exist upstream.
// @implements T5.1 acceptance — strategy consumes pending mint/burn + limiter status
// @invariant  1. Same inputs ⇒ deep-equal signal (purity).
// @verify     npm run test -- strategy.pegflow
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import type { HashiEvent } from '../src/hashi/types.js';
import { defaultParams, validateParams } from '../src/strategy/params.js';
import { flowSkewBps, netFlowSkewBps, pegFlow, SATS_PER_BTC } from '../src/strategy/pegflow.js';
import type { LimiterSample } from '../src/types.js';

import { p2trAddress, testConfig } from './support/fixtures.js';

const cfg = testConfig();
const params = defaultParams(cfg);

const NOW_MS = 1_800_000_000_000;
const WINDOW = { nowMs: NOW_MS, lookbackMs: 3_600_000 } as const;

let nextSeq = 0n;
function base(atMs: number): { seq: bigint; atMs: number; atSecs: bigint } {
  nextSeq += 1n;
  return { seq: nextSeq, atMs, atSecs: BigInt(Math.floor(atMs / 1000)) };
}

const SUI_ADDR = `0x${'ab'.repeat(32)}`;

function depositApproved(requestId: string, sats: bigint, atMs: number): HashiEvent {
  return { ...base(atMs), kind: 'DepositApproved', requestId, sats, approvalTimestampMs: atMs };
}
function depositConfirmed(requestId: string, sats: bigint, atMs: number): HashiEvent {
  return { ...base(atMs), kind: 'DepositConfirmed', requestId, sats };
}
function withdrawalRequested(requestId: string, sats: bigint, atMs: number): HashiEvent {
  return {
    ...base(atMs),
    kind: 'WithdrawalRequested',
    requestId,
    sats,
    bitcoinAddress: p2trAddress(),
    requesterAddress: SUI_ADDR,
  };
}
function withdrawalSigned(requestIds: string[], sats: bigint, atMs: number): HashiEvent {
  return {
    ...base(atMs),
    kind: 'WithdrawalSigned',
    withdrawalTxnId: `txn-${requestIds.join('-')}`,
    requestIds,
    sats,
    satsSource: 'requested',
    signatureCount: 2,
  };
}
function withdrawalConfirmed(requestIds: string[], atMs: number): HashiEvent {
  return {
    ...base(atMs),
    kind: 'WithdrawalConfirmed',
    withdrawalTxnId: `txn-${requestIds.join('-')}`,
    txid: 'ff'.repeat(32),
    requestIds,
  };
}
function withdrawalCancelled(requestId: string, sats: bigint, atMs: number): HashiEvent {
  return { ...base(atMs), kind: 'WithdrawalCancelled', requestId, requesterAddress: SUI_ADDR, sats };
}

function sample(atMs: number, tokens: bigint, queueDepth = 0n): LimiterSample {
  return { atMs, atSecs: BigInt(Math.floor(atMs / 1000)), tokens, queueDepth };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/pegflow — the PUBLIC signal (G8)', () => {
  it('invariant 4 — an empty window yields a zeroed signal, never a throw', () => {
    const s = pegFlow([], [], WINDOW);
    expect(s).toEqual({
      pendingMintSats: 0n,
      pendingBurnSats: 0n,
      netFlowSats: 0n,
      limiterUtilisationBps: 0,
      tightening: false,
      atMs: NOW_MS,
    });
  });

  it('DepositApproved telegraphs supply + ~10 min before the mint; DepositConfirmed clears it', () => {
    const s = pegFlow(
      [
        depositApproved('d1', 500_000n, NOW_MS - 600_000),
        depositApproved('d2', 250_000n, NOW_MS - 300_000),
        depositConfirmed('d1', 500_000n, NOW_MS - 60_000),
      ],
      [],
      WINDOW,
    );
    expect(s.pendingMintSats).toBe(250_000n);
    expect(s.pendingBurnSats).toBe(0n);
    expect(s.netFlowSats).toBe(250_000n);
  });

  it('an expired deposit clears the telegraphed mint too', () => {
    const expired: HashiEvent = {
      ...base(NOW_MS - 10_000),
      kind: 'ExpiredDepositDeleted',
      requestId: 'd9',
    };
    const s = pegFlow([depositApproved('d9', 999_000n, NOW_MS - 60_000), expired], [], WINDOW);
    expect(s.pendingMintSats).toBe(0n);
  });

  it('WithdrawalRequested telegraphs supply −; Signed / Confirmed / Cancelled settle it BY REQUEST ID', () => {
    const events = [
      withdrawalRequested('w1', 100_000n, NOW_MS - 900_000),
      withdrawalRequested('w2', 200_000n, NOW_MS - 800_000),
      withdrawalRequested('w3', 300_000n, NOW_MS - 700_000),
      withdrawalRequested('w4', 400_000n, NOW_MS - 600_000),
      // Signed is the batch event: it settles EVERY request id it carries.
      withdrawalSigned(['w1', 'w2'], 300_000n, NOW_MS - 500_000),
      withdrawalConfirmed(['w3'], NOW_MS - 400_000),
    ];
    const s = pegFlow(events, [], WINDOW);
    expect(s.pendingBurnSats).toBe(400_000n); // only w4 is still outstanding

    const withCancel = pegFlow([...events, withdrawalCancelled('w4', 400_000n, NOW_MS - 100_000)], [], WINDOW);
    expect(withCancel.pendingBurnSats).toBe(0n);
  });

  it('invariant 2 — netFlowSats is SIGNED: burn > mint gives a negative bigint', () => {
    const s = pegFlow(
      [
        depositApproved('d1', 100_000n, NOW_MS - 120_000),
        withdrawalRequested('w1', 900_000n, NOW_MS - 120_000),
      ],
      [],
      WINDOW,
    );
    expect(s.netFlowSats).toBe(-800_000n);
    expect(typeof s.netFlowSats).toBe('bigint');
  });

  it('invariant 1 — the window is an ARGUMENT: events outside the lookback are ignored', () => {
    const events = [
      depositApproved('old', 1_000_000n, NOW_MS - WINDOW.lookbackMs - 1),
      depositApproved('new', 7_000n, NOW_MS - 1),
      depositApproved('future', 5_000_000n, NOW_MS + 1),
    ];
    const s = pegFlow(events, [], WINDOW);
    expect(s.pendingMintSats).toBe(7_000n);
  });

  it('invariant 3 — tightening is read off the REPLAYED trajectory (G5), never an SDK hint', () => {
    const draining = [
      sample(NOW_MS - 3_000_000, 9_000_000_000n),
      sample(NOW_MS - 1_000_000, 6_000_000_000n),
      sample(NOW_MS - 10_000, 4_000_000_000n),
    ];
    const refilling = [...draining].reverse().map((s, i) => sample(NOW_MS - 3_000_000 + i * 1_000_000, s.tokens));

    expect(pegFlow([], draining, WINDOW).tightening).toBe(true);
    expect(pegFlow([], refilling, WINDOW).tightening).toBe(false);
    // A single boundary cannot show a slope — and must not pretend to.
    expect(pegFlow([], [sample(NOW_MS - 10_000, 1n)], WINDOW).tightening).toBe(false);
  });

  it('utilisation is measured against the genesis cap when it is known (the only trust anchor)', () => {
    const traj = [sample(NOW_MS - 20_000, 10_000_000_000n), sample(NOW_MS - 10_000, 2_500_000_000n)];
    const s = pegFlow([], traj, WINDOW, {
      refillRateSatsPerSec: 115_740n,
      maxBucketCapacitySats: 10_000_000_000n,
    });
    expect(s.limiterUtilisationBps).toBe(2_500);
    expect(s.atMs).toBe(NOW_MS - 10_000);
    expect(s.tightening).toBe(true);
  });

  it('with no genesis cap it falls back to the largest OBSERVED balance (an honest bound)', () => {
    const traj = [sample(NOW_MS - 20_000, 8_000_000n), sample(NOW_MS - 10_000, 2_000_000n)];
    expect(pegFlow([], traj, WINDOW).limiterUtilisationBps).toBe(2_500);
  });

  it('ignores limiter samples in the future and is order-insensitive (deterministic sort)', () => {
    const traj = [
      sample(NOW_MS + 60_000, 1n),
      sample(NOW_MS - 10_000, 4_000_000_000n),
      sample(NOW_MS - 20_000, 10_000_000_000n),
    ];
    const s = pegFlow([], traj, WINDOW, {
      refillRateSatsPerSec: 115_740n,
      maxBucketCapacitySats: 10_000_000_000n,
    });
    expect(s.atMs).toBe(NOW_MS - 10_000);
    expect(s.limiterUtilisationBps).toBe(4_000);
  });

  it('is PURE — the same inputs produce a deep-equal signal', () => {
    const events = [
      depositApproved('a', 123_456n, NOW_MS - 5_000),
      withdrawalRequested('b', 654_321n, NOW_MS - 4_000),
    ];
    const traj = [sample(NOW_MS - 3_000, 5n), sample(NOW_MS - 2_000, 4n)];
    expect(pegFlow(events, traj, WINDOW)).toEqual(pegFlow(events, traj, WINDOW));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/pegflow — the PRIVATE response (G8)', () => {
  it('scales the lean per BTC of telegraphed net flow', () => {
    // flowSensitivityBps = 50 bps per BTC ⇒ 0.4 BTC of net mint = 20 bps of lean.
    const wide = validateParams({ ...params, spreadBps: 500 }, cfg);
    expect(netFlowSkewBps((SATS_PER_BTC * 4n) / 10n, wide)).toBe(20);
    expect(netFlowSkewBps(-((SATS_PER_BTC * 4n) / 10n), wide)).toBe(-20);
    expect(netFlowSkewBps(0n, wide)).toBe(0);
  });

  it('clamps the lean to ±spreadBps so peg-flow can never invert the quote', () => {
    expect(netFlowSkewBps(SATS_PER_BTC * 10_000n, params)).toBe(params.spreadBps);
    expect(netFlowSkewBps(-SATS_PER_BTC * 10_000n, params)).toBe(-params.spreadBps);
  });

  it('flowSkewBps consumes the public signal and returns the private lean', () => {
    const signal = pegFlow(
      [depositApproved('d', SATS_PER_BTC * 2n, NOW_MS - 1_000)],
      [],
      WINDOW,
    );
    expect(signal.pendingMintSats).toBe(SATS_PER_BTC * 2n);
    // 2 BTC * 50 bps/BTC = 100 bps, clamped to the 30 bps default half-spread.
    expect(flowSkewBps(signal, params)).toBe(params.spreadBps);
  });

  it('a zero-sensitivity strategy ignores the signal entirely (the response is the secret)', () => {
    const deaf = validateParams({ ...params, flowSensitivityBps: 0 }, cfg);
    expect(netFlowSkewBps(SATS_PER_BTC * 50n, deaf)).toBe(0);
  });
});
