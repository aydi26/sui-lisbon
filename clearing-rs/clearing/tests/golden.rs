// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       sdk/fixtures/clearing.golden.json <- READ IN PLACE, all 46 cases
// @spec       docs/DESIGN-V2.md#9 L1 <- "ONE fixture file, read by every side"
// @spec       aphotic.md#9 (L432) <- "a divergence is a release blocker"
// @rules      G10
// @depends    clearing::spec · clearing::json · clearing::u256
// @facts      THE FILE IS READ FROM ITS REAL PATH:
// @facts        <CARGO_MANIFEST_DIR>/../../sdk/fixtures/clearing.golden.json
// @facts        A fixture COPIED into this crate would drift, and a drifted fixture that stays
// @facts        green is the exact failure this crate exists to catch. If the path is wrong the
// @facts        test FAILS LOUDLY — it never silently skips.
// @facts      THE SCALE IS TAKEN FROM THE FILE (1e9), never from spec::PRICE_SCALE (1e8). The
// @facts        fixtures pin the algorithm's SCALE-INDEPENDENCE; the production constant is
// @facts        pinned separately in `price_scale_constant_is_1e8`. A fixture that inherits the
// @facts        default re-pins the default — which is how a 1e9-SDK / 1e8-Move split survived
// @facts        46 green cases.
// @facts      ROW FORMATS (fixture `_banner`):
// @facts        order   = [index, submitterKey, side, limitPrice, qtyBase]
// @facts        balance = [submitterKey, base, quote]
// @facts        fill    = [index, side, qtyBase, quote, fee]   in CANONICAL order
// @facts      GENERATED CASES mirror sdk/test/support/clearingFixtures.ts exactly: bidder i gets
// @facts        address 0x…(i+1), asker j gets 0x…(100000+j+1), prices and quantities cycle
// @facts        through their arrays.
// @implements #[test] every_golden_case · price_scale_constant_is_1e8 · fixture_is_the_shared_file
//             · per_case_value_conservation · idempotence_over_every_case
// @forbidden  copying the fixture file into this crate
// @forbidden  skipping a case for any reason — an unhandled shape must fail
// @invariant  1. Every case's price, matchedBase, matchedQuote, feeQuote, dustQuote,
//                matchedBaseBeforeTruncation, every fill row and the fillsRoot match.
// @invariant  2. Every expectThrow case fails with an error whose text contains the pinned
//                substring.
// @invariant  3. Re-running any case yields an identical (price, fills, root).
// @ac         cargo test -p clearing --test golden
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use std::collections::BTreeMap;
use std::path::PathBuf;

use clearing::hash::hex;
use clearing::json::{self, Json};
use clearing::spec::{
    self, ClearingInput, Fill, FrozenBalance, RevealedOrder, SIDE_ASK, SIDE_BID,
};
use clearing::types::Address;

/// The shared fixture, read from `sdk/fixtures/` — never a copy.
fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("sdk")
        .join("fixtures")
        .join("clearing.golden.json")
}

fn load() -> Json {
    let p = fixture_path();
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| {
        panic!(
            "could not read the SHARED fixture at {}: {e}\n\
             This test must read sdk/fixtures/clearing.golden.json in place. A copy inside \
             clearing-rs would drift, which is the failure this crate exists to catch.",
            p.display()
        )
    });
    json::parse(&text).unwrap_or_else(|e| panic!("fixture is not valid JSON: {e}"))
}

fn text(v: &Json) -> &str {
    v.as_scalar_text()
        .unwrap_or_else(|| panic!("expected a scalar, got {v:?}"))
}

fn u128_of(v: &Json) -> u128 {
    let s = text(v);
    s.parse::<u128>()
        .unwrap_or_else(|_| panic!("not a u128: {s}"))
}

fn u64_of(v: &Json) -> u64 {
    let s = text(v);
    s.parse::<u64>()
        .unwrap_or_else(|_| panic!("not a u64: {s}"))
}

fn addr_from_hex(s: &str) -> Address {
    let h = s.strip_prefix("0x").unwrap_or(s);
    assert!(h.len() <= 64, "address too long: {s}");
    let padded = format!("{h:0>64}");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16)
            .unwrap_or_else(|_| panic!("bad address hex: {s}"));
    }
    Address(out)
}

/// `sdk/test/support/clearingFixtures.ts#syntheticAddress` — 0x…0001, 0x…0002, …
fn synthetic_address(n: u128) -> Address {
    Address::from_u128(n)
}

struct Case {
    name: String,
    orders: Vec<RevealedOrder>,
    balances: Option<Vec<FrozenBalance>>,
    fee_bps: u128,
    expect_throw: Option<String>,
    expect: Option<Json>,
    /// index -> submitter, so an expected fill row can be resolved back to its account.
    by_index: BTreeMap<u64, Address>,
}

fn build_cases(root: &Json) -> Vec<Case> {
    let addresses: BTreeMap<String, Address> = root
        .get("addresses")
        .expect("fixture has an `addresses` map")
        .as_object()
        .expect("`addresses` is an object")
        .iter()
        .map(|(k, v)| (k.clone(), addr_from_hex(v.as_str().expect("address is a string"))))
        .collect();

    root.get("cases")
        .expect("fixture has a `cases` array")
        .as_array()
        .expect("`cases` is an array")
        .iter()
        .map(|c| {
            let name = c.get("name").and_then(Json::as_str).expect("case has a name").to_string();
            let fee_bps = u128_of(c.get("feeMatchedBps").expect("case has feeMatchedBps"));

            let orders: Vec<RevealedOrder> = if let Some(g) = c.get("generate") {
                // Mirrors buildOrders()'s generated branch, exactly.
                let bid_count = g.get("bidCount").and_then(Json::as_usize).unwrap();
                let ask_count = g.get("askCount").and_then(Json::as_usize).unwrap();
                let arr = |k: &str| -> Vec<String> {
                    g.get(k)
                        .and_then(Json::as_array)
                        .unwrap()
                        .iter()
                        .map(|v| text(v).to_string())
                        .collect()
                };
                let (bp, ap, bq, aq) =
                    (arr("bidPrices"), arr("askPrices"), arr("bidQtys"), arr("askQtys"));
                let mut out = Vec::with_capacity(bid_count + ask_count);
                for i in 0..bid_count {
                    out.push(RevealedOrder {
                        index: out.len() as u64,
                        submitter: synthetic_address(i as u128 + 1),
                        side: SIDE_BID,
                        limit_price: bp[i % bp.len()].parse().unwrap(),
                        qty_base: bq[i % bq.len()].parse().unwrap(),
                    });
                }
                for j in 0..ask_count {
                    out.push(RevealedOrder {
                        index: out.len() as u64,
                        submitter: synthetic_address(100_000 + j as u128 + 1),
                        side: SIDE_ASK,
                        limit_price: ap[j % ap.len()].parse().unwrap(),
                        qty_base: aq[j % aq.len()].parse().unwrap(),
                    });
                }
                out
            } else {
                c.get("orders")
                    .and_then(Json::as_array)
                    .unwrap_or(&[])
                    .iter()
                    .map(|row| {
                        let r = row.as_array().expect("order row is an array");
                        RevealedOrder {
                            index: u64_of(&r[0]),
                            submitter: *addresses
                                .get(r[1].as_str().expect("address key is a string"))
                                .expect("fixture references a known address key"),
                            side: u64_of(&r[2]) as u8,
                            limit_price: u128_of(&r[3]),
                            qty_base: u64_of(&r[4]),
                        }
                    })
                    .collect()
            };

            let balances = c.get("balances").and_then(Json::as_array).map(|rows| {
                rows.iter()
                    .map(|row| {
                        let r = row.as_array().expect("balance row is an array");
                        FrozenBalance {
                            submitter: *addresses
                                .get(r[0].as_str().expect("address key is a string"))
                                .expect("fixture references a known address key"),
                            base: u64_of(&r[1]),
                            quote: u64_of(&r[2]),
                        }
                    })
                    .collect()
            });

            let by_index = orders.iter().map(|o| (o.index, o.submitter)).collect();

            Case {
                name,
                orders,
                balances,
                fee_bps,
                expect_throw: c.get("expectThrow").and_then(Json::as_str).map(str::to_string),
                expect: c.get("expect").cloned(),
                by_index,
            }
        })
        .collect()
}

fn input_for(c: &Case, scale: u128) -> ClearingInput {
    let mut i = ClearingInput::new(c.orders.clone(), c.fee_bps).with_price_scale(scale);
    if let Some(b) = &c.balances {
        i = i.with_balances(b.clone());
    }
    i
}

/// The file must be the shared one, and it must be the one the SDK suite describes.
#[test]
fn fixture_is_the_shared_file() {
    let p = fixture_path();
    assert!(
        p.exists(),
        "the shared fixture is missing at {}. This crate must NOT carry its own copy.",
        p.display()
    );
    let canon = p.canonicalize().expect("fixture path resolves");
    let s = canon.to_string_lossy().replace('\\', "/");
    assert!(
        s.ends_with("sdk/fixtures/clearing.golden.json"),
        "resolved to an unexpected file: {s}"
    );
    let root = load();
    let cases = build_cases(&root);
    assert_eq!(cases.len(), 46, "the fixture is documented as 46 cases");
}

/// The PRODUCTION scale is 1e8 and the FIXTURE scale is not — that difference is deliberate,
/// and asserting it is what stops the fixtures from silently re-pinning a default.
#[test]
fn price_scale_constant_is_1e8_and_the_fixtures_use_another() {
    assert_eq!(spec::PRICE_SCALE, 100_000_000);
    let root = load();
    let file_scale = u128_of(root.get("priceScale").expect("fixture pins a priceScale"));
    assert_eq!(file_scale, 1_000_000_000);
    assert_ne!(file_scale, spec::PRICE_SCALE);
    assert_eq!(spec::MAX_BATCH_SIZE, 256);
    assert_eq!(spec::HARD_MAX_BATCH_SIZE, 512);
    assert_eq!(SIDE_BID, 0);
    assert_eq!(SIDE_ASK, 1);
}

/// @invariant 1 and 2 — every case, no skips.
#[test]
fn every_golden_case() {
    let root = load();
    let scale = u128_of(root.get("priceScale").unwrap());
    let cases = build_cases(&root);

    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for c in &cases {
        let input = input_for(c, scale);
        let got = spec::clear(&input);

        if let Some(want) = &c.expect_throw {
            match got {
                Ok(_) => failures.push(format!("{}: expected a throw containing {want:?}, got Ok", c.name)),
                Err(e) => {
                    let msg = e.to_string();
                    if !msg.contains(want.as_str()) {
                        failures.push(format!("{}: error {msg:?} does not contain {want:?}", c.name));
                    }
                }
            }
            checked += 1;
            continue;
        }

        let r = match got {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{}: unexpected error {e}", c.name));
                continue;
            }
        };
        let e = c.expect.as_ref().unwrap_or_else(|| panic!("{}: no expect block", c.name));

        let mut cmp = |field: &str, got: String, want: &Json| {
            let w = text(want);
            if got != w {
                failures.push(format!("{}: {field} = {got}, fixture says {w}", c.name));
            }
        };
        cmp("price", r.price.to_string(), e.get("price").unwrap());
        cmp("matchedBase", r.matched_base.to_string(), e.get("matchedBase").unwrap());
        cmp("matchedQuote", r.matched_quote.to_string(), e.get("matchedQuote").unwrap());
        cmp("feeQuote", r.fee_quote.to_string(), e.get("feeQuote").unwrap());
        cmp("dustQuote", r.dust_quote.to_string(), e.get("dustQuote").unwrap());
        cmp(
            "matchedBaseBeforeTruncation",
            r.matched_base_before_truncation.to_string(),
            e.get("matchedBaseBeforeTruncation").unwrap(),
        );
        let want_cleared = e.get("cleared").and_then(Json::as_bool).unwrap();
        if r.cleared != want_cleared {
            failures.push(format!("{}: cleared = {}, fixture says {want_cleared}", c.name, r.cleared));
        }

        // The fills, row by row, IN ORDER — the canonical order is part of the commitment.
        let want_rows = e.get("fills").and_then(Json::as_array).unwrap_or(&[]);
        let want_fills: Vec<Fill> = want_rows
            .iter()
            .map(|row| {
                let f = row.as_array().expect("fill row is an array");
                let index = u64_of(&f[0]);
                Fill {
                    index,
                    submitter: *c.by_index.get(&index).unwrap_or_else(|| {
                        panic!("{}: expected fill for unknown order index {index}", c.name)
                    }),
                    side: u64_of(&f[1]) as u8,
                    price: u128_of(e.get("price").unwrap()),
                    qty_base: u64_of(&f[2]),
                    quote: u64_of(&f[3]),
                    fee: u64_of(&f[4]),
                }
            })
            .collect();
        if r.fills != want_fills {
            failures.push(format!(
                "{}: fills differ\n  got  ({}): {:?}\n  want ({}): {:?}",
                c.name,
                r.fills.len(),
                r.fills.iter().take(6).collect::<Vec<_>>(),
                want_fills.len(),
                want_fills.iter().take(6).collect::<Vec<_>>()
            ));
        }
        if let Some(n) = e.get("fillsCount").and_then(Json::as_usize) {
            if r.fills.len() != n {
                failures.push(format!("{}: {} fills, fixture says {n}", c.name, r.fills.len()));
            }
        }

        let want_root = e.get("fillsRoot").and_then(Json::as_str).unwrap();
        let got_root = format!("0x{}", hex(&r.fills_root));
        if got_root != want_root {
            failures.push(format!("{}: root {got_root} != {want_root}", c.name));
        }
        checked += 1;
    }

    assert_eq!(checked, cases.len(), "every case must be evaluated, none skipped");
    assert!(
        failures.is_empty(),
        "{} of {} golden cases disagree with the Rust implementation:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// @invariant 3 — clearing is idempotent, per §5 / aphotic.md §10.
#[test]
fn idempotence_over_every_case() {
    let root = load();
    let scale = u128_of(root.get("priceScale").unwrap());
    for c in build_cases(&root) {
        let input = input_for(&c, scale);
        let a = spec::clear(&input);
        let b = spec::clear(&input);
        match (a, b) {
            (Ok(x), Ok(y)) => assert_eq!(x, y, "{} is not idempotent", c.name),
            (Err(x), Err(y)) => assert_eq!(x, y, "{} errors differently on replay", c.name),
            _ => panic!("{}: one run succeeded and the other did not", c.name),
        }
    }
}

/// The §5 identity, re-derived from the fills of every case rather than trusted from the
/// scalars: base debits == base credits, and quote debits == credits + fee + dust.
#[test]
fn per_case_value_conservation() {
    let root = load();
    let scale = u128_of(root.get("priceScale").unwrap());
    for c in build_cases(&root) {
        if c.expect_throw.is_some() {
            continue;
        }
        let r = spec::clear(&input_for(&c, scale)).unwrap_or_else(|e| panic!("{}: {e}", c.name));
        let limits: BTreeMap<u64, (u8, u128)> =
            c.orders.iter().map(|o| (o.index, (o.side, o.limit_price))).collect();

        let (mut bid_base, mut ask_base) = (0u128, 0u128);
        let (mut bid_quote, mut ask_credit, mut fee_sum) = (0u128, 0u128, 0u128);
        for f in &r.fills {
            assert_eq!(f.price, r.price, "{}: a fill carries a non-uniform price", c.name);
            assert!(f.qty_base > 0, "{}: a zero-quantity fill was emitted", c.name);
            let (side, limit) = limits[&f.index];
            assert_eq!(side, f.side, "{}: fill side does not match its order", c.name);
            if f.side == SIDE_BID {
                assert!(r.price <= limit, "{}: bid filled above its limit", c.name);
                assert_eq!(f.fee, 0, "{}: a bid carries a fee", c.name);
                bid_base += f.qty_base as u128;
                bid_quote += f.quote as u128;
            } else {
                assert!(r.price >= limit, "{}: ask filled below its limit", c.name);
                assert!(f.fee <= f.quote, "{}: fee exceeds proceeds", c.name);
                ask_base += f.qty_base as u128;
                ask_credit += (f.quote - f.fee) as u128;
                fee_sum += f.fee as u128;
            }
        }
        assert_eq!(bid_base, ask_base, "{}: base debits != base credits", c.name);
        assert_eq!(bid_base, r.matched_base as u128, "{}: matchedBase disagrees", c.name);
        assert_eq!(fee_sum, r.fee_quote as u128, "{}: Σ fill.fee != feeQuote", c.name);
        assert_eq!(
            bid_quote,
            ask_credit + r.fee_quote as u128 + r.dust_quote as u128,
            "{}: quote debits != credits + fee + dust",
            c.name
        );
        assert!(
            r.fills.len() <= c.orders.len(),
            "{}: more fills than revealed orders",
            c.name
        );
    }
}
