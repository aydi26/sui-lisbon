// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.context
// @phase      2
// @status     DONE
// @spec       aphotic.md §9 ("devInspect-before-send. Simulate every transaction; catch reverts
//             off-chain, never broadcast them." · "Liveness is not privileged")
// @spec       docs/DESIGN-V2.md §6 (the vault is the root object every other id hangs off)
// @spec       move/sources/vault.move — `public struct Vault<phantom B, phantom Q, phantom S>`
// @rules      G7 G10
// @depends    ../sui/send.ts (preflight — the ONE simulation entry) · ../config.ts · ../util/errors.ts
// @facts      ★ THIS MODULE NEVER BROADCASTS. It builds read-only PTBs and simulates them through
// @facts        `preflight`, which is the same wrapper `sendChecked` uses. A "read" here is a
// @facts        simulation of a `public fun` getter, so every value returned is a value the chain
// @facts        itself computed — never a client-side reconstruction of on-chain state.
// @facts      ★ WHY DEVINSPECT AND NOT `getObject(...).json`: the JSON projection of a Move struct
// @facts        is explicitly documented upstream as varying between gRPC and JSON-RPC. Simulating
// @facts        the module's own accessors is transport-independent and cannot drift from Move.
// @facts      ★ TYPE ARGUMENTS ARE DISCOVERED, NOT CONFIGURED. `Vault<B,Q,S>` carries B, Q and S in
// @facts        its own object type, so reading them off the object makes a wrong `--type-args`
// @facts        flag impossible rather than merely unlikely. One network read, then every PTB in
// @facts        this run is built against what the chain actually holds.
// @facts      ⚠ A Sui shared object is passed as `tx.object(id)`; the SDK's resolution plugin turns
// @facts        it into a fully specified shared input during `prepareForSerialization`. Never hand
// @facts        a shared id to `tx.pure.address` — that compiles and then aborts on chain.
// @implements export interface ChainDeps / Deployment
// @implements export type VaultTypeArgs
// @implements export class MoveReturnError
// @implements export function parseStructType(type): ParsedStructType
// @implements export function applySender(deps, tx): Transaction
// @implements export async function inspect(deps, tx, what): Promise<readonly (readonly Uint8Array[])[]>
// @implements export function decodeU64 / decodeU8 / decodeBool / decodeBytes / decodeAddress
// @implements export async function readVaultTypeArgs(deps, vaultId): Promise<VaultTypeArgs>
// @forbidden  `signAndExecute` — this module reads (gates.ps1 send)
// @forbidden  constructing a Sui client (gates.ps1 transport) — the client is injected
// @forbidden  a canonical object id literal (gates.ps1 ids) — every id arrives as an argument
// @invariant  1. A simulation that reverts raises; it never returns a partially decoded value.
// @invariant  2. `parseStructType` is PURE and total: any unparseable type raises, never guesses.
// @invariant  3. Decoders reject a missing return value rather than substituting a zero.
// @ac         test/chainread.test.ts — type parsing, decoders, and revert-on-read
// @verify     npm run test -- chainread
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import { preflight, PreflightRevertError } from '../sui/send.js';
import type { ObjectId } from '../types.js';
import { AphoticError } from '../util/errors.js';

/** Everything a read needs: the config it was loaded with and an injected client. */
export interface ChainDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
}

/**
 * The three ids every v2 command needs. `registryId` is NOT in `config.ts` — see the note in
 * `../index.ts` on why it arrives as a flag/env at the composition root instead.
 */
export interface Deployment {
  /** `published-at`. EVERY `moveCall` target uses this, and it changes on every upgrade. */
  readonly packageId: ObjectId;
  /**
   * `original-id` — the first-published package. OMITTED ⇒ never upgraded ⇒ same as
   * {@link packageId}. Read it through {@link typeOrigin}, never directly.
   *
   * ⚠ THIS IS NOT A REDUNDANT COPY OF `packageId`. Three things resolve against the original id
   * and break silently against the published-at id once the package is upgraded:
   *   1. the `Vault<B,Q,S>` type arguments (a struct tag keeps its defining package forever),
   *   2. the `DepositReceipt`/`RedeemReceipt` type filter — a wrong one lists ZERO receipts and
   *      the claim crank reports "nothing to do" instead of failing,
   *   3. Seal's IBE namespace — `@mysten/seal` rejects any package whose version is not 1.
   */
  readonly originalPackageId?: ObjectId;
  readonly vaultId: ObjectId;
  readonly registryId: ObjectId;
}

/**
 * The package that type arguments, struct-type filters and Seal identities resolve against.
 *
 * NEVER a `moveCall` target: after an upgrade, calling the original id executes the OLD code.
 */
export function typeOrigin(d: Deployment): ObjectId {
  const original = d.originalPackageId;
  return original === undefined || original.trim() === '' ? d.packageId : original;
}

/** `[B, Q, S]` — base asset, auction quote, LP share coin. Read off the Vault's own type. */
export type VaultTypeArgs = readonly [string, string, string];

export interface ParsedStructType {
  readonly address: string;
  readonly module: string;
  readonly name: string;
  readonly typeArgs: readonly string[];
}

/** A Move call returned nothing, or returned something the decoder cannot read. */
export class MoveReturnError extends AphoticError {
  constructor(message: string) {
    super('BadMoveReturn', message);
  }
}

// ── type parsing ─────────────────────────────────────────────────────────────

/**
 * Split a fully qualified struct tag into its parts, honouring NESTED generics.
 *
 * A naive `split(',')` breaks on `Vault<Coin<A>, B, C>`; the depth counter is what makes this
 * total rather than usually-right (invariant 2).
 */
export function parseStructType(type: string): ParsedStructType {
  const trimmed = type.trim();
  const open = trimmed.indexOf('<');
  const head = open < 0 ? trimmed : trimmed.slice(0, open);
  const parts = head.split('::');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) {
    throw new MoveReturnError(`not a fully qualified struct type: ${type}`);
  }

  let typeArgs: string[] = [];
  if (open >= 0) {
    if (!trimmed.endsWith('>')) {
      throw new MoveReturnError(`unbalanced type arguments in: ${type}`);
    }
    const inner = trimmed.slice(open + 1, -1);
    typeArgs = splitTopLevel(inner).map((s) => s.trim());
    if (typeArgs.some((s) => s === '')) {
      throw new MoveReturnError(`empty type argument in: ${type}`);
    }
  }

  return {
    address: (parts[0] as string).trim(),
    module: (parts[1] as string).trim(),
    name: (parts[2] as string).trim(),
    typeArgs,
  };
}

function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '<') depth += 1;
    else if (c === '>') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) throw new MoveReturnError(`unbalanced type arguments in: <${inner}>`);
  out.push(inner.slice(start));
  return out;
}

// ── simulation ───────────────────────────────────────────────────────────────

/**
 * Stamp the keeper address onto a read PTB when we have one.
 *
 * A simulation still resolves a gas coin unless checks are disabled, and setting the sender keeps
 * the request byte-identical between a rehearsal read and the live one.
 */
export function applySender(deps: ChainDeps, tx: Transaction): Transaction {
  if (deps.cfg.sui.keeperAddress !== '') tx.setSender(deps.cfg.sui.keeperAddress);
  return tx;
}

/**
 * Simulate a read-only PTB and hand back the BCS return values, command by command.
 *
 * Invariant 1: a revert raises `PreflightRevertError` (classified `fatal` by ../util/backoff.ts,
 * because a getter that aborts will abort identically on the next attempt).
 */
export async function inspect(
  deps: ChainDeps,
  tx: Transaction,
  what: string,
): Promise<readonly (readonly Uint8Array[])[]> {
  const result = await preflight({ client: deps.client }, tx, what);
  if (!result.ok) throw new PreflightRevertError(what, result.error ?? 'unknown');
  return result.commandReturns;
}

/** One command's first return value, or a loud failure — never a substituted zero (invariant 3). */
export function returnValue(
  returns: readonly (readonly Uint8Array[])[],
  command: number,
  what: string,
): Uint8Array {
  const values = returns[command];
  if (values === undefined) {
    throw new MoveReturnError(`${what}: simulation produced no result for command ${command}`);
  }
  const first = values[0];
  if (first === undefined) {
    throw new MoveReturnError(`${what}: command ${command} returned no values`);
  }
  return first;
}

export function decodeU64(bytes: Uint8Array, what: string): bigint {
  try {
    return BigInt(bcs.u64().parse(bytes));
  } catch (err) {
    throw new MoveReturnError(`${what}: not a u64 — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function decodeU8(bytes: Uint8Array, what: string): number {
  try {
    return bcs.u8().parse(bytes);
  } catch (err) {
    throw new MoveReturnError(`${what}: not a u8 — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function decodeBool(bytes: Uint8Array, what: string): boolean {
  try {
    return bcs.bool().parse(bytes);
  } catch (err) {
    throw new MoveReturnError(`${what}: not a bool — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `vector<u8>` — a commitment, a ct hash, a Walrus blob id, a fills root. */
export function decodeBytes(bytes: Uint8Array, what: string): Uint8Array {
  try {
    return Uint8Array.from(bcs.vector(bcs.u8()).parse(bytes));
  } catch (err) {
    throw new MoveReturnError(`${what}: not a vector<u8> — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `address` or `ID` — both are 32 raw bytes in BCS. */
export function decodeAddress(bytes: Uint8Array, what: string): string {
  try {
    return bcs.Address.parse(bytes);
  } catch (err) {
    throw new MoveReturnError(`${what}: not an address — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── the vault's own type arguments ───────────────────────────────────────────

/**
 * Read `[B, Q, S]` off the shared Vault object (see the @facts note on why these are discovered
 * rather than configured), asserting the package matches the one we are about to call into.
 *
 * A vault published by a different package is a configuration error that would otherwise surface
 * as an opaque on-chain abort three commands later.
 */
export async function readVaultTypeArgs(
  deps: ChainDeps,
  /**
   * ⚠ THE **ORIGINAL** PACKAGE ID (see {@link typeOrigin}), not `published-at`. A struct tag
   * names the package that DEFINED it, so after any upgrade the vault's type origin stays on the
   * original id while `published-at` moves on. Comparing against `published-at` rejects the
   * keeper's own vault and takes every on-chain command down with it.
   */
  originPackageId: ObjectId,
  vaultId: ObjectId,
): Promise<VaultTypeArgs> {
  const { object } = await deps.client.core.getObject({ objectId: vaultId });
  const parsed = parseStructType(object.type);

  if (parsed.module !== 'vault' || parsed.name !== 'Vault') {
    throw new AphoticError(
      'NotAVault',
      `${vaultId} is a ${parsed.module}::${parsed.name}, not a vault::Vault — check --vault / VAULT_ID`,
    );
  }
  if (parsed.typeArgs.length !== 3) {
    throw new AphoticError(
      'NotAVault',
      `vault::Vault must have 3 type arguments (B, Q, S) — ${vaultId} has ${parsed.typeArgs.length}`,
    );
  }
  if (normalizeId(parsed.address) !== normalizeId(originPackageId)) {
    // An upgraded package keeps the ORIGINAL id in its types, so a mismatch against the ORIGINAL
    // id — and only against the original id — means the vault belongs to another deployment.
    throw new AphoticError(
      'PackageMismatch',
      `vault ${vaultId} has type origin ${parsed.address} but APHOTIC_ORIGINAL_PACKAGE_ID is ` +
        `${originPackageId} — these are different deployments; nothing built against one will ` +
        'apply to the other. (Set APHOTIC_ORIGINAL_PACKAGE_ID to the FIRST-published id, not the ' +
        'upgraded published-at id.)',
    );
  }

  return [parsed.typeArgs[0] as string, parsed.typeArgs[1] as string, parsed.typeArgs[2] as string];
}

/**
 * The object a transaction CREATED whose type is `<module>::<name>`.
 *
 * Two steps on purpose: effects name the created ids but not their types, and a transaction can
 * create more than one object. Confirming the type is what makes the answer the object we asked
 * for rather than whatever happened to be created first. An id is never predicted — a Sui object
 * id is derived from the transaction digest and a creation counter, and printing a guessed one
 * would send the operator to the wrong object for the rest of the cycle.
 */
export async function findCreatedObject(
  deps: ChainDeps,
  digest: string,
  module: string,
  name: string,
): Promise<ObjectId | undefined> {
  if (digest === '') return undefined;

  const result = (await deps.client.core.getTransaction({
    digest,
    include: { effects: true },
  })) as unknown as {
    readonly Transaction?: {
      readonly effects?: { readonly changedObjects?: readonly ChangedObjectLike[] } | undefined;
    };
  };

  const created = (result.Transaction?.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === 'Created')
    .map((c) => c.objectId);
  if (created.length === 0) return undefined;

  const objects = await deps.client.core.getObjects({ objectIds: created });
  for (const object of objects.objects) {
    if (object instanceof Error) continue;
    try {
      const parsed = parseStructType(object.type);
      if (parsed.module === module && parsed.name === name) return object.objectId;
    } catch {
      // A non-struct type (a coin balance, a package) simply is not what we are looking for.
    }
  }
  return undefined;
}

interface ChangedObjectLike {
  readonly objectId: string;
  readonly idOperation: string;
}

/** `0x2` and `0x0000…02` are the same package. Compare canonically, never textually. */
export function normalizeId(id: string): string {
  const hex = id.startsWith('0x') || id.startsWith('0X') ? id.slice(2) : id;
  if (hex === '' || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new MoveReturnError(`not a hex object id: ${id}`);
  }
  return `0x${hex.toLowerCase().padStart(64, '0')}`;
}
