// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §11 (the ladder), D9 (Seal committee), D10
// @spec       aphotic.md §7.1 (notes), §4.5 (Hashi config defaults)
// @rules      G7 G8
// @depends    ../src/config.ts (F1) · ../vitest.config.ts (env pins)
// @facts      vitest.config.ts pins EVERY id-bearing VITE_* to '', so this suite
// @facts        runs against the WORST configuration: a build that shipped without
// @facts        them. That is the state a fresh clone starts in and the state a
// @facts        mis-set CI project ends in, and it must be reported, not guessed at.
// @facts      ⚠ Vite INLINES VITE_* at build time. There is no runtime error for a
// @facts        missing one — configProblems() is the substitute, so it is tested.
// @implements the startup-validation safety net
// @forbidden  a test that depends on a developer's .env.local — the pins forbid it
// @invariant  1. configProblems() never throws.
// @invariant  2. Sats-valued config is bigint.
// @ac         missing ids are reported with a severity and an effect.
// @verify     cd app && npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { canTransact, config, configProblems, isWired } from '../src/config';

describe('the denomination ladder', () => {
  it('is exactly 0.01 / 0.1 / 1 / 10 hBTC, in sats, as bigints', () => {
    expect(config.constants.denominationsSats).toEqual([
      1_000_000n,
      10_000_000n,
      100_000_000n,
      1_000_000_000n,
    ]);
    for (const d of config.constants.denominationsSats) {
      expect(typeof d).toBe('bigint');
    }
  });

  it('keeps every tier individually redeemable above the Hashi minimum', () => {
    // This is the property that makes the FLOOR the right floor: a note you
    // cannot redeem on its own is a note that has to be pooled, which reveals
    // exactly what the ladder exists to hide.
    for (const d of config.constants.denominationsSats) {
      expect(d).toBeGreaterThan(config.hashi.withdrawalMinSats);
    }
    expect(config.hashi.withdrawalMinSats).toBe(30_000n);
  });

  it('is widely spaced — each tier is 10x the last, so there are few of them', () => {
    const tiers = config.constants.denominationsSats;
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i]).toBe(tiers[i - 1] * 10n);
    }
    expect(tiers.length).toBe(4);
  });
});

describe('the cadence and batch constants match the design', () => {
  it('is 12 h offset by 6 h, with a 60 s cut-off and a 10 min reveal grace', () => {
    expect(config.constants.cadenceMs).toBe(43_200_000);
    expect(config.constants.cadenceOffsetMs).toBe(21_600_000);
    expect(config.constants.submitCutoffMs).toBe(60_000);
    expect(config.constants.revealGraceMs).toBe(600_000);
  });

  it('governs the batch at 256 with a hard ceiling of 512', () => {
    expect(config.constants.maxBatchSize).toBe(256);
    expect(config.constants.hardMaxBatchSize).toBe(512);
    expect(config.constants.maxBatchSize).toBeLessThanOrEqual(config.constants.hardMaxBatchSize);
  });
});

describe('the validator collusion floor is quoted as BOTH numbers', () => {
  it('carries the protocol floor and the live count separately', () => {
    // A bare 7 overstates the risk; a bare 32 understates the guarantee. The
    // config carries both so no screen can accidentally quote only one.
    expect(config.constants.validatorFloor).toBe(7);
    expect(config.constants.validatorsLive).toBe(32);
    expect(config.constants.validatorsLive).toBeGreaterThan(config.constants.validatorFloor);
  });
});

describe('configProblems — the substitute for a runtime error', () => {
  const problems = configProblems();
  const keys = problems.map((p) => p.key);

  it('never throws and reports the unset ids', () => {
    expect(Array.isArray(problems)).toBe(true);
    expect(keys).toContain('VITE_APHOTIC_PACKAGE_ID');
    expect(keys).toContain('VITE_VAULT_ID');
    expect(keys).toContain('VITE_BATCH_REGISTRY_ID');
    expect(keys).toContain('VITE_SEAL_KEY_SERVER_IDS');
  });

  it('gives every problem a severity and a one-line effect', () => {
    for (const p of problems) {
      expect(['blocking', 'degraded']).toContain(p.severity);
      expect(p.effect.length).toBeGreaterThan(20);
    }
  });

  it('treats a missing package as blocking and a missing Enoki key as degraded', () => {
    const pkg = problems.find((p) => p.key === 'VITE_APHOTIC_PACKAGE_ID');
    const enoki = problems.find((p) => p.key === 'VITE_ENOKI_API_KEY');
    expect(pkg?.severity).toBe('blocking');
    expect(enoki?.severity).toBe('degraded');
  });

  it('refuses to claim the build can transact while a blocking value is unset', () => {
    expect(canTransact()).toBe(false);
  });

  it('never falls back to plaintext: no key servers is a blocking condition', () => {
    const seal = problems.find((p) => p.key === 'VITE_SEAL_KEY_SERVER_IDS');
    expect(seal?.severity).toBe('blocking');
    expect(seal?.effect).toMatch(/plaintext/i);
  });
});

describe('isWired', () => {
  it('is false when any value is empty and true when all are set', () => {
    expect(isWired(config.aphotic.packageId)).toBe(false);
    expect(isWired(config.hashi.packageId, config.hashi.hbtcType)).toBe(true);
    expect(isWired(config.hashi.packageId, config.aphotic.vaultId)).toBe(false);
    expect(isWired()).toBe(true);
  });
});

describe('the Hashi surface is namespaced under one package id', () => {
  it('derives the hBTC coin type from the package rather than repeating it', () => {
    expect(config.hashi.hbtcType).toBe(`${config.hashi.packageId}::btc::BTC`);
    expect(config.constants.hbtcDecimals).toBe(8);
  });
});
