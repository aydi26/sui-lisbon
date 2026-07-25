// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T0.6
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §12 (env vars), §10 step 1 (fail fast in real mode), §13 A8
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.6 config wiring proof)
// @rules      G7 G9
// @depends    ../src/config.ts (T0.6)
// @facts      ⚠ NO canonical ID LITERAL may appear in this file (G7). Assertions compare against
// @facts        TESTNET_DEFAULTS, never against a pasted 0x… string.
// @facts      WALRUS_EPOCHS must never be 1 (KEEPER.md §8 / A8).
// @implements mock-mode defaults load · real-mode missing vars throw listing them ·
//             env overrides · validation errors · secret redaction
// @verify     npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { TESTNET_DEFAULTS, assertRealModeComplete, loadConfig, redactSecrets } from '../src/config.js';
import { ConfigError } from '../src/util/errors.js';

describe('config — mock mode (the default everywhere: dev, test, CI — G7)', () => {
  it('loads every canonical identifier from TESTNET_DEFAULTS with an empty environment', () => {
    const cfg = loadConfig({});

    expect(cfg.hashi.adapter).toBe('mock');
    expect(cfg.sui.network).toBe(TESTNET_DEFAULTS.suiNetwork);
    expect(cfg.sui.transport).toBe('grpc');
    expect(cfg.sui.grpcUrl).toBe(TESTNET_DEFAULTS.suiGrpcUrl);
    expect(cfg.sui.jsonRpcMirrors).toEqual(TESTNET_DEFAULTS.suiJsonRpcMirrors);

    expect(cfg.hashi.packageId).toBe(TESTNET_DEFAULTS.hashiPackageId);
    expect(cfg.hashi.objectId).toBe(TESTNET_DEFAULTS.hashiObjectId);
    expect(cfg.hashi.objectInitialSharedVersion).toBe(TESTNET_DEFAULTS.hashiObjectInitialSharedVersion);
    expect(cfg.hashi.hbtcCoinType).toBe(TESTNET_DEFAULTS.hbtcCoinType);
    expect(cfg.hashi.hbtcCoinType.startsWith(`${cfg.hashi.packageId}::`)).toBe(true);

    expect(cfg.deepbook.poolId).toBe(TESTNET_DEFAULTS.deepbookPoolId);
    expect(cfg.deepbook.poolInitialSharedVersion).toBe(TESTNET_DEFAULTS.deepbookPoolInitialSharedVersion);
    // RECON R4: the CALLABLE package and the TYPE-ORIGIN package are different objects.
    expect(cfg.deepbook.packageId).toBe(TESTNET_DEFAULTS.deepbookPackageId);
    expect(cfg.deepbook.originalPackageId).toBe(TESTNET_DEFAULTS.deepbookOriginalPackageId);
    expect(cfg.deepbook.packageId).not.toBe(cfg.deepbook.originalPackageId);
    expect(cfg.deepbook.tickSize).toBe(1_000_000n);
    expect(cfg.deepbook.lotSize).toBe(1_000n);
    expect(cfg.deepbook.minSize).toBe(100_000n);

    // G9: BETA channel on testnet, never the stable/mainnet feed id.
    expect(cfg.pyth.btcUsdFeedId).toBe(TESTNET_DEFAULTS.pythBtcUsdFeedId);
    expect(cfg.pyth.hermesEndpoint).toContain('hermes-beta');

    // RECON R6 — the live on-chain Hashi config.
    expect(cfg.hashi.depositTimeDelayMs).toBe(600_000);
    expect(cfg.hashi.depositMinimumSats).toBe(30_000n);
    expect(cfg.hashi.withdrawalMinimumSats).toBe(30_000n);
    expect(cfg.hashi.confirmationThreshold).toBe(6);
    expect(cfg.hashi.cancellationCooldownMs).toBe(3_600_000);
    expect(cfg.hashi.dustFloorSats).toBe(546n);

    // RECON R9 — the two limiter genesis scalars (trust anchors; a BOUND, not a fact).
    expect(cfg.limiter.refillRateSatsPerSec).toBe(1_000n);
    expect(cfg.limiter.maxBucketCapacitySats).toBe(100_000_000n);

    // A8: never the 1-epoch Walrus default.
    expect(cfg.walrus.epochs).toBe(12);
    expect(cfg.walrus.epochs).toBeGreaterThan(1);
  });

  it('leaves not-yet-deployed ids empty and requires nothing in mock mode', () => {
    const cfg = loadConfig({});
    expect(cfg.aphotic.packageId).toBe('');
    expect(cfg.aphotic.vaultId).toBe('');
    expect(cfg.deepbook.balanceManagerId).toBe('');
    expect(cfg.deepbook.tradeCapId).toBe('');
    expect(cfg.secrets.keeperKey).toBeUndefined();
    expect(() => assertRealModeComplete(cfg)).not.toThrow();
  });

  it('is deep-frozen and is a pure function of the env record passed in', () => {
    const cfg = loadConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.hashi)).toBe(true);
    expect(Object.isFrozen(TESTNET_DEFAULTS)).toBe(true);
    expect(loadConfig({ HASHI_ADAPTER: 'real' }).hashi.adapter).toBe('real');
    expect(loadConfig({}).hashi.adapter).toBe('mock');
  });
});

describe('config — env overrides and validation', () => {
  it('overrides every kind of value from the environment', () => {
    const cfg = loadConfig({
      SUI_TRANSPORT: 'jsonRpc',
      HASHI_WITHDRAWAL_MINIMUM_SATS: '50000',
      REFILL_RATE_SATS_PER_S: '7',
      WALRUS_EPOCHS: '30',
      SEAL_KEY_SERVERS: ' a , b ,, c ',
      EVENT_POLL_INTERVAL_MS: '250',
    });
    expect(cfg.sui.transport).toBe('jsonRpc');
    expect(cfg.hashi.withdrawalMinimumSats).toBe(50_000n);
    expect(cfg.limiter.refillRateSatsPerSec).toBe(7n);
    expect(cfg.walrus.epochs).toBe(30);
    expect(cfg.seal.keyServers).toEqual(['a', 'b', 'c']);
    expect(cfg.hashi.eventPollIntervalMs).toBe(250);
  });

  it('refuses WALRUS_EPOCHS=1 — a 1-epoch blob would silently expire the decision log (A8)', () => {
    expect(() => loadConfig({ WALRUS_EPOCHS: '1' })).toThrow(ConfigError);
    try {
      loadConfig({ WALRUS_EPOCHS: '1' });
    } catch (error) {
      expect((error as ConfigError).missing).toEqual(['WALRUS_EPOCHS']);
    }
  });

  it('rejects malformed values and names the offending variable', () => {
    expect(() => loadConfig({ HASHI_ADAPTER: 'live' })).toThrow(/HASHI_ADAPTER/);
    expect(() => loadConfig({ VAULT_ID: '0xnope' })).toThrow(/VAULT_ID/);
    expect(() => loadConfig({ HBTC_COIN_TYPE: 'not-a-struct-tag' })).toThrow(/HBTC_COIN_TYPE/);
    expect(() => loadConfig({ HERMES_ENDPOINT: 'not a url' })).toThrow(/HERMES_ENDPOINT/);
    expect(() => loadConfig({ EVENT_POLL_INTERVAL_MS: '1.5' })).toThrow(/EVENT_POLL_INTERVAL_MS/);
    expect(() => loadConfig({ REFILL_RATE_SATS_PER_S: '-1' })).toThrow(/REFILL_RATE_SATS_PER_S/);
  });
});

describe('config — assertRealModeComplete (docs/KEEPER.md §10 step 1: fail fast)', () => {
  it('throws ONCE listing EVERY missing variable when HASHI_ADAPTER=real', () => {
    const cfg = loadConfig({ HASHI_ADAPTER: 'real' });
    let thrown: ConfigError | undefined;
    try {
      assertRealModeComplete(cfg);
    } catch (error) {
      thrown = error as ConfigError;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown?.missing).toEqual([
      'SUI_KEEPER_ADDRESS',
      'KEEPER_KEY',
      'OWNER_KEY',
      'APHOTIC_PACKAGE_ID',
      'VAULT_ID',
      'BALANCE_MANAGER_ID',
      'TRADE_CAP_ID',
      'WALRUS_PUBLISHER',
      'WALRUS_AGGREGATOR',
      'SEAL_KEY_SERVERS',
    ]);
    // Every missing var is named in the message so one `.env` pass fixes them all.
    for (const name of thrown?.missing ?? []) {
      expect(thrown?.message).toContain(name);
    }
  });

  it('passes once every real-mode variable is set', () => {
    const id = `0x${'1'.repeat(64)}`;
    const cfg = loadConfig({
      HASHI_ADAPTER: 'real',
      SUI_KEEPER_ADDRESS: id,
      KEEPER_KEY: 'suiprivkey1-placeholder',
      OWNER_KEY: 'suiprivkey1-placeholder',
      APHOTIC_PACKAGE_ID: id,
      VAULT_ID: id,
      BALANCE_MANAGER_ID: id,
      TRADE_CAP_ID: id,
      WALRUS_PUBLISHER: 'https://publisher.example',
      WALRUS_AGGREGATOR: 'https://aggregator.example',
      SEAL_KEY_SERVERS: `${id},${id}`,
    });
    expect(() => assertRealModeComplete(cfg)).not.toThrow();
  });

  it('accepts SUI_PRIVATE_KEY as the alias for KEEPER_KEY (that is what keeper/.env uses)', () => {
    const cfg = loadConfig({ SUI_PRIVATE_KEY: 'suiprivkey1-placeholder' });
    expect(cfg.secrets.keeperKey).toBe('suiprivkey1-placeholder');
  });

  it('redactSecrets removes key material so a Config can be logged or journaled', () => {
    const material = 'suiprivkey1qqqqNEVERLOGTHISqqqq';
    const cfg = loadConfig({ KEEPER_KEY: material, OWNER_KEY: material });
    expect(cfg.secrets.keeperKey).toBe(material);

    const safe = redactSecrets(cfg);
    expect(safe.secrets.keeperKey).toBe('***');
    expect(safe.secrets.ownerKey).toBe('***');
    // Config holds bigint sats, so a journal serializer must supply a bigint replacer.
    const serialized = JSON.stringify(safe, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialized).not.toContain(material);
    expect(serialized).toContain('***');
  });
});
