// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     PARTIAL — every body is real; `createSession` needs the `SealBackend` port from
//             ./seal.ts, whose concrete `@mysten/seal` implementation cannot be written until
//             the package is installed (not in keeper/package.json; see the T2.6 handover).
// @spec       docs/KEEPER.md §3.3 ("Session keys: short-lived; created per `run` session")
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · docs/FACTS.md#seal
// @rules      G2 G7 G8
// @depends    ./seal.ts (T2.6) · ../config.ts · aphotic::vault::seal_approve (T1.2)
// @facts      ★ A session key is SHORT-LIVED and scoped to (vault, versionEpoch, ttl). One per
// @facts        `run` session. It authorizes SHARE RETRIEVAL, nothing else — it is not a capability
// @facts        over funds (the keeper still holds only a DeepBook TradeCap, G2).
// @facts      ★ Every share release is gated by an on-chain `aphotic::vault::seal_approve` dry run
// @facts        at each key server. Expiring the session does not weaken that gate; it bounds the
// @facts        blast radius of a leaked session key.
// @facts      A keeper rotation bumps `vault.version_epoch` ⇒ existing sessions become useless
// @facts        because the identity they were minted against no longer resolves (./rotation.ts).
// @facts        On-chain this surfaces as `EStaleVersionEpoch` from `vault::check_seal_access`.
// @facts      ⚠ Session keys are SECRETS: never journaled, never logged, never written to disk.
// @facts        `redactSecrets` (../config.ts) is the pattern to follow for anything adjacent.
// @facts      ⚠ `@mysten/seal` is NOT an installed dependency ⇒ the SDK is reached through
// @facts        `SealBackend.createSessionKey` (./seal.ts).
// @facts      TTL comes from config/args, never a literal here (G7). Seal's `SessionKey` takes a
// @facts        TTL in WHOLE MINUTES, so `ttlMs` is rounded UP to at least one minute.
// @implements export interface SealSession / SessionOptions
// @implements export const SESSION_UNUSABLE_CODE: 'SessionUnusable'
// @implements export async function createSession(deps: SealDeps, signer: Signer, opts: SessionOptions): Promise<SealSession>
// @implements export function isExpired(session: SealSession, nowMs: Millis): boolean
// @implements export function assertUsable(session: SealSession, id: SealIdentity, nowMs: Millis): void
// @implements export function redactSession(session: SealSession): SealSession
// @forbidden  logging/journaling/persisting a session key (G8)
// @forbidden  reusing a session across version epochs — rotation must invalidate it
// @forbidden  treating the session as a fund-moving capability — it is not (G2)
// @invariant  1. `isExpired`/`assertUsable` are PURE (`nowMs` is an argument).
// @invariant  2. A session carries its vault id AND version epoch; both are checked before use.
// @invariant  3. `redactSession` never returns the key material.
// @ac         docs/KEEPER.md §3.3 — one short-lived session per run, epoch-scoped
// @verify     npm run test -- privacy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Millis, ObjectId } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import { requireSealBackend, type SealDeps, type SealIdentity } from './seal.js';

export interface SessionOptions {
  readonly vaultId: ObjectId;
  /** Must match the vault's current `version_epoch`. */
  readonly versionEpoch: number;
  /** Lifetime in ms. Short by design. */
  readonly ttlMs: Millis;
  /** Session creation time (ms epoch), supplied by the caller for replayability. */
  readonly createdAtMs: Millis;
}

/**
 * ⚠ SECRET. Never logged, journaled, or persisted. Authorizes Seal share retrieval only —
 * it is not a capability over funds (G2).
 */
export interface SealSession {
  readonly vaultId: ObjectId;
  readonly versionEpoch: number;
  readonly createdAtMs: Millis;
  readonly expiresAtMs: Millis;
  /** Opaque handle to the underlying Seal session key. Never serialize this. */
  readonly key: unknown;
}

/** Stable error code so tests never match on message text (util/errors.ts invariant 1). */
export const SESSION_UNUSABLE_CODE = 'SessionUnusable' as const;

const MS_PER_MINUTE = 60_000;

/** Mint a short-lived session for one `run`. */
export async function createSession(
  deps: SealDeps,
  signer: Signer,
  opts: SessionOptions,
): Promise<SealSession> {
  const backend = requireSealBackend(deps);

  if (typeof opts.vaultId !== 'string' || opts.vaultId.trim() === '') {
    throw new ConfigError('createSession requires a vault object id (VAULT_ID)', ['VAULT_ID']);
  }
  if (!Number.isInteger(opts.versionEpoch) || opts.versionEpoch < 0) {
    throw new ConfigError(
      `createSession requires a non-negative integer version epoch — got ${String(opts.versionEpoch)}`,
      ['SEAL_VERSION_EPOCH'],
    );
  }
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new ConfigError(`session ttlMs must be > 0 — got ${String(opts.ttlMs)}`, []);
  }
  if (!Number.isFinite(opts.createdAtMs) || opts.createdAtMs < 0) {
    throw new ConfigError(`session createdAtMs must be a non-negative epoch — got ${String(opts.createdAtMs)}`, []);
  }
  if (deps.cfg.aphotic.packageId === '') {
    throw new ConfigError(
      'APHOTIC_PACKAGE_ID is unset — the session key is scoped to the package whose ' +
        '`vault::seal_approve` gates every share release',
      ['APHOTIC_PACKAGE_ID'],
    );
  }

  const key = await backend.createSessionKey({
    address: signer.toSuiAddress(),
    packageId: deps.cfg.aphotic.packageId,
    // Seal counts TTL in whole minutes; round UP so a sub-minute ttl is still usable once.
    ttlMinutes: Math.max(1, Math.ceil(opts.ttlMs / MS_PER_MINUTE)),
    signer,
  });

  return {
    vaultId: opts.vaultId,
    versionEpoch: opts.versionEpoch,
    createdAtMs: opts.createdAtMs,
    expiresAtMs: opts.createdAtMs + opts.ttlMs,
    key,
  };
}

/** PURE expiry check (invariant 1). */
export function isExpired(session: SealSession, nowMs: Millis): boolean {
  return nowMs >= session.expiresAtMs;
}

/**
 * PURE: not expired AND bound to exactly this (vault, versionEpoch). Throws otherwise.
 *
 * The epoch check is the whole point of rotation: after `vault::set_keeper` bumps
 * `version_epoch`, a session minted under the old epoch must be rejected HERE, before the key
 * servers reject it on-chain with `EStaleVersionEpoch`.
 */
export function assertUsable(session: SealSession, id: SealIdentity, nowMs: Millis): void {
  if (session.vaultId !== id.vaultId) {
    throw new AphoticError(
      SESSION_UNUSABLE_CODE,
      `session is bound to vault ${session.vaultId}, not ${id.vaultId}`,
    );
  }
  if (session.versionEpoch !== id.versionEpoch) {
    throw new AphoticError(
      SESSION_UNUSABLE_CODE,
      `session was minted under version epoch ${session.versionEpoch}, but the vault is at ` +
        `${id.versionEpoch} — a rotation invalidated it (this is the epoch doing its job)`,
    );
  }
  if (isExpired(session, nowMs)) {
    throw new AphoticError(
      SESSION_UNUSABLE_CODE,
      `session expired at ${session.expiresAtMs}ms, now ${nowMs}ms`,
    );
  }
}

/** Safe-to-log projection — key material replaced (mirrors `redactSecrets` in ../config.ts). */
export function redactSession(session: SealSession): SealSession {
  return { ...session, key: '***' };
}
