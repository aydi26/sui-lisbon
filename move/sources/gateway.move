module aphotic::gateway;

use aphotic::vault::{Self, Vault};
use hashi::btc::BTC;
use hashi::hashi::Hashi;
use hashi::withdraw;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.3, T1.4
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#module-gateway (L502-L605)
// @spec       docs/RECON.md#R7-hashi-move-surface (L76-L100)
// @spec       docs/BUILD-PLAN.md#T1.3-T1.4 (L80-L81)
// @rules      G1 G2 G3 G7 G10
// @depends    aphotic::vault (T1.1) · aphotic::envelope (T4.1) · the bridge package (external)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000   (live on-chain config read 2026-07-25, RECON R6)
// @facts      ⚠ `hashi::btc_config::bitcoin_withdrawal_minimum()` is public(package)
// @facts        (RECON R7.1) ⇒ NOT CALLABLE from this package. Use the named constant above.
// @facts        ERRATA vs docs/MOVE-PACKAGE.md §6.4, which suggests reading the getter.
// @facts      DUST_FLOOR_SATS = 546
// @facts      EXIT_ADDR_LEN in {20 (P2WPKH), 32 (P2TR)}    (RECON R7 verbatim assert)
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000  (1 h, RECON R6)
// @facts      bitcoin_deposit_time_delay_ms = 600_000 · bitcoin_confirmation_threshold = 6
// @facts      bitcoin package id / shared-object id NEVER appear here — the `&mut Hashi`
// @facts        shared object is threaded in from the PTB by the keeper/app (G7).
// @facts      hBTC withdrawal latency ~1.5-2 h happens INSIDE the bridge AFTER this returns;
// @facts        every Sui-side step here is instant, one checkpoint (G1, G6).
// @facts      ⚠ `hashi::deposit::{deposit, confirm_deposit, approve_deposit,
// @facts        delete_expired_deposit}` are `entry` ⇒ PTB COMMANDS, never Move-callable
// @facts        (E-M9). The permissionless deposit crank therefore lives in the keeper/app PTB
// @facts        builder and deliberately has NO counterpart in this module. The whole
// @facts        Move-composable bridge surface is exactly two functions, both used below.
// @facts      ⚠ TESTABILITY SPLIT (see @invariant 7). Move has no dependency injection and the
// @facts        bridge's `Config`/`CommitteeSet` constructors are public(package), so a real
// @facts        `Hashi` CANNOT be built inside `sui move test`. Every decision this module makes
// @facts        therefore lives in generic `public(package)` staging functions that
// @facts        move/tests/gateway_tests.move drives for real against aphotic::mock_hashi;
// @facts        the three bridge-composing wrappers below are the residual 2-4 line tails.
// @external   public fun hashi::withdraw::request_withdrawal(
//                 hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                 bitcoin_address: vector<u8>, ctx: &mut TxContext)
//             // asserts btc.value() >= 30_000              EBelowMinimumWithdrawal
//             // asserts addr_len == 20 || addr_len == 32    EInvalidBitcoinAddress
//             // consumes the Balance<BTC>; emits withdrawal_queue::WithdrawalRequested
//             public fun hashi::withdraw::cancel_withdrawal(
//                 hashi: &mut Hashi, request_id: address, clock: &Clock,
//                 ctx: &mut TxContext): Balance<BTC>
//             // asserts request.sender == ctx.sender()      EUnauthorizedCancellation   ⚠⚠
//             // asserts !is_request_processing              ECannotCancelProcessingWithdrawal
//             // asserts now >= created_ms + 3_600_000       ECooldownNotElapsed
//             ⚠⚠ cancel_withdrawal is SENDER-BOUND (RECON R7.3). The keeper can NEVER call it.
//                 reclaim_stalled_exit is DEPOSITOR-CALLABLE ONLY, and flush_pending_exit must
//                 assert who == ctx.sender() for the same reason — otherwise the flusher becomes
//                 the only party able to reclaim the resulting request.
//             public struct hashi::btc::BTC has key { id: UID }   // coin_registry style, NOT a
//                 drop witness. Users hold Coin<BTC>; the bridge takes Balance<BTC>.
//             public struct hashi::hashi::Hashi has key { ... }   // the shared object
// @implements public fun register_exit_address<B, Q>(vault: &mut Vault<B, Q>,
//                 addr: vector<u8>, ctx: &mut TxContext)                        [DONE]
//             public fun exit_to_bitcoin<Q>(vault: &mut Vault<BTC, Q>, hashi: &mut Hashi,
//                 shares_to_burn: u64, book_mid: u128, clock: &Clock,
//                 ctx: &mut TxContext)                                          [DONE]
//             public fun reclaim_stalled_exit<Q>(vault: &mut Vault<BTC, Q>, hashi: &mut Hashi,
//                 request_id: address, book_mid: u128, clock: &Clock,
//                 ctx: &mut TxContext)                                          [DONE]
//             public fun flush_pending_exit<Q>(vault: &mut Vault<BTC, Q>, hashi: &mut Hashi,
//                 who: address, clock: &Clock, ctx: &mut TxContext)             [DONE]
//             public fun take_pending_as_hbtc<B, Q>(vault: &mut Vault<B, Q>,
//                 ctx: &mut TxContext): Coin<B>                                 [DONE]
//             public fun pinned_exit_address<B, Q>(vault: &Vault<B, Q>,
//                 who: address): vector<u8>                                     [DONE]
//             public fun assert_reclaim_caller<B, Q>(vault: &Vault<B, Q>, who: address,
//                 ctx: &TxContext)                                              [DONE]
//             public(package) fun stage_exit<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 shares_to_burn: u64, book_mid: u128,
//                 ctx: &mut TxContext): (Option<Balance<B>>, vector<u8>)        [DONE]
//             public(package) fun stage_flush<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 ctx: &TxContext): (Balance<B>, vector<u8>)                    [DONE]
//             public(package) fun settle_reclaim<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 request_id: address, btc_back: Balance<B>, book_mid: u128,
//                 ctx: &TxContext)                                              [DONE]
//             public fun assert_valid_exit_address(addr: &vector<u8>)           [DONE]
//             public fun clears_hashi_minimum(amount_sats: u64): bool           [DONE]
//             public fun hashi_withdrawal_min_sats(): u64                       [DONE]
//             public fun dust_floor_sats(): u64                                 [DONE]
//             ⚠ DELTA vs the skeleton banner, deliberate and documented:
//               (a) register_exit_address / take_pending_as_hbtc are generic <B, Q>. They touch
//                   NO bridge surface, so pinning them to the bridge coin type would only make
//                   them untestable. Only the three functions that actually thread `&mut Hashi`
//                   are concrete in BTC.
//               (b) flush_pending_exit keeps the `who` parameter of docs/MOVE-PACKAGE.md §6.4.
//                   E-M8 requires `who == ctx.sender()` to be ASSERTED; an assertion that cannot
//                   fail (because `who` is always `ctx.sender()`) cannot be tested, and this is
//                   the invariant a third party could otherwise weaponise.
// @events     ExitAddressRegistered { vault_id: ID, who: address, addr_len: u64 }
//             ExitRequested { vault_id: ID, who: address, amount_sats: u64, addr_len: u64 }
//             ExitPooled { vault_id: ID, who: address, amount_sats: u64, pooled_total_sats: u64 }
//             ExitReclaimed { vault_id: ID, who: address, request_id: address, amount_sats: u64 }
//             PendingTakenAsHbtc { vault_id: ID, who: address, amount_sats: u64 }
// @errors     EBadAddressLength · EExitAddressAlreadySet · EExitAddressUnset
//             · EBelowHashiMinimum · ENotDepositor · ERequesterMismatch
// @forbidden  a `bitcoin_address` PARAMETER on ANY exit function — G2, gates.ps1 g2.
//             The destination is READ from the vault's write-once record. There is no
//             parameter a compromised keeper or frontend could use to redirect funds.
// @forbidden  bridge module paths in ANY other sources/*.move — G7, gates.ps1 g7.
//             This file is the ONLY permitted occurrence.
// @forbidden  submitting an exit below 30_000 sats — the bridge would abort; pool it instead (G3)
// @forbidden  swallowing the bridge's aborts in reclaim (not-requester / post-commit /
//             cooldown-not-elapsed) — surface them (G3)
// @forbidden  the keeper calling reclaim_stalled_exit — sender-bound upstream (RECON R7.3)
// @forbidden  a `moveCall` to hashi::deposit::confirm_deposit from here — it is `entry`,
//             i.e. a PTB command only (E-M9)
// @invariant  1. btc_exit_address is WRITE-ONCE. First call sets it; any later call aborts
//                EExitAddressAlreadySet. This is the entire anti-redirect guarantee (G2).
// @invariant  2. exit_to_bitcoin reads the destination from the Vault, NEVER from a parameter (G2).
//                `pinned_exit_address` is the ONLY producer of the address argument, and its only
//                inputs are the vault and the depositor address.
// @invariant  3. amount < HASHI_WITHDRAWAL_MIN_SATS implies POOLED, never submitted (G3).
// @invariant  4. reclaim_stalled_exit and flush_pending_exit both assert who == ctx.sender(),
//                because the upstream cancel is sender-bound (RECON R7.3). A third party must
//                never be able to create a request only it can cancel.
// @invariant  5. Every Sui-side leg completes in ONE PTB with no wait/block (G1).
// @invariant  6. This module never receives, stores or exercises a DeepBook Withdraw/DepositCap (G2).
// @invariant  7. Every branch, guard and state transition lives in a generic staging function
//                (`stage_exit`, `stage_flush`, `settle_reclaim`, `register_exit_address`,
//                `take_pending_as_hbtc`). The three bridge wrappers contain NO logic beyond
//                threading the staged value into `request_withdrawal`/`cancel_withdrawal`.
// @invariant  8. ExitRequested is emitted BEFORE the bridge call (inside the staging function),
//                so the vault-side receipt always precedes the upstream WithdrawalRequested in
//                the same PTB's event stream.
// @ac         docs/MOVE-PACKAGE.md §8 gateway_tests checklist (L652-L659)
// @verify     sui move build
// @verify     sui move test gateway
// @verify     Get-ChildItem move\sources -Filter *.move -Recurse |
//               Select-String -Pattern 'hashi::' |
//               Select-Object -ExpandProperty Path -Unique   # must be ONLY this file
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §6.5) ─────────────────────────────
const EBadAddressLength: u64 = 1;
const EExitAddressAlreadySet: u64 = 2;
const EExitAddressUnset: u64 = 3;
const EBelowHashiMinimum: u64 = 4;
const ENotDepositor: u64 = 5;
const ERequesterMismatch: u64 = 6;

// ── bridge config, injected as named constants ──────────────────────────────
// The upstream accessors are public(package) (RECON R7.1) so these CANNOT be read on-chain.
// Values are the live testnet config read on 2026-07-25 (RECON R6).

/// Minimum withdrawal the bridge accepts, in sats. Below this the upstream call aborts
/// EBelowMinimumWithdrawal, so sub-minimum exits are POOLED instead (G3).
const HASHI_WITHDRAWAL_MIN_SATS: u64 = 30_000;

/// Bitcoin dust floor in sats.
const DUST_FLOOR_SATS: u64 = 546;

/// P2WPKH witness-program length.
const EXIT_ADDR_LEN_P2WPKH: u64 = 20;

/// P2TR witness-program length.
const EXIT_ADDR_LEN_P2TR: u64 = 32;

// ── events (docs/MOVE-PACKAGE.md §6.5) ──────────────────────────────────────

public struct ExitAddressRegistered has copy, drop {
    vault_id: ID,
    who: address,
    /// The address bytes themselves are public on-chain; only the length is emitted here.
    addr_len: u64,
}

public struct ExitRequested has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
    addr_len: u64,
}

public struct ExitPooled has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
    pooled_total_sats: u64,
}

public struct ExitReclaimed has copy, drop {
    vault_id: ID,
    who: address,
    request_id: address,
    amount_sats: u64,
}

public struct PendingTakenAsHbtc has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
}

// ── pure guards (mirror the upstream asserts exactly) ───────────────────────

/// Mirror of the upstream `EInvalidBitcoinAddress` assert (RECON R7):
/// only P2WPKH (20 bytes) and P2TR (32 bytes) witness programs are supported.
/// Called by `register_exit_address` so a bad address is rejected at PIN time, not at exit time.
public fun assert_valid_exit_address(addr: &vector<u8>) {
    let addr_len = addr.length();
    assert!(addr_len == EXIT_ADDR_LEN_P2WPKH || addr_len == EXIT_ADDR_LEN_P2TR, EBadAddressLength);
}

/// Mirror of the upstream `EBelowMinimumWithdrawal` assert (RECON R7).
/// `false` means the exit MUST be pooled rather than submitted (G3).
public fun clears_hashi_minimum(amount_sats: u64): bool {
    amount_sats >= HASHI_WITHDRAWAL_MIN_SATS
}

public fun hashi_withdrawal_min_sats(): u64 { HASHI_WITHDRAWAL_MIN_SATS }

public fun dust_floor_sats(): u64 { DUST_FLOOR_SATS }

// ── the pinned destination (G2) ─────────────────────────────────────────────

/// THE ONLY producer of the Bitcoin address argument handed to the bridge.
///
/// Its only inputs are the vault and the depositor address; there is no code path in this
/// package through which a caller-supplied destination can reach `request_withdrawal`. That
/// absence is the anti-redirect guarantee — a fully compromised keeper or frontend has nothing
/// to redirect (G2).
public fun pinned_exit_address<B, Q>(vault: &Vault<B, Q>, who: address): vector<u8> {
    assert!(vault::has_depositor(vault, who), ENotDepositor);
    let addr = vault::btc_exit_address(vault, who);
    assert!(!addr.is_empty(), EExitAddressUnset);
    addr
}

/// Self-service guard shared by the reclaim path.
///
/// `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()` (RECON R7.3),
/// so the reclaimer must be the depositor who signed the exit. The keeper can build the PTB but
/// can never sign it (G2, E-M8).
public fun assert_reclaim_caller<B, Q>(vault: &Vault<B, Q>, who: address, ctx: &TxContext) {
    assert!(who == ctx.sender(), ERequesterMismatch);
    assert!(vault::has_depositor(vault, who), ENotDepositor);
}

// ── T1.3: register the write-once destination ───────────────────────────────

/// Bind the sender's Bitcoin payout address. WRITE-ONCE (G2): the first call sets it, any later
/// call aborts `EExitAddressAlreadySet`.
///
/// The record is created on demand, so an address can be pinned before the first deposit —
/// which is exactly the onboarding order the app uses (pin, then show the deposit QR).
///
/// Generic over the asset pair: this function touches no bridge surface.
public fun register_exit_address<B, Q>(
    vault: &mut Vault<B, Q>,
    addr: vector<u8>,
    ctx: &mut TxContext,
) {
    assert_valid_exit_address(&addr);
    let who = ctx.sender();

    // Gateway-level write-once check FIRST so the caller sees `EExitAddressAlreadySet` from the
    // module they called. `vault::set_exit_address` re-checks as defence in depth.
    if (vault::has_depositor(vault, who)) {
        assert!(vault::btc_exit_address(vault, who).is_empty(), EExitAddressAlreadySet);
    };

    let addr_len = addr.length();
    vault::set_exit_address(vault, who, addr);

    event::emit(ExitAddressRegistered { vault_id: object::id(vault), who, addr_len });
}

// ── T1.3/T1.4: staging — every decision this module makes lives here ────────

/// Burn `shares_to_burn` of `who` and decide submit-vs-pool.
///
/// Returns `(some(balance), pinned_addr)` when the proceeds clear the bridge minimum and must be
/// submitted, or `(none, pinned_addr)` when they were pooled instead (G3: the bridge REJECTS
/// sub-minimum amounts, it does not queue them).
///
/// The returned address is read from the vault's write-once record — the caller cannot influence
/// it, and there is no parameter through which it could (G2, @invariant 2).
public(package) fun stage_exit<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    shares_to_burn: u64,
    book_mid: u128,
    ctx: &mut TxContext,
): (Option<Balance<B>>, vector<u8>) {
    let addr = pinned_exit_address(vault, who);
    let addr_len = addr.length();

    let btc = vault::burn_shares_for_btc(vault, who, shares_to_burn, book_mid, ctx);
    let amount_sats = btc.value();
    let vault_id = object::id(vault);

    if (!clears_hashi_minimum(amount_sats)) {
        // G3: below the minimum the upstream call would abort `EBelowMinimumWithdrawal`.
        // Pool the sats as an earmark on idle and submit nothing.
        vault::add_pending_exit(vault, who, btc);
        let pooled_total_sats = vault::pending_exit_sats(vault, who);
        event::emit(ExitPooled { vault_id, who, amount_sats, pooled_total_sats });
        return (option::none(), addr)
    };

    // @invariant 8: the vault-side receipt precedes the bridge call. If the upstream request
    // aborts, the whole PTB reverts and neither event is observed.
    event::emit(ExitRequested { vault_id, who, amount_sats, addr_len });
    (option::some(btc), addr)
}

/// Take `who`'s whole pooled earmark out for submission, once it clears the bridge minimum.
///
/// ⚠ E-M8 / RECON R7.3: the flusher becomes the bridge request's `sender`, and
/// `cancel_withdrawal` is sender-bound. A third-party flush would therefore make that third
/// party the ONLY party able to reclaim the request — so a flush is SELF-SERVICE ONLY.
public(package) fun stage_flush<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    ctx: &TxContext,
): (Balance<B>, vector<u8>) {
    assert!(who == ctx.sender(), ERequesterMismatch);

    let addr = pinned_exit_address(vault, who);
    let addr_len = addr.length();

    let pooled = vault::take_pending_exit(vault, who);
    let amount_sats = pooled.value();
    assert!(clears_hashi_minimum(amount_sats), EBelowHashiMinimum);

    event::emit(ExitRequested { vault_id: object::id(vault), who, amount_sats, addr_len });
    (pooled, addr)
}

/// Return a cancelled exit's `Balance<B>` to the vault and re-credit shares at the current NAV.
///
/// DEPOSITOR-ONLY (`assert_reclaim_caller`): the upstream cancel is sender-bound, so the only
/// party who can ever reach this is the depositor who signed the exit.
public(package) fun settle_reclaim<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    request_id: address,
    btc_back: Balance<B>,
    book_mid: u128,
    ctx: &TxContext,
) {
    assert_reclaim_caller(vault, who, ctx);

    let amount_sats = btc_back.value();
    vault::recredit(vault, who, btc_back, book_mid);

    event::emit(ExitReclaimed { vault_id: object::id(vault), who, request_id, amount_sats });
}

/// The depositor opts out of waiting for the pool to reach the bridge minimum and takes the
/// sub-minimum earmark back as hBTC on Sui instead. Instant, one checkpoint (G1) — no bridge
/// surface is involved, hence generic over the asset pair.
public fun take_pending_as_hbtc<B, Q>(vault: &mut Vault<B, Q>, ctx: &mut TxContext): Coin<B> {
    let who = ctx.sender();
    let pooled = vault::take_pending_exit(vault, who);
    let amount_sats = pooled.value();

    event::emit(PendingTakenAsHbtc { vault_id: object::id(vault), who, amount_sats });

    coin::from_balance(pooled, ctx)
}

// ── T1.3/T1.4: the bridge boundary (G7) ─────────────────────────────────────
// The three wrappers below are the ONLY code in the package that names the bridge. Each is a
// literal tail: stage, then thread the staged value into the upstream call. No branch, no
// guard and no state transition lives here (@invariant 7).

/// Composed, destination-pinned exit: burn shares -> split `Balance<BTC>` -> hand it to the
/// bridge with the address PINNED on-chain at registration (G2). ONE PTB, no wait (G1).
///
/// Sub-minimum proceeds are pooled by `stage_exit` and nothing is submitted (G3).
///
/// The ~1.5-2 h native-BTC latency happens entirely INSIDE the bridge AFTER this returns
/// (G1, G6) — nothing on the Sui side blocks.
public fun exit_to_bitcoin<Q>(
    vault: &mut Vault<BTC, Q>,
    hashi: &mut Hashi,
    shares_to_burn: u64,
    book_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let who = ctx.sender();
    let (btc, addr) = stage_exit(vault, who, shares_to_burn, book_mid, ctx);
    if (btc.is_some()) {
        withdraw::request_withdrawal(hashi, clock, btc.destroy_some(), addr, ctx);
    } else {
        btc.destroy_none();
    }
}

/// Flush `who`'s pooled small exits once they clear the bridge minimum.
///
/// ⚠ SELF-SERVICE ONLY — `stage_flush` asserts `who == ctx.sender()` (E-M8). Sponsored gas is
/// fine: sponsorship changes who PAYS, not who the sender is.
public fun flush_pending_exit<Q>(
    vault: &mut Vault<BTC, Q>,
    hashi: &mut Hashi,
    who: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (pooled, addr) = stage_flush(vault, who, ctx);
    withdraw::request_withdrawal(hashi, clock, pooled, addr, ctx);
}

/// Reclaim a stalled exit: cancel the bridge request and put the sats back in the vault.
///
/// ⚠ DEPOSITOR-CALLABLE ONLY. `hashi::withdraw::cancel_withdrawal` asserts
/// `request.sender == ctx.sender()` (RECON R7.3), so the keeper can build this PTB but can
/// NEVER sign it (G2). The upstream aborts — not-requester (`EUnauthorizedCancellation`),
/// post-commit (`ECannotCancelProcessingWithdrawal`) and cooldown-not-elapsed
/// (`ECooldownNotElapsed`) — SURFACE UNWRAPPED (G3): we neither retry, nor mask, nor pretend to
/// hold a queue position we do not control.
public fun reclaim_stalled_exit<Q>(
    vault: &mut Vault<BTC, Q>,
    hashi: &mut Hashi,
    request_id: address,
    book_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let who = ctx.sender();
    assert_reclaim_caller(vault, who, ctx);
    let btc_back = withdraw::cancel_withdrawal(hashi, request_id, clock, ctx);
    settle_reclaim(vault, who, request_id, btc_back, book_mid, ctx);
}

// ── test-only event readers ─────────────────────────────────────────────────
// Event struct fields are module-private, so move/tests/gateway_tests.move cannot read them
// without these. They compile out of the published package.

#[test_only]
public fun exit_address_registered_fields(e: &ExitAddressRegistered): (ID, address, u64) {
    (e.vault_id, e.who, e.addr_len)
}

#[test_only]
public fun exit_requested_fields(e: &ExitRequested): (ID, address, u64, u64) {
    (e.vault_id, e.who, e.amount_sats, e.addr_len)
}

#[test_only]
public fun exit_pooled_fields(e: &ExitPooled): (ID, address, u64, u64) {
    (e.vault_id, e.who, e.amount_sats, e.pooled_total_sats)
}

#[test_only]
public fun exit_reclaimed_fields(e: &ExitReclaimed): (ID, address, address, u64) {
    (e.vault_id, e.who, e.request_id, e.amount_sats)
}

#[test_only]
public fun pending_taken_as_hbtc_fields(e: &PendingTakenAsHbtc): (ID, address, u64) {
    (e.vault_id, e.who, e.amount_sats)
}
