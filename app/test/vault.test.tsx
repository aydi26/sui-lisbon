// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §6.2 (NAV: two PARTIES, not two scopes), §7.7 (the legs
//             and the honest gap), §1 (async request/settle)
// @spec       docs/DESIGN-V2.md §6 (approve_nav prices BOTH legs at one price)
// @spec       move/sources/vault.move — `mul_div`, `proposal_digest`,
//             `claim_deposit`, `claim_redeem`, `NavProposal` field order
// @rules      G7 G8 G10
// @depends    ../src/lib/vault.ts (F2) · ../src/lib/moveRead.ts (F2)
//             · ../src/screens/vault/** (F2) · ../vitest.config.ts (env pins)
// @facts      vitest.config.ts pins every id-bearing VITE_* to '', so this suite
// @facts        runs the WORST configuration — a build that shipped without them.
// @facts        That is what makes the NotWiredError cases the DEFAULT here rather
// @facts        than an edge case, and it is why the decode tests re-import the
// @facts        module under `vi.stubEnv` instead of relying on ambient wiring.
// @facts      THE ROUNDING TWIN IS THE POINT OF THE PREVIEW. `claim_deposit` runs
// @facts        `mul_div(assets, nav_supply, nav_assets)` and `claim_redeem` runs
// @facts        `mul_div(shares, nav_assets, nav_supply)`, BOTH rounding down.
// @facts        Round-down is subadditive, so Σ per-receipt ≤ the epoch total: the
// @facts        dust stays with the vault and never with a claimant. A preview that
// @facts        rounded up would promise sats the contract will not pay.
// @facts      THE DIGEST IS THE ADMIN'S COMMITMENT. `proposal_digest` is
// @facts        `blake2b256(bcs(NavProposal))` over TEN fields in DECLARATION
// @facts        order — BCS has no names, so a reordered field is a different
// @facts        digest and the browser's recomputation would stop matching.
// @facts      ⚠ NOTHING READS ON MOUNT. The screen assertions below drive a fetch
// @facts        spy that REJECTS, so any mount-time request fails the suite
// @facts        loudly rather than passing quietly against a live node.
// @implements the /vault safety net: the rounding twin, the digest twin, the
//             not-wired guards, and the screen's honesty invariants
// @forbidden  a network call from any test — the fetch spy rejects
// @forbidden  asserting a number the reader did not decode from injected bytes
// @invariant  1. The TS preview never exceeds what Move would pay (round-down).
//             2. Every reader refuses BEFORE the wire when an id is unwired.
//             3. The deposit control says "Request", never "Deposit".
//             4. The native-BTC leg is annotated as unverifiable AND capped.
// @ac         cd app && npm test -- vault
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { bcs } from '@mysten/sui/bcs';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config';
import { NotWiredError, decode, objectTypeArgs } from '../src/lib/moveRead';
import {
  assetsForShares,
  buildClaimDeposit,
  buildClaimRedeem,
  buildRequestDeposit,
  buildRequestRedeem,
  listReceipts,
  proposalDigest,
  proposalNavAssets,
  readEpochPrice,
  readEscrowOf,
  readProposal,
  readVaultSnapshot,
  readVaultTypeArgs,
  sharesForAssets,
  totalBalance,
} from '../src/lib/vault';
import NavPanel from '../src/screens/vault/NavPanel';
import PositionPanel from '../src/screens/vault/PositionPanel';
import VaultScreen from '../src/screens/vault/VaultScreen';

// ── the rounding twin ───────────────────────────────────────────────────────
// move/sources/vault.move:
//   fun mul_div(a, b, c) = ((a as u128) * (b as u128)) / (c as u128)
// Move integer division truncates, and BigInt division truncates toward zero.
// For non-negative operands those are the same operation, which is the whole
// reason the twin can be exact rather than approximate.

function moveMulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

describe('the claim preview is the contract’s own arithmetic', () => {
  it('shares = mul_div(assets, nav_supply, nav_assets), truncating', () => {
    // 7 assets at a price of 3 assets per 1 share pays 2 shares and keeps 1.
    expect(sharesForAssets(7n, 3n, 1n)).toBe(2n);
    expect(sharesForAssets(7n, 3n, 1n)).toBe(moveMulDiv(7n, 1n, 3n));
  });

  it('assets = mul_div(shares, nav_assets, nav_supply), truncating', () => {
    expect(assetsForShares(7n, 1n, 3n)).toBe(2n);
    expect(assetsForShares(7n, 1n, 3n)).toBe(moveMulDiv(7n, 1n, 3n));
  });

  it('agrees with mul_div on a spread of awkward, dust-producing vectors', () => {
    const vectors: readonly (readonly [bigint, bigint, bigint])[] = [
      [1n, 3n, 1n],
      [999_999n, 1_000_000n, 999_999n],
      [1_000_000n, 999_999n, 1_000_001n],
      [123_456_789n, 987_654_321n, 1_000_000_007n],
      [30_000n, 7n, 3n],
      [100_000_000n, 100_000_001n, 100_000_003n],
    ];
    for (const [amount, navAssets, navSupply] of vectors) {
      expect(sharesForAssets(amount, navAssets, navSupply)).toBe(
        moveMulDiv(amount, navSupply, navAssets),
      );
      expect(assetsForShares(amount, navAssets, navSupply)).toBe(
        moveMulDiv(amount, navAssets, navSupply),
      );
    }
  });

  it('is SUBADDITIVE, so Σ per-receipt claims can never exceed the epoch total', () => {
    // @invariant 5 of vault.move, restated as a property: rounding DOWN per
    // receipt means the dust the split creates stays with the vault. If this
    // ever flipped, the preview would promise sats claim_deposit will not pay.
    const navAssets = 1_000_000_007n;
    const navSupply = 999_999_937n;
    const receipts = [333_333n, 666_667n, 1n, 999_999n, 7n];
    const total = receipts.reduce((a, b) => a + b, 0n);
    const perReceipt = receipts
      .map((r) => sharesForAssets(r, navAssets, navSupply))
      .reduce((a, b) => a + b, 0n);
    expect(perReceipt).toBeLessThanOrEqual(sharesForAssets(total, navAssets, navSupply));
  });

  it('answers zero rather than dividing by zero on an unpriced epoch', () => {
    expect(sharesForAssets(1_000n, 0n, 5n)).toBe(0n);
    expect(assetsForShares(1_000n, 5n, 0n)).toBe(0n);
  });

  it('stays exact past 2^53, where a number-typed twin would silently drift', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(sharesForAssets(big, 1n, 1n)).toBe(big);
    // The same value through `number` does not round-trip: it lands on 2^53.
    // A `number`-typed preview would quietly lose that sat, and 21e14 sats of
    // supply sits well inside u64 — this is a reachable amount, not a limit case.
    expect(BigInt(Number(big))).not.toBe(big);
    expect(BigInt(Number(big))).toBe(9_007_199_254_740_992n);
  });

  it('sums coin rows as bigint', () => {
    expect(
      totalBalance([
        { objectId: '0x1', balance: 1_000_000n },
        { objectId: '0x2', balance: 2_500_000n },
      ]),
    ).toBe(3_500_000n);
    expect(totalBalance([])).toBe(0n);
  });
});

// ── the digest twin ─────────────────────────────────────────────────────────

const PROPOSAL = {
  epoch: 4n,
  idleSats: 1_000_000n,
  deployedSats: 250_000n,
  inFlightSats: 30_000n,
  nativeBtcSats: 70_000n,
  hashiClaimsSats: 70_000n,
  clearingPrice: 0n,
  bookMid: 0n,
  proposedAtMs: 1_780_000_000_000n,
  proposer: `0x${'ab'.repeat(32)}`,
} as const;

describe('the NAV digest recomputed in the browser', () => {
  it('is 32 bytes and deterministic', () => {
    const a = proposalDigest(PROPOSAL);
    expect(a).toHaveLength(32);
    expect([...proposalDigest(PROPOSAL)]).toEqual([...a]);
  });

  it('changes when ANY of the ten signed fields changes', () => {
    // BCS has no field names: the digest is a commitment to these exact bytes
    // in this exact order, which is what stops a keeper swapping numbers in
    // between the multisig's signature and the transaction.
    const base = proposalDigest(PROPOSAL).join(',');
    const mutations: readonly (typeof PROPOSAL)[] = [
      { ...PROPOSAL, epoch: 5n },
      { ...PROPOSAL, idleSats: 1_000_001n },
      { ...PROPOSAL, deployedSats: 250_001n },
      { ...PROPOSAL, inFlightSats: 30_001n },
      { ...PROPOSAL, nativeBtcSats: 70_001n },
      { ...PROPOSAL, hashiClaimsSats: 70_001n },
      { ...PROPOSAL, clearingPrice: 1n },
      { ...PROPOSAL, bookMid: 1n },
      { ...PROPOSAL, proposedAtMs: 1_780_000_000_001n },
      { ...PROPOSAL, proposer: `0x${'cd'.repeat(32)}` },
    ];
    for (const m of mutations) {
      expect(proposalDigest(m).join(',')).not.toBe(base);
    }
    expect(mutations).toHaveLength(10);
  });

  it('does NOT commit to the leg total — the total is derived, not signed', () => {
    // nav_assets_of() is computed from the four legs; it is not a field of
    // NavProposal, so the browser sums it itself rather than trusting a number.
    expect(proposalNavAssets(PROPOSAL)).toBe(1_350_000n);
    expect(proposalNavAssets(PROPOSAL)).toBe(
      PROPOSAL.idleSats + PROPOSAL.deployedSats + PROPOSAL.inFlightSats + PROPOSAL.nativeBtcSats,
    );
  });

  it('keeps the honest cap satisfiable: native BTC ≤ the on-Sui claim', () => {
    // §7.7 mitigation 2 is an assert in Move (ENavLegUncapped), so the fixture
    // the panel renders must itself be a proposal approve_nav would accept.
    expect(PROPOSAL.nativeBtcSats).toBeLessThanOrEqual(PROPOSAL.hashiClaimsSats);
  });
});

// ── every reader refuses before the wire ────────────────────────────────────

describe('an unwired build refuses BEFORE any network call', () => {
  const simulate = vi.fn(() => Promise.resolve([] as never[]));
  const objectType = vi.fn(() => Promise.resolve('irrelevant'));
  const ownedObjects = vi.fn(() => Promise.resolve([]));

  beforeEach(() => {
    simulate.mockClear();
    objectType.mockClear();
    ownedObjects.mockClear();
  });

  it('the suite really is running the worst configuration', () => {
    expect(config.aphotic.packageId).toBe('');
    expect(config.aphotic.vaultId).toBe('');
  });

  it('readVaultTypeArgs throws NotWiredError naming VITE_VAULT_ID', async () => {
    await expect(readVaultTypeArgs({ objectType })).rejects.toBeInstanceOf(NotWiredError);
    await expect(readVaultTypeArgs({ objectType })).rejects.toThrow(/VITE_VAULT_ID/);
    expect(objectType).not.toHaveBeenCalled();
  });

  const TYPE_ARGS = ['0x2::b::B', '0x2::q::Q', '0x2::s::S'] as const;

  it('readVaultSnapshot / readProposal / readEpochPrice / readEscrowOf all refuse', async () => {
    await expect(readVaultSnapshot(TYPE_ARGS, { simulate })).rejects.toBeInstanceOf(NotWiredError);
    await expect(readProposal(TYPE_ARGS, { simulate })).rejects.toBeInstanceOf(NotWiredError);
    await expect(readEpochPrice(TYPE_ARGS, 0n, { simulate })).rejects.toBeInstanceOf(NotWiredError);
    await expect(readEscrowOf(TYPE_ARGS, '0x1', { simulate })).rejects.toBeInstanceOf(
      NotWiredError,
    );
    expect(simulate).not.toHaveBeenCalled();
  });

  it('listReceipts names the ORIGINAL package id, which is what types resolve against', async () => {
    // A struct type is pinned to the original package forever; only a moveCall
    // target follows an upgrade. So the missing var here is the original id.
    await expect(listReceipts('0x1', { ownedObjects })).rejects.toThrow(
      /VITE_APHOTIC_ORIGINAL_PACKAGE_ID/,
    );
    expect(ownedObjects).not.toHaveBeenCalled();
  });

  it('every PTB builder refuses too, so no unsendable transaction is ever built', async () => {
    const { Transaction } = await import('@mysten/sui/transactions');
    const args = { typeArgs: TYPE_ARGS, sender: `0x${'1'.repeat(64)}` } as const;
    expect(() =>
      buildRequestDeposit(new Transaction(), { ...args, sats: 1_000_000n, coinIds: ['0xc0'] }),
    ).toThrow(NotWiredError);
    expect(() =>
      buildRequestRedeem(new Transaction(), { ...args, shares: 1_000_000n, coinIds: ['0xc0'] }),
    ).toThrow(NotWiredError);
    expect(() => buildClaimDeposit(new Transaction(), { ...args, receiptId: '0xr' })).toThrow(
      NotWiredError,
    );
    expect(() => buildClaimRedeem(new Transaction(), { ...args, receiptId: '0xr' })).toThrow(
      NotWiredError,
    );
  });
});

// ── the snapshot decodes from injected bytes ────────────────────────────────
// Re-imported under a stubbed environment so the reader runs its REAL decode
// path — the alternative is asserting numbers nothing decoded, which is the
// thing this app refuses to do on screen and so refuses to do here.

const U64 = bcs.u64();
const BOOL = bcs.bool();
const BYTES = bcs.vector(bcs.u8());

describe('the vault snapshot decodes the accessors it asked for', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function wiredVault() {
    vi.stubEnv('VITE_APHOTIC_PACKAGE_ID', `0x${'11'.repeat(32)}`);
    vi.stubEnv('VITE_APHOTIC_ORIGINAL_PACKAGE_ID', `0x${'11'.repeat(32)}`);
    vi.stubEnv('VITE_VAULT_ID', `0x${'22'.repeat(32)}`);
    vi.resetModules();
    return (await import('../src/lib/vault')) as typeof import('../src/lib/vault');
  }

  it('maps each command result onto its named field, keeping u64 as bigint', async () => {
    const mod = await wiredVault();
    let commandCount = 0;
    // One command per accessor, in SNAPSHOT order. The values are positional,
    // so a shifted mapping is exactly the bug this test is here to catch: the
    // sentinel below makes epoch and idle distinguishable from everything else.
    const simulate = vi.fn(async (tx) => {
      commandCount = tx.getData().commands.length;
      return Array.from({ length: commandCount }, (_, i) => {
        if (i === 16 || i === 17) return [BOOL.serialize(i === 17).toBytes()]; // is_paused, has_proposal
        if (i === 25) return [BYTES.serialize([1, 2, 3]).toBytes()]; // note_root
        return [U64.serialize(BigInt(i) * 1_000n).toBytes()];
      });
    });

    const snap = await mod.readVaultSnapshot(['0x2::b::B', '0x2::q::Q', '0x2::s::S'], {
      simulate: simulate as never,
      nowMs: 1_700_000_000_000,
    });

    expect(commandCount).toBe(29);
    expect(snap.epoch).toBe(0n); // accessor 0 — vault_epoch
    expect(snap.committedSupply).toBe(1_000n); // accessor 1
    expect(snap.idleSats).toBe(4_000n); // accessor 4
    expect(snap.nativeBtcSats).toBe(10_000n); // accessor 10
    expect(snap.hashiClaimsSats).toBe(11_000n); // accessor 11
    expect(snap.paused).toBe(false);
    expect(snap.hasProposal).toBe(true);
    expect([...snap.noteRoot]).toEqual([1, 2, 3]);
    expect(typeof snap.idleSats).toBe('bigint');
    expect(snap.readAtMs).toBe(1_700_000_000_000);
  });

  it('reads the vault’s THREE type parameters off the live object, never guessing S', async () => {
    const mod = await wiredVault();
    const type = `0x11::vault::Vault<0xf::btc::BTC, 0xd::dbusdc::DBUSDC, 0x11::aphotic_lp::APHOTIC_LP>`;
    const args = await mod.readVaultTypeArgs({ objectType: async () => type });
    expect(args).toEqual([
      '0xf::btc::BTC',
      '0xd::dbusdc::DBUSDC',
      '0x11::aphotic_lp::APHOTIC_LP',
    ]);
  });

  it('refuses an object that is not a Vault<B, Q, S> rather than mis-typing a call', async () => {
    const mod = await wiredVault();
    await expect(
      mod.readVaultTypeArgs({ objectType: async () => '0x11::batch::BatchRegistry' }),
    ).rejects.toThrow(/expected 3/);
  });

  it('sorts receipts by epoch and keeps both legs distinguishable', async () => {
    const mod = await wiredVault();
    const address = (b: number) => `0x${b.toString(16).padStart(2, '0').repeat(32)}`;
    const depositBcs = bcs.struct('DepositReceipt', {
      id: bcs.Address,
      vaultId: bcs.Address,
      epoch: bcs.u64(),
      requester: bcs.Address,
      assetsSats: bcs.u64(),
    });
    const redeemBcs = bcs.struct('RedeemReceipt', {
      id: bcs.Address,
      vaultId: bcs.Address,
      epoch: bcs.u64(),
      requester: bcs.Address,
      shares: bcs.u64(),
    });
    const rows = await mod.listReceipts(address(1), {
      ownedObjects: async (_owner, type) =>
        type.endsWith('DepositReceipt')
          ? [
              {
                objectId: address(0xaa),
                content: depositBcs
                  .serialize({
                    id: address(0xaa),
                    vaultId: address(0x22),
                    epoch: 3n,
                    requester: address(1),
                    assetsSats: 1_000_000n,
                  })
                  .toBytes(),
              },
            ]
          : [
              {
                objectId: address(0xbb),
                content: redeemBcs
                  .serialize({
                    id: address(0xbb),
                    vaultId: address(0x22),
                    epoch: 1n,
                    requester: address(1),
                    shares: 500n,
                  })
                  .toBytes(),
              },
            ],
    });
    expect(rows.map((r) => r.kind)).toEqual(['redeem', 'deposit']); // epoch 1 before epoch 3
    expect(rows[0]!.epoch).toBe(1n);
    expect(rows[0]!.amount).toBe(500n);
    expect(rows[1]!.amount).toBe(1_000_000n);
  });
});

// ── the decoders and the type-arg splitter ──────────────────────────────────

describe('the read primitives the vault screen depends on', () => {
  it('splits generic parameters at the TOP level only', () => {
    expect(objectTypeArgs('0x1::vault::Vault<0x2::coin::Coin<0x3::a::B>, 0x4::c::D>')).toEqual([
      '0x2::coin::Coin<0x3::a::B>',
      '0x4::c::D',
    ]);
    expect(objectTypeArgs('0x1::batch::BatchRegistry')).toEqual([]);
  });

  it('never narrows a u64 to number', () => {
    const max = 18_446_744_073_709_551_615n;
    expect(decode.u64(U64.serialize(max).toBytes())).toBe(max);
    expect(typeof decode.u64(U64.serialize(0n).toBytes())).toBe('bigint');
  });
});

// ── the screen’s honesty invariants ─────────────────────────────────────────

const { networkConfig } = createNetworkConfig({
  testnet: { network: 'testnet', url: config.sui.jsonRpcUrl },
});

function renderVault(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>,
  );
}

describe('the /vault screen, unconfigured and signed out', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error('the network is down')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders without a wallet and fires nothing on mount', () => {
    const { container } = renderVault(<VaultScreen />);
    expect((container.textContent ?? '').length).toBeGreaterThan(1_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says REQUEST and never DEPOSIT on the entry control', () => {
    // Funds enter; shares are not minted until the admin multisig approves a
    // price. "Deposit" would name an outcome the transaction does not produce.
    const { container } = renderVault(<PositionPanel />);
    const labels = Array.from(container.querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').trim().toLowerCase(),
    );
    expect(labels).toContain('request');
    expect(labels.some((l) => l === 'deposit' || l === 'redeem')).toBe(false);
  });

  it('offers no free-form amount field — the ladder is the only size control', () => {
    const { container } = renderVault(<PositionPanel />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('leaves every chain-touching control disabled, each next to a stated reason', () => {
    const { container } = renderVault(<VaultScreen />);
    for (const button of Array.from(container.querySelectorAll('button:not([disabled])'))) {
      const label = (button.textContent ?? '').toLowerCase();
      expect(
        /request|claim|read from chain|approve|settle/.test(label),
        `enabled control "${button.textContent}" would touch chain while unwired`,
      ).toBe(false);
    }
    expect(container.textContent ?? '').toMatch(/VITE_VAULT_ID|VITE_APHOTIC_PACKAGE_ID/);
  });

  it('shows nothing numeric before a read: no epoch, no balance, no receipts', () => {
    const text = renderVault(<PositionPanel />).container.textContent ?? '';
    expect(text).toMatch(/Nothing here reads on load/i);
    expect(text).not.toMatch(/Shares held/);
    expect(text).not.toMatch(/This epoch, so far/);
  });

  it('states NAV as two PARTIES rather than two scopes of one key', () => {
    const text = renderVault(<NavPanel />).container.textContent ?? '';
    expect(text).toMatch(/proposal/i);
    expect(text).toMatch(/approval/i);
    expect(text).toMatch(/two\s+parties/i);
    expect(text).toMatch(/not two scopes/i);
  });

  it('never presents the native-BTC leg as verified', () => {
    const text = renderVault(<VaultScreen />).container.textContent ?? '';
    expect(text).toMatch(/not readable by Move|not verifiable by Move/i);
    expect(text).toMatch(/capped|cap/i);
    expect(text).not.toMatch(/fully reconstructible NAV\b(?!.*Do not)/);
  });

  it('carries the countdown to the next 06:00 / 18:00 UTC boundary', () => {
    const text = renderVault(<VaultScreen />).container.textContent ?? '';
    expect(text).toMatch(/06:00 and 18:00 UTC/);
    expect(text).toMatch(/display only/i);
  });

  it('refuses to claim the carry is running', () => {
    const text = renderVault(<VaultScreen />).container.textContent ?? '';
    expect(text).toMatch(/We are not demonstrating the carry/i);
    expect(text).toMatch(/we deployed/i);
  });
});
