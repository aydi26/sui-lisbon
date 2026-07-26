module aphotic::aphotic_lp;

use std::string;
use sui::coin_registry;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.aphotic_lp
// @phase      1  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#8-fees (L419) <- "LP shares are a fungible `Coin<APHOTIC_LP>`, not a
//             position object — fungible shares stay composable and listable; a bespoke position
//             object traps the liquidity."
// @spec       docs/MOVE-PACKAGE.md:466 <- `vault::create` consumes `TreasuryCap<APHOTIC_LP>`
// @spec       docs/STATUS.md#B26 <- the blocker this module closes: no share coin existed, so no
//             `Vault` could ever be created and the whole runtime object graph was unreachable.
// @rules      G8 (honesty — the disclosure is the coin description) · G10 (sats · u64 · 8 dp)
// @depends    (none — leaf. Deliberately imports no aphotic module: `vault` depends on this type
//             only as its phantom `S`, so a dependency in this direction would be a cycle.)
// @facts      SHARE_DECIMALS = 8 — the share is denominated in the same unit as the base asset it
// @facts        claims. hBTC has 8 decimals (RECON R5) and every amount in this package is
// @facts        satoshis as `u64`, so 1 share unit == 1 sat of claim at genesis NAV.
// @facts      SYMBOL = "avhBTC" · NAME = "Aphotic Vault hBTC Share".
// @facts        Mirrors the sibling `aphotic_lending::lending` share coin `aLhBTC` (FACTS §share
// @facts        coin): `av` = Aphotic vault, `aL` = Aphotic lending.
// @facts      REGISTERED VIA `sui::coin_registry::new_currency_with_otw`, NOT
// @facts        `sui::coin::create_currency` — the latter is DEPRECATED in this framework rev
// @facts        (docs/FACTS.md L864). This is the exact call shape that published successfully
// @facts        for `aphotic_lending::lending` (`Currency<LENDING>` 0xa0b6685d…), so it is a
// @facts        verified shape and not an inferred one.
// @facts      THE METADATA CAP IS DESTROYED IN THE SAME CALL as finalisation, so the description
// @facts        — which IS the G8 disclosure — can never be edited away later.
// @external   public fun sui::coin_registry::new_currency_with_otw<T: drop>(
//                 otw: T, decimals: u8, symbol: String, name: String, description: String,
//                 icon_url: String, ctx: &mut TxContext
//             ): (CurrencyInitializer<T>, TreasuryCap<T>)
//             public fun sui::coin_registry::finalize_and_delete_metadata_cap<T>(
//                 builder: CurrencyInitializer<T>, ctx: &mut TxContext)
//             ⚠ a one-time witness must be named exactly the module name in UPPER CASE, carry
//               only `drop`, and hold no fields. `APHOTIC_LP` in module `aphotic_lp` satisfies
//               all three; get any of them wrong and `init` aborts AT PUBLISH.
// @implements public struct APHOTIC_LP has drop {}
//             fun init(otw: APHOTIC_LP, ctx: &mut TxContext)
//             public fun share_decimals(): u8
// @events     (NONE — and that is not an omission. G10 requires an event per externally-visible
//             STATE TRANSITION; this module has exactly one transition, currency genesis, which
//             `coin_registry` itself publishes as the `Currency<APHOTIC_LP>` object. Every later
//             mint and burn is a `vault` transition and `aphotic::events` emits it there.)
// @errors     (NONE — the module has no failure mode of its own. `init` runs once, at publish.)
// @forbidden  a public mint, a public `TreasuryCap` accessor, or any second holder of the cap.
//             `init` hands the cap to the publisher exactly once and `vault::create` consumes it
//             BY VALUE; after that call nothing in the universe can mint a share except the
//             vault itself (vault.move @invariant "supply drift").
// @forbidden  `sui::coin::create_currency` — deprecated in this framework rev; using it is how a
//             package compiles and then publishes a currency the explorer will not index.
// @invariant  1. `init` mints ZERO shares. `vault::create` asserts `total_supply == 0`
//                (ELpSupplyNotZero), so a pre-minted cap is rejected at genesis rather than
//                silently diluting the first depositor.
// @invariant  2. Exactly one `TreasuryCap<APHOTIC_LP>` exists, and it is consumed by value by
//                `vault::create`. There is no path that produces a second one.
// @invariant  3. `share_decimals()` == 8 == hBTC's decimals, so shares and sats never need a
//                scale conversion anywhere in the package.
// @ac         move/tests/aphotic_lp_tests.move — the OTW is a genuine one-time witness (the
//             publish-time precondition) and the decimals match the base asset.
// @verify     sui move build
// @verify     sui move test aphotic_lp
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── constants ───────────────────────────────────────────────────────────────

/// Same as hBTC (RECON R5) — a share unit and a satoshi are the same magnitude, so no scale
/// conversion exists anywhere between `vault`, `clearing` and `balance`.
const SHARE_DECIMALS: u8 = 8;

const SYMBOL: vector<u8> = b"avhBTC";
const NAME: vector<u8> = b"Aphotic Vault hBTC Share";

// ── the disclosure, on-chain ────────────────────────────────────────────────

/// G8, unedited and unedittable: the metadata cap is destroyed in the same transaction that
/// writes this, so the honest description travels with the coin forever.
const DISCLOSURE: vector<u8> =
    b"A claim on the Aphotic vault, denominated in satoshis of hBTC. hBTC is custodial-threshold wrapped Bitcoin issued by Hashi's guardian set - holding this share is holding that trust assumption, not native BTC. The share is redeemable only at an admin-approved NAV, asynchronously, and its value moves with the vault's market-making and carry results. Not principal-protected.";

// ── types ───────────────────────────────────────────────────────────────────

/// One-time witness. The LP share coin type: `Coin<APHOTIC_LP>`, symbol `avhBTC`.
///
/// The name is load-bearing — `sui::types::is_one_time_witness` requires it to be the module
/// name (`aphotic_lp`) in upper case, with `drop` and no fields.
public struct APHOTIC_LP has drop {}

// ── genesis ─────────────────────────────────────────────────────────────────

/// Runs exactly once, at publish. Registers the currency, destroys the metadata cap so the
/// disclosure above is permanent, and hands the `TreasuryCap` to the publisher — who spends it
/// immediately on `vault::create`, which consumes it by value (@invariant 2).
///
/// The cap is transferred rather than used here because `vault::create<B, Q, S>` also needs the
/// base and quote types, and those are external (hBTC / DBUSDC) and unknowable at publish time.
#[allow(lint(self_transfer))]
fun init(otw: APHOTIC_LP, ctx: &mut TxContext) {
    let (builder, treasury) = coin_registry::new_currency_with_otw(
        otw,
        SHARE_DECIMALS,
        string::utf8(SYMBOL),
        string::utf8(NAME),
        // The description IS the disclosure. It travels with the coin.
        string::utf8(DISCLOSURE),
        string::utf8(b""),
        ctx,
    );
    // Metadata finalised and the metadata cap destroyed in the same call: the disclosure can
    // never be edited away later.
    coin_registry::finalize_and_delete_metadata_cap(builder, ctx);

    // Zero shares minted (@invariant 1) — `vault::create` asserts exactly that.
    transfer::public_transfer(treasury, ctx.sender());
}

// ── read surface ────────────────────────────────────────────────────────────

public fun share_decimals(): u8 { SHARE_DECIMALS }

// ── test-only helpers ───────────────────────────────────────────────────────

/// The witness value, so the one-time-witness precondition can be asserted in a test rather than
/// discovered at publish.
#[test_only]
public fun otw_for_testing(): APHOTIC_LP { APHOTIC_LP {} }
