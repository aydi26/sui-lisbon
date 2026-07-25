# DAY-ONE.md — pre-code verification checklist (RUN BEFORE feature code)

> Purpose: resolve every `UNKNOWN` before writing feature code. This is the named owner of `docs/FACTS.md#unknowns` (U1–U9) plus the `docs/KEEPER.md` §10 items. It is a checklist you literally execute.
> Read after: `docs/FACTS.md`.

---

## ✅ EXECUTED 2026-07-25 — read `docs/DAY-ONE-RESULTS.md` before re-running anything

**This checklist has been run.** The evidence (exact commands + raw output) is in **`docs/DAY-ONE-RESULTS.md`**; every resolved value is already promoted into `docs/FACTS.md` and **no `UNKNOWN — resolve in DAY-ONE.md` rows remain**. Do NOT re-derive an item that is marked resolved below — cite `docs/FACTS.md` by anchor.

| Item | Resolves | Verdict | Outcome |
|---|---|---|---|
| D1 | U9 | **PASS** | All 8 testnet ids resolve. |
| D2 | U3 | **PASS — answer NO** | Every `withdrawal_queue`/`btc_config` getter is `public(package)`. Fallback engaged unconditionally. |
| D3 | U8 | **PARTIAL** | Book read verified (EMPTY). Maker placement deferred — needs hBTC inventory. |
| D4 | U1 | **PASS — RESOLVED** | `refill_rate = 115_740` sats/s, `cap = 10_000_000_000` sats, via `GET {guardian_url}/info` over **HTTP/2**. |
| D5 | U2 | **PASS** | Beta feed `0xf9c0172b…ee8ea31b`. |
| D6 | U4 | **PASS — YES** | Pure offline derivation; any 32-byte value works. |
| D7 | U6 | **PARTIAL** | Faucets alive; throughput unmeasured. **Owner: build lead — start dripping.** |
| D8 | U7 | **PASS** | Seal + Walrus + zkLogin all live; concrete endpoints recorded. |
| D9 | U5 | **N/A** | Targeting testnet. |
| D10 | KEEPER §10 | **PASS** | Real event type strings + envelope `timestampMs`; limiter time base = **seconds**. |

**Three corrections this run produced** (all carried into `docs/FACTS.md`):
1. The guardian `/info` endpoint **does** answer — it just requires **HTTP/2** (HTTP/1.1 ⇒ `464`). U1 is resolved, not unresolvable.
2. `docs/RECON.md` R9 golden vectors **#1 and #7 are arithmetically wrong** (`105_000` should be `100_150`).
3. The deployed DeepBook **v20 lacks 3 `pool` functions** that exist in the pinned dep rev — calling them fails at publish/link time.

⚠ **Transport correction for every command below.** `https://fullnode.testnet.sui.io:443` returns **HTTP 404** for JSON-RPC (gRPC v2 only). Any `curl … https://fullnode.testnet.sui.io:443 -d '{"jsonrpc":…}'` in the original text below **cannot work as written** — substitute the verified mirror `https://rpc-testnet.suiscan.xyz:443`, or use the `sui` CLI (which speaks gRPC). See `docs/FACTS.md#rpc-transport`.

---

## How to use

Run every item below in order. Each has: the **command**, the **expected result**, a **PASS/FAIL gate**, where to **RECORD** the finding, and a **fallback** if it fails. When an item resolves an `UNKNOWN`, write the resolved value into `docs/FACTS.md` (replace the UNKNOWN row) and tick it here. Items marked **BLOCKING** must pass (or their fallback engaged) before `real`-mode (non-mock) work; the whole Move/keeper/app build can proceed against the MOCK (G7) regardless.

## Prereqs

```bash
sui client switch --env testnet          # active env = testnet
sui client active-address                 # funded; get gas at https://faucet.sui.io if needed
sui client gas                            # >0 SUI
node -v                                    # >= 18
# scratch SDK probe project (throwaway), ESM:
mkdir -p /tmp/hashi-probe && cd /tmp/hashi-probe && npm init -y && npm pkg set type=module \
  && npm i @mysten/sui@^2.22.1 @mysten/hashi@0.6.0
```

Full-node RPC used below: `https://fullnode.testnet.sui.io:443`.

---

## D1 — Hashi testnet IDs resolve on a public fullnode  (resolves U9) — BLOCKING — ✅ **PASS 2026-07-25**

```bash
sui client object 0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360 --json   # package
sui client object 0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8 --json   # Hashi shared object
sui client object 0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6 --json   # DeepBook Pool<hBTC,DBUSDC>
```
- **Expected:** all three resolve (package shows modules; Hashi object is a shared object; pool object exists).
- **PASS/FAIL:** any 404/"not found" = FAIL.
- **RECORD:** tick U9 in `docs/FACTS.md#unknowns`. If an ID moved, update `#networks-faucets` / `#deepbook-venue`.
- **Fallback:** re-derive current IDs from `testnet.hashi.sui.io` network config / the `@mysten/hashi` package constants (`client.$extend(hashi())` auto-resolves — log what it resolves).

## D2 — Hashi object: does it expose on-chain getters for queue depth / config?  (resolves U3) — ✅ **PASS 2026-07-25, answer = NO**

```bash
# Inspect the shared object's fields:
sui client object 0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8 --json | less
# Inspect the package's public function ABI (look for public getters on Hashi / config / withdrawal_queue):
curl -s https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' -d '{
 "jsonrpc":"2.0","id":1,"method":"sui_getNormalizedMoveModulesByPackage",
 "params":["0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360"]}' | jq '.result | keys'
```
- **Look for:** a `public fun` returning withdrawal-queue depth, limiter tokens, or config (e.g. in `withdrawal_queue` / `btc_config` / `hashi`).
- **RECORD:** in `docs/FACTS.md#unknowns` U3 write **YES + the function signature** or **NO**.
- **Consequence:** decides `envelope.move`'s congestion read — trustless getter (if YES) vs event-replay + static-buffer fallback (if NO; the design already assumes NO as the safe default). Not blocking: fallback exists.

## D3 — hBTC/DBUSDC book depth + fresh-BalanceManager maker placement  (resolves U8) — BLOCKING for live demo — ⚠️ **PARTIAL 2026-07-25** (book read PASS; maker placement deferred)

```bash
# Pool state (bids/asks levels) — via DeepBook indexer or object read:
curl -s "https://deepbook-indexer.testnet.mystenlabs.com/get_book?pool=0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6&depth=20" | jq .
# (If the indexer path differs, read the pool object and its order book dynamic fields directly.)
```
- Then: create a `BalanceManager`, mint/get test hBTC + DBUSDC, place ONE `POST_ONLY` maker order (small, `lot=1_000`, `min_size=100_000`) via the DeepBook testnet package `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c`; confirm it rests.
- **Expected:** book likely thin/near-empty (fine — vault IS the maker); the maker order must place and rest.
- **RECORD:** U8 → current depth snapshot + "maker placement works: YES/NO".
- **Fallback:** if the pool is unusable, run a scripted taker on a second account for demo fills; frame thin book as the opportunity (G6/demo).

## D4 — Guardian limiter genesis scalars (`refill_rate`, `max_bucket_capacity`)  (resolves U1) — ✅ **RESOLVED 2026-07-25** via GET {guardian_url}/info over HTTP/2

Two paths — do both, cross-check:
```bash
# (a) SDK read:
node -e "import('@mysten/hashi').then(async h=>{/* client.\$extend(hashi()); await sdk.guardian.limiterStatus() */ console.log('call guardian.limiterStatus / canWithdraw and print tokens, refill, cap')})"
# (b) Event-replay bound: pull recent withdrawal_queue events and bound refill from the cleared-volume envelope, cap from the largest single drain:
curl -s https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' -d '{
 "jsonrpc":"2.0","id":1,"method":"suix_queryEvents",
 "params":[{"MoveEventModule":{"package":"0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360","module":"withdrawal_queue"}},null,50,true]}' | jq '.result.data[].type' | sort -u
```
- **RECORD:** U1 → the SDK-reported `refill_rate` + `max_bucket_capacity` if exposed, else the observational bounds. Feed both into the MOCK's `projectCapacity` config (`docs/KEEPER.md` §2.4) and the envelope buffer.
- **Note:** NOT load-bearing (used as a conservative risk-buffer input). Do not block on it; if unknown, size the buffer conservatively and proceed.

## D5 — Pyth BETA-channel BTC/USD feed id  (resolves U2) — BLOCKING for oracle — ✅ **PASS 2026-07-25**

```bash
# Pyth Hermes BETA endpoint — find the testnet (Beta) BTC/USD feed id:
curl -s "https://hermes-beta.pyth.network/v2/price_feeds?query=btc%2Fusd&asset_type=crypto" | jq '.[] | {id, "attributes": .attributes.symbol}'
```
- **Expected:** a Beta feed id for `Crypto.BTC/USD` (may differ from the stable id `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`).
- **RECORD:** U2 → the Beta feed id in `docs/FACTS.md#pyth-oracle`. **Never hardcode the stable id on testnet (G9).**
- Also confirm the Pyth **State** `0x2437…1c7c` + **package** `0xabf8…c837` still resolve (they auto-upgrade 2026-08-18 — pin the current version).

## D6 — `generateDepositAddress` accepts a 32-byte object id as `suiAddress`?  (resolves U4) — ✅ **PASS 2026-07-25, answer = YES**

```bash
node -e "import('@mysten/hashi').then(async h=>{ /* const addr = sdk.generateDepositAddress({suiAddress: '0x'+'11'.repeat(32)}); print addr, assert it is a valid P2TR */ })"
```
- **Expected:** derives a valid P2TR address for an arbitrary 32-byte value. (Full proof that `confirm_deposit` mints to it requires a live deposit — defer; the derivation test is the gate.)
- **RECORD:** U4 → YES/NO. **Gates the stretch deposit-ticket TTO flow (`docs/BUILD-PLAN.md` T5.3).** If NO, mark T5.3 SKIP.

## D7 — Signet faucet throughput  (resolves U6) — start EARLY — ⚠️ **PARTIAL 2026-07-25: faucets alive, throughput UNMEASURED. OWNER: build lead.**

- ⚠ **`signet257.bublina.eu.org` and `alt.signetfaucet.com` are DEAD** — they answer HTTP 200 but the body says the faucet has not worked since 2025-01-30. `https://signetfaucet.com` is the only one that pays.
- ⚠ **Never use Mutinynet** — it is a different chain that shares signet's genesis hash and uses identical `tb1p…` addresses, so a wrong send gives no warning. See `docs/FACTS.md#networks-faucets`.
- On `signetfaucet.com`: paste the Hashi-derived deposit address, set the amount in **BTC** (max `0.01`), solve the captcha, then **wait ≥ 30 s before clicking Send** — the page discards payouts submitted sooner, silently and with a green "queued" message.
- **RECORD:** U6 → per-faucet delivery time + amount. **Start dripping on day one and keep dripping** — deposits are ~70 min end-to-end (G6), you need warm confirmed hBTC.

## D8 — Seal + Walrus + zkLogin all live on testnet  (resolves U7) — BLOCKING for real mode — ✅ **PASS 2026-07-25**

- **Seal:** confirm the testnet key-server committee endpoints/object ids respond; a `seal_approve` dry-run path is reachable.
- **Walrus:** `WALRUS_PUBLISHER` + `WALRUS_AGGREGATOR` testnet endpoints respond to a tiny put/get.
- **zkLogin:** the testnet prover endpoint responds.
- **RECORD:** U7 → the concrete Seal key-server ids, Walrus publisher/aggregator URLs, zkLogin prover URL in `docs/FACTS.md#seal-walrus-zklogin`.
- **Fallback:** if a primitive is down, mock it behind its own adapter (same pattern as Hashi, G7) and demo the rest.

## D9 — (devnet only) hBTC coin type  (resolves U5) — low priority — ⛔ **N/A 2026-07-25 — targeting testnet**

Only if you deviate to devnet (NOT recommended — devnet wipes). Verify `0xa877…3771::btc::BTC` via coin metadata. Otherwise mark U5 "N/A — targeting testnet".

## D10 — `project_capacity` time granularity + exact event type strings  (KEEPER §10) — ✅ **PASS 2026-07-25** (time base = SECONDS)

```bash
# Pull one real WithdrawalSigned event and record its FULL type string + timestamp field granularity:
curl -s https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' -d '{
 "jsonrpc":"2.0","id":1,"method":"suix_queryEvents",
 "params":[{"MoveEventModule":{"package":"0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360","module":"withdrawal_queue"}},null,10,true]}' | jq '.result.data[] | {type, parsedJson}'
```
- **RECORD:** the exact `0x…::withdrawal_queue::Signed` (and `Requested`/`PickedForProcessing`) type strings for the keeper event filters (`docs/KEEPER.md`), and whether the limiter advances on **seconds** vs **ms** (the TS `projectCapacity` floors to integer seconds — confirm this matches on-chain, else fix the shared `hashi/limiter.ts`). **This directly affects G5 replay correctness.**

---

## Exit gate

Before starting Phase 1 (feature code) in `docs/BUILD-PLAN.md`:
- D1, D3, D5, D8, D10 PASS (or fallback engaged) — these are BLOCKING for real mode.
- D2, D4, D6, D7 recorded (resolved or logged with the fallback chosen).
- Every resolved value written back into `docs/FACTS.md` (UNKNOWN rows replaced).
- MOCK path is green regardless (G7) — you can build the whole system against the mock while D-items resolve.

### Exit-gate status, 2026-07-25 — **PASSED, Phase 1 unblocked**

| Gate | Status |
|---|---|
| D1 PASS | ✅ |
| D3 PASS-or-fallback | ⚠️ **fallback engaged** — book read verified; live maker placement deferred behind the scripted book-seeder account, which is now a **hard build dependency**, not an optional nicety (NAV depends on it). |
| D5 PASS | ✅ |
| D8 PASS | ✅ |
| D10 PASS | ✅ |
| D2, D4, D6, D7 recorded | ✅ (D7 logged PARTIAL with a named owner) |
| `docs/FACTS.md` UNKNOWN rows replaced | ✅ — zero `UNKNOWN — resolve in DAY-ONE.md` rows remain |
| MOCK path green (G7) | owned by the keeper scaffolding unit, not this checklist |

**The two items carrying real schedule risk both need a human to start them today:**
1. **D7 — the signet faucet drip.** hBTC cannot be minted (`docs/FACTS.md#hbtc`); a real ~70-minute signet deposit is the only source. Nothing on the BTC leg can be rehearsed until sats land.
2. **D3c — seeding the hBTC/DBUSDC book.** Both sides are empty and the whole testnet book has zero volume; `book_mid` has nothing to read until a scripted account quotes. This depends on (1).
