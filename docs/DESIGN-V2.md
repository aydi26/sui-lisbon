# DESIGN-V2 — the reconciliation reference for the Aphotic v2 backend

> Produced by the design pass of 2026-07-26, **after** the v2 backend build was already in
> flight. This is not the build order — `aphotic.md` and `aphotic-governance.md` are the spec
> of record. This is the list of **deltas, decisions and traps** the build must be reconciled
> against once the modules land.
>
> Where this contradicts a module that was already written, this document is the thing to
> *check*, not automatically the thing to follow — but the contradiction must be resolved
> explicitly and recorded here, never silently.

---

## 1. Three findings that change the design

### F1 — The Seal identity endianness trap is ALREADY IN THIS REPO

The deleted `move/sources/vault.move:698-703` decoded the Seal identity epoch as

```move
epoch = (epoch << 8) + (byte as u64)     // BIG-ENDIAN
```

and `keeper/src/privacy/seal.ts` documents `SEAL_ID_EPOCH_LEN` as *"u64 version_epoch
BIG-ENDIAN"*. **`bcs::peel_u64` reads LITTLE-ENDIAN.** Copying the old `seal_approve` into
`batch.move` produces a policy that never opens — and it fails *silently*, because the key
server simply declines and the batch never reveals.

Structural twin of RECON R14's Bitcoin txid trap: a byte order wrong in one direction only,
with no error message on the wrong path.

**Resolution.** One file owns the encoding (`sdk/src/seal/identity.ts`), both sides import
it, and a golden byte-vector test pins it in BOTH languages: the LE encoding of a given
`T_ms` must open, and the BE encoding of the *same* `T_ms` must abort.

### F2 — A time-lock `seal_approve` must NOT check the sender

The old `vault.move:706` asserted `sender == owner || sender == keeper`. A batch time-lock
must be satisfiable by **anyone** after `T`. That is exactly what makes reveal permissionless
and kills grief-by-non-revelation — the failure mode that sank commit–reveal (`aphotic.md`
§3, rejected designs).

### F3 — Note escrow must NOT sit inside vault NAV  ⚠ architectural

`aphotic-governance.md` Figure 1 has the vault holding notes directly. If it does, a batch
settlement moves vault assets **between** the keeper's `propose_nav` and the admin's
`approve_nav` — so the admin approves a number that is already stale, and the two-party NAV
split is defeated by the auction itself.

**Resolution (deviation from the governance note, stated).** A separate `BalanceLedger`
custodies escrow. The two legs share a *product* balance sheet, not a *Move* balance. This
restates the spec §10 Notes invariant in a form that is actually checkable:

```move
assert!(l.total_base + l.note_backed_base == l.base.value(),  EBaseDrift);
assert!(l.total_quote                     == l.quote.value(), EQuoteDrift);
```

A `Table` cannot be iterated, so incremental totals plus this identity is the only sound form
of "note value in the tree equals custodied minus deployed".

---

## 2. The measured ceilings — and what each one actually costs

None can be raised by paying more gas. The gas *budget* is not the binding limit.

| Limit | Value | What consumes it | n=256 | n=512 |
|---|---|---|---|---|
| `object_runtime_max_num_store_entries` | **1 000** / tx | one `Table<address,Account>` entry per distinct participant in `settle_step` | ≤256 | ≤512 |
| `max_num_event_emit` | **1 024** | 1 `BatchSettled` + 1 `Filled` per fill | ≤257 | ≤513 |
| `max_gas_computation_bucket` | **5 000 000** | `sort_step` + `price_step` | must MEASURE | must MEASURE |
| object size | 250 KB | ~226 B/order across `orders` + `revealed` + `perm` | ~58 KB | ~116 KB |
| `max_pure_argument_size` | 16 384 | `reveal_many` at ~72 B/Order | ~220/call | ~220/call |

**Decision.** `MAX_BATCH_SIZE` is a **governed parameter, default 256**, with
`HARD_MAX_BATCH_SIZE = 512` asserted in the setter. 256 leaves ~4× headroom on the
1 000-entry and 1 024-event walls simultaneously, and the object-size wall independently
agrees 512 is the ceiling.

**Build the resumable path from day one.** `sort_step` and `settle_step` take a `budget` and
advance an on-chain cursor. Not insurance — retrofitting resumption changes the state
machine, the events and the tests. With `budget = 128` a 512-order batch settles in 4
transactions and n could grow into the thousands with no contract change.

**`emit_per_fill: bool`** in the registry is the event escape hatch: with it false only
`BatchSettled` + `ClearingComputed` are emitted and every fill stays provable from
`fills_root`, so the 1 024-event wall can never brick a batch.

**Measure, do not assume, the 5 M computation cap.** `scripts/measure-clearing.mjs`
devInspects `sort_step`/`price_step` for n ∈ {16,32,64,128,256,384,512}, writes
`docs/LIMITS.md`, and **fails the build if any single step exceeds 3 500 000** (70 % of the
cap). If `price_step` at 256 exceeds it, drop the default to 128 and split into
`price_scan_step` + `alloc_step`, both cursor-driven — the API must already anticipate that.

---

## 3. The `seal_approve` entry, exactly

Inner id layout, 48 bytes. Full IBE identity is `bytes(packageId) ‖ inner`; `seal_approve`
receives **only** `inner`.

```
[ 0..8 )  bcs u64      close_ms         LITTLE-ENDIAN   <- F1
[ 8..16)  bcs u64      policy_version   LITTLE-ENDIAN
[16..48)  bcs address  batch object id  (32 raw bytes)
leftovers MUST be empty
```

```move
fun check_policy(id: vector<u8>, r: &BatchRegistry, c: &clock::Clock): bool {
    let mut prepared: BCS = bcs::new(id);
    let t   = prepared.peel_u64();          // LITTLE-ENDIAN
    let ver = prepared.peel_u64();          // LITTLE-ENDIAN
    let _b  = prepared.peel_address();
    let leftovers = prepared.into_remainder_bytes();
    (leftovers.length() == 0)               // MANDATORY - not optional
        && (ver == r.policy_version)        // the versioning tle.move omits
        && (c.timestamp_ms() >= t)
}

/// Non-`public` `entry`. Deny by ABORT, never by return value. No mutation, no event,
/// NO SENDER CHECK (F2).
entry fun seal_approve(id: vector<u8>, r: &BatchRegistry, c: &clock::Clock) {
    assert!(check_policy(id, r, c), ENoAccess);
}
```

Satisfies every key-server constraint: 1 command (≤100), a `MoveCall` to our own package,
name prefixed `seal_approve`, first argument a non-empty `Pure`, side-effect free, denial by
abort. `&BatchRegistry` and `&Clock` are shared reads, legal in the dry-run.

**Skew tolerance — nothing depends on an exact instant.**
- `close_batch` checks the **on-chain** `Clock`, not any key server, so the transition is
  exact regardless of skew.
- `SUBMIT_CUTOFF_MS = 60_000` — no submit lands within a minute of close, so a submit cannot
  race an early key release.
- `REVEAL_GRACE_MS = 600_000` — 10 minutes of reveal window, two orders of magnitude more
  than the observed skew.
- An early leak of ≤2 min reveals orders that can no longer be joined or withdrawn against:
  the ledger froze at `close_batch` and submits stopped a minute earlier.

**The commitment binds the PLAINTEXT, not the ciphertext.** `commitment =
blake2b256(bcs(Order))`. If only `ct_hash` were binding, a submitter could publish one
ciphertext and later claim a different plaintext decrypted from it. Binding to the plaintext
closes that and does **not** reintroduce commit–reveal's grief problem, because after
`close_ms` anyone can fetch the Seal shares and produce the reveal. `ct_hash` and `blob_id`
exist only so a third party can *find* the ciphertext.

---

## 4. Timing is mechanical, not operator-chosen

```move
public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64 {
    let since = oracle::saturating_sub(now_ms, offset_ms);
    let periods = since / cadence_ms;
    offset_ms + oracle::saturating_mul(periods + 1, cadence_ms)
}
```

`cadence_ms = 43_200_000` (12 h), `offset_ms = 21_600_000` → 06:00 and 18:00 UTC daily (unix
epoch day 0 begins 00:00 UTC). `open_batch` takes **no timestamp parameter**; `close_ms` is
derived. The same function lives in `sdk/src/cadence.ts` with shared golden vectors.

**A full batch does not close early.** Closing on fullness would hand a spammer exactly the
timing lever uniform-price clearing exists to remove. A full batch rejects further submits
and still closes on the boundary.

---

## 5. Clearing — determinism is the product

1. **Canonical order.** Bids by `(limit_price DESC, submitter bytes ASC, index ASC)`; asks by
   `(limit_price ASC, submitter bytes ASC, index ASC)`. Ties fully broken → zero
   implementation freedom.
2. **Price discovery.** Candidates = the distinct limit prices present.
   `vol(p) = min(demand(p), supply(p))`. Choose max `vol`; tie-break min `|demand − supply|`;
   tie-break lowest `p`. Integer only, no floats anywhere.
3. **Allocation.** Orders strictly inside the cross fill fully. Orders at exactly `p*` on the
   long side are pro-rated `floor(residual × qty_i / Σqty)`, remainder distributed one sat at
   a time by **largest fractional remainder, tie-broken by canonical position**.
4. **Limit safety.** Asserted per fill, not merely by construction: `bid ⇒ p* ≤ limit`,
   `ask ⇒ p* ≥ limit`.
5. **Quote conversion** rounds **toward the vault** (bids up, asks down) so the dust residual
   can never be negative.
6. **Root.** blake2b256 Merkle over `blake2b256(0x00 ‖ bcs(FillLeaf))` in canonical order,
   odd nodes duplicated.

**The fee is an explicit third term, never a silent shortfall:** `Σdebits == Σcredits + fee`,
with `fee = mul_div(matched_quote, fee_matched_bps, 10_000)` credited to
`vault.fees_accrued`.

**Solvency at settlement without leaking size.** No margin field exists on `SealedOrder` — a
margin would leak order size at submit time, defeating the whole point. Instead `close_batch`
freezes the ledger, and `settle_step` **deterministically truncates** any fill the account
cannot cover to `min(fill, balance)`, recomputing the counterparty symmetrically from the
same rule. Because the rule is a pure function of the frozen snapshot, Move and the TS twin
agree — and the parity test must cover under-funded accounts explicitly.

**Push, not claim (deviation, stated).** Spec §7.2 step 5 has participants *claim* fills. We
**push** in `settle_step` and expose `verify_fill` as the transparency surface. A pull model
leaves an unbounded unclaimed-liability state that must be excluded from NAV and reconciled
forever; push makes settlement terminal. `verify_fill` still gives the app the "prove my fill
against the published root" button, which is what the claim story was actually for.

---

### 5bis. Four things §5 left underspecified — RESOLVED BY THE SDK, and Move MUST match

Found while implementing `sdk/src/clearing.ts`. Each is a place where §5 above was not
executable as written, so the implementation had to decide. **Bit-identical parity is a
release blocker**, so `clearing.move` must implement these exact rules, not its own reading
of §5.

**(a) "Orders strictly inside the cross fill fully" is NOT always satisfiable.**
Counterexample: one bid 100 @ 10, one ask 50 @ 5. The tie-breaks select `p* = 5`, so the
*entire* bid is strictly inside the cross while matched volume is only 50. A rule that
cannot be honoured is worse than no rule — each implementation works around it differently
and parity breaks silently.
**Resolved:** walk price levels in price priority; the first level that does not fit is
pro-rated by largest remainder; every later level gets zero. This reduces to §5.3 exactly
whenever §5.3 *is* satisfiable. Pinned as `degenerate-strictly-inside-exceeds-matched`.

**(b) §5 never defines the price denomination.** The SDK uses DeepBook's `FLOAT_SCALING`
convention, `PRICE_SCALE = 1_000_000_000`, and pins it in the fixture header. If
`clearing.move` picks a different scale, **every golden fixture must be regenerated** — this
is not a cosmetic difference.

**(c) Fee apportionment.** §5 gives `fee = mul_div(matched_quote, bps, 10_000)` as a single
aggregate while also demanding `Σdebits == Σcredits + fee` exactly. Those are only
simultaneously true if the aggregate is distributed without loss.
**Resolved:** distribute the aggregate across ask fills with the *same* largest-remainder
rule, so `Σ fill.fee == feeQuote` exactly. The asserted identity is per-asset — base debits
== base credits; quote debits == quote credits + fee + **dust**, where dust is the
non-negative residual of rounding toward the vault.

**(d) `FillLeaf` byte layout**, proposed by the SDK and to be mirrored verbatim:
`u64 index ‖ address submitter ‖ u8 side ‖ u128 price ‖ u64 qty ‖ u64 quote ‖ u64 fee`
= 73 bytes, hashed `blake2b256(0x00 ‖ bcs)`, rooted with odd-node duplication, bids then
asks in canonical order. **An empty fill set roots to 32 zero bytes**, not to a hash of
nothing.

**One deliberate quirk, replicated on purpose.** For `now_ms < offset_ms` — the first six
hours of the unix epoch — `since` saturates to 0 and `next_boundary` returns
`offset + cadence` = 18:00, skipping the 06:00 boundary. Unreachable in production, but
pinned on both sides as `epoch-zero-skips-the-first-boundary` so nobody "fixes" one side
alone and breaks parity.

---

### 5ter. ⚠ THE PARITY CLAIM DOES NOT CURRENTLY HOLD — measured 2026-07-26

`aphotic.md` §9 says a divergence between clearing implementations is a **release
blocker**. A third implementation was written in Rust specifically to check that, reading
`sdk/fixtures/clearing.golden.json` in place, and it found that **`clearing.move` and §5bis
above are not the same algorithm.**

Do not claim bit-identical parity anywhere until these are resolved. The SDK and the Rust
`spec` engine agree with each other and with all 46 fixtures; it is **Move** that differs,
and Move is what settles.

Seeded census over 4 000 random books: full agreement on **3 407 (85 %)**. Divergence is
narrow and specific, which is exactly why it survived unnoticed:

| # | Divergence | Consequence |
|---|---|---|
| **D1** | **Fill leaf layout.** Move `bcs(Fill)` is 73 bytes (`batch_id`, no `fee`); §5bis is 81 (`fee`, no `batch_id`, u128 price). | The two roots can **never** match for a non-empty fill set. This alone makes byte-comparison meaningless today. |
| **D2** | **Allocation.** Move fills an overfull strictly-inside level **greedily**; §5bis **pro-rates** it. Bids 60@10 + 60@10 against ask 50@5 → Move 50/0, §5bis 25/25. | Two participants at the same price get different fills. 97 of 4 000 books (2.4 %). |
| **D3** | **Fee.** Move folds rounding dust into the fee; §5bis keeps them separate. Asserted exactly: `move.fee_quote == spec.fee_quote + spec.dust_quote`. | 516 of 4 000 books (12.9 %) — the most frequent, and the least visible. |
| **D4** | **Truncation timing.** Move truncates at **load**, before price discovery, so one under-funded account **moves the uniform clearing price**. Counterexample clears at 10 on Move and 12 on §5bis. | A funding shortfall changing the price for everyone is a design question, not a rounding one. |
| **D5** | **Price width.** u64 in Move, u128 in §5bis. The fixture `u128-max-price-…` is not expressible against Move at all. | |

**Which side is right is a human decision, not a mechanical one** — D2 and D4 in particular
are genuine design choices, and the Rust crate deliberately implements BOTH engines rather
than picking. What is not optional is saying so: a parity claim that has not been checked
is a guess, and one that has been checked and failed is a bug.

Two smaller corrections from the same pass:
- **§5bis(d) miscounts its own layout** — it says "= 73 bytes" for a field list that sums to
  81. The SDK's test asserts 81, so the code is right and the prose above is wrong.
- The pre-existing Rust crate carried two dead constants: `0xA11CE` asserted as `659_406`
  (it is **659 918**), and a reference to a hash-vector file that does not exist. Both
  corrected. The replacement BLAKE2b vectors deliberately cross a block boundary: the three
  published 256-bit vectors are all under 44 bytes and every fill leaf is under 128, so
  nothing else in this repo could have caught a multi-block bug.

---

## 6. `approve_nav` — the O(1) form

It must **not** iterate requests; `object_runtime_max_num_store_entries = 1000` makes any
per-request loop a liveness bug waiting to happen.

```
1. digest check: blake2b256(bcs(proposal)) == expected_digest      -> EDigestMismatch
   (the admin multisig signs the exact numbers; a keeper cannot swap the proposal in a race)
2. now - proposed_ms <= max_proposal_age_ms                        -> EProposalStale
3. |nav/supply - last| relative <= max_nav_jump_bps                -> ENavJump
4. divergence_bps(clearing_price, book_mid) <= max_price_dev_bps   -> EPriceDeviation
5. native_btc_sats <= hashi_pending_sats                           -> ENavLegUncapped
6. epoch_prices[epoch] = EpochPrice { nav_assets, nav_supply, now }
7. shares_to_mint    = mul_div(pending_deposit_assets, nav_supply, nav_assets)  // round DOWN
   assets_to_release = mul_div(pending_redeem_shares,  nav_assets, nav_supply)  // round DOWN
8. committed_supply += minted; unminted_shares += minted; committed_supply -= redeemed
9. epoch += 1; zero the pending counters; proposal = none
10. assert_solvent()                                               -> ESolvency
```

`claim_deposit` recomputes the **same** `mul_div` per receipt. Because round-down is
subadditive, `Σ per-receipt ≤ epoch total` always — the dust stays with the vault and never
with a claimant. Test: `nav_rounding_never_over_mints`.

**`committed_supply` is the correct solvency denominator**, not `coin::total_supply`:
total_supply undercounts owed-but-unminted shares and would let an over-mint pass.

```move
assert!(mul_div_u128(supply, last_nav_assets, last_nav_supply) <= (assets as u128), ESolvency);
assert!(coin::total_supply(&lp_treasury) + unminted_shares == committed_supply, ESupplyDrift);
```

**A paused vault still lets holders leave.** `request_redeem` and `claim_redeem` do NOT call
`assert_not_paused`.

---

## 7. What `KeeperCap` may call — the complete list

| Module | Function | Why it is safe |
|---|---|---|
| `vault` | `propose_nav` | records only, commits nothing |
| `vault` | `attest_limiter` | bounded reading, cannot exceed admin-set bounds |
| `allocate` | `allocate` / `deallocate` | destination restricted to the pinned allowlist |
| `carry` | `place_carry_bid` / `cancel_carry_bid` | value-preservation floor asserted in Move |
| `clearing` | `settle_step` (budget hint) | permissionless anyway; the cap only prioritises gas |

**Deliberately NOT keeper-gated, because liveness must not be a privilege** (spec §9):
`open_batch`, `close_batch`, `reveal_order`, `begin_clearing`, `sort_step`, `price_step`,
`settle_step`, `claim_deposit`, `claim_redeem`. The schedule and the commitments *are* the
authorization.

**INV-C1 is enforced structurally:** the keeper-gated functions have **no `address` parameter
at all**. Add a `gates.ps1 keepercap` grep that fails if one appears.

**Pause asymmetry, honestly.** Move cannot read a multisig's threshold, so the spec's
asymmetry is enforced off-chain by the multisig config. What Move *can* enforce, and does:
`pause` is one transaction; `unpause` requires `arm_unpause` in an **earlier** transaction
plus `unpause_delay_ms` elapsed. Cheap to stop, expensive to resume, on-chain.

---

## 8. Decisions

| # | Decision | Status |
|---|---|---|
| **D1** | **TypeScript keeper, one process. Rust confined to clearing parity + `sim/`, offline.** `@mysten/seal` has no Rust SDK and the keeper's defining duty at close is to decrypt. A Rust keeper would need a TS sidecar for exactly that leg — two supervision trees, an IPC boundary carrying **order plaintext**, and a second implementation of the identity encoding, which is precisely where F1 bites. `@mysten/hashi` is TS-only too. **Doc consequence:** spec §9 and governance §4.4 say "open-source Rust"; the honest reconciliation is *"open source; TypeScript, because Seal has no Rust client."* Change the doc, not the architecture. | matches the build |
| **D2** | **Do not demo the carry.** 117 pools in the registry, exactly one involves hBTC, **empty on both sides**. `treasury::mint` is `public(package)` (no hBTC) and the DBUSDC `TreasuryCap` is `AddressOwner` (no quote). A two-sided seeder is a hard dependency on inventory we do not have. | accepted |
| **D3** | **No hBTC lending market exists on testnet.** Suilend/Navi/Scallop have no testnet deployment at all; AlphaLend's 7 markets are testcoins + SUI; Navi mainnet's 35 pools contain no Hashi hBTC. ⇒ we deploy the counterparty ourselves, and say so everywhere. Shape the adapter to the real ERC-4626-ish surface so a mainnet adapter is a new module, not a refactor. | see §9 |
| **D4** | `MAX_BATCH_SIZE` governed at 256, hard cap 512, resumable from day one, then measure. | §2 |
| **D5** | **Mainnet decentralized Seal requires an Enoki-issued API key**, which the no-Enoki rule forecloses. On **testnet** the rule is satisfied by construction: `@mysten/seal@1.3.4` makes `serverConfigs` required, exports no `getAllowlistedKeyServers`, ships no default set. Mainnet options, in order: (a) run our own key servers alongside independent operators, (b) accept an Enoki key for *transport only* — **needs verification that it confers no share**, (c) go straight to the PCR-gated Nautilus policy, the planned upgrade anyway. Decide before mainnet; do not design around it in silence. | open |
| **D6** | **Do not attempt Phase 2.** Spec §11 is explicit. D2 and D3 agree, a 2-of-2 custody multisig plus policy co-signer is an ops project, and the latency model needs the deferred Rust `sim/`. Land `carry.move` as a compiling interface with its banner, signatures and tests written. | accepted |
| **D7** | **Escrow custody separate from vault NAV.** Deviation from the governance note; rationale in F3. A governed `vault::absorb_idle_escrow` is designed and **disabled in v1**. | ⚠ needs reconciliation |
| **D8** | **v1 note spends are LINKABLE.** Spec §7.1 says spends publish a nullifier "without revealing which leaf" — true only with ZK. In v1 the Merkle path is supplied in the clear, so `path_index` names the leaf. **v1 delivers uniformity, not unlinkability.** The commitment/nullifier machinery earns its keep by making Phase 4 a verifier swap. State this in the limitations panel and the README; do not soften it. | must be published |
| **D9** | **Seal committee: n = 5 across 5 distinct OPERATORS, t = 3.** Count operators, not servers — two Mysten servers are one failure domain. 3 of 10 advertised testnet servers are down and versions skew 0.4.4 / 0.6.7 / 0.6.11. Health-probe `/v1/service` (needs **both** a `Client-Sdk-Version` header and a `?service_id=` query param, else 400) and refuse to open a batch below t live. **Never fall back to plaintext.** | |
| **D10** | **Validator collusion floor: quote both numbers, always labelled.** Voting-power cap is `min(10000, max(1000, ceil(10000/n)))` = 10 % while n ≥ 10, so the protocol floor for a quorum is **7 colluding validators**; **live testnet today is 32**. Never a bare "7" (overstates the risk), never a bare "32" (understates the guarantee). | |
| **D11** | **Groth16 (Phase 4) compatibility is UNVERIFIED.** `sui::groth16` takes bn254/bls12381, VK in Arkworks canonical compressed, public inputs as 32-byte **little-endian** scalars, a **hard cap of 8 public inputs**, and `verify_groth16_proof` returns `bool` — it does **not** abort, so the v1 "deny by abort" habit is wrong there. circom/snarkjs serialization compatibility is untested. Phase 4 also wants a SNARK-friendly hash, so blake2b256 → Poseidon is a **tree migration**. Gate Phase 4 on a spike, not a plan. | open |
| **D12** | Carried-forward blockers: **B11** `scripts/register-deposit.ps1` hardcodes two Hashi ids and fails the `ids` gate — source them from `keeper/.env` as `seed-book.mjs` already does. **B8** `Move.lock` records Windows backslash subdirs. **RECON R9 rows #1 and #7** print `105_000` where the algorithm and both shipped twins say `100_150` — the doc is wrong, the tests are right; fix the doc. | |

---

## 9. Why an `sdk/` package is structural, not cosmetic

Three algorithms must be byte-identical in three places: **clearing** (Move + keeper +
app-verifier), the **Merkle tree** (Move + app-prover + keeper root check), and the **Seal
inner id** (Move decoder + app encoder + keeper encoder).

`keeper/src/hashi/limiter.ts`'s banner already carries the rule — *"@forbidden a SECOND copy
of this algorithm anywhere"* — and `keeper/test/limiter.cross.test.ts` exists precisely
because a duplicate drifted once (blocker B6). Duplicating clearing across keeper and app
would reintroduce B6 in the one place where a divergence is a **release blocker** (spec §9).

No build step: `"exports": { "./*": "./src/*.ts" }`, consumed via `keeper/tsconfig.json`
`paths` and `app/vite.config.ts` `resolve.alias`.

**Parity is asserted at three levels**, so the cheap ones run every commit and the expensive
one gates release:

- **L1 — shared golden fixtures.** ~40 hand-written cases in
  `sdk/fixtures/clearing.golden.json`: empty · all-bids · all-asks · no cross · exact touch ·
  single crossing pair · every order at the same price (full pro-rata) · pro-rata with a
  remainder needing largest-remainder tie-breaking · duplicate `(price, submitter)` needing
  the index tie-break · an under-funded account triggering truncation · u64/u128 boundaries ·
  max batch size. A generator emits `move/tests/clearing_golden_tests.move` from the *same*
  JSON, so a fixture edit updates both sides or fails to compile.
- **L2 — TS property test, 10 000 cases, every commit.** Uses the existing seeded
  `keeper/src/util/rng.ts` (the `purity` gate forbids `Math.random()`).
- **L3 — the real parity test, against Move.** `clearing.move` exposes a pure
  `compute_for_inspect(orders_bcs, tick): vector<u8>`; the keeper feeds the same generated
  sets through `devInspectTransactionBlock` and compares BCS **byte-for-byte**. A mismatch
  prints the failing set as a new fixture and fails. This is the release gate spec §9 demands.

---

## 10. Every §10 invariant, as a named test

Legend: **MU** Move unit · **MS** Move `test_scenario` multi-tx · **KP** keeper property ·
**KG** keeper/sdk golden · **LIVE** needs a published package.

### Settlement
| Invariant | Test | Kind |
|---|---|---|
| reverts unless debits == credits | `clearing_tests::settle_reverts_on_value_leak` (`EValueNotPreserved`, corrupted fills) | MU |
| | `clearing_tests::fee_is_an_explicit_credit_term` | MU |
| nobody filled outside their limit | `clearing_tests::no_fill_outside_limit_price` | MU |
| | `clearing.parity.test.ts > no fill outside limit, 10k sets` | KP |
| every fill ↔ exactly one decrypted order | `clearing_tests::every_fill_maps_to_one_revealed_order` | MU |
| | `clearing_tests::unrevealed_orders_are_absent_from_fills` | MU |
| idempotent | `clearing_tests::clearing_is_idempotent` (re-run on cloned scratch) | MU |
| | `clearing_tests::settle_step_past_end_is_a_noop` | MU |
| **Move ≡ TS bit-identical** | `clearing.moveparity.test.ts > 10k devInspect comparisons` | LIVE |

### Notes
| Invariant | Test | Kind |
|---|---|---|
| a nullifier is consumed at most once | `notes_tests::nullifier_cannot_be_reused` (`ENullifierUsed`) | MU |
| | `notes_tests::same_nullifier_in_one_tx_aborts` | MU |
| note value == custodied minus deployed | `balance_tests::conservation_holds_after_every_op` (the D7 form) | MU |
| | `scenario_tests::conservation_across_deposit_spend_trade_withdraw` | MS |
| no `Note` carries an amount | `notes_tests::note_struct_has_no_amount_field` | MU |
| | `gates.ps1 notes` — greps `struct Note` for any field but `id`/`denom_index` | gate |
| stale root outside the ring rejected | `notes_tests::root_older_than_ring_is_rejected` | MU |

### Batch
| Invariant | Test | Kind |
|---|---|---|
| `close_batch` reverts before schedule | `batch_tests::close_before_schedule_aborts` (`ETooEarly`) | MU |
| | `batch_tests::close_at_exactly_close_ms_succeeds` (boundary is `>=`) | MU |
| nothing reveals contents while OPEN | `batch_tests::reveal_while_open_aborts` (`EBadState`) | MU |
| | `batch_tests::open_batch_stores_no_plaintext` | MU |
| transitions monotonic | `batch_tests::state_transitions_are_monotonic` (all 16 pairs) | MU |
| | `gates.ps1 batchstate` — `\.state\s*=` only in `set_state`/`open_batch` | gate |
| operator cannot choose the close | `batch_tests::close_ms_is_derived_not_supplied` · `::next_boundary_golden` | MU |
| a full batch does not close early | `batch_tests::batch_full_rejects_submit_but_does_not_close` | MU |
| **the LE/BE trap (F1)** | `batch_tests::seal_approve_little_endian_golden` — the LE id opens, the **BE** encoding of the same timestamp **aborts** | MU |
| | `batch_tests::seal_approve_rejects_trailing_bytes` | MU |
| | `batch_tests::seal_approve_rejects_wrong_policy_version` | MU |
| | `batch_tests::policy_bump_with_live_batch_aborts` | MU |

### NAV
| Invariant | Test | Kind |
|---|---|---|
| reverts on excess relative jump | `vault_tests::nav_jump_beyond_bound_aborts` (`ENavJump`) | MU |
| reverts on clearing-vs-mid deviation | `vault_tests::clearing_price_deviation_aborts` | MU |
| native-BTC leg ≤ Σ on-Sui claims | `vault_tests::native_btc_leg_capped_by_onsui_claims` | MU |
| `supply × nav ≤ assets` | `vault_tests::solvency_holds_after_every_mutation` (all 8 mutators) | MU |
| | `vault_tests::nav_rounding_never_over_mints` | MU |
| | `scenario_tests::solvency_across_full_epoch` (5 users, request→approve→claim) | MS |
| two PARTIES, not two scopes | `vault_tests::keeper_cannot_approve_nav` · `::admin_cannot_propose_nav` | MU |
| | `vault_tests::approve_with_wrong_digest_aborts` · `::stale_proposal_aborts` | MU |
| a paused vault still lets holders leave | `vault_tests::redeem_and_claim_work_while_paused` | MU |

### Capabilities
| Invariant | Test | Kind |
|---|---|---|
| no keeper fn moves assets off-allowlist | `caps_tests::keeper_functions_take_no_address_param` + the gate | MU |
| | `allocate_tests::allocate_to_unlisted_adapter_aborts` · `::allocate_beyond_cap_bps_aborts` | MU |
| no keeper fn mints, burns or rotates a cap | `caps_tests::keeper_cannot_rotate_itself` · `vault_tests::keeper_cannot_reach_lp_treasury` | MU |
| admin transfer requires acceptance | `caps_tests::admin_transfer_requires_acceptance` | MU |
| | `caps_tests::old_admin_cap_is_stale_after_acceptance` · `::rotated_keeper_cap_invalidates_old` | MU |
| pause cheap, unpause expensive | `caps_tests::unpause_without_arming_aborts` · `::unpause_before_delay_aborts` | MU |

**Targets.** Move ≥ 320 tests · keeper+sdk ≥ 450 · app ≥ 90 · `verify-onchain` ≥ 30 live
assertions · all gates green.

---

## 11. Notes ladder and hashing

```
ladder = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000] sats   // 0.01 / 0.1 / 1 / 10 hBTC
```

The floor matters: 0.01 hBTC = 1 000 000 sats sits comfortably above Hashi's 30 000-sat
withdrawal minimum (RECON R6), so **every denomination is individually redeemable**.

Few tiers, widely spaced — *denominations create uniformity, not privacy; privacy comes from
the crowd.* A ladder fine enough to express an exact amount fragments participants into
singleton anonymity sets and is worth less than no ladder at all.

Hash: `sui::hash::blake2b256`, domain-separated with a 1-byte tag (`0x00` leaf / `0x01` node)
to prevent second-preimage across levels.
- leaf = `blake2b256(0x00 ‖ u8 denom_index ‖ 32B secret ‖ 32B r)`
- nullifier = `blake2b256(32B secret ‖ bcs u64 leaf_index)`

**Gas shape — this is why it fits.** An append is `depth = 20` hashes rewriting
`filled_subtrees` **inside the object**: zero dynamic-field entries. A nullifier insert is
**one** table entry. So 256 spends cost 256 store entries, not 5 120.

Denominations are **append-only**: repricing an existing tier would revalue live notes.

---

## 12. Repo-shape reconciliation

Spec §5 asks for a top-level `sources/`. **Do not do it.** `move/sources/` is where
`Move.toml` resolution, `scripts/gates.ps1`, `scripts/verify-all.ps1` and every
`@verify sui move test` already point. Renaming costs a day and buys nothing.

| Spec §5 | Actual | Action |
|---|---|---|
| `sources/` | `move/sources/` | keep the path, replace the contents |
| `tests/` | `move/tests/` | keep (ERRATA E-M2 records why they sit at the package root) |
| `keeper/` | `keeper/` | keep, TypeScript (D1) |
| `sdk/` | — | **NEW** — §9 |
| `design/governance.md` | `aphotic-governance.md` | move to `docs/GOVERNANCE.md` |

---

## 5quater. ⚠ THE sdk↔MOVE DIVERGENCE IS WIDER THAN CLEARING — measured 2026-07-26

§5ter recorded that `clearing.move` and the spec disagree. Wiring the app against the
**deployed** package found the same class of divergence in **three more encodings**, and one of
them is worse than a wrong number.

| | `sdk/` (spec as written) | deployed Move |
|---|---|---|
| note commitment | `blake2b256(0x00 ‖ denom ‖ s ‖ r)` | `0x01` tag |
| nullifier | untagged | `0x02` tag |
| note node / `zeros[0]` | `0x01` / 32 zero bytes | `0x03` / `blake2b256(0x00)` |
| `Order` BCS | `u8 side ‖ u128 price ‖ u64 qty ‖ salt` | `address ‖ bool ‖ u64 ‖ u64 ‖ salt` |
| `Fill` leaf | 81 B, carries `fee`, no `batch_id` | 73 B, carries `batch_id`, no `fee` |

**The note commitment one is the dangerous entry.** A note committed under the SDK's tags
appends to the tree perfectly happily and is then **unspendable forever** — there is no error at
append time, no error at spend time that names the cause, and no way to recover the deposit. It
is the same silent-failure shape as the Seal endianness bug and the Bitcoin txid byte order:
wrong in exactly one direction, on a path that never throws.

**Resolution taken:** `app/src/lib/{notes,order,fills}.ts` mirror the **deployed** structs and
import only the SDK's primitives (`blake2b256`, `BcsWriter`, `hashLeafBytes`). Each carries the
divergence in its banner. `sdk/` was not edited — it implements the spec, and which side is
right is the same human decision §5ter describes.

**What this means for the parity claim:** it is not one bug, it is a **systematic drift between
a spec written ahead of the code and the code as shipped**. Do not present cross-implementation
parity as a property of this system. Present it as what it currently is — a check we built,
ran, and failed, three times over, which is precisely why it was worth building.

---

## 5ter — RESOLVED, in part. Package v2, 2026-07-26

**D2 and D4 are closed, in the spec's favour, by upgrading Move.**
`published-at` `0x653a8128…` · `original-id` `0xfa214c43…` · upgrade tx
`GVMNWL56qNMR4WRSafnwfBaAFS3aSYvTjXuySFQowx6i` · 283 tests green.

- **D2** — allocation at an overfull strictly-inside level is now **pro-rata**, not greedy.
  Two bids of 60 at par against an ask of 50 now fill **25/25**, not 50/0. This was not a
  rounding preference: greedy allocation put a *first* inside a batch that the whole pitch
  says has none, so it made the product's central claim false. Pro-rata is what makes
  *"uniform-price clearing does not make front-running hard, it makes it meaningless"* true.
- **D4** — truncation moved from load time to **after** price discovery. An under-funded
  account can no longer move the uniform clearing price for everyone; it can only reduce its
  own fill, with the counterparty re-rationed symmetrically by the same rule. It was a
  manipulation lever at near-zero cost — submit an order you cannot fund, move everyone's
  price.

**D1, D3 and D5 remain open**, and they are conventions rather than behaviours: the fill-leaf
layout (73 vs 81 bytes), whether rounding dust folds into the fee, and u64 vs u128 price
width. The clients follow Move on all three.

⚠ **The parity claim still must not be made.** D1 alone means the Merkle roots can never
match for a non-empty fill set. What changed is that the two divergences which *weakened the
product* are gone; the three that remain are bookkeeping differences to align at leisure.
