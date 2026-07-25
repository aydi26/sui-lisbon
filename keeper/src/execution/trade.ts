// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.10, T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.1 (trade PTB — TradeCap only), §4 (Plan), §5 (the ONLY signing surface)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.10 e2e run loop) · CUT LINE item 2
// @spec       docs/MOVE-PACKAGE.md §5.1 (`router::place_maker` / `sweep_ioc` / `cancel_maker`)
// @spec       docs/FACTS.md#deepbook-venue (order-type constants, caps, tick/lot/min_size)
// @rules      G2 G4 G7 G9 G10
// @depends    ../routing/route.ts (T2.7) · ../routing/book.ts (T2.7) · ../config.ts · ../sui/client.ts
// @depends    aphotic::router (T1.5 — DONE, signatures read from move/sources/router.move)
// @facts      ★ THE KEEPER HOLDS ONLY A DeepBook `TradeCap` (G2). It can place/cancel orders and
// @facts        NOTHING else. Never `WithdrawCap`, never `DepositCap`. TRADE_CAP_ID = cfg.deepbook.tradeCapId.
// @facts        balance_manager::generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof
// @facts        is taken INSIDE aphotic::router — this file never touches a proof or a capability
// @facts        other than by object id.
// @facts      ★★ moveCall TARGET = cfg.aphotic.packageId (`aphotic::router`), NOT the DeepBook
// @facts        package. The keeper never calls `deepbook::pool` directly: every venue touch goes
// @facts        through the KeeperCap-gated, envelope-checked router entrypoints (MOVE-PACKAGE §5.1).
// @facts        The DeepBook ids still matter for the TYPE ARGUMENTS and the Pool shared input.
// @facts      VERBATIM router entrypoints (move/sources/router.move, T1.5 DONE):
// @facts        entry fun place_maker<B,Q>(vault, keeper_cap, balance_manager, trade_cap, pool,
// @facts            client_order_id: u64, is_bid: bool, price: u64, quantity: u64, expire_ts: u64,
// @facts            tick: u64, lot: u64, min_size: u64, pending_exit_demand_sats: u64,
// @facts            projected_capacity_sats: u64, book_mid: u128, oracle_mid: u128, clock, ctx)
// @facts        entry fun sweep_ioc<B,Q>(vault, keeper_cap, balance_manager, trade_cap, pool,
// @facts            client_order_id: u64, is_bid: bool, max_price: u64, quantity: u64, tick: u64,
// @facts            lot: u64, min_size: u64, pending_exit_demand_sats: u64,
// @facts            projected_capacity_sats: u64, book_mid: u128, oracle_mid: u128, clock, ctx)
// @facts        entry fun cancel_maker<B,Q>(vault, keeper_cap, balance_manager, trade_cap, pool,
// @facts            order_id: u128, clock, ctx)
// @facts      Emitted receipts (G10): router::MakerPlaced{vault_id,order_id,is_bid,price,quantity}
// @facts        · router::IocSwept{vault_id,is_bid,filled_qty,avg_price}
// @facts        · router::MakerCancelled{vault_id,order_id}. Decoded from event BCS, never from
// @facts        `event.json` — that shape differs between gRPC and JSON-RPC.
// @facts      DeepBook order types (deepbook::constants): NO_RESTRICTION=0 · IMMEDIATE_OR_CANCEL=1 ·
// @facts        FILL_OR_KILL=2 · POST_ONLY=3.  self-matching: SELF_MATCHING_ALLOWED=0 · CANCEL_TAKER=1 ·
// @facts        CANCEL_MAKER=2.  FLOAT_SCALING = 1_000_000_000. The router picks them; we do not.
// @facts      ⚠ `place_post_only_limit_order`, `best_bid_price`, `best_ask_price` are IN THE PINNED
// @facts        SOURCE BUT NOT DEPLOYED on v20 — calling them fails at link time (docs/FACTS.md E-K6/E-M6).
// @facts        Maker placement = place_limit_order with order_type = POST_ONLY (3), inside the router.
// @facts      Pool<hBTC,DBUSDC> = cfg.deepbook.poolId (initialSharedVersion cfg.deepbook.poolInitialSharedVersion).
// @facts        tick 1_000_000 · lot 1_000 · min_size 100_000 (cfg.deepbook.*).
// @facts      TYPE ARGS = [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType]; they resolve against
// @facts        cfg.deepbook.originalPackageId (v1). Getting that backwards is a link error.
// @facts      G4: DeepBook only. Maker POST_ONLY + IOC residual on the SAME book. NO second-venue
// @facts        taker leg, NO concentrated-liquidity ranges — there is no hBTC pool on any AMM.
// @facts      The constraint envelope is enforced ON-CHAIN (envelope.move). The keeper builds within
// @facts        it but never self-polices as trust (docs/KEEPER.md §5.1).
// @implements export interface TradeDeps / TradeContext / TradeResult / OrderOutcome
// @implements export function buildTradeTx(cfg: Config, plan: Plan, ctx: TradeContext): Transaction
// @implements export function buildCancelTx(cfg, orderIds, ctx): Transaction        [T2.7 addition]
// @implements export function decodeRouterEvents(cfg, events): OrderOutcome[]       [T2.7 addition]
// @implements export async function apply(deps: TradeDeps, plan: Plan, ctx: TradeContext): Promise<TradeResult>
// @implements export async function cancelAll(deps: TradeDeps, orderIds: readonly OrderId[], ctx: CancelContext): Promise<TradeResult>
// @implements ⚠ DELTA vs the skeleton banner: `cancelAll` takes a third argument. `router::cancel_maker`
// @implements   needs the Vault AND the KeeperCap, and neither is derivable from `TradeDeps` alone —
// @implements   the KeeperCap object id is not a canonical config id (it is minted at vault creation).
// @forbidden  any WithdrawCap / DepositCap reference anywhere in this file (G2)
// @forbidden  any non-DeepBook venue leg, and any concentrated-liquidity range logic (G4, gates.ps1 g4)
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  calling `pool::mid_price` — it ABORTS EEmptyOrderbook on the empty book (E-K6)
// @forbidden  a bitcoin destination of any kind on this path — the keeper trades, it never moves
//             funds off Sui (G2, gates.ps1 g2)
// @invariant  1. Every command in the PTB is a router entrypoint; nothing moves funds out.
// @invariant  2. Maker orders are POST_ONLY (3); IOC residual is on the SAME pool.
// @invariant  3. price % tick == 0, quantity % lot == 0, quantity >= min_size — asserted BEFORE signing.
// @invariant  4. Cancels are issued before re-quotes so the book never double-counts our size.
// @invariant  5. `client_order_id` is derived from ctx.clientOrderIdBase + command index — no clock,
//                no entropy, so a replayed tick builds a byte-identical PTB.
// @ac         docs/KEEPER.md §13 A5 — Plan.iocOrders only; no second-venue module imported anywhere
// @verify     npm run test -- routing
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import { isAligned, venueParams } from '../routing/book.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, Millis, ObjectId, OrderId, Plan, Sats } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

export interface TradeDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** KEEPER_KEY. Its only power is the DeepBook TradeCap, held by the Vault (G2). */
  readonly signer: Signer;
}

/** Valuation + lifecycle inputs the router entrypoints require. */
export interface TradeContext {
  readonly vaultId: ObjectId;
  /** The KeeperCap minted at vault creation — the keeper's authorization, not a fund capability. */
  readonly keeperCapId: ObjectId;
  /** DeepBook mid, sats-scaled — the NAV reference (G9). */
  readonly bookMid: bigint;
  /** Pyth-derived mid, sats-scaled — the envelope's divergence reference (G9). */
  readonly oracleMid: bigint;
  /** Maker expiry (ms epoch); cfg.loop.makerTimeoutMs after the tick. */
  readonly expireTs: Millis;
  /**
   * Keeper-attested limiter readings the envelope needs (router.move delta (c)): there is no
   * on-chain queue-depth read (E-M4 / RECON R7.2). Lying can only relax the buffer down to the
   * OWNER's static floor, and `verify/` replays the same trajectory from Hashi's events (G5).
   */
  readonly pendingExitDemandSats?: Sats;
  readonly projectedCapacitySats?: Sats;
  /** First `client_order_id`; each command takes base + its index (invariant 5). */
  readonly clientOrderIdBase?: bigint;
}

/** Everything `cancel_maker` needs that is not in `Config`. */
export type CancelContext = Pick<TradeContext, 'vaultId' | 'keeperCapId'>;

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

// ── router event layouts (G10 receipts) ──────────────────────────────────────

const MakerPlacedEvent = bcs.struct('MakerPlaced', {
  vault_id: bcs.Address,
  order_id: bcs.u128(),
  is_bid: bcs.bool(),
  price: bcs.u64(),
  quantity: bcs.u64(),
});

const IocSweptEvent = bcs.struct('IocSwept', {
  vault_id: bcs.Address,
  is_bid: bcs.bool(),
  filled_qty: bcs.u64(),
  avg_price: bcs.u64(),
});

const MakerCancelledEvent = bcs.struct('MakerCancelled', {
  vault_id: bcs.Address,
  order_id: bcs.u128(),
});

/** Minimal event shape both transports return (`SuiClientTypes.Event`). */
export interface RouterEvent {
  readonly eventType: string;
  readonly bcs: Uint8Array;
}

interface ExecutedShape {
  readonly digest: string;
  readonly events?: readonly RouterEvent[] | undefined;
}

/**
 * The minimal execution surface both `SuiGrpcClient` and `SuiJsonRpcClient` expose on `.core`.
 * Declared structurally because the two generic overloads do not unify; no client is constructed
 * here (gates.ps1 transport).
 */
interface ExecutionCore {
  signAndExecuteTransaction(input: {
    transaction: Transaction;
    signer: Signer;
    include: { events: true };
  }): Promise<{
    readonly $kind: 'Transaction' | 'FailedTransaction';
    readonly Transaction?: ExecutedShape;
    readonly FailedTransaction?: ExecutedShape;
  }>;
}

// ── PTB construction ─────────────────────────────────────────────────────────

/**
 * Compile a `Plan` (routing/route.ts) into ONE PTB of router entrypoints: cancels first, then
 * POST_ONLY makers, then the IOC residual on the same book (invariant 4).
 */
export function buildTradeTx(cfg: Config, plan: Plan, ctx: TradeContext): Transaction {
  assertPublished(cfg);
  const venue = venueParams(cfg);
  const tx = newTx(cfg);

  let command = 0;

  // 1. Cancels FIRST — the book must never double-count our resting size.
  for (const orderId of plan.cancels) {
    tx.moveCall(cancelCall(cfg, tx, orderId, ctx));
    command++;
  }

  // 2. POST_ONLY makers.
  for (const order of plan.makerOrders) {
    assertGranularity(order.px, order.sz, venue, 'maker');
    tx.moveCall({
      target: `${cfg.aphotic.packageId}::router::place_maker`,
      typeArguments: typeArgs(cfg),
      arguments: [
        tx.object(ctx.vaultId),
        tx.object(ctx.keeperCapId),
        tx.object(cfg.deepbook.balanceManagerId),
        tx.object(cfg.deepbook.tradeCapId),
        poolRef(cfg, tx),
        tx.pure.u64(clientOrderId(ctx, command)),
        tx.pure.bool(order.side === 'bid'),
        tx.pure.u64(order.px),
        tx.pure.u64(order.sz),
        tx.pure.u64(BigInt(order.expireTs)),
        tx.pure.u64(venue.tickSize),
        tx.pure.u64(venue.lotSize),
        tx.pure.u64(venue.minSize),
        tx.pure.u64(ctx.pendingExitDemandSats ?? 0n),
        tx.pure.u64(ctx.projectedCapacitySats ?? 0n),
        tx.pure.u128(ctx.bookMid),
        tx.pure.u128(ctx.oracleMid),
        tx.object.clock(),
      ],
    });
    command++;
  }

  // 3. IOC residual — SAME pool, no second venue (G4).
  for (const order of plan.iocOrders) {
    assertGranularity(order.px, order.sz, venue, 'ioc');
    tx.moveCall({
      target: `${cfg.aphotic.packageId}::router::sweep_ioc`,
      typeArguments: typeArgs(cfg),
      arguments: [
        tx.object(ctx.vaultId),
        tx.object(ctx.keeperCapId),
        tx.object(cfg.deepbook.balanceManagerId),
        tx.object(cfg.deepbook.tradeCapId),
        poolRef(cfg, tx),
        tx.pure.u64(clientOrderId(ctx, command)),
        tx.pure.bool(order.side === 'bid'),
        tx.pure.u64(order.px),
        tx.pure.u64(order.sz),
        tx.pure.u64(venue.tickSize),
        tx.pure.u64(venue.lotSize),
        tx.pure.u64(venue.minSize),
        tx.pure.u64(ctx.pendingExitDemandSats ?? 0n),
        tx.pure.u64(ctx.projectedCapacitySats ?? 0n),
        tx.pure.u128(ctx.bookMid),
        tx.pure.u128(ctx.oracleMid),
        tx.object.clock(),
      ],
    });
    command++;
  }

  return tx;
}

/** A PTB of nothing but `router::cancel_maker` calls. */
export function buildCancelTx(
  cfg: Config,
  orderIds: readonly OrderId[],
  ctx: CancelContext,
): Transaction {
  assertPublished(cfg);
  const tx = newTx(cfg);
  for (const orderId of orderIds) {
    tx.moveCall(cancelCall(cfg, tx, orderId, ctx));
  }
  return tx;
}

// ── execution ────────────────────────────────────────────────────────────────

/** Build, sign with the TradeCap holder, execute, and classify each order's outcome. */
export async function apply(deps: TradeDeps, plan: Plan, ctx: TradeContext): Promise<TradeResult> {
  const tx = buildTradeTx(deps.cfg, plan, ctx);
  return execute(deps, tx);
}

/** Pull every resting maker order (used on the `makerTimeoutMs` re-route and on shutdown). */
export async function cancelAll(
  deps: TradeDeps,
  orderIds: readonly OrderId[],
  ctx: CancelContext,
): Promise<TradeResult> {
  if (orderIds.length === 0) return { digest: '', outcomes: [] };
  const tx = buildCancelTx(deps.cfg, orderIds, ctx);
  return execute(deps, tx);
}

/**
 * Decode the router's receipts into per-order outcomes.
 *
 * Matched on the `::router::<Struct>` suffix rather than the full type: the `packageId` carried by
 * an event is the ORIGINAL package id, which diverges from `cfg.aphotic.packageId` the first time
 * the package is upgraded. The module path is the stable part.
 */
export function decodeRouterEvents(events: readonly RouterEvent[]): OrderOutcome[] {
  const outcomes: OrderOutcome[] = [];

  for (const event of events) {
    if (event.eventType.endsWith('::router::MakerPlaced')) {
      const parsed = MakerPlacedEvent.parse(event.bcs);
      outcomes.push({ kind: 'maker', orderId: BigInt(parsed.order_id), avgPx: BigInt(parsed.price) });
      continue;
    }
    if (event.eventType.endsWith('::router::IocSwept')) {
      const parsed = IocSweptEvent.parse(event.bcs);
      const filledSats = BigInt(parsed.filled_qty);
      outcomes.push({
        kind: 'ioc',
        filledSats,
        avgPx: BigInt(parsed.avg_price),
        ...(filledSats === 0n ? { skipped: 'ioc-unfilled' } : {}),
      });
      continue;
    }
    if (event.eventType.endsWith('::router::MakerCancelled')) {
      const parsed = MakerCancelledEvent.parse(event.bcs);
      outcomes.push({ kind: 'cancel', orderId: BigInt(parsed.order_id) });
    }
  }

  return outcomes;
}

// ── internals ────────────────────────────────────────────────────────────────

async function execute(deps: TradeDeps, tx: Transaction): Promise<TradeResult> {
  const core = deps.client.core as unknown as ExecutionCore;
  const result = await core.signAndExecuteTransaction({
    transaction: tx,
    signer: deps.signer,
    include: { events: true },
  });

  const executed = result.Transaction ?? result.FailedTransaction;
  if (executed === undefined) {
    throw new AphoticError('TradeExecutionFailed', 'signAndExecuteTransaction returned no transaction');
  }
  if (result.$kind === 'FailedTransaction') {
    throw new AphoticError(
      'TradeExecutionFailed',
      `router PTB failed on chain (digest ${executed.digest})`,
    );
  }

  return { digest: executed.digest, outcomes: decodeRouterEvents(executed.events ?? []) };
}

function newTx(cfg: Config): Transaction {
  const tx = new Transaction();
  if (cfg.sui.keeperAddress !== '') tx.setSender(cfg.sui.keeperAddress);
  return tx;
}

function typeArgs(cfg: Config): [string, string] {
  // Resolve against cfg.deepbook.originalPackageId (v1); the moveCall TARGET is the aphotic package.
  return [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType];
}

function poolRef(cfg: Config, tx: Transaction) {
  return tx.sharedObjectRef({
    objectId: cfg.deepbook.poolId,
    initialSharedVersion: cfg.deepbook.poolInitialSharedVersion,
    mutable: true,
  });
}

function cancelCall(cfg: Config, tx: Transaction, orderId: OrderId, ctx: CancelContext) {
  return {
    target: `${cfg.aphotic.packageId}::router::cancel_maker`,
    typeArguments: typeArgs(cfg),
    arguments: [
      tx.object(ctx.vaultId),
      tx.object(ctx.keeperCapId),
      tx.object(cfg.deepbook.balanceManagerId),
      tx.object(cfg.deepbook.tradeCapId),
      poolRef(cfg, tx),
      tx.pure.u128(orderId),
      tx.object.clock(),
    ],
  };
}

function clientOrderId(ctx: TradeContext, index: number): bigint {
  return (ctx.clientOrderIdBase ?? 0n) + BigInt(index);
}

function assertGranularity(
  px: bigint,
  sz: Sats,
  venue: { tickSize: bigint; lotSize: Sats; minSize: Sats },
  leg: string,
): void {
  if (isAligned(px, sz, venue)) return;
  throw new AphoticError(
    'BadOrderGranularity',
    `${leg} order px=${px} sz=${sz} violates tick=${venue.tickSize} lot=${venue.lotSize} min_size=${venue.minSize}`,
  );
}

/** The router lives in the published `aphotic` package; without its id there is no target. */
function assertPublished(cfg: Config): void {
  const missing: string[] = [];
  if (cfg.aphotic.packageId === '') missing.push('APHOTIC_PACKAGE_ID');
  if (cfg.deepbook.balanceManagerId === '') missing.push('BALANCE_MANAGER_ID');
  if (cfg.deepbook.tradeCapId === '') missing.push('TRADE_CAP_ID');
  if (missing.length > 0) {
    throw new ConfigError(`cannot build a router PTB without ${missing.join(', ')}`, missing);
  }
}
