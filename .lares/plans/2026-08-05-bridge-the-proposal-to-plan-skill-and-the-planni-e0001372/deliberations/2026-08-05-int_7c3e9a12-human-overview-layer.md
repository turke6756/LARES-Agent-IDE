---
plan_artifact_id: plan_e0001372
intent_id: int_7c3e9a12
kind: deliberation
---

# Human-readable overview layer

## Decision

Create one durable `OVERVIEW.md` beside `ARC.md`. It is the human-register source for every structured-plan tab summary. The plan-folder reconciler parses it and atomically projects all stable tab keys into `plan_tab_overviews`. SQLite remains the renderer/readiness projection, not an independent authoring source.

Keep the existing readiness contract: every tab reported as populated by `buildPlanDocuments` needs a non-empty projected body. Packaging writes summaries for every tab discoverable from the disk inventory and always writes Packages. Therefore WP-INGEST-4 may depend on this exact interface:

> After a valid `OVERVIEW.md` is reconciled, `getPlanTabOverview(planId, "packages")` returns a non-empty body and the shared readiness projection reports `overviewStatus: "synced"`. When WP ingest makes Packages populated, no special-case readiness logic is required.

This layer is strictly additive. `ARC.md`, `plan.md`, work-package prose, PLAN-INTENT/PLAN-INTEGRATION markup, and the rung model remain unchanged.

## Durable format

The file lives at `<plan-folder>/OVERVIEW.md`:

```markdown
---
plan_artifact_id: plan_e0001372
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_e0001372",
  "sections": [
    { "tab": "overview", "heading": "What this plan changes" },
    { "tab": "proposal", "heading": "Why this work exists" },
    { "tab": "plan", "heading": "How the work will proceed" },
    { "tab": "deliberations", "heading": "Important decisions" },
    { "tab": "supplements", "heading": "Supporting material" },
    { "tab": "packages", "heading": "Work packages" }
  ]
}
-->

<!--PLAN-TAB-SECTION:overview:BEGIN-->
## What this plan changes

Lares will connect the durable planning files to the planning surface so the
workspace owner can understand and start the plan without asking an agent to
translate it.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

The planning skill currently produces complete agent handoffs, but most of that
information does not reach the human-facing surface.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

The work first defines the disk contracts, then reconciles them into the
application database, and finally exposes explicit Mark Ready and Implement
controls.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

Work-package definitions remain owned by disk, and implementation still begins
only after an explicit human action.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

The supporting documents contain detailed implementation contracts and the
reasoning behind the major design choices.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

The packages add the overview contract, connect disk plans to the database, make
the Packages tab usable, and verify the restart-to-implementation flow.
<!--PLAN-TAB-SECTION:packages:END-->
```

Research is intentionally absent from this example because the example has no populated Research tab.

The JSON block is an index only. Each entry binds one stable `PlanTabKey` to one explicitly delimited section. The first nonblank line after the begin delimiter must be the indexed `## <heading>`; the body continues to the matching end delimiter. Ordinary `##` headings inside the body do not terminate it.

Unmapped prose outside indexed sections is permitted, ignored by projection, and preserved byte-for-byte by UI edits.

### Strict parsing

Add `jsonc-parser` as a production dependency and introduce a shared `src/main/plans/strict-json.ts` helper. It uses `parseTree` with comments and trailing commas disabled, walks every object node, and rejects duplicate property names before converting the tree to a value. WP-INGEST-3 and WP-HOV-2 use this same helper for `PLAN-WORK-PACKAGES:v1` and `PLAN-TAB-OVERVIEWS:v1`; do not ship two strict-JSON implementations.

Validation requires:

- Parsed file size at most 1 MiB.
- Exact matching `plan_artifact_id`, `kind: human-overview`, and `schema_version: 1`.
- Exactly one v1 index outside fenced code.
- Exactly one begin/end delimiter pair for each indexed tab, outside fenced code.
- No unindexed delimiters, duplicate/unknown tab keys, duplicate headings, crossed/nested delimiters, missing headings, or empty bodies.
- Delimiter-like text inside fenced code remains ordinary prose.
- JSON strings containing `-->` are rejected.
- A mapped section at EOF is valid with or without a final newline.
- CRLF and LF parse identically; raw bytes are not normalized for source observation.

Frontmatter uses the repository's bounded scalar subset. Require a single leading fence and unique top-level keys. Reject duplicate keys, nested mappings, sequences, aliases, multiline scalar syntax, and malformed lines. Require exact values for the three identity keys. Additional unique scalar fields such as `author` and `authored_at` are allowed, ignored by projection, and preserved by UI edits.

## Section mutation rules

For a valid current file, the structured editor performs one bounded transform:

- **Replace:** retain the index entry, delimiters, and heading; replace only the body between the heading and end delimiter.
- **Insert:** when a stable tab is not mapped, add its index entry and delimited section in canonical `PLAN_TAB_KEYS` order, using the standard human heading.
- **Remove:** only an explicit Remove action removes both the index entry and complete delimited section. Empty Save is rejected.
- **Rename heading:** unavailable in the body editor. A file-level edit must change the index and visible heading together; mismatch is invalid.
- **Newlines:** detect and retain the existing style. Preserve unrelated bytes, unmapped prose, trailing whitespace outside the target section, and final-newline presence. New files use LF.
- **Fenced code:** track Markdown fence state while locating the index and delimiters.

When insertion/removal changes index entries, rewrite only the index comment canonically: two-space JSON indentation, fixed top-level key order (`schema_version`, `plan_artifact_id`, `sections`), canonical tab order, fixed entry key order (`tab`, `heading`), and the file's newline convention. The byte-preservation guarantee excludes the index block when its entries change; unmapped prose and unrelated sections remain byte-identical.

Tests cover duplicate headings and JSON keys, additional `##` headings, headings/delimiters inside fenced code, CRLF/LF, no final newline, mapped section at EOF, insertion, replacement, removal, and canonical index rewriting.

## Package-time disk inventory

The skill does not call SQLite-dependent `buildPlanDocuments`. It derives the initial section set from a bounded, contained disk inventory:

- Overview: always, because `ARC.md` is part of a promoted folder.
- Plan: always, because `plan.md` exists.
- Proposal: when `plan.json.source_proposal.rel_path` resolves to a contained regular non-symlink file.
- Deliberations, research, and supplements: when their directory contains a real regular non-symlink output other than `.gitkeep`.
- Packages: always during package.
- Legacy HTML: never inferred by the skill.

If a later DB-backed document makes another tab populated, readiness reports the missing section and the owner can add it through the disk-backed editor.

## Projection and durable adoption state

Add overview fields to `plan_folder_projection_state`, the companion table owned by WP-INGEST-2:

- `overview_status`: `absent | synced | invalid | apply-error`
- `overview_source_hash`
- `overview_diagnostics_json`
- `overview_reconciled_at`
- `overview_adoption_state`: `never-seen | observed | projected`, default `never-seen`

The adoption transitions are monotonic:

```text
never-seen -> observed -> projected
never-seen ------------> projected
```

Observing any present source, including valid, invalid, unsafe, unreadable, or oversized, advances `never-seen` to `observed`. Successfully applying a valid snapshot advances either prior state to `projected`. Absence, deletion, rename-away, failure, or restart never moves it backward. First-file DB seeding is allowed only in `never-seen` while the immediately observed source is absent.

Add companion provenance:

```sql
CREATE TABLE IF NOT EXISTS plan_tab_overview_sources (
  plan_id          TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  tab              TEXT NOT NULL,
  source_rel_path  TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  body_hash        TEXT,
  reconcile_state  TEXT NOT NULL CHECK (
    reconcile_state IN ('synced','missing')
  ),
  reconciled_at    INTEGER NOT NULL,
  PRIMARY KEY (plan_id, tab)
);
```

Use two hashes:

- `source_hash`: SHA-256 of exact raw bytes, exposed as `sha256:<hex>` for optimistic conflict detection.
- `body_hash`: SHA-256 of extracted Markdown after newline normalization, used only to determine whether the tab revision changes.

A valid snapshot transaction upserts every stable `PLAN_TAB_KEYS` value. Mapped tabs receive the non-empty body and `synced`; omitted tabs receive `body=NULL`, `body_hash=NULL`, and `missing`. Increment `plan_tab_overviews.revision` only when the effective body changes, including non-null to null. Creating an initially omitted null row uses revision 1; unchanged refreshes do not bump it. Update plan status and per-tab provenance in the same transaction.

Invalid/ambiguous input updates only status, diagnostics, observed token, and adoption state. It preserves last-applied bodies and provenance. Readiness requires `overview_status='synced'`, so preserved bodies cannot satisfy the gate.

When responsibility is valid, reconciliation records the current responsible supervisor in `updated_by` as plan-owner attribution. When responsibility is absent or invalid, it stores `updated_by=NULL`; projection may converge while the independent responsibility gate blocks Mark Ready. This does not claim proof of the OS user who edited the file.

### Missing source after projection

Deleting or renaming away `OVERVIEW.md`:

- Sets `overview_status='absent'`.
- Records `overview-source-absent` and clears the currently observed hash.
- Preserves last-valid bodies, revisions, `updated_by`, and provenance for visibility/recovery.
- Blocks readiness despite preserved bodies.
- Retains `overview_adoption_state='projected'` and never reactivates DB seeding.
- Reconciles a later restored valid file normally.

## Source observation and filesystem safety

Use one observer/token domain everywhere:

```ts
type ObservedOverviewSourceToken =
  | 'absent'
  | 'unsafe'
  | 'unreadable'
  | `sha256:${string}`;
```

The only valid source is a contained regular, non-symlink `<canonical-plan-folder>/OVERVIEW.md`. Main resolves the canonical workspace state directory, plans home, and adopted folder; revalidates `plan.json` identity; resolves existing ancestors with `realpath`; and rejects symlink/junction escapes, a symlink destination, directory destination, non-regular file, or canonical parent outside the folder.

For every contained regular file, including files over 1 MiB, stream exact bytes through SHA-256 without loading the whole file. Oversized files have an exact hash token but `overview_status='invalid'`, diagnostic `overview-source-oversized`, and disabled section editing. The watcher signature, diagnostics, `loadedSourceHash`, and final pre-write observation use this same observer.

`plan:getOverview` returns the last projected body plus current observed token/status. `loadedSourceHash` does not imply the displayed body came from that token; the source may now be absent, invalid, unsafe, unreadable, or newer than the last applied projection.

## Optimistic editor and writer authority

For structured plans, `plan:setOverview` stops writing SQLite directly. Main derives the plan, workspace, canonical folder, and currently validated responsible supervisor. The renderer does not send or choose `supervisorId`; remove the supervisor selector on this path. Legacy/non-folder plans retain the direct-DB behavior.

All in-app overview writes are serialized by a per-plan main-process mutex. The request carries `expectedSourceHash`. Main acquires the mutex, observes the source, compares it, rejects mismatch, revalidates containment/type, writes/replaces, observes again, and then invokes the same reconciler as the watcher.

This is optimistic conflict detection, not atomic filesystem compare-and-swap. It prevents conflicting Lares UI writes from racing, but an uncoordinated external editor can still change the destination between final observation and rename and be overwritten. Comments, copy, and tests must not claim an absolute stale-write guarantee. Subsequent reconciliation reflects the bytes actually present on disk.

If the current file is structurally invalid, unsafe, unreadable, or oversized, disable section editing and direct the owner to a file editor. If valid but the requested tab is omitted, Add Overview inserts it normally.

Extract/reuse the Windows replacement behavior from `src/main/git-checkpoints/checkpoint-service.ts:1622` (read-only clearing and transient `EPERM`/`EACCES`/`EBUSY` retry), and separately add:

1. Sibling temp creation with exclusive `wx` and an unpredictable 128-bit suffix.
2. Complete write and file-handle sync.
3. Destination revalidation and final source observation.
4. Retried atomic rename-replace.
5. Best-effort parent-directory sync where supported.
6. Temp cleanup on every failure.

A forced replacement failure must leave the prior destination byte-identical and remove the temp. If replacement succeeds but DB projection fails, retain the new source file, return `overview-saved-projection-pending`, best-effort record `apply-error`, and retry via watcher/manual/periodic/restart reconciliation.

### One-time DB adoption

First-file seeding requires a structured canonical folder, `overview_adoption_state='never-seen'`, no provenance, and two absent observations including the final pre-replacement observation. Seed only stable `isPlanTabKey` rows with non-empty bodies; preserve stable unpopulated-tab bodies. Unknown tab rows are not copied and produce a migration diagnostic. Once any source is observed, seeding can never reactivate.

## Watcher convergence

Replace the scalar max-mtime signature with:

```ts
interface PlanFolderSignature {
  maxManagedMtimeMs: number;
  overviewToken: ObservedOverviewSourceToken;
}
```

The general bounded max-mtime component remains. The independently observed `overviewToken` catches creation, lower-mtime replacement, rename-away, and deletion even when a newer unchanged `ARC.md` owns the maximum mtime. Top-level folder subscription, boot adoption, over-cap periodic reconciliation, manual refresh, and restart all use the same service.

Unsafe, unreadable, junction, and transient replacement cases use injected filesystem seams on every platform, with conditional native tests where the host supports them: Windows junction/read-only/retry and POSIX symlink/unreadable cases.

## Readiness and Packages presentation

WP-INGEST-4 owns one shared service:

```ts
refreshAndGetPlanReadiness(planId): Promise<PlanReadiness>
```

It forces canonical single-folder refresh and computes WP, responsibility, overview, populated-tab, and run-state gates once. Mark Ready and Implement both consume that same result. WP-HOV-4 extends this evaluator/DTO; it introduces no parallel interpretation.

The gate remains `overviewStatus === 'synced'` plus a non-empty body for every populated `buildPlanDocuments` tab.

Split the Packages document region:

- **Unpopulated:** “No work-package definitions have been imported yet. Packaging writes the durable definitions; Refresh imports them into the Mission Board.”
- **Populated:** never render “not yet implemented — pull Implement to begin.” Render “Work packages are available on the Mission Board below.” The existing Mission Board at `PlanSurfaceView.tsx:119` remains the card surface.
- Render the Packages summary band when Packages is populated.

Packaging writes definitions; reconciliation imports them into cards.

## Package skill contract

After decomposition and baseline recording, but before declaring dispatch readiness, `package` must:

1. Derive the tab inventory from the disk rules above.
2. Write/update and validate `OVERVIEW.md`.
3. Preserve valid unrelated sections and unmapped prose.
4. Validate both overview and work-package contracts.
5. Present the human overview and await the explicit implementation trigger.

The playbook must contain this literal sentence (U+2014, UTF-8 `E2 80 94`):

> *written for the workspace owner — no sentinel names, no rung jargon, no file:line.*

Good register:

> The package importer turns the work described in this folder into cards on the Mission Board. It refuses incomplete input so a partially read plan cannot be started by mistake.

Bad register:

> WP-INGEST-3 folds the `int_4f8b2d61` rung at `plan-folder-watcher.ts:383` and materializes `PLAN-WORK-PACKAGES:v1`.

The overview and WP scaffold contracts touch the same constants/registry. Freeze and land them together in one clean scaffold/version-migration package, or coordinate so only one worker edits the shared files. Follow `scaffold-content-needs-version-bump`: freeze the old package body/hash first, bump its version, add `previousHashes`, extend migration tests, rebuild/relaunch, and launch an agent in the workspace to trigger migration. Assert the literal register sentence and U+2014 byte sequence in the scaffold test.

## Empty-state honesty

- Absent file: “No human overview has been written yet. Package this plan or add an overview before Mark Ready.”
- Invalid file: “The human overview could not be read. Repair `OVERVIEW.md`; the last valid summaries remain visible but cannot make the plan ready.”
- Missing populated-tab section: “This tab has content but no plain-language summary. Add its section before Mark Ready.”
- Detected stale edit: “The overview changed on disk while you were editing. Reload and merge your draft.”
- Projection pending: “The overview was saved to disk but has not reached the surface yet. Refresh to retry.”

## Work packages

### WP-HOV-1 — Contracts and coordinated versioned deployment

**Files**

- `package.json`, `package-lock.json`
- `src/shared/constants.ts:5917` (`PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD`)
- new `PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD`
- `src/main/supervisor/index.ts:1272-1306` (`PROPOSAL_TO_PLAN_TREE`)
- `src/main/supervisor/proposal-to-plan-old-body-fixtures.ts`
- `src/main/supervisor/scaffold-version-migration.test.ts:3776-3838`

**Dep:** coordinate with WP-INGEST-1's contract freeze; no dependency on its parser/DB work.

**Do:** add `jsonc-parser`; freeze both v1 contracts; update `package` once with the disk inventory, exact register rule, example, and validation step; perform one correct hash/version migration; scaffold the contract to Claude and Codex roots.

**Accept:** package cannot declare dispatch readiness without a valid overview; Packages always has a section; pristine playbooks migrate; hand-edited copies are preserved; both contracts use one coordinated scaffold revision; the test proves the register sentence contains literal U+2014.

**Non-goals:** no parser, DB, watcher, IPC, or renderer work.

**Verify:** scaffold registry/migration suites, frozen-hash precondition, main TypeScript compile.

### WP-HOV-2 — Strict parser, projection, adoption state, and watcher convergence

**Files**

- new `src/main/plans/strict-json.ts` and test
- new `src/main/plans/plan-human-overview.ts` and test
- `src/main/database.ts:1933-1947, 3040-3088`
- `src/shared/types.ts:5070-5100`
- `src/main/plans/plan-folder-watcher.ts:33-176, 302-397`
- `src/main/plans/plan-folder-watcher.test.ts`
- `src/main/plans-watcher.ts:245-370` and structured watcher integration tests
- WP-INGEST-2's `plan_folder_projection_state` migration

**Dep:** WP-HOV-1 contract; coordinate strict parsing with WP-INGEST-3.

**Do:** implement duplicate-key-aware strict JSON; delimiter/fence/newline-aware parsing; streamed observation; all-stable-key atomic projection; monotonic adoption state; provenance; composite watcher signature; missing-source behavior; and settled-seam reconciliation.

**Accept:** duplicate JSON/frontmatter keys reject; fenced headings cannot truncate; invalid input preserves bodies but blocks readiness; lower-mtime edits converge; creation/rename/deletion/boot/over-cap/manual/restart converge; missing after projection preserves bodies/provenance and never reseeds; invalid responsibility projects with `updated_by=NULL`; invalid source removal cannot restore `never-seen`; oversized hashing is consistent.

**Non-goals:** no renderer editing or lifecycle ownership.

**Verify:** parser matrix, DB fault injection, injected filesystem observer tests, conditional native safety tests, watcher/PlansWatcher sibling suites, main TypeScript compile.

### WP-HOV-3 — Optimistic disk editor and truthful Packages state

**Files**

- new shared atomic replacement helper, extracting behavior from `src/main/git-checkpoints/checkpoint-service.ts:1622`
- `src/main/plans/plan-ipc.ts:825-953`
- `src/main/plans/plan-overview.test.ts`
- `src/preload/index.ts:749-760`
- `src/shared/types.ts:5084-5097`
- `src/renderer/components/plan/PlanDocumentTabs.tsx:194-300, 362-455`
- `src/renderer/components/plan/PlanDocumentTabs.editor.test.tsx`
- `src/renderer/components/plan/PlanSurfaceView.tabs.test.tsx`

**Dep:** WP-HOV-2.

**Do:** add source-token optimistic detection and per-plan mutex; derive supervisor authority main-side; remove structured-plan supervisor selection; implement replace/insert/remove and one-time seeding; disable invalid-source editing; recover from saved-but-unprojected state; split populated/unpopulated Packages content.

**Accept:** in-app writes serialize; mismatches detected at final observation reject; the external-writer TOCTOU window is documented; no code claims atomic CAS; previously unmapped tabs insert; CRLF/unrelated bytes persist; replacement failure preserves destination and removes temp; populated Packages never shows the unimplemented placeholder; eligible DB-only bodies survive adoption.

**Non-goals:** no arbitrary invalid-file repair or multi-user merge editor.

**Verify:** IPC authorization/concurrency tests, injected external-race seam, replacement/projection failure tests, editor/tab/Packages/preload suites, both TypeScript compiles.

### WP-HOV-4 — Shared readiness integration

**Files**

- WP-INGEST-4's shared readiness service and DTO
- `src/main/plans/plan-lifecycle.ts:299-365`
- `src/main/plans/plan-implement.ts:117-181`
- lifecycle/Implement tests
- `src/renderer/components/plan/PlanSurfaceContainer.tsx` and refusal tests

**Dep:** WP-HOV-2, WP-INGEST-3, and WP-INGEST-4's shared service contract. It does not depend on WP-HOV-3.

**Do:** extend `refreshAndGetPlanReadiness(planId)` with overview status, diagnostics, and missing tabs; make Mark Ready and Implement consume the same post-refresh result; preserve explicit human actions.

**Accept:** valid overview/WP/responsibility reaches `hardening -> ready`; invalid/incomplete/absent overview blocks both actions; valid omission nulls the row and blocks when populated; restoration converges without DB repair.

**Non-goals:** no auto-ready, auto-Implement, WP-ingest redesign, or alternate evaluator.

**Verify:** lifecycle, Implement, forced-refresh, renderer refusal, and TypeScript suites.

### WP-HOV-Z — End-to-end human-register gate

**Files:** new integration fixture/test under `src/main/plans/` and relevant renderer integration test.

**Dep:** WP-HOV-1 through WP-HOV-4 and WP-INGEST-1 through WP-INGEST-4.

**Do / Accept:** prove the exact readable v1 format; duplicate-key and fenced-code behavior; lower-mtime and all watcher triggers; UI insert/replace/remove/seeding; serialized in-app edits and truthful external-race behavior; replacement/projection failure recovery; invalid-source body preservation/readiness refusal; monotonic `never-seen -> observed -> projected`; invalid source removal never reseeds; deletion after projection preserves summaries/provenance but blocks; restoration; invalid responsibility with `updated_by=NULL`; Packages pre-summary/population; populated Packages never shows the placeholder; complete state permits Mark Ready; Implement remains separate; symlink/junction escape cannot read/write outside the folder.

**Non-goals:** no agent-register replacement, orchestration/promote redesign, legacy HTML changes, or merge editor.

**Verify:** full main and relevant renderer suites, both TypeScript builds, scaffold migration suite, and restart/idempotence gate.


<!-- groupthink_run: 2835baac (mode=serial) -->
