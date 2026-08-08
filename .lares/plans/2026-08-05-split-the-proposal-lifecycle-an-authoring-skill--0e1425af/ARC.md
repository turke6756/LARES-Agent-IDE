# ARC — Split the proposal lifecycle — an authoring skill for agents, a human-triggered promotion prompt   (plan_sku: 2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af · plan_artifact_id: plan_0e1425af)
<!--ARC-META {"last_refreshed_at":1786034867020,"source_cutoffs":{"folder_mtime_ms":1786034858.657,"ledger_updated_at":null}} -->
## Decisions
- 2026-08-05 — 2026-08-05 - Parts 1a/1c/2 fully specified, no hardening; Part 1b + open questions 1-2 get one groupthink-serial deliberation (int_6781b552); no online research needed
- 2026-08-05 — packaged. Baseline: local annotated tag
  `plan-baseline/2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af` at commit
  e46ae812 (tag object 5e0bc8d4); local only, never pushed. Advisory (non-blocking): 49 uncommitted
  worktree paths at tagging time are not captured by the tag. Recovery: `git show <tag>:<path>`.
- 2026-08-05 — deliberation int_6781b552 decisions adopted: OQ1 = renderer constant
  `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` (no scaffold bump for it; state-dir template deferred);
  OQ2 = keep mounted picker, default = structural workspace supervisor; artifact_id validated at
  panel + dispatch; C1 (int_9e5d0c47) owns saga inventory/deletion — hard dependency boundary.
- 2026-08-05 — **CROSS-PLAN BOUNDARY with plan_e0001372** (supervisor ae889b24), reconciled at
  Edward's direction before either plan dispatches. Accepted in full by both sides; ae889b24 records
  the mirror of this block in that plan's ARC.md. Both plans share baseline commit e46ae812.
  - **Merged dispatch order (load-bearing):** `WP-A ∥ WP-J` → `WP-1` → `WP-2/3/4` (second scaffold
    bump) → `WP-5` → their `B→C→D→E→G/H/I→F` → `WP-6` → their `WP-Z`. Unprefixed ids are mine;
    letters are plan_e0001372's.
  - **(A) Scaffold bumps are strictly serialized, never concurrent.** Their WP-A bumps FIRST and
    gates; my WP-2/3/4 then re-derives pristine hashes from post-WP-A HEAD as a SECOND bump in the
    same chain. Two concurrent bumps are a correctness failure in scaffold-version-migration, not a
    merge conflict. Conditions accepted by ae889b24: WP-A leaves the `capture` mode row
    byte-untouched (my WP-4 owns it), and asserts no "exactly one scaffold revision" claim.
  - **(B) Promote-panel seam.** Template TEXT and the artifact-id VALIDATOR are mine (WP-1); PATH and
    IDENTITY that fill the template become server-supplied by their WP-F preflight. WP-F preserves
    `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` as text and substitutes only values — my WP-1 assertions
    (`Do NOT run capture`, the artifact_id line, the mode ordering) are an explicit WP-F acceptance
    condition. `isValidProposalArtifactId` survives as the panel-side sanitizer feeding their
    `artifactIdCrossCheck?`; the renderer id is a cross-check, NEVER identity authority.
  - **(C) Cards/gallery file chain**, strict sequence on `ProposalCardGallery.tsx` +
    `proposal-card-metadata.ts`: `WP-J → WP-1 → WP-5 → WP-F`, each gated. WP-F was floating in their
    cut; I added it.
  - **(D) Frontmatter stamp ownership.** Their WP-A owns the promote-time keys (`promoted_to`,
    `promoted_at`, Status refresh) AND the one-time backfill onto the 3 unstamped promoted proposals;
    my WP-2 owns the authoring-time block (`artifact_id`, `author`, `author_agent_id`, `author_role`,
    `authored_at`). Neither touches the other's keys; my WP-2 stamp contract is ADDITIVE — the
    authoring skill never strips or rewrites unknown frontmatter keys.
  - **(M1) `src/shared/constants.ts` collision — the finding that mattered.** My WP-1 adds
    `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` to the same file WP-A rewrites while re-deriving pristine
    hashes. NOT a scaffold-version collision (renderer-bundle constant, no bump, not in
    `PROPOSAL_TO_PLAN_TREE`) but a textual one. **WP-1 is NOT renderer-only and must not run parallel
    to WP-A** — both plans had it filed as independent. Confirmed against plan.md:415.
  - **(M5) WP-3 scope bound.** `read-planning-surface` documents DISK-DERIVED state only and
    explicitly disclaims gallery grouping, DB projection, and readiness gates — those surfaces are
    plan_e0001372's (WP-J/C/E/H) and in flux through their wave 4. That documentation is deferred to
    plan_e0001372 as a NAMED open item in their ARC.md (not folded into WP-Z), scheduled after WP-Z
    gates. Do not re-absorb it into this plan without talking to ae889b24.
  - Pre-existing C1 boundary above is unchanged and still correct — it was the first of five, not the
    only one.
- 2026-08-05 — **CROSS-PLAN BOUNDARY, ROUND 2** (prompted by Edward: "do these two plans actually work
  together?"). Round 1 was necessary but not sufficient. All claims below verified against code by
  both supervisors independently. Scope NARROWED and four gaps closed:
  - **The scaffold tree is PER-FILE versioned** (`src/main/supervisor/index.ts:1272-1298`) — each entry
    carries its own `version` + `previousHashes`. The two plans' "bumps" are therefore disjoint
    per-file bumps, not two revisions of one artifact. **`SKILL.md` is the only byte-contested file.**
    `orient.md` is mine alone (WP-A does not edit it) but is a *semantic* dependency of WP-A's
    `promote.md`. Boundary A (WP-A first, full gate) is unchanged.
  - **(G1) `previousHashes` is cumulative — additive only.** Round 1's "re-derive pristine hashes from
    post-WP-A HEAD" was dangerous as written: a worker taking it literally replaces the map and drops
    entries 1..n-1. Update path is `previousHashes?.[diskVersion] ?? previousHashes?.[1]`
    (`scaffold-writer.ts:186`); retirement path scans `Object.values(...)` (:132). Consequence is not
    a stranded workspace (it still backs up + upgrades at :200-207) but a spurious `.bak.<ts>` in every
    existing workspace, real user edits made indistinguishable from pristine copies, and backups
    `pruneScaffoldBackups` can never reclaim. Fails only on a real workspace after restart; no test
    catches it. Recorded in WP-2's Dep block, applied to WP-3/WP-4.
  - **(G2) `capture.md` is RETIRED, not row-deleted.** WP-4 sets `removed: true` / `content: ''` /
    `version: 4` and KEEPS `previousHashes` (extend `{1,2}` with the v3 body hash). Deleting the tree
    row leaves the deployed activity file orphaned on disk in every existing workspace forever while
    SKILL.md no longer references it. `ScaffoldFile.removed`'s doc comment
    (`scaffold-writer.ts:30-38`) mandates this; `index.ts:3301` is a landed precedent.
  - **(G3) WP-A's A2 continuity rule is protected by brief, not by ordering.** WP-4 carries A2 through
    the trigger/mode-table rewrite verbatim and asserts it in a test; ae889b24 writes A2 as a
    self-contained block that survives a restructure.
  - **(G4) The orient split — responsibility determination STAYS in `proposal-to-plan`.** Agreed with
    ae889b24's framing: it is a precondition of a WRITE (may this supervisor mutate?), not a surface
    report, and a skill contractually forbidden from writing cannot gate a mutation. Only cross-surface
    state REPORTING moves to `read-planning-surface`. WP-4 gives the step a stable anchor heading;
    WP-A's matching-EEXIST loser rule in `promote.md` cites that anchor instead of saying "run orient";
    WP-3 CITES the anchor as normative rather than restating the derivation rules (two copies in two
    separately-versioned skill bodies would drift — the split's real long-term failure mode). Anchor
    name to be agreed with ae889b24 before WP-4 lands.
  - **(G5, theirs)** WP-Z was authored against the monolithic skill and is being re-authored against
    the post-split three-skill shape. No action on this plan.
  - **(G4 anchor — SETTLED)** `references/contracts/responsibility.md`, one normative section
    `## Determination`. Proposed by ae889b24, accepted unchanged. A contract file (not a heading in
    `orient.md`) because `references/contracts/` is already the established home for rules cited from
    multiple playbooks (`index.ts:1289-1293`), it versions independently of `SKILL.md`, and `orient.md`
    is mid-hollowing as its reporting half moves to `read-planning-surface`. **This removes the last
    semantic dependency between the plans:** `orient.md` becomes wholly mine, and the contested
    surface is `SKILL.md` alone — one file across seventeen work packages.
  - **(G6 — NEW, raised by this plan after accepting the anchor) The creator must be the earlier WP.**
    A new contract file needs a new `PROPOSAL_TO_PLAN_TREE` entry. WP-A lands first and cites the file
    from `promote.md`; WP-4 lands a full gate later. If WP-4 creates it, WP-A ships a **deployed,
    agent-facing dangling citation** into every real workspace for the whole interval between gates —
    a live broken pointer in a playbook, not a test failure. **Resolution: WP-A creates
    `references/contracts/responsibility.md` at v1** with the §Determination body (a lift of the rules
    `orient.md` already carries — no new design, no decision transferred), so citation and referent
    land in the same gate. WP-4 then removes the duplicated rules from `orient.md` and cites the
    contract. Ownership of the *content* stays with this plan's WP-4 from v2 onward.
  - **Reconciliation status: COMPLETE on both sides** (round 1 boundaries A–D, round 2 gaps G1–G6),
    G6 acknowledged by ae889b24 at dispatch. **All six gaps closed in execution** — see
    §"Execution record" below for the landed evidence.
## Work packages
- WP-1 Promote-gesture prompt wire (renderer + shared constant) — **landed, gated** — `2a227a90`
- WP-2 write-proposal workspace-shared skill (absorbs capture) — **landed, gated** — `58d6db09`
- WP-3 read-planning-surface skill (orient split, read side) — **landed, gated** — `257dda5b`
- WP-4 proposal-to-plan trigger rewrite (promotion-entry only) — **landed, gated** — `1dd68975`
- WP-5 Authorship on proposal cards (two registers) — **landed, gated** — `5ef92cac`
- WP-6 Backfill pre-rule proposals (optional) — **landed, gated** — `4be5ad77`

## Execution record (2026-08-06, Edward's implementation trigger)

Dispatch order executed, merged across both plans, each arrow a full gate:
`[e0001372 WP-A ∥ WP-J] → WP-1 → WP-2 → WP-4 → WP-3 → WP-5 → [e0001372 B…F] → WP-6 → [WP-Z]`.
Every package ran as a fresh-session codex worker, one at a time — never parallel, because
WP-2/3/4 all write the same scaffold surface. Baseline `e46ae812`; stack linear and unpushed.

**Final scaffold version state** (verified by BOTH supervisors independently against the tree):

| file | version | previousHashes | note |
|---|---|---|---|
| `SKILL.md` | 4 | `{1,2,3}` | A2 continuity block preserved verbatim (G3) |
| `references/activities/capture.md` | 4 | `{1,2,3}` | `removed: true` + `content: ''` — retired in place (G2) |
| `references/activities/orient.md` | 3 | `{1,2}` | derivation rules removed, now cites the contract (G4) |
| `references/contracts/responsibility.md` | 2 | `{1}` | created v1 by WP-A (G6); content owned here from v2 |
| `references/activities/promote.md` | 4 | `{1,2,3}` | EEXIST preamble ceded by ae889b24, rewritten by WP-3 |
| `scripts/plan-manifest.mjs` | 4 | `{1,2,3}` | untouched by this plan |

**WP-6 (`4be5ad77`, gated 2026-08-06)** — backfill of authoring-time author keys on pre-rule
proposals. 6 of 9 candidates attributed from DB `file_activities` create rows plus the plan
manifest responsibility events; **3 deliberately left unattributed** for want of evidence
(`sleep-prevention-power-save-blocker`, `remember-skill-evidence`, `user-owned-agent-behavior-overlays`)
— the spec's no-speculative-attribution rule, honoured. Boundary D held: `git show 4be5ad77 | grep
'^+.*promoted_'` returns nothing; the two files that already carried promotion keys show them as
unchanged context. `read_agent_files_touched(create)` on the worker is empty, which is how we know
`2026-08-05-save-card-streamlining.md` appearing as a *new file* in the commit is a previously
**untracked** proposal being tracked for the first time, not worker-authored content — that file
was one `git clean` from destruction and no longer is. Author values use the
`"Title" (role, workspace)` shape that `declaredAuthorTitle()`
(`proposal-card-metadata.ts:91-97`) parses explicitly; the frontmatter reader there is line-based,
not YAML, so the unbalanced-looking quoting is correct for this consumer and only this consumer.

**Acceptance is DEFERRED, not met:** the spec's visual check (bylines rendering, including inside
the collapsed promoted group) cannot run yet — WP-5's authorship registers are compiled renderer
code that is not deployed until the WP-Z restart. The data is verified; the render is not.

**Pre-existing gap, out of scope, worth someone's attention:**
`2026-08-05-save-card-streamlining.md` has no `artifact_id`. Harmless today, but WP-F's
server-authoritative preflight now requires one, so this proposal cannot be promoted until it gets
one. Not a WP-6 regression — the file never had it.

**G1 held across six packages and two supervisors in one file** — entry `1` intact in every map.
This was the identified highest-risk failure mode: it is invisible to the test suites and surfaces
only on a real workspace restart (spurious `.bak`, "differed from known managed content" warnings,
backups `pruneScaffoldBackups` can never reclaim).

**G2 verified at the mechanism, not just the row shape.** ae889b24 confirmed `removed: true` is
honored — `scaffold-writer.ts:122` branches on it and backs up a divergent copy before removal,
`:445` excludes retired files from the known-hash set. Had the flag been inert, `content: ''` would
have silently overwritten every deployed `capture.md` with an empty file instead of retiring it.

**WP-5 finding worth keeping:** the proposals watcher was never the gap — it already stored the
server-witnessed uuid AND the exact agent title. The information loss was in the **DB-backed gallery
projection**, so the fix landed in `src/main/plans/plan-gallery.ts` + `src/shared/types.ts`, which
now project proposal `artifactId` and the witnessed agent uuid/title to the renderer. A brief that
had asserted "fix the watcher" would have sent the worker to the wrong file. Separately: an
agent-role DB constraint rejects `researcher`; WP-5 hit it, and correctly reverted the widening
rather than loosening a schema constraint to make its own test pass.

**Known live divergence (accepted, not resolved here):** `derivePlanSku()` in
`src/main/plans/promote-proposal.ts` still derives plan identity from the proposal FILENAME, with
~10 call sites, pending deletion by plan_e0001372's WP-F. Every worker brief in this plan
contractually barred reading it and pointed at `src/shared/plan-identity.ts` instead, so the two
derivations never crossed into this plan's lane. Re-check after WP-F lands.

**Unstamped-but-live artifact:** `.lares/proposals/2026-08-05-proposal-lifecycle-split-authoring-vs-promotion.md`
(this plan's source proposal) remains **untracked** while carrying `promoted_to` / `promoted_at`
keys written by e0001372's WP-J. Those keys exist ONLY in the working tree — any clean of untracked
files destroys them and silently regresses that plan's B1 acceptance. Every worker brief carried a
do-not-touch rule for it. It still needs committing by whoever lands that file.

Full bundle-contract specs (Files · Dep · Do · Accept · Non-goals · Verify) live in plan.md
§"Work packages (packaged 2026-08-05)".
## Deliberations
- int_6781b552 (promotion-prompt-design, groupthink-serial, lead=claude reviewer=codex) — **folded-in**.
  Output: [deliberations/2026-08-05-promotion-prompt-design.md](deliberations/2026-08-05-promotion-prompt-design.md);
  run 2a15b2d4 (self-declared cross-check; `ran` unavailable pre-ledger). Integrated 2026-08-05 by the
  responsible supervisor: OQ1 → template constant `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` in
  `src/shared/constants.ts` (state-dir template deferred); OQ2 → keep the mounted picker, default to
  the structural workspace supervisor (`getSupervisor`, race-guarded); `artifact_id` required +
  validated at panel and dispatch boundaries; prop_e0001372 C1 (int_9e5d0c47) dependency boundary
  recorded; WP1–WP7 pre-cut with tests. PLAN-INTEGRATION record adjacent to the link in plan.md.
## Who did what
- 2026-08-05 — capture: proposal authored by "Two Proposal Review Planning surface and Git REview"
  supervisor (9b6a3d39), at Edward's direction, incl. Edward's two amendments.
- 2026-08-05 — scope + promote + deliberate-dispatch + integrate: "Planning supervisor - planning
  surface split" (ac1cb0b6), on Edward's promote gesture. GroupThink run 2a15b2d4 (serial,
  claude lead / codex reviewer) produced the deliberation output.
