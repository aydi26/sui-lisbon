# ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
# @task       B2 (docs/STATUS.md L153-L157 "Known blockers") — ops tooling, no BUILD-PLAN task id
# @phase      ops
# @status     DONE
# @spec       docs/STATUS.md#known-blockers · docs/RECON.md#r10 (L154-L160)
# @rules      G4 G7 G8
# @depends    scripts/seed-book.mjs (all logic lives there — this file is a Windows wrapper only)
# @facts      `sui` 1.76.0 lives at %LOCALAPPDATA%\sui\sui.exe and is NOT reliably on PATH
# @facts        ⇒ this wrapper prepends it, which is the whole reason the wrapper exists.
# @facts      PowerShell 5.1: no `&&`, no ternary, no null-coalescing. Do not "modernise" this file.
# @implements param block mirroring seed-book.mjs flags
# @implements -DryRun (default) · -Execute (the ONLY path that writes on chain)
# @forbidden  an on-chain write without -Execute — enforced below AND again in seed-book.mjs
# @forbidden  a canonical id literal in this file — G7, scripts/gates.ps1 `ids`
# @invariant  1. -DryRun and -Execute are mutually exclusive; passing both is a hard error.
# @invariant  2. Absent -Execute this script cannot cause a signed transaction.
# @invariant  3. The exit code is seed-book.mjs's exit code, unmodified.
# @ac         `powershell -NoProfile -File scripts/seed-book.ps1` prints the obtainable report
# @verify     powershell -NoProfile -File scripts/seed-book.ps1 -DryRun
# @verify     powershell -NoProfile -File scripts/seed-book.ps1 -SwapSui 18 -ChainDryRun
# └── END CONTRACT ───────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    # Explicit no-op: dry run is already the default. Present so the intent can be stated.
    [switch] $DryRun,

    # THE ONLY FLAG THAT CAUSES AN ON-CHAIN WRITE.
    [switch] $Execute,

    # Sell this many SUI into the SUI/DBUSDC book to acquire DBUSDC. 0 = do not swap.
    [double] $SwapSui = 0,

    # Acquire DBUSDC and stop — do not plan or place an order.
    [switch] $SwapOnly,

    [ValidateSet('bid', 'ask')]
    [string] $Side = 'bid',

    # Order size in sats. Omit to use the pool's min_size.
    [string] $Qty,

    # Explicit DeepBook price (u64). Omit to derive it from the Pyth BETA feed.
    [string] $Price,

    # Derive the price from this USD/BTC instead of the oracle.
    [string] $Usd,

    [string] $MaxDeviationBps = '500',
    [string] $SlippageBps = '100',
    [string] $GasBudget = '100000000',

    # Refuse-guard override: place an order knowingly far from the oracle.
    [switch] $AllowOffMarket,

    # Additionally push the PTB through `sui client ptb --dry-run` (no state change).
    [switch] $ChainDryRun,

    [switch] $Json
)

$ErrorActionPreference = 'Stop'

if ($DryRun -and $Execute) {
    Write-Error '-DryRun and -Execute are mutually exclusive. Pick one.'
    exit 2
}

# RECON R2 / CLAUDE.md: sui 1.76.0 is installed but not reliably on PATH in agent shells.
$suiDir = Join-Path $env:LOCALAPPDATA 'sui'
if (Test-Path (Join-Path $suiDir 'sui.exe')) {
    $env:PATH = "$suiDir;$env:PATH"
    $env:SUI_BIN = Join-Path $suiDir 'sui.exe'
}

$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'seed-book.mjs'
if (-not (Test-Path $script)) {
    Write-Error "missing $script"
    exit 2
}

$nodeArgs = @($script)
if ($SwapSui -gt 0) { $nodeArgs += "--swap-sui=$SwapSui" }
if ($SwapOnly) { $nodeArgs += '--swap-only' }
$nodeArgs += "--side=$Side"
if ($Qty) { $nodeArgs += "--qty=$Qty" }
if ($Price) { $nodeArgs += "--price=$Price" }
if ($Usd) { $nodeArgs += "--usd=$Usd" }
$nodeArgs += "--max-deviation-bps=$MaxDeviationBps"
$nodeArgs += "--slippage-bps=$SlippageBps"
$nodeArgs += "--gas-budget=$GasBudget"
if ($AllowOffMarket) { $nodeArgs += '--allow-off-market' }
if ($ChainDryRun) { $nodeArgs += '--chain-dry-run' }
if ($Json) { $nodeArgs += '--json' }

if ($Execute) {
    Write-Host ''
    Write-Host '  ############################################################' -ForegroundColor Yellow
    Write-Host '  #  -Execute: this run WILL sign and submit a transaction.  #' -ForegroundColor Yellow
    Write-Host '  #  It spends SUI and rests a real order on a real book.    #' -ForegroundColor Yellow
    Write-Host '  ############################################################' -ForegroundColor Yellow
    Write-Host ''
    $nodeArgs += '--execute'
}
else {
    Write-Host '  seed-book: DRY RUN (no on-chain write). Add -Execute to submit.' -ForegroundColor Cyan
}

& node @nodeArgs
exit $LASTEXITCODE
