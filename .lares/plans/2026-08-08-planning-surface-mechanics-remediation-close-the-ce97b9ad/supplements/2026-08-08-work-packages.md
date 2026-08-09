---
plan_artifact_id: plan_ce97b9ad
kind: work-packages
---

# Work packages — planning surface mechanics remediation

Decomposition of the hardened plan (all four PLAN-INTENT deliberation/research
outputs folded in). Prose bundle contracts below are the authority for file scope
and acceptance; the machine block is additive projection metadata. Ordering is
load-bearing: Cluster A (readout repairs) lands before Clusters B–D are
*verified*. Nothing in this plan pushes to a remote, restarts Electron, or
deploys — deployment state renders explicitly `not_deployed` (F9).

Recovery framing: the pre-implementation baseline tag (recorded in ARC.md →
Decisions) means any file a package deletes is one `git show <tag>:<path>` away —
no copy-aside archiving in any package.

<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_ce97b9ad",
  "packages": [
    {
      "id": "WP-A1",
      "order": 10,
      "title": "Scope and label file activity correctly",
      "initial_state": "ready",
      "acceptance_conditions": [
        "An event/renderer test spanning renewal generations asserts the rendered file-activity scope matches its label.",
        "Either the idle-event payload requests current-turn activity only, or the heading explicitly states the retained-sessions scope with session id, generation, and time range."
      ],
      "paths": [
        { "path": "src/main/api-server.ts", "intent_kind": "edit" },
        { "path": "src/main/supervisor/index.ts", "intent_kind": "edit" },
        { "path": "src/main/supervisor/event-payload-builder.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-A2",
      "order": 20,
      "title": "Make ARC staleness computed and visible",
      "initial_state": "ready",
      "acceptance_conditions": [
        "A read-only freshness calculator run across all plan folders flags the known-stale ones.",
        "A unit-scale regression test covers the seconds-vs-milliseconds cutoff case."
      ],
      "paths": [
        { "path": "src/main/plans/plan-manifest.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-B1",
      "order": 30,
      "title": "PLAN-WORK-PACKAGES:v2 reachability schema in the ingest parser",
      "initial_state": "ready",
      "acceptance_conditions": [
        "A v2 fixture missing reachability yields diagnostic reachability-invalid; a well-formed v2 fixture parses with obligations projected and schema_version 2.",
        "A reachability edit changes the package contentHash.",
        "v1 blocks still parse as today."
      ],
      "paths": [
        { "path": "src/main/plans/plan-work-package-ingest.ts", "intent_kind": "edit" },
        { "path": "src/main/plans/plan-work-package-ingest.test.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-B2",
      "order": 40,
      "title": "Reachability persistence, grandfather snapshot, and quarantine",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "A grandfathered v1 fixture stays usable at its recorded content hash; a revised or new v1 package absent from the snapshot projects legacy-unmigrated.",
        "Dispatch/assignment refuses a legacy-unmigrated package.",
        "Obligation and evidence rows persist transactionally with read and freshness accessors; the freshness predicate reports not-cleared on candidate-tree or content-hash mismatch."
      ],
      "paths": [
        { "path": "src/main/database.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-B1"]
    },
    {
      "id": "WP-B3",
      "order": 50,
      "title": "prove_reachability proof engine and verification target registry",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "A constructor-only entering test fails refutation (still passes after revert); the WP-6b real-registration shape passes.",
        "A stale-context patch, a patch touching protected test paths, or a compile failure under mutation classifies INDETERMINATE, never pass.",
        "Each entry-seam link and each production construct is refuted independently; evidence rows bind specimen tree OID, mutation blob OID, and registry version."
      ],
      "paths": [
        { "path": "src/main/plans/reachability-prover.ts", "intent_kind": "create" },
        { "path": "src/main/plans/reachability-prover.test.ts", "intent_kind": "create" },
        { "path": "src/main/plans/reachability-targets.ts", "intent_kind": "create" },
        { "path": "src/main/ipc-handlers.ts", "intent_kind": "edit" },
        { "path": "src/preload/index.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-B2"]
    },
    {
      "id": "WP-B4",
      "order": 60,
      "title": "Managed scaffold deployment of the reachability skill and worker duties",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The prove-the-production-entry-point skill body is a managed scaffold constant deployed to every supervisor and worker lane.",
        "WORKER_CLAUDE_MD carries the structured reachability-report duty and every derived *_AGENTS_MD inherits it through the existing anti-drift chain.",
        "Every touched scaffold entry has a version bump and cumulative previousHashes; scaffold-version-migration.test.ts is green."
      ],
      "paths": [
        { "path": "src/shared/constants.ts", "intent_kind": "edit" },
        { "path": "src/main/supervisor/index.ts", "intent_kind": "edit" },
        { "path": "src/main/scaffold-version-migration.test.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-B1"]
    },
    {
      "id": "WP-C1",
      "order": 70,
      "title": "Validate prose counts against machine blocks",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Prose count divergence from the machine block fails loudly on validation; exactly one authority for file scope and acceptance is preserved.",
        "The deliberately-unpatched live instance in the audit plan supplement is fixed only after the validator lands, and the fix is recorded, not silent."
      ],
      "paths": [
        { "path": "src/main/plans/plan-work-package-ingest.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-C2A",
      "order": 80,
      "title": "Outbox tier-1 hardening: hooks and provider-native write scopes",
      "initial_state": "ready",
      "acceptance_conditions": [
        "The research write guard gains a Bash-write second line of defense with a test demonstrating detection of an out-of-outbox shell write.",
        "Provider-native outbox configuration is applied where it exists (codex writable_roots; agy write grants), with the known-bypass limitations documented in the lane config."
      ],
      "paths": [
        { "path": ".lares/researcher/scripts/research-write-guard.mjs", "intent_kind": "edit" },
        { "path": "src/main/workers/codex-settings.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-C2B",
      "order": 90,
      "title": "Restricted-token outbox wrapper launcher (provider-neutral, Windows)",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "A wrapper-launched process cannot write outside the declared outbox while writes inside it succeed, proven by an integration test using a write-restricted token.",
        "World-writable directories are audited at launch and reported.",
        "Failure to establish the restricted token fails closed with a clear error, never silently launching unrestricted."
      ],
      "paths": [
        { "path": "src/main/sandbox/outbox-launcher.ts", "intent_kind": "create" },
        { "path": "src/main/sandbox/outbox-launcher.test.ts", "intent_kind": "create" }
      ],
      "depends_on": ["WP-C2A"]
    },
    {
      "id": "WP-ID1",
      "order": 100,
      "title": "Portable identity enforced at ingestion",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Non-contract proposal/plan artifact IDs are rejected or visibly quarantined at ingestion, never silently accepted.",
        "plans.source_proposal_id is backfilled where derivable from frontmatter, by explicit reviewed mapping.",
        "New orchestration launches require plan_id and planning_intent_id; a missing or mismatched intent is rejected rather than written null."
      ],
      "paths": [
        { "path": "src/main/plans/promotion-dispatch.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/main/orchestration/orchestration-service.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-D1",
      "order": 110,
      "title": "Ledger schema: four new tables and guarded extensions",
      "initial_state": "ready",
      "acceptance_conditions": [
        "plan_package_gate_attempts, plan_package_gate_commit_links, plan_package_deployment_events, and continuation_handoff_result_events exist with the deliberated DDL, indexes, and CHECK constraints.",
        "plan_work_packages gains intent_id and plan_dispatch_attempts gains package_revision, orchestration_id, target_session_id via guarded ALTER.",
        "The plan_wp_lifecycle_events CHECK rebuild admits done, runs at most once, and preserves all live rows.",
        "Commit OIDs are validated 40-hex; evidence tables carry no cascade FKs."
      ],
      "paths": [
        { "path": "src/main/database.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-D2",
      "order": 120,
      "title": "Single package-state transition service",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "transitionPlanPackage implements the closed command union with idempotency keys, one SQLite transaction per command, and self-witnessed evidence.",
        "complete enforces per-kind prerequisites (code: gates passed plus commit and boundary evidence; research: durable output plus gate; no-change: reviewed justification) and consumes reachability-evidence freshness for behavior packages when obligations exist.",
        "A failed gate moves executing to blocked and a later passed retry preserves the failure row."
      ],
      "paths": [
        { "path": "src/main/plans/package-ledger.ts", "intent_kind": "create" },
        { "path": "src/main/plans/package-ledger.test.ts", "intent_kind": "create" }
      ],
      "depends_on": ["WP-D1", "WP-B2"]
    },
    {
      "id": "WP-D3",
      "order": 130,
      "title": "Route all existing package-state writers through the service",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The direct state writers in database.ts, finalization-service.ts, and plan-ipc.ts no longer write plan_work_packages.state inline; the finalization done flip enters via the service's complete path.",
        "A source-guard test fails if any production state mutation exists outside package-ledger.ts."
      ],
      "paths": [
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/finalization-service.ts", "intent_kind": "edit" },
        { "path": "src/main/plans/plan-ipc.ts", "intent_kind": "edit" },
        { "path": "src/main/plans/package-ledger-source-guard.test.ts", "intent_kind": "create" }
      ],
      "depends_on": ["WP-D2"]
    },
    {
      "id": "WP-D4",
      "order": 140,
      "title": "Gate and deployment evidence ingestion",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "Gate outcomes and deployment events are recorded only via main-process witnesses calling the transition service; no renderer or caller submits a trusted outcome.",
        "Absent gate rows read as unknown, never success; absent deployment rows read as unknown, not not_required.",
        "Until a real deployment adapter exists, states are explicit not_deployed or not_required, never inferred from commit reachability."
      ],
      "paths": [
        { "path": "src/main/plans/package-gates.ts", "intent_kind": "create" },
        { "path": "src/main/plans/package-deployments.ts", "intent_kind": "create" },
        { "path": "src/main/plans/package-gates.test.ts", "intent_kind": "create" }
      ],
      "depends_on": ["WP-D2"]
    },
    {
      "id": "WP-D5",
      "order": 150,
      "title": "Continuation handoff results and checkpoint recorder fixes",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "brick_saved, successor_started, and successor_oriented are recorded at their deliberated witness seams with explicit failed/timed_out outcomes, keyed to handoff_attempt_id, never touching checkpoint-turn status.",
        "The coordinator distinguishes closing from active (serialize behind close), cleanup is compare-and-delete by turn identity, and startup reconciliation enumerates all dangling open rows, not the newest 50.",
        "Witnessed paths are whitespace-canonicalized at ingress; a production-like test covers the pending-AFTER-capture race."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/turn-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/witness-recorder.ts", "intent_kind": "edit" },
        { "path": "src/main/supervisor/continuation-watcher.ts", "intent_kind": "edit" },
        { "path": "src/main/supervisor/index.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-D1"]
    },
    {
      "id": "WP-D6",
      "order": 160,
      "title": "DB-only plan projection read surface",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "renderPlanFromLedger returns identity, source proposal, intent, revision, dispatch/session, gate attempts, ordered commit chain, deployment state, derived binding state, and state history from SQLite only.",
        "A test configures filesystem reads to throw and the projection still renders, proving DB-only.",
        "Binding completeness is derived from joins, never stored as an independent mutable marker."
      ],
      "paths": [
        { "path": "src/main/plans/plan-ledger-projection.ts", "intent_kind": "create" },
        { "path": "src/main/plans/plan-ledger-projection.test.ts", "intent_kind": "create" },
        { "path": "src/main/plans/plan-ipc.ts", "intent_kind": "edit" },
        { "path": "src/preload/index.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-D3", "WP-D4"]
    },
    {
      "id": "WP-D7",
      "order": 170,
      "title": "Plan-folder version-control policy: ignore rules, checker, migration commit",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Anchored ignores cover only plan.json lock/temp siblings in both state-dir roots; no plan.json or plan subdirectory is ignored.",
        "check-plan-folder-versioning.mjs --check exits non-zero on an untracked durable file, a tracked ephemeral file, or a plan folder lacking a tracked valid plan.json; tests cover the superseded-draft case, spaces, and the .dashboard fallback.",
        "The population migration is one reviewed explicit-manifest commit that preserves foreign ARC.md edits and stages frozen-specimen files without editing their content, and the checker passes against the prepared index before committing."
      ],
      "paths": [
        { "path": ".gitignore", "intent_kind": "edit" },
        { "path": "scripts/check-plan-folder-versioning.mjs", "intent_kind": "create" },
        { "path": "scripts/check-plan-folder-versioning.test.mjs", "intent_kind": "create" },
        { "path": "package.json", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-D8",
      "order": 180,
      "title": "Ledger acceptance: synthetic gate and historical DB-only comparison",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The synthetic fixture reproduces the a1bacc4a shape and proves WP6-8 refuse complete without evidence, succeed with it, and render done from DB-only state.",
        "The historical fixture renders plan_5b3ea7d1 DB-only with all 11 packages complete, the ordered implementation-commit union exactly equal to the verified 13-commit chain resolved via git rev-parse, e52ad5fb associated with the failed production-entry proof and b4617499 with the correction, and a1bacc4a left unbound.",
        "D3 fixtures show all three handoff results for one attempt while the note turn stays accepted, plus a partial-failure case per boundary.",
        "Deployment state renders explicitly not_deployed; the Electron app is not launched or restarted."
      ],
      "paths": [
        { "path": "src/main/plans/package-ledger.acceptance.test.ts", "intent_kind": "create" }
      ],
      "depends_on": ["WP-D5", "WP-D6"]
    }
  ]
}
-->

## WP-A1 - Scope and label file activity correctly

**Files:** `src/main/api-server.ts` (activity default at ~1828–1831),
`src/main/supervisor/index.ts` (idle-event payload at ~2187–2198),
`src/main/supervisor/event-payload-builder.ts` (heading at ~157–169), plus their
sibling tests.
**Dep:** none.
**Do:** Resolve the F3 ambiguity: either request current-turn/current-session
activity for idle-event payloads, or render an explicit heading ("Files touched
across retained sessions") carrying session ID, generation, and time range.
Ambiguity is the defect; silence is not an acceptable resolution.
**Accept:** an event/renderer test spanning renewal generations asserts the
rendered scope matches the label; the false-freeze-alarm shape (47 rows across
three generations under a turn-local heading) can no longer render.
**Non-goals:** no change to activity *capture*; only scope/labeling of the readout.
**Verify:** targeted tests + sibling suite for the touched event-payload files.

## WP-A2 - Make ARC staleness computed and visible

**Files:** `src/main/plans/plan-manifest.ts` (cutoff helper; the skill-side
`plan-manifest.mjs` copy follows via its own scaffold discipline if its logic
changes), plus tests.
**Dep:** none.
**Do:** Compute the freshness cutoff at read time; expose a stale indicator when
source mtimes exceed `ARC-META.source_cutoffs`; add explicit unit handling
(seconds vs milliseconds — the `plan_0e1425af` defect stored seconds against ms
sources); stop presenting stale ARC prose as current completion state in any
reader surface.
**Accept:** a read-only freshness calculator across all plan folders flags the
known-stale ones; a unit-scale regression test covers the seconds/ms case.
**Non-goals:** no rewrite of ARC content; no automatic ARC regeneration.
**Verify:** run the calculator read-only across `.lares/plans/`; unit tests green.

## WP-B1 - PLAN-WORK-PACKAGES:v2 reachability schema in the ingest parser

**Files:** `src/main/plans/plan-work-package-ingest.ts`,
`src/main/plans/plan-work-package-ingest.test.ts`.
**Dep:** none.
**Do:** Per the folded Cluster B deliberation §2.3: add `reachability` to
`PACKAGE_KEYS`; add the `reachability-invalid` diagnostic; add the shared
exported validator (kind behavior/none; entry_seam_links with seam_kind, paths
via `normalizedPlanPath`, symbol, entering_test, mutation, verification
{target, expect_failure}; production_constructs with producer/consumer paths and
symbols); fold `reachability` into `canonicalContent`; gate the requirement
behind `schema_version === 2`.
**Accept:** see machine block; a `none` package requires a rationale and no other
keys.
**Non-goals:** no persistence (WP-B2), no proof engine (WP-B3); v1 parse
behavior unchanged.
**Verify:** ingest test suite green; `npm run build` clean for the touched area.

## WP-B2 - Reachability persistence, grandfather snapshot, and quarantine

**Files:** `src/main/database.ts` (+ its test files).
**Dep:** WP-B1.
**Do:** Persist `schema_version`, `content_hash`, and normalized obligations
through `applyPlanWorkPackageSnapshot`; create
`plan_wp_reachability_obligations` and `plan_wp_reachability_evidence` per the
deliberation §5 with transactional evidence writes and read/freshness accessors
implementing the §4.6 cleared() predicate; create the server-owned grandfather
snapshot rows (exact package_id + content_hash + schema_version); add the
`legacy-unmigrated` projection status in reconciliation; refuse
dispatch/assignment of quarantined packages.
**Accept:** see machine block.
**Non-goals:** the `done` refusal for ungrandfathered v1 defers to WP-D2/D3;
no engine execution here.
**Verify:** database test suite green; guarded-ALTER idiom consistent with the
file.

## WP-B3 - prove_reachability proof engine and verification target registry

**Files:** `src/main/plans/reachability-prover.ts` (new),
`src/main/plans/reachability-prover.test.ts` (new),
`src/main/plans/reachability-targets.ts` (new managed registry with
`registry.version` and `protected_test_paths`), `src/main/ipc-handlers.ts` and
`src/preload/index.ts` (register + expose the `prove_reachability` command).
**Dep:** WP-B2.
**Do:** Implement the deliberation §4: specimen built by path from the pinned
base via temp-index `read-tree`/`write-tree`/`commit-tree` and a detached scratch
worktree (never mutating the shared index/worktree); per-obligation
baseline-must-pass → apply reviewed mutation (declared path + symbol
intersection, protected-path rejection) → target-must-fail with the
`expect_failure` marker; INDETERMINATE on compile/collection/fixture failures,
stale patches, or protected-path touches; record evidence rows binding
(obligation, specimen_tree_oid, mutation_blob_oid, registry version). The engine
links `parsePlanWorkPackageDocument` directly — no second parser, nothing
scaffolded parses the schema.
**Accept:** see machine block. This package's own IPC registration is itself a
production entry point: include a registration-existence test through the real
`registerIpcHandlers` seam.
**Non-goals:** completion-blocking consumption (WP-D2); no arbitrary command
execution from plan prose — allowlisted runner adapters only.
**Verify:** prover suite green; foreign-edit honesty rule implemented (disclose
non-package-exact trees).

## WP-B4 - Managed scaffold deployment of the reachability skill and worker duties

**Files:** `src/shared/constants.ts`, `src/main/supervisor/index.ts`
(`PROPOSAL_TO_PLAN_TREE` + scaffold entries),
`src/main/scaffold-version-migration.test.ts`.
**Dep:** WP-B1 (the v2 contract text it deploys).
**Do:** Add the managed `PROVE_PRODUCTION_ENTRY_POINT_SKILL` body (gate section
names `prove_reachability`; FAIL/missing-evidence outranks green tests; worker
bullet carries the B3 duty) deployed to every supervisor and worker lane; edit
`WORKER_CLAUDE_MD` once with the structured final-message duty (entry seams,
production-created resources, entering tests, per-obligation refutation status,
every unperformed check), preserving the `*_AGENTS_MD` derivation chain; update
the `work-packages.md` contract (v2 field) and `package.md` (`Entry` section)
scaffold constants. Bump every touched version and append cumulative
`previousHashes` — never replace a row.
**Accept:** see machine block.
**Non-goals:** no in-place edits of deployed per-lane skill copies; app code of
the engine is WP-B3.
**Verify:** `scaffold-version-migration.test.ts` green; derivation-chain
transforms intact.

## WP-C1 - Validate prose counts against machine blocks

**Files:** `src/main/plans/plan-work-package-ingest.ts` (+ tests); the recorded
follow-up patch to
`.lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/supplements/2026-08-07-work-packages.md`.
**Dep:** none (may land any time; the live-instance patch only after the
validator).
**Do:** Machine-check prose numeric count claims ("six machine conditions")
against the parsed machine block where both exist, failing loudly on divergence
— or strip prose counts; preserve exactly one authority for file scope and
acceptance. Then fix the deliberately-preserved audit-evidence instance and
record the fix in that plan's ARC (it was left unpatched as evidence — the fix
must be a visible, attributed change).
**Accept:** see machine block.
**Non-goals:** no relaxation of existing v1 validation.
**Verify:** ingest suite green; divergence fixture fails loudly.

## WP-C2A - Outbox tier-1 hardening: hooks and provider-native write scopes

**Files:** `.lares/researcher/scripts/research-write-guard.mjs`,
`src/main/workers/codex-settings.ts` (or the actual codex lane config seam —
worker locates the config writer; single-site fixes are samples, sweep the lane
config surface), plus lane-config docs.
**Dep:** none.
**Do:** Per the folded C2 research Tier 1: extend the research guard with a
Bash/shell second line of defense (detect out-of-outbox writes in shell
commands; known-bypassable, documented as defense-in-depth, not a boundary);
apply provider-native outbox scopes where they exist (codex `writable_roots`
toward the declared outbox; agy write grants when its lane config supports
them); document per-provider limitations in the lane config.
**Accept:** see machine block.
**Non-goals:** OS-level enforcement (WP-C2B); no weakening of existing guard
behavior.
**Verify:** guard tests green including a shell-write detection case.

## WP-C2B - Restricted-token outbox wrapper launcher (provider-neutral, Windows)

**Files:** `src/main/sandbox/outbox-launcher.ts` (new),
`src/main/sandbox/outbox-launcher.test.ts` (new); wiring into the researcher
(and later audit-lane) launch path.
**Dep:** WP-C2A (lands the declared-outbox configuration surface it enforces).
**Do:** Per the folded C2 research Tier 2: create a synthetic SID for the Lares
sandbox role; stamp write-allow ACEs on the declared outbox only; spawn CLI
provider processes under a write-restricted token (Codex-architecture pattern);
audit world-writable paths at launch; fail closed when the restricted token
cannot be established. Windows 11 Home host — Windows Sandbox (Tier 3) is
unavailable; do not depend on it.
**Accept:** see machine block.
**Non-goals:** network containment (needs elevation — out of scope); replacing
provider-native sandboxes where they exist.
**Verify:** integration test with a real restricted token on Windows; graceful
skip with a loud marker on non-Windows CI.

## WP-ID1 - Portable identity enforced at ingestion

**Files:** `src/main/plans/promotion-dispatch.ts`, `src/main/database.ts`,
`src/main/orchestration/orchestration-service.ts` (worker locates the actual
launch-validation seam — treat named files as samples of the surface, per the
single-call-site rule).
**Dep:** none.
**Do:** Enforce `prop_[0-9a-f]{8}` / `plan_[0-9a-f]{8}` / `int_[0-9a-f]{8}` at
ingestion, not only at promotion: reject or visibly quarantine non-contract IDs
(the population includes `prop_0ed…`, `prop_pigt5a83`); backfill
`plans.source_proposal_id` by explicit reviewed mapping where frontmatter proves
it; require `plan_id` + `planning_intent_id` at orchestration launch, rejecting
rather than writing null. Historical `a1bacc4a` stays unbound pending explicit
reviewed backfill — never joined by topic/path/time.
**Accept:** see machine block.
**Non-goals:** no rewriting of historical rows beyond the reviewed backfill; no
D1 schema work.
**Verify:** ingestion tests cover accept/quarantine/reject paths.

## WP-D1 - Ledger schema: four new tables and guarded extensions

**Files:** `src/main/database.ts` (+ `src/main/database.*.test.ts`).
**Dep:** none.
**Do:** Implement the folded D1+D4 deliberation §3 exactly: the four tables with
their DDL, indexes, and CHECKs (`plan_package_gate_attempts`,
`plan_package_gate_commit_links`, `plan_package_deployment_events`,
`continuation_handoff_result_events`); guarded `ALTER`s for
`plan_work_packages.intent_id` and the three `plan_dispatch_attempts` columns;
the 12-step `plan_wp_lifecycle_events` CHECK rebuild admitting `done` with a
run-at-most-once guard; row mappers, append-only accessors, 40-hex OID
validation, and DB-only projection queries. Backfill `intent_id` /
`package_revision` where derivable; leave null (legacy-unbound) otherwise.
**Accept:** see machine block.
**Non-goals:** no transition logic (WP-D2); no writer rerouting (WP-D3).
**Verify:** database suite green; rebuild idempotence test.

## WP-D2 - Single package-state transition service

**Files:** `src/main/plans/package-ledger.ts` (new),
`src/main/plans/package-ledger.test.ts` (new).
**Dep:** WP-D1, WP-B2 (consumes reachability-evidence freshness for behavior
packages).
**Do:** Implement deliberation §4: the closed command union
(dispatch-confirmed | block | unblock | gate-decided | commits-observed |
deployment-observed | complete | reopen | archive) with idempotency keys; one
transaction per command; self-witnessed evidence (no caller-submitted trusted
outcomes); legal-edge validation; one lifecycle event per state change;
`plan_work_packages` updated as projection only. `complete` enforces per-kind
prerequisites and, for behavior packages with declared obligations, the WP-B2
freshness predicate — this is the completion executor Cluster B defers to, so
its landing flips M2 from recorded-only to completion-blocking. Include
`recordHandoffResult(...)` as the sibling API for the D3 lifecycle (separate
vocabulary, never touches turn status).
**Accept:** see machine block.
**Non-goals:** no rerouting of existing writers (WP-D3); no IPC surface (WP-D6).
**Verify:** service suite green including refuse-without-evidence cases.

## WP-D3 - Route all existing package-state writers through the service

**Files:** `src/main/database.ts` (~5538 projection helper, ~6520 revision
bump), `src/main/commit-candidates/finalization-service.ts`,
`src/main/plans/plan-ipc.ts` (~216), dispatch wiring;
`src/main/plans/package-ledger-source-guard.test.ts` (new).
**Dep:** WP-D2.
**Do:** Convert the `database.ts:5538` state write into an internal projection
helper only the service calls; keep the 6520 revision bump but move any
accompanying state change into the service; make the finalization `done` flip
enter via `complete` so done is evidence-gated, not unconditional. Add the
source-guard test failing on any `UPDATE plan_work_packages SET state` (or
equivalent) outside `package-ledger.ts`.
**Accept:** see machine block.
**Non-goals:** no behavior change to finalization evidence capture itself.
**Verify:** source-guard green; finalization + plan-ipc suites green.

## WP-D4 - Gate and deployment evidence ingestion

**Files:** `src/main/plans/package-gates.ts` (new),
`src/main/plans/package-deployments.ts` (new),
`src/main/plans/package-gates.test.ts` (new).
**Dep:** WP-D2.
**Do:** Server-witnessed ingestion seams that validate evidence and call the
sole transition API: gate attempts (including the Cluster B production-entry
gate with retry history) and deployment events. Explicit
`not_deployed`/`not_required` until a real deployment adapter exists; never
infer deployment from push/commit reachability.
**Accept:** see machine block.
**Non-goals:** no UI; no automatic gate triggering.
**Verify:** ingestion tests green.

## WP-D5 - Continuation handoff results and checkpoint recorder fixes

**Files:** `src/main/git-checkpoints/turn-coordinator.ts`,
`src/main/git-checkpoints/witness-recorder.ts`,
`src/main/supervisor/continuation-watcher.ts`, `src/main/supervisor/index.ts`,
`src/main/database.ts` (§3.4 table lands in WP-D1; this WP wires the seams),
plus tests.
**Dep:** WP-D1.
**Do:** Land the D3 forensic fix spec and the deliberated recording seams
together: (1) coordinator distinguishes `closing` from active — a new send
serializes behind the pending close and opens a normal turn; (2) cleanup becomes
compare-and-delete by turn identity so an old callback can never clear a
successor's turn; (3) startup reconciliation enumerates ALL dangling open rows
(not the newest-50 default) — this is what left row 1774 open; (4) witness-path
whitespace canonicalization at ingress (`witness-recorder.ts` ~46–80; turn 1773
recorded three whitespace variants); (5) `recordHandoffResult` called at the
three witness seams — brick durably inserted → `brick_saved`; runner-launch tail
reports the session live → `successor_started`; attempt-correlated kickoff turn
completes → `successor_oriented`, with explicit failed/timed_out otherwise.
Preserve `overlapping-active-turn` for genuinely active prior turns, with a test
isolating that from the already-closing race.
**Accept:** see machine block.
**Non-goals:** no change to brick authoring or relaunch UX; checkpoint-turn
status is never written by handoff results.
**Verify:** coordinator + continuation suites green; the production-like
pending-AFTER-capture race test passes.

## WP-D6 - DB-only plan projection read surface

**Files:** `src/main/plans/plan-ledger-projection.ts` (new),
`src/main/plans/plan-ledger-projection.test.ts` (new),
`src/main/plans/plan-ipc.ts`, `src/preload/index.ts`, shared types; Mission
Board consumption may be a thin follow-on within this package if context allows.
**Dep:** WP-D3, WP-D4.
**Do:** `renderPlanFromLedger` per deliberation step 6: full plan render from
SQLite only (identity, source proposal, intent, revision, dispatch/session, gate
attempts, ordered commit chain, deployment state, derived binding state, state
history). Binding completeness is derived from joins (`bound` /
`legacy-unbound` / `quarantined` via D2's disposition), never stored.
**Accept:** see machine block; this package's IPC/preload additions get
registration-seam tests (the F1 lesson applies to itself).
**Non-goals:** no filesystem fallback path — absence renders as absence.
**Verify:** DB-only throw-on-fs-read test green.

## WP-D7 - Plan-folder version-control policy: ignore rules, checker, migration commit

**Files:** `.gitignore`, `scripts/check-plan-folder-versioning.mjs` (new),
`scripts/check-plan-folder-versioning.test.mjs` (new), `package.json`
(`check:plan-versioning` script + CI wiring); scaffold contract prose updates
ride WP-B4's constants pass or their own minimal bump.
**Dep:** none (independent; may run in parallel with everything).
**Do:** Deliberation §6.2–6.3: anchored ignores for lock/temp siblings only
(both state-dir roots); the checker (enumerate durable files, `git ls-files
--error-unmatch`, deterministic report, `--check` non-zero on violations); then
the population migration as ONE reviewed explicit-manifest commit — inspect
`git status` first, preserve the two foreign-modified ARC.md files (stage
separately or surface, never fold over), include every durable artifact (all 8
`plan.json`, the winning synthesis `2026-08-06-carry-forward-equivalence.md`,
this plan's research/deliberations), stage frozen-specimen `plan_5b3ea7d1` files
without content edits (index-only, freeze-respecting, reasoning in the commit
message), and run the checker against the prepared index before committing.
Never `git checkout`/`restore`/`clean`/`stash` in the shared worktree.
**Accept:** see machine block.
**Non-goals:** no push; no migration of the 303 legacy root `plans/` documents.
**Verify:** checker `--check` passes post-commit; specimen content byte-identical.

## WP-D8 - Ledger acceptance: synthetic gate and historical DB-only comparison

**Files:** `src/main/plans/package-ledger.acceptance.test.ts` (new; the
historical fixture may live beside it).
**Dep:** WP-D5, WP-D6.
**Do:** Deliberation §7 both layers. 7a synthetic: scratch DB with the a1bacc4a
shape (11 packages landed, WP6–8 blocked/null-bound) proving refuse-then-succeed
and DB-only render. 7b historical: reviewed fixture for `plan_5b3ea7d1` built
from evidence — resolve every commit OID with `git rev-parse` (never trust
abbreviated inherited values; re-derive, reject ambiguous); assert the seven
acceptance clauses including the exact 13-commit chain equality, the
e52ad5fb-failure/b4617499-correction story, a1bacc4a unbound, the three D3
handoff results with the note turn accepted, and `not_deployed` rendering.
**Accept:** see machine block.
**Non-goals:** no Electron launch/restart (F9 blocker inherited, stated, not
quietly assumed).
**Verify:** acceptance suite green; fixture provenance documented in-file.
