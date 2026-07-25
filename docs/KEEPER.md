# docs/KEEPER.md

Purpose: exact build spec for the TypeScript keeper (off-chain deterministic executor) of Aphotic × Hashi.
Read after: docs/FACTS.md, docs/MOVE-PACKAGE.md, docs/ARCHITECTURE.md (source design: HASHI_INTEGRATION.md, "README (8).md").

All numeric identifiers, type strings, object IDs, feed ids, and latencies are canonical in **docs/FACTS.md** — this doc cross-references them (e.g. `see docs/FACTS.md#hbtc`) and NEVER re-inlines a mutable value. Where a value is repeated here it is for signature legibility only; docs/FACTS.md wins on any conflict.

---

## 0. GOLDEN RULES (encoded here — the coding agent MUST NOT violate)

| # | Rule | Where enforced in this keeper |
|---|---|---|
| 2 | Keeper holds ONLY DeepBook `TradeCap`. Never `WithdrawCap`/`DepositCap`. It can place/cancel orders; it can NEVER move funds out. Exits composed in Move (`gateway.move`) to an on-chain-pinned BTC address. | `execution/` builds ONLY trade PTBs + `confirm_deposit` crank + calls to `gateway::exit_to_bitcoin`. NO keeper key ever signs a `hashi::withdraw::request_withdrawal` with a keeper-chosen address. §5, §11. |
| 5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity()=min(cap, tokens+elapsed*refill_rate)` over the on-chain `WithdrawalSigned` stream. NOT a trusted SDK read. | `verify/` re-derives the whole bucket trajectory from on-chain events; `hashi/` MOCK reproduces `project_capacity` byte-for-byte. §2, §9. |
| 6 | BTC leg (deposit ~70 min, withdraw ~1.5–2h) is NEVER live-demoable. Pre-stage. Sui side is instant. | `execution/` + app show a pre-confirmed signet txid; keeper keeps warm deposits/withdrawals. §7, §10. |
| 7 | Isolate the ENTIRE Hashi surface behind an adapter interface with a deterministic MOCK from line one (mirrors `project_capacity` exactly). On-chain Hashi calls confined to `gateway.move`. All IDs configurable (env/config), NEVER hardcoded in logic. | `hashi/` adapter (§2) is the single choke point. `config/` loads every ID from env. |
| 8 | Honesty: hBTC IS custodial-threshold wrapped BTC. Differentiation = composing the bridge's ON-CHAIN machinery (pinned exits, trustless envelope replay, permissionless deposit crank, peg-flow signal), not the token's trust model. | Comments/journal never claim trustless custody; only trustless *observability* (§9) and non-custodial *keeper* (§5, rule 2). |
| 9 | Pin Pyth versions; use Beta feed on testnet; value NAV/collateral at DeepBook mid (depeg defence); staleness guards. | `oracle/` (§6). |

Additional invariants:
- **Determinism.** `strategy/evaluate()` and `routing/route()` are PURE functions of `(decrypted params, on-chain inputs snapshot)`. No `Date.now()`, no `Math.random()` except the bounded jitter drawn from a **seeded** PRNG whose seed is recorded in the journal. Same inputs ⇒ same decision ⇒ `verify/` reproduces it.
- **Sats everywhere.** All BTC amounts are `bigint` satoshis (u64 on-chain). hBTC = 8 decimals (`see docs/FACTS.md#hbtc`). Never `number` for money.
- **ESM only.** `@mysten/hashi` is ESM-only; `@mysten/sui ^2.22.1` peer. `"type": "module"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"|"NodeNext"`.

---

## 1. Top-level layout & runtime

```
keeper/
├── package.json            # "type":"module"; ESM
├── tsconfig.json
├── .env.example            # every var in §12
└── src/
    ├── index.ts            # CLI dispatch (commands §1.2)
    ├── config/             # env → typed Config; ALL ids here (rule 7)
    ├── hashi/              # ADAPTER interface + MOCK + REAL  ★ centerpiece §2
    ├── strategy/           # Seal params, deterministic evaluate()/route() input, padded serializer §3
    ├── routing/            # DeepBook L2 book, maker/IOC split §4
    ├── execution/          # PTB build, confirm_deposit crank, exit_to_bitcoin, sponsored sweep §5
    ├── oracle/             # Pyth Beta + DeepBook TWAP divergence breaker §6
    ├── storage/            # Walrus put/get + lifetime renewal §8
    ├── journal/            # decision records → Walrus blob ids §8
    ├── verify/             # replay engine incl. trustless limiter re-derivation §9
    └── privacy/            # Seal session keys, version-epoch rotation §3.3
```

### 1.1 Dependencies (pin exact versions day one)
| Package | Role |
|---|---|
| `@mysten/sui` (^2.22.1, pinned) | client, PTB (`Transaction`), keypairs, events |
| `@mysten/hashi` (0.6.0, pinned; ESM-only) | REAL adapter only (`see docs/FACTS.md#hashi-sdk`) |
| `@mysten/seal` | encrypt/decrypt, session keys (`privacy/`) |
| `@mysten/walrus` (or HTTP publisher/aggregator) | blob put/get (`storage/`) |
| `@mysten/deepbook-v3` | pool L2 queries, order PTBs, BalanceManager/TradeCap (`routing/`,`execution/`) |
| `@pythnetwork/pyth-sui-js` + Hermes client | Beta price update (`oracle/`) |
| `@mysten/zklogin` | app-side; keeper only consumes resulting address |

### 1.2 CLI commands (`src/index.ts`)
| Command | Action |
|---|---|
| `create-vault --strategy <file>` | encrypt params (Seal), Walrus put ciphertext, publish vault + BalanceManager, delegate `TradeCap` to keeper. |
| `run --vault <ID>` | main loop: watch → evaluate → route → execute → journal. Long-running. |
| `crank [--all]` | run permissionless `confirm_deposit` for pending Hashi deposits (rule 4 public good). |
| `sweep --deposit <req>` | sponsored PTB: minted hBTC → vault shares (§5.3). |
| `exit --vault <ID> --shares <n>` | burn shares → `gateway::exit_to_bitcoin` (pinned addr). §5.4. |
| `reclaim --request <id>` | `gateway::reclaim_stalled_exit` wraps `cancel_withdrawal`. §5.5. |
| `verify --vault <ID> --from-epoch <N> [--limiter]` | replay engine §9. `--limiter` re-derives bucket trajectory (rule 5). |

`run` loop pseudo-cycle (one tick):
```
snapshot = { book: routing.readBook(), oracle: oracle.read(), hashiFlow: hashi.eventsSince(cursor), limiter: verify.deriveLimiter(hashi.signedEvents) }
oracle.assertNoDivergence(snapshot.oracle)        // §6 breaker — throws → no-op
params  = privacy.decrypt(vault.blobId, sessionKey) // §3.3
decision = strategy.evaluate(params, snapshot)      // pure §3.1
plan     = routing.route(decision, snapshot.book)    // pure §4
digest   = execution.apply(plan)                     // PTB, TradeCap only §5
journal.record({ snapshot, decision, plan, digest }) // §8 → Walrus, blob id on-chain
```

---

## 2. `hashi/` — THE ADAPTER (centerpiece; rule 7)

Single abstraction over EVERY Hashi touchpoint. Nothing outside `hashi/` imports `@mysten/hashi`. Two implementations behind one interface: **MOCK** (deterministic, default in dev/test/CI, no network) and **REAL** (wraps SDK + on-chain event reads). Selected by `HASHI_ADAPTER=mock|real`.

Move-composed calls (`request_withdrawal`, `cancel_withdrawal`) are NOT in this adapter's write path — they are built in `execution/` against `gateway.move` (rule 2). The adapter's `requestWithdrawal`/`cancelWithdrawal` methods exist ONLY for the app/UX simulation surface and the MOCK; the production exit goes through Move. This is called out in `HashiAdapter` doc comments so the coding agent does not wire the SDK withdrawal into the vault path.

### 2.1 Types (`hashi/types.ts`)
```ts
export type Sats = bigint;                         // u64 satoshis
export type BtcAddress = Uint8Array;               // 20B P2WPKH | 32B P2TR (see docs/FACTS.md#withdrawal)
export type DepositStatus =
  | 'Requested' | 'Approved' | 'Confirmed';        // deposit lifecycle (Hashi deposit::* events)
export type WithdrawalStatus =
  | 'Requested' | 'Approved' | 'PickedForProcessing'
  | 'Signed' | 'Confirmed' | 'Cancelled';          // withdrawal_queue::* events

export interface DepositAddress { p2tr: string; suiAddress: string; }
export interface DepositView { requestId: string; status: DepositStatus; sats: Sats; recipient: string; }
export interface WithdrawalView { requestId: string; status: WithdrawalStatus; sats: Sats; bitcoinAddress: BtcAddress; signetTxid?: string; }

export interface LimiterStatus {           // token bucket (single GLOBAL bucket, see docs/FACTS.md#limiter)
  tokens: Sats;                            // available capacity NOW
  refillRate: Sats;                        // sats/s (genesis scalar; trust anchor)
  maxBucketCapacity: Sats;                 // cap (genesis scalar; trust anchor)
  asOfMs: number;                          // ms epoch of this reading
}

// On-chain event families (see docs/FACTS.md#hashi-events). Discriminated union.
export type HashiEvent =
  | { kind: 'Minted';               sats: Sats; recipient: string;            atMs: number; seq: bigint }
  | { kind: 'Burned';               sats: Sats;                               atMs: number; seq: bigint }
  | { kind: 'DepositRequested';     requestId: string; sats: Sats;            atMs: number; seq: bigint }
  | { kind: 'DepositApproved';      requestId: string; sats: Sats;            atMs: number; seq: bigint }
  | { kind: 'DepositConfirmed';     requestId: string; sats: Sats;            atMs: number; seq: bigint }
  | { kind: 'WithdrawalRequested';  requestId: string; sats: Sats;            atMs: number; seq: bigint }
  | { kind: 'WithdrawalApproved';   requestId: string;                        atMs: number; seq: bigint }
  | { kind: 'WithdrawalPicked';     requestId: string;                        atMs: number; seq: bigint } // PickedForProcessing
  | { kind: 'WithdrawalSigned';     requestId: string; sats: Sats;            atMs: number; seq: bigint } // ★ advances the bucket
  | { kind: 'WithdrawalConfirmed';  requestId: string; signetTxid: string;    atMs: number; seq: bigint }
  | { kind: 'WithdrawalCancelled';  requestId: string;                        atMs: number; seq: bigint }
  | { kind: 'UtxoSpent';            txid: string;                             atMs: number; seq: bigint };

export interface EventCursor { seq: bigint; }      // resumable
```

### 2.2 Interface (`hashi/adapter.ts`)
```ts
export interface HashiAdapter {
  // ── onboarding (client-side P2TR derivation; no server) ─────────────
  generateDepositAddress(suiAddress: string): Promise<DepositAddress>;

  // ── deposit registration + permissionless crank (rule 4) ────────────
  deposit(args: { signer: Signer; txid: string; utxos: Utxo[]; recipient: string }): Promise<{ requestId: string }>;
  confirmDeposit(requestId: string, signer: Signer): Promise<{ digest: string }>; // PERMISSIONLESS entry

  // ── withdrawal (UX/mock only; PRODUCTION exit is Move via gateway) ───
  requestWithdrawal(args: { sats: Sats; bitcoinAddress: BtcAddress; signer: Signer }): Promise<{ requestId: string }>;
  cancelWithdrawal(requestId: string, signer: Signer): Promise<{ sats: Sats }>;   // pre-commit only, 1h cooldown

  // ── views ───────────────────────────────────────────────────────────
  viewBalance(suiAddress: string): Promise<Sats>;
  depositStatus(requestId: string): Promise<DepositView>;
  withdrawalStatus(requestId: string): Promise<WithdrawalView>;
  viewAll(suiAddress: string): Promise<{ deposits: DepositView[]; withdrawals: WithdrawalView[] }>;

  // ── waiters (poll to terminal state; NEVER live-demoable, rule 6) ────
  waitForDeposit(requestId: string, opts?: { timeoutMs?: number }): Promise<DepositView>;
  waitForWithdrawal(requestId: string, opts?: { timeoutMs?: number }): Promise<WithdrawalView>;

  // ── guardian limiter ────────────────────────────────────────────────
  limiterStatus(): Promise<LimiterStatus>;         // REAL = SDK read; but treat as HINT only (rule 5)
  canWithdraw(sats: Sats): Promise<boolean>;       // pre-exit UX check

  // ── event stream (drives strategy flow signal + verify) ─────────────
  eventsSince(cursor: EventCursor, opts?: { kinds?: HashiEvent['kind'][] }): Promise<{ events: HashiEvent[]; next: EventCursor }>;
  signedEventsSince(cursor: EventCursor): Promise<{ events: Extract<HashiEvent,{kind:'WithdrawalSigned'}>[]; next: EventCursor }>;
}
```

### 2.3 REAL implementation (`hashi/real.ts`)
- Constructs `client.$extend(hashi())`; auto-resolves network IDs from `SUI_NETWORK` (`see docs/FACTS.md#hashi-sdk`). Overridable via `HASHI_PACKAGE_ID`/`HASHI_OBJECT_ID` for pinning (rule 7 — never hardcode).
- `generateDepositAddress` → SDK `generateDepositAddress({suiAddress})`.
- `deposit` → SDK `deposit(...)`. `confirmDeposit` → build+sign the permissionless `confirm_deposit` entry PTB (`see docs/FACTS.md#confirm-deposit`).
- `limiterStatus`/`canWithdraw` → SDK `guardian.*`. **Doc comment MUST state: this is an unverified hint; the authoritative limiter comes from `verify.deriveLimiter` over on-chain `WithdrawalSigned` (rule 5).**
- `eventsSince`/`signedEventsSince` → `client.queryEvents` filtered by `MoveEventType` on the Hashi package's event structs (`see docs/FACTS.md#hashi-events`), paginated by `seq`. This path is the trust anchor; it does NOT use the SDK's convenience readers for limiter data.
- Latencies (`see docs/FACTS.md#latencies`): waiters must tolerate deposit ~70 min, withdrawal ~1.5–2h; default `timeoutMs` from env, generous; rule 6 (pre-stage) applies.

### 2.4 MOCK implementation (`hashi/mock.ts`) — deterministic, no network

Purpose: run the ENTIRE system (strategy, routing, exit gateway sim, verify) with zero live Hashi (rule 7). Must reproduce `project_capacity()` EXACTLY so `verify/` re-derivation and the MOCK agree bit-for-bit.

State machine (in-memory, seeded, advanced by a logical clock the test drives — NOT wall clock):
```ts
interface MockConfig {
  refillRate: Sats;          // e.g. 1000n  (signet sample; see docs/FACTS.md#limiter)
  maxBucketCapacity: Sats;   // e.g. 100_000_000n (1 BTC) — OR the 0.02-BTC test-constant bucket
  startTokens: Sats;         // initial bucket fill
  startMs: number;           // logical t0
  depositDelayMs: number;    // models ~70 min lifecycle steps (compressible in tests)
  withdrawDelayMs: number;   // models ~1.5–2h
  withdrawMinSats: Sats;     // 30_000n (see docs/FACTS.md#withdrawal)
  dustFloor: Sats;           // 546n
}
```

**Canonical `project_capacity` (single source; MOCK and `verify/` import the SAME function):**
```ts
// hashi/limiter.ts — SHARED by mock.ts and verify/limiter.ts. Golden rule 5.
export function projectCapacity(
  tokens: Sats, refillRate: Sats, cap: Sats, elapsedMs: number,
): Sats {
  const elapsedSec = BigInt(Math.floor(elapsedMs / 1000));   // integer seconds; MATCH on-chain granularity — verify day one
  const refilled = tokens + elapsedSec * refillRate;
  return refilled < cap ? refilled : cap;                    // min(cap, tokens + elapsed*refill_rate)
}
```

MOCK behaviour:
- `confirmDeposit` advances a queued deposit to `Confirmed` and appends `Minted` at `now >= requestedAt + depositDelayMs`; else throws `NotReady`.
- A withdrawal path: `requestWithdrawal` (assert `sats >= withdrawMinSats`, address 20|32 bytes) → emit `WithdrawalRequested` → after batch delay emit `WithdrawalPicked` → **on `Signed`, DEBIT the bucket by `sats` and check over-capacity** (`projectCapacity(...) < sats` ⇒ reject with `RateLimitExceeded`, NOT queue — rule 3). Then `Confirmed` with a canned `signetTxid`.
- `limiterStatus()` returns `projectCapacity(...)` for `now`; identical to what `verify/` derives from the emitted `WithdrawalSigned` stream — assert equality in a MOCK↔verify cross-test.
- `eventsSince`/`signedEventsSince` replay the in-memory log by `seq`. Fully deterministic.
- Ordering is "generally FIFO, not strict" and you CANNOT buy priority (rule 3): MOCK exposes a knob `leaderReorderWindow` to simulate discretionary reordering; strategy/verify must not assume strict FIFO.

Acceptance (CI): `mock.limiterStatus()` at any logical `t` === `verify.deriveLimiter(mock.signedEventsSince(0))` evaluated at `t`, for a randomized (seeded) sequence of deposits/withdrawals. See §13.

---

## 3. `strategy/` — encrypted params, deterministic evaluate/route inputs, padded serializer

### 3.1 `evaluate(params, snapshot) → Decision` (PURE)
Flagship family = **peg-flow maker quoting** on `Pool<hBTC, DBUSDC>` (`see docs/FACTS.md#deepbook-pool`). NO Cetus leg (rule 4). Inputs:
| Input | Source |
|---|---|
| `book` | `routing.readBook()` L2 snapshot (§4) |
| `mid` | DeepBook mid (NAV/quote reference — depeg defence, rule 9) |
| `pendingMint` | Σ sats of `DepositApproved` not yet `Minted` (telegraphs supply +) |
| `pendingBurn` | Σ sats of `WithdrawalRequested` not yet `Confirmed` (supply −) |
| `limiter` | `verify.deriveLimiter(...)` (trustless, rule 5) — NOT the SDK hint |
| `idleHBtc`, `pendingExitDemand` | vault state (redemption buffer input) |

Encrypted params (Seal): `spread`, `skew`, `flowSensitivity`, `bufferTarget`, `maxNotionalPerEpoch`, `cooldownMs`, `jitterBounds`, `hysteresisBands`, `makerTimeoutMs`. Never on-chain in plaintext.

`Decision` (recorded in journal §8):
```ts
interface Decision {
  action: 'quote' | 'requote' | 'derisk' | 'noop';
  bidPx: bigint; askPx: bigint;      // tick-aligned (tick 1_000_000, see docs/FACTS.md#deepbook-pool)
  bidSz: Sats;   askSz: Sats;        // lot-aligned (lot 1_000, min_size 100_000)
  cancels: OrderId[];                 // resting orders to pull
  cause?: string;                     // for noop/derisk: e.g. 'limiter-tightening', 'oracle-divergence', 'buffer'
  jitterSeed: string;                 // seeded PRNG seed — recorded so verify reproduces jitter
}
```
Rules encoded: (a) skew quotes toward absorbing telegraphed flow; (b) **redemption buffer** — if deploying would push idle hBTC below `f(idleHBtc, pendingExitDemand)` given `limiter` tightening, downsize/`derisk` with `cause='buffer'`; (c) if `limiter` capacity is trending down (bucket draining faster than refill), pre-emptively `derisk` — this is the replayable "bridge tightening" trace (rule 5). All bands padded via §3.2 so event shapes are uniform (privacy).

### 3.2 Padded serializer (`strategy/serialize.ts`)
Fixed-length encoding of params before Seal encryption so ciphertext size never leaks strategy family. Deterministic; big-endian; sats as u64. `serialize(params) → Uint8Array` (constant length), `deserialize(bytes) → Params`. Round-trip test required.

### 3.3 Seal + version-epoch rotation (`privacy/`)
- `encrypt(params, {vaultId, versionEpoch}) → ciphertext`: identity namespaced to the vault object + `versionEpoch` (`see docs/FACTS.md#seal`). Threshold `SEAL_THRESHOLD` of `SEAL_KEY_SERVERS`.
- `decrypt(blobId, sessionKey) → params`: fetch ciphertext (Walrus §8), request key shares; each key server dry-runs `aphotic::vault::seal_approve` before releasing (rule: access is Move-gated).
- **Session keys**: short-lived; created per `run` session; `privacy/session.ts`.
- **Version-epoch rotation**: rotating the keeper increments `versionEpoch` on-chain (`vault::rotate`), invalidating previously derived key shares (a bare `set_keeper` would not — README security model). `privacy/rotation.ts` re-encrypts current params under the new epoch and Walrus-puts a new ciphertext version. Historical epochs remain individually discloseable (scoped verification tier).

---

## 4. `routing/` — DeepBook L2 book, maker/IOC split (rule 4)

- `readBook(pool) → L2Book`: bids/asks arrays `{px: bigint, sz: Sats}` aligned to tick `1_000_000`, lot `1_000`, `min_size 100_000` (`see docs/FACTS.md#deepbook-pool`). This snapshot is the heavy journal field enabling public routing-verification.
- `route(decision, book) → Plan` (PURE): maker-first. Post `POST_ONLY` maker at `decision.bidPx/askPx`; any residual that must cross → **IOC sweep on the SAME book** (`see docs/FACTS.md#no-cetus`). NO Cetus taker leg, NO CLMM ranges. Self-match prevention ON (vault may rest while its own flow crosses).
```ts
interface Plan {
  makerOrders: { side:'bid'|'ask'; px: bigint; sz: Sats; expireTs: number; postOnly: true }[];
  iocOrders:   { side:'bid'|'ask'; px: bigint; sz: Sats; ioc: true }[];
  cancels: OrderId[];
}
```
- After `makerTimeoutMs` (encrypted param), cancel unfilled maker remainder and re-route as IOC on the same book (there is nowhere else — rule 4).

---

## 5. `execution/` — PTB build, crank, exit, sponsored sweep (rule 2)

The keeper's ONLY signing surface. It can build: trade PTBs (TradeCap), the permissionless `confirm_deposit` crank, the sponsored deposit sweep, and calls into `gateway.move`. It can NEVER build a fund-moving PTB with a keeper-chosen destination (rule 2, rule 8).

### 5.1 Trade PTB (`execution/trade.ts`)
Build `Plan` (§4) into a DeepBook PTB using `TradeCap` only (`see docs/FACTS.md#deepbook-caps`). Place/cancel orders; sign with `KEEPER_KEY`. Constraint envelope is enforced ON-CHAIN in `envelope.move` (slippage bps vs oracle mid, max notional/epoch, cooldown, buffer) — keeper builds within it but does not self-police as trust.

### 5.2 `confirm_deposit` crank (`execution/crank.ts`) — rule 4 public good
`confirmDeposit(requestId)` builds the PERMISSIONLESS `confirm_deposit` entry (`see docs/FACTS.md#confirm-deposit`), for ALL pending Hashi deposits (not only vault users). Mints `Coin<BTC>` to the recipient encoded in the UTXO derivation path — keeper cannot redirect it. Gate on lifecycle: only after `Approved` + mandatory delay (`see docs/FACTS.md#latencies`), else on-chain aborts.

### 5.3 Sponsored deposit sweep (`execution/sweep.ts`)
After a vault-user's hBTC mints, a SPONSORED PTB (keeper/owner pays gas via zkLogin sponsored tx) moves the minted `Coin<BTC>` into vault shares: `vault::deposit_shares`. User never needs SUI. Sats-denominated share issuance.

### 5.4 Exit (`execution/exit.ts`) — rule 2 pinned exit
`exit(vault, shares)` builds ONE PTB calling `gateway::exit_to_bitcoin(vault, shares, ...)` which internally: burns shares → splits `Balance<BTC>` → calls `hashi::withdraw::request_withdrawal(hashi, clock, btc, PINNED_ADDR, ctx)` where `PINNED_ADDR` is the depositor's on-chain-registered address, immutable since first deposit. **The keeper NEVER passes a bitcoin address** — Move reads the pinned one. Emits `WithdrawalRequested`. Small exits below `30_000` sats pool per-user in `gateway.move` until they clear the minimum (`see docs/FACTS.md#withdrawal`). Surface the resulting `requestId`; drive `waitForWithdrawal` → signet txid for display (rule 6: pre-staged for demo).

### 5.5 Reclaim stalled exit (`execution/reclaim.ts`)
`reclaim(requestId)` builds a PTB calling `gateway::reclaim_stalled_exit` which wraps `hashi::withdraw::cancel_withdrawal` (requester-only, pre-commit `Requested`/`Approved` only, 1h cooldown — `see docs/FACTS.md#cancel-withdrawal`), returns `Balance<BTC>` to the vault, re-credits shares. Cannot buy queue priority (rule 3); reclaim is the only recourse on stall.

---

## 6. `oracle/` — Pyth Beta + DeepBook TWAP divergence breaker (rule 9)

- `read() → OracleSnapshot`: `{ pythPx, pythSeq, pythPublishTimeMs, deepbookTwap, deepbookMid }`.
- **Pyth**: BTC/USD feed id `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` — **TESTNET REQUIRES THE BETA-CHANNEL feed id; verify via Hermes before hardcoding** (`see docs/FACTS.md#pyth`). PIN Pyth package/State versions (`PYTH_STATE_ID`, `PYTH_PACKAGE_ID`, `WORMHOLE_STATE_ID`) — Pyth DAO auto-upgrades Sui addresses 2026-08-18 (rule 9).
- **Staleness guard**: reject if `now - pythPublishTimeMs > PYTH_MAX_STALENESS_MS`.
- **DeepBook TWAP**: computed from the pool over `TWAP_WINDOW_MS`.
- **Divergence breaker** (`assertNoDivergence`): if `abs(pythBtcUsd - deepbookImpliedBtcUsd)/pythBtcUsd > ORACLE_DIVERGENCE_BPS` ⇒ throw → `evaluate` returns `noop` with `cause='oracle-divergence'`. This is ALSO the hBTC-depeg circuit breaker (hBTC can depeg below BTC on the thin book; NAV valued at DeepBook mid — rule 9). Journal records both prices so the breaker decision is publicly reproducible.

---

## 7. Demo/pre-staging note (rule 6)

`execution/` and the app NEVER wait on Bitcoin confirmations live. Keeper keeps 2–3 confirmed hBTC deposits and one broadcast withdrawal warm. The ONLY live on-chain BTC-side action shown is the permissionless `confirm_deposit` crank (real state transition, fast) and the instant Sui-side exit PTB; the settled signet txid displayed is from an EARLIER pre-broadcast withdrawal. `waitFor*` timeouts are generous; demo path uses pre-fetched terminal states.

---

## 8. `storage/` + `journal/` — Walrus decision log

`storage/`:
- `put(bytes, {epochs}) → blobId`: Walrus write; **`epochs` = `WALRUS_EPOCHS` set explicitly, never the 1-epoch default** (liveness risk). Encrypt-before-upload always (ciphertexts already encrypted by `privacy/`; raw decision logs may be plaintext but strategy blobs never are).
- `get(blobId) → bytes`.
- `renew(blobId)`: lifetime-renewal task extends before expiry; alerts on failure. `envelope.move` reads the blob object on-chain (certified/unexpired/not-deletable) before permitting keeper actions.

`journal/` — one `DecisionRecord` per tick, appended to a Walrus segment; segment `blobId` emitted on-chain (`journal.move` — self-certifying content-addressed pointer). Record schema:
| Field | Contents |
|---|---|
| `oracle` | Pyth price id + seq + publishTime, DeepBook TWAP + mid (§6) |
| `book` | DeepBook L2 snapshot at decision time (heavy; makes routing checkable) |
| `hashi` | limiter reading (derived, §9), queue depths, `pendingMint`, `pendingBurn`, `WithdrawalSigned` cursor |
| `strategy_blob` | blob id of the strategy VERSION in force (not current) |
| `ruleset` | content hash of the compiled decision function |
| `decision` | `Decision` (§3.1) incl. `jitterSeed` and `cause` |
| `plan` | `Plan` (§4) maker/IOC split |
| `result` | tx digest, or reason no tx issued |
Published on a lag (`LOG_PUBLISH_LAG_MS`) so a live log cannot front-run resting maker orders.

---

## 9. `verify/` — replay engine + TRUSTLESS limiter re-derivation (rule 5)

Two responsibilities:

### 9.1 Decision replay
`verify --vault <ID> --from-epoch <N>`: fetch Walrus segments, re-run the published `evaluate`/`route` against each record's RECORDED inputs (`book`, `oracle`, `hashi`, `jitterSeed`), and report any decision that fails to reproduce. Two tiers (honest, rule 8): *routing* correctness (given δ + book) is PUBLICLY checkable with no keys; *trigger* correctness needs the strategy plaintext (owner or granted-epoch disclosure via Seal version epoch).

### 9.2 Trustless limiter trajectory (`verify/limiter.ts`) — rule 5, the strongest claim
`deriveLimiter(signedEvents, config) → trajectory`: re-derives the ENTIRE Guardian bucket trajectory and global queue depth PURELY from the on-chain event stream — NOT from any SDK read.
```ts
// Import the SAME projectCapacity from hashi/limiter.ts (§2.4) — one implementation, no drift.
import { projectCapacity } from '../hashi/limiter.js';

export function deriveLimiter(
  events: HashiEvent[],                 // WithdrawalRequested/PickedForProcessing/Signed stream, on-chain, seq-ordered
  cfg: { refillRate: Sats; maxBucketCapacity: Sats; genesisTokens: Sats; genesisMs: number },
): { atMs: number; tokens: Sats; queueDepth: Sats }[] {
  // Walk events in seq order; between events refill via projectCapacity(elapsed);
  // on each WithdrawalSigned, DEBIT tokens by that event's sats (the bucket is advanced by Signed events);
  // maintain queueDepth = Σ Requested − Σ (Signed|Cancelled). Emit a sample at every event boundary.
}
```
- ONLY trust anchors: two genesis scalars `refillRate`, `maxBucketCapacity` (`REFILL_RATE_SATS_PER_S`, `MAX_BUCKET_CAPACITY_SATS`) — both observationally boundable; query day one (`see docs/FACTS.md#limiter`, LIVE VALUES UNPUBLISHED). NOT load-bearing for Aphotic (used as risk input, not monetized — rule 8).
- The `run` loop feeds `deriveLimiter` output (NOT `hashi.limiterStatus()`) into `strategy.evaluate` and the journal. The SDK `limiterStatus` is at most a sanity hint.
- `--limiter` flag prints the trajectory and asserts it matches the journal's recorded readings — proving "the bridge was tightening when we pulled quotes" is independently re-derivable from Hashi's own events, not merely logged. Over-capacity batches are REJECTED not queued (rule 3); the derivation reflects that. Ordering "generally FIFO, not strict"; the derivation must not assume strict FIFO for correctness of the bucket total (bucket is order-independent for the token count; queue *identity* ordering is discretionary).

Acceptance: `deriveLimiter` over MOCK's `signedEventsSince(0)` === MOCK's `limiterStatus()` at every boundary (§13 cross-test).

---

## 10. Startup/ops sequence

1. Load `config/` (all IDs from env, rule 7). If any Hashi ID unset in `real` mode → fail fast.
2. `HASHI_ADAPTER=mock` for all dev/test/CI; `real` only against live testnet.
3. Day-one gates before `real` (from HASHI_INTEGRATION.md §2 "Verify on day one"; owner = build lead): confirm testnet IDs respond; `Hashi` object queue getters (envelope fallback if absent); pool book depth + maker placement with fresh BalanceManager; `generateDepositAddress` accepts 32-byte object id (stretch); faucet throughput; Seal+Walrus coexist on testnet; **Pyth Beta feed id via Hermes**; **live `refillRate`/`maxBucketCapacity`**.
4. Keep warm inventory (rule 6). Start faucet drip day one.

UNKNOWN — resolve in DAY-ONE.md (owner = build lead):
- Live `refillRate` / `maxBucketCapacity` on testnet Guardian (query; NOT load-bearing).
- Exact integer-time granularity of on-chain `project_capacity` (seconds vs ms) — MUST match `projectCapacity` (§2.4) or `verify` diverges. Confirm against Hashi source.
- Whether `Hashi` shared object exposes public queue-depth/config getters (envelope on-chain read vs static-buffer fallback).
- Pyth Beta-channel BTC/USD feed id confirmation via Hermes (do not hardcode the stable-channel id blindly).
- Exact Hashi event struct type strings for `queryEvents` filters (`see docs/FACTS.md#hashi-events`; confirm from source).

---

## 11. Trust boundary (rule 2, rule 8 — encode as invariants/comments)

| Keeper CAN | Keeper CANNOT |
|---|---|
| Place/cancel DeepBook orders (TradeCap) | Move funds out of BalanceManager (no WithdrawCap) |
| Run permissionless `confirm_deposit` for anyone | Redirect a mint (recipient fixed in UTXO derivation) |
| Trigger `gateway::exit_to_bitcoin` | Choose the BTC destination (pinned on-chain, immutable) |
| Trigger `gateway::reclaim_stalled_exit` | Buy withdrawal-queue priority (rule 3) |
| Read/decrypt strategy in memory (residual trust; Nautilus fix out of scope) | Prove custody is trustless — hBTC IS threshold-custodial (rule 8) |

A fully compromised keeper can degrade execution quality but CANNOT steal or redirect BTC. State this in the pitch honestly (rule 8): the differentiator is composed on-chain bridge machinery + trustless observability (§9), NOT the token's custody model.

---

## 12. Environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `SUI_NETWORK` | `testnet` (Hashi's network; `see docs/FACTS.md`) |
| `HASHI_ADAPTER` | `mock` \| `real` (default `mock` in dev/CI, rule 7) |
| `OWNER_KEY` | vault creation, sponsored sweeps, emergency actions |
| `KEEPER_KEY` | holds TradeCap only; gas + nothing more (rule 2) |
| `APHOTIC_PACKAGE_ID` | published `aphotic` package id |
| `VAULT_ID` | shared Vault object id |
| `BALANCE_MANAGER_ID` / `TRADE_CAP_ID` | DeepBook custody + keeper cap |
| `HASHI_PACKAGE_ID` | Hashi package (testnet, `see docs/FACTS.md#hashi`) — override, never hardcode |
| `HASHI_OBJECT_ID` | Hashi shared object (testnet, `see docs/FACTS.md#hashi`) |
| `HBTC_COIN_TYPE` | `<pkg>::btc::BTC` (`see docs/FACTS.md#hbtc`) |
| `DEEPBOOK_POOL` | `Pool<hBTC,DBUSDC>` id (`see docs/FACTS.md#deepbook-pool`) |
| `DEEPBOOK_PACKAGE_ID` | DeepBook callable package (`see docs/FACTS.md#deepbook-pool`) |
| `DBUSDC_COIN_TYPE` | DBUSDC type (`see docs/FACTS.md#deepbook-pool`) |
| `PYTH_STATE_ID` / `PYTH_PACKAGE_ID` / `WORMHOLE_STATE_ID` | PINNED Pyth/Wormhole (rule 9; auto-upgrade 2026-08-18) |
| `PYTH_BTC_USD_FEED_ID` | Beta-channel BTC/USD feed (verify via Hermes, rule 9) |
| `HERMES_ENDPOINT` | Pyth Hermes price-update source |
| `PYTH_MAX_STALENESS_MS` | oracle staleness guard |
| `ORACLE_DIVERGENCE_BPS` | breaker threshold (Pyth vs DeepBook TWAP, rule 9) |
| `TWAP_WINDOW_MS` | DeepBook TWAP window |
| `WALRUS_PUBLISHER` / `WALRUS_AGGREGATOR` | write/read endpoints |
| `WALRUS_EPOCHS` | blob lifetime; set explicitly, never 1-epoch default (§8) |
| `SEAL_THRESHOLD` | key-server threshold (default `2`) |
| `SEAL_KEY_SERVERS` | comma-separated server object ids |
| `SEAL_VERSION_EPOCH` | current strategy version epoch (rotation, §3.3) |
| `MAKER_TIMEOUT_MS` | maker cancel-and-IOC-reroute window (also encrypted param; env is the mock/default) |
| `LOG_PUBLISH_LAG_MS` | decision-segment publish lag (anti-front-run, §8) |
| `REFILL_RATE_SATS_PER_S` | limiter genesis scalar (trust anchor, §9; query day one) |
| `MAX_BUCKET_CAPACITY_SATS` | limiter genesis scalar (trust anchor, §9; query day one) |
| `HASHI_WAIT_TIMEOUT_MS` | `waitFor*` timeout (deposit ~70min / withdraw ~1.5–2h, rule 6) |
| `EVENT_POLL_INTERVAL_MS` | event-stream poll cadence |

Keys read from env only; never logged/printed/committed; `.env` gitignored.

---

## 13. Acceptance criteria & verification commands

| # | Criterion | Command / check |
|---|---|---|
| A1 | System runs end-to-end with NO live Hashi (rule 7) | `HASHI_ADAPTER=mock npm test` — full loop green |
| A2 | MOCK `limiterStatus()` === `verify.deriveLimiter(signedEvents)` at every event boundary, seeded random sequence (rule 5) | dedicated cross-test in `verify/__tests__/limiter.cross.test.ts` |
| A3 | `evaluate`/`route` are pure — same inputs reproduce same `Decision`/`Plan` incl. jitter (from `jitterSeed`) | replay test; `verify --vault <ID> --from-epoch 0` reports 0 mismatches |
| A4 | Padded serializer round-trips and is constant-length across strategy families | `strategy/__tests__/serialize.test.ts` |
| A5 | Router emits NO Cetus leg; residual is IOC on the same book (rule 4) | assert `Plan.iocOrders` only; no Cetus module imported anywhere |
| A6 | Keeper build path never signs a withdrawal with a keeper-chosen address (rule 2) | grep: `request_withdrawal` appears ONLY inside `gateway.move` calls; adapter's `requestWithdrawal` unused by `run`/`exit` |
| A7 | Oracle breaker trips on injected divergence and yields `noop cause='oracle-divergence'` (rule 9) | `oracle/__tests__/divergence.test.ts` |
| A8 | `WALRUS_EPOCHS` never defaults to 1; renewal task present | config assertion + `storage/__tests__` |
| A9 | Every externally-visible transition emits a journal record; blob id emitted on-chain | integration test asserts one `DecisionRecord` per tick |
| A10 | `verify --limiter` trajectory matches journal's recorded limiter readings (rule 5) | `verify --vault <ID> --from-epoch 0 --limiter` exits 0 |

Static checks: no `number` for satoshi amounts (lint rule → `bigint`); no `Date.now()`/`Math.random()` inside `strategy/`,`routing/` except seeded jitter; `@mysten/hashi` imported ONLY under `hashi/real.ts`.

---

## ERRATA (2026-07-25)

> Source: `docs/DAY-ONE-RESULTS.md` (live probes) + `docs/RECON.md`. Canonical values live in `docs/FACTS.md`.
> **Where this section conflicts with the body of KEEPER.md above, this section wins.** Each item is WAS / IS / WHY.
> **Also supersedes:** the §12 "UNKNOWN — resolve in DAY-ONE.md (owner = build lead)" block. Every value there is now resolved or has a documented fallback — see E-K2, E-K5, E-K11, E-K12, E-K13 and `docs/FACTS.md#unknowns`.

### E-K1 — §2.4 `projectCapacity`: wrong argument shape, wrong time semantics

- **WAS:**
  ```ts
  export function projectCapacity(tokens: Sats, refillRate: Sats, cap: Sats, elapsedMs: number): Sats
  ```
- **IS:** mirror the upstream implementation (`@mysten/hashi@0.6.0`, `dist/guardian.mjs`) exactly — it takes `(config, state, ABSOLUTE timestampSecs)`, not elapsed milliseconds:
  ```ts
  export interface LimiterConfig { refillRateSatsPerSec: bigint; maxBucketCapacitySats: bigint }
  export interface LimiterState  { numTokensAvailableSats: bigint; lastUpdatedAtSecs: bigint; nextSeq: bigint }

  export function projectCapacity(cfg: LimiterConfig, st: LimiterState, timestampSecs: bigint): bigint {
    const refilled = (timestampSecs > st.lastUpdatedAtSecs ? timestampSecs - st.lastUpdatedAtSecs : 0n)
                     * cfg.refillRateSatsPerSec;                      // saturating_sub, in bigint
    const projected = st.numTokensAvailableSats + refilled;
    return projected < cfg.maxBucketCapacitySats ? projected : cfg.maxBucketCapacitySats;
  }
  ```
  Provide `estimateWaitSecs(cfg, st, amountSats, nowSecs)` too (`0n` if available now, `null` if `amount > maxBucketCapacity` or `refillRate === 0n`; otherwise ceil-div of the deficit).
- **WHY:** the whole G5 claim is "our arithmetic is byte-identical to the bridge's". A different arg shape invites drift and makes the MOCK↔`verify` cross-test compare two things we wrote rather than one thing they wrote. The ms→s floor still belongs in the **caller** (`BigInt(Math.floor(ms / 1000))`) — see E-K3. `docs/FACTS.md#guardian-limiter`.

### E-K2 — §2.4 `MockConfig` sample values are wrong by ~100×

- **WAS:** `refillRate: 1000n`, `maxBucketCapacity: 100_000_000n (1 BTC)`, described as the signet sample.
- **IS:** live testnet values, read from the guardian: **`refillRate = 115_740n` sats/s**, **`maxBucketCapacity = 10_000_000_000n` sats (100 BTC)** — a full bucket refills in ~24 h (≈99.99936 BTC/day). Defaults in `config/` and in `MockConfig` must be these.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D4. Two consequences: (a) an Aphotic-sized exit will essentially never be rate-limited on testnet, so the redemption buffer is an honest **risk input**, not a scarcity story — do not pitch congestion (see `docs/FACTS.md#competitive`); (b) `number` arithmetic is now definitively unsafe (a 100 BTC bucket × large elapsed exceeds `Number.MAX_SAFE_INTEGER`), so the existing "no `number` for sats" lint rule is load-bearing, not stylistic.

### E-K3 — §9.2 `deriveLimiter`: `WithdrawalSigned` has NO amount and NO timestamp

- **WAS:** "on each `WithdrawalSigned`, DEBIT tokens by **that event's** sats", and `cfg.genesisMs`.
- **IS:** verified on live data — `WithdrawalSigned { guardian_signatures, request_ids, signatures, withdrawal_txn_id }`. There is no amount field and no timestamp field. The replay must normalize:
  - **sats** = Σ over `event.request_ids` of the matching `WithdrawalRequested.btc_amount`. **Use the REQUESTED amount**, not `WithdrawalPickedForProcessing.withdrawal_outputs[i].amount` — the latter is net of the Bitcoin network fee (observed `1_000_000` requested vs `998_835` output) and the bucket is debited by the requested amount. Keep `withdrawal_outputs` only as a fallback when a `Requested` event has aged out of the window.
  - **timestamp** = the **Sui event envelope** field `timestampMs` (camelCase), which arrives as a **decimal STRING** over JSON-RPC ⇒ `BigInt(e.timestampMs) / 1000n`. Never `parseInt`. Where a struct also carries `timestamp_ms` they differ (observed 701 ms apart) — prefer the envelope, because `WithdrawalSigned` has no struct timestamp at all.
  - `deriveLimiter` therefore needs an index of `request_id → btc_amount` built from the `WithdrawalRequested` stream **before** it can walk `Signed` events. Fetch both, or fetch by module and partition.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10b/§D10c, `docs/FACTS.md#events`.

### E-K4 — corrected golden vectors (RECON R9 #1 and #7 are arithmetically wrong)

- **WAS:** RECON R9 tabulates `projectCapacity` at `t = 15` over `{tokens 100_000, refill 10, cap 2_000_000}` as `105_000` (vectors #1 and #7).
- **IS:** **`100_150`.** `100_000 + 15 × 10 = 100_150`; the upstream SDK returns `100150n`. RECON's *algorithm* is correct; only those two expected values are slips.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10d. Use the corrected 9-row table in `docs/FACTS.md#guardian-limiter` — it is shared verbatim with `move/tests/envelope_tests.move`, so a wrong value there means the cross-test never goes green.

### E-K5 — transport: `SuiGrpcClient`, and `SuiClient` no longer exists

- **WAS:** implicit `new SuiClient({ url })` against `https://fullnode.testnet.sui.io:443`.
- **IS:** that endpoint returns **HTTP 404 for JSON-RPC** — it serves gRPC v2 only. The default transport is `SuiGrpcClient` from `@mysten/sui/grpc`, constructed in exactly one place (`keeper/src/sui/client.ts`). Also: **`@mysten/sui@2.22.1`'s `./client` subpath does NOT export `SuiClient`** (importing it throws `does not provide an export named 'SuiClient'`); the JSON-RPC class is `SuiJsonRpcClient` from `@mysten/sui/jsonRpc`, useful for probes against the mirror `https://rpc-testnet.suiscan.xyz:443` only.
- **WHY:** `docs/FACTS.md#rpc-transport`, `docs/RECON.md` R1.

### E-K6 — §4 `readBook`: the DeepBook indexer is unusable for this pool, and `mid_price` aborts

- **WAS:** `readBook(pool) → L2Book` with no transport specified; §6 implies a readable mid.
- **IS:**
  - The hosted indexer `deepbook-indexer.testnet.mystenlabs.com` lists 7 pools and **does not include hBTC/DBUSDC**. Never read the book from it. `@mysten/deepbook-v3`'s `DeepBookClient` is driven by a bundled registry that will not contain our pool — build raw `moveCall`s and use the SDK for BCS helpers only.
  - Read the book by **simulating** `pool::get_level2_range(pool, price_low, price_high, is_bid, clock)` against the callable package `0xd874d241…` with type args `[hBTC, DBUSDC]`, and BCS-decode the two `vector<u64>` returns. On an empty book it returns `([], [])`.
  - **Do not call `pool::mid_price`** — on an empty book it **aborts** `deepbook::book` code `2` (`EEmptyOrderbook`), and the book is empty on both sides right now.
  - The deployed v20 package does **not** contain `best_bid_price`, `best_ask_price`, or `place_post_only_limit_order` even though the pinned source rev does. Maker placement = `place_limit_order` with `order_type = 3 (POST_ONLY)`, `self_matching_option = 0`.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D3, `docs/FACTS.md#deepbook-venue`.

### E-K7 — §5.5 a keeper-side `reclaim` command is WRONG AS SPECIFIED

- **WAS:** "`reclaim(requestId)` builds a PTB calling `gateway::reclaim_stalled_exit`" in `execution/reclaim.ts`, i.e. keeper-signed.
- **IS:** `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()`, and the sender is whoever signed the `request_withdrawal` PTB — **the depositor**. **The keeper can never reclaim.** `execution/reclaim.ts` must be either deleted or reduced to a pure **PTB builder** (unsigned) that the app hands to the depositor's zkLogin session to sign. The keeper may still *detect* stalls and surface them; it may not execute them.
- **WHY:** source- and bytecode-verified. `docs/FACTS.md#hashi-move-api`, `docs/RECON.md` R7.3. Same reasoning forbids a keeper-executed pooled-exit flush (see MOVE-PACKAGE E-M8).

### E-K8 — §2 the `@mysten/hashi@0.6.0` API described here does not exist

- **WAS:** `guardian.limiterStatus`, `guardian.canWithdraw`, `view.balance` / `view.depositStatus` / `view.withdrawalStatus` / `view.all`, `waitForDeposit`, `waitForWithdrawal`, `deposit`, `requestWithdrawal`, `cancelWithdrawal`.
- **IS:** the package's **actual** exports are `HashiClient`, `hashi`, `generateDepositAddress`, `deriveChildPubkey`, `twoOfTwoTaprootScriptPathAddress`, `bitcoinAddressToWitnessProgram`, `witnessProgramToAddress`, `arkworksToSec1Compressed`, `projectCapacity`, `estimateWaitSecs`, `fetchGuardianInfo`, and the error classes. Nothing else. Every lifecycle read (`view.*`, `waitFor*`) must be built on `HashiClient` + raw `moveCall`s + event polling **inside our adapter** — which is exactly what G7 exists for. Update `hashi/adapter.ts` accordingly; do not write `real.ts` against methods that are not there.
- **WHY:** read from the installed package. `docs/FACTS.md#sdk`.

### E-K9 — the guardian requires HTTP/2; `fetchGuardianInfo` fails on Node

- **WAS:** limiter state fetched via `guardian.limiterStatus` (see E-K8).
- **IS:** the guardian exposes a read-only `GET {guardian_url}/info` returning `{limiter:{state,config}, gitRevision, committeeEpoch, btcPubkey, signingPubKey, signedAtMs}`. It is served behind an ALB that **rejects HTTP/1.1 with status 464** — so Node's global `fetch`, system `curl`, and the SDK's own `fetchGuardianInfo` all fail. Use `node:http2` (ALPN `h2`) in `hashi/real.ts` and wrap it behind the adapter. `guardian_url` comes from the on-chain Hashi config, never a literal.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D4. Note the response reports the **raw last-consume state**, not a projected balance — the caller runs `projectCapacity` itself, which is precisely the G5 shape. Two samples 14 s apart returned an identical `state` with a moving `signedAtMs`, confirming this.

### E-K10 — `generateDepositAddress` is pure/offline and takes four arguments

- **WAS:** `generateDepositAddress({suiAddress})` — "client-side P2TR derivation, NO server".
- **IS:** offline is right; the signature is not. It is `({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network })` where:
  - `suiAddress` is a **32-byte `Uint8Array`** (a `0x…` hex string throws `Expected 32-byte Sui address, got 66`);
  - `guardianBtcXOnly` is the 32-byte `guardian_btc_public_key` from the on-chain Hashi config;
  - `mpcMasterCompressed` **must** be `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)` — the on-chain key is arkworks-encoded and feeding it raw throws `bad point`;
  - `network: 'signet'`.
  Likewise `witnessProgramToAddress(program, network)` and `bitcoinAddressToWitnessProgram(addr, network)` both **require** the network argument.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D6. U4 = YES: any 32-byte value (including a synthetic object id) derives a valid, deterministic signet P2TR address.

### E-K11 — §6 Pyth: the Beta feed id is resolved

- **WAS:** feed id `0xe62df6c8…` with "TESTNET REQUIRES THE BETA-CHANNEL feed id; verify via Hermes before hardcoding".
- **IS:** `PYTH_BTC_USD_FEED_ID = 0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b` (Hermes Beta, `https://hermes-beta.pyth.network`). Also pin `PYTH_STATE_INITIAL_SHARED_VERSION = 12041355` and `WORMHOLE_STATE_INITIAL_SHARED_VERSION = 1451` for PTB shared-object refs. When resolving feeds, match `attributes.symbol === "Crypto.BTC/USD"` **exactly** — the `btc/usd` query returns 12 look-alike feeds (TBTC, CBBTC, WBTC, LBTC …).
- **WHY:** `docs/FACTS.md#pyth-oracle`, `docs/DAY-ONE-RESULTS.md` §D5.

### E-K12 — §8 Walrus and Seal: concrete endpoints, and one availability gotcha

- **WAS:** Walrus/Seal endpoints unspecified; §10 lists "Seal+Walrus coexist on testnet" as an open day-one gate.
- **IS:** resolved (U7 = YES). `WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space`, `WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space` (`PUT {pub}/v1/blobs?epochs=N`, `GET {agg}/v1/blobs/{blobId}`), with staketab/nodes.guru mirrors as backups. Seal key servers: `0x73d05d62…56db75` and `0xf5d14a81…591623c8`, threshold 2 — `@mysten/seal@1.3.4` **no longer exports `getAllowlistedKeyServers`**, so pass `serverConfigs` explicitly.
  ⚠ A freshly published blob returns `"certifiedEpoch": null` and `"deletable": true`. Any availability predicate that demands certified + non-deletable will reject our own writes; allow a grace window.
- **WHY:** `docs/FACTS.md#seal-walrus-zklogin`, `docs/DAY-ONE-RESULTS.md` §D8.

### E-K13 — §10 the day-one gate list is closed

- **WAS:** step 3 lists eight open day-one gates before `real` mode.
- **IS:** all are resolved or have a documented fallback — see `docs/DAY-ONE-RESULTS.md` and `docs/FACTS.md#unknowns`. Two operational items remain and are **human**, not technical: the signet faucet drip (U6, unmeasured) and seeding the hBTC/DBUSDC book with a scripted second account (U8). **The book seeder is now a hard requirement, not an optional demo aid — the book is empty on both sides and NAV has nothing to read without it.**
- **WHY:** `docs/DAY-ONE.md` exit-gate section.
