// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1
// @phase      0
// @status     DONE
// @spec       docs/APP.md §2.2 (the six stages, L71-L84), §5 (pre-stage table)
// @spec       docs/RECON.md R6 (live Hashi config), R8 (real event names)
// @rules      G1 G6
// @depends    ./types.ts · ./synthetic.ts · ../config.ts
// @facts      bitcoin_confirmation_threshold  = 6            (RECON R6, live)
// @facts      bitcoin_deposit_time_delay_ms   = 600_000      (RECON R6, live)
// @facts      bitcoin_deposit_minimum         = 30_000 sats  (RECON R6, live)
// @facts      confirm_deposit is PERMISSIONLESS — anyone may crank it. Our keeper
// @facts        cranks it for EVERY pending deposit, not only ours. (RECON R7)
// @facts      Total wall clock stages 1-4 ≈ 70 min. Stages 5-6 are Sui-instant.
// @facts        NEVER present the total as fast (G1/G6).
// @implements export const DEPOSIT_STAGES: readonly LifecycleStage[]
//             export const depositFixtures: readonly DepositFixture[]
//             export const warmDeposit: DepositFixture
// @forbidden  a fixture that implies the BTC leg can be watched live (G6)
// @invariant  1. DEPOSIT_STAGES has exactly 6 entries.
// @invariant  2. Stages 1-3 are timeClass 'bitcoin', 4 is 'delay', 5-6 are 'sui'.
// @ac         docs/APP.md §7 A2 A3
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

import { synthBech32, synthDigest, synthId } from './synthetic';
import type { DepositFixture, LifecycleStage } from './types';

/** docs/APP.md §2.2 — exactly six stages, with honest time classes. */
export const DEPOSIT_STAGES: readonly LifecycleStage[] = [
  {
    index: 1,
    label: 'BTC sent (unconfirmed)',
    signal: 'signet mempool → deposit::DepositRequested',
    timeClass: 'bitcoin',
    expected: 'minutes',
  },
  {
    index: 2,
    label: `${config.hashi.confirmations} BTC confirmations`,
    signal: 'signet blocks (~10 min/block)',
    timeClass: 'bitcoin',
    expected: '~60 min',
  },
  {
    index: 3,
    label: 'Committee approved',
    signal: 'deposit::DepositApproved (+ sanctions screen)',
    timeClass: 'bitcoin',
    expected: 'minutes',
  },
  {
    index: 4,
    label: 'Mandatory 10-min delay',
    signal: `bitcoin_deposit_time_delay_ms = ${config.hashi.depositDelayMs}`,
    timeClass: 'delay',
    expected: '10 min, fixed',
  },
  {
    index: 5,
    label: 'confirm_deposit (permissionless)',
    signal: 'deposit::DepositConfirmed → treasury::Minted',
    timeClass: 'sui',
    expected: 'Sui: instant',
  },
  {
    index: 6,
    label: 'Swept into vault shares',
    signal: 'sponsored PTB digest + vault share event',
    timeClass: 'sui',
    expected: 'Sui: instant',
  },
];

/**
 * Standing ops keep 2-3 deposits WARM so the demo never waits on signet (G6).
 * `warmDeposit` is the one parked at stage 4 — the live `confirm_deposit` crank
 * advances it to 5 on screen, which is a REAL on-chain transition.
 */
export const depositFixtures: readonly DepositFixture[] = [
  {
    suiAddress: synthId(0xa1),
    depositAddress: synthBech32('p', 58),
    stage: 4,
    confs: 6,
    requestId: synthId(0xd1),
    amountSats: 120_000n,
  },
  {
    suiAddress: synthId(0xa1),
    depositAddress: synthBech32('p', 58),
    stage: 6,
    confs: 6,
    requestId: synthId(0xd2),
    amountSats: 250_000n,
    mintDigest: synthDigest('mint-d2'),
    sweepDigest: synthDigest('sweep-d2'),
  },
  {
    suiAddress: synthId(0xa2),
    depositAddress: synthBech32('p', 58),
    stage: 2,
    confs: 3,
    requestId: synthId(0xd3),
    amountSats: 45_000n,
  },
];

/** The deposit the demo cranks live. */
export const warmDeposit: DepositFixture = depositFixtures[0]!;
