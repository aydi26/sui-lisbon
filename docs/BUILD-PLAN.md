# BUILD-PLAN.md — ordered work units for Aphotic v2

> Purpose: the sequence in which the v2 product gets built, with dependencies, acceptance criteria
> and an exact VERIFY command per unit. Execute top-to-bottom; do not reorder across the CUT LINE
> without a written reason.
> Read after: `aphotic.md` §11, `docs/DESIGN-V2.md`, `docs/MOVE-PACKAGE.md`, `docs/FACTS.md`.
> Current state of each unit: **`docs/STATUS.md`** — this file says what to do, that file says what
> is done.
>
> **Rewritten 2026-07-26 for the v2 product.** The v1 plan (T0.x–T5.3, the DeepBook market-making
> vault) is void. Its task ids appear in this repo only inside `scripts/` banners that have not been
> reworked yet.

---

## 0. The ordering principle, and the unit-id scheme

`aphotic.md` §11 fixes the order and the reason: **each step de-risks the next.** The vault does
not depend on two-sided flow, so it ships first and is a product on its own; the auction is the
differentiator but needs a market.

**Unit ids are `P<phase>.<module>`** — `P1.vault`, `P3.batch`, `X.sdk` for cross-cutting work.

⚠ **The banners already on disk are inconsistent** with each other: `caps.move` says `@task T1.1`,
`notes.move` says `T3.1`, `allocate.move` says `P1.allocate`, `lending.move` says `P1.lending`.
Both forms are accepted; the mapping is in the tables below. **New files use `P<phase>.<module>`.**
Normalising the existing banners is unit `X.banners` and is low priority — a banner that is
internally correct and cites the right spec anchors is doing its job whichever id form it uses.

---

## Phase 0 — validation (no Move)

| Unit | What | Status |
|---|---|---|
| `P0.demand` | Confirm with liquidity partners that intent leakage on `hBTC` blocks is a real cost. | **not a coding task.** Owner: build lead. |
| `P0.discount` | Measure the `hBTC`/BTC discount once mainnet liquidity exists. **If the discount is persistently below the hurdle, the carry does not work and the auction has no anchor.** | **cannot be done on testnet** — the book is empty on both sides. Logged, not blocking. |

Phase 0 is stated because `aphotic.md` §11 states it, and because pretending it is done would be
the exact dishonesty G2 forbids. It does not gate the code.

---

## Phase 1 — the vault

**AC for the phase:** deposits, shares, the two-party NAV cycle and idle allocation work end to
end, with no carry and no auction. This alone is a shippable product.

| Unit | Files | Depends on | Acceptance criteria | VERIFY |
|---|---|---|---|---|
| `P1.events` (banner `T1.0`) | `move/sources/events.move` | — | package leaf; one emitter per externally-visible transition; the three ceilings recorded in `@facts`; per-fill emission deliberately absent and justified | `cd move && sui move build` |
| `P1.caps` (banner `T1.1`) | `move/sources/caps.move`, `move/tests/caps_tests.move` | `P1.events` | three caps and no fourth; `AdminCap`/`KeeperCap` `key`-only, `VaultCap` `store`-only, `CapRegistry` `store`-only; two-step admin handover; epoch-bound rotation; `assert_keeper_action` exhaustive; `MAX_ALLOWLIST = 32`; **`arm_unpause` + delay** | `cd move && sui move test caps` |
| `P1.allocate` | `move/sources/allocate.move`, `move/tests/allocate_tests.move` | `P1.events` | leaf — imports no `aphotic` module and no lending package; adapter identified by the **pair** `(type A, venue ID)`; per-venue caps; **recall never gated by pause or disable**; `mark` the only path for yield | `cd move && sui move test allocate` |
| `P1.lending` | `lending/sources/lending.move` + tests | `hashi` (type only) | supply/borrow market for hBTC; `disclosure()` returns the honesty text **on-chain**; `is_collateralised()` and `has_liquidations()` both `false`; **zero borrowers ⇒ `accrue` provably adds zero**; reserve factor cuts interest, never principal | `cd lending && sui move test` |
| **`P1.vault`** | `move/sources/vault.move`, `move/tests/vault_tests.move` | `P1.caps`, `P1.allocate`, `P3.balance` | async request/settle; `Coin<APHOTIC_LP>` fungible shares; **`approve_nav` in the O(1) 10-step form**, digest-bound, never iterating requests; `committed_supply` as the solvency denominator; round-DOWN `mul_div` recomputed per receipt; **`request_redeem`/`claim_redeem` ignore the pause** | `cd move && sui move test vault` |

**`P1.vault` is the largest single unit in the plan and the one with the most traps.** Read
`docs/DESIGN-V2.md` §6 and `docs/MOVE-PACKAGE.md` §10 before writing a line of it. The three that
bite: the digest check (a keeper must not be able to swap the proposal in a race), `committed_supply`
(not `coin::total_supply` — it undercounts owed-but-unminted shares and would let an over-mint
pass), and step 4's price-deviation check, which **must tolerate "no mid exists" as a defined
state** because the book is empty.

---

## Phase 2 — the carry: **DELIBERATELY NOT EXECUTED**

`aphotic.md` §11 is explicit: *"Do not attempt Phase 2 in that window — the multisig and the latency
model are where the time goes."* `docs/DESIGN-V2.md` **D6** agrees, and D2 and D3 each independently
confirm it.

| Unit | Files | What lands | What does NOT land |
|---|---|---|---|
| `P2.oracle` (banner `T2.1`) | `move/sources/oracle.move`, `move/tests/oracle_tests.move` | **the full model**: byte-exact limiter replay, the attested queue observation with its consistency checks, and a wait-time **distribution** with an explicit `unbounded_ms()` sentinel | — it is complete |
| `P2.carry` | `move/sources/carry.move` | the three pure guard predicates — value-preservation floor, pinned-address equality, carry hurdle — real and tested | **any execution path.** The module touches no DeepBook, no Hashi, no `Balance<BTC>`, no shared object |
| `P2.custody` | — | — | the 2-of-2 custody multisig and the policy co-signer. An **ops project**, not code |
| `P2.sim` | — | — | the Rust `sim/` latency calibration against upstream's pool simulator |

**VERIFY:** `cd move && sui move test oracle` · `cd move && sui move test carry`.

**Do not "finish" Phase 2 because it looks close.** A carry wired against a book with no mid is not
an implementation; it is an untested branch, and it would be the one branch handling real money.

---

## Phase 3 — the auction

**AC for the phase:** an order encrypted client-side under a time-lock policy is submitted with no
size on chain, the batch closes mechanically, anyone reveals, the uniform price is computed
**on-chain**, settlement pushes fills, and the TypeScript twin reproduces the result **byte for
byte**.

| Unit | Files | Depends on | Acceptance criteria | VERIFY |
|---|---|---|---|---|
| `P3.notes` (banner `T3.1`) | `move/sources/notes.move`, `move/tests/notes_tests.move` | `P1.caps` | `Note` has **no amount field**; ladder append-only, `MAX_TIERS = 8`; domain-separated blake2b256; **leaf index LITTLE-ENDIAN**; append = 20 in-object hashes / **zero** dynamic-field entries; spend = **one** table entry; `MAX_SPENDS_PER_TX = 800` | `cd move && sui move test notes` + `gates.ps1 notes` |
| `P3.balance` (banner `T3.2`) | `move/sources/balance.move`, `move/tests/balance_tests.move` | `P1.caps` | escrow custody **separate from vault NAV** (F3/D7); the conservation identity asserted after every op; **no `reserve`/`lock` primitive** — an order draws, it does not reserve; `has_at_least` for the truncation check; debit/credit emit nothing, custody crossings always emit | `cd move && sui move test balance` |
| **`P3.batch`** | `move/sources/batch.move`, `move/tests/batch_tests.move` | `P3.notes`, `P3.balance`, `X.sdk` | monotonic state machine; `next_boundary` with `cadence 43_200_000` / `offset 21_600_000`; `open_batch` takes **no timestamp**; `close_batch` reverts before `close_ms`, succeeds at exactly `close_ms`; a **full batch does not close early**; `SUBMIT_CUTOFF_MS`/`REVEAL_GRACE_MS`; commitment binds the **plaintext**; **`seal_approve` LITTLE-ENDIAN, leftovers empty, policy_version checked, NO sender check, denies by abort** | `cd move && sui move test batch` + `gates.ps1 batchstate` |
| **`P3.clearing`** | `move/sources/clearing.move`, `move/tests/clearing_tests.move`, `move/tests/clearing_golden_tests.move` (generated) | `P3.batch`, `X.sdk` | the six clearing rules exactly as `docs/FACTS.md#clearing`; **integer only**; limit safety asserted **per fill**; quote rounding toward the vault; fee an explicit third term; **deterministic truncation of under-funded fills from the frozen snapshot**; push not claim; `verify_fill`; **`compute_for_inspect` pure** | `cd move && sui move test clearing` |
| `P3.seal` | app + keeper Seal integration | `X.sdk` | encrypt client-side under the inner id; committee of **5 operators, t = 3**, health-probed; **refuse to open a batch below `t` live**; **never fall back to plaintext** | keeper test + a live dry run |
| `P3.walrus` | app + keeper | — | ciphertext to Walrus; `blob_id` on chain so a third party can *find* it; lifetime set explicitly and long | keeper test |

---

## Phase 4 — hardening. Gate on a spike, not a plan.

| Unit | What | Blocking unknown |
|---|---|---|
| `P4.groth16` | replace `MembershipWitness` with a Groth16 verification — **the only thing that changes**; the tree, the commitment, the nullifier and `spend`'s signature all stay | **U-G, unverified.** `sui::groth16` caps public inputs at **8**, takes 32-byte **little-endian** scalars and Arkworks canonical-compressed VKs, and `verify_groth16_proof` returns `bool` — **it does not abort**, so the v1 "deny by abort" habit is wrong there. A SNARK-friendly hash makes blake2b256 → Poseidon a **tree migration** |
| `P4.pcr` | swap the time-lock policy for a **PCR-gated** policy so only an attested Nautilus enclave ever decrypts. Order format, Seal integration and settlement contract are **unchanged** — this is why it is deferred rather than designed around | — |
| `P4.relay` | a Bitcoin header relay in Move (permissionless submission, cumulative-work fork choice, Merkle inclusion) to close the H4 NAV gap | roadmap, **not a dependency** |

---

## Cross-cutting units

| Unit | Files | Acceptance criteria | VERIFY |
|---|---|---|---|
| **`X.sdk`** | `sdk/src/{clearing,merkle,seal/identity,cadence}.ts`, `sdk/fixtures/clearing.golden.json`, `sdk/package.json` | **the single implementation** of clearing, the Merkle tree, the Seal inner id and the limiter. No build step: `"exports": { "./*": "./src/*.ts" }`, consumed via `keeper/tsconfig.json` `paths` and `app/vite.config.ts` `resolve.alias`. A generator emits `move/tests/clearing_golden_tests.move` from the **same** JSON | `cd keeper && npm test -- clearing` |
| `X.parity` | `keeper/test/clearing.parity.test.ts`, `keeper/test/clearing.moveparity.test.ts` | L1 fixtures (all 12 named cases incl. **under-funded truncation**) · L2 property test, 10 000 seeded cases · **L3 `devInspect` BCS byte-for-byte**. A mismatch prints the failing set as a new fixture and fails | `cd keeper && npm test -- parity` |
| `X.measure` | `scripts/measure-clearing.mjs` → `scripts/LIMITS.generated.md` → `docs/LIMITS.md` | **written, but it has measured NOTHING** — the published package exposes no `clearing` module. **Re-run after `P3.clearing` lands and is published**, then copy the report into `docs/LIMITS.md`. It divides `computationCost` by the reference gas price, because the cost is in **MIST** and the 5 M ceiling is in **units** — comparing them directly is wrong by a factor of the gas price. Threshold 3 500 000 units (70 %). If `price_step` at 256 exceeds it: drop the default to 128 and split into `price_scan_step` + `alloc_step` | `node scripts/measure-clearing.mjs` |
| `X.keeper` | `keeper/src/**` | one TypeScript process; **delete** `strategy/ routing/ execution/ journal/` (v1); keep `sui/client.ts`, `hashi/limiter.ts`, `util/`, `config.ts`; `devInspect`-before-send; fail-soft across reconfiguration; re-derive never cache | `cd keeper && npm run build && npm test` |
| `X.app` | `app/src/**` | rewrite the screens for v2: vault (request/claim), auction (top up · encrypt · submit · reveal · **prove my fill**), transparency (the published root, the clearing price, the limitations panel carrying H1–H4) | `cd app && npm run build && npm test` |
| ~~`X.gates`~~ | `scripts/gates.{ps1,sh}` | **DONE 2026-07-26 02:13 (commit `72b12bb`).** 13 gates; `keepercap`, `notes`, `batchstate`, `send`, `seal_le` added, each proved against a **deliberately-violating** fixture tree as well as a compliant one, in both shells. `g2`/`g4`/`g7` repurposed rather than removed. 4 gates **SKIP** until their modules land — **a SKIP is not a PASS** | `powershell -File scripts/gates.ps1` |
| ~~`X.verifyall`~~ | `scripts/verify-all.ps1` | **DONE, same commit** — 8 → 12 steps, `app npm test` included (**B14 closed**). It immediately exposed **7 app tests still asserting v1 `gateway` error constants** (B23) | `powershell -File scripts/verify-all.ps1` |
| ~~`X.b11`~~ | `scripts/register-deposit.ps1` | **DONE, same commit** — ids resolve process env → `keeper/.env` → `keeper/src/config.ts`, provenance printed, and a self-test asserts neither watched prefix appears so it cannot silently regress. **`ids` is green for the first time** | `powershell -File scripts/gates.ps1 ids` |
| `X.banners` | every source file | one APHOTIC CONTRACT banner per file, `@task` in the `P<phase>.<module>` form, `@spec` citing real anchors | `gates.ps1 todo` |

---

## THE CUT LINE

> **Everything above this line is the minimum demoable product. Everything below is upside.**

**Cut line = Phase 1 (`P1.events`, `P1.caps`, `P1.allocate`, `P1.lending`, `P1.vault`) + a mocked
Phase 3 (`P3.notes`, `P3.balance`, `P3.batch`, `P3.clearing`) + `X.sdk` + `X.parity`.**

That is exactly what `aphotic.md` §11 recommends for a weekend: *"Phase 1 plus a mocked Phase 3
demonstrates the idea in a weekend."*

### Cut-line VERIFY — all of these green, or the cut line is not met

```bash
export PATH="$LOCALAPPDATA/sui:$PATH"
cd move    && sui move build && sui move test        # target >= 320 tests, 0 failures
cd lending && sui move build && sui move test
cd keeper  && npm run build && npm test -- parity    # L1 + L2 green
cd app     && npm run build
powershell -NoProfile -File scripts/gates.ps1        # incl. keepercap, notes, batchstate
```

L3 (`devInspect` parity) additionally requires a published package — it is the **release** gate, not
the cut-line gate.

### Below the cut line — do not start these before the line is green

`P2.*` (all of it) · `P4.*` (all of it) · `X.measure` beyond a first run · the landing-page
re-theme · Vercel deployment · anything involving real hBTC inventory.

---

## Standing prohibitions

1. **Never mark a unit DONE you have not seen a test pass for.** If you did not run the command, do
   not report its output. `docs/STATUS.md` is a ledger of observations, not of intentions.
2. **Never add a row to the keeper-callable list** (`docs/FACTS.md#keeper-callable`) without a
   written decision, and never give a keeper-gated function an `address` parameter.
3. **Never relitigate `aphotic.md` §3.** Those designs are eliminated with a stated reason.
4. **Never weaken an invariant in `aphotic.md` §10 to make a test pass.** If an invariant and a test
   disagree, one of them is wrong — find out which and say so.
5. **Never silently resolve an item in `docs/FACTS.md#unknowns`.** Record the answer with its
   evidence.
6. **Never write any of the five names in `aphotic.md` §22** — anywhere, including generated
   content. Read §22 for the list; describe the pattern generically instead.
7. **Never present a number from our own lending market as a third-party rate**, never say a note
   spend is unlinkable in v1, never quote a bare "7" or a bare "32" for validator collusion, and
   never present the NAV as fully reconstructible.
