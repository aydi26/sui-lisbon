#[test_only]
module aphotic_lending::lending_tests;

use aphotic_lending::lending::{Self, Market, AdminCap, LENDING};
use hashi::btc::BTC;
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.lending
// @phase      1
// @status     DONE
// @spec       lending/sources/lending.move — the module banner IS the contract; every
//               @invariant 1-8 there has at least one named test here.
// @rules      G10
// @depends    aphotic_lending::lending
// @facts      hBTC is minted in tests with `coin::mint_for_testing<BTC>` — legitimate because
// @facts        `Coin<T>` is phantom in `T`, so no hashi capability is needed and no hashi
// @facts        function is called. `hashi::treasury::mint` is `public(package)` (RECON R7.1)
// @facts        and is NOT reachable from here, which is exactly why the test mint is used.
// @facts      YEAR_MS = 31_536_000_000 — the module's own `ms_per_year()`, re-derived nowhere.
// @facts      WORKED EXAMPLE pinned by several tests below (all figures exact, not approximate):
// @facts        supply 1_000_000 sats, borrow 800_000, elapsed exactly one year.
// @facts        utilisation = 800_000 / (200_000 + 800_000)          = 8_000 bps  (= the kink)
// @facts        borrow rate  = 0 + 400 * 8_000 / 8_000               =   400 bps
// @facts        interest     = 800_000 * 400 / 10_000                =    32_000 sats
// @facts        reserve cut  = 32_000 * 1_000 / 10_000               =     3_200 sats
// @facts        total_assets = 200_000 + 832_000 - 3_200             = 1_028_800 sats
// @facts        borrow_index = 1e9 * 832_000 / 800_000               = 1_040_000_000
// @implements ── shape, disclosure, defaults ──
//             #[test] a_new_market_is_empty_and_discloses                       [DONE]
//             #[test] the_disclosure_names_the_operator_and_the_risk            [DONE]
//             ── supply side (@invariant 1, 8) ──
//             #[test] the_first_deposit_locks_the_minimum_shares                [DONE]
//             #[test] a_first_deposit_at_the_lock_size_aborts                   [DONE]
//             #[test] a_zero_deposit_aborts                                     [DONE]
//             #[test] withdraw_returns_principal_when_nothing_was_borrowed      [DONE]
//             #[test] the_locked_shares_are_never_redeemable                    [DONE]
//             #[test] the_supply_cap_binds                                      [DONE]
//             ── no invented yield (@invariant 2) ──
//             #[test] with_no_borrowers_a_year_of_time_creates_nothing          [DONE]
//             #[test] project_accrual_returns_zero_interest_without_borrowers   [DONE]
//             ── real yield, from real borrowing ──
//             #[test] interest_accrues_only_while_capital_is_borrowed           [DONE]
//             #[test] the_share_price_rises_with_accrued_interest               [DONE]
//             #[test] a_later_depositor_buys_in_at_the_higher_share_price       [DONE]
//             ── purity of the projection (@invariant 6) ──
//             #[test] project_accrual_matches_what_accrue_writes                [DONE]
//             #[test] convert_to_assets_now_projects_without_writing            [DONE]
//             ── the reserve cut is a cut of interest (@invariant 4) ──
//             #[test] the_reserve_cut_is_taken_out_of_interest_only             [DONE]
//             #[test] withdraw_reserves_pays_the_accrued_cut                    [DONE]
//             #[test] withdraw_reserves_cannot_reach_supplier_principal         [DONE]
//             #[test] withdraw_reserves_cannot_conjure_absent_cash              [DONE]
//             ── borrow side ──
//             #[test] borrowing_without_a_credit_line_aborts                    [DONE]
//             #[test] borrowing_past_the_credit_line_aborts                     [DONE]
//             #[test] borrowing_past_available_liquidity_aborts                 [DONE]
//             #[test] repay_reduces_the_debt_and_returns_the_change             [DONE]
//             #[test] repaying_without_a_debt_aborts                            [DONE]
//             ── solvency of the claim (@invariant 3) ──
//             #[test] a_supplier_cannot_withdraw_capital_that_is_lent_out       [DONE]
//             ── suppliers can always exit (@invariant 5) ──
//             #[test] a_pause_stops_new_supply                                  [DONE]
//             #[test] a_pause_stops_new_borrowing                               [DONE]
//             #[test] a_pause_never_stops_withdrawal_or_repayment               [DONE]
//             ── the rate curve ──
//             #[test] the_rate_curve_kinks_where_it_says_it_does                [DONE]
//             #[test] the_supply_rate_is_net_of_utilisation_and_the_reserve_factor [DONE]
//             ── governance ──
//             #[test] a_foreign_admin_cap_cannot_govern                         [DONE]
//             #[test] the_interest_model_rejects_a_zero_kink                    [DONE]
//             #[test] the_interest_model_rejects_a_full_kink                    [DONE]
//             #[test] the_interest_model_rejects_an_operator_majority_cut       [DONE]
//             #[test] changing_the_model_accrues_at_the_old_one_first           [DONE]
//             #[test] revoking_an_indebted_borrower_aborts                      [DONE]
//             #[test] revoking_a_repaid_borrower_succeeds                       [DONE]
// @invariant  1. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  2. No test weakens a source invariant to pass; every `expected_failure` names the
//                error constant by symbol.
// @verify     sui move test
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;
const SUPPLIER: address = @0x5;
const OTHER_SUPPLIER: address = @0x6;
const BORROWER: address = @0xB0;

const T0: u64 = 1_000_000;
const YEAR_MS: u64 = 31_536_000_000;

// ── fixtures ────────────────────────────────────────────────────────────────

fun begin(): (Scenario, Clock, Market, AdminCap) {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(T0);
    let (market, admin) = lending::new_market_for_testing(scenario.ctx());
    (scenario, clock, market, admin)
}

fun finish(scenario: Scenario, clock: Clock, market: Market, admin: AdminCap) {
    destroy(market);
    destroy(admin);
    clock.destroy_for_testing();
    scenario.end();
}

fun hbtc(scenario: &mut Scenario, sats: u64): Coin<BTC> {
    coin::mint_for_testing<BTC>(sats, scenario.ctx())
}

/// Supply `sats` as `who`, returning the share coin.
fun supply(
    scenario: &mut Scenario,
    market: &mut Market,
    clock: &Clock,
    who: address,
    sats: u64,
): Coin<LENDING> {
    scenario.next_tx(who);
    let coin_in = hbtc(scenario, sats);
    lending::deposit(market, coin_in, clock, scenario.ctx())
}

/// Approve `BORROWER` for `limit` and draw `sats`.
fun draw(
    scenario: &mut Scenario,
    market: &mut Market,
    admin: &AdminCap,
    clock: &Clock,
    limit: u64,
    sats: u64,
): Coin<BTC> {
    scenario.next_tx(ADMIN);
    lending::set_credit_line(admin, market, BORROWER, limit);
    scenario.next_tx(BORROWER);
    lending::borrow(market, sats, clock, scenario.ctx())
}

// ── shape, disclosure, defaults ─────────────────────────────────────────────

#[test]
fun a_new_market_is_empty_and_discloses() {
    let (scenario, clock, market, admin) = begin();

    assert!(lending::total_assets(&market) == 0, 0);
    assert!(lending::total_shares(&market) == 0, 1);
    assert!(lending::cash_sats(&market) == 0, 2);
    assert!(lending::total_borrows_sats(&market) == 0, 3);
    assert!(lending::protocol_reserves_sats(&market) == 0, 4);
    assert!(lending::borrow_index(&market) == lending::index_scale(), 5);
    assert!(!lending::is_paused(&market), 6);
    assert!(lending::utilisation_bps(&market) == 0, 7);
    assert!(lending::borrow_rate_bps(&market) == 0, 8);
    // "no position" is a value, not an error
    assert!(lending::convert_to_assets(&market, 1_000) == 0, 9);
    assert!(lending::admin_market_id(&admin) == object::id(&market), 10);

    let (base, slope1, kink, slope2, reserve_factor) = lending::interest_model(&market);
    assert!(base == 0 && slope1 == 400 && kink == 8_000, 11);
    assert!(slope2 == 6_000 && reserve_factor == 1_000, 12);
    assert!(lending::ms_per_year() == YEAR_MS, 13);
    assert!(lending::bps_denominator() == 10_000, 14);
    assert!(lending::minimum_locked_shares() == 1_000, 15);

    finish(scenario, clock, market, admin);
}

#[test]
fun the_disclosure_names_the_operator_and_the_risk() {
    // These three reads exist so a front-end physically cannot render the APY of this market
    // without being able to render what it is. See the module's honesty block.
    assert!(lending::is_operator_deployed(), 0);
    assert!(!lending::is_collateralised(), 1);
    assert!(!lending::has_liquidations(), 2);
    assert!(lending::disclosure().length() > 100, 3);
}

// ── supply side (@invariant 1, 8) ───────────────────────────────────────────

#[test]
fun the_first_deposit_locks_the_minimum_shares() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    // the depositor receives everything except the permanently locked units
    assert!(shares.value() == 999_000, 0);
    assert!(lending::locked_shares(&market) == 1_000, 1);
    assert!(lending::total_shares(&market) == 1_000_000, 2);
    // shares were minted against sats that actually arrived (@invariant 1)
    assert!(lending::cash_sats(&market) == 1_000_000, 3);
    assert!(lending::total_assets(&market) == 1_000_000, 4);
    assert!(lending::convert_to_assets(&market, 999_000) == 999_000, 5);
    assert!(lending::convert_to_assets(&market, 1_000_000) == 1_000_000, 6);

    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
#[expected_failure(abort_code = lending::EBelowMinimumInitialDeposit)]
fun a_first_deposit_at_the_lock_size_aborts() {
    let (mut scenario, clock, mut market, _admin) = begin();
    // exactly MINIMUM_LOCKED_SHARES would leave the first depositor with nothing
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000);
    destroy(shares);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EZeroAmount)]
fun a_zero_deposit_aborts() {
    let (mut scenario, clock, mut market, _admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 0);
    destroy(shares);
    abort
}

#[test]
fun withdraw_returns_principal_when_nothing_was_borrowed() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    scenario.next_tx(SUPPLIER);
    let out = lending::withdraw(&mut market, shares, &clock, scenario.ctx());
    assert!(out.value() == 999_000, 0);
    assert!(lending::cash_sats(&market) == 1_000, 1);

    destroy(out);
    finish(scenario, clock, market, admin);
}

#[test]
fun the_locked_shares_are_never_redeemable() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    scenario.next_tx(SUPPLIER);
    let out = lending::withdraw(&mut market, shares, &clock, scenario.ctx());

    // every user share is gone, but the supply can never fall back to zero (@invariant 8),
    // so the "first depositor" branch can never be re-entered against a funded market.
    assert!(lending::total_shares(&market) == 1_000, 0);
    assert!(lending::locked_shares(&market) == 1_000, 1);
    assert!(lending::total_assets(&market) == 1_000, 2);
    assert!(lending::convert_to_assets(&market, 1_000) == 1_000, 3);

    destroy(out);
    finish(scenario, clock, market, admin);
}

#[test]
#[expected_failure(abort_code = lending::ESupplyCapExceeded)]
fun the_supply_cap_binds() {
    let (mut scenario, clock, mut market, admin) = begin();
    scenario.next_tx(ADMIN);
    lending::set_supply_cap(&admin, &mut market, 1_000_000);
    let first = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    destroy(first);
    let second = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1);
    destroy(second);
    abort
}

// ── no invented yield (@invariant 2) ────────────────────────────────────────

#[test]
fun with_no_borrowers_a_year_of_time_creates_nothing() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    let index_before = lending::borrow_index(&market);
    clock.set_for_testing(T0 + YEAR_MS);
    lending::accrue(&mut market, &clock);

    // A year passed. Nobody borrowed. Nothing was created — there is no yield constant here.
    assert!(lending::total_assets(&market) == 1_000_000, 0);
    assert!(lending::total_borrows_sats(&market) == 0, 1);
    assert!(lending::protocol_reserves_sats(&market) == 0, 2);
    assert!(lending::borrow_index(&market) == index_before, 3);
    assert!(lending::convert_to_assets(&market, 999_000) == 999_000, 4);
    assert!(lending::convert_to_assets_now(&market, 999_000, &clock) == 999_000, 5);

    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun project_accrual_returns_zero_interest_without_borrowers() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    // ten years, still nothing
    let (borrows, reserves, interest) = lending::project_accrual(
        &market,
        T0 + YEAR_MS * 10,
    );
    assert!(borrows == 0, 0);
    assert!(reserves == 0, 1);
    assert!(interest == 0, 2);

    destroy(shares);
    finish(scenario, clock, market, admin);
}

// ── real yield, from real borrowing ─────────────────────────────────────────

#[test]
fun interest_accrues_only_while_capital_is_borrowed() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    // exactly at the kink
    assert!(lending::utilisation_bps(&market) == 8_000, 0);
    assert!(lending::borrow_rate_bps(&market) == 400, 1);
    assert!(lending::cash_sats(&market) == 200_000, 2);

    clock.set_for_testing(T0 + YEAR_MS);
    lending::accrue(&mut market, &clock);

    assert!(lending::total_borrows_sats(&market) == 832_000, 3);
    assert!(lending::protocol_reserves_sats(&market) == 3_200, 4);
    assert!(lending::borrow_index(&market) == 1_040_000_000, 5);
    assert!(lending::debt_of(&market, BORROWER) == 832_000, 6);
    assert!(lending::total_assets(&market) == 1_028_800, 7);
    // the interest is a claim on the borrower, not cash that appeared
    assert!(lending::cash_sats(&market) == 200_000, 8);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun the_share_price_rises_with_accrued_interest() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    assert!(lending::convert_to_assets(&market, 999_000) == 999_000, 0);
    clock.set_for_testing(T0 + YEAR_MS);
    lending::accrue(&mut market, &clock);

    // 999_000 * 1_028_800 / 1_000_000, floored
    assert!(lending::convert_to_assets(&market, 999_000) == 1_027_771, 1);
    assert!(lending::convert_to_assets(&market, 999_000) > 999_000, 2);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun a_later_depositor_buys_in_at_the_higher_share_price() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let first = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    clock.set_for_testing(T0 + YEAR_MS);

    let second = supply(&mut scenario, &mut market, &clock, OTHER_SUPPLIER, 1_000_000);
    // 1_000_000 * 1_000_000 / 1_028_800, floored — strictly fewer shares than the first
    // depositor got for the same sats, because the pool is worth more per share now.
    assert!(second.value() == 972_006, 0);
    assert!(second.value() < first.value(), 1);
    assert!(lending::total_shares(&market) == 1_972_006, 2);

    destroy(second);
    destroy(drawn);
    destroy(first);
    finish(scenario, clock, market, admin);
}

// ── purity of the projection (@invariant 6) ─────────────────────────────────

#[test]
fun project_accrual_matches_what_accrue_writes() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    let at_ms = T0 + YEAR_MS / 2;
    let (projected_borrows, projected_reserves, projected_interest) = lending::project_accrual(
        &market,
        at_ms,
    );
    let projected_assets = lending::projected_total_assets(&market, at_ms);
    assert!(projected_interest > 0, 0);

    clock.set_for_testing(at_ms);
    lending::accrue(&mut market, &clock);

    assert!(lending::total_borrows_sats(&market) == projected_borrows, 1);
    assert!(lending::protocol_reserves_sats(&market) == projected_reserves, 2);
    assert!(lending::total_assets(&market) == projected_assets, 3);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun convert_to_assets_now_projects_without_writing() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    clock.set_for_testing(T0 + YEAR_MS);
    let projected = lending::convert_to_assets_now(&market, 999_000, &clock);
    // the read did NOT advance the market
    assert!(lending::last_accrual_ms(&market) == T0, 0);
    assert!(lending::convert_to_assets(&market, 999_000) == 999_000, 1);
    assert!(projected == 1_027_771, 2);

    // and it is exactly what the write then produces
    lending::accrue(&mut market, &clock);
    assert!(lending::convert_to_assets(&market, 999_000) == projected, 3);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

// ── the reserve cut is a cut of interest (@invariant 4) ─────────────────────

#[test]
fun the_reserve_cut_is_taken_out_of_interest_only() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    // a year of idle capital: a management fee on AUM would have taken 1_000 sats here.
    clock.set_for_testing(T0 + YEAR_MS);
    lending::accrue(&mut market, &clock);
    assert!(lending::protocol_reserves_sats(&market) == 0, 0);

    // once interest exists, the cut is exactly reserve_factor x interest and nothing else
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    clock.set_for_testing(T0 + YEAR_MS * 2);
    lending::accrue(&mut market, &clock);
    assert!(lending::protocol_reserves_sats(&market) == 3_200, 1);
    assert!(lending::total_borrows_sats(&market) == 832_000, 2);
    assert!(3_200u64 == 32_000u64 / 10, 3);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun withdraw_reserves_pays_the_accrued_cut() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    clock.set_for_testing(T0 + YEAR_MS);

    scenario.next_tx(ADMIN);
    let taken = lending::withdraw_reserves(&admin, &mut market, 3_200, &clock, scenario.ctx());
    assert!(taken.value() == 3_200, 0);
    assert!(lending::protocol_reserves_sats(&market) == 0, 1);
    assert!(lending::cash_sats(&market) == 196_800, 2);
    // suppliers are unaffected: total_assets already excluded the reserve
    assert!(lending::total_assets(&market) == 1_028_800, 3);

    destroy(taken);
    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
#[expected_failure(abort_code = lending::EInsufficientReserves)]
fun withdraw_reserves_cannot_reach_supplier_principal() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    clock.set_for_testing(T0 + YEAR_MS);

    scenario.next_tx(ADMIN);
    // there is plenty of cash, but only 3_200 sats of it is the operator's
    let taken = lending::withdraw_reserves(&admin, &mut market, 3_201, &clock, scenario.ctx());
    destroy(taken);
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EInsufficientLiquidity)]
fun withdraw_reserves_cannot_conjure_absent_cash() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    // fully lent out: reserves accrue, but there is no cash behind them
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 2_000_000, 1_000_000);
    clock.set_for_testing(T0 + YEAR_MS);
    lending::accrue(&mut market, &clock);
    assert!(lending::cash_sats(&market) == 0, 0);
    assert!(lending::protocol_reserves_sats(&market) == 64_000, 1);

    scenario.next_tx(ADMIN);
    let taken = lending::withdraw_reserves(&admin, &mut market, 1, &clock, scenario.ctx());
    destroy(taken);
    destroy(drawn);
    destroy(shares);
    abort
}

// ── borrow side ─────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = lending::ENotAnApprovedBorrower)]
fun borrowing_without_a_credit_line_aborts() {
    let (mut scenario, clock, mut market, _admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    scenario.next_tx(BORROWER);
    let drawn = lending::borrow(&mut market, 1, &clock, scenario.ctx());
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
#[expected_failure(abort_code = lending::ECreditLineExceeded)]
fun borrowing_past_the_credit_line_aborts() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 500_000, 500_001);
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EInsufficientLiquidity)]
fun borrowing_past_available_liquidity_aborts() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    // the credit line is generous; the market simply does not hold the sats
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 9_000_000, 1_000_001);
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
fun repay_reduces_the_debt_and_returns_the_change() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    clock.set_for_testing(T0 + YEAR_MS);

    // partial repayment
    scenario.next_tx(BORROWER);
    let payment = hbtc(&mut scenario, 300_000);
    let change = lending::repay(&mut market, payment, &clock, scenario.ctx());
    assert!(change.value() == 0, 0);
    // 832_000 owed - 300_000 paid. @invariant 7: the remaining scaled debt rounds UP, so this
    // is exactly 532_000 and not 531_999 — the rounding dust stays owed to the pool.
    assert!(lending::debt_of(&market, BORROWER) == 532_000, 1);
    assert!(lending::total_borrows_sats(&market) == 532_000, 2);
    assert!(lending::cash_sats(&market) == 500_000, 3);
    destroy(change);

    // over-payment is returned, not absorbed
    scenario.next_tx(BORROWER);
    let big = hbtc(&mut scenario, 1_000_000);
    let refund = lending::repay(&mut market, big, &clock, scenario.ctx());
    assert!(refund.value() == 468_000, 4);
    assert!(lending::debt_of(&market, BORROWER) == 0, 5);
    assert!(lending::total_borrows_sats(&market) == 0, 6);
    assert!(lending::utilisation_bps(&market) == 0, 7);

    destroy(refund);
    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
#[expected_failure(abort_code = lending::ENoDebt)]
fun repaying_without_a_debt_aborts() {
    let (mut scenario, clock, mut market, _admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    scenario.next_tx(BORROWER);
    let payment = hbtc(&mut scenario, 1);
    let change = lending::repay(&mut market, payment, &clock, scenario.ctx());
    destroy(change);
    destroy(shares);
    abort
}

// ── solvency of the claim (@invariant 3) ────────────────────────────────────

#[test]
#[expected_failure(abort_code = lending::EInsufficientLiquidity)]
fun a_supplier_cannot_withdraw_capital_that_is_lent_out() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    // the claim is good — only 200_000 sats of it are liquid right now
    assert!(lending::convert_to_assets(&market, 999_000) == 999_000, 0);
    assert!(lending::available_liquidity_sats(&market) == 200_000, 1);

    scenario.next_tx(SUPPLIER);
    let out = lending::withdraw(&mut market, shares, &clock, scenario.ctx());
    destroy(out);
    destroy(drawn);
    abort
}

// ── suppliers can always exit (@invariant 5) ────────────────────────────────

#[test]
#[expected_failure(abort_code = lending::EMarketPaused)]
fun a_pause_stops_new_supply() {
    let (mut scenario, clock, mut market, admin) = begin();
    scenario.next_tx(ADMIN);
    lending::set_paused(&admin, &mut market, true);
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    destroy(shares);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EMarketPaused)]
fun a_pause_stops_new_borrowing() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    scenario.next_tx(ADMIN);
    lending::set_credit_line(&admin, &mut market, BORROWER, 1_000_000);
    lending::set_paused(&admin, &mut market, true);
    scenario.next_tx(BORROWER);
    let drawn = lending::borrow(&mut market, 1, &clock, scenario.ctx());
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
fun a_pause_never_stops_withdrawal_or_repayment() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 500_000);
    clock.set_for_testing(T0 + YEAR_MS);

    scenario.next_tx(ADMIN);
    lending::set_paused(&admin, &mut market, true);
    assert!(lending::is_paused(&market), 0);

    // a paused market must never trap a borrower's ability to reduce debt...
    scenario.next_tx(BORROWER);
    let payment = hbtc(&mut scenario, 1_000_000);
    let change = lending::repay(&mut market, payment, &clock, scenario.ctx());
    assert!(lending::debt_of(&market, BORROWER) == 0, 1);

    // ...nor a supplier's ability to leave.
    scenario.next_tx(SUPPLIER);
    let out = lending::withdraw(&mut market, shares, &clock, scenario.ctx());
    assert!(out.value() > 999_000, 2);

    destroy(out);
    destroy(change);
    destroy(drawn);
    finish(scenario, clock, market, admin);
}

// ── the rate curve ──────────────────────────────────────────────────────────

#[test]
fun the_rate_curve_kinks_where_it_says_it_does() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);

    // idle: nothing borrowed, nothing charged
    assert!(lending::utilisation_bps(&market) == 0, 0);
    assert!(lending::borrow_rate_bps(&market) == 0, 1);

    // below the kink: slope1, linearly
    let a = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 400_000);
    assert!(lending::utilisation_bps(&market) == 4_000, 2);
    assert!(lending::borrow_rate_bps(&market) == 200, 3);

    // at the kink
    scenario.next_tx(BORROWER);
    let b = lending::borrow(&mut market, 400_000, &clock, scenario.ctx());
    assert!(lending::utilisation_bps(&market) == 8_000, 4);
    assert!(lending::borrow_rate_bps(&market) == 400, 5);

    // fully drawn: slope2 bites hard, which is what makes the last satoshi expensive
    scenario.next_tx(BORROWER);
    let c = lending::borrow(&mut market, 200_000, &clock, scenario.ctx());
    assert!(lending::utilisation_bps(&market) == 10_000, 6);
    assert!(lending::borrow_rate_bps(&market) == 6_400, 7);

    destroy(a);
    destroy(b);
    destroy(c);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
fun the_supply_rate_is_net_of_utilisation_and_the_reserve_factor() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    // borrow 400 bps x utilisation 8_000 bps = 320 bps gross, less the 1_000 bps cut = 288 bps
    assert!(lending::borrow_rate_bps(&market) == 400, 0);
    assert!(lending::supply_rate_bps(&market) == 288, 1);
    // the supplier never earns the borrow rate — that is the whole point of the two numbers
    assert!(lending::supply_rate_bps(&market) < lending::borrow_rate_bps(&market), 2);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

// ── governance ──────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = lending::EWrongMarket)]
fun a_foreign_admin_cap_cannot_govern() {
    let (mut scenario, clock, mut market_one, admin_one) = begin();
    let (market_two, admin_two) = lending::new_market_for_testing(scenario.ctx());
    lending::set_paused(&admin_two, &mut market_one, true);
    destroy(market_two);
    destroy(admin_two);
    destroy(admin_one);
    destroy(market_one);
    destroy(clock);
    scenario.end();
    abort
}

#[test]
#[expected_failure(abort_code = lending::EInvalidInterestModel)]
fun the_interest_model_rejects_a_zero_kink() {
    let (mut scenario, clock, mut market, admin) = begin();
    scenario.next_tx(ADMIN);
    lending::set_interest_model(&admin, &mut market, 0, 400, 0, 6_000, 1_000, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EInvalidInterestModel)]
fun the_interest_model_rejects_a_full_kink() {
    let (mut scenario, clock, mut market, admin) = begin();
    scenario.next_tx(ADMIN);
    lending::set_interest_model(&admin, &mut market, 0, 400, 10_000, 6_000, 1_000, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = lending::EInvalidInterestModel)]
fun the_interest_model_rejects_an_operator_majority_cut() {
    let (mut scenario, clock, mut market, admin) = begin();
    scenario.next_tx(ADMIN);
    // the operator may never take more than half of the interest
    lending::set_interest_model(&admin, &mut market, 0, 400, 8_000, 6_000, 5_001, &clock);
    abort
}

#[test]
fun changing_the_model_accrues_at_the_old_one_first() {
    let (mut scenario, mut clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);

    clock.set_for_testing(T0 + YEAR_MS);
    scenario.next_tx(ADMIN);
    lending::set_interest_model(&admin, &mut market, 0, 40_000, 8_000, 6_000, 2_000, &clock);

    // the elapsed year was priced at the OLD 400 bps, not retroactively at the new 40_000
    assert!(lending::total_borrows_sats(&market) == 832_000, 0);
    assert!(lending::protocol_reserves_sats(&market) == 3_200, 1);
    assert!(lending::last_accrual_ms(&market) == T0 + YEAR_MS, 2);
    // and the new model applies from here on
    let (_base, slope1, _kink, _slope2, reserve_factor) = lending::interest_model(&market);
    assert!(slope1 == 40_000 && reserve_factor == 2_000, 3);

    destroy(drawn);
    destroy(shares);
    finish(scenario, clock, market, admin);
}

#[test]
#[expected_failure(abort_code = lending::EBorrowerStillIndebted)]
fun revoking_an_indebted_borrower_aborts() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    scenario.next_tx(ADMIN);
    lending::revoke_credit_line(&admin, &mut market, BORROWER, &clock);
    destroy(drawn);
    destroy(shares);
    abort
}

#[test]
fun revoking_a_repaid_borrower_succeeds() {
    let (mut scenario, clock, mut market, admin) = begin();
    let shares = supply(&mut scenario, &mut market, &clock, SUPPLIER, 1_000_000);
    let drawn = draw(&mut scenario, &mut market, &admin, &clock, 1_000_000, 800_000);
    assert!(lending::is_approved_borrower(&market, BORROWER), 0);
    assert!(lending::credit_line_of(&market, BORROWER) == 1_000_000, 1);

    scenario.next_tx(BORROWER);
    let change = lending::repay(&mut market, drawn, &clock, scenario.ctx());
    assert!(lending::debt_of(&market, BORROWER) == 0, 2);

    scenario.next_tx(ADMIN);
    lending::revoke_credit_line(&admin, &mut market, BORROWER, &clock);
    assert!(!lending::is_approved_borrower(&market, BORROWER), 3);
    assert!(lending::credit_line_of(&market, BORROWER) == 0, 4);

    destroy(change);
    destroy(shares);
    finish(scenario, clock, market, admin);
}
