// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §4.2 (bridge column + trustless replay, L173-L189)
// @spec       docs/RECON.md R9 (exact limiter algorithm + golden vectors)
// @rules      G3 G5
// @depends    ./types.ts · ./synthetic.ts
// @facts      project_capacity(cfg, state, ts_secs) =
// @facts        min(cap, tokens + (ts_secs - last_updated_at) * refill_rate)
// @facts        with SATURATING arithmetic. Time base = UNIX SECONDS. (RECON R9)
// @facts      consume(): capacity < amount ⇒ RateLimitExceeded — the batch is
// @facts        REJECTED, never queued. You cannot buy priority. (G3, RECON R9)
// @facts      GOLDEN VECTOR #1 (shared with keeper/src/hashi/limiter.ts tests and
// @facts        move/tests/envelope_tests.move): tokens 100_000, refill 10/s,
// @facts        last 0, cap 2_000_000 → capacity at t=15 s is 105_000.
// @facts      ⚠ U1 UNRESOLVED: the live genesis scalars are NOT on-chain and the
// @facts        guardian endpoint is gRPC-only. {refill_rate 1000 sats/s,
// @facts        max_bucket 100_000_000 sats} is the sample-config prior — label it
// @facts        a BOUND, not a fact. Not load-bearing (risk input only).
// @facts      ⚠ WithdrawalSigned carries NO amount and NO timestamp: sats come
// @facts        from Σ WithdrawalRequested.btc_amount over request_ids, and the
// @facts        timestamp from the Sui event envelope. (RECON R8)
// @implements export const bridgeFixture: BridgeFixture
// @forbidden  presenting sdkLimiter as the source of truth — it is ADVISORY (G5)
// @forbidden  any field implying a purchasable queue slot — G3
// @invariant  1. expectedReplay is exactly reproducible from `events` by
//                projectCapacity() — the fixture uses golden vector #1.
// @invariant  2. sdkLimiter.capacitySats === expectedReplay.capacitySats (they
//                agree in the happy path; a discrepancy must be surfaced loudly).
// @ac         docs/APP.md §7 A7
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { synthId } from './synthetic';
import type { BridgeFixture } from './types';

const REQ_A = synthId(0xb1);
const REQ_B = synthId(0xb2);
const REQ_C = synthId(0xb3);

/** t0 = the bucket's `last_updated_at`, expressed in ms for the Sui envelope. */
const T0_MS = 0;
const SEC = 1_000;

export const bridgeFixture: BridgeFixture = {
  events: [
    {
      name: 'withdrawal_queue::WithdrawalRequested',
      timestampMs: T0_MS + 2 * SEC,
      requestIds: [REQ_A],
      satsAmount: 40_000n,
    },
    {
      name: 'withdrawal_queue::WithdrawalRequested',
      timestampMs: T0_MS + 4 * SEC,
      requestIds: [REQ_B],
      satsAmount: 35_000n,
    },
    {
      name: 'withdrawal_queue::WithdrawalPickedForProcessing',
      timestampMs: T0_MS + 8 * SEC,
      requestIds: [REQ_A, REQ_B],
      satsAmount: 75_000n,
    },
    {
      // Advances the bucket. Amount is Σ over request_ids; ts is the envelope.
      name: 'withdrawal_queue::WithdrawalSigned',
      timestampMs: T0_MS + 10 * SEC,
      requestIds: [REQ_A, REQ_B],
      satsAmount: 75_000n,
    },
    {
      name: 'withdrawal_queue::WithdrawalRequested',
      timestampMs: T0_MS + 12 * SEC,
      requestIds: [REQ_C],
      satsAmount: 30_000n,
    },
  ],

  // Advisory read from guardian.limiterStatus. Labelled as such in the UI (G5).
  sdkLimiter: {
    capacitySats: 105_000n,
    refillRatePerSec: 10n,
    maxBucketSats: 2_000_000n,
    queueDepth: 1,
    source: 'sdk',
  },

  // What keeper verify/ must re-derive from `events` alone, over
  // projectCapacity() — golden vector #1 (RECON R9).
  expectedReplay: {
    capacitySats: 105_000n,
    refillRatePerSec: 10n,
    maxBucketSats: 2_000_000n,
    queueDepth: 1,
    source: 'replay',
  },

  trajectory: [
    {
      tsSec: 10,
      tokensBeforeSats: 100_000n + 10n * 10n,
      consumedSats: 75_000n,
      tokensAfterSats: 25_100n,
      rejected: false,
    },
    {
      tsSec: 15,
      tokensBeforeSats: 25_100n + 10n * 5n,
      consumedSats: 0n,
      tokensAfterSats: 25_150n,
      rejected: false,
    },
  ],

  genesisScalars: {
    refillRatePerSec: 10n,
    maxBucketSats: 2_000_000n,
    provenance:
      'GOLDEN VECTOR #1 (docs/RECON.md R9). The LIVE scalars are U1-UNRESOLVED: not on-chain, guardian is gRPC-only. Treat any live figure as a bound, not a fact.',
  },
};
