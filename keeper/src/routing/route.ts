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
// @facts      ★ LADDER (T2.7 addition, opt-in via `ctx.ladder`): ONE maker level is the wrong shape
// @facts        for the near-EMPTY hBTC/DBUSDC book (docs/RECON.md R10) — a single price is a single
// @facts        point of no-fill. A ladder posts `levels` rungs stepping AWAY from the decided price
// @facts        by `stepBps` each (bids down, asks up), with size decaying geometrically:
// @facts          w_k = (1 − decayBps/10_000)^k · sz_k = totalSz · w_k / Σ w  (integer bigint maths).
// @facts        MAX_LADDER_LEVELS = 8 rungs per side per tick — a bound, not a tunable.
// @facts        Every rung passes through nonCrossingMakerPrice + alignPrice/alignSize, so a rung is
// @facts        either a LEGAL, non-crossing order or it is NOT EMITTED (@invariant 3/4 unchanged).
// @facts        Rungs landing on the SAME tick after alignment are MERGED (sizes added), never
// @facts        double-posted; Σ emitted rung size <= totalSz, never more.
// @facts        Ladder GEOMETRY is revealed by the resting orders themselves, so journalling the
// @facts        LadderSpec in RouteContext (needed for tier-1 replay) leaks nothing new — the secret
// @facts        that matters is the TRIGGER, and that stays in the Seal frame (G8).
// @facts      ★ SLICE (T2.7 addition, opt-in via `ctx.slice`): a large notional is worked in `count`
// @facts        slices instead of being sent at once. ⚠ route() is PURE and replayed by verify/ (G5),
// @facts        so the CURRENT SLICE IS AN EXPLICIT INPUT (`ctx.slice.index`), never a wall-clock
// @facts        read. `strategy/evaluate.ts#deriveSliceIndex` derives it PURELY from the journaled
// @facts        snapshot (Pyth sequence, else the limiter's on-chain seconds); any impure clock stays
// @facts        in execution/. Slice k gets floor(total·(k+1)/n) − floor(total·k/n), lot-aligned.
// @facts        `derisk` is NEVER sliced: getting flat is not something you work in slices.
// @facts      BACKWARD COMPATIBLE: with `ctx.ladder` and `ctx.slice` ABSENT, route() is byte-identical
// @facts        to the single-level behaviour — every previously journaled plan still replays.
// @implements export interface RouteContext / UnfilledMaker / LadderSpec / SliceSpec
// @implements export const DEFAULT_PASSIVE_BAND_BPS: Bps
// @implements export const MAX_LADDER_LEVELS: 8
// @implements export function route(decision: Decision, book: L2Book, ctx: RouteContext): Plan
// @implements export function residualAfterMaker(decision: Decision, book: L2Book, ctx: RouteContext): { bidSats: Sats; askSats: Sats }
// @implements export function rerouteAsIoc(plan: Plan, unfilled: readonly UnfilledMaker[], book: L2Book, ctx: RouteContext): Plan
// @implements export function nonCrossingMakerPrice(px: bigint, side: Side, book: L2Book, tick: bigint): bigint
// @implements export function ladderRungs(basePx: bigint, totalSz: Sats, side: Side, book: L2Book, ctx: RouteContext, ladder: LadderSpec): readonly MakerOrder[]
// @implements export function ladderSpec(p: { ladderLevels: number; ladderStepBps: Bps; ladderDecayBps: Bps }): LadderSpec
// @implements export function sliceOf(total: Sats, spec: SliceSpec, venue: VenueParams): Sats
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
// @invariant  6. Ladder: rung prices are strictly monotone away from the mid (bids non-increasing,
//                asks non-decreasing), never duplicated, and Σ rung size <= the requested size.
// @invariant  7. Slice: Σ over index 0..count-1 of sliceOf(total, …) <= total, and every slice is
//                lot-aligned or zero. The slice index is an ARGUMENT — never derived from a clock.
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

/** Basis-point denominator. A UNIT, never a tunable (mirrors strategy/params.ts). */
const BPS_DENOM = 10_000;

/**
 * Hard cap on rungs per side per tick. Eight POST_ONLY orders per side is already a full PTB;
 * beyond that the gas cost of a requote outruns the fill probability it buys on a thin book.
 * This is a BOUND (validated by strategy/params.ts#validateExecutionParams), not a strategy knob.
 */
export const MAX_LADDER_LEVELS = 8 as const;

/** Geometry of a laddered quote. Journalled inside RouteContext so `verify/` replays it (G5). */
export interface LadderSpec {
  /** Number of rungs per side, 1..MAX_LADDER_LEVELS. 1 ⇒ the classic single maker level. */
  readonly levels: number;
  /** Distance between consecutive rungs, bps of the decided price, moving AWAY from the mid. */
  readonly stepBps: Bps;
  /** Geometric size decay per rung, bps. 0 ⇒ flat ladder; 10_000 ⇒ everything on rung 0. */
  readonly decayBps: Bps;
}

/**
 * Which slice of a worked notional this tick executes.
 *
 * ⚠ `index` is an INPUT, not a clock read: route() is replayed bit-for-bit by `verify/` (G5).
 * `strategy/evaluate.ts#deriveSliceIndex` computes it purely from the journaled snapshot.
 */
export interface SliceSpec {
  /** 0-based slice index. Values outside [0, count) wrap — a raw cursor is safe to pass. */
  readonly index: number;
  /** Number of slices the decided size is worked in. >= 1. */
  readonly count: number;
}

export interface RouteContext extends VenueParams {
  /** Maker expiry stamp (ms epoch) = tick time + params.makerTimeoutMs. Caller-supplied. */
  readonly expireTs: Millis;
  /** Max size to expose as a taker in one tick, sats. Bounds the IOC residual. */
  readonly maxIocSats: Sats;
  /** Passive-depth band, bps of the mid. Defaults to DEFAULT_PASSIVE_BAND_BPS. */
  readonly passiveBandBps?: Bps;
  /** Laddered quoting. ABSENT ⇒ one maker level per side, exactly as before. */
  readonly ladder?: LadderSpec;
  /** Deterministic slicing of the decided size. ABSENT ⇒ the whole size is worked this tick. */
  readonly slice?: SliceSpec;
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
    // NOT sliced, deliberately: de-risking is the decision to stop working an order and get flat.
    pushDefined(iocOrders, iocLeg('bid', decision.bidSz, book, ctx));
    pushDefined(iocOrders, iocLeg('ask', decision.askSz, book, ctx));
    return { makerOrders, iocOrders, cancels };
  }

  // 'quote' | 'requote' — this tick's slice first (identity when ctx.slice is absent), maker
  // ladder next, then whatever cannot rest.
  const worked = sliceDecision(decision, ctx);

  if (ctx.ladder !== undefined) {
    makerOrders.push(...ladderRungs(worked.bidPx, worked.bidSz, 'bid', book, ctx, ctx.ladder));
    makerOrders.push(...ladderRungs(worked.askPx, worked.askSz, 'ask', book, ctx, ctx.ladder));
  } else {
    pushDefined(makerOrders, makerLeg(worked.bidPx, worked.bidSz, 'bid', book, ctx));
    pushDefined(makerOrders, makerLeg(worked.askPx, worked.askSz, 'ask', book, ctx));
  }

  const residual = residualAfterMaker(worked, book, ctx);
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

// ── laddered quoting (T2.7 addition) ─────────────────────────────────────────

/**
 * `levels` POST_ONLY rungs stepping AWAY from `basePx`, sizes decaying outward. PURE.
 *
 * Rung k sits at `basePx · (1 ∓ k·stepBps/10_000)` (bid ⇒ down, ask ⇒ up) and carries
 * `totalSz · (1 − decayBps/10_000)^k / Σ w` sats — all in integer bigint arithmetic, so the
 * ladder is byte-reproducible on any machine (@invariant 1).
 *
 * A rung is emitted ONLY if it survives the venue: `nonCrossingMakerPrice` (never crosses the
 * resting book, @invariant 4) then `alignPrice`/`alignSize` (tick/lot/min_size, @invariant 3).
 * Rungs that collapse onto the same tick are merged rather than double-posted, so the ladder can
 * never place two competing orders at one price (@invariant 6).
 */
export function ladderRungs(
  basePx: bigint,
  totalSz: Sats,
  side: Side,
  book: L2Book,
  ctx: RouteContext,
  ladder: LadderSpec,
): readonly MakerOrder[] {
  const levels = clampLevels(ladder.levels);
  const stepBps = clampBps(ladder.stepBps);
  const decayBps = clampBps(ladder.decayBps);

  if (basePx <= 0n || totalSz <= 0n) return [];
  if (levels === 1) {
    const only = makerLeg(basePx, totalSz, side, book, ctx);
    return only === undefined ? [] : [only];
  }

  // Geometric weights, EXACT in integers — the common denominator 10_000^(levels−1) is carried
  // explicitly so no rounding happens before the single division below:
  //   w_k = (10_000 − decay)^k · 10_000^(levels−1−k)   ⇒   w_k / Σw = (1 − decay/10_000)^k / Σ
  // Decay 0 ⇒ every weight equal (flat ladder); decay 10_000 ⇒ w_0 alone is non-zero.
  const keep = BigInt(BPS_DENOM - decayBps);
  const denom = BigInt(BPS_DENOM);
  const weights: bigint[] = [];
  let weightSum = 0n;
  for (let k = 0; k < levels; k++) {
    const w = keep ** BigInt(k) * denom ** BigInt(levels - 1 - k);
    weights.push(w);
    weightSum += w;
  }
  if (weightSum <= 0n) return [];

  // Insertion-ordered accumulation: rung 0 (nearest the mid) first, duplicates merged.
  const rungs: { px: bigint; sz: Sats }[] = [];

  for (let k = 0; k < levels; k++) {
    const offsetBps = BigInt(k) * BigInt(stepBps);
    if (side === 'bid' && offsetBps >= BigInt(BPS_DENOM)) break; // a bid at/below zero is no order
    const factor = side === 'bid' ? BigInt(BPS_DENOM) - offsetBps : BigInt(BPS_DENOM) + offsetBps;

    const rawPx = (basePx * factor) / BigInt(BPS_DENOM);
    const px = nonCrossingMakerPrice(rawPx, side, book, ctx.tickSize);
    if (px <= 0n) continue;

    const rawSz = (totalSz * (weights[k] ?? 0n)) / weightSum;
    const sz = alignSize(rawSz, ctx.lotSize, ctx.minSize);
    if (sz === 0n) continue;

    const existing = rungs.find((rung) => rung.px === px);
    if (existing === undefined) rungs.push({ px, sz });
    else existing.sz += sz;
  }

  return rungs.map((rung) => ({
    side,
    px: rung.px,
    sz: rung.sz,
    expireTs: ctx.expireTs,
    postOnly: true as const,
  }));
}

/**
 * Lift a `LadderSpec` out of the (Seal-encrypted) execution parameters.
 *
 * Structurally typed on purpose: `routing/` must not import `strategy/` — the verifier links both
 * and the layering keeps tier-1 routing replay free of any strategy dependency.
 */
export function ladderSpec(p: {
  readonly ladderLevels: number;
  readonly ladderStepBps: Bps;
  readonly ladderDecayBps: Bps;
}): LadderSpec {
  return {
    levels: clampLevels(p.ladderLevels),
    stepBps: clampBps(p.ladderStepBps),
    decayBps: clampBps(p.ladderDecayBps),
  };
}

// ── deterministic time slicing (T2.7 addition) ───────────────────────────────

/**
 * The sats slice `spec.index` of `total`, lot-aligned. PURE — no clock, by construction (G5).
 *
 * Slice k is `floor(total·(k+1)/n) − floor(total·k/n)`, so the slices partition the total exactly
 * before alignment and Σ slices <= total after it (@invariant 7). A slice that floors below
 * `min_size` becomes 0n — an illegal order is never emitted just to honour a schedule.
 */
export function sliceOf(total: Sats, spec: SliceSpec, venue: VenueParams): Sats {
  if (total <= 0n) return 0n;
  const count = clampCount(spec.count);
  if (count === 1) return alignSize(total, venue.lotSize, venue.minSize);

  const n = BigInt(count);
  const k = BigInt(wrapIndex(spec.index, count));
  const portion = (total * (k + 1n)) / n - (total * k) / n;
  return alignSize(portion, venue.lotSize, venue.minSize);
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

/** This tick's working size. Identity when `ctx.slice` is absent (backward compatibility). */
function sliceDecision(decision: Decision, ctx: RouteContext): Decision {
  const spec = ctx.slice;
  if (spec === undefined) return decision;
  return {
    ...decision,
    bidSz: sliceOf(decision.bidSz, spec, ctx),
    askSz: sliceOf(decision.askSz, spec, ctx),
  };
}

/** Total: a non-integer/out-of-range level count collapses to the classic single level. */
function clampLevels(levels: number): number {
  if (!Number.isFinite(levels) || !Number.isInteger(levels) || levels < 1) return 1;
  return levels > MAX_LADDER_LEVELS ? MAX_LADDER_LEVELS : levels;
}

/** Total: a non-integer/out-of-range bps collapses to 0 (no step / no decay). */
function clampBps(bps: Bps): number {
  if (!Number.isFinite(bps)) return 0;
  const whole = Math.trunc(bps);
  if (whole < 0) return 0;
  return whole > BPS_DENOM ? BPS_DENOM : whole;
}

/** Total: a non-integer/out-of-range slice count collapses to 1 (do not slice). */
function clampCount(count: number): number {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) return 1;
  return count;
}

/** Wrap a (possibly raw cursor) index into [0, count). */
function wrapIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isInteger(index)) return 0;
  return ((index % count) + count) % count;
}

function makerKey(order: MakerOrder): string {
  return `${order.side}|${order.px}|${order.sz}|${order.expireTs}`;
}

function pushDefined<T>(into: T[], value: T | undefined): void {
  if (value !== undefined) into.push(value);
}
