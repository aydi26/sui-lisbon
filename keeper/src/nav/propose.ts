// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.nav
// @phase      2
// @status     DONE
// @spec       move/sources/vault.move — `public fun propose_nav<B,Q,S>(v, cap: &KeeperCap,
//             idle_sats, deployed_sats, in_flight_sats, native_btc_sats, hashi_claims_sats,
//             clearing_price, book_mid, clock: &Clock, ctx: &TxContext)`
// @spec       docs/DESIGN-V2.md §6 (`approve_nav` — the O(1) form) · §7 (KeeperCap surface, INV-C1)
// @spec       aphotic.md §7 (two PARTIES, not two scopes)
// @rules      G2 G8 G9 G10
// @depends    ../vault/context.ts · ../vault/read.ts · ../sui/send.ts
// @facts      ★★ TWO PARTIES, NOT TWO SCOPES. `propose_nav` RECORDS a valuation and commits
// @facts        absolutely nothing: no share is minted, no asset moves, no epoch advances. The
// @facts        admin multisig calls `approve_nav` separately, against a digest it signed. There is
// @facts        no approve path in this module and there must never be one — a keeper that could
// @facts        both propose and approve is a keeper that sets its own NAV.
// @facts      ★ INV-C1: `propose_nav` takes NO `address` parameter of any kind. The proposer is
// @facts        `ctx.sender()`. `gates.ps1 keepercap` enforces the absence structurally.
// @facts      ★ THE DIGEST IS READ BACK FROM CHAIN, never recomputed here. It is
// @facts        `blake2b256(bcs(NavProposal))` over a ten-field struct; a TS re-encoding that
// @facts        drifted by one field would hand the multisig a digest that can never be approved,
// @facts        and the failure would only appear after the humans had already signed.
// @facts      ★ FIVE OF THE EIGHT NUMBERS COME FROM THE CHAIN, in ONE simulation, so they are all
// @facts        true at the same version. `idle_sats` in particular is the one leg `approve_nav`
// @facts        re-checks itself (`p.idle_sats == v.base.value()`), so a stale read does not
// @facts        produce a wrong NAV — it produces an admin transaction that aborts.
// @facts      ★ `clearing_price` / `book_mid` DEFAULT TO ZERO, and zero is a DEFINED state:
// @facts        `assert_price_deviation` returns early when either side is 0, meaning "no price
// @facts        reference this epoch". The hBTC/DBUSDC book is empty on both sides (RECON), so
// @facts        inventing a mid would be the dishonest option, not the helpful one (G9).
// @facts      ⚠ LOCAL PRE-CHECK, mirroring §7.7 mitigation 2: `native_btc_sats <= hashi_claims_sats`
// @facts        and `hashi_claims_sats >= last_hashi_claims`. Both are asserted at APPROVE time, so
// @facts        proposing a violating pair records a proposal the admin can never approve. Refuse
// @facts        it here instead.
// @implements export interface NavInputs / ProposeOptions / ProposeReport
// @implements export function resolveNavInputs(state, overrides): NavInputs
// @implements export function assertApprovable(inputs, state): void
// @implements export function buildProposeNavTx(d, typeArgs, capId, inputs): Transaction
// @implements export async function runPropose(deps, d, opts): Promise<ProposeReport>
// @forbidden  an `approve_nav` call anywhere in this module or anywhere in keeper/src
// @forbidden  recomputing the proposal digest client-side
// @forbidden  an `address` argument on the propose path (INV-C1)
// @invariant  1. This module never calls `approve_nav`, `pause`, `unpause` or any AdminCap entry.
// @invariant  2. A proposal that would be unapprovable is refused BEFORE it is broadcast.
// @invariant  3. The reported digest is the chain's, read after the proposal landed.
// @ac         test/nav.test.ts — input resolution, the two cap checks, and PTB shape
// @verify     npm run test -- nav
// @verify     powershell -NoProfile -File scripts/gates.ps1 keepercap
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { sendChecked } from '../sui/send.js';
import type { ObjectId, Sats } from '../types.js';
import { AphoticError } from '../util/errors.js';
import type { ChainDeps, Deployment, VaultTypeArgs } from '../vault/context.js';
import { readProposalDigest, readVaultState, type VaultState } from '../vault/read.js';

/** The eight u64s `propose_nav` records. No address among them — INV-C1. */
export interface NavInputs {
  readonly idleSats: Sats;
  readonly deployedSats: Sats;
  readonly inFlightSats: Sats;
  readonly nativeBtcSats: Sats;
  readonly hashiClaimsSats: Sats;
  /** 0 = "no auction reference this epoch". A defined state, not a missing value. */
  readonly clearingPrice: bigint;
  /** 0 = "no book reference this epoch". The hBTC book is empty on both sides. */
  readonly bookMid: bigint;
}

export type NavOverrides = Partial<NavInputs>;

export interface ProposeOptions {
  readonly signer: Signer;
  readonly typeArgs: VaultTypeArgs;
  /** The owned `KeeperCap`. The ONLY capability on this path (G2). */
  readonly keeperCapId: ObjectId;
  readonly overrides?: NavOverrides;
  readonly dryRun?: boolean;
}

export interface ProposeReport {
  readonly inputs: NavInputs;
  readonly navAssets: bigint;
  readonly state: VaultState;
  readonly digest?: string;
  /** The blake2b256 the admin multisig signs, hex, read back FROM CHAIN (invariant 3). */
  readonly proposalDigestHex?: string;
  readonly broadcast: boolean;
}

/**
 * Chain values first, explicit overrides second.
 *
 * The five balance-sheet legs default to what the vault itself reports; the two price
 * references default to 0 because there is no book to read one from (see the @facts block).
 */
export function resolveNavInputs(state: VaultState, overrides: NavOverrides = {}): NavInputs {
  return {
    idleSats: overrides.idleSats ?? state.idleSats,
    deployedSats: overrides.deployedSats ?? state.deployedSats,
    inFlightSats: overrides.inFlightSats ?? state.inFlightSats,
    nativeBtcSats: overrides.nativeBtcSats ?? state.nativeBtcSats,
    hashiClaimsSats: overrides.hashiClaimsSats ?? state.hashiClaimsSats,
    clearingPrice: overrides.clearingPrice ?? 0n,
    bookMid: overrides.bookMid ?? 0n,
  };
}

/** `idle + deployed + in_flight + native_btc` — `vault::nav_assets_of`, mirrored. */
export function navAssetsOf(inputs: NavInputs): bigint {
  return inputs.idleSats + inputs.deployedSats + inputs.inFlightSats + inputs.nativeBtcSats;
}

/**
 * Refuse a proposal the admin could never approve (invariant 2).
 *
 * Every check here is one `approve_nav` performs. Recording a proposal that is guaranteed to
 * abort at approval is not harmless: it replaces whatever proposal was there before.
 */
export function assertApprovable(inputs: NavInputs, state: VaultState): void {
  if (inputs.nativeBtcSats > inputs.hashiClaimsSats) {
    throw new AphoticError(
      'ENavLegUncapped',
      `native_btc_sats (${inputs.nativeBtcSats}) exceeds hashi_claims_sats (${inputs.hashiClaimsSats}). ` +
        'The unverifiable leg is capped by the verifiable claim behind it (DESIGN-V2 §7.7 ' +
        'mitigation 2); approve_nav would abort ENavLegUncapped.',
    );
  }
  if (inputs.hashiClaimsSats < state.hashiClaimsSats) {
    throw new AphoticError(
      'EClaimsRegressed',
      `hashi_claims_sats (${inputs.hashiClaimsSats}) is below the vault's recorded ` +
        `${state.hashiClaimsSats}. Claims are monotone; approve_nav would abort EClaimsRegressed.`,
    );
  }
  if (inputs.idleSats !== state.idleSats) {
    throw new AphoticError(
      'EIdleMismatch',
      `idle_sats override (${inputs.idleSats}) does not match the vault's base balance ` +
        `(${state.idleSats}). approve_nav re-checks this leg itself and would abort EIdleMismatch.`,
    );
  }
}

export function buildProposeNavTx(
  d: Deployment,
  typeArgs: VaultTypeArgs,
  keeperCapId: ObjectId,
  inputs: NavInputs,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${d.packageId}::vault::propose_nav`,
    typeArguments: [...typeArgs],
    arguments: [
      tx.object(d.vaultId),
      tx.object(keeperCapId),
      tx.pure.u64(inputs.idleSats),
      tx.pure.u64(inputs.deployedSats),
      tx.pure.u64(inputs.inFlightSats),
      tx.pure.u64(inputs.nativeBtcSats),
      tx.pure.u64(inputs.hashiClaimsSats),
      tx.pure.u64(inputs.clearingPrice),
      tx.pure.u64(inputs.bookMid),
      tx.object.clock(),
    ],
  });
  return tx;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Read, check, propose, then read the digest the multisig must sign. */
export async function runPropose(
  deps: ChainDeps,
  d: Deployment,
  opts: ProposeOptions,
): Promise<ProposeReport> {
  const state = await readVaultState(deps, d, opts.typeArgs);
  const inputs = resolveNavInputs(state, opts.overrides);
  assertApprovable(inputs, state);

  const tx = buildProposeNavTx(d, opts.typeArgs, opts.keeperCapId, inputs);
  tx.setSender(opts.signer.toSuiAddress());

  const result = await sendChecked({ client: deps.client }, tx, {
    what: 'vault::propose_nav',
    signer: opts.signer,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });

  const base = {
    inputs,
    navAssets: navAssetsOf(inputs),
    state,
    broadcast: result.broadcast,
  } as const;

  if (!result.broadcast) return base;

  // Invariant 3: the digest is the chain's own, taken after the proposal landed. Reading it
  // before would describe a proposal that does not exist yet.
  const after = await readVaultState(deps, d, opts.typeArgs);
  if (!after.hasProposal) {
    throw new AphoticError(
      'NoProposal',
      'propose_nav executed but the vault reports no proposal — refusing to print a digest for ' +
        'something that is not there',
    );
  }
  const digestBytes = await readProposalDigest(deps, d, opts.typeArgs);

  return {
    ...base,
    ...(result.digest === undefined ? {} : { digest: result.digest }),
    proposalDigestHex: `0x${hex(digestBytes)}`,
  };
}
