// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.8
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §6 (DeepBook TWAP over TWAP_WINDOW_MS)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.8) · docs/FACTS.md#deepbook-venue
// @rules      G4 G7 G9
// @depends    ../routing/book.ts (T2.7) · ../config.ts (twapWindowMs) · ../types.ts
// @facts      TWAP window = cfg.pyth.twapWindowMs (default 300_000 = 5 min).
// @facts      Samples come from the DeepBook L2 mid (routing/book.ts `bookMid`), NOT from an
// @facts        indexer and NOT from `pool::mid_price` (which aborts on an empty book, E-K6).
// @facts      ★ TIME-WEIGHTED, not sample-averaged: a mid that held for 4 minutes must outweigh one
// @facts        that held for 4 seconds, or a burst of samples during a spike skews the reference.
// @facts      ⚠ The testnet book is EMPTY (docs/RECON.md R10) ⇒ `bookMid` is frequently undefined.
// @facts        A window with no usable sample returns `undefined` — the caller then declines to
// @facts        evaluate (`noop`) rather than inventing a price.
// @facts      This TWAP is the DeepBook side of the divergence breaker (./divergence.ts); the Pyth
// @facts        side is ./pyth.ts. NAV itself is valued at the SPOT DeepBook mid (G9).
// @implements export interface MidSample / TwapWindow
// @implements export function createTwapWindow(windowMs: Millis): TwapWindow
// @implements export function pushSample(window: TwapWindow, sample: MidSample): TwapWindow
// @implements export function twap(samples: readonly MidSample[], windowMs: Millis, nowMs: Millis): bigint | undefined
// @forbidden  any wall-clock read — `nowMs` is always an argument (replayability, G5)
// @forbidden  reading the mid from a DeepBook indexer (docs/RECON.md R10)
// @forbidden  `number` for prices — bigint fixed point throughout
// @invariant  1. PURE: no clock, no I/O; `pushSample` returns a NEW window (no mutation).
// @invariant  2. Samples outside `[nowMs - windowMs, nowMs]` are excluded from the average.
// @invariant  3. Weighting is by DWELL TIME, not by sample count.
// @invariant  4. An empty/unusable window yields `undefined`, never 0n.
// @ac         docs/KEEPER.md §13 A7 — feeds the divergence breaker
// @verify     npm run test -- oracle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Millis } from '../types.js';

/** One observation of the DeepBook mid at a logical instant. */
export interface MidSample {
  readonly atMs: Millis;
  /** Sats-scaled DeepBook mid (routing/book.ts). */
  readonly mid: bigint;
}

/** Rolling, immutable sample window. */
export interface TwapWindow {
  readonly windowMs: Millis;
  /** Ascending by `atMs`. */
  readonly samples: readonly MidSample[];
}

/** Empty window of the given width. */
// TODO(T2.8): return { windowMs, samples: [] } (frozen).
export function createTwapWindow(_windowMs: Millis): TwapWindow {
  throw new Error('TODO(T2.8): createTwapWindow not implemented');
}

/** Append a sample and evict everything older than `windowMs`. Returns a NEW window. */
// TODO(T2.8): push, keep ascending order, drop samples older than sample.atMs - windowMs.
export function pushSample(_window: TwapWindow, _sample: MidSample): TwapWindow {
  throw new Error('TODO(T2.8): pushSample not implemented');
}

/**
 * Time-weighted average mid over `[nowMs - windowMs, nowMs]`.
 * `undefined` when no usable sample covers the window (empty book — R10).
 */
// TODO(T2.8): dwell-time weighting between consecutive samples, clipped to the window; bigint only.
export function twap(
  _samples: readonly MidSample[],
  _windowMs: Millis,
  _nowMs: Millis,
): bigint | undefined {
  throw new Error('TODO(T2.8): twap not implemented');
}
