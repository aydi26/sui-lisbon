# CONVENTIONS.md — the stub-contract banner

> Purpose: the machine-parseable header every non-trivial source file carries, so a later coding run can implement the file **from the banner alone** without re-reading the specs. This is the mechanical enforcement of `CLAUDE.md`'s "never re-derive an ID/type/signature".
> Read after: `docs/GOLDEN-RULES.md`, `docs/FACTS.md`.

## 1. Grammar

Comment prefix is `//` in Move and TypeScript, `/* … */` for CSS. Delimiters are fixed literals so tooling can validate them.

```
<prefix> ┌── APHOTIC CONTRACT ────────────────────────────────────────────────
<prefix> @task       Tx.y[, Tx.z]      REQUIRED — BUILD-PLAN task id(s) this file satisfies
<prefix> @phase      0|1|2|3|4|5 [CUT-LINE CRITICAL]
<prefix> @status     STUB | PARTIAL | DONE     REQUIRED — flipped by the implementer
<prefix> @spec       <doc>#<anchor> (L<a>-L<b>)   1..n — the doc lines that ARE the contract
<prefix> @rules      G1 G2 …           golden rules binding this file
<prefix> @depends    <module/file> (Tx.y)
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

1. Exactly **one** banner per file, immediately after the module declaration (Move) or at the very top (TS/TSX).
2. `@task`, `@status`, `@spec`, `@implements`, `@verify` are **mandatory** on every stub.
3. Every `@implements` signature must either exist in the body or have a `TODO(<task>)` on the line above.
4. `@status DONE` requires **zero** `TODO(<its task ids>)` left in that file.
5. `@facts` pre-resolves every constant the file needs. If a value is not in `@facts`, the implementer must add it there before using it — never inline an unexplained literal.
6. Canonical IDs appear **only** in `keeper/src/config.ts`, `app/src/config.ts`, `.env.example`, and `move/Move.toml`. Everywhere else they arrive as config (G7).

## 3. Progress greps

```powershell
# Census of remaining work grouped by BUILD-PLAN task id — the headline command
Select-String -Path move\sources\*.move,move\tests\*.move,keeper\src\*.ts,keeper\src\**\*.ts,app\src\**\*.ts,app\src\**\*.tsx `
              -Pattern 'TODO\(T\d+\.\d+\)' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Group-Object | Sort-Object Name |
  Format-Table Count, Name -AutoSize

# Everything still a stub
Select-String -Path move,keeper,app -Include *.move,*.ts,*.tsx -Pattern '@status\s+STUB' -Recurse |
  Select-Object -ExpandProperty Path -Unique

# All TODOs for ONE task (what a sub-agent opens with)
Select-String -Path move,keeper,app -Include *.move,*.ts,*.tsx -Pattern 'TODO\(T1\.3\)' -Recurse
```

## 4. Example — Move

```move
module aphotic::gateway;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T1.3, T1.4
// @phase      1  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/MOVE-PACKAGE.md#gateway
// @spec       docs/FACTS.md#hashi-move-api
// @rules      G2 G3 G7 G10
// @depends    aphotic::vault (T1.1) · hashi_shim (move/deps/hashi_shim)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000   (on-chain Hashi config, verified 2026-07-25)
// @facts      DUST_FLOOR_SATS = 546
// @facts      EXIT_ADDR_LEN ∈ {20 P2WPKH, 32 P2TR}
// @facts      ⚠ hashi::btc_config::bitcoin_withdrawal_minimum() is public(package) ⇒ NOT CALLABLE.
// @facts        Use the named constant above. ERRATA vs docs/MOVE-PACKAGE.md.
// @external   public fun hashi::withdraw::request_withdrawal(
//                 hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                 bitcoin_address: vector<u8>, ctx: &mut TxContext)
//             public fun hashi::withdraw::cancel_withdrawal(
//                 hashi: &mut Hashi, request_id: address, clock: &Clock,
//                 ctx: &mut TxContext): Balance<BTC>
//             ⚠⚠ cancel_withdrawal asserts request.sender == ctx.sender()
//                 ⇒ reclaim is DEPOSITOR-callable only; the keeper can NEVER call it.
// @implements public fun register_exit_address(...)
//             public fun exit_to_bitcoin(...)
//             public fun reclaim_stalled_exit(...)
// @forbidden  a `bitcoin_address` PARAMETER on any exit fn — G2, gates.ps1 g2
// @forbidden  `use hashi::` in any OTHER sources/*.move — G7, gates.ps1 g7
// @invariant  1. btc_exit_address is write-once.
// @invariant  2. exit_to_bitcoin reads the destination from the Vault, never a param.
// @invariant  3. amount < 30_000 ⇒ pooled, never submitted.
// @ac         docs/MOVE-PACKAGE.md §8 gateway_tests checklist
// @verify     sui move test --filter gateway
// @verify     pwsh scripts/gates.ps1 g7
// └── END CONTRACT ───────────────────────────────────────────────────────────

// TODO(T1.3): error constants, event structs, register_exit_address, exit_to_bitcoin
// TODO(T1.4): reclaim_stalled_exit, flush_pending_exit (self-only), take_pending_as_hbtc
```

## 5. Example — TypeScript

```ts
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.5
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §5.4
// @rules      G1 G2 G6 G7
// @depends    ../hashi/adapter.ts (T0.5) · ../sui/client.ts · aphotic::gateway (T1.3)
// @facts      HASHI_WITHDRAWAL_MIN = 30_000n sats
// @facts      ⚠ The keeper NEVER passes a bitcoin address — Move reads the pinned one (G2).
// @implements export function buildExitTx(cfg: Config, req: ExitRequest): Transaction
//             export async function exit(deps: ExitDeps, req: ExitRequest): Promise<ExitResult>
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  `number` for sats — all money is bigint
// @forbidden  new SuiClient(...) here — use sui/client.ts
// @invariant  1. The PTB contains exactly one moveCall: <pkg>::gateway::exit_to_bitcoin.
// @invariant  2. No argument of that call is a Bitcoin address.
// @ac         mock: exit(1_000_000n) emits WithdrawalRequested with the vault's pinned bytes.
// @verify     npm test -- exit
// └── END CONTRACT ───────────────────────────────────────────────────────────

export function buildExitTx(_cfg: Config, _req: ExitRequest): Transaction {
  // TODO(T2.5): one moveCall gateway::exit_to_bitcoin. NO bitcoin address argument.
  throw new Error('TODO(T2.5): buildExitTx not implemented');
}
```
