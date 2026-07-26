// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §2 constraint 6 (value preservation), §9 (a divergence
//             between clearing implementations is a RELEASE BLOCKER), §10
// @spec       docs/DESIGN-V2.md §5ter (the parity claim does not currently hold,
//             measured 2026-07-26), §6 (approve_nav / solvency denominator)
// @rules      G8
// @depends    ../src/screens/verify/checks.ts (F4)
//             · ../src/screens/verify/ParityPanel.tsx (F4)
//             · ../src/screens/verify/VerifyScreen.tsx (F4)
// @facts      THIS FILE EXISTS FOR TWO REASONS, and neither is coverage:
// @facts        1. The conservation arithmetic must be WRONG-DETECTING. Every
// @facts           identity below is broken deliberately, one at a time, and the
// @facts           test fails unless the verdict flips to 'bad'. A checker that
// @facts           cannot fail is decoration.
// @facts        2. The parity disclosure must not be quietly softened. The five
// @facts           named divergences, the 3 407/4 000 census and the "release
// @facts           blocker" framing are asserted verbatim, exactly as
// @facts           app/test/limitations.test.tsx guards the honesty copy.
// @facts      'na' IS NOT A PASS. The escrow leg is genuinely not computable from
// @facts        the deployed read surface, and the test asserts it can never
// @facts        report 'ok' — that is the single unacceptable outcome for this
// @facts        screen.
// @implements the anti-softening and wrong-detection safety net for /verify
// @forbidden  relaxing a case here to make a copy edit pass — fix the copy, or the
//             claim was never honest in the first place
// @forbidden  a network call: every assertion runs against a literal snapshot
// @invariant  1. A balanced snapshot never reports 'bad'.
// @invariant  2. Each broken identity reports 'bad' and names its Move abort.
// @invariant  3. The parity panel renders before anything it could reassure about.
// @ac         cd app && npm test -- verify
// @verify     cd app && npm test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ParityPanel, { DIVERGENCES } from '../src/screens/verify/ParityPanel';
import VerifyScreen from '../src/screens/verify/VerifyScreen';
import {
  conservationChecks,
  escrowCheck,
  navLegCapCheck,
  navLegsCheck,
  noteBackingCheck,
  solvencyCheck,
  supplyDriftCheck,
  worstVerdict,
  type Check,
} from '../src/screens/verify/checks';
import type { VaultSnapshot } from '../src/lib/vault';

afterEach(cleanup);

// ── the fixture ─────────────────────────────────────────────────────────────
// A vault where every identity the contract asserts actually holds. Every
// divergence below is produced by editing exactly ONE field of this.

const BALANCED: VaultSnapshot = {
  epoch: 4n,
  committedSupply: 1_000n,
  unmintedShares: 250n,
  mintedSupply: 750n,
  idleSats: 400_000n,
  claimableSats: 12_000n,
  pendingDepositAssets: 0n,
  pendingRedeemShares: 0n,
  deployedSats: 300_000n,
  inFlightSats: 100_000n,
  nativeBtcSats: 200_000n,
  hashiClaimsSats: 250_000n,
  navAssets: 1_000_000n, // 400k + 300k + 100k + 200k
  lastNavAssets: 900_000n,
  lastNavSupply: 1_000n,
  lastNavAtMs: 1_700_000_000_000n,
  paused: false,
  hasProposal: false,
  minDepositSats: 30_000n,
  feeMatchedBps: 10n,
  maxNavJumpBps: 500n,
  maxPriceDevBps: 200n,
  maxProposalAgeMs: 600_000n,
  noteOutstandingSats: 5_000_000n,
  noteCustodySats: 5_000_000n,
  noteRoot: new Uint8Array(32),
  escrowBaseCustody: 77_000n,
  escrowQuoteCustody: 0n,
  activeClearings: 0n,
  readAtMs: 1_700_000_000_000,
};

const withField = (patch: Partial<VaultSnapshot>): VaultSnapshot => ({ ...BALANCED, ...patch });

const byId = (checks: readonly Check[], id: string): Check => {
  const found = checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check with id ${id}`);
  return found;
};

// ── the arithmetic holds when it should ─────────────────────────────────────

describe('a balanced vault reports no mismatch', () => {
  it('never reports bad on any identity', () => {
    for (const check of conservationChecks(BALANCED)) {
      expect(check.verdict, `${check.id} should not be bad`).not.toBe('bad');
    }
  });

  it('reproduces the contract mul_div exactly, rounding DOWN', () => {
    // 1000 × 900_000 / 1000 = 900_000 owed against 1_000_000 held.
    const check = solvencyCheck(BALANCED);
    expect(check.verdict).toBe('ok');
    expect(check.left).toBe('900000 sats');
    expect(check.right).toBe('1000000 sats');
    expect(check.note).toMatch(/Headroom 100000 sats/);
  });

  it('re-adds the four NAV legs rather than trusting the reported total', () => {
    expect(navLegsCheck(BALANCED).verdict).toBe('ok');
    expect(navLegsCheck(BALANCED).left).toBe('1000000 sats');
  });

  it('rounds the solvency division DOWN, as the contract does', () => {
    // 3 × 1000 / 7 = 428.57… ⇒ 428, not 429.
    const check = solvencyCheck(
      withField({ committedSupply: 3n, lastNavAssets: 1_000n, lastNavSupply: 7n, navAssets: 428n }),
    );
    expect(check.left).toBe('428 sats');
    expect(check.verdict).toBe('ok');
  });
});

// ── and fails when it should: one broken identity at a time ─────────────────

describe('each identity is wrong-detecting', () => {
  it('catches a note that outlives its backing', () => {
    const check = noteBackingCheck(withField({ noteCustodySats: 4_999_999n }));
    expect(check.verdict).toBe('bad');
    expect(check.abort).toBe('ENoteBackingMismatch');
    expect(check.note).toMatch(/under the tree by 1 sats/);
  });

  it('catches custody drifting ABOVE the tree too, and says which way', () => {
    const check = noteBackingCheck(withField({ noteCustodySats: 5_000_009n }));
    expect(check.verdict).toBe('bad');
    expect(check.note).toMatch(/over the tree by 9 sats/);
  });

  it('catches insolvency by exactly one sat', () => {
    const check = solvencyCheck(withField({ navAssets: 899_999n }));
    expect(check.verdict).toBe('bad');
    expect(check.abort).toBe('ESolvency');
    expect(check.note).toMatch(/SHORT BY 1 sats/);
  });

  it('catches share-supply drift', () => {
    const check = supplyDriftCheck(withField({ unmintedShares: 251n }));
    expect(check.verdict).toBe('bad');
    expect(check.abort).toBe('ESupplyDrift');
    expect(check.note).toMatch(/disagree by 1 shares/);
  });

  it('catches a NAV total that is not the sum of its legs', () => {
    const check = navLegsCheck(withField({ navAssets: 1_000_001n }));
    expect(check.verdict).toBe('bad');
  });

  it('catches the unverifiable native-BTC leg exceeding its cap', () => {
    const check = navLegCapCheck(withField({ nativeBtcSats: 250_001n }));
    expect(check.verdict).toBe('bad');
    expect(check.abort).toBe('ENavLegUncapped');
  });

  it('reports the worst verdict, so one failure colours the whole panel', () => {
    const broken = conservationChecks(withField({ navAssets: 1n }));
    expect(worstVerdict(broken)).toBe('bad');
    expect(worstVerdict(conservationChecks(BALANCED))).toBe('na'); // the escrow leg
  });
});

// ── 'na' is never dressed up as a pass ──────────────────────────────────────

describe("what we cannot compute is never reported as fine", () => {
  it('never reports the escrow identity as ok, on any snapshot', () => {
    for (const snapshot of [BALANCED, withField({ escrowBaseCustody: 0n })]) {
      const check = escrowCheck(snapshot);
      expect(check.verdict).toBe('na');
      expect(check.note).toMatch(/TODO\(F4\)/);
      // The reason must name the missing accessor, not wave at it.
      expect(check.note).toMatch(/total_credited/);
      expect(check.note).toMatch(/will not tick a box it did not compute/);
    }
  });

  it('refuses to tick solvency on a vault that has never been priced', () => {
    const check = solvencyCheck(withField({ lastNavSupply: 0n, lastNavAssets: 0n }));
    expect(check.verdict).toBe('na');
    expect(check.verdict).not.toBe('ok');
    expect(check.note).toMatch(/skips this branch/);
  });

  it('worstVerdict ranks bad above na above ok', () => {
    const mk = (verdict: Check['verdict']): Check => ({
      id: verdict,
      label: '',
      identity: '',
      abort: '',
      verdict,
      left: '',
      right: '',
      note: '',
    });
    expect(worstVerdict([mk('ok'), mk('na'), mk('bad')])).toBe('bad');
    expect(worstVerdict([mk('ok'), mk('na')])).toBe('na');
    expect(worstVerdict([mk('ok'), mk('ok')])).toBe('ok');
  });
});

// ── the parity failure is published, not softened ───────────────────────────

const parityText = () => render(<ParityPanel />).container.textContent ?? '';

describe('the clearing parity failure is stated in full', () => {
  it('carries all five named divergences', () => {
    expect(DIVERGENCES.map((d) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
  });

  it('says it is a release blocker and that MOVE is the side that differs', () => {
    const text = parityText();
    expect(text).toMatch(/release blocker/i);
    expect(text).toMatch(/Move differs/);
    expect(text).toMatch(/Move is what settles/);
    // The soft versions we are refusing to ship.
    expect(text).not.toMatch(/bit-identical parity is verified/i);
    expect(text).not.toMatch(/all implementations agree/i);
  });

  it('publishes the census rather than a rounded reassurance', () => {
    const text = parityText();
    expect(text).toMatch(/3 407/);
    expect(text).toMatch(/4 000/);
    expect(text).toMatch(/85 %/);
    expect(text).toMatch(/15 %/);
  });

  it('states D1 in the strongest form: the roots can NEVER match', () => {
    const text = parityText();
    expect(text).toMatch(/73 bytes/);
    expect(text).toMatch(/81/);
    expect(text).toMatch(/NEVER match/);
  });

  it('quantifies D2 and D3 with their measured incidence', () => {
    const text = parityText();
    expect(text).toMatch(/greedily/);
    expect(text).toMatch(/pro-rates/);
    expect(text).toMatch(/97 of 4 000 books \(2\.4 %\)/);
    expect(text).toMatch(/516 of 4 000 books \(12\.9 %\)/);
  });

  it('states D4 as the design question it is — one account moves the price', () => {
    const text = parityText();
    expect(text).toMatch(/before price discovery/);
    expect(text).toMatch(/changes the uniform clearing price for everyone/i);
  });

  it('marks exactly the two divergences that are design questions, not bugs', () => {
    const design = DIVERGENCES.filter((d) => d.designQuestion).map((d) => d.id);
    expect(design).toEqual(['D2', 'D4']);
    expect(parityText()).toMatch(/both.*engines/i);
  });

  it('cites where the measurement lives, so the claim is checkable', () => {
    const text = parityText();
    expect(text).toMatch(/DESIGN-V2\.md/);
    expect(text).toMatch(/divergence\.rs/);
  });
});
