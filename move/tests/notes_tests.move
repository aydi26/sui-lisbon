#[test_only]
module aphotic::notes_tests;

use aphotic::caps::{Self, CapRegistry, AdminCap, VaultCap};
use aphotic::events;
use aphotic::notes::{Self, DenomLadder, NoteTree, NullifierSet};
use sui::event;
use sui::hash;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3
// @status     DONE
// @spec       aphotic.md#10-invariants (L447-L450)   <- the three Notes invariants
// @spec       aphotic.md#7.1-notes (L314-L333)
// @spec       aphotic.md#2-hard-constraints (L54)
// @spec       aphotic-governance.md#6.3-note-model (L244-L248)
// @rules      G10
// @depends    aphotic::notes (T3.1) · aphotic::caps (T1.1) · aphotic::events (T1.0)
// @facts      The three assertions §10 demands of this module, restated as the tests below:
// @facts        (a) A nullifier can be consumed at most once
// @facts            -> a_valid_proof_spends_exactly_once, a_nullifier_can_be_consumed_only_once
// @facts        (b) Total note value in the tree equals Balance<BTC> minus deployed capital
// @facts            -> note_backing_is_an_exact_identity, note_backing_mismatch_aborts
// @facts        (c) No Note carries a free-form amount
// @facts            -> a_note_carries_no_amount_only_a_ladder_index
// @facts      The commitment and nullifier byte layouts are PINNED against a hand-built
// @facts        pre-image rather than against themselves, so a domain-tag or byte-order change
// @facts        cannot pass silently — the RECON R14.2 failure class.
// @facts      Proofs are built in-test by rebuilding the whole padded tree from the leaves via
// @facts        `notes::hash_nodes` and `notes::zero_hash`, i.e. through exactly the public
// @facts        surface a client would use. Nothing reaches inside the tree.
// @implements #[test] fun the_default_ladder_is_the_four_widely_spaced_tiers()   [DONE]
//             #[test] fun a_bad_denom_index_aborts()                             [DONE]
//             #[test] fun the_commitment_layout_is_pinned()                      [DONE]
//             #[test] fun the_leaf_index_is_little_endian_in_the_nullifier()     [DONE]
//             #[test] fun the_four_hashes_are_domain_separated()                 [DONE]
//             #[test] fun a_short_secret_is_rejected()                           [DONE]
//             #[test] fun short_randomness_is_rejected()                         [DONE]
//             #[test] fun a_fresh_tree_publishes_an_empty_root()                 [DONE]
//             #[test] fun appending_moves_the_root_and_takes_the_liability()     [DONE]
//             #[test] fun a_valid_proof_spends_exactly_once()                    [DONE]
//             #[test] fun a_nullifier_can_be_consumed_only_once()                [DONE]
//             #[test] fun a_bad_merkle_proof_is_rejected()                       [DONE]
//             #[test] fun a_wrong_length_proof_is_rejected()                     [DONE]
//             #[test] fun a_leaf_index_past_capacity_is_rejected()               [DONE]
//             #[test] fun a_stale_but_published_root_still_verifies()            [DONE]
//             #[test] fun verify_membership_reports_rather_than_aborts()         [DONE]
//             #[test] fun the_tree_is_append_only()                              [DONE]
//             #[test] fun the_tree_fills_and_then_refuses()                      [DONE]
//             #[test] fun note_backing_is_an_exact_identity()                    [DONE]
//             #[test] fun note_backing_mismatch_aborts()                         [DONE]
//             #[test] fun a_note_carries_no_amount_only_a_ladder_index()         [DONE]
//             #[test] fun the_ladder_is_admin_governed()                         [DONE]
//             #[test] fun a_foreign_admin_cap_cannot_move_the_ladder()           [DONE]
//             #[test] fun the_ladder_cannot_be_repointed_under_live_escrow()     [DONE]
//             #[test] fun the_ladder_cannot_be_repointed_under_live_notes()      [DONE]
//             #[test] fun a_non_ascending_ladder_is_rejected()                   [DONE]
//             #[test] fun an_empty_ladder_is_rejected()                          [DONE]
//             #[test] fun too_many_tiers_is_rejected()                           [DONE]
//             #[test] fun a_zero_denomination_is_rejected()                      [DONE]
//             #[test] fun a_foreign_vault_cap_cannot_append()                    [DONE]
//             #[test] fun a_foreign_vault_cap_cannot_spend()                     [DONE]
//             #[test] fun the_spend_ceiling_respects_the_store_entry_limit()     [DONE]
// @invariant  1. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @invariant  2. No test constructs a proof by reaching into the tree's private state; every
//                one goes through `hash_nodes` / `zero_hash`, the same surface a client has.
// @ac         aphotic.md §10 "Notes", all three bullets
// @verify     sui move test notes
// └── END CONTRACT ───────────────────────────────────────────────────────────

const ADMIN: address = @0xAD;
const KEEPER: address = @0xC0FFEE;

const DENOM_0_01: u64 = 1_000_000;
const DENOM_0_1: u64 = 10_000_000;
const DENOM_1: u64 = 100_000_000;
const DENOM_10: u64 = 1_000_000_000;

// Domain tags, restated here so the layout tests pin them independently of the module.
const DOMAIN_ZERO: u8 = 0;
const DOMAIN_COMMIT: u8 = 1;
const DOMAIN_NULLIFIER: u8 = 2;
const DOMAIN_NODE: u8 = 3;

fun a_vault_id(sc: &mut Scenario): ID {
    let uid = object::new(sc.ctx());
    let id = uid.to_inner();
    uid.delete();
    id
}

/// A deterministic 32-byte field element stand-in.
fun bytes32(tag: u8): vector<u8> {
    let mut v = vector[];
    let mut i = 0u64;
    while (i < 32) {
        v.push_back((((tag as u64) + i) % 256) as u8);
        i = i + 1;
    };
    v
}

fun bootstrap(
    sc: &mut Scenario,
    depth: u8,
): (CapRegistry, VaultCap, DenomLadder, NoteTree, NullifierSet, ID) {
    let vault_id = a_vault_id(sc);
    let (reg, vault_cap) = caps::new_registry(vault_id, ADMIN, KEEPER, sc.ctx());
    let ladder = notes::new_ladder(vault_id);
    let tree = notes::new_tree(vault_id, depth);
    let nulls = notes::new_nullifier_set(vault_id, sc.ctx());
    sc.next_tx(ADMIN);
    (reg, vault_cap, ladder, tree, nulls, vault_id)
}

fun teardown(
    reg: CapRegistry,
    vault_cap: VaultCap,
    ladder: DenomLadder,
    tree: NoteTree,
    nulls: NullifierSet,
) {
    caps::destroy_registry(reg);
    caps::destroy_vault_cap(vault_cap);
    notes::destroy_ladder(ladder);
    notes::destroy_tree(tree);
    notes::destroy_nullifier_set(nulls);
}

/// The leaf row of the padded tree: the real leaves, then `zeros[0]` out to capacity.
fun padded_leaves(tree: &NoteTree, leaves: &vector<vector<u8>>): vector<vector<u8>> {
    let mut level = *leaves;
    let width = notes::capacity(tree);
    let zero = notes::zero_hash(tree, 0);
    while (level.length() < width) {
        level.push_back(zero);
    };
    level
}

/// Rebuild the whole tree from its leaves and hand back the sibling path for `index` —
/// exactly what an off-chain client does before submitting a spend.
fun proof_for(
    tree: &NoteTree,
    leaves: &vector<vector<u8>>,
    index: u64,
): vector<vector<u8>> {
    let mut level = padded_leaves(tree, leaves);
    let mut siblings = vector[];
    let mut idx = index;
    let mut d = 0u64;
    let depth = notes::depth(tree) as u64;
    while (d < depth) {
        let sibling_index = if (idx % 2 == 0) idx + 1 else idx - 1;
        siblings.push_back(*level.borrow(sibling_index));

        let mut next = vector[];
        let mut i = 0u64;
        while (i < level.length()) {
            next.push_back(notes::hash_nodes(level.borrow(i), level.borrow(i + 1)));
            i = i + 2;
        };
        level = next;
        idx = idx / 2;
        d = d + 1;
    };
    siblings
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — the governed ladder
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun the_default_ladder_is_the_four_widely_spaced_tiers() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, tree, nulls, vault_id) = bootstrap(&mut sc, 3);

    // 0.01 / 0.1 / 1 / 10 hBTC at 8 decimals. Few tiers, widely spaced: a ladder fine enough
    // to express exact amounts fragments participants into singleton anonymity sets.
    assert!(notes::denom_count(&ladder) == 4, 0);
    assert!(notes::denom_sats(&ladder, 0) == DENOM_0_01, 1);
    assert!(notes::denom_sats(&ladder, 1) == DENOM_0_1, 2);
    assert!(notes::denom_sats(&ladder, 2) == DENOM_1, 3);
    assert!(notes::denom_sats(&ladder, 3) == DENOM_10, 4);
    assert!(notes::denominations(&ladder) == notes::default_denominations(), 5);
    assert!(notes::ladder_vault_id(&ladder) == vault_id, 6);
    assert!(notes::notes_outstanding(&ladder) == 0, 7);

    // Each tier is a full order of magnitude above the last.
    let mut i = 1u64;
    while (i < 4) {
        let lo = notes::denom_sats(&ladder, ((i - 1) as u8));
        let hi = notes::denom_sats(&ladder, (i as u8));
        assert!(hi == lo * 10, 10 + i);
        i = i + 1;
    };

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = notes::EBadDenomIndex)]
fun a_bad_denom_index_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (_reg, _vault_cap, ladder, _tree, _nulls, _) = bootstrap(&mut sc, 3);
    notes::denom_sats(&ladder, 4);
    abort 42
}

#[test]
fun the_ladder_is_admin_governed() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut ladder, tree, nulls, vault_id) = bootstrap(&mut sc, 3);

    let admin_cap = sc.take_from_sender<AdminCap>();
    let new_ladder = vector[5_000_000, 50_000_000, 500_000_000];
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, new_ladder);

    assert!(notes::denom_count(&ladder) == 3, 0);
    assert!(notes::denom_sats(&ladder, 2) == 500_000_000, 1);

    let emitted = event::events_by_type<events::DenominationsSet>();
    assert!(emitted.length() == 1, 2);
    let (ev_vault, ev_denoms) = events::denominations_set_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id, 3);
    assert!(ev_denoms == new_ladder, 4);

    sc.return_to_sender(admin_cap);
    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = caps::ECapVaultMismatch)]
fun a_foreign_admin_cap_cannot_move_the_ladder() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_admin_cap_for_testing(other_vault, sc.ctx());
    notes::set_denominations(&mut ladder, &tree, &reg, &foreign, vector[1_000_000]);

    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELadderInUse)]
fun the_ladder_cannot_be_repointed_under_live_escrow() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut ladder, mut tree, _nulls, _) = bootstrap(&mut sc, 3);

    // A note stores an INDEX, never an amount — the property that makes it leak nothing is
    // exactly what makes the ladder immutable while escrow is live. Re-pointing here would
    // silently revalue every outstanding commitment.
    let leaf = notes::commitment(1, &bytes32(1), &bytes32(2));
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);

    let admin_cap = sc.take_from_sender<AdminCap>();
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, vector[7]);

    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELadderInUse)]
fun the_ladder_cannot_be_repointed_under_live_notes() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);

    let note = notes::mint_note(&mut ladder, &vault_cap, 2, sc.ctx());
    assert!(notes::notes_outstanding(&ladder) == 1, 0);

    let admin_cap = sc.take_from_sender<AdminCap>();
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, vector[7]);

    // Unreachable; keeps the note from being an unused resource on the happy path.
    let _ = notes::burn_note(&mut ladder, &vault_cap, note);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELadderNotAscending)]
fun a_non_ascending_ladder_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);
    let admin_cap = sc.take_from_sender<AdminCap>();
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, vector[10, 10]);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELadderEmpty)]
fun an_empty_ladder_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);
    let admin_cap = sc.take_from_sender<AdminCap>();
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, vector[]);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELadderTooManyTiers)]
fun too_many_tiers_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);
    let admin_cap = sc.take_from_sender<AdminCap>();
    // Nine tiers. The cap is a DESIGN guard: many narrow tiers fragment the anonymity set.
    notes::set_denominations(
        &mut ladder,
        &tree,
        &reg,
        &admin_cap,
        vector[1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::EZeroDenomination)]
fun a_zero_denomination_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, mut ladder, tree, _nulls, _) = bootstrap(&mut sc, 3);
    let admin_cap = sc.take_from_sender<AdminCap>();
    notes::set_denominations(&mut ladder, &tree, &reg, &admin_cap, vector[0, 10]);
    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// 2 — the commitment / nullifier byte layout (pinned, not self-referential)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun the_commitment_layout_is_pinned() {
    let secret = bytes32(1);
    let randomness = bytes32(2);

    // C = blake2b256( 0x01 ‖ denom_index ‖ secret(32) ‖ randomness(32) ), 66 bytes in.
    let mut preimage = vector[DOMAIN_COMMIT, 2u8];
    preimage.append(secret);
    preimage.append(randomness);
    assert!(preimage.length() == 66, 0);
    assert!(notes::commitment(2, &secret, &randomness) == hash::blake2b256(&preimage), 1);
    assert!(notes::commitment(2, &secret, &randomness).length() == notes::digest_len(), 2);

    // Every input is load-bearing.
    assert!(notes::commitment(3, &secret, &randomness) != notes::commitment(2, &secret, &randomness), 3);
    assert!(notes::commitment(2, &bytes32(9), &randomness) != notes::commitment(2, &secret, &randomness), 4);
    assert!(notes::commitment(2, &secret, &bytes32(9)) != notes::commitment(2, &secret, &randomness), 5);
}

#[test]
fun the_leaf_index_is_little_endian_in_the_nullifier() {
    let secret = bytes32(7);

    // N = blake2b256( 0x02 ‖ secret(32) ‖ leaf_index(8, LITTLE-ENDIAN) ).
    // A byte-order slip here is SILENT — the nullifier simply never matches — which is the
    // exact failure class of the reversed-txid trap in RECON R14.2.
    let mut le = vector[DOMAIN_NULLIFIER];
    le.append(secret);
    le.append(vector[1u8, 0, 0, 0, 0, 0, 0, 0]);
    assert!(notes::nullifier(&secret, 1) == hash::blake2b256(&le), 0);

    let mut be = vector[DOMAIN_NULLIFIER];
    be.append(secret);
    be.append(vector[0u8, 0, 0, 0, 0, 0, 0, 1]);
    assert!(notes::nullifier(&secret, 1) != hash::blake2b256(&be), 1);

    // A multi-byte index exercises more than the low byte.
    let mut le258 = vector[DOMAIN_NULLIFIER];
    le258.append(secret);
    le258.append(vector[2u8, 1, 0, 0, 0, 0, 0, 0]);
    assert!(notes::nullifier(&secret, 258) == hash::blake2b256(&le258), 2);

    // Distinct leaves under the same secret give distinct tags.
    assert!(notes::nullifier(&secret, 1) != notes::nullifier(&secret, 2), 3);
}

#[test]
fun the_four_hashes_are_domain_separated() {
    let a = bytes32(1);
    let b = bytes32(2);

    // The node hash.
    let mut node_pre = vector[DOMAIN_NODE];
    node_pre.append(a);
    node_pre.append(b);
    assert!(notes::hash_nodes(&a, &b) == hash::blake2b256(&node_pre), 0);
    // Order matters: a Merkle tree that folded commutatively would accept a swapped proof.
    assert!(notes::hash_nodes(&a, &b) != notes::hash_nodes(&b, &a), 1);

    // The zero leaf.
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, tree, nulls, _) = bootstrap(&mut sc, 3);
    assert!(notes::zero_hash(&tree, 0) == hash::blake2b256(&vector[DOMAIN_ZERO]), 2);
    assert!(
        notes::zero_hash(&tree, 1) == notes::hash_nodes(&notes::zero_hash(&tree, 0), &notes::zero_hash(&tree, 0)),
        3,
    );

    // Four distinct tags over the same 64 bytes give four distinct digests.
    assert!(notes::hash_nodes(&a, &b) != notes::commitment(0, &a, &b), 4);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = notes::ESecretLength)]
fun a_short_secret_is_rejected() {
    let _ = notes::commitment(0, &vector[1u8, 2u8], &bytes32(2));
}

#[test]
#[expected_failure(abort_code = notes::ERandomnessLength)]
fun short_randomness_is_rejected() {
    let _ = notes::commitment(0, &bytes32(1), &vector[1u8]);
}

// ════════════════════════════════════════════════════════════════════════════
// 3 — the append-only tree
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun a_fresh_tree_publishes_an_empty_root() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, tree, nulls, vault_id) = bootstrap(&mut sc, 3);

    assert!(notes::depth(&tree) == 3, 0);
    assert!(notes::capacity(&tree) == 8, 1);
    assert!(notes::next_index(&tree) == 0, 2);
    assert!(notes::outstanding_sats(&tree) == 0, 3);
    assert!(notes::outstanding_notes(&tree) == 0, 4);
    assert!(notes::tree_vault_id(&tree) == vault_id, 5);

    // The genesis root is the fold of the zero leaf, and it is already a KNOWN root, so a
    // proof against an empty tree is well defined rather than a special case.
    assert!(notes::root(&tree) == notes::zero_hash(&tree, 3), 6);
    assert!(notes::is_known_root(&tree, &notes::root(&tree)), 7);
    assert!(!notes::is_known_root(&tree, &bytes32(9)), 8);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
fun appending_moves_the_root_and_takes_the_liability() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, nulls, vault_id) = bootstrap(&mut sc, 3);

    let before = notes::root(&tree);
    let leaf0 = notes::commitment(0, &bytes32(1), &bytes32(2));
    let index0 = notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, leaf0);

    assert!(index0 == 0, 0);
    assert!(notes::next_index(&tree) == 1, 1);
    assert!(notes::root(&tree) != before, 2);
    assert!(notes::outstanding_sats(&tree) == DENOM_0_01, 3);
    assert!(notes::outstanding_notes(&tree) == 1, 4);
    // Both the old and the new root remain acceptable.
    assert!(notes::is_known_root(&tree, &before), 5);
    assert!(notes::is_known_root(&tree, &notes::root(&tree)), 6);

    let emitted = event::events_by_type<events::NoteCommitted>();
    assert!(emitted.length() == 1, 7);
    let (ev_vault, ev_index, ev_commitment, ev_root, ev_denom, ev_outstanding) =
        events::note_committed_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id, 8);
    assert!(ev_index == 0, 9);
    assert!(ev_commitment == leaf0, 10);
    assert!(ev_root == notes::root(&tree), 11);
    assert!(ev_denom == 0, 12);
    assert!(ev_outstanding == DENOM_0_01, 13);

    // A second, larger tier adds its own denomination and nothing else.
    let leaf1 = notes::commitment(2, &bytes32(3), &bytes32(4));
    let index1 = notes::append_commitment(&mut tree, &ladder, &vault_cap, 2, leaf1);
    assert!(index1 == 1, 14);
    assert!(notes::outstanding_sats(&tree) == DENOM_0_01 + DENOM_1, 15);
    assert!(notes::outstanding_notes(&tree) == 2, 16);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
fun the_tree_is_append_only() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(1, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);
    let leaves = vector[leaf];
    let root_after_append = notes::root(&tree);

    let witness = notes::new_membership_witness(
        1,
        secret,
        randomness,
        0,
        proof_for(&tree, &leaves, 0),
    );
    notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);

    // A spend retires a note through its NULLIFIER. It does not remove a leaf, does not
    // rewind `next_index`, and does not move the root — there is no path in the module that
    // can (@invariant 4).
    assert!(notes::next_index(&tree) == 1, 0);
    assert!(notes::root(&tree) == root_after_append, 1);
    assert!(notes::outstanding_notes(&tree) == 0, 2);

    // And the slot is not reused: the next append lands at index 1.
    let leaf2 = notes::commitment(0, &bytes32(5), &bytes32(6));
    assert!(notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, leaf2) == 1, 3);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = notes::ETreeFull)]
fun the_tree_fills_and_then_refuses() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, _nulls, _) = bootstrap(&mut sc, 1);
    assert!(notes::capacity(&tree) == 2, 0);

    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, notes::commitment(0, &bytes32(1), &bytes32(2)));
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, notes::commitment(0, &bytes32(3), &bytes32(4)));
    assert!(notes::next_index(&tree) == 2, 1);

    caps::destroy_registry(reg);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, notes::commitment(0, &bytes32(5), &bytes32(6)));
    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// 4 — membership proofs and the nullifier (§10 "A nullifier can be consumed at most once")
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun a_valid_proof_spends_exactly_once() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, vault_id) = bootstrap(&mut sc, 3);

    // Three depositors, and we retire the middle one.
    let s0 = bytes32(1);
    let r0 = bytes32(2);
    let s1 = bytes32(3);
    let r1 = bytes32(4);
    let s2 = bytes32(5);
    let r2 = bytes32(6);
    let c0 = notes::commitment(0, &s0, &r0);
    let c1 = notes::commitment(2, &s1, &r1);
    let c2 = notes::commitment(1, &s2, &r2);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, c0);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 2, c1);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, c2);

    let leaves = vector[c0, c1, c2];
    assert!(notes::verify_membership(&tree, c1, 1, &proof_for(&tree, &leaves, 1)), 0);
    assert!(notes::outstanding_sats(&tree) == DENOM_0_01 + DENOM_1 + DENOM_0_1, 1);

    let tag = notes::nullifier(&s1, 1);
    assert!(!notes::is_spent(&nulls, &tag), 2);

    sc.next_tx(ADMIN);
    let witness = notes::new_membership_witness(2, s1, r1, 1, proof_for(&tree, &leaves, 1));
    let sats = notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);

    assert!(sats == DENOM_1, 3);
    assert!(notes::is_spent(&nulls, &tag), 4);
    assert!(notes::nullifier_count(&nulls) == 1, 5);
    assert!(notes::outstanding_sats(&tree) == DENOM_0_01 + DENOM_0_1, 6);
    assert!(notes::outstanding_notes(&tree) == 2, 7);

    // The receipt publishes the nullifier — that is its purpose — and NOT the leaf index,
    // which would link the spend back to the deposit that funded it.
    let emitted = event::events_by_type<events::NoteSpent>();
    assert!(emitted.length() == 1, 8);
    let (ev_vault, ev_tag, ev_denom, ev_sats, ev_outstanding) =
        events::note_spent_fields(emitted.borrow(0));
    assert!(ev_vault == vault_id, 9);
    assert!(ev_tag == tag, 10);
    assert!(ev_denom == 2, 11);
    assert!(ev_sats == DENOM_1, 12);
    assert!(ev_outstanding == DENOM_0_01 + DENOM_0_1, 13);

    // The neighbours are untouched and still spendable.
    assert!(!notes::is_spent(&nulls, &notes::nullifier(&s0, 0)), 14);
    assert!(!notes::is_spent(&nulls, &notes::nullifier(&s2, 2)), 15);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = notes::ENullifierAlreadySpent)]
fun a_nullifier_can_be_consumed_only_once() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(3, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 3, leaf);
    let leaves = vector[leaf];

    let first = notes::new_membership_witness(3, secret, randomness, 0, proof_for(&tree, &leaves, 0));
    assert!(notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, first) == DENOM_10, 0);

    caps::destroy_registry(reg);

    // The proof is still perfectly valid — the tree is append-only, so the leaf never left.
    // Only the nullifier stops the second spend.
    let second = notes::new_membership_witness(3, secret, randomness, 0, proof_for(&tree, &leaves, 0));
    notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, second);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::EUnknownRoot)]
fun a_bad_merkle_proof_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(1, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);

    // A well-formed path of the right length, made of the wrong digests.
    let bogus = vector[bytes32(11), bytes32(12), bytes32(13)];
    assert!(!notes::verify_membership(&tree, leaf, 0, &bogus), 0);

    caps::destroy_registry(reg);
    let witness = notes::new_membership_witness(1, secret, randomness, 0, bogus);
    notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::EBadProofLength)]
fun a_wrong_length_proof_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(1, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);
    caps::destroy_registry(reg);

    // Two siblings for a depth-3 tree: a truncated path must never fold to a shorter root.
    let witness = notes::new_membership_witness(
        1,
        secret,
        randomness,
        0,
        vector[bytes32(11), bytes32(12)],
    );
    notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ELeafIndexOutOfRange)]
fun a_leaf_index_past_capacity_is_rejected() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(1, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);
    caps::destroy_registry(reg);

    let witness = notes::new_membership_witness(
        1,
        secret,
        randomness,
        8,
        vector[bytes32(11), bytes32(12), bytes32(13)],
    );
    notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);
    abort 42
}

#[test]
fun a_stale_but_published_root_still_verifies() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let s0 = bytes32(1);
    let r0 = bytes32(2);
    let c0 = notes::commitment(1, &s0, &r0);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, c0);

    // The depositor builds their proof HERE, against the root of a one-leaf tree.
    let proof = proof_for(&tree, &vector[c0], 0);

    // Somebody else's deposit lands first and moves the root.
    let c1 = notes::commitment(0, &bytes32(3), &bytes32(4));
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, c1);
    assert!(notes::verify_membership(&tree, c0, 0, &proof), 0);

    // The already-built proof must still settle, or every deposit would grief every pending
    // spend. That is what the rolling root history is for.
    let witness = notes::new_membership_witness(1, s0, r0, 0, proof);
    assert!(notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness) == DENOM_0_1, 1);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
fun verify_membership_reports_rather_than_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, nulls, _) = bootstrap(&mut sc, 3);

    let leaf = notes::commitment(1, &bytes32(1), &bytes32(2));
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);
    let proof = proof_for(&tree, &vector[leaf], 0);

    assert!(notes::verify_membership(&tree, leaf, 0, &proof), 0);
    // Wrong length -> false, not an abort.
    assert!(!notes::verify_membership(&tree, leaf, 0, &vector[bytes32(1)]), 1);
    // Index past capacity -> false, not an abort.
    assert!(!notes::verify_membership(&tree, leaf, 8, &proof), 2);
    // Right proof, wrong leaf.
    assert!(!notes::verify_membership(&tree, notes::commitment(1, &bytes32(9), &bytes32(9)), 0, &proof), 3);
    // Right leaf, wrong index: the path is folded in the other order and cannot match.
    assert!(!notes::verify_membership(&tree, leaf, 1, &proof), 4);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// 5 — backing (§10 "Total note value in the tree equals Balance<BTC> minus deployed capital")
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun note_backing_is_an_exact_identity() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    // Empty tree, empty vault.
    notes::assert_note_backing(&tree, 0, 0);

    let s0 = bytes32(1);
    let r0 = bytes32(2);
    let c0 = notes::commitment(2, &s0, &r0);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 2, c0);
    let c1 = notes::commitment(0, &bytes32(3), &bytes32(4));
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 0, c1);

    // 1 hBTC + 0.01 hBTC of escrow, sitting in a vault that also has 3 hBTC out on loan.
    let escrow = DENOM_1 + DENOM_0_01;
    notes::assert_note_backing(&tree, escrow + 300_000_000, 300_000_000);

    // Retiring a note lowers the liability by exactly its ladder value, so the identity holds
    // across the spend rather than only at the endpoints.
    let witness = notes::new_membership_witness(2, s0, r0, 0, proof_for(&tree, &vector[c0, c1], 0));
    let paid = notes::spend(&mut tree, &mut nulls, &ladder, &vault_cap, witness);
    assert!(paid == DENOM_1, 0);
    notes::assert_note_backing(&tree, escrow - paid + 300_000_000, 300_000_000);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

#[test]
#[expected_failure(abort_code = notes::ENoteBackingMismatch)]
fun note_backing_mismatch_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, _nulls, _) = bootstrap(&mut sc, 3);

    notes::append_commitment(
        &mut tree,
        &ladder,
        &vault_cap,
        2,
        notes::commitment(2, &bytes32(1), &bytes32(2)),
    );
    caps::destroy_registry(reg);

    // One satoshi short of the escrow it is supposed to back.
    notes::assert_note_backing(&tree, DENOM_1 - 1, 0);
    abort 42
}

// ════════════════════════════════════════════════════════════════════════════
// 6 — the Note object (§10 "No Note carries a free-form amount")
// ════════════════════════════════════════════════════════════════════════════

#[test]
fun a_note_carries_no_amount_only_a_ladder_index() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, mut ladder, tree, nulls, vault_id) = bootstrap(&mut sc, 3);

    let a = notes::mint_note(&mut ladder, &vault_cap, 1, sc.ctx());
    let b = notes::mint_note(&mut ladder, &vault_cap, 1, sc.ctx());

    // `Note` has exactly two fields — `id` and `denom_index` — so `note_denom_index` is the
    // ONLY thing readable off it. Two notes of the same tier are therefore indistinguishable
    // apart from their object id: there is no amount to compare.
    assert!(notes::note_denom_index(&a) == 1, 0);
    assert!(notes::note_denom_index(&a) == notes::note_denom_index(&b), 1);
    assert!(object::id(&a) != object::id(&b), 2);

    // The value comes from the GOVERNED LADDER, never from the note.
    assert!(notes::denom_sats(&ladder, notes::note_denom_index(&a)) == DENOM_0_1, 3);
    assert!(notes::notes_outstanding(&ladder) == 2, 4);

    let minted = event::events_by_type<events::NoteMinted>();
    assert!(minted.length() == 2, 5);
    let (ev_vault, ev_note, ev_denom) = events::note_minted_fields(minted.borrow(0));
    assert!(ev_vault == vault_id && ev_note == object::id(&a) && ev_denom == 1, 6);

    let id_a = object::id(&a);
    assert!(notes::burn_note(&mut ladder, &vault_cap, a) == 1, 7);
    assert!(notes::notes_outstanding(&ladder) == 1, 8);

    let burned = event::events_by_type<events::NoteBurned>();
    assert!(burned.length() == 1, 9);
    let (_, ev_burned_id, ev_burned_denom) = events::note_burned_fields(burned.borrow(0));
    assert!(ev_burned_id == id_a && ev_burned_denom == 1, 10);

    assert!(notes::burn_note(&mut ladder, &vault_cap, b) == 1, 11);
    assert!(notes::notes_outstanding(&ladder) == 0, 12);

    teardown(reg, vault_cap, ladder, tree, nulls);
    sc.end();
}

// ════════════════════════════════════════════════════════════════════════════
// 7 — vault binding and the clearing ceiling
// ════════════════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = notes::ECapVaultMismatch)]
fun a_foreign_vault_cap_cannot_append() {
    let mut sc = ts::begin(ADMIN);
    let (reg, _vault_cap, ladder, mut tree, _nulls, _) = bootstrap(&mut sc, 3);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    caps::destroy_registry(reg);

    notes::append_commitment(
        &mut tree,
        &ladder,
        &foreign,
        0,
        notes::commitment(0, &bytes32(1), &bytes32(2)),
    );
    abort 42
}

#[test]
#[expected_failure(abort_code = notes::ECapVaultMismatch)]
fun a_foreign_vault_cap_cannot_spend() {
    let mut sc = ts::begin(ADMIN);
    let (reg, vault_cap, ladder, mut tree, mut nulls, _) = bootstrap(&mut sc, 3);

    let secret = bytes32(1);
    let randomness = bytes32(2);
    let leaf = notes::commitment(1, &secret, &randomness);
    notes::append_commitment(&mut tree, &ladder, &vault_cap, 1, leaf);
    let proof = proof_for(&tree, &vector[leaf], 0);

    let other_vault = a_vault_id(&mut sc);
    let foreign = caps::forge_foreign_vault_cap_for_testing(other_vault);
    caps::destroy_registry(reg);

    let witness = notes::new_membership_witness(1, secret, randomness, 0, proof);
    notes::spend(&mut tree, &mut nulls, &ladder, &foreign, witness);
    abort 42
}

#[test]
fun the_spend_ceiling_respects_the_store_entry_limit() {
    // `object_runtime_max_num_store_entries` is 1_000 dynamic-field/store entries per
    // TRANSACTION and `max_num_event_emit` is 1_024, and neither can be raised by paying more
    // gas. Each spend writes one nullifier row and emits one event, so the downstream
    // MAX_BATCH_SIZE must be governed against this number, not against the gas budget.
    assert!(notes::max_spends_per_tx() == 800, 0);
    assert!(notes::max_spends_per_tx() < 1_000, 1);
    assert!(notes::max_spends_per_tx() < 1_024, 2);

    // The shape guards, restated so a later edit cannot quietly widen them.
    assert!(notes::max_tiers() == 8, 3);
    assert!(notes::max_depth() == 32, 4);
    assert!(notes::root_history() == 32, 5);
    assert!(notes::digest_len() == 32, 6);
}
