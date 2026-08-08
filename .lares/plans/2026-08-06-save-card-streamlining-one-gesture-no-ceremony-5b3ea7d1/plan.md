---
artifact_id: prop_5b3ea7d1
title: Save-card streamlining — one gesture, no ceremony
author: "new propsoal" (supervisor, AgentDashboard)
author_agent_id: 229530a1-04f9-4781-9c8d-a92cae9b7e18
author_role: supervisor
author_provider: claude
authored_at: 2026-08-06T22:11:55Z
---

# Save-card streamlining — one gesture, no ceremony

## In plain terms

Saving your work should feel like pressing save. Today it doesn't. When the owner
sat down to save about fifty files of finished work, the first handful went
through and the rest piled up behind error messages — each one asking him to
redo a step, confirm something he had already confirmed, and type a description
the app could have written itself. The errors were not warning him about real
danger; they fired because each successful save nudged the project's state
forward, which made every other pending save look out of date, even though not a
single file had actually changed.

This proposal is about fixing that experience. The app should let you tick one
box at the top, walk away, and come back to everything saved. It should write its
own descriptions, show a spinner wherever it is thinking, speak in ordinary
sentences instead of internal stage names, and interrupt you only when something
is genuinely wrong — a file that really did change under you, or work belonging
to another agent that you have not yet looked at. Nothing here loosens those
genuine protections; it only stops the app from crying wolf about its own
bookkeeping.

## Why this proposal exists

Edward dogfooded the save-card flow on 2026-08-05 to commit ~50 files of real
work packages and found it **not user friendly**: slow, jargon-laden, and
refusal-prone for the most normal workflow imaginable (saving several packages
one after another). Seven saves succeeded; the rest cascaded into refusals. This
document carries his verbatim requirements and the verified technical diagnosis.
The deliverable is a worker-ready plan that streamlines the flow **from the
user's perspective** while keeping the safety invariants.

> Replicates the structure and findings of
> `.lares/proposals/2026-08-05-save-card-streamlining.md` (a GroupThink input
> brief), restamped under the proposal contract so the Plans pane can scope it
> directly. If both survive, treat this one as the promotable artifact.

## Owner's acceptance bar (verbatim intent)

> "Just save and move on."
> "I want no refusals unless something's truly wrong and I want no user messages."

Concrete requirements, in the owner's words paraphrased:

1. **No refusals unless something is truly wrong.** A refusal caused by repo
   state moving (e.g. a previous save's own commit) while the package's file
   bytes are unchanged must be auto-recovered, not surfaced.
2. **No required user messages.** Commit messages must be auto-generated (the
   card already knows the files and turns). A message box may remain as an
   optional override only. Evidence: forced messages produced commits titled
   literally "ok".
3. **"Commit all" master checkmark** at the top of the save surface that
   selects/saves every package automatically, sequentially, handling staleness
   re-basing internally. This replaces the user hand-looping checkboxes.
4. **Loading feedback everywhere it is slow.** Checking a package's checkbox
   takes a long time (preview/verify runs); clicking Save takes a long time. Both
   need an in-place animation (spinner/progress on the checkbox itself and on the
   Save control) so the app never looks frozen.
5. **Plain language.** No internal stage names in user-visible copy ("Mint stage
   refused", "Re-pin current bytes", "candidate"). Every error message = one
   plain sentence + one action button that performs the recovery.
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
  pinned files may still match" —
  `src/renderer/components/save/save-refusal-copy.ts:25`, raised at
  `src/renderer/components/save/candidate-submit.ts:132-139`).
- The copy itself admits the gap ("pinned files may still match") but the system
  does not check member-blob equality and pushes recovery onto the user
  ("Re-pin current bytes" → re-preview → re-ack → save).
- Real-world outcome: 7 commits landed (`3efafe19`, `4fed0c60`, `5bbc239e`,
  `5c587e9d`, `e37bab14`, `52dd906f`, `e46ae812`); the remaining ~14 modified +
  ~28 untracked files stalled behind repeated `candidate-ack-stale` refusals.
- Forced commit messages produced three commits titled "ok" — the message
  requirement adds friction without provenance value (trailers already carry
  provenance).

### Corrections from the 2026-08-06 scoping review (codex `9d6c0db0`)

Two claims above are imprecise; the plan must carry the corrected versions.

- **The `candidate-ack-stale` refusal is not universal.** The stale comparison
  runs only when a stored preview draft exists
  (`src/renderer/components/save/candidate-submit.ts:128-139`). A card submitted
  without an opened/stored draft uses the fresh preview and can commit without
  the refusal. The precise claim: *every successful commit invalidates every
  previously previewed candidate identity, and every later submit carrying that
  earlier draft is structurally routed to `candidate-ack-stale`.*
- **Auto-generated messages already exist; P3 is a quality gap, not a missing
  mechanism.** Main supplies `defaultMessageBody = "Save N files"`
  (`src/main/commit-candidates/save-card-ipc.ts:531`), submit falls back to it
  (`candidate-submit.ts:77`), and the textarea is already an optional override
  (`CandidatePreview.tsx:338`). The commits titled "ok" were a user typing over
  a working default, not a forced-input bug. P3 becomes: derive a better default
  from package/turn metadata, with deterministic fallback and sanitization.

The rest of the diagnosis is confirmed verbatim against the current tree:
`candidateId` still hashes `pinnedHeadOid` + `indexFingerprint`
(`candidate-service.ts:980-1007`), and `indexFingerprint` hashes the whole
parsed `git ls-files --stage -z` output
(`src/main/commit-candidates/index-fingerprint.ts:3,120`) — so candidate B's
identity cannot survive commit A even when every one of B's bytes is unchanged.

## The design question

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
  sequentially main-side with automatic re-basing between commits, collecting any
  genuinely-required acknowledgements up front in a single pass, and reporting
  one summary at the end (N saved, M need attention).
- **Auto-generated commit messages** from package content/turns; optional
  override field; trailers unchanged.
- **Progress affordances**: per-checkbox busy state during preview/verify,
  Save-button progress state during mint+commit, and a global progress line for
  Save-all ("Saving 3 of 9…").
- **Copy pass**: rename user-facing controls and refusal strings to plain
  language; one action button per recoverable state.

Open challenges any reviewer or panel should push on: batching semantics on
partial failure (continue vs halt), ack once-per-gesture soundness, races with
concurrently-writing agents during a Save-all sweep, token TTL across a long
batch, and whether auto-rebase must re-run finalization-closure checks per
iteration.

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

## Risks surfaced by the scoping review (not in the original brief)

Load-bearing findings from the independent read of the current implementation.
Each is a constraint on the design, not a work package.

1. **Raw worktree blob equality is too weak a carry-forward test.** Candidate
   identity also binds expected commit blob + mode, present/absent state,
   finalization identities, and component topology
   (`candidate-service.ts:986-1005`). A new member can enter a resolved
   component while every old member is untouched; unchanged bytes can acquire
   new foreign provenance.
2. **Finalization-closure checks must re-run every iteration.** Eligibility
   reruns prior-exact-commit closure per included finalization
   (`candidate-service.ts:959`). A sweep cannot reuse its opening verdict.
3. **The existing locks do not stop ordinary agents writing the worktree.** The
   compose lock serializes Lares commits; the object-DB lock serializes commit
   vs restore (`git-checkpoints/commit-coordinator.ts:8`). Neither prevents
   another terminal agent writing a selected file between final revalidation
   (`:533`) and the commit itself (`:588`). Post-commit tree verification
   catches it as `committed-integrity-mismatch` (`:483`) — but the unreviewed
   bytes have already landed. A long sweep widens this existing TOCTOU window.
4. **Mint just in time; never pre-mint a batch.** Tokens carry a 5-minute TTL
   (`candidate-service.ts:73`, expiry `:363`), and pre-minted identities are
   invalidated by the first commit anyway. Preview → mint → consume must happen
   per iteration.
5. **Unmerged index state is repository-wide.** `hasUnmerged` feeds eligibility
   (`:971`) and yields `unsupported-git-state` (`:1038`). "Save the unaffected
   packages anyway" is a deliberate invariant change, not harmless rebasing.
6. **An uncertain outcome must stop the sweep.** Submit deliberately refuses to
   auto-retry when commit transport or reconciliation is uncertain
   (`candidate-submit.ts:217,232`). A batch may continue past a clean
   pre-mutation refusal, but must halt and re-inventory after any outcome where
   a commit may have landed.
7. **Reconciliation failure is post-commit failure.** Coordinator reconciliation
   runs only after a committed outcome (`commit-coordinator-ipc.ts:167`); if
   ledger/finalization closure fails, the commit already exists. Filing it under
   "M need attention" and continuing lets later closure decisions run on
   incomplete evidence.
8. **"Ack at most once" cannot be absolute.** If new overlap or unattributed
   work appears mid-gesture, the system must re-ask or leave that package
   unsaved. The defensible rule is *never re-ask while the complete
   acknowledgement challenge is unchanged.*
9. **An up-front union acknowledgement needs its own immutable challenge.** Mint
   validates acknowledgement against freshly resolved topology (`:258`). Each
   iteration must prove its current challenge is exactly covered by the reviewed
   union; anything newly appearing falls out to attention.
10. **Batch intent must survive regrouped cards.** Component identity derives
    from the current dirty-entry set (`component-assembler.ts:269`); earlier
    commits change it. Drive later iterations from durable package/finalization
    intent, never stale renderer component ids.
11. **"Already saved" needs an explicit result.** A prior batch commit can fully
    satisfy a later package. That must resolve to a deterministic skip, not a
    stale refusal and not an empty commit.
12. **"Foreign-agent bytes" is not yet implementable as stated.** Overlap today
    means `mergedGroupCount >= 2` over owner/plan/plan-item groupings
    (`component-assembler.ts:188,205`) — there is no comparison against the
    initiating human's identity. Requirement 6 needs "foreign" defined against
    an identity source that actually exists.

## Hardening scope

- **Verdict (dated):** 2026-08-06 — one part needs multi-agent deliberation: the
  equivalence predicate that decides what a human's prior review and
  acknowledgement may carry across a commit boundary, together with the sweep
  semantics that depend on it (requirements 1, 3 and 6 / parts P1, P2, P6). The
  remaining parts need no hardening and go straight to packaging: P3
  (better-generated commit messages — mechanism already exists), P4 (progress
  affordances — ordinary renderer state), P5 (plain-language copy pass — bounded
  pass over a typed vocabulary). **No online research on any part**: these are
  repository-contract and product-policy questions, and no external source can
  determine this codebase's intended safety invariant.
- **Second opinion:** consulted — codex worker "Scoping second opinion — save-card
  streamlining" (`9d6c0db0-7eea-43b6-b3f8-92f0aac6c30e`), independent read of the
  current implementation. It confirmed the core `candidateId` diagnosis, corrected
  two claims (recorded above), supplied the 12 risks above, and named the single
  hard question.
- **Marked intents:** `int_7c1e94af` — the carry-forward equivalence predicate and
  the batch-sweep semantics that depend on it (P1, P2, P6). P3/P4/P5 carry no
  intent by design.

<!--PLAN-INTENT
{ "intent_id": "int_7c1e94af", "part": "carry-forward-equivalence-and-sweep-semantics",
  "kind": "groupthink-parallel",
  "targets": [ { "provider": "claude", "model": "claude-opus-5" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "Decides what prior human review/acknowledgement may carry across a commit boundary and when a sweep must halt — a wrong answer silently commits unreviewed bytes or drops a real conflict." }
-->

The question the deliberation must answer, as the scoping review framed it:

> What exact equivalence predicate permits Lares to carry a human's prior review
> and acknowledgement across a fresh preview after HEAD/index movement — without
> silently admitting a newly selected path, a changed expected state or filtered
> representation, changed attribution/overlap topology, or a no-longer-proven
> finalization closure?

The candidate answer to stress-test is **bidirectional equality of the reviewed
semantic manifest** — exact path/member set, expected present/absent state, raw
blob OID, expected commit blob OID and mode, finalization identities and
revisions, component topology and unattributed set, acknowledgement challenge,
and fresh eligibility/closure proof — while allowing whole-repository
`pinnedHeadOid` and unrelated index position to differ, but only after all of
the above is freshly reconstructed.

## Hardening outcome — deliberation folded in

[Carry-forward equivalence and save-sweep semantics](deliberations/2026-08-06-carry-forward-equivalence.md)
— GroupThink parallel (Codex synthesizer + Claude peer), run `a1bacc4a`, serving
`int_7c1e94af`.

<!--PLAN-INTEGRATION
{ "intent_id": "int_7c1e94af", "output_rel_path": "deliberations/2026-08-06-carry-forward-equivalence.md",
  "changed": "Rejected the proposal's candidate predicate (bidirectional equality of the reviewed candidate manifest) as both too weak and too strict; replaced it with reviewed-universe equality plus proof-bearing monotonic discharge. Established a new versioned ReviewedSemanticManifest separate from operational candidate identity. Found two concrete safety gaps in the current code: candidate identity binds only the final member path, not the full commit-effect/pathspec set (renames can change what commits), and componentTopologyDigest omits the ownerAgentId that overlapFor actually uses, so the acknowledgement obligation can change while the digest does not. Made exact-object commit construction (commit-tree + CAS update-ref, replacing worktree-reading git commit --only) a PREREQUISITE to enabling the sweep rather than a follow-up, expanding scope and raising an unresolved git-hook/signing compatibility decision. Settled halting (continue only before token consumption; halt after any post-mutation non-success), just-in-time minting, repository-wide unmerged blocking, deterministic already-saved results, and acknowledgement carry by atom coverage rather than whole-challenge equality. Scoped requirement 6 down honestly to multi-owner/plan overlap plus unattributed work, since no authenticated human principal exists.",
  "disposition": "active" }
-->

The run also left the Claude planner's independent round-1 draft in the folder:
[claude draft](deliberations/int_7c1e94af-claude-draft.md). It carries valid §R1
frontmatter, so it is a genuine returned output — but it is an input to the
synthesis above, not a parallel conclusion, and is recorded as **superseded** so
it does not hold the intent open.

<!--PLAN-INTEGRATION
{ "intent_id": "int_7c1e94af", "output_rel_path": "deliberations/int_7c1e94af-claude-draft.md",
  "changed": "Round-1 independent draft from the claude planner (self-declared orchestration_id a0173b0f, distinct from the run id). Its substance was cross-pollinated into and superseded by the synthesized deliberation; retained for provenance, excluded from the fully-folded requirement.",
  "disposition": "superseded" }
-->

**Consequences the packaging step must respect** (from the deliberation, not the
original brief):

- The **TOCTOU fix is a prerequisite, not a follow-up.** The window between final
  revalidation (`commit-coordinator.ts:533`) and `git commit --only` (`:588`)
  cannot be closed by another pre-commit read, because `git commit --only`
  rereads the worktree and ordinary agents honor neither Lares lock. A long
  automated sweep multiplies that exposure, so the commit must be built from
  reviewed object IDs (`commit-tree` + CAS `update-ref`) **before** the sweep is
  enabled. This carries an unresolved product decision on `pre-commit`/
  `commit-msg`/signing behavior — escalate rather than decide it in a WP.
- **Two latent gaps exist in the current code independent of this feature:**
  candidate identity omits the full commit-effect/pathspec set (a rename can
  change what is committed without changing hashed member fields), and
  `componentTopologyDigest` omits the `ownerAgentId` that `overlapFor` uses
  (`component-assembler.ts:19-70` vs `:190`), so an acknowledgement obligation
  can change while the digest stays equal.
- **Requirement 6 is scoped down honestly** to *multi-owner/plan overlap plus
  unattributed work*. "Foreign to the human" is not implementable without an
  authenticated human principal, a durable principal→agent ownership mapping, and
  that principal stamped onto immutable turn witnesses.
- **Sweep authority moves into the main process**; the renderer becomes a gesture
  initiator and result renderer, never a loop over stale component ids.

## Packaging and recovery point

Ten work packages, in the bundle contract shape, are in
[supplements/2026-08-06-work-packages.md](supplements/2026-08-06-work-packages.md).
The human register is [OVERVIEW.md](OVERVIEW.md).

**Baseline tag:** `plan-baseline/2026-08-06-save-card-streamlining-one-gesture-no-ceremony-5b3ea7d1`
— local annotated tag at `e1a6ab5a`, **never pushed**. Any code this plan deletes
is one `git show <tag>:<path>` away, so deletion packages need no copy-aside
archiving. *Advisory:* 56 uncommitted paths were present at tag time; the tag
captures committed HEAD only and does not cover them.

**WP-5 is blocked on a human decision**, not on other work: exact-object commit
construction changes `pre-commit` / `commit-msg` / signing behaviour, and WP-6
through WP-8 sit behind it. WP-1, WP-2, WP-3, WP-9 and WP-10 are dispatchable
immediately.
