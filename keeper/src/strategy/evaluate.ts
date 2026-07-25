// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §3.1 (`evaluate(params, snapshot) -> Decision`, PURE), §0 (determinism)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · CUT LINE item 2
// @spec       docs/KEEPER.md §9.1 (verify/ re-runs THIS against the recorded inputs)
// @rules      G3 G4 G5 G8 G9 G10
// @depends    ./params.ts (T2.6) · ../types.ts · ../util/rng.ts (SEEDED jitter) · ../verify/limiter.ts (T4.3)
// @facts      ★ PURE FUNCTION. Same (params, inputs) ⇒ same Decision, forever, on any machine.
// @facts        That is what makes the whole verifiability thesis work (G5) — `verify/` re-runs it.
// @facts      Inputs (docs/KEEPER.md §3.1): book · mid · pendingMint · pendingBurn · limiter ·
// @facts        idleHBtc · pendingExitDemand.
// @facts      ⚠ `limiter` MUST be the TRUSTLESS REPLAY (verify.deriveLimiter over on-chain
// @facts        WithdrawalSigned), NEVER `adapter.guardian.limiterStatus()` — that is an
// @facts        unverified SDK hint (G5).
// @facts      Valuation reference is the DeepBook MID, never raw Pyth (G9 hBTC-depeg defence).
// @facts      Decision rules (docs/KEEPER.md §3.1):
// @facts        (a) skew quotes toward absorbing telegraphed flow (pendingMint/pendingBurn);
// @facts        (b) redemption buffer: if deploying would push idle hBTC below
// @facts            f(idleHBtc, pendingExitDemand), downsize or `derisk` with cause='buffer';
// @facts        (c) if the bucket is draining faster than it refills, pre-emptively `derisk`
// @facts            with cause='limiter-tightening' — the replayable "bridge tightening" trace;
// @facts        (d) oracle divergence ⇒ `noop` with cause='oracle-divergence' (G9, oracle/ throws first).
// @facts      ⚠ HONESTY (G8/G3): on live testnet the bucket is 100 BTC refilling ~100 BTC/day —
// @facts        an Aphotic-sized exit will essentially never be rate-limited. The buffer is an
// @facts        honest RISK INPUT and the substrate of the verifiability claim, NOT a scarcity story.
// @facts      Jitter is drawn from createRng(seed) (../util/rng.ts, SplitMix64) and the seed is
// @facts        recorded in Decision.jitterSeed so the replay reproduces it exactly.
// @facts      Alignment: bidPx/askPx tick-aligned (1_000_000), bidSz/askSz lot-aligned (1_000) and
// @facts        >= min_size (100_000) — cfg values arrive via RulesetContext, never literals (G7).
// @implements export interface StrategyInputs / RulesetContext
// @implements export function evaluate(params: StrategyParams, inputs: StrategyInputs, ctx: RulesetContext): Decision
// @implements export function rulesetHash(): string
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  any I/O, network call, or adapter read inside evaluate — inputs arrive as arguments
// @forbidden  reading the limiter from the SDK hint instead of the replay (G5)
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. PURE + total: evaluate never throws for well-formed inputs; it returns `noop` with a cause.
// @invariant  2. Every returned price is tick-aligned and every size lot-aligned + >= min_size.
// @invariant  3. `jitterSeed` is echoed into the Decision so the journal makes the draw reproducible.
// @invariant  4. The function NEVER mutates `params` or `inputs`.
// @ac         docs/KEEPER.md §13 A3 — replay reproduces the Decision incl. jitter, 0 mismatches
// @verify     npm run test -- strategy
// @verify     powershell -NoProfile -File scripts/gates.ps1 purity
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Decision, L2Book, LimiterSample, Millis, OracleSnapshot, Sats } from '../types.js';

import type { StrategyParams } from './params.js';

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
}

/** Venue constants + envelope bounds, injected from config (G7 — never literals in logic). */
export interface RulesetContext {
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minSize: Sats;
  /** cfg.hashi.withdrawalMinimumSats — the pooling threshold the buffer rule reasons about. */
  readonly withdrawalMinimumSats: Sats;
}

/**
 * The decision function. PURE, deterministic, total.
 *
 * `verify/replay.ts` re-runs exactly this against each journaled record's recorded inputs; any
 * divergence is a reported mismatch, so a wall-clock read here would break the product claim.
 */
// TODO(T2.6): implement rules (a)-(d); align prices to tick and sizes to lot/min_size;
//             draw jitter from createRng(inputs.jitterSeed); return `noop` + cause on every guard.
export function evaluate(
  _params: StrategyParams,
  _inputs: StrategyInputs,
  _ctx: RulesetContext,
): Decision {
  throw new Error('TODO(T2.6): evaluate not implemented');
}

/**
 * Content hash of the compiled decision function — journaled as `DecisionRecord.ruleset` so a
 * verifier can prove WHICH rule set produced a decision without seeing the parameters (G8).
 */
// TODO(T2.6): hash the module source/build artifact; must change whenever the rules change.
export function rulesetHash(): string {
  throw new Error('TODO(T2.6): rulesetHash not implemented');
}
