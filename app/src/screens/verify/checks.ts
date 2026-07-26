// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §2 constraint 6 (value preservation), §10 (invariants)
// @spec       docs/DESIGN-V2.md §6 (approve_nav, the O(1) form; committed_supply is
//             the correct solvency denominator), F3/D7 (escrow is a SEPARATE
//             balance sheet)
// @spec       move/sources/vault.move — `assert_solvent` (ESolvency · ESupplyDrift),
//             `nav_assets`, `idle_sats` (= `v.base.value()`), `note_custody_sats`
// @spec       move/sources/notes.move — `assert_note_backing(tree, vault_btc_sats,
//             deployed_sats)`; the vault calls it with `deployed_sats = 0`
// @rules      G8 G10
// @depends    ../../lib/vault.ts (VaultSnapshot) — READ ONLY, never re-derived here
// @facts      THE IDENTITIES, verbatim from the deployed Move:
// @facts        NOTE BACKING   notes::assert_note_backing —
// @facts          tree.outstanding_sats == note_custody.value() - 0
// @facts        SUPPLY DRIFT   vault::assert_solvent (ESupplyDrift) —
// @facts          coin::total_supply(lp_treasury) + unminted_shares
// @facts            == committed_supply
// @facts        SOLVENCY       vault::assert_solvent (ESolvency) —
// @facts          committed_supply × last.nav_assets / last.nav_supply
// @facts            <= nav_assets   (u128 mul_div, rounding DOWN)
// @facts          ⚠ the contract SKIPS this branch entirely while
// @facts            last.nav_supply == 0, so this module reports 'na' there rather
// @facts            than a green tick over a division it never performed.
// @facts        NAV LEGS       vault::nav_assets —
// @facts          idle + deployed + in_flight + native_btc.  Escrow
// @facts          (base_book · quote_book · note_custody) is deliberately NOT in it.
// @facts        LEG CAP        approve_nav step 5 (ENavLegUncapped) —
// @facts          native_btc_sats <= hashi_claims_sats. The unverifiable leg is
// @facts          BOUNDED, not proven; the bound is the honest claim.
// @facts      ⚠ THE HALF WE CANNOT COMPUTE: `balance::assert_solvent` is
// @facts        `total_credited == custody_value`, and `Vault` exposes
// @facts        `escrow_base_custody` (the custody side) but NO accessor for
// @facts        `total_credited` — `balance::total_credited` takes a
// @facts        `&BalanceBook` this package never hands out. So the escrow leg is
// @facts        reported 'na' with that exact reason. A green tick there would be
// @facts        the one unacceptable outcome.
// @facts      A check is 'bad' whenever it is computable and fails. 'na' is NOT a
// @facts        pass: the caller must render it differently from 'ok'.
// @implements export type CheckVerdict · interface Check
// @implements export function noteBackingCheck · supplyDriftCheck · solvencyCheck
// @implements export function navLegsCheck · navLegCapCheck · escrowCheck
// @implements export function conservationChecks · worstVerdict
// @forbidden  reporting 'ok' for an identity this browser did not actually evaluate
// @forbidden  silently clamping a negative difference — the sign is the finding
// @invariant  1. Every check names the Move abort code it mirrors.
// @invariant  2. `worstVerdict` is bad > na > ok, so one failure colours the panel.
// @invariant  3. Arithmetic is bigint end to end; no u64 is narrowed to `number`.
// @ac         app/test/verify.test.tsx — a balanced snapshot is all-ok, and each
//             identity is broken one at a time and shows up as 'bad'.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { VaultSnapshot } from '../../lib/vault';

/**
 * `ok` — computed here and it holds.
 * `bad` — computed here and it does NOT hold. This must be loud.
 * `na`  — not computable from the published read surface, or the contract itself
 *         skips the branch. Never render this as a pass.
 */
export type CheckVerdict = 'ok' | 'bad' | 'na';

export interface Check {
  readonly id: string;
  /** What is being asserted, in words. */
  readonly label: string;
  /** The identity, as the contract writes it. */
  readonly identity: string;
  /** The Move error the chain raises when this fails. */
  readonly abort: string;
  readonly verdict: CheckVerdict;
  /** Left-hand side, rendered. Empty when `na`. */
  readonly left: string;
  /** Right-hand side, rendered. Empty when `na`. */
  readonly right: string;
  /** Why it is `na`, or the size and sign of the gap when it is `bad`. */
  readonly note: string;
}

const sats = (v: bigint): string => `${v.toString()} sats`;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** `notes::assert_note_backing` with `deployed_sats = 0`, as the vault calls it. */
export function noteBackingCheck(s: VaultSnapshot): Check {
  const ok = s.noteOutstandingSats === s.noteCustodySats;
  const gap = s.noteCustodySats - s.noteOutstandingSats;
  return {
    id: 'note-backing',
    label: 'Every outstanding note is backed, sat for sat',
    identity: 'notes::outstanding_sats == note_custody.value()',
    abort: 'ENoteBackingMismatch',
    verdict: ok ? 'ok' : 'bad',
    left: sats(s.noteOutstandingSats),
    right: sats(s.noteCustodySats),
    note: ok
      ? 'The tree and the custody balance move together, so no note can outlive its backing.'
      : `Custody is ${gap > 0n ? 'over' : 'under'} the tree by ${abs(gap).toString()} sats.`,
  };
}

/** `vault::assert_solvent`'s second assertion — `ESupplyDrift`. */
export function supplyDriftCheck(s: VaultSnapshot): Check {
  const sum = s.mintedSupply + s.unmintedShares;
  const ok = sum === s.committedSupply;
  return {
    id: 'supply-drift',
    label: 'Minted plus owed-but-unminted equals committed supply',
    identity: 'total_supply(lp_treasury) + unminted_shares == committed_supply',
    abort: 'ESupplyDrift',
    verdict: ok ? 'ok' : 'bad',
    left: `${sum.toString()} shares`,
    right: `${s.committedSupply.toString()} shares`,
    note: ok
      ? 'committed_supply is the solvency denominator precisely because total_supply alone undercounts shares already owed.'
      : `The two ledgers of share supply disagree by ${abs(sum - s.committedSupply).toString()} shares.`,
  };
}

/**
 * `vault::assert_solvent`'s first assertion — `ESolvency`.
 *
 * The contract guards the whole branch with `last.nav_supply > 0`, so an unpriced
 * vault has nothing to check. Saying so is the honest answer; a tick is not.
 */
export function solvencyCheck(s: VaultSnapshot): Check {
  const base = {
    id: 'solvency',
    label: 'The vault holds at least what every committed share is owed',
    identity: 'committed_supply × last_nav_assets / last_nav_supply <= nav_assets',
    abort: 'ESolvency',
  } as const;
  if (s.lastNavSupply === 0n) {
    return {
      ...base,
      verdict: 'na',
      left: '',
      right: '',
      note:
        'No epoch has been priced yet (last_nav_supply == 0), and the contract skips this branch ' +
        'entirely in that state. There is no division to reproduce, so there is nothing to tick.',
    };
  }
  // The same u128 mul_div the contract runs, rounding DOWN. bigint is exact.
  const owed = (s.committedSupply * s.lastNavAssets) / s.lastNavSupply;
  const ok = owed <= s.navAssets;
  return {
    ...base,
    verdict: ok ? 'ok' : 'bad',
    left: sats(owed),
    right: sats(s.navAssets),
    note: ok
      ? `Headroom ${sats(s.navAssets - owed)}. Claimable is excluded from assets on purpose: those shares are already burned.`
      : `SHORT BY ${sats(owed - s.navAssets)}. The vault owes more than it holds.`,
  };
}

/** `vault::nav_assets` — the four legs, re-added in the browser. */
export function navLegsCheck(s: VaultSnapshot): Check {
  const sum = s.idleSats + s.deployedSats + s.inFlightSats + s.nativeBtcSats;
  const ok = sum === s.navAssets;
  return {
    id: 'nav-legs',
    label: 'The published NAV is the sum of its four legs',
    identity: 'nav_assets == idle + deployed + in_flight + native_btc',
    abort: '(accessor identity — no abort)',
    verdict: ok ? 'ok' : 'bad',
    left: sats(sum),
    right: sats(s.navAssets),
    note: ok
      ? 'Escrow — the two balance books and the note custody — is deliberately NOT in this total (DESIGN-V2 F3).'
      : 'The legs do not add up to the total the vault reports. One of the two reads is wrong.',
  };
}

/** `approve_nav` step 5 — `ENavLegUncapped`. The unverifiable leg is bounded. */
export function navLegCapCheck(s: VaultSnapshot): Check {
  const ok = s.nativeBtcSats <= s.hashiClaimsSats;
  return {
    id: 'nav-leg-cap',
    label: 'The native-BTC leg is capped by the bridge claims it is drawn from',
    identity: 'native_btc_sats <= hashi_claims_sats',
    abort: 'ENavLegUncapped',
    verdict: ok ? 'ok' : 'bad',
    left: sats(s.nativeBtcSats),
    right: sats(s.hashiClaimsSats),
    note: ok
      ? 'Move cannot read Bitcoin, so this leg is BOUNDED rather than proven. The bound is the honest claim, and it is the one being checked here.'
      : 'The native-BTC leg exceeds its cap — the one NAV leg Move cannot verify is also the one out of bounds.',
  };
}

/**
 * `balance::assert_solvent` — the half of conservation this build cannot compute.
 *
 * `Vault` publishes the custody side and not the credited side, so the difference
 * is unavailable to a browser. Stated, with the missing accessor named.
 */
export function escrowCheck(s: VaultSnapshot): Check {
  return {
    id: 'escrow-solvency',
    label: 'Internal balances sum to the escrow the vault physically holds',
    identity: 'total_credited == custody_value, per balance book',
    abort: 'EInsolvent',
    verdict: 'na',
    left: '',
    right: '',
    note:
      `TODO(F4) — not computable from this build. The vault holds ${sats(s.escrowBaseCustody)} base ` +
      `and ${s.escrowQuoteCustody.toString()} quote in escrow, but there is no ` +
      'public accessor on Vault for the credited side: balance::total_credited takes a ' +
      '&BalanceBook, which the package never hands out. The chain asserts this on every ' +
      'settlement; this browser cannot reproduce it, and will not tick a box it did not compute.',
  };
}

/** Every conservation and solvency identity, in the order a reader should meet them. */
export function conservationChecks(s: VaultSnapshot): readonly Check[] {
  return [
    noteBackingCheck(s),
    escrowCheck(s),
    solvencyCheck(s),
    supplyDriftCheck(s),
    navLegsCheck(s),
    navLegCapCheck(s),
  ];
}

/** bad wins over na, na wins over ok — so one failure colours the whole panel. */
export function worstVerdict(checks: readonly Check[]): CheckVerdict {
  if (checks.some((c) => c.verdict === 'bad')) return 'bad';
  if (checks.some((c) => c.verdict === 'na')) return 'na';
  return 'ok';
}
