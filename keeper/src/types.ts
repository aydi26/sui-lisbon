// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §0 ("Sats everywhere"), §3.1 (Decision), §4 (Plan),
//             §6 (OracleSnapshot), §8 (DecisionRecord), §9.2 (limiter trajectory)
// @rules      G1 G2 G4 G5 G9 G10
// @depends    (none — leaf module; every other keeper module imports FROM here)
// @facts      All money is satoshis in `bigint`. hBTC has 8 decimals (docs/FACTS.md#hbtc).
// @facts      DeepBook Pool<hBTC,DBUSDC>: tick 1_000_000 · lot 1_000 · min_size 100_000.
// @facts      hBTC is a FUNGIBLE Coin<BTC>; on-Sui movement is INSTANT (G1) — never model it
// @facts        as a position/NFT and never claim BTC latency gates an on-Sui operation.
// @implements export type Sats = bigint
// @implements export type Millis = number
// @implements export type Secs = bigint
// @implements export type SuiAddress = string
// @implements export type ObjectId = string
// @implements export type Digest = string
// @implements export type Bps = number
// @implements export type BtcAddress = Uint8Array
// @implements export type Side = 'bid' | 'ask'
// @implements export interface L2Level / L2Book / OrderId
// @implements export interface Decision / Plan / MakerOrder / IocOrder
// @implements export interface OracleSnapshot
// @implements export interface LimiterSample
// @implements export interface DecisionRecord
// @forbidden  `number` for any satoshi amount — G10 / KEEPER.md §0 static check
// @invariant  1. This module contains TYPES ONLY — zero runtime code, zero imports.
// @verify     npm run typecheck
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── Scalars ──────────────────────────────────────────────────────────────────

/** Satoshis. ALWAYS bigint — a 1 BTC bucket times a large elapsed exceeds Number.MAX_SAFE_INTEGER. */
export type Sats = bigint;
/** Milliseconds since the unix epoch (Sui `Clock` granularity). */
export type Millis = number;
/** Unix SECONDS. The Guardian limiter's native time base (docs/RECON.md R9). */
export type Secs = bigint;
/** `0x`-prefixed 32-byte Sui address. */
export type SuiAddress = string;
/** `0x`-prefixed 32-byte Sui object/package id. */
export type ObjectId = string;
/** Base58 Sui transaction digest. */
export type Digest = string;
/** Basis points (1/10_000). */
export type Bps = number;
/** A Bitcoin WITNESS PROGRAM: 20 bytes (P2WPKH) or 32 bytes (P2TR). Never a bech32 string. */
export type BtcAddress = Uint8Array;

// ── DeepBook venue (G4: DeepBook only — no Cetus, no CLMM) ───────────────────

export type Side = 'bid' | 'ask';

/** DeepBook order id (u128 on-chain). */
export type OrderId = bigint;

export interface L2Level {
  /** Tick-aligned price (tick = 1_000_000). */
  readonly px: bigint;
  /** Lot-aligned size in sats (lot = 1_000, min_size = 100_000). */
  readonly sz: Sats;
}

/** L2 snapshot of `Pool<hBTC, DBUSDC>` — the heavy journal field that makes routing publicly checkable. */
export interface L2Book {
  readonly poolId: ObjectId;
  readonly bids: readonly L2Level[];
  readonly asks: readonly L2Level[];
  /** DeepBook mid — the NAV/collateral reference (G9 depeg defence). NEVER raw Pyth. */
  readonly mid: bigint;
  readonly atMs: Millis;
}

// ── Strategy / routing (pure, deterministic — KEEPER.md §3.1, §4) ────────────

export type DecisionAction = 'quote' | 'requote' | 'derisk' | 'noop';

export interface Decision {
  readonly action: DecisionAction;
  readonly bidPx: bigint;
  readonly askPx: bigint;
  readonly bidSz: Sats;
  readonly askSz: Sats;
  readonly cancels: readonly OrderId[];
  /** e.g. 'limiter-tightening' | 'oracle-divergence' | 'buffer'. */
  readonly cause?: string;
  /** Seeded PRNG seed — recorded so `verify/` reproduces the jitter exactly. */
  readonly jitterSeed: string;
}

export interface MakerOrder {
  readonly side: Side;
  readonly px: bigint;
  readonly sz: Sats;
  readonly expireTs: Millis;
  readonly postOnly: true;
}

export interface IocOrder {
  readonly side: Side;
  readonly px: bigint;
  readonly sz: Sats;
  readonly ioc: true;
}

/** Maker-first, IOC residual ON THE SAME BOOK. There is nowhere else to route (G4). */
export interface Plan {
  readonly makerOrders: readonly MakerOrder[];
  readonly iocOrders: readonly IocOrder[];
  readonly cancels: readonly OrderId[];
}

// ── Oracle (KEEPER.md §6) ────────────────────────────────────────────────────

export interface OracleSnapshot {
  /** Pyth BTC/USD from the BETA channel on testnet (G9). */
  readonly pythPx: bigint;
  readonly pythSeq: bigint;
  readonly pythPublishTimeMs: Millis;
  readonly deepbookTwap: bigint;
  /** The valuation reference for NAV/collateral (G9). */
  readonly deepbookMid: bigint;
}

// ── Limiter trajectory (KEEPER.md §9.2 — the G5 trustless replay) ────────────

/** One sample of the re-derived Guardian bucket. Produced ONLY from on-chain events (G5). */
export interface LimiterSample {
  readonly atMs: Millis;
  readonly atSecs: Secs;
  readonly tokens: Sats;
  /** Σ Requested − Σ (Signed | Cancelled). */
  readonly queueDepth: Sats;
}

// ── Journal (KEEPER.md §8) ───────────────────────────────────────────────────

export interface DecisionRecord {
  readonly tickMs: Millis;
  readonly oracle: OracleSnapshot;
  readonly book: L2Book;
  readonly hashi: {
    readonly limiter: LimiterSample;
    readonly pendingMintSats: Sats;
    readonly pendingBurnSats: Sats;
    /** Cursor into the `WithdrawalSigned` stream this reading was derived from. */
    readonly signedCursorSeq: bigint;
  };
  /** Blob id of the strategy VERSION in force (not the current one). */
  readonly strategyBlobId: string;
  /** Content hash of the compiled decision function. */
  readonly ruleset: string;
  readonly decision: Decision;
  readonly plan: Plan;
  readonly result: { readonly digest: Digest } | { readonly skipped: string };
}
