#[test_only]
module aphotic::clearing_tests;

use aphotic::batch::{Self, Batch, BatchRegistry, Order};
use aphotic::clearing::{Self, Clearing};
use aphotic::vault::{Self, Vault};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.2-the-batch (L344-L347)
// @spec       aphotic.md#2-hard-constraints (L55-L56)
// @spec       aphotic.md#10-invariants (L441-L446)   <- the Settlement invariants
// @spec       docs/DESIGN-V2.md#5-clearing-determinism-is-the-product
// @rules      G10
// @depends    aphotic::clearing (T3.4) · aphotic::batch (T3.3) · aphotic::vault (T1.2)
// @facts      PRICE_SCALE = 100_000_000: a limit price is quote-sats per whole hBTC, so a price
// @facts        of exactly 100_000_000 is par and the arithmetic in these vectors is readable
// @facts        by hand — which is the point, because every expected number below was computed
// @facts        by hand from the algorithm and not read back out of the implementation.
// @facts      CANONICAL ORDER USES THE ADDRESS AS A u256, so 0xB0B (2 827) precedes
// @facts        0xA11CE (659 406). `pro_rata_uses_largest_remainder_not_canonical_position`
// @facts        relies on that: the winner of the spare sat is SECOND in canonical order and
// @facts        wins on its fraction alone, which is the only way to tell the two rules apart.
// @implements #[test] fun an_empty_batch_still_settles()
//             #[test] fun a_single_crossing_pair_clears_at_one_price()
//             #[test] fun no_cross_produces_no_fills()
//             #[test] fun clearing_is_idempotent()
//             #[test] fun no_fill_is_outside_its_limit_price()
//             #[test] fun every_fill_maps_to_one_revealed_order()
//             #[test] fun unrevealed_orders_are_absent_from_the_fills()
//             #[test] fun settle_reverts_on_a_value_leak()
//             #[test] fun the_fee_is_an_explicit_credit_term()
//             #[test] fun pro_rata_uses_largest_remainder_not_canonical_position()
//             #[test] fun a_strictly_inside_order_is_rationed_when_matched_is_short()
//             #[test] fun the_lower_price_wins_a_volume_tie()
//             #[test] fun an_underfunded_account_is_truncated_not_failed()
//             #[test] fun a_large_batch_settles_across_many_transactions()
//             #[test] fun stepping_past_the_end_is_a_noop()
//             #[test] fun a_budget_of_one_reaches_the_same_answer()
//             #[test] fun verify_fill_proves_membership_and_rejects_a_forgery()
//             #[test] fun escrow_is_locked_for_the_clearing_and_released_at_settlement()
//             #[test] fun settlement_marks_the_batch_and_frees_the_registry()
// @invariant  1. Every test asserts. An empty body is a defect, not a placeholder.
// @ac         aphotic.md §10 "Settlement"
// @verify     sui move test clearing
// └── END CONTRACT ───────────────────────────────────────────────────────────

public struct TESTBTC has drop {}

public struct TESTUSD has drop {}

public struct APLP has drop {}

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;
const FEES: address = @0xFEE;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const DAVE: address = @0xDA1E;

const HOUR: u64 = 3_600_000;
const PAR: u64 = 100_000_000;

fun bytes32(seed: u8): vector<u8> {
    let mut v = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) {
        v.push_back(seed + (i as u8));
        i = i + 1;
    };
    v
}

fun new_world(sc: &mut Scenario): (Vault<TESTBTC, TESTUSD, APLP>, BatchRegistry) {
    let tcap = coin::create_treasury_cap_for_testing<APLP>(sc.ctx());
    let v = vault::create<TESTBTC, TESTUSD, APLP>(tcap, ADMIN, KEEPER, FEES, sc.ctx());
    let br = batch::create_registry(object::id(&v), sc.ctx());
    (v, br)
}

fun fund(
    sc: &mut Scenario,
    v: &mut Vault<TESTBTC, TESTUSD, APLP>,
    who: address,
    base: u64,
    quote: u64,
) {
    sc.next_tx(who);
    if (base > 0) {
        vault::escrow_top_up_base(v, coin::mint_for_testing<TESTBTC>(base, sc.ctx()), sc.ctx());
    };
    if (quote > 0) {
        vault::escrow_top_up_quote(v, coin::mint_for_testing<TESTUSD>(quote, sc.ctx()), sc.ctx());
    };
}

fun an_order(who: address, is_bid: bool, price: u64, qty: u64, salt: u8): Order {
    batch::new_order(who, is_bid, price, qty, bytes32(salt))
}

/// Open at 07:00, submit everything, close on the 18:00 boundary, reveal `reveal_upto` of the
/// orders, then let the reveal grace lapse so a partially revealed book can still clear.
fun stage_batch(
    sc: &mut Scenario,
    br: &mut BatchRegistry,
    clock: &mut Clock,
    orders: &vector<Order>,
    reveal_upto: u64,
): Batch {
    clock.set_for_testing(7 * HOUR);
    sc.next_tx(BOB);
    let mut b = batch::open_batch(br, clock, sc.ctx());

    let mut i = 0u64;
    while (i < orders.length()) {
        let o = orders.borrow(i);
        sc.next_tx(batch::order_submitter(o));
        batch::submit_order(
            &mut b,
            batch::order_commitment(o),
            bytes32(200),
            bytes32(201),
            clock,
            sc.ctx(),
        );
        i = i + 1;
    };

    clock.set_for_testing(18 * HOUR);
    batch::close_batch(&mut b, clock);

    let mut j = 0u64;
    while (j < reveal_upto) {
        batch::reveal_order(&mut b, j, *orders.borrow(j), clock);
        j = j + 1;
    };

    if (reveal_upto < orders.length()) {
        clock.set_for_testing(18 * HOUR + batch::reveal_grace_ms(&b) + 1);
    };
    b
}

fun drive(
    c: &mut Clearing,
    b: &mut Batch,
    br: &mut BatchRegistry,
    v: &mut Vault<TESTBTC, TESTUSD, APLP>,
    budget: u64,
) {
    while (!clearing::is_done(c)) {
        clearing::step(c, b, br, v, budget);
    };
}

fun drive_until_stage(
    c: &mut Clearing,
    b: &mut Batch,
    br: &mut BatchRegistry,
    v: &mut Vault<TESTBTC, TESTUSD, APLP>,
    stop: u8,
) {
    while (clearing::stage(c) != stop) {
        clearing::step(c, b, br, v, 1);
    };
}

// ── the degenerate passes ───────────────────────────────────────────────────

#[test]
fun an_empty_batch_still_settles() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &vector<Order>[], 0);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    // The cadence settles EVERY pass, with or without orders (spec §7.3).
    assert!(clearing::is_done(&c), 0);
    assert!(clearing::clearing_price(&c) == 0, 1);
    assert!(clearing::matched_base_sats(&c) == 0, 2);
    assert!(clearing::fill_count(&c) == 0, 3);
    assert!(clearing::fills_root(&c).length() == 32, 4);
    assert!(clearing::total_debits(&c) == 0, 5);
    assert!(clearing::total_credits(&c) == 0, 6);
    assert!(batch::state(&b) == batch::state_settled(), 7);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun no_cross_produces_no_fills() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 10_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    // Bid 0.90, ask 1.00 — the book does not cross.
    let orders = vector[
        an_order(ALICE, true, 90_000_000, 1_000_000, 1),
        an_order(BOB, false, PAR, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(clearing::clearing_price(&c) == 0, 0);
    assert!(clearing::matched_base_sats(&c) == 0, 1);
    assert!(clearing::fill_count(&c) == 0, 2);
    assert!(vault::escrow_base_of(&v, BOB) == 1_000_000, 3);
    assert!(vault::escrow_quote_of(&v, ALICE) == 10_000_000, 4);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── the reference cross ─────────────────────────────────────────────────────

#[test]
fun a_single_crossing_pair_clears_at_one_price() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    // ALICE bids 1.01, BOB asks 0.99, both for 0.01 hBTC.
    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    // Both candidates clear 1_000_000 sats with the same |demand − supply|, so the LOWEST
    // price wins the tie: 0.99.
    assert!(clearing::clearing_price(&c) == 99_000_000, 0);
    assert!(clearing::matched_base_sats(&c) == 1_000_000, 1);
    assert!(clearing::fill_count(&c) == 2, 2);

    // Bid pays ceil(1_000_000 × 0.99) = 990_000, rounding TOWARD THE VAULT.
    assert!(clearing::quote_paid_sats(&c) == 990_000, 3);
    // Ask receives floor(990_000) less the 10 bps matched fee = 990_000 − 990.
    assert!(clearing::quote_recv_sats(&c) == 989_010, 4);
    assert!(clearing::fee_quote_sats(&c) == 990, 5);

    // Uniform price: EVERY fill printed at p*.
    let f0 = clearing::fill_at(&c, 0);
    let f1 = clearing::fill_at(&c, 1);
    assert!(clearing::fill_price(&f0) == 99_000_000, 6);
    assert!(clearing::fill_price(&f1) == 99_000_000, 7);

    // The ledger moved, and both books stayed exactly solvent.
    assert!(vault::escrow_base_of(&v, ALICE) == 1_000_000, 8);
    assert!(vault::escrow_quote_of(&v, ALICE) == 1_010_000, 9);
    assert!(vault::escrow_base_of(&v, BOB) == 0, 10);
    assert!(vault::escrow_quote_of(&v, BOB) == 989_010, 11);
    assert!(vault::escrow_quote_of(&v, FEES) == 990, 12);
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 13);
    assert!(clearing::total_debits(&c) == 1_990_000, 14);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun the_fee_is_an_explicit_credit_term() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    let fee = clearing::fee_quote_sats(&c);
    assert!(fee > 0, 0);
    // The fee is a CREDIT, not a shortfall: Σdebits == Σcredits with the fee among the credits.
    assert!(vault::escrow_quote_of(&v, FEES) == fee, 1);
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 2);
    // …and it accrues on MATCHED VOLUME, never on assets under management.
    assert!(fee == 990, 3);
    assert!(vault::fee_matched_bps(&v) == 10, 4);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── determinism ─────────────────────────────────────────────────────────────

#[test]
fun clearing_is_idempotent() {
    let mut sc = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(sc.ctx());

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(CAROL, true, PAR, 400_000, 3),
        an_order(BOB, false, 99_000_000, 900_000, 2),
        an_order(DAVE, false, PAR, 700_000, 4),
    ];

    // Run 1.
    let (mut v1, mut br1) = new_world(&mut sc);
    fund(&mut sc, &mut v1, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v1, CAROL, 0, 5_000_000);
    fund(&mut sc, &mut v1, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v1, DAVE, 2_000_000, 0);
    let mut b1 = stage_batch(&mut sc, &mut br1, &mut clock, &orders, 4);
    let mut c1 = clearing::begin(&br1, &mut b1, &mut v1, &clock, sc.ctx());
    drive(&mut c1, &mut b1, &mut br1, &mut v1, 64);

    // Run 2 — same order set, a fresh world, and a different step budget.
    // A second Clock, because `set_for_testing` refuses to run a clock backwards.
    let mut clock2 = clock::create_for_testing(sc.ctx());
    let (mut v2, mut br2) = new_world(&mut sc);
    fund(&mut sc, &mut v2, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v2, CAROL, 0, 5_000_000);
    fund(&mut sc, &mut v2, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v2, DAVE, 2_000_000, 0);
    let mut b2 = stage_batch(&mut sc, &mut br2, &mut clock2, &orders, 4);
    let mut c2 = clearing::begin(&br2, &mut b2, &mut v2, &clock2, sc.ctx());
    drive(&mut c2, &mut b2, &mut br2, &mut v2, 1);

    // Same price. Same root. Always.
    assert!(clearing::clearing_price(&c1) == clearing::clearing_price(&c2), 0);
    assert!(clearing::fills_root(&c1) == clearing::fills_root(&c2), 1);
    assert!(clearing::matched_base_sats(&c1) == clearing::matched_base_sats(&c2), 2);
    assert!(clearing::fill_count(&c1) == clearing::fill_count(&c2), 3);
    assert!(clearing::total_debits(&c1) == clearing::total_debits(&c2), 4);
    assert!(clearing::matched_base_sats(&c1) > 0, 5);

    clearing::destroy_for_testing(c1);
    clearing::destroy_for_testing(c2);
    batch::destroy_batch_for_testing(b1);
    batch::destroy_batch_for_testing(b2);
    batch::destroy_registry_for_testing(br1);
    batch::destroy_registry_for_testing(br2);
    destroy(v1);
    destroy(v2);
    clock::destroy_for_testing(clock);
    clock::destroy_for_testing(clock2);
    sc.end();
}

#[test]
fun a_budget_of_one_reaches_the_same_answer() {
    let mut sc = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(sc.ctx());

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 900_000, 2),
        an_order(CAROL, false, PAR, 300_000, 3),
    ];

    let (mut v1, mut br1) = new_world(&mut sc);
    fund(&mut sc, &mut v1, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v1, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v1, CAROL, 2_000_000, 0);
    let mut b1 = stage_batch(&mut sc, &mut br1, &mut clock, &orders, 3);
    let mut c1 = clearing::begin(&br1, &mut b1, &mut v1, &clock, sc.ctx());
    // One unit of work per transaction — the resumable path, exercised end to end.
    drive(&mut c1, &mut b1, &mut br1, &mut v1, 1);

    let mut clock2 = clock::create_for_testing(sc.ctx());
    let (mut v2, mut br2) = new_world(&mut sc);
    fund(&mut sc, &mut v2, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v2, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v2, CAROL, 2_000_000, 0);
    let mut b2 = stage_batch(&mut sc, &mut br2, &mut clock2, &orders, 3);
    let mut c2 = clearing::begin(&br2, &mut b2, &mut v2, &clock2, sc.ctx());
    drive(&mut c2, &mut b2, &mut br2, &mut v2, 1_000);

    assert!(clearing::clearing_price(&c1) == clearing::clearing_price(&c2), 0);
    assert!(clearing::fills_root(&c1) == clearing::fills_root(&c2), 1);
    assert!(vault::escrow_quote_of(&v1, BOB) == vault::escrow_quote_of(&v2, BOB), 2);
    assert!(vault::escrow_base_of(&v1, ALICE) == vault::escrow_base_of(&v2, ALICE), 3);

    clearing::destroy_for_testing(c1);
    clearing::destroy_for_testing(c2);
    batch::destroy_batch_for_testing(b1);
    batch::destroy_batch_for_testing(b2);
    batch::destroy_registry_for_testing(br1);
    batch::destroy_registry_for_testing(br2);
    destroy(v1);
    destroy(v2);
    clock::destroy_for_testing(clock);
    clock::destroy_for_testing(clock2);
    sc.end();
}

// ── the settlement invariants ───────────────────────────────────────────────

#[test]
fun no_fill_is_outside_its_limit_price() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v, CAROL, 0, 5_000_000);
    fund(&mut sc, &mut v, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v, DAVE, 2_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 102_000_000, 800_000, 1),
        an_order(CAROL, true, PAR, 600_000, 3),
        an_order(BOB, false, 98_000_000, 900_000, 2),
        an_order(DAVE, false, PAR, 400_000, 4),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 4);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    let p = clearing::clearing_price(&c);
    assert!(p > 0, 0);
    let n = clearing::fill_count(&c);
    assert!(n > 0, 1);
    let mut i = 0u64;
    while (i < n) {
        let f = clearing::fill_at(&c, i);
        let idx = clearing::fill_order_index(&f);
        let o = batch::revealed_at(&b, idx);
        if (clearing::fill_is_bid(&f)) {
            assert!(p <= batch::order_limit_price(&o), 100 + i);
        } else {
            assert!(p >= batch::order_limit_price(&o), 200 + i);
        };
        assert!(clearing::fill_price(&f) == p, 300 + i);
        i = i + 1;
    };

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun every_fill_maps_to_one_revealed_order() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v, CAROL, 0, 5_000_000);
    fund(&mut sc, &mut v, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v, DAVE, 2_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 102_000_000, 800_000, 1),
        an_order(CAROL, true, PAR, 600_000, 3),
        an_order(BOB, false, 98_000_000, 900_000, 2),
        an_order(DAVE, false, PAR, 400_000, 4),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 4);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    let n = clearing::fill_count(&c);
    let mut seen = vector<u64>[];
    let mut i = 0u64;
    while (i < n) {
        let f = clearing::fill_at(&c, i);
        let idx = clearing::fill_order_index(&f);
        // The order exists, was revealed, and its side matches the fill.
        assert!(idx < batch::order_count(&b), 0);
        assert!(batch::is_revealed_at(&b, idx), 1);
        let o = batch::revealed_at(&b, idx);
        assert!(batch::order_is_bid(&o) == clearing::fill_is_bid(&f), 2);
        assert!(clearing::fill_submitter(&f) == batch::order_submitter(&o), 3);
        // …and no order is filled twice.
        assert!(!seen.contains(&idx), 4);
        seen.push_back(idx);
        i = i + 1;
    };
    assert!(n > 0, 5);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun unrevealed_orders_are_absent_from_the_fills() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v, CAROL, 2_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 400_000, 2),
        an_order(CAROL, false, 99_000_000, 400_000, 3),
    ];
    // CAROL's ask is never revealed, so the grace window lapses and the batch clears without it.
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(!batch::is_revealed_at(&b, 2), 0);
    assert!(clearing::matched_base_sats(&c) == 400_000, 1);
    let n = clearing::fill_count(&c);
    let mut i = 0u64;
    while (i < n) {
        let f = clearing::fill_at(&c, i);
        assert!(clearing::fill_order_index(&f) != 2, 2);
        assert!(clearing::fill_submitter(&f) != CAROL, 3);
        i = i + 1;
    };
    // CAROL keeps every satoshi she escrowed.
    assert!(vault::escrow_base_of(&v, CAROL) == 2_000_000, 4);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = clearing::EValueNotPreserved)]
fun settle_reverts_on_a_value_leak() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());

    // Drive to the settling stage, then take a satoshi out of the ask's credit. The tally is
    // recomputed AS the fills are pushed, so the leak is caught rather than assumed away.
    drive_until_stage(&mut c, &mut b, &mut br, &mut v, clearing::stage_settling());
    let mut i = 0u64;
    while (i < clearing::fill_count(&c)) {
        let f = clearing::fill_at(&c, i);
        if (!clearing::fill_is_bid(&f)) clearing::shrink_fill_quote_for_testing(&mut c, i, 1);
        i = i + 1;
    };
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── allocation ──────────────────────────────────────────────────────────────

#[test]
fun pro_rata_uses_largest_remainder_not_canonical_position() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, BOB, 0, 1_000);
    fund(&mut sc, &mut v, ALICE, 0, 1_000);
    fund(&mut sc, &mut v, CAROL, 1_000, 0);

    // Three orders, all at par. Demand 4, supply 3 ⇒ matched 3, and the two bids share it.
    //   canonical order is by address-as-u256: 0xB0B (2 827) precedes 0xA11CE (659 406).
    //   BOB  qty 3 → floor(3 × 3 / 4) = 2, fraction 9 − 8 = 1
    //   ALICE qty 1 → floor(3 × 1 / 4) = 0, fraction 3 − 0 = 3
    //   one sat left over → it goes to the LARGEST FRACTION, which is ALICE, who is SECOND in
    //   canonical order. Position alone would have given it to BOB.
    let orders = vector[
        an_order(BOB, true, PAR, 3, 1),
        an_order(ALICE, true, PAR, 1, 2),
        an_order(CAROL, false, PAR, 3, 3),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 3);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(clearing::clearing_price(&c) == PAR, 0);
    assert!(clearing::matched_base_sats(&c) == 3, 1);
    assert!(vault::escrow_base_of(&v, BOB) == 2, 2);
    assert!(vault::escrow_base_of(&v, ALICE) == 1, 3);
    assert!(vault::escrow_base_of(&v, CAROL) == 997, 4);
    // Nothing was created or destroyed: 2 + 1 == 3.
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 5);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_strictly_inside_order_is_rationed_when_matched_is_short() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 1_000);
    fund(&mut sc, &mut v, BOB, 1_000, 0);

    // "Orders strictly inside the cross fill fully" is the NORMAL case, not a theorem: here the
    // single strictly-inside bid wants 10 and only 3 exists.
    let orders = vector[
        an_order(ALICE, true, PAR, 10, 1),
        an_order(BOB, false, 90_000_000, 3, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(clearing::clearing_price(&c) == 90_000_000, 0);
    assert!(clearing::matched_base_sats(&c) == 3, 1);
    assert!(vault::escrow_base_of(&v, ALICE) == 3, 2);
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 3);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun the_lower_price_wins_a_volume_tie() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    // Both candidate prices clear the same volume with the same imbalance. Candidates are
    // scanned ASCENDING and only a STRICT improvement wins, so the lower price is chosen with
    // no extra branch — which is what makes the rule impossible to implement two ways.
    let orders = vector[
        an_order(ALICE, true, 105_000_000, 500_000, 1),
        an_order(BOB, false, 95_000_000, 500_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(clearing::candidate_count(&c) == 2, 0);
    assert!(clearing::clearing_price(&c) == 95_000_000, 1);
    assert!(clearing::matched_base_sats(&c) == 500_000, 2);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun an_underfunded_account_is_truncated_not_failed() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    // ALICE bids for 1_000_000 sats at par but holds only 500_000 quote sats. There is no
    // margin field on a sealed order — a margin would publish size at submit time — so the
    // quantity is truncated deterministically at LOAD time instead.
    fund(&mut sc, &mut v, ALICE, 0, 500_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, PAR, 1_000_000, 1),
        an_order(BOB, false, PAR, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    // The whole batch settles; only the under-funded fill is smaller.
    assert!(clearing::bid_count(&c) == 1, 0);
    let (_, who, price, qty, fill) = clearing::bid_entry_at(&c, 0);
    assert!(who == ALICE, 1);
    assert!(price == PAR, 2);
    assert!(qty == 500_000, 3);
    assert!(fill == 500_000, 4);
    assert!(clearing::matched_base_sats(&c) == 500_000, 5);
    assert!(vault::escrow_quote_of(&v, ALICE) == 0, 6);
    assert!(vault::escrow_base_of(&v, ALICE) == 500_000, 7);
    assert!(vault::escrow_base_of(&v, BOB) == 500_000, 8);
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 9);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun a_large_batch_settles_across_many_transactions() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    // 10 bids at par and above, 10 asks at par and below, all for 100_000 sats. The
    // volume-maximising price is par and every order fills.
    let mut orders = vector<Order>[];
    let mut k = 0u64;
    while (k < 10) {
        let bidder = sui::address::from_u256((1_000 + k) as u256);
        let asker = sui::address::from_u256((2_000 + k) as u256);
        fund(&mut sc, &mut v, bidder, 0, 200_000);
        fund(&mut sc, &mut v, asker, 100_000, 0);
        orders.push_back(an_order(bidder, true, PAR + k * 1_000_000, 100_000, (k as u8) + 1));
        orders.push_back(an_order(asker, false, PAR - k * 1_000_000, 100_000, (k as u8) + 50));
        k = k + 1;
    };

    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 20);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());

    // A budget of 3 units per transaction: the whole clearing has to survive being cut into
    // pieces and resumed off an on-chain cursor, which is the property the ceilings demand.
    let mut steps = 0u64;
    while (!clearing::is_done(&c)) {
        clearing::step(&mut c, &mut b, &mut br, &mut v, 3);
        steps = steps + 1;
    };
    assert!(steps > 10, 0);

    assert!(clearing::clearing_price(&c) == PAR, 1);
    assert!(clearing::matched_base_sats(&c) == 1_000_000, 2);
    assert!(clearing::fill_count(&c) == 20, 3);
    assert!(clearing::total_debits(&c) == clearing::total_credits(&c), 4);
    assert!(clearing::bid_count(&c) == 10, 5);
    assert!(clearing::ask_count(&c) == 10, 6);

    // Every bidder holds exactly the base they bought; every asker gave up exactly theirs.
    let mut j = 0u64;
    while (j < 10) {
        let bidder = sui::address::from_u256((1_000 + j) as u256);
        let asker = sui::address::from_u256((2_000 + j) as u256);
        assert!(vault::escrow_base_of(&v, bidder) == 100_000, 100 + j);
        assert!(vault::escrow_base_of(&v, asker) == 0, 200 + j);
        j = j + 1;
    };

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

// ── lifecycle and transparency ──────────────────────────────────────────────

#[test]
fun stepping_past_the_end_is_a_noop() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    let root = clearing::fills_root(&c);
    let debits = clearing::total_debits(&c);
    let alice_base = vault::escrow_base_of(&v, ALICE);

    // Stepping a finished clearing does nothing at all — it is a no-op, not an abort, so a
    // keeper that races itself cannot double-settle and cannot brick the batch either.
    clearing::step(&mut c, &mut b, &mut br, &mut v, 64);
    clearing::step(&mut c, &mut b, &mut br, &mut v, 1);

    assert!(clearing::fills_root(&c) == root, 0);
    assert!(clearing::total_debits(&c) == debits, 1);
    assert!(vault::escrow_base_of(&v, ALICE) == alice_base, 2);
    assert!(clearing::is_done(&c), 3);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun verify_fill_proves_membership_and_rejects_a_forgery() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 5_000_000);
    fund(&mut sc, &mut v, CAROL, 0, 5_000_000);
    fund(&mut sc, &mut v, BOB, 2_000_000, 0);
    fund(&mut sc, &mut v, DAVE, 2_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 102_000_000, 800_000, 1),
        an_order(CAROL, true, PAR, 600_000, 3),
        an_order(BOB, false, 98_000_000, 900_000, 2),
        an_order(DAVE, false, PAR, 400_000, 4),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 4);
    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    let n = clearing::fill_count(&c);
    assert!(n >= 2, 0);
    let mut i = 0u64;
    while (i < n) {
        let f = clearing::fill_at(&c, i);
        let path = clearing::sibling_path_for_testing(&c, i);
        assert!(clearing::verify_fill(&c, &f, i, &path), 100 + i);
        i = i + 1;
    };

    // A forged leaf — same position, a different price — does not verify.
    let path0 = clearing::sibling_path_for_testing(&c, 0);
    let bumped = clearing::clearing_price(&c) + 1;
    clearing::force_fill_price_for_testing(&mut c, 0, bumped);
    let forged = clearing::fill_at(&c, 0);
    assert!(!clearing::verify_fill(&c, &forged, 0, &path0), 1);

    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun escrow_is_locked_for_the_clearing_and_released_at_settlement() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    assert!(vault::active_clearings(&v) == 0, 0);

    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    // Withdrawals are frozen for the duration, so a fill sized against the ledger at load time
    // is still coverable when it is pushed.
    assert!(vault::active_clearings(&v) == 1, 1);

    drive(&mut c, &mut b, &mut br, &mut v, 64);
    assert!(vault::active_clearings(&v) == 0, 2);

    // And the lock really is released: a withdrawal now goes through.
    sc.next_tx(ALICE);
    let out = vault::escrow_withdraw_quote(&mut v, 1_000, sc.ctx());
    assert!(out.value() == 1_000, 3);

    destroy(out);
    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
fun settlement_marks_the_batch_and_frees_the_registry() {
    let mut sc = ts::begin(ADMIN);
    let (mut v, mut br) = new_world(&mut sc);
    let mut clock = clock::create_for_testing(sc.ctx());

    fund(&mut sc, &mut v, ALICE, 0, 2_000_000);
    fund(&mut sc, &mut v, BOB, 1_000_000, 0);

    let orders = vector[
        an_order(ALICE, true, 101_000_000, 1_000_000, 1),
        an_order(BOB, false, 99_000_000, 1_000_000, 2),
    ];
    let mut b = stage_batch(&mut sc, &mut br, &mut clock, &orders, 2);
    assert!(batch::live_batches(&br) == 1, 0);

    let mut c = clearing::begin(&br, &mut b, &mut v, &clock, sc.ctx());
    assert!(batch::state(&b) == batch::state_clearing(), 1);
    drive(&mut c, &mut b, &mut br, &mut v, 64);

    assert!(batch::state(&b) == batch::state_settled(), 2);
    assert!(batch::live_batches(&br) == 0, 3);
    assert!(clearing::clearing_batch_id(&c) == batch::batch_id(&b), 4);
    assert!(clearing::clearing_vault_id(&c) == object::id(&v), 5);

    // The registry is free again, so the next window can open.
    clock.set_for_testing(20 * HOUR);
    sc.next_tx(CAROL);
    let b2 = batch::open_batch(&mut br, &clock, sc.ctx());
    assert!(batch::batch_id(&b2) == 1, 6);

    batch::destroy_batch_for_testing(b2);
    clearing::destroy_for_testing(c);
    batch::destroy_batch_for_testing(b);
    batch::destroy_registry_for_testing(br);
    destroy(v);
    clock::destroy_for_testing(clock);
    sc.end();
}
