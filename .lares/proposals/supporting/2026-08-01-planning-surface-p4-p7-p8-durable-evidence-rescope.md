# Planning-surface P4 / P7 / P8 Rescope — folder-native document home, durable evidence ladder, checkpoint-free archive

**Status:** executable rescope — GroupThink deliberation, Lead Planner × Reviewer, five review rounds,
Reviewer-approved 2026-08-01. Bounded rescope of stages **P4, P7, P8** of
`.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md` against
**Amendments II (rulings 10–23)** of `.lares/proposals/2026-07-30-planning-surface-revamp.md` and the
**P0–P2 rescope** (`.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`).

**Bounded scope.** Targeted fix, not a redo. Amends **P4/P7/P8 only**. **Builds on** the P0–P2 rescope's
§R0 (folder schema), §R1 (intent markup), §R2 (ARC file), **P2L** (intent ledger + `plan:intents:list`),
and §R-ATTR (attribution authority order) as **normative inputs** — never reinvents them. **Does not touch**
P5/P6 bodies (P6D composer/trailer emission is *consumed by name* only), and **does not reopen** gate K,
P0–P2, or P2L.

**Authority.** Subordinate to revamp Amendments 10–23 and to the P0–P2 rescope §R0/§R1/§R2/§R-ATTR.
Supersedes the **P4/P7/P8** stage text of the parent implementation plan where it conflicts; everything in
the parent plan not restated here carries forward unchanged.

**Anchor policy.** Symbolic anchors (file / function / table / IPC-channel / column names) are authoritative;
line numbers are orientation only — this repo is actively edited and numeric anchors drift.

**Per-WP shape.** Every worker package lists **Files · Dep · Do · Accept · Non-goals · Verify** and fits one
worker context. Verify templates follow the parent plan §0.1:

```powershell
# Main/shared single test
npm run build:main
node dist/main/<compiled-test-path>.js

# Renderer single test
npx vitest run --config vitest.config.ts <renderer-test-file>

# Full main suite
npm run test:supervisor
```

Every new main/shared test registers in `scripts/run-main-tests.mjs` or `npm run test:supervisor` silently
omits it; each stage's integration gate owns the registry edit so parallel WPs never contend.

**A2 / DDL note (normative for this rescope).** P4/P7/P8 **add no new `database.ts` DDL**. The A2 order is
unchanged, including the new P0–P2 rescope nodes:

```
WP-P2A → WP-P2L-schema → P3A slot (incl. promotion_requests) → P4D-reply
  → P5A-schema / P5A-paths / P5B / P5C / P5-dispatch → P8F
```

serialized against the named Save-card migrations (`SC-WP-2A / 2D / 2F / 2G / 3A / 3B / 4C`). The parent's
`P4D-reply` DDL node and the **WP-P8F terminal `DROP` exception** are retained as-is; §R-P8F below
**strengthens** WP-P8F's drop-set invariant without adding a migration or node.

**Stable tab keys (normative; `src/shared/types.ts`).** Tab identity is a stable key, **separate from display
labels**, to avoid singular/plural drift in `plan_tab_overviews` rows:

```ts
type PlanTabKey =
  'overview' | 'proposal' | 'plan' | 'deliberations' | 'research' | 'supplements' | 'packages' | 'legacy-html';
```

Folder→tab mapping (normative): `ARC.md → overview`; `plan.md → plan`; `deliberations/* → deliberations`;
`research/* → research`; `supplements/* → supplements`; external source proposal → `proposal`;
`doc_kind='legacy-html' → legacy-html`. **`plan.json` and every `.gitkeep` are suppressed** (never mapped).

---

## STAGE P4 (amended) — folder-native tabbed document home + intent lifecycle + overviews + comments

**What changes vs. parent P4:** the document home renders the **plan folder's inherent §R0 structure**
(`plan.md` + `deliberations/` + `research/` + `supplements/`, with **`ARC.md` in the Overview tab**) read from
disk via the P1/P2 folder reader, **suppressing `plan.json` + `.gitkeep`**, and gains a **persistent
intent-lifecycle strip** consuming P2L's `plan:intents:list`. Overviews (P4C) and comments (P4D-*/P4E) are
**kept intact**, re-keyed to `PlanTabKey`, with folder-doc comment identity made durable (Δ below).

**Stage non-goals:** no live mission board (P5/P6); no editing the underlying folder markdowns from this pane
(comments only); no HTML plan rendering path; **no re-implementation of folder enumeration/containment**
(reuse WP-P1A `planning-reader:*`); **no new DB schema**; **no forward dependency on P5 / Save-card Stage ③.**
**Stage user-visible acceptance:** a promoted plan opens as a **tabbed** document home whose tabs mirror the
folder (`overview` renders the supervisor overview + `ARC.md`; `plan` renders `plan.md`; `deliberations` /
`research` / `supplements` list their subdir docs; `proposal`; `legacy-html`); `plan.json` and `.gitkeep`
never appear; each populated tab leads with a plain-language overview (or "overview pending"); a **persistent
intent-lifecycle strip** shows marked → ran → returned → folded-in per intent from the ledger, rendering an
**unfolded deliberation as OPEN, never silently complete** (ruling 12); comments can be left/answered at any
lifecycle stage and reach the responsible supervisor. **Gate check:** Edward's scattered-md pain resolved (all
folder artifacts in one place); a resumed agent orients from **one bounded context read**.

### WP-P4A — folder-native tab-model projection IPC (reuses planning-reader; ARC→overview; suppresses plan.json/.gitkeep)
- **Files:** `src/main/plans/plan-documents.ts` (rework projection); IPC `plan:documents` in `plan-ipc.ts`;
  consumes WP-P1A `planning-reader:list` / `planning-reader:read`; `src/shared/types.ts` (adds `PlanTabKey`
  + the tab-model DTO with a per-tab `populated` flag); test `plan-documents.test.ts`.
- **Dep:** WP-P3A, WP-P3B (registry row + `folder_rel_path`), **WP-P1A** (folder manifest + safe-read-by-manifest-ID),
  WP-P2B-folder (adopted `plans.folder_rel_path`). **Declared dep set is exactly `{WP-P3A, WP-P3B, WP-P1A,
  WP-P2B-folder}` — no P5 / SC-WP-3A forward dependency.**
- **Do:** for a `plan_id`, resolve `plans.folder_rel_path` and build the tab model by **unioning two sources**:
  1. the **folder manifest** from `planning-reader:list` scoped to that folder, mapped per the normative
     folder→tab table — **`ARC.md → overview` document**, `plan.md → plan`, `deliberations/* → deliberations`,
     `research/* → research`, `supplements/* → supplements` — each doc carrying its **opaque server-issued
     manifest doc ID** (no raw absolute path leaves main);
  2. `plan_documents` for the external `proposal` (still at `.lares/proposals/<slug>.md`) and any `legacy-html`.
  **Suppress `plan.json` + all `.gitkeep`** (assert here even though WP-P1A already omits them from the manifest).
  **Defense-in-depth membership check:** bind each returned manifest doc to the **requested plan's current
  `folder_rel_path`** (reject a manifest doc that does not resolve inside it) — but **do not implement another
  walker / realpath policy**; containment / symlink-rejection / caps remain WP-P1A's. **Body fetch preserves
  both guards:** folder-doc bodies fetched **only by manifest ID via `planning-reader:read`** (WP-P1A enforces
  folder containment / symlink rejection / caps); external/legacy bodies via the existing `plan_documents`
  server-side path-resolution guard (workspace containment + allowed roots `.lares/proposals/…`,
  `.lares/proposals/supporting/`, `.lares/research/cleared/`, `.lares/plans/legacy/` + byte cap). An
  unregistered renderer-supplied path is rejected on both paths.
  **Per-tab `populated` flag:** true when the tab has ≥1 real document/overview. The synthetic **Packages
  placeholder ("not yet implemented — pull Implement to begin") is `populated:false`**; Packages becomes
  `populated:true` **only when actual `plan_work_packages` rows exist** for the plan. That count is read
  through an **optional capability/accessor with guarded table detection** — if `plan_work_packages`
  (SC-WP-3A) **does not yet exist**, the accessor returns `populated:false` **without throwing and without
  importing any P5/SC-③ module** (detection by guarded `sqlite_master` probe or an injected optional accessor).
  Missing folder / late `plan.md` / deleted output degrade to an empty tab (WP-P1A re-enumerates; absent → empty).
- **Accept:** tab model reflects the live folder with **`ARC.md` in overview** and `plan.md` in `plan`, plus
  external `proposal` + `legacy-html`; `plan.json` + `.gitkeep` never appear in any tab; each manifest doc is
  membership-checked against the plan's current `folder_rel_path`; folder docs readable only by manifest ID
  (unregistered path rejected); external/legacy enforce containment + roots + cap; on-disk add/remove reflected
  on re-list; Packages placeholder `populated:false` **with `plan_work_packages` absent (no throw, no P5 import)**
  and `populated:true` only with real package rows; missing docs degrade gracefully.
- **Non-goals:** no overview *content* (P4C); no board (P5/P6); no second walker / containment impl; no folder
  write; no P5/SC-③ forward dependency.
- **Verify:** main/shared template (fixtures: ARC→overview mapping; plan.json/.gitkeep suppression; cross-folder
  manifest doc rejected by membership check; external+legacy union; deleted deliberation → empty tab;
  `plan_work_packages` absent → Packages `populated:false` no-throw; present-with-rows → `true`).

### WP-P4C-backend — per-tab overview accessors + IPC (keyed to `PlanTabKey`)
- **Files:** `plan_tab_overviews` accessors in `database.ts`; IPC `plan:getOverview` / `plan:setOverview`
  (supervisor-privileged) in `plan-ipc.ts`; test `plan-overview.test.ts`.
- **Dep:** WP-P3A, WP-P4A.
- **Do:** stored, **supervisor-authored** overviews per tab, revisioned, keyed by the stable `PlanTabKey`
  domain. Read + write (write via `hasSupervisorPrivilege`). No schema change (P3A's `plan_tab_overviews(plan_id,
  tab, …)` already keys on a free-text `tab`). `ARC.md` is the `overview` tab's *document*; the supervisor
  overview row exists independently on the `overview` key (a plain-language summary rendered above the ARC).
- **Accept:** get/set round-trips on the folder-native `PlanTabKey` keys; revision bumps; write privileged.
- **Non-goals:** no editor UI; no renderer; no schema change.
- **Verify:** main/shared template.

### WP-P4B — tabbed PlanSurface renderer (folder-native document home; ARC in Overview)
- **Files:** `src/renderer/components/plan/PlanSurfaceContainer.tsx` + `PlanSurfaceView.tsx`; reuse
  `ProposalReader.tsx` + the WP-P1B folder view; `src/preload/index.ts`; test `PlanSurfaceView.tabs.test.tsx`.
- **Dep:** WP-P4A, WP-P4C-backend.
- **Do:** render the document home as **tabs, never one giant scroll** (Amendment 1b), tabs = the `PlanTabKey`
  set. **Overview tab leads with the supervisor overview then renders `ARC.md`**; Plan tab renders `plan.md`;
  Deliberations / Research / Supplements render a **sibling list** of that subdir's docs (opened read-only by
  manifest ID via `planning-reader:read`, reusing the WP-P1B folder view). Each tab leads with its overview then
  the full document(s); a populated tab with no overview shows **"overview pending"**; default tab = `overview`.
  **`plan.json` / `.gitkeep` never render** (WP-P4A omits them; the renderer exposes no raw-manifest affordance
  to reach them). Empty subdir → "no documents yet".
- **Accept:** ARC renders in Overview; tabs switch on stable keys; subdirs render as read-only manifest-ID lists;
  overview-then-doc layout; "overview pending" on a populated tab without a supervisor overview; no plan.json/.gitkeep
  surface; no endless scroll.
- **Non-goals:** no overview editing (P4C-editor); no comments (P4E); no intent strip (WP-P4F); no folder write.
- **Verify:** renderer Vitest template.

### WP-P4C-editor — per-tab overview editor
- **Files:** overview editor in `PlanSurfaceView.tsx`; test.
- **Dep:** WP-P4B, WP-P4C-backend.
- **Do:** in-place per-tab overview editor (privileged) calling `plan:setOverview`, keyed to `PlanTabKey`;
  **Mark Ready (P5B) requires an overview for every *populated* tab** — the Packages placeholder is
  `populated:false` (WP-P4A) and therefore never forces a spurious overview.
- **Accept:** a supervisor writes/edits an overview per tab; it renders above the docs; the empty Packages
  placeholder does not require an overview.
- **Non-goals:** no auto-generation; no worker write.
- **Verify:** renderer Vitest template.

### WP-P4F — intent-lifecycle strip (persistent, expandable; consumes `plan:intents:list`)
- **Files:** new `src/renderer/components/plan/IntentLifecycleStrip.tsx` mounted as a **persistent compact strip
  above the tab body** in `PlanSurfaceView.tsx` (not a document tab); `src/preload/index.ts`; test
  `IntentLifecycleStrip.test.tsx`.
- **Dep:** **WP-P2L-proj** (`plan:intents:list`), WP-P4A (manifest, for deep-link cross-index), WP-P4B.
- **Do:** consume the **existing** P2L projection IPC `plan:intents:list` (do **not** mint a channel; do **not**
  extend P2L) and render a **compact strip** listing each intent's rung (**marked → ran → returned →
  folded-in**), **expanding in place to per-output detail** (present/missing, disposition, `folded_in`,
  integration note) — **one UI shape, no separate tab.** Each result listed **independently** so one folded
  rerun never hides another pending result (§R1); an **unfolded present `active` output → OPEN, never silently
  complete** (ruling 12); withdrawn/superseded surfaced; `ran` from the ledger orchestration join (a running
  groupthink shows "in service of *this* marked part"), else **"ran: unavailable"** (never a self-declared
  orchestration ID as authority); the P2L **derived** confidence/compute readout (ruling 14) shown, **derived,
  never self-asserted.** **Deep-link:** the P4 container **cross-indexes each ledger `output_rel_path` (a rel
  path, not a manifest ID) against the current WP-P4A manifest** and opens the resulting **manifest ID** in the
  matching tab. An output that is **missing / history-only** (no current manifest match) stays **visible but
  non-clickable.**
- **Accept:** the compact strip expands to per-output detail; independent rows; unfolded → open; withdrawn/
  superseded surfaced; `ran: unavailable` pre-ledger; confidence derived not asserted; a present output
  deep-links via manifest cross-index; a history-only output is visible but non-clickable; no P2L change.
- **Non-goals:** no ledger mutation; no new IPC; no run dispatch; no completion inference.
- **Verify:** renderer Vitest template.

### WP-P4D-create — plan-comment create + routing (durable logical-key identity; plan-aware send)
- **Files:** `src/main/plans/plan-comments.ts` (create service); IPC `plan:comment:create`; reuse
  `createSelectionComment` + the existing send/notification path (`comments:send` in `ipc-handlers.ts`) via a
  plan-aware adapter; test `plan-comment-create.test.ts`.
- **Dep:** WP-P3B (plan + folder), WP-P4A.
- **Do:** server-side create. **Validate the target document belongs to the plan** — accept **either** a
  registered `plan_documents` row **or** a **folder-manifest doc ID under the plan's `folder_rel_path`**
  (containment-validated via the WP-P1A manifest — no raw renderer path). Select the current
  `responsible_supervisor_id` server-side, set `sent_to_agent_id`, invoke the send/notification path. **The
  renderer supplies neither recipient nor arbitrary file** — only `plan_id` + a document ref + body.

  **Durable folder-doc comment identity (no DDL).** `selection_comments` exposes only `file_path` /
  `path_type` / `root_directory` and this rescope adds no DDL, so a folder target is encoded as a **versioned
  logical key stored in `file_path`**:
  ```
  lares-plan-doc:v1:<base64url( canonical-json )>
     canonical-json = {"doc_rel_path_within_folder":"deliberations/2026-08-01-attr.md","plan_artifact_id":"plan_<hex>"}
  ```
  Canonical JSON = **sorted keys, no insignificant whitespace, UTF-8**; `base64url` **without padding**; the
  `v1:` version segment enables a future migration without ambiguity. Server-side: **canonicalize the
  manifest-resolved rel path** (normalize separators to `/`, reject `..` / absolute / mixed-separator,
  **containment-validate against the plan's current folder**), then encode `{plan_artifact_id,
  doc_rel_path_within_folder}` and store the key in `file_path`. **`plan_artifact_id` (R0 durable identity) is
  the identity — never `folder_rel_path` / SKU / the opaque manifest ID.** For a logical plan target, set
  **`path_type = NULL` and `root_directory = NULL`** (`PathType` is `'windows' | 'wsl'` — no out-of-domain
  sentinel; an invalid `path_type` could reach path-conversion code). **The exact `lares-plan-doc:v1:` prefix
  is the sole logical-target discriminator.** External `plan_documents` targets keep their ordinary
  `file_path` / `path_type` / `root_directory` unchanged.

  **Plan-aware send/notification adapter.** For a `lares-plan-doc:*` target the send path passes a **cloned
  comment with the logical key resolved to the current physical path** for prompt/display purposes **without
  mutating the stored row**. If resolution fails, it sends/displays the item **explicitly as an orphaned
  plan-document target**, not a bare path.
- **Accept:** create validates plan membership for both sources; a folder-doc comment persists
  `lares-plan-doc:v1:<…>` in `file_path` over a canonicalized, containment-validated rel path with **`path_type`
  and `root_directory` NULL**; `plan_artifact_id` is the durable identity (no `folder_rel_path` / SKU /
  manifest ID stored); recipient = current responsible supervisor; renderer cannot inject recipient / file / key;
  external-doc rows unchanged; the send adapter shows the resolved physical path while the stored row keeps the
  logical key, and surfaces resolution failure as an explicit orphaned-plan-doc target.
- **Non-goals:** no reply storage (P4D-reply); no listing (P4D-proj); no DDL; no `path_type` sentinel.
- **Verify:** main/shared template (round-trip encode/decode; canonicalization + containment rejection; NULL
  `path_type`/`root_directory`; send-adapter resolve-without-mutation + orphaned-on-failure).

### WP-P4D-reply — companion replies table + answer tool ⟨DDL — existing A2 `P4D-reply` slot⟩
*Unchanged from the parent plan.* `selection_comment_replies(id TEXT PRIMARY KEY, comment_id TEXT NOT NULL
REFERENCES selection_comments(id), body TEXT NOT NULL, author_agent_id TEXT, created_at INTEGER NOT NULL)`;
agent-callable `answer_plan_comment(comment_id, body)` validating the caller is the plan's responsible
supervisor; companion row, never overwrites `selection_comments.body` / its status machine.

### WP-P4D-proj — plan-comment projection (dual-source membership; logical-key resolution)
- **Files:** `plan-comments.ts` (list); IPC `plan:comment:list`; test `plan-comment-list.test.ts`.
- **Dep:** WP-P4D-create, WP-P4D-reply, WP-P4A.
- **Do:** list `selection_comments` for the plan **across both membership sources** — the plan's linked
  `plan_documents` **and** the plan's **folder-doc comments** (identified by the `lares-plan-doc:v1:` prefix in
  `file_path`) — joined with `selection_comment_replies` threads. For folder-doc comments, **query/parse only
  the exact `lares-plan-doc:v1:` versioned form**; decode → resolve `{plan_artifact_id → current
  folder_rel_path}` + join `doc_rel_path_within_folder` → re-validate containment against the **current** plan
  folder. **A malformed / undecodable / unknown-version `lares-plan-doc:*` key is treated as an orphaned
  plan-document target — never as a filesystem path, and never falls through to filesystem handling.** A **plan
  folder rename** leaves `plan_artifact_id` + `doc_rel_path_within_folder` intact → **comments stay attached;**
  an **individual document rename/removal** (the rel-path no longer resolves) renders as an **orphaned-target
  thread**, never silently dropped.
- **Accept:** comments on both `plan_documents` and folder-doc logical targets are listed with threaded replies;
  logical keys parsed only in the `v1:` form and resolved through the current folder; a malformed/unknown-version
  key → orphaned (not filesystem); **folder-rename fixture: folder-doc comments remain attached;**
  individual-document-rename fixture → orphaned thread; **compatibility fixture: ordinary file comments (plain
  `file_path`) list and render exactly as before.**
- **Non-goals:** no create/reply mutation; no manifest-ID / path persistence.
- **Verify:** main/shared template (dual-source listing; folder-rename-survives; doc-rename-orphan;
  malformed/unknown-version-orphan; ordinary-file-comment-unchanged).

### WP-P4E — comments renderer rail
*Unchanged from the parent plan.* Render question/answer threads (correlated via
`selection_comment_replies.comment_id`), a compose box (calls `plan:comment:create`), across all lifecycle
states (hardened ≠ frozen — Amendment 1b-ii). Orphaned-target threads render as such.

**Guard clause — generic filesystem comment lookup.** Any generic filesystem comment lookup (e.g.
`listSelectionComments` by OS path, `read-comments` consumers, path-conversion code) **must not interpret
`lares-plan-doc:*` as an OS path** — logical-target rows are excluded from filesystem-path matching and
`path_type` conversion, and surface only through the plan-comment projection. **Verify:** a fixture asserts a
`lares-plan-doc:*` row is never returned by an OS-path query and is never stat-ed / path-converted.

**Integration gate P4Z:** register new/changed P4 main tests (`plan-documents`, `plan-overview`,
`plan-comment-create`, `plan-comment-list`); `npm run test:supervisor`; P4 renderer Vitest
(`PlanSurfaceView.tabs`, `IntentLifecycleStrip`, comments rail); `npm run build`.

**Stage P4 graph:**
`WP-P4A → {WP-P4C-backend → WP-P4B → {WP-P4C-editor, WP-P4F}, WP-P4D-create → WP-P4D-reply → WP-P4D-proj → WP-P4E} → P4Z`
(WP-P4F additionally deps WP-P2L-proj; WP-P4D-proj additionally deps WP-P4A).

---

## STAGE P7 (rewritten in place) — durable evidence surfaces + Amendment-18 altitude ladder

**Rewrite premise (rulings 18, 19, 22).** Every blame/evidence read comes from **durable stores**:
turn/dispatch stamps (`turn_records.plan_id / plan_item_id / plan_stamp_source`, SC-WP-2A/2B), commit records +
trailers (`commit_records` / `commit_turn_links` + `Lares-Turns` / `Lares-Plan`, bundle contract §8–9;
**spoofed external trailers = untrusted**), server-witnessed **orchestration links**
(`orchestrations.planning_intent_id`, WP-P2L-runs), the **intent ledger** (`plan_intents` /
`plan_intent_outputs`), **`plan.json` responsibility history** (§R0), and **ARC** (§R2). **Checkpoints are
demoted to an optional recent-history enrichment ONLY — never the sole source of any tier** (ruling 19). The
whole stage is shaped as the **altitude ladder** (ruling 18), split into **acyclic** WPs with **no runtime
tier-4 pointer in the low-tier service.**

**Altitude ladder — the shape of P7's read surface (normative):**

| Tier | Name | Source (all durable; zero-checkpoint) | Cost |
|---|---|---|---|
| **1** | **ARC** | `ARC.md` read **from disk** (§R2), via the bound folder manifest / document ID — zero DB | cheapest, the entry point |
| **2** | **Ledger + responsibility** | `plan_intents` / `plan_intent_outputs` + `orchestrations.planning_intent_id` join (P2L) + `plan.json.responsibility_events` (§R0) enriched by `plans.responsible_supervisor_id` | cheap |
| **3** | **Files-touched + commit activity** | plan-stamped `turn_records` (SC-WP-2A/2B) + distilled `diff_stats` / `compact_diff` from `retention.ts` + `commit_records` / `commit_turn_links` + contract trailers (§8–9) + `recovery_operations` | mid |
| **4** | **Diffs** | active: baseline-to-current review diff + embedded SC `SelectionPreview` / `CommitCandidate`; archived: baseline + trusted plan-linked per-commit diffs | deepest, never the entry point |

**Checkpoint rule (all tiers).** A live checkpoint (`checkpoint.diff` / `fileHistory`, `git-checkpoints`) may
**enrich tier 3/4 recent history** (click-through, recent turn diffs) but **its absence never blanks a tier** —
every tier answers fully from the durable stores above when checkpoints are GC'd. No tier reads a checkpoint as
its sole source.

**Stage non-goals:** no exact line-authorship claims; no "clobber" without mechanical byte proof; no automatic
dispatch blocks; no second candidate id; **no tier that hard-depends on checkpoints**; no new DDL.
**Stage user-visible acceptance:** an agent or the UI grasps a plan's whole arc **cheaply from tier 1 (ARC)**
and drills down tier-by-tier; the plan-review projection (tier 4) is the primary review object with honest
mixed-authorship / capture-gap annotations off the pinned baseline; contention advises before dispatch without
blocking; blame-to-intent answers path→plan/intent/supervisor with a confidence label from durable stores — no
overclaim. **A spoofed external commit bearing forged `Lares-*` trailers yields NO durable attribution
linkage** (§R-ATTR). **Gate check:** every tier renders for a plan whose checkpoints have been pruned
(durable-only fixture); tier-4 candidate/bundle membership audited against raw `git status --porcelain=v2 -z`.

### WP-P7-ladder-low — ladder DTO + tier 1 ARC (zero-DB) + tier 2 composition
- **Files:** new `src/main/plans/plan-evidence-ladder.ts` (shared `EvidenceLadder` DTO + tier 1 / tier 2); IPC
  `plan:evidence:arc` (tier 1) + `plan:evidence:responsibility` (tier 2 responsibility) in `plan-ipc.ts`;
  tier 2 ledger **reuses `plan:intents:list`** (P2L); a bounded read-only `source_cutoff_mtime` accessor added
  to `src/main/plans/planning-reader.ts`; `src/shared/types.ts`; test `plan-evidence-ladder-low.test.ts`.
- **Dep:** **WP-P1A** (folder manifest / read-by-manifest-ID + the cutoff accessor's internals), **WP-P2L-proj**
  (ledger), WP-P2L-runs (orchestration join, surfaced by P2L-proj), §R0 `plan.json`, §R2 ARC.
- **Do:**
  - **Tier 1 (`plan:evidence:arc`) — truly zero-DB, per §R2.** The **ARC body and its disk cutoff are read
    solely from the already-bound folder manifest / document ID** (the caller passes the plan's ARC manifest
    doc ID obtained from WP-P4A / WP-P1A; tier 1 does **not** resolve a `plan_id` against the registry).
    **Source-cutoff seam:** because WP-P1A suppresses `plan.json` from the *document* manifest, tier 1 obtains
    the R2 source cutoff from a **read-only `source_cutoff_mtime` accessor computed by the existing
    planning-reader internals** (a bounded accessor **reusing the folder enumeration WP-P1A already performs —
    no second walker, and `plan.json` is NOT exposed as a document**): it returns the **guarded max mtime over
    exactly `plan.md`, the R1 output artifacts (`deliberations/*`, `research/*`, `supplements/*`), and
    `plan.json` — excluding `ARC.md` itself** (§R2). Tier 1 compares the ARC's `ARC-META.last_refreshed_at`
    against this cutoff **with zero DB access** and **remains readable when the DB is unavailable.** **Ledger
    freshness is an *optional tier-2 enrichment*** — a stale-vs-ledger flag is added **only when tier 2 is also
    requested.**
  - **Tier 2 (`plan:intents:list` + `plan:evidence:responsibility`).** Ledger rungs / confidence from P2L
    **plus** the responsible-supervisor history read **bounded from `plan.json.responsibility_events`** (current
    responsible = the last `assigned` event; the append-only history is preserved) enriched by
    `plans.responsible_supervisor_id`. No copied run-state.
  - The DTO defines all four tiers structurally, but this service **implements only tiers 1–2 and holds no
    runtime pointer to tier 4** (tiers 3/4 are separate services the UI composes).
  - **Scope guard:** the `source_cutoff_mtime` accessor is an **additive read-only accessor** on planning-reader
    computing a cutoff from internals it already enumerates — it **does not reopen P1's document-manifest
    contract, expose `plan.json` as a document, or change P0–P2 behavior.**
- **Accept:** tier 1 reads ARC + disk cutoff **only** from the bound manifest doc + the cutoff accessor;
  `source_cutoff_mtime` covers exactly `{plan.md, deliberations/*, research/*, supplements/*, plan.json}` and
  **excludes `ARC.md`**, computed **without a second walker** and **without surfacing `plan.json` as a readable
  document**; tier 1 renders **with the DB unavailable** and adds a ledger-staleness flag **only** when tier 2
  is requested; tier 2 = ledger + `plan.json` responsibility (current-responsible + preserved history); **no
  tier-4 pointer.**
- **Non-goals:** no tier-3 trail; no trailer classifier; no diffs; no DB read in tier 1.
- **Verify:** main/shared template (ARC-from-manifest with DB down; cutoff set membership incl. `ARC.md`
  excluded and `plan.json` in the cutoff but not the document manifest; tier-2 responsibility current + history).

### WP-P7-trail — tier 3 durable turn/commit activity + the single trusted-commit classifier seam
- **Files:** new `src/main/plans/plan-evidence-trail.ts` (tier 3) **+ the one server-side trusted-commit
  classifier** `src/main/plans/lares-commit-trust.ts`; IPC `plan:evidence:trail`; `src/shared/types.ts`; tests
  `plan-evidence-trail.test.ts`, `lares-commit-trust.test.ts`.
- **Dep:** **WP-SEP** (durable trail: distilled `diff_stats` / `compact_diff` from `retention.ts`,
  `recovery_operations`), `SC-WP-2A` / `SC-WP-2B` / `SC-WP-2I` (turn stamps + attribution), `SC-WP-2G` (commit
  records / blame), bundle contract §8–9.
- **Do:**
  - **Tier 3 durable trail.** WP-SEP's accepted-turn projection joined with `commit_records` /
    `commit_turn_links` + contract trailers; unstamped / unverified turns annotated via `plan_stamp_source`.
    **Checkpoints enrich recent history only; their absence never empties the tier.**
  - **The single trailer-trust classifier (implemented ONCE here).** `classifyLaresCommit(commitRef | record)`
    identifies a **server-created Lares commit** via bundle contract **§9.4** (attempt / reflog
    identification) **reconciled with the immutable candidate snapshot + commit ledger**, returning a trust
    verdict `{ trusted: bool, relation: 'authoritative' | 'metadata_only' }`. **Identically-named `Lares-*`
    trailers on an external commit are always `metadata_only` and create no attribution links.** **WP-P7A-proj
    and WP-P7C consume this accessor — they do NOT re-implement §9.4.**
- **Accept:** tier 3 renders from durable stores **with checkpoints pruned** and annotates unstamped turns;
  `classifyLaresCommit` returns `authoritative` only for a §9.4-identified, ledger-reconciled Lares commit; a
  **spoofed external commit's forged `Lares-*` trailers classify `metadata_only` → no links**; the classifier
  has exactly one implementation (consumers import it).
- **Non-goals:** no tier-4 diffs; no checkpoint-only trail; no duplicate trust logic.
- **Verify:** main/shared template (durable-only trail; spoofed-trailer `metadata_only`; classifier single-impl).

### WP-P7A-proj — tier 4 review projection (discriminated active / archived; durable-sourced)
- **Files:** `src/main/plans/plan-review-projection.ts` (+test).
- **Dep:** `SC-WP-1G`, `SC-WP-3G`, `SC-WP-2I`, WP-P5C (baseline ref — consumed by name; P5 body untouched),
  **WP-P7-trail** (durable annotations + `classifyLaresCommit`), WP-SEP.
- **Do:** produce the **`PlanReviewProjection`** — **NOT a second candidate model** — as a **discriminated
  union on `mode`**:
  - **`mode:'active'`** — **baseline-to-current** review diff over plan-witnessed paths (baseline =
    `plan_execution_runs.baseline_ref` / unborn) + the **embedded unchanged SC `SelectionPreview` /
    `CommitCandidate`.** Parent behavior retained. **`SC-WP-3I` renders active mode only.**
  - **`mode:'archived'`** — **omits the current SC `CommitCandidate` / `SelectionPreview` entirely** (rendering
    today's candidate would contaminate historical review). Uses a **historical diff renderer over trusted
    plan-linked commits** (`commit_turn_links` / `commit_records`, each `classifyLaresCommit`-trusted), rendering
    **per-commit diffs** as the historical result. **Accepted-but-uncommitted** work of that run exposes the
    **retained compact evidence** (distilled `diff_stats` / `compact_diff`) with an **explicit raw-diff gap** —
    **never reconstructed from checkpoints, and never from later HEAD / worktree state.** **Missing / GC'd
    historical commit objects yield an explicit raw-diff integrity gap, never blank or failure.** The archived
    reader **must not attribute unrelated later changes on the same paths to the old plan** (attribution is
    confined to trusted plan-linked commits + stamped turns of that run).
  - **Mixed-plan commits (both modes):** show the **complete commit with a mixed-plan annotation and identify the
    plan-linked turns / paths** — **do not imply the whole commit belongs exclusively to this plan, and do not
    carve it into a new candidate** (contract D-1; only the embedded SC object, active mode, carries a
    `candidateId`). Never compute another candidate id; never split a cross-plan component.
- **Accept:** the projection is a `mode`-discriminated union; **archived mode contains no current SC candidate /
  preview**; `SC-WP-3I` is active-only; archived renders trusted per-commit diffs; accepted-uncommitted →
  compact evidence + explicit raw-diff gap; a GC'd historical commit → explicit raw-diff gap (not blank /
  failure); a mixed-plan commit shows complete-with-annotation + plan-linked turns / paths, never an exclusive
  claim or a new candidate; later same-path changes are **not** attributed to an archived plan; only the SC
  object has an id.
- **Non-goals:** no new candidate model / id; no auto-commit; no baseline-to-**current** for archived runs; no
  checkpoint / later-HEAD reconstruction.
- **Verify:** main/shared template (active-mode parity; archived omits SC candidate; archived trusted per-commit
  diffs; unrelated-later-change-not-attributed; accepted-uncommitted raw-diff-gap; GC'd-commit raw-diff-gap;
  mixed-plan-commit annotation).

### WP-P7A-ui — ladder review renderer (composes independent tier endpoints, ARC-first)
- **Files:** plan-lens review view in `PlanSurfaceView.tsx`; reuse `SC-WP-3I` preview; `src/preload/index.ts`;
  test.
- **Dep:** WP-P7-ladder-low, WP-P7-trail, WP-P7A-proj, `SC-WP-3H`, `SC-WP-3I`.
- **Do:** compose the **independently callable tier endpoints** top-down: **tier 1 ARC** (entry point) → tier 2
  ledger + responsibility → tier 3 trail → on explicit drill-down **tier 4** review. Render `SC-WP-3I` for
  `mode:'active'`; render the **historical per-commit diff view** for `mode:'archived'` (no SC candidate). Diffs
  are the deepest tier, never the entry point (ruling 18); the stale-ARC flag is surfaced, not hidden; the
  compact archive-integrity warning (WP-P8-archive-durability) renders in the archived view.
- **Accept:** ARC renders first from tier 1; tiers expand on demand from their own endpoints; SC preview reused
  at tier 4 active mode; archived mode renders per-commit diffs without an SC candidate; diffs never the default;
  stale-ARC flag shown; no topology recompute.
- **Non-goals:** no commit here (P6D); no diff-first layout.
- **Verify:** renderer Vitest template.

### WP-P7B — pre-dispatch contention advisories
- **Files:** new `src/main/git-checkpoints/contention-model.ts` (+test).
- **Dep:** WP-P5A-paths (consumed by name), WP-P7-trail (tier-3 durable `turn_records.touched`).
- **Do:** build a rolling path-contention graph from **recent `turn_records.touched`** (a durable store, a
  tier-3 input, **not** a checkpoint); **map planned workspace-relative paths through the workspace prefix into
  repository-relative encoded `pathBytesBase64` before comparison** (two workspaces cannot collide on
  `src/foo.ts`; linked worktrees are not conflated); warn when a package's planned paths overlap active / recent
  turns. **Advisory only, never an automatic block; never hunk-level.** The "recent" window is bounded and its
  absence degrades gracefully — a pruned window yields fewer advisories, never an error.
- **Accept:** the overlap advisory fires from repo-normalized planned paths off durable turn stamps; never
  blocks; cross-workspace collisions avoided; empty recent window → no crash.
- **Non-goals:** no blocking; no hunk attribution; no checkpoint dependency.
- **Verify:** main/shared template.

### WP-P7C — blame-to-intent from the durable record (path-level)
- **Files:** new `src/main/plans/blame-to-intent.ts` (rewrite; +test); IPC + an attribution-view hook.
- **Dep:** WP-P7-ladder-low (tier 2), **WP-P7-trail** (tier 3 + `classifyLaresCommit`), WP-P2L-runs
  (orchestration links), §R0 `plan.json` responsibility, `SC-WP-2A` / `SC-WP-2B`, `SC-WP-2G`.
- **Do:** a **path-level API** `blameToIntent(path)`: return contributing **turns → plans → intents →
  responsible supervisor** with a **confidence label** + a conflicting-contributor list — framed "these plans /
  turns / intents contributed," never "authored this line." An **optional selection / hunk may narrow the
  *presentation*** but **cannot increase attribution confidence or imply hunk authorship** (file / path level is
  the ceiling). **Durable-first read order:**
  1. plan-stamped `turn_records` (SC-WP-2A/2B) and `commit_turn_links` / `commit_records` + **trailers via
     `classifyLaresCommit`** (consume WP-P7-trail's single classifier — do **not** re-implement §9.4) for
     committed work;
  2. `orchestrations.planning_intent_id` to attribute a contribution to a **marked intent** (WP-P2L-runs;
     server-witnessed, never self-declared);
  3. `plan.json.responsibility_events` for **who was responsible when the work happened** — **mechanically: the
     last `assigned` event whose `at` timestamp is ≤ the contributing turn / commit timestamp.** If no `assigned`
     event is at-or-before that timestamp, return **`unknown`** — **never backfill from the current DB owner**
     (`plans.responsible_supervisor_id`) and never from a later `assigned` event. Resolution is per-contribution
     (different contributions in one result may resolve to different supervisors across a reassignment).
  **Checkpoints are an optional recent-history enrichment only, never the sole source** (ruling 19). **Trailer
  trust (§R-ATTR):** only a **server-identified Lares commit's** `Lares-Turns` / `Lares-Plan` trailers
  (reconciled with the candidate snapshot + commit ledger, bundle §9.4, via `classifyLaresCommit`) are
  authoritative; **forged `Lares-*` trailers on an external commit are untrusted hints and manufacture no
  linkage.** *(These trailers are the ones the shared composer emits at P6D / Save-card Stage ④ per §R-ATTR —
  consumed here; P6D body untouched. Agent attribution needs no new trailer — it is recoverable via
  trailer-linked turns + `commit_turn_links`; `Lares-Agent` is explicitly NOT a v3 trailer.)* File / path level
  is v1; exact line provenance stays out; mixed-path commits support only commit-level attribution.
- **Accept:** **path-level** path→turns→plans→intents→responsible-supervisor with confidence + conflicts from
  durable stores; an optional hunk narrows presentation only (no confidence bump, no hunk-authorship claim);
  works with checkpoints pruned; **forged external `Lares-*` trailers yield no linkage** (via `classifyLaresCommit`
  `metadata_only`); intent link from `planning_intent_id` only; **responsible-at-work-time = last `assigned` at
  ≤ contribution ts, else `unknown`, never current-owner backfill**; no exact-line / clobber overclaim; no §9.4
  re-implementation.
- **Non-goals:** no exact line / hunk authorship; no clobber labels; no §9.4 re-implementation; no new trailer.
- **Verify:** main/shared template (durable-only attribution; spoofed-trailer no-link; intent-via-`planning_intent_id`;
  **temporal-responsibility boundary** (turn exactly at an `assigned.at` resolves to that assignment),
  **reassignment** (before → prior supervisor, after → new), **pre-first-assignment → `unknown`**;
  hunk-narrows-presentation-only).

**Integration gate P7Z:** register P7 main tests (`plan-evidence-ladder-low`, `plan-evidence-trail`,
`lares-commit-trust`, `plan-review-projection`, `contention-model`, `blame-to-intent`); `npm run
test:supervisor`; P7 renderer Vitest; `npm run build`; **the checkpoints-pruned fixture passes for every tier**;
tier-4 candidate membership audited against raw `git status --porcelain=v2 -z`.

**Stage P7 graph:**
`{WP-P1A, WP-P2L-proj, WP-P2L-runs} → WP-P7-ladder-low`;
`{WP-SEP, SC-WP-2A/2B/2I/2G} → WP-P7-trail`;
`WP-P7-trail → {WP-P7A-proj → WP-P7A-ui, WP-P7C}` (WP-P7A-ui also deps WP-P7-ladder-low);
`{WP-P5A-paths, WP-P7-trail} → WP-P7B → P7Z`.

---

## STAGE P8 (amended) — legacy import + bespoke-provenance deletion + checkpoint-free folder archive

**What changes vs. parent P8:** the bespoke-provenance deletion sequence (WP-P8A–P8H) is **carried forward
unchanged in scope**, with two additions: (1) **§R-P8F** strengthens WP-P8F's drop-set to a positive,
exhaustive invariant; (2) **WP-P8-archive-durability** is added as a **retention / read-path integration +
regression-audit** WP that does **not** claim to enforce committing through the untouched P5 transition.

**Stage non-goals:** no deletion before import / parity; no global drop while any workspace with pending legacy
rows is unavailable; conservative importer (no fabricated packages); **no deletion of any non-bespoke plan
data** (§R-P8F); **no folder deletion on archive**; no new DDL beyond the parent's terminal P8F exception.
**Stage user-visible acceptance:** legacy HTML plans live in-place as structured boards preserving identity; the
HTML writer / one-writer lock / snapshot VCS / 5-rung resolver are deleted once the global readiness condition
holds; the surface renders from **DB rows + `turn_records` + the plan folder** alone with zero capability loss;
**an archived plan folder — even years later with all checkpoints GC'd — renders its full arc from `ARC.md`
(tier 1) + ledger / responsibility rows (tier 2) + commit records (tier 3) + archived-mode tier 4.**

### WP-P8A – WP-P8E, WP-P8G, WP-P8H (carried forward unchanged)
*Verbatim from the parent plan.* They retire the **legacy HTML** provenance stack (writer, 409 one-writer lock,
HTML watcher / reparse, render-pane / sanitizer / read-ladder, 5-rung resolver / PLAN-EVENT / touch /
materializer) and clean dead references. **Outside the retirement scope:** the folder-per-plan reader
(WP-P1A/P1B), the folder watcher (WP-P2B-folder), the intent ledger (P2L), `plan.json` / ARC, and all
durable-evidence stores.

### §R-P8F — WP-P8F drop-set invariant (constraint + strengthened acceptance; NOT a standalone WP)
- **Applies to:** WP-P8F (the A2 terminal `DROP TABLE IF EXISTS` exception) — **unchanged mechanism and A2
  position; no new migration / node.**
- **Invariant (positive, exhaustive).** The readiness-gated repeatable migration **drops exactly the six named
  bespoke tables** — `plan_snapshots`, `plan_snapshot_blobs`, `plan_section_touches`, `plan_section_changes`,
  `plan_events`, `plan_sections` — **and no other persistent plan data.** Stated as an **exact-set equality**,
  not a durable-table allowlist (an allowlist could omit a table and let it be dropped).
- **Strengthened acceptance / test (added to WP-P8F).** After the migration runs, **the dropped set equals
  exactly those six tables**, and **every other persistent table and every plan-folder artifact is untouched** —
  asserted by snapshotting the table set (and folder contents) before / after and diffing to exactly the six.
  Registered with WP-P8F's existing ready / not-ready / unavailable-workspace fixtures.
- **Non-goals:** no change to the readiness-gate mechanism or the A2 terminal-exception status.

### WP-P8-archive-durability — checkpoint-free archive read-path integration + regression audit
- **Files:** new `src/main/plans/archive-durability.ts`; **IPC `plan:archive:integrity`** in `plan-ipc.ts`;
  `src/shared/types.ts` (integrity DTO); `src/preload/index.ts`; a **compact archive-integrity warning** in the
  archived P7 view (`PlanSurfaceView.tsx`, WP-P7A-ui); test `archive-durability.test.ts`.
- **Dep:** **P4Z, P7Z** (the completed P4 / P7 read surfaces — not merely WP-P4A + a partial ladder),
  WP-P5-archive (plan-level `→ archived` transition + run closure — **consumed by name; P5 body untouched**),
  §R0 / §R2.
- **Do:** integrate and **audit** the checkpoint-free archived-review path (rulings 19, 21) **without claiming
  to enforce commits through the untouched P5 transition:**
  1. **No-deletion + retention guarantee (what P8 *can* guarantee without P5 changes).** Archive is a state
     transition only (owned by WP-P5-archive); this WP asserts it **performs no deletion** and that **all
     committed folder content and durable rows remain retained** afterward. It does **not** claim a post-hoc
     reader made previously-uncommitted content durable.
  2. **Internal audit accessor (bounded; no persisted pre-archive inventory required).** With no persisted
     pre-archive inventory, the accessor **cannot** detect that arbitrary optional rows were later deleted; it
     checks what is mechanically verifiable **now** — **(a) mandatory artifacts present** (`plan.json`,
     `plan.md`, `ARC.md`); **(b) referential integrity / orphan checks** across the plan's row families;
     **(c) durable-store accessibility**; **(d) reported row counts** per family. It does **not** claim
     completeness of optional rows.
  3. **"Committed folder" defined mechanically.** The plan folder is *committed* iff **its canonical artifacts
     (`plan.json`, `plan.md`, `ARC.md`, and the `deliberations/` / `research/` / `supplements/` contents) are
     tracked in HEAD, have no tracked modifications, and there are no untracked plan artifacts under the
     folder.** A violation is reported as an **archive-integrity gap** (`folder-absent | untracked |
     tracked-modified`), never silently rendered as complete.
  4. **Transitive row families covered by the audit + the regression snapshot.** **registry / documents /
     overviews / comments** (`plans`, `plan_documents`, `plan_tab_overviews`, `selection_comments`,
     `selection_comment_replies`); **packages + lifecycle / finalization** (`plan_work_packages`,
     `plan_work_package_layout`, `plan_work_package_paths`, `plan_wp_lifecycle_events`, `package_finalizations`);
     **execution runs / dispatch / recovery** (`plan_execution_runs`, `plan_dispatch_attempts`,
     `recovery_operations`); **intents / outputs / orchestrations** (`plan_intents`, `plan_intent_outputs`,
     `orchestrations` + `planning_intent_id`); **turn / commit links** (`turn_records`, `commit_turn_links`,
     `commit_records`).
  5. **Checkpoint-free render path.** An archived plan renders its full arc via the ladder — tier 1 ARC from
     disk, tier 2 ledger + `plan.json` responsibility, tier 3 durable commit / turn trail, tier 4
     **archived-mode** review (WP-P7A-proj) — **invoking no checkpoint API as a required step.**
     **Missing / GC'd historical commit objects yield an explicit raw-diff integrity gap** (from WP-P7A-proj),
     surfaced as the compact warning — not blank, not failure.
  6. **Delivery path (user-visible).** The accessor is exposed via **`plan:archive:integrity`** → preload → a
     **compact warning banner in the archived P7 view**; when integrity holds, no banner.
- **Accept:** archiving performs no deletion and retains folder + durable rows (asserted); the accessor checks
  mandatory artifacts + referential integrity / orphans + store accessibility + counts (not optional-row
  completeness); "committed folder" evaluated by the mechanical HEAD-tracked / no-modifications / no-untracked
  definition; gaps (`folder-absent | untracked | tracked-modified`, orphan, inaccessible store, GC'd-commit
  raw-diff gap) surface via `plan:archive:integrity` and the archived-view banner; no false "complete" on a gap;
  the archived reader invokes no checkpoint API.
- **Verify (regression, end-to-end):** create a plan folder **and commit it**; snapshot **all plan-associated
  row identities across the families in (4)**; archive; **prune checkpoints**; **reopen from a fresh process /
  DB connection**; **render every tier (1–4, archived mode)** and assert the **before / after row-identity
  snapshot is equal** (proving archive deleted nothing). Separate fixtures: an **uncommitted / tracked-modified /
  untracked** folder → the corresponding integrity gap; a plan whose **historical commit object is GC'd** → an
  explicit raw-diff gap (not blank / failure).
- **Non-goals:** no folder / row deletion; no archive state-machine change (WP-P5-archive owns it); no claim to
  detect deletion of arbitrary optional rows absent a persisted inventory; no ladder re-implementation; no claim
  of enforcing commit durability post-hoc.

**Stage P8 graph:**
`WP-P8A → WP-P8B → (WP-P8C ∥ WP-P8D) → WP-P8E → WP-P8F[§R-P8F] → WP-P8G → WP-P8H`;
`P4Z + P7Z + WP-P5-archive → WP-P8-archive-durability` (independent of the retirement chain).
§R-P8F is a constraint on WP-P8F, not a separate node.

---

## Consolidated dependency graph (P4 / P7 / P8)

```
Tab keys (types.ts): overview|proposal|plan|deliberations|research|supplements|packages|legacy-html
  ARC.md→overview ; plan.md→plan ; deliberations/*→deliberations ; research/*→research ; supplements/*→supplements
  external proposal→proposal ; legacy-html ; plan.json + .gitkeep SUPPRESSED

P4:  WP-P4A(ARC→overview; membership-check; plan.json/.gitkeep suppressed; Packages populated:false w/ guarded
        plan_work_packages detection; deps {P3A,P3B,P1A,P2B-folder} only — NO P5/SC-③ forward dep)
       → {P4C-backend → P4B(ARC in Overview) → {P4C-editor, P4F(persistent expandable strip; rel_path→manifest cross-index)},
          P4D-create(logical key lares-plan-doc:v1:<b64url json{plan_artifact_id,doc_rel_path_within_folder}> in file_path;
                     path_type=NULL, root_directory=NULL; plan-aware send adapter)
            → P4D-reply → P4D-proj(dual-source; v1-only parse; resolve via current folder; malformed→orphaned) → P4E} → P4Z
       Guard: generic fs lookup never treats lares-plan-doc:* as an OS path.

P7 (split, acyclic — NO tier-4 pointer in low service):
  {WP-P1A, P2L-proj, P2L-runs} → WP-P7-ladder-low (DTO + tier1 ARC zero-DB via bound manifest + source_cutoff_mtime
        accessor over {plan.md,outputs,plan.json}\{ARC.md}; tier2 ledger+plan.json responsibility)
  {WP-SEP, SC-2A/2B/2I/2G}     → WP-P7-trail (tier3 durable + SINGLE classifyLaresCommit §9.4 seam)
  WP-P7-trail → WP-P7A-proj (tier4 discriminated: active=baseline→current+SC candidate |
        archived=baseline+trusted per-commit diffs, NO SC candidate, no checkpoint/later-HEAD attribution, GC'd→raw-diff gap;
        mixed-plan=complete+annotated, plan-linked turns/paths, no exclusive claim, no new candidate)
             → WP-P7A-ui (composes independent tier endpoints; SC-WP-3I active-only; archived per-commit view; ARC-first)
  WP-P7-trail → WP-P7C (path-level; hunk narrows presentation only; responsible-at-work-time = last assigned at≤ts else unknown;
        consumes classifyLaresCommit) ; {P5A-paths, P7-trail} → WP-P7B → P7Z

P8:  P8A→P8B→(P8C∥P8D)→P8E→P8F[§R-P8F: drops EXACTLY the six bespoke tables, nothing else]→P8G→P8H
     P4Z + P7Z + WP-P5-archive → WP-P8-archive-durability (no-deletion+retention guarantee; mechanical committed-folder def;
        named transitive row families; audit = mandatory artifacts + referential integrity/orphans + accessibility + counts;
        IPC plan:archive:integrity + archived-view banner; GC'd commit → explicit raw-diff gap;
        verify: commit→snapshot→archive→prune→fresh process→render tiers 1-4 + row-identity equality)

Consumed by name (not edited): P5/P6 bodies ; P6D composer/trailer emission (§R-ATTR) ; WP-P5-archive ; WP-P5C baseline ref.
Reused, not reinvented: §R0 folder schema ; §R1 intent markup ; §R2 ARC ; P2L ledger + plan:intents:list ;
  §R-ATTR authority order + the single classifyLaresCommit seam.
No new DDL in P4/P7/P8 ; A2 order unchanged ; WP-P8F terminal DROP exception retained + strengthened by §R-P8F.
```

---

<!-- groupthink: planning-surface P4/P7/P8 durable-evidence rescope, Lead Planner × Reviewer, 5 rounds, approved 2026-08-01 -->


<!-- groupthink_run: 4110fa9c (mode=serial) -->
