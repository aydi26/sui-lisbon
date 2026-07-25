# RECON.md — verified ground truth, 2026-07-25

> Purpose: every fact below was verified live this session (on-chain read, HTTP probe, or upstream source fetch). **Do NOT re-derive any of it.** Where it contradicts another doc, RECON wins until `docs/FACTS.md` is updated to match (owner: the DAY-ONE unit).
> Read after: `docs/GOLDEN-RULES.md`. Cross-ref: `docs/FACTS.md`, `docs/DAY-ONE.md`.

## R1 — RPC transport

| Fact | Value |
|---|---|
| `https://fullnode.testnet.sui.io:443` **JSON-RPC** | **404 — removed.** The node serves **gRPC v2** only (`/sui.rpc.v2.LedgerService/*`). |
| `sui` CLI 1.76.0 against that endpoint | **WORKS** (uses gRPC internally). `sui client gas` verified. |
| `@mysten/sui@2.22.1` subpath exports | includes `./grpc` (`SuiGrpcClient`) and `./jsonRpc` (`SuiJsonRpcClient`). No peer deps. |
| **Decision** | **`SuiGrpcClient` at `https://fullnode.testnet.sui.io:443` is the default transport.** Constructed in exactly one place (`keeper/src/sui/client.ts`); everything else imports that factory. |
| JSON-RPC mirrors (verified, chain id `4c78adac`) | `https://rpc-testnet.suiscan.xyz:443` · `https://sui-testnet-rpc.publicnode.com` · `https://sui-testnet.nodeinfra.com`. Kept for probes/cross-checks only. `sui-testnet.public.blastapi.io` is **dead (403)**. |
| Not supported on any mirror | `suix_getNormalizedMoveModulesByPackage` |

## R2 — Toolchain (installed this session)

| Tool | State |
|---|---|
| `sui` | **1.76.0-6effb4523834** at `%LOCALAPPDATA%\sui\sui.exe`, on the user PATH. |
| node / npm / pnpm / docker / git | 24.13.0 / 11.6.2 / 11.12.0 / 29.2.0 / 2.48.1 |
| cargo, rustc, gh | absent (not needed) |
| Sui keystore | 3 addresses. Active: `0x883ff25499d099a0e578a781acf03ff251647ca2430a2cef03257b080ea01125` (1.86 SUI). Imported from the user's key: **`0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d`** (2.00 SUI) — this is the deployer/keeper address. |
| Secret handling | The private key lives **only** in the OS Sui keystore and `keeper/.env` (gitignored). Never in `.env.example`, any doc, or a commit. |

## R3 — Move dependencies (both resolvable; no address overrides needed)

Both upstream packages ship a `Published.toml` with `[published.testnet]`, so the new Move package manager resolves `published-at` / `original-id` automatically. **No `[dep-replacements]` block is required.**

| Package | git | subdir | pinned rev |
|---|---|---|---|
| `hashi` | `https://github.com/MystenLabs/hashi.git` | `packages/hashi` | `d9ad6bf440a737a23e0a239d4dfe5a6a51a1de9f` |
| `deepbook` | `https://github.com/MystenLabs/deepbookv3.git` | `packages/deepbook` | `0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb` |

- Hashi `Published.toml [published.testnet]`: `published-at = original-id = 0xfcea10ca…`, version 1, chain-id `4c78adac`.
- DeepBook `Published.toml [published.testnet]`: `original-id = 0xfb28c4cb…`, `published-at = 0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24`, **version 20**.
- Both use `Move.lock` v4 / `sui_system = { system = "sui_system" }` — the **new** package system. Do **not** add explicit `Sui = {git…}` / `[addresses]` lines.
- Framework rev both upstreams pin: `22f9fc9781732d651e18384c9a8eb1dabddf73a6`.
- **No Pyth Move dependency.** `docs/MOVE-PACKAGE.md` §4 already passes `oracle_mid: u128` as a *parameter* to the envelope check — nothing in Move calls Pyth. Pyth's Sui contracts are `edition = "legacy"` with a heavy pinned Wormhole dep; importing them buys nothing and risks the whole build.
- No Seal / Walrus Move deps (both are off-chain SDKs; the only on-chain Seal surface is our own `seal_approve`).

## R4 — DeepBook package versions (FACTS.md is stale)

All three exist on testnet:

| Role | Id | Version |
|---|---|---|
| original / type-origin | `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` | 1 |
| superseded | `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c` | 17 ← what `docs/FACTS.md` records |
| **current callable** | **`0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24`** | **20** |

Type arguments resolve against the **original**; `moveCall` targets the **current callable**. `docs/FACTS.md#deepbook-venue` must record both.

## R5 — On-chain identifiers verified live (testnet, 2026-07-25)

| What | Id | Notes |
|---|---|---|
| Hashi package | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360` | Immutable, v1 |
| `Hashi` shared object | `0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8` | `initialSharedVersion = 805474231` |
| `Pool<hBTC,DBUSDC>` | `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` | `initialSharedVersion = 946570339` |
| DBUSDC package | `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7` | coin type `…::DBUSDC::DBUSDC`, 6 dec |
| hBTC coin type | `0xfcea10ca…::btc::BTC` | 8 dec, symbol `hBTC`, supply ≈ 193.46 BTC |
| Pyth State / package | `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c` / `0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837` | |
| Wormhole State | `0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790` | |
| Hashi **devnet** ids | do **not** exist on testnet (correctly labelled devnet in FACTS.md) | |

**U9 → RESOLVED.**

## R6 — Live Hashi config (read from the shared object)

`paused=false` · `bitcoin_deposit_time_delay_ms=600000` · `bitcoin_deposit_minimum=30000` · **`bitcoin_withdrawal_minimum=30000`** · `bitcoin_confirmation_threshold=6` · `withdrawal_cancellation_cooldown_ms=3600000` · `mpc_threshold_in_basis_points=3334` · `guardian_url=https://guardian.testnet.hashi.sui.io` (gRPC-only, HTTP 464) · `guardian_btc_public_key=41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995` · `bitcoin_chain_id` = signet genesis.

Committee epoch 1171, 19 committees / 84 members. **The bridge is live with real traffic** (deposits ≈30k sats, withdrawals completing Signed→Confirmed in ≈9 min).

## R7 — Hashi Move surface (source-verified from `.hashi_src/`, `.hashi_raw/`)

Composable (callable from `gateway.move`) — **verbatim**:
```move
public fun hashi::withdraw::request_withdrawal(
    hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
    bitcoin_address: vector<u8>, ctx: &mut TxContext)
// asserts btc.value() >= 30_000                    EBelowMinimumWithdrawal
// asserts addr_len == 20 || addr_len == 32         EInvalidBitcoinAddress

public fun hashi::withdraw::cancel_withdrawal(
    hashi: &mut Hashi, request_id: address, clock: &Clock,
    ctx: &mut TxContext): Balance<BTC>
// asserts request.sender == ctx.sender()           EUnauthorizedCancellation   ⚠⚠
// asserts !is_request_processing                   ECannotCancelProcessingWithdrawal
// asserts now >= created_ms + 3_600_000            ECooldownNotElapsed
```
Entry (PTB-only): `entry fun deposit(hashi, utxo, clock, ctx)` · `entry fun confirm_deposit(hashi, request_id, clock, ctx)` (**permissionless**).

**⚠ Consequences that change the design:**
1. `hashi::btc_config` accessors (incl. `bitcoin_withdrawal_minimum()`) are `public(package)` ⇒ **not callable from our package.** Inject `30_000` as a config constant.
2. All `hashi::withdrawal_queue` getters are `public(package)` ⇒ **no on-chain Move read of queue depth is possible.** `U3 = NO`; `envelope.move` takes the static-buffer + event-replay fallback unconditionally.
3. `cancel_withdrawal` is **sender-bound** ⇒ `gateway::reclaim_stalled_exit` is **depositor-callable only; the keeper can never call it.** Any pooled-exit flush must also assert `who == ctx.sender()`, otherwise the flusher becomes the only party able to reclaim.
4. `struct BTC has key { id: UID }` (coin_registry style, not a `drop` witness). Users hold `Coin<BTC>`.

## R8 — Hashi events (real names; FACTS.md is abbreviated/wrong)

| Module | Events |
|---|---|
| `treasury` | `Minted<T>`, `Burned<T>` |
| `deposit` | `DepositRequested`, `DepositApproved`, `DepositConfirmed`, `ExpiredDepositDeleted` |
| `withdrawal_queue` | `WithdrawalRequested`, `WithdrawalApproved`, `WithdrawalPickedForProcessing`, `WithdrawalInputsSigned`, `WithdrawalSigned`, `WithdrawalPresigsReassigned`, `WithdrawalConfirmed`, `WithdrawalCancelled` |

**⚠ `WithdrawalSigned { withdrawal_txn_id, request_ids, signatures, guardian_signatures }` carries NO amount and NO timestamp.** For the G5 replay:
- `sats` = Σ over `request_ids` of `WithdrawalRequested.btc_amount` (fallback: `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount`);
- timestamp = the **Sui event envelope** `timestampMs`, not a struct field.

## R9 — Guardian limiter (exact algorithm, Rust source)

**Time base is UNIX SECONDS** (`refill_rate` = sats/**second**, `last_updated_at` = secs). Sui `Clock` is ms → divide by 1000 at the boundary. Amounts are sats, `u64`.

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
    if capacity < amount             { return RateLimitExceeded }   // REJECTED, never queued (G3)
    state.num_tokens_available = capacity - amount;                 // clamp BEFORE debit
    state.last_updated_at      = ts;
    state.next_seq            += 1;
}
```
Genesis = `{ num_tokens_available: max_bucket_capacity, last_updated_at: 0, next_seq: 0 }`.

Move must emulate saturating arithmetic explicitly (`u64` add/mul **abort** on overflow). TypeScript must use `bigint` (a 1 BTC bucket × large elapsed exceeds `Number.MAX_SAFE_INTEGER`).

**Golden vectors** (shared by `keeper/src/hashi/limiter.ts` tests and `move/tests/envelope_tests.move`):

| # | State | Call | Expect |
|---|---|---|---|
| 1 | `tokens 100_000, refill 10, last 0, cap 2_000_000` | capacity at `t=15` | `100_150` |
| 2 | same | capacity at `t=u64::MAX` | `2_000_000` (saturates, no abort) |
| 3 | `tokens 100_000, refill 0, last 0, next_seq 42` | `consume(42, 100, 80_000)` | ok → `{20_000, 100, 43}` |
| 4 | `tokens 10_000, refill 0, last 0, next_seq 7` | `consume(7, 10, 80_000)` | `RateLimitExceeded` (needed 80_000, available 10_000) |
| 5 | genesis, `cfg{1000, 2_000_000}` | `consume(1, 0, 0)` | `InvalidInputs` (seq) |
| 6 | after `consume(0, 100, 1000)` | `consume(1, 50, 1000)` | `InvalidInputs` (timestamp) |
| 7 | `projectCapacity(100_000n, 10n, 2_000_000n, 15_999)` | ms floors to 15 s | `100_150n` (15 s, not 16 s) |

> **ERRATUM (fixed 2026-07-25, verification pass).** Rows **#1** and **#7** originally printed `105_000`. That did not follow from the algorithm printed immediately above — `min(cap, tokens + elapsed × refill)` = `min(2_000_000, 100_000 + 15 × 10)` = **`100_150`** — nor from the upstream SDK, which returns `100150n` (`docs/FACTS.md` N3, D10d). `105_000` would require `elapsed × refill == 5_000`, i.e. 500 s at refill 10. The shipped twins (`move/sources/envelope.move` + `move/tests/envelope_tests.move`, `keeper/src/hashi/limiter.ts` + `keeper/test/limiter.golden.test.ts`) both assert `100_150` and both are green. Rows #2–#6 were correct as originally written.

**U1 (live genesis scalars) remains UNRESOLVED** — not on-chain; the guardian endpoint is gRPC-only. Use the sample-config prior `{refill_rate: 1000 sats/s, max_bucket_capacity: 100_000_000 sats}` and label it a **bound, not a fact**. Not load-bearing (risk input only).

## R10 — DeepBook venue reality

- The hosted indexer `deepbook-indexer.testnet.mystenlabs.com/get_pools` lists **7 pools and does NOT include hBTC/DBUSDC**. The pool object exists on-chain and is correctly typed. ⇒ **Never read the book from the indexer.**
- Read L2 depth / mid by simulating `pool::get_level2_range` and `pool::mid_price` against the callable package (R4) with explicit type args `[hBTC, DBUSDC]`.
- `@mysten/deepbook-v3`'s `DeepBookClient` is driven by a bundled pool/coin registry that will not contain our pool — build raw `moveCall`s instead; use the SDK for BCS helpers only.
- The whole testnet book shows **zero volume**. `book_mid` will have nothing to read until a scripted taker/maker seeds it — that account is **not optional**, NAV depends on it.
- `DBTC_DBUSDC` in the indexer is DeepBook's own test BTC — **not** hBTC.

## R11 — Pyth

| Channel | BTC/USD feed id |
|---|---|
| **BETA — use on testnet** | **`0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`** (`https://hermes-beta.pyth.network`) |
| stable / mainnet | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |

**U2 → RESOLVED.** Pyth DAO auto-upgrades Sui addresses on 2026-08-18 — pin versions before then.

## R12 — npm packages (versions live on the registry)

`@mysten/sui 2.22.1` · `@mysten/hashi 0.6.0` (peer `@mysten/sui ^2.22.1`) · `@mysten/deepbook-v3 1.5.9` · `@mysten/seal 1.3.4` · `@mysten/walrus 1.2.9` · `@mysten/dapp-kit 1.1.9` · `@mysten/enoki 1.2.7`. All ESM.

## R13 — Landing page source (`aydi26/nox-hackathon`)

7 self-contained React 19 files under `frontend/src/components/LandingPage/`. Deps: `react@^19.1.0`, `react-dom@^19.1.0`, `globe.gl@^2.45.3`, `three@^0.183.2`, `@number-flow/react@^0.6.0`.

- Only EVM coupling: one import `../../lib/publicReader.js` feeding two stat counters → replace with a Sui read that never throws.
- `public/fonts/cravelo.otf` is the **mandatory** display face (also `@font-face`'d inside `LandingPage.css`).
- `Globe3D.jsx` fetches 4 textures/geojson from **jsDelivr at runtime** → vendor them locally so the hero renders offline.
- `Globe3D.jsx`'s cloud-layer `requestAnimationFrame` loop is **never cancelled on unmount** — fix during the port.
- `HorizontalScroll.jsx` is hardcoded to **exactly 3 cards**; the count is baked into CSS as `.hscroll-section{height:300vh}` / `.hscroll-track{width:300vw}`.
- Re-theme surface: colour literals in `LandingPage.css` (`#6366f1`, `#a855f7`, `#a78bfa`, `#818cf8`, `#4338ca`), `atmosphereColor()` in `Globe3D.jsx`, the 6 gradient pairs in `BeamSection.jsx`.
- Copy to rewrite: `LandingPage.jsx` (nav/stats/CTA/footer), `BeamSection.jsx` (h2 + p + 6 logos), `HorizontalScroll.jsx` (`CARDS`), `FAQ.jsx` (`ITEMS`, 5 Q/A), `ContactModal.jsx` (headings/labels/mailto).

## R14 — Deposit registration: there is no relayer, and the txid is byte-reversed

Two facts that are silent failures if you get them wrong. Both verified empirically on 2026-07-25.

**1. Nobody registers your deposit for you.** Sampling 20 consecutive `deposit::DepositRequested` events gave **20 distinct transaction senders**, and in every one `sender == derivation_path == requester_address`. There is no Hashi relayer watching deposit addresses; each depositor submits their own UTXO. `.hashi_src/design__docs__deposit.mdx` agrees — *"The user then submits the request."*

The call chain (all verified against the deployed package):

```move
public fun hashi::utxo::utxo_id(txid: address, vout: u32): UtxoId
public fun hashi::utxo::utxo(id: UtxoId, amount: u64, derivation_path: Option<address>): Utxo
entry  fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo, clock: &Clock, ctx: &mut TxContext)
```

`derivation_path` must be the Sui address the deposit address was derived from — it is where the hBTC gets minted.

**2. ⚠⚠ `utxo_id` takes the txid in Bitcoin's INTERNAL byte order — the REVERSE of what every explorer displays.**

Verified against three real `DepositConfirmed` events. For each, the txid stored on chain was **not found** on signet as-is, the byte-reversed form was **always** found, and the output amount at the recorded `vout` matched the event exactly:

| on-chain txid (internal) | reversed → found on signet | vout | amount |
|---|---|---|---|
| `0x17b9ea28…9be71131` | `3111e79b…8528eab917` | 78 | 327 312 |
| `0x48780348…74a9b8d1` | `d1b8a974…9f48037848` | 568 | 172 358 |
| `0x577f6428…ef049b14` | `149b04ef…6628647f57` | 281 | 401 581 |

Passing the displayed order registers a UTXO that does not exist. Nothing tells you why: the transaction succeeds, and the committee simply never approves it.

`scripts/register-deposit.ps1` does the reversal for you — always hand it the explorer-displayed txid, so there is exactly one place this can be wrong.

Registration is only accepted once the tx has `bitcoin_confirmation_threshold` (6) confirmations; the script refuses below that rather than letting the call abort.

**3. Never register against a mempool txid — it can vanish.** Observed live: the faucet's first batch `04cb601a…` sat unconfirmed for hours, then was **replaced** (RBF) by `2275d890…` with a higher fee. Both explorers now return **404** for the original. The amounts changed too (591 692 → 144 137 per output), so even the vouts we had noted were wrong. Registering while it was in the mempool would have pinned a UTXO that no longer exists — and per point 2 above, that failure is completely silent. The confirmation gate is not a nicety; it is what makes registration safe.
