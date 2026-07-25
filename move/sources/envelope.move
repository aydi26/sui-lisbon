module aphotic::envelope;

use sui::clock::Clock;
use sui::event;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.1
// @phase      4
// @status     DONE
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
// @facts      BPS_DENOMINATOR = 10_000.
// @facts      DEFAULT_MAX_ORACLE_DIVERGENCE_BPS = 200  (keeper/.env.example ORACLE_DIVERGENCE_BPS,
// @facts        keeper/src/config.ts oracleDivergenceBps). OWNER-set, never keeper-set — see
// @facts        @invariant 7.
// @facts      DEFAULT_EPOCH_LEN_MS = 86_400_000 (24 h) — the rolling window the per-epoch
// @facts        notional cap is measured over. 0 disables rolling (a single open-ended epoch).
// @facts      ⚠ UNITS: `action_notional_sats` is SATS OF BASE the action puts at risk, i.e. the
// @facts        order QUANTITY — NOT `price * quantity` as docs/MOVE-PACKAGE.md §5.1 writes.
// @facts        A DeepBook FLOAT_SCALING price times a base quantity is in `quote * 1e9` units
// @facts        and can never be compared against `deployable_sats`, which is sats. A bid
// @facts        deploys quote to acquire exactly `quantity` base sats, so the same number is
// @facts        the correct sats-denominated notional on BOTH sides of the book.
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
//                 projected_capacity_sats: u64, params: &EnvelopeParams): u64      [DONE]
//             public fun check_action(vault_id: ID, paused: bool, idle_sats: u64, nav_sats: u64,
//                 earmarked_pending_exit_sats: u64, pending_exit_demand_sats: u64,
//                 projected_capacity_sats: u64, params: &mut EnvelopeParams,
//                 action_notional_sats: u64, action_price: u128, book_mid: u128,
//                 oracle_mid: u128, clock: &Clock)                                 [DONE]
//             public fun new_envelope_params(max_slippage_bps: u64,
//                 max_notional_per_epoch_sats: u64, min_cooldown_ms: u64, buffer_ratio_bps: u64,
//                 limiter_refill_rate: u64, limiter_max_capacity: u64,
//                 epoch_start_ms: u64): EnvelopeParams                             [DONE]
//             public fun assert_strategy_available(blob_id: &vector<u8>,
//                 attested_available: bool)                                        [DONE]
//             public fun divergence_bps(book_mid: u128, oracle_mid: u128): u64     [DONE]
//             public fun slippage_bps(action_price: u128, book_mid: u128): u64     [DONE]
//             public fun buffer_sats(nav_sats: u64, pending_exit_demand_sats: u64,
//                 projected_capacity_sats: u64, params: &EnvelopeParams): u64      [DONE]
//             public fun max_slippage_bps / max_notional_per_epoch_sats / min_cooldown_ms /
//                 buffer_ratio_bps / limiter_refill_rate / limiter_max_capacity /
//                 epoch_start_ms / epoch_notional_used_sats / last_action_ms /
//                 max_divergence_bps / epoch_len_ms  (&EnvelopeParams -> u64)      [DONE]
//             public fun set_max_divergence_bps / set_epoch_len_ms
//                 (&mut EnvelopeParams, u64)                                       [DONE]
//             public fun bps_denominator / default_max_divergence_bps /
//                 default_epoch_len_ms (): u64                                     [DONE]
//             ⚠ DELTAS vs the skeleton banner + docs/MOVE-PACKAGE.md §4.4, deliberate,
//               each forced by a hole in the original signature:
//               (a) `action_price: u128` was ADDED to check_action. §4.4 orders `ESlippage`
//                   sixth as `slippage(action, book_mid) <= max_slippage_bps`, and slippage is
//                   NOT computable from `action_notional_sats` alone — without the action's own
//                   price, ESlippage is dead code. `action_price == 0` means "this action has no
//                   price leg" (e.g. a cancel) and skips ONLY the slippage bound.
//               (b) `max_divergence_bps` and `epoch_len_ms` were ADDED as EnvelopeParams FIELDS,
//                   not as check_action parameters. §4.4 requires a divergence threshold and an
//                   epoch boundary; neither existed anywhere. They are fields so they are
//                   OWNER-set (vault::set_envelope needs a VaultCap) — a keeper-supplied
//                   threshold could be widened to u64::MAX by a compromised keeper, which would
//                   delete the G9 breaker. `new_envelope_params` KEEPS its 7-argument shape and
//                   defaults them, so every existing caller still compiles.
//               (c) `deployable_sats` / `check_action` take PRIMITIVES, not `&Vault` — see
//                   @invariant 0 (the module is the intra-package leaf; Move forbids the cycle).
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

/// Basis-point denominator. 10_000 bps == 100 %.
const BPS_DENOMINATOR: u64 = 10_000;

/// Default oracle-vs-book divergence breaker (G9), in bps. Mirrors
/// `keeper/.env.example ORACLE_DIVERGENCE_BPS` / `keeper/src/config.ts oracleDivergenceBps`.
/// OWNER-set only — see the banner delta (b).
const DEFAULT_MAX_ORACLE_DIVERGENCE_BPS: u64 = 200;

/// Default rolling window the per-epoch notional cap is measured over: 24 h in ms.
/// `0` disables rolling entirely (one open-ended epoch).
const DEFAULT_EPOCH_LEN_MS: u64 = 86_400_000;

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
    // ── added at T4.1 (banner delta (b)): OWNER-set breaker thresholds ──
    /// G9 oracle-vs-book divergence breaker, in bps. A FIELD, never a `check_action`
    /// parameter: a keeper-supplied threshold could be widened to `u64::MAX`, which would
    /// delete the breaker outright.
    max_divergence_bps: u64,
    /// Rolling window for the per-epoch notional cap, in ms. `0` = never roll.
    epoch_len_ms: u64,
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

fun max_u64(a: u64, b: u64): u64 {
    if (a > b) a else b
}

/// `a * b / c` in u128, CLAMPED to u64 rather than aborting. Every use below is a bound or a
/// buffer: saturating at `u64::MAX` keeps `check_action` fail-CLOSED (an unrepresentable
/// divergence must trip the breaker, not abort with an arithmetic error the caller cannot read).
/// `c == 0` returns `MAX_U64` for the same reason — see `divergence_bps` / `slippage_bps`.
fun mul_div_sat(a: u64, b: u64, c: u64): u64 {
    if (c == 0) return MAX_U64;
    let result = ((a as u128) * (b as u128)) / (c as u128);
    if (result > (MAX_U64 as u128)) MAX_U64 else (result as u64)
}

/// u128 twin of `mul_div_sat`, for the price-scaled bps helpers (`book_mid`/`oracle_mid`/
/// `action_price` are u128 DeepBook FLOAT_SCALING prices, not sats).
fun mul_div_sat_u128(a: u128, b: u64, c: u128): u64 {
    if (c == 0) return MAX_U64;
    let result = (a * (b as u128)) / c;
    if (result > (MAX_U64 as u128)) MAX_U64 else (result as u64)
}

fun abs_diff_u128(a: u128, b: u128): u128 {
    if (a > b) a - b else b - a
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
///
/// The two T4.1 fields default to `DEFAULT_MAX_ORACLE_DIVERGENCE_BPS` / `DEFAULT_EPOCH_LEN_MS`
/// so this constructor KEEPS its 7-argument shape and every existing caller still compiles
/// (banner delta (b)). Change them with `set_max_divergence_bps` / `set_epoch_len_ms`, both of
/// which are only reachable through an owner-held `VaultCap` (`vault::set_envelope`).
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
        max_divergence_bps: DEFAULT_MAX_ORACLE_DIVERGENCE_BPS,
        epoch_len_ms: DEFAULT_EPOCH_LEN_MS,
    }
}

// ── EnvelopeParams accessors (T4.1) ─────────────────────────────────────────

public fun max_slippage_bps(p: &EnvelopeParams): u64 { p.max_slippage_bps }

public fun max_notional_per_epoch_sats(p: &EnvelopeParams): u64 { p.max_notional_per_epoch_sats }

public fun min_cooldown_ms(p: &EnvelopeParams): u64 { p.min_cooldown_ms }

public fun buffer_ratio_bps(p: &EnvelopeParams): u64 { p.buffer_ratio_bps }

public fun limiter_refill_rate(p: &EnvelopeParams): u64 { p.limiter_refill_rate }

public fun limiter_max_capacity(p: &EnvelopeParams): u64 { p.limiter_max_capacity }

public fun epoch_start_ms(p: &EnvelopeParams): u64 { p.epoch_start_ms }

public fun epoch_notional_used_sats(p: &EnvelopeParams): u64 { p.epoch_notional_used_sats }

public fun last_action_ms(p: &EnvelopeParams): u64 { p.last_action_ms }

public fun max_divergence_bps(p: &EnvelopeParams): u64 { p.max_divergence_bps }

public fun epoch_len_ms(p: &EnvelopeParams): u64 { p.epoch_len_ms }

/// OWNER-only in practice: the only `&mut EnvelopeParams` a keeper can obtain is the one
/// `vault::envelope_params_mut` hands to `check_action`, and `check_action` never widens a
/// threshold. Rewriting the whole struct goes through `vault::set_envelope(&VaultCap, ..)`.
public fun set_max_divergence_bps(p: &mut EnvelopeParams, bps: u64) {
    p.max_divergence_bps = bps;
}

public fun set_epoch_len_ms(p: &mut EnvelopeParams, len_ms: u64) { p.epoch_len_ms = len_ms; }

public fun bps_denominator(): u64 { BPS_DENOMINATOR }

public fun default_max_divergence_bps(): u64 { DEFAULT_MAX_ORACLE_DIVERGENCE_BPS }

public fun default_epoch_len_ms(): u64 { DEFAULT_EPOCH_LEN_MS }

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

// ── the redemption buffer (G3) ──────────────────────────────────────────────
//
// TRADE-OFF, stated plainly (E-M4 / RECON R7.2): there is NO on-chain queue-depth getter — all
// 46 `hashi::withdrawal_queue` accessors are `public(package)`. So the buffer is
//
//     max( STATIC floor set by the OWNER at vault creation ,
//          DYNAMIC term derived from KEEPER-ATTESTED limiter readings )
//
// and the `max` is the whole safety argument: the static floor is owner-set and a keeper cannot
// reach it, so the WORST a fully compromised keeper can do by lying about
// `pending_exit_demand_sats` / `projected_capacity_sats` is relax the buffer DOWN TO the
// owner's floor. It can never go below it, and it can never be widened into a priority lever —
// there is no priority to buy (G3). The attested numbers are additionally replayable off-chain:
// `keeper/src/verify/` re-derives the very same limiter trajectory from Hashi's own
// `WithdrawalRequested/PickedForProcessing/Signed` stream via `project_capacity` (G5).

/// The buffer itself, in sats. Exposed so the app/keeper can show WHY a size was refused.
///
/// `buffer = max( nav * buffer_ratio_bps / 10_000 , saturating_sub(demand, capacity) )`
///
/// G3 rationale: if the bridge can only clear `projected_capacity_sats` of exits, the vault must
/// hold the UNSERVICEABLE remainder idle. The buffer IS the response to congestion; reordering or
/// jumping the global queue is not available and is never modelled here.
public fun buffer_sats(
    nav_sats: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    params: &EnvelopeParams,
): u64 {
    let static_floor = mul_div_sat(nav_sats, params.buffer_ratio_bps, BPS_DENOMINATOR);
    let unserviceable = saturating_sub(pending_exit_demand_sats, projected_capacity_sats);
    max_u64(static_floor, unserviceable)
}

/// Max sats the keeper may deploy (move onto the book / spend) right now.
///
/// `earmarked_pending_exit_sats` is subtracted FIRST (@invariant 6 / `vault` @invariant 3): the
/// pooled sub-minimum exits physically sit inside `idle_btc` but their shares are already burned,
/// so they were never the vault's to deploy.
///
/// Saturating throughout ⇒ `deployable_sats <= idle_sats` always, and it never underflows
/// (@invariant 2).
public fun deployable_sats(
    idle_sats: u64,
    nav_sats: u64,
    earmarked_pending_exit_sats: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    params: &EnvelopeParams,
): u64 {
    let spendable = saturating_sub(idle_sats, earmarked_pending_exit_sats);
    let buffer = buffer_sats(nav_sats, pending_exit_demand_sats, projected_capacity_sats, params);
    saturating_sub(spendable, buffer)
}

// ── the two bps breakers ────────────────────────────────────────────────────

/// |book_mid - oracle_mid| / oracle_mid, in bps (G9 depeg / stale-oracle breaker).
///
/// FAIL-CLOSED: a zero `oracle_mid` (no reading, or a stale feed the keeper zeroed) or a zero
/// `book_mid` (empty book — the current testnet state, E-M7) returns `u64::MAX`, so
/// `check_action` aborts `EOracleDivergence` rather than silently trading with no price
/// discipline. The oracle is the DENOMINATOR because it is the reference; hBTC's book price is
/// the quantity under suspicion.
public fun divergence_bps(book_mid: u128, oracle_mid: u128): u64 {
    if (book_mid == 0) return MAX_U64;
    mul_div_sat_u128(abs_diff_u128(book_mid, oracle_mid), BPS_DENOMINATOR, oracle_mid)
}

/// |action_price - book_mid| / book_mid, in bps.
///
/// FAIL-CLOSED on `book_mid == 0` for the same reason as `divergence_bps`. NAV and every bound
/// in this module are DeepBook-mid derived; the oracle is used ONLY by the breaker above (G9,
/// @invariant 5).
public fun slippage_bps(action_price: u128, book_mid: u128): u64 {
    mul_div_sat_u128(abs_diff_u128(action_price, book_mid), BPS_DENOMINATOR, book_mid)
}

// ── Walrus strategy availability ────────────────────────────────────────────

/// Gate on the in-force strategy blob still being retrievable.
///
/// E-M11: an ON-CHAIN Walrus `Blob` read is deliberately NOT wired. A blob written through the
/// public testnet publisher comes back `certifiedEpoch: null, deletable: true`, so a predicate
/// demanding "certified AND non-deletable" would reject our own writes at the moment we make
/// them. The day-one position (docs/MOVE-PACKAGE.md §1.2) is therefore: availability is measured
/// OFF-CHAIN by `keeper/src/storage/`, and its verdict is threaded in here as
/// `attested_available`. An empty blob id is never available.
///
/// This costs nothing in liveness: the vault also holds an in-object ciphertext copy, so Walrus
/// expiry degrades VERIFIABILITY, not liveness.
public fun assert_strategy_available(blob_id: &vector<u8>, attested_available: bool) {
    assert!(!blob_id.is_empty(), EBlobUnavailable);
    assert!(attested_available, EBlobUnavailable);
}

// ── the full pre-action gate ────────────────────────────────────────────────

/// Roll the rolling notional window forward to the period containing `now_ms`, zeroing the
/// used-notional counter. `epoch_len_ms == 0` disables rolling (a single open-ended epoch).
fun roll_epoch(params: &mut EnvelopeParams, now_ms: u64) {
    if (params.epoch_len_ms == 0) return;
    let elapsed = saturating_sub(now_ms, params.epoch_start_ms);
    if (elapsed < params.epoch_len_ms) return;
    let periods = elapsed / params.epoch_len_ms;
    params.epoch_start_ms =
        saturating_add(params.epoch_start_ms, saturating_mul(periods, params.epoch_len_ms));
    params.epoch_notional_used_sats = 0;
}

/// THE pre-action gate. `router` (and any future keeper-gated mutator) calls this before touching
/// the book. Aborts on the first violation, in this exact order
/// (docs/MOVE-PACKAGE.md §4.4, and the file's own TODO of record):
///
///   1. `!paused`                                            -> EPaused
///   2. `now - last_action_ms >= min_cooldown_ms`             -> ECooldown
///   3. `divergence(book_mid, oracle_mid) <= max_divergence`  -> EOracleDivergence  (G9)
///   4. `action_notional_sats <= deployable_sats(..)`         -> EBufferBreach      (G3)
///   5. `epoch_used + action <= max_notional_per_epoch`       -> ENotionalCap
///   6. `slippage(action_price, book_mid) <= max_slippage`    -> ESlippage
///
/// On success — and ONLY here (@invariant 4) — `epoch_notional_used_sats` advances by
/// `action_notional_sats` and `last_action_ms` becomes `now`, exactly once, and
/// `EnvelopeChecked` is emitted.
///
/// `action_notional_sats` is SATS OF BASE the action puts at risk (for both sides of the book:
/// a bid deploys quote to acquire exactly that many base sats). It is deliberately NOT
/// `price * quantity` — a DeepBook FLOAT_SCALING price times a base quantity is in
/// `quote * 1e9` units and could never be compared with `deployable_sats`, which is sats.
///
/// `action_price == 0` means "this action has no price leg" and skips ONLY check 6
/// (banner delta (a)).
///
/// `last_action_ms == 0` means "no action yet" and skips ONLY check 2, so a freshly created
/// vault is not cooled down against a zero timestamp.
public fun check_action(
    vault_id: ID,
    paused: bool,
    idle_sats: u64,
    nav_sats: u64,
    earmarked_pending_exit_sats: u64,
    pending_exit_demand_sats: u64,
    projected_capacity_sats: u64,
    params: &mut EnvelopeParams,
    action_notional_sats: u64,
    action_price: u128,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
) {
    let now_ms = clock.timestamp_ms();

    // 1 — owner pause.
    assert!(!paused, EPaused);

    // 2 — rebalance cooldown.
    if (params.last_action_ms != 0) {
        assert!(
            saturating_sub(now_ms, params.last_action_ms) >= params.min_cooldown_ms,
            ECooldown,
        );
    };

    // 3 — G9 oracle-vs-book divergence breaker. The oracle NEVER prices anything here; it only
    //     vetoes. Valuation is DeepBook-mid derived throughout (@invariant 5).
    assert!(divergence_bps(book_mid, oracle_mid) <= params.max_divergence_bps, EOracleDivergence);

    // 4 — G3 redemption buffer.
    let deployable = deployable_sats(
        idle_sats,
        nav_sats,
        earmarked_pending_exit_sats,
        pending_exit_demand_sats,
        projected_capacity_sats,
        params,
    );
    assert!(action_notional_sats <= deployable, EBufferBreach);

    // 5 — rolling per-epoch notional cap. Roll BEFORE the comparison so an action landing in a
    //     new window is measured against a fresh budget.
    roll_epoch(params, now_ms);
    assert!(
        saturating_add(params.epoch_notional_used_sats, action_notional_sats)
            <= params.max_notional_per_epoch_sats,
        ENotionalCap,
    );

    // 6 — per-action slippage bound vs the book mid.
    if (action_price != 0) {
        assert!(slippage_bps(action_price, book_mid) <= params.max_slippage_bps, ESlippage);
    };

    // Commit — exactly once (@invariant 4).
    params.epoch_notional_used_sats =
        saturating_add(params.epoch_notional_used_sats, action_notional_sats);
    params.last_action_ms = now_ms;

    event::emit(EnvelopeChecked {
        vault_id,
        action_notional_sats,
        deployable_sats: deployable,
        projected_capacity_sats,
        book_mid,
    });
}

// ── test-only event readers ─────────────────────────────────────────────────
// Event struct fields are module-private; these let move/tests/envelope_tests.move assert on the
// emitted receipt. They compile out of the published package.

#[test_only]
public fun envelope_checked_fields(e: &EnvelopeChecked): (ID, u64, u64, u64, u128) {
    (
        e.vault_id,
        e.action_notional_sats,
        e.deployable_sats,
        e.projected_capacity_sats,
        e.book_mid,
    )
}
