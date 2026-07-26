// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §5 (repository layout / object graph), §7 (mechanisms)
// @spec       docs/DESIGN-V2.md §9 (D9 Seal committee), §10 D10 (validator floor),
//             §11 (denomination ladder)
// @rules      G7 G8
// @depends    ./vite-env.d.ts · ../.env.example
// @facts      THIS FILE IS THE ONLY LITERAL-ID SITE IN app/. The full allow-list is
// @facts        keeper/src/config.ts · app/src/config.ts · **/.env.example ·
// @facts        move/Move.toml. Everywhere else an id arrives as config (G7).
// @facts      ⚠⚠ `import.meta.env.VITE_*` is INLINED AT BUILD TIME. A var missing
// @facts        from the build environment is a BROKEN DEPLOY, not a runtime error —
// @facts        the bundle simply contains "". Hence configProblems(): the app says
// @facts        so loudly, on screen, instead of rendering a dead button.
// @facts      HASHI_PACKAGE = 0xfcea10ca…7f4360           (RECON R5, live testnet)
// @facts      HBTC_TYPE     = <HASHI_PACKAGE>::btc::BTC, 8 decimals, sats (RECON R5)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000          (RECON R6, live config)
// @facts      DENOMINATIONS = [1e6, 1e7, 1e8, 1e9] sats = 0.01/0.1/1/10 hBTC
// @facts        (DESIGN-V2 §11). The floor 1_000_000 sits far above Hashi's
// @facts        30_000-sat withdrawal minimum, so EVERY tier is individually
// @facts        redeemable. Denominations are APPEND-ONLY: repricing a live tier
// @facts        would revalue live notes.
// @facts      CADENCE_MS = 43_200_000 · OFFSET_MS = 21_600_000 ⇒ 06:00/18:00 UTC
// @facts        (DESIGN-V2 §4). Mechanical, never operator-chosen.
// @facts      SEAL: n = 5 key servers across 5 DISTINCT OPERATORS, t = 3 (D9).
// @facts        Count operators, not servers. Never fall back to plaintext.
// @facts      VALIDATOR COLLUSION FLOOR: protocol floor 7, live testnet 32 (D10).
// @facts        Always both numbers, always labelled.
// @facts      Every Aphotic object id below is EMPTY until the v2 package is
// @facts        published. Do NOT invent one — an empty id disables the write path
// @facts        and says why (see configProblems).
// @implements export interface AppConfig
//             export const config: AppConfig
//             export function configProblems(): ConfigProblem[]
//             export function isWired(...keys): boolean
// @forbidden  `number` for sats — all money is bigint
// @forbidden  reading import.meta.env from any other module — G7
// @forbidden  a fabricated default for an on-chain id — empty means "not wired"
// @invariant  1. Every field is derived from import.meta.env with a documented
//                default; no component ever sees a raw env var.
// @invariant  2. Sats-valued fields are bigint.
// @invariant  3. configProblems() is pure and never throws.
// @ac         `rg '0x[a-f0-9]{16,}' src/screens src/components` returns nothing.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

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

/** Comma- or whitespace-separated list. Empty entries are dropped. */
function readList(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── shape ────────────────────────────────────────────────────────────────────

export interface AppConfig {
  readonly sui: {
    /** 'testnet'. */
    readonly network: string;
    /** DEFAULT read transport — the testnet fullnode is gRPC-v2-only (RECON R1). */
    readonly grpcUrl: string;
    /** JSON-RPC mirror, required because dapp-kit is typed to SuiJsonRpcClient. */
    readonly jsonRpcUrl: string;
  };

  /**
   * Our own package and its shared objects. Every one of these is '' until the
   * v2 Move package is published; the screens must render "not wired" rather
   * than a control that cannot work.
   */
  readonly aphotic: {
    /** moveCall target (the CURRENT published-at id). */
    readonly packageId: string;
    /** Type-argument origin. Diverges from packageId the moment we upgrade. */
    readonly originalPackageId: string;
    /** Shared `Vault` — shares, NAV lifecycle, fees. */
    readonly vaultId: string;
    /** Shared governance object — caps, pause state, governed parameters. */
    readonly governanceId: string;
    /** Shared `BatchRegistry` — cadence, policy version, live batch pointer. */
    readonly batchRegistryId: string;
    /** Shared `NoteTree` — the append-only commitment tree. */
    readonly noteTreeId: string;
    /** Shared `NullifierSet` — single-use spend tags. */
    readonly nullifierSetId: string;
    /** Shared `BalanceLedger` — escrow custody, held OUTSIDE vault NAV (D7). */
    readonly balanceLedgerId: string;
    /** Shared `AdapterAllowlist` — the pinned lending-adapter destinations. */
    readonly adapterAllowlistId: string;
  };

  readonly hashi: {
    readonly packageId: string;
    readonly objectId: string;
    readonly hbtcType: string;
    /** Hashi rejects withdrawals below this. */
    readonly withdrawalMinSats: bigint;
    readonly depositMinSats: bigint;
    /** Signet confirmations required before a deposit is approved. */
    readonly confirmations: number;
    /** cancel_withdrawal cooldown. */
    readonly cancelCooldownMs: number;
  };

  readonly deepbook: {
    /** Reference mid for the carry entry and the NAV deviation check. */
    readonly poolId: string;
    readonly dbusdcType: string;
    /** moveCall target (v20). */
    readonly packageId: string;
    /** Type-argument origin (v1). */
    readonly originalPackageId: string;
  };

  /**
   * Seal threshold-IBE committee. D9: n = 5 across 5 DISTINCT OPERATORS, t = 3.
   * `@mysten/seal@1.3.4` makes `serverConfigs` REQUIRED and ships no default
   * set, so there is no accidental Enoki key server — the no-Enoki rule (§7.5)
   * is satisfied by construction on testnet.
   */
  readonly seal: {
    /** Key-server object ids, one per operator. */
    readonly keyServerIds: readonly string[];
    /** Key-server base URLs, index-aligned with keyServerIds. */
    readonly keyServerUrls: readonly string[];
    /** Decryption threshold t. A batch must not open below t live servers. */
    readonly threshold: number;
    /** Seal policy version — bumped to invalidate every outstanding identity. */
    readonly policyVersion: number;
  };

  /** Walrus holds the order ciphertexts; the on-chain record is a blob id. */
  readonly walrus: {
    readonly aggregatorUrl: string;
    readonly publisherUrl: string;
  };

  readonly zkLogin: {
    /**
     * Enoki PUBLIC api key. Public by design (it ships to the browser). The
     * Enoki *private* key and the Google OAuth *client secret* must NEVER
     * appear in this app.
     *
     * ⚠ Enoki is used for zkLogin ONLY, never as a Seal key server: giving one
     * party identity linkage AND a decryption share defeats the committee
     * (aphotic.md §7.5).
     */
    readonly enokiApiKey: string;
    readonly googleClientId: string;
    readonly redirectUrl: string;
  };

  readonly explorers: {
    readonly sui: string;
    readonly bitcoin: string;
  };

  /**
   * The published redemption address. The carry exit needs a real transaction
   * signer, so it runs through a 2-of-2 custody multisig and the returning BTC
   * lands at a Bitcoin address no Move code controls (aphotic.md §6.3). Pinning
   * is enforced AT SIGNING, not by Move. Publishing it is mitigation #1.
   */
  readonly custody: {
    /** Sui address of the 2-of-2 custody multisig. */
    readonly multisigAddress: string;
    /** The pinned Bitcoin redemption address. Publicly auditable on Bitcoin. */
    readonly redemptionAddress: string;
  };

  /** Protocol constants that are NOT env-tunable. */
  readonly constants: {
    /** hBTC decimals — amounts are sats (u64 on-chain, bigint here). */
    readonly hbtcDecimals: number;
    /** The governed denomination ladder, in sats. Append-only. */
    readonly denominationsSats: readonly bigint[];
    /** Clearing cadence: 12 h. */
    readonly cadenceMs: number;
    /** Cadence offset: 06:00 UTC. */
    readonly cadenceOffsetMs: number;
    /** No submit lands within this of close (DESIGN-V2 §3). */
    readonly submitCutoffMs: number;
    /** Reveal window after close (DESIGN-V2 §3). */
    readonly revealGraceMs: number;
    /** Governed max batch size (DESIGN-V2 §2 D4). */
    readonly maxBatchSize: number;
    /** Asserted hard ceiling in the setter. */
    readonly hardMaxBatchSize: number;
    /** Sui protocol floor for a colluding quorum — see validatorsLive (D10). */
    readonly validatorFloor: number;
    /** Validators on live testnet, observed 2026-07-26. Quote BOTH numbers. */
    readonly validatorsLive: number;
  };
}

const env = import.meta.env;

export const config: AppConfig = {
  sui: {
    network: readString(env.VITE_SUI_NETWORK, 'testnet'),
    grpcUrl: readString(env.VITE_SUI_GRPC_URL, 'https://fullnode.testnet.sui.io:443'),
    jsonRpcUrl: readString(env.VITE_SUI_JSONRPC_URL, 'https://rpc-testnet.suiscan.xyz:443'),
  },

  aphotic: {
    packageId: readString(env.VITE_APHOTIC_PACKAGE_ID, ''),
    originalPackageId: readString(
      env.VITE_APHOTIC_ORIGINAL_PACKAGE_ID,
      readString(env.VITE_APHOTIC_PACKAGE_ID, ''),
    ),
    vaultId: readString(env.VITE_VAULT_ID, ''),
    governanceId: readString(env.VITE_GOVERNANCE_ID, ''),
    batchRegistryId: readString(env.VITE_BATCH_REGISTRY_ID, ''),
    noteTreeId: readString(env.VITE_NOTE_TREE_ID, ''),
    nullifierSetId: readString(env.VITE_NULLIFIER_SET_ID, ''),
    balanceLedgerId: readString(env.VITE_BALANCE_LEDGER_ID, ''),
    adapterAllowlistId: readString(env.VITE_ADAPTER_ALLOWLIST_ID, ''),
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

  seal: {
    keyServerIds: readList(env.VITE_SEAL_KEY_SERVER_IDS),
    keyServerUrls: readList(env.VITE_SEAL_KEY_SERVER_URLS),
    threshold: readInt(env.VITE_SEAL_THRESHOLD, 3),
    policyVersion: readInt(env.VITE_SEAL_POLICY_VERSION, 1),
  },

  walrus: {
    aggregatorUrl: readString(
      env.VITE_WALRUS_AGGREGATOR,
      'https://aggregator.walrus-testnet.walrus.space',
    ),
    publisherUrl: readString(env.VITE_WALRUS_PUBLISHER, ''),
  },

  zkLogin: {
    enokiApiKey: readString(env.VITE_ENOKI_API_KEY, ''),
    googleClientId: readString(env.VITE_ZKLOGIN_CLIENT_ID, ''),
    redirectUrl: readString(env.VITE_ENOKI_REDIRECT_URL, ''),
  },

  explorers: {
    sui: readString(env.VITE_SUI_EXPLORER, 'https://suiscan.xyz/testnet'),
    bitcoin: readString(env.VITE_BITCOIN_EXPLORER, 'https://mempool.space/signet'),
  },

  custody: {
    multisigAddress: readString(env.VITE_CUSTODY_MULTISIG, ''),
    redemptionAddress: readString(env.VITE_REDEMPTION_ADDRESS, ''),
  },

  constants: {
    hbtcDecimals: 8,
    denominationsSats: [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n],
    cadenceMs: 43_200_000,
    cadenceOffsetMs: 21_600_000,
    submitCutoffMs: 60_000,
    revealGraceMs: 600_000,
    maxBatchSize: 256,
    hardMaxBatchSize: 512,
    validatorFloor: 7,
    validatorsLive: 32,
  },
};

// ── startup validation ───────────────────────────────────────────────────────

export type ConfigSeverity = 'blocking' | 'degraded';

export interface ConfigProblem {
  /** The `VITE_*` key that is missing or malformed. */
  readonly key: string;
  /** 'blocking' = no write path at all. 'degraded' = one feature is dark. */
  readonly severity: ConfigSeverity;
  /** What stops working, in one line the UI can render verbatim. */
  readonly effect: string;
}

interface Requirement {
  readonly key: string;
  readonly value: string | number;
  readonly severity: ConfigSeverity;
  readonly effect: string;
}

function requirements(): readonly Requirement[] {
  return [
    {
      key: 'VITE_APHOTIC_PACKAGE_ID',
      value: config.aphotic.packageId,
      severity: 'blocking',
      effect: 'No transaction can be built: every write targets our own package.',
    },
    {
      key: 'VITE_VAULT_ID',
      value: config.aphotic.vaultId,
      severity: 'blocking',
      effect: 'The vault screen cannot read a position or build a deposit request.',
    },
    {
      key: 'VITE_BATCH_REGISTRY_ID',
      value: config.aphotic.batchRegistryId,
      severity: 'blocking',
      effect: 'No batch can be read, submitted to, or verified.',
    },
    {
      key: 'VITE_BALANCE_LEDGER_ID',
      value: config.aphotic.balanceLedgerId,
      severity: 'blocking',
      effect: 'Order escrow cannot be read; orders draw on the internal balance.',
    },
    {
      key: 'VITE_NOTE_TREE_ID',
      value: config.aphotic.noteTreeId,
      severity: 'degraded',
      effect: 'Note commitments cannot be appended or proved.',
    },
    {
      key: 'VITE_NULLIFIER_SET_ID',
      value: config.aphotic.nullifierSetId,
      severity: 'degraded',
      effect: 'Note spends cannot be checked for double-spend.',
    },
    {
      key: 'VITE_GOVERNANCE_ID',
      value: config.aphotic.governanceId,
      severity: 'degraded',
      effect: 'Governed parameters and pause state are unreadable.',
    },
    {
      key: 'VITE_ADAPTER_ALLOWLIST_ID',
      value: config.aphotic.adapterAllowlistId,
      severity: 'degraded',
      effect: 'The pinned lending-adapter allowlist cannot be shown.',
    },
    {
      key: 'VITE_SEAL_KEY_SERVER_IDS',
      value: config.seal.keyServerIds.length,
      severity: 'blocking',
      effect: 'Orders cannot be encrypted. We never fall back to plaintext (D9).',
    },
    {
      key: 'VITE_WALRUS_PUBLISHER',
      value: config.walrus.publisherUrl,
      severity: 'degraded',
      effect: 'Order ciphertexts cannot be published, only read.',
    },
    {
      key: 'VITE_ENOKI_API_KEY',
      value: config.zkLogin.enokiApiKey,
      severity: 'degraded',
      effect: 'Google sign-in is unavailable; a browser wallet still works.',
    },
    {
      key: 'VITE_ZKLOGIN_CLIENT_ID',
      value: config.zkLogin.googleClientId,
      severity: 'degraded',
      effect: 'Google sign-in is unavailable; a browser wallet still works.',
    },
  ];
}

/**
 * Every `VITE_*` this build needs and did not get.
 *
 * ⚠ Vite INLINES `import.meta.env.VITE_*` at build time, so a var missing from
 * the CI environment produces a bundle containing `""` — there is no runtime
 * error to catch. This function is the substitute: pure, never throws, and the
 * shell renders it at the top of every screen.
 */
export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const req of requirements()) {
    const missing = typeof req.value === 'number' ? req.value === 0 : req.value.length === 0;
    if (missing) {
      problems.push({ key: req.key, severity: req.severity, effect: req.effect });
    }
  }
  if (config.seal.keyServerIds.length > 0 && config.seal.threshold > config.seal.keyServerIds.length) {
    problems.push({
      key: 'VITE_SEAL_THRESHOLD',
      severity: 'blocking',
      effect: `Threshold ${config.seal.threshold} exceeds the ${config.seal.keyServerIds.length} configured key servers — no identity could ever be decrypted.`,
    });
  }
  return problems;
}

/** True when every one of the named config values is non-empty. */
export function isWired(...values: readonly string[]): boolean {
  return values.every((v) => v.length > 0);
}

/** True when nothing blocking is missing. */
export function canTransact(): boolean {
  return configProblems().every((p) => p.severity !== 'blocking');
}
