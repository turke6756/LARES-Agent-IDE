---
plan_artifact_id: plan_ce97b9ad
intent_id: int_b7d41c2e
kind: deliberation
---

# Cluster B — Enforcement mechanism for production reachability

**Intent:** `int_b7d41c2e` · **Plan:** `plan_ce97b9ad` · **Mode:** groupthink-serial (Lead Planner × Reviewer, Reviewer-approved 2026-08-08)

Source material: `plan.md` (Cluster B, B1–B4), the `prove-the-production-entry-point`
skill, and first-hand verification of the current codebase (`plan-work-package-ingest.ts`,
`database.ts` package-state seam, `constants.ts` provider-instruction derivation). Every
enforcement claim below is scoped to what the code can actually do today; where a check
depends on machinery that does not yet exist, it is labelled non-blocking and its home is
named.

---

## 0. The decision this deliberation makes

The proposal already narrowed the cluster (plan.md:152–157): *"the skill content is sound
and the enforcement is missing."* This deliberation therefore does **not** rewrite the
skill's reasoning. It decides **what becomes machine-enforced, at which seam, and what
necessarily stays human judgment** — under the hard B4 constraint that a
registration-existence check is insufficient because in the mint incident the mocks
*simulated* the missing bridge by supplying a token production would itself have had to
create.

The spine of the design is an honest split across five layers:

| Layer | What it checks | Where enforced | Enforcement status in this cluster |
|---|---|---|---|
| **M1 — schema presence** | Every package in a `PLAN-WORK-PACKAGES:v2` supplement declares its reachability obligations (entry-seam links + production constructs) or an explicit reviewed `none` | Ingest parser `parsePlanWorkPackageDocument`, which already runs on every reconcile and fails supplements closed | **Mechanically enforced, live.** The one genuinely mechanical enforcement Cluster B lands on its own. |
| **M2 — revert-refutation** | For every declared obligation, the entering test *fails* when production's registration/construction is removed from an immutable, code-state-bound specimen | App-owned proof engine `prove_reachability`, producing candidate-tree-bound evidence rows; **consumed by a completion-gate executor** | **Non-blocking until the completion executor lands** (SC-WP-3C `done` channel / D1 ledger). Cluster B *generates and records* evidence; D1 alone makes it completion-blocking. |
| **S1 — seam truth** | The declared seam is *actually* production's entry point | `prove-the-production-entry-point` skill (human judgment) | Skill. Not machine-decidable. |
| **S2 — construct completeness & test honesty** | *Every* token/handle/client production constructs is declared, and no entering test supplies one from a fixture/fake | Gate checklist + reviewer inspection of the production chain and the test's fixtures | Skill/checklist. Revert-refutation *corroborates* but does not by itself establish the literal B4 invariant unless every obligation was declared honestly. |
| **S3 — worker reporting** | Final message states entry seam, production-created resources, entering tests, per-obligation refutation status, every unperformed check | Worker instruction; supervisor rejects completion when required info/proof absent | Checklist, backed by gate evidence. No presence-lint. |

The claim is deliberately narrow: **schema presence is mechanically enforced at ingest;
production-entry truth, completeness of production-created resources, and test honesty
remain human judgments; revert-refutation becomes mechanical only when a mandatory
completion executor operates on the exact candidate tree and validates an expected
behavioral failure for every declared obligation.**

### Verified precondition: there is no completion executor today

`plan_work_packages.state` carries a `done` value in its DDL
(`database.ts` — `CHECK (state IN ('ready','executing','blocked','done','archived'))`),
but the sole state-writer `transitionPlanWorkPackageStateInTransaction` **throws on a
`done` target** (*"`done` is SC-WP-3C-owned, never ledgered here"*), and no implemented
code sets `state='done'`. Package completion today is supervisor prose in `ARC.md`, not a
DB transition — exactly F2/D1's gap. This is why "a script the supervisor runs" is **not**
mechanical enforcement of M2: the seam that would refuse completion does not yet exist.
Cluster B builds the evidence and the executor's input contract; D1/SC-WP-3C builds the
refusal.

---

## 1. B4, correctly modelled: independent proof obligations

One revert probe cannot prove both registration reachability *and* production
construction. Reverting a registration line makes even an honest registration test fail
while that same test still mocks a token production should mint — the mint defect would
pass a single-probe check. The model is therefore **independent obligations, each
independently refuted**:

- **Entry-seam links (`entry_seam_links[]`, one or more per behavior package).**
  Registration may legitimately span several files (main registration, preload exposure,
  renderer caller). Each **load-bearing bridge is its own independently refutable
  obligation** — reverting one link proves the test depends on that link, not on all of
  them, so every link gets its own mutation + entering test.
- **Production-construct obligations (`production_constructs[]`, zero or more).** One for
  every token, handle, client, or session production must construct, each naming its
  production construction site and an entering test that obtains it *through production*.

### 1.1 The v2 schema block (`PLAN-WORK-PACKAGES:v2`)

Each package gains a required `reachability` object:

```jsonc
"reachability": {
  "kind": "behavior",                                   // "behavior" | "none"
  "entry_seam_links": [                                 // non-empty for behavior; one obligation per load-bearing bridge
    {
      "seam_kind": "ipc",                               // ipc | preload | route | ui-caller | job | other
      "path": "src/main/ipc-handlers.ts",
      "symbol": "savecard:sweep",
      "entering_test": "src/main/commit-candidates/commit-coordinator-ipc.test.ts",
      "mutation": "reachability-mutations/entry-ipc-savecard-sweep.patch",
      "verification": { "target": "savecard-sweep-ipc-reg", "expect_failure": "REACHABILITY:savecard:sweep" }
    },
    {
      "seam_kind": "preload",
      "path": "src/preload/index.ts",
      "symbol": "SAVE_SWEEP_CHANNEL",
      "entering_test": "src/renderer/components/save/save-card-surface.test.ts",
      "mutation": "reachability-mutations/entry-preload-savecard-sweep.patch",
      "verification": { "target": "savecard-sweep-preload", "expect_failure": "REACHABILITY:preload:savecard:sweep" }
    }
  ],
  "production_constructs": [                             // may be []
    {
      "name": "candidate token",
      "producer_path": "src/main/commit-candidates/candidate-service.ts",
      "producer_symbol": "mintCandidateToken",
      "consumer_path": "src/main/commit-candidates/commit-coordinator.ts",
      "entering_test": "src/main/commit-candidates/production-chain.test.ts",
      "mutation": "reachability-mutations/construct-candidate-token.patch",
      "verification": { "target": "candidate-token-mint", "expect_failure": "REACHABILITY:token:minted-by-production" }
    }
  ]
}
```

Non-behavior package:

```jsonc
"reachability": { "kind": "none", "rationale": "adds/changes no independently reachable behavior; internal helper rename only" }
```

**`kind` is defined by package *effect*, not author convenience.** A package is `behavior`
iff it adds or changes an independently reachable behavior: a new/modified IPC channel,
route, preload binding, UI-invoked path, job, or a production-constructed
handle/token/client. `none` means it does none of those. A refactor that modifies an
*existing* seam is `behavior` and must name+test that existing seam. Ingest cannot verify
the effect claim, so **every `none` rationale is reviewed at the gate** — `none` is
author-asserted and review-gated, never machine-trusted.

---

## 2. M1 — schema presence, mechanically enforced at ingest

### 2.1 Compatibility: a new block version, with an enforceable cutoff

Making `reachability` required inside the existing `v1` label would retroactively turn
every already-`synced` v1 supplement `invalid` on its next reconcile — unsafe. Decision:
**introduce `PLAN-WORK-PACKAGES:v2`**, in which `reachability` is required per package. `v1`
remains syntactically parseable (legacy; no `reachability`), but a **server-owned migration
snapshot** prevents v1 from becoming an indefinite bypass:

- At migration, the app records durable **grandfather rows**: each reviewed legacy
  `package_id` + its exact `content_hash` + `schema_version`. This is a server-owned schema
  migration + durable rows, **not** a mutable dated flag.
- A grandfather applies **only** to that exact `content_hash`. Any content revision drops
  it and requires v2.
- **Cutoff enforcement location (ships in Cluster B):**
  - **Reconciliation** assigns a new projection status `legacy-unmigrated` to any new or
    revised v1 package absent from the grandfather snapshot (alongside `invalid`/`conflict`).
  - **Dispatch/assignment** refuses a `legacy-unmigrated` (quarantined) package.
  - Only the **`done` refusal** for an ungrandfathered v1 package defers to D1/SC-WP-3C.
    Deferring *all* cutoff enforcement would preserve the bypass; it does not.

This is the "introduce v2 with a well-defined cutoff" option, and it is testable (a
grandfathered v1 fixture stays usable at its recorded hash; a revised v1 goes
`legacy-unmigrated`; a v2 fixture is required for new work).

### 2.2 Data-flow: one parser, extended projection, persisted, readable

`parsePlanWorkPackageDocument` returns `ReconciledPlanWorkPackageInput[]`; folding
`reachability` only into `canonicalContent` would hash it but expose nothing to the proof
engine. Resolution:

1. Add a validated `reachability` field to `ReconciledPlanWorkPackageInput` and to the
   projection `parsePlanWorkPackageDocument` returns.
2. Persist `schema_version`, `content_hash`, and the normalized obligations through
   `applyPlanWorkPackageSnapshot` (see §5 tables).
3. The proof engine (§4) obtains packages by calling the **already-exported**
   `parsePlanWorkPackageDocument` on the supplement — **there is no second schema parser.**
   The engine is app-owned TypeScript (§4), so it links the one parser directly rather than
   reimplementing it in a scaffolded script.

### 2.3 Parser edits (plain app code — no scaffold bump; needs its own tests)

In `src/main/plans/plan-work-package-ingest.ts`:

- Add `'reachability'` to `PACKAGE_KEYS`.
- Add diagnostic code `'reachability-invalid'` to `PlanWorkPackageDiagnosticCode`.
- Add a shared, exported validator enforcing, per package: `kind ∈ {behavior,none}`;
  `none` → non-empty trimmed `rationale` (≤300) and no other keys; `behavior` → a non-empty
  `entry_seam_links[]` (each link: `seam_kind ∈` the seam set; `path`/`entering_test`/
  `mutation` via the existing `normalizedPlanPath`; non-empty bounded `symbol`; a
  `verification { target, expect_failure }` of non-empty bounded strings) and a
  `production_constructs[]` array (possibly empty) whose entries each carry normalized
  `producer_path`/`consumer_path`/`entering_test`/`mutation`, non-empty bounded
  `name`/`producer_symbol`, and the same `verification` shape. Reuse the existing
  `rejectArrowStrings` guard (already applied to the whole block).
- Fold `reachability` into `canonicalContent` so any reachability change re-hashes the
  package (`contentHash`) and re-projects.
- Gate the whole requirement behind `schema_version === 2`; `v1` blocks parse as today.

**M1's honest limit:** ingest proves the block is *present and well-formed*. It cannot
prove the seam is real, the constructs are complete, or a mutation bites. Those are M2 +
S1/S2.

---

## 3. B1 brief template — the prose `Entry` section

The WP prose shape is `Files · Dep · Do · Accept · Non-goals · Verify`
(`proposal-to-plan` skill, `references/activities/package.md` Part A). **Add one section:
`Entry`** — the human-readable mirror of the `reachability` block: each entry-seam link,
each production-constructed resource, the entering test for each, and the mutation
reference; or `Entry: none` with a reviewed one-line reason. Edit `package.md` Part A's
shape list and add the `Entry` definition. Deployed via the managed scaffold route (§6).

---

## 4. M2 — revert-refutation as a real behavioral proof

### 4.1 Runtime boundary: app-owned proof engine, no scaffolded parser

The proof engine is **app-owned TypeScript** reusing `parsePlanWorkPackageDocument`,
exposed as a supported command the in-workspace supervisor invokes — an MCP/IPC tool
`prove_reachability(planFolder)`. A scaffolded Node `.mjs` cannot import the TypeScript
ingest module and may run in workspaces without AgentDashboard source, so **nothing
scaffolded parses the schema**. The skill/checklist points the supervisor at the app
command; persistence and the future completion transition are app-owned too, so the proof
engine belongs there.

### 4.2 The specimen: built by path from the pinned base

A gate commonly runs before the final commit, so `HEAD` may contain neither the seam nor
the test, and `git worktree add … HEAD` omits the worker's current work. `add -A` over a
copied live index would capture unrelated staged/unstaged/untracked foreign work and
possibly secrets. Recipe instead (never mutating the shared index/worktree):

1. `read-tree <baseOID>` into a temporary index (`GIT_INDEX_FILE=<tmp>`).
2. Stage **only the package's declared `paths[]`** from the worktree into that temp index.
   Test dependencies the package did not change come from the base tree (already present
   via `read-tree`), never from `add -A`.
3. `write-tree` → tree OID; `commit-tree` on `<baseOID>` → a dangling specimen commit.
4. `git worktree add --detach <scratch> <specimenCommit>`; all mutation happens in
   `<scratch>`; remove it in `finally`. **Never** `checkout`/`restore`/`clean`/`stash` in
   the shared worktree (worker instruction hard rule).

**Foreign-edit honesty:** when a declared shared path carries inseparable foreign edits,
**disclose and mark the tree non-package-exact** — do not silently gate it as
package-exact. Record `baseOID`, included paths, resulting tree/commit OID, and any
admitted foreign content in the evidence. Preferred future path: gate an already-prepared
package commit once D1 mints one (no such per-package commit convention exists today — the
`Save component:<hash>` commits are checkpoints, not package commits).

### 4.3 Bounded verification: managed target registry + stable failure markers

The engine never executes arbitrary command strings from plan prose. Each obligation's
`verification.target` resolves through a **repo-owned, committed, versioned registry** — an
app-owned mapping file (e.g. `src/main/plans/reachability-targets.ts`) carrying a
`registry.version`. Each entry maps a target name →
`{ runner: <allowlisted adapter: node-test | vitest>, file, test_name, protected_test_paths[] }`.
Targets are registered **in-repo under review**, not from plan prose; the engine resolves
the name and runs **only** the fixed adapter invocation inside the specimen scratch
worktree. `registry.version` is persisted as `verification_target_version` in evidence, so
a registry change invalidates prior evidence.

`verification.expect_failure` is a **stable reachability marker** the entering test attaches
to its seam assertion (e.g. `assert.ok(handler, 'REACHABILITY:savecard:sweep')`). The
classifier requires the *failed* assertion to carry that marker. A compile / import /
collection / fixture-setup failure cannot produce the marker → `INDETERMINATE`, never
`PASS`. This defeats both "infer the runner" and "print deceptive output".

### 4.4 The mutation-patch contract

Mutation artifacts are **package artifacts committed with the implementation**, under a
`reachability-mutations/` prefix inside the package's declared paths. Binding is
**external** — a Git tree hash includes the patch blob, so a patch cannot contain its own
specimen tree OID without self-reference. Therefore:

- The patch contains **no OID**.
- The proof engine independently computes the specimen tree OID and the patch blob hash.
- The evidence row binds the tuple `(obligation_id, specimen_tree_oid, mutation_blob_oid)`.
- Applicability is tested by applying the patch to the computed specimen; apply failure or
  stale context → `INDETERMINATE`.
- The patch may touch **only** the obligation's declared `path` / `producer_path`. "Touches
  the symbol" is established by requiring the declared `symbol` / `producer_symbol` token to
  appear in the patch's changed lines within that file (diff-stat proves only the file, not
  the symbol).
- The patch is **rejected (`INDETERMINATE`) if it touches any `protected_test_paths`** from
  the target-registry entry (the entering test + its fixtures). Protection is defined by the
  reviewed registry, not by an author-supplied field.

### 4.5 Per-obligation refutation procedure

For each entry-seam link and each production construct, in the specimen scratch worktree:

1. **Baseline:** run the obligation's verification target → it **must PASS**. A failing
   baseline is `INDETERMINATE`, never proof.
2. **Apply** the reviewed mutation; verify its changed lines fall only in the declared path
   and intersect the declared symbol, and touch no protected path (else `INDETERMINATE`).
3. **Re-run** the target → it **must FAIL**, and the failure must carry the
   `expect_failure` marker (a build/collection/fixture failure is `INDETERMINATE`).
4. **Discard** the specimen worktree.
5. **Record** an evidence row: baseline command+result, mutation identity
   (`mutation_blob_oid`), mutated command+result, failure classification, `specimen_tree_oid`,
   `specimen_base_oid`, `verification_target_version`, verdict, timestamp.

A package clears M2 only when **every** obligation reaches step 3 with a marker-carrying
behavioral failure. This is what catches both incidents: WP-6's constructor test and mint's
mocked token both leave their entering test green after the declared production element is
removed → *still PASS* → **fail**.

**M2's honest limit (stated in the checklist):** revert-refutation proves each *declared*
obligation bites. It does not by itself establish "no test supplies a value production
constructs," because an *undeclared* construct is invisible to it. Completeness is S2 — the
reviewer must inspect the production chain and the entering test's fixtures/fakes and reject
any test-supplied value for a production-constructed resource, and reject any omitted
construct.

### 4.6 Evidence freshness binds to code state

`package_content_hash` hashes package *metadata*, not production-file or test contents, so
it alone cannot detect a code change that leaves the block untouched. The clearance
predicate therefore binds to the candidate tree:

```text
cleared(obligation) :=
  ∃ evidence row where
    evidence.verdict                     == 'pass'
    AND evidence.specimen_tree_oid       == completion_candidate.tree_oid
    AND evidence.package_content_hash    == package.content_hash
    AND evidence.mutation_blob_oid       == current committed patch blob oid
    AND evidence.verification_target_version == registry.version
    AND evidence.obligation_id           == obligation.id

cleared(package) := every obligation of the package is cleared
```

The `specimen_tree_oid == completion_candidate.tree_oid` term makes a change to an entering
test or a production file invalidate stale evidence even when the package block and patch
are unchanged. Where D1 later supplies a package commit, `completion_candidate.tree_oid` is
that commit's tree. **Until a completion candidate exists, evidence may be generated for
review but is never "fresh for mechanical completion."**

---

## 5. Persistence — Cluster B owns evidence writing

Cluster B **creates** the tables, **writes evidence transactionally from the app-owned
proof engine**, and **exposes read + freshness APIs**. D1 later *consumes* those rows to
authorize `done`. (This removes any "D1 may own the writer" ambiguity — if Cluster B claims
evidence is recorded, Cluster B owns the writer.)

```
plan_wp_reachability_obligations(
  id, package_id, package_content_hash, schema_version,
  obligation_kind,            -- 'entry-link' | 'construct'
  ordinal,
  declared_json,              -- the normalized obligation as authored
  mutation_path,
  verification_target,
  expect_failure_id
)

plan_wp_reachability_evidence(
  id, obligation_id, package_content_hash,
  specimen_base_oid, specimen_tree_oid, mutation_blob_oid,
  baseline_result, mutated_result, failure_classification,
  verdict,                    -- 'pass' | 'fail' | 'indeterminate'
  verification_target_version,
  verified_at
)
```

The executor's freshness/coverage test (§4.6) is then mechanical over these rows. Use the
guarded `ALTER TABLE ADD COLUMN` idiom and the "plain attribute, no FK cascade" rule
consistent with the rest of `database.ts`. D1 may extend these rows with completion-run
lifecycle, but the identities above are fixed here so "fresh" and "covers every obligation"
are evaluable now.

---

## 6. B3 — worker final-message duties, provider-neutral

No presence-lint (it would measure phrasing, not truth). Instead, a **required structured
summary** the supervisor rejects completion without: (1) the entry seam(s) wired (`symbol`
+ `path` per link); (2) every production-created resource; (3) the entering test for each
obligation; (4) per-obligation revert-refutation status (`passed` / `not run — reason`);
(5) **every unperformed check**, pairing with the honest-limitation reporting F10 credits.
A worker that cannot reach the seam **stops and says so** (WP-7's stop was correct).

**Provider-neutral deployment.** The worker instruction body is the single
`WORKER_CLAUDE_MD` constant in `src/shared/constants.ts`; the Codex/Grok/agy `AGENTS.md`
bodies are **derived** from it via the existing `.split(…).join(…)` anti-drift chain
(`WORKER_CODEX_AGENTS_MD`, `WORKER_GROK_AGENTS_MD`, `WORKER_AGY_AGENTS_MD`). Edit
`WORKER_CLAUDE_MD` once, preserving the transforms, so every provider surface inherits the
duty. Bump versions and **append (never replace)** cumulative `previousHashes` for
`WORKER_CLAUDE_MD` and every derived `*_AGENTS_MD` entry, per the
`scaffold-content-needs-version-bump` and
`scaffold-previoushashes-cumulative-never-delete-row` disciplines, verified by
`scaffold-version-migration.test.ts`.

---

## 7. Managed scaffold deployment (no in-place hand-edits)

The `prove-the-production-entry-point` skill is **not** currently scaffolded — there is no
entry in `src/shared/constants.ts` or `PROPOSAL_TO_PLAN_TREE`; it exists only as
hand-placed per-lane copies (e.g. `.lares/supervisor/.claude/skills/…`,
`.lares/supervisor/.agents/skills/…`, `.lares/workers/codex/.agents/skills/…`). Editing
those copies in place guarantees drift and recreates the missing enforcement. Decision —
**managed route**:

- **Skill:** add a managed scaffold body constant (e.g. `PROVE_PRODUCTION_ENTRY_POINT_SKILL`
  in `src/shared/constants.ts`) and versioned scaffold entries deploying it to **every**
  relevant supervisor and worker lane. Its gate section names the app command
  (`prove_reachability`) and states: *a `FAIL` or missing-evidence verdict outranks green
  tests, a real code read, and the worker's summary.* Its worker-facing bullet carries the
  B3 duty above.
- **Contract prose:** `references/contracts/work-packages.md` (the v2 `reachability` field +
  validation bullets) and `references/activities/package.md` (the `Entry` section) live in
  `PROPOSAL_TO_PLAN_TREE` in `src/main/supervisor/index.ts`, with embedded content constants
  in `src/shared/constants.ts`. Edit the source-of-truth *and* the scaffold copy, then bump
  the version and append the prior hash for each changed entry.
- `prove_reachability` is app code (MCP/IPC handler + engine + target registry), **not** a
  scaffold entry — no scaffold version applies to it.

---

## 8. What Cluster B ships vs. what defers to D1

**Cluster B ships (this cluster):**

- v2 block schema + ingest validation + persisted obligations / `schema_version` /
  `content_hash`.
- The server-owned v1 migration snapshot + durable grandfather rows + reconciliation
  quarantine (`legacy-unmigrated`) + dispatch/assignment refusal of quarantined packages.
- The app-owned proof engine `prove_reachability` (MCP/IPC) with the managed verification
  target registry and protected-path enforcement, plus tests.
- The `plan_wp_reachability_obligations` / `plan_wp_reachability_evidence` tables with
  **transactional evidence writes** and read/freshness APIs.
- The managed skill + brief `Entry` section + B3 provider-neutral structured reporting,
  deployed to all lanes via managed scaffold constants.
- Checklist-driven evidence generation.

**Deferred to D1 / SC-WP-3C:** consuming that evidence to make the `done` transition
**completion-blocking** — refuse on missing / stale / failing / quarantined-v1 evidence.

**Explicit, recorded limitation.** M1 is enforced on landing. **M2 is non-blocking until
the completion executor lands.** The plan must **not** advertise F1/B4 as fully remediated
before then. An explicit limitation line in `ARC.md`/`OVERVIEW.md` records that reachability
evidence is generated, code-state-bound, and recorded on landing, but becomes
completion-blocking only when the D1 executor lands — so **F1 and B4 remain only partially
remediated until the completion refusal ships.**

---

## 9. Acceptance criteria

1. **M1 (ingest):** in `plan-work-package-ingest.test.ts` — a grandfathered v1 fixture stays
   usable at its recorded content hash; a revised/new v1 package absent from the snapshot →
   `legacy-unmigrated` quarantine; a v2 fixture missing `reachability` → `reachability-invalid`;
   a v2 well-formed fixture → `synced` with obligations persisted and `schema_version=2`; a
   `reachability` edit changes `contentHash`.
2. **Cutoff:** a `legacy-unmigrated` package is refused by dispatch/assignment.
3. **Proof engine:** a fixture package whose entry-seam link declares a constructor-only
   `entering_test` → engine returns `fail` (still-passes-after-revert); WP-6b's real
   `registerIpcHandlers` + fake `ipcMain` shape → `pass`; a patch with stale context, or one
   touching a protected test/fixture path → `INDETERMINATE`; a suite that fails to compile
   under mutation → `INDETERMINATE`, never `pass`. Each entry-seam link and each construct is
   refuted independently.
4. **Evidence freshness (code-state bound):** given a stored `pass` evidence row, change
   **only** the entering-test or a production-file's contents (package block + mutation patch
   unchanged) → the candidate tree OID differs → the freshness predicate reports the
   obligation **not cleared** (stale). This proves evidence binds to code, not metadata.
5. **Evidence join:** given a stored evidence row and a subsequently content-revised package,
   the freshness check reports "not cleared" (content-hash mismatch).
6. **Scaffold reach:** version bumps + cumulative `previousHashes` present for the new skill
   constant, the contract/activity entries, and `WORKER_CLAUDE_MD` + every derived
   `*_AGENTS_MD` entry; `scaffold-version-migration.test.ts` green.

---

## 10. Non-goals honored

- **Deliberation and gating are strengthened, never weakened** (proposal non-goal,
  plan.md:60–65): this cluster *adds* an enforcement layer and removes no gate, review step,
  or deliberation.
- No change to the frozen specimen `plan_5b3ea7d1`; the mint/WP-6 references are read-only
  citations.
- No push/deploy: the proof engine operates entirely on a local dangling specimen object
  built by path from the pinned base, in a scratch worktree.

---

## 11. Implementer's worklist (files & seams)

- `src/main/plans/plan-work-package-ingest.ts` — v2 `reachability` validation, exported shared
  validator, `reachability-invalid` diagnostic, `canonicalContent` fold, `schema_version`
  gate (+ tests in `plan-work-package-ingest.test.ts`).
- `src/main/database.ts` — extend `ReconciledPlanWorkPackageInput`; `applyPlanWorkPackageSnapshot`
  persists `schema_version` / `content_hash` / normalized obligations; new
  `plan_wp_reachability_obligations` + `plan_wp_reachability_evidence` tables; grandfather-row
  table + reconciliation `legacy-unmigrated` status; read/freshness accessors; guarded
  `ALTER TABLE ADD COLUMN` idiom, no FK cascade.
- Reconciliation + dispatch/assignment path — quarantine `legacy-unmigrated`; refuse dispatch
  of quarantined packages.
- New app-owned proof engine + `prove_reachability` MCP/IPC handler + `reachability-targets.ts`
  managed registry (with `registry.version` and `protected_test_paths`), with tests.
- `src/shared/constants.ts` — `PROVE_PRODUCTION_ENTRY_POINT_SKILL` managed body; edit
  `WORKER_CLAUDE_MD` (B3 duty), preserving the derivation chain to `*_AGENTS_MD`; version
  bumps + cumulative `previousHashes`.
- `src/main/supervisor/index.ts` — `PROPOSAL_TO_PLAN_TREE` entries for the v2
  `work-packages.md` contract, the `package.md` `Entry` section, and the new skill; scaffold
  entries for the skill across supervisor + worker lanes; version bumps + cumulative hashes.
- `ARC.md` / `OVERVIEW.md` — record the partial-remediation limitation (§8).

<!-- groupthink: Cluster B production-reachability enforcement, Lead Planner × Reviewer, Reviewer-approved 2026-08-08 -->


<!-- groupthink_run: 73a2b4f9 (mode=serial) -->
