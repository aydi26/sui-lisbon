# ┌── APHOTIC CONTRACT ─────────────────────────────────────────────────────────
# @task       T2.3 (operator companion to keeper/src/execution/crank.ts)
# @phase      2
# @status     DONE
# @spec       docs/FACTS.md#hashi-move-api · .hashi_src/design__docs__deposit.mdx
# @rules      G1 G6 G7
# @facts      Hashi has NO deposit relayer. Verified empirically: 20 consecutive
# @facts        DepositRequested events had 20 DISTINCT tx senders, and in every
# @facts        one sender == derivation_path == requester_address. Each depositor
# @facts        registers their own UTXO. The design doc agrees: "The user then
# @facts        submits the request."
# @facts      ⚠⚠ TXID BYTE ORDER. hashi::utxo::utxo_id takes the txid in Bitcoin's
# @facts        INTERNAL byte order — the REVERSE of what every explorer displays.
# @facts        Verified against 3 real DepositConfirmed events: the displayed
# @facts        txid was never found on signet, the reversed one always was, and
# @facts        the output amount matched the event exactly. Registering the
# @facts        displayed order would reference a UTXO that does not exist, and
# @facts        nothing would tell you why.
# @facts      Registration is only accepted once the tx has the confirmations the
# @facts        committee requires (bitcoin_confirmation_threshold = 6).
# @external   public fun hashi::utxo::utxo_id(txid: address, vout: u32): UtxoId
#             public fun hashi::utxo::utxo(id: UtxoId, amount: u64,
#                 derivation_path: Option<address>): Utxo
#             entry fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo,
#                 clock: &Clock, ctx: &mut TxContext)
# @implements pwsh scripts/register-deposit.ps1 -Txid <displayed> -Vout <n> -Sats <n> [-Recipient <0x..>] [-DryRun]
# @forbidden  passing the DISPLAYED txid byte order — see above
# @invariant  1. The script reverses the txid itself; callers always pass the
#                explorer-displayed form, so there is one place to get it wrong.
#             2. It refuses to submit below the confirmation threshold unless
#                -Force is given, because the call would simply abort.
# @verify     pwsh scripts/register-deposit.ps1 -Txid <t> -Vout <v> -Sats <s> -DryRun
# └── END CONTRACT ────────────────────────────────────────────────────────────
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Txid,      # as shown by any explorer
  [Parameter(Mandatory = $true)][int]$Vout,
  [Parameter(Mandatory = $true)][long]$Sats,
  [string]$Recipient = '',                          # defaults to the active Sui address
  [int]$Confirmations = 6,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"

$HASHI_PKG = '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360'
$HASHI_OBJ = '0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8'
$CLOCK     = '0x6'
$MEMPOOL   = 'https://mempool.space/signet/api'

# ── txid: displayed order -> internal order ─────────────────────────────────
$clean = $Txid.Trim().Replace('0x', '').ToLower()
if ($clean.Length -ne 64) { throw "txid must be 64 hex chars, got $($clean.Length)" }
$pairs = for ($i = 0; $i -lt 64; $i += 2) { $clean.Substring($i, 2) }
$internal = ($pairs[63..0]) -join ''

if ($Recipient -eq '') { $Recipient = (& sui client active-address).Trim() }

Write-Host "displayed txid  : $clean"
Write-Host "internal order  : 0x$internal   <-- passed to utxo_id"
Write-Host "vout / sats     : $Vout / $Sats"
Write-Host "recipient       : $Recipient"

# ── confirmation gate ───────────────────────────────────────────────────────
try {
  $status = Invoke-RestMethod "$MEMPOOL/tx/$clean/status" -TimeoutSec 25
  $tip    = Invoke-RestMethod "$MEMPOOL/blocks/tip/height" -TimeoutSec 20
  if ($status.confirmed) {
    $depth = $tip - $status.block_height + 1
    Write-Host "confirmations   : $depth/$Confirmations (block $($status.block_height))"
  } else {
    $depth = 0
    Write-Host "confirmations   : 0/$Confirmations (still in mempool)"
  }
} catch {
  $depth = -1
  Write-Host "confirmations   : UNKNOWN (mempool.space unreachable)"
}

if ($depth -lt $Confirmations -and -not $Force -and -not $DryRun) {
  Write-Host ''
  Write-Host "Refusing to submit: the committee requires $Confirmations confirmations and this tx has $depth."
  Write-Host "Re-run once it is deep enough, or pass -Force to submit anyway."
  exit 2
}

# ── the PTB ─────────────────────────────────────────────────────────────────
# utxo_id(txid, vout) -> utxo(id, sats, some(recipient)) -> deposit(hashi, utxo, clock)
# derivation_path is Option<address> and MUST be the Sui address the deposit
# address was derived from, or the mint lands somewhere else.
$ptbArgs = @(
  '--move-call', "$HASHI_PKG::utxo::utxo_id", "@0x$internal", "${Vout}u32",
  '--assign', 'uid',
  '--move-call', "$HASHI_PKG::utxo::utxo", 'uid', "${Sats}u64", "some(@$Recipient)",
  '--assign', 'u',
  '--move-call', "$HASHI_PKG::deposit::deposit", "@$HASHI_OBJ", 'u', "@$CLOCK",
  '--gas-budget', '300000000'
)

if ($DryRun) {
  Write-Host ''
  Write-Host 'DRY RUN — the command that would run:'
  Write-Host ("  sui client ptb " + ($ptbArgs -join ' '))
  exit 0
}

Write-Host ''
Write-Host 'submitting hashi::deposit::deposit ...'
& sui client ptb @ptbArgs
exit $LASTEXITCODE
