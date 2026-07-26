// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.vault.read
// @phase      2
// @status     DONE
// @spec       move/sources/vault.move — the public read surface (`vault_epoch`, `idle_sats`,
//             `deployed_sats`, `in_flight_sats`, `native_btc_sats`, `hashi_claims_sats`,
//             `committed_supply`, `unminted_shares`, `pending_deposit_assets`,
//             `pending_redeem_shares`, `claimable_sats`, `last_nav_assets`, `last_nav_supply`,
//             `has_proposal`, `current_proposal_digest`)
// @spec       docs/DESIGN-V2.md §6 (`approve_nav` — the O(1) form and its five checks)
// @rules      G10
// @depends    ./context.ts
// @facts      ★ EVERY FIELD BELOW IS READ BY SIMULATING THE MODULE'S OWN GETTER. The values are
// @facts        therefore whatever Move computes, in one atomic simulation — a set of numbers that
// @facts        were all true at the same version, which is exactly what a NAV proposal needs.
// @facts      ★ `idleSats` IS THE ONE LEG MOVE CHECKS ITSELF: `approve_nav` asserts
// @facts        `p.idle_sats == v.base.value()`. Proposing a stale idle figure does not produce a
// @facts        wrong NAV — it produces an admin transaction that aborts, which is the design.
// @facts      ★ `committedSupply`, not `coin::total_supply`, is the solvency denominator
// @facts        (DESIGN-V2 §6): total supply undercounts owed-but-unminted shares.
// @facts      ⚠ `currentProposalDigest` ABORTS when there is no proposal, so it is read only after
// @facts        `hasProposal` says there is one. That is why it is a separate call and not another
// @facts        command in the batch read.
// @implements export interface VaultState
// @implements export async function readVaultState(deps, d, typeArgs): Promise<VaultState>
// @implements export async function readProposalDigest(deps, d, typeArgs): Promise<Uint8Array>
// @forbidden  reconstructing NAV client-side — every number here is the chain's own answer
// @forbidden  reading a proposal digest without first checking `has_proposal`
// @invariant  1. One simulation ⇒ one consistent snapshot; fields are never stitched across reads.
// @invariant  2. A revert on any getter fails the whole read (no partial VaultState escapes).
// @ac         test/vaultread.test.ts — decoding the full snapshot from recorded BCS
// @verify     npm run test -- vaultread
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';

import type { Sats } from '../types.js';

import {
  applySender,
  decodeBool,
  decodeBytes,
  decodeU64,
  inspect,
  returnValue,
  type ChainDeps,
  type Deployment,
  type VaultTypeArgs,
} from './context.js';

/** A single-simulation snapshot of the vault's balance sheet. */
export interface VaultState {
  readonly epoch: bigint;
  /** `v.base.value()` — the ONE leg `approve_nav` verifies for itself. */
  readonly idleSats: Sats;
  readonly deployedSats: Sats;
  readonly inFlightSats: Sats;
  readonly nativeBtcSats: Sats;
  readonly hashiClaimsSats: Sats;
  readonly claimableSats: Sats;
  readonly committedSupply: bigint;
  readonly unmintedShares: bigint;
  readonly pendingDepositAssets: Sats;
  readonly pendingRedeemShares: bigint;
  readonly lastNavAssets: bigint;
  readonly lastNavSupply: bigint;
  readonly hasProposal: boolean;
}

/** The getters read, in command order. Changing this list changes the decode below — keep paired. */
const GETTERS = [
  'vault_epoch',
  'idle_sats',
  'deployed_sats',
  'in_flight_sats',
  'native_btc_sats',
  'hashi_claims_sats',
  'claimable_sats',
  'committed_supply',
  'unminted_shares',
  'pending_deposit_assets',
  'pending_redeem_shares',
  'last_nav_assets',
  'last_nav_supply',
  'has_proposal',
] as const;

export function buildVaultStateTx(
  deps: ChainDeps,
  d: Deployment,
  typeArgs: VaultTypeArgs,
): Transaction {
  const tx = new Transaction();
  for (const fn of GETTERS) {
    tx.moveCall({
      target: `${d.packageId}::vault::${fn}`,
      typeArguments: [...typeArgs],
      arguments: [tx.object(d.vaultId)],
    });
  }
  return applySender(deps, tx);
}

/** One simulation, one consistent snapshot (invariant 1). */
export async function readVaultState(
  deps: ChainDeps,
  d: Deployment,
  typeArgs: VaultTypeArgs,
): Promise<VaultState> {
  const returns = await inspect(deps, buildVaultStateTx(deps, d, typeArgs), 'vault state read');
  const u64 = (i: number): bigint =>
    decodeU64(returnValue(returns, i, `vault::${GETTERS[i] as string}`), `vault::${GETTERS[i] as string}`);

  return {
    epoch: u64(0),
    idleSats: u64(1),
    deployedSats: u64(2),
    inFlightSats: u64(3),
    nativeBtcSats: u64(4),
    hashiClaimsSats: u64(5),
    claimableSats: u64(6),
    committedSupply: u64(7),
    unmintedShares: u64(8),
    pendingDepositAssets: u64(9),
    pendingRedeemShares: u64(10),
    lastNavAssets: u64(11),
    lastNavSupply: u64(12),
    hasProposal: decodeBool(returnValue(returns, 13, 'vault::has_proposal'), 'vault::has_proposal'),
  };
}

/**
 * The digest the admin multisig signs. Read from the chain rather than recomputed here on
 * purpose: `proposal_digest` is `blake2b256(bcs(NavProposal))`, and a TS re-encoding of that
 * struct that drifted by one field order would hand the admin a digest that can never be
 * approved — a failure with no error to read until the multisig has already signed.
 *
 * ⚠ Call only when `has_proposal` is true; the accessor aborts otherwise.
 */
export async function readProposalDigest(
  deps: ChainDeps,
  d: Deployment,
  typeArgs: VaultTypeArgs,
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${d.packageId}::vault::current_proposal_digest`,
    typeArguments: [...typeArgs],
    arguments: [tx.object(d.vaultId)],
  });
  const returns = await inspect(deps, applySender(deps, tx), 'vault::current_proposal_digest');
  return decodeBytes(
    returnValue(returns, 0, 'vault::current_proposal_digest'),
    'vault::current_proposal_digest',
  );
}
