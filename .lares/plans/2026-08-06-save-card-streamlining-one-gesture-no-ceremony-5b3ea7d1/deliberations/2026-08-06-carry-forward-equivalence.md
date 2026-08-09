---
plan_artifact_id: plan_5b3ea7d1
intent_id: int_7c1e94af
orchestration_id: a1bacc4a
kind: deliberation
---

# Carry-forward equivalence and save-sweep semantics

## Decision

Do not use equality of `candidateId`, equality of the current
`componentTopologyDigest`, or raw worktree blob equality as the carry-forward
predicate. Replace the candidate answer in `plan.md` with **reviewed-universe
equality plus monotonic discharge**:

> A fresh reconstruction may inherit a human's review only when it is in the
> same repository and contract, is derived from the same durable finalization
> intent, contains no commit effect outside the reviewed universe, and every
> still-pending effect is byte-, representation-, operation-, attribution-, and
> closure-equivalent to what was reviewed. A reviewed effect may disappear from
> the pending set only when current-HEAD and reconciliation-ledger evidence prove
> that exact reviewed effect is already saved. The fresh reconstruction must be
> eligible in its entirety. An acknowledgement may carry only for challenge
> atoms already covered by the human's acknowledgement; any new or changed atom
> requires attention.

Formally, let `R` be the canonical reviewed semantic manifest and let `F` be a
fresh reconstruction from durable package intent. Define `U(R)` as the set of
reviewed commit effects, keyed by authoritative path bytes. Partition it on each
iteration into `P(F)` (effects still pending) and `D(F)` (effects discharged as
already saved). Carry is permitted iff all of the following hold:

1. `sameContractAndRepository(R, F)` is true.
2. `sameDurableIntent(R, F)` is true.
3. `P(F) ∪ D(F) = U(R)`, `P(F) ∩ D(F) = ∅`, and `F` has no effect outside
   `U(R)`. Equality is over canonical path bytes, not display paths or renderer
   IDs.
4. Every effect in `P(F)` is exactly equal to its reviewed effect, including raw
   and clean-filtered representations and operation/pathspec closure.
5. Every effect in `D(F)` has a fresh, exact already-saved proof against current
   `HEAD` and the reconciliation ledger. A missing dirty entry alone is not proof.
6. The attribution graph for `P(F)` equals the projection of `R` onto `P(F)`, and
   the current acknowledgement challenge is covered by the acknowledged
   challenge atoms in `R`. Projection may remove discharged paths; it may not add
   a contributor, ownership grouping, component edge, unattributed path, or
   acknowledgement obligation.
7. All repository-wide and per-package eligibility checks, including unmerged
   index state and finalization closure, have just succeeded for this iteration.

Canonicalize the compared structures with the existing JCS helper and compare
their typed structures or SHA-256 digests. Do not compare serialized database
JSON, array insertion order, display text, or a digest whose input schema is not
versioned and available for diagnostic field-by-field comparison.

This is intentionally not literal bidirectional equality of the *pending*
candidate manifest. Literal equality is too weak in fields the current candidate
omits, and too strict after an earlier iteration has exactly saved a reviewed
path. The only permitted asymmetry is monotonic discharge with proof. A newly
pending path is never permitted.

## The reviewed semantic manifest

Add a main-process-only, versioned `ReviewedSemanticManifest` contract alongside
the candidate types in `src/shared/commit-candidates.ts`. Build and retain it in
main; expose only the renderer-safe review/challenge view through
`src/shared/types.ts`. It must contain these canonical fields:

### Contract and repository identity

- `manifestVersion` and `candidateContractVersion`: prevent a carry decision
  across changed comparison semantics.
- `repositoryKey`, `objectDatabaseKey`, and `gitObjectFormat`: prevent equal-looking
  blobs or paths from crossing repositories, object databases, or hash formats.
  Do not include mutable workspace aliases or titles.

### Durable package intent

- For every included finalization: `finalizationId`, `packageId`,
  `packageRevision`, required `boundaryStatus: "ready"`, and a digest of the
  parsed, canonically sorted frozen member manifest.
- The exact frozen member records behind that digest: authoritative path bytes,
  expected present/absent state, raw blob OID, commit blob OID, and commit mode.
  Comparing the records as well as identity/revision avoids assuming that a
  database row can never be corrupted or rewritten.

`finalizationId` is the durable re-resolution handle. `componentId`, `bundleId`,
and dirty `entryId` are not batch intent: the renderer derives them from a live
dirty graph and earlier commits can regroup or remove them.

### Reviewed members and commit effects

- For each reviewed logical member: final path bytes, expected worktree
  present/absent state, raw worktree blob OID, expected commit blob OID, expected
  commit mode, and sorted covering finalization IDs.
- For each logical member, the complete canonical `commitEffects` set: every
  path the commit can change, with path bytes, expected post-commit
  present/absent state, expected blob OID, and mode. Include rename/copy source
  paths and every current `commitPathspecs` path, not only the displayed
  destination.

The second list closes a gap in the candidate answer. `candidate-service.ts:980`
currently hashes only the final member path and its representation, while
`commit-coordinator.ts:512` obtains `commitPathspecs` from fresh reassembly. A
rename can therefore acquire a different source/pathspec without changing the
currently hashed member fields. No carry predicate can promise "no newly selected
path" until the preview and candidate identity bind the full commit-effect set.
`entryKind`, `originalPath`, and `commitPathspecs` in the dirty inventory are
inputs to that normalized effect set; compare the normalized effects rather than
status lettering that can change without changing the commit.

### Attribution and topology

- The selected component partition as sorted sets of member path bytes.
- For every selected path, the complete sorted contributor tuples:
  `turnId`, `agentId`, `ownerAgentId`, `planId`, and `planItemId`.
- The derived ownership/plan/plan-item group keys, component edges, overlap
  requirement, and exact selected unattributed path set.
- A versioned acknowledgement challenge derived from those structures, described
  below.

Do not reuse the existing `componentTopologyDigest` as sufficient evidence.
`component-assembler.ts:19-70` omits `ownerAgentId` from its topology contributor,
but `overlapFor` uses `ownerAgentId` at line 190 to calculate
`mergedGroupCount` and `requiresOverlapAck`. The digest can remain unchanged while
the acknowledgement obligation changes. Extend the canonical topology input to
include the ownership identity used by the overlap calculation, and return the
structured topology/challenge with its digest for diagnostics and tests.

### Fresh closure obligations and proof

- Canonical closure obligations for every non-selected frozen member of every
  included finalization: finalization ID, path bytes, expected state, commit blob
  OID, and mode.
- A fresh proof result for every obligation. An acceptable proof names an exact
  reconciliation ledger link and proves that its commit is reachable from current
  `HEAD`; for a current-HEAD disposition, the tree entry at that path must equal
  the reviewed expected entry (or be absent for a reviewed deletion).

The obligation set must remain semantically identical after accounting for
monotonic discharge, but the particular proving commit OID may differ. Evidence
identity is operational; exact expected state and fresh proof are the invariant.
Do not carry the boolean `closureUnproven` from an opening preview.

## What may deliberately differ

After full fresh reconstruction, carry may ignore:

- `pinnedHeadOid`, provided the iteration repins the current `HEAD` and all fields
  above still pass. A token or candidate minted against the old head is never
  reused.
- The whole-repository `indexFingerprint`, `writeTreeOid`, and unrelated stage-0
  index entries. They remain operational inputs to the newly minted candidate and
  post-commit index-integrity check. Any stage 1/2/3 entry anywhere blocks the
  repository.
- Candidate ID, token ID, issue/expiry timestamps, and token-store sequence.
- Renderer `bundleId`, `componentId`, `entryId`, cached selection arrays, display
  paths, workspace aliases/titles, ordering before canonicalization, protection
  rung, capture-health presentation, and generated message text.
- Unselected inventory changes that neither enter the reviewed commit-effect
  universe nor alter its component partition, contributor graph, closure, or
  challenge.
- Removal of a reviewed pending effect only through the exact already-saved proof
  above.

These are permissions to differ, not fields to copy forward. Every iteration
still reconstructs repository state, commit representations, topology,
eligibility, closure, and the token snapshot from scratch.

## Acknowledgement carry and the up-front union

Represent the complete challenge as a canonical set of independently comparable
atoms, not one opaque union digest:

- one `unattributed` atom per selected unattributed path, binding the full reviewed
  member/effect digest for that path;
- one `overlap` atom per overlap-connected component, binding its sorted member
  paths, contributor tuples including `ownerAgentId`, ownership group keys, and
  overlap reason/version.

The acknowledgement record stores the exact atoms the human saw and accepted,
plus the reviewed-manifest digest. A fresh iteration may carry acknowledgement iff
every current challenge atom has an exactly equal acknowledged atom and the
review-carry predicate also passes. This yields the user rule:

> Never re-ask while the complete current acknowledgement challenge is already
> covered; ask only for new or changed challenge atoms, and do not save the
> affected package until they are acknowledged.

Exact challenge equality is sufficient but unnecessarily strict after an earlier
iteration discharges a reviewed path. Set coverage is equally safe and avoids
re-asking for a smaller challenge. It never treats a changed topology as covered,
because a changed contributor, owner grouping, path set, or representation creates
a different atom.

A single up-front union acknowledgement is sound only when the human is shown and
acknowledges the immutable union of these atoms after the union review manifest is
built. Each iteration must prove `currentChallenge ⊆ acknowledgedUnion`. Do not
auto-check acknowledgements, do not construct the union from stale renderer IDs,
and do not treat acknowledgement of one digest as permission for later atoms that
were not displayed. If a new atom appears mid-sweep, mark that package as needing
attention; the rest may continue only under the clean pre-mutation rule below.

True "foreign-agent bytes" remains out of scope for this change. Current overlap
means multiple owner/plan/plan-item groups, not foreignness to a human. Until there
is a server-authoritative identity source, label and test the requirement honestly
as **multi-owner/plan overlap plus unattributed work**. Implementing human-relative
foreignness would require (1) an authenticated human principal attached by main to
the gesture, never supplied by renderer payload; (2) a durable mapping from that
principal to the supervisor/agents it owns or acts for; and (3) that principal or
ownership mapping stamped onto immutable turn witnesses. `ownerAgentId` alone is an
agent grouping and cannot identify the initiating human.

## Sweep algorithm and halting rules

Move sweep authority into the main process. Add a repository-keyed sweep service
under `src/main/commit-candidates/` and an IPC request/result contract in
`src/shared/types.ts`; keep `SaveCard.tsx` as a gesture initiator and result
renderer. The service executes these steps sequentially:

1. Capture a durable ordered list of finalization intents and the union reviewed
   manifest/challenge. Sort by repository key, package ID, package revision, then
   finalization ID. Do not persist renderer component IDs as intent.
2. Before every package, refresh inventory and re-resolve its active finalization
   against the current dirty graph and ledger. If all reviewed effects are freshly
   proven in current `HEAD`, emit deterministic
   `already-saved { packageId, packageRevision, provingCommitOids }`; do not mint an
   empty candidate.
3. Apply reviewed-universe equality plus monotonic discharge. A changed byte,
   filtered representation, mode, expected state, commit effect, finalization
   revision, contributor graph, overlap atom, or unattributed atom makes only that
   package `needs-attention` before mutation. Never silently widen or rewrite the
   intent.
4. Re-run repository-wide unmerged-index detection and every eligibility and
   finalization-closure proof. Any unmerged stage is a repository-wide blocking
   result: halt before mint and mark all remaining packages blocked. Do not save
   "unaffected" packages.
5. Mint exactly one token just in time from this fresh context, immediately consume
   it, reconcile the committed outcome, then refresh authoritative inventory before
   the next package. Never pre-mint: the five-minute TTL at
   `candidate-service.ts:73` and the first commit's identity movement make batch
   tokens invalid by construction.
6. Continue after `saved`, `already-saved`, or a package-local refusal proven to
   occur before token consumption/attempt creation. Record a pre-mutation refusal
   as `needs-attention` and freshly reconstruct the next package; do not reuse the
   failed package's context.
7. Once a token is consumed or a commit attempt exists, any result other than
   fully reconciled `saved` halts the sweep and forces repository re-inventory.
   This deliberately includes `aborted-stale` and `aborted-error`: they may be
   clean in common paths, but the present coordinator has best-effort seed rollback
   and the batch gains little by guessing. It necessarily includes
   `repository-state-uncertain`, `committed-integrity-mismatch`, commit transport
   failure, reconciliation failure, and inventory-refresh failure.
8. A `committed` coordinator result is not sweep success until
   `commit-coordinator-ipc.ts:168-174` reconciliation succeeds. Reconciliation
   failure is post-commit: halt, report the known commit OID, and never retry the
   package automatically. This preserves the uncertain-outcome behavior at
   `candidate-submit.ts:217-242`.

Return a stable per-intent ledger with exactly one terminal result per input:
`saved`, `already-saved`, `needs-attention`, `blocked-unmerged`, `not-attempted`,
or `halted-uncertain`. Include known attempt/commit OIDs where available. Repeating
the same gesture after a complete authoritative refresh must convert exact prior
saves to `already-saved`, not duplicate commits or stale refusals.

## Close the commit TOCTOU before enabling long sweeps

The interval between final representation revalidation at
`commit-coordinator.ts:533` and `git commit --only` at line 588 is not made safe by
another pre-commit read. `git commit --only` rereads the worktree, while ordinary
agents do not honor either Lares lock. A write in that interval can land before
the post-commit mismatch is detected. A batch feature must not multiply that
existing violation.

Change `src/main/git-checkpoints/commit-coordinator.ts` so the commit is constructed
from reviewed object IDs, never from a post-review worktree read:

1. Under the existing compose and object-database locks, create a temporary index
   from the iteration's freshly pinned `HEAD` tree.
2. Apply the reviewed `commitEffects` to that temporary index with raw-byte
   `update-index --index-info`: set exact reviewed blob/mode entries and remove
   reviewed deletions. No effect may be synthesized from current worktree bytes.
3. `write-tree`, verify the resulting selected tree entries against the reviewed
   effects, create the commit from that tree and pinned parent, then advance `HEAD`
   with an old-OID compare-and-swap (`update-ref <new> <pinned>`). A CAS failure is
   a clean no-commit stale result.
4. Reconcile the real index only for selected effect paths to the exact committed
   entries, preserving unrelated staged entries; verify unrelated entries against
   the pre-operation index snapshot. A concurrent worktree write then remains a
   visible dirty change against the reviewed commit instead of being absorbed into
   it.
5. Keep reflog/attempt identification and post-commit tree verification as
   evidence and defense, not as the mechanism that discovers unreviewed bytes
   after they have landed.

The safest implementation uses `commit-tree` plus CAS `update-ref`; a temporary
index passed to ordinary `git commit` still permits hooks to rewrite that index.
This changes hook semantics: `pre-commit`, `commit-msg`, signing, and other
user-commit behavior currently obtained through `git commit` need an explicit
product decision and tests. Do not retain hook execution if a hook can introduce
bytes outside the reviewed tree. If preserving selected hooks is mandatory, run
only non-mutating validation before `commit-tree` with a documented contract; a
hook failure is pre-mutation. This unresolved compatibility cost is preferable to
claiming an invariant the current command cannot enforce.

## Required edits and tests

- `src/shared/commit-candidates.ts`: add the versioned reviewed manifest,
  normalized commit-effect, topology contributor/ownership, closure obligation,
  challenge atom, and discharge result types. Extend candidate/token snapshots to
  bind the manifest digest and commit effects.
- `src/main/commit-candidates/component-assembler.ts`: include `ownerAgentId` in
  canonical topology; expose structured selected topology and ownership groups;
  derive overlap challenge atoms from the same structure used to calculate
  `requiresOverlapAck`.
- `src/main/commit-candidates/candidate-service.ts`: build reviewed and fresh
  semantic manifests; resolve from finalization intent; implement field-level
  equivalence and monotonic discharge; re-run exact reachable closure/current-HEAD
  proof; include commit effects in candidate identity and token snapshot. Keep
  `pinnedHeadOid` and index fingerprint in each newly minted operational identity,
  but exclude them from review-carry equality.
- `src/main/commit-candidates/index-fingerprint.ts`: retain the repository-wide
  `hasUnmerged` gate and expose the fresh result to the sweep. Do not add a
  path-scoped unmerged exception.
- `src/main/commit-candidates/save-card-ipc.ts`: return the versioned review digest,
  structured challenge atoms, and durable finalization intent; validate carried
  acknowledgement server-side against fresh atoms. Do not accept a renderer claim
  that two manifests are equivalent.
- `src/main/commit-candidates/commit-coordinator-ipc.ts`: expose attempt certainty
  and reconciliation as one sweep-consumable result; never flatten a post-commit
  reconciliation error into a continuable package refusal.
- `src/main/git-checkpoints/commit-coordinator.ts`: bind and consume the complete
  commit-effect manifest and replace worktree-reading `git commit --only` with the
  exact-object tree/commit/CAS flow above.
- `src/main/commit-candidates/save-sweep-service.ts` (new): own durable intent
  ordering, fresh per-iteration resolution, JIT mint/consume/reconcile, result
  classification, acknowledgement coverage, and halting.
- `src/renderer/components/save/CandidatePreview.tsx`: store review-manifest digest
  and structured acknowledged atom IDs/digests in the draft; reset only changed or
  new challenge atoms.
- `src/renderer/components/save/candidate-submit.ts`: replace
  `draftCandidateId !== freshCandidateId` with the server's equivalence/carry
  verdict for single saves; preserve uncertain no-retry semantics.
- `src/renderer/components/save/SaveCard.tsx` and `save-gesture-state.ts`: send
  durable finalization intents and reviewed acknowledgement evidence to the
  main-side sweep, and render deterministic per-intent terminal results. Do not
  loop over stale `selectionForGroup`/`selectionForPins` IDs in the renderer.

Tests must include at least these negative and positive cases:

- HEAD and unrelated stage-0 index entries move, while the full reviewed manifest
  is equal: review and acknowledgement carry; the iteration remints and saves.
- Raw bytes stay equal but clean-filtered blob, mode, expected present/absent state,
  rename source/pathspec, finalization revision/manifest, contributor tuple,
  `ownerAgentId`, component partition, overlap group, or unattributed set changes:
  carry is refused before mint.
- A new selected path and a removed-then-reintroduced path are rejected; a reviewed
  path removed from pending is accepted only with exact current-HEAD plus reachable
  ledger proof.
- One package is completely satisfied by an earlier sweep commit: it returns
  `already-saved` and creates no token/commit. A partially satisfied package commits
  only the reviewed remainder.
- An unchanged up-front union challenge is asked once; a discharged subset is not
  re-asked; a new or changed atom holds only that package. No test may auto-ack an
  atom the preview did not show.
- Finalization closure succeeds at opening and fails on a later iteration: later
  mint is refused. A different exact proving commit may satisfy the same obligation.
- An unmerged index entry outside every selected path halts the whole repository
  sweep before mint.
- Advance fake time beyond five minutes between iterations: no token expires,
  because the next token does not exist until its own iteration.
- Pre-token package mismatch records `needs-attention` and permits the next fresh
  package; every post-consume non-success, transport uncertainty,
  committed-integrity mismatch, reconciliation error, or refresh failure halts and
  causes no automatic retry.
- Inject a worktree write after final revalidation but before commit construction:
  the committed tree contains only reviewed object IDs and the concurrent bytes
  remain dirty. Inject a HEAD move before CAS: no Lares commit advances HEAD.
- Unrelated staged entries remain exact through the exact-object commit and selected
  real-index reconciliation.

Run focused candidate, IPC, coordinator, and renderer tests, their sibling save
suite, and TypeScript/build verification because the shared contract changes both
main and renderer surfaces.

## Open risks not closed here

- Exact-object commit construction changes Git hook and possibly signing behavior.
  The safety requirement determines the commit source, but the product must decide
  which validation/signing behaviors to reintroduce without granting a hook power
  to alter the reviewed tree.
- The current ledger closure check compares exact link fields but does not itself
  prove current-HEAD reachability. The plan requires that stronger proof; its cost
  on large histories should be measured and cached only within one fresh
  iteration, never across commits.
- A crash after `HEAD` CAS but before real-index reconciliation remains a recovery
  case. The durable attempt ledger must let startup distinguish "commit landed,
  index reconciliation incomplete" and halt automatic sweeping until repaired or
  verified.
- There is no authenticated human principal/ownership stamp, so human-relative
  foreignness cannot be implemented honestly in this scope.
- The initial union review is a product interaction requirement: a master checkbox
  cannot itself serve as evidence that byte-level content was reviewed. The
  renderer must preserve or present the actual reviewed union without adding a
  second acknowledgement ceremony.

## Disagreements and resolution

- **Candidate answer: exact bidirectional equality of the reviewed candidate
  manifest.** Rejected as written. It omits commit-effect/pathspec closure and the
  ownership input that actually controls overlap, and it cannot express safe
  already-saved subtraction. Resolved to full reviewed-universe equality with one
  explicit, proof-bearing monotonic-discharge exception.
- **Candidate identity as review identity.** Rejected. `candidateId` deliberately
  binds `pinnedHeadOid` and whole index position, while the existing topology digest
  omits an overlap input. Resolved by separating a versioned review-manifest digest
  from the fresh operational candidate/token identity.
- **Acknowledgement only when the complete challenge is exactly unchanged.** Kept
  as a sufficient rule but not as the necessary rule. Resolved to exact atom
  coverage, which permits only removal of already-covered atoms and never addition
  or mutation. This makes an honestly displayed up-front union sound.
- **Continue after clean failures.** Resolved conservatively: continue only before
  token consumption/attempt creation; halt after every non-success once repository
  mutation machinery has begun.
- **Accept the existing TOCTOU as pre-existing risk.** Rejected. A long automated
  sweep materially increases exposure, and post-commit detection cannot preserve
  the stated invariant. Exact-object commit construction is a prerequisite to
  enabling the sweep.



<!-- groupthink_run: a1bacc4a (mode=parallel) -->
