// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §3.2 (two-phase exit lifecycle, L126-L132), §5
// @spec       docs/RECON.md R7 (withdraw.move signatures + the sender-bound cancel)
// @rules      G2 G3 G6
// @depends    ./types.ts · ./synthetic.ts
// @facts      request_withdrawal asserts btc.value() >= 30_000  EBelowMinimumWithdrawal
// @facts      request_withdrawal asserts addr_len == 20 || 32   EInvalidBitcoinAddress
// @facts      cancel_withdrawal asserts request.sender == ctx.sender()  ⇒ reclaim is
// @facts        DEPOSITOR-callable ONLY; the keeper can NEVER call it. (RECON R7)
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000   (RECON R6, live)
// @facts      Phase A is ONE Sui checkpoint (instant). Phase B is ~1.5-2 h on
// @facts        signet and is ALWAYS pre-staged — never live in the demo (G6).
// @implements export const EXIT_PHASES: readonly LifecycleStage[]
//             export const exitFixtures: readonly ExitFixture[]
//             export const prestagedConfirmedExit: ExitFixture
// @forbidden  a fixture field expressing queue POSITION or priority — G3. The
//             bucket rejects over-capacity batches; it does not hold an orderable
//             queue you can pay into.
// @forbidden  any fixture in which the exit destination differs from the pinned
//             address — G2
// @invariant  1. Every fixture's destination is the on-chain-pinned address.
// @invariant  2. prestagedConfirmedExit already has a signetTxid (G6).
// @ac         docs/APP.md §7 A4 A5 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { synthBech32, synthDigest, synthHex, synthId, synthTxid } from './synthetic';
import type { ExitFixture, LifecycleStage } from './types';

/** docs/APP.md §3.2 — two phases, brutally honest about which leg is slow. */
export const EXIT_PHASES: readonly LifecycleStage[] = [
  {
    index: 1,
    label: 'Exit confirmed on Sui',
    signal: 'shares burned + withdrawal_queue::WithdrawalRequested (one PTB)',
    timeClass: 'sui',
    expected: 'Sui: instant (one checkpoint)',
  },
  {
    index: 2,
    label: 'Broadcasting to Bitcoin…',
    signal:
      'batching → WithdrawalPickedForProcessing → Guardian+MPC → WithdrawalSigned → 6 confs → WithdrawalConfirmed',
    timeClass: 'bitcoin',
    expected: '~1.5-2 h — NEVER live in the demo',
  },
];

/** 32-byte P2TR witness program, pinned at deposit and immutable thereafter. */
const PINNED_P2TR_HEX = synthHex(0x7b, 32);
/** 20-byte P2WPKH witness program. */
const PINNED_P2WPKH_HEX = synthHex(0x2c, 20);

export const exitFixtures: readonly ExitFixture[] = [
  // The one shown confirming in an explorer during judging (G6).
  {
    requestId: synthId(0xe1),
    amountSats: 180_000n,
    burnDigest: synthDigest('burn-e1'),
    pinnedAddressHex: PINNED_P2TR_HEX,
    pinnedAddressBech32: synthBech32('p', 58),
    pinnedAddressKind: 'P2TR',
    phase: 'done',
    signetTxid: synthTxid(0x5e),
  },
  // The one the demo requests LIVE: phase A lands instantly, phase B does not.
  {
    requestId: synthId(0xe2),
    amountSats: 60_000n,
    burnDigest: synthDigest('burn-e2'),
    pinnedAddressHex: PINNED_P2TR_HEX,
    pinnedAddressBech32: synthBech32('p', 58),
    pinnedAddressKind: 'P2TR',
    phase: 'A',
  },
  // Below the 30_000-sat Hashi minimum: POOLED, never submitted (G3).
  {
    requestId: synthId(0xe3),
    amountSats: 12_500n,
    burnDigest: synthDigest('burn-e3'),
    pinnedAddressHex: PINNED_P2WPKH_HEX,
    pinnedAddressBech32: synthBech32('q', 38),
    pinnedAddressKind: 'P2WPKH',
    phase: 'A',
  },
];

/** Shown in the signet explorer during the demo — already confirmed (G6). */
export const prestagedConfirmedExit: ExitFixture = exitFixtures[0]!;
