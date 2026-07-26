// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#11 (append = depth-20 hashes rewriting filled_subtrees IN the
//             object — ZERO dynamic fields; 0x00 leaf / 0x01 node domain tags)
// @spec       docs/DESIGN-V2.md#10 (notes_tests::root_older_than_ring_is_rejected)
// @spec       docs/DESIGN-V2.md#5.6 (the FILLS root is a DIFFERENT shape — odd nodes duplicated)
// @rules      G10
// @depends    ./hash.ts
// @facts      TREE_DEPTH = 20  ⇒ 1_048_576 note leaves (docs/DESIGN-V2.md §11)
// @facts      ROOT_HISTORY_SIZE = 32  (the ring buffer; a root older than the ring is REJECTED)
// @facts      zeros[0] = 32 zero bytes · zeros[i+1] = blake2b256(0x01 ‖ zeros[i] ‖ zeros[i])
// @facts      node  = blake2b256(0x01 ‖ left ‖ right)
// @facts      leaf  = supplied ALREADY HASHED by notes.ts (which applies the 0x00 tag)
// @facts      ★ TWO DIFFERENT TREES LIVE HERE, on purpose:
// @facts        (a) the NOTE tree — fixed depth, zero-padded, incremental (Tornado shape);
// @facts        (b) the FILLS root — variable size, ODD NODES DUPLICATED, no padding.
// @facts        They are not interchangeable. §11 specifies (a); §5.6 specifies (b).
// @implements export const TREE_DEPTH: number
// @implements export const ROOT_HISTORY_SIZE: number
// @implements export interface TreeState
// @implements export interface MerkleProof
// @implements export function zerosFor(depth: number): Uint8Array[]
// @implements export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array
// @implements export function createTree(depth?: number): TreeState
// @implements export function append(tree: TreeState, leaf: Uint8Array): AppendResult
// @implements export function appendAll(tree: TreeState, leaves: readonly Uint8Array[]): TreeState
// @implements export function currentRoot(tree: TreeState): Uint8Array
// @implements export function knownRoots(tree: TreeState): Uint8Array[]
// @implements export function isKnownRoot(tree: TreeState, root: Uint8Array): boolean
// @implements export function rootFromLeaves(leaves: readonly Uint8Array[], depth?: number): Uint8Array
// @implements export function proveFromLeaves(leaves: readonly Uint8Array[], leafIndex: number, depth?: number): MerkleProof
// @implements export function computeRootFromProof(leaf: Uint8Array, proof: MerkleProof): Uint8Array
// @implements export function verifyProof(leaf: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean
// @implements export function binaryRootDuplicatingOdd(leaves: readonly Uint8Array[]): Uint8Array
// @forbidden  mutating a TreeState in place — every function returns a NEW state (Move rewrites
//             filled_subtrees inside the object; TS must not let a caller alias a stale tree)
// @forbidden  an undomain-separated hash — 0x01 on every internal node, always
// @invariant  1. append(...)ing leaves one by one yields the SAME root as rootFromLeaves(all).
// @invariant  2. verifyProof(leaf, proveFromLeaves(leaves, i), rootFromLeaves(leaves)) is true
//                for every i < leaves.length.
// @invariant  3. Any single flipped bit in leaf, sibling or root makes verifyProof false.
// @invariant  4. isKnownRoot remembers exactly the last ROOT_HISTORY_SIZE roots, no more.
// @ac         fixtures/merkle.golden.json — roots after n appends + a valid and an invalid proof
// @verify     npx vitest run merkle
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bytesEqual, hashNodeBytes, ZERO32 } from './hash.js';

/** Note-tree depth — 2^20 leaves (docs/DESIGN-V2.md §11). */
export const TREE_DEPTH = 20;

/** How many historical roots the on-chain ring buffer remembers. */
export const ROOT_HISTORY_SIZE = 32;

/** `blake2b256(0x01 ‖ left ‖ right)`. */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return hashNodeBytes(left, right);
}

const zerosCache = new Map<number, Uint8Array[]>();

/**
 * `zeros[i]` = the root of an all-empty subtree of height `i`.
 * Returns `depth + 1` entries: `zeros[depth]` is the empty-tree root.
 */
export function zerosFor(depth: number): Uint8Array[] {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) {
    throw new RangeError(`tree depth must be an integer in [1, 32], got ${depth}`);
  }
  const hit = zerosCache.get(depth);
  if (hit) return hit.map((z) => Uint8Array.from(z));
  const zs: Uint8Array[] = [Uint8Array.from(ZERO32)];
  for (let i = 0; i < depth; i++) zs.push(hashNode(zs[i]!, zs[i]!));
  zerosCache.set(depth, zs);
  return zs.map((z) => Uint8Array.from(z));
}

/** Immutable incremental-tree state — the exact shape `notes.move` keeps inside the object. */
export interface TreeState {
  readonly depth: number;
  /** `filled_subtrees[i]` — the left-hand node awaiting a sibling at level `i`. */
  readonly filledSubtrees: readonly Uint8Array[];
  readonly zeros: readonly Uint8Array[];
  /** Number of leaves appended so far; also the index the NEXT leaf will occupy. */
  readonly nextIndex: number;
  /** Ring buffer of the last {@link ROOT_HISTORY_SIZE} roots. */
  readonly roots: readonly Uint8Array[];
  readonly currentRootIndex: number;
}

export interface AppendResult {
  readonly tree: TreeState;
  readonly leafIndex: number;
  readonly root: Uint8Array;
}

/** A fresh, empty tree. `roots[0]` is the empty-tree root. */
export function createTree(depth: number = TREE_DEPTH): TreeState {
  const zeros = zerosFor(depth);
  const roots = new Array<Uint8Array>(ROOT_HISTORY_SIZE);
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) roots[i] = Uint8Array.from(ZERO32);
  roots[0] = Uint8Array.from(zeros[depth]!);
  return {
    depth,
    filledSubtrees: zeros.slice(0, depth).map((z) => Uint8Array.from(z)),
    zeros,
    nextIndex: 0,
    roots,
    currentRootIndex: 0,
  };
}

/** The newest root. */
export function currentRoot(tree: TreeState): Uint8Array {
  return Uint8Array.from(tree.roots[tree.currentRootIndex]!);
}

/** Every root still inside the ring, newest first. */
export function knownRoots(tree: TreeState): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let k = 0; k < ROOT_HISTORY_SIZE; k++) {
    const i = (tree.currentRootIndex - k + ROOT_HISTORY_SIZE) % ROOT_HISTORY_SIZE;
    const r = tree.roots[i]!;
    if (bytesEqual(r, ZERO32)) continue; // never-written slot
    out.push(Uint8Array.from(r));
  }
  return out;
}

/**
 * Is `root` still inside the ring? A root older than {@link ROOT_HISTORY_SIZE} appends is
 * REJECTED — `notes_tests::root_older_than_ring_is_rejected`.
 */
export function isKnownRoot(tree: TreeState, root: Uint8Array): boolean {
  if (root.length !== 32 || bytesEqual(root, ZERO32)) return false;
  for (let k = 0; k < ROOT_HISTORY_SIZE; k++) {
    const i = (tree.currentRootIndex - k + ROOT_HISTORY_SIZE) % ROOT_HISTORY_SIZE;
    if (bytesEqual(tree.roots[i]!, root)) return true;
  }
  return false;
}

/**
 * Append one 32-byte leaf. `depth` hashes, `filled_subtrees` rewritten in place — zero
 * dynamic fields, which is the whole gas argument of docs/DESIGN-V2.md §11.
 */
export function append(tree: TreeState, leaf: Uint8Array): AppendResult {
  if (leaf.length !== 32) throw new RangeError(`leaf must be 32 bytes, got ${leaf.length}`);
  const capacity = 2 ** tree.depth;
  if (tree.nextIndex >= capacity) throw new RangeError(`tree is full at depth ${tree.depth}`);

  const leafIndex = tree.nextIndex;
  const filled = tree.filledSubtrees.map((s) => Uint8Array.from(s));
  let idx = leafIndex;
  let cur: Uint8Array = Uint8Array.from(leaf);
  for (let i = 0; i < tree.depth; i++) {
    let left: Uint8Array;
    let right: Uint8Array;
    if (idx % 2 === 0) {
      left = cur;
      right = tree.zeros[i]!;
      filled[i] = Uint8Array.from(cur);
    } else {
      left = filled[i]!;
      right = cur;
    }
    cur = hashNode(left, right);
    idx = Math.floor(idx / 2);
  }

  const nextRootIndex = (tree.currentRootIndex + 1) % ROOT_HISTORY_SIZE;
  const roots = tree.roots.map((r) => Uint8Array.from(r));
  roots[nextRootIndex] = Uint8Array.from(cur);

  return {
    tree: {
      depth: tree.depth,
      filledSubtrees: filled,
      zeros: tree.zeros,
      nextIndex: leafIndex + 1,
      roots,
      currentRootIndex: nextRootIndex,
    },
    leafIndex,
    root: cur,
  };
}

/** Fold {@link append} over many leaves. */
export function appendAll(tree: TreeState, leaves: readonly Uint8Array[]): TreeState {
  let t = tree;
  for (const l of leaves) t = append(t, l).tree;
  return t;
}

/**
 * The populated prefix of every level, level 0 first. Only `leaves.length` entries exist at
 * level 0; missing siblings are `zeros[i]`, so this is O(leaves), not O(2^depth).
 */
function buildLevels(leaves: readonly Uint8Array[], depth: number): Uint8Array[][] {
  const zeros = zerosFor(depth);
  const levels: Uint8Array[][] = [leaves.map((l) => Uint8Array.from(l))];
  for (let i = 0; i < depth; i++) {
    const cur = levels[i]!;
    const next: Uint8Array[] = [];
    for (let j = 0; j < cur.length; j += 2) {
      const left = cur[j]!;
      const right = j + 1 < cur.length ? cur[j + 1]! : zeros[i]!;
      next.push(hashNode(left, right));
    }
    levels.push(next);
  }
  return levels;
}

/** The zero-padded fixed-depth root of `leaves`. Must equal the incremental root. */
export function rootFromLeaves(leaves: readonly Uint8Array[], depth: number = TREE_DEPTH): Uint8Array {
  for (const l of leaves) {
    if (l.length !== 32) throw new RangeError(`leaf must be 32 bytes, got ${l.length}`);
  }
  if (leaves.length === 0) return zerosFor(depth)[depth]!;
  if (leaves.length > 2 ** depth) throw new RangeError(`too many leaves for depth ${depth}`);
  const levels = buildLevels(leaves, depth);
  return levels[depth]![0]!;
}

export interface MerkleProof {
  readonly leafIndex: number;
  /** `siblings[i]` is the sibling at level `i`, bottom-up. */
  readonly siblings: readonly Uint8Array[];
  /** `pathIndices[i]` is 0 when the node is the LEFT child at level `i`, 1 when RIGHT. */
  readonly pathIndices: readonly number[];
}

/** Membership proof for `leaves[leafIndex]` in the fixed-depth tree. */
export function proveFromLeaves(
  leaves: readonly Uint8Array[],
  leafIndex: number,
  depth: number = TREE_DEPTH,
): MerkleProof {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new RangeError(`leafIndex ${leafIndex} outside [0, ${leaves.length})`);
  }
  const zeros = zerosFor(depth);
  const levels = buildLevels(leaves, depth);
  const siblings: Uint8Array[] = [];
  const pathIndices: number[] = [];
  let j = leafIndex;
  for (let i = 0; i < depth; i++) {
    const level = levels[i]!;
    const sibIdx = j ^ 1;
    siblings.push(sibIdx < level.length ? Uint8Array.from(level[sibIdx]!) : Uint8Array.from(zeros[i]!));
    pathIndices.push(j & 1);
    j = Math.floor(j / 2);
  }
  return { leafIndex, siblings, pathIndices };
}

/** Fold a proof upward. This is exactly what `notes.move` recomputes on a spend. */
export function computeRootFromProof(leaf: Uint8Array, proof: MerkleProof): Uint8Array {
  if (leaf.length !== 32) throw new RangeError(`leaf must be 32 bytes, got ${leaf.length}`);
  if (proof.siblings.length !== proof.pathIndices.length) {
    throw new RangeError('proof siblings/pathIndices length mismatch');
  }
  let cur: Uint8Array = Uint8Array.from(leaf);
  for (let i = 0; i < proof.siblings.length; i++) {
    const sib = proof.siblings[i]!;
    cur = proof.pathIndices[i]! === 0 ? hashNode(cur, sib) : hashNode(sib, cur);
  }
  return cur;
}

/** True when `leaf` provably sits under `root` at `proof.leafIndex`. */
export function verifyProof(leaf: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean {
  try {
    return bytesEqual(computeRootFromProof(leaf, proof), root);
  } catch {
    return false;
  }
}

/**
 * The **FILLS** root of docs/DESIGN-V2.md §5.6 — a different shape from the note tree:
 * variable size, **odd nodes duplicated**, no zero padding, no fixed depth.
 * An empty fill set roots to 32 zero bytes.
 */
export function binaryRootDuplicatingOdd(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return Uint8Array.from(ZERO32);
  let level: Uint8Array[] = leaves.map((l) => {
    if (l.length !== 32) throw new RangeError(`leaf must be 32 bytes, got ${l.length}`);
    return Uint8Array.from(l);
  });
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j]!;
      const right = j + 1 < level.length ? level[j + 1]! : left; // odd node duplicated
      next.push(hashNode(left, right));
    }
    level = next;
  }
  return level[0]!;
}
