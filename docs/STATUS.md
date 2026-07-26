# STATUS.md — the honest ledger, 2026-07-26

> Purpose: what is **done**, what is **in flight**, and what has **not been started**, for every
> unit in `docs/BUILD-PLAN.md`. Every number here was **observed by running the command in this
> session**; anything not observed says so in the same sentence.
> Read after: `docs/BUILD-PLAN.md` (execution order), `docs/DESIGN-V2.md` (decisions),
> `docs/DEPLOYED.md` (on-chain receipts).
>
> ## ⚠ THE TREE IS BEING REWRITTEN WHILE THIS FILE IS READ
>
> The product pivoted on **2026-07-26** and other agents are actively writing `move/`, `keeper/`,
> `sdk/`, `app/` and `scripts/`. This file is a **timestamped snapshot**, and it demonstrably went
> stale during its own writing: the Move suite grew from **122** tests to **179** in the 19 minutes
> between two runs (see §5). Re-run the commands; do not trust the numbers below past their
> timestamp.

---

## 1. Headline

> ## ⚠ RE-MEASURED 2026-07-26, ON macOS — every row below the fold is older than this block
>
> The table further down was written mid-build and is now wrong in almost every row that says
> "No". Re-run from a **fresh clone** of `main`, on macOS, nothing cached:
>
> | Question | Answer, as observed |
> |---|---|
> | Does `move/` build on macOS / Linux? | **It did NOT — and that was the headline bug.** `Move.lock` recorded its `subdir` paths with **Windows backslashes** (`crates\sui-framework\packages\move-stdlib`), which the resolver treats as a literal directory name off Windows: `Invalid directory`. No build, no test, no publish, on any non-Windows machine. This is blocker **B8**, known and never fixed. `Move.toml` was always right; the **lock** is what the resolver reads. Fixed by normalising both lockfiles to forward slashes, which are valid on Windows too. |
> | Do the Move tests pass? | **Yes — `Total tests: 283; passed: 283; failed: 0`.** |
> | `lending/`? | **Yes — `Total tests: 37; passed: 37; failed: 0`.** First time this package was run at all. |
> | Does `sdk/` exist? | **Yes, and it is green: 376 tests**, including the 10 000-case seeded property suite. |
> | Is the keeper v2? | **Yes: typecheck clean, 252 tests green.** |
> | Is the app v2? | **Yes: typecheck clean, `vite build` clean, 345 tests green.** |
> | Are the gates green? | **Yes: `bash scripts/gates.sh` → 12 PASS · 0 FAIL · 0 SKIP.** The four SKIPs are gone — `batchstate` and `seal_le` now guard a `batch.move` that exists. |
> | On-chain verification? | **`34 PASS · 1 FAIL · 0 WARN`.** The 7 WARNs were never a deployment problem: `verify-onchain.mjs` reads `APHOTIC_VAULT_ID` etc., while `keeper/.env.example` shipped `VAULT_ID` and omitted six others, so **the repo could not reproduce the `33 PASS` it documents**. Fixed in the example. |
> | **The one real FAIL** | **`admin != keeper` — `Vault.caps.admin` and `.keeper` are BOTH `0xd41b0cd8…f333d`.** One key proposes NAV *and* approves it, so the two-party split (G3) is not live on this deployment. The Move is not at fault: the bytecode is identical either way, which is exactly why this can only be caught on chain. `/vault` now **reads the CapRegistry and says so** instead of asserting the guarantee; `scripts/rotate-keeper.mjs <addr> --execute` closes it in one transaction, signed by the AdminCap holder. |
> | Had the auction ever run? | **No — `next_batch_id` was 0.** Batch **0** is now open on chain (digest `3JWjDDma…`), closing at exactly **18:00:00.000Z**, derived not passed. See `docs/DEPLOYED.md § BATCH 0`. Opening it immediately exposed a real app bug — `Batch` is a **prefix** of `BatchRegistry`, so live-batch discovery could return the registry id — which no test could have caught while no batch existed. |
> | Total | **1 293 tests green** across move · lending · sdk · keeper · app. |
>
> **Cut line: met.** Deposit → `propose_nav` → `approve_nav` → claim has run four times on chain
> (epoch 4), and the auction has a live batch. B26 is closed: the `Vault` exists
> (`0x91660fb4…89b3efcf`), so the "no LP share coin" blocker below is history.

### The original table, kept for the record — stale from `2026-07-26 02:1x`


| Question | Answer, as observed |
|---|---|
| Does `move/` compile? | **Yes.** `sui move build` exit **0**, zero warnings, at 01:52 and again at 02:11. |
| Do the Move tests pass? | **Yes.** ~~179 passed at 02:11~~ → **`Total tests: 275; passed: 275; failed: 0`** re-run at 05:0x. |
| Is the Move package complete? | ~~No — three of ten modules do not exist.~~ → **Yes, all ten exist and are green.** |
| **Is the Move package PUBLISHED?** | **Yes** — package `0x2ebf955e…d9a3`, digest `Hyso18276VRqbDyt9DbvFBDvActna7mbUWutedzUgm7o`, all 10 modules, 0.402 SUI. The first attempt was **rejected on chain** (`VMVerificationOrDeserializationError` — `Clearing` had 39 fields, the verifier caps a struct at **32**); refactoring it into nested `Pricing`/`Allocation` structs fixed it. ⚠ **`sui move build` does not run that verifier** — a 275-green package can still be unpublishable, so gate publishes on `sui client publish --dry-run`. |
| Is the runtime object graph up? | **Partly.** Shared `AdapterRegistry` is live (`0xd7438618…b9f1`, isv 953314528). **`Vault` and `BatchRegistry` are blocked by B26** — `vault::create` consumes a `TreasuryCap<S>` and no LP share coin exists. |
| Is the cut line met? | **No.** ~~The three missing modules are the cut line.~~ ~~The publish is the cut line now.~~ The publish landed; **B26 is the cut line now** — with no `Vault` there is no deposit, no batch and no settlement. |
| Does `sdk/` exist? | **No.** |
| Is the keeper v2? | **No.** It still contains the v1 directories. |
| Is the app v2? | **No.** Mid-rewrite; files were being deleted during this session. |
| Are the gates green? | **Not run by me.** Commit `72b12bb` (02:13, mid-session) reports **8 PASS · 0 FAIL · 4 SKIP**, identical in both shells, and closes B11 and B14. **A SKIP is not green** — the four are modules that have not landed, including `seal_le`, the gate guarding the endianness trap. |
| Is the app suite green? | **No.** Closing B14 exposed **7 app tests still asserting v1 `gateway` error constants** (B23). |

> **A correction to an earlier briefing.** The brief for this documentation pass stated that the
> Move package *"does not currently compile because the modules are mid-write."* **That is not what
> the tree does.** It compiles, and its tests pass. What is true is narrower and more useful: the
> package is **incomplete**, not broken — the three modules that carry the product's actual
> mechanism have not been written. A green build over seven modules is not evidence about the three
> that are missing, and nobody should read it as such.

---

## 2. Move package `aphotic` — per module

Snapshot **2026-07-26 02:11 local**. "Banner" is the `@status` the file claims for itself;
"Observed" is what a run showed.

| Module | File | Banner | Tests observed | Observed verdict |
|---|---|---|---|---|
| `events` | `sources/events.move` | `DONE` | — (exercised through every other suite) | **DONE.** Package leaf; compiles; carries the three ceilings in `@facts`. |
| `caps` | `sources/caps.move` | `DONE` | **24** in `caps_tests` | **DONE.** |
| `notes` | `sources/notes.move` | `DONE` | **32** in `notes_tests` | **DONE.** Suite appeared between 01:52 and 02:11. |
| `balance` | `sources/balance.move` | `DONE` | **25** in `balance_tests` | **DONE.** Suite appeared between 01:52 and 02:11. |
| `allocate` | `sources/allocate.move` | `DONE` | **51** in `allocate_tests` | **DONE.** |
| `oracle` | `sources/oracle.move` | `DONE` | **47** in `oracle_tests` | **DONE.** |
| `carry` | `sources/carry.move` | `PARTIAL` | 0 dedicated suite observed | **PARTIAL, correctly.** Interface only, by design (D6). ⚠ the banner claims the three guard predicates are "REAL and tested" but **no `carry_tests.move` exists** — either the tests live elsewhere or the claim is ahead of the code. **Tracked as B16.** |
| **`vault`** | — | — | — | **NOT STARTED.** |
| **`batch`** | — | — | — | **NOT STARTED.** |
| **`clearing`** | — | — | — | **NOT STARTED.** |

Support: `tests/mock_hashi.move` is present (a bridge stand-in inherited from v1). Whether it is
still needed in v2 is unreviewed — the carry does not execute and nothing else calls Hashi.

**Target for the finished package: ≥ 320 Move tests** (`docs/DESIGN-V2.md` §10). At 179 with three
modules missing, that is plausible but not yet demonstrated.

---

## 3. Second package `aphotic_lending` (`lending/`)

| Item | State |
|---|---|
| `lending/sources/lending.move` | present, banner `@status DONE`, with the honesty disclosure block and an on-chain `disclosure()` |
| `lending/Move.toml`, `Move.lock`, `build/` | present — a prior `sui move build` clearly succeeded (bytecode modules are on disk) |
| `cd lending && sui move build` / `test` | **NOT RUN THIS SESSION.** No test count is claimed. |

---

## 4. Off-chain

| Area | State, observed |
|---|---|
| `sdk/` | **DOES NOT EXIST.** This is a **blocker for `P3.batch` and `P3.clearing`**, because the Seal identity encoding and the clearing algorithm must have exactly one home before a second consumer is written. |
| `keeper/src/` | **v1 tree, mid-rewrite.** Still present: `strategy/ routing/ execution/ journal/ privacy/ storage/ verify/ oracle/` — all of which serve the dead product. Still useful and expected to survive: `sui/client.ts`, `hashi/` (esp. `limiter.ts`), `util/` (incl. the seeded `rng.ts`), `config.ts`, `types.ts`. **No keeper test was run this session.** A v1 green would not be evidence for v2. |
| `app/src/` | **v1 tree, mid-rewrite.** `git status` showed `app/src/components/BridgeColumn.tsx`, `app/src/fixtures/bridge.ts` and `app/src/fixtures/deposit.ts` being **deleted** while this file was written. **No app test was run this session.** |
| `scripts/` | **Moved forward at 02:13, mid-session** — commit `72b12bb`. Now present: `gates.{ps1,sh}` with **13 gates** (`g7 g4 g2 ids sdk purity transport notes batchstate keepercap send seal_le todo`), `verify-all.ps1` at **12 steps**, `measure-clearing.mjs`, `LIMITS.generated.md`, plus the pre-existing `verify-onchain.mjs`, `register-deposit.ps1`, `seed-book.{mjs,ps1}`, `check-enoki.mjs`. **None was run by this documentation session** — the figures in §7 are read from that commit's message and from the files, not from a run of my own. |
| `docs/LIMITS.md` | **now exists** — copied verbatim from `scripts/LIMITS.generated.md` (generated 2026-07-26T00:06Z). ⚠ its Measurements section reads **"NOTHING WAS MEASURED"**, because the published package exposes no `clearing` module. |

---

## 5. Verbatim run log

Everything below is real output from this session. Nothing else in this file claims to be.

```
$ export PATH="$LOCALAPPDATA/sui:$PATH"; cd move && sui move build
INCLUDING DEPENDENCY MoveStdlib
INCLUDING DEPENDENCY Sui
INCLUDING DEPENDENCY SuiSystem
INCLUDING DEPENDENCY deepbook
INCLUDING DEPENDENCY hashi
INCLUDING DEPENDENCY token
BUILDING aphotic
BUILD EXIT=0
                                                     # 2026-07-26 01:52 local
```

```
$ cd move && sui move test
Test result: OK. Total tests: 122; passed: 122; failed: 0
                                                     # 2026-07-26 01:52 local
                                                     # sources/: allocate balance caps carry events notes oracle
                                                     # tests/:   allocate_tests caps_tests mock_hashi oracle_tests
```

```
$ cd move && sui move test        # 19 minutes later, same tree, other agents mid-write
Test result: OK. Total tests: 179; passed: 179; failed: 0
                                                     # 2026-07-26 02:11 local
                                                     # per module: allocate_tests 51 · oracle_tests 47 · notes_tests 32
                                                     #             balance_tests 25 · caps_tests 24
```

```
$ git log --oneline -3                               # 2026-07-26 01:52 local
617a720 docs: the v2 reconciliation reference, and a trap that was already in our repo
e8d0ecc refactor(move): prune the market-making thesis, keep the limiter
6fbcafc feat(app): wallet integration and real transactions on every control

$ git log --oneline -1                               # 2026-07-26 02:15 local — a NEW commit
72b12bb feat(scripts): close B11 and B14, and prove the new gates in both directions
                                                     # landed WHILE this file was being written.
                                                     # Its claims (8 PASS / 0 FAIL / 4 SKIP,
                                                     # 13 gates, verify-all 8 -> 12 steps) are
                                                     # read from that commit, NOT re-verified here.
```

**Not run this session, and therefore not claimed anywhere in this file:**
`cd lending && sui move test` · `cd keeper && npm test` · `cd app && npm test` ·
`scripts/gates.ps1` · `scripts/verify-all.ps1` · `node scripts/verify-onchain.mjs`.

---

## 6. Environment of record

| | |
|---|---|
| `sui` | **1.76.0-6effb4523834** at `%LOCALAPPDATA%\sui\sui.exe`. ⚠ **not reliably on `PATH`** in agent shells — prepend it |
| active env | `testnet`, chain id `4c78adac` |
| node / npm | 24.13.0 / 11.6.2 |
| deployer / keeper address | `0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d` |
| OS | Windows 11. ⚠ never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` — PS 5.1 writes a UTF-8 BOM and the compiler rejects it (`E01001`) |
| transport | `https://fullnode.testnet.sui.io:443` is **gRPC v2 only**; JSON-RPC returns 404 |

---

## 7. Known blockers

| # | Blocker | Impact | Owner / fix |
|---|---|---|---|
| ~~**B25**~~ | **CLOSED 2026-07-26 — the package is PUBLISHED.** `Clearing` was refactored into nested `Pricing`/`Allocation` structs, the dry run went green, and the publish succeeded: package `0x2ebf955e…d9a3`, `UpgradeCap` `0x74a25d12…cde5`, digest `Hyso18276VRqbDyt9DbvFBDvActna7mbUWutedzUgm7o`. Shared `AdapterRegistry` `0xd7438618…b9f1` (isv 953314528) created in digest `CqeesXgjs8sFtKxTfjYSQb5ao1ePLGtDLVNTMfqahNGu`. Receipts in `docs/DEPLOYED.md`. **Keep the diagnosis below — the trap is invisible locally and costs an hour to re-derive.** Original text: **`aphotic::clearing::Clearing` declared 39 fields; the Sui verifier caps a struct at 32.** `sui client publish` is rejected by the validator with `VMVerificationOrDeserializationError in command 0`. Measured directly against the chain: a synthetic `key` struct with **32 fields publishes, 33 does not**. Isolated by subset dry-runs — the other **9 modules publish successfully without `clearing`**; a module holding *only* `clearing`'s four structs, every function body stubbed to `abort 0`, still fails, so it is **not** a code-complexity limit. Proof of fix: the identical struct trimmed to 32 fields dry-runs `success`. | **Total.** No package id, no shared objects, no runtime graph, nothing for the keeper/app/SDK to point at. ⚠ **`sui move build` does not run this verifier** — the package is `275 passed / 0 failed` and still unpublishable, so the local suite is no evidence here. ⚠ **`vault::Vault` is at 31 fields — one under the cap.** | **Move agent.** Trim `Clearing` by ≥ 7 fields; group correlated scalars into a nested `has store` struct (nested structs do not inherit the parent's count). Then gate every publish on `sui client publish --dry-run`, which is the only check that catches this. Full bisection in `docs/DEPLOYED.md` § "PUBLISH ATTEMPT — 2026-07-26". |
| **B26** | **No LP share coin exists, so no `Vault` can ever be created.** `vault::create<B,Q,S>` consumes a `TreasuryCap<S>` **by value** and asserts `total_supply == 0`, but the package defines no such coin. `aphotic.md` L419 and `docs/MOVE-PACKAGE.md:466` both specify `Coin<APHOTIC_LP>`; that module was never written. The only `S` in the tree is `APLP`, declared `#[test_only]` in `move/tests/vault_tests.move`, which is not published. | **Blocks the whole runtime object graph**, because everything hangs off the vault id: `batch::create_registry(vault_id, ctx)` needs it, and `NoteTree` · `NullifierSet` · `DenomLadder` · both `BalanceBook`s are **embedded in the `Vault` by value** — they are not separate shared objects. Only `allocate::create` is independent of the vault. Independent of B25 and will bite immediately after it. | **Move agent.** Add a real, publishable LP-share coin module with a one-time witness. |
| **B17** | ~~`vault.move`, `batch.move`, `clearing.move` do not exist.~~ | — | **CLOSED 2026-07-26.** All three exist; `sui move test` is **`Total tests: 275; passed: 275; failed: 0`**, `sui move build` clean with zero warnings. Superseded by **B25** — the code is written and green, and is rejected by the chain for an unrelated reason. |
| **B18** | **`sdk/` does not exist.** | Blocks `P3.batch` and `P3.clearing` from being written correctly: the Seal identity encoding and the clearing algorithm must have exactly **one** home before a second consumer exists. Writing them twice reintroduces B6 in the one place a divergence is a **release blocker**. | `X.sdk` — do this **before** `P3.batch` |
| **B19** | **The keeper and app still contain the v1 product.** | A green v1 suite could be mistaken for evidence about v2. | `X.keeper`, `X.app` |
| ~~**B11**~~ | `scripts/register-deposit.ps1` hardcoded two Hashi ids ⇒ the `ids` gate failed. | — | **CLOSED at 02:13 by commit `72b12bb`** (not by me, and not verified by a run of mine). The ids now resolve process env → `keeper/.env` → `keeper/src/config.ts`, provenance is printed, and a self-test asserts neither watched prefix appears in the file so it cannot silently regress. |
| ~~**B14**~~ | `scripts/verify-all.ps1` did not run `cd app && npm test`. | — | **CLOSED at 02:13 by the same commit**; `verify-all.ps1` went 8 → 12 steps. |
| **B23** | **NEW, surfaced by closing B14.** Running the app suite under the master gate exposed **7 app tests still asserting v1 `gateway` error constants** that the pivot deleted. That regression was invisible to the master gate until 02:13. | The app suite is red. | `X.app` |
| **B8** | `move/Move.lock` records Windows backslash subdirs. | Cross-platform builds. | low priority |
| **B15** | `oracle.move`'s `@facts` records the old limiter prior (`1_000` / `100_000_000`). | **Not a code bug** — it is correctly labelled *"a BOUND, not a fact"* and values arrive as arguments. But a reader could take it for the live scalars, which are `115_740` / `10_000_000_000`. | update the banner |
| **B16** | `carry.move`'s banner says the three guard predicates are *"REAL and tested"*, but **no `carry_tests.move` exists**. | An unverified DONE-ish claim. | write `carry_tests.move` or soften the banner |
| ~~**B20**~~ | The gates did not enforce the v2 invariants. | — | **CLOSED at 02:13.** Five gates added — `notes`, `batchstate`, `keepercap`, `send`, `seal_le` — each proved against a **deliberately-violating** fixture tree *and* a compliant one, in both shells. That exercise found a real hole: `g2` passed a function taking `bitcoin_address: vector<u8>`, because a word-bounded `address` test misses the underscore — **the gate guarding the most important invariant did not work.** `g2`'s destination test is now strictly broader than `keepercap`'s. `g2`/`g4` were repurposed rather than removed; `g7`'s Hashi-boundary target is now `carry.move`. |
| **B21** | The **5 000 000-unit computation cap is still unmeasured.** `scripts/measure-clearing.mjs` now exists and ran, but its report says **"NOTHING WAS MEASURED"** — the published package exposes no `clearing` module. | `MAX_BATCH_SIZE = 256` is a **reasoned** default, not a measured one. If `price_step` at 256 exceeds 3 500 000, the API must already support splitting into `price_scan_step` + `alloc_step`. | re-run `X.measure` **after `clearing.move` lands and is published**, then re-copy `scripts/LIMITS.generated.md` → `docs/LIMITS.md` |
| **B24** | 4 of the 13 gates report **SKIP** — their target modules (`batch`, and the keeper modules) have not landed. Each SKIP states what was not checked and why, and SKIP is counted separately from PASS. | **A SKIP is not green.** The gate guarding the LE/BE Seal trap (`seal_le`) is one of them. | resolves itself with `P3.batch` and `X.keeper` |
| **B22** | Task-id schemes in file banners are inconsistent (`T1.1` vs `P1.allocate`). | Cosmetic; the census greps must accept both. | `X.banners`, low priority |

### Not blockers — deliberate, and settled

| Item | Why it is not a blocker |
|---|---|
| Phase 2 (the carry) is unimplemented | `aphotic.md` §11 says not to attempt it in this window; D2 (empty book, no mintable inventory), D3 (no lending market) and D6 all agree independently. `carry.move` ships as a compiling, guarded interface. |
| The `hBTC/DBUSDC` book is empty on both sides | We can mint neither leg — `treasury::mint` is `public(package)` and the DBUSDC `TreasuryCap` is `AddressOwner`. Handled as a **defined state**: every book read goes through `get_level2_range`, and `approve_nav`'s deviation check must tolerate "no mid exists". |
| The hBTC lending counterparty is ours | No hBTC lending market exists on Sui testnet. Deployed and **disclosed on-chain** rather than mocked. |
| v1 note spends are linkable | v1 delivers uniformity, not unlinkability. Published, not hidden. |

---

## 8. Documentation state (this pass, 2026-07-26)

| File | Action taken |
|---|---|
| `CLAUDE.md` | **rewritten** for v2 — project summary, read order, repo map, ten new golden rules, build commands, cut line, scope notes |
| `docs/FACTS.md` | **rewritten** — added the ceilings table, the Seal identity byte layout, the cadence constants, the ladder, the clearing rules, the O(1) `approve_nav`, the keeper-callable list, the lending section; removed everything describing the v1 router/gateway |
| `docs/ARCHITECTURE.md` | **rewritten** — new component map, capability graph, four flows, trust-boundary table, the four honesty boundaries |
| `docs/MOVE-PACKAGE.md` | **rewritten** for the ten modules, with an explicit "the code and its tests win over this document" clause |
| `docs/BUILD-PLAN.md` | **rewritten** — phases 0–4 plus cross-cutting units, the CUT LINE, standing prohibitions |
| `docs/GOVERNANCE.md` | **moved** from `aphotic-governance.md` (`git mv`), body unchanged, **§9 Deviations of record added** (D-G1 escrow out of NAV · D-G2 TypeScript keeper · D-G3 push not claim · D-G4 pause asymmetry · D-G5 the disclosures · D-G6 §8 open items) |
| `docs/STATUS.md` | **rewritten** — this file |
| `docs/DEMO.md` | **rewritten** for v2 |
| `docs/DEPLOYED.md` | **appended** — a v2 section; no existing row overwritten |
| `docs/CONVENTIONS.md` | **updated** — v2 example, new gate names, `sdk/` added to the id homes |
| `docs/DEPLOY.md` | **updated** where the pivot changes it (routes, Walrus publisher, Seal server configs, the `sdk/` alias) |
| `docs/LIMITS.md` | **created** — copied verbatim from `scripts/LIMITS.generated.md`, whose own header asks the `docs/` owner to do exactly that |
| `docs/DESIGN-V2.md`, `docs/RECON.md` | **untouched, by instruction.** See §9 |
| `docs/GOLDEN-RULES.md`, `docs/KEEPER.md`, `docs/APP.md`, `docs/ULTRACODE-BRIEF.md` | **deleted** — they described only the dead product |
| `docs/DAY-ONE.md`, `docs/DAY-ONE-RESULTS.md` | **banner-marked superseded / archived.** RESULTS is still the `[D<n>]` evidence behind FACTS and RECON |

---

## 9. The RECON R9 erratum — already fixed, no edit made

`docs/DESIGN-V2.md` D12 lists as outstanding: *"RECON R9 rows #1 and #7 print `105_000` where the
algorithm and both shipped twins say `100_150` — the doc is wrong, the tests are right; fix the
doc."*

**It has already been fixed.** `docs/RECON.md` R9's table prints **`100_150`** in both rows, and
`RECON.md:150` carries a clearly-labelled `ERRATUM (fixed 2026-07-25, verification pass)` note
explaining the correction, the arithmetic (`min(2_000_000, 100_000 + 15 × 10)`), the upstream SDK
cross-check, and that rows #2–#6 were always correct.

**No edit was made to RECON in this pass**, and none is needed. `docs/DESIGN-V2.md` D12's third
bullet is stale — recorded here rather than edited into DESIGN-V2, which is read-only for this pass.

---

## 10. Where old-product text still survives outside `docs/`

Found while sweeping. Rows marked **CLOSED** were fixed by the dead-code sweep of 2026-07-26;
the rest are still open and are owned by other agents or are historical.

| Location | What survives | State |
|---|---|---|
| ~~`HASHI_INTEGRATION.md`, `README (8).md`, `BTC_FIXED_INCOME.md` (root)~~ | the entire v1 design, plus a shelved alternative that was never built | **CLOSED — deleted.** `HASHI_INTEGRATION.md` was audited claim-by-claim against RECON + FACTS first: a strict subset except two facts (**sanctions screening in `approve_deposit`**, **Hashi is pre-1.0**), both transplanted into `docs/FACTS.md#hbtc` / `#latencies`. It also *contradicted* the live docs in five places, which is why a SUPERSEDED banner was judged insufficient. Recoverable from git. |
| ~~`README.md` (root)~~ | pitched "The Bitcoin Dark Vault" and linked four deleted docs | **CLOSED — rewritten** for the redemption-carry vault + sealed-order batch auction; leads with the public `WithdrawalRequestQueue` leak and why uniform-price clearing makes front-running *meaningless* rather than merely hard |
| ~~`move/Move.toml` header comments~~ | cited `envelope::check_action` and `aphotic::vault::seal_approve` | **CLOSED** — now cite `vault::approve_nav` and `aphotic::batch::seal_approve`; the id-homes list now matches `docs/CONVENTIONS.md` §2.6. **Dependency table untouched.** |
| ~~`scripts/gates.{ps1,sh}` banners~~ | `@spec docs/GOLDEN-RULES.md`, deleted | **CLOSED** — retargeted to `CLAUDE.md` "THE 10 GOLDEN RULES" + `docs/CONVENTIONS.md` §2.6/§6, and the `@rules` lines re-mapped to the **v2** rule numbers (the numbers were reassigned in the pivot, so the old `G2 G4 G5 G7` meant something else). No gate logic or verdict changed. |
| ~~`scripts/*.ps1` / `*.mjs` banners generally~~ | v1 task ids and v1 doc anchors | **CLOSED** — `check-enoki.mjs`, `verify-onchain.mjs`, `seed-book.{mjs,ps1}`, `register-deposit.ps1`, `verify-all.ps1` all retargeted to live anchors; dead `T<n>.<m>` ids replaced with `ops — no BUILD-PLAN unit id` |
| `keeper/src/{strategy,routing,execution,journal,privacy,storage,verify}/` | the entire v1 keeper. Three files still cite the now-deleted root docs: `privacy/rotation.ts:9` and `strategy/params.ts:7` cite `"README (8).md"`, `routing/route.ts:11` cites it too, and `strategy/pegflow.ts:7` cites `HASHI_INTEGRATION.md §3`. Those pointers are now **dangling**. | open — `X.keeper` |
| `keeper/test/*`, `keeper/vitest.config.ts`, `sdk/src/rng.ts` | ~30 banner lines citing the deleted `docs/KEEPER.md`, plus `docs/ULTRACODE-BRIEF.md` in `keeper/test/hashi.real.test.ts:7` and `docs/GOLDEN-RULES.md` in `keeper/src/verify/limiter.ts:6` and `keeper/test/limiter.{cross,consume}.test.ts` | open — `X.keeper` / `X.sdk` |
| `app/**` | banner debris citing `docs/APP.md` / `docs/GOLDEN-RULES.md` and v1 `A<n>` / `T<n>.<m>` ids; `app/probe-l2.mjs` is a v1 DeepBook L2 probe referenced by nothing; `app/test/tx.test.ts:89` hardcodes a Hashi package id and is the sole cause of the **`ids` gate FAIL** | open — owned by the app agent |
| `move/tests/mock_hashi.move` | a v1 bridge stand-in; still unreviewed for v2 relevance | open |
