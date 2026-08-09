---
name: proposal-to-plan
description: >-
  Promotion-entry method for turning the proposal selected by the Plans pane
  into an implementation plan with work packages. Invoke only from the injected
  promotion prompt, then scope, promote, deliberate, integrate, package, or
  orient from the plan folder on disk, which is the resumable source of truth.
---

# proposal-to-plan — dispatcher

This skill begins only when the Plans pane injects its promotion prompt for a selected flat
proposal. From that entry it carries the proposal through **scope(+mark) → promote → deliberate →
integrate → package**, with **orient** as the responsible-supervisor re-entry method library. The
**plan folder on disk is the resumable source of truth**; the responsible supervisor plus this
skill's policy drives the work. Proposal creation belongs to the separate `write-proposal` skill.
There is **one** promotion skill root — no second root, no journey driver process, no new
orchestration.

## Pick a mode (six public entries)

| Mode | What it does | Playbook |
|---|---|---|
| `scope` | **First hardening step:** triage what needs deliberation/research, **mark the flat proposal** (PLAN-INTENT), and record the required dated `## Hardening scope` verdict. **Owns marking.** | `references/activities/scope.md` |
| `promote` | Atomic **complete-folder** scaffold (§R0) via temp-dir → rename, `plan.md` already inside. | `references/activities/promote.md` |
| `deliberate` | Launch the **existing** groupthink/researcher lane keyed to **one** marked intent. | `references/activities/deliberate.md` |
| `integrate` | Validate a returned output; **fold by Markdown-link + PLAN-INTEGRATION**; refresh `ARC.md`. | `references/activities/integrate.md` |
| `package` | **Last step:** decompose into bundle-shaped WPs + create-or-verify the `plan-baseline` tag. | `references/activities/package.md` |
| `orient` | **Responsible-supervisor re-entry methods.** Determine responsibility and refresh ARC-META/ARC; cross-surface reporting is split to `read-planning-surface`. | `references/activities/orient.md` |

## Hardening continuity

Once hardening starts, continue through **`scope → promote → deliberate → integrate → package`**
without pausing between phases to ask "phase done, continue?" Resume from durable disk state when a
turn boundary intervenes. The one built-in stop is **after `package`**, when the plan is presented
to the workspace owner and waits for the explicit implementation trigger. Escalation for a genuine
Tier-3 decision remains allowed; routine phase-boundary permission checks are not.

There is **no standalone `mark` mode** — marking is owned inside `scope` (a separate mark would
bypass hardening triage). The `references/activities/*` files are internal playbooks the dispatcher
routes to; load only the one you need. Contracts live once under `references/contracts/`.

## Lane rules (who may run what)

- **`orient` — anyone may determine responsibility.** Apply
  `references/contracts/responsibility.md` §Determination first. The ARC-META/ARC refresh is a
  mutation, so it runs **only when the runner is the plan's current responsible supervisor**; any
  other runner **skips the refresh**. Cross-surface disk-state derivation and reporting belongs to
  `read-planning-surface`, which is read-only for every runner and never launches or
  auto-relaunches. Judgment-bearing next actions remain **gated on the responsible supervisor.**
  Orient-first is a standing rule: on picking up a plan folder, `plan.json` + `ARC.md` + intent
  markers are the **FIRST** place you look.
- **`mark` (inside `scope`) / `integrate` / `package` — the responsible supervisor ONLY.** The
  current responsible supervisor = the **last `assigned` event** in `plan.json`. A non-supervisor
  lane that reaches these is **rejected and instructed** to hand off.
- **Reassignment precedes mutation.** A different supervisor must **append a new `assigned` event**
  (via the helper, under the lock) **before** any mutation. Read-only `orient` is allowed without
  reassignment; a mutation without a fresh `assigned` event is **refused**.
- `ARC.md` is **supervisor-owned** — created at `promote`; its ARC-META/ARC refresh is performed by
  the **responsible supervisor** via `orient`/`integrate`; `read-planning-surface` provides the
  read-only report without refreshing.

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
the read-only dump. The mechanical **ARC-META** refresh has its own helper mode, `refresh-arc` (it
rewrites **only** the `<!--ARC-META-->` block of `ARC.md` — never `plan.json`); ARC **prose** appends
stay native supervisor edits. (`references/contracts/manifest-lock.md`.)

## Dispatcher contract — mode selection replaces any per-turn sentinel

Choosing and running one of the six modes **is** this skill's turn obligation. **Mode selection
replaces any per-turn PLAN-EVENT sentinel obligation** — the durable record is the plan folder's
artifacts (`plan.json`, `plan.md` markup/integration sentinels, `ARC.md`), which the surface reads;
you do **not** owe a per-turn sentinel while working this skill. (PLAN-INTENT / PLAN-INTEGRATION are
**watcher-read document markup**, not a per-turn agent obligation, and are outside
`assertPlanRailFree`.)
