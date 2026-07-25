// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.5 acceptance criteria)
// @spec       docs/KEEPER.md §2.4 (MOCK behaviour), §13 A1 (offline end-to-end)
// @spec       docs/RECON.md#r6 (live bridge config), #r7 (Move aborts mirrored)
// @rules      G1 G2 G3 G5 G6 G7
// @depends    ../src/hashi/mock.ts (T0.5) · ./support/fixtures.ts
// @facts      Deposit min 30_000 sats · withdrawal min 30_000 sats · cancel cooldown 3_600_000 ms
// @facts      Address must be 20 bytes (P2WPKH) or 32 bytes (P2TR) — anything else aborts.
// @facts      `confirm_deposit` is PERMISSIONLESS and EXPLICIT; the mock never auto-confirms.
// @implements deposit lifecycle · withdrawal lifecycle · sub-30_000 rejection ·
//             20/32-byte address validation · cancel sender-binding + cooldown ·
//             RateLimitExceeded rejection (G3) · determinism · event cursor paging
// @invariant  1. Zero network I/O, zero wall-clock reads.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { createMockHashiAdapter } from '../src/hashi/mock.js';
import type { HashiEvent, HashiEventKind } from '../src/hashi/types.js';
import {
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  CooldownNotElapsedError,
  InvalidBitcoinAddressError,
  NotReadyError,
  UnauthorizedCancellationError,
} from '../src/util/errors.js';

import { FAST, p2trAddress, p2wpkhAddress, testConfig, testSigner } from './support/fixtures.js';

const kinds = (events: readonly HashiEvent[]): HashiEventKind[] => events.map((e) => e.kind);

describe('hashi/mock — deposit lifecycle (G6: ~70 min real, logical clock here)', () => {
  it('walks Requested -> Approved -> (PERMISSIONLESS crank) -> Confirmed + Minted and credits the recipient', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(1);
    const recipient = user.toSuiAddress();

    const { requestId } = await mock.deposit({
      signer: user,
      txid: 'signet-txid-1',
      utxos: [{ txid: 'signet-txid-1', vout: 0, sats: 120_000n }],
      recipient,
    });

    expect((await mock.view.depositStatus(requestId)).status).toBe('Requested');
    expect(await mock.view.balance(recipient)).toBe(0n);

    // The crank is not callable before approval + bitcoin_deposit_time_delay_ms.
    await expect(mock.confirmDeposit(requestId, user)).rejects.toBeInstanceOf(NotReadyError);

    const approved = await mock.waitForDeposit(requestId);
    expect(approved.status).toBe('Approved');
    expect(approved.confirmableAtMs).toBeDefined();

    const { digest } = await mock.confirmDeposit(requestId, user);
    expect(digest).toMatch(/^MOCK[0-9a-f]{32}$/);

    const confirmed = await mock.view.depositStatus(requestId);
    expect(confirmed.status).toBe('Confirmed');
    expect(confirmed.sats).toBe(120_000n);
    expect(await mock.view.balance(recipient)).toBe(120_000n);

    const { events } = await mock.eventsSince({ seq: 0n });
    expect(kinds(events)).toEqual(['DepositRequested', 'DepositApproved', 'DepositConfirmed', 'Minted']);
  });

  it('rejects a deposit below bitcoin_deposit_minimum (30_000 sats)', async () => {
    const mock = createMockHashiAdapter(testConfig(), FAST);
    const user = testSigner(1);
    await expect(
      mock.deposit({
        signer: user,
        txid: 'dust',
        utxos: [{ txid: 'dust', vout: 0, sats: 29_999n }],
        recipient: user.toSuiAddress(),
      }),
    ).rejects.toBeInstanceOf(BelowMinimumDepositError);
  });

  it('generateDepositAddress is deterministic per Sui address and needs no server', async () => {
    const a = createMockHashiAdapter(testConfig(), FAST);
    const b = createMockHashiAdapter(testConfig(), FAST);
    const addr = testSigner(3).toSuiAddress();
    const first = await a.generateDepositAddress(addr);
    const second = await b.generateDepositAddress(addr);
    expect(first).toEqual(second);
    expect(first.p2tr).toMatch(/^tb1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/);
    expect(first.suiAddress).toBe(addr);
  });
});

describe('hashi/mock — withdrawal lifecycle (G6: ~1.5–2 h real)', () => {
  it('walks Requested -> Approved -> PickedForProcessing -> Signed -> Confirmed and debits the bucket exactly once', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(2);
    mock.creditBalance(user.toSuiAddress(), 1_000_000n);

    const before = await mock.guardian.limiterStatus();
    expect(before.tokens).toBe(cfg.limiter.maxBucketCapacitySats);
    expect(before.nextSeq).toBe(0n);

    const { requestId } = await mock.requestWithdrawal({
      sats: 500_000n,
      bitcoinAddress: p2trAddress(),
      signer: user,
    });
    expect((await mock.view.withdrawalStatus(requestId)).status).toBe('Requested');

    const settled = await mock.waitForWithdrawal(requestId);
    expect(settled.status).toBe('Confirmed');
    expect(settled.sats).toBe(500_000n);
    expect(settled.signetTxid).toMatch(/^[0-9a-f]{64}$/);

    const after = await mock.guardian.limiterStatus();
    expect(after.nextSeq).toBe(1n);
    expect(after.source).toBe('replay');

    const { events: signed } = await mock.signedEventsSince({ seq: 0n });
    expect(signed).toHaveLength(1);
    expect(signed[0]?.sats).toBe(500_000n);
    expect(signed[0]?.satsSource).toBe('requested');
    // ★ The raw Move struct has neither of these; both are synthesised (docs/RECON.md R8).
    expect(signed[0]?.atMs).toBeGreaterThan(0);
    expect(signed[0]?.atSecs).toBe(BigInt(Math.floor((signed[0]?.atMs ?? 0) / 1000)));

    const { events } = await mock.eventsSince({ seq: 0n });
    expect(kinds(events)).toEqual([
      'WithdrawalRequested',
      'WithdrawalApproved',
      'WithdrawalPickedForProcessing',
      'WithdrawalInputsSigned',
      'WithdrawalSigned',
      'Burned',
      'WithdrawalConfirmed',
    ]);
  });

  it('rejects a withdrawal below bitcoin_withdrawal_minimum (30_000 sats) — EBelowMinimumWithdrawal', async () => {
    const mock = createMockHashiAdapter(testConfig(), FAST);
    const user = testSigner(2);
    await expect(
      mock.requestWithdrawal({ sats: 29_999n, bitcoinAddress: p2trAddress(), signer: user }),
    ).rejects.toBeInstanceOf(BelowMinimumWithdrawalError);
    // Nothing was recorded.
    expect((await mock.eventsSince({ seq: 0n })).events).toHaveLength(0);
  });

  it('accepts a 20-byte P2WPKH and a 32-byte P2TR program, rejects every other length — EInvalidBitcoinAddress', async () => {
    const mock = createMockHashiAdapter(testConfig(), FAST);
    const user = testSigner(2);

    await expect(
      mock.requestWithdrawal({ sats: 50_000n, bitcoinAddress: p2wpkhAddress(), signer: user }),
    ).resolves.toHaveProperty('requestId');
    await expect(
      mock.requestWithdrawal({ sats: 50_000n, bitcoinAddress: p2trAddress(), signer: user }),
    ).resolves.toHaveProperty('requestId');

    for (const length of [0, 19, 21, 31, 33, 64]) {
      await expect(
        mock.requestWithdrawal({ sats: 50_000n, bitcoinAddress: new Uint8Array(length), signer: user }),
      ).rejects.toBeInstanceOf(InvalidBitcoinAddressError);
    }
  });
});

describe('hashi/mock — cancel_withdrawal is sender-bound and cooldown-gated (docs/RECON.md R7.3)', () => {
  it('only the ORIGINAL requester may cancel — the keeper never can (G2)', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, { ...FAST, withdrawalApprovalDelayMs: 10_000_000 });
    const user = testSigner(2);
    const keeper = testSigner(9);

    const { requestId } = await mock.requestWithdrawal({
      sats: 50_000n,
      bitcoinAddress: p2trAddress(),
      signer: user,
    });

    mock.advanceMs(cfg.hashi.cancellationCooldownMs);
    await expect(mock.cancelWithdrawal(requestId, keeper)).rejects.toBeInstanceOf(UnauthorizedCancellationError);
    await expect(mock.cancelWithdrawal(requestId, user)).resolves.toEqual({ sats: 50_000n });
    expect((await mock.view.withdrawalStatus(requestId)).status).toBe('Cancelled');
  });

  it('refuses to cancel before the 1 h withdrawal_cancellation_cooldown_ms', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, { ...FAST, withdrawalApprovalDelayMs: 10_000_000 });
    const user = testSigner(2);
    const { requestId } = await mock.requestWithdrawal({
      sats: 50_000n,
      bitcoinAddress: p2trAddress(),
      signer: user,
    });
    mock.advanceMs(cfg.hashi.cancellationCooldownMs - 1);
    await expect(mock.cancelWithdrawal(requestId, user)).rejects.toBeInstanceOf(CooldownNotElapsedError);
  });
});

describe('hashi/mock — the Guardian bucket (G3: over-capacity is REJECTED, never queued)', () => {
  it('never signs a batch larger than max_bucket_capacity and leaves the bucket untouched', async () => {
    const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '0', MAX_BUCKET_CAPACITY_SATS: '40000' });
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(2);

    const { requestId } = await mock.requestWithdrawal({
      sats: 50_000n,
      bitcoinAddress: p2trAddress(),
      signer: user,
    });
    mock.advanceMs(10_000_000);

    const view = await mock.view.withdrawalStatus(requestId);
    expect(view.status).toBe('PickedForProcessing');
    expect((await mock.signedEventsSince({ seq: 0n })).events).toHaveLength(0);

    const status = await mock.guardian.limiterStatus();
    expect(status.tokens).toBe(40_000n);
    expect(status.nextSeq).toBe(0n);
    expect(await mock.guardian.canWithdraw(50_000n)).toBe(false);
    expect(await mock.guardian.canWithdraw(40_000n)).toBe(true);
    // Below the protocol minimum is never withdrawable regardless of capacity.
    expect(await mock.guardian.canWithdraw(29_999n)).toBe(false);
  });

  it('retries a temporarily over-capacity batch and signs it once the bucket refills (never jumps the queue)', async () => {
    // Slow refill (100 sats/s) so the second batch is genuinely rejected several times first.
    const cfg = testConfig({ REFILL_RATE_SATS_PER_S: '100', MAX_BUCKET_CAPACITY_SATS: '60000' });
    const mock = createMockHashiAdapter(cfg, FAST);
    const user = testSigner(2);

    // Drain the bucket first so the second withdrawal must wait for refill.
    const first = await mock.requestWithdrawal({ sats: 60_000n, bitcoinAddress: p2trAddress(1), signer: user });
    await mock.waitForWithdrawal(first.requestId);
    expect((await mock.guardian.limiterStatus()).nextSeq).toBe(1n);

    const second = await mock.requestWithdrawal({ sats: 50_000n, bitcoinAddress: p2trAddress(2), signer: user });
    const settled = await mock.waitForWithdrawal(second.requestId, { timeoutMs: 5_000_000 });
    expect(settled.status).toBe('Confirmed');

    const { events: signed } = await mock.signedEventsSince({ seq: 0n });
    expect(signed.map((e) => e.sats)).toEqual([60_000n, 50_000n]);
    expect((await mock.guardian.limiterStatus()).nextSeq).toBe(2n);
  });
});

describe('hashi/mock — determinism and the event cursor', () => {
  it('two adapters with the same seed produce byte-identical event logs', async () => {
    const run = async (): Promise<string> => {
      const mock = createMockHashiAdapter(testConfig(), FAST);
      const user = testSigner(4);
      const d = await mock.deposit({
        signer: user,
        txid: 't',
        utxos: [{ txid: 't', vout: 0, sats: 200_000n }],
        recipient: user.toSuiAddress(),
      });
      await mock.waitForDeposit(d.requestId);
      await mock.confirmDeposit(d.requestId, user);
      const w = await mock.requestWithdrawal({ sats: 100_000n, bitcoinAddress: p2trAddress(), signer: user });
      await mock.waitForWithdrawal(w.requestId);
      return JSON.stringify(mock.eventLog(), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    };
    expect(await run()).toBe(await run());
  });

  it('eventsSince resumes exactly at the cursor and never replays an event twice', async () => {
    const mock = createMockHashiAdapter(testConfig(), FAST);
    const user = testSigner(5);
    const d = await mock.deposit({
      signer: user,
      txid: 't',
      utxos: [{ txid: 't', vout: 0, sats: 200_000n }],
      recipient: user.toSuiAddress(),
    });
    await mock.waitForDeposit(d.requestId);
    await mock.confirmDeposit(d.requestId, user);

    const page1 = await mock.eventsSince({ seq: 0n }, { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.next.seq).toBe(2n);

    const page2 = await mock.eventsSince(page1.next);
    expect(page2.events.map((e) => e.seq)).toEqual([2n, 3n]);
    expect(page2.next.seq).toBe(4n);

    const page3 = await mock.eventsSince(page2.next);
    expect(page3.events).toHaveLength(0);
    expect(page3.next.seq).toBe(4n);

    // seq is exactly the index in the log.
    expect(mock.eventLog().map((e) => e.seq)).toEqual([0n, 1n, 2n, 3n]);
  });

  it('bridgeConfig reports the live on-chain constants the mock is seeded from (docs/RECON.md R6)', async () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg, FAST);
    const bridge = await mock.bridgeConfig();
    expect(bridge.adapter).toBe('mock');
    expect(bridge.withdrawalMinimumSats).toBe(30_000n);
    expect(bridge.depositMinimumSats).toBe(30_000n);
    expect(bridge.depositTimeDelayMs).toBe(600_000);
    expect(bridge.cancellationCooldownMs).toBe(3_600_000);
    expect(bridge.confirmationThreshold).toBe(6);
    expect(bridge.dustFloorSats).toBe(546n);
    expect(bridge.paused).toBe(false);
    expect(bridge.limiter).toEqual(cfg.limiter);
  });
});
