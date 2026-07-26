module aphotic::carry;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P2.carry   (aphotic.md §11 "Phase 2 — carry")
// @phase      2  [DELIBERATELY NOT EXECUTED IN v2 — see @status and WHY below]
// @status     PARTIAL — INTERFACE ONLY, BY DESIGN. The three pure predicates that guard the leg
//             (value-preservation floor, pinned-address equality, carry hurdle) are REAL and
//             tested. There is deliberately NO execution path: nothing in this module touches
//             DeepBook, Hashi, a `Balance<BTC>`, or any shared object.
//
//             WHY THE EXECUTION PATH IS ABSENT — three independent reasons, each sufficient:
//               1. aphotic.md §11 says so verbatim: "For a hackathon, Phase 1 plus a mocked
//                  Phase 3 demonstrates the idea in a weekend. Do not attempt Phase 2 in that
//                  window — the multisig and the latency model are where the time goes."
//               2. RECON R10: the `Pool<hBTC,DBUSDC>` order book is EMPTY ON BOTH SIDES, testnet
//                  volume is zero, and `pool::mid_price` aborts `EEmptyOrderbook`. The entry leg
//                  buys hBTC below par — there is nothing to buy and no observable price to buy
//                  it at. A carry wired against a book with no mid is not an implementation, it
//                  is an untested branch.
//               3. aphotic.md §3 / §6.3 (settled, do not relitigate): `request_withdrawal` sets
//                  `sender: ctx.sender()`, which on Sui is the TRANSACTION SIGNER, never the
//                  calling module. The exit leg therefore cannot be composed from a shared
//                  object at all; it requires the 2-of-2 custody multisig to sign. The boundary
//                  is enforced AT SIGNING, not by Move, and no amount of Move code changes that.
// @spec       aphotic.md#7.6-the-carry (entry via DeepBook, exit via the Hashi queue)
// @spec       aphotic.md#10-invariants "Carry" — the two invariants this module owns
// @spec       aphotic.md#11-build-sequence "Phase 2 — carry" (do not attempt in the window)
// @spec       aphotic.md#3-rejected-designs (a shared object can never hold a queue position)
// @spec       aphotic-governance.md#4.2 "Carry floor" · #4.3 "The one boundary Move cannot enforce"
// @spec       docs/RECON.md#R10-deepbook-venue-reality (book empty both sides)
// @spec       docs/RECON.md#R7-hashi-move-surface (request_withdrawal / cancel_withdrawal)
// @rules      G7 (no id hardcoded) · G10 (sats u64 · E<Reason> · events on state transitions)
// @depends    (none — leaf. Deliberately imports no aphotic module, no `hashi::`, no `deepbook::`.)
// @facts      MONEY UNIT = satoshis, u64.
// @facts      BPS_DENOMINATOR = 10_000. "Par" is 10_000 bps: 1 hBTC == 1 BTC (aphotic.md §7.7,
// @facts        "All legs at par; carry P&L accrues through the entry discount").
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 (RECON R6, live config read 2026-07-25).
// @facts        `hashi::btc_config::bitcoin_withdrawal_minimum()` is `public(package)` (RECON
// @facts        R7.1) ⇒ NOT CALLABLE from our package. The value is injected as a parameter to
// @facts        `new_carry_params`, never read from the bridge and never hardcoded in logic.
// @facts      EXIT ADDRESS LENGTH ∈ {20 (P2WPKH), 32 (P2TR)} — asserted upstream by
// @facts        `request_withdrawal` (RECON R7); asserted here too so a bad pin is rejected at
// @facts        configuration time rather than at the first exit.
// @facts      WITHDRAWAL_CANCELLATION_COOLDOWN_MS = 3_600_000 (RECON R6) — relevant only to the
// @facts        Phase-2 reclaim path, which does not exist here.
// @external   NOT CALLED BY THIS MODULE — recorded so the Phase-2 implementer does not re-derive:
//               public fun hashi::withdraw::request_withdrawal(
//                   hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                   bitcoin_address: vector<u8>, ctx: &mut TxContext)
//               public fun hashi::withdraw::cancel_withdrawal(
//                   hashi: &mut Hashi, request_id: address, clock: &Clock,
//                   ctx: &mut TxContext): Balance<BTC>
//               ⚠⚠ `cancel_withdrawal` asserts `request.sender == ctx.sender()` — sender-bound.
//               ⚠⚠ neither can be called by a shared object; both need the custody multisig.
// @implements public fun new_carry_params(hurdle_bps: u64, max_notional_sats: u64,
//                 min_exit_sats: u64, pinned_btc_address: vector<u8>): CarryParams      [DONE]
//             public fun hurdle_bps / max_notional_sats / min_exit_sats /
//                 pinned_btc_address (&CarryParams)                                     [DONE]
//             public fun assert_value_preserved(consumed_sats: u64,
//                 returned_hbtc_equivalent_sats: u64)                                   [DONE]
//             public fun is_value_preserved(u64, u64): bool                             [DONE]
//             public fun assert_pinned_address(&CarryParams, &vector<u8>)               [DONE]
//             public fun is_pinned_address(&CarryParams, &vector<u8>): bool             [DONE]
//             public fun discount_bps(price_bps_of_par: u64): u64                       [DONE]
//             public fun hurdle_met(&CarryParams, price_bps_of_par: u64): bool          [DONE]
//             public fun assert_hurdle_met(&CarryParams, price_bps_of_par: u64)         [DONE]
//             public fun expected_carry_sats(notional_sats: u64, discount_bps: u64): u64 [DONE]
//             public fun assert_exit_submittable(&CarryParams, sats: u64)               [DONE]
//             public fun assert_within_notional_cap(&CarryParams, sats: u64)            [DONE]
//             ── DEFERRED to Phase 2, intentionally absent (NOT stubs, NOT throwing bodies) ──
//             DEFERRED  public fun place_carry_bid(...)   entry leg, DeepBook POST_ONLY
//             DEFERRED  public fun open_carry_exit(...)   exit leg, custody multisig signer
//             DEFERRED  public fun settle_carry(...)      realised-P&L booking
// @events     (NONE — and that is not an omission. G10 requires an event per externally-visible
//             STATE TRANSITION; this module holds no state and performs none. `CarryParams` is a
//             `copy, drop, store` value embedded by its owner, which emits on its own mutation.)
// @errors     ECarryValueLoss · EUnpinnedExitAddress · EInvalidExitAddressLength ·
//             EHurdleNotMet · EBelowWithdrawalMinimum · ENotionalCapExceeded · EInvalidPrice
// @forbidden  `use hashi::` / `use deepbook::` in this file — the execution path does not exist,
//             and a dependency without a call site is how a "not implemented" module quietly
//             becomes half-implemented.
// @forbidden  a `bitcoin_address` PARAMETER on any future exit function. The destination is read
//             from the pinned `CarryParams`, never supplied by the caller — aphotic.md §10:
//             "`request_withdrawal` is never called with a `bitcoin_address` other than the
//             pinned one."
// @forbidden  claiming anywhere that the carry is live. It is not. It is an interface.
// @invariant  1. VALUE-PRESERVATION FLOOR (aphotic.md §10 "Carry"): the leg reverts if it would
//                return less hBTC-equivalent than it consumed. `assert_value_preserved` is that
//                floor; `returned == consumed` is preserved (break-even), `returned < consumed`
//                aborts. Every future execution path MUST close through it.
// @invariant  2. PINNED DESTINATION (aphotic.md §10 "Carry"): the only Bitcoin address the exit
//                leg may ever target is `CarryParams.pinned_btc_address`, fixed at construction
//                and never taken as a call parameter.
// @invariant  3. `new_carry_params` rejects any pin whose length is not 20 or 32 bytes, so an
//                unspendable pin cannot be configured (upstream would abort at exit time).
// @invariant  4. Nothing in this module reads, writes or references any shared object; it is a
//                pure value + predicate module and cannot move a satoshi.
// @invariant  5. `hurdle_met` is monotone in the discount: a deeper discount never turns a met
//                hurdle into an unmet one.
// @ac         move/tests/allocate_tests.move § "carry.move — the Phase-2 interface" — the floor,
//             the pin and the hurdle each have named tests, including the break-even boundary.
// @verify     sui move build
// @verify     sui move test allocate_tests
//             ⚠ the `sui move test` filter is POSITIONAL and matches the FULLY-QUALIFIED test
//               name. `sui move test carry` matches only the 4 tests whose own names contain
//               "carry"; `allocate_tests` runs the whole module — allocate AND carry — which is
//               where every guard in this file is exercised.
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const ECarryValueLoss: u64 = 1;
const EUnpinnedExitAddress: u64 = 2;
const EInvalidExitAddressLength: u64 = 3;
const EHurdleNotMet: u64 = 4;
const EBelowWithdrawalMinimum: u64 = 5;
const ENotionalCapExceeded: u64 = 6;
const EInvalidPrice: u64 = 7;

// ── constants ───────────────────────────────────────────────────────────────

/// 10_000 bps == 100 % == par. hBTC is valued 1:1 against BTC (aphotic.md §7.7).
const BPS_DENOMINATOR: u64 = 10_000;

/// Valid Bitcoin exit-address byte lengths, asserted by `hashi::withdraw::request_withdrawal`
/// (RECON R7) and re-asserted here at configuration time.
const P2WPKH_ADDR_LEN: u64 = 20;
const P2TR_ADDR_LEN: u64 = 32;

// ── structs ─────────────────────────────────────────────────────────────────

/// The carry leg's configuration. A `store` value, embedded by the vault; this module owns no
/// object and no state of its own (@invariant 4).
public struct CarryParams has copy, drop, store {
    /// Minimum discount from par, in bps, at which the entry leg is allowed to bid. Set from the
    /// latency model: expected latency x cost of capital + gas + a margin for model error
    /// (aphotic.md §7.6).
    hurdle_bps: u64,
    /// Ceiling on the sats a single carry may put at risk.
    max_notional_sats: u64,
    /// Hashi's `bitcoin_withdrawal_minimum`, INJECTED (the upstream accessor is
    /// `public(package)`; RECON R7.1). 30_000 sats on testnet as of RECON R6.
    min_exit_sats: u64,
    /// The one Bitcoin address the exit leg may ever target. Fixed here, never a call parameter
    /// (@invariant 2). Published so redemptions are auditable on Bitcoin (aphotic.md §6.3).
    pinned_btc_address: vector<u8>,
}

// ── construction ────────────────────────────────────────────────────────────

public fun new_carry_params(
    hurdle_bps: u64,
    max_notional_sats: u64,
    min_exit_sats: u64,
    pinned_btc_address: vector<u8>,
): CarryParams {
    let len = pinned_btc_address.length();
    assert!(len == P2WPKH_ADDR_LEN || len == P2TR_ADDR_LEN, EInvalidExitAddressLength);
    CarryParams { hurdle_bps, max_notional_sats, min_exit_sats, pinned_btc_address }
}

// ── invariant 1: the value-preservation floor ───────────────────────────────

/// aphotic.md §10 "Carry": *the carry leg reverts if it would return less hBTC-equivalent than
/// it consumed.* Break-even (`returned == consumed`) is preserved; strictly less aborts.
///
/// Every Phase-2 execution path must close through this function. It is deliberately a free
/// function over two `u64`s rather than a method on a position object, so it can be applied to
/// the entry leg, the exit leg, and the round trip without a type to thread.
public fun assert_value_preserved(consumed_sats: u64, returned_hbtc_equivalent_sats: u64) {
    assert!(returned_hbtc_equivalent_sats >= consumed_sats, ECarryValueLoss);
}

public fun is_value_preserved(consumed_sats: u64, returned_hbtc_equivalent_sats: u64): bool {
    returned_hbtc_equivalent_sats >= consumed_sats
}

// ── invariant 2: the pinned destination ─────────────────────────────────────

/// aphotic.md §10 "Carry": *`request_withdrawal` is never called with a `bitcoin_address` other
/// than the pinned one.* Move cannot enforce this at the bridge (the call needs a real signer —
/// §6.3), so the pin is asserted on our side of the boundary AND at signing by the 2-of-2
/// custody co-signer. Stating that plainly is part of the design, not a caveat on it.
public fun assert_pinned_address(params: &CarryParams, candidate: &vector<u8>) {
    assert!(params.pinned_btc_address == *candidate, EUnpinnedExitAddress);
}

public fun is_pinned_address(params: &CarryParams, candidate: &vector<u8>): bool {
    params.pinned_btc_address == *candidate
}

// ── the hurdle ──────────────────────────────────────────────────────────────

/// Discount from par, in bps, given a price expressed in bps of par (10_000 == par).
/// A price at or above par has no discount and returns 0 — never a negative wrap.
public fun discount_bps(price_bps_of_par: u64): u64 {
    assert!(price_bps_of_par > 0, EInvalidPrice);
    if (price_bps_of_par >= BPS_DENOMINATOR) 0 else BPS_DENOMINATOR - price_bps_of_par
}

public fun hurdle_met(params: &CarryParams, price_bps_of_par: u64): bool {
    discount_bps(price_bps_of_par) >= params.hurdle_bps
}

public fun assert_hurdle_met(params: &CarryParams, price_bps_of_par: u64) {
    assert!(hurdle_met(params, price_bps_of_par), EHurdleNotMet);
}

/// Gross sats the spread is worth on `notional_sats` of base, before gas and before the latency
/// cost the hurdle is meant to cover. u128 intermediate: `notional * bps` overflows u64 above
/// ~1.8e15 sats at 10_000 bps.
public fun expected_carry_sats(notional_sats: u64, discount_bps: u64): u64 {
    (((notional_sats as u128) * (discount_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64
}

// ── submission bounds ───────────────────────────────────────────────────────

/// The bridge rejects a withdrawal below `bitcoin_withdrawal_minimum` (RECON R7:
/// `EBelowMinimumWithdrawal`). Checked on our side so the failure is readable here rather than
/// as an opaque upstream abort code.
public fun assert_exit_submittable(params: &CarryParams, sats: u64) {
    assert!(sats >= params.min_exit_sats, EBelowWithdrawalMinimum);
}

public fun assert_within_notional_cap(params: &CarryParams, sats: u64) {
    assert!(sats <= params.max_notional_sats, ENotionalCapExceeded);
}

// ── reads ───────────────────────────────────────────────────────────────────

public fun hurdle_bps(params: &CarryParams): u64 {
    params.hurdle_bps
}

public fun max_notional_sats(params: &CarryParams): u64 {
    params.max_notional_sats
}

public fun min_exit_sats(params: &CarryParams): u64 {
    params.min_exit_sats
}

public fun pinned_btc_address(params: &CarryParams): vector<u8> {
    params.pinned_btc_address
}

public fun bps_denominator(): u64 {
    BPS_DENOMINATOR
}
