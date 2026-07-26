// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#5      <- canonical order · price discovery · allocation ·
//             limit safety · quote conversion · root · the explicit fee term
// @spec       docs/DESIGN-V2.md#5bis   <- (a) price-priority allocation, (b) the denomination,
//             (c) fee apportionment by largest remainder, (d) the FillLeaf byte layout and the
//             32-zero-byte empty root. THESE RESOLUTIONS, not our own reading of §5.
// @spec       sdk/src/clearing.ts      <- the TypeScript twin this file must agree with
// @spec       sdk/fixtures/clearing.golden.json <- 46 hand-derived cases, read directly
// @spec       aphotic.md#9 (L432) <- "a divergence is a release blocker"
// @rules      G10
// @depends    crate::u256 · crate::hash · crate::types (Address only)
// @facts      ⚠ THIS IS NOT `crate::engine`. `engine` is the line-for-line twin of the DEPLOYED
// @facts        `clearing.move`; this module is the twin of the §5bis SPECIFICATION that the
// @facts        golden fixtures encode. They are NOT the same algorithm today — see
// @facts        clearing/tests/divergence.rs, which enumerates every difference. That gap is the
// @facts        finding this crate exists to produce; it is not papered over here.
// @facts      SIDE_BID = 0 (buys base, pays quote) · SIDE_ASK = 1 (sells base, receives quote)
// @facts      PRICE_SCALE = 100_000_000 (1e8) — pinned against `clearing::price_scale()`, NOT
// @facts        DeepBook's 1e9. The fixtures pass their own scale explicitly (1e9), which is
// @facts        what makes them test SCALE-INDEPENDENCE instead of re-pinning a default. The
// @facts        1e9/1e8 split survived 46 green fixtures precisely because they did not.
// @facts      ALLOCATION (§5bis a): walk price levels in canonical priority; a level that fits
// @facts        fills fully; the FIRST level that does not fit is pro-rated by largest
// @facts        remainder; every later level gets zero.
// @facts      TRUNCATION: 1. cap each order at what its account can afford from the FROZEN
// @facts        snapshot, drawing the account budget down in canonical order; 2. recompute
// @facts        M' = min(Σ bid qty', Σ ask qty'); 3. re-ration the LONGER side down to M' with
// @facts        the same rule. Reduction only, so step 3 cannot break an affordability cap.
// @facts      FEE (§5bis c): ONE aggregate floor(matched_quote * bps / 10_000), distributed
// @facts        across the ask fills by largest remainder so Σ fill.fee == fee_quote exactly.
// @facts      FillLeaf (§5bis d), 81 bytes — NOT the 73 the prose claims, see @invariant 8:
// @facts        u64 index ‖ address(32) ‖ u8 side ‖ u128 price ‖ u64 qty ‖ u64 quote ‖ u64 fee
// @facts        leaf = blake2b256(0x00 ‖ bytes) · node = blake2b256(0x01 ‖ l ‖ r)
// @facts        odd node duplicated · EMPTY fill set roots to 32 ZERO BYTES
// @implements pub const SIDE_BID / SIDE_ASK / PRICE_SCALE / BPS_DENOM
//             pub const MAX_BATCH_SIZE / HARD_MAX_BATCH_SIZE
//             pub struct RevealedOrder · FrozenBalance · ClearingInput · Fill · ClearingResult
//             pub fn quote_for_bid / quote_for_ask / canonical_order / discover_price
//             pub fn largest_remainder · encode_fill_leaf · hash_fill_leaf · fills_root
//             pub fn clear(input: &ClearingInput) -> Result<ClearingResult, SpecError>
// @forbidden  f32/f64 ANYWHERE, including intermediately — docs/DESIGN-V2.md §5.2
// @forbidden  a sort that is not FULLY tie-broken
// @forbidden  reading a wall clock, an env var, or a file — this module is pure
// @invariant  1. No fill outside its limit: bid => p* <= limit, ask => p* >= limit. ASSERTED.
// @invariant  2. Σ base debited (asks) == Σ base credited (bids) == matched_base. ASSERTED.
// @invariant  3. Σ quote debited (bids) == Σ ask net credits + fee_quote + dust_quote. ASSERTED.
// @invariant  4. dust_quote >= 0 — guaranteed by rounding both sides toward the vault.
// @invariant  5. n_fills <= n_orders; a zero-quantity fill is never emitted.
// @invariant  6. Idempotent: clear(x) twice yields identical price, fills and root.
// @invariant  7. Truncation is monotone: raising a frozen balance never lowers matched_base.
// @invariant  8. encode_fill_leaf is 81 bytes. §5bis(d) says "= 73 bytes"; that arithmetic is
//                wrong (8+32+1+16+8+8+8 = 81) and the SDK's own test asserts 81. Recorded here
//                rather than silently matching, because a spec that miscounts its own layout is
//                exactly what a third implementation is for.
// @ac         clearing/tests/golden.rs (all 46 fixture cases) · clearing/tests/property.rs
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use core::fmt;

use crate::hash::blake2b256;
use crate::types::Address;
use crate::u256::{mul_div_ceil, mul_div_floor, U256};

/// Buys base, pays quote.
pub const SIDE_BID: u8 = 0;
/// Sells base, receives quote.
pub const SIDE_ASK: u8 = 1;

/// Production scale — `aphotic::clearing::price_scale()`. 1e8, sats-natural for an 8-decimal
/// asset. NOT DeepBook's 1e9 `FLOAT_SCALING`.
pub const PRICE_SCALE: u128 = 100_000_000;
pub const BPS_DENOM: u128 = 10_000;
/// Governed default (docs/DESIGN-V2.md §2 / D4).
pub const MAX_BATCH_SIZE: usize = 256;
/// Asserted ceiling in the setter.
pub const HARD_MAX_BATCH_SIZE: usize = 512;

pub const LEAF_TAG: u8 = 0x00;
pub const NODE_TAG: u8 = 0x01;

/// The BCS length of a `FillLeaf`. See @invariant 8: this is 81, not the 73 §5bis(d) claims.
pub const FILL_LEAF_LEN: usize = 8 + 32 + 1 + 16 + 8 + 8 + 8;

// ── errors ──────────────────────────────────────────────────────────────────

/// Every variant's `Display` text contains the substring the golden fixtures pin in
/// `expectThrow`, so the Rust test can assert the same failures the TypeScript test does
/// without a translation table that could itself drift.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpecError {
    BatchTooLarge(usize),
    DuplicateOrderIndex(u64),
    ZeroQuantity(u64),
    ZeroPrice(u64),
    BadSide(u8),
    BadFeeBps(u128),
    BadPriceScale,
    NotAU64(&'static str, U256),
    NegativeBalance,
    FillOutsideLimit(u64),
    FeeExceedsProceeds(u64),
    ValueNotPreserved(String),
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecError::BatchTooLarge(n) => write!(
                f,
                "EBatchTooLarge: {n} orders exceeds HARD_MAX_BATCH_SIZE {HARD_MAX_BATCH_SIZE}"
            ),
            SpecError::DuplicateOrderIndex(i) => write!(f, "EDuplicateOrderIndex: {i}"),
            SpecError::ZeroQuantity(i) => write!(f, "EZeroQuantity: order {i}"),
            SpecError::ZeroPrice(i) => write!(f, "EZeroPrice: order {i}"),
            SpecError::BadSide(s) => write!(f, "EBadSide: side {s}"),
            SpecError::BadFeeBps(b) => write!(f, "EBadFeeBps: {b}"),
            SpecError::BadPriceScale => write!(f, "EBadPriceScale"),
            SpecError::NotAU64(what, v) => write!(f, "{what} is not a u64: {v}"),
            SpecError::NegativeBalance => write!(f, "ENegativeBalance"),
            SpecError::FillOutsideLimit(i) => write!(f, "EFillOutsideLimit: order {i}"),
            SpecError::FeeExceedsProceeds(i) => write!(f, "EFeeExceedsProceeds: ask {i}"),
            SpecError::ValueNotPreserved(d) => write!(f, "EValueNotPreserved: {d}"),
        }
    }
}

impl std::error::Error for SpecError {}

// ── inputs and outputs ──────────────────────────────────────────────────────

/// One decrypted order, as `reveal_order` recorded it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct RevealedOrder {
    /// Submission index — the FINAL canonical tie-break.
    pub index: u64,
    pub submitter: Address,
    pub side: u8,
    /// u128, scaled by the input's `price_scale`.
    pub limit_price: u128,
    /// u64 base units (sats for hBTC).
    pub qty_base: u64,
}

/// The per-account snapshot `close_batch` froze.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct FrozenBalance {
    pub submitter: Address,
    pub base: u64,
    pub quote: u64,
}

#[derive(Clone, Debug)]
pub struct ClearingInput {
    pub orders: Vec<RevealedOrder>,
    /// `None` disables truncation entirely — every account is treated as solvent.
    pub balances: Option<Vec<FrozenBalance>>,
    pub fee_matched_bps: u128,
    /// Override only for fixtures. `None` means [`PRICE_SCALE`].
    pub price_scale: Option<u128>,
}

impl ClearingInput {
    pub fn new(orders: Vec<RevealedOrder>, fee_matched_bps: u128) -> Self {
        ClearingInput {
            orders,
            balances: None,
            fee_matched_bps,
            price_scale: None,
        }
    }

    pub fn with_balances(mut self, b: Vec<FrozenBalance>) -> Self {
        self.balances = Some(b);
        self
    }

    pub fn with_price_scale(mut self, s: u128) -> Self {
        self.price_scale = Some(s);
        self
    }

    pub fn scale(&self) -> u128 {
        self.price_scale.unwrap_or(PRICE_SCALE)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub index: u64,
    pub submitter: Address,
    pub side: u8,
    /// The uniform clearing price — identical on every fill, by construction.
    pub price: u128,
    pub qty_base: u64,
    /// BID: quote DEBITED (rounded up). ASK: quote GROSS (rounded down); the credit is
    /// `quote - fee`.
    pub quote: u64,
    /// Always 0 on a bid. On an ask, this account's share of `fee_quote`.
    pub fee: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceDiscovery {
    pub cleared: bool,
    pub price: u128,
    /// `min(demand(p*), supply(p*))` BEFORE truncation. May exceed u64; held wide on purpose.
    pub matched_base: U256,
    pub demand: U256,
    pub supply: U256,
    /// Every distinct limit price present, ascending.
    pub candidates: Vec<u128>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClearingResult {
    pub cleared: bool,
    pub price: u128,
    /// Base actually settled, AFTER truncation.
    pub matched_base: u64,
    /// Σ ask-side gross quote. The fee base.
    pub matched_quote: u64,
    pub fee_quote: u64,
    /// Σ bid quote − matched_quote. Retained by the vault; never negative.
    pub dust_quote: u64,
    /// Bids in canonical order, then asks. Zero-quantity fills are omitted.
    pub fills: Vec<Fill>,
    pub fills_root: [u8; 32],
    /// Pre-truncation matched volume — how much solvency cost the batch.
    pub matched_base_before_truncation: u64,
}

// ── §5.5 quote conversion, rounding TOWARD THE VAULT ────────────────────────

/// A buyer pays: round UP.
pub fn quote_for_bid(qty_base: u64, price: u128, scale: u128) -> Option<U256> {
    mul_div_ceil(qty_base as u128, price, scale)
}

/// A seller receives: round DOWN.
pub fn quote_for_ask(qty_base: u64, price: u128, scale: u128) -> Option<U256> {
    mul_div_floor(qty_base as u128, price, scale)
}

// ── §5.1 canonical order ────────────────────────────────────────────────────

/// `Ordering` for bids: price DESC, submitter bytes ASC, index ASC.
fn cmp_bids(a: &RevealedOrder, b: &RevealedOrder) -> core::cmp::Ordering {
    b.limit_price
        .cmp(&a.limit_price)
        .then_with(|| a.submitter.cmp(&b.submitter))
        .then_with(|| a.index.cmp(&b.index))
}

/// `Ordering` for asks: price ASC, submitter bytes ASC, index ASC.
fn cmp_asks(a: &RevealedOrder, b: &RevealedOrder) -> core::cmp::Ordering {
    a.limit_price
        .cmp(&b.limit_price)
        .then_with(|| a.submitter.cmp(&b.submitter))
        .then_with(|| a.index.cmp(&b.index))
}

/// Bids in canonical order, then asks in canonical order.
pub fn canonical_order(orders: &[RevealedOrder]) -> Vec<RevealedOrder> {
    let mut bids: Vec<RevealedOrder> = orders.iter().copied().filter(|o| o.side == SIDE_BID).collect();
    let mut asks: Vec<RevealedOrder> = orders.iter().copied().filter(|o| o.side == SIDE_ASK).collect();
    bids.sort_by(cmp_bids);
    asks.sort_by(cmp_asks);
    bids.extend(asks);
    bids
}

fn validate(orders: &[RevealedOrder]) -> Result<Vec<RevealedOrder>, SpecError> {
    if orders.len() > HARD_MAX_BATCH_SIZE {
        return Err(SpecError::BatchTooLarge(orders.len()));
    }
    let mut seen: Vec<u64> = Vec::with_capacity(orders.len());
    for o in orders {
        if o.side != SIDE_BID && o.side != SIDE_ASK {
            return Err(SpecError::BadSide(o.side));
        }
        if seen.contains(&o.index) {
            return Err(SpecError::DuplicateOrderIndex(o.index));
        }
        seen.push(o.index);
        if o.qty_base == 0 {
            return Err(SpecError::ZeroQuantity(o.index));
        }
        if o.limit_price == 0 {
            return Err(SpecError::ZeroPrice(o.index));
        }
    }
    Ok(orders.to_vec())
}

// ── §5.3 largest-remainder (Hamilton) apportionment ─────────────────────────

/// `floor_i = floor(total * w_i / Σw)`; the `total − Σ floor_i` leftover units go one at a time
/// to the LARGEST fractional remainder, ties broken by ASCENDING index — which IS the canonical
/// tie-break, because callers pass weights already in canonical order.
///
/// Returns `None` if `total > Σ weights` (a caller bug — the TS twin throws there too).
pub fn largest_remainder(total: u64, weights: &[u64]) -> Option<Vec<u64>> {
    let n = weights.len();
    let mut out = vec![0u64; n];
    if n == 0 {
        return if total == 0 { Some(out) } else { None };
    }
    let mut sum: u128 = 0;
    for w in weights {
        sum += *w as u128;
    }
    if total as u128 > sum {
        return None;
    }
    if sum == 0 {
        return Some(out);
    }

    let mut remainders = vec![0u128; n];
    let mut assigned: u128 = 0;
    for i in 0..n {
        let p = total as u128 * weights[i] as u128;
        let q = p / sum;
        out[i] = q as u64;
        remainders[i] = p % sum;
        assigned += q;
    }
    let mut leftover = total as u128 - assigned;
    if leftover == 0 {
        return Some(out);
    }

    // Only entries with a non-zero remainder can receive a unit; for those floor_i < w_i, so
    // `+1` can never push an allocation above its own weight.
    let mut order: Vec<usize> = (0..n).filter(|&i| remainders[i] > 0).collect();
    order.sort_by(|&x, &y| remainders[y].cmp(&remainders[x]).then_with(|| x.cmp(&y)));
    for i in order {
        if leftover == 0 {
            break;
        }
        out[i] += 1;
        leftover -= 1;
    }
    if leftover != 0 {
        return None;
    }
    Some(out)
}

// ── §5.2 price discovery ────────────────────────────────────────────────────

/// Candidates are the distinct limit prices present. `vol(p) = min(demand(p), supply(p))`;
/// choose max `vol`, tie-break min `|demand − supply|`, tie-break the LOWEST `p`.
pub fn discover_price(orders: &[RevealedOrder]) -> PriceDiscovery {
    let mut candidates: Vec<u128> = orders.iter().map(|o| o.limit_price).collect();
    candidates.sort_unstable();
    candidates.dedup();

    if candidates.is_empty() {
        return PriceDiscovery {
            cleared: false,
            price: 0,
            matched_base: U256::ZERO,
            demand: U256::ZERO,
            supply: U256::ZERO,
            candidates,
        };
    }

    let n = candidates.len();
    let mut bid_at = vec![U256::ZERO; n];
    let mut ask_at = vec![U256::ZERO; n];
    for o in orders {
        let i = candidates
            .binary_search(&o.limit_price)
            .expect("candidate set contains every limit price");
        let slot = if o.side == SIDE_BID {
            &mut bid_at[i]
        } else {
            &mut ask_at[i]
        };
        *slot = slot
            .checked_add(&U256::from_u64(o.qty_base))
            .expect("Σ qty of at most 512 u64s cannot overflow 256 bits");
    }

    // demand(p) = Σ bid qty with limit >= p  → suffix sums over ascending candidates.
    let mut demand = vec![U256::ZERO; n];
    let mut acc = U256::ZERO;
    for i in (0..n).rev() {
        acc = acc.checked_add(&bid_at[i]).expect("no 256-bit overflow");
        demand[i] = acc;
    }
    // supply(p) = Σ ask qty with limit <= p  → prefix sums.
    let mut supply = vec![U256::ZERO; n];
    acc = U256::ZERO;
    for i in 0..n {
        acc = acc.checked_add(&ask_at[i]).expect("no 256-bit overflow");
        supply[i] = acc;
    }

    let mut best: Option<usize> = None;
    let mut best_vol = U256::ZERO;
    let mut best_imb = U256::ZERO;
    for i in 0..n {
        let d = demand[i];
        let s = supply[i];
        let vol = if d < s { d } else { s };
        if vol.is_zero() {
            continue;
        }
        let imb = if d > s {
            d.checked_sub(&s).expect("d > s")
        } else {
            s.checked_sub(&d).expect("s >= d")
        };
        // Ascending sweep + STRICT improvement => the lowest price wins every remaining tie.
        if best.is_none() || vol > best_vol || (vol == best_vol && imb < best_imb) {
            best = Some(i);
            best_vol = vol;
            best_imb = imb;
        }
    }

    match best {
        None => PriceDiscovery {
            cleared: false,
            price: 0,
            matched_base: U256::ZERO,
            demand: U256::ZERO,
            supply: U256::ZERO,
            candidates,
        },
        Some(i) => PriceDiscovery {
            cleared: true,
            price: candidates[i],
            matched_base: best_vol,
            demand: demand[i],
            supply: supply[i],
            candidates,
        },
    }
}

// ── §5bis(a) allocation: price priority, then largest remainder at the margin ─

#[derive(Copy, Clone, Debug)]
struct Slot {
    order: RevealedOrder,
    qty: u64,
}

/// Allocate `target` across `slots` (already canonical, so equal-price runs are contiguous).
/// Levels that fit fill fully; the FIRST level that does not fit is pro-rated by largest
/// remainder; every later level gets zero.
fn allocate_side(slots: &[Slot], target: u64) -> Vec<u64> {
    let mut out = vec![0u64; slots.len()];
    let mut remaining = target;
    let mut i = 0usize;
    while i < slots.len() && remaining > 0 {
        let price = slots[i].order.limit_price;
        let mut j = i;
        let mut level_total: u128 = 0;
        while j < slots.len() && slots[j].order.limit_price == price {
            level_total += slots[j].qty as u128;
            j += 1;
        }
        if level_total <= remaining as u128 {
            for k in i..j {
                out[k] = slots[k].qty;
            }
            remaining -= level_total as u64;
        } else {
            let weights: Vec<u64> = slots[i..j].iter().map(|s| s.qty).collect();
            let share = largest_remainder(remaining, &weights)
                .expect("remaining < level_total, so the apportionment is well posed");
            out[i..j].copy_from_slice(&share);
            remaining = 0;
        }
        i = j;
    }
    out
}

// ── clear() ─────────────────────────────────────────────────────────────────

fn to_u64(v: U256, what: &'static str) -> Result<u64, SpecError> {
    v.checked_to_u64().ok_or(SpecError::NotAU64(what, v))
}

/// THE uniform-price clearing algorithm as `docs/DESIGN-V2.md` §5 + §5bis define it.
/// Pure, integer-only, deterministic.
pub fn clear(input: &ClearingInput) -> Result<ClearingResult, SpecError> {
    let scale = input.scale();
    if scale == 0 {
        return Err(SpecError::BadPriceScale);
    }
    if input.fee_matched_bps > BPS_DENOM {
        return Err(SpecError::BadFeeBps(input.fee_matched_bps));
    }

    // ⚠ A PRICE MOVE CANNOT HOLD IS REJECTED AT THE DOOR — this is D5.
    //
    // `limit_price` is a u128 in this spec but a **u64** in `clearing.move`, because a
    // Move `Order` stores `limit_price: u64`. A book carrying a price above u64::MAX is
    // therefore not a book Move can express, and clearing it here would produce a
    // confident result for a batch that could never exist on chain — the worst possible
    // output, since it looks like agreement. Move rejects it at submit; so does this.
    for o in &input.orders {
        if o.limit_price > u64::MAX as u128 {
            return Err(SpecError::NotAU64("limitPrice", U256::from_u128(o.limit_price)));
        }
    }

    let orders = validate(&input.orders)?;
    let discovery = discover_price(&orders);

    let empty = ClearingResult {
        cleared: false,
        price: 0,
        matched_base: 0,
        matched_quote: 0,
        fee_quote: 0,
        dust_quote: 0,
        fills: Vec::new(),
        fills_root: [0u8; 32],
        matched_base_before_truncation: 0,
    };
    if !discovery.cleared {
        return Ok(empty);
    }

    let p = discovery.price;
    let matched_before = to_u64(discovery.matched_base, "matchedBase")?;

    // Eligible = able to trade at p*. Canonical order makes price priority positional.
    let mut bid_slots: Vec<Slot> = {
        let mut v: Vec<RevealedOrder> = orders
            .iter()
            .copied()
            .filter(|o| o.side == SIDE_BID && o.limit_price >= p)
            .collect();
        v.sort_by(cmp_bids);
        v.into_iter().map(|order| Slot { order, qty: order.qty_base }).collect()
    };
    let mut ask_slots: Vec<Slot> = {
        let mut v: Vec<RevealedOrder> = orders
            .iter()
            .copied()
            .filter(|o| o.side == SIDE_ASK && o.limit_price <= p)
            .collect();
        v.sort_by(cmp_asks);
        v.into_iter().map(|order| Slot { order, qty: order.qty_base }).collect()
    };

    // 1. Raw allocation against the discovered volume.
    let raw_bid = allocate_side(&bid_slots, matched_before);
    let raw_ask = allocate_side(&ask_slots, matched_before);
    for (s, q) in bid_slots.iter_mut().zip(raw_bid) {
        s.qty = q;
    }
    for (s, q) in ask_slots.iter_mut().zip(raw_ask) {
        s.qty = q;
    }

    // 2. Truncate against the FROZEN snapshot, in canonical order, per account.
    if let Some(balances) = &input.balances {
        let mut base_budget: Vec<(Address, u64)> = Vec::new();
        let mut quote_budget: Vec<(Address, u64)> = Vec::new();
        for b in balances {
            base_budget.push((b.submitter, b.base));
            quote_budget.push((b.submitter, b.quote));
        }
        let get = |m: &Vec<(Address, u64)>, who: Address| -> u64 {
            m.iter().find(|(a, _)| *a == who).map(|(_, v)| *v).unwrap_or(0)
        };
        let set = |m: &mut Vec<(Address, u64)>, who: Address, v: u64| {
            if let Some(slot) = m.iter_mut().find(|(a, _)| *a == who) {
                slot.1 = v;
            } else {
                m.push((who, v));
            }
        };

        for s in bid_slots.iter_mut() {
            if s.qty == 0 {
                continue;
            }
            let who = s.order.submitter;
            let budget = get(&quote_budget, who);
            // Largest qty affordable at p* with `budget` quote, given the buyer rounds UP.
            let affordable = mul_div_floor(budget as u128, scale, p)
                .expect("p != 0: validate() rejects a zero limit price");
            if affordable < U256::from_u64(s.qty) {
                s.qty = affordable.checked_to_u64().unwrap_or(u64::MAX);
            }
            let spent = to_u64(
                quote_for_bid(s.qty, p, scale).ok_or(SpecError::BadPriceScale)?,
                "truncationSpend",
            )?;
            set(&mut quote_budget, who, budget - spent);
        }
        for s in ask_slots.iter_mut() {
            if s.qty == 0 {
                continue;
            }
            let who = s.order.submitter;
            let budget = get(&base_budget, who);
            if budget < s.qty {
                s.qty = budget;
            }
            set(&mut base_budget, who, budget - s.qty);
        }

        // 3. Re-ration the longer side down to M' — "the counterparty recomputed symmetrically".
        let bid_total: u128 = bid_slots.iter().map(|s| s.qty as u128).sum();
        let ask_total: u128 = ask_slots.iter().map(|s| s.qty as u128).sum();
        let m = bid_total.min(ask_total) as u64;
        if bid_total > m as u128 {
            let re = allocate_side(&bid_slots, m);
            for (s, q) in bid_slots.iter_mut().zip(re) {
                s.qty = q;
            }
        }
        if ask_total > m as u128 {
            let re = allocate_side(&ask_slots, m);
            for (s, q) in ask_slots.iter_mut().zip(re) {
                s.qty = q;
            }
        }
    }

    let matched_base: u128 = ask_slots.iter().map(|s| s.qty as u128).sum();
    let bid_base: u128 = bid_slots.iter().map(|s| s.qty as u128).sum();
    if matched_base != bid_base {
        // @invariant 2.
        return Err(SpecError::ValueNotPreserved(format!(
            "base {bid_base} (bids) != {matched_base} (asks)"
        )));
    }

    if matched_base == 0 {
        return Ok(ClearingResult {
            cleared: true,
            price: p,
            matched_base_before_truncation: matched_before,
            ..empty
        });
    }
    let matched_base = matched_base as u64;

    // 4/5. Quotes, then the explicit fee term apportioned by the SAME largest-remainder rule.
    let mut ask_quotes: Vec<u64> = Vec::with_capacity(ask_slots.len());
    let mut matched_quote_wide = U256::ZERO;
    for s in &ask_slots {
        let q = if s.qty == 0 {
            U256::ZERO
        } else {
            quote_for_ask(s.qty, p, scale).ok_or(SpecError::BadPriceScale)?
        };
        matched_quote_wide = matched_quote_wide
            .checked_add(&q)
            .ok_or(SpecError::NotAU64("matchedQuote", U256::ZERO))?;
        // ⚠ EACH FILL'S QUOTE IS CHECKED **HERE**, BEFORE THE SUM. Move stores a
        // per-fill `quote_sats: u64`, so it aborts on the FILL that does not fit and
        // never reaches an aggregate. Clamping to u64::MAX and letting the sum fail
        // later reported `matchedQuote` for what is really a single overflowing fill —
        // a true failure with the wrong cause, which is the hardest kind to debug.
        ask_quotes.push(to_u64(q, "fillQuote")?);
    }
    let matched_quote = to_u64(matched_quote_wide, "matchedQuote")?;

    // ⚠ THE FEE IS CHARGED PER ASK ON ITS OWN GROSS — it is NOT a batch total
    // apportioned across the asks by largest remainder.
    //
    // This was divergence D3. The two rules agree only when every gross divides
    // evenly; otherwise `floor(Σgross · bps)` and `Σ floor(gross_i · bps)` differ by
    // the dropped remainders, and every fill leaf downstream hashes differently, so
    // the Merkle roots can never match. `clearing.move` computes each ask's fee from
    // that ask's own gross, and Move is the authority here — it is the deployed
    // contract. Pinned by the fixture case `fee-charged-per-ask-on-its-own-gross`.
    let mut fee_of_ask: Vec<u64> = Vec::with_capacity(ask_quotes.len());
    for gross in &ask_quotes {
        fee_of_ask.push(to_u64(
            mul_div_floor(*gross as u128, input.fee_matched_bps, BPS_DENOM)
                .expect("BPS_DENOM != 0"),
            "fillFee",
        )?);
    }

    let mut fills: Vec<Fill> = Vec::new();
    let mut bid_quote_total = U256::ZERO;
    for s in &bid_slots {
        if s.qty == 0 {
            continue;
        }
        // @invariant 1 — asserted per fill, not merely by construction.
        if p > s.order.limit_price {
            return Err(SpecError::FillOutsideLimit(s.order.index));
        }
        let quote = to_u64(
            quote_for_bid(s.qty, p, scale).ok_or(SpecError::BadPriceScale)?,
            "fillQuote",
        )?;
        bid_quote_total = bid_quote_total
            .checked_add(&U256::from_u64(quote))
            .ok_or(SpecError::NotAU64("bidQuoteTotal", U256::ZERO))?;
        fills.push(Fill {
            index: s.order.index,
            submitter: s.order.submitter,
            side: SIDE_BID,
            price: p,
            qty_base: s.qty,
            quote,
            fee: 0,
        });
    }
    let mut fee_total: u128 = 0;
    for (i, s) in ask_slots.iter().enumerate() {
        if s.qty == 0 {
            continue;
        }
        if p < s.order.limit_price {
            return Err(SpecError::FillOutsideLimit(s.order.index));
        }
        let gross = ask_quotes[i];
        let fee = fee_of_ask[i];
        if fee > gross {
            return Err(SpecError::FeeExceedsProceeds(s.order.index));
        }
        fee_total += fee as u128;
        fills.push(Fill {
            index: s.order.index,
            submitter: s.order.submitter,
            side: SIDE_ASK,
            price: p,
            qty_base: s.qty,
            // ⚠ THE PUBLISHED `quote` OF AN ASK IS **NET** OF ITS FEE. The gross is
            // `quote + fee`. Move writes the net figure into the fill leaf, so
            // publishing the gross here changes the leaf bytes and therefore the
            // root. At the 10 000 bps boundary the net is legitimately 0.
            quote: gross - fee,
            fee,
        });
    }
    let bid_quote_total = to_u64(bid_quote_total, "bidQuoteTotal")?;

    // @invariant 4 — rounding both sides toward the vault makes this non-negative.
    let dust_quote = bid_quote_total
        .checked_sub(matched_quote)
        .ok_or_else(|| SpecError::ValueNotPreserved("negative dust".into()))?;

    // ⚠ MOVE'S FEE IS THE RESIDUAL, AND IT ABSORBS THE DUST. There is no fourth
    // term in the identity: the bids pay `bid_quote_total`, the asks are credited
    // their NET quotes, and whatever is left over IS the fee — rounding crumbs
    // included. So the identity to assert is `Σ fill.fee + dustQuote == feeQuote`,
    // never `Σ fill.fee == feeQuote`. Deriving it the other way round (fee first,
    // dust as a separate leftover) is what made this implementation disagree.
    let fee_quote = to_u64(
        U256::from_u128(fee_total + dust_quote as u128),
        "feeQuote",
    )?;

    // @invariant 3 — the §5 identity, asserted rather than assumed. An ask's
    // published `quote` is ALREADY NET, so its credit is `f.quote` itself; the
    // earlier `f.quote - f.fee` here double-subtracted the fee.
    let credits: u128 = fills
        .iter()
        .filter(|f| f.side == SIDE_ASK)
        .map(|f| f.quote as u128)
        .sum();
    if bid_quote_total as u128 != credits + fee_quote as u128 {
        return Err(SpecError::ValueNotPreserved(format!(
            "quote {bid_quote_total} != {credits} + {fee_quote}"
        )));
    }

    let root = fills_root(&fills);
    Ok(ClearingResult {
        cleared: true,
        price: p,
        matched_base,
        matched_quote,
        fee_quote,
        dust_quote,
        fills,
        fills_root: root,
        matched_base_before_truncation: matched_before,
    })
}

// ── §5bis(d) the leaf, and the root ─────────────────────────────────────────

/// `bcs(FillLeaf)` — 81 bytes. u64s and the u128 are LITTLE-endian; the address is 32 RAW
/// big-endian bytes with no length prefix.
pub fn encode_fill_leaf(f: &Fill) -> [u8; FILL_LEAF_LEN] {
    let mut out = [0u8; FILL_LEAF_LEN];
    let mut at = 0usize;
    out[at..at + 8].copy_from_slice(&f.index.to_le_bytes());
    at += 8;
    out[at..at + 32].copy_from_slice(f.submitter.bytes());
    at += 32;
    out[at] = f.side;
    at += 1;
    out[at..at + 16].copy_from_slice(&f.price.to_le_bytes());
    at += 16;
    out[at..at + 8].copy_from_slice(&f.qty_base.to_le_bytes());
    at += 8;
    out[at..at + 8].copy_from_slice(&f.quote.to_le_bytes());
    at += 8;
    out[at..at + 8].copy_from_slice(&f.fee.to_le_bytes());
    at += 8;
    debug_assert_eq!(at, FILL_LEAF_LEN);
    out
}

/// `blake2b256(0x00 ‖ bcs(FillLeaf))`.
pub fn hash_fill_leaf(f: &Fill) -> [u8; 32] {
    let mut buf = [0u8; 1 + FILL_LEAF_LEN];
    buf[0] = LEAF_TAG;
    buf[1..].copy_from_slice(&encode_fill_leaf(f));
    blake2b256(&buf)
}

/// `blake2b256(0x01 ‖ left ‖ right)`.
pub fn hash_node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 65];
    buf[0] = NODE_TAG;
    buf[1..33].copy_from_slice(l);
    buf[33..].copy_from_slice(r);
    blake2b256(&buf)
}

/// The published `fills_root`. **An empty fill set is 32 ZERO BYTES**, not a hash of nothing.
pub fn fills_root(fills: &[Fill]) -> [u8; 32] {
    if fills.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<[u8; 32]> = fills.iter().map(hash_fill_leaf).collect();
    while level.len() > 1 {
        let m = level.len();
        let mut next = Vec::with_capacity(m.div_ceil(2));
        let mut j = 0usize;
        while j < m {
            let l = level[j];
            // Odd node duplicated.
            let r = if j + 1 < m { level[j + 1] } else { l };
            next.push(hash_node(&l, &r));
            j += 2;
        }
        level = next;
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bid(index: u64, who: u128, price: u128, qty: u64) -> RevealedOrder {
        RevealedOrder {
            index,
            submitter: Address::from_u128(who),
            side: SIDE_BID,
            limit_price: price,
            qty_base: qty,
        }
    }

    fn ask(index: u64, who: u128, price: u128, qty: u64) -> RevealedOrder {
        RevealedOrder {
            index,
            submitter: Address::from_u128(who),
            side: SIDE_ASK,
            limit_price: price,
            qty_base: qty,
        }
    }

    /// @invariant 8 — the layout is 81 bytes, and §5bis(d)'s "= 73 bytes" is an arithmetic slip.
    #[test]
    fn fill_leaf_is_81_bytes_not_the_73_the_prose_claims() {
        assert_eq!(FILL_LEAF_LEN, 81);
        assert_eq!(8 + 32 + 1 + 16 + 8 + 8 + 8, 81);
        assert_ne!(FILL_LEAF_LEN, 73);
    }

    #[test]
    fn empty_fill_set_roots_to_32_zero_bytes() {
        assert_eq!(fills_root(&[]), [0u8; 32]);
    }

    /// §5bis(a), the case §5.3 as written cannot satisfy.
    #[test]
    fn degenerate_strictly_inside_exceeds_matched() {
        let input = ClearingInput::new(vec![bid(0, 1, 10, 100), ask(1, 2, 5, 50)], 0)
            .with_price_scale(1);
        let r = clear(&input).unwrap();
        assert_eq!(r.price, 5);
        assert_eq!(r.matched_base, 50);
        assert_eq!(r.fills.len(), 2);
    }

    /// The same level, two orders — the pro-rata branch of §5bis(a).
    #[test]
    fn a_level_that_does_not_fit_is_prorated_not_filled_greedily() {
        let input = ClearingInput::new(
            vec![bid(0, 1, 10, 60), bid(1, 2, 10, 60), ask(2, 3, 5, 50)],
            0,
        )
        .with_price_scale(1);
        let r = clear(&input).unwrap();
        assert_eq!(r.price, 5);
        assert_eq!(r.matched_base, 50);
        let bids: Vec<u64> = r.fills.iter().filter(|f| f.side == SIDE_BID).map(|f| f.qty_base).collect();
        // Pro-rated 25/25, NOT 50/0.
        assert_eq!(bids, vec![25, 25]);
    }

    #[test]
    fn largest_remainder_sums_exactly_and_respects_weights() {
        let out = largest_remainder(10, &[3, 3, 5]).unwrap();
        assert_eq!(out.iter().sum::<u64>(), 10);
        for (o, w) in out.iter().zip([3u64, 3, 5]) {
            assert!(*o <= w);
        }
        assert_eq!(largest_remainder(0, &[]).unwrap(), Vec::<u64>::new());
        assert!(largest_remainder(1, &[]).is_none());
        // total == Σ weights is the legal boundary: everyone gets their whole weight.
        assert_eq!(largest_remainder(11, &[3, 3, 5]).unwrap(), vec![3, 3, 5]);
        // One past it is a caller bug.
        assert!(largest_remainder(12, &[3, 3, 5]).is_none());
    }

    #[test]
    fn errors_carry_the_substrings_the_fixtures_pin() {
        assert!(SpecError::BatchTooLarge(513).to_string().contains("EBatchTooLarge"));
        assert!(SpecError::DuplicateOrderIndex(0).to_string().contains("EDuplicateOrderIndex"));
        assert!(SpecError::ZeroQuantity(0).to_string().contains("EZeroQuantity"));
        assert!(SpecError::ZeroPrice(0).to_string().contains("EZeroPrice"));
        assert!(SpecError::BadFeeBps(10_001).to_string().contains("EBadFeeBps"));
        assert!(SpecError::NotAU64("matchedQuote", U256::ZERO)
            .to_string()
            .contains("matchedQuote is not a u64"));
    }

    #[test]
    fn canonical_order_puts_every_bid_before_every_ask() {
        let sorted = canonical_order(&[ask(0, 1, 5, 1), bid(1, 1, 5, 1)]);
        assert_eq!(sorted[0].side, SIDE_BID);
        assert_eq!(sorted[1].side, SIDE_ASK);
    }

    #[test]
    fn no_input_permutation_changes_the_result() {
        let orders = vec![bid(0, 3, 10, 5), bid(1, 1, 10, 5), bid(2, 2, 12, 5), ask(3, 1, 8, 7)];
        let base = clear(&ClearingInput::new(orders.clone(), 30).with_price_scale(1)).unwrap();
        for perm in [[3usize, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]] {
            let shuffled: Vec<RevealedOrder> = perm.iter().map(|&i| orders[i]).collect();
            let r = clear(&ClearingInput::new(shuffled, 30).with_price_scale(1)).unwrap();
            assert_eq!(r, base);
        }
    }
}
