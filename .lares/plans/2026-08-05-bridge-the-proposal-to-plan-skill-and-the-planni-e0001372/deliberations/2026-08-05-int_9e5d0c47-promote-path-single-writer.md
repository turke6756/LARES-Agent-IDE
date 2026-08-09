---
plan_artifact_id: plan_e0001372
intent_id: int_9e5d0c47
kind: deliberation
---

# Promote-path single writer

## Decision

Choose **(a): the `proposal-to-plan` skill plus the folder reconciler is the sole steady-state promotion path; retire the promotion saga.**

The ownership boundary is:

- The responsible supervisor, using the skill and `plan-manifest.mjs`, is the only writer of plan-folder planning artifacts.
- One common per-folder reconciliation coordinator is the only writer of SQLite projections derived from those artifacts.
- Renderer and IPC code may preflight, dispatch a supervisor, report reconciliation state, or navigate. They never create plan folders or write plan/package rows.
- SQLite remains authoritative for runtime package lifecycle after the boundary defined by `int_4f8b2d61`.

The mounted `PromoteToPlanPanel` remains the single user gesture. The unmounted `PromoteDialog`, mutation/status IPC service, new-request saga, and saga-owned enrichment are retired.

## Why this path

Startup currently assembles the saga and registers its IPC service (`src/main/index.ts:997-1105`), while the mounted panel independently dispatches a supervisor to run the skill. Mounting the unused dialog would preserve two initiators and make service-persisted identity compete with the skill's disk identity.

The saga's enrichment transaction also writes responsibility, transient supervisor attention, proposal linkage, and `plan_documents` after folder adoption (`src/main/database.ts:7988-8068`). That conflicts with the binding sibling decision that manifest responsibility and work-package definitions are reconciler-owned.

## 1. Canonical promotion identity and proposal path

Delete rather than move the filename-derived SKU logic in `src/main/plans/promote-proposal.ts:71-76`.

Create one authored identity implementation in `src/shared/plan-identity.ts`. A build generator produces the standalone `plan-identity.mjs` deployed with the skill; main imports the authored implementation, while deployed `plan-manifest.mjs` imports its generated sibling.

The canonical identity algorithm matches the current helper:

- proposal artifact: frontmatter `artifact_id`;
- plan artifact: `plan_` plus the artifact ID with one leading `prop_` removed;
- date: explicit override, otherwise the first ten characters of `authored_at`, otherwise an injected current UTC date;
- slug: lowercase `title`, replace non-alphanumeric runs with `-`, trim separators, truncate to 48 characters, fall back to `plan`;
- SKU: `<date>-<slug>-<first-eight-artifact-hex>`.

Canonical parsing includes the helper's single- and double-quoted scalar handling. Parity tests cover filename/title disagreement, punctuation, empty titles, truncation, quoted fields, explicit overrides, missing `authored_at`, artifact IDs with and without `prop_`, and `.lares`/`.dashboard` state roots.

Claim result types move from `promote-proposal.ts` into a neutral `promotion-preflight.ts`.

### Deployed-helper path derivation

As part of the versioned `plan-manifest.mjs` v3 to v4 migration, delete the current `.lares/proposals/` substring search and basename fallback in `toRelProposal()`.

The helper must:

1. Resolve `--plans-home` to an absolute path.
2. Require its leaf to be `plans`.
3. Require its parent leaf to be exactly `.lares` or `.dashboard`.
4. Define `stateDirAbs = dirname(plansHomeAbs)`, `workspaceRootAbs = dirname(stateDirAbs)`, and `proposalRootAbs = stateDirAbs/proposals`.
5. Require `--proposal` to resolve beneath `proposalRootAbs`.
6. Require the proposal to be a regular file, not a symlink.
7. Realpath the proposal, proposal root, state directory, and workspace root; reject symlink/reparse traversal, cross-root resolution, missing/unreadable paths, or any realpath outside the active proposal root.
8. Compute the relative path from `workspaceRootAbs`, normalize separators to `/`, and require it to begin with exactly `.lares/proposals/` or `.dashboard/proposals/`, matching the active state directory.
9. Store that normalized path in `plan.json.source_proposal.rel_path`.
10. Reject every basename-only fallback case.

The same validated proposal bytes feed identity derivation. The helper must not derive identity from one file while storing the path of another.

Parity/scaffold fixtures assert the actual manifest path for both variants:

```json
{ "source_proposal": { "rel_path": ".lares/proposals/example.md" } }
```

```json
{ "source_proposal": { "rel_path": ".dashboard/proposals/example.md" } }
```

Rejection fixtures cover cross-state-root inputs, proposal-root escape, `..` traversal, proposal or ancestor symlink/reparse escape, missing proposal, and the former basename-fallback case.

## 2. Server-authoritative preflight

The request is:

```ts
interface PromotionPreflightRequest {
  workspaceId: string;
  proposalDocumentId: string; // opaque planning-reader handle
  artifactIdCrossCheck?: string;
}
```

The renderer never supplies authoritative title, path, authored date, artifact ID, plan ID, or target folder.

Main must:

1. resolve the opaque handle through the planning-reader registry;
2. require it to belong to the requested workspace and have category `proposal`;
3. resolve its path beneath the active state directory's `proposals/` root;
4. reject absolute, escaping, symlinked, non-file, oversized, stale, or cross-workspace targets;
5. re-read the proposal bytes;
6. parse and validate frontmatter from those bytes;
7. require a non-empty portable `artifact_id`;
8. derive canonical identity from the server-read title, authored date, and artifact ID;
9. compare optional `artifactIdCrossCheck` and reject a stale/spoofed mismatch;
10. run the folder claim scan and legacy-pending lookup.

The result is:

```ts
type PromotionPreflightResult =
  | {
      status: 'allowed';
      proposalRelPath: string;
      planArtifactId: string;
      targetFolderRelPath: string;
    }
  | {
      status: 'already-adopted';
      proposalRelPath: string;
      planId: string;
      planArtifactId: string;
      folderRelPath: string;
    }
  | {
      status: 'folder-awaiting-adoption';
      proposalRelPath: string;
      planArtifactId: string;
      folderRelPath: string;
    }
  | { status: 'legacy-draining'; requestId: string; detail: string }
  | { status: 'duplicate-blocked'; folderRelPaths: string[]; detail: string }
  | { status: 'foreign-blocked'; folderRelPath: string; detail: string };
```

`proposalRelPath` comes only from the same contained, server-read file used for identity derivation. It is normalized workspace-relative POSIX form under the active `.lares/proposals/` or `.dashboard/proposals/` root.

`already-adopted` requires both one valid matching folder and a live same-workspace plan row. Only that outcome permits navigation. `folder-awaiting-adoption` blocks another dispatch and offers/runs the existing refresh mechanism.

Tests reject stale/spoofed artifact cross-checks, cross-workspace handles, missing identity, foreign document categories, proposal-root escape, symlinks, and stale handles.

## 3. Sole user-visible gesture and dispatch binding

The only steady-state route is:

1. Open an unpromoted proposal card.
2. Pull **Promote to plan**.
3. Select/create/revive a supervisor in `PromoteToPlanPanel`.
4. Run server-authoritative preflight.
5. If allowed, send that supervisor one instruction to run `proposal-to-plan`.
6. The skill atomically scaffolds the canonical folder.
7. The common coordinator adopts and reconciles the folder.
8. A3/B1's proposal-file stamp updates gallery state.

The panel reports “assigned,” never “plan created.”

`PromoteToPlanPanel` stops accepting `proposalFilePath` as dispatch authority. It accepts the opaque `proposalDocumentId`, workspace ID, and optional artifact cross-check.

The dispatch sequence is:

1. Capture `{workspaceId, proposalDocumentId}` for the selected card.
2. Invoke preflight for that exact pair.
3. For `allowed`, build the supervisor instruction exclusively from `result.proposalRelPath`.
4. Before sending, require the current selected pair to equal the pair that produced the result.
5. If selection changed, discard the result and run a new preflight.
6. Never fall back to the card's absolute path, filename, cached content, or renderer metadata.

The instruction contains the exact server-returned path, for example:

```text
Proposal path: .lares/proposals/example.md
```

or:

```text
Proposal path: .dashboard/proposals/example.md
```

The launched/revived supervisor works from the workspace root, so this relative path is the canonical skill input.

### Concurrent-preflight limitation and loser contract

Preflight is intentionally read-only. Two renderer instances can both receive `allowed` before either scaffold exists. The skill's atomic scaffold remains the concurrency authority.

The loser rule must exist in both the renderer-generated instruction and the deployed `references/activities/promote.md`:

> If scaffold reports matching EEXIST/resume, run `orient` and inspect the latest valid `assigned` event. If another supervisor is responsible, stop without mutating the folder, appending a reassignment, or continuing hardening.

Thus concurrent dispatch may create two supervisors, but it produces one scaffold and one responsible writer; the loser performs read-only orientation and stops.

## 4. Awaited common reconciliation coordinator

Add:

```ts
interface PlanFolderProjectionResult {
  planId: string;
  folderRelPath: string;
  sourceProposal: SourceProposalProjectionResult;
  responsibility: ResponsibilityProjectionResult;
  workPackages: WorkPackageProjectionResult;
}

reconcilePlanFolderProjections(input): Promise<PlanFolderProjectionResult>
```

Order:

1. ensure/adopt the live plan row;
2. scan the intent ledger;
3. reconcile source-proposal linkage;
4. reconcile responsibility;
5. reconcile the WP snapshot;
6. invoke optional downstream callbacks.

The projections are independently atomic. The coordinator is single-flight per plan/folder and is called by boot adoption, live watcher changes, periodic reconciliation, manual refresh, forced readiness/Implement refresh, and the legacy drain.

The watcher may retain detached boot callback behavior, but callers requiring convergence must await or join the coordinator's single-flight. `adoptPlanFolder` alone never proves convergence.

A legacy request becomes adopted only when source status is `synced` and responsibility status is `valid`. WP validity remains independent.

## 5. Source-proposal projection

Add:

```sql
CREATE TABLE IF NOT EXISTS plan_source_proposal_projection_state (
  plan_id                 TEXT PRIMARY KEY
                          REFERENCES plans(id) ON DELETE CASCADE,
  workspace_id            TEXT NOT NULL,
  status                  TEXT NOT NULL
                          CHECK (status IN ('absent','synced','invalid','conflict')),
  source_artifact_id      TEXT,
  source_rel_path         TEXT,
  diagnostic_code        TEXT,
  diagnostics_json        TEXT NOT NULL DEFAULT '[]',
  observed_manifest_mtime INTEGER,
  reconciled_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_source_projection_workspace_status
ON plan_source_proposal_projection_state(workspace_id, status);
```

Add `getPlanSourceProposalProjectionState(planId)`. Each observation replaces status/diagnostic fields; a valid observation clears old diagnostics. Invalid/conflicting input updates only this status table. `buildPlanDocuments` surfaces invalid/conflict warnings.

For a valid source, one `BEGIN IMMEDIATE` transaction:

- resolves one same-workspace proposal matching both artifact and contained canonical path;
- sets `plans.source_proposal_id`;
- sets `plans.promoted_at` only when absent, using valid stable `plan.json.created_at`;
- sets the proposal's promoted state/link;
- creates or updates one proposal document;
- sets `plan_documents.artifact_ref` to the proposal artifact;
- records source projection `synced`.

It never writes responsibility, `supervisor_active_plan`, packages, or request state.

Proposal-document policy:

- zero rows: insert deterministic `plandoc:proposal:<plan_artifact_id>`;
- one identity-matching row, or one legacy row with null `artifact_ref` and matching path: reuse its ID and fill identity fields;
- one mismatching row: conflict, no linkage writes;
- multiple rows: conflict, no deletion or linkage writes.

Add a repeatable partial-unique-index migration:

```sql
CREATE UNIQUE INDEX idx_plan_documents_one_proposal_per_plan
ON plan_documents(plan_id)
WHERE doc_kind = 'proposal';
```

Create it only when no duplicate group exists. Otherwise defer it and record conflicts for affected structured plans. Never auto-delete document rows that may back handles or comments.

B2's contained manifest fallback remains required while DB linkage is absent or converging.

## 6. Legacy migration policy

No new `promotion_requests` rows are created after migration.

Existing rows:

- `adopted`: terminal history; never re-enrich or dispatch;
- `failed`: terminal history; retain reason while the table exists and allow a new skill gesture;
- `pending`: blocks a new gesture for that proposal until explicitly adopted or failed.

The drain scans all valid folders for the proposal artifact rather than assuming the persisted filename-derived target path.

### Matching folder

- One claimant: adopt it and await common reconciliation.
- Mark adopted only when source is `synced` and responsibility is `valid`.
- Duplicate claimants: remain pending with a queryable diagnostic.

### Never reserved

Before classifying, inspect `promotion.reserved` event payloads for the request ID:

- exactly one matching run: repair the pointer atomically;
- no run: fail with `legacy-never-reserved` and retry-from-card guidance;
- multiple runs: remain pending as inconsistent.

Do not dispatch a new worker.

### Reserved-unbound

No body was submitted and no agent is bound. Atomically mark the orchestration `aborted` and request `failed` with `legacy-not-delivered`.

### Bound-undelivered

A bound worker may be alive even though no body was submitted.

1. Resolve the exact bound member.
2. Invoke the existing `AgentSupervisor.stopAgent(agentId)` lifecycle through an injected drain seam; do not kill the process directly.
3. Re-read DB agent state and the supervisor's live process registry.
4. Require a verified terminal outcome: agent status `done|crashed` or missing agent row, and no live process/runtime handle.
5. Only then atomically mark the orchestration `aborted` and request `failed` with `legacy-not-delivered`.

If stop throws, the process remains live, runtime state is unreadable, or shutdown cannot be verified, retain the request pending with `legacy-bound-agent-stop-unconfirmed`. Retirement remains blocked. A crash after verified stop but before DB terminalization is safe: the next drain observes the stopped agent and completes terminalization.

### Submitted-unconfirmed

Never reconstruct or retype the body.

- If a matching folder or newly discovered turn-start witness exists, enter the delivered branch.
- If the run and bound agent are live, use submit-only recovery, then re-witness turn start.
- Never press Enter against a terminal or missing agent.
- If the run is terminal, or the bound agent is terminal/missing, and there is no folder or turn-start witness, atomically fail with `legacy-submitted-unconfirmed-terminal`.
- If the run is terminal but its bound agent remains live, safely stop and verify the agent before failing; otherwise retain pending.
- If witness or agent state is unreadable/ambiguous, retain pending with a diagnostic.

### Delivered

Never send another body.

- Scan all valid folders for the proposal artifact.
- Live run with no folder: remain pending.
- Terminal run with no folder: fail with `legacy-delivered-no-folder`.
- One folder: await common reconciliation and apply the source/responsibility gate.
- Duplicate folders: remain pending with conflict diagnostics.

Because no retained branch reconstructs a body, legacy prompt factories are deleted after historical event-shape fixtures cover submitted/delivered classification.

### Drain scheduling

Run the single-flight drain after boot adoption, on matching structured-folder settlement, during bounded periodic reconciliation, and immediately before retirement evaluation.

The old general `pendingLatches` map is deleted. The durable pending row gates preflight.

## 7. Retirement readiness

Create `applied_migrations` before deciding whether to create `promotion_requests`. Once the retirement marker exists, initialization must not recreate the table.

Orchestration states:

- nonterminal: `starting`, `running`;
- terminal: `complete`, `stalled`, `aborted`, `error`.

After awaiting the drain single-flight, retirement requires:

- zero pending request rows;
- zero nonterminal `name='promotion'` orchestrations, including orphans;
- no request/run pointer disagreement;
- no unverified live bound promotion agent;
- no active drain.

Disagreement policy:

- one event-proven run repairs a missing request pointer;
- zero recoverable runs explicitly fails a pending request;
- multiple candidates remain pending;
- terminal request plus nonterminal run blocks retirement;
- orphan nonterminal run blocks retirement and emits a diagnostic.

When ready, atomically drop `promotion_requests` and record the marker. The helper tolerates an already-absent table. Unavailable workspaces with pending evidence block retirement.

## 8. Scaffold deployment obligations

Changes to `plan-manifest.mjs` and `references/activities/promote.md` must follow `scaffold-content-needs-version-bump`.

Concrete requirements:

1. Update `PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS` so the deployed helper imports `./plan-identity.mjs` and performs the path validation in §1.
2. Add `PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS` to the proposal-to-plan scaffold tree for every Claude/Codex supervisor and worker skill root.
3. Add the `scripts/plan-identity.mjs` scaffold-map entry at version 1.
4. Bump `scripts/plan-manifest.mjs` from version 3 to version 4.
5. Re-derive the pristine current v3 helper hash before editing; freeze it in `proposal-to-plan-old-body-fixtures.ts` or a dedicated fixture and add it as `previousHashes[3]`.
6. Update `PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD` with the matching-EEXIST responsibility/loser rule.
7. Bump `references/activities/promote.md` from version 2 to version 3.
8. Re-derive and freeze the pristine current v2 promote-playbook hash and add it as `previousHashes[2]`.
9. Extend `src/main/supervisor/scaffold-version-migration.test.ts` to prove pristine upgrades, the new identity module, preservation/backup of locally modified copies, and mutually compatible fresh scaffolds.
10. Run the scaffold registry/optimizer suites and main compile.
11. Rebuild/relaunch the app.
12. Launch an agent in an existing workspace and verify deployed `plan-manifest.mjs` v4, `plan-identity.mjs`, and `promote.md` v3.
13. Execute identity/path parity and scaffold smoke tests from that deployed skill copy.

Do not patch existing deployed skill copies manually; the versioned scaffolder performs the migration.

## 9. Deletion and retention inventory

| Surface | Disposition |
|---|---|
| `src/renderer/components/plan/PromoteDialog.tsx` and test | delete-now |
| `src/renderer/components/plan/PromoteToPlanPanel.tsx` and test | keep/update as sole gesture |
| Renderer `promotion-dispatch.ts` and test | keep/update with server-returned path and loser instruction |
| `ProposalCardGallery.tsx` / proposal metadata | keep/update; pass opaque document handle |
| `src/main/plans/promote-proposal.ts` | delete after neutral types are extracted |
| Filename-derived identity helpers | delete/replace |
| `src/main/plans/promotion-claim-scan.ts` and test | keep/update |
| Main `promotion-dispatch.ts` | retain-inert/reduce to evidence and submit-only recovery |
| Legacy prompt factories | delete after fixture coverage |
| `promotion-reconciler.ts` | refactor to `legacy-promotion-drain.ts` |
| `src/main/plans/proposal-promote-ipc.test.ts` | delete/replace with preflight suite |
| `promotion-service-wiring.test.ts` | delete/replace |
| Old `proposal:promote` / `proposal:promotionStatus` handlers | delete-now |
| Old preload bindings/shared result types | delete/replace |
| Startup live saga assembly | delete/replace with coordinator/preflight/drain wiring |
| Promotion-request insertion/retry APIs | delete-now |
| Migration reads/evidence/terminal transitions | retain-inert |
| `promotion_requests` table | retain until gated drop |
| Promotion-specific events and boot-abort exclusion | retain-inert while legacy/orphan runs may exist |
| Common coordinator and source status schema/read API | keep |
| `plan_documents` | keep/harden |
| `plan_work_packages` and sibling tables | keep; sibling reconciler only |
| `plan-manifest.ts` lock interop | keep |
| Generated `plan-identity.mjs` and canonical identity source | keep |
| Legacy HTML surface | untouched |

## 10. Work packages

### WP-PROMOTE-1 — Canonical identity, path validation, versioned skill deployment, and preflight

**Files**

- new `src/shared/plan-identity.ts`
- new `scripts/generate-plan-identity-module.mjs`
- `src/shared/constants.ts:5712-5850,6353-6851`
- `src/main/supervisor/index.ts:1238-1306`
- `src/main/supervisor/proposal-to-plan-old-body-fixtures.ts`
- `src/main/supervisor/scaffold-version-migration.test.ts`
- new `src/main/plans/promotion-preflight.ts`
- `src/main/plans/promotion-claim-scan.ts`
- identity, claim, planning-reader, IPC, and scaffold tests

**Do**

- Implement server-read canonical identity and canonical active-state-root proposal paths.
- Perform every version/hash/tree obligation in §8.
- Implement opaque-handle preflight and all six outcomes.
- Return `proposalRelPath` derived from the validated file.
- Move claim types out of the retiring service.

**Acceptance**

- Main and deployed helper identities match across the complete fixture matrix.
- `.lares` and `.dashboard` manifests contain the exact canonical source path.
- Spoofed/stale IDs, cross-workspace handles, missing identity, unsafe/cross-root/symlink paths, and foreign categories reject.
- Claim without live plan returns awaiting-adoption.
- Preflight cannot derive identity from a different file than its returned `proposalRelPath`.
- Existing-workspace agent-launch verification proves scaffold migration.

### WP-PROMOTE-2 — Awaited coordinator and source projection

**Files**

- new `src/main/plans/plan-folder-reconciler.ts`
- new `src/main/plans/plan-source-proposal-reconciler.ts`
- `src/main/plans/plan-folder-watcher.ts:188-401,409-479`
- `src/main/plans/plan-documents.ts:66-105,260-313`
- `src/main/database.ts:1779-1806,1912-1930,7988-8069`
- coordinator, source transaction, comments, and uniqueness-migration tests

**Dependency:** coordinate with `WP-INGEST-2/3`.

**Acceptance**

- Awaiting the coordinator proves source/responsibility completion.
- Boot detachment cannot prematurely complete a legacy request.
- Source reconciliation is stable and idempotent.
- Duplicate/mismatching proposal documents produce durable conflicts without deletion.
- Projection failures remain independent.

### WP-PROMOTE-3 — Sole mounted gesture

**Files**

- `src/renderer/components/plan/ProposalCardGallery.tsx`
- `src/renderer/components/plan/PromoteToPlanPanel.tsx`
- `src/renderer/components/plan/promotion-dispatch.ts`
- proposal card metadata
- `src/main/plans/plan-ipc.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- delete dialog and old IPC tests

**Dependencies:** WP-PROMOTE-1/2.

**Do**

- Remove old mutate/status channels.
- Pass only workspace ID, opaque proposal handle, and optional artifact cross-check.
- Build the instruction only from preflight's `proposalRelPath`.
- Bind cached results to the workspace/document pair and invalidate them on selection changes.

**Acceptance**

- Only `already-adopted` navigates.
- A stale/different renderer path cannot enter the instruction.
- The instruction contains the exact server-returned `.lares/proposals/...` or `.dashboard/proposals/...` path.
- Changing the selected proposal forces a new preflight.
- Renderer dispatch APIs accept no absolute proposal-path authority.
- Concurrent dispatch produces one writer and a cleanly stopped loser.

### WP-PROMOTE-4 — Authority-safe legacy drain and retirement

**Files**

- refactor/rename promotion reconciler
- reduce main promotion dispatch
- `src/main/index.ts:997-1105`
- `src/main/database.ts:394-440,1947-1969,3133-3283,7718-7986`
- promotion request, delivery, lifecycle-stop, startup, and drop tests

**Dependency:** WP-PROMOTE-2.

**Acceptance**

- No undelivered attempt receives a body.
- Submitted recovery never targets a terminal/missing agent.
- `legacy-submitted-unconfirmed-terminal` is deterministic.
- `legacy-not-delivered` leaves no live bound worker; unverifiable shutdown remains pending.
- Every orphan nonterminal promotion run blocks retirement.
- The table drops once after an awaited clean drain and is never recreated.

### WP-PROMOTE-Z — Single-writer integration gate

Prove end to end:

1. server-read identity equals deployed scaffold identity;
2. both state-directory variants write the exact canonical `source_proposal.rel_path`;
3. renderer identity/path spoofing is rejected;
4. changing selected proposal after preflight invalidates the result;
5. the instruction contains only the server-returned relative proposal path;
6. claimed-but-unadopted folders never navigate;
7. no new promotion request is created;
8. source, responsibility, and packages reconcile through their sole owners;
9. repeated refresh/restart creates no duplicate rows;
10. every legacy crash-matrix branch is safe;
11. bound-undelivered shutdown is verified before failure;
12. submitted-unconfirmed terminalization never presses Enter;
13. orphan promotion runs block retirement;
14. concurrent allowed preflights yield one scaffold, one responsible writer, and one non-mutating loser;
15. old promotion IPC handlers are absent;
16. B2 reads the proposal before DB linkage converges.

Run the full main suite, relevant renderer sibling suites, both TypeScript builds, rebuild/relaunch, and the existing-workspace deployed-skill launch check.

## Explicit non-goals

- No change to bundle contracts, ARC syntax, sentinels, rung ladder, or orchestration modes.
- No second WP parser or package writer.
- No redesign of readiness, Mark Ready, Implement, or overview mapping.
- No automatic execution lifecycle actions.
- No reconstruction of transient `supervisor_active_plan`.
- No automatic deletion of duplicate proposal-document rows.
- No mounting or redesign of `PromoteDialog`.
- No legacy HTML-plan changes.


<!-- groupthink_run: c090565e (mode=serial) -->
