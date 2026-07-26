// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.reveal
// @phase      2
// @status     DONE
// @spec       ../src/batch/order.ts · ../src/batch/reveal.ts · ../src/batch/sealBackend.ts
// @spec       move/sources/batch.move (`order_commitment`, `new_order`, `reveal_order`)
// @spec       docs/DESIGN-V2.md §3 (the commitment binds the PLAINTEXT)
// @rules      G5 G8 G10
// @ac         the commitment is checked LOCALLY · a mismatch is skipped, not submitted ·
//             a bad ct hash never reaches Seal · chunking respects the pure-argument ceiling
// @verify     npm run test -- reveal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { blake2b256 } from '../src/clearing/bytes.js';
import {
  decodeOrder,
  encodeOrder,
  orderCommitment,
  ORDER_BCS_LEN,
  SALT_LEN,
  type PlainOrder,
} from '../src/batch/order.js';
import {
  buildRevealTx,
  MAX_REVEALS_PER_TX,
  REVEAL_PURE_BYTES_PER_ORDER,
  runReveal,
  verifyCiphertext,
  verifyPlaintext,
  walrusBlobId,
} from '../src/batch/reveal.js';
import type { SealBackend, SealDeps } from '../src/privacy/seal.js';
import { STATE_SEALED } from '../src/schedule/index.js';
import type { SealedOrderRow } from '../src/batch/read.js';

import { boolBcs, fakeClient, id, moveCalls, testConfig, testSigner } from './support/chain.js';
import { bcsSealedOrder, chainFixtures } from './support/reveal.fixtures.js';

const ALICE = id('1');
const PKG = id('a');
const VAULT = id('b');
const REGISTRY = id('c');
const BATCH = id('d');
const D = { packageId: PKG, vaultId: VAULT, registryId: REGISTRY };

const order = (over: Partial<PlainOrder> = {}): PlainOrder => ({
  submitter: ALICE,
  isBid: true,
  limitPrice: 100_000_000n,
  qtySats: 50_000n,
  salt: new Uint8Array(SALT_LEN).fill(7),
  ...over,
});

const row = (over: Partial<SealedOrderRow> = {}): SealedOrderRow => {
  const o = order();
  return {
    index: 0,
    submitter: ALICE,
    commitment: orderCommitment(o),
    ctHash: blake2b256(Uint8Array.of(9, 9, 9)),
    blobId: new Uint8Array(32).fill(3),
    submittedAtMs: 1n,
    isRevealed: false,
    ...over,
  };
};

describe('batch/order — the commitment binds the PLAINTEXT', () => {
  it('encodes a constant 82 bytes: 32 addr + 1 bool + 8 + 8 + 1 ULEB + 32 salt', () => {
    expect(encodeOrder(order())).toHaveLength(ORDER_BCS_LEN);
    expect(encodeOrder(order({ isBid: false, qtySats: 1n }))).toHaveLength(ORDER_BCS_LEN);
  });

  it('round trips, field for field', () => {
    const o = order({ isBid: false, limitPrice: 3n, qtySats: 9n });
    expect(decodeOrder(encodeOrder(o))).toEqual(o);
  });

  it('is little-endian, checked against a hand-built pre-image', () => {
    const bytes = encodeOrder(order({ limitPrice: 1n, qtySats: 258n }));
    // u64 1 at offset 33 (32 address + 1 bool)
    expect(Array.from(bytes.slice(33, 41))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    // u64 258 = 0x0102 at offset 41
    expect(Array.from(bytes.slice(41, 49))).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a salt that is not exactly 32 bytes — new_order aborts EBadOrder', () => {
    expect(() => encodeOrder(order({ salt: new Uint8Array(31) }))).toThrow(/exactly 32 bytes/);
  });

  it('refuses a zero quantity or a zero price', () => {
    expect(() => encodeOrder(order({ qtySats: 0n }))).toThrow(/qty_sats must be > 0/);
    expect(() => encodeOrder(order({ limitPrice: 0n }))).toThrow(/limit_price must be > 0/);
  });

  it('refuses a frame of the wrong length rather than truncating it', () => {
    const padded = new Uint8Array(ORDER_BCS_LEN + 4);
    padded.set(encodeOrder(order()));
    expect(() => decodeOrder(padded)).toThrow(/expected exactly 82/);
  });
});

describe('batch/reveal — every check runs LOCALLY, before a byte of gas', () => {
  it('accepts a plaintext whose commitment matches', () => {
    const outcome = verifyPlaintext(row(), encodeOrder(order()));
    expect(outcome.ok).toBe(true);
  });

  it('★ rejects a commitment mismatch and never mentions a price or a size', () => {
    const substituted = encodeOrder(order({ qtySats: 999_999n }));
    const outcome = verifyPlaintext(row(), substituted);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/ECommitmentMismatch/);
      expect(outcome.reason).not.toMatch(/999999|999_999/);
    }
  });

  it('rejects a submitter mismatch — reveal_order asserts it too', () => {
    const other = order({ submitter: id('2') });
    const outcome = verifyPlaintext(row({ commitment: orderCommitment(other) }), encodeOrder(other));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/ESubmitterMismatch/);
  });

  it('a substituted BLOB fails at ct_hash, before Seal is ever asked', () => {
    const ct = Uint8Array.of(9, 9, 9);
    expect(() => verifyCiphertext(row({ ctHash: blake2b256(ct) }), ct)).not.toThrow();
    expect(() => verifyCiphertext(row(), Uint8Array.of(1, 2, 3))).toThrow(/not the one that was committed/);
  });
});

describe('batch/reveal — the pure-argument ceiling is derived, not guessed', () => {
  it('182 = floor(16384 / 90)', () => {
    expect(REVEAL_PURE_BYTES_PER_ORDER).toBe(90);
    expect(MAX_REVEALS_PER_TX).toBe(182);
  });

  it('refuses to build a PTB above the ceiling', () => {
    const entries = Array.from({ length: MAX_REVEALS_PER_TX + 1 }, (_, i) => ({
      index: i,
      order: order(),
    }));
    expect(() => buildRevealTx(D, BATCH, entries)).toThrow(/exceeds MAX_REVEALS_PER_TX/);
  });

  it('builds N × (new_order → reveal_order) with no capability argument', () => {
    const calls = moveCalls(
      buildRevealTx(D, BATCH, [
        { index: 0, order: order() },
        { index: 4, order: order({ isBid: false }) },
      ]),
    );
    expect(calls.map((c) => c.target)).toEqual([
      `${PKG}::batch::new_order`,
      `${PKG}::batch::reveal_order`,
      `${PKG}::batch::new_order`,
      `${PKG}::batch::reveal_order`,
    ]);
    // new_order: five pure arguments and nothing else.
    expect(calls[0]?.argumentKinds).toEqual(['Pure', 'Pure', 'Pure', 'Pure', 'Pure']);
    // reveal_order: batch, index, the Order RESULT of new_order, and the shared Clock (which the
    // builder specifies fully, hence `Object` rather than `UnresolvedObject`).
    expect(calls[1]?.argumentKinds).toEqual(['UnresolvedObject', 'Pure', 'Result', 'Object']);
  });
});

describe('batch/reveal — walrus blob ids', () => {
  it('renders 32 raw bytes as unpadded base64url', () => {
    expect(walrusBlobId(new Uint8Array(32))).toBe('A'.repeat(43));
    expect(walrusBlobId(new Uint8Array(32).fill(255))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('treats a non-32-byte value as an already-encoded ascii id', () => {
    expect(walrusBlobId(new TextEncoder().encode('abc123'))).toBe('abc123');
  });
});

describe('batch/reveal — the end-to-end crank, offline', () => {
  const good = order();
  const goodCt = Uint8Array.of(1, 1, 1, 1);
  const badCt = Uint8Array.of(2, 2, 2, 2);

  /** A deterministic Seal stand-in: it returns whatever the ciphertext maps to. */
  const backend = (plain: Map<string, Uint8Array>): SealBackend => ({
    encrypt: () => Promise.reject(new Error('not used')),
    decrypt: (req) => {
      const key = Array.from(req.ciphertext).join(',');
      const out = plain.get(key);
      if (out === undefined) return Promise.reject(new Error('no share'));
      return Promise.resolve(out);
    },
    createSessionKey: () => Promise.resolve({}),
  });

  it('★ submits the good order, SKIPS the mismatched one, and reports both', async () => {
    const cfg = testConfig({ APHOTIC_PACKAGE_ID: PKG, SEAL_KEY_SERVERS: id('9') });
    const rows = [
      row({ index: 0, ctHash: blake2b256(goodCt), blobId: new Uint8Array(32).fill(1) }),
      row({ index: 1, ctHash: blake2b256(badCt), blobId: new Uint8Array(32).fill(2) }),
    ];
    const { client, sent } = fakeClient({
      simulations: [
        chainFixtures.batch(STATE_SEALED),
        rows.flatMap((r) => [[bcsSealedOrder(r)], [boolBcs(r.isRevealed)]]),
        [],
      ],
    });

    const seal: SealDeps = {
      cfg,
      client,
      backend: backend(
        new Map([
          [Array.from(goodCt).join(','), encodeOrder(good)],
          // the same submitter, a DIFFERENT order ⇒ the commitment will not match
          [Array.from(badCt).join(','), encodeOrder(order({ qtySats: 12_345n }))],
        ]),
      ),
    };

    const report = await runReveal({ cfg, client, seal, readBlob: (_c, blobId) =>
      Promise.resolve(blobId === walrusBlobId(new Uint8Array(32).fill(1)) ? goodCt : badCt),
    }, D, {
      signer: testSigner(),
      batchObjectId: BATCH,
      session: { policyVersion: 1, createdAtMs: 0, expiresAtMs: 1_000_000, key: {} },
      nowMs: 2_100,
    });

    expect(report.accepted).toEqual([0]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.index).toBe(1);
    expect(sent).toHaveLength(1);
    // Only the accepted index made it into the PTB.
    expect(moveCalls(sent[0] as never)).toHaveLength(2);
  });

  it('refuses once the reveal grace has expired instead of buying ERevealWindowClosed', async () => {
    const cfg = testConfig({ APHOTIC_PACKAGE_ID: PKG, SEAL_KEY_SERVERS: id('9') });
    const { client, sent } = fakeClient({ simulations: [chainFixtures.batch(STATE_SEALED)] });
    await expect(
      runReveal({ cfg, client, seal: { cfg, client, backend: backend(new Map()) } }, D, {
        signer: testSigner(),
        batchObjectId: BATCH,
        session: { policyVersion: 1, createdAtMs: 0, expiresAtMs: 10_000_000, key: {} },
        nowMs: 9_000_000,
      }),
    ).rejects.toThrow(/ERevealWindowClosed/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a session minted under a STALE policy version, locally', async () => {
    const cfg = testConfig({ APHOTIC_PACKAGE_ID: PKG, SEAL_KEY_SERVERS: id('9') });
    const { client, sent } = fakeClient({ simulations: [chainFixtures.batch(STATE_SEALED)] });
    await expect(
      runReveal({ cfg, client, seal: { cfg, client, backend: backend(new Map()) } }, D, {
        signer: testSigner(),
        batchObjectId: BATCH,
        session: { policyVersion: 0, createdAtMs: 0, expiresAtMs: 10_000_000, key: {} },
        nowMs: 2_100,
      }),
    ).rejects.toThrow(/policy version 0/);
    expect(sent).toHaveLength(0);
  });
});
