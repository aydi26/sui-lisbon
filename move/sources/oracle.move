module aphotic::oracle;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.1
// @phase      2
// @status     DONE
// @spec       aphotic.md#4.4-read-surface-for-pricing-and-nav (L163-L174)
// @spec       aphotic.md#7.6-the-carry (L379-L387)
// @spec       aphotic.md#10-invariants (L437-L471)
// @spec       aphotic-governance.md#5-nav-computation (L175-L221)
// @spec       docs/RECON.md#R7-hashi-move-surface (L76-L99)
// @spec       docs/RECON.md#R9-guardian-limiter (L113-L152)
// @rules      G3 G5 G7 G10
// @depends    (none — this module is the intra-package LEAF; see @invariant 0)
//
// ── what this module is ──
// The vault's READ-ONLY view of how long a redemption takes. Three pieces, in dependency order:
//   1. a byte-exact replay of the Guardian token-bucket limiter (RECON R9),
//   2. an attested snapshot of the Hashi withdrawal queue — depth AND age distribution,
//   3. a wait-time DISTRIBUTION built from (1) and (2), never a point estimate.
// It computes; it holds no state, touches no coin and calls nothing. Phase 2 execution
// (`carry.move`) is deliberately NOT built — this is the model that would price it.
//
// @facts      LIMITER TIME BASE = UNIX **SECONDS** (RECON R9). refill_rate is sats/second,
// @facts        last_updated_at is seconds. Sui `Clock` is ms ⇒ floor ms→s at the boundary.
// @facts      project_capacity(cfg, state, ts) = min(cap, tokens + saturating(elapsed_s * refill_rate))
// @facts      consume(seq, ts, amount): seq != next_seq -> InvalidInputs;
// @facts        ts < last_updated_at -> InvalidInputs; capacity < amount -> RateLimitExceeded
// @facts        (REJECTED, never queued — G3); else tokens = capacity - amount (clamp BEFORE debit),
// @facts        last_updated_at = ts, next_seq += 1.
// @facts      genesis LimiterState = { num_tokens_available: max_bucket_capacity,
// @facts        last_updated_at: 0, next_seq: 0 }
// @facts      LIMITER PRIOR (a BOUND, not a fact — U1 unresolved): refill_rate = 1_000 sats/s,
// @facts        max_bucket_capacity = 100_000_000 sats. Never hardcode in logic; pass as arguments.
// @facts      Move u64 add/mul ABORT on overflow ⇒ saturation is emulated EXPLICITLY here
// @facts        (`saturating_add` / `saturating_mul` / `saturating_sub`, all widen to u128).
// @facts      ⚠⚠ NO on-chain queue read is possible. RECON R7.2: every
// @facts        `hashi::withdrawal_queue` getter — all 46 of them — and every `hashi::btc_config`
// @facts        accessor is `public(package)`. `WithdrawalRequestQueue` is a `store` field on
// @facts        `BitcoinState`, itself a dynamic field on `Hashi`, with no public reader.
// @facts        ⇒ `QueueObservation` is KEEPER-ATTESTED. It is a CLAIM, not a read. Every
// @facts        consumer must treat it as adversarial input; the constructor is where the
// @facts        internal-consistency checks that a lie must survive are enforced. The claim is
// @facts        independently falsifiable off-chain against the public queue object, which is why
// @facts        attestation is acceptable here and would not be acceptable for custody.
// @facts      AGE_BUCKET_COUNT = 6, upper edges in ms: 600_000 (10 min) · 1_800_000 (30 min) ·
// @facts        3_600_000 (1 h) · 7_200_000 (2 h) · 21_600_000 (6 h) · OPEN (bucket 5).
// @facts        Chosen against the Hashi cadence: batching is ~10 min 📄, reconfiguration follows
// @facts        every Sui epoch boundary (24 h) 📄, cancellation cooldown is 3_600_000 ms (R6).
// @facts      BPS_DENOMINATOR = 10_000. MICRO_BPS_PER_BPS = 1_000_000.
// @facts      MS_PER_YEAR = 31_536_000_000 (365 d) — the time-value denominator.
// @facts      MAX_U64 = 18_446_744_073_709_551_615 doubles as the UNBOUNDED sentinel
// @facts        (`unbounded_ms()`): a quantile that lands in the open tail has no upper bound,
// @facts        and saying "unbounded" is the honest answer, not a large number.
// @external   (none — this module makes NO external calls and has NO imports. Not `hashi`
//             (its readers are public(package)), not `sui::clock` (timestamps arrive as
//             parameters), not Pyth. That is what keeps it liftable and replayable.)
// @implements ── saturating arithmetic ──
//             public fun saturating_sub(a: u64, b: u64): u64                          [DONE]
//             public fun saturating_add(a: u64, b: u64): u64                          [DONE]
//             public fun saturating_mul(a: u64, b: u64): u64                          [DONE]
//             ── the Guardian limiter, replayed (G5) ──
//             public fun project_capacity_secs(tokens_sats: u64, last_updated_at_s: u64,
//                 now_s: u64, refill_rate: u64, max_capacity: u64): u64               [DONE]
//             public fun project_capacity(tokens_sats: u64, last_signed_ms: u64, now_ms: u64,
//                 refill_rate: u64, max_capacity: u64): u64                           [DONE]
//             public fun replay_consume(state: LimiterState, seq: u64, ts_s: u64,
//                 amount_sats: u64, refill_rate: u64, max_capacity: u64): (u8, LimiterState) [DONE]
//             public fun new_limiter_state(num_tokens_available: u64, last_updated_at_s: u64,
//                 next_seq: u64): LimiterState                                        [DONE]
//             public fun genesis_limiter_state(max_capacity: u64): LimiterState       [DONE]
//             public fun limiter_tokens / limiter_last_updated_at_s / limiter_next_seq
//                 (&LimiterState): u64                                                [DONE]
//             public fun limiter_ok / limiter_invalid_inputs /
//                 limiter_rate_limit_exceeded(): u8                                   [DONE]
//             ── the attested queue snapshot (§4.4) ──
//             public fun new_queue_observation(observed_at_ms: u64, ahead_of_us_sats: u64,
//                 total_pending_sats: u64, age_counts: vector<u64>,
//                 oldest_age_ms: u64): QueueObservation                               [DONE]
//             public fun queue_observed_at_ms / queue_ahead_of_us_sats /
//                 queue_total_pending_sats / queue_pending_count /
//                 queue_oldest_age_ms (&QueueObservation): u64                        [DONE]
//             public fun queue_age_count_at(q: &QueueObservation, i: u64): u64        [DONE]
//             public fun queue_age_percentile_ms(q: &QueueObservation, p_bps: u64): u64 [DONE]
//             public fun age_bucket_count(): u64                                      [DONE]
//             public fun age_bucket_upper_ms(i: u64): u64                             [DONE]
//             public fun age_bucket_index(age_ms: u64): u64                           [DONE]
//             ── the wait-time DISTRIBUTION (§7.6) ──
//             public fun new_latency_distribution(bucket_upper_ms: vector<u64>,
//                 weights: vector<u64>, tail_weight: u64,
//                 floor_ms: u64): LatencyDistribution                                 [DONE]
//             public fun percentile_ms(d: &LatencyDistribution, p_bps: u64): u64      [DONE]
//             public fun is_bounded_at_bps(d: &LatencyDistribution, p_bps: u64): bool [DONE]
//             public fun tail_mass_bps(d: &LatencyDistribution): u64                  [DONE]
//             public fun distribution_floor_ms / distribution_total_weight /
//                 distribution_tail_weight / distribution_bucket_count
//                 (&LatencyDistribution): u64                                         [DONE]
//             public fun distribution_bucket_upper_ms_at / distribution_weight_at
//                 (&LatencyDistribution, u64): u64                                    [DONE]
//             public fun unbounded_ms(): u64                                          [DONE]
//             ── composing the two into an estimate ──
//             public fun drain_eta_secs(state: &LimiterState, refill_rate: u64,
//                 max_capacity: u64, now_s: u64, ahead_sats: u64, own_sats: u64): u64 [DONE]
//             public fun pause_adjusted_eta_ms(eta_ms: u64, now_ms: u64,
//                 next_pause_start_ms: u64, pause_len_ms: u64): u64                   [DONE]
//             public fun project_wait(q: &QueueObservation, state: &LimiterState,
//                 refill_rate: u64, max_capacity: u64, now_s: u64, own_sats: u64,
//                 next_pause_start_ms: u64, pause_len_ms: u64,
//                 empirical_upper_ms: vector<u64>, empirical_weights: vector<u64>,
//                 empirical_tail_weight: u64): LatencyDistribution                    [DONE]
//             ── carry sizing discipline (§7.6) ──
//             public fun required_discount_micro_bps(wait_ms: u64,
//                 cost_of_capital_bps_per_year: u64): u64                             [DONE]
//             public fun bps_denominator / micro_bps_per_bps / ms_per_year(): u64     [DONE]
// @events     (none). Every function here is PURE — the module owns no object, mutates nothing
//             and has no externally-visible state transition to emit. G10's "emit an event for
//             every state transition" is satisfied vacuously; inventing an event for a pure
//             read would emit a keeper's *claim* as if it were a chain fact.
// @errors     EBadAgeHistogram · EInconsistentQueue · EBadHistogram · EEmptyDistribution
//             · EBadPercentile
// @forbidden  a mean / expected-wait accessor of any kind. aphotic.md §7.6: "Do not size the
//             carry off a point estimate. The tail is the risk." The absence is the mechanism —
//             a caller physically cannot obtain a mean from this module, so it must choose a
//             quantile and confront `unbounded_ms()` when the quantile lands in the open tail.
// @forbidden  reading `hashi::withdrawal_queue` / `hashi::btc_config` from Move — every getter is
//             `public(package)` (RECON R7.2). Queue facts arrive attested, and say so.
// @forbidden  `use hashi::` in this file — the Hashi boundary is `carry.move`, not the oracle.
// @forbidden  a Pyth or `sui::clock` dependency — timestamps are parameters, which is what makes
//             every function replayable off-chain against the same inputs.
// @forbidden  bare `+` / `*` on limiter arithmetic — u64 ABORTS on overflow; use the saturating fns.
// @forbidden  `replay_consume` aborting on a rejection — see @invariant 2.
// @invariant  0. oracle is the intra-package LEAF: it references NO other aphotic module and no
//                `&Vault`. It takes primitives only. That is what lets the keeper, a verifier and
//                the chain all run the identical computation.
// @invariant  1. `project_capacity` is PURE, never aborts for ANY u64 input, and matches the
//                Guardian `LocalLimiter` byte-for-byte (G5). ms floor to whole seconds at the
//                boundary: 15_999 ms is 15 s of refill, not 16.
// @invariant  2. `replay_consume` returns a STATUS CODE and NEVER aborts. A verifier replaying
//                the on-chain stream must be able to OBSERVE a rejection; aborting would destroy
//                the whole read for one rejected batch. On any non-OK status the state is
//                returned UNCHANGED.
// @invariant  3. Nothing here reorders, prioritises or assumes queue-jumping. Over-capacity is
//                REJECTED, never queued (G3); there is no priority to buy.
// @invariant  4. `QueueObservation` is ATTESTED, never read. The constructor rejects any snapshot
//                that is not internally consistent (bucket count, sats-vs-count, oldest-age vs
//                the histogram) so a careless or lying attestation fails loudly on-chain.
// @invariant  5. The latency estimate is a DISTRIBUTION. `percentile_ms` returns
//                `unbounded_ms()` — not a large finite number — when the requested quantile falls
//                in the open tail or the bucket is dead. Unbounded is a fact, not a failure.
// @invariant  6. Quantiles round UP (`ceil`): a p95 must COVER 95 % of the mass, never fall one
//                sample short. Under-reporting a tail is the exact error §7.6 forbids.
// @invariant  7. Every arithmetic path saturates. No function in this module can abort on
//                overflow or underflow, for any u64 input.
// @ac         the 7 RECON R9 golden vectors are GREEN, verbatim, in move/tests/oracle_tests.move
// @ac         a rate-limited `replay_consume` returns LIMITER_RATE_LIMIT_EXCEEDED and the caller
//             keeps replaying — asserted, not assumed
// @ac         a dead bucket (refill_rate == 0) makes EVERY quantile unbounded
// @verify     sui move build
// @verify     sui move test oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────

/// An age histogram whose length is not `AGE_BUCKET_COUNT`, or a bucket index out of range.
const EBadAgeHistogram: u64 = 1;
/// An attested queue snapshot that contradicts itself.
const EInconsistentQueue: u64 = 2;
/// A malformed latency histogram: mismatched lengths, a non-increasing edge, or an edge at the
/// unbounded sentinel (the open tail is `tail_weight`, never an edge).
const EBadHistogram: u64 = 3;
/// A latency histogram carrying no mass at all — there is no quantile to report.
const EEmptyDistribution: u64 = 4;
/// A percentile outside [0, 10_000] bps.
const EBadPercentile: u64 = 5;

// ── limiter replay status codes ─────────────────────────────────────────────
// Mirror of the Guardian `LocalLimiter::consume` result (RECON R9). Returned as a code rather
// than an abort because `replay_consume` is a REPLAY primitive: the verifier must be able to
// observe a rejection, not be aborted by it (@invariant 2).
const LIMITER_OK: u8 = 0;
const LIMITER_INVALID_INPUTS: u8 = 1;
const LIMITER_RATE_LIMIT_EXCEEDED: u8 = 2;

// ── arithmetic bounds and units ─────────────────────────────────────────────

const MAX_U64: u64 = 18_446_744_073_709_551_615;
const MS_PER_SECOND: u64 = 1_000;

/// Basis-point denominator. 10_000 bps == 100 %.
const BPS_DENOMINATOR: u64 = 10_000;

/// A carry hurdle over a two-hour wait at a 10 %/yr cost of capital is a fraction of one basis
/// point. Reporting it in whole bps would floor it to zero and silently delete the time value of
/// money from every sizing decision, so the hurdle is denominated in MICRO-basis-points.
const MICRO_BPS_PER_BPS: u64 = 1_000_000;

/// 365 days in ms. The denominator for annualised rates.
const MS_PER_YEAR: u64 = 31_536_000_000;

/// Number of age buckets in a `QueueObservation`. The last one is OPEN.
const AGE_BUCKET_COUNT: u64 = 6;

// ── structs ─────────────────────────────────────────────────────────────────

/// A point on the Guardian token-bucket trajectory, replayed from Hashi's own
/// `WithdrawalRequested` / `WithdrawalPickedForProcessing` / `WithdrawalSigned` stream (G5).
/// Time base is UNIX SECONDS (RECON R9).
public struct LimiterState has copy, drop, store {
    num_tokens_available: u64,
    last_updated_at_s: u64,
    next_seq: u64,
}

/// A KEEPER-ATTESTED snapshot of `WithdrawalRequestQueue.requests`.
///
/// ⚠ This is a CLAIM, not a read. RECON R7.2: every `hashi::withdrawal_queue` getter is
/// `public(package)`, so Move cannot see the queue at all — not through `Hashi`, not through the
/// `BitcoinState` dynamic field, not through any accessor. Pretending otherwise would be the
/// single most dangerous fiction in this repo, so the type is named and documented as attested
/// and the constructor is where a lie has to survive contradiction.
///
/// What makes attestation tolerable HERE and nowhere near custody: the queue object is public, so
/// anyone can falsify a snapshot off-chain in one RPC call, and the worst outcome of a false
/// snapshot is a mis-priced carry — never a moved coin.
public struct QueueObservation has copy, drop, store {
    /// Sui-clock ms at which the snapshot was taken.
    observed_at_ms: u64,
    /// Sats sitting in requests that will be served before ours. Queue position measured in
    /// VALUE, because the limiter is a value bucket, not a request counter.
    ahead_of_us_sats: u64,
    /// Sats across every active request (`Requested` + `Approved`).
    total_pending_sats: u64,
    /// Request counts per age bucket; `age_counts[i]` covers `(upper(i-1), upper(i)]`.
    /// Bucket `AGE_BUCKET_COUNT - 1` is OPEN. This is the age DISTRIBUTION §4.4 asks for —
    /// depth alone hides a queue that is deep because it is stuck.
    age_counts: vector<u64>,
    /// Derived: the sum of `age_counts`. Stored so callers cannot disagree about it.
    pending_count: u64,
    /// Age of the oldest active request, in ms.
    oldest_age_ms: u64,
}

/// A wait-time DISTRIBUTION. Deliberately NOT a point estimate (§7.6).
///
/// `bucket_upper_ms[i]` is the INCLUSIVE upper edge of bucket `i`, strictly increasing and
/// finite. `weights[i]` is the mass in `(bucket_upper_ms[i-1], bucket_upper_ms[i]]`. Mass beyond
/// the last finite edge lives in `tail_weight` and is UNBOUNDED by construction — there is no
/// edge to report for it, and inventing one is exactly how a tail gets under-priced.
///
/// `floor_ms` is the deterministic component: the earliest instant the Guardian bucket could
/// possibly cover us, from the replayed limiter. Every quantile is shifted by it. The histogram
/// supplies the shape (empirical, from `withdrawal_txns` / `confirmed_txns`), the floor supplies
/// the arithmetic that is not a guess.
public struct LatencyDistribution has copy, drop, store {
    bucket_upper_ms: vector<u64>,
    weights: vector<u64>,
    tail_weight: u64,
    total_weight: u64,
    floor_ms: u64,
}

// ── saturating arithmetic (Move u64 add/mul ABORT on overflow — R9 requires saturation) ──

public fun saturating_sub(a: u64, b: u64): u64 {
    if (a > b) a - b else 0
}

public fun saturating_add(a: u64, b: u64): u64 {
    let sum = (a as u128) + (b as u128);
    if (sum > (MAX_U64 as u128)) MAX_U64 else (sum as u64)
}

public fun saturating_mul(a: u64, b: u64): u64 {
    // (2^64-1)^2 < 2^128, so the u128 product can never overflow.
    let product = (a as u128) * (b as u128);
    if (product > (MAX_U64 as u128)) MAX_U64 else (product as u64)
}

fun min_u64(a: u64, b: u64): u64 {
    if (a < b) a else b
}

/// `a * b / c` in u128, CLAMPED to u64 rather than aborting. `c == 0` returns `MAX_U64`, which is
/// the unbounded sentinel — a ratio with no denominator is not zero.
fun mul_div_sat(a: u64, b: u64, c: u64): u64 {
    if (c == 0) return MAX_U64;
    let result = ((a as u128) * (b as u128)) / (c as u128);
    if (result > (MAX_U64 as u128)) MAX_U64 else (result as u64)
}

/// `ceil(a * b / c)`, clamped. Quantiles round UP (@invariant 6): a p95 must COVER 95 % of the
/// mass. `c` is always `BPS_DENOMINATOR` at every call site, hence never zero.
fun ceil_mul_div(a: u64, b: u64, c: u64): u64 {
    if (c == 0) return MAX_U64;
    let numer = (a as u128) * (b as u128);
    let result = (numer + (c as u128) - 1) / (c as u128);
    if (result > (MAX_U64 as u128)) MAX_U64 else (result as u64)
}

/// `ceil(a / b)` in u128, clamped. `b == 0` returns `MAX_U64` — never.
fun ceil_div_sat(a: u64, b: u64): u64 {
    if (b == 0) return MAX_U64;
    let result = ((a as u128) + (b as u128) - 1) / (b as u128);
    if (result > (MAX_U64 as u128)) MAX_U64 else (result as u64)
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — the Guardian limiter, replayed (G5)
// ════════════════════════════════════════════════════════════════════════════

/// Seconds-native core. Byte-for-byte the Guardian `project_capacity` (RECON R9):
///   elapsed  = ts_secs.saturating_sub(last_updated_at)
///   refilled = elapsed.saturating_mul(refill_rate)
///   min(cap, tokens.saturating_add(refilled))
public fun project_capacity_secs(
    tokens_sats: u64,
    last_updated_at_s: u64,
    now_s: u64,
    refill_rate: u64,
    max_capacity: u64,
): u64 {
    let elapsed_s = saturating_sub(now_s, last_updated_at_s);
    let refilled = saturating_mul(elapsed_s, refill_rate);
    min_u64(saturating_add(tokens_sats, refilled), max_capacity)
}

/// Millisecond-boundary wrapper, for callers holding a Sui `Clock` (ms). Elapsed milliseconds
/// FLOOR to whole seconds before refill — RECON R9 golden vector 7: 15_999 ms is 15 s of refill,
/// not 16. The floor is applied to the elapsed SPAN, not to each endpoint independently.
public fun project_capacity(
    tokens_sats: u64,
    last_signed_ms: u64,
    now_ms: u64,
    refill_rate: u64,
    max_capacity: u64,
): u64 {
    let elapsed_s = saturating_sub(now_ms, last_signed_ms) / MS_PER_SECOND;
    project_capacity_secs(tokens_sats, 0, elapsed_s, refill_rate, max_capacity)
}

/// Pure replay of the Guardian `LocalLimiter::consume` (RECON R9). Returns a STATUS CODE and the
/// resulting state; the state is returned UNCHANGED on any non-OK status.
///
/// It never aborts (@invariant 2). A verifier walking Hashi's `WithdrawalSigned` stream must be
/// able to observe a rejection mid-stream and keep going — an abort would throw away the entire
/// replay because one historical batch was rate-limited.
///
/// G3: an over-capacity batch is REJECTED (`LIMITER_RATE_LIMIT_EXCEEDED`), never queued. There is
/// no priority to buy.
public fun replay_consume(
    state: LimiterState,
    seq: u64,
    ts_s: u64,
    amount_sats: u64,
    refill_rate: u64,
    max_capacity: u64,
): (u8, LimiterState) {
    if (seq != state.next_seq) return (LIMITER_INVALID_INPUTS, state);
    if (ts_s < state.last_updated_at_s) return (LIMITER_INVALID_INPUTS, state);

    let capacity = project_capacity_secs(
        state.num_tokens_available,
        state.last_updated_at_s,
        ts_s,
        refill_rate,
        max_capacity,
    );
    if (capacity < amount_sats) return (LIMITER_RATE_LIMIT_EXCEEDED, state);

    // Clamp BEFORE debit (R9).
    (
        LIMITER_OK,
        LimiterState {
            num_tokens_available: capacity - amount_sats,
            last_updated_at_s: ts_s,
            next_seq: state.next_seq + 1,
        },
    )
}

public fun new_limiter_state(
    num_tokens_available: u64,
    last_updated_at_s: u64,
    next_seq: u64,
): LimiterState {
    LimiterState { num_tokens_available, last_updated_at_s, next_seq }
}

/// Genesis per RECON R9: a full bucket at t = 0, seq 0.
public fun genesis_limiter_state(max_capacity: u64): LimiterState {
    LimiterState { num_tokens_available: max_capacity, last_updated_at_s: 0, next_seq: 0 }
}

public fun limiter_tokens(state: &LimiterState): u64 { state.num_tokens_available }

public fun limiter_last_updated_at_s(state: &LimiterState): u64 { state.last_updated_at_s }

public fun limiter_next_seq(state: &LimiterState): u64 { state.next_seq }

public fun limiter_ok(): u8 { LIMITER_OK }

public fun limiter_invalid_inputs(): u8 { LIMITER_INVALID_INPUTS }

public fun limiter_rate_limit_exceeded(): u8 { LIMITER_RATE_LIMIT_EXCEEDED }

// ════════════════════════════════════════════════════════════════════════════
// 2 — the attested queue snapshot (§4.4)
// ════════════════════════════════════════════════════════════════════════════

public fun age_bucket_count(): u64 { AGE_BUCKET_COUNT }

/// Inclusive upper edge of age bucket `i`, in ms. The last bucket is OPEN and reports
/// `unbounded_ms()`.
public fun age_bucket_upper_ms(i: u64): u64 {
    assert!(i < AGE_BUCKET_COUNT, EBadAgeHistogram);
    if (i == 0) { 600_000 } // 10 min — roughly one Hashi batch
    else if (i == 1) { 1_800_000 } // 30 min
    else if (i == 2) { 3_600_000 } // 1 h — the cancellation cooldown (R6)
    else if (i == 3) { 7_200_000 } // 2 h
    else if (i == 4) { 21_600_000 } // 6 h
    else { MAX_U64 } // OPEN: a request this old is stuck, not slow
}

/// The bucket an age of `age_ms` falls in.
public fun age_bucket_index(age_ms: u64): u64 {
    let last = AGE_BUCKET_COUNT - 1;
    let mut i = 0;
    while (i < last) {
        if (age_ms <= age_bucket_upper_ms(i)) return i;
        i = i + 1;
    };
    last
}

/// Build an attested snapshot, rejecting anything self-contradictory (@invariant 4).
///
/// The checks are the whole point: an attestation nobody can contradict is a signature on a lie.
/// These are the contradictions that are cheap to catch on-chain —
///   * the histogram must have exactly `AGE_BUCKET_COUNT` buckets;
///   * we cannot be behind more sats than exist in the queue;
///   * an empty queue holds no sats and a non-empty queue holds some (Hashi's withdrawal minimum
///     is 30_000 sats, so a pending request can never contribute zero);
///   * nothing may be older than the oldest request, so every bucket above the oldest request's
///     own bucket must be empty.
public fun new_queue_observation(
    observed_at_ms: u64,
    ahead_of_us_sats: u64,
    total_pending_sats: u64,
    age_counts: vector<u64>,
    oldest_age_ms: u64,
): QueueObservation {
    assert!(age_counts.length() == AGE_BUCKET_COUNT, EBadAgeHistogram);
    assert!(ahead_of_us_sats <= total_pending_sats, EInconsistentQueue);

    let mut pending_count = 0;
    let mut i = 0;
    while (i < AGE_BUCKET_COUNT) {
        pending_count = saturating_add(pending_count, *age_counts.borrow(i));
        i = i + 1;
    };

    // An empty queue holds no sats, and sats in the queue imply requests holding them.
    assert!((pending_count == 0) == (total_pending_sats == 0), EInconsistentQueue);

    // Nothing can be older than the oldest request.
    if (pending_count > 0) {
        let oldest_bucket = age_bucket_index(oldest_age_ms);
        let mut j = oldest_bucket + 1;
        while (j < AGE_BUCKET_COUNT) {
            assert!(*age_counts.borrow(j) == 0, EInconsistentQueue);
            j = j + 1;
        };
    } else {
        assert!(oldest_age_ms == 0, EInconsistentQueue);
    };

    QueueObservation {
        observed_at_ms,
        ahead_of_us_sats,
        total_pending_sats,
        age_counts,
        pending_count,
        oldest_age_ms,
    }
}

public fun queue_observed_at_ms(q: &QueueObservation): u64 { q.observed_at_ms }

public fun queue_ahead_of_us_sats(q: &QueueObservation): u64 { q.ahead_of_us_sats }

public fun queue_total_pending_sats(q: &QueueObservation): u64 { q.total_pending_sats }

public fun queue_pending_count(q: &QueueObservation): u64 { q.pending_count }

public fun queue_oldest_age_ms(q: &QueueObservation): u64 { q.oldest_age_ms }

public fun queue_age_count_at(q: &QueueObservation, i: u64): u64 {
    assert!(i < AGE_BUCKET_COUNT, EBadAgeHistogram);
    *q.age_counts.borrow(i)
}

/// The `p_bps` quantile of the AGE distribution, in ms — how old the queue actually is, not how
/// deep. Returns `unbounded_ms()` when the quantile lands in the open bucket, and for an empty
/// queue (there is no age to report, and 0 would read as "instant").
public fun queue_age_percentile_ms(q: &QueueObservation, p_bps: u64): u64 {
    assert!(p_bps <= BPS_DENOMINATOR, EBadPercentile);
    if (q.pending_count == 0) return MAX_U64;

    let target = ceil_mul_div(q.pending_count, p_bps, BPS_DENOMINATOR);
    let last = AGE_BUCKET_COUNT - 1;
    let mut cum = 0;
    let mut i = 0;
    while (i < last) {
        cum = saturating_add(cum, *q.age_counts.borrow(i));
        if (cum >= target) return age_bucket_upper_ms(i);
        i = i + 1;
    };
    MAX_U64
}

// ════════════════════════════════════════════════════════════════════════════
// 3 — the wait-time DISTRIBUTION (§7.6)
// ════════════════════════════════════════════════════════════════════════════

/// The unbounded sentinel. A quantile in the open tail has NO upper bound; this is the value that
/// says so. Callers must branch on it rather than treat it as a very long wait.
public fun unbounded_ms(): u64 { MAX_U64 }

public fun new_latency_distribution(
    bucket_upper_ms: vector<u64>,
    weights: vector<u64>,
    tail_weight: u64,
    floor_ms: u64,
): LatencyDistribution {
    let n = bucket_upper_ms.length();
    assert!(n > 0, EBadHistogram);
    assert!(weights.length() == n, EBadHistogram);

    let mut total_weight = tail_weight;
    let mut prev = 0;
    let mut i = 0;
    while (i < n) {
        let upper = *bucket_upper_ms.borrow(i);
        // Strictly increasing, so the first edge is also > 0.
        assert!(upper > prev, EBadHistogram);
        // The open tail is `tail_weight`, never an edge — the sentinel may not be an edge.
        assert!(upper < MAX_U64, EBadHistogram);
        prev = upper;
        total_weight = saturating_add(total_weight, *weights.borrow(i));
        i = i + 1;
    };
    assert!(total_weight > 0, EEmptyDistribution);

    LatencyDistribution { bucket_upper_ms, weights, tail_weight, total_weight, floor_ms }
}

/// The `p_bps` quantile of the wait, in ms, INCLUSIVE of the deterministic floor.
///
/// Rounds UP (@invariant 6): a p95 covers 95 % of the mass, never one sample short. Returns
/// `unbounded_ms()` when the quantile falls in the open tail, or when the floor itself is
/// unbounded (a dead Guardian bucket). §7.6: the tail IS the risk — this function refuses to
/// paper over it with a finite number.
public fun percentile_ms(d: &LatencyDistribution, p_bps: u64): u64 {
    assert!(p_bps <= BPS_DENOMINATOR, EBadPercentile);
    let target = ceil_mul_div(d.total_weight, p_bps, BPS_DENOMINATOR);

    let n = d.bucket_upper_ms.length();
    let mut cum = 0;
    let mut i = 0;
    while (i < n) {
        cum = saturating_add(cum, *d.weights.borrow(i));
        if (cum >= target) return saturating_add(d.floor_ms, *d.bucket_upper_ms.borrow(i));
        i = i + 1;
    };
    MAX_U64
}

/// Whether the `p_bps` quantile has a finite bound at all. The honest question to ask before
/// committing capital against a wait.
public fun is_bounded_at_bps(d: &LatencyDistribution, p_bps: u64): bool {
    percentile_ms(d, p_bps) != MAX_U64
}

/// Fraction of the mass in the OPEN tail, in bps. Sizing against a distribution whose tail mass
/// exceeds the position's tolerance is the failure §7.6 names.
public fun tail_mass_bps(d: &LatencyDistribution): u64 {
    mul_div_sat(d.tail_weight, BPS_DENOMINATOR, d.total_weight)
}

public fun distribution_floor_ms(d: &LatencyDistribution): u64 { d.floor_ms }

public fun distribution_total_weight(d: &LatencyDistribution): u64 { d.total_weight }

public fun distribution_tail_weight(d: &LatencyDistribution): u64 { d.tail_weight }

public fun distribution_bucket_count(d: &LatencyDistribution): u64 {
    d.bucket_upper_ms.length()
}

public fun distribution_bucket_upper_ms_at(d: &LatencyDistribution, i: u64): u64 {
    assert!(i < d.bucket_upper_ms.length(), EBadHistogram);
    *d.bucket_upper_ms.borrow(i)
}

public fun distribution_weight_at(d: &LatencyDistribution, i: u64): u64 {
    assert!(i < d.weights.length(), EBadHistogram);
    *d.weights.borrow(i)
}

// ════════════════════════════════════════════════════════════════════════════
// 4 — composing the limiter and the queue into an estimate
// ════════════════════════════════════════════════════════════════════════════

/// Seconds until the Guardian bucket could cover everything ahead of us PLUS our own size.
///
/// This is a FLOOR, not a prediction: it is the earliest instant the rate limiter stops being the
/// binding constraint. Batching cadence, committee latency, Bitcoin confirmation and
/// reconfiguration pauses can only make the real wait longer, which is precisely why the
/// empirical histogram sits on top of it rather than replacing it.
///
/// `refill_rate == 0` is a dead bucket: it returns `unbounded_ms()`'s numeric twin, and every
/// quantile built on it is unbounded. Rounds UP — a partial second of refill does not clear a
/// deficit.
public fun drain_eta_secs(
    state: &LimiterState,
    refill_rate: u64,
    max_capacity: u64,
    now_s: u64,
    ahead_sats: u64,
    own_sats: u64,
): u64 {
    let needed = saturating_add(ahead_sats, own_sats);
    let available = project_capacity_secs(
        state.num_tokens_available,
        state.last_updated_at_s,
        now_s,
        refill_rate,
        max_capacity,
    );
    if (available >= needed) return 0;

    let deficit = needed - available;
    ceil_div_sat(deficit, refill_rate)
}

/// Push an ETA past an announced reconfiguration pause.
///
/// Hashi pauses withdrawals during reconfiguration, which follows every Sui epoch boundary 📄, and
/// `CommitteeSet.pending_epoch_change` announces it. A wait that would otherwise land inside the
/// window does not land there — it lands at the window's end. `pause_len_ms == 0` (no announced
/// pause) is the identity, and an already-unbounded ETA stays unbounded.
public fun pause_adjusted_eta_ms(
    eta_ms: u64,
    now_ms: u64,
    next_pause_start_ms: u64,
    pause_len_ms: u64,
): u64 {
    if (eta_ms == MAX_U64) return MAX_U64;
    if (pause_len_ms == 0) return eta_ms;

    let arrival_ms = saturating_add(now_ms, eta_ms);
    if (arrival_ms < next_pause_start_ms) return eta_ms;

    let pause_end_ms = saturating_add(next_pause_start_ms, pause_len_ms);
    if (arrival_ms >= pause_end_ms) return eta_ms;

    saturating_sub(pause_end_ms, now_ms)
}

/// The full estimate for OUR request: the empirical shape, shifted by the deterministic,
/// pause-adjusted drain floor implied by the replayed limiter and the attested queue.
///
/// The split is deliberate. The floor is arithmetic anyone can re-derive from the on-chain
/// `WithdrawalSigned` stream (G5). The shape is a calibrated belief. Keeping them in separate
/// fields means a reader can discount the belief without discarding the arithmetic.
public fun project_wait(
    q: &QueueObservation,
    state: &LimiterState,
    refill_rate: u64,
    max_capacity: u64,
    now_s: u64,
    own_sats: u64,
    next_pause_start_ms: u64,
    pause_len_ms: u64,
    empirical_upper_ms: vector<u64>,
    empirical_weights: vector<u64>,
    empirical_tail_weight: u64,
): LatencyDistribution {
    let eta_s = drain_eta_secs(
        state,
        refill_rate,
        max_capacity,
        now_s,
        q.ahead_of_us_sats,
        own_sats,
    );
    let floor_ms = if (eta_s == MAX_U64) MAX_U64 else saturating_mul(eta_s, MS_PER_SECOND);
    let adjusted_floor_ms = pause_adjusted_eta_ms(
        floor_ms,
        q.observed_at_ms,
        next_pause_start_ms,
        pause_len_ms,
    );

    new_latency_distribution(
        empirical_upper_ms,
        empirical_weights,
        empirical_tail_weight,
        adjusted_floor_ms,
    )
}

// ════════════════════════════════════════════════════════════════════════════
// 5 — carry sizing discipline (§7.6)
// ════════════════════════════════════════════════════════════════════════════

/// Time-value hurdle for holding a claim for `wait_ms`, in MICRO-bps.
///
/// There is no overload taking a mean, and there never will be: the caller must pass a `wait_ms`
/// it obtained from `percentile_ms`, so the choice of quantile is explicit and reviewable
/// (§7.6, "Do not size the carry off a point estimate. The tail is the risk.").
///
/// An unbounded wait returns `unbounded_ms()`: no discount clears a hurdle with no horizon.
/// Gas, the Hashi network-fee floor and model error are the caller's to add on top — this is the
/// cost of capital and nothing else.
public fun required_discount_micro_bps(wait_ms: u64, cost_of_capital_bps_per_year: u64): u64 {
    if (wait_ms == MAX_U64) return MAX_U64;
    // u256 so the triple product cannot overflow before the division scales it back down.
    let numer =
        (cost_of_capital_bps_per_year as u256)
            * (wait_ms as u256)
            * (MICRO_BPS_PER_BPS as u256);
    let result = numer / (MS_PER_YEAR as u256);
    if (result > (MAX_U64 as u256)) MAX_U64 else (result as u64)
}

public fun bps_denominator(): u64 { BPS_DENOMINATOR }

public fun micro_bps_per_bps(): u64 { MICRO_BPS_PER_BPS }

public fun ms_per_year(): u64 { MS_PER_YEAR }
