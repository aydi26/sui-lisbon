// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.test.support
// @phase      2
// @status     DONE
// @spec       keeper/vitest.config.ts (@forbidden any test that opens a network socket)
// @spec       ../../src/sui/send.ts — the simulate/execute surface this fake stands in for
// @rules      G7 G10
// @depends    @mysten/sui/bcs · @mysten/sui/transactions · @mysten/sui/keypairs/ed25519
// @facts      ★ NO SOCKET IS EVER OPENED. Every keeper test runs offline; a fake client is not a
// @facts        convenience here, it is the acceptance criterion.
// @facts      ★ THE FAKE RECORDS WHAT WAS SENT. `sent` holds every transaction handed to
// @facts        `signAndExecuteTransaction`, which is how a test asserts that a transaction which
// @facts        would revert was NEVER broadcast — the invariant ../../src/sui/send.ts exists for.
// @facts      ⚠ PTB shape is asserted off `tx.getData()`, NOT off a built transaction. Building
// @facts        requires object resolution against a live node; the command list does not.
// @implements export interface FakeClientOptions / FakeClient / MoveCallShape
// @implements export function fakeClient(opts): FakeClient
// @implements export function moveCalls(tx): MoveCallShape[]
// @implements export function u64 / u8 / boolBcs / vecU8 / addressBcs
// @implements export function testSigner(): Signer
// @implements export function testConfig(env?): Config
// @forbidden  a real network call from any test that imports this file
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';

import { loadConfig, type Config } from '../../src/config.js';
import type { AnySuiClient } from '../../src/sui/client.js';

// ── BCS helpers for canned return values ─────────────────────────────────────

export const u64 = (v: bigint | number): Uint8Array => bcs.u64().serialize(v).toBytes();
export const u8 = (v: number): Uint8Array => bcs.u8().serialize(v).toBytes();
export const boolBcs = (v: boolean): Uint8Array => bcs.bool().serialize(v).toBytes();
export const vecU8 = (v: Uint8Array): Uint8Array =>
  bcs.vector(bcs.u8()).serialize(Array.from(v)).toBytes();
export const addressBcs = (v: string): Uint8Array => bcs.Address.serialize(v).toBytes();

/** A canonical 32-byte id from a single nibble — short, distinct, and valid. */
export const id = (n: string): string => `0x${n.repeat(64).slice(0, 64)}`;

// ── the fake client ──────────────────────────────────────────────────────────

export interface FakeObject {
  readonly objectId: string;
  readonly type: string;
  readonly content?: Uint8Array;
}

export interface FakeClientOptions {
  /** Queue of per-simulation return values: one entry per `simulateTransaction` call. */
  readonly simulations?: readonly (readonly Uint8Array[][])[];
  /** Force a simulated revert. When set, NOTHING may be broadcast. */
  readonly revert?: string;
  readonly objects?: readonly FakeObject[];
  readonly owned?: Readonly<Record<string, readonly FakeObject[]>>;
  /** Object ids created by the transaction with this digest. */
  readonly created?: Readonly<Record<string, readonly string[]>>;
  readonly digest?: string;
}

export interface FakeClient {
  readonly client: AnySuiClient;
  /** Every transaction that reached `signAndExecuteTransaction`. */
  readonly sent: Transaction[];
  /** Every transaction that reached `simulateTransaction`. */
  readonly simulated: Transaction[];
}

export function fakeClient(opts: FakeClientOptions = {}): FakeClient {
  const sent: Transaction[] = [];
  const simulated: Transaction[] = [];
  const queue = [...(opts.simulations ?? [])];
  const digest = opts.digest ?? 'FAKEDIGEST';

  const core = {
    simulateTransaction(input: { transaction: Transaction }): Promise<unknown> {
      simulated.push(input.transaction);
      if (opts.revert !== undefined) {
        return Promise.resolve({
          $kind: 'FailedTransaction',
          FailedTransaction: { status: { success: false, error: opts.revert } },
        });
      }
      const next = queue.shift() ?? [];
      return Promise.resolve({
        $kind: 'Transaction',
        Transaction: { status: { success: true } },
        commandResults: next.map((values) => ({ returnValues: values.map((v) => ({ bcs: v })) })),
      });
    },
    signAndExecuteTransaction(input: { transaction: Transaction }): Promise<unknown> {
      sent.push(input.transaction);
      return Promise.resolve({ $kind: 'Transaction', Transaction: { digest } });
    },
    getObject(input: { objectId: string }): Promise<unknown> {
      const found = (opts.objects ?? []).find((o) => o.objectId === input.objectId);
      if (found === undefined) return Promise.reject(new Error(`no such object ${input.objectId}`));
      return Promise.resolve({ object: found });
    },
    getObjects(input: { objectIds: readonly string[] }): Promise<unknown> {
      return Promise.resolve({
        objects: input.objectIds.map(
          (o) => (opts.objects ?? []).find((x) => x.objectId === o) ?? new Error(`missing ${o}`),
        ),
      });
    },
    listOwnedObjects(input: { owner: string; type?: string }): Promise<unknown> {
      const all = opts.owned?.[input.owner] ?? [];
      const objects = input.type === undefined ? all : all.filter((o) => o.type === input.type);
      return Promise.resolve({ objects, hasNextPage: false, cursor: null });
    },
    getTransaction(input: { digest: string }): Promise<unknown> {
      const ids = opts.created?.[input.digest] ?? [];
      return Promise.resolve({
        $kind: 'Transaction',
        Transaction: {
          digest: input.digest,
          effects: {
            changedObjects: ids.map((objectId) => ({ objectId, idOperation: 'Created' })),
          },
        },
      });
    },
  };

  return { client: { core } as unknown as AnySuiClient, sent, simulated };
}

// ── PTB introspection ────────────────────────────────────────────────────────

export interface MoveCallShape {
  readonly target: string;
  readonly typeArguments: readonly string[];
  readonly argumentKinds: readonly string[];
}

/**
 * The move calls in a transaction, read off `getData()`.
 *
 * Deliberately NOT `tx.build()`: building resolves objects against a node, and the command list
 * — which is what every shape assertion here is about — needs no network at all.
 *
 * ⚠ An argument is `{$kind:'Input', Input:<index>}` — a POINTER into `data.inputs`. Reporting the
 * pointer's kind would make every argument read `Input`, and an assertion like
 * `not.toContain('Pure')` would then pass for a transaction that is full of pure arguments. The
 * indirection is resolved here so a shape assertion means what it says.
 */
export function moveCalls(tx: Transaction): MoveCallShape[] {
  const data = tx.getData();
  const inputs = data.inputs as { $kind: string }[];
  const kindOf = (arg: { $kind: string; Input?: number }): string =>
    arg.$kind === 'Input' && arg.Input !== undefined
      ? (inputs[arg.Input]?.$kind ?? 'MissingInput')
      : arg.$kind;

  const out: MoveCallShape[] = [];
  for (const command of data.commands) {
    const call = (command as { MoveCall?: {
      package: string;
      module: string;
      function: string;
      typeArguments: string[];
      arguments: { $kind: string; Input?: number }[];
    } }).MoveCall;
    if (call === undefined) continue;
    out.push({
      target: `${call.package}::${call.module}::${call.function}`,
      typeArguments: call.typeArguments,
      argumentKinds: call.arguments.map(kindOf),
    });
  }
  return out;
}

/** Every command kind in order — `MoveCall`, `TransferObjects`, … */
export function commandKinds(tx: Transaction): string[] {
  return tx.getData().commands.map((c) => (c as { $kind: string }).$kind);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

export function testSigner(): Signer {
  return Ed25519Keypair.generate();
}

export function testConfig(env: Record<string, string | undefined> = {}): Config {
  return loadConfig({ HASHI_ADAPTER: 'mock', ...env });
}
