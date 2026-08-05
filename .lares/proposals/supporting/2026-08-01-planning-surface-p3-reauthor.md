# Planning-surface Stage P3 RE-AUTHOR — promotion service as dispatchable worker packages

**Status:** ACTIVE — **UNBLOCKED, dispatchable** (execution GO still pending with Edward). Both
named decisions were **RESOLVED by Edward on 2026-08-02** via selection comments; this revision
folds the rulings in and deletes the rejected branches. This closes BLOCKER-2 of
`.lares/proposals/supporting/2026-08-01-planning-surface-holistic-review.md`.

- **BLOCK-1 — §P3-GAP: RESOLVED (neither framed option).** Edward: *"i was under the impression
  that the human would never be promoting which documents are part of the plan — its the planning
  activity and the documents it emits that are part of the plan."* The ruling removes the premise
  of both options: there is **no promote-time document selection at all** — the parent P3C/P3A
  supervisor-chosen checklist contract is REVOKED. The plan's documents are the **planning
  activity's emissions**: the §R0 folder is the document set (disk truth, ruling 10), and
  `plan_documents` carries only the source-proposal link. Settled contract in **§P3-GAP
  (resolution)**; `selectedDocRelPaths`, the PromoteDialog doc checklist, and **WP-P3C-cand** are
  **deleted** from P3.
- **BLOCK-2 — §P3-MANIFEST-LOCK: RESOLVED (approved).** Edward approved ("ok this could work") the
  recommended **sidecar lockfile protocol** — owner identity + heartbeat + stale-lock reclaim —
  with the **skill's shipped helper script as the skill-side owner** (Amendment 25 blesses skill
  scripts; agents never hand-edit `plan.json`; they call the script, the script takes the lock).
  Settled protocol in **§P3-MANIFEST-LOCK (resolution)**; `WP-P3-manifest` is **dispatchable**.

All briefs below are dispatchable, gated only by the ordinary dependency graph and Edward's
execution GO.

This document fixes **BLOCKER-2** and **IMPORTANT-3** of the holistic review by re-authoring parent
Stage **P3** into concrete, self-contained, worker-dispatchable packages matching the settled
**§R-P3 / §R-A2** design of
`.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`.

**Bounded scope.** Re-authors **only Stage P3** (stage frame + WP-P3A/WP-P3B/WP-P3C + P3Z + graph)
of `.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md`. It **packages**
the already-settled 12-point §R-P3 design and the §R-A2 `promotion_requests` DDL — it does **not
redesign** them. **No changes** to P0/P1/P2/P2L or P4/P5/P6/P7/P8, Gate K, the git join, or the
bundle contract (wire v1, doc rev 3).

**Authority.** Subordinate to revamp **Amendments II rulings 10 through 25** and to
**§R-P3 / §R-A2 / §R0 / §R1 / §R-ATTR** of the P0–P2 rescope, which are **NORMATIVE and settled**.
Where this document restates §R-P3, §R-P3 governs. This document **supersedes** the P3 stage text of
the parent plan where they conflict (see the supersession map); parent P3 text not restated here is
replaced by the stage frame below.

**Anchor policy.** Symbolic anchors (file / function / table / constant names) are authoritative;
line numbers are orientation only — this repo is actively edited and numeric anchors drift.

**Per-WP shape.** Every package lists **Files · Dep · Do · Accept · Non-goals · Verify** and fits one
worker context. Verify templates follow parent §0.1 / rescope §Per-WP shape:

```powershell
# Main/shared single test
npm run build:main
node dist/main/<compiled-test-path>.js
# Renderer single test
npx vitest run --config vitest.config.ts <renderer-test-file>
# Full main suite
npm run test:supervisor
```

Every new main/shared test registers in `scripts/run-main-tests.mjs`; the **P3Z** gate owns that
registry edit so parallel P3 WPs never contend. A DDL/service worker must additionally run its own
sibling DB test directly (`node dist/main/…`) before P3Z registers it — do not wait on P3Z for
first-pass verification.

---

## ★ CRITICAL — two distinct dispatch kinds; do not conflate ★

The parent P3 text says "no auto-dispatch on promote (Implement is P5)." Read literally that forbids
the dispatch §R-P3 now requires. **It never meant that.** Two different dispatch kinds exist; every
no-auto-dispatch site must name which it means:

- **PLANNING / HARDENING dispatch — ALLOWED at promote (Amendment 10; rulings 23 through 25).**
  Promotion **runs the planning skill**: it dispatches a supervised **planning/hardening worker** that
  executes the `proposal-to-plan` skill journey (scaffold/orient → scope **with a worker-lane
  implementability/size opinion** → mark intent → deliberate → integrate → harden → package). The
  worker's **first mechanical act is atomic scaffold creation** (Amendment 10). This worker authors
  plan documents; it launches **nothing onto the plan's work packages**.

- **EXECUTION dispatch — FORBIDDEN until the human Implement trigger (Amendment 1c).** Dispatching
  workers **onto a plan's work packages** to implement them is gated behind the explicit human
  "Implement" action in **Stage P5**. Promotion never pulls that trigger, never launches an execution
  worker, never bulk-mutates `agents.plan_id`.

**Rule for every previously-"no-dispatch" site:** replace "no auto-dispatch on promote (Implement is
P5)" with the explicit pair — *"promotion dispatches the **planning/hardening** worker (Amendment 10);
it does **not** dispatch **execution** onto the plan — that is gated behind the human Implement
trigger in P5 (Amendment 1c)."* Repeated in the stage frame, WP-P3B-core, WP-P3-reconcile, WP-P3C′,
and P3Z.

---

## Supersession map (parent P3 → this re-author)

| Parent P3 element | Status | Replacement |
|---|---|---|
| **P3 stage frame** (non-goals + acceptance; "no HTML," synchronous) | **SUPERSEDED** | Rewritten stage frame — async, filesystem-first, dispatch-bearing |
| **WP-P3A** (responsibility + doc-link + tab-overview DDL) | **SUPERSEDED** | **WP-P3A′** — same DDL **plus** `promotion_requests` (§R-A2) in the one P3A slot (fixes IMPORTANT-3) |
| **WP-P3B** (synchronous, *"one SQLite transaction, no filesystem write,"* `proposal_id`+unique = idempotency key) | **SUPERSEDED verbatim** | **WP-P3B-core** + **WP-P3B-enrich** (mandatory split; jointly the re-authored WP-P3B contract) + **WP-P3-manifest** (CAS seam) + **WP-P3-reconcile** (§R-P3 point 6) |
| **WP-P3C-cand** (link-candidate service) | **DELETED (BLOCK-1 ruling)** | No consumer — the promote-time doc checklist it fed no longer exists. If the P4 doc home needs external-doc link candidates, it re-enters there as a P4 package. |
| **WP-P3C** (Promote IPC + PromoteDialog); Non-goal *"no auto-dispatch on promote"* | **AMENDED** | **WP-P3C′** — supervisor picker + async `PromoteProposalResult` + concrete `proposal:promotionStatus`; Non-goal re-stated per the CRITICAL box |
| **P3Z** (bare gate) | **SUPERSEDED** | Expanded **P3Z** — all P3 tests + crash-recovery matrix + no-execution-dispatch assertion + sole-proposal-row `plan_documents` guard |
| **P3 stage graph** | **SUPERSEDED** | New arrowed graph with the split + new nodes + P2B-folder adopt edge |
| *(new)* | **NEW** | **WP-P3-manifest** — `src/main/plans/plan-manifest.ts` no-clobber CAS seam (BLOCKED by §P3-MANIFEST-LOCK) |
| *(new)* | **NEW** | **WP-P3-reconcile** — pending-promotion startup reconstruction (§R-P3 point 6) |

`plans.responsible_supervisor_id`, `supervisor_active_plan`, `plan_documents`, `plan_tab_overviews`
DDL stay in the P3A slot exactly as parent — only `promotion_requests` is added. No P0–P2/P2L/P4–P8
element is touched.

---

## §R-A2 note (no change; restated)

`promotion_requests` lands **inside P3A's already-serialized A2 slot** — guarded
`CREATE TABLE IF NOT EXISTS`, never concurrent DDL, rebased onto the current `initDatabase()` head. It
serializes against the existing Save-card + planning slots (`SC-WP-2A/2D/2F/2G/3A/3B/4C`,
`P2A/P3A/P4D-reply/P5A-*/P5B/P5C/P5-dispatch/P8F`; the P8F `DROP` exception untouched). The DDL body is
frozen by §R-A2 and reproduced in WP-P3A′; a worker must not alter its columns, constraints, or the
`UNIQUE(workspace_id, proposal_artifact_id)` de-dup key. The BLOCK-1 ruling adds **no** DDL — no
selection field/table exists (see §P3-GAP resolution).

---

## §P3-GAP (RESOLVED 2026-08-02) — there is no promote-time document selection

**Edward's ruling (verbatim, selection comment, 2026-08-02):** *"i was undeer the impression that
the human would never be promoting which docuemnts are part of the plan its the planning acticity
and the documetns it emitts that are part of the plan."*

The ruling removes the premise of both previously framed options (A: durable selection table /
B: non-authoritative seed + derivation): **the supervisor-chosen document checklist was never the
product contract.** The parent P3C/P3A checklist language is REVOKED. **A plan's documents are the
planning activity's emissions**, and §R0 already gives those a mechanical home — the plan folder
(`plan.md`, `ARC.md`, `deliberations/`, `research/`, `supplements/`) is **disk truth** (ruling 10).

**Settled contract (normative for every P3 brief):**

1. **No selection surface exists.** PromoteDialog carries **no document checklist**;
   `proposal:promote` takes `{ proposalId, supervisorId }` only; `selectedDocRelPaths` is deleted
   from the IPC, the dispatch bootstrap, and every brief. **WP-P3C-cand is deleted** (its sole
   consumer was the checklist; if the P4 doc home needs external-doc link candidates, that is a P4
   package).
2. **The folder is the document set.** Folder-internal documents are **never mirrored into
   `plan_documents`** — readers use the WP-P1A bounded folder manifest / WP-P2C projection ("the
   folder, never `plans.path`"), so the document set tracks the planning activity's emissions
   live, with zero drift and no sync machinery. The `doc_kind` enum is unchanged (the
   `supplements/`-has-no-kind problem vanishes with the mirroring).
3. **`plan_documents` carries exactly one enrichment-time row:** the **source proposal**
   (`rel_path` from `plan.json.source_proposal.rel_path`, containment-checked, rel-path only,
   `doc_kind='proposal'`) — matching §R0's "linked via `plan_documents`" language. WP-P3B-enrich
   writes this row idempotently inside its DB transaction; nothing else writes `plan_documents`
   in P3.
4. **Later external emissions** (documents the planning activity incorporates that live outside
   the folder) are the planning activity's to record and the P4 doc home's to surface — out of P3
   scope; P3 briefs must not add machinery for them.
5. **No DDL change** — no selection field/table enters the A2 slot.

---

## §P3-MANIFEST-LOCK (RESOLVED 2026-08-02) — sidecar lockfile protocol for `plan.json`

**Edward approved the recommended protocol** ("ok this could work"): a **sidecar lockfile with
owner identity + heartbeat + stale-lock reclaim**, with the **skill's shipped helper script as the
skill-side owner** — Amendment 25 explicitly blesses skill scripts; the planning agent never
hand-edits `plan.json`, it calls the helper, the helper takes the lock.

**Settled protocol (normative; implemented verbatim by BOTH sides — service `plan-manifest.ts` and
the skill helper script):**

- **Lock path:** `<plan-folder>/plan.json.lock`, sibling of `plan.json`.
- **Acquire:** atomic exclusive create (`fs.open(…, 'wx')`) writing
  `{ owner_kind: 'service' | 'skill', owner_id, pid, nonce, acquired_at, heartbeat_at }`. Bounded
  retry with backoff on contention; exhaustion is a **clean error** (the skill helper reports it;
  the service retries later via its normal retry/reconcile paths).
- **Heartbeat:** the holder atomically rewrites `heartbeat_at` (temp-write + rename) every
  `PLAN_LOCK_HEARTBEAT_MS` (default 2000) while the mutation is in flight. A healthy holder renews
  indefinitely — there is no hard TTL on a live owner.
- **Stale reclaim:** a contender may reclaim only when
  `now − heartbeat_at > PLAN_LOCK_STALE_MS` (default 15000, several heartbeats). Reclaim is
  **rename-based, race-safe**: atomically rename the stale lock to a tombstone
  (`plan.json.lock.stale-<nonce>`), then perform a fresh exclusive create — a losing racer's
  rename/create fails cleanly and it re-enters acquire. Tombstones are best-effort deleted after
  reclaim.
- **Release:** the holder verifies its own `nonce`, then deletes the lock.
- **Mutation inside the lock:** the existing discipline is retained unchanged — read → verify
  expected hash → transform → temp-write → fsync → atomic rename, preserving concurrent
  `responsibility_events`; the lock is what removes the cross-process check-to-rename window the
  CAS alone could not close. This protocol is the settled implementation of §R-P3's
  "no-clobber CAS discipline."
- **Skill-side owner assignment:** the helper script shipped by **WP-P0A** (deployed via WP-P0C).
  Its P0A brief must carry this protocol verbatim at dispatch time — a coordinated contract, not a
  P3-owned edit of the skill.

**`WP-P3-manifest` is dispatchable.** Its Do/Accept below are updated to require the lock protocol;
the optimistic-CAS-only baseline remains documented as the in-lock mutation discipline, not as the
cross-process answer.

---

## Rewritten P3 stage frame

## STAGE P3 (re-authored) — promotion SERVICE: dispatch → worker-scaffold → watcher-adopt → enrich

**Order of operations (implements §R-P3's filesystem-first requirement):** the service first persists
**request + orchestration identity**, then **delivers** the planning worker; the worker's **first
mechanical act is atomic scaffold creation**; the P2 folder watcher **adopts** the folder; the service
(or reconciler, or retry) **enriches** the adopted row. Scaffold still precedes DB plan enrichment —
"**DB succeeds first is NOT a valid ordering**" (§R-P3 point 3).

**Stage non-goals:**

- **No HTML file minted** (Amendment 1).
- **No EXECUTION dispatch onto work packages** — the human **Implement** trigger in **P5**
  (Amendment 1c). Promotion **does** dispatch the **planning/hardening** worker (Amendment 10; see the
  CRITICAL box). Different dispatch kinds.
- No mission board; no bulk-mutation of `agents.plan_id`.
- **The service writes no plan-folder scaffold bytes** — the dispatched worker scaffolds via the
  skill. The service owns *identity, de-dup, dispatch, post-adoption enrichment*, and the service-side
  `plan.json` responsibility-event CAS — not the scaffold.

**Stage user-visible acceptance:** promoting a proposal **dispatches the planning-lane worker**
(Amendment 10) against a deterministic plan identity; the worker atomically scaffolds a §R0-valid
folder; the P2 folder watcher adopts it; the service/reconciler/retry enriches that exact adopted row
(`source_proposal_id`, `responsible_supervisor_id`, the sole source-proposal `plan_documents` row
per §P3-GAP, `supervisor_active_plan` + focus, source proposal `state='promoted'`), observing one durable
`plan.json` responsibility event. The plan shows `format='structured'`, `run_state='hardening'`. **No
HTML.** `proposal:promote` returns a discriminated `PromoteProposalResult`: the adopted **plan** when
already adopted, else **`promotion-pending`** (with `promotionRequestId` + `planArtifactId`); the
caller never blocks on the watcher. Repeated promote while pending/adopted returns the existing
operation (one worker, one folder, one `plans` row). Crash at any point converges on startup to
exactly one folder/row with no duplicate worker (§R-P3 point 6). **No EXECUTION worker launched at any
point.**

### WP-P3A′ (re-authored) — responsibility + doc-link + tab-overview schema **+ `promotion_requests`** ⟨DDL⟩

- **Files:** `src/main/database.ts`; tests `src/main/database.responsibility.test.ts`,
  `src/main/database.promotion-requests.test.ts`.
- **Dep:** A2, WP-P2A. *(§P3-GAP resolution adds no DDL — there is no selection field/table.)*
- **Do:** in the **single** P3A A2 serialized slot (rebase onto current `initDatabase()` head), using
  the repo's established guarded-migration idiom — **`CREATE TABLE IF NOT EXISTS` for tables, and
  `try { db.exec('ALTER TABLE … ADD COLUMN …'); } catch { /* exists */ }` for column adds (SQLite has
  no portable `ADD COLUMN IF NOT EXISTS`; do not emit that syntax)** — add, exactly as parent WP-P3A:
  `plans.responsible_supervisor_id TEXT REFERENCES agents(id) ON DELETE SET NULL` (**inline FK, here
  only**); `supervisor_active_plan(supervisor_id PK REFERENCES agents(id) ON DELETE CASCADE, plan_id
  TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, activated_at)`; `plan_documents(id, plan_id,
  workspace_id, doc_kind[proposal|deliberation|research|legacy-html], rel_path, artifact_ref, tab,
  sort_order, created_at)` (rel paths only, no body column); `plan_tab_overviews(plan_id, tab, body,
  revision, updated_by, created_at, updated_at, PK(plan_id, tab))`; `supervisor_focus` keeps its
  existing cascade. **THEN, in the same slot, add `promotion_requests` exactly per §R-A2 (do not alter
  columns/constraints):**
  ```sql
  promotion_requests(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    proposal_artifact_id TEXT NOT NULL,
    plan_artifact_id TEXT NOT NULL,          -- deterministic: plan_<proposal-artifact-hex>
    target_folder_rel_path TEXT NOT NULL,    -- deterministic state-dir path
    supervisor_id TEXT,
    orchestration_id TEXT,                   -- bound BEFORE delivery (§R-P3 point 5); winning run
    state TEXT NOT NULL,                     -- pending | adopted | failed
    attempt_count INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(workspace_id, proposal_artifact_id),
    CHECK (state IN ('pending','adopted','failed'))
  )
  ```
  All statements guarded and idempotent.
- **Accept:** parent P3A FK behaviors verified (supervisor delete → responsibility nulled; active-plan
  + focus cascaded; overview round-trips with revision; doc rows store rel paths only);
  `promotion_requests` created idempotently; `UNIQUE(workspace_id, proposal_artifact_id)` rejects a
  second row for one proposal; `CHECK(state)` rejects an out-of-set value; created in the same P3A slot
  as the responsibility DDL (single serialized migration, not a second concurrent slot). The worker
  runs `node dist/main/database.promotion-requests.test.js` and the responsibility sibling directly
  before P3Z registers them.
- **Non-goals:** no promotion logic; no `promotion_requests` reads/writes beyond DDL; no overview
  content.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-P3-manifest — `plan.json` no-clobber seam: §P3-MANIFEST-LOCK lockfile + in-lock CAS

- **Files:** new `src/main/plans/plan-manifest.ts`; test `src/main/plans/plan-manifest.test.ts`.
- **Dep:** none beyond the §R0 `plan.json` shape (§P3-MANIFEST-LOCK is resolved — the protocol
  above is normative). Consumed by WP-P3B-enrich and WP-P3-reconcile only.
- **Do:** implement the **§P3-MANIFEST-LOCK sidecar lockfile protocol verbatim** (acquire `'wx'` +
  owner identity/nonce, heartbeat renewal at `PLAN_LOCK_HEARTBEAT_MS`, rename-based stale reclaim
  after `PLAN_LOCK_STALE_MS`, nonce-verified release, bounded-retry clean errors — constants
  exported and tunable), and **inside the held lock** the mutation discipline: in-process async
  mutex (keyed by resolved folder path) + expected-hash CAS — read, verify expected hash,
  transform, temp-write, fsync, atomic-rename; retry on mismatch, preserving concurrent
  `responsibility_events`; never truncate/clobber; never a shell redirect. The lock closes the
  cross-process check-to-rename window; the CAS remains the in-lock consistency check. API:
  `casAppendResponsibilityEvent(plansHomeRoot, planFolderRelPath, event, { expectedHash?, maxRetries })`
  and generic `casMutate(plansHomeRoot, planFolderRelPath, transform, opts)` — both lock-wrapped. **Containment:** the API
  takes the **plans-home root** (`<workspaceStateDir()>/plans`) plus the plan-folder **relative** path;
  it resolves them, **requires the resolved folder to stay beneath the plans-home root**, and
  **rejects symlink/junction escapes** (realpath-verify; an absent path is a clean error, not an
  uncaught throw). Only then does it target `<folder>/plan.json` / `<folder>/plan.json.lock`.
- **Accept:** a concurrent cross-process skill edit during a service append is preserved (the
  §R-P3 acceptance — exercised with a competing external process/child holding and contending the
  lock, not just two in-process callers); a second acquirer blocks/backs off while a heartbeat is
  live; a dead holder (no heartbeat past `PLAN_LOCK_STALE_MS`) is reclaimed exactly once under
  racing contenders (tombstone rename race: one winner, losers re-enter acquire cleanly); release
  verifies nonce; idempotent append by stable `event_id` (re-append is a no-op, never a
  duplicate); containment/symlink rejection; retry-exhausted clean error; malformed/absent
  `plan.json` clean error.
- **Non-goals:** no scaffold; no DB; no dispatch; the skill agent-side helper (ships in the skill
  root, P0A/P0C) is not authored or modified here — it implements the same protocol per its own
  brief.
- **Verify:** main/shared template.

### WP-P3B-core — identity, de-dup, latch, and the crash-safe two-phase bind-before-deliver lifecycle

*(Half 1 of the re-authored WP-P3B contract; independently dispatchable.)*

- **Files:** rewrite `src/main/plans/promote-proposal.ts`; new `src/main/plans/promotion-dispatch.ts`
  (delivery adapter + oracle); `src/main/orchestration/types.ts` (`OrchestrationName += 'promotion'`;
  the `OrchestrationEvent` promotion kinds below); `src/main/database.ts` (atomic orchestration+request
  reservation accessor; the atomic agent/member/event transaction accessor; promotion event row
  mapping; the `markActiveRunsAborted` SQL filter); `src/main/supervisor/index.ts` (`launchAgent`
  honors the trusted internal binding via a separate non-public parameter — see step 4); tests
  `src/main/plans/promote-proposal.core.test.ts`,
  `src/main/supervisor/promotion-launch-binding.test.ts`; sibling `database.test.ts` and
  `orchestration/*` sibling tests updated. Scoped `rejectMarkdownMigration` lift inside the service
  only. **No `api-server.ts` edit; no broad `supervisor/index.ts` edit beyond the binding + confirmed-
  delivery hook.** The `InternalLaunchContext` type is **main-process-only** (kept in
  `supervisor/index.ts` / main-side orchestration code), **never** in `src/shared/types.ts`.
- **Dep:** WP-P3A′ (`promotion_requests`), WP-P2B-folder (defines the adopt seam this coordinates
  with). *(No WP-P3-manifest dep — core does not touch `plan.json`.)*
- **Frozen promotion lifecycle (no new generic statuses):**
  - `OrchestrationName` gains **`'promotion'`**.
  - **Run status REUSES existing values** (no `reserved/delivering/delivered` — those would force an
    audit of every consumer that treats only `starting|running` as live): **`starting`** = reserved
    and/or bound-but-not-confirmed; **`running`** = after confirmed promotion delivery; existing
    terminal statuses for failure/abort/completion. Internal phases are distinguished by
    **promotion-specific events**, not by status.
  - **Membership role:** `'worker'` (`insertOrchestrationMember(runId, 'worker', agentId)`).
  - **`OrchestrationEvent.kind` (durable evidence):** `promotion.reserved` | `promotion.agent_bound` |
    `promotion.delivery_attempt` | `promotion.delivered` | `promotion.failed`.
  - **The trusted binding is NOT a field on public `LaunchAgentInput`** (which is populated from
    API/IPC-facing data). It travels as a **separate non-public second parameter** suppliable **only by
    the in-process promotion adapter**:
    ```ts
    // main-process signature (supervisor/index.ts); NOT in src/shared/types.ts
    launchAgent(input: LaunchAgentInput, internal?: InternalLaunchContext): Promise<Agent>
    // InternalLaunchContext = { orchestrationBinding: { runId: string; role: 'worker';
    //                           evidenceKind: 'promotion' } }
    ```
    API/IPC callers continue to call `launchAgent(input)` with one argument and **cannot serialize or
    supply** `InternalLaunchContext`.
  - Because `starting`/`running` promotion rows are live, **the `markActiveRunsAborted` SQL exclusion
    `name <> 'promotion'` remains necessary** (scoped in the DB query/update in `database.ts`, not
    filtered afterward in `service.ts` — the DB function already aborts every starting/running row).
- **Do:** the live-process front half of `promoteProposal({ proposalId, supervisorId })` (no
  document selection — §P3-GAP), faithful to §R-P3 points 4, 5, 7 through 9, 11, and 12:
  1. **Claim-scan FIRST, then select identity.** Scan for any §R0-valid folder whose
     `plan.json.source_proposal.artifact_id` matches this proposal.
     - **A manual folder claims it →** retain **its existing valid `plan_artifact_id` and folder path**
       as the identity (never replace it); at most one valid claimant — duplicates diagnosed, **block
       enrichment**, never rebind; a folder claimed by a *different* proposal/supervisor is
       **rejected** (§R-P3 points 9 and 11).
     - **No existing folder →** only then derive the **deterministic service identity/path**
       (`plan_artifact_id = "plan_" + <proposal artifact hex>`,
       `target_folder_rel_path = <workspaceStateDir()>/plans/<plan-sku>/`), retry-convergent.
  2. **Durable de-dup + pending latch (§R-P3 point 4).** Insert-or-read the `promotion_requests` row;
     `UNIQUE(workspace_id, proposal_artifact_id)` is the authoritative cross-restart de-dup seam. The
     in-memory **pending latch** (keyed `(workspace_id, proposal_artifact_id)`) is backed by that row,
     acquired **before dispatch**, and **held until the request is terminal — `state='adopted'`
     (enrichment complete) or witnessed `state='failed'` — NOT merely on folder adoption.** Repeat
     promote while pending/adopted returns the existing operation.
  3. **Branch (§R-P3 point 7):** folder exists **and adopted** → hand to WP-P3B-enrich, return the
     plan; folder exists, **not adopted** → ensure `pending`, return `promotion-pending`; **no folder**
     → the crash-safe dispatch (step 4), return `promotion-pending`.
  4. **Crash-safe dispatch (§R-P3 points 5 and 6) — atomic binding + confirmed delivery:**
     - **Phase 1 (one `database.ts` transaction):** reserve the promotion orchestration row
       (`name='promotion'`, status `starting`, `promotion.reserved` event) AND bind
       `promotion_requests.orchestration_id`, atomically. Commit. *(This is the bind-before-delivery
       gap the current auto-executing `orchestration/service.ts` does not provide — `insertOrchestration`
       there immediately calls `execute()` — hence the promotion-specific lifecycle here rather than
       `run_orchestration`.)*
     - **Phase 2a — atomic agent+binding transaction inside `launchAgent`.** Call
       `AgentSupervisor.launchAgent(input, internal)` with the `InternalLaunchContext` binding and **no
       promotion task in `initialUserPrompt`**. `launchAgent` (in `supervisor/index.ts`) performs, in
       **one DB transaction**:
       ```text
       BEGIN
         create agent row
         insertOrchestrationMember(runId, 'worker', agentId)
         insert promotion.agent_bound event
         update orchestration status (stays 'starting')
       COMMIT
       only THEN spawn the worker process
       ```
       A crash **before commit leaves neither the agent row nor the member** (no unbound orphan); a
       crash **after commit always yields the exact bound agent**.
     - **Phase 2b — confirmed delivery, attempt-logged (submission ≠ turn start).** `launchAgent()`
       returns after process launch, not after task delivery, and the `initialUserPrompt` rail sends
       later on an idle/waiting transition (deleting its pending entry before an async send). So
       promotion work is **not** placed in `initialUserPrompt`. After launch returns,
       `promotion-dispatch.ts`:
       1. **persists `promotion.delivery_attempt`** (with the stable `promotion:<promotionRequestId>`
          marker) **before entering the confirmed-send operation** — so restart inspection can
          distinguish "never attempted" from "attempt interrupted";
       2. submits the full marked prompt through the **confirmed-send seam** (the turn-start-confirmed
          send path in `supervisor/index.ts`, not the fire-and-forget initial-prompt rail); the prompt
          carries the deterministic identity, `promotionRequestId`, and the marker — **no document
          list** (§P3-GAP: the folder the worker scaffolds and fills IS the document set);
       3. records **`promotion.delivered` and status → `running` ONLY after matching turn-start
          confirmation** — never on submission and never on `launchAgent` return.
       The worker's first act is atomic scaffold creation at the deterministic path, **writing the
       stable `promotion-service` responsibility event into the initial R0 manifest**: the service
       derives a **deterministic `event_id`** from the promotion request
       (`"rev_" + first 8 hex of sha256(promotion_request.id)`) and passes it as bootstrap; the worker
       stamps it at scaffold time so **disk responsibility is never absent until post-adoption
       enrichment**; enrichment later **observes** (not re-appends) that exact `event_id`. The worker
       then carries the full, interruptible, resumable ruling-24 journey (scaffold/orient → scope with a
       worker-lane implementability/size opinion → mark → deliberate → integrate → harden → package;
       promotion need not finish it synchronously, but the dispatched skill contract spans it).
       **Planning-lane dispatch (Amendment 10) — NOT the P5 execution dispatch (Amendment 1c); no
       execution worker, no `agents.plan_id` mutation.**
     - **Boot-reconciliation guard — SQL-scoped in `database.ts`:** `markActiveRunsAborted`'s SQL
       `UPDATE ... WHERE` excludes `name='promotion'` (filtering after the call in `service.ts` is too
       late — the DB function already aborts every starting/running row). Promotion rows are reconciled
       by WP-P3-reconcile, never boot-aborted.
  5. **Failed-attempt semantics (§R-P3 point 5).** Terminal launch failure → `state='failed'` +
     `failure_reason` + `promotion.failed`. A retry may go `failed → pending` **only after the prior
     attempt is witnessed terminal** (via the oracle below); the transition is atomic and **increments
     `attempt_count`, replaces `orchestration_id` with the new reserved attempt, clears
     `failure_reason`, and binds before delivery** (step 4), retaining the deterministic identity. **A
     repeat while the recorded attempt might still have delivered does not redrive** — it
     observes/reconciles the existing attempt.
  6. **Delivery oracle — marker AND matching turn-start required; submission is not delivery:**
     ```ts
     type DeliveryProbe =
       | { state: 'not-reserved' }                        // no orchestration bound
       | { state: 'reserved-unbound' }                    // Phase 1 committed; Phase-2a txn never committed (no worker member)
       | { state: 'bound-undelivered'; agentId: string }  // Phase-2a committed; no delivery_attempt; agent input-ready
       | { state: 'submitted-unconfirmed'; agentId: string } // delivery_attempt/body present; matching turn-start ABSENT
       | { state: 'delivered'; agentId: string }          // marker AND matching turn-start evidence
       | { state: 'indeterminate'; boundAgentId?: string; diagnostic: string }; // ambiguous PTY/input state only
     interface PromotionDeliveryInspector {
       inspectDelivery(orchestrationId: string): Promise<DeliveryProbe>;
       resumeDelivery(orchestrationId: string): Promise<void>;    // full marked-prompt send, once; no new orch/worker
       resumeSubmitOnly(orchestrationId: string): Promise<void>;  // confirm turn start only; NEVER retype the body
     }
     ```
     `inspectDelivery` reads the bound worker member, the `promotion.delivery_attempt` evidence, and the
     bound agent's **durable chat/turn evidence**, and treats a request as `delivered` **only when the
     marker AND a matching turn-start** are present. Because the worker member is bound (Phase 2a)
     **before** any send, a crash after agent creation always leaves the member row → recovery finds the
     **exact bound agent**; a crash before it → no member → **provably reserved-unbound**. A submitted
     body without a matching turn start is `submitted-unconfirmed`, never `delivered`. `indeterminate`
     is reserved for genuinely unreadable state and keeps the request `pending` with a diagnostic —
     never a blind resend.
- **Accept:** claim-scan precedes identity and a manual folder's existing identity is retained (not
  overwritten with the deterministic one); concurrent promote → **one** `promotion_requests` row
  (unique-constraint loser reads the winner's) converging on one folder/row (§R-P3 point 8); **Phase 1
  binds `orchestration_id` before any `launchAgent` call** (asserted with an injected `launchAgent`
  recording call time vs the bound row); **the trusted binding is persisted inside `launchAgent` in one
  transaction after the agent row and before process delivery**; **`name='promotion'` rows are excluded
  by the `markActiveRunsAborted` SQL and survive boot**; frozen lifecycle statuses/events/role emitted;
  failed→pending retry atomic + bind-before-deliver + no redrive of a possibly-delivered attempt; latch
  held until request-terminal (adopted/failed), not folder adoption; **a test proves
  adoption/enrichment keys on `plan.json.plan_artifact_id` / `source_proposal.artifact_id`, NOT on
  private dispatch metadata (ruling 25)**; no HTML, no execution worker, no `agents.plan_id` write;
  `promotionRequestId` is included in the dispatch bootstrap.
  **Crash/fault boundaries (the `promotion-launch-binding` test), recovery deterministic at each:**
  - before Phase-1 commit → `not-reserved`;
  - **inside the Phase-2a agent/member/event transaction → rolls back atomically (no unbound orphan
    agent)** → `reserved-unbound`;
  - after Phase-2a commit, **before `promotion.delivery_attempt`** → `bound-undelivered` (safe full
    send once);
  - **after `promotion.delivery_attempt`, body submitted but turn start unconfirmed** →
    `submitted-unconfirmed` (submit-only recovery, never retype body);
  - **turn start confirmed but `promotion.delivered` not yet written** → `delivered` (marker +
    turn-start prove it; enrich);
  - after `promotion.delivered` → `delivered`.
  Recovery never resends a body blindly and never launches a second worker.
- **Non-goals:** no adopted-row enrichment/CAS (WP-P3B-enrich); no startup reconstruction
  (WP-P3-reconcile); **no execution dispatch** (Implement is P5, Amendment 1c — the planning-worker
  dispatch here is Amendment 10, not that); no scaffold bytes written by the service; no folder-adopt
  logic (WP-P2B-folder); no private sidecar / completion JSON / service-owned alternate manifest may
  become authoritative (ruling 25).
- **Verify:** main/shared template; the supervisor-side crash-boundary test built with an injected
  fault at each labeled boundary; the technical-strategy §12 promotion-matrix rows for the live-process
  paths.

### WP-P3B-enrich — saga-ordered transactional enrichment of the adopted row

*(Half 2 of the re-authored WP-P3B contract; independently dispatchable; same file as WP-P3B-core.)*

- **Files:** extend `src/main/plans/promote-proposal.ts` (enrichment entrypoint invoked by
  WP-P3B-core and WP-P3-reconcile); test `src/main/plans/promote-proposal.enrich.test.ts`.
- **Dep:** WP-P3B-core (identity + request row + delivery oracle), **WP-P3-manifest** (no-clobber CAS —
  this half owns the `plan.json` touch), **WP-P2B-folder** (idempotent folder-adopt keyed by
  `plan.json.plan_artifact_id` + the `(workspace_id, artifact_id)` unique index — the exact row this
  enriches).
- **Do:** the enrichment saga against an already-adopted, filesystem-scaffolded row, in a **pinned
  order** — SQLite and `plan.json` do **not** share one transaction:
  1. **Precondition:** the watcher-adopted `plans` row for `plan_artifact_id` exists.
  2. **Manifest step (outside SQLite, first):** via WP-P3-manifest CAS, **observe** the stable
     `promotion-service` `assigned` responsibility event by its **deterministic `event_id`** (written
     by the worker at scaffold time per WP-P3B-core step 4) — or, for a **manual** folder, **verify** a
     pre-existing `manual-skill` `assigned` event matches the server-selected supervisor (mismatch
     **diagnosed, never overwritten**) (§R-P3 point 10). Append only if — and idempotently — the
     deterministic event is somehow absent. Must succeed before step 3.
  3. **DB step (one SQLite transaction, second):** attach `source_proposal_id`,
     `responsible_supervisor_id`, `supervisor_active_plan` + an ordinary `supervisor_focus`, source
     proposal `state='promoted'` + `promoted_to_plan_id`, and **flip `promotion_requests.state:
     pending → adopted` inside this same transaction** — never replacing the adopted row or overwriting
     P2-owned columns.
     **`plan_documents` (§P3-GAP resolution): write exactly ONE row** — the source proposal
     (`rel_path` = `plan.json.source_proposal.rel_path`, containment-checked against the workspace,
     rel-path only, `doc_kind='proposal'`), idempotently (re-enrichment never duplicates it).
     **Nothing else is written to `plan_documents`** — folder-internal documents are never
     mirrored (the folder is the document set; readers use the P1A/P2C folder projection).
  4. **Invariant:** `promotion_requests.state` stays `'pending'` until **both** the manifest
     observation **and** the DB transaction succeed; it becomes `'adopted'` **only** inside the
     successful DB transaction. **Folder adoption by the watcher does not set `adopted`** — only
     completed enrichment does. A crash after folder adoption but before enrichment leaves the row
     **`pending`**, so the pending-scan reconciler revisits it.
  5. **Manifest-observed / DB-fails crash:** the row stays `pending`; a retry (live or reconciler)
     re-observes the same deterministic `event_id` (no duplicate) and redoes the DB transaction —
     idempotent completion of the same work.
- **Accept:** enrichment runs only against an adopted row ("DB-first is not valid ordering" asserted);
  the deterministic responsibility event is observed exactly once (never duplicated across retries); DB
  enrichment + `state='adopted'` commit atomically; crash between manifest and DB leaves state
  `pending` and the reconciler completes it with no duplicate responsibility event; enrichment never
  replaces the adopted row / never overwrites P2-owned columns; a concurrent skill `plan.json` edit
  during the observe/append is preserved (lock + CAS); **the test suite includes a guard asserting
  the ONLY `plan_documents` write is the single source-proposal row (idempotent across
  re-enrichment; no folder-internal document ever mirrored).**
- **Non-goals:** no dispatch/identity (WP-P3B-core); no startup scan (WP-P3-reconcile); no execution
  dispatch; no `plan_documents` machinery beyond the single source-proposal row (§P3-GAP).
- **Verify:** main/shared template.

### WP-P3-reconcile — pending-promotion startup reconstruction (§R-P3 point 6)

- **Files:** new `src/main/plans/promotion-reconciler.ts`; **startup wiring in `src/main/index.ts`**
  (invoke after `startPlansWatcher(...)`, around the `startPlansWatcher({ ... })` call); a **public
  idempotent rescan-and-adopt entrypoint** — if WP-P2B-folder does not already export one, **this WP
  adds the narrow export `adoptPlanFolder(planFolderRelPath): Promise<AdoptResult>` to
  `src/main/plans/plan-folder-watcher.ts`, reusing the watcher's existing idempotent adopt
  implementation** (a P3-owned, explicitly-listed extension of that file — not a behavior change and
  not a silent P2 modification); test `src/main/plans/promotion-reconciler.test.ts`.
- **Dep:** WP-P3B-core (async oracle + dispatch path), WP-P3B-enrich (enrichment saga), WP-P3A′
  (`promotion_requests`), WP-P2B-folder (the adopt implementation reused via the named entrypoint).
- **Do:** at startup, **rebuild pending latches from `promotion_requests` `state='pending'`** and
  reconcile each per §R-P3 point 6 with a **bounded, self-owned convergence step** — **do not await an
  unpromised P2 readiness hook.** Before enriching any request, call the public idempotent
  `adoptPlanFolder(...)` for its deterministic/retained folder to ensure the adopted row exists
  (idempotent no-op if already adopted). Then, using `await inspectDelivery(orchestrationId)`:
  - **`not-reserved`** (or `orchestration_id` NULL) → **claim and dispatch** via WP-P3B-core (fresh
    planning-lane worker).
  - **`reserved-unbound`** → `resumeDelivery`: re-enter the launch path to atomically create+bind the
    agent (Phase 2a), then confirmed-deliver — **no duplicate orchestration**.
  - **`bound-undelivered`** (no attempt, agent input-ready) → **`resumeDelivery`: send the full marked
    prompt once** — same bound agent, **no new agent**.
  - **`submitted-unconfirmed`** (body/marker present, turn-start absent) → **`resumeSubmitOnly`:
    submit-only confirmed recovery on the same agent — NEVER retype the body**.
  - **`delivered`** → `adoptPlanFolder(...)` then run **WP-P3B-enrich** — **no second worker**.
  - **`indeterminate`** (ambiguous PTY/input state) → **leave the request `pending`, emit a
    diagnostic, do NOT dispatch** — re-probe on the next boot or explicit retry (safe: never redrive
    on uncertainty).
  Re-acquire the in-memory pending latch per still-open request so live `proposal:promote` calls
  coalesce onto the reconciled operation. Idempotent, safe every boot. Any dispatch here is
  planning-lane (Amendment 10), never execution (Amendment 1c).
- **Accept (§R-P3 point 6 crash matrix, one fixture each, driven by seeding `promotion_requests` rows +
  a fake `PromotionDeliveryInspector` + a fake `adoptPlanFolder`):** crash before Phase-1 commit
  (`not-reserved`) → claim + dispatch, no duplicate; crash inside/failing Phase-2a
  (`reserved-unbound`) → re-bind + confirmed-deliver, no duplicate orchestration; crash after Phase-2a,
  before attempt (`bound-undelivered`) → full send once, same agent; crash after attempt, before
  turn-start (`submitted-unconfirmed`) → submit-only recovery, body never retyped;
  turn-start-confirmed / delivered → `adoptPlanFolder` + enrich, no second worker; crash after folder
  adoption, before enrichment (row still `pending`) → reconciler completes enrichment, no duplicate
  responsibility event; **`indeterminate` → request stays pending with a diagnostic, no dispatch**; a
  crash-orphaned temp sibling resumed/replaced by its own retry, unrelated dirs untouched; idempotent
  across repeated boots; the pending latch re-acquired so a concurrent live promote coalesces.
- **Non-goals:** no new dispatch/enrich policy (reuses WP-P3B-core/enrich); no execution dispatch; no
  watcher *behavior* change (only the narrow public adopt export is added, reusing existing logic).
- **Verify:** main/shared template.

### WP-P3C-cand — DELETED (§P3-GAP ruling)

The link-candidate service existed solely to feed the PromoteDialog document checklist, which the
BLOCK-1 ruling removed. **Not dispatched, not built.** If the P4 doc home needs external-document
link candidates, it re-enters there as a P4-owned package (same bounded-roots discipline the
parent specified: frontmatter refs + `.lares/proposals/supporting/` + `.lares/research/cleared/`
only).

### WP-P3C′ (amended) — Promote IPC + PromoteDialog: supervisor picker + concrete status IPC

- **Files:** `src/main/plans/plan-ipc.ts` (`proposal:promote`, **`proposal:promotionStatus`**);
  `src/shared/types.ts` (`PromoteProposalResult` + a `PromotionStatus` shape); new
  `src/renderer/components/plan/PromoteDialog.tsx`; Promote wiring in
  `src/renderer/components/plan/PlanGalleryPane.tsx`; `src/preload/index.ts`; tests
  `src/renderer/components/plan/PromoteDialog.test.tsx`, `src/main/plans/proposal-promote-ipc.test.ts`.
- **Dep:** WP-P3B-core, WP-P3B-enrich, WP-P2D.
- **Do:** define the **shared discriminated result** in `src/shared/types.ts`:
  ```ts
  type PromoteProposalResult =
    | { status: 'adopted'; plan: Plan }
    | { status: 'promotion-pending'; promotionRequestId: string; planArtifactId: string };
  ```
  The Promote button (proposals only) opens the **supervisor picker** — **no document checklist
  exists (§P3-GAP)**; supervisor choices filtered via `hasSupervisorPrivilege(agent)` +
  same-workspace membership (server-revalidated); on confirm →
  `proposal:promote({ proposalId, supervisorId })` returning
  `PromoteProposalResult`; the IPC **returns promptly, never blocks on the watcher.** Resolution of a
  `promotion-pending` result uses a **concrete status path, not an undefined invalidation event:** add
  **`proposal:promotionStatus({ promotionRequestId }): PromotionStatus`** backed by `promotion_requests`
  (+ the adopted `plans` row) — runtime IPC over durable DB rows, **not** a private durable skill
  format. The dialog does **bounded polling/refetch** of `promotionStatus` after the promote IPC
  returns, transitioning to the adopted plan when `state='adopted'` surfaces (bounded attempts +
  backoff; gives up with a "still promoting — planning worker running" state, never an infinite poll).
  A repeat Promote on a pending/adopted proposal reflects the existing operation, mints nothing new.
- **Accept:** only privileged same-workspace supervisors listed; **no document-selection UI or
  `selectedDocRelPaths` field anywhere** (§P3-GAP); cancel mints nothing; non-supervisor rejected server-side;
  `proposal:promote` returns the discriminated `PromoteProposalResult`; `proposal:promotionStatus`
  reflects `promotion_requests`/`plans` state; `promotion-pending` resolves to the plan via bounded
  `promotionStatus` polling (not by blocking, not via an undefined event); polling is bounded; a repeat
  Promote starts no second worker.
- **Non-goals:** **Promote dispatches the PLANNING/HARDENING worker (Amendment 10) — it does NOT
  dispatch EXECUTION onto the plan's work packages; that is the human Implement trigger in P5
  (Amendment 1c).** (Supersedes the parent Non-goal "no auto-dispatch on promote (Implement is P5),"
  which conflated the two kinds.) No promotion business logic in the renderer (WP-P3B-core/enrich own
  it).
- **Verify:** renderer Vitest + main template.

**Integration gate P3Z:** register in `scripts/run-main-tests.mjs`: `database.responsibility.test`,
`database.promotion-requests.test` (WP-P3A′), `plan-manifest.test` (WP-P3-manifest),
`promote-proposal.core.test` + `promotion-launch-binding.test` (WP-P3B-core),
`promote-proposal.enrich.test` (WP-P3B-enrich), `promotion-reconciler.test` (WP-P3-reconcile),
`proposal-promote-ipc.test` (WP-P3C′); then
`npm run build:main && npm run test:supervisor`; renderer Vitest (`PromoteDialog.test.tsx`);
`npm run build`. **The gate additionally asserts the full crash-recovery matrix (WP-P3B-core/enrich
live paths + WP-P3-reconcile restart paths — including the adopted-before-enrichment `pending`-revisit
case and the submitted-unconfirmed submit-only recovery), that no P3 code path launches an execution
worker or mutates `agents.plan_id`, and that the only `plan_documents` write anywhere in P3 is
WP-P3B-enrich's single source-proposal row (§P3-GAP).** P3Z owns the `run-main-tests.mjs` registry
edit so the parallel P3 WPs never contend.

**Stage P3 graph:**

```text
A2 + WP-P2A -> WP-P3A' --------------------------------------+
WP-P2B-folder (adopt seam) ----------------------------------+--> WP-P3B-core
                                                                     |
WP-P3-manifest (Dep: none) --------------------+                     v
                                               +----------> WP-P3B-enrich -> WP-P3-reconcile --+
WP-P3B-enrich + WP-P2D -> WP-P3C' -------------------------------------------------------------+--> P3Z
```

- `WP-P3-manifest` (no deps) feeds **WP-P3B-enrich** and **WP-P3-reconcile**, **not**
  WP-P3B-core.
- `WP-P3B-core` needs `WP-P3A′` + the `WP-P2B-folder` adopt seam.
- `WP-P3B-enrich` needs `WP-P3B-core` + `WP-P3-manifest` + `WP-P2B-folder`.
- `WP-P3-reconcile` needs `WP-P3B-enrich` (and reuses WP-P3B-core's oracle + dispatch path).
- `WP-P3C′` needs `WP-P3B-enrich` + `WP-P2D` (WP-P3C-cand is deleted — §P3-GAP).
- All P3 leaves join at **P3Z**. Both former blockers are resolved; only ordinary dependencies
  gate dispatch.

---

<!-- groupthink: planning-surface P3 re-author (promotion → dispatchable WPs), Lead Planner × Reviewer, Reviewer-approved 2026-08-01 as a faithfully blocked re-author awaiting BLOCK-1 (§P3-GAP) and BLOCK-2 (§P3-MANIFEST-LOCK) -->
<!-- revision 2026-08-02 (supervisor): BLOCK-1 + BLOCK-2 RESOLVED by Edward's selection comments; rulings folded in, rejected branches deleted (no promote-time doc selection — folder = document set, plan_documents = source-proposal row only; plan.json sidecar lockfile w/ heartbeat + stale reclaim, skill helper = skill-side owner). Document now dispatchable pending execution GO. -->


<!-- groupthink_run: 8d584002 (mode=serial) -->
