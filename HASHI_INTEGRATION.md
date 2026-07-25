# Aphotic × Hashi — Integration Plan (pre-code)

> Status: ideation deliverable, 2026-07-24. No code exists yet; this document is the contract for the build phase.

## 1. Executive summary

Aphotic becomes the first vault that treats Hashi — MystenLabs' native-BTC orchestrator, whose Sui testnet launched **2026-07-22** — as a composable protocol rather than a token source. Users onboard with a Google login and a plain Bitcoin transaction: zkLogin yields a Sui address, the Hashi SDK derives a personal Taproot deposit address from it client-side, and hBTC mints on Sui after confirmation. The vault runs a Seal-encrypted, sats-denominated strategy maker-first on the live hBTC/DBUSDC DeepBook v3 pool. On exit, the vault's own Move code calls `hashi::withdraw::request_withdrawal` — a `public fun` taking `Balance<BTC>` — in the same PTB that burns shares, pushing **native BTC to a Bitcoin address pinned on-chain at deposit time**, so not even a fully compromised keeper can redirect an exit. The vault's constraint envelope and decision log are extended to understand the bridge itself: withdrawal-queue depth and the Guardian rate limiter become risk inputs, enforced on-chain and replayable from Walrus.

Pitch line: **"We don't integrate a wrapped BTC token. We integrate the bridge."**

> ### ✅ Verified-facts update (deep source pass, 2026-07-24) — this plan got STRONGER
> Everything load-bearing here was source-verified across three workflows. Net effect on Aphotic × Hashi:
> - **UPGRADE — the bridge-aware envelope's key claim is ~99% TRUSTLESS, not merely "keeper-attested."** Hashi's Guardian limiter (`LocalLimiter`) is advanced purely by on-chain `WithdrawalSigned` events through `project_capacity() = min(cap, tokens + elapsed·refill_rate)`. So the whole bucket trajectory + queue depth is **replayable on-chain** from the `WithdrawalRequested / PickedForProcessing / Signed` stream. Aphotic's `verify` command can *recompute* "the bridge was tightening when we pulled quotes" from Hashi's own events — the strongest possible form of Aphotic's verifiable-determinism thesis. Only two genesis scalars (`refill_rate`, `max_bucket_capacity`) are trust anchors, and both are observationally bounded. **Rewrite mechanism #2 (§3) and `envelope.move` (§4) around trustless replay, not an SDK read.**
> - **POSITIONING — Aphotic is structurally differentiated from the field.** Suilend, AlphaLend, Navi and Scallop all integrate Hashi day one as *lending* markets. Aphotic is a **private market-making vault**, not a money market — it does not collide with the "ten BTC-lending clones." And it uses the *exact* featured Sui prize stack: **Move + Seal + Walrus + DeepBook + zkLogin**. That is a rubric bullseye a credit protocol cannot match.
> - **LOWER RISK than a pricing product.** Aphotic *uses* the limiter as a risk input (a redemption buffer), it does not *monetize* its magnitude. So the "live limiter values are unpublished" unknown is far less threatening here than for a bond-pricing curve: worst case the buffer is conservative. Still query `refill_rate`/`max_bucket_capacity` day one, but the thesis does not ride on the number.
> - **CONFIRMED:** `request_withdrawal(…, Balance<BTC>, bitcoin_address, …)` is a composable `public fun`; hBTC is a fungible unregulated `Coin<BTC>`; `confirm_deposit` is permissionless; **no Cetus hBTC pool exists** (router is DeepBook maker + IOC, already handled §4). One new caveat: hBTC can **depeg** below BTC on the thin DeepBook book precisely when exit is throttled — value NAV at the live DeepBook mid and add depeg to the risk register.

## 2. Hashi: verified facts

All verified against source (`github.com/MystenLabs/hashi`, `packages/hashi/sources/`), the `@mysten/hashi` SDK (v0.6.0, 2026-07-21, source in MystenLabs/ts-sdks `packages/hashi/`), and `mystenlabs.github.io/hashi-integrations/`.

**What Hashi is.** "Sui Native Bitcoin Orchestrator". Deposit BTC to a protocol-controlled Taproot address → receive fungible hBTC on Sui; withdrawals burn hBTC and pay native BTC. Custody = MPC threshold Schnorr by an opt-in, stake-weighted subset of Sui validators, plus a Guardian enclave as 2-of-2 co-signer. Not an SPV/light-client bridge. Pre-1.0, explicitly not production-ready. Bitcoin side is **signet** on both Sui networks.

**The hBTC coin.** `hashi::btc::BTC`, 8 decimals, symbol `hBTC`, units are satoshis. Standard unregulated `Coin<BTC>` (`coin_registry::new_currency`) — no deny list, no transfer restrictions; `TreasuryCap` locked in the shared `Hashi` object; mint/burn `public(package)` only.

**Deployments** (mainnet NOT deployed; SDK throws on mainnet):

| | Sui testnet | Sui devnet |
|---|---|---|
| Package | `0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360` | `0xa877d4d97b6a8bae1da982a84980c502c5ad2ead4b24e6c8e50c57cd6ddc3771` |
| `Hashi` shared object | `0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8` | `0x84081242ebb05eac5e09ab2a930a60b1357d3d8bc6f927380979f72de991ccca` |
| Coin type | `<pkg>::btc::BTC` | inferred, verify |
| Frontend | testnet.hashi.sui.io | devnet.hashi.sui.io |

**Key Move signatures** (verified in `packages/hashi/sources/btc/`):

```
// COMPOSABLE — callable from our vault module:
public fun request_withdrawal(hashi: &mut Hashi, clock: &Clock,
    btc: Balance<BTC>, bitcoin_address: vector<u8>, ctx: &mut TxContext)
    // asserts amount >= config.bitcoin_withdrawal_minimum() (30,000 sats)
    // asserts address is 20 bytes (P2WPKH) or 32 bytes (P2TR)
public fun cancel_withdrawal(hashi: &mut Hashi, request_id: address,
    clock: &Clock, ctx: &mut TxContext): Balance<BTC>   // after 1h cooldown, pre-commit only

// PTB-only:
entry fun deposit(hashi: &mut Hashi, utxo: Utxo, clock: &Clock, ctx: &mut TxContext)
entry fun confirm_deposit(hashi: &mut Hashi, request_id: address, clock: &Clock, ctx: &mut TxContext)
    // PERMISSIONLESS; mints to the recipient encoded in the UTXO's derivation path
```

**Flows and latencies.** Deposit: BTC to derived P2TR address (min 30,000 sats) → `deposit` registration → committee `approve_deposit` after **6 BTC confirmations** (+ sanctions screening) → **10-minute delay** → permissionless `confirm_deposit` mints. Signet blocks target ~10 min ⇒ a deposit takes **~70+ min end to end** — never live-demoable; must be pre-staged. Withdrawal: `request_withdrawal` (instant on Sui, emits event, burns via batch commit) → ~10-min batching → Guardian+MPC signing → broadcast → confirmed after 6 confs. Guardian enforces a token-bucket withdrawal rate limiter (queryable via SDK `guardian.limiterStatus` / `canWithdraw`).

**SDK** (`@mysten/hashi`, ESM-only, peer `@mysten/sui` ^2.22.1): `client.$extend(hashi())` auto-resolves network IDs; `generateDepositAddress({suiAddress})` (client-side P2TR derivation — no server), `deposit({signer, txid, utxos, recipient})`, `requestWithdrawal`, `cancelWithdrawal`, `view.balance/depositStatus/withdrawalStatus/all`, `waitForDeposit/waitForWithdrawal`, `guardian.limiterStatus/canWithdraw`.

**Venue.** Mysten's own integration demo is "hashi × DeepBook". Live testnet DeepBook v3 `Pool<hBTC, DBUSDC>`: `0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6` (tick 1_000_000, lot 1_000, min 100_000; created 2026-07-20). DBUSDC: `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC`. **No Cetus hBTC pool found** — the Cetus taker leg does not exist for this pair.

**Events for the keeper/indexer.** `treasury::Minted/Burned`, `deposit::DepositRequested/Approved/Confirmed`, `withdrawal_queue::WithdrawalRequested/Approved/Signed/Confirmed/Cancelled`, `utxo_pool::UtxoSpent`.

### Verify on day one (gates the build)

1. Hashi testnet IDs respond on a public fullnode (research verified them from source constants only).
2. `Hashi` shared object exposes public getters for withdrawal-queue depth / config (needed for the on-chain envelope; fallback below if not).
3. hBTC/DBUSDC pool state: current book depth, and whether placing maker orders works with a fresh BalanceManager.
4. `generateDepositAddress` accepts an arbitrary 32-byte value (an object ID) as `suiAddress` — gates the stretch "deposit ticket" flow.
5. Faucet throughput: how fast `signet257.bublina.eu.org` / `signetfaucet.com` deliver ≥ 30,000 sats; start dripping day one.
6. Seal key servers + Walrus publisher on **testnet** (Hashi's network) — Aphotic previously assumed testnet, so this should hold, but confirm all four primitives coexist there.

## 3. Why this is more than "a strat on wrapped BTC"

Any team can list hBTC in a pool and call it an integration. The critique to survive is: *"you imported a coin type and renamed your pool."* This design survives it because the vault consumes Hashi's **machinery**, which only exists because the bridge lives on Sui as Move objects:

1. **Move-composed exits with destination pinning.** `request_withdrawal` takes `Balance<BTC>` from *our* vault's balance sheet, inside *our* PTB, with the destination checked by *our* Move code against the Bitcoin address the depositor registered at entry. The keeper holds TradeCap only and can never touch this path; even a compromised frontend cannot redirect BTC. This extends Aphotic's constraint-envelope thesis *into the bridge*. Impossible with a token-only integration; impossible on any bridge whose withdrawal isn't `public fun`.
2. **A bridge-aware risk envelope — trustlessly verifiable.** Hashi exits are rate-limited (Guardian token bucket) and slow (batching + 6 confs). The vault maintains an on-chain **redemption buffer**: the envelope refuses keeper deployments that would push idle hBTC below a bound tied to pending exit demand. The encrypted strategy de-risks preemptively when the bridge tightens — and crucially, the limiter state is **not** an opaque SDK read we merely log: it is **reconstructable on-chain** by replaying `project_capacity()` over Hashi's `WithdrawalRequested / PickedForProcessing / Signed` event stream (the `LocalLimiter` is advanced by exactly those events). So "we saw the bridge tightening and pulled quotes" is not just *recorded* in the Walrus log — it is **independently re-derivable from Hashi's own events**, the strongest form of Aphotic's verifiable-determinism thesis. No LP vault anywhere prices its bridge's exit liveness, let alone provably; this one does.
3. **Peg-flow market making as the flagship encrypted strategy.** hBTC supply changes are telegraphed on-chain before they hit the book: `DepositApproved` precedes the mint by ~10 min; `WithdrawalRequested` precedes the burn. The strategy quotes maker-side on the hBTC/DBUSDC book using queue flow as an input. The signal is public; the response is Seal-encrypted — exactly Aphotic's thesis, now with a signal that only exists because Hashi runs on Sui.
4. **One-Bitcoin-transaction onboarding.** zkLogin address → client-side P2TR derivation → user sends BTC from any wallet. Our keeper runs the **permissionless `confirm_deposit` crank** for everyone (a small public good), and a sponsored PTB sweeps the minted hBTC into vault shares. From a Google login to a private BTC strategy without ever holding SUI. Stretch: key the derivation to a per-user "deposit ticket" object ID so the mint lands via transfer-to-object and the vault claims it with `public_receive` — zero user transactions after setup (gated by day-one check #4).
5. **Sats-denominated NAV.** Share accounting, performance, and the decision log are denominated in satoshis. BTC in, more BTC out, and nobody — operator included — can read the rule that did it.

Honest framing for Q&A: hBTC *is* custodial-threshold wrapped BTC. The differentiation is not the token's trust model — it is that the bridge's lifecycle is on-chain and composable, and we compose with it at every stage: entry (derivation + crank), operation (flow signals + limiter-aware envelope), exit (Move-composed, destination-pinned withdrawal, `cancel_withdrawal` reclaim on stall).

## 4. Architecture deltas

Baseline = `README (8).md`. The SUI/USDC design carries over; deltas only.

**Move package**
- `vault.move` — genericize over the asset pair; add `btc_exit_address: vector<u8>` (20 or 32 bytes) captured per depositor at first deposit, immutable thereafter; sats-denominated share math (hBTC has 8 decimals; NAV quotes from the hBTC/DBUSDC mid).
- `gateway.move` (new) — the Hashi boundary: `register_exit_address`, `exit_to_bitcoin` (burn shares → split `Balance<BTC>` → `hashi::withdraw::request_withdrawal` with the pinned address — one PTB, atomic), `reclaim_stalled_exit` (wraps `cancel_withdrawal`, returns the `Balance<BTC>` to the vault, re-credits shares), and small-exit queuing: exits below 30,000 sats accumulate in a per-user pending balance until they clear the Hashi minimum or the user opts to take hBTC instead.
- `envelope.move` — add the redemption-buffer constraint: deployable hBTC ≤ f(idle hBTC, pending exit demand). Reads queue state from the `Hashi` shared object if getters exist (day-one check #2); fallback: a static buffer ratio set at vault creation plus keeper-attested limiter readings in the log.
- `router.move` — drop the Cetus leg for the BTC vault (no hBTC pool exists): maker `POST_ONLY` → IOC sweep on the same book as residual. Simpler and honest; note it in the demo.

**Keeper**
- `hashi/` (new) — event watcher over the six Hashi event families; the permissionless `confirm_deposit` crank (runs for *all* Hashi users, not just ours); deposit-to-shares sweeper (sponsored PTB); withdrawal tracker driving `waitForWithdrawal` → surfacing the signet txid; limiter poller (`guardian.limiterStatus`) feeding both the strategy input vector and the decision log.
- `strategy/` — new flagship family: peg-flow maker quoting (inputs: book snapshot, pending mint/burn queue, limiter status; parameters — spread, skew, flow sensitivity, buffer target — all Seal-encrypted).
- `journal/` — decision records gain `hashi` fields: limiter reading, queue depths, pending-mint total. The `verify` replay covers them.

**App**
- Deposit screen: Google login → derived Taproot address + QR (client-side `generateDepositAddress`), live status via `view.depositStatus`/`waitForDeposit` walking the six-stage lifecycle.
- Exit screen: registered BTC address (immutable, shown with the Move-pinning explanation), exit → Sui-side confirmation instantly, then signet txid when broadcast.
- Transparency panel: add the bridge column — limiter state, queue depths, and the replayable "we de-risked because the bridge tightened" trace.

## 5. Hashi touchpoints (exhaustive)

| Touchpoint | Kind | Where it plugs in |
|---|---|---|
| `hashi::btc::BTC` coin type (sats) | Move | vault asset, share math, DeepBook pool |
| `request_withdrawal(…, Balance<BTC>, vector<u8>, …)` | Move `public fun` | `gateway::exit_to_bitcoin` — composed in the burn-shares PTB |
| `cancel_withdrawal(…): Balance<BTC>` | Move `public fun` | `gateway::reclaim_stalled_exit` |
| `bitcoin_withdrawal_minimum()` (30,000 sats) | Move config | small-exit queuing logic |
| `entry deposit` / permissionless `entry confirm_deposit` | PTB | keeper crank + sponsored deposit sweep |
| `Hashi` shared object (testnet `0x22c0…28f8`) | Move | envelope queue-depth read (pending day-one check) |
| `treasury::Minted/Burned`, `deposit::*`, `withdrawal_queue::*` events | events | keeper watcher; strategy flow signal; journal |
| `generateDepositAddress({suiAddress})` | SDK | app deposit screen (client-side, no server) |
| `deposit({signer, txid, utxos, recipient})` | SDK | keeper registration path |
| `view.depositStatus/withdrawalStatus/balance`, `waitForDeposit/waitForWithdrawal` | SDK | app lifecycle UI, keeper tracker |
| `guardian.limiterStatus` / `canWithdraw` | SDK | strategy input; journal; pre-exit UX check |
| `Pool<hBTC, DBUSDC>` `0x5cda…ced6` | DeepBook | execution venue, maker-first |
| Signet faucets (`signet257.bublina.eu.org`, `signetfaucet.com`) | ops | test BTC supply — start day one |

## 6. Network & liquidity reality

Everything targets **Sui testnet** (Hashi testnet launched 2026-07-22; devnet wipes would eat our IDs). Bitcoin side is signet. DeepBook v3, Walrus and Seal all operate on testnet; confirm Seal committee endpoints day one. The hBTC/DBUSDC pool is four days old — book depth is unknown and likely near-zero. That is not a blocker; it is the pitch: **the vault is the market maker**. For demo fills we run a second account as a scripted taker. No Cetus hBTC pool ⇒ no CLMM range positions for the BTC vault; the strategy is order-book market making, which the maker-first router was built for anyway. Fallback if any Hashi dependency fails late: the SUI/USDC vault from the base design still demos, with the Hashi gateway shown on devnet — but decide by the cut line, not at the venue.

## 7. Phased build plan

| Phase | Scope | Est. |
|---|---|---|
| 0 | Day-one checklist (§2), faucet dripping, one manual end-to-end Hashi deposit via their frontend to learn the real timings | 2–3 h |
| 1 | Move: vault genericized to `Coin<BTC>`, sats share math, `gateway.move` (exit pinning, composed withdrawal, reclaim, small-exit queue), tests | 6–8 h |
| 2 | Keeper: Hashi event watcher, `confirm_deposit` crank, sponsored deposit sweep, withdrawal tracker; router minus Cetus leg quoting on the hBTC book | 6–8 h |
| 3 | App: deposit screen (derivation + lifecycle), exit screen (pinned address, signet txid), zkLogin path | 4–6 h |
| — | **CUT LINE — minimum demoable product: BTC in → encrypted strategy quoting → BTC out** | |
| 4 | Bridge-aware envelope (queue/buffer constraint), journal `hashi` fields, `verify` replay over them | 4 h |
| 5 | Stretch: peg-flow signal in the strategy; deposit-ticket TTO flow; transparency-panel bridge column | 4–6 h |

Standing ops from day one: keep 2–3 confirmed hBTC deposits and one broadcast withdrawal warm at all times, so the demo never waits on signet.

## 8. Demo script (3 minutes)

Pre-staged: funded vault quoting on the hBTC book; one deposit at the "approved, minting soon" stage; one earlier exit already broadcast on signet.

1. *(0:00)* "This is a Bitcoin strategy nobody can copy — and it starts with a Google login." Log in with zkLogin; the Taproot deposit address derives client-side; show a real BTC send from a phone wallet (it will confirm after the demo — say so).
2. *(0:40)* Flip to the pre-staged deposit: run the permissionless `confirm_deposit` crank **live** — hBTC mints on-screen, sweeps into vault shares. "Confirmation is permissionless; our keeper cranks it for everyone."
3. *(1:20)* Show the vault resting maker-side on the hBTC/DBUSDC book; scripted taker fills it; point at the encrypted strategy blob and one decision-log entry showing the limiter reading. "The signal is public. The response is encrypted. And every decision replays from Walrus."
4. *(2:10)* Exit **live**: one PTB burns shares and calls Hashi's `request_withdrawal` — show the `WithdrawalRequested` event and the Move-pinned destination. Then show the earlier exit's signet transaction confirming in an explorer. "Native BTC out, to an address our own contract refuses to change. The keeper can trade; it can never take."
5. *(2:50)* Close: "We didn't integrate a wrapped Bitcoin. We integrated the bridge."

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Hashi testnet instability (2 days old) | Manual end-to-end pass day one; keep devnet configs as fallback; pre-stage everything |
| Faucet can't supply ≥ 30,000-sat deposits fast enough | Start dripping day one from both faucets; consolidate UTXOs; one deposit is enough to demo |
| No public getters on `Hashi` object for queue state | Envelope falls back to static buffer ratio; limiter readings stay in the (replayable) log |
| Empty hBTC book | Vault is the maker; scripted taker for fills; frame thin books as the opportunity |
| Signet timing during judging | Nothing live depends on Bitcoin confirmations; Sui side is instant, BTC side pre-staged |
| SDK v0.6.0 breakage (ESM-only, fresh) | Pin versions in Phase 0; the Move path (`request_withdrawal`) doesn't depend on the SDK |
| Guardian pause / rate-limit hit mid-event | `canWithdraw` pre-check in UX; `cancel_withdrawal` reclaim path; buffer envelope |

## 10. Jury Q&A prep

1. **"Isn't hBTC just wrapped BTC with extra steps?"** The token is; the integration isn't. We compose the bridge's Move surface: exits execute inside our PTB with the destination enforced by our contract, our risk envelope prices the bridge's exit liveness, and our flagship signal only exists because mint/burn intents are on-chain before they hit the book.
2. **"What's your trust model on Hashi?"** Threshold Schnorr across an opt-in, stake-weighted validator subset, 2-of-2 with a Guardian enclave, and a ~60-day CSV recovery leaf if the Guardian dies. We inherit it, state it, and add on top: the keeper can never move BTC (TradeCap only + Move-pinned exits), and `cancel_withdrawal` reclaims stalled exits.
3. **"How do you demo a 70-minute deposit?"** Pipeline. Deposits stay warm at every lifecycle stage; the crank we run live is permissionless confirmation, which is real on-chain state transition, not theater.
4. **"The pool is four days old — what liquidity?"** We are the maker — that's the maker-first thesis. Economic results are measured on historical mainnet data; the testnet demo shows mechanism, and we say so.
5. **"Why do private strategies matter for BTC yield?"** Public rules are replicated at zero cost and manipulated at low cost (trigger-hunting). BTC holders are the most conservative depositors in crypto; they get k-anonymity in the pool, a strategy nobody can read, and an exit their own contract guarantees.
6. **"What breaks if Hashi ships breaking changes mid-event?"** Our Hashi surface is two `public fun` calls, one entry crank, and events — isolated in `gateway.move` and one keeper module. Worst case we re-pin package IDs and rebuild in minutes; catastrophic case falls back per §6.

## 11. README / pitch changes

- Headline → "**Private BTC strategies with maker-first execution on Sui — Bitcoin in, Bitcoin out.**"
- Sui-stack table: add a **Hashi** row ("the vault's asset origin and exit rail; `request_withdrawal` composed in Move with destination pinning — load-bearing because the entire BTC-in/BTC-out custody story runs through it").
- Architecture diagram: Bitcoin (signet) ⇄ Hashi (MPC + Guardian) on the left edge; `gateway.move` between vault and Hashi.
- Motivation: add the third open problem — "BTC yield venues force custody or public strategies; Aphotic offers neither."
- Privacy model table: exit addresses are visible on-chain (they're in withdrawal events) — state it; pending-exit *intent* before request is hidden.
- Limitations: add the Hashi trust model, pre-1.0 status, signet-only, and the 30,000-sat minimums.
- Scope: order-book market making replaces CLMM ranges for the BTC vault (no Cetus hBTC pool); CLMM stays for the SUI/USDC variant.
