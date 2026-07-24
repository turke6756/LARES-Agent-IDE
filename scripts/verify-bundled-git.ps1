<#
  verify-bundled-git.ps1 - the bundled-Git gate (Git-Native WP-G0.5, EXIT GATE G0').

  WHAT THIS PROVES, AND WHY NOTHING ELSE CAN
  ------------------------------------------
  WP-G0.2 chose Lares' internal git and WP-G0.4 shims `git` onto the agent PTY's
  PATH. Unit tests prove the *selection logic* with injected candidates; they
  cannot prove that, on a machine with NO git anywhere on PATH, the real bundled
  MinGit payload actually resolves, actually runs, and actually reads its own
  system config. This script does, against a fetched payload.

  It asserts three things in a git-stripped PATH:
    [1] INTERNAL resolution picks the bundled git.exe (the .staging/mingit payload
        or the packaged resources\mingit payload), and it runs `git --version`.
    [2] A spawned shell (child cmd.exe) with the shim dir appended resolves `git`
        to the shim, which forwards to the bundled git.exe.
    [3] `git config --system core.longpaths` reads `true` from the bundled
        etc\gitconfig (proving the WP-G0.5 system-gitconfig shipped and loads).

  This is a MANUAL / CI verification script. It needs a real fetched payload
  (`npm run fetch:mingit`, which itself needs the manifest pinned - Open #1) or a
  packaged build. It is NOT part of the unit suite. When no payload is staged it
  exits NONZERO with a clear message rather than faking a pass.

      npm run fetch:mingit        # once the manifest is pinned
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-bundled-git.ps1
#>

[CmdletBinding()]
param(
  # Repo root. Defaults to the parent of this script's directory.
  [string]$Root = '',
  # Explicit path to a staged/packaged `mingit` payload dir (the one that
  # contains cmd\git.exe and etc\gitconfig). Auto-discovered when omitted.
  [string]$PayloadDir = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = Split-Path -Parent $scriptDir
}

$script:Failures = @()

function Pass([string]$name, [string]$detail) {
  Write-Host ("  PASS  {0}{1}" -f $name, $(if ($detail) { " - $detail" } else { "" })) -ForegroundColor Green
}
function Fail([string]$name, [string]$detail) {
  $script:Failures += "${name}: $detail"
  Write-Host ("  FAIL  {0} - {1}" -f $name, $detail) -ForegroundColor Red
}

function New-TempDir([string]$tag) {
  $p = Join-Path ([System.IO.Path]::GetTempPath()) ("lares-$tag-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  return $p
}

# ---------------------------------------------------------------------------
# [0] Locate a staged/packaged MinGit payload
# ---------------------------------------------------------------------------
Write-Host "== verify:bundled-git ==  root=$Root"
Write-Host "`n[0] locate the bundled MinGit payload"

if (-not $PayloadDir) {
  $candidates = @(
    (Join-Path $Root 'third_party\git-for-windows\.staging\mingit'),
    (Join-Path $Root 'release\win-unpacked\resources\mingit'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Lares\resources\mingit')
  )
  $PayloadDir = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'cmd\git.exe') } | Select-Object -First 1
}

if (-not $PayloadDir -or -not (Test-Path -LiteralPath (Join-Path $PayloadDir 'cmd\git.exe'))) {
  Fail 'bundled payload' ("no staged/packaged MinGit payload found (looked for cmd\git.exe under .staging\mingit and resources\mingit). " +
    "Run 'npm run fetch:mingit' after the manifest is pinned (Open #1), or point -PayloadDir at a payload.")
  Write-Host "`nverify:bundled-git - FAILED (nothing to test; payload not staged)" -ForegroundColor Red
  exit 1
}
$PayloadDir = (Resolve-Path -LiteralPath $PayloadDir).Path
$bundledGit = Join-Path $PayloadDir 'cmd\git.exe'
Pass 'bundled payload' $PayloadDir

$etcGitconfig = Join-Path $PayloadDir 'etc\gitconfig'
if (Test-Path -LiteralPath $etcGitconfig) { Pass 'bundled etc\gitconfig' $etcGitconfig }
else { Fail 'bundled etc\gitconfig' "missing: $etcGitconfig (WP-G0.5 must copy system-gitconfig here)" }

# ---------------------------------------------------------------------------
# Build a git-stripped PATH and PROVE it is git-free
# ---------------------------------------------------------------------------
$strippedPath = @(
  (Join-Path $env:SystemRoot 'system32'),
  $env:SystemRoot,
  (Join-Path $env:SystemRoot 'System32\Wbem'),
  (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
) -join ';'

$leaked = @()
foreach ($d in $strippedPath.Split(';')) {
  if ($d -and (Test-Path -LiteralPath (Join-Path $d 'git.exe'))) { $leaked += (Join-Path $d 'git.exe') }
}

$savedPath = $env:PATH
$gitIsHidden = $false
if ($leaked.Count -gt 0) {
  Fail 'git.exe hidden' ("the stripped PATH still contains git.exe: " + ($leaked -join ', ') + " - run the gate on a clean VM instead")
} else {
  $env:PATH = $strippedPath
  try {
    $found = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "where git 2>nul"
    $whereCode = $LASTEXITCODE
  } finally {
    $env:PATH = $savedPath
  }
  if ($whereCode -eq 0 -and $found) {
    Fail 'git.exe hidden' ("`where git` still resolved to: " + ($found -join ', '))
  } else {
    $gitIsHidden = $true
    Pass 'git.exe hidden' "PATH stripped to 4 Windows dirs; 'where git' finds nothing. This is what a git-free machine looks like."
  }
}

# ---------------------------------------------------------------------------
# [1] The bundled git.exe runs
# ---------------------------------------------------------------------------
Write-Host "`n[1] bundled git.exe runs (internal resolution target)"
try {
  $ver = & $bundledGit --version 2>&1
  if ($LASTEXITCODE -eq 0 -and ($ver -join '') -match 'git version') {
    Pass 'bundled git --version' (($ver | Select-Object -First 1).Trim())
  } else {
    Fail 'bundled git --version' "unexpected output: $($ver -join ' ')"
  }
} catch {
  Fail 'bundled git --version' $_.Exception.Message
}

# ---------------------------------------------------------------------------
# [2] A spawned shell resolves the shimmed `git` -> bundled git.exe
# ---------------------------------------------------------------------------
# Mirror WP-G0.4's shim: a git.cmd forwarding to the bundled git.exe, appended
# to a git-free PATH. A child cmd.exe must resolve bare `git` to it.
Write-Host "`n[2] spawned shell resolves the shimmed git"
if (-not $gitIsHidden) {
  Fail 'shim resolution' 'the git-free PATH could not be established (see [0])'
} else {
  $shimDir = Join-Path (New-TempDir 'git shim') 'git-shim'
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  $gitCmd = "@echo off`r`n`"$bundledGit`" %*`r`n"
  [System.IO.File]::WriteAllText((Join-Path $shimDir 'git.cmd'), $gitCmd, (New-Object System.Text.ASCIIEncoding))

  try {
    $env:PATH = $strippedPath + ';' + $shimDir
    $whereOut = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "where git 2>nul"
    $whereFirst = @($whereOut | Where-Object { $_ }) | Select-Object -First 1
    if ($whereFirst -and ($whereFirst.Trim().ToLower() -eq (Join-Path $shimDir 'git.cmd').ToLower())) {
      Pass 'shim on PATH' "spawned shell resolves 'git' to the shim: $($whereFirst.Trim())"
    } else {
      Fail 'shim on PATH' "expected the shim's git.cmd first; 'where git' returned: $($whereOut -join ', ')"
    }

    $shimVer = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "git --version 2>nul"
    if (($shimVer -join '') -match 'git version') {
      Pass 'shim forwards to bundled git' (($shimVer | Where-Object { $_ } | Select-Object -First 1).Trim())
    } else {
      Fail 'shim forwards to bundled git' "no version came back through the shim (got: '$($shimVer -join ' ')')"
    }
  } finally {
    $env:PATH = $savedPath
  }
}

# ---------------------------------------------------------------------------
# [3] git config --system core.longpaths reads true from the bundled config
# ---------------------------------------------------------------------------
# Point the bundled git at its own payload as the "system" scope. GIT_CONFIG_SYSTEM
# (git >= 2.32) overrides the system config path; the value the bundled git ships
# is mingit\etc\gitconfig containing `[core] longpaths = true`.
Write-Host "`n[3] git config --system core.longpaths == true (bundled config)"
try {
  $savedGcs = $env:GIT_CONFIG_SYSTEM
  $env:GIT_CONFIG_SYSTEM = $etcGitconfig
  $env:PATH = $strippedPath
  try {
    $lp = & $bundledGit config --system core.longpaths 2>&1
    $lpCode = $LASTEXITCODE
  } finally {
    $env:PATH = $savedPath
    if ($null -eq $savedGcs) { Remove-Item -LiteralPath 'Env:GIT_CONFIG_SYSTEM' -ErrorAction SilentlyContinue }
    else { $env:GIT_CONFIG_SYSTEM = $savedGcs }
  }
  if ($lpCode -eq 0 -and ($lp -join '').Trim() -eq 'true') {
    Pass 'core.longpaths (system)' 'true - the bundled etc\gitconfig loads as the system scope'
  } else {
    Fail 'core.longpaths (system)' "expected 'true' (exit 0); got '$(( $lp -join ' ').Trim())' (exit $lpCode)"
  }
} catch {
  Fail 'core.longpaths (system)' $_.Exception.Message
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
if ($script:Failures.Count -gt 0) {
  Write-Host "verify:bundled-git - FAILED ($($script:Failures.Count)):" -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host "  x $f" -ForegroundColor Red }
  exit 1
}
Write-Host "verify:bundled-git - OK" -ForegroundColor Green
exit 0
