// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P1.oracle
// @phase      1
// @status     DONE
// @spec       docs/KEEPER.md §4 (`readBook(pool) -> L2Book`) + ERRATA E-K6 (the indexer is unusable)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7) · docs/FACTS.md#deepbook-venue · docs/RECON.md#r10 #r4
// @rules      G4 G7 G9
// @depends    ./book.ts (P1.oracle) · ../config.ts · ../sui/client.ts (T0.3)
// @facts      ★★ READ THE BOOK BY SIMULATION, NEVER FROM THE HOSTED INDEXER.
// @facts        `deepbook-indexer.testnet.mystenlabs.com/get_pools` lists 7 pools and DOES NOT
// @facts        include hBTC/DBUSDC (docs/RECON.md R10). The pool exists on-chain and is correctly
// @facts        typed; the indexer simply does not know it. Reading from it returns nothing, forever.
// @facts        (`DBTC_DBUSDC` in that list is DeepBook's OWN test BTC — not hBTC.)
// @facts      ★ `@mysten/deepbook-v3`'s DeepBookClient is driven by a BUNDLED pool/coin registry
// @facts        that will not contain our pool ⇒ build RAW moveCalls; use the SDK for BCS only.
// @facts        (The package is not installed — we BCS-decode with `@mysten/sui/bcs` instead,
// @facts        which is the same wire format and one dependency fewer.)
// @facts      ★ THE ONLY SAFE READ:
// @facts        pool::get_level2_range<B,Q>(&Pool, price_low: u64, price_high: u64, is_bid: bool,
// @facts            &Clock): (vector<u64>, vector<u64>)      // (prices, quantities)
// @facts        On an EMPTY book it SUCCEEDS and returns ([], []).
// @facts        Bids come back DESCENDING, asks ASCENDING ⇒ index 0 is top-of-book on each side.
// @facts      ⚠⚠ NEVER call `pool::mid_price` — on an empty book it ABORTS `deepbook::book` code 2
// @facts        (`EEmptyOrderbook`), and BOTH sides of the testnet book are empty right now.
// @facts        `get_level2_ticks_from_mid` inherits that behaviour — avoid it too.
// @facts      DeepBook price bounds (deepbook::constants, pinned rev): MIN_PRICE = 1,
// @facts        MAX_PRICE = (1 << 63) - 1 = 9_223_372_036_854_775_807. Venue params, not ids.
// @facts      moveCall TARGET  = cfg.deepbook.packageId          (v20 CALLABLE)
// @facts      TYPE ARGUMENTS   = [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType], which
// @facts        resolve against cfg.deepbook.originalPackageId (v1 type-origin). Swapping these
// @facts        two ids is a link error, not a runtime error (docs/FACTS.md#deepbook-venue).
// @facts      Pool shared input: cfg.deepbook.poolId @ initialSharedVersion
// @facts        cfg.deepbook.poolInitialSharedVersion (immutable ref is enough for a read).
// @facts      Clock = 0x6. Simulation transport = the ONE client from ../sui/client.ts (gRPC v2).
// @facts      Venue params: tick 1_000_000 · lot 1_000 · min_size 100_000 (cfg.deepbook.*).
// @implements export interface DeepbookDeps / Level2Range / ReadBookOptions / Level2RangeArgs
// @implements export const DEEPBOOK_MIN_PRICE / DEEPBOOK_MAX_PRICE
// @implements export function buildLevel2RangeTx(cfg: Config, args: Level2RangeArgs): Transaction
// @implements export function decodeLevel2Range(returnValues: readonly Uint8Array[]): Level2Range
// @implements export function assembleBook(cfg, bidSide, askSide, atMs): L2Book
// @implements export async function readLevel2Range(deps: DeepbookDeps, args: Level2RangeArgs): Promise<Level2Range>
// @implements export async function readBook(deps: DeepbookDeps, opts: ReadBookOptions): Promise<L2Book>
// @forbidden  any HTTP call to a DeepBook indexer host — G4/R10, it does not know this pool
// @forbidden  calling `pool::mid_price` or `get_level2_ticks_from_mid` — they abort on an empty book
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  any non-DeepBook venue leg, and any concentrated-liquidity range logic (G4, gates.ps1 g4)
// @forbidden  any wall-clock read for `L2Book.atMs` — it arrives via ReadBookOptions (purity gate)
// @invariant  1. Every read is a simulation — this module never signs or submits.
// @invariant  2. An empty book is a VALID result (`bids: [], asks: [], mid: 0n`), never an exception.
// @invariant  3. Prices/quantities decode to bigint; nothing becomes a `number`.
// @invariant  4. `L2Book.atMs` comes from the caller, so a replayed read is byte-identical.
// @ac         docs/BUILD-PLAN.md T2.7 — reads the L2 book for Pool<hBTC,DBUSDC>, DeepBook only
// @verify     npm run test -- oracle
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type { L2Book, L2Level, Millis, Sats } from '../types.js';
import { AphoticError } from '../util/errors.js';

import { bookMid } from './book.js';

/** `deepbook::constants::min_price()`. A DeepBook price is never zero. */
export const DEEPBOOK_MIN_PRICE = 1n;
/** `deepbook::constants::max_price()` = (1 << 63) - 1. */
export const DEEPBOOK_MAX_PRICE = (1n << 63n) - 1n;

export interface DeepbookDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
}

/** Arguments of `pool::get_level2_range`. Prices are tick-scaled u64. */
export interface Level2RangeArgs {
  readonly priceLow: bigint;
  readonly priceHigh: bigint;
  /** `true` reads the bid side, `false` the ask side. One call per side. */
  readonly isBid: boolean;
}

/** Raw decode of the `(vector<u64>, vector<u64>)` return: parallel price/quantity arrays. */
export interface Level2Range {
  readonly prices: readonly bigint[];
  readonly quantities: readonly Sats[];
}

export interface ReadBookOptions {
  /** Logical timestamp stamped onto the returned `L2Book`. Caller-supplied (invariant 4). */
  readonly atMs: Millis;
  /** Price window for the two range reads. Defaults to the full legal DeepBook range. */
  readonly priceLow?: bigint;
  readonly priceHigh?: bigint;
}

/**
 * The minimal simulation surface both `SuiGrpcClient` and `SuiJsonRpcClient` expose on `.core`.
 *
 * Declared structurally rather than called off the client union: the two `simulateTransaction`
 * overloads are generic in different `Include` type parameters, so a direct union call does not
 * typecheck. This shape is the intersection we actually use, and it keeps the transport gate
 * happy — no client is constructed here.
 */
interface SimulationCore {
  simulateTransaction(input: {
    transaction: Transaction;
    include: { commandResults: true };
  }): Promise<{
    commandResults?: readonly { readonly returnValues: readonly { readonly bcs: Uint8Array }[] }[];
  }>;
}

const U64_VECTOR = bcs.vector(bcs.u64());

/** Build the simulation PTB for ONE side of the book. */
export function buildLevel2RangeTx(cfg: Config, args: Level2RangeArgs): Transaction {
  const tx = new Transaction();

  // A simulation still resolves the sender's gas coin unless checks are disabled; setting the
  // keeper address when we have one keeps the request identical between rehearsal and live.
  if (cfg.sui.keeperAddress !== '') tx.setSender(cfg.sui.keeperAddress);

  tx.moveCall({
    // v20 CALLABLE package — never the v1 type-origin id (that is a link error).
    target: `${cfg.deepbook.packageId}::pool::get_level2_range`,
    typeArguments: [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType],
    arguments: [
      tx.sharedObjectRef({
        objectId: cfg.deepbook.poolId,
        initialSharedVersion: cfg.deepbook.poolInitialSharedVersion,
        mutable: false,
      }),
      tx.pure.u64(args.priceLow),
      tx.pure.u64(args.priceHigh),
      tx.pure.bool(args.isBid),
      tx.object.clock(),
    ],
  });

  return tx;
}

/** BCS-decode the two `vector<u64>` return values. `([], [])` is a valid empty book. */
export function decodeLevel2Range(returnValues: readonly Uint8Array[]): Level2Range {
  const rawPrices = returnValues[0];
  const rawQuantities = returnValues[1];

  const prices = rawPrices === undefined ? [] : U64_VECTOR.parse(rawPrices).map((v) => BigInt(v));
  const quantities =
    rawQuantities === undefined ? [] : U64_VECTOR.parse(rawQuantities).map((v) => BigInt(v));

  if (prices.length !== quantities.length) {
    throw new AphoticError(
      'BadLevel2Decode',
      `get_level2_range returned ${prices.length} prices and ${quantities.length} quantities`,
    );
  }

  return { prices, quantities };
}

/**
 * Fold the two decoded sides into the journal's heavy `book` field.
 *
 * PURE — separated from the transport so a fixture-driven test exercises the exact assembly the
 * live path uses. `mid` is derived from the decoded top of book (`./book.ts`), NEVER by calling
 * `pool::mid_price` (E-K6). No mid ⇒ `0n`, an explicit "no book" value (invariant 2); callers
 * that must distinguish "no mid" from "mid 0" call `bookMid` themselves.
 */
export function assembleBook(
  cfg: Config,
  bidSide: Level2Range,
  askSide: Level2Range,
  atMs: Millis,
): L2Book {
  const bids = toLevels(bidSide).sort((a, b) => compareBigint(b.px, a.px)); // DESCENDING
  const asks = toLevels(askSide).sort((a, b) => compareBigint(a.px, b.px)); // ASCENDING

  const partial: L2Book = { poolId: cfg.deepbook.poolId, bids, asks, mid: 0n, atMs };
  return { ...partial, mid: bookMid(partial) ?? 0n };
}

/** Simulate one side and decode it. No signature, no gas, no state change. */
export async function readLevel2Range(
  deps: DeepbookDeps,
  args: Level2RangeArgs,
): Promise<Level2Range> {
  const tx = buildLevel2RangeTx(deps.cfg, args);
  const core = deps.client.core as unknown as SimulationCore;

  const result = await core.simulateTransaction({ transaction: tx, include: { commandResults: true } });
  const command = result.commandResults?.[0];
  if (command === undefined) {
    throw new AphoticError(
      'BadLevel2Decode',
      'get_level2_range simulation returned no command results',
    );
  }

  return decodeLevel2Range(command.returnValues.map((value) => value.bcs));
}

/**
 * Full L2 snapshot: one range read per side, assembled into the journal's heavy `book` field.
 *
 * `mid` is computed from the decoded top-of-book by `book.ts::bookMid` — NEVER by calling
 * `pool::mid_price`, which aborts on the (currently empty) book.
 */
export async function readBook(deps: DeepbookDeps, opts: ReadBookOptions): Promise<L2Book> {
  const priceLow = opts.priceLow ?? DEEPBOOK_MIN_PRICE;
  const priceHigh = opts.priceHigh ?? DEEPBOOK_MAX_PRICE;

  const bidSide = await readLevel2Range(deps, { priceLow, priceHigh, isBid: true });
  const askSide = await readLevel2Range(deps, { priceLow, priceHigh, isBid: false });

  return assembleBook(deps.cfg, bidSide, askSide, opts.atMs);
}

// ── internals ────────────────────────────────────────────────────────────────

function toLevels(range: Level2Range): L2Level[] {
  const levels: L2Level[] = [];
  for (let i = 0; i < range.prices.length; i++) {
    const px = range.prices[i];
    const sz = range.quantities[i];
    if (px === undefined || sz === undefined) continue;
    if (sz <= 0n) continue; // a level with no size is not a price
    levels.push({ px, sz });
  }
  return levels;
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
