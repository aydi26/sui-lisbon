// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#5 (canonical order · price discovery · allocation · limit safety ·
//             quote conversion · root · the explicit fee term · under-funded truncation)
// @spec       docs/DESIGN-V2.md#9 (this file is THE implementation; Move and app must agree byte
//             for byte — L1 golden fixtures, L2 property, L3 devInspect)
// @spec       docs/DESIGN-V2.md#2 (MAX_BATCH_SIZE governed 256, HARD_MAX_BATCH_SIZE 512)
// @spec       aphotic.md §2.5 (deterministic and reproducible) · §2.6 (atomic, value-preserving)
// @spec       aphotic.md §10 Settlement invariants
// @rules      G5 G10
// @depends    ./math.ts · ./bcs.ts · ./merkle.ts · ./hash.ts · ./address.ts
// @facts      SIDE_BID = 0 (buys base, pays quote) · SIDE_ASK = 1 (sells base, receives quote)
// @facts      PRICE_SCALE = 1_000_000_000  (1e9, DeepBook's FLOAT_SCALING convention).
// @facts        quote = qty_base * limit_price / PRICE_SCALE.
// @facts      BPS_DENOM = 10_000 · HARD_MAX_BATCH_SIZE = 512 · MAX_BATCH_SIZE = 256
// @facts      Canonical order — bids (price DESC, submitter bytes ASC, index ASC);
// @facts                        asks (price ASC,  submitter bytes ASC, index ASC).
// @facts      Price discovery — candidates are the DISTINCT limit prices present on either side;
// @facts        vol(p) = min(demand(p), supply(p)); pick max vol, then min |demand-supply|,
// @facts        then the LOWEST p.
// @facts      Rounding — bids round the quote UP, asks round it DOWN. Both round TOWARD THE
// @facts        VAULT, so `dustQuote = Σ bidQuote - Σ askQuoteGross` is never negative.
// @facts      Fee — feeQuote = mul_div(matchedQuote, feeMatchedBps, 10_000), an EXPLICIT third
// @facts        term, apportioned across the ask fills by the SAME largest-remainder rule so
// @facts        Σ fill.fee == feeQuote exactly. A seller is credited `quote - fee`.
// @facts      Root — blake2b256 Merkle over blake2b256(0x00 ‖ bcs(FillLeaf)) in canonical order,
// @facts        ODD NODES DUPLICATED (merkle.binaryRootDuplicatingOdd). Empty ⇒ 32 zero bytes.
// @facts      FillLeaf bcs = u64 order_index ‖ address submitter ‖ u8 side ‖ u128 price
// @facts                     ‖ u64 qty_base ‖ u64 quote ‖ u64 fee
// @facts      ★ GENERALISATION, stated: §5.3 says "orders strictly inside the cross fill fully".
// @facts        That is not always satisfiable — with bid 100@10 / ask 50@5 the tie-breaks pick
// @facts        p*=5, and the strictly-inside bids (100) exceed the matched volume (50). The
// @facts        implemented rule is the strict generalisation that reduces to §5.3 whenever §5.3
// @facts        is satisfiable: walk price levels in PRICE PRIORITY; levels that fit, fill fully;
// @facts        the first level that does not fit is pro-rated by largest remainder; every later
// @facts        level gets zero. Case `degenerate-strictly-inside-exceeds-matched` pins it.
// @facts      ★ TRUNCATION (docs/DESIGN-V2.md §5, "Solvency at settlement without leaking size"):
// @facts        1. cap each order at what its account can afford from the FROZEN snapshot,
// @facts           consuming the account budget in canonical order;
// @facts        2. recompute M' = min(Σ bid qty', Σ ask qty');
// @facts        3. re-ration the longer side down to M' with the SAME price-priority +
// @facts           largest-remainder rule — "the counterparty recomputed symmetrically".
// @facts        Reduction only, so step 3 can never break an affordability cap.
// @implements export const SIDE_BID: 0
// @implements export const SIDE_ASK: 1
// @implements export const PRICE_SCALE: bigint
// @implements export const MAX_BATCH_SIZE: number
// @implements export const HARD_MAX_BATCH_SIZE: number
// @implements export type Side = 0 | 1
// @implements export interface RevealedOrder
// @implements export interface FrozenBalance
// @implements export interface ClearingInput
// @implements export interface Fill
// @implements export interface ClearingResult
// @implements export function quoteForBid(qtyBase: bigint, price: bigint, scale?: bigint): bigint
// @implements export function quoteForAsk(qtyBase: bigint, price: bigint, scale?: bigint): bigint
// @implements export function canonicalOrder(orders: readonly RevealedOrder[]): RevealedOrder[]
// @implements export function discoverPrice(orders: readonly RevealedOrder[]): PriceDiscovery
// @implements export function encodeFillLeaf(fill: Fill): Uint8Array
// @implements export function hashFillLeaf(fill: Fill): Uint8Array
// @implements export function fillsRoot(fills: readonly Fill[]): Uint8Array
// @implements export function clear(input: ClearingInput): ClearingResult
// @forbidden  a float ANYWHERE, including intermediately — docs/DESIGN-V2.md §5.2
// @forbidden  Date.now() / Math.random() / any I/O — the keeper `purity` gate imports this file
// @forbidden  a second copy of this algorithm in keeper/ or app/ — that is blocker B6 again,
//             and here a divergence is a RELEASE BLOCKER (docs/DESIGN-V2.md §9)
// @forbidden  reading a balance that was not part of the FROZEN snapshot — close_batch froze it
// @invariant  1. No fill outside its limit: bid ⇒ price <= limit, ask ⇒ price >= limit. ASSERTED.
// @invariant  2. Σ base debited (asks) == Σ base credited (bids) == matchedBase. ASSERTED.
// @invariant  3. Σ quote debited (bids) == Σ quote credited (asks, net) + feeQuote + dustQuote.
//                ASSERTED. The fee is an explicit third term, never a silent shortfall.
// @invariant  4. dustQuote >= 0 — guaranteed by rounding both sides toward the vault.
// @invariant  5. fills.length <= orders.length; a zero-quantity fill is never emitted.
// @invariant  6. Idempotent: clear(x) twice yields identical price, fills and root.
// @invariant  7. Truncation is monotone — raising any frozen balance never lowers matchedBase.
// @invariant  8. Σ fill.fee == feeQuote, and every ask fill has fee <= quote.
// @ac         fixtures/clearing.golden.json (L1, 44 cases) · test/clearing.property.test.ts (L2)
// @verify     npx vitest run clearing
// @verify     npm run golden:check        # re-verifies every hand-derived fixture expectation
// @verify     npm run move-fixtures       # PRINTS the Move twin of the L1 fixtures to stdout
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { compareAddress, normalizeAddress } from './address.js';
import { BcsWriter } from './bcs.js';
import { hashLeafBytes } from './hash.js';
import {
  assertU64,
  assertU128,
  BPS_DENOM,
  largestRemainder,
  mulDivCeil,
  mulDivFloor,
} from './math.js';
import { binaryRootDuplicatingOdd } from './merkle.js';

/** Buys base, pays quote. */
export const SIDE_BID = 0 as const;
/** Sells base, receives quote. */
export const SIDE_ASK = 1 as const;

export type Side = typeof SIDE_BID | typeof SIDE_ASK;

/** `quote = qty_base * price / PRICE_SCALE`. DeepBook's FLOAT_SCALING convention. */
export const PRICE_SCALE = 1_000_000_000n;

/** Governed default (docs/DESIGN-V2.md §2 / D4). */
export const MAX_BATCH_SIZE = 256;
/** Asserted ceiling in the setter (docs/DESIGN-V2.md §2 / D4). */
export const HARD_MAX_BATCH_SIZE = 512;

/** One decrypted order, as `reveal_order` recorded it. `index` is its submission position. */
export interface RevealedOrder {
  /** Submission index — the FINAL, canonical tie-break. u64. */
  readonly index: number;
  /** Sui address of the submitter. Normalised internally. */
  readonly submitter: string;
  readonly side: Side;
  /** u128, scaled by {@link PRICE_SCALE}. */
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
}

export interface Fill {
  readonly index: number;
  readonly submitter: string;
  readonly side: Side;
  /** The uniform clearing price. Identical on every fill, by construction. */
  readonly price: bigint;
  readonly qtyBase: bigint;
  /** BID: quote DEBITED (rounded up). ASK: quote GROSS (rounded down); credit is `quote - fee`. */
  readonly quote: bigint;
  /** Always 0 on a bid. On an ask, this account's share of `feeQuote`. */
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
  /** Σ ask-side gross quote. The fee base. */
  readonly matchedQuote: bigint;
  readonly feeQuote: bigint;
  /** Σ bid quote − matchedQuote. Retained by the vault; never negative. */
  readonly dustQuote: bigint;
  /** Bids in canonical order, then asks in canonical order. Zero-quantity fills are omitted. */
  readonly fills: readonly Fill[];
  readonly fillsRoot: Uint8Array;
  /** Pre-truncation matched volume — how much solvency cost the batch. */
  readonly matchedBaseBeforeTruncation: bigint;
}

// ── §5.5 quote conversion, rounding TOWARD THE VAULT ────────────────────────

/** A buyer pays: round UP. */
export function quoteForBid(qtyBase: bigint, price: bigint, scale: bigint = PRICE_SCALE): bigint {
  return mulDivCeil(qtyBase, price, scale);
}

/** A seller receives: round DOWN. */
export function quoteForAsk(qtyBase: bigint, price: bigint, scale: bigint = PRICE_SCALE): bigint {
  return mulDivFloor(qtyBase, price, scale);
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
    assertU128(o.limitPrice, `order[${o.index}].limitPrice`);
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

// ── §5.3 allocation: price priority, then largest-remainder at the margin ───

interface Slot {
  readonly order: RevealedOrder;
  qty: bigint;
}

/**
 * Allocate `target` across `slots` (already in canonical order, so equal-price runs are
 * contiguous). Levels that fit fill fully; the first level that does not fit is pro-rated by
 * largest remainder; every later level gets zero.
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

  const orders = validate(input.orders);
  const discovery = discoverPrice(orders);
  const empty: ClearingResult = {
    cleared: false,
    price: 0n,
    matchedBase: 0n,
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

  // 1. Raw allocation against the discovered volume.
  const rawBid = allocateSide(bidSlots, discovery.matchedBase);
  const rawAsk = allocateSide(askSlots, discovery.matchedBase);
  for (let i = 0; i < bidSlots.length; i++) bidSlots[i]!.qty = rawBid[i]!;
  for (let i = 0; i < askSlots.length; i++) askSlots[i]!.qty = rawAsk[i]!;

  // 2. Truncate against the FROZEN snapshot, in canonical order, per account.
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

    // 3. Re-ration the longer side down to M' — "the counterparty recomputed symmetrically".
    let bidTotal = 0n;
    for (const s of bidSlots) bidTotal += s.qty;
    let askTotal = 0n;
    for (const s of askSlots) askTotal += s.qty;
    const m = bidTotal < askTotal ? bidTotal : askTotal;
    if (bidTotal > m) {
      const re = allocateSide(bidSlots, m);
      for (let i = 0; i < bidSlots.length; i++) bidSlots[i]!.qty = re[i]!;
    }
    if (askTotal > m) {
      const re = allocateSide(askSlots, m);
      for (let i = 0; i < askSlots.length; i++) askSlots[i]!.qty = re[i]!;
    }
  }

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

  // 4/5. Quotes, then the explicit fee term apportioned by the SAME largest-remainder rule.
  const askQuotes = askSlots.map((s) => (s.qty === 0n ? 0n : quoteForAsk(s.qty, p, scale)));
  let matchedQuote = 0n;
  for (const q of askQuotes) matchedQuote += q;
  assertU64(matchedQuote, 'matchedQuote');
  const feeQuote = mulDivFloor(matchedQuote, feeBps, BPS_DENOM);
  const feeShares =
    feeQuote === 0n ? askQuotes.map(() => 0n) : largestRemainder(feeQuote, askQuotes);

  const fills: Fill[] = [];
  let bidQuoteTotal = 0n;
  for (const s of bidSlots) {
    if (s.qty === 0n) continue;
    if (p > s.order.limitPrice) {
      throw new Error(`EFillOutsideLimit: bid ${s.order.index} limit ${s.order.limitPrice} < p* ${p}`);
    }
    const quote = assertU64(quoteForBid(s.qty, p, scale), `fill[${s.order.index}].quote`);
    bidQuoteTotal += quote;
    fills.push({
      index: s.order.index,
      submitter: s.order.submitter,
      side: SIDE_BID,
      price: p,
      qtyBase: s.qty,
      quote,
      fee: 0n,
    });
  }
  let feeTotal = 0n;
  for (let i = 0; i < askSlots.length; i++) {
    const s = askSlots[i]!;
    if (s.qty === 0n) continue;
    if (p < s.order.limitPrice) {
      throw new Error(`EFillOutsideLimit: ask ${s.order.index} limit ${s.order.limitPrice} > p* ${p}`);
    }
    const quote = assertU64(askQuotes[i]!, `fill[${s.order.index}].quote`);
    const fee = feeShares[i]!;
    if (fee > quote) throw new Error(`EFeeExceedsProceeds: ask ${s.order.index}`);
    feeTotal += fee;
    fills.push({
      index: s.order.index,
      submitter: s.order.submitter,
      side: SIDE_ASK,
      price: p,
      qtyBase: s.qty,
      quote,
      fee,
    });
  }
  assertU64(bidQuoteTotal, 'bidQuoteTotal');
  if (feeTotal !== feeQuote) {
    throw new Error(`EValueNotPreserved: apportioned fee ${feeTotal} != ${feeQuote}`);
  }
  const dustQuote = bidQuoteTotal - matchedQuote;
  if (dustQuote < 0n) throw new Error(`EValueNotPreserved: negative dust ${dustQuote}`);
  // The §5 identity, asserted rather than assumed: debits == credits + fee + dust.
  let credits = 0n;
  for (const f of fills) if (f.side === SIDE_ASK) credits += f.quote - f.fee;
  if (bidQuoteTotal !== credits + feeQuote + dustQuote) {
    throw new Error(
      `EValueNotPreserved: quote ${bidQuoteTotal} != ${credits} + ${feeQuote} + ${dustQuote}`,
    );
  }

  return {
    cleared: true,
    price: p,
    matchedBase,
    matchedQuote,
    feeQuote,
    dustQuote,
    fills,
    fillsRoot: fillsRoot(fills),
    matchedBaseBeforeTruncation: discovery.matchedBase,
  };
}

// ── §5.6 the root ───────────────────────────────────────────────────────────

/** `bcs(FillLeaf)` — the exact byte layout `clearing.move` must produce. */
export function encodeFillLeaf(fill: Fill): Uint8Array {
  return new BcsWriter()
    .u64(BigInt(fill.index))
    .address(fill.submitter)
    .u8(fill.side)
    .u128(fill.price)
    .u64(fill.qtyBase)
    .u64(fill.quote)
    .u64(fill.fee)
    .toBytes();
}

/** `blake2b256(0x00 ‖ bcs(FillLeaf))`. */
export function hashFillLeaf(fill: Fill): Uint8Array {
  return hashLeafBytes(encodeFillLeaf(fill));
}

/** The published `fills_root`. Empty fill set ⇒ 32 zero bytes. */
export function fillsRoot(fills: readonly Fill[]): Uint8Array {
  return binaryRootDuplicatingOdd(fills.map(hashFillLeaf));
}
