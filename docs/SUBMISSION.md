# SUBMISSION — Aphotic

**Confidential batch clearing and redemption carry for native Bitcoin on Sui.**
ETHGlobal Lisbon 2026 · Sui track · Sui **testnet**, Bitcoin **signet**. Not audited.

> Every number in this document was produced by running the command printed next to it on
> **2026-07-26**, on the tree as it stood at the time of writing. Where something was in flight,
> it says so. Nothing here is quoted from a summary.

---

## 1. The problem, in one checkable fact

[Hashi](https://github.com/MystenLabs/hashi) is MystenLabs' native-BTC orchestrator on Sui: send
BTC, receive `hBTC`; burn `hBTC`, get BTC back. The return leg runs through a
`WithdrawalRequestQueue`, and **that queue is a public Move object**
(`packages/hashi/sources/btc/withdrawal_queue.move`). Every pending request carries:

| Field | What it tells an observer |
|---|---|
| `sender` | *who* is leaving |
| `btc_amount` | *how much* |
| `bitcoin_address` | *where to* |
| `created_timestamp_ms` | *when they decided* |

Nothing needs decoding. A desk unwinding a position is **watched forming in real time**, and it
stays visible for the ~1.5–2 hours the withdrawal takes to confirm on Bitcoin. This is not a
speculative attack surface — it is the queue's normal, documented operation, and you can read it
right now:

```bash
node scripts/verify-onchain.mjs      # prints live withdrawal_queue events off the shared object
```

That run, on 2026-07-26, returned **28 PASS · 0 FAIL · 0 WARN · 4 INFO**, including 25 live
`WithdrawalRequested` / `WithdrawalApproved` rows with a latest envelope timestamp of
`2026-07-26T05:07:09.822Z`. The bridge is live and carrying real traffic.

Exiting the bridge is also **queued and rate-limited** — the Guardian runs a token-bucket limiter
and batches requests into Bitcoin transactions, and withdrawals pause during Hashi reconfiguration
at every Sui epoch boundary. Latency is therefore variable, and the discount at which `hBTC` trades
against BTC is the market price of that latency.

---

## 2. The mechanism

Aphotic is two things sharing one product balance sheet.

### 2.1 The redemption-carry vault

Buy `hBTC` below par from someone who wants out *now*; redeem it one-for-one through the queue
ourselves; capture the spread. The seller gets immediacy without broadcasting their exit. Idle
capital is lent between carries.

The vault ships first because it does not need two-sided flow — it works from the first dollar.

It is an ERC-7540-shaped async request/settle vault, and its governance claim is a **two-party**
NAV split, not a two-scope one:

```
propose_nav(nav)   ← keeper, via KeeperCap.  Records only. Commits nothing.
approve_nav(nav)   ← admin multisig, via AdminCap. Commits, prices the epoch, mints/burns.
```

The common production pattern separates *scopes* — one automation key holds permissions on both a
valuation module and a settlement module, so a compromised key performs both legs. Aphotic
separates *parties*. That is affordable here because valuation is twice daily and approval is a
signature, not a continuous duty. `approve_nav` additionally checks a digest the admin signed, so
the keeper cannot swap the proposal in a race.

### 2.2 The sealed-order batch auction

Orders are Seal-encrypted **client-side** under a time-lock policy. What lands on Sui is a
commitment, a ciphertext hash and a blob id — **no amount, no side, no price**. At the scheduled
close the policy becomes satisfiable, anyone reveals, and clearing runs **on-chain in Move**,
deterministically, at a single **uniform price**.

Three properties do the work, and each is structural rather than a promise:

**Uniform price makes front-running meaningless, not merely hard.** Everyone in a batch executes at
the same price at the same instant. There is no queue position to buy, no ordering to bribe, no
first-mover edge — because "first" is not a thing a batch has. Sequencing advantage is not defended
against; it is removed from the design.

**The cadence is mechanical.** `close_ms` is *derived*:

```move
public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64
// cadence_ms = 43_200_000 (12 h), offset_ms = 21_600_000 → 06:00 and 18:00 UTC
```

`open_batch` takes **no timestamp parameter**. An operator who could choose when a batch closes
could advantage selected orders — the exact attack uniform-price clearing exists to remove. A
*full* batch also does not close early; it rejects further submits and still closes on the
boundary, so a spammer cannot buy the timing lever either.

**Escrow leaks no size.** A `Balance<BTC>` carries a publicly readable amount, so encrypting the
order would be pointless if escrow were free-form. Escrow is fixed-denomination notes —
`0.01 / 0.1 / 1 / 10 hBTC` — over a Merkle commitment tree with a nullifier set. The `Note` struct
declares `id` and `denom_index` and nothing else; the amount is not hidden, it is **absent**. A
gate enforces that:

```
[PASS] notes  `struct Note` declares only id + denom_index (no amount can leak)
              move/sources/notes.move · fields found: id, denom_index
```

### 2.3 What a compromised keeper buys you

The keeper is off-chain, holds only a `KeeperCap`, and the functions it can call have **no `address`
parameter at all**. Not "the keeper is not permitted to name a destination" — there is no parameter
in which to put one. A gate greps for it:

```
[PASS] keepercap  No KeeperCap-gated function takes an address parameter (INV-C1)
```

And liveness is deliberately **not** a privilege: `open_batch`, `close_batch`, `reveal_order`,
`begin`, `step`, `claim_deposit` and `claim_redeem` are all permissionless. If our keeper is
offline, anyone finishes the batch. The schedule and the commitments *are* the authorization.

---

## 3. What is deployed

| What | Where | State |
|---|---|---|
| `aphotic_lending` package | `0x39d038aea02ccc0bd25e97c7f1a715e87dd6ccae19b0bf9ac255379634b6ea8c` | **live on testnet.** Package object `Immutable` (as all Sui package objects are). An `UpgradeCap` `0x6a196a84…` is `AddressOwner` to the deployer, so a *new version* could be published — the bytecode at this id can never change. |
| shared `Market` | `0x220ba0e51d56600d90c967cf523a54b6a4a48c62384810d5d89b0b884b066677` (isv `953314524`) | live, and **empty**: cash 0, borrows 0, shares 0 |
| share coin | `<pkg>::lending::LENDING`, symbol `aLhBTC`, 8 decimals | `Currency<LENDING>` `0xa0b6685d…`. The metadata cap was **destroyed at publish**, so the coin description — which *is* the disclosure — can never be edited away. |
| publish tx | `3PCybDwuxCCxEace2zSrNutPRSNvEKAazPZjbKPTqnJZ` | success |
| `aphotic` package (the ten v2 modules) | — | **NOT PUBLISHED. A publish was attempted and the validator rejected it** — `VMVerificationOrDeserializationError`, tx `2byvZDvZo2onDwLxQe2bxME9qn3iEscGUDfmWhu4vqmp`. Cause established by bisection, see §5. |
| Hashi (not ours) | package `0xfcea10ca…`, shared `Hashi` `0x22c0ce66…` | live, real traffic |

We deployed the lending counterparty ourselves and say so on-chain — see §6.

---

## 4. What is verified, and how you verify it without us

Run these yourself. The figures are what they printed on 2026-07-26.

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"       # sui is not reliably on PATH

cd move    && sui move build && sui move test    # 275 tests, 275 passed, 0 failed · 10 modules
cd lending && sui move build && sui move test    #  37 tests,  37 passed, 0 failed
cd sdk     && npm test                           # 15 files · 376 tests
cd keeper  && npm test                           # 16 files · 252 tests
cd app     && npm test                           # 12 files · 157 tests (fully offline)

bash scripts/gates.sh                            # 12 PASS · 0 FAIL · 0 SKIP
powershell -NoProfile -File scripts/gates.ps1    # must agree, verdict for verdict
node scripts/verify-onchain.mjs                  # 28 PASS · 0 FAIL · 0 WARN · 4 INFO (needs network)

powershell -NoProfile -File scripts/verify-all.ps1   # the master gate — 12 PASS · 0 FAIL · 0 SKIP
```

```bash
export PATH="$HOME/.cargo/bin:$PATH"             # cargo is installed but not on the default PATH
cd clearing-rs && cargo test                     # 79 passed, 0 failed
```

**Total: 275 Move + 37 lending + 376 SDK + 252 keeper + 157 app + 79 Rust = 1 176 tests, all green**,
plus 12 structural gates that agree verdict-for-verdict across `bash` and PowerShell.

Move tests, per module, measured individually: `vault` **42** · `batch` **45** · `clearing` **25** ·
`notes` **32** · `balance` **27** · `caps` **24**, with `allocate` and `oracle` accounting for the
remaining **80** of the 275.

### The gates are the interesting part

A test proves the code does what the test says. A gate proves the code *cannot* do something a
comment merely asks it not to. All twelve pass, and — this matters — **`SKIP` is counted separately
from `PASS`**, so a gate can never look green because the thing it guards has not been written yet.

| Gate | What it makes impossible |
|---|---|
| `keepercap` | a `KeeperCap` function taking an `address` — the keeper cannot name a destination |
| `notes` | a `Note` field other than `id` / `denom_index` — no amount can leak |
| `seal_le` | a big-endian `u64` decode in `batch.move` — see §5 |
| `batchstate` | `.state =` outside `set_state` / `open_batch` — transitions stay monotonic |
| `send` | `signAndExecute` outside `keeper/src/sui/send.ts` — every write is devInspected first |
| `ids` | a canonical on-chain id hardcoded outside its six declared homes |
| `purity` | `Date.now()` / `Math.random()` in code that must be deterministic |
| `transport` | more than one Sui client factory per package |
| `g7` `g4` `g2` `sdk` | the Hashi boundary, the venue, the exit-destination rule, the adapter boundary |

### Anyone can re-derive the bridge's own rate limiter

The Guardian's token bucket is not a number we ask you to trust. It is a deterministic projection of
Hashi's own public event stream, and the keeper re-derives it from those events rather than reading
the Guardian's API:

```bash
cd keeper && node dist/index.js verify-limiter
```

`project_capacity = min(cap, tokens + elapsed × refill_rate)`, replayed over
`WithdrawalRequested` / `WithdrawalPickedForProcessing` / `WithdrawalSigned` / `WithdrawalCancelled`.
The Guardian's own API is deliberately **not** consulted — the entire claim is that you can reproduce
the bucket without trusting us. There is exactly one implementation of that algorithm per language and
a cross-parity test pins them to each other; a duplicate drifted once, which is why the rule is now
enforced by a gate.

⚠ **Measured honestly:** on 2026-07-26 this exited 0 and returned an **empty trajectory**
(`samples: []`) — the replay found no events in its lookback window, and it fell back to the
`1000 / 100_000_000` sats prior, which is roughly 100× off the live Guardian scalars
(`115_740 / 10_000_000_000`). The algorithm and its golden vectors are pinned by tests; the *live*
replay is not currently producing a trajectory. Do not demo this command without checking it first.

### The clearing engine runs locally, right now

```bash
cd keeper && node dist/index.js clear < orders.json
```

Real output, this tree, one crossing pair at 1.0 bid / 0.9 ask with a 10 bps fee:

```
clearingPrice   90000000        (PRICE_SCALE = 1e8)
matchedBaseSats 1000000
quotePaid       900000
quoteRecv       899100
feeQuote        900             ← Σdebits == Σcredits + fee, exactly
```

### ⚠ And the parity claim currently FAILS — we found it, and we are not going to bury it

`aphotic.md` §9 says a divergence between clearing implementations is a **release blocker**. We wrote
a **third** implementation in Rust specifically to test that claim, reading the same
`sdk/fixtures/clearing.golden.json` in place. It found that `clearing.move` and the TypeScript **are
not the same algorithm.**

Seeded census over **4 000 random books: full agreement on 3 407 (85 %)**. The TypeScript, the 46
fixtures and the Rust spec engine all agree with each other; it is **Move** that differs — and Move
is what settles. Five named divergences, each with a hand-derived counterexample in
`clearing-rs/tests/divergence.rs` and `docs/DESIGN-V2.md` §5ter:

| # | Divergence | Frequency / consequence |
|---|---|---|
| D1 | **Fill-leaf layout.** Move's `bcs(Fill)` is 73 bytes (`batch_id`, no `fee`); the spec's is 81 (`fee`, no `batch_id`, `u128` price). | The two Merkle roots can **never** match for a non-empty fill set. This alone makes byte-comparison meaningless today. |
| D2 | **Allocation.** Move fills an overfull strictly-inside level **greedily**; the spec **pro-rates** it. Bids 60@10 + 60@10 against ask 50@5 → Move gives 50/0, the spec gives 25/25. | 97 of 4 000 (2.4 %). Two participants at the same price get different fills. |
| D3 | **Fee.** Move folds rounding dust into the fee; the spec keeps them separate — asserted exactly as `move.fee == spec.fee + spec.dust`. | 516 of 4 000 (**12.9 %**) — the most frequent and the least visible. |
| D4 | **Truncation timing.** Move truncates at *load*, before price discovery, so one under-funded account **moves the uniform clearing price** for everyone. Counterexample clears at 10 on Move and 12 on the spec. | A design question, not a rounding one. |
| D5 | **Price width.** `u64` in Move, `u128` in the spec. One fixture is not expressible against Move at all. | |

**Which side is right is a human decision, not a mechanical one.** D2 and D4 in particular are genuine
design choices, which is why the Rust crate deliberately implements **both** engines rather than
picking a winner. What is not optional is saying so: *a parity claim that has not been checked is a
guess, and one that has been checked and failed is a bug.* This one is open, and it is the single
highest-priority item in §7.

The same pass found that §5bis(d) of our own design doc **miscounts its own byte layout** — it says
"= 73 bytes" for a field list that sums to 81; the code is right and the prose was wrong.

So the honest state of the three parity levels is: **L1** 46 shared fixtures — green, and now known
to be too narrow to catch this. **L2** 10 000 seeded property cases — green, but they assert
*structural invariants*, not cross-implementation equality. **L3**, the real gate — `devInspect`
byte-for-byte — is owed, and would fail today on D1 alone.

---

## 5. Three things that went wrong, and what they cost

These are here because they show the engineering rather than assert it. The third is the one that
stopped the deployment, so it comes first.

### `sui move build` does not run the verifier that actually decides — 275 green tests, unpublishable

The package builds clean and passes 275 tests. `sui client publish` was rejected by the validator:

```
Error executing transaction '2byvZDvZo2onDwLxQe2bxME9qn3iEscGUDfmWhu4vqmp':
VMVerificationOrDeserializationError in command 0
```

There is no line number, no struct name, no module name — the whole error is one enum variant.
`sui client verify-bytecode-meter`, the tool for exactly this, is `not yet implemented` in sui 1.76.0
and panics. So the cause was isolated by bisection, publishing progressively larger module subsets
with `--dry-run`:

| Module set | Dry run |
|---|---|
| `events oracle carry caps balance notes batch vault` (8) | success |
| the same 8 **+ `clearing`** | **rejected** |
| the same 8 **+ `allocate`** (9, no `clearing`) | success |
| a module containing **only** `clearing`'s four structs, no functions | **rejected** |
| the same structs with every function body stubbed to `abort 0` | still rejected ⇒ not a code-complexity or metering limit |

Then the limit itself was measured directly with a synthetic `public struct T has key`: **32 fields
publishes, 33 does not.** `aphotic::clearing::Clearing` declares **39** (`id` counted). Proof of fix:
the identical struct with 7 fields removed — 32 exactly — dry-runs `success`.

Two things this cost, and one it bought:

- **The lesson: a local green build is not evidence a package can be deployed.** `sui move build`
  runs the Move bytecode verifier; the *Sui object verifier* runs only on a validator. Nothing in the
  local toolchain covers the gap, and the tool that would have is unimplemented.
- **A second, independent blocker was found while sequencing the runtime objects**, and it would have
  bitten immediately after the first was fixed: `vault::create` consumes a `TreasuryCap<S>` by value
  and asserts `total_supply == 0`, but the package **defines no LP share coin**. The spec calls for
  `Coin<APHOTIC_LP>`; that module was never written. The only `S` that exists is `APLP`, declared
  `#[test_only]` inside `move/tests/vault_tests.move`, which is not published. So no `Vault` can be
  created — and because `NoteTree`, `NullifierSet`, `DenomLadder` and both `BalanceBook`s are
  embedded **inside** the `Vault` by value, the entire runtime object graph hangs off it.
- **It bought a correction to our own architecture doc.** The shared-object set the app needs is
  **three** objects — `Vault`, `BatchRegistry`, `AdapterRegistry` — not the seven we had listed, plus
  one `Clearing` shared per batch. We had been wrong about our own object graph, and the failed
  publish is what surfaced it.

⚠ `aphotic::vault::Vault` declares **31** fields — *one* under the same cap. Adding two fields to the
vault breaks the publish the same way, silently, with the same uninformative error. That is now a
recorded tripwire rather than a surprise waiting to happen.

### The Seal identity was big-endian on both sides, and both were wrong together

`keeper/src/privacy/seal.ts` wrote the identity's `close_ms` with
`view.setBigUint64(offset, value, false)` — and `false` is `DataView`'s *little-endian flag*, so it
wrote **big-endian**. The v1 `vault.move` decoded it big-endian by hand, so the two agreed perfectly
and were both wrong. v2's policy parses with `bcs::peel_u64`, which reads **little-endian**.

Emit big-endian into that policy and the key servers simply decline, forever. **The batch never
reveals and there is no error anywhere to read.** It is the same silent class as Hashi's
byte-reversed deposit txid: wrong in exactly one direction, with no failure path that says so.

Two things fixed it properly rather than locally. One file owns the encoding (`sdk/src/seal/identity.ts`),
both sides import it. And the test pins it with **hand-derived** byte vectors, not with the encoder's
own output — an expectation built by the thing under test agrees with itself in either convention,
which is precisely how the v1 bug survived having tests. A gate now fails the build on a `<< 8`
decode in `batch.move`.

### 46 golden fixtures could not fail, because they inherited the constant they were checking

Three implementations of clearing, two price scales: `move/sources/clearing.move` and the keeper
engine were both `1e8`; `sdk/src/clearing.ts` was `1e9` (DeepBook's `FLOAT_SCALING`). That is the
divergence the spec calls a release blocker.

The interesting part is **why 46 hand-derived golden fixtures stayed green through it.** They never
passed a scale, so they silently adopted whatever `PRICE_SCALE` happened to be — re-pinning the
default instead of testing it. *A fixture that inherits the constant it is supposed to check cannot
fail when that constant is wrong.*

Fixed by making the scale explicit at every call site. The goldens now pin the algorithm's
**scale-independence**, which is a strictly stronger property, and the production constant is pinned
separately and directly against `aphotic::clearing::price_scale()`. Move is the authority — it is the
deployed contract, and `1e8` is sats-natural for an 8-decimal asset. (One rounding fixture block had
been tuned to divide exactly at `1e9`; it was passing by accident and had to be retuned.)

**The sequel is the point.** Fixing the fixtures was not enough, because 46 hand-written cases are
simply too narrow a net. It took a **third, independent implementation** — the Rust crate, written to
the spec rather than ported from either existing side — to find that Move and TypeScript disagree on
15 % of random books (§4). Two implementations that agree tell you they agree; they do not tell you
they are right. That is the same lesson as the endianness bug, one level up: an oracle built from the
things under test cannot referee them.

---

## 6. Honest limitations

Disclosing these is what makes the rest credible. They are also all in the product UI, not just here.

**`hBTC` is custodial-threshold wrapped BTC.** Threshold Schnorr across an opt-in, stake-weighted
validator subset, 2-of-2 with a Guardian enclave, and a ~60-day recovery leaf that is MPC-only after
its relative timelock — while coin selection has no age criterion, so the Guardian's protection has a
per-UTXO horizon. There is no Bitcoin light client on Sui; Hashi approves deposits by committee
attestation. Aphotic inherits **every one** of those assumptions. Our differentiation is composing the
bridge's on-chain machinery — never the token's trust model. Hashi is also pre-1.0 and upstream calls
it not production-ready, and the on-ramp is *refusable*: `approve_deposit` includes sanctions screening.

**Validator collusion: protocol floor 7, live testnet today 32.** Sui's per-validator voting-power cap
is `min(10000, max(1000, ceil(10000/n)))` = 10 % while n ≥ 10, so a 6 667 quorum needs at least **7**
colluding validators. Measured live on 2026-07-26: **112 active validators, total voting power 10 000,
and 32 of them taken largest-first to reach 6 667.** Always both numbers, always labelled — a bare 7
overstates the risk and a bare 32 overstates the guarantee.

**v1 note spends are LINKABLE.** The spec says spends publish a nullifier "without revealing which
leaf" — that is true only with a zero-knowledge membership proof. In v1 the Merkle path is supplied
**in the clear**, so the path index names the leaf. **v1 delivers uniformity, not unlinkability.**
Privacy comes from the crowd, not from the ladder, and the crowd does not exist at launch. The
commitment/nullifier machinery earns its keep by making the ZK tier a verifier swap on the same tree
and the same nullifier format — not by hiding anything today.

**We deployed the `hBTC` lending counterparty ourselves.** No hBTC lending market exists on Sui
testnet at all: Suilend, Navi and Scallop have no testnet deployment, and AlphaLend's markets are
testcoins plus SUI. Rather than fake the adapter and report a number nobody can check, we deployed a
genuine one and disclosed that we are the counterparty — including an on-chain `disclosure()` and a
coin description whose metadata cap was destroyed at publish so it cannot be edited away. **Any yield
figure from it is ours, not a market rate.**

**The carry is not executed in this version.** The DeepBook `hBTC/DBUSDC` pool exists and is correctly
typed, and it is **empty on both sides** — `pool::mid_price` aborts `EEmptyOrderbook`, and
`get_level2_range` returns zero levels, both confirmed live today. We can mint neither leg:
`hashi::treasury::mint` is `public(package)` and the DBUSDC `TreasuryCap` is address-owned. There is
nothing to buy and no observable price, so `carry.move` ships as a compiling, guarded interface and
the carry is **not mimed**. This is a deliberate scope decision, not an omission.

**The redemption leg is gated at signing, not by Move.** `request_withdrawal` sets
`sender: ctx.sender()` — the transaction *signer*, never the calling module — so a shared object can
never hold a queue position, and `cancel_withdrawal` asserts the same identity. That leg needs a real
signer, and the returning BTC lands at a Bitcoin address no Move code controls. The mitigation is a
Sui **2-of-2 multisig** (keeper + independent policy co-signer) that signs only for the pinned
address. It is enforced at signing. Move cannot do it, and we do not imply otherwise.

**NAV is not fully reconstructible, and we do not present it as such.** Every leg is on-Sui except
native BTC at the redemption address, which lives in the Bitcoin UTXO set. The mitigation is a cap
asserted in `approve_nav`: attribution to that leg can never exceed the sum of on-Sui-readable
`WithdrawalRequest.btc_amount` values that produced it. A Bitcoin header relay in Move would close
the gap and is roadmap, not dependency.

**If the spread vanishes, the venue is worth little.** If the Guardian's bucket is generously sized
and the queue clears in minutes, there is no discount to harvest. **Aphotic is closer to congestion
insurance than to a bridge, and it should be judged as such.** The live bucket today is on the order
of 100 BTC refilling ~100 BTC/day, which means an Aphotic-sized exit is *not* rate-limited — so we do
not write congestion copy. One structural point does run the other way: the limiter config lives in
the enclave's `InitConfig`, whose hash each key provisioner recomputes independently, so widening
throughput under stress requires a fresh ceremony. Congestion, once it starts, persists.

**Two-sided flow is the principal risk to the auction, and it is economic, not technical.**
Internalisation needs natural buyers, and exit flow is likely thicker than entry flow. The vault does
not depend on it, which is exactly why it ships first.

**Aphotic is not trustless.** It is no less trustworthy than the venue it serves. That is the honest
bar and the one we state.

### Known-incomplete at submission, stated plainly

| # | What | Consequence |
|---|---|---|
| 1 | The **v2 `aphotic` package is not published**, and the reason is on-chain, not procedural: `clearing::Clearing` has 39 fields against a 32-field verifier cap (§5). A second blocker sits behind it — the LP share coin module was never written, so no `Vault` can be created either. | Everything on-chain in the demo runs against the local suite plus the published `aphotic_lending`. The **L3 Move↔TS parity gate needs a published package** and is therefore still owed. Both blockers are diagnosed, bounded and single-file; neither is a design problem. |
| 2 | `scripts/measure-clearing.mjs` ran and reported **"NOTHING WAS MEASURED"** — the published package predates `clearing`. | `MAX_BATCH_SIZE = 256` is a **reasoned** default, not a measured one. The resumable cursor path exists from day one precisely so a measurement can lower it without a redesign. |
| 3 | Some of the keeper's CLI commands are **declared but not wired**; they exit **2** naming the module they need rather than exiting 0. | `schedule` `seal-id` `clear` `verify-limiter` run for real offline. A command that exits 0 having done nothing is how a demo fails without anyone noticing, so none does. Run `node dist/index.js --help` for the current split — the `!` marker is authoritative, not this table. |
| 4 | The tree was being written by several agents while this was measured. Between two passes ~40 minutes apart, keeper went **178 → 252** tests and app **152 → 157**; earlier `verify-all.ps1` runs showed **9 PASS · 3 FAIL**, all three `tsc` errors in files mid-write. The final run was **12 PASS · 0 FAIL · 0 SKIP**. | Every figure here is timestamped to 2026-07-26 and was re-measured at the end. **Re-run before quoting.** |
| 5 | **The Move ↔ TypeScript clearing parity claim fails** on 15 % of 4 000 seeded books, with five named divergences (§4). | This is the release blocker our own spec says it is, and it is **open**. Do not claim bit-identical parity anywhere. `clearing-rs/` is built and green at 79 tests and implements **both** engines on purpose, because a single engine could not have found this. |
| 6 | `clearing-rs/sim/` is standalone: **Hashi's own UTXO-pool simulator is not in this repo**, so the fragmentation leg is parameterised, not calibrated. Every emitted file carries `"calibrated_against_hashi_sim": false`. | Latency-model output is a shape, not a forecast. |
| 7 | `sui move build` emits **4 lint warnings** on a clean rebuild (`W99001` non-composable transfer to sender, 2× `W09014` unused `&mut`, `W02013` discarded return). Exit code is 0. `docs/DEPLOYED.md` records "zero warnings" from an earlier run of the same command; the tree moved. | Cosmetic; listed because "zero warnings" would have been the easy thing to copy. |
| 8 | `scripts/verify-onchain.mjs`'s 28 assertions still check the **v1 legacy** `aphotic` package and vault ids alongside the live Hashi/DeepBook/Pyth ones. | Its Hashi, DeepBook, config, event and Pyth assertions are current and load-bearing; its two `aphotic` rows are historical. |

---

## 7. What comes next

**First, before anything else: resolve the five clearing divergences (§4).** D1 (the fill-leaf layout)
is mechanical — pick one layout and regenerate. D3 (dust folded into the fee) is a one-line decision
about where the residual lives. D2 and D4 are genuine design questions that need a human to answer,
not a patch: whether an overfull price level fills greedily or pro-rata, and whether one under-funded
account may move the uniform price for everyone. Our reading is that pro-rata (D2) and
truncate-after-pricing (D4) are correct, because both keep the price a function of *intent* rather
than of *funding* — but that is a decision to make deliberately and record, and the Rust crate keeps
both engines until it is made. Then turn L3 on, because L3 is what stops this recurring.

**Then, in this order, because the deployment blockers are sequential** — (1) group seven of
`Clearing`'s correlated scalars into a nested `has store` struct, which costs one field each and gets
it to 32; nested structs do not inherit the parent's field count. (2) Write the LP share coin module
so `vault::create` has a `TreasuryCap` to consume. (3) Publish, and record both `published-at` and
`original-id` in `docs/DEPLOYED.md` — a `moveCall` targets the first, type strings and old events
resolve against the second. (4) Re-run `scripts/measure-clearing.mjs` so `MAX_BATCH_SIZE` becomes a
measured number. (5) Turn on the L3 Move↔TypeScript parity gate against the live package. (6) Wire the
six remaining keeper commands. And (7) add a publish dry-run to `verify-all.ps1`, because the whole
lesson of §5 is that no local step covers it.

**Phase 2, the carry** — needs the 2-of-2 custody multisig with a policy co-signer, and a latency
model calibrated against Hashi's own 1 442-line UTXO-pool simulator. Deliberately not attempted in a
hackathon window: the multisig and the latency model are where the time goes, and a carry sized off a
point estimate rather than a distribution is how the tail kills you.

**Phase 4, hardening** — three independent items. A Groth16 membership circuit turns v1's
*uniformity* into *unlinkability* as a verifier swap on the same tree; compatibility is **unverified**
and gated on a spike, because `sui::groth16` caps public inputs at 8, wants little-endian scalars and
returns `bool` rather than aborting, and a SNARK-friendly hash makes blake2b256 → Poseidon a tree
migration. A PCR-gated Seal policy replaces the time-lock so only an attested enclave ever decrypts,
closing both stated confidentiality limits with no contract change. And a Bitcoin header relay in
Move closes the one NAV leg that is not Sui-verifiable.

**Before mainnet** — the Seal committee question has to be answered rather than deferred. Mainnet
decentralized Seal currently requires an Enoki-issued API key, and Enoki is both a zkLogin salt
provider and a key server; using it for both hands one party identity linkage *and* a decryption
share, which our own rule forecloses. On testnet the rule holds by construction. On mainnet the
options are: run our own key servers alongside independent operators, accept an Enoki key for
transport only *after verifying it confers no share*, or go straight to the PCR-gated policy that is
the planned upgrade anyway.

---

## 8. Where to look in the repo

| Path | What |
|---|---|
| `move/sources/batch.move` | the sealed batch, `next_boundary`, and the `seal_approve` time-lock |
| `move/sources/clearing.move` | uniform-price clearing, cursor-driven settlement, `verify_fill` |
| `move/sources/vault.move` | the async request/settle vault and the two-party `approve_nav` |
| `move/sources/notes.move` | the ladder, the Merkle tree, the nullifier set |
| `sdk/src/clearing.ts` · `sdk/src/seal/identity.ts` | the single home of every cross-language byte format |
| `sdk/fixtures/clearing.golden.json` | the 46 shared cases, consumed by both languages |
| `lending/sources/lending.move` | our own counterparty, with the disclosure returned on-chain |
| `scripts/gates.sh` · `scripts/gates.ps1` | the twelve invariants a comment cannot enforce |
| `docs/DEMO.md` | the runbook, the live-vs-pre-staged table, and the fallback |
| `docs/STATUS.md` | the per-unit ledger and the open blockers |
| `aphotic.md` | the spec of record |
| `docs/GOVERNANCE.md` | capabilities, the NAV split, and §9 deviations of record |
