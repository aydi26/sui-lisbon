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

| Path | What |
|---|---|
| `move/` | Move 2024 package **`aphotic`** — `vault` (shares, NAV, `seal_approve`), `gateway` (**the only** Hashi boundary), `envelope` (redemption buffer + limiter replay), `router` (DeepBook maker/IOC), `journal`. Tests in `move/tests/`. |
| `keeper/` | TypeScript ESM keeper — `hashi/` (adapter + deterministic mock + real), `strategy/`, `routing/`, `execution/`, `oracle/`, `storage/`, `journal/`, `verify/`, `privacy/`, `sui/`, `util/`. |
| `app/` | React 19 + Vite — `/` landing, `/deposit`, `/exit`, `/transparency`. |
| `scripts/` | `gates.ps1` / `gates.sh` (invariant gates), `verify-all.ps1` (master gate), `verify-onchain.mjs` (live testnet assertions). |
| `docs/` | All specifications. See the read order below. |

**Canonical on-chain IDs may appear in exactly four places** (G7): `keeper/src/config.ts`, `app/src/config.ts`, the `.env.example` files, `move/Move.toml`. Everywhere else they arrive as config.

---

## Quickstart

Prereqs: `sui` **1.76.0** (`sui client active-env` = `testnet`, gas-funded), Node **≥ 18** (tested on 24.13.0).

```bash
# Move package
cd move && sui move build && sui move test

# Keeper (ESM, "type": "module")
cd keeper && npm install && npm run build && npm test

# App
cd app && npm install && npm run build
cd app && npm run dev            # http://localhost:5173
```

Copy `keeper/.env.example` → `keeper/.env` and `app/.env.example` → `app/.env`. `keeper/.env` is gitignored and is the **only** file that may ever hold a private key (`sui keytool export --key-identity <alias>`).

**Everything runs offline.** The Hashi surface is isolated behind an adapter with a deterministic, logical-clock mock (no `Date.now()`, no `Math.random()`, no I/O), so the whole system builds and tests green with no live bridge.

---

## VERIFY matrix

```bash
powershell -NoProfile -File scripts/verify-all.ps1      # the master gate — runs all 8 steps
```

| Command | Green means |
|---|---|
| `cd move && sui move build` | Package `aphotic` compiles, edition `2024.beta`, **zero warnings** |
| `cd move && sui move test` | All `move/tests/*_tests.move` pass |
| `cd keeper && npm run typecheck` | `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` |
| `cd keeper && npm run build` | Emits runnable ESM to `dist/` with `.d.ts` + sourcemaps |
| `cd keeper && npm test` | Full vitest suite |
| `cd app && npm run build` | `tsc --noEmit && vite build` |
| `powershell -File scripts/gates.ps1` (or `bash scripts/gates.sh`) | 8 invariant gates: `g7` `g4` `g2` `ids` `sdk` `purity` `transport` `todo` |
| `node scripts/verify-onchain.mjs` | Every canonical id, config scalar, event stream and the Pyth Beta feed match FACTS **live on testnet** (needs network) |

The gates are the interesting part: `g7` proves `hashi::` appears in exactly one Move file, `g2` proves no exit function takes a Bitcoin address, `ids` proves no canonical id is hardcoded in logic, `purity` proves the strategy is deterministic, `transport` proves the Sui client is constructed in exactly one place per package.

**Current state:** the repo is scaffolded and all 8 steps pass, but Phases 1–5 are **stubs** — 322 `TODO(Tx.y)` markers across 24 task ids. A green build is not coverage. See **`docs/STATUS.md`** for the honest per-task ledger.

---

## Doc read order

1. **`docs/RECON.md`** — verified ground truth from live probes. **Never re-derive anything in it.**
2. **`docs/GOLDEN-RULES.md`** — G1–G10 with RULE / WHY / **NEVER**. Read before any Hashi/DeepBook/oracle claim or line of code.
3. **`docs/CONVENTIONS.md`** — the contract banner every source file carries.
4. **`docs/FACTS.md`** — canonical IDs, coin types, signatures, latencies, events. Cite by anchor.
5. **The layer spec for your task** — `docs/MOVE-PACKAGE.md` · `docs/KEEPER.md` · `docs/APP.md`. **Read each one's `ERRATA (2026-07-25)` section first — it wins over the body above it.**
6. **`docs/STATUS.md`** — per-task ledger, environment, known blockers.
7. **`docs/ULTRACODE-BRIEF.md`** — the entry document for the implementation run: work-remaining census, full VERIFY matrix, the complete errata digest, and the prohibitions.
8. `docs/BUILD-PLAN.md` (execution order + the CUT LINE) · `docs/ARCHITECTURE.md` · `docs/DAY-ONE.md` / `docs/DAY-ONE-RESULTS.md`.

Design rationale, not build specs: `HASHI_INTEGRATION.md` (authoritative deltas) and `README (8).md` (base product design).
**`BTC_FIXED_INCOME.md` is a shelved alternative ("Meridian" bond) — do not implement it.**

**Conflict resolution:** layer-spec ERRATA > `docs/RECON.md` > `docs/FACTS.md` > layer-spec body > `HASHI_INTEGRATION.md` > `README (8).md`.

---

Built for ETHGlobal Lisbon 2026, Sui track. Sui **testnet** + Bitcoin **signet**. Not audited, not for mainnet funds.
