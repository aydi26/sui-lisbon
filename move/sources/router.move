module aphotic::router;

use aphotic::envelope;
use aphotic::vault::{Self, Vault, KeeperCap};
use deepbook::balance_manager::{Self, BalanceManager, TradeCap};
use deepbook::constants;
use deepbook::order_info::OrderInfo;
use deepbook::pool::{Self, Pool};
use sui::clock::Clock;
use sui::event;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.5
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
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
// @facts        `place_limit_order`'s own doc says "for current version pay_with_deep must be
// @facts        true", so PAY_FEES_WITH_DEEP is a named constant, not a caller knob.
// @facts      DEEPBOOK order-type constants (deepbook::constants, verified in the pinned rev):
// @facts        NO_RESTRICTION 0 · IMMEDIATE_OR_CANCEL 1 · FILL_OR_KILL 2 · POST_ONLY 3
// @facts        SELF_MATCHING_ALLOWED 0 · CANCEL_TAKER 1 · CANCEL_MAKER 2
// @facts      ⚠ The testnet book has ZERO volume (RECON R10) and is EMPTY ON BOTH SIDES
// @facts        (E-M7, measured live). `try_book_mid` therefore returns `none` today; NAV must
// @facts        have a DEFINED behaviour there, which is why the Option form is the primitive
// @facts        and the aborting `book_mid` is the thin wrapper.
// @facts      ⚠ Never read the book from the hosted indexer — it does not list this pool
// @facts        (RECON R10). Read on-chain via get_level2_range.
// @external   public fun deepbook::pool::place_limit_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, client_order_id: u64, order_type: u8,
//                 self_matching_option: u8, price: u64, quantity: u64, is_bid: bool,
//                 pay_with_deep: bool, expire_timestamp: u64, clock: &Clock,
//                 ctx: &TxContext): OrderInfo
//             public fun deepbook::pool::cancel_order<BaseAsset, QuoteAsset>(
//                 self: &mut Pool<BaseAsset, QuoteAsset>, balance_manager: &mut BalanceManager,
//                 trade_proof: &TradeProof, order_id: u128, clock: &Clock, ctx: &TxContext)
//             public fun deepbook::pool::get_level2_range<BaseAsset, QuoteAsset>(
//                 self: &Pool<BaseAsset, QuoteAsset>, price_low: u64, price_high: u64,
//                 is_bid: bool, clock: &Clock): (vector<u64>, vector<u64>)
//             // bids come back DESCENDING, asks ASCENDING ⇒ index 0 is top-of-book on each side.
//             // On an empty side it SUCCEEDS and returns ([], []) — it does not abort (E-M7).
//             public fun deepbook::balance_manager::generate_proof_as_trader(
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 ctx: &TxContext): TradeProof
//             // ⚠ This is the ONLY DeepBook proof path this module uses (G2). The owner-only
//             //   `generate_proof_as_owner` and the Deposit/WithdrawCap paths are unreachable
//             //   from every entrypoint below — none of them takes such a capability.
//             public fun deepbook::constants::post_only(): u8
//             public fun deepbook::constants::immediate_or_cancel(): u8
//             public fun deepbook::constants::self_matching_allowed(): u8
//             public fun deepbook::constants::cancel_maker(): u8
//             public fun deepbook::constants::{min_price, max_price, float_scaling}(): u64
//             public fun deepbook::order_info::{order_id, order_type, price, original_quantity,
//                 executed_quantity, cumulative_quote_quantity, order_inserted}(&OrderInfo)
//             ⚠⚠ E-M6 — DO NOT CALL, absent from the DEPLOYED v20 package even though the pinned
//                 dep source has them: `pool::place_post_only_limit_order`, `pool::best_bid_price`,
//                 `pool::best_ask_price`. A call to a function missing from the linked package
//                 COMPILES and then fails at publish/link time.
//             ⚠⚠ E-M7 — DO NOT CALL `pool::mid_price`: it ABORTS `deepbook::book` code 2
//                 (EEmptyOrderbook) on the book's CURRENT (empty) state, which would make NAV
//                 unreadable. `get_level2_range` returns ([], []) instead.
// @implements entry fun place_maker<B, Q>(vault: &mut Vault<B, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<B, Q>, client_order_id: u64, is_bid: bool, price: u64,
//                 quantity: u64, expire_ts: u64, tick: u64, lot: u64, min_size: u64,
//                 pending_exit_demand_sats: u64, projected_capacity_sats: u64, book_mid: u128,
//                 oracle_mid: u128, clock: &Clock, ctx: &TxContext)
//             entry fun sweep_ioc<B, Q>(vault: &mut Vault<B, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<B, Q>, client_order_id: u64, is_bid: bool, max_price: u64,
//                 quantity: u64, tick: u64, lot: u64, min_size: u64,
//                 pending_exit_demand_sats: u64, projected_capacity_sats: u64, book_mid: u128,
//                 oracle_mid: u128, clock: &Clock, ctx: &TxContext)
//             entry fun cancel_maker<B, Q>(vault: &Vault<B, Q>, keeper_cap: &KeeperCap,
//                 balance_manager: &mut BalanceManager, trade_cap: &TradeCap,
//                 pool: &mut Pool<B, Q>, order_id: u128, clock: &Clock, ctx: &TxContext)
//             public fun try_book_mid<B, Q>(pool: &Pool<B, Q>, clock: &Clock): Option<u128>
//             public fun book_mid<B, Q>(pool: &Pool<B, Q>, clock: &Clock): u128
//             public fun mid_from_levels(bid_prices: &vector<u64>,
//                 ask_prices: &vector<u64>): Option<u128>
//             public fun require_mid(mid: Option<u128>): u128
//             public fun avg_fill_price(filled_base: u64, cumulative_quote: u64): u64
//             public fun assert_post_only(order_type: u8, executed_quantity: u64)
//             public fun assert_keeper_gate<B, Q>(vault: &Vault<B, Q>, cap: &KeeperCap)
//             public fun assert_pool_matches<B, Q>(vault: &Vault<B, Q>, pool_id: ID)
//             public(package) fun stage_order<B, Q>(vault: &mut Vault<B, Q>,
//                 keeper_cap: &KeeperCap, pool_id: ID, price: u64, quantity: u64, tick: u64,
//                 lot: u64, min_size: u64, pending_exit_demand_sats: u64,
//                 projected_capacity_sats: u64, book_mid: u128, oracle_mid: u128, clock: &Clock)
//             public(package) fun stage_cancel<B, Q>(vault: &Vault<B, Q>,
//                 keeper_cap: &KeeperCap, pool_id: ID)
//             public fun assert_order_granularity(price: u64, quantity: u64, tick: u64,
//                 lot: u64, min_size: u64)                                       [DONE]
//             public fun default_tick_size(): u64                                [DONE]
//             public fun default_lot_size(): u64                                 [DONE]
//             public fun default_min_size(): u64                                 [DONE]
//             ⚠ DELTAS vs the skeleton banner + docs/MOVE-PACKAGE.md §5.1, each forced:
//               (a) EVERY function is generic <B, Q>, never `Vault<BTC, Q>` / `Pool<BTC, Q>`.
//                   Naming the bridge's coin type here would require `use hashi::btc::BTC` in
//                   sources/router.move and BREAK the G7 isolation gate outright. Same reasoning
//                   as aphotic::vault's generic-vault decision. Only gateway.move is concrete.
//               (b) `tick` / `lot` / `min_size` are PARAMETERS. The module constants are DEFAULTS
//                   only (V5) — DeepBook admins can adjust a pool's tick/lot at runtime
//                   (`adjust_tick_size_admin`), so a baked-in value would silently start
//                   rejecting valid orders.
//               (c) `pending_exit_demand_sats` / `projected_capacity_sats` are PARAMETERS. They
//                   are the keeper-attested limiter readings envelope::deployable_sats needs, and
//                   there is nothing on-chain to read them from (E-M4 / RECON R7.2: all 46
//                   withdrawal_queue getters are public(package)). The trust bound is stated in
//                   envelope.move: the buffer is max(OWNER-set static floor, attested dynamic
//                   term), so lying can only relax the buffer DOWN TO the owner's floor, never
//                   below it — and `keeper/src/verify/` replays the same trajectory from Hashi's
//                   own event stream (G5).
//               (d) `cancel_maker` does NOT call envelope::check_action. Its spec signature has
//                   neither book_mid nor oracle_mid, so the call is not even expressible; and
//                   every one of the envelope's five remaining checks bounds DEPLOYMENT, while a
//                   cancel is the inverse operation — it returns capital to idle. Gating it
//                   would let a cooldown or a divergence breaker TRAP the vault's quotes on the
//                   book at exactly the moment risk says pull them. It stays keeper-gated and
//                   pool-checked, and `vault::assert_keeper` still blocks it when paused.
//               (f) `ctx` is `&TxContext`, not `&mut`: DeepBook's own entrypoints take
//                   `&TxContext` and nothing here creates an object, so `&mut` only draws W09014
//                   and the build would no longer be warning-free. Likewise `cancel_maker` takes
//                   `&Vault` — a cancel mutates no vault state.
//               (e) `book_mid` is split into `try_book_mid -> Option<u128>` (the primitive) and
//                   `book_mid -> u128` (aborts EEmptyBook). E-M7: the hBTC/DBUSDC book is empty
//                   on BOTH sides right now, so NAV needs a defined non-aborting read.
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
// @forbidden  pool::mid_price / best_bid_price / best_ask_price / place_post_only_limit_order
//             — E-M6, E-M7 (absent from the deployed package, or aborts on an empty book)
// @invariant  1. object::id(pool) == vault::pool_id(vault), else EWrongPool.
// @invariant  2. No non-DeepBook venue import or code path exists in this module (G4).
// @invariant  3. The maker leg is POST_ONLY; a placement that did not rest passively aborts
//                ENotPostOnly.
// @invariant  4. price % tick == 0 (EBadTick), quantity % lot == 0 (EBadLot),
//                quantity >= min_size (EBelowMinSize) — values passed as config.
// @invariant  5. EVERY capital-DEPLOYING entrypoint calls the keeper gate then
//                envelope::check_action BEFORE touching the book. See delta (d) for cancel.
// @invariant  6. Self-match handling is explicit on every placement: the maker leg cannot
//                self-match at all (POST_ONLY aborts if it executes ANY quantity), and the IOC
//                leg carries CANCEL_MAKER, which expires the vault's own resting order instead
//                of trading with itself.
// @invariant  7. NAV valuation uses the DeepBook mid, never a raw oracle price (G9). This module
//                never reads an oracle; `oracle_mid` is passed straight through to the envelope's
//                divergence breaker and prices nothing.
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

/// DeepBook v3 `FLOAT_SCALING`: `quote = base * price / 1e9`, so the realised average price of a
/// fill is `cumulative_quote * 1e9 / filled_base`.
const DEEPBOOK_PRICE_SCALING: u128 = 1_000_000_000;

/// `place_limit_order`'s own doc: "For current version pay_with_deep must be true, so the fee
/// will be paid with DEEP tokens." Not a caller knob — a `false` here would silently change the
/// fee asset and the balance the BalanceManager must be funded in.
const PAY_FEES_WITH_DEEP: bool = true;

const MAX_U64_U128: u128 = 18_446_744_073_709_551_615;

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

// ── pure guards ─────────────────────────────────────────────────────────────

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

/// The maker leg must have RESTED PASSIVELY (@invariant 3).
///
/// Two independent conditions, because E-M6 forces us onto the raw `place_limit_order` path
/// instead of the graceful post-only wrapper:
///   - the order type actually submitted was `POST_ONLY` (3);
///   - it executed ZERO quantity, i.e. it took nothing off the book.
///
/// DeepBook itself aborts `EPOSTOrderCrossesOrderbook` before we get here if a POST_ONLY order
/// executes anything, so in practice this is defence in depth against an upgraded matcher — but
/// it is the check that makes "the maker leg is post-only" an assertion of THIS package rather
/// than an assumption about someone else's.
public fun assert_post_only(order_type: u8, executed_quantity: u64) {
    assert!(order_type == constants::post_only(), ENotPostOnly);
    assert!(executed_quantity == 0, ENotPostOnly);
}

/// Realised average fill price in DeepBook FLOAT_SCALING units: `quote * 1e9 / base`.
/// Zero fill ⇒ zero price (an unfilled IOC has no realised price, and `0` is unambiguous
/// because a real DeepBook price is always >= MIN_PRICE = 1).
public fun avg_fill_price(filled_base: u64, cumulative_quote: u64): u64 {
    if (filled_base == 0) return 0;
    let scaled = ((cumulative_quote as u128) * DEEPBOOK_PRICE_SCALING) / (filled_base as u128);
    if (scaled > MAX_U64_U128) MAX_U64_U128 as u64 else scaled as u64
}

// ── NAV mid, derived from the L2 book (E-M7) ────────────────────────────────

/// Pure top-of-book mid from the two L2 price vectors `get_level2_range` returns.
///
/// `get_level2_range` yields bids DESCENDING and asks ASCENDING, so index 0 is the best price on
/// each side. A one-sided or empty book has NO mid and returns `none` — it does not abort, does
/// not fall back to the other side, and does not invent a price (E-M7: the hBTC/DBUSDC book is
/// empty on BOTH sides today, so this is the live path, not the edge case).
///
/// The result is a DeepBook FLOAT_SCALING price widened to u128 — exactly what
/// `vault::nav_sats` expects (`quote_units * 1e9 / book_mid`). No rescaling happens here.
public fun mid_from_levels(bid_prices: &vector<u64>, ask_prices: &vector<u64>): Option<u128> {
    if (bid_prices.is_empty() || ask_prices.is_empty()) return option::none();
    let best_bid = *bid_prices.borrow(0) as u128;
    let best_ask = *ask_prices.borrow(0) as u128;
    option::some((best_bid + best_ask) / 2)
}

/// Unwrap a mid or abort `EEmptyBook`. Split out so both the aborting and the non-aborting
/// read share one definition of "there is no mid".
public fun require_mid(mid: Option<u128>): u128 {
    assert!(mid.is_some(), EEmptyBook);
    mid.destroy_some()
}

/// The NAV-safe read: `none` when the book is one-sided or empty. The caller (keeper policy)
/// falls back to the last-known oracle-bounded mid.
///
/// Reads with `get_level2_range` over the full legal price range. NEVER `pool::mid_price`, which
/// aborts `EEmptyOrderbook` on the book's current state (E-M7).
public fun try_book_mid<B, Q>(pool: &Pool<B, Q>, clock: &Clock): Option<u128> {
    let (bid_prices, _bid_qty) = pool::get_level2_range(
        pool,
        constants::min_price(),
        constants::max_price(),
        true,
        clock,
    );
    let (ask_prices, _ask_qty) = pool::get_level2_range(
        pool,
        constants::min_price(),
        constants::max_price(),
        false,
        clock,
    );
    mid_from_levels(&bid_prices, &ask_prices)
}

/// The strict read used where a missing mid is a hard error. Aborts `EEmptyBook`.
public fun book_mid<B, Q>(pool: &Pool<B, Q>, clock: &Clock): u128 {
    require_mid(try_book_mid(pool, clock))
}

// ── access gates ────────────────────────────────────────────────────────────

/// @invariant 1 — the pool handed in must be the one pinned in the vault at creation.
/// The id is never a literal in this module (G7); it arrives as `vault.pool_id`.
public fun assert_pool_matches<B, Q>(vault: &Vault<B, Q>, pool_id: ID) {
    assert!(pool_id == vault::pool_id(vault), EWrongPool);
}

/// Keeper authorization for every entrypoint here.
///
/// `ENotKeeper` is raised for the condition this module can name on its own — the cap's
/// `version_epoch` no longer matches the vault's, i.e. the keeper was rotated out and every
/// previously issued cap is dead (`vault::set_keeper` bumps the epoch). Cap-to-vault identity
/// and the pause flag are then delegated to `vault::assert_keeper`, which surfaces the vault's
/// own `ECapVaultMismatch` / `EPaused` unmasked.
public fun assert_keeper_gate<B, Q>(vault: &Vault<B, Q>, cap: &KeeperCap) {
    assert!(vault::keeper_cap_version_epoch(cap) == vault::version_epoch(vault), ENotKeeper);
    vault::assert_keeper(vault, cap);
}

// ── staging: every decision this module makes lives here ────────────────────
// Mirrors the aphotic::gateway pattern for the same reason: a DeepBook `Pool` cannot be
// constructed inside `sui move test` (it needs the shared `Registry`, a `DeepbookAdminCap` or a
// 500-DEEP creation fee, and `registry::test_registry` is `#[test_only]` inside the DEPENDENCY,
// so it is not linked into this package's test build). Putting every guard in a
// `public(package)` staging function keeps the DeepBook wrappers as literal tails and lets
// move/tests/router_tests.move drive the real logic FOR REAL.

/// The full pre-trade gate for a capital-deploying action, in the order @invariant 5 requires:
/// pool identity -> keeper capability -> venue granularity -> the constraint envelope.
///
/// `envelope::check_action` is what advances the epoch notional and the cooldown clock, and it
/// is called EXACTLY once per action (envelope @invariant 4).
///
/// The sats-denominated notional is `quantity` — see the units note in envelope.move's @facts.
public(package) fun stage_order<B, Q>(
    vault: &mut Vault<B, Q>,
    keeper_cap: &KeeperCap,
    pool_id: ID,
    price: u64,
    quantity: u64,
    tick: u64,
    lot: u64,
    min_size: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
) {
    assert_pool_matches(vault, pool_id);
    assert_keeper_gate(vault, keeper_cap);
    assert_order_granularity(price, quantity, tick, lot, min_size);

    // Read every vault scalar BEFORE taking the mutable envelope borrow.
    let vault_id = object::id(vault);
    let paused = vault::is_paused(vault);
    let idle_sats = vault::idle_btc_value(vault);
    let nav = vault::nav_sats(vault, book_mid);
    let earmarked = vault::total_pending_exit_sats(vault);

    let params = vault::envelope_params_mut(vault, keeper_cap);
    envelope::check_action(
        vault_id,
        paused,
        idle_sats,
        nav,
        earmarked,
        pending_exit_demand_sats,
        projected_capacity_sats,
        params,
        quantity,
        price as u128,
        book_mid,
        oracle_mid,
        clock,
    );
}

/// The reduced gate for `cancel_maker` — pool identity + keeper capability, no envelope.
/// See banner delta (d): a cancel returns capital to idle, so the deployment bounds have nothing
/// to bound, and gating it would trap the vault's quotes on the book exactly when risk says pull
/// them. Pause still blocks it, via `vault::assert_keeper`.
public(package) fun stage_cancel<B, Q>(vault: &Vault<B, Q>, keeper_cap: &KeeperCap, pool_id: ID) {
    assert_pool_matches(vault, pool_id);
    assert_keeper_gate(vault, keeper_cap);
}

// ── the DeepBook boundary (G4: this book, and nothing else) ─────────────────
// The three entrypoints below are the only code in the package that touches a venue. Each is
// stage-then-place; there is no branch, guard or state transition left in them.

/// Maker leg: a POST_ONLY limit order resting on `Pool<B, Q>`. Keeper-only.
///
/// E-M6 forces `place_limit_order(order_type = POST_ONLY, self_matching_option =
/// SELF_MATCHING_ALLOWED)` rather than `place_post_only_limit_order`, which is NOT in the
/// deployed v20 package. `SELF_MATCHING_ALLOWED` is the correct — and the only safe — choice
/// here: a POST_ONLY order that executes ANY quantity aborts upstream
/// (`EPOSTOrderCrossesOrderbook`), so it can never self-match, while `CANCEL_TAKER` would abort
/// against the vault's own EXPIRED order sitting at a crossing price. `assert_post_only` then
/// re-checks passivity on our side (@invariant 3 / 6).
entry fun place_maker<B, Q>(
    vault: &mut Vault<B, Q>,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,
    trade_cap: &TradeCap,
    pool: &mut Pool<B, Q>,
    client_order_id: u64,
    is_bid: bool,
    price: u64,
    quantity: u64,
    expire_ts: u64,
    tick: u64,
    lot: u64,
    min_size: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
    ctx: &TxContext,
) {
    let pool_id = object::id(pool);
    stage_order(
        vault,
        keeper_cap,
        pool_id,
        price,
        quantity,
        tick,
        lot,
        min_size,
        pending_exit_demand_sats,
        projected_capacity_sats,
        book_mid,
        oracle_mid,
        clock,
    );

    // G2: `generate_proof_as_trader` is the ONLY proof path reachable from here, and it consumes
    // a TradeCap. There is no DepositCap/WithdrawCap parameter anywhere in this signature.
    let proof = balance_manager::generate_proof_as_trader(balance_manager, trade_cap, ctx);
    let order_info = pool::place_limit_order(
        pool,
        balance_manager,
        &proof,
        client_order_id,
        constants::post_only(),
        constants::self_matching_allowed(),
        price,
        quantity,
        is_bid,
        PAY_FEES_WITH_DEEP,
        expire_ts,
        clock,
        ctx,
    );
    emit_maker_placed(object::id(vault), is_bid, &order_info);
}

/// IOC sweep of the residual on the SAME book (G4 — there is no other venue, and no AMM leg).
/// Keeper-only. `max_price` bounds the sweep: it is the ceiling for a bid and the floor for an
/// ask, exactly as DeepBook interprets a limit price.
///
/// Self-match prevention is `CANCEL_MAKER` (@invariant 6): if the sweep would cross the vault's
/// OWN resting maker order, that order is expired instead of trading with itself. `CANCEL_TAKER`
/// would abort the whole sweep, and `SELF_MATCHING_ALLOWED` would let the vault wash-trade
/// against itself and pay both sides of the fee.
entry fun sweep_ioc<B, Q>(
    vault: &mut Vault<B, Q>,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,
    trade_cap: &TradeCap,
    pool: &mut Pool<B, Q>,
    client_order_id: u64,
    is_bid: bool,
    max_price: u64,
    quantity: u64,
    tick: u64,
    lot: u64,
    min_size: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
    ctx: &TxContext,
) {
    let pool_id = object::id(pool);
    stage_order(
        vault,
        keeper_cap,
        pool_id,
        max_price,
        quantity,
        tick,
        lot,
        min_size,
        pending_exit_demand_sats,
        projected_capacity_sats,
        book_mid,
        oracle_mid,
        clock,
    );

    let proof = balance_manager::generate_proof_as_trader(balance_manager, trade_cap, ctx);
    // `expire_timestamp = now` satisfies DeepBook's `timestamp <= expire_timestamp` for an order
    // that is not meant to outlive the transaction. IOC cancels whatever it cannot fill.
    let order_info = pool::place_limit_order(
        pool,
        balance_manager,
        &proof,
        client_order_id,
        constants::immediate_or_cancel(),
        constants::cancel_maker(),
        max_price,
        quantity,
        is_bid,
        PAY_FEES_WITH_DEEP,
        clock.timestamp_ms(),
        clock,
        ctx,
    );
    emit_ioc_swept(object::id(vault), is_bid, &order_info);
}

/// Cancel an unfilled maker remainder. Keeper-only; see banner delta (d) for why this one is not
/// envelope-gated.
entry fun cancel_maker<B, Q>(
    vault: &Vault<B, Q>,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,
    trade_cap: &TradeCap,
    pool: &mut Pool<B, Q>,
    order_id: u128,
    clock: &Clock,
    ctx: &TxContext,
) {
    stage_cancel(vault, keeper_cap, object::id(pool));

    let proof = balance_manager::generate_proof_as_trader(balance_manager, trade_cap, ctx);
    pool::cancel_order(pool, balance_manager, &proof, order_id, clock, ctx);

    event::emit(MakerCancelled { vault_id: object::id(vault), order_id });
}

// ── receipts (G10: an event for every externally-visible state transition) ──

/// Asserts passivity, then emits `MakerPlaced`. Separated from `place_maker` so the assertion
/// and the receipt are one unit, and so the OrderInfo accessors appear exactly once.
fun emit_maker_placed(vault_id: ID, is_bid: bool, order_info: &OrderInfo) {
    assert_post_only(order_info.order_type(), order_info.executed_quantity());
    event::emit(MakerPlaced {
        vault_id,
        order_id: order_info.order_id(),
        is_bid,
        price: order_info.price(),
        quantity: order_info.original_quantity(),
    });
}

fun emit_ioc_swept(vault_id: ID, is_bid: bool, order_info: &OrderInfo) {
    let filled_qty = order_info.executed_quantity();
    event::emit(IocSwept {
        vault_id,
        is_bid,
        filled_qty,
        avg_price: avg_fill_price(filled_qty, order_info.cumulative_quote_quantity()),
    });
}

// ── test-only event readers ─────────────────────────────────────────────────
// Event struct fields are module-private; these let move/tests/router_tests.move assert on the
// emitted receipts. They compile out of the published package.

#[test_only]
public fun maker_placed_fields(e: &MakerPlaced): (ID, u128, bool, u64, u64) {
    (e.vault_id, e.order_id, e.is_bid, e.price, e.quantity)
}

#[test_only]
public fun ioc_swept_fields(e: &IocSwept): (ID, bool, u64, u64) {
    (e.vault_id, e.is_bid, e.filled_qty, e.avg_price)
}

#[test_only]
public fun maker_cancelled_fields(e: &MakerCancelled): (ID, u128) { (e.vault_id, e.order_id) }

/// The exact `(order_type, self_matching_option)` pair `place_maker` submits, so a test can pin
/// the maker leg's DeepBook constants without constructing a `Pool` (E-M6).
#[test_only]
public fun maker_order_constants(): (u8, u8) {
    (constants::post_only(), constants::self_matching_allowed())
}

/// The same for the IOC sweep leg.
#[test_only]
public fun ioc_order_constants(): (u8, u8) {
    (constants::immediate_or_cancel(), constants::cancel_maker())
}

#[test_only]
public fun pay_fees_with_deep(): bool { PAY_FEES_WITH_DEEP }

#[test_only]
public fun deepbook_price_scaling(): u128 { DEEPBOOK_PRICE_SCALING }

/// The exact tail of `place_maker` after staging: assert passivity, emit the receipt. Lets the
/// tests drive the real assertion path against a synthesised OrderInfo shape.
#[test_only]
public fun emit_maker_placed_for_testing(
    vault_id: ID,
    is_bid: bool,
    order_type: u8,
    order_id: u128,
    price: u64,
    quantity: u64,
    executed_quantity: u64,
) {
    assert_post_only(order_type, executed_quantity);
    event::emit(MakerPlaced { vault_id, order_id, is_bid, price, quantity });
}

/// The exact tail of `sweep_ioc` after staging.
#[test_only]
public fun emit_ioc_swept_for_testing(
    vault_id: ID,
    is_bid: bool,
    filled_qty: u64,
    cumulative_quote: u64,
) {
    event::emit(IocSwept {
        vault_id,
        is_bid,
        filled_qty,
        avg_price: avg_fill_price(filled_qty, cumulative_quote),
    });
}
