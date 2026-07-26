#[test_only]
module aphotic::aphotic_lp_tests;

use aphotic::aphotic_lp;
use aphotic::vault;
use sui::coin;
use sui::test_scenario as ts;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.aphotic_lp
// @phase      1
// @status     DONE
// @spec       move/sources/aphotic_lp.move — @invariant 1..3
// @rules      G10
// @depends    aphotic::aphotic_lp (P1.aphotic_lp) · aphotic::vault (P1.vault)
// @facts      The one-time-witness rule is checked BY THE RUNTIME, at publish, inside
// @facts        `coin_registry::new_currency_with_otw`. A mis-named OTW therefore does not fail
// @facts        `sui move build` — it fails the publish, which is a 20-minute round trip. This
// @facts        file asserts the precondition locally so that trip never has to be taken.
// @implements the three invariants of aphotic_lp.move
// @ac         sui move test aphotic_lp
// @verify     sui move test aphotic_lp
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;
const FEES: address = @0xFEE;

public struct TESTBTC has drop {}
public struct TESTUSD has drop {}

#[test]
/// The publish-time precondition, asserted locally: `APHOTIC_LP` really is a one-time witness.
/// If the struct were renamed, gained a field, or lost `drop`, this fails here instead of
/// aborting inside `init` on chain.
fun the_witness_is_a_genuine_one_time_witness() {
    assert!(sui::types::is_one_time_witness(&aphotic_lp::otw_for_testing()), 0);
}

#[test]
/// @invariant 3 — a share unit and a satoshi are the same magnitude, so no scale conversion
/// exists anywhere between `vault`, `clearing` and `balance`.
fun the_share_matches_the_base_asset_scale() {
    assert!(aphotic_lp::share_decimals() == 8, 0);
}

#[test]
/// @invariant 1 + 2 — genesis mints zero shares, and the cap `vault::create` consumes is
/// accepted. This is the exact call the post-publish PTB makes, with the real share type.
fun the_real_share_type_creates_a_vault() {
    let mut sc = ts::begin(ADMIN);
    let tcap = coin::create_treasury_cap_for_testing<aphotic_lp::APHOTIC_LP>(sc.ctx());
    assert!(coin::total_supply(&tcap) == 0, 0);

    let v = vault::create<TESTBTC, TESTUSD, aphotic_lp::APHOTIC_LP>(
        tcap,
        ADMIN,
        KEEPER,
        FEES,
        sc.ctx(),
    );
    assert!(vault::minted_supply(&v) == 0, 1);
    vault::share(v);

    sc.end();
}
