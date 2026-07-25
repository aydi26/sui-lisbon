# MOVE-PACKAGE.md

Purpose: the build-exact Move 2024 spec for package `aphotic` — `Move.toml` dependencies, and for every module (`vault`, `gateway`, `envelope`, `router`, `journal`) the structs (fields + abilities), full function signatures, events, error constants, invariants, and a per-module test checklist. This is the contract the coding agent implements.
Read after: docs/FACTS.md (canonical IDs/types/signatures), docs/ARCHITECTURE.md (object/capability graph + the four flows).

> ALL object IDs, coin types, external Move signatures, and latencies are canonical in **docs/FACTS.md** and referenced here by anchor (`docs/FACTS.md#<anchor>`). Any hex/number inline in this file is illustrative shape ONLY; the record of truth is FACTS.md. Never hardcode a Hashi/DeepBook/Pyth ID in module logic — pass it as config (G7).

---

## 0. Golden rules this document encodes (front-loaded — never violate)

| # | Rule | Where enforced in this package |
|---|------|--------------------------------|
| G1 | hBTC is a fungible `Coin<BTC>`; on-Sui movement is instant (1 checkpoint). BTC/Guardian latency exists ONLY at mint(deposit)/burn(withdraw). | All Move state transitions are synchronous. `gateway` never blocks/waits; it emits an event and returns. §3, §4. |
| G2 | Keeper holds ONLY DeepBook `TradeCap` — never `WithdrawCap`/`DepositCap`. Exits composed in Move to an on-chain-pinned address. | `vault` stores caps; issues `TradeCap` only. `gateway::exit_to_bitcoin` reads the write-once `btc_exit_address`; no keeper param can redirect. §2, §3. |
| G3 | Cannot buy priority in Hashi's global queue; over-capacity batches REJECTED, not queued. | `envelope` treats the limiter as a *redemption-buffer input*, never a priority lever. No module reorders or prioritizes exits. §4. |
| G4 | No Cetus hBTC pool. Router = DeepBook maker `POST_ONLY` + IOC sweep on the same book. | `router` has NO Cetus/CLMM code path. Only `Pool<hBTC, DBUSDC>`. §5. |
| G5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity()` over the `WithdrawalSigned` stream — not a trusted SDK read. | `envelope::project_capacity` is a pure on-chain function mirrored by the keeper `verify` replay; the buffer bound is derived from it. §4. |
| G7 | Isolate the entire Hashi surface behind `gateway.move`; all IDs configurable. | ONLY `gateway` imports/calls `hashi::*`. `vault`/`envelope`/`router`/`journal` never touch Hashi. §2 import table. |
| G9 | Pin Pyth versions, use Beta feed on testnet, NAV at DeepBook mid (depeg defence), staleness guards. | NAV valuation reads DeepBook mid, not oracle price; `router`/`envelope` accept a `nav_mid` computed from the book; Pyth used only for the divergence breaker (keeper-side, passed as a checked bound). §1.3, §3. |
| G10 | Move 2024 edition idioms throughout. | `edition = "2024.beta"`; method syntax, positional-field avoidance, `public(package)`, `use fun`, no `friend`. §1, §6. |

---

## 1. Package layout & `Move.toml`

### 1.1 Directory tree

```
move/
├── Move.toml
└── sources/
    ├── vault.move        # shared Vault object, share/NAV accounting (sats), seal_approve, cap custody
    ├── gateway.move      # ONLY module touching Hashi on-chain (G7): register_exit_address, exit_to_bitcoin, reclaim_stalled_exit, small-exit pooling
    ├── envelope.move     # constraint checks incl. redemption buffer + trustless limiter replay (project_capacity)
    ├── router.move       # DeepBook maker POST_ONLY + IOC entrypoints (NO Cetus — G4)
    ├── journal.move      # decision-log Walrus blob ids emitted on-chain
    └── tests/
        ├── vault_tests.move
        ├── gateway_tests.move
        ├── envelope_tests.move
        ├── router_tests.move
        └── journal_tests.move
```

Package name: `aphotic`. Modules addressed as `aphotic::vault`, `aphotic::gateway`, etc.

### 1.2 `Move.toml`

Move 2024 (G10). Pin every external dependency to a fixed `rev` (Pyth auto-upgrades 2026-08-18 — see `docs/FACTS.md#pyth-oracle`; Hashi is pre-1.0). Prefer git-pinned deps; if a published-address override is used, pin it in `[addresses]` from config, not hardcoded in logic.

```toml
[package]
name = "aphotic"
edition = "2024.beta"
# license = "MIT"

[dependencies]
# Sui framework — pin to the testnet-matching framework rev.
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "<PIN testnet framework rev>" }

# DeepBook v3 — maker POST_ONLY + IOC on Pool<hBTC, DBUSDC> (docs/FACTS.md#deepbook-venue)
DeepBook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "<PIN rev matching callable pkg 0x22be4c…71a3c>" }

# Pyth on Sui — divergence breaker only (NAV values at DeepBook mid; docs/FACTS.md#pyth-oracle)
Pyth = { git = "https://github.com/pyth-network/pyth-crosschain.git", subdir = "target_chains/sui/contracts", rev = "<PIN — Pyth DAO auto-upgrades Sui addrs 2026-08-18>" }

# Hashi — the native-BTC orchestrator. Only gateway.move depends on this (G7).
# Source: github.com/MystenLabs/hashi, packages/hashi/sources/  (docs/FACTS.md#hashi-move-api)
Hashi = { git = "https://github.com/MystenLabs/hashi.git", subdir = "packages/hashi", rev = "<PIN — pre-1.0, breaking changes expected>" }

[addresses]
aphotic = "0x0"
# hashi package is resolved via the Hashi dependency's named address; the Hashi SHARED OBJECT id
# (docs/FACTS.md#networks-faucets) is NOT an address — it is passed as a &mut Hashi argument at call time.

[dev-dependencies]
# none beyond the above; tests use sui::test_scenario + a local MockHashi in tests/ (see §2.6)
```

**Notes for the coding agent**
- `Wormhole` is a transitive dep of `Pyth`; let the Pyth package pull it — do not add a duplicate named address (version-conflict risk). Pin the Wormhole State id from `docs/FACTS.md#pyth-oracle` only in keeper config, not Move.
- `<PIN …>` placeholders are UNKNOWN — resolve in DAY-ONE.md (owner) by matching the on-chain testnet package versions (`docs/FACTS.md#unknowns` U9). Do NOT build against `main`/`HEAD`.
- **Seal is NOT a Move dependency.** Seal is an off-chain SDK (`docs/FACTS.md#seal-walrus-zklogin`). The only on-chain Seal surface is the `entry fun seal_approve(...)` gate in `vault.move` (§3.4); key servers dry-run it. There is no `Seal = {…}` line.
- **Walrus is NOT a Move dependency for writes.** Walrus put/get is off-chain (keeper `storage/`). The only on-chain Walrus surface is `envelope`'s *read* of the blob object for the availability check (§4.4). If that read is implemented against a Walrus system object, add its dependency then; the day-one fallback (U3-style) is to skip the on-chain blob read and enforce availability off-chain — see §4.4.

### 1.3 Cross-module dependency graph (intra-package)

```
router  ──uses──►  vault (borrow BalanceManager, TradeCap; NAV mid), envelope (pre-trade check), journal (emit)
gateway ──uses──►  vault (burn/mint shares, split Balance<BTC>, read btc_exit_address), envelope (redemption-buffer check), hashi::withdraw (EXTERNAL, G7)
envelope──uses──►  vault (read idle/pending state)  [pure checks; no external calls except optional Walrus blob read §4.4]
journal ──uses──►  vault (VaultCap gate for emit)   [leaf; emits only]
vault   ──uses──►  (leaf: sui framework only; owns caps; defines seal_approve)
```

Rule: `vault` is the leaf of truth for state; `gateway` is the sole external-Hashi boundary (G7); `envelope` is pure/read-only checks; `router` and `gateway` are the two write entrypoints that mutate positions/exits; `journal` only emits. No cycles.

---

## 2. Capability & access-control model (spans modules)

| Capability | Type location | Held by | Grants | NEVER grants |
|---|---|---|---|---|
| `VaultCap` | `vault` | vault owner (creator) | pause, set/rotate keeper (version-epoch bump), register keeper's `TradeCap` recipient, emergency withdraw, set envelope params | keeper trading; is not required for permissionless cranks |
| `KeeperCap` | `vault` | off-chain keeper | authorize `router` entrypoints + `journal::record` (proves "the registered keeper acted") | moving funds out; changing `btc_exit_address`; pausing |
| DeepBook `TradeCap` | DeepBook (`BalanceManager`) | off-chain keeper | place/cancel orders on the pool | withdraw/deposit funds (G2) |
| DeepBook `DepositCap`/`WithdrawCap` | DeepBook (`BalanceManager`) | **vault object only** (stored, never exposed to keeper) | move funds in/out of the BalanceManager | — keeper never receives these (G2) |

Golden invariant (G2): the ONLY path that moves hBTC out of the vault to Bitcoin is `gateway::exit_to_bitcoin`, which reads the write-once `btc_exit_address` from the depositor's record. No function accepts a caller-supplied destination address for an exit. A fully compromised keeper (holding `KeeperCap` + `TradeCap`) can trade and stall, but cannot steal or redirect.

### 2.6 Hashi isolation (G7)

- ONLY `gateway.move` has `use hashi::…`. Grep gate for CI: `hashi::` must appear in `sources/gateway.move` and NOWHERE else in `sources/` (see §7 verification).
- The `&mut Hashi` shared object argument is threaded from the PTB by the keeper/app using the id in `docs/FACTS.md#networks-faucets`; the module never embeds it.
- Tests mock Hashi via a local `tests/mock_hashi.move` exposing the same `request_withdrawal` / `cancel_withdrawal` shapes so `gateway_tests` run without the real package (mirror `docs/FACTS.md#hashi-move-api`). The keeper-side adapter mock (`hashi/` dir) mirrors `project_capacity()` exactly — that is the off-chain twin of §4's on-chain function (G5/G7).

---

## 3. Module `vault`

Purpose: the shared `Vault` object — sats-denominated share/NAV accounting, per-depositor write-once `btc_exit_address`, DeepBook cap custody, the `seal_approve` decryption gate, keeper/owner capability issuance, pause & emergency withdraw. Leaf of state truth.

### 3.1 Structs

```move
/// The shared vault. One per strategy instance.
public struct Vault has key {
    id: UID,
    // ── share accounting (sats-denominated NAV; G1) ──
    total_shares: u64,               // sum of all depositor shares
    idle_btc: Balance<BTC>,          // hBTC held by the vault, not resting on DeepBook
    // NOTE: hBTC resting on DeepBook lives in the BalanceManager, counted via router NAV read.
    dbusdc: Balance<DBUSDC>,         // quote inventory held idle (not on book)
    // ── DeepBook custody (G2) ──
    balance_manager_id: ID,          // the vault's BalanceManager (owns Deposit/Withdraw/TradeCap)
    // ── strategy confidentiality (Seal) ──
    strategy_ciphertext: vector<u8>, // in-object copy (degrades-not-halts on Walrus expiry)
    strategy_blob_id: vector<u8>,    // Walrus blob id of the in-force ciphertext version
    version_epoch: u64,              // Seal identity version; bumped on keeper rotation/revocation
    // ── access control ──
    owner: address,
    keeper: address,                 // the single registered keeper (holds KeeperCap + TradeCap)
    paused: bool,
    // ── envelope params (see envelope.move) ──
    envelope: EnvelopeParams,        // embedded value struct, §4.1
    // ── config: external ids passed at creation, never hardcoded (G7/G9) ──
    pool_id: ID,                     // DeepBook Pool<hBTC, DBUSDC>  (docs/FACTS.md#deepbook-venue)
}

/// Per-depositor record. Table<address, Depositor> or dynamic field keyed by depositor address.
public struct Depositor has store {
    shares: u64,
    btc_exit_address: vector<u8>,    // WRITE-ONCE; 20 (P2WPKH) or 32 (P2TR) bytes; set at first register, immutable after (G2)
    pending_exit_sats: u64,          // small-exit pool: sub-30,000-sat exits accumulate here (gateway §3.5 / §4)
}

/// Owner capability — pause, rotate keeper, set params, emergency withdraw.
public struct VaultCap has key, store { id: UID, vault_id: ID }

/// Keeper capability — authorizes router entrypoints + journal::record for the registered keeper.
public struct KeeperCap has key, store { id: UID, vault_id: ID, version_epoch: u64 }
```

Ability notes: `Vault` is `key` only (shared, non-transferable). `VaultCap`/`KeeperCap` are `key, store` (transferable to owner/keeper accounts). `Depositor` is `store` (held in a `Table`/dynamic field under the vault, never a standalone object). `EnvelopeParams` is a `store`-only value (§4.1).

### 3.2 Constructor & config

```move
/// Create + share a vault. Returns VaultCap to owner; sets up BalanceManager caps externally in the same PTB.
public fun create_vault(
    balance_manager_id: ID,
    pool_id: ID,
    strategy_ciphertext: vector<u8>,
    strategy_blob_id: vector<u8>,
    envelope: EnvelopeParams,
    keeper: address,
    ctx: &mut TxContext
): VaultCap
// shares the Vault (transfer::share_object); returns VaultCap to caller (owner = ctx sender).
// version_epoch starts at 0. paused = false. total_shares = 0.
```

### 3.3 Share / NAV math (sats; G1, G9)

NAV is denominated in **satoshis of hBTC-equivalent**, valued at the **live DeepBook mid** (G9 depeg defence — never the raw Pyth price; DBUSDC inventory is converted to sats at the book mid passed in by `router`).

Definitions (all `u64` sats unless noted):
- `nav_sats(vault, book_mid) = balance::value(&vault.idle_btc) + on_book_btc_sats + dbusdc_to_sats(vault.dbusdc, book_mid)` where `on_book_btc_sats` and any on-book quote come from the BalanceManager snapshot passed by the caller (router reads it; vault does not import DeepBook). `book_mid` is sats-per-DBUSDC scaled — see keeper `oracle/` for the exact fixed-point (`docs/KEEPER.md`).
- First deposit: `shares_minted = deposit_sats` (1 share = 1 sat bootstrap), require `deposit_sats > 0`.
- Subsequent deposit: `shares_minted = mul_div(deposit_sats, total_shares, nav_before_sats)`; require `nav_before_sats > 0`.
- Redemption: `redeem_sats = mul_div(shares_burned, nav_sats, total_shares)`; require `shares_burned <= depositor.shares`.

```move
public fun deposit_btc(
    vault: &mut Vault,
    coin_in: Coin<BTC>,
    book_mid: u128,                  // DeepBook mid, sats-scaled (G9); caller computes via router
    ctx: &mut TxContext
): u64                              // shares minted; also records/updates Depositor for sender

/// Burn shares → returns the sats value the shares represent (as a Balance<BTC> split from idle).
/// Callable by the depositor (self) or by gateway::exit_to_bitcoin (composed). NAV at book_mid (G9).
public(package) fun burn_shares_for_btc(
    vault: &mut Vault,
    who: address,
    shares_to_burn: u64,
    book_mid: u128,
    ctx: &mut TxContext
): Balance<BTC>

/// Re-credit shares + return Balance<BTC> to idle (used by gateway::reclaim_stalled_exit on a cancelled exit).
public(package) fun recredit(
    vault: &mut Vault,
    who: address,
    btc_back: Balance<BTC>,
    book_mid: u128,
)

/// Read helpers (no mutation) — used by envelope & router.
public fun idle_btc_value(vault: &Vault): u64
public fun total_shares(vault: &Vault): u64
public fun pending_exit_sats(vault: &Vault, who: address): u64
public fun btc_exit_address(vault: &Vault, who: address): vector<u8>   // aborts if unregistered
public fun is_paused(vault: &Vault): bool
public fun keeper(vault: &Vault): address
public fun pool_id(vault: &Vault): ID
public fun version_epoch(vault: &Vault): u64
public fun envelope_params(vault: &Vault): &EnvelopeParams
```

Arithmetic: use a checked `mul_div(a: u64, b: u64, c: u64): u64` (widen to `u128` internally, assert `c != 0`, assert result fits `u64`). NAV/share math must never silently truncate to zero for a non-zero deposit — assert `shares_minted > 0` after computing (abort `EZeroShares`). See `sui-pilot:oz-math` for `mul_div` hardening.

### 3.4 Seal gate

```move
/// Seal decryption gate. Each key server DRY-RUNS this before releasing a key share.
/// Identity is namespaced to the vault id + version_epoch (docs/FACTS.md#seal-walrus-zklogin).
/// MUST abort (not return bool) when access is denied — Seal treats a successful dry-run as authorization.
entry fun seal_approve(
    id: vector<u8>,          // the Seal identity bytes presented for decryption
    vault: &Vault,
    ctx: &TxContext
)
// Checks, in order (abort on first failure):
//   1. id encodes vault.id (namespacing) — abort EBadIdentityNamespace otherwise.
//   2. id's version-epoch component == vault.version_epoch (rotation/revocation) — abort EStaleVersionEpoch.
//   3. ctx sender ∈ { vault.owner, vault.keeper } (or an owner-granted disclosure set for scoped historical
//      disclosure) — abort ENotAuthorized.
// No mutation. No event (dry-run context).
```

Golden note: rotating the keeper is `set_keeper` (§3.5) which **bumps `version_epoch`**, invalidating previously derived key shares (a bare address swap would not — `docs/FACTS.md#seal-walrus-zklogin`).

### 3.5 Owner / lifecycle functions

```move
public fun set_keeper(vault: &mut Vault, cap: &VaultCap, new_keeper: address, ctx: &mut TxContext): KeeperCap
// asserts cap.vault_id == vault.id; bumps vault.version_epoch += 1 (Seal revocation); updates vault.keeper;
// mints a fresh KeeperCap{version_epoch}; emits KeeperRotated. Old KeeperCap is now stale (version mismatch).

public fun set_paused(vault: &mut Vault, cap: &VaultCap, paused: bool)          // emits Paused
public fun set_envelope(vault: &mut Vault, cap: &VaultCap, p: EnvelopeParams)   // emits EnvelopeUpdated
public fun update_strategy(vault: &mut Vault, cap: &VaultCap, ciphertext: vector<u8>, blob_id: vector<u8>)
    // updates in-object ciphertext + blob id; emits StrategyUpdated (does NOT bump version_epoch unless keeper rotates)

/// Owner-only emergency withdraw — NEVER keeper-gated (mirrors README security model).
public fun emergency_withdraw(vault: &mut Vault, cap: &VaultCap, amount: u64, ctx: &mut TxContext): Coin<BTC>
    // emits EmergencyWithdraw

/// Register/assert the keeper's authority for router/journal (checked via KeeperCap version match).
public fun assert_keeper(vault: &Vault, cap: &KeeperCap)
    // asserts cap.vault_id == vault.id AND cap.version_epoch == vault.version_epoch (stale cap ⇒ abort)
    // asserts !vault.paused
```

### 3.6 Events

| Event | Fields | Emitted when |
|---|---|---|
| `VaultCreated` | `vault_id: ID, owner, keeper, pool_id: ID` | `create_vault` |
| `Deposited` | `vault_id: ID, who: address, deposit_sats, shares_minted, nav_after_sats` | `deposit_btc` |
| `SharesBurned` | `vault_id: ID, who, shares_burned, btc_sats` | `burn_shares_for_btc` |
| `Recredited` | `vault_id: ID, who, btc_sats, shares_recredited` | `recredit` |
| `KeeperRotated` | `vault_id: ID, old_keeper, new_keeper, new_version_epoch` | `set_keeper` |
| `Paused` | `vault_id: ID, paused: bool` | `set_paused` |
| `StrategyUpdated` | `vault_id: ID, blob_id: vector<u8>, version_epoch` | `update_strategy` |
| `EnvelopeUpdated` | `vault_id: ID` | `set_envelope` |
| `EmergencyWithdraw` | `vault_id: ID, amount` | `emergency_withdraw` |

(Every externally-visible state transition emits an event — `docs/FACTS.md#events` convention.)

### 3.7 Error constants (`E<Reason>`)

`ENotOwner`, `ENotAuthorized`, `EZeroShares`, `EZeroDeposit`, `EInsufficientShares`, `EPaused`, `EStaleVersionEpoch`, `EBadIdentityNamespace`, `ECapVaultMismatch`, `EUnregisteredDepositor`, `EZeroNav`.

### 3.8 Invariants

1. `total_shares == Σ depositor.shares` after every mutating call.
2. `deposit_sats > 0 ⇒ shares_minted > 0` (no zero-share deposits; abort `EZeroShares`).
3. NAV is computed at the DeepBook mid passed in, never at a raw oracle price (G9).
4. `seal_approve` aborts on any denial; it never returns a value indicating denial.
5. `version_epoch` is monotonically non-decreasing; only `set_keeper` bumps it.
6. Keeper never touches `Deposit/WithdrawCap`; only `VaultCap` (owner) can `emergency_withdraw` (G2).
7. `book_mid == 0` aborts NAV math (`EZeroNav`).

---

## 4. Module `envelope`

Purpose: pure/read-only constraint checks enforced before any keeper action — including the **redemption-buffer** constraint tied to pending exit demand and the Guardian limiter, plus the **trustless limiter-replay** function (`project_capacity`, G5). No external calls except an optional on-chain Walrus blob-availability read (§4.4).

### 4.1 Structs

```move
public struct EnvelopeParams has store, copy, drop {
    max_slippage_bps: u64,           // per-action slippage bound vs book mid
    max_notional_per_epoch_sats: u64,// cumulative deploy cap per epoch
    min_cooldown_ms: u64,            // clock-based rebalance cooldown
    buffer_ratio_bps: u64,           // static redemption-buffer floor (fallback when queue getters absent — U3)
    // ── limiter genesis anchors (the ONLY trust anchors; docs/FACTS.md#guardian-limiter) ──
    limiter_refill_rate: u64,        // sats/s   (config; observationally boundable)
    limiter_max_capacity: u64,       // sats     (bucket cap)
    // ── epoch accounting ──
    epoch_start_ms: u64,
    epoch_notional_used_sats: u64,
    last_action_ms: u64,
}
```

### 4.2 Redemption-buffer constraint (G3)

The vault must keep enough idle hBTC to service pending exit demand given the bridge's throttle. Deployable hBTC is bounded below by a buffer:

```move
/// Returns the max sats the keeper may deploy (move onto the book / spend) right now.
public fun deployable_sats(
    vault: &Vault,
    pending_exit_demand_sats: u64,   // Σ pending_exit_sats + externally-known queued exits (caller-supplied, bounded)
    projected_capacity_sats: u64,    // from project_capacity(), §4.3 (G5) — or 0 to force the static fallback
    params: &EnvelopeParams,
): u64
// buffer = max( mul_div(nav, buffer_ratio_bps, 10_000),               // static floor (U3 fallback)
//               saturating_sub(pending_exit_demand_sats, projected_capacity_sats) )  // dynamic, bridge-aware
// deployable = saturating_sub(idle_btc_value(vault), buffer)
// Rationale (G3): if the bridge can only clear `projected_capacity_sats` of exits, the vault must hold the
// UNSERVICEABLE remainder idle. You cannot buy priority; the buffer, not a priority lever, is the response.
```

### 4.3 Trustless limiter replay — `project_capacity` (G5)

This is the on-chain twin of the keeper `verify` replay. It re-derives available bucket capacity from the two genesis anchors + elapsed time; the keeper feeds `tokens` as the value replayed from the `WithdrawalSigned` event stream (`docs/FACTS.md#guardian-limiter`). Pure function, no state read — deterministic and independently checkable.

```move
/// Mirror of Hashi's LocalLimiter.project_capacity() EXACTLY (docs/FACTS.md#guardian-limiter):
///   project_capacity() = min(cap, tokens + elapsed * refill_rate)
/// `tokens` and `last_signed_ms` are replayed on-chain/off-chain from WithdrawalRequested/PickedForProcessing/Signed.
public fun project_capacity(
    tokens_sats: u64,                // bucket tokens at last WithdrawalSigned
    last_signed_ms: u64,             // timestamp of that event
    now_ms: u64,                     // clock now
    refill_rate: u64,                // sats/s (genesis anchor)
    max_capacity: u64,               // sats   (genesis anchor)
): u64 {
    let elapsed_s = (now_ms - last_signed_ms) / 1000;
    let refilled = tokens_sats + elapsed_s * refill_rate;   // widen to u128 to avoid overflow, then min
    min_u64(refilled, max_capacity)
}
```

Golden note (G5): this function is the reason the bridge-aware envelope is ~99% trustless, not "keeper-attested". The keeper `verify/` re-runs this exact arithmetic over Hashi's own event stream; the two genesis scalars are the only trust anchors and are observationally boundable. Keep the formula byte-identical to the keeper mock and to Hashi's `LocalLimiter` — `sui-pilot:oz-math` for the overflow-safe widen.

### 4.4 Other pre-action checks

```move
/// Full pre-action gate — router/gateway call this before mutating. Aborts on any violation.
public fun check_action(
    vault: &Vault,
    params: &mut EnvelopeParams,     // &mut to advance epoch_notional_used + last_action_ms
    action_notional_sats: u64,
    book_mid: u128,
    oracle_mid: u128,                // Pyth BTC/USD, sats-scaled — divergence breaker only (G9)
    clock: &Clock,
): ()
// Order (abort on first failure):
//   1. !vault.paused                                   → EPaused
//   2. now - last_action_ms >= min_cooldown_ms         → ECooldown
//   3. divergence(book_mid, oracle_mid) <= threshold   → EOracleDivergence   (G9 circuit breaker)
//   4. action_notional_sats <= deployable_sats(...)    → EBufferBreach        (G3 redemption buffer)
//   5. epoch_notional_used + action_notional <= max_notional_per_epoch → ENotionalCap (roll epoch on boundary)
//   6. slippage(action, book_mid) <= max_slippage_bps  → ESlippage
// On success: epoch_notional_used += action_notional_sats; last_action_ms = now; emit EnvelopeChecked.

/// OPTIONAL on-chain strategy-availability read (docs/FACTS.md#seal-walrus-zklogin).
/// Day-one fallback (U3-style): if the Walrus system object read is not wired, SKIP this and enforce
/// availability off-chain (keeper storage/ renewal). Vault retains in-object ciphertext so expiry
/// degrades verifiability, not liveness.
public fun assert_strategy_available(/* walrus blob object ref */ ...): ()   // certified, unexpired, not deletable
```

### 4.5 Events & errors

Events: `EnvelopeChecked { vault_id, action_notional_sats, deployable_sats, projected_capacity_sats, book_mid }`.

Error constants: `EPaused`, `ECooldown`, `EOracleDivergence`, `EBufferBreach`, `ENotionalCap`, `ESlippage`, `EBlobUnavailable`.

### 4.6 Invariants

1. `project_capacity` is pure and matches Hashi's `LocalLimiter` and the keeper mock byte-for-byte (G5).
2. `deployable_sats <= idle_btc_value(vault)` always (saturating; never negative/underflow).
3. Nothing in `envelope` reorders, prioritizes, or assumes queue-jumping (G3).
4. `check_action` is the ONLY place epoch notional advances; it is idempotent per action (mutates once).
5. NAV/valuation inputs are DeepBook-mid derived; oracle is used only for the divergence breaker (G9).

---

## 5. Module `router`

Purpose: DeepBook v3 maker-first execution — `POST_ONLY` maker leg + IOC sweep on the SAME `Pool<hBTC, DBUSDC>`. **NO Cetus, NO CLMM ranges** (G4). Keeper-gated by `KeeperCap`; every action passes `envelope::check_action` first.

### 5.1 Entry functions

```move
/// Place a maker order: POST_ONLY limit on Pool<hBTC, DBUSDC>. Keeper-only.
entry fun place_maker(
    vault: &mut Vault,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,   // vault's BM
    trade_cap: &TradeCap,                   // keeper holds this ONLY (G2)
    pool: &mut Pool<BTC, DBUSDC>,           // docs/FACTS.md#deepbook-venue (id validated == vault.pool_id)
    is_bid: bool,
    price: u64,                             // must respect tick 1_000_000
    quantity: u64,                          // must respect lot 1_000 and min_size 100_000 (docs/FACTS.md#deepbook-venue)
    expire_ts: u64,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext
)
// POST_ONLY flag (order type); self-match prevention ENABLED (docs/FACTS.md#deepbook-venue).
// Calls vault::assert_keeper + envelope::check_action(action_notional = quantity·price) BEFORE placing.
// Emits MakerPlaced.

/// IOC sweep of the residual on the SAME book (G4 — never Cetus). Keeper-only.
entry fun sweep_ioc(
    vault: &mut Vault,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,
    trade_cap: &TradeCap,
    pool: &mut Pool<BTC, DBUSDC>,
    is_bid: bool,
    max_price: u64,
    quantity: u64,
    book_mid: u128,
    oracle_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext
)
// IOC order type on Pool<hBTC, DBUSDC>. Same envelope gate. Emits IocSwept { filled_qty, avg_price }.

/// Cancel an unfilled maker remainder (keeper lifecycle; also used before re-route). Keeper-only.
entry fun cancel_maker(
    vault: &mut Vault,
    keeper_cap: &KeeperCap,
    balance_manager: &mut BalanceManager,
    trade_cap: &TradeCap,
    pool: &mut Pool<BTC, DBUSDC>,
    order_id: u128,
    ctx: &mut TxContext
)
// Emits MakerCancelled.
```

### 5.2 NAV mid helper (read-only, DeepBook)

```move
/// Compute the sats-scaled book mid from a Pool L2 read for NAV/valuation (G9 depeg defence).
public fun book_mid(pool: &Pool<BTC, DBUSDC>): u128
// (best_bid + best_ask) / 2, sats-scaled. Used by vault NAV, envelope divergence, deposit/exit valuation.
// If the book is one-sided/empty (thin testnet book, docs/FACTS.md#deepbook-venue U8), abort EEmptyBook —
// caller falls back to last-known/oracle-bounded mid per keeper policy.
```

### 5.3 Events & errors

Events: `MakerPlaced { vault_id, order_id, is_bid, price, quantity }`, `IocSwept { vault_id, is_bid, filled_qty, avg_price }`, `MakerCancelled { vault_id, order_id }`.

Error constants: `EWrongPool`, `ENotKeeper`, `EBadTick`, `EBadLot`, `EBelowMinSize`, `EEmptyBook`, `ENotPostOnly`.

### 5.4 Invariants

1. `pool` object id == `vault.pool_id` (config-checked) — abort `EWrongPool`. No hardcoded pool id (G7).
2. NO Cetus/CLMM import or code path exists in this module (G4). CI grep gate: `cetus` must not appear in `sources/`.
3. Maker leg is `POST_ONLY`; a non-post-only maker placement aborts `ENotPostOnly`.
4. `price % tick == 0`, `quantity % lot == 0`, `quantity >= min_size` (values from `docs/FACTS.md#deepbook-venue`, passed as config).
5. Every entrypoint calls `vault::assert_keeper` + `envelope::check_action` before touching the book.
6. Keeper holds `TradeCap` only; router never calls a Withdraw/Deposit path (G2).
7. Self-match prevention enabled on placement.

---

## 6. Module `gateway`  (THE ONLY Hashi boundary — G7)

Purpose: the sole module importing `hashi::*`. Registers the write-once `btc_exit_address`; composes `hashi::withdraw::request_withdrawal` in the same PTB that burns shares (destination pinned on-chain — G2); wraps `hashi::withdraw::cancel_withdrawal` for stalled-exit reclaim; and pools sub-30,000-sat exits until they clear the Hashi minimum.

External signatures composed (verbatim from `docs/FACTS.md#hashi-move-api`):
- `public fun request_withdrawal(hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>, bitcoin_address: vector<u8>, ctx: &mut TxContext)` — asserts amount ≥ 30,000 sats; addr 20 or 32 bytes; emits `WithdrawalRequested`.
- `public fun cancel_withdrawal(hashi: &mut Hashi, request_id: address, clock: &Clock, ctx: &mut TxContext): Balance<BTC>` — requester-only; only Requested/Approved (pre-commit); 1h cooldown.

### 6.1 `register_exit_address` (write-once; G2)

```move
/// Bind the depositor's Bitcoin payout address. WRITE-ONCE: first call sets it; any later call aborts.
public fun register_exit_address(
    vault: &mut Vault,
    addr: vector<u8>,                // 20 bytes (P2WPKH) or 32 bytes (P2TR) — else abort EBadAddressLength
    ctx: &mut TxContext
)
// asserts sender has (or is creating) a Depositor record; asserts addr length ∈ {20, 32};
// asserts depositor.btc_exit_address is empty (write-once) — else abort EExitAddressAlreadySet.
// emits ExitAddressRegistered { vault_id, who, addr_len }.  (addr itself is public on-chain — state it; docs/FACTS.md)
```

### 6.2 `exit_to_bitcoin` — composed, destination-pinned burn→withdraw (G1, G2, G3)

Runs in ONE PTB: burn shares → split `Balance<BTC>` from vault → call Hashi with the PINNED address. The destination is read from the vault, NOT a caller argument — a compromised keeper/frontend cannot redirect.

```move
public fun exit_to_bitcoin(
    vault: &mut Vault,
    hashi: &mut Hashi,               // the Hashi shared object (id from docs/FACTS.md#networks-faucets, PTB-supplied)
    shares_to_burn: u64,
    book_mid: u128,
    params: &mut EnvelopeParams,
    clock: &Clock,
    ctx: &mut TxContext
)
// 1. who = ctx sender; addr = vault::btc_exit_address(vault, who)  ← PINNED, write-once (G2). Abort EExitAddressUnset if empty.
// 2. btc: Balance<BTC> = vault::burn_shares_for_btc(vault, who, shares_to_burn, book_mid, ctx)
// 3. let amount = balance::value(&btc);
//    if amount < HASHI_WITHDRAWAL_MIN (30,000, from config/getter): // small-exit pooling (G3 / §6.4)
//        vault::add_pending_exit(vault, who, btc); emit ExitPooled{...}; return;
// 4. else: hashi::withdraw::request_withdrawal(hashi, clock, btc, addr, ctx);  // Balance<BTC> consumed by Hashi
//    emit ExitRequested { vault_id, who, amount, addr_len }.  // Hashi also emits WithdrawalRequested
// NOTE (G1): step 2–4 are INSTANT on Sui; the ~1.5–2h latency is entirely inside Hashi AFTER this returns.
// NOTE: envelope check here is a *withdrawal* buffer sanity (does this exit respect pooling/min), not a deploy cap.
```

### 6.3 `reclaim_stalled_exit` — wraps `cancel_withdrawal` (G2)

```move
/// If an exit stalls (pre-commit: Requested/Approved) and the 1h cooldown has passed, reclaim the Balance<BTC>
/// back into the vault and re-credit the depositor's shares.
public fun reclaim_stalled_exit(
    vault: &mut Vault,
    hashi: &mut Hashi,
    request_id: address,             // the stalled Hashi withdrawal request id
    who: address,                    // depositor to re-credit (must match the original requester)
    book_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext
)
// btc_back: Balance<BTC> = hashi::withdraw::cancel_withdrawal(hashi, request_id, clock, ctx);  // requester-only, 1h cooldown, pre-commit only
// vault::recredit(vault, who, btc_back, book_mid);
// emit ExitReclaimed { vault_id, who, request_id, amount }.
// Abort surfaces Hashi's own aborts (not requester / post-commit / cooldown) — do NOT swallow them.
```

### 6.4 Small-exit pooling (< 30,000 sats; G3)

```move
/// Flush a depositor's pooled pending exit once it clears the Hashi minimum.
public fun flush_pending_exit(
    vault: &mut Vault,
    hashi: &mut Hashi,
    who: address,
    clock: &Clock,
    ctx: &mut TxContext
)
// let pooled = vault::take_pending_exit(vault, who);   // Balance<BTC>
// assert balance::value(&pooled) >= HASHI_WITHDRAWAL_MIN else abort EBelowHashiMinimum;
// addr = vault::btc_exit_address(vault, who);  hashi::withdraw::request_withdrawal(hashi, clock, pooled, addr, ctx);
// emit ExitRequested { ... }.

/// Alternatively the depositor opts to take the pooled sub-minimum amount as hBTC coin instead of waiting.
public fun take_pending_as_hbtc(vault: &mut Vault, ctx: &mut TxContext): Coin<BTC>   // emits PendingTakenAsHbtc
```

`HASHI_WITHDRAWAL_MIN` (30,000 sats) and the dust floor (546 sats) come from `docs/FACTS.md#latencies` — pass as config or read `config.bitcoin_withdrawal_minimum()` if the getter is available (U3). Never hardcode in logic beyond a named, config-overridable constant (G7).

### 6.5 Events & errors

Events: `ExitAddressRegistered`, `ExitRequested`, `ExitPooled`, `ExitReclaimed`, `PendingTakenAsHbtc`. (Hashi additionally emits `WithdrawalRequested`/`Cancelled` — the keeper watches both; `docs/FACTS.md#events`.)

Error constants: `EBadAddressLength`, `EExitAddressAlreadySet`, `EExitAddressUnset`, `EBelowHashiMinimum`, `ENotDepositor`, `ERequesterMismatch`.

### 6.6 Invariants

1. `btc_exit_address` is write-once; no code path mutates it after first set (G2). This is the anti-redirect guarantee.
2. `exit_to_bitcoin` reads the destination from the vault record, NEVER from a caller argument (G2).
3. `gateway` is the ONLY module with `use hashi::…` (G7 — CI grep gate, §7).
4. Exits below 30,000 sats are pooled or taken as hBTC; they are NEVER submitted to Hashi (would abort) (G3).
5. `reclaim_stalled_exit` surfaces Hashi's aborts (requester-only / pre-commit / 1h cooldown) rather than masking them (G3 — no queue-jump assumptions).
6. All Sui-side steps are instant (G1); no function blocks on Bitcoin confirmation.

---

## 7. Package-wide verification (acceptance criteria)

Run from `move/`. All must pass before the package is considered done.

| # | Command | Acceptance |
|---|---|---|
| V1 | `sui move build` | compiles clean, edition `2024.beta`, no warnings on unused caps/params |
| V2 | `sui move test` | all `tests/*_tests.move` green (see §8) |
| V3 | `grep -rl 'hashi::' sources/` | returns EXACTLY `sources/gateway.move` (G7 isolation) |
| V4 | `grep -ril 'cetus\|clmm' sources/` | returns NOTHING (G4 — no Cetus/CLMM in the BTC vault) |
| V5 | `grep -rn '0x[0-9a-f]\{40,\}' sources/` | returns NOTHING in module logic — all external ids are config/params (G7). Named constants for tick/lot/min_size/withdrawal-min are the only allowed literals, and each is config-overridable |
| V6 | prover (optional) | `sui-pilot:specify` then `sui-pilot:verify` on `seal_approve`, `deployable_sats`, `project_capacity`, `mul_div` share math — the four correctness-critical fns |

Also: run `sui-pilot:move-code-quality` (Move 2024 idioms, G10) and `sui-pilot:move-code-review` (access-control/arithmetic) before hand-off.

---

## 8. Per-module test checklist (`tests/`)

Use `sui::test_scenario`; mock Hashi via `tests/mock_hashi.move` (§2.6). Encode the golden rules as assertions.

### `vault_tests.move`
- [ ] first deposit: `shares_minted == deposit_sats`; `total_shares` invariant holds.
- [ ] proportional deposit: `shares == mul_div(deposit_sats, total_shares, nav_before)`; non-zero deposit never yields 0 shares (abort `EZeroShares` on the degenerate case).
- [ ] NAV valued at passed `book_mid`, not oracle (G9); `book_mid == 0` aborts `EZeroNav`.
- [ ] `seal_approve` aborts for wrong namespace (`EBadIdentityNamespace`), stale epoch (`EStaleVersionEpoch`), non-authorized sender (`ENotAuthorized`); succeeds (no abort) for owner/keeper with matching epoch.
- [ ] `set_keeper` bumps `version_epoch`; old `KeeperCap` fails `assert_keeper` (`ECapVaultMismatch`/stale) (Seal revocation).
- [ ] `emergency_withdraw` requires `VaultCap`; keeper's `KeeperCap` cannot call it (G2).
- [ ] `paused` blocks keeper actions; owner can still `emergency_withdraw`.

### `envelope_tests.move`
- [ ] `project_capacity` matches the exact formula `min(cap, tokens + elapsed_s·refill_rate)` incl. a table of vectors identical to the keeper mock (G5); no overflow on large `elapsed`.
- [ ] `deployable_sats`: when `pending_exit_demand > projected_capacity`, buffer holds the UNSERVICEABLE remainder idle (G3); deployable is `saturating_sub` (never underflows).
- [ ] static fallback: with `projected_capacity == 0`, buffer == `buffer_ratio_bps` floor (U3 path).
- [ ] `check_action`: cooldown (`ECooldown`), oracle divergence breaker (`EOracleDivergence`, G9), buffer breach (`EBufferBreach`), epoch notional cap (`ENotionalCap`), slippage (`ESlippage`) each abort in order; epoch notional advances exactly once on success.
- [ ] no function reorders/prioritizes exits (G3) — asserted structurally (review, not runtime).

### `router_tests.move`
- [ ] `place_maker` rejects non-`POST_ONLY` (`ENotPostOnly`), bad tick/lot/min_size (`EBadTick`/`EBadLot`/`EBelowMinSize`) using `docs/FACTS.md#deepbook-venue` values.
- [ ] wrong pool id aborts `EWrongPool` (config check, G7).
- [ ] every entrypoint calls `assert_keeper` + `envelope::check_action` before touching the book (keeper without valid cap aborts `ENotKeeper`).
- [ ] `sweep_ioc` fills on the same book; NO Cetus path reachable (G4).
- [ ] `book_mid` aborts `EEmptyBook` on a one-sided/empty book (thin testnet, U8).

### `gateway_tests.move`
- [ ] `register_exit_address`: accepts 20 & 32 bytes; rejects other lengths (`EBadAddressLength`); second call aborts (`EExitAddressAlreadySet`) — write-once (G2).
- [ ] `exit_to_bitcoin`: destination passed to (mock) `request_withdrawal` == the PINNED vault address, NEVER a caller argument, even if the caller tries to pass one (there is no such parameter) (G2).
- [ ] exit `>= 30,000` sats calls `request_withdrawal`; exit `< 30,000` sats is POOLED (`ExitPooled`), never submitted (G3).
- [ ] `flush_pending_exit` aborts `EBelowHashiMinimum` until the pool clears 30,000; then submits.
- [ ] `reclaim_stalled_exit`: mock cancel returns `Balance<BTC>`; vault re-credited via `recredit`; Hashi requester/cooldown aborts surface (not swallowed) (G3).
- [ ] Sui-side legs complete in one PTB with no wait/block (G1).
- [ ] isolation: this is the only test file exercising `hashi::` (mirrors G7 grep gate V3).

### `journal_tests.move` (module `journal`, §9)
- [ ] `record` requires a valid `KeeperCap` (stale/wrong cap aborts).
- [ ] `DecisionRecorded` carries the correct blob id bytes; blob id is opaque `vector<u8>` (content-addressed, self-certifying — `docs/FACTS.md#seal-walrus-zklogin`).

---

## 9. Module `journal`

Purpose: emit decision-log Walrus blob ids on-chain so the off-chain decision record is self-certifying and the on-chain pointer cannot be substituted. Leaf; emits only.

### 9.1 Function & event

```move
/// Emit the blob id of a decision-log segment. Keeper-gated. The heavy record lives off-chain in Walrus;
/// only the content-addressed blob id is anchored on-chain (docs/FACTS.md#seal-walrus-zklogin).
public fun record(
    vault: &Vault,
    keeper_cap: &KeeperCap,
    blob_id: vector<u8>,             // Walrus blob id — content-derived, self-certifying
    seq: u64,                        // monotonically increasing segment sequence
    ctx: &mut TxContext
)
// asserts vault::assert_keeper(vault, keeper_cap);
// emits DecisionRecorded { vault_id, seq, blob_id }.
```

Event: `DecisionRecorded { vault_id: ID, seq: u64, blob_id: vector<u8> }`.
Error constants: `EStaleSeq` (if a seq check is enforced), plus the shared keeper-gate aborts from `vault::assert_keeper`.

### 9.2 Invariants
1. `record` is keeper-gated (valid `KeeperCap`, current version_epoch).
2. Blob id is emitted verbatim as opaque bytes; the module never interprets or trusts its contents (self-certifying by construction).
3. `seq` is monotonically increasing per vault (replay ordering for the keeper `verify/` engine, G5).

---

## 10. Cross-reference index

| Need | Where |
|---|---|
| Exact hBTC coin type, `Coin<BTC>` semantics | `docs/FACTS.md#hbtc` |
| `request_withdrawal` / `cancel_withdrawal` / `deposit` / `confirm_deposit` signatures | `docs/FACTS.md#hashi-move-api` |
| Deposit ~70min / withdraw ~1.5–2h / 30,000-sat min / 546-sat dust | `docs/FACTS.md#latencies` |
| `project_capacity()` formula + trust anchors + replay | `docs/FACTS.md#guardian-limiter` |
| Pool id, tick 1_000_000 / lot 1_000 / min_size 100_000, DBUSDC type, DeepBook callable pkg | `docs/FACTS.md#deepbook-venue` |
| Pyth State/pkg/Wormhole, Beta feed rule, NAV-at-mid, divergence breaker | `docs/FACTS.md#pyth-oracle` |
| Seal `seal_approve`, version epoch, Walrus blob availability/expiry | `docs/FACTS.md#seal-walrus-zklogin` |
| Hashi/DeepBook event families | `docs/FACTS.md#events` |
| Hashi shared-object id (testnet/devnet) | `docs/FACTS.md#networks-faucets` |
| Open questions (framework/dep revs, Hashi getters, feed id) | `docs/FACTS.md#unknowns` (U2, U3, U5, U8, U9) |
| System object/capability graph + the four flows | `docs/ARCHITECTURE.md` |
| Keeper adapter mock mirroring `project_capacity`, PTB build, `verify` replay | `docs/KEEPER.md` |

---

## ERRATA (2026-07-25)

> Source: `docs/DAY-ONE-RESULTS.md` (live probes) + `docs/RECON.md`. Canonical values live in `docs/FACTS.md`.
> **Where this section conflicts with the body of MOVE-PACKAGE.md above, this section wins.** Each item is WAS / IS / WHY. Nothing above was deleted: treat the body as the design intent and this list as the corrections a coding agent must apply while implementing it.
> **Also supersedes:** the §1.2 note that the `<PIN …>` dependency revs are "UNKNOWN — resolve in DAY-ONE.md". They are resolved — see E-M1.

### E-M1 — §1.2 `Move.toml` is stale in four separate ways

- **WAS:** a `[dependencies]` block with an explicit `Sui = { git … rev = "<PIN>" }` line, a `Pyth = { git … }` line, an `[addresses]` block with `aphotic = "0x0"`, and `<PIN …>` placeholders described as UNKNOWN.
- **IS:**
  ```toml
  [package]
  name = "aphotic"
  edition = "2024"

  [dependencies]
  hashi    = { git = "https://github.com/MystenLabs/hashi.git",      subdir = "packages/hashi",    rev = "d9ad6bf440a737a23e0a239d4dfe5a6a51a1de9f" }
  deepbook = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb" }
  ```
  No `Sui` dependency line, no `[addresses]` block, no `[dep-replacements]`, and **no Pyth dependency at all**.
- **WHY:** both upstreams ship a `Published.toml` with `[published.testnet]`, so the **new** Move package manager (`Move.lock` v4, `sui_system = { system = "sui_system" }`) resolves `published-at`/`original-id` and the framework automatically. Adding `Sui = {git…}` or `[addresses]` re-introduces the old system and fights it. Pyth's Sui contracts are `edition = "legacy"` with a heavy pinned Wormhole dep, and **nothing in our Move calls Pyth** — §4 already takes `oracle_mid: u128` as a parameter, so the dependency buys nothing and risks the whole build. The revs are no longer UNKNOWN. See `docs/FACTS.md#move-deps`.

### E-M2 — §1.1 tests must live in `move/tests/`, not `move/sources/tests/`

- **WAS:** the directory tree places `vault_tests.move`, `gateway_tests.move`, … under `move/sources/tests/`.
- **IS:** `move/tests/*.move` (sibling of `sources/`, the Move 2024 default), with the Hashi mock at `move/tests/mock_hashi.move`.
- **WHY:** `gateway_tests.move` necessarily contains `hashi::`. Under `sources/tests/` the G7 isolation gate `grep -rl 'hashi::' move/sources/` returns two files instead of exactly `sources/gateway.move`, and the gate can never go green. Recorded in `docs/FACTS.md#conventions`.

### E-M3 — the withdrawal minimum must be a CONSTANT; the getter is not callable

- **WAS:** §6.4 and the touchpoint table treat `config.bitcoin_withdrawal_minimum()` as a Move call site.
- **IS:** `const HASHI_WITHDRAWAL_MIN_SATS: u64 = 30_000;` in `gateway.move`. Same for every other Hashi config scalar the package needs (dust floor `546`, cancellation cooldown `3_600_000` ms, deposit delay `600_000` ms).
- **WHY:** verified against deployed bytecode — **all 15** `hashi::btc_config` accessors are `Friend` (`public(package)`) and therefore not callable from `aphotic`. See `docs/FACTS.md#hashi-move-api` and `#hashi-onchain-config` for the full live config table.

### E-M4 — there is NO on-chain queue-depth getter; the envelope fallback is unconditional

- **WAS:** §4 and the touchpoint table hedge with "envelope queue-depth read (pending day-one check)", and `docs/FACTS.md#unknowns` U3 was open — implying a branch to write.
- **IS:** **U3 = NO.** All 46 `hashi::withdrawal_queue` getters are `public(package)` (only `output_utxo` is `Public`). `envelope.move` implements the static-redemption-buffer + off-chain-event-replay path **unconditionally**. Do not write an "if the getter exists" branch; there is nothing to call.
- **WHY:** on-chain visibility dump, `docs/DAY-ONE-RESULTS.md` §D2.

### E-M5 — §4.3 `project_capacity`: time base, saturation, and two wrong golden vectors

- **WAS:** `project_capacity(tokens_sats, last_signed_ms, now_ms, refill_rate, max_capacity)` with `elapsed_s = (now_ms - last_signed_ms) / 1000`, plus RECON R9's vectors #1/#7 expecting `105_000`.
- **IS:** the time base is **UNIX SECONDS** (`refillRateSatsPerSec`, `lastUpdatedAtSecs` — the guardian's own field names), so the ms→s division at the boundary is right, but:
  - `now_ms - last_signed_ms` must be **saturating** (`if (now_ms <= last_signed_ms) 0 else …`) — a plain `u64` subtraction **aborts** on out-of-order events, and out-of-order events do occur.
  - `tokens_sats + elapsed_s * refill_rate` must widen to `u128` before the `min`, then narrow — `u64` add/mul abort on overflow, and a 100 BTC bucket × large elapsed overflows.
  - **Golden vectors #1 and #7 expect `100_150`, not `105_000`.** `100_000 + 15 × 10 = 100_150`; confirmed against the upstream `@mysten/hashi` implementation.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10d. The corrected vector table lives in `docs/FACTS.md#guardian-limiter` and is shared verbatim with `keeper/src/hashi/limiter.ts`. Shipping `105_000` means the Move↔TS cross-test can never go green.
- **Also:** the live scalars are now known — `refill_rate = 115_740` sats/s, `max_bucket_capacity = 10_000_000_000` sats (100 BTC). The old `1000` / `100_000_000` prior was wrong by ~100×.

### E-M6 — §5.1/§5.2 `router` must not call three functions that are not deployed

- **WAS:** implied use of DeepBook's convenience reads/wrappers.
- **IS:** the deployed DeepBook package (v20, `0xd874d241…`) **does not contain** `best_bid_price`, `best_ask_price`, or `place_post_only_limit_order`, even though the pinned dep rev's source does. Therefore:
  - maker leg = `pool::place_limit_order(…, order_type = 3 /* POST_ONLY */, self_matching_option = 0 /* SELF_MATCHING_ALLOWED */, …)`;
  - `book_mid` derives top-of-book from **`pool::get_level2_range`**, never `pool::mid_price`.
- **WHY:** an 88-vs-85 public-function diff between the pinned rev and the deployed module. A call to a function absent from the linked package **compiles and then fails at publish/link time** — a trap that surfaces only at deploy. `docs/DAY-ONE-RESULTS.md` §D3b, `docs/FACTS.md#deepbook-venue`.

### E-M7 — §5.2 `book_mid` on an empty book: the two reads behave differently

- **WAS:** one abort path (`EEmptyBook`) implied for the whole read.
- **IS:** verified live against the real pool — `pool::mid_price` **aborts** with `deepbook::book` code **`2` = `EEmptyOrderbook`**; `pool::get_level2_range` **succeeds and returns `([], [])`**. The hBTC/DBUSDC book is **empty on both sides right now**.
- **WHY:** if `book_mid` wraps `mid_price`, NAV aborts on the book's *current* state. Read with `get_level2_range`, treat empty vectors as "no mid", and let the caller fall back to the oracle-bounded last-known mid. `docs/DAY-ONE-RESULTS.md` §D3a.

### E-M8 — §6.3 `reclaim_stalled_exit` is DEPOSITOR-ONLY; the keeper can never call it

- **WAS:** "requester-only" mentioned as a property of `cancel_withdrawal`, without the design consequence being made binding.
- **IS:** `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()`. The request sender is whoever signed the PTB that called `request_withdrawal`. Therefore `gateway::reclaim_stalled_exit` **must be callable only by the depositor**, and:
  - **INVARIANT (add to §6.6):** any small-exit **flush** entrypoint must assert `who == ctx.sender()`. Otherwise the flusher becomes the request sender and the **only** party who can ever reclaim — silently converting pooled exits into funds only a third party can rescue.
- **WHY:** source- and bytecode-verified. `docs/FACTS.md#hashi-move-api`, `docs/RECON.md` R7.3.

### E-M9 — `confirm_deposit` is `entry` and cannot be composed from Move

- **WAS:** listed under Hashi touchpoints alongside the composable functions.
- **IS:** `hashi::deposit::{deposit, confirm_deposit, approve_deposit, delete_expired_deposit}` are all `visibility=Private, isEntry=true` on-chain. They are **PTB commands**, not Move-callable. The permissionless crank lives in the keeper/app PTB builder and must **never** appear as a `moveCall` inside `gateway.move`. The entire Move-composable Hashi surface is exactly two functions: `request_withdrawal` and `cancel_withdrawal`.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D2.

### E-M10 — DeepBook package ids: v20 for calls, the ORIGINAL for types

- **WAS:** a single "DeepBook testnet callable package `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c`".
- **IS:** three ids with distinct roles — original/type-origin `0xfb28c4cb…` (v1, what every `Pool`/`BalanceManager`/`TradeCap` **type** resolves to), superseded `0x22be4cad…` (v17, **do not use**), current callable `0xd874d241…` (v20, every `moveCall` **target**).
- **WHY:** `docs/FACTS.md#deepbook-venue`. In Move source the package manager handles this, but any test or script writing an id literal must pick the right one.

### E-M11 — §4.4 the on-chain Walrus availability check would reject our own fresh blobs

- **WAS:** "`envelope.move` reads the Walrus blob object on-chain (certified, unexpired, not deletable) before permitting a keeper action".
- **IS:** a blob written through the public testnet publisher comes back **`"certifiedEpoch": null`** and **`"deletable": true`**. A predicate demanding *certified* **and** *non-deletable* rejects our own writes at the moment we make them.
- **WHY:** measured on a real PUT (`docs/DAY-ONE-RESULTS.md` §D8). Either relax the predicate (grace window before requiring certification; do not require non-deletable), or register storage explicitly as non-deletable before the check goes live. The safe day-one position is the one §1.2 already names: enforce availability off-chain and keep the on-chain read out of the critical path.

### E-M12 — Pyth: no Move dependency, and the testnet feed id is the BETA one

- **WAS:** §1.2 Pyth dependency + `<PIN>`; feed id marked UNKNOWN.
- **IS:** no Pyth Move dependency (E-M1). The keeper reads Pyth and passes `oracle_mid: u128` in. Testnet BTC/USD feed id = `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b` (Beta channel).
- **WHY:** `docs/FACTS.md#pyth-oracle`, `docs/DAY-ONE-RESULTS.md` §D5.

### E-M13 — doc hygiene: a stray unmatched code fence was removed

- **WAS:** the last line of the §Cross-references table was a bare `````` with no opening fence.
- **IS:** removed.
- **WHY:** it opened a code block that swallowed everything appended after it (including this ERRATA section) in any markdown renderer. One-line fix; no content changed.
