// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §6 (`read() -> OracleSnapshot`), §1.2 (the run-loop tick)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.8) · docs/FACTS.md#pyth-oracle
// @rules      G4 G7 G9
// @depends    ./pyth.ts (T2.8) · ./twap.ts (T2.8) · ./divergence.ts (T2.8) · ../routing/deepbook.ts (T2.7)
// @facts      OracleSnapshot (../types.ts) = { pythPx, pythSeq, pythPublishTimeMs, deepbookTwap, deepbookMid }.
// @facts      ★ `deepbookMid` is the VALUATION reference for NAV/collateral (G9). `pythPx` is only
// @facts        the divergence reference. Never swap those roles.
// @facts      Order of operations in one tick (docs/KEEPER.md §1.2):
// @facts        read() → assertNoDivergence() → (throws ⇒ evaluate returns noop 'oracle-divergence').
// @facts      Both prices land in the journal so the breaker decision is publicly reproducible (G5).
// @facts      ⚠ Empty book (docs/RECON.md R10) ⇒ `deepbookMid`/`deepbookTwap` may be unavailable;
// @facts        `read` fails closed rather than substituting the Pyth price.
// @implements export interface OracleDeps / OracleReadOptions
// @implements export async function read(deps: OracleDeps, opts: OracleReadOptions): Promise<OracleSnapshot>
// @implements export * from './divergence.js' | './pyth.js' | './twap.js'
// @forbidden  valuing NAV at the Pyth price (G9)
// @forbidden  a hardcoded feed id / endpoint — config only (G7, gates.ps1 ids)
// @invariant  1. `nowMs` is an argument; nothing in oracle/ reads a clock.
// @invariant  2. `read` never returns a partially-filled snapshot — it throws instead.
// @ac         docs/KEEPER.md §13 A7
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { DeepbookDeps } from '../routing/deepbook.js';
import type { Millis, OracleSnapshot } from '../types.js';

import type { TwapWindow } from './twap.js';

export * from './divergence.js';
export * from './pyth.js';
export * from './twap.js';

export interface OracleDeps {
  readonly cfg: Config;
  /** Transport for the DeepBook side (simulation of `get_level2_range`). */
  readonly deepbook: DeepbookDeps;
}

export interface OracleReadOptions {
  /** Logical "now" (ms epoch). Always an argument — replayability (G5). */
  readonly nowMs: Millis;
  /** Rolling mid window carried across ticks by the run loop. */
  readonly window: TwapWindow;
}

/**
 * One combined reading: Pyth (BETA) + DeepBook TWAP + DeepBook spot mid.
 *
 * Fails closed — a stale Pyth price or an unreadable book throws rather than returning a
 * half-filled snapshot the strategy would then trade on.
 */
// TODO(T2.8): fetchLatestPrice + assertFresh; readBook → bookMid → pushSample → twap;
//             assemble OracleSnapshot with deepbookMid as the VALUATION reference (G9).
export async function read(
  _deps: OracleDeps,
  _opts: OracleReadOptions,
): Promise<OracleSnapshot> {
  throw new Error('TODO(T2.8): read not implemented');
}
