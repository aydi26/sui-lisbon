# DEMO.md — the runbook

> Purpose: the pre-flight, the minute-by-minute script with **exact commands**, the line between what
> is **live** and what is **pre-staged**, and the fallback.
> Read alongside: `docs/SUBMISSION.md` (the judge-facing summary), `docs/STATUS.md` (what is really
> done — **check it before promising anything**), `docs/DEPLOYED.md` (the ids you will paste).
>
> **Rule for this file: if a command is printed here, it was run.** Where a beat depends on something
> that had not landed at the time of writing, the beat is marked ⚠ and §6 says what to do instead.

---

## 0. State of the tree when this was written — 2026-07-26

Measured, not quoted. Re-run everything in §3 before you present; the tree was being written
concurrently.

| Check | Command | Result |
|---|---|---|
| Move build | `cd move && sui move build` | **exit 0**, 4 lint warnings |
| Move tests | `cd move && sui move test` | **275 passed, 0 failed** |
| Lending package | `cd lending && sui move test` | **37 passed, 0 failed** |
| SDK | `cd sdk && npm test` | **15 files · 376 tests** |
| Keeper | `cd keeper && npm test` | **16 files · 252 tests** |
| App | `cd app && npm test` | **12 files · 157 tests** |
| Gates | `bash scripts/gates.sh` | **12 PASS · 0 FAIL · 0 SKIP** |
| On-chain | `node scripts/verify-onchain.mjs` | **28 PASS · 0 FAIL · 0 WARN · 4 INFO** |
| Rust twin | `cd clearing-rs && cargo test` | **79 passed, 0 failed** ⚠ needs `PATH="$HOME/.cargo/bin:$PATH"` |
| Master gate | `scripts/verify-all.ps1` | **12 PASS · 0 FAIL · 0 SKIP** (of 12 steps) |

**1 176 tests green in total** (275 Move + 37 lending + 376 SDK + 252 keeper + 157 app + 79 Rust),
and the master gate is clean end to end.

⚠ **The tree was being rewritten while this was measured**, so treat every figure as timestamped. In
~40 minutes keeper went 178 → 252 tests and app 152 → 157, and an earlier `verify-all.ps1` run showed
9 PASS · 3 FAIL — all three `tsc` errors in files an agent was mid-write, all three green on re-run.
**Re-run `verify-all.ps1` before you present and use its numbers, not these.** If a build is red on
the day, do not run `npm run dev` on stage — use the built artifacts or the §6 fallback.

⚠ **The v2 `aphotic` package IS PUBLISHED — see the ids below. It took two attempts; the first was rejected by the validator and the bisection is the best technical story here.** A
publish was attempted on 2026-07-26 and the validator rejected it with
`VMVerificationOrDeserializationError` — `clearing::Clearing` declares 39 fields against a 32-field
verifier cap that `sui move build` never checks. A second, independent blocker sits behind it (no LP
share coin, so `vault::create` has no `TreasuryCap` to consume). **Plan the demo on the assumption
that nothing goes on chain** — §6 Fallback A is the main path, not the contingency. `aphotic_lending`
**is** published and live. The full bisection is the best technical story you have; it is §5.

---

## 1. What the demo is actually about

One sentence, and it should be the first thing said:

> **Hashi's withdrawal queue is a public Move object. Every pending request exposes who, how much,
> where to, and since when — so a desk unwinding a position is watched forming in real time.
> Aphotic clears that flow before it reaches the queue.**

Everything else is evidence for that sentence.

### The four things worth showing, in order of strength

| # | What | Why it lands |
|---|---|---|
| **1** | **The leak itself, live.** Real pending requests in Hashi's queue: `sender`, `btc_amount`, `bitcoin_address`, `created_timestamp_ms`. | It is a fact about *their* system that anyone in the room can check in ten seconds. It needs none of our code to be true. |
| **2** | **A sealed order that is genuinely sealed.** Show the on-chain object: a commitment, a ciphertext hash, a blob id. **No amount. No side. No price.** Then the escrow: a `Note` struct with **no amount field at all**. | The whole thesis in one object, checkable in an explorer. |
| **3** | **Timing nobody can choose.** `open_batch` takes no timestamp; `close_ms` is derived; `close_batch` **reverts** a second early; a **full** batch still does not close early. | Uniform-price clearing is only fair if the operator cannot pick the moment. This is that property, in Move. |
| **4** | **The keeper cannot name a destination.** Grep the keeper-callable list live: **none of those functions has an `address` parameter.** | A structural argument, not a policy promise. A missing parameter cannot be supplied. |

**Do not lead with the vault.** The vault is the shippable product and the reason the thing works
from the first dollar, but the auction is the differentiator and the queue leak is the story.

---

## 2. Live vs pre-staged — the boundary, stated

A judge who discovers for themselves that something was pre-staged stops believing everything else.
So say it before they ask.

| Beat | Live? | Why |
|---|---|---|
| Hashi's queue read live in an explorer / `verify-onchain.mjs` | ✅ **LIVE** | their object, our read; 25 real events at 05:07 UTC today |
| `keeper schedule` — the derived cadence | ✅ **LIVE**, offline | one clock read, no network |
| `keeper seal-id` — the 48-byte little-endian identity | ✅ **LIVE**, offline | pure encoding |
| `keeper clear` — uniform-price clearing on a real order set | ✅ **LIVE**, offline | the algorithm, running |
| `keeper verify-limiter` — re-deriving Hashi's rate limiter from Hashi's own events | ⚠ **runs, but returned an EMPTY trajectory** on 2026-07-26 | exits 0 with `samples: []` and falls back to the `1000 / 100_000_000` prior — ~100× off the live scalars. **Check it before you plan to show it.** The algorithm is pinned by golden vectors and a cross-language parity test; the live replay is not currently producing rows. |
| `gates.sh` — the twelve structural invariants | ✅ **LIVE** | greps the tree in front of you |
| `sui move test` — 275 tests | ✅ **LIVE** | ~18 s |
| The published `aphotic_lending` market | ✅ **LIVE** | `0x39d038ae…`, and **empty** — say so |
| Submit / close / reveal / clear **on chain** | ⚠ **needs the v2 package published** | see §0 and §6 |
| **Move ↔ TypeScript clearing parity** | ❌ **DOES NOT HOLD — do not claim it** | a third, independent Rust implementation found Move and the TypeScript disagree on **15 % of 4 000 seeded books**, five named divergences. **Volunteer this; never present parity as achieved.** See §5, story three. |
| **BTC in — a signet deposit minting hBTC** | ❌ **~70+ min** | 6 confirmations + a mandatory 10-minute delay. **Pre-stage.** |
| **BTC out — a redemption confirming on signet** | ❌ **~1.5–2 h** | **Pre-stage.** |
| **The carry itself** | ❌ **NOT BUILT** | the book is empty on both sides and we can mint neither leg. Say it; do not mime it. |

**The BTC leg is never live-demoable, and pretending otherwise is the fastest way to lose the room.**
Pre-stage it: have an **earlier, already-confirmed** signet transaction and its Hashi
`DepositConfirmed` / `WithdrawalConfirmed` events open in a tab, and say plainly *"this one I ran
earlier, because it takes seventy minutes."*

---

## 3. Pre-flight — the day before, not the hour before

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"          # sui is NOT reliably on PATH

# 1. The master gate. Expect 12 PASS. If any step FAILs, read which one before deciding anything.
powershell -NoProfile -File scripts/verify-all.ps1

# 2. The packages
cd move    && sui move build && sui move test        # expect 275 passed
cd lending && sui move build && sui move test        # expect  37 passed

# 3. The offline suites
cd sdk    && npm test                                # expect 376
cd keeper && npm run typecheck && npm run build && npm test   # expect 252 — typecheck MUST be clean
cd app    && npm run build && npm test               # expect 157

# 4. The invariant gates, in BOTH shells — they must agree verdict for verdict
bash scripts/gates.sh
powershell -NoProfile -File scripts/gates.ps1

# 5. Everything we depend on is still where we left it
node scripts/verify-onchain.mjs                      # expect 28 PASS · 0 FAIL
```

Then, and this is the part people skip:

- **Warm the four keeper commands** you will actually type on stage (§4), so no npm install happens live.
- **Run `node dist/index.js verify-limiter` and look at `samples`.** If it is `[]`, drop that beat —
  it exits 0 either way, and a command that prints an empty result on stage is worse than one you
  never opened.
- **Re-read the live Guardian limiter scalars** (`GET {guardian_url}/info` over **HTTP/2** — HTTP/1.1
  returns 464). They are config, and config changes.
- **Health-probe the Seal committee.** `GET {url}/v1/service` needs **both** a `Client-Sdk-Version`
  header **and** a `?service_id=` query param, or it returns 400. **If fewer than `t = 3` distinct
  operators are live, do not open a batch** — and never fall back to plaintext. 3 of 10 advertised
  testnet servers were down on 2026-07-25.
- **Pre-stage the BTC leg** and have the explorer tabs open, already loaded.
- **Have §6 open in another window.** Decide at the cut line, not at the venue.
- **Charge everything and download the slides locally.** Venue wifi is why the globe textures are
  vendored into `app/public/globe/` instead of fetched from a CDN.

Have these ready in a scratch file before you start:

```bash
cat > /tmp/orders.json <<'EOF'
{
  "batchId": 1,
  "feeMatchedBps": 10,
  "orders": [
    { "index": 0, "submitter": "0x…0a11", "isBid": true,  "limitPrice": "100000000", "qtySats": "1000000" },
    { "index": 1, "submitter": "0x…0b22", "isBid": false, "limitPrice": "90000000",  "qtySats": "1000000" }
  ],
  "funding": [
    { "submitter": "0x…0a11", "baseSats": "0",       "quoteSats": "10000000" },
    { "submitter": "0x…0b22", "baseSats": "1000000", "quoteSats": "0" }
  ]
}
EOF
```

(`funding` is **required**, not optional. An account that cannot cover its fill is truncated
deterministically, so omitting the snapshot would clear a *different* auction from the one that would
settle on chain.)

---

## 4. The script

Times are a guide for a ~5-minute slot. **Cut from the bottom, never from beat 1.**

### 0:00 — The leak (40 s, one browser tab, no slides)

Open Hashi's shared object in an explorer, or run:

```bash
node scripts/verify-onchain.mjs
```

Point at the `P5 events withdrawal_queue` rows — real `WithdrawalRequested` / `WithdrawalApproved`,
with an envelope timestamp from minutes ago.

> *"This is Hashi's withdrawal queue. It is a public Move object. Every pending redemption tells you
> who is leaving, how much, and where to — before a satoshi moves, and it stays visible for the hour
> and a half the Bitcoin side takes. If you are a desk unwinding a position, the market watches it
> form and prices against you. Aphotic clears that flow before it reaches this queue."*

### 0:40 — Timing nobody chooses (50 s, live, offline)

```bash
cd keeper && node dist/index.js schedule
```

Real output:

```
now       1785042471352  2026-07-26T05:07:51.352Z
previous  1785002400000  2026-07-25T18:00:00.000Z
next      1785045600000  2026-07-26T06:00:00.000Z  (in 52 min)
due       [{"action":"open","reason":"no live batch; open_batch will derive close_ms = 1785045600000"}]
```

> *"`open_batch` takes no timestamp parameter. `close_ms` is derived — twelve-hour cadence, six-hour
> offset, so 06:00 and 18:00 UTC. Nobody, including us, can choose when a batch closes. And a full
> batch does **not** close early — otherwise a spammer would own the timing lever that uniform-price
> clearing exists to remove."*

If the package is published, this is the moment to call `close_batch` one second early and show it
abort `ETooEarly`. If it is not, say the test does it and show the name:

```bash
cd move && sui move test batch     # 45 tests, incl. close_before_schedule_aborts
```

### 1:30 — What a sealed order actually contains (50 s)

If the app is running and the package is published: submit an order from `/batch` — it is encrypted
**client-side** before it enters the transaction — then open the resulting object.

Otherwise show the struct and the identity:

```bash
cd keeper && node dist/index.js seal-id \
  --batch 0x0000000000000000000000000000000000000000000000000000000000000abc \
  --close-ms 1785045600000 --policy-version 1
```

```
inner id (48 bytes)  0x0047029d9f0100000100000000000000…0abc
  [ 0..8 )  close_ms        1785045600000   LITTLE-ENDIAN
  [ 8..16)  policy_version  1               LITTLE-ENDIAN
  [16..48)  batch id        0x…abc
```

> *"Commitment. Ciphertext hash. Blob id. That is all that lands on chain — no amount, no side, no
> price. And the escrow behind it is fixed-denomination notes: here is the `Note` struct, an id and a
> denomination index, and **no amount field exists**. Not hidden. Absent."*

If asked *"why not just encrypt the amount?"* — one line: **a `Balance<BTC>` carries a publicly
readable value, so escrow would leak the size regardless of what you encrypt.**

If you have 10 spare seconds, this is the best place for the byte-order story (§5).

### 2:20 — Clear it (60 s, live, offline)

```bash
cd keeper && node dist/index.js clear < /tmp/orders.json
```

Real output:

```
clearingPrice   90000000        (PRICE_SCALE = 1e8)
matchedBaseSats 1000000
quotePaid       900000
quoteRecv       899100
feeQuote        900
fillsRoot       0x743f30daebc580a11d32c71c1604457d42…
```

> *"One uniform price for both sides. Debits equal credits plus the fee, exactly — the fee is an
> explicit third term, never a silent shortfall. And that root is what you prove a fill against."*

If the package is published, run it on chain instead — `begin` → `step` (loading → pricing → rooting
→ settling) → `verify_fill` — and say the line that matters:

> *"Notice who is sending these. Open, close, reveal, step, settle — none of them takes a capability.
> If our keeper is offline, anyone in this room finishes the batch. Liveness is never a privilege."*

### 3:20 — The bug we went looking for and found (50 s)

**Do not present parity as achieved.** Present the *search* for it — which is the stronger story, and
the only honest one.

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # ⚠ cargo is installed but NOT on the default PATH here
cd clearing-rs && cargo test           # 79 tests pass, two engines on purpose
```

> *"Our own spec says a divergence between clearing implementations is a release blocker. So we wrote
> a **third** implementation, in Rust, from the spec rather than ported from either side — and it
> found that our Move and our TypeScript are not the same algorithm. Four thousand random books,
> agreement on eighty-five percent. Five named divergences, each with a hand-derived counterexample.
> The worst is structural: the two fill-leaf layouts are seventy-three and eighty-one bytes, so the
> Merkle roots can never match."*
>
> *"Two of the five aren't bugs, they're design questions — whether an overfull price level fills
> greedily or pro-rata, and whether one under-funded account may move the uniform price for everyone.
> So the Rust crate implements **both** engines and refuses to pick, until a human does. A parity
> claim you haven't checked is a guess. One you've checked and failed is a bug — and this one is open."*

If `cargo` will not run on the machine, show the counterexamples instead:

```bash
sed -n '/5ter/,/^---/p' docs/DESIGN-V2.md      # the five divergences, with frequencies
```

### 4:10 — What a compromised keeper buys you (35 s)

```bash
bash scripts/gates.sh
```

Point at these two lines in the output:

```
[PASS] keepercap  No KeeperCap-gated function takes an address parameter (INV-C1)
[PASS] notes      `struct Note` declares only id + denom_index (no amount can leak)
```

> *"The keeper can call a fixed set of functions, and **none of them takes an `address` parameter**.
> Not 'the keeper is not allowed to choose a destination' — there is no parameter in which to put one.
> And NAV is two **parties**: our keeper proposes a number, an admin multisig approves the exact
> digest, and neither moves the share price alone. Twelve gates, zero fails, zero skips — and a skip
> is counted separately, so a gate can never look green because the thing it guards isn't written."*

### 4:45 — The honest close (25 s)

> *"Four things we will say before you ask. `hBTC` is custodial-threshold wrapped Bitcoin — we inherit
> every one of Hashi's trust assumptions, and the collusion floor is seven validators by protocol,
> thirty-two on testnet today. Version one gives you **uniformity, not unlinkability** — the Merkle
> path is public, so the leaf index names the note; the zero-knowledge tier is a verifier swap on the
> same tree. The lending market we allocate idle capital to is **ours**, because none exists on
> testnet, and it says so on chain. And if the bridge's queue always clears in minutes, there is no
> spread and this venue is worth little — Aphotic is closer to congestion insurance than to a bridge.
> It is not trustless. It is no less trustworthy than the venue it serves, and that is the honest bar."*

---

## 5. The three stories to tell if you get a technical question

Each shows engineering rather than asserts it. The first is also the honest answer to *"why isn't it
deployed?"*, so have it ready whether or not anyone asks.

**A green build is not evidence a package can be deployed.** 275 tests pass, `sui move build` exits 0,
and `sui client publish` was rejected by the validator with `VMVerificationOrDeserializationError` —
one enum variant, no module name, no line number. `sui client verify-bytecode-meter` is *not yet
implemented* in sui 1.76.0 and panics. So we bisected: publish eight modules with `--dry-run` →
success; add `clearing` → rejected; add `allocate` instead → success; a module containing **only**
`clearing`'s four structs and no functions → still rejected; every function body stubbed to `abort 0`
→ still rejected, so not a metering limit. Then we measured the wall directly with a synthetic struct:
**32 fields publishes, 33 does not.** `Clearing` has 39. The identical struct with seven removed
dry-runs clean. *"`sui move build` runs the Move verifier; the Sui object verifier runs only on a
validator, and nothing local covers that gap."* If they ask what it cost: it also surfaced a second
blocker — the LP share coin module was never written, so `vault::create` has no `TreasuryCap` to
consume — and it corrected our own architecture doc from seven shared objects to three.

**The byte order that was already wrong on both sides.** The keeper wrote the Seal identity's
timestamp with `setBigUint64(offset, value, false)` — and `false` is `DataView`'s *little-endian
flag*, so it wrote big-endian. The old Move code decoded it big-endian by hand, so both sides agreed
and both were wrong. v2 parses with `bcs::peel_u64`, which is **little-endian**: emit the other
convention and the key servers just decline, the batch never reveals, and **there is no error
anywhere to read**. Fixed by giving the encoding exactly one home, and by pinning it with
**hand-derived** byte vectors rather than the encoder's own output — an expectation built by the
thing under test agrees with itself in either convention, which is exactly how the original bug
survived having tests. There is now a gate that fails the build on a `<< 8` decode in `batch.move`.

**Forty-six golden fixtures that could not fail.** Three implementations of clearing, two price
scales — Move and the keeper at `1e8`, the SDK at `1e9`. That is the divergence our own spec calls a
release blocker. The interesting part is why the fixtures stayed green: they never passed a scale, so
they silently adopted whatever the constant happened to be. **A fixture that inherits the constant it
is supposed to check cannot fail when that constant is wrong.** The fix was to make the scale explicit
at every call site, so the goldens now pin the algorithm's *scale-independence* — a stronger property
— and the production constant is pinned separately and directly against
`aphotic::clearing::price_scale()`.

**And the sequel: two implementations that agree tell you nothing.** Fixing the fixtures was not
enough — 46 hand-written cases are too narrow a net. It took a **third** implementation, written from
the spec rather than ported from either side, to find that Move and TypeScript disagree on 15 % of
random books. Same lesson as the byte-order bug, one level up: **an oracle built out of the things
under test cannot referee them.** Full detail, frequencies and counterexamples in
`docs/DESIGN-V2.md` §5ter and `clearing-rs/tests/divergence.rs`.

---

## 6. The fallback

**Decide at the cut line, not at the venue.**

### Fallback A — the package is not published (**assume this is the path**)

Everything in §4 except the on-chain sub-beats already runs offline. Run the script exactly as
written and say, once, plainly and early — do not let them find it:

> *"The Move package is written and green — two hundred and seventy-five tests — and it is **not**
> published, because the validator rejected the publish. One of our structs has thirty-nine fields and
> the on-chain verifier caps them at thirty-two, and `sui move build` doesn't run that verifier. So
> what you are seeing run is the algorithm and the invariant gates, not a transaction. I would rather
> show you the thing that is true than a transaction that isn't."*

Then tell the bisection (§5, story one). It is a better answer than a deployment would have been,
because it is specific, reproducible and something a Sui judge can check.

Then lean harder on beats 1, 4 and 6 — the leak, the structural keeper argument, and the honest close
— because none of them depends on a publish.

### Fallback B — a build is red on the day

`npm test` and `sui move test` are independent of `npm run build`. Run the **tests**, not the builds,
and do not open `npm run dev`. `node scripts/verify-onchain.mjs`, `bash scripts/gates.sh`,
`sui move test` and the four keeper commands were all green with the builds red.

### Fallback C — no network at all

`sui move test`, `sdk npm test`, `app npm test`, `gates.sh`, and `keeper schedule` / `seal-id` /
`clear` are **fully offline**. Only `verify-onchain.mjs` and `verify-limiter` need the network. Have a
screenshot of today's `verify-onchain.mjs` output ready and say it is a screenshot.

### What is **not** a fallback

- Mocking a clearing result and presenting it as on-chain. **Do not.**
- Running the carry against the empty book to "show something happening."
- Any demo of the BTC leg in real time.
- Describing the clearing parity as achieved, or as "a rounding difference". It is a **release
  blocker by our own spec**, it is open, and volunteering it is worth more than hiding it.

---

## 7. Q&A — the answers that must be ready

| Question | Answer |
|---|---|
| *"Isn't this just a mixer?"* | No, and we do not claim to be. **v1 note spends are linkable** — the Merkle path is supplied in the clear, so the leaf index names the note. Denominations buy **uniformity**; privacy would come from the crowd, and the crowd does not exist at launch. |
| *"Can't the operator front-run the batch?"* | Uniform-price clearing does not make front-running hard, it makes it **meaningless**: everyone in a batch executes at the same price at the same instant. And the operator cannot pick the moment — `close_ms` is derived, and a full batch still does not close early. |
| *"What if the Seal servers collude?"* | Then they decrypt early. Stated without hedging: pre-close confidentiality is `t`-of-`n`, `t = 3` of **5 distinct operators** — counted by operator, because two servers from one operator are one failure domain. The fix is the planned upgrade: a PCR-gated policy so only an attested enclave ever decrypts. |
| *"Why not a TEE now?"* | Clearing on a fixed order set is a **pure function**, so it runs on-chain and anyone verifies it. A TEE buys exactly one thing — hiding *unfilled* orders after close. That is a problem of success, not of launch, and the upgrade is a policy swap with no contract change. |
| *"Why not commit–reveal?"* | It requires participants to be online to reveal, which creates grief-by-non-revelation and forces an anti-abandonment bond. Seal's time-lock gives the same confidentiality with a **guaranteed** reveal — and the policy has **no sender check**, so anyone can produce it. |
| *"Can you jump the withdrawal queue?"* | No. Over-capacity batches are **rejected**, not queued, and a `WithdrawalRequest` lives in an `ObjectBag` on the queue, not in your account — positions are not transferable and cannot be bought. |
| *"Is the vault non-custodial?"* | On the Sui side, yes: capital sits in Move objects reachable only through scoped capabilities. **One boundary is not**: `request_withdrawal` sets `sender: ctx.sender()`, the transaction signer, so a shared object can never hold a queue position. That leg is gated by a 2-of-2 multisig **at signing, not by Move**, and we say so everywhere. |
| *"Can you prove the NAV?"* | Every leg except one. Native BTC at the redemption address lives in the Bitcoin UTXO set and Sui has no light client, so we **cap that leg at the sum of on-Sui-readable withdrawal claims that produced it** — asserted in `approve_nav`. It can never exceed the verifiable claim behind it. **We do not present the NAV as fully reconstructible.** |
| *"What's the yield?"* | Two sources: matched-volume fees and realised carry. **Never a management fee on AUM** — the strategy is idle most of the time by design. And the lending yield on testnet comes from a market **we deployed**, disclosed on-chain, currently holding nothing. |
| *"How big can a batch be?"* | 256 by default, hard-capped at 512, and the binding limits are **store entries and events, not gas** — 1 000 and 1 024 per transaction, neither raisable by paying more. Settlement is cursor-driven from day one, so `n` can grow into the thousands with no contract change. **256 is a reasoned default, not yet a measured one** — the measurement needs the package published. |
| *"Why is your keeper TypeScript when the docs say Rust?"* | Because its defining duty at close is to **decrypt**, and `@mysten/seal` has no Rust client. A Rust keeper would need a TypeScript sidecar for exactly that leg — two supervision trees, an IPC boundary carrying **order plaintext**, and a second implementation of the Seal identity encoding, which is precisely where the byte-order bug bites. The doc was changed, not the architecture; it is recorded as a deviation in `docs/GOVERNANCE.md` §9. |
| *"Has any of this been deployed?"* | `aphotic_lending` is live at `0x39d038ae…`. The main package is written and green and **the validator rejected the publish** — a 39-field struct against a 32-field cap that `sui move build` does not check. Then tell the bisection. Never say "not published yet" as if it were a scheduling matter. |
| *"So how do I know the Move code works if it's never run on chain?"* | You do not, and we will not pretend otherwise. What you can check is 275 Move tests and twelve structural gates. And we will volunteer the bad news, because we would rather you heard it from us: we wrote a **third** clearing implementation in Rust purely to check the parity claim, and **it failed**. TypeScript, the 46 fixtures and the Rust spec engine agree; Move differs on 15 % of 4 000 seeded books, across five named divergences — the fill-leaf layouts are 73 and 81 bytes, so the Merkle roots can never match. Counterexamples are hand-derived in `clearing-rs/tests/divergence.rs`. That is a release blocker by our own §9, it is open, and finding it is what the third implementation was for. |
| *"Is the clearing deterministic and reproducible?"* | Deterministic, yes — same order set, same output; order-independence and truncation-monotonicity are property-tested over thousands of seeded cases. **Reproducible across implementations, not yet** — see the row above. Two of the five divergences are design questions rather than bugs (greedy vs pro-rata allocation at an overfull level; whether one under-funded account may move the uniform price for everyone), which is why the Rust crate implements both engines and refuses to pick until a human does. |

---

## 8. Things we must never say

| Never say | Say instead |
|---|---|
| "Non-custodial Bitcoin." | "`hBTC` is custodial-threshold wrapped BTC. The Sui side is non-custodial; one boundary — the redemption leg — is a 2-of-2 multisig enforced at signing." |
| "Your orders are anonymous." / "unlinkable" | "**v1 gives uniformity, not unlinkability.** The Merkle path is public, so the leaf index names the note." |
| "We earn X% in lending." | "We deployed the hBTC lending market ourselves, because none exists on testnet. That number comes from us — and right now the market is empty." |
| "Seven validators could collude." *(alone)* | "Protocol floor is seven; live testnet today is thirty-two." **Always both.** |
| "Thirty-two validators would have to collude." *(alone)* | same — always both. |
| "The bridge is congested, and we monetise that." | The live bucket is on the order of 100 BTC refilling ~100 BTC/day; an Aphotic-sized exit is never rate-limited. Pitch the **verifiability**: "we re-derive the bridge's own rate limiter from its own on-chain events, and we can show you the arithmetic." |
| "The NAV is fully verifiable on-chain." | "Every leg but one. The native-BTC leg is capped at the on-Sui claims behind it." |
| "It's deployed." *(of the main package)* | "`aphotic_lending` is deployed. The main package is written and green and not published yet." |
| "Trustless." | "Aphotic is not trustless. It is no less trustworthy than the venue it serves." |
| Any of the five names in `aphotic.md` §22 (two firms, two protocols, one token) | describe the **pattern** generically — "the common two-scope keeper pattern", "a single-chain vault". Read §22 for the list. |

The honesty list is not a liability disclaimer. **It is the reason the rest is credible** — and in a
room that has already heard three "private Bitcoin" pitches, being the one that volunteers its own
limits is the differentiator.
