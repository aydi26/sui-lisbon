# MOVE-PACKAGE.md — the ten modules of package `aphotic`

> Purpose: the build-exact Move 2024 spec for package `aphotic` — the dependency DAG, and per
> module the structs, function surface, events, error constants, invariants and test checklist.
> Read after: `aphotic.md`, `docs/DESIGN-V2.md`, `docs/FACTS.md`, `docs/ARCHITECTURE.md`.
>
> ## ⚠ THIS IS A SPEC, NOT A TRANSCRIPT
>
> **The Move sources are being written by other agents right now.** Seven of the ten modules exist;
> three do not. Where the shipped code and this document disagree, **the code and its passing tests
> win, and this document must be corrected** — not the code. If you find such a disagreement, fix
> the doc in the same change that discovers it, and say so in `docs/STATUS.md`.
>
> The authority order for everything else is: `docs/RECON.md` on facts about the world ·
> `docs/DESIGN-V2.md` on deltas and already-taken decisions · `aphotic.md` + `docs/GOVERNANCE.md`
> on what we are building and why.
>
> **Rewritten 2026-07-26 for the v2 product.** The v1 modules — `gateway`, `router`, `journal`,
> `envelope` and the v1 `vault` — are **deleted**. Nothing in this document refers to them.

---

## 0. Status at a glance — observed 2026-07-26 01:52 local

| Module | File | Phase | Observed |
|---|---|---|---|
| `events` | `move/sources/events.move` | 1 | present, banner `@status DONE` |
| `caps` | `move/sources/caps.move` | 1 | present, banner `@status DONE` |
| `notes` | `move/sources/notes.move` | 3 | present, banner `@status DONE` |
| `balance` | `move/sources/balance.move` | 3 | present, banner `@status DONE` |
| `allocate` | `move/sources/allocate.move` | 1 | present, banner `@status DONE` |
| `oracle` | `move/sources/oracle.move` | 2 | present, banner `@status DONE` |
| `carry` | `move/sources/carry.move` | 2 | present, banner `@status PARTIAL` — **interface only, by design** |
| **`vault`** | `move/sources/vault.move` | 1 | **NOT PRESENT** |
| **`batch`** | `move/sources/batch.move` | 3 | **NOT PRESENT** |
| **`clearing`** | `move/sources/clearing.move` | 3 | **NOT PRESENT** |

`sui move build` exits 0 and `sui move test` reports **122 passed, 0 failed** over the modules that
exist. That is not evidence about the three that do not. `docs/DESIGN-V2.md` §10 targets **≥ 320**
Move tests for the finished package.

A **second** Move package, `aphotic_lending`, lives in `lending/` — our own hBTC lending
counterparty. It is not part of `aphotic` and is specified in §13.

---

## 1. `Move.toml` and the dependency DAG

```toml
[package]
name = "aphotic"
edition = "2024.beta"
license = "Apache-2.0"

[dependencies]
hashi    = { git = "https://github.com/MystenLabs/hashi.git",      subdir = "packages/hashi",    rev = "d9ad6bf440a737a23e0a239d4dfe5a6a51a1de9f" }
deepbook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb" }
```

**Exactly two git dependencies, and nothing else.** No `Sui = {git…}` line, no `[addresses]`, no
`[dep-replacements]`, no Pyth, no Seal, no Walrus, and **no `[environments]` block** — sui 1.76.0
rejects overriding system environments verbatim:
`"Cannot override default environments. Environment `testnet` is a system environment…"`.
Rationale in `docs/FACTS.md#move-deps`. ⚠ `Move.lock` records **Windows backslash subdirs** (B8).

### The DAG — acyclic by construction

```
                      events   (LEAF: imports only sui::event)
                        |
                      caps     (imports events)
                     /  |  \
              notes    balance  vault
                 \      |      /   \
                  \     |     /     \
                   `--- batch ---'    allocate
                          |
                       clearing
```

Independent leaves that import **no** `aphotic` module at all — deliberately, so they can neither
cycle nor be pinned to a venue at compile time:

- **`oracle`** — no imports whatsoever. Not `hashi` (its readers are `public(package)`), not
  `sui::clock` (timestamps arrive as parameters), not Pyth. That is what keeps it liftable and
  replayable.
- **`allocate`** — imports no other `aphotic` module and no lending package.
- **`carry`** — imports nothing; it is a bag of pure predicates.

**Move forbids the cycle**, so a leaf takes primitives and never `&Vault`. If you find yourself
wanting to pass `&Vault` into `oracle` or `carry`, pass the numbers instead.

---

## 2. Package-wide conventions

| Rule | Detail |
|---|---|
| Edition | `2024.beta`. Module declaration is the label form: `module aphotic::vault;` |
| Money | **satoshis, `u64`**, everywhere. hBTC has 8 decimals, so the book's unit and the ladder's unit are the same unit |
| Overflow | `u64` add/mul **abort**. Saturation is emulated **explicitly** (`saturating_add` / `saturating_mul` / `saturating_sub`, all widening to `u128`). Never rely on wrapping |
| Errors | constants named `E<Reason>`. **A vacated error code is never reused** — an old client decoding an abort should find nothing, not a different meaning |
| Events | every externally-visible state transition emits, **through `aphotic::events`**. Documented exception: per-fill debits/credits emit nothing (see §6) |
| Hashing | `sui::hash::blake2b256`, always domain-separated with a 1-byte tag, never inline — every hash goes through a named helper so Phase 4 can swap it |
| Byte order | **LITTLE-ENDIAN** for every `u64` in a hash preimage or a Seal identity, matching BCS. A slip here is silent |
| Floats | **none.** Integer arithmetic only, in clearing and everywhere else |
| Ids | canonical on-chain ids appear only in `Move.toml`; everywhere else they arrive as parameters |
| Tests | `move/tests/*_tests.move`, at the **package root** — not `move/sources/tests/` |
| Banner | every file carries one APHOTIC CONTRACT banner (`docs/CONVENTIONS.md`) immediately after the module declaration |

---

## 3. `events` — the package leaf

**Phase 1 · present · DONE.** Imports `sui::event` and nothing else.

One module owns emission so that (a) the event schema is greppable in one place, and (b) the
ceiling arithmetic is stated once. Its banner carries the three ceilings
(`docs/FACTS.md#ceilings`), because they are what bounds `MAX_BATCH_SIZE`.

Emitters, grouped:

| Group | Functions |
|---|---|
| caps | `emit_caps_initialized` · `emit_admin_transfer_initiated` / `_cancelled` / `_accepted` · `emit_keeper_cap_rotated` · `emit_pause_set` · `emit_allowlist_updated` |
| notes | `emit_denominations_set` · `emit_note_committed` · `emit_note_spent` · `emit_note_minted` · `emit_note_burned` |
| balance | `emit_balance_topped_up` · `emit_balance_withdrawn` |
| vault | `emit_nav_proposed` · `emit_nav_approved` · `emit_deposited` · `emit_redeem_requested` · `emit_redeemed` |
| batch / clearing | `emit_batch_opened` · `emit_order_submitted` · `emit_batch_closed` · `emit_order_revealed` · `emit_clearing_computed` · `emit_batch_settled` · (`emit_filled`, gated on `emit_per_fill`) |
| allocate | `emit_adapter_allowed` / `_updated` / `_removed` · `emit_allocated` · `emit_deallocated` · `emit_marked` |

> **The deliberate omission.** `balance::debit` / `balance::credit` emit **nothing**. One event per
> fill would cap the batch below the 1 000-entry store ceiling for **no verifiability gain**,
> because settlement publishes an aggregate `BatchSettled` receipt plus the fill Merkle root, and
> `verify_fill` proves any individual fill against it. **Value crossing the custody boundary — top
> up, withdraw — always emits.**

---

## 4. `caps` — three capabilities, and no fourth

**Phase 1 · present · DONE.** Imports `aphotic::events`, `sui::vec_set`.

### Structs

```move
public struct AdminCap    has key { id: UID, vault_id: ID, epoch: u64 }        // key ONLY
public struct KeeperCap   has key { id: UID, vault_id: ID, epoch: u64 }        // key ONLY
public struct VaultCap    has store { vault_id: ID }                            // store ONLY
public struct CapRegistry has store { vault_id, admin, keeper, admin_epoch,
                                      keeper_epoch, pending_admin: Option<address>,
                                      paused: bool, allowlist: VecSet<address> }
```

**The ability choices are the enforcement, not a comment.** See
`docs/ARCHITECTURE.md` §3.2 for the table of what each one structurally prevents.

### Function surface

```
new_registry(vault_id, admin, keeper, ctx) -> (CapRegistry, VaultCap)
initiate_admin_transfer(reg, &AdminCap, new_admin)
cancel_admin_transfer(reg, &AdminCap)
accept_admin_transfer(reg, ctx)                 // the INCOMING admin signs. Two-step, unbypassable.
rotate_keeper_cap(reg, &AdminCap, new_keeper, ctx)
set_paused(reg, &AdminCap, paused)
allow_address(reg, &AdminCap, entry) / disallow_address(...)
assert_admin(reg, &AdminCap) / assert_keeper(reg, &KeeperCap)
assert_keeper_action(reg, &KeeperCap, action: u8)     // the ACTION_* allowlist
assert_vault_cap(reg, &VaultCap) / assert_allowed(reg, entry) / is_allowed(reg, entry)
vault_id / admin / keeper / admin_epoch / keeper_epoch / is_paused
```

`KeeperCap` admits an **exhaustive** action list, encoded as `ACTION_*` constants and enforced by
`assert_keeper_action`: `propose_nav` · `attest_limiter` · `allocate` · `deallocate` ·
`place_carry_bid` · `cancel_carry_bid` · `settle_step`. Nothing else.
`MAX_ALLOWLIST = 32` — a governance artefact, not a routing table.

### Pause asymmetry, the part Move can hold

`pause` is one transaction. `unpause` requires `arm_unpause` in an **earlier** transaction plus
`unpause_delay_ms` elapsed. Move cannot read a multisig's threshold, so the signer-count asymmetry
is an off-chain multisig-config property — stated, not pretended.

### Invariants → tests

| Invariant | Test |
|---|---|
| admin transfer requires acceptance | `caps_tests::admin_transfer_requires_acceptance` |
| an old cap is stale after acceptance | `caps_tests::old_admin_cap_is_stale_after_acceptance` |
| rotating invalidates the old keeper cap | `caps_tests::rotated_keeper_cap_invalidates_old` |
| the keeper cannot rotate itself | `caps_tests::keeper_cannot_rotate_itself` |
| **no keeper fn takes an `address`** | `caps_tests::keeper_functions_take_no_address_param` + `gates.ps1 keepercap` |
| unpause needs arming, then the delay | `caps_tests::unpause_without_arming_aborts` · `::unpause_before_delay_aborts` |

---

## 5. `notes` — fixed denominations, a Merkle tree, and nullifiers

**Phase 3 · present · DONE.** Imports `aphotic::caps`, `aphotic::events`, `sui::hash`, `sui::table`.

### Structs

```move
public struct Note has key, store { id: UID, denom_index: u8 }   // AND NOTHING ELSE
public struct DenomLadder   has store { vault_id: ID, denoms_sats: vector<u64>, outstanding: u64 }
public struct NoteTree      has key   { id: UID, vault_id: ID, depth: u8,
                                        filled_subtrees: vector<vector<u8>>,
                                        next_index: u64, roots: vector<vector<u8>> /* ring */ }
public struct NullifierSet  has key   { id: UID, vault_id: ID, used: Table<vector<u8>, bool> }
```

> **`Note` carries no amount field, and that is an invariant with a gate behind it.** A free-form
> `Balance<BTC>` in an order object would publish the size and defeat the entire design.

### Hashing — `docs/FACTS.md#denominations` is canonical

| Hash | Preimage |
|---|---|
| commitment | `blake2b256( 0x01 ‖ denom_index(1) ‖ secret(32) ‖ randomness(32) )` |
| nullifier | `blake2b256( 0x02 ‖ secret(32) ‖ leaf_index(8, **LITTLE-ENDIAN**) )` |
| node | `blake2b256( 0x03 ‖ left(32) ‖ right(32) )` |
| zero leaf | `Z0 = blake2b256( 0x00 )`, `Z[i+1] = H(Z[i], Z[i])` |

Every input is **fixed width**, so concatenation is unambiguous; `secret` and `randomness` are
asserted to be exactly 32 bytes. ⚠ `docs/DESIGN-V2.md` §11 writes a slightly different tag scheme;
**the shipped tags above win** — see the errata note in `docs/FACTS.md#denominations`.

### Ladder

Default `[1_000_000, 10_000_000, 100_000_000, 1_000_000_000]` sats — 0.01 / 0.1 / 1 / 10 hBTC.
`MAX_TIERS = 8`. Denominations are **append-only** (repricing a tier revalues live notes). The
floor sits comfortably above Hashi's 30 000-sat withdrawal minimum, so **every denomination is
individually redeemable**.

### Function surface

```
new_ladder(vault_id) -> DenomLadder            default_denominations() -> vector<u64>
set_denominations(&mut DenomLadder, &NoteTree, &CapRegistry, &AdminCap, denoms_sats)
denom_count / denom_sats / denominations / notes_outstanding
new_tree(vault_id, depth) -> NoteTree          new_nullifier_set(vault_id, ctx) -> NullifierSet
commitment(denom_index, &secret, &randomness) -> vector<u8>
nullifier(&secret, leaf_index) -> vector<u8>
append(&mut NoteTree, commitment) -> u64       // returns leaf_index; 20 hashes, ZERO table entries
verify_membership(&NoteTree, MembershipWitness) -> bool
spend(&mut NullifierSet, &NoteTree, witness, ...)   // ONE table entry
max_spends_per_tx() -> u64                     // 800 — 20% headroom under the 1 000 ceiling
```

**Gas shape.** An append rewrites `filled_subtrees` **inside the object** — zero dynamic-field
entries. A nullifier insert is **one** table entry. 256 spends cost 256 store entries, not 5 120.

**Phase 4 swap.** `MembershipWitness` is the **only** thing a Groth16 tier replaces; the tree, the
commitment format, the nullifier format, `spend`'s signature and the accounting are unchanged.
⚠ Phase 4 compatibility is **unverified** — `docs/FACTS.md#unknowns` U-G. Gate it on a spike.

### Invariants → tests

| Invariant | Test |
|---|---|
| a nullifier is consumed at most once | `notes_tests::nullifier_cannot_be_reused` (`ENullifierUsed`) |
| twice in one transaction still aborts | `notes_tests::same_nullifier_in_one_tx_aborts` |
| `Note` has no amount field | `notes_tests::note_struct_has_no_amount_field` + `gates.ps1 notes` |
| a root older than the ring is rejected | `notes_tests::root_older_than_ring_is_rejected` |

---

## 6. `balance` — the persistent internal balance, and escrow custody

**Phase 3 · present · DONE.** Generic over `T` so the module names no upstream package; the vault
instantiates it with hBTC.

### Why it is a separate balance sheet — `docs/DESIGN-V2.md` **F3 / D7**

If the vault held escrow directly, a batch settlement between `propose_nav` and `approve_nav` would
move vault assets, and the admin would approve a number that is already stale — the auction would
defeat the two-party NAV split. **A separate `BalanceBook` custodies escrow.** The two legs share a
*product* balance sheet, not a *Move* balance. Recorded as a deliberate deviation from
`aphotic-governance.md` Figure 1 in `docs/GOVERNANCE.md` §9 D-G1.

### The conservation identity

A `Table` cannot be iterated, so "note value in the tree equals custodied minus deployed" is not
directly expressible on-chain. The equivalent, O(1), asserted after **every** operation:

```move
assert!(l.total_base + l.note_backed_base == l.base.value(),  EBaseDrift);
assert!(l.total_quote                     == l.quote.value(), EQuoteDrift);
```

### Why there is no `reserve` / `lock` primitive

**This is a design decision, not an omission.** Locking collateral at order-submission time would
publish the order's size — precisely the leak the sealed batch exists to close. An order therefore
**draws** on the persistent balance and reserves nothing. The consequence is explicit and handled:
a participant may top down between submission and clearing, so clearing must treat an under-funded
account as a truncated fill. `has_at_least` exists for exactly that check, and `close_batch`
freezes the snapshot the truncation rule reads.

### Function surface

```
new_book<T>(vault_id, ctx) -> BalanceBook<T>
top_up<T>(&mut book, Coin<T>, &TxContext) -> u64        top_up_for<T>(&mut book, Coin<T>, who) -> u64
withdraw<T>(&mut book, amount_sats, ctx) -> Coin<T>
debit<T>(&mut book, &VaultCap, who, amount_sats)        credit<T>(...)
transfer_internal<T>(&mut book, &VaultCap, from, to, amount_sats)
balance_of / has_at_least / has_account / total_credited / custody_value / accounts_opened
```

`debit` / `credit` / `transfer_internal` require the `VaultCap` — which no address can hold, because
it is `store`-only and lives inside the vault. Only the package's own settlement path can reach
them.

### Invariants → tests

| Invariant | Test |
|---|---|
| conservation holds after every operation | `balance_tests::conservation_holds_after_every_op` |
| across a full lifecycle | `scenario_tests::conservation_across_deposit_spend_trade_withdraw` (MS) |
| a top-up/withdraw always emits; a debit/credit never does | `balance_tests::*` |

---

## 7. `allocate` — the pinned adapter allowlist

**Phase 1 · present · DONE.** A leaf: imports no other `aphotic` module and no lending package, so
it can neither cycle nor pin a venue at compile time.

**An adapter is identified by a PAIR, never by an address alone:** `(adapter type A, venue object
ID)`. `A` is a phantom marker type published by the adapter package; the ID is the shared venue
object it drives. **Both** must match an allowlist row or the route aborts — so the same adapter
type at another venue is *not* allowed (`allocate_tests::the_same_type_at_another_venue_is_not_allowed`).

⚠ `std::type_name::get` is **deprecated** in this framework rev — use
`type_name::with_defining_ids<A>()`.

### The adapter contract (what an allowlisted package must expose)

```move
public fun deposit(venue: &mut V, coin: Coin<BTC>, clock: &Clock, ctx: &mut TxContext): Coin<S>
public fun withdraw(venue: &mut V, shares: Coin<S>, clock: &Clock, ctx: &mut TxContext): Coin<BTC>
public fun convert_to_assets(venue: &V, shares: u64): u64      // share units -> REDEEMABLE sats
```

Shape it to this ERC-4626-ish surface so a mainnet adapter is a **new module, not a refactor**.

### Function surface

```
create(ctx) · new(ctx) -> (AdapterRegistry, AdapterAdminCap) · share(registry)
-- governance (AdminCap only) --
allow_adapter<A>(&cap, &mut reg, venue: ID, label, cap_sats, &Clock)
set_adapter_cap<A> · set_adapter_enabled<A> · remove_adapter<A> · set_paused
-- routing (public(package); the vault gates these on KeeperCap) --
begin_deposit<A>(reg, venue, sats) -> DepositTicket
... settle the ticket, mark(...) -- the ONLY way yield enters the book
```

**Recall is never gated by pause or by disabling an adapter.** Lowering a cap blocks new deployment
**without trapping capital** (`allocate_tests::lowering_the_cap_blocks_deployment_without_trapping_capital`,
`::recall_is_never_gated_by_pause_or_disable`).

### Invariants → tests

`allocate_tests` (present, green) covers: unlisted adapter aborts · over-cap aborts · the cap check
cannot be overflowed · marking an unlisted pair aborts · removing a funded adapter aborts ·
enumeration mirrors the allowlist · totals aggregate across venues · the value floor aborts on a
loss and accepts break-even.

---

## 8. `oracle` — the limiter replay and a wait-time distribution

**Phase 2 · present · DONE.** The intra-package leaf: **no imports at all** — not `hashi`, not
`sui::clock`, not Pyth. It computes; it holds no state, touches no coin and calls nothing.

Three pieces, in dependency order:

1. **A byte-exact replay of the Guardian token-bucket limiter** (`docs/FACTS.md#guardian-limiter`).
   Time base is **UNIX SECONDS**; Sui `Clock` is ms ⇒ **floor ms→s at the boundary**. Saturation is
   emulated explicitly, widening to `u128`.
2. **An attested snapshot of the Hashi withdrawal queue** — depth **and** age distribution.
3. **A wait-time DISTRIBUTION**, never a point estimate. `MAX_U64` doubles as the `unbounded_ms()`
   sentinel: a quantile that lands in the open tail has no upper bound, and **saying "unbounded" is
   the honest answer, not a large number**.

> ### ⚠⚠ `QueueObservation` is a CLAIM, not a read
>
> RECON R7.2: **all 46** `hashi::withdrawal_queue` getters and **all 15** `btc_config` accessors are
> `public(package)`. `WithdrawalRequestQueue` is a `store` field on `BitcoinState`, itself a dynamic
> field on `Hashi`, with no public reader. **No on-chain Move read of queue depth is possible.**
>
> So the observation is **keeper-attested**. Every consumer must treat it as adversarial input, and
> the constructor is where the internal-consistency checks a lie must survive are enforced. This is
> acceptable **only** because the claim is independently falsifiable off-chain against the public
> queue object — and it would **not** be acceptable for custody.

`AGE_BUCKET_COUNT = 6`, upper edges in ms: `600_000` (10 min) · `1_800_000` · `3_600_000` ·
`7_200_000` · `21_600_000` · OPEN. Chosen against the Hashi cadence: batching ~10 min,
reconfiguration every Sui epoch (24 h), cancellation cooldown 3 600 000 ms.
`BPS_DENOMINATOR = 10_000`, `MS_PER_YEAR = 31_536_000_000`.

⚠ **B15.** The banner's limiter prior (`refill_rate = 1_000`, `max_bucket_capacity = 100_000_000`)
is labelled *"a BOUND, not a fact"* and is never hardcoded in logic — values arrive as arguments.
The **live** scalars are `115_740` sats/s and `10_000_000_000` sats
(`docs/FACTS.md#guardian-limiter`). Where a number is needed, use the live ones.

### Golden vectors

The nine rows in `docs/FACTS.md#guardian-limiter` are shared between `oracle_tests.move` and the
TypeScript twin. Rows #1 and #7 are **`100_150`** — `docs/RECON.md` R9 already prints that and
carries a labelled erratum note; the "105 000" listed in `docs/DESIGN-V2.md` D12 is **already
fixed**.

---

## 9. `carry` — interface only, on purpose

**Phase 2 · present · PARTIAL, by design.** A leaf; imports nothing.

The three pure predicates that guard the leg are **real and tested**:

```move
new_carry_params(hurdle_bps, max_notional_sats, min_exit_sats, pinned_btc_address) -> CarryParams
hurdle_bps / max_notional_sats / min_exit_sats / pinned_btc_address(&CarryParams)
assert_value_preserved(consumed_sats, returned_hbtc_equivalent_sats)
```

**There is deliberately no execution path.** Nothing in the module touches DeepBook, Hashi, a
`Balance<BTC>` or any shared object. Three independent reasons, each sufficient:

1. `aphotic.md` §11 says so verbatim — *"Do not attempt Phase 2 in that window — the multisig and
   the latency model are where the time goes."*
2. `docs/RECON.md` R10: the `Pool<hBTC,DBUSDC>` book is **empty on both sides**, testnet volume is
   zero, and `pool::mid_price` aborts `EEmptyOrderbook`. The entry leg buys hBTC below par — there
   is nothing to buy and no observable price to buy it at. A carry wired against a book with no mid
   is not an implementation; it is an untested branch.
3. `request_withdrawal` sets `sender: ctx.sender()` — the **transaction signer**, never the calling
   module — so the exit leg cannot be composed from a shared object at all. It requires the 2-of-2
   custody multisig to sign, and no amount of Move code changes that.

Constants recorded so a Phase-2 implementer does not re-derive: `BPS_DENOMINATOR = 10_000` ("par"
is 10 000 bps) · `HASHI_WITHDRAWAL_MIN_SATS = 30_000`, injected as a parameter and never read from
the bridge (its getter is `public(package)`) · exit address length ∈ {20 P2WPKH, 32 P2TR}, asserted
here so a bad pin is rejected at configuration time · `WITHDRAWAL_CANCELLATION_COOLDOWN_MS =
3_600_000`.

---

## 10. `vault` — **NOT WRITTEN YET**

**Phase 1 · the async request/settle vault.** Specified by `aphotic.md` §7.7 / §10, and by
`docs/DESIGN-V2.md` §6 for `approve_nav`, which is the part with a trap in it.

### Structs (target)

```move
public struct Vault<phantom B, phantom Q> has key {
    id: UID,
    caps: CapRegistry,            // by value
    vault_cap: VaultCap,          // by value — no address can ever hold it
    base:  Balance<B>,            // idle hBTC
    quote: Balance<Q>,            // idle USDC
    lp_treasury: TreasuryCap<APHOTIC_LP>,
    epoch: u64,
    epoch_prices: Table<u64, EpochPrice>,
    pending_deposit_assets: u64,
    pending_redeem_shares:  u64,
    committed_supply: u64,        // THE solvency denominator
    unminted_shares:  u64,
    proposal: Option<NavProposal>,
    fees_accrued: u64,
    // governed bounds
    max_nav_jump_bps, max_price_dev_bps, max_proposal_age_ms, unpause_delay_ms, fee_matched_bps,
}

public struct EpochPrice   has store, copy, drop { nav_assets: u64, nav_supply: u64, at_ms: u64 }
public struct NavProposal  has store, copy, drop { nav_assets, nav_supply, native_btc_sats,
                                                   hashi_pending_sats, clearing_price, book_mid,
                                                   proposed_ms }
public struct DepositReceipt has key, store { id: UID, vault_id: ID, epoch: u64, assets: u64 }
public struct RedeemReceipt  has key, store { id: UID, vault_id: ID, epoch: u64, shares: u64 }
```

**Shares are a fungible `Coin<APHOTIC_LP>`, not a position object** — fungible shares stay
composable and listable; a bespoke position object traps the liquidity (`aphotic.md` §8).

### `approve_nav` — the O(1) form, in order

It must **not** iterate requests; `object_runtime_max_num_store_entries = 1000` makes any
per-request loop a liveness bug waiting to happen.

```
1. digest check: blake2b256(bcs(proposal)) == expected_digest      -> EDigestMismatch
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

Step 1 is why a keeper cannot swap the proposal in a race: **the admin multisig signs the exact
numbers**. Step 5 is the H4 cap — the unverifiable native-BTC leg can never exceed the on-Sui claim
behind it. Step 4 must tolerate "no mid exists" as a defined state, because the book is empty
(`docs/FACTS.md#deepbook-venue`).

### Solvency

```move
assert!(mul_div_u128(supply, last_nav_assets, last_nav_supply) <= (assets as u128), ESolvency);
assert!(coin::total_supply(&lp_treasury) + unminted_shares == committed_supply, ESupplyDrift);
```

**`committed_supply`, not `coin::total_supply`.** `total_supply` undercounts owed-but-unminted
shares and would let an over-mint pass.

`claim_deposit` recomputes the **same** `mul_div` per receipt. Round-down is subadditive, so
`Σ per-receipt ≤ epoch total` always — the dust stays with the vault, never with a claimant.

### Function surface (target)

```
-- permissionless --
request_deposit / request_redeem / claim_deposit / claim_redeem
-- keeper (KeeperCap) --   NO `address` PARAMETER ON ANY OF THESE
propose_nav(...) · attest_limiter(...)
-- admin (AdminCap) --
approve_nav(expected_digest) · set_fees · set_cadence · set_bounds · pause · arm_unpause · unpause
-- reads --
nav_of_epoch / committed_supply / assert_solvent / fees_accrued
```

**A paused vault still lets holders leave.** `request_redeem` and `claim_redeem` do **not** call
`assert_not_paused`.

### Invariants → tests (`docs/DESIGN-V2.md` §10)

`vault_tests::nav_jump_beyond_bound_aborts` · `::clearing_price_deviation_aborts` ·
`::native_btc_leg_capped_by_onsui_claims` · `::solvency_holds_after_every_mutation` (all 8
mutators) · `::nav_rounding_never_over_mints` · `::keeper_cannot_approve_nav` ·
`::admin_cannot_propose_nav` · `::approve_with_wrong_digest_aborts` · `::stale_proposal_aborts` ·
`::redeem_and_claim_work_while_paused` · `::keeper_cannot_reach_lp_treasury` ·
`scenario_tests::solvency_across_full_epoch` (5 users, request→approve→claim).

---

## 11. `batch` — **NOT WRITTEN YET**

**Phase 3 · the window, the state machine, and `seal_approve`.**

### The state machine

```
OPEN ──close_batch()──▶ SEALED ──reveals──▶ CLEARING ──settle_step()*──▶ SETTLED
```

Transitions are **monotonic**; no path returns to `OPEN`. Enforce it with a gate as well as a test:
`gates.ps1 batchstate` — `\.state\s*=` may appear only in `set_state` / `open_batch`.

### Timing is mechanical

```move
public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64 {
    let since = oracle::saturating_sub(now_ms, offset_ms);
    let periods = since / cadence_ms;
    offset_ms + oracle::saturating_mul(periods + 1, cadence_ms)
}
```

`cadence_ms = 43_200_000`, `offset_ms = 21_600_000` → **06:00 and 18:00 UTC**. `open_batch` takes
**no timestamp parameter**; `close_ms` is derived. `close_batch` checks the on-chain `Clock` and the
boundary is `>=`. `SUBMIT_CUTOFF_MS = 60_000`, `REVEAL_GRACE_MS = 600_000`. **A full batch does not
close early** — it rejects submits and still closes on the boundary, because closing on fullness
would hand a spammer exactly the timing lever uniform-price clearing exists to remove.

The same function lives in `sdk/src/cadence.ts` with shared golden vectors.

### `seal_approve` — copy this exactly

The inner id is 48 bytes; the full IBE identity is `bytes(packageId) ‖ inner` and `seal_approve`
receives **only `inner`**:

```
[ 0..8 )  bcs u64      close_ms         LITTLE-ENDIAN
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
    (leftovers.length() == 0) && (ver == r.policy_version) && (c.timestamp_ms() >= t)
}

/// Non-`public` `entry`. Deny by ABORT, never by return value.
/// No mutation, no event, NO SENDER CHECK.
entry fun seal_approve(id: vector<u8>, r: &BatchRegistry, c: &clock::Clock) {
    assert!(check_policy(id, r, c), ENoAccess);
}
```

> **⚠⚠ Two traps, both silent, both already in this repo's history.**
>
> **F1 — endianness.** `bcs::peel_u64` reads **little-endian**. The deleted v1 `vault.move`
> decoded the epoch **big-endian**, and `keeper/src/privacy/seal.ts` documented it that way.
> Copying either here produces a policy that **never opens**, and it fails silently: the key server
> declines and the batch never reveals. One file owns the encoding (`sdk/src/seal/identity.ts`) and
> a golden vector pins it in **both** languages.
>
> **F2 — no sender check.** The v1 vault asserted `sender == owner || sender == keeper`. A batch
> time-lock must be satisfiable by **anyone** after `T`. That is exactly what makes reveal
> permissionless and kills grief-by-non-revelation — the failure mode that sank commit–reveal.

### Commitments bind the PLAINTEXT

`commitment = blake2b256(bcs(Order))`. If only `ct_hash` were binding, a submitter could publish one
ciphertext and later claim a different plaintext decrypted from it. Binding to the plaintext closes
that and does **not** reintroduce commit–reveal's grief problem, because after `close_ms` anyone can
fetch the Seal shares and produce the reveal. `ct_hash` and `blob_id` exist only so a third party
can *find* the ciphertext.

### Structs (target)

```move
public struct BatchRegistry has key { id: UID, vault_id: ID, policy_version: u64,
                                      cadence_ms: u64, offset_ms: u64,
                                      max_batch_size: u64, emit_per_fill: bool }
public struct SealedOrder has store { submitter: address, commitment: vector<u8>,
                                      ct_hash: vector<u8>, blob_id: vector<u8> }
                                      // NO amount. NO side. NO price. NO margin field.
public struct Batch has key { id: UID, vault_id: ID, batch_id: u64, state: u8, close_ms: u64,
                              orders: vector<SealedOrder>, revealed: vector<Order>,
                              perm: vector<u64>, sort_cursor: u64, settle_cursor: u64,
                              fills_root: vector<u8>, clearing_price: u64 }
```

`MAX_BATCH_SIZE` is **governed, default 256**; `HARD_MAX_BATCH_SIZE = 512` asserted in the setter.
See `docs/FACTS.md#ceilings` for why, and note that `emit_per_fill = false` is the escape hatch that
makes the 1 024-event wall unable to brick a batch.

### Invariants → tests

`batch_tests::close_before_schedule_aborts` (`ETooEarly`) · `::close_at_exactly_close_ms_succeeds` ·
`::reveal_while_open_aborts` (`EBadState`) · `::open_batch_stores_no_plaintext` ·
`::state_transitions_are_monotonic` (all 16 pairs) · `::close_ms_is_derived_not_supplied` ·
`::next_boundary_golden` · `::batch_full_rejects_submit_but_does_not_close` ·
**`::seal_approve_little_endian_golden`** (the LE id opens, the **BE** encoding of the same
timestamp **aborts**) · `::seal_approve_rejects_trailing_bytes` ·
`::seal_approve_rejects_wrong_policy_version` · `::policy_bump_with_live_batch_aborts`.

---

## 12. `clearing` — **NOT WRITTEN YET**

**Phase 3 · uniform-price match, resumable settlement, and the parity surface.**

The algorithm is specified once, in `docs/FACTS.md#clearing`, because it must be **bit-identical**
in Move and TypeScript. Do not restate it in code comments — cite the anchor. The six rules are:
canonical order (ties fully broken) → candidate prices (max volume, tie-break `|demand − supply|`,
tie-break lowest `p`) → allocation (inside fills fully; at `p*` pro-rata with largest-remainder
distribution) → **per-fill** limit assertion → quote conversion rounding **toward the vault** →
blake2b256 Merkle root over `blake2b256(0x00 ‖ bcs(FillLeaf))`, odd nodes duplicated.

### The fee is an explicit third term

`Σdebits == Σcredits + fee`, with `fee = mul_div(matched_quote, fee_matched_bps, 10_000)` credited
to `vault.fees_accrued`. **Never a silent shortfall.**

### Solvency at settlement without leaking size

There is **no margin field on `SealedOrder`** — a margin would leak order size at submit time.
Instead `close_batch` freezes the ledger, and `settle_step` **deterministically truncates** any fill
the account cannot cover to `min(fill, balance)`, recomputing the counterparty symmetrically from
the same rule. Because the rule is a pure function of the frozen snapshot, Move and the TypeScript
twin agree — **and the parity test must cover under-funded accounts explicitly.**

### Push, not claim

`settle_step` credits fills; `verify_fill` is the transparency surface. Deviation from
`aphotic.md` §7.2 step 5, stated in `docs/GOVERNANCE.md` §9 D-G3: a pull model leaves an unbounded
unclaimed-liability state that must be excluded from NAV and reconciled forever, while push makes
settlement terminal.

### Function surface (target)

```
begin_clearing(&mut Batch, &BatchRegistry, &Clock)
sort_step(&mut Batch, budget: u64)          // cursor-driven, resumable
price_step(&mut Batch, budget: u64)         // may need splitting into price_scan_step + alloc_step
settle_step(&mut Batch, &mut BalanceBook, budget: u64)   // permissionless; KeeperCap is a hint only
verify_fill(&Batch, leaf: FillLeaf, path: vector<vector<u8>>, index: u64): bool
compute_for_inspect(orders_bcs: vector<u8>, tick: u64): vector<u8>   // PURE — the L3 parity surface
```

**Build the resumable path from day one.** With `budget = 128` a 512-order batch settles in 4
transactions and n could grow into the thousands with no contract change. Retrofitting resumption
changes the state machine, the events and the tests.

### Parity — the release gate

| Level | What | When |
|---|---|---|
| L1 | ~40 shared golden fixtures in `sdk/fixtures/clearing.golden.json`; a generator emits `move/tests/clearing_golden_tests.move` from the **same** JSON, so a fixture edit updates both sides or fails to compile | every commit |
| L2 | TypeScript property test, 10 000 cases, seeded RNG | every commit |
| L3 | `compute_for_inspect` through `devInspectTransactionBlock`, compared **BCS byte-for-byte** | release gate |

The L1 fixture list is not negotiable: empty · all-bids · all-asks · no cross · exact touch · single
crossing pair · every order at the same price (full pro-rata) · pro-rata with a remainder needing
largest-remainder tie-breaking · duplicate `(price, submitter)` needing the index tie-break · **an
under-funded account triggering truncation** · u64/u128 boundaries · max batch size.

### Invariants → tests

`clearing_tests::settle_reverts_on_value_leak` (`EValueNotPreserved`) ·
`::fee_is_an_explicit_credit_term` · `::no_fill_outside_limit_price` ·
`::every_fill_maps_to_one_revealed_order` · `::unrevealed_orders_are_absent_from_fills` ·
`::clearing_is_idempotent` · `::settle_step_past_end_is_a_noop` ·
`clearing.parity.test.ts > no fill outside limit, 10k sets` (KP) ·
`clearing.moveparity.test.ts > 10k devInspect comparisons` (LIVE).

---

## 13. `aphotic_lending` — the second package

`lending/`, module `aphotic_lending::lending`. **Not part of `aphotic`**; `allocate.move` reaches it
only through the pinned allowlist and the adapter contract in §7.

It exists because **no hBTC lending market exists on Sui testnet** — Suilend, Navi and Scallop have
no testnet deployment at all, and AlphaLend's markets are testcoins plus SUI. The choice was between
mocking the adapter off-chain, which proves nothing, and deploying a real counterparty and saying
so. **This is the second option, and the saying-so is mandatory:** `disclosure()` returns the
honesty text as an on-chain string so a front-end cannot render the APY without it.

| Fact | Value |
|---|---|
| Depends on | `hashi` **for the type only** (`hashi::btc::BTC`); it calls no hashi function |
| Share coin | `LENDING`, 8 decimals, symbol `aLhBTC`, registered via `sui::coin_registry::new_currency_with_otw` (`sui::coin::create_currency` is deprecated in this framework rev) |
| Index | `INDEX_SCALE = 1e9`; `borrow_index` is `u128` starting at `INDEX_SCALE`; `MS_PER_YEAR = 31_536_000_000` |
| Rate model defaults | base `0` bps · slope1 `400` · kink `8_000` · slope2 `6_000` |
| Collateral | **NONE.** Borrowing is permissioned and uncollateralised; `is_collateralised()` and `has_liquidations()` both return `false`, **on purpose** |
| Yield | real but a **claim on borrowers**: `total_assets` grows only when `total_borrows_sats` grows, and with zero borrowers `accrue` provably adds zero |
| Fees | the reserve factor is a cut of **interest**, never of principal or AUM — a management fee on AUM is a rejected design (`aphotic.md` §3) |

---

## 14. Gates and verification

**13 gates** as of commit `72b12bb` (2026-07-26 02:13), reporting **8 PASS · 0 FAIL · 4 SKIP**.
The canonical table is `docs/CONVENTIONS.md` §6; the Move-relevant ones:

| Gate | What it greps | Status |
|---|---|---|
| `keepercap` | an `address` parameter on any keeper-gated function ⇒ **FAIL** | **exists** |
| `notes` | `struct Note` carrying any field but `id` / `denom_index` ⇒ **FAIL** | **exists** |
| `batchstate` | `\.state\s*=` outside `set_state` / `open_batch` ⇒ **FAIL** | **exists — SKIP** until `batch.move` lands |
| `seal_le` | a big-endian decode of the Seal identity ⇒ **FAIL** | **exists — SKIP** until `batch.move` lands |
| `send` | a nameable destination where there must not be one | **exists** |
| `g2` | the destination test, now **strictly broader** than `keepercap`'s. It previously passed `bitcoin_address: vector<u8>` because a word-bounded `address` match misses the underscore | fixed |
| `g7` | the Hashi Move boundary — target is now `carry.move` | repurposed |
| `ids` · `purity` · `transport` · `sdk` · `todo` | unchanged from v1 | `ids` **green for the first time** |

> **A SKIP is not a PASS.** The two gates that guard `batch.move`'s hardest invariants — the
> monotonic state machine and the little-endian Seal decode — are both SKIP today, **precisely
> because the module they protect does not exist.** They go green only when `P3.batch` lands, and
> not before.

### Verification commands

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"       # sui is NOT reliably on PATH in agent shells

cd move && sui move build                    # must be exit 0, zero warnings
cd move && sui move test                     # the filter is POSITIONAL: `sui move test caps`
cd lending && sui move build && sui move test
node scripts/measure-clearing.mjs            # writes docs/LIMITS.md; fails above 3 500 000 units
powershell -NoProfile -File scripts/gates.ps1
```

⚠ **Windows:** never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` — PS 5.1
writes a UTF-8 BOM and the Move compiler rejects it (`E01001`). Use
`[System.IO.File]::WriteAllText` with `New-Object System.Text.UTF8Encoding($false)`.
