# CLAUDE.md — Aphotic × Hashi ("The Bitcoin Dark Vault")

> Coding-agent entrypoint. Auto-loaded every session. High-signal only. Facts of record live in `docs/FACTS.md` — never re-derive an ID/type/signature; cite it by anchor.

## Project (4 sentences)

Aphotic × Hashi is a NON-CUSTODIAL, PRIVATE market-making vault on Sui **testnet** (Bitcoin side = **signet**): a Seal-encrypted strategy is executed maker-first on the `hBTC/DBUSDC` DeepBook v3 order book by a deterministic off-chain keeper that holds ONLY a DeepBook `TradeCap`. Native BTC enters/exits through Hashi (MystenLabs' native-BTC orchestrator); exits are composed in Move via `hashi::withdraw::request_withdrawal` to a Bitcoin address pinned on-chain at deposit, so a fully compromised keeper can neither steal nor redirect funds. Onboarding is zkLogin + sponsored transactions + a permissionless `confirm_deposit` crank; NAV is sats-denominated; every keeper decision is written to Walrus and is replayable. The differentiator is composing the bridge's ON-CHAIN machinery (pinned exits, a trustlessly-replayable limiter-aware risk envelope, the permissionless deposit crank, a peg-flow signal) — NOT the token's trust model (hBTC IS custodial-threshold wrapped BTC — always state this honestly).

## READ ORDER (a fresh coding agent reads these, in order)

1. **`docs/GOLDEN-RULES.md`** — the 10 hard rules (RULE / WHY / NEVER) + common mistakes to avoid + pitch-honesty lines. **Read FIRST; re-check before any Hashi/DeepBook/oracle claim or code.**
2. **`docs/RECON.md`** — VERIFIED GROUND TRUTH from live reconnaissance (R1–**R14**: transport, toolchain, deps, on-chain ids, Hashi Move surface, events, limiter algorithm, venue reality, Pyth, npm versions, landing page, **deposit registration**). **NEVER re-derive anything in it. Where it contradicts another doc, RECON wins.** (Two known arithmetic slips: see the errata digest.)
3. **`docs/CONVENTIONS.md`** — the APHOTIC CONTRACT banner every source file carries, plus the progress-census greps. Follow the grammar EXACTLY.
4. **`docs/FACTS.md`** — canonical single source of truth (all IDs, coin types, signatures, latencies, limiter mechanics, SDK, venue, oracle, events, unknowns). **FACTS.md wins over the layer-spec bodies; the layer-spec ERRATA sections win over FACTS.**
5. **`docs/DEPLOYED.md`** — what we actually published on testnet: package, shared `Vault`, shared `BalanceManager`, caps, digests, envelope parameters, and what is known-incomplete at v1. These are the ids `keeper/.env` and `app/.env.local` are wired to.
6. **`docs/ARCHITECTURE.md`** — component map, object/capability graph, the four end-to-end flows, trust-boundary table.
7. **Layer spec for the task at hand** — `docs/MOVE-PACKAGE.md` (Move package `aphotic`), `docs/KEEPER.md` (TypeScript keeper), or `docs/APP.md` (React+Vite app). **Read each one's `ERRATA (2026-07-25)` section FIRST — it wins over the body above it.**
8. **`docs/STATUS.md`** — the per-task ledger: what is DONE vs STUB vs BLOCKED, the environment of record, the known blockers, and the verbatim run log.
9. **`docs/ULTRACODE-BRIEF.md`** — the entry document for an implementation run: work-remaining census, full VERIFY matrix, the complete errata digest, and the prohibitions.
10. **`docs/DEMO.md`** — the runbook: the four differentiators, the live-vs-pre-staged boundary, the minute-by-minute script with exact commands, the fallback, and the things we must never say.
11. **`docs/BUILD-PLAN.md`** — the ordered, phase-by-phase task list (T0.x…T5.x) with acceptance criteria + VERIFY commands and the CUT LINE. Execute top-to-bottom.
12. **`docs/DEPLOY.md`** — shipping `app/` to Vercel: `vercel.json`, the `VITE_*` build-time inlining trap, and the Enoki/Google origin registration.
13. **`docs/DAY-ONE.md` + `docs/DAY-ONE-RESULTS.md`** — the pre-code verification checklist (D1–D10) and its execution record. **Already run** (2026-07-25); RESULTS is the receipt behind every resolved UNKNOWN.
14. Design rationale only if needed: **`HASHI_INTEGRATION.md`** (authoritative Aphotic × Hashi design — 5 mechanisms, deltas, demo §8, Q&A §10) and **`README (8).md`** (base Aphotic product design).

> **Conflict resolution:** layer-spec ERRATA > `docs/RECON.md` > `docs/FACTS.md` > layer-spec body > `HASHI_INTEGRATION.md` > `README (8).md`.
> The 10 golden rules also appear condensed below and in the first table of `docs/FACTS.md`; `docs/GOLDEN-RULES.md` is the expanded, authoritative guardrail doc. Every UNKNOWN (U1–U9) is now **resolved or logged** — see `docs/DAY-ONE-RESULTS.md` and `docs/STATUS.md` § Known blockers.

## REPO MAP

### Docs (all under `docs/`)

| File | Purpose |
|---|---|
| `docs/RECON.md` | **VERIFIED GROUND TRUTH** (R1–**R14**) from live recon passes: transport, toolchain, Move deps, on-chain ids, live Hashi config, Hashi Move surface, event names, the exact limiter algorithm, DeepBook venue reality, Pyth, npm versions, landing-page source, **deposit registration**. **Never re-derive; RECON wins over other docs.** |
| `docs/CONVENTIONS.md` | The APHOTIC CONTRACT banner grammar (`@task`/`@status`/`@spec`/`@facts`/`@implements`/`@forbidden`/`@invariant`/`@verify`) + the `TODO(Tx.y)` progress-census greps. |
| `docs/DEPLOYED.md` | **The record of what we published on Sui testnet**: package, shared `Vault`, shared `BalanceManager`, `VaultCap`/`UpgradeCap`, tx digests, envelope parameters, known-incomplete list. Never overwrite a row — add one, so old journal entries stay resolvable. |
| `docs/STATUS.md` | **Per-task ledger** T0.1…T5.3: status · files · VERIFY · note, plus the environment of record, the known blockers, and the verbatim run log. Regenerated by inspecting the tree and running every command. |
| `docs/DEMO.md` | **The runbook.** The four differentiators, the live-vs-pre-staged boundary table, pre-flight, the minute-by-minute script with exact commands, the fallback if the signet leg is not ready, the Q&A, and the never-say list. |
| `docs/DEPLOY.md` | Shipping `app/` to Vercel: `vercel.json`, `.vercelignore`, the `VITE_*` build-time-inlining trap, Enoki/Google origin registration, deploy verification. |
| `docs/ULTRACODE-BRIEF.md` | **Entry document for an implementation run:** 60-second start, banner grammar, work-remaining census with the CUT LINE, the full VERIFY matrix, the complete ERRATA digest (incl. R14), and the G-rule NEVERs. |
| `docs/DAY-ONE-RESULTS.md` | Execution record for DAY-ONE (D1–D10): exact commands, real output, PASS/FAIL, decisions. The **receipt** behind every resolved UNKNOWN. |
| `docs/FACTS.md` | CANONICAL truth: IDs, coin types, Move/SDK signatures, latencies, limiter, venue, oracle, events, conventions, UNKNOWNS. Everything links here. |
| `docs/ARCHITECTURE.md` | System model: component diagram, capability/object graph, 4 flows, trust-boundary table, demo boundary. |
| `docs/MOVE-PACKAGE.md` | Build-exact Move 2024 spec for package `aphotic`: `Move.toml`, per-module structs/fns/events/errors/invariants + tests + verification (V1–V6). |
| `docs/KEEPER.md` | TypeScript ESM keeper spec: `hashi/` adapter+mock, strategy/routing/execution/oracle/storage/journal/verify/privacy, env vars, acceptance (A1–A10). |
| `docs/APP.md` | React+Vite 3-screen app spec: Deposit / Exit / Transparency; components, lifecycle, demo staging, `VITE_` env, acceptance (A1–A11). |
| `docs/BUILD-PLAN.md` | Ordered agent-executable tasks (Phase 0→5), dependency ids, AC, VERIFY, the CUT LINE. START HERE for execution order. |
| `HASHI_INTEGRATION.md` | Authoritative design rationale (5 mechanisms, deltas, phased plan, demo §8, Q&A §10). Not a build spec. |
| `README (8).md` | Base Aphotic product design (Seal/Walrus/DeepBook/zkLogin/keeper/constraint envelope). Filename has a space + parens. |
| `BTC_FIXED_INCOME.md` | **SHELVED ALTERNATIVE ("Meridian" bond). NOT the build. Do NOT implement its mechanics.** |
| `docs/DAY-ONE.md` | Runnable pre-code verification checklist (D1–D10) resolving every UNKNOWN (U1–U9 + KEEPER §10). Run BEFORE feature code; owner of all UNKNOWNS. |
| `docs/GOLDEN-RULES.md` | The 10 golden rules expanded (RULE / WHY / NEVER) + common mistakes to avoid + pitch-honesty lines. **Read FIRST.** |

### Source tree (BUILT — the Move package is published; **4 `TODO`s remain, in 2 files**)

Status legend: **DONE** = implemented AND covered by a test or gate someone ran and saw pass · **PARTIAL** = some bodies real, `TODO(Tx.y)` markers remain · **STUB** = banner + `TODO`, bodies throw/empty. Per-task detail, with the verbatim run log, in `docs/STATUS.md`.

| Path | Purpose | State |
|---|---|---|
| `move/Move.toml` · `move/Move.lock` | Package `aphotic`, `edition = "2024.beta"`. **Exactly two git deps** (`hashi`, `deepbook`) — no `Sui` line, no `[addresses]`, no `[dep-replacements]`, no Pyth, **no `[environments]`** (sui 1.76.0 rejects overriding system envs). ⚠ the lock records Windows backslash subdirs. | DONE |
| `move/sources/vault.move` | Shared `Vault<phantom B, phantom Q>` (**generic** over the asset pair — naming hBTC here would break G7): sats share/NAV accounting, `seal_approve` gate, DeepBook `BalanceManager` reference, write-once `btc_exit_address`, version-epoch rotation. | DONE (T1.1/T1.2) — 42 tests |
| `move/sources/gateway.move` | **THE ONLY Hashi boundary (G7)**: `register_exit_address`, `exit_to_bitcoin` (**no address parameter**), depositor-only `reclaim_stalled_exit`, small-exit pooling with a self-only flush. | DONE (T1.3/T1.4) — 26 tests |
| `move/sources/envelope.move` | Intra-package **LEAF** (takes primitives, never `&Vault` — Move forbids the cycle). Redemption buffer, `deployable_sats`, `check_action`, and the `project_capacity()` trustless limiter replay (G3/G5). | DONE (T4.1) — 34 tests |
| `move/sources/router.move` | DeepBook maker `POST_ONLY` (via `place_limit_order`, order_type 3 — E-M6) + IOC sweep, granularity gate before the book is touched, `try_book_mid` → `none` on a one-sided book. | DONE (T1.5) — 25 tests |
| `move/sources/journal.move` | Emits decision-log Walrus blob ids on-chain (self-certifying), monotonic-seq guard. | DONE (T4.2) — 12 tests |
| `move/tests/*_tests.move` | Per-module tests **at the package root, NOT `sources/tests/`** — otherwise `gateway_tests.move` breaks the G7 grep gate. | DONE — **139 total, 0 failures** |
| `move/tests/mock_hashi.move` | Working bridge stand-in replicating `request_withdrawal`/`cancel_withdrawal` with all five upstream asserts. | DONE |
| `keeper/src/config.ts` · `types.ts` | Pure `loadConfig(env)` (nested groups, `redactSecrets`, `assertRealModeComplete`); shared domain types. One of the four id-bearing files. | DONE |
| `keeper/src/sui/client.ts` | **The only** Sui client factory (`SuiGrpcClient`; `SuiJsonRpcClient` for probes). Enforced by the `transport` gate. | DONE |
| `keeper/src/util/` | `bigint` / `bytes` / `env` / `errors` / `rng` (seeded). | DONE |
| `keeper/src/hashi/` | Adapter interface + deterministic MOCK (logical clock, no I/O) + **REAL adapter** over `HashiClient` + raw `moveCall`s + event polling; `watcher.ts`; `limiter.ts` `projectCapacity()`/`consume()` — the **single** G5 implementation, shared by mock, strategy and `verify/`; `normalize.ts` does the `WithdrawalSigned` join; `eventTypes.ts` the event union. | DONE (T0.5/T2.1/T2.2) |
| `keeper/src/strategy/` | Pure deterministic `evaluate()`, padded serializer, params, peg-flow. The `purity` gate forbids `Date.now()`/`Math.random()` here. | DONE (T2.6/T5.1) |
| `keeper/src/privacy/` | Seal encrypt/decrypt, session keys, version-epoch rotation. **Every body is real; the concrete `SealBackend` port is not bound** — the vault's ciphertext is still a placeholder. | PARTIAL (T2.6) |
| `keeper/src/routing/` | DeepBook L2 book read via `get_level2_range` (never `mid_price`), maker/IOC split on the same book (G4). | DONE (T2.7) |
| `keeper/src/execution/` | PTB build (TradeCap only), `confirm_deposit` crank, sponsored sweep, `exit_to_bitcoin`, **unsigned-only** reclaim builder. | DONE (T2.3–T2.5) |
| `keeper/src/oracle/` | Pyth **Beta** feed + DeepBook TWAP divergence breaker, staleness guards (G9). | DONE (T2.8) |
| `keeper/src/storage/` + `keeper/src/journal/` | Walrus put/get + lifetime renewal; decision records → blob ids. | DONE (T2.9/T4.2) |
| `keeper/src/verify/` | Replay engine incl. the trustless limiter re-derivation over on-chain events (G5). | DONE (T4.3) |
| `keeper/src/index.ts` | The seven-command CLI (`create-vault` `run` `crank` `sweep` `exit` `reclaim` `verify`), fully dispatched to the modules above. `reclaim` **prints an unsigned PTB and never signs** (E-K7). | DONE (T2.10) |
| `keeper/test/` | **481 green tests across 19 files**: limiter golden vectors + consume + Move↔TS cross-parity, mock & real adapters, watcher, crank, sweep, exit, strategy, pegflow, routing, oracle, storage, journal, verify, privacy, config, **e2e.mock**. | DONE |
| `app/src/config.ts` · `.env.example` | Typed from `import.meta.env`. One of the four id-bearing files. | DONE |
| `app/src/lib/` | `suiClient.ts` (the app's single Sui client factory), `bech32.ts`, `explorer.ts`, `format.ts`. | DONE |
| `app/src/hashi/depositAddress.ts` | The app's **only** Hashi boundary — offline client-side Taproot derivation (G7). | DONE |
| `app/src/screens/deposit/` · `transparency/` | Deposit (zkLogin → derived address + QR + lifecycle) and Transparency (decision log, encrypted-strategy panel, bridge column, verify client). | DONE (T3.1/T5.2) |
| `app/src/screens/exit/` | `RegisterExitAddress`, `ptb.ts`, `vaultRead.ts`, `model.ts`, `CallPreview`, `ExitTimeline` are all real. ⚠ `ExitScreen.tsx` still renders a placeholder amount form — 3 of the 12 remaining TODOs. | PARTIAL (T3.2) |
| `app/src/components/` · `fixtures/` · `session/` · `landing/` | Shared components (pinning explainer, lifecycle stepper, trust disclosure, keeper-capability badge…), offline fixtures, Enoki zkLogin session, and the ported React 19 landing page (`/`). ⚠ 1 TODO left in `landing/stats.js`. | DONE except `stats.js` |
| `app/vitest.config.ts` · `app/test/` | The app's own **offline** suite — 6 files, **84 tests** (bech32, components, depositAddress, enoki, format, hashiAdapter). `test.env` pins every `VITE_*` so a developer's `.env.local` cannot change a result. Vitest 3 loads this **instead of** `vite.config.ts`. | DONE |
| `scripts/gates.{ps1,sh}` | 8 invariant gates: `g7` `g4` `g2` `ids` `sdk` `purity` `transport` `todo`. | DONE |
| `scripts/verify-all.ps1` | **Master gate** — runs 8 build/test/gate steps. Today: `7 PASS · 1 FAIL`. ⚠ does **not** yet run `app npm test`. | PARTIAL |
| `scripts/seed-book.{mjs,ps1}` | Ops tooling for **B2**: reads live pool params by devInspect, prints what inventory is *obtainable* with evidence, dry-run by default, refuses off-market bids against the Pyth Beta feed. | DONE |
| `scripts/verify-onchain.mjs` | Live testnet assertions: ids (incl. **our own deployment**), config scalars, event streams, Pyth Beta feed. `28 PASS · 0 FAIL`. | DONE |
| `scripts/register-deposit.ps1` | Registers a signet UTXO with Hashi. **Reverses the txid for you** (R14.2) and refuses below 6 confirmations (R14.3). ⚠ hardcodes two Hashi ids ⇒ **trips the `ids` gate**. | PARTIAL |
| `scripts/check-enoki.mjs` | Verifies a deployed origin is registered with Enoki/Google so zkLogin will not 403. | DONE |

## THE 10 GOLDEN RULES (condensed — full text + enforcement points in `docs/FACTS.md` top table)

| # | Rule (one line) |
|---|---|
| G1 | hBTC is a fungible `Coin<BTC>`; on-Sui movement is INSTANT (1 checkpoint). BTC/Guardian latency exists ONLY at mint(deposit)/burn(withdraw). |
| G2 | Keeper holds ONLY DeepBook `TradeCap`, never `WithdrawCap`/`DepositCap`. Exits are Move-composed to an on-chain-pinned address; a compromised keeper cannot steal or redirect. |
| G3 | You CANNOT buy priority in Hashi's global withdrawal queue; over-capacity batches are REJECTED (`RateLimitExceeded`), not queued. Never design around jumping the queue. |
| G4 | NO Cetus hBTC pool. Router = DeepBook maker `POST_ONLY` + IOC sweep on the SAME book only. No Cetus taker leg, no CLMM ranges. |
| G5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity() = min(cap, tokens + elapsed*refill_rate)` over the on-chain `WithdrawalSigned` stream — `verify/` re-derives it; NOT a trusted SDK read. |
| G6 | The BTC leg (deposit ~70 min, withdraw ~1.5–2 h) is NEVER live-demoable. Pre-stage; Sui side is instant; show an earlier confirmed signet tx. |
| G7 | Isolate the ENTIRE Hashi surface behind an adapter + deterministic MOCK from line one (mirror `project_capacity` exactly); confine on-chain Hashi calls to `gateway.move`; all IDs configurable (env/config), never hardcoded in logic. |
| G8 | Honesty: hBTC IS custodial-threshold wrapped BTC. The differentiation is composing the bridge's on-chain machinery, NOT the token's trust model. |
| G9 | Pin Pyth versions + use the Beta feed on testnet; value NAV/collateral at DeepBook mid (depeg defence); add staleness guards. |
| G10 | Move 2024 edition idioms throughout. Amounts in sats (`u64`). Emit an event for every externally-visible state transition. Error constants named `E<Reason>`. |

## BUILD & TEST COMMANDS

Every result below was observed on 2026-07-25 by running the command, not quoted from a summary.

```bash
# ── THE MASTER GATE — run this first, and again before you claim anything is done ──
powershell -NoProfile -File scripts/verify-all.ps1     # → 7 PASS · 1 FAIL · 0 SKIP  (SKIP is NOT green)
                                                       # the FAIL is `gates`/`ids` — see the ⚠ below

# Move package (from move/) — PUBLISHED on testnet, see docs/DEPLOYED.md
cd move   && sui move build          # compiles clean, edition 2024.beta, ZERO warnings
cd move   && sui move test           # → Total tests: 139; passed: 139; failed: 0
cd move   && sui move test gateway   # per-module: vault(42) gateway(26) envelope(34) router(25) journal(12)
                                     # ⚠ the filter is POSITIONAL. `--filter` is NOT a flag in sui 1.76.0.

# Keeper (from keeper/) — ESM, "type":"module"
cd keeper && npm install && npm run typecheck && npm run build
cd keeper && npm test                              # → 19 files · 481 tests passed
cd keeper && npm run test -- hashi.mock            # T0.5 acceptance: full loop, NO live Hashi (24)
cd keeper && npm run test -- limiter.cross         # G5 acceptance: TS replay == the Move twin (5)
cd keeper && npm run test -- e2e.mock              # cut-line: no wall clock, no socket (13)
cd keeper && node dist/index.js --help             # exit 0, prints the seven commands

# App (from app/) — React 19 + Vite 6
cd app    && npm install && npm run build          # tsc --noEmit && vite build
cd app    && npm test                              # → 6 files · 84 tests passed (fully offline)
cd app    && npm run dev                           # 4 routes: / (landing) /deposit /exit /transparency

# Invariant gates (either shell) — g7 g4 g2 ids sdk purity transport todo
powershell -NoProfile -File scripts/gates.ps1      # → 6 PASS · 1 FAIL + the TODO census (4 markers)
bash scripts/gates.sh

# Live testnet assertions (needs network)
node scripts/verify-onchain.mjs                    # → 28 PASS · 0 FAIL · 0 WARN · 7 INFO
node scripts/seed-book.mjs                         # what book inventory is OBTAINABLE (dry-run by default)

# CUT-LINE VERIFY — all three green:
cd move && sui move build && sui move test              # PASS (139)
cd keeper && npm run build && npm run test -- e2e.mock  # PASS (13)
cd app && npm run build                                 # PASS
```

⚠ **Three live caveats, all tracked in `docs/STATUS.md` § Known blockers:**
1. **The `ids` gate FAILS** — `scripts/register-deposit.ps1:48-49` hardcodes two Hashi ids (**B11**). Until it is fixed, `verify-all.ps1` is `7 PASS · 1 FAIL` and **we cannot claim a clean master gate**.
2. **`verify-all.ps1` does not run `cd app && npm test`** (**B14**) — the app suite is new, so an app regression can still pass the master gate. Add it as a ninth step.
3. **The `hBTC/DBUSDC` book is empty and we cannot create inventory** (**B2**): `treasury::mint` is `public(package)` (no hBTC) *and* the DBUSDC `TreasuryCap` is `AddressOwner`, not shared (no quote asset). `mid_price` asserts **both** sides. Handled everywhere as a defined state; there is simply no price to show.

**Toolchain of record.** `sui` **1.76.0-6effb4523834** at `%LOCALAPPDATA%\sui\sui.exe`; `sui client active-env` = `testnet` (chain id `4c78adac`). Node 24.13.0 / npm 11.6.2. Deployer/keeper address `0xd41b0cd8…f333d`, ~21.8 SUI. ⚠ `sui` is **not reliably on `PATH`** in agent shells — prepend it: `$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"`.

**Deployed (v1, 2026-07-25).** package `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` · shared `Vault<hBTC,DBUSDC>` `0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8` (isv 947353676) · shared DeepBook `BalanceManager` `0x5766ed0b5e3fd310da9ccd723912198450872d9e2c83a473ed59cd5ab51990e2` (isv 947353675). Full receipts in **`docs/DEPLOYED.md`**.

**Transport.** `https://fullnode.testnet.sui.io:443` serves **gRPC v2 only — JSON-RPC returns HTTP 404**; the `sui` CLI speaks gRPC to it and works normally. In code the default client is `SuiGrpcClient` (`@mysten/sui/grpc`), constructed in exactly one place per package (`keeper/src/sui/client.ts`, `app/src/lib/suiClient.ts`) — enforced by the `transport` gate. `SuiClient` no longer exists in `@mysten/sui@2.22.1`; `SuiJsonRpcClient` against the mirror `https://rpc-testnet.suiscan.xyz:443` is for probes only. The Hashi guardian's `/info` requires **HTTP/2** (HTTP/1.1 → 464).

⚠ **Windows:** never rewrite a `.move` file with PowerShell `Set-Content -Encoding utf8` — PS 5.1 writes a UTF-8 BOM and the Move compiler rejects it (`E01001`). Use `[System.IO.File]::WriteAllText` with `New-Object System.Text.UTF8Encoding($false)`.

## CUT LINE (one line)

Minimum demoable product = **BTC in** (pre-staged deposit advanced by the LIVE permissionless `confirm_deposit` crank + sponsored sweep) → **encrypted strategy** quoting maker-side on `Pool<hBTC,DBUSDC>` (scripted taker fills) → **BTC out** (LIVE `gateway::exit_to_bitcoin` PTB to the pinned address; earlier exit's signet txid shown confirming).

**Where we actually stand:** **the cut line is met in code.** All three legs are green with real coverage — 139 Move + 481 keeper + 84 app tests — and the named acceptance test `e2e.mock` exists and asserts determinism and offline-ness rather than assuming them. What sits outside the cut line and cannot be coded around: the `hBTC/DBUSDC` book is empty on both sides and **we can mint neither asset** (hBTC's `treasury::mint` is `public(package)`; DBUSDC's `TreasuryCap` is address-owned), and the signet deposit had not yet cleared 6 confirmations, so the vault holds no hBTC. **`docs/DEMO.md` §5 carries the fallback script for exactly that case** — read it before deciding anything at the venue. The SUI/USDC fallback vault (`HASHI_INTEGRATION.md` §6) remains the last resort; decide AT the cut line, not at the venue.

## SCOPE NOTES (do not get this wrong)

- **`BTC_FIXED_INCOME.md` is a SHELVED alternative ("Meridian" bond). DO NOT build it.** Reference it only as the option not taken. Never import its bond mechanics.
- **`README (8).md` is the base product design** (the SUI/USDC lineage that Aphotic × Hashi extends). `HASHI_INTEGRATION.md` holds the authoritative deltas; where the two differ, HASHI_INTEGRATION.md and `docs/FACTS.md` win.
- On any conflict between docs, **`docs/FACTS.md` is authoritative.** If a value is unknown, it is marked "UNKNOWN — resolve in DAY-ONE.md"; treat it as blocking for `real`-mode work and log the owner (build lead).
