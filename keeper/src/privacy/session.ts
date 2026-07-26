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
// @facts      ★ A session key is SHORT-LIVED and scoped to (package, policyVersion, ttl). It
// @facts        authorizes SHARE RETRIEVAL, nothing else — it is not a capability over funds, and
// @facts        no keeper function takes an address at all (DESIGN-V2 §7, INV-C1).
// @facts      ★ It is NOT bound to a single batch. Seal scopes a SessionKey to a package and a
// @facts        TTL, so one session legitimately opens several batches inside its window; minting
// @facts        one per batch would buy nothing.
// @facts      ★ Every share release is gated by an on-chain `aphotic::batch::seal_approve` dry run
// @facts        at each key server. Expiring the session does not weaken that gate; it bounds the
// @facts        blast radius of a leaked session key.
// @facts      Bumping `BatchRegistry.policy_version` invalidates every outstanding identity at
// @facts        once ⇒ sessions minted under the old version must be refused HERE, locally, before
// @facts        the key servers decline them. Upstream `tle.move` has NO versioning; this is the
// @facts        half we added, and it is worthless if only the Move side enforces it.
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

import type { Millis } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import { requireSealBackend, sealPackageId, type SealDeps, type SealIdentity } from './seal.js';

export interface SessionOptions {
  /** Must match `BatchRegistry.policy_version`. A bump invalidates every session. */
  readonly policyVersion: number;
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
  readonly policyVersion: number;
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

  if (!Number.isInteger(opts.policyVersion) || opts.policyVersion < 0) {
    throw new ConfigError(
      `createSession requires a non-negative integer policy version — got ${String(opts.policyVersion)}`,
      ['SEAL_POLICY_VERSION'],
    );
  }
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new ConfigError(`session ttlMs must be > 0 — got ${String(opts.ttlMs)}`, []);
  }
  if (!Number.isFinite(opts.createdAtMs) || opts.createdAtMs < 0) {
    throw new ConfigError(`session createdAtMs must be a non-negative epoch — got ${String(opts.createdAtMs)}`, []);
  }
  // ⚠ The FIRST-published id, not `published-at` — `SessionKey.create` rejects any package whose
  // on-chain version is not 1. See ./seal.ts `sealPackageId`.
  const sealPackage = sealPackageId(deps.cfg);

  const key = await backend.createSessionKey({
    address: signer.toSuiAddress(),
    packageId: sealPackage,
    // Seal counts TTL in whole minutes; round UP so a sub-minute ttl is still usable once.
    ttlMinutes: Math.max(1, Math.ceil(opts.ttlMs / MS_PER_MINUTE)),
    signer,
  });

  return {
    policyVersion: opts.policyVersion,
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
 * PURE: not expired AND minted under exactly this policy version. Throws otherwise.
 *
 * The version check is the whole point of versioning: bumping
 * `BatchRegistry.policy_version` invalidates every outstanding identity at once, and
 * a session minted under the old version must be rejected HERE, locally, before the
 * key servers decline it. Upstream's `tle.move` has no versioning at all — this is
 * the half we added, and it is worthless if only the Move side enforces it.
 *
 * Note the session is NOT bound to a single batch. A Seal `SessionKey` is scoped to a
 * package and a TTL, so one session legitimately decrypts several batches inside its
 * window; binding it per batch would mint a key per batch for no security gain.
 */
export function assertUsable(session: SealSession, id: SealIdentity, nowMs: Millis): void {
  if (session.policyVersion !== id.policyVersion) {
    throw new AphoticError(
      SESSION_UNUSABLE_CODE,
      `session was minted under policy version ${session.policyVersion}, but the registry is at ` +
        `${id.policyVersion} — a bump invalidated it (this is the versioning doing its job)`,
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
