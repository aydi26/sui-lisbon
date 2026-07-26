// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       move/sources/clearing.move#fill_leaf_hash <- `sui::hash::blake2b256`
// @rules      G10
// @depends    nothing — a data-only LEAF.
// @facts      WHY: the three published BLAKE2b-256 known-answer vectors in `hash.rs` are all
// @facts        shorter than 44 bytes, so NONE of them exercises the multi-block path — the
// @facts        block counter, the chaining and the final-block flag. That is exactly where a
// @facts        hand-rolled BLAKE2b breaks, and it would break SILENTLY: every fill leaf and
// @facts        every Merkle node is under 128 bytes, so the golden fixtures could not catch it
// @facts        either. A 129-byte message would then hash wrong with nothing red anywhere.
// @facts      SOURCE OF TRUTH: OpenSSL, via `node:crypto`'s `blake2b512`, on Node 24.13.0.
// @facts        Command that produced the table (re-runnable, no network):
// @facts          node -e "const c=require('crypto');for(const L of [...]){const m=
// @facts          Buffer.from(Array.from({length:L},(_,i)=>i%256));
// @facts          console.log(L, c.createHash('blake2b512').update(m).digest('hex'))}"
// @facts      ⚠ WHY 512 AND NOT 256: OpenSSL exposes BLAKE2b only at its full 64-byte digest
// @facts        length. BLAKE2b-256 is NOT truncated BLAKE2b-512 — the digest length is mixed
// @facts        into the parameter block (h[0] ^= 0x0101_0000 ^ nn), so the two differ from the
// @facts        first word. What the 512 table pins is therefore the COMPRESSION FUNCTION, the
// @facts        block chaining, the byte counter and the padding — i.e. everything the
// @facts        published 256 vectors leave untested. `nn` itself is pinned separately by the
// @facts        three short 256 vectors. Together the two cover the whole function.
// @facts      Pre-image for length L is the repeating byte sequence 0,1,2,…,255,0,1,… truncated
// @facts        to L bytes. Lengths straddle every block boundary up to 1 000.
// @implements pub const BLAKE2B512_KAT: &[(usize, &str)]
// @forbidden  regenerating this table from THIS crate's own blake2b — that would make the test
//             assert that the code agrees with itself
// @ac         cargo test -p clearing hash
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

/// `(message_length, blake2b-512 hex digest)` — OpenSSL, via `node:crypto`.
pub const BLAKE2B512_KAT: &[(usize, &str)] = &[
    (0, "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"),
    (1, "2fa3f686df876995167e7c2e5d74c4c7b6e48f8068fe0e44208344d480f7904c36963e44115fe3eb2a3ac8694c28bcb4f5a0f3276f2e79487d8219057a506e4b"),
    (2, "1c08798dc641aba9dee435e22519a4729a09b2bfe0ff00ef2dcd8ed6f8a07d15eaf4aee52bbf18ab5608a6190f70b90486c8a7d4873710b1115d3debbb4327b5"),
    (63, "d10bf9a15b1c9fc8d41f89bb140bf0be08d2f3666176d13baac4d381358ad074c9d4748c300520eb026daeaea7c5b158892fde4e8ec17dc998dcd507df26eb63"),
    (64, "2fc6e69fa26a89a5ed269092cb9b2a449a4409a7a44011eecad13d7c4b0456602d402fa5844f1a7a758136ce3d5d8d0e8b86921ffff4f692dd95bdc8e5ff0052"),
    (65, "fcbe8be7dcb49a32dbdf239459e26308b84dff1ea480df8d104eeff34b46fae98627b450c2267d48c0946a697c5b59531452ac0484f1c84e3a33d0c339bb2e28"),
    (127, "b6292669ccd38d5f01caae96ba272c76a879a45743afa0725d83b9ebb26665b731f1848c52f11972b6644f554c064fa90780dbbbf3a89d4fc31f67df3e5857ef"),
    (128, "2319e3789c47e2daa5fe807f61bec2a1a6537fa03f19ff32e87eecbfd64b7e0e8ccff439ac333b040f19b0c4ddd11a61e24ac1fe0f10a039806c5dcc0da3d115"),
    (129, "f59711d44a031d5f97a9413c065d1e614c417ede998590325f49bad2fd444d3e4418be19aec4e11449ac1a57207898bc57d76a1bcf3566292c20c683a5c4648f"),
    (130, "df0a9d0c212843a6a934e3902b2dd30d17fba5f969d2030b12a546d8a6a45e80cf5635f071f0452e9c919275da99bed51eb1173c1af0518726b75b0ec3bae2b5"),
    (191, "b9d7ca81cc60bb9578e44024e5a0a0be80f27336a6a9f4e53df3999cb191280b090e2ac2d29c5baad9d71415bdc129e69aa2667af6a7fd5e189fccdcee817340"),
    (255, "5b21c5fd8868367612474fa2e70e9cfa2201ffeee8fafab5797ad58fefa17c9b5b107da4a3db6320baaf2c8617d5a51df914ae88da3867c2d41f0cc14fa67928"),
    (256, "1ecc896f34d3f9cac484c73f75f6a5fb58ee6784be41b35f46067b9c65c63a6794d3d744112c653f73dd7deb6666204c5a9bfa5b46081fc10fdbe7884fa5cbf8"),
    (257, "d8bfe068de0b4f9fa876a3f8024eb9f7b0029fd5dcf251199e065cee89e1a282c8dbf0442f2ade7294ac1c6be19b388dc990c34d8cb79f5f10c54fa813834fda"),
    (383, "6af23f91ca3ca49b5c8267ea6e6e6597d34b0ae22d17634d2f48e6877f92809cc0a4f3fd9344ce154814493bd35c776923f9492e3733ac8cbc600e963dc78257"),
    (384, "49b3d01a1f21431d4a9b65e0450bb0444b7d1deb81131d650d9cbefcad7436a0e51050445af39f3f1312dbe3e2d03601ba309d3bc3c46bc5bdc768feebe176fb"),
    (385, "49b5b192ab4bc11a8bdf3a092d66b076aec56caab4549d850b33c37caace60925f556073081f35d0b95a4c92533940bceb115adfb51842de6d45a62b54e03083"),
    (511, "13168377cc369541f6819b436d22a260d3e824ec54a1ae69d97b57072715e54f1c4962bb2780110b18fbb258eb4a47381a709e6091817d1556f856e6fac2a9b4"),
    (512, "c59ab1095ca4579525338b6b74689ff234bc3fe9765fe26dfb04ddceaee0ab84dfd8967594cb261fcd88687f4454d80f718116c1b3c32f9f7e169357468cbe67"),
    (513, "68812f695bbb6bded5e12bb37c08a99fbab6e71b18b045223082791b120d8588a9c42466970adadddeb770ef5f1cdebd24c81a3519af977e6b539366c838cfaa"),
    (1000, "9fe687126e6566313081b43167cbfa0b4f721b45a5afd4076af327765d63a616478ffbd1cd5fbe4033e8638b8bcf8de6b3978b54a30f1d9d8d68fbe66c2b74cf"),
];

/// The pre-image the table above hashes: `len` bytes of 0,1,2,…,255,0,1,…
pub fn kat_message(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 256) as u8).collect()
}
