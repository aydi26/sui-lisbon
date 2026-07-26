// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#3 (inner id = bcs u64 ‖ bcs u64 ‖ bcs address, LITTLE-ENDIAN)
// @spec       docs/DESIGN-V2.md#5.6 (fills root hashes bcs(FillLeaf))
// @rules      G10
// @depends    ./address.ts
// @facts      ★ BCS INTEGERS ARE LITTLE-ENDIAN. `bcs::peel_u64` reads 8 bytes LE. This is the
// @facts        whole of finding F1 — the deleted vault.move decoded BIG-ENDIAN and the policy
// @facts        would never have opened.
// @facts      u8 = 1 byte · u64 = 8 bytes LE · u128 = 16 bytes LE
// @facts      address = 32 RAW bytes, NO length prefix
// @facts      vector<u8> = ULEB128 length ‖ bytes
// @facts      bool = 0x00 | 0x01
// @implements export class BcsWriter
// @implements export class BcsReader
// @implements export function uleb128(n: number): Uint8Array
// @implements export function encodeU64LE(n: bigint): Uint8Array
// @implements export function encodeU128LE(n: bigint): Uint8Array
// @implements export function encodeU64BE(n: bigint): Uint8Array
// @implements export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array
// @forbidden  a BIG-ENDIAN integer anywhere except `encodeU64BE`, which exists ONLY so the
//             golden test can prove the WRONG encoding differs (docs/DESIGN-V2.md F1)
// @invariant  1. Every writer method appends; nothing ever rewrites an earlier byte.
// @invariant  2. BcsReader.finish() throws unless every byte was consumed — the MANDATORY
//                "leftovers must be empty" check of docs/DESIGN-V2.md §3.
// @ac         test/bcs.test.ts — LE byte order, ULEB128 multi-byte, leftovers rejection
// @verify     npx vitest run bcs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { addressBytes, addressFromBytes, ADDRESS_LEN } from './address.js';
import { assertU128, assertU64 } from './math.js';

/** Join byte arrays into one freshly allocated buffer. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** ULEB128, as BCS uses for every sequence length. */
export function uleb128(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`uleb128 requires a u32-ish, got ${n}`);
  const bytes: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Uint8Array.from(bytes);
}

function encodeUintLE(n: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = n;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** BCS `u64` — 8 bytes LITTLE-ENDIAN. */
export function encodeU64LE(n: bigint): Uint8Array {
  return encodeUintLE(assertU64(n, 'u64'), 8);
}

/** BCS `u128` — 16 bytes LITTLE-ENDIAN. */
export function encodeU128LE(n: bigint): Uint8Array {
  return encodeUintLE(assertU128(n, 'u128'), 16);
}

/**
 * 8 bytes BIG-ENDIAN. ⚠ NOT BCS. This exists for exactly one reason: so
 * `seal/identity.ts` can export the deliberately-wrong encoding and the golden test can
 * prove it differs from the right one (docs/DESIGN-V2.md F1). Never use it to build a
 * real identity.
 */
export function encodeU64BE(n: bigint): Uint8Array {
  const le = encodeUintLE(assertU64(n, 'u64'), 8);
  return le.reverse();
}

/** Append-only BCS serializer. */
export class BcsWriter {
  private readonly parts: Uint8Array[] = [];

  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`u8 out of range: ${n}`);
    this.parts.push(Uint8Array.of(n));
    return this;
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }

  u64(n: bigint): this {
    this.parts.push(encodeU64LE(n));
    return this;
  }

  u128(n: bigint): this {
    this.parts.push(encodeU128LE(n));
    return this;
  }

  /** 32 RAW bytes — no length prefix. */
  address(a: string): this {
    this.parts.push(addressBytes(a));
    return this;
  }

  /** Raw bytes with NO length prefix (for fixed-size fields the Move side declares as such). */
  fixedBytes(b: Uint8Array): this {
    this.parts.push(Uint8Array.from(b));
    return this;
  }

  /** BCS `vector<u8>` — ULEB128 length then the bytes. */
  bytes(b: Uint8Array): this {
    this.parts.push(uleb128(b.length), Uint8Array.from(b));
    return this;
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

/** Strict BCS reader. `finish()` enforces the "leftovers must be empty" rule. */
export class BcsReader {
  private offset = 0;
  private readonly buf: Uint8Array;

  // NOT a parameter property: those are not type-strippable, and this package is consumed as
  // raw `.ts` by Node, Vite and vitest alike (docs/DESIGN-V2.md §9 — no build step).
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(
        `BcsReader: need ${n} bytes at offset ${this.offset}, only ${this.buf.length - this.offset} left`,
      );
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private uintLE(width: number): bigint {
    const b = this.take(width);
    let v = 0n;
    for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u64(): bigint {
    return this.uintLE(8);
  }

  u128(): bigint {
    return this.uintLE(16);
  }

  address(): string {
    return addressFromBytes(Uint8Array.from(this.take(ADDRESS_LEN)));
  }

  fixedBytes(n: number): Uint8Array {
    return Uint8Array.from(this.take(n));
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  /** The MANDATORY leftovers check of docs/DESIGN-V2.md §3. */
  finish(what = 'payload'): void {
    if (this.remaining() !== 0) {
      throw new RangeError(`${what}: ${this.remaining()} trailing byte(s) — leftovers must be empty`);
    }
  }
}
