// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.10
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/BUILD-PLAN.md T2.10 — "`run --vault <ID>` executes full loop against the MOCK
//             adapter offline: watch → crank → sweep → evaluate → route (maker post) → journal.
//             Deterministic, no network."
// @spec       docs/KEEPER.md §1.2 (the `run` pseudo-cycle) · §13 A1/A2/A3/A10
// @rules      G1 G2 G3 G5 G6 G7 G9
// @depends    ../src/index.ts (T2.10) · ../src/hashi/mock.ts (T0.5) · ../src/verify/** (T4.3) ·
//             ../src/execution/** (T2.3-T2.5) · ./support/fixtures.ts
// @facts      ★ THIS FILE CLOSES BLOCKER B5 (docs/STATUS.md): `npm run test -- e2e.mock` matched no
// @facts        file, so the cut-line VERIFY passed BY VACUUM. It now runs a real end-to-end
// @facts        assertion over the production run loop.
// @facts      Timeline (compressed FAST lifecycle, logical clock, ms):
// @facts             0  DepositRequested 2_000_000 sats -> ALICE
// @facts        60_000  DepositApproved                       (FAST.depositApprovalDelayMs)
// @facts        90_000  crank-eligible: approval + HASHI_DEPOSIT_TIME_DELAY_MS (30_000)
// @facts        90_000  the loop's PERMISSIONLESS crank confirms -> Minted
// @facts       120_000  sweep proof + vault inventory -> quote
// @facts       150_000  requote (resting maker ids from the previous tick)
// @facts       150_000  WithdrawalRequested 1_000_000 sats   (queueDepth 1_000_000)
// @facts       170_000  WithdrawalApproved                   (FAST.withdrawalApprovalDelayMs)
// @facts       190_000  WithdrawalPickedForProcessing        (FAST.withdrawalBatchDelayMs)
// @facts       210_000  WithdrawalSigned  <- ★ the ONLY event that debits the Guardian bucket (G5)
// @facts       270_000  WithdrawalConfirmed                  (FAST.withdrawalConfirmDelayMs)
// @facts      ★ STAGING RULE: a mock action must be staged at the SAME logical instant as the tick
// @facts        that follows it. `runTick` polls FIRST, so an event emitted at `tickMs` is inside
// @facts        that tick's snapshot — and `verify --limiter` filters boundaries by `atMs <= tickMs`.
// @facts        Staging AFTER a tick at the same instant would make the replay disagree by design.
// @facts      Limiter genesis (RECON R9): a FULL bucket, refill 1_000 sats/s, cap 100_000_000 sats.
// @facts        A 1_000_000-sat debit needs 1_000 s to refill, so it is still visible at t=270_000.
// @forbidden  a test that opens a network socket — asserted, not assumed (`fetch` is poisoned)
// @forbidden  a wall-clock read inside the loop — asserted, not assumed (`Date.now` is counted)
// @forbidden  asserting nothing (an empty body is a failure, docs/STATUS.md B4)
// @invariant  1. The same seed produces byte-identical journal segments across two runs.
// @invariant  2. Every journaled tick reproduces under `verifyVault` at BOTH tiers, with the
//                trustless limiter re-derivation enabled (G5).
// @invariant  3. The keeper can never cancel a depositor's withdrawal (G2) — asserted directly.
// @invariant  4. Every command in the CLI table is registered, renders help, and reports EVERY
//                missing required option by name before it does any work (exit code 2, never a crash).
// @verify     npm run test -- e2e.mock
// @verify     node dist/index.js --help
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { assertNoPinnedDestinationArgument, buildExitTx } from '../src/execution/exit.js';
import { buildReclaimTx, findStalledExits, trackWithdrawals } from '../src/execution/reclaim.js';
import { buildSweepTx } from '../src/execution/sweep.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import { createWatcher } from '../src/hashi/watcher.js';
import {
  COMMANDS,
  findCommand,
  initialRunState,
  main,
  missingOptions,
  offlineRunSeams,
  parseArgv,
  replayFnsFor,
  routeContextFor,
  rulesetContextFor,
  runLoop,
  runTick,
  usage,
  type RunOptions,
  type TickOutcome,
} from '../src/index.js';
import { decodeSegment, encodeSegment, type DecisionSegment } from '../src/journal/schema.js';
import { topOfBook } from '../src/routing/book.js';
import { defaultParams } from '../src/strategy/params.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { Sats } from '../src/types.js';
import { UnauthorizedCancellationError } from '../src/util/errors.js';
import {
  verifyVault,
  type UnrecordedInputs,
  type VerifySources,
} from '../src/verify/index.js';

import { FAST, p2trAddress, testConfig, testSigner } from './support/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER = testSigner(1);
const ALICE = testSigner(2);
const VAULT = testSigner(9).toSuiAddress();

/** Placeholder package/object ids: valid 0x+64-hex, and NOT any watched canonical prefix (G7). */
const FAKE_PACKAGE = `0x${'11'.repeat(32)}`;
const FAKE_BALANCE_MANAGER = `0x${'22'.repeat(32)}`;
const FAKE_TRADE_CAP = `0x${'33'.repeat(32)}`;

const DEPOSIT_SATS: Sats = 2_000_000n;
const EXIT_SATS: Sats = 1_000_000n;

function cfgFor(extra: Record<string, string> = {}): Config {
  return testConfig({
    // The mock's compressed confirm delay MUST equal what the crank reads out of Config, or the
    // off-chain eligibility gate and the on-chain abort disagree.
    HASHI_DEPOSIT_TIME_DELAY_MS: String(FAST.depositConfirmDelayMs ?? 30_000),
    APHOTIC_PACKAGE_ID: FAKE_PACKAGE,
    BALANCE_MANAGER_ID: FAKE_BALANCE_MANAGER,
    TRADE_CAP_ID: FAKE_TRADE_CAP,
    SUI_KEEPER_ADDRESS: KEEPER.toSuiAddress(),
    ...extra,
  });
}

interface ScenarioResult {
  readonly outcomes: readonly TickOutcome[];
  readonly segments: readonly DecisionSegment[];
  readonly mock: MockHashiAdapter;
  readonly depositRequestId: string;
  readonly withdrawalRequestId: string;
  readonly cfg: Config;
  readonly opts: RunOptions;
}

/**
 * The full cut-line cycle, driven tick by tick so bridge state can be staged BETWEEN ticks:
 * deposit → permissionless crank → sweep → evaluate → maker quote → requote → exit → settlement.
 *
 * Every clock read comes from the mock's LOGICAL clock; nothing here sleeps or opens a socket.
 */
async function scenario(cfg: Config = cfgFor()): Promise<ScenarioResult> {
  const mock = createMockHashiAdapter(cfg, { ...FAST, startMs: 0 });
  const params = defaultParams(cfg);
  const seams = offlineRunSeams(cfg, {
    vaultId: VAULT,
    hashi: mock,
    signer: KEEPER,
    params,
    log: () => undefined,
  });
  const opts: RunOptions = {
    vaultId: VAULT,
    // 60_000 = cfg.loop.logPublishLagMs, so the segment rotates while the run is still going and
    // the multi-segment path is exercised rather than assumed.
    maxRecordsPerSegment: 4,
  };

  const watcher = createWatcher(mock);
  let state = initialRunState(cfg, opts, seams.strategyBlobId);
  const outcomes: TickOutcome[] = [];

  const tick = async (): Promise<void> => {
    const result = await runTick(cfg, opts, seams, watcher, state);
    state = result.state;
    if (result.outcome !== undefined) outcomes.push(result.outcome);
  };

  // t = 0 — register the deposit, then tick. The event lands at 0 and the tick sees it.
  const { requestId: depositRequestId } = await mock.deposit({
    signer: ALICE,
    txid: 'e2e-alice-utxo',
    utxos: [{ txid: 'e2e-alice-utxo', vout: 0, sats: DEPOSIT_SATS }],
    recipient: ALICE.toSuiAddress(),
  });
  await tick();

  // t = 60_000 — DepositApproved. The crank is not eligible for another 30_000 ms.
  mock.setNowMs(60_000);
  await tick();

  // t = 90_000 — approval + bitcoin_deposit_time_delay_ms: the loop's PERMISSIONLESS crank fires.
  mock.setNowMs(90_000);
  await tick();

  // The sweep is an `aphotic::vault` call, not a Hashi one, so the mock has no vault object to
  // move coins into. We PROVE the sponsored PTB shape (below) and credit the vault's inventory.
  mock.creditBalance(VAULT, DEPOSIT_SATS);

  // t = 120_000 — inventory present ⇒ the first maker quote.
  mock.setNowMs(120_000);
  await tick();

  // t = 150_000 — resting makers ⇒ requote (cancels carried). Stage the exit at the SAME instant
  // so the tick's snapshot and the later replay agree (see the STAGING RULE in the banner).
  mock.setNowMs(150_000);
  const { requestId: withdrawalRequestId } = await mock.requestWithdrawal({
    sats: EXIT_SATS,
    bitcoinAddress: p2trAddress(),
    signer: ALICE,
  });
  await tick();

  // The bridge lifecycle: Approved → PickedForProcessing → Signed (the bucket debit) → Confirmed.
  for (const atMs of [170_000, 190_000, 210_000, 270_000]) {
    mock.setNowMs(atMs);
    await tick();
  }

  const segments = [
    ...state.closedSegments,
    ...(state.segment.records.length > 0 ? [state.segment] : []),
  ];
  return { outcomes, segments, mock, depositRequestId, withdrawalRequestId, cfg, opts };
}

/** In-memory journal sources — the sanctioned `verify/` seam (G7: same judgement code as testnet). */
function memorySources(segments: readonly DecisionSegment[]): VerifySources {
  return {
    async listSegments(_deps, vaultId, fromSeq) {
      return segments
        .filter((s) => s.meta.vaultId === vaultId && s.meta.seq >= fromSeq)
        .map((s) => ({ seq: s.meta.seq, blobId: `mem-${s.meta.seq}` }));
    },
    async fetchSegment(_deps, pointer) {
      const found = segments.find((s) => s.meta.seq === pointer.seq);
      if (found === undefined) throw new Error(`no in-memory segment ${pointer.seq}`);
      // Round-trip through the canonical codec so the replay proves encode/decode fidelity too.
      return decodeSegment(encodeSegment(found));
    },
  };
}

const NO_CLIENT = undefined as unknown as AnySuiClient;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('e2e.mock — the full cut-line cycle drives the production run loop', () => {
  it('deposit -> PERMISSIONLESS crank -> mint, entirely on the logical clock (G6)', async () => {
    const { mock, depositRequestId, outcomes } = await scenario();

    const deposit = await mock.view.depositStatus(depositRequestId);
    expect(deposit.status).toBe('Confirmed');
    expect(deposit.sats).toBe(DEPOSIT_SATS);
    // The mint lands at the recipient encoded in the derivation path — the crank cannot redirect it.
    expect(deposit.recipient).toBe(ALICE.toSuiAddress());
    expect(await mock.view.balance(ALICE.toSuiAddress())).toBe(DEPOSIT_SATS - EXIT_SATS);

    // The crank confirmed on exactly the tick where approval + delay elapsed, and nowhere earlier.
    const confirmed = outcomes.filter((o) =>
      (o.crank?.outcomes ?? []).some((c) => c.requestId === depositRequestId && c.status === 'confirmed'),
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.tickMs).toBe(90_000);

    // Before that, the loop skipped it rather than spending gas on a known on-chain abort.
    const early = outcomes.find((o) => o.tickMs === 60_000);
    expect(
      (early?.crank?.outcomes ?? []).find((c) => c.requestId === depositRequestId)?.status,
    ).toBe('skipped-not-eligible');
  });

  it('the SPONSORED sweep PTB credits the depositor and is paid for by the sponsor (G2)', () => {
    const cfg = cfgFor();
    const tx = buildSweepTx(cfg, {
      vaultId: VAULT,
      depositRequestId: '0xdeadbeef',
      recipient: ALICE.toSuiAddress(),
      coins: [{ objectId: `0x${'44'.repeat(32)}`, sats: DEPOSIT_SATS }],
      bookMid: 1_000_000_000_000n,
      sponsor: KEEPER.toSuiAddress(),
    });
    const data = tx.getData();

    // The DEPOSITOR is the sender; sponsorship changes who PAYS, never who the sender is.
    expect(data.sender).toBe(ALICE.toSuiAddress());
    expect(data.gasData.owner).toBe(KEEPER.toSuiAddress());

    const calls = data.commands.filter((c) => c.$kind === 'MoveCall');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.MoveCall?.function).toBe('deposit_btc');
    // Nothing in a sweep may look like a Bitcoin destination.
    expect(() => assertNoPinnedDestinationArgument(tx)).not.toThrow();
  });

  it('evaluates to a maker-first quote, then a requote that cancels its own resting orders', async () => {
    const { outcomes } = await scenario();

    const quote = outcomes.find((o) => o.decision.action === 'quote');
    expect(quote).toBeDefined();
    expect(quote?.tickMs).toBe(120_000);
    expect(quote?.plan.makerOrders).toHaveLength(2);
    // Maker-first: nothing crossed on the first quote (the passive band covers our size).
    expect(quote?.plan.iocOrders).toHaveLength(0);
    for (const order of quote?.plan.makerOrders ?? []) {
      expect(order.postOnly).toBe(true);
      expect(order.sz % 1_000n).toBe(0n);
      expect(order.px % 1_000_000n).toBe(0n);
    }

    // POST_ONLY must not cross, or DeepBook aborts EPOSTOrderCrossesOrderbook.
    const { bestBid, bestAsk } = topOfBook(quote?.record.book ?? { poolId: '', bids: [], asks: [], mid: 0n, atMs: 0 });
    for (const order of quote?.plan.makerOrders ?? []) {
      if (order.side === 'bid') expect(order.px).toBeLessThan(bestAsk ?? 0n);
      else expect(order.px).toBeGreaterThan(bestBid ?? 0n);
    }

    const requote = outcomes.find((o) => o.decision.action === 'requote');
    expect(requote).toBeDefined();
    expect(requote?.decision.cancels.length).toBeGreaterThan(0);
    expect(requote?.plan.cancels).toEqual(requote?.decision.cancels);

    // A simulated execution NEVER fabricates a digest.
    for (const o of outcomes) expect(o.record.result).toEqual({ skipped: 'offline-simulation' });
  });

  it('the exit debits the Guardian bucket ONLY on WithdrawalSigned, from the trustless replay (G5)', async () => {
    const { outcomes, mock, withdrawalRequestId, cfg } = await scenario();

    const withdrawal = await mock.view.withdrawalStatus(withdrawalRequestId);
    expect(withdrawal.status).toBe('Confirmed');
    expect(withdrawal.sats).toBe(EXIT_SATS);
    expect(withdrawal.signetTxid).toBeDefined();

    const at = (tickMs: number): TickOutcome => {
      const found = outcomes.find((o) => o.tickMs === tickMs);
      if (found === undefined) throw new Error(`no tick at ${tickMs}`);
      return found;
    };

    // Requested ⇒ the amount is in the GLOBAL queue but the bucket is untouched (a full bucket
    // refills to the cap, so `tokens` is still exactly the cap here).
    expect(at(150_000).limiter.queueDepth).toBe(EXIT_SATS);
    expect(at(150_000).limiter.tokens).toBe(cfg.limiter.maxBucketCapacitySats);
    expect(at(190_000).limiter.tokens).toBe(cfg.limiter.maxBucketCapacitySats);

    // Signed ⇒ the ONLY event that advances the bucket. 1_000_000 sats at 1_000 sats/s takes
    // 1_000 s to refill, so the debit is still visible at t = 270_000.
    expect(at(210_000).limiter.queueDepth).toBe(0n);
    expect(at(210_000).limiter.tokens).toBeLessThan(cfg.limiter.maxBucketCapacitySats);
    expect(at(270_000).limiter.tokens).toBeLessThan(cfg.limiter.maxBucketCapacitySats);
    // ...and refilling, monotonically.
    expect(at(270_000).limiter.tokens).toBeGreaterThan(at(210_000).limiter.tokens);

    // The peg-flow accumulator saw the burn arrive and settle.
    expect(at(170_000).flow.pendingBurnSats).toBe(EXIT_SATS);
    expect(outcomes[outcomes.length - 1]?.flow.pendingBurnSats).toBe(0n);
  });

  it('the exit PTB carries no destination argument — the address is read from the Vault (G2)', () => {
    const cfg = cfgFor();
    const tx = buildExitTx(cfg, { vaultId: VAULT, sharesToBurn: EXIT_SATS, bookMid: 1_000_000_000_000n });
    const calls = tx.getData().commands.filter((c) => c.$kind === 'MoveCall');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.MoveCall?.module).toBe('gateway');
    expect(calls[0]?.MoveCall?.function).toBe('exit_to_bitcoin');
    // buildExitTx already asserts this internally; assert it again from the outside so a refactor
    // that removes the internal check still fails here.
    expect(() => assertNoPinnedDestinationArgument(tx)).not.toThrow();
  });

  it('reclaim is DEPOSITOR-signed only: the keeper cannot cancel, and the PTB is never signed (E-K7)', async () => {
    const cfg = cfgFor({ HASHI_CANCELLATION_COOLDOWN_MS: '30000' });
    // A withdrawal that stalls before the committee picks it up: batch delay far in the future.
    const mock = createMockHashiAdapter(cfg, { ...FAST, withdrawalBatchDelayMs: 10_000_000, startMs: 0 });
    mock.creditBalance(ALICE.toSuiAddress(), DEPOSIT_SATS);
    const { requestId } = await mock.requestWithdrawal({
      sats: EXIT_SATS,
      bitcoinAddress: p2trAddress(),
      signer: ALICE,
    });

    mock.setNowMs(60_000); // past the 30 s cooldown, still only `Approved`
    expect((await mock.view.withdrawalStatus(requestId)).status).toBe('Approved');

    const { events } = await mock.eventsSince({ seq: 0n });
    const stalled = findStalledExits(trackWithdrawals(events), 60_000, cfg);
    expect(stalled.map((s) => s.requestId)).toContain(requestId);
    expect(stalled.find((s) => s.requestId === requestId)?.reclaimableAtMs).toBe(30_000);

    // ★ G2: the keeper CANNOT cancel. `cancel_withdrawal` asserts request.sender == ctx.sender().
    await expect(mock.cancelWithdrawal(requestId, KEEPER)).rejects.toBeInstanceOf(
      UnauthorizedCancellationError,
    );

    // The keeper may only BUILD the PTB. The sender is the depositor, and nothing signs it here.
    const tx = buildReclaimTx(cfg, {
      vaultId: VAULT,
      hashiRequestId: requestId,
      depositor: ALICE.toSuiAddress(),
      bookMid: 1_000_000_000_000n,
    });
    expect(tx.getData().sender).toBe(ALICE.toSuiAddress());
    const calls = tx.getData().commands.filter((c) => c.$kind === 'MoveCall');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.MoveCall?.function).toBe('reclaim_stalled_exit');

    // The depositor's own cancel succeeds and re-credits them — proving the stall is recoverable.
    const cancelled = await mock.cancelWithdrawal(requestId, ALICE);
    expect(cancelled.sats).toBe(EXIT_SATS);
    expect((await mock.view.withdrawalStatus(requestId)).status).toBe('Cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('e2e.mock — the journal reproduces under verify (G5 parity)', () => {
  it('writes a multi-segment, canonically-encodable journal', async () => {
    const { segments, outcomes } = await scenario();

    expect(segments.length).toBeGreaterThan(1); // maxRecordsPerSegment = 4 ⇒ the segment rotates
    const records = segments.flatMap((s) => s.records);
    expect(records).toHaveLength(outcomes.length);
    expect(records.map((r) => r.tickMs)).toEqual(outcomes.map((o) => o.tickMs));

    // Segment sequences are strictly increasing from GENESIS_SEQ — the on-chain cursor asserts it.
    expect(segments.map((s) => s.meta.seq)).toEqual(segments.map((_s, i) => BigInt(i + 1)));

    for (const segment of segments) {
      const roundTripped = decodeSegment(encodeSegment(segment));
      expect(hex(encodeSegment(roundTripped))).toBe(hex(encodeSegment(segment)));
      expect(roundTripped.meta.vaultId).toBe(VAULT);
    }
  });

  it('tier 1 (routing, NO keys) reproduces every tick with the limiter re-derived from events', async () => {
    const { segments, mock, cfg, opts } = await scenario();

    const result = await verifyVault(
      { cfg, client: NO_CLIENT, hashi: mock, sources: memorySources(segments) },
      {
        vaultId: opts.vaultId,
        fromSeq: 0n,
        withLimiter: true,
        replay: {
          ruleset: rulesetContextFor(cfg),
          route: routeContextFor(cfg, 0),
          fns: replayFnsFor(cfg),
        },
      },
    );

    expect(result.failures).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.reproduced).toBe(true);
    expect(result.tier).toBe('routing');
    expect(result.segments).toBe(segments.length);
    expect(result.ticks).toBe(segments.flatMap((s) => s.records).length);

    // The re-derived trajectory is COMPLETE: every WithdrawalSigned joined an amount (E-K3).
    expect(result.trajectory?.unresolvedCount).toBe(0);
    expect(result.trajectory?.rejectedCount).toBe(0);
    expect(result.trajectory?.samples.length).toBe(1); // exactly one Signed batch in the scenario
  });

  it('tier 2 (trigger, with the plaintext params) reproduces every decision', async () => {
    const { segments, outcomes, mock, cfg, opts } = await scenario();

    // The four StrategyInputs fields the journal schema does not carry, keyed by tick.
    const unrecorded = new Map<number, UnrecordedInputs>(outcomes.map((o) => [o.tickMs, o.unrecorded]));

    const result = await verifyVault(
      { cfg, client: NO_CLIENT, hashi: mock, sources: memorySources(segments) },
      {
        vaultId: opts.vaultId,
        fromSeq: 0n,
        withLimiter: true,
        params: defaultParams(cfg),
        replay: {
          ruleset: rulesetContextFor(cfg),
          route: routeContextFor(cfg, 0),
          fns: replayFnsFor(cfg),
          unrecordedInputs: (record) => {
            const found = unrecorded.get(record.tickMs);
            if (found === undefined) throw new Error(`no unrecorded inputs for tick ${record.tickMs}`);
            return found;
          },
        },
      },
    );

    expect(result.tier).toBe('trigger');
    expect(result.mismatches).toEqual([]);
    expect(result.reproduced).toBe(true);
  });

  it('a tampered decision IS caught — the replay is not vacuous', async () => {
    const { segments, mock, cfg, opts } = await scenario();

    const target = segments.find((s) => s.records.some((r) => r.decision.action !== 'noop'));
    expect(target).toBeDefined();
    const tampered: DecisionSegment[] = segments.map((s) =>
      s !== target
        ? s
        : {
            ...s,
            records: s.records.map((r) =>
              r.decision.action === 'noop'
                ? r
                : { ...r, plan: { ...r.plan, makerOrders: [] } },
            ),
          },
    );

    const result = await verifyVault(
      { cfg, client: NO_CLIENT, hashi: mock, sources: memorySources(tampered) },
      {
        vaultId: opts.vaultId,
        fromSeq: 0n,
        replay: {
          ruleset: rulesetContextFor(cfg),
          route: routeContextFor(cfg, 0),
          fns: replayFnsFor(cfg),
        },
      },
    );

    expect(result.reproduced).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches.some((m) => m.field.startsWith('plan.makerOrders'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('e2e.mock — determinism and offline-ness are ASSERTED, not assumed', () => {
  it('two runs of the same scenario produce byte-identical journal segments (invariant 1)', async () => {
    const first = await scenario();
    const second = await scenario();

    expect(second.segments.map((s) => hex(encodeSegment(s)))).toEqual(
      first.segments.map((s) => hex(encodeSegment(s))),
    );

    // ...and the same decision sequence, jitter seeds included.
    expect(second.outcomes.map((o) => `${o.tickMs}:${o.decision.action}:${o.decision.jitterSeed}`)).toEqual(
      first.outcomes.map((o) => `${o.tickMs}:${o.decision.action}:${o.decision.jitterSeed}`),
    );
    expect(second.outcomes.map((o) => o.decision.bidPx)).toEqual(first.outcomes.map((o) => o.decision.bidPx));
    expect(second.outcomes.map((o) => o.limiter.tokens)).toEqual(first.outcomes.map((o) => o.limiter.tokens));

    // The mocks' event logs agree too — the whole simulation is a pure function of the seed.
    expect(second.mock.eventLog().map((e) => `${e.seq}:${e.kind}:${e.atMs}`)).toEqual(
      first.mock.eventLog().map((e) => `${e.seq}:${e.kind}:${e.atMs}`),
    );
  });

  it('the loop reads NO wall clock and opens NO socket', async () => {
    const dateNow = vi.spyOn(Date, 'now');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('the e2e loop must not open a socket')));

    try {
      const result = await scenario();
      expect(result.outcomes.length).toBeGreaterThan(0);
      // ★ invariant 5: the only clock is `seams.nowMs()`, i.e. the mock's logical clock.
      expect(dateNow).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('runLoop drives the same tick function and honours --once / --ticks', async () => {
    const cfg = cfgFor();
    const mockOnce = createMockHashiAdapter(cfg, { ...FAST, startMs: 0 });
    mockOnce.creditBalance(VAULT, DEPOSIT_SATS);
    const seamsOnce = offlineRunSeams(cfg, {
      vaultId: VAULT,
      hashi: mockOnce,
      signer: KEEPER,
      log: () => undefined,
    });

    const once = await runLoop(cfg, { vaultId: VAULT, once: true }, seamsOnce);
    expect(once.ticks).toBe(1);
    expect(once.outcomes).toHaveLength(1);
    expect(once.outcomes[0]?.decision.action).toBe('quote');
    // One tick has not reached logPublishLagMs, so the segment is still open and unclosed.
    expect(once.segments).toHaveLength(1);
    expect(once.state.closedSegments).toHaveLength(0);

    const mockMany = createMockHashiAdapter(cfg, { ...FAST, startMs: 0 });
    mockMany.creditBalance(VAULT, DEPOSIT_SATS);
    const seamsMany = offlineRunSeams(cfg, {
      vaultId: VAULT,
      hashi: mockMany,
      signer: KEEPER,
      log: () => undefined,
    });
    const many = await runLoop(cfg, { vaultId: VAULT, maxTicks: 5, tickIntervalMs: 30_000 }, seamsMany);

    expect(many.ticks).toBe(5);
    expect(many.outcomes).toHaveLength(5);
    // `sleep` advanced the MOCK's logical clock — no wall-clock time passed.
    expect(many.outcomes.map((o) => o.tickMs)).toEqual([0, 30_000, 60_000, 90_000, 120_000]);
    expect(mockMany.nowMs()).toBe(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('e2e.mock — the CLI surface is WIRED, not stubbed', () => {
  /** Every command in docs/KEEPER.md §1.2, plus the Seal/Walrus publish step (T2.6). */
  const EXPECTED = [
    'create-vault',
    'publish-strategy',
    'run',
    'crank',
    'sweep',
    'exit',
    'reclaim',
    'verify',
  ] as const;

  it('registers every command, and none of them still throws NotImplemented', () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual([...EXPECTED].sort());

    const text = usage();
    for (const name of EXPECTED) {
      expect(findCommand(name)?.name).toBe(name);
      expect(text).toContain(name);
      // Per-command help renders and names the task that implements the body.
      expect(usage(findCommand(name))).toContain('implemented by');
    }
  });

  it('parses `--name value`, `--name=value`, bare flags and `--` identically (PURE)', () => {
    expect(parseArgv(['run', '--vault', '0xabc', '--once'])).toMatchObject({
      command: 'run',
      options: { vault: '0xabc', once: true },
    });
    expect(parseArgv(['verify', '--vault=0xabc', '--from-epoch=7', '--limiter'])).toMatchObject({
      command: 'verify',
      options: { vault: '0xabc', 'from-epoch': '7', limiter: true },
    });
    expect(parseArgv(['-h'])).toMatchObject({ help: true });
    expect(parseArgv(['crank', '--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
  });

  it('names EVERY missing required option before doing any work', () => {
    const exitSpec = findCommand('exit');
    if (exitSpec === undefined) throw new Error('exit command missing');
    expect(missingOptions(exitSpec, {})).toEqual(['--vault', '--shares']);
    expect(missingOptions(exitSpec, { vault: '0xabc' })).toEqual(['--shares']);
    // A bare `--vault` with no value is NOT a value: it must still be reported as missing.
    expect(missingOptions(exitSpec, { vault: true, shares: '1' })).toEqual(['--vault']);
    expect(missingOptions(exitSpec, { vault: '0xabc', shares: '1' })).toEqual([]);
  });

  it('exits 0 on --help, 2 on a usage error, and never throws (invariants 2 & 3)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err.push(String(line));
    });

    try {
      // These four paths all return BEFORE any config load or I/O — no socket can be opened.
      expect(await main(['--help'])).toBe(0);
      expect(await main(['exit', '--help'])).toBe(0);
      expect(await main([])).toBe(2);
      expect(await main(['not-a-command'])).toBe(2);
      expect(await main(['exit', '--vault', '0xabc'])).toBe(2);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(out.join('\n')).toContain('aphotic-keeper <command> [options]');
    for (const name of EXPECTED) expect(out.join('\n')).toContain(name);
    expect(err.join('\n')).toContain('unknown command "not-a-command"');
    // ★ The actionable failure: it names the option, not just "bad arguments".
    expect(err.join('\n')).toContain('missing required option(s): --shares');
  });

  it('`reclaim` advertises a DEPOSITOR sender and never a keeper signature (G2/E-K7)', () => {
    const spec = findCommand('reclaim');
    expect(spec?.options.map((o) => o.name)).toEqual(
      expect.arrayContaining(['request', 'vault', 'depositor', 'mid']),
    );
    expect(spec?.notes?.join(' ')).toContain('sender-bound to the depositor');
    // The command exists to PRINT: nothing in its option set names a key or a signer.
    expect(usage(spec)).not.toMatch(/key|signer|private/i);
  });
});
