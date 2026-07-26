// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P3.clearing
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move — THE twin. Stage for stage, rounding for rounding.
// @spec       aphotic.md §9 ("The clearing implementation must produce bit-identical output to the
//             Move one. Property-test them against each other; a divergence is a release blocker.")
// @spec       aphotic.md §2.5 (deterministic and reproducible) · §2.6 (atomic, value-preserving)
// @spec       aphotic.md §10 Settlement invariants
// @rules      G5 G10
// @depends    ./bytes.ts (P3.clearing) · ../util/errors.ts
// @facts      ★★ THIS FILE MIRRORS `move/sources/clearing.move`, NOT `docs/DESIGN-V2.md §5`.
// @facts        Where the two disagree the CHAIN is the truth, because the chain is what settles.
// @facts        The disagreements, stated so nobody has to rediscover them (see
// @facts        test/clearing.parity.test.ts, which pins each one):
// @facts          D-1  PRICE_SCALE is 100_000_000 in clearing.move (quote-sats per WHOLE hBTC,
// @facts               which has 8 decimals); sdk/src/clearing.ts uses 1_000_000_000.
// @facts          D-2  A Move `Fill` carries `batch_id` and NO `fee` field; the fee is the
// @facts               RESIDUAL `quote_paid - quote_recv`, and an ask's `quote_sats` is already NET.
// @facts          D-3  Move truncates against the funding snapshot at LOAD time, in SUBMISSION
// @facts               order, BEFORE price discovery. The SDK truncates AFTER allocation, in
// @facts               canonical order, then re-rations. Different results whenever an account is
// @facts               short. Move's shape is the one that settles.
// @facts          D-4  Move prices are u64; the SDK's are u128.
// @facts      ALGORITHM, verbatim from clearing.move:
// @facts        stage 0 LOADING   — per-submitter funding row {base_left, quote_left} drawn down in
// @facts                            SUBMISSION order. A bid can afford floor(quote_left·SCALE/price)
// @facts                            base at its OWN limit (the worst case); charging is
// @facts                            ceil_mul_div(e, price, SCALE). An ask is capped at base_left.
// @facts                            Zero-effective orders are DROPPED, not carried as zero.
// @facts                            Insert canonically: bids (price DESC, addr-as-u256 ASC, index
// @facts                            ASC); asks (price ASC, addr ASC, index ASC).
// @facts        stage 1 PRICING   — candidates = distinct limit prices ASCENDING;
// @facts                            vol(p)=min(demand,supply); STRICT improvement on (vol, then
// @facts                            smaller |demand-supply|) while ascending ⇒ LOWEST price wins ties.
// @facts        stage 2 ALLOC_FULL— orders STRICTLY inside the cross fill min(qty, remaining), in
// @facts                            canonical order. Orders exactly AT p* pool into pro_qty.
// @facts        stage 3 PRORATA   — base = floor(residual·qty/pool);
// @facts                            frac = residual·qty − base·pool   (u128, exact)
// @facts        stage 4 REMAINDER — one sat at a time to the largest unbumped `frac`, ties broken
// @facts                            by canonical position. ⚠ EACH ENTRY IS BUMPED AT MOST ONCE
// @facts                            (`bumped` is never cleared), so an entry can gain at most 1 sat.
// @facts        stage 5 ROOTING   — bid quote = ceil(base·p/SCALE) (buyer pays UP);
// @facts                            ask gross = floor(base·p/SCALE), fee = floor(gross·bps/10000),
// @facts                            stored quote = gross − fee (NET). Limit safety ASSERTED per fill.
// @facts                            fee_quote = quote_paid − quote_recv  (fee + rounding dust).
// @facts        stage 6 SETTLING  — bids debit quote / credit base; asks debit base / credit quote;
// @facts                            the fee is credited to fee_recipient. debits == credits or abort.
// @facts      ⚠ `address` sorts as `sui::address::to_u256`, i.e. BIG-ENDIAN over the 32 bytes.
// @facts        Comparing the 0x-string lexicographically gives the same order ONLY if both are
// @facts        normalised to 64 hex digits. We convert to bigint instead, which cannot drift.
// @implements export const PRICE_SCALE / BPS_DENOMINATOR / MAX_U64 / SIDE_BID / SIDE_ASK
// @implements export interface RevealedOrder / FundingSnapshot / Fill / ClearingResult / ClearingInput
// @implements export function addressKey(address: string): bigint
// @implements export function floorMulDiv / ceilMulDiv(a, b, c): bigint
// @implements export function encodeFill(f: Fill): Uint8Array
// @implements export function fillLeafHash(f: Fill): Uint8Array
// @implements export function fillsRoot(fills: readonly Fill[]): Uint8Array
// @implements export function clear(input: ClearingInput): ClearingResult
// @implements export function verifyFill(root, fill, index, siblings): boolean
// @implements export function siblingPath(fills: readonly Fill[], index: number): Uint8Array[]
// @forbidden  a float ANYWHERE, including intermediately
// @forbidden  Date.now() / Math.random() / any I/O — this module is pure and replayable
// @forbidden  "improving" a rounding direction on this side only — that is the release blocker
// @invariant  1. No fill outside its limit: bid ⇒ p <= limit, ask ⇒ p >= limit. ASSERTED per fill.
// @invariant  2. Σ base filled on bids == Σ base filled on asks == matchedBase.
// @invariant  3. totalDebits == totalCredits once the fee credit is included (§2.6).
// @invariant  4. feeQuote = quotePaid − quoteRecv >= 0, guaranteed by rounding toward the vault.
// @invariant  5. Idempotent: clear(x) twice yields identical price, fills and root.
// @invariant  6. A zero-quantity fill is never emitted.
// @ac         test/clearing.test.ts · test/clearing.property.test.ts (10 000 seeded cases)
// @verify     npm run test -- clearing
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { AphoticError } from '../util/errors.js';

import {
  addressBytes,
  concatBytes,
  hashLeaf,
  hashNode,
  merkleRootDuplicatingOdd,
  writeU64Le,
} from './bytes.js';

/** `clearing.move` PRICE_SCALE — quote-sats per 1e8 base-sats (one whole hBTC). */
export const PRICE_SCALE = 100_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const MAX_U64 = (1n << 64n) - 1n;

export const SIDE_BID = 0 as const;
export const SIDE_ASK = 1 as const;

/** One revealed order, exactly as `batch::revealed_at` yields it. */
export interface RevealedOrder {
  /** Submission index — the final canonical tie-break AND the funding draw-down order. */
  readonly index: number;
  readonly submitter: string;
  readonly isBid: boolean;
  /** u64, scaled by {@link PRICE_SCALE}. */
  readonly limitPrice: bigint;
  readonly qtySats: bigint;
}

/** The frozen per-account escrow snapshot `close_batch` locked in. */
export interface FundingSnapshot {
  readonly submitter: string;
  readonly baseSats: bigint;
  readonly quoteSats: bigint;
}

/** The published fill — the Merkle leaf, byte for byte (`clearing.move::Fill`). */
export interface Fill {
  readonly batchId: bigint;
  readonly orderIndex: bigint;
  readonly submitter: string;
  readonly isBid: boolean;
  readonly baseSats: bigint;
  /** BID: quote DEBITED (rounded up). ASK: quote CREDITED, already NET of the fee. */
  readonly quoteSats: bigint;
  readonly price: bigint;
}

export interface ClearingInput {
  readonly batchId: bigint;
  /** In SUBMISSION order — the funding draw-down depends on it (D-3). */
  readonly orders: readonly RevealedOrder[];
  readonly funding: readonly FundingSnapshot[];
  readonly feeMatchedBps: bigint;
  /** Override for fixtures only. Defaults to {@link PRICE_SCALE}. */
  readonly priceScale?: bigint;
}

export interface ClearingResult {
  readonly cleared: boolean;
  readonly clearingPrice: bigint;
  readonly matchedBaseSats: bigint;
  /** Σ bid quote debited. */
  readonly quotePaid: bigint;
  /** Σ ask quote credited (already net of fee). */
  readonly quoteRecv: bigint;
  /** `quotePaid − quoteRecv` — the matched fee PLUS the rounding dust (D-2). */
  readonly feeQuote: bigint;
  /** Bids in canonical order, then asks in canonical order. Zero-quantity fills omitted. */
  readonly fills: readonly Fill[];
  readonly fillsRoot: Uint8Array;
  readonly totalDebits: bigint;
  readonly totalCredits: bigint;
  /** Distinct limit prices considered, ascending. */
  readonly candidates: readonly bigint[];
}

/** `sui::address::to_u256` — the 32 address bytes read BIG-ENDIAN. */
export function addressKey(address: string): bigint {
  let key = 0n;
  for (const byte of addressBytes(address)) key = (key << 8n) | BigInt(byte);
  return key;
}

/** `clearing.move::floor_mul_div`. */
export function floorMulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c <= 0n) throw new AphoticError('EBadParam', 'floorMulDiv: divisor must be positive');
  return (a * b) / c;
}

/** `clearing.move::ceil_mul_div`. */
export function ceilMulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c <= 0n) throw new AphoticError('EBadParam', 'ceilMulDiv: divisor must be positive');
  const n = a * b;
  return n === 0n ? 0n : (n - 1n) / c + 1n;
}

function assertU64(value: bigint, what: string): bigint {
  if (value < 0n || value > MAX_U64) {
    throw new AphoticError('EOverflow', `${what} is outside u64: ${value}`);
  }
  return value;
}

/** `bcs::to_bytes(&Fill)` — 73 bytes. */
export function encodeFill(f: Fill): Uint8Array {
  return concatBytes(
    writeU64Le(f.batchId),
    writeU64Le(f.orderIndex),
    addressBytes(f.submitter),
    Uint8Array.of(f.isBid ? 1 : 0),
    writeU64Le(f.baseSats),
    writeU64Le(f.quoteSats),
    writeU64Le(f.price),
  );
}

export function fillLeafHash(f: Fill): Uint8Array {
  return hashLeaf(encodeFill(f));
}

/** The published `fills_root`. Empty ⇒ 32 zero bytes. */
export function fillsRoot(fills: readonly Fill[]): Uint8Array {
  return merkleRootDuplicatingOdd(fills.map(fillLeafHash));
}

// ── internal working entry (the Move `Entry` struct) ─────────────────────────

interface Entry {
  readonly orderIndex: number;
  readonly submitter: string;
  readonly key: bigint;
  readonly isBid: boolean;
  readonly limitPrice: bigint;
  /** Already truncated to what the submitter can fund. */
  readonly qtySats: bigint;
  fillBase: bigint;
  frac: bigint;
  bumped: boolean;
}

function bidPrecedes(a: Entry, b: Entry): boolean {
  if (a.limitPrice !== b.limitPrice) return a.limitPrice > b.limitPrice;
  if (a.key !== b.key) return a.key < b.key;
  return a.orderIndex < b.orderIndex;
}

function askPrecedes(a: Entry, b: Entry): boolean {
  if (a.limitPrice !== b.limitPrice) return a.limitPrice < b.limitPrice;
  if (a.key !== b.key) return a.key < b.key;
  return a.orderIndex < b.orderIndex;
}

/** `insert_canonical` — linear insertion, so equal-price runs stay in canonical order. */
function insertCanonical(list: Entry[], e: Entry, precedes: (a: Entry, b: Entry) => boolean): void {
  let i = 0;
  while (i < list.length && !precedes(e, list[i] as Entry)) i++;
  list.splice(i, 0, e);
}

/**
 * THE uniform-price clearing algorithm, as `clearing.move` runs it.
 *
 * Budget/cursor resumption is a gas concern, not a semantic one: every stage in Move is a pure
 * fold over the same state, so running each to completion here yields the identical result. That
 * equivalence is what makes an off-chain twin possible at all.
 */
export function clear(input: ClearingInput): ClearingResult {
  const scale = input.priceScale ?? PRICE_SCALE;
  if (scale <= 0n) throw new AphoticError('EBadParam', 'priceScale must be positive');
  if (input.feeMatchedBps < 0n || input.feeMatchedBps > BPS_DENOMINATOR) {
    throw new AphoticError('EBadParam', `fee_matched_bps out of range: ${input.feeMatchedBps}`);
  }

  // ── stage 0: LOADING — funding truncation in SUBMISSION order, then canonical insert ──
  const baseLeft = new Map<string, bigint>();
  const quoteLeft = new Map<string, bigint>();
  for (const f of input.funding) {
    baseLeft.set(f.submitter, assertU64(f.baseSats, `funding[${f.submitter}].base`));
    quoteLeft.set(f.submitter, assertU64(f.quoteSats, `funding[${f.submitter}].quote`));
  }

  const bids: Entry[] = [];
  const asks: Entry[] = [];

  for (const o of input.orders) {
    assertU64(o.limitPrice, `order[${o.index}].limitPrice`);
    assertU64(o.qtySats, `order[${o.index}].qtySats`);
    if (o.limitPrice <= 0n || o.qtySats <= 0n) {
      // `batch::reveal_order` rejects these on chain, so they can never reach `load_step`.
      throw new AphoticError('EBadOrder', `order ${o.index} has a zero price or quantity`);
    }

    let effective: bigint;
    if (o.isBid) {
      const budget = quoteLeft.get(o.submitter) ?? 0n;
      // The worst case: this bid could clear at its OWN limit, never above it.
      const affordable = (budget * scale) / o.limitPrice;
      const capped = affordable > MAX_U64 ? MAX_U64 : affordable;
      effective = o.qtySats < capped ? o.qtySats : capped;
      if (effective > 0n) {
        quoteLeft.set(o.submitter, budget - ceilMulDiv(effective, o.limitPrice, scale));
      }
    } else {
      const budget = baseLeft.get(o.submitter) ?? 0n;
      effective = o.qtySats < budget ? o.qtySats : budget;
      baseLeft.set(o.submitter, budget - effective);
    }

    if (effective <= 0n) continue; // dropped entirely, exactly as Move does

    const entry: Entry = {
      orderIndex: o.index,
      submitter: o.submitter,
      key: addressKey(o.submitter),
      isBid: o.isBid,
      limitPrice: o.limitPrice,
      qtySats: effective,
      fillBase: 0n,
      frac: 0n,
      bumped: false,
    };
    if (o.isBid) insertCanonical(bids, entry, bidPrecedes);
    else insertCanonical(asks, entry, askPrecedes);
  }

  // Candidate prices: the distinct limits present, ASCENDING (Move merges the two sorted sides).
  const priceSet = new Set<bigint>();
  for (const e of bids) priceSet.add(e.limitPrice);
  for (const e of asks) priceSet.add(e.limitPrice);
  const candidates = [...priceSet].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));

  // ── stage 1: PRICING ──
  let totalBidQty = 0n;
  for (const e of bids) totalBidQty += e.qtySats;

  let demandRemaining = totalBidQty;
  let bidScan = bids.length;
  let supplyAcc = 0n;
  let askScan = 0;
  let found = false;
  let bestPrice = 0n;
  let bestVol = 0n;
  let bestGap = 0n;

  for (const p of candidates) {
    while (bidScan > 0 && (bids[bidScan - 1] as Entry).limitPrice < p) {
      demandRemaining -= (bids[bidScan - 1] as Entry).qtySats;
      bidScan -= 1;
    }
    while (askScan < asks.length && (asks[askScan] as Entry).limitPrice <= p) {
      supplyAcc += (asks[askScan] as Entry).qtySats;
      askScan += 1;
    }
    const vol = demandRemaining < supplyAcc ? demandRemaining : supplyAcc;
    const gap =
      demandRemaining >= supplyAcc ? demandRemaining - supplyAcc : supplyAcc - demandRemaining;
    // Strict improvement only, over ASCENDING candidates ⇒ the lowest price wins every tie.
    if (vol > 0n && (!found || vol > bestVol || (vol === bestVol && gap < bestGap))) {
      found = true;
      bestVol = vol;
      bestGap = gap;
      bestPrice = p;
    }
  }

  const empty = (): ClearingResult => ({
    cleared: false,
    clearingPrice: 0n,
    matchedBaseSats: 0n,
    quotePaid: 0n,
    quoteRecv: 0n,
    feeQuote: 0n,
    fills: [],
    fillsRoot: merkleRootDuplicatingOdd([]),
    totalDebits: 0n,
    totalCredits: 0n,
    candidates,
  });

  if (!found) {
    // A batch with no crossing interest still settles — spec §7.3 settles every pass.
    return empty();
  }

  const p = bestPrice;
  let demand = 0n;
  let eligBids = 0;
  while (eligBids < bids.length && (bids[eligBids] as Entry).limitPrice >= p) {
    demand += (bids[eligBids] as Entry).qtySats;
    eligBids += 1;
  }
  let supply = 0n;
  let eligAsks = 0;
  while (eligAsks < asks.length && (asks[eligAsks] as Entry).limitPrice <= p) {
    supply += (asks[eligAsks] as Entry).qtySats;
    eligAsks += 1;
  }
  const matchedBase = demand < supply ? demand : supply;

  // ── stage 2: ALLOC_FULL — strictly inside the cross fills, at-the-price pools ──
  let filledBid = 0n;
  let filledAsk = 0n;
  let proQtyBid = 0n;
  let proQtyAsk = 0n;

  for (let i = 0; i < eligBids; i++) {
    const e = bids[i] as Entry;
    if (e.limitPrice > p) {
      const remaining = matchedBase - filledBid;
      const fill = e.qtySats < remaining ? e.qtySats : remaining;
      e.fillBase = fill;
      filledBid += fill;
    } else {
      proQtyBid += e.qtySats;
    }
  }
  for (let i = 0; i < eligAsks; i++) {
    const e = asks[i] as Entry;
    if (e.limitPrice < p) {
      const remaining = matchedBase - filledAsk;
      const fill = e.qtySats < remaining ? e.qtySats : remaining;
      e.fillBase = fill;
      filledAsk += fill;
    } else {
      proQtyAsk += e.qtySats;
    }
  }

  const residualBid = matchedBase - filledBid;
  const residualAsk = matchedBase - filledAsk;

  // ── stage 3: PRORATA — floor share plus the exact u128 fractional rank ──
  let awardedBid = 0n;
  let awardedAsk = 0n;
  for (let i = 0; i < eligBids; i++) {
    const e = bids[i] as Entry;
    if (e.limitPrice === p && proQtyBid > 0n) {
      const base = floorMulDiv(residualBid, e.qtySats, proQtyBid);
      e.fillBase = base;
      e.frac = residualBid * e.qtySats - base * proQtyBid;
      e.bumped = false;
      awardedBid += base;
    }
  }
  for (let i = 0; i < eligAsks; i++) {
    const e = asks[i] as Entry;
    if (e.limitPrice === p && proQtyAsk > 0n) {
      const base = floorMulDiv(residualAsk, e.qtySats, proQtyAsk);
      e.fillBase = base;
      e.frac = residualAsk * e.qtySats - base * proQtyAsk;
      e.bumped = false;
      awardedAsk += base;
    }
  }

  // ── stage 4: REMAINDER — one sat at a time, largest unbumped fraction first ──
  // ⚠ `bumped` is never cleared, so an entry receives AT MOST ONE extra sat. That is exactly
  // what clearing.move does; a loop that could bump twice would diverge on the second pass.
  const bumpSide = (side: Entry[], n: number, residual: bigint, awarded: bigint): bigint => {
    let given = awarded;
    for (;;) {
      if (given >= residual) return given;
      let bestI = -1;
      let bestF = 0n;
      for (let i = 0; i < n; i++) {
        const e = side[i] as Entry;
        if (e.limitPrice !== p || e.bumped) continue;
        if (bestI === -1 || e.frac > bestF) {
          bestI = i;
          bestF = e.frac;
        }
      }
      if (bestI === -1) return given;
      const e = side[bestI] as Entry;
      e.fillBase += 1n;
      e.bumped = true;
      given += 1n;
    }
  };
  awardedBid = bumpSide(bids, eligBids, residualBid, awardedBid);
  awardedAsk = bumpSide(asks, eligAsks, residualAsk, awardedAsk);

  // ── stage 5: ROOTING — quotes, limit safety, fills, root ──
  const fills: Fill[] = [];
  let quotePaid = 0n;
  let quoteRecv = 0n;

  const emit = (side: Entry[], isBid: boolean): void => {
    for (const e of side) {
      if (e.fillBase <= 0n) continue;
      if (isBid && p > e.limitPrice) {
        throw new AphoticError(
          'EFillOutsideLimit',
          `bid ${e.orderIndex} limit ${e.limitPrice} below clearing price ${p}`,
        );
      }
      if (!isBid && p < e.limitPrice) {
        throw new AphoticError(
          'EFillOutsideLimit',
          `ask ${e.orderIndex} limit ${e.limitPrice} above clearing price ${p}`,
        );
      }

      let quote: bigint;
      if (isBid) {
        quote = ceilMulDiv(e.fillBase, p, scale); // the buyer pays UP — toward the vault
        quotePaid = assertU64(quotePaid + quote, 'quotePaid');
      } else {
        const gross = floorMulDiv(e.fillBase, p, scale); // the seller receives DOWN
        const fee = floorMulDiv(gross, input.feeMatchedBps, BPS_DENOMINATOR);
        quote = gross - fee;
        quoteRecv = assertU64(quoteRecv + quote, 'quoteRecv');
      }

      fills.push({
        batchId: input.batchId,
        orderIndex: BigInt(e.orderIndex),
        submitter: e.submitter,
        isBid,
        baseSats: e.fillBase,
        quoteSats: quote,
        price: p,
      });
    }
  };
  emit(bids, true);
  emit(asks, false);

  if (quotePaid < quoteRecv) {
    throw new AphoticError(
      'EValueNotPreserved',
      `negative fee residual: quotePaid ${quotePaid} < quoteRecv ${quoteRecv}`,
    );
  }
  const feeQuote = quotePaid - quoteRecv;

  // ── stage 6: SETTLING — the ledger identity, computed the way Move accumulates it ──
  let totalDebits = 0n;
  let totalCredits = 0n;
  for (const f of fills) {
    if (f.isBid) {
      if (f.quoteSats > 0n) totalDebits += f.quoteSats;
      totalCredits += f.baseSats;
    } else {
      totalDebits += f.baseSats;
      if (f.quoteSats > 0n) totalCredits += f.quoteSats;
    }
  }
  if (feeQuote > 0n) totalCredits += feeQuote;

  if (totalDebits !== totalCredits) {
    throw new AphoticError(
      'EValueNotPreserved',
      `debits ${totalDebits} != credits ${totalCredits} — §2.6 would abort on chain`,
    );
  }

  let matchedBid = 0n;
  let matchedAsk = 0n;
  for (const f of fills) {
    if (f.isBid) matchedBid += f.baseSats;
    else matchedAsk += f.baseSats;
  }
  if (matchedBid !== matchedAsk) {
    throw new AphoticError(
      'EValueNotPreserved',
      `base filled on bids ${matchedBid} != on asks ${matchedAsk}`,
    );
  }

  return {
    cleared: true,
    clearingPrice: p,
    matchedBaseSats: matchedAsk,
    quotePaid,
    quoteRecv,
    feeQuote,
    fills,
    fillsRoot: fillsRoot(fills),
    totalDebits,
    totalCredits,
    candidates,
  };
}

/** `clearing.move::verify_fill` — walk the sibling path and compare against the published root. */
export function verifyFill(
  root: Uint8Array,
  fill: Fill,
  index: number,
  siblings: readonly Uint8Array[],
): boolean {
  let current = fillLeafHash(fill);
  let idx = index;
  for (const sib of siblings) {
    current = idx % 2 === 0 ? hashNode(current, sib) : hashNode(sib, current);
    idx = Math.floor(idx / 2);
  }
  if (current.length !== root.length) return false;
  for (let i = 0; i < root.length; i++) if (current[i] !== root[i]) return false;
  return true;
}

/** The sibling path for `index`, matching the odd-node-duplicating tree {@link fillsRoot} builds. */
export function siblingPath(fills: readonly Fill[], index: number): Uint8Array[] {
  if (index < 0 || index >= fills.length) {
    throw new AphoticError('EIndexOutOfRange', `fill index ${index} out of range`);
  }
  let level: Uint8Array[] = fills.map(fillLeafHash);
  let idx = index;
  const path: Uint8Array[] = [];
  while (level.length > 1) {
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push((level[sibIdx] ?? level[idx]) as Uint8Array);
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const l = level[j] as Uint8Array;
      const r = (level[j + 1] ?? l) as Uint8Array;
      next.push(hashNode(l, r));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}
