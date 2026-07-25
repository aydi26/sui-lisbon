// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL — the seeder is a HARD requirement, not a demo aid]
// @status     STUB
// @spec       docs/RECON.md#r10 (zero volume; both sides empty — `book_mid` has nothing to read)
// @spec       docs/FACTS.md#deepbook-venue ("Book reality"), #unknowns U8 (scripted second account)
// @spec       docs/KEEPER.md ERRATA E-K13 ("the book seeder is now a hard requirement")
// @spec       docs/BUILD-PLAN.md CUT LINE item 2 ("scripted taker fills for the demo")
// @rules      G4 G6 G7 G9
// @depends    ./book.ts (T2.7) · ./route.ts (T2.7) · ../types.ts
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
// @implements export interface TakerScriptOptions / TakerStep / TakerScript
// @implements export function buildTakerScript(opts: TakerScriptOptions): TakerScript
// @implements export function stepToPlan(step: TakerStep, book: L2Book, ctx: RouteContext): Plan
// @implements export function stepsDue(script: TakerScript, fromMs: Millis, toMs: Millis): readonly TakerStep[]
// @forbidden  signing any of this with KEEPER_KEY or OWNER_KEY — separate seeder account only (G2)
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — seeded RNG only
// @forbidden  presenting scripted fills as organic volume (G8)
// @forbidden  cetus / clmm anything (G4, gates.ps1 g4)
// @invariant  1. PURE: script generation and step selection take every input as an argument.
// @invariant  2. Same seed ⇒ byte-identical script (rehearsal == demo).
// @invariant  3. Every generated price is tick-aligned; every size lot-aligned and >= min_size.
// @invariant  4. Steps are emitted in non-decreasing `atMs` order.
// @ac         a seeded script produces a two-sided book so `bookMid` is defined for NAV
// @verify     npm run test -- routing
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { L2Book, Millis, Plan, Sats, Side } from '../types.js';

import type { RouteContext } from './route.js';

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
  readonly widthBps: number;
  /** Per-step size, sats. Lot-aligned and >= min_size. */
  readonly stepSats: Sats;
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

/** Generate the deterministic seeding/fill script. PURE. */
// TODO(T2.7): createRng(opts.seed); alternate maker depth around anchorPx then taker crossings;
//             align every price/size; emit steps in non-decreasing atMs order.
export function buildTakerScript(_opts: TakerScriptOptions): TakerScript {
  throw new Error('TODO(T2.7): buildTakerScript not implemented');
}

/** Steps whose `atMs` falls in `[fromMs, toMs)`. PURE. */
// TODO(T2.7): binary-search the sorted steps and slice the window.
export function stepsDue(
  _script: TakerScript,
  _fromMs: Millis,
  _toMs: Millis,
): readonly TakerStep[] {
  throw new Error('TODO(T2.7): stepsDue not implemented');
}

/**
 * Turn one script step into a `Plan` for the SEEDER account to execute.
 *
 * ⚠ The caller must submit this with the seeder's key — never the keeper's (G2).
 */
// TODO(T2.7): maker ⇒ a single POST_ONLY MakerOrder; taker ⇒ a single IOC IocOrder. Same pool.
export function stepToPlan(_step: TakerStep, _book: L2Book, _ctx: RouteContext): Plan {
  throw new Error('TODO(T2.7): stepToPlan not implemented');
}
