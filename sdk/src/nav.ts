// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.9
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#6 (approve_nav, the O(1) form — the ten numbered steps)
// @spec       aphotic.md §10 NAV invariants · §7.7 (all legs at par; the native-BTC leg is
//             CAPPED by the sum of on-Sui-readable withdrawal claims)
// @rules      G9 G10
// @depends    ./math.ts
// @facts      shares_to_mint    = mul_div(pending_deposit_assets, nav_supply, nav_assets)  DOWN
// @facts      assets_to_release = mul_div(pending_redeem_shares,  nav_assets, nav_supply)  DOWN
// @facts      ★ ROUND DOWN, ALWAYS. Round-down is SUBADDITIVE, so Σ(per-receipt) <= epoch total
// @facts        and the dust stays with the VAULT, never with a claimant. `claim_deposit`
// @facts        recomputes the SAME mul_div per receipt — that is what makes it safe.
// @facts        Test of record: `nav_rounding_never_over_mints`.
// @facts      ★ committed_supply is the correct solvency denominator, NOT coin::total_supply:
// @facts        total_supply undercounts owed-but-unminted shares and would let an over-mint pass.
// @facts        assert coin::total_supply(lp) + unminted_shares == committed_supply (ESupplyDrift)
// @facts        assert mul_div_u128(supply, last_nav_assets, last_nav_supply) <= assets (ESolvency)
// @facts      BPS_DENOM = 10_000. Bounds are RELATIVE, in bps: max_nav_jump_bps,
// @facts        max_price_dev_bps, max_proposal_age_ms.
// @facts      ⚠ A PAUSED VAULT STILL LETS HOLDERS LEAVE — request_redeem and claim_redeem do
// @facts        NOT call assert_not_paused. Nothing in this file may gate on `paused`.
// @facts      ⚠ The native-BTC leg is the honest gap (aphotic.md §7.7): Sui has no Bitcoin light
// @facts        client. It is CAPPED at Σ on-Sui WithdrawalRequest.btc_amount, never inferred.
// @implements export function mulDiv(a: bigint, b: bigint, c: bigint): bigint
// @implements export function mulDivU128(a: bigint, b: bigint, c: bigint): bigint
// @implements export interface EpochPrice
// @implements export function sharesToMint(pendingDepositAssets, navSupply, navAssets): bigint
// @implements export function assetsToRelease(pendingRedeemShares, navAssets, navSupply): bigint
// @implements export function divergenceBps(a: bigint, b: bigint): bigint
// @implements export function navJumpBps(navPerShareNow, navPerShareLast): bigint
// @implements export function isSolvent(committedSupply, lastNavAssets, lastNavSupply, assets): boolean
// @implements export function capNativeBtcLeg(nativeBtcSats, hashiPendingSats): bigint
// @implements export function assertNavProposal(p: NavProposal, b: NavBounds): void
// @forbidden  rounding UP anywhere in this file — it would let Σ per-receipt exceed the epoch
//             total and over-mint against the vault
// @forbidden  a float ratio — every comparison is an integer cross-multiplication in bps
// @forbidden  gating redemption on `paused`
// @invariant  1. sharesToMint / assetsToRelease round DOWN, always.
// @invariant  2. Σ_i sharesToMint(x_i, S, A) <= sharesToMint(Σ x_i, S, A)  (subadditivity).
// @invariant  3. divergenceBps(a, b) == divergenceBps(b, a) is FALSE in general — the second
//                argument is the REFERENCE. Named accordingly and tested.
// @invariant  4. capNativeBtcLeg(x, y) == min(x, y) — the unverifiable component can never
//                exceed the verifiable claim behind it.
// @ac         test/nav.test.ts — rounding direction, subadditivity fuzz, bound rejection
// @verify     npx vitest run nav
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { assertU64, BPS_DENOM, mulDivFloor } from './math.js';

/** `mul_div` rounding DOWN. The only rounding this module performs. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return mulDivFloor(a, b, c);
}

/** Alias documenting the Move `mul_div_u128` widening. bigint is unbounded, so identical. */
export function mulDivU128(a: bigint, b: bigint, c: bigint): bigint {
  return mulDivFloor(a, b, c);
}

/** One row of `epoch_prices` (docs/DESIGN-V2.md §6 step 6). */
export interface EpochPrice {
  readonly navAssets: bigint;
  readonly navSupply: bigint;
  readonly recordedMs: bigint;
}

/**
 * `shares_to_mint = mul_div(pending_deposit_assets, nav_supply, nav_assets)`, rounded DOWN.
 * `claim_deposit` recomputes this per receipt with the SAME epoch price.
 */
export function sharesToMint(
  pendingDepositAssets: bigint,
  navSupply: bigint,
  navAssets: bigint,
): bigint {
  if (navAssets === 0n) throw new RangeError('ENavAssetsZero');
  return mulDiv(pendingDepositAssets, navSupply, navAssets);
}

/** `assets_to_release = mul_div(pending_redeem_shares, nav_assets, nav_supply)`, rounded DOWN. */
export function assetsToRelease(
  pendingRedeemShares: bigint,
  navAssets: bigint,
  navSupply: bigint,
): bigint {
  if (navSupply === 0n) throw new RangeError('ENavSupplyZero');
  return mulDiv(pendingRedeemShares, navAssets, navSupply);
}

/**
 * `|value − reference| / reference` in basis points, rounded DOWN.
 * The SECOND argument is the reference — this is deliberately asymmetric.
 */
export function divergenceBps(value: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new RangeError('EZeroReference');
  const delta = value > reference ? value - reference : reference - value;
  return mulDiv(delta, BPS_DENOM, reference);
}

/** Step 3 of `approve_nav`: the relative NAV-per-share jump, in bps. */
export function navJumpBps(navPerShareNow: bigint, navPerShareLast: bigint): bigint {
  return divergenceBps(navPerShareNow, navPerShareLast);
}

/**
 * `mul_div_u128(committed_supply, last_nav_assets, last_nav_supply) <= assets` — the ESolvency
 * assertion. `committed_supply`, NOT `coin::total_supply`: total_supply undercounts
 * owed-but-unminted shares and would let an over-mint pass.
 */
export function isSolvent(
  committedSupply: bigint,
  lastNavAssets: bigint,
  lastNavSupply: bigint,
  assets: bigint,
): boolean {
  if (lastNavSupply === 0n) return committedSupply === 0n;
  return mulDivU128(committedSupply, lastNavAssets, lastNavSupply) <= assets;
}

/**
 * Step 5: `native_btc_sats <= hashi_pending_sats`. The NAV attributed to the leg Move cannot
 * read is capped by the sum of on-Sui-readable `WithdrawalRequest.btc_amount` that produced it.
 */
export function capNativeBtcLeg(nativeBtcSats: bigint, hashiPendingSats: bigint): bigint {
  assertU64(nativeBtcSats, 'nativeBtcSats');
  assertU64(hashiPendingSats, 'hashiPendingSats');
  return nativeBtcSats < hashiPendingSats ? nativeBtcSats : hashiPendingSats;
}

/** The numbers the admin multisig signs. `blake2b256(bcs(this))` is the `expected_digest`. */
export interface NavProposal {
  readonly navAssets: bigint;
  readonly navSupply: bigint;
  readonly proposedMs: bigint;
  readonly clearingPrice: bigint;
  readonly bookMid: bigint;
  readonly nativeBtcSats: bigint;
  readonly hashiPendingSats: bigint;
}

/** The governed bounds `approve_nav` checks against. */
export interface NavBounds {
  readonly nowMs: bigint;
  readonly maxProposalAgeMs: bigint;
  readonly maxNavJumpBps: bigint;
  readonly maxPriceDevBps: bigint;
  readonly lastNavAssets: bigint;
  readonly lastNavSupply: bigint;
}

/**
 * Steps 2–5 of `approve_nav`, as a checkable predicate. Throws with the Move error name so a
 * keeper `devInspect`-before-send prints the same string the chain would.
 *
 * Step 1 (the digest check) lives with the caller, which holds the bcs bytes; steps 6–10
 * mutate state and belong to Move.
 */
export function assertNavProposal(p: NavProposal, b: NavBounds): void {
  if (p.navSupply === 0n || p.navAssets === 0n) throw new Error('ENavZero');
  if (b.nowMs < p.proposedMs) throw new Error('EProposalFromTheFuture');
  if (b.nowMs - p.proposedMs > b.maxProposalAgeMs) throw new Error('EProposalStale');

  if (b.lastNavSupply > 0n && b.lastNavAssets > 0n) {
    // Compare NAV per share without ever forming a float: cross-multiply into a common scale.
    const now = mulDiv(p.navAssets, BPS_DENOM, p.navSupply);
    const last = mulDiv(b.lastNavAssets, BPS_DENOM, b.lastNavSupply);
    if (last > 0n && navJumpBps(now, last) > b.maxNavJumpBps) throw new Error('ENavJump');
  }
  if (p.bookMid > 0n && divergenceBps(p.clearingPrice, p.bookMid) > b.maxPriceDevBps) {
    throw new Error('EPriceDeviation');
  }
  if (p.nativeBtcSats > p.hashiPendingSats) throw new Error('ENavLegUncapped');
}
