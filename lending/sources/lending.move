module aphotic_lending::lending;

use hashi::btc::BTC;
use std::string::{Self, String};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::coin_registry;
use sui::event;
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.lending   (the counterparty behind aphotic.md §11 "Phase 1 — vault":
//             "idle allocation" / aphotic-governance.md §1 "idle hBTC earns lending yield")
// @phase      1
// @status     DONE
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║  HONESTY DISCLOSURE — READ IT, AND REPEAT IT ANYWHERE A NUMBER FROM THIS MARKET IS SHOWN ║
// ╠══════════════════════════════════════════════════════════════════════════════════════════╣
// ║  1. APHOTIC DEPLOYED AND OPERATES THIS MARKET. It is not an independent venue. A yield   ║
// ║     figure sourced from it is a yield figure sourced from ourselves, and must never be   ║
// ║     presented as a third-party rate, a market rate, or external validation of anything.  ║
// ║  2. WHY IT EXISTS: no hBTC lending market exists on Sui testnet. Suilend, Navi and       ║
// ║     Scallop have NO testnet deployment; AlphaLend's markets are testcoins plus SUI. The  ║
// ║     idle-yield leg therefore had nothing to plug into. The choice was between mocking    ║
// ║     the adapter off-chain — which proves nothing — and deploying a real counterparty and ║
// ║     saying so. This is the second option.                                                ║
// ║  3. THE YIELD IS REAL BUT IT IS A CLAIM ON BORROWERS, NOT A CONSTANT. There is no        ║
// ║     hardcoded APY anywhere in this file, and no unbacked mint: `total_assets` grows ONLY ║
// ║     when `total_borrows_sats` grows, and that only happens while somebody is actually    ║
// ║     borrowing. With zero borrowers, `accrue` provably adds zero — see `project_accrual`. ║
// ║  4. BORROWING IS PERMISSIONED AND UNCOLLATERALISED. The admin sets a credit line per     ║
// ║     borrower. There is NO collateral and NO liquidation: `is_collateralised()` returns   ║
// ║     false and `has_liquidations()` returns false, on purpose, so a front-end cannot      ║
// ║     display this market without being able to display that too. Supplier principal is at ║
// ║     risk to borrower default. That is a real risk and it is stated, not hedged.          ║
// ║  5. `disclosure()` returns points 1 and 4 as an on-chain string, so the app has no       ║
// ║     excuse to render the APY without them.                                               ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
//
// @spec       aphotic.md#7.7 / aphotic-governance.md §5 Table 2 — the NAV leg this market feeds:
//               "Lending positions | adapter convert_to_assets(shares) — redeemable hBTC"
// @spec       aphotic-governance.md#4.1 — allocate/deallocate restricted to a pinned allowlist
// @spec       aphotic.md#3-rejected-designs — "A management fee on AUM" is rejected upstream;
//               the reserve factor here is a cut of INTEREST, never of principal or of AUM.
// @rules      G10 (sats u64 · E<Reason> errors · an event per externally-visible transition)
// @depends    hashi (TYPE ONLY: `hashi::btc::BTC`. This package calls no hashi function.)
// @facts      hBTC coin type = `0xfcea10ca…::btc::BTC`, 8 decimals, symbol hBTC (RECON R5/R7.4).
// @facts        `struct BTC has key { id: UID }` — coin_registry style, phantom in `Coin<BTC>`.
// @facts      MONEY UNIT = satoshis, u64.
// @facts      SHARE COIN = `aphotic_lending::lending::LENDING`, 8 decimals, symbol `aLhBTC`.
// @facts        A genuinely fungible `Coin`, not a bespoke position object: aphotic.md §8 —
// @facts        "fungible shares stay composable and listable; a bespoke position object traps
// @facts        the liquidity". Registered through `sui::coin_registry::new_currency_with_otw`
// @facts        because `sui::coin::create_currency` is DEPRECATED in this framework rev.
// @facts      INDEX_SCALE = 1e9. `borrow_index` is u128 and starts at INDEX_SCALE.
// @facts      MS_PER_YEAR = 31_536_000_000 (365 d). Rates are ANNUAL bps, accrued linearly per
// @facts        elapsed millisecond and compounded through the index at every accrual point.
// @facts      DEFAULTS: base 0 bps · slope1 400 bps · kink 8_000 bps · slope2 6_000 bps ·
// @facts        reserve factor 1_000 bps · supply cap 2.1e15 sats (21M BTC).
// @facts      MINIMUM_LOCKED_SHARES = 1_000. The first depositor's first 1_000 share units are
// @facts        moved into the market permanently. This is the standard first-depositor
// @facts        inflation guard: without it, a 1-wei first deposit followed by a large `repay`
// @facts        lets the attacker round every later depositor's shares to zero.
// @external   THE ADAPTER CONTRACT this market implements, verbatim from `aphotic::allocate`'s
//             banner (same three names, so the allowlisted route needs no shim):
//               public fun deposit(market: &mut Market, coin_in: Coin<BTC>, clock: &Clock,
//                   ctx: &mut TxContext): Coin<LENDING>
//               public fun withdraw(market: &mut Market, shares_in: Coin<LENDING>,
//                   clock: &Clock, ctx: &mut TxContext): Coin<BTC>
//               public fun convert_to_assets(market: &Market, shares: u64): u64
// @implements ── lifecycle ──
//             fun init(otw: LENDING, ctx: &mut TxContext)                             [DONE]
//             ── supply side (the adapter contract) ──
//             public fun deposit / withdraw / convert_to_assets                        [DONE]
//             public fun convert_to_assets_now(&Market, u64, &Clock): u64              [DONE]
//             public fun convert_to_shares(&Market, u64): u64                          [DONE]
//             ── borrow side (permissioned, uncollateralised — see the disclosure) ──
//             public fun borrow(&mut Market, u64, &Clock, &mut TxContext): Coin<BTC>   [DONE]
//             public fun repay(&mut Market, Coin<BTC>, &Clock, &mut TxContext): Coin<BTC> [DONE]
//             ── accrual (pure core + the one mutator) ──
//             public fun project_accrual(&Market, now_ms: u64): (u64, u64, u64)        [DONE]
//             public fun accrue(&mut Market, &Clock)                                   [DONE]
//             ── admin ──
//             public fun set_credit_line / revoke_credit_line / set_interest_model /
//                 set_supply_cap / set_paused / withdraw_reserves                      [DONE]
//             ── reads ──
//             public fun total_assets / projected_total_assets / total_shares /
//                 cash_sats / total_borrows_sats / protocol_reserves_sats /
//                 available_liquidity_sats / utilisation_bps / borrow_rate_bps /
//                 supply_rate_bps / borrow_index / last_accrual_ms / is_paused /
//                 supply_cap_sats / credit_line_of / debt_of / is_approved_borrower /
//                 interest_model / admin_market_id                                     [DONE]
//             ── disclosure (point 5 above) ──
//             public fun disclosure(): String                                          [DONE]
//             public fun is_collateralised(): bool   // false                          [DONE]
//             public fun has_liquidations(): bool    // false                          [DONE]
//             public fun is_operator_deployed(): bool // true                          [DONE]
// @events     MarketCreated · Accrued · Supplied · Withdrawn · Borrowed · Repaid ·
//             CreditLineSet · CreditLineRevoked · InterestModelSet · SupplyCapSet ·
//             MarketPausedSet · ReservesWithdrawn
// @errors     EWrongMarket · EMarketPaused · EZeroAmount · EZeroShares ·
//             EBelowMinimumInitialDeposit · ESupplyCapExceeded · EInsufficientLiquidity ·
//             ENotAnApprovedBorrower · ECreditLineExceeded · ENoDebt · EBorrowerStillIndebted ·
//             EInvalidInterestModel · EInsufficientReserves
// @forbidden  a hardcoded APY, a `yield` constant, or any accrual that does not read
//             `total_borrows_sats`. `project_accrual` returns `(borrows, reserves, 0)` unchanged
//             whenever `total_borrows_sats == 0`, and a test pins exactly that.
// @forbidden  minting `Coin<LENDING>` anywhere except `deposit`, against sats that actually
//             arrived. There is exactly one `treasury.mint` call site in this file.
// @forbidden  calling any `hashi::` function. The dependency is a TYPE dependency only.
// @forbidden  presenting a rate from this market as an independent or third-party rate (see the
//             disclosure block above).
// @invariant  1. NO UNBACKED MINT: `Coin<LENDING>` is minted only in `deposit`, only for sats
//                that were joined into `cash` in the same call.
// @invariant  2. NO INVENTED YIELD: with `total_borrows_sats == 0`, `accrue` over ANY elapsed
//                time changes nothing. Supplier assets can only grow out of borrower interest.
// @invariant  3. SOLVENCY OF THE CLAIM: `total_assets = cash + total_borrows − protocol_reserves`.
//                A supplier's redemption is `shares × total_assets / total_shares`, and
//                `withdraw` additionally refuses to touch `protocol_reserves` or to hand out
//                sats that are lent out (`EInsufficientLiquidity`).
// @invariant  4. THE RESERVE CUT IS A CUT OF INTEREST ONLY. It is computed from `interest`,
//                never from `total_borrows`, `cash` or `total_assets` — no AUM fee (aphotic.md §8).
// @invariant  5. SUPPLIERS CAN ALWAYS EXIT: `withdraw` and `repay` are NOT gated on `paused`.
//                Pausing stops new supply and new borrowing only.
// @invariant  6. `project_accrual` is PURE (`&Market` + a timestamp) and is the ONLY arithmetic
//                `accrue` performs, so the NAV projection and the on-chain mutation cannot drift.
// @invariant  7. Rounding always favours the pool, never the borrower: a new draw rounds its
//                scaled debt UP, and a partial repayment rounds the REMAINING scaled debt UP.
//                A full repayment still lands exactly on zero.
// @invariant  8. The first depositor's first `MINIMUM_LOCKED_SHARES` units are locked in the
//                market forever and are never redeemable, so `total_shares` can never return to
//                zero while assets remain.
// @ac         lending/tests/lending_tests.move — every invariant above has a named test.
// @verify     sui move build
// @verify     sui move test
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const EWrongMarket: u64 = 1;
const EMarketPaused: u64 = 2;
const EZeroAmount: u64 = 3;
const EZeroShares: u64 = 4;
const EBelowMinimumInitialDeposit: u64 = 5;
const ESupplyCapExceeded: u64 = 6;
const EInsufficientLiquidity: u64 = 7;
const ENotAnApprovedBorrower: u64 = 8;
const ECreditLineExceeded: u64 = 9;
const ENoDebt: u64 = 10;
const EBorrowerStillIndebted: u64 = 11;
const EInvalidInterestModel: u64 = 12;
const EInsufficientReserves: u64 = 13;

// ── scale constants ─────────────────────────────────────────────────────────
const BPS_DENOMINATOR: u64 = 10_000;
const INDEX_SCALE: u128 = 1_000_000_000;
const MS_PER_YEAR: u64 = 31_536_000_000;
const MAX_U64: u64 = 18_446_744_073_709_551_615;

/// Share coin decimals — matched to hBTC so 1 share ≈ 1 satoshi at inception.
const SHARE_DECIMALS: u8 = 8;

/// First-depositor inflation guard (@invariant 8).
const MINIMUM_LOCKED_SHARES: u64 = 1_000;

// ── interest-model bounds and defaults ──────────────────────────────────────
const MAX_RATE_BPS: u64 = 1_000_000; // 10_000 % annual — a sanity ceiling, not a target
const MAX_RESERVE_FACTOR_BPS: u64 = 5_000; // the operator may never take more than half
const DEFAULT_BASE_RATE_BPS: u64 = 0;
const DEFAULT_SLOPE1_BPS: u64 = 400;
const DEFAULT_KINK_BPS: u64 = 8_000;
const DEFAULT_SLOPE2_BPS: u64 = 6_000;
const DEFAULT_RESERVE_FACTOR_BPS: u64 = 1_000;
const DEFAULT_SUPPLY_CAP_SATS: u64 = 2_100_000_000_000_000; // 21M BTC in sats

// ── the disclosure, on-chain ────────────────────────────────────────────────
const DISCLOSURE: vector<u8> =
    b"Aphotic deployed and operates this lending market. A rate shown from it is not an independent or third-party rate. Borrowing is permissioned and uncollateralised: there is no collateral and no liquidation, so supplier principal is at risk to borrower default. Yield accrues only while capital is actually borrowed.";

// ── types ───────────────────────────────────────────────────────────────────

/// One-time witness. The supply-share coin type: `Coin<LENDING>`, symbol `aLhBTC`.
public struct LENDING has drop {}

/// Governs one `Market` and nothing else.
public struct AdminCap has key, store {
    id: UID,
    market_id: ID,
}

/// Shared object. A supply-side hBTC money market.
public struct Market has key {
    id: UID,
    /// Idle hBTC held by the market. Includes `protocol_reserves_sats`.
    cash: Balance<BTC>,
    /// Mints/burns supply shares. `total_supply()` IS `total_shares`.
    treasury: TreasuryCap<LENDING>,
    /// The first depositor's locked units (@invariant 8). Never redeemable.
    locked_shares: Balance<LENDING>,
    /// Outstanding borrower principal PLUS interest accrued to `last_accrual_ms`.
    total_borrows_sats: u64,
    /// The operator's accrued cut of INTEREST (@invariant 4). Held inside `cash`, excluded
    /// from `total_assets` and from what `withdraw` may pay out.
    protocol_reserves_sats: u64,
    /// Compounding factor, scaled by INDEX_SCALE. Starts at INDEX_SCALE.
    borrow_index: u128,
    last_accrual_ms: u64,
    // ── interest model: annual bps on a kinked utilisation curve ──
    base_rate_bps: u64,
    slope1_bps: u64,
    kink_bps: u64,
    slope2_bps: u64,
    reserve_factor_bps: u64,
    // ── governed limits ──
    supply_cap_sats: u64,
    /// Blocks NEW supply and NEW borrowing only (@invariant 5).
    paused: bool,
    /// borrower -> credit limit in sats. Membership IS approval.
    credit_lines: Table<address, u64>,
    /// borrower -> debt in INDEX_SCALE-scaled units; owed = scaled * borrow_index / INDEX_SCALE.
    debts: Table<address, u128>,
}

// ── events ──────────────────────────────────────────────────────────────────

public struct MarketCreated has copy, drop {
    market_id: ID,
    share_decimals: u8,
    disclosure: String,
}

public struct Accrued has copy, drop {
    market_id: ID,
    interest_sats: u64,
    reserve_cut_sats: u64,
    total_borrows_sats: u64,
    borrow_index: u128,
    at_ms: u64,
}

public struct Supplied has copy, drop {
    market_id: ID,
    supplier: address,
    sats: u64,
    shares_minted: u64,
    total_assets_sats: u64,
    at_ms: u64,
}

public struct Withdrawn has copy, drop {
    market_id: ID,
    supplier: address,
    shares_burned: u64,
    sats: u64,
    total_assets_sats: u64,
    at_ms: u64,
}

public struct Borrowed has copy, drop {
    market_id: ID,
    borrower: address,
    sats: u64,
    debt_sats: u64,
    utilisation_bps: u64,
    at_ms: u64,
}

public struct Repaid has copy, drop {
    market_id: ID,
    borrower: address,
    sats: u64,
    debt_sats: u64,
    at_ms: u64,
}

public struct CreditLineSet has copy, drop {
    market_id: ID,
    borrower: address,
    limit_sats: u64,
}

public struct CreditLineRevoked has copy, drop {
    market_id: ID,
    borrower: address,
}

public struct InterestModelSet has copy, drop {
    market_id: ID,
    base_rate_bps: u64,
    slope1_bps: u64,
    kink_bps: u64,
    slope2_bps: u64,
    reserve_factor_bps: u64,
}

public struct SupplyCapSet has copy, drop {
    market_id: ID,
    supply_cap_sats: u64,
}

public struct MarketPausedSet has copy, drop {
    market_id: ID,
    paused: bool,
}

public struct ReservesWithdrawn has copy, drop {
    market_id: ID,
    sats: u64,
    protocol_reserves_sats: u64,
}

// ── arithmetic helpers ──────────────────────────────────────────────────────

fun saturating_sub(a: u64, b: u64): u64 {
    if (a > b) a - b else 0
}

fun saturating_add(a: u64, b: u64): u64 {
    let sum = (a as u128) + (b as u128);
    if (sum > (MAX_U64 as u128)) MAX_U64 else (sum as u64)
}

fun clamp_u128(value: u128): u64 {
    if (value > (MAX_U64 as u128)) MAX_U64 else (value as u64)
}

/// `a * b / c`, u128 intermediate, floor. `c == 0` is a caller bug, not a runtime condition.
fun mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c != 0, EZeroAmount);
    clamp_u128(((a as u128) * (b as u128)) / (c as u128))
}

// ── lifecycle ───────────────────────────────────────────────────────────────

fun init(otw: LENDING, ctx: &mut TxContext) {
    let (builder, treasury) = coin_registry::new_currency_with_otw(
        otw,
        SHARE_DECIMALS,
        string::utf8(b"aLhBTC"),
        string::utf8(b"Aphotic Lending hBTC Supply Share"),
        // The description is the disclosure. It travels with the coin.
        string::utf8(DISCLOSURE),
        string::utf8(b""),
        ctx,
    );
    // Metadata is finalised and the metadata cap destroyed in the same call: the description
    // above — the disclosure — can never be edited away later.
    coin_registry::finalize_and_delete_metadata_cap(builder, ctx);

    let (market, admin) = new_market(treasury, ctx);
    transfer::share_object(market);
    transfer::public_transfer(admin, ctx.sender());
}

fun new_market(treasury: TreasuryCap<LENDING>, ctx: &mut TxContext): (Market, AdminCap) {
    let market = Market {
        id: object::new(ctx),
        cash: balance::zero<BTC>(),
        treasury,
        locked_shares: balance::zero<LENDING>(),
        total_borrows_sats: 0,
        protocol_reserves_sats: 0,
        borrow_index: INDEX_SCALE,
        last_accrual_ms: 0,
        base_rate_bps: DEFAULT_BASE_RATE_BPS,
        slope1_bps: DEFAULT_SLOPE1_BPS,
        kink_bps: DEFAULT_KINK_BPS,
        slope2_bps: DEFAULT_SLOPE2_BPS,
        reserve_factor_bps: DEFAULT_RESERVE_FACTOR_BPS,
        supply_cap_sats: DEFAULT_SUPPLY_CAP_SATS,
        paused: false,
        credit_lines: table::new(ctx),
        debts: table::new(ctx),
    };
    let market_id = object::id(&market);
    let admin = AdminCap { id: object::new(ctx), market_id };
    event::emit(MarketCreated {
        market_id,
        share_decimals: SHARE_DECIMALS,
        disclosure: string::utf8(DISCLOSURE),
    });
    (market, admin)
}

fun assert_admin(cap: &AdminCap, market: &Market) {
    assert!(cap.market_id == object::id(market), EWrongMarket);
}

// ── accrual ─────────────────────────────────────────────────────────────────

/// PURE (@invariant 6). Returns `(total_borrows, protocol_reserves, interest)` as they WOULD be
/// at `now_ms`, without touching the market. `accrue` applies exactly this, and
/// `projected_total_assets` reads exactly this, so an off-chain NAV projection and the on-chain
/// state cannot disagree.
///
/// @invariant 2 lives here in one line: `total_borrows_sats == 0` returns `interest = 0` for any
/// elapsed time whatsoever. Nothing in this market invents a satoshi.
public fun project_accrual(market: &Market, now_ms: u64): (u64, u64, u64) {
    let borrows = market.total_borrows_sats;
    if (now_ms <= market.last_accrual_ms || borrows == 0) {
        return (borrows, market.protocol_reserves_sats, 0)
    };
    let elapsed_ms = now_ms - market.last_accrual_ms;
    let rate_bps = borrow_rate_bps(market);
    // interest = borrows * annual_rate * elapsed / (10_000 * ms_per_year), floor.
    let interest = clamp_u128(
        ((borrows as u128) * (rate_bps as u128) * (elapsed_ms as u128))
            / ((BPS_DENOMINATOR as u128) * (MS_PER_YEAR as u128)),
    );
    if (interest == 0) {
        return (borrows, market.protocol_reserves_sats, 0)
    };
    // @invariant 4: the cut is taken out of INTEREST, never out of principal or of AUM.
    let cut = mul_div(interest, market.reserve_factor_bps, BPS_DENOMINATOR);
    (saturating_add(borrows, interest), saturating_add(market.protocol_reserves_sats, cut), interest)
}

/// The one mutator. Permissionless and idempotent within a millisecond — every state-changing
/// entry point calls it first, so nobody has to trust a keeper to have done it.
public fun accrue(market: &mut Market, clock: &Clock) {
    let now_ms = clock.timestamp_ms();
    if (now_ms <= market.last_accrual_ms) return;
    let borrows_before = market.total_borrows_sats;
    let (borrows_after, reserves_after, interest) = project_accrual(market, now_ms);
    market.last_accrual_ms = now_ms;
    if (interest == 0) return;
    // Compound the index by exactly the ratio the borrow book grew by, so every borrower's
    // scaled debt tracks the book without per-account iteration.
    market.borrow_index =
        (market.borrow_index * (borrows_after as u128)) / (borrows_before as u128);
    market.total_borrows_sats = borrows_after;
    let reserve_cut = saturating_sub(reserves_after, market.protocol_reserves_sats);
    market.protocol_reserves_sats = reserves_after;
    event::emit(Accrued {
        market_id: object::id(market),
        interest_sats: interest,
        reserve_cut_sats: reserve_cut,
        total_borrows_sats: borrows_after,
        borrow_index: market.borrow_index,
        at_ms: now_ms,
    });
}

// ── the adapter contract: supply side ───────────────────────────────────────

/// hBTC in, supply shares out. The first depositor's first `MINIMUM_LOCKED_SHARES` units are
/// locked in the market forever (@invariant 8).
public fun deposit(
    market: &mut Market,
    coin_in: Coin<BTC>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<LENDING> {
    assert!(!market.paused, EMarketPaused);
    accrue(market, clock);

    let sats = coin_in.value();
    assert!(sats > 0, EZeroAmount);
    let assets_before = total_assets(market);
    assert!(
        (assets_before as u128) + (sats as u128) <= (market.supply_cap_sats as u128),
        ESupplyCapExceeded,
    );

    let total_shares_before = market.treasury.total_supply();
    let shares = if (total_shares_before == 0) {
        assert!(sats > MINIMUM_LOCKED_SHARES, EBelowMinimumInitialDeposit);
        sats
    } else {
        let computed = convert_to_shares(market, sats);
        assert!(computed > 0, EZeroShares);
        computed
    };

    // Shares are minted against sats that arrive in the same call (@invariant 1).
    market.cash.join(coin_in.into_balance());
    let mut minted = market.treasury.mint(shares, ctx);
    if (total_shares_before == 0) {
        let locked = minted.split(MINIMUM_LOCKED_SHARES, ctx);
        market.locked_shares.join(locked.into_balance());
    };

    event::emit(Supplied {
        market_id: object::id(market),
        supplier: ctx.sender(),
        sats,
        shares_minted: shares,
        total_assets_sats: total_assets(market),
        at_ms: clock.timestamp_ms(),
    });
    minted
}

/// Supply shares in, hBTC out. NOT gated on `paused` (@invariant 5): a pause must never trap a
/// supplier. Refuses to pay out of `protocol_reserves_sats` or out of sats that are lent.
public fun withdraw(
    market: &mut Market,
    shares_in: Coin<LENDING>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<BTC> {
    accrue(market, clock);

    let shares = shares_in.value();
    assert!(shares > 0, EZeroShares);
    let sats = convert_to_assets(market, shares);
    assert!(sats > 0, EZeroAmount);
    assert!(sats <= available_liquidity_sats(market), EInsufficientLiquidity);

    market.treasury.burn(shares_in);
    let out = market.cash.split(sats);

    event::emit(Withdrawn {
        market_id: object::id(market),
        supplier: ctx.sender(),
        shares_burned: shares,
        sats,
        total_assets_sats: total_assets(market),
        at_ms: clock.timestamp_ms(),
    });
    coin::from_balance(out, ctx)
}

/// THE ADAPTER READ: what `shares` are redeemable for, in sats, as of the last accrual.
/// Returns 0 on an empty market rather than aborting — "no position" is a value, not an error.
public fun convert_to_assets(market: &Market, shares: u64): u64 {
    let total_shares = market.treasury.total_supply();
    if (total_shares == 0 || shares == 0) return 0;
    mul_div(shares, total_assets(market), total_shares)
}

/// `convert_to_assets` with accrual projected to `clock` but NOT written. This is what a NAV
/// pass should read: it is pure, so it can be simulated with `devInspect` and reproduced by
/// anyone from public state (aphotic-governance.md §5.3, "re-derive, never cache").
public fun convert_to_assets_now(market: &Market, shares: u64, clock: &Clock): u64 {
    let total_shares = market.treasury.total_supply();
    if (total_shares == 0 || shares == 0) return 0;
    mul_div(shares, projected_total_assets(market, clock.timestamp_ms()), total_shares)
}

public fun convert_to_shares(market: &Market, sats: u64): u64 {
    let total_shares = market.treasury.total_supply();
    let assets = total_assets(market);
    if (total_shares == 0 || assets == 0) return sats;
    mul_div(sats, total_shares, assets)
}

// ── borrow side (permissioned, uncollateralised — see the disclosure) ───────

/// Draw against a credit line. Sender-bound: a credit line is not transferable and cannot be
/// drawn on anyone's behalf.
public fun borrow(
    market: &mut Market,
    sats: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<BTC> {
    assert!(!market.paused, EMarketPaused);
    accrue(market, clock);

    let who = ctx.sender();
    assert!(market.credit_lines.contains(who), ENotAnApprovedBorrower);
    assert!(sats > 0, EZeroAmount);
    assert!(sats <= available_liquidity_sats(market), EInsufficientLiquidity);

    let owed = debt_of(market, who);
    let limit = *market.credit_lines.borrow(who);
    assert!((owed as u128) + (sats as u128) <= (limit as u128), ECreditLineExceeded);

    // @invariant 7: scaled debt rounds UP, so rounding never favours the borrower.
    let scaled_delta =
        (((sats as u128) * INDEX_SCALE) + market.borrow_index - 1) / market.borrow_index;
    if (market.debts.contains(who)) {
        let scaled = market.debts.borrow_mut(who);
        *scaled = *scaled + scaled_delta;
    } else {
        market.debts.add(who, scaled_delta);
    };
    market.total_borrows_sats = saturating_add(market.total_borrows_sats, sats);

    let out = market.cash.split(sats);
    event::emit(Borrowed {
        market_id: object::id(market),
        borrower: who,
        sats,
        debt_sats: debt_of(market, who),
        utilisation_bps: utilisation_bps(market),
        at_ms: clock.timestamp_ms(),
    });
    coin::from_balance(out, ctx)
}

/// Repay own debt. Over-payment is returned rather than absorbed. NOT gated on `paused`
/// (@invariant 5) — reducing debt must always be possible.
public fun repay(
    market: &mut Market,
    mut coin_in: Coin<BTC>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<BTC> {
    accrue(market, clock);

    let who = ctx.sender();
    assert!(market.debts.contains(who), ENoDebt);
    let owed = debt_of(market, who);
    assert!(owed > 0, ENoDebt);

    let offered = coin_in.value();
    let applied = if (offered > owed) owed else offered;
    assert!(applied > 0, EZeroAmount);

    let paid = coin_in.split(applied, ctx);
    market.cash.join(paid.into_balance());

    // @invariant 7: the remainder rounds UP into scaled units, so the dust stays owed to the
    // pool rather than being forgiven. A full repayment still lands exactly on zero.
    let remaining = owed - applied;
    let scaled_new = if (remaining == 0) {
        0
    } else {
        (((remaining as u128) * INDEX_SCALE) + market.borrow_index - 1) / market.borrow_index
    };
    *market.debts.borrow_mut(who) = scaled_new;
    market.total_borrows_sats = saturating_sub(market.total_borrows_sats, applied);

    event::emit(Repaid {
        market_id: object::id(market),
        borrower: who,
        sats: applied,
        debt_sats: debt_of(market, who),
        at_ms: clock.timestamp_ms(),
    });
    coin_in
}

// ── admin ───────────────────────────────────────────────────────────────────

/// Approve a borrower, or move an existing limit. Lowering a limit below the outstanding debt is
/// allowed and simply blocks further drawing.
public fun set_credit_line(
    cap: &AdminCap,
    market: &mut Market,
    borrower: address,
    limit_sats: u64,
) {
    assert_admin(cap, market);
    if (market.credit_lines.contains(borrower)) {
        *market.credit_lines.borrow_mut(borrower) = limit_sats;
    } else {
        market.credit_lines.add(borrower, limit_sats);
    };
    event::emit(CreditLineSet { market_id: object::id(market), borrower, limit_sats });
}

/// Remove a borrower entirely. Refuses while any debt is outstanding, so a revocation can never
/// be used to make a debt un-repayable.
public fun revoke_credit_line(
    cap: &AdminCap,
    market: &mut Market,
    borrower: address,
    clock: &Clock,
) {
    assert_admin(cap, market);
    accrue(market, clock);
    assert!(market.credit_lines.contains(borrower), ENotAnApprovedBorrower);
    assert!(debt_of(market, borrower) == 0, EBorrowerStillIndebted);
    market.credit_lines.remove(borrower);
    if (market.debts.contains(borrower)) {
        market.debts.remove(borrower);
    };
    event::emit(CreditLineRevoked { market_id: object::id(market), borrower });
}

public fun set_interest_model(
    cap: &AdminCap,
    market: &mut Market,
    base_rate_bps: u64,
    slope1_bps: u64,
    kink_bps: u64,
    slope2_bps: u64,
    reserve_factor_bps: u64,
    clock: &Clock,
) {
    assert_admin(cap, market);
    // Accrue at the OLD model first: a parameter change must never retroactively reprice a
    // period that has already elapsed.
    accrue(market, clock);
    assert!(kink_bps > 0 && kink_bps < BPS_DENOMINATOR, EInvalidInterestModel);
    assert!(reserve_factor_bps <= MAX_RESERVE_FACTOR_BPS, EInvalidInterestModel);
    assert!(
        base_rate_bps <= MAX_RATE_BPS && slope1_bps <= MAX_RATE_BPS && slope2_bps <= MAX_RATE_BPS,
        EInvalidInterestModel,
    );
    market.base_rate_bps = base_rate_bps;
    market.slope1_bps = slope1_bps;
    market.kink_bps = kink_bps;
    market.slope2_bps = slope2_bps;
    market.reserve_factor_bps = reserve_factor_bps;
    event::emit(InterestModelSet {
        market_id: object::id(market),
        base_rate_bps,
        slope1_bps,
        kink_bps,
        slope2_bps,
        reserve_factor_bps,
    });
}

public fun set_supply_cap(cap: &AdminCap, market: &mut Market, supply_cap_sats: u64) {
    assert_admin(cap, market);
    market.supply_cap_sats = supply_cap_sats;
    event::emit(SupplyCapSet { market_id: object::id(market), supply_cap_sats });
}

public fun set_paused(cap: &AdminCap, market: &mut Market, paused: bool) {
    assert_admin(cap, market);
    market.paused = paused;
    event::emit(MarketPausedSet { market_id: object::id(market), paused });
}

/// Take accrued reserves. Bounded by BOTH the accrued figure and the cash actually present, so
/// this can never dip into supplier principal.
public fun withdraw_reserves(
    cap: &AdminCap,
    market: &mut Market,
    sats: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<BTC> {
    assert_admin(cap, market);
    accrue(market, clock);
    assert!(sats > 0, EZeroAmount);
    assert!(sats <= market.protocol_reserves_sats, EInsufficientReserves);
    assert!(sats <= market.cash.value(), EInsufficientLiquidity);
    market.protocol_reserves_sats = market.protocol_reserves_sats - sats;
    let out = market.cash.split(sats);
    event::emit(ReservesWithdrawn {
        market_id: object::id(market),
        sats,
        protocol_reserves_sats: market.protocol_reserves_sats,
    });
    coin::from_balance(out, ctx)
}

// ── reads ───────────────────────────────────────────────────────────────────

/// @invariant 3. What the whole supply side is worth, as of the last accrual.
public fun total_assets(market: &Market): u64 {
    let gross = (market.cash.value() as u128) + (market.total_borrows_sats as u128);
    let reserves = market.protocol_reserves_sats as u128;
    if (gross > reserves) clamp_u128(gross - reserves) else 0
}

/// `total_assets` with accrual projected to `now_ms` but not written (@invariant 6).
public fun projected_total_assets(market: &Market, now_ms: u64): u64 {
    let (borrows, reserves, _interest) = project_accrual(market, now_ms);
    let gross = (market.cash.value() as u128) + (borrows as u128);
    if (gross > (reserves as u128)) clamp_u128(gross - (reserves as u128)) else 0
}

public fun total_shares(market: &Market): u64 {
    market.treasury.total_supply()
}

public fun cash_sats(market: &Market): u64 {
    market.cash.value()
}

public fun total_borrows_sats(market: &Market): u64 {
    market.total_borrows_sats
}

public fun protocol_reserves_sats(market: &Market): u64 {
    market.protocol_reserves_sats
}

public fun locked_shares(market: &Market): u64 {
    market.locked_shares.value()
}

/// Sats a supplier or borrower may actually take out right now: cash that is neither lent nor
/// earmarked as protocol reserves.
public fun available_liquidity_sats(market: &Market): u64 {
    saturating_sub(market.cash.value(), market.protocol_reserves_sats)
}

/// borrows / (available cash + borrows), in bps. Zero borrows is zero utilisation.
public fun utilisation_bps(market: &Market): u64 {
    let borrows = market.total_borrows_sats;
    if (borrows == 0) return 0;
    let supplied = (available_liquidity_sats(market) as u128) + (borrows as u128);
    if (supplied == 0) return 0;
    let u = clamp_u128(((borrows as u128) * (BPS_DENOMINATOR as u128)) / supplied);
    if (u > BPS_DENOMINATOR) BPS_DENOMINATOR else u
}

/// Annual borrower rate in bps, on the kinked curve. Pure function of the model and utilisation.
public fun borrow_rate_bps(market: &Market): u64 {
    let u = utilisation_bps(market);
    if (u <= market.kink_bps) {
        saturating_add(market.base_rate_bps, mul_div(market.slope1_bps, u, market.kink_bps))
    } else {
        let over = u - market.kink_bps;
        let span = BPS_DENOMINATOR - market.kink_bps;
        saturating_add(
            saturating_add(market.base_rate_bps, market.slope1_bps),
            mul_div(market.slope2_bps, over, span),
        )
    }
}

/// Annual supplier rate in bps: the borrow rate, scaled by utilisation and net of the reserve
/// factor. This is the number a front-end would display — never without `disclosure()`.
public fun supply_rate_bps(market: &Market): u64 {
    let gross = mul_div(borrow_rate_bps(market), utilisation_bps(market), BPS_DENOMINATOR);
    mul_div(gross, BPS_DENOMINATOR - market.reserve_factor_bps, BPS_DENOMINATOR)
}

public fun borrow_index(market: &Market): u128 {
    market.borrow_index
}

public fun last_accrual_ms(market: &Market): u64 {
    market.last_accrual_ms
}

public fun is_paused(market: &Market): bool {
    market.paused
}

public fun supply_cap_sats(market: &Market): u64 {
    market.supply_cap_sats
}

public fun is_approved_borrower(market: &Market, who: address): bool {
    market.credit_lines.contains(who)
}

public fun credit_line_of(market: &Market, who: address): u64 {
    if (!market.credit_lines.contains(who)) 0 else *market.credit_lines.borrow(who)
}

/// Sats owed by `who` as of the last accrual, scaled debt x index.
public fun debt_of(market: &Market, who: address): u64 {
    if (!market.debts.contains(who)) return 0;
    let scaled = *market.debts.borrow(who);
    clamp_u128((scaled * market.borrow_index) / INDEX_SCALE)
}

public fun interest_model(market: &Market): (u64, u64, u64, u64, u64) {
    (
        market.base_rate_bps,
        market.slope1_bps,
        market.kink_bps,
        market.slope2_bps,
        market.reserve_factor_bps,
    )
}

public fun admin_market_id(cap: &AdminCap): ID {
    cap.market_id
}

// ── disclosure (the honesty surface the app must render) ────────────────────

/// The on-chain disclosure. A front-end that can read the APY can read this.
public fun disclosure(): String {
    string::utf8(DISCLOSURE)
}

/// FALSE. Borrowing here is uncollateralised.
public fun is_collateralised(): bool {
    false
}

/// FALSE. There is no liquidation mechanism; supplier principal is at risk to default.
public fun has_liquidations(): bool {
    false
}

/// TRUE. Aphotic deployed and operates this market; it is not an independent venue.
public fun is_operator_deployed(): bool {
    true
}

public fun minimum_locked_shares(): u64 {
    MINIMUM_LOCKED_SHARES
}

public fun index_scale(): u128 {
    INDEX_SCALE
}

public fun ms_per_year(): u64 {
    MS_PER_YEAR
}

public fun bps_denominator(): u64 {
    BPS_DENOMINATOR
}

// ── test-only surface ───────────────────────────────────────────────────────

#[test_only]
public fun new_market_for_testing(ctx: &mut TxContext): (Market, AdminCap) {
    new_market(coin::create_treasury_cap_for_testing<LENDING>(ctx), ctx)
}

#[test_only]
public fun share_for_testing(market: Market) {
    transfer::share_object(market);
}
