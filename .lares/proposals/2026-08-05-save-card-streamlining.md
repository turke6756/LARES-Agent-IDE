---
author: "Save Card Execution" (workspace supervisor, AgentDashboard)
author_agent_id: f57ca63c-9ea2-4120-94eb-11c7dfed1946
author_role: supervisor
author_provider: claude
authored_at: 2026-08-05T22:41:29Z
amended_at: 2026-08-06
---

# Save-card streamlining — GroupThink input brief (2026-08-05)

## Why this deliberation exists

Edward (the product owner) dogfooded the save-card flow on 2026-08-05 to commit
~50 files of real work packages and found it **not user friendly**: slow, jargon-
laden, and refusal-prone for the most normal workflow imaginable (saving several
packages one after another). Seven saves succeeded; the rest cascaded into
refusals. This brief carries his verbatim requirements and the verified technical
diagnosis. The deliverable is a worker-ready plan that streamlines the flow **from
the user's perspective** while keeping the safety invariants.

## Owner's acceptance bar (verbatim intent)

> "Just save and move on."
> "I want no refusals unless something's truly wrong and I want no user messages."

Concrete requirements, in the owner's words paraphrased:

1. **No refusals unless something is truly wrong.** A refusal caused by repo
   state moving (e.g. a previous save's own commit) while the package's file
   bytes are unchanged must be auto-recovered, not surfaced.
2. **No required user messages.** Commit messages must be auto-generated
   (the card already knows the files and turns). A message box may remain as an
   optional override only. Evidence: forced messages produced commits titled
   literally "ok".
3. **"Commit all" master checkmark** at the top of the save surface that
   selects/saves every package automatically, sequentially, handling staleness
   re-basing internally. This replaces the user hand-looping checkboxes.
4. **Loading feedback everywhere it is slow.** Checking a package's checkbox
   takes a long time (preview/verify runs); clicking Save takes a long time.
   Both need an in-place animation (spinner/progress on the checkbox itself and
   on the Save control) so the app never looks frozen.
5. **Plain language.** No internal stage names in user-visible copy ("Mint stage
   refused", "Re-pin current bytes", "candidate"). Every error message = one plain
   sentence + one action button that performs the recovery.
6. **Less acknowledgement ceremony.** The overlap/unattributed acknowledgement
   challenge should appear at most once per save gesture, and only when
   foreign-agent bytes are genuinely involved — not per card, not re-asked after
   harmless staleness.

## Verified technical diagnosis (session evidence, 2026-08-05)

- `candidateId` is a sha256 over an identity doc that includes **`pinnedHeadOid`
  and `indexFingerprint`** (whole-repo position), not just the package's member
  blobs — `src/main/commit-candidates/candidate-service.ts:980-1007`.
- Consequence: **every successful save moves HEAD and invalidates every other
  previewed card.** Sequential saves are structurally guaranteed to refuse with
  `candidate-ack-stale` ("The candidate changed after the preview even though the
  pinned files may still match" — `src/renderer/components/save/save-refusal-copy.ts:25`,
  raised at `src/renderer/components/save/candidate-submit.ts:132-139`).
- The copy itself admits the gap ("pinned files may still match") but the system
  does not check member-blob equality and pushes recovery onto the user
  ("Re-pin current bytes" → re-preview → re-ack → save).
- Real-world outcome: 7 commits landed (`3efafe19`, `4fed0c60`, `5bbc239e`,
  `5c587e9d`, `e37bab14`, `52dd906f`, `e46ae812`); the remaining ~14 modified +
  ~28 untracked files stalled behind repeated `candidate-ack-stale` refusals.
- Forced commit messages produced three commits titled "ok" — the message
  requirement adds friction without provenance value (trailers already carry
  provenance).

## Design question for the panel

How do we deliver "one click → everything saves → silence unless truly wrong"
**without weakening** the safety invariants that matter in a shared multi-agent
tree:

- never commit bytes the human did not review (preview/token binding);
- surface genuine conflicts (a file whose bytes changed since review, unmerged
  index, foreign-agent overlap the human has not seen);
- keep provenance trailers and finalization closure intact.

Proposed direction to stress-test (not a mandate):

- **Auto-rebase on harmless staleness**: on `candidate-ack-stale`, main-side
  re-previews; if every member's worktree blob OID is unchanged, re-mint and
  proceed silently. Only bytes-changed differences surface.
- **Save-all gesture**: a top-level control that runs the per-package pipeline
  sequentially main-side with automatic re-basing between commits, collecting
  any genuinely-required acknowledgements up front in a single pass, and
  reporting one summary at the end (N saved, M need attention).
- **Auto-generated commit messages** from package content/turns; optional
  override field; trailers unchanged.
- **Progress affordances**: per-checkbox busy state during preview/verify,
  Save-button progress state during mint+commit, and a global progress line for
  Save-all ("Saving 3 of 9…").
- **Copy pass**: rename user-facing controls and refusal strings to plain
  language; one action button per recoverable state.

The panel should challenge: batching semantics on partial failure (continue vs
halt), ack once-per-gesture soundness, races with concurrently-writing agents
during a Save-all sweep, token TTL across a long batch, and whether auto-rebase
must re-run finalization-closure checks per iteration.

## Constraints

- Keep the staged pipeline (pin → preview → verify → mint → commit) and the
  typed-refusal architecture; change *when refusals surface*, not the safety
  spine. Recent relevant commits: `8a9e13c8` (mint token on preview leg),
  `633e234c` (typed refusal stages), `acf626cd` (transactional gestures),
  `219adbaa` (ack-staleness refresh).
- No push; local commits only, as today.
- Output must be a worker-ready plan: concrete WPs with files, acceptance
  criteria phrased as user-visible behavior ("saving 9 packages sequentially
  produces 0 refusals when no bytes changed"), and test expectations.
