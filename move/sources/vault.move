module aphotic::vault;

use aphotic::balance::{Self as ledger, BalanceBook};
use aphotic::caps::{Self, CapRegistry, AdminCap, KeeperCap, VaultCap};
use aphotic::events;
use aphotic::notes::{Self, DenomLadder, NoteTree, NullifierSet, MembershipWitness};
use sui::balance::{Self, Balance};
use sui::bcs;
use sui::clock::Clock;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::hash;
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.2
// @phase      1
// @status     DONE
// @spec       aphotic.md#1-what-aphotic-is (L28-L33)
// @spec       aphotic.md#6.2-nav-two-parties-not-two-scopes (L289-L296)
// @spec       aphotic.md#7.7-nav (L389-L411)
// @spec       aphotic.md#8-fees (L415-L419)   <- LP shares are a FUNGIBLE Coin, not a position
// @spec       aphotic.md#10-invariants (L456-L461)  <- the NAV invariants
// @spec       docs/GOVERNANCE.md#5-nav-computation
// @spec       docs/DESIGN-V2.md#6-approve_nav-the-o1-form
// @rules      G10
// @depends    aphotic::caps · aphotic::events · aphotic::notes · aphotic::balance
// @facts      ASYNC REQUEST/SETTLE, ERC-7540 shaped. Four externally reachable legs:
// @facts        request_deposit -> DepositReceipt   (funds in, NO shares yet)
// @facts        request_redeem  -> RedeemReceipt    (shares in, NO assets yet)
// @facts        propose_nav  KeeperCap — records only, commits nothing
// @facts        approve_nav  AdminCap  — commits, prices BOTH pending legs at one price
// @facts        claim_deposit / claim_redeem — settle a receipt at its epoch's price
// @facts      TWO PARTIES, NOT TWO SCOPES (spec §6.2). The keeper cannot approve and the admin
// @facts        cannot propose; the share price moves only when both have acted. Enforced by
// @facts        the cap type on each function, not by a runtime role check.
// @facts      SHARES ARE A FUNGIBLE `Coin<S>` (spec §8: "fungible shares stay composable and
// @facts        listable; a bespoke position object traps the liquidity"). The vault holds the
// @facts        `TreasuryCap<S>` BY VALUE, so it is the only minter in the universe.
// @facts        ⚠ DEVIATION OF RECORD: the spec names the share type `APHOTIC_LP`. A Sui
// @facts        one-time witness must live in a module named after it (`aphotic::aphotic_lp`),
// @facts        which is outside this file. The share type is therefore a PHANTOM PARAMETER `S`
// @facts        and the vault takes custody of its `TreasuryCap<S>` at genesis — which is the
// @facts        property that actually matters and is strictly more general. `create` refuses a
// @facts        treasury whose supply is already non-zero (ELpSupplyNotZero), so
// @facts        `committed_supply` starts provably consistent.
// @facts      NAV LEGS (spec §7.7 / GOVERNANCE §5 Table 2), and their verifiability:
// @facts        idle_sats        — VERIFIED IN MOVE: must equal `base.value()` exactly
// @facts        deployed_sats    — attested (lending adapters); Sui-readable, admin-checkable
// @facts        in_flight_sats   — attested; Σ WithdrawalRequest.btc_amount, Sui-readable
// @facts        native_btc_sats  — attested; the BTC UTXO set is NOT readable by Move
// @facts        hashi_claims_sats— attested cumulative witness; the CAP on the leg above
// @facts        nav_assets = idle + deployed + in_flight + native_btc
// @facts      §7.7 MITIGATION 2 IS AN ASSERT, NOT A PARAGRAPH:
// @facts        native_btc_sats <= hashi_claims_sats                      (ENavLegUncapped)
// @facts        hashi_claims_sats is RATCHETED monotonic on-chain          (EClaimsRegressed)
// @facts        "The unverifiable component can never exceed the verifiable claim behind it."
// @facts      ESCROW IS DELIBERATELY OUTSIDE NAV (docs/DESIGN-V2.md F3 / GOVERNANCE §9 D-G1).
// @facts        `base_book`, `quote_book` and `note_custody` custody participant money in their
// @facts        OWN `Balance` fields. If escrow sat inside NAV, a batch settlement landing
// @facts        BETWEEN propose_nav and approve_nav would move the very number the admin is
// @facts        approving — and the two-party split would be defeated by the auction itself.
// @facts      MAX_NAV_JUMP_BPS default 500 (5 %) · MAX_PRICE_DEV_BPS default 200 (2 %)
// @facts        MAX_PROPOSAL_AGE_MS default 3_600_000 · UNPAUSE_DELAY_MS default 3_600_000
// @facts      NOTE_TREE_DEPTH = 20 (docs/DESIGN-V2.md §11: an append is 20 in-object hashes and
// @facts        ZERO dynamic-field entries, which is why the ladder fits the 1_000-entry wall).
// @facts      PAUSE ASYMMETRY, HONESTLY (DESIGN-V2 §7 / GOVERNANCE D-G4): Move cannot read a
// @facts        multisig threshold, so the SIGNER-count asymmetry is off-chain. What Move
// @facts        enforces here: `pause` is ONE transaction; `unpause` needs `arm_unpause` in an
// @facts        EARLIER transaction plus `unpause_delay_ms` elapsed.
// @facts      A PAUSED VAULT STILL LETS HOLDERS LEAVE: `request_redeem` and `claim_redeem` do
// @facts        not consult the pause flag. Only new money in is stopped.
// @external   (none — this module imports no upstream package. Hashi is reached only through
//             `aphotic::carry`, and DeepBook only through attested scalars.)
// @implements public fun create<B,Q,S>(lp_treasury, admin, keeper, fee_recipient, ctx): Vault
//             public fun share<B,Q,S>(v: Vault<B,Q,S>)
//             public fun request_deposit<B,Q,S>(v, hbtc: Coin<B>, ctx): DepositReceipt
//             public fun request_redeem<B,Q,S>(v, shares: Coin<S>, ctx): RedeemReceipt
//             public fun claim_deposit<B,Q,S>(v, r: DepositReceipt, ctx): Coin<S>
//             public fun claim_redeem<B,Q,S>(v, r: RedeemReceipt, ctx): Coin<B>
//             public fun propose_nav<B,Q,S>(v, cap: &KeeperCap, idle, deployed, in_flight,
//                 native_btc, hashi_claims, clearing_price, book_mid, clock, ctx)
//             public fun approve_nav<B,Q,S>(v, cap: &AdminCap, expected_digest, clock)
//             public fun proposal_digest(p: &NavProposal): vector<u8>
//             public fun pause / arm_unpause / unpause <B,Q,S>(v, cap: &AdminCap[, clock])
//             public fun set_nav_bounds / set_fee_params / set_min_deposit <B,Q,S>
//             public fun escrow_deposit_note<B,Q,S>(v, payment, denom_index, commitment): u64
//             public fun escrow_spend_note<B,Q,S>(v, witness, ctx): u64
//             public fun escrow_top_up_base / escrow_top_up_quote <B,Q,S>
//             public fun escrow_withdraw_base / escrow_withdraw_quote <B,Q,S>
// @events     NavProposed · NavApproved · Deposited · RedeemRequested · Redeemed · PauseSet
//             (all declared in aphotic::events; `Deposited` with shares == 0 is the REQUEST
//             leg, with shares > 0 the CLAIM leg — the vault declares no event struct of its own)
// @errors     ELpSupplyNotZero · EPaused · EZeroAmount · ENoProposal · EDigestMismatch
//             · EProposalStale · EProposalEpochMismatch · EIdleMismatch · ENavLegUncapped
//             · EClaimsRegressed · ENavJump · EPriceDeviation · ESolvency · ESupplyDrift
//             · ENotYetPriced · EVaultMismatch · EInsufficientAssets · ENotPaused
//             · EUnpauseNotArmed · EUnpauseTooEarly · EBadParam · EEscrowLocked
//             · EDenomMismatch · EOverflow · EBelowMinDeposit · ENoClearingActive
// @forbidden  an `address` PARAMETER on any KeeperCap-gated function — INV-C1 is enforced
//             structurally: `propose_nav` takes u64s, a clock and a ctx, and nothing else
// @forbidden  a public accessor returning `&VaultCap` — it would let anyone call
//             `balance::debit` on any account. The accessor is `public(package)`.
// @forbidden  counting `base_book` / `quote_book` / `note_custody` in nav_assets — DESIGN-V2 F3
// @forbidden  a management fee on AUM — spec §3. Fees accrue on matched volume (clearing) only.
// @invariant  1. `approve_nav` reverts if |nav/share − last| exceeds max_nav_jump_bps (ENavJump).
// @invariant  2. `approve_nav` reverts if the clearing price deviates from the DeepBook mid
//                beyond max_price_dev_bps (EPriceDeviation).
// @invariant  3. NAV attributed to the native-BTC leg never exceeds the on-Sui claim behind it
//                (ENavLegUncapped), and that witness can only ratchet up (EClaimsRegressed).
// @invariant  4. committed_supply × nav ≤ vault_assets after every approval (ESolvency), and
//                `coin::total_supply + unminted_shares == committed_supply` (ESupplyDrift).
//                `committed_supply` — not `total_supply` — is the correct denominator: total
//                supply undercounts owed-but-unminted shares and would let an over-mint pass.
// @invariant  5. Round-down pricing is subadditive, so Σ per-receipt claims ≤ the epoch total:
//                the dust stays with the vault and never with a claimant (no over-mint).
// @invariant  6. The keeper cannot approve and the admin cannot propose. Two PARTIES.
// @invariant  7. A paused vault still lets holders leave.
// @invariant  8. Escrow withdrawals are refused while a clearing is in flight, so a fill sized
//                against the ledger at load time is always coverable at settle time.
// @ac         move/tests/vault_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const ELpSupplyNotZero: u64 = 1;
const EPaused: u64 = 2;
const EZeroAmount: u64 = 3;
const ENoProposal: u64 = 4;
const EDigestMismatch: u64 = 5;
const EProposalStale: u64 = 6;
const EProposalEpochMismatch: u64 = 7;
const EIdleMismatch: u64 = 8;
const ENavLegUncapped: u64 = 9;
const EClaimsRegressed: u64 = 10;
const ENavJump: u64 = 11;
const EPriceDeviation: u64 = 12;
const ESolvency: u64 = 13;
const ESupplyDrift: u64 = 14;
const ENotYetPriced: u64 = 15;
const EVaultMismatch: u64 = 16;
const EInsufficientAssets: u64 = 17;
const ENotPaused: u64 = 18;
const EUnpauseNotArmed: u64 = 19;
const EUnpauseTooEarly: u64 = 20;
const EBadParam: u64 = 21;
const EEscrowLocked: u64 = 22;
const EDenomMismatch: u64 = 23;
const EOverflow: u64 = 24;
const EBelowMinDeposit: u64 = 25;
const ENoClearingActive: u64 = 26;

// ── governed defaults ───────────────────────────────────────────────────────
const BPS_DENOMINATOR: u64 = 10_000;
const MAX_U64: u128 = 18_446_744_073_709_551_615;

const DEFAULT_MAX_NAV_JUMP_BPS: u64 = 500;
const DEFAULT_MAX_PRICE_DEV_BPS: u64 = 200;
const DEFAULT_MAX_PROPOSAL_AGE_MS: u64 = 3_600_000;
const DEFAULT_UNPAUSE_DELAY_MS: u64 = 3_600_000;
const MIN_UNPAUSE_DELAY_MS: u64 = 600_000;
const DEFAULT_MIN_DEPOSIT_SATS: u64 = 1_000;
const DEFAULT_FEE_MATCHED_BPS: u64 = 10;
const MAX_FEE_MATCHED_BPS: u64 = 100;

/// docs/DESIGN-V2.md §11 — 20 levels is ~1.05 M notes, and an append is 20 hashes written
/// INSIDE the object, so it costs zero dynamic-field entries against the 1_000-entry wall.
const NOTE_TREE_DEPTH: u8 = 20;

// ── structs ─────────────────────────────────────────────────────────────────

/// Governed risk bounds. Every one of them is a reason `approve_nav` can revert.
public struct VaultParams has copy, drop, store {
    max_nav_jump_bps: u64,
    max_price_dev_bps: u64,
    max_proposal_age_ms: u64,
    unpause_delay_ms: u64,
    min_deposit_sats: u64,
}

/// What the keeper records and what the admin multisig signs. Copy/drop/store so the digest is
/// taken over the EXACT bytes both parties agree on.
public struct NavProposal has copy, drop, store {
    epoch: u64,
    idle_sats: u64,
    deployed_sats: u64,
    in_flight_sats: u64,
    native_btc_sats: u64,
    hashi_claims_sats: u64,
    clearing_price: u64,
    book_mid: u64,
    proposed_at_ms: u64,
    proposer: address,
}

/// The price an epoch settled at, kept forever so a receipt from any epoch can still be claimed.
public struct EpochPrice has copy, drop, store {
    nav_assets: u64,
    nav_supply: u64,
    at_ms: u64,
}

/// Async deposit claim. Bearer: whoever holds it claims the shares, which is what makes the
/// receipt itself composable.
public struct DepositReceipt has key, store {
    id: UID,
    vault_id: ID,
    epoch: u64,
    requester: address,
    assets_sats: u64,
}

public struct RedeemReceipt has key, store {
    id: UID,
    vault_id: ID,
    epoch: u64,
    requester: address,
    shares: u64,
}

/// `B` base asset (hBTC) · `Q` quote asset of the auction · `S` the LP share coin.
public struct Vault<phantom B, phantom Q, phantom S> has key {
    id: UID,
    caps: CapRegistry,
    vault_cap: VaultCap,
    lp_treasury: TreasuryCap<S>,
    // ── the NAV balance sheet ──
    base: Balance<B>,
    pending_deposit: Balance<B>,
    claimable: Balance<B>,
    redeem_escrow: Balance<S>,
    epoch: u64,
    last: EpochPrice,
    committed_supply: u64,
    unminted_shares: u64,
    pending_deposit_assets: u64,
    pending_redeem_shares: u64,
    epoch_prices: Table<u64, EpochPrice>,
    proposal: Option<NavProposal>,
    last_hashi_claims_sats: u64,
    deployed_sats: u64,
    in_flight_sats: u64,
    native_btc_sats: u64,
    // ── escrow: a SEPARATE balance sheet, never counted in NAV (DESIGN-V2 F3) ──
    base_book: BalanceBook<B>,
    quote_book: BalanceBook<Q>,
    note_custody: Balance<B>,
    ladder: DenomLadder,
    tree: NoteTree,
    nulls: NullifierSet,
    active_clearings: u64,
    // ── lifecycle ──
    params: VaultParams,
    unpause_armed_at_ms: Option<u64>,
    fee_recipient: address,
    fee_matched_bps: u64,
}

// ── integer helpers (u128 intermediate, u64 in and out) ─────────────────────

fun mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c > 0, EBadParam);
    let r = ((a as u128) * (b as u128)) / (c as u128);
    assert!(r <= MAX_U64, EOverflow);
    r as u64
}

fun checked_add(a: u64, b: u64): u64 {
    let r = (a as u128) + (b as u128);
    assert!(r <= MAX_U64, EOverflow);
    r as u64
}

fun abs_diff_u128(a: u128, b: u128): u128 {
    if (a >= b) a - b else b - a
}

fun default_params(): VaultParams {
    VaultParams {
        max_nav_jump_bps: DEFAULT_MAX_NAV_JUMP_BPS,
        max_price_dev_bps: DEFAULT_MAX_PRICE_DEV_BPS,
        max_proposal_age_ms: DEFAULT_MAX_PROPOSAL_AGE_MS,
        unpause_delay_ms: DEFAULT_UNPAUSE_DELAY_MS,
        min_deposit_sats: DEFAULT_MIN_DEPOSIT_SATS,
    }
}

// ── genesis ─────────────────────────────────────────────────────────────────

/// Mint the vault and its capability set in one transaction. The `TreasuryCap<S>` is consumed
/// BY VALUE: after this call nothing outside the vault can ever mint a share.
public fun create<B, Q, S>(
    lp_treasury: TreasuryCap<S>,
    admin: address,
    keeper: address,
    fee_recipient: address,
    ctx: &mut TxContext,
): Vault<B, Q, S> {
    assert!(coin::total_supply(&lp_treasury) == 0, ELpSupplyNotZero);

    let id = object::new(ctx);
    let vault_id = id.to_inner();
    let (caps_reg, vault_cap) = caps::new_registry(vault_id, admin, keeper, ctx);

    Vault {
        id,
        caps: caps_reg,
        vault_cap,
        lp_treasury,
        base: balance::zero<B>(),
        pending_deposit: balance::zero<B>(),
        claimable: balance::zero<B>(),
        redeem_escrow: balance::zero<S>(),
        epoch: 0,
        last: EpochPrice { nav_assets: 0, nav_supply: 0, at_ms: 0 },
        committed_supply: 0,
        unminted_shares: 0,
        pending_deposit_assets: 0,
        pending_redeem_shares: 0,
        epoch_prices: table::new<u64, EpochPrice>(ctx),
        proposal: option::none(),
        last_hashi_claims_sats: 0,
        deployed_sats: 0,
        in_flight_sats: 0,
        native_btc_sats: 0,
        base_book: ledger::new_book<B>(vault_id, ctx),
        quote_book: ledger::new_book<Q>(vault_id, ctx),
        note_custody: balance::zero<B>(),
        ladder: notes::new_ladder(vault_id),
        tree: notes::new_tree(vault_id, NOTE_TREE_DEPTH),
        nulls: notes::new_nullifier_set(vault_id, ctx),
        active_clearings: 0,
        params: default_params(),
        unpause_armed_at_ms: option::none(),
        fee_recipient,
        fee_matched_bps: DEFAULT_FEE_MATCHED_BPS,
    }
}

public fun share<B, Q, S>(v: Vault<B, Q, S>) {
    transfer::share_object(v);
}

fun assert_not_paused<B, Q, S>(v: &Vault<B, Q, S>) {
    assert!(!caps::is_paused(&v.caps), EPaused);
}

// ── async deposit ───────────────────────────────────────────────────────────

/// Funds enter. Shares are NOT minted — that happens at the next approved NAV, and the receipt
/// is what carries the claim across the boundary (ERC-7540 shape).
public fun request_deposit<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    hbtc: Coin<B>,
    ctx: &mut TxContext,
): DepositReceipt {
    assert_not_paused(v);
    let assets_sats = hbtc.value();
    assert!(assets_sats > 0, EZeroAmount);
    assert!(assets_sats >= v.params.min_deposit_sats, EBelowMinDeposit);

    v.pending_deposit.join(hbtc.into_balance());
    v.pending_deposit_assets = checked_add(v.pending_deposit_assets, assets_sats);

    let requester = ctx.sender();
    // shares == 0 marks the REQUEST leg; the CLAIM leg carries the minted count.
    events::emit_deposited(object::id(v), requester, assets_sats, 0);

    DepositReceipt {
        id: object::new(ctx),
        vault_id: object::id(v),
        epoch: v.epoch,
        requester,
        assets_sats,
    }
}

/// Settle a deposit receipt at the price its epoch was approved at.
///
/// Allowed while paused: the obligation was fixed when the admin approved the NAV, and refusing
/// to honour it would be a second, undisclosed pause.
public fun claim_deposit<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    receipt: DepositReceipt,
    ctx: &mut TxContext,
): Coin<S> {
    let DepositReceipt { id, vault_id, epoch, requester, assets_sats } = receipt;
    assert!(vault_id == object::id(v), EVaultMismatch);
    id.delete();
    assert!(epoch < v.epoch, ENotYetPriced);

    let price = *v.epoch_prices.borrow(epoch);
    let shares = mul_div(assets_sats, price.nav_supply, price.nav_assets);

    assert!(v.unminted_shares >= shares, ESupplyDrift);
    v.unminted_shares = v.unminted_shares - shares;

    events::emit_deposited(object::id(v), requester, assets_sats, shares);
    coin::mint(&mut v.lp_treasury, shares, ctx)
}

// ── async redeem ────────────────────────────────────────────────────────────

/// Shares are surrendered now and burned at the next approved NAV. Deliberately NOT
/// pause-gated: a paused vault still lets holders leave (@invariant 7).
public fun request_redeem<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    shares: Coin<S>,
    ctx: &mut TxContext,
): RedeemReceipt {
    let n = shares.value();
    assert!(n > 0, EZeroAmount);

    v.redeem_escrow.join(shares.into_balance());
    v.pending_redeem_shares = checked_add(v.pending_redeem_shares, n);

    let requester = ctx.sender();
    events::emit_redeem_requested(object::id(v), requester, n);

    RedeemReceipt { id: object::new(ctx), vault_id: object::id(v), epoch: v.epoch, requester, shares: n }
}

/// Also deliberately NOT pause-gated (@invariant 7).
public fun claim_redeem<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    receipt: RedeemReceipt,
    ctx: &mut TxContext,
): Coin<B> {
    let RedeemReceipt { id, vault_id, epoch, requester, shares } = receipt;
    assert!(vault_id == object::id(v), EVaultMismatch);
    id.delete();
    assert!(epoch < v.epoch, ENotYetPriced);

    let price = *v.epoch_prices.borrow(epoch);
    let assets_sats = mul_div(shares, price.nav_assets, price.nav_supply);
    assert!(v.claimable.value() >= assets_sats, EInsufficientAssets);

    events::emit_redeemed(object::id(v), requester, shares, assets_sats);
    coin::from_balance(v.claimable.split(assets_sats), ctx)
}

// ── NAV: the two-party split ────────────────────────────────────────────────

/// KEEPER leg. Records a valuation and commits absolutely nothing. Takes no `address`
/// parameter of any kind (INV-C1); the proposer is `ctx.sender()`.
///
/// A later proposal in the same epoch simply replaces an earlier one — the admin's digest check
/// is what pins which set of numbers is being approved.
public fun propose_nav<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    cap: &KeeperCap,
    idle_sats: u64,
    deployed_sats: u64,
    in_flight_sats: u64,
    native_btc_sats: u64,
    hashi_claims_sats: u64,
    clearing_price: u64,
    book_mid: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    caps::assert_keeper_action(&v.caps, cap, caps::action_propose_nav());

    let proposal = NavProposal {
        epoch: v.epoch,
        idle_sats,
        deployed_sats,
        in_flight_sats,
        native_btc_sats,
        hashi_claims_sats,
        clearing_price,
        book_mid,
        proposed_at_ms: clock.timestamp_ms(),
        proposer: ctx.sender(),
    };
    v.proposal = option::some(proposal);

    events::emit_nav_proposed(object::id(v), nav_assets_of(&proposal), proposal.proposed_at_ms);
}

/// The digest the admin multisig signs. Taken over the BCS of the exact proposal, so a keeper
/// cannot swap a different set of numbers in between the signature and the transaction.
public fun proposal_digest(p: &NavProposal): vector<u8> {
    hash::blake2b256(&bcs::to_bytes(p))
}

fun nav_assets_of(p: &NavProposal): u64 {
    checked_add(
        checked_add(p.idle_sats, p.deployed_sats),
        checked_add(p.in_flight_sats, p.native_btc_sats),
    )
}

/// ADMIN leg. Commits the valuation and prices BOTH pending legs at the one price.
///
/// O(1) by construction: it never iterates receipts. `object_runtime_max_num_store_entries`
/// is 1_000 per transaction, so a per-request loop would be a liveness bug waiting to happen.
public fun approve_nav<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    cap: &AdminCap,
    expected_digest: vector<u8>,
    clock: &Clock,
) {
    caps::assert_admin(&v.caps, cap);
    assert!(v.proposal.is_some(), ENoProposal);

    let p = *v.proposal.borrow();
    // 1. the admin signed these EXACT numbers
    assert!(proposal_digest(&p) == expected_digest, EDigestMismatch);
    // 2. and signed them recently
    let now_ms = clock.timestamp_ms();
    assert!(now_ms >= p.proposed_at_ms, EProposalStale);
    assert!(now_ms - p.proposed_at_ms <= v.params.max_proposal_age_ms, EProposalStale);
    // 3. for THIS epoch
    assert!(p.epoch == v.epoch, EProposalEpochMismatch);
    // 4. the one leg Move can check itself
    assert!(p.idle_sats == v.base.value(), EIdleMismatch);
    // 5. §7.7 mitigation 2 — the unverifiable leg is capped by the verifiable claim behind it
    assert!(p.native_btc_sats <= p.hashi_claims_sats, ENavLegUncapped);
    assert!(p.hashi_claims_sats >= v.last_hashi_claims_sats, EClaimsRegressed);

    let total_assets = nav_assets_of(&p);

    // 6. the two governed deviation bounds
    let (price_assets, price_supply) = if (v.committed_supply == 0) {
        // Bootstrap: no shares exist, so the first cohort prices at par.
        (1u64, 1u64)
    } else {
        (total_assets, v.committed_supply)
    };
    assert_nav_jump(v, price_assets, price_supply);
    assert_price_deviation(v, p.clearing_price, p.book_mid);

    // 7. price both legs at the SAME price, rounding DOWN on both (@invariant 5)
    let deposit_assets = v.pending_deposit_assets;
    let redeem_shares = v.pending_redeem_shares;
    let shares_to_mint = if (deposit_assets == 0) 0
        else mul_div(deposit_assets, price_supply, price_assets);
    let assets_to_release = if (redeem_shares == 0) 0
        else mul_div(redeem_shares, price_assets, price_supply);

    // 8. move the money
    let incoming = v.pending_deposit.withdraw_all();
    v.base.join(incoming);

    if (redeem_shares > 0) {
        let burned = v.redeem_escrow.withdraw_all();
        let burned_n = burned.value();
        assert!(burned_n == redeem_shares, ESupplyDrift);
        balance::decrease_supply(coin::supply_mut(&mut v.lp_treasury), burned);
        assert!(v.base.value() >= assets_to_release, EInsufficientAssets);
        let released = v.base.split(assets_to_release);
        v.claimable.join(released);
    };

    // 9. supply accounting
    v.committed_supply = checked_add(v.committed_supply, shares_to_mint);
    v.unminted_shares = checked_add(v.unminted_shares, shares_to_mint);
    assert!(v.committed_supply >= redeem_shares, ESupplyDrift);
    v.committed_supply = v.committed_supply - redeem_shares;

    // 10. publish the epoch price and roll
    let price = EpochPrice { nav_assets: price_assets, nav_supply: price_supply, at_ms: now_ms };
    v.epoch_prices.add(v.epoch, price);
    let previous_nav = v.last.nav_assets;
    v.last = price;
    v.epoch = v.epoch + 1;
    v.pending_deposit_assets = 0;
    v.pending_redeem_shares = 0;
    v.deployed_sats = p.deployed_sats;
    v.in_flight_sats = p.in_flight_sats;
    v.native_btc_sats = p.native_btc_sats;
    v.last_hashi_claims_sats = p.hashi_claims_sats;
    v.proposal = option::none();

    // 11. the two solvency identities (@invariant 4)
    assert_solvent(v);

    events::emit_nav_approved(object::id(v), total_assets, previous_nav, now_ms);
}

/// `|nav/share − last_nav/share| / last` in bps. Skipped only at bootstrap, when there is no
/// previous price to deviate from.
fun assert_nav_jump<B, Q, S>(v: &Vault<B, Q, S>, price_assets: u64, price_supply: u64) {
    if (v.last.nav_supply == 0 || v.last.nav_assets == 0) return;
    if (price_supply == 0 || price_assets == 0) return;

    // cross-multiply: |pa*ls − la*ps| * 10_000 <= bound * la * ps
    let lhs = abs_diff_u128(
        (price_assets as u128) * (v.last.nav_supply as u128),
        (v.last.nav_assets as u128) * (price_supply as u128),
    ) * (BPS_DENOMINATOR as u128);
    let rhs =
        (v.params.max_nav_jump_bps as u128)
            * (v.last.nav_assets as u128)
            * (price_supply as u128);
    assert!(lhs <= rhs, ENavJump);
}

/// The auction's clearing price is bounded against the DeepBook mid. A zero on either side
/// means "no reference this epoch" — an empty book is a defined state (RECON: the hBTC book is
/// empty on both sides and `mid_price` aborts), not a reason to brick the vault.
fun assert_price_deviation<B, Q, S>(v: &Vault<B, Q, S>, clearing_price: u64, book_mid: u64) {
    if (clearing_price == 0 || book_mid == 0) return;
    let lhs = abs_diff_u128(clearing_price as u128, book_mid as u128) * (BPS_DENOMINATOR as u128);
    let rhs = (v.params.max_price_dev_bps as u128) * (book_mid as u128);
    assert!(lhs <= rhs, EPriceDeviation);
}

/// `committed_supply × nav ≤ vault_assets`, plus the supply-drift identity.
///
/// `claimable` is excluded from assets on purpose: those shares are already burned, so the
/// balance is owed to redeemers and is no longer backing anybody's share.
public fun assert_solvent<B, Q, S>(v: &Vault<B, Q, S>) {
    let assets = nav_assets(v);
    if (v.last.nav_supply > 0) {
        let owed =
            ((v.committed_supply as u128) * (v.last.nav_assets as u128))
                / (v.last.nav_supply as u128);
        assert!(owed <= (assets as u128), ESolvency);
    };
    assert!(
        checked_add(coin::total_supply(&v.lp_treasury), v.unminted_shares) == v.committed_supply,
        ESupplyDrift,
    );
}

/// The NAV balance sheet. Escrow (`base_book`, `quote_book`, `note_custody`) is NOT here —
/// DESIGN-V2 F3 — and neither is `pending_deposit`, which has not been priced yet.
public fun nav_assets<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    checked_add(
        checked_add(v.base.value(), v.deployed_sats),
        checked_add(v.in_flight_sats, v.native_btc_sats),
    )
}

// ── lifecycle: pause is cheap, unpause is expensive ─────────────────────────

/// One transaction.
public fun pause<B, Q, S>(v: &mut Vault<B, Q, S>, cap: &AdminCap) {
    caps::set_paused(&mut v.caps, cap, true);
    v.unpause_armed_at_ms = option::none();
}

/// Step 1 of resuming. Records the instant; changes nothing else.
public fun arm_unpause<B, Q, S>(v: &mut Vault<B, Q, S>, cap: &AdminCap, clock: &Clock) {
    caps::assert_admin(&v.caps, cap);
    assert!(caps::is_paused(&v.caps), ENotPaused);
    v.unpause_armed_at_ms = option::some(clock.timestamp_ms());
}

/// Step 2, and only after `unpause_delay_ms` has elapsed since step 1.
public fun unpause<B, Q, S>(v: &mut Vault<B, Q, S>, cap: &AdminCap, clock: &Clock) {
    caps::assert_admin(&v.caps, cap);
    assert!(caps::is_paused(&v.caps), ENotPaused);
    assert!(v.unpause_armed_at_ms.is_some(), EUnpauseNotArmed);
    let armed_at = *v.unpause_armed_at_ms.borrow();
    let now = clock.timestamp_ms();
    assert!(now >= armed_at, EUnpauseTooEarly);
    assert!(now - armed_at >= v.params.unpause_delay_ms, EUnpauseTooEarly);

    caps::set_paused(&mut v.caps, cap, false);
    v.unpause_armed_at_ms = option::none();
}

// ── governed parameters ─────────────────────────────────────────────────────

public fun set_nav_bounds<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    cap: &AdminCap,
    max_nav_jump_bps: u64,
    max_price_dev_bps: u64,
    max_proposal_age_ms: u64,
) {
    caps::assert_admin(&v.caps, cap);
    assert!(max_nav_jump_bps > 0 && max_nav_jump_bps <= BPS_DENOMINATOR, EBadParam);
    assert!(max_price_dev_bps > 0 && max_price_dev_bps <= BPS_DENOMINATOR, EBadParam);
    assert!(max_proposal_age_ms > 0, EBadParam);
    v.params.max_nav_jump_bps = max_nav_jump_bps;
    v.params.max_price_dev_bps = max_price_dev_bps;
    v.params.max_proposal_age_ms = max_proposal_age_ms;
}

public fun set_unpause_delay<B, Q, S>(v: &mut Vault<B, Q, S>, cap: &AdminCap, delay_ms: u64) {
    caps::assert_admin(&v.caps, cap);
    assert!(delay_ms >= MIN_UNPAUSE_DELAY_MS, EBadParam);
    v.params.unpause_delay_ms = delay_ms;
}

public fun set_min_deposit<B, Q, S>(v: &mut Vault<B, Q, S>, cap: &AdminCap, min_sats: u64) {
    caps::assert_admin(&v.caps, cap);
    assert!(min_sats > 0, EBadParam);
    v.params.min_deposit_sats = min_sats;
}

/// Fees accrue on MATCHED VOLUME (spec §8), never on AUM. The bound exists so a governance
/// mistake cannot make the auction confiscatory.
public fun set_fee_params<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    cap: &AdminCap,
    fee_matched_bps: u64,
    fee_recipient: address,
) {
    caps::assert_admin(&v.caps, cap);
    assert!(fee_matched_bps <= MAX_FEE_MATCHED_BPS, EBadParam);
    v.fee_matched_bps = fee_matched_bps;
    v.fee_recipient = fee_recipient;
}

// ── escrow: notes in, internal balance out ──────────────────────────────────

/// Deposit exactly one note's worth of base asset and append its commitment to the tree.
///
/// The contract never sees `secret` or `randomness`. `denom_index` is supplied because a
/// fixed-denomination deposit reveals its tier anyway, and the backing identity needs it.
public fun escrow_deposit_note<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    payment: Coin<B>,
    denom_index: u8,
    commitment: vector<u8>,
): u64 {
    assert_not_paused(v);
    let sats = notes::denom_sats(&v.ladder, denom_index);
    assert!(payment.value() == sats, EDenomMismatch);

    v.note_custody.join(payment.into_balance());
    let leaf_index = notes::append_commitment(
        &mut v.tree,
        &v.ladder,
        &v.vault_cap,
        denom_index,
        commitment,
    );
    notes::assert_note_backing(&v.tree, v.note_custody.value(), 0);
    leaf_index
}

/// Retire a note and land its value in the spender's persistent internal balance.
///
/// This is the only bridge between the two escrow representations, and it keeps
/// `assert_note_backing` exact: the tree loses exactly `sats` and `note_custody` loses exactly
/// `sats`, which then reappear inside the book's own custody.
public fun escrow_spend_note<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    witness: MembershipWitness,
    ctx: &mut TxContext,
): u64 {
    let sats = notes::spend(&mut v.tree, &mut v.nulls, &v.ladder, &v.vault_cap, witness);
    let paid = coin::from_balance(v.note_custody.split(sats), ctx);
    ledger::top_up_for(&mut v.base_book, paid, ctx.sender());
    notes::assert_note_backing(&v.tree, v.note_custody.value(), 0);
    sats
}

public fun escrow_top_up_base<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    payment: Coin<B>,
    ctx: &TxContext,
): u64 {
    ledger::top_up(&mut v.base_book, payment, ctx)
}

public fun escrow_top_up_quote<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    payment: Coin<Q>,
    ctx: &TxContext,
): u64 {
    ledger::top_up(&mut v.quote_book, payment, ctx)
}

/// Refused while a clearing is in flight (@invariant 8). A fill is sized against the ledger
/// when the clearing loads it; letting money leave in between would make a computed fill
/// uncoverable and abort the whole settlement.
public fun escrow_withdraw_base<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    amount_sats: u64,
    ctx: &mut TxContext,
): Coin<B> {
    assert!(v.active_clearings == 0, EEscrowLocked);
    ledger::withdraw(&mut v.base_book, amount_sats, ctx)
}

public fun escrow_withdraw_quote<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    amount_sats: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    assert!(v.active_clearings == 0, EEscrowLocked);
    ledger::withdraw(&mut v.quote_book, amount_sats, ctx)
}

// ── the settlement surface `aphotic::clearing` reaches for ──────────────────
// All `public(package)`. A public accessor returning `&VaultCap` would let anyone call
// `balance::debit` on any account, so the cap never leaves the package.

public(package) fun begin_clearing_lock<B, Q, S>(v: &mut Vault<B, Q, S>) {
    assert!(v.active_clearings == 0, EEscrowLocked);
    v.active_clearings = 1;
}

public(package) fun end_clearing_lock<B, Q, S>(v: &mut Vault<B, Q, S>) {
    assert!(v.active_clearings > 0, ENoClearingActive);
    v.active_clearings = 0;
}

public(package) fun settle_debit_base<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    who: address,
    sats: u64,
) {
    ledger::debit(&mut v.base_book, &v.vault_cap, who, sats);
}

public(package) fun settle_credit_base<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    who: address,
    sats: u64,
) {
    ledger::credit(&mut v.base_book, &v.vault_cap, who, sats);
}

public(package) fun settle_debit_quote<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    who: address,
    sats: u64,
) {
    ledger::debit(&mut v.quote_book, &v.vault_cap, who, sats);
}

public(package) fun settle_credit_quote<B, Q, S>(
    v: &mut Vault<B, Q, S>,
    who: address,
    sats: u64,
) {
    ledger::credit(&mut v.quote_book, &v.vault_cap, who, sats);
}

public(package) fun assert_escrow_solvent<B, Q, S>(v: &Vault<B, Q, S>) {
    ledger::assert_solvent(&v.base_book);
    ledger::assert_solvent(&v.quote_book);
}

// ── read surface ────────────────────────────────────────────────────────────

public fun cap_registry<B, Q, S>(v: &Vault<B, Q, S>): &CapRegistry { &v.caps }

public fun vault_epoch<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.epoch }

public fun committed_supply<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.committed_supply }

public fun unminted_shares<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.unminted_shares }

public fun minted_supply<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    coin::total_supply(&v.lp_treasury)
}

public fun idle_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.base.value() }

public fun claimable_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.claimable.value() }

public fun pending_deposit_assets<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.pending_deposit_assets }

public fun pending_redeem_shares<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.pending_redeem_shares }

public fun deployed_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.deployed_sats }

public fun in_flight_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.in_flight_sats }

public fun native_btc_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.native_btc_sats }

public fun hashi_claims_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.last_hashi_claims_sats }

public fun last_nav_assets<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.last.nav_assets }

public fun last_nav_supply<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.last.nav_supply }

public fun has_proposal<B, Q, S>(v: &Vault<B, Q, S>): bool { v.proposal.is_some() }

public fun current_proposal<B, Q, S>(v: &Vault<B, Q, S>): NavProposal {
    *v.proposal.borrow()
}

public fun current_proposal_digest<B, Q, S>(v: &Vault<B, Q, S>): vector<u8> {
    proposal_digest(v.proposal.borrow())
}

public fun proposal_nav_assets(p: &NavProposal): u64 { nav_assets_of(p) }

public fun proposal_epoch(p: &NavProposal): u64 { p.epoch }

public fun proposal_proposer(p: &NavProposal): address { p.proposer }

public fun epoch_price_at<B, Q, S>(v: &Vault<B, Q, S>, epoch: u64): (u64, u64) {
    let p = v.epoch_prices.borrow(epoch);
    (p.nav_assets, p.nav_supply)
}

public fun epoch_price_at_ms<B, Q, S>(v: &Vault<B, Q, S>, epoch: u64): u64 {
    v.epoch_prices.borrow(epoch).at_ms
}

public fun last_nav_at_ms<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.last.at_ms }

public fun proposal_proposed_at_ms(p: &NavProposal): u64 { p.proposed_at_ms }

public fun proposal_native_btc_sats(p: &NavProposal): u64 { p.native_btc_sats }

public fun proposal_hashi_claims_sats(p: &NavProposal): u64 { p.hashi_claims_sats }

public fun proposal_idle_sats(p: &NavProposal): u64 { p.idle_sats }

public fun proposal_clearing_price(p: &NavProposal): u64 { p.clearing_price }

public fun proposal_book_mid(p: &NavProposal): u64 { p.book_mid }

public fun proposal_deployed_sats(p: &NavProposal): u64 { p.deployed_sats }

public fun proposal_in_flight_sats(p: &NavProposal): u64 { p.in_flight_sats }

public fun is_paused<B, Q, S>(v: &Vault<B, Q, S>): bool { caps::is_paused(&v.caps) }

public fun is_unpause_armed<B, Q, S>(v: &Vault<B, Q, S>): bool {
    v.unpause_armed_at_ms.is_some()
}

public fun active_clearings<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.active_clearings }

public fun escrow_base_of<B, Q, S>(v: &Vault<B, Q, S>, who: address): u64 {
    ledger::balance_of(&v.base_book, who)
}

public fun escrow_quote_of<B, Q, S>(v: &Vault<B, Q, S>, who: address): u64 {
    ledger::balance_of(&v.quote_book, who)
}

public fun escrow_base_custody<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    ledger::custody_value(&v.base_book)
}

public fun escrow_quote_custody<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    ledger::custody_value(&v.quote_book)
}

public fun note_custody_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.note_custody.value() }

public fun note_root<B, Q, S>(v: &Vault<B, Q, S>): vector<u8> { notes::root(&v.tree) }

public fun note_tree_depth<B, Q, S>(v: &Vault<B, Q, S>): u8 { notes::depth(&v.tree) }

public fun note_outstanding_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    notes::outstanding_sats(&v.tree)
}

public fun note_sibling_zero<B, Q, S>(v: &Vault<B, Q, S>, level: u64): vector<u8> {
    notes::zero_hash(&v.tree, level)
}

public fun denom_sats_at<B, Q, S>(v: &Vault<B, Q, S>, denom_index: u8): u64 {
    notes::denom_sats(&v.ladder, denom_index)
}

public fun fee_matched_bps<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.fee_matched_bps }

public fun fee_recipient<B, Q, S>(v: &Vault<B, Q, S>): address { v.fee_recipient }

public fun max_nav_jump_bps<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.params.max_nav_jump_bps }

public fun max_price_dev_bps<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.params.max_price_dev_bps }

public fun max_proposal_age_ms<B, Q, S>(v: &Vault<B, Q, S>): u64 {
    v.params.max_proposal_age_ms
}

public fun unpause_delay_ms<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.params.unpause_delay_ms }

public fun min_deposit_sats<B, Q, S>(v: &Vault<B, Q, S>): u64 { v.params.min_deposit_sats }

public fun receipt_epoch(r: &DepositReceipt): u64 { r.epoch }

public fun receipt_assets(r: &DepositReceipt): u64 { r.assets_sats }

public fun redeem_receipt_epoch(r: &RedeemReceipt): u64 { r.epoch }

public fun redeem_receipt_shares(r: &RedeemReceipt): u64 { r.shares }

public fun bps_denominator(): u64 { BPS_DENOMINATOR }

public fun note_tree_depth_const(): u8 { NOTE_TREE_DEPTH }

// ── test-only helpers ───────────────────────────────────────────────────────

#[test_only]
public fun set_deployed_for_testing<B, Q, S>(v: &mut Vault<B, Q, S>, sats: u64) {
    v.deployed_sats = sats;
}

#[test_only]
public fun fund_base_for_testing<B, Q, S>(v: &mut Vault<B, Q, S>, c: Coin<B>) {
    v.base.join(c.into_balance());
}
