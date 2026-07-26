// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.open · B8.batch.close · B8.batch.drive
// @phase      2
// @status     DONE
// @spec       ../src/batch/open.ts · ../src/batch/close.ts · ../src/batch/drive.ts
// @spec       move/sources/batch.move · move/sources/clearing.move
// @spec       aphotic.md §9 (liveness is not a privilege) · docs/DESIGN-V2.md §4 §5
// @rules      G5 G10
// @ac         open takes no timestamp · close refuses early · drive is bounded and says so
// @verify     npm run test -- lifecycle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { buildCloseBatchTx, runClose } from '../src/batch/close.js';
import { buildBeginTx, buildStepTx, runDrive, stageName } from '../src/batch/drive.js';
import { buildOpenBatchTx, runOpen } from '../src/batch/open.js';
import { STATE_CLEARING, STATE_OPEN, STATE_SEALED } from '../src/schedule/index.js';

import {
  addressBcs,
  boolBcs,
  commandKinds,
  fakeClient,
  id,
  moveCalls,
  testConfig,
  testSigner,
  u64,
  u8,
  vecU8,
} from './support/chain.js';

const PKG = id('a');
const VAULT = id('b');
const REGISTRY = id('c');
const BATCH = id('d');
const CLEARING = id('e');
const D = { packageId: PKG, vaultId: VAULT, registryId: REGISTRY };
const TYPE_ARGS = ['0x1::b::B', '0x2::q::Q', '0x3::s::S'] as const;

const registryReturns = (live: bigint): Uint8Array[][] => [
  [addressBcs(VAULT)],
  [u64(43_200_000n)],
  [u64(21_600_000n)],
  [u64(1n)],
  [u64(256n)],
  [u64(60_000n)],
  [u64(600_000n)],
  [u64(4n)],
  [u64(live)],
];

const batchReturns = (state: number, closeMs: bigint, closedAtMs = 0n): Uint8Array[][] => [
  [addressBcs(VAULT)],
  [u64(3n)],
  [u8(state)],
  [u64(1n)],
  [u64(0n)],
  [u64(closeMs)],
  [u64(closedAtMs)],
  [u64(256n)],
  [u64(60_000n)],
  [u64(600_000n)],
  [u64(0n)],
  [u64(0n)],
];

const clearingReturns = (stage: number, done: boolean): Uint8Array[][] => [
  [u8(stage)],
  [boolBcs(done)],
  [u64(3n)],
  [u64(0n)],
  [u64(0n)],
  [u64(0n)],
  [vecU8(new Uint8Array(32))],
];

// ── open ─────────────────────────────────────────────────────────────────────

describe('batch/open — the close time is DERIVED, and this command cannot move it', () => {
  it('builds exactly open_batch then share_batch, with no timestamp argument', () => {
    const calls = moveCalls(buildOpenBatchTx(D));
    expect(calls.map((c) => c.target)).toEqual([
      `${PKG}::batch::open_batch`,
      `${PKG}::batch::share_batch`,
    ]);
    // registry + clock. A third pure argument would be an operator-chosen close time.
    expect(calls[0]?.argumentKinds).toHaveLength(2);
    expect(calls[0]?.argumentKinds).not.toContain('Pure');
  });

  it('predicts close_ms from the REGISTRY cadence, not from a constant', async () => {
    const { client } = fakeClient({
      simulations: [registryReturns(0n), []],
      created: { OPENED: [BATCH] },
      objects: [{ objectId: BATCH, type: `${PKG}::batch::Batch` }],
      digest: 'OPENED',
    });
    const report = await runOpen({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      nowMs: 21_600_000 + 1,
    });
    // offset 6 h, cadence 12 h ⇒ the next boundary after 06:00:00.001 is 18:00.
    expect(report.predictedCloseMs).toBe(64_800_000n);
    expect(report.batchObjectId).toBe(BATCH);
  });

  it('refuses locally when a batch is already live, instead of buying EBatchAlreadyLive', async () => {
    const { client, sent } = fakeClient({ simulations: [registryReturns(1n)] });
    await expect(
      runOpen({ cfg: testConfig(), client }, D, { signer: testSigner(), nowMs: 1 }),
    ).rejects.toThrow(/live_batches == 0/);
    expect(sent).toHaveLength(0);
  });
});

// ── close ────────────────────────────────────────────────────────────────────

describe('batch/close — refuses before the boundary and never closes early on fullness', () => {
  it('builds exactly one close_batch command', () => {
    const calls = moveCalls(buildCloseBatchTx(D, BATCH));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(`${PKG}::batch::close_batch`);
  });

  it('refuses ETooEarly locally and names the remaining wait', async () => {
    const { client, sent } = fakeClient({ simulations: [batchReturns(STATE_OPEN, 2_000n)] });
    await expect(
      runClose({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        batchObjectId: BATCH,
        nowMs: 1_500,
      }),
    ).rejects.toThrow(/500 ms early/);
    expect(sent).toHaveLength(0);
  });

  it('sends at EXACTLY close_ms — the boundary is `>=`', async () => {
    const { client, sent } = fakeClient({ simulations: [batchReturns(STATE_OPEN, 2_000n), []] });
    const report = await runClose({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      batchObjectId: BATCH,
      nowMs: 2_000,
    });
    expect(sent).toHaveLength(1);
    expect(report.broadcast).toBe(true);
  });

  it('refuses a batch that is not OPEN, naming the state it actually found', async () => {
    const { client, sent } = fakeClient({ simulations: [batchReturns(STATE_SEALED, 2_000n, 2_001n)] });
    await expect(
      runClose({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        batchObjectId: BATCH,
        nowMs: 9_999,
      }),
    ).rejects.toThrow(/is SEALED, not OPEN/);
    expect(sent).toHaveLength(0);
  });

  it('--force skips the LOCAL refusal only; the simulation still decides', async () => {
    const { client, sent } = fakeClient({ simulations: [batchReturns(STATE_OPEN, 9_000n), []] });
    await runClose({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      batchObjectId: BATCH,
      nowMs: 1,
      force: true,
    });
    expect(sent).toHaveLength(1);
  });
});

// ── drive ────────────────────────────────────────────────────────────────────

describe('batch/drive — one public driver, a bounded loop, and an honest report', () => {
  it('names the seven stages plus DONE', () => {
    expect(stageName(0)).toBe('LOADING');
    expect(stageName(7)).toBe('DONE');
    expect(stageName(99)).toBe('UNKNOWN(99)');
  });

  it('begin is exactly begin + share_clearing, carrying [B,Q,S]', () => {
    const calls = moveCalls(buildBeginTx(D, TYPE_ARGS, BATCH));
    expect(calls.map((c) => c.target)).toEqual([
      `${PKG}::clearing::begin`,
      `${PKG}::clearing::share_clearing`,
    ]);
    expect(calls[0]?.typeArguments).toEqual([...TYPE_ARGS]);
  });

  it('step carries (c, b, r, v, budget) in that order and no capability', () => {
    const tx = buildStepTx(D, TYPE_ARGS, { clearingObjectId: CLEARING, batchObjectId: BATCH }, 64n);
    const calls = moveCalls(tx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(`${PKG}::clearing::step`);
    expect(calls[0]?.argumentKinds).toEqual([
      'UnresolvedObject',
      'UnresolvedObject',
      'UnresolvedObject',
      'UnresolvedObject',
      'Pure',
    ]);
  });

  it('refuses budget 0 — clearing.move asserts budget > 0', () => {
    expect(() =>
      buildStepTx(D, TYPE_ARGS, { clearingObjectId: CLEARING, batchObjectId: BATCH }, 0n),
    ).toThrow(/budget must be > 0/);
  });

  it('steps until DONE and reports the final root', async () => {
    const { client, sent } = fakeClient({
      simulations: [
        clearingReturns(0, false), // initial read
        [], // step 1
        clearingReturns(6, false), // read after step 1
        [], // step 2
        clearingReturns(7, true), // read after step 2 → DONE
      ],
    });
    const report = await runDrive({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      typeArgs: TYPE_ARGS,
      batchObjectId: BATCH,
      clearingObjectId: CLEARING,
    });

    expect(sent).toHaveLength(2);
    expect(report.steps).toBe(2);
    expect(report.final?.isDone).toBe(true);
    expect(report.exhausted).toBe(false);
  });

  it('★ hitting --max-steps is REPORTED, never rounded up to success', async () => {
    const { client } = fakeClient({
      simulations: [
        clearingReturns(0, false),
        [],
        clearingReturns(0, false),
        [],
        clearingReturns(0, false),
      ],
    });
    const report = await runDrive({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      typeArgs: TYPE_ARGS,
      batchObjectId: BATCH,
      clearingObjectId: CLEARING,
      maxSteps: 2,
    });
    expect(report.steps).toBe(2);
    expect(report.exhausted).toBe(true);
    expect(report.final?.isDone).toBe(false);
  });

  it('refuses to `begin` a batch that is not SEALED and points at --clearing', async () => {
    const { client, sent } = fakeClient({ simulations: [batchReturns(STATE_CLEARING, 2_000n)] });
    await expect(
      runDrive({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        typeArgs: TYPE_ARGS,
        batchObjectId: BATCH,
      }),
    ).rejects.toThrow(/pass its shared object id with --clearing/);
    expect(sent).toHaveLength(0);
  });

  it('a reverted step is never broadcast — devInspect-before-send', async () => {
    const { client, sent } = fakeClient({ revert: 'EWrongBatch' });
    await expect(
      runDrive({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        typeArgs: TYPE_ARGS,
        batchObjectId: BATCH,
        clearingObjectId: CLEARING,
      }),
    ).rejects.toThrow(/simulation reverted/);
    expect(sent).toHaveLength(0);
  });

  it('a begin PTB carries no Pure argument at all (no capability, no timestamp)', () => {
    const calls = moveCalls(buildBeginTx(D, TYPE_ARGS, BATCH));
    expect(calls[0]?.argumentKinds).not.toContain('Pure');
  });

  it('the begin transaction is two commands and nothing else', () => {
    expect(commandKinds(buildBeginTx(D, TYPE_ARGS, BATCH))).toEqual(['MoveCall', 'MoveCall']);
  });
});
