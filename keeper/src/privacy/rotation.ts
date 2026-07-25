// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2
// @status     STUB
// @spec       docs/KEEPER.md §3.3 (version-epoch rotation — why `set_keeper` alone is NOT enough)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.6) · docs/MOVE-PACKAGE.md §3.5 (owner lifecycle fns)
// @spec       "README (8).md" (security model: rotation must revoke previously derived key shares)
// @rules      G2 G7 G8
// @depends    ./seal.ts (T2.6) · ./session.ts (T2.6) · ../storage/walrus.ts (T2.9) ·
//             aphotic::vault (T1.1/T1.2)
// @facts      ★ WHY THE EPOCH EXISTS: swapping the keeper address alone does NOT revoke key shares a
// @facts        previous keeper already derived. Incrementing `vault.version_epoch` CHANGES THE SEAL
// @facts        IDENTITY, so old shares no longer decrypt the new ciphertext. Rotation = set_keeper
// @facts        AND epoch bump AND re-encrypt. Doing only the first is the security bug this
// @facts        paragraph exists to prevent.
// @facts      ★ public fun aphotic::vault::set_keeper(vault: &mut Vault, cap: &VaultCap,
// @facts          new_keeper: address, ctx: &mut TxContext): KeeperCap   — OWNER-only (VaultCap).
// @facts        The epoch bump + `update_strategy(vault, cap, ciphertext, blob_id)` ride the SAME PTB
// @facts        so the vault is never live with a stale ciphertext under a new epoch.
// @facts      ★ OWNER_KEY signs this, NOT KEEPER_KEY. The keeper cannot rotate itself (G2).
// @facts      Historical epochs remain individually discloseable ⇒ scoped verification tier
// @facts        (docs/KEEPER.md §9.1): an auditor can be granted epoch N without ever seeing N+1.
// @facts      Re-encryption goes through ./seal.ts (encrypt-before-upload, G8) and Walrus with
// @facts        EXPLICIT epochs (never 1) — the new ciphertext gets a NEW blob id, which the vault
// @facts        records via `update_strategy`.
// @implements export interface RotationPlan / RotationResult / RotationDeps
// @implements export function nextEpoch(currentEpoch: number): number
// @implements export function buildRotateTx(cfg: Config, plan: RotationPlan, ciphertext: Uint8Array, blobId: string): Transaction
// @implements export async function rotate(deps: RotationDeps, plan: RotationPlan): Promise<RotationResult>
// @forbidden  rotating with KEEPER_KEY — OWNER_KEY (VaultCap) only (G2)
// @forbidden  bumping the epoch without re-encrypting — the vault would hold undecryptable params
// @forbidden  re-encrypting without bumping the epoch — old shares would still decrypt (the bug)
// @forbidden  a hardcoded package/vault id — config only (gates.ps1 ids)
// @invariant  1. set_keeper + epoch bump + update_strategy are ATOMIC (one PTB).
// @invariant  2. `toEpoch === fromEpoch + 1` — epochs are monotonic and gapless.
// @invariant  3. Every live session minted under `fromEpoch` is invalid afterwards (./session.ts).
// @invariant  4. The old ciphertext blob is retained for historical disclosure, never deleted.
// @ac         docs/KEEPER.md §3.3 — rotation invalidates previously derived key shares
// @verify     npm run test -- strategy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { StrategyParams } from '../strategy/params.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, ObjectId, SuiAddress } from '../types.js';

export interface RotationDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** OWNER_KEY — holder of the `VaultCap`. NEVER the keeper key (G2). */
  readonly owner: Signer;
}

export interface RotationPlan {
  readonly vaultId: ObjectId;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  /** New keeper address, when the rotation also replaces the executor. */
  readonly newKeeper?: SuiAddress;
  /** Parameters to re-encrypt under `toEpoch`. Usually the current ones, unchanged. */
  readonly params: StrategyParams;
}

export interface RotationResult {
  readonly digest: Digest;
  readonly toEpoch: number;
  /** Blob id of the ciphertext re-encrypted under the NEW epoch. */
  readonly blobId: string;
  /** Retained for scoped historical disclosure — never deleted (invariant 4). */
  readonly previousBlobId?: string;
}

/** Monotonic, gapless epoch successor. */
// TODO(T2.6): return currentEpoch + 1 (assert non-negative integer).
export function nextEpoch(_currentEpoch: number): number {
  throw new Error('TODO(T2.6): nextEpoch not implemented');
}

/** ONE atomic PTB: set_keeper (optional) + epoch bump + update_strategy (invariant 1). */
// TODO(T2.6): moveCalls into `${cfg.aphotic.packageId}::vault::{set_keeper, update_strategy}`
//             with the VaultCap; sender = owner. Never split across two transactions.
export function buildRotateTx(
  _cfg: Config,
  _plan: RotationPlan,
  _ciphertext: Uint8Array,
  _blobId: string,
): Transaction {
  throw new Error('TODO(T2.6): buildRotateTx not implemented');
}

/**
 * Full rotation: re-encrypt under the NEW epoch → Walrus put → one owner-signed PTB.
 * Skipping either half of "bump AND re-encrypt" is a security bug, not an optimisation.
 */
// TODO(T2.6): seal.encryptParams(params, { vaultId, versionEpoch: plan.toEpoch }) →
//             storage.put(explicit epochs) → buildRotateTx → owner signs + executes.
export async function rotate(
  _deps: RotationDeps,
  _plan: RotationPlan,
): Promise<RotationResult> {
  throw new Error('TODO(T2.6): rotate not implemented');
}
