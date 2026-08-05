# Recommendation: skill vs. scripted workflow for the proposal→plan journey

*2026-08-02. GroupThink deliberation, Lead Planner × Reviewer, three review rounds,
Reviewer-approved. Deliverable of `.lares/proposals/supporting/2026-08-02-skill-vs-workflow-deliberation-brief.md`.
Recommends the shape of the proposal→plan hardening journey (Phase P0) and the concrete
changes it implies to WP-P0A / WP-P0B / WP-P0C of
`.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`.*

**Decision: (C) hybrid — one self-contained `proposal-to-plan` skill root (dispatcher +
internal contract/activity references + one mechanical helper script), reusing the existing
`groupthink` orchestration for bounded deliberations. No new orchestration, no second skill
root, no journey driver process.**

Framing that governs the whole design: **disk artifacts are the resumable source of truth;
the responsible supervisor plus the skill's decision policy drives the work; `orient` derives
the *known* lifecycle state and presents *safe* next actions.** The folder is the durable
artifact authority and evidence source — not the driver, and not the whole of the state (see
the state boundary below).

---

## Why not (B), a scripted/orchestrated workflow

A journey-wide `run_orchestration` entry is the wrong tool, for a structural reason:

- The journey is **human-gated** (Promote is human-initiated, Implement is an explicit human
  trigger, scope needs human judgment), **disjoint in time** (ruling 12: deliberations are
  ordered mid-plan and land later), and **orientable by any agent but mutable only by the
  responsible supervisor** (rulings 17, 23). `run_orchestration` runs are **detached and
  run-to-completion** (a run returns a `runId` and drives itself to `complete` / `stalled` /
  `aborted`). Spanning this journey with such a runner would require inventing **durable
  orchestration state that competes with the on-disk artifact evidence** — a second authority
  the §R1/§R2 design exists to avoid.
- It also breaks the P0 "no app code" boundary and collides with the current-normative
  "**one skill root — no second root**" (§R0 WP-P0A/P0C).

**What orchestration *is* right for** — bounded, run-to-completion sub-steps, reusing existing
lanes:

- the optional **scope second opinion** (a worker/codex read, or a small groupthink);
- **each marked deliberation** (`groupthink` serial/parallel, keyed to one PLAN-INTENT);
- **research**, dispatched to the existing researcher lane.

No new orchestration for integration, packaging, or the journey. `deliberate → integrate` is
explicitly *not* one orchestration: integration is deliberately later, supervisor-owned, and
independently evidenced.

## Why not pure (A)

The activities are behaviorally distinct; a flat `SKILL.md` is large, burns context on every
load, and leaves no seam for the **post-gate ruling-24 decision** (whether parts of the
mechanical spine later become a workflow/orchestration). The fix is internal structure — not a
monolith and not multiple runtime roots.

---

## The recommended shape, concretely

One self-contained skill root. **"Self-contained" means no runtime dependency on any proposal
document outside the skill root** — not duplicating normative blocks. R0/R1/R2 live **once** as
internal contract references; activity playbooks load the contract they need.

```
.claude/skills/proposal-to-plan/          (+ .agents/skills/proposal-to-plan/ for codex)
  SKILL.md                       ← dispatcher: public modes, lane rules, rung ladder in brief,
                                    pointers into references/. Small; loads every time.
  references/
    contracts/
      folder-schema.md           ← §R0 verbatim (canonical, single copy)
      intent-lifecycle.md        ← §R1 verbatim (sentinels, rung ladder, re-entry)
      arc.md                     ← §R2 verbatim
      manifest-lock.md           ← §P3-MANIFEST-LOCK protocol (helper-only; no hand-edit path)
    activities/
      capture.md                 ← write a stamped flat proposal; zero ceremony
      scope.md                   ← hardening triage + optional 2nd opinion; OWNS marking + the verdict
      promote.md                 ← OWNS atomic scaffold of a fully-complete folder (incl. plan.md)
      deliberate.md              ← launch groupthink / research (existing lanes), keyed to an intent
      integrate.md               ← validate returned output; fold-in reference + PLAN-INTEGRATION
      package.md                 ← decompose hardened plan into bundle-contract-shaped WPs
      orient.md                  ← re-entry interpreter; OWNS the decision table below
  scripts/
    plan-manifest.mjs            ← scaffold + locked plan.json CAS + read-only inspect
```

### Public modes vs. internal playbooks

**Public entry modes (7):** `capture`, `scope`, `promote`, `deliberate`, `integrate`,
`package`, `orient`.

- **Marking is owned inside `scope`** (ruling 27: scope's output *is* the marked-up proposal).
  No standalone `mark` mode — it would either duplicate `scope` or permit marking that bypasses
  hardening triage.
- **`promote` is a distinct public mode** — a deliberate mechanical transition invoked after
  scope/markup is complete; it owns the atomic scaffold.
- Only the seven names are user-facing entries; the other `activities/` files are internal
  playbooks the dispatcher routes to. (Supersedes the plain-language guide §3's "three modes";
  the underlying *activities* remain five.)

### The promotion boundary — atomic, complete-folder rename

Marking happens on the **flat proposal**, before `plan.md` exists (ruling 28). Promotion then
builds a **fully-complete** folder in a temp sibling and renames it in one move — the watcher
never observes a half-valid folder or a post-rename interval with an incomplete `plan.md`:

```
scope/mark the flat proposal (.lares/proposals/…), incl. the ## Hardening scope verdict
  → create sibling temp folder
  → write plan.json, ARC.md, seeded subdirs, AND plan.md (copied from the already-marked proposal)
     into the temp folder
  → fsync as required
  → atomically rename the COMPLETE folder into the deterministic target
  → continue hardening (deliberate / integrate / package)
```

- Marking still predates `plan.md`'s existence; the copy into `plan.md` happens **inside the
  temp folder during promotion**, so the renamed folder is valid the instant it appears.
- **`EEXIST` on the target** → orient against the existing folder and **validate it claims the
  same `source_proposal.artifact_id`**. Matching → orient/resume. Mismatching → report a
  collision and **block**; never adopt an unrelated occupant of the deterministic path.

### Trivial-scope verdict — durable home

Absence of intents alone cannot distinguish "scope completed, nothing needs hardening" from
"scope never happened." So `scope` **always** records an explicit, low-ceremony,
**human-readable** verdict:

- A required **`## Hardening scope`** section in the proposal, carrying the **dated supervisor
  verdict** and the **second-opinion disposition** (who was consulted / that none was).
  Migrated into `plan.md` during promotion and summarized under **`ARC.md` → Decisions**.
- This is prose in an existing document — **not a new sentinel.** If a machine-parseable
  verdict is later wanted, that is a **proposed contract amendment** (flagged in Deferred), not
  something invented here.
- `orient` reads it: **explicit verdict present** → scope complete (trivial verdict → no
  intents required); **no intents and no verdict** → scope status **unknown/incomplete, do not
  infer readiness.**

### `orient` decision table (safe, pre-P2L; no auto-relaunch)

`ran` is server-witnessed and **unavailable from disk** until P2L. `orient` reports
launch-state ambiguity and never auto-relaunches. The **script derives evidence; the supervisor
chooses any judgment-bearing action.**

| Disk evidence | `orient` reports | Safe next action |
|---|---|---|
| intent marked; `ran` unavailable; no present output | launch state **unknown** | inspect known run context; **ask the supervisor** whether to launch or rerun — do **not** auto-launch |
| ≥1 valid `active` output, not referenced | returned, **unfolded → open** | `integrate` that exact output |
| every present `active` output referenced | fully folded | continue hardening / `package` if otherwise ready |
| output present but malformed / identity-mismatched | **invalid, not returned** | quarantine + report; do **not** integrate |
| intent superseded / withdrawn | historical, **not open** | no launch, no integration |
| explicit trivial-scope verdict present, no intents | scope complete; **hardening intentionally skipped** | proceed to hardening / `package` |
| no intents **and** no explicit verdict | scope status **unknown/incomplete** | do **not** infer readiness; run/complete `scope` |

---

## State boundary (what is *not* in the folder)

- Before promotion the marked proposal lives under `.lares/proposals/`, not in a plan folder.
- The authoritative `ran` signal is server-witnessed and **unavailable from disk pre-P2L**.
- A **detached deliberation may be running** with no returned artifact yet (hence "launch state
  unknown", not "offer to deliberate").

## Concurrency (lock scope stated honestly)

The manifest lock serializes **`plan.json` mutation only** — it protects manifest integrity. It
does **not** serialize edits to the proposal, `plan.md`, or `ARC.md`, and an append-only
responsibility event does not by itself prevent two supervisors from editing. Therefore:

- The plan is **orientable by any agent; mutable only by the current responsible supervisor**
  (last `assigned` event in `plan.json`), **or by a supervisor after explicit reassignment** (a
  new appended `assigned` event **before** any mutation).
- `orient` is read-only and may be run by anyone; `mark` / `integrate` / `package` may not.

---

## Inventory (names + one-line purpose)

| Kind | Name | Purpose |
|---|---|---|
| Runtime skill (1 root) | `proposal-to-plan` | Whole journey; dispatcher + internal contracts + activity playbooks. |
| Contract reference | `folder-schema` / `intent-lifecycle` / `arc` / `manifest-lock` | §R0 / §R1 / §R2 / lock protocol, each stored **once**. |
| Activity playbook | `capture` / `scope` / `promote` / `deliberate` / `integrate` / `package` / `orient` | Per-activity best-practice detail, loaded on demand. |
| Helper script | `plan-manifest.mjs` (`scaffold` \| `manifest` \| `inspect`) | Atomic §R0 folder scaffold; locked `plan.json` CAS (all creation/mutation); read-only inspection dump. |
| Reused orchestration | `groupthink` via `run_orchestration` | Bounded deliberation, launched by `deliberate`. **Not new.** |
| Reused lane | researcher lane | Deep/multi-source research, dispatched by `deliberate`. **A dispatch lane, not a `run_orchestration` catalog entry.** |

### `plan-manifest.mjs` scope

Owns: (1) `scaffold` — build the **complete** §R0 folder (incl. `plan.md`) in a sibling temp
dir, atomic rename to target, `EEXIST` → defer to orient; (2) `manifest` — **all** `plan.json`
creation and mutation under §P3-MANIFEST-LOCK (owner+nonce `wx` acquire, 2s heartbeat, 15s
stale reclaim); (3) `inspect` — read-only dump of `plan.json` + folder listing.

**No hand-edit path exists.** The agent **never** edits `plan.json` directly. If the helper
cannot acquire the lock (exhaustion) or otherwise fails, that is a **clean error that blocks the
mutation and reports recovery guidance** (retry after the stale-reclaim window, or surface to
the supervisor) — there is no byte-exact fallback, and `manifest-lock.md` documents the
helper-only protocol accordingly.

**Rung derivation is not in the script for P0.** Full rung parsing (frontmatter identity,
containment, normalized Markdown-link resolution, per-output dispositions, malformed handling)
is security-sensitive and is the canonical work of the P1 reader / P2L ledger. For P0, `orient`
reasons over disk **in the playbook**, reporting `ran: unavailable`. No second canonical parser
ships and nothing is called a "reference implementation."

---

## How interruption / resume works

No process to resume — re-entry is a **read**:

1. Any agent opening an existing folder runs `orient` first (ruling 23): `plan-manifest.mjs
   inspect` + read `ARC.md` / `plan.json` / sentinels → report every intent's rung per the
   table **before doing anything new**.
2. The next action is **derived from disk evidence, offered, and gated on the supervisor** —
   never auto-executed, never auto-relaunched pre-P2L.
3. Disjoint-in-time deliberations (ruling 12) land whenever; `integrate` is a separate later act
   triggered by a valid returned artifact's presence, surfaced **open until folded**, never
   silently complete.
4. Mutation is confined to the current responsible supervisor; another supervisor reassigns
   first.

---

## Worker-package changes

### WP-P0A (amended) — proposal-to-plan skill (one root; dispatcher + contracts + activities + helper)

- **Files:** drafts under `.lares/proposals/supporting/scaffold-drafts/proposal-to-plan/`
  mirroring the tree: `SKILL.md`;
  `references/contracts/{folder-schema,intent-lifecycle,arc,manifest-lock}.md`;
  `references/activities/{capture,scope,promote,deliberate,integrate,package,orient}.md`;
  `scripts/plan-manifest.mjs`; plus `supervisor-agent-md.delta.md`, `worker-claude-md.delta.md`,
  `manual-install.md`. All paths outside `.claude/`.
- **Dep:** WP-P0PRE.
- **Do:** author **one** skill root — thin `SKILL.md` dispatcher (seven public modes + lane
  rules + rung-ladder summary + the dispatcher contract that mode selection replaces any
  per-turn sentinel obligation); four contract references (§R0/§R1/§R2/lock **verbatim, single
  copy**; `manifest-lock.md` is **helper-only, no hand-edit path**); seven activity playbooks
  loading only the contracts they need. `scope` owns markup **and** writes the required
  `## Hardening scope` verdict; `promote` owns the atomic **complete-folder** scaffold (writes
  `plan.md` from the marked proposal **into the temp folder before rename**) + migration of the
  verdict into `plan.md`/`ARC.md`; `orient` owns the decision table (with `ran: unavailable`).
  Author `plan-manifest.mjs` with `scaffold` / locked `manifest` CAS / read-only `inspect` (no
  rung parser; lock failure = clean blocking error with recovery guidance).
  `package` additionally owns **pre-implementation git prep**: before declaring the plan
  dispatch-ready it verifies (or creates) a local annotated baseline tag
  `plan-baseline/<plan-slug>` at the workspace HEAD, records the tag name + commit under
  `ARC.md` → Decisions and in `plan.md`, and **warns** (advisory, never blocking) when
  `git status` shows uncommitted edits the tag cannot capture. Recovery framing: any code a
  plan later deletes is one `git show <tag>:<path>` away — deletion WPs need no copy-aside
  archiving. (Once WP-P5C's per-run `baseline_ref` exists this tag becomes belt-and-braces;
  the skill step stays, as the human-visible recovery point.)
- **Accept:**
  1. `scope` marks the **flat proposal** before any `plan.md` exists and records a dated
     `## Hardening scope` verdict + second-opinion disposition;
  2. a **trivial-scope verdict** produces **no artificial intent** and is durably recorded
     (verdict section), so `orient` distinguishes it from "scope never happened";
  3. `promote` produces a **complete** folder via **temp-dir → atomic rename** with `plan.md`
     already inside the temp folder (no post-rename incomplete-plan interval);
  4. `EEXIST` with **matching** `source_proposal.artifact_id` → orient/resume; **mismatching** →
     collision reported, enrichment blocked, occupant untouched;
  5. `orient` reports **`ran` unknown/unavailable without relaunching**, and reports
     **no-intents-no-verdict as scope-incomplete** (never as ready);
  6. **multiple outputs** for one intent remain independently open/folded;
  7. supervisor-only actions (`mark` / `integrate` / `package`) **reject or instruct** a
     non-supervisor lane;
  8. **reassignment precedes mutation** by a new supervisor (read-only `orient` allowed;
     mutation without a fresh `assigned` event refused);
  9. `plan-manifest.mjs` **lock exhaustion returns a clean blocking error** and the agent
     performs **no direct `plan.json` edit**;
  10. malformed frontmatter, `..`-traversal, broken/unresolved Markdown links, and mixed
      `\`/`/` separators **do not count as returned/folded**;
  11. a fresh `git clone`/checkout preserves all three seeded subdirs (`.gitkeep`);
  12. markup sentinels parse as valid JSON; `orient` re-run refreshes `ARC.md`/`ARC-META`
      without clobbering;
  13. `package` creates-or-verifies the `plan-baseline/<plan-slug>` tag, records it in
      `plan.md`/`ARC.md`, warns on uncommitted edits without blocking, and **never pushes**
      the tag (local only).
- **Non-goals:** no `constants.ts` edit (P0C); no DB (P2L); no promotion *service* (P3); no
  second runtime skill root; no canonical rung parser (P1/P2L).
- **Verify:** peer read; markdown lint; `node` dry-run of `plan-manifest.mjs` (`scaffold` incl.
  both `EEXIST` branches and complete-folder-before-rename; `manifest` CAS incl. concurrent-append
  retention and lock-exhaustion error; `inspect`); dry-run all seven modes in a scratch workspace
  incl. clone-preservation. *(If over one context, split into WP-P0A-draft and WP-P0A-review
  against the **same single root**.)*

### WP-P0B — **unchanged**

Ceremony prompt-contract removal + trusted format-gate only; shape-independent. The
dispatcher-contract sentence lives in **WP-P0A's `SKILL.md` and the scaffold deltas**, not here.
Keep the existing note that PLAN-INTENT/PLAN-INTEGRATION are watcher-read doc markup, outside
`assertPlanRailFree`.

### WP-P0C (amended) — deploy the whole skill tree, both lanes, hash-guarded stale-file discipline

- **Do:** deploy the **entire `proposal-to-plan/` tree** (SKILL.md + every `references/**` +
  `scripts/plan-manifest.mjs`) into the Claude root (`.claude/skills/proposal-to-plan/…` via
  `SUPERVISOR_FILES` + `WORKER_FILES_CLAUDE`) and the Codex root
  (`.agents/skills/proposal-to-plan/…` via `SUPERVISOR_FILES_CODEX` + codex worker map).
  Enumerate **mechanically** — list every file as a versioned constant in
  `src/shared/constants.ts` registered in the lane manifests, **or** define a generated
  directory manifest for the tree; do not hand-wave "each as a versioned constant." Follow
  `scaffold-content-needs-version-bump` (freeze current live `SUPERVISOR_AGENT_MD` /
  `WORKER_CLAUDE_MD` into `previousHashes`, author `_V20`/`_V9`, bump the scaffold-map version).
  New scaffold bodies (Claude **and** Codex) carry the plain "where planning artifacts live"
  section (Edward 2026-08-02).
- **Hash-guarded stale-file cleanup:** a file dropped from the manifest is **never deleted
  merely for disappearing.** Removal is allowed **only when the on-disk bytes match a known
  prior scaffold hash** (i.e. an unmodified managed file); a **modified** retired file is
  **preserved and reported/migrated around**, never clobbered.
- **Accept:** migration + worker-scaffold suites green; whole tree present after
  rebuild+relaunch+next launch, verified on a **Claude lane specifically**; **both** stale-file
  cases tested — an **unchanged** retired file is removed, a **modified** retired file is
  preserved; Codex map carries the tree.
- **Verify:** `npm run build`; scaffold-migration + worker-scaffold suites.

---

## Deferred

- The **`ran` rung is already normative** (§R1) — nothing about it is semantically deferred.
  Deferred to **P2L** is its **authoritative availability and ingestion** (the server-witnessed
  `orchestrations.planning_intent_id` join). **P0 exposes `ran: unavailable`** and **never**
  substitutes a filename, a self-declared `orchestration_id`, or absence-of-output for it.
- **A machine-parseable trivial-scope verdict** — P0 records the verdict as human-readable prose
  (`## Hardening scope`); promoting it to a parseable sentinel is a **proposed §R1 contract
  amendment**, out of scope here.
- **Extracting any activity into a real orchestration** — the post-gate ruling-24 decision; the
  contract/activity seams make it cheap, but not now.
- **UI sequencing of the journey** — P1 reader / P2 gallery *render* disk rungs; they never
  drive the journey.

---

## Conflict flags

1. **No fatal conflict.** Honors ruling 23 (supervisor owns the plan; orientable by any agent,
   mutable only by the responsible supervisor / post-reassignment), ruling 17 (re-entrant,
   non-strict), rulings 24–25 (whole-journey skill; structured artifacts + helper script as the
   skill↔surface contract), rulings 27–28 (scope → marked proposal; marking before `plan.md`),
   and the "one root" P0 normative.
2. **Resolved tension:** "each activity feels like its own skill" (Edward) vs. "one root" (P0)
   → activities are **playbook files** (behaviorally separate, extraction-ready), not runtime
   roots. Literal separate skills would overturn current-normative P0 §R0 and must be a
   deliberate amendment, not a P0A drafting choice — advised against pre-gate.
3. **Doc drift, minor:** plain-language guide §3 ("three modes") should be refreshed to the
   seven public modes; it is explicitly "not a spec."

---

<!-- groupthink: skill vs. scripted workflow for the proposal→plan journey, Lead Planner × Reviewer, 3 rounds, approved 2026-08-02 -->


<!-- groupthink_run: 2850dad1 (mode=serial) -->
