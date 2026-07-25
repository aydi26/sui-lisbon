#[test_only]
module aphotic::mock_hashi;

use sui::balance::Balance;
use sui::clock::Clock;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.6
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#hashi-isolation-g7 (L112-L116)
// @spec       docs/RECON.md#R7-hashi-move-surface (L76-L100)
// @rules      G1 G2 G3 G7
// @depends    (none — deliberately standalone so it can stand in for the real package)
// @facts      ⚠ WHY THIS FILE EXISTS: Move has NO dependency injection. `sui move test` cannot
// @facts        exercise `aphotic::gateway::exit_to_bitcoin` against the REAL bridge package
// @facts        (it needs the live shared object + a committee). This module replicates the two
// @facts        composable entrypoints and their asserts EXACTLY so gateway logic can be tested
// @facts        in isolation. VERIFIED 2026-07-25 (T1.6): the escalation to an interface SHIM
// @facts        package is NOT needed and NOT possible either — `hashi::config::create()`,
// @facts        `committee_set::create()`, `versioning::create()`, `treasury::create()` and
// @facts        `proposals::create()` are all public(package), so even the upstream
// @facts        `#[test_only] public fun hashi::hashi::create_for_testing` cannot be given
// @facts        arguments from `aphotic`. gateway.move instead keeps every branch/guard/state
// @facts        transition in generic public(package) staging functions, which
// @facts        move/tests/gateway_tests.move drives FOR REAL against this mock.
// @facts      ⚠ This file lives in move/tests/, NOT move/sources/, precisely so the G7 grep gate
// @facts        over sources/ keeps returning gateway.move only.
// @facts      MIN_WITHDRAWAL_SATS = 30_000            (live config, RECON R6)
// @facts      CANCELLATION_COOLDOWN_MS = 3_600_000    (1 h, RECON R6)
// @facts      ADDR lengths {20 P2WPKH, 32 P2TR}       (RECON R7 verbatim assert)
// @external   Replicated verbatim (RECON R7.1/R7.3):
//             public fun hashi::withdraw::request_withdrawal(
//                 hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                 bitcoin_address: vector<u8>, ctx: &mut TxContext)
//             public fun hashi::withdraw::cancel_withdrawal(
//                 hashi: &mut Hashi, request_id: address, clock: &Clock,
//                 ctx: &mut TxContext): Balance<BTC>
// @implements public fun new_mock<T>(ctx: &mut TxContext): MockHashi<T>          [DONE]
//             public fun request_withdrawal<T>(...)                              [DONE]
//             public fun cancel_withdrawal<T>(...): Balance<T>                   [DONE]
//             public fun mark_processing<T>(...)                                 [DONE]
//             public fun set_paused<T>(...)                                      [DONE]
//             public fun request_count / last_request_id / request_amount_sats /
//                 request_bitcoin_address / request_sender                       [DONE]
//             public fun destroy_mock<T>(m: MockHashi<T>)                        [DONE]
// @errors     EBelowMinimumWithdrawal · EInvalidBitcoinAddress · EUnauthorizedCancellation
//             · ECooldownNotElapsed · ECannotCancelProcessingWithdrawal · EPaused
//             · ERequestNotFound   (mock-local codes; the REAL package uses #[error] byte-string
//             constants, so abort codes are NOT comparable — assert on behaviour, not codes)
// @forbidden  giving this mock any behaviour the real package does not have — it exists to
//             reproduce upstream asserts, not to be convenient
// @invariant  1. request_withdrawal asserts amount >= 30_000 and addr_len in {20, 32}.
// @invariant  2. cancel_withdrawal is SENDER-BOUND: request.sender == ctx.sender() (RECON R7.3).
// @invariant  3. cancel_withdrawal rejects a processing (post-commit) request.
// @invariant  4. cancel_withdrawal enforces the 1 h cooldown from created_ms.
// @invariant  5. The mock NEVER reorders requests or grants priority (G3).
// @ac         docs/MOVE-PACKAGE.md §8 gateway_tests checklist (L652-L659)
// @verify     sui move test
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── mock-local error codes ──────────────────────────────────────────────────
const EBelowMinimumWithdrawal: u64 = 1;
const EInvalidBitcoinAddress: u64 = 2;
const EUnauthorizedCancellation: u64 = 3;
const ECooldownNotElapsed: u64 = 4;
const ECannotCancelProcessingWithdrawal: u64 = 5;
const EPaused: u64 = 6;
const ERequestNotFound: u64 = 7;

// ── live testnet config (RECON R6) ──────────────────────────────────────────
const MIN_WITHDRAWAL_SATS: u64 = 30_000;
const CANCELLATION_COOLDOWN_MS: u64 = 3_600_000;
const ADDR_LEN_P2WPKH: u64 = 20;
const ADDR_LEN_P2TR: u64 = 32;

// ── structs ─────────────────────────────────────────────────────────────────

public struct MockRequest<phantom T> has store {
    request_id: address,
    sender: address,
    bitcoin_address: vector<u8>,
    created_ms: u64,
    /// Set once the (mock) committee commits the request into a withdrawal transaction.
    /// Post-commit requests can no longer be cancelled.
    processing: bool,
    btc: Balance<T>,
}

/// Stands in for the `Hashi` shared object. No abilities: a test creates it, threads it by
/// reference and destroys it explicitly, so a leaked mock is a compile error.
public struct MockHashi<phantom T> {
    withdrawal_min_sats: u64,
    cancellation_cooldown_ms: u64,
    paused: bool,
    last_request_id: address,
    requests: vector<MockRequest<T>>,
}

// ── construction / teardown ─────────────────────────────────────────────────

public fun new_mock<T>(ctx: &mut TxContext): MockHashi<T> {
    let _ = ctx;
    MockHashi {
        withdrawal_min_sats: MIN_WITHDRAWAL_SATS,
        cancellation_cooldown_ms: CANCELLATION_COOLDOWN_MS,
        paused: false,
        last_request_id: @0x0,
        requests: vector[],
    }
}

/// Burns any still-escrowed balances and consumes the mock.
public fun destroy_mock<T>(mock: MockHashi<T>) {
    let MockHashi {
        withdrawal_min_sats: _,
        cancellation_cooldown_ms: _,
        paused: _,
        last_request_id: _,
        mut requests,
    } = mock;
    while (!requests.is_empty()) {
        let MockRequest {
            request_id: _,
            sender: _,
            bitcoin_address: _,
            created_ms: _,
            processing: _,
            btc,
        } = requests.pop_back();
        let _ = btc.destroy_for_testing();
    };
    requests.destroy_empty();
}

// ── replicated upstream entrypoints ─────────────────────────────────────────

/// Mirror of `hashi::withdraw::request_withdrawal`. Consumes the `Balance<T>` and escrows it.
public fun request_withdrawal<T>(
    mock: &mut MockHashi<T>,
    clock: &Clock,
    btc: Balance<T>,
    bitcoin_address: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(!mock.paused, EPaused);
    assert!(btc.value() >= mock.withdrawal_min_sats, EBelowMinimumWithdrawal);
    let addr_len = bitcoin_address.length();
    assert!(addr_len == ADDR_LEN_P2WPKH || addr_len == ADDR_LEN_P2TR, EInvalidBitcoinAddress);

    let request_id = ctx.fresh_object_address();
    mock.last_request_id = request_id;
    mock
        .requests
        .push_back(MockRequest {
            request_id,
            sender: ctx.sender(),
            bitcoin_address,
            created_ms: clock.timestamp_ms(),
            processing: false,
            btc,
        });
}

/// Mirror of `hashi::withdraw::cancel_withdrawal`. SENDER-BOUND (RECON R7.3): only the original
/// requester can cancel, which is exactly why `gateway::reclaim_stalled_exit` is
/// depositor-callable only and the keeper can never call it.
public fun cancel_withdrawal<T>(
    mock: &mut MockHashi<T>,
    request_id: address,
    clock: &Clock,
    ctx: &mut TxContext,
): Balance<T> {
    let index = index_of(mock, request_id);
    let request = mock.requests.borrow(index);

    assert!(!request.processing, ECannotCancelProcessingWithdrawal);
    assert!(request.sender == ctx.sender(), EUnauthorizedCancellation);
    assert!(
        clock.timestamp_ms() >= request.created_ms + mock.cancellation_cooldown_ms,
        ECooldownNotElapsed,
    );

    let MockRequest {
        request_id: _,
        sender: _,
        bitcoin_address: _,
        created_ms: _,
        processing: _,
        btc,
    } = mock.requests.remove(index);
    btc
}

// ── test-side controls & views ──────────────────────────────────────────────

/// Simulate the committee committing the request (post-commit ⇒ no longer cancellable).
public fun mark_processing<T>(mock: &mut MockHashi<T>, request_id: address) {
    let index = index_of(mock, request_id);
    mock.requests.borrow_mut(index).processing = true;
}

public fun set_paused<T>(mock: &mut MockHashi<T>, paused: bool) {
    mock.paused = paused;
}

public fun request_count<T>(mock: &MockHashi<T>): u64 { mock.requests.length() }

public fun last_request_id<T>(mock: &MockHashi<T>): address { mock.last_request_id }

public fun request_amount_sats<T>(mock: &MockHashi<T>, request_id: address): u64 {
    mock.requests.borrow(index_of(mock, request_id)).btc.value()
}

public fun request_bitcoin_address<T>(mock: &MockHashi<T>, request_id: address): vector<u8> {
    mock.requests.borrow(index_of(mock, request_id)).bitcoin_address
}

public fun request_sender<T>(mock: &MockHashi<T>, request_id: address): address {
    mock.requests.borrow(index_of(mock, request_id)).sender
}

fun index_of<T>(mock: &MockHashi<T>, request_id: address): u64 {
    let mut i = 0;
    let n = mock.requests.length();
    while (i < n) {
        if (mock.requests.borrow(i).request_id == request_id) return i;
        i = i + 1;
    };
    abort ERequestNotFound
}
