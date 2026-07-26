# CONVENTIONS.md — the APHOTIC CONTRACT banner

> Purpose: the machine-parseable header every non-trivial source file carries, so a later coding run
> can implement the file **from the banner alone** without re-reading the specs. This is the
> mechanical enforcement of `CLAUDE.md`'s "never re-derive an ID/type/signature".
> Read after: `CLAUDE.md` (the ten golden rules), `docs/FACTS.md`.
>
> **Updated 2026-07-26 for the v2 product.** The grammar is unchanged — it worked. What changed:
> the unit-id form, the list of places a canonical id may live, the gate names, and both examples
> (the old ones showed `gateway.move`, which is deleted).

## 1. Grammar

Comment prefix is `//` in Move and TypeScript, `/* … */` for CSS. Delimiters are fixed literals so
tooling can validate them.

```
<prefix> ┌── APHOTIC CONTRACT ────────────────────────────────────────────────
<prefix> @task       P<phase>.<module>[, …]   REQUIRED — BUILD-PLAN unit id(s) this file satisfies
<prefix> @phase      0|1|2|3|4 [CUT-LINE CRITICAL]
<prefix> @status     STUB | PARTIAL | DONE     REQUIRED — flipped by the implementer
<prefix> @spec       <doc>#<anchor> (L<a>-L<b>)   1..n — the doc lines that ARE the contract
<prefix> @rules      G1 G2 …           golden rules binding this file
<prefix> @depends    <module/file> (P<phase>.<module>)
<prefix> @facts      <NAME> = <value>   (source)    every constant pre-resolved — do NOT re-derive
<prefix> @external   <verbatim upstream signature> + ⚠ gotchas
<prefix> @implements <verbatim signature to write>   1..n — copy-pasteable
<prefix> @events     …    (Move only)
<prefix> @errors     E…   (Move only)
<prefix> @forbidden  <thing> — <which gate catches it>
<prefix> @invariant  <numbered assertion that must hold>
<prefix> @ac         <acceptance criterion or doc pointer>
<prefix> @verify     <exact command>   1..n
<prefix> └── END CONTRACT ───────────────────────────────────────────────────
```

## 2. Rules

1. Exactly **one** banner per file, immediately after the module declaration (Move) or at the very
   top (TS/TSX).
2. `@task`, `@status`, `@spec`, `@implements`, `@verify` are **mandatory** on every stub.
3. Every `@implements` signature must either exist in the body or have a `TODO(<task>)` on the line
   above.
4. `@status DONE` requires **zero** `TODO(<its task ids>)` left in that file — **and** a test that
   someone has actually seen pass. A banner is a claim; `docs/STATUS.md` records whether it was
   checked.
5. `@facts` pre-resolves every constant the file needs. If a value is not in `@facts`, add it there
   before using it — **never inline an unexplained literal.** Where a value is a *prior* rather than
   a measurement, label it: `(a BOUND, not a fact)`.
6. **Canonical on-chain ids appear only in**: `move/Move.toml`, `lending/Move.toml`,
   `keeper/src/config.ts`, `app/src/config.ts`, `sdk/src/config.ts` (if it exists), and the
   `.env.example` files. Everywhere else they arrive as config (G7). Two tooling exceptions, both
   documented inline: the **generated** `Move.lock` / `Published.toml`, and the `scripts/`
   verifiers, which are the tools that *prove* those ids.
7. **Unit ids are `P<phase>.<module>`** — `P1.vault`, `P3.clearing`, `X.sdk`. ⚠ Files written before
   2026-07-26 use a `T<n>.<m>` form (`T1.1` = `P1.caps`, `T3.1` = `P3.notes`, `T3.2` = `P3.balance`,
   `T2.1` = `P2.oracle`, `T1.0` = `P1.events`). Both are accepted by the census greps; new files use
   the `P` form. Normalising the old ones is unit `X.banners`, low priority.
8. **Cite anchors, never re-derive.** `@spec docs/FACTS.md#seal-identity` is right;
   pasting the byte layout into a comment and getting one field wrong is how F1 happened.

## 3. Progress greps

```powershell
# Census of remaining work grouped by unit id — the headline command.
# Accepts BOTH id forms: P1.vault / T1.1
Select-String -Path move\sources\*.move,move\tests\*.move,lending\sources\*.move,`
                    sdk\src\**\*.ts,keeper\src\**\*.ts,app\src\**\*.ts,app\src\**\*.tsx `
              -Pattern 'TODO\((?:P\d+\.[a-z]+|X\.[a-z]+|T\d+\.\d+)\)' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Group-Object | Sort-Object Name |
  Format-Table Count, Name -AutoSize

# Everything still a stub
Select-String -Path move,lending,sdk,keeper,app -Include *.move,*.ts,*.tsx `
              -Pattern '@status\s+STUB' -Recurse |
  Select-Object -ExpandProperty Path -Unique

# Everything claiming DONE — cross-check these against docs/STATUS.md, which records
# whether anyone actually ran the test
Select-String -Path move,lending,sdk,keeper,app -Include *.move,*.ts,*.tsx `
              -Pattern '@status\s+DONE' -Recurse |
  Select-Object -ExpandProperty Path -Unique

# All TODOs for ONE unit (what a sub-agent opens with)
Select-String -Path move,lending,sdk,keeper,app -Include *.move,*.ts,*.tsx `
              -Pattern 'TODO\(P3\.batch\)' -Recurse
```

## 4. Example — Move

```move
module aphotic::batch;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P3.batch
// @phase      3  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       aphotic.md#7.2-the-batch  ·  aphotic.md#7.3-cadence
// @spec       aphotic.md#10-invariants  <- the "Batch" block
// @spec       docs/DESIGN-V2.md §3 (the seal_approve entry, exactly) · §4 (timing is mechanical)
// @spec       docs/FACTS.md#seal-identity · docs/FACTS.md#cadence · docs/FACTS.md#ceilings
// @rules      G4 G5 G6 G8 G10
// @depends    aphotic::notes (P3.notes) · aphotic::balance (P3.balance) · aphotic::caps (P1.caps)
//             sdk/src/seal/identity.ts (X.sdk) — the SAME encoding, the other side
// @facts      cadence_ms = 43_200_000  ·  offset_ms = 21_600_000   => 06:00 / 18:00 UTC
// @facts      SUBMIT_CUTOFF_MS = 60_000   ·  REVEAL_GRACE_MS = 600_000
// @facts      MAX_BATCH_SIZE default 256, HARD_MAX_BATCH_SIZE = 512 asserted in the setter
// @facts        (docs/FACTS.md#ceilings — store entries and events bind, NOT the gas budget)
// @facts      inner seal id, 48 B: close_ms u64 LE ‖ policy_version u64 LE ‖ batch id 32 B
// @facts      ⚠⚠ LITTLE-ENDIAN. `bcs::peel_u64` reads LE; the deleted v1 vault decoded BE and
// @facts        would have produced a policy that NEVER OPENS, silently. docs/DESIGN-V2.md F1.
// @facts      commitment = blake2b256(bcs(Order)) — binds the PLAINTEXT, not the ciphertext.
// @external   (none — Seal has NO Move package. The only on-chain Seal surface is our own
//             `seal_approve`, which key servers reach by dry-running a 1-command PTB.)
// @implements public fun open_batch(...)          // takes NO timestamp parameter
//             public fun close_batch(...)         // reverts before close_ms; >= succeeds
//             public fun submit_order(...)        // rejected within SUBMIT_CUTOFF_MS of close
//             public fun reveal_order(...) / reveal_many(...)
//             entry fun seal_approve(id: vector<u8>, r: &BatchRegistry, c: &clock::Clock)
//             public fun next_boundary(now_ms: u64, cadence_ms: u64, offset_ms: u64): u64
// @forbidden  a SENDER CHECK inside seal_approve — docs/DESIGN-V2.md F2; it must be satisfiable
//             by ANYONE after T, or grief-by-non-revelation comes back
// @forbidden  `.state =` outside set_state / open_batch — gates.ps1 batchstate
// @forbidden  closing a FULL batch early — it rejects submits and still closes on the boundary
// @forbidden  any amount / side / price field on SealedOrder — G9
// @invariant  1. state transitions are monotonic; no path returns to OPEN.
// @invariant  2. close_ms is DERIVED, never supplied by a caller.
// @invariant  3. seal_approve mutates nothing, emits nothing, and denies by ABORT.
// @invariant  4. leftovers.length() == 0 and ver == policy_version are BOTH mandatory.
// @ac         docs/MOVE-PACKAGE.md §11 — the batch_tests checklist, incl.
//             seal_approve_little_endian_golden (LE opens, BE of the SAME timestamp ABORTS)
// @verify     sui move test batch
// @verify     pwsh scripts/gates.ps1 batchstate
// └── END CONTRACT ───────────────────────────────────────────────────────────

// TODO(P3.batch): error constants, BatchRegistry, Batch, the state machine
// TODO(P3.batch): next_boundary + golden vectors shared with sdk/src/cadence.ts
// TODO(P3.batch): seal_approve — LITTLE-ENDIAN, no sender check, leftovers empty
```

## 5. Example — TypeScript

```ts
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.sdk
// @phase      3  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/DESIGN-V2.md §3 (the exact byte layout) · §9 (why sdk/ is structural)
// @spec       docs/FACTS.md#seal-identity
// @rules      G6 G7 G10
// @depends    nothing — this file is a LEAF and must stay one. It is imported by the app
//             (encoder), the keeper (encoder) and mirrored by aphotic::batch (decoder).
// @facts      inner id = 48 bytes:
// @facts        [ 0..8 )  bcs u64 close_ms        LITTLE-ENDIAN
// @facts        [ 8..16)  bcs u64 policy_version  LITTLE-ENDIAN
// @facts        [16..48)  bcs address batch id    (32 raw bytes)
// @facts      full IBE identity = bytes(packageId) ‖ inner; seal_approve receives ONLY inner.
// @facts      ⚠⚠ THE TRAP: the deleted v1 keeper documented this as BIG-ENDIAN. A BE encoding
// @facts        produces a policy that never opens and FAILS SILENTLY — the key server simply
// @facts        declines. Structural twin of RECON R14.2's byte-reversed Bitcoin txid.
// @implements export function encodeInnerId(closeMs: bigint, policyVersion: bigint,
//                 batchId: string): Uint8Array
//             export function decodeInnerId(bytes: Uint8Array): InnerId   // for tests only
// @forbidden  a SECOND copy of this encoding anywhere — G7. If you need it in the app, import
//             it from here. keeper/test/limiter.cross.test.ts exists because a duplicate
//             drifted once (blocker B6).
// @forbidden  `number` for a u64 — all of these are bigint
// @invariant  1. encodeInnerId(...).length === 48, always.
// @invariant  2. decodeInnerId(encodeInnerId(x)) deep-equals x, for 10k seeded cases.
// @invariant  3. The Move golden test asserts the LE encoding OPENS and the BE encoding of the
//                SAME timestamp ABORTS. Both vectors live in sdk/fixtures/.
// @ac         batch_tests::seal_approve_little_endian_golden passes against these bytes
// @verify     npm test -- seal.identity
// └── END CONTRACT ───────────────────────────────────────────────────────────

export function encodeInnerId(
  _closeMs: bigint, _policyVersion: bigint, _batchId: string,
): Uint8Array {
  // TODO(X.sdk): 48 bytes, LITTLE-ENDIAN u64s. See @facts — do not re-derive the layout.
  throw new Error('TODO(X.sdk): encodeInnerId not implemented');
}
```

## 6. The gates a banner can cite

**13 gates**, as of commit `72b12bb` (2026-07-26 02:13):
`g7 g4 g2 ids sdk purity transport notes batchstate keepercap send seal_le todo`. Default is `all`.

| Gate | Fails when | State |
|---|---|---|
| `keepercap` | a keeper-gated function has an `address` parameter | **new** |
| `notes` | `struct Note` carries any field but `id` / `denom_index` | **new** |
| `batchstate` | `\.state\s*=` appears outside `set_state` / `open_batch` | **new** |
| `send` | a destination is nameable where it must not be | **new** |
| `seal_le` | the Seal identity is decoded big-endian | **new** — currently **SKIP**, `batch.move` has not landed |
| `ids` | a canonical on-chain id appears outside the homes in §2.6 | **green for the first time** (B11 closed) |
| `purity` | `Date.now()` / `Math.random()` in deterministic TypeScript | exists |
| `transport` | a Sui client is constructed outside the one factory per package | exists |
| `sdk` | `@mysten/hashi` is imported outside the adapter | exists |
| `todo` | never — informational census only | exists |
| `g2` | **repurposed, and it had a real hole.** It passed a function taking `bitcoin_address: vector<u8>`, because a word-bounded `address` test misses the underscore — *the gate guarding the most important invariant did not work*. Its destination test is now strictly **broader** than `keepercap`'s | fixed |
| `g4` · `g7` | repurposed from the v1 router / gateway boundaries. `g7`'s Hashi-boundary target is now `carry.move` | repurposed |

> **A SKIP is not a PASS.** The gate runner counts them separately and each SKIP states what was
> *not* checked and why. Four gates SKIP today because their target modules do not exist. A gate
> must never look green because the thing it protects has not been written.
>
> Every new gate was proved **against a deliberately-violating fixture tree as well as a compliant
> one, in both shells.** A gate only tested on passing code is not a gate.
