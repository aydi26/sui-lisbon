// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.9
// @phase      2
// @status     DONE
// @spec       docs/KEEPER.md §8 (Walrus put/get/renew) §13 A8 · ERRATA E-K12
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.9)
// @rules      G7 G8 G10
// @depends    ../src/storage/walrus.ts · ../src/storage/renew.ts · ../src/config.ts
// @facts      ⚠ NO NETWORK. Every test drives an IN-MEMORY Walrus that mirrors the real HTTP
// @facts        surface verified on day one: PUT {pub}/v1/blobs?epochs=N → the newlyCreated JSON,
// @facts        GET {agg}/v1/blobs/{id} → the exact bytes. Blob ids are CONTENT-DERIVED (sha256),
// @facts        which is what makes the renewal invariant ("same bytes ⇒ same id") testable.
// @facts      ⚠ NO canonical on-chain ID literal in this file (G7) — config comes from loadConfig.
// @implements epochs are explicit and never 1 · put/get round-trips byte-for-byte ·
//             encrypt-before-upload (the store never sees plaintext) · fresh-blob
//             certifiedEpoch:null grace window · endpoint failover · renewal policy + sweep
// @verify     npm run test -- storage
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import {
  DEFAULT_CHECK_INTERVAL_MS,
  assertRenewPolicy,
  defaultRenewPolicy,
  needsRenewal,
  renew,
  renewAll,
  type RenewPolicy,
  type TrackedBlob,
} from '../src/storage/renew.js';
import {
  FRESH_BLOB_GRACE_MS,
  PlaintextUploadRefusedError,
  WalrusError,
  blobUrl,
  get,
  isAvailable,
  put,
  putEncrypted,
  resolveEpochs,
  status,
  type BlobStatus,
  type Encryptor,
  type FetchLike,
  type HttpInit,
  type HttpResponseLike,
} from '../src/storage/walrus.js';
import { ConfigError, NotFoundError } from '../src/util/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory Walrus (no sockets — vitest.config.ts forbids network in tests)
// ─────────────────────────────────────────────────────────────────────────────

const PUBLISHER = 'https://publisher.invalid';
const AGGREGATOR = 'https://aggregator.invalid';
const PUBLISHER_B = 'https://publisher-backup.invalid';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body?: Uint8Array;
}

interface MemoryWalrus {
  readonly fetch: FetchLike;
  readonly blobs: Map<string, Uint8Array>;
  readonly requests: Recorded[];
  /** Endpoints that answer 500 to every request, to exercise failover. */
  readonly broken: Set<string>;
  currentEpoch: number;
}

/** Walrus blob ids are content-derived; sha256→base64url reproduces that property exactly. */
function contentId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function response(status: number, body: Uint8Array | string): HttpResponseLike {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => toArrayBuffer(bytes),
  };
}

function memoryWalrus(): MemoryWalrus {
  const store: MemoryWalrus = {
    blobs: new Map<string, Uint8Array>(),
    requests: [],
    broken: new Set<string>(),
    currentEpoch: 469,
    fetch: async (url: string, init?: HttpInit): Promise<HttpResponseLike> => {
      const method = init?.method ?? 'GET';
      store.requests.push({ url, method, ...(init?.body === undefined ? {} : { body: init.body }) });

      for (const base of store.broken) {
        if (url.startsWith(base)) return response(500, 'endpoint down');
      }

      const parsed = new URL(url);
      if (method === 'PUT' && parsed.pathname === '/v1/blobs') {
        const epochs = Number(parsed.searchParams.get('epochs'));
        if (!Number.isInteger(epochs) || epochs < 1) return response(400, 'bad epochs');
        const bytes = init?.body ?? new Uint8Array();
        const blobId = contentId(bytes);
        store.blobs.set(blobId, bytes);
        return response(
          200,
          JSON.stringify({
            newlyCreated: {
              blobObject: {
                id: `0x${'9'.repeat(64)}`,
                registeredEpoch: store.currentEpoch,
                blobId,
                size: bytes.length,
                // ⚠ E-K12: a FRESH blob is uncertified and deletable. That is normal.
                certifiedEpoch: null,
                storage: {
                  startEpoch: store.currentEpoch,
                  endEpoch: store.currentEpoch + epochs,
                },
                deletable: true,
              },
            },
          }),
        );
      }

      const match = /^\/v1\/blobs\/(.+)$/.exec(parsed.pathname);
      if (match !== null) {
        const blobId = decodeURIComponent(match[1] ?? '');
        const bytes = store.blobs.get(blobId);
        if (bytes === undefined) return response(404, 'not found');
        return method === 'HEAD' ? response(200, new Uint8Array()) : response(200, bytes);
      }

      return response(404, 'no route');
    },
  };
  return store;
}

function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    WALRUS_PUBLISHER: PUBLISHER,
    WALRUS_AGGREGATOR: AGGREGATOR,
    ...env,
  });
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Reversible, obviously-not-a-cipher stand-in for `privacy/seal.ts` (T2.6). */
const xorEncryptor: Encryptor = {
  encrypt: async (plaintext: Uint8Array) => plaintext.map((b) => b ^ 0x5a),
};

// ─────────────────────────────────────────────────────────────────────────────

describe('storage/walrus — epochs are EXPLICIT and never 1 (A8, the liveness trap)', () => {
  it('resolves the configured window and refuses anything below 2', () => {
    expect(resolveEpochs(testConfig())).toBe(12);
    expect(resolveEpochs(testConfig({ WALRUS_EPOCHS: '30' }))).toBe(30);
    expect(resolveEpochs(testConfig(), { epochs: 5 })).toBe(5);

    // A 1-epoch blob expires almost immediately and the vault silently stops being verifiable.
    expect(() => resolveEpochs(testConfig(), { epochs: 1 })).toThrow(ConfigError);
    expect(() => resolveEpochs(testConfig(), { epochs: 0 })).toThrow(ConfigError);
    expect(() => resolveEpochs(testConfig(), { epochs: 2.5 })).toThrow(/integer >= 2/);
  });

  it('always sends ?epochs=<resolved> on the PUT — the parameter is never optional', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();

    await put(cfg, utf8('journal segment'), { payload: 'decision-log', fetch: walrus.fetch });

    const puts = walrus.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(`${PUBLISHER}/v1/blobs?epochs=12`);
    // The trap, stated as an assertion: the 1-epoch default must never appear on the wire.
    expect(puts[0]?.url).not.toContain('epochs=1&');
    expect(puts[0]?.url.endsWith('epochs=1')).toBe(false);
  });

  it('honours an explicit override and still refuses 1', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig({ WALRUS_EPOCHS: '40' });

    const result = await put(cfg, utf8('x'), { payload: 'decision-log', fetch: walrus.fetch });
    expect(walrus.requests[0]?.url).toContain('epochs=40');
    expect(result.startEpoch).toBe(469);
    expect(result.endEpoch).toBe(509);

    await expect(
      put(cfg, utf8('x'), { epochs: 1, payload: 'decision-log', fetch: walrus.fetch }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('storage/walrus — put/get round trip (blob ids are content-derived)', () => {
  it('returns the exact bytes, and identical bytes yield an identical id', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const payload = utf8('aphotic-day-one-probe-2026-07-25');

    const first = await put(cfg, payload, { payload: 'decision-log', fetch: walrus.fetch });
    const second = await put(cfg, payload, { payload: 'decision-log', fetch: walrus.fetch });
    expect(second.blobId).toBe(first.blobId);

    const other = await put(cfg, utf8('different'), { payload: 'decision-log', fetch: walrus.fetch });
    expect(other.blobId).not.toBe(first.blobId);

    const readBack = await get(cfg, first.blobId, { fetch: walrus.fetch });
    expect(readBack).toEqual(payload);
    expect(new TextDecoder().decode(readBack)).toBe('aphotic-day-one-probe-2026-07-25');
  });

  it('builds the canonical read URL and surfaces a missing blob as NotFound', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    expect(blobUrl(cfg, 'abc-_')).toBe(`${AGGREGATOR}/v1/blobs/abc-_`);
    await expect(get(cfg, 'nope', { fetch: walrus.fetch })).rejects.toThrow(NotFoundError);
  });

  it('fails over to the next publisher and reports every endpoint when all are down', async () => {
    const walrus = memoryWalrus();
    walrus.broken.add(PUBLISHER);
    const cfg = testConfig();

    const ok = await put(cfg, utf8('failover'), {
      payload: 'decision-log',
      fetch: walrus.fetch,
      endpoints: [PUBLISHER, PUBLISHER_B],
    });
    expect(ok.blobId).toBe(contentId(utf8('failover')));
    expect(walrus.requests.map((r) => r.url)).toEqual([
      `${PUBLISHER}/v1/blobs?epochs=12`,
      `${PUBLISHER_B}/v1/blobs?epochs=12`,
    ]);

    walrus.broken.add(PUBLISHER_B);
    await expect(
      put(cfg, utf8('failover'), {
        payload: 'decision-log',
        fetch: walrus.fetch,
        endpoints: [PUBLISHER, PUBLISHER_B],
      }),
    ).rejects.toThrow(/HTTP 500.*HTTP 500/s);
  });

  it('refuses to run at all when the endpoints are unconfigured', async () => {
    const cfg = loadConfig({});
    expect(cfg.walrus.publisher).toBe('');
    await expect(put(cfg, utf8('x'), { payload: 'decision-log' })).rejects.toThrow(ConfigError);
    expect(() => blobUrl(cfg, 'abc')).toThrow(/WALRUS_AGGREGATOR/);
  });

  it('parses an alreadyCertified response as a committed, non-deletable blob', async () => {
    const cfg = testConfig();
    const canned: FetchLike = async () =>
      response(200, JSON.stringify({ alreadyCertified: { blobId: 'ZZZ', endEpoch: 500 } }));

    const result = await put(cfg, utf8('x'), { payload: 'decision-log', fetch: canned });
    expect(result).toEqual({
      blobId: 'ZZZ',
      endEpoch: 500,
      certifiedEpoch: null,
      deletable: false,
    });
  });

  it('rejects a response that is neither newlyCreated nor alreadyCertified', async () => {
    const cfg = testConfig();
    const canned: FetchLike = async () => response(200, '{"surprise":true}');
    await expect(put(cfg, utf8('x'), { payload: 'decision-log', fetch: canned })).rejects.toThrow(
      WalrusError,
    );
  });
});

describe('storage/walrus — ENCRYPT BEFORE UPLOAD (G8: blobs are public and discoverable)', () => {
  it('refuses plaintext strategy material WITHOUT touching the transport', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const secret = utf8('spread=35bps;skew=0.2;inventoryCap=5e7');

    await expect(put(cfg, secret, { fetch: walrus.fetch })).rejects.toThrow(
      PlaintextUploadRefusedError,
    );

    // The whole point: the store never saw the plaintext, not even once.
    expect(walrus.requests).toHaveLength(0);
    expect(walrus.blobs.size).toBe(0);
  });

  it('putEncrypted uploads the CIPHERTEXT — the transport never receives the plaintext', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const secret = utf8('spread=35bps;skew=0.2;inventoryCap=5e7');

    const result = await putEncrypted(cfg, secret, xorEncryptor, { fetch: walrus.fetch });

    const uploaded = walrus.requests.find((r) => r.method === 'PUT')?.body;
    expect(uploaded).toBeDefined();
    expect(uploaded).not.toEqual(secret);
    expect(uploaded).toEqual(await xorEncryptor.encrypt(secret));
    expect(new TextDecoder().decode(uploaded)).not.toContain('spread');

    // And the stored blob is the ciphertext, byte-for-byte.
    expect(walrus.blobs.get(result.blobId)).toEqual(await xorEncryptor.encrypt(secret));
  });

  it('refuses a pass-through "encryptor" that would publish the strategy verbatim', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const identity: Encryptor = { encrypt: async (b) => b };

    await expect(putEncrypted(cfg, utf8('secret'), identity, { fetch: walrus.fetch })).rejects.toThrow(
      PlaintextUploadRefusedError,
    );
    expect(walrus.requests).toHaveLength(0);
  });

  it('allows a decision-log segment as plaintext — that IS the transparency claim (G8)', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const result = await put(cfg, utf8('{"meta":{}}'), {
      payload: 'decision-log',
      fetch: walrus.fetch,
    });
    expect(walrus.blobs.get(result.blobId)).toEqual(utf8('{"meta":{}}'));
  });
});

describe('storage/walrus — status + the fresh-blob grace window (E-K12 / E-M11)', () => {
  it('reports a fresh write as available, uncertified and deletable', async () => {
    const walrus = memoryWalrus();
    const cfg = testConfig();
    const receipt = await put(cfg, utf8('fresh'), { payload: 'decision-log', fetch: walrus.fetch });

    expect(receipt.certifiedEpoch).toBeNull();
    expect(receipt.deletable).toBe(true);

    const s = await status(cfg, receipt.blobId, { fetch: walrus.fetch, receipt });
    expect(s.available).toBe(true);
    expect(s.certifiedEpoch).toBeNull();
    expect(s.endEpoch).toBe(481);
  });

  it('tolerates certifiedEpoch:null inside the grace window and not after it', () => {
    const fresh: BlobStatus = {
      blobId: 'b',
      certifiedEpoch: null,
      deletable: true,
      endEpoch: 481,
      available: true,
    };
    // A predicate demanding certified + non-deletable would reject OUR OWN write. It must not.
    expect(isAvailable(fresh, 1_000)).toBe(true);
    expect(isAvailable(fresh, FRESH_BLOB_GRACE_MS)).toBe(true);
    expect(isAvailable(fresh, FRESH_BLOB_GRACE_MS + 1)).toBe(false);

    const certified: BlobStatus = { ...fresh, certifiedEpoch: 470, deletable: false };
    expect(isAvailable(certified, FRESH_BLOB_GRACE_MS * 100)).toBe(true);

    expect(isAvailable({ ...certified, available: false }, 0)).toBe(false);
  });

  it('reports an unknown blob as unavailable rather than throwing', async () => {
    const walrus = memoryWalrus();
    const s = await status(testConfig(), 'missing', { fetch: walrus.fetch });
    expect(s.available).toBe(false);
    expect(s.deletable).toBe(true);
    expect(s.certifiedEpoch).toBeNull();
  });
});

describe('storage/renew — the lifetime-renewal task (A8)', () => {
  const cfg = testConfig();

  it('derives a policy with a safety margin and refuses a 1-epoch lifetime', () => {
    const policy = defaultRenewPolicy(cfg);
    expect(policy.epochs).toBe(12);
    expect(policy.renewBeforeEpochs).toBe(3);
    expect(policy.checkIntervalMs).toBe(DEFAULT_CHECK_INTERVAL_MS);

    expect(() => assertRenewPolicy({ ...policy, epochs: 1 })).toThrow(ConfigError);
    expect(() => assertRenewPolicy({ ...policy, renewBeforeEpochs: 0 })).toThrow(ConfigError);
  });

  it('needsRenewal is PURE and never keys off certifiedEpoch', () => {
    const policy: RenewPolicy = { epochs: 12, renewBeforeEpochs: 3, checkIntervalMs: 1 };
    const alive: BlobStatus = {
      blobId: 'b',
      certifiedEpoch: null,
      deletable: true,
      endEpoch: 480,
      available: true,
    };

    expect(needsRenewal(alive, 469, policy)).toBe(false); // 11 epochs of life left
    expect(needsRenewal(alive, 477, policy)).toBe(false); // exactly 3 left — still fine
    expect(needsRenewal(alive, 478, policy)).toBe(true); // 2 left — renew
    expect(needsRenewal({ ...alive, available: false }, 469, policy)).toBe(true);
    expect(needsRenewal({ ...alive, endEpoch: undefined }, 469, policy)).toBe(true);
    // A fresh blob is uncertified; that must NOT by itself trigger a renewal.
    expect(needsRenewal({ ...alive, certifiedEpoch: 470 }, 469, policy)).toBe(false);
  });

  it('renews with the policy window (never 1) and preserves the content-derived blob id', async () => {
    const walrus = memoryWalrus();
    const bytes = utf8('strategy-ciphertext-v1');
    const first = await put(cfg, bytes, { payload: 'decision-log', fetch: walrus.fetch });

    const outcome = await renew(cfg, first.blobId, bytes, defaultRenewPolicy(cfg), {
      fetch: walrus.fetch,
    });

    expect(outcome.renewed).toBe(true);
    expect(outcome.blobId).toBe(first.blobId);
    expect(outcome.result?.blobId).toBe(first.blobId);
    expect(outcome.error).toBeUndefined();

    const renewalPut = walrus.requests.filter((r) => r.method === 'PUT').at(-1);
    expect(renewalPut?.url).toBe(`${PUBLISHER}/v1/blobs?epochs=12`);
  });

  it('reports a blob-id change as a FAILED renewal — the on-chain pointer would be orphaned', async () => {
    const walrus = memoryWalrus();
    const outcome = await renew(cfg, 'the-original-id', utf8('DIFFERENT bytes'), defaultRenewPolicy(cfg), {
      fetch: walrus.fetch,
    });

    expect(outcome.renewed).toBe(false);
    expect(outcome.error).toMatch(/content-derived/);
  });

  it('refuses a 1-epoch renewal outright', async () => {
    const walrus = memoryWalrus();
    await expect(
      renew(cfg, 'id', utf8('x'), { epochs: 1, renewBeforeEpochs: 1, checkIntervalMs: 1 }, {
        fetch: walrus.fetch,
      }),
    ).rejects.toThrow(ConfigError);
    expect(walrus.requests).toHaveLength(0);
  });

  it('renewAll sweeps once per blob, never throws, and surfaces failures as alerts', async () => {
    const walrus = memoryWalrus();
    const policy = defaultRenewPolicy(cfg);

    const healthyBytes = utf8('healthy');
    const healthy = await put(cfg, healthyBytes, { payload: 'decision-log', fetch: walrus.fetch });
    const expiringBytes = utf8('expiring');
    const expiring = await put(cfg, expiringBytes, { payload: 'decision-log', fetch: walrus.fetch });

    const blobs: readonly TrackedBlob[] = [
      { blobId: healthy.blobId, bytes: healthyBytes, label: 'strategy', receipt: healthy },
      {
        blobId: expiring.blobId,
        bytes: expiringBytes,
        label: 'journal-segment',
        // endEpoch 470, currentEpoch 469 ⇒ 1 epoch left, below the margin of 3.
        receipt: { ...expiring, endEpoch: 470 },
      },
      { blobId: 'never-uploaded', bytes: utf8('gone'), label: 'strategy' },
    ];

    const outcomes = await renewAll(cfg, blobs, policy, { currentEpoch: 469, fetch: walrus.fetch });

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toEqual({ blobId: healthy.blobId, renewed: false });
    expect(outcomes[1]?.renewed).toBe(true);
    // The third blob is not in the store: it re-uploads and gets a DIFFERENT id ⇒ reported failure.
    expect(outcomes[2]?.renewed).toBe(false);
    expect(outcomes[2]?.error).toBeTruthy();
  });

  it('renewAll degrades honestly with no live epoch reading: it acts only on unreadability', async () => {
    const walrus = memoryWalrus();
    const policy = defaultRenewPolicy(cfg);
    const bytes = utf8('short-lifetime');
    const receipt = await put(cfg, bytes, { payload: 'decision-log', fetch: walrus.fetch });

    const outcomes = await renewAll(
      cfg,
      [{ blobId: receipt.blobId, bytes, label: 'strategy', receipt: { ...receipt, endEpoch: 470 } }],
      policy,
      { fetch: walrus.fetch },
    );

    expect(outcomes[0]).toEqual({ blobId: receipt.blobId, renewed: false });
  });

  it('renewAll turns a dead endpoint into an alertable outcome instead of a throw', async () => {
    const walrus = memoryWalrus();
    walrus.broken.add(PUBLISHER);
    walrus.broken.add(AGGREGATOR);

    const outcomes = await renewAll(
      cfg,
      [{ blobId: 'anything', bytes: utf8('x'), label: 'strategy' }],
      defaultRenewPolicy(cfg),
      { currentEpoch: 469, fetch: walrus.fetch },
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.renewed).toBe(false);
    expect(outcomes[0]?.error).toMatch(/WalrusPutFailed|HTTP 500/);
  });
});
