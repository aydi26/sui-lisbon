// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.5
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (ladder · leaf = blake2b256(0x00 ‖ u8 denom ‖ 32B secret ‖
//             32B r) · nullifier = blake2b256(32B secret ‖ bcs u64 leaf_index))
// @spec       aphotic.md §7.1 (Note carries NO amount; denominations create uniformity,
//             privacy comes from the crowd)
// @rules      G10
// @depends    ./hash.ts · ./bcs.ts · ./merkle.ts
// @facts      DENOMINATIONS = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000] sats
// @facts        = 0.01 / 0.1 / 1 / 10 hBTC.
// @facts      ★ The FLOOR matters: 1_000_000 sats sits far above Hashi's 30_000-sat withdrawal
// @facts        minimum (RECON R6), so EVERY denomination is individually redeemable.
// @facts      Denominations are APPEND-ONLY — repricing a tier would revalue live notes.
// @facts      SECRET_LEN = 32 · RANDOMNESS_LEN = 32
// @facts      ⚠ D8 — v1 note spends are LINKABLE. The Merkle path is supplied in the clear, so
// @facts        path_index names the leaf. v1 delivers UNIFORMITY, not unlinkability. The
// @facts        commitment/nullifier machinery earns its keep by making Phase 4 a verifier swap.
// @facts        Say this in the limitations panel; do not soften it.
// @implements export const DENOMINATIONS: readonly bigint[]
// @implements export const SECRET_LEN: number
// @implements export const RANDOMNESS_LEN: number
// @implements export interface Note
// @implements export function denomValue(denomIndex: number): bigint
// @implements export function denomIndexOf(sats: bigint): number
// @implements export function commitment(denomIndex: number, secret: Uint8Array, r: Uint8Array): Uint8Array
// @implements export function noteCommitment(note: Note): Uint8Array
// @implements export function nullifier(secret: Uint8Array, leafIndex: bigint): Uint8Array
// @implements export function noteValue(note: Note): bigint
// @implements export function totalValue(notes: readonly Note[]): bigint
// @forbidden  an `amount` field on Note — gates.ps1 `notes` greps `struct Note` for exactly that
// @forbidden  a denomination ladder fine enough to express an exact amount — it fragments
//             participants into singleton anonymity sets and is worth LESS than no ladder
// @invariant  1. commitment is sensitive to denom_index, secret AND r, independently.
// @invariant  2. nullifier is sensitive to secret AND leaf_index, independently.
// @invariant  3. The leaf tag (0x00) and the node tag (0x01) never collide: for any 64-byte
//                pair, hashLeaf(x) != hashNode(l, r). Domain separation, asserted.
// @invariant  4. Every denomination >= 30_000 sats (Hashi's withdrawal minimum).
// @ac         test/notes.test.ts — ladder, field sensitivity, domain separation, tree integration
// @verify     npx vitest run notes
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { encodeU64LE } from './bcs.js';
import { blake2b256, hashLeafBytes } from './hash.js';

/** The governed ladder, in sats. Append-only. */
export const DENOMINATIONS: readonly bigint[] = Object.freeze([
  1_000_000n, // 0.01 hBTC
  10_000_000n, // 0.1  hBTC
  100_000_000n, // 1    hBTC
  1_000_000_000n, // 10   hBTC
]);

export const SECRET_LEN = 32;
export const RANDOMNESS_LEN = 32;

/** Hashi's `bitcoin_withdrawal_minimum` (RECON R6) — the floor every tier must clear. */
export const HASHI_WITHDRAWAL_MIN_SATS = 30_000n;

/** The client-side secret half of a note. The on-chain `Note` carries only `denom_index`. */
export interface Note {
  readonly denomIndex: number;
  readonly secret: Uint8Array;
  readonly r: Uint8Array;
}

/** Sats for a ladder index. Throws for an unknown tier. */
export function denomValue(denomIndex: number): bigint {
  if (!Number.isInteger(denomIndex) || denomIndex < 0 || denomIndex >= DENOMINATIONS.length) {
    throw new RangeError(`EBadDenomination: index ${denomIndex}`);
  }
  return DENOMINATIONS[denomIndex]!;
}

/** Ladder index for an exact sat amount, or `-1` when the amount is not a tier. */
export function denomIndexOf(sats: bigint): number {
  for (let i = 0; i < DENOMINATIONS.length; i++) if (DENOMINATIONS[i] === sats) return i;
  return -1;
}

function assertLen(b: Uint8Array, n: number, what: string): Uint8Array {
  if (b.length !== n) throw new RangeError(`${what} must be ${n} bytes, got ${b.length}`);
  return b;
}

/** `blake2b256(0x00 ‖ u8 denom_index ‖ 32B secret ‖ 32B r)` — the Merkle LEAF. */
export function commitment(denomIndex: number, secret: Uint8Array, r: Uint8Array): Uint8Array {
  denomValue(denomIndex); // validates the tier
  assertLen(secret, SECRET_LEN, 'secret');
  assertLen(r, RANDOMNESS_LEN, 'r');
  const payload = new Uint8Array(1 + SECRET_LEN + RANDOMNESS_LEN);
  payload[0] = denomIndex;
  payload.set(secret, 1);
  payload.set(r, 1 + SECRET_LEN);
  return hashLeafBytes(payload);
}

/** {@link commitment} for a whole {@link Note}. */
export function noteCommitment(note: Note): Uint8Array {
  return commitment(note.denomIndex, note.secret, note.r);
}

/**
 * `blake2b256(32B secret ‖ bcs u64 leaf_index)` — the single-use spend tag.
 *
 * ⚠ NOT domain-tagged, deliberately: docs/DESIGN-V2.md §11 specifies exactly these bytes, and
 * the preimage is 40 bytes where a leaf preimage is 66 and a node preimage is 65, so no
 * cross-level collision is reachable by length alone.
 */
export function nullifier(secret: Uint8Array, leafIndex: bigint): Uint8Array {
  assertLen(secret, SECRET_LEN, 'secret');
  const idx = encodeU64LE(leafIndex);
  const payload = new Uint8Array(SECRET_LEN + 8);
  payload.set(secret, 0);
  payload.set(idx, SECRET_LEN);
  return blake2b256(payload);
}

/** Sats represented by a note. */
export function noteValue(note: Note): bigint {
  return denomValue(note.denomIndex);
}

/** Σ sats over a set of notes. */
export function totalValue(notes: readonly Note[]): bigint {
  let sum = 0n;
  for (const n of notes) sum += noteValue(n);
  return sum;
}
