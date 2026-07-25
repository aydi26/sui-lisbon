// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §4 (`route(decision, book) -> Plan`, PURE; maker-first, IOC residual)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7) · CUT LINE item 2 · docs/FACTS.md#no-cetus
// @rules      G4 G5 G7 G9
// @depends    ./book.ts (T2.7) · ../types.ts (Decision/Plan) · ../strategy/evaluate.ts (T2.6)
// @facts      ★ G4 — THERE IS NO hBTC POOL ON ANY AMM. The router is DeepBook maker `POST_ONLY`
// @facts        plus an IOC sweep ON THE SAME BOOK. No second-venue taker leg, no concentrated
// @facts        range logic. The base design in "README (8).md" routes the SUI/USDC vault through
// @facts        an AMM; that path does NOT carry here.
// @facts      Maker-first: post at `decision.bidPx/askPx` with POST_ONLY (order type 3); any residual
// @facts        that must cross becomes an IOC (order type 1) on the SAME pool.
// @facts      After `params.makerTimeoutMs` the unfilled maker remainder is cancelled and re-routed
// @facts        as IOC — there is nowhere else to route it (G4).
// @facts      Self-match prevention is ON: the vault may rest while its own flow crosses
// @facts        (deepbook self-matching options: ALLOWED=0 · CANCEL_TAKER=1 · CANCEL_MAKER=2).
// @facts      Alignment is enforced HERE, before any PTB is built: price % tick == 0,
// @facts        quantity % lot == 0, quantity >= min_size (./book.ts alignPrice/alignSize).
// @facts      ⚠ `place_post_only_limit_order` is NOT deployed on v20 — maker placement is
// @facts        `place_limit_order` with order_type = POST_ONLY (docs/FACTS.md E-K6/E-M6).
// @facts      PURE: this function is replayed by `verify/` against the journaled book snapshot, so
// @facts        the routing tier is publicly checkable WITHOUT the strategy plaintext (G5, §9.1).
// @facts      PASSIVE-DEPTH MODEL (the T2.7 concretisation of "residual that must cross"): a maker
// @facts        order joins the queue BEHIND the depth already resting within `passiveBandBps` of
// @facts        the mid on its own side. Size beyond that queue is what cannot reasonably expect a
// @facts        passive fill this tick and is therefore the IOC residual. Band defaults to
// @facts        DEFAULT_PASSIVE_BAND_BPS and is journalled through RouteContext, so `verify/`
// @facts        replays the identical split.
// @implements export interface RouteContext / UnfilledMaker
// @implements export const DEFAULT_PASSIVE_BAND_BPS: Bps
// @implements export function route(decision: Decision, book: L2Book, ctx: RouteContext): Plan
// @implements export function residualAfterMaker(decision: Decision, book: L2Book, ctx: RouteContext): { bidSats: Sats; askSats: Sats }
// @implements export function rerouteAsIoc(plan: Plan, unfilled: readonly UnfilledMaker[], book: L2Book, ctx: RouteContext): Plan
// @implements export function nonCrossingMakerPrice(px: bigint, side: Side, book: L2Book, tick: bigint): bigint
// @forbidden  any non-DeepBook venue leg, and any concentrated-liquidity range logic — G4, gates.ps1 g4
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  any network call or PTB build here — execution/trade.ts owns that
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. PURE + total: same (decision, book, ctx) ⇒ byte-identical Plan.
// @invariant  2. `Plan.iocOrders` are on the SAME pool as the maker leg — there is no second venue.
// @invariant  3. Every emitted price is tick-aligned; every size lot-aligned and >= min_size.
// @invariant  4. A POST_ONLY maker never crosses the resting book (it would abort on-chain).
// @invariant  5. `cancels` precede placements in the produced Plan ordering — execution/trade.ts
//                compiles the PTB in the field order cancels → makerOrders → iocOrders.
// @ac         docs/KEEPER.md §13 A5 — Plan.iocOrders only; no second-venue module imported anywhere
// @verify     npm run test -- routing
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Bps, Decision, IocOrder, L2Book, MakerOrder, Millis, OrderId, Plan, Sats, Side } from '../types.js';

import { alignPrice, alignSize, depthWithinBps, topOfBook, type VenueParams } from './book.js';

/**
 * Half-width of the band whose resting depth is treated as "the queue ahead of us".
 * 50 bps of the mid — wide enough to cover the top few ticks of a 1_000_000-tick book,
 * narrow enough that far-away depth does not flatter the passive estimate.
 */
export const DEFAULT_PASSIVE_BAND_BPS: Bps = 50;

export interface RouteContext extends VenueParams {
  /** Maker expiry stamp (ms epoch) = tick time + params.makerTimeoutMs. Caller-supplied. */
  readonly expireTs: Millis;
  /** Max size to expose as a taker in one tick, sats. Bounds the IOC residual. */
  readonly maxIocSats: Sats;
  /** Passive-depth band, bps of the mid. Defaults to DEFAULT_PASSIVE_BAND_BPS. */
  readonly passiveBandBps?: Bps;
}

/**
 * A maker order that did not fill before `makerTimeoutMs`.
 *
 * `orderId` is optional because `Plan.makerOrders` carries no id until DeepBook assigns one; when
 * the run loop knows the resting id it passes it here and `rerouteAsIoc` appends the cancel.
 */
export interface UnfilledMaker extends MakerOrder {
  readonly orderId?: OrderId;
}

/**
 * The highest (bid) / lowest (ask) tick-aligned price at which a POST_ONLY order still rests
 * passively against `book`.
 *
 * A POST_ONLY order that would execute ANY quantity aborts upstream
 * (`EPOSTOrderCrossesOrderbook`), so the clamp is not a preference — it is the difference
 * between a resting quote and a reverted transaction (@invariant 4).
 *
 * Returns `0n` when no such price exists (e.g. the best ask is one tick above zero), and the
 * caller then places nothing.
 */
export function nonCrossingMakerPrice(px: bigint, side: Side, book: L2Book, tick: bigint): bigint {
  const aligned = alignPrice(px, tick, side);
  const { bestBid, bestAsk } = topOfBook(book);

  if (side === 'bid') {
    if (bestAsk === undefined || aligned < bestAsk) return aligned;
    return alignPrice(bestAsk - 1n, tick, 'bid');
  }
  if (bestBid === undefined || (aligned > bestBid && aligned > 0n)) return aligned;
  return alignPrice(bestBid + 1n, tick, 'ask');
}

/**
 * Split a `Decision` into a maker-first `Plan`. PURE.
 *
 * Maker POST_ONLY at the decided prices; any residual that must cross is IOC ON THE SAME BOOK.
 * `derisk` skips the passive leg entirely — the point of de-risking is to stop resting and get
 * flat, so the whole decided size goes to the IOC leg (still capped by `ctx.maxIocSats`).
 */
export function route(decision: Decision, book: L2Book, ctx: RouteContext): Plan {
  const cancels: OrderId[] = [...decision.cancels];

  if (decision.action === 'noop') {
    // Cancels still stand: pulling quotes is exactly what a noop tick may need to do.
    return { makerOrders: [], iocOrders: [], cancels };
  }

  const makerOrders: MakerOrder[] = [];
  const iocOrders: IocOrder[] = [];

  if (decision.action === 'derisk') {
    pushDefined(iocOrders, iocLeg('bid', decision.bidSz, book, ctx));
    pushDefined(iocOrders, iocLeg('ask', decision.askSz, book, ctx));
    return { makerOrders, iocOrders, cancels };
  }

  // 'quote' | 'requote' — maker first, then whatever cannot rest.
  pushDefined(makerOrders, makerLeg(decision.bidPx, decision.bidSz, 'bid', book, ctx));
  pushDefined(makerOrders, makerLeg(decision.askPx, decision.askSz, 'ask', book, ctx));

  const residual = residualAfterMaker(decision, book, ctx);
  pushDefined(iocOrders, iocLeg('bid', residual.bidSats, book, ctx));
  pushDefined(iocOrders, iocLeg('ask', residual.askSats, book, ctx));

  return { makerOrders, iocOrders, cancels };
}

/**
 * How much of each side cannot rest passively and must cross. PURE.
 *
 * `wanted - queueAhead`, floored at zero, where `queueAhead` is the resting depth within
 * `passiveBandBps` of the mid on the SAME side (see the banner's passive-depth model). A book
 * with no mid has no measurable queue ⇒ the entire size is residual.
 */
export function residualAfterMaker(
  decision: Decision,
  book: L2Book,
  ctx: RouteContext,
): { bidSats: Sats; askSats: Sats } {
  const band = ctx.passiveBandBps ?? DEFAULT_PASSIVE_BAND_BPS;

  const bidWanted = alignSize(decision.bidSz, ctx.lotSize, ctx.minSize);
  const askWanted = alignSize(decision.askSz, ctx.lotSize, ctx.minSize);
  const bidQueue = depthWithinBps(book, 'bid', band);
  const askQueue = depthWithinBps(book, 'ask', band);

  return {
    bidSats: bidWanted > bidQueue ? bidWanted - bidQueue : 0n,
    askSats: askWanted > askQueue ? askWanted - askQueue : 0n,
  };
}

/**
 * The `makerTimeoutMs` path: cancel the unfilled maker remainder and re-route it as IOC on the
 * SAME book. There is nowhere else to send it (G4).
 *
 * The unfilled orders are removed from `makerOrders` (they are being cancelled, not re-posted),
 * their sizes reappear as capped IOC legs, and any known `orderId` is appended to `cancels`.
 */
export function rerouteAsIoc(
  plan: Plan,
  unfilled: readonly UnfilledMaker[],
  book: L2Book,
  ctx: RouteContext,
): Plan {
  const dropped = new Set(unfilled.map(makerKey));
  const makerOrders = plan.makerOrders.filter((order) => !dropped.has(makerKey(order)));
  const iocOrders: IocOrder[] = [...plan.iocOrders];
  const cancels: OrderId[] = [...plan.cancels];

  for (const order of unfilled) {
    pushDefined(iocOrders, iocLeg(order.side, order.sz, book, ctx));
    if (order.orderId !== undefined && !cancels.includes(order.orderId)) {
      cancels.push(order.orderId);
    }
  }

  return { makerOrders, iocOrders, cancels };
}

/** The neutral element — a FRESH plan every call, so no caller can alias another's arrays. */
export function emptyPlan(): Plan {
  return { makerOrders: [], iocOrders: [], cancels: [] };
}

// ── internals (all pure) ─────────────────────────────────────────────────────

function makerLeg(
  px: bigint,
  sz: Sats,
  side: Side,
  book: L2Book,
  ctx: RouteContext,
): MakerOrder | undefined {
  const size = alignSize(sz, ctx.lotSize, ctx.minSize);
  if (size === 0n) return undefined;
  const price = nonCrossingMakerPrice(px, side, book, ctx.tickSize);
  if (price <= 0n) return undefined;
  return { side, px: price, sz: size, expireTs: ctx.expireTs, postOnly: true };
}

/**
 * The crossing leg. Its limit price is derived from the OPPOSITE top of book so the order can
 * actually fill: a bid sweeps up to the best ask (rounded UP a tick), an ask sweeps down to the
 * best bid (rounded DOWN a tick). With nothing resting on the far side there is nothing to
 * cross into, so no order is emitted — never an unbounded market order.
 */
function iocLeg(side: Side, sats: Sats, book: L2Book, ctx: RouteContext): IocOrder | undefined {
  const capped = sats < ctx.maxIocSats ? sats : ctx.maxIocSats;
  const size = alignSize(capped, ctx.lotSize, ctx.minSize);
  if (size === 0n) return undefined;

  const { bestBid, bestAsk } = topOfBook(book);
  const reference = side === 'bid' ? bestAsk : bestBid;
  if (reference === undefined) return undefined;

  const price = alignPrice(reference, ctx.tickSize, side === 'bid' ? 'ask' : 'bid');
  if (price <= 0n) return undefined;

  return { side, px: price, sz: size, ioc: true };
}

function makerKey(order: MakerOrder): string {
  return `${order.side}|${order.px}|${order.sz}|${order.expireTs}`;
}

function pushDefined<T>(into: T[], value: T | undefined): void {
  if (value !== undefined) into.push(value);
}
