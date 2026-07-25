// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.1, T2.6
// @phase      5  (stretch — post-cut-line; the input plumbing lands with T2.6)
// @status     STUB
// @spec       docs/BUILD-PLAN.md#phase-5 (T5.1 peg-flow signal)
// @spec       docs/KEEPER.md §3.1 (pendingMint/pendingBurn as strategy inputs)
// @spec       docs/FACTS.md#events (flow-signal note) · HASHI_INTEGRATION.md §3 mechanism #3
// @rules      G1 G3 G5 G8
// @depends    ../hashi/watcher.ts (T2.2) · ../types.ts · ./params.ts (T2.6)
// @facts      ★ THE SIGNAL IS PUBLIC; THE RESPONSE IS PRIVATE (G8). Anyone can read Hashi's events;
// @facts        what Aphotic DOES with them stays Seal-encrypted. Never pitch the signal as secret.
// @facts      Why it is a signal at all (docs/FACTS.md#events):
// @facts        `DepositApproved` precedes the mint by ~10 min (bitcoin_deposit_time_delay_ms
// @facts        = 600_000) ⇒ hBTC supply + is telegraphed BEFORE it can hit the book.
// @facts        `WithdrawalRequested` precedes the burn ⇒ supply − is telegraphed likewise.
// @facts      G1: the latency that makes this a lead indicator lives ONLY at the mint/burn
// @facts        boundary. On-Sui movement is instant — never claim BTC latency gates the book.
// @facts      G3: limiter tightening is a RISK input. Over-capacity batches are rejected, not
// @facts        queued, and priority cannot be bought. On testnet the bucket is 100 BTC refilling
// @facts        ~100 BTC/day ⇒ do NOT oversell congestion (docs/FACTS.md#guardian-limiter).
// @facts      Tightening is measured from the TRUSTLESS trajectory (verify/limiter.ts), i.e. the
// @facts        bucket draining faster than `refillRate` over the window — not from an SDK read (G5).
// @implements export interface PegFlowSignal / PegFlowWindow
// @implements export function pegFlow(events: readonly HashiEvent[], limiter: readonly LimiterSample[], window: PegFlowWindow): PegFlowSignal
// @implements export function flowSkewBps(signal: PegFlowSignal, params: StrategyParams): Bps
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  claiming the signal is proprietary or privileged (G8)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. PURE: `window.nowMs` is an argument; nothing is read from a clock.
// @invariant  2. `netFlowSats = pendingMintSats - pendingBurnSats` (may be negative — bigint, signed).
// @invariant  3. `tightening` is derived ONLY from the replayed trajectory (G5).
// @invariant  4. An empty event window yields a zeroed signal, never a throw.
// @ac         docs/BUILD-PLAN.md T5.1 — strategy consumes pending mint/burn + limiter status
// @verify     npm run test -- strategy.pegflow
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { HashiEvent } from '../hashi/types.js';
import type { Bps, LimiterSample, Millis, Sats } from '../types.js';

import type { StrategyParams } from './params.js';

export interface PegFlowWindow {
  /** Logical "now" (ms epoch). An argument, never a clock read — invariant 1. */
  readonly nowMs: Millis;
  /** Lookback for the flow aggregation, ms. */
  readonly lookbackMs: Millis;
}

export interface PegFlowSignal {
  /** Σ telegraphed inbound supply in the window (DepositApproved not yet minted). */
  readonly pendingMintSats: Sats;
  /** Σ telegraphed outbound supply in the window (WithdrawalRequested not yet settled). */
  readonly pendingBurnSats: Sats;
  /** pendingMint − pendingBurn. Signed. */
  readonly netFlowSats: Sats;
  /** Bucket occupancy at the end of the window, bps of `maxBucketCapacity`. */
  readonly limiterUtilisationBps: Bps;
  /** True when the replayed bucket drained faster than it refilled across the window (G5). */
  readonly tightening: boolean;
  /** End of the window (ms epoch) — the sample this signal describes. */
  readonly atMs: Millis;
}

/**
 * Aggregate the public peg-flow signal. PURE.
 *
 * `limiter` is the trajectory produced by `verify.deriveLimiter` over the on-chain
 * `WithdrawalSigned` stream — the trustless replay, not an SDK reading (G5).
 */
// TODO(T5.1): fold DepositApproved/Confirmed + WithdrawalRequested/Signed/Confirmed/Cancelled over
//             the lookback; compute utilisation + tightening from the trajectory slope.
export function pegFlow(
  _events: readonly HashiEvent[],
  _limiter: readonly LimiterSample[],
  _window: PegFlowWindow,
): PegFlowSignal {
  throw new Error('TODO(T5.1): pegFlow not implemented');
}

/**
 * Convert the signal into a quote skew, scaled by the encrypted `flowSensitivityBps`.
 * The SIGNAL is public; this RESPONSE is the private part (G8).
 */
// TODO(T5.1): skew = clamp(netFlowSats scaled by params.flowSensitivityBps, ±params.spreadBps).
export function flowSkewBps(_signal: PegFlowSignal, _params: StrategyParams): Bps {
  throw new Error('TODO(T5.1): flowSkewBps not implemented');
}
