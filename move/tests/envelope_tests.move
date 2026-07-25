#[test_only]
module aphotic::envelope_tests;

use aphotic::envelope;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.1
// @phase      4
// @status     PARTIAL
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
// @invariant  1. `project_capacity` never aborts, for any u64 input (saturating throughout).
// @invariant  2. A non-OK `replay_consume` returns the state UNCHANGED.
// @ac         all 7 RECON R9 golden vectors green
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
    assert!(envelope::project_capacity_secs(V_TOKENS, 0, 15, V_REFILL, V_CAP) == 100_150, 0);

    // The case R9 *meant*: 5_000 sats of refill needs 500 s at 10 sats/s.
    assert!(envelope::project_capacity_secs(V_TOKENS, 0, 500, V_REFILL, V_CAP) == 105_000, 1);

    // Refill is measured from `last_updated_at`, not from zero.
    assert!(envelope::project_capacity_secs(V_TOKENS, 100, 115, V_REFILL, V_CAP) == 100_150, 2);
}

// ── R9 vector 2 — capacity at t = u64::MAX saturates at the cap, never aborts ──
#[test]
fun v2_capacity_saturates_at_max_time() {
    assert!(envelope::project_capacity_secs(V_TOKENS, 0, MAX_U64, V_REFILL, V_CAP) == V_CAP, 0);

    // Same through the millisecond wrapper.
    assert!(envelope::project_capacity(V_TOKENS, 0, MAX_U64, V_REFILL, V_CAP) == V_CAP, 1);

    // And with a refill rate large enough that elapsed*refill alone would overflow u64.
    assert!(
        envelope::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, V_CAP) == V_CAP,
        2,
    );

    // A cap of u64::MAX means the saturated sum is returned rather than the cap.
    assert!(
        envelope::project_capacity_secs(V_TOKENS, 0, MAX_U64, MAX_U64, MAX_U64) == MAX_U64,
        3,
    );
}

// ── R9 vector 3 — consume(42, 100, 80_000) on {100_000, refill 0, last 0, seq 42} ──
#[test]
fun v3_consume_debits_and_advances_seq() {
    let state = envelope::new_limiter_state(100_000, 0, 42);
    let (status, next) = envelope::replay_consume(state, 42, 100, 80_000, 0, V_CAP);

    assert!(status == envelope::limiter_ok(), 0);
    assert!(envelope::limiter_tokens(&next) == 20_000, 1);
    assert!(envelope::limiter_last_updated_at_s(&next) == 100, 2);
    assert!(envelope::limiter_next_seq(&next) == 43, 3);
}

// ── R9 vector 4 — consume(7, 10, 80_000) on {10_000, refill 0, last 0, seq 7} ──
#[test]
fun v4_consume_over_capacity_is_rate_limited() {
    let state = envelope::new_limiter_state(10_000, 0, 7);
    let (status, next) = envelope::replay_consume(state, 7, 10, 80_000, 0, V_CAP);

    // G3: over-capacity is REJECTED, never queued. There is no priority to buy.
    assert!(status == envelope::limiter_rate_limit_exceeded(), 0);

    // The state is returned untouched.
    assert!(envelope::limiter_tokens(&next) == 10_000, 1);
    assert!(envelope::limiter_last_updated_at_s(&next) == 0, 2);
    assert!(envelope::limiter_next_seq(&next) == 7, 3);
}

// ── R9 vector 5 — consume(1, 0, 0) on genesis is a sequence violation ────────
#[test]
fun v5_consume_wrong_seq_is_invalid_inputs() {
    let genesis = envelope::genesis_limiter_state(V_CAP);
    assert!(envelope::limiter_tokens(&genesis) == V_CAP, 0);
    assert!(envelope::limiter_last_updated_at_s(&genesis) == 0, 1);
    assert!(envelope::limiter_next_seq(&genesis) == 0, 2);

    let (status, next) = envelope::replay_consume(genesis, 1, 0, 0, 1_000, V_CAP);

    assert!(status == envelope::limiter_invalid_inputs(), 3);
    assert!(envelope::limiter_tokens(&next) == V_CAP, 4);
    assert!(envelope::limiter_next_seq(&next) == 0, 5);
}

// ── R9 vector 6 — after consume(0, 100, 1000), consume(1, 50, 1000) goes backwards in time ──
#[test]
fun v6_consume_backwards_timestamp_is_invalid_inputs() {
    let genesis = envelope::genesis_limiter_state(V_CAP);
    let (status_first, after_first) = envelope::replay_consume(genesis, 0, 100, 1_000, 1_000, V_CAP);

    assert!(status_first == envelope::limiter_ok(), 0);
    // Refill clamps to the cap BEFORE the debit: min(2_000_000, 2_000_000 + 100*1_000) - 1_000.
    assert!(envelope::limiter_tokens(&after_first) == 1_999_000, 1);
    assert!(envelope::limiter_last_updated_at_s(&after_first) == 100, 2);
    assert!(envelope::limiter_next_seq(&after_first) == 1, 3);

    let (status_second, after_second) = envelope::replay_consume(
        after_first,
        1,
        50,
        1_000,
        1_000,
        V_CAP,
    );

    assert!(status_second == envelope::limiter_invalid_inputs(), 4);
    assert!(envelope::limiter_tokens(&after_second) == 1_999_000, 5);
    assert!(envelope::limiter_last_updated_at_s(&after_second) == 100, 6);
    assert!(envelope::limiter_next_seq(&after_second) == 1, 7);
}

// ── R9 vector 7 — 15_999 ms floors to 15 s of refill, not 16 ────────────────
#[test]
fun v7_milliseconds_floor_to_whole_seconds() {
    // FORMULA-DERIVED: 15 s * 10 sats/s = 150. (R9 writes 105_000; see the ERRATA.)
    assert!(envelope::project_capacity(V_TOKENS, 0, 15_999, V_REFILL, V_CAP) == 100_150, 0);

    // 15_999 ms and 15_000 ms must be indistinguishable.
    assert!(
        envelope::project_capacity(V_TOKENS, 0, 15_999, V_REFILL, V_CAP)
            == envelope::project_capacity(V_TOKENS, 0, 15_000, V_REFILL, V_CAP),
        1,
    );

    // Sub-second elapsed refills nothing.
    assert!(envelope::project_capacity(V_TOKENS, 0, 999, V_REFILL, V_CAP) == V_TOKENS, 2);
    assert!(envelope::project_capacity(V_TOKENS, 0, 1_000, V_REFILL, V_CAP) == V_TOKENS + 10, 3);

    // Flooring is applied to the ELAPSED span, not to each endpoint independently:
    // 1_999 ms -> 999 ms is 1_000 ms elapsed = 1 s, even though 1_999/1_000 == 999/1_000 == 0/1.
    assert!(envelope::project_capacity(V_TOKENS, 999, 1_999, V_REFILL, V_CAP) == V_TOKENS + 10, 4);
}

// ── saturating-arithmetic guards (Move u64 add/mul ABORT on overflow) ───────
#[test]
fun saturating_helpers_never_abort() {
    assert!(envelope::saturating_sub(5, 9) == 0, 0);
    assert!(envelope::saturating_sub(9, 5) == 4, 1);
    assert!(envelope::saturating_add(MAX_U64, 1) == MAX_U64, 2);
    assert!(envelope::saturating_add(0, 0) == 0, 3);
    assert!(envelope::saturating_mul(MAX_U64, 2) == MAX_U64, 4);
    assert!(envelope::saturating_mul(MAX_U64, 0) == 0, 5);
    assert!(envelope::saturating_mul(3, 4) == 12, 6);
}

// ── a clock that runs backwards must refill nothing, not underflow ─────────
#[test]
fun backwards_clock_refills_nothing() {
    assert!(envelope::project_capacity_secs(V_TOKENS, 100, 50, V_REFILL, V_CAP) == V_TOKENS, 0);
    assert!(envelope::project_capacity(V_TOKENS, 100_000, 50, V_REFILL, V_CAP) == V_TOKENS, 1);
}

// TODO(T4.1): deployable_sats — when pending_exit_demand > projected_capacity the buffer holds
//             the UNSERVICEABLE remainder idle (G3); deployable is saturating (never underflows).
// TODO(T4.1): static fallback — with projected_capacity == 0 the buffer is the
//             buffer_ratio_bps floor (the unconditional U3 path, RECON R7.2).
// TODO(T4.1): deployable_sats subtracts the pooled small-exit earmark before the buffer
//             (aphotic::vault @invariant 3).
// TODO(T4.1): check_action — ECooldown, EOracleDivergence (G9), EBufferBreach (G3),
//             ENotionalCap, ESlippage each abort IN ORDER; epoch notional advances exactly
//             once on success and EnvelopeChecked is emitted.
