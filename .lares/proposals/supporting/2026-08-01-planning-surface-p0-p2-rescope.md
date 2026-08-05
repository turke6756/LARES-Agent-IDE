# Planning-surface P0–P2 Rescope + Intent-Ledger Stage + Attribution Notes

**Status:** executable rescope — GroupThink deliberation, Lead Planner × Reviewer, seven review
rounds, Reviewer-approved 2026-08-01. Folds Amendments II (rulings 10–23) of
`.lares/proposals/2026-07-30-planning-surface-revamp.md` into stages **P0, P1, P2** of
`.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md`, adds a new
**Stage P2L (planning intent ledger)**, and records **attribution alignment notes**.

**Bounded scope.** This is a **rescope, not a redo**. It amends **P0/P1/P2** and adds **P2L**.
It **does not redesign** P3–P8, the **promotion-demand gate K**, the git join, or the
**shared bundle/stamping contract (wire v1, doc rev 3)** (`.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`).
P3 receives an explicit **alignment note (§R-P3)**; P6D/P7 receive **alignment constraints
(§R-ATTR)**; the P3–P4 and P5–P8 stage text is otherwise left intact.

**Authority.** Subordinate to the revamp **Amendments 10–23** (authoritative over the proposal
body and over Amendments 1–9 where they conflict) and to the **bundle contract (wire v1, doc rev 3)** on the
stamping seam. This document supersedes the **P0/P1/P2** stage text of the parent implementation
plan where it conflicts; everything in the parent plan not restated here carries forward
unchanged (including the WP-P0PRE / WP-P0B / WP-P1C / WP-P1S / WP-P2C-compat bodies).

**Anchor policy.** Symbolic anchors (file / function / table / constant names) are authoritative;
line numbers are orientation only — this repo is actively edited and numeric anchors drift.

**Per-WP shape.** Every worker package lists **Files · Dep · Do · Accept · Non-goals · Verify**
and fits one worker context. Verify templates follow the parent plan §0.1:

```powershell
# Main/shared single test
npm run build:main
node dist/main/<compiled-test-path>.js

# Renderer single test
npx vitest run --config vitest.config.ts <renderer-test-file>

# Full main suite
npm run test:supervisor
```

Every new main/shared test registers in `scripts/run-main-tests.mjs` or `npm run test:supervisor`
silently omits it; each stage ends with an integration gate that owns the registry edit so
parallel WPs never contend.

---

## §R0 — NORMATIVE: the folder-per-plan structure (rulings 10, 11, 21)

Filesystem-owned; the DB **ingests and enriches**, never owns (ruling 10).

**Bare proposal (unchanged):** a flat markdown `<.lares/proposals/<YYYY-MM-DD>-<slug>.md>` with
portable `artifact_id` frontmatter and **no** additional structure. Valid as a terminal state.

**Canonical plan-folder home:** **`<workspaceStateDir(workspace)>/plans/`** — resolves to
`.lares/plans/`, or the `.dashboard` fallback, via `translateStateRelPath`. This is **distinct
from the legacy workspace-root `plans/`** directory that holds flat HTML/markdown plans. All
plan-folder paths in this rescope mean the **state-dir** home.

**Plan folder:** `<…/plans/<plan-sku>/>` where **`plan-sku = <YYYY-MM-DD>-<slug>-<artifact-short>`**
(`artifact-short` = first 8 hex of `plan_artifact_id`) — collision-safe. **The SKU is display /
path metadata only, never durable identity.** Layout:

```
<workspaceStateDir()>/plans/<plan-sku>/
  plan.json              # CANONICAL machine-readable manifest (below). Folder-is-a-plan signal.
  plan.md                # hardened plan document; PLAN-INTENT sentinels (§R1) + Markdown-link phase refs.
  ARC.md                 # summary of durable records (§R2, ruling 21) — cheapest read tier.
  deliberations/.gitkeep # scoped groupthink outputs (ruling 11); each carries §R1 output frontmatter.
  research/.gitkeep      # scoped research findings.
  supplements/.gitkeep   # supplementary documents.
```

**`plan.json` — canonical disk metadata:**

```json
{
  "schema_version": 1,
  "plan_artifact_id": "plan_<hex>",
  "plan_sku": "<date>-<slug>-<artifact-short>",
  "source_proposal": { "artifact_id": "prop_<hex>", "rel_path": ".lares/proposals/<slug>.md" },
  "responsibility_events": [
    { "event_id": "rev_<hex>", "event": "assigned", "agent_id": "<id>", "display": "<snapshot>",
      "at": <ms>, "source": "manual-skill" | "promotion-service" }
  ],
  "created_at": <ms>, "updated_at": <ms>
}
```

- **Folder-is-a-plan signal (mechanically inspectable):** `plan.json` present with a valid
  `plan_artifact_id`. All ingestion keys on **`plan_artifact_id`**, never the SKU/slug.
- **Plan identity:**
  - **Promotion-service scaffold (no existing folder):** deterministic
    **`plan_artifact_id = "plan_" + <proposal artifact hex>`** at a **deterministic folder path**
    — so a retry after app restart converges on the same folder/id without any in-memory lock.
  - **Manually scaffolded folder:** keeps its **existing valid `plan_artifact_id`** (which may be
    independently minted); it is discovered by the promotion **claim-scan matching
    `plan.json.source_proposal.artifact_id`**, and its identity is retained, never rewritten.
- **Responsibility is disk truth (append-only history; rulings 19, 22, 23).** The **current
  responsible supervisor = the last `assigned` event.** Reassignment **appends** (stable
  `event_id`), never overwrites — "who was responsible when the work happened" is recoverable. DB
  responsibility (`plans.responsible_supervisor_id`, P3A) **enriches**; disk history is the durable
  record. All `plan.json` mutations use the no-clobber CAS discipline of **§R-P3**.
- **`.gitkeep` placeholders.** The three subdirs ship a tracked `.gitkeep` so the structure
  survives clone/checkout (Git does not track empty dirs). Readers suppress `.gitkeep` and
  `plan.json` from the document UI.
- **Relationship to the source proposal.** The source proposal stays at
  `.lares/proposals/<slug>.md` (state → `promoted`, linked via `plan_documents`). `plan.md` is the
  **hardened plan document** authored by the planning skill; it references the proposal +
  deliberations by path. The folder watcher scopes to **directories** under the state-dir plans
  home; legacy `.html` **files** are never treated as plan folders.

---

## §R1 — NORMATIVE: PLAN-INTENT markup + machine-checkable lifecycle (rulings 13, 16, 17, 20)

The planning agent's markup/intent pass etches intent **durably in the canonical marked document**
(the proposal during the markup pass; migrated into `plan.md` on hardening).

**PLAN-INTENT sentinel** — valid JSON (the optional supersede field is added to the same object,
never as a comment):

```html
<!--PLAN-INTENT
{ "intent_id": "int_8hex", "part": "attribution-timing",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "one line: why this part needs deliberation" }
-->
```

Reopening a decision adds one field to the same object — `"supersedes_intent_id": "int_prev"` —
and **mints a new `intent_id`**; sentinels are **never silently reused**.

**Deliberation / research output frontmatter (required).** Every in-folder output declares its
linkage; `returned` derives from this, never from a filename convention:

```yaml
---
plan_artifact_id: plan_<hex>
intent_id: int_8hex
orchestration_id: orc_<id>     # worker SELF-DECLARATION; honored only as a cross-check
kind: deliberation | research
---
```

The self-declared `orchestration_id` is **not** the authoritative `ran` signal — the authority is
the server-witnessed `orchestrations.planning_intent_id` (§P2L).

**PLAN-INTEGRATION record — JSON sentinel, adjacent to the reference, per exact output** (robust to
quotes/markup in `changed`):

```html
<!--PLAN-INTEGRATION
{ "intent_id": "int_8hex", "output_rel_path": "deliberations/2026-08-01-attr.md",
  "changed": "what the deliberation changed", "disposition": "active" }
-->
```

`disposition` ∈ `active | superseded | withdrawn` (default `active`).

**Lifecycle chain — every rung answered by inspection, machine-checkable (ruling 16):**

| Rung | Authoritative signal |
|---|---|
| **marked** | a valid `PLAN-INTENT` sentinel exists in the canonical marked doc |
| **ran** | a **server-witnessed** orchestration linked to this intent exists (`orchestrations.planning_intent_id`, joined on `(plan_id, planning_intent_id)`) — a required rail, not a heuristic; **unavailable pre-ledger** |
| **returned** | ≥1 **currently-present** in-folder output whose frontmatter `intent_id` + `plan_artifact_id` match |
| **folded-in** | a **normalized Markdown link** in the relevant `plan.md` phase **resolves (containment + existence)** to that exact present output — a raw textual substring is explicitly insufficient (false-positives on prose / code fences / comments) |

**Per-output rung rules (reruns produce multiple outputs; the surface lists each result
independently so one folded rerun never hides another pending result):**

- `returned` = **≥1 currently-present** output.
- `fully_folded_in` = **every currently-present `active` returned output is referenced**;
  `superseded`/`withdrawn` outputs are excluded from the requirement.
- **Any present, `active`, unfolded output keeps the intent open.**

**Re-entry semantics (ruling 17):**

- A **rerun of the same still-open intent** → another orchestration under the **same `intent_id`**;
  potentially another output artifact (all retained, §P2L).
- A **superseding / reopened decision** → a **new `intent_id`** carrying `supersedes_intent_id`.
- **Removed or superseded marks stay historical** and render **withdrawn / superseded**, never as
  current satisfaction.
- **Scanner reconciliation** is presence-aware and scan-transactional — see WP-P2L-ingest.

---

## §R2 — NORMATIVE: ARC summary file (ruling 21)

`ARC.md`, committed with the plan folder, is the cheapest tier of the Amendment-18 altitude ladder
— an agent reads the whole arc from disk with **zero DB access**. It is a **summary of durable
records** that **cites** them; it is **not** itself the attribution authority (a skill-authored
prose row never substitutes for work-time stamping — see §R-ATTR).

**Ownership (ruling 29, 2026-08-02):** `ARC.md` is written and maintained by the **responsible
supervisor** (created at promote; refreshed by the orient and integrate activities). This
ownership is stated explicitly in the skill AND in the scaffolded supervisor CLAUDE.md/AGENTS.md
(WP-P0C) — never merely implied.

```markdown
# ARC — <plan title>   (plan_sku: <sku> · plan_artifact_id: <id>)
<!--ARC-META { "last_refreshed_at": <ms>, "source_cutoffs": { "folder_mtime_ms": <ms>, "ledger_updated_at": <ms> } } -->
## Decisions          — <dated decision → rationale>, newest last
## Work packages       — <id> <title> — <state> — <responsible/assignee>
## Deliberations       — <part> — <rung> — <output ref> — <PLAN-INTEGRATION summary, cites intent_id/orchestration_id>
## Who did what        — cites durable refs (intent→orchestration links, turn stamps, commit records, §R-ATTR), NOT prose-as-authority
```

**Freshness contract.** `ARC-META.source_cutoffs.folder_mtime_ms` is the **max mtime over source
artifacts only** (`plan.md`, outputs, `plan.json`) — **excluding `ARC.md` itself**, so refreshing
ARC cannot destabilize its own cutoff. The skill's **orient** and **integrate** modes must
**refresh ARC from current disk/ledger evidence** and update `ARC-META`. Staleness =
`last_refreshed_at` older than the source max mtime or the ledger's `updated_at`; readers may flag
a stale ARC rather than silently present it as the whole current arc.

---

## STAGE P0 (amended) — proposal capture + single planning skill (modes) + ceremony subtraction + probe

**Stage non-goals:** no registry/watcher/gallery/DB schema; no `create_plan`/legacy HTML; no
mission board; promotion *service* not yet available; **no DB intent ledger here** — P0 etches
intent/ARC **to disk only**.
**Stage user-visible acceptance:** supervisors author proposals with zero ceremony **and**, when
hardening, scaffold a plan folder (§R0) with `plan.json` (incl. responsible supervisor), run the
markup/intent pass (§R1), and maintain `ARC.md` (§R2) using their own fs tools — **no app code**.
Capture metric (N) accrues from voluntary-eligible `proposal_authored` events.

### WP-P0PRE — demand-probe append service
*Unchanged from the parent plan.* Carried forward verbatim.

### WP-P0B — ceremony prompt-contract removal + trusted format-gate
*Unchanged from the parent plan.* Note: PLAN-INTENT / PLAN-INTEGRATION are **watcher-read
planning-doc markup, not a per-turn agent obligation** — they are out of `assertPlanRailFree`'s
scope and do not reintroduce the retired every-turn sentinel.

> **Δ Rulings 24–25 (2026-08-01, post-deliberation), scope semantics superseded by
> ruling 27 (2026-08-02):** the skill's mode set below is extended by rulings recorded
> in the revamp proposal's Amendments II/III. **(a) A `scope` mode** sits between
> capture and promote: **scope = the hardening triage, NOT decomposition** (ruling
> 27). The responsible supervisor — ideally with an **independent second opinion**
> (e.g. a Codex-lane agent, or a small groupthink as the scoping vehicle) — decides
> which parts of the proposal need groupthink deliberation and which would benefit
> from online research; the scoping agents must be briefed on the hardening process
> itself; the output is the **marked-up proposal** (ruling 28: markup lands on the
> proposal document, before `plan.md` exists — already §R1's rule). "Nothing needs
> hardening — package and implement" is always a legitimate scope verdict. **(b) A
> `package` mode** closes the journey — worker-sized decomposition is the LAST step,
> after a defensible implementation plan exists (contract-shaped; the bundle-contract
> WP shape). The journey is capture → scope(+mark) → deliberate → integrate →
> package; mark/integrate/package are the **supervisor's** activities (ruling 29),
> and per ruling 25 the structured outputs (§R0/§R1/§R2) + helper scripts ARE the
> skill↔surface contract. WP-P0A's brief must reflect these modes (and the split
> option below then applies across the full mode set).
>
> **Δ Rulings 26–31 + pending shape decision (2026-08-02, guide review):** additional
> P0-relevant rulings from Amendments III: **ARC.md is supervisor-owned** and that
> ownership must be stated in the skill AND the scaffolded supervisor CLAUDE.md/
> AGENTS.md (ruling 29 — see WP-P0C); the scaffold must also carry the **orient-first
> rule** — a supervisor picking up a subscribed plan reads `plan.json` + `ARC.md` +
> intent markers FIRST (ruling 30). **Shape decision RULED (Edward, 2026-08-02):
> the journey ships as the HYBRID recommended by GroupThink run 2850dad1**
> (`supporting/2026-08-02-skill-vs-workflow-recommendation.md`, NORMATIVE for the
> skill's internal structure): ONE `proposal-to-plan` skill root — thin `SKILL.md`
> dispatcher + seven public modes (`capture / scope / promote / deliberate /
> integrate / package / orient`) + per-activity playbook files + single-copy
> contract references (§R0/§R1/§R2/lock) + `plan-manifest.mjs` helper — reusing the
> existing groupthink/researcher lanes for deliberations. No new orchestration, no
> second skill root, no journey driver process. Marking is owned inside `scope`;
> the trivial-scope verdict is a required `## Hardening scope` prose section.
> **Edward's rider:** scoping must treat BOTH kinds of hardening as live options
> for every part — groupthink deliberation AND online research — and a small
> groupthink is a legitimate vehicle for the scoping step itself. **HOLD LIFTED:
> WP-P0A/WP-P0C below are re-authored per the recommendation and dispatchable on
> Edward's GO.**

### WP-P0A (re-authored 2026-08-02 per the approved hybrid — recommendation doc is NORMATIVE) — proposal-to-plan skill (one root; dispatcher + contracts + activities + helper)
- **Files:** drafts under `.lares/proposals/supporting/scaffold-drafts/proposal-to-plan/`
  mirroring the runtime tree: `SKILL.md`;
  `references/contracts/{folder-schema,intent-lifecycle,arc,manifest-lock}.md`;
  `references/activities/{capture,scope,promote,deliberate,integrate,package,orient}.md`;
  `scripts/plan-manifest.mjs`; plus `supervisor-agent-md.delta.md`, `worker-claude-md.delta.md`,
  `manual-install.md` (dogfood hand-install so capture can start before P0C). All paths outside
  `.claude/`.
- **Dep:** WP-P0PRE.
- **Do:** author **one** skill root per the recommendation
  (`2026-08-02-skill-vs-workflow-recommendation.md`):
  - **Thin `SKILL.md` dispatcher** — seven public modes (`capture / scope / promote / deliberate /
    integrate / package / orient`) + lane rules (orient = anyone; mark/integrate/package =
    responsible supervisor only) + rung-ladder summary + the dispatcher contract that mode
    selection replaces any per-turn sentinel obligation.
  - **Four contract references** — §R0/§R1/§R2/§P3-MANIFEST-LOCK **verbatim, single copy each**;
    `manifest-lock.md` is **helper-only, no hand-edit path**.
  - **Seven activity playbooks**, each loading only the contracts it needs. `scope` owns the
    hardening triage AND the markup (no standalone mark mode): supervisor + independent second
    opinion (worker/codex read, or a small groupthink as the scoping vehicle — Edward's rider:
    **both hardening kinds — groupthink deliberation AND online research — are live options for
    every part**), output = the marked flat proposal + a required dated **`## Hardening scope`**
    verdict section (incl. second-opinion disposition; "nothing needs hardening" is a legitimate
    verdict, distinguishable from scope-never-ran). `promote` owns the atomic **complete-folder**
    scaffold: build `plan.json` (incl. `responsibility_events[0]` `manual-skill` `assigned` event
    with stable `event_id`), `ARC.md`, seeded subdirs, AND `plan.md` copied from the already-marked
    proposal **inside the temp sibling folder before the atomic rename** (no post-rename
    incomplete-plan interval), migrating the verdict into `plan.md`/`ARC.md`; `EEXIST` → orient
    against the occupant and **only resume on matching `source_proposal.artifact_id`**, else
    report a collision and block. `deliberate` launches the **existing** groupthink orchestration
    or researcher lane keyed to one `PLAN-INTENT`. `integrate` validates/adopts the
    worker-authored output (frontmatter identity + containment; pre-ledger, `ran` =
    **unavailable**, never promote self-declared `orchestration_id`), folds by Markdown-link
    reference + per-output `PLAN-INTEGRATION` record, refreshes `ARC.md`/`ARC-META`. `package`
    decomposes the hardened plan into bundle-contract-shaped WPs (last step). `orient` owns the
    recommendation's **decision table**: derive every intent's rung from disk, report
    `ran: unavailable` without relaunching, treat no-intents-no-verdict as scope-incomplete,
    surface safe next actions and gate judgment-bearing ones on the supervisor.
  - **`plan-manifest.mjs`** with `scaffold` (atomic complete-folder build) / `manifest` (**all**
    `plan.json` creation/mutation under §P3-MANIFEST-LOCK: owner+nonce `wx` acquire, 2s heartbeat,
    15s stale reclaim, CAS inside the lock) / `inspect` (read-only dump). **No rung parser** (that
    is P1/P2L canonical work); lock exhaustion = clean blocking error with recovery guidance.
- **Accept:** the recommendation's twelve acceptance criteria verbatim (its §"Worker-package
  changes", WP-P0A Accept 1–12): scope marks the flat proposal pre-`plan.md` + records the dated
  verdict; trivial verdict durable with no artificial intent; complete-folder atomic rename; both
  `EEXIST` branches; `ran` reported unavailable without relaunch + no-intents-no-verdict =
  scope-incomplete; multiple outputs independently open/folded; supervisor-only actions
  reject/instruct other lanes; reassignment precedes mutation; lock exhaustion blocks with no
  direct `plan.json` edit; malformed frontmatter / `..`-traversal / broken links / mixed
  separators never count as returned/folded; clone preserves seeded subdirs; sentinels parse as
  valid JSON and orient re-run refreshes ARC without clobbering.
- **Non-goals:** no `constants.ts` edit (P0C); no DB (P2L); no promotion *service* (P3); **no
  second runtime skill root**; no canonical rung parser; no new orchestration.
- **Verify:** peer read; markdown lint; `node` dry-run of `plan-manifest.mjs` (scaffold incl. both
  `EEXIST` branches + complete-folder-before-rename; manifest CAS incl. lock-exhaustion error;
  inspect); dry-run all seven modes in a scratch workspace incl. clone-preservation.

*(If P0A exceeds one worker context, split into **WP-P0A-draft** (write the tree) and
**WP-P0A-review** (lint + dry-run all modes + clone check) against the **same single root**,
sequential — never a second runtime skill root.)*

### WP-P0C (amended) — scaffold deploy via version-bumped constants
- **Files:** `src/shared/constants.ts`; `src/main/supervisor/index.ts` (manifests `SUPERVISOR_FILES`,
  `WORKER_FILES_CLAUDE`, `SUPERVISOR_FILES_CODEX` + codex worker map);
  `src/main/supervisor/scaffold-version-migration.test.ts`;
  `src/main/supervisor/worker-scaffold.test.ts`.
- **Dep:** WP-P0A (content), WP-P0B (worker-md ceremony text must match the retired injection).
- **Do (re-authored 2026-08-02 per the approved hybrid):** deploy the **entire
  `proposal-to-plan/` tree** (SKILL.md + every `references/**` + `scripts/plan-manifest.mjs`)
  into the Claude root (`.claude/skills/proposal-to-plan/…` via `SUPERVISOR_FILES` +
  `WORKER_FILES_CLAUDE`) and the Codex root (`.agents/skills/proposal-to-plan/…` via
  `SUPERVISOR_FILES_CODEX` + codex worker map). Enumerate the tree **mechanically** — every file
  as a versioned constant registered in the lane manifests, or a generated directory manifest —
  no hand-waving. Freeze the current live `SUPERVISOR_AGENT_MD` / `WORKER_CLAUDE_MD` bodies
  byte-exact as `previousHashes[19]` / `previousHashes[8]`; author `SUPERVISOR_AGENT_MD_V20` /
  `WORKER_CLAUDE_MD_V9`; bump the scaffold-map `version`; follow
  `scaffold-content-needs-version-bump` (freeze-then-derive; migration tests). **One skill root —
  no second root.** **Hash-guarded stale-file cleanup:** a file dropped from the manifest is
  never deleted merely for disappearing — removal only when on-disk bytes match a known prior
  scaffold hash (unmodified managed file); a **modified** retired file is preserved and
  reported/migrated around, never clobbered.
  **(Edward, 2026-08-02): the new scaffold bodies — Claude AND Codex lanes — MUST carry a plain
  "where planning artifacts live" orientation section:** proposals are flat markdowns in
  `.lares/proposals/` (deliberation/detail docs in `supporting/`), plan folders live under
  `<workspaceStateDir()>/plans/` (§R0), and the `proposal-to-plan` skill is how agents create or
  resume them. The app tells agents where these homes are via these scaffolded CLAUDE.md/AGENTS.md
  files — agents never guess paths.
  **(Edward, 2026-08-02, rulings 29–30): the SUPERVISOR scaffold bodies must additionally state:
  (a) `ARC.md` is written and maintained by the plan's responsible supervisor — creating it at
  promote and refreshing it on orient/integrate is YOUR job, not a worker's; and (b) the
  orient-first rule — if you are subscribed to a plan and picking it up, `plan.json` + `ARC.md` +
  the intent markers are the FIRST place you look, before doing anything new.**
- **Accept:** migration + worker-scaffold tests green; deployment = rebuild + relaunch + next
  agent launch with the **whole tree present**, verified on a Claude lane specifically (Codex
  regenerates CODEX_HOME unconditionally and would false-positive); **both stale-file cases
  tested** — an unchanged retired file is removed, a modified retired file is preserved; Codex
  map carries the tree.
- **Non-goals:** no behavior beyond deployment.
- **Verify:** `npm run build`; scaffold-migration + worker-scaffold suites.

**Integration gate P0Z:** register WP-P0PRE/P0B main tests in `scripts/run-main-tests.mjs`;
`npm run build:main && npm run test:supervisor`; renderer + scaffold suites green.

**Stage P0 graph:** `WP-P0PRE → {WP-P0A ∥ WP-P0B} → WP-P0C → P0Z`.

---

## STAGE P1 (amended) — filesystem reader: proposals + plan folders, hardened path handling (PRE-GATE)

**Stage non-goals:** no `proposals` table/watcher/DB mutation/gallery/promotion; read-only
filesystem enumeration only; no folder DB registration (P2); no rich tabbed surface (P4).
**Stage user-visible acceptance:** bare proposals and hand-scaffolded plan folders (§R0) browsable
read-only, with the §R1 lifecycle **derived from disk**; browsing (M) = voluntary-eligible
`reader_open` + `savecard_open`; promotion demand (K) accrues from voluntary-eligible
`promotion_requested`. Initial render/refresh never counts as an open.

### WP-P1A (amended) — bounded enumeration + safe read IPC (neutral surface, hardened)
- **Files:** new `src/main/plans/planning-reader.ts`; IPC **`planning-reader:list` /
  `planning-reader:read`** (+ optional `plan-folder-reader:*` sub-channels) in
  `src/main/plans/plan-ipc.ts`; `src/shared/types.ts`; test `planning-reader.test.ts`.
  **Renamed off `proposal-reader`** — update P1B/P1C/P2D references accordingly.
- **Dep:** WP-P0PRE.
- **Do:** enumerate flat `.lares/proposals/*.md` **and** §R0-valid **directories** under
  `<workspaceStateDir()>/plans/*/` (honor `.dashboard` fallback via `translateStateRelPath`). For
  each folder return a bounded manifest of documents, each identified by an **opaque server-issued
  manifest document ID** (or a server-validated relative path) — **no raw absolute path leaves
  main**; the renderer reads only by manifest ID. Reads enforce: **workspace + plan-folder
  containment; symlink/junction/reparse-point rejection (realpath must stay inside the folder);
  nested-traversal + mixed-separator (`\`/`/`) normalization; per-file byte cap AND total manifest
  count/byte caps; `.gitkeep`/`plan.json` suppressed from the document set**. Parse §R1 sentinels +
  output frontmatter + `plan.md` Markdown links **read-only** to derive each intent's rung for
  display — show **marked / returned / folded-in**; **`ran` is "unavailable until ledger
  enrichment"** and the self-declared `orchestration_id` is **never** presented as authoritative.
  Handle **folder rename, deletion, atomic replacement, and late `plan.md`/`plan.json` creation**
  without crashing (re-enumerate; absent → empty state). `reader_open` fires **only on a user
  gesture**; no DB touch; legacy `.html` excluded (directory scope).
- **Accept:** lists proposals + folders; manifest IDs opaque; **symlink/junction escape rejected;
  `..`-traversal + mixed separators rejected; per-file + total caps enforced; `.gitkeep`/`plan.json`
  hidden; rename/delete/atomic-replace/late-creation handled** (fixture for each); disk-derived
  rungs correct; `ran` shown unavailable pre-ledger; no write; no `reader_open` on mount.
- **Non-goals:** no registry/watcher/promotion; no DB.
- **Verify:** main/shared template (fixtures: bare proposal, valid folder, missing `plan.json`,
  stray dir, legacy `.html`, symlink-escape, `..`-traversal, mixed-separator, oversize file,
  oversize manifest, rename, delete, atomic-replace, late `plan.md`).

### WP-P1B (amended) — reader renderer pane (folder-aware, flat, disk-derived lifecycle)
- **Files:** new `src/renderer/components/plan/ProposalReaderPane.tsx` + read-only
  `ProposalReader.tsx`; Plans toolbar entry; `src/preload/index.ts`; tests
  `ProposalReaderPane.test.tsx`, `ProposalReader.test.tsx`. Consumes `planning-reader:*`.
- **Dep:** WP-P1A.
- **Do:** split-screen list + read-only markdown pane; date/title grouping; a **folder view** — when
  a plan-folder row is selected, show `plan.md` in the read pane plus a sibling list (deliberations
  / research / supplements) opened read-only by manifest ID, and a **disk-derived intent lifecycle
  strip** (marked / returned / folded-in; **`ran` rendered "unavailable (pre-ledger)"**; it may note
  "a returned artifact implies work occurred" but never presents a self-declared ID as the `ran`
  rung). No tabs/overviews/comments (P4). Voluntary opens instrumented on user gesture only.
- **Accept:** click-through reads both proposals and folder docs; lifecycle strip renders from disk;
  read-only; no open on mount/refresh.
- **Non-goals:** no promote button (P2D); no editing; no tabbed surface (P4).
- **Verify:** renderer Vitest template.

### WP-P1C — promotion-request capture (demand-metric source)
*Unchanged from the parent plan* except it now calls the renamed `planning-reader` affordance.

### WP-P1S — Save-card open instrumentation
*Unchanged from the parent plan.*

**Integration gate P1Z:** register P1A/P1C main tests; `npm run test:supervisor`; P1B/P1C/P1S
renderer Vitest; `npm run build`.

**Stage P1 graph:** `WP-P0PRE → WP-P1A → WP-P1B → WP-P1C → P1Z`; `SC-WP-1I + WP-P0PRE → WP-P1S`.

---

## ★ PROMOTION-DEMAND GATE K (K parameter; Edward sets) ★

*Unchanged; NOT moved.* Proceed to P2+ **only** when promotion demand reaches K over the probe
window (several weeks, not one). One quiet week does not kill the feature; Edward may grant one
explicit extension. If K is never reached: ship **WP-FB**, keep the tiny reader, fold conservative
execution evidence into the existing AttributionPanel, and build **no** registry/watcher/gallery/
promotion/mission-board/**ledger**.

**"Early" clarified:** the Amendment consequence calls the intent ledger "a new early stage."
*Early* means **before the promotion-page / execution stages (P3+)** — **not** pre-gate. P0/P1
already deliver the full zero-DB disk workflow + disk-derived lifecycle before any DB enrichment
ships; **P2L is post-gate**, immediately after P2. K is not moved to satisfy the word "early."

---

## STAGE P2 (amended) — durable registry + one-owner watcher (two roots) + folder ingest + gallery

**Stage non-goals:** no promotion/responsibility/dispatch/mission-board; structured plans never
enter HTML/projection/pane paths. The folder watcher *adopts/registers* structured rows from disk
but assigns **no** `responsible_supervisor_id` and does **no** dispatch (P3+).
**Stage user-visible acceptance:** the registry lists proposals + **folder-per-plan structured
plans adopted from disk** + legacy HTML "Legacy Plan" rows; existing `format='md'` rows stay hidden
historical records. **Gate check:** registry membership audited against the raw
`.lares/proposals/*.md` **and** valid `<workspaceStateDir()>/plans/*/` filesystem listings.

### WP-P2A (amended) — schema: proposals table + plans columns + md-row policy ⟨DDL⟩
- **Files:** `src/main/database.ts`; tests `database.proposals.test.ts`, `md-row-adoption.test.ts`.
- **Dep:** A2.
- **Do:** create the `proposals` table (as in the parent plan: `id, artifact_id, workspace_id, path,
  slug, title, state[proposal|promoted|archived], author_agent_id,
  author_role[supervisor|worker|unknown], author_display, authored_at, created_at, updated_at,
  mtime_ms, size_bytes, promoted_to_plan_id, deleted_at, UNIQUE(workspace_id, path)`) + partial
  unique indexes `(workspace_id, artifact_id)` and `(promoted_to_plan_id)`. **Five** guarded
  `ALTER plans ADD COLUMN`: `artifact_id`, `source_proposal_id`, `promoted_at`,
  `promoted_content_hash`, **`folder_rel_path`** (workspace-relative path to the plan folder, NULL
  for legacy/proposal-only rows). Partial unique indexes on `plans(workspace_id, artifact_id)`,
  `plans(source_proposal_id)`, and **`plans(workspace_id, folder_rel_path) WHERE folder_rel_path IS
  NOT NULL`**. `responsible_supervisor_id` is **NOT** here (added in P3A with its inline FK). md-row
  policy unchanged (existing `plans(format='md')` rows are hidden, preserved historical records,
  never shown/duplicated; diagnostic inventory-count accessor).
- **Accept:** tables/indexes idempotent; **five** plan ALTERs; `folder_rel_path` unique-per-workspace
  when present; md-row test — an `md` row whose path later appears in the reader/watcher registers
  once as a `proposals` row, the `md` row stays hidden, no dup.
- **Non-goals:** no watcher logic; no `responsible_supervisor_id`; no folder ingest.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-P2B — proposals-watcher (witnessed attribution, adopt/mint, policies)
*Unchanged from the parent plan.* Note: it owns `.lares/proposals/` only and does **not** own the
state-dir plans home (WP-P2B-folder).

### WP-P2B-folder (NEW) — two-root ownership; recursive-aware folder ingest; callback seam
- **Files:** extend **`src/main/plans-watcher.ts`** (the confirmed sole `fs-watcher.subscribe`
  owner for plan directories; `fs-watcher.ts` uses `chokidar.watch(dir, { depth: 0 })` —
  non-recursive) to a **one ownership module managing two roots + bounded child subscriptions**; new
  handler `src/main/plans/plan-folder-watcher.ts`; accessors in `database.ts` (uses WP-P2A columns
  only — **no schema of its own**); test `plan-folder-watcher.test.ts`.
- **Dep:** WP-P2A.
- **Do:**
  1. **Two explicit roots owned by `PlansWatcher`, never merged into one listing:**
     - **Legacy `<workspace>/plans/`** — flat HTML/markdown behavior **unchanged** (existing
       reparse pipeline).
     - **New `<workspaceStateDir(workspace)>/plans/`** — **structured plan directories only**,
       resolved via `workspaceStateDir()`/`translateStateRelPath`; **ensure this state-dir plans
       home on subscription init** (works without a supervisor launch).
  2. **Recursion via bounded child subscriptions (not root-only):** under the **new root**,
     `PlansWatcher` keeps the root subscription **plus** one bounded child subscription per **valid
     structured folder** and its designated subdirs (`deliberations/`, `research/`, `supplements/`)
     so **nested edits to `plan.md`, outputs, and integration references are observed** — a
     `depth:0` root watch alone would miss them. Child subs are lifecycle-bounded (added on adopt,
     torn down on folder removal) and **count-capped**.
  3. **Validity race + backstop:** folders arrive via the **atomic temp-dir → rename** of a
     fully-valid scaffold (§R0 / §R-P3), so a valid `plan.json` is present the instant the folder
     appears. A **periodic full state-dir reconciliation** additionally re-scans for folders that
     became valid without a rename event (e.g., an external tool) **and** for plans **beyond the
     child-subscription cap** — those receive periodic reconciliation **plus a surfaced
     `degraded-watch` diagnostic**, and **never silently stop updating.**
  4. **Idempotent adopt** keyed by `plan.json.plan_artifact_id`: structured `plans` row
     (`format='structured'`, `run_state='hardening'`, `folder_rel_path`, `path=<plan.md rel>`,
     `mtime_ms`/`size_bytes` from `plan.md`). **No `plans.author_*` write** — those columns do not
     exist and P2A adds none; gallery attribution comes from `plan.json` responsibility history +
     the durable attribution projection (§R-ATTR). **Convergence with P3:** the `(workspace_id,
     artifact_id)` unique index makes this the exact row P3 later enriches; the watcher **never**
     sets `responsible_supervisor_id`/doc-links and **never overwrites P3-owned columns.**
     Duplicate `artifact_id` / malformed `plan.json` → same NORMATIVE policies as WP-P2B (leave
     unregistered + diagnostic; quarantine, never rewrite).
  5. **Decouple from P2L (no forward dep):** expose an **`onPlanFolderSettled(planId,
     folderRelPath, changeKind)` callback seam** (constructor dependency, callback-less until wired
     — matching this module's existing F-C pattern). P2L registers its scanner into this seam later
     and performs a **startup full reconciliation** of already-adopted folders; **P2 code imports
     nothing from P2L.**
- **Accept:** the two roots are enumerated independently (a legacy-root `.html` change never enters
  the structured-folder path and vice-versa); the state-dir home is ensured on init; **nested
  `plan.md`/output edits trigger a settled callback** (a root-only `depth:0` watch would fail this
  fixture); **late-validity fixture** — a directory that becomes valid after creation is picked up
  (rename event or periodic reconciliation); **over-cap fixture** — a plan past the child-sub cap
  still updates via periodic reconciliation and surfaces `degraded-watch`; idempotent adopt by
  `plan_artifact_id`; **no `author_*` write** (schema-checked); child subs torn down on removal +
  count-capped; no P2L import in P2; duplicate/malformed per policy.
- **Non-goals:** no responsibility/dispatch (P3+); no gallery UI; no intent-ledger ingest (P2L); no
  HTML/projection path.
- **Verify:** main/shared template.

### WP-P2C (amended) — unified gallery projection + read IPC
- **Files:** new `src/main/plans/plan-gallery.ts`; IPC `plan-gallery:list` / `proposal:read` in
  `plan-ipc.ts`; `src/shared/types.ts`; test `plan-gallery.test.ts`.
- **Dep:** WP-P2A (+ WP-P2B / WP-P2B-folder for data).
- **Do:** single server projection unioning **proposals + `format='structured'` plans (with
  `folder_rel_path` + a `hasFolder` flag) + `format='html'` plans labeled "Legacy Plan"**; exclude
  `format='md'`. Structured readers use `plan_documents`/the folder, never `plans.path` for HTML.
  Date-grouped rows (type badge, state chip); default filter hides `archived` + `promoted`.
  `proposal:read` enforces workspace/path-containment + a byte cap. **For structured folder rows,
  render a responsible-supervisor / owner chip sourced from `plan.json` responsibility history
  (bounded read, mtime-cached) — NOT an author chip.** Authorship stays witnessed-first from
  proposal records; **structured-folder authorship is `unknown` unless separately witnessed.**
  Responsibility is never relabeled as author attribution.
- **Accept:** the row types render; `md` excluded; legacy HTML rows present + labeled; `hasFolder`
  set for folder plans; containment enforced; the owner chip reflects `plan.json` responsibility
  (never labeled "author"); structured-folder author = `unknown` unless witnessed; exclusion of
  structured rows from HTML paths asserted by WP-P2C-compat.
- **Non-goals:** no promote channel (P3); no free-text search/multi-facet (deferred).
- **Verify:** main/shared template.

### WP-P2C-compat — structured-format guards at the real call sites
*Unchanged from the parent plan* (now also covers folder-adopted structured rows): `format ===
'html'` guards so a `format='structured'` plan is mechanically excluded from `reparsePlanFile`,
`getServedPlanProjection`/`resolvePlanProjection`, `PlanPaneManager.show`, and the HTML
plan-projection routes.

### WP-P2D (amended) — gallery pane + Promote button
- **Files:** new `src/renderer/components/plan/PlanGalleryPane.tsx`; reuse `ProposalReader.tsx` +
  the WP-P1B folder view; `src/preload/index.ts`; test `PlanGalleryPane.test.tsx`.
- **Dep:** WP-P2C, WP-P1B.
- **Do:** date-grouped list (type/state chips + owner chip), read pane, archived/promoted toggle,
  **Legacy Plan open path** (legacy surface), structured rows with `hasFolder` open the WP-P1B
  folder view (via `planning-reader`), Promote button (proposals only; behavior in P3C). Supersedes
  the tiny reader pane.
- **Accept:** row types render; click-to-read; legacy plans open via legacy surface; folder plans
  open the folder view; `md` absent; Promote present (behavior in P3C).
- **Non-goals:** promotion logic.
- **Verify:** renderer Vitest template.

**Integration gate P2Z:** register P2A/P2B/**P2B-folder**/P2C/P2C-compat main tests; suites +
renderer + build green; **the membership audit covers both `.lares/proposals/*.md` and valid
`<workspaceStateDir()>/plans/*/` folders** against the raw filesystem.

**Stage P2 graph:** `A2 → WP-P2A → {WP-P2B ∥ WP-P2B-folder ∥ WP-P2C ∥ WP-P2C-compat} → WP-P2D → P2Z`.

---

## STAGE P2L (NEW) — planning intent LEDGER (required; rulings 12–14, 16, 17, 20)

**Position:** post-gate, immediately after P2 (both ingest folder-per-plan). A **required** stage —
the DB enrichment of the disk lifecycle P0/P1 already derive. **Single authority:** run state stays
in `orchestrations`; the ledger holds intent identity/status + presence-aware output observations +
cheap projections, and **joins** `orchestrations` for `ran`. DDL-serialized under A2.
**Stage non-goals:** no stored "complete" flag (rungs derived by inspection every scan); no
execution/work-package tracking (P5); no confidence *assertion* (confidence is *derived*).
**Stage user-visible acceptance:** for each plan the surface answers, per intent, **marked → ran →
returned → folded-in**, with results, integration note, and folded-in-vs-pending; a running
groupthink shows **in service of its marked part** (ruling 13); an unfolded deliberation renders
**open, never silently complete** (ruling 12); withdrawn/superseded intents render as such; results
listed independently so one folded rerun never hides another pending result.

### WP-P2L-schema (NEW) — intent table + observation-only outputs table + orchestration link ⟨DDL⟩
- **Files:** `database.ts` (A2 DDL slot); test `plan-intents.schema.test.ts`.
- **Dep:** A2, WP-P2A.
- **Do:** guarded `CREATE TABLE IF NOT EXISTS`:
  ```sql
  plan_intents(
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL, plan_artifact_id TEXT NOT NULL,
    intent_id TEXT NOT NULL, part_slug TEXT, kind TEXT NOT NULL, targets_json TEXT, reason TEXT,
    source_doc_rel_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',          -- active | withdrawn | superseded
    supersedes_intent_id TEXT, integration_note TEXT,
    first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_scanned_at INTEGER NOT NULL,
    UNIQUE(plan_id, intent_id),                     -- identity is (plan_id, intent_id)
    CHECK (kind IN ('groupthink-serial','groupthink-parallel','research')),
    CHECK (status IN ('active','withdrawn','superseded')) )

  -- multiple runs → multiple outputs; observation records only, NO copied orchestration state
  plan_intent_outputs(
    plan_id TEXT NOT NULL, intent_id TEXT NOT NULL, rel_path TEXT NOT NULL,
    orchestration_id TEXT,                          -- self-declared cross-check; not authority
    present_on_disk INTEGER NOT NULL DEFAULT 1,     -- current-presence; missing outputs retained as history
    disposition TEXT NOT NULL DEFAULT 'active',     -- active | superseded | withdrawn
    folded_in INTEGER NOT NULL DEFAULT 0,           -- true ONLY when present_on_disk=1 AND resolved link exists
    first_seen_at INTEGER NOT NULL, last_present_at INTEGER, last_scanned_at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, intent_id, rel_path),
    FOREIGN KEY (plan_id, intent_id) REFERENCES plan_intents(plan_id, intent_id),  -- same-plan only
    CHECK (present_on_disk IN (0,1)),
    CHECK (disposition IN ('active','superseded','withdrawn')),
    CHECK (folded_in IN (0,1)) )
  ```
  Plus guarded **`ALTER orchestrations ADD COLUMN planning_intent_id TEXT`** and index
  **`idx_orchestrations_plan_intent(plan_id, planning_intent_id)`** (the `ran` join is on **both**
  columns; `intent_id` is unique only within a plan). `plan_id` is **NOT NULL** — P2L depends on P2
  folder adoption having produced the `plans` row; `plan_slug`/SKU is display metadata, absent from
  identity. Keep the "plain attribute, no FK cascade to agents" rule for `dispatched`/`orchestration`
  references. No second mutable run-state authority is created.
- **Accept:** tables/indexes idempotent; identity `(plan_id, intent_id)`; composite FK rejects a
  cross-plan output insert; `orchestrations.planning_intent_id` + index added guarded; no duplicate
  run-state table.
- **Non-goals:** no ingest; no IPC.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-P2L-ingest (NEW) — presence-aware rungs + scan-transactional last-good
- **Files:** new `src/main/plans/plan-intent-ledger.ts` (parser + upsert + rung derivation); wired
  into WP-P2B-folder's `onPlanFolderSettled` seam; test `plan-intent-ledger.test.ts`.
- **Dep:** WP-P2L-schema, WP-P2B-folder.
- **Do:** on each folder scan, parse `PLAN-INTENT` sentinels (§R1) from the canonical marked doc
  (`plan.md`; fall back to the linked source proposal pre-hardening). **Presence:** each successful
  scan marks encountered outputs `present_on_disk=1` (stamps `last_present_at`); previously observed
  but now-absent outputs → `present_on_disk=0` (**never deleted** — retained as history). Outputs are
  **upserted as observations** by `(plan_id, intent_id, rel_path)`; a rerun returning a new artifact
  **adds a row**, never replaces. Parse each `PLAN-INTEGRATION` record (`output_rel_path`,
  `disposition`) onto the matching output row. **Rung derivation:** `returned` = ≥1 currently-present
  valid output; per-output `folded_in=1` **iff** the output is present AND a **normalized Markdown
  link** in the relevant `plan.md` phase **resolves to that exact contained artifact** (parse links →
  resolve rel path → containment + existence; substring is insufficient); intent `fully_folded_in` =
  every present `active` returned output referenced; **any present, `active`, unfolded output keeps
  the intent open.** Recompute per scan (a reference removed after folding flips that output's
  `folded_in` back to 0 while intent status stays `active`).
  - **Scan-transactional last-good:** **one scan generation per folder in a single transaction.**
    Absence reconciliation (intent `withdrawn`; output `present_on_disk=0`) is applied **only after
    both** the canonical-document parse **and** the bounded output enumeration complete
    **successfully**. On any **read/parse/cap failure**, **retain the prior projection and emit a
    diagnostic** — no partial upserts followed by mass withdrawal. **Startup reconciliation uses the
    identical rule.**
  - **Malformed markup ≠ withdrawal:** a malformed `PLAN-INTENT` record makes the scan an
    **incomplete intent-set scan.** Successfully-parsed records may upsert; **previously-known
    intents are NOT withdrawn merely for being absent from a malformed scan**; a diagnostic is
    emitted and **last-good presence retained** for ambiguous rows. **Intent absence-reconciliation
    resumes only after a fully-valid intent-set scan** (zero malformed sentinels) plus the successful
    bounded output enumeration.
  - **Re-entry:** upsert intents by `(plan_id, intent_id)`; a `supersedes_intent_id` present → mark
    the referenced row `status='superseded'`; a withdrawn `intent_id` sentinel reappearing → keep
    withdrawn + emit a **reused-sentinel diagnostic** (new decisions must mint a new `intent_id`).
- **Accept:** valid sentinels upsert by `(plan_id,intent_id)`; `returned`/`folded_in` derived from
  present outputs + resolved MD link (substring rejected by test); **fixtures pass for:** delete /
  move / restore an output; multiple runs of one open intent; supersession via new intent_id; removed
  markup → withdrawn; reference removed after folding → that output reopens; **one valid sentinel
  flipped to malformed JSON → the intent stays last-good, not withdrawn**; an unreadable/over-cap
  scan leaves the prior projection intact; reused withdrawn sentinel → diagnostic; startup uses the
  same last-good rule.
- **Non-goals:** no run correlation (WP-P2L-runs); no UI.
- **Verify:** main/shared template.

### WP-P2L-runs (NEW, required) — server-witnessed intent→orchestration correlation
- **Files:** the planning-deliberation launch seam stamps `orchestrations.planning_intent_id` when
  the skill dispatches a groupthink/research run for a marked intent (reusing the run-frozen
  plan/intent binding on follow-up messages, mirroring bundle contract §6.2); correlation/join in
  `plan-intent-ledger.ts`; test `plan-intent-runs.test.ts`.
- **Dep:** WP-P2L-ingest, **`SC-WP-2A`, `SC-WP-2B`, `SC-WP-2I`** (the frozen-stamp rail +
  attribution projection), A2 (for the WP-P2L-schema column). **Scope guard:** this is a
  **planning-phase** deliberation dispatch (groupthink/research), **not** the P5 execution dispatch
  seam — it adds only a nullable orchestration column + correlation and touches no `SC-WP-2*`
  execution binding.
- **Do:** at launch of a marked intent's deliberation, **validate the intent belongs to that plan and
  is `active`**, then record `planning_intent_id` on the `orchestrations` row (**server-witnessed,
  not self-claimed**). The ledger's `ran` rung is a **join** to `orchestrations` on **both `plan_id`
  and `planning_intent_id`** (using `idx_orchestrations_plan_intent`); state (dispatched / running /
  returned / abandoned) is read live from that single authority + the returned output's existence —
  never a copied mutable flag. **Follow-up messages retain the orchestration row's planning-intent
  association** (a stable column on the run-frozen orchestration row); this **does not add
  `planning_intent_id` to `ResolvedPlanStamp` and changes nothing in the bundle contract.** Absence
  of the stamp on a legacy run degrades gracefully to disk-only `returned`/`folded-in`.
- **Accept:** a launched deliberation stamps `orchestrations.planning_intent_id` after validating
  plan-membership + active status; the ledger joins on `(plan_id, planning_intent_id)` so a
  **running** groupthink shows in service of its marked part (ruling 13); follow-up messages reuse
  the frozen binding (test); no second run-state authority; graceful degrade without the stamp; no
  bundle-contract change.
- **Non-goals:** no P5 execution dispatch; no mutable run table.
- **Verify:** main/shared template; rerun the relevant `SC-WP-2*` binding siblings.

### WP-P2L-proj (NEW) — ledger + derived confidence read IPC (altitude-cheap)
- **Files:** projection in `plan-intent-ledger.ts`; IPC **`plan:intents:list`** in `plan-ipc.ts`;
  `src/shared/types.ts`; test `plan-intent-proj.test.ts`.
- **Dep:** WP-P2L-ingest, WP-P2L-runs.
- **Do:** per-plan projection — each intent with status, rung (joining `orchestrations` for `ran`),
  **per-output history** (present/missing, disposition, folded_in), intent `fully_folded_in`/open,
  integration note, withdrawn/superseded flags; plus a **derived confidence/compute readout**
  (ruling 14) — marked vs satisfied intents, deliberations run, whether a final plan exists —
  **derived, never self-asserted.** Mid-altitude read (ruling 18); ARC stays cheapest, diffs deepest
  (both out of scope here). The UI **lists each result independently** so a folded rerun cannot hide
  a pending one.
- **Accept:** projection derived purely from ledger + orchestration join + disk; unfolded → open;
  withdrawn/superseded surfaced; per-output history preserved; confidence derived not asserted.
- **Non-goals:** no renderer (a P4 tab consumes this later — alignment note only).
- **Verify:** main/shared template.

**Integration gate P2LZ:** register all P2L main tests; `npm run test:supervisor`; build green.

**Stage P2L graph:** `A2 → WP-P2L-schema → WP-P2L-ingest → WP-P2L-runs → WP-P2L-proj → P2LZ`
(scan hook from WP-P2B-folder's `onPlanFolderSettled` seam + startup full reconciliation).

---

## §R-P3 — P3 ALIGNMENT NOTE (narrow, not a redesign)

Amendment 10 makes promotion run the planning skill whose first act scaffolds the folder; the
existing **WP-P3B** unconditionally inserts a new `plans` row, writes no filesystem, and treats
`proposals.promoted_to_plan_id` as its idempotency key — that now conflicts on `artifact_id` and
leaves responsibility/linkage unresolved. **WP-P3B must be amended (alignment only) to:**

1. **Adopt, not duplicate.** Detect an existing folder-backed structured row by stable
   `plan_artifact_id` (and source-proposal artifact identity); enrich that exact row rather than
   inserting a second.
2. **Transactional enrichment.** Attach `source_proposal_id`, `responsible_supervisor_id`,
   `plan_documents` links, `supervisor_active_plan` + focus, and `state='promoted'` on the source
   proposal — **without replacing the adopted row**.
3. **Filesystem-first is normative.** Scaffold (or an already-scaffolded folder) **always precedes**
   DB enrichment via the **atomic temp-dir → rename** of a fully-valid folder (§R0). **"DB succeeds
   first" is NOT a valid ordering.** `EEXIST` on the deterministic target → validate and
   orient/resume, never clobber.
4. **Durable promotion de-dup — the `promotion_requests` row (authoritative seam).** A durable row
   (DDL in §R-A2, inside P3A's serialized slot) is inserted-or-read **before dispatch**; its
   `UNIQUE(workspace_id, proposal_artifact_id)` is the **authoritative cross-restart dispatch de-dup
   seam.** This row is **request metadata, not plan ownership/enrichment** — filesystem-first plan
   creation is intact; the row does not mint or own the `plans` row. The in-memory **pending latch**
   (keyed `(workspace_id, proposal_artifact_id)`) is only a same-process optimization backed by this
   row; it is acquired **before dispatch and stays held until adoption or a witnessed terminal
   failure** — not released on a `promotion-pending` return. **Repeated `proposal:promote` calls
   while pending/adopted return the existing operation** (no second worker).
5. **Dispatch-before-delivery invariant.** **Allocate/create the orchestration row and persist its
   ID onto `promotion_requests.orchestration_id` before any agent/PTY delivery — preferably in one
   DB transaction** (create orchestration + bind to the request commit together). **Only after that
   transaction commits may delivery begin.** Adoption changes only `state: pending → adopted` (it
   does not first establish orchestration identity). Terminal launch failure sets `state='failed'`;
   retry allocates a **new attempt/orchestration under the same request row** and increments
   `attempt_count`, retaining the deterministic `plan_artifact_id`/`target_folder_rel_path`.
6. **Startup reconstruction.** Rebuild pending latches from `state='pending'`:
   - **`pending` + `orchestration_id` present** → delivery *may* have occurred; **inspect / resume /
     reconcile that exact orchestration; never redispatch blindly.**
   - **`pending` + `orchestration_id` NULL** → no delivery could have occurred (binding precedes
     delivery); **claim and dispatch safely.**
7. **`proposal:promote` return contract.** If the claiming folder exists and is adopted (a `plans`
   row exists), enrich transactionally and return the plan. If scaffold was dispatched and the row is
   not yet adopted, return **`promotion-pending`** (with the `plan_artifact_id`); the caller does not
   block on the watcher. Completion resumes via the P2 folder watcher's idempotent adopt, then the
   pending-promotion reconciler (or the next retry) enriches the exact adopted row.
8. **Concurrency convergence.** Two concurrent promotion requests for one proposal converge to **one
   folder and one `plans` row** — serialized on `plan_artifact_id` / `(workspace_id, artifact_id)`
   and on `promotion_requests`'s unique constraint; the loser observes the winner and creates
   nothing new.
9. **Manual folders retained.** A pre-existing manually scaffolded folder is found by the
   source-proposal claim-scan (matching `plan.json.source_proposal.artifact_id`) and keeps its
   existing valid identity; **at most one valid folder may claim a proposal** — duplicates are
   diagnosed and **block enrichment**.
10. **Idempotent responsibility event.** Enrichment **appends-or-observes the responsibility event by
    `event_id`** — a `promotion-service` `assigned` event on scaffold, or **verify** a pre-existing
    `manual-skill` event matches the server-selected supervisor (mismatch diagnosed, never
    overwritten); repeated enrichment retries never append duplicate `assigned` entries. The append
    uses the **no-clobber CAS seam** (below).
11. **Reject foreign ownership.** A folder claimed by a **different** proposal/supervisor is rejected,
    never silently rebound.
12. **Stale temp-scaffold handling.** Temp siblings use a **recognizable request-ID-qualified name**
    (e.g. `<plan-sku>.tmp-<promotion_request.id>` beside the deterministic target). A crash before
    rename leaves the canonical target **absent**; a retry may **safely resume or replace only its
    own validated temp directory** (matched by the request-ID-qualified name); **unrelated
    directories are never removed.**

**No-clobber seam, named:**
- **P3 (service):** a shared **`src/main/plans/plan-manifest.ts`** helper providing **atomic
  read-modify-write / CAS** on `plan.json` (expected content-hash, bounded retry, preserves
  concurrent `responsibility_events`). All service-side `plan.json` mutations go through it.
- **Skill (agent):** the `proposal-to-plan` skill uses an **included helper script** shipped in the
  skill root for the same atomic CAS append, **or** — when editing by hand — the **byte-exact
  edit-retry discipline** (read → verify expected hash → `Edit` the exact bytes → re-read; on
  mismatch, re-read and retry), **never** a shell redirect/`>`/`sed -i`/`tee` (which the
  worker-CLAUDE.md CRLF rule already forbids).

**Acceptance for the P3B alignment:** concurrent promotion requests → one folder/row + one
`promotion_requests` row (unique-constraint loser reads the winner's); **crash before orchestration
allocation** (`pending`, `orchestration_id=NULL`) → startup claims and dispatches, no duplicate
work; **crash after binding, before delivery** (`pending`, `orchestration_id` set, nothing
delivered) → startup inspects that orchestration, finds no delivery, resumes/reconciles without
redispatching blindly; **crash after delivery, before adoption** (`pending`, `orchestration_id` set,
worker ran) → startup reconciles the existing orchestration/folder to adoption, never launches a
second worker; scaffold-success/DB-failure retry enriches the same row (`attempt_count`++) with one
responsibility event; a crash-orphaned temp sibling is resumed/replaced by its own retry and
unrelated dirs are untouched; a concurrent skill edit to `plan.json` during a P3 append is preserved
(CAS retry).

P3A/P3C otherwise intact; `responsible_supervisor_id` DDL stays in P3A and now **enriches** the
`plan.json` disk truth (§R0).

---

## §R-ATTR — Attribution etched at work time (ruling 22) — authority order + alignment

Ruling 22: "which agents did what, which supervisor was responsible" is captured **at work time** —
dispatch stamps + commit trailers — never reconstructed from checkpoints (which expire, ruling 19).

**Durable authority, in order (checkpoint-independent):**

1. **Immutable turn/dispatch stamps** for performed work — `turn_records.plan_id / plan_item_id /
   plan_stamp_source`, frozen at turn-open, immutable (bundle contract §6; **SC-WP-2A/2B**, Save-card
   Stage ②). The dispatch-stamp half of ruling 22; already early.
2. **Server-witnessed intent→orchestration linkage** for planning runs —
   `orchestrations.planning_intent_id` (WP-P2L-runs). The durable "who ran which deliberation."
3. **Commit records / turn links + contract-defined commit trailers** for committed work —
   `commit_turn_links`, `commit_records` (bundle contract §8) and the composer's `Lares-Turns` /
   `Lares-Plan` trailers.
4. **Responsible-supervisor assignment** — `plan.json.responsibility_events` (disk, append-only,
   §R0) enriched by `plans.responsible_supervisor_id` + `supervisor_active_plan` (P3A), with
   assignment time.
5. **ARC** — a maintained **summary that cites** 1–4; **not** itself authority (a prose row never
   substitutes for work-time stamping).

**Pulled-early deliverable of this rescope:** authorities **2 and 4** (planning ledger + disk
responsibility history) land in the P0–P2L tier, checkpoint-independent — satisfying "attribution
etched when the work happens" for the planning arc without waiting for P7 evidence surfaces. Make
**SC-WP-2A/2B/2I** explicit deps of WP-P2L-runs.

**Alignment notes (no P5–P7 edits here):**

- The **existing shared composer** (P6D / Save-card Stage ④) must emit the **contract-defined
  `Lares-Turns` / `Lares-Plan` trailers from its immutable snapshot at commit time** — preserving
  the mixed-plan rule: a mixed-plan candidate emits **all** applicable plan/turn trailers **or
  none**, never a silently-selected scalar plan (bundle contract §3, §10).
- **Commit-trailer trust qualification.** `Lares-*` trailers are authoritative **only for a
  server-identified Lares commit** (bundle contract §9.4 attempt/reflog identification) **reconciled
  with the immutable candidate snapshot + commit ledger.** Identically named trailers appearing in an
  **external** commit are **untrusted hints** and must **not** manufacture attribution (consistent
  with §8's `relation='metadata_only'` labeling). **Acceptance (folded into the P6D/composer + P7
  alignment):** a spoofed external commit bearing forged `Lares-*` trailers yields **no** durable
  attribution linkage.
- **Agent attribution needs no new trailer:** it is recoverable durably via the trailer-linked turns
  + `commit_turn_links`. **`Lares-Agent` is NOT a normative v3 trailer** — if desired later, it is a
  **proposed bundle-contract change outside this rescope**, not presented as existing.
- **P7 blame/evidence must read the durable record (turn stamps, orchestration links, commit
  records/trailers, ledger, responsibility rows), never checkpoints as the sole source** (ruling 19).
  Flagged as a cross-stage constraint; P5–P7 text left intact.

---

## §R-A2 — DDL barrier A2 update (serialization mandatory)

Every `database.ts` migration across both plans is serialized against every other (guarded
`ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` only; two DDL WPs never land concurrently; each rebases
onto the current `initDatabase()` head). **New nodes added by this rescope, in the A2 order:**

- **WP-P2A** — **five** `plans` ALTERs (incl. `folder_rel_path`) + the `folder_rel_path` partial
  unique index, + the `proposals` table/indexes.
- **WP-P2L-schema** — `plan_intents`, `plan_intent_outputs`, `orchestrations.planning_intent_id`
  ALTER + `idx_orchestrations_plan_intent`.
- **P3A slot** — **`promotion_requests`** (below) lands **inside P3A's already-serialized slot**
  (alongside `responsible_supervisor_id`, `supervisor_active_plan`, `plan_documents`,
  `plan_tab_overviews`), guarded `CREATE TABLE IF NOT EXISTS`, **never as concurrent DDL**.

```sql
promotion_requests(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_artifact_id TEXT NOT NULL,
  plan_artifact_id TEXT NOT NULL,          -- deterministic: plan_<proposal-artifact-hex>
  target_folder_rel_path TEXT NOT NULL,    -- deterministic state-dir path
  supervisor_id TEXT,
  orchestration_id TEXT,                   -- bound BEFORE delivery (§R-P3.5); winning run
  state TEXT NOT NULL,                     -- pending | adopted | failed
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, proposal_artifact_id),
  CHECK (state IN ('pending','adopted','failed'))
)
```

These serialize against the existing Save-card + planning slots (`SC-WP-2A/2D/2F/2G/3A/3B/4C`,
`P2A/P3A/P4D-reply/P5A-*/P5B/P5C/P5-dispatch/P8F`). The P8F `DROP` exception is untouched.

---

## Consolidated dependency graph (P0–P2L)

```
P0:   WP-P0PRE → {WP-P0A ∥ WP-P0B} → WP-P0C → P0Z
P1:   WP-P0PRE → WP-P1A → WP-P1B → WP-P1C → P1Z ;  SC-WP-1I + WP-P0PRE → WP-P1S
★ PROMOTION-DEMAND GATE K (unchanged) ★
P2:   A2 → WP-P2A → {WP-P2B ∥ WP-P2B-folder ∥ WP-P2C ∥ WP-P2C-compat} → WP-P2D → P2Z
P2L:  A2 → WP-P2L-schema → WP-P2L-ingest → WP-P2L-runs → WP-P2L-proj → P2LZ
        (scan hook via WP-P2B-folder.onPlanFolderSettled + startup full reconciliation)
Deps out of scope, consumed by name: SC-WP-2A, SC-WP-2B, SC-WP-2I (WP-P2L-runs) ; SC-WP-1I (WP-P1S).
Alignment only (not edited here): §R-P3 (WP-P3B) ; §R-ATTR (P6D/composer, P7).
```

---

<!-- groupthink: planning-surface P0–P2 rescope + intent ledger + attribution, Lead Planner × Reviewer, 7 rounds, approved 2026-08-01 -->


<!-- groupthink_run: 5fddf4ff (mode=serial) -->
