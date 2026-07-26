// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#5.1 (canonical order tie-break is "submitter BYTES ascending")
// @spec       docs/DESIGN-V2.md#3 ([16..48) bcs address batch object id — 32 RAW bytes)
// @rules      G10
// @facts      A Sui address is exactly 32 bytes. BCS encodes it as 32 RAW bytes — no length
// @facts        prefix, unlike `vector<u8>`.
// @facts      ★ Lexicographic order on the normalised lowercase 64-char hex string is IDENTICAL
// @facts        to lexicographic order on the 32 raw bytes, because every byte maps to exactly
// @facts        two hex chars from a monotone alphabet. That is why the clearing sort may
// @facts        compare strings and still match Move's `vector<u8>` comparison.
// @implements export const ADDRESS_LEN: number
// @implements export function normalizeAddress(a: string): string
// @implements export function addressBytes(a: string): Uint8Array
// @implements export function addressFromBytes(b: Uint8Array): string
// @implements export function compareAddress(a: string, b: string): number
// @forbidden  comparing un-normalised addresses — `0x1` and `0x0…01` are the same address
// @invariant  1. normalizeAddress is idempotent and always returns `0x` + 64 lowercase hex.
// @invariant  2. compareAddress(a,b) has the same sign as memcmp(addressBytes(a), addressBytes(b)).
// @ac         test/address.test.ts — padding, idempotence, byte-order equivalence fuzz
// @verify     npx vitest run address
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { fromHex, toHex } from './hash.js';

/** A Sui address is 32 bytes. */
export const ADDRESS_LEN = 32;

const HEX_RE = /^[0-9a-f]*$/;

/** Left-pad to `0x` + 64 lowercase hex. Accepts short forms (`0x1`) and bare hex. */
export function normalizeAddress(a: string): string {
  const raw = (a.startsWith('0x') || a.startsWith('0X') ? a.slice(2) : a).toLowerCase();
  if (!HEX_RE.test(raw)) throw new RangeError(`not a hex address: ${a}`);
  if (raw.length > ADDRESS_LEN * 2) throw new RangeError(`address longer than 32 bytes: ${a}`);
  return `0x${raw.padStart(ADDRESS_LEN * 2, '0')}`;
}

/** The 32 raw bytes BCS writes for a `address`. */
export function addressBytes(a: string): Uint8Array {
  const b = fromHex(normalizeAddress(a));
  if (b.length !== ADDRESS_LEN) throw new RangeError(`address is not 32 bytes: ${a}`);
  return b;
}

/** Inverse of {@link addressBytes}. */
export function addressFromBytes(b: Uint8Array): string {
  if (b.length !== ADDRESS_LEN) throw new RangeError(`address must be 32 bytes, got ${b.length}`);
  return toHex(b);
}

/** `memcmp` on the 32 raw bytes: negative / 0 / positive. */
export function compareAddress(a: string, b: string): number {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
