// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.9
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §8 (`renew(blobId)` — lifetime-renewal task, alerts on failure)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.9) · docs/FACTS.md#walrus
// @rules      G7 G8
// @depends    ./walrus.ts (T2.9) · ../config.ts
// @facts      ★ WHY THIS EXISTS: `envelope.move` reads the strategy blob's availability on-chain
// @facts        before permitting keeper actions. If the blob expires, the vault stops being
// @facts        verifiable — and, worse, a naive availability predicate would HALT it. Renewal is
// @facts        a standing background task, not an afterthought (docs/KEEPER.md §8).
// @facts      Renewal = re-`put` the same bytes with a fresh `epochs` window. Blob ids are
// @facts        CONTENT-DERIVED, so re-uploading identical bytes yields the SAME blob id and the
// @facts        on-chain pointer stays valid. Nothing on-chain has to change.
// @facts      cfg.walrus.epochs (>= 2, default 12) is the window; renew when the remaining life
// @facts        drops below `renewBeforeEpochs`.
// @facts      ⚠ A fresh write reports `certifiedEpoch: null` / `deletable: true` — do NOT treat that
// @facts        as a failed renewal (docs/FACTS.md#walrus, ERRATA E-K12 / E-M11).
// @facts      Current Walrus epoch (2026-07-25 reference point): 469. The live epoch is read at
// @facts        runtime; never hardcode it.
// @facts      The vault also keeps an in-object ciphertext copy, so a missed renewal degrades
// @facts        verifiability rather than halting the vault — but it MUST alert.
// @implements export interface RenewPolicy / RenewOutcome
// @implements export function defaultRenewPolicy(cfg: Config): RenewPolicy
// @implements export function needsRenewal(status: BlobStatus, currentEpoch: number, policy: RenewPolicy): boolean
// @implements export async function renew(cfg: Config, blobId: string, bytes: Uint8Array, policy: RenewPolicy): Promise<RenewOutcome>
// @implements export async function renewAll(cfg: Config, blobs: readonly TrackedBlob[], policy: RenewPolicy): Promise<readonly RenewOutcome[]>
// @forbidden  renewing with an implicit/1-epoch lifetime — the same trap as ./walrus.ts
// @forbidden  silently swallowing a renewal failure — it must surface as an alert
// @invariant  1. `needsRenewal` is PURE (`currentEpoch` is an argument).
// @invariant  2. Renewal preserves the blob id — identical bytes in, identical id out.
// @invariant  3. A failed renewal is reported, never retried into an infinite loop.
// @ac         docs/KEEPER.md §13 A8 — renewal task present
// @verify     npm run test -- storage
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Millis } from '../types.js';

import type { BlobStatus, PutResult } from './walrus.js';

export interface RenewPolicy {
  /** Lifetime to request on each renewal, in epochs. Always >= 2. */
  readonly epochs: number;
  /** Renew once fewer than this many epochs of life remain. */
  readonly renewBeforeEpochs: number;
  /** Background check cadence, ms. */
  readonly checkIntervalMs: Millis;
}

/** A blob the keeper is responsible for keeping alive. */
export interface TrackedBlob {
  readonly blobId: string;
  /** The exact bytes originally uploaded — required for a content-identical re-put. */
  readonly bytes: Uint8Array;
  readonly label: 'strategy' | 'journal-segment';
}

export interface RenewOutcome {
  readonly blobId: string;
  readonly renewed: boolean;
  readonly result?: PutResult;
  /** Set when renewal failed — the caller MUST alert on this (invariant 3). */
  readonly error?: string;
}

/** Policy derived from config: `epochs` from cfg.walrus.epochs, with a sane safety margin. */
// TODO(T2.9): { epochs: cfg.walrus.epochs, renewBeforeEpochs: ceil(epochs/4), checkIntervalMs }.
export function defaultRenewPolicy(_cfg: Config): RenewPolicy {
  throw new Error('TODO(T2.9): defaultRenewPolicy not implemented');
}

/** PURE: does this blob need re-uploading now? */
// TODO(T2.9): (status.endEpoch ?? 0) - currentEpoch < policy.renewBeforeEpochs, or !status.available.
export function needsRenewal(
  _status: BlobStatus,
  _currentEpoch: number,
  _policy: RenewPolicy,
): boolean {
  throw new Error('TODO(T2.9): needsRenewal not implemented');
}

/** Re-`put` identical bytes with a fresh window. The blob id is unchanged (invariant 2). */
// TODO(T2.9): walrus.put(cfg, bytes, { epochs: policy.epochs }); assert the returned blobId matches.
export async function renew(
  _cfg: Config,
  _blobId: string,
  _bytes: Uint8Array,
  _policy: RenewPolicy,
): Promise<RenewOutcome> {
  throw new Error('TODO(T2.9): renew not implemented');
}

/** Sweep every tracked blob once. Never throws — failures come back as `RenewOutcome.error`. */
// TODO(T2.9): status() each blob, needsRenewal(), renew() the ones that qualify, collect outcomes.
export async function renewAll(
  _cfg: Config,
  _blobs: readonly TrackedBlob[],
  _policy: RenewPolicy,
): Promise<readonly RenewOutcome[]> {
  throw new Error('TODO(T2.9): renewAll not implemented');
}
