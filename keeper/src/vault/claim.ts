// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.claim
// @phase      2
// @status     DONE
// @spec       move/sources/vault.move — `public fun claim_deposit<B,Q,S>(v, receipt, ctx): Coin<S>`
//             and `public fun claim_redeem<B,Q,S>(v, receipt, ctx): Coin<B>`
// @spec       aphotic.md §9 ("Liveness is not privileged")
// @spec       docs/DESIGN-V2.md §6 (round-down is subadditive ⇒ dust stays with the vault)
// @rules      G2 G10
// @depends    ./context.ts · ./read.ts · ./receipts.ts · ../sui/send.ts
// @facts      ★ NEITHER CLAIM IS CAP-GATED AND NEITHER IS PAUSE-GATED. `claim_deposit` is allowed
// @facts        while paused because the obligation was fixed when the admin approved the NAV;
// @facts        refusing it would be a second, undisclosed pause. `claim_redeem` likewise — a
// @facts        paused vault still lets holders leave (vault.move @invariant 7).
// @facts      ★ THE COIN GOES TO `receipt.requester`, NOT TO THE SENDER. The receipt records who
// @facts        asked; sending the proceeds anywhere else would make a "courtesy crank" a theft
// @facts        primitive. `requester` is read out of the receipt itself, so the destination is
// @facts        never something this client chooses.
// @facts      ⚠ A receipt is an ADDRESS-OWNED object. The Move function is permissionless, but Sui
// @facts        ownership still decides who may put the object into a transaction, so this crank
// @facts        settles the receipts its signer holds. State that plainly rather than implying the
// @facts        keeper can settle the whole book for everyone.
// @facts      ⚠ `epoch < vault.epoch` is checked LOCALLY first (./receipts.ts `claimable`). Paying
// @facts        gas to be told ENotYetPriced is exactly the outcome devInspect-before-send exists
// @facts        to prevent.
// @implements export interface ClaimOptions / ClaimReport
// @implements export const DEFAULT_CLAIM_CHUNK
// @implements export function buildClaimTx(d, typeArgs, receipts): Transaction
// @implements export function chunk<T>(items, size): T[][]
// @implements export async function runClaim(deps, d, opts): Promise<ClaimReport>
// @forbidden  transferring a claimed coin anywhere but `receipt.requester`
// @forbidden  submitting a receipt whose epoch is not yet priced
// @forbidden  a KeeperCap check on this path (aphotic.md §9)
// @invariant  1. Every `claim_*` command is followed by a transfer to that receipt's requester.
// @invariant  2. Nothing is broadcast when there is no claimable receipt — the command reports
//                "0 claimable" and exits 0, having truthfully done the thing it was asked to do.
// @invariant  3. Chunks are built from the filtered list only; an unpriced receipt cannot enter.
// @ac         test/claim.test.ts — PTB shape, chunking, and the requester-destination rule
// @verify     npm run test -- claim
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { sendChecked } from '../sui/send.js';
import type { ObjectId, SuiAddress } from '../types.js';

import { typeOrigin, type ChainDeps, type Deployment, type VaultTypeArgs } from './context.js';
import { readVaultState } from './read.js';
import { claimable, listReceipts, type Receipt } from './receipts.js';

/**
 * Receipts per transaction. Each one costs two commands (claim + transfer) and one deleted
 * object; 32 keeps the PTB comfortably inside every measured ceiling with room for gas.
 */
export const DEFAULT_CLAIM_CHUNK = 32;

export interface ClaimOptions {
  readonly signer: Signer;
  readonly typeArgs: VaultTypeArgs;
  /** Whose receipts to settle. Must be the signer's address — Sui ownership, not policy. */
  readonly owner: SuiAddress;
  readonly chunkSize?: number;
  readonly dryRun?: boolean;
}

export interface ClaimReport {
  readonly vaultEpoch: bigint;
  readonly scanned: number;
  readonly claimable: readonly Receipt[];
  readonly digests: readonly string[];
  readonly broadcast: boolean;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be >= 1 — got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One PTB settling `receipts`, each proceeds transfer pinned to that receipt's own requester
 * (invariant 1).
 */
export function buildClaimTx(
  d: Deployment,
  typeArgs: VaultTypeArgs,
  receipts: readonly Receipt[],
): Transaction {
  const tx = new Transaction();
  for (const receipt of receipts) {
    const fn = receipt.kind === 'deposit' ? 'claim_deposit' : 'claim_redeem';
    const coin = tx.moveCall({
      target: `${d.packageId}::vault::${fn}`,
      typeArguments: [...typeArgs],
      arguments: [tx.object(d.vaultId), tx.object(receipt.objectId)],
    });
    // The destination is the receipt's own `requester` field — never `tx.sender`, never a flag.
    tx.transferObjects([coin], tx.pure.address(receipt.requester));
  }
  return tx;
}

/** Scan, filter locally, then settle in chunks. */
export async function runClaim(
  deps: ChainDeps,
  d: Deployment,
  opts: ClaimOptions,
): Promise<ClaimReport> {
  const state = await readVaultState(deps, d, opts.typeArgs);

  // ⚠ THE TYPE ORIGIN, NOT `published-at`. `DepositReceipt` keeps the id of the package that
  // DEFINED it, so filtering owned objects by the upgraded id matches nothing — and a scan that
  // matches nothing is reported as "0 claimable", indistinguishable from an empty vault.
  const filterPackage = typeOrigin(d);
  const deposits = await listReceipts(deps, filterPackage, opts.owner, 'deposit');
  const redeems = await listReceipts(deps, filterPackage, opts.owner, 'redeem');
  const all = [...deposits, ...redeems];
  const ready = claimable(all, state.epoch, d.vaultId);

  if (ready.length === 0) {
    // Invariant 2: nothing to do is a RESULT, reported with the numbers behind it — not a
    // silent exit that looks identical to a successful crank.
    return {
      vaultEpoch: state.epoch,
      scanned: all.length,
      claimable: [],
      digests: [],
      broadcast: false,
    };
  }

  const digests: string[] = [];
  let broadcast = false;
  for (const group of chunk(ready, opts.chunkSize ?? DEFAULT_CLAIM_CHUNK)) {
    const tx = buildClaimTx(d, opts.typeArgs, group);
    tx.setSender(opts.signer.toSuiAddress());
    const result = await sendChecked({ client: deps.client }, tx, {
      what: `claim ${group.length} receipt(s)`,
      signer: opts.signer,
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    if (result.digest !== undefined) digests.push(result.digest);
    broadcast = broadcast || result.broadcast;
  }

  return { vaultEpoch: state.epoch, scanned: all.length, claimable: ready, digests, broadcast };
}

/** Re-exported so the CLI can name the ids it settled without importing three modules. */
export type { Receipt, ObjectId };
