// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §3.1 (evaluate PURE), §3.2 (padded serializer), §13 A3/A4
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6)
// @rules      G3 G4 G5 G8 G9 G10
// @depends    ../src/strategy/{params,serialize,evaluate}.ts · ./support/fixtures.ts
// @facts      Venue constants arrive from `loadConfig` — never a literal in a test (G7).
// @facts      MID used throughout is 1_180_000_000_000 — comfortably above one tick (1_000_000)
// @facts        so a 30 bps half-spread and a ±5 bps jitter both survive tick alignment.
// @implements A4 — constant-length round-tripping serializer
// @implements A3 — evaluate() reproduces its Decision bit-for-bit, jitter included
// @implements T2.7 — ExecutionParams (ladder + slice) bounds, the 16-byte extension riding in the
// @implements   frame's zero tail WITHOUT changing its length, and the PURE slice-index derivation
// @invariant  1. No test reads a clock or unseeded entropy — every time is an argument.
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  BPS_DENOMINATOR,
  decodeExecutionExtension,
  defaultExecutionParams,
  defaultParams,
  embedExecutionParams,
  encodeExecutionExtension,
  EXECUTION_PARAM_KEYS,
  EXECUTION_PARAMS_EXT_BYTES,
  EXECUTION_PARAMS_EXT_OFFSET,
  executionParamsFingerprint,
  extractExecutionParams,
  MAX_SLICE_COUNT,
  paramsFingerprint,
  STRATEGY_PARAM_KEYS,
  validateExecutionParams,
  validateParams,
  type ExecutionParams,
  type StrategyParams,
} from '../src/strategy/params.js';
import { MAX_LADDER_LEVELS } from '../src/routing/route.js';
import {
  deserialize,
  serialize,
  SERIALIZED_PARAMS_BYTES,
  SERIALIZED_PARAMS_PADDING_OFFSET,
  SERIALIZED_PARAMS_VERSION,
} from '../src/strategy/serialize.js';
import {
  deriveSliceIndex,
  evaluate,
  rulesetHash,
  sliceCursor,
  type RulesetContext,
  type StrategyInputs,
} from '../src/strategy/evaluate.js';
import { ConfigError } from '../src/util/errors.js';

import { testConfig } from './support/fixtures.js';

const cfg = testConfig();
const params = defaultParams(cfg);

const CTX: RulesetContext = {
  tickSize: cfg.deepbook.tickSize,
  lotSize: cfg.deepbook.lotSize,
  minSize: cfg.deepbook.minSize,
  withdrawalMinimumSats: cfg.hashi.withdrawalMinimumSats,
  maxOracleDivergenceBps: cfg.pyth.divergenceBps,
};

const MID = 1_180_000_000_000n;
const TICK_MS = 1_800_000_000_000;

function inputs(over: Partial<StrategyInputs> = {}): StrategyInputs {
  return {
    book: { poolId: cfg.deepbook.poolId, bids: [], asks: [], mid: MID, atMs: TICK_MS },
    oracle: {
      pythPx: 118_000_000_000n,
      pythSeq: 42n,
      pythPublishTimeMs: TICK_MS - 1_000,
      deepbookTwap: MID,
      deepbookMid: MID,
    },
    limiter: { atMs: TICK_MS, atSecs: BigInt(TICK_MS / 1000), tokens: 10_000_000_000n, queueDepth: 0n },
    pendingMintSats: 0n,
    pendingBurnSats: 0n,
    idleHBtcSats: 10_000_000n,
    pendingExitDemandSats: 0n,
    tickMs: TICK_MS,
    jitterSeed: 'aphotic-seed-1',
    restingOrderIds: [],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/params — the only secret in the system', () => {
  it('defaultParams derives makerTimeoutMs from config and satisfies every bound', () => {
    expect(params.makerTimeoutMs).toBe(cfg.loop.makerTimeoutMs);
    expect(params.cooldownMs).toBe(Math.floor(cfg.loop.makerTimeoutMs / 3));
    // invariant 2
    expect(params.spreadBps).toBeGreaterThan(0);
    expect(params.spreadBps).toBeLessThanOrEqual(BPS_DENOMINATOR);
    expect(Math.abs(params.skewBps)).toBeLessThanOrEqual(params.spreadBps);
    expect(params.jitterBps).toBeLessThanOrEqual(Math.floor(params.spreadBps / 2));
    expect(typeof params.maxNotionalPerEpochSats).toBe('bigint');
    expect(STRATEGY_PARAM_KEYS.length).toBe(9);
  });

  it('validateParams rejects jitter wider than half the spread, naming the field', () => {
    expect(() => validateParams({ ...params, jitterBps: params.spreadBps }, cfg)).toThrowError(ConfigError);
    try {
      validateParams({ ...params, jitterBps: params.spreadBps }, cfg);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ConfigError).missing).toContain('jitterBps');
    }
  });

  it('validateParams rejects |skew| > spread and a spread of 0', () => {
    expect(() => validateParams({ ...params, skewBps: params.spreadBps + 1 }, cfg)).toThrowError(ConfigError);
    expect(() => validateParams({ ...params, spreadBps: 0 }, cfg)).toThrowError(ConfigError);
  });

  it('validateParams rejects `number` for sats — G10, money is never a number', () => {
    const wrong = { ...params, maxNotionalPerEpochSats: 50_000_000 } as unknown as StrategyParams;
    try {
      validateParams(wrong, cfg);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ConfigError).missing).toContain('maxNotionalPerEpochSats');
      expect((e as ConfigError).message).toContain('bigint');
    }
  });

  it('validateParams rejects a per-epoch cap below the venue min_size (config-driven, G7)', () => {
    const tooSmall = { ...params, maxNotionalPerEpochSats: cfg.deepbook.minSize - 1n };
    try {
      validateParams(tooSmall, cfg);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ConfigError).missing).toContain('maxNotionalPerEpochSats');
    }
  });

  it('validateParams lists EVERY missing key in one throw', () => {
    const partial = { spreadBps: 30 } as unknown as StrategyParams;
    try {
      validateParams(partial, cfg);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect([...(e as ConfigError).missing].sort()).toEqual(
        STRATEGY_PARAM_KEYS.filter((k) => k !== 'spreadBps').slice().sort(),
      );
    }
  });

  it('paramsFingerprint is stable, 32 bytes, and never echoes a parameter value (G8)', () => {
    const a = paramsFingerprint(params);
    expect(a).toBe(paramsFingerprint(params));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(params.maxNotionalPerEpochSats.toString(16));
    expect(paramsFingerprint({ ...params, skewBps: 1 })).not.toBe(a);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/serialize — A4: constant length, exact round trip', () => {
  const extreme: StrategyParams = {
    spreadBps: 10_000,
    skewBps: -10_000,
    flowSensitivityBps: 9_999,
    bufferTargetBps: 10_000,
    maxNotionalPerEpochSats: 18_446_744_073_709_551_615n, // u64::MAX
    cooldownMs: 86_400_000,
    jitterBps: 5_000,
    hysteresisBps: 10_000,
    makerTimeoutMs: 3_600_000,
  };

  it('A4 — every strategy family serializes to EXACTLY the same length (no size oracle)', () => {
    expect(serialize(params).length).toBe(SERIALIZED_PARAMS_BYTES);
    expect(serialize(extreme).length).toBe(SERIALIZED_PARAMS_BYTES);
    const minimal: StrategyParams = {
      ...params,
      spreadBps: 1,
      skewBps: 0,
      flowSensitivityBps: 0,
      bufferTargetBps: 0,
      maxNotionalPerEpochSats: cfg.deepbook.minSize,
      cooldownMs: 0,
      jitterBps: 0,
      hysteresisBps: 0,
      makerTimeoutMs: 1,
    };
    expect(serialize(minimal).length).toBe(SERIALIZED_PARAMS_BYTES);
  });

  it('round-trips defaults, extremes and a NEGATIVE skew (zig-zag)', () => {
    expect(deserialize(serialize(params))).toEqual(params);
    expect(deserialize(serialize(extreme))).toEqual(extreme);
    const negative = { ...params, skewBps: -17 };
    expect(deserialize(serialize(negative))).toEqual(negative);
    expect(deserialize(serialize(negative)).skewBps).toBe(-17);
  });

  it('is byte-identical on repeated calls and pads with ZEROS, never entropy (G5)', () => {
    const a = serialize(params);
    const b = serialize(params);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a[0]).toBe(SERIALIZED_PARAMS_VERSION);
    const tail = a.subarray(SERIALIZED_PARAMS_PADDING_OFFSET);
    expect(tail.length).toBe(SERIALIZED_PARAMS_BYTES - SERIALIZED_PARAMS_PADDING_OFFSET);
    expect(tail.every((byte) => byte === 0)).toBe(true);
  });

  it('deserialize refuses a wrong length or an unknown version rather than guessing', () => {
    expect(() => deserialize(new Uint8Array(SERIALIZED_PARAMS_BYTES - 1))).toThrowError(/exactly 128 bytes/);
    const bad = serialize(params);
    bad[0] = 99;
    expect(() => deserialize(bad)).toThrowError(/unknown strategy frame version 99/);
  });

  it('serialize rejects an out-of-range field instead of silently truncating it', () => {
    expect(() => serialize({ ...params, spreadBps: 70_000 })).toThrowError(/spreadBps/);
    expect(() => serialize({ ...params, skewBps: -40_000 })).toThrowError(/zig-zag/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/evaluate — A3: pure, deterministic, venue-legal', () => {
  it('A3 — the same inputs reproduce a byte-identical Decision, jitter included', () => {
    const first = evaluate(params, inputs(), CTX);
    const second = evaluate(params, inputs(), CTX);
    expect(second).toEqual(first);
    expect(first.jitterSeed).toBe('aphotic-seed-1');
    expect(first.action).toBe('quote');
  });

  it('a different SEED changes the jitter but not the decision class or the size', () => {
    const wide: StrategyParams = validateParams({ ...params, spreadBps: 200, jitterBps: 100 }, cfg);
    const a = evaluate(wide, inputs({ jitterSeed: 'seed-a' }), CTX);
    const b = evaluate(wide, inputs({ jitterSeed: 'seed-b' }), CTX);
    expect(b.action).toBe(a.action);
    expect(b.bidSz).toBe(a.bidSz);
    expect(b.askSz).toBe(a.askSz);
    expect([b.bidPx === a.bidPx, b.askPx === a.askPx]).not.toEqual([true, true]);
    expect(b.jitterSeed).toBe('seed-b');
  });

  it('invariant 2/5 — prices are tick-aligned, sizes lot-aligned and >= min_size, bid < ask', () => {
    const d = evaluate(params, inputs(), CTX);
    expect(d.bidPx % cfg.deepbook.tickSize).toBe(0n);
    expect(d.askPx % cfg.deepbook.tickSize).toBe(0n);
    expect(d.bidSz % cfg.deepbook.lotSize).toBe(0n);
    expect(d.askSz % cfg.deepbook.lotSize).toBe(0n);
    expect(d.bidSz).toBeGreaterThanOrEqual(cfg.deepbook.minSize);
    expect(d.askSz).toBeGreaterThanOrEqual(cfg.deepbook.minSize);
    // Rounds INTO the spread, never through the mid.
    expect(d.bidPx).toBeLessThan(MID);
    expect(d.askPx).toBeGreaterThan(MID);
    expect(d.bidPx).toBeLessThan(d.askPx);
  });

  it('invariant 4 — evaluate never mutates params or inputs', () => {
    const frozenInputs = Object.freeze(inputs({ restingOrderIds: Object.freeze([7n, 9n]) }));
    const frozenParams = Object.freeze({ ...params });
    const d = evaluate(frozenParams, frozenInputs, CTX);
    expect(d.action).toBe('requote');
    expect(d.cancels).toEqual([7n, 9n]);
    expect(frozenInputs.restingOrderIds).toEqual([7n, 9n]);
    expect(frozenParams).toEqual(params);
  });

  it('(E-M7) an empty book / absent mid is a DEFINED state: noop cause=no-mid, quotes pulled', () => {
    const d = evaluate(
      params,
      inputs({
        oracle: { ...inputs().oracle, deepbookMid: 0n },
        book: { ...inputs().book, mid: 0n },
        restingOrderIds: [11n],
      }),
      CTX,
    );
    expect(d.action).toBe('noop');
    expect(d.cause).toBe('no-mid');
    expect(d.cancels).toEqual([11n]);
    expect(d.bidSz).toBe(0n);
  });

  it('(d) oracle divergence beyond the configured threshold => noop cause=oracle-divergence (G9)', () => {
    const over = evaluate(
      params,
      inputs({ oracleDivergenceBps: cfg.pyth.divergenceBps + 1, restingOrderIds: [3n] }),
      CTX,
    );
    expect(over.action).toBe('noop');
    expect(over.cause).toBe('oracle-divergence');
    expect(over.cancels).toEqual([3n]);

    const under = evaluate(params, inputs({ oracleDivergenceBps: cfg.pyth.divergenceBps }), CTX);
    expect(under.action).toBe('quote');
  });

  it('the requote cooldown yields noop cause=cooldown and leaves resting orders alone', () => {
    const d = evaluate(
      params,
      inputs({ lastDecisionAtMs: TICK_MS - (params.cooldownMs - 1), restingOrderIds: [5n] }),
      CTX,
    );
    expect(d.action).toBe('noop');
    expect(d.cause).toBe('cooldown');
    expect(d.cancels).toEqual([]);

    const elapsed = evaluate(
      params,
      inputs({ lastDecisionAtMs: TICK_MS - params.cooldownMs, restingOrderIds: [5n] }),
      CTX,
    );
    expect(elapsed.action).toBe('requote');
  });

  it('(b) the redemption buffer downsizes to derisk when nothing legal is left to deploy', () => {
    const d = evaluate(params, inputs({ idleHBtcSats: 200_000n, restingOrderIds: [1n] }), CTX);
    expect(d.action).toBe('derisk');
    expect(d.cause).toBe('buffer');
    expect(d.bidSz).toBe(0n);
    expect(d.cancels).toEqual([1n]);
  });

  it('(b) a sub-minimum pooled exit reserves the FULL Hashi minimum (30_000 sats), not its face value', () => {
    const tiny = evaluate(params, inputs({ pendingExitDemandSats: 1n }), CTX);
    const atMinimum = evaluate(
      params,
      inputs({ pendingExitDemandSats: cfg.hashi.withdrawalMinimumSats }),
      CTX,
    );
    const none = evaluate(params, inputs({ pendingExitDemandSats: 0n }), CTX);
    expect(tiny.bidSz).toBe(atMinimum.bidSz);
    expect(tiny.bidSz).toBeLessThan(none.bidSz);
  });

  it('(c) bucket tightening WIDENS the buffer — the replayable de-risk trace (G5)', () => {
    const calm = evaluate(params, inputs(), CTX);
    const tight = evaluate(
      params,
      inputs({
        limiter: { atMs: TICK_MS, atSecs: 1n, tokens: 1_000_000n, queueDepth: 5_000_000n },
      }),
      CTX,
    );
    expect(tight.action).toBe('quote');
    expect(tight.bidSz).toBeLessThan(calm.bidSz);
  });

  it('(c) tightening with capacity below our own exit demand pre-empts to derisk (G3 — never queued)', () => {
    const d = evaluate(
      params,
      inputs({
        limiter: { atMs: TICK_MS, atSecs: 1n, tokens: 1_000n, queueDepth: 2_000n },
        pendingExitDemandSats: 500_000n,
        restingOrderIds: [2n],
      }),
      CTX,
    );
    expect(d.action).toBe('derisk');
    expect(d.cause).toBe('limiter-tightening');
    expect(d.cancels).toEqual([2n]);
  });

  it('(a) telegraphed net MINT skews the quote centre down; net BURN skews it up', () => {
    const flat = evaluate(params, inputs(), CTX);
    const minting = evaluate(params, inputs({ pendingMintSats: 500_000_000n }), CTX);
    const burning = evaluate(params, inputs({ pendingBurnSats: 500_000_000n }), CTX);
    expect(minting.bidPx).toBeLessThan(flat.bidPx);
    expect(minting.askPx).toBeLessThan(flat.askPx);
    expect(burning.bidPx).toBeGreaterThan(flat.bidPx);
    expect(burning.askPx).toBeGreaterThan(flat.askPx);
  });

  it('(a) the hysteresis dead-band suppresses a sub-threshold flow lean entirely', () => {
    const flat = evaluate(params, inputs(), CTX);
    // 0.1 BTC * 50 bps/BTC = 5 bps < hysteresisBps (10) ⇒ treated as no lean at all.
    const noisy = evaluate(params, inputs({ pendingMintSats: 10_000_000n }), CTX);
    expect(noisy.bidPx).toBe(flat.bidPx);
    expect(noisy.askPx).toBe(flat.askPx);
  });

  it('rulesetHash is a stable 32-byte digest that covers the helpers too', () => {
    const h = rulesetHash();
    expect(h).toBe(rulesetHash());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/params — execution parameters: laddered quoting + deterministic slicing (T2.7)', () => {
  const exec = defaultExecutionParams();

  it('the defaults are a legal ladder for the near-empty book and a legal slice schedule', () => {
    expect(exec).toEqual({
      ladderLevels: 3,
      ladderStepBps: 15,
      ladderDecayBps: 3_000,
      sliceCount: 4,
    });
    expect(EXECUTION_PARAM_KEYS.length).toBe(4);
    expect(exec.ladderLevels).toBeLessThanOrEqual(MAX_LADDER_LEVELS);
    expect(exec.sliceCount).toBeLessThanOrEqual(MAX_SLICE_COUNT);
  });

  it('rejects a level count outside [1, MAX_LADDER_LEVELS], naming the field', () => {
    for (const ladderLevels of [0, -1, MAX_LADDER_LEVELS + 1]) {
      try {
        validateExecutionParams({ ...exec, ladderLevels });
        expect.unreachable(`should have thrown for ladderLevels=${ladderLevels}`);
      } catch (e) {
        expect((e as ConfigError).missing).toContain('ladderLevels');
      }
    }
  });

  it('rejects rungs that are not distinct prices, and a ladder whose deepest bid rung is not a price', () => {
    // levels > 1 with a zero step collapses every rung onto one tick.
    try {
      validateExecutionParams({ ...exec, ladderStepBps: 0 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ConfigError).missing).toContain('ladderStepBps');
      expect((e as ConfigError).message).toMatch(/distinct prices/);
    }
    // (levels-1) * step >= 10_000 ⇒ the deepest bid rung would sit at or below zero.
    expect(() => validateExecutionParams({ ...exec, ladderLevels: 8, ladderStepBps: 1_500 })).toThrowError(
      ConfigError,
    );
    // …and a single-level "ladder" may legitimately carry a zero step.
    expect(validateExecutionParams({ ...exec, ladderLevels: 1, ladderStepBps: 0 }).ladderLevels).toBe(1);
  });

  it('rejects an out-of-range decay or slice count, and any non-integer field', () => {
    expect(() => validateExecutionParams({ ...exec, ladderDecayBps: 10_001 })).toThrowError(ConfigError);
    expect(() => validateExecutionParams({ ...exec, ladderDecayBps: -1 })).toThrowError(ConfigError);
    expect(() => validateExecutionParams({ ...exec, sliceCount: 0 })).toThrowError(ConfigError);
    expect(() => validateExecutionParams({ ...exec, sliceCount: MAX_SLICE_COUNT + 1 })).toThrowError(ConfigError);
    expect(() => validateExecutionParams({ ...exec, ladderLevels: 2.5 })).toThrowError(ConfigError);
    const partial = { ladderLevels: 3 } as unknown as ExecutionParams;
    try {
      validateExecutionParams(partial);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect([...(e as ConfigError).missing].sort()).toEqual(
        EXECUTION_PARAM_KEYS.filter((k) => k !== 'ladderLevels').slice().sort(),
      );
    }
    // Decay may sit at either end of its range — 0 is a flat ladder, 10_000 a front-loaded one.
    expect(validateExecutionParams({ ...exec, ladderDecayBps: 0 }).ladderDecayBps).toBe(0);
    expect(validateExecutionParams({ ...exec, ladderDecayBps: 10_000 }).ladderDecayBps).toBe(10_000);
  });

  it('the extension block is 16 deterministic bytes, zero-padded, and round-trips exactly', () => {
    const block = encodeExecutionExtension(exec);
    expect(block.length).toBe(EXECUTION_PARAMS_EXT_BYTES);
    expect(Array.from(block)).toEqual(Array.from(encodeExecutionExtension(exec)));
    expect(block[0]).toBe(1); // version
    expect(Array.from(block.subarray(9)).every((byte) => byte === 0)).toBe(true);
    expect(decodeExecutionExtension(block)).toEqual(exec);

    const other: ExecutionParams = { ladderLevels: 5, ladderStepBps: 8, ladderDecayBps: 0, sliceCount: 1 };
    expect(decodeExecutionExtension(encodeExecutionExtension(other))).toEqual(other);
  });

  it('A4 HOLDS: embedding the ladder does NOT change the sealed frame length or the strategy fields', () => {
    const plain = serialize(params);
    const embedded = embedExecutionParams(plain, exec);

    expect(embedded.length).toBe(SERIALIZED_PARAMS_BYTES); // invariant 5 — no size oracle
    expect(deserialize(embedded)).toEqual(params); // the strategy fields are untouched
    expect(Array.from(embedded.subarray(0, EXECUTION_PARAMS_EXT_OFFSET))).toEqual(
      Array.from(plain.subarray(0, EXECUTION_PARAMS_EXT_OFFSET)),
    );
    expect(EXECUTION_PARAMS_EXT_OFFSET).toBe(SERIALIZED_PARAMS_PADDING_OFFSET);
    expect(extractExecutionParams(embedded)).toEqual(exec);
    // embed does not mutate its input frame.
    expect(Array.from(plain)).toEqual(Array.from(serialize(params)));
  });

  it('a plain frame reports the ABSENCE of an extension rather than guessing a ladder', () => {
    expect(extractExecutionParams(serialize(params))).toBeUndefined(); // invariant 6
    expect(() => extractExecutionParams(new Uint8Array(SERIALIZED_PARAMS_BYTES - 1))).toThrowError(
      ConfigError,
    );
  });

  it('a PRESENT but malformed extension throws — a corrupt frame never becomes a live ladder', () => {
    const embedded = embedExecutionParams(serialize(params), exec);
    embedded[EXECUTION_PARAMS_EXT_OFFSET] = 9; // unknown version
    expect(() => extractExecutionParams(embedded)).toThrowError(/unknown execution extension version 9/);

    const bad = embedExecutionParams(serialize(params), exec);
    bad[EXECUTION_PARAMS_EXT_OFFSET + 2] = 99; // ladderLevels = 99 — beyond the cap
    expect(() => extractExecutionParams(bad)).toThrowError(ConfigError);
  });

  it('executionParamsFingerprint is stable, 32 bytes, and changes with the geometry (G8)', () => {
    const a = executionParamsFingerprint(exec);
    expect(a).toBe(executionParamsFingerprint(exec));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(executionParamsFingerprint({ ...exec, ladderStepBps: 16 })).not.toBe(a);
    expect(a).not.toContain(exec.ladderDecayBps.toString(16));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('strategy/evaluate — the slice index is derived from the SNAPSHOT, never from a clock (G5)', () => {
  it('sliceCursor reads the on-chain Pyth sequence number out of the journaled snapshot', () => {
    expect(sliceCursor(inputs())).toBe(42n);
    expect(deriveSliceIndex(inputs(), 4)).toBe(2); // 42 mod 4
    expect(deriveSliceIndex(inputs(), 4)).toBe(deriveSliceIndex(inputs(), 4)); // pure
  });

  it('an advancing cursor walks the schedule — consecutive sequences give consecutive slices', () => {
    const indices = [42n, 43n, 44n, 45n].map((pythSeq) =>
      deriveSliceIndex(inputs({ oracle: { ...inputs().oracle, pythSeq } }), 4),
    );
    expect(indices).toEqual([2, 3, 0, 1]);
  });

  it('falls back to the limiter replay seconds when there is no Pyth reading (G5, never an SDK read)', () => {
    const noPyth = inputs({ oracle: { ...inputs().oracle, pythSeq: 0n } });
    expect(sliceCursor(noPyth)).toBe(BigInt(TICK_MS / 1000));
    // 1_800_000_000 mod 7 = 1, while the Pyth cursor 42 mod 7 = 0 — the fallback really is in play.
    expect(deriveSliceIndex(noPyth, 7)).toBe(1);
    expect(deriveSliceIndex(inputs(), 7)).toBe(0);
  });

  it('degrades to slice 0 when there is no cursor at all, or nothing to slice', () => {
    const blind = inputs({
      oracle: { ...inputs().oracle, pythSeq: 0n },
      limiter: { atMs: TICK_MS, atSecs: 0n, tokens: 0n, queueDepth: 0n },
    });
    expect(sliceCursor(blind)).toBe(0n);
    expect(deriveSliceIndex(blind, 4)).toBe(0);
    expect(deriveSliceIndex(inputs(), 1)).toBe(0);
    expect(deriveSliceIndex(inputs(), 0)).toBe(0);
    expect(deriveSliceIndex(inputs(), 2.5)).toBe(0);
  });
});
