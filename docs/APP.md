# APP.md — Aphotic × Hashi frontend spec (React + Vite)

Purpose: exact build spec for the 3-screen web app (Deposit / Exit / Transparency). Optimized for an AI coder. Facts are NOT re-derived here — every ID/type/latency lives in `docs/FACTS.md`; this file references it by anchor.
Read after: `docs/FACTS.md`, `docs/KEEPER.md` (SDK/adapter surface), `docs/MOVE-PACKAGE.md` (gateway pinning), `docs/ARCHITECTURE.md`.

---

## 0. Golden rules this file MUST encode (front-loaded)

| # | Rule (verbatim intent) | Where enforced in this app |
|---|---|---|
| GR6 | The BTC leg (deposit ~70 min, withdraw ~1.5–2 h) is NEVER live-demoable. Pre-stage. Sui side is instant. Show an earlier confirmed signet tx. | `DEMO_MODE` flag + pre-staged fixtures on every screen; §5 pre-stage table; deposit/exit lifecycle components render pre-staged records live |
| GR8 | Honesty: hBTC IS custodial-threshold wrapped BTC. Differentiation = composing the bridge's on-chain machinery (pinned exits, trustless envelope replay, permissionless deposit crank, peg-flow signal), NOT the token trust model. | `<TrustModelDisclosure/>` component (persistent footer/expander), Transparency bridge column copy, Exit pinning explainer |
| GR1 | On-Sui hBTC movement is INSTANT (one checkpoint). Bitcoin/Guardian latency exists ONLY at mint(deposit)/burn(withdraw). | Deposit lifecycle labels "Sui: instant" vs "Bitcoin: ~70 min"; Exit shows instant Sui confirm THEN a lagged signet txid |
| GR2 | Keeper holds ONLY DeepBook `TradeCap`; exits are Move-pinned; a compromised keeper cannot steal/redirect. | Exit screen pinning explainer; Transparency "keeper capability" badge |
| GR3 | You cannot buy priority in Hashi's global withdrawal queue; over-capacity batches are REJECTED. | Exit UX never offers a "fast/priority" option; congestion shown as read-only risk |
| GR5 | Guardian limiter state is TRUSTLESSLY replayable via `project_capacity()` over the `WithdrawalSigned` event stream — not a mere trusted SDK read. | Transparency bridge column "Re-derive congestion from Hashi events" button → calls keeper `verify/` replay, shows re-derived vs SDK-read side by side |
| GR9 | Pin Pyth versions + Beta feed on testnet; value NAV at DeepBook mid; staleness guards. | NAV/price display sources DeepBook mid (see `docs/FACTS.md#oracle`); a stale/divergence banner is rendered when the breaker is tripped |

If a UI element would contradict any rule above, DO NOT BUILD IT. See `docs/FACTS.md#golden-rules`.

---

## 1. Stack, layout, config

- React 18 + Vite + TypeScript, ESM. Router: `react-router` (3 routes). State: React Query (`@tanstack/react-query`) for all async SDK/RPC reads; a small zustand store for zkLogin session + `DEMO_MODE`.
- Wallet/auth: zkLogin (Google) + sponsored transactions. hBTC bridge SDK: `@mysten/hashi` v0.6.0 (ESM-only; peer `@mysten/sui ^2.22.1`) — see `docs/FACTS.md#sdk`. `client.$extend(hashi())` auto-resolves network IDs.
- The app NEVER hardcodes object IDs in logic. All IDs come from a typed config object hydrated from `import.meta.env` (Vite `VITE_` vars). See §6 env table. IDs live in `docs/FACTS.md`.
- The app talks to the bridge through the SAME Hashi adapter interface the keeper defines (`keeper/hashi/` — adapter + deterministic mock + real). In `DEMO_MODE=mock` the app binds the mock so screens render without signet. See `docs/KEEPER.md#hashi-adapter`. This mirrors `project_capacity()` exactly (GR5/GR7).

```
app/
  src/
    config/            # typed config from import.meta.env; NO literal IDs in components
    session/           # zkLogin (Google) login, ephemeral key, sponsored-tx client, zustand store
    hashi/             # thin binding to the shared keeper Hashi adapter (real | mock), DEMO_MODE switch
    screens/
      deposit/         # Screen 1
      exit/            # Screen 2
      transparency/    # Screen 3 (incl. bridge column)
    components/        # shared: QR, LifecycleStepper, AddressPill, TrustModelDisclosure, StaleBanner
    lib/               # sats formatting (u64→BTC/sats), bech32 render, explorer links
```

### Route table

| Path | Screen | Primary job |
|---|---|---|
| `/` → redirect `/deposit` | — | default |
| `/deposit` | Deposit | zkLogin → `generateDepositAddress` → QR → 6-stage lifecycle |
| `/exit` | Exit | show pinned BTC address (immutable) → `requestWithdrawal` → instant Sui confirm → signet txid |
| `/transparency` | Transparency | encrypted-strategy blob, Walrus decision log, BRIDGE COLUMN + trustless replay button |

---

## 2. Screen 1 — Deposit

Flow: Google login (zkLogin) → derive personal Taproot deposit address client-side → render QR + address → user sends signet BTC → poll/await the six-stage lifecycle → hBTC mints → sponsored PTB sweeps into vault shares.

### 2.1 Components

| Component | Responsibility |
|---|---|
| `<ZkLoginButton/>` | Google OAuth → ephemeral key + zkProof → Sui address. Emits `suiAddress`. Sponsored-tx client configured here. |
| `<DepositAddressCard/>` | Calls `generateDepositAddress({ suiAddress })` (client-side P2TR, no server — `docs/FACTS.md#sdk`). Renders `<QR/>` + `<AddressPill/>` (copy). Shows min amount = 30,000 sats and dust floor note (`docs/FACTS.md#latencies`). |
| `<DepositLifecycle/>` | Six-stage `<LifecycleStepper/>` driven by `view.depositStatus` + `waitForDeposit`. |
| `<ConfirmDepositCrankNote/>` | Copy: "Confirmation is PERMISSIONLESS — our keeper cranks `confirm_deposit` for everyone." Read-only in app; the crank runs in the keeper (`execution/`). In demo, a button can trigger the keeper crank on a pre-staged request (see §5). |
| `<DepositRealityBanner/>` | GR1/GR6 copy: "Bitcoin side ≈ 70 min end-to-end and is pre-staged for the demo; Sui side is instant." |
| `<SweepStatus/>` | After mint, shows the sponsored PTB that sweeps minted `Coin<BTC>` into vault shares; links the digest. Sweep is built by keeper `execution/`; app only surfaces status. |

### 2.2 Six-stage deposit lifecycle (the stepper)

Source of truth for stages = Hashi deposit flow in `docs/FACTS.md#latencies` and event families `docs/FACTS.md#hashi-events`. Render exactly six stages:

| # | Stage label | Underlying signal | Time class |
|---|---|---|---|
| 1 | BTC sent (unconfirmed) | mempool / `deposit::DepositRequested` after registration | Bitcoin (slow) |
| 2 | 6 BTC confirmations | 6 confs on signet (~10 min/block) | Bitcoin (slow) |
| 3 | Committee approved | `deposit::DepositApproved` (+ sanctions screen) | Bitcoin/committee |
| 4 | Mandatory 10-min delay | `bitcoin_deposit_time_delay_ms = 600000` | fixed delay |
| 5 | `confirm_deposit` (permissionless) | `deposit::DepositConfirmed` / `treasury::Minted` | Sui (instant once cranked) |
| 6 | Swept into vault shares | sponsored PTB digest; vault share event | Sui (instant) |

Total wall-clock ≈ 70+ min (stages 1–4). Label stages 5–6 "Sui: instant". NEVER present total time as fast (GR1/GR6).

### 2.3 SDK / adapter calls (Deposit)

| Call | Signature / source | Notes |
|---|---|---|
| `generateDepositAddress({ suiAddress })` | `@mysten/hashi` (`docs/FACTS.md#sdk`) | Client-side P2TR derivation, NO server round-trip. `suiAddress` = zkLogin address. |
| `view.depositStatus({ ... })` | `@mysten/hashi` | Poll via React Query (interval ~10 s). Drives stepper stages 1–5. |
| `waitForDeposit({ ... })` | `@mysten/hashi` | Promise resolving at stage 5; used to flip UI to "minted". |
| `view.balance({ suiAddress })` | `@mysten/hashi` | Confirms minted hBTC before sweep. |
| sponsored sweep PTB | keeper `execution/` (`docs/KEEPER.md`) | App triggers/awaits; does not build the PTB itself in prod. |

Do NOT call `deposit({signer, txid, utxos, recipient})` from the app — that registration path lives in the keeper (`docs/FACTS.md#composable-hashi-move-fns`, `docs/KEEPER.md`). The app's role is derive-address + observe-lifecycle + surface-sweep.

### 2.4 State (Deposit)

```
zkLogin: { suiAddress, jwt, ephemeralKey, sponsoredClient } | null
depositAddress: string (bech32m P2TR) | null
depositStatus: { stage: 1..6, confs, requestId?, mintDigest? }   // React Query
demoStaged: DepositFixture | null                                 // §5
```

---

## 3. Screen 2 — Exit

Flow: show the immutable, on-chain-pinned Bitcoin address (with the Move-pinning explanation) → user requests exit → Move gateway burns shares + composes `request_withdrawal` in ONE PTB → INSTANT Sui confirmation (event) → later a signet txid appears via `waitForWithdrawal`.

### 3.1 Components

| Component | Responsibility |
|---|---|
| `<PinnedAddressPanel/>` | Renders the depositor's `btc_exit_address` (20-byte P2WPKH or 32-byte P2TR) read on-chain from the Vault. IMMUTABLE. Includes `<PinningExplainer/>`. |
| `<PinningExplainer/>` | GR2 copy: the exit address is pinned on-chain at deposit via `gateway::register_exit_address`; `gateway::exit_to_bitcoin` composes `hashi::request_withdrawal` with THIS address in-PTB; keeper holds only DeepBook `TradeCap` and can never move or redirect BTC. See `docs/FACTS.md#golden-rules` GR2 and `docs/MOVE-PACKAGE.md#gateway`. |
| `<ExitRequestForm/>` | Amount in sats (u64). Validates `amount >= 30,000` (Hashi min) and `amount >= 546` dust floor; sub-min amounts route to per-user pending pool (`gateway` small-exit pooling) — show "pooling until it clears 30,000 sats" note. NO priority/fast option (GR3). |
| `<ExitLifecycle/>` | Two-phase: (a) instant Sui confirm — `WithdrawalRequested` event + burn digest; (b) signet broadcast — txid via `waitForWithdrawal`. |
| `<SignetTxLink/>` | Renders the broadcast txid with a signet explorer link. In demo, shows an EARLIER already-confirmed signet tx (GR6). |
| `<ExitCongestionNote/>` | Read-only: current limiter/queue state (from Transparency's bridge data). If over-capacity → warn that batches can be REJECTED (`RateLimitExceeded`), not queued (GR3). Offers `cancel_withdrawal`/`reclaim_stalled_exit` reclaim path info (pre-commit only, 1h cooldown — `docs/FACTS.md#composable-hashi-move-fns`). |
| `<ReclaimButton/>` | For a stalled pre-commit request, calls `gateway::reclaim_stalled_exit` (wraps `cancel_withdrawal`). Only enabled for Requested/Approved status + after 1h cooldown. |

### 3.2 Two-phase exit lifecycle

| Phase | What the user sees | Signal | Time class |
|---|---|---|---|
| A | "Exit confirmed on Sui" (shares burned, withdrawal requested) | `withdrawal_queue::WithdrawalRequested` + burn tx digest | Sui: INSTANT (one checkpoint) |
| B | "Broadcasting to Bitcoin…" → signet txid | batching (~10 min or threshold) → `PickedForProcessing` → Guardian+MPC → `Signed` → broadcast → 6 confs → `Confirmed` | Bitcoin: ~1.5–2 h, NEVER live |

Present phase A as done immediately (GR1). Phase B is pre-staged for the demo: show an earlier confirmed signet tx (GR6). Never spin a live progress bar that blocks on Bitcoin during judging.

### 3.3 SDK / adapter / Move calls (Exit)

| Call | Kind | Source |
|---|---|---|
| read `Vault.btc_exit_address` | RPC object read | `docs/MOVE-PACKAGE.md#vault` |
| `gateway::exit_to_bitcoin(...)` | Move PTB (burn shares → split `Balance<BTC>` → `request_withdrawal` pinned addr, atomic) | `docs/FACTS.md#composable-hashi-move-fns`, `docs/MOVE-PACKAGE.md#gateway` |
| `view.withdrawalStatus({ requestId })` | SDK | `@mysten/hashi` — drives phase B |
| `waitForWithdrawal({ requestId })` | SDK | resolves with signet txid |
| `guardian.limiterStatus` / `canWithdraw` | SDK | pre-exit UX check (read-only advisory; NOT a priority lever — GR3) |
| `gateway::reclaim_stalled_exit(...)` | Move PTB (wraps `cancel_withdrawal`) | reclaim, pre-commit only |

The app builds the `exit_to_bitcoin` PTB via zkLogin + sponsored gas. The keeper is NOT in this path (GR2: exits are user/Move-composed, keeper can't touch them).

### 3.4 State (Exit)

```
pinnedAddress: { bytes: Uint8Array, kind: 'P2WPKH'|'P2TR', bech32: string }
exitRequest: { amountSats: bigint, requestId?, burnDigest?, phase: 'A'|'B'|'done' }
withdrawalStatus: { stage, signetTxid? }     // React Query via waitForWithdrawal
reclaimEligible: boolean                      // Requested/Approved && cooldownElapsed
```

---

## 4. Screen 3 — Transparency panel

Three regions: (1) encrypted strategy blob, (2) Walrus decision-log viewer, (3) BRIDGE COLUMN with limiter state + one-click trustless replay.

### 4.1 Components

| Component | Responsibility |
|---|---|
| `<EncryptedStrategyBlob/>` | Shows the in-force strategy CIPHERTEXT (blob id + hex preview) — unreadable. Copy: Seal-gated by `aphotic::vault::seal_approve`, identity namespaced to vault object + version epoch (`docs/FACTS.md#seal`). Shows the version epoch. Optional owner-only "disclose one historical version" affordance (uses Seal version-epoch scoped disclosure). |
| `<DecisionLogViewer/>` | Lists Walrus decision records (blob ids emitted on-chain). Each row: oracle read, DeepBook L2 snapshot ref, strategy_blob id, ruleset hash, decision, result digest — and the `hashi` fields (limiter reading, queue depths, pending-mint total). See `docs/KEEPER.md#journal`. Log is published on a lag (front-run defense). |
| `<KeeperCapabilityBadge/>` | GR2 badge: "Keeper holds DeepBook `TradeCap` only — never `WithdrawCap`." |
| `<TrustModelDisclosure/>` | GR8 persistent expander: hBTC IS custodial-threshold wrapped BTC (MPC threshold Schnorr + Guardian 2-of-2). The differentiation is composing the bridge's on-chain machinery, not the token trust model. |
| `<BridgeColumn/>` | THE headline component — §4.2. |
| `<StaleBanner/>` | GR9: shown when Pyth staleness/divergence breaker is tripped (Pyth BTC/USD vs DeepBook TWAP). NAV is valued at DeepBook mid, not oracle (`docs/FACTS.md#oracle`). |

### 4.2 Bridge column (limiter state + trustless replay) — GR5

Left/read side (advisory, from SDK):
- `guardian.limiterStatus` → current token-bucket capacity (sats), `refill_rate`, `max_bucket_capacity` if exposed, global queue depth. Label clearly: this is the SDK's read. See `docs/FACTS.md#guardian-limiter`.
- `canWithdraw(amount)` advisory.

Right/proof side (the differentiator):
- Button: **"Re-derive congestion from Hashi events"**. On click → calls keeper `verify/` replay engine which recomputes the bucket trajectory + queue depth by replaying `project_capacity() = min(cap, tokens + elapsed*refill_rate)` over the on-chain `WithdrawalRequested / PickedForProcessing / WithdrawalSigned` event stream (`docs/FACTS.md#hashi-events`, `docs/FACTS.md#guardian-limiter`).
- Render re-derived value SIDE BY SIDE with the SDK read; they should match. Copy: "This is not a trusted SDK read — the whole bucket trajectory is re-derived from Hashi's own on-chain events. Only two genesis scalars (`refill_rate`, `max_bucket_capacity`) are trust anchors, and both are observationally boundable." (GR5).
- Show the "we de-risked because the bridge was tightening" trace: correlate a decision-log entry (redemption-buffer tightening) with the re-derived congestion at that timestamp.

Verification affordance (mirror keeper `verify`):
```
# equivalent CLI the panel wraps (keeper verify/):
npx ts-node src/index.ts verify --vault <VAULT_ID> --from-epoch <N> --bridge-replay
```
The panel MUST NOT frame the limiter as a mere trusted read (GR5). If `verify` disagrees with the SDK read, surface the discrepancy loudly.

### 4.3 SDK / calls (Transparency)

| Call | Source |
|---|---|
| Walrus GET (decision segments, ciphertext) | `WALRUS_AGGREGATOR` (`docs/FACTS.md#walrus`) |
| on-chain read: journal blob ids, vault version epoch | RPC (`docs/MOVE-PACKAGE.md#journal`, `#vault`) |
| `guardian.limiterStatus` / `canWithdraw` | `@mysten/hashi` |
| keeper `verify/` bridge replay | `docs/KEEPER.md#verify` |
| Pyth Beta feed + DeepBook TWAP (breaker state) | keeper `oracle/` (`docs/FACTS.md#oracle`) |

### 4.4 State (Transparency)

```
strategy: { blobId, versionEpoch, ciphertextPreview }
decisionLog: DecisionRecord[]            // paginated; includes hashi fields
bridge: {
  sdkLimiter: { capacitySats, refillRate?, maxBucket?, queueDepth },
  replay:     { capacitySats, queueDepth, trajectory[] } | null,   // from verify/
  breakerTripped: boolean
}
```

---

## 5. Demo: pre-staged vs live (GR6)

Encode a `DEMO_MODE` config: `mock` (adapter = deterministic mock, no signet) or `live` (real adapter, still uses pre-staged fixtures for BTC-latency stages).

| Element | Pre-staged | Live in demo |
|---|---|---|
| zkLogin Google login | — | LIVE (instant) |
| `generateDepositAddress` + QR | — | LIVE (client-side, instant) |
| Deposit stages 1–4 (BTC → 6 confs → approve → 10-min delay) | PRE-STAGED (a deposit warm at "approved, minting soon") | never live |
| `confirm_deposit` crank (stage 5) | request pre-staged | LIVE — permissionless mint on-screen (real on-chain transition) |
| Sponsored sweep to shares (stage 6) | — | LIVE (instant Sui) |
| Vault resting maker-side on hBTC/DBUSDC + scripted taker fill | funded vault pre-staged | LIVE fill (Sui instant) |
| Exit phase A (burn + `WithdrawalRequested`) | — | LIVE (instant Sui) — show pinned destination event |
| Exit phase B (signet broadcast + confs) | PRE-STAGED: earlier exit already broadcast on signet | show confirmed tx in explorer; never wait live |
| Bridge column trustless replay | event history pre-fetched | LIVE re-derivation click |

Standing ops (from keeper): keep 2–3 confirmed hBTC deposits + one broadcast withdrawal warm so the demo never waits on signet. See `HASHI_INTEGRATION.md` §8 (demo script) + §7 (build phases).

Fixture shape (deterministic, mirrors mock adapter):
```
DepositFixture  = { suiAddress, depositAddress, stage, confs, requestId, mintDigest? }
ExitFixture     = { requestId, amountSats, burnDigest, signetTxid, explorerUrl }
BridgeFixture   = { events: HashiEvent[], sdkLimiter, expectedReplay }
```

---

## 6. Config / env (Vite `VITE_` vars — NO hardcoded IDs in components)

| Var | Purpose | Value source |
|---|---|---|
| `VITE_SUI_NETWORK` | `testnet` | `docs/FACTS.md` |
| `VITE_DEMO_MODE` | `mock` \| `live` | GR6/GR7 |
| `VITE_APHOTIC_PACKAGE_ID` | published `aphotic` package | fill day-one |
| `VITE_VAULT_ID` | shared Vault object | fill day-one |
| `VITE_HASHI_PACKAGE_ID` | Hashi testnet pkg | `docs/FACTS.md#deployments` (`0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360`) |
| `VITE_HASHI_OBJECT_ID` | Hashi shared object | `docs/FACTS.md#deployments` (`0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8`) |
| `VITE_HBTC_TYPE` | hBTC coin type | `docs/FACTS.md#hbtc` (`0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC`) |
| `VITE_DEEPBOOK_POOL` | `Pool<hBTC, DBUSDC>` | `docs/FACTS.md#venue` (`0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6`) |
| `VITE_WALRUS_AGGREGATOR` | decision-log/ciphertext reads | `docs/FACTS.md#walrus` |
| `VITE_ZKLOGIN_CLIENT_ID` | Google OAuth client | fill day-one |
| `VITE_SPONSOR_URL` | sponsored-tx service endpoint | fill day-one |
| `VITE_PYTH_STATE` / `VITE_PYTH_FEED_ID` | Pyth state + BTC/USD Beta feed | `docs/FACTS.md#oracle` — Beta channel; verify via Hermes; PIN versions (GR9) |
| `VITE_SIGNET_EXPLORER` | signet tx link base | for `<SignetTxLink/>` |

All values that read "fill day-one" are: **UNKNOWN — resolve in DAY-ONE.md** (owner: build lead). Do not invent IDs.

---

## 7. Acceptance criteria

| ID | Criterion | Verify |
|---|---|---|
| A1 | Deposit: Google login yields a Sui address; `generateDepositAddress({suiAddress})` renders a P2TR QR client-side (no network call to a server for derivation). | Manual + intercept network; assert no server derivation request. |
| A2 | Deposit lifecycle renders exactly SIX stages with correct time-class labels (stages 1–4 Bitcoin/slow, 5–6 Sui/instant). | Snapshot test against `DepositFixture`. |
| A3 | Deposit never presents the ~70-min BTC path as fast; `<DepositRealityBanner/>` present (GR1/GR6). | Component test asserts banner + labels. |
| A4 | Exit shows the pinned address as immutable with `<PinningExplainer/>`; no UI path lets a user change the destination (GR2). | Assert no editable field on `btc_exit_address`. |
| A5 | Exit phase A confirms on Sui instantly (event + digest); phase B shows a signet txid via `waitForWithdrawal`; demo shows an EARLIER confirmed signet tx (GR6). | e2e against mock adapter + fixture. |
| A6 | Exit offers NO priority/fast option; over-capacity warns `RateLimitExceeded` (GR3). | Assert absence of priority control; force over-cap fixture → warning. |
| A7 | Transparency bridge column "Re-derive congestion from Hashi events" calls keeper `verify/` replay and shows re-derived vs SDK read side by side; copy states it is NOT a trusted SDK read (GR5). | Click → replay result matches mock; copy assertion. |
| A8 | `<TrustModelDisclosure/>` states hBTC is custodial-threshold wrapped BTC (GR8) and is reachable from every screen. | Presence test across routes. |
| A9 | NAV/price sourced from DeepBook mid; `<StaleBanner/>` renders when breaker tripped (GR9). | Force breaker fixture → banner. |
| A10 | No object ID literals in `src/screens/**` or `src/components/**`; all from `config/` (GR7). | grep: `rg '0x[a-f0-9]{16,}' src/screens src/components` returns nothing. |
| A11 | `DEMO_MODE=mock` renders all three screens end-to-end with zero signet/RPC dependency. | Run `npm run dev` with mock; walk all routes. |

### Verification commands
```bash
cd app && npm install
npm run build                      # type-check + bundle
npm run test                       # component/snapshot + e2e-mock
rg -n '0x[a-f0-9]{16,}' src/screens src/components   # MUST be empty (A10 / GR7)
VITE_DEMO_MODE=mock npm run dev     # A11 walkthrough
```

---

## 8. Cross-references

- Canonical IDs/types/latencies/events: `docs/FACTS.md` (anchors: `#hbtc`, `#deployments`, `#composable-hashi-move-fns`, `#latencies`, `#guardian-limiter`, `#hashi-events`, `#sdk`, `#venue`, `#oracle`, `#seal`, `#walrus`, `#golden-rules`).
- Hashi adapter (real/mock, mirrors `project_capacity`), sponsored sweep, `verify/` replay, journal `hashi` fields: `docs/KEEPER.md`.
- `gateway::register_exit_address` / `exit_to_bitcoin` / `reclaim_stalled_exit`, `Vault.btc_exit_address`, `seal_approve`: `docs/MOVE-PACKAGE.md`.
- Demo staging + standing ops: `HASHI_INTEGRATION.md` §7–8.
- Base UI lineage (deposit/builder/transparency dirs): `README (8).md` repository layout.

---

## ERRATA (2026-07-25)

> Source: `docs/DAY-ONE-RESULTS.md` (live probes) + `docs/RECON.md`. Canonical values live in `docs/FACTS.md`.
> **Where this section conflicts with the body of APP.md above, this section wins.** Each item is WAS / IS / WHY.
> **Also supersedes:** the §6 note that values reading "fill day-one" are "UNKNOWN — resolve in DAY-ONE.md". They are filled in — see E-A8.

### E-A1 — §1 React **19**, not React 18

- **WAS:** "React 18 + Vite + TypeScript".
- **IS:** **React 19** (`react@^19.1.0`, `react-dom@^19.1.0`).
- **WHY:** the landing page being ported in (`aydi26/nox-hackathon`, `frontend/src/components/LandingPage/`) is 7 self-contained **React 19** files with `globe.gl@^2.45.3`, `three@^0.183.2`, `@number-flow/react@^0.6.0`. Pinning React 18 forces either a downgrade of that code or two React majors in one tree. `docs/RECON.md` R13.

### E-A2 — route table: `/` is the LANDING PAGE, not a redirect to `/deposit`

- **WAS:** `| `/` → redirect `/deposit` | — | default |`
- **IS:**

  | Path | Screen | Primary job |
  |---|---|---|
  | `/` | **Landing** | ported hero/globe/beam/horizontal-scroll/FAQ; the pitch surface. CTA → `/deposit`. |
  | `/deposit` | Deposit | zkLogin → derive deposit address → QR → 6-stage lifecycle |
  | `/exit` | Exit | pinned BTC address → exit PTB → instant Sui confirm → signet txid |
  | `/transparency` | Transparency | encrypted-strategy blob, Walrus decision log, bridge column + trustless replay |

- **WHY:** the landing page is a deliverable, not a redirect. Porting notes that bind the implementation: `public/fonts/cravelo.otf` is **mandatory** (also `@font-face`'d in `LandingPage.css`); `Globe3D.jsx` fetches 4 textures/geojson from **jsDelivr at runtime** → vendor them locally so the hero renders offline; `Globe3D.jsx`'s cloud-layer `requestAnimationFrame` loop is **never cancelled on unmount** → fix during the port; `HorizontalScroll.jsx` is hardcoded to exactly 3 cards (`.hscroll-section{height:300vh}` / `.hscroll-track{width:300vw}`); the only EVM coupling is one import of `../../lib/publicReader.js` feeding two stat counters → replace with a Sui read that never throws. `docs/RECON.md` R13.

### E-A3 — `<ReclaimButton/>` MUST be signed by the depositor

- **WAS:** `<ReclaimButton/>` "calls `gateway::reclaim_stalled_exit`", with no signer constraint, while §3.3 says "The keeper is NOT in this path".
- **IS:** it must be signed by the **depositor's own zkLogin session** and by nobody else. `hashi::withdraw::cancel_withdrawal` asserts `request.sender == ctx.sender()`, and the request sender is whoever signed the original `request_withdrawal` PTB. A relayed / keeper-signed / sponsor-signed-as-a-different-sender reclaim **aborts `EUnauthorizedCancellation`**. Sponsored gas is still fine — sponsorship changes who *pays*, not who the *sender* is; make sure the sponsored-tx wiring keeps the depositor as sender.
- **WHY:** source- and bytecode-verified. `docs/FACTS.md#hashi-move-api`, `docs/RECON.md` R7.3. The `<PinningExplainer/>` copy should say this out loud — "only you can cancel your own exit" is a strong, true, G2-reinforcing line.

### E-A4 — §2.3/§3.3: most of the `@mysten/hashi` calls listed do not exist

- **WAS:** `view.depositStatus`, `view.withdrawalStatus`, `view.balance`, `view.all`, `waitForDeposit`, `waitForWithdrawal`, `guardian.limiterStatus`, `guardian.canWithdraw`, `requestWithdrawal`, `cancelWithdrawal`.
- **IS:** `@mysten/hashi@0.6.0` exports only `HashiClient`, `hashi`, `generateDepositAddress`, `deriveChildPubkey`, `twoOfTwoTaprootScriptPathAddress`, `bitcoinAddressToWitnessProgram`, `witnessProgramToAddress`, `arkworksToSec1Compressed`, `projectCapacity`, `estimateWaitSecs`, `fetchGuardianInfo`, and error classes. Every lifecycle read the screens need must come from the **shared adapter** (`keeper/hashi/`) built on event polling + raw `moveCall`s — which the app already binds per §1. No screen may import `@mysten/hashi` directly.
- **WHY:** read from the installed package. `docs/FACTS.md#sdk`. This is a net simplification: the app was always supposed to go through the adapter (G7); the erratum just removes the illusion that a shortcut existed.

### E-A5 — deposit-address derivation needs three inputs, not one

- **WAS:** §2.3 `generateDepositAddress({ suiAddress })`.
- **IS:** `generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly, suiAddress, network: 'signet' })` where `suiAddress` is a **32-byte `Uint8Array`** (a `0x…` string throws), `guardianBtcXOnly` is the on-chain `guardian_btc_public_key`, and `mpcMasterCompressed` is `arkworksToSec1Compressed(Hashi.committee_set.mpc_public_key)` (raw arkworks bytes throw `bad point`). It is fully offline — the QR can render before any network call resolves.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D6. Both key inputs are read from the `Hashi` shared object, so the deposit screen needs that object read on mount (or cached in config).

### E-A6 — §4.2 bridge column: real limiter numbers, and a honesty adjustment

- **WAS:** limiter state framed around an implied small bucket; `guardian.limiterStatus` as the read.
- **IS:** live values are `refill_rate = 115_740` sats/s and `max_bucket_capacity = 10_000_000_000` sats (**100 BTC**, refilling ~100 BTC/day), read from `GET {guardian_url}/info` — **HTTP/2 only**, so it cannot be fetched from browser `fetch` against an HTTP/1.1 path and must come through the adapter/keeper. The panel should present the **replay** (`projectCapacity` re-derived from Hashi's own `WithdrawalSigned` stream, matching the journal) as the headline, and the raw guardian reading only as a cross-check.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D4. ⚠ **Do not write congestion copy.** With a 100 BTC/day bucket, an Aphotic-sized exit will never be throttled on testnet, and a judge who checks will catch an over-claim. The true, checkable claim is verifiability: "we re-derive the bridge's own rate limiter from its own on-chain events." Also note `WithdrawalSigned` carries **no amount and no timestamp** — the replay joins `request_ids` back to `WithdrawalRequested.btc_amount` and uses the event **envelope** `timestampMs`; if the panel shows a per-batch amount, that is where it comes from.

### E-A7 — book/price reads: `get_level2_range`, never `mid_price`; and the book is empty

- **WAS:** implied readable mid / indexer-backed depth.
- **IS:** the hosted DeepBook indexer **does not list** hBTC/DBUSDC. Read depth by simulating `pool::get_level2_range` against the callable package `0xd874d241…` (v20). `pool::mid_price` **aborts** `EEmptyOrderbook` on an empty book, and the book **is** empty on both sides right now. Every price surface (NAV, deposit/exit valuation, transparency) must render a defined empty state — "no book yet" — rather than an error boundary.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D3, `docs/FACTS.md#deepbook-venue`. Until the scripted seeder account quotes, the empty state is what the demo actually shows.

### E-A8 — §6 config: values that are no longer UNKNOWN

- **WAS:** `VITE_` table with placeholders for the Pyth feed, Seal/Walrus endpoints, and the DeepBook package.
- **IS (all now canonical, `docs/FACTS.md`):**

  | Var | Value |
  |---|---|
  | `VITE_DEEPBOOK_PKG` | `0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24` (v20 — **not** `0x22be4cad…`, which is superseded v17) |
  | `VITE_DEEPBOOK_ORIGINAL_PKG` | `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` (type origin) |
  | `VITE_POOL_ID` | `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` |
  | `VITE_HASHI_PKG` / `VITE_HASHI_OBJECT` | `0xfcea10ca…c7f4360` / `0x22c0ce66…4528f8` |
  | `VITE_PYTH_BTC_USD_FEED_ID` | `0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b` (**Beta**) |
  | `VITE_WALRUS_AGGREGATOR` | `https://aggregator.walrus-testnet.walrus.space` |
  | `VITE_SEAL_KEY_SERVER_1` / `_2` | `0x73d05d62…56db75` / `0xf5d14a81…591623c8` (threshold 2) |
  | `VITE_ZKLOGIN_PROVER` | `https://prover.mystenlabs.com/v1` |
  | `VITE_SUI_RPC` | gRPC endpoint — `https://fullnode.testnet.sui.io:443`. **JSON-RPC against that host is 404**; if a JSON-RPC path is unavoidable, use the mirror `https://rpc-testnet.suiscan.xyz:443`. |

- **WHY:** `docs/FACTS.md#rpc-transport`, `#deepbook-venue`, `#pyth-oracle`, `#seal-walrus-zklogin`. The no-literal-IDs rule (§1, G7) is unchanged — these belong in `.env.example` and `app/src/config.ts` only.

### E-A9 — §5 demo staging: the measured BTC-leg number

- **WAS:** withdrawal "~1.5–2 h" as the staging assumption.
- **IS:** one real observed withdrawal went `Requested → Signed` in **5.4 min** and `Requested → Confirmed` in **57.9 min** on a quiet signet. Keep the conservative planning figure (it is one sample), but the pre-staging window is likely tighter than feared.
- **WHY:** `docs/DAY-ONE-RESULTS.md` §D10e. **GR6 is unaffected** — 58 minutes is still far outside a 3-minute demo. Do not be tempted to go live on the BTC leg.
