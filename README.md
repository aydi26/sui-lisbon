# Aphotic × Hashi — The Bitcoin Dark Vault

A **non-custodial, private market-making vault** on Sui testnet (Bitcoin side = **signet**).

A Seal-encrypted strategy is executed maker-first on the `hBTC/DBUSDC` DeepBook v3 order book by a deterministic off-chain keeper that holds **only a DeepBook `TradeCap`**. Native BTC enters and exits through [Hashi](https://github.com/MystenLabs/hashi), MystenLabs' native-BTC orchestrator; exits are composed **in Move** via `hashi::withdraw::request_withdrawal` to a Bitcoin address **pinned on-chain at deposit and immutable thereafter**. A fully compromised keeper can neither steal nor redirect funds — it can trade, it can never take. Onboarding is zkLogin + sponsored transactions + a permissionless `confirm_deposit` crank. NAV is sats-denominated; every keeper decision is written to Walrus and is replayable.

### The honest line about hBTC (G8)

> **hBTC is custodial-threshold wrapped BTC** — threshold Schnorr, a Guardian 2-of-2, and a ~60-day recovery leaf. We do not hide that and we do not claim otherwise.

Our differentiation is **composing the bridge's on-chain machinery**, not the token's trust model:

- **Move-pinned exits** — the destination is written once at deposit and read from chain state, never from a keeper input.
- **A trustlessly-replayable risk envelope** — the Guardian rate limiter's trajectory is re-derived from Hashi's own on-chain events, not read from an SDK we ask you to trust.
- **A permissionless deposit crank** — anyone can advance anyone's deposit; we run it for everyone.
- **A peg-flow signal** — pending mint/burn pressure as a public input to a private strategy.

Anyone can check all four. That is the whole point.

---

## Repo map

| Path | What | State |
|---|---|---|
| `move/` | Move 2024 package **`aphotic`** — `vault` (shares, NAV, `seal_approve`), `gateway` (**the only** Hashi boundary), `envelope` (redemption buffer + limiter replay), `router` (DeepBook maker/IOC), `journal`. Tests in `move/tests/`. | **DONE** — 139 tests, zero warnings, **published on testnet** |
| `keeper/` | TypeScript ESM keeper — `hashi/` (adapter + deterministic mock + real), `strategy/`, `routing/`, `execution/`, `oracle/`, `storage/`, `journal/`, `verify/`, `privacy/`, `sui/`, `util/`, and a seven-command CLI. | **DONE** — 481 tests across 19 files (16:36 snapshot) |
| `app/` | React 19 + Vite — `/` landing, `/deposit`, `/exit`, `/transparency`, plus its own offline vitest suite. | **DONE** — 84 tests; except the exit-amount form (T3.2) and the landing stats (T5.2) |
| `scripts/` | `gates.ps1` / `gates.sh` (8 invariant gates), `verify-all.ps1` (master gate), `verify-onchain.mjs` (28 live testnet assertions), `register-deposit.ps1` (txid-reversing UTXO registrar), `seed-book.mjs` (dry-run-by-default book seeder), `check-enoki.mjs`. | **DONE** — ⚠ `register-deposit.ps1` currently trips the `ids` gate |
| `docs/` | All specifications. See the read order below. | — |

State legend: **DONE** = implemented and covered by a test or gate that was run and observed green · **PARTIAL** = some bodies real, `TODO(Tx.y)` markers remain · **STUB** = compiles, bodies throw. Per-task detail, with the run log, in **`docs/STATUS.md`**.

**Canonical on-chain IDs may appear in exactly four places** (G7): `keeper/src/config.ts`, `app/src/config.ts`, the `.env.example` files, `move/Move.toml`. Everywhere else they arrive as config.

## Deployed on Sui testnet

| What | Id |
|---|---|
| `aphotic` package | `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` |
| `Vault<hBTC, DBUSDC>` (shared) | `0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8` |
| DeepBook `BalanceManager` (shared) | `0x5766ed0b5e3fd310da9ccd723912198450872d9e2c83a473ed59cd5ab51990e2` |

Full receipts, digests, envelope parameters and what is known-incomplete: **`docs/DEPLOYED.md`**.

---

## Quickstart

Prereqs: `sui` **1.76.0** (`sui client active-env` = `testnet`, gas-funded), Node **≥ 18** (tested on 24.13.0 / npm 11.6.2).

⚠ `sui` is not reliably on `PATH`. On Windows: `$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"`.
⚠ The Move test filter is **positional** — `sui move test gateway`. `--filter` is not a flag in 1.76.0.

```bash
# Move package
cd move && sui move build && sui move test      # 139 tests, zero warnings
cd move && sui move test gateway                # per module: vault | gateway | envelope | router | journal

# Keeper (ESM, "type": "module")
cd keeper && npm install && npm run typecheck && npm run build && npm test   # 481 tests, 19 files
cd keeper && node dist/index.js --help          # the seven CLI commands

# App
cd app && npm install && npm run build          # tsc --noEmit && vite build
cd app && npm test                              # 84 tests, 6 files, fully offline
cd app && npm run dev                           # http://localhost:5173
```

Copy `keeper/.env.example` → `keeper/.env` and `app/.env.example` → `app/.env`. `keeper/.env` is gitignored and is the **only** file that may ever hold a private key (`sui keytool export --key-identity <alias>`).

**Everything runs offline.** The Hashi surface is isolated behind an adapter with a deterministic, logical-clock mock (no `Date.now()`, no `Math.random()`, no I/O), so the whole system builds and tests green with no live bridge.

---

## VERIFY matrix

```bash
powershell -NoProfile -File scripts/verify-all.ps1      # the master gate — runs all 8 steps
```

| Command | Green means | Observed 2026-07-25 |
|---|---|---|
| `cd move && sui move build` | Package `aphotic` compiles, edition `2024.beta`, **zero warnings** | exit 0 |
| `cd move && sui move test` | All `move/tests/*_tests.move` pass | `Total tests: 139; passed: 139; failed: 0` |
| `cd keeper && npm run typecheck` | `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` | exit 0 |
| `cd keeper && npm run build` | Emits runnable ESM to `dist/` with `.d.ts` + sourcemaps | exit 0 |
| `cd keeper && npm test` | Full vitest suite | `19 files · 481 tests passed` |
| `cd keeper && npm run test -- limiter.cross` | The **G5** acceptance: the TS limiter replay matches its Move twin | 5 passed |
| `cd keeper && npm run test -- e2e.mock` | The cut-line acceptance: the loop reads no wall clock and opens no socket | 13 passed |
| `cd app && npm run build` | `tsc --noEmit && vite build` | exit 0 |
| `cd app && npm test` | The app's own offline suite (every `VITE_*` pinned) ⚠ not yet a step in `verify-all.ps1` | `6 files · 84 tests passed` |
| `powershell -File scripts/gates.ps1` (or `bash scripts/gates.sh`) | 8 invariant gates: `g7` `g4` `g2` `ids` `sdk` `purity` `transport` `todo` | ⚠ `6 PASS · 1 FAIL` |
| `node scripts/verify-onchain.mjs` | Every canonical id, our own deployment, config scalars, event streams and the Pyth Beta feed match FACTS **live on testnet** (needs network) | `28 PASS · 0 FAIL · 0 WARN` |

The gates are the interesting part: `g7` proves `hashi::` appears in exactly one Move file, `g2` proves no exit function takes a Bitcoin address, `ids` proves no canonical id is hardcoded in logic, `purity` proves the strategy is deterministic, `transport` proves the Sui client is constructed in exactly one place per package.

**Current state, honestly.** The Move package is complete and published; the keeper is complete, CLI included; the app builds, ships three real screens and has its own test suite. **704 tests across the three layers** (snapshot — the suites were still growing during this pass). Three things are open:

- the **exit-amount form** on `/exit` is a placeholder (T3.2), and the landing-page stats are still hardcoded (T5.2) — 4 `TODO(Tx.y)` markers in two files, the whole remaining backlog;
- the **`ids` gate fails** on two hardcoded Hashi ids in `scripts/register-deposit.ps1`, so `verify-all.ps1` is `7 PASS · 1 FAIL`;
- the **`hBTC/DBUSDC` book is empty on both sides** and we can mint neither hBTC (`treasury::mint` is `public(package)`) nor DBUSDC (its `TreasuryCap` is address-owned) — an inventory blocker, handled everywhere as a *defined* state rather than a crash.

See **`docs/STATUS.md`** for the per-task ledger and the verbatim run log, and **`docs/DEMO.md`** for what that means on stage.

---

## Doc read order

1. **`docs/RECON.md`** — verified ground truth from live probes, R1–**R14**. **Never re-derive anything in it.** R14 is the newest and the most dangerous to get wrong: Hashi has **no deposit relayer**, `utxo_id` takes the txid **byte-reversed** from what explorers display, and a mempool txid can be RBF-replaced out from under you — all three fail *silently*.
2. **`docs/GOLDEN-RULES.md`** — G1–G10 with RULE / WHY / **NEVER**. Read before any Hashi/DeepBook/oracle claim or line of code.
3. **`docs/CONVENTIONS.md`** — the contract banner every source file carries.
4. **`docs/FACTS.md`** — canonical IDs, coin types, signatures, latencies, events. Cite by anchor.
5. **`docs/DEPLOYED.md`** — what we actually published on testnet, with digests and envelope parameters. The ids the `.env` files are wired to.
6. **The layer spec for your task** — `docs/MOVE-PACKAGE.md` · `docs/KEEPER.md` · `docs/APP.md`. **Read each one's `ERRATA (2026-07-25)` section first — it wins over the body above it.**
7. **`docs/STATUS.md`** — per-task ledger, environment, known blockers, verbatim run log.
8. **`docs/ULTRACODE-BRIEF.md`** — the entry document for an implementation run: work-remaining census, full VERIFY matrix, the complete errata digest, and the prohibitions.
9. **`docs/DEMO.md`** — the runbook: minute-by-minute script, what is live vs pre-staged, the fallback, and the things we must never say.
10. `docs/BUILD-PLAN.md` (execution order + the CUT LINE) · `docs/DEPLOY.md` (shipping `app/` to Vercel) · `docs/ARCHITECTURE.md` · `docs/DAY-ONE.md` / `docs/DAY-ONE-RESULTS.md`.

Design rationale, not build specs: `HASHI_INTEGRATION.md` (authoritative deltas) and `README (8).md` (base product design).
**`BTC_FIXED_INCOME.md` is a shelved alternative ("Meridian" bond) — do not implement it.**

**Conflict resolution:** layer-spec ERRATA > `docs/RECON.md` > `docs/FACTS.md` > layer-spec body > `HASHI_INTEGRATION.md` > `README (8).md`.

---

Built for ETHGlobal Lisbon 2026, Sui track. Sui **testnet** + Bitcoin **signet**. Not audited, not for mainnet funds.
