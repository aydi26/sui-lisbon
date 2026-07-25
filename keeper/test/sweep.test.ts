// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.4
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.3 · docs/BUILD-PLAN.md T2.4 (user needs no SUI; freshly minted
//             hBTC becomes vault shares)
// @rules      G1 G2 G7 G9
// @depends    ../src/execution/sweep.ts · ./support/fixtures.ts
// @facts      SPONSORED = two signatures over the SAME bytes: the DEPOSITOR signs (sender), the
// @facts        SPONSOR signs (gas owner). The depositor needs ZERO SUI — that is the zkLogin claim.
// @facts      vault::Deposited { vault_id, who, deposit_sats, shares_minted, nav_after_sats } is the
// @facts        share-issuance receipt; decoded from event BCS, never from `event.json`.
// @facts      No network: the transaction bytes builder and the execution core are both injected.
// @forbidden  a test that opens a network socket
// @forbidden  asserting nothing (an empty body is a failure)
// @verify     npm run test -- sweep
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import {
  buildSweepTx,
  decodeSharesMinted,
  DepositedEvent,
  findMintedCoins,
  sweep,
  type CoinRef,
  type SweepDeps,
  type SweepEvent,
  type SweepRequest,
} from '../src/execution/sweep.js';
import type { AnySuiClient } from '../src/sui/client.js';
import type { Sats, SuiAddress } from '../src/types.js';
import { AphoticError, ConfigError } from '../src/util/errors.js';

import { testConfig, testSigner } from './support/fixtures.js';

const APHOTIC_PACKAGE = `0x${'11'.repeat(32)}`;
const VAULT_ID = `0x${'22'.repeat(32)}`;

const cfg = testConfig({ APHOTIC_PACKAGE_ID: APHOTIC_PACKAGE, VAULT_ID });
const bare = testConfig(); // APHOTIC_PACKAGE_ID unset

const SPONSOR = testSigner(7);
const DEPOSITOR = testSigner(8);
const ALICE = DEPOSITOR.toSuiAddress();

const BOOK_MID = 100_000_000_000n;

const COIN_A: CoinRef = { objectId: `0x${'a1'.repeat(32)}`, sats: 300_000n };
const COIN_B: CoinRef = { objectId: `0x${'b2'.repeat(32)}`, sats: 200_000n };

function request(overrides: Partial<SweepRequest> = {}): SweepRequest {
  return {
    vaultId: VAULT_ID,
    depositRequestId: `0x${'de'.repeat(32)}`,
    recipient: ALICE,
    coins: [COIN_A],
    bookMid: BOOK_MID,
    ...overrides,
  };
}

/** A `vault::Deposited` receipt, BCS-encoded exactly as the chain emits it. */
function depositedEvent(who: SuiAddress, depositSats: Sats, sharesMinted: Sats): SweepEvent {
  return {
    eventType: `${APHOTIC_PACKAGE}::vault::Deposited`,
    bcs: DepositedEvent.serialize({
      vault_id: VAULT_ID,
      who,
      deposit_sats: depositSats,
      shares_minted: sharesMinted,
      nav_after_sats: depositSats,
    }).toBytes(),
  };
}

interface ExecutionCall {
  readonly transaction: Uint8Array;
  readonly signer: Signer;
  readonly additionalSignatures: string[];
}

/**
 * A fake `client.core` that records the sponsored execution and replays scripted events.
 * No socket is opened and no Sui client is constructed (gates.ps1 transport).
 */
function fakeClient(options: {
  events?: readonly SweepEvent[];
  failed?: boolean;
  coinPages?: readonly {
    objects: readonly { objectId: string; balance: string }[];
    hasNextPage: boolean;
    cursor: string | null;
  }[];
  listCoinsCalls?: { owner: string; coinType: string; cursor: string | null | undefined }[];
}): { client: AnySuiClient; calls: ExecutionCall[] } {
  const calls: ExecutionCall[] = [];
  let page = 0;

  const core = {
    async signAndExecuteTransaction(input: ExecutionCall & { include: { events: true } }) {
      calls.push({
        transaction: input.transaction,
        signer: input.signer,
        additionalSignatures: input.additionalSignatures,
      });
      const executed = { digest: 'SWEEPDIGEST', events: options.events ?? [] };
      return options.failed === true
        ? { $kind: 'FailedTransaction' as const, FailedTransaction: executed }
        : { $kind: 'Transaction' as const, Transaction: executed };
    },
    async listCoins(req: { owner: string; coinType: string; cursor?: string | null }) {
      options.listCoinsCalls?.push({ owner: req.owner, coinType: req.coinType, cursor: req.cursor ?? null });
      const pages = options.coinPages ?? [];
      const res = pages[page] ?? { objects: [], hasNextPage: false, cursor: null };
      page += 1;
      return res;
    },
  };

  return { client: { core } as unknown as AnySuiClient, calls };
}

function deps(client: AnySuiClient, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    cfg,
    client,
    sponsor: SPONSOR,
    depositor: DEPOSITOR,
    // Injected so the two-signature flow runs offline; production uses tx.build({client}).
    buildBytes: async () => new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/sweep — buildSweepTx: sender is the DEPOSITOR, gas owner is the SPONSOR', () => {
  it('sets the sender to the depositor and the gas owner to the sponsor (invariants 1, 5)', () => {
    const tx = buildSweepTx(cfg, request({ sponsor: SPONSOR.toSuiAddress() }));
    const data = tx.getData();

    expect(data.sender).toBe(ALICE);
    expect(data.gasData.owner).toBe(SPONSOR.toSuiAddress());
    // ★ Sponsorship changes who PAYS, never who the SENDER is.
    expect(data.sender).not.toBe(SPONSOR.toSuiAddress());
  });

  it('calls aphotic::vault::deposit_btc with [vault, coin, book_mid] and both type args', () => {
    const tx = buildSweepTx(cfg, request());
    const commands = tx.getData().commands;

    expect(commands).toHaveLength(1);
    const call = commands[0]?.MoveCall;
    expect(call?.package).toBe(APHOTIC_PACKAGE);
    expect(call?.module).toBe('vault');
    expect(call?.function).toBe('deposit_btc');
    expect(call?.typeArguments).toEqual([cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType]);
    expect(call?.arguments).toHaveLength(3);
  });

  it('merges every extra coin into the primary before depositing', () => {
    const tx = buildSweepTx(cfg, request({ coins: [COIN_A, COIN_B] }));
    const commands = tx.getData().commands;

    expect(commands).toHaveLength(2);
    expect(commands[0]?.$kind).toBe('MergeCoins');
    expect(commands[0]?.MergeCoins?.sources).toHaveLength(1);
    expect(commands[1]?.MoveCall?.function).toBe('deposit_btc');
  });

  it('passes the DeepBook mid through untouched — the caller owns valuation (G9, invariant 4)', () => {
    const inputs = buildSweepTx(cfg, request({ bookMid: 99_500_000_000n })).getData().inputs;
    const pure = inputs.filter((i) => i.$kind === 'Pure');
    expect(pure).toHaveLength(1);
    expect(bcs.u128().parse(Buffer.from(pure[0]?.Pure?.bytes ?? '', 'base64'))).toBe('99500000000');
  });

  it('refuses to build with nothing to sweep', () => {
    expect(() => buildSweepTx(cfg, request({ coins: [] }))).toThrow(AphoticError);
    expect(() => buildSweepTx(cfg, request({ coins: [] }))).toThrow(/NothingToSweep|no Coin/);
  });

  it('refuses a "sponsored" PTB whose sponsor IS the depositor', () => {
    expect(() => buildSweepTx(cfg, request({ sponsor: ALICE }))).toThrow(/distinct gas owner/);
  });

  it('refuses to build without APHOTIC_PACKAGE_ID', () => {
    expect(() => buildSweepTx(bare, request())).toThrow(ConfigError);
  });

  it('is deterministic: the same request builds byte-identical data', () => {
    const a = buildSweepTx(cfg, request({ sponsor: SPONSOR.toSuiAddress() }));
    const b = buildSweepTx(cfg, request({ sponsor: SPONSOR.toSuiAddress() }));
    expect(JSON.stringify(a.getData())).toBe(JSON.stringify(b.getData()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/sweep — findMintedCoins', () => {
  it('pages through every owned Coin<BTC> and converts balances to bigint sats', async () => {
    const calls: { owner: string; coinType: string; cursor: string | null | undefined }[] = [];
    const { client } = fakeClient({
      listCoinsCalls: calls,
      coinPages: [
        { objects: [{ objectId: '0xc1', balance: '300000' }], hasNextPage: true, cursor: 'PAGE2' },
        { objects: [{ objectId: '0xc2', balance: '200000' }], hasNextPage: false, cursor: null },
      ],
    });

    const coins = await findMintedCoins(deps(client), ALICE);

    expect(coins).toEqual([
      { objectId: '0xc1', sats: 300_000n },
      { objectId: '0xc2', sats: 200_000n },
    ]);
    expect(calls.map((c) => c.cursor)).toEqual([null, 'PAGE2']);
    expect(calls[0]?.coinType).toBe(cfg.hashi.hbtcCoinType);
    expect(calls[0]?.owner).toBe(ALICE);
  });

  it('drops zero-balance coin objects', async () => {
    const { client } = fakeClient({
      coinPages: [
        {
          objects: [
            { objectId: '0xc1', balance: '0' },
            { objectId: '0xc2', balance: '7' },
          ],
          hasNextPage: false,
          cursor: null,
        },
      ],
    });
    expect(await findMintedCoins(deps(client), ALICE)).toEqual([{ objectId: '0xc2', sats: 7n }]);
  });

  it('returns [] when the recipient owns no hBTC yet', async () => {
    const { client } = fakeClient({ coinPages: [{ objects: [], hasNextPage: false, cursor: null }] });
    expect(await findMintedCoins(deps(client), ALICE)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/sweep — decodeSharesMinted (BCS receipt, never event.json)', () => {
  it('reads shares_minted out of the vault::Deposited receipt', () => {
    expect(decodeSharesMinted([depositedEvent(ALICE, 300_000n, 300_000n)], ALICE)).toBe(300_000n);
  });

  it('ignores a Deposited belonging to someone else', () => {
    const other = testSigner(9).toSuiAddress();
    expect(decodeSharesMinted([depositedEvent(other, 300_000n, 300_000n)], ALICE)).toBeUndefined();
  });

  it('ignores foreign events entirely', () => {
    const foreign: SweepEvent = { eventType: '0xabc::other::Thing', bcs: new Uint8Array([0]) };
    expect(decodeSharesMinted([foreign], ALICE)).toBeUndefined();
  });

  it('matches on the ::vault::Deposited SUFFIX so a package upgrade cannot break it', () => {
    const upgraded: SweepEvent = {
      eventType: `0x${'99'.repeat(32)}::vault::Deposited`,
      bcs: DepositedEvent.serialize({
        vault_id: VAULT_ID,
        who: ALICE,
        deposit_sats: 1_000n,
        shares_minted: 42n,
        nav_after_sats: 1_000n,
      }).toBytes(),
    };
    expect(decodeSharesMinted([upgraded], ALICE)).toBe(42n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('execution/sweep — the sponsored execution: the user needs ZERO SUI', () => {
  it('collects BOTH signatures over the same bytes: depositor signs, sponsor pays', async () => {
    const { client, calls } = fakeClient({ events: [depositedEvent(ALICE, 500_000n, 500_000n)] });

    const result = await sweep(deps(client), request({ coins: [COIN_A, COIN_B] }));

    expect(calls).toHaveLength(1);
    const call = calls[0];
    // The DEPOSITOR is the signer of record — the sponsor only supplies an extra signature.
    expect(call?.signer.toSuiAddress()).toBe(ALICE);
    expect(call?.additionalSignatures).toHaveLength(1);

    // And that extra signature really is the sponsor's, over these exact bytes.
    const expected = await SPONSOR.signTransaction(new Uint8Array([1, 2, 3, 4]));
    expect(call?.additionalSignatures[0]).toBe(expected.signature);
    expect(call?.transaction).toEqual(new Uint8Array([1, 2, 3, 4]));

    expect(result).toEqual({
      digest: 'SWEEPDIGEST',
      sweptSats: 500_000n,
      sharesMinted: 500_000n,
      recipient: ALICE,
    });
  });

  it('issues shares 1:1 with sats on the bootstrap deposit (invariant 3)', async () => {
    const { client } = fakeClient({ events: [depositedEvent(ALICE, 300_000n, 300_000n)] });
    const result = await sweep(deps(client), request());
    expect(result.sharesMinted).toBe(result.sweptSats);
    expect(typeof result.sharesMinted).toBe('bigint');
  });

  it('resolves the coins itself when the request does not carry them', async () => {
    const { client } = fakeClient({
      events: [depositedEvent(ALICE, 900_000n, 900_000n)],
      coinPages: [
        {
          objects: [
            { objectId: '0xc1', balance: '400000' },
            { objectId: '0xc2', balance: '500000' },
          ],
          hasNextPage: false,
          cursor: null,
        },
      ],
    });

    const result = await sweep(deps(client), request({ coins: undefined }));
    expect(result.sweptSats).toBe(900_000n);
    expect(result.sharesMinted).toBe(900_000n);
  });

  it('refuses to sweep without the depositor\'s signature — the sponsor is NOT a stand-in (G2)', async () => {
    const { client, calls } = fakeClient({ events: [depositedEvent(ALICE, 1n, 1n)] });
    await expect(sweep(deps(client, { depositor: undefined }), request())).rejects.toThrow(
      /must be signed by the DEPOSITOR/,
    );
    expect(calls).toHaveLength(0);
  });

  it('raises when the PTB emitted no share receipt', async () => {
    const { client } = fakeClient({ events: [] });
    await expect(sweep(deps(client), request())).rejects.toThrow(/SweepReceiptMissing|emitted no/);
  });

  it('raises when the PTB failed on chain', async () => {
    const { client } = fakeClient({ events: [], failed: true });
    await expect(sweep(deps(client), request())).rejects.toThrow(/failed on chain/);
  });

  it('the built PTB never names the sponsor except as gas owner (G2)', async () => {
    const tx: Transaction = buildSweepTx(cfg, request({ sponsor: SPONSOR.toSuiAddress() }));
    const json = JSON.stringify(tx.getData());
    const sponsorMentions = json.split(SPONSOR.toSuiAddress()).length - 1;
    expect(sponsorMentions).toBe(1); // gasData.owner, and nowhere else
    expect(tx.getData().gasData.owner).toBe(SPONSOR.toSuiAddress());
  });
});
