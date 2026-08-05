# Shared Bundle / Stamping Contract (wire version 1 · doc revision 3)

> **Version note (2026-08-01 holistic-review reconciliation):** the normative wire/schema
> version is **`BUNDLE_CONTRACT_VERSION = 1`** (§12–§13) — the constant and both
> implementing plans agree. The former "(v3)" in this title was the *document revision*,
> not the wire version; any doc citing "contract v3" means this file at doc revision 3,
> wire version 1. Do not bump the constant without an explicit breaking-change decision.

**Status:** normative contract spec — GroupThink deliberation, Lead Planner ×
Reviewer, six review rounds, Reviewer-approved 2026-07-30. No code changed by this
document; it pins the shared data model both approved Lares proposals depend on so
two divergent bundle/candidate assemblers cannot get built.

**Pins the contract that `prop_4c8d21b7` (Save card) and `prop_8e2f5a93` (planning
surface) both consume:** "work package = save bundle = candidate commit" is ONE
data model with two lenses (fleet Save card / per-plan surface).

**Authority.** Normative over `prop_4c8d21b7` + `prop_8e2f5a93` for anything the
candidate/finalization/stamping/commit surface touches. Subordinate to each
proposal's Edward-ruling Amendments where they conflict.

**Sources evaluated + grounded against real code:**
- `.lares/proposals/2026-07-30-save-card-commit-ui.md` (Amendments authoritative)
- `.lares/proposals/2026-07-30-planning-surface-revamp.md` (Amendments authoritative)
- `.lares/proposals/supporting/2026-07-30-two-proposal-cross-evaluation-groupthink.md`
  (§4.1 stamping, §5 candidate service)
- `.lares/proposals/supporting/save-card-git-native-input-2026-07-30.md`
- `src/main/git-checkpoints/{dispatch-context,turn-coordinator,retention}.ts`,
  `src/main/database.ts`

**Contract version:** `BUNDLE_CONTRACT_VERSION = 1`.
**Type home:** `src/shared/commit-candidates.ts`. **Assembler home:**
`src/main/commit-candidates/`. The authoritative service does NOT live under
`save-card/` (the two lenses are equal; save-card ownership would bias it).

---

## 0. Model: three canonical levels, one renderer DTO, two lenses

The assembler produces three **canonical, normative** structures. `WorkBundle` is a
**non-normative renderer DTO** assembled *from* them; UI reads it, no logic keys off
it.

- **`DirtyInventory`** — repository-scoped worktree dirt + attribution gaps.
- **`ConflictComponent`** — globally-connected witnessed groups over the inventory.
- **`CommitCandidate`** — an immutable, finalization-backed, explicitly-selected
  **union of whole components + independent unattributed entries**. A selection
  WITHOUT finalization is a `SelectionPreview`, not a candidate.

The Save (fleet) and Plan lenses **filter/annotate** these; neither computes
topology, splits a component, nor "produces" candidates. Both surfaces call one
read module: `CommitCandidateService`. The sole real-index writer,
`CommitCoordinator`, is out of scope except for the token/verify obligations in §9.

---

## 1. Repository identity (topology + latch key)

```ts
export interface RepositoryIdentity {
  repositoryKey: string;      // sha256(canonical absolute realpath of THIS worktree's index file)
  objectDatabaseKey: string;  // capability.commonDirQueueKey — shared object-db serialization key
  gitObjectFormat: 'sha1' | 'sha256'; // for validating Git OIDs ONLY; candidate IDs are always sha256
  bareRepo: false;            // bare repos are rejected upstream; never assembled
  workspaces: Array<{ workspaceId: string; workspacePrefix: string }>; // deterministically sorted by workspaceId
}
```

**`repositoryKey` derivation** (main-process only; raw absolute paths NEVER leave
main into renderer DTOs):
1. `git rev-parse --absolute-git-dir` and `git rev-parse --git-path index`.
2. realpath-canonicalize both where the target exists.
3. Normalize Windows drive-letter case + separators consistently with the existing
   capability probe.
4. Reject bare repositories.
5. `repositoryKey = sha256(canonical absolute index path)` — the index is the mutable
   resource the latch protects.

Overlap graph + compose latch key on `repositoryKey` (per-worktree; linked worktrees
differ). Object/ref git ops serialize **independently** on `objectDatabaseKey` via the
existing `CheckpointQueue` (retention.ts:84). Multiple Lares workspaces on one worktree
share `repositoryKey` ⇒ one graph, one latch. Linked worktrees share `objectDatabaseKey`
but not `repositoryKey`: the contract intentionally does NOT over-serialize compose
across linked worktrees, while object writes still serialize on the shared common-dir.

---

## 2. `DirtyInventory` + `DirtyEntry`

```ts
export interface EncodedGitPath {
  pathBytesBase64: string;  // exact Git path bytes from -z output; AUTHORITATIVE for pathspec transport
  displayPath: string;      // best-effort UTF-8 for UI; control chars escaped for DISPLAY only
  utf8Clean: boolean;       // false ⇒ display is lossy; pathspec still uses bytes
}

export interface DirtyInventory {
  repository: RepositoryIdentity;
  entries: DirtyEntry[];
  unattributedEntryIds: string[]; // entries with no witnessing turn; ALWAYS present (may be empty), never auto-grouped
  topologyDigest: string;         // §3.2, over the whole inventory
}

export interface DirtyEntry {
  entryId: string;                // stable within one build: sha256(repositoryKey + pathBytesBase64)
  path: EncodedGitPath;
  originalPath: EncodedGitPath | null; // rename/copy source
  entryKind: 'ordinary' | 'rename-or-copy' | 'unmerged' | 'untracked';
  indexStatus: string;            // single porcelain-v2 status char (X)
  worktreeStatus: string;         // single porcelain-v2 status char (Y)
  headMode: string | null;
  indexMode: string | null;
  worktreeMode: string | null;    // '100644' | '100755' | '120000' | '160000' | null
  submoduleState: string | null;  // porcelain-v2 sub field ('N...' or 'S<c><m><u>')
  renameOrCopyScore: string | null;
  expectedWorktreeState: 'present' | 'absent'; // absent == deletion, distinct from unavailable hash
  rawWorktreeBlobOid: string | null;   // hash-object --no-filters (CHECKPOINT raw semantics); null iff absent/unhashable
  gitLevelEligibility: 'supported' | 'unsupported-git-state'; // GIT-LEVEL ONLY — no package/byte verdicts here
  commitPathspecs: EncodedGitPath[];   // every old/new path a rename/delete/copy commit needs
}
```

**Rules.** Source: `git --no-optional-locks status --porcelain=v2 -z
--untracked-files=all`, vs HEAD, at build time, scoped by the engine's own
`enumerateScope` rules (card ≡ engine; ignored files never appear). Bundle membership
= witnessed paths ∩ dirty paths; a dirty path witnessed by NO turn → the unattributed
set. `unmerged`, `160000` gitlink/submodule, and non-UTF-8 paths ⇒
`unsupported-git-state` (visible, never eligible) — we do NOT promise support while
decoding `-z` lossily; pathspec transport always uses `pathBytesBase64`. Rename/copy
preserves both paths and emits both in `commitPathspecs`. Deletion (`absent`) is not an
unavailable hash. Control-char display escaping and pathspec transport are separate
concerns. `expectedCommitBlobOid` is NOT on the inventory — it needs a temp index and
lives on `CandidateMember` (§4).

---

## 3. `ConflictComponent`

```ts
export interface ConflictComponent {
  componentId: string;               // sha256(repositoryKey + sorted dirtyEntryIds)
  dirtyEntryIds: string[];
  associations: BundleAssociation[]; // many-to-many
  overlap: BundleOverlap;
  componentTopologyDigest: string;   // §3.2, scoped to THIS component
}

export interface BundleAssociation {
  planId: string | null; planItemId: string | null;
  contributingTurnIds: string[]; memberEntryIds: string[];
}

export interface BundleOverlap {
  componentId: string;
  contributingAgentCount: number;
  mergedGroupCount: number;          // ownership/plan groups FUSED into this component (NOT "intersecting components")
  perPathContributors: Record<string /*entryId*/, { turnIds: string[]; agentIds: string[]; planIds: (string|null)[] }>;
  requiresOverlapAck: boolean;       // ≥2 owners/plans fused
}
```

Globally computed once across all `workspaces`. Connected components over
`entry —witnessed-by— turn —same-agent / shared-path— entry`; transitive fusion merges
(A–B, B–C ⇒ one). After components are final, two components cannot intersect (hence
`mergedGroupCount` + per-path contributor sets, not a count of intersecting
components). The plan lens **filters/annotates** components; it NEVER carves a
sub-candidate out of a component that connects to other plans. Scalar
`planId`/`planItemId` and a single `Lares-Plan` trailer exist only in a
`PlanLensSelection` presentation wrapper when exactly one association is selected; a
mixed-plan candidate emits multiple `Lares-Turns`/`Lares-Plan` trailers or none —
never one silently-chosen plan.

Contributing turns per association = `turn_records.id` whose witnessed `touched[]`
(write/create only) intersect that association's member paths within the repository
(all `workspaces`, §5), read with their immutable `plan_id`/`plan_item_id`/
`plan_stamp_source` stamps (§6).

### 3.2 Deterministic topology digest (binds the actual per-entry graph)

```
componentTopologyDigest = sha256( JCS({
  repositoryKey,
  entries: sorted [{
    pathBytesBase64,
    contributors: sorted [{ turnId, agentId, planId, planItemId }]
  }]
}) )
```

Every nested array canonically sorted. The acknowledgement binds to the actual
per-entry overlap graph, so two different contributor mappings with the same aggregate
participants produce DIFFERENT digests. A newly witnessed path connecting into the
component changes its digest; unrelated changes in another component do not invalidate
this candidate. The inventory-level `topologyDigest` uses the identical construction
over all entries; the union digest a candidate acknowledges is this construction over
the union of its selected components' entries.

---

## 4. `CommitCandidate`

A candidate is a **union of atomic units**: whole witnessed components (never a proper
subset in v1) + independently-chosen unattributed entries.

```ts
export interface CommitCandidate {
  candidateId: string;                     // §4.2 — always sha256, identical across both lenses
  contractVersion: number;
  repository: RepositoryIdentity;
  componentIds: string[];                  // each FULLY included — never a proper subset
  selectedUnattributedEntryIds: string[];  // independent atomic units
  members: CandidateMember[];              // = union of the components' entries + selected unattributed
  finalizations: FinalizationRef[];        // §5 — the coverage set (non-empty for a real candidate)
  eligibility: CommitEligibility;
  token: CommitCandidateToken | null;      // present only once minted (§9)
}

export interface SelectionPreview {        // a selection WITHOUT finalization — previewable, never committable
  componentIds: string[]; selectedUnattributedEntryIds: string[]; members: CandidateMember[];
  eligibility: CommitEligibility;          // always {eligible:false, reason:'package-not-finalized'} until finalized
}

export interface CandidateMember {
  entryId: string; path: EncodedGitPath; expectedWorktreeState: 'present' | 'absent';
  rawWorktreeBlobOid: string | null;       // raw semantics — for "unchanged since finalize"
  expectedCommitBlobOid: string | null;    // CLEAN-FILTERED, via temp GIT_INDEX_FILE; may differ from raw; null for deletion
  expectedCommitMode: string | null;       // clean-filtered commit entry mode
  checkpointMode: string | null;           // retained separately when raw ≠ commit semantics
  coveringFinalizationIds: string[];       // NON-EMPTY, sorted, deduped — every active finalization covering this path
  packageVerification: PackageVerificationState; // §4.1
  protection: ProtectionRung;              // §8
}

export interface FinalizationRef { finalizationId: string; packageId: string; packageRevision: number; boundaryStatus: string; }
```

**Server coverage rules.** Every member must have ≥1 covering active finalization; all
covering manifests for a member must agree on `{expectedState, checkpointBlobOid,
checkpointMode, expectedCommitBlobOid, expectedCommitMode}` (else `finalization-conflict`,
ineligible); every requested finalization that covers a selected member is included; a
requested finalization covering NO selected member is rejected (`extraneous-finalization`);
`coveringFinalizationIds` is sorted + deduped. No arbitrary "primary" finalization is
chosen — both plan-package histories are preserved.

**Component atomicity.** For every selected component, ALL its `dirtyEntryIds` enter the
candidate (no proper subset — reject `component-subset-not-allowed`); unattributed
entries are selected independently and never auto-grouped; combining multiple complete
components is legal only because the request explicitly named them. Later shared-file
extraction is a SEPARATE workflow that recomputes topology and revalidates the new unit —
never smuggled through arbitrary selection.

### 4.1 Verification state vs eligibility (Save-card Amendment 1)

```ts
export type PackageVerificationState =
  | 'verified-match' | 'verified-mismatch'
  | 'package-not-finalized' | 'final-checkpoint-unavailable' | 'unsupported-entry';

export type CommitEligibility =
  | { eligible: true }
  | { eligible: false; reason:
      'byte-mismatch' | 'package-not-finalized' | 'checkpoint-unavailable'
      | 'finalization-conflict' | 'component-subset-not-allowed' | 'extraneous-finalization'
      | 'unattributed-not-acknowledged' | 'overlap-not-acknowledged'
      | 'compose-in-flight' | 'unsupported-git-state' };
```

A member is `verified-match` **iff BOTH hold:** current raw bytes/state match
`{checkpointBlobOid, checkpointMode, expectedState}` AND the current temp-index commit
blob/mode match the frozen `{expectedCommitBlobOid, expectedCommitMode}` (§5). A
post-finalization `.gitattributes`/clean-filter change that leaves raw bytes intact but
alters the commit entry ⇒ `verified-mismatch` ⇒ ineligible.

A candidate is one-click committable **iff** every member is `verified-match` against
its covering finalizations, coverage is complete, no manifest conflict, overlap/
unattributed acks satisfied, no compose-in-flight, and no unsupported entry.
Capture-degraded / unfinalized / snapshot-missing work stays visible + previewable,
never one-click.

### 4.2 Candidate identity (JCS / RFC 8785, always sha256)

`candidateId = sha256( JCS( identityDoc ) )` using a named, tested RFC 8785 encoder —
not informal key-sorting:

```
identityDoc = {
  contractVersion, repositoryKey, gitObjectFormat, pinnedHeadOid,
  indexFingerprint,                        // §9.3
  finalizations: sorted [{ finalizationId, packageId, packageRevision }],
  members: sorted [{ pathBytesBase64, rawWorktreeBlobOid, expectedCommitBlobOid,
                     expectedCommitMode, expectedWorktreeState, coveringFinalizationIds }],
  componentTopologyDigest                  // §3.2 union over selected components — deterministic, not a counter
}
```

**Excluded from identity:** UI lens, message text, trailers, renderer labels, capture
digests. Two lenses over the same candidate ⇒ identical `candidateId`. `gitObjectFormat`
is an identity input (for validating Git OIDs); candidate IDs themselves are always
sha256 and are never weakened to sha1.

---

## 5. Finalization boundary — `package_finalizations`

The explicit human/supervisor `done` transition (plan-package) or a DISTINCT fleet
mark-done/mint step (fleet-adhoc) freezes a package boundary. No boundary is ever
auto-derived from `accepted` (a completed turn is not a completed work package, and each
`after_oid` is a whole-tree snapshot that may carry unrelated concurrent bytes).
Fleet-adhoc finalize is its own explicit step immediately before mint — never performed
silently inside the commit mutation.

```sql
CREATE TABLE IF NOT EXISTS package_finalizations (
  id TEXT PRIMARY KEY,                       -- this finalization event
  package_id TEXT NOT NULL,                  -- stable logical package across re-finalizations
  repository_key TEXT NOT NULL,
  finalization_kind TEXT NOT NULL,           -- 'plan-package' | 'fleet-adhoc'
  plan_id TEXT,                              -- NULL for fleet-adhoc
  plan_item_id TEXT,                         -- required for plan-package; NULL for fleet-adhoc (§11 prerequisite)
  package_revision INTEGER NOT NULL,
  finalized_at INTEGER NOT NULL,
  finalized_by TEXT NOT NULL,                -- 'human-ipc' | supervisor agentId
  checkpoint_turn_id TEXT,                   -- boundary source when a turn edge is reused
  checkpoint_oid TEXT,                       -- boundary tree/commit oid
  boundary_ref TEXT,                         -- durable refs/lares/... ref pinning the boundary objects
  boundary_status TEXT NOT NULL,             -- 'ready' | 'unavailable' | 'pruned'
  lifecycle_status TEXT NOT NULL,            -- 'active' | 'superseded' | 'committed' | 'abandoned'
  superseded_by_finalization_id TEXT,
  released_at INTEGER,
  member_manifest_json TEXT NOT NULL,        -- frozen per-path manifest (below)
  contract_version INTEGER NOT NULL,
  failure_reason TEXT,
  created_from_workspace_id TEXT,            -- ATTRIBUTION ONLY; a repo package spans workspaces
  CHECK (finalization_kind IN ('plan-package','fleet-adhoc')),
  CHECK (boundary_status IN ('ready','unavailable','pruned')),
  CHECK (lifecycle_status IN ('active','superseded','committed','abandoned')),
  CHECK (package_revision > 0),
  CHECK (
    (finalization_kind='plan-package' AND plan_id IS NOT NULL AND plan_item_id IS NOT NULL)
    OR
    (finalization_kind='fleet-adhoc'  AND plan_id IS NULL AND plan_item_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_package_finalizations_revision
  ON package_finalizations(package_id, package_revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_package_finalizations_plan_revision
  ON package_finalizations(plan_item_id, package_revision) WHERE finalization_kind = 'plan-package';
CREATE INDEX IF NOT EXISTS idx_package_finalizations_repo
  ON package_finalizations(repository_key, package_id);
```

`member_manifest_json` per path freezes BOTH representations, computed at finalization
time (raw via `hash-object --no-filters`; clean-filtered via a temporary
`GIT_INDEX_FILE`):

```ts
{
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  checkpointBlobOid: string | null;      // raw --no-filters, at finalize
  checkpointMode: string | null;
  expectedCommitBlobOid: string | null;  // clean-filtered via temp index, at finalize
  expectedCommitMode: string | null;
}
```

`checkpoint_oid` alone does NOT keep objects reachable — `boundary_ref` is a durable
Lares ref; retention treats it as protected while `lifecycle_status='active'`. A path
`absent` in the manifest is a verified deletion. If no usable final checkpoint exists at
finalize, finalization either captures a boundary ref explicitly (fleet-adhoc always
does) or records `boundary_status` non-`ready` ⇒ non-committable. Later edits ⇒ new
`package_revision` under the same `package_id`.

### 5.1 Finalization closure (before `committed` / ref release)

A candidate may cover only some of a finalization's manifest paths (another path was
committed earlier or is no longer dirty). Consuming such a candidate must NOT mark the
whole finalization `committed`. Closure is evaluated by the coordinator/reconciler over
the ENTIRE manifest; every manifest member must resolve to one disposition:

```ts
export type FinalizationMemberDisposition =
  | { state: 'selected-in-candidate'; entryId: string }
  | { state: 'already-locally-committed'; commitOid: string }; // exact-content ledger proof (§8)
```

No member may be omitted, reverted, mismatched, or merely clean without exact
commit-ledger proof. A finalization transitions to `lifecycle_status='committed'` and
releases `boundary_ref` (stamps `released_at`) ONLY when every manifest member is
exact-content locally committed after the coordinator/reconciler runs — each member is
`already-locally-committed` (proven via `commit_path_links` matching `{path,
expected_state, commit_blob_oid == expectedCommitBlobOid, commit_mode ==
expectedCommitMode}`) or was `selected-in-candidate` in the commit that just landed and
is now itself exact-content committed. `superseded`/`abandoned` release only under their
explicit lifecycle transitions (`superseded_by_finalization_id` set on supersede). A
partial-candidate commit leaves the finalization `active` with its ref retained. Raw
match alone is never sufficient for closure.

---

## 6. Stamping — frozen at turn-open

### 6.1 Untrusted request vs trusted resolved stamp

```ts
export type RequestedPlanBinding =            // client-supplied, UNTRUSTED
  | { mode: 'agent-default' }
  | { mode: 'explicit'; planId: string; planItemId: string | null }
  | { mode: 'none' };

export interface ResolvedPlanStamp {          // constructed ONLY by trusted boundary/lifecycle code
  planId: string | null;
  planItemId: string | null;
  source: 'explicit' | 'agent-default' | 'fork-carry' | 'revive-carry'
        | 'continuation-carry' | 'explicit-none' | 'unbound-manual';
}
```

Clients send `RequestedPlanBinding`; they NEVER supply `source`. **Validation +
resolution happen at the API/IPC/orchestration boundary, before enqueueing delivery** —
not inside `_deliverAndConfirm`, which is fail-open (turn-coordinator.ts: capture never
blocks delivery) and would swallow a thrown validation error and deliver an unstamped
turn. Resolution of a `RequestedPlanBinding`:
- `explicit`: validate `planId ∈ target workspace` (non-empty, length-bounded UTF-8);
  `planItemId` is **rejected as unsupported until `plan_work_packages` exists** (§11),
  then validated against `(workspace_id, plan_id, id)`. Invalid ⇒ reject at boundary
  (400/IPC error): no PTY bytes, no turn row. → `source='explicit'`.
- `agent-default`: `planId ← target agent's frozen agents.plan_id` (database.ts:966/1771);
  item null. → `source='agent-default'`.
- `none`: both NULL. → `source='explicit-none'`.

The **fork/revive/continuation rails** own their lifecycle event and therefore the
trust; they construct `fork-carry`/`revive-carry`/`continuation-carry` directly — these
do NOT come from a `DispatchOrigin` and cannot be forged through the wire binding.
`DispatchContext` delivered to the coordinator carries the `ResolvedPlanStamp`, not the
raw request. This mirrors how `ownerBrickGeneration` is made un-injectable
(dispatch-context.ts): a caller cannot inject a stamp source through the typed API.

### 6.2 Carry / no-carry table (every dispatch path)

The code has exactly three `DispatchOrigin` values (`orchestration | human-terminal |
api`, dispatch-context.ts:21). The conceptual paths map onto them; carry is pinned per
path:

| Conceptual path | Live route | Binding source (frozen when) | `plan_stamp_source` |
|---|---|---|---|
| **Direct human send** | `human-terminal` (most `sendInput` sites default here); owner-less | `agent-default`; UI/API may pass `explicit`/`none` | agent-default / explicit / explicit-none |
| **Orchestration send** (incl. follow-ups) | `orchestration` | **run-frozen** binding reused every message — NO live lookup per message | explicit / agent-default |
| **API send** | `api` | caller `explicit`/`none`; else `agent-default` | matching |
| **Fork** | new agent, inherits cwd/owner/session | **default-carry source agent's frozen binding at fork creation**; item via explicit fork request or `none`; never read latest turn after | fork-carry / explicit / explicit-none |
| **Revive** | same agent, new session | plan default carries; item only if the revive request freezes it into the pending wake dispatch | revive-carry / explicit |
| **Continuation** | same agent id, fresh session | **freeze active binding onto the continuation attempt before teardown**; carry that exact binding into the pending continuation message; never rediscover from turn rows after relaunch | continuation-carry |
| **Manual-terminal late-bound** | see §6.5 | only when a real turn row exists whose binding source is frozen | unbound-manual |

**Universal rules.** Explicit validated dispatch value always wins over the default. An
invalid *explicit* id is a hard reject (never a silent fallback). The default
(`agents.plan_id`) applies only when the dispatch names no plan. `plan_item_id` is never
defaulted. Human-terminal remains owner-less (`owner_agent_id` NULL); stamping is
orthogonal to ownership.

### 6.3 Persistence (so bindings survive restart)

- **`turn_records`** — guarded try/catch `ALTER … ADD COLUMN` idiom (as used for
  `agents.plan_id`, database.ts:966): `plan_id TEXT`, `plan_item_id TEXT`,
  `plan_stamp_source TEXT NOT NULL DEFAULT 'legacy-unstamped'`. Legacy/migrated rows get
  `legacy-unstamped` (migration-only; never claims a runtime origin). New allocations
  MUST provide a runtime source explicitly; the accessor validates against the enum
  `{explicit, agent-default, fork-carry, revive-carry, continuation-carry, explicit-none,
  unbound-manual}` (a column `CHECK` where SQLite ADD COLUMN allows it, plus accessor
  validation). `AllocateTurnFields.planStampSource` EXCLUDES `legacy-unstamped`.
  Workspace-leading indexes:
  `idx_turn_records_ws_plan_seq(workspace_id, plan_id, turn_seq)`,
  `idx_turn_records_ws_plan_item_seq(workspace_id, plan_item_id, turn_seq)`.
  `TurnRecord` / `AllocateTurnFields` / the row↔object mapper / the
  `allocateAndInsertTurn` INSERT gain the three fields. Keep the "plain attribute, NO FK
  cascade" rule — deleting an agent never purges or nulls these.
  **Immutability is repository-accessor-enforced** (the three columns are deliberately
  absent from `TURN_UPDATABLE_COLUMNS`, database.ts:4455) AND DB-guarded so raw SQL
  cannot mutate them:

  ```sql
  CREATE TRIGGER IF NOT EXISTS turn_records_plan_stamp_immutable
  BEFORE UPDATE OF plan_id, plan_item_id, plan_stamp_source ON turn_records
  WHEN NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_item_id IS NOT OLD.plan_item_id
    OR NEW.plan_stamp_source IS NOT OLD.plan_stamp_source
  BEGIN SELECT RAISE(ABORT, 'turn plan stamp is immutable'); END;
  ```

- **`continuation_handoff_attempts`** (database.ts:205) — add nullable `plan_id`,
  `plan_item_id`, non-null `plan_stamp_source TEXT NOT NULL DEFAULT 'legacy-unstamped'`,
  populated BEFORE teardown. New accessor `getContinuationAttemptBinding(attemptId)`; the
  relaunch/reconciliation rail reads THESE columns — never latest `turn_records`, never
  live `agents.plan_id`.

- **`orchestrations`** (database.ts:375; already has `plan_id` at :404) — add
  `plan_item_id TEXT` and `plan_binding_mode TEXT` so follow-up messages reuse the
  run-frozen package binding; accessor `getOrchestrationBinding(orchestrationId)`.

### 6.4 Non-dispatch turns

Overlap re-open (turn-coordinator.ts:210) closes the prior turn and opens the new row
with the **new send's `ctx`** ⇒ it stamps the new send's binding, not the interrupted
turn's. Startup reconciliation (turn-coordinator.ts:384) only closes dangling rows as
`crashed`; it never stamps. No inference anywhere.

### 6.5 Raw terminal typing — honest v1 position

Renderer/API human sends are ordinary pre-dispatch turns (they route through the send
path and open a turn). **Raw user typing directly into an attached terminal has no
turn-opening rail in v1** (the `quality:'late'` path has no live producer in the current
source). Contract position: **raw terminal typing is unattributed inventory in v1 and
receives no fabricated turn or stamp.** Its bytes appear in `DirtyInventory` as
unattributed entries. `unbound-manual` is reserved for a FUTURE `ManualTurnContextRegistry`
that opens a real late-bound turn row whose binding source could not be frozen; until
that rail exists, no `unbound-manual` rows are produced. The trail must annotate
"unstamped/unverified turns exist for this agent" rather than silently look complete —
made queryable via `plan_stamp_source`, not inferred from nulls.

---

## 7. Capture health (reason-classified)

```ts
export interface TurnCaptureState {
  turnId: string;
  beforeEdge: 'verified-live' | 'ready-hint-only' | 'pruned' | 'absent'; // live rev-parse is authority
  afterEdge:  'verified-live' | 'ready-hint-only' | 'pruned' | 'absent';
  beforeQuality: 'guaranteed' | 'late' | 'degraded' | null;
  afterQuality: 'hook' | 'session-log' | 'terminal' | 'idle-fallback' | 'none' | null;
  failureClass: 'none' | 'overlap' | 'delivery-failed' | 'capture-outage' | 'skipped' | 'other';
}

export interface BundleCaptureHealth {
  turns: TurnCaptureState[];
  captureOutage: boolean;                 // TRUE only for failureClass==='capture-outage' (NOT overlap/delivery)
  pathsWithoutFinalizationEdge: string[]; // members whose EXACT bytes are not backed by a live finalization-manifest edge
}
```

`after_ready=1` is a hint; edge state is decided by live `rev-parse --verify
<ref>^{commit} == oid` (retention.ts:585 `edgeUsable`). `pathsWithoutFinalizationEdge`
asks whether the finalization manifest backs the exact path bytes — not whether every
witnessing turn has an after-edge. Degraded/unverified/outage turns are still visible
and previewable but not one-click committable (§4.1).

---

## 8. Protection — content-specific + ledger DDL

```ts
export type ProtectionRung = 'unprotected' | 'checkpoint-protected' | 'locally-committed' | 'remote-reachable';
export const PROTECTION_RUNG_ORDER: Record<ProtectionRung, number> =
  { 'unprotected': 0, 'checkpoint-protected': 1, 'locally-committed': 2, 'remote-reachable': 3 };
```

Evaluated per member for the exact `{path, expectedState, blobOid, mode}`:
`checkpoint-protected` = a LIVE verified recovery/checkpoint edge holds these exact
bytes/state; `locally-committed` = a `commit_path_links` row holds the exact frozen
commit entry (`commit_blob_oid == expectedCommitBlobOid`, `commit_mode ==
expectedCommitMode`, matching `expected_state` — including deletion); `remote-reachable`
= that commit is CURRENTLY reachable from a configured remote-tracking ref (read-time;
`pushed_remote_count` is a cached hint only). Bundle `weakest` = min by
`PROTECTION_RUNG_ORDER` across members. Raw blob match alone is never sufficient for
`locally-committed`.

```sql
CREATE TABLE IF NOT EXISTS commit_records (
  repository_key TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  parent_oid TEXT,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,                 -- 'lares' | 'external'
  pushed_remote_count INTEGER NOT NULL DEFAULT 0,   -- cached hint; not read-time authority
  last_reconciled_at INTEGER,
  PRIMARY KEY (repository_key, commit_oid),
  CHECK (source IN ('lares','external')),
  CHECK (pushed_remote_count >= 0)
);
CREATE TABLE IF NOT EXISTS commit_turn_links (
  repository_key TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  plan_id TEXT, plan_item_id TEXT,
  relation TEXT NOT NULL,              -- 'candidate_member' | 'exact_path_match' | 'metadata_only'
  capture_quality TEXT,
  PRIMARY KEY (repository_key, commit_oid, turn_id),
  CHECK (relation IN ('candidate_member','exact_path_match','metadata_only'))
);
CREATE TABLE IF NOT EXISTS commit_path_links (
  repository_key TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  path_bytes_base64 TEXT NOT NULL,
  expected_state TEXT NOT NULL,        -- 'present' | 'absent'
  raw_blob_oid_at_commit TEXT,         -- checkpoint raw semantics
  commit_blob_oid TEXT,                -- clean-filtered entry actually in the commit tree
  commit_mode TEXT,
  contributing_turn_ids TEXT,          -- JSON array
  overlap_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repository_key, commit_oid, path_bytes_base64),
  CHECK (expected_state IN ('present','absent')),
  CHECK (overlap_count >= 0)
);
```

`commit-reconciler.ts`: record EXACT links for commits Lares itself creates (from the
consumed snapshot + the identified attempt commit, §9.4). Detect external HEAD movement;
label inferred links conservatively — never claim an external commit contains a turn
merely because path sets overlap (`relation='metadata_only'`). Compute
`pushed_remote_count` against configured remote refs. Replaces the proposals' "commit to
make permanent" copy with honest wording.

---

## 9. The token — opaque, server-held; mint + consume lifecycle

### 9.1 Mint request (acks are validated requests, never authoritative state)

```ts
export interface MintCandidateTokenRequest {
  selectedComponentIds: string[];          // each expands server-side to ALL its dirtyEntryIds
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];               // §4 coverage set
  acknowledgeTopologyDigest: string | null;// must equal the freshly-assembled UNION topology digest (§3.2)
  acknowledgeUnattributedEntryIds: string[];// must cover every selected unattributed entry
}

export interface CommitCandidateToken {
  tokenId: string;        // 256-bit random, base64url
  candidateId: string;    // §4.2
  contractVersion: number;
  issuedAt: number; expiresAt: number;
}
```

`CommitCandidateService` validates the request against the freshly assembled
components + finalizations (component atomicity, coverage, manifest agreement, ack
match), normalizes acks, and stores the IMMUTABLE snapshot (members, manifests,
associations, normalized acks, capture digest, pinned HEAD, index fingerprint,
finalization refs) in a main-process map under `tokenId`. The renderer holds only the
token + separately-validated user input (message). No renderer-provided members/
trailers/acks/digests are ever trusted.

### 9.2 Consumption lifecycle (atomic)

State machine `issued → consuming → consumed`. The `issued → consuming` transition is
**compare-and-set before any async git work**, so two clicks cannot consume one token.
The coordinator then:
1. Resolve the server-held snapshot by `tokenId`; reject unknown/expired/version-mismatch.
2. Reassemble live state.
3. Require identical `candidateId`, member manifest, AND `componentTopologyDigest`.
4. Revalidate BOTH raw and clean-filtered byte-match (§4.1) immediately before commit.
5. Commit path-scoped: `git commit --only --pathspec-from-file=<nul-file>
   --pathspec-file-nul`, pathspecs written as RAW bytes from `commitPathspecs`; hooks
   un-bypassed (never `--no-verify`).
6. Classify the outcome from observed repository state (§9.4) and post-commit verify.
7. Token is single-use: invalidated on success, stale rejection, or first consume attempt.

**Policy (explicit).** TTL = `expiresAt` (default 5 min). Per-`repositoryKey` capacity =
`COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY = 128` (LRU-evict oldest `issued`, never an
in-`consuming` token). A pre-mutation transient failure (before the `issued → consuming`
CAS succeeds and before any git write) does NOT consume the token; once `consuming`, the
token is consumed regardless of outcome. App restart invalidates all tokens (the map is
in-memory). UX must state single-use up front.

### 9.3 Index fingerprint

`indexFingerprint = sha256( JCS( parsed `git ls-files --stage -z` entries ) )`. **Reject
unmerged stages** (candidate ineligible). Keep the `write-tree` tree OID additionally as
a secondary check where producible; `write-tree` alone is not the fingerprint (fails on
unmerged, loses entry shape). This detects pre-existing staged content (`indexStatus`)
and preserves it exactly through the commit.

### 9.4 Attempt-attributed commit identification + outcome

HEAD movement is necessary but not sufficient — the compose latch coordinates Lares, not
external git writers, so an external client can advance HEAD mid-attempt. Each attempt is
server-identified via the reflog:

1. Generate a server `attemptId`; **persist a pending attempt row before any mutation**:

```sql
CREATE TABLE IF NOT EXISTS commit_attempts (
  attempt_id TEXT PRIMARY KEY,
  repository_key TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  pinned_head_oid TEXT NOT NULL,
  reflog_action TEXT NOT NULL,           -- 'lares-commit:<attemptId>'
  started_at INTEGER NOT NULL,
  resolved_head_oid TEXT,
  identified_commit_oid TEXT,
  outcome_status TEXT,                   -- mirrors CommitOutcome.status
  ended_at INTEGER
);
```

2. Run git with `GIT_REFLOG_ACTION=lares-commit:<attemptId>` for the `git commit --only …`
   invocation.
3. Afterward, **identify the attempt's commit from the HEAD reflog marker** (the reflog
   entry whose message carries `lares-commit:<attemptId>`), take its new-OID, and verify
   `parent == pinnedHeadOid` AND candidate tree entries (each `expectedCommitBlobOid` /
   `expectedCommitMode`).

**Classification:**
- Marked commit found + parent/tree verified → `committed` (or
  `committed-integrity-mismatch` if tree entries diverge); ledger that identified OID.
- HEAD unchanged (`resolvedHeadOid === pinnedHeadOid`) AND no marked commit → `aborted-*`.
- HEAD changed but NO uniquely identifiable attempt commit → `repository-state-uncertain`
  (foreign interleave); ledger nothing as the candidate; preserve all evidence.
- Marked commit exists but HEAD subsequently moved again → report the marked commit as
  created (ledgered) WITH `currentHeadDrift`.
- **A marked commit with an unexpected parent or unverifiable tree → `repository-state-uncertain`.**
  Preserve its OID in `commit_attempts.identified_commit_oid`, but do NOT create exact
  candidate links unless parent AND tree verification pass.

```ts
export type CommitOutcome =
  | { status: 'committed'; commitOid: string; attemptId: string;
      indexIntegrity: 'verified' | 'mismatch' | 'unavailable'; indexMismatchedPaths?: EncodedGitPath[];
      currentHeadDrift?: { resolvedHeadOid: string } }
  | { status: 'committed-integrity-mismatch'; commitOid: string; attemptId: string; mismatchedPaths: EncodedGitPath[];
      indexIntegrity: 'verified' | 'mismatch' | 'unavailable'; indexMismatchedPaths?: EncodedGitPath[];
      currentHeadDrift?: { resolvedHeadOid: string } }
  | { status: 'repository-state-uncertain'; pinnedHeadOid: string; resolvedHeadOid: string; attemptId: string }
  | { status: 'aborted-stale'; reason: string; attemptId: string }
  | { status: 'aborted-error'; reason: string; attemptId: string };
```

`aborted-*` is returned ONLY after confirming HEAD is unchanged and no marked commit
exists. A real marked commit is never discarded or auto-rolled-back (D-6).

**Post-commit index verification** (`indexIntegrity`): unrelated pre-existing staged
entries must remain BYTE-FOR-BYTE identical; selected entries may legitimately change to
reflect the new HEAD. A committed index mismatch is reported as a commit-that-exists
integrity incident (`indexIntegrity='mismatch'` with `indexMismatchedPaths`), never an
ordinary abort. If a hook altered the committed tree, the commit already exists →
`committed-integrity-mismatch` (recorded in the ledger, never auto-rolled-back), never
labeled "commit failed".

---

## 10. Invariants both consumers uphold

- **D-1 Global topology.** One repository-wide component pass; lenses filter/annotate; a
  plan lens NEVER carves a smaller candidate out of a component that connects to other
  plans. `plan_id` is a filter/label + trailer only; conflict topology — not plan
  membership — determines what is safely committable.
- **D-2 Repository-exclusive compose latch + object-db serialization.**
  `ComposeLockRegistry` grants an EXCLUSIVE lock per `repositoryKey`: at most one
  `consuming` candidate per real index, regardless of path intersection. Acquired (CAS)
  before final reassembly, held through commit + post-commit verify. While held, neither
  surface issues another actionable token for that `repositoryKey` (a mint attempt
  returns `{eligible:false, reason:'compose-in-flight'}`); the read-only service keeps
  rendering inventory. The active path set is UI metadata, NOT the mutual-exclusion
  boundary. `CheckpointQueue` (keyed by `objectDatabaseKey`) independently serializes git
  object/ref ops — complementary, not a substitute.
- **D-3 Pin, never cache** HEAD/index/ahead-of-origin counts.
- **D-4 Worktree bytes are the only commit source;** checkpoints are the audit/recovery
  trail (link to `restore_paths`), never the commit source.
- **D-5 Witnessed ≠ tree.** Unattributed inventory is ALWAYS exposed (even when empty);
  the assembler NEVER auto-groups unattributed paths; the user may explicitly select
  several, but each is an independent selectable entry.
- **D-6 Abort-never-repair;** no `checkout` / `restore` / `clean` / `reset` / `stash` in
  any failure path, including post-commit mismatch. Corrective staging only.
- **D-7 Token identity is server-derived;** client tokens/acks are validated requests,
  never trusted state.
- **D-8 Stamp immutability** (accessor + enum + trigger over all three stamp columns);
  consumers read, never write/infer stamps.

---

## 11. `plan_work_packages` + item-stamping prerequisite

Non-null `plan_item_id` is REJECTED as unsupported until this table lands; never equate a
work package with `plan_sections.anchor` (that would bake legacy HTML architecture into
the new structured model). Never use an always-true validation seam.

```sql
CREATE TABLE IF NOT EXISTS plan_work_packages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  title TEXT NOT NULL,
  acceptance_condition TEXT,
  state TEXT NOT NULL,                 -- frozen enum below
  assignee_agent_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('ready','executing','blocked','done','archived')),
  CHECK (revision > 0)
);
CREATE INDEX IF NOT EXISTS idx_plan_work_packages_plan ON plan_work_packages(plan_id);
```

Item validation is against `(workspace_id, plan_id, id)`. Landing this table is a hard
prerequisite for item stamping and for `finalization_kind='plan-package'` item-bound
finalizations.

---

## 12. SQL / file plan (implementation-ready)

- **`src/main/database.ts`** — `turn_records` stamp columns + immutability trigger +
  workspace-leading indexes (§6.3); `package_finalizations` (§5); `plan_work_packages`
  (§11); ledger `commit_records` / `commit_turn_links` / `commit_path_links` (§8);
  `commit_attempts` (§9.4); `continuation_handoff_attempts` + `orchestrations` binding
  columns (§6.3); `TurnRecord` / `AllocateTurnFields` / row-mapper / INSERT updates; new
  accessors (`getContinuationAttemptBinding`, `getOrchestrationBinding`, finalization +
  ledger + commit-attempt CRUD). Use the guarded try/catch `ALTER TABLE ADD COLUMN` idiom
  throughout; keep the "plain attribute, NO FK cascade" rule.
- **`src/shared/commit-candidates.ts`** — all types §1–§9.
- **`src/shared/constants.ts`** — `BUNDLE_CONTRACT_VERSION = 1`,
  `COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY = 128`.
- **`src/main/commit-candidates/`** — `candidate-service.ts` (assembler + token store +
  mint), `jcs.ts` (RFC 8785 encoder + tests), `compose-lock-registry.ts`,
  `repository-identity.ts` (§1 derivation).
- **`src/main/git-checkpoints/commit-reconciler.ts`** — ledger + finalization closure
  reconciliation (§5.1, §8).
- **`src/main/git-checkpoints/dispatch-context.ts`** — `DispatchContext` carries
  `ResolvedPlanStamp`; `DispatchAgentInfo` gains `planId`; `DispatchDeps` gains
  `planInWorkspace` + item-validity seam; resolution per §6.1 (no throw here — the
  boundary already validated).
- **`src/main/git-checkpoints/turn-coordinator.ts`** — `TurnContext` gains the resolved
  stamp; `openTurn` passes it into `allocateAndInsertTurn`. Overlap re-open inherits the
  new send's `ctx` (§6.4).
- **Dispatch/lifecycle wiring** — `src/main/api-server.ts`, `src/main/ipc-handlers.ts`
  (validate `RequestedPlanBinding` at the boundary, reject invalid before enqueue);
  `src/main/orchestration/dashboard-client.ts` (pass an `orchestration` `DispatchContext`
  with the run-frozen stamp, follow-ups included — stop calling `sendInput(id, text)`
  bare); `src/main/orchestration/groupthink-v2.ts`, `src/main/orchestration/types.ts`
  (thread run-level binding); `src/main/supervisor/index.ts` (launch/revive/continuation/
  fork rails freeze the stamp into `pendingInitialPrompts`, whose shape becomes
  `{ text: string; expiresAt: number; dispatch: DispatchContext }`; fork copies
  `source.planId` at creation).
- **Renderer** — `SaveCard.tsx` / `SaveBundle.tsx` (fleet lens) and the plan surface
  (plan lens) both read `WorkBundle` DTOs from `CommitCandidateService`; neither
  recomputes topology.

The `CommitCoordinator` (real-index writer) is a later work package; this contract only
fixes the token/verify/outcome obligations it must honor (§9). Its adversarial test
matrix (cross-eval §5.2) must pass before it is enabled.

---

## 13. Versioning the contract

`BUNDLE_CONTRACT_VERSION` on every canonical structure + token; consumers reject
mismatches (force a rebuild, never commit against a stale shape). **Breaking bump (+1)**
on any change to: wire shape, canonical encoder, identity inputs, supported git-entry
semantics, validation rules, finalization semantics, stamping inheritance, or
token-consumption rules. **Non-breaking** only for a field explicitly excluded from
canonical identity that old consumers safely ignore. The constant and this file's version
header move together in one change. (This is app code, not scaffold text, so the
`scaffold-content-needs-version-bump` discipline does not apply — but constant + doc must
move together.)

---

## 14. Test-case list (per dispatch path + per invariant)

**Stamping / dispatch.** Direct human send → `agent-default` from target `agents.plan_id`,
owner NULL, no item; orchestration explicit plan+item wins over agent default;
orchestration no-explicit → worker default, no item defaulted; orchestration FOLLOW-UP
messages reuse the run-frozen binding (not only initial launch); API explicit valid →
carried; cross-workspace explicit plan_id → reject (400), no fallback; explicit item
without/mismatched plan → reject; explicit `none` vs omitted/default distinguished for
EVERY path; `pendingInitialPrompts` retains dispatch metadata through delivery; fork →
`fork-carry` from fork agent's own binding + explicit clear, never read latest turn after;
revive wake → `revive-carry` + explicit item override; **continuation freezes the binding
into `continuation_handoff_attempts` pre-teardown, and relaunch/reconciliation reads those
columns (not `turn_records`, not live `agents.plan_id`) — restart test**; manual-terminal
raw typing = unattributed inventory, no fabricated turn/stamp; invalid explicit binding
rejected BEFORE delivery (no PTY bytes, no turn row); overlap re-open uses the NEW dispatch
stamp; deleting an agent preserves stamps; accessor + enum + trigger all block stamp
mutation (incl. `plan_stamp_source`); non-null `plan_item_id` rejected until
`plan_work_packages` exists; legacy rows read `legacy-unstamped`; `legacy-unstamped` never
written by an allocation; a wire `RequestedPlanBinding` cannot produce any `*-carry`
source.

**Repository scope / topology.** Same worktree via multiple `workspace_id`s ⇒ ONE
component graph + ONE latch; linked worktree ⇒ distinct latch, shared object-db
serialization; `repositoryKey` derived from the real index path; bare repo rejected;
mixed-plan transitive component stays ONE candidate in both lenses; `topologyDigest`
stable on an unchanged tree, changes when a new path connects in, unrelated other-component
change does not invalidate; the digest distinguishes two contributor mappings with
identical aggregate participants but different per-path graphs.

**Git member semantics.** Rename (both paths in `commitPathspecs`), copy, deletion vs
unavailable-hash, symlink `120000`, gitlink `160000` (ineligible), untracked,
ignored-excluded, unmerged (ineligible), submodule state, non-UTF-8 / control-char path
preserved via `pathBytesBase64` + marked unsupported/ineligible; raw checkpoint hash ≠
clean-filtered commit hash surfaced correctly.

**Candidate atomicity + coverage.** Proper-subset selection of a witnessed component
rejected (`component-subset-not-allowed`); multiple complete components combined only when
explicitly named; unattributed entries selectable independently; unrelated unattributed
paths never auto-fuse into one mega-candidate; candidate spanning two plan packages carries
BOTH `FinalizationRef`s and every member maps to its full sorted `coveringFinalizationIds`;
overlapping manifests disagreeing on any raw/commit field → `finalization-conflict`
ineligible; a requested finalization covering no member → `extraneous-finalization`;
identity changes when the finalization/coverage set changes; identical `candidateId` across
both lenses.

**Finalization / verification / closure.** Plan-package `done` finalize → match →
eligible; fleet-adhoc explicit mark-done captures `boundary_ref`; raw bytes unchanged but
`.gitattributes` changes the clean-filtered blob → candidate ineligible
(`verified-mismatch`); prior exact commit closes a finalization by matching the FROZEN
commit blob/mode; candidate selects one dirty member while another manifest member is
exactly committed already → eligible and on commit the finalization closes; a manifest
member clean but lacking exact ledger proof → `package-not-finalized`/ineligible,
finalization stays `active`; partial candidate commit does NOT prematurely mark/release the
finalization; all members protected across new + prior exact commits → `committed`,
`boundary_ref` released, `released_at` stamped; re-finalize bumps `package_revision` under
same `package_id`; supersede sets `superseded_by_finalization_id`; retention keeps the ref
while `active`, releases on `committed`/`superseded`/`abandoned`; unfinalized selection is a
`SelectionPreview` (`package-not-finalized`).

**Token / coordinator.** Mint validates acks against the fresh component (bad
`acknowledgeTopologyDigest` rejected; unacked unattributed rejected); TTL expiry; two
concurrent consumes — CAS lets exactly one proceed; pre-CAS transient failure does not
consume; per-`repositoryKey` cap eviction never touches a `consuming` token; app-restart
invalidation; stale topology digest at consume; contract-version rejection; pre-existing
staged entries preserved byte-identical; repository-exclusive latch — two DISJOINT
candidates against one `repositoryKey`, second mint returns `compose-in-flight` while the
first is `consuming`, inventory still renders.

**Commit attribution + outcome.** External HEAD advance during a failed attempt is NOT
misledgered as a Lares commit (`repository-state-uncertain`); marked Lares commit followed
by another HEAD advance reports the correct created commit PLUS `currentHeadDrift`; a marked
commit with an unexpected parent or unverifiable tree → `repository-state-uncertain`, OID
preserved in `commit_attempts.identified_commit_oid`, no exact candidate links created;
hook mutates committed tree → `committed-integrity-mismatch` recorded, no rollback; hook
alters an unrelated staged entry though the committed tree matches →
`indexIntegrity='mismatch'` integrity incident, commit retained; `aborted-*` only when HEAD
is unchanged and no marked commit exists.

**Protection / capture.** Rung per exact `{path, state, blob, mode}` incl. deletion;
`locally-committed` requires the frozen clean-filtered commit entry (raw match alone
insufficient); `pushed_remote_count` treated as a hint (remote rung decided read-time);
`captureOutage` true only for classified outage (not overlap/delivery); `after_ready`
overridden by live `rev-parse`; `pathsWithoutFinalizationEdge` keyed to exact bytes.

---

<!-- groupthink: shared bundle/stamping contract, Lead Planner × Reviewer, 6 rounds, approved 2026-07-30 -->


<!-- groupthink_run: 50bfdec9 (mode=serial) -->
