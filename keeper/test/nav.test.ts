// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.nav
// @phase      2
// @status     DONE
// @spec       ../src/nav/propose.ts · move/sources/vault.move (`propose_nav` / `approve_nav`)
// @spec       docs/DESIGN-V2.md §6 §7 (INV-C1) · aphotic.md §7 (two PARTIES, not two scopes)
// @rules      G2 G9 G10
// @ac         the PTB has no address argument · an unapprovable proposal is refused before
//             broadcast · the digest is read back from chain, never recomputed
// @verify     npm run test -- nav
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  assertApprovable,
  buildProposeNavTx,
  navAssetsOf,
  resolveNavInputs,
  runPropose,
} from '../src/nav/propose.js';
import type { VaultState } from '../src/vault/read.js';

import { boolBcs, fakeClient, id, moveCalls, testConfig, testSigner, u64, vecU8 } from './support/chain.js';

const PKG = id('a');
const VAULT = id('b');
const REGISTRY = id('c');
const CAP = id('f');
const D = { packageId: PKG, vaultId: VAULT, registryId: REGISTRY };
const TYPE_ARGS = ['0x1::b::B', '0x2::q::Q', '0x3::s::S'] as const;

const state = (over: Partial<VaultState> = {}): VaultState => ({
  epoch: 4n,
  idleSats: 1_000n,
  deployedSats: 2_000n,
  inFlightSats: 300n,
  nativeBtcSats: 400n,
  hashiClaimsSats: 500n,
  claimableSats: 0n,
  committedSupply: 10n,
  unmintedShares: 0n,
  pendingDepositAssets: 0n,
  pendingRedeemShares: 0n,
  lastNavAssets: 3_700n,
  lastNavSupply: 10n,
  hasProposal: false,
  ...over,
});

/** The fourteen `GETTERS` of ../src/vault/read.ts, in order. */
const vaultReturns = (s: VaultState): Uint8Array[][] => [
  [u64(s.epoch)],
  [u64(s.idleSats)],
  [u64(s.deployedSats)],
  [u64(s.inFlightSats)],
  [u64(s.nativeBtcSats)],
  [u64(s.hashiClaimsSats)],
  [u64(s.claimableSats)],
  [u64(s.committedSupply)],
  [u64(s.unmintedShares)],
  [u64(s.pendingDepositAssets)],
  [u64(s.pendingRedeemShares)],
  [u64(s.lastNavAssets)],
  [u64(s.lastNavSupply)],
  [boolBcs(s.hasProposal)],
];

describe('nav — the five balance-sheet legs come from the chain', () => {
  it('defaults every leg to the vault, and both price references to 0', () => {
    const inputs = resolveNavInputs(state());
    expect(inputs).toEqual({
      idleSats: 1_000n,
      deployedSats: 2_000n,
      inFlightSats: 300n,
      nativeBtcSats: 400n,
      hashiClaimsSats: 500n,
      clearingPrice: 0n,
      bookMid: 0n,
    });
  });

  it('0 on either price side is a DEFINED state — no book means no reference, not a guess', () => {
    // assert_price_deviation returns early on a zero; the empty hBTC book is exactly that case.
    expect(resolveNavInputs(state()).bookMid).toBe(0n);
    expect(resolveNavInputs(state(), { bookMid: 42n }).bookMid).toBe(42n);
  });

  it('nav_assets = idle + deployed + in_flight + native_btc (claimable is NOT included)', () => {
    expect(navAssetsOf(resolveNavInputs(state()))).toBe(3_700n);
  });
});

describe('nav — a proposal the admin could never approve is refused HERE', () => {
  it('★ refuses native_btc above hashi_claims (DESIGN-V2 §7.7 mitigation 2)', () => {
    expect(() =>
      assertApprovable(resolveNavInputs(state(), { nativeBtcSats: 900n }), state()),
    ).toThrow(/ENavLegUncapped/);
  });

  it('refuses regressed claims — the leg is monotone', () => {
    expect(() =>
      // 450 still caps native_btc (400), so this trips the monotonicity check and nothing else.
      assertApprovable(resolveNavInputs(state(), { hashiClaimsSats: 450n }), state()),
    ).toThrow(/EClaimsRegressed/);
  });

  it('refuses an idle override — approve_nav re-checks that leg itself', () => {
    expect(() => assertApprovable(resolveNavInputs(state(), { idleSats: 7n }), state())).toThrow(
      /EIdleMismatch/,
    );
  });

  it('accepts the chain-derived defaults', () => {
    expect(() => assertApprovable(resolveNavInputs(state()), state())).not.toThrow();
  });
});

describe('nav — INV-C1: the PTB names no address at all', () => {
  it('is one propose_nav command: vault, cap, seven u64s, clock', () => {
    const calls = moveCalls(buildProposeNavTx(D, TYPE_ARGS, CAP, resolveNavInputs(state())));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(`${PKG}::vault::propose_nav`);
    expect(calls[0]?.typeArguments).toEqual([...TYPE_ARGS]);
    expect(calls[0]?.argumentKinds).toEqual([
      'UnresolvedObject', // vault
      'UnresolvedObject', // KeeperCap
      'Pure',
      'Pure',
      'Pure',
      'Pure',
      'Pure',
      'Pure',
      'Pure',
      'Object', // clock
    ]);
  });

  it('never emits an approve_nav target from this module', () => {
    const calls = moveCalls(buildProposeNavTx(D, TYPE_ARGS, CAP, resolveNavInputs(state())));
    expect(calls.some((c) => c.target.includes('approve_nav'))).toBe(false);
  });
});

describe('nav — the digest the multisig signs is the CHAIN’s', () => {
  it('reads it back after the proposal lands, and never recomputes it locally', async () => {
    const digestBytes = new Uint8Array(32).fill(0xab);
    const { client, sent } = fakeClient({
      simulations: [
        vaultReturns(state()), // pre-read
        [], // propose_nav preflight
        vaultReturns(state({ hasProposal: true })), // post-read
        [[vecU8(digestBytes)]], // current_proposal_digest
      ],
    });

    const report = await runPropose({ cfg: testConfig(), client }, D, {
      signer: testSigner(),
      typeArgs: TYPE_ARGS,
      keeperCapId: CAP,
    });

    expect(sent).toHaveLength(1);
    expect(report.proposalDigestHex).toBe(`0x${'ab'.repeat(32)}`);
    expect(report.navAssets).toBe(3_700n);
  });

  it('refuses to print a digest when the vault reports no proposal', async () => {
    const { client } = fakeClient({
      simulations: [vaultReturns(state()), [], vaultReturns(state({ hasProposal: false }))],
    });
    await expect(
      runPropose({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        typeArgs: TYPE_ARGS,
        keeperCapId: CAP,
      }),
    ).rejects.toThrow(/refusing to print a digest/);
  });

  it('a reverted propose is never broadcast', async () => {
    const { client, sent } = fakeClient({ revert: 'ENotKeeper' });
    await expect(
      runPropose({ cfg: testConfig(), client }, D, {
        signer: testSigner(),
        typeArgs: TYPE_ARGS,
        keeperCapId: CAP,
      }),
    ).rejects.toThrow(/simulation reverted/);
    expect(sent).toHaveLength(0);
  });
});
