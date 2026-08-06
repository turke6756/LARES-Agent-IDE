---
artifact_id: prop_ms8b41e7
title: Multi-provider supervisors — let any agent harness hold the supervisor lane
author: "Testing Grok and Anti" (workspace supervisor, AgentDashboard)
author_agent_id: 31b5c10c-aab0-4990-be3b-c715f4f45b6b
author_role: supervisor
author_provider: claude
authored_at: 2026-08-04T22:30:00-07:00
amended_at: 2026-08-06
---

# Proposal: multi-provider supervisors

## Problem

The supervisor role is currently Claude-Code-only in practice. The role's real
contract is small — consume the dashboard MCP toolset, react to
`[DASHBOARD EVENT]` injections, read/write files under `.lares/supervisor/` —
and none of that is intrinsically Claude. With grok and antigravity (agy) now at
worker parity (capture, yolo flags, git-init fail-closed, agy Stop hook — all
landed 2026-08-04) and gemini being removed in favor of agy, the natural next
step is letting the user choose which harness holds the supervisor lane, e.g.
`.lares/supervisor/<provider>/`.

Edward's ruling (2026-08-04): worker-lane MCP/skills parity is DROPPED — the
target is supervisors, and the first step is a **separate test**, not product
code.

## Known Claude-only dependencies (the gap list to probe)

1. **Memory-index launch injection.** The dashboard injects
   `memory/MEMORY.md` into the Claude launch context. No equivalent path exists
   for other CLIs — a non-Claude supervisor wakes amnesiac unless the index
   moves into its AGENTS.md-equivalent or first prompt.
2. **`--add-dir` workspace scoping.** Claude-specific flag. Each harness needs
   its own scope mechanism or it sees too little (cwd only) or too much.
3. **Skill auto-triggering.** agy skills are explicit `/invoke` only; a
   supervisor that never spontaneously reaches for `remember`,
   `checkpoint-forensics`, or `proposal-to-plan` loses institutional behavior.
   Quality cliff, not a hard blocker.
4. **Continuation/handoff machinery.** `save_continuation_brick`,
   context-percentage monitoring, and session resume are tuned to Claude's
   session model. Codex is session-addressable; agy/grok reattach semantics are
   unproven.

## Evidence so far (per provider)

- **codex** — MCP via `config.toml` and skills via `.agents/skills`: PROVEN
  live (worker lanes use both today).
- **agy** — stdio MCP via `.agents/mcp_config.json` and skills via
  `.agents/skills` (invoke-only): per research report
  `.lares/research/inbox/antigravity-cli-capabilities/2026-08-04-antigravity-cli-capabilities.md`
  (UNTRUSTED tier — web-derived, must be live-verified). Stop hook proven live
  on 1.1.10. Known: PreToolUse schema bug; deny matcher fails open on
  lookaheads and matches whole shell strings (see memory
  mb-2026-08-04-agy-stash-lookahead).
- **grok** — completely unverified; presumed claude-format config but no
  evidence.

## Proposed work: a standalone capability probe (no product code)

A separate test/probe work package, run outside the product codebase's launch
path, that answers per CLI (grok, agy, codex):

1. Can it connect to the dashboard's supervisor-lane MCP server (stdio) and
   successfully call a representative toolset: `get_my_context`, `list_agents`,
   `read_agent_chat`, `send_message_to_agent`?
2. Can it load and execute a supervisor skill (auto-trigger where supported,
   `/invoke` otherwise)? Which invocation modes work?
3. Can it receive an injected event mid-session (the `[DASHBOARD EVENT]`
   pattern) and act on it in the same turn?
4. What is its scoping story — can it be confined to
   `.lares/supervisor/<provider>/` while still reading the workspace root?
5. Session model: can a dead session be resumed/revived with context intact?

Deliverable: a per-provider capability matrix (works / works-degraded /
missing) with live evidence, plus the ranked list of launch-adapter work needed
to close each gap. No changes to `src/` in this WP.

## Architectural direction (for the follow-on, not this WP)

Treat the supervisor contract the way workers were treated: provider-neutral
scaffold, with claude-isms (memory injection, `--add-dir`) moved behind
per-provider launch adapters — the same pattern `provider-auto-approve.ts`
established for yolo flags.

## Trust caution

The supervisor is the workspace's trust anchor (launch/stop/revive/gate
authority). agy's deny matcher already failed open once. Non-Claude supervisors
should clear a HIGHER proof bar than workers before receiving launch-class
authority; the probe's evidence is the entry ticket, not the approval.

## Probe results (run live 2026-08-04, post-restart build)

Three supervisor-peers were launched (`launch_agent {mode: supervisor-peer,
provider: …}`) in the AgentDashboard workspace and asked to exercise the
read-only supervisor toolset. Full reports in each agent's chat history
(codex 844757e5, grok 2b2c6a00, agy 58a0bd18).

| Capability | codex | grok | agy |
|---|---|---|---|
| Launches as supervisor-peer, runs turn, goes idle | yes | yes | yes (input workaround needed) |
| Dashboard MCP server visible | **no** (0 tools) | **yes** (29 tools, `ready`) | **no** (0 tools) |
| MCP tool calls succeed | n/a | **no — 401** `Missing or invalid API token (AGENT_DASHBOARD_API_TOKEN)` | n/a |
| Supervisor skills visible | yes (full roster) | yes (full roster) | yes (30 incl. antigravity-guide) |
| Initial-prompt delivery | ok | ok | **broken** — sign-in-banner false positive blocks `send_message`; `send_keys` raw path works |

Interpretation:

- **grok is a near-miss**: it reads the claude-format `.mcp.json` in the
  supervisor cwd and discovers all 29 tools, but the
  `AGENT_DASHBOARD_API_TOKEN` env injection happens only on the claude launch
  path, so every call 401s. One launch-adapter change (inject the token env for
  grok) likely makes grok a functional supervisor. Note: the toolset it saw is
  the older/full roster (team/channel tools, no plan tools) — the per-role
  toolset gating should be revisited for non-claude peers.
- **codex and agy need per-provider MCP wiring** in the supervisor cwd
  (`config.toml` for codex, `.agents/mcp_config.json` for agy) before they can
  see the server at all. Skills already resolve for both.
- **agy input delivery bug** (filed separately): the dashboard's sign-in
  detector latches agy's transient startup banner ("You are currently not
  signed in") and permanently refuses `send_message_to_agent` delivery
  ("no runner accepted the bytes"), even once the CLI shows signed-in. The
  `send_keys_to_agent` raw path works and is the current workaround. This
  blocks agy for BOTH worker relaunch messaging and supervisor use.

## Status

Probe COMPLETE (2026-08-04). Items 1–2 of the follow-on LANDED and VERIFIED
LIVE 2026-08-05: agy delivery fixed (0e68dff, VT current-screen classifier) and
grok supervisor-peer MCP calls now succeed (8986321 env rail). Live
verification exposed one more dependency: the static
`.lares/supervisor/.mcp.json` (legacy, Jun 12) carried a hardcoded stale token
in its `env` block, shadowing the injected per-agent token — removed by the
supervisor as a workspace-config fix. Product-side follow-on should make the
dashboard OWN per-launch MCP config for non-claude providers instead of
relying on a static file.

Remaining ranked work:

1. Per-provider MCP wiring for codex (`config.toml`) and agy
   (`.agents/mcp_config.json`) in the supervisor scaffold.
2. Role-toolset gating for non-claude peers: grok gets the legacy/full roster
   via the `DASHBOARD_MCP_TOOLSETS` default in `scripts/mcp-supervisor.js`
   (team/channel tools, no plan tools) — decide the supervisor-peer toolset
   deliberately and gate per lane, not per file default.
3. Dashboard-owned per-launch MCP config for non-claude providers (kill the
   static `.mcp.json` dependency).
4. Claude-ism adapters if a non-claude supervisor is productized: memory-index
   launch injection and `--add-dir` workspace scoping equivalents; skill
   auto-trigger remains a quality cliff on agy (invoke-only).
5. Re-run the probe as the acceptance test after each step.
