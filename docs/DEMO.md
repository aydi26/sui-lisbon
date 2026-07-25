# DEMO.md — the runbook

> Purpose: the exact three-minute script, the commands behind each beat, and the line between what is **live** and what is **pre-staged**. Adapted from `HASHI_INTEGRATION.md` §8 to what actually exists on 2026-07-25.
> Read after: `docs/GOLDEN-RULES.md` (G6 and G8 govern this whole file), `docs/STATUS.md` (what is really done), `docs/DEPLOYED.md` (the ids you will paste).

---

## 0. The three sentences you must be able to say without flinching

1. **hBTC is custodial-threshold wrapped BTC.** Threshold Schnorr, a Guardian 2-of-2, a ~60-day recovery leaf. We did not make Bitcoin trustless and we do not claim to.
2. **We did not integrate a wrapped token. We integrated the bridge's on-chain machinery** — and every one of the four things we built on top of it is checkable by a stranger with an RPC endpoint.
3. **The Bitcoin leg is never live.** A deposit is ~70 minutes end to end; one measured withdrawal took **58 minutes** from `Requested` to `Confirmed`. Anything BTC-side you see on screen was staged before we walked up.

## 1. The four differentiators — this is the pitch

| # | What | Why it is not a feature list item | Demoable today? |
|---|---|---|---|
| 1 | **Move-pinned exits** | `gateway::exit_to_bitcoin` takes **no Bitcoin-address argument**. The destination is written once at deposit into `Vault.btc_exit_address` and read from chain state. A fully compromised keeper can trade; it cannot redirect a satoshi. A gate (`g2`) proves no exit function anywhere in the repo accepts an address parameter. | **Yes** — show the Move source and the gate |
| 2 | **A trustlessly-replayable limiter** | The Guardian's rate-limit bucket is re-derived from Hashi's *own* on-chain event stream — `min(cap, tokens + elapsed × refill_rate)` replayed over `WithdrawalRequested`/`Signed` — not read from an SDK we ask you to trust. The only trust anchors are two genesis scalars. One implementation, cross-tested against its Move twin on the R9 golden vectors. | **Yes** — `npm run test -- limiter.cross` |
| 3 | **The permissionless `confirm_deposit` crank** | Hashi's confirm step is permissionless and **has no relayer** — 20 consecutive `DepositRequested` events had 20 distinct senders, each depositor submitting their own. We run the crank **for everybody**, including deposits that are not ours. That is a public good, and it is the one Bitcoin-adjacent thing that is genuinely live-demoable. | **Yes** — see beat 2 |
| 4 | **The peg-flow signal** | `DepositApproved` telegraphs a mint ~10 minutes before supply arrives; `WithdrawalRequested` telegraphs a burn. The **signal is public**; our **response is Seal-encrypted**. Anyone can compute the input; nobody can copy the reaction. | **Yes** — `npm run test -- strategy.pegflow` |

**Never** dress any of this in a congestion story. The live bucket is `refill_rate = 115_740` sats/s with `max_bucket_capacity = 10_000_000_000` sats — **~100 BTC/day**. An Aphotic-sized exit will never be throttled on testnet. The envelope is an honest *risk input*, not scarcity. Saying otherwise is a factual error a judge can check in thirty seconds.

---

## 2. Live vs pre-staged — the boundary, decided in advance

| Beat | Live on camera | Pre-staged before the demo |
|---|---|---|
| zkLogin sign-in + deposit-address derivation | **LIVE** (fully offline derivation, no network) | — |
| Sending BTC from a phone wallet | LIVE as theatre only — say out loud it confirms long after we sit down | — |
| `confirm_deposit` crank | **LIVE** — on somebody else's pending deposit | the target request id, picked ≤ 5 min before |
| hBTC minted → swept into shares | LIVE **only if** a deposit of ours has cleared; otherwise pre-staged | vault state |
| Maker quote resting on `hBTC/DBUSDC` | pre-staged (**see B2 — the book is empty**) | seeded book + resting order |
| Encrypted strategy blob + decision log | screenshot / fixture-backed screen | the Walrus blob |
| `gateway::exit_to_bitcoin` PTB | **LIVE** — one Sui checkpoint, instant | the vault must hold hBTC |
| The signet transaction confirming | **NEVER LIVE** (G6) | an **earlier**, already-confirmed exit, explorer tab open |

Rule of thumb: **anything that touches a Bitcoin block is pre-staged. Anything that touches only Sui is live.** That is G1 in one sentence, and it is a genuine architectural property, not a demo trick — hBTC is a fungible `Coin<BTC>` and moves in one checkpoint.

---

## 3. Pre-flight

### T-60 minutes

```powershell
$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"

# 1. The floor. Expect 139/139 Move, 481/481 keeper, 84/84 app, app build green.
cd C:\Users\adria\sui-lisbon\move   ; sui move test
cd C:\Users\adria\sui-lisbon\keeper ; npm test ; npm run build
cd C:\Users\adria\sui-lisbon\app    ; npm test ; npm run build

# 2. The chain is where you left it. Expect 28 PASS · 0 FAIL.
cd C:\Users\adria\sui-lisbon ; node scripts\verify-onchain.mjs

# 3. The keeper CLI actually runs. Expect exit 0 and seven commands.
cd C:\Users\adria\sui-lisbon\keeper ; node dist\index.js --help

# 4. Gas. Expect > 1 SUI on the deployer.
sui client gas
```

⚠ `scripts/verify-all.ps1` currently reports **7 PASS · 1 FAIL** — the failure is the `ids` gate tripping on two hardcoded Hashi ids in `scripts/register-deposit.ps1` (blocker **B11**). It is a hygiene regression in an operator script, not a product defect. **Do not put `verify-all.ps1` on screen until it is fixed**; run `scripts/gates.ps1 g2` and `g7` individually instead, which is what you actually want to show anyway.

### T-15 minutes

```powershell
# Open tabs, in this order, and leave them open:
#   1. the app  (npm run dev, or the Vercel URL)  -> /deposit
#   2. suiscan  -> the Vault object 0xf03832c9...
#   3. mempool.space/signet -> the EARLIER, already-confirmed exit txid
#   4. a terminal in C:\Users\adria\sui-lisbon

# Find a live, crankable deposit that is NOT ours — this is beat 2's ammunition.
# DepositApproved + 10 minutes elapsed => confirm_deposit will succeed for anyone.
node scripts\verify-onchain.mjs      # the P5 section prints the freshest deposit events
```

Write the chosen `request_id` on a sticky note. If the crank has to be re-picked mid-demo you have lost the beat.

---

## 4. The script — 3 minutes

### 0:00 — "A Bitcoin strategy nobody can copy, and it starts with a Google login."

Click **Sign in with Google** on `/deposit`. A Sui address appears; a Taproot signet deposit address and its QR render **immediately**, because the derivation is pure client-side arithmetic — `generateDepositAddress` over the committee MPC key. No server, no custody handshake.

> "This address is derived in your browser from the committee's public key. We never see a key, and neither does our backend — there isn't one."

Optionally send a few thousand sats from a phone wallet. **Say the quiet part immediately:** *"That will confirm in about an hour. Bitcoin is not fast and I'm not going to pretend otherwise."*

### 0:40 — The crank. **This is the live beat. Do not rush it.**

Pick the sticky-note `request_id` — **somebody else's** deposit — and run the permissionless confirm through the keeper:

```powershell
cd C:\Users\adria\sui-lisbon\keeper
node dist\index.js crank            # or: --all, to sweep every eligible request
```

A `treasury::Minted` event fires and hBTC exists for a stranger.

> "Confirmation on Hashi is permissionless and there is no relayer — we checked: twenty consecutive deposits, twenty different senders, every user pushing their own. So we run the crank for everyone. This deposit isn't ours. We just finished it."

**Fallback if `keeper/.env` is not loaded, or the CLI misbehaves** — the raw PTB does exactly the same thing:

```powershell
$HASHI_PKG = '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360'
$HASHI_OBJ = '0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8'

sui client call `
  --package $HASHI_PKG --module deposit --function confirm_deposit `
  --args $HASHI_OBJ <REQUEST_ID> 0x6 `
  --gas-budget 50000000
```

Rehearse whichever one you plan to use, on a real request id, before the demo. `confirm_deposit` is idempotent and respects the mandatory 600 000 ms delay — an ineligible request is skipped, not errored.

Then flip to the app and show the deposit lifecycle stepper advancing, and the sponsored sweep into vault shares — the depositor needed zero SUI.

### 1:20 — The private half

Show `/transparency`.

> "Left column: the strategy, Seal-encrypted, sitting in Walrus. You can see the blob. You cannot read it. Right column: the bridge — the Guardian's rate-limit bucket, and *how we got that number*."

Then the load-bearing sentence:

> "We didn't ask an SDK what the limiter says. We replayed it. `min(cap, tokens + elapsed × refill_rate)` over Hashi's own on-chain event stream. Two genesis constants are the only things you have to take on faith — and the Move contract and the TypeScript keeper compute it identically, cross-tested on the upstream golden vectors."

```powershell
cd keeper ; npm run test -- limiter.cross    # the Move <-> TS parity assertion
```

And the peg-flow line:

> "`DepositApproved` fires about ten minutes before hBTC exists. That's public — anyone can see supply coming. What we *do* about it is encrypted. Public signal, private response."

⚠ **Honesty note:** the vault's `strategy_ciphertext` on chain is still a one-byte placeholder — the Seal backend port is not bound (**B13**). The correct phrasing is *"the strategy is designed to live encrypted in Walrus and the vault gates decryption through `seal_approve`; the key-server binding is the last wire."* Do not claim a live encrypted blob you cannot open in front of them.

### 2:10 — The exit. Two halves, and be explicit that they are two halves.

Run the exit PTB — one transaction, burn shares and call `hashi::withdraw::request_withdrawal`:

> "One PTB. Burn the shares, request the withdrawal. And look at the signature —"

Put `move/sources/gateway.move` on screen:

```move
public fun exit_to_bitcoin<Q>(
    vault: &mut Vault<BTC, Q>,
    hashi: &mut Hashi,
    shares_to_burn: u64,
    book_mid: u128,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

> "There is no Bitcoin address in that signature. There is no way to pass one. The destination is read out of the vault, where it was written once when you deposited, and it is write-once — a second write aborts. Our keeper holds exactly one capability: a DeepBook `TradeCap`. It can trade. It can never take."

Then prove you did not just say that:

```powershell
powershell -NoProfile -File scripts\gates.ps1 g2
powershell -NoProfile -File scripts\gates.ps1 g7
```

> "That's a gate in CI. No exit function in this repo takes a Bitcoin address, and Hashi's Move surface is confined to exactly one file."

Now switch to the **pre-staged** explorer tab.

> "The Sui half just landed — one checkpoint. The Bitcoin half takes an hour or two, so here's an earlier exit of ours, already confirmed on signet. Same pinned address. I'm showing you a recording of physics, not a recording of our software."

### 2:50 — Close

> "We didn't integrate a wrapped Bitcoin. We integrated the bridge — its pinning, its limiter, its permissionless crank, its flow. hBTC is custodial-threshold wrapped BTC and we say so on the site. Everything we added on top of it, you can check yourself."

---

## 5. If the signet leg is not ready — the fallback

**Decide this before you walk up, not at the podium.**

At the time of writing, our signet deposit `2275d89012c7e3a408a5c04fcb8203f0d1b0702992713e6dd36197ad99ddeac9` (block 314710, vouts 238 and 248, 144 137 sats each) sat at **5 of the required 6 confirmations** and had **not been registered**, so **the vault holds no hBTC** and the `hBTC/DBUSDC` book is empty on both sides (blocker **B2**). B2 is worse than "we haven't got round to it": `treasury::mint` is `public(package)` so we cannot mint hBTC, and `scripts/seed-book.mjs` established that the **DBUSDC `TreasuryCap` is `AddressOwner`, not shared**, so we cannot mint the quote asset either. And `mid_price` asserts *both* sides — seeding one side would not even make it callable. If that is still true at demo time, do **not** improvise around it. Run this version instead:

Drop beats 0:40's mint-and-sweep and 2:10's live exit PTB. Keep everything else, and **make the crank the centrepiece** — it works on strangers' deposits, needs nothing of ours, and is the single most defensible thing we built. Then:

- Show `/deposit` deriving a real signet Taproot address live, and the signet transaction we actually sent, in the explorer, with its confirmation count. Say plainly: *"the sats are in, the registration is one block away, and Hashi's own confirmation threshold is six — we are not going to fake a mint."*
- Show the exit **path** rather than an exit: the `exit_to_bitcoin` signature, the `g2` gate output, and `move/tests/gateway_tests.move` — 26 passing tests including a write-once pin and a depositor-only reclaim.
- Show the empty book as a **designed** state, not a hole: `pool::mid_price` aborts `EEmptyOrderbook` while `get_level2_range` returns `([], [])`, and every consumer of ours treats that as `noop cause=no-mid` rather than crashing. *"There's no counterparty on this pair on testnet. We handle that as a defined state rather than a null-pointer, and here's the test that says so."*
- Close on the numbers you can prove: **139 Move tests, 481 keeper tests, 84 app tests, 28 live on-chain assertions, 7 passing invariant gates**, and a package published at `0xbe433a27…` that anyone in the room can query right now.

That version is weaker theatre and exactly as strong an argument. It is also **honest**, which is the whole differentiator (G8). A judge who catches one faked mint discards the entire pitch.

---

## 6. Questions you will get, and the true answers

| Question | Answer |
|---|---|
| *"So is this trustless Bitcoin?"* | "No. hBTC is custodial-threshold wrapped BTC — threshold Schnorr, a Guardian 2-of-2, a ~60-day recovery leaf. Our contribution is that **our** layer adds no new trust on top of it: the keeper holds only a `TradeCap`, and the exit address is pinned in Move." |
| *"What can the keeper steal?"* | "Nothing. It has a DeepBook `TradeCap` and that is the complete list. No `WithdrawCap`, no `DepositCap`. It can move the vault's position around a single order book and it can lose money doing it. It cannot move a satoshi off Sui, and it cannot change where a satoshi goes when it leaves." |
| *"Can you pay to jump the withdrawal queue?"* | "No — and nobody can. Over-capacity batches are **rejected** with `RateLimitExceeded`, not queued. There is no priority to buy. We ration our own egress rate; that is the only lever that exists." |
| *"Is the bridge congested?"* | "No. The bucket is about 100 BTC a day. We are nowhere near it, and I'd rather tell you that than sell you a scarcity story." |
| *"Why not Cetus / a CLMM?"* | "There is no Cetus hBTC pool. The venue is DeepBook, maker `POST_ONLY` plus an IOC sweep on the same book. A gate fails the build if a CLMM leg appears." |
| *"How do I know your limiter number is real?"* | "Replay it. `verify --limiter` re-derives the bucket from `WithdrawalRequested` and `WithdrawalSigned` on chain. The only inputs you take on faith are the two genesis scalars, and those are in the vault's own state." |
| *"Is the strategy actually private?"* | "The design is: Seal-encrypted params in Walrus, decryption gated by `seal_approve` namespaced to the vault id and a version epoch that bumps when the keeper rotates. The key-server binding is our last open wire — I'll show you the gate and the tests rather than claim a blob I can't open." |

## 7. Never say

- "Trustless Bitcoin", "non-custodial BTC", or anything implying hBTC's trust model is ours to fix. **(G8)**
- "The bridge is congested / we get priority / we're queued ahead." **(G3, G8)**
- Any promise of prompt native-BTC delivery. **(G3)**
- "Watch it confirm" about anything on Bitcoin. **(G6)**
- "Our keeper decides where the BTC goes." It provably cannot. **(G2)**
