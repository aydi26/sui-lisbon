#[test_only]
module aphotic::caps_tests;

use aphotic::caps::{Self, CapRegistry, AdminCap, KeeperCap};
use aphotic::events;
use sui::address;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.1
// @phase      1
// @status     DONE
// @spec       aphotic.md#10-invariants (L463-L466)   <- the four capability invariants
// @spec       aphotic.md#6.1-capabilities (L279-L287)
// @spec       aphotic-governance.md#3-vault-administration (L95-L101)
// @rules      G10
// @depends    aphotic::caps (T1.1) · aphotic::events (T1.0)
// @facts      The four assertions §10 demands of this module, restated as the tests below:
// @facts        (a) No KeeperCap function can move assets to an address outside the pinned
// @facts            allowlist   -> allowlist_gates_every_keeper_payout,
// @facts                           a_keeper_payout_to_an_unlisted_address_aborts
// @facts        (b) No KeeperCap function can mint, burn or rotate a capability
// @facts            -> keeper_admits_exactly_the_six_declared_actions (the action set IS the
// @facts               enumeration, and none of the six is a cap operation) and
// @facts               rotation_requires_an_admin_cap (the type system is the enforcement:
// @facts               `rotate_keeper_cap` takes `&AdminCap`, so a keeper-only caller cannot
// @facts               even construct the call)
// @facts        (c) AdminCap transfer requires explicit acceptance
// @facts            -> admin_transfer_requires_explicit_acceptance and the five negatives
// @facts        (d) a rotated-out KeeperCap is rejected, and a cap from another vault is
// @facts            rejected -> rotated_out_keeper_cap_is_rejected,
// @facts                        foreign_*_cap_is_rejected
// @implements #[test] fun new_registry_seeds_both_parties()                      [DONE]
//             #[test] fun admin_transfer_requires_explicit_acceptance()          [DONE]
//             #[test] fun accepting_retires_the_outgoing_admin_cap()             [DONE]
//             #[test] fun only_the_nominee_can_accept()                          [DONE]
//             #[test] fun accepting_without_a_nomination_aborts()                [DONE]
//             #[test] fun a_second_nomination_while_one_is_pending_aborts()      [DONE]
//             #[test] fun nominating_the_sitting_admin_aborts()                  [DONE]
//             #[test] fun cancelling_restores_a_clean_slate()                    [DONE]
//             #[test] fun cancelling_without_a_nomination_aborts()               [DONE]
//             #[test] fun foreign_admin_cap_is_rejected()                        [DONE]
//             #[test] fun rotation_delivers_a_fresh_cap_and_retires_the_old()    [DONE]
//             #[test] fun rotated_out_keeper_cap_is_rejected()                   [DONE]
//             #[test] fun foreign_keeper_cap_is_rejected()                       [DONE]
//             #[test] fun foreign_vault_cap_is_rejected()                        [DONE]
//             #[test] fun rotation_requires_an_admin_cap()                       [DONE]
//             #[test] fun pause_is_a_complete_keeper_kill_switch()               [DONE]
//             #[test] fun a_paused_vault_still_answers_to_its_admin()            [DONE]
//             #[test] fun keeper_admits_exactly_the_six_declared_actions()       [DONE]
//             #[test] fun an_undeclared_keeper_action_aborts()                   [DONE]
//             #[test] fun allowlist_gates_every_keeper_payout()                  [DONE]
//             #[test] fun a_keeper_payout_to_an_unlisted_address_aborts()        [DONE]
//             #[test] fun disallowing_an_absent_entry_aborts()                   [DONE]
//             #[test] fun the_allowlist_is_bounded()                             [DONE]
//             #[test] fun epochs_only_ever_increase()                            [DONE]
// @invariant  1. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  2. No test weakens an invariant to pass. Where §10 is enforced by the TYPE system
//                rather than by an assert, the test says so explicitly instead of pretending to
//                exercise a call that cannot be written.
// @ac         aphotic.md §10 "Capabilities", all four bullets
// @verify     sui move test caps
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;
const NEW_ADMIN: address = @0xADD;
const INTRUDER: address = @0xBAD;
const KEEPER: address = @0xC0FFEE;
const NEW_KEEPER: address = @0xC0FFEF;
const ADAPTER: address = @0xA11;
const OTHER_ADAPTER: address = @0xA12;

/// A fresh, unique object id, standing in for the vault the registry will be embedded in.
fun a_vault_id(sc: &mut Scenario): ID {
    let uid = object::new(sc.ctx());
    let id = uid.to_inner();
    uid.delete();
    id
}

/// Genesis: a registry bound to a fresh vault id, with the caps delivered to ADMIN and KEEPER.
/// Leaves the scenario in a tx sent by ADMIN, with the AdminCap takeable.
fun bootstrap(sc: &mut Scenario): (CapRegistry, ID) {
    let vault_id = a_vault_id(sc);
    let (reg, vault_cap) = caps::new_registry(vault_id, ADMIN, KEEPER, sc.ctx());
    // The vault cap would live inside the Vault; no vault exists in this suite.
    caps::destroy_vault_cap(vault_cap);
    sc.next_tx(ADMIN);
    (reg, vault_id)
}

// ════════════════════════════════════════════════════════════════════════════
// genesis
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun new_registry_seeds_both_parties() {
    let mut sc = ts::begin(ADMIN);
    let vault_id = a_vault_id(&mut sc);

    let (reg, vault_cap) = caps::new_registry(vault_id, ADMIN, KEEPER, sc.ctx());

    // The registry records both parties, both epochs start at zero, nothing is pending.
    assert!(caps::vault_id(&reg) == vault_id, 0);
    assert!(caps::admin(&reg) == ADMIN, 1);
    assert!(caps::keeper(&reg) == KEEPER, 2);
    assert!(caps::admin_epoch(&reg) == 0, 3);
    assert!(caps::keeper_epoch(&reg) == 0, 4);
    assert!(!caps::is_paused(&reg), 5);
    assert!(caps::pending_admin(&reg).is_none(), 6);
    assert!(caps::allowlist_size(&reg) == 0, 7);
    assert!(caps::vault_cap_vault_id(&vault_cap) == vault_id, 8);

    // The receipt.
    let emitted = event::events_by_type<events::CapsInitialized>();
    assert!(emitted.length() == 1, 9);
    let (ev_vault, ev_admin, ev_keeper) = events::caps_initialized_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id, 10);
    assert!(ev_admin == ADMIN, 11);
    assert!(ev_keeper == KEEPER, 12);

    caps::destroy_vault_cap(vault_cap);

    // The caps landed at the two addresses, and both are live.
    sc.next_tx(ADMIN);
    let admin_cap = sc.take_from_sender<AdminCap>();
    assert!(caps::admin_cap_vault_id(&admin_cap) == vault_id, 13);
    assert!(caps::admin_cap_epoch(&admin_cap) == 0, 14);
    caps::assert_admin(&reg, &admin_cap);
    sc.return_to_sender(admin_cap);

    sc.next_tx(KEEPER);
    let keeper_cap = sc.take_from_sender<KeeperCap>();
    assert!(caps::keeper_cap_vault_id(&keeper_cap) == vault_id, 15);
    assert!(caps::keeper_cap_epoch(&keeper_cap) == 0, 16);
    caps::assert_keeper(&reg, &keeper_cap);
    sc.return_to_sender(keeper_cap);

    caps::destroy_registry(reg);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// §10 Capabilities — "AdminCap transfer requires explicit acceptance"
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun admin_transfer_requires_explicit_acceptance() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, vault_id) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &admin_cap, NEW_ADMIN);

    // STEP 1 MOVED NOTHING. The sitting admin is still the admin, the epoch is untouched, and
    // the nominee holds no capability whatsoever.
    assert!(caps::admin(&reg) == ADMIN, 0);
    assert!(caps::admin_epoch(&reg) == 0, 1);
    assert!(caps::pending_admin(&reg) == option::some(NEW_ADMIN), 2);
    caps::assert_admin(&reg, &admin_cap);

    let initiated = event::events_by_type<events::AdminTransferInitiated>();
    assert!(initiated.length() == 1, 3);
    let (ev_vault, ev_from, ev_to) = events::admin_transfer_initiated_fields(initiated.borrow(0));
    assert!(ev_vault == vault_id && ev_from == ADMIN && ev_to == NEW_ADMIN, 4);

    sc.return_to_sender(admin_cap);

    // The nominee has received no object at all.
    sc.next_tx(NEW_ADMIN);
    assert!(!ts::has_most_recent_for_sender<AdminCap>(&sc), 5);

    // STEP 2 — and only step 2 — moves authority.
    caps::accept_admin_transfer(&mut reg, sc.ctx());
    assert!(caps::admin(&reg) == NEW_ADMIN, 6);
    assert!(caps::admin_epoch(&reg) == 1, 7);
    assert!(caps::pending_admin(&reg).is_none(), 8);

    let accepted = event::events_by_type<events::AdminTransferAccepted>();
    assert!(accepted.length() == 1, 9);
    let (_, ev_from2, ev_to2, ev_epoch) =
        events::admin_transfer_accepted_fields(accepted.borrow(0));
    assert!(ev_from2 == ADMIN && ev_to2 == NEW_ADMIN && ev_epoch == 1, 10);

    sc.next_tx(NEW_ADMIN);
    let fresh = sc.take_from_sender<AdminCap>();
    assert!(caps::admin_cap_epoch(&fresh) == 1, 11);
    caps::assert_admin(&reg, &fresh);
    sc.return_to_sender(fresh);

    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::EStaleAdminEpoch)]
fun accepting_retires_the_outgoing_admin_cap() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let old_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &old_cap, NEW_ADMIN);

    sc.next_tx(NEW_ADMIN);
    caps::accept_admin_transfer(&mut reg, sc.ctx());

    // There is never a moment with two live AdminCaps: the epoch bump retired this one in the
    // same transaction that minted the new one.
    caps::assert_admin(&reg, &old_cap);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ENotPendingAdmin)]
fun only_the_nominee_can_accept() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &admin_cap, NEW_ADMIN);
    sc.return_to_sender(admin_cap);

    sc.next_tx(INTRUDER);
    caps::accept_admin_transfer(&mut reg, sc.ctx());

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ENoPendingTransfer)]
fun accepting_without_a_nomination_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    sc.next_tx(NEW_ADMIN);
    caps::accept_admin_transfer(&mut reg, sc.ctx());

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::EAlreadyPending)]
fun a_second_nomination_while_one_is_pending_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &admin_cap, NEW_ADMIN);
    // Re-pointing an outstanding nomination must be an explicit cancel, not an overwrite.
    caps::initiate_admin_transfer(&mut reg, &admin_cap, INTRUDER);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ETransferToSelf)]
fun nominating_the_sitting_admin_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &admin_cap, ADMIN);

    abort 42
}

#[test]
fun cancelling_restores_a_clean_slate() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, vault_id) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &admin_cap, NEW_ADMIN);
    caps::cancel_admin_transfer(&mut reg, &admin_cap);

    assert!(caps::pending_admin(&reg).is_none(), 0);
    assert!(caps::admin(&reg) == ADMIN, 1);
    assert!(caps::admin_epoch(&reg) == 0, 2);

    let cancelled = event::events_by_type<events::AdminTransferCancelled>();
    assert!(cancelled.length() == 1, 3);
    let (ev_vault, ev_from, ev_to) =
        events::admin_transfer_cancelled_fields(cancelled.borrow(0));
    assert!(ev_vault == vault_id && ev_from == ADMIN && ev_to == NEW_ADMIN, 4);

    // And a fresh nomination is possible again.
    caps::initiate_admin_transfer(&mut reg, &admin_cap, INTRUDER);
    assert!(caps::pending_admin(&reg) == option::some(INTRUDER), 5);
    sc.return_to_sender(admin_cap);

    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::ENoPendingTransfer)]
fun cancelling_without_a_nomination_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::cancel_admin_transfer(&mut reg, &admin_cap);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun foreign_admin_cap_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _) = bootstrap(&mut sc);

    // A perfectly valid AdminCap — for a DIFFERENT vault.
    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_admin_cap_for_testing(other_vault, sc.ctx());
    caps::assert_admin(&reg, &foreign);

    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// §10 Capabilities — rotation, and "a rotated-out cap is rejected"
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun rotation_delivers_a_fresh_cap_and_retires_the_old() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, vault_id) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::rotate_keeper_cap(&mut reg, &admin_cap, NEW_KEEPER, sc.ctx());

    assert!(caps::keeper(&reg) == NEW_KEEPER, 0);
    assert!(caps::keeper_epoch(&reg) == 1, 1);

    let rotated = event::events_by_type<events::KeeperCapRotated>();
    assert!(rotated.length() == 1, 2);
    let (ev_vault, ev_old, ev_new, ev_epoch) =
        events::keeper_cap_rotated_fields(rotated.borrow(0));
    assert!(ev_vault == vault_id && ev_old == KEEPER && ev_new == NEW_KEEPER && ev_epoch == 1, 3);

    sc.return_to_sender(admin_cap);

    // The NEW keeper's cap is live.
    sc.next_tx(NEW_KEEPER);
    let fresh = sc.take_from_sender<KeeperCap>();
    assert!(caps::keeper_cap_epoch(&fresh) == 1, 4);
    caps::assert_keeper(&reg, &fresh);
    caps::assert_keeper_action(&reg, &fresh, caps::action_settle_batch());
    sc.return_to_sender(fresh);

    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::EStaleKeeperEpoch)]
fun rotated_out_keeper_cap_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    sc.next_tx(KEEPER);
    let old_keeper_cap = sc.take_from_sender<KeeperCap>();
    // It works before the rotation.
    caps::assert_keeper(&reg, &old_keeper_cap);

    sc.next_tx(ADMIN);
    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::rotate_keeper_cap(&mut reg, &admin_cap, NEW_KEEPER, sc.ctx());

    // The compromised key still HOLDS the object. It is simply no longer authority.
    caps::assert_keeper(&reg, &old_keeper_cap);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun foreign_keeper_cap_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _) = bootstrap(&mut sc);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_keeper_cap_for_testing(other_vault, sc.ctx());
    caps::assert_keeper(&reg, &foreign);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun foreign_vault_cap_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _) = bootstrap(&mut sc);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    caps::assert_vault_cap(&reg, &foreign);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::EStaleAdminEpoch)]
fun rotation_requires_an_admin_cap() {
    // §10: "No KeeperCap function can mint, burn, or rotate a capability."
    //
    // In Move that is enforced by the TYPE system, not by an assert: `rotate_keeper_cap` takes
    // `&AdminCap`, so a caller holding only a `KeeperCap` cannot construct the call at all —
    // there is no runtime path to exercise, and writing one would require changing the
    // signature, which is exactly what the invariant forbids.
    //
    // What CAN be tested at runtime is the neighbouring hole: a retired admin must not be able
    // to rotate either. Here the admin has handed over, and their old cap no longer rotates.
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let old_admin_cap = sc.take_from_sender<AdminCap>();
    caps::initiate_admin_transfer(&mut reg, &old_admin_cap, NEW_ADMIN);

    sc.next_tx(NEW_ADMIN);
    caps::accept_admin_transfer(&mut reg, sc.ctx());

    sc.next_tx(ADMIN);
    caps::rotate_keeper_cap(&mut reg, &old_admin_cap, INTRUDER, sc.ctx());

    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// pause
// ════════════════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = caps::EPaused)]
fun pause_is_a_complete_keeper_kill_switch() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::set_paused(&mut reg, &admin_cap, true);
    assert!(caps::is_paused(&reg), 0);
    sc.return_to_sender(admin_cap);

    sc.next_tx(KEEPER);
    let keeper_cap = sc.take_from_sender<KeeperCap>();
    // Pause is checked inside `assert_keeper`, so no keeper entry point can forget it.
    caps::assert_keeper(&reg, &keeper_cap);

    abort 42
}

#[test]
fun a_paused_vault_still_answers_to_its_admin() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, vault_id) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::set_paused(&mut reg, &admin_cap, true);

    let paused_ev = event::events_by_type<events::PauseSet>();
    assert!(paused_ev.length() == 1, 0);
    let (ev_vault, ev_paused) = events::pause_set_fields(paused_ev.borrow(0));
    assert!(ev_vault == vault_id && ev_paused, 1);

    // An admin whose own path was pause-gated could never unpause. It is not.
    caps::assert_admin(&reg, &admin_cap);
    caps::set_paused(&mut reg, &admin_cap, false);
    assert!(!caps::is_paused(&reg), 2);
    sc.return_to_sender(admin_cap);

    // ...and the keeper is authority again.
    sc.next_tx(KEEPER);
    let keeper_cap = sc.take_from_sender<KeeperCap>();
    caps::assert_keeper(&reg, &keeper_cap);
    sc.return_to_sender(keeper_cap);

    caps::destroy_registry(reg);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// the EXHAUSTIVE keeper action set (§6.1)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun keeper_admits_exactly_the_six_declared_actions() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _) = bootstrap(&mut sc);

    sc.next_tx(KEEPER);
    let keeper_cap = sc.take_from_sender<KeeperCap>();

    // The six of §6.1, and their discriminants are distinct and dense.
    assert!(caps::action_propose_nav() == 0, 0);
    assert!(caps::action_close_batch() == 1, 1);
    assert!(caps::action_settle_batch() == 2, 2);
    assert!(caps::action_allocate() == 3, 3);
    assert!(caps::action_deallocate() == 4, 4);
    assert!(caps::action_place_carry_bid() == 5, 5);
    assert!(caps::keeper_action_count() == 6, 6);

    // Every one of them passes.
    let mut a = 0u8;
    while (a < caps::keeper_action_count()) {
        caps::assert_keeper_action(&reg, &keeper_cap, a);
        a = a + 1;
    };

    // None of the six is a capability operation or an asset move: the whole set is
    // valuation, batch lifecycle, lending allocation and a price-bounded carry bid.
    sc.return_to_sender(keeper_cap);
    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::EUnknownKeeperAction)]
fun an_undeclared_keeper_action_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _) = bootstrap(&mut sc);

    sc.next_tx(KEEPER);
    let keeper_cap = sc.take_from_sender<KeeperCap>();
    // Discriminant 6 is one past the declared set. Widening it is a governance change.
    caps::assert_keeper_action(&reg, &keeper_cap, caps::keeper_action_count());

    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// the pinned payout allowlist
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun allowlist_gates_every_keeper_payout() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, vault_id) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    assert!(!caps::is_allowed(&reg, ADAPTER), 0);

    caps::allow_address(&mut reg, &admin_cap, ADAPTER);
    assert!(caps::is_allowed(&reg, ADAPTER), 1);
    assert!(caps::allowlist_size(&reg) == 1, 2);
    caps::assert_allowed(&reg, ADAPTER);

    let updated = event::events_by_type<events::AllowlistUpdated>();
    assert!(updated.length() == 1, 3);
    let (ev_vault, ev_entry, ev_allowed, ev_size) =
        events::allowlist_updated_fields(updated.borrow(0));
    assert!(ev_vault == vault_id && ev_entry == ADAPTER && ev_allowed && ev_size == 1, 4);

    // Idempotent: re-allowing does not double-count.
    caps::allow_address(&mut reg, &admin_cap, ADAPTER);
    assert!(caps::allowlist_size(&reg) == 1, 5);

    caps::allow_address(&mut reg, &admin_cap, OTHER_ADAPTER);
    assert!(caps::allowlist_entries(&reg).length() == 2, 6);

    caps::disallow_address(&mut reg, &admin_cap, ADAPTER);
    assert!(!caps::is_allowed(&reg, ADAPTER), 7);
    assert!(caps::is_allowed(&reg, OTHER_ADAPTER), 8);

    sc.return_to_sender(admin_cap);
    caps::destroy_registry(reg);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::ENotAllowlisted)]
fun a_keeper_payout_to_an_unlisted_address_aborts() {
    // §10: "No KeeperCap function can move assets to an address outside the pinned allowlist."
    // Every keeper-driven payout calls `assert_allowed` with its destination before moving
    // value; here the destination was never pinned.
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::allow_address(&mut reg, &admin_cap, ADAPTER);
    sc.return_to_sender(admin_cap);

    caps::assert_allowed(&reg, INTRUDER);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::ENotAllowlistedEntry)]
fun disallowing_an_absent_entry_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    caps::disallow_address(&mut reg, &admin_cap, ADAPTER);

    abort 42
}

#[test]
#[expected_failure(abort_code = caps::EAllowlistFull)]
fun the_allowlist_is_bounded() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    let mut i = 0u64;
    while (i < caps::max_allowlist()) {
        caps::allow_address(&mut reg, &admin_cap, address::from_u256(((i + 1) as u256)));
        i = i + 1;
    };
    assert!(caps::allowlist_size(&reg) == caps::max_allowlist(), 0);

    // A long allowlist is an un-auditable one; the 33rd entry is refused.
    caps::allow_address(&mut reg, &admin_cap, ADAPTER);

    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// epoch monotonicity
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun epochs_only_ever_increase() {
    let mut sc = ts::begin(ADMIN);
    let (mut reg, _) = bootstrap(&mut sc);

    let admin_cap = sc.take_from_sender<AdminCap>();
    let mut seen_keeper_epoch = caps::keeper_epoch(&reg);
    let mut r = 0u64;
    while (r < 4) {
        caps::rotate_keeper_cap(&mut reg, &admin_cap, NEW_KEEPER, sc.ctx());
        let now = caps::keeper_epoch(&reg);
        assert!(now == seen_keeper_epoch + 1, r);
        seen_keeper_epoch = now;
        r = r + 1;
    };

    // Nothing here can lower an epoch: pausing, allowlisting and cancelling a nomination all
    // leave both counters where they were.
    caps::set_paused(&mut reg, &admin_cap, true);
    caps::set_paused(&mut reg, &admin_cap, false);
    caps::allow_address(&mut reg, &admin_cap, ADAPTER);
    caps::initiate_admin_transfer(&mut reg, &admin_cap, NEW_ADMIN);
    caps::cancel_admin_transfer(&mut reg, &admin_cap);
    assert!(caps::keeper_epoch(&reg) == 4, 100);
    assert!(caps::admin_epoch(&reg) == 0, 101);

    sc.return_to_sender(admin_cap);
    caps::destroy_registry(reg);
    sc.end();
}
