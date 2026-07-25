# ARCHITECTURE.md

Purpose: the authoritative system model for Aphotic × Hashi — component map, object/capability graph, and the four end-to-end data flows — so the coding agent builds the right boundaries the first time.
Read after: docs/FACTS.md (all exact IDs/types live there; this file references them by anchor, never re-states them as new truth).

> All object IDs, coin types, Move signatures, and latencies are canonical in **docs/FACTS.md**. When this file needs one it links `docs/FACTS.md#<anchor>`. If a value appears here inline it is illustrative shape only — the number of record is FACTS.md.

---

## 0. Golden rules this document encodes (front-loaded)

| # | Rule | Where enforced in this model |
|---|------|------------------------------|
| G1 | hBTC is a fungible `Coin<BTC>`; on-Sui movement is instant (1 checkpoint). BTC/Guardian latency exists ONLY at mint(deposit)/burn(withdraw). | §4 flows: Sui legs are synchronous; only the two Bitcoin boundaries are async. |
| G2 | Keeper holds ONLY DeepBook `TradeCap` — never `WithdrawCap`/`DepositCap`. Exits composed in Move to an on-chain-pinned address. | §2 capability model; §3 object graph; Flow 3. |
| G3 | You cannot buy priority in Hashi's global withdrawal queue; over-capacity batches are REJECTED, not queued. | §5 trust table; envelope treats limiter as a *buffer input*, never a priority lever. |
| G4 | No Cetus hBTC pool. Router = DeepBook maker `POST_ONLY` + IOC sweep on the same book. | §1 diagram (no Cetus node for BTC vault); Flow 2. |
| G5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity()` over the `WithdrawalSigned` event stream — not a trusted SDK read. | §5 trust table row "limiter"; Flow 4 verify. |
| G6 | The BTC leg (deposit ~70 min, withdraw ~1.5–2 h) is NEVER live-demoable. Pre-stage; Sui side is instant. | §4 latency column; §6 demo boundary. |
| G7 | Isolate the entire Hashi surface behind an adapter with a deterministic MOCK from line one; on-chain Hashi calls confined to `gateway.move`; all IDs configurable. | §1 boundary box; §2 module table; §7. |
| G8 | Honesty: hBTC IS custodial-threshold wrapped BTC. Differentiation = composing the bridge's on-chain machinery, not the token trust model. | §5 trust table header + Hashi-custody row. |
| G9 | Pin Pyth versions, use Beta feed on testnet, value NAV at DeepBook mid (depeg defence), staleness guards. | §3 oracle node; Flow 2 NAV. |
| G10 | Move 2024 edition idioms throughout. | All Move modules in §2. |

---

## 1. Component diagram (system map)

Left edge = Bitcoin/signet is the ONLY asynchronous boundary. Everything from `gateway.move` rightward is on-Sui and synchronous per checkpoint (G1).

```
  ══════════════ ASYNC (Bitcoin latency lives here ONLY — G1/G6) ══════════════
  ┌──────────────┐        ┌───────────────────────────────────────────────┐
  │ BITCOIN      │  UTXO  │ HASHI  (MystenLabs native-BTC orchestrator)   │
  │ signet       │◄──────►│  • MPC threshold-Schnorr (validator subset)   │
  │ P2TR deposit │        │  • Guardian enclave (2-of-2 co-sign)          │
  │ P2WPKH/P2TR  │        │  • OFF-CHAIN token-bucket rate limiter        │
  │ payout addr  │        │      (LocalLimiter; replayable — G5)          │
  └──────────────┘        │  Hashi shared object  (see FACTS.md#hashi)    │
     ~70min deposit       │  emits: Minted/Burned, Deposit*, Withdrawal*  │
     ~1.5-2h withdraw     └───────────────┬───────────────────────────────┘
  ═══════════════════════════════════════ │ ══════════ SYNC below (on-Sui) ═══
                                           │  request_withdrawal(Balance<BTC>, addr)
                                           │  deposit / confirm_deposit (PTB)
                                           │  Coin<BTC> mint→recipient
                     ┌─────────────────────▼─────────────────────┐
   ┌───── APP ─────┐ │  gateway.move   (ONLY module touching     │
   │ React+Vite    │ │  Hashi on-chain — G7)                     │
   │ zkLogin       │ │  register_exit_address · exit_to_bitcoin  │
   │ generate-     │ │  reclaim_stalled_exit · small-exit pool   │
   │ DepositAddr   │ └─────────────────────┬─────────────────────┘
   │ deposit/exit/ │                       │ split/merge Balance<BTC>, shares
   │ transparency  │       ┌───────────────▼───────────────────────────┐
   └──────┬────────┘       │  VAULT  (Sui SHARED object)                │
          │ zkLogin +      │   • share accounting, sats-denominated NAV │
          │ sponsored tx   │   • btc_exit_address pinned per depositor  │
          ▼                │   • strategy ciphertext + Walrus blob id   │
   ┌─────────────┐         │   • DeepBook BalanceManager (owns caps)    │
   │ SEAL        │◄──seal_ │   • envelope.move: constraint checks       │
   │ t-of-n key  │  approve│       incl. redemption buffer (G3)         │
   │ servers     │   gate  │   • journal.move: decision blob ids on-ch. │
   └─────────────┘         └──────┬───────────────────────┬────────────┘
          ▲                       │ issues TradeCap ONLY  │ router.move
          │ ciphertext            │ (G2)                  │ maker+IOC
   ┌──────┴───────┐        ┌───────▼─────────┐   ┌─────────▼──────────────────┐
   │ WALRUS       │◄──log──│ KEEPER          │   │ DeepBook v3                │
   │ decision log │        │ off-chain,      │   │ Pool<hBTC, DBUSDC>         │
   │ + strategy   │──get──►│ deterministic   │──►│ (see FACTS.md#deepbook)    │
   │ ciphertext   │        │ TradeCap only   │   │ POST_ONLY maker + IOC (G4) │
   └──────────────┘        │ evaluate/route  │   │ NO Cetus leg (G4)          │
                           │ confirm_deposit │   └────────────────────────────┘
                           │ crank; exit PTB │            ▲
                           └────────┬────────┘            │ divergence breaker (G9)
                                    │ oracle read   ┌──────┴──────────────────┐
                                    └──────────────►│ Pyth BTC/USD (Beta feed)│
                                                    │ vs DeepBook TWAP        │
                                                    └─────────────────────────┘
```

Node responsibilities (one line each; identifiers in docs/FACTS.md):

| Node | Role | Trust (see §5) |
|------|------|----------------|
| Bitcoin/signet | Native BTC in/out; deposit P2TR + payout P2WPKH/P2TR. | external chain |
| Hashi (MPC+Guardian) | Wraps/unwraps BTC↔`Coin<BTC>`; custody = threshold + Guardian; runs the off-chain limiter. | custodial-threshold (G8) |
| `gateway.move` | The ONLY on-chain caller of Hashi; composes pinned exits, reclaim, small-exit pooling (G7). | trustless-on-chain |
| Vault (shared) | Share/NAV accounting, exit-address pinning, seal_approve, BalanceManager custody, envelope, journal. | trustless-on-chain |
| DeepBook v3 | Sole execution venue; maker + IOC on `Pool<hBTC,DBUSDC>` (G4). | trustless-on-chain |
| Keeper | Off-chain deterministic strategy exec; TradeCap only; runs crank; builds exit PTBs. | keeper-attested (bounded by envelope) |
| Seal | seal_approve gate; identity = vault object + version epoch. | trustless gate + threshold assumption |
| Walrus | Decision log + versioned strategy ciphertext; blob ids emitted on-chain. | content-addressed (self-certifying) |
| App | zkLogin onboarding, deposit-address derivation, lifecycle UI, transparency. | client, untrusted |
| Pyth + TWAP | NAV/divergence circuit breaker; value NAV at DeepBook mid (G9). | oracle (pinned + staleness-guarded) |

---

## 2. Capability model (who can do what)

The whole security thesis: **a fully compromised keeper can trade but can NEVER move funds out or redirect an exit** (G2). This is achieved by capability partitioning + Move-composed pinned exits.

| Cap / authority | Holder | Grants | Explicitly CANNOT |
|-----------------|--------|--------|-------------------|
| DeepBook `TradeCap` | Keeper | place/cancel orders on `Pool<hBTC,DBUSDC>` | move funds out of BalanceManager; withdraw; deposit |
| DeepBook `WithdrawCap` | Vault (held in-object; never delegated) | move funds out of BalanceManager | reachable by keeper key |
| DeepBook `DepositCap` | Vault (in-object) | credit BalanceManager | reachable by keeper key |
| Vault owner authority | Owner key | create vault, global pause, emergency withdraw (never keeper-gated), rotate keeper (bumps version epoch) | read plaintext strategy is NOT special — Seal threshold governs that |
| `seal_approve` gate | Move code in `vault.move` | authorizes a Seal key-share release iff caller/context matches vault + version epoch | be bypassed by keeper alone (needs t-of-n servers to agree) |
| Exit composition | `gateway.move` ONLY (G7) | `request_withdrawal(Balance<BTC>, pinned_addr)` inside the burn PTB | send to any address other than the on-chain-pinned `btc_exit_address` |
| Hashi `confirm_deposit` | ANYONE (permissionless) | mint pending `Coin<BTC>` to the UTXO-derivation recipient | choose a different recipient (fixed by derivation path) |

Move modules (package name `aphotic`, Move 2024 — G10). Emit an event on every externally-visible state transition; error constants `E<Reason>`; amounts in sats (`u64`):

| Module | Responsibility | Touches Hashi? |
|--------|----------------|----------------|
| `vault` | shared `Vault` object; share/NAV accounting (sats); `seal_approve`; holds BalanceManager + Withdraw/DepositCap; pins `btc_exit_address` per depositor (immutable after first set). | no |
| `gateway` | Hashi boundary: `register_exit_address`, `exit_to_bitcoin`, `reclaim_stalled_exit`, small-exit pooling under 30,000-sat minimum. | YES — the only one |
| `envelope` | constraint checks incl. redemption buffer (deployable hBTC ≤ f(idle, pending exit demand)); trustless limiter-replay hooks (G3/G5). | reads Hashi shared object getters if present; else static buffer |
| `router` | DeepBook maker `POST_ONLY` + IOC sweep entrypoints (G4). | no |
| `journal` | emits decision-log Walrus blob ids on-chain (self-certifying pointers). | no |

Keeper directories (TypeScript, ESM) — Hashi surface isolated behind an adapter with a deterministic MOCK from line one (G7):

`hashi/` (adapter iface + mock + real; mock mirrors `project_capacity()` exactly) · `strategy/` (Seal encrypt/decrypt, deterministic `evaluate()`/`route()`, padded serializer) · `routing/` (DeepBook L2 book, maker/IOC split) · `execution/` (PTB build, `confirm_deposit` crank, `exit_to_bitcoin`, sponsored deposit sweep) · `oracle/` (Pyth Beta + DeepBook TWAP divergence breaker) · `storage/` (Walrus put/get + lifetime renewal) · `journal/` (decision records) · `verify/` (replay engine incl. trustless limiter re-derivation) · `privacy/` (Seal session keys, version-epoch rotation).

---

## 3. Object graph

```
Vault (shared object)  ──owns──►  DeepBook BalanceManager
   │                                  ├─ WithdrawCap  (in-object, NEVER delegated)
   │                                  ├─ DepositCap   (in-object)
   │                                  └─ TradeCap     ──delegated──► KEEPER key
   ├─ field: btc_exit_address[depositor] : vector<u8>   (20B P2WPKH | 32B P2TR; immutable)
   ├─ field: strategy_ciphertext + walrus_blob_id
   ├─ field: version_epoch  (Seal identity component; ++ on keeper rotation / revocation)
   └─ field: NAV accounting (sats, u64) valued at live DeepBook mid (G9)

Seal identity  =  namespace(Vault object id, version_epoch)      // rotation/revocation lever
   seal_approve(vault, ctx)  → dry-run gate; t-of-n servers release shares only if it passes

Hashi shared object (external)   see FACTS.md#hashi
   Coin<BTC> (fungible; 8 decimals; sats)   see FACTS.md#hbtc     // standard coin, freely split/merged
   Pool<hBTC, DBUSDC> (external)             see FACTS.md#deepbook

Walrus blobs (content-addressed; ids emitted on-chain by journal.move)
   ├─ strategy ciphertext (versioned; encrypt-before-upload always)
   └─ decision-log segments (oracle read, book snapshot, hashi fields, ruleset hash, decision)

Pyth BTC/USD state + Wormhole state (external; PIN versions, Beta feed on testnet)  see FACTS.md#oracle
```

Key invariants of the graph:
- The keeper key appears in exactly ONE edge: `TradeCap`. No path from the keeper key reaches `WithdrawCap` or `request_withdrawal` (G2).
- `btc_exit_address` is set once per depositor (`register_exit_address`) and is immutable; `exit_to_bitcoin` reads it as the withdrawal destination — the keeper never supplies a destination (G2).
- Seal identity binds to `version_epoch`; bumping it invalidates all previously derived key shares — the correct revocation primitive (a bare `set_keeper` would not do this).

---

## 4. End-to-end data flows

Latency legend: **[SYNC]** = one Sui checkpoint (instant, G1). **[ASYNC-BTC]** = Bitcoin/Guardian latency, pre-stage for demo (G6).

### Flow 1 — Deposit → hBTC mint → sponsored sweep to shares

| Step | Actor | Action | Latency |
|------|-------|--------|---------|
| 1 | App (client) | zkLogin → Sui address; `generateDepositAddress({suiAddress})` derives personal P2TR client-side (no server). | [SYNC] |
| 2 | User | Sends BTC (≥ 30,000 sats) to the derived P2TR from any wallet. | [ASYNC-BTC] |
| 3 | Keeper (`hashi/`+`execution/`) | PTB `deposit(utxo)` registration; then Hashi committee approve after 6 confs + sanctions + 10-min delay. | [ASYNC-BTC] ~70 min total |
| 4 | Keeper (crank) | Permissionless `confirm_deposit(request_id)` — runs for ALL Hashi users (public good). Mints `Coin<BTC>` to the derivation-encoded recipient. | [SYNC] once eligible |
| 5 | Keeper (sponsored PTB) | Sweeps minted hBTC into Vault shares; owner never needs SUI for gas (sponsored tx). | [SYNC] |
| 6 | App | `view.depositStatus` / `waitForDeposit` walks the six-stage lifecycle in the UI. | UI polling |

Pin: exit-address registration (`register_exit_address`, Flow 3 step 0) SHOULD happen at/near deposit so the pinned destination exists before any exit. Stretch: derivation keyed to a per-user "deposit ticket" object id → mint lands via transfer-to-object, vault claims with `public_receive` (gated by day-one check; see docs/FACTS.md).

### Flow 2 — Strategy evaluate → route → maker/IOC on DeepBook

| Step | Actor | Action | Notes |
|------|-------|--------|-------|
| 1 | Keeper (`privacy/`) | Seal session key + `seal_approve` gate → decrypt strategy (identity = vault + version_epoch). | threshold t-of-n |
| 2 | Keeper (`oracle/`) | Read Pyth BTC/USD (Beta feed, pinned) + DeepBook TWAP; if divergence > threshold → REFUSE (circuit breaker, G9). | staleness-guarded |
| 3 | Keeper (`strategy/`) | Deterministic `evaluate()` over: book snapshot, pending mint/burn queue (Hashi events), limiter status, encrypted params (spread/skew/flow-sensitivity/buffer). | peg-flow maker |
| 4 | `envelope.move` | On-chain constraint check incl. redemption buffer: deployable hBTC ≤ f(idle, pending exit demand) (G3). Rejects over-deployment. | Move-enforced |
| 5 | Keeper (`routing/`) | `route()` splits into maker `POST_ONLY` leg + IOC sweep residual on the SAME `Pool<hBTC,DBUSDC>` (G4 — no Cetus). | maker-first |
| 6 | Keeper (`execution/`) | Build PTB using `TradeCap` ONLY; place/cancel orders. | cannot move funds (G2) |
| 7 | `journal.move` | Emit decision-log blob id after Walrus write (Flow 4). | self-certifying |

NAV is always valued at the live DeepBook mid, not oracle, because hBTC can depeg below BTC on the thin book precisely when exits throttle (G9).

### Flow 3 — Exit → burn shares → `gateway.exit_to_bitcoin` → `request_withdrawal` to pinned address

| Step | Actor | Action | Latency |
|------|-------|--------|---------|
| 0 | Depositor (once) | `register_exit_address(addr)` — 20B P2WPKH or 32B P2TR — pinned immutable in Vault. | [SYNC] |
| 1 | Depositor → `gateway.exit_to_bitcoin` | ONE atomic PTB: burn shares → split `Balance<BTC>` from vault → `request_withdrawal(hashi, clock, balance, pinned_addr, ctx)`. Keeper cannot participate in this path. | [SYNC] on Sui |
| 2 | Hashi | Emits `WithdrawalRequested`; batches (~10 min or threshold); Guardian+MPC sign; broadcast; 6 confs. | [ASYNC-BTC] ~1.5–2 h |
| 3 | App | Sui-side confirmation instant; signet txid surfaced when broadcast (`waitForWithdrawal`). | UI |
| Alt | `gateway.reclaim_stalled_exit` | Wraps `cancel_withdrawal` (requester-only, pre-commit Requested/Approved, 1h cooldown) → returns `Balance<BTC>` to vault, re-credits shares. | [SYNC] |
| Small | `gateway` small-exit pool | Exits < 30,000 sats accumulate per-user until they clear the Hashi minimum, or user opts to take hBTC directly. | — |

Hard constraints baked into this flow: min withdrawal 30,000 sats; Bitcoin dust floor 546 sats; over-capacity limiter batches are REJECTED (`RateLimitExceeded`), NOT queued, and priority CANNOT be bought (G3). The destination is the on-chain-pinned address only — a compromised keeper or frontend cannot redirect (G2).

### Flow 4 — journal → Walrus → verify replay (incl. trustless limiter re-derivation)

| Step | Actor | Action |
|------|-------|--------|
| 1 | Keeper (`journal/`) | Build decision record: oracle read (Pyth id+seq), L2 book snapshot, `strategy_blob` id in force, ruleset content hash, decision (range/δ/maker-IOC split or no-op cause), result (digest/reason), + Hashi fields (limiter reading, queue depths, pending-mint total). |
| 2 | Keeper (`storage/`) | Encrypt-before-upload where needed; write segment to Walrus with explicit `WALRUS_EPOCHS`; renewal task extends lifetime before expiry. |
| 3 | `journal.move` | Emit the Walrus blob id on-chain (content-addressed → self-certifying pointer). |
| 4 | Verifier (`verify/`) | Fetch segments; re-run published decision function against recorded inputs; report any non-reproducing decision. |
| 5 | Verifier (limiter) | **Re-derive limiter trajectory TRUSTLESSLY**: replay `project_capacity() = min(cap, tokens + elapsed·refill_rate)` over the on-chain `WithdrawalRequested / PickedForProcessing / Signed` event stream — NOT a trusted SDK read (G5). Confirms "the bridge was tightening when we pulled quotes." Only `refill_rate` + `max_bucket_capacity` are trust anchors, both observationally boundable. |

Two verification tiers (honest): routing-correctness is publicly checkable from δ + book snapshot without plaintext; trigger-correctness needs the strategy plaintext (owner or granted). Version epoch lets an owner disclose ONE historical version without exposing the live one.

---

## 5. Trust-boundary table

Header truth (G8): **hBTC IS custodial-threshold wrapped BTC.** Aphotic's differentiation is composing the bridge's on-chain machinery (pinned exits, trustless envelope, permissionless crank, peg-flow signal), NOT the token's trust model.

| Component / claim | Trustless on-chain | Keeper-attested (bounded) | Off-chain / external trust |
|-------------------|:------------------:|:-------------------------:|:--------------------------:|
| Share/NAV accounting (`vault.move`) | ✅ (NAV at DeepBook mid) | — | — |
| Exit destination pinning (`btc_exit_address`) | ✅ immutable, Move-read | — | — |
| Exit composition (`gateway.exit_to_bitcoin`) | ✅ atomic PTB, `public fun` | — | — |
| Keeper order placement | — | ✅ TradeCap only; can't move funds (G2) | — |
| Constraint envelope incl. redemption buffer | ✅ Move-enforced | — | reads Hashi getters if present, else static buffer |
| Decision log integrity | ✅ blob id on-chain, content-addressed | log *contents* attested by keeper | Walrus storage liveness |
| Routing correctness | ✅ publicly replayable from δ+book | — | — |
| Trigger correctness | — | needs plaintext (owner/granted) | Seal threshold assumption |
| **Guardian rate limiter** | ⚠️ state lives OFF-CHAIN (no on-chain limiter state) **BUT** ✅ TRUSTLESSLY REPLAYABLE via `project_capacity()` over on-chain `WithdrawalSigned` stream (G5) | — | 2 genesis scalars (`refill_rate`, `max_bucket_capacity`) — observationally boundable |
| BTC custody (mint/burn) | — | — | Hashi MPC threshold-Schnorr + Guardian 2-of-2 (G8) |
| Bitcoin settlement | — | — | signet network, 6 confs |
| Pyth oracle | ✅ on-chain read, pinned versions | — | Pyth publishers + Beta feed (staleness-guarded, G9) |
| zkLogin onboarding | — | — | Google OIDC + salt/prover service |
| App frontend | — | — | untrusted client; cannot redirect exits (G2) |

The single most important row: the limiter is off-chain state, but its trajectory is NOT a trusted SDK read — it is independently re-derivable from Hashi's own on-chain event stream (G5). Frame it that way everywhere.

---

## 6. Demo/latency boundary (build implication)

The vertical ASYNC line in §1 is the pre-staging boundary. Everything RIGHT of it (gateway → vault → DeepBook → keeper → Seal/Walrus) is live-demoable and instant. Everything LEFT of it (Bitcoin confirmations, deposit ~70 min, withdrawal ~1.5–2 h) is pre-staged; the demo shows an EARLIER confirmed signet tx and runs the permissionless `confirm_deposit` crank live as the only real on-chain BTC-side transition (G6). Keep 2–3 confirmed hBTC deposits and one broadcast withdrawal warm at all times.

---

## 7. Boundary discipline (do this from line one)

1. Entire Hashi surface behind `hashi/` adapter interface + deterministic MOCK; mock mirrors `project_capacity()` exactly (G5/G7).
2. On-chain Hashi calls confined to `gateway.move` — no other module imports Hashi (G7).
3. All object IDs / coin types / feed ids configurable via env/config, NEVER hardcoded in logic (G7). Values of record: docs/FACTS.md.
4. Keeper key touches only `TradeCap`; owner key holds emergency/pause; verify no code path lets the keeper key reach `WithdrawCap` or `request_withdrawal` (G2).
5. Pin Pyth package/state versions; use Beta feed on testnet; NAV at DeepBook mid; staleness guards (G9).

---

## Cross-references

- Exact IDs/types/signatures/latencies → **docs/FACTS.md** (`#hbtc`, `#hashi`, `#deepbook`, `#oracle`, `#seal`, `#walrus`, `#latencies`, `#limiter`).
- Design rationale / mechanisms / demo script → `HASHI_INTEGRATION.md` (mechanism #2 is the trustless-replay envelope; §8 demo).
- Base Aphotic (Seal/Walrus/DeepBook/zkLogin/keeper/envelope) → `README (8).md`.
- Shelved alternative (NOT the build) → `BTC_FIXED_INCOME.md` (Meridian bond) — reference only.
- Module-level contracts / signatures for `vault`/`gateway`/`envelope`/`router`/`journal` → see the Move-spec doc when authored (resolve exact spec anchor in DAY-ONE.md; owner: Move lead).

---

## ERRATA (2026-07-25)

> Source: `docs/DAY-ONE-RESULTS.md` (live probes) + `docs/RECON.md`. Canonical values live in `docs/FACTS.md`.
> **Where this section conflicts with the body of ARCHITECTURE.md above, this section wins.** Each item is WAS / IS / WHY.

### E-R1 — §5 trust-boundary table: reclaim is DEPOSITOR-ONLY (missing row)

- **WAS:** the table has no row for the reclaim path, and §2's capability model does not state who may cancel a withdrawal.
- **IS:** add this row, and treat it as a first-class trust-boundary fact rather than an implementation detail:

  | Component / claim | Trustless on-chain | Keeper-attested (bounded) | Off-chain / external trust |
  |-------------------|:------------------:|:-------------------------:|:--------------------------:|
  | **Exit reclaim (`gateway.reclaim_stalled_exit`)** | ✅ **DEPOSITOR-ONLY, enforced by Hashi itself** — `cancel_withdrawal` asserts `request.sender == ctx.sender()`; the keeper **cannot** call it, and neither can the app on the user's behalf | — | — |

- **WHY:** `hashi::withdraw::cancel_withdrawal` is sender-bound; the request sender is whoever signed the `request_withdrawal` PTB. This **strengthens** the G2 thesis — it is not merely that the keeper won't redirect funds, it is that the keeper cannot even *unwind* a user's exit. It also imposes an architectural constraint that must be visible here, not buried in the Move spec: **any pooled small-exit flush must assert `who == ctx.sender()`**, otherwise the flusher becomes the sole party able to reclaim. Source- and bytecode-verified: `docs/FACTS.md#hashi-move-api`, `docs/RECON.md` R7.3.

### E-R2 — §5 "reads Hashi getters if present, else static buffer" — no getters exist

- **WAS:** the constraint-envelope row's external-trust cell reads "reads Hashi getters if present, else static buffer", leaving the branch open.
- **IS:** **there are no getters.** All 46 `hashi::withdrawal_queue` accessors and all 15 `hashi::btc_config` accessors are `public(package)` on the deployed bytecode (only `withdrawal_queue::output_utxo` is `Public`). The cell should read: *"static redemption-buffer ratio + off-chain event replay — unconditional; no on-chain Hashi read is possible."*
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D2. Note this **improves** the architecture's honesty: there is no hidden dependency on a bridge getter, and `envelope.move` has one code path instead of two.

### E-R3 — §5 limiter row: the two genesis scalars are no longer unknown

- **WAS:** "2 genesis scalars (`refill_rate`, `max_bucket_capacity`) — observationally boundable" as an open external-trust item.
- **IS:** both are **read live** from the guardian's read-only `GET {guardian_url}/info` — `refill_rate = 115_740` sats/s, `max_bucket_capacity = 10_000_000_000` sats (**100 BTC**). They remain the only trust anchors of the replay, and they remain observationally boundable; they are simply no longer *unknown*. The endpoint is **HTTP/2 only** (HTTP/1.1 returns 464), and it reports the **raw last-consume state**, not a projected balance — the caller runs `project_capacity` itself, which is exactly the shape §4 Flow 4 assumes.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D4, `docs/FACTS.md#guardian-limiter`.
  ⚠ **Narrative adjustment for the pitch (G8).** A 100 BTC bucket refilling ~100 BTC/day means an Aphotic-sized exit will **never** be rate-limited on testnet. Do not frame the bridge-aware envelope as protecting against congestion we would actually hit. The claim that survives scrutiny is the one this table already makes: the limiter's trajectory is **independently re-derivable from Hashi's own on-chain events**, and that is checkable by anyone. Keep the row; change the story around it.

### E-R4 — §4 Flow 4: `WithdrawalSigned` cannot advance the bucket on its own

- **WAS:** Flow 4 / §5 describe the replay as driven by the `WithdrawalSigned` stream.
- **IS:** correct in spirit, incomplete in fact. `WithdrawalSigned { guardian_signatures, request_ids, signatures, withdrawal_txn_id }` carries **no amount and no timestamp**. The replay is a **join**: sats come from `WithdrawalRequested.btc_amount` matched on `request_ids` (use the *requested* amount — `withdrawal_outputs[i].amount` is net of the Bitcoin network fee), and the timestamp comes from the **Sui event envelope** `timestampMs`. Flow 4 therefore consumes **two** event streams, not one.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10b, `docs/FACTS.md#events`. This is a component-diagram-level fact: the `verify/` box needs an index built from `WithdrawalRequested` before it can walk `Signed`.

### E-R5 — §1/§3 transport: the fullnode is gRPC-only

- **WAS:** the component diagram implies a generic "Sui RPC" edge.
- **IS:** `https://fullnode.testnet.sui.io:443` serves **gRPC v2 only** and returns **HTTP 404** for JSON-RPC. `SuiGrpcClient` is the default transport, constructed in exactly one place (`keeper/src/sui/client.ts`); JSON-RPC mirrors (`https://rpc-testnet.suiscan.xyz:443`) are probe-only. Separately, the Hashi guardian requires **HTTP/2**.
- **WHY:** `docs/FACTS.md#rpc-transport`, `docs/RECON.md` R1. Worth showing on the diagram because it is the kind of thing that silently costs an afternoon.

### E-R6 — §2 capability model: the DeepBook cap split is verified, and `confirm_deposit` is PTB-only

- **WAS:** the capability model asserts the `TradeCap`-only keeper (G2) and lists `confirm_deposit` among the Hashi touchpoints.
- **IS:** two confirmations and one correction.
  - **Confirmed on-chain:** `balance_manager::{new, mint_trade_cap, mint_deposit_cap, mint_withdraw_cap, revoke_trade_cap}` and `generate_proof_as_trader(&mut BalanceManager, &TradeCap, &TxContext): TradeProof` all exist and are independent. A shared `BalanceManager` + owned `TradeCap` dry-runs green. G2 is implementable exactly as drawn.
  - **Correction:** `hashi::deposit::{deposit, confirm_deposit, approve_deposit, delete_expired_deposit}` are `visibility=Private, isEntry=true` — **PTB commands, not Move-callable.** The permissionless crank is an arrow from the *keeper/app* to Hashi, never from `gateway.move` to Hashi. The **entire** Move-composable Hashi surface is two functions: `request_withdrawal` and `cancel_withdrawal`. The G7 boundary is therefore narrower — and easier to hold — than the diagram implies.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D2/§D3c, `docs/FACTS.md#hashi-move-api`, `#deepbook-venue`.

### E-R7 — §6 demo/latency boundary: measured numbers, unchanged conclusion

- **WAS:** "deposit ~70 min, withdrawal ~1.5–2 h" as the pre-staging boundary.
- **IS:** one real observed withdrawal: `Requested → Approved` +10 s, `→ PickedForProcessing` +5.1 min, `→ Signed` **+5.4 min**, `→ Confirmed` **+57.9 min**. Keep the conservative planning figures (single quiet-signet sample), but the warm-inventory window is likely tighter than feared.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10e. **G6 stands unchanged** — 58 minutes is still far outside a 3-minute demo; the boundary does not move.
- **New hard dependency to draw on the diagram:** the hBTC/DBUSDC book is **empty on both sides** and hBTC **cannot be minted by us** (`treasury::mint` is `public(package)`). The scripted book-seeder account is therefore a **required component**, not a demo convenience — NAV, the router, and the transparency panel all have nothing to read without it, and seeding it depends on the signet faucet drip completing first.

### E-R8 — doc hygiene: a stray unmatched code fence was removed

- **WAS:** the last line of the §Cross-references list was a bare `````` with no opening fence.
- **IS:** removed.
- **WHY:** it opened a code block that swallowed everything appended after it (including this ERRATA section) in any markdown renderer. One-line fix; no content changed.
