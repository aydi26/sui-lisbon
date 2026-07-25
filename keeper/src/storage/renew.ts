// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.9
// @phase      2
// @status     DONE
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
// @facts      DEFAULT_RENEW_BEFORE_FRACTION = 1/4 — renew once the last quarter of the window is
// @facts        left (>= 1 epoch), so a missed check cycle still leaves time to recover.
// @facts      DEFAULT_CHECK_INTERVAL_MS = 3_600_000 (1 h). Walrus testnet epochs are day-scale
// @facts        (D8 observed epoch 469 → 474 for `?epochs=5`), so hourly is ample and cheap.
// @facts      ⚠ A fresh write reports `certifiedEpoch: null` / `deletable: true` — do NOT treat that
// @facts        as a failed renewal (docs/FACTS.md#walrus, ERRATA E-K12 / E-M11). `renewAll`
// @facts        therefore keys off ENDEPOCH and readability, never off `certifiedEpoch`.
// @facts      Current Walrus epoch (2026-07-25 reference point): 469. The live epoch is read at
// @facts        runtime and arrives as `RenewContext.currentEpoch`; never hardcode it.
// @facts      The vault also keeps an in-object ciphertext copy, so a missed renewal degrades
// @facts        verifiability rather than halting the vault — but it MUST alert.
// @implements export interface RenewPolicy / RenewOutcome / TrackedBlob / RenewContext
// @implements export function defaultRenewPolicy(cfg: Config): RenewPolicy
// @implements export function assertRenewPolicy(policy: RenewPolicy): void
// @implements export function needsRenewal(status: BlobStatus, currentEpoch: number, policy: RenewPolicy): boolean
// @implements export async function renew(cfg: Config, blobId: string, bytes: Uint8Array, policy: RenewPolicy, ctx?: RenewContext): Promise<RenewOutcome>
// @implements export async function renewAll(cfg: Config, blobs: readonly TrackedBlob[], policy: RenewPolicy, ctx?: RenewContext): Promise<readonly RenewOutcome[]>
// @forbidden  renewing with an implicit/1-epoch lifetime — the same trap as ./walrus.ts
// @forbidden  silently swallowing a renewal failure — it must surface as an alert
// @invariant  1. `needsRenewal` is PURE (`currentEpoch` is an argument).
// @invariant  2. Renewal preserves the blob id — identical bytes in, identical id out. A mismatch
//                is reported as a FAILED renewal, never accepted.
// @invariant  3. A failed renewal is reported, never retried into an infinite loop: `renewAll`
//                makes at most ONE attempt per blob per sweep and never throws.
// @ac         docs/KEEPER.md §13 A8 — renewal task present
// @verify     npm run test -- storage
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Millis } from '../types.js';
import { ConfigError } from '../util/errors.js';

import {
  MIN_EPOCHS,
  put,
  status,
  type BlobStatus,
  type FetchLike,
  type PayloadClass,
  type PutResult,
} from './walrus.js';

/** Renew once the last quarter of the window remains. */
export const DEFAULT_RENEW_BEFORE_FRACTION = 4 as const;
/** Background sweep cadence. Walrus epochs are day-scale on testnet; hourly is ample. */
export const DEFAULT_CHECK_INTERVAL_MS = 3_600_000 as const;

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
  /** The write receipt, when the keeper still holds it — supplies the lifetime window. */
  readonly receipt?: PutResult;
}

export interface RenewOutcome {
  readonly blobId: string;
  readonly renewed: boolean;
  readonly result?: PutResult;
  /** Set when renewal failed — the caller MUST alert on this (invariant 3). */
  readonly error?: string;
}

/**
 * Ambient inputs for one sweep. `currentEpoch` is read live (never hardcoded); when it is not
 * available the sweep degrades honestly — it can still renew blobs the aggregator refuses to
 * serve, it just cannot compute remaining lifetime.
 */
export interface RenewContext {
  readonly currentEpoch?: number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: Millis;
  readonly publishers?: readonly string[];
  readonly aggregators?: readonly string[];
  /**
   * Classification of the bytes being re-uploaded. Renewal republishes bytes that already passed
   * `put`'s encrypt-before-upload gate once, so the attestation is inherited, not re-decided.
   */
  readonly payload?: PayloadClass;
}

/** Policy derived from config: `epochs` from cfg.walrus.epochs, with a safety margin. */
export function defaultRenewPolicy(cfg: Config): RenewPolicy {
  const epochs = cfg.walrus.epochs;
  const policy: RenewPolicy = {
    epochs,
    renewBeforeEpochs: Math.max(1, Math.ceil(epochs / DEFAULT_RENEW_BEFORE_FRACTION)),
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
  };
  assertRenewPolicy(policy);
  return policy;
}

/** A 1-epoch renewal is the liveness trap this whole module exists to avoid — refuse it loudly. */
export function assertRenewPolicy(policy: RenewPolicy): void {
  if (!Number.isInteger(policy.epochs) || policy.epochs < MIN_EPOCHS) {
    throw new ConfigError(
      `renewal epochs must be an integer >= ${MIN_EPOCHS} (never the 1-epoch Walrus default) — got ${String(policy.epochs)}`,
      ['WALRUS_EPOCHS'],
    );
  }
  if (!Number.isInteger(policy.renewBeforeEpochs) || policy.renewBeforeEpochs < 1) {
    throw new ConfigError(
      `renewBeforeEpochs must be an integer >= 1 — got ${String(policy.renewBeforeEpochs)}`,
      ['WALRUS_EPOCHS'],
    );
  }
}

/**
 * PURE (invariant 1): does this blob need re-uploading now?
 *
 * Unreadable ⇒ yes. Unknown lifetime ⇒ yes (we cannot prove it is alive). Otherwise renew once
 * the remaining life drops below the margin. `certifiedEpoch` is deliberately NOT consulted: a
 * fresh, perfectly good blob reports `null` (E-K12).
 */
export function needsRenewal(
  blobStatus: BlobStatus,
  currentEpoch: number,
  policy: RenewPolicy,
): boolean {
  if (!blobStatus.available) return true;
  const endEpoch = blobStatus.endEpoch;
  if (endEpoch === undefined) return true;
  return endEpoch - currentEpoch < policy.renewBeforeEpochs;
}

/**
 * Re-`put` identical bytes with a fresh window. The blob id is unchanged (invariant 2) because
 * Walrus ids are content-derived; a changed id means the bytes changed and is a FAILURE, not a
 * successful renewal.
 */
export async function renew(
  cfg: Config,
  blobId: string,
  bytes: Uint8Array,
  policy: RenewPolicy,
  ctx: RenewContext = {},
): Promise<RenewOutcome> {
  assertRenewPolicy(policy);

  let result: PutResult;
  try {
    result = await put(cfg, bytes, {
      epochs: policy.epochs,
      // Renewal re-uploads bytes that were already encrypted upstream; re-encrypting would change
      // the ciphertext and therefore the content-derived id, breaking the on-chain pointer.
      payload: ctx.payload ?? 'strategy-ciphertext',
      encrypted: true,
      ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
      ...(ctx.publishers === undefined ? {} : { endpoints: ctx.publishers }),
    });
  } catch (error) {
    return { blobId, renewed: false, error: describe(error) };
  }

  if (result.blobId !== blobId) {
    return {
      blobId,
      renewed: false,
      result,
      error:
        `renewal returned blob id ${result.blobId} for ${blobId}: Walrus ids are content-derived, ` +
        `so the bytes are not the ones originally published — the on-chain pointer would be orphaned`,
    };
  }

  return { blobId, renewed: true, result };
}

/**
 * Sweep every tracked blob ONCE (invariant 3: at most one attempt per blob per sweep, and this
 * function never throws — every failure comes back as `RenewOutcome.error` for the caller to alert on).
 */
export async function renewAll(
  cfg: Config,
  blobs: readonly TrackedBlob[],
  policy: RenewPolicy,
  ctx: RenewContext = {},
): Promise<readonly RenewOutcome[]> {
  assertRenewPolicy(policy);

  const outcomes: RenewOutcome[] = [];
  for (const blob of blobs) {
    try {
      const blobStatus = await status(cfg, blob.blobId, {
        ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
        ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
        ...(ctx.aggregators === undefined ? {} : { endpoints: ctx.aggregators }),
        ...(blob.receipt === undefined ? {} : { receipt: blob.receipt }),
      });

      const due =
        ctx.currentEpoch === undefined
          ? // No live epoch reading: we can only act on what we measured — readability.
            !blobStatus.available
          : needsRenewal(blobStatus, ctx.currentEpoch, policy);

      if (!due) {
        outcomes.push({ blobId: blob.blobId, renewed: false });
        continue;
      }

      outcomes.push(
        await renew(cfg, blob.blobId, blob.bytes, policy, {
          ...ctx,
          payload: ctx.payload ?? (blob.label === 'strategy' ? 'strategy-ciphertext' : 'decision-log'),
        }),
      );
    } catch (error) {
      outcomes.push({ blobId: blob.blobId, renewed: false, error: describe(error) });
    }
  }
  return outcomes;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
