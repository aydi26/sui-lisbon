#[test_only]
module aphotic::gateway_tests;

use aphotic::envelope;
use aphotic::gateway;
use aphotic::mock_hashi::{Self, MockHashi};
use aphotic::vault::{Self, Vault};
use sui::balance;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.6
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L652-L659)
// @spec       docs/BUILD-PLAN.md#T1.6 (L83)
// @rules      G1 G2 G3 G7
// @depends    aphotic::gateway (T1.3, T1.4) · aphotic::vault (T1.1) · aphotic::mock_hashi
// @facts      Drive the composed exit against aphotic::mock_hashi, NOT the real package —
// @facts        Move has no dependency injection and the real package needs the live shared
// @facts        object plus a committee. Verified this session: `hashi::config::create()`,
// @facts        `hashi::committee_set::create()`, `hashi::versioning::create()`,
// @facts        `hashi::treasury::create()` and `hashi::proposals::create()` are ALL
// @facts        public(package), so even `hashi::hashi::create_for_testing` (which is
// @facts        `#[test_only] public`) cannot be supplied with arguments from `aphotic`.
// @facts        A real `Hashi` therefore cannot exist inside `sui move test`.
// @facts      ⇒ gateway.move puts EVERY branch/guard/state transition in generic
// @facts        `public(package)` staging functions (`stage_exit`, `stage_flush`,
// @facts        `settle_reclaim`) which these tests exercise FOR REAL. The residual
// @facts        bridge wrappers are 2-4 line tails whose exact shape is reproduced by the
// @facts        `compose_exit` / `compose_flush` / `compose_reclaim` helpers below.
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · DUST_FLOOR_SATS = 546
// @facts      EXIT_ADDR_LEN in {20, 32}
// @facts      CANCELLATION_COOLDOWN_MS = 3_600_000 (mock mirrors the live config, RECON R6)
// @facts      BOOK_MID = 1e12 is a DeepBook v3 FLOAT_SCALING price (quote = base*price/1e9).
// @facts        With no quote inventory, NAV == free idle sats, so 1 share == 1 sat and every
// @facts        expected value below is exact rather than rounded.
// @facts      ⚠ This is the ONLY test file that exercises the bridge surface (mirrors the G7
// @facts        grep gate V3). It lives in move/tests/, not move/sources/, so the gate over
// @facts        sources/ still returns gateway.move only.
// @implements #[test] fun exit_address_lengths_20_and_32_accepted()            [DONE]
//             #[test] fun exit_address_length_21_rejected()                    [DONE]
//             #[test] fun exit_address_empty_rejected()                        [DONE]
//             #[test] fun hashi_minimum_boundary()                             [DONE]
//             #[test] fun injected_bridge_config_matches_live_testnet()        [DONE]
//             #[test] fun register_exit_address_accepts_20_and_32_bytes()      [DONE]
//             #[test] fun register_exit_address_rejects_19_bytes()             [DONE]
//             #[test] fun register_exit_address_rejects_33_bytes()             [DONE]
//             #[test] fun register_exit_address_is_write_once()                [DONE]
//             #[test] fun exit_uses_pinned_address_not_a_parameter()           [DONE]
//             #[test] fun exit_at_or_above_minimum_requests_withdrawal()       [DONE]
//             #[test] fun exit_below_minimum_is_pooled_never_submitted()       [DONE]
//             #[test] fun exit_without_a_pinned_address_aborts()               [DONE]
//             #[test] fun exit_by_a_non_depositor_aborts()                     [DONE]
//             #[test] fun flush_pending_exit_aborts_below_minimum()            [DONE]
//             #[test] fun flush_pending_exit_submits_once_the_pool_clears()    [DONE]
//             #[test] fun flush_by_a_non_sender_aborts()                       [DONE]
//             #[test] fun reclaim_recredits_exactly()                          [DONE]
//             #[test] fun reclaim_by_a_non_depositor_aborts()                  [DONE]
//             #[test] fun reclaim_for_another_depositor_aborts()               [DONE]
//             #[test] fun reclaim_surfaces_upstream_unauthorized_abort()       [DONE]
//             #[test] fun reclaim_surfaces_upstream_post_commit_abort()        [DONE]
//             #[test] fun reclaim_surfaces_upstream_cooldown_abort()           [DONE]
//             #[test] fun take_pending_as_hbtc_returns_the_pool()              [DONE]
//             #[test] fun every_sui_side_leg_completes_in_one_ptb()            [DONE]
// @invariant  1. No gateway function accepts a bitcoin_address parameter — a redirect test is
//                IMPOSSIBLE TO WRITE, and that impossibility IS the G2 guarantee. Assert it
//                structurally (the signature has no such parameter) plus by checking the
//                address the mock received equals the pinned one.
// @invariant  2. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @ac         docs/MOVE-PACKAGE.md §8 gateway_tests checklist (L652-L659)
// @verify     sui move test gateway
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── local coin witnesses ────────────────────────────────────────────────────
// The staging functions are generic, so the tests instantiate them with local witnesses and
// never need the bridge's coin type. `gateway::exit_to_bitcoin` is the concrete instantiation.
public struct TESTBTC has drop {}
public struct TESTUSDC has drop {}

const OWNER: address = @0x0A;
const KEEPER: address = @0x0B;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
const MALLORY: address = @0x3D;

const BM_ADDR: address = @0xBEEF;
const POOL_ADDR: address = @0xF00D;

/// DeepBook mid at BTC ~ $100_000 (FLOAT_SCALING 1e9). No quote inventory is ever staged here,
/// so NAV == free idle sats and 1 share == 1 sat throughout.
const BOOK_MID: u128 = 1_000_000_000_000;

/// The bridge's cancellation cooldown, mirrored by mock_hashi (RECON R6).
const COOLDOWN_MS: u64 = 3_600_000;

/// 20 bytes — a P2WPKH witness program.
const ADDR_P2WPKH: vector<u8> = x"0102030405060708090a0b0c0d0e0f1011121314";
/// 32 bytes — a P2TR witness program, deliberately unmistakable in an assertion failure.
const ADDR_P2TR: vector<u8> = x"c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
/// A second, DIFFERENT 20-byte program: the address Bob pinned. If any code path let a caller
/// choose the destination, Alice's exit could carry these bytes. It never can.
const ADDR_BOB: vector<u8> = x"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
/// 19 bytes — one short of P2WPKH.
const ADDR_19: vector<u8> = x"0102030405060708090a0b0c0d0e0f10111213";
/// 33 bytes — one past P2TR.
const ADDR_33: vector<u8> =
    x"c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00ff";

// ── helpers ─────────────────────────────────────────────────────────────────

/// A witness-program of `len` zero bytes.
fun program(len: u64): vector<u8> {
    let mut bytes = vector[];
    let mut i = 0;
    while (i < len) {
        bytes.push_back(0u8);
        i = i + 1;
    };
    bytes
}

fun params(): envelope::EnvelopeParams {
    // Live testnet limiter scalars (ULTRACODE-BRIEF E-K2): 115_740 sats/s into a 100 BTC bucket.
    envelope::new_envelope_params(50, 1_000_000_000, 1_000, 1_000, 115_740, 10_000_000_000, 0)
}

fun create(scenario: &mut Scenario, owner: address, keeper: address): ID {
    scenario.next_tx(owner);
    let cap = vault::create_vault<TESTBTC, TESTUSDC>(
        object::id_from_address(BM_ADDR),
        object::id_from_address(POOL_ADDR),
        b"ciphertext-v0",
        b"blob-v0",
        params(),
        keeper,
        scenario.ctx(),
    );
    let vault_id = vault::vault_cap_vault_id(&cap);
    transfer::public_transfer(cap, owner);
    vault_id
}

fun borrow(scenario: &Scenario, vault_id: ID): Vault<TESTBTC, TESTUSDC> {
    ts::take_shared_by_id<Vault<TESTBTC, TESTUSDC>>(scenario, vault_id)
}

/// Deposit `sats` as `who` in its own transaction. Returns the shares minted.
fun deposit(scenario: &mut Scenario, vault_id: ID, who: address, sats: u64): u64 {
    scenario.next_tx(who);
    let mut v = borrow(scenario, vault_id);
    let c = coin::mint_for_testing<TESTBTC>(sats, scenario.ctx());
    let shares = vault::deposit_btc(&mut v, c, BOOK_MID, scenario.ctx());
    ts::return_shared(v);
    shares
}

/// Pin `addr` as `who` in its own transaction, through the real gateway entrypoint.
fun register(scenario: &mut Scenario, vault_id: ID, who: address, addr: vector<u8>) {
    scenario.next_tx(who);
    let mut v = borrow(scenario, vault_id);
    gateway::register_exit_address(&mut v, addr, scenario.ctx());
    ts::return_shared(v);
}

// ── the bridge tails, reproduced verbatim ───────────────────────────────────
// Each helper below is byte-for-byte the body of the matching `gateway` wrapper with
// `aphotic::mock_hashi` substituted for the bridge package. mock_hashi replicates all five
// upstream asserts (RECON R7), so these drive the real staging logic against the real
// preconditions. See the @facts block for why a real `Hashi` cannot be constructed here.

/// Tail of `gateway::exit_to_bitcoin`.
fun compose_exit(
    v: &mut Vault<TESTBTC, TESTUSDC>,
    mock: &mut MockHashi<TESTBTC>,
    who: address,
    shares_to_burn: u64,
    clk: &Clock,
    ctx: &mut TxContext,
) {
    let (btc, addr) = gateway::stage_exit(v, who, shares_to_burn, BOOK_MID, ctx);
    if (btc.is_some()) {
        mock_hashi::request_withdrawal(mock, clk, btc.destroy_some(), addr, ctx);
    } else {
        btc.destroy_none();
    }
}

/// Tail of `gateway::flush_pending_exit`.
fun compose_flush(
    v: &mut Vault<TESTBTC, TESTUSDC>,
    mock: &mut MockHashi<TESTBTC>,
    who: address,
    clk: &Clock,
    ctx: &mut TxContext,
) {
    let (pooled, addr) = gateway::stage_flush(v, who, ctx);
    mock_hashi::request_withdrawal(mock, clk, pooled, addr, ctx);
}

/// Tail of `gateway::reclaim_stalled_exit`. The upstream aborts are NOT caught — Move has no
/// try/catch, which is precisely how G3's "surface them, never swallow them" is enforced.
fun compose_reclaim(
    v: &mut Vault<TESTBTC, TESTUSDC>,
    mock: &mut MockHashi<TESTBTC>,
    request_id: address,
    clk: &Clock,
    ctx: &mut TxContext,
) {
    let who = ctx.sender();
    gateway::assert_reclaim_caller(v, who, ctx);
    let btc_back = mock_hashi::cancel_withdrawal(mock, request_id, clk, ctx);
    gateway::settle_reclaim(v, who, request_id, btc_back, BOOK_MID, ctx);
}

// ── pure guards (unchanged from the skeleton — still the tripwire) ──────────

#[test]
fun exit_address_lengths_20_and_32_accepted() {
    gateway::assert_valid_exit_address(&program(20)); // P2WPKH
    gateway::assert_valid_exit_address(&program(32)); // P2TR
}

#[test]
#[expected_failure(abort_code = gateway::EBadAddressLength)]
fun exit_address_length_21_rejected() {
    gateway::assert_valid_exit_address(&program(21));
}

#[test]
#[expected_failure(abort_code = gateway::EBadAddressLength)]
fun exit_address_empty_rejected() {
    gateway::assert_valid_exit_address(&vector[]);
}

#[test]
fun hashi_minimum_boundary() {
    // G3: below the minimum the bridge would abort, so the exit must be POOLED instead.
    assert!(!gateway::clears_hashi_minimum(0), 0);
    assert!(!gateway::clears_hashi_minimum(29_999), 1);
    assert!(gateway::clears_hashi_minimum(30_000), 2);
    assert!(gateway::clears_hashi_minimum(1_000_000), 3);
}

#[test]
fun injected_bridge_config_matches_live_testnet() {
    // The upstream accessors are public(package) (RECON R7.1), so these values are INJECTED.
    // If the bridge changes them, this test is the tripwire.
    assert!(gateway::hashi_withdrawal_min_sats() == 30_000, 0);
    assert!(gateway::dust_floor_sats() == 546, 1);
}

// ── T1.3: register_exit_address is write-once (G2) ──────────────────────────

#[test]
fun register_exit_address_accepts_20_and_32_bytes() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    register(&mut scenario, vault_id, ALICE, ADDR_P2TR); // 32 bytes, P2TR
    register(&mut scenario, vault_id, BOB, ADDR_P2WPKH); // 20 bytes, P2WPKH

    scenario.next_tx(ALICE);
    let v = borrow(&scenario, vault_id);
    // The exact bytes land in the vault record and read back through gateway's own accessor.
    assert!(gateway::pinned_exit_address(&v, ALICE) == ADDR_P2TR, 0);
    assert!(gateway::pinned_exit_address(&v, ALICE).length() == 32, 1);
    assert!(gateway::pinned_exit_address(&v, BOB) == ADDR_P2WPKH, 2);
    assert!(gateway::pinned_exit_address(&v, BOB).length() == 20, 3);
    // Independent read of the underlying record agrees byte-for-byte.
    assert!(vault::btc_exit_address(&v, ALICE) == ADDR_P2TR, 4);
    assert!(vault::btc_exit_address(&v, BOB) == ADDR_P2WPKH, 5);
    // A pin needs no prior deposit; the depositor record is created on demand.
    assert!(vault::shares_of(&v, ALICE) == 0, 6);
    ts::return_shared(v);

    scenario.end();
}

#[test]
fun register_exit_address_emits_the_registration_event() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    gateway::register_exit_address(&mut v, ADDR_P2TR, scenario.ctx());

    let evs = event::events_by_type<gateway::ExitAddressRegistered>();
    assert!(evs.length() == 1, 0);
    let (ev_vault, ev_who, ev_len) = gateway::exit_address_registered_fields(evs.borrow(0));
    assert!(ev_vault == vault_id, 1);
    assert!(ev_who == ALICE, 2);
    // Only the LENGTH is emitted — the bytes are already public in the vault record.
    assert!(ev_len == 32, 3);

    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::EBadAddressLength)]
fun register_exit_address_rejects_19_bytes() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    register(&mut scenario, vault_id, ALICE, ADDR_19);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::EBadAddressLength)]
fun register_exit_address_rejects_33_bytes() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    register(&mut scenario, vault_id, ALICE, ADDR_33);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::EExitAddressAlreadySet)]
fun register_exit_address_is_write_once() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);
    // The redirect attempt. There is no other mutator anywhere in the package, and this one
    // refuses — that is the whole anti-redirect guarantee (G2).
    register(&mut scenario, vault_id, ALICE, ADDR_BOB);
    scenario.end();
}

// ── T1.3: the composed exit ─────────────────────────────────────────────────

#[test]
fun exit_at_or_above_minimum_requests_withdrawal() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());

    assert!(mock_hashi::request_count(&mock) == 0, 0);
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());

    // The bridge was called exactly once.
    assert!(mock_hashi::request_count(&mock) == 1, 1);
    let rid = mock_hashi::last_request_id(&mock);
    assert!(mock_hashi::request_amount_sats(&mock, rid) == 100_000, 2);
    // The EXACT pinned bytes reached the bridge.
    assert!(mock_hashi::request_bitcoin_address(&mock, rid) == ADDR_P2TR, 3);
    // ...and the request's sender is the depositor, which is what makes reclaim reachable.
    assert!(mock_hashi::request_sender(&mock, rid) == ALICE, 4);

    // Vault side: shares burned, sats gone, nothing pooled.
    assert!(vault::shares_of(&v, ALICE) == 900_000, 5);
    assert!(vault::total_shares(&v) == 900_000, 6);
    assert!(vault::idle_btc_value(&v) == 900_000, 7);
    assert!(vault::total_pending_exit_sats(&v) == 0, 8);

    // ExitRequested carries the right fields, and no ExitPooled was emitted.
    let requested = event::events_by_type<gateway::ExitRequested>();
    assert!(requested.length() == 1, 9);
    let (ev_vault, ev_who, ev_amount, ev_len) = gateway::exit_requested_fields(requested.borrow(0));
    assert!(ev_vault == vault_id, 10);
    assert!(ev_who == ALICE, 11);
    assert!(ev_amount == 100_000, 12);
    assert!(ev_len == 32, 13);
    assert!(event::events_by_type<gateway::ExitPooled>().length() == 0, 14);

    // The boundary itself: EXACTLY 30_000 sats still submits (G3 mirror of the upstream `>=`).
    compose_exit(&mut v, &mut mock, ALICE, 30_000, &clk, scenario.ctx());
    assert!(mock_hashi::request_count(&mock) == 2, 15);
    let rid2 = mock_hashi::last_request_id(&mock);
    assert!(mock_hashi::request_amount_sats(&mock, rid2) == 30_000, 16);
    assert!(mock_hashi::request_bitcoin_address(&mock, rid2) == ADDR_P2TR, 17);
    assert!(vault::idle_btc_value(&v) == 870_000, 18);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun exit_below_minimum_is_pooled_never_submitted() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());

    // 29_999 sats — one sat under the bridge minimum.
    compose_exit(&mut v, &mut mock, ALICE, 29_999, &clk, scenario.ctx());

    // G3: the bridge was NEVER called. It would have aborted EBelowMinimumWithdrawal.
    assert!(mock_hashi::request_count(&mock) == 0, 0);
    assert!(mock_hashi::last_request_id(&mock) == @0x0, 1);

    // The sats are an EARMARK on idle: shares are burned, the coins stay inside idle_btc.
    assert!(vault::pending_exit_sats(&v, ALICE) == 29_999, 2);
    assert!(vault::total_pending_exit_sats(&v) == 29_999, 3);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 4);
    assert!(vault::free_btc_sats(&v) == 970_001, 5);
    assert!(vault::shares_of(&v, ALICE) == 970_001, 6);
    assert!(vault::total_shares(&v) == 970_001, 7);
    // The earmark is excluded from NAV, so every share that stayed is still worth one sat.
    assert!(vault::nav_sats(&v, BOOK_MID) == 970_001, 8);

    // ExitPooled carries the right fields; no ExitRequested was emitted.
    let pooled = event::events_by_type<gateway::ExitPooled>();
    assert!(pooled.length() == 1, 9);
    let (ev_vault, ev_who, ev_amount, ev_total) = gateway::exit_pooled_fields(pooled.borrow(0));
    assert!(ev_vault == vault_id, 10);
    assert!(ev_who == ALICE, 11);
    assert!(ev_amount == 29_999, 12);
    assert!(ev_total == 29_999, 13);
    assert!(event::events_by_type<gateway::ExitRequested>().length() == 0, 14);

    // Pooling again accumulates and STILL submits nothing.
    compose_exit(&mut v, &mut mock, ALICE, 1_000, &clk, scenario.ctx());
    assert!(mock_hashi::request_count(&mock) == 0, 15);
    assert!(vault::pending_exit_sats(&v, ALICE) == 30_999, 16);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun exit_uses_pinned_address_not_a_parameter() {
    // ── G2, structurally ──────────────────────────────────────────────────────────────────
    // There is NO bitcoin-address parameter to pass. `gateway::stage_exit(vault, who, shares,
    // book_mid, ctx)` and `gateway::exit_to_bitcoin(vault, hashi, shares, book_mid, clock,
    // ctx)` have five and six parameters respectively and NONE of them is an address; the sole
    // producer of the address argument in the whole package is
    // `gateway::pinned_exit_address(vault, who)`, whose only inputs are the vault and the
    // depositor. Uncommenting either line below is a COMPILE ERROR, which is the guarantee:
    //
    //     gateway::stage_exit(&mut v, ALICE, 100_000, BOOK_MID, ADDR_BOB, scenario.ctx());
    //     gateway::exit_to_bitcoin(&mut v, &mut h, 100_000, BOOK_MID, ADDR_BOB, &clk, ctx);
    //
    // What CAN be tested is the positive half: the bytes that reach the bridge are exactly the
    // bytes pinned for that depositor, and a second depositor with a different pin gets their
    // own — so the destination tracks the on-chain record, never anything a caller supplied.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    deposit(&mut scenario, vault_id, BOB, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);
    register(&mut scenario, vault_id, BOB, ADDR_BOB);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());

    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid_a = mock_hashi::last_request_id(&mock);
    let sent_a = mock_hashi::request_bitcoin_address(&mock, rid_a);
    assert!(sent_a == ADDR_P2TR, 0);
    // Independently re-read the on-chain record: the bridge got exactly what is pinned.
    assert!(sent_a == vault::btc_exit_address(&v, ALICE), 1);
    assert!(sent_a == gateway::pinned_exit_address(&v, ALICE), 2);
    // ...and NOT the other depositor's address, which is the only other address in scope.
    assert!(sent_a != ADDR_BOB, 3);
    ts::return_shared(v);

    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_id);
    compose_exit(&mut v, &mut mock, BOB, 100_000, &clk, scenario.ctx());
    let rid_b = mock_hashi::last_request_id(&mock);
    let sent_b = mock_hashi::request_bitcoin_address(&mock, rid_b);
    assert!(sent_b == ADDR_BOB, 4);
    assert!(sent_b == vault::btc_exit_address(&v, BOB), 5);
    assert!(sent_b != sent_a, 6);
    // Two different destinations, both selected purely by the signer's own on-chain pin.
    assert!(mock_hashi::request_sender(&mock, rid_a) == ALICE, 7);
    assert!(mock_hashi::request_sender(&mock, rid_b) == BOB, 8);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::EExitAddressUnset)]
fun exit_without_a_pinned_address_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000); // deposited, but never registered

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::ENotDepositor)]
fun exit_by_a_non_depositor_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);

    scenario.next_tx(MALLORY);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, MALLORY, 100_000, &clk, scenario.ctx());
    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

// ── T1.4: small-exit pooling and the flush ──────────────────────────────────

#[test]
#[expected_failure(abort_code = gateway::EBelowHashiMinimum)]
fun flush_pending_exit_aborts_below_minimum() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 20_000, &clk, scenario.ctx());
    assert!(vault::pending_exit_sats(&v, ALICE) == 20_000, 0);

    // 20_000 < 30_000: flushing now would make the bridge abort, so the gateway refuses first.
    compose_flush(&mut v, &mut mock, ALICE, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun flush_pending_exit_submits_once_the_pool_clears() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2WPKH);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());

    compose_exit(&mut v, &mut mock, ALICE, 20_000, &clk, scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 15_000, &clk, scenario.ctx());
    assert!(mock_hashi::request_count(&mock) == 0, 0);
    assert!(vault::pending_exit_sats(&v, ALICE) == 35_000, 1);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 2);

    compose_flush(&mut v, &mut mock, ALICE, &clk, scenario.ctx());

    // One request for the WHOLE pool, to the pinned address.
    assert!(mock_hashi::request_count(&mock) == 1, 3);
    let rid = mock_hashi::last_request_id(&mock);
    assert!(mock_hashi::request_amount_sats(&mock, rid) == 35_000, 4);
    assert!(mock_hashi::request_bitcoin_address(&mock, rid) == ADDR_P2WPKH, 5);
    assert!(mock_hashi::request_sender(&mock, rid) == ALICE, 6);

    // The earmark is cleared and the sats have physically left idle.
    assert!(vault::pending_exit_sats(&v, ALICE) == 0, 7);
    assert!(vault::total_pending_exit_sats(&v) == 0, 8);
    assert!(vault::idle_btc_value(&v) == 965_000, 9);
    assert!(vault::shares_of(&v, ALICE) == 965_000, 10);

    // The flush emits ExitRequested with the P2WPKH length, not the P2TR one.
    let requested = event::events_by_type<gateway::ExitRequested>();
    assert!(requested.length() == 1, 11);
    let (ev_vault, ev_who, ev_amount, ev_len) = gateway::exit_requested_fields(requested.borrow(0));
    assert!(ev_vault == vault_id, 12);
    assert!(ev_who == ALICE, 13);
    assert!(ev_amount == 35_000, 14);
    assert!(ev_len == 20, 15);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::ERequesterMismatch)]
fun flush_by_a_non_sender_aborts() {
    // E-M8. If Bob could flush Alice's pool, BOB would become the bridge request's sender and
    // therefore the ONLY party who could ever cancel it — silently converting Alice's pooled
    // exit into funds only a third party can rescue. The flush is self-service ONLY.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());
    // Alice pools enough to clear the minimum, so the ONLY thing that can stop Bob is E-M8.
    compose_exit(&mut v, &mut mock, ALICE, 20_000, &clk, scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 15_000, &clk, scenario.ctx());
    assert!(gateway::clears_hashi_minimum(vault::pending_exit_sats(&v, ALICE)), 0);
    ts::return_shared(v);

    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_id);
    compose_flush(&mut v, &mut mock, ALICE, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
fun take_pending_as_hbtc_returns_the_pool() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 25_000, &clk, scenario.ctx());
    assert!(vault::pending_exit_sats(&v, ALICE) == 25_000, 0);
    ts::return_shared(v);

    // The depositor opts out of waiting and takes the sub-minimum pool as hBTC instead.
    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let out = gateway::take_pending_as_hbtc(&mut v, scenario.ctx());
    assert!(out.value() == 25_000, 1);
    assert!(vault::pending_exit_sats(&v, ALICE) == 0, 2);
    assert!(vault::total_pending_exit_sats(&v) == 0, 3);
    assert!(vault::idle_btc_value(&v) == 975_000, 4);
    // NAV never counted the earmark, so taking it changes nothing for the remaining shares.
    assert!(vault::nav_sats(&v, BOOK_MID) == 975_000, 5);
    assert!(vault::shares_of(&v, ALICE) == 975_000, 6);
    // Nothing ever reached the bridge on this path.
    assert!(mock_hashi::request_count(&mock) == 0, 7);

    let taken = event::events_by_type<gateway::PendingTakenAsHbtc>();
    assert!(taken.length() == 1, 8);
    let (ev_vault, ev_who, ev_amount) = gateway::pending_taken_as_hbtc_fields(taken.borrow(0));
    assert!(ev_vault == vault_id, 9);
    assert!(ev_who == ALICE, 10);
    assert!(ev_amount == 25_000, 11);

    coin::burn_for_testing(out);
    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

// ── T1.4: reclaim (DEPOSITOR-ONLY, RECON R7.3 / E-M8) ───────────────────────

#[test]
fun reclaim_recredits_exactly() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let mut clk = clock::create_for_testing(scenario.ctx());

    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid = mock_hashi::last_request_id(&mock);
    assert!(vault::total_shares(&v) == 900_000, 0);
    assert!(vault::shares_of(&v, ALICE) == 900_000, 1);
    assert!(vault::idle_btc_value(&v) == 900_000, 2);
    ts::return_shared(v);

    // The exit stalls. Only after the 1 h cooldown can the DEPOSITOR cancel it.
    clk.set_for_testing(COOLDOWN_MS);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    compose_reclaim(&mut v, &mut mock, rid, &clk, scenario.ctx());

    // EXACT round trip: balance and shares are back where they started.
    assert!(vault::total_shares(&v) == 1_000_000, 3);
    assert!(vault::shares_of(&v, ALICE) == 1_000_000, 4);
    assert!(vault::idle_btc_value(&v) == 1_000_000, 5);
    assert!(vault::nav_sats(&v, BOOK_MID) == 1_000_000, 6);
    assert!(vault::total_pending_exit_sats(&v) == 0, 7);
    // The bridge no longer holds the request.
    assert!(mock_hashi::request_count(&mock) == 0, 8);
    // The pin is untouched — a reclaim never re-opens the destination (G2).
    assert!(gateway::pinned_exit_address(&v, ALICE) == ADDR_P2TR, 9);

    let reclaimed = event::events_by_type<gateway::ExitReclaimed>();
    assert!(reclaimed.length() == 1, 10);
    let (ev_vault, ev_who, ev_rid, ev_amount) = gateway::exit_reclaimed_fields(reclaimed.borrow(0));
    assert!(ev_vault == vault_id, 11);
    assert!(ev_who == ALICE, 12);
    assert!(ev_rid == rid, 13);
    assert!(ev_amount == 100_000, 14);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::ENotDepositor)]
fun reclaim_by_a_non_depositor_aborts() {
    // The gateway guard `reclaim_stalled_exit` runs BEFORE it ever touches the bridge.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let mut clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid = mock_hashi::last_request_id(&mock);
    ts::return_shared(v);

    clk.set_for_testing(COOLDOWN_MS);

    // Mallory has no depositor record at all.
    scenario.next_tx(MALLORY);
    let mut v = borrow(&scenario, vault_id);
    compose_reclaim(&mut v, &mut mock, rid, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = gateway::ERequesterMismatch)]
fun reclaim_for_another_depositor_aborts() {
    // Bob IS a depositor, so `ENotDepositor` cannot fire — the sender/beneficiary mismatch is
    // what stops him crediting Alice's cancelled exit to himself (or to her, on her behalf).
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    deposit(&mut scenario, vault_id, BOB, 1_000_000);

    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_id);
    let back = balance::create_for_testing<TESTBTC>(100_000);
    gateway::settle_reclaim(&mut v, ALICE, @0xDEAD, back, BOOK_MID, scenario.ctx());

    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = mock_hashi::EUnauthorizedCancellation)]
fun reclaim_surfaces_upstream_unauthorized_abort() {
    // G3 / RECON R7.3: `cancel_withdrawal` asserts request.sender == ctx.sender(). Bob is a
    // registered depositor, so both gateway guards pass — and the UPSTREAM abort surfaces
    // unwrapped. Move has no try/catch, so "do not swallow it" is structurally guaranteed.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    deposit(&mut scenario, vault_id, BOB, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let mut clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid = mock_hashi::last_request_id(&mock);
    ts::return_shared(v);

    clk.set_for_testing(COOLDOWN_MS);

    scenario.next_tx(BOB);
    let mut v = borrow(&scenario, vault_id);
    compose_reclaim(&mut v, &mut mock, rid, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = mock_hashi::ECannotCancelProcessingWithdrawal)]
fun reclaim_surfaces_upstream_post_commit_abort() {
    // Once the committee commits the request the hBTC is burned; cancellation is impossible.
    // G3: we never model a queue position we can un-take.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let mut clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid = mock_hashi::last_request_id(&mock);
    mock_hashi::mark_processing(&mut mock, rid);
    ts::return_shared(v);

    clk.set_for_testing(COOLDOWN_MS);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    compose_reclaim(&mut v, &mut mock, rid, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = mock_hashi::ECooldownNotElapsed)]
fun reclaim_surfaces_upstream_cooldown_abort() {
    // One millisecond short of the 1 h cancellation cooldown.
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);
    deposit(&mut scenario, vault_id, ALICE, 1_000_000);
    register(&mut scenario, vault_id, ALICE, ADDR_P2TR);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let mut clk = clock::create_for_testing(scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 100_000, &clk, scenario.ctx());
    let rid = mock_hashi::last_request_id(&mock);
    ts::return_shared(v);

    clk.set_for_testing(COOLDOWN_MS - 1);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    compose_reclaim(&mut v, &mut mock, rid, &clk, scenario.ctx());

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}

// ── G1: every Sui-side leg is instant, one PTB, no wait ─────────────────────

#[test]
fun every_sui_side_leg_completes_in_one_ptb() {
    // Deposit, pin, exit and the bridge submission all happen inside a SINGLE transaction.
    // Nothing blocks on a Bitcoin confirmation: the ~1.5-2 h latency lives entirely inside the
    // bridge AFTER `request_withdrawal` returns (G1, G6).
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, OWNER, KEEPER);

    scenario.next_tx(ALICE);
    let mut v = borrow(&scenario, vault_id);
    let mut mock = mock_hashi::new_mock<TESTBTC>(scenario.ctx());
    let clk = clock::create_for_testing(scenario.ctx());

    let c = coin::mint_for_testing<TESTBTC>(500_000, scenario.ctx());
    let shares = vault::deposit_btc(&mut v, c, BOOK_MID, scenario.ctx());
    assert!(shares == 500_000, 0);
    gateway::register_exit_address(&mut v, ADDR_P2TR, scenario.ctx());
    compose_exit(&mut v, &mut mock, ALICE, 200_000, &clk, scenario.ctx());

    assert!(mock_hashi::request_count(&mock) == 1, 1);
    let rid = mock_hashi::last_request_id(&mock);
    assert!(mock_hashi::request_amount_sats(&mock, rid) == 200_000, 2);
    assert!(mock_hashi::request_bitcoin_address(&mock, rid) == ADDR_P2TR, 3);
    assert!(vault::shares_of(&v, ALICE) == 300_000, 4);
    assert!(vault::idle_btc_value(&v) == 300_000, 5);

    // All three receipts are in the SAME transaction's event stream.
    assert!(event::events_by_type<gateway::ExitAddressRegistered>().length() == 1, 6);
    assert!(event::events_by_type<gateway::ExitRequested>().length() == 1, 7);
    assert!(event::events_by_type<gateway::ExitPooled>().length() == 0, 8);

    clock::destroy_for_testing(clk);
    mock_hashi::destroy_mock(mock);
    ts::return_shared(v);
    scenario.end();
}
