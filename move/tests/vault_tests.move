#[test_only]
module aphotic::vault_tests;

use aphotic::envelope;
use aphotic::vault::{Self, Vault, VaultCap, KeeperCap};
use sui::balance;
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.1, T1.2
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L629-L636)
// @spec       docs/MOVE-PACKAGE.md#module-vault (L120-L306)
// @rules      G1 G2 G9
// @depends    aphotic::vault (T1.1, T1.2) · aphotic::envelope (T4.1)
// @facts      Uses sui::test_scenario. The vault is generic, so B and Q are instantiated with
// @facts        local `TESTBTC` / `TESTUSDC` witnesses plus coin::mint_for_testing and
// @facts        balance::create_for_testing — these tests never need the bridge package (G7).
// @facts      BOOK_MID is a DeepBook v3 price (FLOAT_SCALING 1e9): quote = base * price / 1e9.
// @facts        BOOK_MID = 1e12 means 1 sat costs 1_000 DBUSDC units (1e-6 USD each), i.e.
// @facts        BTC ≈ $100_000. BOOK_MID_2X = 2e12 is the same book at BTC ≈ $200_000, where a
// @facts        given quote balance is worth HALF as many sats. That difference is exactly what
// @facts        `nav_uses_book_mid_not_oracle` pins (G9).
// @facts      Share math: first deposit shares == deposit_sats; then
// @facts        mul_div(deposit_sats, total_shares, nav_before_sats).
// @facts      SEAL IDENTITY = 32-byte vault object id ‖ big-endian u64 epoch (40 bytes total),
// @facts        byte-identical to keeper/src/privacy/seal.ts `sealIdentity`.
// @implements #[test] fun vault_starts_empty_and_unpaused()                     [DONE]
//             #[test] fun first_deposit_mints_one_share_per_sat()               [DONE]
//             #[test] fun proportional_deposit_uses_mul_div()                   [DONE]
//             #[test] fun non_zero_deposit_never_mints_zero_shares()            [DONE]
//             #[test] fun zero_deposit_aborts()                                 [DONE]
//             #[test] fun nav_uses_book_mid_not_oracle()                        [DONE]
//             #[test] fun zero_book_mid_aborts()                                [DONE]
//             #[test] fun nav_sats_with_zero_book_mid_aborts()                  [DONE]
//             #[test] fun mul_div_widens_before_dividing()                      [DONE]
//             #[test] fun mul_div_overflow_aborts()                             [DONE]
//             #[test] fun mul_div_zero_denominator_aborts()                     [DONE]
//             #[test] fun total_shares_equals_sum_of_depositor_shares()         [DONE]
//             #[test] fun burn_more_shares_than_owned_aborts()                  [DONE]
//             #[test] fun burn_zero_shares_aborts()                             [DONE]
//             #[test] fun burn_for_unregistered_depositor_aborts()              [DONE]
//             #[test] fun pending_exit_is_an_earmark_on_idle()                  [DONE]
//             #[test] fun emergency_withdraw_cannot_reach_a_pooled_earmark()    [DONE]
//             #[test] fun take_pending_exit_without_a_pool_aborts()             [DONE]
//             #[test] fun exit_address_is_write_once()                          [DONE]
//             #[test] fun exit_address_can_be_pinned_before_first_deposit()     [DONE]
//             #[test] fun exit_address_second_write_aborts()                    [DONE]
//             #[test] fun exit_address_of_unregistered_aborts()                 [DONE]
//             #[test] fun seal_approve_succeeds_for_owner_and_keeper()          [DONE]
//             #[test] fun seal_approve_rejects_wrong_namespace()                [DONE]
//             #[test] fun seal_approve_rejects_malformed_identity_length()      [DONE]
//             #[test] fun seal_approve_rejects_stale_version_epoch()            [DONE]
//             #[test] fun seal_approve_accepts_the_new_epoch_after_rotation()   [DONE]
//             #[test] fun seal_approve_rejects_unauthorized_sender()            [DONE]
//             #[test] fun set_keeper_bumps_version_epoch()                      [DONE]
//             #[test] fun rotated_out_keeper_cap_is_rejected()                  [DONE]
//             #[test] fun keeper_cap_from_another_vault_is_rejected()           [DONE]
//             #[test] fun envelope_params_mut_rejects_a_stale_keeper_cap()      [DONE]
//             #[test] fun update_strategy_does_not_bump_version_epoch()         [DONE]
//             #[test] fun set_envelope_requires_the_matching_vault_cap()        [DONE]
//             #[test] fun emergency_withdraw_requires_vault_cap()               [DONE]
//             #[test] fun emergency_withdraw_requires_the_owner_as_sender()     [DONE]
//             #[test] fun emergency_withdraw_over_idle_aborts()                 [DONE]
//             #[test] fun emergency_withdraw_zero_aborts()                      [DONE]
//             #[test] fun owner_can_emergency_withdraw_while_paused()           [DONE]
//             #[test] fun paused_blocks_deposit()                               [DONE]
//             #[test] fun paused_blocks_keeper_actions()                        [DONE]
//             #[test] fun redemption_still_works_while_paused()                 [DONE]
// @invariant  1. seal_approve must ABORT on denial — a test that expects a `false` return is
//                testing the wrong contract (a successful dry-run IS the authorization).
// @invariant  2. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @ac         docs/MOVE-PACKAGE.md §8 vault_tests checklist (L629-L636)
// @verify     sui move test vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── local coin witnesses (the vault is generic, so the tests never need the bridge, G7) ──
public struct TESTBTC has drop {}
public struct TESTUSDC has drop {}

const OWNER: address = @0x0A;
const KEEPER: address = @0x0B;
const NEW_KEEPER: address = @0x0C;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
const MALLORY: address = @0x3D;

/// DeepBook mid at BTC ≈ $100_000 (see @facts). 1 sat = 1_000 DBUSDC units.
const BOOK_MID: u128 = 1_000_000_000_000;
/// The same book at BTC ≈ $200_000: a quote balance is worth half as many sats.
const BOOK_MID_2X: u128 = 2_000_000_000_000;

const MAX_U64: u64 = 18_446_744_073_709_551_615;

const BM_ADDR: address = @0xBEEF;
const POOL_ADDR: address = @0xF00D;

// ── helpers ─────────────────────────────────────────────────────────────────

fun params(): envelope::EnvelopeParams {
    // Live testnet limiter scalars (ULTRACODE-BRIEF E-K2): 115_740 sats/s into a 100 BTC bucket.
    envelope::new_envelope_params(50, 1_000_000_000, 1_000, 1_000, 115_740, 10_000_000_000, 0)
}

/// Creates + shares a vault owned by `owner`, sends the `VaultCap` to `owner`, returns its ID.
fun create(scenario: &mut Scenario, owner: address, keeper: address): ID {
    scenario.next_tx(owner);
    let cap = vault::create_vault<TESTBTC, TESTUSDC>(
        object::id_from_address(BM_ADDR),
        object::id_from_address(POOL_ADDR),
        b"ciphertext-v0",
        b"blob-v0",
        params(),
        keeper,
        scenario.ctx(),
    );
    let vault_id = vault::vault_cap_vault_id(&cap);
    transfer::public_transfer(cap, owner);
    vault_id
}

fun borrow(scenario: &Scenario, vault_id: ID): Vault<TESTBTC, TESTUSDC> {
    ts::take_shared_by_id<Vault<TESTBTC, TESTUSDC>>(scenario, vault_id)
}

fun deposit(
    scenario: &mut Scenario,
    vault_id: ID,
    who: address,
    sats: u64,
    book_mid: u128,
): u64 {
    scenario.next_tx(who);
    let mut v = borrow(scenario, vault_id);
    let c = coin::mint_for_testing<TESTBTC>(sats, scenario.ctx());
    let shares = vault::deposit_btc(&mut v, c, book_mid, scenario.ctx());
    ts::return_shared(v);
    shares
}

/// Stages idle quote inventory so NAV has a leg that actually depends on `book_mid` (G9).
fun credit_quote(scenario: &mut Scenario, vault_id: ID, units: u64) {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    vault::credit_quote_for_testing(&mut v, balance::create_for_testing<TESTUSDC>(units));
    ts::return_shared(v);
}

/// Rotates the keeper to `keeper` and hands the fresh `KeeperCap` to it.
fun rotate_keeper(scenario: &mut Scenario, owner: address, vault_id: ID, keeper: address) {
    scenario.next_tx(owner);
    let mut v = borrow(scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    let keeper_cap = vault::set_keeper(&mut v, &cap, keeper, scenario.ctx());
    transfer::public_transfer(keeper_cap, keeper);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
}

fun set_paused(scenario: &mut Scenario, owner: address, vault_id: ID, paused: bool) {
    scenario.next_tx(owner);
    let mut v = borrow(scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    vault::set_paused(&mut v, &cap, paused);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
}

/// 32-byte object id ‖ big-endian u64 epoch — the exact layout `seal_approve` decodes.
fun seal_identity(vault_id: ID, epoch: u64): vector<u8> {
    let mut identity = object::id_to_bytes(&vault_id);
    let mut i = 0u8;
    while (i < 8) {
        let shift = (7 - i) * 8;
        identity.push_back(((epoch >> shift) & 0xFF) as u8);
        i = i + 1;
    };
    identity
}

// ── construction ────────────────────────────────────────────────────────────

#[test]
fun vault_starts_empty_and_unpaused() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::total_shares(&v) == 0, 0);
    assert!(vault::idle_btc_value(&v) == 0, 1);
    assert!(vault::quote_value(&v) == 0, 2);
    assert!(!vault::is_paused(&v), 3);
    assert!(vault::owner(&v) == OWNER, 4);
    assert!(vault::keeper(&v) == KEEPER, 5);
    assert!(vault::version_epoch(&v) == 0, 6);
    assert!(vault::pool_id(&v) == object::id_from_address(POOL_ADDR), 7);
    assert!(vault::balance_manager_id(&v) == object::id_from_address(BM_ADDR), 8);
    assert!(vault::strategy_blob_id(&v) == b"blob-v0", 9);
    assert!(vault::strategy_ciphertext(&v) == b"ciphertext-v0", 10);
    // An empty vault has zero NAV at any (non-zero) mid.
    assert!(vault::nav_sats(&v, BOOK_MID) == 0, 11);
    ts::return_shared(v);

    scenario.end();
}

// ── share / NAV accounting (T1.1) ───────────────────────────────────────────

#[test]
fun first_deposit_mints_one_share_per_sat() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    let minted = deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    assert!(minted == 1_000_000, 0);

    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    assert!(vault::total_shares(&v) == 1_000_000, 1);
    assert!(vault::shares_of(&v, ALICE) == 1_000_000, 2);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 3);
    // Bootstrap: 1 share == 1 sat, so NAV after == the deposit.
    assert!(vault::nav_sats(&v, BOOK_MID) == 1_000_000, 4);
    assert!(vault::has_depositor(&v, ALICE), 5);
    assert!(!vault::has_depositor(&v, BOB), 6);
    assert!(vault::shares_of(&v, BOB) == 0, 7);
    ts::return_shared(v);

    scenario.end();
}

#[test]
fun proportional_deposit_uses_mul_div() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    // Alice bootstraps: 1_000_000 shares against 1_000_000 sats of NAV.
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    // The vault earns quote worth another 1_000_000 sats at BOOK_MID => NAV doubles to 2_000_000
    // while total_shares stays at 1_000_000.
    credit_quote(&mut scenario, vault_id, 1_000_000_000);

    scenario.next_tx(BOB);
    let v = borrow(&scenario, vault_id);
    assert!(vault::nav_sats(&v, BOOK_MID) == 2_000_000, 0);
    ts::return_shared(v);

    // Bob pays the higher NAV: mul_div(1_000_000, 1_000_000, 2_000_000) == 500_000.
    let minted = deposit(&mut scenario, vault_id, BOB, 1_000_000, BOOK_MID);
    assert!(minted == vault::mul_div_for_testing(1_000_000, 1_000_000, 2_000_000), 1);
    assert!(minted == 500_000, 2);

    scenario.next_tx(BOB);
    let v = borrow(&scenario, vault_id);
    assert!(vault::total_shares(&v) == 1_500_000, 3);
    assert!(vault::shares_of(&v, BOB) == 500_000, 4);
    assert!(vault::shares_of(&v, ALICE) == 1_000_000, 5);
    // Bob's claim is worth what he paid: 500_000/1_500_000 of 3_000_000 sats == 1_000_000.
    assert!(vault::nav_sats(&v, BOOK_MID) == 3_000_000, 6);
    assert!(
        vault::mul_div_for_testing(500_000, vault::nav_sats(&v, BOOK_MID), 1_500_000) == 1_000_000,
        7,
    );
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EZeroShares)]
fun non_zero_deposit_never_mints_zero_shares() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    // 1_000 shares against 1_000 sats...
    deposit(&mut scenario, vault_id, ALICE, 1_000, BOOK_MID);
    // ...then NAV is inflated to 1_001_000 sats while total_shares stays 1_000.
    credit_quote(&mut scenario, vault_id, 1_000_000_000);

    // mul_div(1, 1_000, 1_001_000) truncates to 0 — that must ABORT, never silently donate.
    deposit(&mut scenario, vault_id, BOB, 1, BOOK_MID);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EZeroDeposit)]
fun zero_deposit_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 0, BOOK_MID);
    scenario.end();
}

#[test]
fun nav_uses_book_mid_not_oracle() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    credit_quote(&mut scenario, vault_id, 1_000_000_000);

    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    // G9: the ONLY price input is the book mid handed in by the caller. Nothing here reads an
    // oracle, and the same state values differently at a different mid.
    assert!(vault::nav_sats(&v, BOOK_MID) == 2_000_000, 0);
    assert!(vault::nav_sats(&v, BOOK_MID_2X) == 1_500_000, 1);
    assert!(vault::nav_sats(&v, BOOK_MID) != vault::nav_sats(&v, BOOK_MID_2X), 2);
    // The base leg is mid-independent; only the quote leg reprices.
    assert!(vault::idle_btc_value(&v) == 1_000_000, 3);
    ts::return_shared(v);

    // And the valuation flows straight into the share price: at BOOK_MID_2X the NAV is
    // 1_500_000, so 1_500_000 sats buys mul_div(1_500_000, 1_000_000, 1_500_000) == 1_000_000.
    let minted = deposit(&mut scenario, vault_id, BOB, 1_500_000, BOOK_MID_2X);
    assert!(minted == 1_000_000, 4);

    scenario.end();
}

#[test]
fun a_base_only_vault_is_valuable_with_no_price_at_all() {
    // The mid converts the QUOTE leg and nothing else, so a vault holding only hBTC has an
    // EXACT sats NAV with no price input. That is the normal state of a pool nobody else
    // makes a market on (our own hBTC/DBUSDC book has no bid side at all), so it must value
    // cleanly rather than abort.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    let minted = deposit(&mut scenario, vault_id, ALICE, 1_000_000, 0);
    assert!(minted == 1_000_000, 0); // 1 share = 1 sat bootstrap, no price consulted

    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    assert!(vault::nav_sats(&v, 0) == 1_000_000, 1);
    // …and it is genuinely mid-independent while the quote leg is empty.
    assert!(vault::nav_sats(&v, BOOK_MID) == 1_000_000, 2);
    assert!(vault::nav_sats(&v, BOOK_MID_2X) == 1_000_000, 3);
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EZeroNav)]
fun nav_sats_still_rejects_a_zero_mid_once_the_quote_leg_is_non_empty() {
    // The guard is not gone, it is correctly placed: the moment there IS a quote balance to
    // convert, a zero mid would divide by zero and must abort.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    credit_quote(&mut scenario, vault_id, 1_000_000_000);

    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    vault::nav_sats(&v, 0);
    ts::return_shared(v);

    scenario.end();
}

#[test]
fun mul_div_widens_before_dividing() {
    // a*b overflows u64 (≈3.4e38) but the u128 intermediate does not, so the result is exact.
    assert!(vault::mul_div_for_testing(MAX_U64, MAX_U64, MAX_U64) == MAX_U64, 0);
    assert!(vault::mul_div_for_testing(1_000_000, 3, 7) == 428_571, 1); // floor, never round up
    assert!(vault::mul_div_for_testing(0, 12_345, 7) == 0, 2);
    assert!(vault::mul_div_for_testing(1, 1_000, 1_001_000) == 0, 3); // the rounding-drain case
}

#[test]
#[expected_failure(abort_code = vault::EOverflow)]
fun mul_div_overflow_aborts() {
    // MAX_U64 * MAX_U64 / 1 does not fit u64 — abort instead of narrowing silently.
    vault::mul_div_for_testing(MAX_U64, MAX_U64, 1);
}

#[test]
#[expected_failure(abort_code = vault::EZeroNav)]
fun mul_div_zero_denominator_aborts() {
    vault::mul_div_for_testing(1, 1, 0);
}

#[test]
fun total_shares_equals_sum_of_depositor_shares() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    deposit(&mut scenario, vault_id, BOB, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    assert!(vault::total_shares(&v) == 2_000_000, 0);
    assert!(vault::shares_of(&v, ALICE) + vault::shares_of(&v, BOB) == vault::total_shares(&v), 1);

    // Burn half of Alice's position: mul_div(500_000, 2_000_000, 2_000_000) == 500_000 sats.
    let redeemed = vault::burn_shares_for_btc(&mut v, ALICE, 500_000, BOOK_MID, scenario.ctx());
    assert!(redeemed.value() == 500_000, 2);
    assert!(vault::total_shares(&v) == 1_500_000, 3);
    assert!(vault::shares_of(&v, ALICE) == 500_000, 4);
    assert!(vault::shares_of(&v, ALICE) + vault::shares_of(&v, BOB) == vault::total_shares(&v), 5);
    assert!(vault::idle_btc_value(&v) == 1_500_000, 6);

    // Re-credit exactly what came out (the reclaim path) and land back where we started.
    vault::recredit(&mut v, ALICE, redeemed, BOOK_MID);
    assert!(vault::total_shares(&v) == 2_000_000, 7);
    assert!(vault::shares_of(&v, ALICE) == 1_000_000, 8);
    assert!(vault::shares_of(&v, ALICE) + vault::shares_of(&v, BOB) == vault::total_shares(&v), 9);
    assert!(vault::idle_btc_value(&v) == 2_000_000, 10);

    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EInsufficientShares)]
fun burn_more_shares_than_owned_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let out = vault::burn_shares_for_btc(&mut v, ALICE, 1_000_001, BOOK_MID, scenario.ctx());
    balance::destroy_for_testing(out);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EZeroShares)]
fun burn_zero_shares_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let out = vault::burn_shares_for_btc(&mut v, ALICE, 0, BOOK_MID, scenario.ctx());
    balance::destroy_for_testing(out);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EUnregisteredDepositor)]
fun burn_for_unregistered_depositor_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(MALLORY);
    let mut v = borrow(&scenario, vault_id);
    let out = vault::burn_shares_for_btc(&mut v, MALLORY, 1, BOOK_MID, scenario.ctx());
    balance::destroy_for_testing(out);
    ts::return_shared(v);
    scenario.end();
}

// ── pooled small exits are an EARMARK, not a second balance (@invariant 3) ──

#[test]
fun pending_exit_is_an_earmark_on_idle() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    assert!(vault::pending_exit_sats(&v, ALICE) == 0, 0);
    assert!(vault::total_pending_exit_sats(&v) == 0, 1);

    // A sub-minimum exit: burn 20_000 shares, then pool the proceeds.
    let small = vault::burn_shares_for_btc(&mut v, ALICE, 20_000, BOOK_MID, scenario.ctx());
    assert!(small.value() == 20_000, 2);
    assert!(vault::idle_btc_value(&v) == 980_000, 3);

    vault::add_pending_exit(&mut v, ALICE, small);
    // The coins went BACK into idle_btc — only the earmark moved.
    assert!(vault::idle_btc_value(&v) == 1_000_000, 4);
    assert!(vault::pending_exit_sats(&v, ALICE) == 20_000, 5);
    assert!(vault::total_pending_exit_sats(&v) == 20_000, 6);
    assert!(vault::total_shares(&v) == 980_000, 7);
    assert!(vault::shares_of(&v, ALICE) == 980_000, 8);
    // @invariant 10: the earmark is NOT part of NAV, so 1 share is still worth exactly 1 sat
    // for everyone who stayed.
    assert!(vault::free_btc_sats(&v) == 980_000, 9);
    assert!(vault::nav_sats(&v, BOOK_MID) == 980_000, 10);

    // Pooling twice accumulates, and the second exit prices at the SAME 1:1 NAV.
    let more = vault::burn_shares_for_btc(&mut v, ALICE, 10_000, BOOK_MID, scenario.ctx());
    assert!(more.value() == 10_000, 11);
    vault::add_pending_exit(&mut v, ALICE, more);
    assert!(vault::pending_exit_sats(&v, ALICE) == 30_000, 12);
    assert!(vault::total_pending_exit_sats(&v) == 30_000, 13);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 14);
    assert!(vault::nav_sats(&v, BOOK_MID) == 970_000, 15);

    // Taking the pool splits exactly the earmarked sats back out and clears it. NAV is
    // unchanged by the take — those sats were never counted.
    let pooled = vault::take_pending_exit(&mut v, ALICE);
    assert!(pooled.value() == 30_000, 16);
    assert!(vault::idle_btc_value(&v) == 970_000, 17);
    assert!(vault::pending_exit_sats(&v, ALICE) == 0, 18);
    assert!(vault::total_pending_exit_sats(&v) == 0, 19);
    assert!(vault::nav_sats(&v, BOOK_MID) == 970_000, 20);
    assert!(vault::total_shares(&v) == 970_000, 21);
    balance::destroy_for_testing(pooled);

    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EInsufficientIdle)]
fun emergency_withdraw_cannot_reach_a_pooled_earmark() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let small = vault::burn_shares_for_btc(&mut v, ALICE, 25_000, BOOK_MID, scenario.ctx());
    vault::add_pending_exit(&mut v, ALICE, small);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 0);
    assert!(vault::free_btc_sats(&v) == 975_000, 1);
    ts::return_shared(v);

    // 1_000_000 sats are physically present, but 25_000 of them belong to a pooled exit.
    scenario.next_tx(OWNER);
    let mut v = borrow(&scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    let out = vault::emergency_withdraw(&mut v, &cap, 1_000_000, scenario.ctx());
    coin::burn_for_testing(out);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::ENothingPending)]
fun take_pending_exit_without_a_pool_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let out = vault::take_pending_exit(&mut v, ALICE);
    balance::destroy_for_testing(out);
    ts::return_shared(v);
    scenario.end();
}

// ── the write-once Bitcoin exit address (G2 anti-redirect) ──────────────────

#[test]
fun exit_address_is_write_once() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    // No address pinned yet: the record exists but the vector is empty.
    assert!(vault::btc_exit_address(&v, ALICE).is_empty(), 0);

    let addr = x"0102030405060708090a0b0c0d0e0f1011121314"; // 20 bytes, P2WPKH
    vault::set_exit_address(&mut v, ALICE, addr);
    assert!(vault::btc_exit_address(&v, ALICE) == addr, 1);
    assert!(vault::btc_exit_address(&v, ALICE).length() == 20, 2);

    // Another depositor's pin is independent and does not disturb Alice's.
    vault::set_exit_address(&mut v, BOB, x"0000000000000000000000000000000000000000");
    assert!(vault::btc_exit_address(&v, ALICE) == addr, 3);
    assert!(vault::btc_exit_address(&v, BOB) != addr, 4);

    ts::return_shared(v);
    scenario.end();
}

#[test]
fun exit_address_can_be_pinned_before_first_deposit() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    assert!(!vault::has_depositor(&v, ALICE), 0);
    vault::set_exit_address(&mut v, ALICE, x"0102030405060708090a0b0c0d0e0f1011121314");
    assert!(vault::has_depositor(&v, ALICE), 1);
    assert!(vault::shares_of(&v, ALICE) == 0, 2);
    assert!(vault::btc_exit_address(&v, ALICE).length() == 20, 3);
    ts::return_shared(v);

    // Depositing afterwards keeps the pin untouched.
    deposit(&mut scenario, vault_id, ALICE, 500_000, BOOK_MID);
    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    assert!(vault::shares_of(&v, ALICE) == 500_000, 4);
    assert!(vault::btc_exit_address(&v, ALICE) == x"0102030405060708090a0b0c0d0e0f1011121314", 5);
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EExitAddressAlreadySet)]
fun exit_address_second_write_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    vault::set_exit_address(&mut v, ALICE, x"0102030405060708090a0b0c0d0e0f1011121314");
    // A redirect attempt — there is no other mutator, and this one refuses.
    vault::set_exit_address(&mut v, ALICE, x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EUnregisteredDepositor)]
fun exit_address_of_unregistered_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(MALLORY);
    let v = borrow(&scenario, vault_id);
    vault::btc_exit_address(&v, MALLORY);
    ts::return_shared(v);
    scenario.end();
}

// ── Seal gate and keeper rotation (T1.2) ────────────────────────────────────

#[test]
fun seal_approve_succeeds_for_owner_and_keeper() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    let identity = seal_identity(vault_id, 0);
    assert!(identity.length() == vault::seal_identity_len(), 0);

    // A successful dry-run IS the authorization: these calls simply must not abort.
    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    vault::seal_approve_for_testing(identity, &v, scenario.ctx());
    ts::return_shared(v);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    vault::seal_approve_for_testing(seal_identity(vault_id, 0), &v, scenario.ctx());
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EBadIdentityNamespace)]
fun seal_approve_rejects_wrong_namespace() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    // Correct length, correct epoch — but namespaced to a DIFFERENT object.
    let foreign = seal_identity(object::id_from_address(@0xDEAD), 0);

    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    vault::seal_approve_for_testing(foreign, &v, scenario.ctx());
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EBadIdentityNamespace)]
fun seal_approve_rejects_malformed_identity_length() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    // 32 bytes of vault id with no epoch suffix at all.
    let truncated = object::id_to_bytes(&vault_id);

    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    vault::seal_approve_for_testing(truncated, &v, scenario.ctx());
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EStaleVersionEpoch)]
fun seal_approve_rejects_stale_version_epoch() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    let stale = seal_identity(vault_id, 0);

    // Rotation bumps the epoch to 1, which is what invalidates previously derived key shares.
    rotate_keeper(&mut scenario, OWNER, vault_id, NEW_KEEPER);

    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::version_epoch(&v) == 1, 0);
    vault::seal_approve_for_testing(stale, &v, scenario.ctx());
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun seal_approve_accepts_the_new_epoch_after_rotation() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    rotate_keeper(&mut scenario, OWNER, vault_id, NEW_KEEPER);

    scenario.next_tx(NEW_KEEPER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::keeper(&v) == NEW_KEEPER, 0);
    vault::seal_approve_for_testing(seal_identity(vault_id, 1), &v, scenario.ctx());
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::ENotAuthorized)]
fun seal_approve_rejects_unauthorized_sender() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    let identity = seal_identity(vault_id, 0);

    // Well-formed identity, current epoch — but Mallory is neither owner nor keeper.
    scenario.next_tx(MALLORY);
    let v = borrow(&scenario, vault_id);
    vault::seal_approve_for_testing(identity, &v, scenario.ctx());
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun set_keeper_bumps_version_epoch() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::version_epoch(&v) == 0, 0);
    assert!(vault::keeper(&v) == KEEPER, 1);
    ts::return_shared(v);

    rotate_keeper(&mut scenario, OWNER, vault_id, NEW_KEEPER);

    scenario.next_tx(NEW_KEEPER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::version_epoch(&v) == 1, 2);
    assert!(vault::keeper(&v) == NEW_KEEPER, 3);
    // The fresh cap carries the new epoch and passes.
    let keeper_cap = scenario.take_from_sender<KeeperCap>();
    assert!(vault::keeper_cap_version_epoch(&keeper_cap) == 1, 4);
    vault::assert_keeper(&v, &keeper_cap);
    scenario.return_to_sender(keeper_cap);
    ts::return_shared(v);

    // Rotating again keeps the epoch monotonically increasing.
    rotate_keeper(&mut scenario, OWNER, vault_id, KEEPER);
    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    assert!(vault::version_epoch(&v) == 2, 5);
    ts::return_shared(v);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EStaleVersionEpoch)]
fun rotated_out_keeper_cap_is_rejected() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    rotate_keeper(&mut scenario, OWNER, vault_id, KEEPER); // epoch 1, cap -> KEEPER

    // Rotate the keeper away; KEEPER's cap is now stale.
    rotate_keeper(&mut scenario, OWNER, vault_id, NEW_KEEPER); // epoch 2

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let stale_cap = scenario.take_from_sender<KeeperCap>();
    assert!(vault::keeper_cap_version_epoch(&stale_cap) == 1, 0);
    vault::assert_keeper(&v, &stale_cap);
    scenario.return_to_sender(stale_cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::ECapVaultMismatch)]
fun keeper_cap_from_another_vault_is_rejected() {
    let mut scenario = ts::begin(OWNER);
    let vault_a = create(&mut scenario, OWNER, KEEPER);
    let vault_b = create(&mut scenario, BOB, KEEPER);

    // KEEPER holds a cap for vault B...
    rotate_keeper(&mut scenario, BOB, vault_b, KEEPER);

    // ...and tries to use it against vault A.
    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_a);
    let foreign_cap = scenario.take_from_sender<KeeperCap>();
    vault::assert_keeper(&v, &foreign_cap);
    scenario.return_to_sender(foreign_cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EStaleVersionEpoch)]
fun envelope_params_mut_rejects_a_stale_keeper_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    rotate_keeper(&mut scenario, OWNER, vault_id, KEEPER); // epoch 1
    rotate_keeper(&mut scenario, OWNER, vault_id, NEW_KEEPER); // epoch 2, KEEPER's cap is stale

    scenario.next_tx(KEEPER);
    let mut v = borrow(&scenario, vault_id);
    let stale_cap = scenario.take_from_sender<KeeperCap>();
    vault::envelope_params_mut(&mut v, &stale_cap);
    scenario.return_to_sender(stale_cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun update_strategy_does_not_bump_version_epoch() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(OWNER);
    let mut v = borrow(&scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    vault::update_strategy(&mut v, &cap, b"ciphertext-v1", b"blob-v1");
    assert!(vault::strategy_ciphertext(&v) == b"ciphertext-v1", 0);
    assert!(vault::strategy_blob_id(&v) == b"blob-v1", 1);
    // Re-publishing a strategy must NOT revoke live Seal shares — only rotation does.
    assert!(vault::version_epoch(&v) == 0, 2);

    // The envelope can be replaced by the owner without touching the epoch either.
    vault::set_envelope(&mut v, &cap, params());
    assert!(vault::version_epoch(&v) == 0, 3);

    // And the keeper-gated mutable borrow works with a live cap.
    let keeper_cap = vault::set_keeper(&mut v, &cap, KEEPER, scenario.ctx());
    assert!(vault::version_epoch(&v) == 1, 4);
    vault::envelope_params_mut(&mut v, &keeper_cap);
    transfer::public_transfer(keeper_cap, KEEPER);

    scenario.return_to_sender(cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::ECapVaultMismatch)]
fun set_envelope_requires_the_matching_vault_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_a = create(&mut scenario, OWNER, KEEPER);
    let _vault_b = create(&mut scenario, BOB, KEEPER);

    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_a);
    let cap_b = scenario.take_from_sender<VaultCap>();
    vault::set_envelope(&mut v, &cap_b, params());
    scenario.return_to_sender(cap_b);
    ts::return_shared(v);
    scenario.end();
}

// ── capabilities, pause and emergency withdraw (T1.1) ───────────────────────

#[test]
#[expected_failure(abort_code = vault::ECapVaultMismatch)]
fun emergency_withdraw_requires_vault_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_a = create(&mut scenario, OWNER, KEEPER);
    let _vault_b = create(&mut scenario, BOB, KEEPER);
    deposit(&mut scenario, vault_a, ALICE, 1_000_000, BOOK_MID);

    // Bob holds a real VaultCap — for the WRONG vault. A KeeperCap has no path here at all:
    // the signature demands `&VaultCap`, so a keeper literally cannot call this (G2).
    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_a);
    let cap_b = scenario.take_from_sender<VaultCap>();
    let stolen = vault::emergency_withdraw(&mut v, &cap_b, 1_000, scenario.ctx());
    coin::burn_for_testing(stolen);
    scenario.return_to_sender(cap_b);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::ENotOwner)]
fun emergency_withdraw_requires_the_owner_as_sender() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    // The owner's cap leaks to Mallory. The cap alone is not enough — the recorded owner must
    // also be the signer.
    scenario.next_tx(OWNER);
    let cap = scenario.take_from_sender<VaultCap>();
    transfer::public_transfer(cap, MALLORY);

    scenario.next_tx(MALLORY);
    let mut v = borrow(&scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    let stolen = vault::emergency_withdraw(&mut v, &cap, 1_000, scenario.ctx());
    coin::burn_for_testing(stolen);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EInsufficientIdle)]
fun emergency_withdraw_over_idle_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(OWNER);
    let mut v = borrow(&scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    let out = vault::emergency_withdraw(&mut v, &cap, 1_000_001, scenario.ctx());
    coin::burn_for_testing(out);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EZeroDeposit)]
fun emergency_withdraw_zero_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);

    scenario.next_tx(OWNER);
    let mut v = borrow(&scenario, vault_id);
    let cap = scenario.take_from_sender<VaultCap>();
    let out = vault::emergency_withdraw(&mut v, &cap, 0, scenario.ctx());
    coin::burn_for_testing(out);
    scenario.return_to_sender(cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun owner_can_emergency_withdraw_while_paused() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    set_paused(&mut scenario, OWNER, vault_id, true);

    scenario.next_tx(OWNER);
    let mut v = borrow(&scenario, vault_id);
    assert!(vault::is_paused(&v), 0);
    let cap = scenario.take_from_sender<VaultCap>();
    let out = vault::emergency_withdraw(&mut v, &cap, 400_000, scenario.ctx());
    assert!(out.value() == 400_000, 1);
    assert!(vault::idle_btc_value(&v) == 600_000, 2);
    // Shares are untouched by an emergency withdraw — it is a custody escape hatch, not a burn.
    assert!(vault::total_shares(&v) == 1_000_000, 3);
    coin::burn_for_testing(out);
    scenario.return_to_sender(cap);
    ts::return_shared(v);

    // Unpausing restores deposits.
    set_paused(&mut scenario, OWNER, vault_id, false);
    scenario.next_tx(OWNER);
    let v = borrow(&scenario, vault_id);
    assert!(!vault::is_paused(&v), 4);
    ts::return_shared(v);
    deposit(&mut scenario, vault_id, BOB, 600_000, BOOK_MID);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EPaused)]
fun paused_blocks_deposit() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    set_paused(&mut scenario, OWNER, vault_id, true);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = vault::EPaused)]
fun paused_blocks_keeper_actions() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    rotate_keeper(&mut scenario, OWNER, vault_id, KEEPER);
    set_paused(&mut scenario, OWNER, vault_id, true);

    // The cap is current (right vault, right epoch) — pause alone stops the keeper.
    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let keeper_cap = scenario.take_from_sender<KeeperCap>();
    assert!(vault::keeper_cap_version_epoch(&keeper_cap) == vault::version_epoch(&v), 0);
    vault::assert_keeper(&v, &keeper_cap);
    scenario.return_to_sender(keeper_cap);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun redemption_still_works_while_paused() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000, BOOK_MID);
    set_paused(&mut scenario, OWNER, vault_id, true);

    // @invariant 9: a paused vault must still let depositors leave.
    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    assert!(vault::is_paused(&v), 0);
    let out = vault::burn_shares_for_btc(&mut v, ALICE, 250_000, BOOK_MID, scenario.ctx());
    assert!(out.value() == 250_000, 1);
    assert!(vault::shares_of(&v, ALICE) == 750_000, 2);
    assert!(vault::total_shares(&v) == 750_000, 3);
    balance::destroy_for_testing(out);
    ts::return_shared(v);

    scenario.end();
}
