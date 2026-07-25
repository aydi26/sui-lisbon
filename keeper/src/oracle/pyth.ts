// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §6 (Pyth Beta + staleness guard) + ERRATA E-K11 (feed id RESOLVED)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.8) · docs/FACTS.md#pyth-oracle · docs/RECON.md#r11
// @rules      G7 G9
// @depends    ../config.ts (every id/endpoint) · ../types.ts
// @facts      ★★ BETA CHANNEL ONLY ON TESTNET (G9).
// @facts        cfg.pyth.btcUsdFeedId  = the BETA BTC/USD feed (0xf9c0172b…, docs/RECON.md R11)
// @facts        cfg.pyth.hermesEndpoint = https://hermes-beta.pyth.network
// @facts        The STABLE/mainnet feed id (0xe62df6c8…) MUST NOT ship on testnet. Both ids live in
// @facts        config.ts only (G7) — never re-type either literal into this file.
// @facts      ★ When resolving feeds by symbol, match `attributes.symbol === "Crypto.BTC/USD"`
// @facts        EXACTLY. The query `btc/usd` returns 12 look-alikes (TBTC, CBBTC, WBTC, LBTC …).
// @facts        Never fuzzy-match (docs/FACTS.md#pyth-oracle [D5]).
// @facts      ★ STALENESS GUARD: reject when `nowMs - publishTimeMs > cfg.pyth.maxStalenessMs`
// @facts        (default 60_000). A stale price must fail closed ⇒ `noop`, never a guess.
// @facts      ★★ NAV/COLLATERAL IS VALUED AT THE DEEPBOOK MID, NOT THIS PRICE (G9). Pyth is the
// @facts        DIVERGENCE reference only. hBTC can depeg below BTC on the thin book; valuing at
// @facts        raw Pyth would silently over-value the vault exactly when it matters.
// @facts      PIN THE VERSIONS: cfg.pyth.stateId / packageId / wormholeStateId. The Pyth DAO
// @facts        auto-upgrades Sui addresses on 2026-08-18 — an unpinned build breaks that day.
// @facts        Shared-object refs for a PTB: Pyth State initialSharedVersion 12041355,
// @facts        Wormhole State initialSharedVersion 1451 (docs/FACTS.md#pyth-oracle).
// @facts      ⚠ NO on-chain Pyth read is needed: MOVE-PACKAGE §4 takes `oracle_mid: u128` as a
// @facts        PARAMETER; nothing in Move calls Pyth (docs/RECON.md R3). This module is the whole
// @facts        Pyth surface, and it is off-chain.
// @facts      ⚠ `@pythnetwork/pyth-sui-js` is NOT an installed dependency — read Hermes over plain
// @facts        HTTPS with the global fetch (see @blocked in the T2.8 handover).
// @facts      Hermes shape: `GET {hermes}/v2/updates/price/latest?ids[]=<feedId>` →
// @facts        { parsed: [{ id, price: { price, conf, expo, publish_time /* SECONDS */ }, … }] }.
// @facts        `price` and `conf` are decimal STRINGS ⇒ BigInt(...), never parseInt/Number.
// @facts        `publish_time` is SECONDS ⇒ ×1000 at the boundary.
// @implements export interface PythPrice / PythReadOptions
// @implements export async function fetchLatestPrice(cfg: Config, opts?: PythReadOptions): Promise<PythPrice>
// @implements export function assertFresh(cfg: Config, price: PythPrice, nowMs: Millis): PythPrice
// @implements export function scaleToSats(price: PythPrice, hbtcDecimals: number): bigint
// @implements export function isBetaFeed(cfg: Config): boolean
// @forbidden  a hardcoded feed id / Hermes URL — G7, gates.ps1 ids (config.ts is the only home)
// @forbidden  shipping the stable/mainnet feed id on testnet (G9)
// @forbidden  valuing NAV or collateral at this price instead of the DeepBook mid (G9)
// @forbidden  parseInt/Number on a Hermes numeric string — precision loss on u64 fields
// @invariant  1. A price older than cfg.pyth.maxStalenessMs is REJECTED, never used.
// @invariant  2. All price fields are bigint; the exponent is the only `number`.
// @invariant  3. `nowMs` is an argument to the guard so the check is replayable.
// @invariant  4. The returned feed id always equals cfg.pyth.btcUsdFeedId — mismatch is an error.
// @ac         docs/KEEPER.md §13 A7 (with ./divergence.ts) — breaker trips on injected divergence
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Millis } from '../types.js';

/** One Pyth price reading, BETA channel. All money-ish fields are bigint. */
export interface PythPrice {
  /** Unscaled integer price; the real value is `price * 10^expo`. */
  readonly px: bigint;
  /** Confidence interval, same scaling as `px`. */
  readonly conf: bigint;
  /** Decimal exponent (typically negative). The ONLY `number` here. */
  readonly expo: number;
  /** Publish time in MILLISECONDS (Hermes reports seconds — converted at the boundary). */
  readonly publishTimeMs: Millis;
  /** Monotonic sequence/slot of the update, journaled for reproducibility. */
  readonly seq: bigint;
  /** Must equal cfg.pyth.btcUsdFeedId. */
  readonly feedId: string;
}

export interface PythReadOptions {
  /** Abort budget for the Hermes call, ms. */
  readonly timeoutMs?: Millis;
  /** Override the feed id (tests only — production always uses cfg.pyth.btcUsdFeedId). */
  readonly feedId?: string;
}

/** `true` iff the configured endpoint + feed id are the BETA pair required on testnet (G9). */
// TODO(T2.8): compare cfg.pyth.hermesEndpoint/btcUsdFeedId against the beta pair in TESTNET_DEFAULTS.
export function isBetaFeed(_cfg: Config): boolean {
  throw new Error('TODO(T2.8): isBetaFeed not implemented');
}

/** Fetch the latest BETA BTC/USD price from Hermes. No SDK — plain HTTPS. */
// TODO(T2.8): GET `${cfg.pyth.hermesEndpoint}/v2/updates/price/latest?ids[]=${feedId}`;
//             BigInt() the string fields; publish_time (s) × 1000; assert the returned id matches.
export async function fetchLatestPrice(
  _cfg: Config,
  _opts: PythReadOptions = {},
): Promise<PythPrice> {
  throw new Error('TODO(T2.8): fetchLatestPrice not implemented');
}

/**
 * Staleness guard. Fails CLOSED: a stale oracle must produce `noop`, never a guessed price.
 * `nowMs` is an argument so the guard is replayable by `verify/`.
 */
// TODO(T2.8): if (nowMs - price.publishTimeMs > cfg.pyth.maxStalenessMs) throw; else return price.
export function assertFresh(_cfg: Config, _price: PythPrice, _nowMs: Millis): PythPrice {
  throw new Error('TODO(T2.8): assertFresh not implemented');
}

/**
 * Convert a Pyth USD price into the keeper's sats-scaled fixed point for the DIVERGENCE check.
 *
 * ⚠ NOT for NAV: NAV and collateral are valued at the DeepBook mid (G9).
 */
// TODO(T2.8): apply 10^expo against the hBTC decimals; keep everything in bigint.
export function scaleToSats(_price: PythPrice, _hbtcDecimals: number): bigint {
  throw new Error('TODO(T2.8): scaleToSats not implemented');
}
