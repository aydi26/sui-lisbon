# Aphotic

**A redemption-carry vault and a sealed-order batch auction for `hBTC`, on Sui.**

ETHGlobal Lisbon 2026 · Sui track. Sui **testnet**, Bitcoin **signet**. Not audited, not for mainnet funds.

> **Judges:** [`docs/SUBMISSION.md`](docs/SUBMISSION.md) is the summary — problem, mechanism, what is
> deployed, what is verified, and the limitations. [`docs/DEMO.md`](docs/DEMO.md) is the runbook.

---

## The leak we exist to route around

[Hashi](https://github.com/MystenLabs/hashi) is MystenLabs' native-BTC orchestrator: send BTC, receive `hBTC` on Sui; burn `hBTC`, get BTC back. The return leg runs through a **`WithdrawalRequestQueue`** — and that queue is a **public Move object**. Every pending request in it exposes:

| Field | What it tells an observer |
|---|---|
| `sender` | *who* is leaving |
| `btc_amount` | *how much* |
| `bitcoin_address` | *where to* |
| `created_timestamp_ms` | *when they decided* |

Nothing is hidden and nothing needs to be decoded. A desk unwinding a position is **watched forming in real time**, request by request, before a single satoshi has moved on Bitcoin — and it stays visible for the ~1.5–2 hours the withdrawal takes to confirm. That is not a hypothetical: `node scripts/verify-onchain.mjs` pulls the live stream and, on 2026-07-26, printed 25 real `WithdrawalRequested` / `WithdrawalApproved` rows with a latest timestamp of `2026-07-26T05:07:09.822Z`.

Exiting is also queued and rate-limited, so `hBTC` trades below par. The discount is the market price of that latency.

**Aphotic crosses that flow before it reaches the queue.**

Two strategies share one balance sheet:

1. **The redemption-carry vault** — buy `hBTC` below par from someone who wants out *now*, redeem it one-for-one through the queue ourselves, and capture the spread. The seller gets immediacy without broadcasting their exit; we get the carry for absorbing the wait. Idle capital is lent between carries.
2. **The sealed-order batch auction** — orders are Seal-encrypted **client-side** under a time-lock policy, so nothing is readable before the batch closes. Clearing is computed **on-chain in Move**, deterministically, on a frozen order set, at a **uniform price**, twice daily at **06:00 / 18:00 UTC**.

### Why uniform-price clearing, specifically

Uniform-price clearing does not make front-running *hard*. It makes it **meaningless**.

Everyone in a batch executes at **the same price at the same instant**. There is no queue position to buy, no ordering to bribe, no first-mover edge to extract — because "first" is not a thing a batch has. Sequencing advantage is not defended against; it is **removed from the design**. The time-lock stops you *reading* the batch early; the uniform price makes reading it early worthless anyway.

That only holds if nobody can pick the moment. So `close_ms` is **derived** — `next_boundary(now, 12 h, 6 h)` — and `open_batch` takes no timestamp parameter at all. A *full* batch does not close early either; it rejects further submits and still closes on the boundary, because closing on fullness would hand a spammer exactly the timing lever the design exists to remove.

Escrow runs through **fixed-denomination notes** — `0.01 / 0.1 / 1 / 10` hBTC — over a Merkle commitment tree with nullifiers, so escrow leaks no size. A `Balance<BTC>` carries a publicly readable amount, so encrypting the order would be pointless otherwise. `struct Note` declares `id` and `denom_index` and nothing else: the amount is not hidden, it is **absent**.

The vault ships first, because it does not need two-sided flow. The auction is the differentiator, but it needs a market.

---

## Honesty, on the record

These are load-bearing, not disclaimers. They appear in the product UI as well as here, and the full list with the reasoning is [`docs/SUBMISSION.md` §6](docs/SUBMISSION.md).

- **`hBTC` is custodial-threshold wrapped BTC.** Threshold Schnorr across an opt-in stake-weighted validator subset, 2-of-2 with a Guardian enclave, a ~60-day recovery leaf. There is no light client. Aphotic inherits **every one** of Hashi's trust assumptions. Our differentiation is composing the bridge's on-chain machinery — never the token's trust model.
- **v1 note spends are LINKABLE.** The Merkle path is supplied in the clear, so the leaf index names the note. v1 delivers **uniformity, not unlinkability**; privacy comes from the crowd, not from the ladder. Unlinkability needs the Groth16 membership proof, which is Phase 4 and is not built.
- **We deployed the `hBTC` lending counterparty ourselves**, because none exists on Sui testnet — Suilend, Navi and Scallop have no testnet deployment at all. Its APY is *ours*, not a market rate, and `disclosure()` returns that admission **on-chain**.
- **Validator collusion: protocol floor 7, live testnet today 32.** Always both numbers, always labelled. Measured 2026-07-26: 112 active validators, total voting power 10 000, and 32 of them taken largest-first to reach the 6 667 quorum.
- **The carry is not executed in this version.** The DeepBook `hBTC/DBUSDC` book is empty on both sides — `mid_price` aborts `EEmptyOrderbook` — and we can mint neither leg. There is nothing to buy and no observable price, so `carry.move` ships as a compiling, guarded interface and the carry is not mimed.
- **If the spread vanishes, the venue is worth little.** A generously-sized Guardian bucket means the queue clears in minutes and there is no discount. Aphotic is closer to **congestion insurance** than to a bridge, and should be judged as such.
- **The redemption leg is gated at signing, not by Move.** `request_withdrawal` sets `sender: ctx.sender()`, the transaction *signer*, never the calling module — so a shared object can never hold a queue position. A Sui **2-of-2 multisig** (keeper + independent policy co-signer) gates it instead. Move cannot enforce this one boundary and we say so rather than implying otherwise.
- **Aphotic is not trustless.** It is no less trustworthy than the venue it serves. That is the honest bar.

---

## What is real, what is designed

| | State |
|---|---|
| Move package `aphotic` — 10 modules, 275 tests | **PUBLISHED AND LIVE.** package `0xfa214c431cee927137422f042ed679eb6180c226d30fa3e98c6bea9e09597df2` (published-at == original-id, fresh publish, digest `DLW43Kvc8czoiWAfxWXomuHXmT7Cuysp5bSnkmsHBuhH`) · shared `Vault` `0x91660fb483ec6c8ee4f9c2b4be04872b5808955fdcda962b5be5905989b3efcf` · shared `BatchRegistry` `0x9967881e88d5e22fc790d3b761e8ca55c8fd87d1a07baa11eb4a4352cd356b35`. The first publish attempt WAS rejected — `VMVerificationOrDeserializationError`, because `clearing::Clearing` declared 39 fields against a **32-field verifier cap that `sui move build` never runs**. It was refactored into nested structs, and a second blocker behind it (no LP share coin, so `vault::create` had no `TreasuryCap` to consume) was closed by adding `aphotic_lp.move`. Bisection in `docs/SUBMISSION.md` §5.|
| `aphotic_lending` — our hBTC counterparty | **published and live**: `0x39d038aea02ccc0bd25e97c7f1a715e87dd6ccae19b0bf9ac255379634b6ea8c`, shared `Market` `0x220ba0e5…` (isv `953314524`), publish tx `3PCybDwuxCCxEace2zSrNutPRSNvEKAazPZjbKPTqnJZ`. Live and empty — we cannot mint hBTC. |
| `sdk/` clearing · Merkle · Seal identity · limiter | **written and green**, 376 tests, 46 shared golden fixtures |
| Move ↔ TypeScript clearing parity | **FAILS, and we found it ourselves.** The TypeScript, the fixtures and the Rust spec engine all agree; **Move differs**, on 15 % of 4 000 seeded books. Five named divergences with hand-derived counterexamples in `clearing-rs/tests/divergence.rs` and `docs/DESIGN-V2.md` §5ter. The worst is structural: the two fill-leaf layouts are 73 and 81 bytes, so the Merkle roots can **never** match. This is the release blocker `aphotic.md` §9 says it is, and it is open. |
| Move ↔ TypeScript parity **L3** (`devInspect`, BCS byte-for-byte) | **owed** — it needs the package published, and §5ter resolved first |
| `MAX_BATCH_SIZE = 256` | a **reasoned** default, not a measured one. `scripts/measure-clearing.mjs` ran and reported *"NOTHING WAS MEASURED"* against a package that predates `clearing`. |
| Keeper CLI | **all 10 commands run**, 252 tests. Every test is offline against a fake client: the PTB shapes, decoders and local refusals are pinned; the wire behaviour against a real node is not. |
| `clearing-rs/` (Rust clearing twin) | **built and green — 79 tests.** Two engines on purpose: one reproducing the deployed `clearing.move`, one reproducing the spec. A single engine could not have found the divergence above. `sim/` is standalone — Hashi's UTXO simulator is not in this repo, so the fragmentation leg is parameterised, not calibrated, and every emitted file says `"calibrated_against_hashi_sim": false`. |
| The carry (Phase 2) | **not built**, deliberately — see above |
| BTC in / BTC out on signet | **real but never live-demoable**: ~70 min in, ~1.5–2 h out. Pre-staged. |

Two blockers stand between the tree and a deployment, both diagnosed and both single-file. `Clearing`
must lose seven fields to reach the 32-field cap — nested `has store` structs cost one field each and
do not inherit the parent's count. And `vault::create` consumes a `TreasuryCap<S>` while the package
**defines no LP share coin**, so no `Vault` can be created; the only `S` that exists is `#[test_only]`.
Neither is a design problem, and finding the second one corrected our own architecture doc: the app
needs **three** shared objects, not the seven we had listed.

⚠ `vault::Vault` declares **31** fields — one under the same cap. Adding two breaks the publish the
same way, with the same uninformative error.

`docs/STATUS.md` carries the per-unit ledger and the open blockers. **Do not quote a number from this README as evidence of a run** — run the command.

---

## Repo map

| Path | What |
|---|---|
| `move/` | Move 2024 package **`aphotic`** — `events` `caps` `notes` `balance` `allocate` `oracle` `carry` `vault` `batch` `clearing`. Tests at the package root in `move/tests/`. |
| `lending/` | A **second** Move package, `aphotic_lending` — our own `hBTC` lending counterparty, with the honesty disclosure returned on-chain. Published. |
| `sdk/` | The single home of every algorithm that must be byte-identical across languages: clearing, the Merkle tree, the Seal inner id, the limiter. A second copy anywhere is the bug. |
| `keeper/` | TypeScript, one process. Proposes NAV, cranks the schedule — and holds **no discretion**. |
| `clearing-rs/` | The offline Rust clearing twin — **two** engines, one per candidate algorithm, plus `sim/`. 79 tests. ⚠ `cargo` is installed but not on the default PATH: `export PATH="$HOME/.cargo/bin:$PATH"`. |
| `app/` | React 19 + Vite 6 — `/` landing, `/vault`, `/batch`, `/verify`, plus its own fully offline vitest suite. |
| `scripts/` | `gates.{ps1,sh}` (12 invariant gates), `verify-all.ps1` (master gate, 12 steps), `verify-onchain.mjs` (live testnet assertions), `measure-clearing.mjs`, `register-deposit.ps1`, `seed-book.mjs`, `check-enoki.mjs`. |
| `docs/` | All specifications. See the read order below. |

**Canonical on-chain ids may appear only in** `move/Move.toml`, `lending/Move.toml`, `keeper/src/config.ts`, `app/src/config.ts`, `sdk/src/config.ts` and the `.env.example` files. Everywhere else they arrive as config — the `ids` gate enforces it.

---

## Quickstart

Prereqs: `sui` **1.76.0** (`sui client active-env` = `testnet`, gas-funded), Node **≥ 18** (tested on 24.13.0 / npm 11.6.2).

⚠ `sui` is not reliably on `PATH` in agent shells. On Windows: `$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"`.
⚠ The Move test filter is **positional** — `sui move test batch`. `--filter` is not a flag in 1.76.0.
⚠ On Windows, never rewrite a `.move` or `.toml` file with PowerShell `Set-Content -Encoding utf8` — PS 5.1 writes a UTF-8 BOM and the Move compiler rejects it (`E01001`).

```bash
# Move package                                    measured 2026-07-26
cd move    && sui move build && sui move test   # 275 tests, 275 passed, 0 failed
cd move    && sui move test batch               # per-module, positional filter (45)

# The lending counterparty — a second, published package
cd lending && sui move build && sui move test   # 37 tests, 37 passed, 0 failed

# The shared algorithms
cd sdk     && npm install && npm test           # 15 files · 376 tests

# Keeper (ESM, "type": "module")
cd keeper  && npm install && npm run typecheck && npm run build && npm test   # 16 files · 252 tests

# App (React 19 + Vite 6)
cd app     && npm install && npm run build      # tsc --noEmit && vite build
cd app     && npm test                          # 12 files · 157 tests, fully offline
cd app     && npm run dev                       # http://localhost:5173
```

```bash
# The Rust clearing twin — cargo is installed but NOT on the default PATH here
export PATH="$HOME/.cargo/bin:$PATH"
cd clearing-rs && cargo test                    # 79 passed, 0 failed
```

**275 Move + 37 lending + 376 SDK + 252 keeper + 157 app + 79 Rust = 1 176 tests**, all green on
2026-07-26, plus 12 structural gates that agree verdict-for-verdict across both shells.

Copy `keeper/.env.example` → `keeper/.env` and `app/.env.example` → `app/.env`. `keeper/.env` is gitignored and is the **only** file that may ever hold a private key.

**Everything builds and tests offline.** The whole Hashi surface sits behind an adapter with a deterministic mock — no wall clock, no sockets — so no live bridge is needed to get a green suite.

Three things you can run in thirty seconds that are the pitch, not a demo of it:

```bash
cd keeper && node dist/index.js schedule        # the cadence, derived — never chosen
cd keeper && node dist/index.js seal-id --batch 0x…abc --close-ms 1785045600000 --policy-version 1
cd keeper && node dist/index.js clear < orders.json   # uniform-price clearing, locally
```

---

## VERIFY

```bash
powershell -NoProfile -File scripts/verify-all.ps1   # the master gate — 12 PASS · 0 FAIL · 0 SKIP
bash scripts/gates.sh                                # 12 PASS · 0 FAIL · 0 SKIP
powershell -NoProfile -File scripts/gates.ps1        # must agree, verdict for verdict
node scripts/verify-onchain.mjs                      # 28 PASS · 0 FAIL · 0 WARN · 4 INFO (needs network)
```

The gates are the interesting part, because each one guards an invariant that a comment cannot:

| Gate | Proves |
|---|---|
| `keepercap` | no `KeeperCap`-gated function takes an `address` parameter — **the keeper cannot name a destination**, structurally |
| `notes` | `struct Note` declares only `id` and `denom_index`, so no amount can leak |
| `seal_le` | the Seal identity is decoded **little-endian** — a big-endian decode yields a policy that never opens, *silently* |
| `batchstate` | `.state =` appears only in `set_state` / `open_batch`, so transitions stay monotonic |
| `send` | `signAndExecute` lives in exactly one file, so a revert is never broadcast |
| `ids` | no canonical on-chain id is hardcoded outside its declared homes |
| `purity` | no `Date.now()` / `Math.random()` in code that must be deterministic |
| `transport` | the Sui client is constructed in exactly one place per package |
| `g7` · `g4` · `g2` · `sdk` | the Hashi boundary, the venue, the exit-destination rule, the adapter boundary |

**A SKIP is not a PASS.** The runner counts them separately, and every SKIP states what was *not* checked and why — a gate must never look green because the thing it protects has not been written yet.

---

## Doc read order

1. **[`docs/SUBMISSION.md`](docs/SUBMISSION.md)** — the judge-facing summary: problem, mechanism, what is deployed, how to verify it independently, the limitations, what comes next.
2. **`aphotic.md`** — the spec of record. §2 hard constraints, §3 rejected designs (settled — do not relitigate), §10 invariants, §11 build sequence, §13 known limitations, **§22 the naming rule**.
3. **`docs/GOVERNANCE.md`** — capabilities, the two-**party** NAV split, the one custody boundary Move cannot enforce, fees, and §9 deviations of record.
4. **`docs/DESIGN-V2.md`** — the reconciliation reference. **Read-only.** The three findings that changed the design, the measured ceilings, the exact `seal_approve`, the clearing rules, decisions D1–D12.
5. **`docs/RECON.md`** — verified ground truth R1–R14 from live probes. **Read-only. Never re-derive anything in it; where it contradicts another doc, RECON wins.**
6. **`docs/FACTS.md`** — canonical ids, types, signatures, the ceilings table, the Seal identity byte layout, cadence, the ladder, the limiter, events, venue reality, unknowns.
7. **`docs/ARCHITECTURE.md`** — component map, capability graph, the flows, the trust-boundary table.
8. **`docs/MOVE-PACKAGE.md`** — the build-exact spec for the Move modules.
9. **`docs/CONVENTIONS.md`** — the APHOTIC CONTRACT banner every source file carries.
10. **`docs/BUILD-PLAN.md`** — ordered work units, acceptance criteria, VERIFY commands, the CUT LINE.
11. **`docs/STATUS.md`** — what is done, what is not, what was actually observed.
12. **[`docs/DEMO.md`](docs/DEMO.md)** (the runbook and the fallback) · **`docs/DEPLOYED.md`** (append-only on-chain receipts) · **`docs/DEPLOY.md`** (shipping `app/` to Vercel) · **`docs/LIMITS.md`** (generated).

`CLAUDE.md` is the coding-agent entrypoint and carries the conflict-resolution order and the golden rules.

**Archive, not instructions:** `docs/DAY-ONE.md` and `docs/DAY-ONE-RESULTS.md` are the v1 pre-code verification checklist and its execution record. The plan is superseded; **RESULTS is still the receipt** behind every `[D<n>]` citation in `FACTS.md` and `RECON.md`.

---

## License

Apache-2.0
