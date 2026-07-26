// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move  <- ★ THE AUTHORITY. This file MIRRORS the DEPLOYED
//             Move package (v2, 0x653a8128…). Where Move and docs/DESIGN-V2.md §5bis disagree,
//             Move wins, because Move is what settles money and its `Fill` fields are frozen by
//             the `compatible` upgrade policy.
// @spec       docs/DESIGN-V2.md#5 (canonical order · price discovery · allocation · limit safety ·
//             quote conversion · root · the fee term · post-discovery truncation)
// @spec       docs/DESIGN-V2.md#5ter/#5quater (the D1–D5 divergence census this file closes)
// @spec       docs/DESIGN-V2.md#9 (Move, TS and Rust must agree byte for byte — L1 golden
//             fixtures, L2 property, L3 devInspect)
// @spec       aphotic.md §2.5 (deterministic and reproducible) · §2.6 (atomic, value-preserving)
// @rules      G5 G10
// @depends    ./math.ts · ./bcs.ts · ./merkle.ts · ./hash.ts · ./address.ts
// @facts      ── WHAT CHANGED, AND WHY (the D-census, closed 2026-07-26) ──────────────────────
// @facts      D1 THE LEAF. Move's `struct Fill` is { batch_id, order_index, submitter, is_bid,
// @facts        base_sats, quote_sats, price } ⇒ bcs = 8+8+32+1+8+8+8 = 73 bytes. This file used
// @facts        to emit 81 (an extra `fee`, no `batch_id`, a u128 price). Two different leaves
// @facts        can never Merkle to the same root, so NO byte comparison meant anything while
// @facts        that stood. The SDK moved to Move; Move could not move to the SDK.
// @facts      D3 THE FEE. Move charges EACH ask `floor(gross * bps / 10_000)` individually, PUBLISHES
// @facts        THE NET (`quote_sats = gross - fee`), and reports
// @facts            fee_quote = Σ bid ceil-quote − Σ ask net-quote,
// @facts        which therefore FOLDS THE ROUNDING DUST INTO THE FEE. There is no separate dust
// @facts        credit on chain: `settle_step` credits `fee_recipient` exactly `fee_quote`, so at
// @facts        0 bps the fee recipient still receives the dust. This file used to compute ONE
// @facts        aggregate floor(matched_quote·bps/1e4) apportioned by largest remainder, with dust
// @facts        as a fourth term. It now does what Move does; `dustQuote` survives as the
// @facts        REPORTED COMPONENT of `feeQuote` that is rounding residue rather than fee.
// @facts      D5 PRICE WIDTH. A limit price is a Move `u64`. It was u128 here. A u128 price is now
// @facts        REJECTED at validation rather than silently accepted into a book Move cannot hold.
// @facts      D2/D4 were closed on the Move side by the v2 upgrade (pro-rata at the marginal
// @facts        level; truncation AFTER price discovery). This file already did both.
// @facts      ── THE ALGORITHM, IN MOVE'S OWN STAGE ORDER ─────────────────────────────────────
// @facts      SIDE_BID = 0 (buys base, pays quote) · SIDE_ASK = 1 (sells base, receives quote)
// @facts      PRICE_SCALE = 100_000_000 (1e8) = `aphotic::clearing::price_scale()`. A limit price
// @facts        is quote-sats per 1e8 base-sats — per whole hBTC, which has 8 decimals. NOT
// @facts        DeepBook's 1e9 FLOAT_SCALING.
// @facts      BPS_DENOM = 10_000 · HARD_MAX_BATCH_SIZE = 512 · MAX_BATCH_SIZE = 256
// @facts      LOAD    — canonical order: bids (price DESC, submitter bytes ASC, index ASC);
// @facts                asks (price ASC, submitter bytes ASC, index ASC). Move compares the
// @facts                address as `to_u256`, which is the same total order as the raw bytes.
// @facts      PRICING — candidates are the DISTINCT limit prices present, ascending.
// @facts                vol(p) = min(demand(p), supply(p)); max vol, then min |demand−supply|,
// @facts                then the LOWEST p. Computed on the SUBMITTED book — no balance is read.
// @facts      ALLOC   — walk PRICE LEVELS in canonical order. A level whose whole weight fits in
// @facts                what is left of `matched` fills FULLY; the FIRST level that does not fit
// @facts                is pro-rated floor(residual·qty_i/Σqty) with the remainder handed out one
// @facts                sat at a time by largest fractional remainder, ties by canonical
// @facts                position; every LATER level gets zero.
// @facts      TRUNCATE— cap each allocated fill at what the submitter's FROZEN escrow funds at
// @facts                p*, drawing a per-account budget down in canonical order (bids spend
// @facts                quote and round UP; asks spend base).
// @facts      REALLOC — truncation shortens one side, so BOTH sides are re-rationed by the same
// @facts                rule to M' = min(Σ bid', Σ ask'). Reduction only, so no re-rationed fill
// @facts                can breach an affordability cap.
// @facts      ROOT    — bids first then asks, in canonical order. leaf = blake2b256(0x00 ‖ bcs(Fill)),
// @facts                node = blake2b256(0x01 ‖ l ‖ r), ODD NODES DUPLICATED, empty ⇒ 32 zero bytes.
// @facts      ⚠ THE `side` / `is_bid` INVERSION. Move's leaf byte is the BOOL `is_bid`, so a BID
// @facts        writes 0x01 while `SIDE_BID` is the NUMBER 0. Writing `side` into that byte would
// @facts        invert every leaf silently. `encodeFillLeaf` derives the bool explicitly and
// @facts        test/clearing.golden.test.ts pins the byte.
// @implements export const SIDE_BID: 0 · SIDE_ASK: 1 · PRICE_SCALE · MAX_BATCH_SIZE
// @implements export const HARD_MAX_BATCH_SIZE · FILL_LEAF_LEN
// @implements export type Side = 0 | 1
// @implements export interface RevealedOrder · FrozenBalance · ClearingInput · Fill
// @implements export interface PriceDiscovery · ClearingResult
// @implements export function quoteForBid(qtyBase, price, scale?): bigint
// @implements export function quoteForAsk(qtyBase, price, scale?): bigint
// @implements export function feeForAsk(grossQuote, feeMatchedBps): bigint
// @implements export function canonicalOrder(orders): RevealedOrder[]
// @implements export function discoverPrice(orders): PriceDiscovery
// @implements export function encodeFillLeaf(fill): Uint8Array
// @implements export function hashFillLeaf(fill): Uint8Array
// @implements export function fillsRoot(fills): Uint8Array
// @implements export function clear(input: ClearingInput): ClearingResult
// @forbidden  a float ANYWHERE, including intermediately — docs/DESIGN-V2.md §5.2
// @forbidden  Date.now() / Math.random() / any I/O — the keeper `purity` gate imports this file
// @forbidden  a second copy of this algorithm in keeper/ or app/ — that is blocker B6 again,
//             and here a divergence is a RELEASE BLOCKER (docs/DESIGN-V2.md §9)
// @forbidden  putting `fee` in the Merkle leaf — Move's `Fill` has no such field, and the struct
//             is frozen by the `compatible` upgrade policy
// @forbidden  reading a balance that was not part of the FROZEN snapshot — close_batch froze it
// @invariant  1. No fill outside its limit: bid ⇒ price <= limit, ask ⇒ price >= limit. ASSERTED.
// @invariant  2. Σ base debited (asks) == Σ base credited (bids) == matchedBase. ASSERTED.
// @invariant  3. Σ quote debited (bids) == Σ quote credited (asks, NET) + feeQuote. ASSERTED.
//                This is `clearing.move`'s `total_debits == total_credits` on the quote leg,
//                with the fee an explicit credit and NO fourth term.
// @invariant  4. feeQuote == Σ fill.fee + dustQuote, and dustQuote >= 0 — guaranteed by rounding
//                both sides toward the vault. `dustQuote` is a REPORT, not a separate credit.
// @invariant  5. fills.length <= orders.length; a zero-quantity fill is never emitted.
// @invariant  6. Idempotent: clear(x) twice yields identical price, fills and root.
// @invariant  7. Truncation is monotone — raising any frozen balance never lowers matchedBase.
// @invariant  8. encodeFillLeaf is exactly 73 bytes, byte-for-byte `bcs::to_bytes(&Fill)`.
// @ac         fixtures/clearing.golden.json (L1, 47 cases) · test/clearing.property.test.ts (L2)
// @ac         clearing-rs/clearing/tests/divergence.rs — the Move/Rust/TS parity census
// @verify     npx vitest run clearing
// @verify     npm run golden:check        # re-verifies every hand-derived fixture expectation
// @verify     npm run move-fixtures       # PRINTS the Move twin of the L1 fixtures to stdout
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { compareAddress, normalizeAddress } from './address.js';
import { BcsWriter } from './bcs.js';
import { hashLeafBytes } from './hash.js';
import { assertU64, BPS_DENOM, largestRemainder, mulDivCeil, mulDivFloor } from './math.js';
import { binaryRootDuplicatingOdd } from './merkle.js';

/** Buys base, pays quote. Encoded into the leaf as the BOOL `is_bid = true` ⇒ byte 0x01. */
export const SIDE_BID = 0 as const;
/** Sells base, receives quote. Encoded into the leaf as `is_bid = false` ⇒ byte 0x00. */
export const SIDE_ASK = 1 as const;

export type Side = typeof SIDE_BID | typeof SIDE_ASK;

/**
 * `quote = qty_base * price / PRICE_SCALE`.
 *
 * ⚠ 1e8, NOT DeepBook's 1e9 FLOAT_SCALING. This constant was 1e9 here while
 * `aphotic::clearing::PRICE_SCALE` and the keeper's engine were both 1e8 — a
 * three-way implementation with two scales, which is exactly the divergence
 * aphotic.md §9 calls a release blocker. The Move package is the authority: it is
 * the deployed contract, and 1e8 is sats-natural for an 8-decimal asset.
 *
 * The golden fixtures pass their own `priceScale` explicitly, so they pin the
 * algorithm's SCALE-INDEPENDENCE rather than this number. This number is pinned
 * separately against `clearing::price_scale()`.
 */
export const PRICE_SCALE = 100_000_000n;

/** Governed default (docs/DESIGN-V2.md §2 / D4). */
export const MAX_BATCH_SIZE = 256;
/** Asserted ceiling in the setter (docs/DESIGN-V2.md §2 / D4). */
export const HARD_MAX_BATCH_SIZE = 512;

/** `bcs(Fill)` = u64 ‖ u64 ‖ address ‖ bool ‖ u64 ‖ u64 ‖ u64. */
export const FILL_LEAF_LEN = 8 + 8 + 32 + 1 + 8 + 8 + 8;

/** One decrypted order, as `reveal_order` recorded it. `index` is its submission position. */
export interface RevealedOrder {
  /** Submission index — the FINAL, canonical tie-break. u64. */
  readonly index: number;
  /** Sui address of the submitter. Normalised internally. */
  readonly submitter: string;
  readonly side: Side;
  /** u64, scaled by {@link PRICE_SCALE}. ⚠ u64, not u128 — Move holds `limit_price: u64`. */
  readonly limitPrice: bigint;
  /** u64 base units (sats for hBTC). */
  readonly qtyBase: bigint;
}

/** The per-account snapshot `close_batch` froze. Absent ⇒ that account is treated as unlimited. */
export interface FrozenBalance {
  readonly submitter: string;
  readonly base: bigint;
  readonly quote: bigint;
}

export interface ClearingInput {
  readonly orders: readonly RevealedOrder[];
  /** Frozen ledger. `undefined` disables truncation entirely (every account is solvent). */
  readonly balances?: readonly FrozenBalance[] | undefined;
  /** `fee_matched_bps`, 0..10_000. */
  readonly feeMatchedBps: bigint;
  /** Override only for tests/fixtures. Defaults to {@link PRICE_SCALE}. */
  readonly priceScale?: bigint | undefined;
  /**
   * `Clearing.batch_id` — the FIRST field of every Merkle leaf, so two identical books in two
   * different batches publish different roots. Defaults to 0.
   */
  readonly batchId?: bigint | undefined;
}

/**
 * The published fill. Six of these seven fields ARE the Merkle leaf, in this declaration order.
 *
 * ⚠ `fee` is the seventh and is **NOT COMMITTED**: `aphotic::clearing::Fill` has no fee field,
 * and the struct is frozen by the `compatible` upgrade policy. It is reported here because it is
 * how `quote` was derived on an ask, and because the golden fixtures hand-check it.
 */
export interface Fill {
  /** u64. Leaf field 1. */
  readonly batchId: bigint;
  /** u64 `order_index`. Leaf field 2. */
  readonly index: number;
  /** Leaf field 3, 32 raw bytes. */
  readonly submitter: string;
  /** Leaf field 4, written as the BOOL `is_bid` — a BID is byte 0x01 even though SIDE_BID is 0. */
  readonly side: Side;
  /** u64 `base_sats`. Leaf field 5. */
  readonly qtyBase: bigint;
  /**
   * u64 `quote_sats`. Leaf field 6.
   * BID: the quote DEBITED, rounded up. ASK: the quote CREDITED, i.e. gross **net of the fee**.
   */
  readonly quote: bigint;
  /** u64. Leaf field 7. The uniform clearing price — identical on every fill, by construction. */
  readonly price: bigint;
  /** NOT IN THE LEAF. 0 on a bid; on an ask, `floor(gross * feeMatchedBps / 10_000)`. */
  readonly fee: bigint;
}

export interface PriceDiscovery {
  readonly cleared: boolean;
  /** 0 when `cleared` is false. */
  readonly price: bigint;
  /** `min(demand(p*), supply(p*))` — BEFORE truncation. 0 when not cleared. */
  readonly matchedBase: bigint;
  readonly demand: bigint;
  readonly supply: bigint;
  /** Every distinct limit price present, ascending — the candidate set. */
  readonly candidates: readonly bigint[];
}

export interface ClearingResult {
  /** True when a crossing price exists. Truncation may still leave `matchedBase` at 0. */
  readonly cleared: boolean;
  readonly price: bigint;
  /** Base actually settled, AFTER truncation. */
  readonly matchedBase: bigint;
  /** `clearing::quote_paid_sats()` — Σ bid quote debited. */
  readonly quotePaid: bigint;
  /** `clearing::quote_recv_sats()` — Σ ask quote credited, NET of each ask's fee. */
  readonly quoteRecv: bigint;
  /** Σ ask-side GROSS quote = `quoteRecv + Σ fill.fee`. Not a Move field; reported for audit. */
  readonly matchedQuote: bigint;
  /**
   * `clearing::fee_quote_sats()` = `quotePaid − quoteRecv`. The single quote credit the fee
   * recipient receives, and therefore `Σ fill.fee + dustQuote` — Move folds the dust in.
   */
  readonly feeQuote: bigint;
  /**
   * `quotePaid − matchedQuote`: the part of `feeQuote` that is rounding residue rather than
   * matched fee. Never negative, and never credited separately — a REPORT, not a term.
   */
  readonly dustQuote: bigint;
  /** Bids in canonical order, then asks in canonical order. Zero-quantity fills are omitted. */
  readonly fills: readonly Fill[];
  readonly fillsRoot: Uint8Array;
  /** Pre-truncation matched volume — how much solvency cost the batch. */
  readonly matchedBaseBeforeTruncation: bigint;
}

// ── §5.5 quote conversion, rounding TOWARD THE VAULT ────────────────────────

/** A buyer pays: round UP. `ceil_mul_div(base, p, PRICE_SCALE)`. */
export function quoteForBid(qtyBase: bigint, price: bigint, scale: bigint = PRICE_SCALE): bigint {
  return mulDivCeil(qtyBase, price, scale);
}

/** A seller's GROSS proceeds: round DOWN. `floor_mul_div(base, p, PRICE_SCALE)`. */
export function quoteForAsk(qtyBase: bigint, price: bigint, scale: bigint = PRICE_SCALE): bigint {
  return mulDivFloor(qtyBase, price, scale);
}

/**
 * The matched fee charged to ONE ask: `floor(gross * fee_bps / 10_000)`, exactly as
 * `rooting_step` computes it. Per fill — never an aggregate apportioned afterwards.
 */
export function feeForAsk(grossQuote: bigint, feeMatchedBps: bigint): bigint {
  return mulDivFloor(grossQuote, feeMatchedBps, BPS_DENOM);
}

// ── §5.1 canonical order ────────────────────────────────────────────────────

function compareBids(a: RevealedOrder, b: RevealedOrder): number {
  if (a.limitPrice !== b.limitPrice) return a.limitPrice > b.limitPrice ? -1 : 1; // price DESC
  const s = compareAddress(a.submitter, b.submitter);
  if (s !== 0) return s; // submitter bytes ASC
  return a.index - b.index; // index ASC
}

function compareAsks(a: RevealedOrder, b: RevealedOrder): number {
  if (a.limitPrice !== b.limitPrice) return a.limitPrice < b.limitPrice ? -1 : 1; // price ASC
  const s = compareAddress(a.submitter, b.submitter);
  if (s !== 0) return s;
  return a.index - b.index;
}

/** Bids in canonical order, then asks in canonical order. */
export function canonicalOrder(orders: readonly RevealedOrder[]): RevealedOrder[] {
  const bids = orders.filter((o) => o.side === SIDE_BID).sort(compareBids);
  const asks = orders.filter((o) => o.side === SIDE_ASK).sort(compareAsks);
  return [...bids, ...asks];
}

function validate(orders: readonly RevealedOrder[]): RevealedOrder[] {
  if (orders.length > HARD_MAX_BATCH_SIZE) {
    throw new RangeError(
      `EBatchTooLarge: ${orders.length} orders exceeds HARD_MAX_BATCH_SIZE ${HARD_MAX_BATCH_SIZE}`,
    );
  }
  const seen = new Set<number>();
  return orders.map((o) => {
    if (o.side !== SIDE_BID && o.side !== SIDE_ASK) {
      throw new RangeError(`EBadSide: order ${o.index} has side ${String(o.side)}`);
    }
    if (!Number.isInteger(o.index) || o.index < 0) {
      throw new RangeError(`EBadIndex: ${String(o.index)}`);
    }
    if (seen.has(o.index)) throw new RangeError(`EDuplicateOrderIndex: ${o.index}`);
    seen.add(o.index);
    assertU64(BigInt(o.index), `order[${o.index}].index`);
    // D5: Move holds `limit_price: u64`. A u128 price is not expressible on chain, so it is
    // rejected HERE rather than accepted into a book the settlement layer cannot hold.
    assertU64(o.limitPrice, `order[${o.index}].limitPrice`);
    assertU64(o.qtyBase, `order[${o.index}].qtyBase`);
    if (o.qtyBase <= 0n) throw new RangeError(`EZeroQuantity: order ${o.index}`);
    if (o.limitPrice <= 0n) throw new RangeError(`EZeroPrice: order ${o.index}`);
    return { ...o, submitter: normalizeAddress(o.submitter) };
  });
}

// ── §5.2 price discovery ────────────────────────────────────────────────────

/**
 * Candidates are the distinct limit prices present. `vol(p) = min(demand(p), supply(p))`;
 * choose max `vol`, tie-break min `|demand − supply|`, tie-break the LOWEST `p`.
 *
 * Runs on the SUBMITTED book — no frozen balance is consulted, which is the whole of D4:
 * one under-funded account must not be able to move the price everybody else trades at.
 *
 * O(n log n): cumulative demand/supply are computed by one descending and one ascending
 * sweep over the distinct prices, never by an O(n²) rescan.
 */
export function discoverPrice(orders: readonly RevealedOrder[]): PriceDiscovery {
  const bidQty = new Map<bigint, bigint>();
  const askQty = new Map<bigint, bigint>();
  const priceSet = new Set<bigint>();
  for (const o of orders) {
    priceSet.add(o.limitPrice);
    const m = o.side === SIDE_BID ? bidQty : askQty;
    m.set(o.limitPrice, (m.get(o.limitPrice) ?? 0n) + o.qtyBase);
  }
  const candidates = [...priceSet].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  if (candidates.length === 0) {
    return { cleared: false, price: 0n, matchedBase: 0n, demand: 0n, supply: 0n, candidates };
  }

  // demand(p) = Σ bid qty with limit >= p  → suffix sums over ascending candidates
  const demandAt = new Array<bigint>(candidates.length).fill(0n);
  let acc = 0n;
  for (let i = candidates.length - 1; i >= 0; i--) {
    acc += bidQty.get(candidates[i]!) ?? 0n;
    demandAt[i] = acc;
  }
  // supply(p) = Σ ask qty with limit <= p  → prefix sums
  const supplyAt = new Array<bigint>(candidates.length).fill(0n);
  acc = 0n;
  for (let i = 0; i < candidates.length; i++) {
    acc += askQty.get(candidates[i]!) ?? 0n;
    supplyAt[i] = acc;
  }

  let best = -1;
  let bestVol = 0n;
  let bestImb = 0n;
  for (let i = 0; i < candidates.length; i++) {
    const d = demandAt[i]!;
    const s = supplyAt[i]!;
    const vol = d < s ? d : s;
    if (vol === 0n) continue;
    const imb = d > s ? d - s : s - d;
    // Ascending sweep + STRICT improvement ⇒ the lowest price wins every remaining tie.
    if (best === -1 || vol > bestVol || (vol === bestVol && imb < bestImb)) {
      best = i;
      bestVol = vol;
      bestImb = imb;
    }
  }
  if (best === -1) {
    return { cleared: false, price: 0n, matchedBase: 0n, demand: 0n, supply: 0n, candidates };
  }
  return {
    cleared: true,
    price: candidates[best]!,
    matchedBase: bestVol,
    demand: demandAt[best]!,
    supply: supplyAt[best]!,
    candidates,
  };
}

// ── allocation: price priority, then largest-remainder at the margin ────────

interface Slot {
  readonly order: RevealedOrder;
  qty: bigint;
}

/**
 * Allocate `target` across `slots` (already in canonical order, so equal-price runs are
 * contiguous). Levels that fit fill fully; the first level that does not fit is pro-rated by
 * largest remainder; every later level gets zero.
 *
 * The straight-line form of `clearing.move`'s `marginal_level` + `alloc_full_step` +
 * `alloc_prorata_step` + `alloc_remainder_step`. Move's `frac = residual·qty − floor·Σqty`
 * ranking is `largestRemainder`'s `p % sum` scaled by nothing — the same total order.
 */
function allocateSide(slots: readonly Slot[], target: bigint): bigint[] {
  const out = new Array<bigint>(slots.length).fill(0n);
  let remaining = target;
  let i = 0;
  while (i < slots.length && remaining > 0n) {
    const price = slots[i]!.order.limitPrice;
    let j = i;
    let levelTotal = 0n;
    while (j < slots.length && slots[j]!.order.limitPrice === price) {
      levelTotal += slots[j]!.qty;
      j++;
    }
    if (levelTotal <= remaining) {
      for (let k = i; k < j; k++) out[k] = slots[k]!.qty;
      remaining -= levelTotal;
    } else {
      const weights = slots.slice(i, j).map((s) => s.qty);
      const share = largestRemainder(remaining, weights);
      for (let k = i; k < j; k++) out[k] = share[k - i]!;
      remaining = 0n;
    }
    i = j;
  }
  return out;
}

// ── clear() ─────────────────────────────────────────────────────────────────

/** THE uniform-price clearing algorithm. Pure, integer-only, deterministic. */
export function clear(input: ClearingInput): ClearingResult {
  const scale = input.priceScale ?? PRICE_SCALE;
  if (scale <= 0n) throw new RangeError('EBadPriceScale');
  const feeBps = input.feeMatchedBps;
  if (feeBps < 0n || feeBps > BPS_DENOM) throw new RangeError(`EBadFeeBps: ${feeBps}`);
  const batchId = assertU64(input.batchId ?? 0n, 'batchId');

  const orders = validate(input.orders);
  const discovery = discoverPrice(orders);
  const empty: ClearingResult = {
    cleared: false,
    price: 0n,
    matchedBase: 0n,
    quotePaid: 0n,
    quoteRecv: 0n,
    matchedQuote: 0n,
    feeQuote: 0n,
    dustQuote: 0n,
    fills: [],
    fillsRoot: binaryRootDuplicatingOdd([]),
    matchedBaseBeforeTruncation: 0n,
  };
  if (!discovery.cleared) return empty;

  const p = discovery.price;
  assertU64(discovery.matchedBase, 'matchedBase');

  // Eligible = able to trade at p*. Sorted canonically ⇒ price priority is positional.
  const bidSlots: Slot[] = orders
    .filter((o) => o.side === SIDE_BID && o.limitPrice >= p)
    .sort(compareBids)
    .map((order) => ({ order, qty: order.qtyBase }));
  const askSlots: Slot[] = orders
    .filter((o) => o.side === SIDE_ASK && o.limitPrice <= p)
    .sort(compareAsks)
    .map((order) => ({ order, qty: order.qtyBase }));

  // STAGE_ALLOC_* — allocate against the volume discovered from the SUBMITTED book.
  const rawBid = allocateSide(bidSlots, discovery.matchedBase);
  const rawAsk = allocateSide(askSlots, discovery.matchedBase);
  for (let i = 0; i < bidSlots.length; i++) bidSlots[i]!.qty = rawBid[i]!;
  for (let i = 0; i < askSlots.length; i++) askSlots[i]!.qty = rawAsk[i]!;

  // STAGE_TRUNCATE — draw the FROZEN snapshot down against the allocation, in canonical order.
  if (input.balances !== undefined) {
    const baseBudget = new Map<string, bigint>();
    const quoteBudget = new Map<string, bigint>();
    for (const b of input.balances) {
      const who = normalizeAddress(b.submitter);
      if (b.base < 0n || b.quote < 0n) throw new RangeError(`ENegativeBalance: ${who}`);
      baseBudget.set(who, assertU64(b.base, `balance[${who}].base`));
      quoteBudget.set(who, assertU64(b.quote, `balance[${who}].quote`));
    }
    for (const s of bidSlots) {
      if (s.qty === 0n) continue;
      const who = s.order.submitter;
      const budget = quoteBudget.get(who) ?? 0n;
      // Largest qty affordable at p* with `budget` quote, given the buyer rounds UP.
      const affordable = mulDivFloor(budget, scale, p);
      if (affordable < s.qty) s.qty = affordable;
      quoteBudget.set(who, budget - quoteForBid(s.qty, p, scale));
    }
    for (const s of askSlots) {
      if (s.qty === 0n) continue;
      const who = s.order.submitter;
      const budget = baseBudget.get(who) ?? 0n;
      if (budget < s.qty) s.qty = budget;
      baseBudget.set(who, budget - s.qty);
    }
  }

  // STAGE_REALLOC_* — "the counterparty recomputed symmetrically". Move runs this pass
  // unconditionally, and so does this file: when nothing truncated, Σqty == M' on both sides,
  // every level fits, and the pass is the identity.
  let bidTotal = 0n;
  for (const s of bidSlots) bidTotal += s.qty;
  let askTotal = 0n;
  for (const s of askSlots) askTotal += s.qty;
  const mPrime = bidTotal < askTotal ? bidTotal : askTotal;
  const reBid = allocateSide(bidSlots, mPrime);
  for (let i = 0; i < bidSlots.length; i++) bidSlots[i]!.qty = reBid[i]!;
  const reAsk = allocateSide(askSlots, mPrime);
  for (let i = 0; i < askSlots.length; i++) askSlots[i]!.qty = reAsk[i]!;

  let matchedBase = 0n;
  for (const s of askSlots) matchedBase += s.qty;
  let bidBase = 0n;
  for (const s of bidSlots) bidBase += s.qty;
  if (matchedBase !== bidBase) {
    throw new Error(`EValueNotPreserved: base ${bidBase} (bids) != ${matchedBase} (asks)`);
  }

  if (matchedBase === 0n) {
    return { ...empty, cleared: true, price: p, matchedBaseBeforeTruncation: discovery.matchedBase };
  }

  // STAGE_ROOTING — bids first, then asks, in canonical order.
  const fills: Fill[] = [];
  let quotePaid = 0n;
  for (const s of bidSlots) {
    if (s.qty === 0n) continue;
    // @invariant 1 — asserted per fill, not merely by construction.
    if (p > s.order.limitPrice) {
      throw new Error(`EFillOutsideLimit: bid ${s.order.index} limit ${s.order.limitPrice} < p* ${p}`);
    }
    const quote = assertU64(quoteForBid(s.qty, p, scale), 'fillQuote');
    quotePaid += quote;
    fills.push({
      batchId,
      index: s.order.index,
      submitter: s.order.submitter,
      side: SIDE_BID,
      qtyBase: s.qty,
      quote,
      price: p,
      fee: 0n,
    });
  }
  assertU64(quotePaid, 'quotePaid');

  let quoteRecv = 0n;
  let matchedQuote = 0n;
  for (const s of askSlots) {
    if (s.qty === 0n) continue;
    if (p < s.order.limitPrice) {
      throw new Error(`EFillOutsideLimit: ask ${s.order.index} limit ${s.order.limitPrice} > p* ${p}`);
    }
    // D3: the fee is charged PER ASK on its own gross, and the leaf publishes the NET.
    const gross = assertU64(quoteForAsk(s.qty, p, scale), 'fillQuote');
    const fee = feeForAsk(gross, feeBps);
    const net = gross - fee;
    quoteRecv += net;
    matchedQuote += gross;
    fills.push({
      batchId,
      index: s.order.index,
      submitter: s.order.submitter,
      side: SIDE_ASK,
      qtyBase: s.qty,
      quote: net,
      price: p,
      fee,
    });
  }
  assertU64(quoteRecv, 'quoteRecv');
  assertU64(matchedQuote, 'matchedQuote');

  // Rounding toward the vault on both legs guarantees this is never negative — Move asserts
  // `quote_paid >= quote_recv` (EValueNotPreserved) at exactly this point.
  if (quotePaid < quoteRecv) {
    throw new Error(`EValueNotPreserved: quotePaid ${quotePaid} < quoteRecv ${quoteRecv}`);
  }
  const feeQuote = quotePaid - quoteRecv;
  const dustQuote = quotePaid - matchedQuote;
  if (dustQuote < 0n) throw new Error(`EValueNotPreserved: negative dust ${dustQuote}`);

  // @invariant 3, asserted rather than assumed: Σ quote debits == Σ quote credits, where the
  // fee recipient's credit is `feeQuote` and there is NO fourth term.
  let credits = 0n;
  let feeSum = 0n;
  for (const f of fills) {
    if (f.side !== SIDE_ASK) continue;
    credits += f.quote;
    feeSum += f.fee;
  }
  if (quotePaid !== credits + feeQuote) {
    throw new Error(`EValueNotPreserved: quote ${quotePaid} != ${credits} + ${feeQuote}`);
  }
  // @invariant 4 — the dust is a COMPONENT of the fee credit, not a peer of it.
  if (feeQuote !== feeSum + dustQuote) {
    throw new Error(`EValueNotPreserved: fee ${feeQuote} != ${feeSum} + dust ${dustQuote}`);
  }

  return {
    cleared: true,
    price: p,
    matchedBase,
    quotePaid,
    quoteRecv,
    matchedQuote,
    feeQuote,
    dustQuote,
    fills,
    fillsRoot: fillsRoot(fills),
    matchedBaseBeforeTruncation: discovery.matchedBase,
  };
}

// ── §5.6 the leaf, and the root ─────────────────────────────────────────────

/**
 * `bcs::to_bytes(&aphotic::clearing::Fill)` — 73 bytes, in Move's DECLARATION order:
 *
 *     u64 batch_id ‖ u64 order_index ‖ address submitter ‖ bool is_bid
 *   ‖ u64 base_sats ‖ u64 quote_sats ‖ u64 price
 *
 * ⚠ Two traps live in these seven fields:
 *   · `is_bid` is a BOOL. A bid writes 0x01 while `SIDE_BID` is the number 0, so writing `side`
 *     straight into that byte inverts every leaf with nothing red anywhere.
 *   · the integers are LITTLE-endian while the address is 32 BIG-endian bytes — the same
 *     failure class as RECON R14.2 (the reversed Bitcoin txid) and DESIGN-V2 F1.
 */
export function encodeFillLeaf(fill: Fill): Uint8Array {
  const isBid = fill.side === SIDE_BID;
  return new BcsWriter()
    .u64(fill.batchId)
    .u64(BigInt(fill.index))
    .address(fill.submitter)
    .bool(isBid)
    .u64(fill.qtyBase)
    .u64(fill.quote)
    .u64(fill.price)
    .toBytes();
}

/** `blake2b256(0x00 ‖ bcs(Fill))`. */
export function hashFillLeaf(fill: Fill): Uint8Array {
  return hashLeafBytes(encodeFillLeaf(fill));
}

/** The published `fills_root`. Empty fill set ⇒ 32 zero bytes. */
export function fillsRoot(fills: readonly Fill[]): Uint8Array {
  return binaryRootDuplicatingOdd(fills.map(hashFillLeaf));
}
