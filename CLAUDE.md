# AgentDashboard

Workspace-centric Claude Agent Dashboard built with Electron + React.

## Architectural invariant: agents deliberately share a working directory

Many agents run from the **same** working directory by design: every supervisor
in a workspace lives in `.dashboard/supervisor/`, and every Claude worker lives
in `.dashboard/workers/claude/`. The Claude project slug
(`makeClaudeProjectSlug()` in `src/main/supervisor/log-readers/claude-jsonl-reader.ts`)
is derived **purely from the working directory**, so it is **NOT unique per
agent** — many concurrent agents map to one slug.

**Consequence for any code that maps a session `.jsonl` (or any cwd-derived
key) back to a specific agent: you cannot assume one-agent-per-cwd.** Disambiguate
with a per-agent signal instead — the agent whose own session file just went
EOF/stale, an explicit prior-session→successor-session link, process identity,
or tight per-agent timing — never "there is exactly one agent in this folder."

Cautionary example: the `/clear` context-bar reset (`decideClearRotation()` in
`src/main/supervisor/claude-clear-rotation.ts`) guards on *single active claude
agent per slug*; because this app shares cwds, that guard silently no-ops and
the bar never resets. Don't reintroduce slug-uniqueness assumptions.

## Launching the App

### Restarting (default for agents)

When asked to "restart the app" — for example, to pick up edits made during a
session — **always rebuild first**. There is no main-process file-watcher, so
a relaunch without a build silently runs the previous compiled `dist/` and any
fix you just shipped will appear missing.

```bash
npm run restart    # builds main + renderer, then launches Electron
```

Agents should treat `npm run restart` as the canonical restart command. Use it
even if you're not sure what changed since the last launch — rebuild is cheap
(~10 seconds) and prevents stale-build confusion.

### Other modes

| Command            | When to use                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------|
| `npm run dev`      | Active development. Builds main once, launches with Vite HMR for the renderer. **Main-process edits still require a relaunch** — HMR covers React only. |
| `npm run start`    | Launch the existing `dist/` artifact without rebuilding. Only use if you know `dist/` is already current.   |
| `npm run build`    | Compile both main + renderer without launching.                                                       |

### Ghost Vite Server Warning

If UI changes aren't appearing after a rebuild, a stale Vite dev server is likely running in the background. Electron checks for a dev server on ports 5173-5175 and will silently connect to it instead of loading from `dist/`.

**Fix:** Kill the ghost process, rebuild, and relaunch:

```bash
# Find rogue processes
lsof -i :5173       # or: ps aux | grep vite

# Kill them
kill -9 <PID>

# Rebuild and launch
npm run restart
```

## Build Commands

| Command              | Description                                              |
|----------------------|----------------------------------------------------------|
| `npm run restart`    | **Canonical restart** — build (main + renderer) + launch |
| `npm run build`      | Full build (main + renderer) without launching           |
| `npm run build:main` | TypeScript compile for Electron main                     |
| `npm run build:renderer` | Vite build for React frontend                        |
| `npm run start`      | Launch Electron from existing `dist/` (no rebuild)       |
| `npm run dev`        | Dev mode with Vite HMR + Electron                        |

## Project Structure

- `src/main/` — Electron main process
- `src/renderer/` — React frontend (Vite)
- `src/preload/` — Preload scripts (IPC bridge)
- `src/shared/` — Shared types and constants
- `dist/` — Compiled output

## Agent file-write convention: avoid `.claude/`

Worker / planner / persistent agents launched in this workspace should not
write or edit files under `.claude/`. Claude Code's permission system gates
edits to anything inside `.claude/` **even with bypass-permissions on** —
because that's where `settings.json`, agent definitions, plans, and skills
live, the harness pops an interactive confirmation dialog asking the user to
approve the edit. In a non-interactive orchestration run, the agent hangs at
that dialog and the orchestrator times it out before anyone answers.

When authoring prompts, point agents at paths *outside* `.claude/`. If a plan
or output genuinely belongs under `.claude/`, the orchestrator (a Node script,
the dashboard, or a supervisor MCP call) should write it on the agent's
behalf. See `docs/ORCHESTRATION_SPIKE.md` for the run that surfaced this.

## Supervisor scaffold: local edits vs. app-wide changes

A supervisor's files (`.dashboard/supervisor/CLAUDE.md`, `.dashboard/supervisor/.claude/skills/<name>/SKILL.md`, etc.) are scaffolded by the dashboard when a workspace is opened. Since commit `54519bf` (2026-06-09) the scaffold is **version-managed with content-hash migration** (`ensureSupervisorScaffold()` + `writeScaffoldMap` in `src/main/supervisor/index.ts`): each managed file carries a `version` and a `previousHashes` list in the scaffold map. On every supervisor launch:

- **Missing file** → written fresh from the constant.
- **On-disk file whose hash matches a known previous version** (pristine, just outdated) → **silently upgraded** to the current constant.
- **On-disk file whose hash matches no managed version** (locally edited) → **backed up to `.bak.<ts>` and overwritten** with the current constant.

This means two different things depending on what you want:

**1. Local-only tweak (one workspace).** Edits to files under `.dashboard/supervisor/` are **no longer durable**: the next scaffold pass detects the unknown hash, backs the file up to `.bak.<ts>`, and overwrites it. If a local edit is worth keeping, fold it into the source constant (option 2) — or expect to recover it from the `.bak` file.

**2. Change what every supervisor gets (app-wide).** Edit the source constant in `src/shared/constants.ts` — `SUPERVISOR_AGENT_MD` (the CLAUDE.md), `SUPERVISOR_RUN_ORCHESTRATION_SKILL`, etc. — **bump that file's `version` in the scaffold map and append the prior content's hash to `previousHashes`**, then rebuild (`npm run build:main`) and restart Electron. Pristine workspaces upgrade silently at next supervisor launch; locally-edited ones get `.bak`'d + overwritten. The old "delete the folder / remove + re-add the workspace" dance is obsolete.

Multiple workstreams add sections to `SUPERVISOR_AGENT_MD`; each addition must use its own versioned sentinel marker + idempotent append (see `plans/v2-migration-phase-order-audit.md` §5.5), never a wholesale section rewrite.

## Notebook execution convention

When asked to run or debug an `.ipynb` from this dashboard workspace, prefer the
dashboard MCP notebook tools over raw `jupyter nbconvert`. Use `execute_notebook`
for whole-notebook validation and `execute_cell` / `execute_range` for focused
iteration so the dashboard notebook view and persisted outputs stay in sync.
Use `nbconvert` only when the dashboard MCP tool is unavailable or the user
explicitly asks for a fresh-kernel headless run.
