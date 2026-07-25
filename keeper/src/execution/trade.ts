// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.10, T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §5.1 (trade PTB — TradeCap only), §4 (Plan), §5 (the ONLY signing surface)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.10 e2e run loop) · CUT LINE item 2
// @spec       docs/MOVE-PACKAGE.md §5.1 (`router::place_maker` / `sweep_ioc` / `cancel_maker`)
// @spec       docs/FACTS.md#deepbook-venue (order-type constants, caps, tick/lot/min_size)
// @rules      G2 G4 G7 G9 G10
// @depends    ../routing/route.ts (T2.7) · ../config.ts · ../sui/client.ts · aphotic::router (T1.5)
// @facts      ★ THE KEEPER HOLDS ONLY A DeepBook `TradeCap` (G2). It can place/cancel orders and
// @facts        NOTHING else. Never `WithdrawCap`, never `DepositCap`. TRADE_CAP_ID = cfg.deepbook.tradeCapId.
// @facts        balance_manager::generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof
// @facts      Move entrypoints (keeper-gated by KeeperCap; each calls envelope::check_action FIRST):
// @facts        entry fun aphotic::router::place_maker(vault, keeper_cap, balance_manager, trade_cap,
// @facts            pool, is_bid, price, quantity, expire_ts, book_mid, oracle_mid, clock, ctx)
// @facts        entry fun aphotic::router::sweep_ioc(vault, keeper_cap, balance_manager, trade_cap,
// @facts            pool, is_bid, max_price, quantity, book_mid, oracle_mid, clock, ctx)
// @facts        entry fun aphotic::router::cancel_maker(vault, keeper_cap, balance_manager, trade_cap,
// @facts            pool, order_id, ctx)
// @facts      DeepBook order types (deepbook::constants): NO_RESTRICTION=0 · IMMEDIATE_OR_CANCEL=1 ·
// @facts        FILL_OR_KILL=2 · POST_ONLY=3.  self-matching: SELF_MATCHING_ALLOWED=0 · CANCEL_TAKER=1 ·
// @facts        CANCEL_MAKER=2.  FLOAT_SCALING = 1_000_000_000.
// @facts      ⚠ `place_post_only_limit_order`, `best_bid_price`, `best_ask_price` are IN THE PINNED
// @facts        SOURCE BUT NOT DEPLOYED on v20 — calling them fails at link time (docs/FACTS.md E-K6/E-M6).
// @facts        Maker placement = place_limit_order with order_type = POST_ONLY (3).
// @facts      Pool<hBTC,DBUSDC> = cfg.deepbook.poolId (initialSharedVersion cfg.deepbook.poolInitialSharedVersion).
// @facts        tick 1_000_000 · lot 1_000 · min_size 100_000 (cfg.deepbook.*).
// @facts      moveCall TARGETS cfg.deepbook.packageId (v20 CALLABLE); TYPE ARGS resolve against
// @facts        cfg.deepbook.originalPackageId (v1). Getting this backwards is a link error.
// @facts      G4: DeepBook only. Maker POST_ONLY + IOC residual on the SAME book. NO Cetus taker
// @facts        leg, NO CLMM ranges — there is no Cetus hBTC pool.
// @facts      The constraint envelope is enforced ON-CHAIN (envelope.move). The keeper builds within
// @facts        it but never self-polices as trust (docs/KEEPER.md §5.1).
// @implements export interface TradeDeps / TradeContext / TradeResult / OrderOutcome
// @implements export function buildTradeTx(cfg: Config, plan: Plan, ctx: TradeContext): Transaction
// @implements export async function apply(deps: TradeDeps, plan: Plan, ctx: TradeContext): Promise<TradeResult>
// @implements export async function cancelAll(deps: TradeDeps, orderIds: readonly OrderId[]): Promise<TradeResult>
// @forbidden  any WithdrawCap / DepositCap reference anywhere in this file (G2)
// @forbidden  cetus / clmm anything (G4, gates.ps1 g4)
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  calling `pool::mid_price` — it ABORTS EEmptyOrderbook on the empty book (E-K6)
// @invariant  1. Every command in the PTB is a router entrypoint; nothing moves funds out.
// @invariant  2. Maker orders are POST_ONLY (3); IOC residual is on the SAME pool.
// @invariant  3. price % tick == 0, quantity % lot == 0, quantity >= min_size — asserted BEFORE signing.
// @invariant  4. Cancels are issued before re-quotes so the book never double-counts our size.
// @ac         docs/KEEPER.md §13 A5 — Plan.iocOrders only; no Cetus module imported anywhere
// @verify     npm run test -- e2e.mock
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis, ObjectId, OrderId, Plan, Sats } from '../types.js';

export interface TradeDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** KEEPER_KEY. Its only power is the DeepBook TradeCap (G2). */
  readonly signer: Signer;
}

/** Valuation + lifecycle inputs the router entrypoints require. */
export interface TradeContext {
  readonly vaultId: ObjectId;
  /** DeepBook mid, sats-scaled — the NAV reference (G9). */
  readonly bookMid: bigint;
  /** Pyth-derived mid, sats-scaled — the envelope's divergence reference (G9). */
  readonly oracleMid: bigint;
  /** Maker expiry (ms epoch); cfg.loop.makerTimeoutMs after the tick. */
  readonly expireTs: Millis;
}

export interface OrderOutcome {
  readonly orderId?: OrderId;
  readonly kind: 'maker' | 'ioc' | 'cancel';
  readonly filledSats?: Sats;
  readonly avgPx?: bigint;
  readonly skipped?: string;
}

export interface TradeResult {
  readonly digest: Digest;
  readonly outcomes: readonly OrderOutcome[];
}

/**
 * Compile a `Plan` (routing/route.ts) into ONE PTB of router entrypoints: cancels first, then
 * POST_ONLY makers, then the IOC residual on the same book.
 */
// TODO(T2.10): validate tick/lot/min_size alignment, then emit cancel_maker* → place_maker* →
//              sweep_ioc* moveCalls against cfg.deepbook.packageId with type args
//              [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType].
export function buildTradeTx(_cfg: Config, _plan: Plan, _ctx: TradeContext): Transaction {
  throw new Error('TODO(T2.10): buildTradeTx not implemented');
}

/** Build, sign with the TradeCap holder, execute, and classify each order's outcome. */
// TODO(T2.10): execute the PTB and parse MakerPlaced / IocSwept / MakerCancelled events.
export async function apply(_deps: TradeDeps, _plan: Plan, _ctx: TradeContext): Promise<TradeResult> {
  throw new Error('TODO(T2.10): apply not implemented');
}

/** Pull every resting maker order (used on the `makerTimeoutMs` re-route and on shutdown). */
// TODO(T2.10): one PTB of router::cancel_maker calls; tolerate already-filled order ids.
export async function cancelAll(_deps: TradeDeps, _orderIds: readonly OrderId[]): Promise<TradeResult> {
  throw new Error('TODO(T2.10): cancelAll not implemented');
}
