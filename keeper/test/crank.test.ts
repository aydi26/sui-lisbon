// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.3
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.2 · docs/BUILD-PLAN.md T2.3 (idempotent · skips not-yet-eligible ·
//             runs for ALL users)
// @rules      G2 G6 G7 G8
// @depends    ../src/execution/crank.ts · ../src/hashi/mock.ts · ./support/fixtures.ts
// @facts      The mock NEVER auto-confirms a deposit: `confirm_deposit` is an explicit,
// @facts        permissionless crank, and that is the live on-camera demo beat.
// @facts      cfg.hashi.depositTimeDelayMs = 600_000 by default; FAST compresses the mock's
// @facts        lifecycle to 60_000 (approval) + 30_000 (confirm delay) so a whole deposit fits
// @facts        in one test. The COMPRESSED delay is what the mock enforces; the crank reads
// @facts        cfg.hashi.depositTimeDelayMs, so tests that compare the two pass HASHI_DEPOSIT_TIME_DELAY_MS.
// @forbidden  a test that opens a network socket — the whole suite runs offline
// @forbidden  asserting nothing (an empty body is a failure, docs/STATUS.md B4)
// @verify     npm run test -- crank
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  buildConfirmDepositTx,
  confirmableAtMs,
  crank,
  DEPOSIT_EVENT_KINDS,
  foldDepositViews,
  selectCrankable,
  type CrankDeps,
  type CrankOutcome,
} from '../src/execution/crank.js';
import type { HashiAdapter } from '../src/hashi/index.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import type { DepositView } from '../src/hashi/types.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { Millis } from '../src/types.js';
import { NotFoundError, NotReadyError } from '../src/util/errors.js';

import { FAST, testConfig, testSigner } from './support/fixtures.js';

// The mock's compressed confirm delay must equal what the crank reads out of Config, otherwise
// the off-chain gate and the on-chain abort disagree and every assertion below is meaningless.
const CONFIRM_DELAY_MS = FAST.depositConfirmDelayMs ?? 30_000;
const APPROVAL_DELAY_MS = FAST.depositApprovalDelayMs ?? 60_000;

const cfg = testConfig({ HASHI_DEPOSIT_TIME_DELAY_MS: String(CONFIRM_DELAY_MS) });

const KEEPER = testSigner(1);
const ALICE = testSigner(2).toSuiAddress();
const BOB = testSigner(3).toSuiAddress();

/** No PTB is built or executed in these tests — the adapter is the Hashi choke point (G7). */
const NO_CLIENT = undefined as unknown as AnySuiClient;

function deps(hashi: HashiAdapter): CrankDeps {
  return { cfg, hashi, client: NO_CLIENT, signer: KEEPER };
}

function newMock(): MockHashiAdapter {
  return createMockHashiAdapter(cfg, FAST);
}

/** Register a deposit for `recipient` and return its request id. */
async function stageDeposit(mock: MockHashiAdapter, recipient: string, sats = 500_000n): Promise<string> {
  const { requestId } = await mock.deposit({
    signer: KEEPER,
    txid: `tx-${recipient.slice(2, 10)}-${mock.eventLog().length}`,
    utxos: [{ txid: 'utxo', vout: 0, sats }],
    recipient,
  });
  return requestId;
}

function view(overrides: Partial<DepositView>): DepositView {
  return {
    requestId: '0xdead',
    status: 'Approved',
    sats: 500_000n,
    recipient: ALICE,
    ...overrides,
  };
}

function outcomeOf(outcomes: readonly CrankOutcome[], requestId: string): CrankOutcome {
  const found = outcomes.find((o) => o.requestId === requestId);
  if (found === undefined) throw new Error(`no outcome for ${requestId}`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/crank — selectCrankable is PURE (invariant 4)', () => {
  it('accepts an Approved deposit whose delay has elapsed', () => {
    const d = view({ confirmableAtMs: 1_000 });
    expect(selectCrankable([d], 1_000, CONFIRM_DELAY_MS)).toEqual([d]);
    expect(selectCrankable([d], 5_000, CONFIRM_DELAY_MS)).toEqual([d]);
  });

  it('rejects an Approved deposit one millisecond before its delay elapses (invariant 2)', () => {
    const d = view({ confirmableAtMs: 1_000 });
    expect(selectCrankable([d], 999, CONFIRM_DELAY_MS)).toEqual([]);
  });

  it('drops Requested, Confirmed and Expired regardless of the clock', () => {
    const deposits = [
      view({ requestId: '0x1', status: 'Requested', confirmableAtMs: 0 }),
      view({ requestId: '0x2', status: 'Confirmed', confirmableAtMs: 0 }),
      view({ requestId: '0x3', status: 'Expired', confirmableAtMs: 0 }),
    ];
    expect(selectCrankable(deposits, 10_000_000, CONFIRM_DELAY_MS)).toEqual([]);
  });

  it('an Approved deposit with an UNKNOWN approval instant is never eligible', () => {
    // The approval could have happened this instant, so the earliest provable eligibility is
    // now + delay. Assuming otherwise spends gas on a known on-chain abort.
    const d = view({ confirmableAtMs: undefined });
    expect(selectCrankable([d], 10_000_000, CONFIRM_DELAY_MS)).toEqual([]);
    expect(confirmableAtMs(d, 10_000_000, CONFIRM_DELAY_MS)).toBe(10_000_000 + CONFIRM_DELAY_MS);
  });

  it('is a pure function of its arguments — no clock is read', () => {
    const deposits = [view({ confirmableAtMs: 1_000 })];
    const a = selectCrankable(deposits, 1_000, CONFIRM_DELAY_MS);
    const b = selectCrankable(deposits, 1_000, CONFIRM_DELAY_MS);
    expect(a).toEqual(b);
    expect(selectCrankable(deposits, 999, CONFIRM_DELAY_MS)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/crank — foldDepositViews: the WHOLE-BRIDGE candidate set', () => {
  it('folds Requested -> Approved -> Confirmed and derives confirmableAtMs', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS);

    const { events } = await mock.eventsSince({ seq: 0n }, { kinds: [...DEPOSIT_EVENT_KINDS] });
    const [folded] = foldDepositViews(events, CONFIRM_DELAY_MS);

    expect(folded?.requestId).toBe(id);
    expect(folded?.status).toBe('Approved');
    expect(folded?.sats).toBe(500_000n);
    expect(folded?.recipient).toBe(ALICE);
    expect(folded?.confirmableAtMs).toBe(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);
  });

  it('binds the recipient to the derivation path, never to the requester (G2)', async () => {
    const mock = newMock();
    // The KEEPER registers the UTXO; the mint is bound to ALICE through the derivation path.
    await stageDeposit(mock, ALICE);
    const { events } = await mock.eventsSince({ seq: 0n }, { kinds: [...DEPOSIT_EVENT_KINDS] });
    const [folded] = foldDepositViews(events, CONFIRM_DELAY_MS);

    expect(folded?.recipient).toBe(ALICE);
    expect(folded?.recipient).not.toBe(KEEPER.toSuiAddress());
  });

  it('sees deposits belonging to EVERY user, in first-seen order', async () => {
    const mock = newMock();
    const a = await stageDeposit(mock, ALICE);
    const b = await stageDeposit(mock, BOB);
    mock.advanceMs(APPROVAL_DELAY_MS);

    const { events } = await mock.eventsSince({ seq: 0n }, { kinds: [...DEPOSIT_EVENT_KINDS] });
    const folded = foldDepositViews(events, CONFIRM_DELAY_MS);

    expect(folded.map((d) => d.requestId)).toEqual([a, b]);
    expect(folded.map((d) => d.recipient)).toEqual([ALICE, BOB]);
  });

  it('is idempotent — folding the same stream twice gives the same views', async () => {
    const mock = newMock();
    await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS);
    const { events } = await mock.eventsSince({ seq: 0n }, { kinds: [...DEPOSIT_EVENT_KINDS] });

    expect(foldDepositViews(events, CONFIRM_DELAY_MS)).toEqual(foldDepositViews(events, CONFIRM_DELAY_MS));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/crank — buildConfirmDepositTx (E-M9: a PTB command, not a Move call)', () => {
  const REQUEST_ID = '0x'.padEnd(66, 'a');

  it('is ONE command targeting the BRIDGE package, never the aphotic package', () => {
    const tx = buildConfirmDepositTx(cfg, REQUEST_ID);
    const commands = tx.getData().commands;

    expect(commands).toHaveLength(1);
    const call = commands[0]?.MoveCall;
    expect(call?.package).toBe(cfg.hashi.packageId);
    expect(call?.module).toBe('deposit');
    expect(call?.function).toBe('confirm_deposit');
    // E-M9: `confirm_deposit` is `entry`, so it can NEVER be composed from gateway.move.
    expect(call?.package).not.toBe(cfg.aphotic.packageId);
  });

  it('passes exactly (Hashi shared, request_id, Clock) and no type arguments', () => {
    const call = buildConfirmDepositTx(cfg, REQUEST_ID).getData().commands[0]?.MoveCall;
    expect(call?.arguments).toHaveLength(3);
    expect(call?.typeArguments).toEqual([]);
  });

  it('pins the Hashi shared object at its configured initialSharedVersion', () => {
    const inputs = buildConfirmDepositTx(cfg, REQUEST_ID).getData().inputs;
    const shared = inputs.find((i) => i.$kind === 'Object' && i.Object.$kind === 'SharedObject');
    expect(shared?.Object?.SharedObject?.objectId).toBe(cfg.hashi.objectId);
    expect(Number(shared?.Object?.SharedObject?.initialSharedVersion)).toBe(
      cfg.hashi.objectInitialSharedVersion,
    );
    expect(shared?.Object?.SharedObject?.mutable).toBe(true);
  });

  it('carries NO recipient of any kind — the mint lands where the derivation path says (G2)', () => {
    const tx = buildConfirmDepositTx(cfg, REQUEST_ID);
    const call = tx.getData().commands[0]?.MoveCall;
    // Hashi shared object + request_id + Clock. A fourth argument would be a redirect surface.
    expect(call?.arguments).toHaveLength(3);
  });

  it('is deterministic: the same (cfg, requestId) builds byte-identical data', () => {
    const a = buildConfirmDepositTx(cfg, REQUEST_ID);
    const b = buildConfirmDepositTx(cfg, REQUEST_ID);
    expect(JSON.stringify(a.getData())).toBe(JSON.stringify(b.getData()));
  });

  it('leaves the sender unset — the crank is permissionless, whoever signs pays', () => {
    expect(buildConfirmDepositTx(cfg, REQUEST_ID).getData().sender).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/crank — the permissionless crank against the mock', () => {
  it('skips a deposit whose bitcoin_deposit_time_delay_ms has NOT elapsed (invariant 2)', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS); // Approved, but the confirm delay has not run yet.

    const result = await crank(deps(mock), { nowMs: mock.nowMs() });

    expect(result.attempted).toBe(0);
    const outcome = outcomeOf(result.outcomes, id);
    expect(outcome.status).toBe('skipped-not-eligible');
    expect(outcome.eligibleAtMs).toBe(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);
    expect(outcome.digest).toBeUndefined();
    // Nothing was minted.
    expect(await mock.view.balance(ALICE)).toBe(0n);
  });

  it('the mock NEVER auto-confirms — only the crank advances a deposit (the demo beat)', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS + 10_000_000);

    expect((await mock.view.depositStatus(id)).status).toBe('Approved');
    expect(await mock.view.balance(ALICE)).toBe(0n);
  });

  it('confirms an eligible deposit and mints to the derivation-path recipient', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    const result = await crank(deps(mock), { nowMs: mock.nowMs() });

    expect(result.attempted).toBe(1);
    const outcome = outcomeOf(result.outcomes, id);
    expect(outcome.status).toBe('confirmed');
    expect(outcome.digest).toMatch(/^MOCK/);
    expect(await mock.view.balance(ALICE)).toBe(500_000n);
    // The keeper cranked it and received nothing (G2).
    expect(await mock.view.balance(KEEPER.toSuiAddress())).toBe(0n);
  });

  it('IS IDEMPOTENT: re-cranking a Confirmed deposit is a no-op, never an error (invariant 1)', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    await crank(deps(mock), { nowMs: mock.nowMs() });
    const again = await crank(deps(mock), { nowMs: mock.nowMs() });

    expect(again.attempted).toBe(0);
    expect(outcomeOf(again.outcomes, id).status).toBe('skipped-already-confirmed');
    // No double mint.
    expect(await mock.view.balance(ALICE)).toBe(500_000n);
  });

  it('is a PUBLIC GOOD: it cranks OTHER people\'s deposits, not just the vault\'s', async () => {
    const mock = newMock();
    const a = await stageDeposit(mock, ALICE, 400_000n);
    const b = await stageDeposit(mock, BOB, 700_000n);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    const result = await crank(deps(mock), { nowMs: mock.nowMs() });

    expect(result.attempted).toBe(2);
    expect(outcomeOf(result.outcomes, a).status).toBe('confirmed');
    expect(outcomeOf(result.outcomes, b).status).toBe('confirmed');
    expect(await mock.view.balance(ALICE)).toBe(400_000n);
    expect(await mock.view.balance(BOB)).toBe(700_000n);
    expect(await mock.view.balance(KEEPER.toSuiAddress())).toBe(0n);
  });

  it('mixes eligible and not-yet-eligible deposits in one batch without cross-contamination', async () => {
    const mock = newMock();
    const early = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);
    const late = await stageDeposit(mock, BOB);
    mock.advanceMs(APPROVAL_DELAY_MS); // `late` is Approved, still inside its confirm delay.

    const result = await crank(deps(mock), { nowMs: mock.nowMs() });

    expect(outcomeOf(result.outcomes, early).status).toBe('confirmed');
    expect(outcomeOf(result.outcomes, late).status).toBe('skipped-not-eligible');
    expect(result.attempted).toBe(1);
    expect(await mock.view.balance(ALICE)).toBe(500_000n);
    expect(await mock.view.balance(BOB)).toBe(0n);

    // The second pass picks up exactly what the first one left behind — and nothing else.
    mock.advanceMs(CONFIRM_DELAY_MS);
    const second = await crank(deps(mock), { nowMs: mock.nowMs() });
    expect(outcomeOf(second.outcomes, early).status).toBe('skipped-already-confirmed');
    expect(outcomeOf(second.outcomes, late).status).toBe('confirmed');
    expect(second.attempted).toBe(1);
  });

  it('`limit` caps the number of PTBs one invocation submits', async () => {
    const mock = newMock();
    await stageDeposit(mock, ALICE);
    await stageDeposit(mock, BOB);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    const result = await crank(deps(mock), { nowMs: mock.nowMs(), limit: 1 });

    expect(result.attempted).toBe(1);
    expect(result.outcomes.filter((o) => o.status === 'confirmed')).toHaveLength(1);
  });

  it('`requestIds` narrows the batch, and an unknown id fails alone', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    const unknown = '0x'.padEnd(66, 'f');
    const result = await crank(deps(mock), { nowMs: mock.nowMs(), requestIds: [unknown, id] });

    expect(outcomeOf(result.outcomes, unknown).status).toBe('failed');
    expect(outcomeOf(result.outcomes, unknown).reason).toContain('NotFound');
    expect(outcomeOf(result.outcomes, id).status).toBe('confirmed');
    expect(result.attempted).toBe(1);
  });

  it('`all: false` without explicit ids does nothing rather than guessing whose deposits are ours', async () => {
    const mock = newMock();
    await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    const result = await crank(deps(mock), { nowMs: mock.nowMs(), all: false });

    expect(result).toEqual({ attempted: 0, outcomes: [] });
    expect(await mock.view.balance(ALICE)).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/crank — aborts: retry the transient ones, surface the rest', () => {
  /** Wrap an adapter so `confirmDeposit` fails a scripted number of times first. */
  function flaky(inner: MockHashiAdapter, failures: number, error: () => Error): HashiAdapter {
    let seen = 0;
    return {
      ...inner,
      async confirmDeposit(requestId, signer) {
        if (seen++ < failures) throw error();
        return await inner.confirmDeposit(requestId, signer);
      },
    };
  }

  async function eligibleMock(): Promise<{ mock: MockHashiAdapter; id: string }> {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);
    return { mock, id };
  }

  it('retries a transient abort (paused / reconfiguring / committee rotated) with backoff', async () => {
    const { mock, id } = await eligibleMock();
    const slept: Millis[] = [];

    const result = await crank(deps(flaky(mock, 2, () => new Error('MoveAbort: bridge is paused'))), {
      nowMs: mock.nowMs(),
      retryBackoffMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(outcomeOf(result.outcomes, id).status).toBe('confirmed');
    expect(slept).toEqual([100, 200]); // exponential, and the suite never actually waits
    expect(await mock.view.balance(ALICE)).toBe(500_000n);
  });

  it('reports `failed` after maxAttempts and never poisons the rest of the batch (invariant 3)', async () => {
    const mock = newMock();
    const doomed = await stageDeposit(mock, ALICE);
    const healthy = await stageDeposit(mock, BOB);
    mock.advanceMs(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);

    let calls = 0;
    const adapter: HashiAdapter = {
      ...mock,
      async confirmDeposit(requestId, signer) {
        calls++;
        if (requestId === doomed) throw new Error('MoveAbort: committee rotated after approval');
        return await mock.confirmDeposit(requestId, signer);
      },
    };

    const result = await crank(deps(adapter), {
      nowMs: mock.nowMs(),
      maxAttempts: 3,
      sleep: async () => {},
    });

    expect(outcomeOf(result.outcomes, doomed).status).toBe('failed');
    expect(outcomeOf(result.outcomes, doomed).reason).toContain('committee rotated');
    expect(outcomeOf(result.outcomes, healthy).status).toBe('confirmed');
    expect(calls).toBe(4); // 3 doomed attempts + 1 healthy
    expect(await mock.view.balance(BOB)).toBe(500_000n);
  });

  it('a NotReady abort is NOT retried — it reports exactly when the delay elapses', async () => {
    const mock = newMock();
    const id = await stageDeposit(mock, ALICE);
    mock.advanceMs(APPROVAL_DELAY_MS); // Approved; the confirm delay has NOT elapsed on the mock.

    let attempts = 0;
    const adapter: HashiAdapter = {
      ...mock,
      async confirmDeposit(requestId, signer) {
        attempts++;
        return await mock.confirmDeposit(requestId, signer);
      },
    };

    // Lie about the clock so the off-chain gate lets it through — the CHAIN then says no.
    const result = await crank(deps(adapter), {
      nowMs: mock.nowMs() + 10_000_000,
      sleep: async () => {},
    });

    expect(attempts).toBe(1); // not retried
    const outcome = outcomeOf(result.outcomes, id);
    expect(outcome.status).toBe('skipped-not-eligible');
    expect(outcome.eligibleAtMs).toBe(APPROVAL_DELAY_MS + CONFIRM_DELAY_MS);
    expect(await mock.view.balance(ALICE)).toBe(0n);
  });

  it('a NotReadyError carries the readyAt the outcome reports', async () => {
    const err = new NotReadyError('deposit 0x1', 1_234, 1_000);
    expect(err.readyAtMs).toBe(1_234);
    expect(err.code).toBe('NotReady');
    expect(new NotFoundError('deposit 0x1').code).toBe('NotFound');
  });

  it('a permanent NotFound is not retried', async () => {
    const { mock, id } = await eligibleMock();
    let attempts = 0;
    const adapter: HashiAdapter = {
      ...mock,
      async confirmDeposit() {
        attempts++;
        throw new NotFoundError(`deposit ${id}`);
      },
    };

    const result = await crank(deps(adapter), { nowMs: mock.nowMs(), sleep: async () => {} });

    expect(attempts).toBe(1);
    expect(outcomeOf(result.outcomes, id).status).toBe('failed');
  });
});
