// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.oracle
// @phase      1
// @status     DONE
// @spec       aphotic.md §7.7 (NAV leg table — the reference price is the DeepBook mid)
// @spec       aphotic.md §10 NAV ("approve_nav reverts if the clearing price deviates from the
//             DeepBook mid beyond the governed bound")
// @spec       docs/DESIGN-V2.md §6 step 4 (divergence_bps(clearing_price, book_mid))
// @rules      G4 G7 G9
// @depends    ../types.ts (L2Book/L2Level) · ../config.ts (venue params)
// @facts      ★ PURE MODULE. Book arithmetic only — transport lives in ./deepbook.ts.
// @facts      ★ Moved here from the deleted `routing/` tree (the v1 market-making thesis). The
// @facts        maker/IOC quoting helpers (alignPrice / alignSize / isAligned) went with it:
// @facts        v2 places no orders, so a tick-alignment rule that "rounds into the spread"
// @facts        would be dead code pretending to be an invariant.
// @facts      ★ THE MID IS THE ONLY REFERENCE PRICE `approve_nav` compares against (G9). NAV is
// @facts        never valued at raw Pyth BTC/USD — hBTC can trade below BTC on this thin book.
// @facts      ⚠ The mid is derived from the DECODED top of book, never from `pool::mid_price`
// @facts        (that ABORTS `EEmptyOrderbook`, deepbook::book code 2, on an empty book).
// @facts      ⚠ BOOK REALITY (docs/RECON.md R10): both sides of the testnet hBTC/DBUSDC book are
// @facts        EMPTY. `bookMid` therefore has NOTHING to return — it yields `undefined`, and the
// @facts        caller treats "no book" as a defined state, never as the price 0.
// @implements export interface VenueParams / TopOfBook
// @implements export const BPS_DENOMINATOR: bigint
// @implements export function venueParams(cfg: Config): VenueParams
// @implements export function topOfBook(book: L2Book): TopOfBook
// @implements export function bookMid(book: L2Book): bigint | undefined
// @implements export function isCrossed(book: L2Book): boolean
// @implements export function depthWithinBps(book: L2Book, side: Side, bps: Bps): Sats
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`)
// @forbidden  any network/transport call here — ./deepbook.ts owns reads
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. Every function is PURE and total; an empty book never throws.
// @invariant  2. bookMid returns `undefined` (not 0n) when a side is missing — absence is not a price.
// @invariant  3. Zero-size levels are ignored: a level with no size is not a price.
// @ac         test/oracle.test.ts — top of book, empty/one-sided book, mid, depth
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Bps, L2Book, L2Level, Sats, Side } from '../types.js';

/** Basis-point denominator. Named so no bare `10_000n` appears in the arithmetic. */
export const BPS_DENOMINATOR = 10_000n;

/** Venue constants, injected from config so no literal appears in logic (G7). */
export interface VenueParams {
  readonly tickSize: bigint;
  readonly lotSize: Sats;
  readonly minSize: Sats;
}

export interface TopOfBook {
  readonly bestBid?: bigint;
  readonly bestAsk?: bigint;
  readonly bidSize?: Sats;
  readonly askSize?: Sats;
}

/** Lift the venue constants out of `Config`. */
export function venueParams(cfg: Config): VenueParams {
  return {
    tickSize: cfg.deepbook.tickSize,
    lotSize: cfg.deepbook.lotSize,
    minSize: cfg.deepbook.minSize,
  };
}

/**
 * Best bid/ask from a decoded snapshot. Either side may be absent (empty book).
 *
 * `get_level2_range` returns bids DESCENDING and asks ASCENDING, but this function does not
 * assume it: it scans for the extremum so a mis-ordered or hand-built fixture still decodes
 * correctly. Zero-quantity levels are ignored — a level with no size is not a price.
 */
export function topOfBook(book: L2Book): TopOfBook {
  let bestBid: bigint | undefined;
  let bidSize: Sats | undefined;
  for (const level of book.bids) {
    if (level.sz <= 0n) continue;
    if (bestBid === undefined || level.px > bestBid) {
      bestBid = level.px;
      bidSize = level.sz;
    }
  }

  let bestAsk: bigint | undefined;
  let askSize: Sats | undefined;
  for (const level of book.asks) {
    if (level.sz <= 0n) continue;
    if (bestAsk === undefined || level.px < bestAsk) {
      bestAsk = level.px;
      askSize = level.sz;
    }
  }

  return { bestBid, bestAsk, bidSize, askSize };
}

/**
 * (bestBid + bestAsk) / 2 — the reference `approve_nav` checks the clearing price against (G9).
 * Returns `undefined` on an empty or one-sided book: absence of a price is not the price 0.
 */
export function bookMid(book: L2Book): bigint | undefined {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid === undefined || bestAsk === undefined) return undefined;
  return (bestBid + bestAsk) / 2n;
}

/**
 * A crossed book (best bid >= best ask) is transient and pathological, but it IS representable
 * in a decoded snapshot taken between matching-engine states. The mid stays defined; the caller
 * decides whether to trust it as a valuation reference.
 */
export function isCrossed(book: L2Book): boolean {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid === undefined || bestAsk === undefined) return false;
  return bestBid >= bestAsk;
}

/**
 * Resting size within `bps` of the mid on one side — a liquidity reading for the NAV
 * price-deviation bound (how much book the mid is actually standing on).
 *
 * Zero when the book has no mid (invariant 2): with nothing to measure against, the honest
 * answer is "no measurable passive depth".
 */
export function depthWithinBps(book: L2Book, side: Side, bps: Bps): Sats {
  const mid = bookMid(book);
  if (mid === undefined) return 0n;
  if (!Number.isFinite(bps) || bps < 0) return 0n;

  const band = (mid * BigInt(Math.trunc(bps))) / BPS_DENOMINATOR;
  const levels: readonly L2Level[] = side === 'bid' ? book.bids : book.asks;
  const bound = side === 'bid' ? mid - band : mid + band;

  let total = 0n;
  for (const level of levels) {
    if (level.sz <= 0n) continue;
    const inBand = side === 'bid' ? level.px >= bound : level.px <= bound;
    if (inBand) total += level.sz;
  }
  return total;
}
