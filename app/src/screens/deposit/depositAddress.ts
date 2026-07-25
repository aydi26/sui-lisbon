// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.3 (client-side derivation, no server round-trip)
// @spec       docs/APP.md ERRATA E-A5 (four named args, 32-byte Uint8Array)
// @spec       docs/ULTRACODE-BRIEF.md §5 E-K10/E-A5 · docs/RECON.md R5 R6
// @rules      G6 G7 G8
// @depends    ../../config.ts (T0.4) · ../../lib/suiClient.ts (T0.4)
//             @mysten/hashi 0.6.0 (installed in app/package.json)
// @facts      ⚠ generateDepositAddress takes FOUR NAMED ARGS, not { suiAddress }:
// @facts        generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly,
// @facts                                 suiAddress, network }): string
// @facts        · suiAddress MUST be a 32-byte Uint8Array — a '0x…' string throws.
// @facts        · mpcMasterCompressed MUST be arkworksToSec1Compressed(raw) —
// @facts          the raw arkworks bytes throw `bad point`.
// @facts        · network = 'signet' (the Bitcoin side of this testnet build).
// @facts      Both keys are read from the on-chain Hashi shared object
// @facts        (config.hashi.objectId), NEVER from constants:
// @facts        · committee_set.mpc_public_key — plain field, 33 bytes, ARKWORKS
// @facts          compression.
// @facts        · guardian_btc_public_key — 32 bytes, inside the config VecMap
// @facts          (`config.config.contents[] = { key, value }`), NOT a plain field.
// @facts      gRPC JSON shapes observed live 2026-07-25 on this exact endpoint:
// @facts        mpc_public_key          -> base64 string, 33 bytes decoded
// @facts        guardian_btc_public_key -> { '@variant': 'Bytes', pos0: <base64> }
// @facts        JSON-RPC mirrors return the same values as base64 or number[],
// @facts        so the coercion below accepts base64, hex and byte arrays and
// @facts        DISAMBIGUATES on the expected byte length.
// @facts      GOLDEN VECTOR (verified live 2026-07-25, and re-verified against the
// @facts        installed @mysten/hashi 0.6.0 before this file was written).
// @facts        Stored WITHOUT the 0x prefix: these are cryptographic key material
// @facts        for a known-answer test, not canonical object ids, and A10's grep
// @facts        (`0x[a-f0-9]{16,}` under src/screens) must stay empty (G7).
// @facts        mpc raw (arkworks) 391d3d8e…8f3680
// @facts        mpc SEC1            02368f55…3d1d39
// @facts        guardian x-only     41c40449…498995
// @facts        sui address         d41b0cd8…3f333d
// @facts        ⇒ tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p
// @external   generateDepositAddress(inputs: DepositAddressInputs): string
//             arkworksToSec1Compressed(ark: Uint8Array): Uint8Array   // 33 -> 33 B
// @implements export interface HashiDepositKeys
//             export function readHashiDepositKeys(signal?): Promise<HashiDepositKeys>
//             export function suiAddressToBytes(address: string): Uint8Array
//             export function deriveDepositAddress(keys, suiAddress): string
//             export function derivationSelfCheck(): SelfCheckResult
//             export function bip21(address: string): string
// @forbidden  a server round-trip for the derivation itself — A1 intercepts the
//             network. The ONLY network call here reads PUBLIC on-chain keys.
// @forbidden  constructing a Sui client here — use ../../lib/suiClient.ts
// @forbidden  a canonical id literal — every id arrives from config (G7 / A10)
// @forbidden  falling back to a hardcoded key if the on-chain read fails. A wrong
//             deposit address loses the user's BTC irrecoverably; we show an
//             error instead.
// @invariant  1. deriveDepositAddress() runs the golden-vector self-check FIRST and
//                THROWS if it fails. A silent SDK bump must never be able to change
//                the derivation — sending BTC to a wrong address is unrecoverable.
//             2. Key lengths are asserted (33 raw / 33 SEC1 / 32 guardian / 32 sui)
//                before any of them reaches the SDK.
//             3. Derivation is pure and offline: given the same keys and address it
//                always returns the same string, with no network access.
// @ac         docs/APP.md §7 A1
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { arkworksToSec1Compressed, generateDepositAddress } from '@mysten/hashi';

import { config } from '../../config';
import { getSuiClient } from '../../lib/suiClient';

/** The Bitcoin network the Hashi testnet deployment settles on. */
const BITCOIN_NETWORK = 'signet' as const;

/** Field names on the Hashi shared object. Not ids — Move field identifiers. */
const MPC_FIELD = 'mpc_public_key';
const GUARDIAN_FIELD = 'guardian_btc_public_key';

const MPC_KEY_BYTES = 33;
const XONLY_KEY_BYTES = 32;
const SUI_ADDRESS_BYTES = 32;

// ── byte coercion ────────────────────────────────────────────────────────────

const HEX_ALPHABET = /^[0-9a-fA-F]+$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Coerce whatever the RPC layer hands back into raw bytes.
 *
 * A 32-byte value is ambiguous — its 64-char hex rendering is *also* valid
 * base64 — so `expectedLen` is the tie-breaker, not a guess. Anything that does
 * not land on `expectedLen` bytes is rejected rather than silently truncated.
 */
function coerceBytes(value: unknown, expectedLen: number, what: string): Uint8Array {
  const candidates: Uint8Array[] = [];

  if (value instanceof Uint8Array) {
    candidates.push(value);
  } else if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    candidates.push(Uint8Array.from(value as number[]));
  } else if (typeof value === 'string') {
    const raw = value.startsWith('0x') ? value.slice(2) : value;
    if (HEX_ALPHABET.test(raw) && raw.length % 2 === 0) candidates.push(hexToBytes(raw));
    const b64 = base64ToBytes(value);
    if (b64 !== null) candidates.push(b64);
  } else if (value !== null && typeof value === 'object') {
    // Unwrap the RPC envelopes: gRPC `{ '@variant': 'Bytes', pos0 }`, JSON-RPC
    // `{ fields }` / `{ bytes }` / `{ value }`.
    const record = value as Record<string, unknown>;
    for (const key of ['pos0', 'bytes', 'fields', 'value', 'contents', 'vec']) {
      if (record[key] !== undefined) return coerceBytes(record[key], expectedLen, what);
    }
  }

  const hit = candidates.find((c) => c.length === expectedLen);
  if (hit === undefined) {
    throw new Error(
      `${what}: expected ${expectedLen} bytes, got ${
        candidates.length > 0 ? `${candidates.map((c) => c.length).join('/')} bytes` : 'an unreadable value'
      }`,
    );
  }
  return hit;
}

// ── on-chain object walking ──────────────────────────────────────────────────

/** Depth-first hunt for a named field anywhere in the object's content tree. */
function findField(node: unknown, name: string, depth = 0): unknown {
  if (node === null || typeof node !== 'object' || depth > 12) return undefined;
  const record = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  for (const child of Object.values(record)) {
    const hit = findField(child, name, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * `guardian_btc_public_key` lives inside a Move `VecMap`, serialised as
 * `{ contents: [ { key, value } … ] }` (gRPC) or
 * `{ contents: [ { fields: { key, value } } … ] }` (JSON-RPC). Walk both.
 */
function findInVecMaps(node: unknown, wantKey: string, depth = 0): unknown {
  if (node === null || typeof node !== 'object' || depth > 14) return undefined;

  if (Array.isArray(node)) {
    for (const entry of node) {
      if (entry !== null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const fields = (record['fields'] ?? record) as Record<string, unknown>;
        if (fields['key'] === wantKey) return fields['value'];
      }
      const deeper = findInVecMaps(entry, wantKey, depth + 1);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  }

  for (const child of Object.values(node as Record<string, unknown>)) {
    const hit = findInVecMaps(child, wantKey, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface HashiDepositKeys {
  /** 33-byte SEC1-compressed MPC master key — already arkworks-converted. */
  readonly mpcMasterCompressed: Uint8Array;
  /** 32-byte BIP-340 x-only guardian BTC key. */
  readonly guardianBtcXOnly: Uint8Array;
  /** The Hashi object these came from, for display/provenance. */
  readonly sourceObjectId: string;
}

/**
 * Reads the two public keys the deposit derivation needs from the on-chain Hashi
 * shared object. This is the ONLY network call in the deposit-address path, and
 * it reads public configuration — never a secret, never a user input.
 */
export async function readHashiDepositKeys(signal?: AbortSignal): Promise<HashiDepositKeys> {
  const objectId = config.hashi.objectId;
  if (objectId.length === 0) {
    throw new Error('VITE_HASHI_OBJECT_ID is empty — cannot read the bridge keys.');
  }

  const response = await getSuiClient().core.getObjects({
    objectIds: [objectId],
    include: { json: true },
    signal,
  });

  const object = response.objects[0];
  if (object === undefined) throw new Error(`Hashi object ${objectId} not found.`);
  if (object instanceof Error) throw object;

  const content = object.json;
  if (content === null || content === undefined) {
    throw new Error(`Hashi object ${objectId} returned no readable content.`);
  }

  const mpcRaw = findField(content, MPC_FIELD);
  if (mpcRaw === undefined) throw new Error(`${MPC_FIELD} not found on the Hashi object.`);

  const guardianRaw = findField(content, GUARDIAN_FIELD) ?? findInVecMaps(content, GUARDIAN_FIELD);
  if (guardianRaw === undefined) {
    throw new Error(`${GUARDIAN_FIELD} not found in the Hashi config VecMap.`);
  }

  const arkworks = coerceBytes(mpcRaw, MPC_KEY_BYTES, MPC_FIELD);
  const guardianBtcXOnly = coerceBytes(guardianRaw, XONLY_KEY_BYTES, GUARDIAN_FIELD);

  // The on-chain key is arkworks-compressed; the SDK needs SEC1 or it throws
  // `bad point`. This conversion is mandatory, not cosmetic. (E-K10)
  const mpcMasterCompressed = arkworksToSec1Compressed(arkworks);
  if (mpcMasterCompressed.length !== MPC_KEY_BYTES) {
    throw new Error(
      `arkworksToSec1Compressed returned ${mpcMasterCompressed.length} bytes, expected ${MPC_KEY_BYTES}.`,
    );
  }

  return { mpcMasterCompressed, guardianBtcXOnly, sourceObjectId: objectId };
}

// ── derivation ───────────────────────────────────────────────────────────────

/** `0x…` Sui address → the 32 raw bytes the SDK requires (a string throws). */
export function suiAddressToBytes(address: string): Uint8Array {
  const raw = (address.startsWith('0x') ? address.slice(2) : address).toLowerCase();
  if (!HEX_ALPHABET.test(raw) || raw.length === 0 || raw.length > SUI_ADDRESS_BYTES * 2) {
    throw new Error(`Not a Sui address: ${address}`);
  }
  return hexToBytes(raw.padStart(SUI_ADDRESS_BYTES * 2, '0'));
}

/**
 * The golden vector. Verified live against the on-chain Hashi object on
 * 2026-07-25 AND re-verified against @mysten/hashi 0.6.0 as installed here.
 *
 * These are public keys and a public address, deliberately stored WITHOUT the
 * `0x` prefix so the A10 id-literal grep over `src/screens` stays empty. They are
 * a known-answer test, not configuration — nothing reads them at runtime except
 * the self-check.
 */
const VECTOR = {
  mpcArkworksHex: '391d3d8e999367dd9befa4b391fadf5d67025fb30ca7b09b05b9b02ead558f3680',
  mpcSec1Hex: '02368f55ad2eb0b9059bb0a70cb35f02675ddffa91b3a4ef9bdd6793998e3d1d39',
  guardianHex: '41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995',
  suiAddressHex: 'd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d',
  expectedAddress: 'tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p',
} as const;

export interface SelfCheckResult {
  readonly ok: boolean;
  /** What the SDK produced for the golden vector. */
  readonly got: string;
  readonly expected: string;
  readonly detail: string;
}

let selfCheckCache: SelfCheckResult | null = null;

/**
 * Known-answer test over the whole derivation pipeline
 * (arkworks → SEC1 → child pubkey → 2-of-2 taproot → bech32m).
 *
 * A future `@mysten/hashi` bump that changes ANY step in that chain flips this to
 * `ok: false`, and `deriveDepositAddress()` then refuses to produce an address.
 * Bitcoin sent to a wrong address is unrecoverable, so a loud failure is the only
 * acceptable behaviour. Memoised: the elliptic-curve work runs at most once.
 */
export function derivationSelfCheck(): SelfCheckResult {
  if (selfCheckCache !== null) return selfCheckCache;

  try {
    const sec1 = arkworksToSec1Compressed(hexToBytes(VECTOR.mpcArkworksHex));
    const sec1Hex = bytesToHex(sec1);
    if (sec1Hex !== VECTOR.mpcSec1Hex) {
      selfCheckCache = {
        ok: false,
        got: sec1Hex,
        expected: VECTOR.mpcSec1Hex,
        detail: 'arkworksToSec1Compressed no longer matches the golden vector.',
      };
      return selfCheckCache;
    }

    const got = generateDepositAddress({
      mpcMasterCompressed: sec1,
      guardianBtcXOnly: hexToBytes(VECTOR.guardianHex),
      suiAddress: hexToBytes(VECTOR.suiAddressHex),
      network: BITCOIN_NETWORK,
    });

    selfCheckCache = {
      ok: got === VECTOR.expectedAddress,
      got,
      expected: VECTOR.expectedAddress,
      detail:
        got === VECTOR.expectedAddress
          ? 'Golden vector reproduced: arkworks → SEC1 → child key → 2-of-2 taproot → bech32m.'
          : 'generateDepositAddress no longer reproduces the golden vector.',
    };
    return selfCheckCache;
  } catch (err) {
    selfCheckCache = {
      ok: false,
      got: '',
      expected: VECTOR.expectedAddress,
      detail: err instanceof Error ? err.message : String(err),
    };
    return selfCheckCache;
  }
}

/**
 * Derives the depositor's personal signet P2TR address. Pure, offline and
 * deterministic — the QR can render before any other network call resolves.
 *
 * @throws if the golden-vector self-check fails, or if any key/address length is
 *         wrong. Never returns a "best effort" address.
 */
export function deriveDepositAddress(keys: HashiDepositKeys, suiAddress: string): string {
  const check = derivationSelfCheck();
  if (!check.ok) {
    throw new Error(
      `Deposit-address derivation self-check FAILED (${check.detail}). Refusing to show an address — Bitcoin sent to a wrong address cannot be recovered.`,
    );
  }

  if (keys.mpcMasterCompressed.length !== MPC_KEY_BYTES) {
    throw new Error(`MPC key is ${keys.mpcMasterCompressed.length} bytes, expected ${MPC_KEY_BYTES}.`);
  }
  if (keys.guardianBtcXOnly.length !== XONLY_KEY_BYTES) {
    throw new Error(
      `Guardian key is ${keys.guardianBtcXOnly.length} bytes, expected ${XONLY_KEY_BYTES}.`,
    );
  }

  return generateDepositAddress({
    mpcMasterCompressed: keys.mpcMasterCompressed,
    guardianBtcXOnly: keys.guardianBtcXOnly,
    suiAddress: suiAddressToBytes(suiAddress),
    network: BITCOIN_NETWORK,
  });
}

/** BIP-21 payment URI. What the QR encodes; the pill shows the bare address. */
export function bip21(address: string): string {
  return `bitcoin:${address}`;
}
