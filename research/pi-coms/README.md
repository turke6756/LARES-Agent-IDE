# Pi-to-Pi Agent Communication — Study Notes

A vendored copy of the **peer-to-peer agent communication** implementation from
Disler's `pi-vs-claude-code` repo, kept here so we can study how another team
built agent ↔ agent messaging on the Pi harness — relevant to AgentDashboard's
own Teams / inter-agent communication work.

These files are **reference material only**. They are not wired into the
AgentDashboard build and won't run here as-is (they `import` from the Pi
runtime packages — see "Why it won't run here" below).

---

## What is the "Pi coding harness"?

**Pi** (a.k.a. *pi-coding-agent* / the `pi` CLI) is an **open-source terminal
coding agent** — a direct competitor to Claude Code — written by **Mario
Zechner** (`@badlogicgames`).

- Harness source: https://github.com/badlogic/pi-mono (package
  `packages/coding-agent`); also mirrored/referenced as
  `mariozechner/pi-coding-agent`.
- Its defining trait vs. Claude Code is a first-class **extension system**:
  a single TypeScript file loaded with `pi -e <file>.ts` can register new
  **tools** (callable by the model), **slash commands**, **TUI widgets**,
  status indicators, and lifecycle hooks. Extensions import from
  `@mariozechner/pi-coding-agent` (agent API) and `@mariozechner/pi-tui`
  (terminal UI primitives).
- The agent-to-agent "coms" feature below is built **entirely as extensions** —
  nothing is patched into the core. That's the whole point of the demo: a third
  party can add networked multi-agent orchestration without forking the harness.

## Where these files came from

| | |
|---|---|
| Source repo | https://github.com/disler/pi-vs-claude-code |
| Branch | `main` |
| Source commit | `3ce16391a1f4d244f9204578833506580273fe20` (2026-05-11) |
| Vendored on | 2026-05-27 |

Companion material from the source repo:
- Demo video — *"Pi to Pi: Two-Way Agent Orchestration"*: https://youtu.be/PIdETjcXNIk
- Pi extensions docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md

> Note: the upstream repo does **not** ship a separate "coms" repo — the working
> code *is* these extension files. So this folder has the complete, runnable-
> against-Pi implementation, just not its surrounding Pi project.

## Files in this folder

| File | Upstream path | What it is |
|------|---------------|------------|
| `coms.ts` | `extensions/coms.ts` | **v1 — local, same machine.** Each agent binds a Unix socket (POSIX) / named pipe (Windows). Peers discover each other via per-project registry JSON under `~/.pi/coms/projects/<project>/agents/<name>.json`. No server process. |
| `coms-net.ts` | `extensions/coms-net.ts` | **v2 — networked.** Drop-in successor whose transport is a central **HTTP + SSE hub** instead of sockets. Works same-machine, LAN, or remote URL. Renamed tool surface (`coms_net_*`) so it can be loaded alongside v1 without collision. |
| `coms-net-server.ts` | `scripts/coms-net-server.ts` | The **hub** for `coms-net`. A Bun HTTP/SSE server agents register with and route messages through. `coms-net.ts` is meaningless without it — included so v2 is studyable end-to-end. |

## The core model (read this before diving into the code)

Both versions expose the **same four-tool, no-orchestrator** design — two agents
are *equals*, not parent/child:

| Tool (v1 / v2) | Purpose |
|---|---|
| `coms_list` / `coms_net_list` | Discover peers — names, purpose, model, context-used %, queue depth |
| `coms_send` / `coms_net_send` | Send a prompt to a named peer; returns a `msg_id` immediately |
| `coms_get` / `coms_net_get` | **Non-blocking** poll of a `msg_id` → pending / complete / error |
| `coms_await` / `coms_net_await` | **Blocking** wait on a `msg_id` until the reply lands or it times out |

Shared mechanics worth tracing in the source:
- **Envelopes** — `prompt` / `response` / `ping` messages with `msg_id`,
  sender identity, `hops`, timestamp (`coms.ts` ~line 44; `coms-net.ts` ~line 56).
- **Hop limit** — `MAX_HOPS` (default 5) guards against forwarding loops so
  agents can relay without infinite bouncing.
- **Registry files** — JSON under `~/.pi/coms/` (v1) and `~/.pi/coms-net/` (v2)
  are how peers find each other; the dashboard's own approach to agent discovery
  is the natural thing to compare against.
- **Long timeouts** — message TTL defaults to 30 min (`1_800_000` ms), i.e.
  sized for an agent to actually think and reply, not a request/response API.
- Everything is configurable via `PI_COMS_*` / `PI_COMS_NET_*` env vars (see the
  constants block at the top of each file).

### How an exchange flows (v2 / networked)
```
  bun coms-net-server.ts          # 1. start the hub
  pi -e coms-net.ts --name planner   # 2. agent A registers with hub
  pi -e coms-net.ts --name coder     # 3. agent B registers with hub
        |
  planner: coms_net_list            -> sees "coder"
  planner: coms_net_send(coder,…)   -> returns msg_id (hub queues -> SSE push to coder)
  coder   runs the prompt as a turn, emits a response envelope back through hub
  planner: coms_net_await(msg_id)   -> blocks, gets coder's reply
```
v1 (`coms.ts`) is the same dance but the transport is a direct socket/pipe to
the peer instead of a hub, and there's no server to start.

## Why it won't run here

These are Pi extension modules. The first lines import from
`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`,
and a sibling `./themeMap.ts` that we did **not** vendor. To actually execute
them you'd clone the full Pi project and run `pi -e coms-net.ts`. For *study*,
read them directly — the logic (registry I/O, transport, the four tools,
envelope handling) is self-contained and readable without the runtime.

## Suggested reading order

1. This README (the four-tool model + envelope shape).
2. `coms.ts` constants + types (top ~120 lines) — the data model in miniature.
3. `coms.ts` tool definitions (`coms_list/send/get/await`) — the agent-facing API.
4. `coms-net.ts` — see what changes when transport becomes an HTTP/SSE hub.
5. `coms-net-server.ts` — the routing/registry brain of v2.
