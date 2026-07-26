// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.5
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (ladder, leaf and nullifier preimages)
// @spec       aphotic.md §7.1 · §10 Notes invariants
// @rules      G10
// @depends    ../src/notes.ts · ../src/merkle.ts
// @facts      Every denomination must clear Hashi's 30_000-sat withdrawal minimum (RECON R6) or
// @facts        a tier would exist that cannot be individually redeemed.
// @implements describe('denomination ladder') · describe('commitment') · describe('nullifier')
// @verify     npx vitest run notes
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { encodeU64LE } from '../src/bcs.js';
import { blake2b256, hashLeafBytes, toHex } from '../src/hash.js';
import { appendAll, createTree, currentRoot, proveFromLeaves, rootFromLeaves, verifyProof } from '../src/merkle.js';
import {
  commitment,
  DENOMINATIONS,
  denomIndexOf,
  denomValue,
  HASHI_WITHDRAWAL_MIN_SATS,
  noteCommitment,
  noteValue,
  nullifier,
  RANDOMNESS_LEN,
  SECRET_LEN,
  totalValue,
} from '../src/notes.js';
import { createRng } from '../src/rng.js';

const s = (fill: number): Uint8Array => new Uint8Array(SECRET_LEN).fill(fill);
const r = (fill: number): Uint8Array => new Uint8Array(RANDOMNESS_LEN).fill(fill);

describe('denomination ladder', () => {
  it('is exactly 0.01 / 0.1 / 1 / 10 hBTC in sats', () => {
    expect([...DENOMINATIONS]).toEqual([1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n]);
  });

  it('has four widely spaced tiers — few tiers, on purpose', () => {
    expect(DENOMINATIONS).toHaveLength(4);
    for (let i = 1; i < DENOMINATIONS.length; i++) {
      expect(DENOMINATIONS[i]!).toBe(DENOMINATIONS[i - 1]! * 10n);
    }
  });

  it('every tier clears Hashi’s 30_000-sat withdrawal minimum — so each is individually redeemable', () => {
    expect(HASHI_WITHDRAWAL_MIN_SATS).toBe(30_000n);
    for (const d of DENOMINATIONS) expect(d).toBeGreaterThan(HASHI_WITHDRAWAL_MIN_SATS);
  });

  it('is frozen — a tier cannot be repriced, which would revalue live notes', () => {
    expect(Object.isFrozen(DENOMINATIONS)).toBe(true);
  });

  it('maps index to value and back', () => {
    expect(denomValue(0)).toBe(1_000_000n);
    expect(denomValue(3)).toBe(1_000_000_000n);
    expect(denomIndexOf(10_000_000n)).toBe(1);
    expect(denomIndexOf(12_345n)).toBe(-1);
  });

  it('rejects an unknown tier index', () => {
    expect(() => denomValue(4)).toThrow(/EBadDenomination/);
    expect(() => denomValue(-1)).toThrow(/EBadDenomination/);
    expect(() => denomValue(1.5)).toThrow(/EBadDenomination/);
  });

  it('sums note values', () => {
    const notes = [
      { denomIndex: 0, secret: s(1), r: r(1) },
      { denomIndex: 2, secret: s(2), r: r(2) },
    ];
    expect(noteValue(notes[0]!)).toBe(1_000_000n);
    expect(totalValue(notes)).toBe(101_000_000n);
    expect(totalValue([])).toBe(0n);
  });
});

describe('commitment = blake2b256(0x00 || denom || secret || r)', () => {
  it('matches the preimage spelled out by hand', () => {
    const payload = new Uint8Array(1 + 32 + 32);
    payload[0] = 2;
    payload.set(s(0xaa), 1);
    payload.set(r(0xbb), 33);
    expect(toHex(commitment(2, s(0xaa), r(0xbb)))).toBe(toHex(hashLeafBytes(payload)));
  });

  it('is 32 bytes and deterministic', () => {
    const c = commitment(1, s(1), r(2));
    expect(c.length).toBe(32);
    expect(toHex(commitment(1, s(1), r(2)))).toBe(toHex(c));
  });

  it('is sensitive to the denomination independently', () => {
    expect(toHex(commitment(0, s(1), r(2)))).not.toBe(toHex(commitment(1, s(1), r(2))));
  });

  it('is sensitive to the secret independently', () => {
    expect(toHex(commitment(0, s(1), r(2)))).not.toBe(toHex(commitment(0, s(9), r(2))));
  });

  it('is sensitive to r independently — two notes of the same tier and secret still differ', () => {
    expect(toHex(commitment(0, s(1), r(2)))).not.toBe(toHex(commitment(0, s(1), r(9))));
  });

  it('is sensitive to a single flipped bit anywhere in the secret', () => {
    const base = toHex(commitment(0, s(0), r(0)));
    for (let i = 0; i < SECRET_LEN; i++) {
      const sec = s(0);
      sec[i] = sec[i]! ^ 0x01;
      expect(toHex(commitment(0, sec, r(0)))).not.toBe(base);
    }
  });

  it('rejects wrong-length secrets and randomness', () => {
    expect(() => commitment(0, new Uint8Array(31), r(0))).toThrow(/secret must be 32 bytes/);
    expect(() => commitment(0, s(0), new Uint8Array(33))).toThrow(/r must be 32 bytes/);
  });

  it('noteCommitment is commitment applied to a Note', () => {
    const n = { denomIndex: 3, secret: s(7), r: r(8) };
    expect(toHex(noteCommitment(n))).toBe(toHex(commitment(3, s(7), r(8))));
  });

  it('generates 500 distinct commitments from 500 distinct notes', () => {
    const rng = createRng('note-commitments');
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(toHex(commitment(i % 4, rng.bytes(32), rng.bytes(32))));
    }
    expect(seen.size).toBe(500);
  });
});

describe('nullifier = blake2b256(secret || bcs u64 leaf_index)', () => {
  it('matches the preimage spelled out by hand', () => {
    const payload = new Uint8Array(40);
    payload.set(s(0x11), 0);
    payload.set(encodeU64LE(7n), 32);
    expect(toHex(nullifier(s(0x11), 7n))).toBe(toHex(blake2b256(payload)));
  });

  it('is sensitive to the leaf index — the same note at two leaves gives two nullifiers', () => {
    expect(toHex(nullifier(s(1), 0n))).not.toBe(toHex(nullifier(s(1), 1n)));
  });

  it('is sensitive to the secret', () => {
    expect(toHex(nullifier(s(1), 5n))).not.toBe(toHex(nullifier(s(2), 5n)));
  });

  it('uses LITTLE-ENDIAN for the index — index 1 and index 2^56 must differ', () => {
    // If the index were encoded big-endian, byte 32 would be 0 for index 1; it is 1.
    const n1 = nullifier(s(0), 1n);
    const nBig = nullifier(s(0), 1n << 56n);
    expect(toHex(n1)).not.toBe(toHex(nBig));
  });

  it('rejects a wrong-length secret and an out-of-range index', () => {
    expect(() => nullifier(new Uint8Array(16), 0n)).toThrow(/secret must be 32 bytes/);
    expect(() => nullifier(s(0), 2n ** 64n)).toThrow(/u64/);
  });

  it('cannot collide with a commitment — the preimages are 40 vs 66 bytes and differently tagged', () => {
    const rng = createRng('nullifier-vs-commitment');
    const nulls = new Set<string>();
    const comms = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const sec = rng.bytes(32);
      nulls.add(toHex(nullifier(sec, BigInt(i))));
      comms.add(toHex(commitment(i % 4, sec, rng.bytes(32))));
    }
    for (const n of nulls) expect(comms.has(n)).toBe(false);
  });
});

describe('notes in the tree', () => {
  it('a note commitment appended to the tree proves its own membership', () => {
    const rng = createRng('note-tree');
    const notes = Array.from({ length: 12 }, (_, i) => ({
      denomIndex: i % 4,
      secret: rng.bytes(32),
      r: rng.bytes(32),
    }));
    const leaves = notes.map(noteCommitment);
    const tree = appendAll(createTree(20), leaves);
    const root = currentRoot(tree);
    expect(toHex(root)).toBe(toHex(rootFromLeaves(leaves, 20)));
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i]!, proveFromLeaves(leaves, i, 20), root)).toBe(true);
    }
  });

  it('a note NOT in the tree cannot be proved against its root', () => {
    const rng = createRng('note-tree-absent');
    const leaves = Array.from({ length: 8 }, () => commitment(0, rng.bytes(32), rng.bytes(32)));
    const root = rootFromLeaves(leaves, 20);
    const outsider = commitment(0, rng.bytes(32), rng.bytes(32));
    expect(verifyProof(outsider, proveFromLeaves(leaves, 3, 20), root)).toBe(false);
  });
});
