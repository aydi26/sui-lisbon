module aphotic::vault;

use aphotic::envelope::EnvelopeParams;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.1, T1.2
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#module-vault (L120-L306)
// @spec       docs/BUILD-PLAN.md#T1.1-T1.2 (L78-L79)
// @spec       docs/FACTS.md#seal-walrus-zklogin (L245-L255)
// @rules      G1 G2 G9 G10
// @depends    aphotic::envelope (T4.1) — for the embedded EnvelopeParams value
// @facts      ALL amounts are SATOSHIS, u64. 1 share = 1 sat on the bootstrap deposit.
// @facts      hBTC = 8 decimals, symbol hBTC, fungible Coin (G1) — on-Sui moves settle in
// @facts        ONE checkpoint. Bitcoin/Guardian latency exists ONLY at mint/burn.
// @facts      DBUSDC = 6 decimals, type 0xf7152c05...::DBUSDC::DBUSDC (id lives in Move.toml /
// @facts        keeper config ONLY — this module is generic over it, G7).
// @facts      EXIT_ADDR_LEN in {20 (P2WPKH), 32 (P2TR)} — enforced in aphotic::gateway.
// @facts      NAV is valued at the DeepBook mid passed in by the caller, NEVER at a raw
// @facts        oracle price (G9 depeg defence). book_mid == 0 aborts EZeroNav.
// @facts      DEEPBOOK_PRICE_SCALING = 1_000_000_000 (DeepBook v3 FLOAT_SCALING). DeepBook
// @facts        prices satisfy `quote = base * price / 1e9`, so the quote leg of NAV is
// @facts        `quote_units * 1e9 / book_mid` sats. book_mid arrives as u128 from the caller
// @facts        (aphotic::router::book_mid, T1.5) — this module never reads the book itself.
// @facts      SEAL IDENTITY LAYOUT (must stay byte-identical to keeper/src/privacy/seal.ts
// @facts        `sealIdentity`): 40 bytes = 32-byte vault object id ‖ u64 version_epoch
// @facts        BIG-ENDIAN. Any other length aborts EBadIdentityNamespace.
// @facts      ⚠ GENERIC-VAULT DECISION: `Vault<phantom B, phantom Q>` (B = hBTC, Q = DBUSDC)
// @facts        rather than the concrete `Balance<BTC>` sketched in docs/MOVE-PACKAGE.md §3.1.
// @facts        Reason: naming the hBTC type here would require a `hashi` import in
// @facts        sources/vault.move and BREAK the G7 isolation gate. docs/BUILD-PLAN.md T1.1
// @facts        already specifies "Vault generic over asset pair". Only gateway.move
// @facts        instantiates B with the real hBTC coin type.
// @external   (none — vault is the leaf of state truth: sui framework + aphotic::envelope only.
//             It never imports DeepBook and never imports the bridge, G7.)
// @implements public fun create_vault<B, Q>(balance_manager_id: ID, pool_id: ID,
//                 strategy_ciphertext: vector<u8>, strategy_blob_id: vector<u8>,
//                 envelope: EnvelopeParams, keeper: address, ctx: &mut TxContext): VaultCap
//             public fun deposit_btc<B, Q>(vault: &mut Vault<B, Q>, coin_in: Coin<B>,
//                 book_mid: u128, ctx: &mut TxContext): u64
//             public(package) fun burn_shares_for_btc<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 shares_to_burn: u64, book_mid: u128, ctx: &mut TxContext): Balance<B>
//             public(package) fun recredit<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 btc_back: Balance<B>, book_mid: u128)
//             public(package) fun add_pending_exit<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 btc: Balance<B>)
//             public(package) fun take_pending_exit<B, Q>(vault: &mut Vault<B, Q>,
//                 who: address): Balance<B>
//             public(package) fun set_exit_address<B, Q>(vault: &mut Vault<B, Q>, who: address,
//                 addr: vector<u8>)                       // write-once; enforced in gateway (G2)
//             public fun nav_sats<B, Q>(vault: &Vault<B, Q>, book_mid: u128): u64
//             public fun free_btc_sats<B, Q>(vault: &Vault<B, Q>): u64
//             public fun idle_btc_value<B, Q>(vault: &Vault<B, Q>): u64
//             public fun total_pending_exit_sats<B, Q>(vault: &Vault<B, Q>): u64
//             public fun quote_value<B, Q>(vault: &Vault<B, Q>): u64
//             public fun total_shares<B, Q>(vault: &Vault<B, Q>): u64
//             public fun shares_of<B, Q>(vault: &Vault<B, Q>, who: address): u64
//             public fun has_depositor<B, Q>(vault: &Vault<B, Q>, who: address): bool
//             public fun pending_exit_sats<B, Q>(vault: &Vault<B, Q>, who: address): u64
//             public fun btc_exit_address<B, Q>(vault: &Vault<B, Q>, who: address): vector<u8>
//             public fun is_paused<B, Q>(vault: &Vault<B, Q>): bool
//             public fun owner<B, Q>(vault: &Vault<B, Q>): address
//             public fun keeper<B, Q>(vault: &Vault<B, Q>): address
//             public fun pool_id<B, Q>(vault: &Vault<B, Q>): ID
//             public fun balance_manager_id<B, Q>(vault: &Vault<B, Q>): ID
//             public fun version_epoch<B, Q>(vault: &Vault<B, Q>): u64
//             public fun strategy_blob_id<B, Q>(vault: &Vault<B, Q>): vector<u8>
//             public fun strategy_ciphertext<B, Q>(vault: &Vault<B, Q>): vector<u8>
//             public fun envelope_params<B, Q>(vault: &Vault<B, Q>): &EnvelopeParams
//             public fun envelope_params_mut<B, Q>(vault: &mut Vault<B, Q>,
//                 cap: &KeeperCap): &mut EnvelopeParams
//             entry fun seal_approve<B, Q>(id: vector<u8>, vault: &Vault<B, Q>, ctx: &TxContext)
//             public fun set_keeper<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap,
//                 new_keeper: address, ctx: &mut TxContext): KeeperCap
//             public fun set_paused<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap, paused: bool)
//             public fun set_envelope<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap,
//                 p: EnvelopeParams)
//             public fun update_strategy<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap,
//                 ciphertext: vector<u8>, blob_id: vector<u8>)
//             public fun emergency_withdraw<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap,
//                 amount: u64, ctx: &mut TxContext): Coin<B>
//             public fun assert_keeper<B, Q>(vault: &Vault<B, Q>, cap: &KeeperCap)
//             public fun keeper_cap_version_epoch(cap: &KeeperCap): u64
//             public fun vault_cap_vault_id(cap: &VaultCap): ID
//             fun mul_div(a: u64, b: u64, c: u64): u64      // widen to u128, assert c != 0, fits u64
// @events     VaultCreated { vault_id: ID, owner: address, keeper: address, pool_id: ID }
//             Deposited { vault_id: ID, who: address, deposit_sats: u64, shares_minted: u64,
//                 nav_after_sats: u64 }
//             SharesBurned { vault_id: ID, who: address, shares_burned: u64, btc_sats: u64 }
//             Recredited { vault_id: ID, who: address, btc_sats: u64, shares_recredited: u64 }
//             KeeperRotated { vault_id: ID, old_keeper: address, new_keeper: address,
//                 new_version_epoch: u64 }
//             Paused { vault_id: ID, paused: bool }
//             StrategyUpdated { vault_id: ID, blob_id: vector<u8>, version_epoch: u64 }
//             EnvelopeUpdated { vault_id: ID }
//             EmergencyWithdraw { vault_id: ID, amount: u64 }
//             ExitAddressPinned { vault_id: ID, who: address, addr_len: u64 }   [ADDED T1.1]
//             PendingExitPooled { vault_id: ID, who: address, amount_sats: u64,
//                 pooled_total_sats: u64 }                                       [ADDED T1.1]
//             PendingExitTaken { vault_id: ID, who: address, amount_sats: u64 }  [ADDED T1.1]
// @errors     ENotAuthorized · EZeroShares · EZeroDeposit · EInsufficientShares
//             · EPaused · EStaleVersionEpoch · EBadIdentityNamespace · ECapVaultMismatch
//             · EUnregisteredDepositor · EZeroNav
//             ADDED (T1.1, all G10-named): EOverflow (mul_div / NAV would not fit u64)
//             · EZeroRedemption (rounding drain: burning shares that redeem 0 sats)
//             · EInsufficientIdle (requested sats exceed the idle balance)
//             · EExitAddressAlreadySet (vault-level write-once defence in depth for G2)
//             · ENothingPending (take_pending_exit with an empty pool)
// @forbidden  any `hashi` module path in this file — G7, gates.ps1 g7 (this is WHY Vault is generic)
// @forbidden  any DeepBook import here — the BalanceManager is referenced by ID only; router
//             is the module that touches the book (§1.3 dependency graph)
// @forbidden  issuing DeepBook DepositCap/WithdrawCap to the keeper — TradeCap only (G2)
// @forbidden  `seal_approve` returning a bool — it MUST abort on denial (a successful dry-run
//             IS the authorization)
// @forbidden  valuing NAV at a raw oracle price instead of book_mid — G9
// @forbidden  ANY mutator for `Depositor.btc_exit_address` other than the write-once
//             `set_exit_address` — there is deliberately no setter a second write can reach (G2)
// @invariant  1. total_shares == sum of depositor.shares after every mutating call.
// @invariant  2. deposit_sats > 0 implies shares_minted > 0 (abort EZeroShares).
// @invariant  3. `pending_exit_sats` is an EARMARK against `idle_btc`, not a separate balance:
//                the coins stay in `idle_btc` until `take_pending_exit` splits them out.
//                Therefore envelope::deployable_sats MUST subtract the earmark before the buffer.
// @invariant  4. seal_approve aborts on any denial; it never returns a denial value.
// @invariant  5. version_epoch is monotonically non-decreasing; ONLY set_keeper bumps it.
// @invariant  6. Only VaultCap (owner) can emergency_withdraw; KeeperCap can never (G2).
// @invariant  7. book_mid == 0 aborts NAV math (EZeroNav).
// @invariant  8. btc_exit_address is written EXACTLY once per depositor; no path mutates it
//                afterwards (G2 anti-redirect). gateway re-checks it before calling in.
// @invariant  9. `paused` blocks deposits and every keeper action, but NEVER blocks a redemption
//                (burn_shares_for_btc) or the owner's emergency_withdraw — a paused vault must
//                still let depositors leave.
// @invariant 10. The pooled earmark is EXCLUDED from NAV and unspendable by anyone else:
//                `nav_sats` values `free_btc_sats = idle - total_pending_exit_sats`, and
//                burn / emergency_withdraw both spend only `free_btc_sats`. Counting the
//                earmark in NAV would revalue every surviving share upward at the exiting
//                depositor's expense, because their shares were burned when the exit pooled.
//                `total_pending_exit_sats == Σ depositor.pending_exit_sats` at all times.
// @ac         docs/MOVE-PACKAGE.md §8 vault_tests checklist (L629-L636)
// @verify     sui move build
// @verify     sui move test vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §3.7) ─────────────────────────────
// Code 1 was `ENotOwner`, thrown only by the removed owner emergency withdraw. The slot is left
// vacant rather than reused: an old client decoding abort 1 should find nothing, not a different
// meaning.
const ENotAuthorized: u64 = 2;
const EZeroShares: u64 = 3;
const EZeroDeposit: u64 = 4;
const EInsufficientShares: u64 = 5;
const EPaused: u64 = 6;
const EStaleVersionEpoch: u64 = 7;
const EBadIdentityNamespace: u64 = 8;
const ECapVaultMismatch: u64 = 9;
const EUnregisteredDepositor: u64 = 10;
const EZeroNav: u64 = 11;
// ── added at T1.1 (see @errors) ─────────────────────────────────────────────
const EOverflow: u64 = 12;
const EZeroRedemption: u64 = 13;
const EInsufficientIdle: u64 = 14;
const EExitAddressAlreadySet: u64 = 15;
const ENothingPending: u64 = 16;

// ── arithmetic / layout constants ───────────────────────────────────────────

/// `u64::MAX` widened, for the fits-in-u64 guards on the u128 intermediates.
const MAX_U64_U128: u128 = 18_446_744_073_709_551_615;

/// DeepBook v3 `FLOAT_SCALING`: prices satisfy `quote = base * price / 1e9`, hence the quote
/// leg of NAV is `quote_units * 1e9 / book_mid` sats. `book_mid` is supplied by the caller
/// (aphotic::router::book_mid) and is ALWAYS the DeepBook mid, never a raw oracle price (G9).
const DEEPBOOK_PRICE_SCALING: u128 = 1_000_000_000;

/// Seal identity layout — 32-byte vault object id ‖ big-endian u64 version epoch.
/// Byte-identical to `keeper/src/privacy/seal.ts::sealIdentity` (docs/FACTS.md#seal).
const SEAL_ID_VAULT_LEN: u64 = 32;
const SEAL_ID_EPOCH_LEN: u64 = 8;
const SEAL_IDENTITY_LEN: u64 = 40;

// ── structs (docs/MOVE-PACKAGE.md §3.1) ─────────────────────────────────────

/// The shared vault. One per strategy instance.
/// `B` = the hBTC coin type, `Q` = DBUSDC. Generic so this module never names the bridge (G7).
public struct Vault<phantom B, phantom Q> has key {
    id: UID,
    // ── share accounting (sats-denominated NAV; G1) ──
    total_shares: u64,
    /// hBTC held by the vault and NOT resting on DeepBook. Also holds the sats
    /// earmarked by `Depositor.pending_exit_sats` (see @invariant 3).
    idle_btc: Balance<B>,
    /// Σ of every `Depositor.pending_exit_sats`. These sats sit inside `idle_btc` but their
    /// shares are ALREADY burned, so they belong to the exiting depositors and are excluded
    /// from NAV and from anything the vault may spend (@invariant 10).
    total_pending_exit_sats: u64,
    /// Quote inventory held idle (not on the book).
    dbusdc: Balance<Q>,
    depositors: Table<address, Depositor>,
    // ── DeepBook custody (G2): referenced by ID only; the caps live in the BalanceManager ──
    balance_manager_id: ID,
    // ── strategy confidentiality (Seal) ──
    /// In-object ciphertext copy, so Walrus expiry degrades verifiability, not liveness.
    strategy_ciphertext: vector<u8>,
    /// Walrus blob id of the in-force ciphertext version (content-addressed, self-certifying).
    strategy_blob_id: vector<u8>,
    /// Seal identity version; bumped ONLY by set_keeper (rotation/revocation).
    version_epoch: u64,
    // ── access control ──
    owner: address,
    keeper: address,
    paused: bool,
    // ── envelope params (aphotic::envelope) ──
    envelope: EnvelopeParams,
    // ── config: external ids passed at creation, never hardcoded (G7/G9) ──
    pool_id: ID,
}

/// Per-depositor record, held in the vault's `depositors` Table (never a standalone object).
public struct Depositor has store {
    shares: u64,
    /// WRITE-ONCE. 20 bytes (P2WPKH) or 32 bytes (P2TR). Immutable after first set (G2).
    /// Empty vector means "unregistered".
    btc_exit_address: vector<u8>,
    /// Small-exit pool: sub-30_000-sat exits accumulate here as an EARMARK on `idle_btc`.
    pending_exit_sats: u64,
}

/// Owner capability — pause, rotate keeper, set params, emergency withdraw.
public struct VaultCap has key, store {
    id: UID,
    vault_id: ID,
}

/// Keeper capability — authorizes router entrypoints + journal::record for the registered
/// keeper. Grants NO fund movement (G2).
public struct KeeperCap has key, store {
    id: UID,
    vault_id: ID,
    version_epoch: u64,
}

// ── events (docs/MOVE-PACKAGE.md §3.6) ──────────────────────────────────────

public struct VaultCreated has copy, drop {
    vault_id: ID,
    owner: address,
    keeper: address,
    pool_id: ID,
}

public struct Deposited has copy, drop {
    vault_id: ID,
    who: address,
    deposit_sats: u64,
    shares_minted: u64,
    nav_after_sats: u64,
}

public struct SharesBurned has copy, drop {
    vault_id: ID,
    who: address,
    shares_burned: u64,
    btc_sats: u64,
}

public struct Recredited has copy, drop {
    vault_id: ID,
    who: address,
    btc_sats: u64,
    shares_recredited: u64,
}

public struct KeeperRotated has copy, drop {
    vault_id: ID,
    old_keeper: address,
    new_keeper: address,
    new_version_epoch: u64,
}

public struct Paused has copy, drop {
    vault_id: ID,
    paused: bool,
}

public struct StrategyUpdated has copy, drop {
    vault_id: ID,
    blob_id: vector<u8>,
    version_epoch: u64,
}

public struct EnvelopeUpdated has copy, drop {
    vault_id: ID,
}

public struct EmergencyWithdraw has copy, drop {
    vault_id: ID,
    amount: u64,
}

/// The write-once pin itself (G2). Only the LENGTH is emitted here — gateway emits the
/// depositor-facing `ExitAddressRegistered`; this is the state-transition receipt of the vault
/// record actually being written, so the pin can never happen silently (G10).
public struct ExitAddressPinned has copy, drop {
    vault_id: ID,
    who: address,
    addr_len: u64,
}

/// Sub-minimum exit added to the depositor's earmark. The sats stay inside `idle_btc`
/// (@invariant 3); only the earmark moves.
public struct PendingExitPooled has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
    pooled_total_sats: u64,
}

public struct PendingExitTaken has copy, drop {
    vault_id: ID,
    who: address,
    amount_sats: u64,
}

// ── checked arithmetic ──────────────────────────────────────────────────────

/// `a * b / c`, computed in u128 so the product never wraps, then narrowed.
/// `c == 0` is always a zero-NAV divide in this module, hence EZeroNav.
fun mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c != 0, EZeroNav);
    let result = ((a as u128) * (b as u128)) / (c as u128);
    assert!(result <= MAX_U64_U128, EOverflow);
    result as u64
}

// ── NAV (sats, valued at the DeepBook mid — G9) ─────────────────────────────

/// Base sats the vault may actually spend: idle hBTC MINUS the pooled small-exit earmark,
/// whose shares are already burned (@invariant 10).
public fun free_btc_sats<B, Q>(vault: &Vault<B, Q>): u64 {
    let idle = vault.idle_btc.value();
    assert!(idle >= vault.total_pending_exit_sats, EInsufficientIdle);
    idle - vault.total_pending_exit_sats
}

/// Net asset value of the vault in SATS, valued at the DeepBook mid handed in by the caller.
///
/// G9: `book_mid` is the DeepBook mid, never a raw Pyth price. This module never fetches a
/// price; valuation is the caller's input and therefore auditable in the PTB.
///
/// hBTC resting on DeepBook lives in the BalanceManager and is accounted by the router; the
/// vault values only what it custodies directly (free idle base + idle quote). The pooled
/// small-exit earmark is EXCLUDED: those shares were burned when the exit was pooled, so
/// counting the sats again would silently revalue every remaining share upward.
public fun nav_sats<B, Q>(vault: &Vault<B, Q>, book_mid: u128): u64 {
    let free = free_btc_sats(vault);
    let quote = vault.dbusdc.value();

    // A base-only vault has an EXACT sats NAV and needs no price at all: `book_mid`
    // converts the quote leg and nothing else. Asserting on it before this check
    // made a 100%-hBTC vault unvaluable whenever the book had no mid to quote —
    // which is the normal state of a pool nobody else makes a market on. The guard
    // still fires, but only where the value is actually load-bearing.
    if (quote == 0) return free;

    assert!(book_mid != 0, EZeroNav);
    let quote_in_sats = ((quote as u128) * DEEPBOOK_PRICE_SCALING) / book_mid;
    let total = (free as u128) + quote_in_sats;
    assert!(total <= MAX_U64_U128, EOverflow);
    total as u64
}

// ── constructor (docs/MOVE-PACKAGE.md §3.2) ─────────────────────────────────

/// Create and SHARE a vault. Returns the `VaultCap` to the caller, who becomes `owner`.
/// `version_epoch` starts at 0, `paused` is false, `total_shares` is 0.
///
/// The DeepBook `BalanceManager` is referenced by ID only: this module never imports DeepBook
/// and never holds a Deposit/WithdrawCap. The keeper is issued a DeepBook `TradeCap` in the
/// same PTB, and nothing else (G2).
public fun create_vault<B, Q>(
    balance_manager_id: ID,
    pool_id: ID,
    strategy_ciphertext: vector<u8>,
    strategy_blob_id: vector<u8>,
    envelope: EnvelopeParams,
    keeper: address,
    ctx: &mut TxContext,
): VaultCap {
    let owner = ctx.sender();
    let vault = Vault<B, Q> {
        id: object::new(ctx),
        total_shares: 0,
        idle_btc: balance::zero<B>(),
        total_pending_exit_sats: 0,
        dbusdc: balance::zero<Q>(),
        depositors: table::new<address, Depositor>(ctx),
        balance_manager_id,
        strategy_ciphertext,
        strategy_blob_id,
        version_epoch: 0,
        owner,
        keeper,
        paused: false,
        envelope,
        pool_id,
    };
    let vault_id = object::id(&vault);

    event::emit(VaultCreated { vault_id, owner, keeper, pool_id });

    transfer::share_object(vault);

    VaultCap { id: object::new(ctx), vault_id }
}

// ── share / NAV math (docs/MOVE-PACKAGE.md §3.3) ────────────────────────────

/// Deposit hBTC and mint shares pro rata.
///
/// Bootstrap (`total_shares == 0`): 1 share = 1 sat.
/// Otherwise: `shares = mul_div(deposit_sats, total_shares, nav_before_sats)`.
///
/// A non-zero deposit that would round to zero shares ABORTS (`EZeroShares`) rather than
/// silently donating the deposit to the existing holders.
public fun deposit_btc<B, Q>(
    vault: &mut Vault<B, Q>,
    coin_in: Coin<B>,
    book_mid: u128,
    ctx: &mut TxContext,
): u64 {
    assert!(!vault.paused, EPaused);
    let deposit_sats = coin_in.value();
    assert!(deposit_sats > 0, EZeroDeposit);

    // NAV BEFORE the incoming coin is joined — that is the price the new shares pay.
    let nav_before = nav_sats(vault, book_mid);
    let shares_minted = if (vault.total_shares == 0) {
        deposit_sats
    } else {
        assert!(nav_before > 0, EZeroNav);
        mul_div(deposit_sats, vault.total_shares, nav_before)
    };
    assert!(shares_minted > 0, EZeroShares);

    vault.idle_btc.join(coin_in.into_balance());
    vault.total_shares = vault.total_shares + shares_minted;

    let who = ctx.sender();
    ensure_depositor(vault, who);
    let depositor = vault.depositors.borrow_mut(who);
    depositor.shares = depositor.shares + shares_minted;

    let nav_after_sats = nav_sats(vault, book_mid);
    event::emit(Deposited {
        vault_id: object::id(vault),
        who,
        deposit_sats,
        shares_minted,
        nav_after_sats,
    });

    shares_minted
}

/// Burn `shares_to_burn` of `who` and split the sats they represent out of `idle_btc`.
///
/// Callable by the depositor's own flow or, composed, by `gateway::exit_to_bitcoin`.
/// Deliberately NOT blocked by `paused` (@invariant 9): a paused vault must still let
/// depositors leave.
public(package) fun burn_shares_for_btc<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    shares_to_burn: u64,
    book_mid: u128,
    _ctx: &mut TxContext,
): Balance<B> {
    assert!(shares_to_burn > 0, EZeroShares);
    assert!(vault.depositors.contains(who), EUnregisteredDepositor);
    assert!(vault.depositors.borrow(who).shares >= shares_to_burn, EInsufficientShares);

    let nav = nav_sats(vault, book_mid);
    assert!(nav > 0, EZeroNav);

    let btc_sats = mul_div(shares_to_burn, nav, vault.total_shares);
    // Rounding drain guard: never burn shares for nothing.
    assert!(btc_sats > 0, EZeroRedemption);
    // A redemption is never paid out of somebody else's pooled earmark.
    assert!(free_btc_sats(vault) >= btc_sats, EInsufficientIdle);

    let depositor = vault.depositors.borrow_mut(who);
    depositor.shares = depositor.shares - shares_to_burn;
    vault.total_shares = vault.total_shares - shares_to_burn;

    let out = vault.idle_btc.split(btc_sats);

    event::emit(SharesBurned { vault_id: object::id(vault), who, shares_burned: shares_to_burn, btc_sats });

    out
}

/// Return a previously-burned `Balance<B>` to idle and re-credit shares at the CURRENT NAV.
/// Used by `gateway::reclaim_stalled_exit` when the bridge cancels an exit.
public(package) fun recredit<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    btc_back: Balance<B>,
    book_mid: u128,
) {
    let btc_sats = btc_back.value();
    assert!(btc_sats > 0, EZeroDeposit);
    assert!(vault.depositors.contains(who), EUnregisteredDepositor);

    let nav_before = nav_sats(vault, book_mid);
    let shares_recredited = if (vault.total_shares == 0) {
        btc_sats
    } else {
        assert!(nav_before > 0, EZeroNav);
        mul_div(btc_sats, vault.total_shares, nav_before)
    };
    assert!(shares_recredited > 0, EZeroShares);

    vault.idle_btc.join(btc_back);
    vault.total_shares = vault.total_shares + shares_recredited;

    let depositor = vault.depositors.borrow_mut(who);
    depositor.shares = depositor.shares + shares_recredited;

    event::emit(Recredited { vault_id: object::id(vault), who, btc_sats, shares_recredited });
}

/// Pool a sub-minimum exit. The sats go BACK into `idle_btc` and only the depositor's
/// earmark grows — `pending_exit_sats` is an earmark, not a second balance (@invariant 3).
public(package) fun add_pending_exit<B, Q>(vault: &mut Vault<B, Q>, who: address, btc: Balance<B>) {
    let amount_sats = btc.value();
    assert!(amount_sats > 0, EZeroDeposit);
    assert!(vault.depositors.contains(who), EUnregisteredDepositor);

    vault.idle_btc.join(btc);
    vault.total_pending_exit_sats = vault.total_pending_exit_sats + amount_sats;

    let vault_id = object::id(vault);
    let depositor = vault.depositors.borrow_mut(who);
    depositor.pending_exit_sats = depositor.pending_exit_sats + amount_sats;
    let pooled_total_sats = depositor.pending_exit_sats;

    event::emit(PendingExitPooled { vault_id, who, amount_sats, pooled_total_sats });
}

/// Split the depositor's whole earmark back out of `idle_btc` and clear it.
public(package) fun take_pending_exit<B, Q>(vault: &mut Vault<B, Q>, who: address): Balance<B> {
    assert!(vault.depositors.contains(who), EUnregisteredDepositor);
    let amount_sats = vault.depositors.borrow(who).pending_exit_sats;
    assert!(amount_sats > 0, ENothingPending);
    assert!(vault.idle_btc.value() >= amount_sats, EInsufficientIdle);

    let depositor = vault.depositors.borrow_mut(who);
    depositor.pending_exit_sats = 0;
    vault.total_pending_exit_sats = vault.total_pending_exit_sats - amount_sats;

    let out = vault.idle_btc.split(amount_sats);

    event::emit(PendingExitTaken { vault_id: object::id(vault), who, amount_sats });

    out
}

/// WRITE-ONCE pin of the depositor's Bitcoin exit address (G2).
///
/// The depositor record is created on demand so an address can be pinned before the first
/// deposit. A second write ABORTS — there is deliberately no other path in this module that
/// touches `btc_exit_address`, which is the whole anti-redirect guarantee. `gateway` performs
/// the same check first, so a caller sees the gateway error code; this assert is defence in
/// depth against a future intra-package caller.
public(package) fun set_exit_address<B, Q>(
    vault: &mut Vault<B, Q>,
    who: address,
    addr: vector<u8>,
) {
    ensure_depositor(vault, who);
    let vault_id = object::id(vault);
    let depositor = vault.depositors.borrow_mut(who);
    assert!(depositor.btc_exit_address.is_empty(), EExitAddressAlreadySet);
    let addr_len = addr.length();
    depositor.btc_exit_address = addr;

    event::emit(ExitAddressPinned { vault_id, who, addr_len });
}

fun ensure_depositor<B, Q>(vault: &mut Vault<B, Q>, who: address) {
    if (!vault.depositors.contains(who)) {
        vault
            .depositors
            .add(who, Depositor { shares: 0, btc_exit_address: vector[], pending_exit_sats: 0 });
    }
}

// ── read helpers (no mutation) ──────────────────────────────────────────────

public fun idle_btc_value<B, Q>(vault: &Vault<B, Q>): u64 { vault.idle_btc.value() }

/// Σ of every depositor's pooled small-exit earmark. This is the
/// `earmarked_pending_exit_sats` argument `envelope::deployable_sats` subtracts BEFORE the
/// redemption buffer (@invariant 3 / envelope @invariant 6).
public fun total_pending_exit_sats<B, Q>(vault: &Vault<B, Q>): u64 {
    vault.total_pending_exit_sats
}

public fun quote_value<B, Q>(vault: &Vault<B, Q>): u64 { vault.dbusdc.value() }

public fun total_shares<B, Q>(vault: &Vault<B, Q>): u64 { vault.total_shares }

public fun has_depositor<B, Q>(vault: &Vault<B, Q>, who: address): bool {
    vault.depositors.contains(who)
}

/// 0 for an address that has never interacted — absence of a record is zero shares, not an error.
public fun shares_of<B, Q>(vault: &Vault<B, Q>, who: address): u64 {
    if (!vault.depositors.contains(who)) return 0;
    vault.depositors.borrow(who).shares
}

public fun pending_exit_sats<B, Q>(vault: &Vault<B, Q>, who: address): u64 {
    if (!vault.depositors.contains(who)) return 0;
    vault.depositors.borrow(who).pending_exit_sats
}

/// The PINNED exit destination (G2). Aborts for an address with no record; returns the empty
/// vector when the record exists but no address has been pinned yet (gateway maps that to
/// `EExitAddressUnset`).
public fun btc_exit_address<B, Q>(vault: &Vault<B, Q>, who: address): vector<u8> {
    assert!(vault.depositors.contains(who), EUnregisteredDepositor);
    vault.depositors.borrow(who).btc_exit_address
}

public fun is_paused<B, Q>(vault: &Vault<B, Q>): bool { vault.paused }

public fun owner<B, Q>(vault: &Vault<B, Q>): address { vault.owner }

public fun keeper<B, Q>(vault: &Vault<B, Q>): address { vault.keeper }

public fun pool_id<B, Q>(vault: &Vault<B, Q>): ID { vault.pool_id }

public fun balance_manager_id<B, Q>(vault: &Vault<B, Q>): ID { vault.balance_manager_id }

public fun version_epoch<B, Q>(vault: &Vault<B, Q>): u64 { vault.version_epoch }

public fun strategy_blob_id<B, Q>(vault: &Vault<B, Q>): vector<u8> { vault.strategy_blob_id }

public fun strategy_ciphertext<B, Q>(vault: &Vault<B, Q>): vector<u8> { vault.strategy_ciphertext }

public fun envelope_params<B, Q>(vault: &Vault<B, Q>): &EnvelopeParams { &vault.envelope }

/// Mutable envelope params for the keeper-gated pre-trade check (`envelope::check_action`
/// advances the epoch notional). Keeper-capability gated, so a stale or foreign cap cannot
/// reach it, and a paused vault blocks it outright.
public fun envelope_params_mut<B, Q>(
    vault: &mut Vault<B, Q>,
    cap: &KeeperCap,
): &mut EnvelopeParams {
    assert_keeper(vault, cap);
    &mut vault.envelope
}

public fun keeper_cap_version_epoch(cap: &KeeperCap): u64 { cap.version_epoch }

public fun vault_cap_vault_id(cap: &VaultCap): ID { cap.vault_id }

// ── Seal gate (docs/MOVE-PACKAGE.md §3.4) ───────────────────────────────────

/// Seal decryption gate. Each key server DRY-RUNS this before releasing a key share; a
/// successful dry-run IS the authorization, so every denial must ABORT (@invariant 4).
///
/// `id` is the 40-byte identity: 32-byte vault object id ‖ big-endian u64 version epoch.
/// Checks, in order:
///   1. `id` is well-formed and namespaced to THIS vault  -> EBadIdentityNamespace
///   2. the epoch component equals `vault.version_epoch`  -> EStaleVersionEpoch
///   3. sender is the owner or the registered keeper      -> ENotAuthorized
///
/// No mutation, no event (dry-run context).
entry fun seal_approve<B, Q>(id: vector<u8>, vault: &Vault<B, Q>, ctx: &TxContext) {
    check_seal_access(&id, vault, ctx.sender());
}

fun check_seal_access<B, Q>(id: &vector<u8>, vault: &Vault<B, Q>, sender: address) {
    assert!(id.length() == SEAL_IDENTITY_LEN, EBadIdentityNamespace);

    let vault_id_bytes = object::id(vault).to_bytes();
    let mut i = 0;
    while (i < SEAL_ID_VAULT_LEN) {
        assert!(*id.borrow(i) == *vault_id_bytes.borrow(i), EBadIdentityNamespace);
        i = i + 1;
    };

    let mut epoch: u64 = 0;
    let mut j = 0;
    while (j < SEAL_ID_EPOCH_LEN) {
        epoch = (epoch << 8) + (*id.borrow(SEAL_ID_VAULT_LEN + j) as u64);
        j = j + 1;
    };
    assert!(epoch == vault.version_epoch, EStaleVersionEpoch);

    assert!(sender == vault.owner || sender == vault.keeper, ENotAuthorized);
}

// ── owner / lifecycle (docs/MOVE-PACKAGE.md §3.5) ───────────────────────────

fun assert_vault_cap<B, Q>(vault: &Vault<B, Q>, cap: &VaultCap) {
    assert!(cap.vault_id == object::id(vault), ECapVaultMismatch);
}

/// Rotate the keeper. Bumps `version_epoch`, which invalidates every previously derived Seal
/// key share (a bare address swap would not — that is the whole point of the epoch) and makes
/// every outstanding `KeeperCap` stale. Returns the fresh cap for the new keeper.
public fun set_keeper<B, Q>(
    vault: &mut Vault<B, Q>,
    cap: &VaultCap,
    new_keeper: address,
    ctx: &mut TxContext,
): KeeperCap {
    assert_vault_cap(vault, cap);
    let old_keeper = vault.keeper;
    vault.keeper = new_keeper;
    vault.version_epoch = vault.version_epoch + 1;
    let vault_id = object::id(vault);

    event::emit(KeeperRotated {
        vault_id,
        old_keeper,
        new_keeper,
        new_version_epoch: vault.version_epoch,
    });

    KeeperCap { id: object::new(ctx), vault_id, version_epoch: vault.version_epoch }
}

public fun set_paused<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap, paused: bool) {
    assert_vault_cap(vault, cap);
    vault.paused = paused;
    event::emit(Paused { vault_id: object::id(vault), paused });
}

public fun set_envelope<B, Q>(vault: &mut Vault<B, Q>, cap: &VaultCap, p: EnvelopeParams) {
    assert_vault_cap(vault, cap);
    vault.envelope = p;
    event::emit(EnvelopeUpdated { vault_id: object::id(vault) });
}

/// Publish a new in-force strategy ciphertext + Walrus blob id. Does NOT bump `version_epoch`
/// — only a keeper rotation does (@invariant 5), so re-publishing does not revoke live shares.
public fun update_strategy<B, Q>(
    vault: &mut Vault<B, Q>,
    cap: &VaultCap,
    ciphertext: vector<u8>,
    blob_id: vector<u8>,
) {
    assert_vault_cap(vault, cap);
    vault.strategy_ciphertext = ciphertext;
    vault.strategy_blob_id = blob_id;
    event::emit(StrategyUpdated {
        vault_id: object::id(vault),
        blob_id: vault.strategy_blob_id,
        version_epoch: vault.version_epoch,
    });
}

// ── DELIBERATELY ABSENT: an owner emergency withdraw ────────────────────────────────────────
//
// Earlier revisions exposed `emergency_withdraw(vault, cap, amount, ctx): Coin<B>`, gated on the
// `VaultCap` AND the recorded owner. It is gone, on purpose, and must not come back.
//
// It protected nobody but the owner. Depositors can already redeem pro-rata WHILE THE VAULT IS
// PAUSED (see `redemption_still_works_while_paused`), so the honest failure path is: the owner
// calls `set_paused`, the keeper stops, and every depositor exits on their own. An owner
// withdraw adds no recovery capability for depositors — it only lets the owner leave first.
//
// Removing it upgrades the trust claim from "the KEEPER cannot steal or redirect" (G2) to
// "NOBODY can: not the keeper, not the owner". The only ways value leaves this vault are a
// depositor's own pro-rata redemption and `gateway::exit_to_bitcoin` to the write-once address
// pinned at deposit.
//
// The owner keeps exactly the powers that cannot move funds: `set_paused`, `set_keeper`
// (rotating the keeper invalidates its cap), `set_envelope` and `update_strategy`.

/// The keeper authorization used by `router` and `journal`. A cap from another vault, a cap
/// minted before the last rotation, or a paused vault all abort.
public fun assert_keeper<B, Q>(vault: &Vault<B, Q>, cap: &KeeperCap) {
    assert!(cap.vault_id == object::id(vault), ECapVaultMismatch);
    assert!(cap.version_epoch == vault.version_epoch, EStaleVersionEpoch);
    assert!(!vault.paused, EPaused);
}

// ── test-only helpers ───────────────────────────────────────────────────────
// These compile out of the published package. They exist so move/tests/vault_tests.move can
// drive the private `entry fun seal_approve`, assert the exact `mul_div` used by the share
// math, and stage quote inventory (nothing deposits DBUSDC until router settlement, T1.5).

#[test_only]
public fun seal_approve_for_testing<B, Q>(id: vector<u8>, vault: &Vault<B, Q>, ctx: &TxContext) {
    seal_approve(id, vault, ctx)
}

#[test_only]
public fun mul_div_for_testing(a: u64, b: u64, c: u64): u64 { mul_div(a, b, c) }

#[test_only]
public fun credit_quote_for_testing<B, Q>(vault: &mut Vault<B, Q>, q: Balance<Q>) {
    vault.dbusdc.join(q);
}

#[test_only]
public fun deepbook_price_scaling(): u128 { DEEPBOOK_PRICE_SCALING }

#[test_only]
public fun seal_identity_len(): u64 { SEAL_IDENTITY_LEN }
