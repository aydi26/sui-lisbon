// Stub-phase lint suppression. The error constants and the event struct below are part of
// the CONTRACT (docs/MOVE-PACKAGE.md §4.5) and are declared for real, but nothing references
// them until the TODO(T4.1) bodies land. DELETE this attribute when the module status becomes DONE.
#[allow(unused_const, unused_field)]
module aphotic::envelope;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.1
// @phase      4
// @status     PARTIAL
// @spec       docs/MOVE-PACKAGE.md#module-envelope (L309-L414)
// @spec       docs/RECON.md#R9-guardian-limiter (L113-L150)
// @spec       docs/BUILD-PLAN.md#T4.1 (L150)
// @rules      G3 G5 G9 G10
// @depends    (none — this module is the intra-package LEAF; see @invariant 0)
// @facts      LIMITER TIME BASE = UNIX **SECONDS**  (RECON R9). refill_rate is sats/second,
// @facts        last_updated_at is seconds. Sui `Clock` is ms ⇒ divide by 1000 at the boundary.
// @facts      project_capacity(cfg, state, ts) = min(cap, tokens + saturating(elapsed_s * refill_rate))
// @facts      consume(seq, ts, amount): seq != next_seq -> InvalidInputs;
// @facts        ts < last_updated_at -> InvalidInputs; capacity < amount -> RateLimitExceeded
// @facts        (REJECTED, never queued — G3); else tokens = capacity - amount (clamp BEFORE debit),
// @facts        last_updated_at = ts, next_seq += 1.
// @facts      genesis LimiterState = { num_tokens_available: max_bucket_capacity, last_updated_at: 0, next_seq: 0 }
// @facts      LIMITER PRIOR (a BOUND, not a fact — U1 unresolved): refill_rate = 1_000 sats/s,
// @facts        max_bucket_capacity = 100_000_000 sats. Never hardcode in logic; pass as EnvelopeParams.
// @facts      Move u64 add/mul ABORT on overflow ⇒ saturation is emulated EXPLICITLY here
// @facts        (`saturating_add` / `saturating_mul` / `saturating_sub`, all widen to u128).
// @facts      NO on-chain queue-depth getter exists (RECON R7.2 — every
// @facts        hashi withdrawal_queue getter is public(package)) ⇒ U3 = NO ⇒ `deployable_sats`
// @facts        takes the STATIC-BUFFER + EVENT-REPLAY fallback UNCONDITIONALLY.
// @external   (none — this module makes NO external calls. `oracle_mid` arrives as a u128
//             PARAMETER; there is no Pyth Move dependency, RECON R3.)
// @implements public fun project_capacity(tokens_sats: u64, last_signed_ms: u64, now_ms: u64,
//                 refill_rate: u64, max_capacity: u64): u64                       [DONE]
//             public fun project_capacity_secs(tokens_sats: u64, last_updated_at_s: u64,
//                 now_s: u64, refill_rate: u64, max_capacity: u64): u64            [DONE]
//             public fun replay_consume(state: LimiterState, seq: u64, ts_s: u64,
//                 amount_sats: u64, refill_rate: u64, max_capacity: u64): (u8, LimiterState) [DONE]
//             public fun saturating_add/sub/mul(a: u64, b: u64): u64               [DONE]
//             public fun deployable_sats(idle_sats: u64, nav_sats: u64,
//                 earmarked_pending_exit_sats: u64, pending_exit_demand_sats: u64,
//                 projected_capacity_sats: u64, params: &EnvelopeParams): u64      [TODO(T4.1)]
//             public fun check_action(vault_id: ID, paused: bool, idle_sats: u64, nav_sats: u64,
//                 earmarked_pending_exit_sats: u64, pending_exit_demand_sats: u64,
//                 projected_capacity_sats: u64, params: &mut EnvelopeParams,
//                 action_notional_sats: u64, book_mid: u128, oracle_mid: u128,
//                 clock: &Clock)                                                   [TODO(T4.1)]
//             public fun new_envelope_params(max_slippage_bps: u64,
//                 max_notional_per_epoch_sats: u64, min_cooldown_ms: u64, buffer_ratio_bps: u64,
//                 limiter_refill_rate: u64, limiter_max_capacity: u64,
//                 epoch_start_ms: u64): EnvelopeParams                             [TODO(T4.1)]
//             public fun assert_strategy_available(/* walrus blob object ref */)   [TODO(T4.1), OPTIONAL]
// @events     EnvelopeChecked { vault_id: ID, action_notional_sats: u64, deployable_sats: u64,
//                 projected_capacity_sats: u64, book_mid: u128 }
// @errors     EPaused · ECooldown · EOracleDivergence · EBufferBreach · ENotionalCap · ESlippage
//             · EBlobUnavailable
// @forbidden  ANY reordering / prioritisation / queue-jumping of exits — G3, review gate
// @forbidden  reading the Hashi shared object for queue depth — the getters are public(package)
//             (RECON R7.2). The buffer is the response, not a priority lever.
// @forbidden  a Pyth Move dependency — `oracle_mid` is a parameter (RECON R3), gates.ps1 deps
// @forbidden  `hashi` module paths in this file — G7, gates.ps1 g7
// @forbidden  bare `+`/`*` on limiter arithmetic — u64 ABORTS on overflow; use the saturating fns
// @invariant  0. envelope is the intra-package LEAF: it references NO other aphotic module.
//                ERRATA vs docs/MOVE-PACKAGE.md §1.3, which draws `envelope --uses--> vault`
//                while §3.1 gives `Vault.envelope: EnvelopeParams`. That is a CYCLE and Move
//                forbids cyclic module dependencies. Resolution: envelope takes PRIMITIVES
//                (idle_sats, nav_sats, paused, ...) instead of `&Vault`, and vault embeds
//                EnvelopeParams. Dependency order is envelope <- vault <- {gateway, router, journal}.
// @invariant  1. project_capacity is PURE and matches the guardian LocalLimiter and the keeper
//                mock `keeper/src/hashi/limiter.ts` byte-for-byte (G5).
// @invariant  2. deployable_sats <= idle_sats always (saturating; never underflows).
// @invariant  3. Nothing here reorders, prioritises or assumes queue-jumping (G3).
// @invariant  4. check_action is the ONLY place epoch notional advances; exactly once per action.
// @invariant  5. Valuation inputs are DeepBook-mid derived; the oracle is used ONLY for the
//                divergence breaker (G9).
// @invariant  6. `earmarked_pending_exit_sats` (the vault's pooled sub-minimum exits, which
//                remain inside `idle_btc`) is subtracted BEFORE the buffer — those sats are
//                already spoken for. See aphotic::vault @invariant 3.
// @ac         docs/MOVE-PACKAGE.md §8 envelope_tests checklist (L638-L644)
// @ac         the 7 RECON R9 golden vectors are GREEN in move/tests/envelope_tests.move
// @verify     sui move build
// @verify     sui move test envelope
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §4.5) ─────────────────────────────
const EPaused: u64 = 1;
const ECooldown: u64 = 2;
const EOracleDivergence: u64 = 3;
const EBufferBreach: u64 = 4;
const ENotionalCap: u64 = 5;
const ESlippage: u64 = 6;
const EBlobUnavailable: u64 = 7;

// ── limiter replay status codes ─────────────────────────────────────────────
// Mirror of the guardian `LocalLimiter::consume` result (RECON R9). Returned as a
// code rather than an abort because `replay_consume` is a REPLAY primitive: the
// verifier must be able to observe a rejection, not be aborted by it.
const LIMITER_OK: u8 = 0;
const LIMITER_INVALID_INPUTS: u8 = 1;
const LIMITER_RATE_LIMIT_EXCEEDED: u8 = 2;

// ── arithmetic bounds ───────────────────────────────────────────────────────
const MAX_U64: u64 = 18_446_744_073_709_551_615;
const MS_PER_SECOND: u64 = 1_000;

// ── structs ─────────────────────────────────────────────────────────────────

/// Constraint envelope, embedded by value in the Vault (see aphotic::vault).
public struct EnvelopeParams has store, copy, drop {
    max_slippage_bps: u64,
    max_notional_per_epoch_sats: u64,
    min_cooldown_ms: u64,
    /// Static redemption-buffer floor. Unconditional fallback: there is no on-chain
    /// queue-depth getter (RECON R7.2 / U3 = NO).
    buffer_ratio_bps: u64,
    // ── limiter genesis anchors: the ONLY trust anchors (G5), both observationally boundable ──
    /// sats per SECOND (RECON R9 time base).
    limiter_refill_rate: u64,
    /// bucket capacity in sats.
    limiter_max_capacity: u64,
    // ── epoch accounting ──
    epoch_start_ms: u64,
    epoch_notional_used_sats: u64,
    last_action_ms: u64,
}

/// A point on the guardian token-bucket trajectory, replayed from Hashi's own
/// `WithdrawalRequested` / `WithdrawalPickedForProcessing` / `WithdrawalSigned` stream (G5).
/// Time base is UNIX SECONDS (RECON R9).
public struct LimiterState has copy, drop, store {
    num_tokens_available: u64,
    last_updated_at_s: u64,
    next_seq: u64,
}

// ── events (docs/MOVE-PACKAGE.md §4.5) ──────────────────────────────────────

public struct EnvelopeChecked has copy, drop {
    vault_id: ID,
    action_notional_sats: u64,
    deployable_sats: u64,
    projected_capacity_sats: u64,
    book_mid: u128,
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

// ── trustless limiter replay (G5) ───────────────────────────────────────────

/// Seconds-native core. Byte-for-byte the guardian `project_capacity` (RECON R9):
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

/// Millisecond-boundary wrapper matching docs/MOVE-PACKAGE.md §4.3's signature, for callers
/// holding a Sui `Clock` (ms). Elapsed milliseconds FLOOR to whole seconds before refill —
/// RECON R9 golden vector 7: 15_999 ms is 15 s of refill, not 16.
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

/// Pure replay of the guardian `LocalLimiter::consume` (RECON R9). Returns a status code and
/// the resulting state; the state is returned UNCHANGED on any non-OK status.
///
/// G3: an over-capacity batch is REJECTED (`LIMITER_RATE_LIMIT_EXCEEDED`), it is never queued.
/// There is no priority to buy.
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

// ── EnvelopeParams constructor ──────────────────────────────────────────────
// LANDED WITH T1.1 (not T4.1) out of hard necessity: `EnvelopeParams` fields are
// module-private, so `aphotic::vault::create_vault(..., envelope: EnvelopeParams, ...)` and
// every one of its tests are UNCALLABLE until this constructor exists. The T4.1 accessors,
// `deployable_sats` and `check_action` are untouched and still open below.

/// Fresh params. Epoch accounting starts empty: `epoch_notional_used_sats = 0`,
/// `last_action_ms = 0` (no action yet, so the first `check_action` never sees a cooldown).
public fun new_envelope_params(
    max_slippage_bps: u64,
    max_notional_per_epoch_sats: u64,
    min_cooldown_ms: u64,
    buffer_ratio_bps: u64,
    limiter_refill_rate: u64,
    limiter_max_capacity: u64,
    epoch_start_ms: u64,
): EnvelopeParams {
    EnvelopeParams {
        max_slippage_bps,
        max_notional_per_epoch_sats,
        min_cooldown_ms,
        buffer_ratio_bps,
        limiter_refill_rate,
        limiter_max_capacity,
        epoch_start_ms,
        epoch_notional_used_sats: 0,
        last_action_ms: 0,
    }
}

// ── LimiterState constructors / accessors ───────────────────────────────────

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

// ── still to implement ──────────────────────────────────────────────────────
// TODO(T4.1): EnvelopeParams accessors. (`new_envelope_params` already landed above — it was a
//             hard prerequisite of vault::create_vault; do NOT add a second copy.)
// TODO(T4.1): deployable_sats — buffer = max(mul_div(nav, buffer_ratio_bps, 10_000),
//             saturating_sub(pending_exit_demand_sats, projected_capacity_sats));
//             deployable = saturating_sub(saturating_sub(idle_sats, earmarked_pending_exit_sats), buffer).
// TODO(T4.1): check_action — abort order EPaused, ECooldown, EOracleDivergence, EBufferBreach,
//             ENotionalCap, ESlippage; then advance epoch_notional_used_sats + last_action_ms
//             EXACTLY ONCE and emit EnvelopeChecked.
// TODO(T4.1): assert_strategy_available (OPTIONAL — day-one fallback is to enforce Walrus blob
//             availability off-chain in keeper/src/storage/; abort EBlobUnavailable if wired).
