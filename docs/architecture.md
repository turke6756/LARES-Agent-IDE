# Architecture

A map of how Lares is built. This is a conceptual directory, not an exhaustive
reference — it points you at the parts of `src/` that matter and explains how
they fit. For *why* the app is shaped this way, read [Vision](./vision.md).

## The shape in one paragraph

Lares is an **Electron + React desktop app** that launches agentic-CLI agents
(Claude Code today; other terminal agents by design) into a workspace, watches
their session logs in real time, and exposes a **dashboard MCP server** so a
designated *supervisor agent* can coordinate the others. It runs on Windows and
supports both Windows-native and WSL workspaces transparently. Around that agent
core sit a file browser with native renderers, a live Jupyter kernel, a real
embedded web browser with an access-policy layer, a planning surface, a
document editor with agent-visible comments, and a set of context/usage
telemetry subsystems.

## Processes

Lares runs as a small set of cooperating processes:

| Process | Entry | Role |
|---|---|---|
| Electron **main** | `src/main/index.ts` | App lifecycle, IPC, the supervisor, fs watching, file I/O, browser + Jupyter spawn |
| Electron **renderer** | `src/renderer/` | React UI, Zustand state |
| **Preload** bridge | `src/preload/` | `contextBridge` — the typed `window.api` IPC surface |
| **Jupyter server** (child) | `src/main/jupyter-server.ts` | Notebook kernel host, driven over MCP |

Inside the main process, a local **HTTP API server** (`src/main/api-server.ts`)
is the hub: the MCP scripts in `scripts/mcp-*.js` are thin proxies that translate
MCP tool calls into HTTP requests against it. Because of that indirection, the
same capabilities are reachable both from an agent's MCP client and from anything
that can make a local HTTP call.

## Domain primitives

The core types live in `src/shared/types.ts` — treat that file as the source of
truth. The load-bearing ones:

- **Workspace** — a directory, tagged as a Windows path or a WSL path. The unit of
  "what am I working on."
- **Agent** — one launched CLI process tied to a workspace, with a status machine
  (`launching → working → idle → waiting → done | crashed`), its session-log path,
  and supervisor/supervised flags.
- **Persona** — a role: supervisor, worker, or researcher. Each pairs a tool grant
  with a behavioral spec.
- **ContextStats** — per-agent token usage and context-window percentage, derived
  from the session log.

## The supervisor (`src/main/supervisor/`)

The supervisor subsystem is the orchestration core. Its responsibilities are
split across siblings in that directory:

- **Runners** — Windows agents are spawned directly; WSL agents are spawned inside
  a detached **tmux** session, which gives WSL workspaces detach/reattach and
  terminals that survive closing the app.
- **status-monitor** — polls process state and emits status transitions to the
  live agent rail.
- **Session-log readers** (`supervisor/log-readers/`) — tail each harness's own
  session transcript (e.g. Claude Code's per-session JSONL), parse it into typed
  events, and push them to the renderer's chat pane. This is how you can attach to
  any agent and read its reasoning, tool calls, and results.
- **context-stats-monitor** — aggregates token usage and raises supervisor
  notifications as agents approach context-window limits.
- **file-activity tracking** — records each agent's read/write/create operations
  so the UI can show files-read-versus-written and a heat map.
- **worker/role scaffolding** — writes the per-persona scaffold (supervisor,
  worker, researcher) that lets a supervisor delegate waves of work.

> **Architectural invariant — agents share a working directory.** Every
> supervisor in a workspace runs from `.dashboard/supervisor/`, and every Claude
> worker from `.dashboard/workers/claude/`. The project slug that maps a session
> log back to an agent is derived purely from the working directory, so it is
> **not** unique per agent. Any code that maps a session file back to an agent must
> disambiguate with a per-agent signal, never "one agent per directory." This is
> intentional and load-bearing; see the root `CLAUDE.md`.

## The MCP surface (`scripts/mcp-*.js`)

The MCP server is the primary interface for an agent working inside Lares. Agents
are injected with a scoped toolset: a **supervisor** gets the full orchestration
surface (list and message agents, read another agent's chat and files-touched,
launch and coordinate workers, run deliberations, drive notebooks, read and edit
the planning surface); a **worker** or **researcher** gets a narrower grant. The
tool implementations are HTTP routes in `src/main/api-server.ts`; the scripts are
proxies.

## Orchestration & groupthink (`src/main/orchestration/`)

Beyond one-to-one supervision, Lares can run **groupthink**: a structured,
multi-round deliberation between agents — including *across providers* (Claude and
a second harness) — where a script guarantees turn order and aggregation while the
agents supply the judgment. The protocol is mechanism; deciding to convene one is
policy. See [Workflows](./workflows.md) for how this is used in practice.

## Planning surface (`src/main/plans/`)

Lares has a first-class **planning surface**: structured plan documents that
agents read and edit section by section, with a **provenance trail** — the server
witnesses which sections an agent actually read and edited from its tool calls,
so the plan carries a trusted record of who did what where, independent of what
any agent narrates.

## Embedded browser (`src/main/browser/`)

A real, embedded Chromium browser that agents can drive — navigate, click, type,
read the page — the *same* tab a human can grab. It is fronted by an
**access-policy store** (`browser/access-policy-store.ts`) and an **action-audit
log** (`browser/action-audit.ts`) that record and gate what agents do in the
browser. These boundaries are real but partial — read [Security](./security.md).

## Documents, notebooks & file rendering

- **Documents** — a Word-style Markdown editor (Milkdown/Crepe) with
  **agent-visible comments**: you point at a line and leave a comment on *that
  line*, and the agent sees it as an in-band, artifact-anchored channel. Word
  (`.docx` via mammoth), PDF (react-pdf), and figures/GIS formats
  (GeoTIFF, shapefile, Leaflet maps, KaTeX) render natively.
- **Notebooks** — a live Jupyter kernel. The MCP notebook tools
  (`scripts/mcp-tools-notebooks.js`) drive the **same** kernel the user sees in
  the view, so agent runs and human runs stay in sync. Address cells by their
  nbformat `id`, never by index.
- **File viewer** — a tabbed viewer that dispatches a native renderer per file
  type, backed by a dual-backend file watcher (chokidar for Windows paths,
  `inotifywait`/polling for WSL paths).

## Context & usage intelligence

A family of telemetry subsystems make agent behavior legible over time:

- `src/main/context-overhead/` — measures what is consuming each agent's context
  window (system prompt, tool schemas, memory files).
- `src/main/context-optimizer/` — surfaces proposals to trim context overhead.
- `src/main/skill-analytics/` — tracks which skills and MCP tools agents actually
  use.
- `src/main/agent-knowledge/` — extracts durable knowledge from agent activity.

## Persistence

State is kept in a local **SQLite** database via `better-sqlite3`
(`src/main/database.ts`): workspaces, agents, file activities, plans and their
provenance, orchestration sessions, and telemetry. No external database, no
network service.

## Read next

- [Setup](./setup.md) — get it running, including native-module build notes.
- [Workflows](./workflows.md) — the orchestration patterns in practice.
- [Security](./security.md) — the threat model for everything above.
