---
kind: work-packages
plan_artifact_id: plan_ac37e3ae
authored_at: 2026-08-09
author: "Planning supervisor — Refining Save Card in App Experience (dc4a15ae)"
---

# Work packages — Save Card & checkpoints: intent-first save, graduated concurrency, activity worktrees

Decomposition of plan_ac37e3ae after the int_7d41c9a2 design deliberation
(`../deliberations/2026-08-09-intent-architecture-design.md` — cited below as "the design").
The prose bundle contracts below are the authority on scope; the machine block is an additive
projection. WP-1…WP-7 land behind the `intentPackaging` feature flag (design §8); WP-U1/WP-U2
are flag-free quick unblocks shippable immediately.

Standing gates for every WP: (a) prove the production entry point — a service/IPC handler with
green tests but no production registration/preload wiring is NOT complete (this failed twice
before in save-card work); (b) run `tsc` on both processes, not just the test runner; (c) commit
only cleanly-owned hunks — the shared tree carries foreign uncommitted work.

<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_ac37e3ae",
  "packages": [
    {
      "id": "WP-U1",
      "order": 10,
      "title": "Save Card quick unblocks: readable subjects, path acks, bulk acknowledgement",
      "initial_state": "ready",
      "acceptance_conditions": [
        "No default commit subject contains a truncated hash; subjects derive from plan/turn context when resolvable, else a readable file-list form.",
        "Acknowledgement rows render member.path.displayPath, never a content hash.",
        "A 100-file unattributed/untracked backlog is acknowledgeable in at most two gestures (acknowledge-all or per-directory atoms), with per-file acks still available."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/save-card-ipc.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/CandidatePreview.tsx", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" },
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-U2",
      "order": 20,
      "title": "Batch the git work: single temp index, bounded parallelism, incremental sweep refresh",
      "initial_state": "ready",
      "acceptance_conditions": [
        "A parity fixture proves identical member OIDs and identical refusal behavior versus the per-member path.",
        "Preview plus commit of a 100-file candidate completes in seconds, not minutes, in the test harness.",
        "Save-sweep no longer runs a full inventory refresh after every package."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/commit-representation.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/commit-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/save-sweep-service.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-1",
      "order": 30,
      "title": "Intent identity and immutable dispatch join",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Retrying one dispatch reuses one intent; two briefs under one plan item mint two intents.",
        "Wire-shaped callers cannot inject an intent id; stamps are minted main-side pre-delivery via a private-symbol carrier.",
        "Confirmed turns carry the intent immutably through restart, continuation, fork, and revive."
      ],
      "paths": [
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/dispatch-context.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/turn-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/main/plans/plan-lifecycle.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/witness-projection.ts", "intent_kind": "edit" },
        { "path": "src/shared/types.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-2",
      "order": 40,
      "title": "Intent inventory and Save Card projection",
      "initial_state": "ready",
      "acceptance_conditions": [
        "One intent spanning disconnected topology components renders as one task card; one topology component holding two intents renders as two cards.",
        "Unwitnessed paths never acquire provenance; adopt-all-as-baseline mints one auto-named save-set in one gesture; legacy unstamped turns are labeled honestly.",
        "Named-save-set membership is main-owned, byte-addressed, and goes stale on inventory-digest change."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/intent-assembler.ts", "intent_kind": "create" },
        { "path": "src/main/commit-candidates/work-bundle.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/save-card-routes.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" },
        { "path": "src/shared/types.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-3",
      "order": 50,
      "title": "Concurrency classification and the cross-intent resolution picker",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Same-intent overlap and provably convergent or carried-forward cross-intent cases produce no warning and no blocking atom.",
        "Only cross-intent suspected lost-update blocks, with exactly one picker case per path and intent pair; missing evidence is reported as evidence-incomplete, never as a collision.",
        "Resolutions are persisted evidence-bound (evidenceDigest); any byte or witness change invalidates them; lost-work restore routes through supervisor-side restore authority only."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/concurrency-policy.ts", "intent_kind": "create" },
        { "path": "src/main/git-checkpoints/contention-model.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/checkpoint-service.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/CandidatePreview.tsx", "intent_kind": "edit" },
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-2"]
    },
    {
      "id": "WP-4",
      "order": 60,
      "title": "Candidate and commit contract v2 with the intent ledger",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Selection is by intent id; a topology component spanning unrelated intents no longer fuses them into one commit.",
        "Commit-together yields one commit with both intent links; intentional supersession records losing evidence without inventing authorship.",
        "Stale intent revisions or resolution digests refuse mint and commit; the isolated-index, tree-verification, HEAD-CAS, and unrelated-dirt guarantees stay green.",
        "Default messages use the readable save-unit, plan, and plan-item titles; internal UUIDs stay out of the shareable body."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/candidate-service.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/finalization-service.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/commit-coordinator-ipc.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/save-card-ipc.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/commit-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" },
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-2", "WP-3"]
    },
    {
      "id": "WP-5",
      "order": 70,
      "title": "Planning-activity worktree provisioning and dispatch routing",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Implement creates exactly one app-owned detached worktree per execution run on refs/lares/activities, outside the repo, with ownership marker; unborn HEAD refuses Implement cleanly.",
        "All the run's task dispatches share the worktree cwd; wrong-cwd dispatch fails before delivery; conversational work stays on the primary tree.",
        "Provisioning crashes recover via startup reconciliation without losing the baseline or activity head; no second workspace is registered."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/planning-worktree-service.ts", "intent_kind": "create" },
        { "path": "src/main/git-checkpoints/planning-worktree-reconciler.ts", "intent_kind": "create" },
        { "path": "src/main/plans/plan-implement.ts", "intent_kind": "edit" },
        { "path": "src/main/plans/plan-lifecycle.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/dispatch-context.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/candidate-service.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-6",
      "order": 80,
      "title": "Merge-back, conflict UI, cleanup, and recovery",
      "initial_state": "ready",
      "acceptance_conditions": [
        "A clean saved task promotes into primary in one gesture via an isolated three-way merge; primary dirt outside the merge is never touched; HEAD races produce stale retries, never clobbers.",
        "Two plans touching the same file incompatibly leave the second safely committed on its activity ref with a persisted conflict UI; primary stays untouched.",
        "Cleanup runs only at activity completion after ALL proofs (reachability, clean worktree, no lease, no pending merge, ownership marker); failures mark recovery-required, never force-delete."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/activity-merge-service.ts", "intent_kind": "create" },
        { "path": "src/renderer/components/save/PlanMergeBack.tsx", "intent_kind": "create" },
        { "path": "src/main/git-checkpoints/planning-worktree-service.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/save-card-routes.ts", "intent_kind": "edit" },
        { "path": "src/main/database.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-4", "WP-5"]
    },
    {
      "id": "WP-D3",
      "order": 90,
      "title": "Provenance durability: Assisted-by policy and checkpoint-ref pinning",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Assisted-by provider:model trailers ride only witnessed agent work, never human-claimed or adopted-baseline saves, with a per-repo opt-out.",
        "Promoted commits pin their referenced checkpoint refs past normal retention; ref-pointer trailers are local-only and labeled as such."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/commit-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/main/git-checkpoints/retention.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-4"]
    },
    {
      "id": "WP-D6",
      "order": 100,
      "title": "Opt-in candidate-tree validation and repo-policy signing",
      "initial_state": "ready",
      "acceptance_conditions": [
        "When enabled per repo, validation runs against the exact constructed candidate tree (not the dirty worktree) before the CAS commit and may refuse, never modify, the reviewed bytes.",
        "Default remains off; hooks stay bypassed; repo-policy signing signs the commit without altering the verified tree."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/candidate-validation.ts", "intent_kind": "create" },
        { "path": "src/main/git-checkpoints/commit-coordinator.ts", "intent_kind": "edit" },
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-4"]
    },
    {
      "id": "WP-7",
      "order": 110,
      "title": "Cutover, legacy removal, and end-to-end verification",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "All WorkBundle consumers migrate to intent units; component-subset-not-allowed and generic overlap-ack paths are removed; legacy package finalizations and unstamped turns keep read-only rendering.",
        "The ten end-to-end scenarios in the design document section 9 pass, including crash-recovery idempotency.",
        "Full commit-candidate, checkpoint, planning-lifecycle, renderer save, and production-IPC suites are green before the intentPackaging flag is removed."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/work-bundle.ts", "intent_kind": "edit" },
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" },
        { "path": "src/shared/types.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-U2", "WP-6", "WP-D3", "WP-D6"]
    }
  ]
}
-->

## WP-U1 - Save Card quick unblocks: readable subjects, path acks, bulk acknowledgement

**Files:** `src/main/commit-candidates/save-card-ipc.ts` (`deriveDefaultMessageBody`, ~line 601);
`src/renderer/components/save/CandidatePreview.tsx` (ack row, ~line 400);
`src/renderer/components/save/SaveCard.tsx`; `src/shared/commit-candidates.ts` (ack atom shape if a
directory-level atom is added); sibling tests of each.

**Dep:** none. Flag-free; ships before the intent model.

**Do:** (U1 interim) Replace the `Save component:<hex>` subject: derive from the contributing
turns' plan/task context already in scope at commit time when resolvable; fall back to a readable
file-list form ("Save: 3 files in src/renderer"). Demote full untruncated hashes to trailers —
never bake U+2026 into a commit object. (U2) Render `member.path.displayPath` in unattributed
acknowledgement rows. (U3) Add an acknowledge-all control and/or one acknowledgement atom per
untracked directory subtree, so `--untracked-files=all` explosions group the way git groups them.

**Accept:** see machine block.

**Non-goals:** the intent model, schema changes, U4 performance work, any change to what requires
acknowledgement (policy stays; only its granularity and labels change).

**Verify:** renderer save suites + main save-card suites + sibling suites of touched files; `tsc`
both processes; manual Save-pane open against this repo's real dirty tree.

## WP-U2 - Batch the git work: single temp index, bounded parallelism, incremental sweep refresh

**Files:** `src/main/commit-candidates/commit-representation.ts` (~lines 122–200);
`src/main/git-checkpoints/commit-coordinator.ts` (final revalidation loop);
`src/main/commit-candidates/save-sweep-service.ts` (`refreshInventory` per package); tests.

**Dep:** none. Flag-free.

**Do:** One temp index for ALL members of a candidate — single `read-tree HEAD`, single
`git add --pathspec-from-file`, single `ls-files --stage -z` — replacing per-member
mkdtemp + 4 spawns. Bounded-pool parallelism for remaining per-member reads. Make the
coordinator's sequential revalidation loop concurrent. Make sweeps refresh inventory
incrementally rather than a full status + attribution join after every package.

**Accept:** see machine block. No semantic change: the same OIDs get verified, the same
refusals fire.

**Non-goals:** changing verification semantics, staging policy, or the CAS commit; UI work.

**Verify:** parity fixture old-path vs new-path OIDs; full commit-candidate suite; a timed
harness case at ~100 files.

## WP-1 - Intent identity and immutable dispatch join

**Files:** `src/main/database.ts` (migration: `save_intents`, `intent_id` columns on
`turn_records` / `plan_dispatch_attempts` / continuation records, immutable-stamp trigger);
`src/main/git-checkpoints/dispatch-context.ts` (`ResolvedIntentStamp`, private-symbol carrier
parallel to `withResolvedPlanStamp`); `src/main/git-checkpoints/turn-coordinator.ts` (persist at
turn allocation); `src/main/plans/plan-lifecycle.ts` (`dispatchPlanPackage`: transactional
get-or-create keyed on dispatch attempt); `src/main/commit-candidates/witness-projection.ts`
(project `intentId`); `src/shared/types.ts`; tests.

**Dep:** none (first architecture stage; behind `intentPackaging`).

**Do:** Design §2.2–§2.4 verbatim: mint task intents main-side in ONE transaction with the
dispatch attempt; retries reuse; continuations/forks/revives carry; task membership derived from
immutable turn stamps, never stored.

**Accept:** see machine block.

**Non-goals:** any Save Card UI change; named save-sets (WP-2); worktrees (WP-5) — the
`execution_run_id` column ships nullable and unused here.

**Verify:** database migration tests; dispatch-context and turn-coordinator suites; `tsc` both
processes; grep that no wire schema gained an `intentId` field.

## WP-1b - Production wiring for intent identity (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after WP-1 implementation proved its acceptance
conditions unreachable from the original Files list: `dispatchPlanPackage` had no production
caller, and fork/revive intent carry requires the supervisor runtime. WP-1 landed its foundation
flag-gated; WP-1b makes it production-reachable. Prose here is scope authority; the machine block
is deliberately NOT amended.

**Files:** `src/main/plans/plan-lifecycle.ts`; the production plan-dispatch route (wherever
Implement/dispatch actually calls into plan lifecycle — locate it, e.g. `plan-ipc.ts` /
`plan-implement.ts` / main registration); `src/main/supervisor/index.ts` (fork + revive intent
carry); tests, including one that obtains the dispatch path the way production obtains it.

**Dep:** WP-1 foundation commit.

**Do:** Wire `dispatchPlanPackage` (or fold its transactional get-or-create into the real dispatch
call path) so production dispatches mint/reuse intents per design §2.2–§2.4; carry intent stamps
through fork and revive in `supervisor/index.ts`. All behind `intentPackaging`.

**Accept:** WP-1's machine-block acceptance conditions, now provable from production entry points.

**Non-goals:** everything WP-1 excluded; no scaffold-constant edits.

**Verify:** dispatch-context/turn-coordinator/plan suites + supervisor sibling suites; re-run the
package-dispatch suite WP-1 could not re-run; tsc both processes (foreign constants.ts dirt may
still be present — report, don't fix); production-entry-point grep evidence.

## WP-2 - Intent inventory and Save Card projection

**Files:** `src/main/commit-candidates/intent-assembler.ts` (NEW, pure projector per design
§2.5); `src/main/commit-candidates/work-bundle.ts` (compatibility adapter; stops defining primary
grouping); `src/main/commit-candidates/save-card-routes.ts` (plan → item → intent hierarchy);
`src/main/database.ts` (`named_save_set_members`); `src/renderer/components/save/SaveCard.tsx`
(hierarchy, Unwitnessed pool, adopt-all-as-baseline); `src/shared/types.ts` (`SaveIntentUnitDto`);
tests.

**Dep:** WP-1.

**Do:** Design §2.5–§2.6: `intentUnits` beside `bundles` (parity before cutover); membership rules
as listed (topology = evidence linkage only); main-owned named-save-set creation bound to the
inventory digest; the U5 one-gesture adopt-all-as-baseline; honest "Legacy task identity
unavailable" labeling.

**Accept:** see machine block.

**Non-goals:** removing legacy grouping (WP-7); concurrency atoms (WP-3); commit-path changes
(WP-4).

**Verify:** intent-assembler unit suite mirroring `projectWorkBundles` discipline; renderer save
suites; parity fixtures bundles-vs-intents on the same evidence.

## WP-3 - Concurrency classification and the cross-intent resolution picker

**Files:** `src/main/git-checkpoints/concurrency-policy.ts` (NEW: observe/classify/act, design §3);
`src/main/git-checkpoints/contention-model.ts` (stays advisory; add `intentId` to evidence);
`src/main/git-checkpoints/checkpoint-service.ts` (expose after-image blob restore input);
`src/main/database.ts` (`attribution_resolutions`);
`src/renderer/components/save/CandidatePreview.tsx` (versioned `cross-intent` atom + three-gesture
picker); `src/shared/commit-candidates.ts`; tests.

**Dep:** WP-2.

**Do:** Design §3 verbatim: per-path blob OIDs via `ls-tree` on checkpoint trees (never compare
whole-tree commit OIDs); the five-way classifier with exactly one blocking class; auto co-commit
with a non-blocking note for inseparable carried-forward paths; evidence-digest-bound persisted
resolutions; restore only through supervisor-side authority. Remove generic same-intent `overlap`
atoms and `acknowledgeTopologyDigest`.

**Accept:** see machine block.

**Non-goals:** hunk-level attribution (D2 — future intent); auto-classifying supersession
(human-only by design resolution 4); any pausing or auto-routing of agents.

**Verify:** classifier unit suite over fixture checkpoint trees incl. pruned-evidence cases;
picker renderer tests; end-to-end scenario 7 and 8 fixtures.

## WP-4 - Candidate and commit contract v2 with the intent ledger

**Files:** `src/main/commit-candidates/candidate-service.ts`;
`src/main/commit-candidates/finalization-service.ts` (generalize to `saveUnitId`/`saveUnitKind`;
`save_intent_finalizations` v2 with legacy read-only adapter);
`src/main/commit-candidates/commit-coordinator-ipc.ts` (v2 tokens only);
`src/main/commit-candidates/save-card-ipc.ts` (U1 final form: message from intent/plan titles);
`src/main/git-checkpoints/commit-coordinator.ts` (post-commit single-transaction ledger writes);
`src/main/database.ts` (`commit_intent_links`, finalizations v2); `src/shared/commit-candidates.ts`
(manifest v2, `MintCandidateTokenRequestV2`); tests.

**Dep:** WP-2, WP-3.

**Do:** Design §2.3 and §6 verbatim: selection by intent ids; normalized Git operation closure
replaces `component-subset-not-allowed` as the safety closure; resolutions required for every
selected suspected-lost-update; intent + resolution documents bound into `candidateId`; the
existing isolated-index / tree-verify / HEAD-CAS core untouched; readable default message shape.

**Accept:** see machine block.

**Non-goals:** deleting v1 read paths (WP-7 does cutover); worktree contexts (WP-5/6);
Assisted-by policy (WP-D3).

**Verify:** candidate-service + coordinator suites incl. every existing refusal; v1/v2 parity
fixtures; production-IPC registration proven (mint and consume reachable from preload, not only
from tests).

## WP-4 addendum - Picker-persistence production wiring (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after WP-4 implementation proved supervisor gate C
(picker persistence reachable end-to-end) unreachable from the WP-4 Files list: no
attribution-resolution method exists in the preload bridge, no window API contract in shared
types, and SaveCard does not supply `onCrossIntentResolution` to CandidatePreview, so picker
choices stay renderer-local. Prose here is scope authority; the machine block is deliberately
NOT amended (precedent: WP-1b).

**Files (additional, gate-C wiring only):** `src/preload/index.ts` (attribution-resolution IPC
method); `src/shared/types.ts` (preload/window API contract only); 
`src/renderer/components/save/SaveCard.tsx` (supply `onCrossIntentResolution`, wire to the
preload method); `src/renderer/components/save/CandidatePreview.tsx` (only if the callback seam
itself needs adjustment); sibling tests.

**Non-goals:** any other change in these four files; no new renderer features; no scaffold or
constants edits.

**Extension (same day, second stop):** WP-4 implementation then proved the core v2 mint path
itself unreachable: the production mint route is `src/main/commit-candidates/preview-routes.ts`
(builds candidate contexts exclusively from component/unattributed selections and forwards
`selectedComponentIds`/`selectedUnattributedEntryIds`/`acknowledgeTopologyDigest`), registered
via `src/main/ipc-handlers.ts` — none of which the WP-4 Files list contained. Without them,
commit-coordinator-ipc accepting v2 tokens only would leave production with no v2 token
producer (a dead bridge). Additional authority granted:

- `src/main/commit-candidates/preview-routes.ts` — fresh intent-selection resolution and v2
  mint forwarding; removing the `acknowledgeTopologyDigest` forwarding on this mint path is
  in scope (it IS gate B applied to this file); other remnants stay WP-7's.
- `src/main/ipc-handlers.ts` — only as far as the mint-adapter registration requires.
- `src/shared/types.ts` — v2 Save-card preview/mint transport contract (`SaveCardMintRequest`
  v2 shape), beyond the earlier gate-C-only allowance.
- Sibling tests of each.

**Non-goals (extension):** no other routes in preview-routes.ts / ipc-handlers.ts; v1 read
paths stay (WP-7 owns cutover).

**Extension 2 (third stop):** `CandidatePreview.tsx` authorization widened from callback-seam-only
to ALSO include the three refusal-label map entries required by the new v2 `CommitEligibility`
codes (`intent-revision-stale`, `resolution-required`, `resolution-stale`) — the map is
exhaustively typed, so the labels are a compile-time obligation of the v2 contract, not a
feature. Nothing else in the file.

## WP-5 - Planning-activity worktree provisioning and dispatch routing

**Files:** `src/main/git-checkpoints/planning-worktree-service.ts` (NEW);
`src/main/git-checkpoints/planning-worktree-reconciler.ts` (NEW, wired in `engine-bootstrap.ts` —
wiring is in scope); `src/main/plans/plan-implement.ts` (provision before run activation; unborn
refusal); `src/main/plans/plan-lifecycle.ts` (route delivery to activity cwd; freeze
`executionRunId` into the stamp); `src/main/git-checkpoints/dispatch-context.ts` (capability from
activity binding); `src/main/commit-candidates/candidate-service.ts` + `scope-discovery.ts`
(enumerate activity roots); `src/main/database.ts` (`planning_activity_worktrees`); tests.

**Dep:** WP-1 (intent stamps carry the run binding). Parallelizable with WP-3/WP-4.

**Do:** Design §4 verbatim: app-owned path outside the repo with ownership marker; detached
worktree on `refs/lares/activities/<run>/head` (base64url via `ref-encoding.ts`); one logical
workspace with per-worktree `repositoryKey`; companion-table lifecycle with `provisioning` state
pre-activation; the nine-step creation sequence; wrong-cwd dispatch refusal; atomic HEAD +
activity-ref advance on save.

**Accept:** see machine block.

**Non-goals:** merge-back and cleanup (WP-6); registering worktrees as workspaces; path-salted
repositoryKey changes without `repository-identity.ts` confirmation.

**Verify:** service + reconciler suites with crash-point fixtures at every step of the creation
sequence; a real `git worktree add` integration test on a scratch repo; `engine-bootstrap`
registration proven in production wiring.

## WP-6 - Merge-back, conflict UI, cleanup, and recovery

**Files:** `src/main/git-checkpoints/activity-merge-service.ts` (NEW, design §5);
`src/renderer/components/save/PlanMergeBack.tsx` (NEW);
`src/main/git-checkpoints/planning-worktree-service.ts` (cleanup proofs, states);
`src/main/commit-candidates/save-card-routes.ts` (promotion status projection);
`src/main/database.ts` (`activity_merge_attempts`, `activity_merge_conflicts`); tests.

**Dep:** WP-4, WP-5.

**Do:** Design §5 verbatim: isolated-temp-index three-way promotion with per-path primary
cleanliness verification and HEAD CAS; eager per-task promotion with "Saved in plan; promotion
pending" fallback; persisted merge attempts/conflicts; the merge-back UI (content conflict,
explicitly NOT the Q1 attribution picker; no whole-file Commit-together); proof-gated cleanup only
at activity completion; the full startup-recovery matrix (design §5.4).

**Accept:** see machine block.

**Non-goals:** plan-level batch/squash promotion (deferred repo policy); force-deleting anything.

**Verify:** merge-service suite over conflicting/compatible/racing fixtures; recovery matrix
fixtures (each row of §5.4); renderer conflict-UI tests; end-to-end scenarios 4–6 and 10.

## WP-6 addendum - Production seams for merge-back (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after WP-6 implementation proved three acceptance
seams unreachable from the WP-6 Files list (worker stopped correctly, zero edits). WP-1b/WP-4
precedent; machine block deliberately NOT amended. Additional authority, granted as the full
production chain up front to avoid serial stops:

- `src/main/git-checkpoints/commit-coordinator.ts` — invoke the existing
  `advancePlanningActivityHead` primitive at the production Save call site (WP-5 carried gate
  item 1), and originate eager per-task promotion from that path. No other coordinator changes.
- `src/main/git-checkpoints/planning-worktree-reconciler.ts` — extend beyond `provisioning`
  rows to implement every design §5.4 recovery row.
- `src/renderer/components/save/SaveCard.tsx` — render/mount `PlanMergeBack` and the
  per-activity card projection (WP-5 carried gate item 2); no other SaveCard changes.
- Merge-back IPC production chain, minimal seam each: `src/shared/commit-candidates.ts` and/or
  `src/shared/types.ts` (request/response + window API contract), `src/preload/index.ts`
  (binding), `src/main/ipc-handlers.ts` or `src/main/commit-candidates/save-card-ipc.ts`
  (registration), `src/main/git-checkpoints/engine-bootstrap.ts` (bootstrap wiring only if the
  merge service requires it).
- Sibling tests of each.

**Non-goals (addendum):** everything WP-6 already excludes; no route/handler beyond the
merge-back + promotion-status surface; no constants/scaffold edits.

## WP-D3 - Provenance durability: Assisted-by policy and checkpoint-ref pinning

**Files:** `src/main/git-checkpoints/commit-coordinator.ts` (`defaultDeriveTrailers`, ~line 200);
`src/main/git-checkpoints/retention.ts` (pin promoted-commit refs); tests.

**Dep:** WP-4.

**Do:** Settled Q5/Q6 policy: `Assisted-by: <provider>:<model>` ON by default for witnessed agent
work only — never on human-claimed named-save-sets or adopted-baseline saves — with per-repo
opt-out; internal agent UUIDs local-only; promoted commits pin their referenced checkpoint refs
past normal retention; ref-pointer trailers honest about local scope. No transport contract
(Q6 option (a)).

**Accept:** see machine block.

**Non-goals:** cross-clone evidence transport; changing message body shape (WP-4 owns it).

**Verify:** trailer-derivation suite over witnessed/claimed/adopted fixtures; retention suite
proving pinned refs survive a prune pass.

## WP-D3 addendum - Production seams for trailer derivation and ref pinning (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after WP-D3 implementation proved both acceptance
conditions unreachable from the two-file list (worker stopped correctly, zero edits): production
trailer derivation was relocated by WP-4 into `preview-routes.ts` `productionSeams.deriveTrailers`
(so `defaultDeriveTrailers` edits would be bypassed); `CandidateTokenSnapshot` freezes no
provider/model provenance; retention has no production input mapping promoted commits to their
checkpoint refs (that linkage lives in WP-6's merge surfaces). Full chain granted up front:

- `src/main/commit-candidates/preview-routes.ts` — the `productionSeams.deriveTrailers`
  implementation only.
- `src/main/commit-candidates/candidate-service.ts` + `src/shared/commit-candidates.ts` —
  freeze witnessed provider/model provenance into `CandidateTokenSnapshot` (minimal fields;
  internal agent UUIDs stay OUT of any shareable shape).
- `src/main/index.ts` — coordinator/retention construction seam only if injection must change.
- `src/main/git-checkpoints/activity-merge-service.ts` and/or `src/main/database.ts` —
  record/expose the promoted-commit → referenced-checkpoint-ref linkage as retention's
  production input (minimal surface).
- Sibling tests of each.

**Non-goals (addendum):** no message-body changes; no UI; no cross-clone transport; nothing
else in the granted files; no constants/scaffold edits.

## WP-D6 - Opt-in candidate-tree validation and repo-policy signing

**Files:** `src/main/commit-candidates/candidate-validation.ts` (NEW);
`src/main/git-checkpoints/commit-coordinator.ts` (pre-CAS hook point);
`src/shared/commit-candidates.ts` (policy/config types); tests.

**Dep:** WP-4.

**Do:** Settled Q4/D6 policy: per-repo, off-by-default validation of the exact constructed
candidate tree (typecheck/build/test against the written tree, not the dirty worktree) before the
CAS commit — validation may refuse, never modify; hooks stay bypassed; optional repo-policy
signing of the commit object.

**Accept:** see machine block.

**Non-goals:** running repo hooks; any default-on behavior; mutating reviewed bytes ever.

**Verify:** validation-refusal fixtures (dependent-file-omitted tree fails, complete tree passes);
signing fixture; coordinator suite stays green with the feature off.

## WP-7 - Cutover, legacy removal, and end-to-end verification

**Files:** `src/main/commit-candidates/work-bundle.ts`; `src/shared/commit-candidates.ts`
(drop `component-subset-not-allowed`, `requiresOverlapAck`, `acknowledgeTopologyDigest`);
`src/shared/types.ts` (retire supervisor-first bundle DTO); `src/renderer/components/save/SaveCard.tsx`;
plus deletions/telemetry across files the earlier WPs touched — the prose Files lists of WP-1…WP-6
are the authority on the affected surface.

**Dep:** WP-U2, WP-6, WP-D3, WP-D6 (i.e., everything). `initial_state: blocked` until they land.

**Do:** Design §8 WP7: migrate remaining `WorkBundle` consumers to intent units; remove legacy
grouping and generic overlap-ack paths; retain read-only rendering for legacy package
finalizations and unstamped turns; telemetry for predicted/observed/classified/resolved/promoted/
recovered; run the design §9 ten end-to-end scenarios; remove the `intentPackaging` flag last.

**Accept:** see machine block.

**Non-goals:** new features; D2 hunk attribution.

**Verify:** full commit-candidate, checkpoint, planning-lifecycle, renderer save, and
production-IPC suites; the §9 scenario fixtures; a final dead-symbol audit of the removed names.

## WP-7 addendum - Renderer chain completion for the cutover (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after WP-7 implementation proved the shared-DTO
retirement unreachable from the WP-7 Files list: `SaveBundle.tsx` still defines and consumes
`WorkBundleDto` and reads `component.overlap.requiresOverlapAck`, and `save-card-expiry.ts` still
accepts `WorkBundleDto[]` — so removing the DTO and passing the dead-symbol audit is impossible
without them. Worker stopped correctly, zero edits. WP-1b/WP-4/WP-6/WP-D3 precedent; machine
block deliberately NOT amended. Granted as the full chain up front:

**Files (additional):**
- `src/renderer/components/save/SaveBundle.tsx` — retire, or convert to intent-unit rendering
  (whichever the design §8 cutover implies; legacy finalizations keep read-only rendering).
- `src/renderer/components/save/save-card-expiry.ts` — migrate expiry mapping from
  `WorkBundleDto[]` to `SaveIntentUnitDto[]`.
- Sibling tests: `save-card-expiry.test.ts`, any `SaveBundle` coverage affected by retirement
  (`SaveCard.test.tsx` already in WP-7 scope).

**Non-goals (addendum):** everything WP-7 already excludes; no new renderer features; no
constants/scaffold edits.

## WP-7 addendum 2 - Plan-review projection migration (supervisor scope addendum, 2026-08-09)

Minted by the responsible supervisor (dc4a15ae) after the worker's second correct stop (zero
edits): a full `src/` audit found one remaining production consumer of the retiring bundle
shape beyond the granted surface — `PlanReviewProjectionInput.scBundles` is `SaveCardBundle[]`,
with baseline-diff, selected-component, mixed-authorship, and capture-gap logic all consuming
bundles. Same precedent; machine block deliberately NOT amended.

**Files (additional):**
- `src/main/plans/plan-review-projection.ts` — migrate the projection input and its logic from
  `SaveCardBundle[]` to intent units plus read-only topology/inventory evidence (supplied by the
  already-authorized `plan-ipc.ts`).
- `src/main/plans/plan-review-projection.test.ts` — migrate fixtures and assertions accordingly.

**Non-goals (addendum 2):** no behavior change to what the review projection reports beyond the
evidence-shape migration; everything WP-7 already excludes.
