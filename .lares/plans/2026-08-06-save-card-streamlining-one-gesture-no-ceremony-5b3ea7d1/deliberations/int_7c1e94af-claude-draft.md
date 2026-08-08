---
plan_artifact_id: plan_5b3ea7d1
intent_id: int_7c1e94af
orchestration_id: a0173b0f-e0ec-4480-bc1e-cad93b19d222
kind: deliberation
---

# Carry-forward equivalence & sweep semantics — claude draft (int_7c1e94af)

## The decision in one paragraph

Lares may carry a human's prior review and acknowledgement across a fresh
preview after HEAD/index movement **iff** a complete fresh reconstruction of the
package — re-resolved from durable intent, not from stored renderer ids — yields
a **byte-for-byte-equal reviewed semantic manifest** (the candidate identity
document with exactly two fields removed: `pinnedHeadOid` and `indexFingerprint`)
**and** the fresh candidate is independently eligible **and** the final in-lock
byte revalidation still proves each member's committed bytes equal to the
reviewed ones. Manifest equality is *necessary but not sufficient*: it proves the
reviewed content is unchanged, not that the content is still committable or still
on disk — those are separate, mandatory conjuncts. Any divergence in the manifest
surfaces the package to attention; it is never auto-recovered. Only whole-repo
`pinnedHeadOid` and unrelated staged-index position may differ.

This ratifies the candidate in `plan.md` in shape, but sharpens it in three ways
the candidate under-specifies: (a) the digest must be conjoined with *fresh
eligibility* and the *existing in-lock revalidation* — it cannot stand alone;
(b) re-resolution must be driven by durable keys (member path bytes +
finalization ids), because `componentId` is ephemeral; (c) dropping
`indexFingerprint`/`pinnedHeadOid` is *conditionally* safe, and the conditions
are load-bearing, not free.

---

## 1. The predicate, stated precisely enough to implement and test

### 1.1 The reviewed semantic manifest (RSM)

Today `candidateId = sha256(JCS(identityDoc))` where `identityDoc`
(`candidate-service.ts:980-1006`) is:

```
{ contractVersion, repositoryKey, gitObjectFormat,
  pinnedHeadOid, indexFingerprint,
  finalizations: [{finalizationId, packageId, packageRevision}]  (sorted),
  members: [{ pathBytesBase64, rawWorktreeBlobOid, expectedCommitBlobOid,
              expectedCommitMode, expectedWorktreeState,
              coveringFinalizationIds }]  (sorted by path),
  componentTopologyDigest }
```

Define the **reviewed semantic manifest digest**:

```
RSMD(candidate) = sha256(JCS( identityDoc  \  { pinnedHeadOid, indexFingerprint } ))
```

Everything the human actually reviewed is inside RSMD:

- **Selected path/member set** — `members[].pathBytesBase64`.
- **Expected present/absent state** — `members[].expectedWorktreeState`.
- **Raw reviewed bytes** — `members[].rawWorktreeBlobOid`.
- **Filtered representation actually committed** — `members[].expectedCommitBlobOid`
  + `expectedCommitMode` (the clean-filtered blob `commit --only` will write,
  distinct from the raw worktree blob — `commit-representation.ts:32-37`). This
  is the field that answers "a changed *filtered* representation": a `.gitattributes`
  / clean-filter change flips `expectedCommitBlobOid` while `rawWorktreeBlobOid`
  holds, and RSMD diverges.
- **Attribution / overlap topology** — `componentTopologyDigest`
  (`candidate-service.ts:853-874`), which composes each selected component's own
  `componentTopologyDigest` (the full per-entry contributor graph,
  `component-assembler.ts:84-93`) with the selected unattributed paths. A new
  entry joining a resolved component changes `dirtyEntryIds` → changes both
  `componentId` (`component-assembler.ts:273`) and the component's topology digest
  → RSMD diverges. This is how "unchanged bytes acquire new foreign provenance"
  (risk #1) is caught.
- **Acknowledgement challenge** — is a *pure function of the manifest*:
  `requiresOverlapAck = mergedGroupCount >= 2` is derived from topology, and the
  acknowledged unattributed set must equal `selectedUnattributedEntryIds` (both
  folded into `componentTopologyDigest`). So RSMD equality ⇒ ack challenge equal.
  No separate ack field is needed in the digest.
- **Finalization identity + revision** — `finalizations[].{finalizationId,
  packageId, packageRevision}`. A package revision bump diverges RSMD.

### 1.2 The carry predicate CP

Carry review + acknowledgement from a reviewed candidate `R` to a fresh iteration
`F` **iff every one of these holds**:

1. **Complete fresh reconstruction.** `F` is produced by a full fresh pass —
   fresh dirty inventory → `assembleConflictComponents` → `buildCandidate` — run
   *this iteration*, against current server state. No field of `F` is reused from
   `R`.
2. **Intent-driven re-resolution (risk #10).** The selection request that
   produces `F` is rebuilt from **durable intent**: the reviewed member **path
   byte set** and the **finalizationIds** (+ reviewed unattributed path set).
   `entryId = sha256(repositoryKey + pathBytesBase64)` (`dirty-inventory.ts:251`)
   is *stable* across re-inventory, so member/unattributed entry ids are
   recomputed deterministically from paths. `componentId` is **not** stable and
   must **never** be carried; the fresh component is found as the one now
   containing the reviewed member entryIds.
3. **Fresh eligibility (risks #2, #5).** `F.eligibility.eligible === true`,
   re-evaluated by `evaluateEligibility` with *fresh* `hasUnmerged`,
   `closureUnproven`, and per-member verifications. RSMD does **not** contain
   eligibility, so this is a mandatory independent conjunct. Because
   `buildCandidate` reruns the prior-exact-commit closure loop
   (`candidate-service.ts:963-969`) every call, finalization closure is
   re-proven per iteration for free — the sweep never reuses its opening verdict.
4. **Manifest equality.** `RSMD(F) === RSMD(R)`.
5. **Nothing else differs.** The only permitted differences between the full
   `identityDoc` of `R` and `F` are `pinnedHeadOid` and `indexFingerprint`.

If CP holds → mint + consume **silently**. If CP fails at (4) → the reviewed
*content* changed → **surface to attention**, never auto-recover. If CP fails at
(3) for a repo-wide reason (`hasUnmerged`) → **repo-level halt** (§3). If the
fresh reconstruction shows the package is already fully committed → **already-saved
skip** (§3).

### 1.3 The predicate is necessary but NOT sufficient — the sharpening

RSMD equality proves *the reviewed content is identical*. It does **not** prove:

- **…that the bytes are still on disk at commit time.** Between the fresh preview
  and the actual `git commit --only`, a member file can move (a foreign agent
  writing the tree — risk #3). This is caught only by the **existing in-lock
  final revalidation** (`commit-coordinator.ts:533-549`), which re-reads each
  member's representation inside the object-db lock and aborts (`kind:'stale'`) on
  any drift. CP therefore does **not** replace that revalidation; it runs *before*
  it. The safety chain is: RSMD equality (content unchanged since review) → fresh
  eligibility (still committable) → in-lock revalidation (bytes still present and
  equal at the instant of commit). Remove any link and the invariant "no
  unreviewed byte is committed" breaks.

- **…that eligibility holds.** Eligibility is deliberately outside `identityDoc`.
  Two candidates with identical RSMD can differ in eligibility (e.g. a repo-wide
  unmerged entry appeared). Hence conjunct (3).

This is my central attack result on the `plan.md` candidate: **bidirectional
equality of the reviewed semantic manifest is the right identity test, but stated
alone it is unsound — it must be conjoined with fresh eligibility and the
unchanged in-lock revalidation.** The candidate's parenthetical "and fresh
eligibility/closure proof … only after all of the above is freshly reconstructed"
gestures at this; I am making it a hard, testable three-part conjunction.

### 1.4 Why dropping the two fields is safe — and only conditionally

- **`indexFingerprint`** (whole-repo `git ls-files --stage` digest,
  `index-fingerprint.ts:120-129`). Safe to drop from the *identity* test because
  `commit --only <pathspec>` commits the **worktree** version of each member, not
  its staged version, and touches no non-member path; seeded untracked members are
  re-read from the (revalidated-equal) worktree (`commit-coordinator.ts:564-583`).
  So unrelated staged position cannot change a member's committed bytes. The one
  thing the index *can* do that matters — introduce a repository-wide unmerged
  stage — is caught by conjunct (3) (`hasUnmerged` → `unsupported-git-state`,
  `candidate-service.ts:975,1039`). **Conditional, not free:** dropping it is safe
  *only because* fresh eligibility is a separate conjunct. If someone later folds
  eligibility into the digest and drops this reasoning, the safety lapses.

- **`pinnedHeadOid`.** Safe to drop because every member representation is
  recomputed against the fresh HEAD in the reconstruction; any HEAD movement that
  changes what a member would commit (including "HEAD now already contains the
  target bytes") changes `expectedCommitBlobOid`/`expectedWorktreeState` →
  diverges RSMD → attention or already-saved. The boundary case (HEAD moved but
  every member representation identical) is exactly the harmless case we want to
  wave through.

### 1.5 Test obligations (acceptance)

- Saving 9 finalized packages sequentially, no bytes changed between them →
  **0 refusals, 9 saved** (each iteration: RSMD equal across the prior commit's
  HEAD movement; only `pinnedHeadOid`/`indexFingerprint` differ).
- A clean-filter change to one member between review and sweep (raw blob equal,
  filtered blob differs) → that package **falls to attention**, others save.
- A new sibling file joining a reviewed component mid-sweep → topology digest
  diverges → that package **falls to attention**, not silently committed.
- A member file rewritten on disk after the fresh preview but before commit →
  in-lock revalidation aborts `stale` → clean pre-commit refusal → attention.
- A package whose members are already fully committed by an earlier iteration →
  **already-saved skip**, no empty commit, no `candidate-ack-stale`.
- A package-revision bump on a covering finalization mid-sweep → RSMD diverges →
  attention.

---

## 2. The acknowledgement-carry rule

**Rule: never re-ask while the complete acknowledgement challenge is unchanged;
never auto-ack anything new.**

Mechanically the per-package acknowledgement challenge is
`(componentTopologyDigest, sorted selectedUnattributedEntryIds)` — exactly the
pair the mint gate validates (`candidate-service.ts:268-276`). A single up-front
"commit-all" gesture collects the human's acknowledgement **once over the union**
of all packages' challenges, and the system stores each package's challenge
snapshot. Per iteration:

- Recompute the package's fresh challenge from the fresh reconstruction.
- If the fresh challenge **equals** the stored (reviewed) one, pass that fresh
  digest + unattributed set into `mint` — its own equality check
  (`:268-276`) then passes with **no re-ask**.
- If **anything new appears** (a new unattributed id, a changed topology digest,
  a newly-overlapping group), the fresh challenge ⊄ the reviewed union → that
  package **falls out to attention**. Do **not** re-ask mid-sweep; do **not**
  auto-ack.

Why a union ack is sound (risk #8, #9): the human's one gesture asserts "I
acknowledge each of these N specific challenges." Soundness per iteration is the
equality `fresh == stored` for *that* package — the mint gate already enforces the
strong form (digest identity), so there is no way to smuggle new overlap through:
a union digest is never passed to mint; each mint sees its own package's fresh
digest, which must equal what the human saw. The union is a UX affordance
(ask once), not a weakening of the per-package proof.

**On "foreign-agent bytes" (risk #12, requirement 6) — scoped down, honestly.**
Overlap today is `mergedGroupCount >= 2` over `(ownerAgentId ?? agentId, planId,
planItemId)` groupings (`component-assembler.ts:188-211`); there is **no**
comparison against the initiating human's identity. So "ask only when *foreign*
bytes are involved" is **not implementable as stated**. Two honest options:

- **Recommended (this deliberation): do not redefine the trigger.** Keep the
  existing multi-group / unattributed trigger and satisfy requirement 6's spirit
  ("at most once per save gesture") purely by **union-acking once**, not per card.
  Narrowing the trigger below "multi-group" risks *not asking* about genuine
  other-agent overlap → that would weaken the "no unreviewed foreign bytes"
  invariant, which is a non-goal.
- **Follow-on (named, not done here): true foreign-to-initiator.** The witness
  rows already carry `ownerAgentId` (`component-assembler.ts:190`), so the
  *identity source exists*, but the **initiating human's owner identity is not
  threaded into the preview/mint context**. To implement "foreign," thread the
  initiator's owner id into `CandidateBuildContext`/`MintCandidateTokenRequest`
  and redefine the ack trigger as "contains ≥1 ownership group whose owner ≠
  initiator." Because that change touches the safety trigger, it needs its own
  deliberation; it must not ride in on this one.

---

## 3. Sweep semantics that depend on the predicate

### 3.1 Per-iteration lifecycle (mint just-in-time — risk #4)

Each package, in order, entirely main-side:

```
fresh reconstruct (intent-driven)  →  CP check  →  mint (TTL 5 min)  →  consume
```

Mint and consume happen back-to-back within one iteration (seconds), far under the
5-minute token TTL (`candidate-service.ts:73,363`). **Never pre-mint a batch** —
pre-minted identities carry `pinnedHeadOid`/`indexFingerprint` that the first
commit invalidates anyway. If an iteration stalls past TTL before consume, the
token expires and the coordinator returns `token-unresolved`
(`commit-coordinator-ipc.ts:127-131`) — a **clean pre-commit refusal**: re-run
that one iteration (re-preview + re-mint) at most once, then fall to attention.

### 3.2 Halting rules

Precedence, most-conservative first:

1. **Repository-wide unmerged (risk #5).** If any fresh reconstruction reports
   `hasUnmerged`, **halt the whole sweep** with one plain message ("A file in
   this repository has an unresolved merge conflict — resolve it, then save").
   `hasUnmerged` is repo-wide (`candidate-service.ts:971,1039`); "save the others
   anyway" is a deliberate invariant change and is out of scope.
2. **Uncertain outcome (risk #6).** If submit returns `kind:'uncertain'` — commit
   transport threw (`candidate-submit.ts:217-224`) or the post-commit inventory
   refresh threw (`:232-243`) — a commit **may** have landed. **Halt immediately
   and re-inventory.** Never continue past an uncertain outcome.
3. **Post-commit reconciliation failure (risk #7).** If the coordinator returns
   `reconciliation-error` or `save-not-verified` (`commit-coordinator-ipc.ts:174-186`;
   `candidate-submit.ts:228-230`), the commit **already exists** but ledger /
   finalization closure did not complete. **Halt** — continuing would let later
   closure decisions run on incomplete evidence. Surface prominently, not under a
   quiet "M need attention".
4. **Committed-integrity-mismatch.** If the coordinator returns
   `committed-integrity-mismatch` (`commit-coordinator.ts:483-495`) — a hook or a
   foreign write altered selected content and the commit still landed — **halt**
   and surface as genuinely wrong (unreviewed bytes landed, though flagged).
5. **Clean pre-mutation refusal.** Any eligibility/CP failure *before* a commit is
   attempted (byte-mismatch, package-not-finalized, closure-unproven, topology
   changed, token-expired) → that package → **attention**; **continue** to the
   next. No repo mutation occurred, so the sweep is safe to proceed.

### 3.3 Deterministic per-package results (risk #11)

Every package resolves to exactly one of:
`saved` | `already-saved` | `needs-attention(reason)` — plus a sweep-level
`halted(reason)` when 3.2 (1–4) fires. **Already-saved** is detected in the fresh
reconstruction: if every frozen manifest member of the package's covering
finalizations is already ledger-proven (`ledgerProves`, `candidate-service.ts:967`)
/ locally committed, the package is closed → deterministic skip, **not** a stale
refusal and **not** an empty commit. Final summary: "N saved, K already saved,
M need attention" (+ halt reason).

### 3.4 The TOCTOU window (risk #3) — open, honestly

The gap between final revalidation (`commit-coordinator.ts:533`) and the commit
(`:588`) lets a foreign terminal agent overwrite a selected file; the bytes land
and post-commit tree verification flags it as `committed-integrity-mismatch`
(`:483`) — caught, but *after* the unreviewed bytes are in the commit. A long
sweep does **not** widen any single window (revalidation→commit stays tight per
iteration); it runs *more* windows, so aggregate exposure scales with iteration
count. This **cannot be closed** without a cross-agent worktree lock, and the
architecture deliberately has none — many agents share one working tree
(compose lock serializes only Lares commits; object-db lock only commit-vs-restore,
`git-checkpoints/commit-coordinator.ts:8`). **Residual risk, stated plainly:**
per-commit, inherent, detected-not-prevented. The only mitigation the sweep owes
is halting on `committed-integrity-mismatch` (3.2 rule 4) so a flagged bad commit
never gets papered over by continuing.

---

## 4. What I could not close (open risks)

1. **TOCTOU (§3.4).** Not closable without a cross-agent worktree lock the design
   forbids. Mitigation = detect + halt, not prevent.
2. **Foreign-to-initiator overlap (§2).** Needs the initiating human's owner
   identity threaded through preview/mint; deferred as a named follow-on. This
   deliberation keeps the existing (safe, possibly over-eager) multi-group
   trigger and reduces ceremony only via union-ack.
3. **Aggregate exposure of a long sweep.** Even with correct per-iteration
   proofs, running 50 commits is 50 chances for a foreign interleave. No new
   defect, but worth a one-line note to the user that a sweep is not atomic.
4. **`indexFingerprint` drop rests on `commit --only` worktree semantics.** If a
   future change ever commits from the index for a member path, dropping
   `indexFingerprint` from the identity test would become unsound. Guard this with
   a test that a staged-but-not-worktree mutation of a member never affects the
   committed bytes.

---

## 5. What I disagreed with (and how it resolved, pending the co-planner round)

- **Against ratifying the `plan.md` candidate as-is.** Bidirectional manifest
  equality is correct as the *identity* test but unsound stated alone. Resolved by
  making it a three-part conjunction: RSMD equality **+** fresh eligibility **+**
  unchanged in-lock revalidation (§1.3). The digest proves "same content," the
  other two prove "still committable" and "still on disk."
- **Against a raw-worktree-blob-only carry test** (the original brief's
  "auto-rebase if every member's worktree blob OID is unchanged"). Too weak:
  ignores `expectedCommitBlobOid`/mode (filtered representation), topology, and
  finalization revision (risk #1). Resolved by using the full RSM, not
  `rawWorktreeBlobOid` alone.
- **Against narrowing the acknowledgement trigger to hit requirement 6 literally.**
  Redefining "foreign" narrower than the current multi-group trigger risks
  skipping genuine overlap and weakening the invariant. Resolved by achieving
  "ask once" through union-acking, leaving the trigger's *sensitivity* untouched.
- **Against filing post-commit reconciliation failure under "M need attention" and
  continuing** (a tempting reading of "batch continues on non-fatal errors").
  Resolved as a hard halt (§3.2 rule 3): a committed-but-unreconciled state must
  not let subsequent closure decisions proceed on partial evidence.
