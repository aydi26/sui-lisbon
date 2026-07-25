// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.9
// @phase      2
// @status     DONE
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
// @facts        ../privacy/seal.ts BEFORE it ever reaches this module. `put` is FAIL-CLOSED: the
// @facts        payload class defaults to 'strategy-ciphertext' and is REFUSED unless the caller
// @facts        attests `encrypted: true`. `putEncrypted` is the only sanctioned strategy path —
// @facts        it runs the encryptor itself so the transport is never handed plaintext.
// @facts      HTTP API (docs/FACTS.md#walrus, verified round trip 2026-07-25):
// @facts        PUT  {cfg.walrus.publisher}/v1/blobs?epochs=<N>     body = raw bytes
// @facts        GET  {cfg.walrus.aggregator}/v1/blobs/{blobId}      → the exact bytes
// @facts        Primary: publisher.walrus-testnet.walrus.space / aggregator.walrus-testnet.walrus.space
// @facts        Backups (staketab, nodes.guru) live in config/env, never here (G7); they reach this
// @facts        module through `PutOptions.endpoints` / `ReadOptions.endpoints`.
// @facts      PUT response (DAY-ONE-RESULTS §D8, verbatim):
// @facts        {"newlyCreated":{"blobObject":{"id":"0x…","registeredEpoch":469,"blobId":"Gvttnu…",
// @facts          "certifiedEpoch":null,"storage":{"startEpoch":469,"endEpoch":474},"deletable":true}}}
// @facts        or {"alreadyCertified":{"blobId":"…","endEpoch":N,"event":{…}}}
// @facts      ⚠ A FRESHLY PUBLISHED BLOB RETURNS `certifiedEpoch: null` AND `deletable: true`.
// @facts        Any availability predicate demanding certified + non-deletable REJECTS OUR OWN
// @facts        WRITES. Allow a grace window (also true of the on-chain check — E-M11).
// @facts      FRESH_BLOB_GRACE_MS = 600_000 — the window in which `certifiedEpoch: null` is NORMAL.
// @facts      DEFAULT_TIMEOUT_MS  = 60_000  — abort budget per endpoint attempt.
// @facts      ⚠ `@mysten/walrus` is NOT an installed dependency — use the HTTP publisher/aggregator
// @facts        through an INJECTABLE `FetchLike` (global fetch by default). The injection point is
// @facts        what makes the whole module testable with zero network (vitest opens no sockets).
// @facts      The vault also retains an in-object ciphertext copy, so blob expiry degrades
// @facts        VERIFIABILITY rather than halting the vault (docs/FACTS.md#walrus).
// @implements export interface PutOptions / ReadOptions / PutResult / BlobStatus / Encryptor
// @implements export type FetchLike / PayloadClass
// @implements export function resolveEpochs(cfg: Config, opts?: Partial<PutOptions>): number
// @implements export async function put(cfg: Config, bytes: Uint8Array, opts?: Partial<PutOptions>): Promise<PutResult>
// @implements export async function putEncrypted(cfg: Config, plaintext: Uint8Array, encryptor: Encryptor, opts?: Partial<PutOptions>): Promise<PutResult>
// @implements export async function get(cfg: Config, blobId: string, opts?: ReadOptions): Promise<Uint8Array>
// @implements export async function status(cfg: Config, blobId: string, opts?: StatusOptions): Promise<BlobStatus>
// @implements export function blobUrl(cfg: Config, blobId: string, base?: string): string
// @implements export function isAvailable(s: BlobStatus, ageMs: Millis, graceMs?: Millis): boolean
// @forbidden  omitting `epochs` on a PUT, or defaulting it to 1 — G7/A8, the liveness trap
// @forbidden  uploading plaintext strategy material (G8) — encrypt first, always
// @forbidden  a hardcoded publisher/aggregator URL — config only (gates.ps1 ids)
// @invariant  1. `resolveEpochs` returns >= 2 or throws; there is no silent default.
// @invariant  2. `put` always sends `?epochs=<resolved>`; the query parameter is never optional.
// @invariant  3. `get(put(bytes)) === bytes` byte-for-byte (blob ids are content-derived).
// @invariant  4. An availability check tolerates `certifiedEpoch: null` inside the grace window.
// @invariant  5. `putEncrypted` never hands the transport bytes equal to the plaintext.
// @ac         docs/KEEPER.md §13 A8 — WALRUS_EPOCHS never defaults to 1; renewal task present
// @verify     npm run test -- storage
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { Millis } from '../types.js';
import { bytesEqual } from '../util/bytes.js';
import { AphoticError, ConfigError, NotFoundError } from '../util/errors.js';

// ── constants (see @facts) ───────────────────────────────────────────────────

/** Minimum blob lifetime. Walrus itself accepts 1; we never do (A8). */
export const MIN_EPOCHS = 2 as const;
/** Fresh writes report `certifiedEpoch: null`; tolerate it for this long (E-K12/E-M11). */
export const FRESH_BLOB_GRACE_MS = 600_000 as const;
/** Per-endpoint abort budget. */
export const DEFAULT_TIMEOUT_MS = 60_000 as const;

const BLOBS_PATH = '/v1/blobs';

// ── injectable transport ─────────────────────────────────────────────────────

export interface HttpInit {
  readonly method?: string;
  readonly body?: Uint8Array;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The one seam between this module and the network. Production passes nothing and gets the
 * global `fetch`; every test passes an in-memory implementation, which is why the whole suite
 * runs offline (vitest.config.ts @forbidden: "any test that opens a network socket").
 */
export type FetchLike = (url: string, init?: HttpInit) => Promise<HttpResponseLike>;

// ── payload classification (G8) ──────────────────────────────────────────────

/**
 * What is inside the blob.
 * - `strategy-ciphertext` — Seal output. MUST be encrypted; this is the fail-closed default.
 * - `decision-log`        — journal segments. Public BY DESIGN (that is the transparency claim),
 *                           and they carry no plaintext strategy parameters (only blob id + ruleset).
 */
export type PayloadClass = 'strategy-ciphertext' | 'decision-log';

/** Anything that turns plaintext into ciphertext — `privacy/seal.ts` (T2.6) satisfies it. */
export interface Encryptor {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
}

// ── options / results ────────────────────────────────────────────────────────

export interface PutOptions {
  /** Blob lifetime in Walrus epochs. ALWAYS explicit — see the @facts block. */
  readonly epochs: number;
  /** Abort budget for the upload, ms. */
  readonly timeoutMs?: Millis;
  /** Defaults to `strategy-ciphertext` — fail-closed (G8). */
  readonly payload?: PayloadClass;
  /** Caller's attestation that strategy material was encrypted upstream. */
  readonly encrypted?: boolean;
  /** Publisher endpoints, in order. Defaults to `[cfg.walrus.publisher]`. */
  readonly endpoints?: readonly string[];
  /** Injected transport. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

export interface ReadOptions {
  readonly timeoutMs?: Millis;
  /** Aggregator endpoints, in order. Defaults to `[cfg.walrus.aggregator]`. */
  readonly endpoints?: readonly string[];
  readonly fetch?: FetchLike;
}

export interface StatusOptions extends ReadOptions {
  /**
   * The write receipt for this blob, when the keeper has one. The aggregator answers
   * "is it readable"; only the publisher receipt carries the lifetime window, so lifetime
   * fields come from here rather than being invented.
   */
  readonly receipt?: PutResult;
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

// ── errors (local: keeper/src/util/errors.ts is owned by T0.3 and not edited here) ──

/** Any Walrus transport/protocol failure. `code` is the stable discriminant. */
export class WalrusError extends AphoticError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/**
 * G8 refusal: strategy material reached `put` without being encrypted. The transport is NOT
 * invoked — the store never sees the plaintext, not even once.
 */
export class PlaintextUploadRefusedError extends AphoticError {
  constructor(byteLength: number) {
    super(
      'PlaintextUploadRefused',
      `refusing to upload ${byteLength} bytes of unencrypted strategy material: Walrus blobs are ` +
        `PUBLIC and discoverable — encrypt before upload, always (G8). Use putEncrypted(), or pass ` +
        `{ payload: 'decision-log' } if this really is a public journal segment.`,
    );
  }
}

// ── epochs (invariant 1) ─────────────────────────────────────────────────────

/** cfg.walrus.epochs, or an explicit override. Throws below 2 — never silently defaults. */
export function resolveEpochs(cfg: Config, opts: Partial<PutOptions> = {}): number {
  const epochs = opts.epochs ?? cfg.walrus.epochs;
  if (!Number.isInteger(epochs) || epochs < MIN_EPOCHS) {
    throw new ConfigError(
      `walrus epochs must be an integer >= ${MIN_EPOCHS} (never the 1-epoch Walrus default) — got ${String(epochs)}`,
      ['WALRUS_EPOCHS'],
    );
  }
  return epochs;
}

// ── urls ─────────────────────────────────────────────────────────────────────

/** `GET {aggregator}/v1/blobs/{blobId}` — the canonical read URL. */
export function blobUrl(cfg: Config, blobId: string, base?: string): string {
  const root = trimSlash(base ?? requireEndpoint(cfg.walrus.aggregator, 'WALRUS_AGGREGATOR'));
  return `${root}${BLOBS_PATH}/${encodeURIComponent(blobId)}`;
}

function putUrl(base: string, epochs: number): string {
  // invariant 2: `epochs` is part of every PUT, unconditionally.
  return `${trimSlash(base)}${BLOBS_PATH}?epochs=${epochs}`;
}

// ── put ──────────────────────────────────────────────────────────────────────

/**
 * Upload bytes. The payload MUST already be encrypted (G8) unless it is explicitly classified
 * as a public decision-log segment. `epochs` is always sent explicitly (invariant 2).
 */
export async function put(
  cfg: Config,
  bytes: Uint8Array,
  opts: Partial<PutOptions> = {},
): Promise<PutResult> {
  const epochs = resolveEpochs(cfg, opts);
  assertEncryptBeforeUpload(bytes, opts);

  const endpoints = resolveEndpoints(opts.endpoints, cfg.walrus.publisher, 'WALRUS_PUBLISHER');
  const doFetch = opts.fetch ?? globalFetch();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];

  for (const base of endpoints) {
    const url = putUrl(base, epochs);
    try {
      const res = await withTimeout(timeoutMs, (signal) =>
        doFetch(url, {
          method: 'PUT',
          body: bytes,
          headers: { 'content-type': 'application/octet-stream' },
          signal,
        }),
      );
      if (!res.ok) {
        failures.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      return parsePutResponse(await res.text(), url);
    } catch (error) {
      failures.push(`${url} → ${describe(error)}`);
    }
  }

  throw new WalrusError(
    'WalrusPutFailed',
    `walrus PUT failed on all ${endpoints.length} publisher endpoint(s): ${failures.join(' | ')}`,
  );
}

/**
 * THE sanctioned strategy-blob path: encrypt, then upload the ciphertext.
 * The transport is handed the encryptor's output and nothing else (invariant 5).
 */
export async function putEncrypted(
  cfg: Config,
  plaintext: Uint8Array,
  encryptor: Encryptor,
  opts: Partial<PutOptions> = {},
): Promise<PutResult> {
  const ciphertext = await encryptor.encrypt(plaintext);
  if (bytesEqual(ciphertext, plaintext)) {
    // A pass-through "encryptor" would silently publish the strategy. Refuse (G8).
    throw new PlaintextUploadRefusedError(plaintext.length);
  }
  return put(cfg, ciphertext, { ...opts, payload: 'strategy-ciphertext', encrypted: true });
}

function assertEncryptBeforeUpload(bytes: Uint8Array, opts: Partial<PutOptions>): void {
  const payload: PayloadClass = opts.payload ?? 'strategy-ciphertext';
  if (payload === 'strategy-ciphertext' && opts.encrypted !== true) {
    throw new PlaintextUploadRefusedError(bytes.length);
  }
}

// ── get ──────────────────────────────────────────────────────────────────────

/** Download a blob by content-derived id. Falls back across the aggregator mirrors. */
export async function get(cfg: Config, blobId: string, opts: ReadOptions = {}): Promise<Uint8Array> {
  const endpoints = resolveEndpoints(opts.endpoints, cfg.walrus.aggregator, 'WALRUS_AGGREGATOR');
  const doFetch = opts.fetch ?? globalFetch();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];
  let sawNotFound = false;

  for (const base of endpoints) {
    const url = blobUrl(cfg, blobId, base);
    try {
      const res = await withTimeout(timeoutMs, (signal) => doFetch(url, { method: 'GET', signal }));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 404) sawNotFound = true;
      failures.push(`${url} → HTTP ${res.status}`);
    } catch (error) {
      failures.push(`${url} → ${describe(error)}`);
    }
  }

  if (sawNotFound) throw new NotFoundError(`walrus blob ${blobId}`);
  throw new WalrusError(
    'WalrusGetFailed',
    `walrus GET failed on all ${endpoints.length} aggregator endpoint(s): ${failures.join(' | ')}`,
  );
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Availability probe. `available` is measured (the aggregator either serves the blob or it does
 * not); the lifetime fields come from the write receipt, because the read path does not report
 * them. Tolerates the fresh-blob `certifiedEpoch: null` window — see {@link isAvailable}.
 */
export async function status(
  cfg: Config,
  blobId: string,
  opts: StatusOptions = {},
): Promise<BlobStatus> {
  const endpoints = resolveEndpoints(opts.endpoints, cfg.walrus.aggregator, 'WALRUS_AGGREGATOR');
  const doFetch = opts.fetch ?? globalFetch();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let available = false;
  for (const base of endpoints) {
    const url = blobUrl(cfg, blobId, base);
    try {
      let res = await withTimeout(timeoutMs, (signal) => doFetch(url, { method: 'HEAD', signal }));
      // Some aggregators answer 405 to HEAD; fall back to a plain GET before concluding.
      if (res.status === 405 || res.status === 501) {
        res = await withTimeout(timeoutMs, (signal) => doFetch(url, { method: 'GET', signal }));
      }
      if (res.ok) {
        available = true;
        break;
      }
    } catch {
      // an unreachable mirror is not evidence of an unavailable blob — try the next one
    }
  }

  const receipt = opts.receipt;
  return {
    blobId,
    certifiedEpoch: receipt?.certifiedEpoch ?? null,
    // Publisher-created blobs are deletable by default (D8) — assume the unsafe value when unknown.
    deletable: receipt?.deletable ?? true,
    endEpoch: receipt?.endEpoch,
    available,
  };
}

/**
 * Invariant 4. A blob is usable if the aggregator serves it AND either it is certified or it is
 * still inside the grace window. Demanding `certifiedEpoch != null` immediately would reject our
 * own fresh writes (E-K12 / E-M11) — which is exactly the bug this predicate exists to prevent.
 */
export function isAvailable(
  s: BlobStatus,
  ageMs: Millis,
  graceMs: Millis = FRESH_BLOB_GRACE_MS,
): boolean {
  if (!s.available) return false;
  if (s.certifiedEpoch !== null) return true;
  return ageMs <= graceMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────────────

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function requireEndpoint(value: string, envVar: string): string {
  if (value === '') {
    throw new ConfigError(`${envVar} is not set — walrus storage is unconfigured`, [envVar]);
  }
  return value;
}

function resolveEndpoints(
  override: readonly string[] | undefined,
  fallback: string,
  envVar: string,
): readonly string[] {
  const list = (override ?? []).filter((u) => u !== '');
  if (list.length > 0) return list;
  return [requireEndpoint(fallback, envVar)];
}

/** The global `fetch`, resolved lazily so that an injected transport never needs one to exist. */
function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new WalrusError(
      'NoFetchAvailable',
      'no global fetch in this runtime — pass an explicit `fetch` in the walrus options',
    );
  }
  return f as FetchLike;
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parsePutResponse(text: string, url: string): PutResult {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new WalrusError('WalrusBadResponse', `walrus PUT ${url} returned non-JSON: ${clip(text)}`);
  }

  const root = asRecord(json);

  const blobObject = asRecord(asRecord(root?.['newlyCreated'])?.['blobObject']);
  if (blobObject) {
    const storage = asRecord(blobObject['storage']);
    const blobId = optStr(blobObject['blobId']);
    if (blobId === undefined) {
      throw new WalrusError('WalrusBadResponse', `walrus PUT ${url}: newlyCreated without a blobId`);
    }
    return {
      blobId,
      blobObjectId: optStr(blobObject['id']),
      startEpoch: optNum(storage?.['startEpoch']),
      endEpoch: optNum(storage?.['endEpoch']),
      // ⚠ null on a fresh write — normal, not a failure.
      certifiedEpoch: optNum(blobObject['certifiedEpoch']) ?? null,
      deletable: blobObject['deletable'] === true,
    };
  }

  const already = asRecord(root?.['alreadyCertified']);
  if (already) {
    const blobId = optStr(already['blobId']);
    if (blobId === undefined) {
      throw new WalrusError(
        'WalrusBadResponse',
        `walrus PUT ${url}: alreadyCertified without a blobId`,
      );
    }
    return {
      blobId,
      endEpoch: optNum(already['endEpoch']),
      certifiedEpoch: optNum(already['certifiedEpoch']) ?? null,
      // An already-certified blob is a committed one, not a publisher-owned deletable draft.
      deletable: false,
    };
  }

  throw new WalrusError(
    'WalrusBadResponse',
    `walrus PUT ${url}: neither newlyCreated nor alreadyCertified in ${clip(text)}`,
  );
}

function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
