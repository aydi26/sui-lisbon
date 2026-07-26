// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T0.6
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §12 (environment variables)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.3 keeper scaffold, T0.6 config wiring proof)
// @spec       docs/RECON.md#r1 #r4 #r5 #r6 #r9 #r11 (every literal below was verified LIVE 2026-07-25)
// @rules      G5 G7 G9 G10
// @depends    ./util/env.ts · ./util/errors.ts
// @facts      ★ THIS FILE AND `.env.example` ARE THE ONLY PLACES A CANONICAL ID MAY APPEAR (G7).
// @facts      HASHI_PACKAGE_ID            = 0xfcea10ca…  (RECON R5, immutable v1)
// @facts      HASHI_OBJECT_ID             = 0x22c0ce66…  initialSharedVersion 805474231 (RECON R5)
// @facts      HBTC_COIN_TYPE              = <hashi pkg>::btc::BTC, 8 dec, sats (RECON R5)
// @facts      DEEPBOOK_POOL               = 0x5cdaebf2…  initialSharedVersion 946570339 (RECON R5)
// @facts      DEEPBOOK_PACKAGE_ID         = 0xd874d241…  v20 CALLABLE  (RECON R4)
// @facts      DEEPBOOK_ORIGINAL_PACKAGE_ID= 0xfb28c4cb…  v1 TYPE-ORIGIN (RECON R4)
// @facts        ⇒ moveCall targets the CALLABLE id; type args resolve against the ORIGINAL id.
// @facts      PYTH_BTC_USD_FEED_ID        = 0xf9c0172b…  ★ BETA channel (RECON R11) — never the stable id (G9)
// @facts      HERMES_ENDPOINT             = https://hermes-beta.pyth.network (RECON R11)
// @facts      Live Hashi config (RECON R6): deposit delay 600_000 ms · deposit min 30_000 sats ·
// @facts        withdrawal min 30_000 sats · confirmation threshold 6 · cancel cooldown 3_600_000 ms
// @facts      Limiter genesis scalars (RECON R9, U1 BOUND — not a verified fact):
// @facts        REFILL_RATE_SATS_PER_S = 1000 · MAX_BUCKET_CAPACITY_SATS = 100_000_000
// @facts      DeepBook Pool<hBTC,DBUSDC>: tick 1_000_000 · lot 1_000 · min_size 100_000 (FACTS #deepbook-pool)
// @facts      WALRUS_EPOCHS default 12 — NEVER 1 (KEEPER.md §8: 1-epoch default is a liveness risk)
// @facts      Sui RPC: gRPC v2 at https://fullnode.testnet.sui.io:443 is the DEFAULT transport.
// @facts        That host's JSON-RPC is 404/removed (RECON R1) ⇒ JSON-RPC uses the verified mirrors.
// @implements export const TESTNET_DEFAULTS
// @implements export function loadConfig(env?: EnvRecord): Config
// @implements export function assertRealModeComplete(cfg: Config): void
// @implements export function redactSecrets<T>(value: T): T
// @forbidden  any canonical id literal in ANY other .ts file — G7, checked by the T0.6 grep gate
// @forbidden  a private key default of any kind; keys arrive from `keeper/.env` only
// @invariant  1. TESTNET_DEFAULTS is deep-frozen; loadConfig never mutates it.
// @invariant  2. loadConfig is a PURE function of the EnvRecord passed in.
// @invariant  3. walrusEpochs >= 2 always (never the 1-epoch Walrus default).
// @invariant  4. In `real` mode assertRealModeComplete lists EVERY missing var in one throw.
// @ac         docs/BUILD-PLAN.md T0.6 — `git grep -n 0x5cdaebf264 keeper app` hits config/.env.example only
// @verify     npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  readBigInt,
  readEnum,
  readInt,
  readList,
  readObjectId,
  readOptional,
  readString,
  readStructTag,
  readUrl,
  type EnvRecord,
} from './util/env.js';
import { ConfigError } from './util/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical values. THIS RECORD IS THE ONLY LITERAL-ID SITE IN src/ (G7).
// ─────────────────────────────────────────────────────────────────────────────

const HASHI_PACKAGE_ID = '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360';
const DBUSDC_PACKAGE_ID = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7';

export const TESTNET_DEFAULTS = deepFreeze({
  // ── Sui network / transport (RECON R1) ────────────────────────────────────
  suiNetwork: 'testnet',
  /** Default transport. The testnet fullnode serves gRPC v2 ONLY. */
  suiTransport: 'grpc' as const,
  suiGrpcUrl: 'https://fullnode.testnet.sui.io:443',
  /**
   * JSON-RPC is OPT-IN (probes / cross-checks). `fullnode.testnet.sui.io` returns 404 for
   * JSON-RPC, so the default is the first verified mirror (chain id 4c78adac).
   */
  suiJsonRpcUrl: 'https://rpc-testnet.suiscan.xyz:443',
  suiJsonRpcMirrors: [
    'https://rpc-testnet.suiscan.xyz:443',
    'https://sui-testnet-rpc.publicnode.com',
    'https://sui-testnet.nodeinfra.com',
  ] as const,

  // ── Hashi (RECON R5 + R6) ─────────────────────────────────────────────────
  hashiAdapter: 'mock' as const,
  hashiPackageId: HASHI_PACKAGE_ID,
  hashiObjectId: '0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8',
  /** Shared-object initial version — required to build a PTB shared-object input. */
  hashiObjectInitialSharedVersion: 805_474_231,
  hbtcCoinType: `${HASHI_PACKAGE_ID}::btc::BTC`,
  hbtcDecimals: 8,
  guardianUrl: 'https://guardian.testnet.hashi.sui.io',
  /** Live on-chain `bitcoin_deposit_time_delay_ms`. */
  bitcoinDepositTimeDelayMs: 600_000,
  /** Live on-chain `bitcoin_deposit_minimum` (sats). */
  bitcoinDepositMinimumSats: 30_000n,
  /** Live on-chain `bitcoin_withdrawal_minimum` (sats). ⚠ the accessor is public(package) — inject it. */
  bitcoinWithdrawalMinimumSats: 30_000n,
  /** Live on-chain `bitcoin_confirmation_threshold`. */
  bitcoinConfirmationThreshold: 6,
  /** Live on-chain `withdrawal_cancellation_cooldown_ms` (1 h). */
  withdrawalCancellationCooldownMs: 3_600_000,
  /** Bitcoin dust floor (sats) — docs/FACTS.md#latencies. */
  bitcoinDustFloorSats: 546n,

  // ── Guardian limiter genesis scalars (RECON R9 — U1 BOUND, not a fact) ────
  refillRateSatsPerSec: 1_000n,
  maxBucketCapacitySats: 100_000_000n,

  // ── DeepBook (RECON R4 + R5, FACTS #deepbook-pool) ────────────────────────
  deepbookPackageId: '0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24',
  deepbookOriginalPackageId: '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982',
  deepbookPoolId: '0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6',
  deepbookPoolInitialSharedVersion: 946_570_339,
  dbusdcCoinType: `${DBUSDC_PACKAGE_ID}::DBUSDC::DBUSDC`,
  dbusdcDecimals: 6,
  deepbookTickSize: 1_000_000n,
  deepbookLotSize: 1_000n,
  deepbookMinSize: 100_000n,

  // ── Pyth (RECON R11) — BETA channel on testnet (G9) ───────────────────────
  pythStateId: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
  pythPackageId: '0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837',
  wormholeStateId: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
  pythBtcUsdFeedId: '0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b',
  hermesEndpoint: 'https://hermes-beta.pyth.network',
  pythMaxStalenessMs: 60_000,
  oracleDivergenceBps: 200,
  twapWindowMs: 300_000,

  // ── Walrus / Seal ─────────────────────────────────────────────────────────
  /** NEVER 1 — a 1-epoch blob is a liveness risk for the decision log (KEEPER.md §8). */
  walrusEpochs: 12,
  sealThreshold: 2,
  sealVersionEpoch: 0,

  // ── Keeper loop knobs ─────────────────────────────────────────────────────
  makerTimeoutMs: 15_000,
  logPublishLagMs: 60_000,
  /** Generous: withdrawal end-to-end is ~1.5–2 h (G6 — never live-demoed). */
  hashiWaitTimeoutMs: 9_000_000,
  eventPollIntervalMs: 3_000,
});

export type TestnetDefaults = typeof TESTNET_DEFAULTS;

// ─────────────────────────────────────────────────────────────────────────────
// Config shape
// ─────────────────────────────────────────────────────────────────────────────

export type HashiAdapterKind = 'mock' | 'real';
export type SuiTransportKind = 'grpc' | 'jsonRpc';

export interface SuiConfig {
  readonly network: string;
  readonly transport: SuiTransportKind;
  readonly grpcUrl: string;
  readonly jsonRpcUrl: string;
  readonly jsonRpcMirrors: readonly string[];
  /** Keeper's Sui address. Holds the DeepBook `TradeCap` and NOTHING else (G2). */
  readonly keeperAddress: string;
}

/**
 * Everything the Hashi adapter needs. Mirrors the live on-chain `Hashi` config
 * (docs/RECON.md R6) so the MOCK is seeded from reality.
 */
export interface HashiConfig {
  readonly adapter: HashiAdapterKind;
  readonly packageId: string;
  readonly objectId: string;
  readonly objectInitialSharedVersion: number;
  readonly hbtcCoinType: string;
  readonly hbtcDecimals: number;
  readonly guardianUrl: string;
  readonly depositTimeDelayMs: number;
  readonly depositMinimumSats: bigint;
  readonly withdrawalMinimumSats: bigint;
  readonly confirmationThreshold: number;
  readonly cancellationCooldownMs: number;
  readonly dustFloorSats: bigint;
  readonly waitTimeoutMs: number;
  readonly eventPollIntervalMs: number;
}

/**
 * The two genesis scalars are the ONLY trust anchors of the G5 replay
 * (docs/KEEPER.md §9.2). Field names match `@mysten/hashi`'s `GuardianLimiterConfig`
 * so the shapes are structurally interchangeable without importing the SDK here.
 */
export interface LimiterConfig {
  readonly refillRateSatsPerSec: bigint;
  readonly maxBucketCapacitySats: bigint;
}

export interface DeepbookConfig {
  /** Current CALLABLE package (v20) — `moveCall` targets. */
  readonly packageId: string;
  /** Original/type-origin package (v1) — TYPE ARGUMENTS resolve here. */
  readonly originalPackageId: string;
  readonly poolId: string;
  readonly poolInitialSharedVersion: number;
  readonly dbusdcCoinType: string;
  readonly dbusdcDecimals: number;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minSize: bigint;
  readonly balanceManagerId: string;
  readonly tradeCapId: string;
}

export interface PythConfig {
  readonly stateId: string;
  readonly packageId: string;
  readonly wormholeStateId: string;
  /** BETA-channel BTC/USD feed id — testnet only (G9). */
  readonly btcUsdFeedId: string;
  readonly hermesEndpoint: string;
  readonly maxStalenessMs: number;
  readonly divergenceBps: number;
  readonly twapWindowMs: number;
}

export interface AphoticConfig {
  /** `published-at` — what a `moveCall` target must name. Changes on every upgrade. */
  readonly packageId: string;
  /**
   * `original-id` — the FIRST-PUBLISHED package. Type arguments, struct-type filters and Seal's
   * IBE namespace resolve against this FOREVER; it never changes across upgrades.
   *
   * Empty ⇒ never upgraded, so it equals {@link packageId}. Callers must use
   * `originalPackageId || packageId`, never `packageId` alone, for anything type-shaped.
   */
  readonly originalPackageId: string;
  readonly vaultId: string;
}

export interface WalrusConfig {
  readonly publisher: string;
  readonly aggregator: string;
  /** Always >= 2 (invariant 3). */
  readonly epochs: number;
}

export interface SealConfig {
  readonly threshold: number;
  readonly keyServers: readonly string[];
  readonly versionEpoch: number;
}

export interface KeeperLoopConfig {
  readonly makerTimeoutMs: number;
  readonly logPublishLagMs: number;
}

/** Secrets. NEVER logged, journaled, or serialized (see `redactSecrets`). */
export interface SecretsConfig {
  /** `KEEPER_KEY`, falling back to `SUI_PRIVATE_KEY` (what `keeper/.env` uses). */
  readonly keeperKey: string | undefined;
  readonly ownerKey: string | undefined;
}

export interface Config {
  readonly sui: SuiConfig;
  readonly hashi: HashiConfig;
  readonly limiter: LimiterConfig;
  readonly deepbook: DeepbookConfig;
  readonly pyth: PythConfig;
  readonly aphotic: AphoticConfig;
  readonly walrus: WalrusConfig;
  readonly seal: SealConfig;
  readonly loop: KeeperLoopConfig;
  readonly secrets: SecretsConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a `Config` from an environment record. PURE — pass `process.env` explicitly
 * at the composition root; never read it implicitly from inside a module.
 */
export function loadConfig(env: EnvRecord = process.env): Config {
  const d = TESTNET_DEFAULTS;

  const walrusEpochs = readInt(env, 'WALRUS_EPOCHS', d.walrusEpochs);
  if (walrusEpochs < 2) {
    // KEEPER.md §8 / A8: a 1-epoch blob expires almost immediately — the decision
    // log would stop being verifiable. Refuse it loudly rather than defaulting.
    throw new ConfigError(`WALRUS_EPOCHS must be >= 2 (never the 1-epoch Walrus default) — got ${walrusEpochs}`, [
      'WALRUS_EPOCHS',
    ]);
  }

  const sealThreshold = readInt(env, 'SEAL_THRESHOLD', d.sealThreshold);
  if (sealThreshold < 1) {
    throw new ConfigError(`SEAL_THRESHOLD must be >= 1 — got ${sealThreshold}`, ['SEAL_THRESHOLD']);
  }

  const config: Config = {
    sui: {
      network: readString(env, 'SUI_NETWORK', d.suiNetwork),
      transport: readEnum<SuiTransportKind>(env, 'SUI_TRANSPORT', ['grpc', 'jsonRpc'], d.suiTransport),
      grpcUrl: readUrl(env, 'SUI_GRPC_URL', d.suiGrpcUrl),
      jsonRpcUrl: readUrl(env, 'SUI_JSON_RPC_URL', d.suiJsonRpcUrl),
      jsonRpcMirrors: readList(env, 'SUI_JSON_RPC_MIRRORS', d.suiJsonRpcMirrors),
      keeperAddress: readObjectId(env, 'SUI_KEEPER_ADDRESS', ''),
    },
    hashi: {
      adapter: readEnum<HashiAdapterKind>(env, 'HASHI_ADAPTER', ['mock', 'real'], d.hashiAdapter),
      packageId: readObjectId(env, 'HASHI_PACKAGE_ID', d.hashiPackageId),
      objectId: readObjectId(env, 'HASHI_OBJECT_ID', d.hashiObjectId),
      objectInitialSharedVersion: readInt(
        env,
        'HASHI_OBJECT_INITIAL_SHARED_VERSION',
        d.hashiObjectInitialSharedVersion,
      ),
      hbtcCoinType: readStructTag(env, 'HBTC_COIN_TYPE', d.hbtcCoinType),
      hbtcDecimals: readInt(env, 'HBTC_DECIMALS', d.hbtcDecimals),
      guardianUrl: readUrl(env, 'HASHI_GUARDIAN_URL', d.guardianUrl),
      depositTimeDelayMs: readInt(env, 'HASHI_DEPOSIT_TIME_DELAY_MS', d.bitcoinDepositTimeDelayMs),
      depositMinimumSats: readBigInt(env, 'HASHI_DEPOSIT_MINIMUM_SATS', d.bitcoinDepositMinimumSats),
      withdrawalMinimumSats: readBigInt(env, 'HASHI_WITHDRAWAL_MINIMUM_SATS', d.bitcoinWithdrawalMinimumSats),
      confirmationThreshold: readInt(env, 'HASHI_CONFIRMATION_THRESHOLD', d.bitcoinConfirmationThreshold),
      cancellationCooldownMs: readInt(
        env,
        'HASHI_CANCELLATION_COOLDOWN_MS',
        d.withdrawalCancellationCooldownMs,
      ),
      dustFloorSats: readBigInt(env, 'BITCOIN_DUST_FLOOR_SATS', d.bitcoinDustFloorSats),
      waitTimeoutMs: readInt(env, 'HASHI_WAIT_TIMEOUT_MS', d.hashiWaitTimeoutMs),
      eventPollIntervalMs: readInt(env, 'EVENT_POLL_INTERVAL_MS', d.eventPollIntervalMs),
    },
    limiter: {
      refillRateSatsPerSec: readBigInt(env, 'REFILL_RATE_SATS_PER_S', d.refillRateSatsPerSec),
      maxBucketCapacitySats: readBigInt(env, 'MAX_BUCKET_CAPACITY_SATS', d.maxBucketCapacitySats),
    },
    deepbook: {
      packageId: readObjectId(env, 'DEEPBOOK_PACKAGE_ID', d.deepbookPackageId),
      originalPackageId: readObjectId(env, 'DEEPBOOK_ORIGINAL_PACKAGE_ID', d.deepbookOriginalPackageId),
      poolId: readObjectId(env, 'DEEPBOOK_POOL', d.deepbookPoolId),
      poolInitialSharedVersion: readInt(
        env,
        'DEEPBOOK_POOL_INITIAL_SHARED_VERSION',
        d.deepbookPoolInitialSharedVersion,
      ),
      dbusdcCoinType: readStructTag(env, 'DBUSDC_COIN_TYPE', d.dbusdcCoinType),
      dbusdcDecimals: readInt(env, 'DBUSDC_DECIMALS', d.dbusdcDecimals),
      tickSize: readBigInt(env, 'DEEPBOOK_TICK_SIZE', d.deepbookTickSize),
      lotSize: readBigInt(env, 'DEEPBOOK_LOT_SIZE', d.deepbookLotSize),
      minSize: readBigInt(env, 'DEEPBOOK_MIN_SIZE', d.deepbookMinSize),
      balanceManagerId: readObjectId(env, 'BALANCE_MANAGER_ID', ''),
      tradeCapId: readObjectId(env, 'TRADE_CAP_ID', ''),
    },
    pyth: {
      stateId: readObjectId(env, 'PYTH_STATE_ID', d.pythStateId),
      packageId: readObjectId(env, 'PYTH_PACKAGE_ID', d.pythPackageId),
      wormholeStateId: readObjectId(env, 'WORMHOLE_STATE_ID', d.wormholeStateId),
      btcUsdFeedId: readObjectId(env, 'PYTH_BTC_USD_FEED_ID', d.pythBtcUsdFeedId),
      hermesEndpoint: readUrl(env, 'HERMES_ENDPOINT', d.hermesEndpoint),
      maxStalenessMs: readInt(env, 'PYTH_MAX_STALENESS_MS', d.pythMaxStalenessMs),
      divergenceBps: readInt(env, 'ORACLE_DIVERGENCE_BPS', d.oracleDivergenceBps),
      twapWindowMs: readInt(env, 'TWAP_WINDOW_MS', d.twapWindowMs),
    },
    aphotic: {
      packageId: readObjectId(env, 'APHOTIC_PACKAGE_ID', ''),
      // Defaults to `published-at`: a package that was never upgraded has one id, and that is
      // the ONLY case where the two may be conflated.
      originalPackageId: readObjectId(
        env,
        'APHOTIC_ORIGINAL_PACKAGE_ID',
        readObjectId(env, 'APHOTIC_PACKAGE_ID', ''),
      ),
      vaultId: readObjectId(env, 'VAULT_ID', ''),
    },
    walrus: {
      publisher: readUrl(env, 'WALRUS_PUBLISHER', ''),
      aggregator: readUrl(env, 'WALRUS_AGGREGATOR', ''),
      epochs: walrusEpochs,
    },
    seal: {
      threshold: sealThreshold,
      keyServers: readList(env, 'SEAL_KEY_SERVERS', []),
      versionEpoch: readInt(env, 'SEAL_VERSION_EPOCH', d.sealVersionEpoch),
    },
    loop: {
      makerTimeoutMs: readInt(env, 'MAKER_TIMEOUT_MS', d.makerTimeoutMs),
      logPublishLagMs: readInt(env, 'LOG_PUBLISH_LAG_MS', d.logPublishLagMs),
    },
    secrets: {
      // `keeper/.env` writes SUI_PRIVATE_KEY; KEEPER.md §12 calls it KEEPER_KEY. Accept both.
      keeperKey: readOptional(env, 'KEEPER_KEY') ?? readOptional(env, 'SUI_PRIVATE_KEY'),
      ownerKey: readOptional(env, 'OWNER_KEY'),
    },
  };

  return deepFreeze(config);
}

/** Variables with no safe default: required before ANY `real`-mode work. */
const REAL_MODE_REQUIREMENTS: readonly {
  readonly envVar: string;
  readonly get: (cfg: Config) => string | readonly string[] | undefined;
  readonly why: string;
}[] = [
  { envVar: 'SUI_KEEPER_ADDRESS', get: (c) => c.sui.keeperAddress, why: 'keeper identity (TradeCap holder, G2)' },
  { envVar: 'KEEPER_KEY', get: (c) => c.secrets.keeperKey, why: 'signs trade PTBs + the confirm_deposit crank' },
  { envVar: 'OWNER_KEY', get: (c) => c.secrets.ownerKey, why: 'vault creation + sponsored sweeps' },
  { envVar: 'APHOTIC_PACKAGE_ID', get: (c) => c.aphotic.packageId, why: 'published `aphotic` Move package' },
  { envVar: 'VAULT_ID', get: (c) => c.aphotic.vaultId, why: 'shared Vault object' },
  { envVar: 'BALANCE_MANAGER_ID', get: (c) => c.deepbook.balanceManagerId, why: 'DeepBook custody' },
  { envVar: 'TRADE_CAP_ID', get: (c) => c.deepbook.tradeCapId, why: 'the ONLY capability the keeper holds (G2)' },
  { envVar: 'WALRUS_PUBLISHER', get: (c) => c.walrus.publisher, why: 'decision-log writes' },
  { envVar: 'WALRUS_AGGREGATOR', get: (c) => c.walrus.aggregator, why: 'decision-log reads' },
  { envVar: 'SEAL_KEY_SERVERS', get: (c) => c.seal.keyServers, why: 'Seal threshold decryption' },
];

/**
 * Fail fast before any live work (docs/KEEPER.md §10 step 1). No-op in `mock` mode —
 * G7 requires the whole system to run offline with zero Hashi/Walrus/Seal identifiers set.
 * Throws ONCE listing EVERY missing variable, so the operator fixes `.env` in a single pass.
 */
export function assertRealModeComplete(cfg: Config): void {
  if (cfg.hashi.adapter !== 'real') return;

  const missing: string[] = [];
  const details: string[] = [];
  for (const req of REAL_MODE_REQUIREMENTS) {
    const value = req.get(cfg);
    const empty = value === undefined || (typeof value === 'string' ? value === '' : value.length === 0);
    if (empty) {
      missing.push(req.envVar);
      details.push(`  - ${req.envVar}: ${req.why}`);
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `HASHI_ADAPTER=real requires ${missing.length} unset variable(s):\n${details.join('\n')}`,
      missing,
    );
  }
}

/** Replace secret values with `***` so a Config can be safely logged/journaled. */
export function redactSecrets(cfg: Config): Config {
  return {
    ...cfg,
    secrets: {
      keeperKey: cfg.secrets.keeperKey === undefined ? undefined : '***',
      ownerKey: cfg.secrets.ownerKey === undefined ? undefined : '***',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
