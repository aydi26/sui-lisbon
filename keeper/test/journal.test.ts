// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4
// @status     DONE
// @spec       docs/KEEPER.md §8 (DecisionRecord schema, publish on a lag) §13 A9
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.2) · docs/MOVE-PACKAGE.md §9
// @rules      G2 G5 G8 G10
// @depends    ../src/journal/schema.ts · ../src/journal/record.ts · ../src/storage/walrus.ts
// @facts      ⚠ NO NETWORK, NO WALL CLOCK. Walrus is an in-memory transport with content-derived
// @facts        ids; the Sui client is a structural fake; every timestamp is an argument.
// @facts      ⚠ NO canonical on-chain ID literal in this file (G7) — ids come from loadConfig.
// @facts      GENESIS SEQ = 1 (journal.move `assert_monotonic_seq` is strict against last_seq = 0).
// @implements canonical round trip incl. bigints · schema rejects a record missing a hashi field ·
//             bigints are decimal strings, never JSON numbers · one record per tick incl. noop ·
//             publish lag is enforced · the anchor PTB is exactly one journal::record moveCall
// @verify     npm run test -- journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

import type { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import {
  AnchorFailedError,
  PublishTooEarlyError,
  appendRecord,
  blobIdToBytes,
  buildAnchorTx,
  buildRecord,
  bytesToBlobId,
  isPublishDue,
  markAnchored,
  openSegment,
  publishSegment,
  type AnchorObjectRefs,
  type BuildRecordInput,
} from '../src/journal/record.js';
import {
  JOURNAL_SCHEMA_VERSION,
  JournalSchemaError,
  assertReplayable,
  canonicalJson,
  decodeSegment,
  encodeSegment,
  segmentHash,
  type DecisionSegment,
} from '../src/journal/schema.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { DecisionRecord } from '../src/types.js';
import { AphoticError, ConfigError } from '../src/util/errors.js';

import { testSigner } from './support/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PUBLISHER = 'https://publisher.invalid';
const AGGREGATOR = 'https://aggregator.invalid';
const OBJ_A = `0x${'a'.repeat(64)}`;
const OBJ_B = `0x${'b'.repeat(64)}`;
const OBJ_C = `0x${'c'.repeat(64)}`;
const OBJ_D = `0x${'d'.repeat(64)}`;

function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    WALRUS_PUBLISHER: PUBLISHER,
    WALRUS_AGGREGATOR: AGGREGATOR,
    APHOTIC_PACKAGE_ID: OBJ_A,
    VAULT_ID: OBJ_B,
    ...env,
  });
}

const REFS: AnchorObjectRefs = { journalCursorId: OBJ_C, keeperCapId: OBJ_D };

function recordInput(tickMs: number, overrides: Partial<BuildRecordInput> = {}): BuildRecordInput {
  return {
    tickMs,
    oracle: {
      pythPx: 6_412_355_000_000n,
      pythSeq: 42n,
      pythPublishTimeMs: tickMs - 500,
      deepbookTwap: 6_410_000_000_000n,
      deepbookMid: 6_411_000_000_000n,
    },
    book: {
      poolId: OBJ_B,
      bids: [{ px: 6_410_000_000_000n, sz: 200_000n }],
      asks: [{ px: 6_412_000_000_000n, sz: 150_000n }],
      mid: 6_411_000_000_000n,
      atMs: tickMs,
    },
    // ★ G5: the limiter reading is RE-DERIVED from the on-chain event stream, not read from an SDK.
    limiter: { atMs: tickMs, atSecs: BigInt(Math.floor(tickMs / 1000)), tokens: 100_150n, queueDepth: 0n },
    pendingMintSats: 30_000n,
    pendingBurnSats: 0n,
    signedCursorSeq: 17n,
    strategyBlobId: 'GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM',
    ruleset: 'sha256:ruleset-v1',
    decision: {
      action: 'quote',
      bidPx: 6_410_000_000_000n,
      askPx: 6_412_000_000_000n,
      bidSz: 100_000n,
      askSz: 100_000n,
      cancels: [1n, 2n],
      jitterSeed: 'seed-0001',
    },
    plan: {
      makerOrders: [
        { side: 'bid', px: 6_410_000_000_000n, sz: 100_000n, expireTs: tickMs + 15_000, postOnly: true },
      ],
      iocOrders: [{ side: 'ask', px: 6_412_000_000_000n, sz: 50_000n, ioc: true }],
      cancels: [1n, 2n],
    },
    result: { digest: 'DiGeStBaSe58' },
    ...overrides,
  };
}

function sampleSegment(ticks: readonly number[] = [1_000, 2_000, 3_000]): DecisionSegment {
  let segment = openSegment({
    vaultId: OBJ_B,
    seq: 1n,
    strategyBlobId: 'GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM',
    ruleset: 'sha256:ruleset-v1',
  });
  for (const tick of ticks) segment = appendRecord(segment, buildRecord(recordInput(tick)));
  return segment;
}

// ── in-memory Walrus (content-derived ids, no sockets) ───────────────────────

interface MemoryWalrus {
  readonly fetch: (url: string, init?: { method?: string; body?: Uint8Array }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  readonly requests: { url: string; method: string; body?: Uint8Array }[];
  readonly blobs: Map<string, Uint8Array>;
}

function memoryWalrus(): MemoryWalrus {
  const requests: MemoryWalrus['requests'] = [];
  const blobs = new Map<string, Uint8Array>();
  return {
    requests,
    blobs,
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ url, method, ...(init?.body === undefined ? {} : { body: init.body }) });
      const bytes = init?.body ?? new Uint8Array();
      const blobId = createHash('sha256').update(bytes).digest('base64url');
      blobs.set(blobId, bytes);
      const body = new TextEncoder().encode(
        JSON.stringify({
          newlyCreated: {
            blobObject: {
              id: OBJ_A,
              blobId,
              certifiedEpoch: null,
              storage: { startEpoch: 469, endEpoch: 481 },
              deletable: true,
            },
          },
        }),
      );
      return {
        ok: true,
        status: 200,
        text: async () => new TextDecoder().decode(body),
        arrayBuffer: async () => {
          const out = new ArrayBuffer(body.byteLength);
          new Uint8Array(out).set(body);
          return out;
        },
      };
    },
  };
}

/** Structural stand-in for the Sui client. Nothing is constructed; nothing dials out. */
function fakeClient(
  execute: (tx: Transaction) => { $kind: string; Transaction?: { digest: string } },
): AnySuiClient {
  return {
    core: {
      signAndExecuteTransaction: async ({ transaction }: { transaction: Transaction }) =>
        execute(transaction),
    },
  } as unknown as AnySuiClient;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('journal/schema — canonical encoding (invariants 1 & 2)', () => {
  it('round-trips a segment byte-for-byte, bigints included', () => {
    const segment = sampleSegment();
    const decoded = decodeSegment(encodeSegment(segment));

    expect(decoded).toEqual(segment);
    // Bigint identity, not "looks equal": a Number() revive would silently pass a loose check.
    expect(typeof decoded.records[0]?.hashi.limiter.tokens).toBe('bigint');
    expect(decoded.records[0]?.hashi.limiter.tokens).toBe(100_150n);
    expect(decoded.records[0]?.oracle.pythPx).toBe(6_412_355_000_000n);
    expect(decoded.meta.seq).toBe(1n);
    expect(decoded.records[0]?.decision.cancels).toEqual([1n, 2n]);
  });

  it('preserves a u64 that Number() would round off', () => {
    const huge = 18_446_744_073_709_551_615n; // u64::MAX
    const segment = openSegment({ vaultId: OBJ_B, seq: 1n, strategyBlobId: 'blob', ruleset: 'r' });
    const withRecord = appendRecord(
      segment,
      buildRecord(recordInput(1_000, { pendingMintSats: huge, signedCursorSeq: huge })),
    );

    const decoded = decodeSegment(encodeSegment(withRecord));
    expect(decoded.records[0]?.hashi.pendingMintSats).toBe(huge);
    expect(decoded.records[0]?.hashi.signedCursorSeq).toBe(huge);
    // The reason the codec must never touch Number(): the same value round-tripped through a
    // double comes back WRONG, and a replay would report a phantom mismatch.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it('emits every satoshi/u64 field as a DECIMAL STRING, never a JSON number', () => {
    const text = new TextDecoder().decode(encodeSegment(sampleSegment([1_000])));
    expect(text).toContain('"tokens":"100150"');
    expect(text).toContain('"pendingMintSats":"30000"');
    expect(text).toContain('"signedCursorSeq":"17"');
    expect(text).toContain('"seq":"1"');
    // Millisecond timestamps stay numbers — they are Millis, not money.
    expect(text).toContain('"tickMs":1000');
    expect(text).not.toMatch(/"tokens":\d/);
  });

  it('is canonical: key insertion order cannot change the bytes or the hash', () => {
    const a = sampleSegment();
    // Same content, every object literal rebuilt with keys in a different order.
    const b: DecisionSegment = {
      records: a.records.map((r) => ({
        result: r.result,
        plan: r.plan,
        decision: r.decision,
        ruleset: r.ruleset,
        strategyBlobId: r.strategyBlobId,
        hashi: {
          signedCursorSeq: r.hashi.signedCursorSeq,
          pendingBurnSats: r.hashi.pendingBurnSats,
          pendingMintSats: r.hashi.pendingMintSats,
          limiter: r.hashi.limiter,
        },
        book: r.book,
        oracle: r.oracle,
        tickMs: r.tickMs,
      })),
      meta: {
        ruleset: a.meta.ruleset,
        strategyBlobId: a.meta.strategyBlobId,
        toMs: a.meta.toMs,
        fromMs: a.meta.fromMs,
        seq: a.meta.seq,
        vaultId: a.meta.vaultId,
        schemaVersion: a.meta.schemaVersion,
      },
    };

    expect(encodeSegment(b)).toEqual(encodeSegment(a));
    expect(segmentHash(b)).toBe(segmentHash(a));
    expect(segmentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('changes the hash when any recorded input changes (self-certifying pointers)', () => {
    const base = sampleSegment([1_000]);
    const nudged = openSegment(base.meta);
    const withDifferentLimiter = appendRecord(
      nudged,
      buildRecord(recordInput(1_000, { pendingMintSats: 30_001n })),
    );
    expect(segmentHash(withDifferentLimiter)).not.toBe(segmentHash(base));
  });
});

describe('journal/schema — a record without the HASHI block cannot be replayed (T4.2 AC)', () => {
  const good = buildRecord(recordInput(1_000));

  it('accepts a complete record', () => {
    expect(() => assertReplayable(good)).not.toThrow();
  });

  it('rejects a record missing the whole hashi block', () => {
    const { hashi: _dropped, ...rest } = good;
    expect(() => assertReplayable(rest as unknown as DecisionRecord)).toThrow(JournalSchemaError);
    expect(() => assertReplayable(rest as unknown as DecisionRecord)).toThrow(/record\.hashi/);
  });

  it('rejects a record missing ANY single hashi field, naming the field', () => {
    const cases: readonly (keyof DecisionRecord['hashi'])[] = [
      'limiter',
      'pendingMintSats',
      'pendingBurnSats',
      'signedCursorSeq',
    ];
    for (const field of cases) {
      const hashi = { ...good.hashi };
      delete (hashi as Record<string, unknown>)[field];
      const broken = { ...good, hashi } as unknown as DecisionRecord;
      expect(() => assertReplayable(broken)).toThrow(JournalSchemaError);
      expect(() => assertReplayable(broken)).toThrow(new RegExp(`record\\.hashi\\.${field}`));
    }
  });

  it('rejects a limiter sample missing its bucket reading (the G5 trust anchor)', () => {
    const limiter = { ...good.hashi.limiter };
    delete (limiter as Record<string, unknown>)['tokens'];
    const broken = { ...good, hashi: { ...good.hashi, limiter } } as unknown as DecisionRecord;
    expect(() => assertReplayable(broken)).toThrow(/record\.hashi\.limiter\.tokens/);
  });

  it('rejects a record missing the jitter seed — verify/ could not reproduce the decision', () => {
    const decision = { ...good.decision };
    delete (decision as Record<string, unknown>)['jitterSeed'];
    expect(() =>
      assertReplayable({ ...good, decision } as unknown as DecisionRecord),
    ).toThrow(/record\.decision\.jitterSeed/);
  });

  it('rejects sats supplied as `number` instead of bigint (G10)', () => {
    const broken = {
      ...good,
      hashi: { ...good.hashi, pendingMintSats: 30_000 },
    } as unknown as DecisionRecord;
    expect(() => assertReplayable(broken)).toThrow(/expected a bigint/);
  });

  it('rejects a result that records neither a digest nor a skip reason', () => {
    expect(() =>
      assertReplayable({ ...good, result: {} } as unknown as DecisionRecord),
    ).toThrow(/record\.result/);
  });

  it('encodeSegment refuses to publish an unreplayable record', () => {
    const segment = sampleSegment([1_000]);
    const broken: DecisionSegment = {
      ...segment,
      records: [{ ...good, hashi: undefined } as unknown as DecisionRecord],
    };
    expect(() => encodeSegment(broken)).toThrow(/segment\.records\[0\]\.hashi/);
  });
});

describe('journal/schema — decode is strict', () => {
  it('refuses an unknown schema version', () => {
    const text = new TextDecoder().decode(encodeSegment(sampleSegment([1_000])));
    const bumped = text.replace(`"schemaVersion":${JOURNAL_SCHEMA_VERSION}`, '"schemaVersion":2');
    expect(() => decodeSegment(new TextEncoder().encode(bumped))).toThrow(
      /unknown journal schema version 2/,
    );
  });

  it('refuses a u64 that arrived as a JSON number (precision loss)', () => {
    const text = new TextDecoder().decode(encodeSegment(sampleSegment([1_000])));
    const numeric = text.replace('"tokens":"100150"', '"tokens":100150');
    expect(() => decodeSegment(new TextEncoder().encode(numeric))).toThrow(/DECIMAL STRING/);
  });

  it('refuses a seq below the on-chain genesis (cursor starts at 0, assertion is strict)', () => {
    const text = new TextDecoder().decode(encodeSegment(sampleSegment([1_000])));
    const zeroed = text.replace('"seq":"1"', '"seq":"0"');
    expect(() => decodeSegment(new TextEncoder().encode(zeroed))).toThrow(/seq must be >= 1/);
    expect(() =>
      encodeSegment({ ...sampleSegment([1_000]), meta: { ...sampleSegment([1_000]).meta, seq: 0n } }),
    ).toThrow(/segment.meta.seq/);
  });

  it('refuses garbage bytes', () => {
    expect(() => decodeSegment(new TextEncoder().encode('not json'))).toThrow(JournalSchemaError);
  });
});

describe('journal/record — one record per tick, pure segment algebra (A9, invariant 2)', () => {
  it('records EVERY tick, including a noop (a refusal is a decision)', () => {
    let segment = openSegment({ vaultId: OBJ_B, seq: 3n, strategyBlobId: 'blob', ruleset: 'r' });
    segment = appendRecord(segment, buildRecord(recordInput(1_000)));
    segment = appendRecord(
      segment,
      buildRecord(
        recordInput(2_000, {
          decision: {
            action: 'noop',
            bidPx: 0n,
            askPx: 0n,
            bidSz: 0n,
            askSz: 0n,
            cancels: [],
            cause: 'oracle-divergence',
            jitterSeed: 'seed-0002',
          },
          plan: { makerOrders: [], iocOrders: [], cancels: [] },
          result: { skipped: 'oracle-divergence' },
        }),
      ),
    );
    segment = appendRecord(segment, buildRecord(recordInput(3_000)));

    expect(segment.records).toHaveLength(3);
    expect(segment.records[1]?.decision.action).toBe('noop');
    expect(segment.records[1]?.decision.cause).toBe('oracle-divergence');
    expect(segment.records[1]?.result).toEqual({ skipped: 'oracle-divergence' });
    expect(decodeSegment(encodeSegment(segment)).records[1]?.decision.cause).toBe('oracle-divergence');
  });

  it('is pure: appending returns a NEW segment and never mutates the old one', () => {
    const before = sampleSegment([1_000]);
    const after = appendRecord(before, buildRecord(recordInput(2_500)));

    expect(before.records).toHaveLength(1);
    expect(before.meta.toMs).toBe(1_000);
    expect(after.records).toHaveLength(2);
    expect(after.meta.fromMs).toBe(1_000);
    expect(after.meta.toMs).toBe(2_500);
    expect(markAnchored(after, 'DIGEST').anchorDigest).toBe('DIGEST');
    expect(after.anchorDigest).toBeUndefined();
  });

  it('sets fromMs/toMs from the first record of an empty segment', () => {
    const fresh = openSegment({ vaultId: OBJ_B, seq: 1n, strategyBlobId: 'blob', ruleset: 'r' });
    expect(fresh.meta.fromMs).toBe(0);
    const one = appendRecord(fresh, buildRecord(recordInput(5_000)));
    expect(one.meta.fromMs).toBe(5_000);
    expect(one.meta.toMs).toBe(5_000);
  });

  it('refuses an out-of-order tick — the log IS the replay ordering (G5)', () => {
    const segment = sampleSegment([1_000, 2_000]);
    expect(() => appendRecord(segment, buildRecord(recordInput(1_500)))).toThrow(AphoticError);
    expect(() => appendRecord(segment, buildRecord(recordInput(1_500)))).toThrow(/precedes/);
  });

  it('isPublishDue is pure and never fires on an empty segment', () => {
    const empty = openSegment({ vaultId: OBJ_B, seq: 1n, strategyBlobId: 'blob', ruleset: 'r' });
    expect(isPublishDue(empty, 10_000_000, 60_000, 100)).toBe(false);

    const segment = sampleSegment([1_000, 2_000, 3_000]);
    expect(isPublishDue(segment, 3_000 + 59_999, 60_000, 100)).toBe(false);
    expect(isPublishDue(segment, 3_000 + 60_000, 60_000, 100)).toBe(true);
    // Full segments flush regardless of the lag.
    expect(isPublishDue(segment, 3_001, 60_000, 3)).toBe(true);
  });
});

describe('journal/record — blob id ↔ opaque bytes', () => {
  it('round-trips the canonical id string', () => {
    const id = 'GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM';
    const bytes = blobIdToBytes(id);
    expect(bytes).toHaveLength(id.length);
    expect(bytesToBlobId(bytes)).toBe(id);
  });

  it('rejects anything that is not a url-safe base64 blob id', () => {
    expect(() => blobIdToBytes('')).toThrow(/not a Walrus blob id/);
    expect(() => blobIdToBytes('has spaces')).toThrow(/not a Walrus blob id/);
    expect(() => blobIdToBytes('has/slash+plus')).toThrow(/not a Walrus blob id/);
  });
});

describe('journal/record — the anchoring PTB (invariant 3, G2)', () => {
  const cfg = testConfig();
  const blobId = 'GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM';

  it('contains EXACTLY ONE moveCall: <aphotic>::journal::record', () => {
    const data = buildAnchorTx(cfg, blobId, 7n, REFS).getData();

    expect(data.commands).toHaveLength(1);
    const command = data.commands[0];
    expect(command?.$kind).toBe('MoveCall');
    expect(command?.MoveCall?.package).toBe(OBJ_A);
    expect(command?.MoveCall?.module).toBe('journal');
    expect(command?.MoveCall?.function).toBe('record');
    // Vault<B, Q> is generic over the pair — only the TYPE ARGUMENTS name hBTC (G7).
    expect(command?.MoveCall?.typeArguments).toEqual([
      cfg.hashi.hbtcCoinType,
      cfg.deepbook.dbusdcCoinType,
    ]);
    // vault, cursor, keeper_cap, blob_id, seq — and nothing else.
    expect(command?.MoveCall?.arguments).toHaveLength(5);
    expect(data.sender).toBe(cfg.sui.keeperAddress === '' ? null : cfg.sui.keeperAddress);
  });

  it('moves no funds and carries no Bitcoin address (G2)', () => {
    const data = buildAnchorTx(cfg, blobId, 7n, REFS).getData();
    const pureInputs = data.inputs.filter((i) => i.$kind === 'Pure');
    const objectInputs = data.inputs.filter((i) => i.$kind !== 'Pure');

    // Only the blob id and the seq are pure values; the three objects are vault/cursor/keeperCap.
    expect(pureInputs).toHaveLength(2);
    expect(objectInputs).toHaveLength(3);
    expect(JSON.stringify(data)).not.toContain('bitcoin');
  });

  it('refuses to anchor without the ids it needs, or below the genesis seq', () => {
    expect(() => buildAnchorTx(loadConfig({}), blobId, 1n, REFS)).toThrow(ConfigError);
    expect(() => buildAnchorTx(cfg, blobId, 1n, { ...REFS, journalCursorId: '' })).toThrow(
      /JOURNAL_CURSOR_ID/,
    );
    expect(() => buildAnchorTx(cfg, blobId, 1n, { ...REFS, keeperCapId: '' })).toThrow(/KEEPER_CAP_ID/);
    expect(() => buildAnchorTx(cfg, blobId, 0n, REFS)).toThrow(/seq must be >= 1/);
  });
});

describe('journal/record — publishSegment: Walrus put then on-chain anchor', () => {
  const cfg = testConfig();
  const signer = testSigner(1);

  it('uploads the canonical bytes with an explicit epoch window and anchors the blob id', async () => {
    const walrus = memoryWalrus();
    const segment = sampleSegment([1_000, 2_000]);
    let anchored: Transaction | undefined;

    const result = await publishSegment(
      {
        cfg,
        client: fakeClient((tx) => {
          anchored = tx;
          return { $kind: 'Transaction', Transaction: { digest: 'ANCHOR-DIGEST' } };
        }),
        signer,
        refs: REFS,
        fetch: walrus.fetch,
      },
      segment,
    );

    expect(result.seq).toBe(1n);
    expect(result.anchorDigest).toBe('ANCHOR-DIGEST');
    expect(result.blobId).toBe(
      createHash('sha256').update(encodeSegment(segment)).digest('base64url'),
    );

    const puts = walrus.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(`${PUBLISHER}/v1/blobs?epochs=12`);
    // The uploaded bytes ARE the canonical segment — a verifier can re-derive the id from them.
    expect(puts[0]?.body).toEqual(encodeSegment(segment));
    expect(decodeSegment(walrus.blobs.get(result.blobId) ?? new Uint8Array())).toEqual(segment);

    // Exactly one moveCall, and it anchors the id we just wrote.
    const data = anchored?.getData();
    expect(data?.commands).toHaveLength(1);
    expect(data?.commands[0]?.MoveCall?.function).toBe('record');
  });

  it('enforces the anti-front-run publish lag and uploads NOTHING when it has not elapsed', async () => {
    const walrus = memoryWalrus();
    const segment = sampleSegment([1_000, 2_000]);
    const deps = {
      cfg,
      client: fakeClient(() => ({ $kind: 'Transaction', Transaction: { digest: 'D' } })),
      signer,
      refs: REFS,
      fetch: walrus.fetch,
    };

    const lagMs = cfg.loop.logPublishLagMs;
    await expect(publishSegment(deps, segment, 2_000 + lagMs - 1)).rejects.toThrow(
      PublishTooEarlyError,
    );
    expect(walrus.requests).toHaveLength(0);

    const ok = await publishSegment(deps, segment, 2_000 + lagMs);
    expect(ok.anchorDigest).toBe('D');
  });

  it('never drops records: a failed anchor throws and leaves the segment untouched', async () => {
    const walrus = memoryWalrus();
    const segment = sampleSegment([1_000, 2_000]);

    await expect(
      publishSegment(
        {
          cfg,
          client: fakeClient(() => ({ $kind: 'FailedTransaction' })),
          signer,
          refs: REFS,
          fetch: walrus.fetch,
        },
        segment,
      ),
    ).rejects.toThrow(AnchorFailedError);

    await expect(
      publishSegment(
        {
          cfg,
          client: fakeClient(() => {
            throw new Error('rpc exploded');
          }),
          signer,
          refs: REFS,
          fetch: walrus.fetch,
        },
        segment,
      ),
    ).rejects.toThrow(/rpc exploded/);

    // The caller's segment is intact and byte-identical, so the retry re-derives the SAME blob id.
    expect(segment.records).toHaveLength(2);
    expect(segment.anchorDigest).toBeUndefined();
    expect(encodeSegment(segment)).toEqual(encodeSegment(sampleSegment([1_000, 2_000])));
  });
});
