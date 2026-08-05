# Cross-evaluation synthesis — Planning-surface revamp (prop_8e2f5a93) × Save card (prop_4c8d21b7)

**Status:** groupthink synthesis (deliberation, no code changes yet). Two independent
planners cross-evaluated both proposals against the git-checkpoint turn database and the
supporting record under `.lares/proposals/supporting/`, then reconciled over two compare
rounds. This document is the merged conclusion: keep / change / drop per design element,
a revised shipping order with per-stage acceptance, the file/schema/IPC-level edits a
worker can execute, and the two decisions that must go to Edward.

**Method:** parallel independent drafts → one compare round each → this synthesis. Where
the two planners disagreed, the chosen middle ground is stated with its reasoning inline.

**Sources evaluated:**
- `.lares/proposals/2026-07-30-planning-surface-revamp.md` (prop_8e2f5a93)
- `.lares/proposals/2026-07-30-save-card-commit-ui.md` (prop_4c8d21b7)
- `.lares/proposals/supporting/2026-07-30-plan-surface-revival-technical-strategy.md`
- `.lares/proposals/supporting/2026-07-30-plan-surface-revival-design-detail.md`
- `.lares/proposals/supporting/save-card-git-native-input-2026-07-30.md`
- the two round-1/round-2 context briefs in the same folder

---

## 1. Executive decision

Both proposals are sound, rigorously grounded, and correctly refuse the two seductive
wrong moves (hunk-surgery attribution; auto-commit). The corrections are **ordering,
ambition, and accuracy of provenance claims** — not direction.

The load-bearing model both planners converged on is a single **protection-and-provenance
chain**, one layer deeper than either proposal shipped:

```text
proposal → plan / work package → dispatch → turn → witnessed paths / checkpoints
        → dirty candidate → local commit → remote reachability
```

- **Share the read model for this chain.** Candidate assembly, validation, evidence
  queries, and preview are one shared, read-only capability used by both surfaces.
- **Isolate the one component that mutates the real Git index/branch** as a separate,
  late, safety-gated subsystem — and treat "Lares never mutates the real index at all
  (preview + export + deep-link only)" as the recommended default, with a
  quiescence-gated commit as an optional later capability (Decision A, §7).
- **Promote into structured DB state, never into a new HTML plan file** — this removes
  the largest source of over-engineering (building an HTML architecture in Stage 1 that
  Stage 2 must migrate and delete).

The checkpoint DB is used **correctly but passively** by both proposals (a chronological
evidence store). Its higher-value uses are **active**: dirty-work retention *pinning*
(protect, don't warn), a durable **commit-protection ledger** with a remote-reachability
rung, **aggregate plan-review candidates**, conservative **blame-to-intent** queries, and
**pre-dispatch contention advisories**. These are the opportunities neither proposal
exploits; all are named and specced below with honest accuracy caveats.

---

## 2. Keep / change / drop (final, merged)

| Design element | Decision | Required change / reasoning |
|---|---|---|
| Cheap proposal markdown (Stage 0A skill) | **Keep** | Teach proposal *capture* only. Do **not** route new work into the legacy HTML plan rail. Do not promise promotion until a front door exists. Manual dogfood install first; scaffold-constant deploy waits until Stage 2. |
| `plan_id` / `plan_item_id` on `turn_records` | **Keep** | Caller-supplied, server-validated, **frozen at turn-open, never inferred later**. Ship this early — it unlocks evidence queries independently of the gallery. |
| Checkpoint-derived execution trail | **Keep, demote to drill-down** | Render from `turn_records`; never write into tracked plan files. The *primary* review object becomes the aggregate plan-review candidate (below); the per-turn trail explains *how it got there*. |
| Evidence ⇒ completion | **Drop the inference (keep never doing it)** | Evidence may show activity, review-readiness, or risk — never "done." `done` is an explicit human/supervisor transition. |
| PLAN-EVENT every-turn requirement; read-before-edit-for-progress | **Drop now** | Pure subtraction; safe immediately. |
| `assertPlanRailFree` one-writer lock | **Change (do not delete yet)** | It is hostile to shared-cwd **but protects a non-concurrency-safe HTML writer**. Deleting it while agents still author HTML swaps visible 409s for silent lost updates / malformed plans. Keep it scoped to legacy HTML ops; delete it when the HTML write path is retired (Stage 2), by **eliminating the unsafe write path**, not by permitting concurrent writes to it. |
| Bespoke provenance (5-rung resolver, `plan_snapshots` VCS, section hashing, touch tracker, sentinel parser) | **Drop after legacy import** | Git objects now do this. Delete only once plan state is structured DB rows with the `plan_state_events` ledger and the two legacy HTML plans are imported + parity-verified. |
| Proposal gallery / registry / promotion | **Keep, gate behind a longer probe** | Build only after separate demand metrics clear (§6). A probe that only counts files supervisors write does not prove demand for a gallery or promotion. |
| Promotion target | **Change: structured DB rows, no HTML** | Promote into a single structured transaction; retain the proposal md as the portable source; export a tracked audit artifact on archive. Removes almost all file+DB compensation complexity. Any residual dual-write must be idempotent/compensated **from the start** — frequency affects priority, not atomicity. |
| Save card dirty inventory | **Keep, ship first** | Read-only. Present overlap-connected components + unattributed pseudo-bundle + workspace capture-health, not allegedly-clean per-agent bundles. |
| Expiry warnings | **Change: protect, don't nag** | The engine controls retention, so **pin recovery edges for still-dirty paths** (quota-bounded); warn only when quota/max-extension genuinely forces weakening. |
| Commit composer | **Split, isolate the writer** | One subsystem, two modules: `CommitCandidateService` (read-only, shared, frequent) → `CommitCoordinator` (real-index mutation, singleton, quiescence-gated, exhaustively audited). |
| Stage-then-commit into the global index | **Drop** | Preview from a temporary `GIT_INDEX_FILE`; never leave candidate paths staged between user actions; one path-scoped `git commit --only …` on the explicit click. Optional labeled "Stage only" escape hatch later. |
| Hunk attribution / splitting | **Drop** | Whole-path scope only. Overlapping paths are inseparable unless a human edits the candidate. |
| Hot-file "shared changes" auto-commit | **Change to human-driven extraction** | Auto-committing a whole hot file relocates mixed concerns and can yield a non-compiling intermediate commit. Connected components define the minimum safely-separable unit; the UI *suggests* extracting a shared prerequisite commit; extraction requires explicit human selection + validation, never automatic reassignment. |
| Plan-grouped commits | **Keep as a filter/label** | Plan is useful commit metadata (trailers); **conflict topology, not plan membership, determines what is safely committable.** |
| Blame-to-intent | **Add, conservatively** | File/hunk→turns→plans with confidence + conflicting contributors is cheap. Exact line authorship is **not** cheap (§3); ship the honest version first. |
| Aggregate plan-review | **Add as a "candidate," not an exact diff** | HEAD/worktree vs a pinned plan baseline, limited to plan-bound witnessed paths, annotated with overlapping non-plan turns + capture gaps + explicit mixed-authorship warning. |
| Contention analysis | **Add as pre-dispatch advisory** | Prevention (warn before launching into a hotspot) beats post-hoc attribution. Never an automatic block. |
| Regression / clobber detection | **Add as suspicion, never proof** | Whole-tree snapshots observe a shared cumulative tree; never label a "clobber" unless the byte transition mechanically establishes it. |
| Work-package-level undo | **Drop from initial design** | Restoring the union of a package's paths is dangerous in a shared tree (paths carry later work). Link to per-turn/path restore instead. |
| Commit-protection ledger + remote rung | **Add** | Three honest states: checkpoint-protected → locally committed → reachable from a configured remote. A local commit is stronger than a checkpoint but is **not** an off-machine backup. |
| Commit trailers | **Add** | `Lares-Plan`, `Lares-Plan-Item`, `Lares-Turns` — portable, git-native provenance that survives outside the DB. |

---

## 3. Where the two planners disagreed, and the chosen middle ground

These are the only points where the independent drafts diverged. Each resolution is the
synthesis position a worker should implement.

**(a) Ceremony deletion is not uniformly "pure subtraction."**
Split it. Remove the PLAN-EVENT requirement and read-before-edit-for-progress **now**
(safe). Keep `assertPlanRailFree` alive **scoped to legacy HTML operations** until the
HTML writer is retired in Stage 2. Rationale: the lock is hostile to shared-cwd, but the
HTML document it guards is not concurrency-safe; removing the lock before removing the
write path exchanges visible 409s for silent data loss.

**(b) Hot-file overlap — extraction, not a "shared changes" auto-commit.**
Keep connected components as the minimum safely-separable candidate. Highlight shared
paths inside a component and *offer* "extract this shared file as a prerequisite commit,"
but require the human to select it and require the resulting candidate to pass validation
(it may not compile if consumers stay in later commits). Automatic reassignment of a hot
file's bytes is unsafe.

**(c) TOCTOU at commit time — path-scoped quiescence is optimistic; ship workspace
quiescence if committing at all.**
A per-path content hash + singleton compose lock closes composer-vs-composer and
preview-vs-click races, but **not** an active agent writing a selected path during
`git add`/`git commit`. `CheckpointQueue` and any compose lock coordinate *Lares* Git
operations, not arbitrary filesystem writes by agents/editors/shells. Path-scoped
quiescence (pause only dispatches touching selected paths) is tempting but unsound: an
open turn that has not yet touched a path may be about to. Therefore, **if Lares commits
at all, V1 requires workspace quiescence** (no open Lares turn; no restore/revert in
flight) plus a final revalidation immediately before a single path-scoped commit, and
external tools remain an optimistic-concurrency residual handled by abort-never-repair.
This feeds Decision A (§7): the recommended default is to **not** mutate the index in V1.

**(d) Blame-to-intent is file-level-cheap, not line-level-cheap.**
Ship file/hunk→turns→plans with confidence + conflicting contributors. Exact line
provenance is defeated by concurrent work in whole-tree snapshots, moved/deleted lines,
generated rewrites, and multi-turn lines. Exact attribution strengthens only after the
commit-turn ledger exists: `git blame` → durable commit → ledger → candidate turns/plan
(and mixed-path commits still support only commit-level attribution).

**(e) Aggregate plan review is a *candidate*, not an exact union of after-trees.**
Diffing a plan-open whole-tree baseline against accepted turns' after-trees includes
other agents' concurrent changes; witnessed-path restriction helps but a witnessed file
may still carry another agent's bytes; unioning can double-count or show later-reverted
work. Present it as a "plan review candidate" with explicit mixed-authorship and
capture-gap annotations — the same accuracy discipline as the commit composer.

**(f) Promotion simplification is architectural, not a relaxation of correctness.**
Do not wait for observed corruption before adding compensation. Instead remove the need
for it: promote into a structured DB transaction, keep the proposal md as the source,
skip HTML entirely. If any dual FS+DB write remains, its idempotency/cleanup must be
correct from day one.

---

## 4. The checkpoint DB — concrete additive edits (grouped by module)

### 4.1 Immutable intent stamping (ship early; unlocks everything downstream)

**Files:** `src/main/database.ts`, `src/main/git-checkpoints/dispatch-context.ts`,
`src/main/git-checkpoints/turn-coordinator.ts`, `src/shared/types.ts`,
`src/main/api-server.ts`, `src/main/plans/plan-ipc.ts`,
`src/main/orchestration/groupthink-v2.ts`, `src/main/orchestration/types.ts`.

- `turn_records`: add nullable `plan_id TEXT`, `plan_item_id TEXT` via the existing
  try/catch `ALTER TABLE ADD COLUMN` idiom (as used for `agents.plan_id`). Indexes:
  `idx_turn_records_plan ON turn_records(plan_id, turn_seq)` and
  `idx_turn_records_plan_item ON turn_records(plan_item_id, turn_seq)`.
- Extend `AllocateTurnFields` and the `turn_records` row↔object mapper to carry
  `planId`/`planItemId`. Keep the file's "plain attribute, NO FK cascade" rule: deleting
  an agent must never purge these rows or null the association.
- `DispatchContext` + `TurnContext`: add optional `planId?`/`planItemId?` (caller-
  suppliable, unlike `ownerBrickGeneration`). In `buildDispatchTurnContext`, resolve:
  explicit validated dispatch values win; a frozen `agents.plan_id` is a **default** for
  `planId` only when the dispatch names none; copy resolved values into the row at
  `openTurn` and never re-infer from cwd / plan-file edits / final messages / hook keys.
- Validate server-side: plan ∈ workspace; item ∈ plan (only when an item is supplied).
  Reject invalid **explicit** identifiers with a 400 — do not silently fall back.
- Tests: explicit binding; supervisor default; cross-workspace rejection; mismatched
  item; human-terminal turn; resumed/reused agent; deleting an agent preserves the join.

### 4.2 Commit-protection ledger + reconciler

**Files:** `src/main/database.ts`; new `src/main/git-checkpoints/commit-reconciler.ts`.

Schema:

```sql
CREATE TABLE IF NOT EXISTS commit_records (
  workspace_id       TEXT NOT NULL,
  commit_oid         TEXT NOT NULL,
  parent_oid         TEXT,
  observed_at        TEXT NOT NULL,
  source             TEXT NOT NULL,        -- lares | external
  pushed_remote_count INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at TEXT,
  PRIMARY KEY (workspace_id, commit_oid)
);
CREATE TABLE IF NOT EXISTS commit_turn_links (
  commit_oid    TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  plan_id       TEXT,
  plan_item_id  TEXT,
  relation      TEXT NOT NULL,             -- candidate_member | exact_path_match | metadata_only
  capture_quality TEXT
);
CREATE TABLE IF NOT EXISTS commit_path_links (
  commit_oid              TEXT NOT NULL,
  repo_relative_path      TEXT NOT NULL,
  worktree_blob_oid_at_commit TEXT,
  contributing_turn_ids   TEXT,            -- JSON array
  overlap_count           INTEGER NOT NULL DEFAULT 0
);
```

`commit-reconciler.ts`:
- Record **exact** links for commits Lares itself creates (from the candidate token).
- Detect external HEAD movement; label inferred links **conservatively** — never claim an
  external commit contains a turn merely because path sets overlap (`relation='metadata_only'`).
- Compute `pushed_remote_count` against configured remote refs; expose the three protection
  states: checkpoint-protected / locally-committed / remote-reachable.
- Replace the proposal's "commit to make permanent" copy with honest wording.

### 4.3 Retention pinning (protect, don't warn)

**Files:** `src/main/git-checkpoints/retention.ts`; new
`src/main/git-checkpoints/protection-policy.ts`.

- Before pruning, intersect each turn's witnessed paths with the current dirty-path set.
- Retain **both** edges for turns whose witnessed paths remain dirty, bounded by an
  explicit storage quota and a maximum extension.
- If enumeration or capture quality is insufficient, **retain rather than prune** until
  quota forces a decision.
- Once a path is linked to a local commit (via the ledger), return to normal thinning.
- Warn **only** when quota / max-extension means protection will genuinely weaken.
- Keep the existing `decidePruneEdges(row, now, retentionMs)` predicate authoritative;
  the forecaster calls it with a future `now` so warnings can never disagree with reality.

### 4.4 Contention model (pre-dispatch prevention)

**Files:** new `src/main/git-checkpoints/contention-model.ts`.

- Build a rolling path-contention graph from recent `turn_records.touched`.
- Before dispatch, warn when a proposed work package names hotspot paths or overlaps
  active turns. **Scheduling advice, never an automatic block.**
- Surface shared-path risk in plan items and Save candidates. Never infer hunk-level
  ownership.

### 4.5 Blame-to-intent + aggregate review (conservative)

**Files:** `src/main/git-checkpoints/checkpoint-ipc.ts`,
`src/main/plans/execution-trail.ts`, `src/renderer/components/plan/PlanSurfaceView.tsx`,
`src/renderer/components/git/FileHistoryView.tsx` (or equivalent attribution view).

- **File/hunk→intent projection:** given a path (or hunk), return contributing turns and
  their plans, with a confidence label and a list of conflicting contributors. Frame as
  "these plans/turns contributed," not "authored this line." Strengthen post-ledger via
  `git blame` → `commit_records`/`commit_turn_links`.
- **Aggregate plan-review candidate:** for a `plan_id`, produce HEAD/worktree vs a pinned
  plan baseline, restricted to paths witnessed by plan-bound turns, annotated with
  overlapping non-plan turns, unattributed/capture-gap risk, and an explicit "current
  bytes may contain mixed authorship" flag. Render as the plan's **primary** review
  object; the per-turn trail becomes drill-down.
- **Regression signals (suspicion):** same-path contention alerts; later-turn
  changed/deleted prior-turn output; unexpected shrinkage/reversion; links to compare the
  relevant snapshots. Never emit the word "clobber" without a mechanical byte proof.

---

## 5. Commit subsystem — one capability, two modules

### 5.1 `CommitCandidateService` (read-only, shared by both surfaces)

**Files (new):** `src/main/save-card/dirty-status.ts`,
`src/main/save-card/bundle-assembler.ts`, `src/main/save-card/commit-candidate.ts`,
`src/main/save-card/commit-candidate-service.ts`, plus unit tests.

Responsibilities:
1. Run `git --no-optional-locks status --porcelain=v2 -z --untracked-files=all`.
2. Reuse the checkpoint engine's `enumerateScope` workspace-scope rules (card ≡ engine).
3. Join dirty paths → witnessed turns, plans, workers, capture quality, protection state.
4. Build **overlap-connected components**. Worker / supervisor / plan are **filters and
   labels, not commit boundaries.**
5. Emit an **immutable candidate token**: pinned HEAD OID; index tree checksum; selected
   path list; selected worktree blob OIDs + modes; overlap + unattributed acknowledgements;
   contributing turn IDs; proposed message + trailers.
6. Build preview diffs through a **temporary `GIT_INDEX_FILE`**; never mutate the real
   index during review.

### 5.2 `CommitCoordinator` (the only real-index writer; singleton, late, gated)

**Files (new):** `src/main/save-card/commit-coordinator.ts` + adversarial integration tests.

- **V1 quiescence gate:** refuse (or pause new dispatches and wait for) any open Lares turn
  and any restore/revert in flight before committing.
- Serialize through the existing per-object-DB `CheckpointQueue`; additionally hold a
  repo-level compose lock so two coordinators cannot run.
- Immediately before commit, **revalidate** HEAD, index state, every selected path's
  blob/mode, overlap acknowledgements, capture quality. **Reject stale candidates and
  regenerate — never attempt repair.**
- Commit with a single path-scoped operation:
  `git commit --only --pathspec-from-file=<file> --pathspec-file-nul` using the
  user-approved message. `--only` disregards other paths' staged content and leaves it
  intact afterward — no persistent Lares staging.
- Run normal `pre-commit` / `prepare-commit-msg` / `commit-msg` / `post-commit` hooks;
  **never** `--no-verify`.
- Never delete `index.lock`; bounded retry on contention, then loud failure.
- Never use `checkout` / `restore` / `clean` / `reset` / `stash` in error handling —
  corrective staging only.
- Record the resulting commit + exact candidate membership in the protection ledger.
- On hook failure or stale input, leave worktree bytes intact and report index state
  explicitly.

**Adversarial test matrix (must pass before enabling the coordinator):** another agent
edits a selected path after preview; edits a non-selected path; HEAD moves after preview;
index changes after preview; unrelated content already staged; an active turn begins
before confirmation; restore/revert races confirmation; `pre-commit`/`commit-msg` rejects;
a hook modifies selected content; `index.lock` already present; filenames with spaces /
newlines / Unicode / leading dashes; add/delete/rename, exec-bit, symlink, submodule,
CRLF, untracked; transitive overlap (A–B, B–C); empty witness sets / missing snapshots;
failed commit followed by successful candidate regeneration.

Only `CommitCandidateService` is called by the Save card and plan surface. Only the
explicit Commit button calls `CommitCoordinator`.

---

## 6. Demand probe — separate metrics, longer window

The proposals' single "≥3 plans created" gate conflates three distinct hypotheses. Track
them separately over **several weeks**:

- **Proposal capture:** ≥N proposals voluntarily authored to `.lares/proposals/` (not to
  exercise the feature).
- **Human browsing:** ≥M voluntary returns to the proposal reader / Save card.
- **Promotion demand:** ≥K promotions voluntarily requested.

Ship a **very small filesystem-backed proposal reader** early *only if* discoverability is
otherwise too poor to measure browsing. Gate the durable registry, promotion workflow,
responsibility model, and mission board on **promotion demand** specifically. If promotion
is not voluntarily requested, **retain the reader + fold execution evidence into the
existing attribution UI; do not build a mission board.**

Additional gate checks (from both proposals, retained): plan-bound agents resume from one
bounded context read; no false "activity = done"; bundle precision audited against raw
`git status`; a supervisor identifies dirty / unattributed / overlapping / weakly-protected
work in <30s.

---

## 7. Revised shipping order (with per-stage acceptance)

Each stage is shippable and reversible alone; later stages are gated on earlier ones
earning their keep.

**Stage 0 — proposal habit + ceremony subtraction (no gate).**
- Manual-install `proposal-to-plan` skill: write cheap markdown to `.lares/proposals/`
  with a portable `artifact_id`; a proposal is a valid terminal state; do **not** route
  hardening agents into legacy HTML; do not promise promotion.
- Remove the PLAN-EVENT every-turn requirement + read-before-edit-for-progress
  (`src/main/plans/plan-rail-contract.ts`, worker guidance). Keep `assertPlanRailFree`
  scoped to legacy HTML ops.
- *Accept:* a supervisor unprompted authors a proposal md; no worker emits a sentinel;
  legacy HTML edits still serialize.

**Stage 1 — read-only Save card (no index writes).**
- `CommitCandidateService` read path + `src/main/save-card/save-card-ipc.ts`;
  `src/preload/index.ts`; `src/shared/types.ts`; `src/renderer/components/save/SaveCard.tsx`
  + `SaveBundle.tsx`. Show overlap-connected components, unattributed pseudo-bundle,
  capture-quality flags, and **workspace capture-health** (turns without before/after
  snapshots; witnessed changes without restorable edges; dirty paths with no witnessed
  turn; imminent quota-driven weakening).
- *Accept:* dirty/unattributed/overlap/protection state identifiable in <30s; bundle
  membership matches raw `git status`; zero real-index writes.

**Stage 2 — dispatch-time plan association (§4.1).** Independent of the gallery; unlocks
evidence queries. *Accept:* every plan-bound dispatch yields a correct immutable join;
deleting an agent preserves it.

**Stage 3 — conservative evidence surfaces (§4.5).** File/hunk→intent queries, aggregate
plan-review candidates, contention advisories. *Accept:* each surface renders with its
confidence/mixed-authorship annotations; no exact-provenance overclaim.

**Stage 4 — protection depth (§4.2, §4.3).** Retention pinning + commit-protection ledger
+ three-rung protection state. *Accept:* still-dirty work retains recovery edges within
quota; ledger links Lares commits exactly and external commits conservatively.

**Stage 5 — registry / gallery / promotion (gated on promotion demand, §6).**
`.lares/proposals/` construction in `src/main/workspace-state-dir.ts`; dedicated
`proposals` registry + `src/main/proposals-watcher.ts` (witnessed-first attribution,
frontmatter `artifact_id` adopt/mint, the normative duplicate + malformed-frontmatter
policies from the technical strategy); unified gallery IPC on
`src/main/plans/plan-ipc.ts`; `PlanGalleryPane.tsx` + read-only markdown pane + date
grouping + author/capture chips. **Promotion mints structured DB rows in one transaction
— no HTML plan file.** Deploy the Stage-0 skill + supervisor/worker guidance via
`src/shared/constants.ts` version bumps now (with the frozen-hash migration discipline).
*Accept:* promote creates a structured plan + proposal→plan lineage transactionally and
idempotently; source md persists; the two legacy HTML plans import + parity-verify; then
delete snapshot VCS, section hashing, sanitizer/render-pane, touch tracking, claim
resolver, sentinel parser, HTML writeback — and retire `assertPlanRailFree` with the
writer.

**Stage 6 — candidate preview from both surfaces (no index writes).** Save card =
fleet/conflict-component candidates; plan surface = plan-filtered candidates labeled by
work package; require explicit inclusion of unattributed paths; offer message editing +
`Lares-Plan` / `Lares-Plan-Item` / `Lares-Turns` trailers; export to the user's Git client
via deep link. *Accept:* preview never touches the real index; export round-trips.

**Stage 7 — commit coordinator (optional; only after Decision A says yes).** Enable
`CommitCoordinator` only after the workspace-quiescence gate exists and the adversarial
matrix passes. *Accept:* every matrix case either commits exactly the previewed bytes or
aborts cleanly with worktree intact; the protection ledger records the result.

---

## 8. Two decisions for Edward

**Decision A — does Lares ever mutate the real index?**
Recommended default: **ship Stage 6 (preview + export + deep-link) and stop there.**
Protection visibility, candidate preview, message/trailer generation, and export capture
most of the value at a fraction of the corruption risk. Treat Stage 7 (real-index commit
behind workspace quiescence) as an **optional later capability**, not a V1 requirement. If
quiescence proves too disruptive in a live fleet, Stage 6 is the terminal state.

**Decision B — promotion target.**
Both planners agree: **promote into structured DB rows, never a new `.lares/plans/*.html`
file.** This is the single largest reduction in over-engineering (no HTML architecture
built in Stage 5 that Stage 2 must migrate and delete) and it removes almost all
file+DB compensation complexity. Confirm this supersedes the technical strategy's
`promote-proposal.ts` HTML-minting flow (§D of that document).

---

## 9. Strongest case against each proposal (retained, both planners concur)

**Against the planning-surface revamp.** The observed failure was **adoption, not
provenance** — two plans, one a demo, are weak evidence that users want a registry,
watcher, promotion transaction, responsibility schema, mission board, migration system,
agent tools, and archive format. The product risks re-creating an issue tracker inside a
coding dashboard when conversation + agent cards + checkpoint diffs + ordinary repository
markdown already cover the real workflow. The most dangerous over-engineering is
generating an HTML plan architecture in Stage 1 that Stage 2 is already planning to
delete. **Mitigation:** the longer, separated demand probe (§6) and no-HTML promotion (§8B).

**Against the Save card.** `git status` and mainstream source-control UIs already show
uncommitted work; in a shared tree the checkpoint DB **cannot** reliably divide current
file bytes by worker or plan, and a polished bundle UI can create *false confidence* in
attribution and lead users to commit mixed concerns. The composer expands Lares from safe
private refs into the real index/branch — a large corruption-risk increase for a
convenience feature — and expiry alone does not justify it (accepted turns keep an after
edge; compact evidence is distilled before pruning). **Mitigation:** the defensible core is
the read-only protection card (§7 Stage 1) + retention pinning (protect, don't nag);
one-click commit is optional and should be dropped if quiescence, stale-candidate
validation, and index preservation cannot be made boringly reliable (Decision A).

---

## 10. Missing opportunities the checkpoint DB enables (neither proposal exploits)

1. **Commit-protection ledger with a remote-reachability rung** — the honest end of the
   chain; makes "is my work actually safe?" answerable and powers durable blame-to-intent.
2. **Retention pinning** — the engine controls retention, so protect still-dirty work
   automatically instead of nagging the user to repair an avoidable policy decision.
3. **Aggregate plan-review candidate** — the validated market pattern (branch diff as the
   completion artifact) with honest mixed-authorship annotation; both proposals lead with
   the chronological trail instead.
4. **Pre-dispatch contention advisories** — turn checkpoint history into prevention.
5. **File→turn→plan blame-to-intent** — cheap at file level, market-unique; ship the
   conservative version now and the exact version after the commit-turn ledger.

---

## Bottom line

Ship three seams first, in order: (1) the proposal-capture habit + safe ceremony
subtraction; (2) the **read-only** Save card with overlap-connected components,
unattributed work, and workspace capture-health; (3) immutable dispatch-time plan
association. Then add conservative evidence surfaces, retention pinning, and the
commit-protection ledger. Build the registry/gallery and **structured-row, no-HTML**
promotion only after separated demand metrics clear. Share **candidate semantics** between
both surfaces; treat the real-index coordinator as a separate, late, quiescence-gated
subsystem — and seriously consider never building it, letting preview + export + deep-link
be the terminal state. The consequential question is no longer whether the proposals share
a composer (they should share *candidate assembly*); it is whether Lares must mutate the
real index at all.

<!-- groupthink: two-proposal cross-evaluation synthesis, 2026-07-30 -->


<!-- groupthink_run: 98b56a3e (mode=parallel) -->
