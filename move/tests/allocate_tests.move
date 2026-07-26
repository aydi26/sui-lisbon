#[test_only]
module aphotic::allocate_tests;

use aphotic::allocate::{Self, AdapterRegistry, AdapterAdminCap};
use aphotic::carry;
use std::string;
use std::type_name;
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.allocate, P2.carry
// @phase      1
// @status     DONE
// @spec       aphotic.md#10-invariants — "Capabilities" and "Carry"
// @spec       aphotic-governance.md#4.1 — the pinned lending-adapter allowlist
// @rules      G10
// @depends    aphotic::allocate · aphotic::carry
// @facts      This file covers BOTH modules. `carry.move` is interface-only in v2 (see its
// @facts        banner), so its three predicates are tested here rather than in a file of their
// @facts        own — the agent that owns this build owns `allocate_tests.move` and no other
// @facts        test path, and a predicate with no test is a predicate that does not work.
// @facts      Marker types `AdapterA` / `AdapterB` stand in for a real adapter package's phantom
// @facts        witness. They are never constructed: only `type_name::with_defining_ids<A>()`
// @facts        is taken of them, exactly as `allocate` does.
// @facts      Venue ids are synthesised with `object::id_from_address` — no live id appears in a
// @facts        test (G7).
// @implements ── allocate: construction & governance ──
//             #[test] registry_starts_empty_and_unpaused                        [DONE]
//             #[test] allow_adapter_pins_the_pair_and_emits                     [DONE]
//             #[test] allow_adapter_twice_aborts                                [DONE]
//             #[test] an_empty_label_is_refused                                 [DONE]
//             #[test] a_foreign_admin_cap_cannot_govern                         [DONE]
//             #[test] a_foreign_admin_cap_cannot_pause                          [DONE]
//             #[test] set_paused_toggles_and_emits                              [DONE]
//             ── allocate: the allowlist IS the gate (@invariant 1) ──
//             #[test] the_same_type_at_another_venue_is_not_allowed             [DONE]
//             #[test] another_type_at_the_same_venue_is_not_allowed             [DONE]
//             #[test] marking_an_unlisted_pair_aborts                           [DONE]
//             ── allocate: deployment (@invariant 3, 6) ──
//             #[test] the_deposit_round_trip_books_principal_and_shares         [DONE]
//             #[test] deposit_at_exactly_the_cap_is_allowed                     [DONE]
//             #[test] deposit_over_the_venue_cap_aborts                         [DONE]
//             #[test] the_cap_check_cannot_be_overflowed                        [DONE]
//             #[test] a_zero_deposit_aborts                                     [DONE]
//             #[test] an_adapter_that_returns_no_shares_aborts                  [DONE]
//             #[test] deposit_is_refused_while_the_registry_is_paused           [DONE]
//             #[test] deposit_is_refused_while_the_entry_is_disabled            [DONE]
//             #[test] a_ticket_cannot_be_closed_against_another_registry        [DONE]
//             ── allocate: recall (@invariant 2, 4) ──
//             #[test] recall_is_never_gated_by_pause_or_disable                 [DONE]
//             #[test] withdrawing_more_shares_than_held_aborts                  [DONE]
//             #[test] a_short_return_breaches_the_value_floor                   [DONE]
//             #[test] a_return_exactly_at_the_floor_is_accepted                 [DONE]
//             #[test] a_withdraw_ticket_cannot_be_closed_against_another_registry [DONE]
//             ── allocate: delisting (@invariant 5) ──
//             #[test] removing_a_funded_adapter_aborts                          [DONE]
//             #[test] removing_an_adapter_that_still_holds_shares_aborts        [DONE]
//             #[test] removing_a_drained_adapter_delists_it                     [DONE]
//             ── allocate: the NAV mark (@invariant 7) ──
//             #[test] mark_is_the_only_way_yield_enters_the_book                [DONE]
//             #[test] a_deposit_invalidates_the_mark                            [DONE]
//             #[test] a_withdraw_invalidates_the_mark                           [DONE]
//             #[test] assert_fresh_mark_accepts_a_fresh_mark                    [DONE]
//             #[test] assert_fresh_mark_rejects_a_stale_mark                    [DONE]
//             #[test] assert_fresh_mark_rejects_a_never_marked_entry            [DONE]
//             ── allocate: aggregation & winding down ──
//             #[test] totals_aggregate_across_venues                            [DONE]
//             #[test] enumeration_mirrors_the_allowlist                         [DONE]
//             #[test] lowering_the_cap_blocks_deployment_without_trapping_capital [DONE]
//             ── carry: the Phase-2 interface ──
//             #[test] carry_params_accept_20_and_32_byte_pins                   [DONE]
//             #[test] carry_params_reject_a_19_byte_pin                         [DONE]
//             #[test] carry_params_reject_an_empty_pin                          [DONE]
//             #[test] the_value_floor_aborts_on_a_loss                          [DONE]
//             #[test] the_value_floor_accepts_break_even                        [DONE]
//             #[test] only_the_pinned_address_is_accepted                       [DONE]
//             #[test] a_one_byte_difference_is_not_the_pinned_address           [DONE]
//             #[test] discount_is_zero_at_or_above_par                          [DONE]
//             #[test] a_zero_price_is_invalid                                   [DONE]
//             #[test] the_hurdle_is_monotone_in_the_discount                    [DONE]
//             #[test] assert_hurdle_met_aborts_below_the_hurdle                 [DONE]
//             #[test] expected_carry_does_not_overflow_u64                      [DONE]
//             #[test] an_exit_at_the_bridge_minimum_is_submittable              [DONE]
//             #[test] an_exit_below_the_bridge_minimum_aborts                   [DONE]
//             #[test] the_notional_cap_binds                                    [DONE]
// @invariant  1. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  2. No test weakens a source invariant to pass: every `expected_failure` names the
//                error constant the source module raises, by symbol, not by number.
// @ac         `sui move test allocate_tests` is green (51 tests: allocate + carry).
// @verify     sui move test allocate_tests
//             ⚠ the filter is POSITIONAL and matches the FULLY-QUALIFIED test name — there is
//               no `--filter` flag in sui 1.76.0. `sui move test carry` would match only the 4
//               tests whose own names contain "carry".
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;

/// Stand-ins for an adapter package's phantom witness type. Never constructed.
public struct AdapterA {}
public struct AdapterB {}

// ── fixtures ────────────────────────────────────────────────────────────────

fun venue_a(): ID {
    object::id_from_address(@0xA1)
}

fun venue_b(): ID {
    object::id_from_address(@0xB2)
}

fun begin(): (Scenario, Clock) {
    let mut scenario = ts::begin(ADMIN);
    let clock = clock::create_for_testing(scenario.ctx());
    (scenario, clock)
}

fun finish(scenario: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    scenario.end();
}

/// A registry with `AdapterA @ venue_a` allowed at `cap_sats`.
fun with_adapter_a(
    scenario: &mut Scenario,
    clock: &Clock,
    cap_sats: u64,
): (AdapterRegistry, AdapterAdminCap) {
    let (mut registry, cap) = allocate::new(scenario.ctx());
    allocate::allow_adapter<AdapterA>(
        &cap,
        &mut registry,
        venue_a(),
        b"aphotic-lending hBTC market",
        cap_sats,
        clock,
    );
    (registry, cap)
}

/// One complete deployment leg: open the ticket, "call the adapter", close the ticket.
fun deploy(registry: &mut AdapterRegistry, clock: &Clock, sats: u64, shares_out: u64) {
    let ticket = allocate::test_begin_deposit<AdapterA>(registry, venue_a(), sats);
    assert!(allocate::ticket_sats(&ticket) == sats, 0);
    allocate::test_finish_deposit(registry, ticket, shares_out, clock);
}

/// One complete recall leg.
fun recall(
    registry: &mut AdapterRegistry,
    clock: &Clock,
    shares: u64,
    min_sats_out: u64,
    sats_in: u64,
) {
    let ticket = allocate::test_begin_withdraw<AdapterA>(
        registry,
        venue_a(),
        shares,
        min_sats_out,
    );
    assert!(allocate::ticket_shares(&ticket) == shares, 0);
    assert!(allocate::ticket_min_sats_out(&ticket) == min_sats_out, 0);
    allocate::test_finish_withdraw(registry, ticket, sats_in, clock);
}

// ── construction & governance ───────────────────────────────────────────────

#[test]
fun registry_starts_empty_and_unpaused() {
    let (mut scenario, clock) = begin();
    let (registry, cap) = allocate::new(scenario.ctx());
    assert!(allocate::adapter_count(&registry) == 0, 0);
    assert!(allocate::total_principal_sats(&registry) == 0, 1);
    assert!(allocate::total_marked_assets_sats(&registry) == 0, 2);
    assert!(!allocate::is_paused(&registry), 3);
    assert!(!allocate::is_allowed<AdapterA>(&registry, venue_a()), 4);
    assert!(allocate::admin_registry_id(&cap) == object::id(&registry), 5);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun allow_adapter_pins_the_pair_and_emits() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(1_700_000_000_000);
    let (registry, cap) = with_adapter_a(&mut scenario, &clock, 50_000_000);

    assert!(allocate::adapter_count(&registry) == 1, 0);
    assert!(allocate::is_allowed<AdapterA>(&registry, venue_a()), 1);
    assert!(allocate::is_enabled<AdapterA>(&registry, venue_a()), 2);
    assert!(allocate::venue_cap_sats<AdapterA>(&registry, venue_a()) == 50_000_000, 3);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 0, 4);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 0, 5);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 0, 6);
    assert!(allocate::added_at_ms<AdapterA>(&registry, venue_a()) == 1_700_000_000_000, 7);
    assert!(
        allocate::label<AdapterA>(&registry, venue_a())
            == string::utf8(b"aphotic-lending hBTC market"),
        8,
    );
    // the pinned pair is enumerable for a NAV pass
    let (adapter, venue) = allocate::adapter_key_at(&registry, 0);
    assert!(adapter == type_name::with_defining_ids<AdapterA>(), 9);
    assert!(venue == venue_a(), 10);
    assert!(event::num_events() == 1, 11);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
#[expected_failure(abort_code = allocate::EAdapterAlreadyAllowed)]
fun allow_adapter_twice_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 1_000);
    allocate::allow_adapter<AdapterA>(&cap, &mut registry, venue_a(), b"again", 1, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EEmptyLabel)]
fun an_empty_label_is_refused() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = allocate::new(scenario.ctx());
    allocate::allow_adapter<AdapterA>(&cap, &mut registry, venue_a(), b"", 1, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EWrongRegistry)]
fun a_foreign_admin_cap_cannot_govern() {
    let (mut scenario, clock) = begin();
    let (mut registry_one, _cap_one) = allocate::new(scenario.ctx());
    let (_registry_two, cap_two) = allocate::new(scenario.ctx());
    // cap_two governs registry_two and nothing else.
    allocate::allow_adapter<AdapterA>(&cap_two, &mut registry_one, venue_a(), b"x", 1, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EWrongRegistry)]
fun a_foreign_admin_cap_cannot_pause() {
    let (mut scenario, _clock) = begin();
    let (mut registry_one, _cap_one) = allocate::new(scenario.ctx());
    let (_registry_two, cap_two) = allocate::new(scenario.ctx());
    allocate::set_paused(&cap_two, &mut registry_one, true);
    abort
}

#[test]
fun set_paused_toggles_and_emits() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = allocate::new(scenario.ctx());
    assert!(!allocate::is_paused(&registry), 0);
    allocate::set_paused(&cap, &mut registry, true);
    assert!(allocate::is_paused(&registry), 1);
    allocate::set_paused(&cap, &mut registry, false);
    assert!(!allocate::is_paused(&registry), 2);
    assert!(event::num_events() == 2, 3);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

// ── the allowlist IS the gate (@invariant 1) ────────────────────────────────

#[test]
#[expected_failure(abort_code = allocate::EAdapterNotAllowed)]
fun the_same_type_at_another_venue_is_not_allowed() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    assert!(!allocate::is_allowed<AdapterA>(&registry, venue_b()), 0);
    // A vetted adapter type pointed at an unvetted shared object must not route.
    let ticket = allocate::test_begin_deposit<AdapterA>(&mut registry, venue_b(), 1);
    allocate::test_finish_deposit(&mut registry, ticket, 1, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EAdapterNotAllowed)]
fun another_type_at_the_same_venue_is_not_allowed() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    assert!(!allocate::is_allowed<AdapterB>(&registry, venue_a()), 0);
    // The right object driven through the wrong adapter must not route either.
    let ticket = allocate::test_begin_deposit<AdapterB>(&mut registry, venue_a(), 1);
    allocate::test_finish_deposit(&mut registry, ticket, 1, &clock);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EAdapterNotAllowed)]
fun marking_an_unlisted_pair_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    allocate::test_mark<AdapterB>(&mut registry, venue_a(), 999_999, &clock);
    abort
}

// ── deployment (@invariant 3, 6) ────────────────────────────────────────────

#[test]
fun the_deposit_round_trip_books_principal_and_shares() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 10_000_000);

    deploy(&mut registry, &clock, 2_500_000, 2_500_000);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 2_500_000, 0);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 2_500_000, 1);
    assert!(allocate::total_principal_sats(&registry) == 2_500_000, 2);
    // cost basis carried, mark invalidated
    assert!(allocate::last_assets_sats<AdapterA>(&registry, venue_a()) == 2_500_000, 3);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 0, 4);

    // a second leg accumulates; share units need not equal sats
    deploy(&mut registry, &clock, 1_500_000, 1_400_000);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 4_000_000, 5);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 3_900_000, 6);
    assert!(allocate::total_principal_sats(&registry) == 4_000_000, 7);
    assert!(allocate::total_marked_assets_sats(&registry) == 4_000_000, 8);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun deposit_at_exactly_the_cap_is_allowed() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    deploy(&mut registry, &clock, 600_000, 600_000);
    deploy(&mut registry, &clock, 400_000, 400_000);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 1_000_000, 0);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
#[expected_failure(abort_code = allocate::EVenueCapExceeded)]
fun deposit_over_the_venue_cap_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    deploy(&mut registry, &clock, 600_000, 600_000);
    deploy(&mut registry, &clock, 400_001, 400_001);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EVenueCapExceeded)]
fun the_cap_check_cannot_be_overflowed() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    // `principal + sats` would wrap in u64; the check is done in u128 so this must be a
    // readable EVenueCapExceeded, not an arithmetic abort.
    deploy(&mut registry, &clock, 18_446_744_073_709_551_615, 1);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EZeroAmount)]
fun a_zero_deposit_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    deploy(&mut registry, &clock, 0, 1);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::ENoSharesReceived)]
fun an_adapter_that_returns_no_shares_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    // sats left the vault but the venue minted nothing — the leg must not close.
    deploy(&mut registry, &clock, 500_000, 0);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::ERegistryPaused)]
fun deposit_is_refused_while_the_registry_is_paused() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    allocate::set_paused(&cap, &mut registry, true);
    deploy(&mut registry, &clock, 1, 1);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EAdapterDisabled)]
fun deposit_is_refused_while_the_entry_is_disabled() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    allocate::set_adapter_enabled<AdapterA>(&cap, &mut registry, venue_a(), false);
    deploy(&mut registry, &clock, 1, 1);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EWrongRegistry)]
fun a_ticket_cannot_be_closed_against_another_registry() {
    let (mut scenario, clock) = begin();
    let (mut registry_one, _cap_one) = with_adapter_a(&mut scenario, &clock, 1_000_000);
    let (mut registry_two, _cap_two) = allocate::new(scenario.ctx());
    let ticket = allocate::test_begin_deposit<AdapterA>(&mut registry_one, venue_a(), 1_000);
    allocate::test_finish_deposit(&mut registry_two, ticket, 1_000, &clock);
    abort
}

// ── recall (@invariant 2, 4) ────────────────────────────────────────────────

#[test]
fun recall_is_never_gated_by_pause_or_disable() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 4_000_000, 4_000_000);

    // The kill switch fires: no NEW deployment...
    allocate::set_paused(&cap, &mut registry, true);
    allocate::set_adapter_enabled<AdapterA>(&cap, &mut registry, venue_a(), false);

    // ...but capital already at the venue must always be recallable.
    recall(&mut registry, &clock, 4_000_000, 4_000_000, 4_050_000);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 0, 0);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 0, 1);
    assert!(allocate::total_principal_sats(&registry) == 0, 2);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
#[expected_failure(abort_code = allocate::EInsufficientShares)]
fun withdrawing_more_shares_than_held_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    recall(&mut registry, &clock, 1_000_001, 0, 1_000_001);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EValueLoss)]
fun a_short_return_breaches_the_value_floor() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    // the venue returned one satoshi less than the floor the keeper committed to
    recall(&mut registry, &clock, 1_000_000, 1_000_000, 999_999);
    abort
}

#[test]
fun a_return_exactly_at_the_floor_is_accepted() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    recall(&mut registry, &clock, 400_000, 400_000, 400_000);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 600_000, 0);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 600_000, 1);
    assert!(allocate::total_principal_sats(&registry) == 600_000, 2);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
#[expected_failure(abort_code = allocate::EWrongRegistry)]
fun a_withdraw_ticket_cannot_be_closed_against_another_registry() {
    let (mut scenario, clock) = begin();
    let (mut registry_one, _cap_one) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry_one, &clock, 1_000_000, 1_000_000);
    let (mut registry_two, _cap_two) = allocate::new(scenario.ctx());
    let ticket = allocate::test_begin_withdraw<AdapterA>(
        &mut registry_one,
        venue_a(),
        1_000,
        0,
    );
    allocate::test_finish_withdraw(&mut registry_two, ticket, 1_000, &clock);
    abort
}

// ── delisting (@invariant 5) ────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = allocate::EAdapterStillFunded)]
fun removing_a_funded_adapter_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::remove_adapter<AdapterA>(&cap, &mut registry, venue_a());
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EAdapterStillFunded)]
fun removing_an_adapter_that_still_holds_shares_aborts() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    // principal is home but the share units are not — still funded.
    recall(&mut registry, &clock, 400_000, 0, 1_000_000);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 0, 0);
    assert!(allocate::shares<AdapterA>(&registry, venue_a()) == 600_000, 1);
    allocate::remove_adapter<AdapterA>(&cap, &mut registry, venue_a());
    abort
}

#[test]
fun removing_a_drained_adapter_delists_it() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_010_000, &clock);
    recall(&mut registry, &clock, 1_000_000, 0, 1_010_000);

    allocate::remove_adapter<AdapterA>(&cap, &mut registry, venue_a());
    assert!(allocate::adapter_count(&registry) == 0, 0);
    assert!(!allocate::is_allowed<AdapterA>(&registry, venue_a()), 1);
    assert!(allocate::total_principal_sats(&registry) == 0, 2);
    assert!(allocate::total_marked_assets_sats(&registry) == 0, 3);

    // and it can be re-listed afterwards
    allocate::allow_adapter<AdapterA>(&cap, &mut registry, venue_a(), b"relisted", 7, &clock);
    assert!(allocate::adapter_count(&registry) == 1, 4);
    assert!(allocate::venue_cap_sats<AdapterA>(&registry, venue_a()) == 7, 5);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

// ── the NAV mark (@invariant 7) ─────────────────────────────────────────────

#[test]
fun mark_is_the_only_way_yield_enters_the_book() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(1_000);
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);

    // straight after deployment the book carries cost basis and NOTHING more
    assert!(allocate::total_marked_assets_sats(&registry) == 1_000_000, 0);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 0, 1);

    // the venue's own convert_to_assets is what recognises the yield
    clock.set_for_testing(2_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_012_345, &clock);
    assert!(allocate::last_assets_sats<AdapterA>(&registry, venue_a()) == 1_012_345, 2);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 2_000, 3);
    assert!(allocate::total_marked_assets_sats(&registry) == 1_012_345, 4);
    // principal (cost basis) is untouched by a mark
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 1_000_000, 5);

    // a mark can go DOWN too — a lending market can take a loss
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 900_000, &clock);
    assert!(allocate::total_marked_assets_sats(&registry) == 900_000, 6);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun a_deposit_invalidates_the_mark() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(5_000);
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_050_000, &clock);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 5_000, 0);

    deploy(&mut registry, &clock, 100_000, 95_000);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 0, 1);
    assert!(allocate::last_assets_sats<AdapterA>(&registry, venue_a()) == 1_150_000, 2);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun a_withdraw_invalidates_the_mark() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(5_000);
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_050_000, &clock);
    recall(&mut registry, &clock, 500_000, 0, 525_000);
    assert!(allocate::last_marked_ms<AdapterA>(&registry, venue_a()) == 0, 0);
    assert!(allocate::last_assets_sats<AdapterA>(&registry, venue_a()) == 525_000, 1);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun assert_fresh_mark_accepts_a_fresh_mark() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(100_000);
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_000_000, &clock);
    clock.set_for_testing(160_000);
    // exactly at the bound is fresh
    allocate::assert_fresh_mark<AdapterA>(&registry, venue_a(), &clock, 60_000);
    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
#[expected_failure(abort_code = allocate::EStaleMark)]
fun assert_fresh_mark_rejects_a_stale_mark() {
    let (mut scenario, mut clock) = begin();
    clock.set_for_testing(100_000);
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_000_000, &clock);
    clock.set_for_testing(160_001);
    allocate::assert_fresh_mark<AdapterA>(&registry, venue_a(), &clock, 60_000);
    abort
}

#[test]
#[expected_failure(abort_code = allocate::EStaleMark)]
fun assert_fresh_mark_rejects_a_never_marked_entry() {
    let (mut scenario, clock) = begin();
    let (mut registry, _cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    // deployed but never marked: NAV must refuse to value it
    allocate::assert_fresh_mark<AdapterA>(&registry, venue_a(), &clock, 1_000_000_000);
    abort
}

// ── aggregation & winding down ──────────────────────────────────────────────

#[test]
fun totals_aggregate_across_venues() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    allocate::allow_adapter<AdapterB>(
        &cap,
        &mut registry,
        venue_b(),
        b"second venue",
        3_000_000,
        &clock,
    );

    deploy(&mut registry, &clock, 1_000_000, 1_000_000);
    let ticket = allocate::test_begin_deposit<AdapterB>(&mut registry, venue_b(), 2_000_000);
    allocate::test_finish_deposit(&mut registry, ticket, 2_000_000, &clock);

    assert!(allocate::total_principal_sats(&registry) == 3_000_000, 0);
    assert!(allocate::total_marked_assets_sats(&registry) == 3_000_000, 1);

    allocate::test_mark<AdapterA>(&mut registry, venue_a(), 1_100_000, &clock);
    assert!(allocate::total_marked_assets_sats(&registry) == 3_100_000, 2);
    allocate::test_mark<AdapterB>(&mut registry, venue_b(), 1_900_000, &clock);
    assert!(allocate::total_marked_assets_sats(&registry) == 3_000_000, 3);
    // principal is cost basis and does not follow the mark
    assert!(allocate::total_principal_sats(&registry) == 3_000_000, 4);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun enumeration_mirrors_the_allowlist() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 1);
    allocate::allow_adapter<AdapterB>(&cap, &mut registry, venue_b(), b"b", 1, &clock);
    assert!(allocate::adapter_count(&registry) == 2, 0);

    let (adapter_0, venue_0) = allocate::adapter_key_at(&registry, 0);
    let (adapter_1, venue_1) = allocate::adapter_key_at(&registry, 1);
    assert!(adapter_0 == type_name::with_defining_ids<AdapterA>() && venue_0 == venue_a(), 1);
    assert!(adapter_1 == type_name::with_defining_ids<AdapterB>() && venue_1 == venue_b(), 2);

    // removing the FIRST row leaves the enumeration consistent with the table
    allocate::remove_adapter<AdapterA>(&cap, &mut registry, venue_a());
    assert!(allocate::adapter_count(&registry) == 1, 3);
    let (adapter_only, venue_only) = allocate::adapter_key_at(&registry, 0);
    assert!(
        adapter_only == type_name::with_defining_ids<AdapterB>() && venue_only == venue_b(),
        4,
    );
    assert!(!allocate::is_allowed<AdapterA>(&registry, venue_a()), 5);
    assert!(allocate::is_allowed<AdapterB>(&registry, venue_b()), 6);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

#[test]
fun lowering_the_cap_blocks_deployment_without_trapping_capital() {
    let (mut scenario, clock) = begin();
    let (mut registry, cap) = with_adapter_a(&mut scenario, &clock, 5_000_000);
    deploy(&mut registry, &clock, 4_000_000, 4_000_000);

    // wind the venue down: cap below the deployed principal
    allocate::set_adapter_cap<AdapterA>(&cap, &mut registry, venue_a(), 0);
    assert!(allocate::venue_cap_sats<AdapterA>(&registry, venue_a()) == 0, 0);

    // recall still works and drains it completely
    recall(&mut registry, &clock, 4_000_000, 4_000_000, 4_000_000);
    assert!(allocate::principal_sats<AdapterA>(&registry, venue_a()) == 0, 1);
    allocate::remove_adapter<AdapterA>(&cap, &mut registry, venue_a());
    assert!(allocate::adapter_count(&registry) == 0, 2);

    destroy(registry);
    destroy(cap);
    finish(scenario, clock);
}

// ════════════════════════════════════════════════════════════════════════════
// carry.move — the Phase-2 interface.
//
// carry.move is deliberately NOT executed in v2 (see its banner: aphotic.md §11 forbids Phase 2
// in a hackathon window, RECON R10 says the hBTC book is empty on both sides, and aphotic.md §3
// records that a shared object can never hold a Hashi queue position). What EXISTS is the guard
// set every future execution path must close through, and a guard with no test is a guard that
// does not work. These tests are the reason the interface can be trusted later.
// ════════════════════════════════════════════════════════════════════════════

fun p2tr_pin(): vector<u8> {
    let mut address_bytes = vector[];
    let mut i = 0u8;
    while (i < 32u8) {
        address_bytes.push_back(i);
        i = i + 1;
    };
    address_bytes
}

fun params(): carry::CarryParams {
    // hurdle 50 bps, cap 5 BTC, bridge minimum 30_000 sats (RECON R6), 32-byte P2TR pin
    carry::new_carry_params(50, 500_000_000, 30_000, p2tr_pin())
}

#[test]
fun carry_params_accept_20_and_32_byte_pins() {
    let p2wpkh = carry::new_carry_params(
        10,
        1_000,
        30_000,
        b"12345678901234567890",
    );
    assert!(carry::pinned_btc_address(&p2wpkh).length() == 20, 0);
    assert!(carry::hurdle_bps(&p2wpkh) == 10, 1);
    assert!(carry::max_notional_sats(&p2wpkh) == 1_000, 2);
    assert!(carry::min_exit_sats(&p2wpkh) == 30_000, 3);

    let p2tr = params();
    assert!(carry::pinned_btc_address(&p2tr) == p2tr_pin(), 4);
    assert!(carry::bps_denominator() == 10_000, 5);
}

#[test]
#[expected_failure(abort_code = carry::EInvalidExitAddressLength)]
fun carry_params_reject_a_19_byte_pin() {
    carry::new_carry_params(10, 1_000, 30_000, b"1234567890123456789");
}

#[test]
#[expected_failure(abort_code = carry::EInvalidExitAddressLength)]
fun carry_params_reject_an_empty_pin() {
    carry::new_carry_params(10, 1_000, 30_000, b"");
}

#[test]
#[expected_failure(abort_code = carry::ECarryValueLoss)]
fun the_value_floor_aborts_on_a_loss() {
    assert!(!carry::is_value_preserved(1_000_000, 999_999), 0);
    carry::assert_value_preserved(1_000_000, 999_999);
}

#[test]
fun the_value_floor_accepts_break_even() {
    // break-even is preserved: aphotic.md §10 says "less than", not "no more than"
    assert!(carry::is_value_preserved(1_000_000, 1_000_000), 0);
    carry::assert_value_preserved(1_000_000, 1_000_000);
    // and a profitable round trip obviously passes
    assert!(carry::is_value_preserved(1_000_000, 1_004_000), 1);
    carry::assert_value_preserved(1_000_000, 1_004_000);
    // consuming nothing can never lose
    carry::assert_value_preserved(0, 0);
}

#[test]
fun only_the_pinned_address_is_accepted() {
    let p = params();
    assert!(carry::is_pinned_address(&p, &p2tr_pin()), 0);
    carry::assert_pinned_address(&p, &p2tr_pin());
    let other = b"12345678901234567890";
    assert!(!carry::is_pinned_address(&p, &other), 1);
}

#[test]
#[expected_failure(abort_code = carry::EUnpinnedExitAddress)]
fun a_one_byte_difference_is_not_the_pinned_address() {
    let p = params();
    let mut nearly = p2tr_pin();
    let last = nearly.pop_back();
    nearly.push_back(last + 1);
    carry::assert_pinned_address(&p, &nearly);
}

#[test]
fun discount_is_zero_at_or_above_par() {
    assert!(carry::discount_bps(10_000) == 0, 0);
    assert!(carry::discount_bps(10_500) == 0, 1);
    assert!(carry::discount_bps(9_950) == 50, 2);
    assert!(carry::discount_bps(1) == 9_999, 3);
}

#[test]
#[expected_failure(abort_code = carry::EInvalidPrice)]
fun a_zero_price_is_invalid() {
    carry::discount_bps(0);
}

#[test]
fun the_hurdle_is_monotone_in_the_discount() {
    let p = params(); // hurdle 50 bps
    assert!(!carry::hurdle_met(&p, 10_000), 0); // at par: no discount
    assert!(!carry::hurdle_met(&p, 9_951), 1); // 49 bps: short of the hurdle
    assert!(carry::hurdle_met(&p, 9_950), 2); // exactly 50 bps: met
    assert!(carry::hurdle_met(&p, 9_900), 3); // deeper: still met (monotone)
    assert!(carry::hurdle_met(&p, 5_000), 4);
    carry::assert_hurdle_met(&p, 9_950);
}

#[test]
#[expected_failure(abort_code = carry::EHurdleNotMet)]
fun assert_hurdle_met_aborts_below_the_hurdle() {
    let p = params();
    carry::assert_hurdle_met(&p, 9_951);
}

#[test]
fun expected_carry_does_not_overflow_u64() {
    assert!(carry::expected_carry_sats(1_000_000, 50) == 5_000, 0);
    assert!(carry::expected_carry_sats(0, 10_000) == 0, 1);
    assert!(carry::expected_carry_sats(1_000_000, 0) == 0, 2);
    // 1.8e19 sats x 10_000 bps overflows u64 in the numerator; the u128 intermediate must not.
    let huge = 18_446_744_073_709_551_615;
    assert!(carry::expected_carry_sats(huge, 10_000) == huge, 3);
    assert!(carry::expected_carry_sats(huge, 1) == huge / 10_000, 4);
}

#[test]
fun an_exit_at_the_bridge_minimum_is_submittable() {
    let p = params();
    carry::assert_exit_submittable(&p, 30_000);
    carry::assert_exit_submittable(&p, 30_001);
}

#[test]
#[expected_failure(abort_code = carry::EBelowWithdrawalMinimum)]
fun an_exit_below_the_bridge_minimum_aborts() {
    let p = params();
    // RECON R6: bitcoin_withdrawal_minimum = 30_000 sats. Upstream would abort
    // EBelowMinimumWithdrawal; we refuse earlier, with a readable error.
    carry::assert_exit_submittable(&p, 29_999);
}

#[test]
#[expected_failure(abort_code = carry::ENotionalCapExceeded)]
fun the_notional_cap_binds() {
    let p = params(); // cap 500_000_000 sats
    carry::assert_within_notional_cap(&p, 500_000_000);
    carry::assert_within_notional_cap(&p, 500_000_001);
}
