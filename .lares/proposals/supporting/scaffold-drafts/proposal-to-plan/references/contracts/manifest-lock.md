# Contract reference — §P3-MANIFEST-LOCK: the plan.json lock + no-clobber CAS protocol

> **Canonical, single copy. HELPER-ONLY — there is NO hand-edit path for
> `plan.json`.** This file carries the lock/CAS protocol that governs **all**
> `plan.json` creation and mutation. Under the approved hybrid
> (`.lares/proposals/supporting/2026-08-02-skill-vs-workflow-recommendation.md`,
> NORMATIVE), the agent **never** edits `plan.json` directly and there is **no
> byte-exact fallback**: every write goes through `scripts/plan-manifest.mjs`
> (`scaffold` / `manifest`), which owns the lock. If the helper cannot acquire
> the lock, that is a **clean blocking error with recovery guidance** — not a
> licence to hand-edit. This supersedes, *for the skill agent*, the "or byte-exact
> edit-retry" alternative offered by the source §R-P3 seam text reproduced below
> (that alternative remains for the P3 **service** side only).

---

## The lock protocol (owner+nonce `wx` acquire · 2s heartbeat · 15s stale reclaim)

`plan-manifest.mjs manifest` serializes **`plan.json` mutation only** (recommendation:
"The manifest lock serializes `plan.json` mutation only — it protects manifest integrity"). It does
**not** serialize edits to the proposal, `plan.md`, or `ARC.md`. Protocol:

- **Acquire** a sibling lock file (`plan.json.lock`) with an **exclusive `wx` create** carrying an
  **owner id + random nonce**. `wx` fails if the lock already exists → the holder is live.
- **Heartbeat** the lock every **2 seconds** (refresh its mtime / heartbeat timestamp) for as long
  as the mutation is in progress.
- **Stale reclaim:** a lock whose heartbeat is older than **15 seconds** is considered abandoned and
  may be reclaimed by a new owner+nonce acquire. A reclaiming writer verifies its own nonce after
  acquire (guards a race between two reclaimers).
- **CAS inside the lock:** read `plan.json`, compute its expected content-hash, apply the change,
  and write back **only if the on-disk hash still matches** — preserving any concurrent
  `responsibility_events`. On hash mismatch, re-read and retry within a bounded budget.
- **Release** by unlinking the lock file after the write + fsync completes.
- **Lock exhaustion** (cannot acquire within the retry budget, e.g. a live holder that never yields)
  → **clean error that blocks the mutation and reports recovery guidance** (retry after the
  15s stale-reclaim window, or surface to the supervisor). **No direct `plan.json` edit** is
  attempted as a fallback.

---

## §R-P3 — No-clobber seam, named (source text, verbatim)

> The following block is reproduced **verbatim** from §R-P3 of
> `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`.
> For **this skill**, only the **Skill (agent)** bullet's *helper-script* path
> applies — the "or … byte-exact edit-retry discipline" alternative is **not** a
> skill path (see the helper-only ruling above); it is retained here only because
> it is part of the verbatim source seam and governs the P3 service side.

**No-clobber seam, named:**
- **P3 (service):** a shared **`src/main/plans/plan-manifest.ts`** helper providing **atomic
  read-modify-write / CAS** on `plan.json` (expected content-hash, bounded retry, preserves
  concurrent `responsibility_events`). All service-side `plan.json` mutations go through it.
- **Skill (agent):** the `proposal-to-plan` skill uses an **included helper script** shipped in the
  skill root for the same atomic CAS append, **or** — when editing by hand — the **byte-exact
  edit-retry discipline** (read → verify expected hash → `Edit` the exact bytes → re-read; on
  mismatch, re-read and retry), **never** a shell redirect/`>`/`sed -i`/`tee` (which the
  worker-CLAUDE.md CRLF rule already forbids).

---

## Why helper-only for the skill

The recommendation's `plan-manifest.mjs` scope is explicit: the helper owns **all** `plan.json`
creation and mutation, and

> **No hand-edit path exists.** The agent **never** edits `plan.json` directly. If the helper
> cannot acquire the lock (exhaustion) or otherwise fails, that is a **clean error that blocks the
> mutation and reports recovery guidance** … there is no byte-exact fallback, and `manifest-lock.md`
> documents the helper-only protocol accordingly.

Rung derivation is **not** in the helper (that is the P1 reader / P2L ledger's canonical work); the
lock protects manifest integrity only.
