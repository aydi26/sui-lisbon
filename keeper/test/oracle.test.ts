// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     DONE
// @spec       docs/KEEPER.md §6 (Pyth Beta + staleness guard + DeepBook TWAP divergence breaker)
// @spec       docs/KEEPER.md §13 A7 (breaker trips on injected divergence ⇒ noop)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.8) · docs/FACTS.md#pyth-oracle · docs/RECON.md#r11
// @rules      G7 G9
// @depends    ../src/oracle/{pyth,twap,divergence,index}.ts (T2.8) · ../src/config.ts
// @facts      ⚠ NO canonical ID LITERAL may appear in this file (G7, gates.ps1 ids). The Beta feed
// @facts        id and the Hermes endpoint are read from TESTNET_DEFAULTS, never pasted.
// @facts      ⚠ NO NETWORK. Hermes is exercised through an injected `fetchImpl`; the book through
// @facts        an injected `readBookImpl` (vitest.config.ts forbids sockets).
// @facts      ⚠ NO WALL CLOCK. Every `nowMs` is a literal logical timestamp.
// @implements staleness rejection · divergence trip/reset with hysteresis · fixed-point scaling
//             (BTC/USD → sats fixed point, DeepBook price → the same scale) · empty-book behaviour
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { TESTNET_DEFAULTS, loadConfig, type Config } from '../src/config.js';
import {
  DEEPBOOK_FLOAT_SCALING_EXP,
  HermesError,
  MAX_DIVERGENCE_BPS,
  ORACLE_DIVERGENCE_CAUSE,
  OracleDivergenceError,
  OracleUnavailableError,
  PYTH_BTC_USD_SYMBOL,
  StaleOracleError,
  assertFresh,
  assertNoDivergence,
  createBreaker,
  createTwapWindow,
  deepbookPriceToUsdFixed,
  divergenceBps,
  fetchLatestPrice,
  isBetaFeed,
  isDivergent,
  isStale,
  normalizeFeedId,
  pushSample,
  read,
  recoveryMs,
  resetBps,
  resolveFeedIdBySymbol,
  scaleToSats,
  stepBreaker,
  tick,
  twap,
  type FetchLike,
  type MidSample,
  type OracleDeps,
  type PythPrice,
} from '../src/oracle/index.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { L2Book, Millis, OracleSnapshot } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — all logical, all offline
// ─────────────────────────────────────────────────────────────────────────────

const CFG: Config = loadConfig({});

/** A logical wall-clock instant. Nothing in these tests reads a real clock. */
const T0: Millis = 1_800_000_000_000;

/** $100_000.00 with hBTC's 8 decimals of fixed point. */
const USD_100K_FIXED = 10_000_000_000_000n;

function pythPrice(overrides: Partial<PythPrice> = {}): PythPrice {
  return {
    // 10_000_000_000_000 × 10^-8 = $100_000
    px: 10_000_000_000_000n,
    conf: 5_000_000_000n,
    expo: -8,
    publishTimeMs: T0,
    seq: 42n,
    feedId: CFG.pyth.btcUsdFeedId,
    ...overrides,
  };
}

/** Raw DeepBook u64 price for a given whole-dollar BTC price (hBTC 8 dec / DBUSDC 6 dec). */
function dbPriceForUsd(usd: bigint): bigint {
  // quote_raw = base_raw · price / 1e9  ⇒  price = usd · 10^(qDec − bDec + 9) = usd · 10^7
  return usd * 10n ** BigInt(CFG.deepbook.dbusdcDecimals - CFG.hashi.hbtcDecimals + DEEPBOOK_FLOAT_SCALING_EXP);
}

function book(mid: bigint, atMs: Millis = T0): L2Book {
  return { poolId: CFG.deepbook.poolId, bids: [], asks: [], mid, atMs };
}

function snapshot(overrides: Partial<OracleSnapshot> = {}): OracleSnapshot {
  return {
    pythPx: USD_100K_FIXED,
    pythSeq: 42n,
    pythPublishTimeMs: T0,
    deepbookTwap: USD_100K_FIXED,
    deepbookMid: USD_100K_FIXED,
    ...overrides,
  };
}

/** A `fetch` stand-in that returns a canned body. Never opens a socket. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): FetchLike {
  return async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function hermesBody(feedId: string, price: Record<string, unknown>, slot = 1_234n): unknown {
  return {
    parsed: [
      {
        // Hermes echoes ids UNPREFIXED — the parser must normalise.
        id: normalizeFeedId(feedId),
        price,
        ema_price: price,
        metadata: { slot: Number(slot), proof_available_time: 1, prev_publish_time: 1 },
      },
    ],
  };
}

const FAKE_CLIENT = {} as AnySuiClient;

function oracleDeps(over: {
  price?: PythPrice;
  bookMid?: bigint;
  throwOnBook?: Error;
}): OracleDeps {
  return {
    cfg: CFG,
    deepbook: { cfg: CFG, client: FAKE_CLIENT },
    fetchPriceImpl: async () => over.price ?? pythPrice(),
    readBookImpl: async (_deps, opts) => {
      if (over.throwOnBook) throw over.throwOnBook;
      return book(over.bookMid ?? dbPriceForUsd(100_000n), opts.atMs);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G9 — the BETA channel is the only acceptable testnet configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('pyth — G9 beta-channel guard', () => {
  it('recognises the configured testnet pair as the BETA feed', () => {
    expect(isBetaFeed(CFG)).toBe(true);
    // Cross-check against config.ts (the only sanctioned home for the literal, G7).
    expect(CFG.pyth.hermesEndpoint).toBe(TESTNET_DEFAULTS.hermesEndpoint);
    expect(CFG.pyth.btcUsdFeedId).toBe(TESTNET_DEFAULTS.pythBtcUsdFeedId);
    expect(CFG.pyth.hermesEndpoint).toContain('beta');
  });

  it('rejects a non-beta endpoint or a substituted feed id', () => {
    const wrongEndpoint = loadConfig({ HERMES_ENDPOINT: 'https://hermes.pyth.network' });
    expect(isBetaFeed(wrongEndpoint)).toBe(false);

    const wrongFeed = loadConfig({ PYTH_BTC_USD_FEED_ID: `0x${'ab'.repeat(32)}` });
    expect(isBetaFeed(wrongFeed)).toBe(false);
  });

  it('normalises feed ids so a 0x-prefixed config value matches an unprefixed Hermes id', () => {
    const withPrefix = CFG.pyth.btcUsdFeedId;
    const without = normalizeFeedId(withPrefix);
    expect(without.startsWith('0x')).toBe(false);
    expect(normalizeFeedId(without)).toBe(without);
    expect(normalizeFeedId(withPrefix.toUpperCase())).toBe(without);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hermes parsing — decimal STRINGS, seconds → ms, invariant 4
// ─────────────────────────────────────────────────────────────────────────────

describe('pyth — Hermes read (offline, injected transport)', () => {
  const publishTimeSecs = 1_800_000_000;

  it('parses decimal-string price fields into bigint and seconds into milliseconds', async () => {
    const fetchImpl = stubFetch(
      hermesBody(CFG.pyth.btcUsdFeedId, {
        price: '10000000000000',
        conf: '5000000000',
        expo: -8,
        publish_time: publishTimeSecs,
      }),
    );

    const price = await fetchLatestPrice(CFG, { fetchImpl });

    expect(price.px).toBe(10_000_000_000_000n);
    expect(typeof price.px).toBe('bigint');
    expect(price.conf).toBe(5_000_000_000n);
    expect(price.expo).toBe(-8);
    expect(price.publishTimeMs).toBe(publishTimeSecs * 1000);
    expect(price.seq).toBe(1_234n);
    expect(price.feedId).toBe(CFG.pyth.btcUsdFeedId);
  });

  it('never loses precision on a u64-scale price string (the parseInt trap)', async () => {
    const huge = '18446744073709551615'; // u64::MAX — Number() would round this
    const fetchImpl = stubFetch(
      hermesBody(CFG.pyth.btcUsdFeedId, { price: huge, conf: '1', expo: -8, publish_time: publishTimeSecs }),
    );

    const price = await fetchLatestPrice(CFG, { fetchImpl });
    expect(price.px).toBe(18_446_744_073_709_551_615n);
    expect(price.px.toString()).toBe(huge);
  });

  it('builds the request against the configured BETA endpoint and feed id (G7 — no literals)', async () => {
    let seen = '';
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            hermesBody(CFG.pyth.btcUsdFeedId, {
              price: '1',
              conf: '0',
              expo: -8,
              publish_time: publishTimeSecs,
            }),
          ),
      };
    };

    await fetchLatestPrice(CFG, { fetchImpl });
    expect(seen.startsWith(CFG.pyth.hermesEndpoint)).toBe(true);
    expect(seen).toContain('/v2/updates/price/latest');
    expect(seen).toContain(normalizeFeedId(CFG.pyth.btcUsdFeedId));
  });

  it('THROWS when Hermes answers with a different feed id (invariant 4 — no silent substitution)', async () => {
    const otherFeed = `0x${'cd'.repeat(32)}`;
    const fetchImpl = stubFetch(
      hermesBody(otherFeed, { price: '1', conf: '0', expo: -8, publish_time: publishTimeSecs }),
    );

    await expect(fetchLatestPrice(CFG, { fetchImpl })).rejects.toBeInstanceOf(HermesError);
  });

  it('throws on a non-2xx response and on a non-JSON body', async () => {
    await expect(fetchLatestPrice(CFG, { fetchImpl: stubFetch('', { ok: false, status: 503 }) })).rejects.toThrow(
      /HTTP 503/,
    );
    await expect(fetchLatestPrice(CFG, { fetchImpl: stubFetch('<html>nope</html>') })).rejects.toThrow(
      /not JSON/,
    );
  });

  it('resolves a feed by EXACT symbol and refuses the look-alikes (docs/FACTS.md D5)', async () => {
    const target = CFG.pyth.btcUsdFeedId;
    const catalogue = [
      { id: normalizeFeedId(`0x${'11'.repeat(32)}`), attributes: { symbol: 'Crypto.TBTC/USD' } },
      { id: normalizeFeedId(`0x${'22'.repeat(32)}`), attributes: { symbol: 'Crypto.WBTC/USD' } },
      { id: normalizeFeedId(target), attributes: { symbol: PYTH_BTC_USD_SYMBOL } },
      { id: normalizeFeedId(`0x${'33'.repeat(32)}`), attributes: { symbol: 'Crypto.CBBTC/USD' } },
    ];

    const resolved = await resolveFeedIdBySymbol(CFG, PYTH_BTC_USD_SYMBOL, { fetchImpl: stubFetch(catalogue) });
    expect(normalizeFeedId(resolved)).toBe(normalizeFeedId(target));

    const lookAlikesOnly = catalogue.filter((f) => f.attributes.symbol !== PYTH_BTC_USD_SYMBOL);
    await expect(
      resolveFeedIdBySymbol(CFG, PYTH_BTC_USD_SYMBOL, { fetchImpl: stubFetch(lookAlikesOnly) }),
    ).rejects.toBeInstanceOf(HermesError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Staleness — invariant 1, fail closed
// ─────────────────────────────────────────────────────────────────────────────

describe('pyth — staleness guard (fails CLOSED)', () => {
  const max = CFG.pyth.maxStalenessMs;

  it('accepts a price exactly at the staleness boundary', () => {
    const price = pythPrice({ publishTimeMs: T0 - max });
    expect(assertFresh(CFG, price, T0)).toBe(price);
    expect(isStale(CFG, price.publishTimeMs, T0)).toBe(false);
  });

  it('REJECTS a price one millisecond past the boundary, carrying the replay inputs', () => {
    const price = pythPrice({ publishTimeMs: T0 - max - 1 });
    expect(() => assertFresh(CFG, price, T0)).toThrowError(StaleOracleError);

    try {
      assertFresh(CFG, price, T0);
      expect.unreachable('assertFresh must throw on a stale price');
    } catch (err) {
      const e = err as StaleOracleError;
      expect(e.code).toBe('OracleStale');
      expect(e.ageMs).toBe(max + 1);
      expect(e.maxStalenessMs).toBe(max);
      expect(e.nowMs).toBe(T0);
      expect(e.publishTimeMs).toBe(T0 - max - 1);
    }
  });

  it('REJECTS a price timestamped in the future beyond the same budget (clock skew / spoof)', () => {
    expect(() => assertFresh(CFG, pythPrice({ publishTimeMs: T0 + max + 1 }), T0)).toThrowError(StaleOracleError);
    // Small forward skew inside the budget is tolerated.
    expect(() => assertFresh(CFG, pythPrice({ publishTimeMs: T0 + 1 }), T0)).not.toThrow();
  });

  it('honours an overridden PYTH_MAX_STALENESS_MS', () => {
    const strict = loadConfig({ PYTH_MAX_STALENESS_MS: '1000' });
    expect(isStale(strict, T0 - 999, T0)).toBe(false);
    expect(isStale(strict, T0 - 1001, T0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixed-point scaling — BTC/USD → sats-scaled fixed point
// ─────────────────────────────────────────────────────────────────────────────

describe('pyth — fixed-point scaling (bigint only, no floats)', () => {
  it('scales a negative-exponent price into hBTC-decimal fixed point', () => {
    // $100_000 at expo -8, 8 decimals ⇒ 100_000 × 10^8
    expect(scaleToSats(pythPrice(), CFG.hashi.hbtcDecimals)).toBe(USD_100K_FIXED);
    expect(scaleToSats(pythPrice(), CFG.hashi.hbtcDecimals)).toBe(100_000n * 10n ** 8n);
  });

  it('handles expo + decimals == 0 (identity) and a positive net exponent (multiply)', () => {
    expect(scaleToSats(pythPrice({ px: 7n, expo: -CFG.hashi.hbtcDecimals }), CFG.hashi.hbtcDecimals)).toBe(7n);
    expect(scaleToSats(pythPrice({ px: 7n, expo: -6 }), CFG.hashi.hbtcDecimals)).toBe(700n);
  });

  it('handles a negative net exponent by truncating division, never by a float', () => {
    // expo -12 with 8 decimals ⇒ divide by 10^4; 123_456_789 / 10_000 = 12_345 (truncated)
    expect(scaleToSats(pythPrice({ px: 123_456_789n, expo: -12 }), CFG.hashi.hbtcDecimals)).toBe(12_345n);
  });

  it('scales a raw DeepBook u64 price to the SAME fixed point (so divergence is comparable)', () => {
    // DeepBook v3: quote_raw = base_raw · price / 1e9  (deepbook/math.move)
    expect(deepbookPriceToUsdFixed(CFG, dbPriceForUsd(100_000n))).toBe(USD_100K_FIXED);
    expect(deepbookPriceToUsdFixed(CFG, dbPriceForUsd(97_500n))).toBe(97_500n * 10n ** 8n);
    // Both sides of the breaker land on the same number for the same economic price.
    expect(deepbookPriceToUsdFixed(CFG, dbPriceForUsd(100_000n))).toBe(
      scaleToSats(pythPrice(), CFG.hashi.hbtcDecimals),
    );
  });

  it('pins the DeepBook exponent to the value verified in the pinned dependency source', () => {
    expect(DEEPBOOK_FLOAT_SCALING_EXP).toBe(9);
    // exponent = 2·bDec − qDec − 9 = 2·8 − 6 − 9 = +1
    expect(deepbookPriceToUsdFixed(CFG, 1n)).toBe(10n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TWAP — dwell-time weighting, window exclusion, empty book
// ─────────────────────────────────────────────────────────────────────────────

describe('twap — time-weighted DeepBook mid', () => {
  const W = 300_000;

  it('creates an empty window and returns undefined for it (invariant 4 — never 0n)', () => {
    const w = createTwapWindow(W);
    expect(w.windowMs).toBe(W);
    expect(w.samples).toEqual([]);
    expect(twap(w.samples, W, T0)).toBeUndefined();
  });

  it('weights by DWELL TIME, not by sample count', () => {
    // 100 held for 240s, then 200 held for 60s ⇒ (100·240 + 200·60)/300 = 120
    const samples: MidSample[] = [
      { atMs: T0 - 300_000, mid: 100n },
      { atMs: T0 - 60_000, mid: 200n },
    ];
    expect(twap(samples, W, T0)).toBe(120n);

    // A burst of five identical samples in the last 4 seconds must NOT drag the average to 200.
    const bursty: MidSample[] = [
      { atMs: T0 - 300_000, mid: 100n },
      { atMs: T0 - 4_000, mid: 200n },
      { atMs: T0 - 3_000, mid: 200n },
      { atMs: T0 - 2_000, mid: 200n },
      { atMs: T0 - 1_000, mid: 200n },
    ];
    const bursted = twap(bursty, W, T0);
    expect(bursted).toBeDefined();
    // Sample-count averaging would give 180; dwell weighting gives ≈101.
    expect(bursted).toBe(101n);
  });

  it('excludes samples outside [now − window, now] (invariant 2)', () => {
    const samples: MidSample[] = [
      { atMs: T0 - 900_000, mid: 999n }, // far older than the window
      { atMs: T0 - 200_000, mid: 100n },
      { atMs: T0 + 5_000, mid: 500n }, // in the future
    ];
    // Only the 100n sample participates; it dwells the whole measured span.
    expect(twap(samples, W, T0)).toBe(100n);
  });

  it('returns undefined when every sample fell out of the window (empty book, R10)', () => {
    const samples: MidSample[] = [{ atMs: T0 - 900_000, mid: 100n }];
    expect(twap(samples, W, T0)).toBeUndefined();
  });

  it('returns the newest observation when all samples collapse onto one instant', () => {
    const samples: MidSample[] = [
      { atMs: T0, mid: 100n },
      { atMs: T0, mid: 300n },
    ];
    expect(twap(samples, W, T0)).toBe(300n);
  });

  it('pushSample is immutable, keeps ascending order and evicts stale samples', () => {
    const w0 = createTwapWindow(W);
    const w1 = pushSample(w0, { atMs: T0 - 400_000, mid: 50n });
    const w2 = pushSample(w1, { atMs: T0 - 100_000, mid: 100n });
    const w3 = pushSample(w2, { atMs: T0, mid: 200n });

    expect(w0.samples).toHaveLength(0); // invariant 1: no mutation
    expect(w1.samples).toHaveLength(1);
    expect(w3.samples.map((s) => s.atMs)).toEqual([T0 - 100_000, T0]); // 400s-old sample evicted
    expect(w3.samples.map((s) => s.mid)).toEqual([100n, 200n]);
  });

  it('ignores non-positive mids — absence of a price is not the price 0', () => {
    const samples: MidSample[] = [
      { atMs: T0 - 200_000, mid: 0n },
      { atMs: T0 - 100_000, mid: 100n },
    ];
    expect(twap(samples, W, T0)).toBe(100n);
    expect(twap([{ atMs: T0 - 100_000, mid: 0n }], W, T0)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Divergence — bigint-exact bps, fail closed
// ─────────────────────────────────────────────────────────────────────────────

describe('divergence — bigint-exact bps', () => {
  it('computes bps exactly, symmetrically in magnitude', () => {
    expect(divergenceBps(10_000n, 10_000n)).toBe(0);
    expect(divergenceBps(10_000n, 9_800n)).toBe(200); // 2% below
    expect(divergenceBps(10_000n, 10_200n)).toBe(200); // 2% above
    expect(divergenceBps(USD_100K_FIXED, (USD_100K_FIXED * 9_700n) / 10_000n)).toBe(300);
  });

  it('truncates rather than rounding — deterministic and replayable', () => {
    // 1 / 10_000 = 1bps exactly; 1 / 10_001 truncates to 0bps.
    expect(divergenceBps(10_000n, 9_999n)).toBe(1);
    expect(divergenceBps(10_001n, 10_000n)).toBe(0);
  });

  it('treats a zero/absent price on either side as MAXIMUM divergence (invariant 2)', () => {
    expect(divergenceBps(0n, 10_000n)).toBe(MAX_DIVERGENCE_BPS);
    expect(divergenceBps(10_000n, 0n)).toBe(MAX_DIVERGENCE_BPS);
    expect(divergenceBps(-1n, 10_000n)).toBe(MAX_DIVERGENCE_BPS);
  });

  it('isDivergent flags exactly the readings above the configured limit', () => {
    const limit = CFG.pyth.divergenceBps; // 200 by default
    expect(limit).toBe(TESTNET_DEFAULTS.oracleDivergenceBps);

    const atLimit = snapshot({ deepbookTwap: (USD_100K_FIXED * BigInt(10_000 - limit)) / 10_000n });
    expect(isDivergent(CFG, atLimit)).toBe(false); // strictly greater trips

    const past = snapshot({ deepbookTwap: (USD_100K_FIXED * BigInt(10_000 - limit - 1)) / 10_000n });
    expect(isDivergent(CFG, past)).toBe(true);
  });
});

describe('divergence — assertNoDivergence (A7: trips ⇒ evaluate returns noop)', () => {
  it('passes a tight, fresh reading', () => {
    expect(() => assertNoDivergence(CFG, snapshot(), T0)).not.toThrow();
  });

  it('THROWS OracleDivergenceError on an injected hBTC depeg, carrying both prices (G5 replay)', () => {
    // hBTC trading 5% under BTC on the thin book — exactly the G9 depeg case.
    const depeg = snapshot({ deepbookTwap: (USD_100K_FIXED * 95n) / 100n });

    try {
      assertNoDivergence(CFG, depeg, T0);
      expect.unreachable('the breaker must trip on a 5% depeg with a 200bps limit');
    } catch (err) {
      expect(err).toBeInstanceOf(OracleDivergenceError);
      const e = err as OracleDivergenceError;
      expect(e.code).toBe('OracleDivergence');
      expect(e.bps).toBe(500);
      expect(e.limitBps).toBe(CFG.pyth.divergenceBps);
      expect(e.referencePx).toBe(depeg.pythPx);
      expect(e.observedPx).toBe(depeg.deepbookTwap);
      // A verifier recomputes the same number straight from the journalled record.
      expect(divergenceBps(e.referencePx, e.observedPx)).toBe(e.bps);
    }
  });

  it('checks staleness BEFORE divergence — a stale reference fails closed', () => {
    const stale = snapshot({ pythPublishTimeMs: T0 - CFG.pyth.maxStalenessMs - 1 });
    expect(() => assertNoDivergence(CFG, stale, T0)).toThrowError(StaleOracleError);
  });

  it('treats an absent DeepBook TWAP (empty book, R10) as a failure, never a pass', () => {
    expect(() => assertNoDivergence(CFG, snapshot({ deepbookTwap: 0n }), T0)).toThrowError(
      OracleDivergenceError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hysteresis — the stateful breaker the run loop carries across ticks
// ─────────────────────────────────────────────────────────────────────────────

describe('divergence — breaker hysteresis (trip / hold / reset)', () => {
  const limit = CFG.pyth.divergenceBps;

  /** A snapshot diverging by exactly `bps` below the Pyth reference, fresh at `atMs`. */
  function diverged(bps: number, atMs: Millis = T0): OracleSnapshot {
    return snapshot({
      pythPublishTimeMs: atMs,
      deepbookTwap: (USD_100K_FIXED * BigInt(10_000 - bps)) / 10_000n,
    });
  }

  it('starts closed and stays closed inside the band', () => {
    const s0 = createBreaker();
    expect(s0.tripped).toBe(false);
    expect(s0.cause).toBeUndefined();

    const s1 = stepBreaker(CFG, s0, diverged(limit), T0);
    expect(s1.tripped).toBe(false);
    expect(s1.lastBps).toBe(limit);
  });

  it('trips past the threshold and exposes the run loop cause', () => {
    const tripped = stepBreaker(CFG, createBreaker(), diverged(limit + 100), T0);
    expect(tripped.tripped).toBe(true);
    expect(tripped.cause).toBe(ORACLE_DIVERGENCE_CAUSE);
    expect(tripped.trippedAtMs).toBe(T0);
    expect(tripped.lastBps).toBe(limit + 100);
  });

  it('HOLDS while divergence sits between the reset threshold and the trip threshold', () => {
    const t = stepBreaker(CFG, createBreaker(), diverged(limit + 100), T0);
    // Back inside the trip band, but above the re-arm threshold ⇒ still open.
    const held = stepBreaker(CFG, t, diverged(limit - 1, T0 + recoveryMs(CFG)), T0 + recoveryMs(CFG));
    expect(resetBps(CFG)).toBe(Math.floor(limit / 2));
    expect(held.tripped).toBe(true);
    expect(held.cause).toBe(ORACLE_DIVERGENCE_CAUSE);
  });

  it('HOLDS below the reset threshold until a full TWAP window has elapsed', () => {
    const t = stepBreaker(CFG, createBreaker(), diverged(limit + 100), T0);
    const tooSoon = T0 + recoveryMs(CFG) - 1;
    const held = stepBreaker(CFG, t, diverged(0, tooSoon), tooSoon);
    expect(held.tripped).toBe(true);
    expect(held.lastBps).toBe(0);
  });

  it('RESETS once divergence is below half the threshold AND the window has fully refreshed', () => {
    const t = stepBreaker(CFG, createBreaker(), diverged(limit + 100), T0);
    const okAt = T0 + recoveryMs(CFG);
    const reset = stepBreaker(CFG, t, diverged(resetBps(CFG), okAt), okAt);
    expect(reset.tripped).toBe(false);
    expect(reset.cause).toBeUndefined();
    expect(reset.trippedAtMs).toBeUndefined();
  });

  it('does NOT chatter: a price oscillating around the threshold trips once and stays open', () => {
    let state = createBreaker();
    const seq = [limit + 1, limit - 1, limit + 1, limit - 1, limit + 1];
    seq.forEach((bps, i) => {
      const at = T0 + i * 1_000;
      state = stepBreaker(CFG, state, diverged(bps, at), at);
    });
    expect(state.tripped).toBe(true);
    // The last excursion above the limit re-armed the hold timer.
    expect(state.trippedAtMs).toBe(T0 + 4_000);
  });

  it('a fresh excursion above the limit re-arms the hold timer, delaying the reset', () => {
    let state = stepBreaker(CFG, createBreaker(), diverged(limit + 100), T0);
    const bump = T0 + 10_000;
    state = stepBreaker(CFG, state, diverged(limit + 100, bump), bump);
    expect(state.trippedAtMs).toBe(bump);

    // What WOULD have been long enough measured from the first trip is no longer enough.
    const wouldHaveWorked = T0 + recoveryMs(CFG);
    state = stepBreaker(CFG, state, diverged(0, wouldHaveWorked), wouldHaveWorked);
    expect(state.tripped).toBe(true);

    const actuallyEnough = bump + recoveryMs(CFG);
    state = stepBreaker(CFG, state, diverged(0, actuallyEnough), actuallyEnough);
    expect(state.tripped).toBe(false);
  });

  it('trips on a STALE reading even when the two prices agree (fail closed)', () => {
    const staleButEqual = snapshot({ pythPublishTimeMs: T0 - CFG.pyth.maxStalenessMs - 1 });
    const state = stepBreaker(CFG, createBreaker(), staleButEqual, T0);
    expect(state.tripped).toBe(true);
    expect(state.lastBps).toBe(MAX_DIVERGENCE_BPS);
  });

  it('is PURE — stepping the same state twice yields identical results and no mutation', () => {
    const s0 = createBreaker();
    const a = stepBreaker(CFG, s0, diverged(limit + 100), T0);
    const b = stepBreaker(CFG, s0, diverged(limit + 100), T0);
    expect(a).toEqual(b);
    expect(s0.tripped).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// read()/tick() — the composed reading, fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('oracle.read — composed snapshot (G9: NAV is the DeepBook mid)', () => {
  const window = createTwapWindow(CFG.pyth.twapWindowMs);

  it('assembles a full snapshot with both sides on the same scale', async () => {
    const out = await tick(oracleDeps({}), { nowMs: T0, window });

    expect(out.snapshot.pythPx).toBe(USD_100K_FIXED);
    expect(out.snapshot.deepbookMid).toBe(USD_100K_FIXED);
    expect(out.snapshot.deepbookTwap).toBe(USD_100K_FIXED);
    expect(out.snapshot.pythSeq).toBe(42n);
    expect(out.snapshot.pythPublishTimeMs).toBe(T0);
    // The window advanced by exactly one sample and is carried into the next tick.
    expect(out.window.samples).toHaveLength(1);
    expect(out.window.samples[0]?.atMs).toBe(T0);
    expect(window.samples).toHaveLength(0); // caller's window untouched
    expect(() => assertNoDivergence(CFG, out.snapshot, T0)).not.toThrow();
  });

  it('values the vault at the DEEPBOOK mid, not at Pyth, when hBTC is depegged (G9)', async () => {
    // Pyth says $100k; the book says $95k. NAV must follow the book.
    const deps = oracleDeps({ bookMid: dbPriceForUsd(95_000n) });
    const snap = await read(deps, { nowMs: T0, window });

    expect(snap.deepbookMid).toBe(95_000n * 10n ** 8n);
    expect(snap.pythPx).toBe(USD_100K_FIXED);
    expect(snap.deepbookMid).not.toBe(snap.pythPx);
    // …and that 500bps gap is precisely what trips the breaker.
    expect(() => assertNoDivergence(CFG, snap, T0)).toThrowError(OracleDivergenceError);
  });

  it('THROWS OracleUnavailable on an empty book instead of substituting Pyth (R10 / G9)', async () => {
    // readBook returns mid 0n for an empty book (deepbook.ts invariant 2).
    const deps = oracleDeps({ bookMid: 0n });
    await expect(read(deps, { nowMs: T0, window })).rejects.toBeInstanceOf(OracleUnavailableError);

    try {
      await read(deps, { nowMs: T0, window });
      expect.unreachable('an empty book must fail closed');
    } catch (err) {
      const e = err as OracleUnavailableError;
      expect(e.code).toBe('OracleUnavailable');
      expect(e.what).toBe('deepbook-mid');
    }
  });

  it('THROWS StaleOracleError before ever touching the book', async () => {
    let bookRead = 0;
    const deps: OracleDeps = {
      cfg: CFG,
      deepbook: { cfg: CFG, client: FAKE_CLIENT },
      fetchPriceImpl: async () => pythPrice({ publishTimeMs: T0 - CFG.pyth.maxStalenessMs - 1 }),
      readBookImpl: async (_d, o) => {
        bookRead += 1;
        return book(dbPriceForUsd(100_000n), o.atMs);
      },
    };

    await expect(read(deps, { nowMs: T0, window })).rejects.toBeInstanceOf(StaleOracleError);
    expect(bookRead).toBe(0);
  });

  it('stamps the book with the caller-supplied nowMs — never a wall clock (invariant 1)', async () => {
    const out = await tick(oracleDeps({}), { nowMs: T0 + 12_345, window });
    expect(out.book.atMs).toBe(T0 + 12_345);
    expect(out.snapshot.pythPublishTimeMs).toBe(T0);
  });

  it('accumulates a real time-weighted TWAP across successive ticks', async () => {
    // $100k for 240s, then $200k for 60s ⇒ TWAP = $120k, while the MID is $200k.
    const first = await tick(
      oracleDeps({ bookMid: dbPriceForUsd(100_000n), price: pythPrice({ publishTimeMs: T0 - 300_000 }) }),
      { nowMs: T0 - 300_000, window },
    );
    const second = await tick(
      oracleDeps({ bookMid: dbPriceForUsd(200_000n), price: pythPrice({ publishTimeMs: T0 - 60_000 }) }),
      { nowMs: T0 - 60_000, window: first.window },
    );
    const third = await tick(
      oracleDeps({ bookMid: dbPriceForUsd(200_000n), price: pythPrice({ publishTimeMs: T0 }) }),
      { nowMs: T0, window: second.window },
    );

    expect(third.snapshot.deepbookMid).toBe(200_000n * 10n ** 8n);
    expect(third.snapshot.deepbookTwap).toBe(120_000n * 10n ** 8n);
  });

  it('propagates a book transport failure instead of guessing a price', async () => {
    const boom = new Error('devInspect failed');
    await expect(read(oracleDeps({ throwOnBook: boom }), { nowMs: T0, window })).rejects.toBe(boom);
  });
});
