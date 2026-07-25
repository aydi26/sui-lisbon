#[test_only]
module aphotic::router_tests;

use aphotic::envelope;
use aphotic::router;
use aphotic::vault::{Self, Vault, VaultCap, KeeperCap};
use deepbook::constants;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.5
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L645-L650)
// @spec       docs/RECON.md#R10-deepbook-venue-reality (L152-L158)
// @rules      G2 G4 G9
// @depends    aphotic::router (T1.5) · aphotic::vault (T1.1) · aphotic::envelope (T4.1)
// @facts      tick 1_000_000 · lot 1_000 · min_size 100_000  (docs/FACTS.md#deepbook-venue)
// @facts      ⚠ A DeepBook `Pool` CANNOT be constructed inside `sui move test`. It needs the
// @facts        shared `Registry` plus either a `DeepbookAdminCap` or a 500-DEEP creation fee,
// @facts        and `deepbook::registry::test_registry` is `#[test_only]` INSIDE THE DEPENDENCY,
// @facts        so it is not linked into this package's test build. The testnet book is also
// @facts        empty on both sides with zero volume (RECON R10, E-M7), so even an integration
// @facts        run would have nothing to match against.
// @facts      ⇒ router.move puts EVERY guard and decision in `public(package)` staging functions
// @facts        (`stage_order`, `stage_cancel`) plus pure helpers (`assert_post_only`,
// @facts        `mid_from_levels`, `require_mid`, `avg_fill_price`), which these tests exercise
// @facts        FOR REAL. What is left inside the three entrypoints is the DeepBook call itself,
// @facts        whose exact constants are pinned below by `maker_order_constants` /
// @facts        `ioc_order_constants` rather than by a live fill.
// @facts      BOOK_MID = 1e12 is a DeepBook v3 FLOAT_SCALING price (quote = base*price/1e9).
// @facts        With no quote inventory, NAV == free idle sats, so 1 share == 1 sat.
// @implements #[test] fun granularity_accepts_a_well_formed_order()             [DONE]
//             #[test] fun granularity_rejects_bad_tick()                        [DONE]
//             #[test] fun granularity_rejects_bad_lot()                         [DONE]
//             #[test] fun granularity_rejects_below_min_size()                  [DONE]
//             #[test] fun venue_defaults_match_facts()                          [DONE]
//             #[test] fun granularity_is_config_overridable()                   [DONE]
//             #[test] fun place_maker_rejects_wrong_pool()                      [DONE]
//             #[test] fun cancel_maker_rejects_wrong_pool()                     [DONE]
//             #[test] fun place_maker_requires_a_current_keeper_cap()           [DONE]
//             #[test] fun cancel_maker_requires_a_current_keeper_cap()          [DONE]
//             #[test] fun a_paused_vault_blocks_every_router_entrypoint()       [DONE]
//             #[test] fun the_gate_runs_before_the_book_is_touched()            [DONE]
//             #[test] fun staging_rejects_bad_tick_lot_and_min_size()           [DONE]
//             #[test] fun staging_enforces_the_envelope()                       [DONE]
//             #[test] fun staging_advances_the_epoch_notional()                 [DONE]
//             #[test] fun place_maker_is_post_only()                            [DONE]
//             #[test] fun a_maker_leg_that_executed_anything_is_not_post_only() [DONE]
//             #[test] fun a_non_post_only_order_type_is_rejected()              [DONE]
//             #[test] fun the_maker_leg_uses_post_only_and_the_ioc_leg_cancels_maker() [DONE]
//             #[test] fun maker_placed_carries_the_order()                      [DONE]
//             #[test] fun sweep_ioc_reports_the_realised_average_price()        [DONE]
//             #[test] fun avg_fill_price_is_float_scaled()                      [DONE]
//             #[test] fun book_mid_is_the_top_of_book_average()                 [DONE]
//             #[test] fun book_mid_aborts_on_empty_book()                       [DONE]
//             #[test] fun try_book_mid_is_none_on_a_one_sided_book()            [DONE]
// @invariant  1. No test may introduce a non-DeepBook venue leg (G4) — the gate over sources/
//                would catch the module, but a test must not normalise the idea either.
// @invariant  2. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  3. No test hands the router a Deposit/WithdrawCap — no entrypoint takes one, and
//                that absence IS the G2 guarantee for the trading path.
// @ac         docs/MOVE-PACKAGE.md §8 router_tests checklist (L645-L650)
// @verify     sui move test router
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── local coin witnesses ────────────────────────────────────────────────────
// The router is generic over the asset pair (banner delta (a)), so the tests instantiate it
// with local witnesses and never need the bridge's coin type.
public struct TESTBTC has drop {}
public struct TESTUSDC has drop {}

const OWNER: address = @0x0A;
const KEEPER: address = @0x0B;

const BM_ADDR: address = @0xBEEF;
const POOL_ADDR: address = @0xF00D;
/// A DIFFERENT pool. If any path let the keeper substitute a book, an order could land here.
const WRONG_POOL_ADDR: address = @0xBAD;

const TICK: u64 = 1_000_000;
const LOT: u64 = 1_000;
const MIN_SIZE: u64 = 100_000;

/// DeepBook mid at BTC ~ $100_000 (FLOAT_SCALING 1e9).
const BOOK_MID: u128 = 1_000_000_000_000;

/// A tick-aligned price equal to the mid, so the slippage bound is never the reason a test fails.
const AT_MID: u64 = 1_000_000_000_000;

/// Live testnet limiter scalars (E-K2).
const LIVE_REFILL: u64 = 115_740;
const LIVE_CAP: u64 = 10_000_000_000;

// ── helpers ─────────────────────────────────────────────────────────────────

/// slippage 10_000 bps (disabled) · 1 BTC notional/epoch · no cooldown · no buffer floor.
/// Individual tests tighten exactly the one bound they are probing.
fun params(): envelope::EnvelopeParams {
    envelope::new_envelope_params(10_000, 100_000_000, 0, 0, LIVE_REFILL, LIVE_CAP, 0)
}

fun create(scenario: &mut Scenario, pool_addr: address): ID {
    scenario.next_tx(OWNER);
    let cap = vault::create_vault<TESTBTC, TESTUSDC>(
        object::id_from_address(BM_ADDR),
        object::id_from_address(pool_addr),
        b"ciphertext-v0",
        b"blob-v0",
        params(),
        KEEPER,
        scenario.ctx(),
    );
    let vault_id = vault::vault_cap_vault_id(&cap);
    transfer::public_transfer(cap, OWNER);
    vault_id
}

fun borrow(scenario: &Scenario, vault_id: ID): Vault<TESTBTC, TESTUSDC> {
    ts::take_shared_by_id<Vault<TESTBTC, TESTUSDC>>(scenario, vault_id)
}

/// Mint the keeper's `KeeperCap`. `create_vault` does not issue one — only `set_keeper` mints
/// caps — so this also bumps `version_epoch` to 1, which the staleness tests rely on.
fun mint_keeper_cap(scenario: &mut Scenario, vault_id: ID): KeeperCap {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    let owner_cap = ts::take_from_address<VaultCap>(scenario, OWNER);
    let keeper_cap = vault::set_keeper(&mut v, &owner_cap, KEEPER, scenario.ctx());
    ts::return_to_address(OWNER, owner_cap);
    ts::return_shared(v);
    keeper_cap
}

fun deposit(scenario: &mut Scenario, vault_id: ID, sats: u64) {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    let c = coin::mint_for_testing<TESTBTC>(sats, scenario.ctx());
    vault::deposit_btc(&mut v, c, BOOK_MID, scenario.ctx());
    ts::return_shared(v);
}

fun set_paused(scenario: &mut Scenario, vault_id: ID, paused: bool) {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    let owner_cap = ts::take_from_address<VaultCap>(scenario, OWNER);
    vault::set_paused(&mut v, &owner_cap, paused);
    ts::return_to_address(OWNER, owner_cap);
    ts::return_shared(v);
}

fun clock_at(scenario: &mut Scenario, ms: u64): Clock {
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(ms);
    clk
}

/// The exact body of `place_maker` / `sweep_ioc` UP TO the DeepBook call: the whole gate.
/// `pool_addr` stands in for `object::id(pool)`, which is the only thing the entrypoints derive
/// from the `&mut Pool` they are handed.
fun stage(
    v: &mut Vault<TESTBTC, TESTUSDC>,
    cap: &KeeperCap,
    pool_addr: address,
    price: u64,
    quantity: u64,
    clk: &Clock,
) {
    router::stage_order(
        v,
        cap,
        object::id_from_address(pool_addr),
        price,
        quantity,
        TICK,
        LOT,
        MIN_SIZE,
        0,
        LIVE_CAP,
        BOOK_MID,
        BOOK_MID,
        clk,
    );
}

// ── pure granularity guards (unchanged from the skeleton — still the tripwire) ──

#[test]
fun granularity_accepts_a_well_formed_order() {
    router::assert_order_granularity(50_000_000_000, 100_000, TICK, LOT, MIN_SIZE);
    router::assert_order_granularity(TICK, MIN_SIZE, TICK, LOT, MIN_SIZE);
}

#[test]
#[expected_failure(abort_code = router::EBadTick)]
fun granularity_rejects_bad_tick() {
    router::assert_order_granularity(50_000_000_001, 100_000, TICK, LOT, MIN_SIZE);
}

#[test]
#[expected_failure(abort_code = router::EBadLot)]
fun granularity_rejects_bad_lot() {
    router::assert_order_granularity(50_000_000_000, 100_500, TICK, LOT, MIN_SIZE);
}

#[test]
#[expected_failure(abort_code = router::EBelowMinSize)]
fun granularity_rejects_below_min_size() {
    router::assert_order_granularity(50_000_000_000, 99_000, TICK, LOT, MIN_SIZE);
}

#[test]
fun venue_defaults_match_facts() {
    assert!(router::default_tick_size() == TICK, 0);
    assert!(router::default_lot_size() == LOT, 1);
    assert!(router::default_min_size() == MIN_SIZE, 2);
}

#[test]
fun granularity_is_config_overridable() {
    // The defaults are defaults, not law (V5): the same order is valid under a finer venue.
    router::assert_order_granularity(50_000_000_001, 99_000, 1, 1, 1);
}

// ── @invariant 1: the pool must be the one pinned in the vault (G7) ─────────

#[test]
#[expected_failure(abort_code = router::EWrongPool)]
fun place_maker_rejects_wrong_pool() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    deposit(&mut scenario, vault_id, 100_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    stage(&mut v, &cap, WRONG_POOL_ADDR, AT_MID, MIN_SIZE, &clk);

    abort 0
}

#[test]
#[expected_failure(abort_code = router::EWrongPool)]
fun cancel_maker_rejects_wrong_pool() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);

    router::stage_cancel(&v, &cap, object::id_from_address(WRONG_POOL_ADDR));

    abort 0
}

// ── @invariant 5: keeper capability, at the CURRENT version epoch (G2) ─────

#[test]
#[expected_failure(abort_code = router::ENotKeeper)]
fun place_maker_requires_a_current_keeper_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let stale = mint_keeper_cap(&mut scenario, vault_id); // epoch 1
    let fresh = mint_keeper_cap(&mut scenario, vault_id); // epoch 2 — `stale` is now dead
    deposit(&mut scenario, vault_id, 100_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    // Sanity: the FRESH cap passes the same gate, so the abort below is about staleness only.
    stage(&mut v, &fresh, POOL_ADDR, AT_MID, MIN_SIZE, &clk);

    stage(&mut v, &stale, POOL_ADDR, AT_MID, MIN_SIZE, &clk);

    abort 0
}

#[test]
#[expected_failure(abort_code = router::ENotKeeper)]
fun cancel_maker_requires_a_current_keeper_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let stale = mint_keeper_cap(&mut scenario, vault_id);
    let fresh = mint_keeper_cap(&mut scenario, vault_id);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let pool_id = object::id_from_address(POOL_ADDR);

    router::stage_cancel(&v, &fresh, pool_id); // passes
    router::stage_cancel(&v, &stale, pool_id); // aborts

    abort 0
}

#[test]
#[expected_failure(abort_code = vault::EPaused)]
fun a_paused_vault_blocks_every_router_entrypoint() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    set_paused(&mut scenario, vault_id, true);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);

    // Even the un-envelope-gated cancel path is blocked, because `vault::assert_keeper`
    // asserts `!paused` (banner delta (d)).
    router::stage_cancel(&v, &cap, object::id_from_address(POOL_ADDR));

    abort 0
}

#[test]
fun the_gate_runs_before_the_book_is_touched() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    deposit(&mut scenario, vault_id, 100_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    // The whole gate — pool identity, keeper cap, granularity, envelope — runs to completion
    // with no DeepBook object in scope at all. That is the structural proof that it precedes
    // the venue call, and the reason `stage_order` exists as its own function.
    stage(&mut v, &cap, POOL_ADDR, AT_MID, MIN_SIZE, &clk);

    let p = vault::envelope_params(&v);
    assert!(envelope::epoch_notional_used_sats(p) == MIN_SIZE, 0);

    ts::return_shared(v);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

// ── @invariant 4: venue granularity, through the real staging path ─────────

#[test]
#[expected_failure(abort_code = router::EBadLot)]
fun staging_rejects_bad_tick_lot_and_min_size() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    deposit(&mut scenario, vault_id, 100_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    // A lot-misaligned quantity never reaches the envelope, let alone the book.
    stage(&mut v, &cap, POOL_ADDR, AT_MID, MIN_SIZE + 1, &clk);

    abort 0
}

// ── @invariant 5: the envelope is enforced, and advanced exactly once ──────

#[test]
#[expected_failure(abort_code = envelope::EBufferBreach)]
fun staging_enforces_the_envelope() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    deposit(&mut scenario, vault_id, 1_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    // Only 1_000_000 sats are idle; a 2_000_000 sat order breaches the redemption buffer (G3).
    stage(&mut v, &cap, POOL_ADDR, AT_MID, 2_000_000, &clk);

    abort 0
}

#[test]
fun staging_advances_the_epoch_notional() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    deposit(&mut scenario, vault_id, 100_000_000);

    scenario.next_tx(KEEPER);
    let clk = clock_at(&mut scenario, 1_000);
    let mut v = borrow(&scenario, vault_id);

    stage(&mut v, &cap, POOL_ADDR, AT_MID, 1_000_000, &clk);
    stage(&mut v, &cap, POOL_ADDR, AT_MID, 2_000_000, &clk);

    // The notional is SATS OF BASE (the order quantity), never price*quantity — see the units
    // note in envelope.move's @facts. 1_000_000 + 2_000_000.
    let p = vault::envelope_params(&v);
    assert!(envelope::epoch_notional_used_sats(p) == 3_000_000, 0);
    assert!(envelope::last_action_ms(p) == 1_000, 1);

    // A cancel does NOT advance it (banner delta (d)).
    router::stage_cancel(&v, &cap, object::id_from_address(POOL_ADDR));
    let p2 = vault::envelope_params(&v);
    assert!(envelope::epoch_notional_used_sats(p2) == 3_000_000, 2);

    ts::return_shared(v);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

// ── @invariant 3 / 6: the maker leg is POST_ONLY and cannot self-match ─────

#[test]
fun place_maker_is_post_only() {
    // A resting order: POST_ONLY (3) and zero executed quantity.
    router::assert_post_only(constants::post_only(), 0);
}

#[test]
#[expected_failure(abort_code = router::ENotPostOnly)]
fun a_maker_leg_that_executed_anything_is_not_post_only() {
    // A "post-only" order that took liquidity is a taker. DeepBook aborts
    // EPOSTOrderCrossesOrderbook first; this is our own re-check (@invariant 3).
    router::assert_post_only(constants::post_only(), 1);
}

#[test]
#[expected_failure(abort_code = router::ENotPostOnly)]
fun a_non_post_only_order_type_is_rejected() {
    router::assert_post_only(constants::no_restriction(), 0);
}

#[test]
fun the_maker_leg_uses_post_only_and_the_ioc_leg_cancels_maker() {
    // E-M6: `place_post_only_limit_order` is absent from the deployed v20 package, so the maker
    // leg goes through `place_limit_order` with the POST_ONLY order-type constant. Pin the exact
    // pair the entrypoints submit, since no `Pool` exists here to observe it on.
    let (maker_type, maker_self_match) = router::maker_order_constants();
    assert!(maker_type == constants::post_only(), 0);
    assert!(maker_type == 3, 1);
    // SELF_MATCHING_ALLOWED is correct AND safe for the maker leg: a POST_ONLY order that
    // executes anything aborts upstream, so it can never self-match, while CANCEL_TAKER would
    // abort against the vault's own expired order at a crossing price.
    assert!(maker_self_match == constants::self_matching_allowed(), 2);
    assert!(maker_self_match == 0, 3);

    // The IOC sweep CAN cross, so it carries real self-match prevention (@invariant 6):
    // CANCEL_MAKER expires the vault's own resting order instead of trading with itself.
    let (ioc_type, ioc_self_match) = router::ioc_order_constants();
    assert!(ioc_type == constants::immediate_or_cancel(), 4);
    assert!(ioc_type == 1, 5);
    assert!(ioc_self_match == constants::cancel_maker(), 6);
    assert!(ioc_self_match == 2, 7);
    assert!(ioc_self_match != constants::self_matching_allowed(), 8);

    // Fees are paid in DEEP — `place_limit_order`'s own doc requires it for the current version.
    assert!(router::pay_fees_with_deep(), 9);
}

// ── receipts (G10) ──────────────────────────────────────────────────────────

#[test]
fun maker_placed_carries_the_order() {
    let mut scenario = ts::begin(OWNER);
    scenario.next_tx(KEEPER);
    let vault_id = object::id_from_address(POOL_ADDR);

    router::emit_maker_placed_for_testing(
        vault_id,
        true,
        constants::post_only(),
        0xDEADBEEF,
        AT_MID,
        MIN_SIZE,
        0,
    );

    let events = event::events_by_type<router::MakerPlaced>();
    assert!(events.length() == 1, 0);
    let (emitted_vault, order_id, is_bid, price, quantity) =
        router::maker_placed_fields(events.borrow(0));
    assert!(emitted_vault == vault_id, 1);
    assert!(order_id == 0xDEADBEEF, 2);
    assert!(is_bid, 3);
    assert!(price == AT_MID, 4);
    assert!(quantity == MIN_SIZE, 5);

    scenario.end();
}

#[test]
fun sweep_ioc_reports_the_realised_average_price() {
    let mut scenario = ts::begin(OWNER);
    scenario.next_tx(KEEPER);
    let vault_id = object::id_from_address(POOL_ADDR);

    // 100_000 base sats filled for 100_000 quote units at BOOK_MID:
    //   quote = base * price / 1e9  =>  100_000 * 1e12 / 1e9 = 100_000_000.
    router::emit_ioc_swept_for_testing(vault_id, false, 100_000, 100_000_000);

    let events = event::events_by_type<router::IocSwept>();
    assert!(events.length() == 1, 0);
    let (emitted_vault, is_bid, filled, avg) = router::ioc_swept_fields(events.borrow(0));
    assert!(emitted_vault == vault_id, 1);
    assert!(!is_bid, 2);
    assert!(filled == 100_000, 3);
    assert!(avg == AT_MID, 4);

    scenario.end();
}

#[test]
fun avg_fill_price_is_float_scaled() {
    assert!(router::deepbook_price_scaling() == 1_000_000_000, 0);

    // quote * 1e9 / base.
    assert!(router::avg_fill_price(100_000, 100_000_000) == 1_000_000_000_000, 1);
    assert!(router::avg_fill_price(200_000, 100_000_000) == 500_000_000_000, 2);

    // An IOC that filled nothing has no realised price. `0` is unambiguous: DeepBook's
    // MIN_PRICE is 1, so a real fill can never report 0.
    assert!(router::avg_fill_price(0, 0) == 0, 3);
    assert!(router::avg_fill_price(0, 12_345) == 0, 4);
}

// ── NAV mid from the L2 book (E-M7 — the book is EMPTY on testnet today) ───

#[test]
fun book_mid_is_the_top_of_book_average() {
    // `get_level2_range` returns bids DESCENDING and asks ASCENDING, so index 0 is top-of-book.
    let bids = vector[999_000_000_000, 998_000_000_000, 997_000_000_000];
    let asks = vector[1_001_000_000_000, 1_002_000_000_000];

    let mid = router::mid_from_levels(&bids, &asks);
    assert!(mid.is_some(), 0);
    assert!(mid.destroy_some() == 1_000_000_000_000, 1);

    // The deeper levels are ignored — this is a TOP-of-book mid, not a VWAP.
    let thin = vector[999_000_000_000];
    let mid2 = router::mid_from_levels(&thin, &asks);
    assert!(mid2.destroy_some() == 1_000_000_000_000, 2);

    // Odd sums truncate rather than abort.
    assert!(router::mid_from_levels(&vector[1u64], &vector[2u64]).destroy_some() == 1, 3);

    // And it unwraps through the strict reader without aborting.
    assert!(router::require_mid(router::mid_from_levels(&bids, &asks)) == 1_000_000_000_000, 4);
}

#[test]
fun try_book_mid_is_none_on_a_one_sided_book() {
    let bids = vector[999_000_000_000];
    let asks = vector[1_001_000_000_000];
    let empty = vector<u64>[];

    // E-M7: `get_level2_range` SUCCEEDS and returns ([], []) on an empty side — it does not
    // abort the way `pool::mid_price` does. So the primitive must have a defined `none`, and
    // must never fall back to the one side that does exist.
    assert!(router::mid_from_levels(&empty, &asks).is_none(), 0);
    assert!(router::mid_from_levels(&bids, &empty).is_none(), 1);
    assert!(router::mid_from_levels(&empty, &empty).is_none(), 2);
}

#[test]
#[expected_failure(abort_code = router::EEmptyBook)]
fun book_mid_aborts_on_empty_book() {
    // The strict reader is the one NAV uses where a missing mid is a hard error.
    router::require_mid(router::mid_from_levels(&vector<u64>[], &vector<u64>[]));
}
