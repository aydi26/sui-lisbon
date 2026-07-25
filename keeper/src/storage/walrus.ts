// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.9
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §8 (`put`/`get`, epochs EXPLICIT, encrypt-before-upload) + ERRATA E-K12
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.9) · docs/FACTS.md#walrus
// @rules      G7 G8 G10
// @depends    ../config.ts (endpoints + epochs) · ../privacy/seal.ts (T2.6, encrypt-before-upload)
// @facts      ★★ `epochs` IS ALWAYS EXPLICIT, FROM CONFIG. Walrus DEFAULTS TO A SINGLE EPOCH when
// @facts        the parameter is omitted — a 1-epoch decision log expires almost immediately and
// @facts        the vault silently stops being verifiable. cfg.walrus.epochs (default 12) is
// @facts        validated >= 2 in config.ts; NEVER pass a literal, never omit the parameter.
// @facts      ★★ ENCRYPT BEFORE UPLOAD, ALWAYS. Walrus blobs are PUBLIC and discoverable; blob ids
// @facts        are content-derived (self-certifying). Strategy ciphertext is Seal-encrypted by
// @facts        ../privacy/seal.ts BEFORE it ever reaches this module.
// @facts      HTTP API (docs/FACTS.md#walrus, verified round trip):
// @facts        PUT  {cfg.walrus.publisher}/v1/blobs?epochs=<N>     body = raw bytes
// @facts        GET  {cfg.walrus.aggregator}/v1/blobs/{blobId}      → the exact bytes
// @facts        Primary: publisher.walrus-testnet.walrus.space / aggregator.walrus-testnet.walrus.space
// @facts        Backups (staketab, nodes.guru) live in config, never here (G7).
// @facts      ⚠ A FRESHLY PUBLISHED BLOB RETURNS `certifiedEpoch: null` AND `deletable: true`.
// @facts        Any availability predicate demanding certified + non-deletable REJECTS OUR OWN
// @facts        WRITES. Allow a grace window (also true of the on-chain check — E-M11).
// @facts      ⚠ `@mysten/walrus` is NOT an installed dependency — use the HTTP publisher/aggregator
// @facts        with the global fetch (see @blocked in the T2.9 handover).
// @facts      The vault also retains an in-object ciphertext copy, so blob expiry degrades
// @facts        VERIFIABILITY rather than halting the vault (docs/FACTS.md#walrus).
// @implements export interface PutOptions / PutResult / BlobStatus
// @implements export function resolveEpochs(cfg: Config, opts?: Partial<PutOptions>): number
// @implements export async function put(cfg: Config, bytes: Uint8Array, opts?: Partial<PutOptions>): Promise<PutResult>
// @implements export async function get(cfg: Config, blobId: string): Promise<Uint8Array>
// @implements export async function status(cfg: Config, blobId: string): Promise<BlobStatus>
// @implements export function blobUrl(cfg: Config, blobId: string): string
// @forbidden  omitting `epochs` on a PUT, or defaulting it to 1 — G7/A8, the liveness trap
// @forbidden  uploading plaintext strategy material (G8) — encrypt first, always
// @forbidden  a hardcoded publisher/aggregator URL — config only (gates.ps1 ids)
// @invariant  1. `resolveEpochs` returns >= 2 or throws; there is no silent default.
// @invariant  2. `put` always sends `?epochs=<resolved>`; the query parameter is never optional.
// @invariant  3. `get(put(bytes)) === bytes` byte-for-byte (blob ids are content-derived).
// @invariant  4. An availability check tolerates `certifiedEpoch: null` inside the grace window.
// @ac         docs/KEEPER.md §13 A8 — WALRUS_EPOCHS never defaults to 1; renewal task present
// @verify     npm run test -- storage
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Millis } from '../types.js';

export interface PutOptions {
  /** Blob lifetime in Walrus epochs. ALWAYS explicit — see the @facts block. */
  readonly epochs: number;
  /** Abort budget for the upload, ms. */
  readonly timeoutMs?: Millis;
}

export interface PutResult {
  /** Content-derived, self-certifying blob id. */
  readonly blobId: string;
  /** Sui object id of the blob registration, when the publisher returns one. */
  readonly blobObjectId?: string;
  readonly startEpoch?: number;
  readonly endEpoch?: number;
  /** ⚠ `null` on a fresh write — that is NORMAL, not a failure. */
  readonly certifiedEpoch: number | null;
  /** ⚠ `true` on a fresh write. */
  readonly deletable: boolean;
}

export interface BlobStatus {
  readonly blobId: string;
  readonly certifiedEpoch: number | null;
  readonly deletable: boolean;
  readonly endEpoch?: number;
  /** `true` once the blob is readable from the aggregator. */
  readonly available: boolean;
}

/** cfg.walrus.epochs, or an explicit override. Throws below 2 — never silently defaults (invariant 1). */
// TODO(T2.9): opts?.epochs ?? cfg.walrus.epochs; assert >= 2; return.
export function resolveEpochs(_cfg: Config, _opts: Partial<PutOptions> = {}): number {
  throw new Error('TODO(T2.9): resolveEpochs not implemented');
}

/** `GET {aggregator}/v1/blobs/{blobId}` — the canonical read URL. */
// TODO(T2.9): join cfg.walrus.aggregator + '/v1/blobs/' + encodeURIComponent(blobId).
export function blobUrl(_cfg: Config, _blobId: string): string {
  throw new Error('TODO(T2.9): blobUrl not implemented');
}

/**
 * Upload bytes. The payload MUST already be encrypted (G8) — Walrus blobs are public.
 * `epochs` is always sent explicitly (invariant 2).
 */
// TODO(T2.9): PUT `${cfg.walrus.publisher}/v1/blobs?epochs=${resolveEpochs(cfg, opts)}` with the raw
//             body; parse newlyCreated/alreadyCertified into PutResult; retry against the backups.
export async function put(
  _cfg: Config,
  _bytes: Uint8Array,
  _opts: Partial<PutOptions> = {},
): Promise<PutResult> {
  throw new Error('TODO(T2.9): put not implemented');
}

/** Download a blob by content-derived id. */
// TODO(T2.9): GET blobUrl(cfg, blobId) → Uint8Array; fall back to the mirror aggregators.
export async function get(_cfg: Config, _blobId: string): Promise<Uint8Array> {
  throw new Error('TODO(T2.9): get not implemented');
}

/** Availability + lifetime probe. Tolerates the fresh-blob `certifiedEpoch: null` window. */
// TODO(T2.9): HEAD/GET the aggregator + read the blob's status; map to BlobStatus.
export async function status(_cfg: Config, _blobId: string): Promise<BlobStatus> {
  throw new Error('TODO(T2.9): status not implemented');
}
