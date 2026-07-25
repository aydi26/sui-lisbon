// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.7
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §4 (`readBook(pool) -> L2Book`) + ERRATA E-K6 (the indexer is unusable)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.7) · docs/FACTS.md#deepbook-venue · docs/RECON.md#r10 #r4
// @rules      G4 G7 G9
// @depends    ./book.ts (T2.7) · ../config.ts · ../sui/client.ts (T0.3)
// @facts      ★★ READ THE BOOK BY SIMULATION, NEVER FROM THE HOSTED INDEXER.
// @facts        `deepbook-indexer.testnet.mystenlabs.com/get_pools` lists 7 pools and DOES NOT
// @facts        include hBTC/DBUSDC (docs/RECON.md R10). The pool exists on-chain and is correctly
// @facts        typed; the indexer simply does not know it. Reading from it returns nothing, forever.
// @facts        (`DBTC_DBUSDC` in that list is DeepBook's OWN test BTC — not hBTC.)
// @facts      ★ `@mysten/deepbook-v3`'s DeepBookClient is driven by a BUNDLED pool/coin registry
// @facts        that will not contain our pool ⇒ build RAW moveCalls; use the SDK for BCS only.
// @facts        (The package is not even installed — see @blocked in the T2.7 handover.)
// @facts      ★ THE ONLY SAFE READ:
// @facts        pool::get_level2_range<B,Q>(&Pool, price_low: u64, price_high: u64, is_bid: bool,
// @facts            &Clock): (vector<u64>, vector<u64>)      // (prices, quantities)
// @facts        On an EMPTY book it SUCCEEDS and returns ([], []).
// @facts      ⚠⚠ NEVER call `pool::mid_price` — on an empty book it ABORTS `deepbook::book` code 2
// @facts        (`EEmptyOrderbook`), and BOTH sides of the testnet book are empty right now.
// @facts        `get_level2_ticks_from_mid` inherits that behaviour — avoid it too.
// @facts      moveCall TARGET  = cfg.deepbook.packageId          (v20 CALLABLE)
// @facts      TYPE ARGUMENTS   = [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType], which
// @facts        resolve against cfg.deepbook.originalPackageId (v1 type-origin). Swapping these
// @facts        two ids is a link error, not a runtime error (docs/FACTS.md#deepbook-venue).
// @facts      Pool shared input: cfg.deepbook.poolId @ initialSharedVersion
// @facts        cfg.deepbook.poolInitialSharedVersion (immutable ref is enough for a read).
// @facts      Clock = 0x6. Simulation transport = the ONE client from ../sui/client.ts (gRPC v2).
// @facts      Venue params: tick 1_000_000 · lot 1_000 · min_size 100_000 (cfg.deepbook.*).
// @implements export interface DeepbookDeps / Level2Range / ReadBookOptions
// @implements export function buildLevel2RangeTx(cfg: Config, args: Level2RangeArgs): Transaction
// @implements export function decodeLevel2Range(returnValues: readonly Uint8Array[]): Level2Range
// @implements export async function readLevel2Range(deps: DeepbookDeps, args: Level2RangeArgs): Promise<Level2Range>
// @implements export async function readBook(deps: DeepbookDeps, opts: ReadBookOptions): Promise<L2Book>
// @forbidden  any HTTP call to a DeepBook indexer host — G4/R10, it does not know this pool
// @forbidden  calling `pool::mid_price` or `get_level2_ticks_from_mid` — they abort on an empty book
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  cetus / clmm anything (G4, gates.ps1 g4)
// @forbidden  any wall-clock read for `L2Book.atMs` — it arrives via ReadBookOptions (purity gate)
// @invariant  1. Every read is a devInspect/simulation — this module never signs or submits.
// @invariant  2. An empty book is a VALID result (`bids: [], asks: [], mid: 0n`), never an exception.
// @invariant  3. Prices/quantities decode to bigint; nothing becomes a `number`.
// @invariant  4. `L2Book.atMs` comes from the caller, so a replayed read is byte-identical.
// @ac         docs/BUILD-PLAN.md T2.7 — reads the L2 book for Pool<hBTC,DBUSDC>, no Cetus
// @verify     npm run test -- routing
// @verify     powershell -NoProfile -File scripts/gates.ps1 g4
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type { L2Book, Millis, Sats } from '../types.js';

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
  /** Price window for the two range reads. Defaults to the full u64 range. */
  readonly priceLow?: bigint;
  readonly priceHigh?: bigint;
}

/** Build the simulation PTB for ONE side of the book. */
// TODO(T2.7): tx.moveCall({ target: `${cfg.deepbook.packageId}::pool::get_level2_range`,
//             typeArguments: [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType],
//             arguments: [pool(shared, immutable), pure u64 priceLow, pure u64 priceHigh,
//                         pure bool isBid, clock] })
export function buildLevel2RangeTx(_cfg: Config, _args: Level2RangeArgs): Transaction {
  throw new Error('TODO(T2.7): buildLevel2RangeTx not implemented');
}

/** BCS-decode the two `vector<u64>` return values. `([], [])` is a valid empty book. */
// TODO(T2.7): bcs.vector(bcs.u64()).parse() each return value; map to bigint.
export function decodeLevel2Range(_returnValues: readonly Uint8Array[]): Level2Range {
  throw new Error('TODO(T2.7): decodeLevel2Range not implemented');
}

/** Simulate one side and decode it. No signature, no gas, no state change. */
// TODO(T2.7): devInspect/simulate buildLevel2RangeTx via deps.client, then decodeLevel2Range.
export async function readLevel2Range(
  _deps: DeepbookDeps,
  _args: Level2RangeArgs,
): Promise<Level2Range> {
  throw new Error('TODO(T2.7): readLevel2Range not implemented');
}

/**
 * Full L2 snapshot: one range read per side, assembled into the journal's heavy `book` field.
 *
 * `mid` is computed from the decoded top-of-book by `book.ts::bookMid` — NEVER by calling
 * `pool::mid_price`, which aborts on the (currently empty) book.
 */
// TODO(T2.7): two readLevel2Range calls (bid + ask), sort, compute mid via book.ts, stamp opts.atMs.
export async function readBook(_deps: DeepbookDeps, _opts: ReadBookOptions): Promise<L2Book> {
  throw new Error('TODO(T2.7): readBook not implemented');
}
