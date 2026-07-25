// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     DONE
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
// @facts        `parsed[].id` is UNPREFIXED hex; cfg ids are `0x`-prefixed ⇒ normalise before compare.
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

import { TESTNET_DEFAULTS, type Config } from '../config.js';
import type { Millis } from '../types.js';
import { AphoticError } from '../util/errors.js';

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

/**
 * The subset of `fetch` this module uses. Declared structurally so tests can inject a
 * deterministic transport — the whole vitest suite must run offline (vitest.config.ts).
 */
export type FetchLike = (input: string, init?: { readonly signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface PythReadOptions {
  /** Abort budget for the Hermes call, ms. */
  readonly timeoutMs?: Millis;
  /** Override the feed id (tests only — production always uses cfg.pyth.btcUsdFeedId). */
  readonly feedId?: string;
  /** Injected transport (tests only). Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

/**
 * The EXACT Pyth symbol for BTC/USD. `attributes.symbol` must match this string character for
 * character — the `btc/usd` query returns 12 look-alikes (TBTC, CBBTC, WBTC, LBTC …) and a fuzzy
 * match silently prices the vault off the wrong asset (docs/FACTS.md#pyth-oracle [D5]).
 */
export const PYTH_BTC_USD_SYMBOL = 'Crypto.BTC/USD';

/** Default abort budget for a Hermes read. Kept well under one keeper tick. */
export const DEFAULT_HERMES_TIMEOUT_MS = 5_000;

/** Hermes/transport failure (non-2xx, unparseable body, feed absent from the response). */
export class HermesError extends AphoticError {
  readonly url: string;

  constructor(url: string, detail: string) {
    super('HermesError', `hermes read failed (${url}): ${detail}`);
    this.url = url;
  }
}

/**
 * The staleness rejection. Fails CLOSED — the caller must turn this into `noop`, never a guess.
 * Carries every input to the comparison so `verify/` can reproduce the decision (G5).
 */
export class StaleOracleError extends AphoticError {
  readonly publishTimeMs: Millis;
  readonly nowMs: Millis;
  readonly ageMs: Millis;
  readonly maxStalenessMs: Millis;

  constructor(publishTimeMs: Millis, nowMs: Millis, maxStalenessMs: Millis) {
    const ageMs = nowMs - publishTimeMs;
    super(
      'OracleStale',
      `pyth price is stale: published ${publishTimeMs}ms, now ${nowMs}ms ` +
        `(age ${ageMs}ms > max ${maxStalenessMs}ms)`,
    );
    this.publishTimeMs = publishTimeMs;
    this.nowMs = nowMs;
    this.ageMs = ageMs;
    this.maxStalenessMs = maxStalenessMs;
  }
}

/** Lower-case, `0x`-stripped hex — Hermes returns ids unprefixed, config stores them prefixed. */
export function normalizeFeedId(feedId: string): string {
  const lower = feedId.trim().toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/**
 * `true` iff the configured endpoint + feed id are the BETA pair required on testnet (G9).
 *
 * The reference values are read from `TESTNET_DEFAULTS` — config.ts is the only place either
 * literal may appear (G7, `gates.ps1 ids`).
 */
export function isBetaFeed(cfg: Config): boolean {
  const endpointMatches =
    stripTrailingSlash(cfg.pyth.hermesEndpoint) === stripTrailingSlash(TESTNET_DEFAULTS.hermesEndpoint);
  const feedMatches = normalizeFeedId(cfg.pyth.btcUsdFeedId) === normalizeFeedId(TESTNET_DEFAULTS.pythBtcUsdFeedId);
  return endpointMatches && feedMatches;
}

/**
 * Fetch the latest BETA BTC/USD price from Hermes. No SDK — plain HTTPS.
 *
 * Invariant 4: the id echoed back by Hermes must equal the id we asked for, else we throw. A
 * silently-substituted feed would price the vault off a look-alike asset.
 */
export async function fetchLatestPrice(cfg: Config, opts: PythReadOptions = {}): Promise<PythPrice> {
  const feedId = opts.feedId ?? cfg.pyth.btcUsdFeedId;
  const url =
    `${stripTrailingSlash(cfg.pyth.hermesEndpoint)}/v2/updates/price/latest` +
    `?ids[]=${normalizeFeedId(feedId)}&parsed=true&encoding=hex`;

  const body = await getJson(url, opts);
  const parsed = (body as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed)) {
    throw new HermesError(url, 'response has no `parsed` array');
  }

  const want = normalizeFeedId(feedId);
  const entry = parsed.find(
    (e): e is HermesParsedEntry => isRecord(e) && typeof e.id === 'string' && normalizeFeedId(e.id) === want,
  );
  if (entry === undefined) {
    // Invariant 4 — never fall back to "whatever came back first".
    throw new HermesError(url, `feed ${want} absent from the response (got ${parsed.length} entr(y|ies))`);
  }

  const price = entry.price;
  if (!isRecord(price)) {
    throw new HermesError(url, `feed ${want} has no \`price\` object`);
  }

  return Object.freeze({
    // `price`/`conf` are decimal STRINGS — BigInt(), never parseInt/Number (u64 precision).
    px: toBigInt(url, 'price.price', price.price),
    conf: toBigInt(url, 'price.conf', price.conf),
    expo: toInt(url, 'price.expo', price.expo),
    // Hermes reports `publish_time` in SECONDS.
    publishTimeMs: Number(toBigInt(url, 'price.publish_time', price.publish_time) * 1000n),
    seq: readSeq(url, entry),
    feedId,
  });
}

/**
 * Staleness guard. Fails CLOSED: a stale oracle must produce `noop`, never a guessed price.
 * `nowMs` is an argument so the guard is replayable by `verify/`.
 *
 * A price published in the FUTURE by more than the same budget is rejected too — that is clock
 * skew or a spoofed timestamp, and either way the reading is not trustworthy.
 */
export function assertFresh(cfg: Config, price: PythPrice, nowMs: Millis): PythPrice {
  if (isStale(cfg, price.publishTimeMs, nowMs)) {
    throw new StaleOracleError(price.publishTimeMs, nowMs, cfg.pyth.maxStalenessMs);
  }
  return price;
}

/**
 * The single staleness predicate. `divergence.ts` shares it so there is exactly one definition of
 * "too old" on the trading path.
 */
export function isStale(cfg: Config, publishTimeMs: Millis, nowMs: Millis): boolean {
  const ageMs = nowMs - publishTimeMs;
  return ageMs > cfg.pyth.maxStalenessMs || -ageMs > cfg.pyth.maxStalenessMs;
}

/**
 * Convert a Pyth USD price into the keeper's sats-scaled fixed point for the DIVERGENCE check.
 *
 * Result unit: **USD per 1 BTC, carrying `hbtcDecimals` fractional digits.**
 *   value = px · 10^expo · 10^hbtcDecimals
 * e.g. px = 10_000_000_000_000, expo = -8, hbtcDecimals = 8 ⇒ $100_000.00 ⇒ 10_000_000_000_000n.
 *
 * Division truncates toward zero (bigint `/`), which is the deterministic, replayable choice.
 *
 * ⚠ NOT for NAV: NAV and collateral are valued at the DeepBook mid (G9). hBTC can trade below BTC
 * on the thin testnet book, and this number would hide exactly that.
 */
export function scaleToSats(price: PythPrice, hbtcDecimals: number): bigint {
  const exp = price.expo + hbtcDecimals;
  if (exp >= 0) return price.px * 10n ** BigInt(exp);
  return price.px / 10n ** BigInt(-exp);
}

/**
 * Resolve a feed id from the Hermes catalogue by EXACT symbol match.
 *
 * Encodes docs/FACTS.md#pyth-oracle [D5]: the `btc/usd` query returns 12 look-alike feeds, so the
 * only safe filter is `attributes.symbol === PYTH_BTC_USD_SYMBOL`, character for character.
 * Operational tool (id verification); the trading path always reads `cfg.pyth.btcUsdFeedId`.
 */
export async function resolveFeedIdBySymbol(
  cfg: Config,
  symbol: string = PYTH_BTC_USD_SYMBOL,
  opts: PythReadOptions = {},
): Promise<string> {
  const url = `${stripTrailingSlash(cfg.pyth.hermesEndpoint)}/v2/price_feeds?query=${encodeURIComponent(symbol)}`;
  const body = await getJson(url, opts);
  if (!Array.isArray(body)) {
    throw new HermesError(url, 'price_feeds response is not an array');
  }

  const hit = body.find(
    (e): e is { id: string } =>
      isRecord(e) &&
      typeof e.id === 'string' &&
      isRecord(e.attributes) &&
      // EXACT, never `includes`/`toLowerCase` — that is how you end up pricing TBTC.
      e.attributes.symbol === symbol,
  );
  if (hit === undefined) {
    throw new HermesError(url, `no feed with attributes.symbol === ${JSON.stringify(symbol)}`);
  }
  return `0x${normalizeFeedId(hit.id)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────────────

interface HermesParsedEntry {
  readonly id: string;
  readonly price?: unknown;
  readonly metadata?: unknown;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function getJson(url: string, opts: PythReadOptions): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (doFetch === undefined) {
    throw new HermesError(url, 'no fetch implementation available (Node >= 18 or opts.fetchImpl)');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_HERMES_TIMEOUT_MS;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new HermesError(url, `transport error: ${String(cause)}`);
  }

  if (!response.ok) {
    throw new HermesError(url, `HTTP ${response.status}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HermesError(url, `body is not JSON (${text.slice(0, 120)})`);
  }
}

/** Accepts a decimal string or a JSON number; rejects anything else. Never `parseInt`. */
function toBigInt(url: string, field: string, value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new HermesError(url, `${field} is not an integer (${JSON.stringify(value)})`);
}

function toInt(url: string, field: string, value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  throw new HermesError(url, `${field} is not an integer (${JSON.stringify(value)})`);
}

/**
 * Monotonic update identifier, journaled so a replay pins the exact update.
 * Prefer `metadata.slot`; fall back to the publish time when Hermes omits metadata.
 */
function readSeq(url: string, entry: HermesParsedEntry): bigint {
  const metadata = entry.metadata;
  if (isRecord(metadata) && metadata.slot !== undefined && metadata.slot !== null) {
    return toBigInt(url, 'metadata.slot', metadata.slot);
  }
  const price = entry.price;
  if (isRecord(price)) {
    return toBigInt(url, 'price.publish_time', price.publish_time);
  }
  throw new HermesError(url, 'no metadata.slot and no price.publish_time to sequence on');
}
