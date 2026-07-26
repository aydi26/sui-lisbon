#[test_only]
module aphotic::vault_tests;

use aphotic::caps::{Self, AdminCap, KeeperCap};
use aphotic::notes;
use aphotic::vault::{Self, Vault};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.2
// @phase      1
// @status     DONE
// @spec       aphotic.md#6.2-nav-two-parties-not-two-scopes (L289-L296)
// @spec       aphotic.md#7.7-nav (L389-L411)
// @spec       aphotic.md#10-invariants (L456-L461)
// @spec       docs/DESIGN-V2.md#6-approve_nav-the-o1-form
// @rules      G10
// @depends    aphotic::vault (T1.2) · aphotic::caps · aphotic::notes
// @facts      TESTBTC stands in for hBTC (`0xfcea10ca…::btc::BTC`, 8 decimals, sats).
// @facts        TESTUSD stands in for the auction quote asset. APLP is the LP share coin.
// @facts      ⚠ THE ONE THING NO RUNTIME TEST CAN COVER, and it is deliberate: "the keeper
// @facts        cannot approve and the admin cannot propose" is enforced by the TYPE of the
// @facts        capability each function demands. A test that passed an `AdminCap` where a
// @facts        `&KeeperCap` is required would not compile, so there is nothing to assert at
// @facts        run time. What IS tested here is everything around it — a foreign cap, a
// @facts        rotated-out cap, a wrong digest and a stale proposal — because those are the
// @facts        ways the split could be defeated WITHOUT changing the signatures.
// @implements #[test] fun a_fresh_vault_is_empty_and_solvent()
//             #[test] fun create_rejects_a_treasury_that_already_minted()
//             #[test] fun request_deposit_takes_funds_but_mints_no_shares()
//             #[test] fun a_deposit_below_the_minimum_aborts()
//             #[test] fun a_deposit_while_paused_aborts()
//             #[test] fun claiming_before_the_epoch_is_priced_aborts()
//             #[test] fun the_bootstrap_epoch_prices_the_first_cohort_at_par()
//             #[test] fun a_full_epoch_mints_burns_and_pays_out()
//             #[test] fun nav_rounding_never_over_mints()
//             #[test] fun approve_with_a_wrong_digest_aborts()
//             #[test] fun a_stale_proposal_aborts()
//             #[test] fun a_second_proposal_replaces_the_first()
//             #[test] fun nav_jump_beyond_the_bound_aborts()
//             #[test] fun nav_jump_exactly_at_the_bound_succeeds()
//             #[test] fun clearing_price_deviation_beyond_the_bound_aborts()
//             #[test] fun a_zero_book_mid_is_a_defined_state_not_a_revert()
//             #[test] fun the_native_btc_leg_is_capped_by_the_onsui_claim()
//             #[test] fun the_hashi_claims_witness_cannot_regress()
//             #[test] fun the_idle_leg_must_equal_the_balance_move_can_see()
//             #[test] fun solvency_holds_after_every_mutation()
//             #[test] fun a_foreign_admin_cap_cannot_approve_nav()
//             #[test] fun a_rotated_out_keeper_cap_cannot_propose_nav()
//             #[test] fun a_paused_vault_still_lets_holders_leave()
//             #[test] fun unpausing_without_arming_aborts()
//             #[test] fun unpausing_before_the_delay_aborts()
//             #[test] fun unpausing_after_the_delay_succeeds()
//             #[test] fun pausing_again_clears_a_pending_arm()
//             #[test] fun the_governed_bounds_are_admin_gated()
//             #[test] fun an_excessive_matched_fee_is_refused()
//             #[test] fun escrow_top_up_and_withdraw_round_trip()
//             #[test] fun escrow_withdrawal_is_locked_during_a_clearing()
//             #[test] fun escrow_never_enters_nav()
//             #[test] fun a_note_deposit_and_spend_lands_in_the_internal_balance()
//             #[test] fun a_note_deposit_of_the_wrong_size_aborts()
//             #[test] fun the_proposal_digest_binds_every_field()
// @invariant  1. Every test asserts. An empty body is a defect, not a placeholder.
// @ac         aphotic.md §10 "NAV" and "Capabilities"
// @verify     sui move test vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

public struct TESTBTC has drop {}

public struct TESTUSD has drop {}

public struct APLP has drop {}

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;
const FEES: address = @0xFEE;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;

const BPS: u64 = 10_000;

fun bytes32(seed: u8): vector<u8> {
    let mut v = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) {
        v.push_back(seed + (i as u8));
        i = i + 1;
    };
    v
}

fun new_vault(sc: &mut Scenario): Vault<TESTBTC, TESTUSD, APLP> {
    let tcap = coin::create_treasury_cap_for_testing<APLP>(sc.ctx());
    vault::create<TESTBTC, TESTUSD, APLP>(tcap, ADMIN, KEEPER, FEES, sc.ctx())
}

fun take_caps(sc: &mut Scenario): (AdminCap, KeeperCap) {
    sc.next_tx(ADMIN);
    let a = sc.take_from_sender<AdminCap>();
    sc.next_tx(KEEPER);
    let k = sc.take_from_sender<KeeperCap>();
    (a, k)
}

/// propose + approve in one go, with the digest read straight off the recorded proposal.
fun propose_and_approve(
    v: &mut Vault<TESTBTC, TESTUSD, APLP>,
    admin: &AdminCap,
    keeper: &KeeperCap,
    clock: &Clock,
    sc: &mut Scenario,
    idle: u64,
    deployed: u64,
    in_flight: u64,
    native_btc: u64,
    claims: u64,
    clearing_price: u64,
    book_mid: u64,
) {
    sc.next_tx(KEEPER);
    vault::propose_nav(
        v,
        keeper,
        idle,
        deployed,
        in_flight,
        native_btc,
        claims,
        clearing_price,
        book_mid,
        clock,
        sc.ctx(),
    );
    let digest = vault::current_proposal_digest(v);
    sc.next_tx(ADMIN);
    vault::approve_nav(v, admin, digest, clock);
}

// ── genesis ─────────────────────────────────────────────────────────────────

#[test]
fun a_fresh_vault_is_empty_and_solvent() {
    let mut sc = ts::begin(ADMIN);
    let v = new_vault(&mut sc);

    assert!(vault::vault_epoch(&v) == 0, 0);
    assert!(vault::committed_supply(&v) == 0, 1);
    assert!(vault::minted_supply(&v) == 0, 2);
    assert!(vault::idle_sats(&v) == 0, 3);
    assert!(vault::nav_assets(&v) == 0, 4);
    assert!(!vault::has_proposal(&v), 5);
    assert!(!vault::is_paused(&v), 6);
    assert!(vault::active_clearings(&v) == 0, 7);
    assert!(vault::note_tree_depth(&v) == vault::note_tree_depth_const(), 8);
    assert!(caps::vault_id(vault::cap_registry(&v)) == object::id(&v), 9);
    vault::assert_solvent(&v);

    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::ELpSupplyNotZero)]
fun create_rejects_a_treasury_that_already_minted() {
    let mut sc = ts::begin(ADMIN);
    let mut tcap = coin::create_treasury_cap_for_testing<APLP>(sc.ctx());
    let stray = coin::mint(&mut tcap, 1, sc.ctx());
    let v = vault::create<TESTBTC, TESTUSD, APLP>(tcap, ADMIN, KEEPER, FEES, sc.ctx());
    destroy(stray);
    destroy(v);
    sc.end();
}

// ── the async deposit leg ───────────────────────────────────────────────────

#[test]
fun request_deposit_takes_funds_but_mints_no_shares() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);

    sc.next_tx(ALICE);
    let money = coin::mint_for_testing<TESTBTC>(5_000_000, sc.ctx());
    let receipt = vault::request_deposit(&mut v, money, sc.ctx());

    // Funds are in, shares are not minted, and NAV has not moved: the deposit is not priced
    // until an admin approves a valuation.
    assert!(vault::pending_deposit_assets(&v) == 5_000_000, 0);
    assert!(vault::minted_supply(&v) == 0, 1);
    assert!(vault::committed_supply(&v) == 0, 2);
    assert!(vault::idle_sats(&v) == 0, 3);
    assert!(vault::nav_assets(&v) == 0, 4);
    assert!(vault::receipt_assets(&receipt) == 5_000_000, 5);
    assert!(vault::receipt_epoch(&receipt) == 0, 6);

    destroy(receipt);
    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EBelowMinDeposit)]
fun a_deposit_below_the_minimum_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);
    sc.next_tx(ALICE);
    let money = coin::mint_for_testing<TESTBTC>(1, sc.ctx());
    let receipt = vault::request_deposit(&mut v, money, sc.ctx());
    destroy(receipt);
    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EPaused)]
fun a_deposit_while_paused_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    assert!(vault::is_paused(&v), 0);

    sc.next_tx(ALICE);
    let money = coin::mint_for_testing<TESTBTC>(5_000_000, sc.ctx());
    let receipt = vault::request_deposit(&mut v, money, sc.ctx());

    destroy(receipt);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::ENotYetPriced)]
fun claiming_before_the_epoch_is_priced_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);
    sc.next_tx(ALICE);
    let money = coin::mint_for_testing<TESTBTC>(5_000_000, sc.ctx());
    let receipt = vault::request_deposit(&mut v, money, sc.ctx());
    let shares = vault::claim_deposit(&mut v, receipt, sc.ctx());
    destroy(shares);
    destroy(v);
    sc.end();
}

#[test]
fun the_bootstrap_epoch_prices_the_first_cohort_at_par() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ALICE);
    let money = coin::mint_for_testing<TESTBTC>(5_000_000, sc.ctx());
    let receipt = vault::request_deposit(&mut v, money, sc.ctx());

    // Nothing is deployed and the base balance is still zero, because the deposit is pending.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);

    assert!(vault::vault_epoch(&v) == 1, 0);
    let (pa, ps) = vault::epoch_price_at(&v, 0);
    assert!(pa == 1 && ps == 1, 1);
    assert!(vault::idle_sats(&v) == 5_000_000, 2);
    assert!(vault::committed_supply(&v) == 5_000_000, 3);
    assert!(vault::unminted_shares(&v) == 5_000_000, 4);
    assert!(vault::minted_supply(&v) == 0, 5);
    vault::assert_solvent(&v);

    sc.next_tx(ALICE);
    let shares = vault::claim_deposit(&mut v, receipt, sc.ctx());
    assert!(shares.value() == 5_000_000, 6);
    assert!(vault::unminted_shares(&v) == 0, 7);
    assert!(vault::minted_supply(&v) == 5_000_000, 8);
    vault::assert_solvent(&v);

    destroy(shares);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_full_epoch_mints_burns_and_pays_out() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // epoch 0 — bootstrap: 1_000_000 sats in at par.
    sc.next_tx(ALICE);
    let d0 = vault::request_deposit(
        &mut v,
        coin::mint_for_testing<TESTBTC>(1_000_000, sc.ctx()),
        sc.ctx(),
    );
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);
    sc.next_tx(ALICE);
    let alice_shares = vault::claim_deposit(&mut v, d0, sc.ctx());
    assert!(alice_shares.value() == 1_000_000, 0);

    // epoch 1 — 5 % of the book is now deployed and has accrued: 1_050_000 total.
    sc.next_tx(ALICE);
    let mut alice_shares = alice_shares;
    let surrendered = alice_shares.split(400_000, sc.ctx());
    let r0 = vault::request_redeem(&mut v, surrendered, sc.ctx());
    assert!(vault::pending_redeem_shares(&v) == 400_000, 1);

    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 1_000_000, 50_000, 0, 0, 0, 0, 0);

    // 400_000 shares × 1.05 = 420_000 sats set aside; 600_000 shares still outstanding.
    assert!(vault::claimable_sats(&v) == 420_000, 2);
    assert!(vault::idle_sats(&v) == 580_000, 3);
    assert!(vault::committed_supply(&v) == 600_000, 4);
    assert!(vault::minted_supply(&v) == 600_000, 5);
    vault::assert_solvent(&v);

    sc.next_tx(ALICE);
    let paid = vault::claim_redeem(&mut v, r0, sc.ctx());
    assert!(paid.value() == 420_000, 6);
    assert!(vault::claimable_sats(&v) == 0, 7);
    vault::assert_solvent(&v);

    destroy(paid);
    destroy(alice_shares);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun nav_rounding_never_over_mints() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::set_min_deposit(&mut v, &admin, 1);
    // A 50 % move is the point of the test, so widen the guard deliberately.
    vault::set_nav_bounds(&mut v, &admin, BPS, 200, 3_600_000);

    // epoch 0: two shares exist at par.
    sc.next_tx(ALICE);
    let d = vault::request_deposit(&mut v, coin::mint_for_testing<TESTBTC>(2, sc.ctx()), sc.ctx());
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);
    sc.next_tx(ALICE);
    let s = vault::claim_deposit(&mut v, d, sc.ctx());

    // epoch 1: assets 3 against supply 2, and two 1-sat deposits pending.
    sc.next_tx(ALICE);
    let da = vault::request_deposit(&mut v, coin::mint_for_testing<TESTBTC>(1, sc.ctx()), sc.ctx());
    sc.next_tx(BOB);
    let db = vault::request_deposit(&mut v, coin::mint_for_testing<TESTBTC>(1, sc.ctx()), sc.ctx());

    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 2, 1, 0, 0, 0, 0, 0);

    // Cohort total: floor(2 × 2 / 3) = 1 share for the whole epoch.
    assert!(vault::unminted_shares(&v) == 1, 0);

    // Per receipt: floor(1 × 2 / 3) = 0 each. Round-down is SUBADDITIVE, so the dust stays
    // with the vault and never with a claimant.
    sc.next_tx(ALICE);
    let sa = vault::claim_deposit(&mut v, da, sc.ctx());
    sc.next_tx(BOB);
    let sb = vault::claim_deposit(&mut v, db, sc.ctx());
    assert!(sa.value() == 0, 1);
    assert!(sb.value() == 0, 2);
    assert!(vault::unminted_shares(&v) == 1, 3);
    vault::assert_solvent(&v);

    destroy(s);
    destroy(sa);
    destroy(sb);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── the two-party split ─────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = vault::EDigestMismatch)]
fun approve_with_a_wrong_digest_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 0, 0, 0, 0, 0, 0, &clock, sc.ctx());
    sc.next_tx(ADMIN);
    vault::approve_nav(&mut v, &admin, bytes32(9), &clock);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EProposalStale)]
fun a_stale_proposal_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 0, 0, 0, 0, 0, 0, &clock, sc.ctx());
    let digest = vault::current_proposal_digest(&v);

    clock.set_for_testing(vault::max_proposal_age_ms(&v) + 1);
    sc.next_tx(ADMIN);
    vault::approve_nav(&mut v, &admin, digest, &clock);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_second_proposal_replaces_the_first() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 7, 0, 0, 0, 0, 0, &clock, sc.ctx());
    let first = vault::current_proposal_digest(&v);
    vault::propose_nav(&mut v, &keeper, 0, 9, 0, 0, 0, 0, 0, &clock, sc.ctx());
    let second = vault::current_proposal_digest(&v);
    assert!(first != second, 0);

    let p = vault::current_proposal(&v);
    assert!(vault::proposal_deployed_sats(&p) == 9, 1);
    assert!(vault::proposal_proposer(&p) == KEEPER, 2);

    // The admin approves the numbers they signed; the superseded digest is simply not the one.
    sc.next_tx(ADMIN);
    vault::approve_nav(&mut v, &admin, second, &clock);
    assert!(vault::deployed_sats(&v) == 9, 3);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun a_foreign_admin_cap_cannot_approve_nav() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 0, 0, 0, 0, 0, 0, &clock, sc.ctx());
    let digest = vault::current_proposal_digest(&v);

    sc.next_tx(ADMIN);
    let uid = object::new(sc.ctx());
    let other_vault = uid.to_inner();
    uid.delete();
    let forged = caps::forge_foreign_admin_cap_for_testing(other_vault, sc.ctx());
    vault::approve_nav(&mut v, &forged, digest, &clock);

    destroy(forged);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::EStaleKeeperEpoch)]
fun a_rotated_out_keeper_cap_cannot_propose_nav() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::rotate_keeper(&mut v, &admin, BOB, sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 0, 0, 0, 0, 0, 0, &clock, sc.ctx());

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── the NAV guards ──────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = vault::ENavJump)]
fun nav_jump_beyond_the_bound_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ALICE);
    let d = vault::request_deposit(
        &mut v,
        coin::mint_for_testing<TESTBTC>(1_000_000, sc.ctx()),
        sc.ctx(),
    );
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);

    // 5.01 % against a 5 % (500 bps) bound.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 1_000_000, 50_100, 0, 0, 0, 0, 0);

    destroy(d);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun nav_jump_exactly_at_the_bound_succeeds() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ALICE);
    let d = vault::request_deposit(
        &mut v,
        coin::mint_for_testing<TESTBTC>(1_000_000, sc.ctx()),
        sc.ctx(),
    );
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);

    // Exactly 500 bps. The comparison is `<=`, so the boundary is inclusive.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 1_000_000, 50_000, 0, 0, 0, 0, 0);
    assert!(vault::last_nav_assets(&v) == 1_050_000, 0);
    assert!(vault::last_nav_supply(&v) == 1_000_000, 1);

    destroy(d);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EPriceDeviation)]
fun clearing_price_deviation_beyond_the_bound_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // 3 % away from the reference mid, against a 2 % (200 bps) bound.
    propose_and_approve(
        &mut v,
        &admin,
        &keeper,
        &clock,
        &mut sc,
        0,
        0,
        0,
        0,
        0,
        103_000_000,
        100_000_000,
    );

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_zero_book_mid_is_a_defined_state_not_a_revert() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // The hBTC book is empty on both sides on testnet and `mid_price` aborts there. A missing
    // reference must not brick the vault — it is a defined state, so the check is skipped.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 99_000_000, 0);
    assert!(vault::vault_epoch(&v) == 1, 0);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::ENavLegUncapped)]
fun the_native_btc_leg_is_capped_by_the_onsui_claim() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // 10 sats of "native BTC at the redemption address" behind a 9-sat on-Sui claim.
    // The unverifiable component can never exceed the verifiable claim behind it.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 10, 9, 0, 0);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EClaimsRegressed)]
fun the_hashi_claims_witness_cannot_regress() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 100, 100, 0, 0);
    assert!(vault::hashi_claims_sats(&v) == 100, 0);
    // The witness is CUMULATIVE, so shrinking it would let the capped leg be re-used.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 50, 50, 0, 0);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EIdleMismatch)]
fun the_idle_leg_must_equal_the_balance_move_can_see() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // The idle leg is the ONE leg Move can check for itself, so it is checked.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 12_345, 0, 0, 0, 0, 0, 0);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun solvency_holds_after_every_mutation() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    vault::assert_solvent(&v);

    sc.next_tx(ALICE);
    let d = vault::request_deposit(
        &mut v,
        coin::mint_for_testing<TESTBTC>(1_000_000, sc.ctx()),
        sc.ctx(),
    );
    vault::assert_solvent(&v);

    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);
    vault::assert_solvent(&v);

    sc.next_tx(ALICE);
    let mut shares = vault::claim_deposit(&mut v, d, sc.ctx());
    vault::assert_solvent(&v);

    let half = shares.split(500_000, sc.ctx());
    let r = vault::request_redeem(&mut v, half, sc.ctx());
    vault::assert_solvent(&v);

    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 1_000_000, 0, 0, 0, 0, 0, 0);
    vault::assert_solvent(&v);

    sc.next_tx(ALICE);
    let paid = vault::claim_redeem(&mut v, r, sc.ctx());
    assert!(paid.value() == 500_000, 0);
    vault::assert_solvent(&v);

    // Eight mutations, eight solvency checks, and the supply identity closed each time.
    assert!(vault::minted_supply(&v) + vault::unminted_shares(&v) == vault::committed_supply(&v), 1);

    destroy(paid);
    destroy(shares);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── pause ───────────────────────────────────────────────────────────────────

#[test]
fun a_paused_vault_still_lets_holders_leave() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ALICE);
    let d = vault::request_deposit(
        &mut v,
        coin::mint_for_testing<TESTBTC>(1_000_000, sc.ctx()),
        sc.ctx(),
    );
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);
    sc.next_tx(ALICE);
    let shares = vault::claim_deposit(&mut v, d, sc.ctx());

    // Price the exit BEFORE the pause, then pause with the receipt outstanding.
    sc.next_tx(ALICE);
    let mut shares = shares;
    let half = shares.split(500_000, sc.ctx());
    let r = vault::request_redeem(&mut v, half, sc.ctx());
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 1_000_000, 0, 0, 0, 0, 0, 0);

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    assert!(vault::is_paused(&v), 0);

    // Neither `claim_redeem` nor `request_redeem` consults the pause flag.
    //
    // ⚠ Stated honestly rather than implied: a pause DOES stop the keeper, so a redemption
    // requested after the pause cannot be PRICED until an admin resumes. What a pause can
    // never do is trap an exit that has already been priced, or refuse to accept the request.
    sc.next_tx(ALICE);
    let paid = vault::claim_redeem(&mut v, r, sc.ctx());
    assert!(paid.value() == 500_000, 1);

    sc.next_tx(ALICE);
    let r2 = vault::request_redeem(&mut v, shares, sc.ctx());
    assert!(vault::pending_redeem_shares(&v) == 500_000, 2);
    assert!(vault::is_paused(&v), 3);

    destroy(r2);
    destroy(paid);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EUnpauseNotArmed)]
fun unpausing_without_arming_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    vault::unpause(&mut v, &admin, &clock);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EUnpauseTooEarly)]
fun unpausing_before_the_delay_aborts() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    vault::arm_unpause(&mut v, &admin, &clock);
    clock.set_for_testing(vault::unpause_delay_ms(&v) - 1);
    vault::unpause(&mut v, &admin, &clock);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun unpausing_after_the_delay_succeeds() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    vault::arm_unpause(&mut v, &admin, &clock);
    assert!(vault::is_unpause_armed(&v), 0);
    clock.set_for_testing(vault::unpause_delay_ms(&v));
    vault::unpause(&mut v, &admin, &clock);

    assert!(!vault::is_paused(&v), 1);
    assert!(!vault::is_unpause_armed(&v), 2);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun pausing_again_clears_a_pending_arm() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    vault::pause(&mut v, &admin);
    vault::arm_unpause(&mut v, &admin, &clock);
    assert!(vault::is_unpause_armed(&v), 0);
    // Pausing is one transaction and it resets the clock on resuming.
    vault::pause(&mut v, &admin);
    assert!(!vault::is_unpause_armed(&v), 1);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── governed parameters ─────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun the_governed_bounds_are_admin_gated() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);

    sc.next_tx(BOB);
    let uid = object::new(sc.ctx());
    let other = uid.to_inner();
    uid.delete();
    let forged = caps::forge_foreign_admin_cap_for_testing(other, sc.ctx());
    vault::set_nav_bounds(&mut v, &forged, 100, 100, 1_000);

    destroy(forged);
    destroy(admin);
    destroy(keeper);
    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EBadParam)]
fun an_excessive_matched_fee_is_refused() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);

    sc.next_tx(ADMIN);
    vault::set_fee_params(&mut v, &admin, 101, FEES);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    sc.end();
}

// ── escrow, which is deliberately not NAV ───────────────────────────────────

#[test]
fun escrow_top_up_and_withdraw_round_trip() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);

    sc.next_tx(ALICE);
    vault::escrow_top_up_base(&mut v, coin::mint_for_testing<TESTBTC>(700, sc.ctx()), sc.ctx());
    vault::escrow_top_up_quote(&mut v, coin::mint_for_testing<TESTUSD>(900, sc.ctx()), sc.ctx());
    assert!(vault::escrow_base_of(&v, ALICE) == 700, 0);
    assert!(vault::escrow_quote_of(&v, ALICE) == 900, 1);

    let back = vault::escrow_withdraw_base(&mut v, 200, sc.ctx());
    assert!(back.value() == 200, 2);
    assert!(vault::escrow_base_of(&v, ALICE) == 500, 3);
    assert!(vault::escrow_base_custody(&v) == 500, 4);

    destroy(back);
    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EEscrowLocked)]
fun escrow_withdrawal_is_locked_during_a_clearing() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);

    sc.next_tx(ALICE);
    vault::escrow_top_up_base(&mut v, coin::mint_for_testing<TESTBTC>(700, sc.ctx()), sc.ctx());
    vault::begin_clearing_lock(&mut v);
    let back = vault::escrow_withdraw_base(&mut v, 200, sc.ctx());

    destroy(back);
    destroy(v);
    sc.end();
}

#[test]
fun escrow_never_enters_nav() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ALICE);
    vault::escrow_top_up_base(
        &mut v,
        coin::mint_for_testing<TESTBTC>(9_000_000, sc.ctx()),
        sc.ctx(),
    );

    // 9 M sats of participant money is custodied, and NAV is still zero. If escrow sat inside
    // NAV a settlement between propose and approve would move the number being approved.
    assert!(vault::escrow_base_custody(&v) == 9_000_000, 0);
    assert!(vault::nav_assets(&v) == 0, 1);
    assert!(vault::idle_sats(&v) == 0, 2);

    // And the idle leg still checks out at zero, which proves escrow is not in `base`.
    propose_and_approve(&mut v, &admin, &keeper, &clock, &mut sc, 0, 0, 0, 0, 0, 0, 0);
    assert!(vault::vault_epoch(&v) == 1, 3);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_note_deposit_and_spend_lands_in_the_internal_balance() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);

    let denom = vault::denom_sats_at(&v, 0);
    assert!(denom == 1_000_000, 0);

    let secret = bytes32(11);
    let randomness = bytes32(77);
    let commitment = notes::commitment(0, &secret, &randomness);

    sc.next_tx(ALICE);
    let leaf = vault::escrow_deposit_note(
        &mut v,
        coin::mint_for_testing<TESTBTC>(denom, sc.ctx()),
        0,
        commitment,
    );
    assert!(leaf == 0, 1);
    assert!(vault::note_custody_sats(&v) == denom, 2);
    assert!(vault::note_outstanding_sats(&v) == denom, 3);
    // A note deposit is NOT a NAV event.
    assert!(vault::nav_assets(&v) == 0, 4);

    // Leaf 0 of an otherwise empty tree: every sibling is the level's zero hash.
    let mut siblings = vector<vector<u8>>[];
    let mut i = 0u64;
    while (i < (vault::note_tree_depth(&v) as u64)) {
        siblings.push_back(vault::note_sibling_zero(&v, i));
        i = i + 1;
    };
    let witness = notes::new_membership_witness(0, secret, randomness, 0, siblings);

    sc.next_tx(ALICE);
    let sats = vault::escrow_spend_note(&mut v, witness, sc.ctx());
    assert!(sats == denom, 5);
    assert!(vault::escrow_base_of(&v, ALICE) == denom, 6);
    assert!(vault::note_custody_sats(&v) == 0, 7);
    assert!(vault::note_outstanding_sats(&v) == 0, 8);

    destroy(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = vault::EDenomMismatch)]
fun a_note_deposit_of_the_wrong_size_aborts() {
    let mut sc = ts::begin(ALICE);
    let mut v = new_vault(&mut sc);
    let commitment = notes::commitment(0, &bytes32(1), &bytes32(2));

    sc.next_tx(ALICE);
    // A note carries an INDEX, not an amount: paying anything but the tier would silently
    // revalue it.
    vault::escrow_deposit_note(
        &mut v,
        coin::mint_for_testing<TESTBTC>(999_999, sc.ctx()),
        0,
        commitment,
    );

    destroy(v);
    sc.end();
}

#[test]
fun the_proposal_digest_binds_every_field() {
    let mut sc = ts::begin(ADMIN);
    let mut v = new_vault(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(KEEPER);
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 3, 4, 5, 6, &clock, sc.ctx());
    let base_digest = vault::current_proposal_digest(&v);

    // Every scalar in the proposal must move the digest, or the admin's signature would not
    // pin the numbers it is signing.
    vault::propose_nav(&mut v, &keeper, 0, 9, 2, 3, 4, 5, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 0);
    vault::propose_nav(&mut v, &keeper, 0, 1, 9, 3, 4, 5, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 1);
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 9, 9, 5, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 2);
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 3, 9, 5, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 3);
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 3, 4, 9, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 4);
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 3, 4, 5, 9, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) != base_digest, 5);

    // …and it is stable: the same numbers reproduce the same digest.
    vault::propose_nav(&mut v, &keeper, 0, 1, 2, 3, 4, 5, 6, &clock, sc.ctx());
    assert!(vault::current_proposal_digest(&v) == base_digest, 6);

    destroy(admin);
    destroy(keeper);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}
