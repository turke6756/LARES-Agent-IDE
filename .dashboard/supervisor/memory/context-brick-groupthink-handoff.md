# HANDOFF — Run the context-brick re-spec GroupThink, then write the FINAL hardened plan

**Written 2026-07-02 by the outgoing supervisor session (context nearly full).** You are the
successor. This file is your complete brief; everything here was verified this session unless
marked otherwise. Verify liveness facts with your tools before acting — this note is advisory
data, not authoritative state.

## Mission (two phases, one deliverable)

1. **Run a GroupThink** (serial mode) to close the open design questions listed below.
2. **Synthesize the FINAL hardened implementation plan** for the supervisor context brick
   (Inc 1 → Inc 5), folding in (a) the 2026-07-02 audit, (b) the new GroupThink output, and
   (c) the v2 phase-order constraints — into ONE worker-ready document:
   **`plans/context-brick-implementation-final.md`**.

The deliverable bar: a worker can be briefed from that single file per increment with zero
further questions, and every increment slots cleanly into the v2 multi-supervisor migration
(Phase A = Inc 1; Inc 2 ≡ B1a P1-10a with one owner; exposure gate preserved).

## Read these, in this order, before launching anything

1. `plans/context-brick-plan-audit-2026-07-02.md` — **the audit. Primary input.** Contains
   verdict, verified-vs-stale claim inventory, and §7's recommended path (which you are executing).
2. `memory/context-brick-implementation.md` — the priming map (Inc 1→5 details) **with the
   ⚠️ 2026-07-02 stale-claims addendum at the top. Trust the addendum over the body.**
3. `plans/context-brick-nextsteps-groupthink-serial.md` — the Inc 4/5 mechanism spec (its
   runtime claims verified; its data-model/watcher bugs are audit §5).
4. Skim: `plans/supervisor-context-brick-implementation.md` (Inc 1 tasks A–D + roadmap),
   `plans/context-brick-nextsteps-groupthink-parallel.md` (§2a/§3 — the only concrete
   Inc 2/Inc 3 shapes anywhere), `plans/v2-migration-phase-order-audit.md` (phase order,
   exposure gate), `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md` D-16 + P1-10a +
   P1-07r step 5, `plans/b1a-reaudit-vs-live-orchestration.md` §1/§2.

## What the GroupThink must decide/produce (the topic content)

Frame the deliberation as: *"Re-spec the context-brick plan stack against the audit — produce
amendments, not a redesign. The architecture is settled; the tickets are stale."* Specifically:

1. **Inc 2 header decision (the one genuinely open question).** Author identity for brick
   writes: honor the already-shipped `AGENT_DASHBOARD_SELF_ID`/`X-Self-Id` (zero new plumbing;
   env already on parent process both platforms, `index.ts:2722-2727` / `:3127-3132`) vs. add
   `AGENT_DASHBOARD_SUPERVISOR_ID`/`X-Supervisor-Id` at those same parent-env sites (D-16
   compliant; matches P1-10a naming and P1-07r step 5 route auth). **Hard constraints:** never
   in the shared `.mcp.json` (D-16); one ticket owned jointly with B1a P1-10a — no divergent
   duplicate rails; validation semantics must be written down (exists + in header workspace +
   `is_supervisor` else 403; asserted caller overrides the `getSupervisorAgent` LIMIT-1
   fallback, which stays non-asserted-only).
2. **Re-anchored Inc 1 tasks A–D** per audit §3: CALLER_HEADERS + `get_my_context` into
   `mcp-dashboard.js` `createApiRequest` (`:46-86`, Bearer token already there); C1 env
   injection at the parent-env sites (ensureMcpConfig is a dead stub); drop C3 (done); A tasks
   re-anchored to `route(method, url: URL, req)` at `:314`, admission gate `decideApiAccess`,
   CORS line `'Content-Type, Authorization'` at `:218`; teams/personas currently REQUIRE
   workspaceId (400) — decide + record that header-present relaxation is intended.
3. **Serial-doc amendments** per audit §5: dedicated `agents.continuation_generation` column
   (not restartCount); fold in the empty-memo/hard-ceiling escape; sysprompt builder falls
   back to `getCurrentBrick()` from DB (Electron-restart-mid-handoff must not produce a
   brickless successor — define the reconcile-path behavior); owned-idle gate becomes a
   busy-blocklist (`launching|working|waiting|restarting|receiving` block; `crashed` is
   non-blocking but its ids ride the attempt reason) — there is NO `stopped` status; relaunch
   route re-check adds the no-owned-orchestration-running condition; note-request injection
   rides the send handshake (HANDSHAKE OK/FAILED + handoff_failed recovery), never a bare
   write; pin initial constants (context threshold ~80% to match the existing event, hard
   ceiling ~95%, HANDSHAKE_TIMEOUT_MS, debounce ticks, backoff, page-human mechanism).
4. **Write the missing Inc 2 + Inc 3 tickets** (worker-ready). Inc 3: borrow parallel doc
   §3.1–3.3 wholesale (`getAgentsByOwner`, `GET /api/supervisor/owned-agents`,
   `list_my_agents`, counts-only in `get_my_context`), author identity per decision 1.

## How to run the GroupThink

- Tool: `run_orchestration({name:'groupthink', workspace_id, supervisor_id, topic, plan_path,
  mode:'serial'})`. Poll `get_orchestration_run`; events arrive as `[DASHBOARD EVENT]`.
- **Verify your own `supervisor_id` via `list_agents` — do NOT guess it** (the 2026-06-21
  self-identity bug in MEMORY.md is exactly this mistake; get_my_context does not exist yet).
- `plan_path`: `plans/context-brick-respec-groupthink.md` (the GroupThink's own artifact —
  distinct from your final synthesis file).
- Topic: compress the four numbered items above + pointer to the audit file. The planners can
  read files — point them at the audit and the doc list rather than pasting content.
- If it stalls: resume with `run_orchestration({name:'groupthink', resume_run_id})` from the
  stall event's hint.

## Then: the final synthesis (you write this, not the GroupThink)

`plans/context-brick-implementation-final.md` — structure suggestion:
Inc 1 (re-anchored tasks A–D + acceptance) → Inc 2 (decided rail + validation + P1-10a
reconciliation note) → Inc 3 → Inc 4 (serial doc §1–§4/§6/§7 with the amendments) → Inc 5
(watcher with fixed gate + escape + handshake) → cross-cutting landmines → per-phase
build/verify. Rules: anchor by SYMBOL not line; keep the restart-path byte-identical
invariant; scaffold edits need version bump + previousHashes + sentinel; every acceptance
list from the old docs carries over PLUS the audit's new criteria (crashed-owned-worker
doesn't block; app-restart-mid-handoff yields a bricked successor or defined degraded mode;
note-request survives a dropped submit).

Also do the bookkeeping: mark Inc 2 ≡ P1-10a in both doc stacks; note in
`plans/context-brick-plan-audit-2026-07-02.md` that the re-spec landed (link the final plan).

## Standing landmines (carry these; they bite)

- Shared-cwd invariant: never key agent↔session on one-agent-per-cwd; brick keys on dashboard id.
- D-16: per-supervisor identity NEVER in shared `.mcp.json`; parent process env only.
- You are a supervisor: coordinate via MCP tools; don't edit source; plans/memory writes are fine.
- `.claude/` write gate for launched agents — point worker outputs outside `.claude/`.
- PowerShell quoting: prefer `bash -lc` for multi-word launch args; verify via Win32_Process.
- Exposure gate: nothing may make multiple live supervisors real before the supervisor-id rail
  is honored (P1-02 after P1-10a/Inc 2).
- Line numbers in every doc drift — re-anchor by symbol before speccing.

## State snapshot (2026-07-02, end of session)

- Branch `exp/gt-handshake-pressure`, heavy uncommitted work tree (post-`b1136f2`).
- Inc 1 confirmed UNBUILT (no resolveIdentity / CALLER_HEADERS / get_my_context / CONTINUATION_*).
- `owner_agent_id` + `AGENT_DASHBOARD_SELF_ID` + API bearer token: SHIPPED.
- Audit written: `plans/context-brick-plan-audit-2026-07-02.md`. Memory addendum stamped.
- No GroupThink started yet — that is your first action after reading the inputs.
