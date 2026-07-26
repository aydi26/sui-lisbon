// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move#compute_root (L856-L881) · #verify_fill (L885-L903)
// @spec       move/sources/clearing.move#sibling_path_for_testing (L1056-L1085)
// @rules      G10
// @depends    crate::hash · crate::bcs · crate::types
// @facts      FILL TREE (clearing.move L98-L101):
// @facts        leaf  = blake2b256(0x00 ‖ bcs(Fill))
// @facts        node  = blake2b256(0x01 ‖ left ‖ right)
// @facts        an ODD node at any level is DUPLICATED (paired with itself)
// @facts        the EMPTY tree is 32 ZERO BYTES — not blake2b256(""), not an error
// @facts      ⚠ These tags are DISTINCT from the note tree in `aphotic::notes`, which uses
// @facts        0x00/0x01/0x02/0x03 for a different purpose. The two trees are never mixed:
// @facts        this root lives on the `Clearing` object and only `verify_fill` reads it.
// @facts      PROOF WALK: at each level, `current` is the LEFT input when idx is even and the
// @facts        RIGHT input when idx is odd, then idx /= 2. A duplicated odd node therefore has
// @facts        ITSELF as its sibling.
// @implements pub fn fill_leaf_hash(f: &Fill) -> [u8; 32]
//             pub fn hash_pair(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32]
//             pub fn zero_root() -> [u8; 32]
//             pub fn compute_root(fills: &[Fill]) -> [u8; 32]
//             pub fn sibling_path(fills: &[Fill], index: usize) -> Vec<[u8; 32]>
//             pub fn verify_fill(root, f, index, siblings) -> bool
// @forbidden  padding the leaf level to a power of two — Move duplicates the odd node instead,
//             and the two conventions give different roots for every non-power-of-two count
// @invariant  1. compute_root(&[]) is 32 zero bytes.
// @invariant  2. sibling_path(fills, i) verifies against compute_root(fills), for every i and
//                every fill count from 1 to at least 33 (odd, even, and power-of-two counts).
// @invariant  3. A forged leaf at a valid position does NOT verify.
// @ac         cargo test -p clearing merkle
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use crate::bcs::fill_to_bcs;
use crate::hash::blake2b256;
use crate::types::Fill;

pub const LEAF_TAG: u8 = 0x00;
pub const NODE_TAG: u8 = 0x01;

/// `blake2b256(0x00 ‖ bcs(Fill))` — the Merkle leaf, byte for byte.
pub fn fill_leaf_hash(f: &Fill) -> [u8; 32] {
    let mut buf = [0u8; 1 + crate::bcs::FILL_BCS_LEN];
    buf[0] = LEAF_TAG;
    buf[1..].copy_from_slice(&fill_to_bcs(f));
    blake2b256(&buf)
}

/// `blake2b256(0x01 ‖ left ‖ right)`.
pub fn hash_pair(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 1 + 64];
    buf[0] = NODE_TAG;
    buf[1..33].copy_from_slice(l);
    buf[33..].copy_from_slice(r);
    blake2b256(&buf)
}

/// The empty tree: 32 zero bytes. NOT a hash of anything.
pub const fn zero_root() -> [u8; 32] {
    [0u8; 32]
}

/// Fold the fill list into a root, duplicating the odd node at each level.
pub fn compute_root(fills: &[Fill]) -> [u8; 32] {
    if fills.is_empty() {
        return zero_root();
    }
    let mut level: Vec<[u8; 32]> = fills.iter().map(fill_leaf_hash).collect();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let m = level.len();
        let mut j = 0usize;
        while j < m {
            let l = &level[j];
            // Odd node duplicated — the same rule as clearing.move L874.
            let r = if j + 1 < m { &level[j + 1] } else { l };
            next.push(hash_pair(l, r));
            j += 2;
        }
        level = next;
    }
    level[0]
}

/// The sibling path for `index`, mirroring `sibling_path_for_testing` exactly. Public here
/// because off-chain this is the transparency surface a front end needs, not a test helper.
pub fn sibling_path(fills: &[Fill], index: usize) -> Vec<[u8; 32]> {
    let mut siblings = Vec::new();
    if fills.is_empty() {
        return siblings;
    }
    let mut level: Vec<[u8; 32]> = fills.iter().map(fill_leaf_hash).collect();
    let mut idx = index;
    while level.len() > 1 {
        let m = level.len();
        let sib_i = if idx % 2 == 0 {
            if idx + 1 < m {
                idx + 1
            } else {
                idx
            }
        } else {
            idx - 1
        };
        siblings.push(level[sib_i]);

        let mut next = Vec::with_capacity(m.div_ceil(2));
        let mut j = 0usize;
        while j < m {
            let l = &level[j];
            let r = if j + 1 < m { &level[j + 1] } else { l };
            next.push(hash_pair(l, r));
            j += 2;
        }
        level = next;
        idx /= 2;
    }
    siblings
}

/// `clearing::verify_fill`, minus the stage assert (which lives on the engine).
pub fn verify_fill(root: &[u8; 32], f: &Fill, index: usize, siblings: &[[u8; 32]]) -> bool {
    let mut current = fill_leaf_hash(f);
    let mut idx = index;
    for sib in siblings {
        current = if idx % 2 == 0 {
            hash_pair(&current, sib)
        } else {
            hash_pair(sib, &current)
        };
        idx /= 2;
    }
    &current == root
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Address;

    fn fills(n: usize) -> Vec<Fill> {
        (0..n)
            .map(|i| Fill {
                batch_id: 7,
                order_index: i as u64,
                submitter: Address::from_u128(0xB0B + i as u128),
                is_bid: i % 2 == 0,
                base_sats: 1_000 + i as u64,
                quote_sats: 990 + i as u64,
                price: 99_000_000,
            })
            .collect()
    }

    /// @invariant 1.
    #[test]
    fn empty_tree_is_32_zero_bytes() {
        assert_eq!(compute_root(&[]), [0u8; 32]);
        assert_eq!(compute_root(&[]).len(), 32);
    }

    #[test]
    fn single_fill_root_is_its_leaf() {
        let f = fills(1);
        assert_eq!(compute_root(&f), fill_leaf_hash(&f[0]));
    }

    /// The odd-node rule, spelled out rather than trusted: three leaves fold as
    /// (h01, h22) where h22 pairs leaf 2 with ITSELF.
    #[test]
    fn odd_node_is_duplicated_not_padded() {
        let f = fills(3);
        let l0 = fill_leaf_hash(&f[0]);
        let l1 = fill_leaf_hash(&f[1]);
        let l2 = fill_leaf_hash(&f[2]);
        let want = hash_pair(&hash_pair(&l0, &l1), &hash_pair(&l2, &l2));
        assert_eq!(compute_root(&f), want);

        // Zero-padding to four leaves would give a DIFFERENT root. Prove they differ so the
        // two conventions can never be confused.
        let padded = hash_pair(&hash_pair(&l0, &l1), &hash_pair(&l2, &[0u8; 32]));
        assert_ne!(compute_root(&f), padded);
    }

    /// @invariant 2 — every index, across odd / even / power-of-two counts.
    #[test]
    fn every_path_verifies_for_every_size() {
        for n in 1..=33usize {
            let f = fills(n);
            let root = compute_root(&f);
            for i in 0..n {
                let path = sibling_path(&f, i);
                assert!(
                    verify_fill(&root, &f[i], i, &path),
                    "path failed for n={n} i={i}"
                );
            }
        }
    }

    /// @invariant 3.
    #[test]
    fn a_forged_leaf_does_not_verify() {
        let f = fills(5);
        let root = compute_root(&f);
        let path = sibling_path(&f, 0);
        let mut forged = f[0];
        forged.price += 1;
        assert!(!verify_fill(&root, &forged, 0, &path));

        // Nor does a real leaf at the wrong position.
        assert!(!verify_fill(&root, &f[1], 0, &path));
    }

    #[test]
    fn tags_are_distinct_so_a_leaf_cannot_pose_as_a_node() {
        assert_ne!(LEAF_TAG, NODE_TAG);
        let z = [0u8; 32];
        // A 64-byte "fill" cannot exist (bcs(Fill) is 73 bytes), but assert the tag separation
        // directly anyway: the domain separation is the whole point of the prefix byte.
        let node = hash_pair(&z, &z);
        let mut leafish = [0u8; 1 + crate::bcs::FILL_BCS_LEN];
        leafish[0] = LEAF_TAG;
        assert_ne!(node, blake2b256(&leafish));
    }
}
