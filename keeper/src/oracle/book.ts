// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §4 (L2Book shape, tick/lot alignment), §6 (mid is the NAV reference)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7) · docs/FACTS.md#deepbook-venue
// @rules      G4 G7 G9
// @depends    ../types.ts (L2Book/L2Level) · ../config.ts (venue params)
// @facts      ★ PURE MODULE. Book arithmetic only — no transport (that is ./deepbook.ts).
// @facts      Venue constants arrive from config (G7): tick 1_000_000 · lot 1_000 · min_size 100_000.
// @facts      ★ THE MID IS THE NAV/COLLATERAL REFERENCE (G9 hBTC-depeg defence). NAV is NEVER
// @facts        valued at raw Pyth BTC/USD — hBTC can trade below BTC on this thin book.
// @facts      ⚠ The mid is derived from the DECODED top of book, never from `pool::mid_price`
// @facts        (it ABORTS `EEmptyOrderbook` on an empty book — docs/FACTS.md E-K6).
// @facts      ⚠ BOOK REALITY (docs/RECON.md R10): both sides of the testnet book are EMPTY and
// @facts        volume is zero. `bookMid` on an empty/one-sided book has NOTHING to return —
// @facts        it yields `undefined`, and the caller applies the documented fallback policy.
// @facts        The scripted taker/maker seeder (./taker.ts) is therefore NOT optional: NAV
// @facts        depends on it.
// @facts      Rounding rule: quotes round INTO the spread (bids down, asks up) so a POST_ONLY
// @facts        maker can never cross and abort `EPOSTOrderCrossesOrderbook`.
// @implements export interface VenueParams / TopOfBook
// @implements export function venueParams(cfg: Config): VenueParams
// @implements export function topOfBook(book: L2Book): TopOfBook
// @implements export function bookMid(book: L2Book): bigint | undefined
// @implements export function alignPrice(px: bigint, tick: bigint, side: Side): bigint
// @implements export function alignSize(sz: Sats, lot: Sats, minSize: Sats): Sats
// @implements export function depthWithinBps(book: L2Book, side: Side, bps: Bps): Sats
// @implements export function isCrossed(book: L2Book): boolean          [T2.7 addition]
// @implements export function isAligned(px, sz, v: VenueParams): boolean [T2.7 addition]
// @implements export const BPS_DENOMINATOR: bigint
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  any network/transport call here — ./deepbook.ts owns reads
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. Every function is PURE and total; an empty book never throws.
// @invariant  2. alignPrice rounds INTO the spread: bids DOWN, asks UP (never crossing).
// @invariant  3. alignSize floors to `lot`; a result below `minSize` returns 0n (do not place).
// @invariant  4. bookMid returns `undefined` (not 0n) when a side is missing — absence is not a price.
// @ac         docs/BUILD-PLAN.md T2.7 — L2 book maths feeding maker/IOC split
// @verify     npm run test -- routing
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
 * (bestBid + bestAsk) / 2 — the NAV/collateral reference (G9).
 * Returns `undefined` on an empty or one-sided book: absence of a price is not the price 0.
 */
export function bookMid(book: L2Book): bigint | undefined {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid === undefined || bestAsk === undefined) return undefined;
  return (bestBid + bestAsk) / 2n;
}

/**
 * A crossed book (best bid >= best ask) is transient and pathological, but it IS representable
 * in a decoded snapshot taken between matching engine states. The mid stays defined; the maker
 * legs are what must be pushed out of the way (see ./route.ts `nonCrossingMakerPrice`).
 */
export function isCrossed(book: L2Book): boolean {
  const { bestBid, bestAsk } = topOfBook(book);
  if (bestBid === undefined || bestAsk === undefined) return false;
  return bestBid >= bestAsk;
}

/**
 * Tick-align a quote, rounding INTO the spread (bid ⇒ down, ask ⇒ up) so POST_ONLY cannot cross.
 *
 * Total by construction: a non-positive tick or a non-positive price yields `0n`, and callers
 * treat `0n` as "no order" (a DeepBook price is always >= MIN_PRICE = 1).
 */
export function alignPrice(px: bigint, tick: bigint, side: Side): bigint {
  if (tick <= 0n) return 0n;
  if (px <= 0n) return 0n;
  const remainder = px % tick;
  if (remainder === 0n) return px;
  return side === 'bid' ? px - remainder : px - remainder + tick;
}

/** Lot-align a size; anything left below `minSize` becomes 0n (do not place). */
export function alignSize(sz: Sats, lot: Sats, minSize: Sats): Sats {
  if (lot <= 0n) return 0n;
  if (sz <= 0n) return 0n;
  const floored = sz - (sz % lot);
  return floored >= minSize ? floored : 0n;
}

/** The granularity predicate `aphotic::router::assert_order_granularity` enforces on-chain. */
export function isAligned(px: bigint, sz: Sats, venue: VenueParams): boolean {
  if (venue.tickSize <= 0n || venue.lotSize <= 0n) return false;
  return px > 0n && px % venue.tickSize === 0n && sz % venue.lotSize === 0n && sz >= venue.minSize;
}

/**
 * Resting size within `bps` of the mid on one side — the liquidity input to the IOC split.
 *
 * Zero when the book has no mid (invariant 4): with nothing to measure against, the honest
 * answer is "no measurable passive depth", which routes the whole size to the IOC leg.
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
