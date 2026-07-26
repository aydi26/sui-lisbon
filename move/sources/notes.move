module aphotic::notes;

use aphotic::caps::{Self, CapRegistry, AdminCap, VaultCap};
use aphotic::events;
use sui::hash;
use sui::table::{Self, Table};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.1-notes (L314-L333)
// @spec       aphotic.md#2-hard-constraints (L54)      <- escrow must not leak order size
// @spec       aphotic.md#10-invariants (L447-L450)     <- the Notes invariants
// @spec       aphotic-governance.md#6.3-note-model (L244-L248)
// @rules      G10
// @depends    aphotic::caps (T1.1) · aphotic::events (T1.0)
// @facts      LADDER (default) = 0.01 / 0.1 / 1 / 10 hBTC
// @facts        = 1_000_000 / 10_000_000 / 100_000_000 / 1_000_000_000 sats. hBTC has 8
// @facts        decimals, so 1 hBTC = 100_000_000 sats (RECON R5/R7.4).
// @facts      FEW TIERS, WIDELY SPACED. MAX_TIERS = 8. A ladder fine enough to express exact
// @facts        amounts fragments participants into singleton anonymity sets and is WORSE than
// @facts        no ladder at all (aphotic.md §7.1). The cap is a design guard, not a gas guard.
// @facts      COMMITMENT  C = blake2b256( 0x01 ‖ denom_index(1) ‖ secret(32) ‖ randomness(32) )
// @facts      NULLIFIER   N = blake2b256( 0x02 ‖ secret(32) ‖ leaf_index(8, LITTLE-ENDIAN) )
// @facts      NODE        H = blake2b256( 0x03 ‖ left(32) ‖ right(32) )
// @facts      ZERO LEAF   Z0 = blake2b256( 0x00 ) ; Z[i+1] = H(Z[i], Z[i])
// @facts        Every input is FIXED WIDTH, so the concatenations are unambiguous and the
// @facts        domain byte makes the four hashes non-interchangeable. secret and randomness
// @facts        are asserted to be exactly 32 bytes.
// @facts      ⚠ LEAF INDEX IS LITTLE-ENDIAN, matching BCS (and the Seal time-lock inner id,
// @facts        which `bcs::peel_u64` also reads LE). A byte-order slip here is silent: the
// @facts        nullifier simply never matches, exactly the failure class of RECON R14.2.
// @facts      ON-CHAIN CLEARING CEILINGS (protocol config; NONE can be raised by paying more):
// @facts        object_runtime_max_num_store_entries = 1_000 per TRANSACTION  <- the binding one
// @facts        max_num_event_emit                   = 1_024 per transaction
// @facts        max_gas_computation_bucket           = 5_000_000 units, hard-capped
// @facts        Each `spend` writes ONE Table entry (the nullifier) and emits ONE event, so
// @facts        MAX_SPENDS_PER_TX = 800 leaves 20 % headroom for the vault's own writes. A
// @facts        batch above that MUST be cleared resumably, across transactions, with an
// @facts        on-chain cursor. See `max_spends_per_tx()`.
// @facts      PHASE-4 SWAP: `MembershipWitness` is the ONLY thing a Groth16 tier replaces. The
// @facts        tree, the commitment format, the nullifier format, `spend`'s signature and the
// @facts        accounting all stay exactly as they are — the verifier changes, nothing else.
// @external   (none — no upstream package is imported. `sui::hash::blake2b256` is a framework
//             native; Phase 4 swaps it for the circuit's hash, which is why every hash goes
//             through `hash_nodes` / `commitment` / `nullifier` and never inline.)
// @implements public fun new_ladder(vault_id: ID): DenomLadder
//             public fun default_denominations(): vector<u64>
//             public fun set_denominations(ladder: &mut DenomLadder, tree: &NoteTree,
//                 reg: &CapRegistry, cap: &AdminCap, denoms_sats: vector<u64>)
//             public fun denom_count(ladder: &DenomLadder): u64
//             public fun denom_sats(ladder: &DenomLadder, denom_index: u8): u64
//             public fun denominations(ladder: &DenomLadder): vector<u64>
//             public fun notes_outstanding(ladder: &DenomLadder): u64
//             public fun new_tree(vault_id: ID, depth: u8): NoteTree
//             public fun new_nullifier_set(vault_id: ID, ctx: &mut TxContext): NullifierSet
//             public fun commitment(denom_index: u8, secret: &vector<u8>,
//                 randomness: &vector<u8>): vector<u8>
//             public fun nullifier(secret: &vector<u8>, leaf_index: u64): vector<u8>
//             public fun hash_nodes(left: &vector<u8>, right: &vector<u8>): vector<u8>
//             public fun zero_hash(tree: &NoteTree, level: u64): vector<u8>
//             public fun append_commitment(tree: &mut NoteTree, ladder: &DenomLadder,
//                 cap: &VaultCap, denom_index: u8, commitment: vector<u8>): u64
//             public fun new_membership_witness(denom_index: u8, secret: vector<u8>,
//                 randomness: vector<u8>, leaf_index: u64,
//                 siblings: vector<vector<u8>>): MembershipWitness
//             public fun spend(tree: &mut NoteTree, nulls: &mut NullifierSet,
//                 ladder: &DenomLadder, cap: &VaultCap, witness: MembershipWitness): u64
//             public fun compute_root(leaf: vector<u8>, leaf_index: u64,
//                 siblings: &vector<vector<u8>>): vector<u8>
//             public fun verify_membership(tree: &NoteTree, leaf: vector<u8>, leaf_index: u64,
//                 siblings: &vector<vector<u8>>): bool
//             public fun is_known_root(tree: &NoteTree, root: &vector<u8>): bool
//             public fun is_spent(nulls: &NullifierSet, n: &vector<u8>): bool
//             public fun assert_note_backing(tree: &NoteTree, vault_btc_sats: u64,
//                 deployed_sats: u64)
//             public fun mint_note(ladder: &mut DenomLadder, cap: &VaultCap, denom_index: u8,
//                 ctx: &mut TxContext): Note
//             public fun burn_note(ladder: &mut DenomLadder, cap: &VaultCap, note: Note): u8
//             public fun note_denom_index(note: &Note): u8
//             public fun root / next_index / depth / capacity / outstanding_sats
//                 / outstanding_notes / tree_vault_id  (&NoteTree -> ..)
//             public fun nullifier_count / nullifier_set_vault_id (&NullifierSet -> ..)
//             public fun max_tiers / max_depth / root_history / digest_len
//                 / max_spends_per_tx (): u64
//             public fun destroy_ladder / destroy_tree / destroy_nullifier_set
// @events     DenominationsSet · NoteCommitted · NoteSpent · NoteMinted · NoteBurned
//             (all declared in aphotic::events)
// @errors     ELadderEmpty · ELadderNotAscending · ELadderTooManyTiers · ELadderInUse
//             · EZeroDenomination · EBadDenomIndex · EBadDepth · ETreeFull · EBadDigestLength
//             · EBadProofLength · ELeafIndexOutOfRange · EUnknownRoot · ENullifierAlreadySpent
//             · ESecretLength · ERandomnessLength · ENoteBackingMismatch
//             · ENoteAccountingUnderflow · ECapVaultMismatch
// @forbidden  ANY amount field on `Note` — hard constraint §2.4. A `Balance<BTC>` inside an
//             order object carries a publicly readable value and defeats the whole design.
//             `Note` has exactly two fields: `id` and `denom_index`.
// @forbidden  a public setter for `denom_index` — a note's value must come from the governed
//             ladder and from nowhere else
// @forbidden  emitting the leaf index at spend time — it would link the spend to its deposit
// @forbidden  re-pointing the ladder while escrow is outstanding — it would silently revalue
//             every live note (ELadderInUse)
// @forbidden  an unbounded per-transaction spend loop — see MAX_SPENDS_PER_TX in @facts
// @invariant  1. A nullifier can be consumed AT MOST ONCE. `spend` inserts into the Table and
//                a second insert of the same key aborts ENullifierAlreadySpent.
// @invariant  2. No `Note` carries a free-form amount. Value is `denom_sats(ladder, index)`,
//                read from the admin-governed ladder, never from the note.
// @invariant  3. `outstanding_sats` == Σ over live commitments of their denomination. It rises
//                only in `append_commitment` and falls only in `spend`, by the same ladder
//                value, so `assert_note_backing` is exact rather than approximate.
// @invariant  4. The tree is APPEND-ONLY: `next_index` only increases and no function removes
//                a leaf. A spend retires a note via its nullifier, never by mutating the tree.
// @invariant  5. `set_denominations` is admin-gated AND refuses while any escrow is live
//                (outstanding_sats > 0 or notes_outstanding > 0).
// @invariant  6. Every mutating entry point requires the vault's own `VaultCap` bound to the
//                same `vault_id` as the structure it mutates — a cap from another vault aborts.
// @invariant  7. A membership proof is checked against a root the tree ACTUALLY published
//                (the last ROOT_HISTORY roots), never against a caller-supplied root.
// @ac         move/tests/notes_tests.move — every invariant above has a named test
// @verify     sui move build
// @verify     sui move test notes
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants ─────────────────────────────────────────────────────────
const ELadderEmpty: u64 = 1;
const ELadderNotAscending: u64 = 2;
const ELadderTooManyTiers: u64 = 3;
const ELadderInUse: u64 = 4;
const EZeroDenomination: u64 = 5;
const EBadDenomIndex: u64 = 6;
const EBadDepth: u64 = 7;
const ETreeFull: u64 = 8;
const EBadDigestLength: u64 = 9;
const EBadProofLength: u64 = 10;
const ELeafIndexOutOfRange: u64 = 11;
const EUnknownRoot: u64 = 12;
const ENullifierAlreadySpent: u64 = 13;
const ESecretLength: u64 = 14;
const ERandomnessLength: u64 = 15;
const ENoteBackingMismatch: u64 = 16;
const ENoteAccountingUnderflow: u64 = 17;
const ECapVaultMismatch: u64 = 18;

// ── domain separation tags (see @facts) ─────────────────────────────────────
const DOMAIN_ZERO: u8 = 0;
const DOMAIN_COMMIT: u8 = 1;
const DOMAIN_NULLIFIER: u8 = 2;
const DOMAIN_NODE: u8 = 3;

/// blake2b256 output width. `secret` and `randomness` are held to the same width so every
/// pre-image is fixed-length and the concatenation is unambiguous.
const DIGEST_LEN: u64 = 32;

/// Ceiling on tree depth. 32 levels is 4.29 billion leaves — far past anything the ceilings in
/// @facts allow us to clear — and keeps `1 << depth` inside u64 with room to spare.
const MAX_DEPTH: u8 = 32;

/// How many past roots stay acceptable, so a proof built one block ago is not invalidated by
/// somebody else's deposit landing first.
const ROOT_HISTORY: u64 = 32;

/// Ladder tiers. Small ON PURPOSE — see @facts.
const MAX_TIERS: u64 = 8;

/// Derived from `object_runtime_max_num_store_entries = 1_000` with 20 % headroom for the
/// vault's own writes in the same transaction. Governs the downstream MAX_BATCH_SIZE.
const MAX_SPENDS_PER_TX: u64 = 800;

// ── default ladder: 0.01 / 0.1 / 1 / 10 hBTC, in sats ───────────────────────
const DENOM_0_01_BTC: u64 = 1_000_000;
const DENOM_0_1_BTC: u64 = 10_000_000;
const DENOM_1_BTC: u64 = 100_000_000;
const DENOM_10_BTC: u64 = 1_000_000_000;

// ── structs ─────────────────────────────────────────────────────────────────

/// The governed denomination ladder. `store` only: embedded by value in the Vault.
public struct DenomLadder has store {
    vault_id: ID,
    /// Strictly ascending, all non-zero, at most MAX_TIERS entries.
    denoms_sats: vector<u64>,
    /// Live `Note` OBJECTS in circulation. Separate from the tree's own counter because a Note
    /// object and a tree commitment are two different escrow representations of the same
    /// uniformity guarantee.
    notes_outstanding: u64,
}

/// THE unit of uniformity. Exactly two fields, and the second is an INDEX into the governed
/// ladder — never an amount (hard constraint §2.4). Two notes of the same denomination are
/// indistinguishable on-chain apart from their object id.
public struct Note has key, store {
    id: UID,
    denom_index: u8,
}

/// Append-only incremental Merkle tree of note commitments, with a rolling root history.
public struct NoteTree has store {
    vault_id: ID,
    depth: u8,
    capacity: u64,
    next_index: u64,
    root: vector<u8>,
    /// The left-hand sibling cached at each level, so an append is O(depth) and needs no leaf
    /// storage at all.
    filled_subtrees: vector<vector<u8>>,
    /// zeros[i] is the root of an all-empty subtree of height i. Length is depth + 1.
    zeros: vector<vector<u8>>,
    /// Ring buffer of the last ROOT_HISTORY published roots.
    roots: vector<vector<u8>>,
    root_cursor: u64,
    /// Σ of the denominations of every commitment appended and not yet spent (@invariant 3).
    outstanding_sats: u64,
    outstanding_notes: u64,
}

/// Consumed-at-most-once spend tags.
public struct NullifierSet has store {
    vault_id: ID,
    spent: Table<vector<u8>, bool>,
    count: u64,
}

/// Everything a spender must show to retire a note. THE Phase-4 swap surface: replacing this
/// with a Groth16 proof plus its public inputs changes the verifier and nothing else.
public struct MembershipWitness has drop, store {
    denom_index: u8,
    secret: vector<u8>,
    randomness: vector<u8>,
    leaf_index: u64,
    siblings: vector<vector<u8>>,
}

// ── little-endian u64, written out rather than pulled from bcs so the byte order of the ──
// ── nullifier pre-image is visible at the point of use (see the @facts warning). ────────
fun u64_to_le_bytes(x: u64): vector<u8> {
    let mut rest = x;
    let mut out = vector[];
    let mut i = 0u64;
    while (i < 8) {
        out.push_back(((rest % 256) as u8));
        rest = rest / 256;
        i = i + 1;
    };
    out
}

// ── hashing ─────────────────────────────────────────────────────────────────

/// Internal-node hash. Public so a client (or the test suite) can rebuild the exact tree the
/// contract will verify against.
public fun hash_nodes(left: &vector<u8>, right: &vector<u8>): vector<u8> {
    assert!(left.length() == DIGEST_LEN, EBadDigestLength);
    assert!(right.length() == DIGEST_LEN, EBadDigestLength);
    let mut buf = vector[DOMAIN_NODE];
    buf.append(*left);
    buf.append(*right);
    hash::blake2b256(&buf)
}

/// `C = blake2b256(0x01 ‖ denom_index ‖ secret ‖ randomness)`.
public fun commitment(denom_index: u8, secret: &vector<u8>, randomness: &vector<u8>): vector<u8> {
    assert!(secret.length() == DIGEST_LEN, ESecretLength);
    assert!(randomness.length() == DIGEST_LEN, ERandomnessLength);
    let mut buf = vector[DOMAIN_COMMIT, denom_index];
    buf.append(*secret);
    buf.append(*randomness);
    hash::blake2b256(&buf)
}

/// `N = blake2b256(0x02 ‖ secret ‖ leaf_index_le)`. Reveals nothing about which leaf is being
/// retired without the secret, and is deterministic, so the same note can never be spent twice.
public fun nullifier(secret: &vector<u8>, leaf_index: u64): vector<u8> {
    assert!(secret.length() == DIGEST_LEN, ESecretLength);
    let mut buf = vector[DOMAIN_NULLIFIER];
    buf.append(*secret);
    buf.append(u64_to_le_bytes(leaf_index));
    hash::blake2b256(&buf)
}

// ── ladder ──────────────────────────────────────────────────────────────────

public fun default_denominations(): vector<u64> {
    vector[DENOM_0_01_BTC, DENOM_0_1_BTC, DENOM_1_BTC, DENOM_10_BTC]
}

public fun new_ladder(vault_id: ID): DenomLadder {
    DenomLadder { vault_id, denoms_sats: default_denominations(), notes_outstanding: 0 }
}

/// Admin-governed re-pointing of the ladder.
///
/// REFUSES while any escrow is live (@invariant 5). Re-pointing under outstanding notes would
/// silently revalue every one of them, because a note stores an INDEX and not an amount — the
/// same property that makes it leak nothing is what makes the ladder immutable in use.
public fun set_denominations(
    ladder: &mut DenomLadder,
    tree: &NoteTree,
    reg: &CapRegistry,
    cap: &AdminCap,
    denoms_sats: vector<u64>,
) {
    caps::assert_admin(reg, cap);
    assert!(caps::vault_id(reg) == ladder.vault_id, ECapVaultMismatch);
    assert!(tree.vault_id == ladder.vault_id, ECapVaultMismatch);
    assert!(tree.outstanding_sats == 0, ELadderInUse);
    assert!(tree.outstanding_notes == 0, ELadderInUse);
    assert!(ladder.notes_outstanding == 0, ELadderInUse);

    let n = denoms_sats.length();
    assert!(n > 0, ELadderEmpty);
    assert!(n <= MAX_TIERS, ELadderTooManyTiers);
    assert!(*denoms_sats.borrow(0) > 0, EZeroDenomination);
    let mut i = 1;
    while (i < n) {
        assert!(*denoms_sats.borrow(i) > *denoms_sats.borrow(i - 1), ELadderNotAscending);
        i = i + 1;
    };

    ladder.denoms_sats = denoms_sats;
    events::emit_denominations_set(ladder.vault_id, ladder.denoms_sats);
}

public fun denom_count(ladder: &DenomLadder): u64 { ladder.denoms_sats.length() }

/// The ONLY place a note's value comes from (@invariant 2).
public fun denom_sats(ladder: &DenomLadder, denom_index: u8): u64 {
    let i = denom_index as u64;
    assert!(i < ladder.denoms_sats.length(), EBadDenomIndex);
    *ladder.denoms_sats.borrow(i)
}

public fun denominations(ladder: &DenomLadder): vector<u64> { ladder.denoms_sats }

public fun notes_outstanding(ladder: &DenomLadder): u64 { ladder.notes_outstanding }

public fun ladder_vault_id(ladder: &DenomLadder): ID { ladder.vault_id }

// ── tree ────────────────────────────────────────────────────────────────────

public fun new_tree(vault_id: ID, depth: u8): NoteTree {
    assert!(depth >= 1, EBadDepth);
    assert!(depth <= MAX_DEPTH, EBadDepth);

    let mut zeros = vector[];
    let mut filled_subtrees = vector[];
    let mut current = hash::blake2b256(&vector[DOMAIN_ZERO]);
    zeros.push_back(current);

    let levels = depth as u64;
    let mut level = 0;
    while (level < levels) {
        filled_subtrees.push_back(current);
        current = hash_nodes(&current, &current);
        zeros.push_back(current);
        level = level + 1;
    };

    // Pre-fill the ring with the genesis root so `is_known_root` never has to reason about a
    // half-populated buffer.
    let mut roots = vector[];
    let mut k = 0;
    while (k < ROOT_HISTORY) {
        roots.push_back(current);
        k = k + 1;
    };

    NoteTree {
        vault_id,
        depth,
        capacity: 1u64 << depth,
        next_index: 0,
        root: current,
        filled_subtrees,
        zeros,
        roots,
        root_cursor: 0,
        outstanding_sats: 0,
        outstanding_notes: 0,
    }
}

/// Append a commitment and take on its denomination as a liability.
///
/// The commitment is opaque here: the contract never sees `secret` or `randomness` at deposit
/// time. `denom_index` is supplied because the deposit of a fixed-denomination note reveals its
/// tier anyway, and the backing accounting (@invariant 3) needs it.
///
/// Returns the leaf index, which the depositor keeps privately — it is an input to their
/// nullifier and is never emitted.
public fun append_commitment(
    tree: &mut NoteTree,
    ladder: &DenomLadder,
    cap: &VaultCap,
    denom_index: u8,
    commitment: vector<u8>,
): u64 {
    assert_tree_cap(tree, cap);
    assert!(ladder.vault_id == tree.vault_id, ECapVaultMismatch);
    assert!(commitment.length() == DIGEST_LEN, EBadDigestLength);

    let sats = denom_sats(ladder, denom_index);
    let leaf_index = insert_leaf(tree, commitment);

    tree.outstanding_sats = tree.outstanding_sats + sats;
    tree.outstanding_notes = tree.outstanding_notes + 1;

    events::emit_note_committed(
        tree.vault_id,
        leaf_index,
        commitment,
        tree.root,
        denom_index,
        tree.outstanding_sats,
    );

    leaf_index
}

fun insert_leaf(tree: &mut NoteTree, leaf: vector<u8>): u64 {
    assert!(tree.next_index < tree.capacity, ETreeFull);
    let leaf_index = tree.next_index;

    let mut current = leaf;
    let mut idx = leaf_index;
    let mut level = 0;
    let levels = tree.depth as u64;
    while (level < levels) {
        if (idx % 2 == 0) {
            *tree.filled_subtrees.borrow_mut(level) = current;
            let z = *tree.zeros.borrow(level);
            current = hash_nodes(&current, &z);
        } else {
            let left = *tree.filled_subtrees.borrow(level);
            current = hash_nodes(&left, &current);
        };
        idx = idx / 2;
        level = level + 1;
    };

    tree.root = current;
    tree.root_cursor = (tree.root_cursor + 1) % ROOT_HISTORY;
    *tree.roots.borrow_mut(tree.root_cursor) = current;
    tree.next_index = leaf_index + 1;

    leaf_index
}

/// Fold a leaf up to a root along `siblings`, choosing the side from the bits of `leaf_index`.
/// Aborts on a mis-sized digest — that is a malformed call, not a failed proof.
public fun compute_root(
    leaf: vector<u8>,
    leaf_index: u64,
    siblings: &vector<vector<u8>>,
): vector<u8> {
    assert!(leaf.length() == DIGEST_LEN, EBadDigestLength);
    let mut current = leaf;
    let mut idx = leaf_index;
    let mut i = 0;
    let n = siblings.length();
    while (i < n) {
        let sibling = siblings.borrow(i);
        current =
            if (idx % 2 == 0) {
                hash_nodes(&current, sibling)
            } else {
                hash_nodes(sibling, &current)
            };
        idx = idx / 2;
        i = i + 1;
    };
    current
}

/// `true` iff `root` is one of the last ROOT_HISTORY roots this tree published (@invariant 7).
public fun is_known_root(tree: &NoteTree, root: &vector<u8>): bool {
    let mut i = 0;
    while (i < ROOT_HISTORY) {
        if (tree.roots.borrow(i) == root) return true;
        i = i + 1;
    };
    false
}

/// Non-aborting membership check, for callers that want to branch rather than revert.
/// A wrong-length proof or an out-of-range index is `false`; a mis-sized digest still aborts
/// inside `compute_root`.
public fun verify_membership(
    tree: &NoteTree,
    leaf: vector<u8>,
    leaf_index: u64,
    siblings: &vector<vector<u8>>,
): bool {
    if (siblings.length() != (tree.depth as u64)) return false;
    if (leaf_index >= tree.capacity) return false;
    is_known_root(tree, &compute_root(leaf, leaf_index, siblings))
}

fun assert_membership(
    tree: &NoteTree,
    leaf: vector<u8>,
    leaf_index: u64,
    siblings: &vector<vector<u8>>,
) {
    assert!(siblings.length() == (tree.depth as u64), EBadProofLength);
    assert!(leaf_index < tree.capacity, ELeafIndexOutOfRange);
    assert!(is_known_root(tree, &compute_root(leaf, leaf_index, siblings)), EUnknownRoot);
}

// ── spending ────────────────────────────────────────────────────────────────

public fun new_nullifier_set(vault_id: ID, ctx: &mut TxContext): NullifierSet {
    NullifierSet { vault_id, spent: table::new<vector<u8>, bool>(ctx), count: 0 }
}

public fun new_membership_witness(
    denom_index: u8,
    secret: vector<u8>,
    randomness: vector<u8>,
    leaf_index: u64,
    siblings: vector<vector<u8>>,
): MembershipWitness {
    MembershipWitness { denom_index, secret, randomness, leaf_index, siblings }
}

/// Retire one note. Returns the sats it was worth, for the caller to pay out or to credit
/// against a fill.
///
/// v1 verifies membership IN MOVE against a published root, with the proof supplied by the
/// client. Phase 4 replaces exactly this check with `sui::groth16` and leaves everything else —
/// the tree, the commitment, the nullifier, this signature — untouched.
///
/// Order of checks is deliberate: the denomination is resolved first (a bad index is a caller
/// error), then membership, then the nullifier. A double spend therefore costs a full proof
/// verification, which is the correct price for a griefing attempt.
public fun spend(
    tree: &mut NoteTree,
    nulls: &mut NullifierSet,
    ladder: &DenomLadder,
    cap: &VaultCap,
    witness: MembershipWitness,
): u64 {
    assert_tree_cap(tree, cap);
    assert!(nulls.vault_id == tree.vault_id, ECapVaultMismatch);
    assert!(ladder.vault_id == tree.vault_id, ECapVaultMismatch);

    let MembershipWitness { denom_index, secret, randomness, leaf_index, siblings } = witness;

    let sats = denom_sats(ladder, denom_index);
    let leaf = commitment(denom_index, &secret, &randomness);
    assert_membership(tree, leaf, leaf_index, &siblings);

    let tag = nullifier(&secret, leaf_index);
    assert!(!nulls.spent.contains(tag), ENullifierAlreadySpent);
    nulls.spent.add(tag, true);
    nulls.count = nulls.count + 1;

    assert!(tree.outstanding_sats >= sats, ENoteAccountingUnderflow);
    assert!(tree.outstanding_notes > 0, ENoteAccountingUnderflow);
    tree.outstanding_sats = tree.outstanding_sats - sats;
    tree.outstanding_notes = tree.outstanding_notes - 1;

    events::emit_note_spent(tree.vault_id, tag, denom_index, sats, tree.outstanding_sats);

    sats
}

public fun is_spent(nulls: &NullifierSet, n: &vector<u8>): bool {
    nulls.spent.contains(*n)
}

// ── backing (aphotic.md §10, Notes) ─────────────────────────────────────────

/// "Total note value in the tree equals `Balance<BTC>` held by the vault minus deployed
/// capital." Called by the vault at settlement.
///
/// The persistent internal balances of `aphotic::balance` are NOT part of this identity: a
/// `BalanceBook` custodies its own `Balance<T>`, physically separate from the vault's, and
/// carries its own conservation assert (`balance::assert_solvent`). The two ledgers are never
/// netted against one another, which is what keeps both invariants exact.
public fun assert_note_backing(tree: &NoteTree, vault_btc_sats: u64, deployed_sats: u64) {
    assert!(vault_btc_sats >= deployed_sats, ENoteBackingMismatch);
    assert!(tree.outstanding_sats == vault_btc_sats - deployed_sats, ENoteBackingMismatch);
}

// ── Note objects ────────────────────────────────────────────────────────────

/// Mint a note object of a governed denomination. Vault-gated: the caller must already hold
/// the vault's own capability, i.e. the value backing the note has been taken.
public fun mint_note(
    ladder: &mut DenomLadder,
    cap: &VaultCap,
    denom_index: u8,
    ctx: &mut TxContext,
): Note {
    assert!(caps::vault_cap_vault_id(cap) == ladder.vault_id, ECapVaultMismatch);
    // Validity of the tier, and nothing else, is what a note records. `denom_sats` aborts on an
    // out-of-range tier; the amount it returns is deliberately discarded (a `Note` stores the
    // INDEX, never the amount, so a re-denominated ladder cannot rewrite an outstanding note).
    let _ = denom_sats(ladder, denom_index);

    let note = Note { id: object::new(ctx), denom_index };
    ladder.notes_outstanding = ladder.notes_outstanding + 1;

    events::emit_note_minted(ladder.vault_id, object::id(&note), denom_index);
    note
}

/// Burn a note and hand its tier back to the caller, who owes the holder `denom_sats` of it.
public fun burn_note(ladder: &mut DenomLadder, cap: &VaultCap, note: Note): u8 {
    assert!(caps::vault_cap_vault_id(cap) == ladder.vault_id, ECapVaultMismatch);
    assert!(ladder.notes_outstanding > 0, ENoteAccountingUnderflow);

    let Note { id, denom_index } = note;
    let note_id = id.to_inner();
    id.delete();

    ladder.notes_outstanding = ladder.notes_outstanding - 1;
    events::emit_note_burned(ladder.vault_id, note_id, denom_index);

    denom_index
}

/// The ONLY accessor a `Note` has. There is no amount to read (@invariant 2).
public fun note_denom_index(note: &Note): u8 { note.denom_index }

fun assert_tree_cap(tree: &NoteTree, cap: &VaultCap) {
    assert!(caps::vault_cap_vault_id(cap) == tree.vault_id, ECapVaultMismatch);
}

// ── read surface ────────────────────────────────────────────────────────────

public fun root(tree: &NoteTree): vector<u8> { tree.root }

public fun next_index(tree: &NoteTree): u64 { tree.next_index }

public fun depth(tree: &NoteTree): u8 { tree.depth }

public fun capacity(tree: &NoteTree): u64 { tree.capacity }

public fun outstanding_sats(tree: &NoteTree): u64 { tree.outstanding_sats }

public fun outstanding_notes(tree: &NoteTree): u64 { tree.outstanding_notes }

public fun tree_vault_id(tree: &NoteTree): ID { tree.vault_id }

public fun zero_hash(tree: &NoteTree, level: u64): vector<u8> {
    assert!(level < tree.zeros.length(), EBadDepth);
    *tree.zeros.borrow(level)
}

public fun nullifier_count(nulls: &NullifierSet): u64 { nulls.count }

public fun nullifier_set_vault_id(nulls: &NullifierSet): ID { nulls.vault_id }

public fun max_tiers(): u64 { MAX_TIERS }

public fun max_depth(): u64 { MAX_DEPTH as u64 }

public fun root_history(): u64 { ROOT_HISTORY }

public fun digest_len(): u64 { DIGEST_LEN }

/// The per-transaction spend ceiling the downstream MAX_BATCH_SIZE must respect. See @facts:
/// it is derived from `object_runtime_max_num_store_entries`, which no gas budget can raise.
public fun max_spends_per_tx(): u64 { MAX_SPENDS_PER_TX }

// ── teardown ────────────────────────────────────────────────────────────────

public fun destroy_ladder(ladder: DenomLadder) {
    let DenomLadder { vault_id: _, denoms_sats: _, notes_outstanding: _ } = ladder;
}

public fun destroy_tree(tree: NoteTree) {
    let NoteTree {
        vault_id: _,
        depth: _,
        capacity: _,
        next_index: _,
        root: _,
        filled_subtrees: _,
        zeros: _,
        roots: _,
        root_cursor: _,
        outstanding_sats: _,
        outstanding_notes: _,
    } = tree;
}

public fun destroy_nullifier_set(nulls: NullifierSet) {
    let NullifierSet { vault_id: _, spent, count: _ } = nulls;
    table::drop(spent);
}
