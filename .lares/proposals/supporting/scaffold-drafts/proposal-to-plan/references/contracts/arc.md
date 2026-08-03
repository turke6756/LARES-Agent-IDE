# Contract reference — §R2: the ARC summary file

> **Canonical, single copy.** This file reproduces **§R2** of
> `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`
> **verbatim** (the ARC.md skeleton, ownership rule, and freshness contract). It
> is the one authoritative copy inside the skill; `promote`, `integrate`, and
> `orient` cite it and never restate it.

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
