# Lares

**Lares** is an agent-native workspace for orchestrating AI agents across
terminals, files, browsers, documents, and notebooks. It is an Electron + React
desktop app that launches agentic-CLI agents into a workspace and keeps every one
of them visible, addressable, and interruptible. (Formerly **AgentDashboard**.)

This file is read automatically by Claude Code on every session in this repo. It
is the short operational orientation; the full docs live in [`docs/`](docs/).

> ⚠ **Alpha — agents execute real commands.** Lares runs agents that execute shell
> in real terminals, drive a real browser, and read/write files. Read
> [SECURITY.md](SECURITY.md) before running it.

## Set up Lares

If a user asks you to **"set up Lares"** (or "install Lares" / "configure Lares"),
follow the setup skill at `.claude/skills/lares/` — it is an agent-followed wizard:
check Node/npm versions → `npm install` → offer optional integrations → write
non-secret settings → point the user to a **separate terminal** for any secrets
(never capture secrets in the AI session) → `npm run build` → launch → health
check. Do not write secrets into the session or into the user's `.claude/`.

## Build & run

There is **no main-process file-watcher**, so after any code change you must
rebuild before launching — a plain relaunch silently runs the previous `dist/`.

| Command | When to use |
|---|---|
| `npm run restart` | **Canonical restart** — build (main + renderer) + launch. Use this after edits. |
| `npm run build` | Compile both without launching. |
| `npm run start` | Launch the existing `dist/` (only if you know it is current). |
| `npm run dev` | Vite HMR for the renderer; main-process edits still need a relaunch. |

New to the project? See [docs/setup.md](docs/setup.md) for prerequisites
(Node ≥ 20, a terminal-agent CLI, Windows + WSL, native-module build notes).

## Project structure

- `src/main/` — Electron main process (supervisor, runners, browser, plans, IPC)
- `src/renderer/` — React frontend (Vite)
- `src/preload/` — preload scripts (IPC bridge)
- `src/shared/` — shared types and constants
- `dist/` — compiled output

For how these fit together, read [docs/architecture.md](docs/architecture.md).

## Architectural invariant: agents share a working directory

Many agents run from the **same** working directory by design: every supervisor in
a workspace lives in `.lares/supervisor/`, and every Claude worker in
`.lares/workers/claude/`. (Formerly `.dashboard/` — existing workspaces are
renamed in place on first touch; see src/main/workspace-state-dir.ts.) The
Claude project slug is derived **purely from the
working directory**, so it is **not unique per agent** — many concurrent agents map
to one slug.

**Consequence:** any code that maps a session `.jsonl` (or any cwd-derived key)
back to a specific agent **cannot** assume one-agent-per-cwd. Disambiguate with a
per-agent signal — the agent whose own session file just went stale, an explicit
prior→successor session link, process identity, or tight per-agent timing — never
"there is exactly one agent in this folder." Don't reintroduce slug-uniqueness
assumptions.

## Writing under `.claude/`

Claude Code gates edits to anything inside `.claude/` with an interactive
permission dialog **even with bypass-permissions on**. In a non-interactive
orchestration run an agent will hang at that dialog. When authoring agent prompts,
point agents at paths *outside* `.claude/`; if something genuinely belongs under
`.claude/`, have the orchestrator write it on the agent's behalf.

## Notebook execution

When running or debugging an `.ipynb` in this workspace, prefer the dashboard's MCP
notebook tools (`execute_notebook`, `execute_cell`, `execute_range`) over raw
`jupyter nbconvert`, so the notebook view, live kernel, and saved outputs stay in
sync. Use `nbconvert` only when the MCP tool is unavailable or a fresh-kernel
headless run is explicitly requested. Address cells by their nbformat `id`, never
by index.

## For non-Claude agents

If you are not Claude Code, see [AGENTS.md](AGENTS.md) for the neutral-core version
of this orientation.
