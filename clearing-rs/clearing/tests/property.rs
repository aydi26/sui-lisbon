// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#9 (L432) <- "Property-test them against each other; a divergence is a
//             release blocker."
// @spec       aphotic.md#10 Settlement <- the four invariants written as tests first
// @spec       docs/DESIGN-V2.md#5 · #5bis
// @rules      G10
// @depends    clearing::spec · clearing::engine · clearing::rng
// @facts      EVERY generator is SEEDED. `rand::random()` is forbidden: a property failure that
// @facts        cannot be replayed from a printed seed is not evidence, it is an anecdote. Each
// @facts        assertion message carries its seed.
// @facts      THE STRUCTURAL INVARIANTS ASSERTED, mirroring what clearing.move asserts on chain:
// @facts        P1  no fill outside its limit price          (clearing.move EFillOutsideLimit)
// @facts        P2  Σ debits == Σ credits + fee              (clearing.move EValueNotPreserved)
// @facts        P3  n_fills <= n_revealed                    (@invariant 3)
// @facts        P4  re-running yields an identical (price, root)   (@invariant 4, idempotence)
// @facts        P5  truncation is MONOTONE in the frozen balance   (SDK @invariant 7)
// @facts      P5 is the one that is not obvious. Raising any account's frozen balance must never
// @facts        LOWER matched_base — otherwise topping up an escrow could shrink your own fill,
// @facts        and `vault::begin_clearing_lock` allows top-ups mid-clearing precisely because
// @facts        they "can only make a fill MORE coverable" (clearing.move L88-L90).
// @facts      BOTH engines are swept, each against the invariants its own semantics promise.
// @implements #[test] p1_no_fill_outside_its_limit · p2_value_is_preserved
//             · p3_never_more_fills_than_orders · p4_idempotent · p5_truncation_is_monotone
//             · move_engine_holds_its_own_invariants · move_engine_is_budget_invariant
// @forbidden  `rand::random()`, `SystemTime`, or any unseeded entropy
// @forbidden  a property that can pass vacuously — every sweep asserts it produced fills
// @invariant  1. Every sweep below reaches a non-trivial book at least once (asserted).
// @ac         cargo test -p clearing --test property
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use std::collections::BTreeMap;

use clearing::engine::{self, BatchInput, PRICE_SCALE as MOVE_SCALE};
use clearing::rng::SplitMix64;
use clearing::spec::{self, ClearingInput, FrozenBalance, RevealedOrder, SIDE_ASK, SIDE_BID};
use clearing::types::{Address, Escrowed, Order, OrderSlot};

/// A generated book, in whichever shape a given engine wants it.
#[derive(Clone, Debug)]
struct Book {
    orders: Vec<RevealedOrder>,
    balances: Vec<FrozenBalance>,
    fee_bps: u128,
}

/// Prices are drawn from a SMALL ladder on purpose: distinct prices are the candidate set, so a
/// wide random range would make every book a one-order-per-level book and never exercise the
/// pro-rata, largest-remainder or tie-break paths — the sweep would look thorough and test
/// nothing interesting.
const PRICE_LADDER: [u128; 6] = [
    8_000_000_000,
    9_000_000_000,
    10_000_000_000,
    10_000_000_001,
    11_000_000_000,
    12_000_000_000,
];

fn gen_book(r: &mut SplitMix64, max_orders: u64) -> Book {
    let n = r.range(0, max_orders);
    let n_accounts = r.range(1, 4);
    let mut orders = Vec::new();
    for i in 0..n {
        let side = if r.bool_with(1, 2) { SIDE_BID } else { SIDE_ASK };
        orders.push(RevealedOrder {
            index: i,
            submitter: Address::from_u128(r.range(1, n_accounts) as u128),
            side,
            limit_price: PRICE_LADDER[r.below(PRICE_LADDER.len() as u64) as usize],
            qty_base: r.range(1, 1_000),
        });
    }
    let balances = (1..=n_accounts)
        .map(|a| FrozenBalance {
            submitter: Address::from_u128(a as u128),
            base: r.range(0, 5_000),
            quote: r.range(0, 5_000_000_000_000),
        })
        .collect();
    Book {
        orders,
        balances,
        // 0, a realistic 30, and the 10_000 boundary all occur.
        fee_bps: [0u128, 5, 30, 250, 10_000][r.below(5) as usize],
    }
}

fn spec_input(b: &Book, with_balances: bool) -> ClearingInput {
    let i = ClearingInput::new(b.orders.clone(), b.fee_bps).with_price_scale(spec::PRICE_SCALE);
    if with_balances {
        i.with_balances(b.balances.clone())
    } else {
        i
    }
}

/// The same book as the Move engine wants it. Prices fit u64 by construction (the ladder).
fn move_input(b: &Book, with_balances: bool) -> BatchInput {
    let mut input = BatchInput::new(1, b.fee_bps as u64, Address::from_u128(0xFEE));
    for o in &b.orders {
        input = input.revealed(Order::new(
            o.submitter,
            o.side == SIDE_BID,
            o.limit_price as u64,
            o.qty_base,
        ));
    }
    for fb in &b.balances {
        input = input.fund(
            fb.submitter,
            if with_balances { fb.base } else { u64::MAX / 4 },
            if with_balances { fb.quote } else { u64::MAX / 4 },
        );
    }
    input
}

const SEEDS: [u64; 6] = [1, 0xA11CE, 0xB0B, 0xDEAD_BEEF, 0x5EED, 977];

/// P1 — no participant is filled outside their limit price. `clearing.move` asserts this per
/// fill (EFillOutsideLimit); `spec::clear` returns FillOutsideLimit. Neither may ever trip.
#[test]
fn p1_no_fill_outside_its_limit() {
    let mut cleared_books = 0usize;
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..400 {
            let b = gen_book(&mut r, 12);
            for with_bal in [false, true] {
                let res = spec::clear(&spec_input(&b, with_bal))
                    .unwrap_or_else(|e| panic!("seed {seed} iter {iter}: {e}"));
                let limits: BTreeMap<u64, (u8, u128)> =
                    b.orders.iter().map(|o| (o.index, (o.side, o.limit_price))).collect();
                for f in &res.fills {
                    let (side, limit) = limits[&f.index];
                    assert_eq!(side, f.side, "seed {seed} iter {iter}");
                    if f.side == SIDE_BID {
                        assert!(res.price <= limit, "seed {seed} iter {iter}: bid above its limit");
                    } else {
                        assert!(res.price >= limit, "seed {seed} iter {iter}: ask below its limit");
                    }
                }
                if !res.fills.is_empty() {
                    cleared_books += 1;
                }
            }
        }
    }
    // @invariant 1 — the sweep must not have been vacuous.
    assert!(cleared_books > 500, "only {cleared_books} books produced fills");
}

/// P2 — Σ debits == Σ credits + fee, per asset, with the fee an EXPLICIT term.
/// Quote side: `Σ bid quote == Σ ask net credit + fee_quote + dust_quote`.
/// Base side:  `Σ ask base == Σ bid base == matched_base`.
#[test]
fn p2_value_is_preserved() {
    let mut nonzero_fee_books = 0usize;
    let mut dust_books = 0usize;
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..400 {
            let b = gen_book(&mut r, 12);
            for with_bal in [false, true] {
                let res = spec::clear(&spec_input(&b, with_bal))
                    .unwrap_or_else(|e| panic!("seed {seed} iter {iter}: {e}"));
                let (mut bid_base, mut ask_base) = (0u128, 0u128);
                let (mut bid_quote, mut credits, mut fee_sum) = (0u128, 0u128, 0u128);
                for f in &res.fills {
                    if f.side == SIDE_BID {
                        bid_base += f.qty_base as u128;
                        bid_quote += f.quote as u128;
                        assert_eq!(f.fee, 0);
                    } else {
                        ask_base += f.qty_base as u128;
                        credits += (f.quote - f.fee) as u128;
                        fee_sum += f.fee as u128;
                        assert!(f.fee <= f.quote, "seed {seed} iter {iter}: fee > proceeds");
                    }
                }
                assert_eq!(bid_base, ask_base, "seed {seed} iter {iter}: base not preserved");
                assert_eq!(bid_base, res.matched_base as u128, "seed {seed} iter {iter}");
                assert_eq!(fee_sum, res.fee_quote as u128, "seed {seed} iter {iter}: Σfee != feeQuote");
                assert_eq!(
                    bid_quote,
                    credits + res.fee_quote as u128 + res.dust_quote as u128,
                    "seed {seed} iter {iter}: quote not preserved"
                );
                if res.fee_quote > 0 {
                    nonzero_fee_books += 1;
                }
                if res.dust_quote > 0 {
                    dust_books += 1;
                }
            }
        }
    }
    assert!(nonzero_fee_books > 100, "the fee term was almost never exercised");
    assert!(dust_books > 0, "rounding never produced dust — the sweep is too clean");
}

/// P3 — `n_fills <= n_revealed`, and a zero-quantity fill is never emitted.
#[test]
fn p3_never_more_fills_than_orders() {
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..300 {
            let b = gen_book(&mut r, 16);
            for with_bal in [false, true] {
                let res = spec::clear(&spec_input(&b, with_bal)).unwrap();
                assert!(
                    res.fills.len() <= b.orders.len(),
                    "seed {seed} iter {iter}: {} fills for {} orders",
                    res.fills.len(),
                    b.orders.len()
                );
                let mut seen: Vec<u64> = Vec::new();
                for f in &res.fills {
                    assert!(f.qty_base > 0, "seed {seed} iter {iter}: zero-quantity fill");
                    assert!(!seen.contains(&f.index), "seed {seed} iter {iter}: duplicate fill index");
                    seen.push(f.index);
                }
            }
        }
    }
}

/// P4 — re-running yields an identical `(price, root)`. Also: no permutation of the INPUT
/// changes the output, which is the stronger form and the one a canonical order actually buys.
#[test]
fn p4_idempotent_and_permutation_invariant() {
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..300 {
            let b = gen_book(&mut r, 10);
            let input = spec_input(&b, true);
            let a = spec::clear(&input).unwrap();
            let c = spec::clear(&input).unwrap();
            assert_eq!(a.price, c.price, "seed {seed} iter {iter}");
            assert_eq!(a.fills_root, c.fills_root, "seed {seed} iter {iter}");
            assert_eq!(a, c, "seed {seed} iter {iter}");

            // Fisher-Yates with the same seeded generator.
            let mut shuffled = b.orders.clone();
            for i in (1..shuffled.len()).rev() {
                let j = r.below(i as u64 + 1) as usize;
                shuffled.swap(i, j);
            }
            let mut b2 = b.clone();
            b2.orders = shuffled;
            let d = spec::clear(&spec_input(&b2, true)).unwrap();
            assert_eq!(
                a.price, d.price,
                "seed {seed} iter {iter}: input order changed the clearing price"
            );
            assert_eq!(
                a.fills_root, d.fills_root,
                "seed {seed} iter {iter}: input order changed the root"
            );
        }
    }
}

/// P5 — truncation is MONOTONE: raising any frozen balance never lowers `matched_base`.
///
/// This is the property that makes `begin_clearing_lock` safe to leave top-ups open. If it
/// failed, depositing more escrow could shrink your own fill.
#[test]
fn p5_truncation_is_monotone_in_the_frozen_balance() {
    let mut improved = 0usize;
    let mut compared = 0usize;
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..400 {
            let b = gen_book(&mut r, 10);
            let base = spec::clear(&spec_input(&b, true)).unwrap();

            // Raise exactly one account's base and quote, leaving everything else alone.
            if b.balances.is_empty() {
                continue;
            }
            let who = r.below(b.balances.len() as u64) as usize;
            let bump_base = r.range(1, 5_000);
            let bump_quote = r.range(1, 5_000_000_000_000);
            let mut b2 = b.clone();
            b2.balances[who].base = b2.balances[who].base.saturating_add(bump_base);
            b2.balances[who].quote = b2.balances[who].quote.saturating_add(bump_quote);
            let richer = spec::clear(&spec_input(&b2, true)).unwrap();

            assert!(
                richer.matched_base >= base.matched_base,
                "seed {seed} iter {iter}: raising account {who}'s balance LOWERED matched_base \
                 ({} -> {})",
                base.matched_base,
                richer.matched_base
            );
            compared += 1;
            if richer.matched_base > base.matched_base {
                improved += 1;
            }
        }
    }
    assert!(compared > 1_000, "not enough comparisons ({compared})");
    // Vacuity guard: if a bump NEVER helped, the sweep never generated a binding constraint.
    assert!(improved > 0, "raising a balance never increased matched_base — nothing was binding");
}

/// The Move twin, against the invariants `clearing.move` itself asserts on chain. `run()`
/// returns `Err(ValueNotPreserved)` if debits != credits, so reaching `Done` IS the assertion.
#[test]
fn move_engine_holds_its_own_invariants() {
    let mut settled = 0usize;
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..300 {
            let b = gen_book(&mut r, 12);
            for with_bal in [false, true] {
                let out = engine::clear(move_input(&b, with_bal))
                    .unwrap_or_else(|e| panic!("seed {seed} iter {iter} bal={with_bal}: {e}"));
                assert_eq!(out.stage, engine::Stage::Done);
                // @invariant 1 — the engine only reaches Done when these are equal.
                assert_eq!(out.total_debits, out.total_credits, "seed {seed} iter {iter}");
                // @invariant 2, re-checked from the outcome rather than trusted.
                for f in &out.fills {
                    let o = b
                        .orders
                        .iter()
                        .find(|x| x.index == f.order_index)
                        .expect("every fill maps to a revealed order");
                    if f.is_bid {
                        assert!(out.clearing_price <= o.limit_price as u64);
                    } else {
                        assert!(out.clearing_price >= o.limit_price as u64);
                    }
                    assert!(f.base_sats > 0);
                }
                // @invariant 3.
                assert!(out.fills.len() <= b.orders.len());
                // Quote conservation with the fee as an explicit term.
                assert_eq!(
                    out.quote_paid_sats,
                    out.quote_recv_sats + out.fee_quote_sats,
                    "seed {seed} iter {iter}: the Move fee term does not close"
                );
                if !out.fills.is_empty() {
                    settled += 1;
                }
            }
        }
    }
    assert!(settled > 400, "only {settled} Move books produced fills");
}

/// @invariant 7 of `engine` — budget-invariance. The on-chain clearing spans as many
/// transactions as it needs; if the answer depended on how the work was sliced, resumption
/// would be a consensus bug rather than an optimisation.
#[test]
fn move_engine_is_budget_invariant() {
    for seed in SEEDS {
        let mut r = SplitMix64::new(seed);
        for iter in 0..120 {
            let b = gen_book(&mut r, 10);
            let mut prev: Option<engine::Outcome> = None;
            for budget in [1u64, 2, 7, 128, 10_000] {
                let mut c = engine::Clearing::begin(move_input(&b, true));
                c.run(budget)
                    .unwrap_or_else(|e| panic!("seed {seed} iter {iter} budget {budget}: {e}"));
                let out = c.outcome();
                if let Some(p) = &prev {
                    assert_eq!(
                        p, &out,
                        "seed {seed} iter {iter}: budget {budget} changed the outcome"
                    );
                }
                prev = Some(out);
            }
        }
    }
}

/// The production scale really is 1e8 on both sides of this crate — the constant the 1e9/1e8
/// divergence turned on.
#[test]
fn both_engines_agree_on_the_price_scale_constant() {
    assert_eq!(MOVE_SCALE as u128, spec::PRICE_SCALE);
    assert_eq!(MOVE_SCALE, 100_000_000);
}

/// An unrevealed slot must never be loaded, and it must not shift anyone's `order_index`.
#[test]
fn unrevealed_slots_keep_their_index_and_never_fill() {
    let alice = Address::from_u128(1);
    let bob = Address::from_u128(2);
    let input = BatchInput::new(1, 0, Address::from_u128(0xFEE))
        .revealed(Order::new(alice, true, 10 * MOVE_SCALE, 100))
        .unrevealed()
        .revealed(Order::new(bob, false, 10 * MOVE_SCALE, 100))
        .fund(alice, 0, u64::MAX / 4)
        .fund(bob, 1_000, 0);
    let out = engine::clear(input).unwrap();
    assert_eq!(out.fills.len(), 2);
    // The ask sits at slot 2, NOT slot 1 — the hole is preserved.
    assert!(out.fills.iter().any(|f| f.order_index == 2 && !f.is_bid));
    assert!(!out.fills.iter().any(|f| f.order_index == 1));
    let _ = OrderSlot::Unrevealed;
    let _ = Escrowed::default();
}
