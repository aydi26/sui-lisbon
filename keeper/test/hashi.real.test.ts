// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.1
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.1 — "still swappable for the mock behind the same
//             interface"), docs/KEEPER.md §2.3
// @spec       docs/ULTRACODE-BRIEF.md E-K8 (the SDK gaps), E-K9 (guardian needs HTTP/2)
// @rules      G2 G3 G5 G6 G7
// @depends    ../src/hashi/real.ts (T2.1) · ../src/hashi/mock.ts (T0.5) · ./support/fixtures.ts
// @facts      This suite drives the REAL adapter through its injected seams (`RealHashiDeps`):
// @facts        a fake `HashiSdkClient`, a fake event pager, a fake PTB executor and a fake
// @facts        guardian reader. ZERO network, ZERO wall clock — the whole suite is offline (G7).
// @facts      ⚠ '@mysten/hashi' is deliberately NOT imported here: G7 confines it to
// @facts        keeper/src/hashi/real.ts. The SDK shape is exercised through `HashiSdkClient`,
// @facts        the structural slice real.ts type-checks the genuine `HashiClient` against.
// @implements construction is I/O-free · mock↔real interface parity · error-taxonomy parity ·
//             event log normalization/paging/idempotency · requestId->digest resolution ·
//             confirm_deposit raw moveCall target · guardian hint never throws (E-K9) ·
//             canWithdraw answers from the REPLAY, not the hint (G5) ·
//             UnsupportedByUpstreamError when no event transport exists (E-K8 gap #3)
// @invariant  1. No test opens a socket and none reads Date.now().
// @verify     npm run test -- hashi.real
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { createMockHashiAdapter } from '../src/hashi/mock.js';
import type { RawSuiEvent } from '../src/hashi/normalize.js';
import {
  UnsupportedByUpstreamError,
  bitcoinNetworkFor,
  buildJsonRpcEventQuery,
  compareRawEvents,
  createRealHashiAdapter,
  depositViewOf,
  isLimiterHintAvailable,
  parseGuardianLimiter,
  txDigestOf,
  txEventsOf,
  withdrawalViewOf,
  type EventQuery,
  type HashiSdkClient,
  type RealHashiDeps,
  type SdkDepositInfo,
  type SdkWithdrawalInfo,
} from '../src/hashi/real.js';
import type { HashiEvent } from '../src/hashi/types.js';
import {
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  InvalidBitcoinAddressError,
  NotFoundError,
} from '../src/util/errors.js';

import { p2trAddress, p2wpkhAddress, testConfig, testSigner } from './support/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: raw Sui events, JSON-RPC shaped (`{type, parsedJson, timestampMs, id}`)
// ─────────────────────────────────────────────────────────────────────────────

const REQ_A = '0xaa'.padEnd(66, 'a');
const REQ_B = '0xbb'.padEnd(66, 'b');
const DEP_A = '0xdd'.padEnd(66, 'd');
const TXN_1 = '0x11'.padEnd(66, '1');

function raw(
  cfg: Config,
  module: string,
  struct: string,
  parsedJson: Record<string, unknown>,
  timestampMs: number,
  txDigest: string,
  eventSeq = 0,
  typeArgs = '',
): RawSuiEvent {
  return {
    type: `${cfg.hashi.packageId}::${module}::${struct}${typeArgs}`,
    parsedJson,
    timestampMs: String(timestampMs),
    id: { txDigest, eventSeq: String(eventSeq) },
  };
}

/** deposit module: DepositRequested -> DepositApproved -> DepositConfirmed. */
function depositEvents(cfg: Config, user: string): RawSuiEvent[] {
  return [
    raw(cfg, 'deposit', 'DepositRequested', {
      request_id: DEP_A,
      amount: '120000',
      requester_address: user,
      derivation_path: user,
    }, 1_000, 'DIGEST-DEP-1'),
    raw(cfg, 'deposit', 'DepositApproved', {
      request_id: DEP_A,
      utxo: { fields: { amount: '120000' } },
      approval_timestamp_ms: '2000',
    }, 2_000, 'DIGEST-DEP-2'),
    raw(cfg, 'deposit', 'DepositConfirmed', {
      request_id: DEP_A,
      utxo: { fields: { amount: '120000' } },
    }, 3_000, 'DIGEST-DEP-3'),
  ];
}

/** withdrawal_queue module: two requests, one of which gets picked + signed. */
function withdrawalEvents(cfg: Config, user: string): RawSuiEvent[] {
  return [
    raw(cfg, 'withdrawal_queue', 'WithdrawalRequested', {
      request_id: REQ_A,
      btc_amount: '50000',
      bitcoin_address: [...p2wpkhAddress(0x01)],
      requester_address: user,
    }, 1_500, 'DIGEST-W-1'),
    raw(cfg, 'withdrawal_queue', 'WithdrawalRequested', {
      request_id: REQ_B,
      btc_amount: '70000',
      bitcoin_address: [...p2trAddress(0x02)],
      requester_address: user,
    }, 2_500, 'DIGEST-W-2'),
    raw(cfg, 'withdrawal_queue', 'WithdrawalPickedForProcessing', {
      withdrawal_txn_id: TXN_1,
      txid: TXN_1,
      request_ids: [REQ_A],
      withdrawal_outputs: [{ fields: { amount: '50000', bitcoin_address: [...p2wpkhAddress(0x01)] } }],
    }, 4_000, 'DIGEST-W-3'),
    raw(cfg, 'withdrawal_queue', 'WithdrawalSigned', {
      withdrawal_txn_id: TXN_1,
      request_ids: [REQ_A],
      signatures: ['sig'],
      guardian_signatures: ['gsig'],
    }, 5_000, 'DIGEST-W-4'),
  ];
}

/** treasury module: the generic Minted<T> — the filter must carry the type argument. */
function treasuryEvents(cfg: Config): RawSuiEvent[] {
  return [
    raw(cfg, 'treasury', 'Minted', { amount: '120000' }, 3_000, 'DIGEST-DEP-3', 1, `<${cfg.hashi.hbtcCoinType}>`),
  ];
}

/** A pager over pre-baked pages, keyed by module. Mirrors JSON-RPC cursor semantics. */
function pagedEventQuery(pages: Record<string, RawSuiEvent[][]>): EventQuery {
  return async ({ module, cursor }) => {
    const modulePages = pages[module] ?? [];
    const index = cursor === null ? 0 : Number(cursor.eventSeq);
    const data = modulePages[index] ?? [];
    const hasNextPage = index + 1 < modulePages.length;
    return {
      data,
      nextCursor: hasNextPage ? { txDigest: module, eventSeq: String(index + 1) } : null,
      hasNextPage,
    };
  };
}

function singlePageQuery(cfg: Config, user: string): EventQuery {
  return pagedEventQuery({
    deposit: [depositEvents(cfg, user)],
    withdrawal_queue: [withdrawalEvents(cfg, user)],
    treasury: [treasuryEvents(cfg)],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: a fake HashiSdkClient (the structural slice of `HashiClient` we call)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeSdk {
  readonly client: HashiSdkClient;
  readonly calls: string[];
  readonly deposits: Map<string, SdkDepositInfo>;
  readonly withdrawals: Map<string, SdkWithdrawalInfo>;
  readonly balances: Map<string, bigint>;
}

function fakeSdk(): FakeSdk {
  const calls: string[] = [];
  const deposits = new Map<string, SdkDepositInfo>();
  const withdrawals = new Map<string, SdkWithdrawalInfo>();
  const balances = new Map<string, bigint>();

  const client: HashiSdkClient = {
    async generateDepositAddress({ suiAddress, bitcoinNetwork }) {
      calls.push(`generateDepositAddress:${bitcoinNetwork ?? '-'}`);
      return `tb1p${suiAddress.slice(2, 12)}`;
    },
    view: {
      async all() {
        calls.push('view.all');
        return {
          paused: false,
          bitcoinChainId: 'signet',
          bitcoinDepositMinimum: 30_000n,
          bitcoinWithdrawalMinimum: 30_000n,
          bitcoinConfirmationThreshold: 6n,
          withdrawalCancellationCooldownMs: 3_600_000n,
          bitcoinDepositTimeDelayMs: 600_000n,
          depositMinimum: 30_000n,
          worstCaseNetworkFee: 29_454n,
          guardianUrl: 'https://guardian.example.invalid',
          guardianPublicKey: null,
          guardianBtcPublicKey: null,
        };
      },
      async balance(owner) {
        calls.push(`view.balance:${owner}`);
        return { totalBalance: balances.get(owner) ?? 0n, coinObjectCount: 1 };
      },
      async depositStatus(suiTxDigest) {
        calls.push(`view.depositStatus:${suiTxDigest}`);
        return deposits.get(suiTxDigest) ?? null;
      },
      async withdrawalStatus(suiTxDigest) {
        calls.push(`view.withdrawalStatus:${suiTxDigest}`);
        return withdrawals.get(suiTxDigest) ?? null;
      },
      async transactionHistory(suiAddress) {
        calls.push(`view.transactionHistory:${suiAddress}`);
        return [
          {
            kind: 'deposit',
            requestId: DEP_A,
            sender: suiAddress,
            amountSats: 120_000n,
            approved: true,
            confirmableAtMs: 2_600_000n,
          },
          {
            kind: 'withdrawal',
            requestId: REQ_A,
            sender: suiAddress,
            btcAmountSats: 50_000n,
            bitcoinAddress: p2wpkhAddress(0x01),
            status: 'Processing',
            btcTxid: null,
          },
        ];
      },
    },
    tx: {
      deposit(params) {
        calls.push(`tx.deposit:${params.txid}:${params.utxos.length}:${params.recipient}`);
        return new Transaction();
      },
      requestWithdrawal(options) {
        calls.push(`tx.requestWithdrawal:${options.amount}:${options.bitcoinAddress.length}`);
        return new Transaction();
      },
      cancelWithdrawal(options) {
        calls.push(`tx.cancelWithdrawal:${options.requestId}:${options.recipient}`);
        return new Transaction();
      },
    },
  };

  return { client, calls, deposits, withdrawals, balances };
}

/** A gRPC-shaped execution result carrying `events`, so `requireEventField` can find the receipt. */
function txResult(cfg: Config, digest: string, events: RawSuiEvent[]): unknown {
  return {
    $kind: 'Transaction',
    Transaction: {
      digest,
      events: events.map((e) => ({ eventType: e.type, json: e.parsedJson, timestampMs: e.timestampMs })),
    },
  };
  void cfg;
}

/** Deps that keep the whole adapter offline and on a LOGICAL clock. */
function offlineDeps(cfg: Config, user: string, over: Partial<RealHashiDeps> = {}): RealHashiDeps {
  let clock = 1_000_000;
  return {
    sdk: fakeSdk().client,
    eventQuery: singlePageQuery(cfg, user),
    signAndExecute: async () => txResult(cfg, 'DIGEST-EXEC', []),
    guardianInfo: async () => {
      throw new Error('guardian unreachable in tests');
    },
    nowMs: () => (clock += 1_000),
    sleep: async () => undefined,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('hashi/real — construction is I/O-free and configuration-pinned (G7)', () => {
  it('builds with no deps at all and performs zero I/O until a method is called', () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const adapter = createRealHashiAdapter(cfg);
    expect(adapter.kind).toBe('real');
    // Every transport is lazy: nothing above threw and nothing was constructed.
    expect(typeof adapter.eventsSince).toBe('function');
  });

  it('pairs Sui testnet with Bitcoin signet, and only mainnet with mainnet', () => {
    expect(bitcoinNetworkFor(testConfig())).toBe('signet');
    expect(bitcoinNetworkFor(testConfig({ SUI_NETWORK: 'mainnet' }))).toBe('mainnet');
  });

  it('raises UnsupportedByUpstreamError when no event transport exists (E-K8 gap #3)', () => {
    // gRPC v2 has no event RPC; with the JSON-RPC mirror blanked there is nowhere to read from.
    const cfg = testConfig({ SUI_JSON_RPC_URL: '' });
    expect(() => buildJsonRpcEventQuery(cfg)).toThrow(UnsupportedByUpstreamError);
    try {
      buildJsonRpcEventQuery(cfg);
    } catch (err) {
      expect((err as UnsupportedByUpstreamError).code).toBe('UnsupportedByUpstream');
      expect((err as Error).message).toMatch(/no event-query RPC/);
    }
  });
});

describe('hashi/real — interface + error-taxonomy parity with the MOCK (T2.1 acceptance)', () => {
  it('exposes exactly the same method/namespace surface as the mock adapter', () => {
    const cfg = testConfig();
    const mock = createMockHashiAdapter(cfg);
    const real = createRealHashiAdapter(testConfig({ HASHI_ADAPTER: 'real' }));

    const surface = (a: object): string[] =>
      Object.keys(a)
        .filter((k) => k !== 'options' && !['nowMs', 'advanceMs', 'setNowMs', 'limiterState', 'eventLog', 'creditBalance'].includes(k))
        .sort();

    expect(surface(real)).toEqual(surface(mock));
    for (const key of ['balance', 'depositStatus', 'withdrawalStatus', 'all'] as const) {
      expect(typeof real.view[key]).toBe('function');
      expect(typeof mock.view[key]).toBe('function');
    }
    for (const key of ['limiterStatus', 'canWithdraw'] as const) {
      expect(typeof real.guardian[key]).toBe('function');
      expect(typeof mock.guardian[key]).toBe('function');
    }
  });

  it('rejects a sub-minimum deposit with the SAME error code as the mock (EBelowMinimumDeposit)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(1);
    const real = createRealHashiAdapter(cfg, offlineDeps(cfg, user.toSuiAddress()));
    const mock = createMockHashiAdapter(testConfig());

    const args = {
      signer: user,
      txid: '0xfeed',
      utxos: [{ txid: '0xfeed', vout: 0, sats: 29_999n }],
      recipient: user.toSuiAddress(),
    };

    await expect(real.deposit(args)).rejects.toBeInstanceOf(BelowMinimumDepositError);
    await expect(mock.deposit(args)).rejects.toBeInstanceOf(BelowMinimumDepositError);
  });

  it('rejects a sub-minimum withdrawal and a malformed witness program exactly as the mock does', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(2);
    const real = createRealHashiAdapter(cfg, offlineDeps(cfg, user.toSuiAddress()));
    const mock = createMockHashiAdapter(testConfig());

    const tooSmall = { sats: 29_999n, bitcoinAddress: p2trAddress(), signer: user };
    await expect(real.requestWithdrawal(tooSmall)).rejects.toBeInstanceOf(BelowMinimumWithdrawalError);
    await expect(mock.requestWithdrawal(tooSmall)).rejects.toBeInstanceOf(BelowMinimumWithdrawalError);

    // 21 bytes is neither P2WPKH (20) nor P2TR (32) — mirrors EInvalidBitcoinAddress.
    const badAddr = { sats: 50_000n, bitcoinAddress: new Uint8Array(21), signer: user };
    await expect(real.requestWithdrawal(badAddr)).rejects.toBeInstanceOf(InvalidBitcoinAddressError);
    await expect(mock.requestWithdrawal(badAddr)).rejects.toBeInstanceOf(InvalidBitcoinAddressError);
  });
});

describe('hashi/real — event log (the G5 trust anchor, E-K8 gap #3)', () => {
  it('normalizes all three modules into one seq-ordered log with the WithdrawalSigned join', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(3).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));

    const { events, next } = await adapter.eventsSince({ seq: 0n });
    const kinds = events.map((e) => e.kind);

    // Merged on (timestampMs, txDigest, eventSeq) across deposit / withdrawal_queue / treasury.
    expect(kinds).toEqual([
      'DepositRequested', // 1000
      'WithdrawalRequested', // 1500
      'DepositApproved', // 2000
      'WithdrawalRequested', // 2500
      'DepositConfirmed', // 3000 · DIGEST-DEP-3 seq 0
      'Minted', // 3000 · DIGEST-DEP-3 seq 1
      'WithdrawalPickedForProcessing', // 4000
      'WithdrawalSigned', // 5000
    ]);
    expect(events.map((e) => e.seq)).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(next.seq).toBe(8n);

    // ★ WithdrawalSigned carries NO amount on chain — normalize.ts joins it from the request.
    const signed = events.find((e) => e.kind === 'WithdrawalSigned');
    expect(signed).toBeDefined();
    if (signed?.kind === 'WithdrawalSigned') {
      expect(signed.sats).toBe(50_000n);
      expect(signed.satsSource).toBe('requested');
      expect(signed.atSecs).toBe(5n);
    }

    // The generic treasury event resolved its coin type from the type argument.
    const minted = events.find((e) => e.kind === 'Minted');
    if (minted?.kind === 'Minted') expect(minted.coinType).toBe(cfg.hashi.hbtcCoinType);
  });

  it('is idempotent and monotonic: re-reading a cursor replays identical events', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(3).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));

    const first = await adapter.eventsSince({ seq: 0n });
    const again = await adapter.eventsSince({ seq: 0n });
    expect(again.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
    expect(again.events.map((e) => e.kind)).toEqual(first.events.map((e) => e.kind));

    // Reading past the end yields nothing and does not move the cursor backwards.
    const tail = await adapter.eventsSince(first.next);
    expect(tail.events).toEqual([]);
    expect(tail.next.seq).toBe(first.next.seq);
  });

  it('pages: a limit bounds the batch and the returned cursor resumes exactly where it stopped', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(3).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));

    const page1 = await adapter.eventsSince({ seq: 0n }, { limit: 3 });
    expect(page1.events).toHaveLength(3);
    expect(page1.next.seq).toBe(3n);

    const page2 = await adapter.eventsSince(page1.next, { limit: 3 });
    expect(page2.events.map((e) => e.seq)).toEqual([3n, 4n, 5n]);
  });

  it('walks multi-page module streams and still produces one deterministic merged order', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(3).toSuiAddress();
    const w = withdrawalEvents(cfg, user);
    const d = depositEvents(cfg, user);
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user),
      // Two pages per module, so the merge has to happen across fetches, not just within one.
      eventQuery: pagedEventQuery({
        deposit: [d.slice(0, 2), d.slice(2)],
        withdrawal_queue: [w.slice(0, 2), w.slice(2)],
        treasury: [treasuryEvents(cfg)],
      }),
      eventPageLimit: 2,
    });

    const all: HashiEvent[] = [];
    let cursor = { seq: 0n };
    for (let i = 0; i < 10; i++) {
      const page = await adapter.eventsSince(cursor);
      if (page.events.length === 0) break;
      all.push(...page.events);
      cursor = page.next;
    }
    expect(all.map((e) => e.kind)).toEqual([
      'DepositRequested',
      'WithdrawalRequested',
      'DepositApproved',
      'WithdrawalRequested',
      'DepositConfirmed',
      'Minted',
      'WithdrawalPickedForProcessing',
      'WithdrawalSigned',
    ]);
    expect(all.map((e) => Number(e.seq))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('signedEventsSince exposes only WithdrawalSigned — the sub-stream that moves the bucket (G5)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(3).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));

    const { events } = await adapter.signedEventsSince({ seq: 0n });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('WithdrawalSigned');
    expect(events[0]?.sats).toBe(50_000n);
  });
});

describe('hashi/real — request_id -> Sui digest resolution (E-K8 gap #1)', () => {
  it('resolves a request_id from the event log and calls the digest-keyed SDK view', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(4).toSuiAddress();
    const sdk = fakeSdk();
    const info: SdkDepositInfo = {
      requestId: DEP_A,
      amountSats: 120_000n,
      recipient: user,
      approvalTimestampMs: 2_000n,
      confirmableAtMs: 602_000n,
      status: 'pending',
      suiTxDigest: 'DIGEST-DEP-1',
    };
    sdk.deposits.set('DIGEST-DEP-1', info);

    const adapter = createRealHashiAdapter(cfg, { ...offlineDeps(cfg, user), sdk: sdk.client });
    const view = await adapter.view.depositStatus(DEP_A);

    expect(sdk.calls).toContain('view.depositStatus:DIGEST-DEP-1');
    expect(view.status).toBe('Approved'); // pending + an approval timestamp
    expect(view.sats).toBe(120_000n);
    expect(view.confirmableAtMs).toBe(602_000);
  });

  it('throws NotFoundError for a request_id no Hashi event ever mentioned', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(4).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));
    await expect(adapter.view.withdrawalStatus('0xdeadbeef')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps the SDK lifecycle vocabulary onto ours (Processing -> PickedForProcessing)', () => {
    const w: SdkWithdrawalInfo = {
      requestId: REQ_A,
      btcAmountSats: 50_000n,
      bitcoinAddress: p2wpkhAddress(0x01),
      status: 'Processing',
      btcTxid: null,
    };
    expect(withdrawalViewOf(w).status).toBe('PickedForProcessing');
    expect(withdrawalViewOf({ ...w, status: 'cancelled' }).status).toBe('Cancelled');
    expect(withdrawalViewOf({ ...w, status: 'Confirmed', btcTxid: 'abc' }).signetTxid).toBe('abc');

    const d: SdkDepositInfo = {
      requestId: DEP_A,
      amountSats: 1n,
      recipient: null,
      approvalTimestampMs: null,
      confirmableAtMs: null,
      status: 'pending',
      suiTxDigest: 'x',
    };
    expect(depositViewOf(d).status).toBe('Requested');
    expect(depositViewOf({ ...d, status: 'expired' }).status).toBe('Expired');
    expect(depositViewOf({ ...d, status: 'confirmed' }).status).toBe('Confirmed');
  });

  it('view.all() maps the SDK transaction history onto DepositView/WithdrawalView', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(5).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));
    const { deposits, withdrawals } = await adapter.view.all(user);

    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.status).toBe('Approved');
    expect(deposits[0]?.confirmableAtMs).toBe(2_600_000);
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]?.status).toBe('PickedForProcessing');
    expect(withdrawals[0]?.sats).toBe(50_000n);
  });
});

describe('hashi/real — PTBs (G2: the keeper can crank, it can never redirect)', () => {
  it('confirmDeposit builds the raw entry moveCall the SDK does not ship (E-K8 gap #2)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(6);
    let seen: Transaction | undefined;
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user.toSuiAddress()),
      signAndExecute: async ({ transaction }) => {
        seen = transaction;
        return { $kind: 'Transaction', Transaction: { digest: 'CRANK-DIGEST', events: [] } };
      },
    });

    const { digest } = await adapter.confirmDeposit(DEP_A, user);
    expect(digest).toBe('CRANK-DIGEST');

    const data = seen?.getData();
    const command = data?.commands[0];
    expect(command?.$kind).toBe('MoveCall');
    expect(command?.MoveCall?.package).toBe(cfg.hashi.packageId);
    expect(command?.MoveCall?.module).toBe('deposit');
    expect(command?.MoveCall?.function).toBe('confirm_deposit');
    // &mut Hashi (shared, mutable) · request_id · &Clock (shared, immutable)
    expect(command?.MoveCall?.arguments).toHaveLength(3);
    const hashiInput = data?.inputs[0];
    expect(hashiInput?.Object?.SharedObject?.objectId).toBe(cfg.hashi.objectId);
    expect(hashiInput?.Object?.SharedObject?.mutable).toBe(true);
  });

  it('deposit returns the request_id read out of the emitted DepositRequested event', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(7);
    const sdk = fakeSdk();
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user.toSuiAddress()),
      sdk: sdk.client,
      signAndExecute: async () =>
        txResult(cfg, 'D', [
          raw(cfg, 'deposit', 'DepositRequested', { request_id: DEP_A, amount: '120000' }, 1_000, 'D'),
        ]),
    });

    const { requestId } = await adapter.deposit({
      signer: user,
      txid: '0xfeed',
      utxos: [{ txid: '0xfeed', vout: 0, sats: 120_000n }],
      recipient: user.toSuiAddress(),
    });
    expect(requestId).toBe(DEP_A);
    expect(sdk.calls).toContain(`tx.deposit:0xfeed:1:${user.toSuiAddress()}`);
  });

  it('cancelWithdrawal reads the refunded sats out of WithdrawalCancelled (depositor-signed only)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(8);
    const sdk = fakeSdk();
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user.toSuiAddress()),
      sdk: sdk.client,
      signAndExecute: async () =>
        txResult(cfg, 'C', [
          raw(cfg, 'withdrawal_queue', 'WithdrawalCancelled', {
            request_id: REQ_A,
            requester_address: user.toSuiAddress(),
            btc_amount: '50000',
          }, 9_000, 'C'),
        ]),
    });

    const { sats } = await adapter.cancelWithdrawal(REQ_A, user);
    expect(sats).toBe(50_000n);
    // The refund goes to the SIGNER's own address — never a keeper-chosen recipient (G2).
    expect(sdk.calls).toContain(`tx.cancelWithdrawal:${REQ_A}:${user.toSuiAddress()}`);
  });

  it('surfaces a missing receipt event as NotFoundError rather than an undefined request id', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(9);
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user.toSuiAddress()),
      signAndExecute: async () => txResult(cfg, 'X', []),
    });
    await expect(
      adapter.requestWithdrawal({ sats: 50_000n, bitcoinAddress: p2trAddress(), signer: user }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('hashi/real — bridgeConfig reads live governance, limiter stays configured (G5)', () => {
  it('takes every mutable parameter from view.all() and the two genesis scalars from Config', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(10).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));
    const bridge = await adapter.bridgeConfig();

    expect(bridge.adapter).toBe('real');
    expect(bridge.packageId).toBe(cfg.hashi.packageId);
    expect(bridge.depositTimeDelayMs).toBe(600_000);
    expect(bridge.withdrawalMinimumSats).toBe(30_000n);
    expect(bridge.confirmationThreshold).toBe(6);
    expect(bridge.paused).toBe(false);
    // The trust anchors are NOT read from the bridge — they are the configured bound (G5).
    expect(bridge.limiter).toEqual(cfg.limiter);
  });
});

describe('hashi/real — guardian is a HINT that never breaks the loop (E-K9, G5)', () => {
  it('returns available:false instead of throwing when the guardian is unreachable', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(11).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, offlineDeps(cfg, user));

    const status = await adapter.guardian.limiterStatus();
    expect(status.source).toBe('sdk-hint');
    expect(isLimiterHintAvailable(status)).toBe(false);
    expect(status.tokens).toBe(0n);
  });

  it('returns available:false when the guardian answers but has no limiter (unprovisioned)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(11).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user),
      guardianInfo: async () => ({ limiter: null, gitRevision: 'deadbeef' }),
    });
    expect(isLimiterHintAvailable(await adapter.guardian.limiterStatus())).toBe(false);
  });

  it('projects a live reading with OUR saturating projectCapacity, not the SDK’s', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(11).toSuiAddress();
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user),
      // Fixed logical clock at 2_000_000 ms = 2000 s.
      nowMs: () => 2_000_000,
      guardianInfo: async () => ({
        limiter: {
          state: { numTokensAvailableSats: '100000', lastUpdatedAtSecs: '1000', nextSeq: '7' },
          config: { refillRateSatsPerSec: '10', maxBucketCapacitySats: '100000000' },
        },
      }),
    });

    const status = await adapter.guardian.limiterStatus();
    expect(isLimiterHintAvailable(status)).toBe(true);
    // 100_000 + (2000 - 1000) * 10 = 110_000, well under the 100_000_000 ceiling.
    expect(status.tokens).toBe(110_000n);
    expect(status.nextSeq).toBe(7n);
    expect(status.asOfSecs).toBe(2_000n);
    expect(status.source).toBe('sdk-hint');
  });

  it('parses snake_case guardian payloads too (the wire shape is UNVERIFIED — E-K9)', () => {
    const parsed = parseGuardianLimiter({
      limiter: {
        state: { num_tokens_available: '42', last_updated_at: '5', next_seq: '1' },
        config: { refill_rate: '10', max_bucket_capacity: '1000' },
      },
    });
    expect(parsed?.state.numTokensAvailableSats).toBe(42n);
    expect(parsed?.refillRate).toBe(10n);
    expect(parsed?.cap).toBe(1_000n);
    expect(parseGuardianLimiter({ limiter: null })).toBeUndefined();
    expect(parseGuardianLimiter('nonsense')).toBeUndefined();
  });

  it('canWithdraw answers from the event REPLAY, never from the guardian hint (G5/G3)', async () => {
    const cfg = testConfig({ HASHI_ADAPTER: 'real' });
    const user = testSigner(12).toSuiAddress();
    let guardianCalls = 0;
    const adapter = createRealHashiAdapter(cfg, {
      ...offlineDeps(cfg, user),
      nowMs: () => 5_000,
      guardianInfo: async () => {
        guardianCalls += 1;
        return { limiter: null };
      },
    });

    // Below the on-chain minimum: refused without touching anything.
    expect(await adapter.guardian.canWithdraw(29_999n)).toBe(false);

    // The fixture stream signs one 50_000-sat batch; capacity is the configured 100_000_000 bucket.
    expect(await adapter.guardian.canWithdraw(50_000n)).toBe(true);
    // Above the whole bucket ⇒ can never be satisfied. G3: REJECTED, not queued.
    expect(await adapter.guardian.canWithdraw(cfg.limiter.maxBucketCapacitySats + 1n)).toBe(false);

    expect(guardianCalls).toBe(0);
  });
});

describe('hashi/real — transport-shape tolerant parsing', () => {
  it('reads the digest and events from both gRPC-ish and JSON-RPC-ish result shapes', () => {
    expect(txDigestOf({ $kind: 'Transaction', Transaction: { digest: 'A' } })).toBe('A');
    expect(txDigestOf({ $kind: 'FailedTransaction', FailedTransaction: { digest: 'B' } })).toBe('B');
    expect(txDigestOf({ digest: 'C' })).toBe('C');
    expect(txDigestOf(null)).toBeUndefined();

    const core = txEventsOf({ Transaction: { events: [{ eventType: 'a::b::C', json: { x: 1 } }] } });
    expect(core[0]?.type).toBe('a::b::C');
    const jsonRpc = txEventsOf({ events: [{ type: 'a::b::C', parsedJson: { x: 1 } }] });
    expect(jsonRpc[0]?.type).toBe('a::b::C');
    const nested = txEventsOf({ Transaction: { events: { events: [{ eventType: 'a::b::C', json: {} }] } } });
    expect(nested).toHaveLength(1);
    expect(txEventsOf(undefined)).toEqual([]);
  });

  it('orders raw events by (timestampMs, txDigest, eventSeq) so two replayers agree', () => {
    const cfg = testConfig();
    const a = raw(cfg, 'deposit', 'DepositRequested', {}, 1_000, 'AAA', 0);
    const b = raw(cfg, 'deposit', 'DepositRequested', {}, 1_000, 'AAA', 1);
    const c = raw(cfg, 'deposit', 'DepositRequested', {}, 1_000, 'BBB', 0);
    const d = raw(cfg, 'deposit', 'DepositRequested', {}, 2_000, 'AAA', 0);

    const shuffled = [d, c, b, a];
    expect([...shuffled].sort(compareRawEvents)).toEqual([a, b, c, d]);
  });
});
