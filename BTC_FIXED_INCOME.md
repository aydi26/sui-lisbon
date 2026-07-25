# Native-BTC Fixed Income on Hashi — design & jury prep (pre-code)

> Status: ideation deliverable, 2026-07-24. No code yet. This is the corrected, adversarially-stress-tested version of the "fixed-term BTC credit with PT/YT" idea. All three review lenses (Mysten-engineer, fixed-income-risk, originality) scored the *advisor's* framing 4/10 and demanded a reframe; the design below is the reframe that survives.
>
> One-line product: **a fixed-term bond whose principal is delivered as *native BTC* through Hashi, and whose price is the on-chain term structure of native-BTC settlement liveness.** Working name: **Meridian** (a yield-curve/term-structure connotation). Rename at will.

---

## 0. TL;DR — what changed and why

The advisor's proposal had two load-bearing premises. **Both are false**, verified against Hashi's Move + Rust source:

1. ❌ *"Bitcoin's structural latency means fixed-term over-collateralized credit doesn't need instant liquidation."*
   hBTC is a **standard fungible `Coin<hashi::btc::BTC>`** (8 dec, unregulated, no deny list). Its collateral liquidation is a pure on-Sui token move that settles in **one Sui checkpoint (sub-second), with ZERO Bitcoin/Guardian latency**. A maturity date does **not** remove intra-term liquidation risk — Notional, Term Finance and Yield Protocol all liquidate over-collateralized fixed-term debt *before* maturity. Deferring liquidation to maturity on volatile BTC collateral = a guaranteed under-water book.

2. ❌ *"The Guardian can delay a withdrawal, so liquidation is asynchronous — a window where a position is under-collateralized but not yet liquidatable."*
   The Guardian rate limiter / 6-conf / 10-min delays gate **only** the `hBTC → native BTC` burn boundary. They never sit between "position under-collateralized" and "liquidator holds the hBTC." So **Idea 2 (pre-liquidation Dutch auction + latency backstop) prices a risk that does not exist**, and a Mysten judge spots it in ten seconds.

**What is true and un-clonable:** the ONE place native-BTC latency genuinely bites is the **aggregate-redemption boundary**. Native-BTC *out* is gated by a single global Guardian **token bucket** (sample signet config ≈ **0.864 BTC/day**, ~27.8 h to refill 1 BTC). That congestion is real, shared, non-parallelizable, and **exists on no wrapped BTC**.

**The reframe:** stop pricing collateral-liquidation latency (fake). Price **native-BTC settlement liveness** (real, Hashi-exclusive). The bond settles to native BTC via `request_withdrawal` to an on-chain-pinned Bitcoin address, and its discount curve prices credit + rate + **redemption-queue congestion at that maturity**. The "backstop" is reborn as a **redemption-liveness tranche**.

Also: it is **not** Pendle PT/YT — hBTC is **not yield-bearing**, so there is no SY-yield to strip. It is a **collateralized fixed-term zero-coupon bond** (Notional / Term / Yield family). Call it that.

> ### ⚠️ Mechanism v2 corrections (deep stress-test, 2026-07-24) — §10 is authoritative
> A 5-agent mechanism-design pass caught **two errors in our own first-cut design**. Read §10 before building:
> 1. **STRENGTHENS us — congestion is ~99% TRUSTLESS, not "keeper-attested."** Hashi's `LocalLimiter` is advanced purely by on-chain `WithdrawalSigned` events through `project_capacity() = min(cap, tokens + elapsed·refill_rate)`. So the whole bucket trajectory + global queue depth is **replayable on-chain** from the `WithdrawalRequested / PickedForProcessing / Signed` event stream. The only trust anchors are **two genesis scalars** (`refill_rate`, `max_bucket_capacity`) — themselves observationally bounded from the cleared-volume envelope. Ship a permissionless `verify` replay. This clears the institutional "transparent, verifiable" bar far better than an SDK read.
> 2. **DISCIPLINES us — you cannot buy priority in Hashi's global queue.** The bucket **rejects** over-capacity batches (`RateLimitExceeded` in `limiter.rs`), it does not hold an orderable queue; `next_seq` is a per-*batch* counter assigned off-chain by a committee leader whose ordering is "generally FIFO, not strict." So Meridian can only ration **the rate at which it calls `request_withdrawal`** and **order its own pending burns** — it cannot sell global-queue priority. The friend's Dutch auction therefore sells **"who gets fronted by Meridian's own redemption-liveness reserve this window"** (a good we control), NOT queue priority (a good we don't). With that reframe + the IC fixes in §10, the auction survives.
>
> **Honest economics:** the congestion premium is a **tail-insurance** product — small steady carry (~18 bps/yr on book, ~90 bps/yr on liveness capital), fat rare tail (~0.5 BTC/day in a crash). Its **entire magnitude rides on the two unpublished live limiter constants** → **querying them on-chain is day-one action #1.** (Warning: the `limiter.rs` *test* constant is a 0.02-BTC bucket; if live values are that small the product can barely move BTC; if huge, the congestion bar is ~2 bps and invisible. There is a viable band; we are betting on landing in it, sight-unseen.)

---

## 1. Verified facts (source-grounded)

### hBTC (the collateral / settlement asset)
- Type: `hashi::btc::BTC`; testnet fully-qualified `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC`.
- **Fungible standard `Coin<BTC>`** via `sui::coin_registry::new_currency`. 8 decimals, symbol `hBTC`, units = satoshis. `struct BTC has key { id: UID }` is only the currency *witness* type, not what users hold — do not be fooled by it.
- **Unregulated**: no `make_regulated`, no `DenyCap`, no deny list, no coin-level pause, no transfer restriction. Any third-party Move contract can custody / `split` / `join` / transfer it. `TreasuryCap` lives inside the shared `Hashi` object; `mint`/`burn` are `public(package)` (we cannot mint; we don't need to).
- No non-fungible / position representation exists anywhere in Hashi.

### The composable withdrawal (our load-bearing hook)
```move
// packages/hashi/sources/btc/withdraw.move
public fun request_withdrawal(
    hashi: &mut Hashi, clock: &Clock,
    btc: Balance<BTC>, bitcoin_address: vector<u8>, ctx: &mut TxContext)
    // asserts amount >= config.bitcoin_withdrawal_minimum()  (min 30,000 sats)
    // asserts bitcoin_address is 20 bytes (P2WPKH) or 32 bytes (P2TR)
    // emits WithdrawalRequested
public fun cancel_withdrawal(
    hashi: &mut Hashi, request_id: address, clock: &Clock, ctx: &mut TxContext): Balance<BTC>
    // requester-only (EUnauthorizedCancellation); ONLY in Requested/Approved states
    // (ECannotCancelProcessingWithdrawal once committed/burned); 1h cooldown; refunds hBTC
```
`request_withdrawal` is a **`public fun`** — callable inside *our* PTB. This is what makes "principal terminates in native BTC at a contract-pinned address" possible. `cancel_withdrawal` only reclaims **your own** pre-commit exit — it cannot interpose on anyone else's.

### Latencies & the Guardian bucket (the real risk we price)
- **Deposit** ≈ 6 BTC confs (~60 min) + committee approval + **10-min delay** (`bitcoin_deposit_time_delay_ms = 600000`), then permissionless `confirm_deposit` mints. ≈ **70 min end-to-end — never live-demoable; pre-stage it.**
- **Withdrawal** ≈ up to ~10-min batch wait + sign + 6 confs (~60 min) ≈ **1.5–2 h**, plus any bucket wait.
- **Guardian token bucket**: single **global** bucket, denominated in sats: `refill_rate` (sats/s) + `max_bucket_capacity` (sats). Serialized via strict monotonic `next_seq`. Over-capacity requests **wait in FIFO** until refill. Sample signet config: `1000 sats/s`, `100_000_000 sats (1 BTC)` ⇒ **≈ 0.864 BTC/day sustained, ~27.8 h to refill an empty 1-BTC bucket**. ⚠️ These are **sample/devnet** values; **live testnet values are unpublished — query on-chain day one.** Mechanism exact; magnitude illustrative.
- **60-day recovery leaf**: Taproot leaf spendable MPC-only after a 60-day timelock if the Guardian is lost.

### Oracle & venue
- **Pyth** on Sui testnet: State `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c`, package `0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837`. Canonical **stable** BTC/USD feed `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` — **testnet requires the Beta-channel feed ID; verify via Hermes before hardcoding**. Pyth DAO auto-upgrades Sui addresses **2026-08-18 — pin versions**. Hashi's institutional path references **CF Benchmarks** for BTC pricing — confirm whether the hBTC lending oracle is CF or plain Pyth.
- **DeepBook v3** `Pool<hBTC, DBUSDC>` = `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6`; DBUSDC = `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC`. Liquidation-routing + hBTC price-discovery venue. Book is days old ⇒ **value hBTC collateral at a haircut to the DeepBook price, not raw Pyth BTC/USD**, to defend against hBTC depeg under exit throttling.

### Competitive reality (from the prize page + Hashi launch coverage)
- Sui bounty = **$6,000** ("Best App Built on Sui" $4k + Continuity $2k). Featured stack: Move, Walrus, Seal, DeepBook, zkLogin. **No mention of Hashi/BTC/lending anywhere** — "jury expects Hashi" is a *soft* expectation, not a scored requirement. Rubric: **"meaningful (non-superficial) integration," "depth over breadth," "market-viable," working demo, "why Sui."**
- **Suilend, AlphaLend, Navi, Scallop are integrating Hashi day one**; 25+ institutions (BitGo, Cumberland, FalconX) testing. A generic "deposit hBTC → borrow → yield" pool is the single most crowded idea and a strictly-worse copy of four funded incumbents ⇒ reads as **cosmetic**.
- Mysten's stated builder priorities explicitly name **"BTC-collateralized bonds / fixed income"** and prime brokerage, with prereqs = transparent collateral management, verifiable terms, on-chain collateral-health visibility. Our reframed product hits this bullseye.
- **Tenor** (team's cited prior art) = fixed-rate fixed-term lending on **Base**, built on **Morpho** — not Sui. Relevant as pedigree/design reference, not as a Sui precedent. **"Wift" returned no public record — do NOT cite it to the jury without a source URL.**

---

## 2. The product (reframed)

**Meridian = a native-BTC-settled, fixed-term zero-coupon bond, tranched by redemption liveness.**

- A borrower locks collateral and mints **ptBTC** — a fungible zero-coupon claim that redeems for **1 BTC-equivalent at maturity T**. A lender buys ptBTC at a discount today; their fixed BTC yield = `(1/price − 1)` annualized.
- **Redemption is native.** At maturity (or lender election), redemption composes `hashi::withdraw::request_withdrawal(..., Balance<BTC>, bitcoin_address, ...)` in the **same PTB**, delivering **native BTC to a Bitcoin address pinned on-chain at issuance**. Even a compromised keeper/frontend cannot redirect it. *This is the one thing wBTC/tBTC and every incumbent money-market structurally cannot replicate.*
- **The discount is a term structure of native-BTC settlement.** Across maturities (1/3/6/12-mo), each ptBTC discount prices three decomposable things: (a) credit/collateral risk, (b) the fixed rate, and (c) **redemption-queue congestion at that maturity** — read live from the Guardian bucket. A maturity landing on a congested date trades at a **deeper discount**. This curve *cannot exist on wrapped BTC*, because wrapped BTC has no protocol-level exit throttle to ration.
- **Two tranches turn the advisor's "backstop" into something real:**
  - **Senior / "prompt"**: guaranteed native-BTC delivery within a bounded window at maturity → **lower** yield (you pay for liveness/priority).
  - **Junior / "liveness"**: accepts later delivery when the bucket is drained, warehouses congestion timing → **earns** the congestion premium.
  A pre-funded **redemption-liveness reserve** backs the senior guarantee; the junior tranche + reserve *is* the backstop, repriced onto the risk that actually exists.
- **Collateral liquidation stays instant and synchronous on Sui**: continuous Pyth BTC/USD health check, prompt permissionless seizure, liquidation routed through the hBTC/DBUSDC DeepBook pool, hBTC valued at a DeepBook haircut. **We state plainly that liquidation is NOT where latency lives** — that single sentence signals to a Hashi judge that we understood the system.

### Where the yield actually comes from (the question that kills fixed-income projects)
1. **Borrow-demand interest** on originated loans (real, but thin on a 4-day-old testnet → scripted borrower for the demo, disclosed).
2. **The settlement-congestion premium** — intrinsic and Hashi-exclusive: prompt native-BTC exit is a *scarce good* (the bucket), so those who want it now pay those who wait. **This yield exists even with zero external borrowers**, which is what makes the demo economically honest rather than fictional.
3. (Grand-unified, stretch) **market-making yield**: idle hBTC deployed maker-first on DeepBook — this is where the original **Aphotic** engine returns as the *yield source* backing the interest strip, not as a separate product.

---

## 3. Architecture deltas (names, no code)

**Move package**
- `bond.move` (new) — `ptBTC` zero-coupon accounting; issuance (lock collateral → mint ptBTC at market discount), maturity redemption, tranche split (senior/junior), per-holder pinned `bitcoin_address: vector<u8>` (20/32 bytes) fixed at issuance.
- `settlement.move` (new) — the Hashi boundary: `redeem_to_bitcoin` (burn ptBTC → split `Balance<BTC>` → `hashi::withdraw::request_withdrawal` with pinned address, one PTB), `reclaim_stalled` (wraps `cancel_withdrawal` for our *own* pending exits), and the **redemption-liveness reserve** that fronts senior redemptions when the bucket is congested.
- `risk.move` (new) — continuous health factor from Pyth BTC/USD (Beta feed) with an hBTC **DeepBook-haircut** valuation; permissionless instant liquidation routed to the hBTC/DBUSDC pool; liquidation threshold + close factor.
- `curve.move` (new) — reads live Guardian bucket state (limiter status + withdrawal-queue depth from the `Hashi` shared object if getters exist; fallback: keeper-attested readings) and exposes the per-maturity congestion input that prices the discount.

**Keeper (off-chain, TypeScript)**
- `hashi/` — event watcher (deposit/withdrawal/mint/burn families); permissionless `confirm_deposit` crank; `guardian.limiterStatus`/`canWithdraw` poller feeding the curve and logged to Walrus.
- `settlement/` — maturity scheduler that **staggers maturities against the bucket refill rate**; redemption batch driver (`waitForWithdrawal` → surfaces signet txid).
- `pricing/` — discount-curve construction decomposed into credit / rate / congestion.

**App**
- Issue screen: lock collateral → mint ptBTC at a shown discount; pin the payout Bitcoin address (with the Move-pinning explanation).
- Curve screen: the native-BTC settlement curve across maturities, with the congestion component highlighted live from the Guardian bucket.
- Redeem screen: maturity → Sui-side burn instantly → signet txid when the native BTC is broadcast; senior vs junior delivery state.

---

## 4. Hashi touchpoints (exhaustive)

| Touchpoint | Kind | Where it plugs in |
|---|---|---|
| `hashi::btc::BTC` (fungible, sats) | Move coin | collateral + ptBTC face unit + DeepBook pricing |
| `request_withdrawal(…, Balance<BTC>, vector<u8>, …)` | Move `public fun` | `settlement::redeem_to_bitcoin` — composed in the redemption PTB |
| `cancel_withdrawal(…): Balance<BTC>` | Move `public fun` | `settlement::reclaim_stalled` — our own congested exits only |
| `bitcoin_withdrawal_minimum()` (30,000 sats) | Move config | min redemption size; small-holder pooling |
| Guardian token bucket (`refill_rate`, `max_bucket_capacity`) | off-chain enclave state, queryable | **the congestion input priced into the curve** — the whole thesis |
| `guardian.limiterStatus` / `canWithdraw` | SDK | curve pricing; pre-redeem UX; Walrus log |
| permissionless `confirm_deposit` crank | PTB | keeper onramp (public good) |
| `view.withdrawalStatus`, `waitForWithdrawal` | SDK | redemption tracking + signet txid surfacing |
| `Hashi` shared object `0x22c0…28f8` | Move | withdrawal-queue depth read (if getters exist) |
| DeepBook `Pool<hBTC,DBUSDC>` `0x5cda…ced6` | DeepBook | liquidation routing + hBTC price discovery |
| Pyth BTC/USD (Beta feed, testnet) | oracle | health factor trigger |

---

## 5. Phased build plan (36h, with cut line)

| Phase | Scope | Est. |
|---|---|---|
| 0 | Day-one checklist: query **live** limiter values on-chain; confirm Hashi testnet IDs respond; one manual end-to-end Hashi deposit+withdraw to learn real timings; start faucet dripping; confirm Pyth Beta BTC/USD feed via Hermes; confirm hBTC/DBUSDC book state. **Wrap Hashi behind an adapter interface with a mock impl from line one.** | 2–3 h |
| 1 | `bond.move`: ptBTC issuance + maturity redemption + pinned address; `settlement.move`: `redeem_to_bitcoin` composing `request_withdrawal`; tests | 6–8 h |
| 2 | `risk.move`: Pyth health factor + DeepBook-haircut valuation + instant liquidation; keeper Hashi watcher + limiter poller | 6–8 h |
| — | **CUT LINE — MVP: issue ptBTC at a discount → BTC drops → pre-maturity liquidation on DeepBook → maturity → redeem to a native BTC address.** One maturity, single (scripted, disclosed) counterparty. | |
| 3 | `curve.move` + pricing: multi-maturity discount curve with the live congestion component | 4–6 h |
| 4 | Senior/junior tranching + redemption-liveness reserve; app curve screen | 4–6 h |
| 5 | Stretch: Aphotic market-making engine as yield source; Walrus decision log; Seal-gated institutional terms | 4–6 h |

**Do not rely on "maturity means no liquidation."** Keep instant liquidation. The demo must *show* a seizure.

---

## 6. Demo script (3 min)

Pre-staged: hBTC already minted (deposits are ~70 min); one bond issued; one earlier redemption already broadcast on signet.

1. *(0:00)* "A fixed-term Bitcoin bond that pays you back in **real Bitcoin** — and prices something no wrapped BTC can: the cost of getting your Bitcoin *out*." Issue a ptBTC at a visible discount; pin the payout BTC address; explain the discount = rate + credit + **exit-congestion**.
2. *(0:50)* Drop the BTC/USD Pyth price on a test feed → health factor breaches → **live instant liquidation** routed through DeepBook. "Liquidation is instant on Sui — Bitcoin latency never touches on-Sui collateral. We say that on record."
3. *(1:40)* Show the settlement **curve** across maturities, with the congestion component pulled live from the Guardian bucket (`limiterStatus`). "This is a term structure of native-BTC settlement. It literally cannot exist on wBTC."
4. *(2:20)* **Redeem live**: one PTB burns ptBTC and calls `request_withdrawal` to the pinned address → show `WithdrawalRequested` + the earlier redemption's signet tx confirming in an explorer. "Native BTC out, to an address our contract refuses to change."
5. *(2:50)* "We didn't list hBTC in a pool. We built the first bond that prices, and settles, native Bitcoin."

---

## 7. Jury Q&A — the 8 hardest, with answers

1. **"Where does Bitcoin latency sit between 'under-collateralized' and 'liquidator holds the hBTC'?"** → Nowhere. hBTC is a fungible Sui coin; liquidation is one checkpoint, latency-free. We price latency only at native-BTC egress, which is the one place it's real.
2. **"Everything in your bond compiles against wBTC. What line reads a Hashi-specific property?"** → Redemption: `request_withdrawal` settling principal to a pinned Bitcoin address, and the discount's congestion component read from the Guardian bucket. Swap in wBTC and both vanish.
3. **"Where does the yield come from?"** → Borrow-demand interest (scripted counterparty in the demo, disclosed) + the intrinsic settlement-congestion premium (exists with zero borrowers) + optional DeepBook market-making. hBTC is not yield-bearing; we never claim otherwise.
4. **"BTC gaps 40% mid-term — what stops bad debt?"** → Continuous Pyth health factor + instant DeepBook-routed seizure, hBTC valued at a DeepBook haircut (not raw oracle) to survive depeg. The fixed *rate* is set at origination; the *liquidation trigger* is continuous. We reject "maturity means no liquidation."
5. **"100 bonds mature the same day; the bucket does ~1 BTC/day. Who gets paid?"** → That's exactly the risk we price: maturities are staggered against the refill rate; senior tranche + a pre-funded liveness reserve get bounded-window delivery; junior tranche is paid the congestion premium to absorb the tail. And we quote *live* limiter values, not the sample.
6. **"Isn't this just Notional/Term with hBTC?"** → Notional/Term settle to a token IOU. Ours settles to **native BTC at a Bitcoin address**, and its curve prices an exit-throttle that only exists on Hashi. That's the wedge.
7. **"Suilend/Navi/Scallop integrate Hashi day one — why aren't you their pool #11?"** → Because they lend hBTC and stop at a token. At maturity we call `request_withdrawal`; principal leaves the chain as Bitcoin. None of them price or settle native-BTC liveness.
8. **"Wift? Tenor?"** → Tenor: fixed-rate fixed-term on Base/Morpho — our design reference, not a Sui precedent. Wift: we won't claim it without a source. (Have a URL ready or drop it.)

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| Hashi testnet 2 days old, breaking changes | Adapter + mock from line one; pre-stage all Hashi state; keep IDs configurable |
| Live limiter values unknown | Query on-chain day one; present magnitude as illustrative until then |
| hBTC depeg on thin DeepBook book | Value collateral at DeepBook haircut, not raw Pyth; document the assumption |
| No real borrowers on testnet | Scripted counterparty, disclosed; lean the demo on the intrinsic congestion premium |
| Pyth Beta-feed / DAO auto-upgrade 2026-08-18 | Use Beta feed ID; pin package versions; add staleness guards |
| 70-min deposits break a live demo | Nothing live depends on Bitcoin confirmations; pre-stage; crank `confirm_deposit` live for realism |
| Redemption batch stalls past a maturity "guarantee" | Senior window is bounded-but-not-instant by design; reserve fronts it; disclose Sui-maturity vs native-delivery-date distinction |

---

## 9. Positioning vs the existing repo

The repo currently holds two READMEs: `README (8).md` (Aphotic — private LP vault) and `HASHI_INTEGRATION.md` (Aphotic × Hashi — "integrate the bridge"). This document is a **different product** in the same Hashi-native spirit. The clean relationship:
- **Meridian** (this doc) is the headline: a native-BTC fixed-income primitive — hits Mysten's explicitly-named "BTC-collateralized bonds / fixed income" priority.
- **Aphotic's maker-first engine** becomes Meridian's optional **yield source** (Phase 5), not a competing product.
- Both share the same load-bearing Hashi hook: `request_withdrawal` composed in Move with an on-chain-pinned destination.

Decide before the code phase whether to ship Meridian standalone (recommended — sharper, less surface) or Meridian-with-Aphotic-yield (grand-unified — only if Phases 0–4 land with time to spare).

---

## 10. Deep mechanism (adversarially verified) — authoritative

This section supersedes any looser framing above. It is the output of a 3-designer + 2-skeptic pass. Two of our own first-cut errors were caught (see §0 box) and are corrected here.

### 10.1 Pricing — the three-bar term structure

A `ptBTC(T)` is a zero-coupon claim on **1 BTC face, delivered as native BTC** via `request_withdrawal` at maturity T. Price = a product of three **separable, closed-form** factors, each a function of published inputs:

```
P_ptBTC(T) = P_rate(T) · P_credit(T) · P_cong(T)
P_rate   = exp(−r·T)              r = BTC term base rate (borrow utilisation; governance-pinned when book thin — LABEL administered)
P_credit = exp(−h·LGD·T)          h = liquidation-gap hazard, LGD = loss given gap (small: liquidation is instant on Sui)
P_cong   = exp(−λ·τ_mean) · exp(−κ·λ·σ_τ)   the Hashi-exclusive bar
```

**Render the bars as `−ln P_i`** (exactly additive at any magnitude; the naive bps-sum is only a first-order approximation and breaks for large discounts). **Publish the exact product `P` as the price.**

**Congestion wait**, from the replayed bucket state at T (`R`=refill sats/s, `L`=level, `B_global`=global FIFO sats ahead, `Q_mer`=our own cohort at T):
```
need_first = max(0, B_global − L);  need_last = max(0, B_global + Q_mer − L)
τ_first = need_first/R;  τ_last = need_last/R;  τ_mean = (τ_first + τ_last)/2
```
**Calibrate λ (liveness carry) to observables** — the DeepBook hBTC/DBUSDC basis and the senior/junior spread the auction actually clears — so λ is market-derived, never "a number you invented."

### 10.2 Worked example (illustrative sample bucket: R=1000 sats/s, cap=1 BTC ⇒ 0.864 BTC/day)

3-month cohort: `Q_mer=5 BTC`, `B_global=2 BTC`, `L=0.2 BTC` ⇒ τ_first=2.08 d, τ_last=7.87 d, **τ_mean≈4.98 d**.
With λ=8%, κ=1.5, σ_τ=0.4·τ_mean: **P_cong ⇒ 17.4 bps** of discount.
Full price (r=3%, h=2%, LGD=10%, T=90/365): **P_rate 73.7 bps · P_credit 4.9 bps · P_cong 17.4 bps ⇒ P=0.990411 ⇒ ~3.93% fixed yield.** The jury sees three bars; the 17.4 bps is the part impossible on wrapped BTC.

**The curve bends with scarcity** (3mo, vs the 0.864 BTC/day bucket): cohort 1 BTC → 1.8 bps; 5 BTC → 17.8 bps; 12 BTC → 44 bps; 20 BTC → 80 bps. Across maturities the congestion bar is genuinely non-monotone (each T has its own projected cohort) — a real curve, not one opaque yield.

### 10.3 The redemption-liveness market (the friend's Dutch auction, corrected home)

**What is sold:** NOT global-queue priority (unbuyable — bucket rejects over-capacity batches, leader orders batches off-chain). It sells **first claim on Meridian's own pre-funded redemption-liveness reserve this window** — real hBTC Meridian holds and can pay out now. That good IS deliverable.

- **Senior ptBTC** = liveness providers: reserve-fronted native BTC within a bounded window W; lower yield; senior principal seeds the reserve.
- **Junior ptBTC** = warehouses the tail; higher yield; is who bids.
- **Reserve** `R = ρ · peak rolling single-window senior demand` (size to worst-case tail, assuming **zero reclaim** for any request past `Processing` — see 10.5). Funded by senior principal + recycled premia + maker spread.
- **Dutch auction** per window: descending clock in bps of principal a junior forgoes to be fronted now; **uniform clearing price** (truthful bidding); pro-rata at the clearing tick.

**Worked auction:** window capacity 3.0 BTC (reserve draw); 8 junior bidders, 8.6 BTC demand; clock 300→…→**clears 180 bps**; H1–H3 fully served (2.3 BTC), H4 pro-rated 58%, rest fall to next window free or take hBTC. Premium = 3.0 × 180 bps = **0.054 BTC**. Tail: 20 BTC/day drain vs ~3.17 BTC prompt supply ⇒ clock pins near cap ⇒ **~0.5 BTC/day** liveness payout.

### 10.4 Incentive-compatibility fixes (mandatory, enforce on-chain)

The naive design has three real IC holes. Fixes:
1. **Wash-pump under uniform pricing:** an actor owning both junior ptBTC *and* the reserve bids high to lift the clearing price, then the reserve they own captures it. → **Exclude any senior/reserve-linked address from junior bidding (Move assertion, not convention); rebate premia to the LOSING juniors** (who provided the liveness), not to reserve owners.
2. **Issuer self-dealing:** borrower controls `split_tranche` and (if tunable) the congestion premium. → **`congestion_premium` must be a pure, non-tunable function of the attested+replayed bucket state**; senior issuance capped by an externally-verifiable reserve-coverage ratio.
3. **Free-loser front-run:** an auction loser self-exits into the global bucket and beats the winners. → Submit winners **atomically in the clearing PTB** to shrink the window; state plainly "prompt" = *submitted first by us + reserve-fronted*, never *confirmed first on Bitcoin*.
Plus: min-participation floor (clear at 0 bps / pure FIFO below it); round allocations to **30,000-sat lots with miner-fee headroom** (else `request_withdrawal` aborts `EBelowMinimumWithdrawal` / `EOutputBelowDust`); reserve circuit-breaker → convert senior guarantee to pro-rata + halt senior issuance when `reserve/senior-claims < threshold`.

### 10.5 Corrected trust model & the reclaim limit

- **Trustless on-chain:** ptBTC accounting, pinned address, `request_withdrawal` composition, liquidation, our own `Q_mer` schedule, **and the full bucket trajectory + `B_global`** (replay `project_capacity()` over the `WithdrawalRequested/PickedForProcessing/Signed` event stream). Ship this as a permissionless `verify` module.
- **Only trust anchors:** the two genesis scalars `refill_rate`, `max_bucket_capacity` — pinned at market creation, **observationally bounded** (refill_rate = asymptotic slope of the cleared-volume envelope; capacity = largest single instantaneous drain), re-estimated live, flagged "illustrative until confirmed."
- **Reclaim is narrow:** `cancel_withdrawal` works only while `Requested/Approved` (pre-`Processing`), requester-only, 1 h cooldown. Once Hashi commits+burns, reclaim is gone. **Size the reserve assuming zero reclaim past `Processing`.**

### 10.6 The demo that survives both skeptics

Sui-side is live; the Bitcoin tail is pre-staged; **congestion is shown by replay, never by live saturation.**
1. `bond::open_position` — lock pre-staged hBTC, mint 1.0 ptBTC at a visible 3-bar discount, pin a 32-byte P2TR exit address (show write-once).
2. Drop a test Pyth BTC/USD feed → health breach → **`risk::liquidate` LIVE**, seized hBTC routed through DeepBook `0x5cda…ced6` in one checkpoint. Say on record: *"liquidation is instant on Sui — Bitcoin latency never touches on-Sui collateral."*
3. **Congestion by replay:** recompute `P_cong` from the recorded `WithdrawalSigned` stream through `project_capacity()`, show it matches the published bar; bump the scripted `Q_mer` cohort 1→12 BTC and watch only the congestion bar grow 1.8→44 bps while rate/credit stay fixed. *"This bar exists only because Hashi has a bucket — and it's replayable, not asserted."*
4. Maturity → one PTB: burn ptBTC → split `Balance<BTC>` → `request_withdrawal` to the pinned address → `WithdrawalRequested` event; then show an earlier pre-broadcast redemption confirming in a signet explorer.
5. *(stretch)* one live liveness auction: bids → descending clock stops at 180 bps → `exit_to_bitcoin` for winners atomically → premium credited to the reserve.

**Cut line = steps 1–4** (settlement + instant liquidation + trustless congestion curve). Step 5 (the friend's auction) is the depth stretch.

### 10.7 The one sentence that converts the biggest weakness into a credibility signal

> *"We ration our own egress rate and front seniors from our own reserve; we do **not** and **cannot** buy priority in Hashi's global queue — and our congestion bar is replayed trustlessly from Hashi's own `WithdrawalSigned` stream, not asserted."*

Saying this proves you read `limiter.rs`. It simultaneously defeats "you just renamed a pool" and "you're selling a promise you can't keep."
