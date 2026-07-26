# ┌── APHOTIC CONTRACT ─────────────────────────────────────────────────────────
# @task       T2.3 (operator companion to keeper/src/execution/crank.ts) · blocker B11
# @phase      2
# @status     DONE
# @spec       docs/FACTS.md#hashi-move-api · docs/RECON.md#r14 · .hashi_src/design__docs__deposit.mdx
# @spec       docs/DESIGN-V2.md §8 D12 (B11: this file used to hardcode two Hashi ids)
# @rules      G1 G6 G7
# @depends    keeper/.env → keeper/src/config.ts (the ONLY id homes, G7) · the `sui` CLI for signing
# @facts      Hashi has NO deposit relayer. Verified empirically: 20 consecutive
# @facts        DepositRequested events had 20 DISTINCT tx senders, and in every
# @facts        one sender == derivation_path == requester_address. Each depositor
# @facts        registers their own UTXO. The design doc agrees: "The user then
# @facts        submits the request."
# @facts      ⚠⚠ TXID BYTE ORDER (RECON R14.2). hashi::utxo::utxo_id takes the txid
# @facts        in Bitcoin's INTERNAL byte order — the REVERSE of what every
# @facts        explorer displays. Verified against 3 real DepositConfirmed events:
# @facts        the displayed txid was never found on signet, the reversed one
# @facts        always was, and the output amount matched the event exactly.
# @facts        Registering the displayed order references a UTXO that does not
# @facts        exist, the transaction SUCCEEDS, and the committee simply never
# @facts        approves it. Nothing tells you why. This script does the reversal,
# @facts        so there is exactly one place it can be wrong.
# @facts      ⚠ RECON R14.3: registration is only accepted once the tx has
# @facts        bitcoin_confirmation_threshold (6) confirmations, and a MEMPOOL txid
# @facts        can be RBF-replaced out of existence. The confirmation gate is what
# @facts        makes registration safe, not a nicety.
# @facts      ID RESOLUTION (G7 — no canonical id literal may appear in this file):
# @facts        HASHI_PACKAGE_ID / HASHI_OBJECT_ID are read, in order, from
# @facts        (1) the process environment, (2) keeper/.env, (3) keeper/src/config.ts
# @facts        — the same chain scripts/seed-book.mjs uses. Provenance is printed.
# @external   public fun hashi::utxo::utxo_id(txid: address, vout: u32): UtxoId
#             public fun hashi::utxo::utxo(id: UtxoId, amount: u64,
#                 derivation_path: Option<address>): Utxo
#             entry fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo,
#                 clock: &Clock, ctx: &mut TxContext)
# @implements Get-DotEnv · Get-ConfigTsId · Resolve-HashiId  (the B11 fix)
# @implements ConvertTo-InternalTxid   (RECON R14.2 — the byte reversal)
# @implements Get-ConfirmationDepth · Test-DeepEnough  (RECON R14.3 — the 6-conf gate)
# @implements Invoke-SelfTest          (-SelfTest: both safety behaviours, offline)
# @implements pwsh scripts/register-deposit.ps1 -Txid <displayed> -Vout <n> -Sats <n> [-Recipient <0x..>] [-DryRun]
# @forbidden  passing the DISPLAYED txid byte order — see above
# @forbidden  a canonical id literal in this file — G7, scripts/gates.ps1 `ids`
# @invariant  1. The script reverses the txid itself; callers always pass the
#                explorer-displayed form, so there is one place to get it wrong.
#             2. It refuses to submit below the confirmation threshold unless
#                -Force is given, because the call would simply abort.
#             3. No on-chain id is written in this file; resolution failure is a
#                hard exit, never a silent fallback to a guessed id.
# @ac         `powershell -NoProfile -File scripts/gates.ps1 ids` is GREEN
# @ac         `powershell -NoProfile -File scripts/register-deposit.ps1 -SelfTest` exits 0
# @verify     powershell -NoProfile -File scripts/register-deposit.ps1 -SelfTest
# @verify     pwsh scripts/register-deposit.ps1 -Txid <t> -Vout <v> -Sats <s> -DryRun
# @verify     powershell -NoProfile -File scripts/gates.ps1 ids
# └── END CONTRACT ────────────────────────────────────────────────────────────
[CmdletBinding()]
param(
  [string]$Txid = '',                               # as shown by any explorer
  [int]$Vout = -1,
  [long]$Sats = 0,
  [string]$Recipient = '',                          # defaults to the active Sui address
  [int]$Confirmations = 6,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$SelfTest                                 # offline: exercise both safety behaviours
)

$ErrorActionPreference = 'Stop'
$env:PATH = "$env:LOCALAPPDATA\sui;$env:PATH"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CLOCK = '0x6'
$MEMPOOL = 'https://mempool.space/signet/api'

# ── SAFETY BEHAVIOUR 1 — RECON R14.2: displayed order -> internal order ──────
function ConvertTo-InternalTxid {
    param([Parameter(Mandatory = $true)][string] $Displayed)
    $clean = $Displayed.Trim()
    if ($clean.StartsWith('0x') -or $clean.StartsWith('0X')) { $clean = $clean.Substring(2) }
    $clean = $clean.ToLowerInvariant()
    if ($clean -notmatch '^[0-9a-f]*$') { throw "txid must be hex, got '$Displayed'" }
    if ($clean.Length -ne 64) { throw "txid must be 64 hex chars, got $($clean.Length)" }
    $pairs = for ($i = 0; $i -lt 64; $i += 2) { $clean.Substring($i, 2) }
    return [pscustomobject]@{ Clean = $clean; Internal = ($pairs[31..0] -join '') }
}

# ── SAFETY BEHAVIOUR 2 — RECON R14.3: the confirmation gate ──────────────────
# Returns -1 when the depth is genuinely UNKNOWN (mempool.space unreachable). An
# unknown depth is NOT a deep-enough depth — Test-DeepEnough treats it as 0-like.
function Get-ConfirmationDepth {
    param([string] $CleanTxid, [string] $Api = $MEMPOOL)
    try {
        $status = Invoke-RestMethod "$Api/tx/$CleanTxid/status" -TimeoutSec 25
        $tip = Invoke-RestMethod "$Api/blocks/tip/height" -TimeoutSec 20
        if ($status.confirmed) {
            return [pscustomobject]@{ Depth = ($tip - $status.block_height + 1); Height = $status.block_height; Known = $true }
        }
        return [pscustomobject]@{ Depth = 0; Height = $null; Known = $true }
    }
    catch {
        return [pscustomobject]@{ Depth = -1; Height = $null; Known = $false }
    }
}

function Test-DeepEnough {
    param([int] $Depth, [int] $Threshold)
    return ($Depth -ge $Threshold)
}

# ── G7 id resolution — env → keeper/.env → keeper/src/config.ts ──────────────
function Get-DotEnv {
    param([string] $Path)
    $out = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $out }
    foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = ($line.Substring(0, $eq).Trim()) -replace '^export\s+', ''
        $v = $line.Substring($eq + 1).Trim()
        if ($v.Length -ge 2) {
            $a = $v.Substring(0, 1); $b = $v.Substring($v.Length - 1, 1)
            if (($a -eq '"' -and $b -eq '"') -or ($a -eq "'" -and $b -eq "'")) { $v = $v.Substring(1, $v.Length - 2) }
        }
        if ($v -ne '') { $out[$k] = $v }
    }
    return $out
}

# ⚠ Strip `//` / `*` comment lines FIRST. config.ts carries an APHOTIC CONTRACT banner whose
# `@facts` lines quote the SAME constant names with the id ELIDED to its first few nibbles plus
# an ellipsis. Scraping one of those yields a truncated id and a transaction that fails for a
# reason you will never guess. seed-book.mjs strips comments for exactly the same reason.
# The `{60,}` length floor below is a second, independent guard against an elided match.
function Get-ConfigTsId {
    param([string] $Path, [string[]] $Keys)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $src = ([System.IO.File]::ReadAllLines($Path) | Where-Object { $_ -notmatch '^\s*(//|\*|/\*)' }) -join "`n"
    foreach ($k in $Keys) {
        $rx = '\b' + [regex]::Escape($k) + '\b\s*[:=]\s*[''"`]?(0x[0-9a-fA-F]{60,})[''"`]?'
        $m = [regex]::Match($src, $rx)
        if ($m.Success) { return $m.Groups[1].Value }
    }
    return $null
}

function Resolve-HashiId {
    param([string] $EnvKey, [string[]] $ConfigKeys, [hashtable] $DotEnv)
    $v = [Environment]::GetEnvironmentVariable($EnvKey)
    if ($v) { return [pscustomobject]@{ Value = $v; From = "process env $EnvKey" } }
    if ($DotEnv.ContainsKey($EnvKey)) { return [pscustomobject]@{ Value = $DotEnv[$EnvKey]; From = "keeper/.env $EnvKey" } }
    $cfg = Join-Path $RepoRoot 'keeper/src/config.ts'
    $v = Get-ConfigTsId $cfg $ConfigKeys
    if ($v) { return [pscustomobject]@{ Value = $v; From = "keeper/src/config.ts ($($ConfigKeys -join '/'))" } }
    return [pscustomobject]@{ Value = $null; From = 'UNRESOLVED' }
}

# ── -SelfTest — both safety behaviours, offline, no network, no signing ──────
function Invoke-SelfTest {
    $script:fails = 0
    function Assert-Eq {
        param($Actual, $Expected, [string] $What)
        if ("$Actual" -ceq "$Expected") { Write-Host "  ok   $What" -ForegroundColor Green }
        else { Write-Host "  FAIL $What`n         expected: $Expected`n         actual  : $Actual" -ForegroundColor Red; $script:fails++ }
    }
    function Assert-True {
        param([bool] $Cond, [string] $What)
        if ($Cond) { Write-Host "  ok   $What" -ForegroundColor Green }
        else { Write-Host "  FAIL $What" -ForegroundColor Red; $script:fails++ }
    }

    Write-Host ''
    Write-Host 'register-deposit self-test (offline)' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'RECON R14.2 — txid byte reversal'

    # A synthetic vector whose reversal is checkable by eye, byte by byte.
    $v = ConvertTo-InternalTxid '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
    Assert-Eq $v.Internal '201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a090807060504030201' 'reverses byte order (32 bytes, not nibbles)'

    # Involution: reversing twice is the identity. This is what makes "always hand it
    # the DISPLAYED form" a safe instruction.
    $back = ConvertTo-InternalTxid $v.Internal
    Assert-Eq $back.Internal $v.Clean 'reversal is an involution'

    # A 0x prefix and upper case must not change the result.
    $p = ConvertTo-InternalTxid ('0X' + '0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20')
    Assert-Eq $p.Internal $v.Internal 'accepts a 0x prefix and upper case'

    # It must never silently accept a short/odd/non-hex txid — a truncated txid would
    # register a UTXO that does not exist, which is the silent failure R14.2 describes.
    $threw = $false
    try { [void] (ConvertTo-InternalTxid '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f') } catch { $threw = $true }
    Assert-True $threw 'rejects a 62-char txid'
    $threw = $false
    try { [void] (ConvertTo-InternalTxid 'zz02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20') } catch { $threw = $true }
    Assert-True $threw 'rejects non-hex'

    Write-Host ''
    Write-Host 'RECON R14.3 — the 6-confirmation gate'
    Assert-True (-not (Test-DeepEnough 0 6)) 'refuses at 0 confirmations (still in mempool — RBF can replace it)'
    Assert-True (-not (Test-DeepEnough 5 6)) 'refuses at 5 confirmations'
    Assert-True (Test-DeepEnough 6 6) 'accepts at exactly 6 confirmations'
    Assert-True (Test-DeepEnough 99 6) 'accepts above the threshold'
    Assert-True (-not (Test-DeepEnough -1 6)) 'refuses when the depth is UNKNOWN (unreachable explorer is not "deep enough")'

    Write-Host ''
    Write-Host 'B11 — id resolution carries no literal'
    $self = [System.IO.File]::ReadAllText($PSCommandPath)
    # The `ids` gate watches these two prefixes; assert this file cannot reintroduce them.
    $pkgPrefix = '0x' + 'fcea10ca'
    $objPrefix = '0x' + '22c0ce66'
    Assert-True (-not $self.Contains($pkgPrefix)) 'no Hashi package-id literal in this file'
    Assert-True (-not $self.Contains($objPrefix)) 'no Hashi object-id literal in this file'

    $dotenv = Get-DotEnv (Join-Path $RepoRoot 'keeper/.env')
    $pkg = Resolve-HashiId 'HASHI_PACKAGE_ID' @('HASHI_PACKAGE_ID', 'hashiPackageId') $dotenv
    $obj = Resolve-HashiId 'HASHI_OBJECT_ID' @('HASHI_OBJECT_ID', 'hashiObjectId') $dotenv
    Assert-True ($null -ne $pkg.Value) "HASHI_PACKAGE_ID resolves (from: $($pkg.From))"
    Assert-True ($null -ne $obj.Value) "HASHI_OBJECT_ID resolves  (from: $($obj.From))"
    if ($pkg.Value) { Assert-True ($pkg.Value -match '^0x[0-9a-fA-F]{64}$') 'resolved package id is a full 32-byte id, not an elided one' }
    if ($obj.Value) { Assert-True ($obj.Value -match '^0x[0-9a-fA-F]{64}$') 'resolved object id is a full 32-byte id, not an elided one' }

    Write-Host ''
    if ($script:fails -gt 0) { Write-Host "  $script:fails FAILURE(S)" -ForegroundColor Red; return 1 }
    Write-Host '  all self-tests passed' -ForegroundColor Green
    return 0
}

if ($SelfTest) { exit (Invoke-SelfTest) }

# ── argument validation (only once we know we are not self-testing) ──────────
if (-not $Txid) { Write-Host 'register-deposit.ps1: -Txid is required (or pass -SelfTest).' -ForegroundColor Red; exit 2 }
if ($Vout -lt 0) { Write-Host 'register-deposit.ps1: -Vout is required and must be >= 0.' -ForegroundColor Red; exit 2 }
if ($Sats -le 0) { Write-Host 'register-deposit.ps1: -Sats is required and must be > 0.' -ForegroundColor Red; exit 2 }

# ── resolve the ids (B11: never a literal in this file) ─────────────────────
$dotenv = Get-DotEnv (Join-Path $RepoRoot 'keeper/.env')
$pkgRes = Resolve-HashiId 'HASHI_PACKAGE_ID' @('HASHI_PACKAGE_ID', 'hashiPackageId') $dotenv
$objRes = Resolve-HashiId 'HASHI_OBJECT_ID' @('HASHI_OBJECT_ID', 'hashiObjectId') $dotenv

if (-not $pkgRes.Value -or -not $objRes.Value) {
    Write-Host ''
    Write-Host 'Cannot resolve the Hashi ids. This script never hardcodes them (G7, blocker B11).' -ForegroundColor Red
    Write-Host '  Set HASHI_PACKAGE_ID / HASHI_OBJECT_ID in the environment or in keeper/.env,' -ForegroundColor Red
    Write-Host '  or make sure keeper/src/config.ts still declares them.' -ForegroundColor Red
    Write-Host ("  package : {0}" -f $(if ($pkgRes.Value) { $pkgRes.Value } else { 'UNRESOLVED' })) -ForegroundColor Red
    Write-Host ("  object  : {0}" -f $(if ($objRes.Value) { $objRes.Value } else { 'UNRESOLVED' })) -ForegroundColor Red
    exit 2
}
$HASHI_PKG = $pkgRes.Value
$HASHI_OBJ = $objRes.Value

# ── txid: displayed order -> internal order ─────────────────────────────────
$tx = ConvertTo-InternalTxid $Txid
$clean = $tx.Clean
$internal = $tx.Internal

if ($Recipient -eq '') { $Recipient = (& sui client active-address).Trim() }

Write-Host "hashi package   : $HASHI_PKG   (from: $($pkgRes.From))"
Write-Host "hashi object    : $HASHI_OBJ   (from: $($objRes.From))"
Write-Host "displayed txid  : $clean"
Write-Host "internal order  : 0x$internal   <-- passed to utxo_id (RECON R14.2)"
Write-Host "vout / sats     : $Vout / $Sats"
Write-Host "recipient       : $Recipient"

# ── confirmation gate ───────────────────────────────────────────────────────
$conf = Get-ConfirmationDepth $clean
$depth = $conf.Depth
if (-not $conf.Known) {
    Write-Host "confirmations   : UNKNOWN (mempool.space unreachable)"
}
elseif ($depth -eq 0) {
    Write-Host "confirmations   : 0/$Confirmations (still in mempool — an RBF replacement can erase it, RECON R14.3)"
}
else {
    Write-Host "confirmations   : $depth/$Confirmations (block $($conf.Height))"
}

if (-not (Test-DeepEnough $depth $Confirmations) -and -not $Force -and -not $DryRun) {
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
