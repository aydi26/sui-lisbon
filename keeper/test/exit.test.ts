// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.4 §5.5 + ERRATA E-K7 · docs/BUILD-PLAN.md T2.5
// @spec       docs/KEEPER.md §13 A6 (no keeper-chosen destination exists anywhere)
// @rules      G1 G2 G3 G6 G7
// @depends    ../src/execution/exit.ts · ../src/execution/reclaim.ts · ../src/hashi/mock.ts
// @facts      ★ This suite covers BOTH halves of T2.5: the exit PTB (exit.ts) and the UNSIGNED
// @facts        reclaim builder (reclaim.ts). One task, one suite — a `--reclaim` filter would
// @facts        match no file and pass by vacuum (docs/STATUS.md B5).
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000. Below it, Move POOLS per-user and emits
// @facts        ExitPooled; no bridge request exists (G3 — sub-minimum is REJECTED, not queued).
// @facts      The gateway is simulated by a fake execution core that mirrors move/sources/gateway.move:
// @facts        it emits the same receipts and, above the minimum, drives the MOCK adapter with the
// @facts        vault's PINNED destination — which is precisely the destination the keeper never has.
// @forbidden  a test that opens a network socket
// @forbidden  asserting nothing (an empty body is a failure)
// @verify     npm run test -- exit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import {
  assertNoPinnedDestinationArgument,
  buildExitTx,
  decodeExitReceipt,
  exit,
  ExitPooledEvent,
  ExitRequestedEvent,
  signetTxidOf,
  trackExit,
  type ExitDeps,
  type ExitEvent,
  type ExitRequest,
} from '../src/execution/exit.js';
import * as reclaimModule from '../src/execution/reclaim.js';
import {
  buildReclaimTx,
  findStalledExits,
  isReclaimable,
  trackWithdrawals,
  type TrackedWithdrawal,
} from '../src/execution/reclaim.js';
import { createMockHashiAdapter, type MockHashiAdapter } from '../src/hashi/mock.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { Sats, SuiAddress } from '../src/types.js';
import { AphoticError, ConfigError } from '../src/util/errors.js';

import { FAST, p2trAddress, p2wpkhAddress, testConfig, testSigner } from './support/fixtures.js';

const APHOTIC_PACKAGE = `0x${'11'.repeat(32)}`;
const VAULT_ID = `0x${'22'.repeat(32)}`;

const cfg = testConfig({ APHOTIC_PACKAGE_ID: APHOTIC_PACKAGE, VAULT_ID });
const bare = testConfig(); // APHOTIC_PACKAGE_ID unset

const DEPOSITOR = testSigner(4);
const ALICE = DEPOSITOR.toSuiAddress();
const KEEPER = testSigner(1);

const BOOK_MID = 100_000_000_000n;
/** The destination the depositor PINNED on-chain at registration. The keeper never sees it. */
const PINNED = p2trAddress(0x7c);

const MIN_SATS = cfg.hashi.withdrawalMinimumSats; // 30_000

function request(overrides: Partial<ExitRequest> = {}): ExitRequest {
  return { vaultId: VAULT_ID, sharesToBurn: 100_000n, bookMid: BOOK_MID, ...overrides };
}

function exitRequestedEvent(who: SuiAddress, sats: Sats): ExitEvent {
  return {
    eventType: `${APHOTIC_PACKAGE}::gateway::ExitRequested`,
    bcs: ExitRequestedEvent.serialize({
      vault_id: VAULT_ID,
      who,
      amount_sats: sats,
      addr_len: 32n,
    }).toBytes(),
  };
}

function exitPooledEvent(who: SuiAddress, sats: Sats, pooledTotal: Sats): ExitEvent {
  return {
    eventType: `${APHOTIC_PACKAGE}::gateway::ExitPooled`,
    bcs: ExitPooledEvent.serialize({
      vault_id: VAULT_ID,
      who,
      amount_sats: sats,
      pooled_total_sats: pooledTotal,
    }).toBytes(),
  };
}

/**
 * A fake `client.core` that simulates `gateway::exit_to_bitcoin`.
 *
 * Above the bridge minimum it forwards to the MOCK adapter using the vault's PINNED destination —
 * exactly what Move does — so the request id the test asserts on is a real one produced by the
 * bridge simulation, not a string we made up.
 */
function gatewayClient(
  mock: MockHashiAdapter,
  opts: { sats: Sats; who?: SuiAddress; failed?: boolean; events?: readonly ExitEvent[] },
): { client: AnySuiClient; built: Transaction[] } {
  const built: Transaction[] = [];
  const who = opts.who ?? ALICE;

  const core = {
    async signAndExecuteTransaction(input: {
      transaction: Transaction;
      signer: Signer;
      include: { events: true };
    }) {
      built.push(input.transaction);
      if (opts.failed === true) {
        return { $kind: 'FailedTransaction' as const, FailedTransaction: { digest: 'FAILED', events: [] } };
      }

      const events: ExitEvent[] = [...(opts.events ?? [])];
      if (opts.events === undefined) {
        if (opts.sats < MIN_SATS) {
          // G3: below the minimum Move POOLS and submits NOTHING.
          events.push(exitPooledEvent(who, opts.sats, opts.sats));
        } else {
          events.push(exitRequestedEvent(who, opts.sats));
          // Move — not the keeper — hands the bridge the PINNED destination.
          await mock.requestWithdrawal({
            sats: opts.sats,
            bitcoinAddress: PINNED,
            signer: input.signer,
          });
        }
      }
      return { $kind: 'Transaction' as const, Transaction: { digest: 'EXITDIGEST', events } };
    },
  };

  return { client: { core } as unknown as AnySuiClient, built };
}

function deps(mock: MockHashiAdapter, client: AnySuiClient, signer: Signer = DEPOSITOR): ExitDeps {
  return { cfg, client, hashi: mock, signer };
}

function newMock(): MockHashiAdapter {
  const mock = createMockHashiAdapter(cfg, FAST);
  mock.creditBalance(ALICE, 10_000_000n);
  return mock;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/exit — buildExitTx: ONE call, and NO destination anywhere (G2)', () => {
  it('is exactly one moveCall: <aphotic>::gateway::exit_to_bitcoin (invariant 1)', () => {
    const commands = buildExitTx(cfg, request()).getData().commands;

    expect(commands).toHaveLength(1);
    const call = commands[0]?.MoveCall;
    expect(call?.package).toBe(APHOTIC_PACKAGE);
    expect(call?.module).toBe('gateway');
    expect(call?.function).toBe('exit_to_bitcoin');
  });

  it('carries ONE type argument (Q) — the base asset is pinned to the bridge coin in Move', () => {
    const call = buildExitTx(cfg, request()).getData().commands[0]?.MoveCall;
    expect(call?.typeArguments).toEqual([cfg.deepbook.dbusdcCoinType]);
  });

  it('passes exactly [vault, hashi, shares, book_mid, clock] — five arguments, no destination', () => {
    const call = buildExitTx(cfg, request()).getData().commands[0]?.MoveCall;
    expect(call?.arguments).toHaveLength(5);
  });

  it('★ NO argument of the PTB is a Bitcoin witness program (invariant 2)', () => {
    const inputs = buildExitTx(cfg, request()).getData().inputs;

    for (const input of inputs) {
      if (input.$kind !== 'Pure') continue;
      const bytes = Buffer.from(input.Pure.bytes, 'base64');
      // A 20/32-byte vector<u8> would be 21/33 bytes with a matching ULEB length prefix.
      expect(bytes.length === 21 && bytes[0] === 20).toBe(false);
      expect(bytes.length === 33 && bytes[0] === 32).toBe(false);
    }
    // And the pinned destination bytes appear nowhere in the transaction data at all.
    const json = JSON.stringify(buildExitTx(cfg, request()).getData());
    expect(json).not.toContain(Buffer.from(PINNED).toString('base64'));
  });

  it('the G2 check HAS TEETH: a rogue PTB carrying a 32-byte program is rejected', () => {
    const rogue = new Transaction();
    rogue.moveCall({
      target: `${APHOTIC_PACKAGE}::gateway::exit_to_bitcoin`,
      arguments: [rogue.pure.vector('u8', Array.from(p2trAddress(0x01)))],
    });
    expect(() => assertNoPinnedDestinationArgument(rogue)).toThrow(AphoticError);
    expect(() => assertNoPinnedDestinationArgument(rogue)).toThrow(/READ FROM THE VAULT/);
  });

  it('the G2 check also rejects a 20-byte P2WPKH program', () => {
    const rogue = new Transaction();
    rogue.moveCall({
      target: `${APHOTIC_PACKAGE}::gateway::exit_to_bitcoin`,
      arguments: [rogue.pure.vector('u8', Array.from(p2wpkhAddress(0x02)))],
    });
    expect(() => assertNoPinnedDestinationArgument(rogue)).toThrow(/READ FROM THE VAULT/);
  });

  it('pins the bridge shared object at its configured initialSharedVersion, mutable', () => {
    const inputs = buildExitTx(cfg, request()).getData().inputs;
    const shared = inputs.filter((i) => i.$kind === 'Object' && i.Object.$kind === 'SharedObject');
    const bridge = shared.find((i) => i.Object?.SharedObject?.objectId === cfg.hashi.objectId);
    expect(bridge).toBeDefined();
    expect(Number(bridge?.Object?.SharedObject?.initialSharedVersion)).toBe(
      cfg.hashi.objectInitialSharedVersion,
    );
    expect(bridge?.Object?.SharedObject?.mutable).toBe(true);
  });

  it('refuses a zero-share exit and refuses to build without APHOTIC_PACKAGE_ID', () => {
    expect(() => buildExitTx(cfg, request({ sharesToBurn: 0n }))).toThrow(/ZeroExit|must be > 0/);
    expect(() => buildExitTx(bare, request())).toThrow(ConfigError);
  });

  it('is deterministic: the same request builds byte-identical data', () => {
    expect(JSON.stringify(buildExitTx(cfg, request()).getData())).toBe(
      JSON.stringify(buildExitTx(cfg, request()).getData()),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/exit — decodeExitReceipt', () => {
  it('reads a submitted exit out of gateway::ExitRequested', () => {
    expect(decodeExitReceipt([exitRequestedEvent(ALICE, 50_000n)], ALICE)).toEqual({
      pooled: false,
      sats: 50_000n,
    });
  });

  it('reads a pooled exit out of gateway::ExitPooled', () => {
    expect(decodeExitReceipt([exitPooledEvent(ALICE, 10_000n, 25_000n)], ALICE)).toEqual({
      pooled: true,
      sats: 10_000n,
    });
  });

  it('ignores a receipt belonging to another depositor', () => {
    const bob = testSigner(5).toSuiAddress();
    expect(decodeExitReceipt([exitRequestedEvent(bob, 50_000n)], ALICE)).toBeUndefined();
  });

  it('ignores foreign events', () => {
    expect(decodeExitReceipt([{ eventType: '0xa::x::Y', bcs: new Uint8Array([0]) }], ALICE)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/exit — the composed exit against the bridge mock', () => {
  it('an exit BELOW 30_000 sats POOLS: no bridge request, and that is a success (invariant 3)', async () => {
    const mock = newMock();
    const { client } = gatewayClient(mock, { sats: 12_000n });

    const result = await exit(deps(mock, client), request({ sharesToBurn: 12_000n }));

    expect(result.pooled).toBe(true);
    expect(result.sats).toBe(12_000n);
    expect(result.requestId).toBeUndefined();
    // G3: the bridge REJECTS sub-minimum amounts, so nothing was ever submitted to it.
    expect(mock.eventLog().filter((e) => e.kind === 'WithdrawalRequested')).toHaveLength(0);
  });

  it('an exit AT or ABOVE the minimum submits, and the destination is the vault\'s PINNED one', async () => {
    const mock = newMock();
    const { client } = gatewayClient(mock, { sats: MIN_SATS });

    const result = await exit(deps(mock, client), request({ sharesToBurn: 30_000n }));

    expect(result.pooled).toBe(false);
    expect(result.sats).toBe(MIN_SATS);
    expect(result.requestId).toBeDefined();
    expect(result.digest).toBe('EXITDIGEST');

    // The bridge received the PINNED program — supplied by Move, never by this keeper.
    const submitted = await mock.view.withdrawalStatus(result.requestId as string);
    expect(submitted.sats).toBe(MIN_SATS);
    expect([...submitted.bitcoinAddress]).toEqual([...PINNED]);
  });

  it('joins the request id from the bridge stream, scoped to events AFTER this exit', async () => {
    const mock = newMock();
    // An UNRELATED earlier withdrawal of the same size by the same address.
    const earlier = await mock.requestWithdrawal({ sats: 60_000n, bitcoinAddress: PINNED, signer: DEPOSITOR });

    const { client } = gatewayClient(mock, { sats: 60_000n });
    const result = await exit(deps(mock, client), request({ sharesToBurn: 60_000n }));

    expect(result.requestId).toBeDefined();
    expect(result.requestId).not.toBe(earlier.requestId);
  });

  it('prefers the request id carried by the PTB\'s own bridge event when there is one', async () => {
    const mock = newMock();
    const requestId = `0x${'ee'.repeat(32)}`;
    const { client } = gatewayClient(mock, {
      sats: 40_000n,
      events: [
        exitRequestedEvent(ALICE, 40_000n),
        {
          eventType: `${cfg.hashi.packageId}::withdrawal_queue::WithdrawalRequested`,
          bcs: new Uint8Array([0]),
          json: { request_id: requestId },
        },
      ],
    });

    const result = await exit(deps(mock, client), request({ sharesToBurn: 40_000n }));
    expect(result.requestId).toBe(requestId);
  });

  it('matches the receipt of the SIGNER by default, and of `who` when given', async () => {
    const mock = newMock();
    const bob = testSigner(5).toSuiAddress();
    const { client } = gatewayClient(mock, { sats: 12_000n, events: [exitPooledEvent(bob, 12_000n, 12_000n)] });

    // Signed by ALICE, receipt belongs to BOB ⇒ no receipt for us.
    await expect(exit(deps(mock, client), request())).rejects.toThrow(/ExitReceiptMissing|emitted neither/);

    const withWho = await exit(deps(mock, client), request({ who: bob }));
    expect(withWho.pooled).toBe(true);
  });

  it('raises when the exit PTB failed on chain', async () => {
    const mock = newMock();
    const { client } = gatewayClient(mock, { sats: 40_000n, failed: true });
    await expect(exit(deps(mock, client), request())).rejects.toThrow(/failed on chain/);
  });

  it('the keeper may TRIGGER an exit and still cannot redirect it (G2)', async () => {
    const mock = newMock();
    const { client, built } = gatewayClient(mock, { sats: 40_000n, who: KEEPER.toSuiAddress() });

    const result = await exit(deps(mock, client, KEEPER), request({ sharesToBurn: 40_000n }));

    expect(result.pooled).toBe(false);
    // Whoever signed, the PTB it signed still carries no destination.
    const tx = built[0];
    expect(tx).toBeDefined();
    expect(() => assertNoPinnedDestinationArgument(tx as Transaction)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/exit — trackExit surfaces the signet txid (G6: never on the demo path)', () => {
  it('follows a submitted exit to Confirmed and yields the signet txid', async () => {
    const mock = newMock();
    const { client } = gatewayClient(mock, { sats: 100_000n });
    const result = await exit(deps(mock, client), request({ sharesToBurn: 100_000n }));

    const view = await trackExit(deps(mock, client), result.requestId as string);

    expect(view.status).toBe('Confirmed');
    expect(signetTxidOf(view)).toMatch(/^[0-9a-f]{64}$/);
    // ~1.5–2 h of LOGICAL time elapsed inside the bridge, after the instant Sui-side PTB (G1/G6).
    expect(mock.nowMs()).toBeGreaterThan(0);
  });

  it('honours an explicit timeout budget and reports a Timeout rather than hanging', async () => {
    const mock = newMock();
    const { client } = gatewayClient(mock, { sats: 100_000n });
    const result = await exit(deps(mock, client), request({ sharesToBurn: 100_000n }));

    await expect(trackExit(deps(mock, client), result.requestId as string, { timeoutMs: 1 })).rejects.toThrow(
      /timed out/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/reclaim — DEPOSITOR-SIGNED ONLY (E-K7): a builder, never a signer', () => {
  const COOLDOWN = cfg.hashi.cancellationCooldownMs; // 3_600_000

  function tracked(overrides: Partial<TrackedWithdrawal> = {}): TrackedWithdrawal {
    return {
      requestId: `0x${'ab'.repeat(32)}`,
      status: 'Requested',
      sats: 100_000n,
      createdAtMs: 0,
      requester: ALICE,
      ...overrides,
    };
  }

  it('exports NOTHING that can sign or submit (invariant 1)', () => {
    expect(Object.keys(reclaimModule).sort()).toEqual([
      'buildReclaimTx',
      'findStalledExits',
      'isReclaimable',
      'trackWithdrawals',
    ]);
    for (const value of Object.values(reclaimModule)) {
      expect(String(value)).not.toMatch(/signAndExecute|signTransaction|executeTransaction/);
    }
  });

  it('isReclaimable mirrors the two on-chain asserts: pre-commit status + 1 h cooldown', () => {
    expect(isReclaimable(tracked({ status: 'Requested' }), 0, COOLDOWN, COOLDOWN)).toBe(true);
    expect(isReclaimable(tracked({ status: 'Approved' }), 0, COOLDOWN, COOLDOWN)).toBe(true);
    // One millisecond early ⇒ ECooldownNotElapsed on chain.
    expect(isReclaimable(tracked({ status: 'Approved' }), 0, COOLDOWN - 1, COOLDOWN)).toBe(false);
  });

  it('isReclaimable refuses every post-commit status (ECannotCancelProcessingWithdrawal)', () => {
    for (const status of ['PickedForProcessing', 'Signed', 'Confirmed', 'Cancelled'] as const) {
      expect(isReclaimable(tracked({ status }), 0, COOLDOWN * 10, COOLDOWN)).toBe(false);
    }
  });

  it('findStalledExits is PURE and reports the lag and the reclaimable-at instant (invariant 3)', () => {
    const nowMs = COOLDOWN + 500_000;
    const stalled = findStalledExits([tracked({ createdAtMs: 0 })], nowMs, cfg);

    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.requester).toBe(ALICE);
    expect(stalled[0]?.sats).toBe(100_000n);
    expect(stalled[0]?.stalledForMs).toBe(nowMs);
    expect(stalled[0]?.reclaimableAtMs).toBe(COOLDOWN);
    expect(findStalledExits([tracked({ createdAtMs: 0 })], nowMs, cfg)).toEqual(stalled);
  });

  it('never reports a withdrawal whose creation time is unknown — we cannot prove the cooldown', () => {
    expect(findStalledExits([tracked({ createdAtMs: undefined })], COOLDOWN * 10, cfg)).toEqual([]);
  });

  it('trackWithdrawals folds the public stream into (created_ms, requester, status)', async () => {
    const mock = newMock();
    const { requestId } = await mock.requestWithdrawal({
      sats: 100_000n,
      bitcoinAddress: PINNED,
      signer: DEPOSITOR,
    });
    const createdAtMs = mock.nowMs();

    const atRequest = trackWithdrawals(mock.eventLog());
    expect(atRequest).toHaveLength(1);
    expect(atRequest[0]).toEqual({
      requestId,
      status: 'Requested',
      sats: 100_000n,
      createdAtMs,
      requester: ALICE,
    });

    // The requester is the ONLY address the upstream cancel accepts — never the keeper.
    expect(atRequest[0]?.requester).not.toBe(KEEPER.toSuiAddress());

    mock.advanceMs(FAST.withdrawalApprovalDelayMs ?? 20_000);
    expect(trackWithdrawals(mock.eventLog())[0]?.status).toBe('Approved');

    mock.advanceMs(1_000_000);
    expect(trackWithdrawals(mock.eventLog())[0]?.status).toBe('Confirmed');
  });

  it('a stall detected from the real stream becomes a reclaim the DEPOSITOR can sign', async () => {
    const mock = newMock();
    // Compressed lifecycle would settle it; freeze the pick so it stays pre-commit.
    const frozen = createMockHashiAdapter(cfg, { ...FAST, withdrawalBatchDelayMs: 100_000_000 });
    frozen.creditBalance(ALICE, 10_000_000n);
    const { requestId } = await frozen.requestWithdrawal({
      sats: 100_000n,
      bitcoinAddress: PINNED,
      signer: DEPOSITOR,
    });
    frozen.advanceMs(FAST.withdrawalApprovalDelayMs ?? 20_000);

    const nowMs = frozen.nowMs() + COOLDOWN;
    const stalled = findStalledExits(trackWithdrawals(frozen.eventLog()), nowMs, cfg);

    expect(stalled.map((s) => s.requestId)).toEqual([requestId]);
    expect(stalled[0]?.requester).toBe(ALICE);
    expect(mock.eventLog()).toEqual([]); // the other mock was never touched
  });

  it('buildReclaimTx sets the DEPOSITOR as sender and calls gateway::reclaim_stalled_exit', () => {
    const tx = buildReclaimTx(cfg, {
      vaultId: VAULT_ID,
      hashiRequestId: `0x${'cd'.repeat(32)}`,
      depositor: ALICE,
      bookMid: BOOK_MID,
    });
    const data = tx.getData();

    expect(data.sender).toBe(ALICE);
    expect(data.sender).not.toBe(KEEPER.toSuiAddress());
    expect(data.commands).toHaveLength(1);

    const call = data.commands[0]?.MoveCall;
    expect(call?.package).toBe(APHOTIC_PACKAGE);
    expect(call?.module).toBe('gateway');
    expect(call?.function).toBe('reclaim_stalled_exit');
    expect(call?.typeArguments).toEqual([cfg.deepbook.dbusdcCoinType]);
    // vault, hashi, request_id, book_mid, clock — and NO `who`: Move uses ctx.sender().
    expect(call?.arguments).toHaveLength(5);
  });

  it('the reclaim PTB is UNSIGNED and carries no destination either (G2)', () => {
    const tx = buildReclaimTx(cfg, {
      vaultId: VAULT_ID,
      hashiRequestId: `0x${'cd'.repeat(32)}`,
      depositor: ALICE,
      bookMid: BOOK_MID,
    });

    // A `Transaction` has no signature slot at all — that is the whole point of E-K7.
    expect('signatures' in tx.getData()).toBe(false);
    expect(() => assertNoPinnedDestinationArgument(tx)).not.toThrow();
  });

  it('refuses to build without a depositor, or without the package ids', () => {
    const req = { vaultId: VAULT_ID, hashiRequestId: '0xcd', depositor: '', bookMid: BOOK_MID };
    expect(() => buildReclaimTx(cfg, req)).toThrow(/ReclaimNeedsDepositor|never sign/);
    expect(() => buildReclaimTx(bare, { ...req, depositor: ALICE })).toThrow(ConfigError);
  });

  it('is deterministic: the same request builds byte-identical data', () => {
    const req = {
      vaultId: VAULT_ID,
      hashiRequestId: `0x${'cd'.repeat(32)}`,
      depositor: ALICE,
      bookMid: BOOK_MID,
    };
    expect(JSON.stringify(buildReclaimTx(cfg, req).getData())).toBe(
      JSON.stringify(buildReclaimTx(cfg, req).getData()),
    );
  });
});
