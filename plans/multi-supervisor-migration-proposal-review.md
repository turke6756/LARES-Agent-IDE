# Proposal Review: Multi-Supervisor + Orchestration Runtime Migration

**Subject:** `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`
**Reviewers:** Lead Planner + Reviewer (GroupThink v1 deliberation)
**Date:** 2026-05-11
**Form:** Proposal review (not a new plan). Output is a punch list of edits the proposal author should apply to the document before the migration starts. After those edits, the proposal is approved.

---

## Verdict

**Conditionally approve.** The architecture is right, the sequencing premise is right, and the "what stays" boundaries are well-drawn. Approve after the proposal document is edited to:

1. Split 1a-prime into a prior, independently-soakable migration gate.
2. Replace the soft twin-mode "preference" with a hard switch.
3. Rework the supervisor event queue from singleton to per-supervisor (both routing and batch construction).
4. Close the remaining blocking decisions enumerated in §Blockers.
5. Apply the document edits enumerated in §Document edits.

These are document edits and one localized code rework (the queue), not architecture rework.

---

## Strengths to preserve

- Three concerns (in-process MCP, orchestration runtime, multi-supervisor) correctly identified as coupled by the `supervisor_id` + `orchestration_id` schema. The data-model coupling is the load-bearing argument for bundling and the doc states it cleanly.
- Explicit **What stays** sections for both the dev-mode scripts and the structured-chat surfaces. Pre-empts predictable scope creep.
- Phased acceptance criteria with the 1a-prime → 1a → 1b → 1c unblock chain explicit.
- Goals and Non-goals are exhaustive; "no new orchestrations as part of this migration" is the right boundary.
- The twin-skill / dogfood mirror mechanism is a clever way to keep the supervisor-edits-the-script dev affordance without poisoning production — but it needs B1 to be safe.

---

## Scope refinement: 1a-prime is its own gate

Reframe the proposal as **three deliverables**, with the in-process MCP runtime (1a-prime) shipping as a **prior, independently-soakable migration** that proves itself with existing tools before 1a's orchestration runtime starts emitting through it.

1a-prime is coupled to 1a/1b only by convenience (`McpToolContext` parallels `OrchestrationRunContext`); the `supervisor_id` schema coupling that justifies bundling only argues for orchestration runtime + multi-supervisor.

**Required addition: HTTP/SSE fallback contract.** If a provider's MCP client (Codex, Gemini) cannot hold SSE reliably, the fallback is a **thin stdio adapter wrapping the in-process MCP server** — not a return to per-agent stdio children, not abandoning the migration. The smoke test in 1a-prime step 2 must accept the stdio-adapter outcome as a "pass with fallback," not as a regression.

---

## Blockers (must close before kickoff)

### B1 — Twin-mode: hard switch, not soft preference

The proposal's CLAUDE.md "prefer non-`-script`" guidance is a probabilistic instruction to a non-deterministic model, and the two namespaces expose semantically similar operations. **One supervisor session gets either canonical MCP or script MCP, never both.** If A/B testing is needed, launch two separate supervisor instances with different `.mcp.json` configurations.

**Concrete edits to the proposal:**

- The `.mcp.json` writer takes a per-supervisor mode (`canonical` | `script`) and emits exactly one server family per supervisor.
- Dogfood default is `canonical`; opt into `script` per supervisor via launch form or env var.
- Delete the "two skills visible, prefer one" passage in "Supervisor skill changes."
- Replace it with: "Each supervisor session sees exactly one orchestration skill, determined by its MCP mode."
- Update Phase 1a-prime step 5 to write only one server family per supervisor's `.mcp.json`, keyed off the supervisor's mode.

### B2 — Per-supervisor event queue (both routing and batch construction)

[`src/main/supervisor/index.ts:418`](src/main/supervisor/index.ts) uses a single shared `supervisorQueuedEvents` array and one `eventDrainTimer`. With multiple supervisors, events for A and B will batch together and the drain delivers to whichever supervisor the singleton draws — wrong by construction. Phase 1b must include the following rework:

- Replace the singleton with `Map<supervisorId, { events: SupervisorEvent[]; drainTimer: Timer | null }>` keyed by resolved-owner supervisor ID.
- Event enqueue resolves owner via `agent.supervisorId` first; only enqueues if owner exists (no fallback to "the workspace's supervisor").
- **Batch payload construction must happen per queue.** No cross-supervisor `buildConsolidatedPayload(events)` call over a mixed-owner array should remain possible after the rework. Construction reads only its own queue's events.
- Each supervisor's drain is independent (its own timer, its own batch, its own delivery target).

**Acceptance criterion (add to Phase 1b):** "Events emitted by worker W route only to W's `supervisor_id`'s queue, verified by a two-supervisor smoke test where supervisor A and supervisor B each own a worker emitting events and each receives only its own worker's events, with no payload mixing."

### B3 — MCP-derived IDs, not caller-supplied

`mcp__supervisor__run_orchestration` must derive `workspace_id` and `supervisor_id` from the MCP connection / calling-agent context, not accept them as arguments. The supervisor cannot accidentally or maliciously launch work under the wrong owner.

**Concrete edits to the proposal:**

- Drop `workspace_id` and `supervisor_id` from the `run_orchestration` MCP arg list in the "MCP and HTTP surface" table.
- Keep them as explicit fields on the HTTP route (`POST /api/orchestrations`), where the UI invokes from outside a supervisor's context.
- The MCP server resolves both from the connection metadata (the calling supervisor's agent ID) and rejects the call if the calling agent is not a supervisor.

### B4 — In-flight orchestration upgrade policy

Pick one and document it explicitly in the migration:

- **Hard precondition (recommended):** dashboard startup detects in-flight orchestrations from the pre-migration era (running child Node processes claiming agents with `orchestration_id IS NULL` and a known PID) and refuses to upgrade until they complete or are explicitly stopped.
- **Pass-through:** legacy in-flight orchestrations are treated as `orchestration_id IS NULL` worker pairs and the in-process bridge ignores them. The script's existing stdout-tail event channel continues until the script exits.

Either is defensible; choose one before kickoff so the implementer is not left guessing.

### B5 — Cancellation default locked

Lock to: **members stay alive unless `stop_members: true` is passed.** This matches the stall behavior; explicit cancel adopting the same default keeps the supervisor's mental model consistent. Update Open Questions §4 from "recommended" to "decided" and reflect the default in the `cancel_orchestration` row of the MCP tool table.

### B6 — Rollback contract for `.mcp.json` rewrites

A user upgrading has their workspace `.mcp.json` rewritten to point at the in-process server. If a regression is discovered, the rollback is a subsequent dashboard release that rewrites `.mcp.json` again — there is no in-place fallback because user workspaces have no `scripts/` directory.

**Implication, documented in the proposal:** this is a one-way door per release; the in-process MCP server must pass full functional parity on all three providers (Claude, Codex, Gemini) before 1a-prime ships, not just the smoke test. Add this as an explicit ship-gate for 1a-prime.

---

## Document edits (accepted as edits, not redesigns)

### D1 — Concrete `getSupervisorAgent` call-site disposition

Replace the proposal's "audit them during the migration" line with this enumerated table:

| Site | Disposition |
|---|---|
| [`src/main/database.ts:376`](src/main/database.ts) `getSupervisorAgent` | Keep as legacy default. Filter to active supervisors if the contract claims "active." Add companion `getSupervisorAgents(workspaceId): Agent[]`. |
| [`src/main/supervisor/index.ts:343`](src/main/supervisor/index.ts) (event bridge) | Replace with `agent.supervisorId` lookup. If NULL, drop event. |
| [`src/main/supervisor/index.ts:391`](src/main/supervisor/index.ts) (event bridge) | Same as above. |
| [`src/main/supervisor/index.ts:529`](src/main/supervisor/index.ts) (duplicate guard) | Delete. |
| `src/main/ipc-handlers.ts` `agent:get-supervisor` | Add `agent:get-supervisors` (plural) for the launch-dropdown UI; keep singular as legacy default for callers that genuinely mean "the workspace's default." |
| `scripts/list-ids.js` | Dev-only; update to list all supervisors or leave with an explicit "legacy: shows the most-recent supervisor" comment. |

**Update stale line references in the proposal's References section:** `562 → 529`, `375 → 343`, `423 → 391`. Audit the rest of the doc for any other stale `:NNN` references against current `src/main/supervisor/index.ts` before kickoff.

### D2 — Event-naming rule (deterministic)

Replace the mixed convention in the "Event emission" section with this rule set:

- **Completion:** `orchestration.<type>.complete` — e.g., `orchestration.groupthink-v1.complete`.
- **Recovery (stall / abort / failed):** `orchestration.<type>.<recovery>` — e.g., `orchestration.groupthink-v1.stalled`.
- **Domain progress events** (e.g., `groupthink.turn-advanced`): `<type>.<event>`, no `orchestration.` prefix. These are informational and not tied to lifecycle.

**Grandfathering:** `groupthink.complete` is **grandfathered and emitted only for backward compatibility during/after the GroupThink v1 migration.** The canonical new completion event is `orchestration.groupthink-v1.complete`. Future code, including new orchestration types, must not treat `groupthink.complete` as the preferred pattern; consumers should subscribe to both during the transition and switch to the canonical event once the grandfathered emitter is removed in a later cleanup pass.

### D3 — Resume-merge order (deterministic)

On `POST /api/orchestrations/:id/resume`:

1. Base: `orchestrations.params_json` (original launch params).
2. Apply: `OrchestrationOutcome.resumePayload` from the prior stall (if any).
3. Apply: caller-supplied `params_override` (if any).

Last-write-wins on collisions. Document this precedence order in the "MCP and HTTP surface" section under the `/resume` route.

### D4 — Phase boundary fix

Move "Default supervisor on launch UI" from Phase 1b item 4 to Phase 1c. It is a UI change.

### D5 — Phase 1c acceptance gains catalog UI

Add to Phase 1c acceptance: "The Orchestrations catalog tab lists available orchestrations (from `GET /api/orchestrations/available`), renders the GroupThink v1 parameter form from the descriptor's parameter schema, and submits a run that lands in the chosen supervisor's card."

### D6 — `MEMORY.md` index-race note

Add one line to "Memory remains shared":

> The index file `MEMORY.md` itself is the only race surface — per-memory files are independent and append-only by name. The standard mitigation is the supervisor using `Edit` (append) rather than `Write` (rewrite) on the index file. Individual memory file conflicts are non-issues by construction.

### D7 — Open Questions cleanup

After the body edits above, reclassify the Open Questions section so it stops mixing blocking decisions with deferrable notes:

- **Decided in body:**
  - §1 (events table vs new table) — reuse `events` with nullable `orchestration_id`; verify row size during implementation.
  - §4 (cancellation default) — locked per B5.
- **Implementation notes (non-blocking):**
  - §3 (script divergence policy) — user prefers manual port; revisit post-migration.
  - §5 (cwd assumptions) — grep for cwd-uniqueness assumptions during 1b.
- **Already removed in body:**
  - §2 (MCP tool location) — addressed in "Architecture — in-process MCP runtime."

After this cleanup, "Open Questions" should be empty or contain only the implementation notes; nothing in it should block kickoff.

---

## Approval criteria (when this review is satisfied)

The proposal `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md` is approved and ready to start when its document reflects:

1. 1a-prime split into a prior, independently-soakable gate with the stdio-adapter fallback contract (Scope refinement).
2. Hard-switch twin-mode (B1).
3. Per-supervisor event queue, including per-queue batch payload construction, added to Phase 1b with the two-supervisor smoke acceptance (B2).
4. MCP-context-derived IDs in the tool surface (B3).
5. In-flight upgrade policy chosen (B4).
6. Cancellation default locked at "members stay alive" (B5).
7. `.mcp.json` rollback contract documented and tied to a 1a-prime ship-gate of three-provider parity (B6).
8. Document edits D1–D7 applied.

No further architectural change is required — the design is sound. The migration may proceed once the above edits land in the proposal document.

---

## Open questions the review did not need to resolve

These were considered and intentionally not escalated to blockers; they are either deferrable or implementation-level:

- Whether `params_json` and `resumePayload` should be merged at runtime or stored already-merged — implementer's call; D3 fixes the precedence rule, the storage shape is free.
- Whether the orchestration catalog UI form-rendering uses an existing JSON-schema-form library or a hand-rolled mapper — implementer's call within Phase 1c.
- Long-term policy for `scripts/groupthink-v1.js` divergence — the user's stated preference (manual port) stands; revisit after the migration is live.
- Whether per-supervisor cwd matters — proposal's stance ("session UUIDs key resume, not cwd") is correct; flag for a grep during 1b implementation.


<!-- groupthink_members: 2c378345-909a-4c20-b81d-bf8c19102602, null -->
