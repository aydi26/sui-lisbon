module aphotic::caps;

use aphotic::events;
use sui::vec_set::{Self, VecSet};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.1
// @phase      1
// @status     DONE
// @spec       aphotic.md#6.1-capabilities (L279-L287)
// @spec       aphotic.md#6.2-nav-two-parties-not-two-scopes (L289-L296)
// @spec       aphotic.md#10-invariants (L463-L466)   <- the capability invariants
// @spec       aphotic-governance.md#4.1-capability-scoping (L109-L124)
// @spec       aphotic-governance.md#3-vault-administration (L95-L101)
// @rules      G10
// @depends    aphotic::events (T1.0)
// @facts      THREE capabilities, and no fourth:
// @facts        AdminCap  — admin multisig. approve_nav · set_fees · set_denominations
// @facts                    · set_cadence · rotate_keeper_cap · pause/unpause
// @facts                    · set_adapter_allowlist
// @facts        KeeperCap — keeper address. EXHAUSTIVE list of what it admits:
// @facts                    propose_nav · close_batch · settle_batch · allocate · deallocate
// @facts                    · place_carry_bid. NOTHING else. Encoded as ACTION_* below and
// @facts                    enforced by `assert_keeper_action`.
// @facts        VaultCap  — held by the vault OBJECT itself: internal note custody + settlement.
// @facts      ABILITY CHOICES ARE THE ENFORCEMENT, not a comment:
// @facts        AdminCap  has `key` ONLY (no `store`) ⇒ it can never be `public_transfer`d and
// @facts                  can never be wrapped. The ONLY way it moves is the two-step handover
// @facts                  below, which is what makes "explicit acceptance" unbypassable.
// @facts        KeeperCap has `key` ONLY ⇒ only `rotate_keeper_cap` can deliver one, so the
// @facts                  registry's `keeper` address is always the address that holds it.
// @facts        VaultCap  has `store` ONLY (no `key`) ⇒ it can NEVER be a top-level owned
// @facts                  object. It can only live inside another object — i.e. inside the
// @facts                  vault. No address can ever hold it.
// @facts        CapRegistry has `store` ONLY ⇒ it is embedded BY VALUE in the Vault. It is not
// @facts                  shareable, so two registries can never claim the same `vault_id`.
// @facts      EPOCHS: `admin_epoch` and `keeper_epoch` are monotonically increasing. A cap
// @facts        minted before the last rotation carries the OLD epoch and is rejected. This is
// @facts        the pattern recovered from the v1 vault's `set_keeper` / `assert_keeper`.
// @facts      MAX_ALLOWLIST = 32 pinned payout destinations. Small on purpose: the allowlist is
// @facts        a governance artefact, not a routing table.
// @external   (none — this module makes NO external calls and imports no upstream package.)
// @implements public fun new_registry(vault_id: ID, admin: address, keeper: address,
//                 ctx: &mut TxContext): (CapRegistry, VaultCap)
//             public fun initiate_admin_transfer(reg: &mut CapRegistry, cap: &AdminCap,
//                 new_admin: address)
//             public fun cancel_admin_transfer(reg: &mut CapRegistry, cap: &AdminCap)
//             public fun accept_admin_transfer(reg: &mut CapRegistry, ctx: &mut TxContext)
//             public fun rotate_keeper_cap(reg: &mut CapRegistry, cap: &AdminCap,
//                 new_keeper: address, ctx: &mut TxContext)
//             public fun set_paused(reg: &mut CapRegistry, cap: &AdminCap, paused: bool)
//             public fun allow_address(reg: &mut CapRegistry, cap: &AdminCap, entry: address)
//             public fun disallow_address(reg: &mut CapRegistry, cap: &AdminCap, entry: address)
//             public fun assert_admin(reg: &CapRegistry, cap: &AdminCap)
//             public fun assert_keeper(reg: &CapRegistry, cap: &KeeperCap)
//             public fun assert_keeper_action(reg: &CapRegistry, cap: &KeeperCap, action: u8)
//             public fun assert_vault_cap(reg: &CapRegistry, cap: &VaultCap)
//             public fun assert_allowed(reg: &CapRegistry, entry: address)
//             public fun is_allowed(reg: &CapRegistry, entry: address): bool
//             public fun vault_id / admin / keeper / admin_epoch / keeper_epoch / is_paused
//                 / pending_admin / allowlist_size / allowlist_entries  (&CapRegistry -> ..)
//             public fun admin_cap_vault_id / admin_cap_epoch  (&AdminCap -> ..)
//             public fun keeper_cap_vault_id / keeper_cap_epoch  (&KeeperCap -> ..)
//             public fun vault_cap_vault_id(cap: &VaultCap): ID
//             public fun action_propose_nav / action_close_batch / action_settle_batch
//                 / action_allocate / action_deallocate / action_place_carry_bid
//                 / keeper_action_count / max_allowlist (): u8|u64
//             public fun destroy_registry(reg: CapRegistry)
//             public fun destroy_vault_cap(cap: VaultCap)
// @events     CapsInitialized · AdminTransferInitiated · AdminTransferCancelled
//             · AdminTransferAccepted · KeeperCapRotated · PauseSet · AllowlistUpdated
//             (all declared in aphotic::events)
// @errors     ECapVaultMismatch · EStaleAdminEpoch · EStaleKeeperEpoch · ENoPendingTransfer
//             · ENotPendingAdmin · EPaused · EUnknownKeeperAction · ENotAllowlisted
//             · ETransferToSelf · EAlreadyPending · EAllowlistFull · ENotAllowlistedEntry
// @forbidden  ANY function here that takes `&KeeperCap` and mints, burns or rotates a
//             capability — invariant 2 below. There is exactly one cap-minting function per
//             cap type and all of them require `&AdminCap` or are the genesis constructor.
// @forbidden  giving AdminCap or KeeperCap the `store` ability — it would let a holder
//             `public_transfer` the cap and bypass the two-step handover outright
// @forbidden  giving VaultCap the `key` ability — it would let the vault's own settlement
//             authority escape to an address
// @forbidden  a `set_admin(address)` one-step setter — §3 of the governance note requires
//             explicit acceptance and there is deliberately no path that skips it
// @invariant  1. AdminCap transfer requires explicit acceptance: after `initiate_admin_transfer`
//                the incoming admin holds NOTHING, and only `accept_admin_transfer`, called by
//                that exact address, mints them a cap. (aphotic.md §10 Capabilities)
// @invariant  2. No `&KeeperCap` function in this module mints, burns or rotates a capability,
//                and none moves an asset — this module holds no asset at all.
// @invariant  3. A cap whose `vault_id` differs from the registry's is rejected
//                (ECapVaultMismatch), for all three cap types.
// @invariant  4. A rotated-out cap is rejected: `assert_admin` / `assert_keeper` compare the
//                cap's epoch against the registry's, and both epochs only ever increase.
// @invariant  5. `assert_keeper` fails while paused. Pausing is therefore a complete keeper
//                kill-switch and needs no per-function plumbing.
// @invariant  6. `assert_keeper_action` accepts EXACTLY the six actions of §6.1 and aborts on
//                any other discriminant, so "what KeeperCap admits" is enforced, not documented.
// @invariant  7. Accepting the handover bumps `admin_epoch`, which retires the OUTGOING admin's
//                cap in the same transaction. There is never a moment with two live AdminCaps.
// @ac         move/tests/caps_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test caps
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const ECapVaultMismatch: u64 = 1;
const EStaleAdminEpoch: u64 = 2;
const EStaleKeeperEpoch: u64 = 3;
const ENoPendingTransfer: u64 = 4;
const ENotPendingAdmin: u64 = 5;
const EPaused: u64 = 6;
const EUnknownKeeperAction: u64 = 7;
const ENotAllowlisted: u64 = 8;
const ETransferToSelf: u64 = 9;
const EAlreadyPending: u64 = 10;
const EAllowlistFull: u64 = 11;
const ENotAllowlistedEntry: u64 = 12;

// ── the EXHAUSTIVE keeper action set (aphotic.md §6.1) ──────────────────────
// Adding a discriminant here is a governance change, not a refactor: it widens what a
// compromised keeper key can do. `KEEPER_ACTION_COUNT` is the gate.
const ACTION_PROPOSE_NAV: u8 = 0;
const ACTION_CLOSE_BATCH: u8 = 1;
const ACTION_SETTLE_BATCH: u8 = 2;
const ACTION_ALLOCATE: u8 = 3;
const ACTION_DEALLOCATE: u8 = 4;
const ACTION_PLACE_CARRY_BID: u8 = 5;
const KEEPER_ACTION_COUNT: u8 = 6;

/// Pinned payout destinations. Deliberately small — a long allowlist is an un-auditable one.
const MAX_ALLOWLIST: u64 = 32;

// ── structs ─────────────────────────────────────────────────────────────────

/// The capability registry. `store` only, so it is embedded BY VALUE in the Vault and cannot
/// be shared standalone — which is what makes `vault_id` unforgeable.
public struct CapRegistry has store {
    vault_id: ID,
    admin: address,
    admin_epoch: u64,
    /// Set by step 1 of the handover, cleared by step 2 or by a cancel. While it is `some`,
    /// authority has NOT moved.
    pending_admin: Option<address>,
    keeper: address,
    keeper_epoch: u64,
    paused: bool,
    /// Pinned addresses a keeper-driven allocation may pay out to (§10 Capabilities).
    allowlist: VecSet<address>,
}

/// Admin multisig capability. `key` only: never transferable by the generic transfer
/// functions, never wrappable. It moves ONLY through the two-step handover.
public struct AdminCap has key {
    id: UID,
    vault_id: ID,
    admin_epoch: u64,
}

/// Keeper capability. `key` only, so `rotate_keeper_cap` is the sole issuer and the registry's
/// `keeper` address always names the holder.
public struct KeeperCap has key {
    id: UID,
    vault_id: ID,
    keeper_epoch: u64,
}

/// The vault's own capability, for internal note custody and settlement. `store` only: it has
/// no `key`, so it can never be a top-level owned object and no address can ever hold it.
public struct VaultCap has store {
    vault_id: ID,
}

// ── genesis ─────────────────────────────────────────────────────────────────

/// Mint the capability set for a vault. `vault_id` is the id of the `UID` the calling vault
/// module has just created, so the registry, the caps and the vault are bound at birth.
///
/// The `AdminCap` goes to `admin` and the `KeeperCap` to `keeper`; the `CapRegistry` and the
/// `VaultCap` are returned by value for the vault to embed. Neither has `key`, so the caller
/// has no way to do anything else with them.
public fun new_registry(
    vault_id: ID,
    admin: address,
    keeper: address,
    ctx: &mut TxContext,
): (CapRegistry, VaultCap) {
    let reg = CapRegistry {
        vault_id,
        admin,
        admin_epoch: 0,
        pending_admin: option::none(),
        keeper,
        keeper_epoch: 0,
        paused: false,
        allowlist: vec_set::empty(),
    };

    transfer::transfer(AdminCap { id: object::new(ctx), vault_id, admin_epoch: 0 }, admin);
    transfer::transfer(KeeperCap { id: object::new(ctx), vault_id, keeper_epoch: 0 }, keeper);

    events::emit_caps_initialized(vault_id, admin, keeper);

    (reg, VaultCap { vault_id })
}

// ── assertions (the whole authorization surface) ────────────────────────────

/// A cap from another vault, or one minted before the last acceptance, aborts.
public fun assert_admin(reg: &CapRegistry, cap: &AdminCap) {
    assert!(cap.vault_id == reg.vault_id, ECapVaultMismatch);
    assert!(cap.admin_epoch == reg.admin_epoch, EStaleAdminEpoch);
}

/// A cap from another vault, a rotated-out cap, or a paused vault all abort.
///
/// Pause is checked HERE rather than in each keeper entry point, so it is impossible to add a
/// keeper function that forgets it (@invariant 5). The admin path deliberately does NOT check
/// pause — an admin must be able to unpause.
public fun assert_keeper(reg: &CapRegistry, cap: &KeeperCap) {
    assert!(cap.vault_id == reg.vault_id, ECapVaultMismatch);
    assert!(cap.keeper_epoch == reg.keeper_epoch, EStaleKeeperEpoch);
    assert!(!reg.paused, EPaused);
}

/// `assert_keeper` plus the exhaustive action check. Every keeper-gated entry point in the
/// package declares its `ACTION_*` discriminant here, so §6.1's list is enforced rather than
/// merely written down (@invariant 6).
public fun assert_keeper_action(reg: &CapRegistry, cap: &KeeperCap, action: u8) {
    assert_keeper(reg, cap);
    assert!(action < KEEPER_ACTION_COUNT, EUnknownKeeperAction);
}

public fun assert_vault_cap(reg: &CapRegistry, cap: &VaultCap) {
    assert!(cap.vault_id == reg.vault_id, ECapVaultMismatch);
}

/// The pinned-allowlist gate (§10 Capabilities: "No KeeperCap function can move assets to an
/// address outside the pinned allowlist"). Every keeper-driven payout calls this with its
/// destination BEFORE moving value.
public fun assert_allowed(reg: &CapRegistry, entry: address) {
    assert!(reg.allowlist.contains(&entry), ENotAllowlisted);
}

public fun is_allowed(reg: &CapRegistry, entry: address): bool {
    reg.allowlist.contains(&entry)
}

// ── two-step admin handover (§3 of the governance note) ─────────────────────

/// Step 1. Nominates `new_admin`. Authority does NOT move: the current admin keeps a live cap
/// and `new_admin` holds nothing until they accept.
public fun initiate_admin_transfer(reg: &mut CapRegistry, cap: &AdminCap, new_admin: address) {
    assert_admin(reg, cap);
    assert!(new_admin != reg.admin, ETransferToSelf);
    assert!(reg.pending_admin.is_none(), EAlreadyPending);

    reg.pending_admin = option::some(new_admin);
    events::emit_admin_transfer_initiated(reg.vault_id, reg.admin, new_admin);
}

/// Withdraw a nomination. Only the sitting admin can, and only while one is outstanding.
public fun cancel_admin_transfer(reg: &mut CapRegistry, cap: &AdminCap) {
    assert_admin(reg, cap);
    assert!(reg.pending_admin.is_some(), ENoPendingTransfer);

    let to = reg.pending_admin.extract();
    events::emit_admin_transfer_cancelled(reg.vault_id, reg.admin, to);
}

/// Step 2. Callable ONLY by the nominated address, and it is the only path that changes
/// `reg.admin`. Bumps `admin_epoch`, which retires the outgoing admin's cap in the same
/// transaction (@invariant 7), and mints a fresh cap to the sender.
public fun accept_admin_transfer(reg: &mut CapRegistry, ctx: &mut TxContext) {
    assert!(reg.pending_admin.is_some(), ENoPendingTransfer);
    let to = reg.pending_admin.extract();
    let sender = ctx.sender();
    assert!(sender == to, ENotPendingAdmin);

    let from = reg.admin;
    reg.admin = sender;
    reg.admin_epoch = reg.admin_epoch + 1;

    transfer::transfer(
        AdminCap { id: object::new(ctx), vault_id: reg.vault_id, admin_epoch: reg.admin_epoch },
        sender,
    );

    events::emit_admin_transfer_accepted(reg.vault_id, from, sender, reg.admin_epoch);
}

// ── keeper rotation ─────────────────────────────────────────────────────────

/// Rotate the keeper. Bumps `keeper_epoch`, which makes EVERY outstanding `KeeperCap` stale —
/// including one held by a compromised key at an address the admin cannot reach — and delivers
/// a fresh cap to `new_keeper`.
///
/// Requires `&AdminCap`: a keeper can never rotate its own capability (@invariant 2).
public fun rotate_keeper_cap(
    reg: &mut CapRegistry,
    cap: &AdminCap,
    new_keeper: address,
    ctx: &mut TxContext,
) {
    assert_admin(reg, cap);

    let old_keeper = reg.keeper;
    reg.keeper = new_keeper;
    reg.keeper_epoch = reg.keeper_epoch + 1;

    transfer::transfer(
        KeeperCap {
            id: object::new(ctx),
            vault_id: reg.vault_id,
            keeper_epoch: reg.keeper_epoch,
        },
        new_keeper,
    );

    events::emit_keeper_cap_rotated(reg.vault_id, old_keeper, new_keeper, reg.keeper_epoch);
}

// ── admin lifecycle ─────────────────────────────────────────────────────────

/// Pause / unpause. Pausing is a complete keeper kill-switch (@invariant 5). Asymmetric
/// thresholds — cheap to pause, expensive to unpause, mirroring the bridge's own convention —
/// live in the admin MULTISIG policy, not here: Move sees one signed transaction either way.
public fun set_paused(reg: &mut CapRegistry, cap: &AdminCap, paused: bool) {
    assert_admin(reg, cap);
    reg.paused = paused;
    events::emit_pause_set(reg.vault_id, paused);
}

public fun allow_address(reg: &mut CapRegistry, cap: &AdminCap, entry: address) {
    assert_admin(reg, cap);
    assert!(reg.allowlist.length() < MAX_ALLOWLIST, EAllowlistFull);
    if (!reg.allowlist.contains(&entry)) {
        reg.allowlist.insert(entry);
    };
    events::emit_allowlist_updated(reg.vault_id, entry, true, reg.allowlist.length());
}

public fun disallow_address(reg: &mut CapRegistry, cap: &AdminCap, entry: address) {
    assert_admin(reg, cap);
    assert!(reg.allowlist.contains(&entry), ENotAllowlistedEntry);
    reg.allowlist.remove(&entry);
    events::emit_allowlist_updated(reg.vault_id, entry, false, reg.allowlist.length());
}

// ── read surface ────────────────────────────────────────────────────────────

public fun vault_id(reg: &CapRegistry): ID { reg.vault_id }

public fun admin(reg: &CapRegistry): address { reg.admin }

public fun keeper(reg: &CapRegistry): address { reg.keeper }

public fun admin_epoch(reg: &CapRegistry): u64 { reg.admin_epoch }

public fun keeper_epoch(reg: &CapRegistry): u64 { reg.keeper_epoch }

public fun is_paused(reg: &CapRegistry): bool { reg.paused }

public fun pending_admin(reg: &CapRegistry): Option<address> { reg.pending_admin }

public fun allowlist_size(reg: &CapRegistry): u64 { reg.allowlist.length() }

public fun allowlist_entries(reg: &CapRegistry): vector<address> { *reg.allowlist.keys() }

public fun admin_cap_vault_id(cap: &AdminCap): ID { cap.vault_id }

public fun admin_cap_epoch(cap: &AdminCap): u64 { cap.admin_epoch }

public fun keeper_cap_vault_id(cap: &KeeperCap): ID { cap.vault_id }

public fun keeper_cap_epoch(cap: &KeeperCap): u64 { cap.keeper_epoch }

public fun vault_cap_vault_id(cap: &VaultCap): ID { cap.vault_id }

// ── the action discriminants, exposed so callers never inline a magic number ──

public fun action_propose_nav(): u8 { ACTION_PROPOSE_NAV }

public fun action_close_batch(): u8 { ACTION_CLOSE_BATCH }

public fun action_settle_batch(): u8 { ACTION_SETTLE_BATCH }

public fun action_allocate(): u8 { ACTION_ALLOCATE }

public fun action_deallocate(): u8 { ACTION_DEALLOCATE }

public fun action_place_carry_bid(): u8 { ACTION_PLACE_CARRY_BID }

public fun keeper_action_count(): u8 { KEEPER_ACTION_COUNT }

public fun max_allowlist(): u64 { MAX_ALLOWLIST }

// ── teardown ────────────────────────────────────────────────────────────────
// Both are safe to expose: neither holds an asset, and obtaining either BY VALUE means the
// caller already dismantled the vault that owned it.

public fun destroy_registry(reg: CapRegistry) {
    let CapRegistry {
        vault_id: _,
        admin: _,
        admin_epoch: _,
        pending_admin: _,
        keeper: _,
        keeper_epoch: _,
        paused: _,
        allowlist: _,
    } = reg;
}

public fun destroy_vault_cap(cap: VaultCap) {
    let VaultCap { vault_id: _ } = cap;
}

// ── test-only helpers ───────────────────────────────────────────────────────
// A `key`-only cap cannot be destroyed by a test through any generic path, so the suite needs
// these. They compile out of the published package.

#[test_only]
public fun destroy_admin_cap_for_testing(cap: AdminCap) {
    let AdminCap { id, vault_id: _, admin_epoch: _ } = cap;
    id.delete();
}

#[test_only]
public fun destroy_keeper_cap_for_testing(cap: KeeperCap) {
    let KeeperCap { id, vault_id: _, keeper_epoch: _ } = cap;
    id.delete();
}

/// Mint a cap bound to a DIFFERENT vault, so the suite can prove a foreign cap is rejected.
#[test_only]
public fun forge_foreign_admin_cap_for_testing(vault_id: ID, ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx), vault_id, admin_epoch: 0 }
}

#[test_only]
public fun forge_foreign_keeper_cap_for_testing(vault_id: ID, ctx: &mut TxContext): KeeperCap {
    KeeperCap { id: object::new(ctx), vault_id, keeper_epoch: 0 }
}

#[test_only]
public fun forge_foreign_vault_cap_for_testing(vault_id: ID): VaultCap {
    VaultCap { vault_id }
}
