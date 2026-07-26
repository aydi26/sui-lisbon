// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §4.1 (hBTC is a plain coin, 8 decimals), §7.3 (cadence)
// @spec       docs/DESIGN-V2.md §4 (next_boundary)
// @rules      G7 G8
// @depends    ../config.ts (F1) · ../lib/suiClient.ts · ../lib/cadence.ts (F1)
// @facts      TWO COUNTERS, and each is honest about what it is:
// @facts        LEFT  hBTC in circulation, in sats — a LIVE read of the bridge's
// @facts              own supply via getCoinInfo. It is HASHI'S number, context
// @facts              only, and must NEVER be labelled as assets under management
// @facts              or as anything Aphotic holds (G8).
// @facts        RIGHT minutes to the next 06:00 / 18:00 UTC clearing — a pure
// @facts              function of the calendar. No network, so it is correct even
// @facts              when the venue wifi is not.
// @facts      Verified live over SuiGrpcClient.stateService.getCoinInfo:
// @facts        { treasury: { totalSupply: 19_385_887_201n } } ≈ 193.86 BTC.
// @facts      Aphotic's own assets under management are NOT read here: the v2
// @facts        vault is not published, and there is no field to read. A landing
// @facts        page is the last place to invent one.
// @external   client.stateService.getCoinInfo({ coinType })
//               -> { response: { metadata, treasury?: { totalSupply?: bigint } } }
// @implements export async function readAggregateStats(): Promise<AggregateStats>
// @forbidden  THROWING — the hero must render at the venue with the network down
// @forbidden  labelling the bridge's supply as Aphotic's AUM — G8
// @forbidden  `number` for sats — sats stay bigint until the last Number() cast
// @forbidden  a canonical id literal here — G7
// @invariant  1. NEVER throws. Any failure resolves with ok:false and circulating 0.
// @invariant  2. The read is abortable and time-boxed (READ_TIMEOUT_MS).
// @invariant  3. The countdown is computed even when the read fails — it does not
//                depend on the network at all.
// @ac         the landing page renders with zero network and shows a countdown.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';
import { getSuiClient } from '../lib/suiClient';
import { msUntilNextBoundary, nextBoundaryMs } from '../lib/cadence';

/** Hard ceiling on the landing-page read. The hero never waits on the network. */
const READ_TIMEOUT_MS = 4000;

/**
 * @typedef {Object} AggregateStats
 * @property {number} circulating       Bridge-wide hBTC supply in sats. Context only — NOT our AUM.
 * @property {number} minutesToClearing  Whole minutes to the next 06:00/18:00 UTC boundary.
 * @property {boolean} ok                True only when the Sui read succeeded.
 * @property {bigint} circulatingSats    The same supply, unrounded.
 * @property {number} nextCloseMs        Unix ms of the boundary being counted down to.
 */

/**
 * Minutes to the next clearing. Pure, offline, and rounded UP so the counter
 * never shows "0 minutes" while the window is still open.
 *
 * @param {number} nowMs
 * @returns {number}
 */
export function minutesToClearing(nowMs) {
  return Math.max(1, Math.ceil(msUntilNextBoundary(nowMs) / 60_000));
}

/**
 * Reads the two landing-page counters. Wallet-free and read-only, so the hero
 * shows a live number before anyone connects.
 *
 * NEVER throws: any RPC, network or parse failure resolves with `ok: false` and
 * a zero supply, while the countdown — which needs nothing but a clock — stays
 * correct.
 *
 * @param {number} [nowMs] Injected clock, for tests.
 * @returns {Promise<AggregateStats>}
 */
export async function readAggregateStats(nowMs = Date.now()) {
  const base = {
    minutesToClearing: minutesToClearing(nowMs),
    nextCloseMs: nextBoundaryMs(nowMs),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);

  try {
    // The bridge-wide hBTC supply. This is Hashi's number, not ours: it is a
    // liveness signal and a sense of scale, never a claim about what we hold.
    const { response } = await getSuiClient().stateService.getCoinInfo(
      { coinType: config.hashi.hbtcType },
      { abort: controller.signal },
    );

    const circulatingSats = BigInt(response?.treasury?.totalSupply ?? 0);

    return {
      ...base,
      circulating: Number(circulatingSats),
      circulatingSats,
      ok: true,
    };
  } catch {
    return { ...base, circulating: 0, circulatingSats: 0n, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export default readAggregateStats;
