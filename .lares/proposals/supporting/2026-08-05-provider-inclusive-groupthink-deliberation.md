---
artifact_id: prop_gt9c52f4
title: Provider-inclusive GroupThink deliberations + workspace provider-steering surface
author_role: worker
authored_at: 2026-08-05T00:00:00-07:00
---

# Plan: Provider-inclusive GroupThink deliberations + workspace provider-steering surface

## Alignment with the sibling effort

Sibling `2026-08-04-multi-provider-supervisors.md` governs **who holds the supervisor lane**; this plan governs **which providers a supervisor pairs inside a GroupThink run** and the **workspace-scoped, visibly-editable knob** that shapes that choice. Invariants: (1) any of `{claude, codex, grok, agy}` may fill **either** slot — inclusion is unconditional, never gated by a runtime writer-ack; (2) writer-slot reliability is settled by **recorded live evidence**, never by product policy that permanently rejects a provider; (3) config is the deterministic control, lesson/memory are optional soft layers; (4) GroupThink provider settings are **namespaced independently** from any future supervisor-lane provider config.

## Preference contract (normative — a *preference*, not allow/deny)

```
effective provider  =  explicit per-run arg  (lead_provider / reviewer_provider)
                    ↳ else workspace GroupThink default  (persisted settings)
                    ↳ else built-in default  (lead=claude, reviewer=codex)
```

A supervisor **can** override the workspace default per run — intentional, hence `default*` naming. All three layers only ever yield a value in `{claude, codex, grok, agy}`. `gemini` is rejected on every **explicit** input path (422/typed reject); historical Gemini rows stay readable but non-resumable.

## Read-recovery vs. write-validation (normative — resolves the sanitize/reject tension)

Two distinct disciplines, never conflated:

- **Read recovery (load path):** a malformed or manually-corrupted settings file is sanitized **per field to that field's default** so a bad disk state can never crash a launch. Silent, lenient — disk is not a trusted, user-intent-bearing input.
- **Write validation (explicit update path):** an HTTP/IPC update carrying an invalid provider (`gemini`, unknown, empty) is **rejected strictly and the prior saved settings are left unchanged** — HTTP 422, IPC rejects with the equivalent typed error. Explicit updates are user intent; a bad one is an error to surface, not a value to quietly rewrite.

---

## Part A — Provider-inclusive deliberation (product code)

### WP-A1 — Canonical TypeScript provider set + MCP parity enforcement

**File:** `src/shared/types.ts` (near `LaunchableAgentProvider`, line 40)

```ts
export const LAUNCHABLE_AGENT_PROVIDERS: readonly LaunchableAgentProvider[] =
  ['claude', 'codex', 'grok', 'agy'] as const;

export function isLaunchableAgentProvider(v: unknown): v is LaunchableAgentProvider {
  return typeof v === 'string' && (LAUNCHABLE_AGENT_PROVIDERS as readonly string[]).includes(v);
}
```

Canonical for TypeScript consumers. `scripts/mcp-tools-orchestration.js` and `launch_agent` enums cannot import a `.ts` array at runtime, so they **remain literal duplicates**; drift is caught by a **parity test** (WP-C) importing the compiled constant and asserting exact **ordered** equality against both JS enums. No single-runtime-source claim.

### WP-A2 — Positive provider validation in the service

**File:** `src/main/orchestration/service.ts` (replaces the gemini-only checks, lines 105-114). Exported so WP-C tests it directly (no private-symbol inspection):

```ts
export function assertGroupthinkProvider(role: 'lead_provider' | 'reviewer_provider', value: string | undefined): void {
  if (value === undefined) return;
  if (value === 'gemini') throw httpErr(422, 'Gemini provider discontinued; use Antigravity (agy). Historical Gemini agents remain readable.');
  if (!isLaunchableAgentProvider(value)) throw httpErr(422, `Unsupported ${role} '${value}'; expected one of ${LAUNCHABLE_AGENT_PROVIDERS.join(', ')}.`);
}
```

Fresh-run branch: call for both slots **before** the WP-B2 default coalesce. Resume branch: keep the gemini "cannot resume" 422 and add WP-A5.

### WP-A3 — Enum the MCP tool params

**File:** `scripts/mcp-tools-orchestration.js` (lines 177-178) — `enum: ['claude','codex','grok','agy']` on both, descriptions naming writer (Lead/Synthesizer) vs. reviewer (Reviewer/peer) responsibility and "omit to inherit the workspace default." No proof-gate/ack text.

### WP-A4 — Reframe catalog defaults (accurate, non-prohibitive)

**File:** `src/main/orchestration/catalog.ts` (lines 15-16) — remove "only claude writes reliably"; describe the writer slot's job (fresh-file Write or native section Edit), state any of `claude|codex|grok|agy`, default `claude`/`codex`. The runner fails **closed** on a non-writing writer (`waitForDeliverable` → `STALL:`, `groupthink-v2.ts:777`), so unreliability is observable and characterized by WP-A6 evidence, not asserted in schema copy.

### WP-A5 — Resume-provider mutation → 409 (never silent)

**File:** `src/main/orchestration/service.ts` (resume branch, beside the planningIntent 409 at line 116)

```ts
if (req.leadProvider && req.leadProvider !== prior.leadProvider)
  throw httpErr(409, 'A resumed orchestration cannot change its lead provider.');
if (req.reviewerProvider && req.reviewerProvider !== prior.reviewerProvider)
  throw httpErr(409, 'A resumed orchestration cannot change its reviewer provider.');
```

Matching values pass. `legacyCommand`-derived providers fold into `req.*` before this check, so they are covered.

### WP-A6 — Writer-slot capability evidence (MANUAL acceptance WP — explicit user approval required before launch)

This WP launches **up to sixteen live, token-consuming deliberations** (4 shapes × 3 non-Claude providers + 4 Claude control runs). It is a **manual acceptance/evidence WP**, not autonomous work: the executing agent MUST obtain **explicit user approval before launching any run**, consistent with the run-orchestration skill's "don't autonomously launch" rule. No `src/` change gates on it.

Four execution shapes per provider (writer prompt/history differs across all four):

| # | Shape | mode | Deliverable |
|---|---|---|---|
| 1 | Serial fresh-file | serial | Write new `plan_path` |
| 2 | Parallel fresh synthesis | parallel | Synthesizer writes new `plan_path` |
| 3 | Serial plan-rail edit | serial + `section_anchor` | native Edit of one section in place |
| 4 | Parallel plan-rail edit | parallel + `section_anchor` | Synthesizer native-Edits one section |

Coverage is **deterministic across all three non-Claude providers** — `codex`, `grok`, `agy` — for all four shapes; **Claude runs once per shape as a control baseline** (confirms the harness, not Claude's reliability). Per run record: **final-turn completion**, **actual file/section mutation**, **stall classification** (which `STALL:` reason), and **elapsed time to deliverable** (distinct from `PLAN_WRITE_GRACE_MS`, a flush tolerance). Outcome classes are kept **separate**: `writes-reliably` / `writes-degraded` / `stalls` / **`unavailable`** — a provider unavailable/authentication failure is recorded as `unavailable` **with evidence**, never conflated with a writer `stall` and never worked around by changing product policy. Deliverable: a per-provider × per-shape matrix in a **plan-local durable artifact** `supporting/provider-writer-capability.md` (authored provenance, not the untrusted `.lares/research/inbox/`). Cited by later doc edits; gates/restricts nothing in code.

---

## Part B — Workspace-scoped, visibly-editable steering surface

### WP-B1 — Namespaced, workspace-scoped settings module (new)

**Files:** `src/shared/types.ts`, `src/shared/constants.ts`, `src/main/orchestration/orchestration-provider-settings.ts` (new)

```ts
export interface OrchestrationProviderSettings {
  groupthink: { defaultLeadProvider: LaunchableAgentProvider; defaultReviewerProvider: LaunchableAgentProvider };
}
export const DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS: OrchestrationProviderSettings = {
  groupthink: { defaultLeadProvider: 'claude', defaultReviewerProvider: 'codex' },
};
```

Store at `path.join(workspaceStateDir(ws.path), 'orchestration-provider-settings.json')` (genuine workspace scope, not `userData`). Cache is a **`Map<workspaceRoot, OrchestrationProviderSettings>`** — structural isolation. Two clearly-separated entry points:

- **`sanitizeOrchestrationProviderSettings(raw)` — READ RECOVERY.** Each field independently falls back to its default via `isLaunchableAgentProvider` (`gemini`/unknown/empty → default). Used only by `load…`. Lenient.
- **`validateOrchestrationProviderSettingsUpdate(raw)` — WRITE VALIDATION.** Throws a typed error on any invalid/`gemini`/empty field; does **not** coerce. Used by every explicit setter (IPC/HTTP) **before** persisting; on throw, the on-disk settings are left untouched.

Plus `load…(workspaceRoot)` (sanitize path), `save…(validated, workspaceRoot)` (atomic temp+rename, callers pass already-validated input), `getOrchestrationProviderSettingsCached(workspaceRoot)`, `updateOrchestrationProviderSettings(next, workspaceRoot)` (validate → save → refresh cache; throws before touching disk on invalid input), `__reset…ForTest()`.

### WP-B2 — Service consumes the workspace default (precedence layer 2)

**File:** `src/main/orchestration/service.ts` (fresh-run branch, lines 156-157)

```ts
const prov = getOrchestrationProviderSettingsCached(ws.path).groupthink;
// assertGroupthinkProvider() on req.* already ran above
leadProvider:     req.leadProvider     || prov.defaultLeadProvider,
reviewerProvider: req.reviewerProvider || prov.defaultReviewerProvider,
```

### WP-B3 — Preflight: effective defaults visible BEFORE spend

`start_run()` persists and launches before returning, so a returned value arrives after agents may run — too late for confirmation. Expose via **read-only preflight**:

- **File:** the `/api/supervisor/context` handler (workspace derived from the authenticated `X-Workspace-Id` header). Add `orchestrationProviderDefaults: { groupthink: { defaultLeadProvider, defaultReviewerProvider } }`, read via `getOrchestrationProviderSettingsCached(ws.path)`.
- **File:** `scripts/mcp-tools-observability.js` — extend `get_my_context`'s description to mention the field (handler already passes the response through).
- **Skill flow (WP-B5):** read defaults via `get_my_context` → construct overrides if any → **confirm the effective pairing with the user** → call `run_orchestration`.
- *(Optional telemetry only)* `start_run` MAY additionally return the resolved pair, labeled telemetry, not confirmation. Default: `{runId}` unchanged.

### WP-B4 — Dedicated "GroupThink Providers" tool tab (the user-facing control)

`ContextWindowWarningPanel` is a dedicated Tools tab, not a general Settings pane; do not overload it. Add a distinct tab:

- **New component:** `src/renderer/components/orchestration/GroupThinkProvidersPanel.tsx` — two `<select>`s (lead / reviewer) from `LAUNCHABLE_AGENT_PROVIDERS`, showing current effective values for the selected workspace, with **Save** and **Reset to defaults**.
- **Dispatch:** in `src/renderer/components/fileviewer/FileViewerPanel.tsx`, add a branch beside `effectiveTab.toolId === 'context-window-warning'` (~line 257): `=== 'groupthink-providers'` → `<GroupThinkProvidersPanel />`.
- **Open trigger:** add the Tools entry opening `toolId: 'groupthink-providers'` in `src/renderer/components/layout/TopBar.tsx`, mirroring the `context-window-warning` trigger and its store action.
- **Transport:** IPC `get_orchestration_provider_settings` / `update_orchestration_provider_settings` in `ipc-handlers.ts` (accept `workspaceId`, resolve `ws.path` main-side; the update handler calls `validateOrchestrationProviderSettingsUpdate` and rejects with a typed error on invalid input, leaving prior settings intact). HTTP route pair derives the workspace **exclusively from the authenticated `X-Workspace-Id` header** — never a trusted body/query id; invalid provider → **422**, prior settings unchanged. Do **not** copy the gauge endpoint's app-global scoping. Add typed preload bridge methods + `OrchestrationProviderSettings` typings.
- **Changed events carry `workspaceId`:** the update broadcast is tagged; renderer subscribers **ignore events for other workspaces**, and a tagged update whose `workspaceId` ≠ the currently-selected workspace can never overwrite the selected panel's state. The panel guards **stale async loads** on workspace switch (capture the request's workspaceId; drop the result if `selectedWorkspaceId` moved — same guard shape as `FileViewerPanel:78`).

### WP-B5 — Skill guidance via the scaffold constant (v4→v5) — hash derived from the pristine pre-edit body

**Files:** `src/shared/constants.ts` (`SUPERVISOR_RUN_ORCHESTRATION_SKILL`), `src/main/supervisor/index.ts`, `src/main/supervisor/scaffold-version-migration.test.ts`

Canonical source is the constant; the `.lares/supervisor/.claude/skills/run-orchestration/SKILL.md` copy is scaffold output — do not hand-edit only the live copy. **Order is load-bearing** (the constant is v5 *after* the edit; hashing it then would record the wrong "previous" hash):

1. **Before editing anything**, independently compute the literal SHA-256 hex of the **exact current v4 body** of `SUPERVISOR_RUN_ORCHESTRATION_SKILL` (hash the constant's current string as it stands on disk now). Record that literal string. **Do not** derive it from the post-edit constant, and **do not** trust any precomputed/handed-in value without re-deriving it yourself from the pristine v4 body.
2. Add `export const SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH = '<the literal hash from step 1>';` in `src/main/supervisor/index.ts`.
3. **Then** edit the canonical constant body: (a) the WP-B3 preflight flow (read defaults → override → confirm → launch); (b) omitted args inherit the workspace default, pass only to override; (c) resume 409s on a provider mismatch (WP-A5). Optional: one prose *example* of a judgment-based override (not policy).
4. Bump the `SUPERVISOR_FILES` entry (`src/main/supervisor/index.ts`, lines 3261-3264) `version: 4 → 5`, add `4: SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH` to `previousHashes`.
5. Extend `scaffold-version-migration.test.ts` to prove a pristine v4 on-disk file (hash === `SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH`) upgrades silently to v5.

The `.agents/` provider-neutral mirror is **coordinated with the sibling's supervisor scaffold work** (cross-effort note), not duplicated here.

### Not a WP — lesson / memory

A "which pairing when" lesson is **optional, user-authored** judgment; seeding an opinionated default is unsupported by evidence and out of scope — surface guidance as **examples in panel helper text / skill prose**. Memory is rejected (workspace *state*, wrong lifecycle for a durable preference).

---

## Part C — Tests

- **MCP parity (WP-A1):** import compiled `LAUNCHABLE_AGENT_PROVIDERS`; assert exact ordered equality against the `run_orchestration` `lead_provider`/`reviewer_provider` enums **and** the `launch_agent` enum.
- **Provider validation (WP-A2):** test the exported `assertGroupthinkProvider` + end-to-end service behavior for every value: all four accepted in either slot incl. **same-provider pairs**; `gemini` → 422; unknown → 422; empty → 422.
- **Settings read recovery vs. write validation (WP-B1):** malformed JSON / corrupted field on **load** → per-field defaults; an **explicit update** with `gemini`/unknown/empty → typed reject **and a proof that the previously-saved pair is preserved unchanged**; valid update round-trips atomically; **per-workspace isolation** (two roots independent; cache Map no cross-leak).
- **Precedence (WP-B2):** explicit > workspace default > built-in — assert persisted `OrchestrationRun` providers in each case.
- **Resume mutation (WP-A5):** mismatch → 409; match passes; gemini prior → 422.
- **Preflight (WP-B3):** `/api/supervisor/context` includes `orchestrationProviderDefaults.groupthink` scoped by `X-Workspace-Id`; **and** exercise the `get_my_context` MCP proxy itself (via the observability tool handler) to prove the field survives the actual supervisor-facing path, not only the raw route.
- **Transport (WP-B4):** HTTP getter/setter derive workspace **only** from `X-Workspace-Id` (reject/ignore body id); invalid update → 422 with prior settings intact; IPC/preload get+update round-trip; invalid IPC update → typed reject, prior settings intact.
- **Renderer (WP-B4):** workspace switch re-loads values; **stale load** dropped when workspace changes mid-fetch; **a workspace-tagged update received *after* switching workspaces cannot overwrite the newly-selected workspace's panel state**; broadcast for another workspace ignored; save/reset behavior; `<select>` options match `LAUNCHABLE_AGENT_PROVIDERS`.
- **Scaffold migration (WP-B5):** pristine v4 file upgrades silently to v5; `optimizer-scaffold-registry` row still resolves.
- **Sibling suites:** run `orchestration-service.test.ts`, `groupthink-v2.test.ts`, `orchestration-binding.test.ts`, the scaffold/version suites, and the `FileViewerPanel`/TopBar renderer suites — not only the new named tests.

## Scope boundaries

No supervisor-lane provider selection (sibling owns it; the `OrchestrationProviderSettings` namespace leaves room without implying GroupThink defaults configure the supervisor lane). No per-mode default granularity. No runtime writer-ack / `allow_unproven_writer` — inclusion is unconditional; writer reliability is evidence (WP-A6), not policy. `start_run`'s `{runId}` contract unchanged.


<!-- groupthink_run: 27d25aa3 (mode=serial) -->
