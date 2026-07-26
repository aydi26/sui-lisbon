// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (hash = sui::hash::blake2b256, 1-byte domain tags)
// @spec       docs/DESIGN-V2.md#5 (fills root = blake2b256 over blake2b256(0x00 ‖ bcs(FillLeaf)))
// @rules      G10
// @depends    (nothing — zero runtime dependencies by design)
// @facts      BLAKE2b per RFC 7693. `sui::hash::blake2b256` is unkeyed BLAKE2b with outlen = 32.
// @facts      The ONLY parameter that differs from blake2b512 is the digest length folded into
// @facts        h[0] ^= 0x01010000 ^ (keylen << 8) ^ outlen  ⇒ blake2b512 parity against
// @facts        node:crypto validates the entire compression function (test/hash.test.ts).
// @facts      KAT blake2b256("")    = 0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8
// @facts      KAT blake2b256("abc") = bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319
// @facts      DOMAIN_LEAF = 0x00 · DOMAIN_NODE = 0x01  (second-preimage separation across levels)
// @implements export const DOMAIN_LEAF: number
// @implements export const DOMAIN_NODE: number
// @implements export function blake2b(input: Uint8Array, outlen?: number): Uint8Array
// @implements export function blake2b256(input: Uint8Array): Uint8Array
// @implements export function hashLeafBytes(payload: Uint8Array): Uint8Array
// @implements export function hashNodeBytes(left: Uint8Array, right: Uint8Array): Uint8Array
// @implements export function toHex(b: Uint8Array): string
// @implements export function fromHex(s: string): Uint8Array
// @implements export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
// @implements export const ZERO32: Uint8Array
// @forbidden  a runtime dependency (@noble/hashes, @mysten/sui) — the app bundles this file
// @forbidden  BigInt arithmetic in the compression function — 32-bit limb form is ~50x faster
//             and the L2 property suite hashes ~5M times
// @invariant  1. Pure: same input ⇒ same 32 bytes, forever, on every platform.
// @invariant  2. blake2b(x, 64) === node:crypto blake2b512(x) for every x (fuzzed, 512 inputs).
// @invariant  3. Every returned Uint8Array is freshly allocated — no shared scratch escapes.
// @ac         test/hash.test.ts: KATs + 512-case node:crypto fuzz + domain-tag separation
// @verify     npx vitest run hash
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** Domain tag prepended to every Merkle *leaf* preimage (docs/DESIGN-V2.md §11). */
export const DOMAIN_LEAF = 0x00;
/** Domain tag prepended to every Merkle *node* preimage (docs/DESIGN-V2.md §11). */
export const DOMAIN_NODE = 0x01;

/** 32 zero bytes — the empty `fills_root`, and the `zeros[0]` of the note tree. */
export const ZERO32: Uint8Array = new Uint8Array(32);

// ── BLAKE2b (RFC 7693), 32-bit limb form ────────────────────────────────────
// Each 64-bit word is stored as two consecutive u32 limbs, LOW first.

const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// SIGMA, pre-doubled so it indexes directly into the limb array `m`.
const SIGMA2 = new Uint8Array(
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2,
    11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14,
    2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0,
    11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13,
    11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4,
    10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  ].map((x) => x * 2),
);

// Module-level scratch. Single-threaded, never escapes, always fully overwritten per compress.
const v = new Uint32Array(32);
const m = new Uint32Array(32);

interface Ctx {
  readonly b: Uint8Array; // 128-byte input block
  readonly h: Uint32Array; // 16 limbs = 8 words of chained state
  t: number; // bytes compressed so far (< 2^53, ample)
  c: number; // bytes currently buffered in `b`
  readonly outlen: number;
}

/** `v[a] += v[b]` on 64-bit limb pairs. */
function add64aa(a: number, b: number): void {
  const o0 = v[a]! + v[b]!;
  let o1 = v[a + 1]! + v[b + 1]!;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}

/** `v[a] += (b1 << 32 | b0)` on 64-bit limb pairs. */
function add64ac(a: number, b0: number, b1: number): void {
  let o0 = v[a]! + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = v[a + 1]! + b1;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}

function get32(arr: Uint8Array, i: number): number {
  return arr[i]! ^ (arr[i + 1]! << 8) ^ (arr[i + 2]! << 16) ^ (arr[i + 3]! << 24);
}

function mixG(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  const x0 = m[ix]!;
  const x1 = m[ix + 1]!;
  const y0 = m[iy]!;
  const y1 = m[iy + 1]!;

  add64aa(a, b);
  add64ac(a, x0, x1);

  // v[d] = (v[d] ^ v[a]) rotr 32
  let xor0 = v[d]! ^ v[a]!;
  let xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = xor1;
  v[d + 1] = xor0;

  add64aa(c, d);

  // v[b] = (v[b] ^ v[c]) rotr 24
  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);

  add64aa(a, b);
  add64ac(a, y0, y1);

  // v[d] = (v[d] ^ v[a]) rotr 16
  xor0 = v[d]! ^ v[a]!;
  xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);

  add64aa(c, d);

  // v[b] = (v[b] ^ v[c]) rotr 63
  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

function compress(ctx: Ctx, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i]!;
    v[i + 16] = IV32[i]!;
  }
  // Counter t (low 64 bits; the high 64 stay 0 — inputs here are far below 2^53 bytes).
  v[24] = v[24]! ^ (ctx.t >>> 0);
  v[25] = v[25]! ^ Math.floor(ctx.t / 0x100000000);
  if (last) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  for (let i = 0; i < 32; i++) m[i] = get32(ctx.b, 4 * i);

  for (let i = 0; i < 12; i++) {
    const s = i * 16;
    mixG(0, 8, 16, 24, SIGMA2[s]!, SIGMA2[s + 1]!);
    mixG(2, 10, 18, 26, SIGMA2[s + 2]!, SIGMA2[s + 3]!);
    mixG(4, 12, 20, 28, SIGMA2[s + 4]!, SIGMA2[s + 5]!);
    mixG(6, 14, 22, 30, SIGMA2[s + 6]!, SIGMA2[s + 7]!);
    mixG(0, 10, 20, 30, SIGMA2[s + 8]!, SIGMA2[s + 9]!);
    mixG(2, 12, 22, 24, SIGMA2[s + 10]!, SIGMA2[s + 11]!);
    mixG(4, 14, 16, 26, SIGMA2[s + 12]!, SIGMA2[s + 13]!);
    mixG(6, 8, 18, 28, SIGMA2[s + 14]!, SIGMA2[s + 15]!);
  }
  for (let i = 0; i < 16; i++) ctx.h[i] = ctx.h[i]! ^ v[i]! ^ v[i + 16]!;
}

function init(outlen: number): Ctx {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) {
    throw new RangeError(`blake2b outlen must be an integer in [1, 64], got ${outlen}`);
  }
  const h = new Uint32Array(16);
  for (let i = 0; i < 16; i++) h[i] = IV32[i]!;
  // Unkeyed: keylen = 0. fanout = depth = 1 ⇒ 0x01010000.
  h[0] = h[0]! ^ 0x01010000 ^ outlen;
  return { b: new Uint8Array(128), h, t: 0, c: 0, outlen };
}

function update(ctx: Ctx, input: Uint8Array): void {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i]!;
  }
}

function final(ctx: Ctx): Uint8Array {
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = new Uint8Array(ctx.outlen);
  for (let i = 0; i < ctx.outlen; i++) {
    out[i] = (ctx.h[i >> 2]! >> (8 * (i & 3))) & 0xff;
  }
  return out;
}

/** Unkeyed BLAKE2b with an explicit digest length (default 32 = `sui::hash::blake2b256`). */
export function blake2b(input: Uint8Array, outlen = 32): Uint8Array {
  const ctx = init(outlen);
  update(ctx, input);
  return final(ctx);
}

/** The exact twin of `sui::hash::blake2b256`. */
export function blake2b256(input: Uint8Array): Uint8Array {
  return blake2b(input, 32);
}

/** `blake2b256(0x00 ‖ payload)` — the domain-separated LEAF hash. */
export function hashLeafBytes(payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = DOMAIN_LEAF;
  buf.set(payload, 1);
  return blake2b256(buf);
}

/** `blake2b256(0x01 ‖ left ‖ right)` — the domain-separated internal NODE hash. */
export function hashNodeBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== 32 || right.length !== 32) {
    throw new RangeError(
      `hashNodeBytes requires two 32-byte digests, got ${left.length} and ${right.length}`,
    );
  }
  const buf = new Uint8Array(65);
  buf[0] = DOMAIN_NODE;
  buf.set(left, 1);
  buf.set(right, 33);
  return blake2b256(buf);
}

const HEX = '0123456789abcdef';

/** Lowercase `0x`-prefixed hex. */
export function toHex(b: Uint8Array): string {
  let out = '0x';
  for (let i = 0; i < b.length; i++) {
    const byte = b[i]!;
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }
  return out;
}

/** Parse `0x`-prefixed or bare hex. Throws on odd length or a non-hex character. */
export function fromHex(s: string): Uint8Array {
  const body = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (body.length % 2 !== 0) throw new RangeError(`hex string has odd length: ${s}`);
  // Full-string validation: parseInt('1z', 16) would silently truncate to 1.
  if (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body)) throw new RangeError(`not hex: ${s}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Constant-shape (not constant-time) byte comparison. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
