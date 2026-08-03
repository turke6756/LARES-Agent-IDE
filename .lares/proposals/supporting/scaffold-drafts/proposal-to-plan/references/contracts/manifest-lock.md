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

## The lock protocol (owner+nonce `wx` acquire · 2s atomic heartbeat · 15s claim-marker-serialized stale reclaim)

`plan-manifest.mjs manifest` serializes **`plan.json` mutation only** (recommendation:
"The manifest lock serializes `plan.json` mutation only — it protects manifest integrity"). It does
**not** serialize edits to the proposal, `plan.md`, or `ARC.md`. Protocol:

- **Acquire** a sibling lock file (`plan.json.lock`) with an **exclusive `wx` create** carrying a
  **lock record** (`owner_kind` + `owner_id` + `pid` + random `nonce` + `acquired_at` +
  `heartbeat_at`). `wx` fails if the lock already exists → the holder is live. The record schema is
  **byte-for-byte the same as the service side (`src/main/plans/plan-manifest.ts`)** so a skill
  contender and a service contender read each other's freshness correctly across processes — in
  particular the heartbeat timestamp is `heartbeat_at`, **not** a short `hb`.
- **Heartbeat** the lock every **2 seconds** by **atomically** rewriting `heartbeat_at` (temp-write
  → fsync → rename, never a truncating in-place write) for as long as the mutation is in progress.
  The holder first re-reads the on-disk record and renews **only if its own nonce is still present**;
  if the lock was reclaimed out from under it (nonce mismatch) it **stops** heartbeating so it never
  clobbers the new holder.
- **Stale reclaim (claim-marker serialized):** a lock whose `heartbeat_at` is older than **15
  seconds** may be reclaimed — but a **bare** "read stale → unlink" race is unsafe: a contender that
  read the victim as stale can wake *after* the victim was already reclaimed and a **fresh** live lock
  installed in its place, and its unlink/rename would then steal that fresh lock, transiently emptying
  the lock path and breaking mutual exclusion. So reclaimers of a given victim are **serialized by an
  exclusive per-victim claim marker** — `plan.json.lock.reclaim-<victim-nonce>`, created with `wx`.
  Exactly one contender wins the marker and performs **confirm-still-stale → rename victim to a
  tombstone (`plan.json.lock.stale-<victim-nonce>`) → drop the tombstone**; while the stale victim is
  still present no `wx` acquire can install a fresh lock and no other reclaimer can act, so the
  sequence can never grab a fresh lock. Losers of the marker back off and re-enter acquire cleanly.
  The claim-marker and tombstone paths are **identical across the skill and service implementations**,
  so cross-implementation contenders serialize against each other on the same marker.
- **Windows contention tolerance:** on NTFS a concurrent create/rename/delete of the same lock path
  surfaces as a sharing violation (`EPERM`/`EACCES`/`EBUSY`) rather than `EEXIST`; those are treated
  as **transient contention to retry**, never a fatal acquire failure.
- **CAS inside the lock:** read `plan.json`, compute its expected content-hash, apply the change,
  and write back **only if the on-disk hash still matches** — preserving any concurrent
  `responsibility_events`. On hash mismatch, re-read and retry within a bounded budget.
- **Release** by verifying our own nonce is still the record on disk, then unlinking the lock file
  after the write + fsync completes. If the lock was reclaimed out from under us (nonce mismatch) we
  unlink **nothing** — the current holder owns it.
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
