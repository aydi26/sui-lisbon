# CLAUDE.md — Aphotic

> Coding-agent entrypoint. Auto-loaded every session. High-signal only.
> Facts of record live in `docs/FACTS.md` — never re-derive an ID, a type or a signature; cite it by anchor.
>
> **⚠ THE PRODUCT PIVOTED ON 2026-07-26.** If you have seen this repo before: the private
> market-making vault that quoted `hBTC/DBUSDC` on DeepBook **is dead**. `gateway.move`,
> `router.move`, `journal.move` and the v1 `vault.move` are gone, and so are
> `keeper/src/{strategy,routing,execution,journal}`. Anything that describes a maker/IOC router,
> a `TradeCap`-only keeper, a `btc_exit_address` pinned at deposit, or a Seal-encrypted *strategy*
> is describing the **old** product. Do not implement it. See "SUPERSEDED" below.

## Project (4 sentences)

Aphotic is **two strategies sharing one balance sheet**: a **redemption-carry vault** that buys
`hBTC` below par, redeems it one-for-one through the Hashi withdrawal queue and captures the
spread — lending idle capital between carries — and a **sealed-order batch auction** that clears
`hBTC` at a uniform price twice daily, with orders Seal-encrypted client-side under a time-lock
policy so nothing is readable before the batch closes. The clearing is computed **on-chain in
Move**, deterministically, on a fixed order set; escrow runs through **fixed-denomination notes**
with a Merkle commitment tree and nullifiers, so escrow leaks no size; vault semantics are async
request/settle, and NAV is **proposed by the keeper and approved by an admin multisig** — a
two-**party** split, not two-scope. The differentiator is the leak Aphotic exists to route around:
Hashi's `WithdrawalRequestQueue` is a **public Move object** whose every pending request exposes
`sender`, `btc_amount`, `bitcoin_address` and `created_timestamp_ms`, so a desk unwinding is
watched forming in real time — Aphotic crosses that flow **before** it reaches the queue. The
vault ships first because it does not depend on two-sided flow; the auction is the differentiator
but needs a market.

## READ ORDER (a fresh coding agent reads these, in order)

1. **`aphotic.md`** — **the spec of record.** Read all of it, and specifically §2 hard constraints,
   §3 rejected designs (settled — do not relitigate), §5 module layout, §7 mechanisms, §10
   invariants, §11 build sequence, §13 known limitations, and **§22 the naming rule** (below).
2. **`docs/GOVERNANCE.md`** — the operations note: capabilities, the two-party NAV split, the one
   custody boundary Move cannot enforce, the confidential-clearing section, fees. Carries a
   **DEVIATIONS** section recording where the build knowingly differs from it.
3. **`docs/DESIGN-V2.md`** — **the reconciliation reference. DO NOT EDIT.** Three findings that
   change the design (F1 the Seal endianness trap, F2 no sender check, F3 escrow out of NAV), the
   measured ceilings, the exact `seal_approve`, the clearing rules, the O(1) `approve_nav`, the
   complete keeper-callable list, decisions D1–D12, and every §10 invariant as a named test.
4. **`docs/RECON.md`** — **VERIFIED GROUND TRUTH from live reconnaissance. DO NOT EDIT.**
   R1–R14: transport, toolchain, Move deps, on-chain ids, live Hashi config, the Hashi Move
   surface, event names, the exact limiter algorithm, DeepBook reality, Pyth, npm versions,
   deposit registration. **Never re-derive anything in it. Where it contradicts another doc,
   RECON wins.**
5. **`docs/FACTS.md`** — canonical single source of truth: ids, coin types, signatures, the
   ceilings table, the Seal identity byte layout, the cadence constants, the denomination ladder,
   the limiter, Pyth, events, venue reality, unknowns.
6. **`docs/ARCHITECTURE.md`** — component map, object/capability graph, the flows, and the
   trust-boundary table (precisely what the keeper can and cannot do).
7. **`docs/MOVE-PACKAGE.md`** — the build-exact spec for the ten Move modules.
8. **`docs/CONVENTIONS.md`** — the APHOTIC CONTRACT banner every source file carries, and the
   progress-census greps. Follow the grammar exactly.
9. **`docs/BUILD-PLAN.md`** — the ordered work units with acceptance criteria and VERIFY commands,
   and the CUT LINE.
10. **`docs/STATUS.md`** — the per-unit ledger: DONE vs IN FLIGHT vs NOT STARTED, what was actually
    observed and when, and the known blockers.
11. **`docs/DEPLOYED.md`** — what we published on testnet. **Never overwrite a row — add one**, so
    old journal entries and digests stay resolvable.
12. **`docs/DEMO.md`** — the runbook, the live-vs-pre-staged boundary, the fallback, the never-say
    list.
13. **`docs/DEPLOY.md`** — shipping `app/` to Vercel: the `VITE_*` build-time inlining trap and the
    Enoki/Google origin registration.

> **Conflict resolution.**
> - On **what the world is** (ids, upstream signatures, on-chain config, byte orders): `docs/RECON.md` wins, then `docs/FACTS.md`.
> - On **what we are building and why**: `aphotic.md` wins, then `docs/GOVERNANCE.md`.
> - On **deltas, traps and already-taken decisions**: `docs/DESIGN-V2.md` wins over the layer docs. Where it contradicts a module that was already written, resolve it **explicitly and in writing** — never silently.
> - On **what the code actually does**: the shipped code and its passing tests win over every document, and the document must then be corrected. The documents still win on what the code *should* do; when the two disagree, one of them is a bug — say which.

### ⚠ SUPERSEDED — the v1 product. Read only as history; never implement.

| File | What it is |
|---|---|
| ~~`HASHI_INTEGRATION.md`~~ | The v1 "Bitcoin Dark Vault" design. **DELETED 2026-07-26.** Its Hashi content was audited claim-by-claim against `docs/RECON.md` + `docs/FACTS.md`, which are a strict superset of it — and which **contradict** it in five places (event names, the `@mysten/hashi` SDK surface, config/queue getter visibility, `cancel_withdrawal`'s sender binding, and the limiter scalars, which it had wrong by ~100×). The only two facts it uniquely held were transplanted into `docs/FACTS.md#hbtc` and `#latencies`: **`approve_deposit` performs sanctions screening**, and **Hashi is pre-1.0 / not production-ready**. Recoverable from git if ever needed. |
| ~~`README (8).md`~~ | The v1 base product design (SUI/USDC lineage). **DELETED 2026-07-26** — no unique ground truth. |
| ~~`BTC_FIXED_INCOME.md`~~ | A shelved alternative ("Meridian" bond) that was never the build. **DELETED 2026-07-26.** |
| `docs/DAY-ONE.md` · `docs/DAY-ONE-RESULTS.md` | The v1 pre-code verification checklist and its execution record. The **plan** is superseded; the **RESULTS are still the receipts** behind the `[D<n>]` citations in `docs/FACTS.md` and `docs/RECON.md`. **Kept deliberately** — read as evidence, not as instructions. |

> Why these three were deleted rather than banner-marked: they are tracked in git, so deletion is
> recoverable, whereas a superseded doc left in the tree is *found by grep* and half-believed. The
> deciding factor was that `HASHI_INTEGRATION.md` was not merely stale but **actively wrong** in
> five load-bearing places; a SUPERSEDED banner does not stop a coding agent from lifting a
> plausible-looking event name out of it.

`docs/GOLDEN-RULES.md`, `docs/KEEPER.md`, `docs/APP.md` and `docs/ULTRACODE-BRIEF.md` **were
deleted** in the pivot. The surviving rules are the ten below.

## THE NAMING RULE — non-negotiable (`aphotic.md` §22)

`aphotic.md` §22 lists five names — two firms, two protocols and one token — that **must never
appear** in this project: not in code, comments, commit messages, documentation, tests, the
front-end, or any external material. **Open §22 and read the list; it is deliberately not repeated
here, because repeating it is itself a violation.** Where an operational pattern needs describing,
describe the **pattern** generically ("the common two-scope keeper pattern", "a single-chain
vault"). This applies to generated content exactly as it applies to hand-written content.

## REPO MAP

### Docs (all under `docs/`)

| File | Purpose | Editable? |
|---|---|---|
| `docs/DESIGN-V2.md` | Reconciliation reference: F1–F3, the ceilings, `seal_approve`, clearing, `approve_nav`, the keeper-callable list, D1–D12, the invariant→test matrix. | **NO** |
| `docs/RECON.md` | Verified ground truth R1–R14. Never re-derive; RECON wins. | **NO** |
| `docs/GOVERNANCE.md` | The operations note (moved from `aphotic-governance.md`) + a **DEVIATIONS** section recording F3/D7 and D1. | yes |
| `docs/FACTS.md` | Canonical ids, types, signatures, ceilings, seal identity layout, cadence, ladder, limiter, events, unknowns. | yes |
| `docs/ARCHITECTURE.md` | Component map, capability graph, the four flows, trust boundaries. | yes |
| `docs/MOVE-PACKAGE.md` | Build-exact spec for the ten modules. The code and its tests win over it. | yes |
| `docs/CONVENTIONS.md` | The APHOTIC CONTRACT banner grammar + progress greps. | yes |
| `docs/BUILD-PLAN.md` | Ordered work units, AC, VERIFY, the CUT LINE. | yes |
| `docs/STATUS.md` | Per-unit ledger + observed run log + blockers. | yes |
| `docs/DEPLOYED.md` | On-chain receipts. **Append-only.** | append |
| `docs/DEMO.md` | The runbook and the fallback. | yes |
| `docs/DEPLOY.md` | Vercel deploy of `app/`. | yes |
| `docs/LIMITS.md` | The measured clearing ceilings. **Generated** — copy `scripts/LIMITS.generated.md` over it; do not hand-edit. Today its Measurements section says *"NOTHING WAS MEASURED"*. | generated |
| `docs/DAY-ONE.md` · `docs/DAY-ONE-RESULTS.md` | v1 archive; RESULTS is still the `[D<n>]` evidence. | archive |

### Source tree — **observed 2026-07-26 01:52 local, mid-build**

Other agents are writing `move/`, `keeper/`, `sdk/`, `app/` and `scripts/` **right now**. This
table is a snapshot, not a contract. `docs/STATUS.md` carries the per-unit detail and the
verbatim run log.

| Path | Purpose | Observed state |
|---|---|---|
| `move/Move.toml` · `move/Move.lock` | Package `aphotic`, `edition = "2024.beta"`. **Exactly two git deps** (`hashi`, `deepbook`) — no `Sui` line, no `[addresses]`, no `[dep-replacements]`, no Pyth, no Seal/Walrus, **no `[environments]`** (sui 1.76.0 rejects overriding system envs). ~~⚠ the lock records Windows backslash subdirs (**B8**).~~ **B8 FIXED 2026-07-26** — both lockfiles now carry forward slashes. The backslash form was not cosmetic: off Windows the resolver reads `crates\sui-framework\packages\move-stdlib` as a literal directory and dies with `Invalid directory`, so **the package did not build at all on macOS or Linux**. Forward slashes work on both. Never let a Windows toolchain rewrite this file back. | present |
| `move/sources/events.move` | Package leaf. One emitter per externally-visible transition; carries the ceilings as `@facts`. | present, `@status DONE` |
| `move/sources/caps.move` | `AdminCap` (key only) · `KeeperCap` (key only) · `VaultCap` (store only) · `CapRegistry`; two-step admin handover, keeper rotation by epoch, action allowlist. | present, `@status DONE` |
| `move/sources/notes.move` | `DenomLadder` · `NoteTree` (depth 20, `filled_subtrees` in-object) · `NullifierSet`; blake2b256 domain-separated; **leaf index LITTLE-ENDIAN**. | present, `@status DONE` |
| `move/sources/balance.move` | `BalanceBook<T>` — the persistent per-participant internal balance and the escrow custodian (**DESIGN-V2 F3/D7**: escrow is NOT vault NAV). | present, `@status DONE` |
| `move/sources/allocate.move` | Pinned lending-adapter allowlist keyed on `(adapter type A, venue ID)`. Leaf: imports no lending package. | present, `@status DONE` |
| `move/sources/oracle.move` | The Guardian limiter replay (`project_capacity`/`consume`), the keeper-attested queue observation, and a wait-time **distribution**. Leaf, no imports. | present, `@status DONE` |
| `move/sources/carry.move` | **Interface only, by design** (D6 / `aphotic.md` §11): the three pure guard predicates are real and tested; there is deliberately **no execution path**. | present, `@status PARTIAL` |
| `move/sources/vault.move` | **NOT PRESENT YET.** Async request/settle, `propose_nav`/`approve_nav`, `committed_supply`, `claim_deposit`/`claim_redeem`, `assert_solvent`. | missing |
| `move/sources/batch.move` | **NOT PRESENT YET.** `BatchRegistry`, the OPEN→SEALED→CLEARING→SETTLED machine, `next_boundary`, `seal_approve`. | missing |
| `move/sources/clearing.move` | **NOT PRESENT YET.** Uniform-price match, cursor-driven `sort_step`/`price_step`/`settle_step`, `fills_root`, `verify_fill`, `compute_for_inspect`. | missing |
| `move/tests/*_tests.move` | Tests live at the **package root**, not `sources/tests/`. Present: `allocate_tests`, `caps_tests`, `oracle_tests`, `mock_hashi`. | 122 tests, all green |
| `lending/` | A **second** Move package, `aphotic_lending` — our own hBTC lending counterparty, because **none exists on testnet** (D3). Its module banner carries the honesty disclosure and `disclosure()` returns it on-chain. | present, `@status DONE` |
| `sdk/` | **NOT PRESENT YET.** The single home of every algorithm that must be byte-identical in three places: clearing, the Merkle tree, the Seal inner id, the limiter (DESIGN-V2 §9). No build step — `"exports": { "./*": "./src/*.ts" }`. | missing |
| `keeper/src/` | TypeScript, one process (D1). **Still contains the v1 directories** `strategy/ routing/ execution/ journal/ privacy/ storage/ verify/` — those are the dead product and are pending deletion. Surviving and still useful: `sui/client.ts` (the one client factory), `hashi/limiter.ts` (the single G-rule limiter), `util/` (incl. the seeded `rng.ts`), `config.ts`. | mid-rewrite |
| `app/src/` | React 19 + Vite 6. **Still the v1 three screens** (deposit / exit / transparency) plus the ported landing page at `/`. Pending rewrite. | mid-rewrite |
| `scripts/gates.{ps1,sh}` | **13 invariant gates** (`g7 g4 g2 ids sdk purity transport notes batchstate keepercap send seal_le todo`), reworked for v2 at 02:13. **8 PASS · 0 FAIL · 4 SKIP** — and **a SKIP is not a PASS**: `batchstate` and `seal_le` guard `batch.move`, which does not exist. | reworked |
| `scripts/verify-all.ps1` | Master gate, 12 steps, now including `app npm test`. | reworked |
| `scripts/verify-onchain.mjs` | Live testnet assertions against ids we depend on. | present |
| `scripts/register-deposit.ps1` | Registers a signet UTXO with Hashi. Reverses the txid for you (R14.2), refuses below 6 confirmations **and when the depth is unknown** (R14.3). Ids now resolve from env/config, so the `ids` gate is **green for the first time**. | present |
| `scripts/measure-clearing.mjs` · `scripts/LIMITS.generated.md` · `docs/LIMITS.md` | devInspects `sort_step`/`price_step` at n ∈ {16…512}, threshold 3 500 000 units. ⚠ **it has measured nothing yet** — the published package exposes no `clearing` module, so `MAX_BATCH_SIZE = 256` is a *reasoned*, not a *measured*, default. | present, unmeasured |

## THE 10 GOLDEN RULES

Enforcement points and the full text of every fact cited here are in `docs/FACTS.md`.

| # | Rule (one line) |
|---|---|
| **G1** | **hBTC is a plain fungible `Coin<BTC>`, 8 decimals, sats — no `DenyCap`, no deny list, no freeze anywhere in the Hashi package.** On-Sui movement is instant. Bitcoin latency exists ONLY at mint (deposit, ~70 min) and burn (withdrawal, ~1.5–2 h), so **the BTC leg is never live-demoable — pre-stage it** and show an earlier confirmed signet tx. You cannot buy priority in the queue: over-capacity is **REJECTED** (`RateLimitExceeded`), never queued. |
| **G2** | **Honesty is a hard requirement, not a tone.** `hBTC` **is** custodial-threshold wrapped BTC. **v1 note spends are LINKABLE** — the Merkle path is public, so the leaf index names the note; v1 delivers **uniformity, not unlinkability**. We **deploy the hBTC lending counterparty ourselves** because none exists on testnet — never present its APY as a market rate. Validator collusion: **protocol floor 7, live testnet today 32 — always both, always labelled.** The native-BTC NAV leg is not Sui-verifiable and is **capped** at the on-Sui claims behind it. And never name the parties in §22. |
| **G3** | **The keeper holds no discretion, and it is enforced structurally.** The complete keeper-callable list is `docs/DESIGN-V2.md` §7 and nothing may be added to it without a written decision. Those functions take **no `address` parameter at all**, so a keeper cannot name a destination — that is the enforcement, not a comment. NAV is **two PARTIES** (`propose_nav` keeper, `approve_nav` admin multisig, digest-bound), never two scopes. |
| **G4** | **Liveness is never a privilege.** `open_batch`, `close_batch`, `reveal_order`, `begin_clearing`, `sort_step`, `price_step`, `settle_step`, `claim_deposit`, `claim_redeem` are **permissionless** — the schedule and the commitments are the authorization. If the keeper is down, anyone finishes the batch. A **paused vault still lets holders leave**: `request_redeem` and `claim_redeem` do not check the pause. |
| **G5** | **Timing is mechanical; an operator can never choose when a batch closes.** `close_ms` is derived by `next_boundary(now, 43_200_000, 21_600_000)` → 06:00 / 18:00 UTC; `open_batch` takes **no timestamp parameter**; `close_batch` reverts before `close_ms` and succeeds at exactly `close_ms`. **A full batch does not close early** — it rejects further submits and still closes on the boundary. `SUBMIT_CUTOFF_MS = 60_000`, `REVEAL_GRACE_MS = 600_000`. |
| **G6** | **The Seal identity is LITTLE-ENDIAN.** `bcs::peel_u64` reads LE; the deleted v1 vault decoded it **big-endian** and would have produced a policy that never opens, **silently**. One file owns the encoding (`sdk/src/seal/identity.ts`); both sides import it; a golden vector pins it in **both** languages — the LE id must open and the **BE encoding of the same timestamp must abort**. `seal_approve` is a non-`public` `entry`, denies **by abort**, mutates nothing, emits nothing, asserts `leftovers.length() == 0` and `policy_version`, and **has NO sender check** (a time-lock must be satisfiable by anyone after `T`, which is what kills grief-by-non-revelation). |
| **G7** | **One implementation of every algorithm that must agree across languages — and clearing must be bit-identical.** `sdk/` owns clearing, the Merkle tree, the Seal inner id and the limiter; a second copy anywhere is the bug (it happened once — blocker B6). Parity is asserted at three levels: shared golden fixtures, a 10 000-case seeded property test, and a `devInspect` byte-for-byte comparison against Move. **A Move↔TS divergence is a release blocker.** The same rule governs Hashi: the entire bridge surface stays behind an adapter with a deterministic mock, and every on-chain id arrives as config — never hardcoded in logic. |
| **G8** | **The batch-size ceiling is store entries and events, not the gas budget.** `object_runtime_max_num_store_entries = 1_000`/tx, `max_num_event_emit = 1_024`, `max_gas_computation_bucket = 5_000_000` — **none can be raised by paying more gas**. `MAX_BATCH_SIZE` is a **governed parameter, default 256**, `HARD_MAX_BATCH_SIZE = 512` asserted in the setter. `sort_step`/`settle_step` take a `budget` and advance an on-chain cursor **from day one** — retrofitting resumption changes the state machine, the events and the tests. `emit_per_fill: bool` is the event escape hatch. **Measure the 5 M cap, do not assume it.** |
| **G9** | **Escrow must not leak order size.** Fixed denominations only — `1_000_000 / 10_000_000 / 100_000_000 / 1_000_000_000` sats — and **no `Note` carries an amount field**. No margin, no reserve and no lock at submit time: a reservation would publish the size, so orders draw on a **persistent internal balance** topped up independently of trading, and `settle_step` **deterministically truncates** an under-funded fill to `min(fill, balance)` from the frozen snapshot. Denominations create **uniformity, not privacy**; privacy comes from the crowd. Denominations are **append-only** — repricing a tier would revalue live notes. |
| **G10** | **Move 2024 edition idioms throughout.** Amounts in sats (`u64`); money is `bigint` in TypeScript and `number` for sats is forbidden. Error constants named `E<Reason>`. Emit an event for every externally-visible state transition. **Integer arithmetic only — no floats anywhere in clearing**, and `u64` add/mul **abort** on overflow, so saturation is emulated explicitly (widen to `u128` before the `min`). |

## BUILD & TEST COMMANDS

⚠ **`sui` is not reliably on `PATH` in agent shells.** Prepend it:
`$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"` (PowerShell) / `export PATH="$LOCALAPPDATA/sui:$PATH"` (bash).

```bash
# ── Move package (from move/) ─────────────────────────────────────────────────
cd move && sui move build          # OBSERVED 2026-07-26 01:52: exit 0, zero warnings
cd move && sui move test           # OBSERVED 2026-07-26 01:52: Total tests: 122; passed: 122; failed: 0
cd move && sui move test caps      # per-module filter
#   ⚠ the filter is POSITIONAL. `--filter` is NOT a flag in sui 1.76.0.
#   ⚠ 122 green covers only the SEVEN modules that exist. vault / batch / clearing are
#     still being written; DESIGN-V2 §10 targets >= 320 Move tests.

# ── The lending counterparty (a SECOND package, from lending/) ────────────────
cd lending && sui move build && sui move test    # not run by this session — see docs/STATUS.md

# ── Keeper (from keeper/) — ESM, "type":"module" ─────────────────────────────
cd keeper && npm install && npm run typecheck && npm run build
cd keeper && npm test
#   ⚠ mid-rewrite. The v1 suites for strategy/routing/execution/journal test deleted product
#     surface; do not treat a v1 green as evidence for v2.

# ── App (from app/) — React 19 + Vite 6 ──────────────────────────────────────
cd app && npm install && npm run build && npm test && npm run dev

# ── Invariant gates (either shell) — 13 gates, identical verdicts in both ────
powershell -NoProfile -File scripts/gates.ps1      # reported 8 PASS / 0 FAIL / 4 SKIP at 02:13
bash scripts/gates.sh                              #   A SKIP IS NOT A PASS.
powershell -NoProfile -File scripts/verify-all.ps1 # master gate, 12 steps (incl. app npm test)

# ── Live testnet assertions (needs network) ──────────────────────────────────
node scripts/verify-onchain.mjs
```

**Everything above that is annotated "OBSERVED" was run in this session and the output is quoted
verbatim. Everything else was not run — do not report an output you did not see.**

**Toolchain of record.** `sui` **1.76.0-6effb4523834** at `%LOCALAPPDATA%\sui\sui.exe`;
`sui client active-env` = `testnet` (chain id `4c78adac`). Node 24.13.0 / npm 11.6.2.
Deployer/keeper address `0xd41b0cd8…f333d`.

**Transport.** `https://fullnode.testnet.sui.io:443` serves **gRPC v2 only — JSON-RPC returns
HTTP 404**; the `sui` CLI speaks gRPC to it and works normally. In code the default client is
`SuiGrpcClient` (`@mysten/sui/grpc`), constructed in exactly **one** place per package
(`keeper/src/sui/client.ts`, `app/src/lib/suiClient.ts`) — enforced by the `transport` gate.
`SuiClient` no longer exists in `@mysten/sui@2.22.1`; `SuiJsonRpcClient` against the mirror
`https://rpc-testnet.suiscan.xyz:443` is for probes only. The Hashi guardian's `/info` requires
**HTTP/2** (HTTP/1.1 → 464).

⚠ **Windows:** never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` — PS 5.1
writes a UTF-8 BOM and the Move compiler rejects it (`E01001`). Use
`[System.IO.File]::WriteAllText` with `New-Object System.Text.UTF8Encoding($false)`.

## CUT LINE (one line)

Minimum demoable product = **`aphotic.md` §11 Phase 1 (the vault: `caps` + `vault` + `allocate`,
deposit → `propose_nav` → `approve_nav` → `claim`) plus a mocked Phase 3 (`notes` + `balance` +
`batch` + `clearing`: Seal-encrypted submit → mechanical close → reveal → on-chain uniform-price
clear → push settlement, with the Move↔TS parity shown live).** Phase 2 (the carry) is
**deliberately out** — `aphotic.md` §11 says so, and D2/D3/D6 each independently confirm it.

**Where we stand — RE-MEASURED 2026-07-26 on macOS, from a fresh clone.** ~~`sui move build` is
green and 122 Move tests pass across the seven modules that exist. `vault.move`, `batch.move` and
`clearing.move` — the three modules the cut line is actually about — **are not written yet**, and
neither is `sdk/`. The keeper and app still contain the v1 product. Nothing about the cut line is
proven today.~~ All ten Move modules exist, are published, and were **upgraded to v2**. Observed:

| | |
|---|---|
| move `aphotic` | **283/283** · `lending` **37/37** · `sdk/` **376/376** · `keeper/` **252/252** · `app/` **345/345** — **1 293 total** |
| gates | `bash scripts/gates.sh` → **12 PASS · 0 FAIL · 0 SKIP** (the four SKIPs are gone) |
| on chain | `node scripts/verify-onchain.mjs` → **35 PASS · 0 FAIL · 0 WARN** (was 34 PASS · 1 FAIL until the keeper rotation below) |
| cut line | **met** — deposit → `propose_nav` → `approve_nav` → claim has run to **epoch 4**, and **batch 0 is open** (closes 18:00:00.000Z, derived not passed) |

**Governance — read this before you touch it.** That FAIL was `admin != keeper`: `Vault.caps.admin`
and `.keeper` were both `0xd41b0cd8…f333d`, so G3's two-party split was **not live**, and no amount
of Move review would have shown it — the bytecode is identical either way. **Closed 2026-07-26** by
`scripts/rotate-keeper.mjs`, digest `3zFxqJeCg1SoLUqsJDievQkCDacskrEevCVgf1zuB7kJ`: keeper is now
`0x883ff254…01125` at `keeper_epoch = 1`, admin unchanged. `propose_nav` must therefore be signed by
the **keeper** address and `approve_nav` by the **admin** — one key can no longer do both, which is
the entire point. Receipts in `docs/DEPLOYED.md § KEEPER ROTATION`.

**The mechanism stays even though the state is now green.** `/vault` READS the `CapRegistry` on
every load and renders whichever state is true (`TwoPartyNote`, `app/test/capSplit.test.tsx` pins
both branches). **Do not replace it with unconditional two-party copy** — the guarantee is a
property of a deployment, not of the code, and the next deployment may not hold it.

## SCOPE NOTES (do not get this wrong)

- **Do not attempt Phase 2 (the carry).** `aphotic.md` §11 is explicit; the `Pool<hBTC,DBUSDC>`
  book is **empty on both sides** and we can mint neither leg (`treasury::mint` is
  `public(package)`; the DBUSDC `TreasuryCap` is `AddressOwner`), so there is nothing to buy and no
  mid to buy it at; and the exit leg needs a 2-of-2 custody multisig, which is an ops project.
  `carry.move` lands as a compiling interface with real, tested guard predicates — nothing more.
- **The one boundary Move cannot enforce.** `request_withdrawal` sets `sender: ctx.sender()`, which
  on Sui is the **transaction signer**, never the calling module. A shared object can therefore
  never hold a queue position, and `cancel_withdrawal` asserts `request_sender() == ctx.sender()`.
  The redemption leg is gated by a **Sui 2-of-2 multisig** (keeper + independent policy co-signer)
  at **signing time, not by Move**. Say so plainly everywhere.
- **Do not put Enoki in the Seal committee.** Enoki is both a zkLogin salt provider and a Seal key
  server; using it for both hands one party identity linkage **and** a decryption share. Committee
  is `n = 5` across **5 distinct operators**, `t = 3` (count operators, not servers). Never fall
  back to plaintext.
- **The "Meridian" fixed-income bond is a shelved alternative. Do not build it.** Its design doc
  (`BTC_FIXED_INCOME.md`) was deleted on 2026-07-26; recover it from git only as the option not
  taken, never as a spec.
- On any conflict, apply the resolution order at the top of this file. If a value is unknown, mark
  it and log the owner; never invent one.
