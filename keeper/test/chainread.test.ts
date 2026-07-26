// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.context
// @phase      2
// @status     DONE
// @spec       ../src/vault/context.ts — the read plumbing every on-chain command shares
// @rules      G7 G10
// @ac         type parsing is total · decoders refuse a missing value · a reverted read raises
// @verify     npm run test -- chainread
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import { PreflightRevertError } from '../src/sui/send.js';
import {
  decodeAddress,
  decodeBool,
  decodeBytes,
  decodeU64,
  decodeU8,
  inspect,
  normalizeId,
  parseStructType,
  readVaultTypeArgs,
  returnValue,
} from '../src/vault/context.js';

import { addressBcs, boolBcs, fakeClient, id, testConfig, u64, u8, vecU8 } from './support/chain.js';

const PKG = id('a');
const VAULT = id('b');

describe('vault/context — struct type parsing is TOTAL, never a guess', () => {
  it('splits a plain struct tag', () => {
    const p = parseStructType('0x2::coin::Coin');
    expect(p).toMatchObject({ address: '0x2', module: 'coin', name: 'Coin', typeArgs: [] });
  });

  it('splits NESTED type arguments — a naive split(",") breaks exactly here', () => {
    const p = parseStructType(`${PKG}::vault::Vault<0x2::coin::Coin<0x2::sui::SUI>, 0x3::q::Q, 0x4::s::S>`);
    expect(p.typeArgs).toEqual(['0x2::coin::Coin<0x2::sui::SUI>', '0x3::q::Q', '0x4::s::S']);
  });

  it('rejects a tag that is not fully qualified rather than inventing parts', () => {
    expect(() => parseStructType('coin::Coin')).toThrow(/fully qualified/);
    expect(() => parseStructType('0x2::coin::Coin<0x2::sui::SUI')).toThrow(/unbalanced/);
  });

  it('normalizes ids canonically, so 0x2 and its padded form compare equal', () => {
    expect(normalizeId('0x2')).toBe(normalizeId(`0x${'0'.repeat(63)}2`));
    expect(() => normalizeId('0xzz')).toThrow(/not a hex object id/);
  });
});

describe('vault/context — decoders refuse rather than substitute', () => {
  it('decodes every scalar the read surface returns', () => {
    expect(decodeU64(u64(42n), 'x')).toBe(42n);
    expect(decodeU8(u8(3), 'x')).toBe(3);
    expect(decodeBool(boolBcs(true), 'x')).toBe(true);
    expect(Array.from(decodeBytes(vecU8(Uint8Array.of(1, 2, 3)), 'x'), Number)).toEqual([1, 2, 3]);
    expect(decodeAddress(addressBcs(VAULT), 'x')).toBe(VAULT);
  });

  it('a missing command result is an error, NOT a zero', () => {
    expect(() => returnValue([], 0, 'vault::idle_sats')).toThrow(/no result for command 0/);
    expect(() => returnValue([[]], 0, 'vault::idle_sats')).toThrow(/returned no values/);
  });
});

describe('vault/context — a reverted read raises and returns nothing', () => {
  it('surfaces a simulation failure as PreflightRevertError', async () => {
    const { client } = fakeClient({ revert: 'EBadState' });
    const deps = { cfg: testConfig(), client };
    await expect(inspect(deps, new Transaction(), 'a read')).rejects.toBeInstanceOf(
      PreflightRevertError,
    );
  });
});

describe('vault/context — type arguments are DISCOVERED off the vault, not configured', () => {
  const deps = (type: string) => ({
    cfg: testConfig(),
    client: fakeClient({ objects: [{ objectId: VAULT, type }] }).client,
  });

  it('reads [B, Q, S] from the object type', async () => {
    const args = await readVaultTypeArgs(
      deps(`${PKG}::vault::Vault<0x1::b::B, 0x2::q::Q, 0x3::s::S>`),
      PKG,
      VAULT,
    );
    expect(args).toEqual(['0x1::b::B', '0x2::q::Q', '0x3::s::S']);
  });

  it('refuses an object that is not a vault::Vault', async () => {
    await expect(readVaultTypeArgs(deps(`${PKG}::batch::Batch`), PKG, VAULT)).rejects.toThrow(
      /not a vault::Vault/,
    );
  });

  it('refuses a vault published by a DIFFERENT package — different deployments never mix', async () => {
    await expect(
      readVaultTypeArgs(deps(`${id('c')}::vault::Vault<0x1::b::B, 0x2::q::Q, 0x3::s::S>`), PKG, VAULT),
    ).rejects.toThrow(/different deployments/);
  });
});
