---
plan_artifact_id: plan_ce97b9ad
intent_id: int_d1d47a05
kind: deliberation
---

# D1 + D4 synthesis — server-witnessed package ledger and plan-folder version-control policy

Two independent planners (Claude, Codex) converged on the architecture and, after two
exchange rounds, on the schema. This is the joint decision, resolved to worker-executable
edits. It is the design of record for intent `int_d1d47a05`.

**Decision in one paragraph.** SQLite is the authority for mutable *execution* facts
(package state, gates, commits, deployment, handoff results). Git is the authority for
*portable* plan artifacts (identity, lineage, responsibility history, prose,
deliberations). Do **not** build a greenfield monolithic ledger: join and strengthen the
tables that already exist (`plan_work_packages`, `plan_dispatch_attempts`,
`package_finalizations`, `commit_records`, `commit_turn_links`, `plan_intents`,
`orchestrations`, `plans`), add **four** normalized tables for the facts nothing currently
records, and route every package-state write through **one** main-process transition
service that witnesses evidence itself. Version-control **every** durable file in every
plan folder, **including `plan.json`**, exempting only enumerated lock/temp artifacts.

---

## 1. Where the two planners agree (converged)

1. Most infrastructure exists; strengthen-and-join, never copy into a monolith.
2. A canonical **DB-only projection** + **one** package-state transition service is the
   right architecture. The service is the sole writer of `plan_work_packages.state`.
3. `plan_wp_lifecycle_events` is rebuilt to admit `done` and becomes the single
   append-only state log (no separate replacement table needed).
4. `package_finalizations` stays the **boundary / frozen-manifest** evidence and is *not*
   duplicated — but it is **not** a gate-outcome table (see §3.1).
5. `commit_turn_links` + `commit_records` provide package↔commit **membership** once
   dispatch stamps `plan_item_id`; no separate general commit-membership table.
6. D3 handoff results are a **separate lifecycle** keyed to `handoff_attempt_id`, recorded
   through a sibling API, and **never** touch `turn_records.status`/quality/`failure_reason`.
7. D2 owns identity validation, quarantine, and backfill; D1 **consumes** D2's verdicts and
   never invents replacement identities. Legacy null-bound orchestration `a1bacc4a` stays
   unbound until an explicit reviewed D2 backfill — never joined by topic/path/time.
8. Acceptance is **DB-only** (filesystem reads made to fail) and compares against the
   independently verified 13-commit chain; deployment renders explicit `not_deployed`.
9. **Track `plan.json`** (D4). The earlier "gitignore + regenerate from ledger" idea is
   rejected (see §5.1).

---

## 2. Where they disagreed, and the resolution

| # | Dispute | Resolution | Why |
|---|---|---|---|
| 1 | Is `package_finalizations` the gate-outcome table? | **No.** Add `plan_package_gate_attempts` + `plan_package_gate_commit_links`. | `boundary_status ∈ {ready,unavailable,pruned}` is retention state, not pass/fail. Overloading it repeats the D3 mistake. |
| 2 | Is `pushed_remote_count` deployment state? | **No.** Add append-only `plan_package_deployment_events`. | The column is a cached remote-reachability hint; push ≠ deploy; it cannot express environment/deploying/failed/rolled-back/not-required. |
| 3 | Can the intent join form on `plan_work_packages`? | **No — it has no `intent_id`.** Add nullable `intent_id`, require for new work, validate against `plan_intents`. | The Claude draft's `⟕ plan_intents ON (plan_id,intent_id)` was unformable; `orchestrations.planning_intent_id` only covers orchestration-driven work. |
| 4 | Encode binding completeness as a `binding_status` column? | **No.** **Derive** binding state in the projection from actual joins; reuse D2's identity disposition if D2 persists one. | An independent mutable marker drifts from the columns it summarizes and doesn't classify `a1bacc4a`. |
| 5 | Did the missing `done` CHECK cause the historical gap? | **No** (verified: `finalization-service.ts`/`plan-ipc.ts:216` flip `done` directly). Still remove the CHECK for the new single-API design. | WP6–8 stayed blocked because the finalization path wasn't exercised and bindings/evidence were absent — not a SQLite rejection. Fixing the CHECK alone repairs nothing; the *service + bindings* do. |
| 6 | Make `plan.json` a DB-regenerable cache? | **No — track it.** | A clone carries no `.db`; `plan.json` is the folder-is-a-plan bootstrap signal; it holds full ordered `responsibility_events` the DB does not store (`plans` has only `responsible_supervisor_id`). Regeneration is a far larger design and creates a bootstrap cycle. |
| 7 | Track `*.md` only, or all durable files? | **All regular files**, exempting only enumerated ephemeral patterns. | A markdown-only rule leaves `.txt`/JSON/schema evidence unversioned (the population already has a research `.txt`). |
| 8 | Require ≥1 commit for every `done`? | **No.** Require the package's **declared delivery evidence by kind** (code→commits, research→output+gate, no-change→reviewed justification). Historical acceptance still joins all 13 commits. | A universal commit rule wrongly rejects no-change/research/externally-delivered packages. |
| 9 | Immutable `plan_package_revisions` table? | **Not for D1.** `plan_work_packages.revision` already bumps on content change and `package_finalizations` freezes revisioned boundaries. | Meets D1's stated acceptance without a new table; honors the author's disclosed incentive to *not* oversize Cluster D. |

**Net new tables: four.** `plan_package_gate_attempts`, `plan_package_gate_commit_links`,
`plan_package_deployment_events`, `continuation_handoff_result_events`. Everything else is
reuse + narrow extension.

---

## 3. D1 — schema

All new DDL goes in `src/main/database.ts` using the file's established idioms: `TEXT`
primary keys, epoch-ms `INTEGER` timestamps, `CHECK` constraints, **no cascade FKs on
evidence tables** (evidence must survive agent/plan deletion), guarded `ALTER` (SQLite has
no `ADD COLUMN IF NOT EXISTS`). Place the four tables in a new serialized slot after the
existing `plan_dispatch_attempts` block (currently ends ~line 2206). Add tests to
`src/main/database.*.test.ts`.

### 3.0 Reuse map (no schema change)

- `plans` — local plan row; `artifact_id`, `source_proposal_id`, `folder_rel_path`.
- `plan_intents (plan_id, intent_id)` — intent identity/lineage parent.
- `package_finalizations` — frozen boundary/manifest evidence; referenced by gate attempts.
- `commit_records (repository_key, commit_oid)` — canonical commit identity; **40-hex only**.
- `commit_turn_links (commit_oid, turn_id, plan_id, plan_item_id)` — package↔commit
  **membership** once dispatch stamps `plan_item_id`.
- `turn_records` — dispatched turn/session (`session_id`) evidence.
- `orchestrations` — sole run-state authority; `(plan_id, planning_intent_id)`.

### 3.1 New table — `plan_package_gate_attempts`

Gate outcomes (including the Cluster B production-entry gate, with retry history). Absence
is **unknown**, never success.

```sql
CREATE TABLE IF NOT EXISTS plan_package_gate_attempts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  plan_id            TEXT NOT NULL,
  plan_artifact_id   TEXT NOT NULL,
  intent_id          TEXT,
  package_id         TEXT NOT NULL,
  package_revision   INTEGER NOT NULL,
  gate_key           TEXT NOT NULL,          -- e.g. 'production-entry','review','acceptance'
  gate_revision      INTEGER NOT NULL DEFAULT 1,
  attempt_no         INTEGER NOT NULL,
  outcome            TEXT NOT NULL,          -- pending|passed|failed|cancelled
  finalization_id    TEXT,                   -- optional link to package_finalizations.id (evidence, not approval)
  witness_agent_id   TEXT,
  witness_session_id TEXT,
  witness_turn_id    TEXT,
  evidence_json      TEXT,
  decided_at         INTEGER,
  created_at         INTEGER NOT NULL,
  UNIQUE (package_id, package_revision, gate_key, attempt_no),
  CHECK (outcome IN ('pending','passed','failed','cancelled')),
  CHECK (package_revision > 0 AND gate_revision > 0 AND attempt_no > 0)
);
CREATE INDEX IF NOT EXISTS idx_gate_attempts_pkg
  ON plan_package_gate_attempts (package_id, package_revision, gate_key);
```

### 3.2 New table — `plan_package_gate_commit_links`

Which full commit OIDs a gate attempt actually **verified** (distinct from membership).

```sql
CREATE TABLE IF NOT EXISTS plan_package_gate_commit_links (
  gate_attempt_id  TEXT NOT NULL,
  repository_key   TEXT NOT NULL,
  commit_oid       TEXT NOT NULL,            -- 40-hex; references commit_records
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (gate_attempt_id, repository_key, commit_oid),
  CHECK (length(commit_oid) = 40)
);
```

### 3.3 New table — `plan_package_deployment_events`

Append-only; current state = latest event per `(package_id, package_revision,
environment)`. Null (no row) = **unknown**, not `not_required`.

```sql
CREATE TABLE IF NOT EXISTS plan_package_deployment_events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  plan_id            TEXT NOT NULL,
  package_id         TEXT NOT NULL,
  package_revision   INTEGER NOT NULL,
  environment        TEXT NOT NULL,          -- 'production','staging','local-electron-acceptance',...
  state              TEXT NOT NULL,          -- not_required|not_deployed|deploying|deployed|failed|rolled_back
  repository_key     TEXT,
  commit_oid         TEXT,                   -- 40-hex when present
  witness_agent_id   TEXT,
  witness_session_id TEXT,
  detail_json        TEXT,
  occurred_at        INTEGER NOT NULL,
  CHECK (state IN ('not_required','not_deployed','deploying','deployed','failed','rolled_back')),
  CHECK (commit_oid IS NULL OR length(commit_oid) = 40),
  CHECK (package_revision > 0)
);
CREATE INDEX IF NOT EXISTS idx_deploy_events_pkg
  ON plan_package_deployment_events (package_id, package_revision, environment, occurred_at);
```

### 3.4 New table — `continuation_handoff_result_events`

The D3 fix output. Keyed to `handoff_attempt_id`; **never** updates checkpoint-turn status.
Place next to the other continuation tables (`src/main/database.ts` ~line 262, after
`continuation_deferrals`).

```sql
CREATE TABLE IF NOT EXISTS continuation_handoff_result_events (
  id                   TEXT PRIMARY KEY,
  handoff_attempt_id   TEXT NOT NULL,        -- FK-by-value to continuation_handoff_attempts.id (no cascade)
  result_kind          TEXT NOT NULL,        -- brick_saved|successor_started|successor_oriented
  outcome              TEXT NOT NULL,        -- succeeded|failed|timed_out
  dashboard_agent_id   TEXT NOT NULL,
  generation           INTEGER NOT NULL,
  brick_id             TEXT,                 -- brick_saved
  source_session_id    TEXT,
  successor_session_id TEXT,                 -- successor_started/_oriented
  kickoff_turn_id      TEXT,                 -- successor_oriented
  completion_quality   TEXT,
  detail_json          TEXT,
  witnessed_at         INTEGER NOT NULL,
  CHECK (result_kind IN ('brick_saved','successor_started','successor_oriented')),
  CHECK (outcome IN ('succeeded','failed','timed_out'))
);
CREATE INDEX IF NOT EXISTS idx_handoff_results_attempt
  ON continuation_handoff_result_events (handoff_attempt_id, result_kind, witnessed_at);
```

Recording seams (from the D3 forensic, lines 164–184): `brick_saved` only after the
tool-sourced brick row is durably inserted; `successor_started` only after the runner-launch
**tail** reports the new session live (not when the relaunch route accepts); `successor_oriented`
only after the attempt-correlated kickoff turn completes — record `failed`/`timed_out`
explicitly otherwise. The append-only + `(attempt, kind, witnessed_at)` key lets a timeout be
followed by a later success without rewriting history.

### 3.5 Extensions to existing tables (guarded `ALTER`)

**`plan_work_packages`** — add the missing package-side intent key:

```js
try { db.exec(`ALTER TABLE plan_work_packages ADD COLUMN intent_id TEXT`); } catch { /* exists */ }
```

Nullable for legacy rows; **required for new execution** and validated against
`plan_intents(plan_id, intent_id)` inside the transition service (§4). Never silently null
for new work.

**`plan_dispatch_attempts`** — freeze the dispatched revision and correlate the session:

```js
try { db.exec(`ALTER TABLE plan_dispatch_attempts ADD COLUMN package_revision INTEGER`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE plan_dispatch_attempts ADD COLUMN orchestration_id TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE plan_dispatch_attempts ADD COLUMN target_session_id TEXT`); } catch { /* exists */ }
```

`package_revision` freezes the exact revision dispatched. `target_session_id` is filled at
confirmation when known; otherwise the projection derives the session via
`confirmed_turn_id → turn_records.session_id`. When `orchestration_id` is present the
service asserts its `(plan_id, planning_intent_id)` matches the dispatch's plan/intent. Do
**not** infer delivery or package state from `confirmed_turn_id`'s terminal status.

**`plan_wp_lifecycle_events`** — rebuild to admit `done`. SQLite cannot `ALTER` a CHECK and
the table has live rows, so use the standard 12-step rebuild at the existing block
(~line 2131):

1. `CREATE TABLE plan_wp_lifecycle_events__new (...)` identical to the current definition
   except `CHECK (to_state IN ('ready','executing','blocked','done','archived'))`.
2. `INSERT INTO plan_wp_lifecycle_events__new SELECT * FROM plan_wp_lifecycle_events;`
3. `DROP TABLE plan_wp_lifecycle_events;`
4. `ALTER TABLE plan_wp_lifecycle_events__new RENAME TO plan_wp_lifecycle_events;`
5. Recreate `idx_plan_wp_lifecycle_pkg` and `idx_plan_wp_lifecycle_plan`.

Guard the rebuild so it runs at most once (probe whether a `to_state='done'` insert is
already accepted in a rolled-back savepoint; skip if so). This table remains the **single
append-only state log**; `done` is now recordable here rather than only implied by a
finalization flip.

**`plans`** — *optional hardening, not required*: `CREATE UNIQUE INDEX idx_plans_id_artifact
ON plans(id, artifact_id) WHERE artifact_id IS NOT NULL` to allow identity-checking
composite FKs from future ledger rows. Deferred: the existing schema treats `artifact_id`
as lineage, not identity, and `plan_id` is already FK-enforced.

---

## 4. D1 — the single supported transition service

New file **`src/main/plans/package-ledger.ts`** (+ `package-ledger.test.ts`). A
main-process service, **not** a general SQL/IPC patch endpoint.

```ts
transitionPlanPackage(command, witness): TransitionResult
```

- **Closed command union:** `dispatch-confirmed | block | unblock | gate-decided |
  commits-observed | deployment-observed | complete | reopen | archive`. Each command
  carries an **idempotency key**; replay returns the prior result; conflicting reuse fails.
- **The service witnesses evidence itself.** No renderer/caller may submit a trusted gate
  outcome, session id, commit existence, or deployment success; the relevant main-process
  subsystem observes the fact and calls the service. (This is the F1 lesson — trust the
  production-witnessed path, not a caller's claim.)
- **One SQLite transaction per command:** resolve + validate `(workspace_id, plan_id,
  plan_artifact_id, intent_id, package_id, package_revision)` agree on one row; insert the
  command's evidence rows (gate attempt, commit links, deployment event, dispatch
  confirmation); validate the legal state edge and its prerequisites; append **one**
  `plan_wp_lifecycle_events` row iff state changes; and update `plan_work_packages` as a
  **projection** (never an independent authority).
- **`complete` (→done) prerequisites**, by package kind (§2 row 8):
  - *code/file package*: a confirmed dispatch where required; all required gates `passed`
    (latest attempt per `gate_key`); every declared **implementation** commit present in
    `commit_records` and covered by a passed required gate; a `ready`/`committed`
    `package_finalizations` boundary as its kind requires; an explicit deployment state.
  - *artifact/research package*: durable output identity + gate evidence.
  - *no-change package*: an explicit reviewed justification recorded as evidence.
  A `failed` gate moves `executing → blocked`; a later `passed` retry does **not** erase the
  recorded failure.

**Enforcement that it is the only writer.** Route the three existing direct writers through
the service and delete their inline `state` writes:
- `src/main/database.ts:5538` (`UPDATE plan_work_packages SET state = ?, updated_at = ?`) —
  becomes an internal projection helper the service calls, not a public accessor.
- `src/main/database.ts:6520` (revision bump on content drift) — keep the revision bump; it
  is not a *state* transition, but move any accompanying state change into the service.
- `src/main/commit-candidates/finalization-service.ts` and `src/main/plans/plan-ipc.ts:216`
  (the finalization `done` flip) — the finalization txn now calls the service's `complete`
  path so `done` is gated by evidence, not flipped unconditionally.
Add a source-guard test that greps `src/main/**` and fails if any `UPDATE plan_work_packages
SET state` (or equivalent state mutation) exists outside `package-ledger.ts`. Handoff
results use a sibling **`recordHandoffResult(...)`** in the same file — a *different*
lifecycle, sharing no state vocabulary, so the D3 overloading bug cannot recur.

---

## 5. D2 seam (schema-shaping only; D2 is not redesigned here)

D1 consumes D2's postconditions:

- `plans.artifact_id` matches `plan_[0-9a-f]{8}` and `source_proposal_id` points at a
  valid, non-quarantined `prop_[0-9a-f]{8}` row **before** a package can be dispatched or
  completed.
- `plan_work_packages.intent_id` (§3.5) matches `int_[0-9a-f]{8}` and exists in
  `plan_intents` for the same plan; dispatch/launch **reject** a missing/mismatched intent
  rather than writing null.
- New orchestration launches require both `plan_id` and `planning_intent_id`. `a1bacc4a`
  stays historical evidence, linked only by explicit reviewed backfill.
- **Binding completeness is derived, not stored** (§2 row 4): the projection computes
  `bound` from successful joins, `legacy-unbound` from missing legacy bindings, and
  `quarantined` from D2's authoritative disposition (reuse D2's field if it persists one;
  do not add an independent mutable marker).

---

## 6. D4 — plan-folder version-control policy

### 6.1 Decision: track every durable file, including `plan.json`

`plan.json` is git-tracked. Rationale settled across both planners: a clone carries no
`.db`; the plan-folder watcher (`src/main/plans/plan-folder-watcher.ts`) adopts a folder as
a plan only when it holds a valid `plan.json`; and `plan.json` stores the full ordered
`responsibility_events` history that SQLite does not (verified: `plans` persists only
`responsible_supervisor_id`; the manifest history lives in `plan-manifest.ts`). Tracking it
does **not** create a second execution-state authority, because `plan.json` carries
**identity, source-proposal identity, intent lineage, and responsibility history only** —
never package/gate/commit/deployment state, which SQLite owns. The existing CAS/lock write
path already handles concurrent appends, so the shared-working-tree concern is addressed
without hiding the file.

**Field boundary (enforced by review, and by §6.2's scaffold contract):**
- **`plan.json` (tracked, portable):** `artifact_id`, `source_proposal_id`, intent lineage,
  folder identity, `responsibility_events` (full ordered history), creation metadata.
- **SQLite ledger (not in git):** package state, gate attempts, commit links, deployment
  events, per-turn execution facts.
Neither `plan.json` nor `ARC.md` may duplicate package/gate/commit/deployment status.

### 6.2 Enforcement

1. **`.gitignore`** — add anchored ignores for **only** the ephemeral siblings, both
   state-dir roots:
   ```
   /.lares/plans/*/plan.json.lock*
   /.lares/plans/*/plan.json.wtmp-*
   /.dashboard/plans/*/plan.json.lock*
   /.dashboard/plans/*/plan.json.wtmp-*
   ```
   Do **not** ignore `plan.json` or any plan subdirectory.
2. **Checker** — new `scripts/check-plan-folder-versioning.mjs` (repo `scripts/`, outside
   `.claude/` so non-interactive runs don't hang). It enumerates regular files under both
   plan roots, classifies only the enumerated ephemeral patterns as local, runs
   `git ls-files --error-unmatch` for every durable file, and prints a deterministic
   tracked/untracked report. `--check` exits non-zero on: an untracked durable file, a
   tracked ephemeral file, a missing tracked file, or a plan folder lacking a tracked valid
   `plan.json`.
3. **Tests** — `scripts/check-plan-folder-versioning.test.mjs` covering the
   superseded-draft-vs-winning-synthesis case, untracked `plan.json`, lock/temp exemptions,
   paths with spaces, and the `.dashboard` fallback.
4. **Wire it in** — add an npm script (`"check:plan-versioning"`) and a CI invocation.
5. **Scaffold contract** — update `src/main/plans/plan-manifest.ts` (and `plan-manifest.mjs`
   if present) plus the mirrored scaffold constants in `src/shared/constants.ts` to state
   that every durable created artifact must be included in its owning commit. **Bump every
   affected scaffold version and retain cumulative `previousHashes`** (per the
   `scaffold-content-needs-version-bump` and `scaffold-previoushashes-cumulative` lessons) —
   do not silently rewrite deployed workspaces.

### 6.3 Migration of the current population (careful; shared working tree)

Survey fact: 8 plan folders, 72 files, 25 tracked, 47 untracked; **all `plan.json`
untracked**; no ignore rule (split is accidental). Two `ARC.md` files
(`...-5b3ea7d1/ARC.md`, `...-65e665d7/ARC.md`) carry **uncommitted local modifications**.

Execute as **one dedicated reviewed commit**, not a wholesale add:

1. Inspect `git status --short --untracked-files=all -- .lares/plans` and the two modified
   `ARC.md` diffs first. **Preserve** those foreign edits — never `git checkout`/`restore`/
   `clean`/`stash` (worker rule). If a modified `ARC.md` is not yours, do not fold your
   commit over its content; stage it separately or leave it and surface it.
2. Stage an **explicit file manifest** (each durable path listed), not `.lares/plans/**`.
   Include every valid durable artifact — in particular every `plan.json`, the active
   synthesis `...-5b3ea7d1/deliberations/2026-08-06-carry-forward-equivalence.md`, both
   folded `plan_ce97b9ad` research reports, and all deliberations/supplements/research —
   excluding only proven lock/temp material.
3. **Frozen-specimen note:** `git add` of an unmodified `plan_5b3ea7d1` file changes only
   the index, not the working tree, so it does not violate the content freeze. Because the
   freeze is load-bearing audit evidence, stage the specimen's files in this same reviewed
   commit with that reasoning in the message; do not edit specimen content.
4. Run `scripts/check-plan-folder-versioning.mjs --check` against the prepared index
   **before** committing; it must pass.

---

## 7. D1 acceptance

Two layers.

**7a. Fast deterministic gate (synthetic).** In `src/main/plans/package-ledger.acceptance.test.ts`,
seed a scratch DB reproducing the a1bacc4a shape: a plan with 11 packages, all landed
(finalization boundary + `commit_turn_links` membership per package) but with WP6–8 left
`blocked` and null bindings. Assert: (i) WP6–8 refuse `complete` without evidence and
succeed with it; (ii) `renderPlanFromLedger` — reading SQLite only — shows all 11 `done`
with commit OIDs, derived binding state, and an explicit deployment state; (iii) a failed
gate followed by a passed retry preserves the failure row.

**7b. Historical DB-only comparison (the intent's required acceptance).** Build a reviewed
historical fixture for `plan_5b3ea7d1` from evidence (not heuristics): 11 package
revisions, dispatch agents/sessions where **proven**, gate attempts, explicit `not_deployed`
deployment events, and the case-study implementation commits. **Resolve each commit OID with
`git rev-parse`** (do not trust any abbreviated value handed forward; reject
ambiguous/missing objects; store only 40-hex). Acceptance passes only when:

1. the plan renders with the plan folder temporarily unavailable and filesystem reads
   configured to fail (proves DB-only);
2. the projection reports all 11 packages complete — not WP6–8 blocked — while preserving
   every historical failed/retried gate;
3. the ordered package implementation-commit union equals the independently verified
   13-commit chain **exactly** — no missing, extra, abbreviated, or duplicate OID — and
   every implementation OID is covered by a passed required gate;
4. `e52ad5fb` is visibly associated with the **failed/incomplete** production-entry proof
   and `b4617499` with the **correcting** gate/commit evidence (the F1/B4 story);
5. `a1bacc4a` is **not** silently attributed — it remains unbound pending explicit D2
   backfill;
6. D3 fixtures independently show `brick_saved`, `successor_started`, `successor_oriented`
   for one attempt while the note turn stays normally `accepted`, plus a partial-failure
   case for each boundary; and
7. `scripts/check-plan-folder-versioning.mjs --check` passes with every durable artifact
   tracked and only lock/temp exempt.

Deployment state must remain visibly `not_deployed` (F9): do **not** launch or restart the
Electron app as part of this package unless separately authorized.

---

## 8. File-level implementation plan (sequenced)

Order is load-bearing: correctness-critical joins/authority first, refinements after.

1. **Schema + migration** — `src/main/database.ts`, `src/main/database.*.test.ts`. Add the
   four tables (§3.1–3.4), the guarded `ALTER`s and lifecycle CHECK rebuild (§3.5), row
   mappers, append-only accessors, full-OID (40-hex) validation, and DB-only projection
   queries. Backfill `intent_id`/`package_revision` for existing rows where derivable;
   leave null (legacy-unbound) otherwise.
2. **Transition service** — new `src/main/plans/package-ledger.ts` + `package-ledger.test.ts`
   (§4). Command union, state machine, per-kind `complete` prerequisites, idempotency,
   self-witnessed evidence, atomic projection. Add the source-guard test proving no
   production call site writes `plan_work_packages.state` outside the service.
3. **Route existing writers through the service** — `src/main/database.ts:5538,6520`,
   `src/main/commit-candidates/finalization-service.ts`,
   `src/main/plans/plan-ipc.ts`, and dispatch wiring. Remove inline state writes; the
   finalization `done` flip now enters via `complete`.
4. **Gate + deployment ingestion** — new `src/main/plans/package-gates.ts` and
   `package-deployments.ts` (+ tests). Validate server-witnessed evidence and call the sole
   transition API. Until a real deployment adapter exists, record explicit
   `not_deployed`/`not_required`; never infer deployment from commit reachability.
5. **D3 handoff results** — `src/main/database.ts` (§3.4), `recordHandoffResult` in
   `package-ledger.ts`, and the three witness seams in
   `src/main/supervisor/continuation-watcher.ts` + `src/main/supervisor/index.ts`. Land
   alongside D3's compare-and-delete, serialize-behind-close, and unbounded-reconciliation
   fixes; assert checkpoint-turn status is untouched.
6. **DB-only read surface** — new `src/main/plans/plan-ledger-projection.ts`,
   `src/main/plans/plan-ipc.ts`, `src/preload/index.ts`, shared types, and Mission Board
   components/tests. Return plan identity, source proposal, intent, revision,
   dispatch/agent/session, gate attempts, ordered commit chain, deployment state, derived
   binding state, and state history — from SQLite only. Add a test that throws on any
   filesystem read to prove DB-only.
7. **D4 versioning** — `.gitignore`, `scripts/check-plan-folder-versioning.{mjs,test.mjs}`,
   `package.json`, CI, scaffold constants/manifest (with version bump + cumulative
   `previousHashes`), and the single reviewed plan-population migration commit (§6.3). This
   step is independent of 1–6 and may proceed in parallel.

**Verification:** run the new database/service/projection/D3/versioning tests, the full
sibling plan and continuation suites, `npm run build`, and the DB-only historical
acceptance fixture (§7). Do not restart Electron unless separately authorized.

---

## 9. Scope note (author conflict of interest)

The proposal discloses that its author is incentivized to *oversize* Cluster D. This design
lands **four** new tables and four narrow column additions — down from an initial
seven-table proposal — by proving most infrastructure already exists and reusing the
witnessed `commit_turn_links`/`package_finalizations` paths. Each new table is forced by an
evidenced fact nothing currently records (gate pass/fail history, gate→commit verification,
deployment as distinct from push, handoff results as a separate lifecycle). The immutable
package-revision table and `plans(id, artifact_id)` composite-FK hardening were considered
and **deferred** as not required for the stated acceptance. That is the honest floor for a
long-lived schema commitment: normalized enough to be right the first time, no larger.


<!-- groupthink_run: 9a5148f5 (mode=parallel) -->
