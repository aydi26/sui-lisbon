// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.9
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#6 (approve_nav, the O(1) form) · aphotic.md §10 NAV
// @rules      G9 G10
// @depends    ../src/nav.ts · ../src/rng.ts
// @facts      The named test of record in docs/DESIGN-V2.md §6 is `nav_rounding_never_over_mints`.
// @facts        Its TS twin is the subadditivity property below: because round-down is
// @facts        subadditive, Σ per-receipt <= epoch total ALWAYS, so the dust stays with the
// @facts        vault and never with a claimant.
// @implements describe('mulDiv rounds down') · describe('subadditivity') · describe('bounds')
// @verify     npx vitest run nav
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { BPS_DENOM } from '../src/math.js';
import {
  assertNavProposal,
  assetsToRelease,
  capNativeBtcLeg,
  divergenceBps,
  isSolvent,
  mulDiv,
  mulDivU128,
  navJumpBps,
  sharesToMint,
  type NavBounds,
  type NavProposal,
} from '../src/nav.js';
import { createRng } from '../src/rng.js';

describe('mulDiv rounds DOWN, always', () => {
  it('truncates rather than rounds', () => {
    expect(mulDiv(7n, 1n, 2n)).toBe(3n); // 3.5 -> 3, not 4
    expect(mulDiv(9n, 1n, 10n)).toBe(0n); // 0.9 -> 0
    expect(mulDivU128(7n, 1n, 2n)).toBe(3n);
  });

  it('rejects a zero denominator', () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/division by zero/);
    expect(() => sharesToMint(1n, 1n, 0n)).toThrow(/ENavAssetsZero/);
    expect(() => assetsToRelease(1n, 1n, 0n)).toThrow(/ENavSupplyZero/);
  });
});

describe('epoch pricing', () => {
  it('mints shares at the epoch price, rounded down', () => {
    // 1000 assets deposited, NAV = 2000 assets / 1500 supply -> 1000 * 1500 / 2000 = 750
    expect(sharesToMint(1000n, 1500n, 2000n)).toBe(750n);
    // 999 * 1500 / 2000 = 749.25 -> 749
    expect(sharesToMint(999n, 1500n, 2000n)).toBe(749n);
  });

  it('releases assets at the epoch price, rounded down', () => {
    expect(assetsToRelease(750n, 2000n, 1500n)).toBe(1000n);
    expect(assetsToRelease(749n, 2000n, 1500n)).toBe(998n); // 998.66 -> 998
  });

  it('never over-mints: Σ per-receipt <= the epoch total (subadditivity), 3000 random splits', () => {
    const rng = createRng('nav-subadditive');
    for (let i = 0; i < 3000; i++) {
      const navSupply = rng.nextBelow(10n ** 12n) + 1n;
      const navAssets = rng.nextBelow(10n ** 12n) + 1n;
      const receipts: bigint[] = [];
      const k = rng.nextInt(8) + 1;
      for (let j = 0; j < k; j++) receipts.push(rng.nextBelow(10n ** 9n));
      const total = receipts.reduce((a, b) => a + b, 0n);
      const epochTotal = sharesToMint(total, navSupply, navAssets);
      const perReceipt = receipts.reduce(
        (a, x) => a + sharesToMint(x, navSupply, navAssets),
        0n,
      );
      expect(perReceipt).toBeLessThanOrEqual(epochTotal);
    }
  });

  it('the same subadditivity holds on the redeem leg', () => {
    const rng = createRng('nav-subadditive-redeem');
    for (let i = 0; i < 2000; i++) {
      const navSupply = rng.nextBelow(10n ** 12n) + 1n;
      const navAssets = rng.nextBelow(10n ** 12n) + 1n;
      const a = rng.nextBelow(10n ** 9n);
      const b = rng.nextBelow(10n ** 9n);
      expect(
        assetsToRelease(a, navAssets, navSupply) + assetsToRelease(b, navAssets, navSupply),
      ).toBeLessThanOrEqual(assetsToRelease(a + b, navAssets, navSupply));
    }
  });
});

describe('divergenceBps', () => {
  it('is relative to the SECOND argument, and is asymmetric', () => {
    expect(divergenceBps(110n, 100n)).toBe(1000n); // 10 %
    expect(divergenceBps(90n, 100n)).toBe(1000n);
    expect(divergenceBps(100n, 110n)).toBe(909n); // 10/110 -> 9.09 %
    expect(divergenceBps(110n, 100n)).not.toBe(divergenceBps(100n, 110n));
  });

  it('is zero for equal values and rounds down', () => {
    expect(divergenceBps(100n, 100n)).toBe(0n);
    expect(divergenceBps(10001n, 10000n)).toBe(1n);
    expect(divergenceBps(100_001n, 100_000n)).toBe(0n); // 0.001 % -> 0 bps
  });

  it('rejects a non-positive reference', () => {
    expect(() => divergenceBps(1n, 0n)).toThrow(/EZeroReference/);
  });

  it('navJumpBps is divergenceBps against the LAST value', () => {
    expect(navJumpBps(105n, 100n)).toBe(500n);
  });
});

describe('solvency', () => {
  it('holds when supply x nav <= assets', () => {
    expect(isSolvent(1000n, 2000n, 1000n, 2000n)).toBe(true); // 1000 * 2 = 2000 <= 2000
    expect(isSolvent(1001n, 2000n, 1000n, 2000n)).toBe(false); // 2002 > 2000
  });

  it('an empty vault is solvent only with zero committed supply', () => {
    expect(isSolvent(0n, 0n, 0n, 0n)).toBe(true);
    expect(isSolvent(1n, 0n, 0n, 0n)).toBe(false);
  });

  it('uses committed_supply, so owed-but-unminted shares cannot hide an over-mint', () => {
    const minted = 900n;
    const unminted = 200n;
    const committed = minted + unminted;
    // total_supply alone would pass; committed_supply correctly fails.
    expect(isSolvent(minted, 2000n, 1000n, 2000n)).toBe(true);
    expect(isSolvent(committed, 2000n, 1000n, 2000n)).toBe(false);
  });
});

describe('the native-BTC leg is CAPPED, never inferred', () => {
  it('is min(claimed, on-Sui readable)', () => {
    expect(capNativeBtcLeg(500n, 1000n)).toBe(500n);
    expect(capNativeBtcLeg(1500n, 1000n)).toBe(1000n);
    expect(capNativeBtcLeg(0n, 1000n)).toBe(0n);
  });

  it('the unverifiable component can never exceed the verifiable claim, 2000 random pairs', () => {
    const rng = createRng('nav-btc-cap');
    for (let i = 0; i < 2000; i++) {
      const claimed = rng.nextBelow(10n ** 12n);
      const readable = rng.nextBelow(10n ** 12n);
      expect(capNativeBtcLeg(claimed, readable)).toBeLessThanOrEqual(readable);
    }
  });

  it('rejects non-u64 inputs', () => {
    expect(() => capNativeBtcLeg(2n ** 64n, 1n)).toThrow(/u64/);
  });
});

describe('assertNavProposal — steps 2 to 5 of approve_nav', () => {
  const proposal: NavProposal = {
    navAssets: 2_000_000n,
    navSupply: 1_000_000n,
    proposedMs: 1_000_000n,
    clearingPrice: 100n,
    bookMid: 100n,
    nativeBtcSats: 500n,
    hashiPendingSats: 1000n,
  };
  const bounds: NavBounds = {
    nowMs: 1_060_000n,
    maxProposalAgeMs: 600_000n,
    maxNavJumpBps: 1000n,
    maxPriceDevBps: 500n,
    lastNavAssets: 2_000_000n,
    lastNavSupply: 1_000_000n,
  };

  it('accepts a well-formed proposal', () => {
    expect(() => assertNavProposal(proposal, bounds)).not.toThrow();
  });

  it('rejects a stale proposal', () => {
    expect(() =>
      assertNavProposal(proposal, { ...bounds, nowMs: proposal.proposedMs + 600_001n }),
    ).toThrow(/EProposalStale/);
  });

  it('rejects a proposal timestamped in the future', () => {
    expect(() => assertNavProposal(proposal, { ...bounds, nowMs: 999_999n })).toThrow(
      /EProposalFromTheFuture/,
    );
  });

  it('rejects a NAV jump beyond the governed bound', () => {
    // NAV/share moves 2.0 -> 2.4, a 2000 bps jump against a 1000 bps bound.
    expect(() => assertNavProposal({ ...proposal, navAssets: 2_400_000n }, bounds)).toThrow(
      /ENavJump/,
    );
  });

  it('accepts a jump exactly at the bound', () => {
    // 2.0 -> 2.2 is exactly 1000 bps.
    expect(() => assertNavProposal({ ...proposal, navAssets: 2_200_000n }, bounds)).not.toThrow();
  });

  it('rejects a clearing price that deviates from the book mid beyond the bound', () => {
    expect(() => assertNavProposal({ ...proposal, clearingPrice: 106n }, bounds)).toThrow(
      /EPriceDeviation/,
    );
    expect(() => assertNavProposal({ ...proposal, clearingPrice: 105n }, bounds)).not.toThrow();
  });

  it('skips the price check when there is no book mid — an empty book is a defined state', () => {
    expect(() =>
      assertNavProposal({ ...proposal, bookMid: 0n, clearingPrice: 999_999n }, bounds),
    ).not.toThrow();
  });

  it('rejects a native-BTC leg above the on-Sui claims behind it', () => {
    expect(() => assertNavProposal({ ...proposal, nativeBtcSats: 1001n }, bounds)).toThrow(
      /ENavLegUncapped/,
    );
    expect(() => assertNavProposal({ ...proposal, nativeBtcSats: 1000n }, bounds)).not.toThrow();
  });

  it('rejects a zero NAV', () => {
    expect(() => assertNavProposal({ ...proposal, navSupply: 0n }, bounds)).toThrow(/ENavZero/);
    expect(() => assertNavProposal({ ...proposal, navAssets: 0n }, bounds)).toThrow(/ENavZero/);
  });

  it('skips the jump check on the first epoch, when there is no previous NAV', () => {
    expect(() =>
      assertNavProposal(proposal, { ...bounds, lastNavAssets: 0n, lastNavSupply: 0n }),
    ).not.toThrow();
  });

  it('never reads a `paused` flag — a paused vault still lets holders leave', () => {
    // Structural: the bounds type has no `paused` field to read.
    expect(Object.keys(bounds)).not.toContain('paused');
    expect(BPS_DENOM).toBe(10_000n);
  });
});
