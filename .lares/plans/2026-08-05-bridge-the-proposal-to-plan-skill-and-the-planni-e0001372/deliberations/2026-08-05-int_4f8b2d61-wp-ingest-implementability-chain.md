---
plan_artifact_id: plan_e0001372
intent_id: int_4f8b2d61
kind: deliberation
---

# WP-ingest implementability chain

## Decision

Make the `kind: work-packages` supplement the sole machine-readable source of planned work packages. The skill continues to write the existing bundle-contract prose and `ARC.md -> ## Work packages` ledger; an additive, strict JSON projection in the supplement supplies only the fields the planning surface must ingest. ARC remains a human/runtime summary and may produce advisory consistency warnings, but it never creates packages or changes lifecycle state.

Reconcile responsibility and work packages as two independently atomic projections from the same folder refresh. This prevents a malformed WP supplement from blocking a legitimate supervisor reassignment, while readiness still requires both projections to be clean.

A skill-driven plan becomes implementable through this explicit chain:

1. `package` writes bundle-contract prose and the structured WP projection.
2. Folder reconciliation creates at least one `ready` package and resolves the authoritative responsible supervisor.
3. The overview work owned by `int_7c3e9a12` populates every required `plan_tab_overviews` row, including Packages once ingest makes that tab populated.
4. The human pulls **Mark Ready**, changing `hardening -> ready`.
5. The human pulls **Implement**, creating the execution run and changing `ready -> executing`.

Neither packaging nor reconciliation automatically performs steps 4 or 5.

## Invariants

- One valid disk projection is one coherent DB planning revision: apply its entire WP delta or none.
- Package identity survives supplement renames, restarts, folder adoption, and casing-only logical-ID edits.
- Disk owns planning definitions only while affected packages have no runtime ownership.
- SQLite exclusively owns assignment, dispatch, execution, finalization, completion, and runtime lifecycle.
- Invalid or missing input can update diagnostic status but cannot partially mutate package/runtime rows.
- No package row is hard-deleted; omission from a valid snapshot uses lifecycle-aware tombstoning.
- Missing/unreadable whole supplements never mean "archive every package."
- Unresolved disk drift blocks Mark Ready and Implement.
- Implement remains a renderer-only, app-user-observed action.

## 1. Work-package supplement contract

The responsible supervisor writes exactly one Markdown file under `supplements/` with frontmatter `kind: work-packages` and the plan's exact `plan_artifact_id`. The prose sections remain in the existing `Files / Dep / Do / Accept / Non-goals / Verify` bundle-contract shape.

Immediately before the prose WP sections, emit exactly one hidden machine block:

```markdown
<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_e0001372",
  "packages": [
    {
      "id": "WP-1",
      "order": 10,
      "title": "WP schema and parser",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Invalid input leaves package, layout, path, assignment, and lifecycle rows unchanged."
      ],
      "paths": [
        {
          "path": "src/main/plans/plan-work-package-ingest.ts",
          "intent_kind": "create"
        }
      ],
      "depends_on": []
    }
  ]
}
-->
```

This is additive machine metadata, not a replacement or modification of the bundle-contract prose, ARC ledger, PLAN-INTENT/PLAN-INTEGRATION sentinels, or rung ladder.

### Validation rules

- Exactly one regular, non-symlink Markdown file under `supplements/` may carry matching `kind: work-packages` frontmatter.
- Exactly one `PLAN-WORK-PACKAGES:v1` block is required. Bound the file and block to 1 MiB.
- Parse strict JSON. Reject comments, duplicate keys, unknown top-level keys, unknown package keys, and any string containing `-->`.
- `schema_version` must equal `1`.
- The block, supplement frontmatter, and `plan.json` must carry the same `plan_artifact_id`.
- `packages` must be a non-empty array.
- `id` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and be unique case-insensitively.
- Derive the DB ID as `wp:<plan_artifact_id>:<lowercase logical id>`. Preserve authored casing in provenance for display.
- `order` must be a unique non-negative integer; gaps are allowed. Display order is `(order, lowercase id)`.
- `title` is required, trimmed, and at most 300 characters.
- `initial_state` is required and limited to `ready | blocked`. Disk cannot declare `executing`, `done`, `archived`, assignment, revision, or completion.
- `acceptance_conditions` is a non-empty array of non-empty strings. Store it in `acceptance_condition` joined by `\n` in declared order.
- `paths` is an array and may be empty for verification-, documentation-, or artifact-only packages. Each entry has `path` and optional `intent_kind` limited to `create | edit | delete | verify`.
- Paths must be normalized workspace-relative POSIX paths. Reject absolute/drive/UNC paths, backslashes, empty or `.` paths, NUL, and outward traversal.
- `depends_on` contains logical IDs from this projection. Reject missing/self references and cycles. Every dependency must have a lower `order` than its dependent.
- Compute each package's content digest from canonical JSON over ID, title, initial state, acceptance conditions, normalized paths, and dependencies. Exclude `order` so an order-only edit does not increment package revision.
- Compute a projection digest over the ordered package records including `order`.
- Require exactly one prose `## <id> - <title>` or `## <id> — <title>` heading for each projected package and no additional prose WP headings. IDs and titles must match; the prose remains responsible for full bundle-contract completeness.
- ARC duplicate/unknown-ID checks are advisory only because ARC may legitimately retain historical/tombstoned entries.

A prose-only legacy supplement is `invalid`, not heuristically imported. Its responsible supervisor must add a reviewed v1 block before the plan can become ready.

## 2. Provenance and status schema

Add companion tables; do not alter the frozen eleven-column `plan_work_packages` shape.

```sql
CREATE TABLE IF NOT EXISTS plan_work_package_sources (
  package_id           TEXT PRIMARY KEY
                       REFERENCES plan_work_packages(id) ON DELETE CASCADE,
  workspace_id         TEXT NOT NULL,
  plan_id              TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_rel_path      TEXT NOT NULL,
  source_local_id      TEXT NOT NULL COLLATE NOCASE,
  source_format        TEXT NOT NULL CHECK (source_format = 'structured-v1'),
  applied_hash         TEXT NOT NULL,
  observed_hash        TEXT,
  applied_order        INTEGER NOT NULL,
  observed_order       INTEGER,
  declared_state       TEXT NOT NULL CHECK (declared_state IN ('ready','blocked')),
  reconcile_state      TEXT NOT NULL CHECK (reconcile_state IN (
    'synced', 'drift-conflict', 'missing-pristine', 'missing-conflict'
  )),
  present              INTEGER NOT NULL CHECK (present IN (0,1)),
  tombstoned_at        INTEGER,
  first_seen_at        INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL,
  UNIQUE(plan_id, source_local_id)
);

CREATE INDEX IF NOT EXISTS idx_plan_wp_sources_plan
  ON plan_work_package_sources(plan_id, reconcile_state);

CREATE TABLE IF NOT EXISTS plan_folder_projection_state (
  plan_id                       TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  workspace_id                  TEXT NOT NULL,
  wp_status                     TEXT NOT NULL DEFAULT 'unpackaged'
                                CHECK (wp_status IN ('unpackaged','synced','invalid','conflict')),
  wp_source_rel_path            TEXT,
  wp_projection_hash            TEXT,
  wp_diagnostics_json           TEXT NOT NULL DEFAULT '[]',
  wp_reconciled_at              INTEGER,
  responsibility_event_id       TEXT,
  responsibility_status         TEXT NOT NULL DEFAULT 'absent'
                                CHECK (responsibility_status IN ('valid','absent','invalid')),
  responsibility_detail         TEXT,
  responsibility_reconciled_at  INTEGER
);
```

The WP and responsibility transactions update only their owned columns in `plan_folder_projection_state`. Per-package applied/observed fields make drift queryable without decoding plan-level diagnostic JSON.

## 3. WP snapshot reconciliation

Implement pure parsing/canonicalization plus one transactional applier in a new `src/main/plans/plan-work-package-ingest.ts`.

### Snapshot phase

Outside SQLite:

1. Read the already-contained canonical plan folder and fully parse `plan.json`.
2. Locate zero or one matching work-package supplement.
3. Parse and validate the complete v1 block, prose ID/title parity, paths, dependencies, hashes, and ordering.
4. Re-stat/re-read the source before apply; if it changed during validation, retry once and otherwise return `invalid/source-raced`.
5. On absent, ambiguous, malformed, oversized, unsafe, or identity-mismatched input, update only WP diagnostic/status columns. Do not touch packages or responsibility.

If a previously ingested entire supplement disappears, set `wp_status='conflict'` with `source-missing`; preserve all packages. Individual package removal is recognized only when a valid, complete replacement projection omits it.

### Apply preflight

Open one `BEGIN IMMEDIATE` transaction, re-read the plan, current packages, provenance, and runtime evidence, then classify the complete delta before the first mutation.

Runtime ownership includes:

- non-null package assignee;
- non-`disk-reconciler` lifecycle events;
- dispatch attempts;
- stamped turns or other durable package attribution;
- package finalization;
- `executing` or `done` state;
- an execution run or other execution evidence relevant to the affected package/plan.

An unmanaged DB package attached to this plan but lacking a provenance row is preserved and makes the plan `conflict`; never adopt it by title or silently include it in a disk-defined execution roster.

If any changed/removed package is runtime-owned, or any deterministic ID collides with an unrelated row, reject the entire WP delta. Roll back, then record only observed hashes/orders and conflict diagnostics in a separate diagnostic transaction. Applied hashes, packages, paths, layouts, assignments, lifecycle state, and plan run state remain unchanged.

### New and unchanged packages

For a new package while the plan is `hardening`, or during a safe pre-execution `ready` revision:

- Insert `plan_work_packages` with deterministic ID, null assignee, declared `ready|blocked`, revision `1`, and one reconciliation timestamp.
- Insert normalized paths and layout order.
- Insert its provenance row as `synced`, `present=1`, with equal applied/observed hashes and orders.
- Creation is not a lifecycle transition and does not need a synthetic lifecycle event.

For an existing package whose hash and order match, update only `last_seen_at`/observed provenance idempotently.

### Safe semantic and order changes

While `hardening`, an entirely planning-owned snapshot may change:

- A semantic content change updates title, acceptance, paths, declared state, and applied hash atomically; preserve `created_at` and increment `revision` exactly once.
- An order-only change updates layout and applied/observed order without incrementing package revision.
- A declared `ready <-> blocked` change goes through the lifecycle ledger with actor `disk-reconciler` and a reason containing the new applied hash; the bulk DB primitive must use the same internal transition logic as `plan-lifecycle.ts`, not a general upsert that overwrites state.

If the plan is `ready`, has no execution run/evidence, and every affected package is planning-owned, apply the same full-snapshot update and atomically compare-and-set `plans.run_state='hardening'` in the package transaction. This invalidates the prior human approval. An unchanged refresh never demotes.

During `executing` or `archived`, or once relevant runtime evidence exists, semantic/order changes and additions are conflicts.

### Removal and restoration

Never delete a package row.

When a valid complete projection omits a previously ingested planning-owned package:

- transition it to `archived` through the lifecycle ledger;
- actor: `disk-reconciler`;
- reason: `source package removed during planning`;
- preserve paths and revision;
- set `present=0`, `tombstoned_at=<now>`, and `reconcile_state='missing-pristine'`.

If it reappears before external runtime evidence exists, restore it through a `disk-reconciler` lifecycle event to its declared initial state, apply any safe semantic/order update, clear the tombstone, and mark it `synced`.

Omission of an assigned, dispatched, executed, finalized, done, or otherwise runtime-owned package produces `missing-conflict` and rejects the full snapshot without changing the live row.

Any exception rolls back package rows, layout, paths, lifecycle events, provenance, revisions, tombstones, projection status, and any `ready -> hardening` demotion together. Validate all removals before archiving the first package.

## 4. Responsible-supervisor reconciliation

Parse and apply responsibility independently from WP validity. `plan.json.responsibility_events` is disk-authoritative history; the last array entry whose event is `assigned` is current. Do not sort by timestamps and do not fall back to an older event.

Validate the history shape, unique non-empty event IDs, and the latest assignment's non-empty agent ID. Then require the agent to exist in the plan workspace and satisfy `is_supervisor=1 OR privilege_lane='supervisor'`.

In one responsibility transaction:

- For a valid assignment, set `plans.responsible_supervisor_id`, upsert `supervisor_focus` without overwriting notes, and record `responsibility_status='valid'` plus the event ID.
- Do not assign the new supervisor's `supervisor_active_plan`; responsibility is ownership, while active-plan selection is transient attention and must not be reconstructed in boot directory order.
- If responsibility moved away from a prior supervisor, clear that prior supervisor's `supervisor_active_plan` only when it currently points to this plan. Do not disturb another active selection.
- For absent history, clear `responsible_supervisor_id` and record `absent`.
- For malformed history or a missing/deleted/non-supervisor/cross-workspace latest agent, clear `responsible_supervisor_id`, record `invalid` with the rejected event/reason, and clear a stale prior active-plan pointer only if it targets this plan.
- Never retain or fall back to the previous DB supervisor when disk's current responsibility cannot be validated.

Responsibility may reconcile during execution; it changes ownership, not package runtime state.

## 5. Readiness and human-trigger chain

Add a shared read-only readiness projection. Mark Ready and Implement must force the same plan-ID-only single-folder refresh before evaluating their gates.

### Mark Ready

Change `markPlanReady` from "at least one non-archived package" to "at least one package in `ready` state." Add failures:

- `work-package-ingest-not-synced`
- `no-ready-package`
- retain `no-valid-responsible-supervisor`
- retain `tab-overview-missing`

The complete gate is:

- structured plan currently `hardening`;
- `wp_status='synced'` and no per-package conflict state;
- at least one `ready` package;
- `responsibility_status='valid'` and the DB supervisor relationship still validates;
- every tab returned as populated by `buildPlanDocuments(planId)` has a non-empty `plan_tab_overviews` body.

Use a DB compare-and-set for `hardening -> ready`; do not call the broad `updatePlan` setter after checking stale state.

Interface required from `int_7c3e9a12`: once ingest creates package rows, `buildPlanDocuments` marks Packages populated, so that intent must supply a non-empty Packages overview in addition to every other populated tab. This plan does not choose overview source, mapping, wording, or editing UX.

### Implement

Before touching Git, force reconciliation and re-run all existing Implement gates plus clean WP reconciliation. If refresh fails, is invalid/conflicted, or safely demotes a changed ready plan to hardening, return a structured failure and do not probe/create a baseline ref.

Keep the existing baseline-before-run ordering and the atomic execution-run insert plus `ready -> executing` transition unchanged. Implement remains renderer-only; add no HTTP/API route.

### Surface and transport

Expose typed renderer-only methods:

- `plan:refreshFromDisk(planId)`
- `plan:getReadiness(planId)`
- `plan:markReady(planId)`
- existing `plan:implement(planId)`

`getReadiness` returns run state, package counts by state, WP/responsibility statuses, supervisor validity, missing overview tabs, package-specific conflicts, and `canMarkReady`/`canImplement`.

The plan surface renders Refresh from disk, Mark Ready in hardening, a visible ready badge in ready, Implement in ready, and structured refusal details. Refresh state after every action. These controls never auto-dispatch.

## 6. Host and triggers

Use `src/main/plans/plan-folder-watcher.ts` as the host. At the settled seam:

1. the plans row is already adopted/revived;
2. scan the intent ledger;
3. reconcile responsibility;
4. reconcile the WP snapshot;
5. invoke the optional downstream callback.

Run this sequence on boot adoption, new/revived folders, watched top-level/child changes, periodic reconciliation for over-cap folders, explicit manual refresh, and forced refresh before Mark Ready/Implement.

Extend the narrow `adoptPlanFolder` path so manual refresh resolves the canonical folder and calls the same service. IPC accepts only `planId`; main derives workspace and folder paths. Do not duplicate parsing or DB policy in handlers.

## 7. Work packages

### WP-INGEST-1 - Skill schema and versioned deployment

**Files**

- `src/shared/constants.ts:5917` (`PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD`)
- new `PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD` beside the existing proposal-to-plan contracts
- `src/main/supervisor/index.ts:1235-1305`
- `src/main/supervisor/proposal-to-plan-old-body-fixtures.ts`
- `src/main/supervisor/scaffold-version-migration.test.ts`

**Dep:** none.

**Do**

- Load and follow `scaffold-content-needs-version-bump` before editing scaffold content.
- Add the exact v1 contract and example above; require package to write projection and prose in the same operation and self-check ID/title parity.
- Re-derive the pristine current `package.md` hash before editing, preserve its byte-exact old body fixture, bump the package-playbook version, and add its prior hash.
- Add `references/contracts/work-packages.md` to `PROPOSAL_TO_PLAN_TREE` for Claude and Codex roots.
- Do not patch deployed `.lares/*/skills` copies as the source change.

**Accept**

- Fresh scaffolds receive the contract.
- Pristine previous package playbooks upgrade automatically.
- Locally modified deployed playbooks remain untouched.
- Existing bundle prose and ARC syntax remain unchanged.

**Non-goals:** no parser or DB changes.

**Verify:** scaffold migration/version and optimizer scaffold registry suites; main TypeScript compile.

### WP-INGEST-2 - DB companions and atomic package reconciliation

**Files**

- `src/main/database.ts:1645-1667, 1992-2056, 4959-5320`
- new DB-focused reconciliation test beside `database.planWorkPackages.test.ts`

**Dep:** WP-INGEST-1 for the frozen input contract.

**Do**

- Add the companion/status schema and indexes.
- Add queries for managed/unmanaged packages and package runtime evidence, including stamped turns.
- Implement the one-transaction package applier, internal disk lifecycle transitions, revision/order semantics, tombstones, ready demotion, and diagnostic-only conflict recording.
- Do not call `upsertPlanWorkPackage` for existing reconciled rows because it overwrites state and assignee.

**Accept**

- Fault injection after every mutation stage rolls back the entire applied snapshot.
- A conflict preserves applied hashes, packages, paths, assignments, lifecycle/runtime state, and run state while recording observed drift.
- No path deletes a package row.
- Order-only changes do not increment revision.

**Non-goals:** no parsing, watcher, IPC, or renderer changes.

**Verify:** new DB tests plus work-package, layout/path, lifecycle, dispatch, stamped-evidence, and finalization sibling suites; main TypeScript compile.

### WP-INGEST-3 - Parser, responsibility, and watcher integration

**Files**

- new `src/main/plans/plan-work-package-ingest.ts`
- new `src/main/plans/plan-work-package-ingest.test.ts`
- `src/main/plans/plan-folder-watcher.ts:25-34, 188-401, 409-479`
- `src/main/plans/plan-folder-watcher.test.ts`
- responsibility helpers/status writes in `src/main/database.ts:1884-1930, 5315-5333`

**Dep:** WP-INGEST-2.

**Do**

- Implement strict bounded parsing, canonical hashes, casing-stable IDs, path/dependency validation, and prose ID/title parity.
- Implement independent fail-closed responsibility reconciliation without assigning `supervisor_active_plan` to the new owner.
- Compose both projections at the watcher settled seam and single-folder refresh path.
- Return typed diagnostics and persist durable status; console logging alone is insufficient.

**Accept**

- Boot/adopt/change/periodic/manual refresh converge identically.
- Missing/malformed supplements preserve all package rows.
- Valid replacement omission archives only planning-owned packages.
- Invalid latest responsibility clears stale DB authority without blocking a valid WP projection.
- Boot order never assigns a supervisor's active plan.

**Non-goals:** no readiness or renderer controls.

**Verify:** parser fixture matrix, watcher sibling suite, responsibility validation/active-plan tests, restart idempotence, main TypeScript compile.

### WP-INGEST-4 - Refresh, Mark Ready, and Implement reachability

**Files**

- `src/main/plans/plan-lifecycle.ts:279-365`
- `src/main/plans/plan-implement.ts:144-271`
- `src/main/plans/plan-ipc.ts:1059-1160`
- `src/preload/index.ts:220-235, 750-760`
- `src/shared/types.ts` plan API/readiness DTOs near the existing plans preload contract
- `src/renderer/components/plan/PlanSurfaceContainer.tsx:47-68`
- `src/renderer/components/plan/PlanSurfaceView.tsx:15-123`
- lifecycle, Implement, preload-surface, PlanSurface, document-tab, and Mission Board tests

**Dep:** WP-INGEST-3 and the overview interface from `int_7c3e9a12`.

**Do**

- Add read-only readiness projection and plan-ID-only refresh/Mark Ready IPC.
- Force refresh before Mark Ready and Implement.
- Require clean ingest and a ready package; use CAS for Mark Ready.
- Expose existing Implement through typed preload and add lifecycle controls/refusal details.
- Preserve renderer-only authorization and existing Implement baseline/run transaction ordering.

**Accept**

- A valid packaged plan with valid supervisor and complete overviews reaches `hardening -> ready -> executing` by two explicit human actions.
- Only-blocked packages cannot Mark Ready.
- Safe post-ready drift applies and demotes to hardening; unsafe drift remains conflict.
- Invalid refresh prevents any Git baseline operation.
- Packages becoming populated adds Packages to the overview gate.

**Non-goals:** no overview-source design, HTTP route, auto-ready, auto-Implement, or dispatch.

**Verify:** lifecycle, Implement, preload-surface, plan-surface, document-tab, Mission Board sibling suites; main and renderer TypeScript compile.

### WP-INGEST-Z - End-to-end restart/conflict/readiness gate

**Files:** new integration fixture/test under `src/main/plans/`; no production changes except defects exposed by the gate.

**Dep:** WP-INGEST-1 through WP-INGEST-4.

**Do / Accept**

Create a temporary structured plan folder through the real watcher and prove:

1. adoption starts in `hardening`;
2. the v1 block produces deterministic, ordered Mission Board cards and paths;
3. ready and blocked initial states are honored;
4. a valid manifest assignment populates responsible supervisor but does not steal active-plan attention;
5. missing Packages/other populated-tab overviews block Mark Ready;
6. complete overviews permit Mark Ready;
7. Implement creates exactly one active execution run;
8. safe pre-execution edits demote ready to hardening;
9. runtime-owned edits/removals create queryable conflicts without overwriting DB state;
10. valid omission tombstones a pristine package, while missing/malformed whole supplements preserve all packages;
11. invalid responsibility clears stale authority independently of WP ingest;
12. restart and repeated refresh are idempotent.

**Non-goals:** no feature expansion during gate repair.

**Verify:** full main suite, relevant renderer sibling suites, and both TypeScript builds.

## Explicit non-goals

- No ARC-prose lifecycle import or heuristic legacy parser.
- No change to bundle-contract prose, ARC ledger syntax, PLAN-INTENT/PLAN-INTEGRATION sentinels, or rung ladder.
- No automatic Mark Ready, Implement, assignment, dispatch, completion, or finalization.
- No dependency scheduler; `depends_on` is validated planning metadata only.
- No conflict-resolution editor or post-execution package revision workflow.
- No overview-source or per-tab mapping design beyond the interface owned by `int_7c3e9a12`.
- No legacy HTML-plan changes.
- No deletion of package history.
- No second package parser or DB writer in the promotion saga.

## Promote-path dependency

This design assumes `int_9e5d0c47` selects skill plus reconciler as the single writer. If the promotion saga remains authoritative, it must invoke this same folder reconciliation service after adoption; it must not gain another parser or write package definitions directly. Proposal-link enrichment may remain saga-owned, while responsibility must use the same manifest-derived validation semantics defined here.


<!-- groupthink_run: 64d9833c (mode=parallel) -->
