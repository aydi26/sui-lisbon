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
// @facts      ⚠ `deriveLimiter` is implemented INLINE here on purpose: the real
// @facts        `keeper/src/verify/limiter.ts` arrives at T4.3 and is owned by a later task.
// @facts        When it lands, DELETE the local copy and import it — the assertion must not drift.
// @implements a seeded randomized deposit/withdrawal sequence + the parity assertion
// @implements the local `deriveLimiter` stand-in (to be replaced by verify/ at T4.3)
// @invariant  1. deriveLimiter uses ONLY on-chain-observable events + the two genesis scalars.
// @verify     npm test -- limiter.cross
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { consume, genesis, msToSecs, projectCapacityAtSecs, type LimiterConfig, type LimiterState } from '../src/hashi/limiter.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import type { HashiEventOf, Sats } from '../src/hashi/types.js';
import { createRng } from '../src/util/rng.js';

import { FAST, p2trAddress, testConfig, testSigner } from './support/fixtures.js';

/**
 * TODO(T4.3): delete this and import `deriveLimiter` from `../src/verify/limiter.js`.
 *
 * Trustless re-derivation of the Guardian bucket from the on-chain `WithdrawalSigned` stream
 * (G5). The ONLY inputs are the events and the two genesis scalars — no SDK read, no guardian
 * endpoint, no trust in the keeper.
 */
function deriveLimiter(
  cfg: LimiterConfig,
  signedEvents: readonly HashiEventOf<'WithdrawalSigned'>[],
): { state: LimiterState; samples: { atSecs: bigint; tokens: Sats }[] } {
  let state = genesis(cfg);
  const samples: { atSecs: bigint; tokens: Sats }[] = [];

  signedEvents.forEach((event, index) => {
    // seq = index: the signed stream is gap-free because rejected batches emit nothing (G3).
    const result = consume(cfg, state, BigInt(index), event.atSecs, event.sats);
    if (!result.ok) {
      throw new Error(`replay diverged at index ${index}: ${result.error} (${result.reason})`);
    }
    state = result.state;
    samples.push({ atSecs: event.atSecs, tokens: state.numTokensAvailableSats });
  });

  return { state, samples };
}

/** Capacity the replay projects at an arbitrary logical instant. */
function replayTokensAt(cfg: LimiterConfig, state: LimiterState, atMs: number): Sats {
  return projectCapacityAtSecs(cfg, state, msToSecs(atMs));
}

async function assertParity(cfg: LimiterConfig, mock: MockHashiAdapter, label: string): Promise<void> {
  const live = await mock.guardian.limiterStatus();
  const { events } = await mock.signedEventsSince({ seq: 0n });
  const derived = deriveLimiter(cfg, events);

  expect(derived.state.nextSeq, `${label}: next_seq`).toBe(live.nextSeq);
  expect(derived.state.numTokensAvailableSats, `${label}: stored tokens`).toBe(
    mock.limiterState().numTokensAvailableSats,
  );
  expect(derived.state.lastUpdatedAtSecs, `${label}: last_updated_at`).toBe(
    mock.limiterState().lastUpdatedAtSecs,
  );
  expect(replayTokensAt(cfg, derived.state, live.asOfMs), `${label}: projected tokens`).toBe(live.tokens);
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

    const { events } = await mock.signedEventsSince({ seq: 0n });
    expect(events).toHaveLength(1);
    expect(events[0]?.sats).toBe(60_000n);

    const derived = deriveLimiter(cfg.limiter, events);
    expect(derived.state.numTokensAvailableSats).toBe(40_000n);
    expect(derived.state.nextSeq).toBe(1n);
    await assertParity(cfg.limiter, mock, 'after rejection');
  });
});
