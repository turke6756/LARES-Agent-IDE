# V2: Supervisor-Centric Dashboard Initiative (the big lift)

**Recorded:** 2026-06-03. **Why this matters:** This is the umbrella program for
version 2 of AgentDashboard. It is a multi-doc, multi-layer initiative and — as of
this writing — **almost none of it is actually implemented.** Several large design
docs reference each other; reading any one alone gives a misleadingly "done" feeling.
This memory is the map so a future session doesn't have to re-derive it.

## The hub document

`docs/SUPERVISOR_DASHBOARD_UI_MIGRATION.md` is the **program game plan** (its Part 0)
*and* the UI-migration spec (Parts 1–5). Read Part 0 first for the whole board. It is
renderer-only itself (layer L2) but maps every flanking workstream.

## The doc set (the "several large documents", mostly NOT implemented)

| # | Workstream | Doc | Status (per Part 0 + my 2026-06-03 verify) |
|---|---|---|---|
| 1 | **Identity & scoping (L0)** | `plans/supervisor-context-brick-architecture.md` + `-implementation.md` | Increment 1 "implementation-ready"; **NOT merged.** Verified: shim has no `AGENT_DASHBOARD_WORKSPACE_ID`/`CALLER_HEADERS`/`get_my_context`; api-server has no `resolveIdentity`. |
| 2 | **Multi-supervisor data model (L1)** | `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md` | Phase 1 partly shipped; Phase 2 (UI) NOT shipped. `agents.supervisor_id`/`orchestration_id`/`role` + `orchestrations` table reportedly not present at `database.ts:40-61`. |
| 3 | **Plan-subscription data (L1)** | `docs/PLAN_SUBSCRIPTION_MIGRATION.md` | Planning, not started. `plans` registry, `supervisor_focus`, focus MCP tools, wake event, fs sync. |
| 4 | **Dashboard UI (L2)** | `docs/SUPERVISOR_DASHBOARD_UI_MIGRATION.md` (Parts 1–5) | Planning; blocked on #2 + #3. Gold supervisor card, nested workers, orchestration sub-groups, focused-plans subsection, plans sidebar, launch surfaces. |
| 5 | **Planning surface (L3)** | `docs/INTERACTIVE_PLAN_SURFACE_PROPOSAL.md` (+ `PLAN_CONTROL_PLANE.md`) | Designed, not built. HTML plan substrate, lifecycle, compile-to-JSON, execution. §14 reliability benchmark still gates choices. |
| 6 | **Plan provenance & history (L4)** | `docs/PLAN_SURFACE_PROVENANCE_REVISION.md` | Designed 2026-05-30 (honest-core v1 locked); not built. Frozen `agents.plan_id`, `plan_events` semantic spine (Stop-hook-written), L0/L1/L2 history projection, trust split. |
| 7 | **Forward: manifest contract** | `docs/MULTI_SUPERVISOR_PHASE3_MANIFEST.md` | Forward design only; §2.5 UI config object pre-aligned to it. |

## The five-layer stack (dependency, not strict build order)

```
L0  Identity & scoping ... context-brick: workspace_id now → +project/supervisor/PLAN ids on one rail (#1)
L1  Data model ........... multi-supervisor schema · plans/supervisor_focus · agents.plan_id · plan_events (#2 #3 #6)
L2  UI surface ........... gold card · nested workers · orchestration sub-groups · focused plans · plans sidebar (#4) THIS-IS-THE-HUB-DOC
L3  Planning surface ..... plan HTML · lifecycle · compile→JSON · execute — docks into L2 (#5)
L4  Provenance & history . plan_events (hook-written) · L0/L1/L2 projection — surfaced in L2, read on wake via L0 (#6)
```

**Headline goal:** a human — or an autonomous supervisor recovering from `/clear` —
opens the dashboard and sees, per supervisor, the workers/orchestrations it owns, the
plans it shepherds, and a trustworthy progressively-disclosed history of each plan.
Organizing truth: **supervisors own plans; every agent a supervisor launches serves a
plan; the dashboard records that activity as the plan's spine.**

## Critical path for the headline goal (per Part 0 §0.3)

1. **L0** — extend context-brick rail with `plan_id` (`AGENT_DASHBOARD_PLAN_ID` → `X-Plan-Id`), resolved+frozen at launch.
2. **L1** — add `agents.plan_id` (frozen history key) + `plan_events` table (semantic spine).
3. **L4** — teach the existing `dashboard-status.mjs` Stop hook (already fires Claude+Codex) to emit `plan.artifact.*` / `plan.scope.changed` / `plan.transition.*` on plan-touching turns; build `read_plan_projection`.
4. **L2** — surface the projection in the focused-plans subsection (§2.6) + future per-plan history rail.

Trust split: everything provenance adds is trustworthy *because* it lands in L0/L1 (DB
+ hook), **not** in agent-edited HTML.

## CONNECTS TO THE WORKSPACE_ID TOKEN-BURN PROBLEM (the live pain)

Supervisors today burn thousands of tokens just discovering their own `workspace_id`
(no path from "I'm a supervisor in workspace X" → its UUID; `list_agents` dumps all
~70 agents and omits the field; no `list_workspaces`; the WSL curl fallback is broken).
**The L0 context-brick increment is the fix and is fully specced but unshipped.** It:
- Injects `workspace_id` into the supervisor's **system prompt** at launch (Task C2 echo line) → zero discovery cost, survives `/clear`.
- Makes MCP tools **auto-scope** from an `X-Workspace-Id` header (Tasks A3/B2/B4) → `list_agents` with no arg returns only your workspace; the id becomes unnecessary to pass.
- Adds **`get_my_context`** (no-arg whoami) (Tasks A4/B3).
- Plants a standing **"Re-Orientation on Revival"** instruction in `SUPERVISOR_AGENT_MD` (Task D1) so the supervisor self-orients first after any `/clear`/crash/compaction.
- Fixes the hardcoded `'24678'` port (Task C3).

Ship sequence: A→B→C→D in the tree → `npm run build:main` → apply D3 on-disk dual-edit
to `.dashboard/supervisor/CLAUDE.md` (scaffolder never overwrites) → `npm run restart`
→ restart the running supervisor. Each layer is independently shippable + backward-
compatible (gated on `identity.asserted`, never on `workspaceId == null`).

**Does NOT fix:** multi-supervisor disambiguation (`getSupervisorAgent` is `LIMIT 1`
newest; `X-Supervisor-Id` captured-but-ignored), the WSL curl-host issue (only the port
bug), and it scopes `list_agents` output rather than adding a per-row `workspaceId`.

## How to read the set (Part 0 §0.4)

- Identity/orientation? → `supervisor-context-brick-implementation.md` then UI doc Part 1 "Prerequisites".
- Plan history/provenance? → context-brick impl (the rail `plan_id` rides) → `PLAN_SURFACE_PROVENANCE_REVISION.md` → UI §2.6 + Part 5.
- The UI itself? → UI doc Parts 1–5; prereqs in Part 1.
- Plan substrate? → `INTERACTIVE_PLAN_SURFACE_PROPOSAL.md` (read its 2026-05-30 amendment banner first).

## Notable future-work payoff (UI doc Part 5)

Animated/replayable plan-execution view: dashboard renders a live task-graph over the
`plan_events`/`file_activities`/`agents.status` stream (NOT agent-authored HTML script,
which is stripped). Because every event is persisted (DB-as-event-store), the same
renderer that live-tails an execution can scrub a finished one — live=animation,
after=replay. Needs no new data beyond the L1/L4 `plan_events` spine already on the
near-term path.

## Bottom line for V2 planning

This is a genuinely big lift: 7 workstreams, 5 layers, ~6 design docs, almost nothing
merged. The leverage order is **L0 first** (context-brick — it's the cheapest, unblocks
identity for everything above, and immediately stops the supervisor token-burn), then
L1 schema (#2/#3/#6 columns+tables), then L2 UI, with L3/L4 designed but gated on the
planning-surface reliability benchmark. Start any V2 push by confirming current
merge-state against the tree — the docs read as "done" but are mostly intent.
