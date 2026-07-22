# AGENTS.md

Orientation for any AI agent working in the **Lares** repository. This is the
provider-neutral mirror of [`CLAUDE.md`](CLAUDE.md); if you are Claude Code, read
that file instead (the harness loads it automatically).

## What Lares is

Lares is an agent-native workspace for orchestrating AI agents across terminals,
files, browsers, documents, and notebooks — an Electron + React desktop app that
launches agentic-CLI agents into a workspace and keeps every one of them visible
and interruptible. (Formerly **AgentDashboard**.)

**Provider posture.** Lares has no provider SDK and no lock-in — it is built on the
capabilities any terminal-agent harness exposes. **Claude Code is the reference
harness it is developed and tested against today**, and a second provider (Codex)
is wired in for cross-provider "groupthink." Any equivalent terminal agent can be
dropped into the terminals; broader harness support is a roadmap item, not a
current guarantee.

> ⚠ **Alpha — agents execute real commands.** Lares runs agents that execute shell
> in real terminals, drive a real browser, and read/write files. Read
> [SECURITY.md](SECURITY.md) before running it.

## Build & run

There is no main-process file-watcher, so **rebuild before launching** after any
code change — a plain relaunch runs the previous `dist/`.

| Command | When to use |
|---|---|
| `npm run restart` | Canonical restart — build (main + renderer) + launch. |
| `npm run build` | Compile both without launching. |
| `npm run start` | Launch the existing `dist/` (only if current). |
| `npm run dev` | Vite HMR for the renderer; main-process edits still need a relaunch. |

Prerequisites and native-module notes: [docs/setup.md](docs/setup.md).

## Project structure

- `src/main/` — Electron main process (supervisor, runners, browser, plans, IPC)
- `src/renderer/` — React frontend (Vite)
- `src/preload/` — preload scripts (IPC bridge)
- `src/shared/` — shared types and constants
- `dist/` — compiled output

Architecture overview: [docs/architecture.md](docs/architecture.md).

## Conventions that will bite you

- **Agents share a working directory by design.** Every supervisor lives in
  `.lares/supervisor/` and every Claude worker in `.lares/workers/claude/`,
  and the project slug is derived purely from the working directory — so it is
  **not unique per agent.** Any code mapping a session log back to an agent must
  disambiguate with a per-agent signal, never "one agent per directory."
- **Writing under `.claude/` may block on a permission dialog.** Some harnesses gate
  edits inside `.claude/` interactively; a non-interactive run can hang there. Point
  agent work at paths outside `.claude/` where possible.
- **Notebooks:** prefer the dashboard's MCP notebook tools over raw `nbconvert` so
  the view, live kernel, and saved outputs stay in sync. Address cells by nbformat
  `id`, never by index.

## Learn more

- [docs/vision.md](docs/vision.md) — what Lares is and why.
- [docs/architecture.md](docs/architecture.md) — how it is built.
- [docs/workflows.md](docs/workflows.md) — the multi-agent patterns.
- [docs/security.md](docs/security.md) — the threat model.
