# Contract reference — §R0: the folder-per-plan structure

> **Canonical, single copy.** This file reproduces **§R0** of
> `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`
> **verbatim**. It is the one authoritative copy inside the skill; activity
> playbooks cite it and never restate it. If the source §R0 changes, update
> here — do not fork a second copy elsewhere in the skill.

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
