---
name: orchestration-spike
description: Run the disposable orchestration smoke test that launches a detached Node process driving planner and worker agents through the dashboard HTTP API. Use only when the user explicitly asks to run the orchestration spike.
---

# Orchestration Spike

Use this skill only when the user asks to run the orchestration spike.

This is a disposable smoke test. It launches a detached Node process, then returns to idle while the script drives planner and worker agents through the AgentDashboard HTTP API.

## Preconditions

- Run from this supervisor agent's shell.
- Abort if AgentDashboard's API is not reachable.
- Abort if you cannot identify exactly one active supervisor for the current workspace.

## Discover API, Supervisor, And Workspace

Use `GET /api/agents` and filter active agents where `isSupervisor` is `true`. Active means status is not `done` or `crashed`.

Choose the API host and port this way:

- Prefer `http://127.0.0.1:24678`.
- If that fails, try ports `24679`, `24680`, and `24681`.
- In WSL, use the Windows host IP from `/etc/resolv.conf` if `127.0.0.1` cannot connect.

Identify the current supervisor by matching its `workingDirectory` to the current shell directory. The current directory should be `.dashboard/supervisor` for this workspace. Use that agent's `id` as `supervisorId` and its `workspaceId` as `workspaceId`.

If the filtered current-workspace supervisor count is not exactly one, stop and report the ambiguity.

## Launch Detached Spike

Create a run id and log path:

```bash
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOG="plans/.runs/spike-${RUN_ID}.log"
mkdir -p "plans/.runs"
```

In Bash, WSL, or Git Bash, launch with:

```bash
nohup node scripts/orchestration-spike.js \
  --run-id "$RUN_ID" \
  --task "Create hello.py and update the spike plan." \
  --workspace-id "$WORKSPACE_ID" \
  --supervisor-id "$SUPERVISOR_ID" \
  --api-host "$API_HOST" \
  --api-port "$API_PORT" \
  --quiet \
  > "$LOG" 2>&1 &
```

In PowerShell or a Windows shell, launch with:

> **Quoting gotcha (PowerShell 5.1):** `Start-Process -ArgumentList @(...)` and `powershell -Command` both silently strip the quotes around array elements containing spaces (so `--task "Create hello.py..."` arrives as just `--task` with the rest as orphan tokens). Prefer Bash; fallback is `cmd /c` with a single command string. Verify with `(Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine`.

```powershell
# Preferred: shell out to Bash. POSIX quoting works.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
bash -lc "mkdir -p plans/.runs && nohup node scripts/orchestration-spike.js --run-id '$RunId' --task 'Create hello.py and update the spike plan.' --workspace-id '$WorkspaceId' --supervisor-id '$SupervisorId' --api-host '$ApiHost' --api-port '$ApiPort' --quiet > plans/.runs/spike-$RunId.log 2>&1 &"

# Fallback: cmd /c with a single command-line string. cmd respects the quotes verbatim.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
$Log = "plans\.runs\spike-$RunId.log"
New-Item -ItemType Directory -Force "plans\.runs" | Out-Null
$Cmd = 'node scripts\orchestration-spike.js --run-id "' + $RunId + '" --task "Create hello.py and update the spike plan." --workspace-id "' + $WorkspaceId + '" --supervisor-id "' + $SupervisorId + '" --api-host "' + $ApiHost + '" --api-port "' + $ApiPort + '" --quiet > "' + $Log + '" 2>&1'
Start-Process -WindowStyle Hidden cmd -ArgumentList @('/c', $Cmd)

# DO NOT use: Start-Process -FilePath node -ArgumentList @(...).
# PS 5.1 strips the quotes around any element containing spaces before CreateProcess.
```

After launching, tell the user the run id and log path, then stop working. The detached script will send `[DASHBOARD EVENT]` messages back to this supervisor:

- `Spike: planners launched`
- `Spike: consensus check complete`
- `Spike: plan written`
- `Spike: phase-1 done`
- `Spike: complete`

It may send `Spike: aborted` if the smoke test fails.

## Agent file-write convention

The spike's plan markdown is intentionally written to **repo root**
(`spike-hello-world.md`), not under `.claude/`. Claude Code's permission
system gates edits inside `.claude/` even with bypass-permissions on, which
hangs worker forks on an interactive confirmation dialog. When iterating on
this spike or writing similar orchestrations, keep agent-edited files outside
`.claude/`. See `docs/ORCHESTRATION_SPIKE.md` for the run that surfaced this.
