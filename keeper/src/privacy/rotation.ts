// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2
// @status     PARTIAL — `nextEpoch` and `buildRotateTx` are fully real and tested; `rotate`
//             is real but cannot round-trip live until a concrete `SealBackend` exists
//             (`@mysten/seal` is not an installed dependency — see the T2.6 handover).
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
// @facts      ★ VERIFIED against move/sources/vault.move (T1.1, DONE):
// @facts        public fun set_keeper<B, Q>(vault: &mut Vault<B,Q>, cap: &VaultCap,
// @facts          new_keeper: address, ctx: &mut TxContext): KeeperCap
// @facts        public fun update_strategy<B, Q>(vault: &mut Vault<B,Q>, cap: &VaultCap,
// @facts          ciphertext: vector<u8>, blob_id: vector<u8>)
// @facts      ★ ONLY `set_keeper` bumps `version_epoch` (vault.move @invariant 5) ⇒ a rotation
// @facts        ALWAYS contains a `set_keeper` call, even when the keeper address is unchanged.
// @facts        `update_strategy` deliberately does NOT bump, so re-publishing never revokes shares.
// @facts      ★ `set_keeper` RETURNS a fresh `KeeperCap`; a PTB must consume it, so the builder
// @facts        transfers it to the incoming keeper in the same transaction.
// @facts      ★ OWNER_KEY signs this, NOT KEEPER_KEY. The keeper cannot rotate itself (G2).
// @facts      Historical epochs remain individually discloseable ⇒ scoped verification tier
// @facts        (docs/KEEPER.md §9.1): an auditor can be granted epoch N without ever seeing N+1.
// @facts      Re-encryption goes through ./seal.ts (encrypt-before-upload, G8) and Walrus with
// @facts        EXPLICIT epochs (never 1) — the new ciphertext gets a NEW blob id, which the vault
// @facts        records via `update_strategy`.
// @facts      `Vault<phantom B, phantom Q>` is GENERIC (G7) ⇒ every moveCall carries
// @facts        typeArguments [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType] from config.
// @implements export interface RotationPlan / RotationResult / RotationDeps / RotationExecutor
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
// @verify     npm run test -- privacy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import { validateParams, type StrategyParams } from '../strategy/params.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, ObjectId, SuiAddress } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

import { publishStrategy, type BlobStore, type SealBackend, type SealDeps } from './seal.js';

/** Signs and submits the rotation PTB. Injectable so the builder stays unit-testable offline. */
export interface RotationExecutor {
  (input: {
    readonly tx: Transaction;
    readonly signer: Signer;
    readonly cfg: Config;
    readonly client: AnySuiClient;
  }): Promise<{ readonly digest: Digest }>;
}

export interface RotationDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** OWNER_KEY — holder of the `VaultCap`. NEVER the keeper key (G2). */
  readonly owner: Signer;
  /** Seal SDK port (./seal.ts). Absent ⇒ `rotate` fails loudly rather than skipping encryption. */
  readonly backend?: SealBackend;
  /** Walrus port. Defaults to `storage/walrus.ts`. */
  readonly storage?: BlobStore;
  /** Defaults to {@link defaultRotationExecutor}. */
  readonly executor?: RotationExecutor;
}

export interface RotationPlan {
  readonly vaultId: ObjectId;
  /** The owner-held `VaultCap` object id — the only authority that may rotate (G2). */
  readonly vaultCapId: ObjectId;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  /**
   * New keeper address, when the rotation also replaces the executor. Omitted ⇒ the CURRENT
   * keeper (`cfg.sui.keeperAddress`) is re-appointed — `set_keeper` still bumps the epoch,
   * which is the point (invalidating shares, not changing who trades).
   */
  readonly newKeeper?: SuiAddress;
  /** Parameters to re-encrypt under `toEpoch`. Usually the current ones, unchanged. */
  readonly params: StrategyParams;
  /** Blob id currently recorded on the vault — carried through, never deleted (invariant 4). */
  readonly previousBlobId?: string;
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
export function nextEpoch(currentEpoch: number): number {
  if (!Number.isInteger(currentEpoch) || currentEpoch < 0) {
    throw new ConfigError(
      `version epoch must be a non-negative integer — got ${String(currentEpoch)}`,
      ['SEAL_VERSION_EPOCH'],
    );
  }
  if (!Number.isSafeInteger(currentEpoch + 1)) {
    throw new ConfigError(`version epoch ${currentEpoch} is at the safe-integer ceiling`, [
      'SEAL_VERSION_EPOCH',
    ]);
  }
  return currentEpoch + 1;
}

function assertRotatable(cfg: Config, plan: RotationPlan): SuiAddress {
  if (cfg.aphotic.packageId === '') {
    throw new ConfigError('APHOTIC_PACKAGE_ID is unset — cannot target aphotic::vault', [
      'APHOTIC_PACKAGE_ID',
    ]);
  }
  if (plan.vaultId === '' || plan.vaultCapId === '') {
    throw new ConfigError('rotation needs both the Vault object id and the owner VaultCap id', [
      'VAULT_ID',
    ]);
  }
  if (plan.toEpoch !== plan.fromEpoch + 1) {
    // Invariant 2 — a gap or a repeat would leave shares valid under an epoch nobody re-encrypted.
    throw new ConfigError(
      `rotation epochs must be gapless: toEpoch (${plan.toEpoch}) must equal fromEpoch + 1 (${plan.fromEpoch + 1})`,
      ['SEAL_VERSION_EPOCH'],
    );
  }
  const keeper = plan.newKeeper ?? cfg.sui.keeperAddress;
  if (keeper === '') {
    throw new ConfigError(
      'rotation needs a keeper address: `set_keeper` is what bumps version_epoch, so it must be ' +
        'called even when the keeper is unchanged (set SUI_KEEPER_ADDRESS or plan.newKeeper)',
      ['SUI_KEEPER_ADDRESS'],
    );
  }
  return keeper;
}

/** ONE atomic PTB: set_keeper (the epoch bump) + update_strategy (invariant 1). */
export function buildRotateTx(
  cfg: Config,
  plan: RotationPlan,
  ciphertext: Uint8Array,
  blobId: string,
): Transaction {
  const keeper = assertRotatable(cfg, plan);
  if (ciphertext.length === 0) {
    // Bumping the epoch without re-encrypting leaves the vault holding an undecryptable strategy.
    throw new AphoticError('RotationRefused', 'refusing to rotate with an empty ciphertext');
  }
  if (blobId === '') {
    throw new AphoticError('RotationRefused', 'refusing to rotate with an empty strategy blob id');
  }

  // The Vault is generic over the asset pair (G7) — both type args come from config.
  const typeArguments = [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType];
  const tx = new Transaction();
  // NOTE: the sender is deliberately left unset. `CoreClient.signAndExecuteTransaction` calls
  // `setSenderIfNotSet(signer.toSuiAddress())`, so the sender is whoever signs — and the only
  // valid signer is OWNER_KEY, the `VaultCap` holder (G2). Hardcoding the keeper address here
  // would silently produce a transaction the keeper could never actually authorise.

  // 1. set_keeper — the ONLY function that bumps `version_epoch` (vault.move @invariant 5).
  const keeperCap = tx.moveCall({
    target: `${cfg.aphotic.packageId}::vault::set_keeper`,
    typeArguments,
    arguments: [tx.object(plan.vaultId), tx.object(plan.vaultCapId), tx.pure.address(keeper)],
  });
  // The returned KeeperCap must be consumed by the PTB; hand it to the incoming keeper.
  tx.transferObjects([keeperCap], tx.pure.address(keeper));

  // 2. update_strategy — the ciphertext re-encrypted under the NEW epoch, same transaction, so
  //    the vault is never observable with a stale ciphertext under a fresh epoch (invariant 1).
  tx.moveCall({
    target: `${cfg.aphotic.packageId}::vault::update_strategy`,
    typeArguments,
    arguments: [
      tx.object(plan.vaultId),
      tx.object(plan.vaultCapId),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(blobId))),
    ],
  });

  return tx;
}

/** Sign + submit with the OWNER key through the single Sui client factory's core API. */
export const defaultRotationExecutor: RotationExecutor = async ({ tx, signer, client }) => {
  const result = await client.core.signAndExecuteTransaction({ transaction: tx, signer });
  if (result.$kind === 'FailedTransaction') {
    throw new AphoticError(
      'RotationFailed',
      `rotation transaction ${result.FailedTransaction.digest} failed on chain`,
    );
  }
  return { digest: result.Transaction.digest };
};

/**
 * Full rotation: re-encrypt under the NEW epoch → Walrus put → one owner-signed PTB.
 * Skipping either half of "bump AND re-encrypt" is a security bug, not an optimisation.
 */
export async function rotate(deps: RotationDeps, plan: RotationPlan): Promise<RotationResult> {
  assertRotatable(deps.cfg, plan);
  validateParams(plan.params, deps.cfg);

  const sealDeps: SealDeps = {
    cfg: deps.cfg,
    client: deps.client,
    ...(deps.backend === undefined ? {} : { backend: deps.backend }),
    ...(deps.storage === undefined ? {} : { storage: deps.storage }),
  };

  // Encrypt under the NEW epoch FIRST: if this fails, nothing on-chain has moved and the old
  // ciphertext is still the one in force.
  const { blobId, ciphertext } = await publishStrategy(sealDeps, plan.params, {
    vaultId: plan.vaultId,
    versionEpoch: plan.toEpoch,
  });

  const tx = buildRotateTx(deps.cfg, plan, ciphertext, blobId);
  const execute = deps.executor ?? defaultRotationExecutor;
  const { digest } = await execute({ tx, signer: deps.owner, cfg: deps.cfg, client: deps.client });

  return {
    digest,
    toEpoch: plan.toEpoch,
    blobId,
    // Invariant 4: the previous blob is retained for scoped historical disclosure.
    ...(plan.previousBlobId === undefined ? {} : { previousBlobId: plan.previousBlobId }),
  };
}
