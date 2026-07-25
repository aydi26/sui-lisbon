// Stub-phase lint suppression. The error constants and event structs below are part of the
// CONTRACT (docs/MOVE-PACKAGE.md §5.3) and are declared for real, but most are not referenced
// until the TODO(T1.5) bodies land. DELETE when the module status becomes DONE.
#[allow(unused_const, unused_field)]
module aphotic::router;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.5
// @phase      1  [CUT-LINE CRITICAL]
// @status     PARTIAL
// @spec       docs/MOVE-PACKAGE.md#module-router (L417-L499)
// @spec       docs/RECON.md#R10-deepbook-venue-reality (L152-L158)
// @spec       docs/BUILD-PLAN.md#T1.5 (L82)
// @rules      G2 G4 G9 G10
// @depends    aphotic::vault (T1.1) · aphotic::envelope (T4.1) · deepbook (external)
// @facts      Pool<hBTC, DBUSDC> testnet id 0x5cdaebf2...  (NEVER inline here — it arrives as
// @facts        vault.pool_id and is checked against the passed &mut Pool, G7)
// @facts      DEFAULT_TICK_SIZE = 1_000_000 · DEFAULT_LOT_SIZE = 1_000 · DEFAULT_MIN_SIZE = 100_000
// @facts        (docs/FACTS.md#deepbook-venue). Config-OVERRIDABLE: the assert helpers take the
// @facts        live values as parameters; the constants are defaults only (V5).
// @facts      DeepBook testnet package versions (RECON R4): original/type-origin
// @facts        0xfb28c4cb...(v1) · superseded 0x22be4cad...(v17) · CURRENT CALLABLE
// @facts        0xd874d241...(v20). Type args resolve against the ORIGINAL; moveCall targets
// @facts        the CURRENT. Both belong in keeper/app config, not here.
// @facts      Trading fees payable in DEEP or the input token; pool creation fee 500 DEEP.
// @facts      ⚠ The testnet book has ZERO volume (RECON R10). `mid_price` has nothing to read
// @facts        until a scripted taker/maker seeds it — that account is NOT optional, NAV
// @facts        depends on it. `book_mid` aborts EEmptyBook on a one-sided/empty book.
// @facts      ⚠ Never read the book from the hosted indexer — it does not list this pool
// @facts        (RECON R10). Read on-chain via get_level2_range / mid_price.
// @external   public fun deepbook::pool::place_limit_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, client_order_id: u64, order_type: u8,
//                 self_matching_option: u8, price: u64, quantity: u64, is_bid: bool,
//                 pay_with_deep: bool, expire_timestamp: u64, clock: &Clock,
//                 ctx: &TxContext): OrderInfo
//             public fun deepbook::pool::place_post_only_limit_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, client_order_id: u64, price: u64, quantity: u64,
//                 is_bid: bool, pay_with_deep: bool, expire_timestamp: u64, clock: &Clock,
//                 ctx: &TxContext): Option<OrderInfo>
//             // ⚠ GRACEFUL post-only: returns none instead of aborting EPOSTOrderCrossesOrderbook
//             //   when the order would cross, and none when the placement rests nothing.
//             //   `some` therefore always means "resting on the book". Self-matching is fixed
//             //   to SELF_MATCHING_ALLOWED and is NOT a parameter. Prefer this for the maker leg.
//             public fun deepbook::pool::place_market_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, client_order_id: u64, self_matching_option: u8,
//                 quantity: u64, is_bid: bool, pay_with_deep: bool, clock: &Clock,
//                 ctx: &TxContext): OrderInfo
//             // IOC under the hood: forwards constants::immediate_or_cancel() at max/min price.
//             public fun deepbook::pool::cancel_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, order_id: u128, clock: &Clock, ctx: &TxContext)
//             public fun deepbook::pool::mid_price<BaseAsset, QuoteAsset>(
//                 self: &Pool<BaseAsset, QuoteAsset>, clock: &Clock): u64
//             public fun deepbook::pool::get_level2_range<BaseAsset, QuoteAsset>(
//                 self: &Pool<BaseAsset, QuoteAsset>, price_low: u64, price_high: u64,
//                 is_bid: bool, clock: &Clock): (vector<u64>, vector<u64>)
//             public fun deepbook::balance_manager::generate_proof_as_trader(
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 ctx: &TxContext): TradeProof
//             // ⚠ This is the ONLY DeepBook proof path the keeper may use (G2). The
//             //   owner-only `generate_proof_as_owner` and the Deposit/WithdrawCap paths
//             //   must never be reachable from a keeper-gated entrypoint.
//             public fun deepbook::constants::post_only(): u8
//             public fun deepbook::constants::immediate_or_cancel(): u8
//             public fun deepbook::constants::self_matching_allowed(): u8
//             public fun deepbook::constants::cancel_taker(): u8
// @implements entry fun place_maker<Q>(vault: &mut Vault<BTC, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<BTC, Q>, client_order_id: u64, is_bid: bool, price: u64,
//                 quantity: u64, expire_ts: u64, book_mid: u128, oracle_mid: u128,
//                 clock: &Clock, ctx: &mut TxContext)
//             entry fun sweep_ioc<Q>(vault: &mut Vault<BTC, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<BTC, Q>, client_order_id: u64, is_bid: bool, max_price: u64,
//                 quantity: u64, book_mid: u128, oracle_mid: u128, clock: &Clock,
//                 ctx: &mut TxContext)
//             entry fun cancel_maker<Q>(vault: &mut Vault<BTC, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<BTC, Q>, order_id: u128, clock: &Clock, ctx: &mut TxContext)
//             public fun book_mid<Q>(pool: &Pool<BTC, Q>, clock: &Clock): u128
//             public fun assert_order_granularity(price: u64, quantity: u64, tick: u64,
//                 lot: u64, min_size: u64)                                       [DONE]
//             public fun default_tick_size(): u64                                [DONE]
//             public fun default_lot_size(): u64                                 [DONE]
//             public fun default_min_size(): u64                                 [DONE]
// @events     MakerPlaced { vault_id: ID, order_id: u128, is_bid: bool, price: u64, quantity: u64 }
//             IocSwept { vault_id: ID, is_bid: bool, filled_qty: u64, avg_price: u64 }
//             MakerCancelled { vault_id: ID, order_id: u128 }
// @errors     EWrongPool · ENotKeeper · EBadTick · EBadLot · EBelowMinSize · EEmptyBook
//             · ENotPostOnly
// @forbidden  ANY non-DeepBook venue leg, and any concentrated-liquidity range logic — G4,
//             gates.ps1 g4. There is no hBTC pool on the AMM; the router is maker POST_ONLY
//             plus IOC sweep on the SAME order book, and nothing else.
// @forbidden  a hardcoded pool id — it must equal vault.pool_id (G7), abort EWrongPool
// @forbidden  any Withdraw/Deposit cap path — the keeper holds TradeCap ONLY (G2)
// @forbidden  a bridge module path in this file — G7, gates.ps1 g7
// @invariant  1. object::id(pool) == vault::pool_id(vault), else EWrongPool.
// @invariant  2. No non-DeepBook venue import or code path exists in this module (G4).
// @invariant  3. The maker leg is POST_ONLY; a non-post-only maker placement aborts ENotPostOnly.
// @invariant  4. price % tick == 0 (EBadTick), quantity % lot == 0 (EBadLot),
//                quantity >= min_size (EBelowMinSize) — values passed as config.
// @invariant  5. EVERY entrypoint calls vault::assert_keeper then envelope::check_action
//                BEFORE touching the book.
// @invariant  6. Self-match prevention is enabled on placement.
// @invariant  7. NAV valuation uses the DeepBook mid, never a raw oracle price (G9).
// @ac         docs/MOVE-PACKAGE.md §8 router_tests checklist (L645-L650)
// @verify     sui move build
// @verify     sui move test router
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §5.3) ─────────────────────────────
const EWrongPool: u64 = 1;
const ENotKeeper: u64 = 2;
const EBadTick: u64 = 3;
const EBadLot: u64 = 4;
const EBelowMinSize: u64 = 5;
const EEmptyBook: u64 = 6;
const ENotPostOnly: u64 = 7;

// ── venue granularity defaults (docs/FACTS.md#deepbook-venue) ───────────────
// DEFAULTS ONLY. The assert helper takes the live values as parameters so the venue
// parameters stay config-overridable (V5).
const DEFAULT_TICK_SIZE: u64 = 1_000_000;
const DEFAULT_LOT_SIZE: u64 = 1_000;
const DEFAULT_MIN_SIZE: u64 = 100_000;

// ── events (docs/MOVE-PACKAGE.md §5.3) ──────────────────────────────────────

public struct MakerPlaced has copy, drop {
    vault_id: ID,
    order_id: u128,
    is_bid: bool,
    price: u64,
    quantity: u64,
}

public struct IocSwept has copy, drop {
    vault_id: ID,
    is_bid: bool,
    filled_qty: u64,
    avg_price: u64,
}

public struct MakerCancelled has copy, drop {
    vault_id: ID,
    order_id: u128,
}

// ── pure guards (implemented now) ───────────────────────────────────────────

/// Venue granularity gate. Values arrive as parameters so the pool's live tick/lot/min_size
/// can be threaded from config rather than baked into logic (G7/V5).
public fun assert_order_granularity(
    price: u64,
    quantity: u64,
    tick: u64,
    lot: u64,
    min_size: u64,
) {
    assert!(price % tick == 0, EBadTick);
    assert!(quantity % lot == 0, EBadLot);
    assert!(quantity >= min_size, EBelowMinSize);
}

public fun default_tick_size(): u64 { DEFAULT_TICK_SIZE }

public fun default_lot_size(): u64 { DEFAULT_LOT_SIZE }

public fun default_min_size(): u64 { DEFAULT_MIN_SIZE }

// ── still to implement ──────────────────────────────────────────────────────
// TODO(T1.5): `use deepbook::{pool::Pool, balance_manager::{Self, BalanceManager, TradeCap},
//             constants};` plus aphotic::{vault, envelope}.
// TODO(T1.5): place_maker — assert object::id(pool) == vault::pool_id (EWrongPool);
//             vault::assert_keeper(vault, keeper_cap) (ENotKeeper);
//             assert_order_granularity(...);
//             envelope::check_action(..., action_notional = price * quantity, ...);
//             proof = balance_manager::generate_proof_as_trader(bm, trade_cap, ctx);
//             pool::place_post_only_limit_order(...) — `none` means it would have crossed;
//             treat that as ENotPostOnly rather than silently no-op'ing; emit MakerPlaced.
// TODO(T1.5): sweep_ioc — same gates, then place_limit_order with
//             constants::immediate_or_cancel() bounded by max_price on the SAME book (G4);
//             emit IocSwept { filled_qty, avg_price }.
// TODO(T1.5): cancel_maker — same gates, pool::cancel_order; emit MakerCancelled.
// TODO(T1.5): book_mid — read pool::mid_price (or best_bid/best_ask via get_level2_range),
//             widen to u128, sats-scale; abort EEmptyBook on a one-sided/empty book (RECON R10).
