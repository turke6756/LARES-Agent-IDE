# Architecture

A map of how Lares is built. This is a conceptual directory, not an exhaustive
reference — it points you at the parts of `src/` that matter and explains how
they fit. For *why* the app is shaped this way, read [Vision](./vision.md).

## The shape in one paragraph

Lares is an **Electron + React desktop app** that launches agentic-CLI agents —
a model inside its lab-built harness (Claude Code today; other terminal agents
by design) — into a workspace, watches their session logs in real time, and
exposes a **dashboard MCP server** that acts as a harness around those
harnesses: it gives authorized agents the tools to launch and message each
other, and lets a designated *supervisor agent* coordinate the others. It runs on Windows and
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

There are two nested control layers here. The provider harness controls the
model's own reasoning-and-tool loop inside one terminal session; Lares controls
the relationships *among* sessions — launching, identity, role, status,
communication, hierarchy, shared artifacts, context-aware handoff, and scripted
deliberation. The outer layer needs no provider model SDK.

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
- **Agent** — one model-plus-harness session, launched as a CLI process and tied
  to a workspace, with a status machine
  (`launching → working → idle → waiting → done | crashed`), its session-log path,
  and supervisor/supervised flags.
- **Persona** — a role: supervisor, worker, or researcher. Each pairs a tool grant
  with a behavioral spec.
- **ContextStats** — per-agent token usage and context-window percentage,
  derived from the session log. Context is treated as a delegation constraint,
  not merely a UI metric.

## The supervisor (`src/main/supervisor/`)

The supervisor is the outer harness's policy-bearing agent. It keeps the
higher-level goal and plan in view, assigns bounded work to workers and
researchers, receives their events and results, and decides whether to continue
a session, launch another wave, request cross-provider review, or hand work to
a fresh context window. The hierarchy exists to divide both labor and context:
each worker concentrates on a slice that fits its window while the supervisor
maintains continuity across the project.

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
- **context-stats-monitor** — treats each agent's context window as a finite
  orchestration resource: aggregates token usage, and raises supervisor
  notifications as agents approach context-window limits so continuation,
  replacement, and handoff decisions can be made.
- **file-activity tracking** — records each agent's read/write/create operations
  so the UI can show files-read-versus-written and a heat map.
- **worker/role scaffolding** — writes the per-persona scaffold (supervisor,
  worker, researcher) that lets a supervisor delegate waves of work.

> **Architectural invariant — agents share a working directory.** Every
> supervisor in a workspace runs from `.lares/supervisor/`, and every Claude
> worker from `.lares/workers/claude/` (formerly `.dashboard/`; migrated in
> place on first touch). The project slug that maps a session
> log back to an agent is derived purely from the working directory, so it is
> **not** unique per agent. Any code that maps a session file back to an agent must
> disambiguate with a per-agent signal, never "one agent per directory." This is
> intentional and load-bearing; see the root `CLAUDE.md`.

## The MCP surface (`scripts/mcp-*.js`)

The MCP surface is where "a harness for agent harnesses" is implemented: a
provider's harness gives its model tools to act on the workspace; this server
gives whole agents tools to act on each other.

The MCP server is the primary interface for an agent working inside Lares. Agents
are injected with a scoped toolset: a **supervisor** gets the full orchestration
surface (list and message agents, read another agent's chat and files-touched,
launch and coordinate workers, run deliberations, drive notebooks, read and edit
the planning surface); a **worker** or **researcher** gets a narrower grant. The
tool implementations are HTTP routes in `src/main/api-server.ts`; the scripts are
proxies.

## Cross-workspace collaboration (`src/main/security/`, `api-server.ts`)

By default an agent's reach is its own workspace. A **supervisor** can reach
across workspaces — but only a supervisor, only on the routes opened for it, and
every crossing is written to an audit ledger. The trust model rests on the
**per-agent capability token** minted at launch (`src/main/security/agent-capabilities.ts`):
each token carries a server-side claim `{agentId, workspaceId, privilegeLane}`.

- **Two trust tiers.** A request bearing the shared global bearer (no minted
  claim) is the trusted UI/admin path and keeps today's behavior. A request
  bearing a minted claim is a real agent; cross-workspace discovery, foreign
  targets, foreign peer launch, and **all** revival require
  `privilegeLane === 'supervisor'`.
- **Two authorizers** (`api-server.ts`): `authorizeCrossWorkspace` gates
  workspace-scoped discovery (list); `authorizeAgentTarget` gates per-ID target
  actions (read/send/revive). The general self-scope fence (`resolveWorkspaceScope`)
  is untouched — cross-workspace reach is granted *only* by these helpers, only on
  the routes that opened it.
- **The four capabilities.** `list_workspaces` (+ cross-workspace `list_agents
  {workspace_id}`) for discovery; cross-workspace `read_agent_chat` /
  `send_message_to_agent` for per-ID reach; `revive_agent` to relaunch a
  done/crashed agent's original session in its original workspace/cwd
  (supervisor-only even same-workspace — revival is a launch-class mutation;
  providers **claude** and **codex**, gemini is not session-addressable); and
  `launch_agent` with `mode: 'supervisor-peer'` to create a top-level peer
  supervisor (no owner edge) — the only launch class allowed to target a foreign
  workspace.
- **Audit** (`cross_workspace_audit`, `src/main/database.ts`). Every discovery,
  foreign read/send, foreign/peer launch, and revival — **success AND denial** —
  is recorded with actor/target workspace+agent ids, operation, outcome/error
  code, and sanitized metadata (a fixed key allowlist). Message **contents are
  never stored** — only `queued_message_len`.
- **The credential model is real.** A capability token is minted **exactly once**
  per launch/relaunch/fork and threaded to the dashboard MCP config, the child
  env, and any team MCP config; the global bearer is **never** injected into an
  agent sidecar (otherwise a worker's raw HTTP would present the bearer and read
  as admin). A mint failure **fails closed** — the launch aborts rather than fall
  back to the bearer.

The MCP tool docs (`scripts/mcp-tools-observability.js`, `scripts/mcp-tools-orchestration.js`)
and the resident supervisor scaffold (`SUPERVISOR_AGENT_MD` in
`src/shared/constants.ts`) describe `list_workspaces`, `revive_agent`, and the
`launch_agent` `supervisor-peer` mode, including the supervisor-only reach and the
supported revive providers.

## Orchestration & groupthink (`src/main/orchestration/`)

Beyond one-to-one supervision, Lares runs orchestrations as **scripted
primitives**: deterministic scripts that use the app's own MCP tools — the same
tools a supervisor would use — to launch agents, inject prompts, relay
messages, count turns, and gate completion on a final artifact. The flagship is
**groupthink**: a structured, multi-round deliberation between agents *across
providers* (Claude and a second harness), in *parallel* mode (independent
solutions, preserving genuine independent judgment, then reconciliation) or
*serial* mode (proposal, then pushback). The script guarantees turn order and
aggregation; the agents supply the judgment. The protocol is mechanism;
deciding to convene one is policy. See [Workflows](./workflows.md) for how this
is used in practice.

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

Context is the scarce resource the hierarchy exists to divide, so Lares
instruments it. A family of telemetry subsystems make agent behavior — and
context spend — legible over time:

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
