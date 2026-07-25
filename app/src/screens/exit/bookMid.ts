// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.3 (book_mid is a PTB argument, therefore auditable)
// @spec       docs/GOLDEN-RULES.md G9 (Pyth BETA on testnet · staleness guards)
// @spec       move/sources/vault.move nav_sats (v3: the EZeroNav guard moved INSIDE
//             the `quote != 0` branch, so a base-only vault values with no price)
// @rules      G7 G9 G10
// @depends    ../../config.ts (T0.4)
// @facts      DeepBook v3 FLOAT_SCALING = 1e9 and prices satisfy
// @facts        `quote_raw = base_raw * price / 1e9`   (vault.move L174-L177)
// @facts      hBTC has 8 decimals (RECON R5); DBUSDC has 6 (coin metadata read
// @facts        2026-07-25: {"decimals":6,"symbol":"DBUSDC"}).
// @facts      ⇒ book_mid = usd_per_btc × 10^(9 + 6 − 8) = usd_per_btc × 1e7.
// @facts        Pyth reports (price, expo) with price × 10^expo = usd, so
// @facts        book_mid = price × 10^(expo + 9 + QUOTE_DEC − BASE_DEC).
// @facts      Pyth BETA-channel BTC/USD feed id lives in config.pyth.feedId (G9).
// @facts        The stable/mainnet id is NEVER valid on testnet.
// @facts      ⚠ This is a PYTH-DERIVED mid, not a DeepBook mid. The hBTC/DBUSDC book
// @facts        is empty on BOTH sides, so `pool::mid_price` aborts EEmptyOrderbook
// @facts        and there is no book mid to read. It is labelled as such everywhere it
// @facts        is rendered — G9 forbids VALUING at raw Pyth, and this value is not
// @facts        load-bearing today: the vault holds zero DBUSDC, so nav_sats returns
// @facts        free_btc_sats and never divides by it. It becomes load-bearing only
// @facts        once a quote leg exists, at which point the book will exist too.
// @external   GET {hermesUrl}/v2/updates/price/latest?ids[]=<feed>&parsed=true
//               → { parsed: [{ price: { price, conf, expo, publish_time } }] }
// @implements export interface BookMidOk · export type BookMidReading
//             export function midFromPyth(price, expo): bigint
//             export function formatUsd(price, expo): string
//             export async function readBookMid(signal?): Promise<BookMidReading>
// @forbidden  a hardcoded feed id or hermes url — both come from config (G7)
// @forbidden  `number` arithmetic on the mid — bigint only (G10)
// @forbidden  presenting this as a DeepBook mid — it is not, and the copy says so (G9)
// @invariant  1. A reading older than STALE_AFTER_MS is reported `stale`, never
//                silently used as if fresh.
// @invariant  2. Every failure resolves to a rendered state; this never throws.
// @ac         docs/APP.md §7 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';

/** DeepBook v3 FLOAT_SCALING (vault.move DEEPBOOK_PRICE_SCALING). */
const FLOAT_SCALING_EXP = 9;
/** hBTC decimals — amounts are sats. */
const BASE_DECIMALS = 8;
/** DBUSDC decimals, read from coin metadata on testnet. */
const QUOTE_DECIMALS = 6;

/** Beyond this the reading is presented as stale rather than used silently (G9). */
export const STALE_AFTER_MS = 60_000;

export interface BookMidOk {
  readonly status: 'ok' | 'stale';
  /** u128, DeepBook FLOAT_SCALING. What the PTB carries as `book_mid`. */
  readonly mid: bigint;
  /** Human BTC/USD, e.g. `64,225.49`. */
  readonly usd: string;
  readonly publishedAtMs: number;
  readonly ageMs: number;
}

export type BookMidReading = BookMidOk | { readonly status: 'unavailable'; readonly reason: string };

/**
 * `book_mid = price × 10^(expo + FLOAT_SCALING_EXP + QUOTE_DECIMALS − BASE_DECIMALS)`.
 *
 * Integer-only: a negative exponent divides, it never touches a float.
 */
export function midFromPyth(price: bigint, expo: number): bigint {
  const e = expo + FLOAT_SCALING_EXP + QUOTE_DECIMALS - BASE_DECIMALS;
  if (e >= 0) return price * 10n ** BigInt(e);
  return price / 10n ** BigInt(-e);
}

/** `64,225.49` from Pyth's (price, expo) pair. No floating point. */
export function formatUsd(price: bigint, expo: number): string {
  const decimals = expo < 0 ? -expo : 0;
  const scale = 10n ** BigInt(decimals);
  const scaled = expo >= 0 ? price * 10n ** BigInt(expo) : price;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(decimals, '0').slice(0, 2);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals === 0 ? grouped : `${grouped}.${frac}`;
}

interface HermesPrice {
  price: string;
  expo: number;
  publish_time: number;
}

function firstParsed(payload: unknown): HermesPrice | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const parsed = (payload as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entry = parsed[0] as { price?: unknown };
  const price = entry.price;
  if (typeof price !== 'object' || price === null) return null;
  const p = price as Partial<HermesPrice>;
  if (typeof p.price !== 'string' || typeof p.expo !== 'number' || typeof p.publish_time !== 'number') {
    return null;
  }
  return { price: p.price, expo: p.expo, publish_time: p.publish_time };
}

/**
 * Read the Pyth **Beta**-channel BTC/USD price and convert it to the u128
 * `book_mid` the Move entry points take. Never throws.
 */
export async function readBookMid(signal?: AbortSignal): Promise<BookMidReading> {
  const feed = config.pyth.feedId;
  const base = config.pyth.hermesUrl.replace(/\/+$/, '');
  if (feed.length === 0 || base.length === 0) {
    return { status: 'unavailable', reason: 'No Pyth feed configured (VITE_PYTH_FEED_ID / VITE_PYTH_HERMES_URL).' };
  }

  const url = `${base}/v2/updates/price/latest?ids%5B%5D=${encodeURIComponent(feed)}&parsed=true&encoding=hex`;

  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      return { status: 'unavailable', reason: `Pyth Hermes (beta) answered HTTP ${response.status}.` };
    }
    const price = firstParsed(await response.json());
    if (price === null) {
      return { status: 'unavailable', reason: 'Pyth Hermes returned no parsed price for this feed id.' };
    }

    const publishedAtMs = price.publish_time * 1000;
    const ageMs = Math.max(0, Date.now() - publishedAtMs);
    return {
      status: ageMs > STALE_AFTER_MS ? 'stale' : 'ok',
      mid: midFromPyth(BigInt(price.price), price.expo),
      usd: formatUsd(BigInt(price.price), price.expo),
      publishedAtMs,
      ageMs,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', reason: `Could not reach Pyth Hermes (beta): ${reason}` };
  }
}
