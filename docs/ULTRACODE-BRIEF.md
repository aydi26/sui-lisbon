# ULTRACODE-BRIEF.md — the entry document for the implementation run

> You are the massive coding run. The skeleton is done: every file exists, compiles, and carries a machine-readable contract. Your job is to fill bodies, not to design or to re-derive facts.
> **Start here. You should be writing code inside a minute.**

---

## 0. The 60-second start

```bash
# 1. Confirm the floor is still green (should be 8 PASS · 0 FAIL · 0 SKIP)
powershell -NoProfile -File scripts/verify-all.ps1

# 2. Pick the next task from docs/STATUS.md (BUILD-PLAN order, cut line first)

# 3. Open every file carrying it
grep -rn 'TODO(T1.1)' move keeper app

# 4. Read that file's banner. The banner IS the spec. Implement. Flip @status. Delete the TODOs.
```

## 1. Read order

| # | Doc | Why | Skip if… |
|---|---|---|---|
| 1 | **`docs/RECON.md`** | Verified ground truth from live probes. **NEVER re-derive anything in it. Where it contradicts another doc, RECON wins** — except the two arithmetic slips listed in §5 below. | never skip |
| 2 | **`docs/GOLDEN-RULES.md`** | G1–G10 with RULE / WHY / **NEVER**. Violating one is a failure, not a style issue. | never skip |
| 3 | **`docs/CONVENTIONS.md`** | The banner grammar you must read from and write back to. | never skip |
| 4 | **`docs/FACTS.md`** | Canonical IDs, types, signatures. Cite by anchor; never inline an unexplained literal. | never skip |
| 5 | **The layer spec for your task** — `docs/MOVE-PACKAGE.md` · `docs/KEEPER.md` · `docs/APP.md` | Design intent. **Read its `ERRATA (2026-07-25)` section FIRST — it wins over the body above it.** | other layers |
| 6 | **`docs/STATUS.md`** | Per-task ledger: what is real, what is a stub, what is blocked. | never skip |
| 7 | `docs/BUILD-PLAN.md` | Execution order, AC, dependency ids, the CUT LINE. | — |
| 8 | `docs/DAY-ONE-RESULTS.md` · `docs/ARCHITECTURE.md` | Receipts and system model. Consult on demand. | — |

**Conflict resolution:** layer-spec ERRATA > `docs/RECON.md` > `docs/FACTS.md` > layer-spec body > `HASHI_INTEGRATION.md` > `README (8).md`. `BTC_FIXED_INCOME.md` is a **shelved alternative — never implement it.**

## 2. The contract banner, in one paragraph

Every non-trivial source file carries **exactly one** `APHOTIC CONTRACT` banner — immediately after the module declaration in Move, at the very top in TS/TSX — delimited by the fixed literals `┌── APHOTIC CONTRACT ───` and `└── END CONTRACT ───`, comment-prefixed with `//`. Its fields are `@task` (BUILD-PLAN ids), `@phase`, `@status` (`STUB`|`PARTIAL`|`DONE`), `@spec` (the doc lines that *are* the contract), `@rules` (binding G-rules), `@depends`, `@facts` (**every constant pre-resolved — if a value is not there, add it there before using it, never inline an unexplained literal**), `@external` (verbatim upstream signatures + gotchas), `@implements` (copy-pasteable signatures you must write), `@events`/`@errors` (Move only), `@forbidden` (with the gate that catches it), numbered `@invariant`s, `@ac`, and `@verify` commands. `@task`, `@status`, `@spec`, `@implements`, `@verify` are mandatory. **Every `@implements` signature must either exist in the body or have a `TODO(<task>)` on the line above it.** You flip `@status` to `DONE` only when **zero** `TODO(<its task ids>)` remain in that file — and you delete the module-level `#[allow(unused_const, unused_field)]` suppression at the same time.

**The census greps** (`docs/CONVENTIONS.md` §3):

```bash
# Work remaining, grouped by task id — the headline command
grep -roh 'TODO(T[0-9]\+\.[0-9]\+)' move/sources move/tests keeper/src keeper/test app/src | sort | uniq -c

# All TODOs for ONE task — what you open with
grep -rn 'TODO(T1.3)' move keeper app

# Everything still a stub
grep -rln '@status *STUB' move keeper app
```

```powershell
# Same census, native (also emitted by the `todo` gate)
powershell -NoProfile -File scripts/gates.ps1 todo
```

## 3. Work remaining — the census, in BUILD-PLAN order

**322 `TODO` markers · 24 task ids · 100 files.** Verified by direct inspection, 2026-07-25.

| Task | TODOs | Status | Primary files |
|---|---:|---|---|
| **T0.1–T0.6** | **0** | **DONE / PARTIAL** | Scaffold complete. T0.1 has two open **human-ops** items (see §7 B1/B2). |
| T1.1 Vault + share math | 20 | STUB | `move/sources/vault.move`, `move/tests/vault_tests.move` ⚠ 15 empty-body tests |
| T1.2 `seal_approve` gate | 14 | STUB | `move/sources/vault.move` |
| T1.3 Gateway register + composed exit | 4 | PARTIAL | `move/sources/gateway.move` — pure guards already real |
| T1.4 Gateway reclaim + small-exit pool | 4 | STUB | `move/sources/gateway.move` |
| T1.5 Router maker + IOC | 17 | PARTIAL | `move/sources/router.move` — granularity guard already real |
| T1.6 Gateway unit tests | 16 | STUB | `move/tests/gateway_tests.move` (+ real `mock_hashi.move`) |
| T2.1 Real Hashi adapter | 16 | STUB | `keeper/src/hashi/real.ts` |
| T2.2 Event watcher | 4 | STUB | `keeper/src/hashi/watcher.ts` |
| T2.3 `confirm_deposit` crank | 8 | STUB | `keeper/src/execution/crank.ts` |
| T2.4 Sponsored deposit sweep | 7 | STUB | `keeper/src/execution/sweep.ts` |
| T2.5 Withdrawal tracker | 14 | STUB | `keeper/src/execution/{exit,reclaim}.ts` |
| T2.6 Strategy + Seal | **37** | STUB | `keeper/src/strategy/**`, `keeper/src/privacy/**` |
| T2.7 Routing L2 + maker/IOC | **32** | STUB | `keeper/src/routing/**`, `keeper/src/execution/trade.ts` |
| T2.8 Oracle divergence breaker | 22 | STUB | `keeper/src/oracle/**` |
| T2.9 Walrus storage | 18 | STUB | `keeper/src/storage/**` |
| T2.10 E2E run loop (mock) | 7 | STUB | `keeper/src/index.ts` ⚠ **no `e2e.mock` test file exists yet** |
| T3.1 Deposit screen | 5 | STUB | `app/src/screens/deposit/`, `components/QrCode.tsx`, `app/src/hashi/` |
| T3.2 Exit screen | 6 | STUB | `app/src/screens/exit/` |
| T3.3 zkLogin + sponsored | 8 | STUB | `app/src/session/zkLogin.ts` |
| **═══════════ CUT LINE ═══════════** | | | **everything above must be green first** |
| T4.1 Envelope redemption buffer | 13 | PARTIAL | `move/sources/envelope.move` — the **G5 limiter twin is already real + tested** |
| T4.2 Journal decision records | 25 | STUB | `keeper/src/journal/**`, `move/sources/journal.move` |
| T4.3 Verify: trustless limiter replay | 16 | STUB | `keeper/src/verify/**` |
| T5.1 Peg-flow signal | 4 | STUB | `keeper/src/strategy/pegflow.ts` |
| T5.2 Transparency panel | 5 | STUB | `app/src/screens/transparency/`, `components/BridgeColumn.tsx` |
| T5.3 Deposit-ticket TTO | 0 | NOT-STARTED | no files — unblocked (U4 = YES) |

### What is already REAL — do not rewrite it

| Code | Coverage |
|---|---|
| `keeper/src/hashi/{limiter,mock,adapter,normalize,eventTypes,types}.ts` | 44 tests. The deterministic bridge simulation + the canonical `projectCapacity`. |
| `keeper/src/config.ts`, `types.ts`, `sui/client.ts`, `util/**` | Pure `loadConfig(env)`, the single Sui client factory, bigint/bytes/env/errors/rng helpers. |
| `move/sources/envelope.move` limiter half | 9 Move tests — the G5 twin of `limiter.ts`. |
| `move/sources/gateway.move` address/minimum guards | 5 tests. |
| `move/sources/router.move` granularity guard | 6 tests. |
| `move/sources/journal.move` seq guard | 2 tests. |
| `move/tests/mock_hashi.move` | Full bridge stand-in with all five upstream asserts. |
| `app/src/{config,routes,fixtures/**,components/**,landing/**}` | Builds green; landing page ported with textures vendored. |

## 4. VERIFY matrix

Run the aggregate first; drop to the specific command when something is red.

| Command | Green means | Measured 2026-07-25 |
|---|---|---|
| `powershell -NoProfile -File scripts/verify-all.ps1` | **The master gate.** All 8 steps below pass. `SKIP` is **not** green. | `8 PASS · 0 FAIL · 0 SKIP` |
| `cd move && sui move build` | Package `aphotic` compiles, edition `2024.beta`, **zero warnings**. | exit 0 |
| `cd move && sui move test` | All `move/tests/*_tests.move` pass. ⚠ Not coverage of T1.1/T1.2 — `vault_tests.move` bodies are empty. | `OK. Total tests: 37; passed: 37` |
| `cd move && sui move test --filter gateway` | T1.3/T1.4/T1.6 tests only. | 5 pass |
| `cd move && sui move test --filter envelope` | T4.1 limiter twin. | 9 pass |
| `cd keeper && npm run typecheck` | `tsc --noEmit` over `src/` + `test/` under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + NodeNext. | exit 0 |
| `cd keeper && npm run build` | Emits `dist/**` with `.d.ts` + sourcemaps; the ESM actually runs. | exit 0 |
| `cd keeper && npm test` | Full vitest suite. | `5 files · 44 tests passed` |
| `cd keeper && npm run test -- hashi.mock` | BUILD-PLAN T0.5 acceptance. | 13 pass |
| `cd keeper && npm run test -- e2e.mock` | **Cut-line acceptance for T2.10.** ⚠ Today this matches **no file** and passes by vacuum — authoring it is part of T2.10. | n/a |
| `cd app && npm run build` | `tsc --noEmit && vite build`. | exit 0, 1029 modules |
| `powershell -NoProfile -File scripts/gates.ps1` (or `bash scripts/gates.sh`) | All 8 invariant gates — see below. | `7 PASS · 0 FAIL · 0 SKIP` + `todo` census |
| `node scripts/verify-onchain.mjs` | Every canonical id resolves live on testnet; config scalars, event streams and the Pyth Beta feed match FACTS. Needs network. | `25 PASS · 0 FAIL · 0 WARN · 8 INFO` |

### The 8 invariant gates (`scripts/gates.ps1`)

| Gate | Enforces | Fails if you… |
|---|---|---|
| `g7` | `hashi::` appears in **exactly** `move/sources/gateway.move` | import Hashi into any other Move source |
| `g4` | No `cetus`/`clmm` anywhere in `move/sources/` | add a non-DeepBook venue leg or CLMM range logic. ⚠ Even the *words* in a comment trip it — the banners say "any non-DeepBook venue leg" on purpose |
| `g2` | No Bitcoin-address parameter on any exit function | let the exit destination be a runtime input |
| `ids` | Canonical ids only in `keeper/src/config.ts`, `app/src/config.ts`, `.env.example`, `move/Move.toml` | hardcode an id in logic |
| `sdk` | `@mysten/hashi` imported only in `keeper/src/hashi/real.ts` | import the SDK from a screen or a strategy |
| `purity` | No `Date.now()`/`Math.random()` in `strategy/` or `routing/` | make `evaluate()`/`route()` non-deterministic |
| `transport` | Sui client constructed only in `keeper/src/sui/client.ts` and `app/src/lib/suiClient.ts` | `new SuiGrpcClient(...)` anywhere else |
| `todo` | informational census | — |

## 5. ERRATA digest — every correction, so nobody re-derives a wrong fact

The layer specs each carry a full `ERRATA (2026-07-25)` section that **wins over the body above it**. This is the compressed index. When implementing, read the full item.

### Arithmetic and the G5 limiter

| id | Correction |
|---|---|
| **RECON R9 #1/#7** | **`105_000` is WRONG — the correct value is `100_150`.** `100_000 + 15 s × 10 sats/s = 100_150`; the upstream SDK returns `100150n`. RECON's *algorithm* is right; only those two expected values are slips. Both twins already encode `100_150` and cross-test green. **Do not "fix" them back.** (E-K4, E-M5) |
| **E-K2 / E-M5** | Live limiter scalars: **`refill_rate = 115_740` sats/s**, **`max_bucket_capacity = 10_000_000_000` sats (100 BTC)** — a full bucket refills in ~24 h. The old `1000` / `100_000_000` prior is wrong by ~100×. Consequence: an Aphotic-sized exit will **never** be rate-limited on testnet ⇒ the envelope is an honest **risk input**, not a scarcity story. |
| **E-M5** | Move must emulate saturation **explicitly**: `u64` add/mul **abort** on overflow, and a plain `u64` subtraction of out-of-order timestamps aborts too. Widen to `u128` before the `min`, then narrow. TypeScript must use `bigint` — a 100 BTC bucket × large elapsed exceeds `Number.MAX_SAFE_INTEGER`. **"No `number` for sats" is load-bearing, not stylistic.** |
| **E-K1 (resolved both ways)** | Two shapes ship deliberately: `projectCapacity(tokens, refillRate, cap, elapsedMs)` (canonical, BUILD-PLAN T0.5 / KEEPER §2.4) **and** `projectCapacityAtSecs(cfg, state, tsSecs)` (exact upstream mirror). Move mirrors both: `project_capacity(...)` and `project_capacity_secs(...)`. Same math, different shape. Time base is **UNIX SECONDS**; `msToSecs` is the only sanctioned ms→s conversion and it floors **elapsed**, not each endpoint. |
| **E-K3 / E-R4** | **`WithdrawalSigned` carries NO amount and NO timestamp.** The replay is a **join**: sats = Σ over `request_ids` of `WithdrawalRequested.btc_amount` (**use the requested amount** — `withdrawal_outputs[i].amount` is net of the Bitcoin network fee, observed `1_000_000` vs `998_835`); timestamp = the **Sui event envelope** `timestampMs`, a decimal **string** ⇒ `BigInt(e.timestampMs) / 1000n`, never `parseInt`. Flow 4 consumes **two** streams, not one. |

### Hashi surface

| id | Correction |
|---|---|
| **E-M3 / R7.1** | All 15 `hashi::btc_config` accessors are `public(package)` ⇒ **not callable from `aphotic`.** Inject `30_000` (withdrawal min), `546` (dust), `3_600_000` ms (cancel cooldown), `600_000` ms (deposit delay) as named constants. |
| **E-M4 / E-R2 / R7.2** | **U3 = NO.** All 46 `hashi::withdrawal_queue` getters are `public(package)` (only `output_utxo` is public). There is **no on-chain queue-depth read**. `envelope.move` takes the static-buffer + event-replay path **unconditionally** — do not write an "if the getter exists" branch. |
| **E-M8 / E-K7 / E-A3 / E-R1** | `cancel_withdrawal` asserts `request.sender == ctx.sender()` ⇒ **`reclaim_stalled_exit` is DEPOSITOR-ONLY. The keeper can NEVER call it.** `keeper/src/execution/reclaim.ts` must be an **unsigned PTB builder** the app hands to the depositor's zkLogin session. **INVARIANT:** any pooled small-exit flush must assert `who == ctx.sender()`, else the flusher becomes the only party able to reclaim. Sponsored gas is fine — sponsorship changes who *pays*, not who the *sender* is. |
| **E-M9 / E-R6** | `hashi::deposit::{deposit, confirm_deposit, approve_deposit, delete_expired_deposit}` are `visibility=Private, isEntry=true` ⇒ **PTB commands, not Move-callable.** The permissionless crank lives in the keeper/app PTB builder and must **never** appear as a `moveCall` inside `gateway.move`. **The entire Move-composable Hashi surface is exactly two functions:** `request_withdrawal` and `cancel_withdrawal`. |
| **E-K8 / E-A4** | Most of the `@mysten/hashi` API the specs describe **does not exist**. `0.6.0` exports only `HashiClient`, `hashi`, `generateDepositAddress`, `deriveChildPubkey`, `twoOfTwoTaprootScriptPathAddress`, `bitcoinAddressToWitnessProgram`, `witnessProgramToAddress`, `arkworksToSec1Compressed`, `projectCapacity`, `estimateWaitSecs`, `fetchGuardianInfo`, error classes. Build `view.*`/`waitFor*` on `HashiClient` + raw `moveCall`s + event polling **inside the adapter**. ⚠ **Do not use the SDK's `projectCapacity`** — no `u64` saturation, so it diverges at the extremes. Ours is canonical. |
| **E-K9 / E-A6** | The guardian's `GET {guardian_url}/info` is behind an ALB that **rejects HTTP/1.1 with status 464**. Node's `fetch`, `curl`, and the SDK's `fetchGuardianInfo` all fail. Use `node:http2` (ALPN `h2`). It reports the **raw last-consume state**, not a projected balance — the caller runs `projectCapacity` itself, which is exactly the G5 shape. |
| **E-K10 / E-A5** | `generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network })` — **four** args. `suiAddress` must be a **32-byte `Uint8Array`** (a `0x…` string throws). `mpcMasterCompressed` **must** be `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)` (raw arkworks bytes throw `bad point`). `witnessProgramToAddress`/`bitcoinAddressToWitnessProgram` both **require** the network arg. Fully offline ⇒ the QR renders before any network call. **U4 = YES:** any 32-byte value, including a synthetic object id, derives a valid deterministic signet P2TR address. |
| **R8** | Real event names: `treasury::{Minted,Burned}` · `deposit::{DepositRequested,DepositApproved,DepositConfirmed,ExpiredDepositDeleted}` · `withdrawal_queue::{WithdrawalRequested,Approved,PickedForProcessing,InputsSigned,Signed,PresigsReassigned,Confirmed,Cancelled}`. ⚠ **`utxo_pool::UtxoSpent` does not exist** — `docs/FACTS.md#events` is stale. ⚠ `treasury::Minted<T>` has **only** `amount`, no recipient — which is precisely why the keeper cannot redirect a mint (G2). The event `kind` in our types is the **verbatim** Move struct name (`WithdrawalPickedForProcessing`, not `WithdrawalPicked`). |

### DeepBook venue

| id | Correction |
|---|---|
| **E-M10 / R4** | **Three** DeepBook ids with distinct roles: original/type-origin `0xfb28c4cb…` (v1 — every `Pool`/`BalanceManager`/`TradeCap` **type** resolves here), superseded `0x22be4cad…` (v17 — **do not use**), current callable `0xd874d241…` (**v20 — every `moveCall` target**). Using the wrong one breaks type resolution. |
| **E-M6** | The deployed v20 package **does not contain** `best_bid_price`, `best_ask_price`, or `place_post_only_limit_order`, even though the pinned dep source does. A call to a function absent from the linked package **compiles and then fails at publish/link time**. Maker leg = `place_limit_order(…, order_type = 3 /* POST_ONLY */, self_matching_option = 0)`. |
| **E-M7 / E-K6 / E-A7** | `pool::mid_price` **aborts** `deepbook::book` code **2 = `EEmptyOrderbook`**; `pool::get_level2_range` **succeeds and returns `([], [])`**. **The book is empty on both sides right now.** Derive top-of-book from `get_level2_range`, treat empty as "no mid", render a defined empty state everywhere. |
| **R10 / E-K6** | The hosted indexer lists 7 pools and **does not include hBTC/DBUSDC** — never read the book from it. `@mysten/deepbook-v3`'s `DeepBookClient` is driven by a bundled registry that will not contain our pool — build raw `moveCall`s, use the SDK for BCS helpers only. `DBTC_DBUSDC` in the indexer is DeepBook's own test BTC, **not** hBTC. |
| **E-R6** | Confirmed on-chain: `balance_manager::{new, mint_trade_cap, mint_deposit_cap, mint_withdraw_cap, revoke_trade_cap}` and `generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof` all exist and are independent. A shared `BalanceManager` + owned `TradeCap` dry-runs green. **G2 is implementable exactly as drawn.** |

### Transport, oracle, storage

| id | Correction |
|---|---|
| **E-K5 / E-R5 / R1** | `https://fullnode.testnet.sui.io:443` serves **gRPC v2 only — JSON-RPC returns HTTP 404**. **`@mysten/sui@2.22.1` no longer exports `SuiClient`** (importing it throws). Use `SuiGrpcClient` from `@mysten/sui/grpc`, constructed in exactly one place per package. `SuiJsonRpcClient` is for probes against the mirror `https://rpc-testnet.suiscan.xyz:443` only. ⚠ `SuiGrpcClient` takes **`baseUrl`**; `SuiJsonRpcClient` takes **`url`**. |
| **E-K11 / E-M12 / R11** | **No Pyth Move dependency** — nothing in Move calls Pyth; `envelope::check_action` takes `oracle_mid: u128` as a **parameter**. Testnet feed = **Beta** `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b` at `https://hermes-beta.pyth.network` — **not** the stable `0xe62df6c8…`. Pin `PYTH_STATE_INITIAL_SHARED_VERSION = 12041355` and `WORMHOLE_STATE_INITIAL_SHARED_VERSION = 1451`. Match `attributes.symbol === "Crypto.BTC/USD"` **exactly** — `btc/usd` returns 12 look-alikes. Pyth DAO auto-upgrades Sui addresses **2026-08-18**. |
| **E-K12 / E-M11** | Walrus `PUT {publisher}/v1/blobs?epochs=N` → `GET {aggregator}/v1/blobs/{blobId}`; `WALRUS_EPOCHS` explicit (`< 2` already throws). Seal key servers `0x73d05d62…` / `0xf5d14a81…`, threshold 2 — `@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`**, pass `serverConfigs` explicitly. ⚠ A freshly published blob returns **`certifiedEpoch: null`, `deletable: true`** — an availability predicate demanding certified + non-deletable **rejects our own writes**. Allow a grace window; keep the on-chain read out of the critical path. |

### Build system and layout

| id | Correction |
|---|---|
| **E-M1 / R3** | `Move.toml` = `[package] name/edition` + exactly two git deps (`hashi`, `deepbook`). **No `Sui` dependency line, no `[addresses]`, no `[dep-replacements]`, no Pyth.** Both upstreams ship a `Published.toml` with `[published.testnet]`, so the new package manager resolves `published-at`/`original-id` and the framework automatically. Adding `Sui = {git…}` or `[addresses]` re-introduces the old system and fights it. |
| **NEW (this pass)** | **`[environments]` must be OMITTED.** `sui` 1.76.0 rejects `testnet = "4c78adac"` at resolution: *"Cannot override default environments … System environments: testnet, mainnet."* Documented in the `Move.toml` header. |
| **NEW (this pass)** | RECON **R3**'s "framework rev `22f9fc97…`" is misleading — the resolver actually pins `d50b7888…` because under the new package system the framework comes from the CLI's system environment, not the upstream manifests. Harmless; builds green. |
| **E-M2** | Tests live in **`move/tests/`**, not `move/sources/tests/` — otherwise `gateway_tests.move` (which necessarily contains `hashi::`) makes the **G7 gate unpassable**. |
| **E-A1 / E-A2 / R13** | React **19**, not 18 (the ported landing page is React 19 + `globe.gl` + `three` + `@number-flow/react`). **`/` is the LANDING PAGE**, not a redirect to `/deposit`. Porting constraints: `public/fonts/cravelo.otf` is mandatory; globe textures must be vendored (jsDelivr at runtime otherwise); the cloud-layer `requestAnimationFrame` loop is **never cancelled on unmount** — fix it; `HorizontalScroll` is hardcoded to exactly 3 cards (`300vh`/`300vw`). |
| **E-A8** | The `VITE_` table is fully resolved — take values from `app/.env.example`, never inline. |

### Latency and the demo

| id | Correction |
|---|---|
| **E-A9 / E-R7** | One measured withdrawal: `Requested → Approved` +10 s, `→ PickedForProcessing` +5.1 min, `→ Signed` **+5.4 min**, `→ Confirmed` **+57.9 min** on a quiet signet. Keep the conservative planning figures (single sample). **G6 stands unchanged** — 58 minutes is still far outside a 3-minute demo. |
| **E-R7 / R10** | **New hard dependency:** the book is empty **and hBTC cannot be minted by us** (`treasury::mint` is `public(package)`). The scripted book-seeder account is a **required component**, and it depends on the signet faucet drip completing first. |

### Spec deltas the skeleton already committed to — honour them

1. **`Vault<phantom B, phantom Q>` is GENERIC** over the asset pair, not concrete `Balance<BTC>`. Naming the hBTC type in `vault.move` would need a bridge import there and break the G7 gate. Only `gateway.move` instantiates `B` with the real hBTC type.
2. **`envelope` is the intra-package LEAF** and takes **primitives** (`idle_sats`, `nav_sats`, `paused`, …), never `&Vault`. `MOVE-PACKAGE.md` §1.3 draws `envelope → vault` while §3.1 gives `Vault.envelope: EnvelopeParams` — that is a **cycle**, and Move forbids cyclic module deps. Order is `envelope ← vault ← {gateway, router, journal}`.
3. **`Depositor.pending_exit_sats` is an EARMARK against `idle_btc`**, not a separate balance. Coins stay in `idle_btc` until `take_pending_exit` splits them out, so `envelope::deployable_sats` takes an `earmarked_pending_exit_sats` argument and subtracts it **before** the buffer.
4. **The `HashiAdapter` uses NESTED namespaces** — `view.{balance,depositStatus,withdrawalStatus,all}` and `guardian.{limiterStatus,canWithdraw}` (BUILD-PLAN T0.5 + SDK shape), not `KEEPER.md` §2.2's flat `viewBalance`/`limiterStatus`.
5. **Mock deposits are NEVER auto-confirmed** — `confirm_deposit` is an explicit permissionless crank, which is the live on-camera demo beat. `waitForDeposit` resolves at Confirmed/Expired **or** at crank-eligible Approved.
6. **DeepBook needs both package ids in config:** `packageId` (v20) for `moveCall` targets, `originalPackageId` (v1) for **type arguments**.

## 6. NEVER — the hard prohibitions

Straight from the G-rules. Each of these is caught by a gate, a reviewer, or a judge.

**G1** · NEVER claim Bitcoin latency protects, delays, or gates any **on-Sui** operation (share moves, NAV updates, order placement). NEVER model hBTC as a non-fungible/position object — it is a fungible `Coin<BTC>` settling in one checkpoint.
**G2** · NEVER give the keeper `WithdrawCap` or `DepositCap`. NEVER let the exit destination be a runtime/keeper input — it is **write-once at deposit**. NEVER add a `bitcoin_address` parameter to any exit function (gate `g2`).
**G3** · NEVER design a feature that assumes buying, holding, or jumping a global queue slot, or that guarantees prompt native-BTC delivery you do not control. Over-capacity batches are **REJECTED**, not queued.
**G4** · NEVER add a Cetus dependency or CLMM range logic to the BTC vault. NEVER let `README (8).md`'s Cetus router leak in (gate `g4` — the *words* trip it, phrase banners as "any non-DeepBook venue leg").
**G5** · NEVER frame the limiter as "we trust an SDK call". The MOCK and `verify/` MUST import **one identical** `projectCapacity` from `keeper/src/hashi/limiter.ts`. NEVER let a second copy live in a test file once `src/verify/limiter.ts` exists.
**G6** · NEVER put a live Bitcoin confirmation in the demo critical path. Demo congestion by **REPLAY**, never by live saturation.
**G7** · NEVER call the Hashi SDK or `hashi::` Move functions outside the adapter / `gateway.move`. NEVER hardcode a canonical ID outside `keeper/src/config.ts`, `app/src/config.ts`, `.env.example`, `move/Move.toml` (gates `g7`, `sdk`, `ids`).
**G8** · NEVER claim hBTC is trustless or non-custodial — it **IS** custodial-threshold wrapped BTC. NEVER claim the differentiation is the token. NEVER write congestion copy: the bucket is ~100 BTC/day and an Aphotic-sized exit will never be throttled on testnet.
**G9** · NEVER hardcode the stable/mainnet Pyth feed id on testnet. NEVER value hBTC at raw Pyth BTC/USD — value at the **DeepBook mid**.
**G10** · NEVER use `number` for sats in TypeScript (`bigint` only) or anything but `u64` in Move. NEVER skip the event on an externally-visible state transition. Error constants are named `E<Reason>`.

**Process prohibitions:** never implement `BTC_FIXED_INCOME.md`'s "Meridian" bond mechanics (shelved alternative). Never cite unverifiable prior art. Never write a private key into any file but `keeper/.env`. Never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` (BOM ⇒ `E01001`).

## 7. Open blockers you cannot code around

| # | Blocker | Owner |
|---|---|---|
| **B1** | **Signet faucet drip never started.** No hBTC inventory ⇒ nothing to pre-stage (G6) and nothing to seed the book with. Needs a signet wallet + a human captcha. | build lead (human), **today** |
| **B2** | **The hBTC/DBUSDC book is empty and the scripted seeder account does not exist.** `treasury::mint` is `public(package)` — we cannot mint hBTC. NAV, the router and the transparency panel have nothing to read. Depends on B1. | build lead (human) |
| **B4** | `move/tests/vault_tests.move` has **15 empty-body tests** that pass while asserting nothing. Fill them with `vault.move`. | T1.1/T1.2 |
| **B5** | `npm run test -- e2e.mock` matches **no test file** — the cut-line VERIFY passes by vacuum. | T2.10 |
| **B6** | `deriveLimiter` is duplicated inline in `keeper/test/limiter.cross.test.ts`; delete it and import `src/verify/limiter.ts` when that lands. | T4.3 |

Full list with severities: **`docs/STATUS.md` § Known blockers.**
