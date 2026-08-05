---
plan_artifact_id: plan_pigt5a83
kind: work-packages
authored_at: 2026-08-05
author: supervisor f56fe814-3702-477f-a492-75e64b4ec141
---

# Work packages — provider-inclusive GroupThink (plan_pigt5a83)

Bundle-contract shape per `.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`.
Normative detail lives in the two hardened deliberation docs; each WP cites its sections:

- **[DELIB-A/B/C]** `.lares/proposals/supporting/2026-08-05-provider-inclusive-groupthink-deliberation.md` (run 27d25aa3)
- **[DELIB-B3a]** `deliberations/2026-08-05-b3a-availability-signal.md` (run 290646e4, int_a7b3c9e2)

Default worker lane: **codex** (standing directive). Dispatch is a separate explicit
human trigger — nothing here auto-launches.

---

## WP-1 — Canonical provider set + MCP enum parity (A1 + A3)

- **Files:** `src/shared/types.ts`; `scripts/mcp-tools-orchestration.js`; new parity test.
- **Dep:** none (first WP).
- **Do:** Add `LAUNCHABLE_AGENT_PROVIDERS` + `isLaunchableAgentProvider` guard per [DELIB-A/B/C] WP-A1 (verbatim shape). Enum `lead_provider`/`reviewer_provider` in `scripts/mcp-tools-orchestration.js:177-178` per WP-A3 (writer/reviewer role descriptions, "omit to inherit the workspace default", no proof-gate text).
- **Accept:** Parity test imports the compiled constant and asserts exact **ordered** equality against BOTH JS enums (`run_orchestration` params AND the `launch_agent` enum). JS enums stay literal duplicates — no runtime import of `.ts`.
- **Non-goals:** No service validation (WP-2); no settings module (WP-3).
- **Verify:** New parity test green; `tsc` clean; sibling `orchestration-binding.test.ts` still green.

## WP-2 — Service provider validation + resume-409 + catalog copy (A2 + A5 + A4)

- **Files:** `src/main/orchestration/service.ts`; `src/main/orchestration/catalog.ts`; `orchestration-service.test.ts`.
- **Dep:** WP-1 (uses `isLaunchableAgentProvider`).
- **Do:** Exported `assertGroupthinkProvider` replacing the gemini-only checks (service.ts:105-114), called for both slots before the default coalesce, per [DELIB-A/B/C] WP-A2. Resume branch: 409 on lead/reviewer mutation (beside the planningIntent 409 at :116), `legacyCommand`-derived providers folded into `req.*` first, per WP-A5. Catalog copy reframed per WP-A4 (writer slot's job; any of the four; drop "only claude writes reliably").
- **Accept:** All four providers accepted in either slot incl. same-provider pairs; `gemini`/unknown/empty → 422; resume mismatch → 409, match passes, gemini prior → 422.
- **Non-goals:** No workspace-default coalesce (WP-4); no writer-ack gate ever.
- **Verify:** `orchestration-service.test.ts` + `groupthink-v2.test.ts` green; `tsc` clean.

## WP-3 — Workspace-scoped settings module (B1)

- **Files:** `src/shared/types.ts`; `src/shared/constants.ts`; new `src/main/orchestration/orchestration-provider-settings.ts` + test.
- **Dep:** WP-1.
- **Do:** `OrchestrationProviderSettings` + defaults, storage at `workspaceStateDir(ws.path)/orchestration-provider-settings.json`, `Map<workspaceRoot,…>` cache, and the two strictly-separated entry points — `sanitizeOrchestrationProviderSettings` (READ RECOVERY, per-field default) vs `validateOrchestrationProviderSettingsUpdate` (WRITE VALIDATION, typed throw, no coercion) — plus load/save(atomic temp+rename)/cached/update/`__reset…ForTest`, all per [DELIB-A/B/C] WP-B1 verbatim.
- **Accept:** Malformed load → per-field defaults, never throws; invalid explicit update → typed reject AND prior on-disk settings proven unchanged; valid update round-trips atomically; two workspace roots fully isolated (no cache cross-leak).
- **Non-goals:** No service wiring (WP-4); no transport/UI (WP-5a/5b).
- **Verify:** New module test green; `tsc` clean.

## WP-4 — Precedence coalesce + preflight exposure (B2 + B3)

- **Files:** `src/main/orchestration/service.ts`; `src/main/api-server.ts` (context route); `scripts/mcp-tools-observability.js` (description only); tests incl. `api-identity.test.ts`.
- **Dep:** WP-2, WP-3.
- **Do:** Fresh-run branch coalesces `req.* || workspace default` (service.ts:156-157) per [DELIB-A/B/C] WP-B2 — `assertGroupthinkProvider` already ran on `req.*`. Add `orchestrationProviderDefaults.groupthink` to `/api/supervisor/context` (workspace from authenticated `X-Workspace-Id` only); extend `get_my_context` tool description; `start_run` `{runId}` contract unchanged, per WP-B3.
- **Accept:** Precedence proven end-to-end: explicit > workspace default > built-in (assert persisted `OrchestrationRun` providers each case). Context route carries the field scoped by `X-Workspace-Id`; the `get_my_context` MCP proxy path itself is exercised, not only the raw route.
- **Non-goals:** No availability signal (WP-6a) — that is a sibling key, different resolver.
- **Verify:** `orchestration-service.test.ts`, `api-identity.test.ts`, `scripts/mcp-tools-observability.test.js` green; `tsc` clean.

## WP-5a — Settings transport: IPC + HTTP + preload (B4 transport half)

- **Files:** `src/main/ipc-handlers.ts`; `src/main/api-server.ts` (route pair); `src/preload/*`; shared typings; transport tests.
- **Dep:** WP-3.
- **Do:** IPC `get_/update_orchestration_provider_settings` (accept `workspaceId`, resolve `ws.path` main-side, update path calls `validateOrchestrationProviderSettingsUpdate`); HTTP pair deriving workspace **exclusively** from authenticated `X-Workspace-Id` (never body/query id; do NOT copy the gauge endpoint's app-global scoping); invalid → 422/typed reject, prior settings intact; changed-event broadcast tagged with `workspaceId`. Typed preload bridge methods. Per [DELIB-A/B/C] WP-B4 transport paragraphs.
- **Accept:** HTTP getter/setter ignore any body workspace id; invalid update → 422 with prior settings proven intact; IPC round-trip + typed reject covered.
- **Non-goals:** No renderer component (WP-5b).
- **Verify:** Transport tests green; `tsc` clean.

## WP-5b — "GroupThink Providers" Tools tab (B4 renderer half)

- **Files:** new `src/renderer/components/orchestration/GroupThinkProvidersPanel.tsx`; `src/renderer/components/fileviewer/FileViewerPanel.tsx` (~line 257 dispatch branch); `src/renderer/components/layout/TopBar.tsx` (open trigger); renderer tests.
- **Dep:** WP-5a.
- **Do:** Two `<select>`s from `LAUNCHABLE_AGENT_PROVIDERS`, current effective values for the selected workspace, Save + Reset-to-defaults; `toolId: 'groupthink-providers'` branch beside `context-window-warning`; TopBar Tools entry mirroring the existing trigger; stale-async-load guard on workspace switch (FileViewerPanel:78 shape); subscribers ignore events tagged for other workspaces. Per [DELIB-A/B/C] WP-B4.
- **Accept:** Workspace switch re-loads; stale load dropped mid-fetch; a tagged update arriving after a switch cannot overwrite the newly-selected workspace's panel state; other-workspace broadcast ignored; options match the canonical const.
- **Non-goals:** No general Settings pane; do not overload `ContextWindowWarningPanel`.
- **Verify:** New renderer tests + sibling `FileViewerPanel`/TopBar suites green (run the sibling suites, not only the new files); `tsc` clean.

## WP-6a — Availability signal: types, resolver, registry, route (B3a core)

- **Files:** `src/shared/types.ts`; new `src/main/provider-availability.ts`; new `src/main/supervisor/provider-runtime-observations.ts`; `src/main/api-server.ts:2418`; `scripts/mcp-tools-observability.js:116-126`; `provider-availability.test.ts`.
- **Dep:** WP-1 (canonical const). Independent of WP-4 (sibling route keys — coordinate the route edit if concurrent).
- **Do:** Implement [DELIB-B3a] Decisions 1, 2, 4 and the registry of Decision 3 verbatim: public DTO + `PROVIDER_AVAILABILITY_REASON_ORDER`; pure `resolveProviderAvailability` (no I/O/clock) + thin `getAvailableProviders` (globally TTL-cached `detectRuntimePrerequisites()` with NO workspace option); session-scoped `Map<provider, Map<reason, obs>>` registry with reason-required clearing; claude mixed-window freshness rules; route returns length-4 canonical-order array as sibling key after `counts`.
- **Accept:** [DELIB-B3a] Decision 6 "Pure resolver" + "Route / MCP" bullets in full — incl. static `not-detected` always wins over runtime observations, 95/99/100 boundaries on both windows, stale-does-not-downgrade, seven_day tie-break.
- **Non-goals:** No evidence EMISSION sites (WP-6b); no skill text (WP-7); availability is process-global — no workspace coupling, no WSL probe.
- **Verify:** Fixture-only tests (never spawn `where.exe`/`--version`); `api-identity.test.ts` + observability script test green; `tsc` clean (new top-level module).

## WP-6b — Availability evidence emission + clearing (B3a lifecycle) — grok half EVIDENCE-GATED

- **Files:** `src/main/supervisor/index.ts` (`_deliverAndConfirm` :7922-7929, `recordSendOutcome` :8012, `forceIdleFromHook`); `src/main/supervisor/status-monitor.ts` (:988-1009, cleanup :505); conditionally new `provider-quota-classifier.ts` + `__fixtures__/`; lifecycle/seam tests.
- **Dep:** WP-6a.
- **Do:** Implement [DELIB-B3a] Decision 3's evidence table: agy `auth-banner` noted at the existing positive sign-in site, cleared reason-specifically on a `confirmed` agy outcome. Grok `free-usage-limit`: ONLY if the real exhausted-terminal artifact is recovered — strict `classifyGrokFreeLimit` over `getCurrentScreen()` (never the ring), two-consecutive-poll stability via a distinct `lastProviderQuotaSig` map, screen-gated Stop-hook clearing (verbatim rule in the doc). **If the artifact cannot be recovered: omit the grok classifier, monitor wiring, fixtures, and lifecycle tests entirely — no inert scaffolding — and record grok quota as unsupported.**
- **Accept:** [DELIB-B3a] Decision 6 "Classifier / observation lifecycle" bullets, incl. both Stop-hook cases (screen-still-exhausted → retained; non-exhaustion screen → cleared) and the assertion that generic GroupThink `STALL:` paths mutate nothing.
- **Non-goals:** Never a blanket clear; no new Notification types (red-bar work is a separate memory'd effort); no provider dropped from the array.
- **Verify:** `interactive-prompt-detector.test.ts`, `status-monitor.test.ts`, `agent-supervisor.test.ts` (or current seam-test homes) green; `tsc` clean.

## WP-7 — run-orchestration skill v4→v5 (B5, carries B3a rule text)

- **Files:** `src/shared/constants.ts` (`SUPERVISOR_RUN_ORCHESTRATION_SKILL`); `src/main/supervisor/index.ts` (~:3275 registry row); `scaffold-version-migration.test.ts`.
- **Dep:** WP-4 (preflight field exists), WP-6a (rule text refers to `availableProviders`). Load the `scaffold-content-needs-version-bump` skill before editing.
- **Do:** ORDER IS LOAD-BEARING per [DELIB-A/B/C] WP-B5: (1) hash the pristine v4 body FIRST — re-derive, never trust a handed-in hash; (2) add `SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH`; (3) then edit the body: preflight flow (read defaults → override → confirm → launch), inherit/override semantics, resume-409 note, plus the EXACT availability rule text from [DELIB-B3a] Decision 5 (verbatim blockquote); (4) bump version 4→5 + `previousHashes` entry; (5) migration test proves pristine v4 upgrades silently.
- **Accept:** [DELIB-B3a] Decision 6 "WP-B5 scaffold-contract tests": v5 body contains the rule text; only `unavailable` blocks launch; degraded-eligible-as-fallback; preference-source named in preflight; same-provider pair legal.
- **Non-goals:** Do not hand-edit the live `.lares/supervisor/.claude/skills/run-orchestration/SKILL.md` copy alone; `.agents/` mirror coordinated with the sibling supervisor-scaffold effort, not duplicated.
- **Verify:** `scaffold-version-migration.test.ts` + optimizer-scaffold-registry resolution green; `tsc` clean.

## WP-8 — Writer-capability evidence matrix (A6) — MANUAL, USER-APPROVAL-GATED

- **Files:** output only: `supplements/provider-writer-capability.md` (this plan folder).
- **Dep:** WP-1..WP-7 landed (tests the real surface); **explicit approval from Edward before ANY launch** — up to 16 live token-burning runs (4 shapes × codex/grok/agy + 4 claude controls). NOTE: grok free quota was exhausted account-wide 2026-08-05 — grok runs blocked until reset/upgrade.
- **Do:** Per [DELIB-A/B/C] WP-A6: per run record final-turn completion, actual file/section mutation, stall classification, elapsed-to-deliverable; outcome classes `writes-reliably`/`writes-degraded`/`stalls`/`unavailable` kept separate (unavailable with evidence, never conflated with a writer stall).
- **Accept:** Complete per-provider × per-shape matrix in the plan-local artifact; no `src/` change gates on it.
- **Non-goals:** No product-policy change from findings; no working around an unavailable provider.
- **Verify:** Artifact present with authored provenance; cited by later doc edits.

## WP-Z — Final gate (C sibling sweep)

- **Files:** none (verification only).
- **Dep:** WP-1..WP-7 (WP-8 excluded — manual).
- **Do:** Full sweep per [DELIB-A/B/C] Part C closing bullet: `orchestration-service.test.ts`, `groupthink-v2.test.ts`, `orchestration-binding.test.ts`, scaffold/version suites, `FileViewerPanel`/TopBar renderer suites, all new suites, and `tsc` — not only the named new tests.
- **Accept:** Everything green; no stale expectations left in sibling suites.
- **Non-goals:** No new features.
- **Verify:** Full main + renderer runner output attached to the gate summary.
