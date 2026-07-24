<#
  verify-bundled-node.ps1 - the hidden-Node gate (plan 5, verification matrix V10 + V11).

  WHAT THIS PROVES, AND WHY NOTHING ELSE CAN
  ------------------------------------------
  Phase 3 replaced every `spawn('node', ...)` with the Node runtime bundled inside
  Electron (`Lares.exe` + ELECTRON_RUN_AS_NODE=1). Unit tests can only prove which
  command string we *chose*. They cannot prove that that command actually boots a
  helper, that node-pty resolves out of app.asar.unpacked, or that an MCP sidecar
  completes a handshake - on a machine with no Node.js. This script does.

  YOU MUST CLOSE LARES FIRST. Electron's single-instance lock makes the launch
  check meaningless while another copy is running, and this script deliberately
  refuses to fake a pass: it skips loudly instead.

      # close every Lares window (and any dev `npm run start`), then:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-bundled-node.ps1

  Checks:
    [0] The packaged tree exists.
    [1] The environment really has no reachable node.exe (the simulation is honest).
    [2] The packaged app launches under that stripped environment, opens its DB,
        and logs no module-load error.
    [3] V10 - a cmd.exe PTY opens through the packaged pty-host and echoes a
        sentinel. Proves the bundled runtime + node-pty resolution, independent of
        any provider CLI.
    [4] V11 - an MCP sidecar completes a JSON-RPC initialize handshake AND lists
        its tools. A working PTY does NOT prove this: it is a different runtime
        entry point (resources\scripts, outside the asar) and a different failure
        mode. Deliberately kept separate from [3].

  Exit code is non-zero on any FAIL. WARN/SKIP never fails the run, but a SKIP
  means the gate did not execute - re-run until [3] and [4] both report PASS.
#>

[CmdletBinding()]
param(
  # Repo root. Defaults to the parent of this script's directory.
  [string]$Root = '',
  # Which packaged Lares.exe to exercise. Defaults to release\win-unpacked\Lares.exe,
  # falling back to an installed copy under %LOCALAPPDATA%\Programs\Lares.
  [string]$Exe = '',
  # Seconds to wait for the GUI launch check in [2].
  [int]$LaunchWaitSeconds = 20,
  # Optional path to a scaffolded workspace root (the folder that CONTAINS
  # `.lares\scripts\dashboard-status.mjs`). When provided, [5] additionally
  # exercises the REAL status hook + status line through the shim. Skipped when
  # absent — the shim contract (5a-5d) is proven regardless.
  [string]$Workspace = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = Split-Path -Parent $scriptDir
}

$script:Failures = @()
$script:Warnings = @()

function Pass([string]$name, [string]$detail) {
  Write-Host ("  PASS  {0}{1}" -f $name, $(if ($detail) { " - $detail" } else { "" })) -ForegroundColor Green
}
function Fail([string]$name, [string]$detail) {
  $script:Failures += "${name}: $detail"
  Write-Host ("  FAIL  {0} - {1}" -f $name, $detail) -ForegroundColor Red
}
function Warn([string]$name, [string]$detail) {
  $script:Warnings += "${name}: $detail"
  Write-Host ("  WARN  {0} - {1}" -f $name, $detail) -ForegroundColor Yellow
}
function Skip([string]$name, [string]$detail) {
  # A skip is louder than a warning on purpose: it means the gate did not run.
  $script:Warnings += "${name}: SKIPPED - $detail"
  Write-Host ("  SKIP  {0} - {1}" -f $name, $detail) -ForegroundColor Magenta
}

function New-TempDir([string]$tag) {
  $p = Join-Path ([System.IO.Path]::GetTempPath()) ("lares-$tag-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  return $p
}

function Read-AllText([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  $t = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $t) { return '' }
  return $t
}

# ---------------------------------------------------------------------------
# [0] Locate the packaged tree
# ---------------------------------------------------------------------------
Write-Host "== verify:bundled-node ==  root=$Root"
Write-Host "`n[0] packaged tree"

if (-not $Exe) {
  $candidates = @(
    (Join-Path $Root 'release\win-unpacked\Lares.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Lares\Lares.exe')
  )
  $Exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) {
  Fail 'packaged Lares.exe' "not found. Build it with 'npm run dist:win' (or pass -Exe <path>). Checked release\win-unpacked and %LOCALAPPDATA%\Programs\Lares."
  Write-Host "`nverify:bundled-node - FAILED (nothing to test)" -ForegroundColor Red
  exit 1
}
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$appDir = Split-Path -Parent $Exe
$resources = Join-Path $appDir 'resources'
$asar = Join-Path $resources 'app.asar'
Pass 'packaged Lares.exe' $Exe

if (Test-Path -LiteralPath $asar) { Pass 'app.asar' $asar }
else { Fail 'app.asar' "missing: $asar" }

$mcpScript = Join-Path $resources 'scripts\mcp-dashboard.js'
if (Test-Path -LiteralPath $mcpScript) { Pass 'mcp sidecar script' $mcpScript }
else { Fail 'mcp sidecar script' "missing: $mcpScript (extraResources should copy scripts\ to resources\scripts)" }

# The PTY helper now lives INSIDE app.asar (plan 5.1). PowerShell cannot see
# into an asar, so its exact path is discovered in [3] by trying each candidate
# and reporting which one the Electron runtime actually resolved.
$ptyHostCandidates = @(
  'dist\main\main\pty-host.js',
  'main\main\pty-host.js'
)
if (Test-Path -LiteralPath (Join-Path $resources 'scripts\pty-host.js')) {
  Fail 'pty-host location' "a pty-host.js still ships in resources\scripts - from there no node_modules is on the resolution path and require('node-pty') dies (ground truth F5). Plan 5.1 moved it to src/main/."
}

# ---------------------------------------------------------------------------
# [1] Make node.exe unreachable, and PROVE it is unreachable
# ---------------------------------------------------------------------------
Write-Host "`n[1] hidden-Node environment"

# Report every resolution route we know of, before hiding anything, so the run
# log records what the machine actually had.
$realNode = $null
try { $realNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source } catch { }
if ($realNode) { Write-Host "        this machine HAS node at: $realNode" }
else { Write-Host "        this machine has no node.exe on PATH (already clean)" }

foreach ($v in @('NVM_HOME', 'NVM_SYMLINK', 'NODE', 'NODE_PATH', 'NODE_OPTIONS')) {
  $val = [Environment]::GetEnvironmentVariable($v)
  if ($val) { Write-Host "        env $v = $val  (will be cleared)" }
}
# App Paths is a ShellExecute-only route: CreateProcess (what Node/Electron's
# child_process uses) does NOT consult it. Recorded for completeness so a future
# reader does not assume it was overlooked.
foreach ($hive in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\node.exe',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\node.exe')) {
  if (Test-Path -LiteralPath $hive) {
    Write-Host "        registry App Paths entry exists: $hive (ShellExecute-only; CreateProcess ignores it)"
  }
}

# A minimal Windows PATH. Anything Node-ish (nvm shims, %APPDATA%\npm, Program
# Files\nodejs, a Git-Bash-provided node) is gone by construction.
$strippedPath = @(
  (Join-Path $env:SystemRoot 'system32'),
  $env:SystemRoot,
  (Join-Path $env:SystemRoot 'System32\Wbem'),
  (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
) -join ';'

# Verify by construction: none of those directories may contain node.exe.
$leaked = @()
foreach ($d in $strippedPath.Split(';')) {
  if ($d -and (Test-Path -LiteralPath (Join-Path $d 'node.exe'))) { $leaked += (Join-Path $d 'node.exe') }
}

$savedEnv = @{}
function Enter-HiddenNodeEnv {
  foreach ($k in @('PATH', 'NVM_HOME', 'NVM_SYMLINK', 'NODE', 'NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE')) {
    $script:savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
  }
  $env:PATH = $strippedPath
  foreach ($k in @('NVM_HOME', 'NVM_SYMLINK', 'NODE', 'NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE')) {
    Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue
  }
}
function Exit-HiddenNodeEnv {
  foreach ($k in $script:savedEnv.Keys) {
    $v = $script:savedEnv[$k]
    if ($null -eq $v) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:$k" -Value $v }
  }
}

$nodeIsHidden = $false
if ($leaked.Count -gt 0) {
  Fail 'node.exe hidden' ("the stripped PATH still contains node.exe: " + ($leaked -join ', ') + " - this machine cannot simulate a clean install; run the gate on a VM instead")
} else {
  Enter-HiddenNodeEnv
  try {
    # `where node` is the same PATH+PATHEXT search CreateProcess performs. The
    # redirect happens INSIDE cmd: `where` writes its "INFO: Could not find
    # files" to stderr, and a PowerShell-side `2>$null` on a native command
    # raises a terminating NativeCommandError under $ErrorActionPreference=Stop.
    $found = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "where node 2>nul"
    $whereCode = $LASTEXITCODE
  } finally {
    Exit-HiddenNodeEnv
  }
  if ($whereCode -eq 0 -and $found) {
    Fail 'node.exe hidden' ("`where node` still resolved to: " + ($found -join ', '))
  } else {
    $nodeIsHidden = $true
    Pass 'node.exe hidden' "PATH stripped to 4 Windows dirs; 'where node' finds nothing (exit $whereCode). This is what a machine with no Node.js looks like."
  }
}

# ---------------------------------------------------------------------------
# Shared child-process runner: stdin from a file, stdout/stderr to files,
# launched with the hidden-Node environment inherited from this process.
# ---------------------------------------------------------------------------
function Invoke-HiddenNodeChild {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$StdinText,
    [hashtable]$ExtraEnv = @{},
    [int]$WaitSeconds = 25,
    [string]$WorkDir
  )
  $dir = New-TempDir 'child'
  $inFile = Join-Path $dir 'stdin.txt'
  $outFile = Join-Path $dir 'stdout.txt'
  $errFile = Join-Path $dir 'stderr.txt'
  # ASCII, no BOM: a UTF-8 BOM in front of the first JSON line makes JSON.parse
  # fail and the whole check would look like a runtime failure.
  [System.IO.File]::WriteAllText($inFile, $StdinText, (New-Object System.Text.ASCIIEncoding))

  $savedExtra = @{}
  foreach ($k in $ExtraEnv.Keys) { $savedExtra[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }

  $proc = $null
  Enter-HiddenNodeEnv
  try {
    foreach ($k in $ExtraEnv.Keys) { Set-Item -LiteralPath "Env:$k" -Value $ExtraEnv[$k] }
    $sp = @{
      FilePath                    = $FilePath
      PassThru                    = $true
      NoNewWindow                 = $true
      RedirectStandardInput       = $inFile
      RedirectStandardOutput      = $outFile
      RedirectStandardError       = $errFile
    }
    if ($Arguments -and $Arguments.Count -gt 0) { $sp['ArgumentList'] = $Arguments }
    if ($WorkDir) { $sp['WorkingDirectory'] = $WorkDir }
    $proc = Start-Process @sp
    $null = $proc.WaitForExit($WaitSeconds * 1000)
  } finally {
    if ($proc -and -not $proc.HasExited) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      Start-Sleep -Milliseconds 500
    }
    foreach ($k in $ExtraEnv.Keys) {
      $v = $savedExtra[$k]
      if ($null -eq $v) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
      else { Set-Item -LiteralPath "Env:$k" -Value $v }
    }
    Exit-HiddenNodeEnv
  }

  return [pscustomobject]@{
    Stdout = Read-AllText $outFile
    Stderr = Read-AllText $errFile
    Dir    = $dir
  }
}

# ---------------------------------------------------------------------------
# [2] The packaged app launches with no Node on PATH
# ---------------------------------------------------------------------------
Write-Host "`n[2] packaged app launches under the hidden-Node environment"

$running = @(Get-Process -Name 'Lares', 'electron' -ErrorAction SilentlyContinue)
if (-not $nodeIsHidden) {
  Skip 'app launch' 'the hidden-Node environment could not be established (see [1])'
} elseif ($running.Count -gt 0) {
  Skip 'app launch' ("{0} Lares/electron process(es) are running and hold Electron's single-instance lock. Close every Lares window (including a dev 'npm run start') and re-run - this check cannot be faked around." -f $running.Count)
} else {
  $profileDir = New-TempDir 'profile'
  $stdout = Join-Path $profileDir 'stdout.log'
  $stderr = Join-Path $profileDir 'stderr.log'
  $proc = $null
  $savedAppData = $env:APPDATA
  Enter-HiddenNodeEnv
  try {
    # APPDATA override isolates the database: src/main/database.ts reads
    # process.env.APPDATA directly (ground truth F9). If that is ever refactored
    # to app.getPath('userData'), this stops isolating - rewrite it, do not delete it.
    $env:APPDATA = $profileDir
    $proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Start-Sleep -Seconds $LaunchWaitSeconds

    if ($proc.HasExited) {
      Fail 'app launch' "Lares.exe exited early with code $($proc.ExitCode) - see $stdout / $stderr"
    } else {
      Pass 'app launch' "alive (pid $($proc.Id)) after ${LaunchWaitSeconds}s with no node.exe reachable"
    }

    $db = Join-Path $profileDir 'AgentDashboard\dashboard.db'
    if (Test-Path -LiteralPath $db) { Pass 'database opens' $db }
    else { Fail 'database opens' "expected $db - the packaged app did not open its SQLite database" }

    $joined = (Read-AllText $stdout) + "`n" + (Read-AllText $stderr)
    $bad = $joined | Select-String -Pattern "NODE_MODULE_VERSION|was compiled against a different Node\.js version|Cannot find module|is not recognized as an internal or external command|ENOENT.*node"
    if ($bad) { Fail 'no module-load errors' ("app output contains: " + $bad[0].Line.Trim()) }
    else { Pass 'no module-load errors' 'stdout+stderr clean of ABI / missing-module / missing-node text' }
  } finally {
    if ($proc -and -not $proc.HasExited) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      Start-Sleep -Seconds 2
    }
    $env:APPDATA = $savedAppData
    Exit-HiddenNodeEnv
    if (Test-Path -LiteralPath $profileDir) {
      try { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
}

# ---------------------------------------------------------------------------
# [3] V10 - a real cmd.exe PTY through the packaged pty-host
# ---------------------------------------------------------------------------
# This drives the SAME helper the Windows runner drives, on the SAME runtime
# (Lares.exe + ELECTRON_RUN_AS_NODE=1), speaking the SAME stdin/stdout JSON
# protocol - just without the supervisor in the loop. If node-pty cannot be
# resolved out of app.asar.unpacked, or Electron-as-Node cannot read an entry
# point inside the asar, it fails here.
Write-Host "`n[3] V10 - cmd.exe PTY through the packaged pty-host"

$SENTINEL = 'LARESPTYOK'
if (-not $nodeIsHidden) {
  Skip 'V10 pty' 'the hidden-Node environment could not be established (see [1])'
} else {
  $workDir = New-TempDir 'ptycwd'
  $spawnMsg = '{"type":"spawn","command":"cmd.exe","args":["/d","/s","/c","echo ' + $SENTINEL + '"],"cwd":' +
              (ConvertTo-Json $workDir) + ',"cols":80,"rows":24}'
  $stdin = $spawnMsg + "`n"

  $v10Done = $false
  $attempts = @()
  foreach ($rel in $ptyHostCandidates) {
    $entry = Join-Path $asar $rel
    $r = Invoke-HiddenNodeChild -FilePath $Exe -Arguments @($entry) -StdinText $stdin `
      -ExtraEnv @{ ELECTRON_RUN_AS_NODE = '1' } -WaitSeconds 25 -WorkDir $workDir

    $blob = $r.Stdout
    # Squash to A-Z0-9 so a sentinel split across two JSON "data" messages (which
    # ConPTY can do) still matches. Nothing else in the protocol produces that
    # letter run, so this cannot manufacture a false pass.
    $squashed = ($blob -replace '[^A-Za-z0-9]', '').ToUpperInvariant()
    $sawReady = $blob -match '"type"\s*:\s*"ready"'
    $sawPid = $blob -match '"type"\s*:\s*"pid"'
    $sawSentinel = $squashed.Contains($SENTINEL)

    $attempts += [pscustomobject]@{ Entry = $entry; Ready = $sawReady; Pid = $sawPid; Sentinel = $sawSentinel; Err = $r.Stderr }

    if ($sawReady -and $sawPid -and $sawSentinel) {
      Pass 'V10 pty-host ready'   "helper booted from $entry on Lares.exe (ELECTRON_RUN_AS_NODE=1), no system node"
      Pass 'V10 pty spawned'      'pty-host reported a PTY pid - node-pty loaded out of app.asar.unpacked'
      Pass 'V10 sentinel echoed'  "cmd.exe wrote '$SENTINEL' back through the PTY"
      $v10Done = $true

      # Plan §1.7 / §0.4: the PTY CHILD must NOT inherit ELECTRON_RUN_AS_NODE.
      # pty-host is spawned WITH the flag (it is Electron-as-Node) but deletes it
      # before spawning the PTY child. Dump the child env with `cmd /c set` and
      # assert the marker is gone (defense in depth against runtime leakage).
      $envDump = New-TempDir 'ptyenv'
      $setMsg = '{"type":"spawn","command":"cmd.exe","args":["/d","/s","/c","set"],"cwd":' +
                (ConvertTo-Json $envDump) + ',"cols":80,"rows":24}' + "`n"
      $re = Invoke-HiddenNodeChild -FilePath $Exe -Arguments @($entry) -StdinText $setMsg `
        -ExtraEnv @{ ELECTRON_RUN_AS_NODE = '1' } -WaitSeconds 25 -WorkDir $envDump
      if ($re.Stdout -match '(?im)^ELECTRON_RUN_AS_NODE=') {
        Fail 'V10 pty child env' 'the PTY child inherited ELECTRON_RUN_AS_NODE - pty-host must delete it before spawning (plan §0.4/§1.4)'
      } else {
        Pass 'V10 pty child env' 'ELECTRON_RUN_AS_NODE absent from the PTY child environment (confined to the shim/helper process)'
      }
      if (Test-Path -LiteralPath $envDump) { try { Remove-Item -LiteralPath $envDump -Recurse -Force -ErrorAction SilentlyContinue } catch { } }
      break
    }
    if ($sawReady -and $sawPid -and -not $sawSentinel) {
      # Helper and node-pty are fine; the child never produced output. Report it
      # precisely rather than blaming module resolution.
      $flat = ($blob -replace '\s+', ' ').Trim()
      if ($flat.Length -gt 400) { $flat = $flat.Substring(0, 400) }
      Fail 'V10 sentinel echoed' "pty-host booted and spawned a PTY from $entry, but '$SENTINEL' never came back. stdout: $flat"
      $v10Done = $true
      break
    }
  }

  if (-not $v10Done) {
    $detail = ($attempts | ForEach-Object {
      "entry=$($_.Entry) ready=$($_.Ready) pid=$($_.Pid) stderr=$((($_.Err) -replace '\s+',' ').Trim())"
    }) -join ' || '
    Fail 'V10 pty' "the packaged pty-host never became ready from any candidate entry point. $detail"
  }

  if (Test-Path -LiteralPath $workDir) {
    try { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# ---------------------------------------------------------------------------
# [4] V11 - MCP sidecar handshake
# ---------------------------------------------------------------------------
# Separate from V10 on purpose. Different entry point (resources\scripts, a real
# file OUTSIDE the asar, with no node_modules on its resolution path), different
# protocol, different failure mode. A working terminal proves nothing here.
#
# tools/list is included deliberately: it forces the sidecar to require its
# sibling toolset modules, which is the dependency-closure claim of plan 5.4a.
# No dashboard API server is needed - initialize and tools/list are answered
# locally; only tools/call would reach the HTTP API.
Write-Host "`n[4] V11 - MCP sidecar handshake"

if (-not $nodeIsHidden) {
  Skip 'V11 mcp' 'the hidden-Node environment could not be established (see [1])'
} elseif (-not (Test-Path -LiteralPath $mcpScript)) {
  Fail 'V11 mcp' "sidecar script missing: $mcpScript"
} else {
  $stdin = ('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-bundled-node","version":"1.0.0"}}}' + "`n" +
            '{"jsonrpc":"2.0","method":"notifications/initialized"}' + "`n" +
            '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' + "`n")

  $r = Invoke-HiddenNodeChild -FilePath $Exe -Arguments @($mcpScript) -StdinText $stdin -ExtraEnv @{
    ELECTRON_RUN_AS_NODE      = '1'
    AGENT_DASHBOARD_API_TOKEN = 'verify-bundled-node-not-a-real-token'
    AGENT_DASHBOARD_API_PORT  = '24678'
    DASHBOARD_MCP_TOOLSETS    = 'comms,observability'
  } -WaitSeconds 25

  $lines = @($r.Stdout -split "`r?`n" | Where-Object { $_.Trim() })
  $init = $null; $toolsMsg = $null
  foreach ($l in $lines) {
    try { $o = $l | ConvertFrom-Json } catch { continue }
    if ($o.id -eq 1) { $init = $o }
    if ($o.id -eq 2) { $toolsMsg = $o }
  }

  if (-not $init) {
    Fail 'V11 initialize' ("no JSON-RPC response to initialize. stdout: '" + (($r.Stdout -replace '\s+', ' ').Trim()) + "' stderr: '" + (($r.Stderr -replace '\s+', ' ').Trim()) + "'")
  } elseif ($init.error) {
    Fail 'V11 initialize' "server returned an error: $($init.error | ConvertTo-Json -Compress)"
  } elseif ($init.result -and $init.result.serverInfo -and $init.result.serverInfo.name) {
    Pass 'V11 initialize' "handshake completed on Lares.exe with no system node - serverInfo.name=$($init.result.serverInfo.name), protocolVersion=$($init.result.protocolVersion)"
  } else {
    Fail 'V11 initialize' "response had no result.serverInfo: $($init | ConvertTo-Json -Compress -Depth 6)"
  }

  if (-not $toolsMsg) {
    Fail 'V11 tools/list' 'no response to tools/list - the sidecar answered initialize but could not enumerate its toolsets'
  } elseif ($toolsMsg.error) {
    Fail 'V11 tools/list' "server returned an error: $($toolsMsg.error | ConvertTo-Json -Compress)"
  } else {
    $n = @($toolsMsg.result.tools).Count
    if ($n -gt 0) {
      Pass 'V11 tools/list' "$n tool(s) enumerated - the sidecar's sibling module requires resolved from resources\scripts (plan 5.4a)"
    } else {
      Fail 'V11 tools/list' 'the sidecar returned an empty tool list for toolsets comms,observability'
    }
  }

  if ($r.Stderr -match "Cannot find module") {
    Fail 'V11 module resolution' ("the sidecar could not resolve a module: " + (($r.Stderr -replace '\s+', ' ').Trim()))
  }
  if (Test-Path -LiteralPath $r.Dir) {
    try { Remove-Item -LiteralPath $r.Dir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# ---------------------------------------------------------------------------
# [5] The node shim (bundled-node-exposure plan §1.7)
# ---------------------------------------------------------------------------
# [3]/[4] prove the bundled runtime boots when we hand it ELECTRON_RUN_AS_NODE=1
# explicitly. This section proves the SHIM: a `node` command on PATH, generated
# under an install path with a SPACE, re-execs Lares.exe as Node so a Node-free
# machine's bare `node` (hooks, status line) just works — with system node
# keeping precedence.
Write-Host "`n[5] node shim -> Lares.exe (hook/statusline path)"

# The shim dir deliberately contains a space (matches the plan's "install path
# containing spaces" requirement and userData paths like `C:\Users\First Last`).
$shimRoot = Join-Path (New-TempDir 'shim root') 'node-shim'
New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null

# node.cmd content is a byte-for-byte mirror of src/main/node-shim.ts. If that
# module changes, change this too (there is no shared source across TS/PS).
$nodeCmd = "@echo off`r`nsetlocal`r`nset `"ELECTRON_RUN_AS_NODE=1`"`r`n`"$Exe`" %*`r`n"
[System.IO.File]::WriteAllText((Join-Path $shimRoot 'node.cmd'), $nodeCmd, (New-Object System.Text.ASCIIEncoding))

if (-not $nodeIsHidden) {
  Skip 'V12 shim' 'the hidden-Node environment could not be established (see [1])'
} else {
  # 5b/5c: with the shim APPENDED to a node-free PATH, bare `node` resolves the
  # shim and runs as Electron-as-Node.
  $savedEnv2 = @{}
  foreach ($k in @('PATH')) { $savedEnv2[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
  Enter-HiddenNodeEnv
  try {
    $env:PATH = $strippedPath + ';' + $shimRoot

    $whereOut = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "where node 2>nul"
    $whereFirst = @($whereOut | Where-Object { $_ }) | Select-Object -First 1
    if ($whereFirst -and ($whereFirst.Trim().ToLower() -eq (Join-Path $shimRoot 'node.cmd').ToLower())) {
      Pass 'V12 where node' "bare 'node' resolves the shim: $($whereFirst.Trim())"
    } else {
      Fail 'V12 where node' "expected the shim's node.cmd first; 'where node' returned: $($whereOut -join ', ')"
    }

    $ver = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "node -p `"process.versions.node`" 2>nul"
    $ver = ($ver | Where-Object { $_ } | Select-Object -First 1)
    if ($ver -and $ver.Trim() -match '^\d+\.\d+\.\d+') {
      Pass 'V12 node -p versions.node' "shim ran and reported node $($ver.Trim())"
    } else {
      Fail 'V12 node -p versions.node' "no version came back through the shim (got: '$ver')"
    }

    # The crux: it is ELECTRON-as-Node, not a stray system node. A real node
    # binary has an empty process.versions.electron.
    $elec = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "node -p `"process.versions.electron`" 2>nul"
    $elec = ($elec | Where-Object { $_ } | Select-Object -First 1)
    if ($elec -and $elec.Trim() -match '^\d+\.') {
      Pass 'V12 electron-as-node' "process.versions.electron=$($elec.Trim()) - the shim really re-execs Lares.exe"
    } else {
      Fail 'V12 electron-as-node' "process.versions.electron was empty - the shim did NOT resolve to Lares.exe (got: '$elec')"
    }

    # 5d: precedence. A fake node.cmd EARLIER on PATH must win (system-first),
    # and the shim must still be the fallback once the fake is gone.
    $fakeDir = Join-Path (New-TempDir 'fake node') 'bin'
    New-Item -ItemType Directory -Path $fakeDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $fakeDir 'node.cmd'), "@echo off`r`necho FAKENODE_SENTINEL`r`n", (New-Object System.Text.ASCIIEncoding))
    $env:PATH = $fakeDir + ';' + $strippedPath + ';' + $shimRoot
    $pre = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c "node 2>nul"
    if (($pre -join '') -match 'FAKENODE_SENTINEL') {
      Pass 'V12 precedence' 'a node.cmd earlier on PATH wins - the shim is a strict fallback (append-only, plan §0.3)'
    } else {
      Fail 'V12 precedence' "the earlier fake node was NOT preferred; the shim must never override a real node. Got: $($pre -join ' ')"
    }
  } finally {
    Exit-HiddenNodeEnv
    foreach ($k in $savedEnv2.Keys) {
      $v = $savedEnv2[$k]
      if ($null -eq $v) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
      else { Set-Item -LiteralPath "Env:$k" -Value $v }
    }
  }

  # 5e/5f: the REAL scaffolded hook + status line, through the shim. Requires a
  # scaffolded workspace; skip loudly otherwise.
  $statusHook = ''
  $statusLine = ''
  if ($Workspace) {
    $statusHook = Join-Path $Workspace '.lares\scripts\dashboard-status.mjs'
    $statusLine = Join-Path $Workspace '.lares\scripts\dashboard-statusline.mjs'
  }
  if (-not $Workspace) {
    Skip 'V12 status hook' 'no -Workspace given; pass a scaffolded workspace root to exercise the real hook + status line through the shim'
  } elseif (-not (Test-Path -LiteralPath $statusHook)) {
    Skip 'V12 status hook' "no dashboard-status.mjs under $Workspace\.lares\scripts (is it a scaffolded workspace?)"
  } else {
    $spool = Join-Path (New-TempDir 'spool') 'pending-status.jsonl'
    # No dashboard API is up, so HTTP delivery fails and the hook falls back to
    # the spool - which is exactly the path we want to prove works under the shim.
    $r = Invoke-HiddenNodeChild -FilePath (Join-Path $shimRoot 'node.cmd') -Arguments @($statusHook, 'working') -StdinText '' -ExtraEnv @{
      AGENT_ID            = 'verify-shim-agent'
      DASHBOARD_PORT      = '24680'
      DASHBOARD_SPOOL_PATH = $spool
    } -WaitSeconds 20
    if (Test-Path -LiteralPath $spool) {
      $rec = Read-AllText $spool
      if ($rec -match 'verify-shim-agent') {
        Pass 'V12 status hook -> spool' "dashboard-status.mjs ran through the shim and wrote a spool record"
      } else {
        Fail 'V12 status hook -> spool' "spool file exists but has no agent record. stderr: $((($r.Stderr) -replace '\s+',' ').Trim())"
      }
    } else {
      Fail 'V12 status hook -> spool' "no spool record written. stdout: $((($r.Stdout) -replace '\s+',' ').Trim()) stderr: $((($r.Stderr) -replace '\s+',' ').Trim())"
    }

    if (Test-Path -LiteralPath $statusLine) {
      $usageDir = Join-Path (New-TempDir 'ws') '.lares\usage'
      New-Item -ItemType Directory -Path $usageDir -Force | Out-Null
      $wsForLine = Split-Path -Parent (Split-Path -Parent $usageDir)
      $rateBlob = '{"rate_limits":[{"type":"5h","used_pct":10,"resets_at":"2099-01-01T00:00:00Z"}]}'
      $r2 = Invoke-HiddenNodeChild -FilePath (Join-Path $shimRoot 'node.cmd') -Arguments @($statusLine) -StdinText $rateBlob -ExtraEnv @{
        AGENT_ID      = 'verify-shim-agent'
        DASHBOARD_PORT = '24680'
        CLAUDE_PROJECT_DIR = $wsForLine
      } -WaitSeconds 20
      if (($r2.Stdout).Trim().Length -gt 0) {
        Pass 'V12 status line -> stdout' 'dashboard-statusline.mjs printed a line through the shim'
      } else {
        Warn 'V12 status line -> stdout' "no status line printed. stderr: $((($r2.Stderr) -replace '\s+',' ').Trim())"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
if ($script:Warnings.Count -gt 0) {
  Write-Host "verify:bundled-node - $($script:Warnings.Count) warning/skip:" -ForegroundColor Yellow
  foreach ($w in $script:Warnings) { Write-Host "  ! $w" -ForegroundColor Yellow }
}
if ($script:Failures.Count -gt 0) {
  Write-Host "verify:bundled-node - FAILED ($($script:Failures.Count)):" -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host "  x $f" -ForegroundColor Red }
  exit 1
}
Write-Host "verify:bundled-node - OK" -ForegroundColor Green
Write-Host "Note: V10/V11 here exercise the packaged helpers directly. The full" -ForegroundColor DarkGray
Write-Host "matrix still wants one GUI terminal opened and one dashboard MCP tool" -ForegroundColor DarkGray
Write-Host "called from a live agent on a machine that never had Node installed." -ForegroundColor DarkGray
exit 0
