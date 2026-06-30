---
name: create-persona
description: Help the user design and set up a NEW AgentDashboard persona (a reusable custom agent). Use when the user says things like "create a new agent", "make me a persona", "set up a new dashboard agent", "I want an agent that does X", or asks how personas/agent tools/the .dashboard folder structure work. Walks the user through choosing the agent's purpose and tools, then constructs the persona folder so it's launchable from the dashboard's Launch Agent dropdown.
---

# Create a Persona

A **persona** is a reusable custom agent in the AgentDashboard: a folder with its own
identity, memory, status hooks, and skills. Once it exists, it shows up in the **Launch
Agent** dropdown under "— your custom agents —" and can be launched into its own context
any time. This skill helps you design one *with* the user and set it up correctly.

Your job is to be a **guide**, not just a scaffolder: most users don't know what tools an
agent can have or how the `.dashboard` folder is laid out. Explain the choices, recommend
sensible defaults, then build it.

## Where personas live

```
<workspace>/.dashboard/
  ├── supervisor/        ← reserved lane (built-in, do not treat as a custom persona)
  ├── researcher/        ← reserved lane (built-in)
  ├── workers/           ← reserved lane (built-in)
  ├── scripts/           ← shared helper scripts (dashboard-status.mjs, read-comments.py)
  └── agents/
        └── <name>/      ← ★ CUSTOM PERSONAS GO HERE (this is what the dropdown discovers)
```

The Launch dropdown's scanner reads **`.dashboard/agents/<name>/`** and lists any folder
with a root `CLAUDE.md`. The three reserved lanes live one level up and are NOT custom
personas — never put a custom persona directly under `.dashboard/`; it won't be discovered.

## Two flavors of persona — decide this first

The single most important design question: **does this agent need to drive the dashboard
itself** (launch/stop/message other agents), or just do its own work?

- **Plain persona** — does its own work with native tools (Bash, file edits, web). Examples:
  a note-taker, a doc reviewer, a code-writer. **Dropdown-launchable, works out of the box.**
  This is most personas. Pick this unless the user explicitly needs orchestration.
- **Orchestration persona** — needs the `agent-dashboard` MCP tools (`launch_agent`,
  `stop_agent`, `send_message_to_agent`, `list_agents`, …) to coordinate OTHER agents.
  These tools authenticate against the dashboard API with a token that **only exists while
  the app is running and rotates on every restart**. A persona gets that live token **only
  when launched on a privileged lane** (inline `--mcp-config` injection) — NOT from a file.
  See "Granting orchestration tools" below; this kind of persona can't just be dropdown-launched.

## The persona folder anatomy

A complete persona has these files. The dashboard's native "+ New agent" flow produces them;
if building/customizing by hand, this is the target:

```
.dashboard/agents/<name>/
  ├── CLAUDE.md                     identity + behavior contract (seeded from the exemplar
  │                                 persona; this is the agent's "who am I")
  ├── memory/MEMORY.md              persistent memory index across runs
  └── .claude/
        ├── settings.json           status hooks (REQUIRED — see below)
        └── skills/                 shipped skills (create-persona, read-comments, …)
```

- **Status hooks are the one mandatory tool-related thing.** Every dashboard agent reports
  its state (idle / working / done) via SessionStart / UserPromptSubmit / Stop hooks in
  `.claude/settings.json` that call the shared `dashboard-status.mjs`. Without them the
  dashboard can't track the agent. At depth `.dashboard/agents/<name>/` the hook path is
  `${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs` (**two** levels up — `../../`,
  not `../`).
- **No `.mcp.json` by default.** A custom persona is born with hooks + identity + memory +
  skills, and native tools (Bash/files/web). It does NOT get a `.mcp.json`. (A baked
  `.mcp.json` would make orchestration tools *appear* but fail to authenticate — see below.)

## The tools you can grant — inform the user, let them pick

Walk the user through what the agent could do. Recommend the smallest grant that fits.

| Capability | How it's granted | Notes |
|---|---|---|
| **Bash + file tools** (Read/Write/Edit/Grep/Glob) | native — always on | every persona has these |
| **Web** — WebSearch / WebFetch | native | research / lookup personas |
| **Default skills** — `create-persona`, `read-comments` | shipped into every persona | all personas |
| **Browser** — `browser_*` MCP | researcher-lane tooling | scraping / web-driving personas |
| **Orchestration** — `launch_agent`, `stop_agent`, `send_message_to_agent`, `list_agents`, `get_context_stats`, teams | **privileged lane launch only** (live token via inline `--mcp-config`) | coordinator personas; see below |

## Granting orchestration tools (the important caveat)

Do **not** try to grant orchestration tools by dropping an `agent-dashboard` server into a
folder `.mcp.json`. It will not work reliably:

- The dashboard's API token is minted fresh at app start and **rotates on every restart**;
  it is never persisted to disk. A token you copy into a `.mcp.json` is stale the moment
  the app restarts.
- A persona launched from the dropdown runs on the unprivileged **legacy lane**, which gets
  **no token injected**. The MCP server still *loads* (so the tools appear in the list), but
  every call fails with `Missing or invalid API token` (a 401). Visible ≠ usable.

The only mechanism that hands a persona a **live** token is a **privileged lane launch**,
where the dashboard injects `--mcp-config` with the current token at launch time. In
practice that means launching the persona with a lane flag (`isSupervisor: true` together
with `persona: <name>`) via the dashboard API — not the plain dropdown. So:

- **If the user wants a coordinator persona,** tell them it must be launched on a privileged
  lane to get working tools, and that the plain dropdown launch will give it tools that
  *look* present but 401. (If the dashboard later supports a per-persona lane declaration,
  prefer that — it makes orchestration personas dropdown-launchable with a live token.)
- **If the user just wants the agent to do its own work,** a plain persona is simpler and
  fully dropdown-launchable. Steer here unless coordination is genuinely required.

## How to create the persona

**Preferred — the dashboard's native "+ New agent" flow.** Open the Launch Agent dialog →
"+ New agent…", give the name + role. It scaffolds `.dashboard/agents/<name>/` with CLAUDE.md
(from the exemplar), memory, status hooks, and the default skills. Confirm the anatomy above.

**Manual / customization fallback.** To hand-build or tweak:

1. **Gather requirements:** a short **name/slug** (lowercase-hyphen), the **purpose** (one or
   two sentences → CLAUDE.md identity), and whether it needs **orchestration** (→ privileged
   lane) or just native tools (→ plain dropdown persona).
2. **Create the folder** `.dashboard/agents/<name>/` and write CLAUDE.md (start from the
   exemplar persona, replace identity/role), `memory/MEMORY.md` (a "# Memory Index" stub),
   `.claude/settings.json` (status hooks with `../../scripts/dashboard-status.mjs`), and copy
   the default skills into `.claude/skills/`. Do NOT add a `.mcp.json`.
3. **Don't hand-edit a dashboard-managed `CLAUDE.md` later** — the app may overwrite it on
   upgrade. For durable per-persona tweaks use a sibling **`CLAUDE.local.md`** (auto-loaded,
   never overwritten).

## Verify it works

1. Open the Launch dropdown — the persona appears under "— your custom agents —". (If not,
   reopen the dialog or restart the app; the scanner caches the list.)
2. Launch it; confirm it self-identifies from its CLAUDE.md.
3. Confirm the dashboard shows its status changing (idle → working → done) — proof the hooks
   fired.
4. For an orchestration persona, confirm it was launched on a privileged lane, then have it
   actually CALL a read-only tool (e.g. `list_agents`) and confirm it returns data, not a 401.

## Gotchas

- **Location:** custom personas MUST be under `.dashboard/agents/<name>/`. Reserved-lane
  names (`supervisor`, `researcher`, `workers`) are off limits.
- **Hook depth:** `../../scripts/` at `.dashboard/agents/<name>/`. One `../` too few and the
  status hooks silently fail.
- **Orchestration tokens rotate:** never bake an API token into a `.mcp.json`. Tools granted
  that way appear but 401. Use a privileged lane launch for a live token.
- **No nested `.dashboard/`:** launching a discovered persona writes nothing into its own
  cwd. A `.dashboard/` appearing *inside* a persona folder is leftover junk — safe to delete.
