// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.1, T2.6
// @phase      5  (stretch — post-cut-line; the input plumbing lands with T2.6)
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-5 (T5.1 peg-flow signal)
// @spec       docs/KEEPER.md §3.1 (pendingMint/pendingBurn as strategy inputs)
// @spec       docs/FACTS.md#events (flow-signal note) · HASHI_INTEGRATION.md §3 mechanism #3
// @rules      G1 G3 G5 G8
// @depends    ../hashi/watcher.ts (T2.2) · ../hashi/types.ts · ../types.ts · ./params.ts (T2.6)
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
// @facts      SETTLEMENT JOIN (docs/RECON.md R8 event field reality):
// @facts        pendingMint = Σ DepositApproved.sats over requestIds NOT yet DepositConfirmed
// @facts                      and NOT ExpiredDepositDeleted.
// @facts        pendingBurn = Σ WithdrawalRequested.sats over requestIds NOT yet
// @facts                      WithdrawalSigned / WithdrawalConfirmed / WithdrawalCancelled.
// @facts        ⚠ WithdrawalConfirmed carries `requestIds` but NO amount ⇒ settlement must be
// @facts        matched by REQUEST ID, never by summing amounts off the settle-side events.
// @facts      SATS_PER_BTC = 100_000_000 (hBTC has 8 decimals, docs/FACTS.md#hbtc) — a unit, not an id.
// @implements export const SATS_PER_BTC: bigint
// @implements export interface PegFlowSignal / PegFlowWindow
// @implements export function pegFlow(events, limiter, window, limiterCfg?): PegFlowSignal
// @implements export function netFlowSkewBps(netFlowSats: Sats, params: StrategyParams): Bps
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

import type { LimiterConfig } from '../config.js';
import type { HashiEvent } from '../hashi/types.js';
import type { Bps, LimiterSample, Millis, Sats } from '../types.js';

import { BPS_DENOMINATOR, type StrategyParams } from './params.js';

/** 1 BTC in satoshis. hBTC has 8 decimals (docs/FACTS.md#hbtc). A UNIT, not a canonical id. */
export const SATS_PER_BTC = 100_000_000n;

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

/** The zeroed signal an empty window yields (invariant 4). */
function emptySignal(atMs: Millis): PegFlowSignal {
  return {
    pendingMintSats: 0n,
    pendingBurnSats: 0n,
    netFlowSats: 0n,
    limiterUtilisationBps: 0,
    tightening: false,
    atMs,
  };
}

function sumUnsettled(open: ReadonlyMap<string, Sats>, settled: ReadonlySet<string>): Sats {
  let total = 0n;
  for (const [requestId, sats] of open) {
    if (!settled.has(requestId)) total += sats;
  }
  return total;
}

/**
 * Aggregate the public peg-flow signal. PURE.
 *
 * `limiter` is the trajectory produced by `verify.deriveLimiter` over the on-chain
 * `WithdrawalSigned` stream — the trustless replay, not an SDK reading (G5).
 *
 * `limiterCfg` is OPTIONAL: when the two genesis scalars are known (the only trust anchors of
 * the G5 replay) utilisation is measured against `maxBucketCapacitySats`; otherwise it falls
 * back to the largest token balance actually observed in the trajectory, which is an
 * OBSERVATIONAL LOWER BOUND on the cap — honest, and never a trusted SDK read.
 */
export function pegFlow(
  events: readonly HashiEvent[],
  limiter: readonly LimiterSample[],
  window: PegFlowWindow,
  limiterCfg?: LimiterConfig,
): PegFlowSignal {
  const nowMs = window.nowMs;
  const lookbackMs = window.lookbackMs > 0 ? window.lookbackMs : 0;
  const fromMs = nowMs - lookbackMs;

  if (events.length === 0 && limiter.length === 0) return emptySignal(nowMs);

  // ── Flow: telegraphed-but-unsettled, matched BY REQUEST ID (see the @facts join) ──
  const openMints = new Map<string, Sats>();
  const settledMints = new Set<string>();
  const openBurns = new Map<string, Sats>();
  const settledBurns = new Set<string>();

  for (const e of events) {
    if (e.atMs < fromMs || e.atMs > nowMs) continue;
    switch (e.kind) {
      case 'DepositApproved':
        // `DepositApproved` precedes the mint by ~600_000 ms — this is the whole lead indicator.
        openMints.set(e.requestId, e.sats);
        break;
      case 'DepositConfirmed':
      case 'ExpiredDepositDeleted':
        settledMints.add(e.requestId);
        break;
      case 'WithdrawalRequested':
        openBurns.set(e.requestId, e.sats);
        break;
      case 'WithdrawalCancelled':
        settledBurns.add(e.requestId);
        break;
      case 'WithdrawalSigned':
      case 'WithdrawalConfirmed':
        for (const requestId of e.requestIds) settledBurns.add(requestId);
        break;
      default:
        // Every other kind (Minted/Burned/DepositRequested/Approved/Picked/InputsSigned/
        // PresigsReassigned) carries no settlement information for this signal.
        break;
    }
  }

  const pendingMintSats = sumUnsettled(openMints, settledMints);
  const pendingBurnSats = sumUnsettled(openBurns, settledBurns);

  // ── Limiter: occupancy + tightening, from the REPLAYED trajectory only (G5, invariant 3) ──
  const upTo = [...limiter].filter((s) => s.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs);
  const inWindow = upTo.filter((s) => s.atMs >= fromMs);

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1] ?? upTo[upTo.length - 1];

  // "Drained faster than it refilled" == the bucket NET FELL across the window: the projection
  // already added every token the refill rate could produce, so a net fall is exactly that.
  const tightening = first !== undefined && last !== undefined && last.tokens < first.tokens;

  let capSats = limiterCfg?.maxBucketCapacitySats ?? 0n;
  if (capSats <= 0n) {
    for (const s of upTo) if (s.tokens > capSats) capSats = s.tokens;
  }

  let limiterUtilisationBps = 0;
  if (last !== undefined && capSats > 0n) {
    const raw = (last.tokens * BigInt(BPS_DENOMINATOR)) / capSats;
    limiterUtilisationBps = Number(raw > BigInt(BPS_DENOMINATOR) ? BigInt(BPS_DENOMINATOR) : raw);
  }

  return {
    pendingMintSats,
    pendingBurnSats,
    netFlowSats: pendingMintSats - pendingBurnSats,
    limiterUtilisationBps,
    tightening,
    atMs: last?.atMs ?? nowMs,
  };
}

/**
 * The private RESPONSE to the public signal (G8), shared by {@link flowSkewBps} and
 * `evaluate()` so the journal and the replay cannot drift.
 *
 * `flowSensitivityBps` is bps PER BTC of telegraphed net flow; the result is clamped to
 * ±`spreadBps` so peg-flow can lean the quote but never invert it.
 *
 * Sign convention: telegraphed net MINT (+supply arriving) ⇒ POSITIVE skew ⇒ `evaluate()`
 * shifts the quote centre DOWN, i.e. leans toward selling hBTC / bidding lower — absorbing
 * the flow rather than being run over by it.
 */
export function netFlowSkewBps(netFlowSats: Sats, params: StrategyParams): Bps {
  const sensitivity = BigInt(Math.trunc(params.flowSensitivityBps));
  // bigint division truncates toward zero — deterministic for both signs.
  const raw = (netFlowSats * sensitivity) / SATS_PER_BTC;
  const cap = BigInt(Math.abs(Math.trunc(params.spreadBps)));
  const clamped = raw > cap ? cap : raw < -cap ? -cap : raw;
  return Number(clamped);
}

/**
 * Convert the signal into a quote skew, scaled by the encrypted `flowSensitivityBps`.
 * The SIGNAL is public; this RESPONSE is the private part (G8).
 */
export function flowSkewBps(signal: PegFlowSignal, params: StrategyParams): Bps {
  return netFlowSkewBps(signal.netFlowSats, params);
}
