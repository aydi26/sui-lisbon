#[test_only]
module aphotic::batch_tests;

use aphotic::batch::{Self, Batch, BatchRegistry, Order};
use aphotic::caps::{Self, CapRegistry, AdminCap, KeeperCap};
use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.2-the-batch (L335-L347)
// @spec       aphotic.md#7.3-cadence (L349-L353)
// @spec       aphotic.md#10-invariants (L452-L455)
// @spec       docs/DESIGN-V2.md#3-the-seal_approve-entry-exactly
// @spec       docs/DESIGN-V2.md#4-timing-is-mechanical-not-operator-chosen
// @rules      G10
// @depends    aphotic::batch (T3.3) · aphotic::caps
// @facts      THE SIXTEEN ORDERED PAIRS are covered by 1 forward test + 10 expected_failure
// @facts        tests. Move cannot catch an abort inside a test, so a monotonicity table has to
// @facts        be written out rather than looped — the alternative is a loop that only ever
// @facts        exercises the successful half, which would prove nothing.
// @facts      THE LE/BE TRAP is the headline case: `seal_approve_opens_on_the_little_endian_id`
// @facts        and `seal_approve_rejects_the_big_endian_id` are the SAME timestamp encoded two
// @facts        ways. The big-endian one must not open, and it fails silently in production —
// @facts        the key server just declines — which is why it is pinned here.
// @implements #[test] fun next_boundary_hits_0600_and_1800_utc()
//             #[test] fun next_boundary_saturates_below_the_offset()
//             #[test] fun close_ms_is_derived_not_supplied()
//             #[test] fun close_before_the_schedule_aborts()
//             #[test] fun close_at_exactly_close_ms_succeeds()
//             #[test] fun opening_and_closing_are_permissionless()
//             #[test] fun a_second_live_batch_is_refused()
//             #[test] fun forward_transitions_all_succeed()
//             #[test] fun transition_0_to_0_aborts() … 3_to_3_aborts()   [10 tests]
//             #[test] fun revealing_while_open_aborts()
//             #[test] fun reading_a_plaintext_while_open_aborts()
//             #[test] fun a_submit_stores_no_plaintext()
//             #[test] fun a_full_batch_rejects_submits_but_does_not_close_early()
//             #[test] fun a_submit_inside_the_cutoff_aborts()
//             #[test] fun revealing_a_mismatched_commitment_aborts()
//             #[test] fun revealing_under_another_submitter_aborts()
//             #[test] fun revealing_twice_aborts()
//             #[test] fun revealing_after_the_grace_window_aborts()
//             #[test] fun clearing_before_the_reveal_window_closes_aborts()
//             #[test] fun clearing_with_everything_revealed_succeeds()
//             #[test] fun clearing_after_the_grace_window_succeeds_half_revealed()
//             #[test] fun order_commitment_binds_every_field()
//             #[test] fun seal_identity_is_48_bytes_and_little_endian()
//             #[test] fun seal_approve_opens_on_the_little_endian_id()
//             #[test] fun seal_approve_rejects_the_big_endian_id()
//             #[test] fun seal_approve_before_the_timelock_aborts()
//             #[test] fun seal_approve_rejects_trailing_bytes()
//             #[test] fun seal_approve_rejects_a_stale_policy_version()
//             #[test] fun seal_approve_rejects_a_short_identity()
//             #[test] fun a_policy_bump_with_a_live_batch_aborts()
//             #[test] fun a_policy_bump_succeeds_once_the_batch_settles()
//             #[test] fun max_batch_size_above_the_hard_cap_is_refused()
//             #[test] fun the_registry_setters_are_admin_gated()
// @invariant  1. Every test asserts. An empty body is a defect, not a placeholder.
// @ac         aphotic.md §10 "Batch"
// @verify     sui move test batch
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;

const HOUR: u64 = 3_600_000;
const DAY: u64 = 86_400_000;
const CADENCE: u64 = 43_200_000;
const OFFSET: u64 = 21_600_000;

fun bytes32(seed: u8): vector<u8> {
    let mut v = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) {
        v.push_back(seed + (i as u8));
        i = i + 1;
    };
    v
}

fun new_env(sc: &mut Scenario): (CapRegistry, BatchRegistry) {
    let uid = object::new(sc.ctx());
    let vault_id = uid.to_inner();
    uid.delete();
    let (reg, vcap) = caps::new_registry(vault_id, ADMIN, KEEPER, sc.ctx());
    let br = batch::create_registry(vault_id, sc.ctx());
    caps::destroy_vault_cap(vcap);
    (reg, br)
}

fun take_caps(sc: &mut Scenario): (AdminCap, KeeperCap) {
    sc.next_tx(ADMIN);
    let a = sc.take_from_sender<AdminCap>();
    sc.next_tx(KEEPER);
    let k = sc.take_from_sender<KeeperCap>();
    (a, k)
}

fun an_order(who: address, is_bid: bool, price: u64, qty: u64, salt: u8): Order {
    batch::new_order(who, is_bid, price, qty, bytes32(salt))
}

fun submit(sc: &mut Scenario, b: &mut Batch, clock: &Clock, o: &Order, who: address) {
    sc.next_tx(who);
    batch::submit_order(b, batch::order_commitment(o), bytes32(200), bytes32(201), clock, sc.ctx());
}

// ── mechanical timing ───────────────────────────────────────────────────────

#[test]
fun next_boundary_hits_0600_and_1800_utc() {
    // Unix epoch day 0 begins at 00:00 UTC, so offset 6 h + cadence 12 h is 06:00 / 18:00.
    assert!(batch::next_boundary(6 * HOUR, CADENCE, OFFSET) == 18 * HOUR, 0);
    assert!(batch::next_boundary(6 * HOUR + 1, CADENCE, OFFSET) == 18 * HOUR, 1);
    assert!(batch::next_boundary(17 * HOUR, CADENCE, OFFSET) == 18 * HOUR, 2);
    assert!(batch::next_boundary(18 * HOUR, CADENCE, OFFSET) == DAY + 6 * HOUR, 3);
    assert!(batch::next_boundary(DAY, CADENCE, OFFSET) == DAY + 6 * HOUR, 4);
    assert!(batch::next_boundary(DAY + 6 * HOUR, CADENCE, OFFSET) == DAY + 18 * HOUR, 5);
    // 90 days out, to prove the periodicity rather than the first two steps.
    assert!(
        batch::next_boundary(90 * DAY + 7 * HOUR, CADENCE, OFFSET) == 90 * DAY + 18 * HOUR,
        6,
    );
}

#[test]
fun next_boundary_saturates_below_the_offset() {
    // Below `offset_ms` the plain formula would skip the FIRST boundary. Production never
    // enters this window (real timestamps are ~1.7e12 ms) but a shared golden-vector twin has
    // to agree on every input, not only the reachable ones.
    assert!(batch::next_boundary(0, CADENCE, OFFSET) == OFFSET, 0);
    assert!(batch::next_boundary(1, CADENCE, OFFSET) == OFFSET, 1);
    assert!(batch::next_boundary(OFFSET - 1, CADENCE, OFFSET) == OFFSET, 2);
}

#[test]
fun close_ms_is_derived_not_supplied() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let b = batch::open_batch(&mut br, &clock, sc.ctx());

    // `open_batch` has no timestamp parameter at all; there is nothing for an operator to
    // choose (hard constraint §2.7).
    assert!(batch::close_ms(&b) == 18 * HOUR, 0);
    assert!(batch::close_ms(&b) == batch::next_boundary(7 * HOUR, CADENCE, OFFSET), 1);
    assert!(batch::opened_at_ms(&b) == 7 * HOUR, 2);
    assert!(batch::state(&b) == batch::state_open(), 3);
    assert!(batch::batch_id(&b) == 0, 4);
    assert!(batch::live_batches(&br) == 1, 5);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ETooEarly)]
fun close_before_the_schedule_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    clock.set_for_testing(18 * HOUR - 1);
    batch::close_batch(&mut b, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun close_at_exactly_close_ms_succeeds() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    // The boundary is `>=`: a transaction landing in the exact millisecond closes the window.
    clock.set_for_testing(18 * HOUR);
    batch::close_batch(&mut b, &clock);

    assert!(batch::state(&b) == batch::state_sealed(), 0);
    assert!(batch::closed_at_ms(&b) == 18 * HOUR, 1);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun opening_and_closing_are_permissionless() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    // CAROL holds no capability of any kind. Liveness is not a privilege (spec §9).
    sc.next_tx(CAROL);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    clock.set_for_testing(18 * HOUR);
    sc.next_tx(CAROL);
    batch::close_batch(&mut b, &clock);
    assert!(batch::state(&b) == batch::state_sealed(), 0);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EBatchAlreadyLive)]
fun a_second_live_batch_is_refused() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let b1 = batch::open_batch(&mut br, &clock, sc.ctx());
    let b2 = batch::open_batch(&mut br, &clock, sc.ctx());

    batch::destroy_batch_for_testing(b1);
    batch::destroy_batch_for_testing(b2);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── the state machine: all sixteen ordered pairs ────────────────────────────

fun a_batch_in(sc: &mut Scenario, br: &mut BatchRegistry, clock: &Clock, s: u8): Batch {
    sc.next_tx(BOB);
    let mut b = batch::open_batch(br, clock, sc.ctx());
    if (s > batch::state_open()) batch::set_state_for_testing(&mut b, s);
    b
}

#[test]
fun forward_transitions_all_succeed() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());

    // 0→1, 0→2, 0→3, 1→2, 1→3, 2→3 — the six strictly increasing pairs.
    let pairs = vector[
        vector[0u8, 1u8],
        vector[0u8, 2u8],
        vector[0u8, 3u8],
        vector[1u8, 2u8],
        vector[1u8, 3u8],
        vector[2u8, 3u8],
    ];
    let mut i = 0u64;
    while (i < pairs.length()) {
        let p = pairs.borrow(i);
        let from = *p.borrow(0);
        let to = *p.borrow(1);
        let mut b = a_batch_in(&mut sc, &mut br, &clock, from);
        batch::set_state_for_testing(&mut b, to);
        assert!(batch::state(&b) == to, i);
        batch::destroy_batch_for_testing(b);
        // The registry only allows one live batch, so release it before the next pair.
        batch::force_release_for_testing(&mut br);
        i = i + 1;
    };

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

macro fun non_monotonic_case($from: u8, $to: u8) {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let clock = clock::create_for_testing(sc.ctx());
    let mut b = a_batch_in(&mut sc, &mut br, &clock, $from);
    batch::set_state_for_testing(&mut b, $to);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_0_to_0_aborts() { non_monotonic_case!(0, 0) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_1_to_0_aborts() { non_monotonic_case!(1, 0) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_1_to_1_aborts() { non_monotonic_case!(1, 1) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_2_to_0_aborts() { non_monotonic_case!(2, 0) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_2_to_1_aborts() { non_monotonic_case!(2, 1) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_2_to_2_aborts() { non_monotonic_case!(2, 2) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_3_to_0_aborts() { non_monotonic_case!(3, 0) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_3_to_1_aborts() { non_monotonic_case!(3, 1) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_3_to_2_aborts() { non_monotonic_case!(3, 2) }

#[test]
#[expected_failure(abort_code = batch::ENonMonotonic)]
fun transition_3_to_3_aborts() { non_monotonic_case!(3, 3) }

// ── nothing is readable before close ────────────────────────────────────────

#[test]
fun a_submit_stores_no_plaintext() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    submit(&mut sc, &mut b, &clock, &o, ALICE);

    // What landed is a commitment, a ciphertext hash, a Walrus locator and the submitter.
    // There is no field to read an amount, a side or a price out of.
    assert!(batch::order_count(&b) == 1, 0);
    assert!(batch::revealed_count(&b) == 0, 1);
    assert!(!batch::is_revealed_at(&b, 0), 2);
    let s = batch::sealed_order_at(&b, 0);
    assert!(batch::sealed_submitter(&s) == ALICE, 3);
    assert!(batch::sealed_commitment(&s) == batch::order_commitment(&o), 4);
    assert!(batch::sealed_ct_hash(&s) == bytes32(200), 5);
    assert!(batch::sealed_blob_id(&s) == bytes32(201), 6);
    assert!(batch::sealed_submitted_at_ms(&s) == 7 * HOUR, 7);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EBadState)]
fun revealing_while_open_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    submit(&mut sc, &mut b, &clock, &o, ALICE);
    batch::reveal_order(&mut b, 0, o, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EBadState)]
fun reading_a_plaintext_while_open_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    submit(&mut sc, &mut b, &clock, &o, ALICE);
    let leaked = batch::revealed_at(&b, 0);

    destroy(leaked);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EBatchFull)]
fun a_full_batch_rejects_submits_but_does_not_close_early() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(ADMIN);
    batch::set_max_batch_size(&mut br, &reg, &admin, 2);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    let o1 = an_order(ALICE, true, 100_000_000, 1, 1);
    let o2 = an_order(BOB, false, 100_000_000, 1, 2);
    submit(&mut sc, &mut b, &clock, &o1, ALICE);
    submit(&mut sc, &mut b, &clock, &o2, BOB);

    // Full — and STILL OPEN. Closing on fullness would hand a spammer the timing lever that
    // uniform-price clearing exists to remove.
    assert!(batch::state(&b) == batch::state_open(), 0);
    assert!(batch::order_count(&b) == 2, 1);

    let o3 = an_order(CAROL, true, 100_000_000, 1, 3);
    submit(&mut sc, &mut b, &clock, &o3, CAROL);

    destroy(admin);
    destroy(keeper);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ESubmitWindowClosed)]
fun a_submit_inside_the_cutoff_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    let cutoff = batch::submit_cutoff_ms(&b);

    // Exactly on the cutoff still lands.
    clock.set_for_testing(18 * HOUR - cutoff);
    let ok = an_order(ALICE, true, 100_000_000, 1, 1);
    submit(&mut sc, &mut b, &clock, &ok, ALICE);
    assert!(batch::order_count(&b) == 1, 0);

    // One millisecond inside it does not: a submit must never be able to race an early key
    // release caused by key-server skew.
    clock.set_for_testing(18 * HOUR - cutoff + 1);
    let late = an_order(BOB, true, 100_000_000, 1, 2);
    submit(&mut sc, &mut b, &clock, &late, BOB);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── reveal ──────────────────────────────────────────────────────────────────

fun open_close_with(
    sc: &mut Scenario,
    br: &mut BatchRegistry,
    clock: &mut Clock,
    orders: &vector<Order>,
): Batch {
    clock.set_for_testing(7 * HOUR);
    sc.next_tx(BOB);
    let mut b = batch::open_batch(br, clock, sc.ctx());
    let mut i = 0u64;
    while (i < orders.length()) {
        let o = orders.borrow(i);
        submit(sc, &mut b, clock, o, batch::order_submitter(o));
        i = i + 1;
    };
    clock.set_for_testing(18 * HOUR);
    batch::close_batch(&mut b, clock);
    b
}

#[test]
#[expected_failure(abort_code = batch::ECommitmentMismatch)]
fun revealing_a_mismatched_commitment_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o]);

    // Same submitter, different quantity — the commitment binds the PLAINTEXT, so a submitter
    // cannot decrypt to one order and settle another.
    let swapped = an_order(ALICE, true, 100_000_000, 999_999, 1);
    batch::reveal_order(&mut b, 0, swapped, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ESubmitterMismatch)]
fun revealing_under_another_submitter_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o]);

    let stolen = an_order(BOB, true, 100_000_000, 500_000, 1);
    batch::reveal_order(&mut b, 0, stolen, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EAlreadyRevealed)]
fun revealing_twice_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o]);
    batch::reveal_order(&mut b, 0, o, &clock);
    assert!(batch::revealed_count(&b) == 1, 0);
    batch::reveal_order(&mut b, 0, o, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ERevealWindowClosed)]
fun revealing_after_the_grace_window_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o]);
    clock.set_for_testing(18 * HOUR + batch::reveal_grace_ms(&b) + 1);
    batch::reveal_order(&mut b, 0, o, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ERevealWindowOpen)]
fun clearing_before_the_reveal_window_closes_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o1 = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let o2 = an_order(BOB, false, 100_000_000, 500_000, 2);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o1, o2]);
    batch::reveal_order(&mut b, 0, o1, &clock);
    // Half revealed and the grace window is still open: a clearing must not start against a
    // partially revealed book.
    batch::to_clearing(&mut b, &clock);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun clearing_with_everything_revealed_succeeds() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o1 = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let o2 = an_order(BOB, false, 100_000_000, 500_000, 2);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o1, o2]);
    batch::reveal_order(&mut b, 0, o1, &clock);
    batch::reveal_order(&mut b, 1, o2, &clock);
    batch::to_clearing(&mut b, &clock);

    assert!(batch::state(&b) == batch::state_clearing(), 0);
    let r0 = batch::revealed_at(&b, 0);
    assert!(batch::order_is_bid(&r0), 1);
    assert!(batch::order_qty_sats(&r0) == 500_000, 2);
    assert!(batch::order_limit_price(&r0) == 100_000_000, 3);
    assert!(batch::order_salt(&r0) == bytes32(1), 4);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun clearing_after_the_grace_window_succeeds_half_revealed() {
    let mut sc = ts::begin(BOB);
    let (reg, mut br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let o1 = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let o2 = an_order(BOB, false, 100_000_000, 500_000, 2);
    let mut b = open_close_with(&mut sc, &mut br, &mut clock, &vector[o1, o2]);
    batch::reveal_order(&mut b, 0, o1, &clock);
    // An unrevealed order does not stall the auction forever; it simply never clears.
    clock.set_for_testing(18 * HOUR + batch::reveal_grace_ms(&b) + 1);
    batch::to_clearing(&mut b, &clock);

    assert!(batch::state(&b) == batch::state_clearing(), 0);
    assert!(batch::revealed_count(&b) == 1, 1);
    assert!(!batch::is_revealed_at(&b, 1), 2);

    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun order_commitment_binds_every_field() {
    let base = an_order(ALICE, true, 100_000_000, 500_000, 1);
    let c = batch::order_commitment(&base);

    assert!(batch::order_commitment(&an_order(BOB, true, 100_000_000, 500_000, 1)) != c, 0);
    assert!(batch::order_commitment(&an_order(ALICE, false, 100_000_000, 500_000, 1)) != c, 1);
    assert!(batch::order_commitment(&an_order(ALICE, true, 100_000_001, 500_000, 1)) != c, 2);
    assert!(batch::order_commitment(&an_order(ALICE, true, 100_000_000, 500_001, 1)) != c, 3);
    assert!(batch::order_commitment(&an_order(ALICE, true, 100_000_000, 500_000, 2)) != c, 4);
    // …and it is stable.
    assert!(batch::order_commitment(&an_order(ALICE, true, 100_000_000, 500_000, 1)) == c, 5);
    assert!(c.length() == 32, 6);
}

// ── the Seal time-lock policy ───────────────────────────────────────────────

#[test]
fun seal_identity_is_48_bytes_and_little_endian() {
    // close_ms = 0x0102 = 258. LITTLE-endian, so the low byte comes FIRST.
    let id = batch::seal_identity(258, 1, @0x0);
    assert!(id.length() == batch::seal_id_len(), 0);
    assert!(id.length() == 48, 1);
    assert!(*id.borrow(0) == 2, 2);
    assert!(*id.borrow(1) == 1, 3);
    let mut i = 2u64;
    while (i < 8) {
        assert!(*id.borrow(i) == 0, 4);
        i = i + 1;
    };
    // policy_version = 1, also little-endian.
    assert!(*id.borrow(8) == 1, 5);
    let mut j = 9u64;
    while (j < 16) {
        assert!(*id.borrow(j) == 0, 6);
        j = j + 1;
    };
    // …and 32 raw address bytes after that.
    let mut k = 16u64;
    while (k < 48) {
        assert!(*id.borrow(k) == 0, 7);
        k = k + 1;
    };
}

#[test]
fun seal_approve_opens_on_the_little_endian_id() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let id = batch::seal_identity(18 * HOUR, batch::policy_version(&br), @0xBA7C);
    clock.set_for_testing(18 * HOUR);
    assert!(batch::check_policy(id, &br, &clock), 0);
    batch::seal_approve_for_testing(id, &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENoAccess)]
fun seal_approve_rejects_the_big_endian_id() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    // The SAME timestamp, encoded the other way round. `bcs::peel_u64` reads little-endian;
    // a big-endian identity produces a policy that never opens, and it fails SILENTLY in
    // production because the key server simply declines. Structural twin of RECON R14.2.
    let be = batch::seal_identity_big_endian_for_testing(
        18 * HOUR,
        batch::policy_version(&br),
        @0xBA7C,
    );
    clock.set_for_testing(18 * HOUR);
    assert!(!batch::check_policy(be, &br, &clock), 0);
    batch::seal_approve_for_testing(be, &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENoAccess)]
fun seal_approve_before_the_timelock_aborts() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let id = batch::seal_identity(18 * HOUR, batch::policy_version(&br), @0xBA7C);
    clock.set_for_testing(18 * HOUR - 1);
    batch::seal_approve_for_testing(id, &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENoAccess)]
fun seal_approve_rejects_trailing_bytes() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    // The `leftovers.length() == 0` check is MANDATORY: without it the policy accepts
    // identities that were never intended.
    let mut id = batch::seal_identity(18 * HOUR, batch::policy_version(&br), @0xBA7C);
    id.push_back(0xFFu8);
    clock.set_for_testing(18 * HOUR);
    batch::seal_approve_for_testing(id, &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENoAccess)]
fun seal_approve_rejects_a_stale_policy_version() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    // Versioning is ours; upstream `tle.move` explicitly omits it, and our package is
    // upgradeable.
    let id = batch::seal_identity(18 * HOUR, batch::policy_version(&br) + 1, @0xBA7C);
    clock.set_for_testing(18 * HOUR);
    batch::seal_approve_for_testing(id, &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::ENoAccess)]
fun seal_approve_rejects_a_short_identity() {
    let mut sc = ts::begin(BOB);
    let (reg, br) = new_env(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    clock.set_for_testing(18 * HOUR);
    batch::seal_approve_for_testing(vector[0u8, 1u8, 2u8], &br, &clock);

    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── governance ──────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = batch::EPolicyBumpWithLiveBatch)]
fun a_policy_bump_with_a_live_batch_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let b = batch::open_batch(&mut br, &clock, sc.ctx());
    // A bump would orphan every order already encrypted under the old identity — silently.
    sc.next_tx(ADMIN);
    batch::set_policy_version(&mut br, &reg, &admin, 2);

    destroy(admin);
    destroy(keeper);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_policy_bump_succeeds_once_the_batch_settles() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(7 * HOUR);

    sc.next_tx(BOB);
    let mut b = batch::open_batch(&mut br, &clock, sc.ctx());
    clock.set_for_testing(18 * HOUR);
    batch::close_batch(&mut b, &clock);
    batch::to_clearing(&mut b, &clock);
    batch::to_settled(&mut b, &mut br);
    assert!(batch::live_batches(&br) == 0, 0);
    assert!(batch::state(&b) == batch::state_settled(), 1);

    sc.next_tx(ADMIN);
    batch::set_policy_version(&mut br, &reg, &admin, 2);
    assert!(batch::policy_version(&br) == 2, 2);

    destroy(admin);
    destroy(keeper);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = batch::EBadParam)]
fun max_batch_size_above_the_hard_cap_is_refused() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);

    assert!(batch::max_batch_size(&br) == batch::default_max_batch_size(), 0);
    sc.next_tx(ADMIN);
    batch::set_max_batch_size(&mut br, &reg, &admin, batch::hard_max_batch_size() + 1);

    destroy(admin);
    destroy(keeper);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun the_registry_setters_are_admin_gated() {
    let mut sc = ts::begin(ADMIN);
    let (reg, mut br) = new_env(&mut sc);
    let (admin, keeper) = take_caps(&mut sc);

    sc.next_tx(CAROL);
    let uid = object::new(sc.ctx());
    let other = uid.to_inner();
    uid.delete();
    let forged = caps::forge_foreign_admin_cap_for_testing(other, sc.ctx());
    batch::set_max_batch_size(&mut br, &reg, &forged, 4);

    destroy(forged);
    destroy(admin);
    destroy(keeper);
    batch::destroy_registry_for_testing(br);
    caps::destroy_registry(reg);
    sc.end();
}
