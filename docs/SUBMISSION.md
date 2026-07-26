# SUBMISSION — Aphotic

**Confidential batch clearing and redemption carry for native Bitcoin on Sui.**
ETHGlobal Lisbon 2026 · Sui track · Sui **testnet**, Bitcoin **signet**. Not audited.

> Every number in this document was produced by running the command printed next to it on
> **2026-07-26**, on the tree as it stood at the time of writing, and every on-chain id was read
> back with `sui client object`. Where something was in flight, it says so. Nothing here is quoted
> from a summary — and where a figure could not be verified, it was **removed** rather than softened.

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

That run, on 2026-07-26, returned **35 PASS · 0 FAIL · 0 WARN · 5 INFO**, including 25 live
`WithdrawalRequested` / `WithdrawalApproved` rows with a latest envelope timestamp of
`2026-07-26T06:37:26.319Z` — a minute old when the command returned. It also read `hBTC`'s total
supply straight off chain: **28 392 033 023 sats (283.92 BTC)** in circulation. The bridge is live
and carrying real traffic.

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

Everything in this table was read back with `sui client object <id>` on **2026-07-26**, not
transcribed from a deployment log.

### The `aphotic` package — published, then upgraded, so there are now **two** ids

| | Id | What it is for |
|---|---|---|
| **`published-at`** | `0x653a81289672661facacae1b7740b333afc7c6a88198d38b916c20b14e855c55` | **a `moveCall` targets this.** On chain: `objType: package`, `version: 2`, `Immutable`, `prevTx` `GVMNWL56qNMR4WRSafnwfBaAFS3aSYvTjXuySFQowx6i` (the upgrade). |
| **`original-id`** | `0xfa214c431cee927137422f042ed679eb6180c226d30fa3e98c6bea9e09597df2` | **type arguments, type-string checks and event type strings resolve here forever.** On chain: `version: 1`, `Immutable`, `prevTx` `DLW43Kvc8czoiWAfxWXomuHXmT7Cuysp5bSnkmsHBuhH` (the publish). |
| `UpgradeCap` | `0x12b8e8d6b4a49ac3027e5a3c2b33f9e9c8609254b5baa676dbb47ef41674c277` | `AddressOwner` to the deployer; its `package` field now reads `0x653a8128…` and its `version` reads `2` — which is the receipt that the upgrade happened. |

Both ids live in `move/Published.toml` and are wired as **two separate variables** in
`keeper/.env` (`APHOTIC_PACKAGE_ID` / `APHOTIC_ORIGINAL_PACKAGE_ID`) and `app/.env.local`
(`VITE_APHOTIC_PACKAGE_ID` / `VITE_APHOTIC_ORIGINAL_PACKAGE_ID`). Checking a vault's type against
`published-at` was correct on the day of the publish and has been wrong ever since — which is
precisely why `scripts/verify-onchain.mjs` asserts type origin against the **original**.

### The runtime object graph — live

| What | Where | State |
|---|---|---|
| shared `Vault<BTC, DBUSDC, APHOTIC_LP>` | `0x91660fb483ec6c8ee4f9c2b4be04872b5808955fdcda962b5be5905989b3efcf` | `Shared`, isv `953314532`. Its full type resolves against the **original** id, over `0xfcea10ca…::btc::BTC`, `0xf7152c05…::DBUSDC::DBUSDC` and `0xfa214c43…::aphotic_lp::APHOTIC_LP`. |
| shared `BatchRegistry` | `0x9967881e88d5e22fc790d3b761e8ca55c8fd87d1a07baa11eb4a4352cd356b35` | `Shared`, isv `953314533`. Reads back `cadence_ms 43 200 000` · `offset_ms 21 600 000` · `submit_cutoff_ms 60 000` · `reveal_grace_ms 600 000` · `max_batch_size 256` · `policy_version 1`. The cadence constants are not a doc claim; they are fields you can read. |
| shared `AdapterRegistry` | `0x216b878d592129d6c5ce7c5c2b1f72d77cef8ed852db5934cb5a559a2eec29ca` | `Shared`, isv `953314534`, empty |
| `AdminCap` / `KeeperCap` | `0x3bb58bd5…` / `0xcfbdfc8d…` | live; type origin asserted against the original id by `verify-onchain.mjs` |
| the front-end | `https://aphotic-taupe.vercel.app` | deployed; `/` `/vault` `/batch` `/verify` `/docs` each returned **200** |

There are **three** shared objects, not seven. `NoteTree`, `NullifierSet`, `DenomLadder`,
`CapRegistry` and both `BalanceBook`s are embedded in `Vault` **by value** — they are struct fields
and have no object id, ever.

### The lending counterparty — a second package, also live

| What | Where | State |
|---|---|---|
| `aphotic_lending` package | `0x39d038aea02ccc0bd25e97c7f1a715e87dd6ccae19b0bf9ac255379634b6ea8c` | **live**, `version: 1`, `Immutable`. An `UpgradeCap` is `AddressOwner` to the deployer, so a *new version* could be published — the bytecode at this id can never change. |
| shared `Market` | `0x220ba0e51d56600d90c967cf523a54b6a4a48c62384810d5d89b0b884b066677` (isv `953314524`) | live, and **empty** — read off chain today: `cash 0`, `total_borrows_sats 0`, `protocol_reserves_sats 0` |
| share coin | `<pkg>::lending::LENDING`, symbol `aLhBTC`, 8 decimals | the metadata cap was **destroyed at publish**, so the coin description — which *is* the disclosure — can never be edited away. |
| publish tx | `3PCybDwuxCCxEace2zSrNutPRSNvEKAazPZjbKPTqnJZ` | success |
| Hashi (not ours) | package `0xfcea10ca…`, shared `Hashi` `0x22c0ce66…` | live, real traffic |

We deployed the lending counterparty ourselves and say so on-chain — see §6.

---

## 4. What is verified, and how you verify it without us

Run these yourself. The figures are what they printed on 2026-07-26.

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"       # sui is not reliably on PATH

cd move    && sui move build                     # exit 0, zero warnings on a clean rebuild
cd move    && sui move test                      # Total tests: 283; passed: 283; failed: 0 · 11 modules
cd lending && sui move build && sui move test    # Total tests:  37; passed:  37; failed: 0
cd sdk     && npm test                           # 15 files · 376 tests
cd keeper  && npm test                           # 16 files · 252 tests
cd app     && npm test                           # 18 files · 327 tests (fully offline)

bash scripts/gates.sh                            # the 12 invariant gates
powershell -NoProfile -File scripts/gates.ps1    # must agree, verdict for verdict
node scripts/verify-onchain.mjs                  # 35 PASS · 0 FAIL · 0 WARN · 5 INFO (needs network)

powershell -NoProfile -File scripts/verify-all.ps1   # the master gate — 12 steps
```

```bash
export PATH="$HOME/.cargo/bin:$PATH"             # cargo is installed but not on the default PATH
cd clearing-rs && cargo test                     # 79 passed, 0 failed (47 + 11 + 9 + 7 + 5)
```

**Total: 283 Move + 37 lending + 376 SDK + 252 keeper + 327 app + 79 Rust = 1 354 tests, all green**
on 2026-07-26, plus 12 structural gates that agree verdict-for-verdict across `bash` and PowerShell.

Move tests per test module, counted from a single `sui move test` run: `allocate_tests` **51** ·
`oracle_tests` **47** · `batch_tests` **42** · `vault_tests` **35** · `notes_tests` **32** ·
`balance_tests` **25** · `clearing_tests` **24** · `caps_tests` **24** · `aphotic_lp_tests` **3** =
**283**. (Counts printed by the *positional filter* — `sui move test vault` — do not add up to 283,
because the filter matches test names and several modules share words.)

⚠ **The gates were `13 PASS · 0 FAIL · 0 SKIP` at 08:37 and `13 PASS · 0 FAIL · 0 SKIP` at 08:55**,
and both readings are honest. A scratch file `scripts/.probe.mjs`, dropped into the tree by another
process between the two runs, carries a literal `hBTC` coin type, and the `ids` gate fails it —
correctly, because a canonical id hardcoded outside its six declared homes is a fail regardless of
who wrote it or why. The master gate reports whatever is in the tree at that second; **re-run it
rather than quoting this paragraph.** All eleven other gates, all ten test steps and
`verify-onchain.mjs` passed in the same run.

### The gates are the interesting part

A test proves the code does what the test says. A gate proves the code *cannot* do something a
comment merely asks it not to. There are twelve, and — this matters — **`SKIP` is counted separately
from `PASS`**, so a gate can never look green because the thing it guards has not been written yet.
The paragraph above is the demonstration: the one gate that failed today failed because it caught
something real, not because it was mis-scoped.

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

⚠ **Measured honestly, and re-measured on 2026-07-26 at 06:5x UTC — still true:** this exits 0 and
returns an **empty trajectory** (`samples: []`, `finalQueueDepth: "0"`), because the replay finds no
events in its lookback window. It then falls back to the `1000 / 100_000_000` sats prior, which is
roughly 100× off the live Guardian scalars (`115_740 / 10_000_000_000`) — and the fallback prior is
printed in the output rather than hidden, so you can see that it is a prior. The algorithm and its
golden vectors are pinned by tests in both languages; the *live* replay is not currently producing a
trajectory. **Do not demo this command without checking it first.**

### The clearing engine runs locally, right now

```bash
cd keeper && node dist/index.js clear < orders.json
```

Real output, this tree, one crossing pair at 1.0 bid / 0.9 ask with a 10 bps fee (the command emits
JSON; the fields are quoted here in the order they appear):

```
"clearingPrice":   "90000000"      (PRICE_SCALE = 1e8, == aphotic::clearing::price_scale())
"matchedBaseSats": "1000000"
"quotePaid":       "900000"        the bid pays  ceil
"quoteRecv":       "899100"        the ask keeps floor, minus the fee
"feeQuote":        "900"           900_000 == 899_100 + 900, exactly — the fee is an explicit
                                   third term, never a silent shortfall
"totalDebits":     "1900000"   ==  "totalCredits": "1900000"
"fillsRoot":       0x743f30daebc580a11d32c71c1604457d42048f6762dea352ee9605b9f3911ce8
"candidates":      ["90000000", "100000000"]
```

### ⚠ And the parity claim currently FAILS — we found it, and we are not going to bury it

`aphotic.md` §9 says a divergence between clearing implementations is a **release blocker**. We wrote
a **third** implementation in Rust specifically to test that claim, reading the same
`sdk/fixtures/clearing.golden.json` in place. It found that `clearing.move` and the TypeScript **are
not the same algorithm.**

The seeded census, re-run on 2026-07-26 (`cargo test --test divergence divergence_report --
--nocapture`), still prints:

```
  books swept                             4000
  clearing price differs                  0
  matched base differs                    0
  per-order allocation differs   [D2]     97
  fee total differs              [D3]     516
  fills root differs (non-empty) [D1]     2406
  agree on price+matched+alloc+fee        3407
```

**Full agreement on 3 407 of 4 000 (85 %).** The TypeScript, the 46 fixtures and the Rust spec engine
all agree with each other; it is **Move** that differed — and Move is what settles.

⚠ **That census measures package v1.** The Rust `engine.rs` is the twin of the *first* publish and
says so in its own banner; it has not been re-pointed at the upgraded code. So read the table below
as the diagnosis, and the paragraph after it as the current state.

| # | Divergence | Frequency / consequence, as measured against v1 |
|---|---|---|
| D1 | **Fill-leaf layout.** Move's `bcs(Fill)` is 73 bytes (`batch_id`, no `fee`); the spec's is 81 (`fee`, no `batch_id`, `u128` price). | 2 406 of 4 000. The two Merkle roots can **never** match for a non-empty fill set. This alone makes byte-comparison meaningless. |
| D2 | **Allocation.** Move filled an overfull strictly-inside level **greedily**; the spec **pro-rates** it. Bids 60@10 + 60@10 against ask 50@5 → Move gave 50/0, the spec gives 25/25. | 97 of 4 000 (2.4 %). Two participants at the same price got different fills. |
| D3 | **Fee.** Move folds rounding dust into the fee; the spec keeps them separate — asserted exactly as `move.fee == spec.fee + spec.dust`. | 516 of 4 000 (**12.9 %**) — the most frequent and the least visible. |
| D4 | **Truncation timing.** Move truncated at *load*, before price discovery, so one under-funded account **moved the uniform clearing price** for everyone. Counterexample cleared at 10 on Move and 12 on the spec. | A design question, not a rounding one. |
| D5 | **Price width.** `u64` in Move, `u128` in the spec. One fixture is not expressible against Move at all. | |

### What the v2 upgrade changed, and what it did not

**D2 and D4 are closed, in the spec's favour, by upgrading the package** — `published-at`
`0x653a8128…`, upgrade tx `GVMNWL56qNMR4WRSafnwfBaAFS3aSYvTjXuySFQowx6i`. The deployed
`clearing.move` now declares `STAGE_TRUNCATE`, `STAGE_REALLOC_FULL`, `STAGE_REALLOC_PRORATA` and
`STAGE_REALLOC_REMAINDER` as distinct stages, which is the change made visible in the API.

- **D2 → pro-rata.** Two bids of 60 at par against an ask of 50 now fill **25/25**, not 50/0. This
  was never a rounding preference. Greedy allocation put a *first* inside a batch whose entire pitch
  is that it has none — it made the product's central claim false. Pro-rata is what makes *"uniform
  price does not make front-running hard, it makes it meaningless"* true.
- **D4 → truncate after pricing.** An under-funded account can no longer move the uniform clearing
  price for everyone; it can only reduce its own fill, with the counterparty re-rationed
  symmetrically by the same rule. It was a manipulation lever at near-zero cost: submit an order you
  cannot fund, move everyone's price.

**D1, D3 and D5 remain open, and the parity claim must still NOT be made.** Those three are
*conventions* rather than behaviours — the fill-leaf layout, whether rounding dust folds into the
fee, and `u64` vs `u128` price width — and the clients follow Move on all three. But D1 alone means
the two Merkle roots can never match for a non-empty fill set, so byte-for-byte parity is still
false today. What changed is that the two divergences which *weakened the product* are gone; the
three that remain are bookkeeping differences to align at leisure.

**Which side is right was a human decision, not a mechanical one.** D2 and D4 were genuine design
choices, which is why the Rust crate deliberately implements **both** engines rather than picking a
winner — and why the decision, once taken, is recorded in `docs/DESIGN-V2.md` rather than quietly
patched. What is not optional is saying so: *a parity claim that has not been checked is a guess, and
one that has been checked and failed is a bug.* Two of the five are now fixed; three are open.

The same pass found that §5bis(d) of our own design doc **miscounts its own byte layout** — it says
"= 73 bytes" for a field list that sums to 81; the code is right and the prose was wrong.

So the honest state of the three parity levels is: **L1** 46 shared fixtures — green, and now known
to be too narrow to catch this. **L2** 10 000 seeded property cases — green, but they assert
*structural invariants*, not cross-implementation equality. **L3**, the real gate — `devInspect`
byte-for-byte — is owed. The package is now published, so the blocker is no longer the deployment;
it is D1, and L3 would fail on it today.

---

## 5. Three things that went wrong, and what they cost

These are here because they show the engineering rather than assert it. The first is the one that
stopped the deployment for an afternoon; it is **resolved** — the package is published and upgraded —
and it is kept in full because the trap is invisible locally and costs an hour to re-derive.

### `sui move build` does not run the verifier that actually decides — a green package, unpublishable

The package built clean and passed its whole suite. `sui client publish` was rejected by the
validator:

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

**How it was fixed:** `Clearing`'s correlated scalars were grouped into nested `Pricing` and
`Allocation` structs — a nested `has store` struct costs the parent **one** field and does not
inherit its count — which brought it under 32. The republish succeeded.

Two things this cost, and one it bought:

- **The lesson: a local green build is not evidence a package can be deployed.** `sui move build`
  runs the Move bytecode verifier; the *Sui object verifier* runs only on a validator. Nothing in the
  local toolchain covers the gap, and the tool that would have is unimplemented. Gate publishes on
  `sui client publish --dry-run`, which is the only local step that catches it.
- **A second, independent blocker was found while sequencing the runtime objects**, and it bit
  immediately after the first was fixed: `vault::create` consumes a `TreasuryCap<S>` by value
  and asserts `total_supply == 0`, but the package **defined no LP share coin**. The spec calls for
  `Coin<APHOTIC_LP>`; that module had never been written. The only `S` that existed was `APLP`,
  declared `#[test_only]` inside `move/tests/vault_tests.move`, which is not published. So no `Vault`
  could be created — and because `NoteTree`, `NullifierSet`, `DenomLadder` and both `BalanceBook`s
  are embedded **inside** the `Vault` by value, the entire runtime object graph hung off it.
  **Closed** by adding `move/sources/aphotic_lp.move` with the standard one-time-witness shape, 8
  decimals to match sats, so `init` mints the cap at publish time. It is the eleventh module and
  carries its own three tests.
- **It bought a correction to our own architecture doc.** The shared-object set the app needs is
  **three** objects — `Vault`, `BatchRegistry`, `AdapterRegistry` — not the seven we had listed, plus
  one `Clearing` shared per batch. We had been wrong about our own object graph, and the failed
  publish is what surfaced it.

A third rejection followed the two above and is worth one line, because it is a PTB shape rather
than a bug: `vault::create` returns a `Vault` **by value**, which must be shared in the *same*
transaction, and `sui client call` cannot chain. It was done with
`sui client ptb --move-call … --assign v --move-call …::share v`.

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
colluding validators. Measured live on 2026-07-26, at **epoch 1172**: **112 active validators, total
voting power 10 000, largest single validator 515 (5.15 %), and 32 of them taken largest-first to
reach 6 667.** Always both numbers, always labelled — a bare 7 overstates the risk and a bare 32
overstates the guarantee. And note the floor is a *protocol* property while the 32 is a *snapshot*:
it moves with the validator set, so re-measure it rather than quoting this line.

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
| 1 | **The Move ↔ TypeScript clearing parity claim still fails.** D2 and D4 were closed by the v2 upgrade; **D1, D3 and D5 are open** (§4). | Do not claim bit-identical parity anywhere. D1 alone — 73-byte vs 81-byte fill leaves — means the Merkle roots can never match for a non-empty fill set, so the **L3 `devInspect` gate would fail today**. `clearing-rs/` is built and green at 79 tests and implements **both** engines on purpose, because a single engine could not have found this. |
| 2 | `scripts/measure-clearing.mjs`, re-run today against the **live** package, still reports **"NOTHING WAS MEASURED"** — but for a new reason. It now finds the `clearing` module and sees **44 functions**; what it does not find is `sort_step` / `price_step`, because the shipped state machine is a single budgeted `step`. The script targets names that no longer exist. | `MAX_BATCH_SIZE = 256` remains a **reasoned** default, not a measured one — and the on-chain `BatchRegistry` does read back `max_batch_size: 256`, so the *value* is confirmed while the *justification* is not. The resumable cursor path exists from day one precisely so a measurement can lower it without a redesign. |
| 3 | `clearing-rs/engine.rs` is the twin of package **v1**, not of the deployed v2 — its own banner says so. | The 4 000-book divergence census in §4 measures v1. It has not been re-run against the upgraded code, so treat the D2 frequency (97 books) as historical. D1, D3 and D5 are unaffected by the upgrade. |
| 4 | The tree is being written by several agents while this is measured. The `ids` gate went from **PASS** to **FAIL** inside twenty minutes because a scratch file appeared under `scripts/`. | Every figure here is timestamped to 2026-07-26 and was re-measured at the end of the pass. **Re-run before quoting.** |
| 5 | `clearing-rs/sim/` is standalone: **Hashi's own UTXO-pool simulator is not in this repo**, so the fragmentation leg is parameterised, not calibrated. Every emitted file carries `"calibrated_against_hashi_sim": false`. | Latency-model output is a shape, not a forecast. |
| 6 | `keeper verify-limiter` runs, exits 0, and returns an **empty trajectory** against the live event stream. | The algorithm is pinned by golden vectors in two languages; the live replay is not currently producing rows. Stated in §4 and again here, because it is the one command whose output could be mistaken for a result. |
| 7 | The vault, the batch registry and the adapter registry are **live and empty**. Nothing has been deposited, no batch has been opened (`next_batch_id: 0`, `live_batches: 0`). | The on-chain machinery is real and callable; it has not yet carried a user. |

---

## 7. What comes next

**First, before anything else: close the three remaining clearing divergences (§4).** Two of the
five are already done, and they were the two that mattered most — the v2 upgrade made allocation at
an overfull marginal level **pro-rata** (D2) and moved truncation to **after** price discovery (D4),
because both keep the clearing price a function of *intent* rather than of *funding*. That decision
was made deliberately and recorded in `docs/DESIGN-V2.md` rather than patched quietly.

What remains is bookkeeping, and it is mechanical rather than architectural. **D1** — pick one
fill-leaf layout, 73 bytes or 81, and regenerate both sides. **D3** — decide in one line whether
rounding dust folds into the fee or lives beside it. **D5** — `u64` or `u128` price width. The
clients follow Move on all three today, so the work is to make the *spec* and the *fixtures* agree
rather than to change the deployed contract. Then turn L3 on, because L3 is what stops this
recurring — and re-point `clearing-rs/engine.rs` at the upgraded package, so the census measures
what is deployed rather than what used to be.

**Then, in this order** — (1) re-run `scripts/measure-clearing.mjs` against the *shipped* function
names (`step`, not `sort_step` / `price_step`) so `MAX_BATCH_SIZE` becomes a measured number rather
than a reasoned one. (2) Turn on the L3 Move ↔ TypeScript parity gate against the live package,
which is now possible for the first time. (3) Add a publish dry-run to `verify-all.ps1`, because the
whole lesson of §5 is that no local step covers it. (4) Open the first batch and carry a deposit end
to end, because the object graph is live and empty.

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
