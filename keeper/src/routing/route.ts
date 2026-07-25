// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §4 (`route(decision, book) -> Plan`, PURE; maker-first, IOC residual)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7) · CUT LINE item 2 · docs/FACTS.md#no-cetus
// @rules      G4 G5 G7 G9
// @depends    ./book.ts (T2.7) · ../types.ts (Decision/Plan) · ../strategy/evaluate.ts (T2.6)
// @facts      ★ G4 — THERE IS NO CETUS hBTC POOL. The router is DeepBook maker `POST_ONLY` plus an
// @facts        IOC sweep ON THE SAME BOOK. No Cetus taker leg, no CLMM ranges. The base design in
// @facts        "README (8).md" uses Cetus for the SUI/USDC vault; that path does NOT carry here.
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
// @implements export interface RouteContext
// @implements export function route(decision: Decision, book: L2Book, ctx: RouteContext): Plan
// @implements export function residualAfterMaker(decision: Decision, book: L2Book, ctx: RouteContext): { bidSats: Sats; askSats: Sats }
// @implements export function rerouteAsIoc(plan: Plan, unfilled: readonly MakerOrder[], book: L2Book, ctx: RouteContext): Plan
// @forbidden  cetus / clmm anything — G4, gates.ps1 g4
// @forbidden  any wall-clock or entropy source (`Date.now`, `Math.random`) — G5, gates.ps1 purity
// @forbidden  any network call or PTB build here — execution/trade.ts owns that
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. PURE + total: same (decision, book, ctx) ⇒ byte-identical Plan.
// @invariant  2. `Plan.iocOrders` are on the SAME pool as the maker leg — there is no second venue.
// @invariant  3. Every emitted price is tick-aligned; every size lot-aligned and >= min_size.
// @invariant  4. A POST_ONLY maker never crosses the resting book (it would abort on-chain).
// @invariant  5. `cancels` precede placements in the produced Plan ordering.
// @ac         docs/KEEPER.md §13 A5 — Plan.iocOrders only; no Cetus module imported anywhere
// @verify     npm run test -- routing
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Decision, L2Book, MakerOrder, Millis, Plan, Sats } from '../types.js';

import type { VenueParams } from './book.js';

export interface RouteContext extends VenueParams {
  /** Maker expiry stamp (ms epoch) = tick time + params.makerTimeoutMs. Caller-supplied. */
  readonly expireTs: Millis;
  /** Max size to expose as a taker in one tick, sats. Bounds the IOC residual. */
  readonly maxIocSats: Sats;
}

/**
 * Split a `Decision` into a maker-first `Plan`. PURE.
 *
 * Maker POST_ONLY at the decided prices; any residual that must cross is IOC ON THE SAME BOOK.
 */
// TODO(T2.7): emit cancels first, then POST_ONLY makers (aligned), then the IOC residual capped
//             by ctx.maxIocSats. Never emit an order on any venue but the pool in `book.poolId`.
export function route(_decision: Decision, _book: L2Book, _ctx: RouteContext): Plan {
  throw new Error('TODO(T2.7): route not implemented');
}

/** How much of each side cannot rest passively and must cross. PURE. */
// TODO(T2.7): compare decision sizes against passive depth at/behind the quote (book.depthWithinBps).
export function residualAfterMaker(
  _decision: Decision,
  _book: L2Book,
  _ctx: RouteContext,
): { bidSats: Sats; askSats: Sats } {
  throw new Error('TODO(T2.7): residualAfterMaker not implemented');
}

/**
 * The `makerTimeoutMs` path: cancel the unfilled maker remainder and re-route it as IOC on the
 * SAME book. There is nowhere else to send it (G4).
 */
// TODO(T2.7): convert each unfilled MakerOrder into a capped IocOrder and append its cancel.
export function rerouteAsIoc(
  _plan: Plan,
  _unfilled: readonly MakerOrder[],
  _book: L2Book,
  _ctx: RouteContext,
): Plan {
  throw new Error('TODO(T2.7): rerouteAsIoc not implemented');
}
