# BUILD-PLAN.md — ordered, agent-executable task list for the Opus "ultracode" build

Purpose: the exact sequence of TASK units to build Aphotic × Hashi ("The Bitcoin Dark Vault"). Execute top-to-bottom; each task has dependency ids, files, acceptance criteria (AC), and a verification command (VERIFY). Do not reorder across the CUT LINE without cause.
Read after: docs/FACTS.md, docs/DAY-ONE.md, docs/MOVE-PACKAGE.md, docs/KEEPER.md, docs/APP.md.

---

## GOLDEN RULES (never violate — re-read before every task)

| # | Rule |
|---|---|
| G1 | hBTC is a fungible `Coin<BTC>`. On-Sui hBTC movement is INSTANT (one checkpoint). Bitcoin/Guardian latency exists ONLY at mint(deposit)/burn(withdraw). |
| G2 | Keeper holds ONLY DeepBook `TradeCap` — never `WithdrawCap`/`DepositCap`. It can place/cancel orders; it can NEVER move funds out. Exits composed in Move to an on-chain-pinned address. |
| G3 | You CANNOT buy priority in Hashi's global withdrawal queue; over-capacity batches are REJECTED (`RateLimitExceeded`), not queued. Never design around jumping the queue. |
| G4 | No Cetus hBTC pool. Router = DeepBook maker `POST_ONLY` + IOC sweep on the same book. No Cetus taker leg, no CLMM ranges for the BTC vault. |
| G5 | Guardian limiter is TRUSTLESSLY replayable via `project_capacity() = min(cap, tokens + elapsed*refill_rate)` over the `WithdrawalRequested/PickedForProcessing/Signed` event stream. `verify/` re-derives it — NOT a trusted SDK read. |
| G6 | The BTC leg (deposit ~70min, withdraw ~1.5–2h) is NEVER live-demoable. Pre-stage. Sui side is instant. |
| G7 | Isolate ALL Hashi surface behind an adapter interface with a deterministic MOCK from line one (mirror `project_capacity` exactly). On-chain Hashi calls live ONLY in `gateway.move`. All IDs configurable (env/config), never hardcoded in logic. |
| G8 | Honesty: hBTC IS custodial-threshold wrapped BTC. Differentiation = composing the bridge's on-chain machinery, not the token's trust model. |
| G9 | Pin Pyth versions + use the Beta feed on testnet; value collateral/NAV at DeepBook mid (depeg defence); add staleness guards. |
| G10 | Move 2024 edition idioms throughout. Amounts in sats (u64). Emit an event for every externally-visible state transition. Error constants named `E<Reason>`. |

---

## Canonical identifiers (mirror of docs/FACTS.md — pull from config, never inline in logic)

| Key | Value |
|---|---|
| hBTC coin type | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC` |
| Hashi package (testnet) | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360` |
| Hashi shared object (testnet) | `0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8` |
| DeepBook `Pool<hBTC, DBUSDC>` | `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` |
| DBUSDC coin type | `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC` |
| DeepBook callable pkg (testnet) | `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c` |
| Pyth State | `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c` |
| Pyth package | `0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837` |
| Wormhole State | `0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790` |
| BTC/USD feed id | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` (testnet REQUIRES BETA channel — verify via Hermes before hardcoding) |
| Withdrawal min | 30,000 sats · Bitcoin dust floor 546 sats · pinned addr = 20 bytes (P2WPKH) or 32 bytes (P2TR) |

If any value above conflicts with docs/FACTS.md, docs/FACTS.md wins — resolve there.

---

## Toolchain preflight (run before Phase 0; failures block everything)

| Check | VERIFY |
|---|---|
| Sui CLI on testnet | `sui client active-env` prints `testnet`; `sui client active-address` set + gas-funded |
| Node ESM | `node -v` ≥ 18; keeper `package.json` has `"type": "module"` |
| Move 2024 | `Move.toml` `[package]` `edition = "2024.beta"` |

---

# PHASE 0 — Scaffold + Day-One gate

Definition of done: repo builds empty Move package and an ESM keeper + Vite app that both start; the Hashi adapter interface + deterministic mock compile and pass a unit test; every canonical ID is read from config (not literal); docs/DAY-ONE.md checklist executed and its unknowns resolved or logged.

| Task | id | Depends | Files created/edited | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Run day-one gate | T0.1 | — | (none — ops) | Every item in docs/DAY-ONE.md is checked; each UNKNOWN is either resolved and written into docs/FACTS.md or explicitly logged with owner. Faucet drip started (both signet faucets). One manual end-to-end Hashi deposit initiated via testnet.hashi.sui.io to learn real timings. | Manual: docs/DAY-ONE.md fully checked; `sui client objects` shows Hashi/pool IDs resolve on fullnode |
| Move scaffold | T0.2 | — | `move/Move.toml`, `move/sources/vault.move` (empty module `aphotic::vault`) | `sui move new aphotic` layout under `move/`; edition `2024.beta`; package name `aphotic`; builds empty. | `cd move && sui move build` |
| Keeper scaffold | T0.3 | — | `keeper/package.json` (ESM), `keeper/tsconfig.json`, `keeper/src/index.ts`, `keeper/src/config.ts` | ESM TS project; `config.ts` loads ALL canonical IDs from env/`.env` (per docs/FACTS.md); `@mysten/sui` ^2.22.1 + `@mysten/hashi` 0.6.0 pinned in deps; no ID literal anywhere but `config.ts` defaults. | `cd keeper && npm install && npm run build` |
| App scaffold | T0.4 | — | `app/` (React + Vite), `app/src/config.ts` | `npm run dev` serves; three empty routes: `/deposit`, `/exit`, `/transparency`; IDs from env. | `cd app && npm install && npm run build` |
| Hashi adapter interface + MOCK | T0.5 | T0.3 | `keeper/src/hashi/adapter.ts` (interface), `keeper/src/hashi/mock.ts`, `keeper/src/hashi/limiter.ts` (`projectCapacity()`), `keeper/test/hashi.mock.test.ts` | Adapter interface covers: `generateDepositAddress`, `deposit`, `requestWithdrawal`, `cancelWithdrawal`, `view.{balance,depositStatus,withdrawalStatus,all}`, `waitForDeposit`, `waitForWithdrawal`, `guardian.{limiterStatus,canWithdraw}`, and an event stream `subscribeEvents`. MOCK is deterministic (seeded), needs no network, and `limiter.ts` `projectCapacity(tokens, refillRate, cap, elapsedMs) = min(cap, tokens + elapsed*refillRate)` (CANONICAL arg order, per `docs/KEEPER.md` §2.4 — the SAME function imported by mock and `verify/`) matches Hashi `project_capacity` EXACTLY (G5). Real adapter stub throws `NotImplemented`. | `cd keeper && npm run test -- hashi.mock` |
| Config wiring proof | T0.6 | T0.3,T0.4,T0.5 | `keeper/.env.example`, `app/.env.example` | Grepping the codebase for any canonical ID literal returns hits ONLY in `config.ts`/`.env.example` (G7). | `git grep -n 0x5cdaebf264 keeper app` returns only config files |

Cross-ref: docs/FACTS.md (all IDs), docs/DAY-ONE.md (T0.1 items).

---

# PHASE 1 — Move package (mirrors docs/MOVE-PACKAGE.md) — CUT-LINE CRITICAL

Definition of done: `aphotic` package builds and all tests pass; a shared `Vault` over `Coin<BTC>` with sats share math; `gateway::exit_to_bitcoin` composes `hashi::withdraw::request_withdrawal` in one PTB from a per-depositor pinned address; `reclaim_stalled_exit` wraps `cancel_withdrawal`; small-exit pooling below 30,000 sats; keeper holds only `TradeCap`; every state transition emits an event.

| Task | id | Depends | Files | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Vault object + share math | T1.1 | T0.2 | `move/sources/vault.move` | Shared `Vault` generic over asset pair, holds DeepBook `BalanceManager`, strategy ciphertext + Walrus blob id, share ledger in sats (u64). `deposit`/`redeem` share accounting; NAV valued at DeepBook mid (G9). Captures immutable `btc_exit_address: vector<u8>` (20 or 32 bytes) per depositor at first deposit (G2). Error consts `E<Reason>`. Events on deposit/redeem/share-mint. | `cd move && sui move build` |
| `seal_approve` gate | T1.2 | T1.1 | `move/sources/vault.move` | `seal_approve` gates decryption; identity namespaced to vault object + version epoch (rotation/revocation). `rotate_keeper` increments epoch. | `cd move && sui move test` |
| Gateway: register + composed exit | T1.3 | T1.1 | `move/sources/gateway.move` | `register_exit_address` (validates 20/32-byte, immutable-once-set). `exit_to_bitcoin`: burn shares → split `Balance<BTC>` → call `hashi::withdraw::request_withdrawal(hashi, clock, btc, pinned_addr, ctx)` in ONE atomic PTB using the PINNED address (never a caller-supplied one) (G2). Asserts amount ≥ 30,000 sats. Emits `ExitRequested` before the Hashi call. ALL Hashi imports confined to this module (G7). | `cd move && sui move test` |
| Gateway: reclaim + small-exit pool | T1.4 | T1.3 | `move/sources/gateway.move` | `reclaim_stalled_exit` wraps `hashi::withdraw::cancel_withdrawal(...) : Balance<BTC>`, returns balance to vault, re-credits shares (respect 1h cooldown / pre-commit-only). Small-exit pooling: exits < 30,000 sats accumulate in a per-user pending balance until they clear the Hashi minimum or the user opts to take hBTC (G3 — never assume queue priority). | `cd move && sui move test` |
| Router: maker + IOC | T1.5 | T1.1 | `move/sources/router.move` | DeepBook-only entrypoints against `Pool<hBTC, DBUSDC>`: maker `POST_ONLY` place/cancel + IOC sweep on the SAME book. NO Cetus, NO CLMM (G4). Self-match prevention enabled. Keeper path gated to `TradeCap` capability only (G2). | `cd move && sui move test` |
| Gateway unit tests | T1.6 | T1.3,T1.4 | `move/sources/tests/gateway_tests.move` | Tests: exit below 30,000 sats pools not requests; exit to a NON-pinned address is impossible (no code path accepts one); reclaim re-credits exactly; events emitted. | `cd move && sui move test gateway` |

Cross-ref: docs/MOVE-PACKAGE.md (module specs), docs/FACTS.md#hashi (signatures), HASHI_INTEGRATION.md §4 (deltas), §3 mechanism #1 (composed pinned exit).

---

# PHASE 2 — Keeper (mirrors docs/KEEPER.md) — CUT-LINE CRITICAL

Definition of done: keeper watches Hashi events, runs the permissionless `confirm_deposit` crank, sponsored-sweeps minted hBTC into shares, tracks withdrawals surfacing the signet txid, quotes maker-first on the hBTC book from a Seal-encrypted strategy; the deterministic mock backs every Hashi call so all of this runs offline in CI.

| Task | id | Depends | Files | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Real Hashi adapter | T2.1 | T0.5 | `keeper/src/hashi/real.ts` | Implements the T0.5 interface via `@mysten/hashi` (`client.$extend(hashi())`); network IDs auto-resolve; still swappable for the mock behind the same interface (G7). | `cd keeper && npm run test -- hashi.real --network=mock` (contract test against mock parity) |
| Event watcher | T2.2 | T2.1 | `keeper/src/hashi/watcher.ts` | Subscribes to the six Hashi event families (`treasury::Minted/Burned`, `deposit::*`, `withdrawal_queue::*`, `utxo_pool::UtxoSpent`); normalized event log; deterministic under the mock. | `cd keeper && npm run test -- watcher` |
| `confirm_deposit` crank | T2.3 | T2.2 | `keeper/src/execution/crank.ts` | Runs the PERMISSIONLESS `confirm_deposit` for pending Hashi deposits (for all users, not only ours). Idempotent; skips not-yet-eligible (respects 10-min delay). | `cd keeper && npm run test -- crank` |
| Sponsored deposit sweep | T2.4 | T2.3 | `keeper/src/execution/sweep.ts` | Sponsored PTB sweeps freshly-minted hBTC into vault shares; user needs no SUI (zkLogin path). | `cd keeper && npm run test -- sweep` |
| Withdrawal tracker | T2.5 | T2.2 | `keeper/src/execution/exit.ts` | Builds the `exit_to_bitcoin` PTB (calls `gateway`), drives `waitForWithdrawal`, surfaces the signet txid. Keeper NEVER holds `WithdrawCap` (G2). | `cd keeper && npm run test -- exit` |
| Strategy: Seal + deterministic evaluate/route | T2.6 | T0.5 | `keeper/src/strategy/`, `keeper/src/privacy/` | Padded fixed-length serializer; Seal encrypt/decrypt with version-epoch identity; `evaluate()`/`route()` PURE + deterministic (same inputs → same output). Maker-first quoting on the hBTC book. | `cd keeper && npm run test -- strategy` |
| Routing: L2 book + maker/IOC split | T2.7 | T2.6 | `keeper/src/routing/` | Reads DeepBook L2 book for `Pool<hBTC, DBUSDC>`; computes maker `POST_ONLY` leg + IOC residual on the SAME book (G4). No Cetus. | `cd keeper && npm run test -- routing` |
| Oracle divergence breaker | T2.8 | T2.6 | `keeper/src/oracle/` | Pyth BETA BTC/USD feed (pinned versions, staleness guard, G9) vs DeepBook TWAP; refuses evaluation on divergence beyond threshold. NAV valued at DeepBook mid. | `cd keeper && npm run test -- oracle` |
| Storage: Walrus put/get | T2.9 | T2.6 | `keeper/src/storage/` | Walrus put/get for strategy ciphertext + decision segments; `WALRUS_EPOCHS` set EXPLICITLY (never default); lifetime-renewal task. Encrypt-before-upload always. | `cd keeper && npm run test -- storage` |
| End-to-end run loop (mock) | T2.10 | T2.4,T2.5,T2.7,T2.8,T2.9 | `keeper/src/index.ts` (`run` cmd) | `run --vault <ID>` executes full loop against the MOCK adapter offline: watch → crank → sweep → evaluate → route (maker post) → journal stub. Deterministic, no network. | `cd keeper && npm run test -- e2e.mock` |

Cross-ref: docs/KEEPER.md (module specs), docs/FACTS.md (SDK API, event names), HASHI_INTEGRATION.md §4 (keeper deltas), mechanism #3/#4.

---

# PHASE 3 — App (mirrors docs/APP.md) — CUT-LINE CRITICAL

Definition of done: deposit screen does zkLogin + client-side `generateDepositAddress` + lifecycle; exit screen shows the immutable pinned address + Move-pinning explanation + resulting signet txid; the whole BTC-in → quote → BTC-out story is demoable (BTC leg pre-staged per G6).

| Task | id | Depends | Files | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Deposit screen | T3.1 | T0.4,T2.4 | `app/src/deposit/` | zkLogin (Google) → Sui address → CLIENT-SIDE `generateDepositAddress({suiAddress})` + QR (no server). Live status via `view.depositStatus`/`waitForDeposit` walking the six-stage lifecycle. | `cd app && npm run build`; manual: address derives, QR renders |
| Exit screen | T3.2 | T0.4,T2.5 | `app/src/exit/` | Shows the registered pinned BTC address (immutable) WITH the Move-pinning explanation (G2). Exit → instant Sui-side confirmation → then signet txid when broadcast. Pre-stage an earlier confirmed signet tx to show live (G6). | `cd app && npm run build`; manual: pinned addr shown, txid surfaces |
| zkLogin + sponsored path | T3.3 | T3.1 | `app/src/deposit/`, `app/src/lib/` | First deposit needs no SUI (sponsored); custody stays with depositor. | manual: login → deposit flow with zero user SUI |

Cross-ref: docs/APP.md (screen specs), HASHI_INTEGRATION.md §4 (app deltas), mechanism #4 (one-Bitcoin-transaction onboarding).

---

## ================= CUT LINE =================

MINIMUM DEMOABLE PRODUCT (must be green before ANY Phase 4+ work):

1. BTC in — pre-staged deposit (G6) advanced by the LIVE permissionless `confirm_deposit` crank (T2.3) on-screen; sponsored sweep into shares (T2.4).
2. Encrypted strategy — Seal-encrypted strategy (T2.6) quoting maker-side on `Pool<hBTC, DBUSDC>` via router (T1.5, T2.7); scripted taker fills for the demo.
3. BTC out — LIVE `gateway.exit_to_bitcoin` PTB (T1.3, T2.5) emitting `WithdrawalRequested` to the on-chain-pinned address; earlier exit's signet txid shown confirming in an explorer.

Cut-line VERIFY (all must pass):
```
cd move   && sui move build && sui move test
cd keeper && npm run build && npm run test -- e2e.mock
cd app    && npm run build
```
Plus a manual rehearsal of demo steps 2–4 in HASHI_INTEGRATION.md §8. If the BTC leg risks failing at judging, fall back to the SUI/USDC vault per HASHI_INTEGRATION.md §6 — decide AT the cut line, not at the venue.

## ============================================

---

# PHASE 4 — Bridge-aware envelope + journal + verify (post-cut-line)

Definition of done: on-chain redemption-buffer constraint; decision records carry Hashi fields; `verify` replay TRUSTLESSLY re-derives limiter state from Hashi's event stream (G5), not from an SDK read.

| Task | id | Depends | Files | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Envelope: redemption buffer | T4.1 | T1.1,T1.3 | `move/sources/envelope.move` | Constraint: deployable hBTC ≤ f(idle hBTC, pending exit demand). Reads queue state from the `Hashi` shared object IF getters exist (docs/DAY-ONE.md check #2); FALLBACK = static buffer ratio at vault creation + keeper-attested limiter readings in the (replayable) log. Standard envelope checks too (slippage bps, notional/epoch, venue allowlist, cooldown, Walrus-blob availability, owner pause, owner-only emergency withdraw). | `cd move && sui move test envelope` |
| Journal: decision records | T4.2 | T2.9 | `keeper/src/journal/`, `move/sources/journal.move` | Decision records include `hashi` fields: limiter reading, queue depths, pending-mint total, plus oracle/book/strategy_blob/ruleset/decision/result. Blob ids emitted on-chain (self-certifying). | `cd keeper && npm run test -- journal` |
| Verify: trustless limiter replay | T4.3 | T4.2,T0.5 | `keeper/src/verify/` | `verify --vault <ID> --from-epoch <N>` re-runs the published decision fn against recorded inputs AND re-derives the limiter trajectory by replaying `projectCapacity()` over the on-chain `WithdrawalRequested/PickedForProcessing/Signed` stream (G5). Reports any decision that fails to reproduce. Only trust anchors are the two genesis scalars (`refill_rate`, `max_bucket_capacity`). | `cd keeper && npm run test -- verify` and `verify --vault <ID> --from-epoch 0` on the mock stream reproduces the bucket |

Cross-ref: docs/MOVE-PACKAGE.md#envelope, docs/KEEPER.md#verify, HASHI_INTEGRATION.md §3 mechanism #2 (rewritten around trustless replay), §7 phase 4.

---

# PHASE 5 — Stretch (post-cut-line, only if 0–4 green)

Definition of done: peg-flow signal live in the strategy; transparency panel with bridge column; deposit-ticket TTO flow (gated by docs/DAY-ONE.md check #4).

| Task | id | Depends | Files | Acceptance criteria | VERIFY |
|---|---|---|---|---|---|
| Peg-flow signal | T5.1 | T2.6,T2.2 | `keeper/src/strategy/` | Strategy consumes pending mint/burn queue (from `DepositApproved` preceding mint, `WithdrawalRequested` preceding burn) + limiter status as inputs; response stays Seal-encrypted (G8 — signal public, response private). | `cd keeper && npm run test -- strategy.pegflow` |
| Transparency panel | T5.2 | T4.3 | `app/src/transparency/` | Shows encrypted strategy blob, decision log, and the BRIDGE COLUMN: limiter state, queue depths, and the replayable "we de-risked because the bridge tightened" trace (G5). | `cd app && npm run build`; manual: bridge column renders replay trace |
| Deposit-ticket TTO | T5.3 | T2.4 | `keeper/src/execution/`, `move/sources/vault.move` | GATED by docs/DAY-ONE.md check #4 (does `generateDepositAddress` accept a 32-byte object id as `suiAddress`?). If yes: key derivation to a per-user deposit-ticket object id; mint lands via transfer-to-object; vault claims with `public_receive` — zero user tx after setup. If check #4 fails: SKIP, mark "UNKNOWN — resolved NO in DAY-ONE.md". | `cd move && sui move test ticket` (only if check #4 passed) |

Cross-ref: docs/APP.md#transparency, HASHI_INTEGRATION.md §3 mechanism #3 & #4, §7 phase 5.

---

## Standing ops (from day one, every day)

- Keep 2–3 confirmed hBTC deposits and one broadcast withdrawal WARM at all times (G6) so the demo never waits on signet. See HASHI_INTEGRATION.md §7 (standing ops) + §9 risk register.
- Keep `signetfaucet.com` dripping — it is the ONLY working signet faucet (`signet257.bublina.eu.org` and `alt.signetfaucet.com` are dead; Mutinynet is a DIFFERENT CHAIN and must never be used). Amount is in BTC, max `0.01`, and you must wait ≥ 30 s after the captcha or the payout is silently discarded. See `docs/FACTS.md#networks-faucets`.
- Pin SDK/Pyth versions; Pyth DAO auto-upgrades Sui addresses 2026-08-18 → versions must be pinned before then (G9).

## Global definition of done (submission)

All of: cut-line VERIFY green + Phase 4 green + at least one Phase 5 task + demo rehearsed to HASHI_INTEGRATION.md §8 + risk register (§9) mitigations in place + Q&A (§10) answerable. hBTC framing honest per G8.
