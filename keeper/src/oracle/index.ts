// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     DONE
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
// @facts      The spot mid is taken from `L2Book.mid`, which `routing/deepbook.ts::readBook`
// @facts        populates via `routing/book.ts::bookMid` and sets to `0n` on an empty book
// @facts        (deepbook.ts invariant 2). Reading the field rather than re-deriving it keeps the
// @facts        journalled `book` and the snapshot from ever disagreeing.
// @facts      ★ COMMON SCALE. Every price in an OracleSnapshot is "USD per 1 BTC carrying
// @facts        cfg.hashi.hbtcDecimals fractional digits". Pyth arrives via `scaleToSats`; the
// @facts        DeepBook side via `deepbookPriceToUsdFixed`. Divergence is a ratio, so it is only
// @facts        meaningful because both sides share this scale.
// @facts      ★ DeepBook v3 price semantics (verified in the pinned dep source,
// @facts        deepbook/math.move + order_info.move): quote_raw = base_raw * price / FLOAT_SCALING
// @facts        with FLOAT_SCALING = 1_000_000_000 (deepbook::constants::float_scaling).
// @implements export interface OracleDeps / OracleReadOptions / OracleTick
// @implements export function deepbookPriceToUsdFixed(cfg: Config, dbPrice: bigint): bigint
// @implements export async function tick(deps: OracleDeps, opts: OracleReadOptions): Promise<OracleTick>
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
import { readBook, type DeepbookDeps, type ReadBookOptions } from '../routing/deepbook.js';
import type { L2Book, Millis, OracleSnapshot } from '../types.js';

import { OracleUnavailableError } from './divergence.js';
import { assertFresh, fetchLatestPrice, scaleToSats, type PythPrice, type PythReadOptions } from './pyth.js';
import { pushSample, twap, type TwapWindow } from './twap.js';

export * from './divergence.js';
export * from './pyth.js';
export * from './twap.js';

/**
 * `deepbook::constants::FLOAT_SCALING = 1_000_000_000` expressed as a base-10 exponent.
 * Verified in the pinned dependency source (`deepbook/math.move`, `deepbook/constants.move`):
 * `math::mul(base_quantity, price) = base_quantity * price / FLOAT_SCALING = quote_quantity`.
 */
export const DEEPBOOK_FLOAT_SCALING_EXP = 9;

export interface OracleDeps {
  readonly cfg: Config;
  /** Transport for the DeepBook side (simulation of `get_level2_range`). */
  readonly deepbook: DeepbookDeps;
  /**
   * Seams. Both default to the real implementations; tests inject deterministic stand-ins so the
   * suite never opens a socket (vitest.config.ts forbids it).
   */
  readonly readBookImpl?: (deps: DeepbookDeps, opts: ReadBookOptions) => Promise<L2Book>;
  readonly fetchPriceImpl?: (cfg: Config, opts?: PythReadOptions) => Promise<PythPrice>;
}

export interface OracleReadOptions {
  /** Logical "now" (ms epoch). Always an argument — replayability (G5). */
  readonly nowMs: Millis;
  /** Rolling mid window carried across ticks by the run loop. */
  readonly window: TwapWindow;
}

/** One tick's full output: the snapshot, the book it came from, and the advanced TWAP window. */
export interface OracleTick {
  readonly snapshot: OracleSnapshot;
  /** The raw L2 snapshot — the heavy journal field (`DecisionRecord.book`). */
  readonly book: L2Book;
  /** The window with this tick's sample appended; the run loop carries it into the next tick. */
  readonly window: TwapWindow;
}

/**
 * Convert a raw DeepBook u64 price into the snapshot's common fixed point (USD per 1 BTC with
 * `cfg.hashi.hbtcDecimals` fractional digits), so it is directly comparable to `scaleToSats`.
 *
 *   quote_raw = base_raw · price / 10^9                                    (deepbook/math.move)
 *   USD/BTC   = (quote_raw / 10^qDec) / (base_raw / 10^bDec)
 *             = price · 10^(bDec − qDec − 9)
 *   fixed(bDec) = USD/BTC · 10^bDec = price · 10^(2·bDec − qDec − 9)
 *
 * With the live pair (hBTC 8 dec, DBUSDC 6 dec) the exponent is +1.
 *
 * ⚠ This is the number NAV is valued at (G9) — never the Pyth price.
 */
export function deepbookPriceToUsdFixed(cfg: Config, dbPrice: bigint): bigint {
  const exp =
    2 * cfg.hashi.hbtcDecimals - cfg.deepbook.dbusdcDecimals - DEEPBOOK_FLOAT_SCALING_EXP;
  if (exp >= 0) return dbPrice * 10n ** BigInt(exp);
  return dbPrice / 10n ** BigInt(-exp);
}

/**
 * One combined reading: Pyth (BETA) + DeepBook TWAP + DeepBook spot mid.
 *
 * Fails closed — a stale Pyth price or an unreadable book throws rather than returning a
 * half-filled snapshot the strategy would then trade on (invariant 2).
 */
export async function tick(deps: OracleDeps, opts: OracleReadOptions): Promise<OracleTick> {
  const { cfg } = deps;
  const fetchPrice = deps.fetchPriceImpl ?? fetchLatestPrice;
  const readTheBook = deps.readBookImpl ?? readBook;

  // 1. Pyth BETA reference. Stale ⇒ StaleOracleError ⇒ the tick becomes a `noop`.
  const price = assertFresh(cfg, await fetchPrice(cfg), opts.nowMs);
  const pythPx = scaleToSats(price, cfg.hashi.hbtcDecimals);
  if (pythPx <= 0n) {
    throw new OracleUnavailableError('pyth-price', `non-positive scaled price ${pythPx}`);
  }

  // 2. DeepBook book by SIMULATION (never the indexer, never `pool::mid_price` — E-K6/R10).
  // `L2Book.mid` is populated by `routing/deepbook.ts::readBook` from `routing/book.ts::bookMid`;
  // its documented empty-book value is `0n` (deepbook.ts invariant 2). We read the field rather
  // than re-deriving it so the journalled `book` and the snapshot can never disagree.
  const book = await readTheBook(deps.deepbook, { atMs: opts.nowMs });
  if (book.mid <= 0n) {
    // The testnet book is empty on both sides (R10). Absence of a mid is NOT the price 0, and it
    // is emphatically not "use Pyth instead" (G9) — we decline to value the vault this tick.
    throw new OracleUnavailableError('deepbook-mid', 'book has no two-sided top of book');
  }
  const deepbookMid = deepbookPriceToUsdFixed(cfg, book.mid);

  // 3. Advance the time-weighted window and derive the divergence reference.
  const window = pushSample(opts.window, { atMs: opts.nowMs, mid: deepbookMid });
  const deepbookTwap = twap(window.samples, window.windowMs, opts.nowMs);
  if (deepbookTwap === undefined || deepbookTwap <= 0n) {
    throw new OracleUnavailableError('deepbook-twap', 'no usable mid sample inside the TWAP window');
  }

  const snapshot: OracleSnapshot = Object.freeze({
    pythPx,
    pythSeq: price.seq,
    pythPublishTimeMs: price.publishTimeMs,
    deepbookTwap,
    // ★ G9: THIS is the NAV/collateral reference. `pythPx` above is only what we diverge from.
    deepbookMid,
  });

  return Object.freeze({ snapshot, book, window });
}

/** Contract-shaped convenience wrapper around {@link tick}. */
export async function read(deps: OracleDeps, opts: OracleReadOptions): Promise<OracleSnapshot> {
  return (await tick(deps, opts)).snapshot;
}
