#[test_only]
module aphotic::router_tests;

use aphotic::router;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.5
// @phase      1  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L645-L650)
// @spec       docs/RECON.md#R10-deepbook-venue-reality (L152-L158)
// @rules      G2 G4 G9
// @depends    aphotic::router (T1.5) · aphotic::vault (T1.1) · deepbook (external)
// @facts      tick 1_000_000 · lot 1_000 · min_size 100_000  (docs/FACTS.md#deepbook-venue)
// @facts      ⚠ The testnet book has ZERO volume (RECON R10) — a book-touching test needs a
// @facts        pool seeded inside test_scenario, or must be deferred to an integration run.
// @implements #[test] fun granularity_accepts_a_well_formed_order()             [DONE]
//             #[test] fun granularity_rejects_bad_tick()                        [DONE]
//             #[test] fun granularity_rejects_bad_lot()                         [DONE]
//             #[test] fun granularity_rejects_below_min_size()                  [DONE]
//             #[test] fun venue_defaults_match_facts()                          [DONE]
//             #[test] fun granularity_is_config_overridable()                   [DONE]
//             #[test] fun place_maker_rejects_wrong_pool()                      [TODO(T1.5)]
//             #[test] fun place_maker_requires_keeper_cap()                     [TODO(T1.5)]
//             #[test] fun place_maker_is_post_only()                            [TODO(T1.5)]
//             #[test] fun sweep_ioc_fills_on_the_same_book()                    [TODO(T1.5)]
//             #[test] fun book_mid_aborts_on_empty_book()                       [TODO(T1.5)]
// @invariant  1. No test may introduce a non-DeepBook venue leg (G4) — the gate over sources/
//                would catch the module, but a test must not normalise the idea either.
// @ac         docs/MOVE-PACKAGE.md §8 router_tests checklist (L645-L650)
// @verify     sui move test router
// └── END CONTRACT ───────────────────────────────────────────────────────────

const TICK: u64 = 1_000_000;
const LOT: u64 = 1_000;
const MIN_SIZE: u64 = 100_000;

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

// TODO(T1.5): place_maker aborts EWrongPool when object::id(pool) != vault::pool_id (G7).
// TODO(T1.5): place_maker / sweep_ioc / cancel_maker abort ENotKeeper without a current-epoch
//             KeeperCap, and each calls envelope::check_action BEFORE touching the book.
// TODO(T1.5): the maker leg is POST_ONLY — a placement that would cross must not rest as a
//             taker; ENotPostOnly. Self-match prevention is enabled.
// TODO(T1.5): sweep_ioc fills on the SAME book as the maker leg; no other venue is reachable (G4).
// TODO(T1.5): book_mid aborts EEmptyBook on a one-sided or empty book (RECON R10 — zero volume).
// TODO(T1.5): the keeper path never reaches a Deposit/WithdrawCap; TradeCap only (G2).
