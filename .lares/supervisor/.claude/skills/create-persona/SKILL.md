---
name: create-persona
description: Help the user design and set up a NEW AgentDashboard persona (a reusable custom agent). Use when the user says things like "create a new agent", "make me a persona", "set up a new dashboard agent", "I want an agent that does X", or asks how personas/agent tools/the .lares folder structure work. Walks the user through choosing the agent's purpose and tools, then constructs the persona folder so it's launchable from the dashboard's Launch Agent dropdown.
---
<!-- skill body v2: privilege question is none/supervisor; per-persona lane declaration exists now -->

# Create a Persona

A **persona** is a reusable custom agent in the AgentDashboard: a folder with its own
identity, memory, status hooks, and skills. Once it exists, it shows up in the **Launch
Agent** dropdown under "— your custom agents —" and can be launched into its own context
any time. This skill helps you design one *with* the user and set it up correctly.

Your job is to be a **guide**, not just a scaffolder: most users don't know what tools an
agent can have or how the `.lares` folder is laid out. Explain the choices, recommend
sensible defaults, then build it.

**You never write under `.claude/`.** The privilege question below is purely
conversational — the dashboard app writes `persona.json` and the hook-bearing
`.claude/settings.json` for you via its `persona:create` / `persona:setLane` IPC.
Editing anything under `.claude/` from a skill trips the harness's interactive
confirm and hangs a headless run.

## Where personas live

```
<workspace>/.lares/
  ├── supervisor/        ← reserved lane (built-in, do not treat as a custom persona)
  ├── researcher/        ← reserved lane (built-in)
  ├── workers/           ← reserved lane (built-in)
  ├── scripts/           ← shared helper scripts (dashboard-status.mjs, read-comments.py)
  └── agents/
        └── <name>/      ← ★ CUSTOM PERSONAS GO HERE (this is what the dropdown discovers)
```

The Launch dropdown's scanner reads **`.lares/agents/<name>/`** and lists any folder
with a root `CLAUDE.md`. The three reserved lanes live one level up and are NOT custom
personas — never put a custom persona directly under `.lares/`; it won't be discovered.

## Two flavors of persona — decide this first

The single most important design question: **which privilege should this agent inherit —
`none` or `supervisor`?** (i.e. does it just do its own work, or does it need to drive
the dashboard — launch/stop/message other agents?)

- **`none` (plain persona)** — does its own work with native tools (Bash, file edits, web).
  Examples: a note-taker, a doc reviewer, a code-writer. **Dropdown-launchable, works out of
  the box;** no `persona.json` is written. This is most personas. Pick this unless the user
  explicitly needs orchestration.
- **`supervisor` (orchestration persona)** — needs the `agent-dashboard` MCP tools
  (`launch_agent`, `stop_agent`, `send_message_to_agent`, `list_agents`, …) to coordinate
  OTHER agents. Choosing `supervisor` has the app write `persona.json {"lane":"supervisor"}`,
  which grants the **supervisor-tier MCP toolset** AND the **supervisor hook scaffold**
  (incl. the `Notification → waiting` hook) at launch, while keeping the persona
  `isSupervisor:false` — it renders as its **own** dashboard card. A `supervisor`-lane
  persona is fully **dropdown-launchable** with a live token (see "Granting orchestration
  tools" below).

## The persona folder anatomy

A complete persona has these files. The dashboard's native "+ New agent" flow produces them;
if building/customizing by hand, this is the target:

```
.lares/agents/<name>/
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
  dashboard can't track the agent. At depth `.lares/agents/<name>/` the hook path is
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
| **Orchestration** — `launch_agent`, `stop_agent`, `send_message_to_agent`, `list_agents` | **`supervisor` privilege lane** (live token via inline `--mcp-config`; dropdown-launchable once `persona.json` declares the lane) | coordinator personas; see below |

## Granting orchestration tools (the important caveat)

Do **not** try to grant orchestration tools by dropping an `agent-dashboard` server into a
folder `.mcp.json`. It will not work reliably:

- The dashboard's API token is minted fresh at app start and **rotates on every restart**;
  it is never persisted to disk. A token you copy into a `.mcp.json` is stale the moment
  the app restarts.
- A persona launched from the dropdown with **no declared lane** runs on the unprivileged
  **legacy lane**, which gets **no token injected**. The MCP server still *loads* (so the
  tools appear in the list), but every call fails with `Missing or invalid API token` (a
  401). Visible ≠ usable.

The mechanism that hands a persona a **live** token is a **privileged lane launch**, where
the dashboard injects `--mcp-config` with the current token at launch time. **The
per-persona lane declaration EXISTS NOW:** when you have the app give a persona the
`supervisor` privilege, it writes `persona.json {"lane":"supervisor"}` into the persona
folder, and a plain **dropdown** launch then auto-injects the live token AND scaffolds the
supervisor hook block (SessionStart / Stop / UserPromptSubmit / Notification → waiting). So
a supervisor-inheriting persona is fully dropdown-launchable with working orchestration
tools and live hook-driven status — no manual `isSupervisor` flag needed, and it keeps its
own dashboard card (`isSupervisor:false`). So:

- **If the user wants a coordinator persona,** have the app give it the `supervisor`
  privilege lane (the privilege question above). The dashboard writes `persona.json` + the
  hook-bearing `settings.json`; the persona then gets a live token from the plain dropdown
  launch and reports hook-driven status (including `waiting` on a blocking prompt). A
  `none`-lane (legacy) launch instead gives it tools that *look* present but 401.
- **If the user just wants the agent to do its own work,** a plain `none` persona is simpler
  and fully dropdown-launchable. Steer here unless coordination is genuinely required.

## How to create the persona

**Preferred — the dashboard's native "+ New agent" flow.** Open the Launch Agent dialog →
"+ New agent…", give the name + role. It scaffolds `.lares/agents/<name>/` with CLAUDE.md
(from the exemplar), memory, status hooks, and the default skills. Confirm the anatomy above.

**Manual / customization fallback.** To hand-build or tweak:

1. **Gather requirements:** a short **name/slug** (lowercase-hyphen), the **purpose** (one or
   two sentences → CLAUDE.md identity), and **which privilege this agent should inherit:
   `none` or `supervisor`**. `none` = a plain dropdown persona with no `persona.json`.
   `supervisor` = the app writes `persona.json {"lane":"supervisor"}`, granting the
   supervisor MCP toolset AND the supervisor hook scaffold (incl. `Notification → waiting`)
   while staying `isSupervisor:false` (its own card). This privilege question is
   **conversational only** — the app writes `persona.json` + `settings.json` via
   `persona:create` / `persona:setLane` IPC; the skill itself NEVER writes under `.claude/`.
2. **Create the folder** `.lares/agents/<name>/` and write CLAUDE.md (start from the
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

- **Location:** custom personas MUST be under `.lares/agents/<name>/`. Reserved-lane
  names (`supervisor`, `researcher`, `workers`) are off limits.
- **Hook depth:** `../../scripts/` at `.lares/agents/<name>/`. One `../` too few and the
  status hooks silently fail.
- **Orchestration tokens rotate:** never bake an API token into a `.mcp.json`. Tools granted
  that way appear but 401. Use a privileged lane launch for a live token.
- **No nested `.lares/`:** launching a discovered persona writes nothing into its own
  cwd. A `.lares/` appearing *inside* a persona folder is leftover junk — safe to delete.
