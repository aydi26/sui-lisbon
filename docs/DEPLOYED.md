# DEPLOYED.md — Aphotic on Sui testnet

> Purpose: the record of what we actually published on chain, and the receipts.
> These are the ids `keeper/.env` and `app/.env.local` are wired to. When the
> package is upgraded, add a row — **never overwrite one**, so an old journal entry
> stays resolvable.
> Read after: `docs/RECON.md` (which records the ids we depend on but did not deploy).
>
> ⚠ **Two numbering schemes live in this file, and they are not the same thing.**
> The sections labelled **v1 / v2 / v3** below are *publish generations of the **old**
> `aphotic` package* (the v1 product — the DeepBook market-making vault). The section
> immediately below, **APHOTIC v2**, is the **product** pivot of 2026-07-26. Nothing was
> overwritten to make room for it.

---

## APHOTIC v2 — the 2026-07-26 product pivot — **PUBLISHED** (partial runtime graph)

**The package is live on Sui testnet.** The first publish attempt was rejected on chain; the
cause was diagnosed, fixed in `clearing.move`, and the republish succeeded. Both the failure
and the success are recorded below — the failure is the more useful of the two.

### THE RECEIPT — publish, 2026-07-26

| What | Id / value |
|---|---|
| **publish digest** | `Hyso18276VRqbDyt9DbvFBDvActna7mbUWutedzUgm7o` — status `success` |
| **`aphotic` package (published-at)** | `0x2ebf955ea7398901eb2e5f6a81ca554e574d1a98575f0c272932b729275ed9a3` |
| **`aphotic` original-id (type origin)** | `0x2ebf955ea7398901eb2e5f6a81ca554e574d1a98575f0c272932b729275ed9a3` |
| **`UpgradeCap`** | `0x74a25d12b74fc33ac4699cf496d8d838c876ba9cbfa4166df51e6fe9d392cde5` → `AddressOwner` `0xd41b0cd8…f333d` |
| modules (10) | `allocate` `balance` `batch` `caps` `carry` `clearing` `events` `notes` `oracle` `vault` |
| gas | 0.40174988 SUI |
| toolchain | `sui` 1.76.0, edition `2024.beta`, chain-id `4c78adac` |

**published-at == original-id today, and they will diverge on the first upgrade.** This was a
**fresh publish, not an upgrade** — every v1 public function is gone and Move's `compatible`
policy forbids removals. Keep both ids wired separately: a `moveCall` targets **published-at**,
while type arguments, type-string checks and event type strings resolve against **original-id**
forever. Checking a vault's type against published-at breaks the moment we upgrade.

### THE RECEIPT — runtime objects

| Object | Id | Owner | Digest |
|---|---|---|---|
| shared **`AdapterRegistry`** | `0xd743861834773a8129301e766be83ba43c0fe4227aef6181c11a222618a0b9f1` | `Shared`, isv **953314528** | `CqeesXgjs8sFtKxTfjYSQb5ao1ePLGtDLVNTMfqahNGu` |
| **`AdapterAdminCap`** | `0xb3dde8f1862de74c491ed8ad33b55d57abd37631087300848fbb1dffc6416614` | `AddressOwner` `0xd41b0cd8…f333d` | same tx |
| shared **`Vault<B,Q,S>`** | — | — | **BLOCKED, see B26 below** |
| shared **`BatchRegistry`** | — | — | **BLOCKED** (needs `vault_id`) |
| **`AdminCap`** / **`KeeperCap`** | — | — | **BLOCKED** (minted only inside `vault::create`) |

**The package has no `init` function**, so publishing created nothing but the `UpgradeCap`.
Every runtime object is made by an explicit call. `allocate::create` is the only one that does
not need a vault id first, which is why it is the only one that exists.

### ⚠ There are THREE shared objects in this design, not seven

Read from the Move source, not from the older env-var list: `NoteTree`, `NullifierSet`,
`DenomLadder`, the `CapRegistry` and **both** `BalanceBook`s are embedded in `Vault`
**by value** (`vault.move` fields `tree:` `nulls:` `ladder:` `caps:` `base_book:` `quote_book:`).
They are struct fields — they have **no object id of their own and never will**. So
`VITE_GOVERNANCE_ID`, `VITE_NOTE_TREE_ID`, `VITE_NULLIFIER_SET_ID` and `VITE_BALANCE_LEDGER_ID`
all take the **vault id** and are read as fields of it. Only `Vault`, `BatchRegistry` and
`AdapterRegistry` are separate shared objects. `Clearing` objects are shared per batch by
`clearing::share_clearing`.

### B26 — the remaining blocker: no LP share coin, so no `Vault` can be created

```move
public fun create<B, Q, S>(lp_treasury: TreasuryCap<S>, admin, keeper, fee_recipient, ctx)
```

`vault::create` consumes a `TreasuryCap<S>` **by value** and asserts `total_supply == 0`, but the
`aphotic` package **defines no LP share coin**. `aphotic.md` L419 and `docs/MOVE-PACKAGE.md:466`
both specify `Coin<APHOTIC_LP>` — that module was never written. The only `S` in the tree is
`APLP`, declared `#[test_only]` in `move/tests/vault_tests.move`, which is not published.

This blocks the rest of the graph, because everything hangs off the vault id:
`batch::create_registry(vault_id, ctx)` needs it, and `AdminCap`/`KeeperCap` are minted only by
`caps::new_registry`, which runs inside `vault::create`. **Fix: add a real, publishable LP-share
coin module with a one-time witness, then re-run the create sequence.** Owner: the Move agent.

⚠ When the vault is created, the **`AdminCap` must go to the admin multisig, not to the deployer
EOA**. `scripts/verify-onchain.mjs` now asserts cap ownership from chain and **FAILS if the admin
and keeper resolve to the same address** — same-address caps silently void the two-party NAV split
that the whole governance claim rests on.

---

### THE FIRST ATTEMPT — **FAILED, then RESOLVED**: `Clearing` had 39 fields, the on-chain limit is 32

Kept because the trap is invisible locally and will be walked into again. The first publish was
**rejected by the Sui Move verifier**: a real, reproducible on-chain rejection, not a toolchain or
network problem. Nothing was created — no transaction was ever executed.

**Resolution:** `Clearing` was refactored to group correlated scalars into nested `Pricing` and
`Allocation` structs (nested structs do not inherit the parent's field count), which brought it
under the cap. The republish then succeeded — that is the receipt at the top of this section.

```
Error executing transaction '2byvZDvZo2onDwLxQe2bxME9qn3iEscGUDfmWhu4vqmp':
VMVerificationOrDeserializationError in command 0
```

The local toolchain is green and disagrees with the chain — this is the whole trap:

| Gate | Result |
|---|---|
| `sui move build` | clean, **zero warnings**, 10 modules, 48 143 bytes of bytecode |
| `sui move test` | `Total tests: 275; passed: 275; failed: 0` |
| `sui client publish` | **`VMVerificationOrDeserializationError in command 0`** |

**`sui move build` does NOT run the Sui object verifier.** Only the validator does. A package
can be 275-tests green and still be unpublishable.

#### Root cause, established by bisection (not by guessing)

`sui client verify-bytecode-meter` is `not yet implemented` in sui 1.76.0 and panics, so the
cause was isolated by publishing progressively larger module subsets with `--dry-run`:

| Module set | Dry run |
|---|---|
| `events oracle carry caps balance notes batch vault` (8) | **success** |
| the same 8 **+ `clearing`** | `VMVerificationOrDeserializationError` |
| the same 8 **+ `allocate`** (9, no `clearing`) | **success** |
| a module containing **only** `clearing`'s four structs, no functions | `VMVerificationOrDeserializationError` |
| the same structs with **every function body stubbed to `abort 0`** | still fails ⇒ **not** a code-complexity/meter limit |

Then the limit itself was measured directly, with a synthetic `public struct T has key`:

| Field count | Dry run |
|---|---|
| 21 | success |
| **32** | **success** |
| **33** | **`VMVerificationOrDeserializationError`** |
| 41 | fails |

**The Sui verifier caps a struct at 32 fields.** `aphotic::clearing::Clearing` declares **39**
(`id` counts). Proof of fix: the *identical* struct with 7 fields removed — 32 exactly — dry-runs
`success`.

#### The one blocking change (owned by the Move agent — NOT made here)

`move/sources/clearing.move` — `Clearing` must lose **≥ 7 fields** to reach 32. The usual fix is
to group correlated scalars into a nested `has store` struct, which costs one field each:
the pricing scan cursors (`bid_scan` `supply_acc` `ask_scan` `found` `best_price` `best_vol`
`best_gap`), the allocation counters, or the settlement tail
(`quote_paid` `quote_recv` `fee_quote` `total_debits` `total_credits` `fee_bps` `fee_recipient`).
Nested structs do **not** inherit the parent's field count.

⚠ **`aphotic::vault::Vault` declares 31 fields — one under the cap.** Adding two fields to the
vault breaks the publish the same way. Every other struct in the package is well clear.

Field census (`id` included), for whoever fixes this:

```
39  clearing.move::Clearing   <<< EXCEEDS THE 32-FIELD LIMIT
31  vault.move::Vault         <<< one field of headroom
```

#### Second blocker, independent of the first, found while sequencing the runtime objects

Even once `Clearing` is trimmed and the package publishes, **no `Vault` can be created**:

```move
public fun create<B, Q, S>(lp_treasury: TreasuryCap<S>, admin, keeper, fee_recipient, ctx)
```

`vault::create` consumes a `TreasuryCap<S>` **by value** and asserts `total_supply == 0`, but the
`aphotic` package **defines no LP share coin**. `aphotic.md` L419 and `docs/MOVE-PACKAGE.md:466`
both specify `Coin<APHOTIC_LP>` — that module was never written. The only `S` that exists is
`APLP`, declared `#[test_only]` inside `move/tests/vault_tests.move`, which is not published.

This blocks the entire runtime object graph, because everything hangs off the vault id:
`batch::create_registry(vault_id, ctx)` needs it, and `NoteTree`, `NullifierSet`, `DenomLadder`
and both `BalanceBook`s are **embedded inside the `Vault` by value** — they are not separate
shared objects and never get their own ids. `allocate::create` (the `AdapterRegistry`) is the
only runtime object that does not need the vault.

So the shared-object set the app needs is only **three** objects, not seven:
`Vault` · `BatchRegistry` · `AdapterRegistry`. `Clearing` objects are shared per batch by
`clearing::share_clearing`. See the env-var mapping note in `app/.env.example`.

#### What was left untouched

`move/sources/**` was not edited — per the task's standing instruction, a Move source change is
reported, not made. All bisection ran on scratchpad copies. `move/Published.toml` **was** cleared
of its stale **v1** entry (`0x148a1191…dee54`), because the CLI refuses to publish while a
publication record exists and v2 is a fresh publish; both v1 ids remain recorded in § LEGACY
below, so nothing was lost.

### What changed, and why every id below is stale

The product pivoted from a private market-making vault to a **redemption-carry vault plus a
sealed-order batch auction**. The Move modules `gateway`, `router`, `journal`, `envelope`
and the v1 `vault` are **deleted**; the v2 package is ten different modules
(`caps` `vault` `notes` `balance` `batch` `clearing` `allocate` `carry` `oracle` `events`).
A module set that different is a **fresh publish, not an upgrade** — Move's `compatible`
policy forbids removing a public function, and every v1 public function is gone.

### What to fill in when it lands — **updated 2026-07-26, post-publish**

⚠ This checklist was written before the object graph was read off the Move source, and it
**overcounts the shared objects**. `BalanceBook`, `NoteTree` and `NullifierSet` are embedded in
`Vault` by value and have no ids — the rows are kept, struck through, so nobody re-adds them.

| What | Id |
|---|---|
| `aphotic` package (published-at) | ✅ `0x2ebf955e…d9a3` |
| `aphotic` original-id (type origin) | ✅ `0x2ebf955e…d9a3` (equal today; diverges on upgrade) |
| shared `AdapterRegistry` | ✅ `0xd7438618…b9f1` (Shared, isv 953314528) |
| `UpgradeCap` | ✅ `0x74a25d12…cde5` (AddressOwner, deployer) |
| shared `Vault<B, Q, S>` | ⛔ **BLOCKED — B26**, no LP share coin exists |
| shared `BatchRegistry` | ⛔ **BLOCKED** — `create_registry` needs `vault_id` |
| `AdminCap` (→ **admin multisig**, not an EOA) | ⛔ **BLOCKED** — minted inside `vault::create` |
| `KeeperCap` (→ keeper address) | ⛔ **BLOCKED** — same |
| ~~shared `BalanceBook<hBTC>`~~ | **not an object** — `base_book`/`quote_book` fields of `Vault` |
| ~~shared `NoteTree` · `NullifierSet`~~ | **not objects** — `tree`/`nulls` fields of `Vault` |
| `aphotic_lending` package (`lending/`) | ✅ `0x39d038ae…6ea8c` — already live, see its own section |
| shared lending market object | ✅ `0x220ba0e5…6677` (Shared, isv 953314524) |
| Seal committee — 5 operators, t = 3, **excludes Enoki** | ✅ in `app/.env.local`, read off chain 2026-07-26 |
| Custody multisig (2-of-2) + pinned Bitcoin redemption address | ⛔ not stood up |
| publish digest / `create_vault` digest | ✅ `Hyso1827…gm7o` / ⛔ no vault yet |

**Record both ids at publish, always.** A `moveCall` targets **published-at**; type
arguments, type-string checks and events emitted by an earlier generation resolve against
**original-id**. Checking a vault's type against published-at instead starts failing the
moment you upgrade — that lesson is written up in the v2-generation section below and cost
us a debugging session.

### Before publishing v2, these must be true

- `docs/STATUS.md` shows `vault.move`, `batch.move` and `clearing.move` **existing and
  green** — ✅ met 2026-07-26: all three exist, `sui move test` is `275 passed / 0 failed`.
  Note this is **necessary but not sufficient** — the 275-green package was still rejected
  on chain (see the publish-attempt section above). Add to this list:
- `aphotic::clearing::Clearing` declares **≤ 32 fields**, and so does every other struct
  (`Vault` is at 31). Verified by a `--dry-run` publish, which is the only gate that catches it.
- The package defines a **real, publishable LP share coin** for `vault::create`'s
  `TreasuryCap<S>`. A `#[test_only]` witness in `move/tests/` cannot be used.
- `scripts/measure-clearing.mjs` has run and `docs/LIMITS.md` exists, so `MAX_BATCH_SIZE`
  is a **measured** default and not a reasoned one.
- The `AdminCap` goes to a **multisig**, not to the deployer EOA. The two-party NAV split
  is the entire governance claim; handing both caps to one address silently voids it.
- The Seal committee is health-probed and **at least `t = 3` operators are live.**

---

## LEGACY — the v1 product's publish generations

⚠ **Everything from here down deployed the old product.** Those packages still exist on
chain and still contain `gateway`, `router`, `journal` and the v1 `vault`. Nothing of ours
points at them any more. They are kept so old journal entries, digests and event type
strings stay resolvable — **do not wire anything new to them.**

## v3 — 2026-07-25 (fresh publish) — the last v1-product deployment

| What | Id |
|---|---|
| **`aphotic` package** | `0x148a11915b86ebb79d0a98f81da666ba92edfc03ff0a3ef937a3441df66dee54` |
| **`Vault<hBTC, DBUSDC>`** | `0x9236a21c20e6d97e4507171d1709dfc31b90f4b2f2d4b528eb36626ec3fafec7` (Shared, isv `952944693`) |
| `VaultCap` | `0x827877974aa5611eac496fa964c88cc0b098781e4c8c48a67b6010affbf101d4` |
| `UpgradeCap` | `0xe635c3c9f055197d24df7fc5ed0b8202aa43ac7cf17200cfaf585deb9a42aec4` |
| publish digest | `3zU4y144dysNTtPeppCvb8HjsxH7bxHHyjfuS6qZztxs` |
| `create_vault` digest | `7EQRABBkHodd5ExNK3MgXs598rN4kx4WRHg5uFqbiEZC` |

The DeepBook `BalanceManager` (`0x5766ed0b…`) and the keeper `TradeCap` (`0xc7629a3b…`) are **unchanged** — they belong to DeepBook, not to us, so they survive any republish of our package.

### What changed: the owner can no longer withdraw

`vault::emergency_withdraw` is **gone**. It let the owner take idle hBTC out to themselves, gated on the `VaultCap` plus the recorded owner as signer.

It protected nobody but the owner. Depositors can already redeem pro-rata **while the vault is paused** (`redemption_still_works_while_paused`), so the honest failure path is: the owner pauses, the keeper stops, everyone exits on their own. An owner withdraw adds no recovery capability for depositors — it only lets the owner leave first.

The trust claim therefore moves from *"the KEEPER cannot steal or redirect"* to *"NOBODY can — not the keeper, not the owner"*. The only two ways value leaves this vault are a depositor's own pro-rata redemption and `gateway::exit_to_bitcoin` to the write-once address pinned at deposit.

The owner keeps only powers that cannot move funds: `set_paused`, `set_keeper` (rotating invalidates the old keeper cap), `set_envelope`, `update_strategy`. Two tests pin this down: `pausing_is_the_owner_s_ONLY_lever_and_it_moves_no_funds` and `a_leaked_vault_cap_cannot_move_funds_either` — the second hands the cap to an attacker, has them use it, and asserts the balance is untouched.

### Why a fresh publish and not an upgrade

Move's `compatible` upgrade policy **forbids removing a public function**. Attempted and rejected verbatim:

```
error[Compatibility E01001]: missing public declaration
  public function 'emergency_withdraw' is missing
  Public functions are part of a module's public interface and cannot be removed
  or changed during a 'compatible' upgrade.
```

`--skip-verify-compatibility` only skips the *local* check; the chain rejects it anyway. Since the v2 vault held zero hBTC, republishing was cheaper and gives the stronger result: the function does not exist, rather than existing-but-always-aborting.

Error code `1` (`ENotOwner`) is now **vacant** in `vault.move` and deliberately not reused — an old client decoding abort 1 should find nothing, not a different meaning.

⚠ The v1/v2 packages below still exist on chain and still contain `emergency_withdraw`. Nothing of ours points at them and no vault of ours uses them. They are kept in this file only so old journal entries and digests stay resolvable.

## v2 — 2026-07-25 (upgrade) — SUPERSEDED

| What | Id |
|---|---|
| **`aphotic` published-at (call this)** | `0xbf55eecc6c840c576c88e05c469f9753ab5ad9212e04c6cf56564f88929875bf` |
| **`aphotic` original-id (type origin)** | `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` |
| upgrade digest | `56Us71eqUH82AnhXzxibuTts6y4P7eViA3Le5qFpAGBC` |

Every other object below is **unchanged** — the shared `Vault`, the `BalanceManager`, the caps and their ids all survive the upgrade. `Vault<hBTC,DBUSDC>`'s type string still names the **original** id and always will, exactly like DeepBook's two-id split (`docs/RECON.md` R4). So:

- `moveCall` targets → **published-at** (`0xbf55eecc…`)
- type arguments, type-string checks, and events emitted by v1 → **original-id** (`0xbe433a27…`)

Checking the vault's type against the published-at instead would have started failing the moment we upgraded. `scripts/verify-onchain.mjs` asserts both ids and uses the original for the type check.

**What changed in the code.** One misplaced assertion in `vault::nav_sats`:

```move
// before — a 100%-hBTC vault could not be valued at all without a price
assert!(book_mid != 0, EZeroNav);
let quote = vault.dbusdc.value();
if (quote == 0) return free;
```

`book_mid` converts the **quote** leg and nothing else, so a base-only vault has an exact sats NAV with no price input. The guard fired one line too early, which made the vault unvaluable exactly when the book has no mid — the normal state of a pool nobody else makes a market on, and permanently our state given there are ~16 DBUSDC in existence across the whole testnet. The assertion now sits inside the `quote != 0` branch, where the value is genuinely load-bearing.

Covered by two tests that encode the new semantics precisely: `a_base_only_vault_is_valuable_with_no_price_at_all` and `nav_sats_still_rejects_a_zero_mid_once_the_quote_leg_is_non_empty`.

## v1 — 2026-07-25

| What | Id | Notes |
|---|---|---|
| **`aphotic` package** | `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` | modules `envelope`, `gateway`, `journal`, `router`, `vault` · Immutable |
| **`Vault<hBTC, DBUSDC>`** | `0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8` | **Shared**, `initialSharedVersion = 947353676` |
| `VaultCap` | `0x232ed471922011b4083e20bfb7c58f923f8c3fd4691ca5522364ff3d506d9b3d` | owned by the deployer — owner-only controls (pause, envelope, emergency withdraw) |
| DeepBook `BalanceManager` | `0x5766ed0b5e3fd310da9ccd723912198450872d9e2c83a473ed59cd5ab51990e2` | **Shared**, `initialSharedVersion = 947353675` |
| `UpgradeCap` | `0xf2660f561f358e02d88e82ec4792916bdd1193f8553cdd6ab43e81c96fd72ca9` | owned by the deployer |
| Deployer / keeper address | `0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d` | |

Transaction digests:

| Step | Digest |
|---|---|
| publish | `5hFRU5w5ZZ14wo5dtR9vk7vynF2VknzmPudMJeQ7Qs7t` |
| create + share `BalanceManager` | see `balance_manager::new` tx below |
| `create_vault` | `42EiUjFm52revijuNvjX976KvuxgVQSDzF4fk7Xff8qR` |

Publish cost `136 635 480` MIST (~0.137 SUI). The dry run resolved linkage against
the real `hashi` (`0xfcea10ca…`) and `deepbook` packages with no linker error, so
the on-chain `gateway` genuinely calls the live bridge.

## Envelope parameters fixed at creation

| Parameter | Value | Why |
|---|---|---|
| `max_slippage_bps` | `50` | 0.5 % |
| `max_notional_per_epoch_sats` | `100_000_000` | 1 BTC per epoch |
| `min_cooldown_ms` | `30_000` | keeper action spacing |
| `buffer_ratio_bps` | `2_000` | 20 % redemption buffer |
| `limiter_refill_rate` | `115_740` | **live** Guardian value (DAY-ONE D4) |
| `limiter_max_capacity` | `10_000_000_000` | **live** Guardian value — 100 BTC |
| `epoch_start_ms` | `1784984759062` | creation time |

⚠ The limiter scalars are the values read from the live Guardian, **not** the
`1000` / `100_000_000` prior that older docs carry. That prior is wrong by ~100×.
Because the real bucket is ~100 BTC/day, **never write congestion copy** — the
bridge is not tight, and claiming it is would be false.

## Known-incomplete at v1

- `strategy_ciphertext` and `strategy_blob_id` are one-byte placeholders. They
  are filled when Seal encryption lands (T2.6) and the blob is written to
  Walrus (T2.9). The vault is functional without them; only the strategy
  privacy story depends on them.
- The vault holds no hBTC yet — the signet deposit is still confirming.
- No `TradeCap` has been issued to the keeper yet; that happens when the keeper
  first needs to quote (T2.7). The vault references the `BalanceManager` by ID
  only and never holds a `DepositCap`/`WithdrawCap` (G2).

## Verify these ids yourself

```bash
sui client object 0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66
sui client object 0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8
node scripts/verify-onchain.mjs
```

---

## APHOTIC v2 — PUBLISHED 2026-07-26 (the second attempt)

⚠ **Never overwrite a row above.** This section is appended so every earlier journal entry
stays resolvable against the ids it was written with.

| What | Id / digest |
|---|---|
| package (`published-at` **and** `original-id`) | `0xfa214c431cee927137422f042ed679eb6180c226d30fa3e98c6bea9e09597df2` |
| publish digest | `DLW43Kvc8czoiWAfxWXomuHXmT7Cuysp5bSnkmsHBuhH` — `success` |
| `UpgradeCap` | `0x12b8e8d6b4a49ac3027e5a3c2b33f9e9c8609254b5baa676dbb47ef41674c277` → deployer |
| `TreasuryCap<APHOTIC_LP>` | `0x6dd359c759575bcc50e3ca7bf38ef21a4d6fe8f11b5cd64ca57a629547a2f520` — **consumed by `vault::create`** |
| `Currency<APHOTIC_LP>` | `0x03b1814e4b7df25d8b309071a0d7d2da7938dd46f7c29d0aef82db6bed81378e` |
| shared **`Vault<BTC, DBUSDC, APHOTIC_LP>`** | `0x91660fb483ec6c8ee4f9c2b4be04872b5808955fdcda962b5be5905989b3efcf` — digest `AYe5Y2EGEC1VTySuHX2jYHRSECwr1FfvGDfCBWmLdrpV` |
| `AdminCap` | `0x3bb58bd51acd3f5caa26bc15b87fa295b4862bdcc4b60755890d911ced9ebbc1` |
| `KeeperCap` | `0xcfbdfc8d86535786b765b803249fff505bed06b1731fba491acf17f76de87822` |
| shared **`BatchRegistry`** | `0x9967881e88d5e22fc790d3b761e8ca55c8fd87d1a07baa11eb4a4352cd356b35` — digest `Fn4rqfdffQcMUaw1izWGDwtnA8TzfVfBnk6kxJ3YV8BV` |

Published-at and original-id are equal today because this is a fresh publish. They **diverge on
the first upgrade** — type arguments resolve against the original forever while `moveCall`
targets the current — so they are wired as two separate variables everywhere.

### Why there are three shared objects and not seven

`NoteTree`, `NullifierSet`, `DenomLadder`, `CapRegistry` and both `BalanceBook`s are embedded in
`Vault` **by value**. They are struct fields and have no object id, ever. So
`VITE_GOVERNANCE_ID`, `VITE_NOTE_TREE_ID`, `VITE_NULLIFIER_SET_ID` and `VITE_BALANCE_LEDGER_ID`
all take the **vault id**. Only `VAULT`, `BATCH_REGISTRY` and `ADAPTER_ALLOWLIST` name distinct
objects.

### Two rejections it took to get here

**1. `VMVerificationOrDeserializationError in command 0`** with `sui move build` clean and all
tests green. Bisected by subset dry-runs: nine of ten modules published, `clearing` alone failed,
and a module holding only its structs with every body stubbed to `abort 0` still failed — ruling
out complexity. Measured directly against the chain: **a struct with 32 fields publishes, 33 does
not.** `Clearing` had 39, and was refactored into nested `Pricing`/`Allocation` structs.

⚠ **`sui move build` does not run the verifier that catches this.** Gate publishes on
`sui client publish --dry-run` instead. Note `vault::Vault` sits at **31 fields — one under the
cap**.

**2. `vault::create<B,Q,S>` consumes a `TreasuryCap<S>` and no LP share coin existed.** The only
`S` in the tree was a `#[test_only]` witness. `aphotic_lp.move` was added with the standard
one-time-witness shape, 8 decimals to match sats, so `init` mints the cap at publish time.

**3. `UnusedValueWithoutDrop`** on the first `vault::create` call: it returns a `Vault` by value
which must be shared in the **same** PTB, and `sui client call` cannot chain. Done with
`sui client ptb --move-call … --assign v --move-call …::share v`.

### Correction — the `AdapterRegistry` belongs to a package, not to the deployment

The first `AdapterRegistry` (`0xd743861834773a81…`) was created by the **superseded** package
`0x2ebf955e…`. It still exists and still works, but its type is
`0x2ebf955e…::allocate::AdapterRegistry`, so nothing in the live package can consume it —
`verify-onchain.mjs` caught exactly that with a type-prefix assertion rather than an existence
check. A registry that exists but is the wrong type is the failure an existence check misses.

Recreated against the live package:

| What | Id |
|---|---|
| shared `AdapterRegistry` | `0x216b878d592129d6c5ce7c5c2b1f72d77cef8ed852db5934cb5a559a2eec29ca` |
| `AdapterAdminCap` | `0xf6b4d0bbd904c0af83f6a3235f03d5c03128575870c824ea9f8b6db31c6a47e1` |
| digest | `67aHU3fsZQr76sVubKwEbQSjX2kd97st91f45qv6PafM` |

`allocate::new` returns `(AdapterRegistry, AdapterAdminCap)` unshared **on purpose**, so a
deployment PTB can inspect the pair before publishing it; `allocate::share` is the second step.

**Live verification, after the rewire:**

```
node scripts/verify-onchain.mjs
  33 PASS · 0 FAIL · 0 WARN · 6 INFO
```

---

## BATCH 0 — the first batch ever opened (2026-07-26)

Until now `BatchRegistry.next_batch_id` was **0**: the sealed-order auction was published,
configured and tested, but had **never run on chain**. `/verify` said so in as many words — *"No
batch has ever been opened on this package."* That is now false, which is the point.

`open_batch` is **permissionless** (G4 — liveness is never a privilege), so this needed no cap and
no keeper. Two commands in one PTB, because `open_batch` returns the `Batch` **by value** and
`share_batch` is the second step:

```
sui client ptb \
  --move-call <pkg>::batch::open_batch @<registry> @0x6 --assign b \
  --move-call <pkg>::batch::share_batch b \
  --gas-budget 30000000
```

| What | Id / value |
|---|---|
| transaction digest | `3JWjDDmAserJXt1kokzgfRSs1stCrMnqPRLBZwcPxi2F` — `Success` |
| shared **`Batch`** (batch 0) | `0xe73f034b90eef92a06db2b889e8d4514f2f097298aa4eecbca2a364a3e2c096f`, `Shared`, isv **954059098** |
| opened by | `0x48ae587dfa4c0011e764ed5dfb8fd79aec082d79cd2a3969fe277ed6c887b725` — **not** the keeper, and that is the demonstration |
| `opened_at_ms` | `2026-07-26T10:42:08.873Z` |
| `close_ms` | **`2026-07-26T18:00:00.000Z`** — exactly the 18:00 UTC boundary |
| state · policy · max_orders | `OPEN` · `1` · `256` |
| registry after | `live_batches = 1`, `next_batch_id = 1` |

**Why the close time is the headline.** `close_ms` was not passed in — `open_batch` takes **no
timestamp parameter** and derives it from `next_boundary(now, 43_200_000, 21_600_000)`. It landed on
`18:00:00.000Z` to the millisecond. G5 ("an operator can never choose when a batch closes") stops
being a claim about the source and becomes a receipt.

### What this immediately exposed — a real bug, invisible until a batch existed

The app read the live batch and returned
`CommandArgumentError { arg_idx: 0, kind: TypeMismatch } in command 0`.

`discoverLiveBatch` finds the `Batch` by taking the transaction that emitted `BatchOpened` and
looking through its object changes for a type matching `<pkg>::batch::Batch` — with `startsWith`.
But **`Batch` is a prefix of `BatchRegistry`**, and `open_batch` creates the batch *and* mutates the
registry in the same transaction, so the scan could return the **registry** id. `readBatch` then
passed a `BatchRegistry` where a `&Batch` was expected.

Fixed in `app/src/lib/batch.ts` by matching the whole type (`selectObjectOfType`, with a `<` case so
generic structs still match), and pinned by six cases in `app/test/batch.test.tsx` — including the
registry-listed-first ordering that produced the failure. **No batch had ever been opened, so no
test and no run could have caught this.** It would have surfaced for the first time in front of a
judge.

### Still to do on batch 0

`close_batch` reverts before `close_ms` and succeeds at exactly it — so after **18:00 UTC** the
batch wants closing, and then `begin` / `step` / settle to free the registry (`live_batches` back to
0). Every one of those is permissionless. An unsettled batch blocks the next `open_batch`
(`EBatchAlreadyLive`), so this is a loose end, not a finished lifecycle.

---

## KEEPER ROTATION — the two-party NAV split is now LIVE (2026-07-26)

`docs/STATUS.md` recorded the one real on-chain failure: `verify-onchain.mjs` reported
`admin != keeper  FAIL`, because `Vault.caps.admin` and `.keeper` were **the same address**. G3's
two-party NAV split was, on this deployment, one key that both proposes and approves. The Move was
never at fault — the bytecode is byte-identical either way, which is exactly why nothing but an
on-chain read could catch it.

Closed with `scripts/rotate-keeper.mjs`, one transaction, signed by the AdminCap holder.

| | |
|---|---|
| digest | `3zFxqJeCg1SoLUqsJDievQkCDacskrEevCVgf1zuB7kJ` |
| status | Success |
| function | `vault::rotate_keeper<BTC, DBUSDC, APHOTIC_LP>` |
| admin (unchanged) | `0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d` |
| keeper **before** | `0xd41b0cd8…f333d` — the admin, `keeper_epoch = 0` |
| keeper **after** | `0x883ff25499d099a0e578a781acf03ff251647ca2430a2cef03257b080ea01125`, `keeper_epoch = 1` |
| fresh `KeeperCap` | `0x0c64a5f5e3348e21fbdaa0c3e1912486bb9af625611ac75f998614782f6de5f2` (AddressOwner: the new keeper) |
| verify-onchain | **34 PASS · 1 FAIL → 35 PASS · 0 FAIL · 0 WARN** |

The old cap was **not clawed back** and did not need to be: `caps::rotate_keeper_cap` bumps
`keeper_epoch`, so the previous `KeeperCap` is stale by epoch and no longer authorises anything.

**Operational consequence, and it is not cosmetic.** `propose_nav` must now be signed by
`0x883ff254…`; `approve_nav` stays with the admin. That is the point — the two roles are two
*parties*, and the demo can no longer accidentally perform both with one key. `keeper/.env` carries
`APHOTIC_KEEPER_ADDRESS` / `APHOTIC_KEEPER_CAP_ID` accordingly (gitignored; see
`keeper/.env.example` for the names).

`/vault` needs no change to reflect this: `NavPanel` reads the `CapRegistry` every time and renders
whichever state is true. It now shows the guarantee **with both addresses** instead of the warning
"The two-party NAV split is not live on this deployment" — because the deployment changed, not
because the copy did.
