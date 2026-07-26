// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       aphotic.md#9 <- "Property-test them against each other"
// @spec       sdk/src/rng.ts <- the TS twin uses the same discipline: a SEEDED generator only
// @rules      G10
// @depends    nothing — a LEAF.
// @facts      SplitMix64 (Steele/Lea/Flood, 2014). Chosen because it is 8 lines, has no state
// @facts        beyond one u64, and its constants are published — so a reviewer can confirm the
// @facts        generator without trusting this file.
// @facts      EVERY property test seeds explicitly. A failing case must be reproducible from
// @facts        the seed printed in the failure message, or the property test is theatre.
// @implements pub struct SplitMix64 · new · next_u64 · below · range · bool_with
// @forbidden  `rand::random()`, `SystemTime`, or any unseeded entropy — a property test that
//             cannot be replayed is not evidence
// @forbidden  f32/f64 — `below` uses rejection sampling, not a float multiply
// @invariant  1. The same seed yields the same stream, always.
// @invariant  2. `below(n)` is in [0, n) for every n > 0 and is not biased by a modulo fold.
// @ac         cargo test -p clearing rng
// @verify     cd clearing-rs; cargo test
// └── END CONTRACT ───────────────────────────────────────────────────────────

/// SplitMix64. Deterministic, seeded, no I/O.
#[derive(Copy, Clone, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub const fn new(seed: u64) -> Self {
        SplitMix64 { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, n)`. Rejection-sampled — a plain `% n` would over-represent the low
    /// values, which is exactly the kind of silent skew that makes a property test look
    /// thorough while never reaching the interesting inputs.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0, "SplitMix64::below(0)");
        if n.is_power_of_two() {
            return self.next_u64() & (n - 1);
        }
        let zone = u64::MAX - (u64::MAX % n) - 1;
        loop {
            let v = self.next_u64();
            if v <= zone {
                return v % n;
            }
        }
    }

    /// Uniform in `[lo, hi]`, inclusive.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        assert!(lo <= hi, "SplitMix64::range with lo > hi");
        if lo == 0 && hi == u64::MAX {
            return self.next_u64();
        }
        lo + self.below(hi - lo + 1)
    }

    /// `true` with probability `num / den`.
    pub fn bool_with(&mut self, num: u64, den: u64) -> bool {
        assert!(den > 0 && num <= den);
        self.below(den) < num
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// @invariant 1.
    #[test]
    fn the_same_seed_replays_exactly() {
        let a: Vec<u64> = {
            let mut r = SplitMix64::new(0xA11CE);
            (0..64).map(|_| r.next_u64()).collect()
        };
        let b: Vec<u64> = {
            let mut r = SplitMix64::new(0xA11CE);
            (0..64).map(|_| r.next_u64()).collect()
        };
        assert_eq!(a, b);
        let c: Vec<u64> = {
            let mut r = SplitMix64::new(0xA11CF);
            (0..64).map(|_| r.next_u64()).collect()
        };
        assert_ne!(a, c);
    }

    /// The published first outputs for seed 0 — pinned so a "harmless" constant edit is caught.
    #[test]
    fn matches_the_published_splitmix64_stream_for_seed_0() {
        let mut r = SplitMix64::new(0);
        assert_eq!(r.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(r.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        assert_eq!(r.next_u64(), 0x06C4_5D18_8009_454F);
    }

    /// @invariant 2.
    #[test]
    fn below_is_in_range_and_reaches_every_value() {
        let mut r = SplitMix64::new(7);
        let mut seen = [false; 7];
        for _ in 0..2_000 {
            let v = r.below(7);
            assert!(v < 7);
            seen[v as usize] = true;
        }
        assert!(seen.iter().all(|s| *s), "below(7) never produced some value");
    }

    #[test]
    fn range_is_inclusive_on_both_ends() {
        let mut r = SplitMix64::new(11);
        let mut lo_seen = false;
        let mut hi_seen = false;
        for _ in 0..2_000 {
            let v = r.range(5, 9);
            assert!((5..=9).contains(&v));
            lo_seen |= v == 5;
            hi_seen |= v == 9;
        }
        assert!(lo_seen && hi_seen);
        assert_eq!(r.range(3, 3), 3);
    }
}
