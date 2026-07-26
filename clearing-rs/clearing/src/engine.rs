// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move — ⚠ THIS IS NOW THE TWIN OF PACKAGE v1, NOT OF
//             THE DEPLOYED CODE. The v2 upgrade fixed D2 (greedy -> pro-rata at the
//             marginal level) and D4 (truncation moved from load time to AFTER price
//             discovery, so an under-funded account can no longer move the uniform
//             price). Move now matches `spec.rs` on both; this file matches neither
//             side fully and is kept as the v1 reference the divergence census was
//             measured against. `spec.rs` is the engine to compare Move to.
// @spec       aphotic.md#9 (L432) <- "must produce bit-identical output to the Move one.
//             Property-test them against each other; a divergence is a release blocker."
// @spec       aphotic.md#7.2-the-batch · aphotic.md#10-invariants (Settlement)
// @rules      G10
// @depends    crate::types · crate::merkle
// @facts      STAGES, each with its own cursor, each budgeted:
// @facts        0 LOADING · 1 PRICING · 2 ALLOC_FULL · 3 ALLOC_PRORATA · 4 ALLOC_REMAINDER
// @facts        5 ROOTING · 6 SETTLING · 7 DONE   (DONE falls through: stepping it is a NO-OP)
// @facts      PRICE_SCALE = 100_000_000 · BPS_DENOMINATOR = 10_000 · DEFAULT_SETTLE_BUDGET = 128
// @facts      CANONICAL ORDER, ties fully broken so implementation freedom is zero:
// @facts        bids (price DESC, address-as-u256 ASC, order_index ASC)
// @facts        asks (price ASC,  address-as-u256 ASC, order_index ASC)
// @facts      PRICE DISCOVERY: candidates are the DISTINCT limit prices present, ASCENDING.
// @facts        vol(p) = min(demand(p), supply(p)); take max vol; tie-break min |demand−supply|;
// @facts        tie-break the LOWEST p — which needs no branch, because candidates ascend and
// @facts        only a STRICT improvement replaces the incumbent.
// @facts      ALLOCATION: strictly-inside orders first in canonical order until `matched` runs
// @facts        out; orders at EXACTLY p* share the residual pro-rata floor(res*qty/Σqty), and
// @facts        the remainder goes out ONE SAT AT A TIME by largest fractional remainder,
// @facts        tie-broken by canonical position (the scan is canonical and only a STRICT
// @facts        improvement wins). Each at-p entry can be bumped AT MOST ONCE.
// @facts      QUOTE CONVERSION rounds TOWARD THE VAULT: bids pay ceil, asks receive floor and
// @facts        then lose floor(gross*fee_bps/10_000). fee = Σbid_ceil − Σask_net, so the fee
// @facts        is an EXPLICIT third credit term and the dust can never be negative.
// @facts      SOLVENCY WITHOUT LEAKING SIZE: no margin field exists. Each order's quantity is
// @facts        TRUNCATED AT LOAD TIME to what the submitter's persistent balance funds at the
// @facts        order's OWN limit price (worst case for a bid, since p* <= limit), with a
// @facts        per-submitter running budget so several orders from one account are jointly
// @facts        funded. `afford` saturates at u64::MAX — Move clamps it the same way.
// @facts      ⚠ `alloc_remainder_step`'s side switch uses `continue` WITHOUT incrementing the
// @facts        budget counter, exactly as Move does. Mirrored so step counts match too.
// @implements pub struct Clearing
//             pub fn Clearing::begin(input: BatchInput) -> Clearing
//             pub fn Clearing::step(&mut self, budget: u64) -> Result<(), ClearingError>
//             pub fn Clearing::run(&mut self, budget: u64) -> Result<u64, ClearingError>
//             pub fn Clearing::verify_fill(&self, f, index, siblings) -> Result<bool, _>
//             pub fn Clearing::outcome(&self) -> Outcome
// @forbidden  a float — `clearing.move` contains none and neither may this file. The `sim`
//             crate is where floats are allowed to live.
// @forbidden  sorting with a comparator that is not FULLY tie-broken — a stable sort here and
//             an unstable one there is exactly how a twin drifts
// @forbidden  reading a wall clock — nothing downstream of `begin` consults time
// @invariant  1. Settlement reverts unless total debits equal total credits, with the fee
//                counted as an explicit credit (ValueNotPreserved).
// @invariant  2. No participant is filled outside their limit price, asserted PER FILL.
// @invariant  3. Every fill maps to exactly one revealed order; indices are unique; an
//                unrevealed order is never loaded.
// @invariant  4. Idempotent: the same order set yields the same price and the same root.
// @invariant  5. Stepping a finished clearing is a no-op, not an error.
// @invariant  6. A batch with no revealed orders still settles: price 0, empty root, zero
//                debits and credits.
// @invariant  7. Budget-invariance: budget 1 and budget 10_000 produce identical output.
// @ac         clearing/tests/move_vectors.rs (every numeric expectation transcribed from
//             move/tests/clearing_tests.move) · clearing/tests/property.rs
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use std::collections::BTreeMap;

use crate::merkle;
use crate::types::{Address, ClearingError, EntryView, Escrowed, Fill, Order, OrderSlot};

pub const PRICE_SCALE: u64 = 100_000_000;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const DEFAULT_SETTLE_BUDGET: u64 = 128;

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Loading = 0,
    Pricing = 1,
    AllocFull = 2,
    AllocProrata = 3,
    AllocRemainder = 4,
    Rooting = 5,
    Settling = 6,
    Done = 7,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum RemainderSide {
    Bid,
    Ask,
    None,
}

/// Everything `begin` needs. In Move these arrive as `&Batch` and `&Vault`; here they are a
/// snapshot, which is exactly what the on-chain escrow lock guarantees for the duration.
#[derive(Clone, Debug)]
pub struct BatchInput {
    pub batch_id: u64,
    /// Position in this vector IS `order_index`. An unrevealed slot keeps its index.
    pub orders: Vec<OrderSlot>,
    pub escrow: BTreeMap<Address, Escrowed>,
    pub fee_bps: u64,
    pub fee_recipient: Address,
}

impl BatchInput {
    pub fn new(batch_id: u64, fee_bps: u64, fee_recipient: Address) -> Self {
        BatchInput {
            batch_id,
            orders: Vec::new(),
            escrow: BTreeMap::new(),
            fee_bps,
            fee_recipient,
        }
    }

    pub fn revealed(mut self, o: Order) -> Self {
        self.orders.push(OrderSlot::Revealed(o));
        self
    }

    pub fn unrevealed(mut self) -> Self {
        self.orders.push(OrderSlot::Unrevealed);
        self
    }

    pub fn fund(mut self, who: Address, base_sats: u64, quote_sats: u64) -> Self {
        self.escrow.insert(
            who,
            Escrowed {
                base_sats,
                quote_sats,
            },
        );
        self
    }
}

#[derive(Copy, Clone, Debug)]
struct Entry {
    order_index: u64,
    submitter: Address,
    /// The canonical tie-break. Move stores `to_u256(who)`; the raw bytes have the same order.
    key: Address,
    is_bid: bool,
    limit_price: u64,
    qty_sats: u64,
    fill_base: u64,
    /// `residual × qty_i − floor × Σqty` — the largest-remainder ranking value.
    frac: u128,
    bumped: bool,
}

#[derive(Copy, Clone, Debug)]
struct Funding {
    who: Address,
    base_left: u64,
    quote_left: u64,
}

/// The result of a completed clearing, in the shape the read surface of `clearing.move` exposes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub batch_id: u64,
    pub stage: Stage,
    pub clearing_price: u64,
    pub matched_base_sats: u64,
    pub fills: Vec<Fill>,
    pub fills_root: [u8; 32],
    pub quote_paid_sats: u64,
    pub quote_recv_sats: u64,
    pub fee_quote_sats: u64,
    pub total_debits: u64,
    pub total_credits: u64,
    pub candidate_count: usize,
    pub eligible_bids: usize,
    pub eligible_asks: usize,
    pub bids: Vec<EntryView>,
    pub asks: Vec<EntryView>,
    pub escrow: BTreeMap<Address, Escrowed>,
}

pub struct Clearing {
    batch_id: u64,
    orders: Vec<OrderSlot>,
    escrow: BTreeMap<Address, Escrowed>,

    stage: Stage,
    cursor: u64,

    funding: Vec<Funding>,
    bids: Vec<Entry>,
    asks: Vec<Entry>,

    candidates: Vec<u64>,
    demand_remaining: u64,
    bid_scan: u64,
    supply_acc: u64,
    ask_scan: u64,
    found: bool,
    best_price: u64,
    best_vol: u64,
    best_gap: u64,

    clearing_price: u64,
    matched_base: u64,
    elig_bids: u64,
    elig_asks: u64,
    filled_bid: u64,
    filled_ask: u64,
    pro_qty_bid: u64,
    pro_qty_ask: u64,
    residual_bid: u64,
    residual_ask: u64,
    awarded_bid: u64,
    awarded_ask: u64,
    remainder_side: RemainderSide,

    fills: Vec<Fill>,
    fills_root: [u8; 32],
    quote_paid: u64,
    quote_recv: u64,
    fee_quote: u64,

    total_debits: u64,
    total_credits: u64,
    fee_bps: u64,
    fee_recipient: Address,
}

// ── integer helpers — the same three Move has, with the same abort conditions ────────────────

fn floor_mul_div(a: u64, b: u64, c: u64) -> Result<u64, ClearingError> {
    if c == 0 {
        return Err(ClearingError::BadParam);
    }
    let r = (a as u128) * (b as u128) / (c as u128);
    u64::try_from(r).map_err(|_| ClearingError::Overflow)
}

fn ceil_mul_div(a: u64, b: u64, c: u64) -> Result<u64, ClearingError> {
    if c == 0 {
        return Err(ClearingError::BadParam);
    }
    let n = (a as u128) * (b as u128);
    let r = (n + c as u128 - 1) / c as u128;
    u64::try_from(r).map_err(|_| ClearingError::Overflow)
}

fn checked_add(a: u64, b: u64) -> Result<u64, ClearingError> {
    a.checked_add(b).ok_or(ClearingError::Overflow)
}

fn min_u64(a: u64, b: u64) -> u64 {
    if a < b {
        a
    } else {
        b
    }
}

fn abs_diff_u64(a: u64, b: u64) -> u64 {
    if a >= b {
        a - b
    } else {
        b - a
    }
}

impl Clearing {
    // ── genesis ─────────────────────────────────────────────────────────────

    pub fn begin(input: BatchInput) -> Self {
        Clearing {
            batch_id: input.batch_id,
            orders: input.orders,
            escrow: input.escrow,
            stage: Stage::Loading,
            cursor: 0,
            funding: Vec::new(),
            bids: Vec::new(),
            asks: Vec::new(),
            candidates: Vec::new(),
            demand_remaining: 0,
            bid_scan: 0,
            supply_acc: 0,
            ask_scan: 0,
            found: false,
            best_price: 0,
            best_vol: 0,
            best_gap: 0,
            clearing_price: 0,
            matched_base: 0,
            elig_bids: 0,
            elig_asks: 0,
            filled_bid: 0,
            filled_ask: 0,
            pro_qty_bid: 0,
            pro_qty_ask: 0,
            residual_bid: 0,
            residual_ask: 0,
            awarded_bid: 0,
            awarded_ask: 0,
            remainder_side: RemainderSide::Bid,
            fills: Vec::new(),
            fills_root: [0u8; 32],
            quote_paid: 0,
            quote_recv: 0,
            fee_quote: 0,
            total_debits: 0,
            total_credits: 0,
            fee_bps: input.fee_bps,
            fee_recipient: input.fee_recipient,
        }
    }

    // ── the one public driver ───────────────────────────────────────────────

    /// Advance by at most `budget` units of work. Safe to call after the clearing has finished
    /// (@invariant 5). A "unit" is: one order loaded · one candidate priced · one order
    /// allocated · one remainder sat awarded · one fill hashed · one fill pushed.
    pub fn step(&mut self, budget: u64) -> Result<(), ClearingError> {
        if budget == 0 {
            return Err(ClearingError::BadParam);
        }
        match self.stage {
            Stage::Loading => self.load_step(budget),
            Stage::Pricing => self.price_step(budget),
            Stage::AllocFull => self.alloc_full_step(budget),
            Stage::AllocProrata => self.alloc_prorata_step(budget),
            Stage::AllocRemainder => self.alloc_remainder_step(budget),
            Stage::Rooting => self.rooting_step(budget),
            Stage::Settling => self.settle_step(budget),
            // DONE falls through: stepping a finished clearing does nothing.
            Stage::Done => Ok(()),
        }
    }

    /// Drive to completion at `budget` units per step. Returns the number of steps taken —
    /// the same count a keeper would need transactions for.
    pub fn run(&mut self, budget: u64) -> Result<u64, ClearingError> {
        let mut steps = 0u64;
        // Bounded so a logic bug surfaces as a failure rather than a hang.
        let ceiling = 64 + 16 * (self.orders.len() as u64 + 1) * (self.orders.len() as u64 + 1);
        while self.stage != Stage::Done {
            self.step(budget)?;
            steps += 1;
            if steps > ceiling {
                return Err(ClearingError::BadParam);
            }
        }
        Ok(steps)
    }

    // ── stage 0: load, funding-truncate, insert in canonical position ───────

    fn escrow_of(&self, who: Address) -> Escrowed {
        self.escrow.get(&who).copied().unwrap_or_default()
    }

    fn funding_row(&mut self, who: Address) -> usize {
        if let Some(i) = self.funding.iter().position(|f| f.who == who) {
            return i;
        }
        let e = self.escrow_of(who);
        self.funding.push(Funding {
            who,
            base_left: e.base_sats,
            quote_left: e.quote_sats,
        });
        self.funding.len() - 1
    }

    fn load_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let total = self.orders.len() as u64;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let i = self.cursor;
            if let OrderSlot::Revealed(o) = self.orders[i as usize] {
                let who = o.submitter;
                let is_bid = o.is_bid;
                let price = o.limit_price;
                let qty = o.qty_sats;

                let row_i = self.funding_row(who);
                let effective = {
                    let row = &mut self.funding[row_i];
                    if is_bid {
                        if price == 0 {
                            return Err(ClearingError::BadParam);
                        }
                        // Worst case: the bid could clear at its own limit, never above it.
                        let afford_u128 =
                            (row.quote_left as u128) * (PRICE_SCALE as u128) / (price as u128);
                        // Move clamps to MAX_U64 rather than aborting; a saturating cast is
                        // exactly that.
                        let afford = u64::try_from(afford_u128).unwrap_or(u64::MAX);
                        let e = min_u64(qty, afford);
                        if e > 0 {
                            let cost = ceil_mul_div(e, price, PRICE_SCALE)?;
                            row.quote_left = row.quote_left - cost;
                        }
                        e
                    } else {
                        let e = min_u64(qty, row.base_left);
                        row.base_left -= e;
                        e
                    }
                };

                if effective > 0 {
                    let entry = Entry {
                        order_index: i,
                        submitter: who,
                        key: who,
                        is_bid,
                        limit_price: price,
                        qty_sats: effective,
                        fill_base: 0,
                        frac: 0,
                        bumped: false,
                    };
                    self.insert_canonical(entry);
                }
            }
            self.cursor = i + 1;
            used += 1;
        }

        if self.cursor >= total {
            self.finish_loading()?;
        }
        Ok(())
    }

    /// `true` iff `a` precedes `b` on the bid side: price DESC, then key ASC, then index ASC.
    fn bid_precedes(a: &Entry, b: &Entry) -> bool {
        if a.limit_price != b.limit_price {
            return a.limit_price > b.limit_price;
        }
        if a.key != b.key {
            return a.key < b.key;
        }
        a.order_index < b.order_index
    }

    /// Ask side: price ASC, then key ASC, then index ASC.
    fn ask_precedes(a: &Entry, b: &Entry) -> bool {
        if a.limit_price != b.limit_price {
            return a.limit_price < b.limit_price;
        }
        if a.key != b.key {
            return a.key < b.key;
        }
        a.order_index < b.order_index
    }

    fn insert_canonical(&mut self, e: Entry) {
        if e.is_bid {
            let n = self.bids.len();
            let mut i = 0usize;
            while i < n && !Self::bid_precedes(&e, &self.bids[i]) {
                i += 1;
            }
            self.bids.insert(i, e);
        } else {
            let n = self.asks.len();
            let mut i = 0usize;
            while i < n && !Self::ask_precedes(&e, &self.asks[i]) {
                i += 1;
            }
            self.asks.insert(i, e);
        }
    }

    /// Build the candidate list — the distinct limit prices, ASCENDING — by merging the two
    /// already-sorted sides. Bids are walked backwards because they are sorted DESC.
    fn finish_loading(&mut self) -> Result<(), ClearingError> {
        let nb = self.bids.len();
        let na = self.asks.len();

        let mut total_bid_qty = 0u64;
        for b in &self.bids {
            total_bid_qty = checked_add(total_bid_qty, b.qty_sats)?;
        }

        let mut out: Vec<u64> = Vec::new();
        let mut bi = nb;
        let mut ai = 0usize;
        let mut has_last = false;
        let mut last = 0u64;
        while bi > 0 || ai < na {
            let take_bid = if bi == 0 {
                false
            } else if ai >= na {
                true
            } else {
                self.bids[bi - 1].limit_price <= self.asks[ai].limit_price
            };
            let p = if take_bid {
                bi -= 1;
                self.bids[bi].limit_price
            } else {
                let x = self.asks[ai].limit_price;
                ai += 1;
                x
            };
            if !has_last || p != last {
                out.push(p);
                last = p;
                has_last = true;
            }
        }

        self.candidates = out;
        self.demand_remaining = total_bid_qty;
        self.bid_scan = nb as u64;
        self.supply_acc = 0;
        self.ask_scan = 0;
        self.cursor = 0;
        self.stage = Stage::Pricing;
        if self.candidates.is_empty() {
            self.finish_pricing()?;
        }
        Ok(())
    }

    // ── stage 1: uniform price discovery ────────────────────────────────────

    fn price_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let total = self.candidates.len() as u64;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let p = self.candidates[self.cursor as usize];

            // Bids qualify while limit >= p. Sorted DESC, so the qualifying set is a PREFIX
            // that shrinks from the back as p rises.
            while self.bid_scan > 0 && self.bids[self.bid_scan as usize - 1].limit_price < p {
                self.demand_remaining -= self.bids[self.bid_scan as usize - 1].qty_sats;
                self.bid_scan -= 1;
            }
            // Asks qualify while limit <= p. Sorted ASC, so it is a growing prefix.
            while (self.ask_scan as usize) < self.asks.len()
                && self.asks[self.ask_scan as usize].limit_price <= p
            {
                self.supply_acc = checked_add(self.supply_acc, self.asks[self.ask_scan as usize].qty_sats)?;
                self.ask_scan += 1;
            }

            let vol = min_u64(self.demand_remaining, self.supply_acc);
            let gap = abs_diff_u64(self.demand_remaining, self.supply_acc);
            // STRICT improvement only, and candidates ascend, so the lowest price wins ties.
            if vol > 0
                && (!self.found
                    || vol > self.best_vol
                    || (vol == self.best_vol && gap < self.best_gap))
            {
                self.found = true;
                self.best_vol = vol;
                self.best_gap = gap;
                self.best_price = p;
            }

            self.cursor += 1;
            used += 1;
        }

        if self.cursor >= total {
            self.finish_pricing()?;
        }
        Ok(())
    }

    fn finish_pricing(&mut self) -> Result<(), ClearingError> {
        if !self.found {
            // No cross. A batch with no crossing interest still settles (@invariant 6).
            self.clearing_price = 0;
            self.matched_base = 0;
            self.elig_bids = 0;
            self.elig_asks = 0;
            self.cursor = 0;
            self.stage = Stage::Rooting;
            return Ok(());
        }

        let p = self.best_price;
        self.clearing_price = p;

        let mut demand = 0u64;
        let mut nb = 0usize;
        while nb < self.bids.len() && self.bids[nb].limit_price >= p {
            demand = checked_add(demand, self.bids[nb].qty_sats)?;
            nb += 1;
        }
        let mut supply = 0u64;
        let mut na = 0usize;
        while na < self.asks.len() && self.asks[na].limit_price <= p {
            supply = checked_add(supply, self.asks[na].qty_sats)?;
            na += 1;
        }

        self.elig_bids = nb as u64;
        self.elig_asks = na as u64;
        self.matched_base = min_u64(demand, supply);
        self.cursor = 0;
        self.stage = Stage::AllocFull;
        Ok(())
    }

    // ── stage 2: fill the strictly-inside orders, in canonical order ────────

    fn alloc_full_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let total = self.elig_bids + self.elig_asks;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let p = self.clearing_price;
            let matched = self.matched_base;
            if self.cursor < self.elig_bids {
                let i = self.cursor as usize;
                let remaining = matched - self.filled_bid;
                let e = &mut self.bids[i];
                if e.limit_price > p {
                    let fill = min_u64(e.qty_sats, remaining);
                    e.fill_base = fill;
                    self.filled_bid += fill;
                } else {
                    self.pro_qty_bid = checked_add(self.pro_qty_bid, e.qty_sats)?;
                }
            } else {
                let i = (self.cursor - self.elig_bids) as usize;
                let remaining = matched - self.filled_ask;
                let e = &mut self.asks[i];
                if e.limit_price < p {
                    let fill = min_u64(e.qty_sats, remaining);
                    e.fill_base = fill;
                    self.filled_ask += fill;
                } else {
                    self.pro_qty_ask = checked_add(self.pro_qty_ask, e.qty_sats)?;
                }
            }
            self.cursor += 1;
            used += 1;
        }

        if self.cursor >= total {
            self.residual_bid = self.matched_base - self.filled_bid;
            self.residual_ask = self.matched_base - self.filled_ask;
            self.cursor = 0;
            self.stage = Stage::AllocProrata;
        }
        Ok(())
    }

    // ── stage 3: pro-rate the orders sitting exactly at p* ──────────────────

    fn alloc_prorata_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let total = self.elig_bids + self.elig_asks;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let p = self.clearing_price;
            if self.cursor < self.elig_bids {
                let i = self.cursor as usize;
                let residual = self.residual_bid;
                let pool = self.pro_qty_bid;
                if self.bids[i].limit_price == p && pool > 0 {
                    let qty = self.bids[i].qty_sats;
                    let base = floor_mul_div(residual, qty, pool)?;
                    let e = &mut self.bids[i];
                    e.fill_base = base;
                    e.frac = (residual as u128) * (qty as u128) - (base as u128) * (pool as u128);
                    e.bumped = false;
                    self.awarded_bid += base;
                }
            } else {
                let i = (self.cursor - self.elig_bids) as usize;
                let residual = self.residual_ask;
                let pool = self.pro_qty_ask;
                if self.asks[i].limit_price == p && pool > 0 {
                    let qty = self.asks[i].qty_sats;
                    let base = floor_mul_div(residual, qty, pool)?;
                    let e = &mut self.asks[i];
                    e.fill_base = base;
                    e.frac = (residual as u128) * (qty as u128) - (base as u128) * (pool as u128);
                    e.bumped = false;
                    self.awarded_ask += base;
                }
            }
            self.cursor += 1;
            used += 1;
        }

        if self.cursor >= total {
            self.cursor = 0;
            self.remainder_side = RemainderSide::Bid;
            self.stage = Stage::AllocRemainder;
        }
        Ok(())
    }

    // ── stage 4: the remainder, one sat at a time, largest fraction first ───

    /// Index of the largest unbumped fraction at exactly p* on one side. Canonical position
    /// breaks ties because the scan runs in canonical order and only a STRICT improvement wins.
    fn best_fraction(&self, is_bid: bool) -> Option<usize> {
        let (n, p) = if is_bid {
            (self.elig_bids, self.clearing_price)
        } else {
            (self.elig_asks, self.clearing_price)
        };
        let mut found: Option<usize> = None;
        let mut best_f = 0u128;
        for i in 0..n as usize {
            let e = if is_bid { &self.bids[i] } else { &self.asks[i] };
            if e.limit_price == p && !e.bumped && (found.is_none() || e.frac > best_f) {
                found = Some(i);
                best_f = e.frac;
            }
        }
        found
    }

    fn alloc_remainder_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let mut used = 0u64;
        while used < budget && self.remainder_side != RemainderSide::None {
            // NOTE: the side switch below does NOT consume budget, exactly as the Move
            // `continue` skips its `used = used + 1`.
            if self.remainder_side == RemainderSide::Bid {
                if self.awarded_bid >= self.residual_bid {
                    self.remainder_side = RemainderSide::Ask;
                    continue;
                }
                match self.best_fraction(true) {
                    None => {
                        self.remainder_side = RemainderSide::Ask;
                        continue;
                    }
                    Some(i) => {
                        let e = &mut self.bids[i];
                        e.fill_base += 1;
                        e.bumped = true;
                        self.awarded_bid += 1;
                    }
                }
            } else {
                if self.awarded_ask >= self.residual_ask {
                    self.remainder_side = RemainderSide::None;
                    continue;
                }
                match self.best_fraction(false) {
                    None => {
                        self.remainder_side = RemainderSide::None;
                        continue;
                    }
                    Some(i) => {
                        let e = &mut self.asks[i];
                        e.fill_base += 1;
                        e.bumped = true;
                        self.awarded_ask += 1;
                    }
                }
            }
            used += 1;
        }

        if self.remainder_side == RemainderSide::None {
            self.cursor = 0;
            self.stage = Stage::Rooting;
        }
        Ok(())
    }

    // ── stage 5: publish the fills and their Merkle root ────────────────────

    fn rooting_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let nb = self.bids.len() as u64;
        let total = nb + self.asks.len() as u64;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let p = self.clearing_price;
            let is_bid = self.cursor < nb;
            let e = if is_bid {
                self.bids[self.cursor as usize]
            } else {
                self.asks[(self.cursor - nb) as usize]
            };

            if e.fill_base > 0 {
                // @invariant 2 — asserted PER FILL, not merely by construction.
                if is_bid {
                    if p > e.limit_price {
                        return Err(ClearingError::FillOutsideLimit);
                    }
                } else if p < e.limit_price {
                    return Err(ClearingError::FillOutsideLimit);
                }

                let quote = if is_bid {
                    // Round TOWARD THE VAULT: the buyer pays up.
                    let q = ceil_mul_div(e.fill_base, p, PRICE_SCALE)?;
                    self.quote_paid = checked_add(self.quote_paid, q)?;
                    q
                } else {
                    // Round TOWARD THE VAULT: the seller receives down, net of the fee.
                    let gross = floor_mul_div(e.fill_base, p, PRICE_SCALE)?;
                    let fee = floor_mul_div(gross, self.fee_bps, BPS_DENOMINATOR)?;
                    let net = gross - fee;
                    self.quote_recv = checked_add(self.quote_recv, net)?;
                    net
                };

                self.fills.push(Fill {
                    batch_id: self.batch_id,
                    order_index: e.order_index,
                    submitter: e.submitter,
                    is_bid,
                    base_sats: e.fill_base,
                    quote_sats: quote,
                    price: p,
                });
            }

            self.cursor += 1;
            used += 1;
        }

        if self.cursor >= total {
            // Rounding toward the vault guarantees this is never negative.
            if self.quote_paid < self.quote_recv {
                return Err(ClearingError::ValueNotPreserved);
            }
            self.fee_quote = self.quote_paid - self.quote_recv;
            self.fills_root = merkle::compute_root(&self.fills);
            self.cursor = 0;
            self.stage = Stage::Settling;
            // The Move side emits BatchCleared here. There is no event surface off-chain;
            // `outcome()` carries the same four values.
        }
        Ok(())
    }

    // ── stage 6: push the fills into the two ledgers ────────────────────────

    fn debit(book: &mut BTreeMap<Address, Escrowed>, who: Address, sats: u64, base: bool) -> Result<(), ClearingError> {
        let row = book.entry(who).or_default();
        let slot = if base {
            &mut row.base_sats
        } else {
            &mut row.quote_sats
        };
        *slot = slot.checked_sub(sats).ok_or(ClearingError::LedgerUnderflow)?;
        Ok(())
    }

    fn credit(book: &mut BTreeMap<Address, Escrowed>, who: Address, sats: u64, base: bool) -> Result<(), ClearingError> {
        let row = book.entry(who).or_default();
        let slot = if base {
            &mut row.base_sats
        } else {
            &mut row.quote_sats
        };
        *slot = slot.checked_add(sats).ok_or(ClearingError::Overflow)?;
        Ok(())
    }

    fn settle_step(&mut self, budget: u64) -> Result<(), ClearingError> {
        let total = self.fills.len() as u64;
        let mut used = 0u64;
        while self.cursor < total && used < budget {
            let f = self.fills[self.cursor as usize];
            if f.is_bid {
                if f.quote_sats > 0 {
                    Self::debit(&mut self.escrow, f.submitter, f.quote_sats, false)?;
                    self.total_debits = checked_add(self.total_debits, f.quote_sats)?;
                }
                Self::credit(&mut self.escrow, f.submitter, f.base_sats, true)?;
                self.total_credits = checked_add(self.total_credits, f.base_sats)?;
            } else {
                Self::debit(&mut self.escrow, f.submitter, f.base_sats, true)?;
                self.total_debits = checked_add(self.total_debits, f.base_sats)?;
                if f.quote_sats > 0 {
                    Self::credit(&mut self.escrow, f.submitter, f.quote_sats, false)?;
                    self.total_credits = checked_add(self.total_credits, f.quote_sats)?;
                }
            }
            self.cursor += 1;
            used += 1;
        }

        if self.cursor >= total {
            // The fee is an EXPLICIT credit term, never a silent shortfall.
            if self.fee_quote > 0 {
                Self::credit(&mut self.escrow, self.fee_recipient, self.fee_quote, false)?;
                self.total_credits = checked_add(self.total_credits, self.fee_quote)?;
            }
            // @invariant 1 — hard constraint §2.6.
            if self.total_debits != self.total_credits {
                return Err(ClearingError::ValueNotPreserved);
            }
            self.stage = Stage::Done;
        }
        Ok(())
    }

    // ── read surface ────────────────────────────────────────────────────────

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn is_done(&self) -> bool {
        self.stage == Stage::Done
    }

    pub fn batch_id(&self) -> u64 {
        self.batch_id
    }

    pub fn clearing_price(&self) -> u64 {
        self.clearing_price
    }

    pub fn matched_base_sats(&self) -> u64 {
        self.matched_base
    }

    pub fn fills_root(&self) -> [u8; 32] {
        self.fills_root
    }

    pub fn fill_count(&self) -> usize {
        self.fills.len()
    }

    pub fn fill_at(&self, i: usize) -> Result<Fill, ClearingError> {
        self.fills
            .get(i)
            .copied()
            .ok_or(ClearingError::IndexOutOfRange)
    }

    pub fn fills(&self) -> &[Fill] {
        &self.fills
    }

    pub fn total_debits(&self) -> u64 {
        self.total_debits
    }

    pub fn total_credits(&self) -> u64 {
        self.total_credits
    }

    pub fn fee_quote_sats(&self) -> u64 {
        self.fee_quote
    }

    pub fn quote_paid_sats(&self) -> u64 {
        self.quote_paid
    }

    pub fn quote_recv_sats(&self) -> u64 {
        self.quote_recv
    }

    pub fn bid_count(&self) -> usize {
        self.bids.len()
    }

    pub fn ask_count(&self) -> usize {
        self.asks.len()
    }

    pub fn candidate_count(&self) -> usize {
        self.candidates.len()
    }

    pub fn eligible_bids(&self) -> u64 {
        self.elig_bids
    }

    pub fn eligible_asks(&self) -> u64 {
        self.elig_asks
    }

    fn view(e: &Entry) -> EntryView {
        EntryView {
            order_index: e.order_index,
            submitter: e.submitter,
            limit_price: e.limit_price,
            qty_sats: e.qty_sats,
            fill_base: e.fill_base,
        }
    }

    pub fn bid_entry_at(&self, i: usize) -> Result<EntryView, ClearingError> {
        self.bids
            .get(i)
            .map(Self::view)
            .ok_or(ClearingError::IndexOutOfRange)
    }

    pub fn ask_entry_at(&self, i: usize) -> Result<EntryView, ClearingError> {
        self.asks
            .get(i)
            .map(Self::view)
            .ok_or(ClearingError::IndexOutOfRange)
    }

    pub fn escrow_base_of(&self, who: Address) -> u64 {
        self.escrow_of(who).base_sats
    }

    pub fn escrow_quote_of(&self, who: Address) -> u64 {
        self.escrow_of(who).quote_sats
    }

    /// `clearing::verify_fill`, including the stage gate: a root is not final before SETTLING.
    pub fn verify_fill(
        &self,
        f: &Fill,
        index: usize,
        siblings: &[[u8; 32]],
    ) -> Result<bool, ClearingError> {
        if self.stage < Stage::Settling {
            return Err(ClearingError::NotFinal);
        }
        Ok(merkle::verify_fill(&self.fills_root, f, index, siblings))
    }

    pub fn sibling_path(&self, index: usize) -> Vec<[u8; 32]> {
        merkle::sibling_path(&self.fills, index)
    }

    pub fn outcome(&self) -> Outcome {
        Outcome {
            batch_id: self.batch_id,
            stage: self.stage,
            clearing_price: self.clearing_price,
            matched_base_sats: self.matched_base,
            fills: self.fills.clone(),
            fills_root: self.fills_root,
            quote_paid_sats: self.quote_paid,
            quote_recv_sats: self.quote_recv,
            fee_quote_sats: self.fee_quote,
            total_debits: self.total_debits,
            total_credits: self.total_credits,
            candidate_count: self.candidates.len(),
            eligible_bids: self.elig_bids as usize,
            eligible_asks: self.elig_asks as usize,
            bids: self.bids.iter().map(Self::view).collect(),
            asks: self.asks.iter().map(Self::view).collect(),
            escrow: self.escrow.clone(),
        }
    }

    /// Test-only: break value preservation on purpose so @invariant 1 is proven by a failing
    /// case rather than assumed. Mirrors `shrink_fill_quote_for_testing`.
    pub fn shrink_fill_quote_for_testing(&mut self, i: usize, by: u64) {
        self.fills[i].quote_sats -= by;
    }

    /// Test-only: mirrors `force_fill_price_for_testing`.
    pub fn force_fill_price_for_testing(&mut self, i: usize, price: u64) {
        self.fills[i].price = price;
    }
}

/// Run a batch to completion at the default settle budget. The convenience entry point the
/// keeper and the `sim` crate use.
pub fn clear(input: BatchInput) -> Result<Outcome, ClearingError> {
    let mut c = Clearing::begin(input);
    c.run(DEFAULT_SETTLE_BUDGET)?;
    Ok(c.outcome())
}
