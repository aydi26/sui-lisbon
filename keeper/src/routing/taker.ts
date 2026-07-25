// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL — the seeder is a HARD requirement, not a demo aid]
// @status     DONE
// @spec       docs/RECON.md#r10 (zero volume; both sides empty — `book_mid` has nothing to read)
// @spec       docs/FACTS.md#deepbook-venue ("Book reality"), #unknowns U8 (scripted second account)
// @spec       docs/KEEPER.md ERRATA E-K13 ("the book seeder is now a hard requirement")
// @spec       docs/BUILD-PLAN.md CUT LINE item 2 ("scripted taker fills for the demo")
// @rules      G4 G6 G7 G9
// @depends    ./book.ts (T2.7) · ./route.ts (T2.7) · ../types.ts · ../util/rng.ts
// @facts      ★ WHY THIS FILE EXISTS: the hBTC/DBUSDC book shows ZERO volume and BOTH sides are
// @facts        EMPTY. NAV is valued at the DeepBook mid (G9), so with no book there is no mid,
// @facts        no NAV, and nothing for the maker quote to sit against. A scripted counterparty
// @facts        seeds it. That account is NOT optional (docs/FACTS.md#deepbook-venue).
// @facts      ★★ THE SEEDER RUNS UNDER A SEPARATE ACCOUNT — never the keeper key, never the vault's
// @facts        BalanceManager. If the vault traded against itself, DeepBook self-match prevention
// @facts        would cancel one leg and the "fills" would be theatre. Two accounts, always.
// @facts      ⚠ hBTC CANNOT BE MINTED BY US — seeding the BASE side needs a real signet deposit
// @facts        through Hashi (~70 min, G6). Pre-stage it; start the faucet drip early (U6).
// @facts      Venue rules still apply: tick 1_000_000 · lot 1_000 · min_size 100_000; maker legs are
// @facts        POST_ONLY (3), crossing legs are IOC (1). Same pool only (G4).
// @facts      DEMO HONESTY (G8): the fills are SCRIPTED. Say so. The verifiable claims are the
// @facts        pinned exit, the trustless limiter replay and the permissionless crank — not volume.
// @facts      Deterministic by construction: the script is generated from a SEED (../util/rng.ts),
// @facts        so a rehearsal and the live run produce the same sequence.
// @facts      SCRIPT SHAPE: a repeating 3-slot cycle — maker BID below the anchor, maker ASK above
// @facts        it, then ONE crossing IOC whose side alternates each cycle. Two steps in, the book
// @facts        is two-sided and `bookMid` is defined, which is the whole point (@ac).
// @implements export interface TakerScriptOptions / TakerStep / TakerScript
// @implements export function buildTakerScript(opts: TakerScriptOptions): TakerScript
// @implements export function stepToPlan(step: TakerStep, book: L2Book, ctx: RouteContext): Plan
// @implements export function stepsDue(script: TakerScript, fromMs: Millis, toMs: Millis): readonly TakerStep[]
// @forbidden  signing any of this with KEEPER_KEY or OWNER_KEY — separate seeder account only (G2)
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — seeded RNG only
// @forbidden  presenting scripted fills as organic volume (G8)
// @forbidden  any non-DeepBook venue leg, and any concentrated-liquidity range logic (G4, gates.ps1 g4)
// @invariant  1. PURE: script generation and step selection take every input as an argument.
// @invariant  2. Same seed ⇒ byte-identical script (rehearsal == demo).
// @invariant  3. Every generated price is tick-aligned; every size lot-aligned and >= min_size.
// @invariant  4. Steps are emitted in non-decreasing `atMs` order.
// @ac         a seeded script produces a two-sided book so `bookMid` is defined for NAV
// @verify     npm run test -- routing
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Bps, L2Book, MakerOrder, Millis, Plan, Sats, Side } from '../types.js';
import { createRng } from '../util/rng.js';

import { alignPrice, alignSize, BPS_DENOMINATOR, type VenueParams } from './book.js';
import { nonCrossingMakerPrice, type RouteContext } from './route.js';

/** Size jitter, in lots, drawn from the seeded RNG. Bounded so the script stays legible. */
const MAX_SIZE_JITTER_LOTS = 4;

export interface TakerScriptOptions {
  /** Deterministic seed (../util/rng.ts SplitMix64). Same seed ⇒ same script. */
  readonly seed: string;
  /** Logical start of the script (ms epoch). */
  readonly startMs: Millis;
  /** Gap between steps, ms. */
  readonly intervalMs: Millis;
  /** Number of steps to generate. */
  readonly steps: number;
  /** Reference price to build the seeded book around (tick-scaled). */
  readonly anchorPx: bigint;
  /** Half-width of the seeded book around the anchor, bps. */
  readonly widthBps: Bps;
  /** Per-step size, sats. Lot-aligned and >= min_size. */
  readonly stepSats: Sats;
  /**
   * Venue granularity the generated prices/sizes must satisfy (invariant 3). Injected rather
   * than baked in: DeepBook admins can adjust a pool's tick/lot at runtime (G7 / router.move V5).
   */
  readonly venue: VenueParams;
}

export interface TakerStep {
  readonly atMs: Millis;
  readonly side: Side;
  readonly px: bigint;
  readonly sz: Sats;
  /** `maker` seeds resting depth (POST_ONLY); `taker` crosses it (IOC) to produce a fill. */
  readonly kind: 'maker' | 'taker';
}

export interface TakerScript {
  readonly seed: string;
  readonly steps: readonly TakerStep[];
}

/**
 * Generate the deterministic seeding/fill script. PURE.
 *
 * Throws when the requested `stepSats`/`anchorPx` cannot satisfy the venue's granularity — a
 * script that silently degenerates to zero-size steps would seed nothing and leave NAV undefined,
 * which is exactly the failure this file exists to prevent.
 */
export function buildTakerScript(opts: TakerScriptOptions): TakerScript {
  const { tickSize, lotSize, minSize } = opts.venue;

  if (!Number.isInteger(opts.steps) || opts.steps < 0) {
    throw new RangeError(`buildTakerScript: steps must be a non-negative integer, got ${opts.steps}`);
  }
  if (alignSize(opts.stepSats, lotSize, minSize) === 0n) {
    throw new RangeError(
      `buildTakerScript: stepSats ${opts.stepSats} is below min_size ${minSize} after lot alignment`,
    );
  }
  if (alignPrice(opts.anchorPx, tickSize, 'bid') === 0n) {
    throw new RangeError(
      `buildTakerScript: anchorPx ${opts.anchorPx} is below one tick ${tickSize}`,
    );
  }

  const rng = createRng(opts.seed);
  const width = Math.max(1, Math.trunc(opts.widthBps));
  const steps: TakerStep[] = [];

  for (let i = 0; i < opts.steps; i++) {
    const atMs = opts.startMs + i * opts.intervalMs;
    const slot = i % 3;
    const cycle = Math.floor(i / 3);

    // Both draws happen on EVERY iteration, in the same order, so the stream never depends on
    // which branch is taken — that is what makes invariant 2 hold across option changes.
    const jitterBps = 1 + rng.nextInt(width);
    const jitterLots = BigInt(rng.nextInt(MAX_SIZE_JITTER_LOTS));

    const sz = alignSize(opts.stepSats + jitterLots * lotSize, lotSize, minSize);
    if (sz === 0n) continue;

    if (slot === 0) {
      // Maker BID, one jittered band below the anchor. Rounded DOWN — away from the spread.
      const px = alignPrice(opts.anchorPx - offset(opts.anchorPx, jitterBps), tickSize, 'bid');
      if (px > 0n) steps.push({ atMs, side: 'bid', px, sz, kind: 'maker' });
      continue;
    }

    if (slot === 1) {
      // Maker ASK, one jittered band above the anchor. Rounded UP — away from the spread.
      const px = alignPrice(opts.anchorPx + offset(opts.anchorPx, jitterBps), tickSize, 'ask');
      if (px > 0n) steps.push({ atMs, side: 'ask', px, sz, kind: 'maker' });
      continue;
    }

    // Crossing leg. Side alternates per cycle so both sides of the seeded book get traded.
    const side: Side = cycle % 2 === 0 ? 'bid' : 'ask';
    const px =
      side === 'bid'
        ? alignPrice(opts.anchorPx + offset(opts.anchorPx, width), tickSize, 'ask')
        : alignPrice(opts.anchorPx - offset(opts.anchorPx, width), tickSize, 'bid');
    if (px > 0n) steps.push({ atMs, side, px, sz, kind: 'taker' });
  }

  return { seed: opts.seed, steps };
}

/**
 * Steps whose `atMs` falls in `[fromMs, toMs)`. PURE.
 *
 * Binary search on both ends — the script is emitted in non-decreasing `atMs` order (invariant 4),
 * so the window is a contiguous slice.
 */
export function stepsDue(
  script: TakerScript,
  fromMs: Millis,
  toMs: Millis,
): readonly TakerStep[] {
  if (toMs <= fromMs) return [];
  const start = lowerBound(script.steps, fromMs);
  const end = lowerBound(script.steps, toMs);
  return script.steps.slice(start, end);
}

/**
 * Turn one script step into a `Plan` for the SEEDER account to execute.
 *
 * ⚠ The caller must submit this with the seeder's key — never the keeper's (G2).
 *
 * A `maker` step is clamped so it rests passively against whatever is already on the book (a
 * POST_ONLY order that crosses aborts `EPOSTOrderCrossesOrderbook`). A `taker` step keeps its
 * scripted limit price — crossing is the entire point of that leg — capped by `ctx.maxIocSats`.
 */
export function stepToPlan(step: TakerStep, book: L2Book, ctx: RouteContext): Plan {
  if (step.kind === 'maker') {
    const sz = alignSize(step.sz, ctx.lotSize, ctx.minSize);
    const px = nonCrossingMakerPrice(step.px, step.side, book, ctx.tickSize);
    if (sz === 0n || px <= 0n) return { makerOrders: [], iocOrders: [], cancels: [] };
    const order: MakerOrder = { side: step.side, px, sz, expireTs: ctx.expireTs, postOnly: true };
    return { makerOrders: [order], iocOrders: [], cancels: [] };
  }

  const capped = step.sz < ctx.maxIocSats ? step.sz : ctx.maxIocSats;
  const sz = alignSize(capped, ctx.lotSize, ctx.minSize);
  // A crossing bid needs a CEILING price and a crossing ask a FLOOR — round away from the mid.
  const px = alignPrice(step.px, ctx.tickSize, step.side === 'bid' ? 'ask' : 'bid');
  if (sz === 0n || px <= 0n) return { makerOrders: [], iocOrders: [], cancels: [] };
  return { makerOrders: [], iocOrders: [{ side: step.side, px, sz, ioc: true }], cancels: [] };
}

// ── internals (all pure) ─────────────────────────────────────────────────────

function offset(anchorPx: bigint, bps: number): bigint {
  return (anchorPx * BigInt(bps)) / BPS_DENOMINATOR;
}

/** First index whose `atMs >= target`. */
function lowerBound(steps: readonly TakerStep[], target: Millis): number {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const step = steps[mid];
    if (step !== undefined && step.atMs < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
