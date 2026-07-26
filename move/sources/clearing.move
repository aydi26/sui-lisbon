module aphotic::clearing;

use aphotic::batch::{Self, Batch, BatchRegistry};
use aphotic::events;
use aphotic::vault::{Self, Vault};
use sui::bcs;
use sui::clock::Clock;
use sui::hash;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.2-the-batch (L344-L347)   <- uniform-price match, on-chain, in Move
// @spec       aphotic.md#2-hard-constraints (L55-L56) <- deterministic & reproducible; atomic
//             and value-preserving
// @spec       aphotic.md#10-invariants (L441-L446)   <- the Settlement invariants
// @spec       aphotic.md#12-open-questions (L503)    <- "fix a maximum batch size as a governed
//             parameter rather than discovering it in production"
// @spec       docs/DESIGN-V2.md#2-the-measured-ceilings
// @spec       docs/DESIGN-V2.md#5-clearing-determinism-is-the-product
// @rules      G10
// @depends    aphotic::batch (T3.3) · aphotic::vault (T1.2) · aphotic::events (T1.0)
// @facts      ── THE CEILING, SOLVED EXPLICITLY ──────────────────────────────────────────────
// @facts      None of these can be raised by paying more gas. The gas BUDGET is not the binding
// @facts      limit; a larger budget buys storage and never computation.
// @facts        object_runtime_max_num_store_entries = 1_000 per TRANSACTION
// @facts        max_num_event_emit                   = 1_024 per transaction
// @facts        max_gas_computation_bucket           = 5_000_000 units, hard-capped
// @facts        max_pure_argument_size               = 16_384 bytes
// @facts      WHAT CONSUMES THEM HERE, per settle_step: a fill touches ONE row of the base book
// @facts        and ONE row of the quote book ⇒ 2 store entries per fill. Events are emitted
// @facts        ONCE per batch (BatchCleared, BatchSettled) and never per fill — the fill Merkle
// @facts        root is what makes an individual fill provable, so a per-fill event would burn
// @facts        the 1_024 wall for no verifiability gain. `aphotic::events` forbids the struct
// @facts        outright, so this is structural, not a convention.
// @facts      CHOSEN BOUND: MAX_BATCH_SIZE is GOVERNED, default 256, and the setter hard-caps it
// @facts        at HARD_MAX_BATCH_SIZE = 512 (aphotic::batch). Justification:
// @facts          · 256 fills → 512 store entries: ~2× headroom under the 1_000 wall.
// @facts          · 512 fills → 1_024 store entries: OVER the wall in ONE transaction, which is
// @facts            exactly why settlement is CURSOR-DRIVEN — `settle_step(budget)` bounds the
// @facts            entries touched per transaction, and DEFAULT_SETTLE_BUDGET = 128 keeps any
// @facts            single settling transaction at ≤256 entries at any batch size.
// @facts          · 512 < aphotic::notes::max_spends_per_tx() = 800, so the escrow side cannot
// @facts            be the thing that breaks first either.
// @facts      RESUMABLE FROM DAY ONE, not retrofitted: every stage carries an on-chain cursor
// @facts        and takes a `budget`, so a clearing spans as many transactions as it needs and
// @facts        `n` can grow into the thousands with no contract change. Retrofitting resumption
// @facts        would have changed the state machine, the events and the tests.
// @facts      ⚠ THE 5 000 000-UNIT COMPUTATION CAP IS **NOT MEASURED HERE**. It is bounded by
// @facts        construction (every stage is budgeted) but the per-step constant is unmeasured
// @facts        on a live node. `scripts/measure-clearing.mjs` is the missing instrument; until
// @facts        it exists, treat 256 as a designed bound and not an observed one. Stated plainly
// @facts        rather than implied — DESIGN-V2 §2 requires measurement before mainnet.
// @facts      ── DETERMINISM IS THE PRODUCT ───────────────────────────────────────────────────
// @facts      CANONICAL ORDER, ties fully broken so implementation freedom is zero:
// @facts        bids  (limit_price DESC, submitter-as-u256 ASC, order_index ASC)
// @facts        asks  (limit_price ASC,  submitter-as-u256 ASC, order_index ASC)
// @facts        The address is compared as a u256 (`sui::address::to_u256`, big-endian by
// @facts        definition) — one integer compare instead of a 32-byte lexicographic loop.
// @facts      PRICE DISCOVERY: candidates are the distinct limit prices present.
// @facts        vol(p) = min(demand(p), supply(p)); pick max vol; tie-break min |demand−supply|;
// @facts        tie-break the LOWEST p. Candidates are scanned ASCENDING and the update is a
// @facts        STRICT improvement, so "lowest p" needs no extra branch. Integer only; there is
// @facts        no float anywhere in this module.
// @facts      ALLOCATION: orders strictly inside the cross fill first, in canonical order, until
// @facts        `matched` is exhausted; orders at EXACTLY p* share the residual pro-rata,
// @facts        floor(residual × qty_i / Σqty), and the remainder is distributed ONE SAT AT A
// @facts        TIME by largest fractional remainder, tie-broken by canonical position.
// @facts        ⚠ "strictly inside fills fully" is the normal case, NOT a theorem: with
// @facts        bid 100×10 against ask 90×3 the volume-maximising price is 90 and the single
// @facts        strictly-inside bid cannot fill fully. Canonical-order priority is the
// @facts        deterministic rule that covers it, and it degenerates to "fills fully" whenever
// @facts        the residual suffices.
// @facts      QUOTE CONVERSION rounds TOWARD THE VAULT — bids pay `ceil`, asks receive `floor` —
// @facts        so the dust residual can never be negative. PRICE_SCALE = 100_000_000, i.e. a
// @facts        limit price is quote-sats per 1e8 base-sats (per whole hBTC), matching hBTC's
// @facts        8 decimals (RECON R5).
// @facts      THE FEE IS AN EXPLICIT THIRD TERM, never a silent shortfall:
// @facts        Σdebits == Σcredits, where the fee is itself one of the credits.
// @facts        fee = (Σ bid ceil-quote − Σ ask net-quote) = per-ask fee + rounding dust.
// @facts      SOLVENCY WITHOUT LEAKING SIZE: there is no margin field on a sealed order — a
// @facts        margin would publish order size at submit time and defeat the whole design.
// @facts        Instead each order's quantity is TRUNCATED AT LOAD TIME to what the submitter's
// @facts        persistent internal balance can actually fund, at the order's OWN limit price
// @facts        (the worst case for a bid, since p* ≤ limit). A per-submitter running budget
// @facts        makes several orders from one account jointly funded. Escrow withdrawals are
// @facts        locked for the duration of a clearing (`vault::begin_clearing_lock`), so the
// @facts        snapshot cannot go stale underneath the computation; top-ups stay allowed
// @facts        because they can only make a fill MORE coverable.
// @facts      PUSH, NOT CLAIM (deviation of record, DESIGN-V2 §5 / GOVERNANCE D-G3). Spec §7.2
// @facts        step 5 has participants CLAIM fills. `settle_step` credits them directly and
// @facts        `verify_fill` is the transparency surface. A pull model leaves an unbounded
// @facts        unclaimed-liability state that must be excluded from NAV and reconciled forever;
// @facts        push makes settlement terminal. `verify_fill` still gives the front end the
// @facts        "prove my fill against the published root" affordance, which is what the claim
// @facts        story was actually for.
// @facts      FILL MERKLE TREE: leaf = blake2b256(0x00 ‖ bcs(Fill)), node = blake2b256(0x01 ‖ l ‖ r),
// @facts        odd nodes duplicated, empty tree = 32 zero bytes. Distinct from the note tree
// @facts        (aphotic::notes tags 0x00/0x01/0x02/0x03) — the two are never mixed: this root
// @facts        lives on the `Clearing` object and is verified only by `verify_fill`.
// @external   (none)
// @implements public fun begin<B,Q,S>(r: &BatchRegistry, b: &mut Batch, v: &mut Vault<B,Q,S>,
//                 clock: &Clock, ctx: &mut TxContext): Clearing
//             public fun share_clearing(c: Clearing)
//             public fun step<B,Q,S>(c: &mut Clearing, b: &mut Batch, r: &mut BatchRegistry,
//                 v: &mut Vault<B,Q,S>, budget: u64)
//             public fun verify_fill(c: &Clearing, f: &Fill, index: u64,
//                 siblings: &vector<vector<u8>>): bool
//             public fun fill_leaf_hash(f: &Fill): vector<u8>
//             public fun stage / clearing_price / matched_base_sats / fills_root / fill_count
//                 / fill_at / total_debits / total_credits / fee_quote_sats (&Clearing -> ..)
// @events     BatchCleared (once, when the price and root are final) · BatchSettled (once, when
//             every fill has been pushed). Both declared in aphotic::events.
// @errors     EBadStage · EBadParam · EWrongBatch · EWrongVault · EFillOutsideLimit
//             · EValueNotPreserved · EOverflow · EIndexOutOfRange · ENotFinal
// @forbidden  a per-fill event — the 1_024-event wall; `aphotic::events` declares no such struct
// @forbidden  a float, a sort that is not fully tie-broken, or any dependence on transaction
//             order — clearing must be reproducible off-chain byte-for-byte
// @forbidden  a margin / reserve field on a sealed order — it publishes size at submit time
// @forbidden  reading the wall clock anywhere in the match — `begin` takes the clock only to
//             hand it to `batch::to_clearing`, and nothing downstream consults it
// @invariant  1. `settle_step` reverts unless total debits equal total credits
//                (EValueNotPreserved), with the fee counted as an explicit credit term.
// @invariant  2. No participant is filled outside their limit price (EFillOutsideLimit),
//                asserted PER FILL rather than trusted to construction.
// @invariant  3. Every fill in the published root corresponds to exactly one revealed order:
//                fills carry `order_index`, indices are unique, and an unrevealed order is
//                never loaded.
// @invariant  4. Clearing is idempotent: the same order set yields the same price and the same
//                root, always.
// @invariant  5. Stepping a finished clearing is a no-op, not an abort.
// @invariant  6. A batch with no revealed orders still settles — price 0, empty root, zero
//                debits and credits — because the cadence settles every pass with or without
//                orders (spec §7.3).
// @ac         move/tests/clearing_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test clearing
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const EBadParam: u64 = 2;
const EWrongBatch: u64 = 3;
const EWrongVault: u64 = 4;
const EFillOutsideLimit: u64 = 5;
const EValueNotPreserved: u64 = 6;
const EOverflow: u64 = 7;
const EIndexOutOfRange: u64 = 8;
const ENotFinal: u64 = 9;

// ── stages (each carries its own cursor; all are budgeted) ──────────────────
const STAGE_LOADING: u8 = 0;
const STAGE_PRICING: u8 = 1;
const STAGE_ALLOC_FULL: u8 = 2;
const STAGE_ALLOC_PRORATA: u8 = 3;
const STAGE_ALLOC_REMAINDER: u8 = 4;
const STAGE_ROOTING: u8 = 5;
const STAGE_SETTLING: u8 = 6;
const STAGE_DONE: u8 = 7;

const SIDE_BID: u8 = 0;
const SIDE_ASK: u8 = 1;
const SIDE_NONE: u8 = 2;

/// A limit price is quote-sats per 1e8 base-sats — per whole hBTC, which has 8 decimals.
const PRICE_SCALE: u64 = 100_000_000;
const BPS_DENOMINATOR: u64 = 10_000;
const MAX_U64: u128 = 18_446_744_073_709_551_615;

const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;

/// Keeps any single settling transaction at ≤256 store entries whatever the batch size.
const DEFAULT_SETTLE_BUDGET: u64 = 128;

// ── structs ─────────────────────────────────────────────────────────────────

/// One side of one revealed order, in canonical position. `qty_sats` is already truncated to
/// what the submitter can fund; the raw submitted quantity is never used again.
public struct Entry has copy, drop, store {
    order_index: u64,
    submitter: address,
    /// The canonical tie-break: the address as a big-endian u256.
    key: u256,
    is_bid: bool,
    limit_price: u64,
    qty_sats: u64,
    fill_base: u64,
    /// `residual × qty_i − floor × Σqty` — the largest-remainder ranking value.
    frac: u128,
    bumped: bool,
}

/// A per-submitter funding snapshot, taken once and drawn down as their orders load.
public struct Funding has copy, drop, store {
    who: address,
    base_left: u64,
    quote_left: u64,
}

/// The published fill. This is the Merkle leaf, byte for byte.
public struct Fill has copy, drop, store {
    batch_id: u64,
    order_index: u64,
    submitter: address,
    is_bid: bool,
    base_sats: u64,
    quote_sats: u64,
    price: u64,
}

/// Stage-1 scratch state: the candidate price list and the two running scans that discover the
/// uniform price. Grouped into its own struct ONLY because the Sui bytecode verifier caps a
/// struct at 32 fields (`max_fields_in_struct`) and `Clearing` carries more state than that —
/// `sui move build` does not run that check, so a flat `Clearing` compiles and then fails at
/// publish with `VMVerificationOrDeserializationError`. No semantics live here.
public struct Pricing has drop, store {
    /// The distinct limit prices present, ASCENDING.
    candidates: vector<u64>,
    demand_remaining: u64,
    bid_scan: u64,
    supply_acc: u64,
    ask_scan: u64,
    found: bool,
    best_price: u64,
    best_vol: u64,
    best_gap: u64,
}

/// Stages 2–4 scratch state: the cleared price and every running total the three allocation
/// passes carry. Grouped for the same 32-field reason as `Pricing`.
public struct Allocation has drop, store {
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
    remainder_side: u8,
}

/// 19 fields — see `Pricing` for why the pricing and allocation blocks are nested rather than
/// inline. The 32-field verifier cap applies to `Pricing` and `Allocation` too (9 and 13).
public struct Clearing has key {
    id: UID,
    vault_id: ID,
    batch_id: u64,
    stage: u8,
    cursor: u64,
    // ── loading ──
    funding: vector<Funding>,
    bids: vector<Entry>,
    asks: vector<Entry>,
    // ── pricing (stage 1) ──
    pricing: Pricing,
    // ── allocation (stages 2–4) ──
    alloc: Allocation,
    // ── rooting ──
    fills: vector<Fill>,
    fills_root: vector<u8>,
    quote_paid: u64,
    quote_recv: u64,
    fee_quote: u64,
    // ── settling ──
    total_debits: u64,
    total_credits: u64,
    fee_bps: u64,
    fee_recipient: address,
}

// ── integer helpers ─────────────────────────────────────────────────────────

fun floor_mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c > 0, EBadParam);
    let r = ((a as u128) * (b as u128)) / (c as u128);
    assert!(r <= MAX_U64, EOverflow);
    r as u64
}

fun ceil_mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c > 0, EBadParam);
    let n = (a as u128) * (b as u128);
    let r = (n + (c as u128) - 1) / (c as u128);
    assert!(r <= MAX_U64, EOverflow);
    r as u64
}

fun checked_add(a: u64, b: u64): u64 {
    let r = (a as u128) + (b as u128);
    assert!(r <= MAX_U64, EOverflow);
    r as u64
}

fun min_u64(a: u64, b: u64): u64 { if (a < b) a else b }

fun abs_diff_u64(a: u64, b: u64): u64 { if (a >= b) a - b else b - a }

// ── genesis ─────────────────────────────────────────────────────────────────

/// Move the batch SEALED → CLEARING and take the escrow snapshot lock.
///
/// Permissionless (spec §9: liveness is not a privilege). The `Clock` is consumed here and
/// nowhere else — nothing in the match itself reads a clock, which is half of why the result is
/// reproducible off-chain.
public fun begin<B, Q, S>(
    r: &BatchRegistry,
    b: &mut Batch,
    v: &mut Vault<B, Q, S>,
    clock: &Clock,
    ctx: &mut TxContext,
): Clearing {
    let vault_id = object::id(v);
    assert!(batch::batch_vault_id(b) == vault_id, EWrongVault);
    assert!(batch::registry_vault_id(r) == vault_id, EWrongVault);

    batch::to_clearing(b, clock);
    vault::begin_clearing_lock(v);

    Clearing {
        id: object::new(ctx),
        vault_id,
        batch_id: batch::batch_id(b),
        stage: STAGE_LOADING,
        cursor: 0,
        funding: vector[],
        bids: vector[],
        asks: vector[],
        pricing: Pricing {
            candidates: vector[],
            demand_remaining: 0,
            bid_scan: 0,
            supply_acc: 0,
            ask_scan: 0,
            found: false,
            best_price: 0,
            best_vol: 0,
            best_gap: 0,
        },
        alloc: Allocation {
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
            remainder_side: SIDE_BID,
        },
        fills: vector[],
        fills_root: vector[],
        quote_paid: 0,
        quote_recv: 0,
        fee_quote: 0,
        total_debits: 0,
        total_credits: 0,
        fee_bps: vault::fee_matched_bps(v),
        fee_recipient: vault::fee_recipient(v),
    }
}

public fun share_clearing(c: Clearing) {
    transfer::share_object(c);
}

// ── the one public driver ───────────────────────────────────────────────────

/// Advance the clearing by at most `budget` units of work. Permissionless, and safe to call
/// after the clearing has finished (@invariant 5).
///
/// A "unit" means: one order loaded · one candidate price evaluated · one order allocated ·
/// one remainder sat awarded · one fill hashed · one fill pushed to the ledger.
public fun step<B, Q, S>(
    c: &mut Clearing,
    b: &mut Batch,
    r: &mut BatchRegistry,
    v: &mut Vault<B, Q, S>,
    budget: u64,
) {
    assert!(budget > 0, EBadParam);
    assert!(batch::batch_id(b) == c.batch_id, EWrongBatch);
    assert!(batch::batch_vault_id(b) == c.vault_id, EWrongVault);
    assert!(object::id(v) == c.vault_id, EWrongVault);

    if (c.stage == STAGE_LOADING) {
        load_step(c, b, v, budget)
    } else if (c.stage == STAGE_PRICING) {
        price_step(c, budget)
    } else if (c.stage == STAGE_ALLOC_FULL) {
        alloc_full_step(c, budget)
    } else if (c.stage == STAGE_ALLOC_PRORATA) {
        alloc_prorata_step(c, budget)
    } else if (c.stage == STAGE_ALLOC_REMAINDER) {
        alloc_remainder_step(c, budget)
    } else if (c.stage == STAGE_ROOTING) {
        rooting_step(c, budget)
    } else if (c.stage == STAGE_SETTLING) {
        settle_step(c, b, r, v, budget)
    };
    // STAGE_DONE falls through: stepping a finished clearing does nothing.
}

// ── stage 0: load, funding-truncate, and insert in canonical position ───────

fun funding_row<B, Q, S>(c: &mut Clearing, v: &Vault<B, Q, S>, who: address): u64 {
    let n = c.funding.length();
    let mut i = 0;
    while (i < n) {
        if (c.funding.borrow(i).who == who) return i;
        i = i + 1;
    };
    c.funding.push_back(Funding {
        who,
        base_left: vault::escrow_base_of(v, who),
        quote_left: vault::escrow_quote_of(v, who),
    });
    n
}

fun load_step<B, Q, S>(c: &mut Clearing, b: &Batch, v: &Vault<B, Q, S>, budget: u64) {
    let total = batch::order_count(b);
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let i = c.cursor;
        if (batch::is_revealed_at(b, i)) {
            let o = batch::revealed_at(b, i);
            let who = batch::order_submitter(&o);
            let is_bid = batch::order_is_bid(&o);
            let price = batch::order_limit_price(&o);
            let qty = batch::order_qty_sats(&o);

            let row_i = funding_row(c, v, who);
            let effective = {
                let row = c.funding.borrow_mut(row_i);
                if (is_bid) {
                    // Worst case: the bid could clear at its own limit, never above it.
                    let afford_u128 =
                        ((row.quote_left as u128) * (PRICE_SCALE as u128)) / (price as u128);
                    let afford = if (afford_u128 > MAX_U64) (MAX_U64 as u64)
                        else (afford_u128 as u64);
                    let e = min_u64(qty, afford);
                    if (e > 0) {
                        let cost = ceil_mul_div(e, price, PRICE_SCALE);
                        row.quote_left = row.quote_left - cost;
                    };
                    e
                } else {
                    let e = min_u64(qty, row.base_left);
                    row.base_left = row.base_left - e;
                    e
                }
            };

            if (effective > 0) {
                let entry = Entry {
                    order_index: i,
                    submitter: who,
                    key: sui::address::to_u256(who),
                    is_bid,
                    limit_price: price,
                    qty_sats: effective,
                    fill_base: 0,
                    frac: 0,
                    bumped: false,
                };
                insert_canonical(c, entry);
            };
        };
        c.cursor = i + 1;
        used = used + 1;
    };

    if (c.cursor >= total) finish_loading(c);
}

/// `true` iff `a` precedes `b` on the bid side: price DESC, then key ASC, then index ASC.
fun bid_precedes(a: &Entry, b: &Entry): bool {
    if (a.limit_price != b.limit_price) return a.limit_price > b.limit_price;
    if (a.key != b.key) return a.key < b.key;
    a.order_index < b.order_index
}

/// Ask side: price ASC, then key ASC, then index ASC.
fun ask_precedes(a: &Entry, b: &Entry): bool {
    if (a.limit_price != b.limit_price) return a.limit_price < b.limit_price;
    if (a.key != b.key) return a.key < b.key;
    a.order_index < b.order_index
}

fun insert_canonical(c: &mut Clearing, e: Entry) {
    if (e.is_bid) {
        let n = c.bids.length();
        let mut i = 0;
        while (i < n && !bid_precedes(&e, c.bids.borrow(i))) i = i + 1;
        c.bids.insert(e, i);
    } else {
        let n = c.asks.length();
        let mut i = 0;
        while (i < n && !ask_precedes(&e, c.asks.borrow(i))) i = i + 1;
        c.asks.insert(e, i);
    }
}

/// Build the candidate price list — the distinct limit prices present, ASCENDING — by merging
/// the two already-sorted sides. Bids are walked backwards because they are sorted DESC.
fun finish_loading(c: &mut Clearing) {
    let nb = c.bids.length();
    let na = c.asks.length();

    let mut total_bid_qty = 0u64;
    let mut i = 0;
    while (i < nb) {
        total_bid_qty = checked_add(total_bid_qty, c.bids.borrow(i).qty_sats);
        i = i + 1;
    };

    let mut out = vector<u64>[];
    let mut bi = nb;
    let mut ai = 0;
    let mut has_last = false;
    let mut last = 0u64;
    while (bi > 0 || ai < na) {
        let take_bid = if (bi == 0) false
            else if (ai >= na) true
            else c.bids.borrow(bi - 1).limit_price <= c.asks.borrow(ai).limit_price;
        let p = if (take_bid) {
            bi = bi - 1;
            c.bids.borrow(bi).limit_price
        } else {
            let x = c.asks.borrow(ai).limit_price;
            ai = ai + 1;
            x
        };
        if (!has_last || p != last) {
            out.push_back(p);
            last = p;
            has_last = true;
        };
    };

    c.pricing.candidates = out;
    c.pricing.demand_remaining = total_bid_qty;
    c.pricing.bid_scan = nb;
    c.pricing.supply_acc = 0;
    c.pricing.ask_scan = 0;
    c.cursor = 0;
    c.stage = STAGE_PRICING;
    if (c.pricing.candidates.is_empty()) finish_pricing(c);
}

// ── stage 1: uniform price discovery ────────────────────────────────────────

fun price_step(c: &mut Clearing, budget: u64) {
    let total = c.pricing.candidates.length();
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let p = *c.pricing.candidates.borrow(c.cursor);

        // Bids qualify while limit >= p. Sorted DESC, so the qualifying set is a PREFIX that
        // shrinks from the back as p rises.
        while (c.pricing.bid_scan > 0 && c.bids.borrow(c.pricing.bid_scan - 1).limit_price < p) {
            c.pricing.demand_remaining = c.pricing.demand_remaining - c.bids.borrow(c.pricing.bid_scan - 1).qty_sats;
            c.pricing.bid_scan = c.pricing.bid_scan - 1;
        };
        // Asks qualify while limit <= p. Sorted ASC, so the qualifying set is a growing prefix.
        while (
            c.pricing.ask_scan < c.asks.length() && c.asks.borrow(c.pricing.ask_scan).limit_price <= p
        ) {
            c.pricing.supply_acc = checked_add(c.pricing.supply_acc, c.asks.borrow(c.pricing.ask_scan).qty_sats);
            c.pricing.ask_scan = c.pricing.ask_scan + 1;
        };

        let vol = min_u64(c.pricing.demand_remaining, c.pricing.supply_acc);
        let gap = abs_diff_u64(c.pricing.demand_remaining, c.pricing.supply_acc);
        // Strict improvement only, and candidates ascend, so the lowest price wins every tie.
        if (vol > 0 && (!c.pricing.found || vol > c.pricing.best_vol || (vol == c.pricing.best_vol && gap < c.pricing.best_gap))) {
            c.pricing.found = true;
            c.pricing.best_vol = vol;
            c.pricing.best_gap = gap;
            c.pricing.best_price = p;
        };

        c.cursor = c.cursor + 1;
        used = used + 1;
    };

    if (c.cursor >= total) finish_pricing(c);
}

fun finish_pricing(c: &mut Clearing) {
    if (!c.pricing.found) {
        // No cross. A batch with no crossing interest still settles — spec §7.3 settles every
        // pass, with or without orders.
        c.alloc.clearing_price = 0;
        c.alloc.matched_base = 0;
        c.alloc.elig_bids = 0;
        c.alloc.elig_asks = 0;
        c.cursor = 0;
        c.stage = STAGE_ROOTING;
        return
    };

    let p = c.pricing.best_price;
    c.alloc.clearing_price = p;

    let mut demand = 0u64;
    let mut nb = 0;
    while (nb < c.bids.length() && c.bids.borrow(nb).limit_price >= p) {
        demand = checked_add(demand, c.bids.borrow(nb).qty_sats);
        nb = nb + 1;
    };
    let mut supply = 0u64;
    let mut na = 0;
    while (na < c.asks.length() && c.asks.borrow(na).limit_price <= p) {
        supply = checked_add(supply, c.asks.borrow(na).qty_sats);
        na = na + 1;
    };

    c.alloc.elig_bids = nb;
    c.alloc.elig_asks = na;
    c.alloc.matched_base = min_u64(demand, supply);
    c.cursor = 0;
    c.stage = STAGE_ALLOC_FULL;
}

// ── stage 2: fill the strictly-inside orders, in canonical order ────────────

fun alloc_full_step(c: &mut Clearing, budget: u64) {
    let total = c.alloc.elig_bids + c.alloc.elig_asks;
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let p = c.alloc.clearing_price;
        let matched = c.alloc.matched_base;
        if (c.cursor < c.alloc.elig_bids) {
            let i = c.cursor;
            let remaining = matched - c.alloc.filled_bid;
            let e = c.bids.borrow_mut(i);
            if (e.limit_price > p) {
                let fill = min_u64(e.qty_sats, remaining);
                e.fill_base = fill;
                c.alloc.filled_bid = c.alloc.filled_bid + fill;
            } else {
                c.alloc.pro_qty_bid = checked_add(c.alloc.pro_qty_bid, e.qty_sats);
            };
        } else {
            let i = c.cursor - c.alloc.elig_bids;
            let remaining = matched - c.alloc.filled_ask;
            let e = c.asks.borrow_mut(i);
            if (e.limit_price < p) {
                let fill = min_u64(e.qty_sats, remaining);
                e.fill_base = fill;
                c.alloc.filled_ask = c.alloc.filled_ask + fill;
            } else {
                c.alloc.pro_qty_ask = checked_add(c.alloc.pro_qty_ask, e.qty_sats);
            };
        };
        c.cursor = c.cursor + 1;
        used = used + 1;
    };

    if (c.cursor >= total) {
        c.alloc.residual_bid = c.alloc.matched_base - c.alloc.filled_bid;
        c.alloc.residual_ask = c.alloc.matched_base - c.alloc.filled_ask;
        c.cursor = 0;
        c.stage = STAGE_ALLOC_PRORATA;
    };
}

// ── stage 3: pro-rate the orders sitting exactly at p* ──────────────────────

fun alloc_prorata_step(c: &mut Clearing, budget: u64) {
    let total = c.alloc.elig_bids + c.alloc.elig_asks;
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let p = c.alloc.clearing_price;
        if (c.cursor < c.alloc.elig_bids) {
            let i = c.cursor;
            let residual = c.alloc.residual_bid;
            let pool = c.alloc.pro_qty_bid;
            let e = c.bids.borrow_mut(i);
            if (e.limit_price == p && pool > 0) {
                let base = floor_mul_div(residual, e.qty_sats, pool);
                e.fill_base = base;
                e.frac =
                    ((residual as u128) * (e.qty_sats as u128)) - ((base as u128) * (pool as u128));
                e.bumped = false;
                c.alloc.awarded_bid = c.alloc.awarded_bid + base;
            };
        } else {
            let i = c.cursor - c.alloc.elig_bids;
            let residual = c.alloc.residual_ask;
            let pool = c.alloc.pro_qty_ask;
            let e = c.asks.borrow_mut(i);
            if (e.limit_price == p && pool > 0) {
                let base = floor_mul_div(residual, e.qty_sats, pool);
                e.fill_base = base;
                e.frac =
                    ((residual as u128) * (e.qty_sats as u128)) - ((base as u128) * (pool as u128));
                e.bumped = false;
                c.alloc.awarded_ask = c.alloc.awarded_ask + base;
            };
        };
        c.cursor = c.cursor + 1;
        used = used + 1;
    };

    if (c.cursor >= total) {
        c.cursor = 0;
        c.alloc.remainder_side = SIDE_BID;
        c.stage = STAGE_ALLOC_REMAINDER;
    };
}

// ── stage 4: the remainder, one sat at a time, largest fraction first ───────

/// Index of the largest unbumped fraction at exactly p* on one side, canonical position
/// breaking ties because the scan runs in canonical order and only a STRICT improvement wins.
fun best_fraction(c: &Clearing, is_bid: bool): (bool, u64) {
    let (n, p) = if (is_bid) (c.alloc.elig_bids, c.alloc.clearing_price) else (c.alloc.elig_asks, c.alloc.clearing_price);
    let mut found = false;
    let mut best_i = 0;
    let mut best_f = 0u128;
    let mut i = 0;
    while (i < n) {
        let e = if (is_bid) c.bids.borrow(i) else c.asks.borrow(i);
        if (e.limit_price == p && !e.bumped) {
            if (!found || e.frac > best_f) {
                found = true;
                best_f = e.frac;
                best_i = i;
            };
        };
        i = i + 1;
    };
    (found, best_i)
}

fun alloc_remainder_step(c: &mut Clearing, budget: u64) {
    let mut used = 0;
    while (used < budget && c.alloc.remainder_side != SIDE_NONE) {
        if (c.alloc.remainder_side == SIDE_BID) {
            if (c.alloc.awarded_bid >= c.alloc.residual_bid) {
                c.alloc.remainder_side = SIDE_ASK;
                continue
            };
            let (ok, i) = best_fraction(c, true);
            if (!ok) {
                c.alloc.remainder_side = SIDE_ASK;
                continue
            };
            let e = c.bids.borrow_mut(i);
            e.fill_base = e.fill_base + 1;
            e.bumped = true;
            c.alloc.awarded_bid = c.alloc.awarded_bid + 1;
        } else {
            if (c.alloc.awarded_ask >= c.alloc.residual_ask) {
                c.alloc.remainder_side = SIDE_NONE;
                continue
            };
            let (ok, i) = best_fraction(c, false);
            if (!ok) {
                c.alloc.remainder_side = SIDE_NONE;
                continue
            };
            let e = c.asks.borrow_mut(i);
            e.fill_base = e.fill_base + 1;
            e.bumped = true;
            c.alloc.awarded_ask = c.alloc.awarded_ask + 1;
        };
        used = used + 1;
    };

    if (c.alloc.remainder_side == SIDE_NONE) {
        c.cursor = 0;
        c.stage = STAGE_ROOTING;
    };
}

// ── stage 5: publish the fills and their Merkle root ────────────────────────

fun rooting_step(c: &mut Clearing, budget: u64) {
    let nb = c.bids.length();
    let total = nb + c.asks.length();
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let p = c.alloc.clearing_price;
        let is_bid = c.cursor < nb;
        let e = if (is_bid) *c.bids.borrow(c.cursor) else *c.asks.borrow(c.cursor - nb);

        if (e.fill_base > 0) {
            // @invariant 2 — asserted per fill, not merely by construction.
            if (is_bid) {
                assert!(p <= e.limit_price, EFillOutsideLimit);
            } else {
                assert!(p >= e.limit_price, EFillOutsideLimit);
            };

            let quote = if (is_bid) {
                // Round TOWARD THE VAULT: the buyer pays up.
                let q = ceil_mul_div(e.fill_base, p, PRICE_SCALE);
                c.quote_paid = checked_add(c.quote_paid, q);
                q
            } else {
                // Round TOWARD THE VAULT: the seller receives down, net of the matched fee.
                let gross = floor_mul_div(e.fill_base, p, PRICE_SCALE);
                let fee = floor_mul_div(gross, c.fee_bps, BPS_DENOMINATOR);
                let net = gross - fee;
                c.quote_recv = checked_add(c.quote_recv, net);
                net
            };

            c.fills.push_back(Fill {
                batch_id: c.batch_id,
                order_index: e.order_index,
                submitter: e.submitter,
                is_bid,
                base_sats: e.fill_base,
                quote_sats: quote,
                price: p,
            });
        };

        c.cursor = c.cursor + 1;
        used = used + 1;
    };

    if (c.cursor >= total) {
        // Rounding toward the vault guarantees this is never negative.
        assert!(c.quote_paid >= c.quote_recv, EValueNotPreserved);
        c.fee_quote = c.quote_paid - c.quote_recv;
        c.fills_root = compute_root(&c.fills);
        c.cursor = 0;
        c.stage = STAGE_SETTLING;

        events::emit_batch_cleared(
            c.vault_id,
            c.batch_id,
            c.alloc.clearing_price,
            c.alloc.matched_base,
            c.fills_root,
        );
    };
}

public fun fill_leaf_hash(f: &Fill): vector<u8> {
    let mut buf = vector[LEAF_TAG];
    buf.append(bcs::to_bytes(f));
    hash::blake2b256(&buf)
}

fun hash_pair(l: &vector<u8>, r: &vector<u8>): vector<u8> {
    let mut buf = vector[NODE_TAG];
    buf.append(*l);
    buf.append(*r);
    hash::blake2b256(&buf)
}

fun zero_root(): vector<u8> {
    let mut out = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) {
        out.push_back(0u8);
        i = i + 1;
    };
    out
}

fun compute_root(fills: &vector<Fill>): vector<u8> {
    let n = fills.length();
    if (n == 0) return zero_root();

    let mut level = vector<vector<u8>>[];
    let mut i = 0;
    while (i < n) {
        level.push_back(fill_leaf_hash(fills.borrow(i)));
        i = i + 1;
    };

    while (level.length() > 1) {
        let mut next = vector<vector<u8>>[];
        let m = level.length();
        let mut j = 0;
        while (j < m) {
            let l = level.borrow(j);
            // Odd node duplicated.
            let r = if (j + 1 < m) level.borrow(j + 1) else l;
            next.push_back(hash_pair(l, r));
            j = j + 2;
        };
        level = next;
    };
    *level.borrow(0)
}

/// The transparency surface that replaces the pull-based claim (deviation D-G3): prove a fill
/// against the published root without touching any balance.
public fun verify_fill(
    c: &Clearing,
    f: &Fill,
    index: u64,
    siblings: &vector<vector<u8>>,
): bool {
    assert!(c.stage >= STAGE_SETTLING, ENotFinal);
    let mut current = fill_leaf_hash(f);
    let mut idx = index;
    let mut i = 0;
    let n = siblings.length();
    while (i < n) {
        let sib = siblings.borrow(i);
        current = if (idx % 2 == 0) hash_pair(&current, sib) else hash_pair(sib, &current);
        idx = idx / 2;
        i = i + 1;
    };
    current == c.fills_root
}

// ── stage 6: push the fills into the two ledgers ────────────────────────────

fun settle_step<B, Q, S>(
    c: &mut Clearing,
    b: &mut Batch,
    r: &mut BatchRegistry,
    v: &mut Vault<B, Q, S>,
    budget: u64,
) {
    let total = c.fills.length();
    let mut used = 0;
    while (c.cursor < total && used < budget) {
        let f = *c.fills.borrow(c.cursor);
        if (f.is_bid) {
            if (f.quote_sats > 0) {
                vault::settle_debit_quote(v, f.submitter, f.quote_sats);
                c.total_debits = checked_add(c.total_debits, f.quote_sats);
            };
            vault::settle_credit_base(v, f.submitter, f.base_sats);
            c.total_credits = checked_add(c.total_credits, f.base_sats);
        } else {
            vault::settle_debit_base(v, f.submitter, f.base_sats);
            c.total_debits = checked_add(c.total_debits, f.base_sats);
            if (f.quote_sats > 0) {
                vault::settle_credit_quote(v, f.submitter, f.quote_sats);
                c.total_credits = checked_add(c.total_credits, f.quote_sats);
            };
        };
        c.cursor = c.cursor + 1;
        used = used + 1;
    };

    if (c.cursor >= total) {
        // The fee is an EXPLICIT credit term, never a silent shortfall.
        if (c.fee_quote > 0) {
            vault::settle_credit_quote(v, c.fee_recipient, c.fee_quote);
            c.total_credits = checked_add(c.total_credits, c.fee_quote);
        };
        // @invariant 1 — hard constraint §2.6.
        assert!(c.total_debits == c.total_credits, EValueNotPreserved);
        vault::assert_escrow_solvent(v);

        batch::to_settled(b, r);
        vault::end_clearing_lock(v);
        c.stage = STAGE_DONE;

        events::emit_batch_settled(c.vault_id, c.batch_id, c.total_debits, c.total_credits);
    };
}

// ── read surface ────────────────────────────────────────────────────────────

public fun stage(c: &Clearing): u8 { c.stage }

public fun is_done(c: &Clearing): bool { c.stage == STAGE_DONE }

public fun clearing_vault_id(c: &Clearing): ID { c.vault_id }

public fun clearing_batch_id(c: &Clearing): u64 { c.batch_id }

public fun clearing_price(c: &Clearing): u64 { c.alloc.clearing_price }

public fun matched_base_sats(c: &Clearing): u64 { c.alloc.matched_base }

public fun fills_root(c: &Clearing): vector<u8> { c.fills_root }

public fun fill_count(c: &Clearing): u64 { c.fills.length() }

public fun fill_at(c: &Clearing, i: u64): Fill {
    assert!(i < c.fills.length(), EIndexOutOfRange);
    *c.fills.borrow(i)
}

public fun total_debits(c: &Clearing): u64 { c.total_debits }

public fun total_credits(c: &Clearing): u64 { c.total_credits }

public fun fee_quote_sats(c: &Clearing): u64 { c.fee_quote }

public fun quote_paid_sats(c: &Clearing): u64 { c.quote_paid }

public fun quote_recv_sats(c: &Clearing): u64 { c.quote_recv }

public fun bid_count(c: &Clearing): u64 { c.bids.length() }

public fun ask_count(c: &Clearing): u64 { c.asks.length() }

public fun candidate_count(c: &Clearing): u64 { c.pricing.candidates.length() }

public fun eligible_bids(c: &Clearing): u64 { c.alloc.elig_bids }

public fun eligible_asks(c: &Clearing): u64 { c.alloc.elig_asks }

public fun bid_entry_at(c: &Clearing, i: u64): (u64, address, u64, u64, u64) {
    assert!(i < c.bids.length(), EIndexOutOfRange);
    let e = c.bids.borrow(i);
    (e.order_index, e.submitter, e.limit_price, e.qty_sats, e.fill_base)
}

public fun ask_entry_at(c: &Clearing, i: u64): (u64, address, u64, u64, u64) {
    assert!(i < c.asks.length(), EIndexOutOfRange);
    let e = c.asks.borrow(i);
    (e.order_index, e.submitter, e.limit_price, e.qty_sats, e.fill_base)
}

public fun fill_batch_id(f: &Fill): u64 { f.batch_id }

public fun fill_order_index(f: &Fill): u64 { f.order_index }

public fun fill_submitter(f: &Fill): address { f.submitter }

public fun fill_is_bid(f: &Fill): bool { f.is_bid }

public fun fill_base_sats(f: &Fill): u64 { f.base_sats }

public fun fill_quote_sats(f: &Fill): u64 { f.quote_sats }

public fun fill_price(f: &Fill): u64 { f.price }

public fun price_scale(): u64 { PRICE_SCALE }

public fun default_settle_budget(): u64 { DEFAULT_SETTLE_BUDGET }

public fun stage_loading(): u8 { STAGE_LOADING }

public fun stage_pricing(): u8 { STAGE_PRICING }

public fun stage_rooting(): u8 { STAGE_ROOTING }

public fun stage_settling(): u8 { STAGE_SETTLING }

public fun stage_done(): u8 { STAGE_DONE }

// ── test-only helpers ───────────────────────────────────────────────────────

/// Break value preservation on purpose so @invariant 1 is proven by a failing case rather than
/// assumed from construction. Shrinking a credit cannot abort inside the ledger, so the abort
/// that follows is the one being tested.
#[test_only]
public fun shrink_fill_quote_for_testing(c: &mut Clearing, i: u64, by: u64) {
    let f = c.fills.borrow_mut(i);
    f.quote_sats = f.quote_sats - by;
}

#[test_only]
public fun force_fill_price_for_testing(c: &mut Clearing, i: u64, price: u64) {
    let f = c.fills.borrow_mut(i);
    f.price = price;
}

#[test_only]
public fun sibling_path_for_testing(c: &Clearing, index: u64): vector<vector<u8>> {
    let n = c.fills.length();
    let mut siblings = vector<vector<u8>>[];
    if (n == 0) return siblings;

    let mut level = vector<vector<u8>>[];
    let mut i = 0u64;
    while (i < n) {
        level.push_back(fill_leaf_hash(c.fills.borrow(i)));
        i = i + 1;
    };
    let mut idx = index;
    while (level.length() > 1) {
        let m = level.length();
        let sib_i = if (idx % 2 == 0) { if (idx + 1 < m) idx + 1 else idx } else idx - 1;
        siblings.push_back(*level.borrow(sib_i));

        let mut next = vector<vector<u8>>[];
        let mut j = 0;
        while (j < m) {
            let l = level.borrow(j);
            let r = if (j + 1 < m) level.borrow(j + 1) else l;
            next.push_back(hash_pair(l, r));
            j = j + 2;
        };
        level = next;
        idx = idx / 2;
    };
    siblings
}

#[test_only]
public fun destroy_for_testing(c: Clearing) {
    let Clearing {
        id,
        vault_id: _,
        batch_id: _,
        stage: _,
        cursor: _,
        funding: _,
        bids: _,
        asks: _,
        pricing: _,
        alloc: _,
        fills: _,
        fills_root: _,
        quote_paid: _,
        quote_recv: _,
        fee_quote: _,
        total_debits: _,
        total_credits: _,
        fee_bps: _,
        fee_recipient: _,
    } = c;
    id.delete();
}
