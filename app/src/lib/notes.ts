// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.1 (notes; a Note carries no amount), §7.4
// @spec       docs/DESIGN-V2.md §11 (ladder, depth-20 tree, domain separation), D8
// @spec       move/sources/notes.move — the tags and the pre-images below were read
//             out of that file, constant by constant.
// @rules      G7 G8 G10
// @depends    @aphotic/sdk/hash (blake2b256) · @aphotic/sdk/bcs (encodeU64LE)
//             · ./suiClient.ts · ../config.ts
// @facts      ★★ THE DIVERGENCE THAT WOULD HAVE EATEN EVERY NOTE. ★★
// @facts        `sdk/src/notes.ts` + `sdk/src/merkle.ts` implement docs/DESIGN-V2
// @facts        §11 as WRITTEN: leaf tag 0x00, node tag 0x01, an untagged
// @facts        nullifier, and zeros[0] = 32 zero bytes. The SHIPPED
// @facts        move/sources/notes.move uses DIFFERENT constants:
// @facts          DOMAIN_ZERO = 0 · DOMAIN_COMMIT = 1 · DOMAIN_NULLIFIER = 2
// @facts          DOMAIN_NODE = 3
// @facts          commitment = blake2b256(0x01 ‖ u8 denom ‖ 32B secret ‖ 32B r)
// @facts          nullifier  = blake2b256(0x02 ‖ 32B secret ‖ u64 LE leaf_index)
// @facts          node       = blake2b256(0x03 ‖ left ‖ right)
// @facts          zeros[0]   = blake2b256(0x00)     ← NOT 32 zero bytes
// @facts        A note committed under the SDK's tags is appended fine and then
// @facts        FAILS `notes::spend` forever: the contract recomputes the leaf and
// @facts        gets a different digest, so the membership proof cannot match. It
// @facts        is unrecoverable and it fails silently at deposit time. So this
// @facts        module mirrors the DEPLOYED CONTRACT, not the design note, and
// @facts        imports only `blake2b256` and `encodeU64LE` from the sdk — the
// @facts        primitives, never a second hashing scheme.
// @facts        ⇒ REPORTED as an sdk↔Move parity break. sdk/ is not this unit's to
// @facts        edit; when it is reconciled, delete this module's tag table and
// @facts        import the sdk's again. `app/test/notes.test.ts` pins the bytes so
// @facts        the swap cannot happen silently.
// @facts      TREE: depth 20, ROOT_HISTORY 32, capacity 1_048_576. An append is 20
// @facts        hashes rewritten INSIDE the object — zero dynamic fields.
// @facts      ⚠ D8 — v1 spends are LINKABLE. The Merkle path is supplied in the
// @facts        clear, so `leaf_index` names the leaf. v1 delivers UNIFORMITY, not
// @facts        unlinkability. Say it on screen; never soften it.
// @facts      ⚠ THE SECRET NEVER LEAVES THE BROWSER and is never derivable from
// @facts        chain state. Lose it and the note is unspendable by anyone,
// @facts        forever — which is also why nothing here transmits it.
// @implements export const DOMAIN_* · SECRET_LEN · RANDOMNESS_LEN · NOTE_TREE_DEPTH
// @implements export function commitment · nullifier · hashNode · zerosFor
// @implements export function rootFromLeaves · siblingsFor
// @implements export interface StoredNote · NoteWallet
// @implements export function newNote · loadNotes · saveNote · updateNote
//             · forgetNote · noteBackupBlob
// @implements export async function readNoteLeaves(opts?)
// @forbidden  a second copy of blake2b — the sdk owns the primitive
// @forbidden  transmitting `secret` or `r` anywhere: not to Walrus, not to a log,
//             not into a Move argument other than the witness itself
// @forbidden  deriving a note secret from anything guessable (a timestamp, an
//             address, a counter) — it is 32 bytes of crypto.getRandomValues
// @invariant  1. commitment/nullifier are byte-identical to notes.move.
// @invariant  2. siblingsFor(leaves, i) folds back to rootFromLeaves(leaves).
// @invariant  3. Nothing in this module reads a wall clock except `newNote`'s
//                createdMs, which is metadata and never enters a hash.
// @ac         app/test/notes.test.ts — golden bytes for the four tags, path/root
//             agreement at depth 20, and the wallet round-trip.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- notes
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { encodeU64LE } from '@aphotic/sdk/bcs';
import { blake2b256, bytesEqual, fromHex, toHex } from '@aphotic/sdk/hash';

import { config } from '../config';
import { getJsonRpcClient } from './suiClient';

// ── the tags, exactly as move/sources/notes.move declares them ──────────────

export const DOMAIN_ZERO = 0x00;
export const DOMAIN_COMMIT = 0x01;
export const DOMAIN_NULLIFIER = 0x02;
export const DOMAIN_NODE = 0x03;

export const SECRET_LEN = 32;
export const RANDOMNESS_LEN = 32;
export const DIGEST_LEN = 32;

/** `vault.move`'s NOTE_TREE_DEPTH. 20 levels ≈ 1.05 M notes. */
export const NOTE_TREE_DEPTH = 20;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function assertLen(b: Uint8Array, n: number, what: string): Uint8Array {
  if (b.length !== n) throw new RangeError(`${what} must be ${n} bytes, got ${b.length}`);
  return b;
}

/** `blake2b256(0x01 ‖ denom_index ‖ secret ‖ randomness)` — the Merkle LEAF. */
export function commitment(denomIndex: number, secret: Uint8Array, r: Uint8Array): Uint8Array {
  assertLen(secret, SECRET_LEN, 'secret');
  assertLen(r, RANDOMNESS_LEN, 'randomness');
  return blake2b256(concat(Uint8Array.of(DOMAIN_COMMIT, denomIndex), secret, r));
}

/** `blake2b256(0x02 ‖ secret ‖ u64 LE leaf_index)` — the single-use spend tag. */
export function nullifier(secret: Uint8Array, leafIndex: bigint): Uint8Array {
  assertLen(secret, SECRET_LEN, 'secret');
  return blake2b256(concat(Uint8Array.of(DOMAIN_NULLIFIER), secret, encodeU64LE(leafIndex)));
}

/** `blake2b256(0x03 ‖ left ‖ right)`. */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  assertLen(left, DIGEST_LEN, 'left');
  assertLen(right, DIGEST_LEN, 'right');
  return blake2b256(concat(Uint8Array.of(DOMAIN_NODE), left, right));
}

/** `zeros[0] = blake2b256(0x00)`, then folded — `new_tree`'s exact construction. */
export function zerosFor(depth: number = NOTE_TREE_DEPTH): Uint8Array[] {
  const out: Uint8Array[] = [blake2b256(Uint8Array.of(DOMAIN_ZERO))];
  for (let i = 0; i < depth; i += 1) out.push(hashNode(out[i]!, out[i]!));
  return out;
}

/** The root the contract would publish after appending exactly these leaves. */
export function rootFromLeaves(
  leaves: readonly Uint8Array[],
  depth: number = NOTE_TREE_DEPTH,
): Uint8Array {
  const zeros = zerosFor(depth);
  let level: Uint8Array[] = [...leaves];
  for (let d = 0; d < depth; d += 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? zeros[d]!;
      next.push(hashNode(left, right));
    }
    level = next;
  }
  return level[0] ?? zeros[depth]!;
}

/**
 * The `depth` siblings that fold `leaves[leafIndex]` up to the root — the
 * `siblings` field of `notes::MembershipWitness`.
 *
 * Built HERE, in the browser, from the public leaf list. That is the whole point:
 * the proof is the user's to construct, and the operator supplies nothing.
 */
export function siblingsFor(
  leaves: readonly Uint8Array[],
  leafIndex: number,
  depth: number = NOTE_TREE_DEPTH,
): Uint8Array[] {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new RangeError(`leaf index ${leafIndex} is outside the ${leaves.length} known leaves`);
  }
  const zeros = zerosFor(depth);
  const siblings: Uint8Array[] = [];
  let level: Uint8Array[] = [...leaves];
  let idx = leafIndex;
  for (let d = 0; d < depth; d += 1) {
    const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(level[pair] ?? zeros[d]!);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashNode(level[i]!, level[i + 1] ?? zeros[d]!));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return siblings;
}

/** Fold a leaf up a path — the twin of `notes::compute_root`, used to self-check. */
export function rootFromPath(
  leaf: Uint8Array,
  leafIndex: number,
  siblings: readonly Uint8Array[],
): Uint8Array {
  let current = leaf;
  let idx = leafIndex;
  for (const sibling of siblings) {
    current = idx % 2 === 0 ? hashNode(current, sibling) : hashNode(sibling, current);
    idx = Math.floor(idx / 2);
  }
  return current;
}

// ── the client-side note wallet ─────────────────────────────────────────────

export interface StoredNote {
  /** Ladder index. The ONLY thing the on-chain `Note` knows. */
  readonly denomIndex: number;
  /** 32 bytes, hex. NEVER transmitted. */
  readonly secretHex: string;
  /** 32 bytes, hex. NEVER transmitted. */
  readonly randomnessHex: string;
  readonly commitmentHex: string;
  /** Assigned by `append_commitment`; null until the deposit lands. */
  readonly leafIndex: number | null;
  /** The vault this note is escrowed in. A note is not portable across vaults. */
  readonly vaultId: string;
  readonly createdMs: number;
  /** Set once the note has been spent into the internal balance. */
  readonly spentAtMs: number | null;
}

const STORAGE_KEY = 'aphotic.notes.v1';

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null; // a browser with storage disabled is a working browser
  }
}

/** 32 bytes from the platform CSPRNG. Never a PRNG, never a timestamp. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new Error(
      'crypto.getRandomValues is unavailable in this environment — refusing to generate a ' +
        'note secret from anything weaker.',
    );
  }
  crypto.getRandomValues(out);
  return out;
}

/** A fresh, unregistered note. Nothing about it is derivable from chain state. */
export function newNote(denomIndex: number, vaultId: string, nowMs: number): StoredNote {
  const secret = randomBytes(SECRET_LEN);
  const r = randomBytes(RANDOMNESS_LEN);
  return {
    denomIndex,
    secretHex: toHex(secret),
    randomnessHex: toHex(r),
    commitmentHex: toHex(commitment(denomIndex, secret, r)),
    leafIndex: null,
    vaultId,
    createdMs: nowMs,
    spentAtMs: null,
  };
}

export function noteSecret(note: StoredNote): Uint8Array {
  return fromHex(note.secretHex);
}

export function noteRandomness(note: StoredNote): Uint8Array {
  return fromHex(note.randomnessHex);
}

export function loadNotes(): StoredNote[] {
  const store = storage();
  if (store === null) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredNote[]) : [];
  } catch {
    return [];
  }
}

function writeNotes(notes: readonly StoredNote[]): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // Quota or private mode. The caller already has the note in memory and the
    // download is the real backup — swallowing here beats losing the screen.
  }
}

export function saveNote(note: StoredNote): StoredNote[] {
  const notes = [...loadNotes(), note];
  writeNotes(notes);
  return notes;
}

/** Replace by commitment — the only stable key before a leaf index exists. */
export function updateNote(commitmentHex: string, patch: Partial<StoredNote>): StoredNote[] {
  const notes = loadNotes().map((n) =>
    n.commitmentHex === commitmentHex ? { ...n, ...patch } : n,
  );
  writeNotes(notes);
  return notes;
}

export function forgetNote(commitmentHex: string): StoredNote[] {
  const notes = loadNotes().filter((n) => n.commitmentHex !== commitmentHex);
  writeNotes(notes);
  return notes;
}

/**
 * The backup payload. It contains the secrets, which is the point: without this
 * file the note is unspendable by anyone including us, and no amount of
 * on-chain data can reconstruct it.
 */
export function noteBackupBlob(notes: readonly StoredNote[]): string {
  return JSON.stringify(
    {
      format: 'aphotic.notes.v1',
      warning:
        'THESE ARE THE ONLY COPIES OF YOUR NOTE SECRETS. Losing this file makes every note ' +
        'in it permanently unspendable — by you and by everyone else. Anyone who obtains it ' +
        'can spend them.',
      vaultId: notes[0]?.vaultId ?? '',
      notes,
    },
    null,
    2,
  );
}

// ── the public leaf list ────────────────────────────────────────────────────

export interface NoteLeaf {
  readonly leafIndex: number;
  readonly commitment: Uint8Array;
  readonly denomIndex: number;
}

/** Injected so the offline suite never opens a socket. */
export type NoteLeavesFn = () => Promise<readonly NoteLeaf[]>;

interface RawNoteEvent {
  readonly leaf_index?: unknown;
  readonly commitment?: unknown;
  readonly denom_index?: unknown;
  readonly vault_id?: unknown;
}

function parseNoteEvent(json: unknown): NoteLeaf | null {
  if (typeof json !== 'object' || json === null) return null;
  const e = json as RawNoteEvent;
  const index = Number(e.leaf_index);
  if (!Number.isFinite(index)) return null;
  const bytes = Array.isArray(e.commitment) ? Uint8Array.from(e.commitment as number[]) : null;
  if (bytes === null || bytes.length !== DIGEST_LEN) return null;
  return { leafIndex: index, commitment: bytes, denomIndex: Number(e.denom_index ?? 0) };
}

/**
 * Every `NoteCommitted` event, in leaf order — the public leaf list a membership
 * proof is built from.
 *
 * gRPC v2 has no event query, so this one read goes over the verified JSON-RPC
 * mirror. It is the only place in the app that does, and it is stated rather
 * than hidden.
 */
export async function readNoteLeaves(opts?: {
  readonly leaves?: NoteLeavesFn;
  readonly pageLimit?: number;
}): Promise<readonly NoteLeaf[]> {
  if (opts?.leaves !== undefined) return opts.leaves();
  const origin = config.aphotic.originalPackageId;
  const vaultId = config.aphotic.vaultId;
  if (origin.length === 0 || vaultId.length === 0) {
    throw new Error(
      'VITE_APHOTIC_ORIGINAL_PACKAGE_ID and VITE_VAULT_ID must both be set before the leaf ' +
        'list can be read — a membership proof cannot be built from a guess.',
    );
  }
  const client = getJsonRpcClient();
  const out: NoteLeaf[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  for (let page = 0; page < 200; page += 1) {
    const response = await client.queryEvents({
      query: { MoveEventType: `${origin}::events::NoteCommitted` },
      cursor,
      limit: opts?.pageLimit ?? 200,
      order: 'ascending',
    });
    for (const event of response.data) {
      const leaf = parseNoteEvent(event.parsedJson);
      if (leaf !== null) out.push(leaf);
    }
    const next = response.nextCursor;
    if (!response.hasNextPage || next === null || next === undefined) break;
    cursor = next;
  }
  out.sort((a, b) => a.leafIndex - b.leafIndex);
  return out;
}

/** Leaves as a dense array indexed by leaf_index, ready for `siblingsFor`. */
export function leafArray(leaves: readonly NoteLeaf[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const leaf of leaves) out[leaf.leafIndex] = leaf.commitment;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === undefined) {
      throw new Error(
        `the leaf list has a hole at index ${i} — refusing to build a proof against an ` +
          'incomplete tree, because the resulting root would be silently wrong.',
      );
    }
  }
  return out;
}

/** True when a rebuilt path folds to the root the vault actually published. */
export function pathMatchesRoot(
  leaf: Uint8Array,
  leafIndex: number,
  siblings: readonly Uint8Array[],
  publishedRoot: Uint8Array,
): boolean {
  return bytesEqual(rootFromPath(leaf, leafIndex, siblings), publishedRoot);
}
