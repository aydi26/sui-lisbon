// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T0.6
// @phase      0
// @status     DONE
// @spec       docs/APP.md §6 (env table, L242-L260)
// @spec       docs/BUILD-PLAN.md Phase 0 T0.4/T0.6
// @spec       docs/RECON.md R1 R4 R5 R6 R11
// @rules      G7 G9
// @depends    ./vite-env.d.ts · ../.env.example
// @facts      THIS FILE IS THE ONLY LITERAL-ID SITE IN app/. The full allow-list
// @facts        is: keeper/src/config.ts · app/src/config.ts · **/.env.example ·
// @facts        move/Move.toml. Everywhere else an id arrives as config (G7).
// @facts      HASHI_PACKAGE   = 0xfcea10ca…7f4360                (RECON R5, live)
// @facts      HASHI_OBJECT    = 0x22c0ce66…4528f8  initialSharedVersion 805474231
// @facts      HBTC_TYPE       = <HASHI_PACKAGE>::btc::BTC, 8 dec, sats  (RECON R5)
// @facts      DEEPBOOK_POOL   = 0x5cdaebf2…55ced6  initialSharedVersion 946570339
// @facts      DEEPBOOK_PKG    = 0xd874d241…bbb24  v20 CURRENT CALLABLE (RECON R4)
// @facts        ⚠ docs/FACTS.md#deepbook-venue records v17 (0x22be4cad…) — STALE.
// @facts        Type args resolve against the ORIGINAL id 0xfb28c4cb…; moveCall
// @facts        targets the CURRENT CALLABLE id.
// @facts      PYTH_FEED_ID    = 0xf9c0172b…8ea31b  BETA channel  (RECON R11, G9)
// @facts        ⚠ 0xe62df6c8… is the STABLE/mainnet id — never on testnet.
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000  (live Hashi config, RECON R6)
// @facts      HASHI_DEPOSIT_DELAY_MS    = 600_000 (stage 4 of the 6-stage flow)
// @facts      HASHI_CANCEL_COOLDOWN_MS  = 3_600_000
// @facts      BITCOIN_DUST_FLOOR_SATS   = 546
// @facts      EXIT_ADDR_LEN ∈ {20 P2WPKH, 32 P2TR}
// @facts      WALRUS_AGGREGATOR is UNKNOWN — U7 / docs/DAY-ONE.md D8. Empty by
// @facts        default; do NOT invent an endpoint.
// @implements export type DemoMode = 'mock' | 'live'
//             export interface AppConfig
//             export const config: AppConfig
//             export function assertConfigured(keys): void
// @forbidden  `number` for sats — all money is bigint
// @forbidden  reading import.meta.env from any other module — G7
// @invariant  1. Every field is derived from import.meta.env with a documented
//                default; no component ever sees a raw env var.
// @invariant  2. Sats-valued fields are bigint.
// @ac         docs/APP.md §7 A10 — `rg '0x[a-f0-9]{16,}' src/screens src/components`
//             returns nothing.
// @verify     cd app && npx tsc --noEmit
// @verify     git grep -n 0x5cdaebf264 app/src   # only this file
// └── END CONTRACT ───────────────────────────────────────────────────────────

export type DemoMode = 'mock' | 'live';

/** Hashi testnet package. Every hBTC type/id below is namespaced under it. */
const HASHI_PACKAGE_ID =
  '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360';

// ── env readers ──────────────────────────────────────────────────────────────

function readString(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim();
  return v.length > 0 ? v : fallback;
}

function readSats(raw: string | undefined, fallback: bigint): bigint {
  const v = (raw ?? '').trim();
  if (v.length === 0) return fallback;
  try {
    return BigInt(v);
  } catch {
    return fallback;
  }
}

function readInt(raw: string | undefined, fallback: number): number {
  const v = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(v) ? v : fallback;
}

function readDemoMode(raw: string | undefined): DemoMode {
  return readString(raw, 'mock') === 'live' ? 'live' : 'mock';
}

// ── shape ────────────────────────────────────────────────────────────────────

export interface AppConfig {
  readonly demoMode: DemoMode;

  readonly sui: {
    /** 'testnet'. Bitcoin side is signet. */
    readonly network: string;
    /** DEFAULT read transport — the testnet fullnode is gRPC-v2-only (RECON R1). */
    readonly grpcUrl: string;
    /** JSON-RPC mirror, required because dapp-kit is typed to SuiJsonRpcClient. */
    readonly jsonRpcUrl: string;
  };

  readonly aphotic: {
    /** '' until the package is published (DAY-ONE). */
    readonly packageId: string;
    /** '' until the shared Vault exists (DAY-ONE). */
    readonly vaultId: string;
  };

  readonly hashi: {
    readonly packageId: string;
    readonly objectId: string;
    readonly hbtcType: string;
    /** Hashi rejects withdrawals below this — EBelowMinimumWithdrawal. */
    readonly withdrawalMinSats: bigint;
    readonly depositMinSats: bigint;
    /** Mandatory post-approval delay: stage 4 of the 6-stage deposit lifecycle. */
    readonly depositDelayMs: number;
    /** Signet confirmations required: stage 2. */
    readonly confirmations: number;
    /** cancel_withdrawal cooldown (reclaim path). */
    readonly cancelCooldownMs: number;
  };

  readonly deepbook: {
    readonly poolId: string;
    readonly dbusdcType: string;
    /** moveCall target (v20). */
    readonly packageId: string;
    /** Type-argument origin (v1). */
    readonly originalPackageId: string;
  };

  readonly pyth: {
    readonly stateId: string;
    readonly packageId: string;
    readonly hermesUrl: string;
    /** BETA-channel BTC/USD feed. Testnet only ever uses this one (G9). */
    readonly feedId: string;
  };

  readonly walrus: {
    /** '' until DAY-ONE D8 resolves U7. */
    readonly aggregatorUrl: string;
  };

  readonly zkLogin: {
    /**
     * Enoki PUBLIC api key from https://portal.enoki.mystenlabs.com.
     * Public by design (it is shipped to the browser). The Enoki *private* key
     * and the Google OAuth *client secret* must NEVER appear in this app.
     */
    readonly enokiApiKey: string;
    /** Google OAuth client id (public). Registered in the Enoki portal too. */
    readonly googleClientId: string;
    /**
     * OAuth redirect target. Empty ⇒ Enoki defaults to `window.location.origin`.
     * Whatever is used here must be allow-listed in BOTH the Enoki portal and
     * the Google Cloud console, or the popup returns `redirect_uri_mismatch`.
     */
    readonly redirectUrl: string;
    /**
     * Optional custom gas-sponsor endpoint. Empty ⇒ Enoki sponsors natively
     * from its own gas pool, which is the supported path (docs/APP.md T3.3).
     */
    readonly sponsorUrl: string;
  };

  readonly keeper: {
    /** Backs the Transparency "Re-derive congestion from Hashi events" button. */
    readonly verifyUrl: string;
  };

  readonly explorers: {
    readonly signet: string;
    readonly sui: string;
  };

  /** Protocol constants that are NOT env-tunable. */
  readonly constants: {
    /** Bitcoin dust floor. */
    readonly dustFloorSats: bigint;
    /** hBTC decimals — amounts are sats (u64 on-chain, bigint here). */
    readonly hbtcDecimals: number;
    /** Valid pinned-exit-address byte lengths: 20 = P2WPKH, 32 = P2TR. */
    readonly exitAddressLengths: readonly number[];
    /** Deposit lifecycle stage count (docs/APP.md §2.2). */
    readonly depositStages: number;
  };
}

const env = import.meta.env;

export const config: AppConfig = {
  demoMode: readDemoMode(env.VITE_DEMO_MODE),

  sui: {
    network: readString(env.VITE_SUI_NETWORK, 'testnet'),
    grpcUrl: readString(env.VITE_SUI_GRPC_URL, 'https://fullnode.testnet.sui.io:443'),
    jsonRpcUrl: readString(env.VITE_SUI_JSONRPC_URL, 'https://rpc-testnet.suiscan.xyz:443'),
  },

  aphotic: {
    packageId: readString(env.VITE_APHOTIC_PACKAGE_ID, ''),
    vaultId: readString(env.VITE_VAULT_ID, ''),
  },

  hashi: {
    packageId: readString(env.VITE_HASHI_PACKAGE_ID, HASHI_PACKAGE_ID),
    objectId: readString(
      env.VITE_HASHI_OBJECT_ID,
      '0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8',
    ),
    hbtcType: readString(env.VITE_HBTC_TYPE, `${HASHI_PACKAGE_ID}::btc::BTC`),
    withdrawalMinSats: readSats(env.VITE_HASHI_WITHDRAWAL_MIN_SATS, 30_000n),
    depositMinSats: readSats(env.VITE_HASHI_DEPOSIT_MIN_SATS, 30_000n),
    depositDelayMs: readInt(env.VITE_HASHI_DEPOSIT_DELAY_MS, 600_000),
    confirmations: readInt(env.VITE_HASHI_CONFIRMATIONS, 6),
    cancelCooldownMs: readInt(env.VITE_HASHI_CANCEL_COOLDOWN_MS, 3_600_000),
  },

  deepbook: {
    poolId: readString(
      env.VITE_DEEPBOOK_POOL,
      '0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6',
    ),
    dbusdcType: readString(
      env.VITE_DBUSDC_TYPE,
      '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
    ),
    packageId: readString(
      env.VITE_DEEPBOOK_PACKAGE,
      '0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24',
    ),
    originalPackageId: readString(
      env.VITE_DEEPBOOK_ORIGINAL_PACKAGE,
      '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982',
    ),
  },

  pyth: {
    stateId: readString(
      env.VITE_PYTH_STATE,
      '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
    ),
    packageId: readString(
      env.VITE_PYTH_PACKAGE,
      '0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837',
    ),
    hermesUrl: readString(env.VITE_PYTH_HERMES_URL, 'https://hermes-beta.pyth.network'),
    feedId: readString(
      env.VITE_PYTH_FEED_ID,
      '0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b',
    ),
  },

  walrus: {
    // U7 resolved by DAY-ONE D8 (real PUT -> GET round trip, 2026-07-25).
    aggregatorUrl: readString(
      env.VITE_WALRUS_AGGREGATOR,
      'https://aggregator.walrus-testnet.walrus.space',
    ),
  },

  zkLogin: {
    enokiApiKey: readString(env.VITE_ENOKI_API_KEY, ''),
    googleClientId: readString(env.VITE_ZKLOGIN_CLIENT_ID, ''),
    redirectUrl: readString(env.VITE_ENOKI_REDIRECT_URL, ''),
    sponsorUrl: readString(env.VITE_SPONSOR_URL, ''),
  },

  keeper: {
    verifyUrl: readString(env.VITE_KEEPER_VERIFY_URL, 'http://localhost:8787'),
  },

  explorers: {
    signet: readString(env.VITE_SIGNET_EXPLORER, 'https://mempool.space/signet'),
    sui: readString(env.VITE_SUI_EXPLORER, 'https://suiscan.xyz/testnet'),
  },

  constants: {
    dustFloorSats: 546n,
    hbtcDecimals: 8,
    exitAddressLengths: [20, 32],
    depositStages: 6,
  },
};

/** Env keys that are UNKNOWN until docs/DAY-ONE.md is executed. */
export const DAY_ONE_BLANKS = [
  'VITE_APHOTIC_PACKAGE_ID',
  'VITE_VAULT_ID',
  'VITE_WALRUS_AGGREGATOR',
  'VITE_ENOKI_API_KEY',
  'VITE_ZKLOGIN_CLIENT_ID',
] as const;

/**
 * Returns the DAY_ONE_BLANKS that are still empty. `live` mode must refuse to
 * run while this is non-empty; `mock` mode ignores it entirely (G6/G7).
 */
export function missingLiveConfig(): string[] {
  const present: Record<(typeof DAY_ONE_BLANKS)[number], string> = {
    VITE_APHOTIC_PACKAGE_ID: config.aphotic.packageId,
    VITE_VAULT_ID: config.aphotic.vaultId,
    VITE_WALRUS_AGGREGATOR: config.walrus.aggregatorUrl,
    VITE_ENOKI_API_KEY: config.zkLogin.enokiApiKey,
    VITE_ZKLOGIN_CLIENT_ID: config.zkLogin.googleClientId,
  };
  return DAY_ONE_BLANKS.filter((k) => present[k].length === 0);
}

export const isMock = (): boolean => config.demoMode === 'mock';
