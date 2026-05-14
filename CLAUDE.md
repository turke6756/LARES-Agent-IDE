# AgentDashboard

Workspace-centric Claude Agent Dashboard built with Electron + React.

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

A supervisor's files (`.dashboard/supervisor/CLAUDE.md`, `.dashboard/supervisor/.claude/skills/<name>/SKILL.md`, etc.) are **scaffolded once** by the dashboard the first time a workspace is opened that doesn't already have a `.dashboard/supervisor/` directory. The scaffold logic lives in `src/main/supervisor/index.ts` (`ensureSupervisorScaffold()`) and explicitly **never overwrites existing files** — it only writes ones that are missing.

This means two different things depending on what you want:

**1. Local-only tweak (one workspace).** Edit the file under `.dashboard/supervisor/` directly. The change sticks for this workspace and survives restarts, but it's lost if anyone wipes that folder, and **no other workspace gets it** — the next supervisor scaffolded anywhere else still gets the old content from the constants.

**2. Change what every future supervisor gets (app-wide).** Edit the source constant in `src/shared/constants.ts` — `SUPERVISOR_AGENT_MD` (the CLAUDE.md), `SUPERVISOR_RUN_ORCHESTRATION_SKILL`, `SUPERVISOR_ORCHESTRATION_SPIKE_SKILL`, etc. Then **rebuild the main process** (`npm run build:main`) and restart Electron. From that point on, any workspace that gets a fresh supervisor scaffold receives the updated content.

**Verifying the app-wide change in a workspace that already has a supervisor:** because the scaffolder won't overwrite, you have to force a fresh scaffold. The reliable sequence is:

1. Stop the supervisor running in that workspace (or close the dashboard).
2. Delete the `.dashboard/supervisor/` folder (or just the specific files you want regenerated — `CLAUDE.md`, the relevant `SKILL.md`).
3. Remove the workspace from the dashboard.
4. Re-add the workspace. The dashboard rescaffolds from the current (rebuilt) constants.

If you only edit the on-disk file without touching the constant, you've made a local-only change. If you only edit the constant without rebuilding + removing the stale folder, the running app keeps emitting the old content. Both steps matter.

## Notebook execution convention

When asked to run or debug an `.ipynb` from this dashboard workspace, prefer the
dashboard MCP notebook tools over raw `jupyter nbconvert`. Use `execute_notebook`
for whole-notebook validation and `execute_cell` / `execute_range` for focused
iteration so the dashboard notebook view and persisted outputs stay in sync.
Use `nbconvert` only when the dashboard MCP tool is unavailable or the user
explicitly asks for a fresh-kernel headless run.
