---
name: proposal-to-plan
description: >-
  The house method for carrying a proposal to an implementation plan with
  work packages — capture, scope (hardening triage + markup), promote (scaffold
  the plan folder), deliberate, integrate, package, and orient. Use whenever you
  author a proposal in .lares/proposals/, harden one into a plan folder under
  <workspaceStateDir()>/plans/, or pick up an existing plan folder. One skill
  root; the folder on disk is the resumable source of truth.
---

# proposal-to-plan — dispatcher

This skill carries a proposal all the way to an implementation plan: **capture → scope(+mark) →
promote → deliberate → integrate → package**, with **orient** as the re-entry read. The **plan
folder on disk is the resumable source of truth**; the responsible supervisor plus this skill's
policy drives the work; `orient` derives the *known* state and offers *safe* next actions. There is
**one** skill root — no second root, no journey driver process, no new orchestration.

## Pick a mode (seven public entries)

| Mode | What it does | Playbook |
|---|---|---|
| `capture` | Write a stamped **flat** proposal in `.lares/proposals/`; zero ceremony. Terminal-valid. | `references/activities/capture.md` |
| `scope` | **First hardening step:** triage what needs deliberation/research, **mark the flat proposal** (PLAN-INTENT), and record the required dated `## Hardening scope` verdict. **Owns marking.** | `references/activities/scope.md` |
| `promote` | Atomic **complete-folder** scaffold (§R0) via temp-dir → rename, `plan.md` already inside. | `references/activities/promote.md` |
| `deliberate` | Launch the **existing** groupthink/researcher lane keyed to **one** marked intent. | `references/activities/deliberate.md` |
| `integrate` | Validate a returned output; **fold by Markdown-link + PLAN-INTEGRATION**; refresh `ARC.md`. | `references/activities/integrate.md` |
| `package` | **Last step:** decompose into bundle-shaped WPs + create-or-verify the `plan-baseline` tag. | `references/activities/package.md` |
| `orient` | **Re-entry read.** Derive every intent's rung from disk; report safe next actions. Owns the decision table. | `references/activities/orient.md` |

There is **no standalone `mark` mode** — marking is owned inside `scope` (a separate mark would
bypass hardening triage). The `references/activities/*` files are internal playbooks the dispatcher
routes to; load only the one you need. Contracts live once under `references/contracts/`.

## Lane rules (who may run what)

- **`orient` — anyone.** It is **read-only**; it never mutates the plan, never launches, never
  auto-relaunches. Judgment-bearing next actions it surfaces are **gated on the responsible
  supervisor.** Orient-first is a standing rule: on picking up a plan folder, `plan.json` + `ARC.md`
  + intent markers are the **FIRST** place you look.
- **`mark` (inside `scope`) / `integrate` / `package` — the responsible supervisor ONLY.** The
  current responsible supervisor = the **last `assigned` event** in `plan.json`. A non-supervisor
  lane that reaches these is **rejected and instructed** to hand off.
- **Reassignment precedes mutation.** A different supervisor must **append a new `assigned` event**
  (via the helper, under the lock) **before** any mutation. Read-only `orient` is allowed without
  reassignment; a mutation without a fresh `assigned` event is **refused**.
- `ARC.md` is **supervisor-owned** — created at `promote`, refreshed by `orient`/`integrate`.
- `capture` is open to anyone (a worker may author with `author_role: worker`).

## Rung ladder (in brief — full text in `references/contracts/intent-lifecycle.md`)

**marked** (valid PLAN-INTENT sentinel) → **ran** (server-witnessed orchestration link;
**unavailable pre-ledger — reported as `ran: unavailable`, never faked from a filename or a
self-declared `orchestration_id`**) → **returned** (≥1 currently-present in-folder output whose
frontmatter `intent_id` + `plan_artifact_id` match) → **folded-in** (a **normalized Markdown link**
in the relevant `plan.md` phase **resolves** to that exact present output — a substring is
insufficient). Multiple outputs per intent are tracked **independently**; any present, `active`,
unfolded output **keeps the intent open**.

## The `plan.json` rule

**All** `plan.json` creation and mutation goes through `scripts/plan-manifest.mjs`
(`scaffold` / `manifest`) under the §P3-MANIFEST-LOCK protocol. **There is no hand-edit path**; lock
exhaustion is a **clean blocking error with recovery guidance**, never a direct edit. `inspect` is
the read-only dump. (`references/contracts/manifest-lock.md`.)

## Dispatcher contract — mode selection replaces any per-turn sentinel

Choosing and running one of the seven modes **is** this skill's turn obligation. **Mode selection
replaces any per-turn PLAN-EVENT sentinel obligation** — the durable record is the plan folder's
artifacts (`plan.json`, `plan.md` markup/integration sentinels, `ARC.md`), which the surface reads;
you do **not** owe a per-turn sentinel while working this skill. (PLAN-INTENT / PLAN-INTEGRATION are
**watcher-read document markup**, not a per-turn agent obligation, and are outside
`assertPlanRailFree`.)
