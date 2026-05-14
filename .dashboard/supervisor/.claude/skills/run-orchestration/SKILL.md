---
name: run-orchestration
description: Run an AgentDashboard orchestration — a multi-agent script-driven workflow such as planning committee, scoping, fork-and-execute, or GroupThink. Use when the user names an orchestration or describes a goal that maps to one. Don't autonomously launch.
---

# Run Orchestration

Use this skill when the user asks to run any AgentDashboard **orchestration** — a multi-agent script-driven workflow (planning committee, scoping, fork-and-execute, etc.).

This is the generic playbook. The orchestration-specific details (parameters, events, recovery) live in each orchestration's own manual under `scripts/<name>.md`.

## Available orchestrations

| Name | Script | Manual | Purpose |
|---|---|---|---|
| `groupthink-v1` | `scripts/groupthink-v1.js` | `scripts/groupthink-v1.md` | Two-agent cross-provider deliberation producing a planning markdown |

When new orchestrations are added, they should appear in this table and ship with a `scripts/<name>.md` manual matching the structure of `groupthink-v1.md`.

## Workflow

### 1. Identify the orchestration

The user will name one (e.g., "run a GroupThink on X") or describe a goal that maps to one. If unclear, ask. Don't guess — orchestrations launch real agents and burn real tokens.

### 2. Read the orchestration's manual

Open `scripts/<name>.md` and read the **When to use**, **Parameters**, **Events emitted**, and **Recovery contract** sections. Each manual is self-contained — every flag, every event, every exit code is documented there.

### 3. Discover IDs

Every orchestration needs a `workspaceId` and a `supervisorId`. Find them via the dashboard API:

```bash
curl -s http://127.0.0.1:24678/api/agents | jq '.[] | select(.isSupervisor) | {id, workspaceId, title, status}'
```

Choose the API host this way:

- Prefer `http://127.0.0.1:24678`.
- If that fails, try ports `24679`, `24680`, `24681`.
- In WSL, use the Windows host IP from `/etc/resolv.conf` if `127.0.0.1` cannot connect.

Identify the current supervisor by matching its `workingDirectory` to the current shell directory (typically `.dashboard/supervisor` for this workspace). Use that agent's `id` as `supervisorId` and its `workspaceId` as `workspaceId`.

If exactly one active supervisor isn't found for the current workspace, stop and report the ambiguity.

### 4. Construct the invocation

Fill in the orchestration's required and useful optional flags. Most orchestrations take this shape:

```bash
node scripts/<name>.js \
  --workspaceId=<ws-id> \
  --supervisorId=<sup-id> \
  [orchestration-specific flags]
```

Confirm with the user before launching anything that will burn tokens — show the constructed command. Don't autonomously launch.

### 5. Launch detached

Orchestrations run in the background. Launch the script and return to idle. The script will send `[DASHBOARD EVENT]` messages to your input as it progresses.

In Bash / WSL / Git Bash:

```bash
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOG="plans/.runs/<name>-${RUN_ID}.log"
mkdir -p "plans/.runs"
nohup node scripts/<name>.js [args...] > "$LOG" 2>&1 &
```

In PowerShell or a Windows shell:

> **Quoting gotcha (PowerShell 5.1):** `Start-Process -ArgumentList @(...)` and `powershell -Command` both silently strip the quotes around any array element containing spaces before `CreateProcess` sees them. A flag like `--topic="A B C"` arrives at `node` as just `--topic=A` with `B` and `C` as orphan positional tokens. **Prefer Bash via `bash -lc` — POSIX quoting survives intact.** Fallback: `cmd /c` with a single command-line string (cmd respects the quotes verbatim). Always verify the launch with `(Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine`.

```powershell
# Preferred: shell out to Bash. POSIX quoting works.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
bash -lc "mkdir -p plans/.runs && nohup node scripts/<name>.js --workspaceId=<ws-id> --supervisorId=<sup-id> --topic='Multi-word topic survives intact' > plans/.runs/<name>-$RunId.log 2>&1 &"

# Fallback: cmd /c with a single command-line string. cmd respects the quotes verbatim.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
$Log = "plans\.runs\<name>-$RunId.log"
New-Item -ItemType Directory -Force "plans\.runs" | Out-Null
$Cmd = 'node scripts\<name>.js --workspaceId=<ws-id> --supervisorId=<sup-id> --topic="Multi-word topic" > "' + $Log + '" 2>&1'
Start-Process -WindowStyle Hidden cmd -ArgumentList @('/c', $Cmd)

# DO NOT use: Start-Process -FilePath node -ArgumentList @(...).
# PS 5.1 strips the quotes around any element containing spaces before CreateProcess.
```

After launching, tell the user the run id and log path, then stop working. The orchestration drives itself.

### 6. Watch for events

Each orchestration documents the `[DASHBOARD EVENT]` strings it emits. When one arrives in your chat:

- **Happy path events** (e.g. `*.complete`, `*.turn_complete`): acknowledge, no action needed unless the user asks.
- **`*.stalled`**: read the manual's **Recovery contract** section. Typically you'll have three options — steer-and-resume, accept-partial, or abandon. Decide based on the payload (turns elapsed, last exchange, agent state). When in doubt, escalate to the user.
- **`*.aborted`**: something went wrong. Read the orchestration's run log at the path printed at launch, diagnose, and either retry or escalate.

### 7. Inspect agents during a run

You can read what agents are saying mid-run without disturbing the orchestration:

- `read_agent_chat` (preferred for orchestrations): structured turn-complete messages.
- `read_agent_log` (fallback): raw terminal output.

Don't `send_message_to_agent` to a planner mid-run unless the orchestration is stalled — you'll race the script's relay loop.

## File-write convention

Orchestrations and the agents they launch should not write to paths under `.claude/`. Claude Code's permission system gates edits there even with bypass-permissions on, hanging worker forks at an interactive dialog. Plan markdown, run logs, and any agent-edited files belong outside `.claude/` — typically under `plans/` or the workspace root.

## Constraints

- Run orchestrations only when the user asks. Don't autonomously launch them.
- Confirm the constructed invocation with the user before launching, especially for non-trivial topics.
- Each orchestration's manual is the source of truth for its flags and events. If the manual disagrees with this skill, follow the manual.
- After launch, return to idle. Don't poll the dashboard; let `[DASHBOARD EVENT]` messages drive your wake-ups.
