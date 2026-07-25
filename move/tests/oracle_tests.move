#[test_only]
module aphotic::oracle_tests;

use aphotic::oracle::{Self, EnvelopeParams};
use sui::clock::{Self, Clock};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.1
// @phase      4
// @status     DONE
// @spec       docs/RECON.md#R9-guardian-limiter (L113-L150)   <- the golden vectors
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L638-L644)
// @rules      G3 G5
// @depends    aphotic::envelope (T4.1)
// @facts      These vectors are SHARED with keeper/src/hashi/limiter.ts. The Move function and
// @facts        the TypeScript function must agree byte-for-byte (G5) — if you change one,
// @facts        change the other and re-run BOTH suites.
// @facts      ⚠⚠ RECON R9 ARITHMETIC ERRATA — vectors 1 and 7.
// @facts        R9 states the state {tokens 100_000, refill 10, last 0, cap 2_000_000} and
// @facts        expects 105_000 at t = 15 s (v1) and at elapsed 15_999 ms (v7).
// @facts        R9's own source-verified formula gives min(cap, tokens + elapsed*refill)
// @facts          = min(2_000_000, 100_000 + 15*10) = 100_150, NOT 105_000.
// @facts        105_000 would require elapsed*refill == 5_000, i.e. elapsed == 500 s at
// @facts          refill 10 (or refill 333.33 at 15 s).
// @facts        RESOLUTION: the FORMULA wins — it is the source-verified guardian algorithm and
// @facts          G5 requires byte-identity with it. The vectors below assert the
// @facts          formula-derived 100_150 and additionally pin the 500 s case that yields the
// @facts          105_000 R9 intended. docs/RECON.md R9 and docs/FACTS.md#guardian-limiter
// @facts          must be corrected. Vectors 2-6 are internally consistent and pass as written.
// @implements #[test] fun v1_capacity_at_15_seconds()                         [DONE]
//             #[test] fun v2_capacity_saturates_at_max_time()                 [DONE]
//             #[test] fun v3_consume_debits_and_advances_seq()                [DONE]
//             #[test] fun v4_consume_over_capacity_is_rate_limited()          [DONE]
//             #[test] fun v5_consume_wrong_seq_is_invalid_inputs()            [DONE]
//             #[test] fun v6_consume_backwards_timestamp_is_invalid_inputs()  [DONE]
//             #[test] fun v7_milliseconds_floor_to_whole_seconds()            [DONE]
//             #[test] fun saturating_helpers_never_abort()                     [DONE]
//             #[test] fun backwards_clock_refills_nothing()                    [DONE]
//             ── T4.1 (redemption buffer + the pre-action gate) ──
//             #[test] fun accessors_round_trip_the_constructor()               [DONE]
//             #[test] fun setters_are_the_only_way_to_move_a_threshold()       [DONE]
//             #[test] fun buffer_is_the_static_floor_when_the_bridge_can_serve()  [DONE]
//             #[test] fun buffer_holds_the_unserviceable_remainder()           [DONE]
//             #[test] fun static_fallback_governs_at_zero_capacity()           [DONE]
//             #[test] fun deployable_subtracts_the_earmark_before_the_buffer() [DONE]
//             #[test] fun deployable_never_underflows_and_never_exceeds_idle() [DONE]
//             #[test] fun divergence_and_slippage_bps_are_exact()              [DONE]
//             #[test] fun divergence_fails_closed_on_a_missing_price()         [DONE]
//             #[test] fun strategy_availability_gate()                         [DONE]
//             #[test] fun strategy_unavailable_aborts()                        [DONE]
//             #[test] fun strategy_with_an_empty_blob_id_aborts()              [DONE]
//             #[test] fun check_action_succeeds_and_advances_exactly_once()    [DONE]
//             #[test] fun check_action_emits_the_receipt()                     [DONE]
//             #[test] fun check_action_aborts_when_paused()                    [DONE]
//             #[test] fun check_action_aborts_on_cooldown()                    [DONE]
//             #[test] fun first_action_is_never_cooled_down()                  [DONE]
//             #[test] fun check_action_aborts_on_oracle_divergence()           [DONE]
//             #[test] fun check_action_aborts_on_buffer_breach()               [DONE]
//             #[test] fun check_action_aborts_on_the_epoch_notional_cap()      [DONE]
//             #[test] fun check_action_aborts_on_slippage()                    [DONE]
//             #[test] fun a_priceless_action_skips_only_the_slippage_bound()   [DONE]
//             #[test] fun the_epoch_notional_budget_rolls()                    [DONE]
//             #[test] fun a_zero_epoch_len_never_rolls()                       [DONE]
//             #[test] fun abort_order_is_pause_cooldown_divergence_buffer_cap_slippage() [DONE]
// @invariant  1. `project_capacity` never aborts, for any u64 input (saturating throughout).
// @invariant  2. A non-OK `replay_consume` returns the state UNCHANGED.
// @invariant  3. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @ac         all 7 RECON R9 golden vectors green
// @ac         docs/MOVE-PACKAGE.md §8 envelope_tests checklist (L638-L644)
// @verify     sui move test envelope
// └── END CONTRACT ───────────────────────────────────────────────────────────

const MAX_U64: u64 = 18_446_744_073_709_551_615;

// Shared bucket config for vectors 1, 2 and 7.
const V_TOKENS: u64 = 100_000;
const V_REFILL: u64 = 10;
const V_CAP: u64 = 2_000_000;

// ── R9 vector 1 — capacity at t = 15 s ──────────────────────────────────────
#[test]
fun v1_capacity_at_15_seconds() {
    // FORMULA-DERIVED: min(2_000_000, 100_000 + 15*10) = 100_150.
    // (R9 writes 105_000; see the ERRATA in the banner.)
    assert!(oracle::project_capacity_secs(V_TOKENS, 0, 15, V_REFILL, V_CAP) == 100_150, 0);

    // The case R9 *meant*: 5_000 sats of refill needs 500 s at 10 sats/s.
    assert!(oracle::project_capacity_secs(V_TOKENS, 0, 500, V_REFILL, V_CAP) == 105_000, 1);

    // Refill is measured from `last_updated_at`, not from zero.
    assert!(oracle::project_capacity_secs(V_TOKENS, 100, 115, V_REFILL, V_CAP) == 100_150, 2);
}

// ── R9 vector 2 — capacity at t = u64::MAX saturates at the cap, never aborts ──
#[test]
fun v2_capacity_saturates_at_max_time() {
    assert!(oracle::project_capacity_secs(V_TOKENS, 0, MAX_U64, V_REFILL, V_CAP) == V_CAP, 0);

    // Same through the millisecond wrapper.
    assert!(oracle::project_capacity(V_TOKENS, 0, MAX_U64, V_REFILL, V_CAP) == V_CAP, 1);

    // And with a refill rate large enough that elapsed*refill alone would overflow u64.
    assert!(
        oracle::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, V_CAP) == V_CAP,
        2,
    );

    // A cap of u64::MAX means the saturated sum is returned rather than the cap.
    assert!(
        oracle::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, MAX_U64) == MAX_U64,
        3,
    );
}

// ── R9 vector 3 — consume(42, 100, 80_000) on {100_000, refill 0, last 0, seq 42} ──
#[test]
fun v3_consume_debits_and_advances_seq() {
    let state = oracle::new_limiter_state(100_000, 0, 42);
    let (status, next) = oracle::replay_consume(state, 42, 100, 80_000, 0, V_CAP);

    assert!(status == oracle::limiter_ok(), 0);
    assert!(oracle::limiter_tokens(&next) == 20_000, 1);
    assert!(oracle::limiter_last_updated_at_s(&next) == 100, 2);
    assert!(oracle::limiter_next_seq(&next) == 43, 3);
}

// ── R9 vector 4 — consume(7, 10, 80_000) on {10_000, refill 0, last 0, seq 7} ──
#[test]
fun v4_consume_over_capacity_is_rate_limited() {
    let state = oracle::new_limiter_state(10_000, 0, 7);
    let (status, next) = oracle::replay_consume(state, 7, 10, 80_000, 0, V_CAP);

    // G3: over-capacity is REJECTED, never queued. There is no priority to buy.
    assert!(status == oracle::limiter_rate_limit_exceeded(), 0);

    // The state is returned untouched.
    assert!(oracle::limiter_tokens(&next) == 10_000, 1);
    assert!(oracle::limiter_last_updated_at_s(&next) == 0, 2);
    assert!(oracle::limiter_next_seq(&next) == 7, 3);
}

// ── R9 vector 5 — consume(1, 0, 0) on genesis is a sequence violation ────────
#[test]
fun v5_consume_wrong_seq_is_invalid_inputs() {
    let genesis = oracle::genesis_limiter_state(V_CAP);
    assert!(oracle::limiter_tokens(&genesis) == V_CAP, 0);
    assert!(oracle::limiter_last_updated_at_s(&genesis) == 0, 1);
    assert!(oracle::limiter_next_seq(&genesis) == 0, 2);

    let (status, next) = oracle::replay_consume(genesis, 1, 0, 0, 1_000, V_CAP);

    assert!(status == oracle::limiter_invalid_inputs(), 3);
    assert!(oracle::limiter_tokens(&next) == V_CAP, 4);
    assert!(oracle::limiter_next_seq(&next) == 0, 5);
}

// ── R9 vector 6 — after consume(0, 100, 1000), consume(1, 50, 1000) goes backwards in time ──
#[test]
fun v6_consume_backwards_timestamp_is_invalid_inputs() {
    let genesis = oracle::genesis_limiter_state(V_CAP);
    let (status_first, after_first) = oracle::replay_consume(genesis, 0, 100, 1_000, 1_000, V_CAP);

    assert!(status_first == oracle::limiter_ok(), 0);
    // Refill clamps to the cap BEFORE the debit: min(2_000_000, 2_000_000 + 100*1_000) - 1_000.
    assert!(oracle::limiter_tokens(&after_first) == 1_999_000, 1);
    assert!(oracle::limiter_last_updated_at_s(&after_first) == 100, 2);
    assert!(oracle::limiter_next_seq(&after_first) == 1, 3);

    let (status_second, after_second) = oracle::replay_consume(
        after_first,
        1,
        50,
        1_000,
        1_000,
        V_CAP,
    );

    assert!(status_second == oracle::limiter_invalid_inputs(), 4);
    assert!(oracle::limiter_tokens(&after_second) == 1_999_000, 5);
    assert!(oracle::limiter_last_updated_at_s(&after_second) == 100, 6);
    assert!(oracle::limiter_next_seq(&after_second) == 1, 7);
}

// ── R9 vector 7 — 15_999 ms floors to 15 s of refill, not 16 ────────────────
#[test]
fun v7_milliseconds_floor_to_whole_seconds() {
    // FORMULA-DERIVED: 15 s * 10 sats/s = 150. (R9 writes 105_000; see the ERRATA.)
    assert!(oracle::project_capacity(V_TOKENS, 0, 15_999, V_REFILL, V_CAP) == 100_150, 0);

    // 15_999 ms and 15_000 ms must be indistinguishable.
    assert!(
        oracle::project_capacity(V_TOKENS, 0, 15_999, V_REFILL, V_CAP)
            == oracle::project_capacity(V_TOKENS, 0, 15_000, V_REFILL, V_CAP),
        1,
    );

    // Sub-second elapsed refills nothing.
    assert!(oracle::project_capacity(V_TOKENS, 0, 999, V_REFILL, V_CAP) == V_TOKENS, 2);
    assert!(oracle::project_capacity(V_TOKENS, 0, 1_000, V_REFILL, V_CAP) == V_TOKENS + 10, 3);

    // Flooring is applied to the ELAPSED span, not to each endpoint independently:
    // 1_999 ms -> 999 ms is 1_000 ms elapsed = 1 s, even though 1_999/1_000 == 999/1_000 == 0/1.
    assert!(oracle::project_capacity(V_TOKENS, 999, 1_999, V_REFILL, V_CAP) == V_TOKENS + 10, 4);
}

// ── saturating-arithmetic guards (Move u64 add/mul ABORT on overflow) ───────
#[test]
fun saturating_helpers_never_abort() {
    assert!(oracle::saturating_sub(5, 9) == 0, 0);
    assert!(oracle::saturating_sub(9, 5) == 4, 1);
    assert!(oracle::saturating_add(MAX_U64, 1) == MAX_U64, 2);
    assert!(oracle::saturating_add(0, 0) == 0, 3);
    assert!(oracle::saturating_mul(MAX_U64, 2) == MAX_U64, 4);
    assert!(oracle::saturating_mul(MAX_U64, 0) == 0, 5);
    assert!(oracle::saturating_mul(3, 4) == 12, 6);
}

// ── a clock that runs backwards must refill nothing, not underflow ─────────
#[test]
fun backwards_clock_refills_nothing() {
    assert!(oracle::project_capacity_secs(V_TOKENS, 100, 50, V_REFILL, V_CAP) == V_TOKENS, 0);
    assert!(oracle::project_capacity(V_TOKENS, 100_000, 50, V_REFILL, V_CAP) == V_TOKENS, 1);
}

// ════════════════════════════════════════════════════════════════════════════
// T4.1 — the redemption buffer and the pre-action gate
// ════════════════════════════════════════════════════════════════════════════

const OWNER: address = @0x0A;

/// DeepBook FLOAT_SCALING mid at BTC ~ $100_000 (`quote = base * price / 1e9`).
const BOOK_MID: u128 = 1_000_000_000_000;

/// Live testnet limiter scalars (E-K2): 115_740 sats/s into a 100 BTC bucket.
const LIVE_REFILL: u64 = 115_740;
const LIVE_CAP: u64 = 10_000_000_000;

/// The reference envelope every check_action test starts from:
///   slippage 50 bps · 1 BTC of notional per epoch · 1 s cooldown · 100 bps (1 %) buffer floor.
fun base_params(): EnvelopeParams {
    oracle::new_envelope_params(50, 100_000_000, 1_000, 100, LIVE_REFILL, LIVE_CAP, 0)
}

fun a_vault_id(): ID { object::id_from_address(@0xFA017) }

/// A clock parked at `ms`, in its own scenario. Every check_action test needs one because the
/// cooldown and the epoch roll are clock-driven.
fun clock_at(scenario: &mut Scenario, ms: u64): Clock {
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(ms);
    clk
}

/// `check_action` with the reference vault state: 1 BTC idle, NAV == idle, nothing earmarked,
/// no exit demand, the bridge bucket full. Only the arguments a test actually varies are
/// parameters.
fun check(
    params: &mut EnvelopeParams,
    idle_sats: u64,
    earmarked: u64,
    demand: u64,
    capacity: u64,
    notional: u64,
    action_price: u128,
    oracle_mid: u128,
    clk: &Clock,
) {
    oracle::check_action(
        a_vault_id(),
        false,
        idle_sats,
        idle_sats,
        earmarked,
        demand,
        capacity,
        params,
        notional,
        action_price,
        BOOK_MID,
        oracle_mid,
        clk,
    );
}

// ── accessors / setters ─────────────────────────────────────────────────────

#[test]
fun accessors_round_trip_the_constructor() {
    let p = oracle::new_envelope_params(50, 100_000_000, 1_000, 100, LIVE_REFILL, LIVE_CAP, 7);

    assert!(oracle::max_slippage_bps(&p) == 50, 0);
    assert!(oracle::max_notional_per_epoch_sats(&p) == 100_000_000, 1);
    assert!(oracle::min_cooldown_ms(&p) == 1_000, 2);
    assert!(oracle::buffer_ratio_bps(&p) == 100, 3);
    assert!(oracle::limiter_refill_rate(&p) == LIVE_REFILL, 4);
    assert!(oracle::limiter_max_capacity(&p) == LIVE_CAP, 5);
    assert!(oracle::epoch_start_ms(&p) == 7, 6);

    // Epoch accounting starts empty, so the FIRST action is never cooled down.
    assert!(oracle::epoch_notional_used_sats(&p) == 0, 7);
    assert!(oracle::last_action_ms(&p) == 0, 8);

    // The two T4.1 fields are DEFAULTED, keeping the constructor at 7 arguments (delta (b)).
    assert!(oracle::max_divergence_bps(&p) == oracle::default_max_divergence_bps(), 9);
    assert!(oracle::epoch_len_ms(&p) == oracle::default_epoch_len_ms(), 10);
    assert!(oracle::default_max_divergence_bps() == 200, 11);
    assert!(oracle::default_epoch_len_ms() == 86_400_000, 12);
    assert!(oracle::bps_denominator() == 10_000, 13);
}

#[test]
fun setters_are_the_only_way_to_move_a_threshold() {
    let mut p = base_params();

    oracle::set_max_divergence_bps(&mut p, 25);
    oracle::set_epoch_len_ms(&mut p, 0);

    assert!(oracle::max_divergence_bps(&p) == 25, 0);
    assert!(oracle::epoch_len_ms(&p) == 0, 1);

    // Nothing else moved.
    assert!(oracle::max_slippage_bps(&p) == 50, 2);
    assert!(oracle::buffer_ratio_bps(&p) == 100, 3);
}

// ── the redemption buffer (G3) ──────────────────────────────────────────────

#[test]
fun buffer_is_the_static_floor_when_the_bridge_can_serve() {
    let p = base_params(); // 100 bps == 1 %

    // Demand 5_000_000 sats, bucket can clear 10 BTC ⇒ nothing is unserviceable, so the
    // OWNER-set static floor governs: 1 % of a 100_000_000 sat NAV.
    let buffer = oracle::buffer_sats(100_000_000, 5_000_000, LIVE_CAP, &p);
    assert!(buffer == 1_000_000, 0);
}

#[test]
fun buffer_holds_the_unserviceable_remainder() {
    let p = base_params();

    // The bridge can only clear 2_000_000 of 9_000_000 sats of demand. The vault must hold the
    // 7_000_000 sat remainder idle — you cannot buy priority in the global queue (G3).
    let buffer = oracle::buffer_sats(100_000_000, 9_000_000, 2_000_000, &p);
    assert!(buffer == 7_000_000, 0);

    // ...and that dominates the 1_000_000 static floor, which is what `max` is for.
    assert!(buffer > oracle::buffer_sats(100_000_000, 0, LIVE_CAP, &p), 1);
}

#[test]
fun static_fallback_governs_at_zero_capacity() {
    let p = base_params();

    // projected_capacity == 0 forces the U3 fallback path (RECON R7.2: no on-chain queue-depth
    // getter exists). With no demand either, the buffer is exactly the bps floor.
    assert!(oracle::buffer_sats(100_000_000, 0, 0, &p) == 1_000_000, 0);

    // A keeper attesting capacity == 0 AND demand == 0 cannot push the buffer below the floor —
    // that is the whole trust bound.
    assert!(oracle::buffer_sats(100_000_000, 0, 0, &p) >= 1_000_000, 1);
}

#[test]
fun deployable_subtracts_the_earmark_before_the_buffer() {
    let p = base_params();

    // idle 100_000_000 sats, of which 30_000_000 are POOLED sub-minimum exits whose shares are
    // already burned (vault @invariant 3 / envelope @invariant 6). NAV excludes them.
    let nav = 70_000_000;
    let deployable = oracle::deployable_sats(100_000_000, nav, 30_000_000, 0, LIVE_CAP, &p);

    // (100_000_000 - 30_000_000) - 1 % of 70_000_000 = 70_000_000 - 700_000.
    assert!(deployable == 69_300_000, 0);

    // Dropping the earmark would have let the keeper deploy other depositors' exit sats.
    let without_earmark = oracle::deployable_sats(100_000_000, nav, 0, 0, LIVE_CAP, &p);
    assert!(without_earmark == 99_300_000, 1);
    assert!(deployable < without_earmark, 2);
}

#[test]
fun deployable_never_underflows_and_never_exceeds_idle() {
    let p = base_params();

    // Buffer larger than the whole idle balance -> 0, not an abort and not a wrap (@invariant 2).
    assert!(oracle::deployable_sats(1_000, 100_000_000, 0, 0, LIVE_CAP, &p) == 0, 0);

    // Earmark larger than idle -> 0.
    assert!(oracle::deployable_sats(1_000, 1_000, MAX_U64, 0, LIVE_CAP, &p) == 0, 1);

    // Unserviceable demand at u64::MAX -> 0, no overflow anywhere.
    assert!(oracle::deployable_sats(MAX_U64, MAX_U64, 0, MAX_U64, 0, &p) == 0, 2);

    // deployable <= idle for every combination above, and for a zero-buffer envelope.
    let zero_buffer = oracle::new_envelope_params(50, MAX_U64, 0, 0, LIVE_REFILL, LIVE_CAP, 0);
    assert!(oracle::deployable_sats(12_345, 12_345, 0, 0, LIVE_CAP, &zero_buffer) == 12_345, 3);

    // A 100 % buffer ratio strands everything.
    let all_buffer = oracle::new_envelope_params(50, MAX_U64, 0, 10_000, LIVE_REFILL, LIVE_CAP, 0);
    assert!(oracle::deployable_sats(12_345, 12_345, 0, 0, LIVE_CAP, &all_buffer) == 0, 4);
}

// ── the two bps breakers ────────────────────────────────────────────────────

#[test]
fun divergence_and_slippage_bps_are_exact() {
    // 1 % above the oracle == 100 bps, measured against the oracle reference.
    assert!(oracle::divergence_bps(101_000_000_000_000, 100_000_000_000_000) == 100, 0);
    // ...and symmetric below it.
    assert!(oracle::divergence_bps(99_000_000_000_000, 100_000_000_000_000) == 100, 1);
    assert!(oracle::divergence_bps(BOOK_MID, BOOK_MID) == 0, 2);

    // Slippage is measured against the BOOK mid (G9: never a raw oracle price).
    assert!(oracle::slippage_bps(BOOK_MID + BOOK_MID / 100, BOOK_MID) == 100, 3);
    assert!(oracle::slippage_bps(BOOK_MID - BOOK_MID / 200, BOOK_MID) == 50, 4);
    assert!(oracle::slippage_bps(BOOK_MID, BOOK_MID) == 0, 5);
}

#[test]
fun divergence_fails_closed_on_a_missing_price() {
    // No oracle reading, or an empty book (E-M7: the live testnet state) must NOT read as
    // "zero divergence, trade away". Both saturate, so the breaker trips.
    assert!(oracle::divergence_bps(BOOK_MID, 0) == MAX_U64, 0);
    assert!(oracle::divergence_bps(0, BOOK_MID) == MAX_U64, 1);
    assert!(oracle::divergence_bps(0, 0) == MAX_U64, 2);
    assert!(oracle::slippage_bps(BOOK_MID, 0) == MAX_U64, 3);
}

// ── Walrus strategy availability (E-M11: attested OFF-chain) ────────────────

#[test]
fun strategy_availability_gate() {
    oracle::assert_strategy_available(&b"blob-v0", true);
}

#[test]
#[expected_failure(abort_code = oracle::EBlobUnavailable)]
fun strategy_unavailable_aborts() {
    oracle::assert_strategy_available(&b"blob-v0", false);
}

#[test]
#[expected_failure(abort_code = oracle::EBlobUnavailable)]
fun strategy_with_an_empty_blob_id_aborts() {
    oracle::assert_strategy_available(&vector[], true);
}

// ── check_action: the happy path ────────────────────────────────────────────

#[test]
fun check_action_succeeds_and_advances_exactly_once() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, BOOK_MID, BOOK_MID, &clk);

    // @invariant 4: the epoch notional advanced by exactly the action, once.
    assert!(oracle::epoch_notional_used_sats(&p) == 1_000_000, 0);
    assert!(oracle::last_action_ms(&p) == 5_000, 1);

    // A second action past the cooldown accumulates rather than replacing.
    let mut clk2 = clk;
    clk2.set_for_testing(9_000);
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 2_000_000, BOOK_MID, BOOK_MID, &clk2);
    assert!(oracle::epoch_notional_used_sats(&p) == 3_000_000, 2);
    assert!(oracle::last_action_ms(&p) == 9_000, 3);

    clock::destroy_for_testing(clk2);
    scenario.end();
}

#[test]
fun check_action_emits_the_receipt() {
    let mut scenario = ts::begin(OWNER);
    scenario.next_tx(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    check(&mut p, 100_000_000, 0, 4_000_000, LIVE_CAP, 1_000_000, BOOK_MID, BOOK_MID, &clk);

    let events = event::events_by_type<oracle::EnvelopeChecked>();
    assert!(events.length() == 1, 0);
    let (vault_id, notional, deployable, capacity, mid) =
        oracle::envelope_checked_fields(events.borrow(0));

    assert!(vault_id == a_vault_id(), 1);
    assert!(notional == 1_000_000, 2);
    // 100_000_000 idle - 1 % static floor (the bucket can serve the 4_000_000 of demand).
    assert!(deployable == 99_000_000, 3);
    assert!(capacity == LIVE_CAP, 4);
    assert!(mid == BOOK_MID, 5);

    clock::destroy_for_testing(clk);
    scenario.end();
}

// ── check_action: every abort path, IN ORDER ────────────────────────────────

#[test]
#[expected_failure(abort_code = oracle::EPaused)]
fun check_action_aborts_when_paused() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    oracle::check_action(
        a_vault_id(),
        true, // paused
        100_000_000,
        100_000_000,
        0,
        0,
        LIVE_CAP,
        &mut p,
        1_000_000,
        BOOK_MID,
        BOOK_MID,
        BOOK_MID,
        &clk,
    );

    abort 0
}

#[test]
#[expected_failure(abort_code = oracle::ECooldown)]
fun check_action_aborts_on_cooldown() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params(); // cooldown 1_000 ms

    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::last_action_ms(&p) == 5_000, 0);

    // 999 ms later — one millisecond short.
    clk.set_for_testing(5_999);
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, BOOK_MID, BOOK_MID, &clk);

    abort 0
}

#[test]
fun first_action_is_never_cooled_down() {
    let mut scenario = ts::begin(OWNER);
    // Clock at 0 with a 1_000 ms cooldown: `now - last_action_ms` would be 0 < 1_000. A fresh
    // envelope must not be cooled down against its own `last_action_ms == 0` sentinel.
    let clk = clock_at(&mut scenario, 0);
    let mut p = base_params();

    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::epoch_notional_used_sats(&p) == 1_000_000, 0);
    // The sentinel is still 0 because the action itself landed at t = 0 — and the NEXT action
    // is therefore still un-cooled, which is the honest reading of "no action has been timed".
    assert!(oracle::last_action_ms(&p) == 0, 1);

    clock::destroy_for_testing(clk);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = oracle::EOracleDivergence)]
fun check_action_aborts_on_oracle_divergence() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params(); // default breaker = 200 bps

    // Oracle 3 % below the book: 300 bps of divergence. G9 depeg defence.
    let oracle = BOOK_MID - (BOOK_MID * 3) / 100;
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, BOOK_MID, oracle, &clk);

    abort 0
}

#[test]
#[expected_failure(abort_code = oracle::EBufferBreach)]
fun check_action_aborts_on_buffer_breach() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    // 9_000_000 sats of exit demand, the bucket can clear 2_000_000 ⇒ 7_000_000 must stay idle.
    // Deployable is 100_000_000 - 7_000_000 = 93_000_000; the action asks for one sat more.
    check(&mut p, 100_000_000, 0, 9_000_000, 2_000_000, 93_000_001, BOOK_MID, BOOK_MID, &clk);

    abort 0
}

#[test]
#[expected_failure(abort_code = oracle::ENotionalCap)]
fun check_action_aborts_on_the_epoch_notional_cap() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params(); // 100_000_000 sats per epoch

    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 60_000_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::epoch_notional_used_sats(&p) == 60_000_000, 0);

    // 60m + 41m > 100m, and the 24 h window has not rolled.
    clk.set_for_testing(20_000);
    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 41_000_000, BOOK_MID, BOOK_MID, &clk);

    abort 0
}

#[test]
#[expected_failure(abort_code = oracle::ESlippage)]
fun check_action_aborts_on_slippage() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params(); // 50 bps

    // Quote 1 % (100 bps) through the book mid.
    let price = BOOK_MID + BOOK_MID / 100;
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, price, BOOK_MID, &clk);

    abort 0
}

#[test]
fun a_priceless_action_skips_only_the_slippage_bound() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    // `action_price == 0` means "no price leg" (banner delta (a)). Every OTHER check still runs,
    // which the buffer/notional assertions below prove by still being enforced.
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000_000, 0, BOOK_MID, &clk);
    assert!(oracle::epoch_notional_used_sats(&p) == 1_000_000, 0);

    clock::destroy_for_testing(clk);
    scenario.end();
}

// ── the rolling epoch budget ────────────────────────────────────────────────

#[test]
fun the_epoch_notional_budget_rolls() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock_at(&mut scenario, 1_000);
    let mut p = base_params(); // epoch_start_ms 0, epoch_len_ms 86_400_000, cap 100_000_000

    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 90_000_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::epoch_notional_used_sats(&p) == 90_000_000, 0);
    assert!(oracle::epoch_start_ms(&p) == 0, 1);

    // One full day later the window rolls: the budget is fresh, so 90m fits again.
    clk.set_for_testing(86_400_000);
    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 90_000_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::epoch_notional_used_sats(&p) == 90_000_000, 2);
    assert!(oracle::epoch_start_ms(&p) == 86_400_000, 3);

    // Jumping several windows lands on the START of the window containing `now`, not on `now`.
    clk.set_for_testing(86_400_000 * 5 + 123);
    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 1_000, BOOK_MID, BOOK_MID, &clk);
    assert!(oracle::epoch_start_ms(&p) == 86_400_000 * 5, 4);
    assert!(oracle::epoch_notional_used_sats(&p) == 1_000, 5);

    clock::destroy_for_testing(clk);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = oracle::ENotionalCap)]
fun a_zero_epoch_len_never_rolls() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock_at(&mut scenario, 1_000);
    let mut p = base_params();
    oracle::set_epoch_len_ms(&mut p, 0); // one open-ended epoch

    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 90_000_000, BOOK_MID, BOOK_MID, &clk);

    // A year later the budget is still spent.
    clk.set_for_testing(86_400_000 * 365);
    check(&mut p, 200_000_000, 0, 0, LIVE_CAP, 90_000_000, BOOK_MID, BOOK_MID, &clk);

    abort 0
}

// ── the ORDER of the aborts ─────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = oracle::ECooldown)]
fun abort_order_is_pause_cooldown_divergence_buffer_cap_slippage() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = clock_at(&mut scenario, 5_000);
    let mut p = base_params();

    // Land one legal action so the cooldown clock is armed.
    check(&mut p, 100_000_000, 0, 0, LIVE_CAP, 1_000, BOOK_MID, BOOK_MID, &clk);

    // Now violate the cooldown AND the divergence breaker AND the buffer AND the notional cap
    // AND the slippage bound simultaneously. The cooldown is checked second, so it is the one
    // that must surface — if any later check ran first this test would report ITS code instead.
    clk.set_for_testing(5_001);
    oracle::check_action(
        a_vault_id(),
        false,
        1_000, // idle far below the action
        1_000,
        0,
        MAX_U64, // unserviceable demand
        0, // ...with a dead bucket
        &mut p,
        MAX_U64, // notional past the epoch cap
        BOOK_MID * 2, // 10_000 bps of slippage
        BOOK_MID,
        1, // an absurd oracle -> huge divergence
        &clk,
    );

    abort 0
}
