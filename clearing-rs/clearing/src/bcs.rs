// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move#fill_leaf_hash (L833-L837) <- `bcs::to_bytes(f)`
// @spec       move/sources/clearing.move (struct Fill, L202-L210) <- the field ORDER is the
//             wire format; reordering the struct silently changes every root
// @rules      G10
// @depends    crate::types (Fill, Address)
// @facts      BCS encodes a struct as the concatenation of its fields IN DECLARATION ORDER,
// @facts        with no tag, no length prefix and no padding.
// @facts        u64     -> 8 bytes LITTLE-ENDIAN
// @facts        bool    -> 1 byte, 0x00 or 0x01
// @facts        address -> 32 raw bytes, NO length prefix (Sui addresses are fixed-size)
// @facts      => bcs(Fill) is exactly 8+8+32+1+8+8+8 = 73 bytes, and the leaf pre-image is
// @facts        1 + 73 = 74 bytes (LEAF_TAG ‖ bcs(Fill)).
// @facts      ⚠ THE BYTE-ORDER TRAP: the u64s are LITTLE-endian while the address is BIG-endian.
// @facts        Same failure class as RECON R14.2 (the byte-reversed Bitcoin txid) and
// @facts        DESIGN-V2 F1 (the big-endian Seal identity): a byte-order slip here produces a
// @facts        different root with no error anywhere, on either side.
// @implements pub fn fill_to_bcs(f: &Fill) -> [u8; FILL_BCS_LEN]
//             pub const FILL_BCS_LEN: usize = 73
// @forbidden  a serde/bcs crate dependency — see the crate README
// @invariant  1. fill_to_bcs is exactly 73 bytes.
// @invariant  2. The encoding matches a HAND-BUILT pre-image, not a re-derivation of itself.
// @invariant  3. Every field is load-bearing: changing any one changes the bytes.
// @ac         cargo test -p clearing bcs
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use crate::types::Fill;

/// bcs(Fill) is fixed-width: two u64s, an address, a bool, then three u64s.
pub const FILL_BCS_LEN: usize = 8 + 8 + 32 + 1 + 8 + 8 + 8;

/// BCS-encode a `Fill` exactly as `sui::bcs::to_bytes` does in `clearing.move`.
pub fn fill_to_bcs(f: &Fill) -> [u8; FILL_BCS_LEN] {
    let mut out = [0u8; FILL_BCS_LEN];
    let mut at = 0usize;

    let put_u64 = |out: &mut [u8; FILL_BCS_LEN], at: &mut usize, v: u64| {
        out[*at..*at + 8].copy_from_slice(&v.to_le_bytes());
        *at += 8;
    };

    put_u64(&mut out, &mut at, f.batch_id);
    put_u64(&mut out, &mut at, f.order_index);
    out[at..at + 32].copy_from_slice(f.submitter.bytes());
    at += 32;
    out[at] = u8::from(f.is_bid);
    at += 1;
    put_u64(&mut out, &mut at, f.base_sats);
    put_u64(&mut out, &mut at, f.quote_sats);
    put_u64(&mut out, &mut at, f.price);

    debug_assert_eq!(at, FILL_BCS_LEN);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Address;

    fn sample() -> Fill {
        Fill {
            batch_id: 1,
            order_index: 2,
            submitter: Address::from_u128(0xB0B),
            is_bid: true,
            base_sats: 0x0102_0304_0506_0708,
            quote_sats: 990_000,
            price: 99_000_000,
        }
    }

    #[test]
    fn length_is_73() {
        assert_eq!(FILL_BCS_LEN, 73);
        assert_eq!(fill_to_bcs(&sample()).len(), 73);
    }

    /// @invariant 2 — the expectation is BUILT BY HAND from the BCS rules, field by field, so
    /// the test cannot pass by agreeing with a mistake in `fill_to_bcs`.
    #[test]
    fn matches_a_hand_built_preimage() {
        let f = sample();
        let mut want = Vec::with_capacity(73);

        // batch_id: u64 = 1, LITTLE-endian.
        want.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0, 0]);
        // order_index: u64 = 2, LITTLE-endian.
        want.extend_from_slice(&[0x02, 0, 0, 0, 0, 0, 0, 0]);
        // submitter: @0xB0B — 32 bytes, BIG-endian, right-aligned.
        want.extend_from_slice(&[0u8; 30]);
        want.extend_from_slice(&[0x0B, 0x0B]);
        // is_bid: true.
        want.push(0x01);
        // base_sats: 0x0102030405060708 reversed by the little-endian rule.
        want.extend_from_slice(&[0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
        // quote_sats: 990_000 = 0x0F_1B30 -> 30 1b 0f 00 00 00 00 00
        want.extend_from_slice(&[0x30, 0x1B, 0x0F, 0, 0, 0, 0, 0]);
        // price: 99_000_000 = 0x05E6_9EC0 -> c0 9e e6 05 00 00 00 00
        want.extend_from_slice(&[0xC0, 0x9E, 0xE6, 0x05, 0, 0, 0, 0]);

        assert_eq!(want.len(), 73);
        assert_eq!(&fill_to_bcs(&f)[..], &want[..]);
    }

    #[test]
    fn bool_false_is_a_zero_byte() {
        let mut f = sample();
        f.is_bid = false;
        assert_eq!(fill_to_bcs(&f)[48], 0x00);
        f.is_bid = true;
        assert_eq!(fill_to_bcs(&f)[48], 0x01);
    }

    /// @invariant 3 — no field is decorative. If any of these stopped mattering, two different
    /// fills could share a leaf and the root would stop proving what it claims to prove.
    #[test]
    fn every_field_is_load_bearing() {
        let base = fill_to_bcs(&sample());

        let mut f = sample();
        f.batch_id += 1;
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.order_index += 1;
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.submitter = Address::from_u128(0xA11CE);
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.is_bid = false;
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.base_sats += 1;
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.quote_sats += 1;
        assert_ne!(fill_to_bcs(&f), base);

        let mut f = sample();
        f.price += 1;
        assert_ne!(fill_to_bcs(&f), base);
    }

    /// The two u64 legs are little-endian and the address leg is big-endian. Encoding the
    /// address little-endian would be invisible for @0x0 and for palindromes; @0xA11CE is
    /// neither, which is why the Move vectors use it.
    #[test]
    fn address_leg_is_big_endian_not_little() {
        let mut f = sample();
        f.submitter = Address::from_u128(0xA11CE);
        let enc = fill_to_bcs(&f);
        assert_eq!(&enc[16..45], &[0u8; 29]);
        assert_eq!(&enc[45..48], &[0x0A, 0x11, 0xCE]);
    }
}
