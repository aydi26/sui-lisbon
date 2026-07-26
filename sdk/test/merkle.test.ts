// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.2
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (incremental append-only tree, depth 20, root ring of 32)
// @spec       docs/DESIGN-V2.md#5.6 (the FILLS root — odd nodes DUPLICATED, a different shape)
// @rules      G10
// @depends    ../src/merkle.ts · ../fixtures/merkle.golden.json
// @facts      The two trees must never be confused. Both are tested here, side by side, and one
// @facts        test asserts they DISAGREE on the same three leaves — because they should.
// @implements describe('note tree') · describe('proofs') · describe('fills root')
// @verify     npx vitest run merkle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blake2b256, fromHex, toHex, ZERO32 } from '../src/hash.js';
import {
  append,
  appendAll,
  binaryRootDuplicatingOdd,
  computeRootFromProof,
  createTree,
  currentRoot,
  hashNode,
  isKnownRoot,
  knownRoots,
  proveFromLeaves,
  rootFromLeaves,
  ROOT_HISTORY_SIZE,
  TREE_DEPTH,
  verifyProof,
  zerosFor,
} from '../src/merkle.js';
import { createRng } from '../src/rng.js';

interface GoldenProof {
  leafIndex: number;
  leaf: string;
  siblings: string[];
  pathIndices: number[];
  root: string;
  valid: boolean;
}
interface Golden {
  depth: number;
  zeros: string[];
  leaves: string[];
  rootsAfterNAppends: { n: number; root: string }[];
  rootFromAllLeaves: string;
  proof: GoldenProof;
  invalidProof: GoldenProof;
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/merkle.golden.json', import.meta.url)), 'utf8'),
) as Golden;

const leafOf = (i: number): Uint8Array => blake2b256(Uint8Array.of(i & 0xff));

describe('constants', () => {
  it('pins the production depth and ring size', () => {
    expect(TREE_DEPTH).toBe(20);
    expect(ROOT_HISTORY_SIZE).toBe(32);
  });
});

describe('zeros', () => {
  it('zeros[0] is 32 zero bytes and each level is the node hash of the previous, doubled', () => {
    const zs = zerosFor(8);
    expect(toHex(zs[0]!)).toBe(toHex(ZERO32));
    for (let i = 0; i < 8; i++) expect(toHex(zs[i + 1]!)).toBe(toHex(hashNode(zs[i]!, zs[i]!)));
  });

  it('matches the golden vectors', () => {
    const zs = zerosFor(golden.depth);
    expect(zs.map(toHex)).toEqual(golden.zeros);
  });

  it('is cached but never hands out an aliased buffer', () => {
    const a = zerosFor(8);
    a[0]![0] = 0xff;
    expect(toHex(zerosFor(8)[0]!)).toBe(toHex(ZERO32));
  });

  it('rejects an absurd depth', () => {
    expect(() => zerosFor(0)).toThrow(/depth/);
    expect(() => zerosFor(33)).toThrow(/depth/);
  });
});

describe('incremental append', () => {
  it('reproduces every golden root after n appends', () => {
    let tree = createTree(golden.depth);
    expect(toHex(currentRoot(tree))).toBe(golden.rootsAfterNAppends[0]!.root);
    for (let i = 0; i < golden.leaves.length; i++) {
      const r = append(tree, fromHex(golden.leaves[i]!));
      tree = r.tree;
      expect(r.leafIndex).toBe(i);
      expect(toHex(r.root)).toBe(golden.rootsAfterNAppends[i + 1]!.root);
    }
    expect(toHex(currentRoot(tree))).toBe(golden.rootFromAllLeaves);
  });

  it('agrees with rootFromLeaves for every prefix length, at depth 20', () => {
    const leaves: Uint8Array[] = [];
    let tree = createTree(TREE_DEPTH);
    for (let i = 0; i < 17; i++) {
      leaves.push(leafOf(i));
      const r = append(tree, leaves[i]!);
      tree = r.tree;
      expect(toHex(r.root)).toBe(toHex(rootFromLeaves(leaves, TREE_DEPTH)));
    }
  });

  it('never mutates the tree it was given', () => {
    const t0 = createTree(8);
    const before = toHex(currentRoot(t0));
    append(t0, leafOf(1));
    expect(toHex(currentRoot(t0))).toBe(before);
    expect(t0.nextIndex).toBe(0);
  });

  it('rejects a non-32-byte leaf and a full tree', () => {
    const t = createTree(8);
    expect(() => append(t, new Uint8Array(31))).toThrow(/32 bytes/);
    const tiny = appendAll(createTree(1), [leafOf(0), leafOf(1)]);
    expect(() => append(tiny, leafOf(2))).toThrow(/tree is full/);
  });

  it('an empty tree roots to zeros[depth]', () => {
    expect(toHex(rootFromLeaves([], 8))).toBe(toHex(zerosFor(8)[8]!));
    expect(toHex(currentRoot(createTree(8)))).toBe(toHex(zerosFor(8)[8]!));
  });
});

describe('root ring buffer', () => {
  it('remembers exactly the last 32 roots and forgets the 33rd', () => {
    let tree = createTree(8);
    const roots: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) {
      const r = append(tree, leafOf(i));
      tree = r.tree;
      roots.push(r.root);
    }
    expect(isKnownRoot(tree, roots[39]!)).toBe(true);
    expect(isKnownRoot(tree, roots[8]!)).toBe(true); // 40 - 32 = 8, the oldest still inside
    expect(isKnownRoot(tree, roots[7]!)).toBe(false); // one older — REJECTED
    expect(knownRoots(tree)).toHaveLength(ROOT_HISTORY_SIZE);
  });

  it('never accepts the all-zero root or a wrong-length root', () => {
    const tree = appendAll(createTree(8), [leafOf(0)]);
    expect(isKnownRoot(tree, ZERO32)).toBe(false);
    expect(isKnownRoot(tree, new Uint8Array(31))).toBe(false);
  });

  it('reports only written slots before the ring has wrapped', () => {
    const tree = appendAll(createTree(8), [leafOf(0), leafOf(1)]);
    expect(knownRoots(tree)).toHaveLength(3); // empty root + 2 appends
  });
});

describe('proofs', () => {
  it('verifies the golden proof and rejects the tampered one', () => {
    const good = {
      leafIndex: golden.proof.leafIndex,
      siblings: golden.proof.siblings.map(fromHex),
      pathIndices: golden.proof.pathIndices,
    };
    expect(verifyProof(fromHex(golden.proof.leaf), good, fromHex(golden.proof.root))).toBe(true);

    const bad = {
      leafIndex: golden.invalidProof.leafIndex,
      siblings: golden.invalidProof.siblings.map(fromHex),
      pathIndices: golden.invalidProof.pathIndices,
    };
    expect(verifyProof(fromHex(golden.invalidProof.leaf), bad, fromHex(golden.invalidProof.root))).toBe(
      false,
    );
  });

  it('proves every leaf of a 13-leaf tree at depth 20', () => {
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < 13; i++) leaves.push(leafOf(i));
    const root = rootFromLeaves(leaves, TREE_DEPTH);
    for (let i = 0; i < leaves.length; i++) {
      const p = proveFromLeaves(leaves, i, TREE_DEPTH);
      expect(p.siblings).toHaveLength(TREE_DEPTH);
      expect(verifyProof(leaves[i]!, p, root)).toBe(true);
    }
  });

  it('fails when any single bit of the leaf, a sibling, or the root is flipped', () => {
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) leaves.push(leafOf(i));
    const root = rootFromLeaves(leaves, 8);
    const p = proveFromLeaves(leaves, 3, 8);

    const badLeaf = Uint8Array.from(leaves[3]!);
    badLeaf[17] = badLeaf[17]! ^ 0x08;
    expect(verifyProof(badLeaf, p, root)).toBe(false);

    for (let level = 0; level < p.siblings.length; level++) {
      const sibs = p.siblings.map((s) => Uint8Array.from(s));
      sibs[level]![0] = sibs[level]![0]! ^ 0x01;
      expect(verifyProof(leaves[3]!, { ...p, siblings: sibs }, root)).toBe(false);
    }

    const badRoot = Uint8Array.from(root);
    badRoot[0] = badRoot[0]! ^ 0x80;
    expect(verifyProof(leaves[3]!, p, badRoot)).toBe(false);
  });

  it('fails when the path indices are flipped (a right child claimed as a left child)', () => {
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) leaves.push(leafOf(i));
    const root = rootFromLeaves(leaves, 8);
    const p = proveFromLeaves(leaves, 3, 8);
    const flipped = { ...p, pathIndices: p.pathIndices.map((x) => x ^ 1) };
    expect(verifyProof(leaves[3]!, flipped, root)).toBe(false);
  });

  it('rejects an out-of-range leaf index and a malformed proof', () => {
    const leaves = [leafOf(0)];
    expect(() => proveFromLeaves(leaves, 1, 8)).toThrow(/outside/);
    expect(() => proveFromLeaves(leaves, -1, 8)).toThrow(/outside/);
    expect(() =>
      computeRootFromProof(leaves[0]!, { leafIndex: 0, siblings: [ZERO32], pathIndices: [] }),
    ).toThrow(/length mismatch/);
    expect(verifyProof(new Uint8Array(31), proveFromLeaves(leaves, 0, 8), ZERO32)).toBe(false);
  });

  it('proves 200 random leaves in a 200-leaf tree', () => {
    const rng = createRng('merkle-proofs');
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) leaves.push(blake2b256(rng.bytes(16)));
    const root = rootFromLeaves(leaves, TREE_DEPTH);
    for (let i = 0; i < 200; i++) {
      expect(verifyProof(leaves[i]!, proveFromLeaves(leaves, i, TREE_DEPTH), root)).toBe(true);
    }
  });
});

describe('fills root (docs/DESIGN-V2.md §5.6 — a DIFFERENT tree)', () => {
  it('roots an empty fill set to 32 zero bytes', () => {
    expect(toHex(binaryRootDuplicatingOdd([]))).toBe(toHex(ZERO32));
  });

  it('is the leaf itself for one leaf', () => {
    expect(toHex(binaryRootDuplicatingOdd([leafOf(1)]))).toBe(toHex(leafOf(1)));
  });

  it('DUPLICATES an odd node rather than padding with a zero', () => {
    const a = leafOf(1);
    const b = leafOf(2);
    const c = leafOf(3);
    // level 1 = [ H(a,b), H(c,c) ]  — c duplicated, NOT zeros[0]
    const expected = hashNode(hashNode(a, b), hashNode(c, c));
    expect(toHex(binaryRootDuplicatingOdd([a, b, c]))).toBe(toHex(expected));
  });

  it('differs from the fixed-depth note tree on the same leaves — they are not interchangeable', () => {
    const ls = [leafOf(1), leafOf(2), leafOf(3)];
    expect(toHex(binaryRootDuplicatingOdd(ls))).not.toBe(toHex(rootFromLeaves(ls, TREE_DEPTH)));
  });

  it('is order-sensitive', () => {
    const a = leafOf(1);
    const b = leafOf(2);
    expect(toHex(binaryRootDuplicatingOdd([a, b]))).not.toBe(toHex(binaryRootDuplicatingOdd([b, a])));
  });

  it('is deterministic for sizes 0..40', () => {
    for (let n = 0; n <= 40; n++) {
      const ls: Uint8Array[] = [];
      for (let i = 0; i < n; i++) ls.push(leafOf(i));
      expect(toHex(binaryRootDuplicatingOdd(ls))).toBe(toHex(binaryRootDuplicatingOdd(ls)));
    }
  });

  it('rejects a non-32-byte leaf', () => {
    expect(() => binaryRootDuplicatingOdd([new Uint8Array(31)])).toThrow(/32 bytes/);
  });
});
