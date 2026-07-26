module aphotic::allocate;

use std::string::{Self, String};
use std::type_name::{Self, TypeName};
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.allocate   (aphotic.md §11 "Phase 1 — vault": vault.move, caps.move, allocate.move)
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#5-architecture — "allocate.move  Pinned lending-adapter allowlist"
// @spec       aphotic.md#6.1 — AdminCap may call `set_adapter_allowlist`;
//               KeeperCap may call `allocate` / `deallocate`
// @spec       aphotic.md#10-invariants — "No KeeperCap function can move assets to an address
//               outside the pinned allowlist"
// @spec       aphotic-governance.md#4.1 — "restricted to a pinned allowlist of lending adapters,
//               so the keeper can route capital only through audited venues, never a malicious one"
// @spec       aphotic.md#7.7 / aphotic-governance.md §5 Table 2 — NAV leg
//               "Lending positions | adapter convert_to_assets(shares)"
// @rules      G7 (every id arrives as config — no venue id is hardcoded here)
//             G10 (sats u64 · E<Reason> errors · an event per externally-visible transition)
// @depends    (none — `allocate` is a LEAF of the aphotic package. It deliberately imports no
//               other aphotic module, and no lending package, so it can neither cycle nor pin
//               a venue at compile time. See @invariant 0.)
// @facts      MONEY UNIT = satoshis, u64 (aphotic.md §14: hBTC is 8-decimal, sats).
// @facts      An adapter is identified by a PAIR, never by an address alone:
// @facts        (adapter type `A`, venue object `ID`).  `A` is a phantom marker type published
// @facts        by the adapter package; the ID is the shared venue object it drives. Both must
// @facts        match an allowlist row or the route aborts.
// @facts      `std::type_name::get` is DEPRECATED in this framework rev — use
// @facts        `type_name::with_defining_ids<A>()` (MoveStdlib type_name.move:45,171).
// @facts      NO hBTC lending market exists on Sui testnet: Suilend / Navi / Scallop have no
// @facts        testnet deployment at all, and AlphaLend's 7 markets are testcoins + SUI. The
// @facts        counterparty Aphotic routes to on testnet is therefore OUR OWN package,
// @facts        `aphotic_lending::lending` (repo `lending/`) — see its module banner for the
// @facts        honesty disclosure. That is a fact about the venue, not about this registry:
// @facts        this registry pins whatever the AdminCap holder allows and nothing else.
// @external   THE ADAPTER CONTRACT (what an allowlisted adapter package MUST expose; enforced
//             socially at allowlist time, and mechanically by the ticket flow below):
//               public fun deposit(venue: &mut V, coin: Coin<BTC>, clock: &Clock,
//                   ctx: &mut TxContext): Coin<S>            // hBTC in  -> share units out
//               public fun withdraw(venue: &mut V, shares: Coin<S>, clock: &Clock,
//                   ctx: &mut TxContext): Coin<BTC>          // share units in -> hBTC out
//               public fun convert_to_assets(venue: &V, shares: u64): u64
//                                                            // share units -> REDEEMABLE sats
//             `aphotic_lending::lending` implements all three under exactly these names.
// @implements public fun create(ctx: &mut TxContext)                                    [DONE]
//             public fun new(ctx: &mut TxContext): (AdapterRegistry, AdapterAdminCap)   [DONE]
//             public fun share(registry: AdapterRegistry)                                [DONE]
//             ── governance (AdminCap only) ──
//             public fun allow_adapter<A>(cap: &AdapterAdminCap, reg: &mut AdapterRegistry,
//                 venue: ID, label: vector<u8>, cap_sats: u64, clock: &Clock)            [DONE]
//             public fun set_adapter_cap<A>(...)                                         [DONE]
//             public fun set_adapter_enabled<A>(...)                                     [DONE]
//             public fun remove_adapter<A>(...)                                          [DONE]
//             public fun set_paused(cap: &AdapterAdminCap, reg: &mut AdapterRegistry, bool) [DONE]
//             ── routing (package-internal: the vault gates these on KeeperCap) ──
//             public(package) fun begin_deposit<A>(reg, venue, sats): DepositTicket      [DONE]
//             public(package) fun finish_deposit(reg, t, shares_received, clock)         [DONE]
//             public(package) fun begin_withdraw<A>(reg, venue, shares, min_sats_out):
//                 WithdrawTicket                                                          [DONE]
//             public(package) fun finish_withdraw(reg, t, sats_received, clock)          [DONE]
//             public(package) fun mark<A>(reg, venue, assets_sats, clock)                [DONE]
//             ── reads (NAV) ──
//             public fun total_principal_sats / total_marked_assets_sats / adapter_count /
//                 adapter_key_at / is_allowed / is_enabled / venue_cap_sats /
//                 principal_sats / shares / last_assets_sats / last_marked_ms / label /
//                 is_paused / ticket_sats / ticket_shares / ticket_min_sats_out           [DONE]
//             public fun assert_fresh_mark<A>(reg, venue, clock, max_age_ms)              [DONE]
// @events     AdapterAllowed · AdapterRemoved · AdapterCapSet · AdapterEnabledSet ·
//             RegistryPausedSet · CapitalAllocated · CapitalDeallocated · AdapterMarked
// @errors     EWrongRegistry · EAdapterNotAllowed · EAdapterAlreadyAllowed · EAdapterDisabled ·
//             ERegistryPaused · EVenueCapExceeded · EZeroAmount · ENoSharesReceived ·
//             EInsufficientShares · EValueLoss · EAdapterStillFunded · EEmptyLabel · EStaleMark
// @forbidden  a `public` mutator of the accounting fields — the ticket pair and `mark` are
//             `public(package)` on purpose. If anyone could call `finish_deposit`, anyone could
//             book principal into the registry without moving a satoshi and corrupt the NAV leg.
// @forbidden  hardcoding ANY venue/package id in this file (G7). Venues arrive as `ID` arguments
//             and live only in the on-chain allowlist.
// @forbidden  `use aphotic::…` — this module is the leaf (see @invariant 0).
// @invariant  0. LEAF: `allocate` references no other aphotic module and no lending package.
//                Direction of dependency is allocate <- vault, never the reverse.
// @invariant  1. A route to a (type, venue) pair that is not in the allowlist ALWAYS aborts.
//                This is the Move half of aphotic.md §10 "no KeeperCap function can move assets
//                to an address outside the pinned allowlist".
// @invariant  2. Deployment is gated; RECALL IS NOT. `begin_withdraw` succeeds while the registry
//                is paused and while the entry is disabled — a kill switch that trapped capital
//                inside a venue we just declared unsafe would be worse than no kill switch.
// @invariant  3. `begin_deposit` aborts unless `principal_sats + sats <= cap_sats`, so a venue
//                can never hold more cost basis than the AdminCap holder pinned.
// @invariant  4. `finish_withdraw` aborts unless `sats_received >= min_sats_out` — the
//                value-preservation floor, on the allocation leg.
// @invariant  5. `remove_adapter` aborts while `principal_sats != 0` or `shares != 0`: an entry
//                can only be delisted after its capital is home, so the NAV leg can never
//                reference a row that no longer exists.
// @invariant  6. DepositTicket / WithdrawTicket are hot potatoes (no abilities): once a route is
//                begun it MUST be closed in the same transaction, so the registry can never
//                observe a half-booked allocation.
// @invariant  7. Any change of `principal_sats` or `shares` INVALIDATES the mark
//                (`last_marked_ms = 0`) and carries `last_assets_sats` at cost basis. A NAV pass
//                must therefore re-`mark` from the venue's own `convert_to_assets` before it can
//                recognise a satoshi of yield.
// @ac         move/tests/allocate_tests.move — every invariant above has a named test.
// @verify     sui move build
// @verify     sui move test allocate
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const EWrongRegistry: u64 = 1;
const EAdapterNotAllowed: u64 = 2;
const EAdapterAlreadyAllowed: u64 = 3;
const EAdapterDisabled: u64 = 4;
const ERegistryPaused: u64 = 5;
const EVenueCapExceeded: u64 = 6;
const EZeroAmount: u64 = 7;
const ENoSharesReceived: u64 = 8;
const EInsufficientShares: u64 = 9;
const EValueLoss: u64 = 10;
const EAdapterStillFunded: u64 = 11;
const EEmptyLabel: u64 = 12;
const EStaleMark: u64 = 13;

// ── arithmetic bound ────────────────────────────────────────────────────────
const MAX_U64: u64 = 18_446_744_073_709_551_615;

// ── structs ─────────────────────────────────────────────────────────────────

/// Governs the allowlist. Intended to be held by the SAME admin multisig that holds
/// `aphotic::caps::AdminCap` (aphotic.md §6.1 `set_adapter_allowlist`). It is a separate object
/// rather than a field on that cap so `allocate` stays a leaf and the two modules ship
/// independently; a registry is bound to exactly one cap at construction, so a foreign
/// `AdapterAdminCap` can never govern it.
public struct AdapterAdminCap has key, store {
    id: UID,
    registry_id: ID,
}

/// The allowlist key: an adapter marker type PLUS the venue object it drives. Neither half is
/// sufficient — the type alone would let the keeper point a vetted adapter at an attacker's
/// shared object, and the id alone would let it call a different entry point on the same object.
public struct AdapterKey has copy, drop, store {
    adapter: TypeName,
    venue: ID,
}

public struct AdapterEntry has store {
    label: String,
    enabled: bool,
    /// Ceiling on `principal_sats`, set by the AdminCap holder.
    cap_sats: u64,
    /// Cost basis currently at the venue: Σ deployed − Σ returned, floored at 0.
    principal_sats: u64,
    /// Adapter share units currently held by the vault for this venue.
    shares: u64,
    /// Last value reported for `convert_to_assets(shares)`, in sats.
    last_assets_sats: u64,
    /// `Clock` ms at which `last_assets_sats` was reported. `0` = invalidated / never marked.
    last_marked_ms: u64,
    added_at_ms: u64,
}

/// Shared object. The pinned allowlist and the vault's book of adapter positions.
public struct AdapterRegistry has key {
    id: UID,
    entries: Table<AdapterKey, AdapterEntry>,
    /// Enumeration order for a NAV pass. Mirrors `entries` exactly.
    keys: vector<AdapterKey>,
    total_principal_sats: u64,
    total_marked_assets_sats: u64,
    /// Kill switch for NEW deployment only — recall is never gated (@invariant 2).
    paused: bool,
}

// ── hot potatoes (no abilities: must be consumed in the same transaction) ────

public struct DepositTicket {
    registry: ID,
    key: AdapterKey,
    sats: u64,
}

public struct WithdrawTicket {
    registry: ID,
    key: AdapterKey,
    shares: u64,
    min_sats_out: u64,
}

// ── events ──────────────────────────────────────────────────────────────────

public struct AdapterAllowed has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    label: String,
    cap_sats: u64,
}

public struct AdapterRemoved has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
}

public struct AdapterCapSet has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    cap_sats: u64,
}

public struct AdapterEnabledSet has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    enabled: bool,
}

public struct RegistryPausedSet has copy, drop {
    registry: ID,
    paused: bool,
}

public struct CapitalAllocated has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    sats: u64,
    shares_received: u64,
    principal_sats: u64,
    at_ms: u64,
}

public struct CapitalDeallocated has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    shares: u64,
    sats_received: u64,
    principal_sats: u64,
    at_ms: u64,
}

public struct AdapterMarked has copy, drop {
    registry: ID,
    adapter: TypeName,
    venue: ID,
    shares: u64,
    assets_sats: u64,
    marked_at_ms: u64,
}

// ── construction ────────────────────────────────────────────────────────────

/// Build an unshared registry and the cap bound to it. Returned rather than shared so a
/// deployment PTB can inspect it first; `share` publishes it.
public fun new(ctx: &mut TxContext): (AdapterRegistry, AdapterAdminCap) {
    let registry = AdapterRegistry {
        id: object::new(ctx),
        entries: table::new(ctx),
        keys: vector[],
        total_principal_sats: 0,
        total_marked_assets_sats: 0,
        paused: false,
    };
    let cap = AdapterAdminCap {
        id: object::new(ctx),
        registry_id: object::id(&registry),
    };
    (registry, cap)
}

public fun share(registry: AdapterRegistry) {
    transfer::share_object(registry);
}

/// One-call bootstrap: share the registry, hand the cap to the caller (the admin multisig).
///
/// The self-transfer is the point, not an accident: the publisher IS the admin multisig at
/// genesis, and the cap has to land somewhere it can be spent from in the next transaction.
#[allow(lint(self_transfer))]
public fun create(ctx: &mut TxContext) {
    let (registry, cap) = new(ctx);
    share(registry);
    transfer::public_transfer(cap, ctx.sender());
}

// ── internal helpers ────────────────────────────────────────────────────────

fun saturating_sub(a: u64, b: u64): u64 {
    if (a > b) a - b else 0
}

/// Move `u64` addition ABORTS on overflow. Registry-wide totals are sums over independently
/// capped venues, so they are saturated rather than allowed to abort a NAV pass.
fun saturating_add(a: u64, b: u64): u64 {
    let sum = (a as u128) + (b as u128);
    if (sum > (MAX_U64 as u128)) MAX_U64 else (sum as u64)
}

fun key_of<A>(venue: ID): AdapterKey {
    AdapterKey { adapter: type_name::with_defining_ids<A>(), venue }
}

fun assert_cap(cap: &AdapterAdminCap, registry: &AdapterRegistry) {
    assert!(cap.registry_id == object::id(registry), EWrongRegistry);
}

fun assert_allowed_key(registry: &AdapterRegistry, key: AdapterKey) {
    assert!(registry.entries.contains(key), EAdapterNotAllowed);
}

// ── governance (AdminCap) ───────────────────────────────────────────────────

/// Pin `(A, venue)` as a routable lending adapter. Idempotent it is NOT: re-allowing an existing
/// pair aborts, so a cap change is always an explicit `set_adapter_cap`.
public fun allow_adapter<A>(
    cap: &AdapterAdminCap,
    registry: &mut AdapterRegistry,
    venue: ID,
    label: vector<u8>,
    cap_sats: u64,
    clock: &Clock,
) {
    assert_cap(cap, registry);
    assert!(!label.is_empty(), EEmptyLabel);
    let key = key_of<A>(venue);
    assert!(!registry.entries.contains(key), EAdapterAlreadyAllowed);
    let label = string::utf8(label);
    registry
        .entries
        .add(
            key,
            AdapterEntry {
                label,
                enabled: true,
                cap_sats,
                principal_sats: 0,
                shares: 0,
                last_assets_sats: 0,
                last_marked_ms: 0,
                added_at_ms: clock.timestamp_ms(),
            },
        );
    registry.keys.push_back(key);
    event::emit(AdapterAllowed {
        registry: object::id(registry),
        adapter: key.adapter,
        venue,
        label,
        cap_sats,
    });
}

/// Raise or lower the venue ceiling. Lowering below the deployed principal is ALLOWED and is the
/// intended way to wind a venue down: it blocks new deployment without trapping what is there.
public fun set_adapter_cap<A>(
    cap: &AdapterAdminCap,
    registry: &mut AdapterRegistry,
    venue: ID,
    cap_sats: u64,
) {
    assert_cap(cap, registry);
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow_mut(key).cap_sats = cap_sats;
    event::emit(AdapterCapSet {
        registry: object::id(registry),
        adapter: key.adapter,
        venue,
        cap_sats,
    });
}

public fun set_adapter_enabled<A>(
    cap: &AdapterAdminCap,
    registry: &mut AdapterRegistry,
    venue: ID,
    enabled: bool,
) {
    assert_cap(cap, registry);
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow_mut(key).enabled = enabled;
    event::emit(AdapterEnabledSet {
        registry: object::id(registry),
        adapter: key.adapter,
        venue,
        enabled,
    });
}

/// Delist. Aborts while any capital or any share unit is still at the venue (@invariant 5).
public fun remove_adapter<A>(cap: &AdapterAdminCap, registry: &mut AdapterRegistry, venue: ID) {
    assert_cap(cap, registry);
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    {
        let entry = registry.entries.borrow(key);
        assert!(entry.principal_sats == 0 && entry.shares == 0, EAdapterStillFunded);
    };
    let AdapterEntry {
        label: _,
        enabled: _,
        cap_sats: _,
        principal_sats: _,
        shares: _,
        last_assets_sats,
        last_marked_ms: _,
        added_at_ms: _,
    } = registry.entries.remove(key);
    registry.total_marked_assets_sats =
        saturating_sub(registry.total_marked_assets_sats, last_assets_sats);
    let (found, i) = registry.keys.index_of(&key);
    assert!(found, EAdapterNotAllowed);
    registry.keys.remove(i);
    event::emit(AdapterRemoved { registry: object::id(registry), adapter: key.adapter, venue });
}

/// Global kill switch for NEW deployment. Recall is deliberately unaffected (@invariant 2).
public fun set_paused(cap: &AdapterAdminCap, registry: &mut AdapterRegistry, paused: bool) {
    assert_cap(cap, registry);
    registry.paused = paused;
    event::emit(RegistryPausedSet { registry: object::id(registry), paused });
}

// ── routing ─────────────────────────────────────────────────────────────────
// `public(package)`: the vault holds the coins and the KeeperCap and is the only legitimate
// caller. See @forbidden.

/// Open a deployment leg. The returned hot potato must be closed by `finish_deposit` in the same
/// transaction, after the adapter's own `deposit` has actually returned share units.
///
/// `&mut` is deliberate even though this half of the leg only reads: it takes the registry
/// EXCLUSIVELY for the duration of the hot potato, so no second leg can open against the same
/// venue before `finish_deposit` closes this one. Weakening it to `&` would legalise that.
#[allow(unused_mut_parameter)]
public(package) fun begin_deposit<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    sats: u64,
): DepositTicket {
    assert!(!registry.paused, ERegistryPaused);
    assert!(sats > 0, EZeroAmount);
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    let entry = registry.entries.borrow(key);
    assert!(entry.enabled, EAdapterDisabled);
    // u128 on purpose: `principal + sats` in u64 would ABORT on overflow instead of reporting
    // `EVenueCapExceeded`, turning a governed refusal into an unreadable arithmetic error.
    assert!(
        (entry.principal_sats as u128) + (sats as u128) <= (entry.cap_sats as u128),
        EVenueCapExceeded,
    );
    DepositTicket { registry: object::id(registry), key, sats }
}

/// Close a deployment leg with the share units the adapter actually returned.
public(package) fun finish_deposit(
    registry: &mut AdapterRegistry,
    ticket: DepositTicket,
    shares_received: u64,
    clock: &Clock,
) {
    let DepositTicket { registry: registry_id, key, sats } = ticket;
    assert!(registry_id == object::id(registry), EWrongRegistry);
    assert!(shares_received > 0, ENoSharesReceived);
    assert_allowed_key(registry, key);
    let entry = registry.entries.borrow_mut(key);
    // Bounded by the `EVenueCapExceeded` check in `begin_deposit`, so this cannot overflow.
    entry.principal_sats = entry.principal_sats + sats;
    entry.shares = saturating_add(entry.shares, shares_received);
    // Cost basis carried; the mark is invalidated so no yield can be recognised without a
    // fresh read of the venue's own `convert_to_assets` (@invariant 7).
    entry.last_assets_sats = saturating_add(entry.last_assets_sats, sats);
    entry.last_marked_ms = 0;
    let principal_sats = entry.principal_sats;
    registry.total_principal_sats = saturating_add(registry.total_principal_sats, sats);
    registry.total_marked_assets_sats =
        saturating_add(registry.total_marked_assets_sats, sats);
    event::emit(CapitalAllocated {
        registry: registry_id,
        adapter: key.adapter,
        venue: key.venue,
        sats,
        shares_received,
        principal_sats,
        at_ms: clock.timestamp_ms(),
    });
}

/// Open a recall leg. Deliberately NOT gated on `paused` or `enabled` (@invariant 2).
/// `min_sats_out` is the value-preservation floor the closing call is held to.
///
/// `&mut` is deliberate — same exclusivity argument as `begin_deposit`.
#[allow(unused_mut_parameter)]
public(package) fun begin_withdraw<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    shares: u64,
    min_sats_out: u64,
): WithdrawTicket {
    assert!(shares > 0, EZeroAmount);
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    let entry = registry.entries.borrow(key);
    assert!(entry.shares >= shares, EInsufficientShares);
    WithdrawTicket { registry: object::id(registry), key, shares, min_sats_out }
}

/// Close a recall leg with the sats the adapter actually returned.
public(package) fun finish_withdraw(
    registry: &mut AdapterRegistry,
    ticket: WithdrawTicket,
    sats_received: u64,
    clock: &Clock,
) {
    let WithdrawTicket { registry: registry_id, key, shares, min_sats_out } = ticket;
    assert!(registry_id == object::id(registry), EWrongRegistry);
    assert!(sats_received >= min_sats_out, EValueLoss);
    assert_allowed_key(registry, key);
    let entry = registry.entries.borrow_mut(key);
    assert!(entry.shares >= shares, EInsufficientShares);
    entry.shares = entry.shares - shares;
    entry.principal_sats = saturating_sub(entry.principal_sats, sats_received);
    entry.last_assets_sats = saturating_sub(entry.last_assets_sats, sats_received);
    entry.last_marked_ms = 0;
    let principal_sats = entry.principal_sats;
    registry.total_principal_sats = saturating_sub(registry.total_principal_sats, sats_received);
    registry.total_marked_assets_sats =
        saturating_sub(registry.total_marked_assets_sats, sats_received);
    event::emit(CapitalDeallocated {
        registry: registry_id,
        adapter: key.adapter,
        venue: key.venue,
        shares,
        sats_received,
        principal_sats,
        at_ms: clock.timestamp_ms(),
    });
}

/// Record the venue's own `convert_to_assets(shares)` for the NAV pass. This is the ONLY place a
/// satoshi of adapter yield can enter the book, and it is `public(package)` so the vault can
/// require a `KeeperCap` for it (aphotic.md §6.2: the keeper PROPOSES, the admin APPROVES).
public(package) fun mark<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    assets_sats: u64,
    clock: &Clock,
) {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    let now_ms = clock.timestamp_ms();
    let entry = registry.entries.borrow_mut(key);
    let previous = entry.last_assets_sats;
    entry.last_assets_sats = assets_sats;
    entry.last_marked_ms = now_ms;
    let shares = entry.shares;
    registry.total_marked_assets_sats =
        saturating_add(saturating_sub(registry.total_marked_assets_sats, previous), assets_sats);
    event::emit(AdapterMarked {
        registry: object::id(registry),
        adapter: key.adapter,
        venue,
        shares,
        assets_sats,
        marked_at_ms: now_ms,
    });
}

// ── reads ───────────────────────────────────────────────────────────────────

/// NAV guard: abort unless this entry carries a mark no older than `max_age_ms`.
/// An invalidated mark (`last_marked_ms == 0`) always aborts.
public fun assert_fresh_mark<A>(
    registry: &AdapterRegistry,
    venue: ID,
    clock: &Clock,
    max_age_ms: u64,
) {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    let entry = registry.entries.borrow(key);
    assert!(entry.last_marked_ms != 0, EStaleMark);
    assert!(saturating_sub(clock.timestamp_ms(), entry.last_marked_ms) <= max_age_ms, EStaleMark);
}

public fun is_allowed<A>(registry: &AdapterRegistry, venue: ID): bool {
    registry.entries.contains(key_of<A>(venue))
}

public fun is_enabled<A>(registry: &AdapterRegistry, venue: ID): bool {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).enabled
}

public fun venue_cap_sats<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).cap_sats
}

public fun principal_sats<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).principal_sats
}

public fun shares<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).shares
}

public fun last_assets_sats<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).last_assets_sats
}

public fun last_marked_ms<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).last_marked_ms
}

public fun label<A>(registry: &AdapterRegistry, venue: ID): String {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).label
}

public fun added_at_ms<A>(registry: &AdapterRegistry, venue: ID): u64 {
    let key = key_of<A>(venue);
    assert_allowed_key(registry, key);
    registry.entries.borrow(key).added_at_ms
}

public fun total_principal_sats(registry: &AdapterRegistry): u64 {
    registry.total_principal_sats
}

public fun total_marked_assets_sats(registry: &AdapterRegistry): u64 {
    registry.total_marked_assets_sats
}

public fun is_paused(registry: &AdapterRegistry): bool {
    registry.paused
}

public fun adapter_count(registry: &AdapterRegistry): u64 {
    registry.keys.length()
}

/// `(adapter type, venue id)` at enumeration index `i` — the NAV pass walks this.
public fun adapter_key_at(registry: &AdapterRegistry, i: u64): (TypeName, ID) {
    let key = *registry.keys.borrow(i);
    (key.adapter, key.venue)
}

public fun admin_registry_id(cap: &AdapterAdminCap): ID {
    cap.registry_id
}

public fun ticket_sats(ticket: &DepositTicket): u64 {
    ticket.sats
}

public fun ticket_shares(ticket: &WithdrawTicket): u64 {
    ticket.shares
}

public fun ticket_min_sats_out(ticket: &WithdrawTicket): u64 {
    ticket.min_sats_out
}

// ── test-only surface ───────────────────────────────────────────────────────
// `allocate` is a leaf: no aphotic module exists yet that gates the routing calls on a
// `KeeperCap`, so the tests need the same `public(package)` entry points the vault will use.
// These wrappers are `#[test_only]` and are compiled out of every published build.

#[test_only]
public fun test_begin_deposit<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    sats: u64,
): DepositTicket {
    begin_deposit<A>(registry, venue, sats)
}

#[test_only]
public fun test_finish_deposit(
    registry: &mut AdapterRegistry,
    ticket: DepositTicket,
    shares_received: u64,
    clock: &Clock,
) {
    finish_deposit(registry, ticket, shares_received, clock)
}

#[test_only]
public fun test_begin_withdraw<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    shares: u64,
    min_sats_out: u64,
): WithdrawTicket {
    begin_withdraw<A>(registry, venue, shares, min_sats_out)
}

#[test_only]
public fun test_finish_withdraw(
    registry: &mut AdapterRegistry,
    ticket: WithdrawTicket,
    sats_received: u64,
    clock: &Clock,
) {
    finish_withdraw(registry, ticket, sats_received, clock)
}

#[test_only]
public fun test_mark<A>(
    registry: &mut AdapterRegistry,
    venue: ID,
    assets_sats: u64,
    clock: &Clock,
) {
    mark<A>(registry, venue, assets_sats, clock)
}
