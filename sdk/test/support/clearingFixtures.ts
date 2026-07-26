// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.3
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 L1 (ONE fixture file, read by the TS test, the Move generator
//             and the golden regenerator — a fixture edit must update every side or fail)
// @rules      G5
// @depends    ../../fixtures/clearing.golden.json · ../../src/clearing.ts
// @facts      This is the SINGLE decoder for the compact fixture rows. If the test and the
// @facts        generator each parsed the JSON their own way, a fixture could pass one and fail
// @facts        the other — the same duplication B6 punished us for.
// @implements export interface GoldenCase
// @implements export function loadClearingGolden(): GoldenFile
// @implements export function buildOrders(c: GoldenCase, addresses): RevealedOrder[]
// @implements export function buildBalances(c: GoldenCase, addresses): FrozenBalance[] | undefined
// @implements export function expectedFills(c: GoldenCase, addresses): Fill[] | undefined
// @forbidden  a second parser for this file anywhere
// @verify     npx vitest run clearing.golden
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SIDE_ASK,
  SIDE_BID,
  type Fill,
  type FrozenBalance,
  type RevealedOrder,
  type Side,
} from '../../src/clearing.js';

export type OrderRow = [number, string, number, string, string];
export type BalanceRow = [string, string, string];
export type FillRow = [number, number, string, string, string];

export interface GenerateSpec {
  readonly bidCount: number;
  readonly askCount: number;
  readonly bidPrices: readonly string[];
  readonly askPrices: readonly string[];
  readonly bidQtys: readonly string[];
  readonly askQtys: readonly string[];
}

export interface GoldenExpect {
  readonly cleared: boolean;
  readonly price: string;
  readonly matchedBase: string;
  readonly matchedQuote: string;
  readonly feeQuote: string;
  readonly dustQuote: string;
  readonly matchedBaseBeforeTruncation: string;
  readonly fills?: readonly FillRow[];
  readonly fillsCount?: number;
  fillsRoot: string | null;
}

export interface GoldenCase {
  readonly name: string;
  readonly why: string;
  readonly feeMatchedBps: string;
  readonly orders?: readonly OrderRow[];
  readonly balances?: readonly BalanceRow[];
  readonly generate?: GenerateSpec;
  readonly pinned?: boolean;
  readonly expectThrow?: string;
  expect?: GoldenExpect;
}

export interface GoldenFile {
  readonly priceScale: string;
  readonly addresses: Readonly<Record<string, string>>;
  readonly cases: GoldenCase[];
}

export const CLEARING_GOLDEN_PATH = fileURLToPath(
  new URL('../../fixtures/clearing.golden.json', import.meta.url),
);

export function loadClearingGolden(): GoldenFile {
  return JSON.parse(readFileSync(CLEARING_GOLDEN_PATH, 'utf8')) as GoldenFile;
}

function addr(addresses: Readonly<Record<string, string>>, key: string): string {
  const a = addresses[key];
  if (a === undefined) throw new Error(`fixture references unknown address key ${key}`);
  return a;
}

/** Deterministic 32-byte address for the generated batches: 0x…0001, 0x…0002, … */
function syntheticAddress(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function asSide(n: number): Side {
  if (n !== SIDE_BID && n !== SIDE_ASK) throw new Error(`fixture has a bad side: ${n}`);
  return n;
}

/** The orders a case declares, either literally or via its `generate` spec. */
export function buildOrders(
  c: GoldenCase,
  addresses: Readonly<Record<string, string>>,
): RevealedOrder[] {
  if (c.generate) {
    const g = c.generate;
    const out: RevealedOrder[] = [];
    for (let i = 0; i < g.bidCount; i++) {
      out.push({
        index: out.length,
        submitter: syntheticAddress(i + 1),
        side: SIDE_BID,
        limitPrice: BigInt(g.bidPrices[i % g.bidPrices.length]!),
        qtyBase: BigInt(g.bidQtys[i % g.bidQtys.length]!),
      });
    }
    for (let j = 0; j < g.askCount; j++) {
      out.push({
        index: out.length,
        submitter: syntheticAddress(100_000 + j + 1),
        side: SIDE_ASK,
        limitPrice: BigInt(g.askPrices[j % g.askPrices.length]!),
        qtyBase: BigInt(g.askQtys[j % g.askQtys.length]!),
      });
    }
    return out;
  }
  return (c.orders ?? []).map(([index, who, side, price, qty]) => ({
    index,
    submitter: addr(addresses, who),
    side: asSide(side),
    limitPrice: BigInt(price),
    qtyBase: BigInt(qty),
  }));
}

/** `undefined` means the case supplies NO frozen snapshot, which disables truncation. */
export function buildBalances(
  c: GoldenCase,
  addresses: Readonly<Record<string, string>>,
): FrozenBalance[] | undefined {
  if (!c.balances) return undefined;
  return c.balances.map(([who, base, quote]) => ({
    submitter: addr(addresses, who),
    base: BigInt(base),
    quote: BigInt(quote),
  }));
}

/** The hand-written expected fills, resolved into full `Fill` objects. */
export function expectedFills(
  c: GoldenCase,
  addresses: Readonly<Record<string, string>>,
): Fill[] | undefined {
  const rows = c.expect?.fills;
  if (!rows) return undefined;
  const orders = buildOrders(c, addresses);
  const byIndex = new Map(orders.map((o) => [o.index, o]));
  const price = BigInt(c.expect!.price);
  return rows.map(([index, side, qty, quote, fee]) => {
    const o = byIndex.get(index);
    if (!o) throw new Error(`${c.name}: expected fill for unknown order index ${index}`);
    return {
      index,
      submitter: o.submitter,
      side: asSide(side),
      price,
      qtyBase: BigInt(qty),
      quote: BigInt(quote),
      fee: BigInt(fee),
    };
  });
}
