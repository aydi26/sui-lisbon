module aphotic::events;

use sui::event;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.0
// @phase      1
// @status     DONE
// @spec       aphotic.md#2-hard-constraints (L47-L58)
// @spec       aphotic.md#10-invariants (L437-L471)
// @spec       aphotic-governance.md#4.2-invariants-enforced-in-move (L126-L131)
// @rules      G10 (an event for EVERY externally-visible state transition)
// @depends    (none — this module is the package LEAF. It imports sui::event and nothing else.)
// @facts      MAX_NUM_EVENT_EMIT = 1_024 events per TRANSACTION (protocol config, hard cap;
// @facts        it CANNOT be raised by paying more gas). Any per-order emission inside a batch
// @facts        clearing therefore bounds MAX_BATCH_SIZE. See aphotic::notes::max_spends_per_tx.
// @facts      OBJECT_RUNTIME_MAX_NUM_STORE_ENTRIES = 1_000 dynamic-field/store entries touched
// @facts        per transaction — the tighter of the two ceilings, and the one that governs the
// @facts        NullifierSet Table writes.
// @facts      MAX_GAS_COMPUTATION_BUCKET = 5_000_000 computation units, hard-capped regardless
// @facts        of the gas budget. A bigger budget buys storage, never computation.
// @facts      ⇒ per-fill events are DELIBERATELY ABSENT from aphotic::balance. Internal debits
// @facts        and credits during clearing are covered by the batch-level BatchSettled receipt
// @facts        plus the published fill Merkle root, which is what makes clearing verifiable
// @facts        without spending 1 event per participant.
// @external   (none)
// @implements public fun emit_caps_initialized(vault_id: ID, admin: address, keeper: address)
//             public fun emit_admin_transfer_initiated(vault_id: ID, from: address, to: address)
//             public fun emit_admin_transfer_cancelled(vault_id: ID, from: address, to: address)
//             public fun emit_admin_transfer_accepted(vault_id: ID, from: address, to: address,
//                 admin_epoch: u64)
//             public fun emit_keeper_cap_rotated(vault_id: ID, old_keeper: address,
//                 new_keeper: address, keeper_epoch: u64)
//             public fun emit_pause_set(vault_id: ID, paused: bool)
//             public fun emit_allowlist_updated(vault_id: ID, entry: address, allowed: bool,
//                 size_after: u64)
//             public fun emit_denominations_set(vault_id: ID, denoms_sats: vector<u64>)
//             public fun emit_note_committed(vault_id: ID, leaf_index: u64,
//                 commitment: vector<u8>, root: vector<u8>, denom_index: u8,
//                 outstanding_sats: u64)
//             public fun emit_note_spent(vault_id: ID, nullifier: vector<u8>, denom_index: u8,
//                 sats: u64, outstanding_sats: u64)
//             public fun emit_note_minted(vault_id: ID, note_id: ID, denom_index: u8)
//             public fun emit_note_burned(vault_id: ID, note_id: ID, denom_index: u8)
//             public fun emit_balance_topped_up(vault_id: ID, who: address, amount_sats: u64,
//                 balance_after_sats: u64)
//             public fun emit_balance_withdrawn(vault_id: ID, who: address, amount_sats: u64,
//                 balance_after_sats: u64)
//             ── forward-declared for the downstream vault / batch / clearing modules ──
//             public fun emit_nav_proposed(vault_id: ID, nav_sats: u64, at_ms: u64)
//             public fun emit_nav_approved(vault_id: ID, nav_sats: u64,
//                 previous_nav_sats: u64, at_ms: u64)
//             public fun emit_deposited(vault_id: ID, who: address, assets_sats: u64,
//                 shares: u64)
//             public fun emit_redeem_requested(vault_id: ID, who: address, shares: u64)
//             public fun emit_redeemed(vault_id: ID, who: address, shares: u64,
//                 assets_sats: u64)
//             public fun emit_batch_opened(vault_id: ID, batch_id: u64, close_at_ms: u64)
//             public fun emit_order_submitted(vault_id: ID, batch_id: u64, who: address,
//                 ciphertext_hash: vector<u8>)
//             public fun emit_batch_closed(vault_id: ID, batch_id: u64, orders: u64,
//                 closed_at_ms: u64)
//             public fun emit_batch_cleared(vault_id: ID, batch_id: u64, clearing_price: u64,
//                 matched_sats: u64, fill_root: vector<u8>)
//             public fun emit_batch_settled(vault_id: ID, batch_id: u64, debits_sats: u64,
//                 credits_sats: u64)
// @events     CapsInitialized · AdminTransferInitiated · AdminTransferCancelled
//             · AdminTransferAccepted · KeeperCapRotated · PauseSet · AllowlistUpdated
//             · DenominationsSet · NoteCommitted · NoteSpent · NoteMinted · NoteBurned
//             · BalanceToppedUp · BalanceWithdrawn
//             · NavProposed · NavApproved · Deposited · RedeemRequested · Redeemed
//             · BatchOpened · OrderSubmitted · BatchClosed · BatchCleared · BatchSettled
// @errors     (none — this module never aborts. It is a pure emission surface.)
// @forbidden  emitting an event struct declared anywhere OTHER than this module — every module
//             in the package emits through here, so the indexed event surface has ONE owner
// @forbidden  putting an order AMOUNT, SIDE or PRICE into any pre-close event — hard constraint
//             §2.3 (no order content readable before batch close)
// @forbidden  a per-fill event inside clearing — it would burn the 1_024-event ceiling and cap
//             the batch far below the store-entry limit (see @facts)
// @invariant  1. Every emitter here is TOTAL: no assert, no abort, no state. A state transition
//                can therefore never fail *because of* its receipt.
// @invariant  2. Emitters are `public`, so the type surface is stable for downstream modules
//                and for off-chain indexers. Forging an event of these types from outside the
//                package proves nothing on its own: every one of them is only meaningful when
//                read together with the object state it accompanies, which only this package
//                can write.
// @invariant  3. No event carries a note SECRET, a note RANDOMNESS, or a leaf INDEX at spend
//                time. The nullifier is emitted (that is its purpose); the leaf it retires is
//                not, or the spend would be linkable to its deposit.
// @ac         every `emit_*` used by aphotic::caps / notes / balance is asserted in the
//             corresponding *_tests.move via the `#[test_only]` field readers below
// @verify     sui move build
// @verify     sui move test
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── capability lifecycle (aphotic::caps) ────────────────────────────────────

public struct CapsInitialized has copy, drop {
    vault_id: ID,
    admin: address,
    keeper: address,
}

/// Step 1 of the two-step admin handover. Authority has NOT moved yet.
public struct AdminTransferInitiated has copy, drop {
    vault_id: ID,
    from: address,
    to: address,
}

public struct AdminTransferCancelled has copy, drop {
    vault_id: ID,
    from: address,
    to: address,
}

/// Step 2. `admin_epoch` is the value that makes every previously minted `AdminCap` stale.
public struct AdminTransferAccepted has copy, drop {
    vault_id: ID,
    from: address,
    to: address,
    admin_epoch: u64,
}

public struct KeeperCapRotated has copy, drop {
    vault_id: ID,
    old_keeper: address,
    new_keeper: address,
    keeper_epoch: u64,
}

public struct PauseSet has copy, drop {
    vault_id: ID,
    paused: bool,
}

public struct AllowlistUpdated has copy, drop {
    vault_id: ID,
    entry: address,
    allowed: bool,
    size_after: u64,
}

// ── notes (aphotic::notes) ──────────────────────────────────────────────────

public struct DenominationsSet has copy, drop {
    vault_id: ID,
    denoms_sats: vector<u64>,
}

/// A commitment appended to the note tree. Carries the denomination, which a fixed-ladder
/// deposit reveals anyway, and never the secret or the randomness.
public struct NoteCommitted has copy, drop {
    vault_id: ID,
    leaf_index: u64,
    commitment: vector<u8>,
    root: vector<u8>,
    denom_index: u8,
    outstanding_sats: u64,
}

/// A note retired. The nullifier is public by construction; the leaf index it retires is NOT
/// emitted, or the spend would be linkable to the deposit that funded it.
public struct NoteSpent has copy, drop {
    vault_id: ID,
    nullifier: vector<u8>,
    denom_index: u8,
    sats: u64,
    outstanding_sats: u64,
}

public struct NoteMinted has copy, drop {
    vault_id: ID,
    note_id: ID,
    denom_index: u8,
}

public struct NoteBurned has copy, drop {
    vault_id: ID,
    note_id: ID,
    denom_index: u8,
}

// ── persistent internal balances (aphotic::balance) ─────────────────────────

public struct BalanceToppedUp has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
    balance_after_sats: u64,
}

public struct BalanceWithdrawn has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
    balance_after_sats: u64,
}

// ── vault / batch / clearing (downstream modules emit through here) ─────────

public struct NavProposed has copy, drop {
    vault_id: ID,
    nav_sats: u64,
    at_ms: u64,
}

public struct NavApproved has copy, drop {
    vault_id: ID,
    nav_sats: u64,
    previous_nav_sats: u64,
    at_ms: u64,
}

public struct Deposited has copy, drop {
    vault_id: ID,
    who: address,
    assets_sats: u64,
    shares: u64,
}

public struct RedeemRequested has copy, drop {
    vault_id: ID,
    who: address,
    shares: u64,
}

public struct Redeemed has copy, drop {
    vault_id: ID,
    who: address,
    shares: u64,
    assets_sats: u64,
}

public struct BatchOpened has copy, drop {
    vault_id: ID,
    batch_id: u64,
    close_at_ms: u64,
}

/// Pre-close receipt. Carries the ciphertext hash and NOTHING else — no amount, no side,
/// no price (hard constraint §2.3).
public struct OrderSubmitted has copy, drop {
    vault_id: ID,
    batch_id: u64,
    who: address,
    ciphertext_hash: vector<u8>,
}

public struct BatchClosed has copy, drop {
    vault_id: ID,
    batch_id: u64,
    orders: u64,
    closed_at_ms: u64,
}

public struct BatchCleared has copy, drop {
    vault_id: ID,
    batch_id: u64,
    clearing_price: u64,
    matched_sats: u64,
    fill_root: vector<u8>,
}

/// Value preservation made observable: `debits_sats` must equal `credits_sats`, and the
/// settling transaction must abort otherwise (hard constraint §2.6).
public struct BatchSettled has copy, drop {
    vault_id: ID,
    batch_id: u64,
    debits_sats: u64,
    credits_sats: u64,
}

// ── emitters ────────────────────────────────────────────────────────────────

public fun emit_caps_initialized(vault_id: ID, admin: address, keeper: address) {
    event::emit(CapsInitialized { vault_id, admin, keeper });
}

public fun emit_admin_transfer_initiated(vault_id: ID, from: address, to: address) {
    event::emit(AdminTransferInitiated { vault_id, from, to });
}

public fun emit_admin_transfer_cancelled(vault_id: ID, from: address, to: address) {
    event::emit(AdminTransferCancelled { vault_id, from, to });
}

public fun emit_admin_transfer_accepted(
    vault_id: ID,
    from: address,
    to: address,
    admin_epoch: u64,
) {
    event::emit(AdminTransferAccepted { vault_id, from, to, admin_epoch });
}

public fun emit_keeper_cap_rotated(
    vault_id: ID,
    old_keeper: address,
    new_keeper: address,
    keeper_epoch: u64,
) {
    event::emit(KeeperCapRotated { vault_id, old_keeper, new_keeper, keeper_epoch });
}

public fun emit_pause_set(vault_id: ID, paused: bool) {
    event::emit(PauseSet { vault_id, paused });
}

public fun emit_allowlist_updated(vault_id: ID, entry: address, allowed: bool, size_after: u64) {
    event::emit(AllowlistUpdated { vault_id, entry, allowed, size_after });
}

public fun emit_denominations_set(vault_id: ID, denoms_sats: vector<u64>) {
    event::emit(DenominationsSet { vault_id, denoms_sats });
}

public fun emit_note_committed(
    vault_id: ID,
    leaf_index: u64,
    commitment: vector<u8>,
    root: vector<u8>,
    denom_index: u8,
    outstanding_sats: u64,
) {
    event::emit(NoteCommitted {
        vault_id,
        leaf_index,
        commitment,
        root,
        denom_index,
        outstanding_sats,
    });
}

public fun emit_note_spent(
    vault_id: ID,
    nullifier: vector<u8>,
    denom_index: u8,
    sats: u64,
    outstanding_sats: u64,
) {
    event::emit(NoteSpent { vault_id, nullifier, denom_index, sats, outstanding_sats });
}

public fun emit_note_minted(vault_id: ID, note_id: ID, denom_index: u8) {
    event::emit(NoteMinted { vault_id, note_id, denom_index });
}

public fun emit_note_burned(vault_id: ID, note_id: ID, denom_index: u8) {
    event::emit(NoteBurned { vault_id, note_id, denom_index });
}

public fun emit_balance_topped_up(
    vault_id: ID,
    who: address,
    amount_sats: u64,
    balance_after_sats: u64,
) {
    event::emit(BalanceToppedUp { vault_id, who, amount_sats, balance_after_sats });
}

public fun emit_balance_withdrawn(
    vault_id: ID,
    who: address,
    amount_sats: u64,
    balance_after_sats: u64,
) {
    event::emit(BalanceWithdrawn { vault_id, who, amount_sats, balance_after_sats });
}

public fun emit_nav_proposed(vault_id: ID, nav_sats: u64, at_ms: u64) {
    event::emit(NavProposed { vault_id, nav_sats, at_ms });
}

public fun emit_nav_approved(vault_id: ID, nav_sats: u64, previous_nav_sats: u64, at_ms: u64) {
    event::emit(NavApproved { vault_id, nav_sats, previous_nav_sats, at_ms });
}

public fun emit_deposited(vault_id: ID, who: address, assets_sats: u64, shares: u64) {
    event::emit(Deposited { vault_id, who, assets_sats, shares });
}

public fun emit_redeem_requested(vault_id: ID, who: address, shares: u64) {
    event::emit(RedeemRequested { vault_id, who, shares });
}

public fun emit_redeemed(vault_id: ID, who: address, shares: u64, assets_sats: u64) {
    event::emit(Redeemed { vault_id, who, shares, assets_sats });
}

public fun emit_batch_opened(vault_id: ID, batch_id: u64, close_at_ms: u64) {
    event::emit(BatchOpened { vault_id, batch_id, close_at_ms });
}

public fun emit_order_submitted(
    vault_id: ID,
    batch_id: u64,
    who: address,
    ciphertext_hash: vector<u8>,
) {
    event::emit(OrderSubmitted { vault_id, batch_id, who, ciphertext_hash });
}

public fun emit_batch_closed(vault_id: ID, batch_id: u64, orders: u64, closed_at_ms: u64) {
    event::emit(BatchClosed { vault_id, batch_id, orders, closed_at_ms });
}

public fun emit_batch_cleared(
    vault_id: ID,
    batch_id: u64,
    clearing_price: u64,
    matched_sats: u64,
    fill_root: vector<u8>,
) {
    event::emit(BatchCleared { vault_id, batch_id, clearing_price, matched_sats, fill_root });
}

public fun emit_batch_settled(vault_id: ID, batch_id: u64, debits_sats: u64, credits_sats: u64) {
    event::emit(BatchSettled { vault_id, batch_id, debits_sats, credits_sats });
}

// ── test-only field readers ─────────────────────────────────────────────────
// Event struct fields are module-private, so the *_tests.move suites cannot read an emitted
// receipt without these. They compile out of the published package.

#[test_only]
public fun caps_initialized_fields(e: &CapsInitialized): (ID, address, address) {
    (e.vault_id, e.admin, e.keeper)
}

#[test_only]
public fun admin_transfer_initiated_fields(e: &AdminTransferInitiated): (ID, address, address) {
    (e.vault_id, e.from, e.to)
}

#[test_only]
public fun admin_transfer_cancelled_fields(e: &AdminTransferCancelled): (ID, address, address) {
    (e.vault_id, e.from, e.to)
}

#[test_only]
public fun admin_transfer_accepted_fields(
    e: &AdminTransferAccepted,
): (ID, address, address, u64) {
    (e.vault_id, e.from, e.to, e.admin_epoch)
}

#[test_only]
public fun keeper_cap_rotated_fields(e: &KeeperCapRotated): (ID, address, address, u64) {
    (e.vault_id, e.old_keeper, e.new_keeper, e.keeper_epoch)
}

#[test_only]
public fun pause_set_fields(e: &PauseSet): (ID, bool) {
    (e.vault_id, e.paused)
}

#[test_only]
public fun allowlist_updated_fields(e: &AllowlistUpdated): (ID, address, bool, u64) {
    (e.vault_id, e.entry, e.allowed, e.size_after)
}

#[test_only]
public fun denominations_set_fields(e: &DenominationsSet): (ID, vector<u64>) {
    (e.vault_id, e.denoms_sats)
}

#[test_only]
public fun note_committed_fields(
    e: &NoteCommitted,
): (ID, u64, vector<u8>, vector<u8>, u8, u64) {
    (e.vault_id, e.leaf_index, e.commitment, e.root, e.denom_index, e.outstanding_sats)
}

#[test_only]
public fun note_spent_fields(e: &NoteSpent): (ID, vector<u8>, u8, u64, u64) {
    (e.vault_id, e.nullifier, e.denom_index, e.sats, e.outstanding_sats)
}

#[test_only]
public fun note_minted_fields(e: &NoteMinted): (ID, ID, u8) {
    (e.vault_id, e.note_id, e.denom_index)
}

#[test_only]
public fun note_burned_fields(e: &NoteBurned): (ID, ID, u8) {
    (e.vault_id, e.note_id, e.denom_index)
}

#[test_only]
public fun balance_topped_up_fields(e: &BalanceToppedUp): (ID, address, u64, u64) {
    (e.vault_id, e.who, e.amount_sats, e.balance_after_sats)
}

#[test_only]
public fun balance_withdrawn_fields(e: &BalanceWithdrawn): (ID, address, u64, u64) {
    (e.vault_id, e.who, e.amount_sats, e.balance_after_sats)
}
