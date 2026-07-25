// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5  (pre-flight for T4.3 verify/)
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §13 A2 (THE parity acceptance criterion), §9.2 (deriveLimiter)
// @spec       docs/GOLDEN-RULES.md#g5
// @rules      G3 G5 G7
// @depends    ../src/hashi/mock.ts (T0.5) · ../src/hashi/limiter.ts (T0.5)
// @facts      ★ A2: `mock.limiterStatus()` at logical t MUST equal the value derived by replaying
// @facts        `mock.signedEventsSince(0)` through the SAME projectCapacity/consume, for a
// @facts        seeded randomized sequence. This IS the G5 claim, tested.
// @facts      The replay assigns limiter seq = index in the WithdrawalSigned stream. That is
// @facts        valid precisely because a REJECTED batch emits NO event and does not advance
// @facts        `next_seq` (G3) — so the stream has no gaps.
// @facts      ✔ B6 CLOSED (T4.3): the local `deriveLimiter` stand-in that used to live here is GONE.
// @facts        This file now imports the REAL `../src/verify/limiter.js` — the parity assertion and
// @facts        the production replay are the same code, so they cannot drift apart (G5).
// @facts      The real `deriveLimiter` takes the FULL event slice (not just the Signed sub-stream)
// @facts        because E-K3 requires the `WithdrawalRequested` join to recover the debit amount.
// @implements a seeded randomized deposit/withdrawal sequence + the parity assertion
// @invariant  1. deriveLimiter uses ONLY on-chain-observable events + the two genesis scalars.
// @verify     npm test -- limiter.cross
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { type LimiterConfig } from '../src/hashi/limiter.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import { createRng } from '../src/util/rng.js';
import { deriveLimiter, limiterAt } from '../src/verify/limiter.js';

import { FAST, p2trAddress, testConfig, testSigner } from './support/fixtures.js';

async function assertParity(cfg: LimiterConfig, mock: MockHashiAdapter, label: string): Promise<void> {
  const live = await mock.guardian.limiterStatus();
  // The FULL slice: Signed carries no amount, so the replay joins it to WithdrawalRequested (E-K3).
  const { events } = await mock.eventsSince({ seq: 0n });
  const derived = deriveLimiter(events, { limiter: cfg });

  expect(derived.final.nextSeq, `${label}: next_seq`).toBe(live.nextSeq);
  expect(derived.final.numTokensAvailableSats, `${label}: stored tokens`).toBe(
    mock.limiterState().numTokensAvailableSats,
  );
  expect(derived.final.lastUpdatedAtSecs, `${label}: last_updated_at`).toBe(
    mock.limiterState().lastUpdatedAtSecs,
  );
  expect(limiterAt(derived, live.asOfMs, { limiter: cfg }).tokens, `${label}: projected tokens`).toBe(
    live.tokens,
  );
  // Every boundary joined to a REQUESTED amount, and nothing was rejected in the emitted stream (G3).
  expect(derived.unresolvedCount, `${label}: unresolved boundaries`).toBe(0);
  expect(derived.rejectedCount, `${label}: rejected boundaries`).toBe(0);
}

describe('A2 — mock.limiterStatus() === replay of mock.signedEventsSince(0) (G5)', () => {
  it('holds at every boundary of a seeded randomized deposit/withdrawal sequence', async () => {
    const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '250', MAX_BUCKET_CAPACITY_SATS: '2000000' });
    const mock = createMockHashiAdapter(cfg, { ...FAST, seed: 'A2-cross-test' });
    const rng = createRng('A2-cross-test-driver');
    const users = [testSigner(11), testSigner(12), testSigner(13)];

    await assertParity(cfg.limiter, mock, 'genesis');

    for (let round = 0; round < 40; round++) {
      const user = rng.pick(users);

      switch (rng.nextInt(3)) {
        case 0: {
          // Deposit + the permissionless crank.
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
          // Withdrawal — sometimes larger than the current bucket, so batches ARE rejected (G3).
          const sats = 30_000n + rng.nextBelow(900_000n);
          await mock.requestWithdrawal({
            sats,
            bitcoinAddress: p2trAddress(round & 0xff),
            signer: user,
          });
          break;
        }
        default: {
          // Pure time passing — refills the bucket and lets pending batches progress.
          mock.advanceMs(rng.nextInt(400_000) + 1_000);
          break;
        }
      }

      await assertParity(cfg.limiter, mock, `round ${round}`);
    }

    // The sequence must have actually exercised the bucket, otherwise the test proves nothing.
    const { events } = await mock.signedEventsSince({ seq: 0n });
    expect(events.length).toBeGreaterThan(3);
    expect(mock.limiterState().nextSeq).toBe(BigInt(events.length));
  });

  it('a rejected (over-capacity) batch emits NO WithdrawalSigned, so the replay stays gap-free (G3)', async () => {
    const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '0', MAX_BUCKET_CAPACITY_SATS: '100000' });
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(14);

    // 60_000 fits; 60_000 again does not (bucket never refills at rate 0).
    await mock.requestWithdrawal({ sats: 60_000n, bitcoinAddress: p2trAddress(1), signer: user });
    mock.advanceMs(200_000);
    await mock.requestWithdrawal({ sats: 60_000n, bitcoinAddress: p2trAddress(2), signer: user });
    mock.advanceMs(5_000_000);

    const { events: signed } = await mock.signedEventsSince({ seq: 0n });
    expect(signed).toHaveLength(1);
    expect(signed[0]?.sats).toBe(60_000n);

    const { events } = await mock.eventsSince({ seq: 0n });
    const derived = deriveLimiter(events, { limiter: cfg.limiter });
    expect(derived.final.numTokensAvailableSats).toBe(40_000n);
    expect(derived.final.nextSeq).toBe(1n);
    // The second withdrawal was never signed, so it is still sitting in the global queue (G3).
    expect(derived.finalQueueDepth).toBe(60_000n);
    await assertParity(cfg.limiter, mock, 'after rejection');
  });
});
