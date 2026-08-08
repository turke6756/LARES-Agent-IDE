---
plan_artifact_id: plan_e0001372
kind: work-packages
authored_at: 2026-08-05
author: supervisor ae889b24
---

# Work packages — plan_e0001372

Merged and re-cut by the responsible supervisor from the three folded
deliberations. The deliberations each proposed their own package set
(`WP-INGEST-1..4+Z`, `WP-HOV-1..4+Z`, `WP-PROMOTE-1..4+Z`); those sets overlap
on shared machinery, so dispatching them verbatim would put three workers in
the same files and ship duplicate implementations. This is the authoritative
cut. Each package below cites the deliberation package(s) it subsumes.

**Baseline:** `plan-baseline/2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372`
at commit `e46ae812` (local annotated tag, never pushed). Anything a package
deletes is one `git show <tag>:<path>` away — no copy-aside archiving.

**The three couplings that forced the re-cut** (all three deliberations found
them independently):
1. One strict-JSON helper serves both `PLAN-WORK-PACKAGES:v1` and
   `PLAN-TAB-OVERVIEWS:v1` — never two implementations.
2. One coordinated scaffold revision: `WP-INGEST-1`, `WP-HOV-1`, and
   `WP-PROMOTE-1`'s §8 all edit the same constants, tree, and fixtures.
3. One readiness evaluator: `refreshAndGetPlanReadiness(planId)` — `WP-HOV-4`
   extends it rather than interpreting in parallel.

**Dispatch waves** (dependency order, not a schedule):

| Wave | Packages |
|---|---|
| 1 | WP-A, WP-J |
| 2 | WP-B |
| 3 | WP-C → WP-D (same watcher seam; sequence, do not parallelize) |
| 4 | WP-E, WP-G |
| 5 | WP-F, WP-H, WP-I |
| 6 | WP-Z |

> ⚠ **CROSS-PLAN ORDERING — read before dispatching anything.** These waves are
> *within-plan only*. plan_0e1425af (proposal-lifecycle split, supervisor
> ac1cb0b6) interleaves with this plan; the binding merged order is in
> `../ARC.md` §"Cross-plan boundary". Summary: `WP-A ∥ WP-J` → their WP-1 →
> their WP-2/3/4 (second scaffold bump) → their WP-5 → WP-B → WP-C → WP-D →
> WP-E → WP-G/H/I → **WP-F** → their WP-6 → WP-Z. Each arrow is a full gate.
> **WP-A must gate completely before their WP-1 or WP-2/3/4 start** — all three
> edit `src/shared/constants.ts` while re-deriving pristine scaffold hashes, and
> running them concurrently breaks the scaffold migration chain for existing
> workspaces. The machine block below cannot express cross-plan dependencies;
> it is not the ordering authority.

> **Provisional machine block.** The `PLAN-WORK-PACKAGES:v1` block below is
> written to the contract `int_4f8b2d61` specifies, but no parser exists yet —
> WP-A freezes the contract and WP-C implements the parser. WP-A must validate
> this block against the frozen contract and correct it if they diverge. It is
> deliberately present so this plan is the first dogfood of its own format.

<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_e0001372",
  "packages": [
    { "id": "WP-A", "order": 10, "title": "Shared foundations: strict JSON, plan identity, one coordinated scaffold revision", "initial_state": "ready",
      "acceptance_conditions": ["Fresh scaffolds carry all contracts; pristine playbooks migrate; hand-edited copies are preserved.", "All WP-A scaffold changes migrate as one compatible gate; no second strict-JSON implementation exists."],
      "paths": [{"path":"src/shared/plan-identity.ts","intent_kind":"create"},{"path":"src/main/plans/strict-json.ts","intent_kind":"create"},{"path":"src/shared/constants.ts","intent_kind":"edit"},{"path":"src/main/supervisor/index.ts","intent_kind":"edit"}],
      "depends_on": [] },
    { "id": "WP-J", "order": 20, "title": "Unhardened surface items (B1, B2, B5)", "initial_state": "ready",
      "acceptance_conditions": ["A promoted proposal leaves the active gallery without losing history.", "The Proposal tab renders from the manifest when no DB row exists.", "The review column explains why it is empty instead of erroring."],
      "paths": [{"path":"src/renderer/components/plan/ProposalCardGallery.tsx","intent_kind":"edit"},{"path":"src/main/plans/plan-documents.ts","intent_kind":"edit"},{"path":"src/main/plans/plan-ipc.ts","intent_kind":"edit"}],
      "depends_on": [] },
    { "id": "WP-B", "order": 30, "title": "DB companions and atomic work-package reconciliation", "initial_state": "blocked",
      "acceptance_conditions": ["Fault injection after every mutation stage rolls back the whole snapshot.","No path hard-deletes a package row.","Order-only changes do not increment revision."],
      "paths": [{"path":"src/main/database.ts","intent_kind":"edit"}],
      "depends_on": ["WP-A"] },
    { "id": "WP-C", "order": 40, "title": "Work-package parser, responsibility reconciliation, watcher seam", "initial_state": "blocked",
      "acceptance_conditions": ["Boot/adopt/change/periodic/manual refresh converge identically.","Missing or malformed supplements preserve all package rows.","Boot order never assigns a supervisor's active plan."],
      "paths": [{"path":"src/main/plans/plan-work-package-ingest.ts","intent_kind":"create"},{"path":"src/main/plans/plan-folder-watcher.ts","intent_kind":"edit"}],
      "depends_on": ["WP-B"] },
    { "id": "WP-D", "order": 50, "title": "Human-overview parser, projection, adoption state, watcher convergence", "initial_state": "blocked",
      "acceptance_conditions": ["Duplicate JSON/frontmatter keys reject; fenced headings cannot truncate a section.","Invalid input preserves bodies but blocks readiness.","Lower-mtime edits and rename-aways converge.","An observed invalid source can never restore never-seen seeding."],
      "paths": [{"path":"src/main/plans/plan-human-overview.ts","intent_kind":"create"},{"path":"src/main/plans/plan-folder-watcher.ts","intent_kind":"edit"}],
      "depends_on": ["WP-C"] },
    { "id": "WP-E", "order": 60, "title": "Common folder-reconciliation coordinator and source-proposal projection", "initial_state": "blocked",
      "acceptance_conditions": ["Awaiting the coordinator proves source and responsibility completion.","Boot detachment cannot prematurely complete a legacy request.","Duplicate or mismatching proposal documents produce durable conflicts without deletion."],
      "paths": [{"path":"src/main/plans/plan-folder-reconciler.ts","intent_kind":"create"},{"path":"src/main/plans/plan-source-proposal-reconciler.ts","intent_kind":"create"}],
      "depends_on": ["WP-D"] },
    { "id": "WP-G", "order": 70, "title": "Optimistic overview disk editor and truthful Packages state", "initial_state": "blocked",
      "acceptance_conditions": ["In-app writes serialize; a stale source hash rejects at final observation.","No code or test claims atomic compare-and-swap.","Replacement failure leaves the destination byte-identical and removes the temp.","Populated Packages never shows the unimplemented placeholder."],
      "paths": [{"path":"src/main/plans/plan-ipc.ts","intent_kind":"edit"},{"path":"src/renderer/components/plan/PlanDocumentTabs.tsx","intent_kind":"edit"}],
      "depends_on": ["WP-D"] },
    { "id": "WP-F", "order": 80, "title": "Server-authoritative preflight and the sole mounted promote gesture", "initial_state": "blocked",
      "acceptance_conditions": ["Only already-adopted navigates.","A renderer-supplied path can never enter the supervisor instruction.","Concurrent dispatch yields one scaffold, one responsible writer, one non-mutating loser.","Exactly one identity derivation exists in the tree: derivePlanSku and every caller are gone, guarded by a test."],
      "paths": [{"path":"src/main/plans/promotion-preflight.ts","intent_kind":"create"},{"path":"src/renderer/components/plan/PromoteToPlanPanel.tsx","intent_kind":"edit"},{"path":"src/main/plans/promote-proposal.ts","intent_kind":"delete"},{"path":"src/renderer/components/plan/PromoteDialog.tsx","intent_kind":"delete"}],
      "depends_on": ["WP-E"] },
    { "id": "WP-H", "order": 90, "title": "Shared readiness evaluator: forced refresh, Mark Ready, Implement", "initial_state": "blocked",
      "acceptance_conditions": ["A valid packaged plan with valid supervisor and complete overviews reaches hardening -> ready -> executing by two explicit human actions.","Only-blocked packages cannot Mark Ready.","Invalid refresh prevents any git baseline operation.","One evaluator serves both gates."],
      "paths": [{"path":"src/main/plans/plan-lifecycle.ts","intent_kind":"edit"},{"path":"src/main/plans/plan-implement.ts","intent_kind":"edit"}],
      "depends_on": ["WP-E"] },
    { "id": "WP-I", "order": 100, "title": "Authority-safe legacy promotion drain and gated retirement", "initial_state": "blocked",
      "acceptance_conditions": ["No undelivered attempt ever receives a body.","legacy-not-delivered leaves no live bound worker; unverifiable shutdown stays pending.","Every orphan nonterminal promotion run blocks retirement.","The table drops once after an awaited clean drain and is never recreated."],
      "paths": [{"path":"src/main/plans/legacy-promotion-drain.ts","intent_kind":"create"},{"path":"src/main/index.ts","intent_kind":"edit"}],
      "depends_on": ["WP-E"] },
    { "id": "WP-Z", "order": 110, "title": "End-to-end gate: promote to implement on one skill-driven plan", "initial_state": "blocked",
      "acceptance_conditions": ["A proposal promoted through the sole gesture reaches Implement with no manual DB work, driven through the post-split skill set.","Restart and repeated refresh are idempotent.","Every legacy crash-matrix branch is safe.","A pre-WP-A workspace migrates across both scaffold bumps in one launch with no file falling to the user-modified backup path.","The retired capture playbook leaves no orphan on disk."],
      "paths": [],
      "depends_on": ["WP-F", "WP-G", "WP-H", "WP-I", "WP-J"] }
  ]
}
-->

## WP-A - Shared foundations: strict JSON, plan identity, one coordinated scaffold revision

Subsumes `WP-INGEST-1`, `WP-HOV-1`, and the §1/§8 scaffold obligations of
`WP-PROMOTE-1`. **This package exists because those three would otherwise
collide in `src/shared/constants.ts`.** It is the single serialization point of
the whole plan — one worker, one scaffold revision.

**Files**
- `package.json`, `package-lock.json` (add `jsonc-parser`)
- new `src/main/plans/strict-json.ts` + test
- new `src/shared/plan-identity.ts`; new `scripts/generate-plan-identity-module.mjs`
- `src/shared/constants.ts` — `PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD:5917`,
  `PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD`, new
  `PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD`, new
  `PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD`,
  `PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS` (v3→v4), new
  `PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS` (v1), and the SKILL.md continuity
  rule (item A2)
- `src/main/supervisor/index.ts:1238-1306` (`PROPOSAL_TO_PLAN_TREE`, Claude + Codex roots)
- `src/main/supervisor/proposal-to-plan-old-body-fixtures.ts`
- `src/main/supervisor/scaffold-version-migration.test.ts`

**Dep:** none.

**Do**
- Load `scaffold-content-needs-version-bump` before touching scaffold content.
- Implement one duplicate-key-rejecting strict-JSON helper (`parseTree`,
  comments and trailing commas disabled) used by both v1 block parsers.
- Implement canonical frontmatter-derived identity in `src/shared/plan-identity.ts`
  and generate the deployed `plan-identity.mjs` sibling from it. **Delete** the
  filename-derived SKU logic at `src/main/plans/promote-proposal.ts:71-76` and
  the substring/basename fallback in the deployed helper's `toRelProposal()`;
  replace with realpath-validated derivation under the active `.lares`/`.dashboard`
  state root (see the promote deliberation §1).
- Freeze both v1 contracts (`PLAN-WORK-PACKAGES:v1`, `PLAN-TAB-OVERVIEWS:v1`)
  and validate this file's own provisional block against the frozen shape.
- Update the `package` playbook once, covering: the disk-derived tab inventory,
  the mandatory `OVERVIEW.md` write, and both validation steps. Include the
  register rule as a literal sentence with U+2014:
  *written for the workspace owner — no sentinel names, no rung jargon, no file:line.*
- Add item A2's continuity rule (no "phase done, continue?" pauses between
  scope→promote→deliberate→integrate→package; the one built-in stop is after
  `package`) and item A3's promote-time proposal frontmatter stamp
  (`promoted_to`, `promoted_at`, Status refresh).
- Re-derive every pristine current hash **before** editing; freeze old bodies;
  add `previousHashes` entries; bump `plan-manifest.mjs` 3→4 and `promote.md` 2→3.
- Add the matching-EEXIST loser rule to `promote.md`: on a matching resume,
  run `orient`, and if another supervisor is responsible, stop without mutating,
  reassigning, or continuing.
- Do **not** hand-patch deployed `.lares/*/skills` copies.

**Cross-plan constraints (boundary A / M6 — binding, agreed with plan_0e1425af)**
- Leave the `capture` mode row in the dispatcher SKILL.md **byte-untouched**.
  Do not delete it and do not author text that assumes it survives — their WP-4
  owns that row and removes it in the next bump.
- Do **not** assert "exactly one scaffold revision" in any comment or test. A
  second scaffold bump (their WP-2/3/4) follows this one in the same chain, and
  such an assertion would fail it. The unrelated "exactly one strict-JSON
  implementation" assertion below is fine and stays.
- `src/main/plans/promote-proposal.ts:71-76` is **deleted, not repaired** — WP-F
  removes that file entirely. Do not spend effort making it correct.
- This package must **gate fully** before their WP-1 and WP-2/3/4 begin. Nothing
  from either plan may touch `src/shared/constants.ts` concurrently with it.
- **Write the A2 continuity rule as a self-contained block in `SKILL.md`, not
  woven into the trigger prose** (boundary gap 3). plan_0e1425af's WP-4 rewrites
  this file's trigger description and mode table in the very next scaffold
  revision. A2 must survive that rewrite verbatim; a rule embedded in trigger
  sentences will not. Add a test asserting A2's presence so their bump breaks
  loudly if it drops it.
- **`previousHashes` is a cumulative `Record<version, hash>`, not a
  latest-only field** (`scaffold-writer.ts:132` scans every value; `:186` falls
  back to entry `1`). Every entry this package bumps must ADD its new hash and
  PRESERVE all prior entries — see `capture.md` at `supervisor/index.ts:1278`
  for the existing `{1:…, 2:…}` shape at version 3. Dropping an entry sends
  older workspaces down the user-modified `.bak` path instead of migrating them,
  silently, and only on a real workspace after restart.
- **promote.md EEXIST loser rule — RESOLVED wording (boundary gap 4).** Do NOT
  write "run `orient`" (plan_0e1425af's WP-3 splits orient's reporting half into
  a read-only skill, so that stops being one coherent action). Instead **cite the
  anchor**: "…on a matching resume, apply the responsible-supervisor
  determination in `references/contracts/responsibility.md` §Determination. If
  another supervisor is responsible, stop without mutating, reassigning, or
  continuing."
- **WP-A CREATES that contract file at v1** (boundary gap 6) — new
  `references/contracts/responsibility.md` plus its `PROPOSAL_TO_PLAN_TREE`
  entry. **Citation and referent must land in the SAME gate.** If their WP-4
  created it instead, WP-A would ship a deployed, agent-facing dangling pointer
  into every real workspace for the entire interval between the two gates — a
  live broken reference inside a playbook an agent is actively following, which
  no test would catch. Their catch, and it is right.
- The §`Determination` body is **lifted from the rules `orient.md` already
  carries** — this is co-location, not new design. Do not invent or extend the
  responsibility rules here. Their WP-4 then strips the duplicated rules from
  `orient.md`, cites the contract, and **owns its content from v2 onward**;
  WP-A owns v1 only.

**Accept**
- Fresh scaffolds carry both contracts, the identity module, and the updated
  playbooks; pristine previous copies migrate automatically; locally modified
  copies are preserved/backed up.
- Main and the deployed helper produce identical identity across a fixture
  matrix including filename/title disagreement, punctuation, empty titles,
  truncation, quoted scalars, explicit overrides, missing `authored_at`,
  artifact IDs with and without `prop_`, and both state roots.
- Every basename-fallback and proposal-root-escape case rejects.
- The scaffold test asserts the register sentence's literal U+2014 bytes.
- Exactly one strict-JSON implementation exists in the tree.

**Non-goals:** no parser, DB, watcher, IPC, or renderer behavior.

**Verify:** scaffold registry + version-migration suites, frozen-hash
precondition, identity parity matrix, main `tsc`. Then rebuild/relaunch and
launch an agent in an existing workspace to prove deployed v4/v3 migration.

## WP-J - Unhardened surface items (B1, B2, B5)

The scope verdict marked these as needing no deliberation. Grouped because each
is small and they share the proposal/plan document surface.

**Files**
- `src/renderer/components/plan/ProposalCardGallery.tsx`, proposal card metadata
- `src/main/plans/planning-reader.ts:563-603`
- `src/main/plans/plan-documents.ts:90-97, 219-221`
- `src/main/plans/plan-ipc.ts:540-541`
- sibling gallery / document-tab / review-column tests

**Dep:** none in CODE (deliberately independent of WP-A so it can land in wave 1).
Its *acceptance* must not depend on WP-A either — see the amendment below.
**Cross-plan:** first writer on `ProposalCardGallery.tsx` +
`proposal-card-metadata.ts`; chain is **WP-J → their WP-1 → their WP-5 → WP-F**.

**Do**
- **B1:** filter cards carrying `promoted_to` frontmatter out of the active
  gallery, rendering them as a collapsed "promoted" group rather than deleting
  them, so history stays discoverable. Filesystem-consistent with the rest of
  the pane — do not introduce a DB read here.
  - **Gate on a FIXTURE-stamped proposal, never on WP-A's live promote
    behavior** (boundary M2). WP-A is what makes promote stamp at all, and this
    package must not acquire a hidden dependency on it.
  - The collapsed group renders **full card metadata, not a bare filename
    list** (boundary M4) — plan_0e1425af's WP-5 byline and WP-6 visual check
    have to work *inside* the group.
- **B1-backfill (one-time data fix, boundary D/M3):** stamp `promoted_to` /
  `promoted_at` onto the already-promoted proposals that lack it. Ground truth
  verified on disk 2026-08-05: **4 plan folders, 12 proposals, exactly 1
  stamped** — and that one was hand-stamped by a supervisor, because the
  deployed promote path stamps nothing today (WP-A item A3 is unbuilt). So
  **3 proposals need backfill**, including plan_0e1425af's own source
  `.lares/proposals/2026-08-05-proposal-lifecycle-split-authoring-vs-promotion.md`.
  Derive each `promoted_to` from the plan folder whose `plan.json`
  `source_proposal` points at that file — never from filename similarity.
  Without this, the filter makes *this* plan's proposal vanish from the active
  gallery while every other promoted proposal stays: asymmetric, reads as a
  bug, is not one. Touch **only** the two promote-time keys — the authoring-time
  block (`artifact_id`, `author*`, `authored_at`) belongs to their WP-2.
- **B2:** when no `plan_documents` proposal row exists, fall back to
  `plan.json.source_proposal.rel_path`, with containment checks, an opaque
  document reference, and deduplication once WP-E's linkage creates the real
  row.
- **B5:** while no execution run exists, render why the review column is empty
  ("no work packages implemented yet — pull Implement to begin") instead of
  throwing or showing a permanent blank.

**Accept**
- A **fixture-stamped** proposal leaves the active gallery on the next read and
  remains reachable in the promoted group, with full card metadata rendered.
- After backfill, all 4 promoted proposals are stamped and grouped — no
  promoted proposal remains in the active gallery.
- The Proposal tab renders from the manifest with no DB row, and does not
  double-render once a row appears.
- The review column never surfaces an error before the first execution run.

**Non-goals:** no WP ingest, no overview work, no promote-path changes.

**Verify:** gallery, planning-reader, document-tab, and review-projection
sibling suites; both `tsc`.

## WP-B - DB companions and atomic work-package reconciliation

Subsumes `WP-INGEST-2`.

**Files**
- `src/main/database.ts:1645-1667, 1992-2056, 4959-5320`
- new DB reconciliation test beside `database.planWorkPackages.test.ts`

**Dep:** WP-A (frozen input contract).

**Do**
- Add `plan_work_package_sources` and `plan_folder_projection_state` (including
  the overview columns WP-D will own) plus indexes. Leave the frozen
  `plan_work_packages` shape untouched.
  > **CORRECTION (2026-08-06, supervisor ae889b24, after WP-B gated).** Earlier
  > drafts of this document called that table **"eleven-column"**. That is
  > WRONG. Verified on disk at `src/main/database.ts:1652`: it has **TEN**
  > columns — `id`, `workspace_id`, `plan_id`, `title`, `acceptance_condition`,
  > `state`, `assignee_agent_id`, `revision`, `created_at`, `updated_at` — plus
  > two CHECK constraints. WP-B's worker hit the mismatch, preserved the REAL
  > shape, and reported the discrepancy rather than adding a column to satisfy
  > the prose. **Any package that finds prose and schema disagreeing must do the
  > same: the tree is authoritative, this document is not.** Do not "fix" the
  > table to match a description.
- Add queries for managed/unmanaged packages and runtime evidence (assignee,
  non-`disk-reconciler` lifecycle events, dispatch attempts, stamped turns,
  finalization, `executing`/`done`, execution runs).
- Implement the one-transaction applier: runtime-ownership rejection, internal
  disk lifecycle transitions reusing `plan-lifecycle.ts` logic, revision/order
  semantics, tombstones, safe `ready → hardening` demotion, and
  diagnostic-only conflict recording.
- Never call `upsertPlanWorkPackage` for an existing reconciled row — it
  overwrites state and assignee.

**Accept**
- Fault injection after every mutation stage rolls back the entire snapshot.
- A conflict preserves applied hashes, packages, paths, assignments, lifecycle
  and run state while recording observed drift.
- No path hard-deletes a package row.
- Order-only changes do not increment revision.

**Non-goals:** no parsing, watcher, IPC, or renderer changes.

**Verify:** new DB tests plus work-package, layout/path, lifecycle, dispatch,
stamped-evidence, and finalization sibling suites; main `tsc`.

## WP-C - Work-package parser, responsibility reconciliation, watcher seam

Subsumes `WP-INGEST-3`.

**Files**
- new `src/main/plans/plan-work-package-ingest.ts` + test
- `src/main/plans/plan-folder-watcher.ts:25-34, 188-401, 409-479` + test
- responsibility helpers in `src/main/database.ts:1884-1930, 5315-5333`

**Dep:** WP-B. Uses WP-A's strict-JSON helper — do not write another.

**Do**
- Strict bounded parsing of `PLAN-WORK-PACKAGES:v1`: canonical hashes (content
  digest excluding `order`, projection digest including it), casing-stable
  deterministic IDs, path and dependency validation, prose `## <id> - <title>`
  parity, re-stat before apply with one retry on a raced source.
- Independent fail-closed responsibility reconciliation: last `assigned` array
  entry wins (never sort by timestamp, never fall back to an older event);
  validate existence, same workspace, and supervisor privilege; **never** assign
  the new owner's `supervisor_active_plan`; clear a prior supervisor's pointer
  only when it targets this plan.
- Compose both projections at the watcher settled seam and the single-folder
  refresh path. Persist typed diagnostics durably — console logging alone is
  insufficient.

**Accept**
- Boot, adopt, change, periodic, manual, and forced refresh converge identically.
- Missing or malformed supplements preserve all package rows; only a valid
  complete replacement's omission archives a planning-owned package.
- Invalid latest responsibility clears stale DB authority without blocking a
  valid WP projection.
- Boot order never assigns a supervisor's active plan.

**Non-goals:** no readiness or renderer controls.

**Verify:** parser fixture matrix, watcher sibling suite, responsibility and
active-plan tests, restart idempotence, main `tsc`.

## WP-D - Human-overview parser, projection, adoption state, watcher convergence

Subsumes `WP-HOV-2`.

**Files**
- new `src/main/plans/plan-human-overview.ts` + test
- `src/main/database.ts:1933-1947, 3040-3088`; `src/shared/types.ts:5070-5100`
- `src/main/plans/plan-folder-watcher.ts:33-176, 302-397` + test
- `src/main/plans-watcher.ts:245-370` + structured watcher integration tests
- the `plan_folder_projection_state` migration from WP-B; new
  `plan_tab_overview_sources`

**Dep:** WP-C. **Sequence after WP-C, do not run in parallel** — both edit
`plan-folder-watcher.ts` at the same seam.

**Do**
- Parse `OVERVIEW.md`: frontmatter identity, one `PLAN-TAB-OVERVIEWS:v1` index
  outside fenced code, one begin/end delimiter pair per indexed tab,
  fence/newline-aware scanning, 1 MiB bound, rejection of `-->` in strings.
- Stream exact bytes through SHA-256 for the observed source token
  (`absent | unsafe | unreadable | sha256:<hex>`); reject symlink/junction
  escape, non-regular files, and canonical parents outside the folder.
- Project **all** stable tab keys atomically: mapped tabs get the body and
  `synced`, omitted tabs get NULL and `missing`; bump
  `plan_tab_overviews.revision` only when the effective body changes.
- Implement the monotonic adoption state (`never-seen → observed → projected`)
  gating one-time DB seeding, and the missing-source behavior (preserve bodies
  and provenance, block readiness, never reseed).
- Replace the scalar max-mtime watcher signature with
  `{maxManagedMtimeMs, overviewToken}` so creation, lower-mtime replacement,
  rename-away, and deletion all converge.

**Accept**
- Duplicate JSON or frontmatter keys reject; headings inside fenced code cannot
  truncate a section; CRLF and LF parse identically.
- Invalid input preserves last-applied bodies but blocks readiness.
- Invalid responsibility still projects, with `updated_by = NULL`.
- An observed invalid or removed source can never restore `never-seen` seeding.

**Non-goals:** no renderer editing, no lifecycle ownership.

**Verify:** parser matrix, DB fault injection, injected filesystem-observer
tests, conditional native safety tests (Windows junction/read-only, POSIX
symlink), watcher and PlansWatcher sibling suites, main `tsc`.

## WP-E - Common folder-reconciliation coordinator and source-proposal projection

Subsumes `WP-PROMOTE-2`.

**Files**
- new `src/main/plans/plan-folder-reconciler.ts`
- new `src/main/plans/plan-source-proposal-reconciler.ts`
- `src/main/plans/plan-folder-watcher.ts:188-401, 409-479`
- `src/main/plans/plan-documents.ts:66-105, 260-313`
- `src/main/database.ts:1779-1806, 1912-1930, 7988-8069`
- coordinator, source-transaction, and uniqueness-migration tests

**Dep:** WP-D.

**Do**
- Add the awaited single-flight `reconcilePlanFolderProjections(input)` running
  in order: adopt the plan row → scan the intent ledger → reconcile
  source-proposal linkage → reconcile responsibility → reconcile the WP
  snapshot → downstream callbacks. Projections stay independently atomic.
- Add `plan_source_proposal_projection_state` and its read API; implement the
  valid-source transaction (set `plans.source_proposal_id`, set `promoted_at`
  only when absent, link the proposal, create-or-update exactly one proposal
  document, set `artifact_ref`). It must never write responsibility,
  `supervisor_active_plan`, packages, or request state.
- Add the deferred partial unique index
  `idx_plan_documents_one_proposal_per_plan`, created only when no duplicate
  group exists; never auto-delete document rows that may back handles or
  comments.

**Accept**
- Awaiting the coordinator proves source and responsibility completion;
  `adoptPlanFolder` alone never proves convergence.
- Boot detachment cannot prematurely complete a legacy request.
- Source reconciliation is stable and idempotent across restart.
- Duplicate or mismatching proposal documents produce durable conflicts with no
  deletion and no linkage writes.

**Non-goals:** no WP parser changes, no readiness, no renderer.

**Verify:** coordinator, source, document-uniqueness, and watcher suites; main `tsc`.

## WP-F - Server-authoritative preflight and the sole mounted promote gesture

Subsumes `WP-PROMOTE-3` and the preflight half of `WP-PROMOTE-1`.

**Files**
- new `src/main/plans/promotion-preflight.ts`; `src/main/plans/promotion-claim-scan.ts`
- delete `src/main/plans/promote-proposal.ts` after extracting neutral types
- delete `src/renderer/components/plan/PromoteDialog.tsx` + test
- `src/renderer/components/plan/PromoteToPlanPanel.tsx`,
  `promotion-dispatch.ts`, `ProposalCardGallery.tsx`
- `src/main/plans/plan-ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`
- delete `proposal-promote-ipc.test.ts` and `promotion-service-wiring.test.ts`,
  replacing them with a preflight suite

**Dep:** WP-E (needs the coordinator), WP-A (identity). **Cross-plan:** also
after plan_0e1425af's WP-1 and WP-5 — WP-F is the LAST of four writers on
`ProposalCardGallery.tsx` / `proposal-card-metadata.ts` (chain WP-J → their
WP-1 → their WP-5 → WP-F).

**Cross-plan constraints (boundary B — binding, agreed with plan_0e1425af)**
- Their WP-1 lands the instruction template as the shared constant
  `PROPOSAL_PROMOTION_PROMPT_TEMPLATE`. **Preserve it as TEXT** and change only
  the values substituted into it. Their assertions must still be green after
  this package: the instruction contains `Do NOT run capture`, the artifact_id
  line, and the `scope -> promote -> deliberate -> integrate -> package`
  ordering. Do not rewrite the prompt wording as part of the rewiring.
- Their `isValidProposalArtifactId` **survives** as the panel-side input
  sanitizer, and its output feeds this package's `artifactIdCrossCheck?`
  preflight parameter. The renderer-supplied artifact id is a **cross-check,
  never authority** — that is what fills the optional parameter the preflight
  signature already carries.
- The path/identity authority transfer is the ONLY thing this package takes
  from the renderer. Removing their validator or template would be a
  boundary violation, not a simplification.

**INHERITED OBLIGATION — closing the dual-identity divergence (added 2026-08-06 by supervisor ae889b24 after gating WP-A).** This is a NAMED deliverable of this package, not an incidental consequence of deleting a file. **Do not treat it as done because `promote-proposal.ts` no longer exists — verify no caller survives.**

WP-A built the canonical frontmatter-derived identity in `src/shared/plan-identity.ts` but left `derivePlanSku()` in `src/main/plans/promote-proposal.ts` **live**, because this package deletes the file wholesale. As of WP-A's gate that function still derives plan identity from the proposal **filename**, with roughly ten call sites including `promotion-dispatch.ts`, `promotion-reconciler.ts`, `promotion-claim-scan.ts`, and `src/main/index.ts`. So between WP-A and this package the tree carries **two identity derivations whose disagreement is the exact failure this plan exists to prevent.** It is currently harmless only because filename and frontmatter title agree on every proposal on disk today — a coincidence, not an invariant, and one that stops holding the moment anyone renames a proposal or authors one whose title diverges from its basename.

- Re-derive the live call-site list yourself before starting (load `re-derive-inherited-values`); the count above was accurate at WP-A's gate and WPs B–E may have shifted it. **Do not delete a call site by assuming what it does** — several are on the promotion-reconciler path and consume the SKU as a durable folder key.
- Every surviving caller migrates to `src/shared/plan-identity.ts`. Where a caller needs the folder-path SKU specifically, take it from the canonical module's derivation, never from a basename.
- Both plans have been contractually barred from reading `derivePlanSku` since 2026-08-06 (ac1cb0b6 accepted this for plan_0e1425af's six packages), so any call site you find is pre-existing, never newly introduced. If you find a NEW one, that is a boundary violation — stop and report it to the responsible supervisor rather than quietly fixing it.
- Add a guard test asserting no filename-derived identity path exists in the tree, so this cannot silently return.

**Do**
- Implement preflight on `{workspaceId, proposalDocumentId, artifactIdCrossCheck?}`
  with the six typed outcomes; resolve the opaque handle server-side, re-read
  the proposal bytes, and derive identity from **those same bytes**.
- Rewire the panel: no `proposalFilePath` authority, instruction built solely
  from `result.proposalRelPath`, result bound to the exact workspace/document
  pair and invalidated on selection change.
- Remove the old `proposal:promote` / `proposal:promotionStatus` handlers,
  preload bindings, and shared result types.
- The panel reports "assigned", never "plan created".

**Accept**
- Only `already-adopted` navigates; a claimed-but-unadopted folder does not.
- Spoofed or stale artifact cross-checks, cross-workspace handles, foreign
  document categories, and unsafe paths all reject.
- A renderer-supplied absolute path, filename, or cached metadata can never
  enter the supervisor instruction.
- Concurrent dispatch yields one scaffold, one responsible writer, and one
  loser that orients read-only and stops.
- **Exactly one identity derivation exists in the tree.** `derivePlanSku` and
  every caller are gone; a guard test fails if a filename-derived identity path
  reappears. (Inherited from WP-A — see the obligation block above.)

**Non-goals:** no legacy drain (WP-I), no `PromoteDialog` revival.

**Verify:** preflight, claim-scan, planning-reader, panel/dispatch, and preload
suites; both `tsc`.

## WP-G - Optimistic overview disk editor and truthful Packages state

Subsumes `WP-HOV-3`.

**Files**
- new shared atomic-replacement helper, extracted from
  `src/main/git-checkpoints/checkpoint-service.ts:1622`
- `src/main/plans/plan-ipc.ts:825-953`; `src/main/plans/plan-overview.test.ts`
- `src/preload/index.ts:749-760`; `src/shared/types.ts:5084-5097`
- `src/renderer/components/plan/PlanDocumentTabs.tsx:194-300, 362-455` + tests
- `src/renderer/components/plan/PlanSurfaceView.tabs.test.tsx`

**Dep:** WP-D.

**Do**
- For structured plans, `plan:setOverview` stops writing SQLite and writes disk:
  per-plan main-process mutex, `expectedSourceHash` comparison, containment
  revalidation, exclusive-`wx` sibling temp with a 128-bit suffix, sync, final
  re-observation, retried atomic rename-replace, temp cleanup on every failure.
- Derive the responsible supervisor main-side; remove the renderer's supervisor
  selector on this path. Legacy/non-folder plans keep direct-DB behavior.
- Implement replace / insert / remove / canonical index rewrite, and the
  one-time DB seeding path gated on `never-seen` plus two absent observations.
- Split the Packages document region: an unpopulated message that names
  packaging and refresh, and a populated state that points at the Mission Board
  and **never** shows the "not yet implemented" placeholder.

**Accept**
- In-app writes serialize; a mismatch at final observation rejects.
- The external-writer TOCTOU window is documented; **no** comment, copy, or test
  claims an absolute stale-write guarantee.
- Replacement failure leaves the destination byte-identical and removes the temp;
  a saved-but-unprojected write returns `overview-saved-projection-pending` and
  recovers on the next reconciliation.
- CRLF, unmapped prose, and unrelated bytes survive an edit.

**Non-goals:** no arbitrary invalid-file repair, no multi-user merge editor.

**Verify:** IPC authorization/concurrency tests, injected external-race seam,
replacement and projection-failure tests, editor/tab/preload suites; both `tsc`.

## WP-H - Shared readiness evaluator: forced refresh, Mark Ready, Implement

Merges `WP-INGEST-4` and `WP-HOV-4`. **Merged deliberately:** HOV-4 extends the
same evaluator INGEST-4 creates, and splitting them invites two interpretations
of readiness.

**Files**
- `src/main/plans/plan-lifecycle.ts:279-365`
- `src/main/plans/plan-implement.ts:117-271`
- `src/main/plans/plan-ipc.ts:1059-1160`
- `src/preload/index.ts:220-235, 750-760`; `src/shared/types.ts` readiness DTOs
- `src/renderer/components/plan/PlanSurfaceContainer.tsx:47-68`,
  `PlanSurfaceView.tsx:15-123`
- lifecycle, Implement, preload-surface, PlanSurface, document-tab, Mission
  Board, and refusal tests

**Dep:** WP-D and WP-E.

**Do**
- Add one `refreshAndGetPlanReadiness(planId)` that forces a canonical
  single-folder refresh and evaluates WP, responsibility, overview,
  populated-tab, and run-state gates **once**. Both Mark Ready and Implement
  consume that same result.
- Change `markPlanReady` from "≥1 non-archived package" to "≥1 `ready` package",
  adding `work-package-ingest-not-synced` and `no-ready-package` and retaining
  `no-valid-responsible-supervisor` and `tab-overview-missing`. Use compare-and-set
  for `hardening → ready`; do not call the broad `updatePlan` setter after a
  stale read.
- Force refresh before Implement and refuse before any git baseline operation
  when refresh is invalid, conflicted, or safely demotes the plan.
- Expose `plan:refreshFromDisk`, `plan:getReadiness`, `plan:markReady` alongside
  the existing renderer-only `plan:implement`; render the controls and
  structured refusal details. Implement stays renderer-only — add no HTTP route.

**Accept**
- A valid packaged plan with a valid supervisor and complete overviews reaches
  `hardening → ready → executing` through exactly two explicit human actions.
- Only-blocked packages cannot Mark Ready; absent or invalid overviews block both.
- Safe post-ready drift applies and demotes to `hardening`; unsafe drift stays a
  conflict.
- An invalid refresh prevents any git baseline probe or creation.

**Non-goals:** no auto-ready, auto-Implement, dispatch, or overview-source design.

**Verify:** lifecycle, Implement, forced-refresh, preload-surface, plan-surface,
document-tab, Mission Board, and renderer refusal suites; both `tsc`.

## WP-I - Authority-safe legacy promotion drain and gated retirement

Subsumes `WP-PROMOTE-4`.

**Files**
- refactor `promotion-reconciler.ts` → `legacy-promotion-drain.ts`
- reduce main `promotion-dispatch.ts` to evidence + submit-only recovery
- `src/main/index.ts:997-1105` (replace saga assembly with coordinator /
  preflight / drain wiring)
- `src/main/database.ts:394-440, 1947-1969, 3133-3283, 7718-7986`
- promotion-request, delivery, lifecycle-stop, startup, and drop tests

**Dep:** WP-E.

**Do**
- Stop creating `promotion_requests` rows. Classify each existing row by the
  crash matrix — never-reserved, reserved-unbound, bound-undelivered,
  submitted-unconfirmed, delivered — and drain accordingly. The drain scans all
  valid folders for the proposal **artifact**, never the persisted
  filename-derived path.
- For bound-undelivered, stop the agent through `AgentSupervisor.stopAgent` via
  an injected seam and require a **verified** terminal outcome before
  terminalizing; otherwise retain pending with
  `legacy-bound-agent-stop-unconfirmed`.
- Never reconstruct or retype a body; never press Enter against a terminal or
  missing agent. Delete the legacy prompt factories once event-shape fixtures
  cover submitted/delivered classification.
- Delete the `pendingLatches` map — the durable pending row gates preflight.
- Create `applied_migrations` before deciding whether to create
  `promotion_requests`; drop the table once, atomically, behind the full
  retirement check (zero pending rows, zero nonterminal promotion
  orchestrations including orphans, no pointer disagreement, no unverified live
  bound agent, no active drain), and never recreate it.

**Accept**
- No undelivered attempt receives a body.
- `legacy-not-delivered` leaves no live bound worker; unverifiable shutdown
  stays pending rather than terminalizing.
- Every orphan nonterminal promotion run blocks retirement.
- A user upgrading with a pending request never loses it silently.

**Non-goals:** no new promote UX, no readiness changes.

**Verify:** promotion-request, delivery, lifecycle-stop, startup-wiring, and
drop-migration tests; main `tsc`.

## WP-Z - End-to-end gate: promote to implement on one skill-driven plan

Subsumes all three deliberations' Z packages. No production changes except
defects the gate exposes.

**Files:** new integration fixtures/tests under `src/main/plans/` and the
relevant renderer integration tests.

**Dep:** WP-F, WP-G, WP-H, WP-I, WP-J — **and all of plan_0e1425af (their
WP-1..WP-6)**, which lands earlier in the merged order.

> ⚠ **RE-AUTHORED 2026-08-05 for the post-split skill.** This package was
> originally written against the *monolithic* `proposal-to-plan` skill. By the
> time it runs, plan_0e1425af has decomposed that skill into three:
> **`write-proposal`** (authoring, absorbs the retired `capture` mode),
> **`read-planning-surface`** (read-only surface reporting, holds orient's
> reporting half), and **`proposal-to-plan`** (promotion-entry only). Item 1
> below drives "the skill" end to end — it must exercise the **post-split**
> arrangement, not the monolith, and its fixtures must be authored against the
> final shape. Do not inherit pre-split assumptions from the deliberation Z
> packages this subsumes.
>
> **This gate spans two plans.** A failure here may belong to plan_0e1425af, not
> to us. Do not silently repair another plan's package: classify each failure by
> owning plan and route anything theirs to supervisor ac1cb0b6. "No production
> changes except defects the gate exposes" applies only to defects in **our**
> packages.

**Do / Accept** — prove on a temporary structured plan folder driven through the
real watcher:
1. A proposal promoted through the sole gesture reaches Implement with **no
   manual DB work** — the failure this whole plan exists to fix. Driven through
   the **post-split** skill set: authored via `write-proposal` (not a `capture`
   mode, which no longer exists), promoted via the mounted gesture carrying
   their `PROPOSAL_PROMOTION_PROMPT_TEMPLATE`, and carried by
   `proposal-to-plan` operating as a promotion-entry-only skill.
2. Server-read identity equals deployed-scaffold identity; both state-root
   variants write the exact canonical `source_proposal.rel_path`.
3. Renderer identity/path spoofing rejects; changing the selected proposal after
   preflight invalidates the result.
4. Adoption starts in `hardening`; the v1 block produces deterministic ordered
   Mission Board cards; `ready` and `blocked` initial states are honored.
5. A valid manifest assignment populates the responsible supervisor without
   stealing active-plan attention.
6. Missing overview sections block Mark Ready; complete ones permit it;
   Implement creates exactly one active execution run.
7. Safe pre-execution edits demote `ready → hardening`; runtime-owned edits and
   removals create queryable conflicts without overwriting DB state.
8. Valid omission tombstones a pristine package; missing or malformed whole
   supplements preserve all packages.
9. Every legacy crash-matrix branch is safe; orphan promotion runs block
   retirement; old promotion IPC handlers are absent.
10. Restart and repeated refresh are idempotent; symlink/junction escape cannot
    read or write outside the folder.

**Post-split gate items (added by the cross-plan boundary re-authoring):**

11. **Two-bump migration chain from a pre-WP-A workspace.** A workspace scaffolded
    at the ORIGINAL versions (SKILL.md v2, promote.md v2, plan-manifest.mjs v3,
    capture.md v3 — see `supervisor/index.ts:1275-1297`) migrates cleanly to the
    final post-split state in ONE launch, without any file landing in the
    user-modified `.bak` path. This is the failure mode `previousHashes` map
    truncation produces, it is invisible to unit tests, and it is the single
    highest-value item in this gate. Test from a v3-era fixture workspace, not
    from a freshly scaffolded one.
12. **`capture.md` retired, not orphaned.** After migration, no
    `references/activities/capture.md` remains on disk in an existing workspace,
    a user-modified copy was backed up before removal, and the sidecar records
    the retirement. A dangling playbook an agent could still open is a failure.
13. **A2 survived the trigger rewrite.** The deployed `SKILL.md` still carries the
    continuity rule (no "phase done, continue?" pauses across
    scope→promote→deliberate→integrate→package; the one built-in stop is after
    `package`) after plan_0e1425af's WP-4 restructured the file.
14. **Responsibility determination is still reachable from the promote flow.** The
    matching-EEXIST loser path can determine whether another supervisor is
    responsible and stop without mutating — without invoking the read-only
    `read-planning-surface` skill, which may not write or append `assigned`
    events. (Resolution of boundary gap 4; confirm the agreed wording before
    writing the assertion.)
15. **The three skills are provisioned to their intended lanes** and the two new
    ones appear in an existing workspace after migration — not only in a fresh
    scaffold.

**Non-goals:** no feature expansion during gate repair; no repair of
plan_0e1425af's packages without routing to their supervisor.

**Verify:** full main suite, relevant renderer sibling suites, both TypeScript
builds, scaffold migration suite, and a rebuild/relaunch with the
existing-workspace deployed-skill check — the relaunch check now covers items
11–13 and 15 and is **not optional**, because the migration failures this gate
exists to catch cannot be reproduced in-process.
