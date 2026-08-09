---
plan_artifact_id: plan_ac37e3ae
intent_id: int_7d41c9a2
orchestration_id: 5432c132
kind: deliberation
---

# Intent-first Save, graduated concurrency, and per-activity worktrees — one architecture

This deliberation serves marked intent `int_7d41c9a2`. It designs D5 (intent-first
packaging), D1 (graduated concurrency policy), and Q2 (worktree-per-planning-activity)
as one coherent architecture against the existing `src/main/commit-candidates/*` and
`src/main/git-checkpoints/*` code. The six §6 rulings of `plan.md` are settled policy
and are NOT reopened; this is design only. Integration and packaging into work packages
remain the responsible supervisor's job.

Two independent planners produced drafts and reconciled them; the resolved positions
below are what both converged on.

---

## 0. Synthesis summary

### Agreed (both drafts, unanimously)

- The Save Card groups by **semantic intent**, never by `ConflictComponent`.
- `ConflictComponent` (topology) is retained as **attribution/concurrency evidence**,
  not a commit boundary. Component connectivity stops gating candidate membership.
- Intent projection is a **pure** projector introduced **beside** the existing bundle
  projection (an `intentUnits` field alongside `bundles`) so parity tests and a safe
  renderer cutover are possible before legacy grouping is removed.
- **Same-intent overlap is silent** — no warning, acknowledgement, or challenge atom.
- Predictive contention (`contention-model.ts`) stays **advisory** — never pauses
  agents, never auto-routes.
- Named save-sets use **authoritative Git path bytes** and inherit the live-inventory
  self-cleaning property (a path committed by any means drops out).
- One planning activity = one **execution-run worktree** shared by all its agents.
- A genuine worktree **merge conflict** is distinct from Q1's save-time attribution
  picker; real three-way resolution is legitimate only at merge-back.
- Worktree provisioning, merge-back, cleanup, and restart reconciliation need
  **durable lifecycle state**.
- The isolated-index / CAS commit coordinator is the **trusted core** and is extended,
  not replaced.

### Disagreements, resolved

| # | Question | Resolution | Reason |
|---|---|---|---|
| 1 | Is a task the plan item, or finer? | **Finer. Mint a task `intentId`.** | Q3: "task (one dispatched brief) as the default unit, grouped under its plan item" is two levels. One plan item can be retried, continued, handed among agents, or split into several briefs. `(planId, planItemId)` is necessary context but insufficient identity. |
| 2 | Classifier compares `turn.before/afterOid`? | **No — resolve per-path blob OIDs.** | `turn_records.before/afterOid` are checkpoint **commit** OIDs for whole trees; unrelated paths move between checkpoints. The contested path's blob must be resolved with `ls-tree` in each checkpoint tree. |
| 3 | "ancestor blob" test? | **Dropped.** | Blobs have no ancestry in Git; only commits do. Initial classifier uses only mechanically provable blob-equality cases. Hunk survival is deferred to D2. |
| 4 | Auto-classify `superseded`? | **No. Supersession is a human resolution only.** | If later work never observed earlier's finished state, the system cannot know whether replacement was deliberate or accidental — that is exactly why the picker exists. Auto-`superseded` would reopen Q1. |
| 5 | Worktree location | **App-owned path outside the repo.** | An in-repo/adjacent linked worktree creates dirty inventory and recursive-discovery hazards. |
| 6 | Worktree branch | **Detached + `refs/lares/activities/<run>/head`.** | A `refs/heads/lares/plan/*` branch shows in ordinary branch tooling and is pushable by accident; activity state is internal like checkpoints. |
| 7 | Register worktree as its own workspace? | **No. One logical workspace; an activity binding supplies physical cwd + per-worktree `repositoryKey`.** | A second workspace pollutes selection and plan/workspace membership checks. Reuse the existing `repositoryKey` ≠ `objectDatabaseKey` separation. |
| 8 | Worktree lifecycle: run-row columns or companion table? | **Companion `planning_activity_worktrees` table.** | The run row is inserted atomically at `ready→executing`; the worktree must be provisioned **before** that transaction, so it needs a row that can exist pre-activation and be reconciled independently. |
| 9 | Promotion granularity | **Eager per-task promotion, worktree retained across tasks; batch/squash is a deferred repo policy.** | Each task IS a curated intent commit, so per-task promotion is not working-log noise; it keeps primary fresh and conflicts small. Do not foreclose plan-level batching later. |
| 10 | Cleanup timing | **At activity completion, never after one save.** | One worktree holds several task intents. |
| 11 | Orphan cleanup | **Never force-delete by name alone.** | A missing DB row may itself be the crash artifact while the worktree holds the only reachable work. Require the full proof set or mark `recovery-required`. |
| 12 | Unwitnessed dirt (U5) | **Named-save-set flow, plus a one-gesture "Adopt all unwitnessed as baseline" fast path.** | Honors U5's low-ceremony backlog escape without forcing full per-file curation. |
| 13 | Restore gesture authority | **Routes through supervisor-side restore authority; workers never restore.** | `plan.md` §1 is emphatic that restore is supervisor-side and destructive in a shared tree. |

---

## 1. Invariants (must hold across all work packages)

- A task `intentId` is minted/derived by the **main process** from the durable dispatch
  request **before** delivery. A renderer, API caller, prompt, agent, task label, or
  mutable plan selection cannot assert an intent ID.
- Delivery retry reuses the original intent; a genuinely new dispatched brief mints a
  new intent. Continuations and same-task forks carry the frozen intent stamp; a new
  delegated subtask gets a new intent even under the same plan item or agent.
- Human-terminal and otherwise unwitnessed changes have **no fabricated task intent**;
  they enter the named-save-set flow.
- Same-intent overlap is silent co-authorship. Only a **cross-intent suspected lost
  update** produces the attribution picker.
- Candidate identity binds intent membership, resolutions (each carrying an
  `evidenceDigest`), exact file representations, finalizations, and HEAD.
- The commit coordinator's isolated temp index, tree verification, and HEAD CAS are
  preserved unchanged; partial staging never rides unrelated dirt.
- A worktree is never destroyed while its commits or dirty files are not proven
  recoverable.
- Predictive contention never blocks or auto-routes.

---

## 2. Save-intent model (D5)

### 2.1 Where identity comes from

The chain already exists at dispatch and is persisted; only the **task-level key** is
missing:

```
dispatch (ResolvedPlanStamp)  →  turn_records.{plan_id, plan_item_id}  →  witness join
```

`dispatch-context.ts` (`buildDispatchTurnContext`, line 296) resolves a
`ResolvedPlanStamp {planId, planItemId, source}` server-side and freezes it onto
`TurnContext.planStamp`; the witness recorder persists it onto `turn_records`. We add a
minted task intent alongside it — **we do not redesign plan stamping.**

### 2.2 Schema (`src/main/database.ts`, new migration)

```sql
CREATE TABLE save_intents (
  id                  TEXT PRIMARY KEY,                -- svi_<uuid>; immutable
  workspace_id        TEXT NOT NULL,                   -- logical workspace (stable)
  execution_run_id    TEXT,                            -- activity binding, null for named-save-set
  repository_key      TEXT,                            -- activity worktree identity once resolved
  kind                TEXT NOT NULL CHECK (kind IN ('task','named-save-set')),
  plan_id             TEXT,
  plan_item_id        TEXT,
  title               TEXT NOT NULL,
  brief_digest        TEXT,                            -- SHA-256 of normalized dispatched brief
  dispatch_attempt_id TEXT UNIQUE,                     -- the durable dispatch occurrence
  created_by          TEXT NOT NULL CHECK (created_by IN ('task-dispatch','human-save-card')),
  created_by_id       TEXT,
  state               TEXT NOT NULL
                      CHECK (state IN ('open','ready','committed','superseded','abandoned')),
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  ready_at            INTEGER,
  committed_at        INTEGER,
  CHECK (
    (kind='task'           AND dispatch_attempt_id IS NOT NULL) OR
    (kind='named-save-set' AND dispatch_attempt_id IS NULL)
  )
);
CREATE INDEX idx_save_intents_plan_item ON save_intents(plan_id, plan_item_id, created_at);
CREATE INDEX idx_save_intents_run_state ON save_intents(execution_run_id, state);

-- Named save-set membership: explicit, byte-addressed, inventory-digest bound.
CREATE TABLE named_save_set_members (
  intent_id            TEXT NOT NULL REFERENCES save_intents(id) ON DELETE CASCADE,
  path_bytes_base64    TEXT NOT NULL,
  inventory_digest     TEXT NOT NULL,                  -- stale-detection anchor
  added_by_app_user_id TEXT NOT NULL,
  added_at             INTEGER NOT NULL,
  PRIMARY KEY (intent_id, path_bytes_base64)
);

-- Many-to-many so "Commit together" and carried-forward co-commits keep BOTH intents
-- as provenance without rewriting history to pretend they were one task.
CREATE TABLE commit_intent_links (
  repository_key  TEXT NOT NULL,
  commit_oid      TEXT NOT NULL,
  intent_id       TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  relation        TEXT NOT NULL
                  CHECK (relation IN ('primary','committed-together','superseded-evidence')),
  PRIMARY KEY (repository_key, commit_oid, intent_id, intent_revision)
);
```

**Task membership is never stored** — it is derived from immutable turn stamps so it
cannot drift from the evidence. Only named-save-set membership is stored (it has no
witnessing turn).

Add immutable columns to existing tables, protected by the **existing immutable-stamp
trigger** used for plan stamps:

```sql
ALTER TABLE turn_records            ADD COLUMN intent_id TEXT;
ALTER TABLE turn_records            ADD COLUMN intent_stamp_source TEXT;
ALTER TABLE plan_dispatch_attempts  ADD COLUMN intent_id TEXT;
-- continuation handoff records: add intent_id (carry).
```

### 2.3 Finalization — generalized, not duplicated

Do **not** map task identity back to plan-item identity to avoid schema work, and do
**not** stand up a parallel per-intent table casually. Generalize the existing
finalization contract to a **save unit**:

- Reuse `finalization-service.ts` boundary-freeze + durable-ref mechanics verbatim
  (`finalizePackage` failure-ordered sequence is the crash-safety contract).
- Introduce `saveUnitId` + `saveUnitKind` (`'plan-package' | 'task' | 'named-save-set'`)
  as the finalization key. `named-save-set` reuses the existing `fleet-adhoc` path
  (NULL plan attribution — `database.ts:1728` CHECK already allows it) with the
  save-set id as `package_id`.
- **Task intents cannot use the current plan-package uniqueness keyed on
  `plan_item_id`** (several task intents live under one plan item). Add a
  `save_intent_finalizations` v2 table keyed on `(save_unit_id, revision)`, and keep
  `package_finalizations` as a **read-only legacy adapter** during migration. New task
  and named-save-set commits use v2; the renderer reads both until parity holds.

```ts
interface SaveIntentFinalization {
  id: string;
  saveUnitId: string;                 // intentId or save-set id
  saveUnitKind: 'task' | 'named-save-set';
  revision: number;
  repositoryKey: string;
  frozenMembers: ReviewedFrozenMember[];
  boundaryRef: string | null;
  boundaryStatus: 'ready' | 'unavailable' | 'pruned';
  lifecycleStatus: 'active' | 'superseded' | 'committed' | 'abandoned';
  finalizedAt: number;
  finalizedBy: string;
}
```

### 2.4 Dispatch-time identity

Extend the plan-package dispatch path (`src/main/plans/plan-lifecycle.ts`
`dispatchPlanPackage()`; the resolver in `dispatch-context.ts`
`resolvePackageDispatchContext`) to, in order:

1. Validate package, plan item, target, and active execution run (unchanged).
2. Resolve the activity worktree for the execution run (§4).
3. In ONE SQLite transaction: get-or-create the `save_intents` **task** row keyed by
   `plan_dispatch_attempts.id`; insert the pending dispatch attempt carrying its
   `intent_id`; a retry reuses the same intent.
4. Build a trusted intent stamp and freeze it (private-symbol carrier, exactly
   parallel to `withResolvedPlanStamp`, `dispatch-context.ts:47` — a wire-shaped
   `requestedPlanBinding` must not gain an arbitrary `intentId` field).
5. Deliver into the activity worktree cwd (§4.3).
6. Confirm the turn as today; `intent_id` is written immutably at turn allocation.

```ts
interface ResolvedIntentStamp {
  intentId: string;
  kind: 'task';
  executionRunId: string | null;
  planId: string | null;
  planItemId: string | null;
  source: 'task-dispatch' | 'continuation-carry' | 'fork-carry' | 'revive-carry';
}

interface TurnContext    { /* existing */ intentStamp?: ResolvedIntentStamp }
interface TurnRecord     { /* existing */ intentId?: string | null; intentStampSource?: string }
interface ProjectedWitness { /* existing */ intentId: string | null }
```

A task becomes `ready` through an explicit completion/save boundary: saving an `open`
task performs a compare-and-set `open → ready`, freezes/increments its revision, and
creates its finalization. A committed intent is never silently reopened; further work
requires a new task intent.

### 2.5 Intent projection (`src/main/commit-candidates/intent-assembler.ts`, NEW)

Pure projector, same discipline as today's `projectWorkBundles` (membership copied from
evidence, no inference):

```ts
interface IntentAssemblyInput {
  inventory: DirtyInventory;
  witnesses: ProjectedWitness[];       // now carry intentId
  intents: SaveIntent[];
  namedMembers: NamedSaveSetMember[];
  topology: ComponentAssembly;         // ConflictComponent[] — evidence only
}

interface SaveIntentUnit {
  intent: SaveIntent;
  memberEntryIds: string[];
  contributingTurnIds: string[];
  contributingAgentIds: string[];
  topologyComponentIds: string[];      // evidence linkage
  concurrency: IntentConcurrencyEvidence;
  captureHealth: BundleCaptureHealth;
  weakestProtection: ProtectionRung | null;
}
```

Membership rules:

- A dirty entry witnessed by exactly one intent belongs to it.
- Several same-intent turns add contributors, not owners.
- One intent may gather entries from several topology components into one unit.
- One topology component may contain several intents without merging them.
- A path carrying several intent IDs is cross-intent evidence → classified (§3).
- An entry with no intent stamp stays in the **Unwitnessed** pool until placed in a
  named save-set.
- Legacy turns with `planId`/`planItemId` but no `intentId` render under **"Legacy task
  identity unavailable"** — never guessed into a new task.

Retire `component-subset-not-allowed` from candidate eligibility
(`commit-candidates.ts:406`). The real atomic safety closure is the **normalized Git
operation closure** already computed by `normalizeCommitEffects` (final path, rename
source, copy source/retention, modes, finalization obligations) — not component
connectivity.

### 2.6 Save Card projection (`SaveCard.tsx`, `save-card-routes.ts`)

Grouping hierarchy replaces supervisor-first grouping:

```
Plan title
  Plan item title
    Task intent title  → status, paths, contributors, evidence disclosure
Unplanned tasks
Named save-sets
Unwitnessed changes  → [Adopt all as baseline]  (one gesture; mints an auto-named save-set)
```

- Task title is the default commit subject; plan and plan-item titles form the message
  body (U1). Agents/topology live in a collapsed **"Attribution evidence"** section.
- Acknowledgement rows render `member.path.displayPath` (U2), never a content hash.
- `save-card-routes.ts` resolves plan/plan-item/intent labels and active activity roots;
  its supervisor/worker identity derivation becomes contributor metadata and no longer
  sets a `groupingKey`.
- Named-save-set creation is a **main-owned** mutation taking a name + selected
  authoritative entry IDs; main re-resolves them to path bytes and binds the current
  inventory digest. A changed/missing entry marks the set stale and requires review;
  the renderer cannot mint path membership.
- **"Adopt all unwitnessed as baseline" (U5)**: one gesture that mints an auto-named
  save-set over the entire Unwitnessed pool — the low-ceremony backlog escape hatch —
  without forcing per-file curation.

Renderer DTO (`src/shared/types.ts`):

```ts
interface SaveIntentUnitDto {
  intentId: string;
  kind: 'task' | 'named-save-set';
  title: string;
  state: SaveIntentState;
  plan: { id: string; title: string } | null;
  planItem: { id: string; title: string } | null;
  members: WorkBundleMember[];
  contributors: SaveCardWorkerUnit[];
  topologyEvidence: { componentIds: string[]; pathsWithMultipleTurns: string[]; captureHealth: BundleCaptureHealth };
  concurrencyCases: ConcurrencyCaseDto[];
  saveability: SaveCardPackageSaveability;
}
```

---

## 3. Graduated concurrency policy (D1)

New module `src/main/git-checkpoints/concurrency-policy.ts`. `contention-model.ts` stays
the predictor; the new module is the canonical observe/classify/act projection.

### 3.1 Predict (advisory only — unchanged behavior)

Reuse `contention-model.ts`. Add `intentId` to its evidence and surface a soft badge at
dispatch plus telemetry. **No** pause, serialize, or route on predictions (Q2).
Worktree-per-activity already isolates independent plans, so prediction mainly explains
contention among collaborating tasks inside one activity.

### 3.2 Observe — per-path blobs, not commit OIDs

`turn_records.beforeOid`/`afterOid` are checkpoint **commit** OIDs for whole trees.
Resolve the contested path in each checkpoint tree (`git ls-tree <commitOid> -- <path>`)
to get its blob OID:

```ts
interface PathIntentObservation {
  repositoryKey: string;
  path: EncodedGitPath;
  intentId: string | null;
  turnId: string;
  agentId: string | null;
  beforeCommitOid: string | null;
  afterCommitOid: string | null;
  beforeBlobOid: string | null;   // resolved via ls-tree; null when path absent/pruned
  afterBlobOid: string | null;
  finalBlobOid: string | null;    // current dirty-tree blob (DirtyEntry.rawWorktreeBlobOid)
  startedAt: number | null;
  endedAt: number | null;
  evidenceQuality: 'complete' | 'partial';
}
```

Do not infer order solely from `startedAt`; prefer verified edge relationships.

### 3.3 Classify — mechanically provable cases only

```ts
type ConcurrencyClassification =
  | 'same-intent-coauthor'
  | 'cross-intent-convergent'
  | 'cross-intent-carried-forward'
  | 'cross-intent-suspected-lost-update'
  | 'evidence-incomplete';
```

In precedence order, per contested path:

1. All contributing turns carry the same non-null intent → `same-intent-coauthor` (silent).
2. Different intents, equal `finalBlobOid` → `cross-intent-convergent` (silent).
3. A later verified `beforeBlobOid` equals an earlier intent's `afterBlobOid` →
   `cross-intent-carried-forward` (silent; later saw and continued earlier's result).
4. Different intents; later's `beforeBlobOid` ≠ earlier's `afterBlobOid` **and** the
   `finalBlobOid` differs from that earlier after-blob → `cross-intent-suspected-lost-update`
   (**the only blocking case**).
5. Required edges missing/pruned → `evidence-incomplete` (uses capture-health language;
   never mislabeled as a collision).

No `superseded` classifier result exists — supersession is a persisted **human**
resolution (§3.5). "Ancestor blob" tests are not used (blobs have no ancestry); provable
hunk survival is deferred to D2.

### 3.4 Carried-forward that cannot be separated

When cases 2/3 leave a shared path whose contributions cannot be separated without
reconstruction, candidate closure **automatically co-commits** the dependent intents,
records both in `commit_intent_links`, and shows a **non-blocking** note: *"Task B builds
on Task A in this file."* The human resolves nothing; D2 can later split provable hunks.

### 3.5 Act — resolution schema and picker

Only case 4 generates a blocking atom. Resolutions are persisted and evidence-bound so
they survive preview refresh and are auditable:

```ts
type CrossIntentResolution = 'commit-together' | 'superseded-intentionally' | 'restore-lost-work';

interface AttributionResolution {
  id: string;
  repositoryKey: string;
  pathBytesBase64: string;
  evidenceDigest: string;   // SHA-256 of {path, ordered intentIds+turnIds, per-path before/after blob OIDs, finalBlobOid, classifierVersion}
  earlierIntentId: string;
  laterIntentId: string;
  resolution: CrossIntentResolution;
  chosenByAppUserId: string;
  chosenAt: number;
  supersededIntentId: string | null;
  restoreTurnId: string | null;
  consumedByCandidateId: string | null;
}
```

Any byte or witness change alters `evidenceDigest` and invalidates the decision.

Picker behavior (one gesture; never a manual merge; agents never paused):

- **Commit together** — select both intent units into one candidate; write both
  `commit_intent_links` (`primary` + `committed-together`); preserve both intents rather
  than rewriting history. Communicates "these were actually one job."
- **Superseded intentionally** — assign the final path to the surviving intent; record
  the other as `superseded-evidence`; mark the whole intent `superseded` only when no
  active members remain. No disk mutation.
- **Work was lost — restore** — resolve the earlier intent's verified **after** checkpoint
  blob for that path, show the checkpoint→disk diff, then perform restore **through the
  supervisor-side restore authority** (`restore_paths` / checkpoint-forensics — workers
  never restore; `plan.md` §1). Restoration invalidates inventory, candidate, and
  resolution; the card refreshes from new bytes.

Update `ReviewChallengeAtom` (`commit-candidates.ts:196`) with a versioned `cross-intent`
atom; remove generic same-intent `overlap` atoms and `acknowledgeTopologyDigest`.

---

## 4. Planning-activity worktrees (Q2)

### 4.1 Durable lifecycle — companion table

A worktree must be provisioned **before** the `ready→executing` run activation
transaction, so it gets its own row (not columns on `plan_execution_runs`):

```sql
CREATE TABLE planning_activity_worktrees (
  execution_run_id       TEXT PRIMARY KEY REFERENCES plan_execution_runs(id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL,
  logical_workspace_id   TEXT NOT NULL,
  object_database_key    TEXT NOT NULL,     -- shared with primary
  activity_repository_key TEXT NOT NULL,    -- distinct per worktree
  primary_repository_key TEXT NOT NULL,
  path                   TEXT NOT NULL,
  baseline_oid           TEXT NOT NULL,
  activity_head_ref      TEXT NOT NULL,     -- refs/lares/activities/<run>/head
  promoted_head_oid      TEXT,
  state                  TEXT NOT NULL CHECK (state IN
    ('provisioning','active','merge-pending','merge-conflicted','merged','cleanup-pending','cleaned','recovery-required')),
  failure_code           TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
```

- **Path** is app-owned and outside the repo:
  `<app-user-data>/planning-worktrees/<workspace-id>/<execution-run-id>/`, carrying a
  persisted **Lares ownership marker** file verified before any cleanup.
- **Ref** `refs/lares/activities/<enc(executionRunId)>/head` (base64url id encoding,
  `ref-encoding.ts`), advanced by CAS `update-ref --stdin`. No `refs/heads/*` branch.
- **Identity**: keep the single logical workspace ID; the activity supplies physical cwd
  and a distinct `activity_repository_key`. Reuse the existing
  `repositoryKey` ≠ `objectDatabaseKey` separation (`RepositoryIdentity`,
  `commit-candidates.ts:5`); **do not** introduce path-salted `repositoryKey` until
  `repository-identity.ts` confirms its derivation supports linked worktrees. **Do not**
  register the worktree as a second workspace.

### 4.2 Creation at Implement (`src/main/plans/plan-implement.ts` + new `planning-worktree-service.ts`)

1. Recheck Implement eligibility.
2. Probe and pin primary HEAD (existing `probePlanBaseline`,
   `plan-baseline-refs.ts:98`). **Unborn HEAD → refuse Implement with
   `worktree-requires-initial-commit`** (a detached linked worktree needs a commit);
   do not silently fall back to the shared tree.
3. Allocate execution-run id + deterministic path.
4. Persist a `provisioning` activity row.
5. Create `refs/lares/activities/<run>/head` at the baseline.
6. `git worktree add --detach <path> <baselineOid>`.
7. Verify: shared common object database; worktree HEAD == baseline; per-worktree
   repository key ≠ primary key; ownership marker present.
8. In the run-activation transaction, insert/activate the run and flip the activity row
   to `active`.
9. Any pre-activation failure leaves recoverable ref/path recorded and returns
   `worktree-provision-failed`; startup reconciliation finishes or quarantines it.

### 4.3 Dispatch routing

- Every plan-package dispatch resolves its active run to the activity worktree and
  freezes `executionRunId` into the intent stamp.
- The delivery adapter launches/selects an agent session whose cwd **equals** the
  activity path. Dispatch to an agent attached elsewhere is refused
  (`target-agent-worktree-mismatch`); changing only checkpoint metadata while the
  process writes elsewhere is forbidden.
- `buildDispatchTurnContext` resolves git capability from the trusted activity binding,
  not the logical workspace's primary path (`resolveCapability`, `dispatch-context.ts:137`).
- `scope-discovery.ts` and `candidate-service.ts` enumerate active planning worktrees as
  Save Card inventory roots; separate worktrees are separate candidate repositories even
  though they share an object database.
- Conversational / quick / cross-cutting (non-run) work continues in the primary shared
  tree — the default collaboration mode.

### 4.4 Saving and activity-head durability

A task Save inside an activity worktree:

1. commits through the existing coordinator against that worktree's HEAD;
2. advances worktree `HEAD` and `activity_head_ref` in ONE `update-ref --stdin`
   transaction with expected-old values;
3. records the intent commit + `commit_intent_links`;
4. **eagerly** attempts promotion into primary (§5). If promotion cannot complete, the
   task shows **"Saved in plan; promotion pending"** and remains reachable via the
   activity ref and worktree. The worktree is **retained** for the run's other tasks.
   (Plan-level batch/squash promotion is a deferred repo-policy option, not foreclosed.)

---

## 5. Merge-back and recovery (Q2)

New module `src/main/git-checkpoints/activity-merge-service.ts`. It reuses the
coordinator's philosophy — never a live-worktree `git merge` that writes conflict
markers.

### 5.1 Clean promotion

Inputs: `base` = last promoted activity OID; `ours` = current primary HEAD; `theirs` =
current activity head. Then:

1. build the three-way result in an **isolated temp index**;
2. compute the exact paths the merge would change;
3. verify each such primary path is clean or already equals the merged result;
4. `commit-tree` a merge commit (parents `ours`, `theirs`), or fast-forward when
   `ours === base`;
5. **CAS** primary HEAD (`update-ref HEAD <new> <expectedOld>`);
6. reconcile only the proven affected clean paths in the primary index/worktree; all
   other dirt untouched;
7. record `promoted_head_oid` and advance the promotion base.

If primary HEAD moves mid-attempt, discard the unreachable tentative merge commit and
recompute (`repository-state-uncertain` semantics, `commit-candidates.ts:479`). Existing
dirty primary paths are never overwritten.

### 5.2 Two plans touching the same files

The first plan to promote establishes the new primary tree. The second compares
`base` = its last promoted activity base, `ours` = current primary (incl. plan A),
`theirs` = its activity head → auto-merge or a real three-way conflict. Persist:

```ts
interface ActivityMergeAttempt {
  id: string; executionRunId: string;
  baseOid: string; primaryHeadOid: string; activityHeadOid: string;
  proposedCommitOid: string | null;
  state: 'pending' | 'conflicted' | 'committed' | 'stale' | 'failed';
  startedAt: number; endedAt: number | null;
}
interface ActivityMergeConflict {
  attemptId: string; pathBytesBase64: string;
  baseBlobOid: string | null; primaryBlobOid: string | null; activityBlobOid: string | null;
  resolutionBlobOid: string | null;
  resolution: 'keep-primary' | 'take-activity' | 'merged' | null;
}
```

Merge-back UX (`src/renderer/components/save/PlanMergeBack.tsx`, NEW):

```
Plan B is saved in its activity worktree but cannot yet be promoted.
main changed since Plan B began.

conflicted/path.ts
  Current main — includes Plan A      [Keep current main]
  This plan    — Plan B               [Take this plan]
  Common base                         [Open merge editor]
```

This is a **content** conflict, not the Q1 attribution picker — a manual merge is
legitimate because two independently valid final trees exist (Q1's "never a manual merge"
governs shared-tree attribution bookkeeping only). Whole-file **"Commit together" is NOT
offered** here (both plan commits already exist and are attributable). Every choice
retains both commits and records a path-level disposition; resolutions live only in the
temp merge index — primary HEAD and both worktrees stay untouched until the full tree
verifies.

### 5.3 Cleanup — only at activity completion, with proofs

Begins only when the plan activity completes/archives and all saved activity commits are
promoted. Required proofs (ALL): activity head reachable from promoted primary head;
worktree clean (no dirty/untracked); no live agent/session cwd lease; no pending merge or
unpromoted commit; ownership marker present. Then: `cleanup-pending` → non-forced
`git worktree remove` → prune the verified admin entry → delete the activity ref →
`cleaned`. Never force-remove for recovery; dirty/missing/mismatched → `recovery-required`.

### 5.4 Startup recovery (`planning-worktree-reconciler.ts`, wired in `engine-bootstrap.ts`)

Mirrors `reconcilePlanBaselineOrphans` (`plan-baseline-refs.ts:224`):

- `provisioning` + valid path/ref → finish activation.
- `provisioning`, baseline-only clean orphan → safe remove.
- `active`, missing path, valid activity ref → recreate detached worktree at the ref.
- dirty orphan / unknown ownership marker → **quarantine**, surface recovery steps
  (never force-delete by decoded run id alone — a missing DB row may be the crash artifact).
- `merge-pending`/`merge-conflicted` → restore the persisted merge UI.
- merge commit with uncertain CAS outcome → inspect primary HEAD/reflog via a
  merge-attempt marker before retry.
- `cleanup-pending` → retry only after repeating every cleanup proof.
- missing ref, existing worktree → recreate the ref from verified worktree HEAD.
- missing both path and ref → `recovery-required`; never claim the work merged.

---

## 6. Candidate & commit contract v2

Bump the candidate contract version; extend `ReviewedSemanticManifest`
(`commit-candidates.ts:218`):

```ts
interface ReviewedSaveIntent {
  intentId: string; kind: 'task' | 'named-save-set'; revision: number;
  title: string; planId: string | null; planItemId: string | null; finalizationId: string;
}
interface ReviewedAttributionResolution {
  resolutionId: string; evidenceDigest: string;
  resolution: 'commit-together' | 'superseded-intentionally';
  affectedPathBytesBase64: string[]; intentIds: string[];
}
interface ReviewedSemanticManifestV2 {
  /* existing repository/member/closure/representation fields */
  saveIntents: ReviewedSaveIntent[];
  attributionResolutions: ReviewedAttributionResolution[];
  attributionTopology: ReviewedAttributionTopology;   // evidence only
}
```

Selection moves from component IDs to intent IDs:

```ts
interface MintCandidateTokenRequestV2 {
  selectedIntentIds: string[];
  selectedNamedSaveSetIds: string[];
  resolutionIds: string[];
  finalizationIds: string[];
}
```

`candidate-service.ts` SHALL: resolve intent units from fresh inventory → union member
paths → expand only the normalized Git operation/finalization closure → require a valid
resolution for every selected suspected-lost-update case → re-read finalizations and
representations → include intent + resolution documents in `candidateId` → mint the
existing single-use token.

`commit-coordinator.ts` retains its isolated index, tree verification, and HEAD CAS.
After success, ONE SQLite transaction writes: commit record; turn links; path links;
`commit_intent_links`; consumed `attribution_resolutions`; intent finalization state;
intent `committed`/`superseded` transitions.

Default commit message (U1):

```
<save unit title>

Plan: <plan title>
Plan item: <plan-item title>
Task: <task intent title>

Assisted-by: <provider>:<model>
```

Internal IDs remain local structured trailers/ledger fields, never in the shareable body
(Q5). Named-save-set title replaces the task line for manual saves.

---

## 7. Module boundary map

| Module | Change |
|---|---|
| `src/main/git-checkpoints/dispatch-context.ts` | Trusted intent/activity stamps; freeze into `TurnContext`; resolve capability from activity binding. |
| `src/main/git-checkpoints/turn-coordinator.ts` | Persist immutable `intentId` at turn allocation. |
| `src/main/git-checkpoints/contention-model.ts` | Keep advisory; add `intentId` to evidence. |
| `src/main/git-checkpoints/concurrency-policy.ts` | **New** — observe/classify/act + evidence digests. |
| `src/main/git-checkpoints/planning-worktree-service.ts` | **New** — provision/verify/activity-ref/lease/cleanup. |
| `src/main/git-checkpoints/planning-worktree-reconciler.ts` | **New** — startup recovery. |
| `src/main/git-checkpoints/activity-merge-service.ts` | **New** — isolated three-way merge, conflict persistence, primary CAS. |
| `src/main/git-checkpoints/commit-coordinator.ts` | Support activity repository contexts; atomic HEAD/activity-ref advance. |
| `src/main/git-checkpoints/checkpoint-service.ts` | Expose exact after-image blob restore input for lost-work resolution. |
| `src/main/commit-candidates/witness-projection.ts` | Project immutable `intentId`. |
| `src/main/commit-candidates/component-assembler.ts` | Topology as evidence; drop component-as-package. |
| `src/main/commit-candidates/intent-assembler.ts` | **New** — canonical intent→dirty-entry join. |
| `src/main/commit-candidates/work-bundle.ts` | Compatibility adapter during migration; stop defining primary grouping. |
| `src/main/commit-candidates/candidate-service.ts` | Select intents; operation closure; resolution atoms; manifest v2; enumerate activity roots. |
| `src/main/commit-candidates/save-card-routes.ts` | Project plan→item→intent hierarchy + active activity roots. |
| `src/main/commit-candidates/save-card-ipc.ts` | `deriveDefaultMessageBody` from intent/plan titles (line 601). |
| `src/main/commit-candidates/finalization-service.ts` | Generalize to `saveUnitId/saveUnitKind`; legacy package adapter. |
| `src/main/commit-candidates/commit-coordinator-ipc.ts` | Accept only main-resolved v2 tokens. |
| `src/main/plans/plan-implement.ts` | Provision worktree before run activation; unborn refusal. |
| `src/main/plans/plan-lifecycle.ts` | Mint task intents transactionally with dispatch attempts; route delivery to activity cwd. |
| `src/shared/commit-candidates.ts` | Intent DTOs, manifest v2, `cross-intent` atom, resolution types; drop `component-subset-not-allowed`, `requiresOverlapAck`, `acknowledgeTopologyDigest`. |
| `src/shared/types.ts` | Replace supervisor-first bundle DTO with `SaveIntentUnitDto`. |
| `src/renderer/components/save/SaveCard.tsx` | Plan/item/intent hierarchy; promotion state; adopt-baseline gesture. |
| `src/renderer/components/save/CandidatePreview.tsx` | Evidence disclosure + three-choice picker; `displayPath` acks. |
| `src/renderer/components/save/PlanMergeBack.tsx` | **New** — merge-back conflict UI. |
| `src/main/database.ts` | Intent, finalization v2, commit-link, worktree, merge-attempt/conflict, resolution schema + accessors; immutable `intent_id` columns + trigger. |

---

## 8. Staged, buildable decomposition

Each stage compiles, ships behind an `intentPackaging` feature flag, and is
independently testable. Legacy component grouping is removed only after parity +
integration coverage.

**WP1 — Intent identity & immutable dispatch join.** `save_intents` schema + accessors;
`intent_id` on dispatch attempts/turns/continuations; trusted intent stamps + carry;
atomic intent+attempt creation on dispatch. Existing Save projection unchanged behind
the flag.
*Acceptance:* retrying one dispatch → one intent; two briefs under one plan item → two
intents; task labels cannot define identity; wire callers cannot inject intent IDs;
confirmed turns carry the intent through restart/continuation.

**WP2 — Intent inventory & Save Card projection.** `intent-assembler.ts`; intent-unit
DTOs + hierarchical renderer; named-save-set creation + stale checks; adopt-baseline
gesture; component projection kept as evidence/legacy only.
*Acceptance:* one intent over disconnected components → one task card; two intents by one
agent → two cards; one plan item → multiple saveable tasks; unwitnessed paths never
acquire provenance; legacy unstamped work labeled honestly.

**WP3 — Concurrency classification & picker.** Per-path blob observation; classifier;
persisted evidence-bound resolutions; `cross-intent` atom replacing generic overlap;
lost-work → supervisor restore.
*Acceptance:* same-intent same-file → no warning; carried-forward/convergent → no block;
divergent cross-intent → exactly one picker case per path/intent pair; changed bytes
invalidate a prior resolution; restore uses the selected verified after-image and
refreshes inventory.

**WP4 — Candidate contract v2 & intent ledger.** Intent finalizations; select by intent;
bind intent/resolution docs into candidate identity/token; `commit_intent_links`;
readable messages. Run v1/v2 readers in parallel until parity fixtures pass, then switch
the renderer.
*Acceptance:* a component spanning unrelated intents no longer fuses them; "Commit
together" → one commit, two links; intentional supersession records losing evidence
without inventing authorship; stale revisions/digests refuse mint/commit; isolated-index
and unrelated-dirt guarantees stay green.

**WP5 — Activity worktree provisioning & routing.** Worktree schema/service/reconciler;
Implement provisioning (unborn refusal); bind agents/dispatch to activity cwd; enumerate
activity roots; atomic HEAD + activity-ref advance.
*Acceptance:* Implement creates exactly one worktree per run; all its tasks share it; a
different run → a different worktree; wrong-cwd dispatch fails before delivery;
provisioning crashes recover without losing baseline/activity head; conversational work
stays on the primary tree.

**WP6 — Merge-back, conflicts, cleanup, recovery.** Isolated merge attempts + primary
cleanliness checks; promotion status + conflict UI; resolutions bound to three-way OIDs;
safe cleanup + startup recovery; close activity only after reachability + cleanliness
proofs.
*Acceptance:* a clean saved task promotes in one gesture; primary dirt outside the merge
untouched; HEAD races → stale retry, never clobber; Plan A then overlapping Plan B →
three-way merge or persisted conflict with primary untouched; restart preserves
conflicted/promotion-pending states; cleanup refuses dirty/unmerged/leased/unowned;
missing worktree rebuilt from its activity ref.

**WP7 — Cutover & compatibility removal.** Migrate remaining `WorkBundle` consumers to
intent units; remove `component-subset-not-allowed` and generic overlap-ack paths;
retain read-only rendering for legacy package finalizations + unstamped turns; telemetry
for predicted/observed/classified/resolved/promoted/recovered; run full commit-candidate,
checkpoint, planning-lifecycle, renderer-Save, and production-IPC suites before removing
the flag.

---

## 9. Required end-to-end scenarios

1. Two agents edit one file for the same task → one silent task card, both contributors,
   one commit.
2. One task edits several unrelated directories → one task card, one commit.
3. One agent handles two briefs under one plan item → two task cards.
4. Two plans touch different files → separate worktrees, both promote cleanly.
5. Two plans touch the same file compatibly → the second auto-merges.
6. Two plans touch the same file incompatibly → the second stays safely committed in its
   activity worktree and enters merge-conflicted UI; primary untouched.
7. Cross-intent shared-tree divergence → Save blocks only on the attribution picker.
8. Lost-work restore → checkpoint after-image restored via supervisor authority without
   committing stale candidate bytes.
9. Human edits with no witnessed task → remain Unwitnessed until placed in a named
   save-set (or adopted-as-baseline in one gesture).
10. Crash during creation, commit, merge CAS, and cleanup → every state completes
    idempotently or surfaces as `recovery-required`; no work deleted.

---

*This artifact serves the single marked intent `int_7d41c9a2` and leaves hardening into
work packages, integration, and packaging to the responsible supervisor.*


<!-- groupthink_run: 5432c132 (mode=parallel) -->
