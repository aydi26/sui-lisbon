// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       move/sources/clearing.move (struct Entry / Funding / Fill, L180-L257)
// @spec       move/sources/batch.move (struct Order — submitter, is_bid, limit_price, qty_sats)
// @spec       aphotic.md#2-hard-constraints <- money is u64 SATOSHIS, never a float
// @rules      G10
// @depends    nothing — a LEAF.
// @facts      A Sui `address` is 32 bytes, BIG-ENDIAN, and an address literal is RIGHT-ALIGNED
// @facts        into those 32 bytes: `@0xB0B` is 0x00..000b0b.
// @facts      `Entry.key` in Move is `sui::address::to_u256(who)` — the 32 bytes read as a
// @facts        big-endian u256. Comparing the RAW BYTE ARRAY lexicographically is EXACTLY the
// @facts        same total order, so `[u8; 32]` with derived `Ord` reproduces the tie-break
// @facts        without a u256 type. This is why `Address` derives Ord and must never be
// @facts        reordered or given a custom Ord.
// @facts      Canonical order (clearing.move L56-L60), ties FULLY broken:
// @facts        bids  (limit_price DESC, key ASC, order_index ASC)
// @facts        asks  (limit_price ASC,  key ASC, order_index ASC)
// @facts      batch.move L437-L438 asserts qty_sats > 0 and limit_price > 0 at reveal, so the
// @facts        engine never sees a zero price (which would divide by zero in the bid-funding
// @facts        truncation). `Order::new` asserts the same, on this side.
// @facts      PRICE_SCALE = 100_000_000: a limit price is quote-sats per 1e8 base-sats.
// @implements pub struct Address([u8; 32]) · pub struct Order · pub enum OrderSlot
//             pub struct Escrowed · pub struct Fill · pub struct EntryView
// @forbidden  f32/f64 anywhere in this crate — clearing.move has no float and neither may the
//             twin. The `sim` crate may use floats; `clearing` may not.
// @invariant  1. Address ordering equals Move's `to_u256` ordering for every pair.
// @invariant  2. Order construction rejects price 0 and qty 0, exactly as batch.move does.
// @ac         cargo test -p clearing address
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use core::fmt;

/// A Sui address: 32 big-endian bytes.
///
/// `Ord` is DERIVED on the raw bytes, which is bit-for-bit the same total order as Move's
/// `sui::address::to_u256(a) < sui::address::to_u256(b)`. Do not hand-write an `Ord`.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Address(pub [u8; 32]);

impl Address {
    /// The Move literal form: `@0xA11CE` is the value 0xA11CE right-aligned into 32 bytes.
    pub const fn from_u128(v: u128) -> Self {
        let mut out = [0u8; 32];
        let be = v.to_be_bytes();
        let mut i = 0;
        while i < 16 {
            out[16 + i] = be[i];
            i += 1;
        }
        Address(out)
    }

    pub const fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The low 128 bits, for readable test output. Lossy by construction; display only.
    pub fn low_u128(&self) -> u128 {
        let mut be = [0u8; 16];
        be.copy_from_slice(&self.0[16..]);
        u128::from_be_bytes(be)
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "@0x{:X}", self.low_u128())
    }
}

/// A revealed order, exactly the four fields `clearing.move` reads out of `batch::Order`.
/// The salt and the commitment never reach clearing, so they are absent here on purpose.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub submitter: Address,
    pub is_bid: bool,
    pub limit_price: u64,
    pub qty_sats: u64,
}

impl Order {
    /// Mirrors `batch.move` L437-L438: qty and price must both be strictly positive.
    pub fn new(submitter: Address, is_bid: bool, limit_price: u64, qty_sats: u64) -> Self {
        assert!(qty_sats > 0, "EBadOrder: qty_sats must be > 0");
        assert!(limit_price > 0, "EBadOrder: limit_price must be > 0");
        Order {
            submitter,
            is_bid,
            limit_price,
            qty_sats,
        }
    }
}

/// A slot in the batch. `order_index` is the position in this vector, so an unrevealed order
/// still occupies its index — that is what makes fill→order mapping provable (@invariant 3).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum OrderSlot {
    Unrevealed,
    Revealed(Order),
}

/// One participant's persistent internal balance, in sats. There is deliberately no "reserved"
/// or "locked" field: a reservation at order time would publish order size (clearing.move
/// @forbidden, spec §7.2).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Escrowed {
    pub base_sats: u64,
    pub quote_sats: u64,
}

/// The published fill. This is the Merkle leaf, byte for byte — field order here IS the BCS
/// field order and must match `clearing.move`'s `struct Fill` declaration exactly.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub batch_id: u64,
    pub order_index: u64,
    pub submitter: Address,
    pub is_bid: bool,
    pub base_sats: u64,
    pub quote_sats: u64,
    pub price: u64,
}

/// The read-only projection of an `Entry` that `clearing::bid_entry_at` / `ask_entry_at` return.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct EntryView {
    pub order_index: u64,
    pub submitter: Address,
    pub limit_price: u64,
    pub qty_sats: u64,
    pub fill_base: u64,
}

/// The abort codes of `aphotic::clearing`, with their Move numbers.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ClearingError {
    BadParam = 2,
    WrongBatch = 3,
    WrongVault = 4,
    FillOutsideLimit = 5,
    ValueNotPreserved = 6,
    Overflow = 7,
    IndexOutOfRange = 8,
    NotFinal = 9,
    /// NOT a `clearing.move` code. `vault::settle_debit_*` delegates to `aphotic::ledger`,
    /// which aborts on its own with an insufficient-balance error. Given the load-time funding
    /// truncation this is unreachable on the honest path, so it is kept distinct rather than
    /// folded into `ValueNotPreserved` — reaching it means the truncation is wrong.
    LedgerUnderflow = 100,
}

impl ClearingError {
    /// The `abort_code` a Move test would name.
    pub fn code(self) -> u64 {
        self as u64
    }
}

impl fmt::Display for ClearingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "E{self:?} (abort code {})", self.code())
    }
}

impl std::error::Error for ClearingError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// @invariant 1 — the byte order IS the numeric order. The `pro_rata` Move vector depends
    /// on 0xB0B (2 827) preceding 0xA11CE (659 918); if this flipped, that vector would still
    /// "pass" with the sat awarded to the wrong account.
    ///
    /// ⚠ This test shipped asserting 659 406 for 0xA11CE, which is simply wrong arithmetic —
    /// 0xA11CE is 659 918. It never ran, because the crate had no `lib.rs` and so could not
    /// compile. Corrected rather than deleted: the ORDERING claim it makes is real and the
    /// exhaustive loop below is what actually proves it.
    #[test]
    fn address_byte_order_equals_u256_order() {
        let bob = Address::from_u128(0xB0B);
        let alice = Address::from_u128(0xA11CE);
        assert!(bob < alice);
        assert_eq!(bob.low_u128(), 2_827);
        assert_eq!(alice.low_u128(), 659_918);
        assert_eq!(alice.low_u128(), 0xA11CE);

        // Exhaustive over a range where the byte layout crosses several byte boundaries.
        for a in 0u128..512 {
            for b in 0u128..512 {
                assert_eq!(
                    Address::from_u128(a) < Address::from_u128(b),
                    a < b,
                    "order diverged at {a} vs {b}"
                );
            }
        }
    }

    #[test]
    fn address_is_right_aligned_big_endian() {
        let a = Address::from_u128(0xB0B);
        assert_eq!(a.bytes()[..30], [0u8; 30]);
        assert_eq!(a.bytes()[30], 0x0B);
        assert_eq!(a.bytes()[31], 0x0B);
    }

    #[test]
    #[should_panic(expected = "limit_price must be > 0")]
    fn order_rejects_zero_price() {
        Order::new(Address::from_u128(1), true, 0, 10);
    }

    #[test]
    #[should_panic(expected = "qty_sats must be > 0")]
    fn order_rejects_zero_qty() {
        Order::new(Address::from_u128(1), true, 100, 0);
    }

    #[test]
    fn error_codes_match_move() {
        assert_eq!(ClearingError::BadParam.code(), 2);
        assert_eq!(ClearingError::FillOutsideLimit.code(), 5);
        assert_eq!(ClearingError::ValueNotPreserved.code(), 6);
        assert_eq!(ClearingError::NotFinal.code(), 9);
    }
}
