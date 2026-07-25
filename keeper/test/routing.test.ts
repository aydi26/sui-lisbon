// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §4 (routing/), §5.1 (trade PTB) + ERRATA E-K6
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7 AC + VERIFY `npm run test -- routing`)
// @rules      G2 G4 G5 G9 G10
// @depends    ../src/routing/** (T2.7) · ../src/execution/trade.ts · ./support/fixtures.ts
// @facts      Venue under test: tick 1_000_000 · lot 1_000 · min_size 100_000 (cfg.deepbook.*).
// @facts      Book fixtures are SYNTHETIC and priced around 1e11 so every level is tick-aligned.
// @facts      ⚠ No network, no wall clock: every `atMs`/`expireTs` is a literal, every book is a
// @facts        fixture, and the only randomness is the seeded SplitMix64 in ../src/util/rng.ts.
// @implements empty book · one-sided book · crossed book · maker/IOC split arithmetic ·
// @implements granularity rounding · L2 decode · deterministic seeder · router PTB shape
// @implements LADDER: rung count/spacing/decay · granularity rejection · non-crossing on a
// @implements   one-sided and a CROSSED book · empty book · duplicate-tick merge · level cap
// @implements SLICE: partition arithmetic · route() footprint reduction · derisk is never sliced
// @implements DETERMINISM: two identical runs produce a BYTE-identical serialized plan
// @forbidden  a test that opens a socket or reads the wall clock — vitest runs offline
// @invariant  1. Every assertion checks a value, never just "did not throw".
// @verify     npm run test -- routing
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { describe, expect, it } from 'vitest';

import {
  buildCancelTx,
  buildTradeTx,
  decodeRouterEvents,
  type TradeContext,
} from '../src/execution/trade.js';
import {
  alignPrice,
  alignSize,
  assembleBook,
  bookMid,
  buildLevel2RangeTx,
  buildTakerScript,
  decodeLevel2Range,
  DEEPBOOK_MAX_PRICE,
  DEEPBOOK_MIN_PRICE,
  depthWithinBps,
  isAligned,
  isCrossed,
  ladderRungs,
  ladderSpec,
  MAX_LADDER_LEVELS,
  nonCrossingMakerPrice,
  rerouteAsIoc,
  route,
  residualAfterMaker,
  sliceOf,
  stepsDue,
  stepToPlan,
  topOfBook,
  venueParams,
  type LadderSpec,
  type RouteContext,
  type TakerScriptOptions,
} from '../src/routing/index.js';
import type { Decision, L2Book, L2Level } from '../src/types.js';
import { AphoticError, ConfigError } from '../src/util/errors.js';

import { testConfig } from './support/fixtures.js';

const cfg = testConfig();
const VENUE = venueParams(cfg);
const POOL = cfg.deepbook.poolId;

// Every fixture price is a multiple of tick = 1_000_000 (the venue rejects anything else).
const TICK = 1_000_000n;
const LOT = 1_000n;
const MIN_SIZE = 100_000n;

function book(bids: readonly L2Level[], asks: readonly L2Level[], atMs = 1_000): L2Book {
  const partial: L2Book = { poolId: POOL, bids, asks, mid: 0n, atMs };
  return { ...partial, mid: bookMid(partial) ?? 0n };
}

const EMPTY = book([], []);

const ONE_SIDED = book([{ px: 99_800_000_000n, sz: 300_000n }], []);

/** mid = (99_800_000_000 + 100_200_000_000) / 2 = 100_000_000_000. */
const TWO_SIDED = book(
  [
    { px: 99_800_000_000n, sz: 300_000n },
    { px: 99_600_000_000n, sz: 200_000n },
    { px: 90_000_000_000n, sz: 5_000_000n }, // far outside the 50 bps band
  ],
  [
    { px: 100_200_000_000n, sz: 250_000n },
    { px: 100_400_000_000n, sz: 150_000n },
    { px: 110_000_000_000n, sz: 9_000_000n }, // far outside the band
  ],
);

/** best bid 102e9 >= best ask 99e9 — a transient crossed snapshot. */
const CROSSED = book(
  [{ px: 102_000_000_000n, sz: 300_000n }],
  [{ px: 99_000_000_000n, sz: 300_000n }],
);

const CTX: RouteContext = {
  ...VENUE,
  expireTs: 1_700_000_015_000,
  maxIocSats: 1_000_000n,
};

function decision(over: Partial<Decision> = {}): Decision {
  return {
    action: 'quote',
    bidPx: 99_700_000_500n, // deliberately NOT tick-aligned
    askPx: 100_300_000_500n, // deliberately NOT tick-aligned
    bidSz: 1_234_567n, // deliberately NOT lot-aligned
    askSz: 450_000n,
    cancels: [],
    jitterSeed: 'routing-test',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/book — venue params and top of book', () => {
  it('venueParams lifts tick/lot/min_size straight out of config (no literal in logic, G7)', () => {
    expect(VENUE).toEqual({ tickSize: TICK, lotSize: LOT, minSize: MIN_SIZE });
  });

  it('EMPTY book: no top of book, no mid, not crossed — and nothing throws (invariant 1)', () => {
    expect(topOfBook(EMPTY)).toEqual({
      bestBid: undefined,
      bestAsk: undefined,
      bidSize: undefined,
      askSize: undefined,
    });
    expect(bookMid(EMPTY)).toBeUndefined();
    expect(isCrossed(EMPTY)).toBe(false);
    expect(depthWithinBps(EMPTY, 'bid', 50)).toBe(0n);
  });

  it('ONE-SIDED book: a best bid but NO mid — absence of a price is not the price 0 (invariant 4)', () => {
    const top = topOfBook(ONE_SIDED);
    expect(top.bestBid).toBe(99_800_000_000n);
    expect(top.bidSize).toBe(300_000n);
    expect(top.bestAsk).toBeUndefined();
    expect(bookMid(ONE_SIDED)).toBeUndefined();
    expect(ONE_SIDED.mid).toBe(0n);
  });

  it('TWO-SIDED book: best bid/ask are the extrema, mid is their average', () => {
    const top = topOfBook(TWO_SIDED);
    expect(top.bestBid).toBe(99_800_000_000n);
    expect(top.bestAsk).toBe(100_200_000_000n);
    expect(bookMid(TWO_SIDED)).toBe(100_000_000_000n);
    expect(isCrossed(TWO_SIDED)).toBe(false);
  });

  it('CROSSED book still has a mid, and reports itself as crossed', () => {
    expect(bookMid(CROSSED)).toBe(100_500_000_000n);
    expect(isCrossed(CROSSED)).toBe(true);
  });

  it('zero-size levels are ignored — a level with no size is not a price', () => {
    const b = book([{ px: 999_000_000_000n, sz: 0n }, { px: 99_000_000_000n, sz: 5_000n }], []);
    expect(topOfBook(b).bestBid).toBe(99_000_000_000n);
  });

  it('depthWithinBps sums only what rests inside the band, per side', () => {
    // mid 100e9, 50 bps band = 500_000_000 ⇒ bid bound 99.5e9, ask bound 100.5e9.
    expect(depthWithinBps(TWO_SIDED, 'bid', 50)).toBe(500_000n); // 300k + 200k, the 90e9 level is out
    expect(depthWithinBps(TWO_SIDED, 'ask', 50)).toBe(400_000n); // 250k + 150k, the 110e9 level is out
    // A wide enough band pulls the far levels in.
    expect(depthWithinBps(TWO_SIDED, 'bid', 2_000)).toBe(5_500_000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/book — granularity rounding (tick 1_000_000 / lot 1_000 / min_size 100_000)', () => {
  it('alignPrice rounds INTO the spread: bids DOWN, asks UP (invariant 2)', () => {
    expect(alignPrice(99_700_000_500n, TICK, 'bid')).toBe(99_700_000_000n);
    expect(alignPrice(99_700_000_500n, TICK, 'ask')).toBe(99_701_000_000n);
    // Already aligned ⇒ unchanged on BOTH sides (no gratuitous tick of slippage).
    expect(alignPrice(99_700_000_000n, TICK, 'bid')).toBe(99_700_000_000n);
    expect(alignPrice(99_700_000_000n, TICK, 'ask')).toBe(99_700_000_000n);
  });

  it('alignPrice is total: sub-tick, zero and negative prices collapse to 0n ("no order")', () => {
    expect(alignPrice(999_999n, TICK, 'bid')).toBe(0n);
    expect(alignPrice(999_999n, TICK, 'ask')).toBe(TICK);
    expect(alignPrice(0n, TICK, 'ask')).toBe(0n);
    expect(alignPrice(-5n, TICK, 'bid')).toBe(0n);
    expect(alignPrice(1_500_000n, 0n, 'bid')).toBe(0n);
  });

  it('alignSize floors to the lot and drops anything below min_size to 0n (invariant 3)', () => {
    expect(alignSize(1_234_567n, LOT, MIN_SIZE)).toBe(1_234_000n);
    expect(alignSize(100_000n, LOT, MIN_SIZE)).toBe(100_000n); // exactly min_size survives
    expect(alignSize(100_999n, LOT, MIN_SIZE)).toBe(100_000n);
    expect(alignSize(99_999n, LOT, MIN_SIZE)).toBe(0n); // floors to 99_000 < min_size
    expect(alignSize(0n, LOT, MIN_SIZE)).toBe(0n);
    expect(alignSize(-1n, LOT, MIN_SIZE)).toBe(0n);
  });

  it('isAligned mirrors aphotic::router::assert_order_granularity', () => {
    expect(isAligned(100_000_000_000n, 100_000n, VENUE)).toBe(true);
    expect(isAligned(100_000_000_001n, 100_000n, VENUE)).toBe(false); // bad tick
    expect(isAligned(100_000_000_000n, 100_001n, VENUE)).toBe(false); // bad lot
    expect(isAligned(100_000_000_000n, 99_000n, VENUE)).toBe(false); // below min_size
    expect(isAligned(0n, 100_000n, VENUE)).toBe(false); // price 0 is never legal
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/route — maker POST_ONLY never crosses (invariant 4)', () => {
  it('leaves a non-crossing quote alone', () => {
    expect(nonCrossingMakerPrice(99_700_000_500n, 'bid', TWO_SIDED, TICK)).toBe(99_700_000_000n);
    expect(nonCrossingMakerPrice(100_300_000_500n, 'ask', TWO_SIDED, TICK)).toBe(100_301_000_000n);
  });

  it('clamps a crossing bid to the last tick STRICTLY below the best ask', () => {
    expect(nonCrossingMakerPrice(100_500_000_000n, 'bid', TWO_SIDED, TICK)).toBe(100_199_000_000n);
    // Exactly at the best ask is still a cross.
    expect(nonCrossingMakerPrice(100_200_000_000n, 'bid', TWO_SIDED, TICK)).toBe(100_199_000_000n);
  });

  it('clamps a crossing ask to the first tick STRICTLY above the best bid', () => {
    expect(nonCrossingMakerPrice(99_000_000_000n, 'ask', TWO_SIDED, TICK)).toBe(99_801_000_000n);
    expect(nonCrossingMakerPrice(99_800_000_000n, 'ask', TWO_SIDED, TICK)).toBe(99_801_000_000n);
  });

  it('on a CROSSED book both legs are pushed out of the way, and neither would abort on-chain', () => {
    const bid = nonCrossingMakerPrice(103_000_000_000n, 'bid', CROSSED, TICK);
    const ask = nonCrossingMakerPrice(98_000_000_000n, 'ask', CROSSED, TICK);
    expect(bid).toBe(98_999_000_000n); // < best ask 99e9
    expect(ask).toBe(102_001_000_000n); // > best bid 102e9
    expect(bid < 99_000_000_000n).toBe(true);
    expect(ask > 102_000_000_000n).toBe(true);
  });

  it('an empty book imposes no clamp — there is nothing to cross', () => {
    expect(nonCrossingMakerPrice(99_700_000_500n, 'bid', EMPTY, TICK)).toBe(99_700_000_000n);
    expect(nonCrossingMakerPrice(99_700_000_500n, 'ask', EMPTY, TICK)).toBe(99_701_000_000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/route — maker/IOC split arithmetic', () => {
  it('residualAfterMaker = aligned size − passive queue within the band, floored at zero', () => {
    // bid: 1_234_567 → 1_234_000 aligned; queue 500_000 ⇒ 734_000 must cross.
    // ask:   450_000 → 450_000 aligned; queue 400_000 ⇒  50_000 must cross (below min_size).
    expect(residualAfterMaker(decision(), TWO_SIDED, CTX)).toEqual({
      bidSats: 734_000n,
      askSats: 50_000n,
    });
  });

  it('a size fully covered by the passive queue leaves NO residual', () => {
    const d = decision({ bidSz: 300_000n, askSz: 300_000n });
    expect(residualAfterMaker(d, TWO_SIDED, CTX)).toEqual({ bidSats: 0n, askSats: 0n });
  });

  it('no mid ⇒ no measurable queue ⇒ the whole size is residual', () => {
    expect(residualAfterMaker(decision(), EMPTY, CTX)).toEqual({
      bidSats: 1_234_000n,
      askSats: 450_000n,
    });
  });

  it('route(quote) posts both makers and crosses ONLY the residual that clears min_size', () => {
    const plan = route(decision(), TWO_SIDED, CTX);

    expect(plan.makerOrders).toEqual([
      { side: 'bid', px: 99_700_000_000n, sz: 1_234_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'ask', px: 100_301_000_000n, sz: 450_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
    // The 50_000-sat ask residual is below min_size ⇒ it is NOT placed.
    expect(plan.iocOrders).toEqual([
      { side: 'bid', px: 100_200_000_000n, sz: 734_000n, ioc: true },
    ]);
    expect(plan.cancels).toEqual([]);
  });

  it('every emitted price is tick-aligned and every size lot-aligned & >= min_size (invariant 3)', () => {
    const plan = route(decision(), TWO_SIDED, CTX);
    for (const o of [...plan.makerOrders, ...plan.iocOrders]) {
      expect(isAligned(o.px, o.sz, VENUE)).toBe(true);
    }
  });

  it('the IOC leg is capped by ctx.maxIocSats', () => {
    const d = decision({ bidSz: 50_000_000n });
    const plan = route(d, TWO_SIDED, { ...CTX, maxIocSats: 250_000n });
    expect(plan.iocOrders).toEqual([{ side: 'bid', px: 100_200_000_000n, sz: 250_000n, ioc: true }]);
  });

  it('a ONE-SIDED book can only cross the side that exists', () => {
    // Bids rest, asks are empty. A crossing BID has no ask to lift ⇒ not emitted. A crossing ASK
    // hits the resting bid ⇒ emitted. With no mid there is no measurable queue, so the whole
    // decided ask size is residual.
    const plan = route(decision(), ONE_SIDED, CTX);
    expect(plan.makerOrders).toHaveLength(2);
    expect(plan.iocOrders).toEqual([
      { side: 'ask', px: 99_800_000_000n, sz: 450_000n, ioc: true },
    ]);
  });

  it('an EMPTY book emits maker legs at the decided (aligned) prices and no IOC', () => {
    const plan = route(decision(), EMPTY, CTX);
    expect(plan.makerOrders.map((o) => o.px)).toEqual([99_700_000_000n, 100_301_000_000n]);
    expect(plan.iocOrders).toEqual([]);
  });

  it('route(noop) places nothing but STILL honours the cancels — pulling quotes is a real action', () => {
    const plan = route(decision({ action: 'noop', cancels: [7n, 9n] }), TWO_SIDED, CTX);
    expect(plan).toEqual({ makerOrders: [], iocOrders: [], cancels: [7n, 9n] });
  });

  it('route(derisk) skips the passive leg entirely and crosses out', () => {
    const plan = route(decision({ action: 'derisk', cancels: [3n] }), TWO_SIDED, CTX);
    expect(plan.makerOrders).toEqual([]);
    expect(plan.iocOrders).toEqual([
      { side: 'bid', px: 100_200_000_000n, sz: 1_000_000n, ioc: true }, // capped at maxIocSats
      { side: 'ask', px: 99_800_000_000n, sz: 450_000n, ioc: true },
    ]);
    expect(plan.cancels).toEqual([3n]);
  });

  it('is PURE: the same (decision, book, ctx) yields a structurally identical Plan (invariant 1)', () => {
    expect(route(decision(), TWO_SIDED, CTX)).toEqual(route(decision(), TWO_SIDED, CTX));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/route — rerouteAsIoc (the makerTimeoutMs path, G4: same book only)', () => {
  it('drops the unfilled maker, re-routes its size as IOC, and appends its cancel', () => {
    const plan = route(decision(), TWO_SIDED, CTX);
    const unfilledBid = plan.makerOrders[0];
    expect(unfilledBid).toBeDefined();
    if (unfilledBid === undefined) return;

    const next = rerouteAsIoc(plan, [{ ...unfilledBid, orderId: 42n }], TWO_SIDED, CTX);

    expect(next.makerOrders).toEqual([plan.makerOrders[1]]);
    expect(next.cancels).toEqual([42n]);
    // The original 734_000 IOC plus the re-routed maker size, capped at maxIocSats = 1_000_000.
    expect(next.iocOrders).toEqual([
      { side: 'bid', px: 100_200_000_000n, sz: 734_000n, ioc: true },
      { side: 'bid', px: 100_200_000_000n, sz: 1_000_000n, ioc: true },
    ]);
  });

  it('never duplicates a cancel already in the plan', () => {
    const plan = route(decision({ cancels: [42n] }), TWO_SIDED, CTX);
    const maker = plan.makerOrders[0];
    if (maker === undefined) throw new Error('fixture: expected a maker leg');
    const next = rerouteAsIoc(plan, [{ ...maker, orderId: 42n }], TWO_SIDED, CTX);
    expect(next.cancels).toEqual([42n]);
  });

  it('an unfilled maker with no known order id still re-routes its size', () => {
    const plan = route(decision(), TWO_SIDED, CTX);
    const maker = plan.makerOrders[1];
    if (maker === undefined) throw new Error('fixture: expected an ask maker leg');
    const next = rerouteAsIoc(plan, [maker], TWO_SIDED, CTX);
    expect(next.cancels).toEqual([]);
    expect(next.iocOrders.some((o) => o.side === 'ask' && o.sz === 450_000n)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/route — LADDERED quoting (the right shape for a near-empty book, R10)', () => {
  /** 3 rungs · 15 bps apart · 30 % size decay outward. */
  const L3: LadderSpec = { levels: 3, stepBps: 15, decayBps: 3_000 };
  const LADDER_CTX: RouteContext = { ...CTX, ladder: L3 };

  it('emits N rungs stepping AWAY from the decided price with geometrically decaying size', () => {
    // w_k = 0.7^k over a 10_000-denominated integer weight ⇒ Σw = 2.19; sizes floor to the lot.
    expect(ladderRungs(99_700_000_500n, 1_234_567n, 'bid', TWO_SIDED, CTX, L3)).toEqual([
      { side: 'bid', px: 99_700_000_000n, sz: 563_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'bid', px: 99_550_000_000n, sz: 394_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'bid', px: 99_400_000_000n, sz: 276_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
    expect(ladderRungs(100_300_000_500n, 450_000n, 'ask', TWO_SIDED, CTX, L3)).toEqual([
      { side: 'ask', px: 100_301_000_000n, sz: 205_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'ask', px: 100_451_000_000n, sz: 143_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'ask', px: 100_601_000_000n, sz: 100_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
  });

  it('rung SPACING is exactly stepBps of the base price, and the ladder never over-posts the size', () => {
    // A tick-clean base so the spacing assertion is exact: 15 bps of 100e9 = 150_000_000.
    const rungs = ladderRungs(100_000_000_000n, 3_000_000n, 'bid', EMPTY, CTX, L3);
    expect(rungs.map((r) => r.px)).toEqual([
      100_000_000_000n,
      99_850_000_000n,
      99_700_000_000n,
    ]);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i - 1]!.px - rungs[i]!.px).toBe(150_000_000n);
      expect(rungs[i]!.sz).toBeLessThan(rungs[i - 1]!.sz); // decays outward
    }
    const posted = rungs.reduce((sum, r) => sum + r.sz, 0n);
    expect(posted).toBeLessThanOrEqual(3_000_000n);
    expect(posted).toBeGreaterThan(2_990_000n); // only lot-flooring is lost
  });

  it('decayBps = 0 is a FLAT ladder; decayBps = 10_000 puts everything on rung 0', () => {
    const flat = ladderRungs(100_000_000_000n, 3_000_000n, 'bid', EMPTY, CTX, {
      levels: 3,
      stepBps: 15,
      decayBps: 0,
    });
    expect(flat.map((r) => r.sz)).toEqual([1_000_000n, 1_000_000n, 1_000_000n]);

    const front = ladderRungs(100_000_000_000n, 3_000_000n, 'bid', EMPTY, CTX, {
      levels: 3,
      stepBps: 15,
      decayBps: 10_000,
    });
    expect(front).toHaveLength(1);
    expect(front[0]!.sz).toBe(3_000_000n);
  });

  it('GRANULARITY: a rung that cannot clear min_size is NOT emitted (never an illegal order)', () => {
    // 300_000 sats over 3 decaying rungs ⇒ 136_986 / 95_890 / 67_123 — only the first is legal.
    const rungs = ladderRungs(99_700_000_500n, 300_000n, 'bid', TWO_SIDED, CTX, L3);
    expect(rungs).toEqual([
      { side: 'bid', px: 99_700_000_000n, sz: 136_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
    for (const r of rungs) expect(isAligned(r.px, r.sz, VENUE)).toBe(true);
    // Below min_size on EVERY rung ⇒ nothing at all, rather than a rejected transaction.
    expect(ladderRungs(99_700_000_500n, 99_999n, 'bid', TWO_SIDED, CTX, L3)).toEqual([]);
  });

  it('every rung of a full route() plan is tick/lot/min_size legal (invariant 3)', () => {
    const plan = route(decision(), TWO_SIDED, LADDER_CTX);
    expect(plan.makerOrders).toHaveLength(6);
    for (const o of [...plan.makerOrders, ...plan.iocOrders]) {
      expect(isAligned(o.px, o.sz, VENUE)).toBe(true);
    }
    // The IOC split is unchanged by laddering — it is a function of the decided size, not the shape.
    expect(plan.iocOrders).toEqual([{ side: 'bid', px: 100_200_000_000n, sz: 734_000n, ioc: true }]);
  });

  it('NON-CROSSING on a ONE-SIDED book: asks are empty, so no bid rung can be clamped', () => {
    const plan = route(decision(), ONE_SIDED, LADDER_CTX);
    const { bestBid } = topOfBook(ONE_SIDED);
    for (const o of plan.makerOrders) {
      if (o.side === 'ask') expect(o.px).toBeGreaterThan(bestBid!); // never crosses the resting bid
    }
    expect(plan.makerOrders.filter((o) => o.side === 'bid')).toHaveLength(3);
    expect(plan.makerOrders.filter((o) => o.side === 'ask')).toHaveLength(3);
  });

  it('NON-CROSSING on a CROSSED book: every rung is clamped, and the clamped duplicates MERGE', () => {
    // Bid base 103e9 is above the best ask 99e9 ⇒ all three rungs clamp onto the same legal tick,
    // and they are merged into ONE order rather than three competing orders at one price.
    const rungs = ladderRungs(103_000_000_000n, 1_234_567n, 'bid', CROSSED, CTX, L3);
    expect(rungs).toEqual([
      { side: 'bid', px: 98_999_000_000n, sz: 1_233_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
    expect(rungs[0]!.px).toBeLessThan(99_000_000_000n); // strictly below the best ask

    const asks = ladderRungs(98_000_000_000n, 1_234_567n, 'ask', CROSSED, CTX, L3);
    for (const o of asks) expect(o.px).toBeGreaterThan(102_000_000_000n); // above the best bid
  });

  it('an EMPTY book ladders freely — nothing rests, so nothing clamps', () => {
    const plan = route(decision(), EMPTY, { ...CTX, ladder: L3 });
    expect(plan.iocOrders).toEqual([]);
    expect(plan.makerOrders.filter((o) => o.side === 'bid').map((o) => o.px)).toEqual([
      99_700_000_000n,
      99_550_000_000n,
      99_400_000_000n,
    ]);
    expect(plan.makerOrders.filter((o) => o.side === 'ask').map((o) => o.px)).toEqual([
      100_301_000_000n,
      100_451_000_000n,
      100_601_000_000n,
    ]);
  });

  it('levels = 1 reproduces the classic single maker level EXACTLY (backward compatibility)', () => {
    const single = route(decision(), TWO_SIDED, { ...CTX, ladder: { levels: 1, stepBps: 15, decayBps: 3_000 } });
    expect(single).toEqual(route(decision(), TWO_SIDED, CTX));
  });

  it('clamps a nonsense level count to MAX_LADDER_LEVELS instead of building an unbounded PTB', () => {
    const rungs = ladderRungs(100_000_000_000n, 80_000_000n, 'bid', EMPTY, CTX, {
      levels: 99,
      stepBps: 15,
      decayBps: 0,
    });
    expect(MAX_LADDER_LEVELS).toBe(8);
    expect(rungs).toHaveLength(8);
    expect(rungs.every((r) => r.sz === 10_000_000n)).toBe(true);
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]!.px).toBeLessThan(rungs[i - 1]!.px);
  });

  it('ladderSpec lifts the geometry out of the encrypted parameter set, clamping as it goes', () => {
    expect(ladderSpec({ ladderLevels: 3, ladderStepBps: 15, ladderDecayBps: 3_000 })).toEqual(L3);
    expect(ladderSpec({ ladderLevels: 0, ladderStepBps: -5, ladderDecayBps: 99_999 })).toEqual({
      levels: 1,
      stepBps: 0,
      decayBps: 10_000,
    });
  });

  it('a zero/absent base price or size ladders nothing — total, never a throw (invariant 1)', () => {
    expect(ladderRungs(0n, 1_000_000n, 'bid', TWO_SIDED, CTX, L3)).toEqual([]);
    expect(ladderRungs(99_700_000_500n, 0n, 'bid', TWO_SIDED, CTX, L3)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/route — DETERMINISTIC time slicing (the index is an INPUT, never a clock)', () => {
  const L3: LadderSpec = { levels: 3, stepBps: 15, decayBps: 3_000 };

  it('sliceOf partitions the total: Σ slices <= total, every slice lot-aligned', () => {
    const slices = [0, 1, 2, 3].map((index) => sliceOf(1_234_567n, { index, count: 4 }, VENUE));
    expect(slices).toEqual([308_000n, 308_000n, 308_000n, 308_000n]);
    const sum = slices.reduce((a, b) => a + b, 0n);
    expect(sum).toBeLessThanOrEqual(1_234_567n);
    expect(sum).toBeGreaterThan(1_234_567n - 4n * LOT);
  });

  it('count = 1 is the identity, and a slice below min_size is dropped rather than sent illegal', () => {
    expect(sliceOf(1_234_567n, { index: 0, count: 1 }, VENUE)).toBe(1_234_000n);
    expect(sliceOf(0n, { index: 0, count: 4 }, VENUE)).toBe(0n);
    // 300_000 / 4 = 75_000 < min_size 100_000 ⇒ nothing legal to send this slice.
    expect(sliceOf(300_000n, { index: 2, count: 4 }, VENUE)).toBe(0n);
  });

  it('a raw cursor index wraps into [0, count) — a caller may pass a sequence number directly', () => {
    expect(sliceOf(1_234_567n, { index: 9, count: 4 }, VENUE)).toBe(
      sliceOf(1_234_567n, { index: 1, count: 4 }, VENUE),
    );
    expect(sliceOf(1_234_567n, { index: -1, count: 4 }, VENUE)).toBe(
      sliceOf(1_234_567n, { index: 3, count: 4 }, VENUE),
    );
    // A nonsense count degrades to "do not slice" rather than dividing by zero.
    expect(sliceOf(1_234_567n, { index: 0, count: 0 }, VENUE)).toBe(1_234_000n);
  });

  it('route() works only THIS slice, shrinking the footprint below the passive queue', () => {
    const plan = route(decision(), TWO_SIDED, { ...CTX, slice: { index: 1, count: 4 } });
    expect(plan.makerOrders).toEqual([
      { side: 'bid', px: 99_700_000_000n, sz: 308_000n, expireTs: CTX.expireTs, postOnly: true },
      { side: 'ask', px: 100_301_000_000n, sz: 112_000n, expireTs: CTX.expireTs, postOnly: true },
    ]);
    // A quarter of the size now fits behind the resting queue ⇒ nothing has to cross.
    expect(plan.iocOrders).toEqual([]);
  });

  it('slicing composes with the ladder: this slice is what gets laddered', () => {
    const plan = route(decision(), EMPTY, { ...CTX, ladder: L3, slice: { index: 0, count: 4 } });
    // Slice 0 of 1_234_567 is 308_000 sats; laddered 100/70/49 that is 140_639 / 98_447 / 68_913,
    // and only the first rung clears min_size — the other two are dropped, not shrunk into legality.
    const bids = plan.makerOrders.filter((o) => o.side === 'bid');
    expect(bids.map((o) => o.sz)).toEqual([140_000n]);
    expect(bids.reduce((a, o) => a + o.sz, 0n)).toBeLessThanOrEqual(308_000n);
    // The ask slice (112_000) cannot support ANY legal rung at a 30 % decay ⇒ nothing is posted.
    expect(plan.makerOrders.filter((o) => o.side === 'ask')).toEqual([]);
    for (const o of plan.makerOrders) expect(isAligned(o.px, o.sz, VENUE)).toBe(true);
  });

  it('derisk is NEVER sliced — getting flat is not something you work in slices', () => {
    const sliced = route(decision({ action: 'derisk' }), TWO_SIDED, {
      ...CTX,
      slice: { index: 0, count: 4 },
    });
    expect(sliced).toEqual(route(decision({ action: 'derisk' }), TWO_SIDED, CTX));
  });

  it('a plan is BYTE-identical across two identical runs — ladder and slice included (G5)', () => {
    const ctx: RouteContext = { ...CTX, ladder: L3, slice: { index: 2, count: 4 } };
    const encode = (p: ReturnType<typeof route>): string =>
      JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

    const a = encode(route(decision(), TWO_SIDED, ctx));
    const b = encode(route(decision(), TWO_SIDED, ctx));
    expect(a).toBe(b);
    expect(a).toBe(encode(route(decision(), TWO_SIDED, { ...ctx })));
    // …and a DIFFERENT slice really is a different plan (the schedule is not decorative).
    expect(encode(route(decision(), TWO_SIDED, { ...ctx, slice: { index: 0, count: 2 } }))).not.toBe(a);
  });

  it('omitting ladder + slice leaves route() exactly as it was before T2.7 (no silent behaviour change)', () => {
    expect(route(decision(), TWO_SIDED, { ...CTX, ladder: undefined, slice: undefined })).toEqual(
      route(decision(), TWO_SIDED, CTX),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/deepbook — the L2 read (E-K6: get_level2_range, never mid_price)', () => {
  it('builds a simulation moveCall against the CALLABLE package with the right type args', () => {
    const tx = buildLevel2RangeTx(cfg, {
      priceLow: DEEPBOOK_MIN_PRICE,
      priceHigh: DEEPBOOK_MAX_PRICE,
      isBid: true,
    });
    const commands = tx.getData().commands;
    expect(commands).toHaveLength(1);

    const call = commands[0]?.MoveCall;
    expect(call).toBeDefined();
    expect(call?.package).toBe(cfg.deepbook.packageId);
    expect(call?.module).toBe('pool');
    expect(call?.function).toBe('get_level2_range');
    expect(call?.typeArguments).toEqual([cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType]);
    // pool, price_low, price_high, is_bid, clock
    expect(call?.arguments).toHaveLength(5);
  });

  it('pins the DeepBook price bounds to deepbook::constants (MIN 1, MAX (1<<63)-1)', () => {
    expect(DEEPBOOK_MIN_PRICE).toBe(1n);
    expect(DEEPBOOK_MAX_PRICE).toBe(9_223_372_036_854_775_807n);
  });

  it('decodes the two vector<u64> returns to bigint (invariant 3)', () => {
    const vec = bcs.vector(bcs.u64());
    const prices = vec.serialize([99_800_000_000n, 99_600_000_000n]).toBytes();
    const quantities = vec.serialize([300_000n, 200_000n]).toBytes();
    expect(decodeLevel2Range([prices, quantities])).toEqual({
      prices: [99_800_000_000n, 99_600_000_000n],
      quantities: [300_000n, 200_000n],
    });
  });

  it('an EMPTY side decodes to ([], []) — a valid result, never an exception (invariant 2)', () => {
    const vec = bcs.vector(bcs.u64());
    const empty = vec.serialize([]).toBytes();
    expect(decodeLevel2Range([empty, empty])).toEqual({ prices: [], quantities: [] });
    expect(decodeLevel2Range([])).toEqual({ prices: [], quantities: [] });
  });

  it('rejects a decode whose price/quantity vectors disagree in length', () => {
    const vec = bcs.vector(bcs.u64());
    expect(() =>
      decodeLevel2Range([vec.serialize([1n, 2n]).toBytes(), vec.serialize([1n]).toBytes()]),
    ).toThrow(AphoticError);
  });

  it('assembleBook sorts bids DESC / asks ASC, drops empty levels, and derives the mid', () => {
    const assembled = assembleBook(
      cfg,
      { prices: [99_600_000_000n, 99_800_000_000n], quantities: [200_000n, 300_000n] },
      { prices: [100_400_000_000n, 100_200_000_000n, 105_000_000_000n], quantities: [150_000n, 250_000n, 0n] },
      1_700_000_000_000,
    );

    expect(assembled.bids.map((l) => l.px)).toEqual([99_800_000_000n, 99_600_000_000n]);
    expect(assembled.asks.map((l) => l.px)).toEqual([100_200_000_000n, 100_400_000_000n]);
    expect(assembled.mid).toBe(100_000_000_000n);
    expect(assembled.poolId).toBe(cfg.deepbook.poolId);
    expect(assembled.atMs).toBe(1_700_000_000_000); // caller-supplied (invariant 4)
  });

  it('assembleBook on the CURRENT testnet reality (both sides empty) yields mid 0n, not a throw', () => {
    const assembled = assembleBook(cfg, { prices: [], quantities: [] }, { prices: [], quantities: [] }, 5);
    expect(assembled.bids).toEqual([]);
    expect(assembled.asks).toEqual([]);
    expect(assembled.mid).toBe(0n);
    expect(bookMid(assembled)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('routing/taker — the deterministic book seeder (a hard requirement, R10)', () => {
  const OPTS: TakerScriptOptions = {
    seed: 'aphotic-demo-0',
    startMs: 1_700_000_000_000,
    intervalMs: 5_000,
    steps: 9,
    anchorPx: 100_000_000_000n,
    widthBps: 40,
    stepSats: 250_000n,
    venue: VENUE,
  };

  it('same seed ⇒ byte-identical script (invariant 2: rehearsal == demo)', () => {
    expect(buildTakerScript(OPTS)).toEqual(buildTakerScript(OPTS));
  });

  it('a different seed produces a different script', () => {
    const other = buildTakerScript({ ...OPTS, seed: 'aphotic-demo-1' });
    expect(other).not.toEqual(buildTakerScript(OPTS));
    expect(other.seed).toBe('aphotic-demo-1');
  });

  it('emits steps in non-decreasing atMs order (invariant 4)', () => {
    const { steps } = buildTakerScript(OPTS);
    expect(steps).toHaveLength(9);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.atMs).toBeGreaterThanOrEqual(steps[i - 1]!.atMs);
    }
    expect(steps[0]!.atMs).toBe(OPTS.startMs);
  });

  it('every generated price is tick-aligned and every size lot-aligned & >= min_size (invariant 3)', () => {
    for (const step of buildTakerScript(OPTS).steps) {
      expect(isAligned(step.px, step.sz, VENUE)).toBe(true);
    }
  });

  it('the maker steps seed BOTH sides, so bookMid is defined for NAV (@ac)', () => {
    const { steps } = buildTakerScript(OPTS);
    const makers = steps.filter((s) => s.kind === 'maker');
    const seeded = book(
      makers.filter((s) => s.side === 'bid').map((s) => ({ px: s.px, sz: s.sz })),
      makers.filter((s) => s.side === 'ask').map((s) => ({ px: s.px, sz: s.sz })),
    );
    expect(seeded.bids.length).toBeGreaterThan(0);
    expect(seeded.asks.length).toBeGreaterThan(0);
    expect(bookMid(seeded)).toBeDefined();
    expect(isCrossed(seeded)).toBe(false); // bids sit below the anchor, asks above it
  });

  it('the crossing legs alternate side so both sides of the seeded book get traded', () => {
    const takers = buildTakerScript(OPTS).steps.filter((s) => s.kind === 'taker');
    expect(takers).toHaveLength(3);
    expect(takers.map((s) => s.side)).toEqual(['bid', 'ask', 'bid']);
  });

  it('refuses a step size that cannot clear min_size — a silent no-op script would leave NAV undefined', () => {
    expect(() => buildTakerScript({ ...OPTS, stepSats: 99_000n })).toThrow(RangeError);
    expect(() => buildTakerScript({ ...OPTS, anchorPx: 999n })).toThrow(RangeError);
    expect(() => buildTakerScript({ ...OPTS, steps: -1 })).toThrow(RangeError);
  });

  it('stepsDue slices the half-open window [fromMs, toMs)', () => {
    const script = buildTakerScript(OPTS);
    const t0 = OPTS.startMs;
    expect(stepsDue(script, t0, t0 + 5_000).map((s) => s.atMs)).toEqual([t0]);
    expect(stepsDue(script, t0, t0 + 15_000).map((s) => s.atMs)).toEqual([t0, t0 + 5_000, t0 + 10_000]);
    // The last of the 9 steps sits at t0 + 40_000; nothing is due after it.
    expect(stepsDue(script, t0 + 40_000, t0 + 45_000).map((s) => s.atMs)).toEqual([t0 + 40_000]);
    expect(stepsDue(script, t0 + 45_000, t0 + 90_000)).toEqual([]);
    expect(stepsDue(script, t0, t0)).toEqual([]);
    expect(stepsDue(script, t0 + 100, t0)).toEqual([]);
  });

  it('stepToPlan turns a maker step into ONE non-crossing POST_ONLY order', () => {
    const step = buildTakerScript(OPTS).steps.find((s) => s.kind === 'maker' && s.side === 'bid');
    if (step === undefined) throw new Error('fixture: expected a maker bid step');
    const plan = stepToPlan(step, TWO_SIDED, CTX);

    expect(plan.iocOrders).toEqual([]);
    expect(plan.cancels).toEqual([]);
    expect(plan.makerOrders).toHaveLength(1);
    const order = plan.makerOrders[0]!;
    expect(order.postOnly).toBe(true);
    expect(order.expireTs).toBe(CTX.expireTs);
    expect(order.px < 100_200_000_000n).toBe(true); // strictly below the best ask
  });

  it('stepToPlan turns a taker step into ONE IOC order, capped by maxIocSats', () => {
    const step = buildTakerScript(OPTS).steps.find((s) => s.kind === 'taker');
    if (step === undefined) throw new Error('fixture: expected a taker step');
    const plan = stepToPlan(step, TWO_SIDED, { ...CTX, maxIocSats: 200_000n });

    expect(plan.makerOrders).toEqual([]);
    expect(plan.iocOrders).toHaveLength(1);
    expect(plan.iocOrders[0]!.ioc).toBe(true);
    expect(plan.iocOrders[0]!.sz).toBe(200_000n);
  });

  it('stepToPlan emits nothing when the step cannot satisfy the venue', () => {
    const step = { atMs: 0, side: 'bid' as const, px: 100_000_000_000n, sz: 1n, kind: 'maker' as const };
    expect(stepToPlan(step, TWO_SIDED, CTX)).toEqual({ makerOrders: [], iocOrders: [], cancels: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/trade — the router PTB (G2: TradeCap only, G4: DeepBook only)', () => {
  const id = (fill: string) => `0x${fill.repeat(32)}`;
  const tradeCfg = testConfig({
    APHOTIC_PACKAGE_ID: id('a1'),
    VAULT_ID: id('b2'),
    BALANCE_MANAGER_ID: id('c3'),
    TRADE_CAP_ID: id('d4'),
    SUI_KEEPER_ADDRESS: id('e5'),
  });

  const tradeCtx: TradeContext = {
    vaultId: tradeCfg.aphotic.vaultId,
    keeperCapId: id('f6'),
    bookMid: 100_000_000_000n,
    oracleMid: 100_100_000_000n,
    expireTs: 1_700_000_015_000,
    pendingExitDemandSats: 1_000_000n,
    projectedCapacitySats: 10_000_000_000n,
    clientOrderIdBase: 100n,
  };

  function callsOf(tx: ReturnType<typeof buildTradeTx>) {
    return tx.getData().commands.map((c) => c.MoveCall);
  }

  it('compiles cancels FIRST, then POST_ONLY makers, then the IOC residual (invariant 4)', () => {
    const plan = route(decision({ cancels: [11n, 12n] }), TWO_SIDED, CTX);
    const calls = callsOf(buildTradeTx(tradeCfg, plan, tradeCtx));

    expect(calls.map((c) => c?.function)).toEqual([
      'cancel_maker',
      'cancel_maker',
      'place_maker',
      'place_maker',
      'sweep_ioc',
    ]);
  });

  it('targets aphotic::router — never deepbook::pool directly (every venue touch is envelope-gated)', () => {
    const calls = callsOf(buildTradeTx(tradeCfg, route(decision(), TWO_SIDED, CTX), tradeCtx));
    for (const call of calls) {
      expect(call?.package).toBe(tradeCfg.aphotic.packageId);
      expect(call?.module).toBe('router');
      expect(call?.typeArguments).toEqual([
        tradeCfg.hashi.hbtcCoinType,
        tradeCfg.deepbook.dbusdcCoinType,
      ]);
    }
  });

  it('place_maker carries the full router argument list (18 args incl. clock)', () => {
    const plan = route(decision(), TWO_SIDED, CTX);
    const calls = callsOf(buildTradeTx(tradeCfg, plan, tradeCtx));
    const maker = calls.find((c) => c?.function === 'place_maker');
    const ioc = calls.find((c) => c?.function === 'sweep_ioc');
    const cancel = callsOf(buildCancelTx(tradeCfg, [11n], tradeCtx))[0];

    expect(maker?.arguments).toHaveLength(18);
    expect(ioc?.arguments).toHaveLength(17);
    expect(cancel?.arguments).toHaveLength(7);
  });

  it('derives client_order_id deterministically from the base + command index (invariant 5)', () => {
    const plan = route(decision({ cancels: [11n] }), TWO_SIDED, CTX);
    const a = buildTradeTx(tradeCfg, plan, tradeCtx);
    const b = buildTradeTx(tradeCfg, plan, tradeCtx);
    expect(JSON.stringify(a.getData())).toBe(JSON.stringify(b.getData()));
  });

  it('REFUSES to build an unaligned order — the granularity check happens BEFORE signing (invariant 3)', () => {
    const bad = {
      makerOrders: [
        { side: 'bid' as const, px: 100_000_000_001n, sz: 100_000n, expireTs: 1, postOnly: true as const },
      ],
      iocOrders: [],
      cancels: [],
    };
    expect(() => buildTradeTx(tradeCfg, bad, tradeCtx)).toThrow(AphoticError);
    expect(() => buildTradeTx(tradeCfg, bad, tradeCtx)).toThrow(/violates tick/);
  });

  it('refuses to build anything before the aphotic package and the TradeCap ids are known', () => {
    expect(() => buildTradeTx(cfg, route(decision(), TWO_SIDED, CTX), tradeCtx)).toThrow(ConfigError);
  });

  it('an empty plan compiles to an empty PTB — never a stray command', () => {
    const tx = buildTradeTx(tradeCfg, { makerOrders: [], iocOrders: [], cancels: [] }, tradeCtx);
    expect(tx.getData().commands).toHaveLength(0);
  });

  it('decodes the router receipts from event BCS (never from the transport-dependent json)', () => {
    const MakerPlaced = bcs.struct('MakerPlaced', {
      vault_id: bcs.Address,
      order_id: bcs.u128(),
      is_bid: bcs.bool(),
      price: bcs.u64(),
      quantity: bcs.u64(),
    });
    const IocSwept = bcs.struct('IocSwept', {
      vault_id: bcs.Address,
      is_bid: bcs.bool(),
      filled_qty: bcs.u64(),
      avg_price: bcs.u64(),
    });
    const MakerCancelled = bcs.struct('MakerCancelled', {
      vault_id: bcs.Address,
      order_id: bcs.u128(),
    });

    const outcomes = decodeRouterEvents([
      {
        eventType: `${tradeCfg.aphotic.packageId}::router::MakerCancelled`,
        bcs: MakerCancelled.serialize({ vault_id: tradeCtx.vaultId, order_id: 11n }).toBytes(),
      },
      {
        eventType: `${tradeCfg.aphotic.packageId}::router::MakerPlaced`,
        bcs: MakerPlaced.serialize({
          vault_id: tradeCtx.vaultId,
          order_id: 77n,
          is_bid: true,
          price: 99_700_000_000n,
          quantity: 1_234_000n,
        }).toBytes(),
      },
      {
        eventType: `${tradeCfg.aphotic.packageId}::router::IocSwept`,
        bcs: IocSwept.serialize({
          vault_id: tradeCtx.vaultId,
          is_bid: true,
          filled_qty: 0n,
          avg_price: 0n,
        }).toBytes(),
      },
      { eventType: '0x2::coin::Something', bcs: new Uint8Array([0]) },
    ]);

    expect(outcomes).toEqual([
      { kind: 'cancel', orderId: 11n },
      { kind: 'maker', orderId: 77n, avgPx: 99_700_000_000n },
      { kind: 'ioc', filledSats: 0n, avgPx: 0n, skipped: 'ioc-unfilled' },
    ]);
  });
});
