# `clearing-rs` — the third clearing implementation

`aphotic.md` §9 requires the clearing implementation to be reproducible independently, and states
that **a divergence between implementations is a release blocker, not a warning.**

There were already two implementations in this repo — `move/sources/clearing.move` and
`sdk/src/clearing.ts` — and they diverged once this week on the price scale (1e8 in Move, 1e9 in
the SDK) **while all 46 hand-derived golden fixtures stayed green**, because the fixtures never
passed a scale and silently adopted whatever the default happened to be. This crate is the third
implementation, in a language whose `u64` `saturating_*` arithmetic matches the on-chain
semantics natively, so no bigint gymnastics stand between the code and the thing it is checking.

---

## Build and test

```powershell
cd C:\Users\adria\sui-lisbon\clearing-rs
cargo test
```

### ⚠ Build from PowerShell, never from Git Bash

In Git Bash, `link` resolves to MSYS's `/usr/bin/link` instead of MSVC's `link.exe`, and
`cargo build` fails confusingly — it looks like a Rust problem and is not. Use PowerShell.

### ⚠ This workspace pins the `x86_64-pc-windows-gnu` toolchain

See the comment at the top of `rust-toolchain.toml`. Short version: MSVC 14.41 is installed on
this machine but **the Windows SDK is not** — there is no `kernel32.lib` anywhere,
`Windows Kits\10\Lib` is empty, and `vcvarsall.bat` is missing — so the MSVC linker cannot link
anything. The GNU toolchain that rustup ships is self-contained and works with no further
installation. Nothing here is target-specific. Delete the pin once the Windows SDK is installed.

### Running the simulator

```powershell
cargo run -p sim -- --help
cargo run -p sim -- --out latency.json --flow-out flow.json
cargo run -p sim -- --out slow.json --queue-depth-sats 40000000000 --amount-sats 500000000
```

---

## What is in here

| Path | What it is |
|---|---|
| `clearing/src/engine.rs` | **The Move twin.** A line-for-line reproduction of the deployed `move/sources/clearing.move`: seven budgeted stages each with its own cursor, `PRICE_SCALE = 1e8`, load-time funding truncation, a per-ask fee. |
| `clearing/src/spec.rs` | **The specification twin.** `docs/DESIGN-V2.md` §5 + §5bis, which is what `sdk/src/clearing.ts` implements and what the 46 golden fixtures encode: u128 prices, post-discovery truncation, one aggregate fee apportioned by largest remainder. |
| `clearing/src/u256.rs` | 256-bit integer arithmetic. The fixtures carry limit prices up to `u128::MAX`, so `qty × price` reaches 192 bits — wider than any Rust primitive. Integer only; the division is shift-and-subtract. |
| `clearing/src/hash.rs` | BLAKE2b-256, hand-written, matching `sui::hash::blake2b256`. |
| `clearing/src/bcs.rs` · `merkle.rs` | The Move `Fill` BCS encoding and the fill Merkle tree (odd node duplicated, empty root = 32 zero bytes). |
| `clearing/src/json.rs` | A minimal JSON reader/writer whose number path never touches a float. |
| `clearing/src/rng.rs` | SplitMix64. Every property test seeds explicitly. |
| `clearing/tests/golden.rs` | Reads `sdk/fixtures/clearing.golden.json` **in place** and asserts all 46 cases. |
| `clearing/tests/property.rs` | Seeded property sweeps over both engines. |
| `clearing/tests/divergence.rs` | **The report.** Five pinned divergences between the two engines. |
| `sim/src/latency.rs` | Hashi exit-latency Monte Carlo → a JSON *distribution*. |
| `sim/src/flow.rs` | Synthetic order flow driven through the real clearing engine. |

### There are two engines in here, and that is the point

Reproducing only Move would have made the golden fixtures unreadable. Reproducing only the SDK
would have left the deployed contract unchecked. Building both is what surfaced the findings
below — a single engine could not have.

---

## Findings

### F1 — all 46 golden fixtures pass against an independently written implementation

`cargo test --test golden` reads `sdk/fixtures/clearing.golden.json` from its real path (never a
copy — a copied fixture drifts, which is the whole failure this crate exists to catch) and
matches every case's `price`, `matchedBase`, `matchedQuote`, `feeQuote`, `dustQuote`,
`matchedBaseBeforeTruncation`, every `fills` row in order, and every `fillsRoot`. Including the
seven `expectThrow` cases and the three pinned 256/512-order batches.

The fixtures declare `priceScale = 1e9` and the test honours **that**, not `spec::PRICE_SCALE`
(1e8). A separate test asserts the production constant is 1e8 and that the fixture scale differs
from it — which is what makes the fixtures pin scale-*independence* instead of re-pinning a
default.

### F2 — `clearing.move` and `docs/DESIGN-V2.md` §5bis are not the same algorithm

`clearing/tests/divergence.rs` pins five differences, each with a minimal hand-derived
counterexample. These are **recorded, not resolved** — deciding which side is right is a spec
decision for a human, and silently picking a winner is exactly how the 1e9/1e8 split survived.

| | Divergence |
|---|---|
| **D1** | **Fill leaf, and therefore the root.** Move: `bcs(Fill)` = `u64 batch_id ‖ u64 order_index ‖ address ‖ bool is_bid ‖ u64 base ‖ u64 quote ‖ u64 price` = **73 bytes**. §5bis(d): `u64 index ‖ address ‖ u8 side ‖ u128 price ‖ u64 qty ‖ u64 quote ‖ u64 fee` = **81 bytes**. Different fields, different widths. The two `fills_root` values can **never** match for a non-empty fill set; only the empty root (32 zero bytes) coincides. |
| **D2** | **Allocation at an overfull strictly-inside level.** Move fills strictly-inside orders **greedily** in canonical order (`min(qty, remaining)`), so the first order at a level can take everything. §5bis(a) **pro-rates** the first level that does not fit, by largest remainder. Counterexample: bids 60@10 and 60@10, ask 50@5, p\*=5, matched 50 → Move gives 50/0, §5bis gives 25/25. They coincide whenever every strictly-inside level fits, which is the common case and why this survived. |
| **D3** | **The fee.** Move charges each ask `floor(gross × bps / 10 000)` and reports `fee_quote = Σ bid_ceil − Σ ask_net`, which **folds the rounding dust into the fee**. §5bis(c) computes one aggregate `floor(matched_quote × bps / 10 000)`, apportions it by largest remainder, and keeps `dust_quote` as a separate fourth term. The exact relationship, asserted in `d3_…`: `move.fee_quote == spec.fee_quote + spec.dust_quote`. |
| **D4** | **When truncation happens.** Move truncates at **load**, before price discovery, so one under-funded account can move the **uniform clearing price everybody trades at**. §5bis truncates **after** discovery, so `p*` is a function of the submitted book alone. Counterexample in `d4_…`: the same book clears at 10 on the Move side and 12 on the §5bis side. |
| **D5** | **Price width.** Move's `limit_price` is a `u64`; §5bis and the fixtures use `u128`, and fixture `u128-max-price-crossing-overflows-quote` carries `u128::MAX`. That case cannot be expressed against the Move engine at all — the divergence is in the type, before any arithmetic. |

A seeded census over 4 000 random books (`cargo test --test divergence -- --nocapture
divergence_report`) puts the practical exposure at roughly 2 % of books for D2 and 13 % for D3,
with agreement on price, matched volume, allocation and fee in about 85 %. That is the shape of a
narrow, specific divergence rather than two unrelated algorithms — which is also why it went
unnoticed.

### F3 — §5bis(d) miscounts its own byte layout

The prose says the `FillLeaf` layout `u64 ‖ address ‖ u8 ‖ u128 ‖ u64 ‖ u64 ‖ u64` is
"**= 73 bytes**". It is 8+32+1+16+8+8+8 = **81**. The SDK's own test asserts 81, so the code is
right and the sentence is wrong. Pinned in `spec.rs` @invariant 8 and `d1_…`.

### F4 — two dead test constants in the pre-existing partial crate

A `clearing-rs/` skeleton from an earlier run was finished rather than replaced (see below). It
had never compiled — there was no `lib.rs` — so its tests had never run, and two of them were
wrong:

- `types.rs` asserted `Address::from_u128(0xA11CE).low_u128() == 659_406`. `0xA11CE` is **659 918**.
- `hash.rs` referenced `crate::vectors::MOVE_BLAKE2B_KAT` and a `clearing-rs/move-vectors/`
  directory, neither of which exists.

Both corrected rather than deleted: the claims they made were real, only the numbers were not.

---

## What was finished vs replaced

The partial crate from the earlier killed run — `types.rs`, `bcs.rs`, `hash.rs`, `merkle.rs` and
the 1 072-line `engine.rs` Move twin — was **kept and finished**. It is careful, faithful work
and rewriting it would have thrown away a real asset. What was missing and has been added:
`lib.rs` (without which nothing compiled), `spec.rs`, `u256.rs`, `json.rs`, `rng.rs`,
`vectors.rs`, all three integration test files, the whole `sim/` crate, this README and the
toolchain pin.

---

## `sim/` is standalone — it does **not** link Hashi's simulator

`aphotic.md` §4.6 points at `crates/hashi/src/utxo_pool/sim.rs`, a 1 442-line UTXO pool simulator
in the Hashi repo, as the way to calibrate the latency model without waiting for mainnet data.
**That file is not in this repository.** `.hashi_src/` vendors only `guardian/limiter.rs`,
`bitcoin/taproot.rs`, `constants.rs` and `guardian_limiter.rs` — there is no `utxo_pool/` at all.
Linking it would mean vendoring the Hashi crate and its dependency tree from a source this repo
does not have.

So the model is standalone, and it says so in its own output:

- The **limiter leg is faithful** — `project_capacity(cfg, tokens, elapsed) = min(cap, tokens +
  elapsed × refill_rate)`, saturating, exactly as `.hashi_src/…guardian__limiter.rs` L94-L99 does
  it, with the live scalars from `docs/FACTS.md` (`refill_rate = 115 740` sats/s,
  `max_bucket_capacity = 10 000 000 000` sats). An over-capacity request is **rejected**, never
  queued ahead of anyone (G3).
- The **UTXO-fragmentation leg is parameterised, not calibrated.** Every emitted file carries
  `"calibrated_against_hashi_sim": false`. Calibrating it is a real, still-open task.

Output is a **distribution, never a point estimate** — `aphotic.md` §7.6: *"Do not size the carry
off a point estimate. The tail is the risk."* `latency.json` carries min/p50/p75/p90/p95/p99/p999/
max/mean, a 30-minute-bin histogram, and a per-leg mean breakdown so a reader can see where the
time goes rather than only how much of it there is. Bitcoin confirmations are drawn from a Poisson
process (exponential gaps, mean 600 s), not a flat ten minutes — a point estimate of 6 × 10 min
understates p99 by roughly a factor of two, and that understatement *is* the risk §7.6 warns about.

---

## Why no dependencies

`clearing` has **zero** third-party dependencies and `sim` depends only on `clearing`. BLAKE2b,
BCS, the 256-bit arithmetic, the JSON reader and the RNG are all written here. Three reasons:

1. A parity twin must not be able to drift because an upstream crate changed a default.
2. `cargo test` needs no network, which matters when the whole point is reproducibility.
3. The dependency tree behind a release-blocking check should be trivially auditable.

BLAKE2b is pinned against the published BLAKE2b-256 known-answer vectors for the short cases and
against **OpenSSL** (via `node:crypto`'s `blake2b512`) for messages that cross block boundaries —
the three published 256-bit vectors are all under 44 bytes and so exercise none of the multi-block
path, and every fill leaf and Merkle node is under 128 bytes, so the golden fixtures could not
catch a multi-block bug either.

## Floats

`clearing` contains **no float, anywhere, not even intermediately** — `docs/DESIGN-V2.md` §5.2.
`sim` is the one place a float is allowed, and it is used in exactly one function
(`latency::exponential_s`), for sampling.
