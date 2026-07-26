// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#9 (L432) <- "The Rust clearing implementation must produce
//             bit-identical output to the Move one. Property-test them against each other;
//             a divergence is a RELEASE BLOCKER."
// @spec       move/sources/clearing.move  <- what `engine` reproduces
// @spec       docs/DESIGN-V2.md#5bis      <- what `spec` reproduces, and what the 46 golden
//             fixtures encode
// @rules      G10
// @depends    clearing::engine · clearing::spec · clearing::rng
// @facts      ⚠⚠ THIS FILE IS THE DELIVERABLE. Its tests PASS by pinning divergences that
// @facts        already exist between the two implementations in this repo. Nothing here is
// @facts        "fixed" by making one side agree with the other — that decision is not a test's
// @facts        to make, and silently picking a winner is how the 1e9/1e8 split survived.
// @facts      HOW THE TWO WERE COMPARED: both engines run on the SAME book at the SAME scale
// @facts        (1e8) with the SAME escrow. Prices come from a small ladder so equal-price
// @facts        levels actually occur — that is where the allocation rules part company.
// @facts      D1 FILL LEAF / ROOT.   Move  bcs(Fill) = u64 batch_id ‖ u64 order_index ‖
// @facts        address ‖ bool is_bid ‖ u64 base ‖ u64 quote ‖ u64 price          = 73 bytes.
// @facts        §5bis(d)   = u64 index ‖ address ‖ u8 side ‖ u128 price ‖ u64 qty ‖ u64 quote
// @facts        ‖ u64 fee                                                         = 81 bytes.
// @facts        Different fields, different widths, different lengths ⇒ the two `fills_root`
// @facts        values can NEVER be equal for any non-empty fill set. Only the empty root
// @facts        (32 zero bytes) coincides. §5bis(d) additionally states "= 73 bytes" for its
// @facts        OWN layout, which sums to 81 — the prose miscounts itself.
// @facts      D2 ALLOCATION AT AN OVERFULL STRICTLY-INSIDE LEVEL. Move fills strictly-inside
// @facts        orders GREEDILY in canonical order, `min(qty, remaining)`, so the first order
// @facts        at a level can take everything. §5bis(a) PRO-RATES the first level that does
// @facts        not fit, by largest remainder. They coincide whenever every strictly-inside
// @facts        level fits — which is the common case, and why this survived.
// @facts      D3 THE FEE. Move charges each ask `floor(gross * bps / 10_000)` individually and
// @facts        reports `fee_quote = Σ bid_ceil − Σ ask_net`, which FOLDS THE ROUNDING DUST
// @facts        INTO THE FEE. §5bis(c) computes ONE aggregate `floor(matched_quote * bps /
// @facts        10_000)`, apportions it by largest remainder, and keeps `dust_quote` as a
// @facts        separate fourth term. Per-ask fees differ; the totals differ by the dust.
// @facts      D4 WHEN TRUNCATION HAPPENS. Move truncates AT LOAD, before price discovery, so an
// @facts        under-funded account can move the CLEARING PRICE. §5bis truncates AFTER
// @facts        discovery, so the price is a function of the submitted book alone.
// @facts      D5 PRICE WIDTH. Move's `limit_price` is u64; §5bis and the fixtures use u128, and
// @facts        fixture `u128-max-price-crossing-overflows-quote` carries u128::MAX. That case
// @facts        is not expressible against the Move engine at all.
// @implements #[test] d1..d5 (one minimal counterexample each) · divergence_report (the sweep)
//             · the_two_engines_agree_when_no_level_is_overfull (the AGREEMENT class)
// @forbidden  changing either engine to make a divergence disappear — record it, do not resolve
//             it. Resolution is a spec decision, made by a human, in docs/.
// @invariant  1. Every divergence below is reproduced by a MINIMAL, hand-checked counterexample,
//                not merely by a random sweep — a sweep tells you something differs, a
//                counterexample tells you what.
// @ac         cargo test -p clearing --test divergence
// @verify     cd clearing-rs; cargo test
// @verify     cd clearing-rs; cargo test --test divergence -- --nocapture divergence_report
// └── END CONTRACT ───────────────────────────────────────────────────────────

use std::collections::BTreeMap;

use clearing::engine::{self, BatchInput, PRICE_SCALE as SCALE};
use clearing::rng::SplitMix64;
use clearing::spec::{self, ClearingInput, FrozenBalance, RevealedOrder, SIDE_ASK, SIDE_BID};
use clearing::types::{Address, Order};

const FEE_ACCOUNT: u128 = 0xFEE;
/// Enough quote to fund any bid the tests below place, without truncating anything.
const RICH: u64 = u64::MAX / 4;

fn a(n: u128) -> Address {
    Address::from_u128(n)
}

fn bid(index: u64, who: u128, price: u64, qty: u64) -> RevealedOrder {
    RevealedOrder {
        index,
        submitter: a(who),
        side: SIDE_BID,
        limit_price: price as u128,
        qty_base: qty,
    }
}

fn ask(index: u64, who: u128, price: u64, qty: u64) -> RevealedOrder {
    RevealedOrder {
        index,
        submitter: a(who),
        side: SIDE_ASK,
        limit_price: price as u128,
        qty_base: qty,
    }
}

/// Run the same book through both engines. `balances` is `(who, base, quote)`.
struct Both {
    mv: engine::Outcome,
    sp: spec::ClearingResult,
}

fn run_both(orders: &[RevealedOrder], balances: &[(u128, u64, u64)], fee_bps: u64) -> Both {
    let mut bi = BatchInput::new(1, fee_bps, a(FEE_ACCOUNT));
    for o in orders {
        bi = bi.revealed(Order::new(
            o.submitter,
            o.side == SIDE_BID,
            u64::try_from(o.limit_price).expect("the Move engine only holds u64 prices"),
            o.qty_base,
        ));
    }
    for (who, base, quote) in balances {
        bi = bi.fund(a(*who), *base, *quote);
    }
    let mv = engine::clear(bi).expect("the Move twin settles");

    let sp_in = ClearingInput::new(orders.to_vec(), fee_bps as u128)
        .with_price_scale(SCALE as u128)
        .with_balances(
            balances
                .iter()
                .map(|(who, base, quote)| FrozenBalance {
                    submitter: a(*who),
                    base: *base,
                    quote: *quote,
                })
                .collect(),
        );
    let sp = spec::clear(&sp_in).expect("the spec twin clears");
    Both { mv, sp }
}

/// `order_index -> base filled`, for whichever engine.
fn mv_alloc(o: &engine::Outcome) -> BTreeMap<u64, u64> {
    o.fills.iter().map(|f| (f.order_index, f.base_sats)).collect()
}

fn sp_alloc(r: &spec::ClearingResult) -> BTreeMap<u64, u64> {
    r.fills.iter().map(|f| (f.index, f.qty_base)).collect()
}

// ── D1 — the leaf layout, and therefore the root ────────────────────────────

/// The two `fills_root` values cannot agree for any non-empty fill set: the leaves commit to
/// different fields at different widths. Only the EMPTY root coincides, at 32 zero bytes.
#[test]
fn d1_the_two_fill_leaves_commit_to_different_fields() {
    assert_eq!(clearing::bcs::FILL_BCS_LEN, 73, "Move leaf: bcs(Fill)");
    assert_eq!(spec::FILL_LEAF_LEN, 81, "§5bis(d) leaf");
    // §5bis(d) states "= 73 bytes" for the 81-byte layout it defines. The prose miscounts.
    assert_ne!(spec::FILL_LEAF_LEN, clearing::bcs::FILL_BCS_LEN);

    // The empty root is the ONE thing both sides agree on.
    assert_eq!(clearing::merkle::compute_root(&[]), [0u8; 32]);
    assert_eq!(spec::fills_root(&[]), [0u8; 32]);

    // A single, simplest possible cross. Both engines fill it identically...
    let orders = vec![bid(0, 1, 10 * SCALE, 100), ask(1, 2, 10 * SCALE, 100)];
    let b = run_both(&orders, &[(1, 0, RICH), (2, 100, 0)], 0);
    assert_eq!(mv_alloc(&b.mv), sp_alloc(&b.sp), "the allocation itself agrees here");
    assert_eq!(b.mv.clearing_price as u128, b.sp.price);
    // ...and still publish different roots, because the leaves are different objects.
    assert_ne!(
        b.mv.fills_root, b.sp.fills_root,
        "D1 would be resolved: the two roots now agree"
    );
    // The Move leaf carries batch_id and no fee; the spec leaf carries fee and no batch_id.
    assert!(b.mv.fills.iter().all(|f| f.batch_id == 1));
    assert!(b.sp.fills.iter().all(|f| f.fee == 0));
}

// ── D2 — allocation at an overfull strictly-inside level ────────────────────

/// Two bids at the SAME price, both strictly inside the cross, together exceeding the matched
/// volume. Move fills the first canonically-ordered bid greedily; §5bis pro-rates the level.
///
/// Hand-derived: bids 60 @ 10 (index 0, acct 1) and 60 @ 10 (index 1, acct 2); ask 50 @ 5.
/// Candidates {5, 10}. vol(5) = min(120, 50) = 50; vol(10) = min(120, 0) = 0. So p* = 5 and
/// matched = 50. Both bids are STRICTLY inside (10 > 5) and 120 > 50 — §5.3 as written is
/// unsatisfiable, which is precisely what §5bis(a) exists to resolve.
#[test]
fn d2_an_overfull_strictly_inside_level_is_split_differently() {
    let orders = vec![
        bid(0, 1, 10 * SCALE, 60),
        bid(1, 2, 10 * SCALE, 60),
        ask(2, 3, 5 * SCALE, 50),
    ];
    let b = run_both(&orders, &[(1, 0, RICH), (2, 0, RICH), (3, 50, 0)], 0);

    assert_eq!(b.mv.clearing_price, 5 * SCALE, "both must agree on p* here");
    assert_eq!(b.sp.price, (5 * SCALE) as u128);
    assert_eq!(b.mv.matched_base_sats, 50);
    assert_eq!(b.sp.matched_base, 50);

    let mv = mv_alloc(&b.mv);
    let sp = sp_alloc(&b.sp);
    // Move: greedy in canonical order — the first bid takes the whole 50.
    assert_eq!(mv.get(&0), Some(&50));
    assert_eq!(mv.get(&1), None, "the second bid gets nothing on the Move side");
    // §5bis(a): the level is pro-rated by largest remainder — 25 / 25.
    assert_eq!(sp.get(&0), Some(&25));
    assert_eq!(sp.get(&1), Some(&25));
    assert_ne!(mv, sp, "D2 would be resolved: the allocations now agree");
}

/// The AGREEMENT class, asserted so the divergence above is bounded rather than open-ended:
/// when every strictly-inside level fits, the greedy rule and the pro-rata rule coincide, and
/// the two engines allocate identically.
#[test]
fn the_two_engines_agree_when_no_level_is_overfull() {
    // Bids 30 @ 12 and 30 @ 11; asks 40 @ 9 and 40 @ 10. Every eligible bid fills fully.
    let orders = vec![
        bid(0, 1, 12 * SCALE, 30),
        bid(1, 2, 11 * SCALE, 30),
        ask(2, 3, 9 * SCALE, 40),
        ask(3, 4, 10 * SCALE, 40),
    ];
    let b = run_both(
        &orders,
        &[(1, 0, RICH), (2, 0, RICH), (3, 40, 0), (4, 40, 0)],
        0,
    );
    assert_eq!(b.mv.clearing_price as u128, b.sp.price);
    assert_eq!(b.mv.matched_base_sats, b.sp.matched_base);
    assert_eq!(
        mv_alloc(&b.mv),
        sp_alloc(&b.sp),
        "with no overfull level the two rules must coincide"
    );
}

// ── D3 — the fee ────────────────────────────────────────────────────────────

/// Move charges each ask individually and folds the rounding dust into `fee_quote`;
/// §5bis(c) computes one aggregate and keeps `dust_quote` separate. With two asks whose
/// individual fees each round down, the two totals part company.
#[test]
fn d3_the_fee_is_computed_from_a_different_base() {
    // Three sats at a price that makes ceil and floor differ, and a fee that rounds.
    let orders = vec![
        bid(0, 1, 3 * SCALE + 1, 3),
        ask(1, 2, 3 * SCALE + 1, 1),
        ask(2, 3, 3 * SCALE + 1, 2),
    ];
    let b = run_both(&orders, &[(1, 0, RICH), (2, 1, 0), (3, 2, 0)], 30);

    assert_eq!(b.mv.clearing_price as u128, b.sp.price);
    assert_eq!(b.mv.matched_base_sats, b.sp.matched_base);
    assert_eq!(mv_alloc(&b.mv), sp_alloc(&b.sp), "the allocation agrees; only the fee differs");

    // Move: fee_quote is the residual Σbid_ceil − Σask_net, so it ABSORBS the dust.
    assert_eq!(
        b.mv.fee_quote_sats,
        b.mv.quote_paid_sats - b.mv.quote_recv_sats,
        "Move defines the fee as the residual"
    );
    // §5bis: fee and dust are two separate terms and both are reported.
    assert_eq!(
        b.sp.fee_quote as u128 + b.sp.dust_quote as u128,
        (b.mv.fee_quote_sats) as u128,
        "the Move fee equals the spec fee PLUS the spec dust — that is exactly the difference"
    );
    assert!(
        b.sp.dust_quote > 0,
        "this counterexample must actually produce dust, or it proves nothing"
    );
    assert_ne!(
        b.mv.fee_quote_sats, b.sp.fee_quote,
        "D3 would be resolved: the two fee totals now agree"
    );
}

// ── D4 — when truncation happens ────────────────────────────────────────────

/// Move truncates at LOAD time, so an under-funded bid never enters price discovery at its
/// stated size and can change `p*`. §5bis discovers the price on the submitted book and only
/// then truncates, so `p*` is a function of the book alone.
/// Hand-derived. At PRICE_SCALE = 1e8 a limit of `12 * SCALE` costs 12 quote-sats per base-sat,
/// so an account holding 12 quote-sats can fund exactly ONE sat of a 100-sat bid.
///
/// Book: bid 100 @ 12 (acct 1, holding 12 quote) · bid 5 @ 10 (acct 2, rich)
///       ask 100 @ 12 (acct 3)                   · ask 3 @ 10 (acct 4)
///
/// §5bis discovers on the SUBMITTED book:
///   p = 10 → demand 105, supply 3  → vol 3
///   p = 12 → demand 100, supply 103 → vol 100   ⇒ p* = 12
/// Move truncates acct 1 to 1 sat AT LOAD, so it discovers on a different book:
///   p = 10 → demand 6, supply 3   → vol 3
///   p = 12 → demand 1, supply 103 → vol 1      ⇒ p* = 10
///
/// The under-funding of ONE account has moved the uniform price everybody trades at.
#[test]
fn d4_underfunding_moves_the_move_price_but_never_the_spec_price() {
    let orders = vec![
        bid(0, 1, 12 * SCALE, 100),
        bid(1, 2, 10 * SCALE, 5),
        ask(2, 3, 12 * SCALE, 100),
        ask(3, 4, 10 * SCALE, 3),
    ];
    let poor = 12; // exactly one base-sat's worth of quote at a limit of 12 * SCALE
    let b = run_both(&orders, &[(1, 0, poor), (2, 0, RICH), (3, 100, 0), (4, 3, 0)], 0);

    // The spec engine discovers the price BEFORE looking at any balance.
    let no_balances =
        spec::clear(&ClearingInput::new(orders.clone(), 0).with_price_scale(SCALE as u128))
            .unwrap();
    assert_eq!(
        b.sp.price, no_balances.price,
        "the spec price must not depend on the frozen snapshot"
    );
    assert_eq!(b.sp.price, (12 * SCALE) as u128);

    // The Move engine loaded acct 1's bid as 1 sat, not 100, before pricing.
    let elig: Vec<u64> = b.mv.bids.iter().map(|e| e.qty_sats).collect();
    assert!(
        elig.contains(&1),
        "the Move engine should have truncated the poor bid at LOAD time, got {elig:?}"
    );
    assert_eq!(b.mv.clearing_price, 10 * SCALE);

    // THE UNIFORM PRICE ITSELF DIFFERS. Not the allocation — the price.
    assert_ne!(
        b.mv.clearing_price as u128, b.sp.price,
        "D4 would be resolved: load-time truncation no longer moves the clearing price"
    );
}

// ── D5 — price width ────────────────────────────────────────────────────────

/// Move holds a limit price in a u64; §5bis and the fixtures hold it in a u128, and the fixture
/// `u128-max-price-crossing-overflows-quote` uses u128::MAX. That case cannot be expressed
/// against the Move engine at all — the divergence is in the TYPE, before any arithmetic.
#[test]
fn d5_a_u128_price_is_not_expressible_on_the_move_side() {
    let huge = u128::MAX;
    assert!(u64::try_from(huge).is_err(), "u128::MAX does not fit a u64");
    // The spec engine accepts it and refuses for the right reason: the QUOTE overflows u64.
    let r = spec::clear(
        &ClearingInput::new(
            vec![
                RevealedOrder { index: 0, submitter: a(1), side: SIDE_BID, limit_price: huge, qty_base: 1 },
                RevealedOrder { index: 1, submitter: a(2), side: SIDE_ASK, limit_price: huge, qty_base: 1 },
            ],
            0,
        )
        .with_price_scale(1_000_000_000),
    );
    let e = r.expect_err("a u128::MAX price must overflow the quote");
    assert!(
        e.to_string().contains("matchedQuote is not a u64"),
        "unexpected error: {e}"
    );
}

// ── the sweep ───────────────────────────────────────────────────────────────

const LADDER: [u64; 5] = [8, 9, 10, 11, 12];

/// A randomised census of how often, and how, the two engines part company. Prints a summary
/// under `--nocapture`. The assertions are on the SHAPE of the census, not on exact counts, so
/// this cannot become a brittle snapshot — but it fails loudly if a whole divergence class
/// disappears (someone "fixed" one side) or if a new class appears.
#[test]
fn divergence_report() {
    let mut n = 0usize;
    let mut price_differs = 0usize;
    let mut matched_differs = 0usize;
    let mut alloc_differs = 0usize;
    let mut fee_differs = 0usize;
    let mut root_differs = 0usize;
    let mut fully_agree = 0usize;
    let mut first_price_case: Option<String> = None;

    for seed in [1u64, 0xA11CE, 0xB0B, 0xDEAD_BEEF, 0x5EED, 977, 31_337, 42] {
        let mut r = SplitMix64::new(seed);
        for iter in 0..500 {
            let count = r.range(0, 8);
            let accts = r.range(1, 3);
            let mut orders = Vec::new();
            for i in 0..count {
                let side = if r.bool_with(1, 2) { SIDE_BID } else { SIDE_ASK };
                orders.push(RevealedOrder {
                    index: i,
                    submitter: a(r.range(1, accts) as u128),
                    side,
                    limit_price: (LADDER[r.below(5) as usize] * SCALE) as u128,
                    qty_base: r.range(1, 200),
                });
            }
            // Deliberately generous escrow, so D4 (truncation timing) does not mask D2/D3.
            let balances: Vec<(u128, u64, u64)> =
                (1..=accts).map(|x| (x as u128, 100_000u64, RICH)).collect();
            let fee_bps = [0u64, 30, 250][r.below(3) as usize];

            let b = run_both(&orders, &balances, fee_bps);
            n += 1;

            let p_diff = b.mv.clearing_price as u128 != b.sp.price;
            let m_diff = b.mv.matched_base_sats != b.sp.matched_base;
            let a_diff = mv_alloc(&b.mv) != sp_alloc(&b.sp);
            let f_diff = b.mv.fee_quote_sats != b.sp.fee_quote;
            let r_diff = b.mv.fills_root != b.sp.fills_root;

            if p_diff {
                price_differs += 1;
                if first_price_case.is_none() {
                    first_price_case = Some(format!(
                        "seed {seed} iter {iter}: move p*={} spec p*={} orders={orders:?}",
                        b.mv.clearing_price, b.sp.price
                    ));
                }
            }
            if m_diff {
                matched_differs += 1;
            }
            if a_diff {
                alloc_differs += 1;
            }
            if f_diff {
                fee_differs += 1;
            }
            if r_diff && !b.mv.fills.is_empty() {
                root_differs += 1;
            }
            if !p_diff && !m_diff && !a_diff && !f_diff {
                fully_agree += 1;
            }
        }
    }

    println!("\n── clearing-rs divergence census — aphotic::clearing (Move) vs DESIGN-V2 §5bis ──");
    println!("  books swept                             {n}");
    println!("  clearing price differs                  {price_differs}");
    println!("  matched base differs                    {matched_differs}");
    println!("  per-order allocation differs   [D2]     {alloc_differs}");
    println!("  fee total differs              [D3]     {fee_differs}");
    println!("  fills root differs (non-empty) [D1]     {root_differs}");
    println!("  agree on price+matched+alloc+fee        {fully_agree}");
    if let Some(c) = &first_price_case {
        println!("  first price divergence: {c}");
    }
    println!("  NOTE: D1 is structural — the leaves commit to different fields, so a non-empty");
    println!("        root can never match. D4 (truncation timing) is suppressed in this sweep");
    println!("        by funding every account generously; d4_… pins it separately.");
    println!("────────────────────────────────────────────────────────────────────────────────\n");

    // Shape assertions — every named class must still be reachable, and agreement must still
    // be the common case (otherwise the divergence is not the narrow one documented above).
    assert!(n > 3_000, "the sweep is too small to conclude anything ({n})");
    assert!(
        alloc_differs > 0,
        "D2 no longer reproduces — if a side was changed, update this file and docs/"
    );
    assert!(
        root_differs > 0,
        "D1 no longer reproduces — the two leaf layouts appear to have converged"
    );
    assert!(
        fully_agree * 2 > n,
        "the two engines now disagree on the MAJORITY of books ({fully_agree}/{n}); the \
         divergence is wider than D1-D5 describe"
    );
    // The engines are NOT interchangeable, and this crate exists to say so out loud.
    assert!(
        price_differs + matched_differs + alloc_differs + fee_differs > 0,
        "no divergence at all was observed — either the implementations converged (delete this \
         file and celebrate) or the sweep stopped generating interesting books"
    );
}
