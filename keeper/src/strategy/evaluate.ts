// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §3.1 (`evaluate(params, snapshot) -> Decision`, PURE), §0 (determinism)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · CUT LINE item 2
// @spec       docs/KEEPER.md §9.1 (verify/ re-runs THIS against the recorded inputs)
// @rules      G3 G4 G5 G8 G9 G10
// @depends    ./params.ts (T2.6) · ./pegflow.ts (T5.1) · ../types.ts · ../util/rng.ts (SEEDED jitter)
// @facts      ★ PURE FUNCTION. Same (params, inputs) ⇒ same Decision, forever, on any machine.
// @facts        That is what makes the whole verifiability thesis work (G5) — `verify/` re-runs it.
// @facts      Inputs (docs/KEEPER.md §3.1): book · mid · pendingMint · pendingBurn · limiter ·
// @facts        idleHBtc · pendingExitDemand.
// @facts      ⚠ `limiter` MUST be the TRUSTLESS REPLAY (verify.deriveLimiter over on-chain
// @facts        WithdrawalSigned), NEVER `adapter.guardian.limiterStatus()` — that is an
// @facts        unverified SDK hint (G5).
// @facts      Valuation reference is the DeepBook MID, never raw Pyth (G9 hBTC-depeg defence).
// @facts      ⚠ E-M7/E-K6: `pool::mid_price` ABORTS on an empty book and the hBTC/DBUSDC book is
// @facts        empty on both sides right now ⇒ a zero/absent mid is a NORMAL state and must
// @facts        produce `noop` + cause='no-mid', never a throw (invariant 1).
// @facts      Decision rules (docs/KEEPER.md §3.1):
// @facts        (a) skew quotes toward absorbing telegraphed flow (pendingMint/pendingBurn);
// @facts        (b) redemption buffer: if deploying would push idle hBTC below
// @facts            f(idleHBtc, pendingExitDemand), downsize or `derisk` with cause='buffer';
// @facts        (c) if the bucket is draining faster than it refills, pre-emptively `derisk`
// @facts            with cause='limiter-tightening' — the replayable "bridge tightening" trace;
// @facts        (d) oracle divergence ⇒ `noop` with cause='oracle-divergence' (G9, oracle/ throws first).
// @facts      ⚠ The divergence MAGNITUDE arrives PRE-COMPUTED from oracle/ (`inputs.oracleDivergenceBps`)
// @facts        and the threshold from config (`ctx.maxOracleDivergenceBps` = cfg.pyth.divergenceBps).
// @facts        evaluate() never rescales Pyth USD against DeepBook price units itself — that
// @facts        normalisation belongs to oracle/ (T2.8) and inventing it here would be a silent bug.
// @facts      ⚠ HONESTY (G8/G3): on live testnet the bucket is 100 BTC refilling ~100 BTC/day —
// @facts        an Aphotic-sized exit will essentially never be rate-limited. The buffer is an
// @facts        honest RISK INPUT and the substrate of the verifiability claim, NOT a scarcity story.
// @facts      TIGHTENING PREDICATE (from the replay ONLY, G5): `limiter.queueDepth > limiter.tokens`
// @facts        — the globally telegraphed outstanding demand exceeds the projected capacity.
// @facts        Both fields come from `verify.deriveLimiter`; no SDK read is involved.
// @facts      Jitter is drawn from createRng(seed) (../util/rng.ts, SplitMix64) and the seed is
// @facts        recorded in Decision.jitterSeed so the replay reproduces it exactly.
// @facts      Alignment: bidPx/askPx tick-aligned (1_000_000), bidSz/askSz lot-aligned (1_000) and
// @facts        >= min_size (100_000) — cfg values arrive via RulesetContext, never literals (G7).
// @facts        Bids round DOWN to tick, asks round UP: quoting rounds INTO the spread, never through it.
// @implements export interface StrategyInputs / RulesetContext
// @implements export function evaluate(params: StrategyParams, inputs: StrategyInputs, ctx: RulesetContext): Decision
// @implements export function rulesetHash(): string
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  any I/O, network call, or adapter read inside evaluate — inputs arrive as arguments
// @forbidden  reading the limiter from the SDK hint instead of the replay (G5)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. PURE + total: evaluate never throws for well-formed inputs; it returns `noop` with a cause.
// @invariant  2. Every returned price is tick-aligned and every NON-ZERO size lot-aligned + >= min_size.
// @invariant  3. `jitterSeed` is echoed into the Decision so the journal makes the draw reproducible.
// @invariant  4. The function NEVER mutates `params` or `inputs`.
// @invariant  5. bidPx < askPx on every `quote`/`requote` — a jittered quote can never cross itself.
// @ac         docs/KEEPER.md §13 A3 — replay reproduces the Decision incl. jitter, 0 mismatches
// @verify     npm run test -- strategy
// @verify     powershell -NoProfile -File scripts/gates.ps1 purity
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type {
  Bps,
  Decision,
  DecisionAction,
  L2Book,
  LimiterSample,
  Millis,
  OracleSnapshot,
  OrderId,
  Sats,
} from '../types.js';
import { createRng } from '../util/rng.js';

import { BPS_DENOMINATOR, type StrategyParams } from './params.js';
import { netFlowSkewBps } from './pegflow.js';

/** The complete decision input set. Every field is a SNAPSHOT — nothing is fetched inside. */
export interface StrategyInputs {
  /** L2 snapshot of Pool<hBTC,DBUSDC> (routing/book.ts). The heavy journal field. */
  readonly book: L2Book;
  /** Pyth (BETA) + DeepBook TWAP + DeepBook mid (oracle/). */
  readonly oracle: OracleSnapshot;
  /** ★ The TRUSTLESS replay sample (verify/limiter.ts) — never the SDK hint (G5). */
  readonly limiter: LimiterSample;
  /** Σ approved-but-unminted deposits — telegraphed supply + (watcher FlowState). */
  readonly pendingMintSats: Sats;
  /** Σ requested-but-unsettled withdrawals — telegraphed supply − (watcher FlowState). */
  readonly pendingBurnSats: Sats;
  /** Vault idle hBTC, sats. */
  readonly idleHBtcSats: Sats;
  /** Pooled + in-flight exit demand against the vault, sats. */
  readonly pendingExitDemandSats: Sats;
  /** Logical tick time (ms epoch). Supplied by the caller so the tick is replayable. */
  readonly tickMs: Millis;
  /** Seed for the bounded jitter draw. Echoed into `Decision.jitterSeed`. */
  readonly jitterSeed: string;
  /** Orders currently resting on the book. */
  readonly restingOrderIds: readonly bigint[];
  /** ms epoch of the previous decision, for the cooldown/hysteresis bands. */
  readonly lastDecisionAtMs?: Millis;
  /**
   * |Pyth − DeepBook TWAP| in bps, ALREADY normalised onto a common scale by `oracle/` (T2.8).
   * Absent ⇒ the breaker is oracle/'s responsibility alone and evaluate does not second-guess it.
   */
  readonly oracleDivergenceBps?: Bps;
}

/** Venue constants + envelope bounds, injected from config (G7 — never literals in logic). */
export interface RulesetContext {
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minSize: Sats;
  /** cfg.hashi.withdrawalMinimumSats — the pooling threshold the buffer rule reasons about. */
  readonly withdrawalMinimumSats: Sats;
  /** cfg.pyth.divergenceBps. Absent ⇒ evaluate's divergence backstop is disabled (G9, rule d). */
  readonly maxOracleDivergenceBps?: Bps;
}

// ── pure helpers (no clock, no entropy) ──────────────────────────────────────

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Largest multiple of `m` that is <= v. Non-negative domain only. */
function floorToMultiple(v: bigint, m: bigint): bigint {
  if (v <= 0n) return 0n;
  if (m <= 1n) return v;
  return (v / m) * m;
}

/** Smallest multiple of `m` that is >= v. Non-negative domain only. */
function ceilToMultiple(v: bigint, m: bigint): bigint {
  if (v <= 0n) return 0n;
  if (m <= 1n) return v;
  return ((v + m - 1n) / m) * m;
}

function satSubFloor(a: Sats, b: Sats): Sats {
  return a > b ? a - b : 0n;
}

function minSats(a: Sats, b: Sats): Sats {
  return a < b ? a : b;
}

/** Every `noop`/`derisk` exit shares this shape so the journal schema is uniform. */
function halt(
  action: Extract<DecisionAction, 'noop' | 'derisk'>,
  cause: string,
  jitterSeed: string,
  cancels: readonly OrderId[],
): Decision {
  return {
    action,
    bidPx: 0n,
    askPx: 0n,
    bidSz: 0n,
    askSz: 0n,
    cancels,
    cause,
    jitterSeed,
  };
}

/**
 * The decision function. PURE, deterministic, total.
 *
 * `verify/replay.ts` re-runs exactly this against each journaled record's recorded inputs; any
 * divergence is a reported mismatch, so a wall-clock read here would break the product claim.
 */
export function evaluate(
  params: StrategyParams,
  inputs: StrategyInputs,
  ctx: RulesetContext,
): Decision {
  const seed = inputs.jitterSeed;
  // Never mutate `inputs` (invariant 4) — the copy is what we hand to the Decision.
  const resting: readonly OrderId[] = [...inputs.restingOrderIds];

  // ── (d) oracle divergence — G9. oracle/ throws first; this is the in-band backstop. ────────
  const measuredDivergence = inputs.oracleDivergenceBps;
  const maxDivergence = ctx.maxOracleDivergenceBps;
  if (
    measuredDivergence !== undefined &&
    maxDivergence !== undefined &&
    Number.isFinite(measuredDivergence) &&
    Math.abs(measuredDivergence) > maxDivergence
  ) {
    // Pull resting quotes: leaving them up while the reference price is untrusted is the one
    // way an "inaction" can still lose money.
    return halt('noop', 'oracle-divergence', seed, resting);
  }

  // ── requote cooldown — the encrypted band that stops us churning the book ───────────────────
  if (
    inputs.lastDecisionAtMs !== undefined &&
    Number.isFinite(inputs.lastDecisionAtMs) &&
    inputs.tickMs - inputs.lastDecisionAtMs < params.cooldownMs
  ) {
    // A cooldown is genuinely "do nothing": resting orders stay exactly where they are.
    return halt('noop', 'cooldown', seed, []);
  }

  // ── valuation reference: the DeepBook MID, never raw Pyth (G9) ──────────────────────────────
  const mid = inputs.oracle.deepbookMid > 0n ? inputs.oracle.deepbookMid : inputs.book.mid;
  if (mid <= 0n) {
    // E-M7: the book is empty on both sides today; `get_level2_range` returns ([], []). That is
    // a defined empty state, not an error.
    return halt('noop', 'no-mid', seed, resting);
  }

  // ── (c) limiter tightening, from the TRUSTLESS replay only (G5) ─────────────────────────────
  const tightening = inputs.limiter.queueDepth > inputs.limiter.tokens;

  // Hard pre-emption: the globally projected capacity no longer covers our own telegraphed exit
  // demand. G3 — over-capacity batches are REJECTED, never queued, so the only lever we have is
  // to stop deploying and let the buffer rebuild.
  if (tightening && inputs.limiter.tokens < inputs.pendingExitDemandSats) {
    return halt('derisk', 'limiter-tightening', seed, resting);
  }

  // ── (b) redemption buffer ───────────────────────────────────────────────────────────────────
  // Tightening doubles the buffer target before anything is deployed: that widening is exactly
  // the "we de-risked because the bridge tightened" trace `verify/` replays.
  const effectiveBufferBps = tightening
    ? Math.min(params.bufferTargetBps * 2, BPS_DENOMINATOR)
    : params.bufferTargetBps;

  // Small exits below the Hashi minimum (30_000 sats) cannot leave individually — they pool.
  // Reserve at least one minimum-sized exit whenever any demand is outstanding, so the pool can
  // always be flushed (docs/RECON.md R7 `EBelowMinimumWithdrawal`).
  const pooledFloor =
    inputs.pendingExitDemandSats > 0n && inputs.pendingExitDemandSats < ctx.withdrawalMinimumSats
      ? ctx.withdrawalMinimumSats
      : inputs.pendingExitDemandSats;

  const bufferSats =
    pooledFloor + (inputs.idleHBtcSats * BigInt(effectiveBufferBps)) / BigInt(BPS_DENOMINATOR);

  const deployableSats = minSats(
    satSubFloor(inputs.idleHBtcSats, bufferSats),
    params.maxNotionalPerEpochSats,
  );

  const perSide = floorToMultiple(deployableSats / 2n, ctx.lotSize);
  if (perSide < ctx.minSize) {
    // Downsizing would produce an illegal order; pull instead of quoting a size the venue rejects.
    return halt('derisk', tightening ? 'limiter-tightening' : 'buffer', seed, resting);
  }

  // ── (a) skew toward absorbing telegraphed flow (peg-flow signal, T5.1) ──────────────────────
  const netFlowSats = inputs.pendingMintSats - inputs.pendingBurnSats;
  const flowSkew = netFlowSkewBps(netFlowSats, params);
  let skewBps = clampInt(params.skewBps + flowSkew, -params.spreadBps, params.spreadBps);
  // Hysteresis dead-band: a sub-threshold lean is noise, and requoting on noise leaks intent.
  if (Math.abs(skewBps) < params.hysteresisBps) skewBps = 0;
  skewBps = clampInt(skewBps, -(BPS_DENOMINATOR - 1), BPS_DENOMINATOR - 1);

  // Positive skew shifts the CENTRE DOWN ⇒ leans toward selling hBTC (see params.skewBps).
  const centre = (mid * BigInt(BPS_DENOMINATOR - skewBps)) / BigInt(BPS_DENOMINATOR);
  if (centre <= 0n) return halt('noop', 'degenerate-price', seed, resting);

  // ── bounded jitter from the SEEDED PRNG; the seed is journaled (invariant 3) ────────────────
  const rng = createRng(seed);
  const span = params.jitterBps > 0 ? BigInt(params.jitterBps * 2 + 1) : 0n;
  const drawJitter = (): number =>
    span === 0n ? 0 : Number(rng.nextBelow(span)) - params.jitterBps;

  const bidHalfBps = clampInt(params.spreadBps + drawJitter(), 1, BPS_DENOMINATOR - 1);
  const askHalfBps = clampInt(params.spreadBps + drawJitter(), 1, BPS_DENOMINATOR - 1);

  // Round INTO the spread: bid down to tick, ask up to tick — never through the mid.
  const bidPx = floorToMultiple(
    (centre * BigInt(BPS_DENOMINATOR - bidHalfBps)) / BigInt(BPS_DENOMINATOR),
    ctx.tickSize,
  );
  let askPx = ceilToMultiple(
    (centre * BigInt(BPS_DENOMINATOR + askHalfBps)) / BigInt(BPS_DENOMINATOR),
    ctx.tickSize,
  );

  if (bidPx < ctx.tickSize) {
    // The mid is below one tick — nothing legal can be quoted around it.
    return halt('noop', 'degenerate-price', seed, resting);
  }
  if (askPx <= bidPx) askPx = bidPx + ctx.tickSize; // invariant 5

  return {
    action: resting.length > 0 ? 'requote' : 'quote',
    bidPx,
    askPx,
    bidSz: perSide,
    askSz: perSide,
    cancels: resting,
    jitterSeed: seed,
  };
}

/**
 * Content hash of the compiled decision function — journaled as `DecisionRecord.ruleset` so a
 * verifier can prove WHICH rule set produced a decision without seeing the parameters (G8).
 *
 * The digest covers `evaluate` AND every pure helper it delegates to, so changing a rounding
 * rule or the tightening predicate changes the hash even though `evaluate`'s own text did not.
 */
const RULESET_ID = 'aphotic.strategy.evaluate/v1';

export function rulesetHash(): string {
  const hash = createHash('sha256');
  hash.update(RULESET_ID);
  for (const fn of [
    evaluate,
    halt,
    clampInt,
    floorToMultiple,
    ceilToMultiple,
    satSubFloor,
    minSats,
    netFlowSkewBps,
  ]) {
    hash.update('\n');
    hash.update(fn.toString());
  }
  return hash.digest('hex');
}
