# ULTRACODE-BRIEF.md — the entry document for the implementation run

> **Refreshed 2026-07-25 16:31, post-implementation pass.** The skeleton run is over: the Move package is complete and **published on testnet**, the keeper is complete including its CLI, and the app ships three real screens with its own test suite. What is left is small, named, and listed in §3 — **4 TODOs in 2 files**.
> **Start here. You should be writing code inside a minute.**

---

## 0. The 60-second start

```powershell
$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"     # sui is NOT reliably on PATH

# 1. Confirm the floor. Today: 7 PASS · 1 FAIL (the `ids` gate — B11).
powershell -NoProfile -File scripts\verify-all.ps1

# 2. Pick the next task from docs/STATUS.md. There are only four open items.

# 3. Open every file carrying it
grep -rn 'TODO(T2.10)' move keeper app

# 4. Read that file's banner. The banner IS the spec. Implement. Flip @status. Delete the TODOs.
```

**Do not re-derive anything.** Every ID, signature, scalar and latency already exists in `docs/RECON.md` / `docs/FACTS.md` / `docs/DEPLOYED.md`. If a value is not in a file's `@facts` block, add it there *from those docs* before using it — never inline an unexplained literal.

## 1. Read order

| # | Doc | Why | Skip if… |
|---|---|---|---|
| 1 | **`docs/RECON.md`** | Verified ground truth from live probes, R1–**R14**. **NEVER re-derive anything in it. Where it contradicts another doc, RECON wins** — except the two arithmetic slips in §5. | never skip |
| 2 | **`docs/GOLDEN-RULES.md`** | G1–G10 with RULE / WHY / **NEVER**. Violating one is a failure, not a style issue. | never skip |
| 3 | **`docs/CONVENTIONS.md`** | The banner grammar you read from and write back to. | never skip |
| 4 | **`docs/FACTS.md`** | Canonical IDs, types, signatures. Cite by anchor. | never skip |
| 5 | **`docs/DEPLOYED.md`** | What we actually published, with digests. The ids `keeper/.env` and `app/.env.local` are wired to. | never skip |
| 6 | **The layer spec for your task** — `docs/MOVE-PACKAGE.md` · `docs/KEEPER.md` · `docs/APP.md` | Design intent. **Read its `ERRATA (2026-07-25)` section FIRST — it wins over the body above it.** | other layers |
| 7 | **`docs/STATUS.md`** | Per-task ledger: what is real, what is a stub, what is blocked, with the run log. | never skip |
| 8 | **`docs/DEMO.md`** | The runbook. Read it before you change anything on a demo path — it records what we can and cannot honestly claim. | — |
| 9 | `docs/BUILD-PLAN.md` · `docs/DEPLOY.md` | Execution order + the CUT LINE; Vercel shipping. | — |
| 10 | `docs/DAY-ONE-RESULTS.md` · `docs/ARCHITECTURE.md` | Receipts and system model. Consult on demand. | — |

**Conflict resolution:** layer-spec ERRATA > `docs/RECON.md` > `docs/FACTS.md` > layer-spec body > `HASHI_INTEGRATION.md` > `README (8).md`. `BTC_FIXED_INCOME.md` is a **shelved alternative — never implement it.**

## 2. The contract banner, in one paragraph

Every non-trivial source file carries **exactly one** `APHOTIC CONTRACT` banner — immediately after the module declaration in Move, at the very top in TS/TSX — delimited by the fixed literals `┌── APHOTIC CONTRACT ───` and `└── END CONTRACT ───`, comment-prefixed with `//`. Its fields are `@task` (BUILD-PLAN ids), `@phase`, `@status` (`STUB`|`PARTIAL`|`DONE`), `@spec` (the doc lines that *are* the contract), `@rules` (binding G-rules), `@depends`, `@facts` (**every constant pre-resolved**), `@external` (verbatim upstream signatures + gotchas), `@implements` (copy-pasteable signatures you must write), `@events`/`@errors` (Move only), `@forbidden` (with the gate that catches it), numbered `@invariant`s, `@ac`, and `@verify` commands. `@task`, `@status`, `@spec`, `@implements`, `@verify` are mandatory. **Every `@implements` signature must either exist in the body or have a `TODO(<task>)` on the line above it.** You flip `@status` to `DONE` only when **zero** `TODO(<its task ids>)` remain in that file — and you delete any module-level `#[allow(unused_const, unused_field)]` suppression at the same time. (None remain under `move/sources/` — keep it that way.)

**The census greps** (`docs/CONVENTIONS.md` §3):

```bash
# Work remaining, grouped by task id — the headline command
grep -roh 'TODO(T[0-9]\+\.[0-9]\+)' move/sources move/tests keeper/src keeper/test app/src | sort | uniq -c

# All TODOs for ONE task — what you open with
grep -rn 'TODO(T2.10)' move keeper app

# Everything still a stub
grep -rln '@status *STUB' move keeper app
```

```powershell
powershell -NoProfile -File scripts\gates.ps1 todo    # the same census, native
```

## 3. Work remaining — the census

**4 `TODO` markers · 2 task ids · 2 files.** Down from 322. Verified by direct inspection, 2026-07-25 16:31.

### The whole backlog

| Task | TODOs | Status | Where | What is actually missing |
|---|---:|---|---|---|
| **T3.2 Exit screen form** | **3** | STUB | `app/src/screens/exit/ExitScreen.tsx` | `ExitRequestForm` renders a placeholder instead of a controlled **bigint** sats input; the pinned address comes from a fixture instead of an on-chain read. Everything around it is DONE: `ptb.ts`, `vaultRead.ts`, `model.ts`, `CallPreview.tsx`, `ExitTimeline.tsx`, `RegisterExitAddress.tsx`, `lib/bech32.ts`. |
| **T5.2 Landing stats** | **1** | PARTIAL | `app/src/landing/stats.js` | Placeholder headline numbers; wire them to real reads. The transparency screen itself is DONE. |
| T5.3 Deposit-ticket TTO | 0 | NOT-STARTED | — | Derivation-unblocked (U4 = YES) but **mint-unproven**. Out of demo scope. |

Everything else is DONE. **T2.10 landed during this pass**: `keeper/src/index.ts` is `@status DONE` with zero `NotImplementedError`, and `keeper/test/e2e.mock.test.ts` (13 tests) *asserts* the loop reads no wall clock and opens no socket. The app grew its own vitest suite (`app/vitest.config.ts` + `app/test/**`, 6 files / 84 tests, fully offline with pinned `VITE_*`).

### What is already REAL — do not rewrite it

| Code | Coverage |
|---|---|
| `move/sources/{vault,gateway,envelope,router,journal}.move` | **139 Move tests**: envelope 34 · gateway 26 · journal 12 · router 25 · vault 42. Published at `0xbe433a27…`. |
| `move/tests/mock_hashi.move` | Full bridge stand-in with all five upstream asserts. |
| `keeper/src/hashi/**` (incl. `real.ts`, `watcher.ts`) | mock 24 · real 36 · watcher 22 · limiter 19 · cross-parity 5. The canonical `projectCapacity`/`consume` (G5) lives in `limiter.ts` and **nowhere else**. |
| `keeper/src/{strategy,routing,oracle,storage,journal,verify,execution,privacy}/**` | strategy 26 · pegflow 15 · routing 56 · oracle 49 · storage 24 · journal 30 · verify 34 · crank 59 · sweep 23 · exit 45 · privacy 21. |
| `keeper/src/index.ts` | The seven-command CLI, fully dispatched. `e2e.mock` 13 tests. |
| `keeper/src/{config,types}.ts`, `sui/client.ts`, `util/**` | Pure `loadConfig(env)` (10 tests), single Sui client factory, bigint/bytes/env/errors/rng. |
| `app/src/**` except `screens/exit/ExitScreen.tsx` and `landing/stats.js` | Builds green. Deposit screen, transparency screen, Enoki zkLogin session, Hashi deposit-address boundary, all shared components. **84 app tests** across bech32 / components / depositAddress / enoki / format / hashiAdapter. |
| `scripts/{gates,verify-all,verify-onchain,register-deposit,seed-book,check-enoki}` | 8 gates · master gate · 28 live on-chain assertions · the txid-reversing deposit registrar · the dry-run-by-default book seeder. |

**481 keeper tests across 19 files, 139 Move tests, 84 app tests. Do not break them.**

## 4. VERIFY matrix

Run the aggregate first; drop to the specific command when something is red.

| Command | Green means | Measured 2026-07-25 |
|---|---|---|
| `powershell -NoProfile -File scripts\verify-all.ps1` | **The master gate.** All 8 steps. `SKIP` is **not** green. | ⚠ `7 PASS · 1 FAIL · 0 SKIP` — `gates` fails on `ids` (**B11**) |
| `cd move && sui move build` | Package `aphotic` compiles, edition `2024.beta`, **zero warnings**. | exit 0 |
| `cd move && sui move test` | All `move/tests/*_tests.move` pass. | `Total tests: 139; passed: 139; failed: 0` |
| `cd move && sui move test gateway` | T1.3/T1.4/T1.6. ⚠ The filter is **positional** — `--filter` is not a flag in sui 1.76.0. | 26 pass |
| `cd move && sui move test envelope` | T4.1, incl. the R9 golden vectors v1–v7. | 34 pass |
| `cd move && sui move test vault` | T1.1/T1.2. | 42 pass |
| `cd keeper && npm run typecheck` | `tsc --noEmit` over `src/` + `test/` under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + NodeNext. | exit 0 |
| `cd keeper && npm run build` | Emits `dist/**` with `.d.ts` + sourcemaps; the ESM runs (`node dist/index.js --help` → exit 0). | exit 0 |
| `cd keeper && npm test` | Full vitest suite. | `19 files · 481 tests passed` |
| `cd keeper && npm run test -- hashi.mock` | BUILD-PLAN T0.5 acceptance. | 24 pass |
| `cd keeper && npm run test -- limiter.cross` | **The G5 parity acceptance** — TS `deriveLimiter` vs the Move twin. | 5 pass |
| `cd keeper && npm run test -- e2e.mock` | **Cut-line acceptance for T2.10.** Asserts the loop reads no wall clock and opens no socket. | 13 pass |
| `cd app && npm run build` | `tsc --noEmit && vite build`. | exit 0 |
| `cd app && npm test` | The app's own offline vitest suite (`app/vitest.config.ts` pins every `VITE_*`). ⚠ **not yet a step in `verify-all.ps1`** — add it. | `6 files · 84 tests passed` |
| `powershell -NoProfile -File scripts\gates.ps1` | All 8 invariant gates. | ⚠ `6 PASS · 1 FAIL` + the todo census (4 markers) |
| `node scripts\verify-onchain.mjs` | Every canonical id resolves live; config scalars, event streams, our own deployment and the Pyth Beta feed match. Needs network. | `28 PASS · 0 FAIL · 0 WARN · 7 INFO` |
| `node scripts\seed-book.mjs` | Prints what book inventory is **obtainable**, from live reads, and writes nothing without `--execute`. | exit 0 |
| `node scripts\check-enoki.mjs <origin>` | The Enoki/Google origin is registered so zkLogin will not 403. | run per deployed origin |

### The 8 invariant gates (`scripts/gates.ps1`)

| Gate | Enforces | Fails if you… | Today |
|---|---|---|---|
| `g7` | `hashi::` appears in **exactly** `move/sources/gateway.move` | import Hashi into any other Move source | PASS |
| `g4` | No `cetus`/`clmm` under `move/sources` or `keeper/src` | add a non-DeepBook venue leg or CLMM range logic. ⚠ Even the *words* in a comment trip it — banners say "any non-DeepBook venue leg" on purpose | PASS |
| `g2` | No Bitcoin-address parameter on any exit function | let the exit destination be a runtime input | PASS |
| `ids` | Canonical ids only in `keeper/src/config.ts`, `app/src/config.ts`, `.env.example`, `move/Move.toml` | hardcode an id in logic | **FAIL — `scripts/register-deposit.ps1:48-49`** |
| `sdk` | `@mysten/hashi` imported only in `keeper/src/hashi/real.ts` | import the SDK from a screen or a strategy | PASS (load-bearing now) |
| `purity` | No `Date.now()`/`Math.random()` in `strategy/` or `routing/` | make `evaluate()`/`route()` non-deterministic | PASS |
| `transport` | Sui client constructed only in `keeper/src/sui/client.ts` and `app/src/lib/suiClient.ts` | `new SuiGrpcClient(...)` anywhere else | PASS |
| `todo` | informational census | — | 12 markers |

## 5. ERRATA digest — every correction, so nobody re-derives a wrong fact

The layer specs each carry a full `ERRATA (2026-07-25)` section that **wins over the body above it**. This is the compressed index. When implementing, read the full item.

### ★ NEW — R14: deposit registration (three ways to fail silently)

| id | Correction |
|---|---|
| **R14.1** | **There is no Hashi relayer. Nobody registers your deposit for you.** Sampling 20 consecutive `deposit::DepositRequested` events gave **20 distinct transaction senders**, and in every one `sender == derivation_path == requester_address`. Each depositor submits their own UTXO via `hashi::utxo::utxo_id` → `hashi::utxo::utxo` → `entry hashi::deposit::deposit`. `derivation_path` must be the Sui address the deposit address was derived from — it is **where the hBTC gets minted**. |
| **R14.2 ⚠⚠** | **`utxo_id` takes the txid in Bitcoin's INTERNAL byte order — the REVERSE of what every explorer displays.** Verified against three real `DepositConfirmed` events: the displayed txid was never found on signet, the reversed one always was, and the amount at the recorded `vout` matched exactly. **Passing the displayed order registers a UTXO that does not exist, the transaction succeeds, and nothing ever tells you why** — the committee simply never approves it. `scripts/register-deposit.ps1` does the reversal for you; always hand it the explorer-displayed form so there is exactly one place this can be wrong. |
| **R14.3** | **Never register against a mempool txid — it can be replaced.** Observed live: the faucet's first batch `04cb601a…` sat unconfirmed for hours, was **RBF-replaced** by `2275d890…`, and both explorers now 404 the original. **The amounts changed too** (591 692 → 144 137 per output), so the noted vouts were wrong as well. Combined with R14.2, that failure is completely silent. Registration is only accepted at `bitcoin_confirmation_threshold = 6` confirmations, and the script refuses below it rather than letting the call abort. **The confirmation gate is not a nicety; it is what makes registration safe.** |

### Arithmetic and the G5 limiter

| id | Correction |
|---|---|
| **RECON R9 #1/#7** | **`105_000` is WRONG — the correct value is `100_150`.** `100_000 + 15 s × 10 sats/s = 100_150`; the upstream SDK returns `100150n`. RECON's *algorithm* is right; only those two expected values are slips. Both twins encode `100_150` and cross-test green — the test names now carry the erratum inline. **Do not "fix" them back.** (E-K4, E-M5) |
| **E-K2 / E-M5** | Live limiter scalars: **`refill_rate = 115_740` sats/s**, **`max_bucket_capacity = 10_000_000_000` sats (100 BTC)** — a full bucket refills in ~24 h. These are the values the deployed vault was created with (`docs/DEPLOYED.md`). The old `1000` / `100_000_000` prior is wrong by ~100×. Consequence: an Aphotic-sized exit will **never** be rate-limited on testnet ⇒ the envelope is an honest **risk input**, not a scarcity story, and **congestion copy is a factual error** (G8). |
| **E-M5** | Move must emulate saturation **explicitly**: `u64` add/mul **abort** on overflow, and a plain `u64` subtraction of out-of-order timestamps aborts too. Widen to `u128` before the `min`, then narrow. TypeScript must use `bigint` — a 100 BTC bucket × large elapsed exceeds `Number.MAX_SAFE_INTEGER`. **"No `number` for sats" is load-bearing, not stylistic.** |
| **E-K1 (resolved both ways)** | Two shapes ship deliberately: `projectCapacity(tokens, refillRate, cap, elapsedMs)` (canonical) **and** `projectCapacityAtSecs(cfg, state, tsSecs)` (exact upstream mirror). Move mirrors both. Time base is **UNIX SECONDS**; `msToSecs` is the only sanctioned ms→s conversion and it floors **elapsed**, not each endpoint. |
| **E-K3 / E-R4** | **`WithdrawalSigned` carries NO amount and NO timestamp.** The replay is a **join**: sats = Σ over `request_ids` of `WithdrawalRequested.btc_amount` (**the requested amount** — `withdrawal_outputs[i].amount` is net of the Bitcoin network fee: observed `1_000_000` vs `998_835`); timestamp = the **Sui event envelope** `timestampMs`, a decimal **string** ⇒ `BigInt(e.timestampMs) / 1000n`, never `parseInt`. Flow 4 consumes **two** streams. |

### Hashi surface

| id | Correction |
|---|---|
| **E-M3 / R7.1** | All 15 `hashi::btc_config` accessors are `public(package)` ⇒ **not callable from `aphotic`.** Inject `30_000` (withdrawal min), `546` (dust), `3_600_000` ms (cancel cooldown), `600_000` ms (deposit delay) as named constants. Re-verified live today. |
| **E-M4 / E-R2 / R7.2** | **U3 = NO.** All 46 `hashi::withdrawal_queue` getters are `public(package)` (only `output_utxo` is public). There is **no on-chain queue-depth read**. `envelope.move` takes the static-buffer + event-replay path **unconditionally**. |
| **E-M8 / E-K7 / E-A3 / E-R1** | `cancel_withdrawal` asserts `request.sender == ctx.sender()` ⇒ **`reclaim_stalled_exit` is DEPOSITOR-ONLY. The keeper can NEVER call it.** `keeper/src/execution/reclaim.ts` is an **unsigned PTB builder** the app hands to the depositor's zkLogin session. **INVARIANT:** the pooled small-exit flush asserts `who == ctx.sender()`, else the flusher becomes the only party able to reclaim. Sponsored gas is fine — sponsorship changes who *pays*, not who the *sender* is. |
| **E-M9 / E-R6** | `hashi::deposit::{deposit, confirm_deposit, approve_deposit, delete_expired_deposit}` are `visibility=Private, isEntry=true` ⇒ **PTB commands, not Move-callable.** The permissionless crank lives in the keeper/app PTB builder and must **never** appear as a `moveCall` inside `gateway.move`. **The entire Move-composable Hashi surface is exactly two functions:** `request_withdrawal` and `cancel_withdrawal`. |
| **E-K8 / E-A4** | Most of the `@mysten/hashi` API the specs describe **does not exist**. `0.6.0` exports only `HashiClient`, `hashi`, `generateDepositAddress`, `deriveChildPubkey`, `twoOfTwoTaprootScriptPathAddress`, `bitcoinAddressToWitnessProgram`, `witnessProgramToAddress`, `arkworksToSec1Compressed`, `projectCapacity`, `estimateWaitSecs`, `fetchGuardianInfo`, error classes. `real.ts` builds `view.*`/`waitFor*` on `HashiClient` + raw `moveCall`s + event polling, and declares an explicit `UnsupportedByUpstream` error for what the transport genuinely cannot serve. ⚠ **Do not use the SDK's `projectCapacity`** — no `u64` saturation, so it diverges at the extremes. Ours is canonical. |
| **E-K9 / E-A6** | The guardian's `GET {guardian_url}/info` is behind an ALB that **rejects HTTP/1.1 with status 464**. Node's `fetch`, `curl`, and the SDK's `fetchGuardianInfo` all fail. Use `node:http2` (ALPN `h2`). It reports the **raw last-consume state**, not a projected balance — the caller runs `projectCapacity` itself, which is exactly the G5 shape. |
| **E-K10 / E-A5** | `generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network })` — **four** args. `suiAddress` must be a **32-byte `Uint8Array`** (a `0x…` string throws). `mpcMasterCompressed` **must** be `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)`. `witnessProgramToAddress`/`bitcoinAddressToWitnessProgram` both **require** the network arg. Fully offline ⇒ the QR renders before any network call. **U4 = YES** for derivation; ⚠ that `confirm_deposit` actually mints **to an object id** is unproven — keep T5.3 off the demo path. |
| **R8** | Real event names: `treasury::{Minted,Burned}` · `deposit::{DepositRequested,DepositApproved,DepositConfirmed,ExpiredDepositDeleted}` · `withdrawal_queue::{WithdrawalRequested,Approved,PickedForProcessing,InputsSigned,Signed,PresigsReassigned,Confirmed,Cancelled}`. ⚠ **`utxo_pool::UtxoSpent` does not exist** — `docs/FACTS.md#events` is stale. ⚠ `treasury::Minted<T>` has **only** `amount`, no recipient — which is precisely why the keeper cannot redirect a mint (G2). The event `kind` in our types is the **verbatim** Move struct name (`WithdrawalPickedForProcessing`, not `WithdrawalPicked`). |

### DeepBook venue

| id | Correction |
|---|---|
| **E-M10 / R4** | **Three** DeepBook ids with distinct roles: original/type-origin `0xfb28c4cb…` (v1 — every `Pool`/`BalanceManager`/`TradeCap` **type** resolves here), superseded `0x22be4cad…` (v17 — **do not use**), current callable `0xd874d241…` (**v20 — every `moveCall` target**). Config carries both `packageId` (v20) and `originalPackageId` (v1). |
| **E-M6** | The deployed v20 package **does not contain** `best_bid_price`, `best_ask_price`, or `place_post_only_limit_order`, even though the pinned dep source does. A call to a function absent from the linked package **compiles and then fails at publish/link time**. Maker leg = `place_limit_order(…, order_type = 3 /* POST_ONLY */, self_matching_option = 0)`. |
| **E-M7 / E-K6 / E-A7** | `pool::mid_price` **aborts** `deepbook::book` code **2 = `EEmptyOrderbook`**; `pool::get_level2_range` **succeeds and returns `([], [])`**. **The book is still empty on both sides — re-confirmed live today.** Derive top-of-book from `get_level2_range`, treat empty as "no mid" (`try_book_mid → none`, `evaluate → noop cause=no-mid`), render a defined empty state everywhere. |
| **R10 / E-K6** | The hosted indexer lists 7 pools and **does not include hBTC/DBUSDC** — never read the book from it. `@mysten/deepbook-v3`'s `DeepBookClient` is driven by a bundled registry that will not contain our pool — build raw `moveCall`s, use the SDK for BCS helpers only. `DBTC_DBUSDC` in the indexer is DeepBook's own test BTC, **not** hBTC. |
| **E-R6** | Confirmed on-chain **and now in production**: `balance_manager::{new, mint_trade_cap, …}` and `generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof` exist and are independent. Our shared `BalanceManager` `0x5766ed0b…` is live. **G2 is implementable exactly as drawn.** |

### Transport, oracle, storage

| id | Correction |
|---|---|
| **E-K5 / E-R5 / R1** | `https://fullnode.testnet.sui.io:443` serves **gRPC v2 only — JSON-RPC returns HTTP 404**. **`@mysten/sui@2.22.1` no longer exports `SuiClient`** (importing it throws). Use `SuiGrpcClient` from `@mysten/sui/grpc`, constructed in exactly one place per package. `SuiJsonRpcClient` is for probes against the mirror `https://rpc-testnet.suiscan.xyz:443` only — that is what `verify-onchain.mjs` uses. ⚠ `SuiGrpcClient` takes **`baseUrl`**; `SuiJsonRpcClient` takes **`url`**. |
| **E-K11 / E-M12 / R11** | **No Pyth Move dependency** — nothing in Move calls Pyth; `envelope::check_action` takes `oracle_mid: u128` as a **parameter**. Testnet feed = **Beta** `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b` at `https://hermes-beta.pyth.network` — **not** the stable `0xe62df6c8…`. Pin `PYTH_STATE_INITIAL_SHARED_VERSION = 12041355` and `WORMHOLE_STATE_INITIAL_SHARED_VERSION = 1451`. Match `attributes.symbol === "Crypto.BTC/USD"` **exactly**. ⚠ Pyth DAO auto-upgrades Sui addresses **2026-08-18**. |
| **E-K12 / E-M11** | Walrus `PUT {publisher}/v1/blobs?epochs=N` → `GET {aggregator}/v1/blobs/{blobId}`; `WALRUS_EPOCHS` explicit (`< 2` throws in `config.ts`). Seal key servers `0x73d05d62…` / `0xf5d14a81…`, threshold 2 — `@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`**, pass `serverConfigs` explicitly. ⚠ A freshly published blob returns **`certifiedEpoch: null`, `deletable: true`** — an availability predicate demanding certified + non-deletable **rejects our own writes**. Allow a grace window; keep the on-chain read out of the critical path. |

### Build system and layout

| id | Correction |
|---|---|
| **E-M1 / R3** | `Move.toml` = `[package] name/edition` + exactly two git deps (`hashi`, `deepbook`). **No `Sui` dependency line, no `[addresses]`, no `[dep-replacements]`, no Pyth.** Both upstreams ship a `Published.toml` with `[published.testnet]`, so the new package manager resolves `published-at`/`original-id` and the framework automatically. |
| **NEW** | **`[environments]` must be OMITTED.** `sui` 1.76.0 rejects `testnet = "4c78adac"`: *"Cannot override default environments … System environments: testnet, mainnet."* Documented in the `Move.toml` header. |
| **NEW** | RECON **R3**'s "framework rev `22f9fc97…`" is misleading — the resolver pins `d50b7888…` because under the new package system the framework comes from the CLI's system environment. Harmless; builds green. |
| **NEW** | **`sui move test`'s filter is POSITIONAL** in 1.76.0 — `sui move test gateway`. `--filter` is **not** a flag and older docs (including earlier revisions of this brief) are wrong. |
| **NEW** | `move/Move.lock` records **Windows backslash** subdir paths (`crates\sui-framework\packages\move-stdlib`). Machine-generated; may need regeneration on Linux/macOS CI (**B8**). |
| **E-M2** | Tests live in **`move/tests/`**, not `move/sources/tests/` — otherwise `gateway_tests.move` (which necessarily contains `hashi::`) makes the **G7 gate unpassable**. `docs/BUILD-PLAN.md` T1.6 still names the wrong path. |
| **E-A1 / E-A2 / R13** | React **19**, not 18. **`/` is the LANDING PAGE**, not a redirect to `/deposit`. Porting constraints: `public/fonts/cravelo.otf` is mandatory; globe textures are **vendored** into `app/public/globe/`; the cloud-layer `requestAnimationFrame` loop had to be cancelled on unmount; `HorizontalScroll` is hardcoded to exactly 3 cards (`300vh`/`300vw`). |
| **NEW** | `docs/BUILD-PLAN.md` T3.3 names `app/src/session/zkLogin.ts`; the file is **`app/src/session/enoki.ts`** (+ `useSession.ts`, `components/ZkLoginButton.tsx`, `scripts/check-enoki.mjs`). |
| **E-A8** | The `VITE_` table is fully resolved — take values from `app/.env.example`, never inline. Vite **inlines every `VITE_*` at build time**: changing one in a dashboard does nothing until redeploy, and every value lands in the public bundle. See `docs/DEPLOY.md`. |

### Latency and the demo

| id | Correction |
|---|---|
| **E-A9 / E-R7** | One measured withdrawal: `Requested → Approved` +10 s, `→ PickedForProcessing` +5.1 min, `→ Signed` **+5.4 min**, `→ Confirmed` **+57.9 min** on a quiet signet. Single sample — keep the conservative planning figures. **G6 stands unchanged**: 58 minutes is far outside a 3-minute demo. |
| **E-R7 / R10** | **Hard dependency, still open (B2):** the book is empty **and hBTC cannot be minted by us** (`treasury::mint` is `public(package)`). The scripted book-seeder account is a **required component**, and it depends on the signet sats clearing 6 confirmations and being registered. |
| **NEW** | **The keeper CLI is wired as of this pass.** `keeper/src/index.ts` dispatches all seven commands; `node dist/index.js crank` is real. `docs/DEMO.md` §4 also records the raw `sui client call` equivalent — keep it, it is the fallback if the keeper's `.env` is not loaded at the venue. |

### Spec deltas the implementation committed to — honour them

1. **`Vault<phantom B, phantom Q>` is GENERIC** over the asset pair, not concrete `Balance<BTC>`. Naming the hBTC type in `vault.move` would need a bridge import there and break the G7 gate. Only `gateway.move` instantiates `B` with the real hBTC type — which is why `exit_to_bitcoin<Q>` is constrained to `Vault<BTC, Q>`.
2. **`envelope` is the intra-package LEAF** and takes **primitives** (`idle_sats`, `nav_sats`, `paused`, …), never `&Vault`. `MOVE-PACKAGE.md` §1.3 draws `envelope → vault` while §3.1 gives `Vault.envelope: EnvelopeParams` — that is a **cycle**, and Move forbids cyclic module deps. Order is `envelope ← vault ← {gateway, router, journal}`.
3. **`Depositor.pending_exit_sats` is an EARMARK against `idle_btc`**, not a separate balance. `envelope::deployable_sats` takes an `earmarked_pending_exit_sats` argument and subtracts it **before** the buffer.
4. **The `HashiAdapter` uses NESTED namespaces** — `view.{balance,depositStatus,withdrawalStatus,all}` and `guardian.{limiterStatus,canWithdraw}`, not `KEEPER.md` §2.2's flat form.
5. **Mock deposits are NEVER auto-confirmed** — `confirm_deposit` is an explicit permissionless crank. `waitForDeposit` resolves at Confirmed/Expired **or** at crank-eligible Approved.
6. **A sub-minimum pooled exit reserves the FULL Hashi minimum (30 000 sats)**, not its face value — otherwise the buffer under-reserves the moment a pool flushes.

## 6. NEVER — the hard prohibitions

**G1** · NEVER claim Bitcoin latency protects, delays, or gates any **on-Sui** operation. NEVER model hBTC as a non-fungible/position object — it is a fungible `Coin<BTC>` settling in one checkpoint.
**G2** · NEVER give the keeper `WithdrawCap` or `DepositCap`. NEVER let the exit destination be a runtime/keeper input — it is **write-once at deposit**. NEVER add a `bitcoin_address` parameter to any exit function (gate `g2`).
**G3** · NEVER design a feature that assumes buying, holding, or jumping a global queue slot, or that guarantees prompt native-BTC delivery you do not control. Over-capacity batches are **REJECTED**, not queued.
**G4** · NEVER add a Cetus dependency or CLMM range logic. NEVER let `README (8).md`'s Cetus router leak in (gate `g4` — the *words* trip it; phrase banners as "any non-DeepBook venue leg").
**G5** · NEVER frame the limiter as "we trust an SDK call". The mock, the strategy and `verify/` MUST import **one identical** `projectCapacity` from `keeper/src/hashi/limiter.ts`. NEVER let a second copy live anywhere — including a test file.
**G6** · NEVER put a live Bitcoin confirmation in the demo critical path. Demo congestion by **REPLAY**, never by live saturation.
**G7** · NEVER call the Hashi SDK or `hashi::` Move functions outside `keeper/src/hashi/real.ts` / `app/src/hashi/depositAddress.ts` / `move/sources/gateway.move`. NEVER hardcode a canonical ID outside `keeper/src/config.ts`, `app/src/config.ts`, `.env.example`, `move/Move.toml` (gates `g7`, `sdk`, `ids`).
**G8** · NEVER claim hBTC is trustless or non-custodial — it **IS** custodial-threshold wrapped BTC. NEVER claim the differentiation is the token. **NEVER write congestion copy**: the bucket is ~100 BTC/day and an Aphotic-sized exit will never be throttled on testnet.
**G9** · NEVER hardcode the stable/mainnet Pyth feed id on testnet. NEVER value hBTC at raw Pyth BTC/USD — value at the **DeepBook mid**.
**G10** · NEVER use `number` for sats in TypeScript (`bigint` only) or anything but `u64` in Move. NEVER skip the event on an externally-visible state transition. Error constants are named `E<Reason>`.

**Process prohibitions:** never implement `BTC_FIXED_INCOME.md`'s "Meridian" bond mechanics (shelved alternative). Never cite unverifiable prior art. Never write a private key into any file but `keeper/.env`. Never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` (BOM ⇒ `E01001`) — use `[System.IO.File]::WriteAllText` with `New-Object System.Text.UTF8Encoding($false)`.

## 7. Open blockers you cannot code around

| # | Blocker | Owner |
|---|---|---|
| **B2** | **The hBTC/DBUSDC book is empty on both sides and we cannot create inventory.** `treasury::mint` is `public(package)` (no hBTC) **and** the DBUSDC `TreasuryCap` is `AddressOwner`, not shared (no quote asset either) — established by `scripts/seed-book.mjs`, which reports honestly and refuses to write without `--execute`. ⚠ `mid_price` asserts **both** sides, so seeding one side changes nothing. Handled as a *defined* state everywhere; there is simply no price to show. | build lead (human) |
| **B11** | The **`ids` gate FAILS**: `scripts/register-deposit.ps1:48-49` hardcodes the Hashi package and object ids. Source them from `keeper/.env` (which is what `seed-book.mjs` does — it passes), or add an explicit documented exemption for operator scripts. Until then `verify-all.ps1` is `7 PASS · 1 FAIL`. | whoever owns `scripts/` |
| **B13** | **Seal is not bound to a live backend.** `privacy/{seal,session,rotation}.ts` are PARTIAL; the vault's `strategy_ciphertext` is a one-byte placeholder. The "encrypted strategy" claim is architecturally true and not yet demonstrated on chain — phrase it that way. | T2.6 follow-up |
| **B14** | **`verify-all.ps1` has no `app test` step.** The app suite (84 tests) is new and the master gate does not run it, so an app regression can pass the master gate. | whoever owns `scripts/` |
| **B8** | `move/Move.lock` records Windows backslash subdir paths; may need regeneration on non-Windows CI. | CI owner |

**Closed during this pass:** B1 (signet sats received), B3, B4, **B5** (`e2e.mock` authored, 13 tests), B6, B7, B9, B10, **B12** (the keeper CLI is wired).

Full list with severities and the resolved ones: **`docs/STATUS.md` § Known blockers.**
