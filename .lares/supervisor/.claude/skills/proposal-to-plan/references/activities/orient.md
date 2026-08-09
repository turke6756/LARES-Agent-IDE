# Activity playbook — `orient`

**Purpose.** The responsible-supervisor **re-entry method library**. It retains the two steps that
gate or perform plan-folder writes: determine responsibility, then refresh `ARC.md`/`ARC-META`
without clobbering prose. Cross-surface disk-state derivation and reporting has moved to the
read-only `read-planning-surface` skill; use that skill for the lifecycle report and safe next
actions.

**Lane.** Anyone may perform the read-only responsibility determination. The ARC-META/ARC refresh
is a mutation and is performed **only when the runner is the plan's current responsible
supervisor**; any other runner **SKIPS the refresh**. Judgment-bearing actions remain **gated on the
responsible supervisor**.

**Contracts loaded.** `references/contracts/folder-schema.md` (§R0), `references/contracts/intent-lifecycle.md`
(§R1 rungs), `references/contracts/arc.md` (§R2 — refresh on re-run),
`references/contracts/responsibility.md` (§Determination), and
`references/contracts/manifest-lock.md` (read-only `inspect` only — orient never mutates `plan.json`).

---

## Steps

1. **Inspect the folder.** Run `scripts/plan-manifest.mjs inspect` (read-only `plan.json` + folder
   listing) and read `ARC.md`.
2. **Determine responsibility.** Apply
   `references/contracts/responsibility.md` §Determination. This is the normative write gate; do
   not duplicate its rules here. If another supervisor is responsible, stop without mutating or
   reassigning and **SKIP the refresh**.
3. **Refresh `ARC.md`/`ARC-META` — responsible supervisor ONLY.** This step is a mutation, so run it
   **only if §Determination says you are the plan's current responsible supervisor**. Route the
   mechanical **ARC-META** update
   (`last_refreshed_at`, `folder_mtime_ms`) through **`scripts/plan-manifest.mjs refresh-arc --dir
   <plan-folder>`**, which rewrites **only** the ARC-META block atomically — every prose section stays
   byte-identical, and `ARC.md`'s own mtime is excluded from the cutoff. Any **prose** refresh (a
   `## Deliberations` / `## Who did what` append) is a **native supervisor edit** that must **add** to,
   and never clobber, existing content (Accept 12).
4. **Read the planning surface.** Use `read-planning-surface` for the moved cross-surface lifecycle
   derivation and report. That read-only skill owns the decision table and reporting rules; it does
   not perform this playbook's responsibility-gated refresh.
