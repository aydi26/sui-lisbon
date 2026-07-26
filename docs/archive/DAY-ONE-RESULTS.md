# DAY-ONE-RESULTS.md — execution record for `docs/DAY-ONE.md`, 2026-07-25

> # 📌 ARCHIVE — 2026-07-26. Still valid **as evidence**; superseded **as a plan**.
>
> The product pivoted on 2026-07-26. The v1 build this record was produced for is dead, and the
> decisions taken in it about routers, maker quoting and pinned exit addresses no longer apply.
>
> **What survives, and why this file was not deleted:** every `[D<n>]` citation in
> `docs/FACTS.md` and `docs/RECON.md` points at a block below. This is the receipt behind the live
> Hashi config, the Guardian limiter scalars, the Pyth Beta feed id, the Seal/Walrus/zkLogin
> endpoints, the DeepBook venue reality and the signet faucet findings — all of which are still
> load-bearing facts about the world.
>
> Read it to check *how* a fact was established. Do not read it for what to build.

> Purpose: the **evidence file**. One section per D1–D10 with the exact command run, the real (trimmed) output, a PASS/FAIL/N-A verdict, and the decision taken. Every value promoted into `docs/FACTS.md` traces back to a block here. Nothing in this file is invented; where a probe was not run, it says so.
> Read after: `docs/RECON.md`, `docs/DAY-ONE.md`. Resolved values live in `docs/FACTS.md` — this file is the receipt, not the reference.

## Environment of record

| | |
|---|---|
| Date of run | 2026-07-25 (chain timestamps are UTC and land on 2026-07-24T21:00–23:10Z) |
| `sui` CLI | `sui 1.76.0-6effb4523834`, `sui client active-env` = `testnet` |
| Active address | `0x883ff25499d099a0e578a781acf03ff251647ca2430a2cef03257b080ea01125` (1.86 SUI) |
| node | `v24.13.0` |
| Chain id | `4c78adac` (testnet) |
| Throwaway SDK probe dir | `%TEMP%\claude\…\scratchpad\probe` — `@mysten/sui@2.22.1`, `@mysten/hashi@0.6.0`, `@mysten/seal@1.3.4`, `@mysten/walrus@1.2.9`. **Nothing was installed into `keeper/` or `app/`.** |
| On-chain writes | **NONE.** Every transaction in this file is `--dev-inspect` or `dryRunTransactionBlock`. No keys were written to any file. |

**Transport note (governs every probe below).** `https://fullnode.testnet.sui.io:443` returns **HTTP 404** for JSON-RPC (gRPC v2 only, RECON R1 — re-confirmed below). All JSON-RPC probes therefore target the verified mirror `https://rpc-testnet.suiscan.xyz:443`. The `sui` CLI talks gRPC to the official fullnode and works normally.

```bash
$ curl -s -o /dev/null -w "http=%{http_code}" https://fullnode.testnet.sui.io:443 \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
http=404
$ curl -s https://rpc-testnet.suiscan.xyz:443 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"4c78adac"}
```

---

## Summary table

| Item | Resolves | Verdict | One-line outcome |
|---|---|---|---|
| D1 | U9 | **PASS** | All 8 testnet ids resolve; the devnet Hashi package correctly does NOT exist on testnet. |
| D2 | U3 | **PASS (answer = NO)** | On-chain visibility dump: every `withdrawal_queue` / `btc_config` getter is `Friend` (`public(package)`). Fallback engaged. |
| D3 | U8 | **PARTIAL** | Book read verified live (empty book; `mid_price` aborts `EEmptyOrderbook=2`, `get_level2_range` returns `([], [])`). BalanceManager+TradeCap mint dry-runs green. Live maker placement **not attempted** — needs hBTC inventory (~70 min signet deposit). |
| D4 | U1 | **PASS — RESOLVED** | Guardian `/info` **is** reachable over **HTTP/2**: `refillRateSatsPerSec=115740`, `maxBucketCapacitySats=10_000_000_000`. The FACTS.md prior was wrong by ~100×. |
| D5 | U2 | **PASS** | Beta BTC/USD feed id = `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`. Pyth State + package resolve. |
| D6 | U4 | **PASS — YES** | `generateDepositAddress` is a **pure local** derivation and accepts any 32-byte value, including a synthetic object id. Deterministic. |
| D7 | U6 | **PARTIAL** | Both faucets return HTTP 200. Actual sats delivery **not measured** (needs a signet wallet + human captcha) — owner: build lead, start dripping now. |
| D8 | U7 | **PASS** | Seal key servers up + `service_id` matches on-chain object; Walrus PUT→GET round trip succeeded; zkLogin prover reachable. |
| D9 | U5 | **N/A** | Targeting testnet. Devnet Hashi package does not exist on testnet; U5 closed as N/A. |
| D10 | KEEPER §10 | **PASS** | All real event type strings captured. `WithdrawalSigned` carries **no amount and no timestamp** (RECON R8 confirmed). Limiter time base = **seconds**. |

Two **corrections to `docs/RECON.md`** were produced by this run and are carried into `docs/FACTS.md`:
1. **R9 golden vectors #1 and #7 are arithmetically wrong** (expect `105_000`; the stated formula and the upstream SDK both give `100_150`). See D10.
2. **R9's claim that U1 is unresolvable is wrong** — the guardian's read-only `/info` endpoint answers, it just requires HTTP/2. See D4.

---

## D1 — Hashi/DeepBook/Pyth testnet ids resolve on a public fullnode (U9) — **PASS**

```powershell
$env:PATH += ";$env:LOCALAPPDATA\sui"
foreach ($id in $ids) { sui client object $id --json }
```

```
Hashi package                              OK  owner="Immutable"
Hashi shared obj                           OK  owner={"Shared":{"initial_shared_version":805474231}}
Pool hBTC/DBUSDC                           OK  owner={"Shared":{"initial_shared_version":946570339}}
DBUSDC package                             OK  owner="Immutable"
DeepBook v20                               OK  owner="Immutable"
Pyth State                                 OK  owner={"Shared":{"initial_shared_version":12041355}}
Pyth package                               OK  owner="Immutable"
Wormhole State                             OK  owner={"Shared":{"initial_shared_version":1451}}
Hashi DEVNET pkg (expect FAIL on testnet)  FAIL code: 'Some requested entity was not found',
                                                message: "Object 0xa877d4d9…3771 …"
```

The Hashi shared object's own type was read back as
`0xfcea10ca…::hashi::Hashi` with top-level fields `committee_set, config, id, num_consumed_presigs, proposals, tob, treasury, versioning`.

**Verdict: PASS.** U9 → RESOLVED. New value captured for FACTS: **Pyth State `initialSharedVersion = 12041355`**, **Wormhole State `initialSharedVersion = 1451`** (needed for PTB shared-object refs).

---

## D2 — Does Hashi expose on-chain getters for queue depth / config? (U3) — **PASS, answer = NO**

`suix_getNormalizedMoveModulesByPackage` is unsupported on every mirror (RECON R1), but the per-module form **is** supported, and it reports `visibility` — which is what actually decides U3. `Friend` in the normalized ABI == `public(package)` in Move 2024.

```bash
curl -s https://rpc-testnet.suiscan.xyz:443 -H 'Content-Type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"sui_getNormalizedMoveModule",
   "params":["0xfcea10ca…c7f4360","withdrawal_queue"]}'
```

```
== withdrawal_queue
   Friend (46): approve_withdrawal, borrow_request, …, is_request_processing, …,
                request_bitcoin_address, request_btc_amount, request_created_timestamp_ms,
                request_id, request_sender, request_status, …, withdrawal_txn_pending_count, …
   Public (1):  output_utxo
== btc_config
   Friend (15): bitcoin_chain_id, bitcoin_confirmation_threshold, bitcoin_deposit_minimum,
                bitcoin_deposit_time_delay_ms, bitcoin_withdrawal_minimum, dust_relay_min_value,
                init_defaults, set_*, withdrawal_cancellation_cooldown_ms, worst_case_network_fee
== withdraw
   request_withdrawal:   vis=Public  entry=false     <-- composable
   cancel_withdrawal:    vis=Public  entry=false     <-- composable
   approve_request / commit_withdrawal_tx / confirm_withdrawal / finalize_withdrawal /
   commit_input_signatures / reallocate_presigs / cleanup_spent_utxos : vis=Private entry=true
== deposit
   deposit / approve_deposit / confirm_deposit / delete_expired_deposit : vis=Private entry=true
```

**Verdict: PASS — U3 = NO**, verified against the deployed bytecode (not just source).
Consequences, all of which are now FACTS:
- `hashi::btc_config::bitcoin_withdrawal_minimum()` is **NOT callable from `aphotic`** ⇒ inject `30_000` as a Move constant.
- **No on-chain read of queue depth or limiter state exists.** `envelope.move` takes the static-buffer + event-replay path **unconditionally**; there is no "if YES" branch to write.
- `deposit::confirm_deposit` is `entry` and **private-entry**, i.e. PTB-callable, **not** composable from our Move. The permissionless crank is a keeper/app **PTB**, never a Move call inside `gateway.move`.
- Only two Hashi functions are `public fun`: `request_withdrawal` and `cancel_withdrawal`. That is the entire composable surface (G7).

---

## D3 — hBTC/DBUSDC book + maker placement (U8) — **PARTIAL**

### D3a — read the book (the indexer is unusable, RECON R10; simulate instead)

```powershell
sui client call --dev-inspect --package 0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24 `
  --module pool --function mid_price `
  --type-args 0xfcea10ca…::btc::BTC 0xf7152c05…::DBUSDC::DBUSDC `
  --args 0x5cdaebf2…a55ced6 0x6
```

```
Dry run completed, execution status: failure
MoveAbort(MoveLocation { module: ModuleId { address: d874d241…bbb24, name: Identifier("book") },
          function: 12, instruction: 88, function_name: Some("mid_price") }, 2) in command 0
```

Abort code **2** in `deepbook::book` is `EEmptyOrderbook` (source, pinned rev `0b6d9cca…`):
```move
const EInvalidAmountIn: u64 = 1;
const EEmptyOrderbook: u64 = 2;
const EInvalidPriceRange: u64 = 3;
```

Same call via `devInspectTransactionBlock` with BCS decoding of the returns:

```
=== pool::mid_price                                status: failure  MoveAbort(… book … ,2)
=== pool::get_level2_range is_bid=true  [1, 1e12]  status: success
  cmd0 ret0 type=vector<u64> bytes=[0]
  cmd0 ret1 type=vector<u64> bytes=[0]
  DECODED prices= [] quantities= []
=== pool::get_level2_range is_bid=false [1, 1e12]  status: success
  DECODED prices= [] quantities= []
```

**Both outcomes are the acceptable ones named in the brief, and they differ per function — this is the load-bearing result:**
`mid_price` **aborts** on an empty book; `get_level2_range` **succeeds and returns two empty vectors**. The keeper must read the book with `get_level2_range`, never `mid_price`, or it dies on an empty testnet book.

### D3b — deployed package version 20 is BEHIND the pinned source rev (new, blocking)

RECON R3 pins `deepbook` at rev `0b6d9cca8975f38cf55c3e9bf5dcca2563b148cb`, whose `Published.toml` claims `published-at = 0xd874d241…` (v20). Diffing the source's public functions against the **deployed** module:

```bash
curl … sui_getNormalizedMoveModule 0xd874d241…bbb24 pool   # 85 public fns
grep -E '^public(\(package\))? fun' pool.move              # 88 public fns  (rev 0b6d9cca)
```
```
IN SOURCE BUT NOT ON-CHAIN: ["best_ask_price","best_bid_price","place_post_only_limit_order"]
ON-CHAIN BUT NOT IN SOURCE: []
```
Independently confirmed one call at a time:
```
mid_price                  : PRESENT
get_level2_range           : PRESENT
get_level2_ticks_from_mid  : PRESENT
place_limit_order          : PRESENT
place_market_order         : PRESENT
swap_exact_base_for_quote  : PRESENT
best_bid_price             : ABSENT -> No function was found with function name best_bid_price
best_ask_price             : ABSENT -> No function was found with function name best_ask_price
place_post_only_limit_order: ABSENT -> No function was found with function name place_post_only_limit_order
```

**Decision:** `router.move` must **not** call `best_bid_price`, `best_ask_price`, or `place_post_only_limit_order`. They compile (the dep source has them) and then fail at publish/link time against v20. Use `place_limit_order(order_type = POST_ONLY = 3)` and derive top-of-book from `get_level2_range`. Recorded in `docs/FACTS.md#deepbook-venue` and the MOVE-PACKAGE/KEEPER errata.

Order-type constants read from the pinned `constants.move` (these are compile-time values, identical in v20):
`NO_RESTRICTION=0, IMMEDIATE_OR_CANCEL=1, FILL_OR_KILL=2, POST_ONLY=3`; `SELF_MATCHING_ALLOWED=0, CANCEL_TAKER=1, CANCEL_MAKER=2`; `FLOAT_SCALING=1_000_000_000`.

### D3c — fresh BalanceManager + TradeCap (the G2 capability split) — dry-run green

```js
const bm  = tx.moveCall({ target: `${PKG}::balance_manager::new` });
const cap = tx.moveCall({ target: `${PKG}::balance_manager::mint_trade_cap`, arguments: [bm] });
tx.transferObjects([cap], SENDER);
tx.moveCall({ target: '0x2::transfer::public_share_object',
              typeArguments: [`${ORIG}::balance_manager::BalanceManager`], arguments: [bm] });
await client.dryRunTransactionBlock({ transactionBlock: await tx.build({ client }) });
```
```
D3b BalanceManager+TradeCap dry-run status: {"status":"success"}
  created 0xfb28c4cb…::balance_manager::TradeCap      owner={"AddressOwner":"0x883ff254…"}
  created 0xfb28c4cb…::balance_manager::BalanceManager owner={"Shared":{"initial_shared_version":902523980}}
  gas used (computation+storage): 1990000 4810800
```

The full cap set exists on-chain and is independent, exactly as G2 assumes:
`mint_trade_cap`, `mint_deposit_cap`, `mint_withdraw_cap`, `revoke_trade_cap`,
`generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext) -> TradeProof`,
`generate_proof_as_owner(&mut BalanceManager, &TxContext) -> TradeProof`.

**Verdict: PARTIAL.** Book read = PASS. Capability model = PASS. **Live maker placement NOT attempted**: it needs `Coin<hBTC>` and `Coin<DBUSDC>` in the manager, and hBTC cannot be minted by us (`treasury::mint` is `public(package)`, G1) — it requires a real ~70-minute signet deposit. Fallback already mandated by RECON R10 stands: **a scripted second account seeding both sides of the book is not optional; NAV depends on it.**

---

## D4 — Guardian limiter genesis scalars (U1) — **PASS, RESOLVED**

The `@mysten/hashi@0.6.0` surface is not what `docs/FACTS.md#sdk` describes. Actual exports:

```
AmountBelowMinimumError HashiClient HashiConfigError HashiFetchError HashiGuardianError
HashiPausedError InvalidBitcoinAddressError InvalidParamsError arkworksToSec1Compressed
bitcoinAddressToWitnessProgram deriveChildPubkey estimateWaitSecs fetchGuardianInfo
generateDepositAddress hashi projectCapacity twoOfTwoTaprootScriptPathAddress
witnessProgramToAddress
```

There is **no `guardian.limiterStatus`**. There is `fetchGuardianInfo(origin)` which GETs `<origin>/info`. Over plain HTTP/1.1 (curl, and Node's global `fetch`) that endpoint returns **464** — an ALB protocol-version rejection, which is what made RECON conclude the guardian was gRPC-only:

```
SDK fetchGuardianInfo FAILED: HashiGuardianError  Guardian /info returned HTTP 464
```

Retried with Node's built-in `node:http2` (ALPN `h2`):

```js
const client = http2.connect('https://guardian.testnet.hashi.sui.io');
client.request({ ':method': 'GET', ':path': '/info', accept: 'application/json' });
```
```json
{"limiter":{"state":{"numTokensAvailableSats":"7043037994",
                     "lastUpdatedAtSecs":"1784934423",
                     "nextSeq":"556"},
            "config":{"refillRateSatsPerSec":"115740",
                      "maxBucketCapacitySats":"10000000000"}},
 "gitRevision":"ae3fc68200a80fcef2dd5dbea5c4fd18a4ec8f0e",
 "committeeEpoch":"1171",
 "btcPubkey":"41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995",
 "signingPubKey":"8e6e6767497fe1aec80e94405aab18c8cbd97cc57cc5709cdcced90ca90d74ee",
 "signedAtMs":"1784934466504"}
```
`GET /health` → `200` (empty body). `GET /` → `404`. Two samples 14 s apart returned the **same** `state` with a moving `signedAtMs` — i.e. `/info` reports the **raw last-consume state, not a projected balance**; the caller must run `project_capacity` itself. That is exactly the shape the G5 replay assumes.

| Scalar | Value | Derived |
|---|---|---|
| `refill_rate` | **115_740 sats/s** | 9_999_936_000 sats/day ≈ **99.99936 BTC/day** |
| `max_bucket_capacity` | **10_000_000_000 sats** | **100 BTC** |
| observed `num_tokens_available` | 7_043_037_994 sats | ≈ 70.43 BTC at 2026-07-24T23:07:03Z |
| observed `next_seq` | 556 | |

**Verdict: PASS — U1 RESOLVED.** The FACTS.md "sample signet config" prior (`1000 sats/s`, `100_000_000 sats`) is **wrong by ~100×** and is replaced. Two consequences: (a) the bucket is ~100 BTC deep and refills a full bucket per day — Aphotic-sized exits will **never** be the binding constraint, so the redemption buffer is genuinely a risk input and not a product feature; (b) the keeper's guardian client **must** speak HTTP/2 — `@mysten/hashi`'s own `fetchGuardianInfo` fails on Node's default fetch. Wrap it, don't call it.

---

## D5 — Pyth BETA BTC/USD feed id (U2) — **PASS**

```bash
curl -s "https://hermes-beta.pyth.network/v2/price_feeds?query=btc%2Fusd&asset_type=crypto" \
 | node -e "…filter(x=>x.attributes.symbol==='Crypto.BTC/USD')"
```
```json
[{"id":"f9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b",
  "attributes":{"asset_type":"Crypto","base":"BTC","description":"BITCOIN / US DOLLAR",
                "display_symbol":"BTC/USD","generic_symbol":"BTCUSD",
                "quote_currency":"USD","symbol":"Crypto.BTC/USD"}}]
matched 1 of 12
```
The query returns 12 BTC-ish feeds (TBTC, CBBTC, EBTC, UBTC, WBTC, LBTC, MBTC, ZBTC, SOLVBTC…) — only the exact `symbol == "Crypto.BTC/USD"` match is correct. Do not fuzzy-match.

Pyth State `0x2437…1c7c` and package `0xabf8…c837` both resolve (D1).

**Verdict: PASS.** U2 → RESOLVED, `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b`, matching RECON R11. Never ship the stable id `0xe62df6c8…` on testnet (G9).

---

## D6 — `generateDepositAddress` with an arbitrary 32-byte value (U4) — **PASS, answer = YES**

The function is **not** what `docs/FACTS.md#sdk` describes (`({suiAddress})`). Real signature:

```js
function generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network }) {
  return twoOfTwoTaprootScriptPathAddress(guardianBtcXOnly,
           deriveChildPubkey(mpcMasterCompressed, suiAddress), network);
}
```
It is **pure and offline** — no RPC, no server. `suiAddress` must be a **32-byte `Uint8Array`** (a `0x…` hex string throws `Expected 32-byte Sui address, got 66`).

The two key inputs come from the on-chain `Hashi` object, and `mpc_public_key` is stored in **arkworks** encoding — feeding it raw to noble throws `bad point`. It must go through the SDK's `arkworksToSec1Compressed`:

```
mpc_public_key (on-chain, 33 B) = 391d3d8e999367dd9befa4b391fadf5d67025fb30ca7b09b05b9b02ead558f3680
arkworksToSec1Compressed ->       02368f55ad2eb0b9059bb0a70cb35f02675ddffa91b3a4ef9bdd6793998e3d1d39
guardian_btc_public_key (config) = 41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995
```

```
--- D6 / U4: generateDepositAddress with arbitrary 32-byte values (network='signet') ---
  real sui address               -> tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p
  synthetic OBJECT id 0x11*32    -> tb1pf5mfyestn0ufzfxyf6wx4s3kt6c3gqaqjh6ct49vwy7n98wec2rsewnaly
  synthetic OBJECT id 0xab*32    -> tb1pgm6eqt3enj0ssaxh29jmm4q0h52xqr3scr26a887uk5azk237j7qq0crkd
  known depositor from event     -> tb1pyv2knw99ewv8trfhedetep9pldhdhf0jeh92c35frfj44e7wq9js5uk94z
  deterministic: true
```

**Verdict: PASS — U4 = YES.** All four derive valid signet P2TR (`tb1p…`) addresses and the derivation is deterministic. `BUILD-PLAN` T5.3 (deposit-ticket transfer-to-object) is **not** blocked by derivation.
Honest caveat, unchanged from DAY-ONE's own wording: deriving the address proves nothing about `confirm_deposit` **minting to an object id** — the mint recipient is decoded on-chain from the derivation path and only a live deposit proves that leg. Treat T5.3 as *derivation-unblocked, mint-unproven*.

Bonus, verified on a real on-chain exit address: `witnessProgramToAddress(<20 bytes>, 'signet')` →
`tb1qht7wmzjggxl9je0zw7fl42rjjqh9w4ka2lwv3u` (P2WPKH). `bitcoinAddressToWitnessProgram(addr, network)` takes the network as a **second argument** — omitting it throws `wrong-network` with `expected "undefined"`.

---

## D7 — Signet faucet throughput (U6) — **PARTIAL**

```
200  https://signet257.bublina.eu.org/
200  https://signetfaucet.com
200  https://alt.signetfaucet.com/
```

**Verdict: PARTIAL / LOGGED.** Both faucets named in DAY-ONE are alive, plus a third (`alt.signetfaucet.com`). **Delivery time and amount were NOT measured** — both are human/captcha-gated web forms and require a signet wallet address, which this run neither owns nor should create on the user's behalf. Owner: build lead. This is the single longest-lead item in the whole plan (G6: deposits are ~70 min end-to-end and hBTC cannot be minted any other way — see D3c) — **start dripping to ≥ 30 000 sats today.**

---

## D8 — Seal + Walrus + zkLogin live on testnet (U7) — **PASS**

### Walrus — real PUT → GET round trip

```bash
$ echo -n "aphotic-day-one-probe-2026-07-25" > blob.txt
$ curl -X PUT "https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=5" --upload-file blob.txt
http=200
{"newlyCreated":{"blobObject":{
  "id":"0x75757b0f9ed5ac6cc42eebb76f18ff6ee610e0f0aaa32e282b824e2751c60634",
  "registeredEpoch":469,
  "blobId":"GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM",
  "size":32,"encodingType":"RS2","certifiedEpoch":null,
  "storage":{"id":"0x6e43a2bc…","startEpoch":469,"endEpoch":474,"storageSize":66034000},
  "deletable":true}},
 "resourceOperation":{"registerFromScratch":{"encodedLength":66034000,"epochsAhead":5}},
 "cost":1438794}}

$ curl "https://aggregator.walrus-testnet.walrus.space/v1/blobs/GvttnuEgQzwvZa-R2bP1_P2QW-sgLihnwITYJj1XCaM"
aphotic-day-one-probe-2026-07-25
http=200
```

`?epochs=5` was honoured verbatim (`startEpoch 469 → endEpoch 474`), which is the empirical proof behind the FACTS rule "set `WALRUS_EPOCHS` explicitly and long". Two findings worth carrying: the blob came back **`"deletable": true`** and **`"certifiedEpoch": null`** immediately after write — so an `envelope.move` availability check that requires *certified* and *non-deletable* would have **rejected our own fresh blob**. Publisher-created blobs are deletable by default.

Redundant endpoints, all HTTP 200 on `/v1/api`:

| Role | URL |
|---|---|
| publisher (primary) | `https://publisher.walrus-testnet.walrus.space` |
| aggregator (primary) | `https://aggregator.walrus-testnet.walrus.space` |
| publisher (backup) | `https://wal-publisher-testnet.staketab.org` · `https://walrus-testnet-publisher.nodes.guru` |
| aggregator (backup) | `https://wal-aggregator-testnet.staketab.org` · `https://walrus-testnet-aggregator.nodes.guru` |

### Seal — key servers up, `service_id` cross-checked against chain

`@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`**; `SealClient` takes an explicit `serverConfigs` list. Ids taken from the upstream docs (`MystenLabs/seal`, `docs/content/UsingSeal.mdx`, `_SealPackageIds.mdx`) and then **verified on-chain**:

```
$ sui_getObject 0x73d05d62…56db75
  type: 0x0f16e84a49dec8425e6900cfdfe3730aaf1e8bc608d9f0500fcfa2c2267abfb4::key_server::KeyServer
  owner: {"Shared":{"initial_shared_version":443947654}}
$ sui_getObject 0xf5d14a81…591623c8
  type: 0x0f16e84a…::key_server::KeyServer   owner: Shared(443947655)
$ sui_getObject 0xb012378c…1e1e98
  type: 0x4614e5da0136ee7d464992ddd3719d388ae2bfdb48dfec6d9ad579f87341f2e1::key_server::KeyServer
  owner: {"ObjectOwner":"0xeb24d442…86d2"}      (committee member object)
$ sui_getObject 0xdccbeb87…d814112  ->  type: package, owner: Immutable
```
```
$ curl "https://seal-key-server-testnet-1.mystenlabs.com/health"   {"name":"key-server","version":"0.6.11","status":"up"}
$ curl "https://seal-key-server-testnet-2.mystenlabs.com/health"   {"name":"key-server","version":"0.6.11","status":"up"}
$ curl "https://seal-aggregator-testnet.mystenlabs.com/health"     {"name":"key-server","version":"0.6.11","status":"up"}

$ curl ".../v1/service?service_id=0x73d05d62…56db75" -H "Client-Sdk-Version: 1.3.4" -H "Client-Sdk-Type: typescript"
{"service_id":"0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
 "pop":"lyXUNwyEKphh6rJ28WRgnCC1LjT0AX9j7lbqoQjlKZWUXijHEnMTwmvgLlE8WUcc"}
$ curl ".../v1/service?service_id=0xf5d14a81…591623c8" …
{"service_id":"0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
 "pop":"o8HaTy68eARZEZkfGyHMOMjEFd4Qi8C4sRqMEq8SbFV73uLZ8gvHIluSDdn+w18/"}
```
Each server's self-reported `service_id` equals its on-chain object id — the anti-impersonation check the Seal docs describe passes. Note `/v1/service` **requires** a `Client-Sdk-Version` header (400 `MissingRequiredHeader` without it) **and** a `service_id` query param (400 `InvalidServiceId` without it).

### zkLogin prover

```
400  https://prover.mystenlabs.com/v1        (POST {} — 400 = alive, rejecting a malformed body)
400  https://prover-dev.mystenlabs.com/v1
404  https://api.enoki.mystenlabs.com/v1/zklogin
```

**Verdict: PASS.** U7 → RESOLVED with concrete endpoints; all three primitives coexist on testnet alongside DeepBook and Hashi. No adapter-mocking fallback needed for Seal or Walrus.

---

## D9 — devnet hBTC coin type (U5) — **N/A**

Targeting testnet (Hashi devnet wipes). D1 confirms `0xa877d4d9…3771` does not exist on testnet. **U5 closed as N/A — targeting testnet.** No work required.

---

## D10 — Exact event type strings, envelope timestamp, limiter time base (KEEPER §10) — **PASS**

### D10a — full event inventory, observed live

```bash
curl -s https://rpc-testnet.suiscan.xyz:443 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,
 "method":"suix_queryEvents","params":[{"MoveEventModule":
   {"package":"0xfcea10ca…c7f4360","module":"withdrawal_queue"}},null,25,true]}'
```

Every type string below was returned by the node, verbatim. `P` = `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360`.

| Fully-qualified type | Observed | `parsedJson` keys |
|---|---|---|
| `P::withdrawal_queue::WithdrawalRequested` | ✅ | `bitcoin_address, btc_amount, request_id, requester_address, sui_tx_digest, timestamp_ms` |
| `P::withdrawal_queue::WithdrawalApproved` | ✅ | `request_id` |
| `P::withdrawal_queue::WithdrawalPickedForProcessing` | ✅ | `change_outputs, inputs, randomness, request_ids, timestamp_ms, txid, withdrawal_outputs, withdrawal_txn_id` |
| `P::withdrawal_queue::WithdrawalInputsSigned` | ✅ | `num_inputs, signed_count, withdrawal_txn_id` |
| `P::withdrawal_queue::WithdrawalSigned` | ✅ | `guardian_signatures, request_ids, signatures, withdrawal_txn_id` |
| `P::withdrawal_queue::WithdrawalConfirmed` | ✅ | `change_utxo_amounts, change_utxo_ids, request_ids, txid, withdrawal_txn_id` |
| `P::withdrawal_queue::WithdrawalCancelled` | not seen in window | — |
| `P::withdrawal_queue::WithdrawalPresigsReassigned` | not seen in window | — |
| `P::deposit::DepositRequested` | ✅ | `amount, derivation_path, request_id, requester_address, sui_tx_digest, timestamp_ms, utxo_id` |
| `P::deposit::DepositApproved` | ✅ | `approval_timestamp_ms, cert, request_id, utxo` |
| `P::deposit::DepositConfirmed` | ✅ | `request_id, utxo` |
| `P::deposit::ExpiredDepositDeleted` | not seen in window | — |
| `P::treasury::Minted<P::btc::BTC>` | ✅ | `amount` |
| `P::treasury::Burned<P::btc::BTC>` | (generic, same shape) | `amount` |

⚠ `treasury::Minted`/`Burned` are **generic**: the type string a filter must match is `P::treasury::Minted<P::btc::BTC>`, **including the type argument**. A `MoveEventType` filter on the bare name will not match.

Real samples:
```json
WithdrawalRequested   {"bitcoin_address":[186,252,237,138,72,65,190,89,101,226,119,147,250,168,114,144,46,87,86,221],
                       "btc_amount":"1000000",
                       "request_id":"0xac5fa70b08b2d82fb30035fcb2d56a52af0fa9afe8bd93d8b6286c36a3d95488",
                       "requester_address":"0xf0d3747d…a5bd","sui_tx_digest":[…32 bytes…],
                       "timestamp_ms":"1784930128384"}
WithdrawalSigned      {"guardian_signatures":[[…64 B…],…],
                       "request_ids":["0xac5fa70b…95488"],
                       "signatures":[…],"withdrawal_txn_id":"0x05d6529c…5ff5"}
WithdrawalPicked…     withdrawal_outputs[0] = {"amount":"998835",
                                               "bitcoin_address":[186,252,…,221]}
DepositConfirmed      {"request_id":"0x06dc9fc2…9a08",
                       "utxo":{"amount":"30065","derivation_path":"0x61408a9f…9be4",
                               "id":{"txid":"0x546a4559…5d44","vout":0}}}
```

### D10b — `WithdrawalSigned` has no amount and no timestamp (RECON R8 confirmed)

```
Signed has timestamp_ms field? false
Signed has amount field?      false
Signed n request_ids:         1
```
So the G5 replay must, per signed batch:
- **sats** = Σ over `request_ids` of `WithdrawalRequested.btc_amount` (fallback `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount`; in the sampled batch `1_000_000` requested vs `998_835` output — the delta is the Bitcoin network fee, **so use the REQUESTED amount, which is what the bucket is debited by**);
- **timestamp** = the **Sui event envelope** field, not a struct field.

### D10c — envelope timestamp field name and type

```
--- envelope keys ---
[ 'id','packageId','transactionModule','sender','type','parsedJson','bcsEncoding','bcs','timestampMs' ]
timestampMs: 1784930450570  (type string)
```
The envelope field is **`timestampMs`** (camelCase) and arrives as a **decimal string** over JSON-RPC — `BigInt(e.timestampMs)`, never `parseInt`. Where a struct also carries `timestamp_ms` they differ slightly (`WithdrawalPickedForProcessing`: struct `1784930435223` vs envelope `1784930435924`, 701 ms apart). **The bucket must be advanced by the envelope `timestampMs` of `WithdrawalSigned`, because `WithdrawalSigned` has no struct timestamp at all.**

### D10d — limiter time base = SECONDS; two RECON golden vectors are wrong

The guardian's own `/info` (D4) reports **`lastUpdatedAtSecs`** and **`refillRateSatsPerSec`** — the time base is **UNIX seconds**, confirming RECON R9. Sui `Clock` is ms ⇒ divide by 1000 at the boundary.

The upstream SDK implementation (`@mysten/hashi@0.6.0`, `dist/guardian.mjs`) is the reference:
```js
function projectCapacity(config, state, timestampSecs) {
  const refilled = (timestampSecs > state.lastUpdatedAtSecs
                     ? timestampSecs - state.lastUpdatedAtSecs : 0n) * config.refillRateSatsPerSec;
  const projected = state.numTokensAvailableSats + refilled;
  return projected < config.maxBucketCapacitySats ? projected : config.maxBucketCapacitySats;
}
function estimateWaitSecs(config, state, amountSats, nowSecs) {
  if (amountSats > config.maxBucketCapacitySats) return null;
  const available = projectCapacity(config, state, nowSecs);
  if (available >= amountSats) return 0n;
  const deficit = amountSats - available;
  if (config.refillRateSatsPerSec === 0n) return null;
  return (deficit + config.refillRateSatsPerSec - 1n) / config.refillRateSatsPerSec;
}
```
Note the arg shape: **`(config, state, ABSOLUTE timestampSecs)`** — not `(tokens, refillRate, cap, elapsedMs)` as `docs/KEEPER.md` §2.4 specifies. Note also `timestampSecs > lastUpdatedAtSecs ? … : 0n`, which is how "saturating_sub" is expressed in bigint.

Run against RECON R9's golden vectors:
```
SDK projectCapacity({refill:10n, cap:2_000_000n}, {tokens:100_000n, last:0n}, 15n)      = 100150n
        RECON R9 vector #1 expects 105000n                                             ← RECON IS WRONG
SDK projectCapacity(same, 2n**64n-1n)                                                  = 2000000n
        RECON R9 vector #2 expects 2000000n                                            ← agrees
SDK estimateWaitSecs(same, 200_000n, 0n)                                               = 10000n
```
`100_000 + 15 × 10 = 100_150`. RECON R9's own stated formula gives `100_150`; the tabulated expectation `105_000` does not follow from it. **Vectors #1 and #7 in RECON R9 are arithmetic errors.** The algorithm in R9 is correct; only those two expected values are not. `docs/FACTS.md#guardian-limiter` now carries the corrected table, and `keeper/src/hashi/limiter.ts` / `move/tests/envelope_tests.move` must use the corrected values or the shared-vector cross-test will never go green.

### D10e — observed real-world latency (bonus, single sample)

For request `0xac5fa70b…95488` (1 000 000 sats):

| Transition | Envelope `timestampMs` | Δ from Requested |
|---|---|---|
| `WithdrawalRequested` | 1784930128384 → 2026-07-24T21:55:28Z | — |
| `WithdrawalApproved` | 1784930138570 | +10 s |
| `WithdrawalPickedForProcessing` | 1784930435924 | +5.1 min |
| `WithdrawalSigned` | 1784930450570 | **+5.4 min** |
| `WithdrawalConfirmed` | 1784933601511 | **+57.9 min** |

Faster than the `~1.5–2 h` in `docs/FACTS.md#latencies`, but it is **one** sample on a quiet signet. Keep the conservative planning figure; G6 (never live-demo the BTC leg) is unaffected — 58 minutes is still far outside a 3-minute demo.

---

## Exit gate assessment (per `docs/DAY-ONE.md`)

| Gate | Status |
|---|---|
| D1 PASS | ✅ |
| D3 PASS-or-fallback | ⚠️ **fallback engaged** — book read verified; maker placement deferred behind the scripted-seeder account (RECON R10), which is now a hard build dependency, not an optional nicety. |
| D5 PASS | ✅ |
| D8 PASS | ✅ |
| D10 PASS | ✅ |
| D2, D4, D6, D7 recorded | ✅ (D7 logged as PARTIAL with a named owner) |
| Every resolved value written back into `docs/FACTS.md` | ✅ — see `docs/FACTS.md#unknowns`; no `UNKNOWN — resolve in DAY-ONE.md` rows remain. |
| MOCK path green regardless (G7) | n/a to this unit — owned by the keeper scaffolding agent. |

**Phase 1 is unblocked.** The two items that carry real schedule risk are (1) the signet faucet drip (D7) and (2) seeding the hBTC/DBUSDC book (D3c) — both need a human to start them today.
