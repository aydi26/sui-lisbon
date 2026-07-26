#Requires -Version 5.1
# ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
# @task       T0.6 (v2 extension) · blocker B14
# @phase      0  [CUT-LINE CRITICAL]
# @status     DONE
# @spec       docs/BUILD-PLAN.md "Cut-line VERIFY" · CLAUDE.md "BUILD & TEST COMMANDS"
# @spec       docs/DESIGN-V2.md §9 (sdk parity is a RELEASE GATE) · §10 (test targets)
# @rules      G2 G4 G5 G7 G10
# @depends    scripts/gates.ps1 · scripts/verify-onchain.mjs · scripts/measure-clearing.mjs
# @facts      12 ordered steps:
# @facts        move build · move test · sdk typecheck · sdk test · keeper typecheck ·
# @facts        keeper build · keeper test · clearing parity · app build · app test ·
# @facts        gates · verify-onchain
# @facts      ⚠ B14 (FIXED HERE): this script used to run 8 steps and NOT `cd app && npm test`,
# @facts        so an app regression passed the master gate. `app test` is now a step of its
# @facts        own, and so are `sdk typecheck`, `sdk test` and the clearing parity run.
# @facts      ⚠ DESIGN-V2 §9: clearing must be BYTE-IDENTICAL in Move, keeper and app. The
# @facts        parity test is the release gate, so it gets its own line in the table rather
# @facts        than hiding inside `sdk test` — a green suite that never ran parity is exactly
# @facts        the failure this row exists to make visible.
# @facts      A step whose tree/toolchain/npm-script/test-file does not exist yet is SKIP
# @facts        (amber), never FAIL (red) and NEVER PASS — other agents scaffold move/, sdk/,
# @facts        keeper/ and app/ concurrently. SKIP IS NOT GREEN.
# @implements Invoke-Step · Test-HasTestMatching · the ordered $Steps table · the summary
# @forbidden  reporting green for a step that did not actually run — SKIP is a distinct verdict
# @forbidden  folding SKIP into PASS in the header count
# @invariant  1. Exit code is non-zero iff at least one step is FAIL.
# @invariant  2. Steps run in the declared order; the on-chain probe runs last.
# @invariant  3. stderr is merged inside cmd.exe, never via PowerShell's 2>&1
# @invariant     (PS 5.1 wraps native stderr in ErrorRecords and corrupts $?).
# @invariant  4. The header states PASS, FAIL and SKIP as three separate counts, and names
# @invariant     every skipped step so "8 PASS" can never be mistaken for "everything ran".
# @ac         green table + exit 0 on a fully scaffolded tree
# @verify     powershell -NoProfile -File scripts/verify-all.ps1
# @verify     powershell -NoProfile -File scripts/verify-all.ps1 -SkipOnchain
# └── END CONTRACT ───────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [switch] $SkipOnchain,      # offline run: omit the network probes
    [switch] $ShowOutput,       # stream each step's full output, not just failures
    [switch] $Strict            # pass -Strict through to gates.ps1
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Resolves a tool to a runnable path. PATH first, then the known install locations —
# `sui` is installed to %LOCALAPPDATA%\sui\sui.exe (RECON R2) and a shell started before
# that PATH entry existed will not see it. Returns $null when genuinely unavailable.
function Resolve-Tool {
    param([string] $Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $Name }
    $fallbacks = @{
        'sui'  = @("$env:LOCALAPPDATA\sui\sui.exe", "$env:USERPROFILE\.cargo\bin\sui.exe")
        'node' = @("$env:ProgramFiles\nodejs\node.exe")
        'npm'  = @("$env:ProgramFiles\nodejs\npm.cmd")
    }
    foreach ($p in ($fallbacks[$Name])) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Get-NpmScripts {
    param([string] $Dir)
    $pkg = Join-Path $RepoRoot "$Dir/package.json"
    if (-not (Test-Path -LiteralPath $pkg)) { return $null }
    try {
        $json = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
    }
    catch { return $null }
    if (-not $json.scripts) { return @{} }
    $map = @{}
    foreach ($p in $json.scripts.PSObject.Properties) { $map[$p.Name] = $p.Value }
    return $map
}

# Does <Dir> contain at least one test file whose name matches <Pattern>? Used by the
# clearing-parity step: `vitest run clearing` against a tree with no clearing test exits 1
# ("No test files found"), which would read as a FAILING parity gate when the truth is that
# the parity test has not been written yet. Those are different facts and must look different.
function Test-HasTestMatching {
    param([string] $Dir, [string] $Pattern)
    $root = Join-Path $RepoRoot $Dir
    if (-not (Test-Path -LiteralPath $root)) { return $false }
    $hits = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ts' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.Name -match $Pattern })
    return ($hits.Count -gt 0)
}

# Runs a command inside cmd.exe so stderr merges natively (see @invariant 3).
function Invoke-Step {
    param([string] $Dir, [string] $Command)
    $wd = if ($Dir -eq '.') { $RepoRoot } else { Join-Path $RepoRoot $Dir }
    $output = & cmd /c "cd /d ""$wd"" && $Command 2>&1"
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
}

# ── ordered step table ───────────────────────────────────────────────────────
# NeedsTestMatching = @(<dir>, <filename regex>): SKIP when no such test file exists, so a
# not-yet-written gate is amber, not red and never green.
$Steps = @(
    [pscustomobject]@{ Name = 'move build'; Dir = 'move'; Command = 'sui move build'; NeedsFile = 'Move.toml'; NeedsTool = 'sui'; NpmScript = $null; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'move test'; Dir = 'move'; Command = 'sui move test'; NeedsFile = 'Move.toml'; NeedsTool = 'sui'; NpmScript = $null; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'sdk typecheck'; Dir = 'sdk'; Command = 'npm run typecheck'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'typecheck'; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'sdk test'; Dir = 'sdk'; Command = 'npm test'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'test'; NeedsTestMatching = @('sdk', '\.test\.ts$') }
    [pscustomobject]@{ Name = 'keeper typecheck'; Dir = 'keeper'; Command = 'npm run typecheck'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'typecheck'; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'keeper build'; Dir = 'keeper'; Command = 'npm run build'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'build'; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'keeper test'; Dir = 'keeper'; Command = 'npm test'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'test'; NeedsTestMatching = @('keeper', '\.test\.ts$') }
    # DESIGN-V2 §9 L3 — the release gate. Its own row on purpose.
    [pscustomobject]@{ Name = 'clearing parity'; Dir = 'sdk'; Command = 'npm test -- clearing'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'test'; NeedsTestMatching = @('sdk', 'clearing.*\.test\.ts$') }
    [pscustomobject]@{ Name = 'app build'; Dir = 'app'; Command = 'npm run build'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'build'; NeedsTestMatching = $null }
    # B14 — this row is the fix. Without it an app regression passes the master gate.
    [pscustomobject]@{ Name = 'app test'; Dir = 'app'; Command = 'npm test'; NeedsFile = 'package.json'; NeedsTool = 'npm'; NpmScript = 'test'; NeedsTestMatching = @('app', '\.test\.tsx?$') }
    [pscustomobject]@{ Name = 'gates'; Dir = '.'; Command = "powershell -NoProfile -ExecutionPolicy Bypass -File ""scripts\gates.ps1"" all$(if ($Strict) { ' -Strict' })"; NeedsFile = 'scripts/gates.ps1'; NeedsTool = $null; NpmScript = $null; NeedsTestMatching = $null }
    [pscustomobject]@{ Name = 'verify-onchain'; Dir = '.'; Command = 'node scripts\verify-onchain.mjs'; NeedsFile = 'scripts/verify-onchain.mjs'; NeedsTool = 'node'; NpmScript = $null; NeedsTestMatching = $null }
)

Write-Host ''
Write-Host 'Aphotic x Hashi — verify-all' -ForegroundColor Cyan
Write-Host "  repo  : $RepoRoot"
Write-Host "  time  : $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')"
Write-Host "  steps : $($Steps.Count)"
Write-Host ''

$results = @()

foreach ($s in $Steps) {
    if ($SkipOnchain -and $s.Name -eq 'verify-onchain') {
        $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = '-SkipOnchain requested'; Output = @() }
        Write-Host ("[SKIP] {0,-17} -SkipOnchain requested" -f $s.Name) -ForegroundColor Yellow
        continue
    }

    # Tree not scaffolded yet?
    $where = if ($s.Dir -eq '.') { $s.NeedsFile } else { "$($s.Dir)/$($s.NeedsFile)" }
    if ($s.NeedsFile -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot $where))) {
        $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = "$where not present"; Output = @() }
        Write-Host ("[SKIP] {0,-17} {1} not present" -f $s.Name, $where) -ForegroundColor Yellow
        continue
    }

    # Toolchain missing?
    $command = $s.Command
    if ($s.NeedsTool) {
        $tool = Resolve-Tool $s.NeedsTool
        if (-not $tool) {
            $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = "$($s.NeedsTool) not found on PATH or in its known install location"; Output = @() }
            Write-Host ("[SKIP] {0,-17} {1} not found" -f $s.Name, $s.NeedsTool) -ForegroundColor Yellow
            continue
        }
        if ($tool -ne $s.NeedsTool) {
            # Substitute the resolved absolute path for the leading token.
            $command = '"' + $tool + '"' + $s.Command.Substring($s.NeedsTool.Length)
        }
    }

    # npm script not declared yet?
    if ($s.NpmScript) {
        $scripts = Get-NpmScripts $s.Dir
        if ($null -eq $scripts -or -not $scripts.ContainsKey($s.NpmScript)) {
            $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = "no `"$($s.NpmScript)`" script in $($s.Dir)/package.json"; Output = @() }
            Write-Host ("[SKIP] {0,-17} no ""{1}"" script in {2}/package.json" -f $s.Name, $s.NpmScript, $s.Dir) -ForegroundColor Yellow
            continue
        }
        if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "$($s.Dir)/node_modules"))) {
            $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = "$($s.Dir)/node_modules absent — run npm install"; Output = @() }
            Write-Host ("[SKIP] {0,-17} {1}/node_modules absent — run npm install" -f $s.Name, $s.Dir) -ForegroundColor Yellow
            continue
        }
    }

    # The test file this step exists to run has not been written yet?
    if ($s.NeedsTestMatching) {
        $td = $s.NeedsTestMatching[0]; $tp = $s.NeedsTestMatching[1]
        if (-not (Test-HasTestMatching $td $tp)) {
            $results += [pscustomobject]@{ Name = $s.Name; Status = 'SKIP'; Seconds = 0; Note = "no test file matching /$tp/ under $td/ — NOT WRITTEN YET"; Output = @() }
            Write-Host ("[SKIP] {0,-17} no test file matching /{1}/ under {2}/ — NOT WRITTEN YET" -f $s.Name, $tp, $td) -ForegroundColor Yellow
            continue
        }
    }

    Write-Host ("[ .. ] {0,-17} {1}" -f $s.Name, $command) -ForegroundColor DarkGray
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $run = Invoke-Step $s.Dir $command
    $sw.Stop()
    $status = if ($run.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    $results += [pscustomobject]@{
        Name = $s.Name; Status = $status; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        Note = "exit $($run.ExitCode)"; Output = $run.Output
    }

    if ($status -eq 'PASS') {
        Write-Host ("[PASS] {0,-17} {1}s" -f $s.Name, [math]::Round($sw.Elapsed.TotalSeconds, 1)) -ForegroundColor Green
        if ($ShowOutput) { $run.Output | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray } }
    }
    else {
        Write-Host ("[FAIL] {0,-17} exit {1} after {2}s" -f $s.Name, $run.ExitCode, [math]::Round($sw.Elapsed.TotalSeconds, 1)) -ForegroundColor Red
        $tail = if ($ShowOutput) { $run.Output } else { $run.Output | Select-Object -Last 30 }
        $tail | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
    }
}

# ── summary ──────────────────────────────────────────────────────────────────
$pass = @($results | Where-Object { $_.Status -eq 'PASS' }).Count
$fail = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$skip = @($results | Where-Object { $_.Status -eq 'SKIP' }).Count
$skipped = @($results | Where-Object { $_.Status -eq 'SKIP' } | ForEach-Object { $_.Name })

Write-Host ''
Write-Host ('  {0,-17} {1,-6} {2,-8} {3}' -f 'STEP', 'RESULT', 'SECONDS', 'NOTE')
Write-Host ('  ' + ('-' * 78))
foreach ($r in $results) {
    $color = 'Gray'
    if ($r.Status -eq 'PASS') { $color = 'Green' } elseif ($r.Status -eq 'FAIL') { $color = 'Red' } elseif ($r.Status -eq 'SKIP') { $color = 'Yellow' }
    Write-Host ('  {0,-17} {1,-6} {2,-8} {3}' -f $r.Name, $r.Status, $r.Seconds, $r.Note) -ForegroundColor $color
}
Write-Host ''
Write-Host ("  RESULT: {0} PASS · {1} FAIL · {2} SKIP   (of {3} steps)" -f $pass, $fail, $skip, $results.Count) -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { 'Green' })
if ($skip -gt 0) {
    Write-Host ("  SKIP IS NOT GREEN. Did not run: {0}" -f ($skipped -join ', ')) -ForegroundColor Yellow
    Write-Host '  The cut line requires move/, sdk/, keeper/ and app/ to ALL run.' -ForegroundColor Yellow
}
Write-Host ''

if ($fail -gt 0) { exit 1 }
exit 0
