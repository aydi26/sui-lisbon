// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §9 (devInspect-before-send), §2 constraint 5 (recomputable)
// @spec       move/sources/*.move — every read below is a `public fun` accessor
// @rules      G7 G8
// @depends    ./suiClient.ts (F1) · ../config.ts (F1)
// @facts      THE ONE READ PATH. A screen never constructs a client and never
// @facts        calls simulateTransaction itself; it calls a typed reader in
// @facts        vaultRead.ts / batchRead.ts, which calls `readMove` here.
// @facts      gRPC v2 has no `devInspectTransactionBlock`. Its equivalent is
// @facts        `client.core.simulateTransaction({ transaction, include:
// @facts        { commandResults: true }, checksEnabled: false })`, which returns
// @facts        per-command `returnValues[].bcs` — the BCS of each Move return.
// @facts        `checksEnabled: false` is what lets a read run with a sender that
// @facts        owns no gas; `doGasSelection` is already false on that path.
// @facts      ⚠ NOTHING HERE RUNS ON MOUNT. Every reader is called from a click
// @facts        handler, so a screen that has not been asked for data makes no
// @facts        request at all (app/test/routes.smoke.test.tsx asserts it).
// @facts      ⚠ `Vault<B, Q, S>` is GENERIC and the share type `S` is NOT in any
// @facts        VITE_* var — it is whatever coin the TreasuryCap passed to
// @facts        `vault::create` minted. So we do not guess it: `objectTypeArgs`
// @facts        reads the live object's own type string and splits its generic
// @facts        parameters. One read, cached, and it can never disagree with the
// @facts        object it is about to call.
// @implements export const ZERO_ADDRESS · CLOCK_ID
// @implements export class NotWiredError
// @implements export function aphoticTarget(module, fn): string
// @implements export function requireWired(...): void
// @implements export type SimulateFn · ReturnValues
// @implements export function readMove(build, opts?): Promise<ReturnValues>
// @implements export function objectTypeArgs(objectType): string[]
// @implements export async function readObjectType(objectId, opts?): Promise<string>
// @implements export const decode = { u8, u64, bool, address, bytes, u64Vec, byteVec }
// @implements export function first(values, i): Uint8Array
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  a canonical on-chain id literal — everything comes from config (G7)
// @forbidden  a read fired from a component's mount effect
// @invariant  1. Every reader takes an injectable `simulate`, so the offline test
//                suite drives the same code path the browser drives.
// @invariant  2. A missing config id throws NotWiredError BEFORE any network call.
// @invariant  3. Decoders never coerce a u64 to `number` — sats are bigint.
// @ac         app/test/moveRead.test.ts — decoders round-trip; type-arg splitting
//             survives nested generics; an unwired read throws before the wire.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- moveRead
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import { config } from '../config';
import { getSuiClient } from './suiClient';

/** 32 zero bytes. A read has no sender in any meaningful sense; this is the stand-in. */
export const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;

/** The shared `Clock`. A framework object, not one of ours. */
export const CLOCK_ID = '0x6';

/** Thrown before any network call when a required id is empty in this build. */
export class NotWiredError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(
      `${keys.join(' and ')} ${keys.length === 1 ? 'is' : 'are'} empty in this build — ` +
        'there is nothing on chain to read. Set it before `vite build`; it is inlined, not runtime.',
    );
    this.name = 'NotWiredError';
    this.keys = keys;
  }
}

/** Throws NotWiredError listing every named env key whose value is empty. */
export function requireWired(entries: readonly (readonly [string, string])[]): void {
  const missing = entries.filter(([, value]) => value.length === 0).map(([key]) => key);
  if (missing.length > 0) throw new NotWiredError(missing);
}

/** `<package>::<module>::<fn>`. Throws rather than build a call against `''`. */
export function aphoticTarget(moduleName: string, fn: string): string {
  requireWired([['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId]]);
  return `${config.aphotic.packageId}::${moduleName}::${fn}`;
}

/** BCS of each return value, per command, in command order. */
export type ReturnValues = readonly (readonly Uint8Array[])[];

/** Injected so the test suite exercises the readers without a socket. */
export type SimulateFn = (tx: Transaction) => Promise<ReturnValues>;

export interface ReadOptions {
  /** Override the transport. Tests always do. */
  readonly simulate?: SimulateFn;
  /** Who the simulation runs as. Reads do not care, but the field must be set. */
  readonly sender?: string | null;
}

/** The live transport: gRPC `simulateTransaction` with command outputs. */
function liveSimulate(sender: string): SimulateFn {
  return async (tx: Transaction) => {
    tx.setSenderIfNotSet(sender);
    const result = await getSuiClient().core.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      checksEnabled: false,
    });
    const commands = result.commandResults ?? [];
    return commands.map((command) => command.returnValues.map((value) => value.bcs));
  };
}

/**
 * Run a read-only PTB and hand back every command's return values.
 *
 * `build` receives a fresh `Transaction`; add one `moveCall` per value you want.
 * Nothing is signed, nothing is broadcast, and no gas is selected.
 */
export async function readMove(
  build: (tx: Transaction) => void,
  opts?: ReadOptions,
): Promise<ReturnValues> {
  const tx = new Transaction();
  build(tx);
  const sender = opts?.sender ?? ZERO_ADDRESS;
  tx.setSenderIfNotSet(sender);
  const simulate = opts?.simulate ?? liveSimulate(sender);
  return simulate(tx);
}

/**
 * The generic parameters of a Move type string, split at the TOP level only, so
 * `Vault<0x2::coin::Coin<0x3::a::B>, 0x4::c::D>` yields two entries and not four.
 */
export function objectTypeArgs(objectType: string): string[] {
  const open = objectType.indexOf('<');
  if (open < 0 || !objectType.endsWith('>')) return [];
  const inner = objectType.slice(open + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '<') depth += 1;
    else if (c === '>') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Injected object-type read, so the readers stay testable offline. */
export type ObjectTypeFn = (objectId: string) => Promise<string>;

export async function readObjectType(objectId: string, fn?: ObjectTypeFn): Promise<string> {
  if (fn !== undefined) return fn(objectId);
  const response = await getSuiClient().core.getObject({ objectId });
  return response.object.type;
}

// ── decoders ────────────────────────────────────────────────────────────────
// Every one takes the BCS of ONE Move return value. u64 stays bigint: sats are
// money and `number` loses the top 11 bits of a u64.

const U8 = bcs.u8();
const U64 = bcs.u64();
const BOOL = bcs.bool();
const BYTES = bcs.vector(bcs.u8());
const U64S = bcs.vector(bcs.u64());
const BYTE_VECS = bcs.vector(bcs.vector(bcs.u8()));

export const decode = {
  u8: (b: Uint8Array): number => U8.parse(b),
  u64: (b: Uint8Array): bigint => BigInt(U64.parse(b)),
  bool: (b: Uint8Array): boolean => BOOL.parse(b),
  address: (b: Uint8Array): string => bcs.Address.parse(b),
  /** Move `vector<u8>` — a digest, a root, a blob id. */
  bytes: (b: Uint8Array): Uint8Array => Uint8Array.from(BYTES.parse(b)),
  u64Vec: (b: Uint8Array): bigint[] => U64S.parse(b).map((v) => BigInt(v)),
  byteVec: (b: Uint8Array): Uint8Array[] => BYTE_VECS.parse(b).map((v) => Uint8Array.from(v)),
} as const;

/**
 * The i-th command's FIRST return value. Reads are one value per command, so
 * this is the shape every caller wants — and it says which command failed
 * rather than dereferencing undefined.
 */
export function first(values: ReturnValues, i: number): Uint8Array {
  return nth(values, i, 0);
}

/** The j-th return value of the i-th command — for the `(u64, u64)` accessors. */
export function nth(values: ReturnValues, i: number, j: number): Uint8Array {
  const command = values[i];
  const value = command?.[j];
  if (value === undefined) {
    throw new Error(
      `command ${i} returned no value at position ${j} (got ${values.length} command result(s)) — ` +
        'the simulation ran but the Move function returned nothing there.',
    );
  }
  return value;
}
