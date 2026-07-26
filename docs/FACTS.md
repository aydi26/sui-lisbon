# FACTS.md — canonical single source of truth

> Purpose: the one authoritative reference for every verified identifier, byte layout, constant,
> ceiling, signature, latency and endpoint Aphotic depends on. Every other doc links here by
> anchor; **do not duplicate these values elsewhere, and never re-derive one.**
> Read after: `aphotic.md`, `docs/DESIGN-V2.md`, `docs/RECON.md`.
>
> **Provenance markers.** `[R<n>]` = `docs/RECON.md` section — verified live on 2026-07-25 by
> on-chain read, HTTP probe or upstream source fetch. `[D<n>]` = a probe block in
> `docs/DAY-ONE-RESULTS.md` (archived, still the receipt). `[V2 §n]` = `docs/DESIGN-V2.md`.
> On conflict: **RECON wins on facts about the world; DESIGN-V2 wins on deltas and decisions;
> the shipped code and its passing tests win on what the code does.**
>
> **Rewritten 2026-07-26 for the v2 product.** Everything that described the v1 market-making
> vault (the maker/IOC router, the `TradeCap`-only keeper, the pinned `btc_exit_address`, the
> Seal-encrypted *strategy*, the peg-flow signal) has been removed, not archived — it described
> modules that no longer exist. The DeepBook section survives **only** as venue reality behind
> decision D2.

---

## Golden rules (front-loaded)
<a id="golden-rules"></a>

The one-line forms are in `CLAUDE.md`, which is auto-loaded into every session and is the
authoritative statement. This table exists so a doc can cite a rule by number.

| # | Rule |
|---|---|
| G1 | hBTC is a plain fungible `Coin<BTC>`, 8 decimals, sats — no `DenyCap`, no deny list, no freeze. On-Sui movement is instant; Bitcoin latency exists only at mint/burn, so the BTC leg is never live-demoable. You cannot buy priority in the queue: over-capacity is **rejected**, not queued. |
| G2 | Honesty is a hard requirement. hBTC IS custodial-threshold wrapped BTC · v1 note spends are **linkable** · we deploy the lending counterparty ourselves · validator collusion floor **7**, live testnet **32**, always both and always labelled · the native-BTC NAV leg is capped at the on-Sui claims behind it. |
| G3 | The keeper holds no discretion, enforced **structurally**: the complete callable list is `[V2 §7]`, and those functions take **no `address` parameter at all**. NAV is two **parties**, not two scopes. |
| G4 | Liveness is never a privilege — the whole batch critical path is permissionless, and a paused vault still lets holders leave. |
| G5 | Timing is mechanical: `close_ms` is derived, never supplied; a full batch does not close early. |
| G6 | The Seal identity is **LITTLE-ENDIAN**; `seal_approve` denies by abort and has **no sender check**. |
| G7 | One implementation of every cross-language algorithm, in `sdk/`. Clearing must be **bit-identical** across Move and TypeScript; a divergence is a release blocker. Hashi stays behind an adapter + mock; ids arrive as config. |
| G8 | The batch ceiling is **store entries and events, not gas budget**. 1 000 / 1 024 / 5 000 000, none raisable. Resumable cursors from day one. |
| G9 | Escrow must not leak size: fixed denominations, no amount field on a `Note`, no reserve at submit time. |
| G10 | Move 2024 idioms · sats `u64` · `E<Reason>` errors · an event per externally-visible transition · integer arithmetic only. |

---

## Ceilings — the limits that actually bind
<a id="ceilings"></a>

Anchor: `#ceilings`

**None of these can be raised by paying more gas. The gas *budget* is not the binding limit.**
Source `[V2 §2]`; mirrored in `move/sources/events.move` and `move/sources/notes.move` `@facts`.

| Limit | Value | What consumes it | headroom at n=256 | at n=512 |
|---|---|---|---|---|
| `object_runtime_max_num_store_entries` | **1 000** / tx | one `Table<address, Account>` entry per distinct participant in `settle_step`; one entry per nullifier insert | ≤ 256 | ≤ 512 |
| `max_num_event_emit` | **1 024** / tx | 1 × `BatchSettled` + 1 × `Filled` per fill | ≤ 257 | ≤ 513 |
| `max_gas_computation_bucket` | **5 000 000** units | `sort_step` + `price_step` | **must MEASURE** | **must MEASURE** |
| object size | 250 KB | ≈ 226 B/order across `orders` + `revealed` + `perm` | ≈ 58 KB | ≈ 116 KB |
| `max_pure_argument_size` | 16 384 B | `reveal_many` at ≈ 72 B/`Order` | ≈ 220 per call | ≈ 220 per call |

**Decision `[V2 D4]`.** `MAX_BATCH_SIZE` is a **governed parameter, default 256**;
`HARD_MAX_BATCH_SIZE = 512` is asserted in the setter. 256 leaves ~4× headroom on the 1 000-entry
and 1 024-event walls simultaneously, and the object-size wall independently agrees 512 is the
ceiling.

**Consequences that are not optional:**

- `sort_step` and `settle_step` take a `budget` and advance an **on-chain cursor**, from day one.
  Retrofitting resumption changes the state machine, the events and the tests. With `budget = 128`
  a 512-order batch settles in 4 transactions, and n could grow into the thousands with no
  contract change.
- `emit_per_fill: bool` in the registry is the event escape hatch: with it `false`, only
  `BatchSettled` + `ClearingComputed` are emitted and every fill stays provable from `fills_root`,
  so the 1 024-event wall can never brick a batch.
- `MAX_SPENDS_PER_TX = 800` in `notes.move` — 20 % headroom under the 1 000-entry wall for the
  vault's own writes.
- **Measure, do not assume, the 5 M computation cap.** `scripts/measure-clearing.mjs` devInspects
  `sort_step`/`price_step` for n ∈ {16, 32, 64, 128, 256, 384, 512}, writes
  `scripts/LIMITS.generated.md` (copied to `docs/LIMITS.md`), and **fails the build if any single
  step exceeds 3 500 000** (70 % of the cap). If `price_step` at 256 exceeds it, drop the default to
  128 and split into `price_scan_step` + `alloc_step`, both cursor-driven — **the API must already
  anticipate that.**
  ⚠ **It has measured nothing yet**: the published package exposes no `clearing` module, so
  `MAX_BATCH_SIZE = 256` is a **reasoned** default, not a measured one. ⚠ The tool divides
  `computationCost` by the **reference gas price**, because the cost is reported in **MIST** and the
  5 M ceiling is in **units** — comparing them directly is wrong by a factor of the gas price.

---

## The Seal identity — byte layout
<a id="seal-identity"></a>

Anchor: `#seal-identity`

Source `[V2 §3]`. **This is the single highest-risk encoding in the project**: a byte order wrong
in one direction only, with **no error message on the wrong path** — the key server simply declines
and the batch never reveals. Structural twin of the Bitcoin txid trap in `[R14.2]`.

Full IBE identity is `bytes(packageId) ‖ inner`. `seal_approve` receives **only `inner`**, 48 bytes:

```
[ 0..8 )  bcs u64      close_ms         LITTLE-ENDIAN   <- the trap
[ 8..16)  bcs u64      policy_version   LITTLE-ENDIAN
[16..48)  bcs address  batch object id  (32 raw bytes)
leftovers MUST be empty
```

**Why LE.** `bcs::peel_u64` reads **little-endian**. The deleted v1 `vault.move:698-703` decoded
the epoch as `epoch = (epoch << 8) + byte` — **big-endian** — and `keeper/src/privacy/seal.ts`
documented it as *"u64 version_epoch BIG-ENDIAN"*. Copying either into `batch.move` produces a
policy that never opens.

**Resolution (mandatory).** One file owns the encoding — `sdk/src/seal/identity.ts` — both sides
import it, and a golden byte-vector test pins it in **both** languages: the LE encoding of a given
`T_ms` must **open**, and the BE encoding of the **same** `T_ms` must **abort**
(`batch_tests::seal_approve_little_endian_golden`).

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
/// NO SENDER CHECK.
entry fun seal_approve(id: vector<u8>, r: &BatchRegistry, c: &clock::Clock) {
    assert!(check_policy(id, r, c), ENoAccess);
}
```

**No sender check `[V2 F2]`.** The v1 vault asserted `sender == owner || sender == keeper`. A batch
time-lock must be satisfiable by **anyone** after `T` — that is exactly what makes reveal
permissionless and kills grief-by-non-revelation, the failure mode that sank commit–reveal
(`aphotic.md` §3).

**Key-server constraints, all satisfied**: 1 command (≤ 100), a `MoveCall` into our own package, a
name prefixed `seal_approve`, first argument a non-empty `Pure`, side-effect free, denial by abort.
`&BatchRegistry` and `&Clock` are shared reads and are legal in the dry run.

**The commitment binds the PLAINTEXT, not the ciphertext**:
`commitment = blake2b256(bcs(Order))`. If only `ct_hash` were binding, a submitter could publish one
ciphertext and later claim a different plaintext decrypted from it. Binding to the plaintext closes
that and does **not** reintroduce commit–reveal's grief problem, because after `close_ms` anyone can
fetch the Seal shares and produce the reveal. `ct_hash` and `blob_id` exist only so a third party
can *find* the ciphertext.

### Seal committee `[V2 D5, D9]`

| Field | Value |
|---|---|
| Size | **n = 5 across 5 distinct OPERATORS, t = 3.** Count **operators**, not servers — two Mysten servers are one failure domain. |
| Health probe | `GET {url}/v1/service` — requires **both** a `Client-Sdk-Version` header **and** a `?service_id=` query param, else `400`. |
| Refusal rule | **Refuse to open a batch below `t` live servers. Never fall back to plaintext.** |
| Testnet fleet state (2026-07-25) | 3 of 10 advertised servers down; versions skew `0.4.4` / `0.6.7` / `0.6.11`. |
| **Fleet state FROM A BROWSER (2026-07-26)** | **6 of 10 usable, across exactly 5 distinct operators.** Measured with a real cross-origin `fetch` from `http://localhost:5173`, not with `curl`. The four that fail fail on **CORS, not liveness**: NodeInfra, Studio Mirai, H2O Nodes and Mhax.io all answer `curl` with HTTP 200 and a matching `service_id` while the browser rejects the response — NodeInfra sends `Access-Control-Allow-Origin` **twice**, which is invalid and fatal everywhere. **This app encrypts in the browser, so the browser's verdict is the only one that counts, and a `curl`-based health check will lie to you.** Browser-clean committee, one server per operator: Mysten Labs · Ruby Nodes · Overclock · Triton One · Natsai. Verified end to end (`SealClient.encrypt`, `verifyKeyServers: true`, t = 3 of 5), not merely probed. |
| **Enoki is excluded** | Enoki is both a zkLogin salt provider and a Seal key server; using it for both hands one party identity linkage **and** a decryption share. |
| Mainnet ⚠ | Mainnet decentralized Seal requires an **Enoki-issued API key**, which the no-Enoki rule forecloses. Options in order: (a) run our own key servers alongside independent operators, (b) accept an Enoki key for *transport only* — **needs verification that it confers no share**, (c) go straight to the PCR-gated Nautilus policy, the planned upgrade anyway. **Decide before mainnet; do not design around it in silence.** |

On **testnet** the no-Enoki rule is satisfied by construction: `@mysten/seal@1.3.4` makes
`serverConfigs` required, exports no `getAllowlistedKeyServers`, and ships no default set.

---

## Cadence — timing is mechanical
<a id="cadence"></a>

Anchor: `#cadence`

Source `[V2 §4]`. Same function in Move and in `sdk/src/cadence.ts`, with shared golden vectors.

```move
public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64 {
    let since = oracle::saturating_sub(now_ms, offset_ms);
    let periods = since / cadence_ms;
    offset_ms + oracle::saturating_mul(periods + 1, cadence_ms)
}
```

| Constant | Value | Meaning |
|---|---|---|
| `cadence_ms` | **43 200 000** | 12 hours |
| `offset_ms` | **21 600 000** | 6 hours — unix epoch day 0 begins 00:00 UTC, so this yields **06:00 and 18:00 UTC daily** |
| `SUBMIT_CUTOFF_MS` | **60 000** | no submit lands within a minute of close, so a submit cannot race an early key release |
| `REVEAL_GRACE_MS` | **600 000** | 10 minutes of reveal window — two orders of magnitude more than the observed key-server skew |

- `open_batch` takes **no timestamp parameter**; `close_ms` is derived.
- `close_batch` checks the **on-chain `Clock`**, not any key server, so the transition is exact
  regardless of skew. The boundary is `>=`: closing at exactly `close_ms` succeeds.
- **A full batch does not close early.** Closing on fullness would hand a spammer exactly the
  timing lever uniform-price clearing exists to remove. A full batch rejects further submits and
  still closes on the boundary.
- An early key leak of ≤ 2 min reveals orders that can no longer be joined or withdrawn against:
  the ledger froze at `close_batch` and submits stopped a minute earlier.
- Settle on **every** pass, with or without pending orders, so the on-chain share price tracks
  accrual continuously rather than only at deposit events.

---

## The denomination ladder
<a id="denominations"></a>

Anchor: `#denominations`

Source `[V2 §11]`, `aphotic.md` §7.1.

```
ladder = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000] sats   // 0.01 / 0.1 / 1 / 10 hBTC
```

**The floor matters:** 0.01 hBTC = 1 000 000 sats sits comfortably above Hashi's 30 000-sat
withdrawal minimum `[R6]`, so **every denomination is individually redeemable**.

Few tiers, widely spaced — *denominations create uniformity, not privacy; privacy comes from the
crowd*. A ladder fine enough to express an exact amount fragments participants into singleton
anonymity sets and is worth less than no ladder at all. `MAX_TIERS = 8` is a design guard, not a
gas guard. **Denominations are append-only**: repricing an existing tier would revalue live notes.

### Hashing — domain-separated blake2b256

`sui::hash::blake2b256`, with a 1-byte domain tag so the four hashes are non-interchangeable and
second preimages cannot cross levels. Every input is **fixed width**, so the concatenations are
unambiguous; `secret` and `randomness` are asserted to be exactly 32 bytes.

| Hash | Preimage | Note |
|---|---|---|
| commitment `C` | `blake2b256( 0x01 ‖ denom_index(1) ‖ secret(32) ‖ randomness(32) )` | as shipped in `notes.move` |
| nullifier `N` | `blake2b256( 0x02 ‖ secret(32) ‖ leaf_index(8, **LITTLE-ENDIAN**) )` | LE matches BCS and the Seal inner id |
| node `H` | `blake2b256( 0x03 ‖ left(32) ‖ right(32) )` | |
| zero leaf | `Z0 = blake2b256( 0x00 )`, `Z[i+1] = H(Z[i], Z[i])` | |

> ⚠ **Errata note.** `[V2 §11]` writes the leaf as `blake2b256(0x00 ‖ denom_index ‖ secret ‖ r)`
> and the nullifier without a domain tag. The **shipped** `move/sources/notes.move` uses the tags
> in the table above (`0x00` reserved for the zero leaf, `0x01` commitment, `0x02` nullifier,
> `0x03` node) and its tests are green. **The code wins.** Anyone porting the tree into `sdk/`
> must take the shipped tags, and the shared golden vectors must pin them.

**Gas shape — this is why it fits.** An append is `depth = 20` hashes rewriting `filled_subtrees`
**inside the object**: zero dynamic-field entries. A nullifier insert is **one** table entry. So
256 spends cost 256 store entries, not 5 120.

**Phase 4 swap.** `MembershipWitness` is the **only** thing a Groth16 tier replaces. The tree, the
commitment format, the nullifier format, `spend`'s signature and the accounting all stay exactly as
they are. ⚠ See `#unknowns` U-G for why Phase 4 is gated on a spike, not a plan.

---

## Clearing — determinism is the product
<a id="clearing"></a>

Anchor: `#clearing`

Source `[V2 §5]`. Every rule here exists to remove implementation freedom, because the same
algorithm must produce **bit-identical** output in Move and in TypeScript (G7).

1. **Canonical order.** Bids by `(limit_price DESC, submitter bytes ASC, index ASC)`; asks by
   `(limit_price ASC, submitter bytes ASC, index ASC)`. Ties are **fully** broken.
2. **Price discovery.** Candidates = the distinct limit prices present.
   `vol(p) = min(demand(p), supply(p))`. Choose max `vol`; tie-break min `|demand − supply|`;
   tie-break lowest `p`. **Integer only, no floats anywhere.**
3. **Allocation.** Orders strictly inside the cross fill fully. Orders at exactly `p*` on the long
   side are pro-rated `floor(residual × qty_i / Σqty)`, with the remainder distributed one sat at a
   time by **largest fractional remainder, tie-broken by canonical position**.
4. **Limit safety.** Asserted **per fill**, not merely by construction: `bid ⇒ p* ≤ limit`,
   `ask ⇒ p* ≥ limit`.
5. **Quote conversion** rounds **toward the vault** (bids up, asks down), so the dust residual can
   never be negative.
6. **Root.** blake2b256 Merkle over `blake2b256(0x00 ‖ bcs(FillLeaf))` in canonical order, odd
   nodes duplicated.
7. **The fee is an explicit third term, never a silent shortfall:**
   `Σdebits == Σcredits + fee`, with `fee = mul_div(matched_quote, fee_matched_bps, 10_000)`
   credited to `vault.fees_accrued`.
8. **Solvency at settlement without leaking size.** No margin field exists on `SealedOrder` — a
   margin would leak order size at submit time. Instead `close_batch` **freezes the ledger**, and
   `settle_step` **deterministically truncates** any fill the account cannot cover to
   `min(fill, balance)`, recomputing the counterparty symmetrically from the same rule. Because the
   rule is a pure function of the frozen snapshot, Move and the TS twin agree — and **the parity
   test must cover under-funded accounts explicitly.**
9. **Push, not claim** (deviation from `aphotic.md` §7.2 step 5, stated): `settle_step` credits
   fills and `verify_fill` is the transparency surface. A pull model leaves an unbounded
   unclaimed-liability state that must be excluded from NAV and reconciled forever; push makes
   settlement terminal.

### Parity is asserted at three levels `[V2 §9]`

| Level | What | When |
|---|---|---|
| **L1** | ~40 shared golden fixtures in `sdk/fixtures/clearing.golden.json`: empty · all-bids · all-asks · no cross · exact touch · single crossing pair · every order at the same price (full pro-rata) · pro-rata with a remainder needing largest-remainder tie-breaking · duplicate `(price, submitter)` needing the index tie-break · **an under-funded account triggering truncation** · u64/u128 boundaries · max batch size. A generator emits `move/tests/clearing_golden_tests.move` from the *same* JSON, so a fixture edit updates both sides or fails to compile. | every commit |
| **L2** | TypeScript property test, 10 000 cases, using the existing **seeded** `keeper/src/util/rng.ts` (the `purity` gate forbids `Math.random()`). | every commit |
| **L3** | The real parity test: `clearing.move` exposes a pure `compute_for_inspect(orders_bcs, tick): vector<u8>`; the keeper feeds the same generated sets through `devInspectTransactionBlock` and compares **BCS byte-for-byte**. A mismatch prints the failing set as a new fixture and fails. | release gate |

---

## NAV — `approve_nav`, the O(1) form
<a id="nav"></a>

Anchor: `#nav`

Source `[V2 §6]`. It must **not** iterate requests: `object_runtime_max_num_store_entries = 1000`
makes any per-request loop a liveness bug waiting to happen.

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

- `claim_deposit` recomputes the **same** `mul_div` per receipt. Because round-down is subadditive,
  `Σ per-receipt ≤ epoch total` always — the dust stays with the vault and never with a claimant.
  Test: `nav_rounding_never_over_mints`.
- **`committed_supply` is the correct solvency denominator**, not `coin::total_supply`:
  total_supply undercounts owed-but-unminted shares and would let an over-mint pass.

```move
assert!(mul_div_u128(supply, last_nav_assets, last_nav_supply) <= (assets as u128), ESolvency);
assert!(coin::total_supply(&lp_treasury) + unminted_shares == committed_supply, ESupplyDrift);
```

- **A paused vault still lets holders leave.** `request_redeem` and `claim_redeem` do **not** call
  `assert_not_paused`.

### NAV composition, and the one leg that is not Sui-verifiable

| Leg | Source | Verifiable on Sui? |
|---|---|---|
| Idle `hBTC` | `Balance<BTC>` in vault | ✅ |
| Idle `USDC` | `Balance<USDC>` in vault | ✅ |
| Lending positions | adapter `convert_to_assets(shares)` | ✅ (against **our own** market — see G2) |
| Notes in escrow | denom × count, net of nullified | ✅ — **but custodied by `balance.move`, NOT inside vault NAV** (`[V2 F3/D7]`, `docs/GOVERNANCE.md` §9 D-G1) |
| Pending Hashi withdrawals | `WithdrawalRequest.btc_amount` where `sender` = custody | ✅ off-chain read; **not** readable from Move `[R7.2]` |
| In-flight withdrawals | `WithdrawalTransaction` referencing our request ids | ✅ off-chain read |
| **Native BTC at the redemption address** | **Bitcoin UTXO set** | ⚠ **NO** |

All legs at par (1 BTC = 1 hBTC); carry P&L accrues through the entry discount.

**The last leg is the honest gap.** Sui has no Bitcoin light client — Hashi itself approves
deposits by committee attestation, not by SPV proof. Three mitigations, in order of strength:
(1) publish and pin the redemption address so anyone can check the balance;
(2) **cap NAV attribution to that leg at the sum of on-Sui-readable `WithdrawalRequest.btc_amount`
values that produced it** — the unverifiable component can never exceed the verifiable claim behind
it (`ENavLegUncapped`, step 5 above); (3) a Bitcoin header relay in Move — roadmap, not dependency.
**Never present the NAV as fully reconstructible.**

---

## What `KeeperCap` may call — the complete list
<a id="keeper-callable"></a>

Anchor: `#keeper-callable`

Source `[V2 §7]`. **Nothing may be added to this table without a written decision.**

| Module | Function | Why it is safe |
|---|---|---|
| `vault` | `propose_nav` | records only, commits nothing |
| `vault` | `attest_limiter` | bounded reading; cannot exceed admin-set bounds |
| `allocate` | `allocate` / `deallocate` | destination restricted to the pinned allowlist |
| `carry` | `place_carry_bid` / `cancel_carry_bid` | value-preservation floor asserted in Move (Phase 2 — interface only today) |
| `clearing` | `settle_step` (budget hint) | permissionless anyway; the cap only prioritises gas |

**Deliberately NOT keeper-gated, because liveness must not be a privilege** (`aphotic.md` §9):
`open_batch`, `close_batch`, `reveal_order`, `begin_clearing`, `sort_step`, `price_step`,
`settle_step`, `claim_deposit`, `claim_redeem`. **The schedule and the commitments are the
authorization.**

**INV-C1 is enforced structurally:** the keeper-gated functions have **no `address` parameter at
all**. `gates.ps1 keepercap` fails if one appears — it exists as of 2026-07-26, and `g2`'s
destination test is now strictly broader than it.

> ⚠ **A cautionary note worth keeping.** Building `keepercap` exposed that the pre-existing `g2`
> gate — the one guarding this exact invariant — **did not work**: it passed a function taking
> `bitcoin_address: vector<u8>`, because a word-bounded `address` match misses the underscore.
> **Prove every gate against a deliberately-violating fixture tree, not only against passing code.**

**Pause asymmetry, honestly.** Move cannot read a multisig's threshold, so the signer-count
asymmetry is enforced off-chain by the multisig config. What Move enforces: `pause` is one
transaction; `unpause` requires `arm_unpause` in an **earlier** transaction plus `unpause_delay_ms`
elapsed.

### The capability model as shipped (`move/sources/caps.move`)

Ability choices **are** the enforcement, not a comment:

| Cap | Abilities | Consequence |
|---|---|---|
| `AdminCap` | `key` only | can never be `public_transfer`d, can never be wrapped ⇒ the two-step handover is unbypassable |
| `KeeperCap` | `key` only | only `rotate_keeper_cap` can deliver one ⇒ the registry's `keeper` address always holds it |
| `VaultCap` | `store` only | can **never** be a top-level owned object; it lives only inside the vault. No address can ever hold it |
| `CapRegistry` | `store` only | embedded **by value** in the Vault; not shareable, so two registries can never claim the same `vault_id` |

`admin_epoch` and `keeper_epoch` are monotonically increasing; a cap minted before the last
rotation carries the old epoch and is rejected. `MAX_ALLOWLIST = 32` pinned payout destinations —
small on purpose: the allowlist is a governance artefact, not a routing table.

---

## RPC transport
<a id="rpc-transport"></a><a id="rpc"></a><a id="transport"></a>

Anchor: `#rpc-transport`

**The official testnet fullnode does not serve JSON-RPC.** It serves **gRPC v2 only**
(`/sui.rpc.v2.LedgerService/*`); a JSON-RPC POST returns **HTTP 404**. `[R1]`

| Concern | Decision |
|---|---|
| **Default transport** | **`SuiGrpcClient` from `@mysten/sui/grpc` against `https://fullnode.testnet.sui.io:443`.** Constructed in exactly **one** place per package (`keeper/src/sui/client.ts`, `app/src/lib/suiClient.ts`); everything else imports that factory. Enforced by the `transport` gate. |
| `sui` CLI 1.76.0 | Works against the official fullnode (speaks gRPC internally). `sui client object <id> --json` and `sui client call --dev-inspect` are the reference CLI probes. |
| `@mysten/sui@2.22.1` subpaths | `./grpc` → `SuiGrpcClient`; `./jsonRpc` → `SuiJsonRpcClient`. **`@mysten/sui/client` does NOT export `SuiClient`** — that name is gone in 2.x. `[D3]` |
| JSON-RPC mirrors (chain id `4c78adac`) | `https://rpc-testnet.suiscan.xyz:443` (primary probe) · `https://sui-testnet-rpc.publicnode.com` · `https://sui-testnet.nodeinfra.com`. **Probes only.** `sui-testnet.public.blastapi.io` is dead (403). |
| Unsupported on every mirror | `suix_getNormalizedMoveModulesByPackage`. The per-module `sui_getNormalizedMoveModule` **is** supported and is how ABI/visibility was verified. `[D2]` |
| ⚠ **Mirrors serve DELETED objects as live** (2026-07-26) | `suix_getCoins` on `rpc-testnet.suiscan.xyz` returned coin `0x913519a6…` at version **887160253** as an owned object; the fullnode answered **`Object … not found`** — it had been spent. A PTB built from a mirror-sourced object id fails at execution, and the failure looks like a contract bug rather than a stale read. **Rule: every id that will be SPENT comes from the gRPC fullnode.** In `app/`, `listCoinsOf`, `listReceipts` and `readObjectType` are all on `getSuiClient()` (gRPC); the single JSON-RPC read is `readObjectFields`, and it is display-only (`Vault.caps`), where lagging is stale but never unspendable. |
| Chain id | `4c78adac` |

**HTTP/2 requirement.** The Hashi guardian at `https://guardian.testnet.hashi.sui.io` sits behind
an ALB that **rejects HTTP/1.1 with status 464**. Node's global `fetch` and the system `curl` are
HTTP/1.1, so both fail — including `@mysten/hashi`'s own `fetchGuardianInfo`. Use `node:http2`
(ALPN `h2`). `[D4]`

---

## hBTC
<a id="hbtc"></a>

Anchor: `#hbtc`

| Field | Value |
|---|---|
| Coin type (testnet) | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC` |
| Module / struct | `hashi::btc` — `struct BTC has key { id: UID }` (a `coin_registry` currency object, **not** a `drop` witness) `[R7.4]` |
| Decimals · symbol · unit | `8` · `hBTC` · satoshis |
| Coin kind | standard fungible unregulated `sui::coin::Coin<BTC>` via `coin_registry::new_currency`. **No `DenyCap`, no deny list, no freeze capability anywhere in the Hashi package** — Aphotic balances cannot be frozen |
| NOT | a position object / NFT |
| `TreasuryCap` | locked in the shared `Hashi` object |
| mint / burn | `public(package)` only — **we CANNOT mint.** The only way to obtain hBTC is a real signet deposit (~70 min). `[D3c]` |
| Supply (2026-07-25) | ≈ 193.46 BTC `[R5]` |

**Honesty (G2).** hBTC is a claim on a committee-managed pool: threshold Schnorr across an opt-in
stake-weighted validator subset, 2-of-2 with a Guardian enclave, ~60-day CSV recovery leaf. Aphotic
inherits **all** of Hashi's trust assumptions, including that deposits are approved by attestation
without an on-chain light client, and that the Guardian's protection has a per-UTXO horizon (the
recovery tapleaf is MPC-only after a 60-day relative timelock, while coin selection has **no age
criterion**). Aphotic is not trustless; it is **no less trustworthy than the venue it serves**, and
that is the honest bar.

**Two further upstream facts, on the record.**

- **`approve_deposit` is a permissioned gate that can reject.** The committee performs **sanctions
  screening** alongside the 6-confirmation wait, so the on-ramp is not merely slow — it is
  *refusable*, and a refusal is upstream of anything Aphotic controls. Say so rather than implying
  the deposit path is permissionless end to end. (Only `confirm_deposit`, the final mint step, is
  permissionless.)
- **Hashi is pre-1.0 and upstream states it is not production-ready.** Aphotic runs on **testnet**
  against **signet** and inherits that status. Never present either as production-grade.

---

## Hashi Move API
<a id="hashi-move-api"></a><a id="cancel-withdrawal"></a><a id="withdrawal"></a>

Anchor: `#hashi-move-api`

Verified against the **deployed bytecode** (`sui_getNormalizedMoveModule`, visibility field) as
well as source. `Friend` in the normalized ABI == `public(package)` in Move 2024. `[D2] [R7]`

### The entire composable surface — exactly two functions

```move
public fun hashi::withdraw::request_withdrawal(
    hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
    bitcoin_address: vector<u8>, ctx: &mut TxContext)
// asserts version enabled, not paused
// asserts btc.value() >= 30_000                 EBelowMinimumWithdrawal
// asserts addr_len == 20 (P2WPKH) || == 32 (P2TR)   EInvalidBitcoinAddress
// emits WithdrawalRequested
// takes a Balance, not a Coin — composes in PTBs without a wrapper

public fun hashi::withdraw::cancel_withdrawal(
    hashi: &mut Hashi, request_id: address, clock: &Clock,
    ctx: &mut TxContext): Balance<BTC>
// asserts request.sender == ctx.sender()        EUnauthorizedCancellation      SENDER-BOUND
// asserts !is_request_processing(request)       ECannotCancelProcessingWithdrawal
// asserts now >= created_ms + 3_600_000         ECooldownNotElapsed
```

> ### ⚠⚠ Why the redemption leg cannot be non-custodial in Move
>
> `create_withdrawal` sets `sender: ctx.sender()`, which on Sui is the **transaction signer**, never
> the calling module. Therefore:
> - **A shared object can never hold a queue position.** Any design in which an `AphoticVault`
>   shared object holds Hashi queue positions is custodial by construction (`aphotic.md` §3,
>   settled — do not relitigate).
> - `cancel_withdrawal` is **sender-bound**, so only the original signer can ever cancel.
> - The destination `bitcoin_address` is fixed at request time and the escrowed `Balance<BTC>` is
>   burned on commit, leaving **no on-chain claim**.
> - A `WithdrawalRequest` lives inside an `ObjectBag` on `WithdrawalRequestQueue`, **not** in the
>   user's account. It is not a transferable object — **queue positions cannot be traded or bought.**
>
> Mitigation, mirroring Hashi's own Guardian: the custody address is a **Sui 2-of-2 multisig**
> (keeper + independent policy co-signer); the co-signer signs `request_withdrawal` only when
> `bitcoin_address` equals the pinned vault address and only within a rate limit; the pinned
> Bitcoin address is published so redemptions are auditable on Bitcoin. **Enforced at signing, not
> by Move. State this plainly in all external material.**

### PTB-only entry functions (NOT composable from Move)

```move
entry fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo, clock: &Clock, ctx: &mut TxContext)
entry fun hashi::deposit::confirm_deposit(hashi: &mut Hashi, request_id: address, clock: &Clock, ctx: &mut TxContext)
// PERMISSIONLESS; mints Coin<BTC> to the recipient encoded in the UTXO's derivation path
```

Both are `visibility=Private, isEntry=true` on-chain `[D2]` — callable from a **PTB command**, but
not from another Move module.

### ⚠ Config and queue accessors are NOT callable

| Fn | Real visibility | Consequence |
|---|---|---|
| `hashi::btc_config::bitcoin_withdrawal_minimum()` and **all 15** accessors | **`public(package)`** | **Not callable from `aphotic`.** Inject `30_000` and friends as constants/parameters. |
| **All 46** `hashi::withdrawal_queue` getters (only `output_utxo` is `Public`) | **`public(package)`** | **There is NO on-chain Move read of queue depth or limiter state.** `WithdrawalRequestQueue` is a `store` field on `BitcoinState`, itself a dynamic field on `Hashi`, with no public reader. ⇒ `oracle::QueueObservation` is **keeper-attested**: a CLAIM, not a read. Every consumer must treat it as adversarial input, and the constructor is where the internal-consistency checks a lie must survive are enforced. The claim is independently falsifiable off-chain against the public queue object, which is why attestation is acceptable here and would **not** be acceptable for custody. |

### The read surface (off-chain — this is the leak Aphotic routes around)

| Source | Path | Use |
|---|---|---|
| `BitcoinState` | dynamic field on `Hashi`, key `BitcoinStateKey{}` | root of all reads |
| **`WithdrawalRequestQueue.requests`** | `BitcoinState.withdrawal_queue` | **live queue depth and age distribution — every pending request publicly exposes `sender`, `btc_amount`, `bitcoin_address`, `created_timestamp_ms`** |
| `.withdrawal_txns` / `.confirmed_txns` | same | batch history → latency-model calibration |
| `UtxoPool.utxos` | `BitcoinState.utxo_pool` | reserves and fragmentation → next-batch cost |
| `Treasury` | `hashi::treasury` | hBTC supply → coverage ratio |
| `user_requests: Table<address, Bag>` | `BitcoinState` | our own requests, indexed by custody address |
| `CommitteeSet.pending_epoch_change` | `hashi::committee_set` | reconfiguration → predictable pause |
| `WithdrawalSigned` event | — | reconstruct the Guardian token bucket client-side |

### Facts that matter for modelling

- **Coin selection has no age criterion** — inputs are selected largest-first, then consolidated
  smallest-first. Nothing rotates mid-sized UTXOs.
- **Committee weight mirrors Sui consensus voting power** (`active_validator_voting_powers()`).
  Total voting power 10 000, quorum 6 667, per-validator cap
  `min(10000, max(1000, ceil(10000/n)))` = 10 % while n ≥ 10 ⇒ **protocol floor 7 colluding
  validators; live testnet today 32** `[V2 D10]`. Certificate threshold is 6 667 bps
  (`hashi::threshold::CERTIFICATE_THRESHOLD_BPS`).
- **Fee bumping is CPFP, not RBF.** Stuck batches are bumped by spending the change UTXO or a
  recipient output.
- **Withdrawals pause during reconfiguration**, triggered at each Sui epoch boundary (24 h). The
  keeper must **not crash across that window**.
- `crates/hashi/src/utxo_pool/sim.rs` upstream is a 1 442-line pool simulator — the way to
  calibrate the latency model without waiting for mainnet data.

---

## Hashi on-chain config (live, read from the shared object)
<a id="hashi-onchain-config"></a><a id="hashi-config"></a>

Anchor: `#hashi-onchain-config`

Read from `Hashi.config` (`0x22c0ce66…4528f8`) on 2026-07-25. `[D1] [D6] [R6]`

| Key | Value | Note |
|---|---|---|
| `paused` | `false` | |
| `bitcoin_deposit_minimum` | `30_000` sats | dust floor 546 |
| `bitcoin_withdrawal_minimum` | **`30_000` sats** | `EBelowMinimumWithdrawal`; getter NOT callable — inject the constant |
| `bitcoin_deposit_time_delay_ms` | `600_000` (10 min) | mandatory delay before `confirm_deposit` can mint |
| `bitcoin_confirmation_threshold` | `6` | BTC confirmations before committee approval |
| `withdrawal_cancellation_cooldown_ms` | `3_600_000` (1 h) | `ECooldownNotElapsed` |
| `mpc_threshold_in_basis_points` | `3334` | |
| `mpc_max_faulty_in_basis_points` | `3333` | |
| `governance_emergency_pause_threshold_bps` | `500` (5 %) | asymmetric: cheap to pause |
| `governance_emergency_unpause_threshold_bps` | `6667` (⅔) | expensive to resume |
| `guardian_url` | `https://guardian.testnet.hashi.sui.io` | **HTTP/2 only** |
| `guardian_btc_public_key` | `41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995` | x-only, 32 B |
| `bitcoin_chain_id` | `0xf61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000` | **standard signet genesis** |
| `committee_set.mpc_public_key` | `391d3d8e…3d1d39` (33 B, **arkworks encoding**) | must be run through `arkworksToSec1Compressed` before use `[D6]` |
| `committee_set.epoch` | `1171` | 19 committees / 84 members |

`worst_case_network_fee = bitcoin_withdrawal_minimum − 546` = **29 454 sats** at these defaults.

The bridge is **live with real traffic** — deposits ≈ 30 000 sats, withdrawals completing
Requested→Confirmed in ≈ 58 min on a quiet signet. `[D10e]`

---

## Latencies
<a id="latencies"></a>

Anchor: `#latencies`

Bitcoin side = **signet** (block target ~10 min).

| Flow | Planning figure | Steps |
|---|---|---|
| **Deposit** | **~70+ min** | BTC to the derived P2TR address (min 30 000 sats) → `deposit` registration → committee `approve_deposit` after **6 confirmations** *and* **sanctions screening** → **mandatory 10-min delay** → permissionless `confirm_deposit` mints |
| **Withdrawal** | **~1.5–2 h** (plan for 2) | `request_withdrawal` (instant on Sui) → batch (~10 min or threshold) → Guardian + MPC threshold-Schnorr sign → broadcast → confirmed after 6 confirmations |

Measured, one real 1 000 000-sat withdrawal on 2026-07-24 `[D10e]` — informative, **not** a promise:
`WithdrawalApproved` +10 s · `WithdrawalPickedForProcessing` +5.1 min · `WithdrawalSigned` +5.4 min ·
`WithdrawalConfirmed` **+57.9 min**.

Keep the conservative planning figures; one quiet-signet sample is not a distribution. **G1 is
unaffected either way — 58 min is still far outside a 3-minute demo.**

Ordering is committee-leader-discretionary, "generally FIFO, not strict". **You cannot buy
priority.**

---

## Guardian limiter
<a id="guardian-limiter"></a><a id="limiter"></a>

Anchor: `#guardian-limiter`

| Property | Value |
|---|---|
| Shape | a SINGLE GLOBAL token bucket `{refill_rate: sats/second, max_bucket_capacity: sats}` |
| **Time base** | **UNIX SECONDS.** `refill_rate` is sats/**second**, `last_updated_at` is **seconds**. Sui `Clock` is ms ⇒ **floor ms→s at the boundary.** `[D4] [D10d] [R9]` |
| Location | the OFF-CHAIN Rust Guardian enclave (`LocalLimiter`). On-chain Move has **no** limiter state |
| Advancement | advanced purely by on-chain `WithdrawalSigned` events |
| Trustless replay | the entire bucket trajectory is replayable from the on-chain event stream; `oracle.move` is the Move twin and `keeper/src/hashi/limiter.ts` the TypeScript one |
| Over-capacity | batches are **REJECTED** (`RateLimitExceeded`), **not queued** |
| Read endpoint | `GET {guardian_url}/info` — **HTTP/2 only**. Returns the RAW last-consume state; it does **not** project. The caller runs `project_capacity` itself |

### Exact algorithm `[R9]`

```rust
fn project_capacity(cfg, state, ts_secs) -> u64 {
    let elapsed  = ts_secs.saturating_sub(state.last_updated_at);
    let refilled = elapsed.saturating_mul(cfg.refill_rate);
    state.num_tokens_available.saturating_add(refilled).min(cfg.max_bucket_capacity)
}

fn consume(seq, ts, amount) {
    if seq != state.next_seq         { return InvalidInputs }
    if ts  <  state.last_updated_at  { return InvalidInputs }
    let capacity = project_capacity(cfg, state, ts);
    if capacity < amount             { return RateLimitExceeded }   // REJECTED, never queued
    state.num_tokens_available = capacity - amount;                 // clamp BEFORE debit
    state.last_updated_at      = ts;
    state.next_seq            += 1;
}
```

Genesis = `{ num_tokens_available: max_bucket_capacity, last_updated_at: 0, next_seq: 0 }`.

- **Move** must emulate saturating arithmetic explicitly — `u64` add/mul **abort** on overflow;
  widen to `u128` before the `min`.
- **TypeScript** must use `bigint` throughout — a 100 BTC bucket × large elapsed blows past
  `Number.MAX_SAFE_INTEGER`.
- There must be exactly **one** implementation per language (G7).

### LIVE testnet scalars (2026-07-25) `[D4]`

| Scalar | Value | Derived |
|---|---|---|
| `refill_rate` | **`115_740` sats/s** | `9_999_936_000` sats/day ≈ **99.99936 BTC/day** |
| `max_bucket_capacity` | **`10_000_000_000` sats** | **100 BTC** |
| observed `num_tokens_available` | `7_043_037_994` sats (≈ 70.43 BTC) | at `lastUpdatedAtSecs = 1784934423` |
| observed `next_seq` | `556` | |

> **Do not oversell congestion.** The bucket is a **100 BTC bucket refilling a full bucket per
> day**. An Aphotic-sized exit will essentially never be rate-limited on testnet. The earlier
> "1000 sats/s / 1 BTC" prior was wrong by ~100× and is deleted. The limiter stays in the design as
> an honest **risk input** and as the substrate for the *verifiability* claim — not as a scarcity
> story.
>
> ⚠ `move/sources/oracle.move`'s `@facts` block still records the old `1_000` / `100_000_000`
> prior, correctly labelled *"a BOUND, not a fact"* and never hardcoded in logic (it is passed as
> arguments). Where a **number** is needed, use the live scalars above. Tracked as **B15**.

### Golden vectors — shared across the Move and TypeScript twins

| # | State / call | Expect |
|---|---|---|
| 1 | `tokens 100_000, refill 10, last 0, cap 2_000_000` → capacity at `t=15` | **`100_150`** |
| 2 | same → capacity at `t = u64::MAX` | `2_000_000` (saturates, no abort) |
| 3 | `tokens 100_000, refill 0, last 0, next_seq 42` → `consume(42, 100, 80_000)` | ok → `{20_000, 100, 43}` |
| 4 | `tokens 10_000, refill 0, last 0, next_seq 7` → `consume(7, 10, 80_000)` | `RateLimitExceeded` |
| 5 | genesis, `cfg{1000, 2_000_000}` → `consume(1, 0, 0)` | `InvalidInputs` (seq) |
| 6 | after `consume(0, 100, 1000)` → `consume(1, 50, 1000)` | `InvalidInputs` (timestamp) |
| 7 | ms→s flooring: `elapsedMs = 15_999` on `tokens 100_000, refill 10, cap 2_000_000` | **`100_150n`** — floors to 15 s, not 16 |
| 8 | `estimateWaitSecs(cfg{10, 2_000_000}, {100_000, 0}, 200_000, 0)` | `10_000` s (ceil-div) |
| 9 | `estimateWaitSecs(cfg, state, amount > max_bucket_capacity, t)` | `null` — never satisfiable in one withdrawal |

> **Errata status.** `docs/DESIGN-V2.md` D12 lists "RECON R9 rows #1 and #7 print `105_000`" as an
> outstanding doc bug. **It is already fixed.** `docs/RECON.md` R9 now prints `100_150` in both
> rows and carries a labelled ERRATUM note at `RECON.md:150` explaining the correction. Rows #2–#6
> were always correct. **No further edit to RECON is needed or permitted.**

---

## npm packages
<a id="sdk"></a><a id="hashi-sdk"></a>

Anchor: `#sdk`

`@mysten/sui 2.22.1` · `@mysten/hashi 0.6.0` (peer `@mysten/sui ^2.22.1`) · `@mysten/deepbook-v3 1.5.9` ·
`@mysten/seal 1.3.4` · `@mysten/walrus 1.2.9` · `@mysten/dapp-kit 1.1.9` · `@mysten/enoki 1.2.7`.
All ESM. `[R12]`

### `@mysten/hashi@0.6.0` — the ACTUAL exported surface

```
AmountBelowMinimumError · HashiClient · HashiConfigError · HashiFetchError · HashiGuardianError
HashiPausedError · InvalidBitcoinAddressError · InvalidParamsError · arkworksToSec1Compressed
bitcoinAddressToWitnessProgram · deriveChildPubkey · estimateWaitSecs · fetchGuardianInfo
generateDepositAddress · hashi · projectCapacity · twoOfTwoTaprootScriptPathAddress
witnessProgramToAddress
```

| Symbol | Real signature / gotcha |
|---|---|
| `generateDepositAddress` | `({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network })` — **pure, offline, no RPC**. `suiAddress` is a **32-byte `Uint8Array`**, not a hex string. `mpcMasterCompressed` must be `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)`; raw arkworks bytes throw `bad point`. `network: 'signet'`. `[D6]` |
| `arkworksToSec1Compressed` | the mandatory bridge between the on-chain encoding and secp256k1 |
| `witnessProgramToAddress` / `bitcoinAddressToWitnessProgram` | **both take `network` as an argument**; omitting it throws `wrong-network`. 20 B → P2WPKH `tb1q…`, 32 B → P2TR `tb1p…` |
| `projectCapacity(config, state, timestampSecs)` | **ABSOLUTE seconds**, bigint |
| `estimateWaitSecs(config, state, amountSats, nowSecs)` | `0n` if available now, `null` if unsatisfiable |
| `fetchGuardianInfo(origin)` | **fails on Node (HTTP 464)** — uses global `fetch` (HTTP/1.1). **Do not call it; wrap `node:http2` yourself.** `[D4]` |
| `HashiClient` / `hashi()` | client extension, `client.$extend(hashi())` |

> **There is NO `guardian.limiterStatus`, no `guardian.canWithdraw`, no `view.*`, no `waitForDeposit`
> / `waitForWithdrawal`, and no top-level `deposit` / `requestWithdrawal` / `cancelWithdrawal`
> helper** in v0.6.0. Any spec text naming them describes an API that does not exist. Those flows
> are built on `HashiClient` + raw `moveCall`s + event polling **behind our own adapter** — which is
> exactly why the adapter exists (G7).

---

## Events
<a id="events"></a><a id="hashi-events"></a>

Anchor: `#events`

Real, on-chain-observed type strings. Let
`P = 0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360`. `[D10a] [R8]`

| Module | Event | `parsedJson` fields |
|---|---|---|
| `withdrawal_queue` | `WithdrawalRequested` | `bitcoin_address` (vec u8, 20\|32) · **`btc_amount`** · `request_id` · `requester_address` · `sui_tx_digest` · `timestamp_ms` |
| | `WithdrawalApproved` | `request_id` |
| | `WithdrawalPickedForProcessing` | `change_outputs` · `inputs` · `randomness` · `request_ids` · `timestamp_ms` · `txid` · **`withdrawal_outputs[] {amount, bitcoin_address}`** · `withdrawal_txn_id` |
| | `WithdrawalInputsSigned` | `num_inputs` · `signed_count` · `withdrawal_txn_id` |
| | **`WithdrawalSigned`** | `guardian_signatures` · `request_ids` · `signatures` · `withdrawal_txn_id` |
| | `WithdrawalConfirmed` | `change_utxo_amounts` · `change_utxo_ids` · `request_ids` · `txid` · `withdrawal_txn_id` |
| | `WithdrawalCancelled` · `WithdrawalPresigsReassigned` | not observed in window |
| `deposit` | `DepositRequested` | `amount` · `derivation_path` · `request_id` · `requester_address` · `sui_tx_digest` · `timestamp_ms` · `utxo_id {txid, vout}` |
| | `DepositApproved` | `approval_timestamp_ms` · `cert` · `request_id` · `utxo` |
| | `DepositConfirmed` | `request_id` · `utxo {amount, derivation_path, id{txid,vout}}` |
| | `ExpiredDepositDeleted` | not observed in window |
| `treasury` | `Minted<T>` / `Burned<T>` | `amount` — fully qualified **`P::treasury::Minted<P::btc::BTC>`** |

> The names some older material used (`deposit::Approved`, `withdrawal_queue::Signed`,
> `utxo_pool::UtxoSpent`) **do not exist**. The prefix is part of the identifier. There is no
> `utxo_pool` event family.

### ⚠ Three normalization rules the limiter replay depends on `[D10b] [D10c]`

1. **`WithdrawalSigned` carries NO amount and NO timestamp.** To advance the bucket you must join:
   **sats** = Σ over `request_ids` of `WithdrawalRequested.btc_amount` (use the **requested**
   amount — `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount` is net of the Bitcoin
   network fee, observed `1_000_000` requested vs `998_835` output, and the bucket is debited by the
   requested amount); **timestamp** = the **Sui event envelope**.
2. **The envelope timestamp field is `timestampMs`** (camelCase) and arrives as a decimal
   **string** over JSON-RPC ⇒ `BigInt(e.timestampMs)`, never `parseInt`. Where a struct also has
   `timestamp_ms` the two differ slightly (observed 701 ms apart) — always prefer the envelope.
3. **`treasury::Minted`/`Burned` are GENERIC.** A filter must match the **type argument**; a filter
   on the bare name will not match.

### Aphotic's own events

`aphotic::events` is the package **leaf** and the single emitter. G10: **an event for every
externally-visible state transition** — but note the deliberate exception recorded in
`balance.move`'s banner: **per-fill debits and credits emit nothing.** One event per fill would cap
the batch below the store-entry limit for no verifiability gain, because settlement publishes an
aggregate `BatchSettled` receipt plus the fill Merkle root. **Value crossing the custody boundary —
top up, withdraw — always emits.**

---

## DeepBook — venue reality
<a id="deepbook-venue"></a><a id="deepbook"></a><a id="venue"></a>

Anchor: `#deepbook-venue`

> **Scope note.** The v1 product quoted maker orders on this book. **That product is dead.** This
> section survives only as (a) the evidence behind decision **D2 — do not demo the carry**, and (b)
> the source of `book_mid` for the `approve_nav` price-deviation check. There is no router, no
> maker/IOC split and no `TradeCap` in v2.

### Package ids — use the right one for the right job `[R4] [D3]`

| Role | Id | Version |
|---|---|---|
| **original / type-origin** — every `Pool`/`BalanceManager` **TYPE** resolves against this | `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` | 1 |
| superseded — do not use | `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c` | 17 |
| **current callable** — every `moveCall` TARGET | **`0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24`** | **20** |

### Pool + parameters

| Field | Value |
|---|---|
| `Pool<hBTC, DBUSDC>` | `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` (`initialSharedVersion = 946570339`) |
| tick · lot · min_size | `1_000_000` · `1_000` · `100_000` |
| DBUSDC coin type | `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC` (6 dec) |
| DEEP coin type | `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP` |

### Reading the book — `get_level2_range`, never `mid_price` `[D3a]`

| Call | Behaviour on an empty book |
|---|---|
| `pool::mid_price<B,Q>(&Pool, &Clock): u64` | **ABORTS** `deepbook::book` code `2` = `EEmptyOrderbook` |
| `pool::get_level2_range<B,Q>(&Pool, low, high, is_bid, &Clock)` | **SUCCEEDS**, returns `([], [])` |
| `pool::get_level2_ticks_from_mid` | inherits the mid-price behaviour — avoid |

⇒ **Every book read goes through `get_level2_range`.** The `approve_nav` price-deviation check
must therefore tolerate "no mid exists" as a **defined state**, not an abort.

The hosted indexer `deepbook-indexer.testnet.mystenlabs.com` lists 7 pools and **does not include
hBTC/DBUSDC** `[R10]` — never read the book from the indexer. `@mysten/deepbook-v3`'s
`DeepBookClient` is driven by a bundled registry that will not contain our pool; build raw
`moveCall`s and use the SDK for BCS helpers only. `DBTC_DBUSDC` in the indexer is DeepBook's own
test BTC, **not** hBTC.

⚠ The pinned dep rev is **ahead of deployed v20**: `best_ask_price`, `best_bid_price` and
`place_post_only_limit_order` exist in source but **not on chain**. Calling them compiles and then
fails at publish/link time. `[D3b]`

### Why the carry is not demoable `[V2 D2]`

117 pools in the registry; exactly **one** involves hBTC, and it is **empty on both sides** with
zero volume. `treasury::mint` is `public(package)` (no hBTC) **and** the DBUSDC `TreasuryCap` is
`AddressOwner`, not shared (no quote asset). A two-sided seeder is a hard dependency on inventory we
do not have. **The carry ships as a compiling, tested interface with no execution path.**

---

## Lending — the counterparty is ours
<a id="lending"></a>

Anchor: `#lending`

`[V2 D3]`. **No hBTC lending market exists on Sui testnet.** Suilend, Navi and Scallop have no
testnet deployment at all; AlphaLend's 7 markets are testcoins + SUI; Navi mainnet's 35 pools
contain no Hashi hBTC.

⇒ We deploy the counterparty ourselves: the **second Move package** `aphotic_lending` in `lending/`.
Its module banner carries the honesty disclosure and `disclosure()` returns it as an on-chain
string so the front-end has no excuse to render the APY without it.

| Fact | Value |
|---|---|
| Package / module | `aphotic_lending::lending` (`lending/`) |
| Share coin | `LENDING`, 8 decimals, symbol `aLhBTC` — a genuinely fungible `Coin`, registered via `sui::coin_registry::new_currency_with_otw` (`sui::coin::create_currency` is deprecated in this framework rev) |
| Rate model defaults | base `0` bps · slope1 `400` bps · kink `8_000` bps · slope2 `6_000` bps |
| Index | `INDEX_SCALE = 1e9`; `borrow_index` is `u128` starting at `INDEX_SCALE`; `MS_PER_YEAR = 31_536_000_000` |
| Collateral | **NONE.** Borrowing is permissioned and **uncollateralised** — an admin-set credit line per borrower. `is_collateralised()` returns `false` and `has_liquidations()` returns `false`, on purpose |
| Yield | **real but a claim on borrowers.** `total_assets` grows only when `total_borrows_sats` grows. With zero borrowers, `accrue` provably adds zero |

**What must be said wherever a number from this market appears (G2):** *we deployed and operate this
market; it is not an independent venue; supplier principal is at risk to borrower default.*

**Adapter contract** — what an allowlisted adapter package must expose (`allocate.move` enforces the
pairing `(adapter type A, venue object ID)`, never an address alone):

```move
public fun deposit(venue: &mut V, coin: Coin<BTC>, clock: &Clock, ctx: &mut TxContext): Coin<S>
public fun withdraw(venue: &mut V, shares: Coin<S>, clock: &Clock, ctx: &mut TxContext): Coin<BTC>
public fun convert_to_assets(venue: &V, shares: u64): u64      // share units -> REDEEMABLE sats
```

Shape the adapter to this ERC-4626-ish surface so a mainnet adapter is a **new module, not a
refactor**.

---

## Pyth oracle
<a id="pyth-oracle"></a><a id="oracle"></a><a id="pyth"></a>

Anchor: `#pyth-oracle`

**Pin all versions** — the Pyth DAO auto-upgrades Sui addresses on **2026-08-18**.

| Field | Value |
|---|---|
| Pyth State | `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c` (`initialSharedVersion = 12041355`) |
| Pyth package | `0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837` |
| Wormhole State | `0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790` |
| **BTC/USD feed — TESTNET (BETA). USE THIS.** | **`0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`** · `https://hermes-beta.pyth.network` |
| BTC/USD feed (stable/mainnet — do NOT ship on testnet) | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |

The query `btc/usd` returns **12** feeds on Hermes Beta (TBTC, CBBTC, EBTC, UBTC, WBTC, LBTC, MBTC,
ZBTC, SOLVBTC …). **Match on `attributes.symbol === "Crypto.BTC/USD"` exactly; never fuzzy-match.**
`[D5]`

**There is NO Pyth Move dependency** `[R3]`. Nothing in Move calls Pyth — a price arrives as a
**parameter**. Pyth's Sui contracts are `edition = "legacy"` with a heavy pinned Wormhole dep;
importing them buys nothing and risks the whole build. Add staleness guards
(`now − publishTime > max` ⇒ refuse).

---

## Move dependencies
<a id="move-deps"></a>

Anchor: `#move-deps`

Both upstream packages ship a `Published.toml` with `[published.testnet]`, so the **new** Move
package manager resolves `published-at` / `original-id` automatically. **No `[dep-replacements]`, no
`[addresses]`, no explicit `Sui = {git…}` line, and no `[environments]` block** — sui 1.76.0 rejects
overriding system environments. `[R3]`

| Package | git | subdir | pinned rev |
|---|---|---|---|
| `hashi` | `https://github.com/MystenLabs/hashi.git` | `packages/hashi` | `d9ad6bf440a737a23e0a239d4dfe5a6a51a1de9f` |
| `deepbook` | `https://github.com/MystenLabs/deepbookv3.git` | `packages/deepbook` | `0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb` |

- Hashi `[published.testnet]`: `published-at = original-id = 0xfcea10ca…`, version 1, chain-id `4c78adac`.
- DeepBook `[published.testnet]`: `original-id = 0xfb28c4cb…`, `published-at = 0xd874d241…`, **version 20**.
- Framework rev both upstreams pin: `22f9fc9781732d651e18384c9a8eb1dabddf73a6`.
- **No Pyth, no Seal, no Walrus Move dep** — the only on-chain Seal surface is our own
  `seal_approve`.
- ⚠ `Move.lock` records **Windows backslash subdirs** (**B8**).

---

## Seal / Walrus / zkLogin endpoints
<a id="seal-walrus-zklogin"></a><a id="seal"></a><a id="walrus"></a><a id="zklogin"></a>

Anchor: `#seal-walrus-zklogin`

All three verified live on testnet. `[D8]`

### Seal

| Field | Value |
|---|---|
| Seal package (testnet) | `0xdccbeb87767be2b2346af5575eb139807205e4c23ec53dc616f951fe1d814112` (original-id `0x4614e5da…`, version 6) |
| Independent key server #1 | `0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75` · `https://seal-key-server-testnet-1.mystenlabs.com` |
| Independent key server #2 | `0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8` · `https://seal-key-server-testnet-2.mystenlabs.com` |
| Decentralized (committee) server | `0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98` · aggregator `https://seal-aggregator-testnet.mystenlabs.com` |
| SDK | `@mysten/seal@1.3.4` |

**The full open-mode testnet fleet**, from `MystenLabs/seal` `docs/content/Pricing.mdx` — nine
distinct operators. `browser` is a real cross-origin `fetch`, measured 2026-07-26; **`curl` says
200 for every row**, which is exactly why the column exists.

| Operator | Open-mode URL | KeyServer object id | browser |
|---|---|---|---|
| Mysten Labs (1) | `https://seal-key-server-testnet-1.mystenlabs.com` | `0x73d05d62…9356db75` | ✅ |
| Mysten Labs (2) | `https://seal-key-server-testnet-2.mystenlabs.com` | `0xf5d14a81…591623c8` | ✅ (same operator as #1 — counts once) |
| Ruby Nodes | `https://seal-testnet.api.rubynodes.io` | `0x6068c0ac…6d141da2` | ✅ |
| NodeInfra | `https://open-seal-testnet.nodeinfra.com` | `0x5466b7df…b8131007` | ❌ duplicate `Access-Control-Allow-Origin` |
| Studio Mirai | `https://open.key-server-testnet.seal.mirai.cloud` | `0x164ac3d2…cccf0f2` | ❌ CORS |
| Overclock | `https://seal-testnet-open.overclock.run` | `0x9c949e53…4c434105` | ✅ |
| H2O Nodes | `https://seal-open.sui-testnet.h2o-nodes.com` | `0x39cef09b…774f25a2` | ❌ CORS |
| Triton One | `https://seal.testnet.sui.rpcpool.com` | `0x4cded1ab…b2da4c46` | ✅ |
| Natsai | `https://seal-open-test.natsai.xyz` | `0x3c93ec14…6adc3dad` | ✅ ⚠ its KeyServer object is `AddressOwner`, not `Shared`, unlike the other four; `verifyKeyServers` still passes |
| Mhax.io | `https://seal-testnet-open.suiftly.io` | `0x6a0726a1…c930ba06` | ❌ CORS |

There is **no on-chain registry to enumerate**: the `key_server` module emits no registration
event, and the live KeyServer objects sit under four *different* original package ids
(`0x0f16e84a…`, `0x4614e5da…`, `0x62c79dfe…`, `0xe3d7e7a0…`) because Seal has been republished
several times on testnet. So a type-equality check against one package id will reject valid
servers — check `endsWith('::key_server::KeyServer')`, and treat the doc page as the discovery
mechanism it is.

⚠ `@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`.** Construct
`SealClient({ suiClient, serverConfigs: [{ objectId, weight: 1 }, …], verifyKeyServers })` with
explicit ids. Each server's self-reported `service_id` was cross-checked against its on-chain object
id — the anti-impersonation check passes. **Committee composition rules are in `#seal-identity`.**

### Walrus

| Field | Value |
|---|---|
| Publisher / aggregator (primary) | `https://publisher.walrus-testnet.walrus.space` · `https://aggregator.walrus-testnet.walrus.space` |
| Backups | `https://wal-publisher-testnet.staketab.org` · `https://walrus-testnet-publisher.nodes.guru` · `https://wal-aggregator-testnet.staketab.org` · `https://walrus-testnet-aggregator.nodes.guru` |
| PUT / GET | `PUT {publisher}/v1/blobs?epochs=<N>` · `GET {aggregator}/v1/blobs/{blobId}` |
| SDK | `@mysten/walrus@1.2.9` |

- Blob lifetime is the `epochs` parameter at write time and **defaults to a single epoch if
  omitted** — set it explicitly and long.
- Blob ids are content-derived (self-certifying). Blobs are **public and discoverable** — encrypt
  before upload, always. In v2 Walrus carries the **encrypted order blobs**; `blob_id` exists only
  so a third party can *find* the ciphertext (`#seal-identity`).
- ⚠ A freshly published blob comes back `"certifiedEpoch": null` / `"deletable": true`. Any
  availability predicate demanding certified **and** non-deletable would reject our own fresh blob.

### zkLogin

| Field | Value |
|---|---|
| Prover (prod / dev) | `https://prover.mystenlabs.com/v1` · `https://prover-dev.mystenlabs.com/v1` — both reachable |
| Enoki | `@mysten/enoki@1.2.7` |

zkLogin itself is safe to integrate: **against the market, a zkLogin address is exactly as opaque as
an ed25519 one.** Offer Enoki for retail onboarding and a self-managed path
(`@mysten/sui/zklogin`) for desks with a harder threat model. Sponsored transactions are fine —
orders are encrypted **before** entering the transaction, and sponsorship is the only way to let
someone act without holding SUI. **But Enoki must not be in the Seal committee** (`#seal-identity`).

---

## Networks & faucets
<a id="networks-faucets"></a><a id="deployments"></a><a id="hashi"></a>

Anchor: `#networks-faucets`

Target: **Sui testnet**, Bitcoin side **signet**.

| | Sui testnet |
|---|---|
| Hashi package | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360` (Immutable, v1) |
| `Hashi` shared object | `0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8` (`initialSharedVersion = 805474231`) |
| Frontend / guardian | `https://testnet.hashi.sui.io` · `https://guardian.testnet.hashi.sui.io` (**HTTP/2 only**) |

The Hashi **devnet** ids do not exist on testnet (verified). Mainnet: not deployed.

### Deposit registration — two silent failure modes `[R14]`

1. **Nobody registers your deposit for you.** 20 consecutive `DepositRequested` events gave 20
   distinct senders, and in every one `sender == derivation_path == requester_address`. There is no
   Hashi relayer; each depositor submits their own UTXO. Call chain:
   `hashi::utxo::utxo_id(txid, vout)` → `hashi::utxo::utxo(id, amount, derivation_path)` →
   `entry hashi::deposit::deposit(...)`. `derivation_path` must be the Sui address the deposit
   address was derived from — it is where the hBTC gets minted.
2. **⚠⚠ `utxo_id` takes the txid in Bitcoin's INTERNAL byte order — the REVERSE of what every
   explorer displays.** Passing the displayed order registers a UTXO that does not exist, and
   nothing tells you why: the transaction succeeds and the committee simply never approves it.
   `scripts/register-deposit.ps1` does the reversal for you — always hand it the
   explorer-displayed txid, so there is exactly one place this can be wrong.
3. **Never register against a mempool txid.** Observed live: a faucet batch sat unconfirmed for
   hours, was **replaced** (RBF), and both explorers now 404 the original — amounts and vouts
   changed too. The 6-confirmation gate is not a nicety; it is what makes registration safe.

### Signet faucets

| Faucet | State (2026-07-25) |
|---|---|
| `https://signetfaucet.com` | **THE ONLY WORKING ONE.** Amount field is in **BTC**, range `0.00001`–`0.01`. Captcha, and the page requires a **≥ 30 s pause before submitting** — submit sooner and the payout is silently discarded. |
| `https://signet257.bublina.eu.org/` · `https://alt.signetfaucet.com/` · `https://signetfaucet.bublina.eu.org` | **DEAD** — serve 200 with a "does not work at the moment" body. |

🚨 **Do NOT use Mutinynet** (`faucet.mutinynet.com`). It is a **different chain**: it shares signet's
genesis hash, which makes it look compatible, but block 100 000 hashes differ and it sits at ~3.29 M
blocks against standard signet's ~314 k. Addresses have the identical `tb1p…` form, so nothing would
warn you — coins sent there are on a chain Hashi does not watch.

---

## Conventions (build-time)
<a id="conventions"></a>

Anchor: `#conventions`

| Layer | Convention |
|---|---|
| Move package | `aphotic` (in `move/`), edition `2024.beta`. A **second** package `aphotic_lending` lives in `lending/` |
| Move modules | `caps` · `vault` · `notes` · `balance` · `batch` · `clearing` · `allocate` · `carry` · `oracle` · `events` — ten, and no eleventh without a written decision |
| Move amounts | satoshis, `u64` |
| Move events | an event for **every** externally-visible state transition, emitted through `aphotic::events` — with the documented per-fill exception (`#events`) |
| Move errors | constants named `E<Reason>` |
| Move tests | under **`move/tests/`**, at the package root — not `move/sources/tests/` |
| Keeper | **TypeScript**, ESM, one process (`[V2 D1]`). Money is `bigint`; `number` for sats is forbidden |
| `sdk/` | the single home of clearing, the Merkle tree, the Seal inner id and the limiter. No build step: `"exports": { "./*": "./src/*.ts" }`, consumed via `keeper/tsconfig.json` `paths` and `app/vite.config.ts` `resolve.alias` |
| App | React 19 + Vite |
| Canonical ids | may appear **only** in `move/Move.toml`, `lending/Move.toml`, `keeper/src/config.ts`, `app/src/config.ts` and the `.env.example` files. Everywhere else they arrive as config (G7) |
| Repo shape | `aphotic.md` §5 asks for a top-level `sources/`. **Do not do it** — `move/sources/` is where `Move.toml` resolution, `scripts/gates.ps1`, `scripts/verify-all.ps1` and every `@verify` already point `[V2 §12]` |
| Docs | under `docs/`; cross-reference by exact filename + anchor; every doc starts with a one-line purpose + "Read after: …" |

---

## UNKNOWNS
<a id="unknowns"></a>

Anchor: `#unknowns`

Everything the v1 U1–U9 list covered is resolved and folded into the sections above. These are the
v2 open items. **Do not silently resolve one — record the answer here with its evidence.**

| # | Unknown | Status | Owner / fallback |
|---|---|---|---|
| **U-A** | **The 5 000 000-unit computation cost of `sort_step` / `price_step` at n ∈ {16…512}.** | **OPEN — the tool exists, the measurement does not.** `scripts/measure-clearing.mjs` ran and reported *"NOTHING WAS MEASURED"*: the published package exposes no `clearing` module. | Re-run after `clearing.move` lands **and is published**, then copy the report to `docs/LIMITS.md`. Fallback if `price_step` at 256 exceeds 3 500 000: drop the default to 128 and split into `price_scan_step` + `alloc_step`, both cursor-driven. **The API must already anticipate this.** `[V2 §2]` |
| **U-B** | **Exact Seal Move API for time-lock policies**, and confirmation that a `seal_approve` gating on a timestamp alone is accepted by the key servers. | **OPEN.** The entry shape in `#seal-identity` satisfies every documented key-server constraint, but has not been exercised against a live server. | Verify with a live dry run before the demo. **Never fall back to plaintext.** |
| **U-C** | **Mainnet Seal without Enoki** — decentralized Seal requires an Enoki-issued API key. | **OPEN, not blocking testnet.** | Options (a)/(b)/(c) in `#seal-identity`. Decide before mainnet. `[V2 D5]` |
| **U-D** | **Storage-rebate economics of the denomination ladder** — many small objects have a cost profile that should be measured before the ladder is fixed. | **OPEN.** | Measure alongside U-A. The gas *shape* is known (`#denominations`); the rebate is not. |
| **U-E** | **Live Guardian limiter genesis scalars over time.** Current values read 2026-07-25 (`#guardian-limiter`); they are config, and config can change. | **RESOLVED for today, re-read before the demo.** | `GET {guardian_url}/info` over HTTP/2. Never hardcode in logic — pass as arguments. |
| **U-F** | **Does `confirm_deposit` actually mint to an object id** used as the derivation path? Derivation is proven pure and offline `[D6]`; the mint is not. | **DERIVATION-UNBLOCKED, MINT-UNPROVEN.** | Needs a live deposit. **Do not put it on the demo critical path.** |
| **U-G** | **Groth16 (Phase 4) compatibility is UNVERIFIED.** `sui::groth16` takes bn254/bls12381, VK in Arkworks canonical compressed, public inputs as 32-byte **little-endian** scalars, a **hard cap of 8 public inputs**, and `verify_groth16_proof` returns `bool` — it does **not** abort, so the v1 "deny by abort" habit is wrong there. circom/snarkjs serialization compatibility is untested, and a SNARK-friendly hash means blake2b256 → Poseidon is a **tree migration**. | **OPEN.** | **Gate Phase 4 on a spike, not a plan.** `[V2 D11]` |
| **U-H** | **Two-sided flow.** The auction needs natural buyers; the organic bid comes from participants entering Hashi who would rather not wait 6 confirmations plus the 10-minute mint delay. That flow is real but likely thinner than exit flow. | **OPEN — economic, not technical.** | It is why the **vault ships first**. State it in any external material (`aphotic.md` §13). |
