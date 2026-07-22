<#
  verify-windows-package.ps1 — post-package release gate (plan §4.4).

  Run after `npm run dist:win`:
      npm run verify:package

  Asserts the artifacts exist, that every native binary the packaged app needs at
  runtime is actually unpacked (not stranded inside app.asar), that no build-time
  tooling shipped, that Lares.exe carries the right version resources, that the
  build is unsigned exactly as the docs claim, and that the app really launches
  and opens its database.

  Exits non-zero on any hard failure. Warnings do not fail the run.
#>

[CmdletBinding()]
param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not reliably populated inside a param() default under Windows
# PowerShell 5.1, so resolve the repo root in the body instead.
if (-not $Root) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = Split-Path -Parent $scriptDir
}

$script:Failures = @()
$script:Warnings = @()

function Pass([string]$name, [string]$detail) {
  Write-Host ("  PASS  {0}{1}" -f $name, $(if ($detail) { " - $detail" } else { "" }))
}
function Fail([string]$name, [string]$detail) {
  $script:Failures += "${name}: $detail"
  Write-Host ("  FAIL  {0} - {1}" -f $name, $detail) -ForegroundColor Red
}
function Warn([string]$name, [string]$detail) {
  $script:Warnings += "${name}: $detail"
  Write-Host ("  WARN  {0} - {1}" -f $name, $detail) -ForegroundColor Yellow
}

function Assert-NonEmptyFile([string]$name, [string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { Fail $name "missing: $path"; return $null }
  $item = Get-Item -LiteralPath $path
  if ($item.Length -le 0) { Fail $name "zero bytes: $path"; return $null }
  Pass $name ("{0} ({1:N1} MB)" -f (Split-Path -Leaf $path), ($item.Length / 1MB))
  return $item
}

$pkg = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$release = Join-Path $Root 'release'
$unpackedRoot = Join-Path $release 'win-unpacked'
$resources = Join-Path $unpackedRoot 'resources'
$asarUnpacked = Join-Path $resources 'app.asar.unpacked'

Write-Host "== verify:package ==  version=$version  release=$release"

if (-not (Test-Path -LiteralPath $release)) {
  Write-Host "  FAIL  release directory missing: $release - run 'npm run dist:win' first" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Artifacts
# ---------------------------------------------------------------------------
Write-Host "`n[1] artifacts"
$setup = Assert-NonEmptyFile 'installer' (Join-Path $release "Lares-Setup-$version-x64.exe")
$portable = Assert-NonEmptyFile 'portable' (Join-Path $release "Lares-Portable-$version-x64.exe")

if ($setup) {
  $sizeMb = $setup.Length / 1MB
  if ($sizeMb -gt 400) {
    Warn 'installer size' ("{0:N1} MB exceeds the ~400 MB sanity gate - inspect the bundle for bloat" -f $sizeMb)
  } else {
    Pass 'installer size' ("{0:N1} MB (under the ~400 MB sanity gate)" -f $sizeMb)
  }
}

# ---------------------------------------------------------------------------
# 2. Unpacked native binaries
# ---------------------------------------------------------------------------
# Assert on the PRESENCE of unpacked binaries, never on the absence of the
# package from the asar: a package's JavaScript may legitimately stay inside the
# asar while only its binaries are unpacked.
Write-Host "`n[2] unpacked natives"
if (-not (Test-Path -LiteralPath $unpackedRoot)) {
  Fail 'win-unpacked' "missing: $unpackedRoot"
} else {
  $nativeChecks = @(
    @{ Name = 'better-sqlite3 binding'; Path = Join-Path $asarUnpacked 'node_modules\better-sqlite3\build\Release\better_sqlite3.node' }
    @{ Name = 'lares-native binary';    Path = Join-Path $resources 'native\lares-native\build\Release\lares_native.node' }
    @{ Name = 'lares-native index.js';  Path = Join-Path $resources 'native\lares-native\index.js' }
  )
  foreach ($c in $nativeChecks) {
    if (Test-Path -LiteralPath $c.Path) { Pass $c.Name (Resolve-Path -LiteralPath $c.Path).Path }
    else { Fail $c.Name "missing: $($c.Path)" }
  }

  # node-pty: the .node binding AND winpty-agent.exe (the agent is what
  # **/*.node alone would miss).
  $ptyDir = Join-Path $asarUnpacked 'node_modules\node-pty'
  $ptyNode = @(Get-ChildItem -LiteralPath $ptyDir -Recurse -Filter '*.node' -ErrorAction SilentlyContinue)
  if ($ptyNode.Count -gt 0) { Pass 'node-pty binding' ($ptyNode[0].FullName) }
  else { Fail 'node-pty binding' "no .node found under $ptyDir" }

  $winpty = @(Get-ChildItem -LiteralPath $ptyDir -Recurse -Filter 'winpty-agent.exe' -ErrorAction SilentlyContinue)
  if ($winpty.Count -gt 0) { Pass 'winpty-agent.exe' ($winpty[0].FullName) }
  else { Fail 'winpty-agent.exe' "not found under $ptyDir" }

  # PDFium ships its engine as a .wasm, not a .node.
  $pdfDir = Join-Path $asarUnpacked 'node_modules\@hyzyla\pdfium'
  $pdfBin = @(Get-ChildItem -LiteralPath $pdfDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.wasm', '.node' })
  if ($pdfBin.Count -gt 0) { Pass 'pdfium binary' ($pdfBin[0].FullName) }
  else { Fail 'pdfium binary' "no .wasm/.node found under $pdfDir" }
}

# ---------------------------------------------------------------------------
# 3. Bundle hygiene - no build tooling inside the asar
# ---------------------------------------------------------------------------
Write-Host "`n[3] bundle hygiene"
$asar = Join-Path $resources 'app.asar'
if (-not (Test-Path -LiteralPath $asar)) {
  Fail 'app.asar' "missing: $asar"
} else {
  try {
    $listing = & npx --no-install asar list $asar 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $listing) {
      Warn 'asar list' "could not enumerate $asar (npx asar unavailable) - hygiene check skipped"
    } else {
      $tooling = $listing | Select-String -Pattern 'node_modules[\\/](typescript|vite|vitest|electron-builder)[\\/]'
      if ($tooling) {
        Fail 'build tooling in asar' ("{0} matching entries, e.g. {1}" -f $tooling.Count, $tooling[0].Line)
      } else {
        Pass 'build tooling in asar' 'no typescript/vite/vitest/electron-builder entries'
      }
    }
  } catch {
    Warn 'asar list' "asar enumeration failed: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------------------
# 4. Lares.exe metadata + signature status
# ---------------------------------------------------------------------------
Write-Host "`n[4] executable metadata"
$exe = Join-Path $unpackedRoot 'Lares.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  Fail 'Lares.exe' "missing: $exe"
} else {
  # These come from rcedit, which only runs while signAndEditExecutable is NOT
  # disabled. A regression on that decision (plan §3.1) shows up right here.
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  if ($vi.ProductName -eq 'Lares') { Pass 'ProductName' $vi.ProductName }
  else { Fail 'ProductName' "expected 'Lares', got '$($vi.ProductName)'" }

  if ($vi.FileVersion -and $vi.FileVersion.StartsWith($version)) { Pass 'FileVersion' $vi.FileVersion }
  else { Fail 'FileVersion' "expected to start with '$version', got '$($vi.FileVersion)'" }

  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  if ($sig.Status -eq 'NotSigned') {
    Pass 'signature' 'NotSigned (matches the documented unsigned 0.2.0 release)'
  } else {
    Fail 'signature' "expected NotSigned (the docs claim unsigned), got $($sig.Status)"
  }
}

# ---------------------------------------------------------------------------
# 5. Isolated launch smoke
# ---------------------------------------------------------------------------
# This works specifically because src/main/database.ts reads process.env.APPDATA
# directly (ground truth F9) to place dashboard.db. If a future refactor "cleans
# up" that path to app.getPath('userData'), this isolation silently stops
# isolating and the assertion below must be rewritten - do not just delete it.
Write-Host "`n[5] isolated launch smoke"
# Overriding APPDATA isolates the DATABASE, but not Electron's single-instance
# lock: a dev `npm run start` (or an installed Lares) already holds it, and the
# smoke process would exit immediately with "Another instance is already
# running". That is an environment precondition, not a packaging defect, so
# detect it up front and skip loudly rather than emitting a fake pass or a
# misleading fail. On CI / a clean VM nothing else is running and it always runs.
$otherInstances = @(Get-Process -Name 'Lares', 'electron' -ErrorAction SilentlyContinue)
if ($otherInstances.Count -gt 0) {
  Warn 'launch smoke' ('SKIPPED - {0} Lares/electron process(es) already running hold Electron''s single-instance lock. Close all Lares instances (including a dev "npm run start") and re-run to exercise this gate.' -f $otherInstances.Count)
} elseif (Test-Path -LiteralPath $exe) {
  $tempProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("lares-verify-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempProfile -Force | Out-Null
  $stdout = Join-Path $tempProfile 'stdout.log'
  $stderr = Join-Path $tempProfile 'stderr.log'
  $proc = $null
  try {
    $prevAppData = $env:APPDATA
    $env:APPDATA = $tempProfile
    $proc = Start-Process -FilePath $exe -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $env:APPDATA = $prevAppData

    Start-Sleep -Seconds 20

    if ($proc.HasExited) {
      Fail 'launch smoke' "Lares.exe exited early with code $($proc.ExitCode)"
    } else {
      Pass 'launch smoke' "process alive (pid $($proc.Id)) after 20s"
    }

    $db = Join-Path $tempProfile 'AgentDashboard\dashboard.db'
    if (Test-Path -LiteralPath $db) {
      Pass 'database created' $db
    } else {
      # Treat failure to open SQLite as a hard release blocker.
      Fail 'database created' "expected $db - the packaged app did not open its SQLite database"
    }

    $output = @()
    foreach ($f in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $f) { $output += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) }
    }
    $joined = ($output -join "`n")
    $abi = $joined | Select-String -Pattern 'NODE_MODULE_VERSION|was compiled against a different Node\.js version|Cannot find module|invalid ELF|is not a valid Win32 application'
    if ($abi) {
      Fail 'no module-load errors' ("module/ABI error in app output: " + $abi[0].Line.Trim())
    } else {
      Pass 'no module-load errors' 'no ABI / missing-module text in stdout+stderr'
    }
    if ($joined -match 'lares-native not loadable') {
      Warn 'lares-native' 'the packaged app logged "lares-native not loadable" - watchdog runs degraded (plan §4.3 go/no-go)'
    }
  } finally {
    if ($proc -and -not $proc.HasExited) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      Start-Sleep -Seconds 2
    }
    # Remove only the temp profile this script created.
    if (Test-Path -LiteralPath $tempProfile) {
      try { Remove-Item -LiteralPath $tempProfile -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
} else {
  Fail 'launch smoke' 'skipped - Lares.exe missing'
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
if ($script:Warnings.Count -gt 0) {
  Write-Host "verify:package - $($script:Warnings.Count) warning(s):" -ForegroundColor Yellow
  foreach ($w in $script:Warnings) { Write-Host "  ! $w" -ForegroundColor Yellow }
}
if ($script:Failures.Count -gt 0) {
  Write-Host "verify:package - FAILED ($($script:Failures.Count)):" -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host "  x $f" -ForegroundColor Red }
  exit 1
}
Write-Host "verify:package - OK" -ForegroundColor Green
exit 0
