// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#5bis(b) <- a limit price is a u128; a quantity is a u64
// @spec       sdk/src/math.ts#mulDivFloor / #mulDivCeil <- bigint there, exact here
// @rules      G10
// @depends    nothing — a LEAF.
// @facts      WHY THIS EXISTS: the golden fixtures carry limit prices up to u128::MAX
// @facts        (`u128-max-price-crossing-overflows-quote`). `qty_base * price` is therefore
// @facts        u64 × u128 = up to 192 bits, which no Rust primitive holds. TypeScript hides
// @facts        this behind bigint; Rust must not hide it behind a wrapping multiply.
// @facts      256 bits is sufficient and provably so: max operand product is
// @facts        (2^64 − 1)(2^128 − 1) < 2^192.
// @facts      Division is shift-and-subtract, 256 iterations, integer only. Slower than Knuth D
// @facts        and immune to the limb-borrow bugs Knuth D is famous for. The clearing engine
// @facts        performs O(n) of these per batch, so the constant is irrelevant.
// @implements pub struct U256 · from_u64 · from_u128 · mul_u128 · checked_to_u64
//             · checked_to_u128 · divmod · is_zero · cmp
//             pub fn mul_div_floor(a: U256-able, b, c) -> U256
//             pub fn mul_div_ceil(a: U256-able, b, c) -> U256
// @forbidden  f32/f64 — this crate is integer-only, including intermediately
// @forbidden  a bigint crate dependency — see README § "Why no dependencies"
// @invariant  1. mul_div_floor(a,b,c) * c + rem == a * b, with 0 <= rem < c.
// @invariant  2. mul_div_ceil(a,b,c) == mul_div_floor(a,b,c) unless c divides a*b, in which
//                case they are equal — i.e. ceil - floor ∈ {0, 1}.
// @invariant  3. For operands that fit u128, the result agrees with native u128 arithmetic.
// @ac         cargo test -p clearing u256
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

use core::cmp::Ordering;
use core::fmt;

/// An unsigned 256-bit integer, stored as four little-endian 64-bit limbs.
#[derive(Copy, Clone, PartialEq, Eq, Default, Hash)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0, 0, 0, 0]);
    pub const ONE: U256 = U256([1, 0, 0, 0]);

    pub const fn from_u64(v: u64) -> Self {
        U256([v, 0, 0, 0])
    }

    pub const fn from_u128(v: u128) -> Self {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0, 0, 0, 0]
    }

    /// `Some(v)` iff the value fits a `u64`. The clearing engine uses this everywhere the TS
    /// twin calls `assertU64`.
    pub fn checked_to_u64(&self) -> Option<u64> {
        if self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0 {
            Some(self.0[0])
        } else {
            None
        }
    }

    /// `Some(v)` iff the value fits a `u128` — the `assertU128` boundary.
    pub fn checked_to_u128(&self) -> Option<u128> {
        if self.0[2] == 0 && self.0[3] == 0 {
            Some((self.0[0] as u128) | ((self.0[1] as u128) << 64))
        } else {
            None
        }
    }

    fn bit(&self, i: usize) -> bool {
        (self.0[i / 64] >> (i % 64)) & 1 == 1
    }

    fn set_bit(&mut self, i: usize) {
        self.0[i / 64] |= 1u64 << (i % 64);
    }

    /// `self << 1`, discarding the carry out of bit 255. Only used inside `divmod`, where the
    /// remainder is provably < divisor <= 2^256 - 1, so nothing is ever discarded.
    fn shl1(&self) -> U256 {
        let mut out = [0u64; 4];
        let mut carry = 0u64;
        for i in 0..4 {
            out[i] = (self.0[i] << 1) | carry;
            carry = self.0[i] >> 63;
        }
        U256(out)
    }

    fn wrapping_sub(&self, other: &U256) -> U256 {
        let mut out = [0u64; 4];
        let mut borrow = 0i128;
        for i in 0..4 {
            let d = self.0[i] as i128 - other.0[i] as i128 - borrow;
            if d < 0 {
                out[i] = (d + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                out[i] = d as u64;
                borrow = 0;
            }
        }
        U256(out)
    }

    /// Widening multiply: `u128 × u128 -> U256`. Panics only if the true product exceeds
    /// 2^256, which is impossible for two u128 operands (max product < 2^256).
    pub fn mul_u128(a: u128, b: u128) -> U256 {
        // Split each operand into two 64-bit halves and accumulate the four partial products.
        let (a0, a1) = (a as u64 as u128, a >> 64);
        let (b0, b1) = (b as u64 as u128, b >> 64);

        let p00 = a0 * b0; // contributes to limbs 0,1
        let p01 = a0 * b1; // limbs 1,2
        let p10 = a1 * b0; // limbs 1,2
        let p11 = a1 * b1; // limbs 2,3

        let mut limbs = [0u64; 4];
        limbs[0] = p00 as u64;

        // limb 1 = high(p00) + low(p01) + low(p10)
        let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
        limbs[1] = mid as u64;

        // limb 2 = carry(mid) + high(p01) + high(p10) + low(p11)
        let hi = (mid >> 64) + (p01 >> 64) + (p10 >> 64) + (p11 as u64 as u128);
        limbs[2] = hi as u64;

        // limb 3 = carry(hi) + high(p11)
        limbs[3] = ((hi >> 64) + (p11 >> 64)) as u64;

        U256(limbs)
    }

    /// `self * other`, checked. `None` on overflow past 256 bits.
    pub fn checked_mul_u64(&self, m: u64) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let p = self.0[i] as u128 * m as u128 + carry;
            out[i] = p as u64;
            carry = p >> 64;
        }
        if carry != 0 {
            return None;
        }
        Some(U256(out))
    }

    pub fn checked_add(&self, other: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let s = self.0[i] as u128 + other.0[i] as u128 + carry;
            out[i] = s as u64;
            carry = s >> 64;
        }
        if carry != 0 {
            return None;
        }
        Some(U256(out))
    }

    pub fn checked_sub(&self, other: &U256) -> Option<U256> {
        if self < other {
            None
        } else {
            Some(self.wrapping_sub(other))
        }
    }

    /// Long division, one bit at a time. Returns `(quotient, remainder)`.
    /// Panics on a zero divisor — the callers all reject `c == 0` first, exactly as
    /// `floor_mul_div` in `clearing.move` asserts `c > 0` (EBadParam).
    pub fn divmod(&self, d: &U256) -> (U256, U256) {
        assert!(!d.is_zero(), "U256::divmod: division by zero");
        if self < d {
            return (U256::ZERO, *self);
        }
        let mut q = U256::ZERO;
        let mut r = U256::ZERO;
        for i in (0..256).rev() {
            r = r.shl1();
            if self.bit(i) {
                r.set_bit(0);
            }
            if r >= *d {
                r = r.wrapping_sub(d);
                q.set_bit(i);
            }
        }
        (q, r)
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                Ordering::Equal => {}
                o => return o,
            }
        }
        Ordering::Equal
    }
}

impl fmt::Debug for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

impl fmt::Display for U256 {
    /// Decimal, so a failing assertion prints something a human can compare with the fixture.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_zero() {
            return write!(f, "0");
        }
        let ten = U256::from_u64(10);
        let mut digits = Vec::new();
        let mut n = *self;
        while !n.is_zero() {
            let (q, r) = n.divmod(&ten);
            digits.push(b'0' + r.0[0] as u8);
            n = q;
        }
        digits.reverse();
        write!(f, "{}", String::from_utf8(digits).expect("ascii digits"))
    }
}

/// Parse an unsigned decimal string. The fixture file carries every scalar as a decimal
/// string precisely because JSON numbers cannot hold a u128.
pub fn parse_u256_dec(s: &str) -> Option<U256> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut acc = U256::ZERO;
    for ch in s.bytes() {
        if !ch.is_ascii_digit() {
            return None;
        }
        acc = acc
            .checked_mul_u64(10)?
            .checked_add(&U256::from_u64((ch - b'0') as u64))?;
    }
    Some(acc)
}

/// `floor(a * b / c)` in 256-bit arithmetic. `None` iff `c == 0`.
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> Option<U256> {
    if c == 0 {
        return None;
    }
    let p = U256::mul_u128(a, b);
    Some(p.divmod(&U256::from_u128(c)).0)
}

/// `ceil(a * b / c)` in 256-bit arithmetic. `None` iff `c == 0`.
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> Option<U256> {
    if c == 0 {
        return None;
    }
    let p = U256::mul_u128(a, b);
    let (q, r) = p.divmod(&U256::from_u128(c));
    if r.is_zero() {
        Some(q)
    } else {
        q.checked_add(&U256::ONE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// @invariant 3 — agreement with native u128 where native u128 is defined.
    #[test]
    fn agrees_with_native_u128_arithmetic() {
        let cases: [(u128, u128, u128); 8] = [
            (0, 0, 1),
            (1, 1, 1),
            (7, 11, 3),
            (1_000_000, 1_000_000_000, 100_000_000),
            (u64::MAX as u128, 1, 1),
            (123_456_789, 987_654_321, 1_000_000_007),
            (u32::MAX as u128, u32::MAX as u128, 7),
            (1, u64::MAX as u128, 100_000_000),
        ];
        for (a, b, c) in cases {
            let want = a * b / c;
            assert_eq!(
                mul_div_floor(a, b, c).unwrap().checked_to_u128().unwrap(),
                want,
                "floor({a}*{b}/{c})"
            );
            let want_ceil = if (a * b) % c == 0 { want } else { want + 1 };
            assert_eq!(
                mul_div_ceil(a, b, c).unwrap().checked_to_u128().unwrap(),
                want_ceil,
                "ceil({a}*{b}/{c})"
            );
        }
    }

    /// @invariant 1 — the division identity, at the widths that actually occur.
    #[test]
    fn division_identity_holds_at_192_bits() {
        // qty = u64::MAX, price = u128::MAX — the `u128-max-price` fixture's shape.
        let a = u64::MAX as u128;
        let b = u128::MAX;
        let c = 1_000_000_000u128;
        let p = U256::mul_u128(a, b);
        let (q, r) = p.divmod(&U256::from_u128(c));
        assert!(r < U256::from_u128(c));
        let back = q.checked_mul_u64(c as u64).unwrap().checked_add(&r).unwrap();
        assert_eq!(back, p);
        // And it genuinely does not fit u128, which is the whole reason this module exists.
        assert!(p.checked_to_u128().is_none());
    }

    /// @invariant 2.
    #[test]
    fn ceil_minus_floor_is_zero_or_one() {
        for a in 0u128..40 {
            for b in 1u128..40 {
                for c in 1u128..17 {
                    let f = mul_div_floor(a, b, c).unwrap();
                    let ce = mul_div_ceil(a, b, c).unwrap();
                    let diff = ce.checked_sub(&f).unwrap().checked_to_u64().unwrap();
                    assert!(diff <= 1, "{a}*{b}/{c}: ceil-floor = {diff}");
                    assert_eq!(diff == 0, (a * b) % c == 0);
                }
            }
        }
    }

    #[test]
    fn mul_u128_is_exact_at_the_top_of_the_range() {
        let p = U256::mul_u128(u128::MAX, u128::MAX);
        // (2^128-1)^2 = 2^256 - 2^129 + 1
        assert_eq!(p.0[0], 1);
        assert_eq!(p.0[1], 0);
        assert_eq!(p.0[2], u64::MAX - 1);
        assert_eq!(p.0[3], u64::MAX);
    }

    #[test]
    fn decimal_roundtrip() {
        for s in [
            "0",
            "1",
            "18446744073709551615",
            "340282366920938463463374607431768211455",
            "1000000000",
        ] {
            assert_eq!(parse_u256_dec(s).unwrap().to_string(), s);
        }
        assert!(parse_u256_dec("").is_none());
        assert!(parse_u256_dec("12a").is_none());
    }

    #[test]
    fn ordering_is_by_magnitude_not_limb_order() {
        assert!(U256::from_u64(1) < U256::from_u128(u128::MAX));
        assert!(U256::from_u128(1u128 << 64) > U256::from_u64(u64::MAX));
        assert_eq!(U256::ZERO.cmp(&U256::ZERO), Ordering::Equal);
    }

    #[test]
    #[should_panic(expected = "division by zero")]
    fn divmod_by_zero_panics() {
        let _ = U256::ONE.divmod(&U256::ZERO);
    }
}
