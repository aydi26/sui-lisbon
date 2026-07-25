// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
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
import type { Bps, L2Book, Sats, Side } from '../types.js';

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
// TODO(T2.7): return { tickSize, lotSize, minSize } from cfg.deepbook.
export function venueParams(_cfg: Config): VenueParams {
  throw new Error('TODO(T2.7): venueParams not implemented');
}

/** Best bid/ask from a decoded snapshot. Either side may be absent (empty book). */
// TODO(T2.7): max(bids.px) / min(asks.px) with their sizes; tolerate empty arrays.
export function topOfBook(_book: L2Book): TopOfBook {
  throw new Error('TODO(T2.7): topOfBook not implemented');
}

/**
 * (bestBid + bestAsk) / 2 — the NAV/collateral reference (G9).
 * Returns `undefined` on an empty or one-sided book: absence of a price is not the price 0.
 */
// TODO(T2.7): compute from topOfBook; undefined unless BOTH sides exist.
export function bookMid(_book: L2Book): bigint | undefined {
  throw new Error('TODO(T2.7): bookMid not implemented');
}

/** Tick-align a quote, rounding INTO the spread (bid ⇒ down, ask ⇒ up) so POST_ONLY cannot cross. */
// TODO(T2.7): side === 'bid' ? floorTo(px, tick) : ceilTo(px, tick).
export function alignPrice(_px: bigint, _tick: bigint, _side: Side): bigint {
  throw new Error('TODO(T2.7): alignPrice not implemented');
}

/** Lot-align a size; anything left below `minSize` becomes 0n (do not place). */
// TODO(T2.7): floored = sz - (sz % lot); return floored >= minSize ? floored : 0n.
export function alignSize(_sz: Sats, _lot: Sats, _minSize: Sats): Sats {
  throw new Error('TODO(T2.7): alignSize not implemented');
}

/** Resting size within `bps` of the mid on one side — the liquidity input to the IOC split. */
// TODO(T2.7): sum level sizes whose price is within bps of bookMid; 0n when the mid is undefined.
export function depthWithinBps(_book: L2Book, _side: Side, _bps: Bps): Sats {
  throw new Error('TODO(T2.7): depthWithinBps not implemented');
}
