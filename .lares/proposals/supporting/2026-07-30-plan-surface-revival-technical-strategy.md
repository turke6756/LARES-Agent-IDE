# Plan-surface revival — technical strategy (Round 2, final)

**Status:** approved technical strategy (deliberation, no code changes yet).
**Governing intent:** Revision 2 of `.lares/proposals/supporting/2026-07-30-plan-surface-revival-design-detail.md` (R2.1–R2.7).
**Method:** Lead-Planner ⇄ Reviewer serial sharpening, 2026-07-30. Every load-bearing
code claim below was verified against source during deliberation.

This document resolves brief questions A–H at file/schema/IPC granularity and folds
them into a revised staged sequence with per-stage acceptance checks. It is written to
be executed by worker agents without further design questions.

---

## 0. Verified-fact baseline (corrections that shape the design)

These correct the round-2 brief; the strategy is built on the verified state.

- **Repo-root `plans/` is gitignored** (`.gitignore:30` `/plans/`); its two HTML files
  are **untracked**. There is **no tracked plan history to preserve** — durable
  artifacts are net-new capability.
- **No blanket `/.lares/` ignore exists.** `.gitignore` names only specific runtime
  subpaths (`.lares/workers/`, `.lares/*/memory/`, `.lares/staging/`, `.lares/usage/`,
  `.lares/research/inbox/`, …). `git check-ignore` confirms `.lares/proposals/*.md` and
  `.lares/plans/*.html` are **tracked by default** — the exact `research/inbox`
  (ignored) vs `research/cleared` (tracked) precedent.
- **`plans` already holds ~190 `format='md'` rows** adopted from repo-root `plans/*.md`
  (`src/renderer/components/plan/PlansMenu.tsx:16`; the gallery filters to
  `format==='html'`). **`format='md'` does NOT identify a proposal** ⇒ a dedicated
  `proposals` table is required; `run_state` is lifecycle, not artifact type.
- The default surface template bakes the **local DB UUID** into
  `<body data-plan-id="4cd99980-50f0-4117-b6d3-803d2e2d2c8b">` (`src/main/plans/templates/default-surface.ts:84`,
  `renderDefaultSurface(planId, …)`) ⇒ tracking that HTML unchanged is a
  clone-dirtying bug.
- The subscription owner is **`src/main/plans-watcher.ts`**; `src/main/plans/watch-plans.ts`
  exports `reparsePlanFile(plan)` (invoked via `onPlanSettled`) and **assumes HTML**.
- Gallery transport is **IPC `plan:list` / `plan:projection`** (`src/main/plans/plan-ipc.ts`),
  not `GET /api/plans`.
- Supervisor scaffold constant is **`SUPERVISOR_AGENT_MD`** (derived `_V19 → _V20`,
  `src/shared/constants.ts:361,673`); worker is `WORKER_CLAUDE_MD` (derived chain).
- `createPlanSurface` (`src/main/plans/create-plan.ts:87`) writes to repo-root
  `<ws>/plans/` (`plansDirFor`, `:142`), **format hard-coded `'html'`**, Windows-only,
  and writes the **DB row before the file**.
- The md-migration guard is `rejectMarkdownMigration` (`src/main/api-server.ts:3455`,
  keys `:3680`, `seedMarkdown` inert `:3463`).
- `supervisor_focus` (`src/main/database.ts:916`) is many-to-many
  (PK `(supervisor_id, plan_id)`, both `ON DELETE CASCADE`).
- Supervisor capability rule is **`hasSupervisorPrivilege(agent)`** (`src/shared/types`,
  used at `src/main/api-server.ts:635`; `isSupervisor` / `privilegeLane==='supervisor'`).
- There is **no `.agents/skills` root today**; skills deploy to
  `.lares/supervisor/.claude/skills/<name>/SKILL.md`. A Codex skill root is net-new.

---

## A. Filesystem layout + git posture

### Layout — two flat spaces, distinct registries

```
.lares/proposals/<date>-<slug>.md                      # cheap markdown; valid terminal state (R2.6 §1)
.lares/plans/<date>-<slug>-<short-artifact-id>.html    # promoted surface; collision-resistant name
```

- **Flat files.** Stage-2's board is DB state, so no per-plan subdirectories.
- **Archived / promoted are `state`/`run_state` values, never physical moves** (a move
  churns UNIQUE keys and forces watcher re-index for zero benefit).
- **Collision-resistant filenames** `<date>-<slug>-<short-artifact-id>.html`.
  Branch-local numeric suffixes collide on merge; a short portable artifact-id does not.

### Git posture — track authored intent; keep the tracked artifact portable

- **Track `.lares/proposals/` and `.lares/plans/`.** They are already tracked by default;
  add only a documenting comment block to `.gitignore` (mirroring the research-store
  block) so a future blanket-ignore cannot silently swallow them. Runtime noise
  (`workers/`, `memory/`, `staging/`, `usage/`) stays specifically ignored.
- **The user is always the committer** (R2.4). Artifacts enter git history only on human
  commit; nothing auto-commits.
- **Precondition before any HTML is tracked — the tracked artifact must not contain the
  local DB primary key.** Introduce a portable `artifact_id` (workspace-scoped unique,
  generated at creation, stable across clones). The file embeds **`data-artifact-id`**
  (that value), never `plans.id`. The local `plans.id` stays DB-only; the watcher
  resolves a file to its row by `(workspace_id, artifact_id)` then `path`. Opening a
  tracked artifact whose `artifact_id` is unknown to this workspace's DB ⇒ the watcher
  **adopts** it (mints a `plans` row referencing the existing `artifact_id`) and **does
  not rewrite the file** — no write-on-open, no dirtying.
- **Do not persist the checkpoint-derived Execution Trail into the tracked HTML.**
  Render it live from `turn_records`. Persisting derived UI material would dirty the
  plan on every execution and cause merge conflicts. **Track authored intent only.**
- **Consequence, stated plainly:** proposals/plans appear in `git status` and become
  shareable history on commit. Repo-root `plans/` stays gitignored scratch, untouched.

### Construction owner

`src/main/workspace-state-dir.ts` ensures `.lares/proposals/` and `.lares/plans/` exist
on first touch (research/ is precedent). **Directory creation only — no DB work, no file
relocation** (see §H / legacy compatibility).

---

## B. Author attribution — witnessed-first

- **Canonical author is witnessed, not self-asserted.** On discovery, resolve the exact
  canonical path against the **earliest qualifying `file_activities` write near
  discovery time**; that agent (id/role) is canonical. **Must not assume
  one-agent-per-cwd** — match the witnessed write event, never "the one agent in this
  folder."
- **Frontmatter is display metadata / fallback only**, validated and stored separately;
  it never overwrites registry timestamps.
- **No witnessed write ⇒ `author_role='unknown'`, not `human`.** Missing capture is not
  proof of human authorship.
- **Date grouping uses the registry's DB `created_at`** (stable). `authored_at` (optional
  frontmatter) is a separate display hint; `mtime_ms` is an "updated" hint only.

Frontmatter the Stage-0 skill teaches (advisory, plus the portable id from Δ2):

```yaml
---
artifact_id: prop_9f3c7a10        # portable, stable across clones (see C)
title: Structured commit composer
author_role: supervisor           # display hint; witnessed value wins
authored_at: 2026-07-30T14:05:00Z
---
```

---

## C. Dedicated `proposals` registry + split watcher

### Schema

```sql
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,          -- local DB id
  artifact_id   TEXT,                      -- portable id (from frontmatter; minted if absent)
  workspace_id  TEXT NOT NULL,
  path          TEXT NOT NULL,
  slug          TEXT,
  title         TEXT,
  state         TEXT NOT NULL,             -- proposal | promoted | archived
  author_agent_id TEXT,
  author_role   TEXT,                      -- supervisor | worker | unknown
  author_display TEXT,
  authored_at   TEXT,
  created_at    TEXT NOT NULL,             -- DB mint time; stable gallery grouping key
  updated_at    TEXT NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  promoted_to_plan_id TEXT,
  deleted_at    TEXT,
  UNIQUE(workspace_id, path)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_artifact
  ON proposals(workspace_id, artifact_id) WHERE artifact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_promoted_to
  ON proposals(promoted_to_plan_id) WHERE promoted_to_plan_id IS NOT NULL;
```

Add to `plans` (nullable, via the existing try/catch `ALTER TABLE ADD COLUMN` idiom used
for `agents.plan_id`):

```sql
ALTER TABLE plans ADD COLUMN artifact_id TEXT;              -- portable id baked into the file
ALTER TABLE plans ADD COLUMN source_proposal_id TEXT;       -- local join (fast, same-workspace)
ALTER TABLE plans ADD COLUMN promoted_at TEXT;
ALTER TABLE plans ADD COLUMN promoted_content_hash TEXT;    -- SHA-256 of exact promoted source bytes
ALTER TABLE plans ADD COLUMN responsible_supervisor_id TEXT;-- see E
-- CREATE UNIQUE INDEX on plans(workspace_id, artifact_id) WHERE artifact_id IS NOT NULL   (S1.A)
-- CREATE UNIQUE INDEX on plans(source_proposal_id)        WHERE source_proposal_id IS NOT NULL (one-to-one promotion)
```

This keeps proposal files entirely out of HTML section/snapshot/focus machinery. The
gallery reads a **single unified projection** that unions/normalizes `proposals` +
`plans(format='html')`; the renderer stays agnostic to the two tables.

### Portable proposal identity (survives cloning)

- The Stage-0 skill writes a valid portable `artifact_id` into proposal **frontmatter**
  at authoring time.
- `proposals-watcher.ts` **adopts the frontmatter `artifact_id`** on registration.
- For a **hand-authored proposal lacking one**, the watcher **mints a valid `artifact_id`
  and safely inserts it into the file's frontmatter *before* registration** (idempotent:
  a later re-scan sees the present value and does not re-mint).
- Promotion embeds that same value + `promoted_content_hash` in the plan (D). A clone
  therefore registers the proposal under its **stable** id and reconstructs lineage.

### Split watcher — two pipelines

- **New `src/main/proposals-watcher.ts`** owns `.lares/proposals/`: mints/updates
  `proposals` rows, runs witnessed attribution, performs the frontmatter-id adopt/mint.
  **Its events NEVER reach `reparsePlanFile`.**
- **`plans-watcher.ts`** keeps HTML: continues watching repo-root `plans/` (legacy
  compat) **and** adds `.lares/plans/`, routing both through `onPlanSettled` →
  `reparsePlanFile`. On an unknown-`artifact_id` file it **adopts** (mints a row), never
  rewrites.
- The "sole watcher" invariant only guards against duplicate subscriptions to the **same**
  path; a second watcher owning a **different** directory is compliant.

### Duplicate `artifact_id` policy (NORMATIVE)

If the same `artifact_id` appears at two paths **within one workspace**: **leave the
duplicate file unregistered and surface a diagnostic/notice naming BOTH paths + the
shared `artifact_id`.** Do **not** insert a synthetic row (it would pollute the registry
and cannot satisfy the unique index anyway), and **never rebind** the canonical
(first-registered) row between paths.

### Malformed frontmatter policy (NORMATIVE)

If a proposal's YAML frontmatter is malformed or ambiguous: **report/quarantine (surface
a diagnostic; register with witnessed attribution and `author_role` per B, or leave
unregistered with a notice) — never rewrite uncertain YAML.** Frontmatter is only
safely rewritten in the single narrow case of inserting a missing `artifact_id` into
otherwise-valid frontmatter.

### md-migration guard

`rejectMarkdownMigration` continues to guard the external plan create/register API.
Proposals never touch it. It is lifted **only** inside the promotion service (D), the one
sanctioned md→zones conversion.

---

## D. Promotion flow — single confirm, idempotent, transactional, compensated

Picker first; then one atomic operation. **Never mint an unowned plan.**

1. UI: user clicks **Promote** on a proposal → the **supervisor picker opens first**
   (choices filtered to actual supervisor agents — see E).
2. On confirm: **`POST /api/proposals/:id/promote`** with
   `{ supervisor_id, idempotency_key }`.

### Promotion service — `src/main/plans/promote-proposal.ts`

This **requires splitting `createPlanSurface`** (which today writes the DB row before the
file, monolithically). Extract two reusable pieces; refactor `createPlanSurface` to call
them so its behavior and tests are preserved:

- **`allocatePlanPath(ws, slug) → { relPath, artifactId }`** — collision-resistant
  `<date>-<slug>-<short-artifact-id>.html`.
- **`renderSurfaceBytes(artifactId, title, seededZones) → string`** — pure; bakes
  `data-artifact-id` (NOT the DB UUID) and the seeded zone content.

`promoteProposal({ proposalId, supervisorId, idempotencyKey })`:

1. Load the proposal; validate; **compute `promoted_content_hash` (SHA-256) over the exact
   source bytes.**
2. **Convert** the markdown injection-safely: strip YAML frontmatter; escape/convert md→
   HTML; put the **full proposal body into Summary (`sec_summry`)**; extract a
   `## Open Questions` section into `sec_quests` **only when present**.
3. **Render exact plan bytes to a temporary sibling** file in `.lares/plans/`
   (e.g. `.<final>.tmp`) via `renderSurfaceBytes`.
4. **Open a DB transaction**; **re-check `promoted_to_plan_id`** (idempotency — return the
   existing plan on hit; also short-circuits a repeated `idempotency_key`).
5. Insert **plan + lineage + responsibility + active-plan + focus** rows in the
   transaction: `plans` (with `artifact_id`, `source_proposal_id`, `promoted_at`,
   `promoted_content_hash`, `run_state='hardening'`, `responsible_supervisor_id`),
   `proposals.promoted_to_plan_id` + `state='promoted'`, `supervisor_active_plan`, and an
   ordinary `supervisor_focus` row (continuity / `get_my_context`). The plan HTML embeds
   `data-source-proposal-artifact-id` (the proposal's portable id) +
   `data-promoted-content-hash`.
6. **Atomically rename** the temp file to its final path **before commit**.
7. **Rename failure → roll back** the transaction (no plan row persists).
8. **Commit failure after rename → remove only the exact generated file**, but **only
   after verifying the SHA-256 of the complete generated plan bytes** (the full file
   content just written) matches — not merely the embedded artifact/source metadata — so
   a concurrently-modified or unrelated file is never deleted.
9. **Suppress/tolerate watcher reconciliation during the window:** the service holds a
   short-lived path-ignore token so `plans-watcher` does not race-adopt the temp/final
   file mid-transaction.

**One-to-one promotion** is enforced by the unique indexes on
`proposals(promoted_to_plan_id)` and `plans(source_proposal_id)`.

**Rationale for a new plan id (not in-place conversion):** the markdown proposal is
immutable lineage/history; the promoted plan is a different mutable artifact with
different invariants. The proposal md persists forever (never deleted/rewritten); the
`promoted_content_hash` + seeded plan preserve exactly what was promoted even if the
proposal md is later edited.

---

## E. Responsibility + subscription — explicit, not `supervisor_focus`

`supervisor_focus` is many-to-many and cannot express singular responsibility or a
deterministic dispatch default. Add:

```sql
ALTER TABLE plans ADD COLUMN responsible_supervisor_id TEXT;  -- singular responsible supervisor
CREATE TABLE IF NOT EXISTS supervisor_active_plan (
  supervisor_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL     REFERENCES plans(id)  ON DELETE CASCADE,
  activated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **FK behavior:** `plans.responsible_supervisor_id` → **`ON DELETE SET NULL`** (deleting
  the supervisor leaves the plan; responsibility becomes null, surfaced as "unassigned").
  `supervisor_active_plan` rows → **`ON DELETE CASCADE`** on both supervisor and plan.
  `supervisor_focus` keeps its existing cascade.
- **Promotion sets both** `responsible_supervisor_id` and `supervisor_active_plan` (and
  the ordinary `supervisor_focus` row).
- **Supervisor definition:** picker choices **and** server-side `/promote` validation use
  **`hasSupervisorPrivilege(agent)`** and enforce **same-workspace membership** — not the
  focus route's existence-only check.
- **Dispatch default:** a dispatch with no explicit `planId` defaults from the
  dispatcher's **`supervisor_active_plan`** (deterministic), **not** "exactly one focus"
  (brittle — a stale retained focus would silently disable it). **Explicit dispatch
  `planId` still wins after validation.**
- **"All its workers subscribe," stated precisely:** *future* turns dispatched by the
  responsible supervisor **inherit the active plan** (including reused workers) via the
  Stage-1 dispatch binding stamping `turn_records.plan_id`. Existing `agents.plan_id`
  rows are **not bulk-mutated**. **Bound-worker UI derives from authoritative
  `turn_records.plan_id`** with a defined recency/status rule (workers with an accepted
  turn on the plan within the active window, still live).
- **Surfaced to the agent:** `get_my_context` injects the plan outcome/summary + "You are
  the responsible supervisor for ‹title›; workers you dispatch inherit it."

---

## F. Gallery UI + transport

- **Dedicated split-screen pane `PlanGalleryPane.tsx`** (list top / reading pane bottom),
  opened from the existing Plans toolbar button.
- **One unified gallery projection** built server-side (union/normalize `proposals` +
  `plans(format='html')`). Rows: date-grouped by DB `created_at`, author chip (display +
  role icon), type badge (Proposal / Plan), state chip, **Promote** button (proposals
  only), archived/promoted filter toggle (default hides `archived` + `promoted`).
- **Transport = new IPC channels** (matching the existing `plan:list` mirror pattern, not
  `GET /api/plans`):
  - `plan-gallery:list` → unified rows.
  - `proposal:read` → md body, with **workspace/path-containment validation + a byte cap**.
  - `proposal:promote` → the promotion service (D).
  - existing `plan:projection` for html plans.
- **Reading pane:** extract a **read-only markdown component** for proposals (do **not**
  reuse the stateful `FileViewerPanel` wholesale); html plans keep `PlanSurfaceView`.
  Specify **detached-Plans-window** behavior and native **`WebContentsView` visibility
  suspension** when the pane is hidden.
- **Supervisor picker** (`PromoteDialog.tsx`) choices filtered via `hasSupervisorPrivilege`.
- **Smallest shippable:** list + click-to-read + promote + picker + archived toggle +
  date grouping + author chip. Defer free-text search and multi-facet filters.

---

## G. Scaffold + Stage-0 split

- **Stage 0A scope note (R2.7 of the proposal):** the skill and instruction edits encode
  the supervisor's DRIVING role, not just a filing convention. The skill's trigger fires
  on the situation ("discussion is converging on feature-shaped work — offer to write a
  proposal"), and the supervisor scaffold text states the proactive behavior: recognize
  proposal-shaped discussion, offer the next best practice (promotion → groupthink
  hardening → work-package scoping → worker launch) at the right moment, never assuming
  the user knows the app's concepts.
- **Stage 0A (genuinely no app code):** a manually-installed `proposal-to-plan` skill +
  instructions using **existing tools only**. The skill's first step **creates
  `<workspace>/.lares/proposals/` with the agent's own filesystem tools** when absent
  (it cannot call the internal `workspaceStateDir()` helper; it hardcodes the
  `.lares/proposals/` relative path under the workspace root it is given — the
  `.dashboard` fallback is not a Stage-0 concern). Because the gallery promote seam does
  not exist yet, **promotion in 0A is the manual existing path** (supervisor runs
  `create_plan` / focus MCP by hand); the "groupthink output lands in a plan" acceptance
  moves to **S1.E**.
- **Stage 0B (app code):** deploy the skill + instruction edits through
  `src/shared/constants.ts` + the scaffold-version migration (requires build/relaunch +
  subsequent agent launch).
- **Scaffold specifics (verified names + discipline):**
  - **Both provider skill roots** are **separate version-1 scaffold-map entries**, sharing
    one body constant where possible:
    `.claude/skills/proposal-to-plan/SKILL.md` **and**
    `.agents/skills/proposal-to-plan/SKILL.md` (net-new root — no `.agents/skills` exists
    today). "Codex-derived variants inherit" applies to derived *instruction bodies*, not
    to separate skill-root files.
  - **Supervisor instruction edit** = independent version bump on **`SUPERVISOR_AGENT_MD`**
    (re-derive from the current live export, freeze the previous body byte-exact, add its
    hash to `previousHashes`, add migration tests). Teaches: on a potential work idea,
    write `.lares/proposals/<slug>.md` with the portable `artifact_id` frontmatter — and
    if simple, that is the end (valid terminal state); promotion → plan is a human act in
    the gallery; when you hold an active plan, dispatched workers inherit it; run hardening
    groupthinks with `plan_id`+`section_anchor`.
  - **Worker instruction edit** = **separate** independent version bump on
    `WORKER_CLAUDE_MD` (re-derived from current source — verify the live chain; do not
    assume `_V8→_V9`), same freeze/hash/tests discipline. Content: a worker may also author
    a proposal (`author_role: worker`), plus the Stage-1 ceremony deletion (drop the
    PLAN-EVENT every-turn requirement + read-before-edit-for-progress).
  - Each changed scaffold-map entry independently requires: version increment, frozen
    previous-body hash in `previousHashes`, migration tests, rebuild/relaunch + agent
    launch for deployment. **Existing workspaces are NOT auto-updated** — the
    scaffold-version migration applies on workspace open.
  - Skills live under skill roots and are **scaffold-installed, agent-invoked only**
    (`.claude/` write-gating would hang a non-interactive worker).

---

## H. Revised sequence + per-stage acceptance

### Stage 0A — no app code (ship immediately)

Manual `proposal-to-plan` skill/instructions; proposals written to `.lares/proposals/`
(skill creates the dir when absent); promotion is the manual `create_plan` path.
*Accept:* in a fresh workspace with no `.lares/proposals/`, the skill creates it and a
supervisor unprompted authors a `.lares/proposals/*.md` with a portable `artifact_id`;
demand probe begins.

### Stage 0B — scaffold deploy

Constants + migration for the two skill roots (v1 each) and the supervisor/worker edits
(each its own version bump). *Accept:* migration tests green; a freshly-opened existing
workspace gains the skills + instructions after relaunch.

### Stage 1 — join + registry + gallery + promotion

Ordered so no sub-part depends on later schema:

- **S1.0 — item schema (dormant, first).** `plan_items` (id, plan_id, title,
  acceptance_condition, state, assignee, parent_item_id, ordering) and
  `plan_item_state_events` (item_id, from_state, to_state, actor, reason, ts) — a small
  audit ledger, NOT a content VCS. States
  `not_started | active | ready_for_review | blocked | done | dropped`; `done` is only an
  explicit human/supervisor transition, never inferred. Items stay **optional/unused**
  (flat mission = one implicit item). *Accept:* schema present; migrations green.

- **S1.A — `.lares/` space + portable identity + split-out primitives.**
  `workspace-state-dir.ts` ensures `.lares/proposals/` + `.lares/plans/` (dirs only, no
  relocation). New surfaces created in the **resolved** state dir via `workspaceStateDir()`
  / `translateStateRelPath()` (honoring the `.dashboard` fallback for rename-blocked
  workspaces). Extract `allocatePlanPath()` + `renderSurfaceBytes()` from
  `createPlanSurface`; bake `data-artifact-id` (not the DB UUID); render the Execution
  Trail from `turn_records` (never persisted to HTML). Add the plan unique indexes on
  `(workspace_id, artifact_id)` and `(source_proposal_id)`. Repo-root `plans/` remains
  watched as legacy compatibility; legacy files stay in place until the Stage-2 importer.
  *Accept:* a UI-created plan lands under `.lares/plans/` and shows in `git status`;
  opening it in a clone does **not** dirty the file.

- **S1.B — checkpoint join** (proposal S1.1–S1.5, validated against S1.0 schema).
  `turn_records.plan_id` + `plan_item_id` (nullable) + indexes; dispatch binding
  (`DispatchContext` gains caller-suppliable `planId`/`planItemId`, validated server-side:
  plan ∈ workspace, item ∈ plan; resolved values copied into `turn_records` at open time,
  never inferred later); Execution Trail derived from `turn_records` (not `plan_events`);
  evidence-first sidebar. `plan_item_id` validated **only when supplied** (else null).
  *Accept:* every plan-bound dispatch (direct, orchestration, continuation, failed turn)
  yields a correct join; deleting an agent preserves the join (plain attribute, no FK
  cascade).

- **S1.C — proposals registry.** `proposals` table + `src/main/proposals-watcher.ts` +
  witnessed attribution + frontmatter `artifact_id` adopt/mint + the normative duplicate
  and malformed-frontmatter policies. *Accept:* agent- and hand-authored md both register
  with correct witnessed author (or `unknown`) and stable `created_at`; a hand-authored
  file without `artifact_id` gets one safely inserted; a duplicate `artifact_id` is left
  unregistered with a both-paths diagnostic.

- **S1.D — gallery pane.** `PlanGalleryPane.tsx` + unified projection + IPC
  (`plan-gallery:list`, `proposal:read`, `proposal:promote`) + read-only md component.
  *Accept:* proposals + plans list date-grouped, author chips correct, click-to-read works
  for both md and html. **Needs S1.C.**

- **S1.E — promotion.** `promote-proposal.ts` service (transactional, compensated,
  idempotent) + responsibility/active-plan (E, with FK behavior) + md-400 lift at the
  endpoint + injection tests + portable lineage embedding. *Accept:* promote mints a
  linked `hardening` plan with a responsible supervisor; source md persists as `promoted`;
  the Stage-0 "groupthink lands in a plan" acceptance is validated here. **Needs
  S1.C + S1.D + the S1.A split.**

- **S1.F — ceremony deletion + subscription default.** Remove `assertPlanRailFree` 409
  lock and the PLAN-EVENT every-turn requirement; dispatch default from
  `supervisor_active_plan`; `get_my_context` "take charge" text. *Accept:* a responsible
  supervisor's worker inherits the plan via `turn_records`; no worker edits plan HTML or
  emits a sentinel. **Independent.**

**Independent vs coupled:** independent = S1.0, S1.A, S1.B, S1.F. Coupled = S1.D needs
S1.C; S1.E needs S1.C + S1.D + the S1.A split.

**Stage-1 dogfood gate (unchanged from proposal):** ≥5 real multi-agent tasks over one
week; **≥3 plans created voluntarily**; a plan created from the UI in <~30s; a supervisor
identifies status/blocker/responsible-agent/diff/restore for a task within ~30s; a resumed
agent orients from **one** bounded context read; low-quality checkpoints, contention, and
unattributed-window changes stay visible. **If voluntary use does not occur, stop** — keep
the cheap proposals gallery (it earns its keep alone), fold the trail into
AttributionPanel, and retire the heavy surface. Do not proceed to Stage 2.

### Stage 2 — gated on voluntary use

Structured renderer-native mission board modeling the `proposal → hardening → executing →
archived` (resurrectable) state machine; `plan_items` first-class (title, acceptance
condition, state, assignee); agent contract replaces HTML-section tools
(`get_plan_context`, `set_plan_item_state`, `add_plan_note`); **legacy importer** converts
old repo-root `plans/*.html` → board and archives originals; legacy HTML retired; bespoke
provenance deleted (5-rung resolver, `plan_snapshots`/`plan_snapshot_blobs`, section
hashing, touch tracking, `read-ladder`, `section-*`, `sanitize-plan-html`, render-pane).
**Snapshots die only once the plan is structured DB state whose mutations are recorded by
the `plan_item_state_events` audit ledger** — never on the false premise that checkpoints
already version plan edits (human UI plan edits occur outside checkpointed dispatches).

### Stage 3 — gated

Commit composer under R2.4's **user-always-commits** contract: group per **work package**
by default (plan = the commit series); begin from **witnessed paths** never the raw
window; show contention + unattributed changes + sibling overlap; preview exact contents +
message; take a recovery snapshot before touching index/refs; **human/supervisor-initiated
only**, output always a staged proposal gated on the human. Build only after the board is
used without it.

---

## §12. Promotion / migration acceptance — failure cases (worker test matrix)

Workers must cover, at minimum:

- double-click / idempotent-key retry → single plan, second call returns the existing one;
- canceled picker → **no** plan minted (nothing unowned);
- missing source file at promote time → clean error, no partial state;
- malformed/absent frontmatter → report/quarantine, **no YAML rewrite** (except the narrow
  safe `artifact_id` insertion into otherwise-valid frontmatter);
- unsafe markdown (raw `<script>`/HTML) → escaped/neutralized in seeded zones (injection
  tests);
- slug / filename collision → collision-resistant name resolves it, no overwrite;
- **write-failure after DB prep** → transaction rolled back, no plan row;
- **DB commit-failure after rename** → only the exact generated file removed, gated on a
  **full-file SHA-256** match;
- **clone with an already-known `artifact_id`** → adopt without rewrite/dirty;
- **duplicate `artifact_id` within one workspace** → duplicate left unregistered +
  both-paths diagnostic, canonical row never rebound;
- **proposal edited after promotion** → plan retains `promoted_content_hash` + seeded
  content unchanged;
- supervisor deleted → `responsible_supervisor_id` nulled, `supervisor_active_plan` row
  cascaded;
- non-supervisor agent chosen in picker → rejected by `hasSupervisorPrivilege`;
- WSL workspace → plan creation cleanly rejected (Windows-only v1), not a crash;
- both `.lares/` and `.dashboard/` present → uses the resolved dir, honors the fallback.

---

## Invariant conflicts — flagged and resolved

- **Shared-cwd (many agents, one working directory).** All attribution is
  per-witnessed-write / per-dispatch / per-turn — never "the one agent in this folder."
  The plan↔turn join stamps `turn_records` at dispatch and is never re-inferred from cwd,
  plan-file edits, final messages, or provider hook keys.
- **`.claude/` write-gating.** Proposals target `.lares/proposals/` (not `.claude/`), so
  no non-interactive worker hangs. Skills live under skill roots and are
  scaffold-installed, agent-invoked only.
- **Checkpoint capture assumptions.** Proposal md writes occur in normal turns → witnessed
  via `file_activities` → attribution works. Human plan-HTML edits in the UI occur outside
  a checkpointed dispatch, so plan-state history relies on the Stage-2 item-state audit
  ledger, not checkpoint refs (snapshots retained until then).
- **Tracked-artifact identity.** Portable `artifact_id` (not the DB UUID) is baked in-file;
  the derived Execution Trail is never persisted → no clone-dirtying, no execution-driven
  merge conflicts.
- **Scaffold non-deployment.** The G edits + `.lares/` dir construction reach existing
  workspaces only via on-open dir construction + the version-bump migration + relaunch;
  they are never assumed to be already present.

---

## Bottom line

The surface was never lacking evidence — it lacked a **front door**, a **light touch**, a
**join**, and a **cheap entry point** for ideas. Checkpoints supply the witnessed evidence
that makes the light-touch version possible; the proposals gallery supplies the cheap entry
point that makes most ideas valid terminal artifacts with zero ceremony; promotion is the
single formal gate where a supervisor takes charge and plan formality begins. Build
**cheap proposals → deliberate promotion → structured intent joined to automatic
checkpoint evidence → user-composed commits** — in that order, each stage gated on the
previous one earning its keep. If the one-week probe is not used voluntarily, keep the
cheap proposals gallery and fold the execution trail into the AttributionPanel; do not keep
a separate heavyweight planning product alive for the sunk cost of its provenance
machinery.


<!-- groupthink_run: c50b5f71 (mode=serial) -->
