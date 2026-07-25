// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/RECON.md#r7 (addr_len == 20 || addr_len == 32 — EInvalidBitcoinAddress)
// @spec       docs/KEEPER.md §2.1 (`BtcAddress = Uint8Array`)
// @rules      G2 G7
// @facts      BTC_ADDR_LEN_P2WPKH = 20
// @facts      BTC_ADDR_LEN_P2TR   = 32
// @facts      hashi::withdraw::request_withdrawal asserts the witness-program length is 20 or 32.
// @implements export const BTC_ADDR_LEN_P2WPKH: 20
// @implements export const BTC_ADDR_LEN_P2TR: 32
// @implements export function isValidBtcWitnessProgram(bytes: Uint8Array): boolean
// @implements export function assertBtcWitnessProgram(bytes: Uint8Array): Uint8Array
// @implements export function bytesToHex(bytes: Uint8Array): string
// @implements export function hexToBytes(hex: string): Uint8Array
// @implements export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
// @forbidden  encoding/decoding real bech32 here — the keeper only ever handles witness PROGRAMS
// @invariant  1. assertBtcWitnessProgram throws InvalidBitcoinAddressError for any other length.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { fromHex, toHex } from '@mysten/sui/utils';

import { InvalidBitcoinAddressError } from './errors.js';

/** P2WPKH witness program length (bytes). */
export const BTC_ADDR_LEN_P2WPKH = 20 as const;
/** P2TR witness program length (bytes). */
export const BTC_ADDR_LEN_P2TR = 32 as const;

export function isValidBtcWitnessProgram(bytes: Uint8Array): boolean {
  return bytes.length === BTC_ADDR_LEN_P2WPKH || bytes.length === BTC_ADDR_LEN_P2TR;
}

/** Mirrors the on-chain assert in `hashi::withdraw::request_withdrawal` (docs/RECON.md R7). */
export function assertBtcWitnessProgram(bytes: Uint8Array): Uint8Array {
  if (!isValidBtcWitnessProgram(bytes)) {
    throw new InvalidBitcoinAddressError(bytes.length);
  }
  return bytes;
}

/** Lowercase hex, no `0x` prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes);
}

/** Accepts with or without a `0x` prefix. */
export function hexToBytes(hex: string): Uint8Array {
  return fromHex(hex);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
