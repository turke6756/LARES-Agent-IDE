---
artifact_id: prop_4c8d21b7
title: Save card — uncommitted-work visibility and one-click commit staging
author_role: supervisor
authored_at: 2026-07-30T20:10:00Z
---

# Save card: uncommitted-work visibility and commit staging

**Status:** proposal (first artifact authored under the proposals practice from
`.lares/proposals/supporting/2026-07-30-plan-surface-revival-technical-strategy.md`;
this file is its own dogfood).

**Origin:** Edward's ask, 2026-07-30. Technical grounding:
`.lares/proposals/supporting/save-card-git-native-input-2026-07-30.md` — written by the
"Git Native Work" supervisor (5d94254d, builder of the checkpoint engine) from a
fresh source read of `src/main/git-checkpoints/`.

## Why

Lares is a save-game system that never shows you the save screen. The checkpoint
engine records every agent turn with before/after restore points — but all of that
work sits **uncommitted** in a shared tree, invisible until someone remembers to
run `git status`. Two real risks today:

1. **Invisible exposure.** Fleets of agents produce work across days; nothing in
   the UI answers "what work exists that git doesn't yet protect?" (The current
   54-commits-ahead / previously-uncommitted-backlog situation is exactly this,
   lived.)
2. **Silent expiry.** Checkpoint restore points thin after the retention window
   (currently 10 days, `RETENTION_DENSE_WINDOW_MS`). Uncommitted work whose
   restore points expire loses its byte-exact undo. Nothing warns the user that
   it's "time to save."

The metaphor Edward named: a **Save card** — the place you go to see unsaved
progress and hit Save. The user is *always* the committer (revival-strategy R2.4);
the app only makes saving visible, easy, and timely.

## What

A **Save card** UI surface, a peer of the Plans button, showing:

- **Bundles of uncommitted work**, grouped three ways:
  - by **worker** (one agent's witnessed dirty paths),
  - by **supervisor unit** (a supervisor's own turns + all its workers'),
  - by **plan** (once plan_id stamps on turn_records land — strategy §S1.B).
- Per bundle: dirty paths, contributing turns/agents, **capture quality** flags
  (unverified turns where snapshots were missing), **overlap flags** (paths shared
  with another bundle), and an **expiry horizon** ("restore points for this work
  begin thinning in 2 days").
- An **"unattributed changes" pseudo-bundle**: dirty paths no bundle witnessed
  (Bash-mediated work, generated files, capture outages). The card never pretends
  the witnessed union covers the tree.
- A **Commit action** per bundle: the app *stages* the bundle's paths and drafts a
  commit message from turn/plan metadata (attribution goes in the message, not
  hunk surgery); the **user clicks commit** with their own identity and hooks.
  Never auto-commit — not on a timer, not on expiry.
- **Expiry warnings** surfaced on the card and escalated per the existing P1
  ladder (no repo → offer `git init`; dirty → "commit to make permanent";
  committed-no-remote → gentle nudge). Worded honestly: "restore points expire,"
  not "your work is deleted" — retention distills diffs before pruning.

## How (grounded in the engine input — key positions adopted)

The Git Native Work assessment: **feasible; mostly read-side plus one genuinely
new write-side module.** Positions this proposal adopts wholesale:

- **"Uncommitted" = `git status --porcelain -z` vs HEAD** at card-open, scoped by
  the engine's own `enumerateScope` rules. Bundle membership = witnessed paths ∩
  dirty paths. Not "vs last user commit" — HEAD is the only boundary git enforces.
- **Bundle granularity = whole paths; commit worktree bytes.** Hunk-level
  splitting across concurrent agents is not safely automatable (proven by the
  4-commit blob-surgery split). Overlapping bundles merge or force an explicit
  user pick; checkpoints stay the audit trail, never the commit source.
- **The commit composer is a new module with its own safety review** — the first
  component ever allowed to touch the real index (the whole engine is built on
  "never touch HEAD/index/branches"). It serializes through the existing
  CheckpointQueue, refuses/snapshots a non-empty index, pins and re-verifies HEAD,
  and never reaches for checkout/restore/clean/stash in failure paths.
- **Expiry forecasting reuses `decidePruneEdges` with a future `now`** — the
  production predicate itself, so warnings can never disagree with what retention
  actually does. Warn ~48h before thinning, only for paths still dirty.

**Build order** (each stage shippable alone): ① read-only card (bundle assembler +
IPC + renderer) → ② expiry forecaster + warnings (subsumes proposal P1) →
③ composer, single-bundle, refuse-on-overlap → ④ overlap UX + plan grouping.

## Relation to the plan-surface revival strategy

This is **the same engine as Stage 3's commit composer** in
`.lares/proposals/supporting/2026-07-30-plan-surface-revival-technical-strategy.md`,
arriving from the other
direction: Stage 3 stages *a promoted proposal's artifacts*; the Save card stages
*any bundle of fleet work*. Build one composer (Save card Stage 3 above) and let
the plan-surface flow call it. The plan-grouping view depends on S1.B's
`turn_records.plan_id` stamps and should not block Stages ①–③.

## Amendments — 2026-07-30 cross-evaluation + Edward's rulings

Source: `.lares/proposals/supporting/2026-07-30-two-proposal-cross-evaluation-groupthink.md`
(GroupThink run 98b56a3e) + engine-owner and Plans-supervisor consultations +
Edward's selection-comment rulings. Authoritative over the body above where they
conflict.

1. **Decision A resolved: in-app commit stays, reframed as "commit finished
   packages" (Edward's ruling).** The user checks off a bundle and it commits —
   always user-initiated, never automatic. The unit committed is a SAID-AND-DONE
   work package, not in-flight work. Mechanically: commit current worktree bytes
   only after verifying they byte-match the package's final checkpoint
   snapshot. Match (the normal done case) ⇒ committing the disk IS committing
   the packaged checkpoint; no race exists. Mismatch ⇒ refuse + flag "changed
   since package completed" with the diff (and offer snapshot restore). This
   check-at-click replaces the workspace-quiescence gate; the groupthink's
   "preview + export only, never mutate the index" default is OVERRULED.
2. **Composer split retained.** `CommitCandidateService` (read-only, shared by
   Save card and plan surface: porcelain ∩ witnessed paths, overlap-connected
   components, preview via temporary GIT_INDEX_FILE) is separate from
   `CommitCoordinator` (the ONLY real-index writer; singleton; serialized via
   CheckpointQueue + repo-level compose lock; revalidates HEAD/index/blobs at
   click; single path-scoped `git commit --only`; hooks always run; never
   checkout/restore/clean/reset/stash in failure paths; adversarial test matrix
   must pass before enabling).
3. **Overlap is computed globally across BOTH grouping models** (fleet bundles
   and plan bundles can intersect), with one global compose-in-flight latch —
   two surfaces must never offer stale commits on intersecting path sets.
   Conflict topology, not plan membership, determines what is safely
   committable; plan is a filter/label + commit trailers
   (`Lares-Plan` / `Lares-Plan-Item` / `Lares-Turns`).
4. **Retention: protect, don't nag — with Edward's quota caveat.** Instead of
   expiry warnings, pin recovery edges for still-dirty paths automatically,
   bounded by an explicit storage quota + max extension (so an inattentive user
   cannot silently inflate the DB with micro-checkpoints). Speak only when the
   cap genuinely forces weakening: "lots of uncommitted work is eating recovery
   space — time to save." `decidePruneEdges` stays authoritative.
5. **Protection ledger added.** Three honest rungs — checkpoint-protected →
   locally committed → remote-reachable — recorded in commit/turn/path link
   tables; Lares' own commits link exactly, external commits conservatively.
   Replaces "commit to make permanent" copy with honest wording.
6. **Capture-health on the card.** Turns with missing snapshots, dirty paths no
   bundle witnessed (the unattributed pseudo-bundle), and capture-outage windows
   render as first-class flags — the card never pretends the witnessed union
   covers the tree.
7. **Build order revised:** ① read-only card (ships first — it dogfoods the
   shared bundle contract both proposals depend on) → ② retention pinning +
   protection ledger → ③ candidate preview from both surfaces (no index
   writes) → ④ CommitCoordinator behind the byte-match check + test matrix.

8. **UI identity (Edward's ruling).** The entry point is a **button styled like
   a little save card in the TOP bar, alongside Plans / Dashboard / Files**, and
   it opens the Save surface **in the main view** (same pattern as those
   surfaces). The experience should *feel like saving progress in a video
   game*: satisfying, deliberate, clearly "your progress is now safe." This
   answers open question 1: separate top-bar button opening a main-view
   surface, not a tab inside another surface.

9. **Grouping semantics (Edward's ruling, resolves open question "default
   grouping").** A commit should bundle work toward a **common goal**: the
   default package granularity is the **supervisor unit** (or the **plan**,
   when work is plan-bound). A **single worker's work is the smallest
   permissible package** — supported, but flagged as less ideal in the UI.
10. **Memory-jog descriptions (Edward's ruling).** Every package card leads
   with a plain-language line built from the supervisor/worker/plan **role
   description** plus **dates** — "this package is from supervisor X, who
   worked on Y, on date Z" — so the user recognizes the work without
   reading paths.
11. **Committed vs uncommitted differentiation (Edward's ruling).** Unsaved
   work is the visually loud primary section; saved work renders as a quiet,
   clearly-differentiated **recent-saves list only** (full commit history
   stays in git tooling, never on the card). The saved section terminates in
   an eventual **Push to origin** action — the third protection rung made
   actionable. Push is a later stage, same user-initiated contract as commit.
12. **Visual style (Edward's ruling).** Relatively simple, inspired by VS Code
   and ArcGIS; reuse the app's existing palette/tokens
   (src/renderer/styles/globals.css — surface tiers, accent blue, fg tiers),
   not a bespoke theme. **Approved visual reference:**
   `.lares/proposals/supporting/2026-07-30-save-card-ui-mockup.html` — a
   static HTML mockup of the final-form surface (open in a browser). It
   demonstrates: top-bar Save button w/ badge; supervisor-unit default
   grouping rail; ready/held/in-progress/unattributed card states; the
   byte-match verify block; memory-jog description lines; quiet recent-saves
   list; Push-to-origin row; recovery-space quota + protection ledger. UI
   workers (SC-WP-1C and later renderer WPs) should treat it as the layout
   and tone reference, using the app's real tokens rather than its inlined
   copies.

The remaining open question (warning threshold) is UI-level; nothing blocks
build stages ①–②.

## Hardening deliverables (2026-07-30, post-amendment)

The amendments above have been hardened into executable artifacts. Where they
conflict with this proposal's body, the deliverables below are authoritative:

- `.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md` — NORMATIVE
  contract v1 for "work package = candidate commit = save bundle" (the shared
  data model of Amendment/build-order item ①): types, DDL, token, stamping
  rules, `package_finalizations` freeze, test list. Serial GroupThink run
  50bfdec9.
- `.lares/proposals/supporting/2026-07-30-save-card-implementation-plan.md` —
  this proposal's implementation plan: ~40 worker-sized WPs (`SC-WP-*`) across
  stages ① read-only card → ② stamping/ledger/pinning → ③ finalization/preview
  → ④ CommitCoordinator behind the adversarial test matrix + enablement flag;
  includes the ownership ledger and user-identity commit env mode. Serial
  GroupThink run 6d5bb4b0.
- `.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md`
  — the sibling planning-surface plan, which consumes the `SC-WP-*` packages by
  name and shares the global DDL serialization barrier (A2).
- `.lares/proposals/supporting/2026-07-30-save-card-ui-mockup.html` — approved
  static mockup of the final-form Save surface (Edward-reviewed 2026-07-30;
  see Amendment 12 for what it demonstrates and how UI workers should use it).
