module aphotic::balance;

use aphotic::caps::{Self, VaultCap};
use aphotic::events;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.1-notes (L333)   <- "Participants hold a persistent internal
//             balance, topped up independently of trading; orders draw on it with no on-chain
//             movement at submission."
// @spec       aphotic.md#2-hard-constraints (L54, L56)  <- no size leak · value preservation
// @spec       aphotic.md#10-invariants (L441-L446)      <- the Settlement invariants
// @spec       aphotic-governance.md#6.3-note-model (L248)
// @rules      G10
// @depends    aphotic::caps (T1.1) · aphotic::events (T1.0)
// @facts      Money is u64 SATOSHIS throughout. hBTC has 8 decimals (RECON R5), so the book's
// @facts        unit and the note ladder's unit are the same unit.
// @facts      GENERIC over the coin type `T` so this module names no upstream package. The
// @facts        vault instantiates it with hBTC (`0xfcea10ca…::btc::BTC`); the id lives in
// @facts        Move.toml and in the keeper/app config, never in logic.
// @facts      WHY THERE IS NO `reserve` / `lock` PRIMITIVE — and this is a design decision, not
// @facts        an omission: locking collateral at order-submission time would publish the
// @facts        order's size, which is precisely the leak the sealed batch exists to close
// @facts        (§7.1 "Denominations still leak timing if escrow is funded at order time").
// @facts        An order therefore DRAWS on the persistent balance and reserves nothing. The
// @facts        consequence is explicit: a participant may top down between submission and
// @facts        clearing, and clearing must treat an under-funded account as a failed fill —
// @facts        `has_at_least` is provided for exactly that check.
// @facts      WHY DEBIT/CREDIT EMIT NOTHING: the per-transaction event ceiling is 1_024 and the
// @facts        store-entry ceiling 1_000, neither raisable by paying more gas. One event per
// @facts        fill would cap the batch below the store-entry limit for no verifiability gain,
// @facts        because settlement publishes an aggregate `BatchSettled` receipt plus the fill
// @facts        Merkle root. Value crossing the CUSTODY boundary — top up, withdraw — always
// @facts        emits.
// @external   (none)
// @implements public fun new_book<T>(vault_id: ID, ctx: &mut TxContext): BalanceBook<T>
//             public fun top_up<T>(book: &mut BalanceBook<T>, payment: Coin<T>,
//                 ctx: &TxContext): u64
//             public fun top_up_for<T>(book: &mut BalanceBook<T>, payment: Coin<T>,
//                 who: address): u64
//             public fun withdraw<T>(book: &mut BalanceBook<T>, amount_sats: u64,
//                 ctx: &mut TxContext): Coin<T>
//             public fun debit<T>(book: &mut BalanceBook<T>, cap: &VaultCap, who: address,
//                 amount_sats: u64)
//             public fun credit<T>(book: &mut BalanceBook<T>, cap: &VaultCap, who: address,
//                 amount_sats: u64)
//             public fun transfer_internal<T>(book: &mut BalanceBook<T>, cap: &VaultCap,
//                 from: address, to: address, amount_sats: u64)
//             public fun balance_of<T>(book: &BalanceBook<T>, who: address): u64
//             public fun has_at_least<T>(book: &BalanceBook<T>, who: address,
//                 amount_sats: u64): bool
//             public fun has_account<T>(book: &BalanceBook<T>, who: address): bool
//             public fun total_credited<T>(book: &BalanceBook<T>): u64
//             public fun custody_value<T>(book: &BalanceBook<T>): u64
//             public fun accounts_opened<T>(book: &BalanceBook<T>): u64
//             public fun book_vault_id<T>(book: &BalanceBook<T>): ID
//             public fun assert_solvent<T>(book: &BalanceBook<T>)
//             public fun destroy_empty_book<T>(book: BalanceBook<T>)
// @events     BalanceToppedUp · BalanceWithdrawn (declared in aphotic::events)
// @errors     EZeroAmount · EInsufficientBalance · ENoAccount · EInsolvent · ESameAccount
//             · ECapVaultMismatch · EBookNotEmpty
// @forbidden  a `reserve` / `lock` / `escrow_for_order` primitive — see @facts. It would
//             publish order size at submission and defeat the sealed batch.
// @forbidden  a per-fill event in `debit` / `credit` / `transfer_internal` — it would burn the
//             1_024-event ceiling; the batch-level receipt is the record
// @forbidden  a keeper-gated withdrawal to an arbitrary address — `withdraw` pays the SENDER
//             and takes no destination parameter at all, so there is no address to redirect
// @forbidden  crediting without a matching debit outside a `transfer_internal` — it would break
//             `assert_solvent`, which settlement calls at the end of every batch
// @invariant  1. SOLVENCY: `total_credited == custody_value` after every externally reachable
//                call. `assert_solvent` is the assertion; `top_up` and `withdraw` move both
//                sides together and `transfer_internal` moves neither.
// @invariant  2. `debit` and `credit` are the raw halves, and are only correct IN PAIRS. Any
//                sequence of them must end with `assert_solvent`, which settlement calls, so an
//                unbalanced clearing reverts (hard constraint §2.6, debits equal credits).
// @invariant  3. `withdraw` pays `ctx.sender()` and nobody else. There is no destination
//                argument on any function in this module.
// @invariant  4. `balance_of` of an address that never interacted is 0, not an abort — absence
//                of a record is a zero balance.
// @invariant  5. No function reveals, records or reacts to an ORDER. This module knows only
//                addresses and sats, so submitting an order produces no state change here and
//                therefore no timing signal (§7.1).
// @invariant  6. Every internal-ledger mutator requires the vault's own `VaultCap`, bound to the
//                same `vault_id` as the book.
// @ac         move/tests/balance_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test balance
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const EZeroAmount: u64 = 1;
const EInsufficientBalance: u64 = 2;
const ENoAccount: u64 = 3;
const EInsolvent: u64 = 4;
const ESameAccount: u64 = 5;
const ECapVaultMismatch: u64 = 6;
const EBookNotEmpty: u64 = 7;

// ── structs ─────────────────────────────────────────────────────────────────

/// The persistent internal ledger. `store` only: embedded by value in the Vault.
///
/// `custody` is this book's OWN coin holding, physically separate from the vault's trading
/// balance. Keeping them separate is what lets both `assert_solvent` here and
/// `notes::assert_note_backing` there be exact identities rather than inequalities.
public struct BalanceBook<phantom T> has store {
    vault_id: ID,
    custody: Balance<T>,
    /// address -> sats. An address with no row has a zero balance (@invariant 4).
    accounts: Table<address, u64>,
    /// Σ of every row. Held equal to `custody.value()` by @invariant 1.
    total_credited: u64,
    /// Rows ever opened. Monotonic; a row is never removed, because removing it would make a
    /// participant's first top-up after a full withdrawal look different from their tenth.
    accounts_opened: u64,
}

public fun new_book<T>(vault_id: ID, ctx: &mut TxContext): BalanceBook<T> {
    BalanceBook {
        vault_id,
        custody: balance::zero<T>(),
        accounts: table::new<address, u64>(ctx),
        total_credited: 0,
        accounts_opened: 0,
    }
}

// ── the custody boundary ────────────────────────────────────────────────────

/// Top up the sender's own internal balance. Independent of trading by design: this is the
/// only moment value moves in, and it is deliberately decoupled from order submission so that
/// submitting an order produces no on-chain movement at all (§7.1).
public fun top_up<T>(book: &mut BalanceBook<T>, payment: Coin<T>, ctx: &TxContext): u64 {
    top_up_for(book, payment, ctx.sender())
}

/// Top up `who`. Sponsored onboarding uses this — the payer and the beneficiary differ, and
/// neither fact says anything about an order.
public fun top_up_for<T>(book: &mut BalanceBook<T>, payment: Coin<T>, who: address): u64 {
    let amount_sats = payment.value();
    assert!(amount_sats > 0, EZeroAmount);

    book.custody.join(payment.into_balance());
    open_account(book, who);
    let row = book.accounts.borrow_mut(who);
    *row = *row + amount_sats;
    let balance_after_sats = *row;
    book.total_credited = book.total_credited + amount_sats;

    events::emit_balance_topped_up(book.vault_id, who, amount_sats, balance_after_sats);
    balance_after_sats
}

/// Withdraw from the sender's own internal balance. Pays the SENDER; there is no destination
/// parameter, so there is nothing for a compromised keeper — or anyone else — to redirect
/// (@invariant 3).
public fun withdraw<T>(
    book: &mut BalanceBook<T>,
    amount_sats: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(amount_sats > 0, EZeroAmount);
    let who = ctx.sender();
    assert!(book.accounts.contains(who), ENoAccount);

    let row = book.accounts.borrow_mut(who);
    assert!(*row >= amount_sats, EInsufficientBalance);
    *row = *row - amount_sats;
    let balance_after_sats = *row;
    book.total_credited = book.total_credited - amount_sats;

    let out = coin::from_balance(book.custody.split(amount_sats), ctx);
    events::emit_balance_withdrawn(book.vault_id, who, amount_sats, balance_after_sats);
    out
}

// ── the settlement surface (clearing calls these) ───────────────────────────

/// Raw debit. Correct only when paired with a matching credit in the same transaction — see
/// @invariant 2. Emits nothing (see @facts).
public fun debit<T>(book: &mut BalanceBook<T>, cap: &VaultCap, who: address, amount_sats: u64) {
    assert_book_cap(book, cap);
    assert!(amount_sats > 0, EZeroAmount);
    assert!(book.accounts.contains(who), ENoAccount);

    let row = book.accounts.borrow_mut(who);
    assert!(*row >= amount_sats, EInsufficientBalance);
    *row = *row - amount_sats;
    book.total_credited = book.total_credited - amount_sats;
}

/// Raw credit. The other half of @invariant 2.
public fun credit<T>(book: &mut BalanceBook<T>, cap: &VaultCap, who: address, amount_sats: u64) {
    assert_book_cap(book, cap);
    assert!(amount_sats > 0, EZeroAmount);

    open_account(book, who);
    let row = book.accounts.borrow_mut(who);
    *row = *row + amount_sats;
    book.total_credited = book.total_credited + amount_sats;
}

/// The value-preserving primitive, and the one clearing should reach for: it cannot break
/// solvency because it never touches `total_credited` or `custody` at all.
public fun transfer_internal<T>(
    book: &mut BalanceBook<T>,
    cap: &VaultCap,
    from: address,
    to: address,
    amount_sats: u64,
) {
    assert_book_cap(book, cap);
    assert!(from != to, ESameAccount);
    assert!(amount_sats > 0, EZeroAmount);
    assert!(book.accounts.contains(from), ENoAccount);

    let debited = book.accounts.borrow_mut(from);
    assert!(*debited >= amount_sats, EInsufficientBalance);
    *debited = *debited - amount_sats;

    open_account(book, to);
    let credited = book.accounts.borrow_mut(to);
    *credited = *credited + amount_sats;
}

// ── invariants and reads ────────────────────────────────────────────────────

/// Hard constraint §2.6 made checkable: settlement calls this last, and an unbalanced batch
/// reverts the whole transaction.
public fun assert_solvent<T>(book: &BalanceBook<T>) {
    assert!(book.total_credited == book.custody.value(), EInsolvent);
}

public fun balance_of<T>(book: &BalanceBook<T>, who: address): u64 {
    if (!book.accounts.contains(who)) return 0;
    *book.accounts.borrow(who)
}

/// The check clearing performs instead of holding a reserve — see the @facts note on why there
/// is no reserve primitive.
public fun has_at_least<T>(book: &BalanceBook<T>, who: address, amount_sats: u64): bool {
    balance_of(book, who) >= amount_sats
}

public fun has_account<T>(book: &BalanceBook<T>, who: address): bool {
    book.accounts.contains(who)
}

public fun total_credited<T>(book: &BalanceBook<T>): u64 { book.total_credited }

public fun custody_value<T>(book: &BalanceBook<T>): u64 { book.custody.value() }

public fun accounts_opened<T>(book: &BalanceBook<T>): u64 { book.accounts_opened }

public fun book_vault_id<T>(book: &BalanceBook<T>): ID { book.vault_id }

fun open_account<T>(book: &mut BalanceBook<T>, who: address) {
    if (!book.accounts.contains(who)) {
        book.accounts.add(who, 0);
        book.accounts_opened = book.accounts_opened + 1;
    };
}

fun assert_book_cap<T>(book: &BalanceBook<T>, cap: &VaultCap) {
    assert!(caps::vault_cap_vault_id(cap) == book.vault_id, ECapVaultMismatch);
}

// ── teardown ────────────────────────────────────────────────────────────────

/// Refuses while a satoshi of participant money is still here.
public fun destroy_empty_book<T>(book: BalanceBook<T>) {
    let BalanceBook { vault_id: _, custody, accounts, total_credited, accounts_opened: _ } = book;
    assert!(total_credited == 0, EBookNotEmpty);
    assert!(custody.value() == 0, EBookNotEmpty);
    custody.destroy_zero();
    table::drop(accounts);
}
