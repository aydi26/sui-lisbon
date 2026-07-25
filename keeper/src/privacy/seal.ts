// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     PARTIAL — every body is real, but the ONLY missing piece is the concrete
//             `@mysten/seal` SealBackend: the package is NOT in keeper/package.json and this
//             agent may not add dependencies. Wire `sealBackendFromMystenSeal()` (below) the
//             moment `@mysten/seal@1.3.4` is installed; nothing else changes.
// @spec       docs/KEEPER.md §3.3 (Seal encrypt/decrypt, Move-gated access) + ERRATA E-K12
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · CUT LINE item 2 (encrypted strategy)
// @spec       docs/FACTS.md#seal · docs/MOVE-PACKAGE.md §3.4 (`vault::seal_approve`)
// @rules      G7 G8 G10
// @depends    ../strategy/serialize.ts (T2.6) · ../storage/walrus.ts (T2.9) · ../config.ts ·
//             aphotic::vault::seal_approve (T1.2)
// @facts      ★ IDENTITY IS NAMESPACED TO (vault object id + versionEpoch). Rotating the keeper
// @facts        increments `vault.version_epoch`, which INVALIDATES previously derived key shares —
// @facts        a bare `set_keeper` would not (that is the whole point of the epoch).
// @facts        Historical epochs stay individually discloseable ⇒ scoped verification tier (§9.1).
// @facts      ★ IDENTITY LAYOUT — byte-identical to `aphotic::vault::check_seal_access`:
// @facts        40 bytes = 32-byte vault object id ‖ u64 version_epoch BIG-ENDIAN.
// @facts        Any other length aborts EBadIdentityNamespace on-chain; a mismatched epoch
// @facts        aborts EStaleVersionEpoch. Do not "improve" this encoding on one side only.
// @facts      ★ ACCESS IS MOVE-GATED: each key server DRY-RUNS `aphotic::vault::seal_approve` before
// @facts        releasing a share. The gate is on-chain; the keeper cannot talk its way past it.
// @facts      Threshold: cfg.seal.threshold (default 2) of cfg.seal.keyServers.
// @facts        Aphotic default = the two INDEPENDENT testnet key servers, t=2 (docs/FACTS.md#seal).
// @facts      ⚠ `@mysten/seal@1.3.4` NO LONGER EXPORTS `getAllowlistedKeyServers`. Construct
// @facts        `SealClient({ suiClient, serverConfigs: [{ objectId, weight: 1 }, …], verifyKeyServers })`
// @facts        with EXPLICIT object ids from config (G7 — never a literal here).
// @facts      ⚠ `/v1/service` needs BOTH a `Client-Sdk-Version` header (else 400 MissingRequiredHeader)
// @facts        AND a `?service_id=` query parameter (else 400 InvalidServiceId).
// @facts      ★ ENCRYPT BEFORE UPLOAD, ALWAYS (G8). Walrus blobs are public and discoverable; the
// @facts        strategy plaintext must never leave this module unencrypted.
// @facts      ⚠ Residual trust, stated honestly (G8): the running keeper decrypts parameters IN
// @facts        MEMORY. A Nautilus/TEE fix is explicitly out of scope. Never claim otherwise.
// @facts      ⚠ `@mysten/seal` is NOT an installed dependency ⇒ the SDK is reached through the
// @facts        narrow `SealBackend` port below. The `sdk` gate also forbids importing an SDK
// @facts        outside its adapter, so a port is the correct shape regardless.
// @facts      Payload is the CONSTANT-LENGTH frame from ../strategy/serialize.ts (128 bytes) so the
// @facts        ciphertext size leaks nothing about the strategy family.
// @implements export interface SealIdentity / EncryptResult / SealDeps / SealBackend / BlobStore
// @implements export const SEAL_IDENTITY_LEN / SEAL_ID_VAULT_LEN / SEAL_ID_EPOCH_LEN
// @implements export function sealIdentity(id: SealIdentity): Uint8Array
// @implements export function requireSealBackend(deps: SealDeps): SealBackend
// @implements export async function encryptParams(deps: SealDeps, params: StrategyParams, id: SealIdentity): Promise<EncryptResult>
// @implements export async function decryptParams(deps: SealDeps, ciphertext: Uint8Array, session: SealSession): Promise<StrategyParams>
// @implements export async function publishStrategy(deps: SealDeps, params: StrategyParams, id: SealIdentity): Promise<{ blobId: string; ciphertext: Uint8Array }>
// @forbidden  logging, journaling, or serializing plaintext parameters anywhere (G8)
// @forbidden  a hardcoded key-server object id or URL — config only (gates.ps1 ids)
// @forbidden  uploading anything to Walrus before encryption
// @forbidden  claiming custody/execution is trustless — hBTC is threshold-custodial (G8)
// @invariant  1. Plaintext never leaves this module except as a return value to the run loop.
// @invariant  2. The identity ALWAYS includes the version epoch — no epoch, no encryption.
// @invariant  3. Ciphertext length is a constant function of the padded frame, not of the values.
// @invariant  4. Decryption failure is an error, never a silent fallback to defaults.
// @ac         docs/BUILD-PLAN.md T2.6 — Seal encrypt/decrypt with version-epoch identity
// @verify     npm run test -- privacy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Config } from '../config.js';
import type { StrategyParams } from '../strategy/params.js';
import { deserialize, serialize } from '../strategy/serialize.js';
import { put as walrusPut } from '../storage/walrus.js';
import type { AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';
import { hexToBytes } from '../util/bytes.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import type { SealSession } from './session.js';

/** 32-byte vault object id — the first half of the identity. */
export const SEAL_ID_VAULT_LEN = 32 as const;
/** big-endian u64 version epoch — the second half. */
export const SEAL_ID_EPOCH_LEN = 8 as const;
/** Total identity length. Must equal `aphotic::vault::SEAL_IDENTITY_LEN`. */
export const SEAL_IDENTITY_LEN = SEAL_ID_VAULT_LEN + SEAL_ID_EPOCH_LEN;

/**
 * The narrow port onto the Seal SDK. `@mysten/seal` is NOT installed (and, like every SDK in
 * this repo, would be confined to a single adapter anyway), so every Seal operation goes
 * through this interface. A test injects a deterministic in-memory implementation; production
 * injects one built over `SealClient`/`SessionKey`.
 */
export interface SealBackend {
  /** Threshold-encrypt `data` under `identity`. Returns the serialized encrypted object. */
  encrypt(req: SealEncryptRequest): Promise<Uint8Array>;
  /** Fetch shares (each key server dry-runs `vault::seal_approve`) and decrypt. */
  decrypt(req: SealDecryptRequest): Promise<Uint8Array>;
  /** Mint a short-lived session key bound to (address, package, ttl). See ./session.ts. */
  createSessionKey(req: SealSessionKeyRequest): Promise<unknown>;
}

export interface SealEncryptRequest {
  /** The 128-byte padded frame — never raw parameter values. */
  readonly data: Uint8Array;
  /** 40-byte identity from {@link sealIdentity}. */
  readonly identity: Uint8Array;
  readonly threshold: number;
  /** Key-server OBJECT IDS, explicit, straight from config (E-K12). */
  readonly keyServers: readonly string[];
  /** The `aphotic` package whose `vault::seal_approve` gates every share release. */
  readonly packageId: string;
}

export interface SealDecryptRequest {
  readonly ciphertext: Uint8Array;
  readonly identity: Uint8Array;
  /** Opaque `SessionKey`. NEVER logged or serialized (G8). */
  readonly sessionKey: unknown;
  readonly packageId: string;
}

export interface SealSessionKeyRequest {
  readonly address: string;
  readonly packageId: string;
  readonly ttlMinutes: number;
  readonly signer: Signer;
}

/** The Walrus write port. Structurally satisfied by `storage/walrus.ts`'s `put` (T2.9). */
export interface BlobStore {
  put(cfg: Config, bytes: Uint8Array, opts: { epochs: number }): Promise<{ blobId: string }>;
}

export interface SealDeps {
  readonly cfg: Config;
  /** Needed by SealClient for the `seal_approve` dry run. */
  readonly client: AnySuiClient;
  /** Seal SDK port. Absent ⇒ every Seal call fails loudly (never a silent plaintext path). */
  readonly backend?: SealBackend;
  /** Walrus port. Defaults to `storage/walrus.ts`. */
  readonly storage?: BlobStore;
}

/** The Seal identity: vault object + version epoch. Rotation invalidates old shares. */
export interface SealIdentity {
  readonly vaultId: ObjectId;
  /** cfg.seal.versionEpoch, or the vault's current `version_epoch` on-chain. */
  readonly versionEpoch: number;
}

export interface EncryptResult {
  readonly ciphertext: Uint8Array;
  readonly identity: Uint8Array;
  readonly threshold: number;
  readonly keyServers: readonly string[];
}

/**
 * Deterministic identity bytes: 32-byte vault object id ‖ u64 version epoch (BIG-ENDIAN).
 *
 * This layout is mirrored byte-for-byte by `aphotic::vault::check_seal_access`. A short vault id
 * is LEFT-padded to 32 bytes, exactly as `object::id(vault).to_bytes()` yields it on-chain.
 */
export function sealIdentity(id: SealIdentity): Uint8Array {
  if (typeof id.vaultId !== 'string' || id.vaultId.trim() === '') {
    throw new ConfigError('sealIdentity requires a vault object id (VAULT_ID)', ['VAULT_ID']);
  }
  if (!Number.isInteger(id.versionEpoch) || id.versionEpoch < 0) {
    // Invariant 2 — no epoch, no encryption.
    throw new ConfigError(
      `sealIdentity requires a non-negative integer version epoch — got ${String(id.versionEpoch)}`,
      ['SEAL_VERSION_EPOCH'],
    );
  }

  let raw: Uint8Array;
  try {
    raw = hexToBytes(id.vaultId);
  } catch {
    throw new ConfigError(`vault object id is not valid hex: ${id.vaultId}`, ['VAULT_ID']);
  }
  if (raw.length > SEAL_ID_VAULT_LEN) {
    throw new ConfigError(
      `vault object id must be at most ${SEAL_ID_VAULT_LEN} bytes — got ${raw.length}`,
      ['VAULT_ID'],
    );
  }

  const out = new Uint8Array(SEAL_IDENTITY_LEN);
  out.set(raw, SEAL_ID_VAULT_LEN - raw.length); // left-pad, as Sui renders object ids
  new DataView(out.buffer).setBigUint64(SEAL_ID_VAULT_LEN, BigInt(id.versionEpoch), false);
  return out;
}

/**
 * The Seal SDK port, or a loud failure. Never fall back to plaintext — a missing backend must
 * stop the keeper, not silently downgrade the only secret in the system (G8).
 */
export function requireSealBackend(deps: SealDeps): SealBackend {
  if (deps.backend === undefined) {
    throw new ConfigError(
      'no SealBackend configured: `@mysten/seal` is not an installed dependency of keeper/. ' +
        'Install @mysten/seal@1.3.4 and inject a backend built over SealClient/SessionKey with ' +
        'EXPLICIT serverConfigs from cfg.seal.keyServers (E-K12).',
      ['SEAL_KEY_SERVERS'],
    );
  }
  return deps.backend;
}

function assertKeyServers(cfg: Config): readonly string[] {
  const keyServers = cfg.seal.keyServers;
  if (keyServers.length === 0) {
    throw new ConfigError('SEAL_KEY_SERVERS is empty — Seal needs explicit key-server object ids', [
      'SEAL_KEY_SERVERS',
    ]);
  }
  if (cfg.seal.threshold > keyServers.length) {
    throw new ConfigError(
      `SEAL_THRESHOLD (${cfg.seal.threshold}) exceeds the number of key servers (${keyServers.length})`,
      ['SEAL_THRESHOLD', 'SEAL_KEY_SERVERS'],
    );
  }
  return keyServers;
}

function assertPackageId(cfg: Config): string {
  if (cfg.aphotic.packageId === '') {
    throw new ConfigError(
      'APHOTIC_PACKAGE_ID is unset — key servers dry-run `aphotic::vault::seal_approve` and need it',
      ['APHOTIC_PACKAGE_ID'],
    );
  }
  return cfg.aphotic.packageId;
}

/** Pad → serialize → threshold-encrypt. The ONLY place plaintext parameters are encrypted. */
export async function encryptParams(
  deps: SealDeps,
  params: StrategyParams,
  id: SealIdentity,
): Promise<EncryptResult> {
  const backend = requireSealBackend(deps);
  const keyServers = assertKeyServers(deps.cfg);
  const packageId = assertPackageId(deps.cfg);
  const identity = sealIdentity(id);

  // Constant-length frame FIRST (invariant 3): the ciphertext must never be a size oracle.
  const data = serialize(params);
  const ciphertext = await backend.encrypt({
    data,
    identity,
    threshold: deps.cfg.seal.threshold,
    keyServers,
    packageId,
  });

  if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0) {
    throw new AphoticError('SealEncryptFailed', 'Seal backend returned an empty ciphertext');
  }

  return { ciphertext, identity, threshold: deps.cfg.seal.threshold, keyServers };
}

/**
 * Fetch shares (each key server dry-runs `vault::seal_approve` first) and decrypt.
 * The plaintext exists only in the run loop's memory — state this honestly (G8).
 *
 * ⚠ The CALLER must have run `session.assertUsable(session, id, nowMs)` first: expiry is a
 * clock question and this module is kept clock-free so `verify/` can exercise it.
 */
export async function decryptParams(
  deps: SealDeps,
  ciphertext: Uint8Array,
  session: SealSession,
): Promise<StrategyParams> {
  const backend = requireSealBackend(deps);
  const packageId = assertPackageId(deps.cfg);
  // The identity is derived from the SESSION, never from a caller-supplied argument — a session
  // minted under epoch N can only ever address epoch N's ciphertext (invariant 2).
  const identity = sealIdentity({ vaultId: session.vaultId, versionEpoch: session.versionEpoch });

  const plaintext = await backend.decrypt({ ciphertext, identity, sessionKey: session.key, packageId });

  // Invariant 4: a malformed frame is an error. `deserialize` rejects wrong length/version and
  // never guesses, so a stale-epoch share can never masquerade as valid parameters.
  return deserialize(plaintext);
}

/** Encrypt then Walrus-put (explicit epochs, never 1) and return the blob id for the vault. */
export async function publishStrategy(
  deps: SealDeps,
  params: StrategyParams,
  id: SealIdentity,
): Promise<{ blobId: string; ciphertext: Uint8Array }> {
  // ENCRYPT BEFORE UPLOAD, always (G8): Walrus blobs are public and permanently discoverable.
  const { ciphertext } = await encryptParams(deps, params, id);
  const store: BlobStore = deps.storage ?? { put: walrusPut };
  const { blobId } = await store.put(deps.cfg, ciphertext, { epochs: deps.cfg.walrus.epochs });
  if (typeof blobId !== 'string' || blobId === '') {
    throw new AphoticError('WalrusPutFailed', 'Walrus returned an empty blob id for the strategy ciphertext');
  }
  return { blobId, ciphertext };
}
