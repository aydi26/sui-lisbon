#[test_only]
module aphotic::oracle_tests;

use aphotic::oracle;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.1
// @phase      2
// @status     DONE
// @spec       docs/RECON.md#R9-guardian-limiter (L113-L152)   <- the golden vectors
// @spec       docs/RECON.md#R7-hashi-move-surface (L76-L99)   <- why the queue is ATTESTED
// @spec       aphotic.md#4.4-read-surface-for-pricing-and-nav (L163-L174)
// @spec       aphotic.md#7.6-the-carry (L379-L387)            <- "the tail is the risk"
// @rules      G3 G5 G10
// @depends    aphotic::oracle (T2.1)
// @facts      The limiter vectors are the SHARED cross-implementation contract (G5). If you
// @facts        change one side you change the other and re-run BOTH suites.
// @facts      ⚠⚠ RECON R9 ARITHMETIC ERRATA — vectors 1 and 7 (corrected upstream 2026-07-25).
// @facts        R9 originally printed 105_000 for the state
// @facts        {tokens 100_000, refill 10, last 0, cap 2_000_000} at t = 15 s and at
// @facts        elapsed 15_999 ms. R9's own source-verified formula gives
// @facts          min(cap, tokens + elapsed*refill) = min(2_000_000, 100_000 + 15*10) = 100_150.
// @facts        105_000 would need elapsed*refill == 5_000, i.e. 500 s at refill 10.
// @facts        RESOLUTION: the FORMULA wins — it is the Guardian algorithm and G5 requires
// @facts        byte-identity with it. The vectors below assert 100_150 AND additionally pin the
// @facts        500 s case that yields the 105_000 R9 intended.
// @facts      REFERENCE HISTOGRAM used throughout section 3:
// @facts        edges [600_000, 1_800_000, 3_600_000, 7_200_000] ms,
// @facts        weights [50, 30, 15, 4], tail 1  ⇒ total 100, tail mass 100 bps.
// @facts        cumulative 50 / 80 / 95 / 99 ⇒ p50 = 600_000 · p80 = 1_800_000 ·
// @facts        p95 = 3_600_000 · p99 = 7_200_000 · p100 = UNBOUNDED (it is in the open tail).
// @implements ── 1. the KEPT limiter surface: RECON R9 golden vectors, verbatim ──
//             #[test] fun v1_capacity_at_15_seconds()                             [DONE]
//             #[test] fun v2_capacity_saturates_at_max_time()                     [DONE]
//             #[test] fun v3_consume_debits_and_advances_seq()                    [DONE]
//             #[test] fun v4_consume_over_capacity_is_rate_limited()              [DONE]
//             #[test] fun v5_consume_wrong_seq_is_invalid_inputs()                [DONE]
//             #[test] fun v6_consume_backwards_timestamp_is_invalid_inputs()      [DONE]
//             #[test] fun v7_milliseconds_floor_to_whole_seconds()                [DONE]
//             #[test] fun saturating_helpers_never_abort()                        [DONE]
//             #[test] fun backwards_clock_refills_nothing()                       [DONE]
//             #[test] fun a_rejection_is_observed_not_thrown()                    [DONE]
//             ── 2. the ATTESTED queue snapshot ──
//             #[test] fun age_buckets_partition_the_line()                        [DONE]
//             #[test] fun a_snapshot_round_trips()                                [DONE]
//             #[test] fun the_age_quantile_reads_the_histogram()                  [DONE]
//             #[test] fun an_all_stuck_queue_has_an_unbounded_age()               [DONE]
//             #[test] fun an_empty_queue_reports_unbounded_not_zero()             [DONE]
//             #[test] fun a_wrong_length_histogram_is_rejected()                  [DONE]
//             #[test] fun being_behind_more_than_exists_is_rejected()             [DONE]
//             #[test] fun sats_without_requests_is_rejected()                     [DONE]
//             #[test] fun requests_without_sats_is_rejected()                     [DONE]
//             #[test] fun nothing_may_be_older_than_the_oldest_request()          [DONE]
//             #[test] fun an_empty_queue_may_not_claim_an_oldest_request()        [DONE]
//             #[test] fun an_out_of_range_bucket_is_rejected()                    [DONE]
//             ── 3. the wait-time DISTRIBUTION ──
//             #[test] fun quantiles_walk_the_histogram()                          [DONE]
//             #[test] fun quantiles_round_up_never_short()                        [DONE]
//             #[test] fun the_floor_shifts_every_quantile()                       [DONE]
//             #[test] fun the_open_tail_is_unbounded_not_large()                  [DONE]
//             #[test] fun tail_mass_is_reported_in_bps()                          [DONE]
//             #[test] fun distribution_accessors_round_trip()                     [DONE]
//             #[test] fun a_mismatched_histogram_is_rejected()                    [DONE]
//             #[test] fun an_empty_histogram_is_rejected()                        [DONE]
//             #[test] fun non_increasing_edges_are_rejected()                     [DONE]
//             #[test] fun the_unbounded_sentinel_may_not_be_an_edge()             [DONE]
//             #[test] fun a_massless_distribution_is_rejected()                   [DONE]
//             #[test] fun a_percentile_above_one_hundred_percent_is_rejected()    [DONE]
//             ── 4. composing limiter + queue ──
//             #[test] fun a_covered_request_waits_on_nothing()                    [DONE]
//             #[test] fun the_drain_floor_is_the_deficit_over_the_refill_rate()   [DONE]
//             #[test] fun the_drain_floor_rounds_up()                             [DONE]
//             #[test] fun refill_credited_since_the_last_signature_shortens_the_wait() [DONE]
//             #[test] fun a_dead_bucket_never_drains()                            [DONE]
//             #[test] fun the_drain_floor_never_overflows()                       [DONE]
//             #[test] fun a_pause_pushes_an_eta_to_the_far_side()                 [DONE]
//             #[test] fun project_wait_stacks_the_shape_on_the_floor()            [DONE]
//             #[test] fun a_dead_bucket_makes_every_quantile_unbounded()          [DONE]
//             #[test] fun project_wait_carries_the_pause_into_the_floor()         [DONE]
//             ── 5. carry sizing discipline ──
//             #[test] fun the_hurdle_is_the_time_value_of_the_wait()              [DONE]
//             #[test] fun an_unbounded_wait_admits_no_discount()                  [DONE]
//             #[test] fun the_hurdle_never_overflows()                            [DONE]
// @invariant  1. `project_capacity` never aborts, for any u64 input (saturating throughout).
// @invariant  2. A non-OK `replay_consume` returns the state UNCHANGED and the caller keeps going.
// @invariant  3. No quantile in this suite is compared against a MEAN — the module exposes none,
//                and these tests must never introduce one (aphotic.md §7.6).
// @invariant  4. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @ac         all 7 RECON R9 golden vectors green, verbatim
// @ac         every constructor rejection path has its own `expected_failure` test
// @verify     sui move build
// @verify     sui move test oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

const MAX_U64: u64 = 18_446_744_073_709_551_615;

// Shared bucket config for vectors 1, 2 and 7.
const V_TOKENS: u64 = 100_000;
const V_REFILL: u64 = 10;
const V_CAP: u64 = 2_000_000;

// ════════════════════════════════════════════════════════════════════════════
// 1 — the KEPT limiter surface (RECON R9 golden vectors, verbatim)
// ════════════════════════════════════════════════════════════════════════════

// ── R9 vector 1 — capacity at t = 15 s ──────────────────────────────────────
#[test]
fun v1_capacity_at_15_seconds() {
    // FORMULA-DERIVED: min(2_000_000, 100_000 + 15*10) = 100_150.
    // (R9 originally wrote 105_000; see the ERRATA in the banner.)
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
    assert!(oracle::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, V_CAP) == V_CAP, 2);

    // A cap of u64::MAX means the saturated sum is returned rather than the cap.
    assert!(oracle::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, MAX_U64) == MAX_U64, 3);
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
    // FORMULA-DERIVED: 15 s * 10 sats/s = 150. (R9 originally wrote 105_000; see the ERRATA.)
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

// ── @invariant 2: a rejection is a RETURN VALUE, so the replay survives it ──
#[test]
fun a_rejection_is_observed_not_thrown() {
    // A verifier walking Hashi's WithdrawalSigned stream hits a historically rate-limited batch.
    // If `replay_consume` aborted, that one batch would destroy the whole read. Instead the
    // rejection comes back as a code, the state is untouched, and the walk continues.
    let start = oracle::new_limiter_state(50_000, 0, 3);

    let (rejected, unchanged) = oracle::replay_consume(start, 3, 10, 1_000_000, 0, V_CAP);
    assert!(rejected == oracle::limiter_rate_limit_exceeded(), 0);
    assert!(oracle::limiter_next_seq(&unchanged) == 3, 1);
    assert!(oracle::limiter_tokens(&unchanged) == 50_000, 2);

    // Same sequence number, a size the bucket can serve: the replay picks straight back up.
    let (ok, after) = oracle::replay_consume(unchanged, 3, 10, 20_000, 0, V_CAP);
    assert!(ok == oracle::limiter_ok(), 3);
    assert!(oracle::limiter_tokens(&after) == 30_000, 4);
    assert!(oracle::limiter_next_seq(&after) == 4, 5);

    // A bad sequence number is also observable rather than fatal, and leaves the walk intact.
    let (bad_seq, still) = oracle::replay_consume(after, 99, 20, 1, 0, V_CAP);
    assert!(bad_seq == oracle::limiter_invalid_inputs(), 6);
    assert!(oracle::limiter_next_seq(&still) == 4, 7);
    assert!(oracle::limiter_tokens(&still) == 30_000, 8);
}

// ════════════════════════════════════════════════════════════════════════════
// 2 — the ATTESTED queue snapshot (RECON R7.2: Move cannot read the queue)
// ════════════════════════════════════════════════════════════════════════════

/// Six buckets: 3 fresh, 2 half-hour-old, 1 an hour old, nothing older.
fun fresh_counts(): vector<u64> { vector[3, 2, 1, 0, 0, 0] }

/// The reference snapshot: 6 requests, 2_000_000 sats pending, 1_500_000 of them ahead of us,
/// oldest request 50 minutes old (bucket 2).
fun a_snapshot(): oracle::QueueObservation {
    oracle::new_queue_observation(0, 1_500_000, 2_000_000, fresh_counts(), 3_000_000)
}

#[test]
fun age_buckets_partition_the_line() {
    assert!(oracle::age_bucket_count() == 6, 0);

    // Edges are INCLUSIVE uppers, so each boundary belongs to the lower bucket.
    assert!(oracle::age_bucket_index(0) == 0, 1);
    assert!(oracle::age_bucket_index(600_000) == 0, 2);
    assert!(oracle::age_bucket_index(600_001) == 1, 3);
    assert!(oracle::age_bucket_index(1_800_000) == 1, 4);
    assert!(oracle::age_bucket_index(1_800_001) == 2, 5);
    assert!(oracle::age_bucket_index(3_600_000) == 2, 6);
    assert!(oracle::age_bucket_index(3_600_001) == 3, 7);
    assert!(oracle::age_bucket_index(7_200_000) == 3, 8);
    assert!(oracle::age_bucket_index(7_200_001) == 4, 9);
    assert!(oracle::age_bucket_index(21_600_000) == 4, 10);
    assert!(oracle::age_bucket_index(21_600_001) == 5, 11);
    assert!(oracle::age_bucket_index(MAX_U64) == 5, 12);

    // The last bucket is OPEN — it reports the unbounded sentinel, not a large number.
    assert!(oracle::age_bucket_upper_ms(4) == 21_600_000, 13);
    assert!(oracle::age_bucket_upper_ms(5) == oracle::unbounded_ms(), 14);
}

#[test]
fun a_snapshot_round_trips() {
    let q = a_snapshot();

    assert!(oracle::queue_observed_at_ms(&q) == 0, 0);
    assert!(oracle::queue_ahead_of_us_sats(&q) == 1_500_000, 1);
    assert!(oracle::queue_total_pending_sats(&q) == 2_000_000, 2);
    assert!(oracle::queue_oldest_age_ms(&q) == 3_000_000, 3);

    // The count is DERIVED from the histogram, so no caller can disagree about it.
    assert!(oracle::queue_pending_count(&q) == 6, 4);
    assert!(oracle::queue_age_count_at(&q, 0) == 3, 5);
    assert!(oracle::queue_age_count_at(&q, 1) == 2, 6);
    assert!(oracle::queue_age_count_at(&q, 2) == 1, 7);
    assert!(oracle::queue_age_count_at(&q, 5) == 0, 8);
}

#[test]
fun the_age_quantile_reads_the_histogram() {
    let q = a_snapshot(); // counts 3 / 2 / 1, cumulative 3 / 5 / 6 out of 6

    // p50: target ceil(6 * 0.50) = 3, covered by bucket 0.
    assert!(oracle::queue_age_percentile_ms(&q, 5_000) == 600_000, 0);
    // p60: target ceil(3.6) = 4 — bucket 0 alone is one short, so it rounds into bucket 1.
    assert!(oracle::queue_age_percentile_ms(&q, 6_000) == 1_800_000, 1);
    // p90: target ceil(5.4) = 6, only reached at bucket 2.
    assert!(oracle::queue_age_percentile_ms(&q, 9_000) == 3_600_000, 2);
    // The oldest request is 50 minutes old, so p100 is bounded by the 1 h edge.
    assert!(oracle::queue_age_percentile_ms(&q, 10_000) == 3_600_000, 3);
}

#[test]
fun an_all_stuck_queue_has_an_unbounded_age() {
    // Two requests, both beyond the 6 h edge — the exact shape "depth alone" would hide: a
    // shallow queue that is not moving at all.
    let q = oracle::new_queue_observation(0, 0, 60_000, vector[0, 0, 0, 0, 0, 2], 30_000_000);

    assert!(oracle::queue_pending_count(&q) == 2, 0);
    assert!(oracle::queue_age_percentile_ms(&q, 5_000) == oracle::unbounded_ms(), 1);
    assert!(oracle::queue_age_percentile_ms(&q, 10_000) == oracle::unbounded_ms(), 2);
}

#[test]
fun an_empty_queue_reports_unbounded_not_zero() {
    let q = oracle::new_queue_observation(1_234, 0, 0, vector[0, 0, 0, 0, 0, 0], 0);

    assert!(oracle::queue_pending_count(&q) == 0, 0);
    // There is no age to report. Zero would read as "instant", which is a different claim.
    assert!(oracle::queue_age_percentile_ms(&q, 5_000) == oracle::unbounded_ms(), 1);
}

#[test]
#[expected_failure(abort_code = oracle::EBadAgeHistogram)]
fun a_wrong_length_histogram_is_rejected() {
    let _ = oracle::new_queue_observation(0, 0, 30_000, vector[1, 0, 0], 100);
}

#[test]
#[expected_failure(abort_code = oracle::EInconsistentQueue)]
fun being_behind_more_than_exists_is_rejected() {
    // We cannot be behind 3_000_000 sats when the whole queue holds 2_000_000.
    let _ = oracle::new_queue_observation(0, 3_000_000, 2_000_000, fresh_counts(), 3_000_000);
}

#[test]
#[expected_failure(abort_code = oracle::EInconsistentQueue)]
fun sats_without_requests_is_rejected() {
    let _ = oracle::new_queue_observation(0, 0, 2_000_000, vector[0, 0, 0, 0, 0, 0], 0);
}

#[test]
#[expected_failure(abort_code = oracle::EInconsistentQueue)]
fun requests_without_sats_is_rejected() {
    // Hashi's withdrawal minimum is 30_000 sats, so a pending request never contributes zero.
    let _ = oracle::new_queue_observation(0, 0, 0, fresh_counts(), 3_000_000);
}

#[test]
#[expected_failure(abort_code = oracle::EInconsistentQueue)]
fun nothing_may_be_older_than_the_oldest_request() {
    // Oldest claimed at 10 minutes (bucket 0) while a request sits in the 2 h bucket.
    let _ = oracle::new_queue_observation(0, 0, 60_000, vector[1, 0, 0, 1, 0, 0], 600_000);
}

#[test]
#[expected_failure(abort_code = oracle::EInconsistentQueue)]
fun an_empty_queue_may_not_claim_an_oldest_request() {
    let _ = oracle::new_queue_observation(0, 0, 0, vector[0, 0, 0, 0, 0, 0], 900_000);
}

#[test]
#[expected_failure(abort_code = oracle::EBadAgeHistogram)]
fun an_out_of_range_bucket_is_rejected() {
    let q = a_snapshot();
    let _ = oracle::queue_age_count_at(&q, 6);
}

// ════════════════════════════════════════════════════════════════════════════
// 3 — the wait-time DISTRIBUTION (aphotic.md §7.6)
// ════════════════════════════════════════════════════════════════════════════

fun ref_edges(): vector<u64> { vector[600_000, 1_800_000, 3_600_000, 7_200_000] }

fun ref_weights(): vector<u64> { vector[50, 30, 15, 4] }

/// Total 100, cumulative 50 / 80 / 95 / 99, with 1 unit of mass in the OPEN tail.
fun ref_distribution(floor_ms: u64): oracle::LatencyDistribution {
    oracle::new_latency_distribution(ref_edges(), ref_weights(), 1, floor_ms)
}

#[test]
fun quantiles_walk_the_histogram() {
    let d = ref_distribution(0);

    assert!(oracle::percentile_ms(&d, 5_000) == 600_000, 0);
    assert!(oracle::percentile_ms(&d, 8_000) == 1_800_000, 1);
    assert!(oracle::percentile_ms(&d, 9_500) == 3_600_000, 2);
    assert!(oracle::percentile_ms(&d, 9_900) == 7_200_000, 3);

    assert!(oracle::is_bounded_at_bps(&d, 9_900), 4);
    assert!(oracle::distribution_total_weight(&d) == 100, 5);
}

#[test]
fun quantiles_round_up_never_short() {
    let d = ref_distribution(0);

    // p51 needs ceil(51) = 51 units; bucket 0 holds only 50, so the quantile MUST step up.
    // Rounding down here would report a p51 that covers 50 % — the under-reported tail §7.6
    // forbids.
    assert!(oracle::percentile_ms(&d, 5_100) == 1_800_000, 0);
    // p50 is exactly covered by bucket 0 and must NOT step up.
    assert!(oracle::percentile_ms(&d, 5_000) == 600_000, 1);
    // p95 is exactly covered at bucket 2; p9501 rounds to 96 and steps into bucket 3.
    assert!(oracle::percentile_ms(&d, 9_500) == 3_600_000, 2);
    assert!(oracle::percentile_ms(&d, 9_501) == 7_200_000, 3);
}

#[test]
fun the_floor_shifts_every_quantile() {
    // The deterministic drain floor is arithmetic, not belief: it moves the WHOLE distribution.
    let d = ref_distribution(60_000);

    assert!(oracle::distribution_floor_ms(&d) == 60_000, 0);
    assert!(oracle::percentile_ms(&d, 5_000) == 660_000, 1);
    assert!(oracle::percentile_ms(&d, 9_900) == 7_260_000, 2);

    // Shape and floor stay separable, so a reader can discount the belief and keep the arithmetic.
    let bare = ref_distribution(0);
    assert!(oracle::percentile_ms(&d, 5_000) - oracle::percentile_ms(&bare, 5_000) == 60_000, 3);
}

#[test]
fun the_open_tail_is_unbounded_not_large() {
    let d = ref_distribution(0);

    // 1 unit of 100 sits past the last finite edge. p100 therefore has NO bound, and the
    // module says so instead of quietly returning the last edge.
    assert!(oracle::percentile_ms(&d, 10_000) == oracle::unbounded_ms(), 0);
    assert!(!oracle::is_bounded_at_bps(&d, 10_000), 1);

    // A distribution whose mass is entirely in the tail is unbounded everywhere above p0.
    let all_tail = oracle::new_latency_distribution(ref_edges(), vector[0, 0, 0, 0], 7, 0);
    assert!(oracle::percentile_ms(&all_tail, 1) == oracle::unbounded_ms(), 2);
    assert!(oracle::tail_mass_bps(&all_tail) == 10_000, 3);
}

#[test]
fun tail_mass_is_reported_in_bps() {
    let d = ref_distribution(0);
    assert!(oracle::tail_mass_bps(&d) == 100, 0); // 1 of 100 == 1 % == 100 bps

    let no_tail = oracle::new_latency_distribution(ref_edges(), ref_weights(), 0, 0);
    assert!(oracle::tail_mass_bps(&no_tail) == 0, 1);
    assert!(oracle::percentile_ms(&no_tail, 10_000) == 7_200_000, 2);
}

#[test]
fun distribution_accessors_round_trip() {
    let d = ref_distribution(1_234);

    assert!(oracle::distribution_bucket_count(&d) == 4, 0);
    assert!(oracle::distribution_bucket_upper_ms_at(&d, 0) == 600_000, 1);
    assert!(oracle::distribution_bucket_upper_ms_at(&d, 3) == 7_200_000, 2);
    assert!(oracle::distribution_weight_at(&d, 0) == 50, 3);
    assert!(oracle::distribution_weight_at(&d, 3) == 4, 4);
    assert!(oracle::distribution_tail_weight(&d) == 1, 5);
    assert!(oracle::distribution_total_weight(&d) == 100, 6);
    assert!(oracle::distribution_floor_ms(&d) == 1_234, 7);
    assert!(oracle::bps_denominator() == 10_000, 8);
}

#[test]
#[expected_failure(abort_code = oracle::EBadHistogram)]
fun a_mismatched_histogram_is_rejected() {
    let _ = oracle::new_latency_distribution(ref_edges(), vector[50, 30, 15], 1, 0);
}

#[test]
#[expected_failure(abort_code = oracle::EBadHistogram)]
fun an_empty_histogram_is_rejected() {
    let _ = oracle::new_latency_distribution(vector[], vector[], 1, 0);
}

#[test]
#[expected_failure(abort_code = oracle::EBadHistogram)]
fun non_increasing_edges_are_rejected() {
    let _ = oracle::new_latency_distribution(
        vector[600_000, 600_000, 3_600_000],
        vector[1, 1, 1],
        0,
        0,
    );
}

#[test]
#[expected_failure(abort_code = oracle::EBadHistogram)]
fun the_unbounded_sentinel_may_not_be_an_edge() {
    // The open tail is `tail_weight`. Smuggling it in as a finite edge would let a caller report
    // a bounded quantile for mass that has no bound.
    let _ = oracle::new_latency_distribution(vector[600_000, MAX_U64], vector[1, 1], 0, 0);
}

#[test]
#[expected_failure(abort_code = oracle::EEmptyDistribution)]
fun a_massless_distribution_is_rejected() {
    let _ = oracle::new_latency_distribution(ref_edges(), vector[0, 0, 0, 0], 0, 0);
}

#[test]
#[expected_failure(abort_code = oracle::EBadPercentile)]
fun a_percentile_above_one_hundred_percent_is_rejected() {
    let d = ref_distribution(0);
    let _ = oracle::percentile_ms(&d, 10_001);
}

// ════════════════════════════════════════════════════════════════════════════
// 4 — composing the limiter and the queue
// ════════════════════════════════════════════════════════════════════════════

/// A bucket holding 1_000_000 sats, refilling at 1_000 sats/s into a 100 BTC cap.
const D_TOKENS: u64 = 1_000_000;
const D_REFILL: u64 = 1_000;
const D_CAP: u64 = 10_000_000_000;

fun drain_state(): oracle::LimiterState { oracle::new_limiter_state(D_TOKENS, 0, 0) }

#[test]
fun a_covered_request_waits_on_nothing() {
    let s = drain_state();
    // 500_000 ahead + 100_000 of our own = 600_000 <= the 1_000_000 already in the bucket.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 0, 500_000, 100_000) == 0, 0);
    // Exactly covered is still covered.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 0, 900_000, 100_000) == 0, 1);
}

#[test]
fun the_drain_floor_is_the_deficit_over_the_refill_rate() {
    let s = drain_state();
    // needed 1_600_000, available 1_000_000, deficit 600_000 at 1_000 sats/s = 600 s.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 0, 1_500_000, 100_000) == 600, 0);

    // Our OWN size is part of the deficit — a bigger exit waits longer for the same queue.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 0, 1_500_000, 600_000) == 1_100, 1);
}

#[test]
fun the_drain_floor_rounds_up() {
    let s = drain_state();
    // deficit 600_001 sats at 1_000 sats/s is 600.001 s — a partial second does not clear it.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 0, 1_500_001, 100_000) == 601, 0);
}

#[test]
fun refill_credited_since_the_last_signature_shortens_the_wait() {
    let s = drain_state(); // last_updated_at_s = 0
    // 300 s of refill have already accrued: available 1_300_000, deficit 300_000 = 300 s.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 300, 1_500_000, 100_000) == 300, 0);
    // Far enough forward and the bucket has refilled past the need entirely.
    assert!(oracle::drain_eta_secs(&s, D_REFILL, D_CAP, 10_000, 1_500_000, 100_000) == 0, 1);
}

#[test]
fun a_dead_bucket_never_drains() {
    let s = drain_state();
    // refill_rate == 0: the deficit is never made up. "Unbounded" is the honest answer.
    assert!(
        oracle::drain_eta_secs(&s, 0, D_CAP, 0, 1_500_000, 100_000) == oracle::unbounded_ms(),
        0,
    );
}

#[test]
fun the_drain_floor_never_overflows() {
    let s = drain_state();
    // ahead + own saturates rather than aborting, and the eta clamps rather than wrapping.
    assert!(oracle::drain_eta_secs(&s, 1, D_CAP, 0, MAX_U64, MAX_U64) > 0, 0);
    assert!(oracle::drain_eta_secs(&s, MAX_U64, D_CAP, 0, MAX_U64, MAX_U64) == 1, 1);
    // A cap smaller than the tokens on hand still yields a finite, saturating answer.
    assert!(oracle::drain_eta_secs(&s, 1, 1, MAX_U64, 10, 0) == 9, 2);
}

#[test]
fun a_pause_pushes_an_eta_to_the_far_side() {
    // Reconfiguration window: [1_000_000, 2_800_000) ms.
    let start = 1_000_000;
    let len = 1_800_000;

    // Landing before the window is untouched.
    assert!(oracle::pause_adjusted_eta_ms(600_000, 0, start, len) == 600_000, 0);
    // Landing INSIDE it lands at the far edge instead.
    assert!(oracle::pause_adjusted_eta_ms(1_200_000, 0, start, len) == 2_800_000, 1);
    // The very first instant of the window is inside it.
    assert!(oracle::pause_adjusted_eta_ms(1_000_000, 0, start, len) == 2_800_000, 2);
    // The first instant after it is not.
    assert!(oracle::pause_adjusted_eta_ms(2_800_000, 0, start, len) == 2_800_000, 3);
    assert!(oracle::pause_adjusted_eta_ms(3_000_000, 0, start, len) == 3_000_000, 4);

    // No announced pause is the identity.
    assert!(oracle::pause_adjusted_eta_ms(1_200_000, 0, start, 0) == 1_200_000, 5);
    // An already-unbounded eta stays unbounded.
    assert!(
        oracle::pause_adjusted_eta_ms(oracle::unbounded_ms(), 0, start, len)
            == oracle::unbounded_ms(),
        6,
    );
    // `now` is the origin the eta is measured from, so a later `now` shortens the push.
    assert!(oracle::pause_adjusted_eta_ms(400_000, 900_000, start, len) == 1_900_000, 7);
}

#[test]
fun project_wait_stacks_the_shape_on_the_floor() {
    let q = a_snapshot(); // 1_500_000 sats ahead of us, observed at t = 0
    let s = drain_state();

    let d = oracle::project_wait(
        &q,
        &s,
        D_REFILL,
        D_CAP,
        0, // now_s
        100_000, // our own size
        0, // no announced pause
        0,
        ref_edges(),
        ref_weights(),
        1,
    );

    // deficit 600_000 sats / 1_000 sats per s = 600 s = 600_000 ms of deterministic floor.
    assert!(oracle::distribution_floor_ms(&d) == 600_000, 0);
    assert!(oracle::percentile_ms(&d, 5_000) == 1_200_000, 1);
    assert!(oracle::percentile_ms(&d, 9_500) == 4_200_000, 2);
    // The open tail survives the shift — a floor cannot bound what the shape leaves unbounded.
    assert!(oracle::percentile_ms(&d, 10_000) == oracle::unbounded_ms(), 3);
    assert!(oracle::tail_mass_bps(&d) == 100, 4);
}

#[test]
fun a_dead_bucket_makes_every_quantile_unbounded() {
    let q = a_snapshot();
    let s = drain_state();

    let d = oracle::project_wait(
        &q,
        &s,
        0, // dead bucket
        D_CAP,
        0,
        100_000,
        0,
        0,
        ref_edges(),
        ref_weights(),
        1,
    );

    assert!(oracle::distribution_floor_ms(&d) == oracle::unbounded_ms(), 0);
    assert!(!oracle::is_bounded_at_bps(&d, 5_000), 1);
    assert!(!oracle::is_bounded_at_bps(&d, 1), 2);
    // ...and nothing about the shape can rescue it.
    assert!(oracle::percentile_ms(&d, 9_500) == oracle::unbounded_ms(), 3);
}

#[test]
fun project_wait_carries_the_pause_into_the_floor() {
    let q = a_snapshot(); // observed_at_ms = 0
    let s = drain_state();

    // The 600_000 ms drain floor lands inside the [500_000, 2_300_000) reconfiguration window,
    // so the floor becomes the far edge of the window.
    let d = oracle::project_wait(
        &q,
        &s,
        D_REFILL,
        D_CAP,
        0,
        100_000,
        500_000,
        1_800_000,
        ref_edges(),
        ref_weights(),
        1,
    );

    assert!(oracle::distribution_floor_ms(&d) == 2_300_000, 0);
    assert!(oracle::percentile_ms(&d, 5_000) == 2_900_000, 1);
}

// ════════════════════════════════════════════════════════════════════════════
// 5 — carry sizing discipline (aphotic.md §7.6)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun the_hurdle_is_the_time_value_of_the_wait() {
    assert!(oracle::micro_bps_per_bps() == 1_000_000, 0);
    assert!(oracle::ms_per_year() == 31_536_000_000, 1);

    // A full year at 10 %/yr is, by definition, 1_000 bps == 1e9 micro-bps.
    assert!(
        oracle::required_discount_micro_bps(oracle::ms_per_year(), 1_000) == 1_000_000_000,
        2,
    );

    // Two hours at 10 %/yr: 1_000 * 7_200_000 * 1e6 / 31_536_000_000 = 228_310 micro-bps,
    // i.e. 0.228 bps. Reported in whole bps this would floor to ZERO — which is exactly why the
    // hurdle is denominated in micro-bps.
    assert!(oracle::required_discount_micro_bps(7_200_000, 1_000) == 228_310, 3);

    // Linear in both arguments.
    assert!(oracle::required_discount_micro_bps(14_400_000, 1_000) == 456_621, 4);
    assert!(oracle::required_discount_micro_bps(7_200_000, 2_000) == 456_621, 5);

    // No wait, no hurdle.
    assert!(oracle::required_discount_micro_bps(0, 1_000) == 0, 6);
}

#[test]
fun an_unbounded_wait_admits_no_discount() {
    // The only sizing input this module offers is a QUANTILE, and a quantile in the open tail is
    // unbounded. No discount clears a hurdle with no horizon — the position is simply not sized.
    let d = ref_distribution(0);
    let p100 = oracle::percentile_ms(&d, 10_000);

    assert!(p100 == oracle::unbounded_ms(), 0);
    assert!(oracle::required_discount_micro_bps(p100, 1_000) == oracle::unbounded_ms(), 1);
}

#[test]
fun the_hurdle_never_overflows() {
    // A wait one tick below the sentinel with an absurd cost of capital clamps, never wraps.
    assert!(oracle::required_discount_micro_bps(MAX_U64 - 1, MAX_U64) == MAX_U64, 0);
    assert!(oracle::required_discount_micro_bps(MAX_U64, 0) == MAX_U64, 1);
    assert!(oracle::required_discount_micro_bps(1_000_000, 0) == 0, 2);
}
