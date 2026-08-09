---
plan_artifact_id: plan_ce97b9ad
intent_id: int_d1d47a05
kind: deliberation
---

# D1 + D4 — Server-witnessed package ledger schema and plan-folder version-control policy

**One joint decision.** D1 chooses where the machine-durable record of "a plan's
work happened and is reachable" lives; D4 chooses what the plan folder commits to
git. They are the same decision because the moment `plan.json` stops being
git-tracked, its durability has to come from the D1 ledger or from nowhere. This
draft resolves both together, grounded in a read of the live schema and a git
survey of the on-disk plan-folder population.

---

## 0. What the survey found (evidence, not assertion)

### 0.1 Plan-folder git tracking (D4 survey — `git ls-files` / `git status`)

Across all six plan folders under `.lares/plans/`:

- **`plan.json` is untracked in 6 of 6 folders.** It is *not* matched by any
  `.gitignore` rule (`git check-ignore` returns nothing) — it is simply never
  `git add`ed. Its untracked status is an accident of what the scaffold and agents
  happened to stage, exactly as D4 states.
- **`.md` tracking is inconsistent and sometimes inverted.** In
  `plan_5b3ea7d1` the *superseded* draft `deliberations/int_7c1e94af-claude-draft.md`
  is tracked while the *active, folded-in* synthesis
  `deliberations/2026-08-06-carry-forward-equivalence.md` is untracked. `research/`
  is untracked in most folders (one stray `grok-...txt` excepted); `supplements/`
  ranges from fully tracked (`plan_e0001372`) to `.gitkeep`-only.
- The tracked set today is roughly `{ARC.md, OVERVIEW.md, plan.md}` plus whatever
  supplements/deliberations an agent remembered to add. **The machine-readable half
  and the winning arguments are the untracked half.**

This is the precise defect D4 raises, now confirmed to be workspace-wide rather
than a case-study quirk.

### 0.2 The ledger is 80% built and 100% disconnected (D1 survey — `src/main/database.ts`)

The tables D1 asks for mostly already exist. What is missing is the join, the
enforcement, and the single writer:

| Ledger fact D1 wants | Existing table/column | State |
|---|---|---|
| `plan_artifact_id`, `source_proposal_id` | `plans.artifact_id`, `plans.source_proposal_id` (1826-1834) | exists; `source_proposal_id` null for case+audit plans |
| `intent_id` identity + outputs | `plan_intents(plan_id,intent_id)`, `plan_intent_outputs` (1853-1901) | exists |
| package id / revision / state | `plan_work_packages` (1680-1693) | exists |
| package transition history | `plan_wp_lifecycle_events` (2131-2146) | exists **but CHECK omits `'done'`** |
| dispatched agent / session | `plan_dispatch_attempts` (2190-2204), `orchestrations` (417-458) | exists; `orchestrations.planning_intent_id` **nullable**, null for a1bacc4a |
| gate outcome + commit boundary | `package_finalizations` (1707-1744) | exists; never written for WP6-8 |
| commit OIDs ↔ turn ↔ plan item | `commit_turn_links(commit_oid,turn_id,plan_id,plan_item_id)` (1647-1656) | exists; `plan_item_id` null because `turn_records.plan_item_id` was null at dispatch |
| deployment state | `commit_records.pushed_remote_count` (1635-1646) | exists |
| continuation handoff results | `continuation_handoff_attempts` (218-227) | **status only; no brick_saved/successor_started/successor_oriented** |

**Diagnosis of the a1bacc4a evidence.** The 13 commits have "no machine join to
package gates" for three mechanical reasons, all fixable without a greenfield
ledger:

1. `orchestrations` for a1bacc4a has `plan_id / planning_intent_id / plan_item_id`
   all null — nothing *required* them at launch, so the dispatch→plan join never
   formed. (D2's remit.)
2. Because dispatch never stamped `plan_item_id`, `turn_records.plan_item_id` was
   null, so `commit_turn_links.plan_item_id` is null — the commit→package edge
   exists structurally but carries no package key.
3. `package_finalizations` — the row that *is* the gate outcome + commit boundary —
   was never written for WP6-8, because there is no single supported transition
   that writes it, and the one transition-log table that would witness a completion
   (`plan_wp_lifecycle_events`) **cannot even represent `'done'`** (its
   `CHECK (to_state IN ('ready','executing','blocked','archived'))` omits it). So
   `plan_work_packages.state` was left at `blocked` while the work actually landed.

**Design consequence: D1 is an integration-and-enforcement job, not a new schema
from scratch.** The correct move is a canonical *ledger view* + *one transition
API* over the existing tables, plus three additive pieces (the `'done'` fix, a
continuation-results table, and binding-completeness markers). This is both
cheaper and safer (no data migration of live plan state) than a parallel ledger,
and it cuts directly against the author's disclosed incentive to oversize Cluster D.

---

## 1. Decision D1 — the server-witnessed package ledger

### 1.1 Shape: one canonical join view + one transition API over existing tables

**Do not** create a new monolithic `package_ledger` table that copies columns from
`plan_work_packages`, `package_finalizations`, and `commit_records`. That would
create a second mutable authority — the exact anti-pattern the existing schema
comments call out ("SINGLE run-state authority stays in `orchestrations`",
1843-1846; "never a second mutable run-state authority"). Instead the ledger is:

- **a read model** (`renderPlanFromLedger`) that JOINs the existing tables, and
- **a single write path** (`recordPackageTransition`) that is the *only* mutator of
  `plan_work_packages.state` and atomically writes the transition's evidence.

### 1.2 The join (the "machine register" F2 asked for)

Define one accessor in a new file **`src/main/plan-ledger.ts`** exporting
`renderPlanFromLedger(workspaceId, planId): LedgerView`. It returns, per package,
the full chain — assembled by these joins (all keys already exist in the schema):

```
plan_work_packages  pwp        (id, plan_id, revision, state, assignee_agent_id)
  ⟕ plans           p          ON p.id = pwp.plan_id
                               → plan_artifact_id, source_proposal_id, folder_rel_path
  ⟕ plan_intents    pi         ON (pi.plan_id, pi.intent_id)      -- intent lineage
  ⟕ plan_dispatch_attempts pda ON pda.package_id = pwp.id         -- dispatched agent + confirmed_turn_id
  ⟕ orchestrations  o          ON (o.plan_id, o.planning_intent_id)-- run identity
  ⟕ package_finalizations pf   ON pf.package_id = pwp.id
                                  AND pf.package_revision = pwp.revision
                                  AND pf.lifecycle_status IN ('active','committed')  -- GATE OUTCOME + boundary
  ⟕ commit_turn_links ctl      ON ctl.plan_item_id = pwp.id       -- COMMIT OIDS
  ⟕ commit_records  cr         ON (cr.repository_key, cr.commit_oid)-- DEPLOYMENT STATE (pushed_remote_count)
  ⟕ plan_wp_lifecycle_events le ON le.package_id = pwp.id          -- transition history
```

The topic's required fields map exactly:

| Required field | Source in the join |
|---|---|
| `plan_artifact_id` | `plans.artifact_id` |
| `intent_id` | `plan_intents.intent_id` (+ `orchestrations.planning_intent_id` for the run that ran it) |
| package id / revision | `plan_work_packages.id` / `.revision` |
| dispatched agent / session | `plan_dispatch_attempts.target_agent_id` + `.confirmed_turn_id`; `orchestrations.run_id` |
| gate outcome | `package_finalizations.boundary_status` + `.lifecycle_status` (never derived from `accepted`) |
| commit OIDs | `commit_turn_links.commit_oid` filtered by `relation` |
| deployment state | `commit_records.pushed_remote_count` (0 ⇒ not deployed) |

This is why F9's "nothing is deployed" caveat is representable rather than
assumed: `pushed_remote_count = 0` on every commit *is* the deployment state, on
the record.

### 1.3 Three additive schema changes (the real net-new work)

**(a) Fix the `'done'` gap — `plan_wp_lifecycle_events`.** SQLite can't `ALTER` a
CHECK, and the table has live rows, so use the 12-step rebuild idiom already
established elsewhere in this file. In `src/main/database.ts` at the block starting
line 2131, replace the `CREATE TABLE` + add a guarded one-time rebuild:

```sql
-- was: CHECK (to_state IN ('ready','executing','blocked','archived'))
CHECK (to_state IN ('ready','executing','blocked','done','archived'))
```

Rebuild migration (guarded, runs once — detect by probing the old CHECK):
`CREATE TABLE plan_wp_lifecycle_events__new (... new CHECK ...)` →
`INSERT INTO ...__new SELECT * FROM plan_wp_lifecycle_events` →
`DROP TABLE plan_wp_lifecycle_events` → `ALTER TABLE ...__new RENAME TO ...` →
recreate the two indexes (2143-2146). Wrap in a `try/catch` that no-ops if the new
CHECK already admits `'done'` (probe with a throwaway insert-rollback).

**(b) Continuation handoff results — new table, keyed to `handoff_attempt_id`,
NOT overloading checkpoint-turn status.** This is the D3 constraint made concrete.
The D3 forensic (RESOLVED: recorder bug) is explicit that these three results are
a *distinct lifecycle* from the checkpoint turn and "should not overwrite
checkpoint-turn status." Add near the continuation tables (`src/main/database.ts`
~line 262, after `continuation_deferrals`):

```sql
CREATE TABLE IF NOT EXISTS continuation_handoff_results (
  id                  TEXT PRIMARY KEY,
  handoff_attempt_id  TEXT NOT NULL,          -- FK-by-value to continuation_handoff_attempts.id
  dashboard_agent_id  TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  result_kind         TEXT NOT NULL
    CHECK (result_kind IN ('brick_saved','successor_started','successor_oriented')),
  disposition         TEXT NOT NULL
    CHECK (disposition IN ('succeeded','failed','timed_out')),
  -- correlation, never authority over turn_records.status:
  brick_id            TEXT,                   -- for brick_saved
  successor_session_id TEXT,                  -- for successor_started/_oriented
  kickoff_turn_id     TEXT,                   -- for successor_oriented
  detail_json         TEXT,                   -- bytes/source/quality/failure_reason
  observed_at         TEXT NOT NULL,
  UNIQUE(handoff_attempt_id, result_kind)
);
CREATE INDEX IF NOT EXISTS idx_continuation_results_attempt
  ON continuation_handoff_results (handoff_attempt_id);
```

Recording rules (straight from the D3 fix spec, lines 164-184 of the forensic):
- `brick_saved` — only after the tool-sourced brick row is durably inserted.
- `successor_started` — only after the runner-launch **tail** resolves and the
  fresh session is live (not when the relaunch route accepts).
- `successor_oriented` — only after the auto-submitted orientation turn is
  correlated to the attempt/session and completes; record `failed`/`timed_out`
  explicitly otherwise.

Because these live in their own table keyed by `handoff_attempt_id`, a handoff that
saves a brick but fails to start a successor, or starts one that fails to orient,
is faithfully representable — and none of it touches `turn_records.status`. This
is the "must not overload checkpoint-turn status" requirement, satisfied
structurally. (The checkpoint-recorder fixes themselves — turn-identity
compare-and-delete, serialize-behind-close, unbounded reconciliation, witness-path
canonicalization — are separate D3-implementation packages; this ledger only
consumes their *outputs*.)

**(c) Binding-completeness markers (the D2 seam — see §3).** Add one nullable
column to `plan_dispatch_attempts` and read one from `orchestrations`:
`ALTER TABLE plan_dispatch_attempts ADD COLUMN binding_status TEXT` with
`CHECK (binding_status IS NULL OR binding_status IN ('bound','legacy-unbound','quarantined-nonstandard-id'))`.
The ledger view surfaces `binding_status` so a null-bound legacy dispatch (a1bacc4a)
renders as `legacy-unbound` instead of silently vanishing from the join.

### 1.4 The single supported transition API

One function, in `src/main/plan-ledger.ts`, is the **only** writer of
`plan_work_packages.state`:

```ts
recordPackageTransition({
  workspaceId, planId, packageId, packageRevision,
  fromState, toState,          // validated: fromState must equal current row state
  actor, reason,
  evidence: {
    dispatchAttemptId?,        // required for ready→executing
    confirmedTurnId?,
    finalizationId?,           // REQUIRED for →done: the package_finalizations boundary
    commitOids?,               // REQUIRED for →done: ≥1, joined via commit_turn_links
    gateOutcome?,              // boundary_status snapshot
  }
}): TransitionResult
```

In one SQLite transaction it: (1) asserts `fromState === current` (optimistic
concurrency — reject on mismatch, never blind-write); (2) writes
`plan_work_packages.state` and `updated_at`; (3) appends a `plan_wp_lifecycle_events`
row (now able to carry `'done'`); (4) for `→done`, asserts a matching
`package_finalizations` row of the same `(package_id, revision)` exists with a
`checkpoint_oid` and that `commit_turn_links` carries ≥1 commit for the item —
**refusing to mark done a package with no witnessed commit.** That refusal is the
mechanical fix for "WP6-8 blocked after all landed" *and* its inverse ("done with
no commit").

**Enforcement that it is the *only* writer.** Two layers:
1. **Centralization + test guard** (ships now): route every existing
   `UPDATE plan_work_packages SET state` through the API; add a test that greps the
   `src/main/**` tree and fails if any `UPDATE plan_work_packages SET state` string
   exists outside `plan-ledger.ts`. (Same style as this repo's other
   grep-the-source invariants.)
2. **DB trigger (hardening, optional)**: a `BEFORE UPDATE OF state` trigger keyed to
   a per-transaction guard row in a `temp` table that only the accessor sets —
   mirrors the `turn_records_plan_stamp_immutable` trigger pattern (1623-1628) but
   admits the guarded path. List as hardening, not a blocker.

### 1.5 D1 acceptance — render from DB-only state, compare to the verified commit chain

A single env-gated acceptance test (`src/main/plan-ledger.acceptance.test.ts`):

1. **Seed the a1bacc4a failure shape** in a scratch DB: a plan with 11 packages,
   all `landed` (a `package_finalizations` boundary + `commit_turn_links` per item),
   but with `plan_work_packages.state` left at `blocked` for WP6-8 and null
   dispatch bindings — reproduce the exact reported gap.
2. **Run the forward path**: for each landed package call `recordPackageTransition`
   `→done` with its real finalization + commit evidence. Assert WP6-8 refuse to go
   done *without* evidence and succeed *with* it.
3. **Render DB-only**: call `renderPlanFromLedger(workspaceId, planId)` with **no
   filesystem read of `plan.json`**. Assert every landed package renders `done`
   with ≥1 commit OID, a non-null assignee (or an explicit `legacy-unbound`
   marker), and a deployment state (`pushed_remote_count`).
4. **Compare to the verified chain**: assert the set of commit OIDs the ledger
   attributes to the plan equals the independently verified commit chain (the 13
   commits), with none orphaned and none invented. This is the "compare against the
   verified commit chain" criterion, mechanized.

Passing this test *is* the proof that "the software can reconstruct its own history"
— the human-cross-references-six-places problem F2 names.

---

## 2. Decision D4 — plan-folder version-control policy

### 2.1 The decision: track the arguments, derive the machine state — uniform and enforced

Split by **authorship and mutation profile**, not by file type accident:

| Artifact | Policy | Rationale |
|---|---|---|
| `plan.md`, `ARC.md`, `OVERVIEW.md` | **git-tracked (required)** | human-authored, append-rarely, argument-of-record |
| `deliberations/*.md` | **git-tracked (required), ALL of them** | the winning synthesis carries the proof-bearing predicate F10 credits — losing it is the D4 defect |
| `supplements/*.md`, `research/*.md` (cleared) | **git-tracked (required)** | durable inputs; low churn |
| `plan.json` | **NOT git-tracked, by declared rule; durability from the D1 ledger** | machine projection of churn-heavy event state; git-tracking it creates a second mutable authority and merge conflicts in a shared tree |

**Why `plan.json` stays untracked *and that is now a decision, not an accident*:**

1. It holds "churn-heavy event appends" (the plan's own words, 302) — responsibility
   events, lifecycle transitions. In this repo **many agents share one working
   tree** (a core CLAUDE.md invariant); a per-plan mutable JSON that every dispatch
   appends to would generate constant cross-lane merge conflicts on a file no human
   reads.
2. Tracking it would make git a *second* authority for plan identity/lifecycle
   alongside the ledger — the exact "single run-state authority" principle the
   schema comments defend (1843-1846). Two authorities drift; the audit already
   found the drift.
3. Its durability is now **provable, not hand-waved**: D1 §1.5 renders full plan
   state from the DB. Add `projectPlanJson(workspaceId, planId)` to
   `src/main/plan-ledger.ts` that regenerates `plan.json` byte-for-content from
   `renderPlanFromLedger`. `plan.json` becomes a *cache*, stamped
   `"schema":"derived-from-ledger"` with a `"ledger_hash"` of the projection. If the
   file is lost, it is regenerated; if it diverges from the ledger, the hash
   mismatch is detectable.

This is the decision D4 demands "on the record": `plan.json` is untracked **because
the ledger is its source of truth**, not because a scaffold forgot to add it.

### 2.2 Make the untracked status a *rule*, not an omission

Add to the repo `.gitignore` (or a `.lares/plans/.gitignore`):

```
# Plan-folder machine projection — durability lives in the D1 ledger (plan_ce97b9ad).
# Regenerate with projectPlanJson(); never the source of truth. Decision: int_d1d47a05.
.lares/plans/**/plan.json
```

Now `git check-ignore` returns a *reason*, and the D4 "accident" is closed.

### 2.3 Backfill the tracked half (the winning arguments that have no history)

A worker executes, once:

1. `git add` every `.md` under `.lares/plans/*/{deliberations,supplements,research}/`
   that is currently untracked — **most importantly**
   `plan_5b3ea7d1/deliberations/2026-08-06-carry-forward-equivalence.md` (the active
   synthesis with no history) and `plan_e0001372`, `plan_65e665d7` untracked
   supplements/research surfaced by `git status`.
2. **Frozen-specimen caution:** the proposal's non-goal forbids *changing*
   `plan_5b3ea7d1`. `git add` of an unmodified file preserves content byte-for-byte
   (it changes only the index, never the working tree), so it does not violate the
   content freeze — but because the freeze is load-bearing audit evidence, the
   specimen's backfill `git add` is called out as a **separate, human-gated commit**
   with that reasoning in the message, not bundled into the automated sweep.
3. Never use `git rm`/`checkout`/`restore`/`clean` (CLAUDE.md worker rule). This is
   purely additive.

### 2.4 Enforce the policy so it stays uniform

New guard script **`.lares/scripts/plan-folder-tracking-guard.mjs`** (outside
`.claude/`, so non-interactive runs don't hang on the permission dialog):

- For each plan folder: assert every `*.md` is tracked (`git ls-files --error-unmatch`),
  and assert `plan.json` is **not** tracked (it must match the ignore rule).
- Emit a machine-readable diff of violations; exit non-zero on any.
- Wire it into the same save/CI hook that C1 (§C1 count-validation) and A2
  (freshness) use, so "which plan-folder artifacts are version-controlled" is
  checked, not remembered.

Acceptance for D4: running the guard across the current population (a) flags the
inverted `plan_5b3ea7d1` deliberations split before backfill and (b) passes after
backfill + `.gitignore` land, with `plan.json` reported as intentionally-ignored
rather than accidentally-untracked.

---

## 3. How D2 constrains this schema (without redesigning D2)

D2 owns *ingestion identity*; D1/D4 only need to be *shaped so D2 can enforce*. Three
constraints, all already accommodated above:

1. **Reject/quarantine non-contract IDs.** The ledger's identity keys —
   `plans.artifact_id` (`prop_[0-9a-f]{8}`), `plan_intents.intent_id`
   (`int_[0-9a-f]{8}`) — must be representable as *quarantined* rather than silently
   null-joined when malformed (`prop_0ed…`, `prop_pigt5a83`). The
   `binding_status = 'quarantined-nonstandard-id'` marker (§1.3c) is that seam: D2's
   ingestion sets it; the ledger view surfaces it. **No new identity column is
   invented here** — D2 decides the predicate; the ledger only carries the verdict.
2. **Backfill `source_proposal_id`.** Already a column (`plans.source_proposal_id`,
   1827) with a partial-unique index (1833). The ledger join (§1.2) reads it; D2's
   backfill populates it. The only D1 requirement: the render must not *fail* on a
   null `source_proposal_id` (legacy plans) — it renders `source: unknown`, not an
   error.
3. **Require `planning_intent_id` at launch.** `orchestrations.planning_intent_id`
   stays nullable at the *column* level (legacy rows exist), but D2 makes it
   **required for new dispatches**. The ledger encodes the consequence, not the
   enforcement: a dispatch whose orchestration has a null `planning_intent_id`
   renders `binding_status = 'legacy-unbound'`. New (post-D2) dispatches can never
   be `legacy-unbound` — that is D2's acceptance, visible through D1's view.

The clean division: **D2 decides *whether* an ID/binding is admissible; D1's schema
decides *how the verdict is represented and joined*; neither redefines the other.**

---

## 4. Sequencing, risk, and scope discipline

- **Order:** (1) `'done'` CHECK rebuild → (2) `recordPackageTransition` +
  centralize writers + grep-guard test → (3) `renderPlanFromLedger` +
  `continuation_handoff_results` → (4) `projectPlanJson` → (5) D4 `.gitignore` +
  backfill + tracking guard → (6) D1 acceptance test. Steps 1-2 are the load-bearing
  correctness fixes; 5 is independent and can land in parallel.
- **Depends on D3-recorder fixes only for inputs.** This ledger consumes the D3
  results but does not implement the checkpoint-coordinator repair — keep those in
  the D3 implementation package. If D3's continuation-results writers are not yet
  live, `continuation_handoff_results` simply stays empty; the ledger degrades
  gracefully.
- **Scope check against the disclosed conflict of interest.** The author is
  incentivized to oversize Cluster D. This draft *shrinks* D1 to "join + one API +
  three additive changes" by proving 80% of the tables already exist, and *bounds*
  D4 to "one ignore rule + one backfill + one guard." Net-new tables: **one**
  (`continuation_handoff_results`). Net-new columns: **one**
  (`binding_status`). That is the honest floor, not a rebuild.
- **F9 / no-deploy caveat travels:** the D1 acceptance asserts deployment state is
  *rendered* (`pushed_remote_count`), and on today's tree that value is 0 for all
  13 commits — the test asserts the ledger reports "not deployed" truthfully rather
  than assuming a push happened.

---

## 5. Decision summary

- **D1:** a canonical **read model** (`renderPlanFromLedger`) joining the *existing*
  `plan_work_packages / plan_dispatch_attempts / package_finalizations /
  commit_turn_links / commit_records / plan_intents / orchestrations` tables, plus a
  **single transition API** (`recordPackageTransition`) that is the sole writer of
  package state and refuses `→done` without a finalization boundary and ≥1 witnessed
  commit. Three additive schema changes: fix the `plan_wp_lifecycle_events` `'done'`
  gap, add `continuation_handoff_results` (keyed to `handoff_attempt_id`, never
  overloading `turn_records.status`), add a `binding_status` completeness marker.
  Acceptance: render the plan from DB-only state and prove its commit set equals the
  verified 13-commit chain.
- **D4:** **track all `.md`** (plan.md/ARC/OVERVIEW/deliberations/supplements/research),
  **do not track `plan.json`** — but by *declared `.gitignore` rule* with its
  durability sourced from the D1 ledger via `projectPlanJson`, backfilled and
  enforced by `plan-folder-tracking-guard.mjs`. The winning synthesis gets a git
  history; the churn-heavy machine projection becomes a regenerable cache of the
  ledger, not a shadow authority.
- **D2 seam:** the schema carries `binding_status` and reads existing
  `source_proposal_id` / `planning_intent_id` so D2's ingestion verdicts
  (reject/quarantine/require) are representable and joinable without D1 redefining
  D2's rules.
