---
plan_artifact_id: plan_5b3ea7d1
kind: work-packages
schema_version: 1
---

# Work packages — save-card streamlining

Derived from `plan.md` and the folded deliberation
[deliberations/2026-08-06-carry-forward-equivalence.md](../deliberations/2026-08-06-carry-forward-equivalence.md).

**Read before dispatching any package.** The prose sections below are the
authority on scope; the machine block is a projection. Two standing rules from
the deliberation bind every package here:

- No byte the human did not review may be committed. A package that cannot hold
  that line must refuse, not guess.
- Review carry is decided **server-side** in main. The renderer never asserts
  that two manifests are equivalent.

<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_5b3ea7d1",
  "packages": [
    {
      "id": "WP-1",
      "order": 10,
      "title": "Reviewed semantic manifest and normalized commit effects",
      "initial_state": "ready",
      "acceptance_conditions": [
        "A versioned ReviewedSemanticManifest type exists with contract/repository identity, durable finalization intent, reviewed members, normalized commit effects, attribution topology, closure obligations, and challenge atoms.",
        "Normalizing a rename produces commit effects covering both source and destination paths, plus every commitPathspecs path, not only the displayed destination.",
        "The renderer-facing type exposes only the review and challenge view; the full manifest stays main-process only.",
        "Canonicalization uses the existing JCS helper and compares typed structures or SHA-256 digests, never serialized database JSON or array insertion order."
      ],
      "paths": [
        { "path": "src/shared/commit-candidates.ts", "intent_kind": "edit" },
        { "path": "src/shared/types.ts", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-2",
      "order": 20,
      "title": "Fix topology digest to include the ownership input overlap actually uses",
      "initial_state": "ready",
      "acceptance_conditions": [
        "The canonical topology contributor includes ownerAgentId, so a change that alters requiresOverlapAck can no longer leave componentTopologyDigest unchanged.",
        "A regression test constructs two inventories differing only in ownerAgentId and asserts the digests differ and the overlap requirement differs.",
        "Structured selected topology, ownership group keys, and overlap challenge atoms are returned alongside the digest, derived from the same structure that computes requiresOverlapAck.",
        "Existing overlap behaviour for unchanged inputs is preserved."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/component-assembler.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-3",
      "order": 30,
      "title": "Bind the full commit-effect set into candidate identity",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Candidate identity and the token snapshot bind the complete normalized commit-effect set, closing the gap where a rename changes what commits without changing hashed member fields.",
        "A test renames a member so its source path and pathspec change while every currently hashed member field stays equal, and asserts the candidate identity changes.",
        "pinnedHeadOid and indexFingerprint remain in the operational candidate identity and are unchanged in meaning.",
        "Preview and mint agree on the same effect set; the coordinator is never handed effects the preview did not bind."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/candidate-service.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-4",
      "order": 40,
      "title": "Carry predicate: reviewed-universe equality plus monotonic discharge",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Carry is permitted only when contract/repository identity match, durable intent matches, pending and discharged effects exactly partition the reviewed universe with nothing outside it, every pending effect is exactly equal including filtered representation and mode, every discharged effect carries a fresh exact already-saved proof, attribution projects without addition, and all eligibility and closure checks just succeeded.",
        "A reviewed effect may leave the pending set only with proof against current HEAD and a reachable reconciliation-ledger link; a missing dirty entry alone is rejected as proof.",
        "A newly selected path is never carried; a removed-then-reintroduced path is rejected.",
        "Acknowledgement carries by atom coverage, not whole-challenge equality: an unchanged challenge is not re-asked, a discharged subset is not re-asked, and any new or changed atom blocks only its own package.",
        "Acknowledgement coverage is validated in main against freshly derived atoms; a renderer-supplied equivalence claim is ignored.",
        "HEAD movement and unrelated stage-0 index churn alone do not refuse carry."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/candidate-service.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/save-card-ipc.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1", "WP-2", "WP-3"]
    },
    {
      "id": "WP-5",
      "order": 50,
      "title": "Exact-object commit construction",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Hook contract (Edward ruling 2026-08-06, option 1): commits built by this route do not run pre-commit, commit-msg, or signing, and that bypass is stated explicitly in the coordinator code and the save-path docs so a future hook author discovers it.",
        "The commit is built from reviewed object IDs, never from a post-review worktree read: temporary index seeded from the pinned HEAD tree, reviewed effects applied by raw-byte update-index index-info, write-tree, verify selected entries, commit-tree, then update-ref with an old-OID compare-and-swap.",
        "A worktree write injected after final revalidation but before commit construction does not enter the commit; the concurrent bytes remain visibly dirty afterwards.",
        "A HEAD move injected before the compare-and-swap produces a clean no-commit stale result and advances nothing.",
        "The real index is reconciled only for selected effect paths; unrelated staged entries are byte-identical before and after, verified against a pre-operation snapshot.",
        "Post-commit tree verification and reflog attempt identification remain as evidence, not as the mechanism that discovers unreviewed bytes after they land."
      ],
      "paths": [
        { "path": "src/main/git-checkpoints/commit-coordinator.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1", "WP-3"]
    },
    {
      "id": "WP-6",
      "order": 60,
      "title": "Main-side save-sweep service with halting rules",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "Sweep authority lives in main, keyed by repository, driven by a durable ordered list of finalization intents; renderer component, bundle, and entry IDs are never used as batch intent.",
        "Each package is freshly re-resolved before its turn: a package already fully satisfied by an earlier commit returns a deterministic already-saved result with proving commit OIDs and mints no token.",
        "Exactly one token is minted just in time per package and consumed immediately; nothing is pre-minted, so the five-minute TTL cannot expire mid-sweep.",
        "Any unmerged index entry anywhere halts the whole repository sweep before mint and marks remaining packages blocked; unaffected packages are not saved anyway.",
        "The sweep continues past a package-local refusal proven to occur before token consumption, and halts after any post-consume outcome other than fully reconciled success, including aborted-stale, aborted-error, repository-state-uncertain, committed-integrity-mismatch, transport failure, reconciliation failure, and inventory-refresh failure.",
        "A committed coordinator result is not success until reconciliation succeeds; a reconciliation failure halts, reports the known commit OID, and never auto-retries.",
        "Every input intent gets exactly one terminal result: saved, already-saved, needs-attention, blocked-unmerged, not-attempted, or halted-uncertain.",
        "Repeating the same gesture after a full refresh converts exact prior saves to already-saved rather than duplicating commits or raising stale refusals."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/save-sweep-service.ts", "intent_kind": "create" },
        { "path": "src/main/commit-candidates/commit-coordinator-ipc.ts", "intent_kind": "edit" },
        { "path": "src/main/commit-candidates/index-fingerprint.ts", "intent_kind": "edit" },
        { "path": "src/shared/types.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-4", "WP-5"]
    },
    {
      "id": "WP-7",
      "order": 70,
      "title": "Renderer: server verdict replaces the local staleness comparison",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The draft stores the review-manifest digest and structured acknowledged atom IDs and digests, and resets only changed or new atoms.",
        "Single-save submit uses the server carry verdict instead of comparing the drafted candidate ID against a fresh one, and preserves the existing no-auto-retry behaviour on uncertain outcomes.",
        "SaveCard sends durable finalization intents and reviewed acknowledgement evidence to the main-side sweep and renders one deterministic terminal result per intent.",
        "No renderer code loops over stale selection or component IDs to drive a batch.",
        "Saving nine packages sequentially with no bytes changed produces zero refusals end to end."
      ],
      "paths": [
        { "path": "src/renderer/components/save/candidate-submit.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/CandidatePreview.tsx", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/save-gesture-state.ts", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-6"]
    },
    {
      "id": "WP-8",
      "order": 80,
      "title": "Save-all control and progress affordances",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "A single top-level control starts the sweep over every saveable package; the user does not hand-loop checkboxes.",
        "Checking a package shows an in-place busy state on that checkbox while preview and verify run; the control cannot be double-fired.",
        "The Save control shows a progress state during mint and commit, and the sweep shows overall progress naming the current package.",
        "The end of a sweep shows one summary: how many saved, how many already saved, how many need attention, and whether the sweep halted.",
        "No part of the flow leaves the surface looking frozen with no indicator."
      ],
      "paths": [
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/CandidatePreview.tsx", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-7"]
    },
    {
      "id": "WP-9",
      "order": 90,
      "title": "Plain-language copy pass over controls and typed refusals",
      "initial_state": "ready",
      "acceptance_conditions": [
        "No user-visible string contains an internal stage name such as mint, candidate, pin, or token.",
        "Every recoverable refusal renders one plain sentence plus one action button that performs the recovery.",
        "Overlap copy says multi-owner or unattributed work and never claims the bytes are foreign to the user, because no identity source supports that claim.",
        "The typed refusal taxonomy and its codes are unchanged; only presentation changes.",
        "A test asserts the banned vocabulary does not appear in rendered save-surface copy."
      ],
      "paths": [
        { "path": "src/renderer/components/save/save-refusal-copy.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/SaveCard.tsx", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-10",
      "order": 100,
      "title": "Better default commit messages from package metadata",
      "initial_state": "ready",
      "acceptance_conditions": [
        "The default message body is derived from package and turn metadata instead of the generic Save N files, with a deterministic fallback when metadata is missing.",
        "Message text is sanitized and length-bounded, and a package with identical inputs always produces the identical message.",
        "The message box remains an optional override and is never required to save.",
        "Provenance trailers are unchanged."
      ],
      "paths": [
        { "path": "src/main/commit-candidates/save-card-ipc.ts", "intent_kind": "edit" },
        { "path": "src/renderer/components/save/CandidatePreview.tsx", "intent_kind": "edit" }
      ],
      "depends_on": []
    }
  ]
}
-->

## WP-1 — Reviewed semantic manifest and normalized commit effects

**Files** · `src/shared/commit-candidates.ts` (add types) · `src/shared/types.ts`
(renderer-safe review/challenge view only).

**Dep** · none. This is the contract every later package builds on.

**Do** · Add a versioned `ReviewedSemanticManifest` alongside the candidate types:
contract and repository identity (`manifestVersion`, `candidateContractVersion`,
`repositoryKey`, `objectDatabaseKey`, `gitObjectFormat` — no mutable workspace
aliases or titles); durable package intent (per finalization: `finalizationId`,
`packageId`, `packageRevision`, required `boundaryStatus: "ready"`, a digest of
the canonically sorted frozen member manifest, **and** the member records behind
that digest); reviewed members (final path bytes, expected present/absent state,
raw blob OID, commit blob OID, commit mode, sorted covering finalization IDs);
the complete normalized `commitEffects` set per logical member — every path the
commit can change, including rename and copy source paths and every current
`commitPathspecs` entry; attribution topology (component partition as sorted path
sets, full contributor tuples including `ownerAgentId`, derived group keys,
component edges, overlap requirement, selected unattributed set); closure
obligations for every non-selected frozen member; and the challenge atoms
(one `unattributed` atom per selected unattributed path, one `overlap` atom per
overlap-connected component). Canonicalize with the existing JCS helper.

**Accept** · As listed in the machine block. In particular a rename must produce
effects covering source *and* destination.

**Non-goals** · No behaviour change, no call-site rewiring, no predicate logic —
types and normalization only. Do not widen the renderer-visible surface beyond
the review and challenge view.

**Verify** · `npx tsc --noEmit` for both main and renderer configs; new unit
tests for effect normalization (rename, copy, delete, mode change) pass.

## WP-2 — Fix topology digest to include the ownership input overlap actually uses

**Files** · `src/main/commit-candidates/component-assembler.ts`.

**Dep** · WP-1.

**Do** · The canonical topology contributor (`:19-70`) omits `ownerAgentId`,
while `overlapFor` (`:190`) uses `ownerAgentId` to compute `mergedGroupCount` and
`requiresOverlapAck`. The digest can therefore stay equal while the
acknowledgement obligation changes — a real correctness bug independent of this
feature. Add the ownership identity to the canonical topology input, and return
the structured selected topology, ownership group keys, and overlap challenge
atoms derived from the *same* structure that computes `requiresOverlapAck`, so
the two can never disagree again.

**Accept** · As in the machine block; the regression test differing only in
`ownerAgentId` is the load-bearing one.

**Non-goals** · Do not change what overlap *means*, do not alter grouping rules,
and do not introduce any notion of a human principal.

**Verify** · `component-assembler` tests plus the sibling save suite.

## WP-3 — Bind the full commit-effect set into candidate identity

**Files** · `src/main/commit-candidates/candidate-service.ts`.

**Dep** · WP-1.

**Do** · Today the identity doc (`:980-1007`) hashes the final member path and
its representation, while the coordinator obtains `commitPathspecs` from fresh
reassembly (`commit-coordinator.ts:512`). A rename can acquire a different source
or pathspec without changing any hashed field. Include the complete normalized
commit-effect set in candidate identity and the token snapshot so preview, mint,
and coordinator cannot disagree about what will change.

**Accept** · As in the machine block; the rename test is the proof.

**Non-goals** · Do not remove `pinnedHeadOid` or `indexFingerprint` from the
operational identity — they stay; this package only adds. The decision to exclude
them from *review-carry equality* belongs to WP-4.

**Verify** · Candidate-service tests, the save suite, and a build.

## WP-4 — Carry predicate: reviewed-universe equality plus monotonic discharge

**Files** · `src/main/commit-candidates/candidate-service.ts` (predicate, fresh
closure proof) · `src/main/commit-candidates/save-card-ipc.ts` (return the
versioned review digest, structured challenge atoms, and durable intent; validate
carried acknowledgement server-side).

**Dep** · WP-1, WP-2, WP-3.

**Do** · Implement the deliberation's predicate. Let `R` be the reviewed manifest
and `F` a fresh reconstruction from durable finalization intent. Partition the
reviewed commit effects `U(R)` into still-pending `P(F)` and discharged `D(F)`.
Carry iff: same contract and repository; same durable intent; `P ∪ D = U`,
`P ∩ D = ∅`, and nothing in `F` outside `U`; every effect in `P` exactly equal
including clean-filtered representation, mode, and pathspec closure; every effect
in `D` carrying a fresh exact already-saved proof against current `HEAD` **and** a
reachable reconciliation-ledger link; attribution for `P` equal to `R` projected
onto `P` (projection may drop discharged paths, never add a contributor, group,
edge, unattributed path, or obligation); and all eligibility, unmerged, and
closure checks freshly passed this iteration. Acknowledgement carries by atom
coverage: `currentChallenge ⊆ acknowledgedAtoms`. Do not carry a boolean
`closureUnproven` from an opening preview — re-prove it.

**Accept** · As in the machine block. Note the two directions that matter: HEAD
movement alone must **not** refuse; a changed filtered blob, mode, expected
state, rename source, finalization revision, contributor tuple, `ownerAgentId`,
component partition, overlap group, or unattributed set **must** refuse, before
mint.

**Non-goals** · No sweep, no batching, no UI. Do not accept a renderer claim that
two manifests are equivalent. Do not add a path-scoped exception to the
repository-wide unmerged gate.

**Verify** · Candidate and IPC test suites plus their siblings; `tsc` for main.

## WP-5 — Exact-object commit construction

**Files** · `src/main/git-checkpoints/commit-coordinator.ts`.

**Dep** · WP-1, WP-3. The human decision that formerly blocked this package is
**RESOLVED** — see "Hook and signing contract" below.

**Do** · The window between final revalidation (`:533`) and `git commit --only`
(`:588`) cannot be closed by another pre-commit read: `git commit --only` rereads
the worktree, and ordinary agents honor neither the compose lock nor the
object-database lock. Build the commit from reviewed object IDs instead — under
both existing locks: temp index from the pinned `HEAD` tree → apply reviewed
effects with raw-byte `update-index --index-info` (never synthesizing an effect
from current worktree bytes) → `write-tree` → verify selected entries against the
reviewed effects → `commit-tree` → `update-ref` with an old-OID compare-and-swap
→ reconcile the real index only for selected effect paths, verifying unrelated
entries against a pre-operation snapshot.

**Hook and signing contract — RESOLVED, Edward ruled 2026-08-06 (option 1).**
This package changes `pre-commit`, `commit-msg`, and signing behaviour, because a
hook that can rewrite the index can introduce bytes outside the reviewed tree.
The ruling: **git hooks do not run in the Lares commit path.** Evidence behind
it — the repo has no active hooks (`.git/hooks/` holds only untouched samples),
no `core.hooksPath`, no husky, `commit.gpgsign` unset and no signing key, so
nothing is lost today. The alternative (non-mutating validation before
`commit-tree`) was offered and declined as unwarranted complexity for hooks that
do not exist.

**Obligation this places on you:** make the behaviour discoverable. State
explicitly, in the coordinator code and in whatever doc covers the save path,
that commits produced by this route bypass `pre-commit` / `commit-msg` / signing,
so a future hook author finds a clear statement rather than silently wondering
why their hook never fires. Do not implement hook support; do not leave it
unstated either.

**Accept** · As in the machine block; the injected-write and injected-HEAD-move
tests are the proof.

**Non-goals** · Do not keep `git commit --only` as a fallback path. Do not
attempt to preserve hook behaviour by allowing a hook to touch the index.

**Verify** · Coordinator tests including the injection cases; full main suite;
manual check that unrelated staged entries survive byte-identical.

## WP-6 — Main-side save-sweep service with halting rules

**Files** · `src/main/commit-candidates/save-sweep-service.ts` (new) ·
`src/main/commit-candidates/commit-coordinator-ipc.ts` (expose attempt certainty
and reconciliation as one sweep-consumable result) ·
`src/main/commit-candidates/index-fingerprint.ts` (keep the repository-wide
`hasUnmerged` gate; expose the fresh result) · `src/shared/types.ts` (IPC
request/result contract).

**Dep** · WP-4, WP-5. Blocked until both land — the sweep must not be enabled
while the TOCTOU window is open.

**Do** · Implement the eight-step sweep from the deliberation: capture durable
ordered intent and the union reviewed manifest and challenge (sorted by
repository key, package ID, package revision, finalization ID); per package,
refresh inventory and re-resolve, emitting a deterministic `already-saved` when
every reviewed effect is freshly proven in `HEAD`; apply the WP-4 predicate,
marking only the affected package `needs-attention` on any mismatch; re-run the
repository-wide unmerged and closure checks, halting the whole sweep on any
unmerged stage; mint one token just in time, consume, reconcile, refresh; continue
only past refusals proven pre-consumption; halt on every post-consume non-success.

**Accept** · As in the machine block. The classification is the contract: exactly
one terminal result per input intent.

**Non-goals** · No renderer changes. Never flatten a post-commit reconciliation
error into a continuable package refusal. Never pre-mint. Never save "unaffected"
packages past an unmerged index.

**Verify** · New sweep tests including the fake-clock case (advance past five
minutes between iterations; nothing expires because the next token does not exist
yet), the already-saved case, the partial-satisfaction case, and every halting
case; full main suite.

## WP-7 — Renderer: server verdict replaces the local staleness comparison

**Files** · `src/renderer/components/save/candidate-submit.ts` ·
`CandidatePreview.tsx` · `SaveCard.tsx` · `save-gesture-state.ts`.

**Dep** · WP-6.

**Do** · Replace the `draftCandidateId !== freshCandidateId(preview)` comparison
(`candidate-submit.ts:128-139`) with the server's carry verdict. Store the
review-manifest digest and structured acknowledged atom IDs and digests in the
draft, resetting only changed or new atoms. Send durable finalization intents and
acknowledgement evidence to the sweep; render one terminal result per intent.

**Accept** · As in the machine block — including the user-visible bar: nine
packages saved sequentially with no bytes changed produce zero refusals.

**Non-goals** · Do not preserve any renderer-side equivalence judgement. Do not
loop over `selectionForGroup` or `selectionForPins` IDs to drive a batch. Do not
weaken the uncertain-outcome no-retry behaviour at `candidate-submit.ts:217,232`.

**Verify** · Renderer save suite and its siblings; `tsc` for the renderer.

## WP-8 — Save-all control and progress affordances

**Files** · `src/renderer/components/save/SaveCard.tsx` · `CandidatePreview.tsx`.

**Dep** · WP-7.

**Do** · Add the top-level save-all control and the missing feedback: per-checkbox
busy state during preview and verify, a progress state on the Save control during
mint and commit, an overall sweep progress line naming the current package, and a
single end-of-sweep summary (saved / already saved / needs attention / halted).

**Accept** · As in the machine block.

**Non-goals** · The master control is a gesture initiator only — it is **not**
evidence that byte-level content was reviewed, and it must not auto-acknowledge
anything. Do not add a second acknowledgement ceremony to compensate.

**Verify** · Renderer save suite; manual pass over a multi-package save.

## WP-9 — Plain-language copy pass over controls and typed refusals

**Files** · `src/renderer/components/save/save-refusal-copy.ts` · `SaveCard.tsx`.

**Dep** · none — independent of the engine work, safe to run in parallel.

**Do** · Rewrite user-visible copy to one plain sentence plus one action button
per recoverable state. The stage-prefix switch at `save-refusal-copy.ts:9` is the
target. Overlap copy must say *multi-owner or unattributed work*, never "another
agent's" or "foreign" — no identity source supports that claim.

**Accept** · As in the machine block, including the banned-vocabulary test.

**Non-goals** · Do not change refusal codes, the taxonomy, or any behaviour.
Presentation only.

**Verify** · Renderer save suite; grep the rendered copy for the banned terms.

## WP-10 — Better default commit messages from package metadata

**Files** · `src/main/commit-candidates/save-card-ipc.ts` (the
`defaultMessageBody` generator at `:531`) ·
`src/renderer/components/save/CandidatePreview.tsx` (override presentation).

**Dep** · none — independent, safe to run in parallel.

**Do** · Auto-generation already exists; the default is just the generic
`Save N files`. Derive a better default from package and turn metadata, with a
deterministic fallback when metadata is missing, plus sanitization and a length
bound. Keep the textarea as an optional override.

**Accept** · As in the machine block; identical inputs must always produce an
identical message.

**Non-goals** · Do not make the message required. Do not touch provenance
trailers. Do not read repository content to summarize a diff.

**Verify** · IPC tests for the generator (including the fallback and sanitization
cases); renderer save suite.
