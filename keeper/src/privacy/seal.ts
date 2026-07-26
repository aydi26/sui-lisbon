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
import { put as walrusPut } from '../storage/walrus.js';
import type { AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';
import { hexToBytes } from '../util/bytes.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import type { SealSession } from './session.js';

/**
 * ⚠⚠ BYTE ORDER — READ THIS BEFORE TOUCHING ANY OFFSET BELOW.
 *
 * The v1 identity was `32-byte vault id ‖ u64 epoch BIG-ENDIAN`, and the v1
 * `vault::seal_approve` decoded it by hand with `epoch = (epoch << 8) + byte`.
 * Both sides agreed, so both were wrong together and nothing complained.
 *
 * v2's policy is the batch time-lock, and it parses with `bcs::peel_u64`, which
 * reads **LITTLE-ENDIAN**. Emit big-endian here and the key servers decline
 * forever: the batch simply never reveals, with no error anywhere to read. That
 * is the same silent failure class as RECON R14's Bitcoin txid byte order — a
 * value that is wrong in exactly one direction, on a path that never throws.
 *
 * Layout, 48 bytes, mirrored by `aphotic::batch::check_policy`:
 *   [ 0..8 )  bcs u64      close_ms        LITTLE-ENDIAN
 *   [ 8..16)  bcs u64      policy_version  LITTLE-ENDIAN
 *   [16..48)  bcs address  batch object id (32 raw bytes)
 * and trailing bytes are REJECTED on the Move side, so the length is exact, not
 * a minimum.
 *
 * This is the INNER id only. Seal prefixes the package id itself to form the
 * full IBE identity — never prepend it here or it lands twice.
 */
export const SEAL_ID_CLOSE_MS_LEN = 8 as const;
export const SEAL_ID_POLICY_VERSION_LEN = 8 as const;
export const SEAL_ID_BATCH_LEN = 32 as const;
/** Total inner-identity length. Must equal what `aphotic::batch::check_policy` consumes. */
export const SEAL_IDENTITY_LEN =
  SEAL_ID_CLOSE_MS_LEN + SEAL_ID_POLICY_VERSION_LEN + SEAL_ID_BATCH_LEN;

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

/**
 * The Seal identity: WHEN it opens, under WHICH policy, for WHICH batch.
 *
 * `closeMs` is the batch's scheduled close, derived from the cadence and never
 * chosen by an operator — see `aphotic::batch::next_boundary`. Bumping
 * `policyVersion` invalidates every outstanding identity at once.
 */
export interface SealIdentity {
  readonly batchId: ObjectId;
  /** The batch's scheduled close, unix ms. Derived from the cadence, never supplied. */
  readonly closeMs: number;
  /** `BatchRegistry.policy_version`. A mismatch is refused by the policy. */
  readonly policyVersion: number;
}

export interface EncryptResult {
  readonly ciphertext: Uint8Array;
  readonly identity: Uint8Array;
  readonly threshold: number;
  readonly keyServers: readonly string[];
}

/**
 * The 48-byte INNER identity for the batch time-lock. See the byte-order note on
 * `SEAL_IDENTITY_LEN` — the two u64s are LITTLE-ENDIAN because `bcs::peel_u64` is.
 *
 * A short batch id is LEFT-padded to 32 bytes, exactly as `object::id(b).to_bytes()`
 * renders it on-chain.
 */
export function sealIdentity(id: SealIdentity): Uint8Array {
  if (typeof id.batchId !== 'string' || id.batchId.trim() === '') {
    throw new ConfigError('sealIdentity requires a batch object id', ['BATCH_ID']);
  }
  if (!Number.isInteger(id.closeMs) || id.closeMs < 0) {
    throw new ConfigError(
      `sealIdentity requires a non-negative integer close_ms — got ${String(id.closeMs)}`,
      ['BATCH_CADENCE_MS'],
    );
  }
  if (!Number.isInteger(id.policyVersion) || id.policyVersion < 0) {
    // Invariant 2 — no policy version, no encryption. The version is what lets us
    // invalidate every outstanding identity at once if the policy is ever wrong.
    throw new ConfigError(
      `sealIdentity requires a non-negative integer policy version — got ${String(id.policyVersion)}`,
      ['SEAL_POLICY_VERSION'],
    );
  }

  let raw: Uint8Array;
  try {
    raw = hexToBytes(id.batchId);
  } catch {
    throw new ConfigError(`batch object id is not valid hex: ${id.batchId}`, ['BATCH_ID']);
  }
  if (raw.length > SEAL_ID_BATCH_LEN) {
    throw new ConfigError(
      `batch object id must be at most ${SEAL_ID_BATCH_LEN} bytes — got ${raw.length}`,
      ['BATCH_ID'],
    );
  }

  const out = new Uint8Array(SEAL_IDENTITY_LEN);
  const view = new DataView(out.buffer);
  // `true` is DataView's LITTLE-ENDIAN flag. The v1 code passed `false` here and
  // that single boolean is the whole bug — it is the difference between a policy
  // that opens on schedule and one that never opens at all.
  view.setBigUint64(0, BigInt(id.closeMs), true);
  view.setBigUint64(SEAL_ID_CLOSE_MS_LEN, BigInt(id.policyVersion), true);
  out.set(raw, SEAL_IDENTITY_LEN - raw.length); // left-pad, as Sui renders object ids
  return out;
}

/**
 * The SAME timestamp encoded big-endian. Exists ONLY so a test can assert that the
 * two differ and that the big-endian form is rejected. Never call it in the run loop —
 * the deliberately awkward name is the guard.
 */
export function sealIdentityBigEndianWRONG(id: SealIdentity): Uint8Array {
  const out = sealIdentity(id);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(id.closeMs), false);
  view.setBigUint64(SEAL_ID_CLOSE_MS_LEN, BigInt(id.policyVersion), false);
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

/**
 * Threshold-encrypt an already-framed payload. The ONLY place plaintext is encrypted.
 *
 * This port deliberately does NOT know what it is encrypting. v1 took a
 * `StrategyParams` and serialized it here, which put a domain type inside the
 * crypto boundary; v2 takes bytes, so the caller owns the frame and this module
 * has one job.
 *
 * ⚠ The CALLER must supply a CONSTANT-LENGTH frame. Seal does not pad, so
 * ciphertext length tracks plaintext length — an unpadded order would leak its
 * size through the one thing we encrypted it to hide.
 */
export async function encryptPayload(
  deps: SealDeps,
  data: Uint8Array,
  id: SealIdentity,
): Promise<EncryptResult> {
  const backend = requireSealBackend(deps);
  const keyServers = assertKeyServers(deps.cfg);
  const packageId = assertPackageId(deps.cfg);
  const identity = sealIdentity(id);

  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new AphoticError('SealEncryptFailed', 'refusing to encrypt an empty payload');
  }

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
export async function decryptPayload(
  deps: SealDeps,
  ciphertext: Uint8Array,
  session: SealSession,
  id: SealIdentity,
): Promise<Uint8Array> {
  const backend = requireSealBackend(deps);
  const packageId = assertPackageId(deps.cfg);
  const identity = sealIdentity(id);

  const plaintext = await backend.decrypt({ ciphertext, identity, sessionKey: session.key, packageId });

  // Invariant 4: never hand back an empty frame as if it were data. The caller
  // decodes and checks the commitment; a mismatch there is what actually catches
  // a substituted ciphertext, and it can only do that if it receives real bytes.
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0) {
    throw new AphoticError('SealDecryptFailed', 'Seal backend returned an empty plaintext');
  }
  return plaintext;
}

/** Encrypt then Walrus-put (explicit epochs, never 1) and return the blob id. */
export async function publishSealed(
  deps: SealDeps,
  data: Uint8Array,
  id: SealIdentity,
): Promise<{ blobId: string; ciphertext: Uint8Array }> {
  // ENCRYPT BEFORE UPLOAD, always (G8): Walrus blobs are public and permanently discoverable.
  const { ciphertext } = await encryptPayload(deps, data, id);
  const store: BlobStore = deps.storage ?? { put: walrusPut };
  const { blobId } = await store.put(deps.cfg, ciphertext, { epochs: deps.cfg.walrus.epochs });
  if (typeof blobId !== 'string' || blobId === '') {
    throw new AphoticError('WalrusPutFailed', 'Walrus returned an empty blob id for the strategy ciphertext');
  }
  return { blobId, ciphertext };
}
