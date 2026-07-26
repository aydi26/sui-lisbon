// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md#9 (L432) <- "The Rust clearing implementation must produce
//             bit-identical output to the Move one. Property-test them against each other;
//             a divergence is a release blocker."
// @spec       move/sources/clearing.move  <- what `engine` reproduces
// @spec       docs/DESIGN-V2.md#5 + #5bis <- what `spec` reproduces
// @spec       sdk/src/clearing.ts         <- the TypeScript twin of `spec`
// @rules      G10
// @depends    nothing outside this crate. ZERO third-party dependencies, deliberately.
// @facts      ── THERE ARE TWO ENGINES IN HERE, AND THAT IS THE POINT ─────────────────────────
// @facts      `engine`  a line-for-line twin of the DEPLOYED `move/sources/clearing.move`:
// @facts                seven budgeted stages, u64 prices at PRICE_SCALE = 1e8, load-time
// @facts                funding truncation, a per-ask fee, `Fill { batch_id, order_index,
// @facts                submitter, is_bid, base_sats, quote_sats, price }`.
// @facts      `spec`    a twin of the SPECIFICATION in docs/DESIGN-V2.md §5 + §5bis, which is
// @facts                what `sdk/src/clearing.ts` implements and what the 46 golden fixtures
// @facts                encode: u128 prices, post-discovery truncation, ONE aggregate fee
// @facts                apportioned by largest remainder, `Fill { index, submitter, side,
// @facts                price, qty_base, quote, fee }`.
// @facts      THESE TWO DO NOT AGREE TODAY. `clearing/tests/divergence.rs` enumerates every
// @facts                difference and is the deliverable of this crate. It is a REPORT, not a
// @facts                failure — nothing here silently picks a winner.
// @facts      A single engine could not have found that. Reproducing only Move would have made
// @facts                the golden fixtures unreadable; reproducing only the SDK would have
// @facts                left the deployed contract unchecked.
// @implements pub mod bcs · engine · hash · json · merkle · rng · spec · types · u256 · vectors
// @forbidden  f32/f64 ANYWHERE in this crate, including intermediately (docs/DESIGN-V2.md §5.2).
//             The `sim` crate is the only place a float may live.
// @forbidden  a third-party dependency — see README § "Why no dependencies"
// @forbidden  reading a wall clock, an env var or a socket from any function here
// @invariant  1. `cargo test -p clearing` needs no network and no fixture copy: the golden
//                test reads `sdk/fixtures/clearing.golden.json` in place.
// @ac         clearing/tests/golden.rs · property.rs · divergence.rs
// @verify     cd clearing-rs; cargo test
// @verify     cd clearing-rs; cargo test --  --nocapture divergence_report
// └── END CONTRACT ───────────────────────────────────────────────────────────

//! Aphotic clearing — the third, independent implementation.
//!
//! `aphotic.md` §9 requires the clearing implementation to be reproducible independently and
//! calls a divergence between implementations a **release blocker**, not a warning. There are
//! already two implementations in this repo (Move and TypeScript). This is the third, in a
//! language whose `u64` arithmetic matches the on-chain semantics natively.
//!
//! Build from **PowerShell**, never from Git Bash — see `README.md`.

pub mod bcs;
pub mod engine;
pub mod hash;
pub mod json;
pub mod merkle;
pub mod rng;
pub mod spec;
pub mod types;
pub mod u256;
pub mod vectors;

pub use engine::{clear as clear_move, BatchInput, Clearing, Outcome, Stage};
pub use spec::{clear as clear_spec, ClearingInput, ClearingResult, RevealedOrder, SpecError};
pub use types::{Address, ClearingError, Escrowed, Fill, Order, OrderSlot};
