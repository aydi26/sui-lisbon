// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.read
// @phase      2
// @status     DONE
// @spec       ../src/batch/read.ts · move/sources/batch.move (the public read surface)
// @rules      G10
// @ac         registry/batch snapshots decode · an illegal state fails · order reads are chunked
// @verify     npm run test -- batchread
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { describe, expect, it } from 'vitest';

import { narrowState, readBatch, readRegistry, readSealedOrders } from '../src/batch/read.js';
import { STATE_SEALED } from '../src/schedule/index.js';

import { addressBcs, boolBcs, fakeClient, id, testConfig, u64, u8 } from './support/chain.js';

const PKG = id('a');
const VAULT = id('b');
const REGISTRY = id('c');
const BATCH = id('d');
const D = { packageId: PKG, vaultId: VAULT, registryId: REGISTRY };

const SEALED_ORDER = bcs.struct('SealedOrder', {
  submitter: bcs.Address,
  commitment: bcs.vector(bcs.u8()),
  ct_hash: bcs.vector(bcs.u8()),
  blob_id: bcs.vector(bcs.u8()),
  submitted_at_ms: bcs.u64(),
});

const sealedOrder = (submitter: string, tag: number): Uint8Array =>
  SEALED_ORDER.serialize({
    submitter,
    commitment: Array.from(new Uint8Array(32).fill(tag)),
    ct_hash: Array.from(new Uint8Array(32).fill(tag + 1)),
    blob_id: Array.from(new Uint8Array(32).fill(tag + 2)),
    submitted_at_ms: 1_000n,
  }).toBytes();

describe('batch/read — the registry cadence is READ, never assumed', () => {
  it('decodes every governed parameter in one simulation', async () => {
    const { client, simulated } = fakeClient({
      simulations: [
        [
          [addressBcs(VAULT)],
          [u64(43_200_000n)],
          [u64(21_600_000n)],
          [u64(7n)],
          [u64(256n)],
          [u64(60_000n)],
          [u64(600_000n)],
          [u64(5n)],
          [u64(0n)],
        ],
      ],
    });
    const state = await readRegistry({ cfg: testConfig(), client }, D);

    expect(simulated).toHaveLength(1);
    expect(state.cadence).toEqual({ cadenceMs: 43_200_000n, offsetMs: 21_600_000n });
    expect(state.policyVersion).toBe(7n);
    expect(state.maxBatchSize).toBe(256n);
    expect(state.liveBatches).toBe(0n);
    expect(state.vaultId).toBe(VAULT);
  });
});

describe('batch/read — the state machine is narrowed, never coerced', () => {
  it('accepts exactly 0..3', () => {
    expect([0, 1, 2, 3].map(narrowState)).toEqual([0, 1, 2, 3]);
  });

  it('refuses to guess what state 9 means', () => {
    expect(() => narrowState(9)).toThrow(/outside 0\.\.3/);
  });
});

describe('batch/read — a batch snapshot fills schedule/BatchSnapshot', () => {
  it('decodes the twelve getters in command order', async () => {
    const { client } = fakeClient({
      simulations: [
        [
          [addressBcs(VAULT)],
          [u64(3n)],
          [u8(STATE_SEALED)],
          [u64(7n)],
          [u64(1_000n)],
          [u64(2_000n)],
          [u64(2_001n)],
          [u64(256n)],
          [u64(60_000n)],
          [u64(600_000n)],
          [u64(2n)],
          [u64(1n)],
        ],
      ],
    });
    const batch = await readBatch({ cfg: testConfig(), client }, D, BATCH);

    expect(batch.batchId).toBe(3n);
    expect(batch.state).toBe(STATE_SEALED);
    expect(batch.closeMs).toBe(2_000n);
    expect(batch.closedAtMs).toBe(2_001n);
    expect(batch.orderCount).toBe(2);
    expect(batch.revealedCount).toBe(1);
    expect(batch.objectId).toBe(BATCH);
  });
});

describe('batch/read — order reads are CHUNKED so a busy batch does not fail on its own size', () => {
  it('splits 5 orders into 3 simulations at chunk 2, index-aligned throughout', async () => {
    const alice = id('1');
    const pair = (tag: number): Uint8Array[][] => [[sealedOrder(alice, tag)], [boolBcs(false)]];
    const { client, simulated } = fakeClient({
      simulations: [
        [...pair(10), ...pair(20)],
        [...pair(30), ...pair(40)],
        [...pair(50)],
      ],
    });

    const rows = await readSealedOrders({ cfg: testConfig(), client }, D, BATCH, 5, 2);

    expect(simulated).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0]?.commitment[0]).toBe(10);
    expect(rows[4]?.commitment[0]).toBe(50);
    expect(rows.every((r) => r.isRevealed === false)).toBe(true);
  });

  it('refuses a short read rather than clearing a partial book', async () => {
    const { client } = fakeClient({ simulations: [[]] });
    await expect(
      readSealedOrders({ cfg: testConfig(), client }, D, BATCH, 2, 2),
    ).rejects.toThrow(/no result for command/);
  });
});
