// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
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
// @facts      ⚠ Session keys are SECRETS: never journaled, never logged, never written to disk.
// @facts        `redactSecrets` (../config.ts) is the pattern to follow for anything adjacent.
// @facts      ⚠ `@mysten/seal` is NOT an installed dependency (see @blocked in the T2.6 handover).
// @facts      TTL comes from config/args, never a literal here (G7).
// @implements export interface SealSession / SessionOptions
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
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Millis, ObjectId } from '../types.js';

import type { SealDeps, SealIdentity } from './seal.js';

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

/** Mint a short-lived session for one `run`. */
// TODO(T2.6): SessionKey.create({ address: signer address, packageId: cfg.aphotic.packageId,
//             ttlMin from opts.ttlMs, suiClient: deps.client }) and sign the personal message.
export async function createSession(
  _deps: SealDeps,
  _signer: Signer,
  _opts: SessionOptions,
): Promise<SealSession> {
  throw new Error('TODO(T2.6): createSession not implemented');
}

/** PURE expiry check. */
// TODO(T2.6): nowMs >= session.expiresAtMs.
export function isExpired(_session: SealSession, _nowMs: Millis): boolean {
  throw new Error('TODO(T2.6): isExpired not implemented');
}

/** PURE: not expired AND bound to exactly this (vault, versionEpoch). Throws otherwise. */
// TODO(T2.6): assert vaultId + versionEpoch match and !isExpired; rotation must invalidate.
export function assertUsable(
  _session: SealSession,
  _id: SealIdentity,
  _nowMs: Millis,
): void {
  throw new Error('TODO(T2.6): assertUsable not implemented');
}

/** Safe-to-log projection — key material replaced (mirrors `redactSecrets` in ../config.ts). */
// TODO(T2.6): return { ...session, key: '***' }.
export function redactSession(_session: SealSession): SealSession {
  throw new Error('TODO(T2.6): redactSession not implemented');
}
