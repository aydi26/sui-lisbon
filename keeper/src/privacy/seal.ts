// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
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
// @facts      ⚠ `@mysten/seal` is NOT an installed dependency (see @blocked in the T2.6 handover).
// @facts      Payload is the CONSTANT-LENGTH frame from ../strategy/serialize.ts (128 bytes) so the
// @facts        ciphertext size leaks nothing about the strategy family.
// @implements export interface SealIdentity / EncryptResult / SealDeps
// @implements export function sealIdentity(id: SealIdentity): Uint8Array
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
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { StrategyParams } from '../strategy/params.js';
import type { AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';

import type { SealSession } from './session.js';

export interface SealDeps {
  readonly cfg: Config;
  /** Needed by SealClient for the `seal_approve` dry run. */
  readonly client: AnySuiClient;
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

/** Deterministic identity bytes: vault object id ‖ version epoch (big-endian). */
// TODO(T2.6): concat the 32-byte vault id with the u64 epoch; stable and reproducible.
export function sealIdentity(_id: SealIdentity): Uint8Array {
  throw new Error('TODO(T2.6): sealIdentity not implemented');
}

/** Pad → serialize → threshold-encrypt. The ONLY place plaintext parameters are encrypted. */
// TODO(T2.6): serialize(params) (128-byte frame) → SealClient.encrypt with explicit serverConfigs
//             from cfg.seal.keyServers and threshold cfg.seal.threshold.
export async function encryptParams(
  _deps: SealDeps,
  _params: StrategyParams,
  _id: SealIdentity,
): Promise<EncryptResult> {
  throw new Error('TODO(T2.6): encryptParams not implemented');
}

/**
 * Fetch shares (each key server dry-runs `vault::seal_approve` first) and decrypt.
 * The plaintext exists only in the run loop's memory — state this honestly (G8).
 */
// TODO(T2.6): SealClient.decrypt with the session key → deserialize the 128-byte frame.
export async function decryptParams(
  _deps: SealDeps,
  _ciphertext: Uint8Array,
  _session: SealSession,
): Promise<StrategyParams> {
  throw new Error('TODO(T2.6): decryptParams not implemented');
}

/** Encrypt then Walrus-put (explicit epochs, never 1) and return the blob id for the vault. */
// TODO(T2.6): encryptParams → storage.put(cfg, ciphertext, { epochs: cfg.walrus.epochs }).
export async function publishStrategy(
  _deps: SealDeps,
  _params: StrategyParams,
  _id: SealIdentity,
): Promise<{ blobId: string; ciphertext: Uint8Array }> {
  throw new Error('TODO(T2.6): publishStrategy not implemented');
}
