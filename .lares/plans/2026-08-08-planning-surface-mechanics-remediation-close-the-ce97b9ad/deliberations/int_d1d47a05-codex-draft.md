---
plan_artifact_id: plan_ce97b9ad
intent_id: int_d1d47a05
kind: deliberation
---

# D1 + D4 decision: a normalized server ledger and a wholly versioned plan folder

## Decision

Use SQLite as the authority for mutable execution facts and Git as the authority for
portable plan artifacts. Extend the existing package, dispatch, finalization, commit,
intent, and plan tables instead of introducing a parallel all-purpose ledger. Add
immutable package-revision, gate, package-to-commit, deployment-event, and handoff-result
tables, then expose one main-process package transition service as the only writer of
package state.

Version-control every durable file in every `.lares/plans/<plan-sku>/` folder, including
`plan.json`, `plan.md`, `ARC.md`, `OVERVIEW.md`, deliberations, research, supplements, and
`.gitkeep` placeholders. Ignore only manifest lock/recovery temporaries. `plan.json` stays
the portable folder-is-a-plan signal and identity bootstrap; the ledger does not become
an excuse to leave it local. Its responsibility-event churn is meaningful history and
must be committed. SQLite remains authoritative for execution state, so neither
`plan.json` nor `ARC.md` may duplicate package/gate/commit/deployment status.

This split survives both failure modes: a clone can rediscover a plan from Git without
the originating machine's database, while the running app can render execution truth
without reading prose or inferring completion from Git.

## Population survey and D4 finding

The read-only survey used `git status --short --untracked-files=all -- .lares/plans` and
`git ls-files --stage -- .lares/plans` on 2026-08-08. The current population has eight
plan folders and 72 files. Only 25 files are in the current index; 47 are untracked.
There is no ignore rule for `plan.json` or the plan folders (`git check-ignore` returned
no match), so the split is accidental rather than policy.

All eight `plan.json` files are untracked. The per-folder tracked/total counts are
1/6, 7/14, 5/10, 3/7, 5/10, 4/11, 0/8, and 0/6. The case-study folder
`...-5b3ea7d1` proves the semantic damage: its superseded Claude draft is tracked, while
the winning `2026-08-06-carry-forward-equivalence.md` synthesis is untracked. The active
`plan_ce97b9ad` folder, including both folded research reports, currently has no tracked
files. Two tracked `ARC.md` files also have local modifications. No implementation may
bulk-add this population without first preserving those foreign edits and reviewing the
exact index.

## Relational contract

Keep `plans.id` as the local foreign-key target and `plans.artifact_id` as portable
identity. Every new package-ledger row carries `workspace_id`, `plan_id`, and
`plan_artifact_id`; the transition service verifies that all three identify the same
row. Never join by folder name, SKU, source path, agent working directory, or package
title.

### Existing tables retained

- `plans`: authoritative local plan row. D2 must populate `artifact_id` and
  `source_proposal_id`; D1 rejects execution-ledger writes while either is absent or
  quarantined.
- `plan_intents`: parent for `(plan_id, intent_id)`. Package revisions and launches
  reference this composite identity.
- `plan_work_packages`: current package projection for compatibility and indexed board
  reads. Its `state`, `revision`, and assignee are derived fields updated only inside the
  transition transaction.
- `plan_dispatch_attempts`: durable send-before-delivery record. Extend it rather than
  create another dispatch table.
- `package_finalizations`: frozen candidate/boundary evidence. It is no longer a second
  owner of the `done` state.
- `commit_records`: canonical `(repository_key, commit_oid)` observation. Package links
  reference it; do not copy commit metadata into package rows.
- `orchestrations`: sole orchestration run-state authority. Its plan/intent columns are
  required at launch under D2 and referenced from dispatches where an orchestration is
  involved.

### New and extended schema

1. Add `UNIQUE(id, artifact_id)` on `plans` to support identity-checking composite
   foreign keys. Add no nullable "best effort" identity path for new writes.

2. Create `plan_package_revisions` as immutable package definitions:

   - columns: `package_id`, `revision`, `workspace_id`, `plan_id`,
     `plan_artifact_id`, `intent_id`, `title`, `acceptance_condition`,
     `definition_hash`, `source_rel_path`, `created_at`, `created_by`;
   - primary key `(package_id, revision)`;
   - foreign keys to `plan_work_packages(id)`, `plans(id, artifact_id)`, and
     `plan_intents(plan_id, intent_id)`;
   - unique `(plan_id, intent_id, package_id, revision)` and `revision > 0` checks.

   A changed package definition inserts revision N+1; it never overwrites revision N.
   The existing `plan_work_packages.revision` points at the current revision.

3. Extend `plan_dispatch_attempts` with non-null-for-new-row
   `workspace_id`, `plan_artifact_id`, `intent_id`, `package_revision`, and nullable
   `orchestration_id`, `target_session_id`. `target_agent_id` records the dashboard
   agent; `target_session_id` is filled only when delivery confirms the actual session.
   The row must reference the exact package revision and, when present, an orchestration
   whose `(plan_id, planning_intent_id)` matches. Keep `confirmed_turn_id` as delivery
   evidence; do not infer delivery or package state from that turn's terminal status.

4. Create `plan_package_gate_attempts`:

   - `id`, package/revision/plan identity columns, `dispatch_attempt_id`, `gate_key`,
     `gate_revision`, `attempt_no`, `outcome`, `witness_agent_id`,
     `witness_session_id`, `witness_turn_id`, `evidence_json`, `decided_at`;
   - outcomes are `pending`, `passed`, `failed`, or `cancelled`; absence is unknown,
     never success;
   - unique `(package_id, package_revision, gate_key, attempt_no)`;
   - a production-entry gate is a required named gate for behavior packages under
     Cluster B. A gate may verify many commits and a commit may be verified by more
     than one gate.

5. Create `plan_package_commit_links` for package membership and
   `plan_package_gate_commit_links` for verification:

   - package link key `(package_id, package_revision, repository_key, commit_oid)` with
     `relation` in `implementation`, `gate-fix`, `verification`, `merge` and a stable
     `chain_ordinal`;
   - gate link key `(gate_attempt_id, repository_key, commit_oid)`;
   - both reference `commit_records(repository_key, commit_oid)` and never accept an
     abbreviated OID;
   - package completion requires every declared implementation commit to be covered by
     the latest passed required gates. This is the missing machine join for the 13-commit
     case-study chain.

6. Create append-only `plan_package_deployment_events`:

   - `id`, package/revision/plan identity, `environment`, `state`, optional canonical
     repository/OID, `witness_agent_id`, `witness_session_id`, `detail_json`,
     `occurred_at`;
   - states are `not_required`, `not_deployed`, `deploying`, `deployed`, `failed`, and
     `rolled_back`;
   - current deployment state is the latest event per package revision/environment.
     A null row means unknown, not `not_required`. The historical case is explicitly
     `not_deployed`, because no push/deploy or manual Electron acceptance occurred.

7. Replace `plan_wp_lifecycle_events` as write authority with append-only
   `plan_package_state_events`: `id`, full plan/package/revision identity,
   `from_state`, `to_state`, `cause_kind`, `cause_id`, `actor_agent_id`,
   `actor_session_id`, `reason`, `occurred_at`, and `idempotency_key`. Allow all package
   states, including `done`, in this one table. Existing lifecycle rows and successful
   plan-package finalizations are imported once with deterministic idempotency keys;
   old tables remain readable evidence but receive no new state writes.

8. Create append-only `continuation_handoff_result_events`, separate from package
   state and checkpoint turns:

   - `id`, `handoff_attempt_id`, `result_kind`, `outcome`, `dashboard_agent_id`,
     `generation`, `brick_id`, `source_session_id`, `successor_session_id`,
     `kickoff_turn_id`, `completion_quality`, `detail_json`, `witnessed_at`;
   - result kinds are exactly `brick_saved`, `successor_started`, and
     `successor_oriented`; outcomes are `succeeded`, `failed`, or `timed_out`;
   - key/index `(handoff_attempt_id, result_kind, witnessed_at)` and an idempotency
     constraint per witnessed event permit a timeout followed by later success without
     rewriting history.

   `brick_saved` is emitted after the brick insert commits; `successor_started` only
   after the runner-launch tail reports the new session live; `successor_oriented` only
   after the attempt-correlated kickoff turn completes successfully. These events link
   to turn/session evidence but never update `turn_records.status`, checkpoint quality,
   or `failure_reason`.

## The single supported package transition API

Add `transitionPlanPackage(command, witness)` in
`src/main/plans/package-ledger.ts`. It is a main-process service, not a general SQL/IPC
patch endpoint. Commands are a closed discriminated union: `dispatch-confirmed`,
`block`, `unblock`, `gate-decided`, `commits-observed`, `deployment-observed`,
`complete`, `reopen`, and `archive`. Each command carries an idempotency key; the
service derives actor/session/time from the authenticated server witness where
available.

One SQLite transaction must: resolve and validate plan/artifact/intent/package revision;
insert the command's evidence rows; validate the legal state edge and its prerequisites;
append one state event if state changes; and update `plan_work_packages` as a projection.
No renderer request may supply a trusted gate outcome, session id, commit existence, or
deployment success. The relevant main-process subsystem witnesses those facts and calls
the service. Replays return the prior result; conflicting reuse of an idempotency key
fails.

`complete` is legal only when the latest revision has a confirmed dispatch where
required, all required gates passed, every implementation commit is present in
`commit_records` and covered by the passed gates, the package finalization boundary is
ready/committed as required by its kind, and deployment has an explicit state. A failed
gate moves executing work to blocked; a later passed retry does not erase the failure.
`done` is therefore no longer split between `plan-lifecycle.ts` and
`finalization-service.ts`.

Handoff results use a sibling server-only `recordHandoffResult(...)` API because they
are a different lifecycle. Sharing the package transition vocabulary would recreate
the D3 status-overloading bug.

## D2 constraints, without redesigning D2

D2 owns parsing, rejection/quarantine, and backfill policy. D1 consumes these
postconditions:

- `plans.artifact_id` must match `plan_[0-9a-f]{8}` and `source_proposal_id` must point
  at a valid, non-quarantined `prop_[0-9a-f]{8}` row before a package revision can be
  created or dispatched.
- `intent_id` must match `int_[0-9a-f]{8}` and exist in `plan_intents` for the same
  plan. Package dispatch and orchestration launch reject a missing/mismatched intent;
  they do not silently write null.
- New orchestration launches require both `plan_id` and `planning_intent_id` after D2
  validation. Legacy null-bound run `a1bacc4a` remains historical evidence and is
  linked only by an explicit reviewed backfill, never by matching topic/path/time.
- Quarantined legacy IDs remain visible and read-only. The D1 migration records them
  in diagnostics and does not mint replacement identities or guess joins.

## D4 enforcement and migration

1. Add anchored ignore rules for only
   `/.lares/plans/*/plan.json.lock*`, `/.lares/plans/*/plan.json.wtmp-*`, and the
   `.dashboard` equivalents. Do not ignore `plan.json` or any plan subdirectory.
2. Add `scripts/check-plan-folder-versioning.mjs`. It enumerates regular files under
   both state-dir plan roots, classifies only the approved ephemeral patterns as local,
   runs `git ls-files --error-unmatch` for every durable file, and prints a deterministic
   tracked/untracked report. `--check` exits nonzero on an untracked durable file, a
   tracked ephemeral file, a missing tracked file, or a plan folder lacking a tracked
   valid `plan.json`.
3. Add an npm script and CI invocation for the checker, plus unit tests in
   `scripts/check-plan-folder-versioning.test.mjs` covering the superseded-draft/winning-
   synthesis case, untracked `plan.json`, lock temporaries, spaces, and the
   `.dashboard` fallback.
4. Update `scripts/plan-manifest.mjs` scaffold/manifest output and the mirrored
   constants in `src/shared/constants.ts` to state that every durable created artifact
   must be included in the owning commit. Bump every affected scaffold version and
   retain cumulative `previousHashes`; do not silently rewrite existing workspaces.
5. Migrate the current population as a dedicated reviewed commit after inspecting the
   two modified ARC files and all 47 untracked files. Stage an explicit manifest, not
   `.lares/plans/**` wholesale. The commit must include all valid durable artifacts,
   particularly every `plan.json`, active synthesis, folded research report, and
   deliberation; exclude only proven temporary/local material. Run the checker against
   the prepared index before committing.

## File-level implementation plan

1. **Schema and migration — `src/main/database.ts`, `src/main/database.*.test.ts`.**
   Add the tables/indexes/guarded columns above, row mappers, append-only accessors,
   deterministic migration from lifecycle/finalization rows, full-OID validation, and
   DB-only projection queries. Extend dispatch rows without weakening legacy reads.
2. **Authority service — new `src/main/plans/package-ledger.ts` and
   `package-ledger.test.ts`.** Implement the command union, state machine,
   prerequisite checks, idempotency, witness derivation, and atomic projection update.
   Tests must prove direct SQL-era writers cannot bypass the service through any
   production call site.
3. **Existing writers — `src/main/plans/plan-lifecycle.ts`,
   `src/main/commit-candidates/finalization-service.ts`,
   `src/main/git-checkpoints/commit-reconciler.ts`, and dispatch wiring.** Route
   confirmed dispatch, finalization/done, commit observation, block/retry, and archive
   through `transitionPlanPackage`; remove direct `plan_work_packages.state` updates.
4. **Gate/deployment ingestion — new `src/main/plans/package-gates.ts` and
   `package-deployments.ts` with tests.** Validate server evidence and call the sole
   transition API. Until a real deployment adapter exists, record explicit
   `not_deployed`/`not_required`; never infer deployment from commit reachability.
5. **D3 recording — `src/main/database.ts`,
   `src/main/supervisor/continuation-watcher.ts`, `src/main/supervisor/index.ts`, and
   continuation lifecycle tests.** Add the handoff result events at the three exact
   witness seams. Land alongside D3's compare-and-delete, serialize-behind-close, and
   unbounded reconciliation fixes; assert checkpoint-turn status is untouched.
6. **DB-only read surface — new `src/main/plans/plan-ledger-projection.ts`,
   `src/main/plans/plan-ipc.ts`, `src/preload/index.ts`, shared types, and Mission Board
   components/tests.** Return plan identity, source proposal, intent, revision,
   dispatch/agent/session, gate attempts, ordered commit chain, deployment state, and
   state history from SQLite only. Add a test dependency that throws on every filesystem
   read to prove the projection is DB-only.
7. **Version-control policy — `.gitignore`, the checker files, `package.json`, CI,
   scaffold constants/scripts/tests, and the reviewed plan-population commit.** Enforce
   the uniform policy in both scaffolding and verification.

## D1 acceptance

Build a historical fixture for `plan_5b3ea7d1` from reviewed evidence, not heuristics.
Backfill its 11 completed package revisions, dispatch agents/sessions where proven,
gate attempts, explicit `not_deployed` states, and these 13 full OIDs resolved from Git:
`c26fa62b`, `386b37e7`, `edf72436`, `218b4bf1`, `fe743334`, `5a121843`,
`9080f53d`, `e52ad5fb`, `b4617499`, `f6bb12a3`, `885edc25`, `deefad3c`,
`8b2af592`. The migration tool must expand each abbreviation with `git rev-parse`, reject
ambiguity/missing objects, and store only 40-hex OIDs.

Acceptance passes only when:

1. the plan renders with the plan folder temporarily unavailable and with filesystem
   reads configured to fail;
2. the DB projection reports all 11 packages complete, not WP6-WP8 blocked, while
   preserving every historical failed/retried gate;
3. its ordered package commit union equals the independently verified 13-OID chain
   exactly—no missing, extra, abbreviated, or duplicate OID—and every implementation
   OID is covered by a passed required gate;
4. `e52ad5fb` is visibly associated with the failed/incomplete production-entry proof
   and `b4617499` with the correcting gate/commit evidence;
5. orchestration `a1bacc4a` is not silently attributed; it remains unbound until an
   explicit reviewed D2 backfill supplies plan and intent;
6. D3 fixtures independently show `brick_saved`, `successor_started`, and
   `successor_oriented` for one attempt while the note turn remains normally accepted,
   plus partial-failure cases for each boundary; and
7. the plan-folder checker passes with every durable artifact tracked and only lock/temp
   files exempt.

Run the new database/service/projection/D3/versioning tests, the full sibling plan and
continuation suites, `npm run build`, and the DB-only historical acceptance fixture.
Do not launch or restart the Electron app as part of this package unless separately
authorized; the plan's deployment/manual acceptance state must remain visibly
`not_deployed`.
