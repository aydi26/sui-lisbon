# DEMO.md — the runbook

> Purpose: the script, the exact commands behind each beat, the line between what is **live** and
> what is **pre-staged**, the fallback, and the things we must never say.
> Read after: `CLAUDE.md` (G1 and G2 govern this whole file), `docs/STATUS.md` (what is really
> done — **check it before promising anything**), `docs/DEPLOYED.md` (the ids you will paste).
>
> **Rewritten 2026-07-26 for the v2 product.** Any older script that demonstrates maker quoting on
> DeepBook, a pinned exit address, or a Seal-encrypted *strategy* is describing the dead v1 product.
>
> ⚠ **Read `docs/STATUS.md` §1 first.** As of this writing `vault.move`, `batch.move` and
> `clearing.move` do not exist, so **beats 2–4 below cannot be run yet**. This file is the runbook
> for when they can; §6 is the runbook for if they cannot.

---

## 1. What the demo is actually about

One sentence, and it should be the first thing said:

> **Hashi's withdrawal queue is a public Move object. Every pending request exposes who, how much,
> where to, and since when — so a desk unwinding a position is watched forming in real time.
> Aphotic clears that flow before it reaches the queue.**

Everything else in the demo is evidence for that sentence.

### The four things worth showing, in order of strength

| # | What | Why it lands |
|---|---|---|
| **1** | **A sealed order that is genuinely sealed.** Submit an order; show the on-chain object: a commitment, a ciphertext hash, a blob id. **No amount. No side. No price.** Then show the escrow: fixed-denomination notes, and a `Note` struct with **no amount field at all**. | It is checkable in an explorer in ten seconds, and it is the whole thesis in one object. |
| **2** | **The clearing runs on-chain, and the TypeScript twin reproduces it byte for byte.** Run the parity test live: the same order set through `devInspectTransactionBlock` and through `sdk/`, compared as **BCS bytes**. | "Deterministic and reproducible" stops being a claim and becomes a diff that returns nothing. |
| **3** | **Timing nobody can choose.** Show `close_ms` being **derived** by `next_boundary`, `open_batch` taking no timestamp parameter, and `close_batch` **reverting** when called a second early. Then show that a **full** batch still does not close early. | Uniform-price clearing is only fair if the operator cannot pick the moment. This is that property, on chain. |
| **4** | **The keeper cannot name a destination.** Show the keeper-callable list — five entries — and then show that **none of those functions has an `address` parameter**. Grep it live. | It is a structural argument, not a policy promise. A missing parameter cannot be supplied. |

**Do not lead with the vault.** The vault is the shippable product and the reason the thing works
from the first dollar, but the auction is the differentiator and the queue leak is the story.

---

## 2. Live vs pre-staged — the boundary, stated

| Beat | Live? | Why |
|---|---|---|
| Note top-up, order submit (encrypted client-side) | ✅ **LIVE** | pure Sui + Seal; instant |
| `close_batch` reverting early, then succeeding on the boundary | ✅ **LIVE** | one `Clock` read |
| Reveal → `sort_step` → `price_step` → `settle_step` | ✅ **LIVE** | permissionless; anyone in the room can send it |
| `verify_fill` against the published root | ✅ **LIVE** | the transparency surface |
| **Move ↔ TypeScript clearing parity** | ✅ **LIVE** | the strongest beat |
| Vault: `request_deposit` → `propose_nav` → `approve_nav` → `claim_deposit` | ✅ **LIVE** | two signers, both in the room |
| Idle allocation to the lending market | ✅ **LIVE**, with the disclosure said out loud | it is **our** market |
| **BTC in — a signet deposit minting hBTC** | ❌ **~70+ min** | 6 confirmations + a mandatory 10-minute delay. **Pre-stage.** |
| **BTC out — a redemption confirming on signet** | ❌ **~1.5–2 h** | measured 57.9 min to `WithdrawalConfirmed` on a *quiet* signet. **Pre-stage.** |
| **The carry itself** | ❌ **NOT BUILT** | say so; do not mime it |

**The BTC leg is never live-demoable, and pretending otherwise is the fastest way to lose the
room.** Pre-stage it: have an **earlier, already-confirmed** signet transaction and its Hashi
`DepositConfirmed` / `WithdrawalConfirmed` events open in a tab, and say plainly *"this one I ran
earlier, because it takes seventy minutes."*

---

## 3. Pre-flight — the day before, not the hour before

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"          # sui is NOT reliably on PATH

# 1. The package builds and the suite is green
cd move    && sui move build && sui move test
cd lending && sui move build && sui move test

# 2. The parity gate — this is beat 2, so it must be green before you promise it
cd keeper && npm run build && npm test -- parity

# 3. The app builds and its offline suite passes
cd app && npm run build && npm test

# 4. The invariant gates, including the three v2 ones
powershell -NoProfile -File scripts/gates.ps1

# 5. Everything we depend on is still where we left it
node scripts/verify-onchain.mjs
```

Then, and this is the part people skip:

- **Re-read the live Guardian limiter scalars** (`GET {guardian_url}/info` over **HTTP/2** — HTTP/1.1
  returns 464). They are config and config changes.
- **Health-probe the Seal committee.** `GET {url}/v1/service` needs **both** a `Client-Sdk-Version`
  header **and** a `?service_id=` query param, or it returns 400. **If fewer than `t = 3` operators
  are live, do not open a batch.** 3 of 10 advertised testnet servers were down on 2026-07-25.
- **Pre-stage the BTC leg** and have the explorer tabs open, already loaded.
- **Have the fallback (§6) open in another window.** Decide at the cut line, not at the venue.
- **Charge everything and download the slides locally.** Venue wifi is why the globe textures are
  vendored into `app/public/globe/` instead of fetched from a CDN.

---

## 4. The script

Times are a guide for a ~5-minute slot. Cut from the bottom, never from beat 1.

### 0:00 — The leak (30 s, no slides, one browser tab)

Open the Hashi withdrawal queue object in an explorer. Point at a real pending request: `sender`,
`btc_amount`, `bitcoin_address`, `created_timestamp_ms`.

> *"This is Hashi's withdrawal queue. It is a public Move object. Every pending redemption tells you
> who is leaving, how much, and where to — before a satoshi moves. If you are a desk unwinding a
> position, the market watches it form and prices against you. Aphotic clears that flow before it
> reaches this queue."*

### 0:30 — A sealed order (60 s, live)

Submit an order from the app. It is encrypted **client-side** before it enters the transaction.

Then open the resulting object and read it out:

> *"Commitment. Ciphertext hash. Blob id. That is all. No amount, no side, no price. And the escrow
> behind it is fixed-denomination notes — here is the `Note` struct: an id and a denomination index,
> and **no amount field exists**. Not hidden. Absent."*

If asked *"why not just encrypt the amount?"*, the answer is one line: **a `Balance<BTC>` carries a
publicly readable value, so escrow would leak the size regardless of what you encrypt.**

### 1:30 — Timing nobody chooses (45 s, live)

```bash
# call close_batch one second early
# -> aborts ETooEarly
```

> *"`open_batch` takes no timestamp parameter. `close_ms` is derived — twelve-hour cadence, six-hour
> offset, so 06:00 and 18:00 UTC. Nobody, including us, can choose when a batch closes. And a full
> batch does **not** close early — otherwise a spammer would own the timing lever that uniform-price
> clearing exists to remove."*

### 2:15 — Clear it, on chain (60 s, live)

Close on the boundary. Anyone reveals — **this is the point to say it out loud**:

> *"Notice who is sending these transactions. Reveal, sort, price, settle — none of them takes a
> capability. If our keeper is offline, anyone in this room finishes the batch. Liveness is never a
> privilege."*

Show the clearing price and the fills root. Then `verify_fill`: prove one fill against the published
root.

### 3:15 — The parity gate (60 s, live — the strongest beat)

```bash
cd keeper && npm test -- moveparity
```

> *"Same order set. Once through the Move code, by `devInspect`. Once through the TypeScript in
> `sdk/`. Compared as BCS bytes. There is exactly one implementation of this algorithm per language,
> and a divergence is a release blocker — because 'deterministic and reproducible' has to be
> something you can check, not something we say."*

### 4:15 — What a compromised keeper buys you (30 s)

```bash
powershell -NoProfile -File scripts/gates.ps1 keepercap
```

> *"Five functions the keeper can call. None of them takes an `address` parameter. Not 'the keeper is
> not allowed to choose a destination' — there is no parameter in which to put one. And NAV is two
> **parties**: our keeper proposes a number, an admin multisig approves the exact digest, and
> neither moves the share price alone."*

### 4:45 — The honest close (15 s)

> *"Three things we will say before you ask. `hBTC` is custodial-threshold wrapped BitCoin — we
> inherit every one of Hashi's trust assumptions, and the collusion floor is seven validators by
> protocol, thirty-two on testnet today. Version one gives you **uniformity, not unlinkability** —
> the Merkle path is public, so the leaf index names the note; the zero-knowledge tier is a verifier
> swap on the same tree. And the lending market we allocate idle capital to is **ours**, because
> none exists on testnet. Aphotic is not trustless. It is no less trustworthy than the venue it
> serves, and that is the honest bar."*

---

## 5. Q&A — the answers that must be ready

| Question | Answer |
|---|---|
| *"Isn't this just a mixer?"* | No, and we do not claim to be. **v1 note spends are linkable** — the Merkle path is supplied in the clear, so the leaf index names the note. Denominations buy **uniformity**; privacy would come from the crowd, and the crowd does not exist at launch. |
| *"Can't the operator front-run the batch?"* | Uniform-price clearing does not make front-running hard, it makes it **meaningless**: everyone in a batch executes at the same price at the same instant. And the operator cannot pick the moment — `close_ms` is derived. |
| *"What if the Seal servers collude?"* | Then they decrypt early. Stated without hedging: pre-close confidentiality is `t`-of-`n`, `t = 3` of **5 distinct operators** — counted by operator, because two servers from one operator are one failure domain. The fix is the planned upgrade: a PCR-gated policy so only an attested enclave ever decrypts. |
| *"Why not a TEE now?"* | Clearing on a fixed order set is a **pure function**, so it runs on-chain and anyone verifies it. A TEE buys exactly one thing — hiding *unfilled* orders after close. That is a problem of success, not of launch, and the upgrade is a policy swap with no contract change. |
| *"Why not commit–reveal?"* | It requires participants to be online to reveal, which creates grief-by-non-revelation and forces an anti-abandonment bond. Seal's time-lock gives the same confidentiality with a **guaranteed** reveal — and the time-lock policy has **no sender check**, so anyone can produce it. |
| *"Can you jump the withdrawal queue?"* | No. Over-capacity batches are **rejected**, not queued, and a `WithdrawalRequest` lives in an `ObjectBag` on the queue, not in your account — positions are not transferable and cannot be bought. |
| *"Is the vault non-custodial?"* | On the Sui side, yes: capital sits in Move objects reachable only through scoped capabilities. **One boundary is not**: `request_withdrawal` sets `sender: ctx.sender()`, the transaction signer, so a shared object can never hold a queue position. That leg is gated by a 2-of-2 multisig **at signing, not by Move**, and we say so everywhere. |
| *"Can you prove the NAV?"* | Every leg except one. Native BTC at the redemption address lives in the Bitcoin UTXO set and Sui has no light client, so we **cap that leg at the sum of on-Sui-readable withdrawal claims that produced it** — asserted in `approve_nav`. It can never exceed the verifiable claim behind it. **We do not present the NAV as fully reconstructible.** |
| *"What's the yield?"* | Two sources: matched-volume fees and realised carry. **Never a management fee on AUM** — the strategy is idle most of the time by design. And the lending yield you see on testnet comes from a market **we deployed**, which is disclosed on-chain. |
| *"How big can a batch be?"* | 256 by default, hard-capped at 512, and the binding limits are **store entries and events, not gas** — 1 000 and 1 024 per transaction, neither raisable by paying more. Settlement is cursor-driven from day one, so `n` can grow into the thousands with no contract change. |

---

## 6. The fallback — if the auction is not ready

**Decide at the cut line, not at the venue.** If `batch.move` and `clearing.move` are not green,
do **not** improvise around them.

### Fallback A — the vault, plus the parity gate on the algorithm alone

Show Phase 1 end to end (`request_deposit` → `propose_nav` → `approve_nav` → `claim_deposit`) and
lead on the **two-party NAV split** and the **structural keeper argument** (beat 4), then run the
`sdk/` clearing property test — 10 000 seeded cases — as evidence that the algorithm exists and is
deterministic even if the on-chain half is not wired.

> Say: *"The vault is the part that ships first, because it does not depend on two-sided flow. The
> clearing engine is written and property-tested; what you are not seeing today is it running
> on-chain."* That is honest and it is still a demo.

### Fallback B — the queue leak, told with real data

Even with **no** Aphotic code running, the queue leak is real and observable. Pull live
`WithdrawalRequested` events and show the distribution: who, how much, where to, since when. Then
show `oracle.move`'s limiter replay reproducing the Guardian's bucket from those same public events.

### What is **not** a fallback

- Mocking a clearing result and presenting it as on-chain. **Do not.**
- Running the carry against the empty book to "show something happening."
- Any demo of the BTC leg in real time.

---

## 7. Things we must never say

| Never say | Say instead |
|---|---|
| "Non-custodial Bitcoin." | "`hBTC` is custodial-threshold wrapped BTC. The Sui side is non-custodial; one boundary — the redemption leg — is a 2-of-2 multisig enforced at signing." |
| "Your orders are anonymous." / "unlinkable" | "**v1 gives uniformity, not unlinkability.** The Merkle path is public, so the leaf index names the note." |
| "We earn X% in lending." | "We deployed the hBTC lending market ourselves, because none exists on testnet. That number comes from us." |
| "Seven validators could collude." *(alone)* | "Protocol floor is seven; live testnet today is thirty-two." **Always both.** |
| "Thirty-two validators would have to collude." *(alone)* | same — always both. |
| "The bridge is congested, and we monetise that." | The live bucket is **100 BTC refilling ~100 BTC/day**. An Aphotic-sized exit is never rate-limited. Pitch the **verifiability**: "we re-derive the bridge's own rate limiter from its own on-chain events, and we can show you the arithmetic." |
| "The NAV is fully verifiable on-chain." | "Every leg but one. The native-BTC leg is capped at the on-Sui claims behind it." |
| "Trustless." | "Aphotic is not trustless. It is no less trustworthy than the venue it serves." |
| Any of the five names in `aphotic.md` §22 (two firms, two protocols, one token) | describe the **pattern** generically — "the common two-scope keeper pattern", "a single-chain vault". Read §22 for the list. |

The honesty list is not a liability disclaimer. **It is the reason the rest is credible** — and in a
room full of people who have heard three "private Bitcoin" pitches already, being the one that
volunteers its own limits is the differentiator.
