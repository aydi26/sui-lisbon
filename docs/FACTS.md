# FACTS.md — Canonical single source of truth

> Purpose: the one authoritative reference for every verified identifier, signature, latency, limiter mechanic, SDK method, venue/oracle/faucet, event name, and competitive fact for Aphotic × Hashi. Every other doc links here by anchor; DO NOT duplicate these values elsewhere.
> Read after: (none — this is the root reference)
>
> **Status 2026-07-25: every value below was verified live this session.** Evidence (exact command + raw output) is in `docs/DAY-ONE-RESULTS.md`, cross-referenced per row as `[D<n>]`. Ground-truth reconnaissance is in `docs/RECON.md` (`[R<n>]`). On conflict: **FACTS.md wins**; where FACTS.md corrects RECON, the correction is called out inline and justified by a `[D<n>]` receipt.
>
> Project one-liner: Aphotic × Hashi ("The Bitcoin Dark Vault") — a NON-CUSTODIAL, PRIVATE market-making vault on Sui. A Seal-encrypted strategy is executed maker-first on the hBTC/DBUSDC DeepBook v3 book by a deterministic off-chain keeper holding ONLY a DeepBook `TradeCap`; native BTC enters/exits via Hashi with exits composed in Move (`request_withdrawal`) to an on-chain-pinned Bitcoin address; every keeper decision is written to Walrus and is replayable. zkLogin onboarding + permissionless `confirm_deposit` crank. Sats-denominated NAV. Sui **TESTNET** (Bitcoin side = **signet**).
>
> Sources transcribed: `HASHI_INTEGRATION.md` (authoritative design), `README (8).md` (base design). `BTC_FIXED_INCOME.md` is a SHELVED ALTERNATIVE ("Meridian" bond) — NOT the build; do not import its mechanics.

---

## Golden rules (front-loaded — never violate)
<a id="golden-rules"></a>

| # | Rule |
|---|---|
| G1 | hBTC is a fungible `Coin<BTC>`. On-Sui movement of hBTC is INSTANT (one checkpoint). Bitcoin/Guardian latency exists ONLY at the mint(deposit)/burn(withdraw) boundary. Never claim otherwise. |
| G2 | The keeper holds ONLY a DeepBook `TradeCap` — never `WithdrawCap`. It can place/cancel orders; it can NEVER move funds out. Exits are composed in Move (`gateway`) to an address pinned on-chain at deposit; a fully compromised keeper cannot steal or redirect. |
| G3 | You CANNOT buy priority in Hashi's global withdrawal queue; over-capacity batches are REJECTED (`RateLimitExceeded`), not queued. Never design anything that assumes jumping the queue. |
| G4 | No Cetus hBTC pool exists. Router = DeepBook maker (`POST_ONLY`) + IOC sweep on the same book ONLY. No Cetus taker leg, no CLMM ranges for the BTC vault. |
| G5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity()` over the `WithdrawalSigned` event stream — the `verify` command re-derives it. Do NOT frame it as a mere trusted SDK read. |
| G6 | The BTC leg (deposit ~70 min, withdraw ~1–2 h) is NEVER live-demoable. Pre-stage. Sui side is instant. Show an earlier confirmed signet tx. |
| G7 | Isolate the entire Hashi surface behind an adapter interface with a deterministic MOCK from line one (mirror `project_capacity` exactly); keep on-chain Hashi calls confined to `gateway.move`; make all IDs configurable (env/config), never hardcoded in logic. |
| G8 | Honesty for the pitch: hBTC IS custodial-threshold wrapped BTC. Differentiation = composing the bridge's ON-CHAIN machinery (composed pinned exits, trustlessly-verifiable bridge-aware envelope, permissionless deposit crank, peg-flow signal), NOT the token's trust model. |
| G9 | Pin Pyth versions + use the Beta feed on testnet; value collateral/NAV at DeepBook mid (depeg defence); add staleness guards. |
| G10 | Move 2024 edition idioms throughout. |

---

## RPC transport

Anchor: `#rpc-transport` (aliases: `#rpc`, `#transport`)
<a id="rpc"></a><a id="transport"></a>

**The official testnet fullnode does not serve JSON-RPC.** It serves **gRPC v2 only** (`/sui.rpc.v2.LedgerService/*`). A JSON-RPC POST returns **HTTP 404**. [R1] [D-env]

| Concern | Decision |
|---|---|
| **Default transport** | **`SuiGrpcClient` from `@mysten/sui/grpc` against `https://fullnode.testnet.sui.io:443`.** Constructed in exactly ONE place (`keeper/src/sui/client.ts`); everything else imports that factory. |
| `sui` CLI 1.76.0 | Works against the official fullnode (speaks gRPC internally). `sui client object <id> --json` and `sui client call --dev-inspect` are the reference CLI probes. |
| `@mysten/sui@2.22.1` subpaths | `./grpc` → `SuiGrpcClient`, `GrpcCoreClient`, `GrpcWebFetchTransport`; `./jsonRpc` → `SuiJsonRpcClient`, `getJsonRpcFullnodeUrl`. **`@mysten/sui/client` does NOT export `SuiClient`** — that name is gone in 2.x; importing it throws `does not provide an export named 'SuiClient'`. [D3] |
| JSON-RPC mirrors (verified, chain id `4c78adac`) | `https://rpc-testnet.suiscan.xyz:443` (primary probe) · `https://sui-testnet-rpc.publicnode.com` · `https://sui-testnet.nodeinfra.com`. **Probes/cross-checks only — never a production dependency.** `sui-testnet.public.blastapi.io` is dead (403). |
| Unsupported on every mirror | `suix_getNormalizedMoveModulesByPackage`. The **per-module** form `sui_getNormalizedMoveModule` IS supported and is how ABI/visibility was verified. [D2] |
| Chain id | `4c78adac` |

**HTTP/2 requirement (non-obvious, bit us once).** The Hashi guardian at `https://guardian.testnet.hashi.sui.io` is served behind an ALB that **rejects HTTP/1.1 with status 464**. Node's global `fetch` and the system `curl` are HTTP/1.1, so both fail — including `@mysten/hashi`'s own `fetchGuardianInfo`. Use `node:http2` (ALPN `h2`). See `#guardian-limiter`. [D4]

---

## hBTC

Anchor: `#hbtc`

| Field | Value |
|---|---|
| Coin type (testnet) | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC` |
| Module | `hashi::btc` |
| Struct | `BTC` — `struct BTC has key { id: UID }` (coin_registry currency object, **not** a `drop` witness) [R7.4] |
| Decimals | `8` |
| Symbol | `hBTC` |
| Units | satoshis (sats) |
| Coin kind | STANDARD FUNGIBLE unregulated `sui::coin::Coin<BTC>` (via `coin_registry::new_currency`) — NO deny list, NO transfer restriction; freely custodied / split / merged by third parties |
| NOT | a position object / NFT |
| `TreasuryCap` | locked in the shared `Hashi` object |
| mint / burn | `public(package)` only — **we CANNOT mint.** Consequence: the only way to obtain hBTC is a real signet deposit (~70 min). This is what makes D7 (faucet drip) the longest-lead item in the plan. [D3c] |
| Supply (2026-07-25) | ≈ 193.46 BTC [R5] |

Depeg note: hBTC can DEPEG below BTC on the thin DeepBook book precisely when exits are throttled. Value NAV at the live DeepBook mid (see `#pyth-oracle`). This is a risk-register item.

---

## Hashi Move API

Anchor: `#hashi-move-api` (aliases: `#composable-hashi-move-fns`, `#confirm-deposit`, `#cancel-withdrawal`, `#withdrawal`)
<a id="composable-hashi-move-fns"></a><a id="confirm-deposit"></a><a id="cancel-withdrawal"></a><a id="withdrawal"></a>

Verified **against the deployed bytecode** (`sui_getNormalizedMoveModule`, visibility field) as well as source. `Friend` in the normalized ABI == `public(package)` in Move 2024. [D2]

### The ENTIRE composable surface — exactly two functions

```move
// COMPOSABLE — call from gateway.move inside our PTB:
public fun hashi::withdraw::request_withdrawal(
    hashi: &mut Hashi,
    clock: &Clock,
    btc: Balance<BTC>,
    bitcoin_address: vector<u8>,
    ctx: &mut TxContext
)
// asserts btc.value() >= 30_000                 EBelowMinimumWithdrawal
// asserts addr_len == 20 (P2WPKH) || == 32 (P2TR)   EInvalidBitcoinAddress
// emits WithdrawalRequested

public fun hashi::withdraw::cancel_withdrawal(
    hashi: &mut Hashi,
    request_id: address,
    clock: &Clock,
    ctx: &mut TxContext
): Balance<BTC>
// asserts request.sender == ctx.sender()        EUnauthorizedCancellation      ⚠⚠ SENDER-BOUND
// asserts !is_request_processing(request)       ECannotCancelProcessingWithdrawal
// asserts now >= created_ms + 3_600_000         ECooldownNotElapsed
```

> ### ⚠⚠ `cancel_withdrawal` is SENDER-BOUND — read this before designing any reclaim path
> `cancel_withdrawal` asserts `request.sender == ctx.sender()`. The *sender* of the withdrawal is whoever signed the PTB that called `request_withdrawal`. Therefore:
> - **`gateway::reclaim_stalled_exit` is DEPOSITOR-CALLABLE ONLY. The keeper can NEVER call it.** A keeper-side `reclaim` command is a design error, not an implementation detail.
> - If small exits are **pooled and flushed** by a third party, that flusher becomes the request sender and thus the **only** party who can ever cancel it. Any flush entrypoint MUST assert `who == ctx.sender()`.
> - The app's `<ReclaimButton/>` must be signed by the depositor (zkLogin session), not relayed through the keeper.
> [R7.3] [D2]

### PTB-only entry functions (NOT composable from Move)

```move
entry fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo, clock: &Clock, ctx: &mut TxContext)
entry fun hashi::deposit::confirm_deposit(hashi: &mut Hashi, request_id: address, clock: &Clock, ctx: &mut TxContext)
// PERMISSIONLESS; mints Coin<BTC> to the recipient encoded in the UTXO's derivation path
```
Both are `visibility=Private, isEntry=true` on-chain [D2] — i.e. callable from a **PTB command**, but **not** callable from another Move module. The permissionless crank is therefore a keeper/app PTB and must never appear as a `moveCall` inside `gateway.move`.

### ⚠ Config accessors are NOT callable

| Fn | Real visibility | Consequence |
|---|---|---|
| `hashi::btc_config::bitcoin_withdrawal_minimum()` | **`public(package)` (`Friend`)** | **NOT callable from `aphotic`.** Inject `30_000` as a Move **constant** (`HASHI_WITHDRAWAL_MIN_SATS`). |
| `bitcoin_deposit_minimum`, `bitcoin_deposit_time_delay_ms`, `bitcoin_confirmation_threshold`, `withdrawal_cancellation_cooldown_ms`, `dust_relay_min_value`, `worst_case_network_fee`, `bitcoin_chain_id` | `public(package)` | same — all injected as constants from `#hashi-onchain-config`. |
| **All 46** `hashi::withdrawal_queue` getters (`request_btc_amount`, `request_status`, `is_request_processing`, `withdrawal_txn_pending_count`, …) | **`public(package)`** (only `output_utxo` is `Public`) | **There is NO on-chain Move read of queue depth or limiter state.** `envelope.move` takes the static-buffer + event-replay path **unconditionally**. There is no "if the getter exists" branch to write. (`#unknowns` U3 = NO.) |

### Touchpoint summary

| Touchpoint | Kind | Aphotic call site |
|---|---|---|
| `hashi::btc::BTC` coin type (sats) | Move type | vault asset, share math, DeepBook pool |
| `request_withdrawal(…, Balance<BTC>, vector<u8>, …)` | `public fun` | `gateway::exit_to_bitcoin` (composed in burn-shares PTB) |
| `cancel_withdrawal(…): Balance<BTC>` | `public fun` | `gateway::reclaim_stalled_exit` — **depositor-signed only** |
| withdrawal minimum `30_000` sats | **constant** (getter not callable) | `gateway` small-exit pooling logic |
| `entry deposit` | PTB command | keeper registration path |
| `entry confirm_deposit` (permissionless) | PTB command | keeper crank + sponsored deposit sweep |
| `Hashi` shared object | Move arg | passed as `&mut Hashi`; **not** readable for queue depth |

---

## Hashi on-chain config (live, read from the shared object)

Anchor: `#hashi-onchain-config` (alias: `#hashi-config`)
<a id="hashi-config"></a>

Read from `Hashi.config` (`0x22c0ce66…4528f8`) on 2026-07-25. These are the values to inject as Move constants / keeper config. [D1] [D6] [R6]

| Key | Value | Note |
|---|---|---|
| `paused` | `false` | |
| `bitcoin_deposit_minimum` | `30_000` sats | |
| `bitcoin_withdrawal_minimum` | **`30_000` sats** | `EBelowMinimumWithdrawal` floor; getter NOT callable — hardcode as a constant |
| `bitcoin_deposit_time_delay_ms` | `600_000` (10 min) | mandatory delay before `confirm_deposit` can mint |
| `bitcoin_confirmation_threshold` | `6` | BTC confirmations before committee approval |
| `withdrawal_cancellation_cooldown_ms` | `3_600_000` (1 h) | `ECooldownNotElapsed` |
| `mpc_threshold_in_basis_points` | `3334` | |
| `mpc_max_faulty_in_basis_points` | `3333` | |
| `mpc_weight_reduction_allowed_delta` | `800` | |
| `mpc_nonce_generation_protocol` | `0` | |
| `governance_emergency_pause_threshold_bps` | `500` | |
| `governance_emergency_unpause_threshold_bps` | `6667` | |
| `guardian_url` | `https://guardian.testnet.hashi.sui.io` | **HTTP/2 only** — see `#rpc-transport` |
| `guardian_btc_public_key` | `41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995` | x-only, 32 B; input to `generateDepositAddress` |
| `bitcoin_chain_id` | `0xf61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000` | signet genesis |
| `committee_set.mpc_public_key` | `391d3d8e999367dd9befa4b391fadf5d67025fb30ca7b09b05b9b02ead558f3680` (33 B, **arkworks encoding**) | must be run through `arkworksToSec1Compressed` → `02368f55ad2eb0b9059bb0a70cb35f02675ddffa91b3a4ef9bdd6793998e3d1d39` before use [D6] |
| `committee_set.epoch` | `1171` | 19 committees / 84 members |

The bridge is **live with real traffic** — deposits ≈30 000 sats, withdrawals completing Requested→Confirmed in ≈58 min on a quiet signet. [D10e]

---

## Latencies

Anchor: `#latencies`

Bitcoin side = signet (block target ~10 min).

| Flow | Planning figure | Steps |
|---|---|---|
| **Deposit** | **~70+ min** | BTC to derived P2TR addr (min 30 000 sats) → `deposit` registration → committee `approve_deposit` after **6 BTC confirmations** (+ sanctions screening) → **mandatory 10-min delay** (`bitcoin_deposit_time_delay_ms = 600000`) → PERMISSIONLESS `confirm_deposit` mints |
| **Withdrawal** | **~1–2 h** (plan for 2) | `request_withdrawal` (INSTANT on Sui, emits event, burns via batch commit) → batch (~10 min OR threshold) → Guardian + MPC (threshold Schnorr) sign → broadcast → confirmed after **6 confs** |

**Measured, one real 1 000 000-sat withdrawal on 2026-07-24 [D10e]** — informative, NOT a promise:

| Transition | Δ from `WithdrawalRequested` |
|---|---|
| `WithdrawalApproved` | +10 s |
| `WithdrawalPickedForProcessing` | +5.1 min |
| `WithdrawalSigned` | **+5.4 min** |
| `WithdrawalConfirmed` | **+57.9 min** |

Keep the conservative planning figures above; a single quiet-signet sample is not a distribution. G6 is unaffected either way — 58 min is still far outside a 3-minute demo.

Amount floors:

| Floor | Value |
|---|---|
| Withdrawal minimum | `30_000` sats |
| Deposit minimum | `30_000` sats |
| Bitcoin dust floor | `546` sats |

Ordering: committee-leader-discretionary, "generally FIFO, not strict". You CANNOT buy priority (see `#guardian-limiter`, G3).

Consequence for demo (G6): the BTC leg is NEVER live-demoable. Pre-stage confirmed deposits and a broadcast withdrawal. Sui side is instant. Show an earlier confirmed signet tx in an explorer.

---

## Guardian limiter

Anchor: `#guardian-limiter` (alias: `#limiter`)
<a id="limiter"></a>

| Property | Value |
|---|---|
| Shape | a SINGLE GLOBAL token bucket `{refill_rate: sats/**second**, max_bucket_capacity: sats}` |
| **Time base** | **UNIX SECONDS.** `refill_rate` is sats/**second**; `last_updated_at` is **seconds**. Sui `Clock` is ms ⇒ divide by 1000 **at the boundary**. Confirmed by the guardian's own field names `refillRateSatsPerSec` / `lastUpdatedAtSecs`. [D4] [D10d] |
| Location | OFF-CHAIN Rust Guardian enclave (`LocalLimiter`). On-chain Move has NO limiter state. |
| Advancement | advanced PURELY by on-chain `WithdrawalSigned` events |
| Trustless replay | The entire bucket trajectory + global queue depth is TRUSTLESSLY REPLAYABLE from the on-chain `WithdrawalRequested / PickedForProcessing / Signed` event stream. `verify` RE-DERIVES it (G5). |
| Trust anchors | ONLY two genesis scalars: `refill_rate`, `max_bucket_capacity`. **Both now READ LIVE** (below) and independently observationally boundable. |
| Over-capacity | batches are REJECTED (`RateLimitExceeded`), NOT queued (G3) |
| Ordering | committee-leader-discretionary, "generally FIFO, not strict" — cannot buy priority |
| Read endpoint | `GET {guardian_url}/info` — **HTTP/2 ONLY** (HTTP/1.1 ⇒ 464). Returns the RAW last-consume state; it does **not** project. The caller runs `project_capacity` itself. [D4] |

### LIVE testnet values (2026-07-25) — U1 RESOLVED

| Scalar | Value | Derived |
|---|---|---|
| `refill_rate` | **`115_740` sats/s** | `9_999_936_000` sats/day ≈ **99.99936 BTC/day** |
| `max_bucket_capacity` | **`10_000_000_000` sats** | **100 BTC** |
| observed `num_tokens_available` | `7_043_037_994` sats (≈70.43 BTC) | at `lastUpdatedAtSecs = 1784934423` |
| observed `next_seq` | `556` | |
| guardian `gitRevision` | `ae3fc68200a80fcef2dd5dbea5c4fd18a4ec8f0e` | |

> **CORRECTION.** The previously-recorded "sample signet config" of `1000 sats/s` + `100_000_000 sats` (1 BTC) was a **prior, and it is wrong by ~100×**. The bucket is a **100 BTC** bucket refilling a full bucket per day. Consequence to internalise before pitching: an Aphotic-sized exit will essentially never be the binding constraint. The redemption buffer stays in the design as an honest **risk input** and as the substrate for the *verifiability* claim (G5) — it is NOT a scarcity story. Do not oversell congestion.

### Exact algorithm (upstream reference implementation)

`@mysten/hashi@0.6.0`, `dist/guardian.mjs` — this is the byte-for-byte target for `keeper/src/hashi/limiter.ts` and the Move twin:

```js
function projectCapacity(config, state, timestampSecs) {          // ABSOLUTE seconds, not elapsed
  const refilled = (timestampSecs > state.lastUpdatedAtSecs
                     ? timestampSecs - state.lastUpdatedAtSecs : 0n)   // == saturating_sub
                   * config.refillRateSatsPerSec;
  const projected = state.numTokensAvailableSats + refilled;
  return projected < config.maxBucketCapacitySats ? projected : config.maxBucketCapacitySats;
}

function estimateWaitSecs(config, state, amountSats, nowSecs) {
  if (amountSats > config.maxBucketCapacitySats) return null;         // never satisfiable
  const available = projectCapacity(config, state, nowSecs);
  if (available >= amountSats) return 0n;
  const deficit = amountSats - available;
  if (config.refillRateSatsPerSec === 0n) return null;
  return (deficit + config.refillRateSatsPerSec - 1n) / config.refillRateSatsPerSec;   // ceil-div
}
```

Consume semantics (Rust `limiter.rs`, [R9]):
```rust
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

Implementation notes:
- **Move** must emulate saturating arithmetic explicitly — `u64` add/mul **abort** on overflow; widen to `u128` before the `min`.
- **TypeScript** must use `bigint` throughout — a 100 BTC bucket × large elapsed blows past `Number.MAX_SAFE_INTEGER`.
- The MOCK and `verify/` MUST import **one** identical `projectCapacity` (`keeper/src/hashi/limiter.ts`).

### Golden vectors (CORRECTED — shared by `keeper/src/hashi/limiter.ts` tests and `move/tests/envelope_tests.move`)

> **⚠ CORRECTION vs `docs/RECON.md` R9.** R9's vectors **#1** and **#7** tabulate `105_000`, which does not follow from R9's own formula: `100_000 + 15 × 10 = 100_150`. Verified against the upstream SDK, which returns `100150n` [D10d]. The algorithm in R9 is right; those two expected values are arithmetic slips. **Use the table below.** Shipping R9's numbers means the shared-vector cross-test can never go green.

| # | State / call | Expect |
|---|---|---|
| 1 | `tokens 100_000, refill 10, last 0, cap 2_000_000` → capacity at `t=15` | **`100_150`** (RECON says 105_000 — wrong) |
| 2 | same → capacity at `t = u64::MAX` | `2_000_000` (saturates, no abort) |
| 3 | `tokens 100_000, refill 0, last 0, next_seq 42` → `consume(42, 100, 80_000)` | ok → `{20_000, 100, 43}` |
| 4 | `tokens 10_000, refill 0, last 0, next_seq 7` → `consume(7, 10, 80_000)` | `RateLimitExceeded` (needed 80 000, available 10 000) |
| 5 | genesis, `cfg{1000, 2_000_000}` → `consume(1, 0, 0)` | `InvalidInputs` (seq) |
| 6 | after `consume(0, 100, 1000)` → `consume(1, 50, 1000)` | `InvalidInputs` (timestamp) |
| 7 | ms→s flooring: `elapsedMs = 15_999` on `tokens 100_000, refill 10, cap 2_000_000` | **`100_150n`** — floors to 15 s, not 16 (RECON says 105_000 — wrong) |
| 8 | `estimateWaitSecs(cfg{10, 2_000_000}, {100_000, 0}, 200_000, 0)` | `10_000` s (ceil-div) |
| 9 | `estimateWaitSecs(cfg, state, amount > max_bucket_capacity, t)` | `null` — never satisfiable in one withdrawal |

Aphotic usage: the constraint envelope maintains an on-chain **redemption buffer** — it refuses keeper deployments that would push idle hBTC below a bound tied to pending exit demand. The strategy de-risks preemptively when the bridge tightens. This trace is replayable from Hashi's own events (not an SDK read).

Implementation rule (G7): the adapter MOCK must mirror `project_capacity()` EXACTLY from line one.

---

## SDK

Anchor: `#sdk` (alias: `#hashi-sdk`)
<a id="hashi-sdk"></a>

| Field | Value |
|---|---|
| Package | `@mysten/hashi` |
| Version | `v0.6.0` (2026-07-21) |
| Module system | ESM-only |
| Peer dependency | `@mysten/sui` `^2.22.1` |
| Source | `MystenLabs/ts-sdks` → `packages/hashi/` |
| Mainnet | SDK THROWS on mainnet (not deployed) |

### ⚠ ACTUAL exported surface (read from the installed package — the previous table was wrong)

```
AmountBelowMinimumError · HashiClient · HashiConfigError · HashiFetchError · HashiGuardianError
HashiPausedError · InvalidBitcoinAddressError · InvalidParamsError · arkworksToSec1Compressed
bitcoinAddressToWitnessProgram · deriveChildPubkey · estimateWaitSecs · fetchGuardianInfo
generateDepositAddress · hashi · projectCapacity · twoOfTwoTaprootScriptPathAddress
witnessProgramToAddress
```

| Symbol | Real signature / gotcha |
|---|---|
| `generateDepositAddress` | `({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network })` — **pure, offline, no RPC.** `suiAddress` is a **32-byte `Uint8Array`**, not a hex string (a `0x…` string throws `Expected 32-byte Sui address, got 66`). `mpcMasterCompressed` must be `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)`; raw arkworks bytes throw `bad point`. `network: 'signet'` for us. [D6] |
| `arkworksToSec1Compressed` | mandatory bridge between the on-chain `mpc_public_key` encoding and secp256k1. |
| `witnessProgramToAddress(program, network)` / `bitcoinAddressToWitnessProgram(addr, network)` | **both take `network` as an argument**; omitting it throws `wrong-network` with `expected "undefined"`. 20 B → P2WPKH `tb1q…`, 32 B → P2TR `tb1p…`. |
| `projectCapacity(config, state, timestampSecs)` | **ABSOLUTE seconds**, bigint. See `#guardian-limiter`. |
| `estimateWaitSecs(config, state, amountSats, nowSecs)` | returns `0n` if available now, `null` if unsatisfiable. |
| `fetchGuardianInfo(origin)` | GETs `{origin}/info`. **Fails on Node (HTTP 464)** because it uses global `fetch` (HTTP/1.1) and the guardian ALB requires HTTP/2. **Do not call it — wrap `node:http2` yourself.** [D4] |
| `HashiClient` / `hashi()` | client extension, `client.$extend(hashi())`. |

> **There is NO `guardian.limiterStatus`, no `guardian.canWithdraw`, no `view.balance` / `view.depositStatus` / `view.withdrawalStatus` / `view.all`, no `waitForDeposit` / `waitForWithdrawal`, no `deposit` / `requestWithdrawal` / `cancelWithdrawal` top-level helpers** in v0.6.0's export list. Any spec text that names them (`docs/KEEPER.md` §2, `docs/APP.md` §2.3/§3.3) is describing an API that does not exist; those flows must be built on `HashiClient` + raw `moveCall`s + event polling behind our own adapter (G7 — which is exactly why the adapter exists).

### Other npm packages (versions live on the registry) [R12]

`@mysten/sui 2.22.1` · `@mysten/deepbook-v3 1.5.9` · `@mysten/seal 1.3.4` · `@mysten/walrus 1.2.9` · `@mysten/dapp-kit 1.1.9` · `@mysten/enoki 1.2.7`. All ESM.

---

## DeepBook venue

Anchor: `#deepbook-venue` (aliases: `#deepbook`, `#deepbook-pool`, `#deepbook-caps`, `#venue`, `#no-cetus`)
<a id="deepbook"></a><a id="deepbook-pool"></a><a id="deepbook-caps"></a><a id="venue"></a><a id="no-cetus"></a>

Mysten's own integration demo is "hashi × DeepBook" (`https://mystenlabs.github.io/hashi-integrations/`).

### Package ids — all three exist; use the right one for the right job [R4] [D3]

| Role | Id | Version |
|---|---|---|
| **original / type-origin** — every `Pool`/`BalanceManager`/`TradeCap` **TYPE** resolves against this | `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` | 1 |
| superseded — **do not use** (this is what FACTS.md recorded before 2026-07-25) | `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c` | 17 |
| **current callable** — every `moveCall` **TARGET** | **`0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24`** | **20** |

### ⚠ The pinned dep rev is AHEAD of deployed v20 — three functions do not exist on chain [D3b]

RECON R3 pins `deepbook` at rev `0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb`. That source has **88** public `pool` functions; the deployed v20 package has **85**. The delta:

```
IN SOURCE BUT NOT ON-CHAIN: best_ask_price · best_bid_price · place_post_only_limit_order
ON-CHAIN BUT NOT IN SOURCE: (none)
```

**Calling any of those three compiles and then fails at publish/link time.** `router.move` must use `place_limit_order(order_type = POST_ONLY)` and derive top-of-book from `get_level2_range`. (The graceful `place_post_only_limit_order` wrapper that returns `Option<OrderInfo>` instead of aborting `EPOSTOrderCrossesOrderbook` is *coming*, but is not deployed — do not design around it.)

### Reading the book — `get_level2_range`, never `mid_price` [D3a]

On the current EMPTY testnet book, verified by simulation against v20:

| Call | Behaviour on an empty book |
|---|---|
| `pool::mid_price<B,Q>(&Pool, &Clock): u64` | **ABORTS** `deepbook::book` code **`2` = `EEmptyOrderbook`** |
| `pool::get_level2_range<B,Q>(&Pool, price_low, price_high, is_bid, &Clock): (vector<u64>, vector<u64>)` | **SUCCEEDS**, returns `([], [])` |
| `pool::get_level2_ticks_from_mid<B,Q>(&Pool, ticks, &Clock)` | inherits the mid-price behaviour — avoid |

⇒ Every book read (keeper `routing/`, Move `router::book_mid`, app transparency panel) goes through `get_level2_range`. Anything that calls `mid_price` dies on an empty book, which is the book's **current** state.

The **hosted indexer `deepbook-indexer.testnet.mystenlabs.com` lists 7 pools and does NOT include hBTC/DBUSDC** [R10] — never read the book from the indexer. `@mysten/deepbook-v3`'s `DeepBookClient` is driven by a bundled pool/coin registry that will not contain our pool; build raw `moveCall`s and use the SDK for BCS helpers only. (`DBTC_DBUSDC` in the indexer is DeepBook's own test BTC — **not** hBTC.)

### Pool + parameters

| Field | Value |
|---|---|
| `Pool<hBTC, DBUSDC>` (testnet) | `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` |
| `initialSharedVersion` | `946570339` |
| tick | `1_000_000` |
| lot | `1_000` |
| min_size | `100_000` |
| created | 2026-07-20 |
| pool fee | `500 DEEP` |
| DBUSDC coin type | `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC` (6 dec) |
| DEEP coin type | `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP` |

Order-type constants (`deepbook::constants`, compile-time):
`NO_RESTRICTION=0` · `IMMEDIATE_OR_CANCEL=1` · `FILL_OR_KILL=2` · **`POST_ONLY=3`** · `MAX_RESTRICTION=3`;
self-matching: `SELF_MATCHING_ALLOWED=0` · `CANCEL_TAKER=1` · `CANCEL_MAKER=2`; `FLOAT_SCALING=1_000_000_000`.

Router (G4): **NO Cetus hBTC pool exists** ⇒ router = DeepBook maker `POST_ONLY` + IOC sweep on the SAME book. No Cetus taker leg, no CLMM ranges for the BTC vault.

### Capability model (G2) — verified on-chain [D3c]

DeepBook `BalanceManager` issues `DepositCap` / `WithdrawCap` / `TradeCap` **independently**:
```
balance_manager::new(&mut TxContext): BalanceManager
balance_manager::mint_trade_cap(&mut BalanceManager, &mut TxContext): TradeCap
balance_manager::mint_deposit_cap / mint_withdraw_cap / revoke_trade_cap
balance_manager::generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof
balance_manager::generate_proof_as_owner (&mut BalanceManager, &TxContext): TradeProof
```
The keeper holds ONLY `TradeCap` and builds its `TradeProof` via `generate_proof_as_trader`. Creating a shared `BalanceManager` + minting a `TradeCap` dry-runs green (≈1.99 M computation + 4.81 M storage MIST).

### Book reality (build implication, not a footnote)

The whole testnet book shows **zero volume** and both sides are **empty** as of 2026-07-25. `book_mid` has nothing to read until a scripted taker/maker seeds it. **That seeder account is NOT optional — NAV depends on it.** hBTC cannot be minted by us (`#hbtc`), so seeding the base side requires a real signet deposit; start the faucet drip now (`#unknowns` U6).

---

## Pyth oracle

Anchor: `#pyth-oracle` (aliases: `#oracle`, `#pyth`)
<a id="oracle"></a><a id="pyth"></a>

Pyth on Sui testnet. PIN ALL VERSIONS (G9) — Pyth DAO auto-upgrades Sui addresses on **2026-08-18**.

| Field | Value |
|---|---|
| Pyth State | `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c` (`initialSharedVersion = 12041355`) |
| Pyth package | `0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837` |
| Wormhole State | `0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790` (`initialSharedVersion = 1451`) |
| **BTC/USD feed id — TESTNET (BETA channel). USE THIS.** | **`0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`** |
| Beta Hermes endpoint | `https://hermes-beta.pyth.network` |
| BTC/USD feed id (stable / mainnet — **do NOT ship on testnet**) | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |

Verified by exact-symbol match on Hermes Beta: the query `btc/usd` returns **12** feeds (TBTC, CBBTC, EBTC, UBTC, WBTC, LBTC, MBTC, ZBTC, SOLVBTC …). **Match on `attributes.symbol === "Crypto.BTC/USD"` exactly; never fuzzy-match.** [D5]

**There is NO Pyth Move dependency** [R3]. `docs/MOVE-PACKAGE.md` §4 already passes `oracle_mid: u128` as a *parameter* to the envelope check — nothing in Move calls Pyth. Pyth's Sui contracts are `edition = "legacy"` with a heavy pinned Wormhole dep; importing them buys nothing and risks the whole build. The Pyth read lives in the keeper (`oracle/`), which passes the value in.

Rules:
- Use the BETA-channel feed id on testnet.
- PIN Pyth State + package versions (auto-upgrade 2026-08-18).
- Add staleness guards (`now − publishTime > PYTH_MAX_STALENESS_MS` ⇒ refuse).
- Value collateral/NAV at the live **DeepBook mid** (depeg defence, G1/G9), not the oracle price directly.
- Oracle-divergence circuit breaker = Pyth BTC/USD vs DeepBook TWAP — evaluation refuses to run if they diverge beyond threshold.

---

## Move dependencies

Anchor: `#move-deps`

Both upstream packages ship a `Published.toml` with `[published.testnet]`, so the **new** Move package manager resolves `published-at` / `original-id` automatically. **No `[dep-replacements]`, no `[addresses]`, no explicit `Sui = {git…}` line.** [R3]

| Package | git | subdir | pinned rev |
|---|---|---|---|
| `hashi` | `https://github.com/MystenLabs/hashi.git` | `packages/hashi` | `d9ad6bf440a737a23e0a239d4dfe5a6a51a1de9f` |
| `deepbook` | `https://github.com/MystenLabs/deepbookv3.git` | `packages/deepbook` | `0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb` |

- Hashi `[published.testnet]`: `published-at = original-id = 0xfcea10ca…`, version 1, chain-id `4c78adac`.
- DeepBook `[published.testnet]`: `original-id = 0xfb28c4cb…`, `published-at = 0xd874d241…`, **version 20**.
- Both use `Move.lock` v4 / `sui_system = { system = "sui_system" }`.
- Framework rev both upstreams pin: `22f9fc9781732d651e18384c9a8eb1dabddf73a6`.
- **No Pyth Move dep** (see `#pyth-oracle`). **No Seal / Walrus Move deps** — both are off-chain SDKs; the only on-chain Seal surface is our own `seal_approve`.
- ⚠ The DeepBook rev is **ahead of deployed v20** — see `#deepbook-venue`.

---

## Seal / Walrus / zkLogin

Anchor: `#seal-walrus-zklogin` (aliases: `#seal`, `#walrus`, `#zklogin`)
<a id="seal"></a><a id="walrus"></a><a id="zklogin"></a>

All three verified live on testnet alongside DeepBook and Hashi (U7 RESOLVED). [D8]

### Seal

| Field | Value |
|---|---|
| Seal package (testnet) | `0xdccbeb87767be2b2346af5575eb139807205e4c23ec53dc616f951fe1d814112` (original-id `0x4614e5da0136ee7d464992ddd3719d388ae2bfdb48dfec6d9ad579f87341f2e1`, version 6) |
| Independent key server #1 | objectId `0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75` · `https://seal-key-server-testnet-1.mystenlabs.com` · shared, `initialSharedVersion 443947654` |
| Independent key server #2 | objectId `0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8` · `https://seal-key-server-testnet-2.mystenlabs.com` · shared, `initialSharedVersion 443947655` |
| Decentralized (committee) server | objectId `0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98` · aggregator `https://seal-aggregator-testnet.mystenlabs.com` |
| Key-server version (health) | `0.6.11`, `status: up` on all three |
| SDK | `@mysten/seal@1.3.4` |

⚠ `@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`.** Construct `SealClient({ suiClient, serverConfigs: [{ objectId, weight: 1 }, …], verifyKeyServers })` with explicit ids from the table. `/v1/service` requires **both** a `Client-Sdk-Version` header (else `400 MissingRequiredHeader`) **and** a `?service_id=` query param (else `400 InvalidServiceId`). Each server's self-reported `service_id` was cross-checked against its on-chain object id — the anti-impersonation check passes.

**Aphotic default:** the two independent servers, `threshold = 2`. Threshold (t-of-n) access control; a Move `seal_approve` gate authorizes decryption and each key server dry-runs `aphotic::vault::seal_approve` before releasing a share. Identity is NAMESPACED to the vault object + a version epoch (rotation/revocation + scoped historical disclosure). Rotating the keeper increments the version epoch, invalidating previously derived key shares.

### Walrus

| Field | Value |
|---|---|
| Publisher (primary) | `https://publisher.walrus-testnet.walrus.space` |
| Aggregator (primary) | `https://aggregator.walrus-testnet.walrus.space` |
| Publisher (backup) | `https://wal-publisher-testnet.staketab.org` · `https://walrus-testnet-publisher.nodes.guru` |
| Aggregator (backup) | `https://wal-aggregator-testnet.staketab.org` · `https://walrus-testnet-aggregator.nodes.guru` |
| PUT | `PUT {publisher}/v1/blobs?epochs=<N>` (body = raw bytes) |
| GET | `GET {aggregator}/v1/blobs/{blobId}` |
| Current Walrus epoch (2026-07-25) | `469` |
| SDK | `@mysten/walrus@1.2.9` |

Verified round trip: a 32-byte blob written with `?epochs=5` returned `blobId GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM`, blob object `0x75757b0f…c60634`, `startEpoch 469 → endEpoch 474`, and the aggregator returned the exact bytes.

- Blob lifetime is the `epochs` parameter at write time and **defaults to a single epoch if omitted** — set `WALRUS_EPOCHS` EXPLICITLY and long. (`?epochs=5` was honoured verbatim.)
- Blob ids are content-derived (self-certifying). Blobs are PUBLIC + discoverable — **encrypt before upload, always.**
- ⚠ A freshly published blob comes back **`"certifiedEpoch": null`** and **`"deletable": true`**. An `envelope.move` availability check that demands *certified* **and** *non-deletable* would reject our own fresh blob. Either relax the predicate, or register storage explicitly as non-deletable, and always allow a grace window before requiring certification.
- The vault also retains an in-object ciphertext copy so expiry degrades verifiability rather than halting the vault. A renewal task extends lifetime before expiry.

### zkLogin

| Field | Value |
|---|---|
| Prover (prod) | `https://prover.mystenlabs.com/v1` — reachable (POST `{}` ⇒ `400`, i.e. alive and rejecting a malformed body) |
| Prover (dev) | `https://prover-dev.mystenlabs.com/v1` — reachable (`400`) |
| Enoki | `@mysten/enoki@1.2.7`; `https://api.enoki.mystenlabs.com/v1/zklogin` returns `404` — use the Enoki SDK, not that raw path |

Wallet-free deposit path (Google login → Sui address) + sponsored transactions (no SUI for gas on first deposit). Custody remains with the depositor throughout. **Reclaim must be signed by the depositor's zkLogin session** (see `#hashi-move-api`).

---

## Events

Anchor: `#events` (alias: `#hashi-events`)
<a id="hashi-events"></a>

**Real, on-chain-observed type strings.** Let `P = 0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360`. Every row below was returned verbatim by `suix_queryEvents`. [D10a]

| Module | Event | Fully-qualified type | `parsedJson` fields |
|---|---|---|---|
| `withdrawal_queue` | `WithdrawalRequested` | `P::withdrawal_queue::WithdrawalRequested` | `bitcoin_address` (vec u8, 20\|32) · **`btc_amount`** · `request_id` · `requester_address` · `sui_tx_digest` · `timestamp_ms` |
| | `WithdrawalApproved` | `…::WithdrawalApproved` | `request_id` |
| | `WithdrawalPickedForProcessing` | `…::WithdrawalPickedForProcessing` | `change_outputs` · `inputs` · `randomness` · `request_ids` · `timestamp_ms` · `txid` · **`withdrawal_outputs[] {amount, bitcoin_address}`** · `withdrawal_txn_id` |
| | `WithdrawalInputsSigned` | `…::WithdrawalInputsSigned` | `num_inputs` · `signed_count` · `withdrawal_txn_id` |
| | **`WithdrawalSigned`** | `…::WithdrawalSigned` | `guardian_signatures` · `request_ids` · `signatures` · `withdrawal_txn_id` |
| | `WithdrawalConfirmed` | `…::WithdrawalConfirmed` | `change_utxo_amounts` · `change_utxo_ids` · `request_ids` · `txid` · `withdrawal_txn_id` |
| | `WithdrawalCancelled` | `…::WithdrawalCancelled` | (not observed in window) |
| | `WithdrawalPresigsReassigned` | `…::WithdrawalPresigsReassigned` | (not observed in window) |
| `deposit` | `DepositRequested` | `P::deposit::DepositRequested` | `amount` · `derivation_path` · `request_id` · `requester_address` · `sui_tx_digest` · `timestamp_ms` · `utxo_id {txid, vout}` |
| | `DepositApproved` | `…::DepositApproved` | `approval_timestamp_ms` · `cert` · `request_id` · `utxo` |
| | `DepositConfirmed` | `…::DepositConfirmed` | `request_id` · `utxo {amount, derivation_path, id{txid,vout}}` |
| | `ExpiredDepositDeleted` | `…::ExpiredDepositDeleted` | (not observed in window) |
| `treasury` | `Minted<T>` | **`P::treasury::Minted<P::btc::BTC>`** | `amount` |
| | `Burned<T>` | **`P::treasury::Burned<P::btc::BTC>`** | `amount` |

> The names previously recorded here (`deposit::Approved`, `withdrawal_queue::Signed`, `utxo_pool::UtxoSpent`) **do not exist**. The prefix is part of the identifier: `WithdrawalSigned`, not `Signed`. There is no `utxo_pool` event family.

### ⚠ Three normalization rules the G5 replay depends on [D10b] [D10c]

1. **`WithdrawalSigned` carries NO amount and NO timestamp.** Confirmed on live data (`Signed has timestamp_ms field? false`, `Signed has amount field? false`). To advance the bucket you must join:
   - **sats** = Σ over `request_ids` of `WithdrawalRequested.btc_amount`. *(Use the REQUESTED amount. `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount` is net of the Bitcoin network fee — observed `1_000_000` requested vs `998_835` output — and the bucket is debited by the requested amount.)*
   - **timestamp** = the **Sui event ENVELOPE** field.
2. **The envelope timestamp field is `timestampMs`** (camelCase) and arrives as a **decimal STRING** over JSON-RPC ⇒ `BigInt(e.timestampMs)`, never `parseInt`. Where a struct also has `timestamp_ms` the two differ slightly (observed 701 ms apart) — always prefer the envelope for limiter arithmetic, because `WithdrawalSigned` has no struct timestamp at all.
3. **`treasury::Minted`/`Burned` are GENERIC.** An event filter must match `P::treasury::Minted<P::btc::BTC>` **including the type argument**; a filter on the bare name will not match.

Limiter-critical subset for trustless replay (G5, see `#guardian-limiter`): `WithdrawalRequested` → `WithdrawalPickedForProcessing` → `WithdrawalSigned`. `WithdrawalSigned` is the event that advances the bucket.

Flow-signal note: `DepositApproved` precedes the mint by ~10 min; `WithdrawalRequested` precedes the burn — the peg-flow strategy uses these as a public signal telegraphed before it hits the book.

Aphotic must emit an event for EVERY externally-visible state transition (see conventions below).

---

## Networks & faucets

Anchor: `#networks-faucets` (aliases: `#deployments`, `#hashi`)
<a id="deployments"></a><a id="hashi"></a>

Target: **Sui testnet** (Hashi testnet launched 2026-07-22; devnet wipes would eat IDs). Bitcoin side = **signet**. DeepBook v3, Walrus, Seal, Pyth all operate on testnet.

### Hashi deployments

| | Sui testnet | Sui devnet |
|---|---|---|
| Package | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360` (Immutable, v1) | `0xa877d4d97b6a8bae1da982a84980c502c5ad2ead4b24e6c8e50c57cd6ddc3771` |
| `Hashi` shared object | `0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8` (`initialSharedVersion = 805474231`) | `0x84081242ebb05eac5e09ab2a930a60b1357d3d8bc6f927380979f72de991ccca` |
| Coin type | `0xfcea10ca…::btc::BTC` | N/A — we are not targeting devnet |
| Frontend | `https://testnet.hashi.sui.io` | `https://devnet.hashi.sui.io` |
| Guardian | `https://guardian.testnet.hashi.sui.io` (**HTTP/2 only**) | — |

The devnet ids **do not exist on testnet** — verified (`Some requested entity was not found`). They are listed only so nobody pastes them by accident. Mainnet: NOT deployed.

### Signet faucets

| Faucet | Reachability (2026-07-25) |
|---|---|
| `https://signet257.bublina.eu.org/` | HTTP 200 |
| `https://signetfaucet.com` | HTTP 200 |
| `https://alt.signetfaucet.com/` | HTTP 200 |

Delivery time/amount NOT measured — both are human/captcha-gated (`#unknowns` U6). **Start dripping day one; hBTC cannot be obtained any other way (`#hbtc`).**

### Reference URLs

| Resource | URL |
|---|---|
| Hashi × DeepBook integration demo | `https://mystenlabs.github.io/hashi-integrations/` |
| Hashi design docs | `https://mystenlabs.github.io/hashi/design` |
| Hashi source | `github.com/MystenLabs/hashi` (`packages/hashi/sources/`) |
| SDK source | `MystenLabs/ts-sdks` (`packages/hashi/`) |
| Seal source + docs | `github.com/MystenLabs/seal` (`docs/content/UsingSeal.mdx`, `_SealPackageIds.mdx`) |
| DeepBook source | `github.com/MystenLabs/deepbookv3` (`packages/deepbook/sources/`) |

---

## Competitive

Anchor: `#competitive`

| Field | Value |
|---|---|
| Sui prize total | `$6,000` |
| — "Best App Built on Sui" | `$4,000` |
| — Continuity | `$2,000` |
| Featured stack | Move / Seal / Walrus / DeepBook / zkLogin |
| Hashi/BTC requirement | NONE written — soft expectation, verbally encouraged by the jury |
| Field (Suilend, AlphaLend, Navi, Scallop) | integrate Hashi day one AS LENDING (money markets) |
| Aphotic differentiation | a PRIVATE MARKET-MAKING VAULT — structurally differentiated from the "BTC-lending clones"; uses the EXACT featured stack |

Honest framing (G8): hBTC IS custodial-threshold wrapped BTC (threshold Schnorr across an opt-in stake-weighted validator subset, 2-of-2 with a Guardian enclave, ~60-day CSV recovery leaf). The differentiation is composing the bridge's on-chain machinery, NOT the token's trust model:
1. Move-composed exits with on-chain destination pinning.
2. Bridge-aware risk envelope, trustlessly verifiable via `project_capacity()` replay.
3. Permissionless `confirm_deposit` crank (public good).
4. Peg-flow signal (only exists because mint/burn intents are on-chain).

⚠ Honesty upgrade after D4: the live limiter is a **100 BTC bucket refilling ~100 BTC/day**. Do **not** pitch bridge congestion as a scarcity story — an Aphotic-sized exit will never be rate-limited on testnet. Pitch the *verifiability*: "we re-derive the bridge's own rate limiter from its own on-chain events, and we can show you the arithmetic." That claim is true, checkable, and does not depend on the bucket being tight.

---

## Conventions (build-time — for cross-reference)

Anchor: `#conventions`

| Layer | Convention |
|---|---|
| Move package name | `aphotic` |
| Move modules | `vault` (shared Vault object, share/NAV accounting, `seal_approve`), `gateway` (Hashi boundary: `register_exit_address`, `exit_to_bitcoin`, `reclaim_stalled_exit`, small-exit pooling), `envelope` (constraint checks incl. redemption buffer + trustless limiter replay hooks), `router` (DeepBook maker+IOC entrypoints), `journal` (decision-log blob ids emitted on-chain) |
| Move amounts | sats (`u64`) |
| Move events | emit an event for EVERY externally-visible state transition |
| Move errors | error constants named `E<Reason>` |
| Move tests | under **`move/tests/`** — NOT `move/sources/tests/`. A test that `use`s `hashi::` inside `sources/` breaks the G7 isolation gate (`grep -rl 'hashi::' move/sources/` must return exactly `sources/gateway.move`). |
| Move edition | 2024 (G10) |
| Keeper | TypeScript, ESM. Dirs: `sui/` (the ONE `SuiGrpcClient` factory), `hashi/` (adapter interface + mock + real + shared `limiter.ts`), `strategy/`, `routing/`, `execution/`, `oracle/`, `storage/`, `journal/`, `verify/`, `privacy/`, `config/` |
| Keeper money | `bigint` everywhere; `number` for sats is forbidden |
| App | React **19** + Vite. Screens: deposit / exit / transparency, plus the landing page at `/` |
| Docs | under `C:/Users/adria/sui-lisbon/docs/`; cross-reference by exact filename + anchor (e.g. `see docs/FACTS.md#hbtc`); every doc starts with a one-line purpose + "Read after: <files>" |

---

## UNKNOWNS

Anchor: `#unknowns`

Owner: `docs/DAY-ONE.md`. Evidence: `docs/DAY-ONE-RESULTS.md`. **All rows are RESOLVED, LOGGED with a chosen fallback, or N/A — none are blocking `real` mode except U6, which is a human/time item, not a technical one.**

| # | Unknown | Status | Value / fallback |
|---|---|---|---|
| U1 | Live testnet Guardian limiter values (`refill_rate`, `max_bucket_capacity`) | **RESOLVED [D4]** | `refill_rate = 115_740` sats/s · `max_bucket_capacity = 10_000_000_000` sats (100 BTC). Read from `GET {guardian_url}/info` over **HTTP/2**. The old prior (1000 sats/s / 1 BTC) was wrong by ~100× and is deleted. See `#guardian-limiter`. |
| U2 | Testnet BTC/USD Pyth BETA feed id | **RESOLVED [D5]** | `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`. See `#pyth-oracle`. |
| U3 | Does `Hashi` expose public getters for withdrawal-queue depth / config? | **RESOLVED = NO [D2]** | Verified against deployed bytecode: all 46 `withdrawal_queue` getters and all 15 `btc_config` accessors are `public(package)`. **Fallback engaged unconditionally**: `envelope.move` uses the static redemption-buffer ratio + off-chain event replay; the withdrawal minimum is a Move **constant** `30_000`. There is no getter branch to implement. |
| U4 | Does `generateDepositAddress` accept an arbitrary 32-byte value (an object id) as `suiAddress`? | **RESOLVED = YES [D6]** | It is a pure offline derivation; four distinct 32-byte inputs (incl. two synthetic object ids) produced valid, deterministic signet P2TR addresses. `BUILD-PLAN` T5.3 is derivation-unblocked. ⚠ *Caveat:* that `confirm_deposit` actually MINTS to an object id is **unproven** — it needs a live deposit. Treat T5.3 as *derivation-unblocked, mint-unproven*; do not put it on the demo critical path. |
| U5 | Devnet hBTC coin type | **N/A** | Targeting testnet. The devnet package does not exist on testnet [D1]. Closed — no work. |
| U6 | Signet faucet throughput | **LOGGED — PARTIAL [D7]** | All three faucets return HTTP 200; **delivery time/amount not measured** (human/captcha gated, and this run does not create wallets on the user's behalf). **Fallback = none — there is no alternative source of hBTC** (`#hbtc`). Owner: build lead. **Start dripping today.** This is the longest-lead item in the plan. |
| U7 | Do Seal key servers + Walrus publisher/aggregator + zkLogin prover coexist on testnet with DeepBook and Hashi? | **RESOLVED = YES [D8]** | Concrete endpoints and object ids recorded in `#seal-walrus-zklogin`. Walrus PUT→GET round trip succeeded; both Seal key servers healthy with on-chain-matching `service_id`; both zkLogin provers reachable. No adapter-mocking fallback needed. |
| U8 | Live hBTC/DBUSDC book depth + maker placement with a fresh `BalanceManager` | **PARTIAL — fallback engaged [D3]** | Book is **empty on both sides**; `mid_price` aborts `EEmptyOrderbook(2)`, `get_level2_range` returns `([], [])` ⇒ **read the book only via `get_level2_range`**. `BalanceManager` + `TradeCap` creation dry-runs green. **Live maker placement NOT attempted** — it needs hBTC inventory (U6). **Fallback (now a hard requirement, not an option): a scripted second account seeds both sides of the book.** Also: deployed v20 lacks `best_bid_price`/`best_ask_price`/`place_post_only_limit_order` — see `#deepbook-venue`. |
| U9 | Do the Hashi testnet IDs respond on a public fullnode? | **RESOLVED = YES [D1]** | All 8 testnet ids (Hashi package + shared object, Pool, DBUSDC, DeepBook v20, Pyth State + package, Wormhole State) resolve; the devnet package correctly does not. |

### Newly opened (not in the original U-list)

| # | Item | Status |
|---|---|---|
| N1 | The `@mysten/hashi@0.6.0` API in `docs/KEEPER.md` / `docs/APP.md` (`view.*`, `waitFor*`, `guardian.limiterStatus`, `requestWithdrawal`, …) **does not exist**. | **LOGGED.** Fallback: build those flows on `HashiClient` + raw `moveCall`s + event polling behind our own adapter — which is what G7 mandates anyway. See `#sdk`. |
| N2 | Pinned DeepBook dep rev is ahead of deployed v20 by 3 `pool` functions. | **LOGGED + avoided.** Do not call `best_bid_price` / `best_ask_price` / `place_post_only_limit_order`. See `#deepbook-venue`. |
| N3 | RECON R9 golden vectors #1 and #7 are arithmetically wrong (`105_000` should be `100_150`). | **CORRECTED here.** Use the table in `#guardian-limiter`. |
| N4 | Fresh Walrus blobs are `deletable: true` / `certifiedEpoch: null`. | **LOGGED.** An `envelope.move` availability predicate demanding certified+non-deletable would reject our own writes. See `#seal-walrus-zklogin`. |
