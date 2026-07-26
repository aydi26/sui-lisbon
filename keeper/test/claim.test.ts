// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.claim
// @phase      2
// @status     DONE
// @spec       ../src/vault/receipts.ts · ../src/vault/claim.ts
// @spec       move/sources/vault.move (`claim_deposit` / `claim_redeem`, `epoch < v.epoch`)
// @spec       aphotic.md §9 (liveness is not a privilege)
// @rules      G2 G10
// @ac         only priced receipts are claimed · a foreign vault is skipped · proceeds go to the
//             receipt's requester, never the sender · nothing is broadcast when nothing is due
// @verify     npm run test -- claim
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { describe, expect, it } from 'vitest';

import { buildClaimTx, chunk, runClaim } from '../src/vault/claim.js';
import {
  claimable,
  decodeReceipt,
  receiptType,
  RECEIPT_BCS_LEN,
  type Receipt,
} from '../src/vault/receipts.js';

import { boolBcs, commandKinds, fakeClient, id, moveCalls, testConfig, testSigner, u64 } from './support/chain.js';

const PKG = id('a');
const VAULT = id('b');
const REGISTRY = id('c');
const OTHER_VAULT = id('e');
const ALICE = id('1');
const D = { packageId: PKG, vaultId: VAULT, registryId: REGISTRY };
const TYPE_ARGS = ['0x1::b::B', '0x2::q::Q', '0x3::s::S'] as const;

const RECEIPT = bcs.struct('Receipt', {
  id: bcs.Address,
  vault_id: bcs.Address,
  epoch: bcs.u64(),
  requester: bcs.Address,
  amount: bcs.u64(),
});

const encodeReceipt = (objectId: string, vaultId: string, epoch: bigint, requester: string): Uint8Array =>
  RECEIPT.serialize({ id: objectId, vault_id: vaultId, epoch, requester, amount: 1_000n }).toBytes();

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  kind: 'deposit',
  objectId: id('7'),
  vaultId: VAULT,
  epoch: 3n,
  requester: ALICE,
  amount: 1_000n,
  ...over,
});

describe('vault/receipts — decoding refuses a struct that changed shape', () => {
  it('decodes the fixed 112-byte layout', () => {
    const bytes = encodeReceipt(id('7'), VAULT, 3n, ALICE);
    expect(bytes).toHaveLength(RECEIPT_BCS_LEN);
    const r = decodeReceipt('deposit', id('7'), bytes);
    expect(r).toMatchObject({ vaultId: VAULT, epoch: 3n, requester: ALICE, amount: 1_000n });
  });

  it('★ refuses a short buffer rather than reading a misaligned epoch', () => {
    expect(() => decodeReceipt('deposit', id('7'), new Uint8Array(64))).toThrow(
      /changed shape; regenerate this decoder/,
    );
  });

  it('names the two receipt types off the package id, never a literal', () => {
    expect(receiptType(PKG, 'deposit')).toBe(`${PKG}::vault::DepositReceipt`);
    expect(receiptType(PKG, 'redeem')).toBe(`${PKG}::vault::RedeemReceipt`);
  });
});

describe('vault/receipts — only PRICED receipts of THIS vault are claimable', () => {
  it('keeps epoch < vaultEpoch and drops the current epoch', () => {
    const rows = [receipt({ epoch: 3n }), receipt({ epoch: 4n, objectId: id('8') })];
    expect(claimable(rows, 4n, VAULT).map((r) => r.epoch)).toEqual([3n]);
  });

  it('drops a receipt belonging to a different vault — claim_deposit aborts EVaultMismatch', () => {
    const rows = [receipt({ vaultId: OTHER_VAULT })];
    expect(claimable(rows, 9n, VAULT)).toHaveLength(0);
  });
});

describe('vault/claim — proceeds go to the RECEIPT’s requester, never the sender', () => {
  it('emits claim + transfer per receipt, in that order', () => {
    const tx = buildClaimTx(D, TYPE_ARGS, [
      receipt({ kind: 'deposit', objectId: id('7') }),
      receipt({ kind: 'redeem', objectId: id('8') }),
    ]);
    expect(commandKinds(tx)).toEqual([
      'MoveCall',
      'TransferObjects',
      'MoveCall',
      'TransferObjects',
    ]);
    expect(moveCalls(tx).map((c) => c.target)).toEqual([
      `${PKG}::vault::claim_deposit`,
      `${PKG}::vault::claim_redeem`,
    ]);
  });

  it('carries no capability: vault + receipt, and nothing else', () => {
    const calls = moveCalls(buildClaimTx(D, TYPE_ARGS, [receipt()]));
    expect(calls[0]?.argumentKinds).toEqual(['UnresolvedObject', 'UnresolvedObject']);
  });

  it('chunks a long list without dropping or duplicating a receipt', () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    expect(chunk(items, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(() => chunk(items, 0)).toThrow(/chunk size must be >= 1/);
  });
});

describe('vault/claim — the crank, offline', () => {
  const vaultReturns = (epoch: bigint): Uint8Array[][] => [
    [u64(epoch)],
    ...Array.from({ length: 12 }, () => [u64(0n)]),
    [boolBcs(false)],
  ];

  it('★ nothing due ⇒ nothing broadcast, and the numbers behind that are reported', async () => {
    const signer = testSigner();
    const owner = signer.toSuiAddress();
    const { client, sent } = fakeClient({
      simulations: [vaultReturns(3n)],
      owned: {
        [owner]: [
          {
            objectId: id('7'),
            type: receiptType(PKG, 'deposit'),
            content: encodeReceipt(id('7'), VAULT, 3n, ALICE),
          },
        ],
      },
    });

    const report = await runClaim({ cfg: testConfig(), client }, D, {
      signer,
      typeArgs: TYPE_ARGS,
      owner,
    });

    expect(report.scanned).toBe(1);
    expect(report.claimable).toHaveLength(0);
    expect(report.broadcast).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('claims a priced receipt and settles it to its own requester', async () => {
    const signer = testSigner();
    const owner = signer.toSuiAddress();
    const { client, sent } = fakeClient({
      simulations: [vaultReturns(9n), []],
      owned: {
        [owner]: [
          {
            objectId: id('7'),
            type: receiptType(PKG, 'deposit'),
            content: encodeReceipt(id('7'), VAULT, 3n, ALICE),
          },
        ],
      },
    });

    const report = await runClaim({ cfg: testConfig(), client }, D, {
      signer,
      typeArgs: TYPE_ARGS,
      owner,
    });

    expect(report.claimable.map((r) => r.requester)).toEqual([ALICE]);
    expect(sent).toHaveLength(1);
    expect(commandKinds(sent[0] as never)).toEqual(['MoveCall', 'TransferObjects']);
  });
});
