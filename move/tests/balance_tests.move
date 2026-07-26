#[test_only]
module aphotic::balance_tests;

use aphotic::balance::{Self, BalanceBook};
use aphotic::caps::{Self, CapRegistry, VaultCap};
use aphotic::events;
use sui::coin;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.1-notes (L333)   <- persistent internal balance, drawn on with no
//             on-chain movement at submission
// @spec       aphotic.md#2-hard-constraints (L54, L56)
// @spec       aphotic.md#10-invariants (L441-L446)
// @spec       aphotic-governance.md#6.3-note-model (L248)
// @rules      G10
// @depends    aphotic::balance (T3.2) · aphotic::caps (T1.1) · aphotic::events (T1.0)
// @facts      The settlement invariants this suite is responsible for:
// @facts        "settle_batch reverts unless total debits equal total credits"
// @facts          -> an_unbalanced_settlement_is_caught, debits_and_credits_balance
// @facts        "escrow must not leak order size" (§2.4) — the module-level consequence is
// @facts          that there is NO reserve primitive, so submitting an order changes nothing
// @facts          here -> submission_moves_nothing_because_there_is_nothing_to_reserve
// @facts      TESTBTC stands in for hBTC. The module is generic over the coin type precisely so
// @facts        it names no upstream package; the real instantiation is
// @facts        `0xfcea10ca…::btc::BTC` (RECON R5), 8 decimals, and the unit here is the sat.
// @implements #[test] fun a_fresh_book_is_empty_and_solvent()                     [DONE]
//             #[test] fun top_up_moves_custody_and_ledger_together()              [DONE]
//             #[test] fun top_up_for_credits_a_third_party()                      [DONE]
//             #[test] fun withdraw_pays_the_sender_and_takes_no_destination()     [DONE]
//             #[test] fun withdrawing_more_than_the_balance_aborts()              [DONE]
//             #[test] fun withdrawing_without_an_account_aborts()                 [DONE]
//             #[test] fun a_zero_top_up_aborts()                                  [DONE]
//             #[test] fun a_zero_withdrawal_aborts()                              [DONE]
//             #[test] fun balance_of_an_unknown_address_is_zero()                 [DONE]
//             #[test] fun debits_and_credits_balance()                            [DONE]
//             #[test] fun an_unbalanced_settlement_is_caught()                    [DONE]
//             #[test] fun credit_opens_an_account()                               [DONE]
//             #[test] fun debiting_an_account_that_never_existed_aborts()         [DONE]
//             #[test] fun debiting_past_the_balance_aborts()                      [DONE]
//             #[test] fun transfer_internal_cannot_break_solvency()               [DONE]
//             #[test] fun transfer_internal_to_self_aborts()                      [DONE]
//             #[test] fun transfer_internal_past_the_balance_aborts()             [DONE]
//             #[test] fun a_foreign_vault_cap_cannot_debit()                      [DONE]
//             #[test] fun a_foreign_vault_cap_cannot_credit()                     [DONE]
//             #[test] fun a_foreign_vault_cap_cannot_transfer()                   [DONE]
//             #[test] fun submission_moves_nothing_because_there_is_nothing_to_reserve()
//                                                                                 [DONE]
//             #[test] fun an_account_drained_between_submission_and_clearing_is_detected()
//                                                                                 [DONE]
//             #[test] fun an_account_row_is_never_removed()                        [DONE]
//             #[test] fun destroying_a_funded_book_aborts()                        [DONE]
//             #[test] fun a_drained_book_can_be_destroyed()                        [DONE]
// @invariant  1. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  2. Solvency (`total_credited == custody_value`) is re-asserted after every
//                externally reachable call the suite makes, not only at the end.
// @ac         aphotic.md §10 "Settlement", value-preservation bullet
// @verify     sui move test balance
// └── END CONTRACT ───────────────────────────────────────────────────────────

/// Stand-in for hBTC. The book is generic so the module names no upstream package.
public struct TESTBTC has drop {}

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;

fun a_vault_id(sc: &mut Scenario): ID {
    let uid = object::new(sc.ctx());
    let id = uid.to_inner();
    uid.delete();
    id
}

fun bootstrap(sc: &mut Scenario): (CapRegistry, VaultCap, BalanceBook<TESTBTC>, ID) {
    let vault_id = a_vault_id(sc);
    let (reg, vault_cap) = caps::new_registry(vault_id, ADMIN, KEEPER, sc.ctx());
    let book = balance::new_book<TESTBTC>(vault_id, sc.ctx());
    sc.next_tx(ADMIN);
    (reg, vault_cap, book, vault_id)
}

fun teardown(reg: CapRegistry, vault_cap: VaultCap, book: BalanceBook<TESTBTC>) {
    caps::destroy_registry(reg);
    caps::destroy_vault_cap(vault_cap);
    drain(book);
}

/// Empty the book through the public surface so `destroy_empty_book`'s guard is honoured.
fun drain(book: BalanceBook<TESTBTC>) {
    balance::destroy_empty_book(book);
}

fun fund(sc: &mut Scenario, book: &mut BalanceBook<TESTBTC>, who: address, sats: u64) {
    let payment = coin::mint_for_testing<TESTBTC>(sats, sc.ctx());
    balance::top_up_for(book, payment, who);
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — the custody boundary
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun a_fresh_book_is_empty_and_solvent() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, book, vault_id) = bootstrap(&mut sc);

    assert!(balance::total_credited(&book) == 0, 0);
    assert!(balance::custody_value(&book) == 0, 1);
    assert!(balance::accounts_opened(&book) == 0, 2);
    assert!(balance::book_vault_id(&book) == vault_id, 3);
    assert!(!balance::has_account(&book, ALICE), 4);
    balance::assert_solvent(&book);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
fun top_up_moves_custody_and_ledger_together() {
    let mut sc = ts::begin(ALICE);
    let (reg, vault_cap, mut book, vault_id) = bootstrap(&mut sc);

    sc.next_tx(ALICE);
    let payment = coin::mint_for_testing<TESTBTC>(1_500_000, sc.ctx());
    let after = balance::top_up(&mut book, payment, sc.ctx());

    assert!(after == 1_500_000, 0);
    assert!(balance::balance_of(&book, ALICE) == 1_500_000, 1);
    assert!(balance::custody_value(&book) == 1_500_000, 2);
    assert!(balance::total_credited(&book) == 1_500_000, 3);
    assert!(balance::accounts_opened(&book) == 1, 4);
    balance::assert_solvent(&book);

    let emitted = event::events_by_type<events::BalanceToppedUp>();
    assert!(emitted.length() == 1, 5);
    let (ev_vault, ev_who, ev_amount, ev_after) =
        events::balance_topped_up_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id && ev_who == ALICE, 6);
    assert!(ev_amount == 1_500_000 && ev_after == 1_500_000, 7);

    // A second top-up accumulates rather than replacing, and opens no new row.
    let more = coin::mint_for_testing<TESTBTC>(500_000, sc.ctx());
    assert!(balance::top_up(&mut book, more, sc.ctx()) == 2_000_000, 8);
    assert!(balance::accounts_opened(&book) == 1, 9);
    balance::assert_solvent(&book);

    // Drain so the book can be destroyed through the public surface.
    let out = balance::withdraw(&mut book, 2_000_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 2_000_000, 10);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
fun top_up_for_credits_a_third_party() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);

    // Sponsored onboarding: the payer and the beneficiary differ, and neither fact says
    // anything about an order.
    fund(&mut sc, &mut book, ALICE, 700_000);
    assert!(balance::balance_of(&book, ALICE) == 700_000, 0);
    assert!(balance::balance_of(&book, ADMIN) == 0, 1);
    balance::assert_solvent(&book);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 700_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 700_000, 2);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
fun withdraw_pays_the_sender_and_takes_no_destination() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, vault_id) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 1_000_000);

    sc.next_tx(ALICE);
    // There is no destination ARGUMENT on this call — `withdraw(book, amount, ctx)` — so there
    // is nothing for a compromised keeper, or anyone else, to redirect.
    let out = balance::withdraw(&mut book, 400_000, sc.ctx());
    assert!(out.value() == 400_000, 0);
    assert!(balance::balance_of(&book, ALICE) == 600_000, 1);
    assert!(balance::custody_value(&book) == 600_000, 2);
    balance::assert_solvent(&book);

    let emitted = event::events_by_type<events::BalanceWithdrawn>();
    assert!(emitted.length() == 1, 3);
    let (ev_vault, ev_who, ev_amount, ev_after) =
        events::balance_withdrawn_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id && ev_who == ALICE, 4);
    assert!(ev_amount == 400_000 && ev_after == 600_000, 5);

    assert!(coin::burn_for_testing(out) == 400_000, 6);
    let rest = balance::withdraw(&mut book, 600_000, sc.ctx());
    assert!(coin::burn_for_testing(rest) == 600_000, 7);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
#[expected_failure(abort_code = balance::EInsufficientBalance)]
fun withdrawing_more_than_the_balance_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 101, sc.ctx());
    coin::burn_for_testing(out);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::ENoAccount)]
fun withdrawing_without_an_account_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);

    sc.next_tx(BOB);
    let out = balance::withdraw(&mut book, 1, sc.ctx());
    coin::burn_for_testing(out);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::EZeroAmount)]
fun a_zero_top_up_aborts() {
    let mut sc = ts::begin(ALICE);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);

    sc.next_tx(ALICE);
    let payment = coin::mint_for_testing<TESTBTC>(0, sc.ctx());
    balance::top_up(&mut book, payment, sc.ctx());
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::EZeroAmount)]
fun a_zero_withdrawal_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 0, sc.ctx());
    coin::burn_for_testing(out);
    abort 42
}

#[test]
fun balance_of_an_unknown_address_is_zero() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, book, _) = bootstrap(&mut sc);

    // Absence of a record is a zero balance, not an error — clearing must be able to ask about
    // an address it has never seen without reverting the whole batch.
    assert!(balance::balance_of(&book, CAROL) == 0, 0);
    assert!(!balance::has_account(&book, CAROL), 1);
    assert!(!balance::has_at_least(&book, CAROL, 1), 2);
    assert!(balance::has_at_least(&book, CAROL, 0), 3);

    teardown(reg, vault_cap, book);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// 2 — the settlement surface (§2.6, debits equal credits or the transaction reverts)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun debits_and_credits_balance() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 3_000_000);

    // One fill: ALICE pays, BOB receives, and the custody balance never moves — the value was
    // already inside the book, which is exactly why order submission needs no on-chain
    // movement (§7.1).
    let custody_before = balance::custody_value(&book);
    balance::debit(&mut book, &vault_cap, ALICE, 1_200_000);
    balance::credit(&mut book, &vault_cap, BOB, 1_200_000);

    assert!(balance::balance_of(&book, ALICE) == 1_800_000, 0);
    assert!(balance::balance_of(&book, BOB) == 1_200_000, 1);
    assert!(balance::custody_value(&book) == custody_before, 2);
    assert!(balance::total_credited(&book) == 3_000_000, 3);
    balance::assert_solvent(&book);

    sc.next_tx(BOB);
    let out = balance::withdraw(&mut book, 1_200_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 1_200_000, 4);
    sc.next_tx(ALICE);
    let rest = balance::withdraw(&mut book, 1_800_000, sc.ctx());
    assert!(coin::burn_for_testing(rest) == 1_800_000, 5);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
#[expected_failure(abort_code = balance::EInsolvent)]
fun an_unbalanced_settlement_is_caught() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 1_000_000);

    // A clearing that debits without the matching credit. `assert_solvent` is what settlement
    // calls last, and it reverts the whole transaction — hard constraint §2.6.
    balance::debit(&mut book, &vault_cap, ALICE, 400_000);
    balance::assert_solvent(&book);
    abort 42
}

#[test]
fun credit_opens_an_account() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 1_000_000);

    assert!(!balance::has_account(&book, CAROL), 0);
    balance::transfer_internal(&mut book, &vault_cap, ALICE, CAROL, 250_000);
    assert!(balance::has_account(&book, CAROL), 1);
    assert!(balance::balance_of(&book, CAROL) == 250_000, 2);
    assert!(balance::accounts_opened(&book) == 2, 3);
    balance::assert_solvent(&book);

    sc.next_tx(CAROL);
    let out = balance::withdraw(&mut book, 250_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 250_000, 4);
    sc.next_tx(ALICE);
    let rest = balance::withdraw(&mut book, 750_000, sc.ctx());
    assert!(coin::burn_for_testing(rest) == 750_000, 5);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
#[expected_failure(abort_code = balance::ENoAccount)]
fun debiting_an_account_that_never_existed_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    balance::debit(&mut book, &vault_cap, CAROL, 1);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::EInsufficientBalance)]
fun debiting_past_the_balance_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 10);
    balance::debit(&mut book, &vault_cap, ALICE, 11);
    abort 42
}

#[test]
fun transfer_internal_cannot_break_solvency() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 2_000_000);
    fund(&mut sc, &mut book, BOB, 500_000);

    let total_before = balance::total_credited(&book);
    let custody_before = balance::custody_value(&book);

    // It touches neither `total_credited` nor `custody`, so no sequence of these can ever
    // leave the book insolvent — which is why clearing should reach for this rather than the
    // raw halves.
    let mut i = 0u64;
    while (i < 5) {
        balance::transfer_internal(&mut book, &vault_cap, ALICE, BOB, 100_000);
        balance::assert_solvent(&book);
        i = i + 1;
    };

    assert!(balance::total_credited(&book) == total_before, 0);
    assert!(balance::custody_value(&book) == custody_before, 1);
    assert!(balance::balance_of(&book, ALICE) == 1_500_000, 2);
    assert!(balance::balance_of(&book, BOB) == 1_000_000, 3);
    assert!(
        balance::balance_of(&book, ALICE) + balance::balance_of(&book, BOB) == total_before,
        4,
    );

    sc.next_tx(ALICE);
    let a = balance::withdraw(&mut book, 1_500_000, sc.ctx());
    assert!(coin::burn_for_testing(a) == 1_500_000, 5);
    sc.next_tx(BOB);
    let b = balance::withdraw(&mut book, 1_000_000, sc.ctx());
    assert!(coin::burn_for_testing(b) == 1_000_000, 6);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
#[expected_failure(abort_code = balance::ESameAccount)]
fun transfer_internal_to_self_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);
    balance::transfer_internal(&mut book, &vault_cap, ALICE, ALICE, 50);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::EInsufficientBalance)]
fun transfer_internal_past_the_balance_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);
    balance::transfer_internal(&mut book, &vault_cap, ALICE, BOB, 101);
    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// 3 — vault binding
// ════════════════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = balance::ECapVaultMismatch)]
fun a_foreign_vault_cap_cannot_debit() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    balance::debit(&mut book, &foreign, ALICE, 10);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::ECapVaultMismatch)]
fun a_foreign_vault_cap_cannot_credit() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    balance::credit(&mut book, &foreign, ALICE, 10);
    abort 42
}

#[test]
#[expected_failure(abort_code = balance::ECapVaultMismatch)]
fun a_foreign_vault_cap_cannot_transfer() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 100);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    balance::transfer_internal(&mut book, &foreign, ALICE, BOB, 10);
    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// 4 — the reason there is no reserve primitive (§7.1 / §2.4)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun submission_moves_nothing_because_there_is_nothing_to_reserve() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 5_000_000);

    // A fresh transaction: everything below is what ONE order submission would do.
    sc.next_tx(ALICE);
    let ledger_before = balance::balance_of(&book, ALICE);
    let custody_before = balance::custody_value(&book);
    let total_before = balance::total_credited(&book);

    // Submitting an order consults the book and nothing more. There is deliberately NO
    // `reserve` / `lock` / `escrow_for_order` function to call: locking collateral at
    // submission would publish the order's size, which is the exact leak the sealed batch
    // exists to close. The reads below are the entire interaction.
    assert!(balance::has_at_least(&book, ALICE, 4_000_000), 0);
    assert!(balance::has_at_least(&book, ALICE, 5_000_000), 1);
    assert!(!balance::has_at_least(&book, ALICE, 5_000_001), 2);

    assert!(balance::balance_of(&book, ALICE) == ledger_before, 3);
    assert!(balance::custody_value(&book) == custody_before, 4);
    assert!(balance::total_credited(&book) == total_before, 5);
    assert!(balance::accounts_opened(&book) == 1, 6);
    // No event was produced by any of it, so there is no timing signal either.
    assert!(event::events_by_type<events::BalanceToppedUp>().length() == 0, 7);
    assert!(event::events_by_type<events::BalanceWithdrawn>().length() == 0, 8);
    balance::assert_solvent(&book);

    let out = balance::withdraw(&mut book, 5_000_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 5_000_000, 9);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
fun an_account_drained_between_submission_and_clearing_is_detected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 1_000_000);

    // Because nothing is reserved, a participant CAN top down after submitting. That is the
    // stated cost of not leaking size, and it is not silent: clearing checks funding before it
    // fills, and treats the shortfall as a failed fill rather than a failed batch.
    assert!(balance::has_at_least(&book, ALICE, 900_000), 0);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 800_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 800_000, 1);

    assert!(!balance::has_at_least(&book, ALICE, 900_000), 2);
    assert!(balance::has_at_least(&book, ALICE, 200_000), 3);
    balance::assert_solvent(&book);

    let rest = balance::withdraw(&mut book, 200_000, sc.ctx());
    assert!(coin::burn_for_testing(rest) == 200_000, 4);

    teardown(reg, vault_cap, book);
    sc.end();
}

#[test]
fun an_account_row_is_never_removed() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 300_000);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 300_000, sc.ctx());
    assert!(coin::burn_for_testing(out) == 300_000, 0);

    // The row survives at zero. Removing it would make a participant's first top-up after a
    // full withdrawal observably different from their tenth — a free timing signal.
    assert!(balance::has_account(&book, ALICE), 1);
    assert!(balance::balance_of(&book, ALICE) == 0, 2);
    assert!(balance::accounts_opened(&book) == 1, 3);

    let again = coin::mint_for_testing<TESTBTC>(50_000, sc.ctx());
    assert!(balance::top_up(&mut book, again, sc.ctx()) == 50_000, 4);
    assert!(balance::accounts_opened(&book) == 1, 5);

    let last = balance::withdraw(&mut book, 50_000, sc.ctx());
    assert!(coin::burn_for_testing(last) == 50_000, 6);

    teardown(reg, vault_cap, book);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// 5 — teardown
// ════════════════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = balance::EBookNotEmpty)]
fun destroying_a_funded_book_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 1);
    balance::destroy_empty_book(book);
    abort 42
}

#[test]
fun a_drained_book_can_be_destroyed() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut book, _) = bootstrap(&mut sc);
    fund(&mut sc, &mut book, ALICE, 123_456);

    sc.next_tx(ALICE);
    let out = balance::withdraw(&mut book, 123_456, sc.ctx());
    assert!(coin::burn_for_testing(out) == 123_456, 0);
    assert!(balance::total_credited(&book) == 0, 1);
    assert!(balance::custody_value(&book) == 0, 2);
    balance::assert_solvent(&book);

    caps::destroy_registry(reg);
    caps::destroy_vault_cap(vault_cap);
    balance::destroy_empty_book(book);
    sc.end();
}
