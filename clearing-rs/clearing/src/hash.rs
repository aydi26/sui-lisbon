// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#9 (L432) <- "the Rust clearing implementation must produce
//             bit-identical output to the Move one"
// @spec       move/sources/clearing.move#fill_leaf_hash — `sui::hash::blake2b256`
// @rules      G10
// @depends    nothing — this file is a LEAF and must stay one.
// @facts      Sui's `sui::hash::blake2b256` is unkeyed BLAKE2b (RFC 7693) with a 32-byte
// @facts        digest length, i.e. BLAKE2b-256 — NOT BLAKE2s and NOT truncated BLAKE2b-512.
// @facts      Parameter block for the unkeyed 32-byte variant: h[0] ^= 0x01010000 ^ (kk<<8) ^ nn
// @facts        with kk = 0 and nn = 32  =>  h[0] ^= 0x0101_0020.
// @facts      Rotation constants R1..R4 = 32, 24, 16, 63.  Rounds = 12, SIGMA rows 10 and 11
// @facts        reuse SIGMA[0] and SIGMA[1].
// @facts      Block size = 128 bytes. The empty message hashes ONE all-zero block with t = 0.
// @facts      KNOWN-ANSWER VECTORS pinned in the tests below (published BLAKE2b-256 digests):
// @facts        ""     -> 0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8
// @facts        "abc"  -> bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319
// @implements pub fn blake2b256(input: &[u8]) -> [u8; 32]
// @forbidden  a hashing crate dependency — the twin must not be able to drift because an
//             upstream default changed, and `cargo test` must need no network
// @invariant  1. blake2b256 agrees with the published BLAKE2b-256 known-answer vectors.
// @invariant  2. Hashing is chunk-boundary independent: a 128-byte-aligned message and a
//                message one byte either side both hash correctly (block/padding logic).
// @ac         cargo test -p clearing hash
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

const IV: [u64; 8] = [
    0x6a09_e667_f3bc_c908,
    0xbb67_ae85_84ca_a73b,
    0x3c6e_f372_fe94_f82b,
    0xa54f_f53a_5f1d_36f1,
    0x510e_527f_ade6_82d1,
    0x9b05_688c_2b3e_6c1f,
    0x1f83_d9ab_fb41_bd6b,
    0x5be0_cd19_137e_2179,
];

const SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const BLOCK_BYTES: usize = 128;
const DIGEST_BYTES: usize = 32;

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn g(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

/// The BLAKE2b compression function F. `t` is the byte counter, `last` marks the final block.
fn compress(h: &mut [u64; 8], block: &[u8; BLOCK_BYTES], t: u128, last: bool) {
    let mut m = [0u64; 16];
    for (i, word) in m.iter_mut().enumerate() {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&block[i * 8..i * 8 + 8]);
        *word = u64::from_le_bytes(buf);
    }

    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);

    v[12] ^= t as u64;
    v[13] ^= (t >> 64) as u64;
    if last {
        v[14] ^= u64::MAX;
    }

    for r in 0..12 {
        let s = &SIGMA[r % 10];
        g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }

    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

/// Unkeyed BLAKE2b with a 32-byte digest — the exact function behind `sui::hash::blake2b256`.
pub fn blake2b256(input: &[u8]) -> [u8; DIGEST_BYTES] {
    let full = blake2b(input, DIGEST_BYTES);
    let mut out = [0u8; DIGEST_BYTES];
    out.copy_from_slice(&full);
    out
}

/// Unkeyed BLAKE2b at an arbitrary digest length, 1..=64 bytes.
///
/// Exists ONLY so the multi-block path can be pinned against OpenSSL, which exposes BLAKE2b at
/// 64 bytes and nowhere else (see `crate::vectors`). Nothing in the clearing algorithm calls
/// this with `outlen != 32`; `blake2b256` is the production entry point.
pub fn blake2b(input: &[u8], outlen: usize) -> Vec<u8> {
    assert!((1..=64).contains(&outlen), "blake2b: outlen must be 1..=64");
    let mut h = IV;
    // kk = 0 (unkeyed), fanout = 1, depth = 1. The DIGEST LENGTH IS PART OF THE PARAMETER
    // BLOCK — which is why BLAKE2b-256 is not a truncation of BLAKE2b-512.
    h[0] ^= 0x0101_0000 ^ (outlen as u64);

    let n = input.len();
    // Every block but the last is compressed as a non-final block. An empty message still
    // compresses exactly one (all-zero) final block with t = 0.
    let full_blocks = if n == 0 { 0 } else { (n - 1) / BLOCK_BYTES };

    let mut block = [0u8; BLOCK_BYTES];
    for i in 0..full_blocks {
        block.copy_from_slice(&input[i * BLOCK_BYTES..(i + 1) * BLOCK_BYTES]);
        compress(&mut h, &block, ((i + 1) * BLOCK_BYTES) as u128, false);
    }

    let tail_start = full_blocks * BLOCK_BYTES;
    block = [0u8; BLOCK_BYTES];
    block[..n - tail_start].copy_from_slice(&input[tail_start..]);
    compress(&mut h, &block, n as u128, true);

    let mut full = [0u8; 64];
    for i in 0..8 {
        full[i * 8..i * 8 + 8].copy_from_slice(&h[i].to_le_bytes());
    }
    full[..outlen].to_vec()
}

/// Lower-case hex, for pinning bytes in tests and reports.
pub fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(D[(b >> 4) as usize] as char);
        s.push(D[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_answer_empty() {
        assert_eq!(
            hex(&blake2b256(b"")),
            "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
    }

    #[test]
    fn known_answer_abc() {
        assert_eq!(
            hex(&blake2b256(b"abc")),
            "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"
        );
    }

    #[test]
    fn known_answer_quick_brown_fox() {
        assert_eq!(
            hex(&blake2b256(b"The quick brown fox jumps over the lazy dog")),
            "01718cec35cd3d796dd00020e0bfecb473ad23457d063b75eff29c0ffa2e58a9"
        );
    }

    /// @invariant 2 — the block/padding boundary is where a hand-rolled BLAKE2b breaks, and
    /// none of the three published known-answer vectors above is longer than 43 bytes.
    ///
    /// The multi-block path is pinned against OPENSSL instead, at the 64-byte digest length
    /// OpenSSL exposes. That covers the compression function, the chaining, the byte counter
    /// and the padding; the digest-length parameter itself is covered by the 256-bit vectors
    /// above. See `crate::vectors` for how the table was produced.
    #[test]
    fn multi_block_matches_openssl() {
        for (len, expect) in crate::vectors::BLAKE2B512_KAT {
            let msg = crate::vectors::kat_message(*len);
            assert_eq!(
                &hex(&blake2b(&msg, 64)),
                expect,
                "blake2b diverged from OpenSSL at length {len}"
            );
        }
    }

    /// BLAKE2b-256 is NOT truncated BLAKE2b-512. If it ever were, every fill root in this repo
    /// would be wrong and no other test here would notice.
    #[test]
    fn b256_is_not_a_truncation_of_b512() {
        let msg = b"aphotic";
        assert_ne!(&blake2b256(msg)[..], &blake2b(msg, 64)[..32]);
    }

    #[test]
    fn different_lengths_differ() {
        // Cheap structural check that does not depend on a memorised digest.
        let a = blake2b256(&[0u8; 127]);
        let b = blake2b256(&[0u8; 128]);
        let c = blake2b256(&[0u8; 129]);
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn hex_roundtrips_length() {
        assert_eq!(hex(&blake2b256(b"x")).len(), 64);
    }
}
