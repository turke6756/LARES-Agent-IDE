# Planning-surface Implementation Plan

**Status:** executable implementation plan — GroupThink deliberation, Lead Planner ×
Reviewer, Reviewer-approved 2026-07-30. Hardens the approved planning-surface revamp
(`.lares/proposals/2026-07-30-planning-surface-revamp.md`, **Amendments authoritative**)
into worker-sized work packages. Consumes the normative bundle contract v1
(`.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`) unchanged, and is
**strictly downstream of** the Save-card implementation plan
(`.lares/proposals/supporting/2026-07-30-save-card-implementation-plan.md`) for every
stamping / finalization / candidate / coordinator capability — those WPs are referenced by
their canonical `SC-WP-<id>` names and are never re-specified here.

Grounding sources: the two-proposal cross-evaluation
(`.lares/proposals/supporting/2026-07-30-two-proposal-cross-evaluation-groupthink.md`,
§4.5 evidence surfaces, §6 demand probe, §7 stages) and the plan-surface revival technical
strategy (`.lares/proposals/supporting/2026-07-30-plan-surface-revival-technical-strategy.md`,
superseded where the Amendments conflict — notably: **promotion mints structured DB rows +
links source documents, never a new HTML plan file**).

**Anchor policy:** symbolic anchors (file / function / table / constant names) are
authoritative; line numbers are orientation only — this repo is actively edited and numeric
anchors drift.

**Per-WP shape:** every worker package lists **Files · Dep · Do · Accept · Non-goals ·
Verify** and fits one worker context. Verify templates follow Save-card §0.1:

```powershell
# Main/shared single test
npm run build:main
node dist/main/<compiled-test-path>.js

# Renderer single test
npx vitest run --config vitest.config.ts <renderer-test-file>

# Full main suite
npm run test:supervisor
```

Every new main/shared test must be registered in `scripts/run-main-tests.mjs` or
`npm run test:supervisor` silently omits it; each stage ends with an integration gate that
owns that edit so parallel WPs never contend on the registry.

---

## A. Cross-plan barriers & shared substrate

### A1 — Save-card integration barrier (canonical names)

No planning branch starts before its listed Save-card WPs merge:

- **Contract types (all planning WPs):** `SC-WP-0A`.
- **Stamped evidence / dispatch default / evidence surfaces:** `SC-WP-2A`, `SC-WP-2B`,
  `SC-WP-2C`, `SC-WP-2D`, `SC-WP-2E`, `SC-WP-2F`; attribution `SC-WP-2I`.
- **Work packages + item validation (Stages P5, P6 — requires SC Stage ③):** `SC-WP-3A`.
- **Done / finalization (P6D):** `SC-WP-3B`, `SC-WP-3C`, `SC-WP-3D`.
- **Candidate / preview (P7A):** `SC-WP-1G`, `SC-WP-3G`, `SC-WP-3H`, `SC-WP-3I`.
- **Commit-package (P6D — requires SC Stage ④):** `SC-WP-4E`, `SC-WP-4F`, `SC-WP-4L`.
- **Blame exact half (P7C):** `SC-WP-2G`.

**Consequence:** the execution tier (P5–P7) cannot begin before Save-card **Stage ③**;
P6D + P7A also need Save-card **Stage ④**.

### A2 — Global DDL serialization barrier (both plans)

Every `database.ts` migration — across both plans — is serialized against every other. The
serialized set spans Save-card **`SC-WP-2A`, `SC-WP-2D` (binding cols), `SC-WP-2F` (binding
cols), `SC-WP-2G`, `SC-WP-3A`, `SC-WP-3B`, `SC-WP-4C`** and planning **P2A, P3A, P4D-reply,
P5A-schema, P5A-paths, P5B, P5C, P5-dispatch, P8F**. Each DDL WP rebases onto the current
`initDatabase()` head and adds only guarded `ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`; two
DDL WPs never land concurrently. This is a first-class graph node, not "serialized within a
stage."

**Exception:** WP-P8F is the single deliberate terminal exception to the "guarded
`ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` only" rule — it performs readiness-gated
`DROP TABLE IF EXISTS` under a repeatable migration marker, and is still serialized in the
A2 order.

### A3 — Demand-probe metric definition

Substrate = **WP-P0PRE**. Variables **N / M / K are TBD parameters** (Edward sets thresholds).
Metrics:

- **Proposal capture (N):** count(`proposal_authored`), voluntary-eligible only.
- **Human browsing (M):** count(`reader_open` **or** `savecard_open`), voluntary-eligible only.
- **Promotion demand (K):** count(`promotion_requested`), voluntary-eligible only — the gate.

**Voluntary is decided at aggregation time by an auditable rule, not from transport:**
`source` is a factual origin tag; eligibility excludes `source='test-harness'` and any event
carrying the explicit `feature_exercise=true` tag, with a `manual_class` override column. A
documented aggregation query reproduces the three counts. The server never claims to infer
user intent from transport alone.

### WP-SEP — shared stamped-evidence projection (branch-independent)

- **Files:** new `src/main/plans/stamped-evidence-projection.ts` (+`stamped-evidence-projection.test.ts`).
- **Dep:** `SC-WP-2A`, `SC-WP-2B`, `SC-WP-2C`, `SC-WP-2D`, `SC-WP-2E`, `SC-WP-2F`, `SC-WP-2I`,
  existing `src/main/git-checkpoints/retention.ts`. **Not gated on K** — builds after Save-card
  Stage ②, so both the board (P6A) and the fallback (WP-FB) can consume it.
- **Do:** expose two pure projections over immutable plan-stamped `turn_records`: **live
  activity** (open plan-stamped turns + witnessed `touched[]` → `isActive`, never completion)
  and **durable trail** (accepted turns; `diff_stats` / `compact_diff` read from `retention.ts`'s
  existing backfill — **not `SC-WP-2K`**, which is pin accounting; restore/revert from
  `recovery_operations`). Annotate unstamped/unverified turns via `plan_stamp_source`. No
  completion inference anywhere.
- **Accept:** live activity from open turns; durable trail from accepted + distilled fields;
  unstamped annotated; consumable with zero board/registry dependency (imports nothing gated).
- **Non-goals:** no card DTO; no UI; no finalization reads.
- **Verify:** main/shared template.

---

## STAGE P0 — proposal capture + ceremony subtraction + probe substrate

**Stage non-goals:** no registry/watcher/gallery/DB schema; no `create_plan`/legacy HTML; no
mission board; promotion is not yet available.
**Stage user-visible acceptance:** supervisors author proposal mds with zero ceremony;
hardening produces linked markdown (not HTML/plan rows); legacy HTML still serializes; the
structured path is exempt from the one-writer lock. **Capture metric (N)** begins accruing
from voluntary-eligible `proposal_authored` events.

### WP-P0PRE — demand-probe append service
- **Files:** new `src/main/telemetry/demand-probe.ts`; IPC `demand-probe:record` in
  `src/main/ipc-handlers.ts`; agent tool `record_planning_event(kind)` (kinds
  `proposal_authored` | `promotion_requested`); `.gitignore` block for `.lares/usage/`; test
  `demand-probe.test.ts`.
- **Dep:** none.
- **Do:** atomic single-line JSONL append to `.lares/usage/demand-probe.jsonl` (resolved via
  `workspaceStateDir()`, `.dashboard` fallback), event
  `{eventId, ts, workspace_id, kind, source, feature_exercise, manual_class?}` with size/rotation
  cap. `source` is a **factual origin tag** (`renderer-user-action` | `agent-tool` |
  `test-harness`) derived from the call path; `feature_exercise` is an explicit tag any
  exercising/test path sets. **Voluntary eligibility is NOT asserted here** — it is computed at
  aggregation time (A3). Verify `.lares/usage/` is git-ignored (add a documenting block if absent).
- **Accept:** atomic non-duplicating appends (retry idempotent by `eventId`); rotation honored;
  `.lares/usage/` confirmed ignored; the writer never sets a "voluntary" boolean; an aggregation
  query reproduces the three metrics with the documented exclusions.
- **Non-goals:** no aggregation UI; no intent inference.
- **Verify:** main/shared template.

### WP-P0A — proposal-to-plan skill + driving-role instruction drafts (content)
- **Files:** drafts under `.lares/proposals/supporting/scaffold-drafts/`:
  `proposal-to-plan.SKILL.md`, `supervisor-agent-md.delta.md`, `worker-claude-md.delta.md`,
  `manual-install.md`.
- **Dep:** WP-P0PRE (uses `record_planning_event`).
- **Do:** the skill teaches the supervisor **driving role** (R2.7): recognize proposal-shaped
  discussion → write `.lares/proposals/<date>-<slug>.md` with portable `artifact_id` frontmatter
  (the skill creates the dir with its own fs tools when absent). **The proposal is the terminal
  artifact**; **hardening output stays as linked markdown documents** (groupthink md under
  `.lares/proposals/supporting/`, research under `.lares/research/cleared/`) — never routed into
  the legacy HTML plan rail, never `create_plan`. The supervisor may **record a promotion request**
  via `record_planning_event('promotion_requested')` and states plainly that structured promotion
  becomes available only after it ships. Worker delta: may author proposals (`author_role: worker`)
  and drops the every-turn `PLAN-EVENT` sentinel + read-before-edit-for-progress obligations.
  `manual-install.md` documents the dogfood hand-install so the capture metric can start before P0C.
- **Accept:** in a fresh workspace a supervisor unprompted authors a proposal md; a
  `proposal_authored` event lands; no `create_plan`; hardening yields linked mds; no `plans` row created.
- **Non-goals:** no `constants.ts` edit (P0C); no promotion execution; no code.
- **Verify:** peer read; markdown lint; dry-run manual install in a scratch workspace.

### WP-P0B — ceremony prompt-contract removal + trusted format-gate
- **Files:** `src/main/plans/plan-rail-contract.ts` (`planRailContractBlock`,
  `planClaimConventionBlock`, `PLAN_EVENT_STATUSES`); `src/main/plans/read-ladder.ts`
  (`EDIT_DISCIPLINE`); `src/main/orchestration/groupthink-v2-prompts.ts` (sentinel/edit-discipline
  injection); `src/main/orchestration/plan-ownership.ts` (`assertPlanRailFree`, called from
  `api-server.ts`, `ipc-handlers.ts`, `orchestration/service.ts`); tests
  `plan-rail-contract.sync.test.ts`, `read-ladder.test.ts`, `section-reader.test.ts`,
  `plan-ownership.scope.test.ts`.
- **Dep:** none.
- **Do:** strip the mandatory every-turn-sentinel + read-before-edit language from all three
  prompt sources **including `EDIT_DISCIPLINE`**, while **preserving the `raw+editWindow` mode +
  byte-exact edit-window response**. Retain fail-open `scrapePlanEventSentinel` + the
  `plan_events`/touch columns (deletion waits for P8E — no server rejection exists today).
  `assertPlanRailFree` **loads the plan by ID and returns early unless the trusted
  `plan.format === 'html'`** — it never accepts a caller-supplied format.
- **Accept:** no prompt/injection/`EDIT_DISCIPLINE` obligates a per-turn sentinel or
  read-before-edit; `raw+editWindow` still returns the byte-exact window for legacy HTML.
  Format-gate matrix: `html` → guarded, `structured` → bypass, `md` → bypass, unknown/missing plan
  id → safe no-crash bypass; all three call sites covered. Concurrent legacy-HTML **plan-bound
  dispatch/orchestration rails** still 409; the guard does **not** serialize arbitrary external
  filesystem edits.
- **Non-goals:** no parser/column deletion (P8E); no lock removal (P8B).
- **Verify:** main/shared template; sibling `plan-rail-contract.sync.test.ts` green.

### WP-P0C — scaffold deploy via version-bumped constants
- **Files:** `src/shared/constants.ts`; `src/main/supervisor/index.ts` (manifests
  `SUPERVISOR_FILES`, `WORKER_FILES_CLAUDE`, `SUPERVISOR_FILES_CODEX` + codex worker map);
  `src/main/supervisor/scaffold-version-migration.test.ts`; `src/main/supervisor/worker-scaffold.test.ts`.
- **Dep:** WP-P0A (content), WP-P0B (worker-md ceremony text must match the retired injection).
- **Do:** freeze the **current** live `SUPERVISOR_AGENT_MD` / `WORKER_CLAUDE_MD` bodies byte-exact
  and register their hashes as `previousHashes[19]` / `previousHashes[8]`; author the **new live
  bodies `SUPERVISOR_AGENT_MD_V20` / `WORKER_CLAUDE_MD_V9`**; bump the scaffold-map `version` in
  `supervisor/index.ts`; add net-new skill-root entries `.claude/skills/proposal-to-plan/SKILL.md`
  (into `SUPERVISOR_FILES` + `WORKER_FILES_CLAUDE`) and `.agents/skills/proposal-to-plan/SKILL.md`
  (into `SUPERVISOR_FILES_CODEX` + codex worker map). Follow the `scaffold-content-needs-version-bump`
  discipline (freeze-then-derive; add migration tests).
- **Accept:** migration tests green; deployment = rebuild + relaunch + next agent launch; **verified
  on a Claude lane specifically** (Codex regenerates CODEX_HOME unconditionally every launch and
  would false-positive).
- **Non-goals:** no behavior beyond deployment.
- **Verify:** `npm run build`; scaffold-migration + worker-scaffold suites.

**Integration gate P0Z:** register WP-P0PRE/P0B main tests in `scripts/run-main-tests.mjs`;
`npm run build:main && npm run test:supervisor`; renderer + scaffold suites green.

**Stage P0 graph:** `WP-P0PRE → {WP-P0A ∥ WP-P0B} → WP-P0C → P0Z`.

---

## STAGE P1 — tiny filesystem proposal reader (PRE-GATE; Save-card-independent)

**Stage non-goals:** no `proposals` table, watcher, DB mutation, frontmatter rewriting, gallery,
or promotion. Read-only filesystem enumeration only.
**Stage user-visible acceptance:** proposals browsable in a read-only reader; **browsing (M)** =
voluntary-eligible `reader_open` + `savecard_open`; **promotion demand (K)** accrues from
voluntary-eligible `promotion_requested`. No durable machinery. Initial render/refresh does not
count as an open.

### WP-P1A — bounded enumeration + safe read IPC
- **Files:** new `src/main/plans/proposal-reader.ts`; IPC `proposal-reader:list` / `proposal-reader:read`
  in `src/main/plans/plan-ipc.ts`; `src/shared/types.ts`; test `proposal-reader.test.ts`.
- **Dep:** WP-P0PRE.
- **Do:** enumerate `<workspaceStateDir()>/.lares/proposals/*.md` (bounded count + byte cap; honor
  `.dashboard` fallback via `translateStateRelPath`); parse frontmatter read-only (title/authored_at
  display; never rewrite); `proposal-reader:read` returns the body with path-containment validation +
  byte cap (no raw absolute path leaves main); emit `reader_open` **only on a user gesture** (not
  initial mount); no DB touch.
- **Accept:** lists proposal mds date/title-sorted; safe read enforces containment + cap; absent dir →
  empty state; no write anywhere; initial mount emits no `reader_open`.
- **Non-goals:** no registry/watcher/promotion.
- **Verify:** main/shared template.

### WP-P1B — reader renderer pane
- **Files:** new `src/renderer/components/plan/ProposalReaderPane.tsx` + read-only `ProposalReader.tsx`;
  Plans toolbar entry; `src/preload/index.ts`; tests `ProposalReaderPane.test.tsx`, `ProposalReader.test.tsx`.
- **Dep:** WP-P1A.
- **Do:** split-screen list + read-only markdown pane; date/title grouping; voluntary opens
  instrumented on user gesture.
- **Accept:** click-to-read works; empty/non-repo renders; read-only; no open on mount/refresh.
- **Non-goals:** no promote button; no editing.
- **Verify:** renderer Vitest template.

### WP-P1C — promotion-request capture (demand-metric source)
- **Files:** Request-Promotion affordance in `proposal-reader.ts` / `ProposalReaderPane.tsx` →
  `record_planning_event('promotion_requested')`; test `promotion-request.test.ts`.
- **Dep:** WP-P1A, WP-P1B, WP-P0PRE.
- **Do:** a human-gesture Request-Promotion affordance (and the supervisor skill offer path) logs one
  **voluntary-eligible** `promotion_requested` — the K source, existing before promotion is buildable
  so demand is measured on intent, not on a shipped feature.
- **Accept:** a request logs exactly one voluntary-eligible event; no plan/registry created (promotion
  does not exist yet).
- **Non-goals:** no promotion execution.
- **Verify:** main/shared + renderer templates.

### WP-P1S — Save-card open instrumentation
- **Files:** hook in `src/renderer/components/save/SaveCard.tsx` emitting `savecard_open` via
  `demand-probe:record`; test `SaveCard.demandProbe.test.tsx`.
- **Dep:** `SC-WP-1I` (SaveCard.tsx must exist), WP-P0PRE.
- **Do:** emit `savecard_open` **only on a user gesture** opening the Save card — not on initial
  render/refresh — so browsing (M) includes Save-card opens.
- **Accept:** a user opening the Save card logs one voluntary-eligible `savecard_open`; mount/refresh
  logs none.
- **Non-goals:** no Save-card behavior change.
- **Verify:** renderer Vitest template.

**Integration gate P1Z:** register P1A/P1C main tests; `npm run test:supervisor`; P1B/P1C/P1S renderer
Vitest; `npm run build`.

**Stage P1 graph:** `WP-P0PRE → WP-P1A → WP-P1B → WP-P1C → P1Z`; `SC-WP-1I + WP-P0PRE → WP-P1S`.

---

## ★ PROMOTION-DEMAND GATE (K parameter; Edward sets) ★

Proceed to P2+ **only** when promotion demand reaches K over the probe window (several weeks, not one).
One quiet week does not kill the feature; Edward may grant **one explicit extension**. **If K is never
reached:** ship **WP-FB**, keep the tiny reader, fold conservative execution evidence into the existing
AttributionPanel, and build **no** registry/watcher/gallery/promotion/mission-board.

---

## STAGE P2 — durable registry + watcher + gallery (post-gate)

**Stage non-goals:** no promotion/responsibility/dispatch/mission-board; structured plans never enter
HTML/projection/pane paths.
**Stage user-visible acceptance:** the durable registry lists proposals + structured plans + **legacy
HTML plans as "Legacy Plan" rows** (opened via the current legacy surface until P8); existing
`format='md'` rows stay hidden historical records (never shown/duplicated); witnessed authors correct.
**Gate check:** registry membership audited against the raw `.lares/proposals/` filesystem listing.

### WP-P2A — schema: proposals table + plans columns + md-row policy ⟨DDL⟩
- **Files:** `src/main/database.ts`; tests `database.proposals.test.ts`, `md-row-adoption.test.ts`.
- **Dep:** A2.
- **Do:** create `proposals` (`id, artifact_id, workspace_id, path, slug, title,
  state[proposal|promoted|archived], author_agent_id, author_role[supervisor|worker|unknown],
  author_display, authored_at, created_at, updated_at, mtime_ms, size_bytes, promoted_to_plan_id,
  deleted_at, UNIQUE(workspace_id, path)`) + partial unique indexes `(workspace_id, artifact_id)` and
  `(promoted_to_plan_id)`. **Four** guarded `ALTER plans ADD COLUMN`: `artifact_id`, `source_proposal_id`,
  `promoted_at`, `promoted_content_hash` (**`responsible_supervisor_id` is NOT here — added in P3A with
  its inline FK**). Partial unique indexes on `plans(workspace_id, artifact_id)` and
  `plans(source_proposal_id)`. **md-row policy:** only markdown under the resolved `.lares/proposals/`
  dir is proposal-shaped; existing `plans(format='md')` rows are **hidden, preserved historical md
  records** (never shown as plans, never duplicated into `proposals`) + a diagnostic inventory-count
  accessor.
- **Accept:** tables/indexes idempotent; **only four** plan ALTERs; md-row test — an `md` row whose path
  later appears in the reader/watcher registers once as a `proposals` row, the `md` row stays hidden, no dup.
- **Non-goals:** no watcher logic; no `responsible_supervisor_id`.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-P2B — proposals-watcher (witnessed attribution, adopt/mint, policies)
- **Files:** new `src/main/proposals-watcher.ts`; accessors in `database.ts`; test `proposals-watcher.test.ts`.
- **Dep:** WP-P2A.
- **Do:** own `.lares/proposals/` only (its events **never reach `reparsePlanFile`**); **ensure the
  resolved `.lares/proposals/` dir on subscription initialization** (works without a supervisor launch).
  Witnessed-first attribution via `file_activities` (never one-agent-per-cwd; no witnessed write ⇒
  `author_role='unknown'`; date grouping uses DB `created_at`). Frontmatter `artifact_id`: **adopt** when
  present; **mint + safely insert** into otherwise-valid frontmatter when absent (idempotent). NORMATIVE
  policies: duplicate `artifact_id` within one workspace → leave the duplicate unregistered + surface a
  both-paths diagnostic, never rebind the canonical row; malformed YAML → report/quarantine, never rewrite.
- **Accept:** dir ensured on init; agent/hand-authored register with correct witnessed author (or
  `unknown`) + stable `created_at`; missing-id inserted; duplicate/malformed handled per policy.
- **Non-goals:** no gallery UI; no promotion.
- **Verify:** main/shared template.

### WP-P2C — unified gallery projection + read IPC
- **Files:** new `src/main/plans/plan-gallery.ts`; IPC `plan-gallery:list` / `proposal:read` in
  `plan-ipc.ts`; `src/shared/types.ts`; test `plan-gallery.test.ts`.
- **Dep:** WP-P2A (+ WP-P2B for data).
- **Do:** single server projection unioning **proposals + `format='structured'` plans + `format='html'`
  plans labeled "Legacy Plan"** (opened via the current legacy surface until P8); **exclude `format='md'`**.
  Structured readers use `plan_documents`, never `plans.path`. Date-grouped rows (author chip + role icon,
  type badge, state chip); default filter hides `archived` + `promoted`. `proposal:read` enforces
  workspace/path-containment validation + a byte cap.
- **Accept:** the three row types render; `md` excluded; legacy HTML rows present + labeled; containment
  enforced; exclusion of structured rows from HTML paths asserted by WP-P2C-compat.
- **Non-goals:** no promote channel (P3); no free-text search/multi-facet (deferred).
- **Verify:** main/shared template.

### WP-P2C-compat — structured-format guards at the real call sites
- **Files:** `src/main/plans/watch-plans.ts` (`reparsePlanFile` / `getServedPlanProjection`),
  `src/main/plans/plan-pane-manager.ts` (`PlanPaneManager`), `src/main/plans/plan-ipc.ts` (`plan:projection`),
  `src/main/api-server.ts` (plan-projection routes); test `structured-exclusion.test.ts`.
- **Dep:** WP-P2A.
- **Do:** add `format === 'html'` guards so a `format='structured'` plan is mechanically excluded from
  `reparsePlanFile`, `getServedPlanProjection`/`resolvePlanProjection`, `PlanPaneManager.show`, and the
  HTML plan-projection routes (each returns a structured-not-applicable outcome, no crash).
- **Accept:** a structured row cannot enter any HTML/projection/pane path (asserted per site); legacy HTML unaffected.
- **Non-goals:** no gallery logic; no deletion.
- **Verify:** main/shared template; sibling watcher/pane suites.

### WP-P2D — gallery pane + Promote button
- **Files:** new `src/renderer/components/plan/PlanGalleryPane.tsx`; reuse `ProposalReader.tsx`;
  `src/preload/index.ts`; test `PlanGalleryPane.test.tsx`.
- **Dep:** WP-P2C, WP-P1B.
- **Do:** date-grouped list (author/type/state chips), read pane, archived/promoted toggle, **Legacy Plan
  open path** (legacy surface), Promote button (proposals only; behavior in P3C). Supersedes the tiny
  reader pane.
- **Accept:** three row types render; click-to-read; legacy plans open via legacy surface; `md` absent;
  Promote present (behavior in P3C).
- **Non-goals:** promotion logic.
- **Verify:** renderer Vitest template.

**Integration gate P2Z:** register P2A/P2B/P2C/P2C-compat main tests; suites + renderer + build green.

**Stage P2 graph:** `A2 → WP-P2A → {WP-P2B ∥ WP-P2C ∥ WP-P2C-compat} → WP-P2D → P2Z`.

---

## STAGE P3 — promotion service: structured rows, no HTML

**Stage non-goals:** **no HTML file minted** (Amendment 1); no mission board; no dispatch onto the plan
(Implement is P5); no bulk-mutation of `agents.plan_id`.
**Stage user-visible acceptance:** promotion mints structured rows + narrowly-linked docs transactionally
and idempotently with no HTML; source md persists as `promoted`; the plan shows `hardening`; a responsible
supervisor is recorded.

### WP-P3A — responsibility + document-link + tab-overview schema ⟨DDL⟩
- **Files:** `database.ts`; test `database.responsibility.test.ts`.
- **Dep:** A2, WP-P2A.
- **Do:** add `plans.responsible_supervisor_id TEXT REFERENCES agents(id) ON DELETE SET NULL` (**inline FK,
  here only**); `supervisor_active_plan(supervisor_id PK REFERENCES agents(id) ON DELETE CASCADE, plan_id
  TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, activated_at)`; `plan_documents(id, plan_id,
  workspace_id, doc_kind[proposal|deliberation|research|legacy-html], rel_path, artifact_ref, tab, sort_order,
  created_at)` (workspace-relative paths, no body column); `plan_tab_overviews(plan_id, tab, body, revision,
  updated_by, created_at, updated_at, PK(plan_id, tab))`. `supervisor_focus` keeps its existing cascade.
- **Accept:** FK behaviors verified (supervisor delete → responsibility nulled, active-plan + focus cascaded);
  overview round-trips with revision; doc rows store rel paths only.
- **Non-goals:** no promotion/overview content.
- **Verify:** main/shared template.

### WP-P3B — promote-proposal.ts structured-promotion service
- **Files:** new `src/main/plans/promote-proposal.ts` (+`promote-proposal.test.ts`); scoped lift of
  `rejectMarkdownMigration` inside the service only.
- **Dep:** WP-P3A.
- **Do:** `promoteProposal({ proposalId, supervisorId, selectedDocRelPaths })` — one SQLite transaction, **no
  filesystem write**: (1) load + validate the proposal; **revalidate source containment + recompute
  `promoted_content_hash` (SHA-256) immediately before the txn**; (2) **no `idempotencyKey` — `proposal_id` +
  the one-to-one unique constraints ARE the idempotency key** (re-check `promoted_to_plan_id`; return existing
  on hit); **retry with a different supervisor/doc set → rejected `already-promoted`** (the first promotion is
  authoritative; changing responsibility/docs is a post-promotion edit, not a re-promote); (3) insert a
  **structured** `plans` row: `format='structured'`, `run_state='hardening'`, `path` = source proposal
  workspace-relative path, `mtime_ms` / `size_bytes` = source snapshot at promote (satisfy NOT NULL), +
  `artifact_id`, `source_proposal_id`, `promoted_at`, `promoted_content_hash`, `responsible_supervisor_id`;
  (4) insert `plan_documents` linking **only** the selected proposal + validated-frontmatter artifact/path refs
  + explicitly dialog-selected docs (rel-paths, containment-checked); (5) set `supervisor_active_plan` + an
  ordinary `supervisor_focus` row; (6) update `proposals.promoted_to_plan_id` + `state='promoted'`. Because no
  file is written, the operation is a single DB transaction — no rename/compensation/watcher-suppression steps.
- **Accept:** a structured `hardening` plan is minted with a responsible supervisor + active-plan + focus; **no
  HTML file**; source md persists as `promoted`; re-promote returns the existing plan / rejects a changed
  selection; canceled/absent supervisor → nothing minted; missing source at promote time → clean error, no
  partial state; proposal edited after promotion → `promoted_content_hash` unchanged; only selected/referenced
  docs linked; rel-paths only.
- **Non-goals:** no md→HTML; no seeded zones; no broad co-located discovery.
- **Verify:** main/shared template; the technical-strategy §12 promotion-matrix rows that still apply.

### WP-P3C-cand — link-candidate service
- **Files:** new `src/main/plans/link-candidates.ts`; IPC `proposal:linkCandidates`; test `link-candidates.test.ts`.
- **Dep:** WP-P3A.
- **Do:** return **only** validated explicit frontmatter refs + **bounded files under
  `.lares/proposals/supporting/` and `.lares/research/cleared/`** (containment + count/byte caps) — **no
  workspace-wide crawl, no other roots.**
- **Accept:** candidate roots pinned to those two dirs + frontmatter refs; nothing outside; caps enforced.
- **Non-goals:** no broad discovery.
- **Verify:** main/shared template.

### WP-P3C — promote IPC + PromoteDialog supervisor picker
- **Files:** `plan-ipc.ts` (`proposal:promote`); new `src/renderer/components/plan/PromoteDialog.tsx`; Promote
  wiring in `PlanGalleryPane.tsx`; `src/preload/index.ts`; tests `PromoteDialog.test.tsx`, `proposal-promote-ipc.test.ts`.
- **Dep:** WP-P3B, WP-P3C-cand, WP-P2D.
- **Do:** the Promote button (proposals only) opens the picker **first**; the doc-selection checklist is fed by
  `proposal:linkCandidates`; supervisor choices filtered via `hasSupervisorPrivilege(agent)` + same-workspace
  membership (server-revalidated); on confirm → `proposal:promote`.
- **Accept:** only privileged same-workspace supervisors listed; only checklist docs linked; cancel mints
  nothing; non-supervisor rejected server-side.
- **Non-goals:** no auto-dispatch on promote (Implement is P5).
- **Verify:** renderer + main templates.

**Integration gate P3Z.**

**Stage P3 graph:** `WP-P2A → WP-P3A → {WP-P3B, WP-P3C-cand} → WP-P3C → P3Z`.

---

## STAGE P4 — tabbed plan page: document home + overviews + comments

**Stage non-goals:** no live mission board (P5/P6); no editing the underlying markdowns from this pane
(comments only); no HTML plan rendering path.
**Stage user-visible acceptance:** a promoted plan opens as a **tabbed** document home; each populated tab
leads with a plain-language overview (or "overview pending"); comments can be left and answered on the plan
at any stage (pre-trigger, mid-execution, archived) and reach the responsible supervisor. **Gate check:**
Edward's scattered-md pain resolved (all artifacts in one place); a resumed agent orients from **one bounded
context read**.

### WP-P4A — plan documents + tab-model projection IPC (with plan-document reader guard)
- **Files:** new `src/main/plans/plan-documents.ts`; IPC `plan:documents` in `plan-ipc.ts`; test `plan-documents.test.ts`.
- **Dep:** WP-P3A, WP-P3B.
- **Do:** for a `plan_id`, return the tab model (Overview / Proposal / Deliberation / Research / Packages /
  legacy-html) from `plan_documents`. The **body fetch is its own guard**: it **loads the registered
  `plan_documents` row server-side, resolves its workspace-relative path, enforces workspace containment + the
  allowed document roots (`.lares/proposals/…`, `.lares/proposals/supporting/`, `.lares/research/cleared/`,
  `.lares/plans/legacy/`), rejects any unregistered renderer-supplied path, and applies the byte cap** — the
  proposal-reader/P2C guard is insufficient for supporting/research/legacy paths. The Packages tab returns
  "not yet implemented — pull Implement to begin" until P5/P6.
- **Accept:** tab model returned per plan; only registered `plan_documents` paths are readable; an unregistered
  renderer path is rejected; containment + roots + byte cap enforced for supporting/research/legacy docs;
  missing docs degrade gracefully.
- **Non-goals:** no overview content; no board.
- **Verify:** main/shared template.

### WP-P4C-backend — per-tab overview accessors + IPC
- **Files:** `plan_tab_overviews` accessors in `database.ts`; IPC `plan:getOverview` / `plan:setOverview`
  (supervisor-privileged) in `plan-ipc.ts`; test `plan-overview.test.ts`.
- **Dep:** WP-P3A, WP-P4A.
- **Do:** stored, **supervisor-authored** overviews per tab, revisioned; read + write (write via
  `hasSupervisorPrivilege`).
- **Accept:** get/set round-trips; revision bumps; write privileged.
- **Non-goals:** no editor UI; no renderer.
- **Verify:** main/shared template.

### WP-P4B — tabbed PlanSurface renderer (document home)
- **Files:** `src/renderer/components/plan/PlanSurfaceContainer.tsx` + `PlanSurfaceView.tsx`; reuse
  `ProposalReader.tsx`; `src/preload/index.ts`; test `PlanSurfaceView.tabs.test.tsx`.
- **Dep:** WP-P4A, **WP-P4C-backend** (overview fetch — not the editor; no cycle).
- **Do:** render the document home as **tabs, never one giant scroll** (Amendment 1b): Overview / Proposal /
  Deliberation / Research / Packages / legacy-html. Each tab leads with its plain-language overview then the
  full document(s); a populated tab with no overview shows **"overview pending"**; default tab = Overview.
- **Accept:** tabs switch; overview-then-doc layout; "overview pending" shows when absent on a populated tab;
  no endless scroll.
- **Non-goals:** no overview editing (P4C-editor); no comments (P4E).
- **Verify:** renderer Vitest template.

### WP-P4C-editor — per-tab overview editor
- **Files:** overview editor in `PlanSurfaceView.tsx`; test.
- **Dep:** WP-P4B, WP-P4C-backend.
- **Do:** in-place per-tab overview editor (privileged) calling `plan:setOverview`; **Mark Ready (P5B) requires
  an overview for every populated tab.**
- **Accept:** a supervisor writes/edits an overview per tab; it renders above the docs.
- **Non-goals:** no auto-generation; no worker write.
- **Verify:** renderer Vitest template.

### WP-P4D-create — plan-comment create + routing service
- **Files:** new `src/main/plans/plan-comments.ts` (create service); IPC `plan:comment:create`; reuse
  `createSelectionComment` + the existing send/notification path (`comments:send` in `ipc-handlers.ts`); test
  `plan-comment-create.test.ts`.
- **Dep:** WP-P3B (plan + docs).
- **Do:** server-side create: **validate the target document belongs to the plan** (`plan_documents`), create
  the `selection_comments` row, **select the current `responsible_supervisor_id` server-side, set
  `sent_to_agent_id`**, invoke the existing send/notification path. **The renderer supplies neither recipient
  nor arbitrary file** — only `plan_id` + a document ref + body.
- **Accept:** create validates plan membership; recipient = current responsible supervisor; notification fired;
  renderer cannot inject recipient/file.
- **Non-goals:** no reply storage (P4D-reply); no listing (P4D-proj).
- **Verify:** main/shared template.

### WP-P4D-reply — companion replies table + answer tool ⟨DDL⟩
- **Files:** `database.ts` `selection_comment_replies(id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES
  selection_comments(id), body TEXT NOT NULL, author_agent_id TEXT, created_at INTEGER NOT NULL)` (A2 DDL slot);
  answer service in `plan-comments.ts`; **agent-callable MCP tool `answer_plan_comment(comment_id, body)`**
  validating the caller is the plan's responsible supervisor; test `plan-comment-reply.test.ts`.
- **Dep:** A2, WP-P4D-create.
- **Do:** the tool writes a **companion reply row** — **never** overwrites `selection_comments.body`, **never**
  overloads its existing delivery-status `status` machine; validates the answering agent is the responsible supervisor.
- **Accept:** a reply persists in the companion table with author + time; the question row is untouched; a
  non-responsible caller is rejected.
- **Non-goals:** no additive answer fields on `selection_comments`; no resolution workflow beyond thread display.
- **Verify:** main/shared template.

### WP-P4D-proj — plan-comment projection
- **Files:** `plan-comments.ts` (list); IPC `plan:comment:list`; test `plan-comment-list.test.ts`.
- **Dep:** WP-P4D-create, **WP-P4D-reply** (it queries/joins `selection_comment_replies`).
- **Do:** list `selection_comments` for the plan's linked docs via `listSelectionComments`, joined with
  `selection_comment_replies` threads.
- **Accept:** lists per-plan comments + threaded replies.
- **Non-goals:** no create/reply mutation.
- **Verify:** main/shared template.

### WP-P4E — comments renderer rail
- **Files:** comments rail in `PlanSurfaceView.tsx`; `src/preload/index.ts`; test.
- **Dep:** WP-P4D-proj, WP-P4B.
- **Do:** render question/answer threads (correlated via `selection_comment_replies.comment_id`), a compose box
  (calls `plan:comment:create`), across all lifecycle states (hardened ≠ frozen — Amendment 1b-ii).
- **Accept:** threads render; answers appear inline; compose works pre-trigger/mid-exec/archived.
- **Non-goals:** no recipient selection in UI.
- **Verify:** renderer Vitest template.

**Integration gate P4Z.**

**Stage P4 graph:** `WP-P4A → {WP-P4C-backend → WP-P4B → WP-P4C-editor, WP-P4D-create → WP-P4D-reply → WP-P4D-proj → WP-P4E} → P4Z`.

---

## STAGE P5 — work-package lifecycle + dispatch (hardening → ready → executing → archived)

**Stage non-goals:** never alter `SC-WP-3A`'s pinned 11-column schema; no board rendering (P6); **no
plan-bound worker before Implement**; `done` remains SC-owned; no work-package undo (link to per-turn/path
restore instead).
**Stage user-visible acceptance:** a plan moves hardening → (Mark Ready) → ready → (human Implement) →
executing → archived (resurrectable); packages are editable with planned paths; the execution baseline is
durably pinned; **no false "activity = done"** (activity never transitions state).
**(Edward ruling 31, 2026-08-02 — revamp Amendments III): the `ready` state must surface as a VISIBLE
UI readiness element — a state badge on the gallery card AND in the reader — and the Implement trigger
is gated on, and visually justified by, that ready state.** Whichever WP renders the trigger UI must
render the badge with it.
**(Edward ruling 26, 2026-08-02): planning surface and Save card are decoupled for now — the P6 board's
commit checkbox is DEFERRED; the user commits via the Save card separately. Package completion evidence
(SC Stage ③ finalization) is unaffected.**

### WP-P5A-schema — package backend + layout companion ⟨DDL⟩
- **Files:** `database.ts` `plan_work_package_layout(package_id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL)`
  (A2 DDL slot, outside `SC-WP-3A`'s 11 columns); package CRUD projection over `SC-WP-3A`; test
  `plan-work-packages.test.ts`.
- **Dep:** `SC-WP-3A`, A2, WP-P3A.
- **Do:** create/edit/assign packages (consuming `SC-WP-3A` CRUD, no schema change); reorder writes
  `plan_work_package_layout`; **assignee validated as a same-workspace agent**; **archive is NOT mutated here
  — it delegates to WP-P5B's transactional lifecycle service** (this WP may expose the UI command surface only).
- **Accept:** packages created/edited/assigned/reordered via `SC-WP-3A` + layout; assignee validated; archive
  delegates to P5B.
- **Non-goals:** no lifecycle-state transitions here; no renderer.
- **Verify:** main/shared template.

### WP-P5A-paths — planned-path companion table ⟨DDL⟩
- **Files:** `database.ts` `plan_work_package_paths(package_id, workspace_id, path, intent_kind, created_at)`
  (A2 DDL slot); populate accessor; test.
- **Dep:** `SC-WP-3A`, A2.
- **Do:** store planned (workspace-relative) paths per package; populate seam from the editor; feeds P7B contention.
- **Accept:** planned paths persisted; workspace-relative only.
- **Non-goals:** no contention logic; no 12th column on `SC-WP-3A`.
- **Verify:** main/shared template.

### WP-P5A-editor — work-package editor renderer
- **Files:** new `src/renderer/components/plan/WorkPackageEditor.tsx`; `src/preload/index.ts`; test.
- **Dep:** WP-P5A-schema, WP-P5A-paths.
- **Do:** create/edit/assign/reorder + planned-path entry; the archive command calls P5B's service (not a direct write).
- **Accept:** editor drives CRUD + planned paths; archive routes through P5B.
- **Non-goals:** no direct state mutation.
- **Verify:** renderer Vitest template.

### WP-P5B — lifecycle-event service + Mark-Ready ⟨DDL⟩
- **Files:** `database.ts` `plan_wp_lifecycle_events(id, package_id, plan_id, from_state, to_state, actor,
  reason, ts)` (A2 DDL slot); new `src/main/plans/plan-lifecycle.ts`; Mark-Ready validation +
  `plans.run_state hardening→ready`; test `plan-lifecycle.test.ts`.
- **Dep:** `SC-WP-3A`, A2, WP-P5A-schema, WP-P4C-backend.
- **Do:** the **sole owner** of `ready` / `executing` / `blocked` / `archived` transitions on
  `plan_work_packages.state` (each ledgered) — **never `done`** (`SC-WP-3C` is authoritative). The package
  **archive** transition lives here (P5A delegates to it). **Mark Ready** flips `run_state hardening→ready`
  only when ≥1 non-archived package + an overview for every populated tab + a valid responsible supervisor.
- **Accept:** non-done transitions ledgered; archive owned here; Mark Ready enforces the three conditions; the
  `done` path is untouched.
- **Non-goals:** no `done` write; no dispatch.
- **Verify:** main/shared template.

### WP-P5C — execution-run baseline + Implement trigger ⟨DDL⟩
- **Files:** `database.ts` `plan_execution_runs(id, plan_id, repository_key, baseline_kind TEXT CHECK(baseline_kind
  IN ('head','unborn')), baseline_head_oid TEXT, baseline_ref TEXT, trigger_source TEXT, app_user_id TEXT,
  triggered_at INTEGER, lifecycle_state TEXT)` (A2 DDL slot); new `src/main/git-checkpoints/plan-baseline-refs.ts`
  (+test); Implement service + IPC `plan:implement` (**renderer-only, human-gesture initiated — an agent cannot
  pull it**); test `plan-implement.test.ts`.
- **Dep:** WP-P5B, `SC-WP-3A`, `SC-WP-2C`, `SC-WP-2D`.
- **Do:** **Implement eligibility:** plan `ready`, ≥1 `ready` package, overviews present, valid supervisor. On
  the **human** trigger, a durable baseline is pinned: for a head baseline, **create a durable ref
  `refs/lares/plans/<planId>/<runId>` at the pinned HEAD OID before the run row commits** (storing an OID in
  SQLite does not protect an unreachable commit from Git GC). **Failure ordering:** create ref → (in the same
  txn) insert the `plan_execution_runs` row with `baseline_ref`, `run_state ready→executing`. A DB-txn failure
  after ref creation leaves an **orphan ref** GC'd by **startup orphan reconciliation — delete any
  `refs/lares/plans/*` ref with no matching `plan_execution_runs` row at all (regardless of lifecycle state);
  archived/inactive runs retain their refs.** Ref-creation failure ⇒ never insert an executing run. **Unborn
  HEAD → `baseline_kind='unborn'`, `baseline_head_oid=null`, `baseline_ref=null`** (explicit marker, not
  nullable-OID alone). **Retain the ref for archived historical audit; release only under an explicit
  plan-deletion policy — plan deletion is the sole normal release path.** **Edge cases:** reject non-repository
  + bare repository; **`trigger_source='renderer-user-action'` + a real `app_user_id`** — never a claimed human
  identity the app cannot prove.
- **Accept:** ineligible plan cannot implement; an agent caller is refused; non-repo/bare rejected; the baseline
  ref is created before the run row; an orphan ref is reconciled on restart; unborn stores no ref; archived runs
  keep their ref; the ref is released only on plan deletion; truthful trigger fields.
- **Non-goals:** no auto-dispatch; no default-plan install (P5D).
- **Verify:** main/shared template (repo / non-repo / bare / unborn / orphan-restart fixtures).

### WP-P5C-gate — pre-Implement enforcement seam
- **Files:** the trusted `SC-WP-2B` `DispatchDeps` boundary in `src/main/git-checkpoints/dispatch-context.ts`
  (plug a structured-plan guard); test `pre-implement-gate.test.ts`; rerun all `SC-WP-2*` boundary suites.
- **Dep:** WP-P5C, `SC-WP-2B`, `SC-WP-2C`, `SC-WP-2D`, `SC-WP-2E`, `SC-WP-2F`.
- **Do:** enforce **no plan-bound worker before Implement** at the shared boundary used by API / IPC /
  orchestration / revival / continuation: **reject every explicit OR default binding to a `format='structured'`
  plan lacking an active execution run — including an explicit `planId` with no `planItemId`.** Legacy HTML plan
  behavior is separate and unchanged.
- **Accept:** any structured-plan binding (explicit-plan, explicit-plan+item, or default) before an active run is
  refused at the boundary; after Implement it is allowed; legacy HTML unaffected; all `SC-WP-2*` boundary suites pass.
- **Non-goals:** no legacy-HTML change.
- **Verify:** main/shared template + SC siblings.

### WP-P5-dispatch — package dispatch + persisted attempt/reconciliation ⟨DDL⟩
- **Files:** package launch/send in `plan-lifecycle.ts` / the dispatch seam; `database.ts`
  `plan_dispatch_attempts(id TEXT PRIMARY KEY, package_id TEXT NOT NULL, plan_id TEXT NOT NULL, execution_run_id
  TEXT NOT NULL, target_agent_id TEXT, requested_plan_item_id TEXT NOT NULL, confirmed_turn_id TEXT, state TEXT
  NOT NULL CHECK(state IN ('pending','delivered','failed','reconciled')), created_at INTEGER NOT NULL, confirmed_at
  INTEGER, reconciled_at INTEGER)` (A2 DDL slot); startup reconciler hook; test `package-dispatch.test.ts`.
- **Dep:** WP-P5C-gate, `SC-WP-3A`, `SC-WP-2E`, `SC-WP-2F`, A2.
- **Do:** send a worker onto a package carrying **explicit `planId + planItemId`** (item validated via `SC-WP-3A`);
  refuse every package send before an active execution run (P5C-gate). **Ordering safety:** insert a
  `plan_dispatch_attempts` row `state='pending'` **before** send. On **confirmed delivery / turn start**, run one
  txn that persists `state='delivered'` **plus `confirmed_turn_id`** together with (or before) the package
  transition `plan_work_packages.state ready→executing` + a P5B lifecycle event. **The package becomes `executing`
  on delivery/turn-start confirmation — NOT when the turn eventually reaches terminal
  `turn_records.status='accepted'`.** Failed send ⇒ attempt `→'failed'`, package stays `ready`. **Reconciliation
  keys primarily by `confirmed_turn_id`:** a startup/periodic reconciler resolves `pending`/`delivered` attempts
  whose package is still `ready`, applies the `executing` transition + lifecycle event, and marks the attempt
  `reconciled` — never inferring completion. **Crash before `confirmed_turn_id` is persisted:** deterministic
  fallback = the earliest matching stamped turn for the same target agent + plan + item + execution run after
  `created_at`, relying on the existing one-send-per-busy-agent invariant; **ambiguous matches remain `pending`
  and surface a diagnostic, never guess.**
- **Accept:** the attempt row precedes send; `executing` is set on turn-start confirmation, not terminal accepted;
  failed send leaves `ready`; a confirmed-but-txn-failed attempt is reconciled to `executing` via
  `confirmed_turn_id` (never `done`); the crash-before-ID fallback resolves the unambiguous case and holds
  ambiguous ones `pending` with a diagnostic; continuation/revival retain the item stamp (focused tests).
- **Non-goals:** no completion inference; no `done`.
- **Verify:** main/shared template.

### WP-P5-archive — plan archive / resurrection / re-implement
- **Files:** plan-level transitions in `plan-lifecycle.ts`; test `plan-archive.test.ts`.
- **Dep:** WP-P5C, WP-P5B.
- **Do:** plan-level `executing/ready → archived` **+ active execution-run closure** (`lifecycle_state`);
  resurrection `archived → ready`; **re-Implement mints a NEW `plan_execution_runs` row** (fresh baseline ref);
  previously done/archived package revisions are retained (SC `package_revision`), not resurrected as `ready`.
  The archived run's baseline ref is retained for audit (release only on plan deletion, per P5C).
- **Accept:** archive closes the run; resurrect returns to `ready`; re-Implement mints a new run with a fresh
  baseline; prior revisions preserved; archived baseline refs retained.
- **Non-goals:** no package-content rollback.
- **Verify:** main/shared template.

### WP-P5D — gated dispatch default + get_my_context runtime text
- **Files:** the `SC-WP-2B` default-source seam; the runtime `get_my_context` handler in `src/main/api-server.ts`
  (**runtime text — no scaffold migration**); test `dispatch-default.activePlan.test.ts`.
- **Dep:** `SC-WP-2B`, `SC-WP-2C`, `SC-WP-2D`, WP-P5C.
- **Do:** the active-plan default returns a plan **only while its execution run is active / `run_state='executing'`**;
  explicit validated dispatch `planId` still wins; `plan_item_id` is never defaulted. `get_my_context` injects
  "You are the responsible supervisor for ‹title›; workers you dispatch inherit it (once implemented)" at runtime.
- **Accept:** no default binding before Implement; after Implement a responsible supervisor's no-explicit dispatch
  stamps the active plan (via SC stamping); explicit overrides; stale focus never binds; `agents.plan_id` not
  bulk-mutated; **no scaffold version bump.**
- **Non-goals:** no item defaulting; no constants edit.
- **Verify:** main/shared template; rerun `SC-WP-2*` dispatch-binding siblings.

**Integration gate P5Z.**

**Stage P5 graph:** `SC-WP-3A + A2 → {WP-P5A-schema, WP-P5A-paths} → WP-P5A-editor; WP-P5A-schema → WP-P5B → WP-P5C
→ WP-P5C-gate → WP-P5-dispatch; WP-P5C → {WP-P5-archive, WP-P5D}; → P5Z`.

---

## STAGE P6 — live mission board (requires SC Stage ③; P6D requires SC Stage ④)

**Stage non-goals:** no completion inferred from activity; no work-package undo; **no second `done` write / no
new done channel**; the board creates no SC tables.
**Stage user-visible acceptance:** work-package cards light up live from open-turn activity (never completion);
`state` and `liveActivity` are separate; file click-through opens the diff; `done`/finalization is SC-owned; the
commit-package action uses the shared SC route. **Gate check:** a supervisor answers status/blocker/diff/restore
in **<30 s**; no false "activity = done."

### WP-P6A — board evidence projection
- **Files:** new `src/main/plans/mission-board-evidence.ts` (+test).
- **Dep:** **WP-SEP**, `SC-WP-3A`.
- **Do:** adapt **WP-SEP**'s live-activity + durable-trail projections to per-package / per-plan shapes for the
  board (witnessed touches, distilled `diff_stats`/`compact_diff`, restore/revert events); annotate unstamped/
  unverified turns; no completion claim.
- **Accept:** per-package live activity + durable trail derived from WP-SEP; unstamped annotated.
- **Non-goals:** no card DTO/UI.
- **Verify:** main/shared template.

### WP-P6B-query — card model (state ⟂ activity)
- **Files:** new `src/main/plans/mission-board.ts` (query); IPC `plan:board:list` in `plan-ipc.ts`;
  `src/shared/types.ts`; test.
- **Dep:** `SC-WP-3A`, WP-P6A.
- **Do:** project `SC-WP-3A` packages + P6A into card DTOs with **separate fields**: structured `state` (from
  `plan_work_packages.state`) and transient `liveActivity` (from open-turn touches). Activity never mutates/
  reinterprets `state` and never yields `done`.
- **Accept:** `state` and `liveActivity` are distinct DTO fields; a touch sets `liveActivity` only; live tick-in works.
- **Non-goals:** no transport; no state write.
- **Verify:** main/shared template.

### WP-P6B-transport — bounded polling transport
- **Files:** polling subscription in `plan-ipc.ts` + a renderer store hook; test.
- **Dep:** WP-P6B-query.
- **Do:** **bounded polling** of `plan:board:list` — a named interval, **cancel when the pane is hidden**,
  **stale-response suppression** (drop out-of-order responses). (No push emitters — polling chosen for simplicity.)
- **Accept:** polls at the interval; stops when hidden; stale responses dropped.
- **Non-goals:** no push producers.
- **Verify:** main/shared + renderer templates.

### WP-P6C — mission board renderer (cards light up, diff click-through)
- **Files:** new `src/renderer/components/plan/MissionBoard.tsx` + `WorkPackageCard.tsx` + css, mounted on the
  Packages tab of `PlanSurfaceView.tsx`; `src/preload/index.ts`; tests `MissionBoard.test.tsx`, `WorkPackageCard.test.tsx`.
- **Dep:** WP-P6B-transport.
- **Do:** cards light from `liveActivity`; witnessed touches tick in. **File click →
  `checkpoint.fileHistory(workspaceId, path, opts)` for the clicked file with the contributing turn selected,
  opening `FileHistoryView`; a secondary "turn diff" action calls `checkpoint.diff(workspaceId, turnId)`
  (turn-wide, opening `AttributionPanel`); restore via `RestoreDialog`.** The `checkpoint.diff` channel is
  turn-wide and **not** path-filtered — file-level uses `fileHistory`. Contention/drift warnings (P7B) render on
  the card; explicit done/commit affordances present (behavior in P6D).
- **Accept:** a card activates from `liveActivity`; file click opens `FileHistoryView` for that path with the
  turn selected; the turn-wide diff is a distinct secondary action; no auto-done.
- **Non-goals:** no commit/done logic here (P6D).
- **Verify:** renderer Vitest template.

### WP-P6D-timeline — timeline projection
- **Files:** timeline projection in `mission-board.ts` + IPC `plan:board:timeline`; test.
- **Dep:** `SC-WP-3B`, `SC-WP-3C`, WP-P5B, WP-P6B-query.
- **Do:** union **`package_finalizations` (authoritative done) + `plan_wp_lifecycle_events` (non-done)** into a
  per-package timeline; backend, with IPC tests.
- **Accept:** the timeline shows finalization-done + lifecycle events in order.
- **Non-goals:** no renderer; no done mutation.
- **Verify:** main/shared template.

### WP-P6D — done + commit renderer integration
- **Files:** done + commit controls in `MissionBoard.tsx` / `WorkPackageCard.tsx`; invoke **`SC-WP-3D`'s existing
  done channel** in `src/main/plans/plan-ipc.ts`; commit-package via **`SC-WP-4E` route + `SC-WP-4F` `CommitOutcome`
  + `SC-WP-4L`**; render WP-P6D-timeline; test `board-done-commit.test.tsx`.
- **Dep:** WP-P6C, WP-P6D-timeline, `SC-WP-3C`, `SC-WP-3D`, `SC-WP-4E`, `SC-WP-4F`, `SC-WP-4L`.
- **Do:** the explicit `done` control calls `SC-WP-3D` (which atomically finalizes + sets `plan_work_packages.state
  ='done'` — the `SC-WP-3C` boundary-unavailable invariant is preserved); **no planning-side `done` write / no new
  channel**; the commit-package action on a done card invokes the **shared** SC coordinator route + renders the
  shared `CommitOutcome`; renders the timeline. Never recomputes topology or forges trailers.
- **Accept:** `done` goes only through `SC-WP-3D`; the timeline renders both sources; commit-package produces
  identical `CommitOutcome` handling as the Save lens; no Save-only coupling.
- **Non-goals:** no done mutation in planning code.
- **Verify:** renderer + main templates.

**Integration gate P6Z.**

**Stage P6 graph:** `WP-SEP + SC-WP-3A → WP-P6A → WP-P6B-query → {WP-P6B-transport → WP-P6C, WP-P6D-timeline};
{WP-P6C, WP-P6D-timeline} + SC Stage④ → WP-P6D → P6Z`.

---

## STAGE P7 — evidence surfaces (conservative, confidence-labeled)

**Stage non-goals:** no exact line-authorship claims; no "clobber" without mechanical byte proof; no automatic
dispatch blocks; no second candidate id.
**Stage user-visible acceptance:** the plan-review projection is the primary review object with honest
mixed-authorship / capture-gap annotations off the pinned baseline; contention advises before dispatch without
blocking; blame-to-intent answers file→plan with confidence — no overclaim. **Gate check:** candidate/bundle
membership is audited against raw `git status --porcelain=v2 -z` (the cross-eval §6 precision check) via
WP-P7A-proj's embedded SC object — distinct from P2's filesystem-registry comparison.

### WP-P7A-proj — PlanReviewProjection
- **Files:** new `src/main/plans/plan-review-projection.ts` (+test).
- **Dep:** `SC-WP-1G`, `SC-WP-3G`, `SC-WP-2I`, WP-P5C (baseline), WP-P6A.
- **Do:** produce a **`PlanReviewProjection`** — **NOT a second candidate model** — combining (a) a
  **baseline-to-current review diff** over plan-witnessed paths (baseline = `plan_execution_runs.baseline_ref` /
  unborn), (b) the **unchanged SC `SelectionPreview` / `CommitCandidate`** embedded, (c) mixed-authorship +
  capture-gap annotations (Amendment 5). **Only the embedded SC object carries `candidateId`; never compute
  another candidate id; never claim baseline-diff identity equals Save-lens identity.** The plan lens
  filters/annotates SC components — **never carves a sub-candidate out of a component that connects to other
  plans** (contract D-1). Evidence never implies completion.
- **Accept:** the projection is not a candidate; only the SC object has an id; the baseline diff + annotations
  render; never splits a cross-plan component.
- **Non-goals:** no new candidate model/id; no auto-commit.
- **Verify:** main/shared template.

### WP-P7A-ui — plan-lens review renderer
- **Files:** plan-lens review view in `PlanSurfaceView.tsx`; reuse `SC-WP-3I` preview; `src/preload/index.ts`; test.
- **Dep:** WP-P7A-proj, `SC-WP-3H`, `SC-WP-3I`.
- **Do:** render the baseline diff + the embedded SC preview via the shared `SC-WP-3I` component; the per-turn
  trail (P6A) is drill-down.
- **Accept:** renders the projection; the SC preview is reused; no topology recompute.
- **Non-goals:** no commit here (P6D).
- **Verify:** renderer Vitest template.

### WP-P7B — pre-dispatch contention advisories
- **Files:** new `src/main/git-checkpoints/contention-model.ts` (+test).
- **Dep:** WP-P5A-paths, WP-P6A.
- **Do:** build a rolling path-contention graph from recent `turn_records.touched`; **map planned
  workspace-relative paths through the workspace prefix into repository-relative encoded `pathBytesBase64` before
  comparison** (two workspaces cannot collide on `src/foo.ts`; linked worktrees are not conflated); warn when a
  package's planned paths overlap active/recent turns. **Advisory only, never an automatic block; never hunk-level.**
- **Accept:** the overlap advisory fires from repo-normalized planned paths; never blocks; cross-workspace
  collisions avoided.
- **Non-goals:** no blocking; no hunk attribution.
- **Verify:** main/shared template.

### WP-P7C — blame-to-intent
- **Files:** new `src/main/plans/blame-to-intent.ts` (+test); IPC + an attribution-view hook.
- **Dep:** WP-P6A; strengthened by `SC-WP-2G`.
- **Do:** given a path/hunk, return contributing turns + their plans with a **confidence label** + a
  conflicting-contributor list — framed "these plans/turns contributed," never "authored this line." File-level
  is v1; exact line provenance stays out. Post-ledger strengthen via `git blame → commit_records /
  commit_turn_links` (`SC-WP-2G`); mixed-path commits still support only commit-level attribution.
- **Accept:** file→turns→plans with confidence + conflicts; no exact-line / clobber overclaim; the post-ledger
  path strengthens when `SC-WP-2G` is present.
- **Non-goals:** no exact line authorship; no clobber labels.
- **Verify:** main/shared template.

**Integration gate P7Z.**

**Stage P7 graph:** `SC-WP-1G/3G/2I + WP-P5C + WP-P6A → WP-P7A-proj → WP-P7A-ui; WP-P5A-paths + WP-P6A → WP-P7B;
WP-P6A (+ SC-WP-2G) → WP-P7C; → P7Z`.

---

## STAGE P8 — legacy import + deletion of bespoke provenance

**Recovery point:** the annotated git tag `pre-planning-surface-baseline` (local, created 2026-08-02 before
Wave 1 dispatch) marks the last commit with the legacy HTML plan implementation fully intact. Any code this
stage deletes is recoverable via `git show pre-planning-surface-baseline:<path>` — deletion WPs need no
copy-aside archiving of source files.

**Stage non-goals:** no deletion before import/parity; no global drop while any workspace with pending legacy rows
is unavailable; conservative importer (no fabricated packages).
**Stage user-visible acceptance:** legacy HTML plans live in-place as structured boards preserving their identity;
the HTML writer / one-writer lock / snapshot VCS / 5-rung resolver are deleted once the global readiness condition
holds; the surface renders from DB rows + `turn_records` alone with zero capability loss.

> **2026-08-04 RULING (Edward) — WP-P8A CUT.** Single-user install; the only 3 `format='html'` plan rows in the
> live DB are junk and will be **deleted at deploy time**, not migrated. No importer, no parity report, no
> extracted-md artifacts. In-flight P8A worker stopped; its partial files removed. Downstream adjustments:
> **P8B** dep on P8A is void — dispatch directly. **P8D**: the "legacy display renders from the extracted md"
> acceptance is void (no legacy display exists after row deletion). **P8F**: the readiness check simplifies to
> **zero active `format='html'` rows DB-wide** (no import/parity markers exist or are required); it still blocks
> on any unavailable workspace with pending legacy rows, and still drops exactly once under a migration marker.
> The WP-P8A text below is retained for reference only — do not dispatch it.

### WP-P8A — legacy HTML importer + parity report ⟨CUT — see ruling above⟩
- **Files:** new `src/main/plans/legacy-plan-importer.ts` (+test); extracted-artifact writer.
- **Dep:** WP-P3B, WP-P5A-schema, WP-P5B, Stage P6.
- **Do:** **update each existing `format='html'` `plans` row in place — preserving `plan.id`, focus, and historical
  references** (never insert a replacement). Set `format='structured'`; **extract inert text/markdown from the HTML
  and write a tracked workspace-relative markdown artifact** at `.lares/plans/legacy/<slug>-<short-artifact-id>.md`,
  linked via `plan_documents(doc_kind='legacy-html')` (this is the storage target — `plan_documents` holds the path,
  the extracted body lives in that md file, which survives P8D's sanitizer/render-pane deletion). **Failure ordering
  / compensation:** **allocate the destination path exclusively and never overwrite an existing artifact** (collision
  → distinct name); write temp → fsync → **atomic rename to final** → link in the same DB txn; **a post-rename DB-txn
  failure hash-checks and removes the exact generated FINAL target** (the temp no longer exists), gated on a
  full-content SHA-256 match; **a hash-mismatched final artifact is preserved** (never remove a pre-existing/modified
  file). Conservative mapping: map **only mechanically recognized task/package structures** into `SC-WP-3A` packages;
  retain unmatched content as a linked archived legacy document + a **manual-review report**. **Parity = {document
  checksum, recognized-package count/text/state, unmatched-section inventory}**; **query the actual DB-wide legacy
  `format='html'` count** (never hardcode).
- **Accept:** in-place conversion preserves `plan.id` / focus; the extracted md artifact is written + linked;
  destination allocated exclusively and never overwrites; post-rename failure removes only the hash-verified final
  target; a hash-mismatched final is preserved; conservative mapping; parity report emitted; count queried.
- **Non-goals:** no source-HTML deletion (retained as an archived reference); no fabricated packages.
- **Verify:** main/shared template.

### WP-P8B — HTML authoring / writeback removal
- **Files:** `src/main/plans/create-plan.ts` (remove the `createPlanSurface` HTML write path); delete
  `src/main/plans/templates/default-surface.ts`; retire `assertPlanRailFree` in `src/main/orchestration/plan-ownership.ts`
  with the writer.
- **Dep:** WP-P8A.
- **Do:** eliminate the unsafe HTML write path; **now** delete the 409 one-writer lock (safe only after the writer is gone).
- **Accept:** no code path writes plan HTML; the lock is gone; no concurrent-write data-loss window opens.
- **Non-goals:** no watcher/snapshot/resolver deletion.
- **Verify:** main/shared template; sibling suites.

### WP-P8C — HTML watcher / reparse removal
- **Files:** `src/main/plans/watch-plans.ts`, `src/main/plans-watcher.ts` HTML reparse pipeline.
- **Dep:** WP-P8B.
- **Do:** remove `reparsePlanFile` / the HTML reparse route; the proposals-watcher is unaffected.
- **Accept:** no HTML reparse path; the proposals-watcher still works.
- **Non-goals:** no resolver/snapshot deletion.
- **Verify:** main/shared template.

### WP-P8D — render-pane / sanitizer / read-ladder retirement
- **Files:** delete `src/main/plans/plan-render-pane.ts`, `plan-pane-manager.ts`, `sanitize-plan-html.ts`,
  `read-ladder.ts`, `section-reader.ts`, `section-anchors.ts`.
- **Dep:** WP-P8B.
- **Do:** remove the HTML render/sanitize/read-ladder stack (the extracted md artifacts from P8A now back legacy
  display — no sanitizer needed).
- **Accept:** pane/sanitizer/read-ladder gone; legacy display renders from the extracted md.
- **Non-goals:** no resolver/snapshot deletion.
- **Verify:** main/shared template.

### WP-P8E — 5-rung resolver / PLAN-EVENT / touch retirement
- **Files:** delete `src/main/plans/plan-events.ts` (`resolveTargetAnchor`, `scrapePlanEventSentinel`,
  `composePlanEvent`, `TurnComposeGuard`), `plan-touch-tracker.ts`, `plan-rail-contract.ts`,
  `execution-trail-writer.ts` (`trailMaterializer`), the legacy `execution-trail.ts`.
- **Dep:** WP-P8C, WP-P8D (a call-site audit proves the fail-open parser is now unreferenced).
- **Do:** delete the bespoke provenance code once no live reference remains — Git objects + SC stamping now do what
  it reimplemented.
- **Accept:** resolver/sentinel/touch/materializer removed; no live references.
- **Non-goals:** no table drops (P8F).
- **Verify:** main/shared template.

### WP-P8F — snapshot accessors + readiness-gated repeatable DROP migration ⟨DDL — A2 terminal exception⟩
- **Files:** `database.ts` — remove snapshot/section accessors; delete `src/main/plans/section-cache.ts`; install a
  **repeatable, readiness-gated migration** (A2 DDL slot).
- **Dep:** WP-P8E, WP-P5B ledger + WP-P6A trail exist, A2.
- **Do:** install a migration that, **each run**, evaluates a **global readiness check** — zero non-imported active
  `format='html'` plans **DB-wide**; every legacy row carries a successful parity/import marker; **no unavailable
  workspace with pending legacy rows** — and only then runs `DROP TABLE IF EXISTS plan_snapshots,
  plan_snapshot_blobs, plan_section_touches, plan_section_changes, plan_events, plan_sections` **once under a
  migration marker**. **Until the condition holds, the tables remain inert but present**; the migration re-checks on
  later launches (repeatable).
- **Accept:** the migration is installed and repeatable even when the drop is deferred; it drops exactly once when
  the global condition first holds; it blocks on any unavailable workspace with pending rows.
- **Non-goals:** no drop while unready.
- **Verify:** main/shared template (ready + not-ready + unavailable-workspace fixtures).

### WP-P8G — renderer / preload / API dead-reference cleanup
- **Files:** `src/renderer/components/plan/PlanActivityTrail.tsx`, `TrustedEventRow.tsx`, `ClaimedPayload.tsx`,
  legacy `plan-surface-model.ts` helpers, `src/preload/index.ts`, retired `api-server.ts` / `ipc-handlers.ts` channels.
- **Dep:** WP-P8F.
- **Do:** remove consumers of the retired provenance. **The inert legacy tables may still exist** (until P8F's
  condition becomes true) — this WP removes only code consumers, not data, and must not assume the tables are gone.
- **Accept:** no dead imports/channels; renderer builds; tolerant of still-present inert tables.
- **Non-goals:** no data drop.
- **Verify:** renderer Vitest; `npm run build`.

### WP-P8H — final full-suite + dead-symbol audit
- **Files:** none (audit).
- **Dep:** WP-P8A–P8G.
- **Do:** run the full main + renderer suites; grep for orphaned exports.
- **Accept:** full `npm run test:supervisor` + renderer suites green; no orphaned exports.
- **Non-goals:** none.
- **Verify:** full build + both suites.

**Stage P8 graph:** `WP-P8A → WP-P8B → (WP-P8C ∥ WP-P8D) → WP-P8E → WP-P8F → WP-P8G → WP-P8H`.

---

## FALLBACK — WP-FB (if K is never reached)

- **Files:** extend `src/renderer/components/checkpoints/AttributionPanel.tsx`; a thin IPC over **WP-SEP**
  (`stamped-evidence-projection.ts`); test.
- **Dep:** **WP-SEP** (branch-independent; it already carries `SC-WP-2A`, `SC-WP-2B`, `SC-WP-2C`, `SC-WP-2D`,
  `SC-WP-2E`, `SC-WP-2F`, `SC-WP-2I`) + the tiny reader (Stage P1).
- **Do:** render conservative, confidence-labeled stamped evidence (turns → files → plans, no completion claims)
  inside `AttributionPanel`. Build **no** registry/watcher/gallery/promotion/mission-board.
- **Accept:** stamped evidence renders in `AttributionPanel` with honest annotations; consumes WP-SEP (which exists
  regardless of the gate); no heavy machinery introduced.
- **Non-goals:** everything P2–P8.
- **Verify:** renderer + main templates.

---

## Integration gates (P0Z–P8Z)

Non-worker integration gates (compact by design). Each registers its stage's new main/shared tests in
`scripts/run-main-tests.mjs`, then requires `npm run test:supervisor` + that stage's **renderer Vitest suites** +
`npm run build` all green. They own only `run-main-tests.mjs` edits (serialized like Save-card's terminal gate WPs).

---

## Global dependency graph (top level)

```
P0: WP-P0PRE → {WP-P0A ∥ WP-P0B} → WP-P0C → P0Z
P1: WP-P1A → WP-P1B → WP-P1C → P1Z ; SC-WP-1I + WP-P0PRE → WP-P1S
        ── PROMOTION-DEMAND GATE (K) ──  [else → WP-FB, stop]
WP-SEP (ungated, after SC Stage ②): SC-WP-2A..2F/2I + retention.ts → WP-SEP
A2 (global DDL barrier) serializes every DDL WP across SC + planning (P8F = terminal drop exception).
A1 (Save-card integration barrier) gates each execution branch by canonical SC-WP name.

P2: A2 → P2A → {P2B ∥ P2C ∥ P2C-compat} → P2D → P2Z
P3: P2A → P3A → {P3B, P3C-cand} → P3C → P3Z
P4: P4A → {P4C-backend → P4B → P4C-editor, P4D-create → P4D-reply → P4D-proj → P4E} → P4Z
P5: SC-WP-3A + A2 → {P5A-schema, P5A-paths} → P5A-editor ;
    P5A-schema → P5B → P5C → P5C-gate → P5-dispatch ; P5C → {P5-archive, P5D} → P5Z
P6: WP-SEP + SC-WP-3A → P6A → P6B-query → {P6B-transport → P6C, P6D-timeline} → (SC Stage④) → P6D → P6Z
P7: SC-WP-1G/3G/2I + P5C + P6A → P7A-proj → P7A-ui ; P5A-paths + P6A → P7B ; P6A (+SC-WP-2G) → P7C → P7Z
P8: P8A → P8B → (P8C ∥ P8D) → P8E → P8F → P8G → P8H
```

Stages are sequential (each consumes the prior's durable shape). Within a stage, DDL WPs are strictly serial (A2);
renderer-only and pure-projection WPs run in parallel. The entire P5–P7 tier is gated on Save-card Stage ③
(`SC-WP-3A`); P6D + P7A also require Save-card Stage ④.

---

## Decisions (Reviewer-ratified)

1. **md-row disposition:** hidden and preserved as **historical md records** (not "debris"), never shown as plans
   or duplicated, with a diagnostic inventory count (WP-P2A).
2. **Comments:** a companion `selection_comment_replies` table (keeping its `id` PK) + an explicit agent-callable
   `answer_plan_comment` tool; question creation/routing owned server-side by WP-P4D-create (WP-P4D-*).
3. **Legacy drops:** hard drops are the terminal state, but only after the global readiness condition, via a
   repeatable deferred migration; otherwise the tables remain inert but present (WP-P8F).

---

<!-- groupthink: planning-surface implementation plan, Lead Planner × Reviewer, Reviewer-approved 2026-07-30 -->


<!-- groupthink_run: 51fc6796 (mode=serial) -->
