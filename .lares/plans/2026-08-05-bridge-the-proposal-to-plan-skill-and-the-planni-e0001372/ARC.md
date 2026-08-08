# ARC — Bridge the proposal-to-plan skill and the planning surface (dual-register docs, disk→DB reconciler, run-to-implementation)   (plan_sku: 2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372 · plan_artifact_id: plan_e0001372)
<!--ARC-META {"last_refreshed_at":1785982810505,"source_cutoffs":{"folder_mtime_ms":1785982804391.0098,"ledger_updated_at":null}} -->
## Decisions
- 2026-08-06 — **LIVE DIVERGENCE CLOSED at WP-F `1277290f`, as the 2026-08-06 entry below promised.** Exactly one identity derivation now exists in the tree: `src/shared/plan-identity.ts`. `derivePlanSku()` and `promote-proposal.ts` are deleted, every consumer re-homed, and a guard test in `promotion-preflight.test.ts` fails if a filename-derived identity path reappears. The cross-plan bar on reading `derivePlanSku` is now enforced by the tree rather than by agreement — but KEEP the bar in briefs: the two prohibition strings in `constants.ts` are deployed skill text and a future worker "tidying" them would remove the guardrail, not the bug.
- 2026-08-05 — **Baseline tag** `plan-baseline/2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372` created at workspace HEAD `e46ae812` (local annotated tag, never pushed). Recovery framing: any code a work package deletes is one `git show <tag>:<path>` away — deletion WPs need no copy-aside archiving. **Advisory (non-blocking):** 49 uncommitted paths existed in the worktree at tag time, so the tag captures committed HEAD only, not that in-flight work.
- 2026-08-05 — packaged: 11 work packages cut (WP-A, WP-J, WP-B, WP-C, WP-D, WP-E, WP-F, WP-G, WP-H, WP-I, WP-Z), re-cut from the deliberations' 15 to eliminate three shared-machinery collisions. Plan is **dispatch-ready**; implementation awaits an explicit human trigger.
- 2026-08-05 — **Cross-plan boundary agreed with plan_0e1425af** (proposal-lifecycle split; responsible supervisor ac1cb0b6), at Edward's direction, before either plan dispatched. Both plans were packaged and dispatch-ready off the same baseline `e46ae812` and collided on four surfaces. Negotiated by direct supervisor-to-supervisor exchange; both sides accepted in full. **Round 2 (same day) found the round-1 boundary NECESSARY BUT NOT SUFFICIENT** — Edward challenged whether two plans decomposing and hardening the same skill could really proceed, and re-examination against the code turned up two mechanical failures the briefs would have produced (`previousHashes` map truncation, `capture.md` orphaning), one unprotected rule (A2 in SKILL.md), and one unresolved design seam (orient's split vs. the promote-flow responsibility check). See `## Cross-plan boundary` below for the merged dispatch order, the four boundaries, and the round-2 gaps. **Round 2 CLOSED 2026-08-05 — all five gaps agreed and recorded on both sides. Both plans are reconciled and dispatch-ready; nothing launches until Edward's implementation trigger.**
- 2026-08-06 — **IMPLEMENTATION TRIGGERED by Edward. Wave 1 dispatched and GATED: WP-A (`1248e733`) and WP-J (`9e7284f7`), both codex, both on local `master`, unpushed, baseline still `e46ae812`.** Gating was done by the supervisor against the tree, not against worker summaries. Verified mechanically: G1 `previousHashes` cumulative (`plan-manifest.mjs` v4=`{1,2,3}`, `promote.md` v3=`{1,2}`, `SKILL.md` v3=`{1,2}`); G2 `capture.md` row + constant byte-untouched; G6 `responsibility.md` v1 contract, `PROPOSAL_TO_PLAN_TREE` entry, and the `§Determination` citation all in the SAME commit (no dangling pointer shipped); no "exactly one scaffold revision" assertion in `src/`; WP-J commit touches none of WP-A's files. Baton passed to ac1cb0b6 for their WP-1 (dispatched, codex `72d7df61`) per the merged order — **WP-B is deliberately HELD until their WP-2/3/4 chain clears `src/shared/constants.ts`.**
- 2026-08-06 — **LIVE DIVERGENCE, accepted with mitigation, closes at WP-F.** `derivePlanSku()` in `src/main/plans/promote-proposal.ts` still derives plan identity from the proposal FILENAME and remains live with ~10 call sites (incl. `promotion-dispatch.ts`, `promotion-reconciler.ts`). WP-A's brief both said "delete it" and "don't spend effort, WP-F deletes the file"; the worker took the second reading. Effect: the tree carries TWO identity derivations until WP-F, and this plan's premise is precisely that filename and frontmatter can disagree — currently harmless only because they agree on every existing proposal. **Mitigation: every package in BOTH plans is barred from reading `derivePlanSku` and must use `src/shared/plan-identity.ts`; ac1cb0b6 accepted this constraint for their six packages. WP-F's brief must carry removal as a named obligation, not an incidental one.**
- 2026-08-06 — **Deferred to WP-Z, not silently skipped:** real-workspace scaffold migration (deployed v4/v3) is UNVERIFIED. Neither wave-1 worker could restart Lares because they run inside it; both correctly declined to present headless compiled migration tests as the relaunch gate. Requires Edward's restart at WP-Z.
- 2026-08-06 — **Carried risk (data, not code):** WP-J's `promoted_to`/`promoted_at` stamp on `.lares/proposals/2026-08-05-proposal-lifecycle-split-authoring-vs-promotion.md` exists ONLY in the working tree — the file is wholly untracked foreign work owned by plan_0e1425af, so committing it would have annexed another supervisor's unlanded artifact. Any clean of untracked files destroys the stamp and silently regresses B1 acceptance. ac1cb0b6 notified; their WP-2 preserves both keys verbatim when it lands the file.
- 2026-08-06 — **Cross-plan scaffold chain COMPLETE and closed. G1–G6 all held under two supervisors and six packages in one file.** plan_0e1425af landed `2a227a90` (WP-1), `58d6db09` (WP-2), `1dd68975` (WP-4), `257dda5b` (WP-3), `5ef92cac` (WP-5), all gated by ae889b24 against the tree. Final verified `PROPOSAL_TO_PLAN_TREE` state, every map cumulative with entry `1` intact: `SKILL.md` v4 `{1,2,3}` · `capture.md` v4 `{1,2,3}` **retired via `removed:true` with the ROW PRESERVED** (verified mechanism, not just a flag: `scaffold-writer.ts:122` branches on it, `.bak`s a divergent copy before removing, `:445` excludes retired files from the known-hash set) · `orient.md` v3 `{1,2}` · `promote.md` v4 `{1,2,3}` · `responsibility.md` v2 `{1}` (content owned by plan_0e1425af from v2 per G6) · `plan-manifest.mjs` v4 `{1,2,3}`. Our A2 continuity block survived their WP-4 verbatim; our EEXIST loser rule survived their WP-3 rewrite with the `§Determination` citation intact (`constants.ts:6028`). **Constants file free; the B→C→D→E→G/H/I→F floor is ours. Their WP-6 alone remains, after WP-F.**
- 2026-08-06 — **WP-B gated: `c0273a79` (475 insertions, ZERO deletions — pure addition, frozen shape provably untouched); Task 0 `70411aa2` closed the worktree-only stamp risk** by committing `.lares/proposals/2026-08-05-proposal-lifecycle-split-authoring-vs-promotion.md` unaltered, both promote-time keys verified in the committed blob.
- 2026-08-06 — **DOCUMENT ERROR CORRECTED, and the rule it implies.** This plan's work-package document described `plan_work_packages` as **"eleven-column"**; it is **TEN** columns (verified `src/main/database.ts:1652`). WP-B's worker found the mismatch, preserved the real schema, and reported it instead of adding a column to satisfy the prose. The failure mode was live — WP-C, WP-D and WP-H all inherit that phrasing, and reconciling it the other way would have altered a contract three packages depend on. Correction is now inline in the WP-B brief. **Standing rule for every remaining package: where prose and tree disagree, the TREE is authoritative; report the discrepancy, never "fix" code to match a description.**
- 2026-08-06 — **WP-G (`48cc8190`) and WP-H (`8d92bdfb`) gated in parallel; disjoint files, no collision.** Both gated against the tree. Cross-plan bar held in both: no `derivePlanSku`, no `supervisor_active_plan` writer, no `plan_documents` deletion, one strict-json implementation. WP-H's merge premise verified directly — exactly one `refreshAndGetPlanReadiness` serving both gates. **Residue:** one stale renderer test asserting the retired "not yet implemented" Packages text now fails; both workers found it and both correctly declined to edit another package's file. Test-only, production is correct. Assign to WP-Z or a cleanup commit.
- 2026-08-06 — **SCOPE RULING: the `PLAN-WORK-PACKAGES:v1` machine block is NOT the dispatch authority; the prose `**Files**` list in each `## WP-<x>` section is.** WP-I was dispatched from the machine block's two-entry `paths` array (`legacy-promotion-drain.ts`, `index.ts`) when its prose Files list names five surfaces — `promotion-reconciler.ts` (as refactor source), `promotion-dispatch.ts`, `index.ts`, `database.ts`, and the migration/delivery/lifecycle-stop/startup/drop tests. The worker hit the resulting wall, stopped without committing, and reported — the instructed behaviour. **The document says so itself** (supplements header lines 53-57: the block is "provisional", and "cannot express cross-plan dependencies; it is not the ordering authority"); the dispatch error was the supervisor's, not the worker's or the spec's. **Binding for the remaining packages (WP-F, WP-Z): brief the prose Files list, and treat the `paths` array as a hint only.** Note WP-F's `paths` array likewise omits the ~10 `derivePlanSku` call sites its prose obligation requires it to migrate.
- 2026-08-06 — **SHIPPED DEFECT FOUND IN P8F (different plan, this supervisor's lane), fixed inside WP-I on Edward's approval.** Found while adjudicating WP-I's scope conflict. `initDatabase()` unconditionally creates the six "retired" plan-provenance tables (`database.ts:1027, 1042, 1100, 1122, 1138, 1146` + indexes) and then calls the marker-guarded `dropRetiredPlanProvenanceTablesIfReady(db)` at `:1175` in the SAME init pass. Boot 1: create → drop → marker written. Boot 2: `CREATE TABLE IF NOT EXISTS` **recreates them empty** → drop reads the marker → returns `already-dropped` → no-op. **P8F's acceptance claim "DROPped ONCE … and never recreated" is false as written: the tables return one boot later and persist forever.** Severity is low as correctness — P8G removed every reader, so they are empty dead schema, not a data or behaviour bug — but the claim is false in a plan reported complete, and it sits in the pending deploy checklist. **It has never executed (nothing is deployed), so it is fixable before it ever fires.** `promotion_requests` has the identical exposure at `database.ts:2009`, which is exactly why WP-I could not satisfy "never recreated" from `index.ts` alone. Sequenced as WP-I commit 1 (fix P8F, establish the correct idiom) then commit 2 (WP-I proper follows that idiom). **Corrected mechanism, for the record:** `applied_migrations` boot ordering is a NON-issue — `ensureAppliedMigrationsTable()` self-ensures at the top of the drop function (`:3313-3320`); the first WP-I worker named that as the blocker and was wrong on the mechanism while right on the conclusion.
- 2026-08-05 — three parts need groupthink deliberation: human-overview layer (A1+B4, int_7c3e9a12), WP-ingest implementability chain (B3+, int_4f8b2d61), promote-path single-writer (C1, int_9e5d0c47); A2/A3/B1/B2/B5 need no hardening; no online research needed.
## Work packages
Cut 2026-08-05 by supervisor ae889b24; full bundle contracts in [supplements/2026-08-05-work-packages.md](supplements/2026-08-05-work-packages.md). Re-cut (not concatenated) from the three deliberations' 15 packages because they overlapped on shared machinery. Dispatch waves: **1)** WP-A, WP-J · **2)** WP-B · **3)** WP-C → WP-D (same watcher seam, sequence) · **4)** WP-E, WP-G · **5)** WP-F, WP-H, WP-I · **6)** WP-Z.

> ⚠ **These waves are superseded at dispatch time by `## Cross-plan boundary` below.** plan_0e1425af's packages interleave with ours: their WP-1 and WP-2/3/4 must land between our WP-A and our WP-B, and WP-F moves after their WP-5. Read that section before dispatching anything.

- WP-A Shared foundations: strict JSON, plan identity, one coordinated scaffold revision — **DONE 2026-08-06, gated — commit `1248e733`** (codex 16452fca; subsumes WP-INGEST-1 + WP-HOV-1 + WP-PROMOTE-1 §1/§8; the plan's single serialization point). Deviation: `derivePlanSku` left live — see Decisions.
- WP-J Unhardened surface items: gallery filter, proposal-tab fallback, review-column honesty (B1/B2/B5) — **DONE 2026-08-06, gated — commit `9e7284f7`** (codex 07caf724). B1-backfill applied to 3 proposals; 1 of the 3 stamped in worktree only — see Decisions.
- WP-B DB companions and atomic work-package reconciliation — **DONE 2026-08-06, gated — commit `c0273a79`** (codex 16d30366; + Task 0 `70411aa2`). Rollback verified after all seven mutation stages; 10 new tests. Subsumes WP-INGEST-2.
- WP-C Work-package parser, responsibility reconciliation, watcher seam — **DONE 2026-08-06, gated — commit `e9482700`** (codex dd3c498e). Subsumes WP-INGEST-3. **Seam for WP-D: `reconcilePlanFolderPlanningState()` is the single ordered extension point — intent ledger → responsibility → work packages → downstream callback; WP-D inserts overview projection before the callback. Composite signature and periodic `PlansWatcher` wiring deliberately untouched.** Verified: `supervisor_active_plan` is DELETE-only, scoped to this plan (`plan-work-package-ingest.ts:104`), with a test proving a prior supervisor pointing at a DIFFERENT plan keeps its pointer; last-`assigned`-wins by array order, no timestamp sort.
- WP-D Human-overview parser, projection, adoption state, watcher convergence — **DONE 2026-08-06, gated — commit `c82f6684`** (codex d63f4327). Subsumes WP-HOV-2. Adoption monotonicity verified at THREE layers: transition fn (`database.ts:5536`), SQL ratchet `CASE` in the reconcile upsert (`:5574-5577`, pins projected→projected / observed→observed regardless of caller), and the CHECK constraint (`:2167`). Composite `{maxManagedMtimeMs, overviewToken}` signature landed. Windows junction/read-only safety tests ran natively; POSIX symlink skipped with reason.
- WP-E Common folder-reconciliation coordinator and source-proposal projection — **DONE 2026-08-06, gated — commit `06a7ce38`** (codex 2ee30b18). Subsumes WP-PROMOTE-2. **CONTRACT FOR WP-F/G/H/I: `reconcilePlanFolderProjections(input): Promise<PlanFolderProjectionResult>`; input `{workspace, planFolderRelPath, changeKind?, downstreamCallbacks?, now?, test-only seams}`; result `{planId, folderRelPath, intentLedger, sourceProposal, responsibility, workPackages, overview}`. Order: adopt plan row → intent ledger → source-proposal linkage → responsibility → work packages → overview → queued downstream callbacks. `adoptPlanFolder()` proves ROW ADOPTION ONLY — callers needing convergence MUST await `reconcilePlanFolderProjections()`; that await proves source AND responsibility settled.** The brief's ordering and WP-C/D's seam order were reconciled as a superset, not a conflict. Isolation verified: no `supervisor_active_plan` writer reintroduced, no `plan_documents` deletion, no new `derivePlanSku` caller.
- WP-G Optimistic overview disk editor and truthful Packages state — **DONE 2026-08-06, gated — commit `48cc8190`** (codex c350d9f0; subsumes WP-HOV-3). Scope verified inside briefed paths (`plan-ipc.ts`, `PlanDocumentTabs.tsx` only). Awaits `reconcilePlanFolderProjections()` per WP-E's contract and returns `overview-saved-projection-pending` on durable-save/projection failure. Serialization (max concurrency 1), final-observation stale rejection, byte-identical destination on replacement failure, and temp cleanup all exercised by induced-failure tests. No "atomic compare-and-swap" claim in code or tests. Isolation clean: no `derivePlanSku`, no `supervisor_active_plan` write, no `plan_documents` deletion. **Known crumb:** one stale renderer test still asserts the retired "not yet implemented" text; WP-G declined to edit it as out of scope, WP-H hit the same test and also declined. Belongs to WP-Z or a cleanup commit — it is a test-only failure, production renders the new wording.
- WP-H Shared readiness evaluator: forced refresh, Mark Ready, Implement — **DONE 2026-08-06, gated — commit `8d92bdfb`** (codex 7f369764; MERGES WP-INGEST-4 + WP-HOV-4 to prevent two readiness interpretations). Scope verified inside briefed paths (`plan-lifecycle.ts`, `plan-implement.ts` only). **ONE evaluator: `refreshAndGetPlanReadiness(planId, deps?)`, consumed by both Mark Ready and Implement** — the merge's whole purpose, verified in the tree. Awaits WP-E's coordinator before evaluating. Mark Ready is a `hardening → ready` compare-and-set; only `ready` packages qualify; blocked-only plans refuse. Implement refuses before ANY git probe or baseline creation when refresh/readiness fails (validate-before-git-baseline held). Refresh never advances lifecycle — two explicit human actions required. `npm run test:supervisor` green in 445s; main `tsc` clean.
- WP-I Authority-safe legacy promotion drain and gated retirement — **IN FLIGHT 2026-08-06, REDISPATCHED with corrected scope** (codex 5f841938; subsumes WP-PROMOTE-4). First dispatch STOPPED without committing — correctly — on a scope/tree conflict; see Decisions 2026-08-06 (scope ruling) and the P8F defect entry. Now running as TWO commits: (1) fix the shipped P8F create-then-drop defect, (2) WP-I proper. **Commit 1 DONE and GATED — `5cd21052`** (`database.ts` + `plans-legacy-drop-migration.test.ts` only). Mechanism verified in the tree: marker read once via a new `hasAppliedMigration()` helper, the whole six-table CREATE block wrapped in `if (!legacyPlanProvenanceRetired)`. **Guard boundary checked exactly — opens `database.ts:1023`, closes `:1164`, encloses precisely the six retired tables AND all six of their indexes, nothing else.** That boundary was the fix's own risk surface: a brace one line short would have left `CREATE INDEX … ON plan_snapshots` outside the guard, throwing "no such table" and crashing DB init on every boot after the drop. The drop function was refactored onto the same helper, so exactly one marker-read implementation exists. Regression test does a real close + `initDatabase()` to model boot 2, and correctly fixes the test fake to PERSIST its store across close — without that the test would have passed vacuously against a fake that resets. **Commit 2 DONE and GATED — `be234e4f`** (9 files, all inside the prose Files list; worker took one continuation, finishing at 160 turns). Cross-plan bar clean. **`promotion_requests` creation is now marker-conditional (`database.ts:2022`) using commit 1's shared `hasAppliedMigration` helper — one idiom, not two.** Verified mechanically, in the order that matters:
  - **No live writer survives to the table being dropped.** `index.ts` now calls `providePromotionService(null)` and deletes the `dispatchFresh` route; `insertOrReadPromotionRequest` has exactly ONE runtime caller (`promote-proposal.ts:282`, inside `promoteProposal()`), reachable only through that nulled seam; every surviving `promote-proposal` import elsewhere is `import type`, erased at compile time. A null service is a first-class supported state, not a crash — `plan-ipc.ts:665` documents that unwired handlers "reject honestly".
  - **The DROP is genuinely awaited-drain-gated.** `runDrainAndRetire()` awaits a sequential per-request loop, then awaits `collectUnverifiedBoundAgents()`, and only then calls retire (`legacy-promotion-drain.ts:100-125`). Single-flight: a concurrent `drainAndRetire()` returns the in-flight promise rather than racing. Per-request errors leave that request PENDING and recorded `indeterminate` — a throwing branch never aborts the sweep or silently skips.
  - **The drop is TOCTOU-safe and atomic.** Five typed pre-checks (active-drain, unverified-live-bound-agent, pending-requests, nonterminal-promotion-runs, pointer-disagreement), then blockers are RE-READ inside the drop transaction and the transaction throws if any appeared. `DROP TABLE` and the marker INSERT are in the SAME transaction, so "dropped but unmarked" — the state that would let boot 2 recreate it — is unreachable. `promotionRequestsTableExists()` guards post-drop blocker reads.
  - **Orphan nonterminal runs block retirement, and the check is stronger than the acceptance.** `orphanNonterminalRunIds` is derived as a SUBSET of `nonterminalRunIds` (`.filter(runId => !requestByRun.has(runId))`), and the gate tests the parent set — so ALL nonterminal promotion runs block, orphan or not. The orphan list is a diagnostic breakout, not the gate. This was the package's most plausible silent failure (two sibling fields, only one checked) and it is correct.
  - Tests: `test:supervisor` 434s green, `test:plans` green, main `tsc` clean, drain 16/16, promotion-requests 8/8, lifecycle-stop 26/26, launch-binding 12/12, startup wiring 1/1.
  - **Accepted limitation, stated honestly by the worker:** no real Electron boot with an externally-killed process at every instruction boundary — the crash matrix is covered by deterministic DB/startup/delivery/lifecycle fault fixtures instead. That gap is WP-Z's and Edward's restart, not a defect here.
  - **Deliberate carry-over:** `pendingLatches` (`promote-proposal.ts:162+`) survives despite the brief's "delete it" instruction. Correct call — that file is WP-F's to delete entirely, the same reasoning WP-A applied to `derivePlanSku`, and it is now unreachable dead code. Closes at WP-F.
- WP-F Server-authoritative preflight and the sole mounted promote gesture — **DONE 2026-08-06, gated — commit `1277290f`** (codex f095654b, reaped). Subsumes WP-PROMOTE-3 + preflight half of WP-PROMOTE-1. **LAST of ours in the merged order; their WP-6 released on this gate.** 22 files, −1736 net; file set matches the prose **Files** list exactly and no foreign-dirty file was touched. Gate evidence read from the TREE, not the worker summary: `promote-proposal.ts` deleted → `derivePlanSku` has **zero executable references in `src/`**; the only survivors are two deployed-skill PROHIBITION strings in `constants.ts` + their scaffold assertion (guardrail text — must stay; do not "clean up"). `pendingLatches`, the legacy compat path, the old `proposal:promote`/`proposal:promotionStatus` IPC + preload bindings, and `PromoteDialog` all died with the file. Guard test lives in `promotion-preflight.test.ts` (6/6). Suites: `test:supervisor` green 465s, `test:plans` green, main tsc + both builds green, focused renderer 27/27.
  - **THE INHERITED "~10 CALL SITES" WAS STALE — recorded so no future package re-derives it.** Zero calls existed in `promotion-dispatch.ts`, `promotion-reconciler.ts`, `promotion-claim-scan.ts`, or `index.ts` (all four named in the obligation block). Reality at gate time: ONE production call + ONE test call, both inside `promote-proposal.ts`, plus three TYPE-only imports (`legacy-promotion-drain.ts`, `promotion-claim-scan.ts`, `plan-ipc.ts`) re-homed. WPs B–I had shifted the tree since WP-A's gate. The brief's own instruction to re-derive rather than trust the count is what caught it — keep that instruction in WP-Z.
  - **Boundary B verified intact (ac1cb0b6 independently re-verified against the tree before dispatching WP-6).** `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` still imported and substituted as TEXT (`promotion-dispatch.ts:2,19`); `isValidProposalArtifactId` survives as the panel sanitizer (`:7`, consumed `PromoteToPlanPanel.tsx:43`) feeding `artifactIdCrossCheck?`. One WP-1 assertion CHANGED and was **replaced, not weakened**: `'proposal is missing a valid artifact_id'` → `'server preflight returned an invalid plan identity'`, i.e. the rejection moved renderer-guessed → server-authoritative, which is the package's purpose. Likewise `Proposal path: C:\work\.lares\proposals\idea.md` → `.lares/proposals/idea.md`. New `isSafeProposalRelPath` rejects absolute paths, `..` traversal, and bare filenames. Peer raised no objection.
- WP-Z End-to-end gate: promote to implement on one skill-driven plan — **DONE 2026-08-06, gated — commit `e1a6ab5a`** (codex 17c977c7, reaped). **PLAN COMPLETE: all 11 packages landed+gated.** 3 files only: new `src/main/plans/proposal-to-implement.e2e.test.ts` (467 lines, registered in `scripts/run-main-tests.mjs` so it runs in CI, no `.skip`/`.only`), plus the crumb fix. **ZERO production changes — the correct outcome**, meaning the gate exposed no defect in our packages; nothing was routed to ac1cb0b6. Renderer plan suite now **124/124**; full main suite green 359s; main tsc + production Vite build green; app NOT rebuilt/restarted/killed.
  - **OPEN CRUMB CLOSED, and closed the right way round.** `PlanSurfaceView.tabs.test.tsx` now asserts the actually-shipped string (verified at `PlanDocumentTabs.tsx:517`: "No work-package definitions have been imported yet…Refresh imports them into the Mission Board.") — the TEST was corrected to match production, never the reverse, and the assertion was strengthened rather than deleted or skipped. Four prior packages (G, H, I, F) correctly refused to touch it because it wasn't theirs.
  - **⚠ ITEMS 11, 12, 15 ARE FIXTURE-PROVEN ONLY — DEPLOYMENT REMAINS UNPROVEN UNTIL A HUMAN RESTART.** The worker reported this honestly and unprompted; do NOT let a successor upgrade it to "verified". What IS proven: an exact v3-era fixture (SKILL v2 / promote v2 / plan-manifest v3 / capture v3) migrates in ONE reconciliation with zero pristine `.bak` files; pristine `capture.md` disappears without backup while a modified copy is backed up exactly once and the sidecar records v4; both new skills appear in every intended existing-workspace lane. What is NOT proven: that any of this runs in Edward's real workspace. Only `npm run restart` proves that, and no worker can relaunch the app it runs inside. (A/J/B/C/D/E/F/G/H/I all landed+gated). Now blocked ONLY on plan_0e1425af's WP-6 (dispatched 2026-08-06, codex `cde134f9`, owner ac1cb0b6) and then on EDWARD'S RESTART.** Unassigned. Two things it must carry: (1) **the restart is not delegable** — no worker can verify the real-workspace scaffold migration (deployed v4/v3) from inside the app it runs in, so no package may claim it from headless tests; (2) **the open crumb**: `PlanSurfaceView.tabs.test.tsx` still asserts the retired "not yet implemented" Packages text (renderer plan suite 123/124). TEST-ONLY — production is correct. WP-G, WP-H, WP-I and WP-F all hit it and all correctly refused to edit another package's file; it is WP-Z's or a standalone cleanup commit's.
## Deliberations
- **int_4f8b2d61** — wp-ingest-implementability-chain (B3 + supervisor reconciliation) · rung: **folded-in** · output: [deliberations/2026-08-05-int_4f8b2d61-wp-ingest-implementability-chain.md](deliberations/2026-08-05-int_4f8b2d61-wp-ingest-implementability-chain.md) · orchestration_id `64d9833c` (groupthink parallel, codex lead + codex reviewer; self-declared cross-check only — `ran` is unavailable pre-ledger). Integrated 2026-08-05: decided the strict additive `PLAN-WORK-PACKAGES:v1` supplement block as sole machine-readable WP source, two independently-atomic projections at the plan-folder-watcher settled seam, two companion tables (frozen `plan_work_packages` shape untouched), runtime-ownership rejection + lifecycle-aware tombstoning with no hard deletes, fail-closed responsibility reconciliation that never assigns `supervisor_active_plan`, and Mark Ready re-gated on ≥1 `ready` package via CAS. Cuts WP-INGEST-1..4 + Z; requires from int_7c3e9a12 only a non-empty Packages tab overview.
- **int_7c3e9a12** — human-overview-layer (A1+B4) · rung: **folded-in** · output: [deliberations/2026-08-05-int_7c3e9a12-human-overview-layer.md](deliberations/2026-08-05-int_7c3e9a12-human-overview-layer.md) · orchestration_id `2835baac` (groupthink serial, codex lead + codex reviewer; self-declared cross-check only). Integrated 2026-08-05: one `OVERVIEW.md` beside `ARC.md` with a `PLAN-TAB-OVERVIEWS:v1` index + delimited per-tab sections; `package` derives the tab inventory from disk (never SQLite) and always writes Packages, so the existing per-populated-tab readiness gate is KEPT UNCHANGED rather than special-cased; reconciler projects all stable tab keys atomically at the same watcher settled seam; `plan:setOverview` becomes a disk write under a per-plan mutex with optimistic source-hash detection (documented as not atomic CAS); adds monotonic overview adoption state, a provenance table, and a composite watcher signature so lower-mtime edits and rename-aways converge. Cuts WP-HOV-1..4 + Z.
- **int_9e5d0c47** — promote-path-single-writer (C1) · rung: **folded-in** · output: [deliberations/2026-08-05-int_9e5d0c47-promote-path-single-writer.md](deliberations/2026-08-05-int_9e5d0c47-promote-path-single-writer.md) · orchestration_id `c090565e` (groupthink serial, codex lead + codex reviewer; self-declared cross-check only). Integrated 2026-08-05: **chose option (a)** — skill + reconciler is the sole promotion path, saga retires. One `reconcilePlanFolderProjections` single-flight coordinator becomes the only SQLite writer for folder-derived state; `PromoteToPlanPanel` stays the single gesture and reports "assigned", never "plan created". Server-authoritative preflight on an opaque `proposalDocumentId` with six typed outcomes; renderer holds no path/identity authority. Legacy `promotion_requests` drained per classified crash-matrix branch with verified agent shutdown, never reconstructing a body, table dropped only behind a gated readiness check. Cuts WP-PROMOTE-1..4 + Z with a full delete-now / retain-inert / keep inventory.

### Latent bug found during deliberation (supervisor note, 2026-08-05)
`int_9e5d0c47` surfaced a defect **outside the proposal's original scope**, in the promote machinery this very plan was created with: `src/main/plans/promote-proposal.ts:71-76` derives the plan SKU from the proposal **filename**, and the deployed `plan-manifest.mjs` `toRelProposal()` resolves the proposal via a `.lares/proposals/` **substring search with a basename fallback** — both contradict §R0/promote's rule that identity comes from frontmatter, never the filename. This plan's own scaffold happened to produce the correct `source_proposal.rel_path` because filename and title agreed closely enough, but a proposal whose filename and `title` diverge would mis-key. The fix is folded into **WP-A** (one authored `src/shared/plan-identity.ts` + generated `plan-identity.mjs`, strict realpath-validated proposal paths under the active state root).

### Cross-deliberation coupling (supervisor note, 2026-08-05)
Three couplings, each found independently by more than one deliberation. **They are the reason the 15 deliberation packages were re-cut into 11** — the re-cut resolves them structurally, so the notes below are now the rationale, not an outstanding instruction:
- **Shared strict-JSON helper.** `PLAN-WORK-PACKAGES:v1` and `PLAN-TAB-OVERVIEWS:v1` must use ONE duplicate-key-rejecting helper (`src/main/plans/strict-json.ts`, `jsonc-parser`). Resolved by putting the helper in **WP-A** ahead of both parsers (WP-C, WP-D).
- **Single coordinated scaffold version bump.** Three deliberation packages (WP-INGEST-1, WP-HOV-1, WP-PROMOTE-1 §8) all edit `PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD` / `PROPOSAL_TO_PLAN_TREE` / the old-body fixtures / `scaffold-version-migration.test.ts`. Resolved by merging all three into **WP-A** as ONE scaffold revision, per the `scaffold-content-needs-version-bump` skill. WP-A is therefore the plan's single serialization point — one worker, no parallel dispatch.
- **Shared readiness service.** `refreshAndGetPlanReadiness(planId)` must have exactly one implementation and one interpretation. Resolved by merging WP-INGEST-4 and WP-HOV-4 into **WP-H** rather than leaving an owner/extender pair.
- **Also sequenced, not merged:** WP-C and WP-D both edit `plan-folder-watcher.ts` at the same settled seam, so wave 3 runs them in order rather than in parallel.

## Cross-plan boundary — plan_0e1425af (supervisor note, 2026-08-05)

Agreed 2026-08-05 between supervisor **ae889b24** (this plan) and **ac1cb0b6**
(plan_0e1425af, "Split the proposal lifecycle"), at Edward's direction, **before
either plan dispatched a worker**. Both plans were packaged off baseline
`e46ae812` and would have collided. Both supervisors accepted the terms in full.
A successor of either plan inherits this section; it is binding on dispatch.

**Merged dispatch order across both plans** (each arrow is a full gate):

`WP-A ∥ WP-J` → `their WP-1` → `their WP-2/3/4` (second scaffold bump) →
`their WP-5` → `WP-B` → `WP-C` → `WP-D` → `WP-E` → `WP-G/H/I` → `WP-F` →
`their WP-6` → `WP-Z`

**Boundary A — two scaffold bumps, strictly serialized.** Their WP-2/3/4 share a
scaffold-version bump touching the same four surfaces as WP-A
(`src/shared/constants.ts`, `PROPOSAL_TO_PLAN_TREE` at
`src/main/supervisor/index.ts:1238-1306`, `proposal-to-plan-old-body-fixtures.ts`,
`scaffold-version-migration.test.ts`). Both packages re-derive pristine hashes
before editing, so **running them in parallel breaks the migration chain for
existing workspaces** — a correctness failure, not a merge conflict. WP-A bumps
FIRST and gates fully; their bump re-derives from post-WP-A HEAD. Two bumps in a
chain is supported; two concurrent bumps are not. Conditions on WP-A: it leaves
the `capture` mode row **byte-untouched** (neither assuming it survives nor
deleting it — their WP-4 owns that row), and it asserts no "exactly one scaffold
revision" claim in any comment or test, because a second bump follows it in the
same chain. (The unrelated "exactly one strict-JSON implementation" assertion
stays.)

**Boundary B — the promote-panel instruction seam.** Their WP-1 also edits
`src/shared/constants.ts` (adding `PROPOSAL_PROMOTION_PROMPT_TEMPLATE`), so it is
**not** renderer-only and cannot run parallel to WP-A either — it is a textual
collision on the same file mid-hash-derivation. Their finding; both supervisors
had WP-1 filed as independent. Division of authority: the template **text** and
`isValidProposalArtifactId` stay renderer constants (theirs); the **path and
identity** that fill the template come from WP-F's server preflight (ours).
`isValidProposalArtifactId` survives as the panel-side input sanitizer feeding
WP-F's `artifactIdCrossCheck?` parameter — the renderer-supplied id is a
cross-check, never authority. **WP-F acceptance condition (added):** their WP-1
assertions must still be green after WP-F — the instruction contains
`Do NOT run capture`, the artifact_id line, and the
`scope -> promote -> deliberate -> integrate -> package` ordering.

**Boundary C — writer order on the proposal-card files.** Four packages write
`ProposalCardGallery.tsx` + `proposal-card-metadata.ts`. Full gated order:
**WP-J → their WP-1 → their WP-5 → WP-F.** (WP-F was floating in our cut; their
catch.)

**Boundary D — frontmatter key ownership.** WP-A owns the **promote-time** keys
(`promoted_to`, `promoted_at`, Status refresh). Their WP-2 `write-proposal`
contract owns the **authoring-time** block (`artifact_id`, `author`,
`author_agent_id`, `author_role`, `authored_at`). Neither touches the other's
keys, and their authoring skill is **additive** — it never strips or rewrites
unknown frontmatter, so promote-time keys survive a re-authoring pass.

**Amendments this plan owes (fold into the WP briefs at dispatch):**
- **WP-J** — re-gate acceptance on a **fixture-stamped** proposal, not on WP-A's
  live promote behavior, so `depends_on: []` is honest.
- **WP-J** — carry the one-time **backfill** of `promoted_to`/`promoted_at` onto
  already-promoted proposals. Ground truth verified on disk 2026-08-05: **4 plan
  folders, 12 proposals, exactly 1 stamped** — and that one was hand-stamped by a
  supervisor, because the deployed promote path does not stamp at all today
  (WP-A item A3 is unbuilt). Backfill is therefore 3 proposals, including
  plan_0e1425af's own source. Without it, WP-J's filter makes this plan's
  proposal vanish from the active gallery while every other promoted proposal
  stays — asymmetric, reads as a bug, is not one.
- **WP-J** — the collapsed "promoted" group must render **full card metadata**,
  not a bare filename list, so their WP-5 byline and WP-6 visual check work
  inside it.
- **WP-A** — brief must state `promote-proposal.ts:71-76` is **deleted, not
  repaired** (WP-F removes the file entirely). Do not brief a worker to fix a
  doomed file.

**Round 2 (2026-08-05, after Edward challenged whether the boundary was
sufficient — it was not).** Re-examined against the code rather than against the
agreement. Verified narrowing first: `PROPOSAL_TO_PLAN_TREE`
(`src/main/supervisor/index.ts:1275-1297`) is **per-file versioned**, each entry
carrying its own `version` + `previousHashes`, and their WP-4 leaves
`references/` and `scripts/` untouched — so the two "bumps" are disjoint except
on **`SKILL.md` and `orient.md`**. Boundary A survives. Four further gaps in that
residue, none covered by round 1:

- **Gap 1 (mechanical, theirs).** `previousHashes` is a cumulative
  `Record<version, hash>`: `scaffold-writer.ts:132` scans *every* value for
  pristine detection and `:186` falls back to entry `1`. Their "re-derive from
  post-WP-A HEAD" instruction, followed literally, writes a latest-only map and
  drops the older entries — every workspace below that version is then treated as
  user-modified, backed up to `.bak`, and never migrates. Silent; only reproduces
  on a real workspace after restart. Fix: ADD the new hash, preserve all priors.
- **Gap 2 (mechanical, theirs).** `capture.md` must be retired via the
  `removed: true` path (`scaffold-writer.ts:39, :122`), which backs up then
  deletes and records it. Deleting the tree row instead orphans a stale playbook
  on disk in every existing workspace, unreferenced by the rewritten SKILL.md but
  still readable by an agent.
- **Gap 3 (shared).** `SKILL.md` is the one genuinely contested file. WP-A writes
  the A2 continuity rule; their WP-4 then rewrites the trigger and mode table.
  Ordering cannot protect A2 — only briefs can. Both sides amended: WP-A writes
  A2 as a self-contained block plus a test; their WP-4 is told A2 is there and
  must survive verbatim.
- **Gap 4 — RESOLVED 2026-08-05, both sides agreed. Anchor:
  `references/contracts/responsibility.md` §`Determination`**. **Gap 6 (raised by
  accepting the anchor, theirs): WP-A CREATES the contract at v1**, not their
  WP-4 — citation and referent must land in the same gate, or WP-A ships a
  deployed agent-facing dangling pointer into every real workspace for the whole
  interval between the two gates (a live broken reference inside a playbook an
  agent is following; no test catches it). The §Determination body is lifted from
  rules `orient.md` already carries — co-location, not new design. Their WP-4
  then strips the duplicates from `orient.md`, cites the contract, and owns its
  content from v2 onward; WP-A owns v1 only. `promote.md`'s EEXIST loser rule **cites** that anchor instead of saying
  "run `orient`". `read-planning-surface` (their WP-3) may *report* who is
  responsible but **must not restate the derivation rules even descriptively** —
  it cites the same contract as normative. Their sharpening, and it is the
  durable half: two copies of the rules in two separately-versioned skill bodies
  would drift, and that drift is the split's real long-term failure mode. A
  contract file was chosen over a heading in `orient.md` because
  `references/contracts/` is the established home for rules cited from multiple
  places (`supervisor/index.ts:1289-1293`), it versions independently, and
  `orient.md` is being hollowed by the split. **WP-A may now author the
  promote.md wording** — confirm the exact filename against what their WP-4
  lands before writing the citation.
- **Gap 1 severity corrected by them (verified).** My "never migrates" was wrong
  in direction: `scaffold-writer.ts:198-208` backs up *and* upgrades, so no
  workspace is stranded. The durable damage is that `SCAFFOLD_BAK_RETENTION`
  (`:49-54`) never prunes a backup matching no known managed body — so the
  spurious `.bak` is permanent litter and a genuine user edit becomes
  indistinguishable from a pristine copy. Same fix, worse consequence.
- **Gap 2 confirmed stronger than argued.** `ScaffoldFile.removed`'s doc
  (`scaffold-writer.ts:30-38`) already states the rule outright, and
  `supervisor/index.ts:3301` (`orchestration-spike/SKILL.md`, `removed: true`,
  `previousHashes {1,2}`) is a landed precedent of the exact shape.
- **Contested surface narrowed to `SKILL.md` ALONE.** `orient.md` is theirs
  outright — WP-A never byte-edits it; it was only a semantic dependency of
  `promote.md`, and the contract anchor removes even that. One contested file
  across both plans' seventeen packages.

- **Gap 4 (original statement, superseded by the resolution above).** WP-A's matching-EEXIST
  loser rule in `promote.md` says "run `orient`, and if another supervisor is
  responsible, stop without mutating" — but their WP-3 moves orient's
  rung-derivation into a read-only skill that never writes or appends `assigned`
  events. "Run orient" stops being one coherent action. **Proposed** (theirs to
  confirm, they own the split's design intent): responsibility determination
  stays in `proposal-to-plan` because it is a precondition of a WRITE action, not
  a surface report; `read-planning-surface` takes only cross-surface reporting.
  WP-A must not author the promote.md wording until this is settled.
- **Gap 5 (ours, fixed).** WP-Z was authored against the monolithic skill and in
  the merged order now gates a skill split into three. Re-authored 2026-08-05:
  item 1 driven through the post-split arrangement, plus new items 11–15
  (two-bump migration from a v3-era workspace, capture retirement leaves no
  orphan, A2 survived, responsibility determination still reachable, both new
  skills provisioned to existing workspaces). The rebuild/relaunch check is now
  non-optional — items 11–13 and 15 cannot be reproduced in-process. WP-Z also
  now spans two plans: failures must be classified by owning plan and routed, not
  silently repaired.

**Deferred obligation (named, not buried).** Their WP-3 (`read-planning-surface`
skill) documents **disk-derived state only** and explicitly disclaims gallery
grouping, DB projection, and readiness gates — those surfaces are ours and in
flux across WP-C/WP-H/WP-J. Documenting them is therefore **owned by
plan_e0001372 and scheduled after WP-Z gates**. It is deliberately NOT folded
into WP-Z, which is a test gate with "no production changes"; silently widening
it is how obligations get lost. Carried here so Edward and any successor can see
it.

## Who did what
- 2026-08-05 — supervisor ae889b24 ("Planning supervisor - planning surface fix"): scoped (3 intents marked), promoted, launched and integrated all three deliberations, re-cut the merged 11-package set, created the baseline tag, and hand-wrote `OVERVIEW.md` (the first example of the format this plan designs; no reader exists for it yet).
- 2026-08-05 — codex agent 157853e2 (read-only, stopped): scope second opinion; validated the proposal's file:line claims and contributed the implementability-chain gap, the partially-wired-saga correction, and the B3 ingest-schema/tombstone/transactionality risks.
- 2026-08-05 — groupthink run `64d9833c` (parallel, codex + codex): the int_4f8b2d61 deliberation artifact.
- 2026-08-05 — groupthink run `2835baac` (serial, codex + codex): the int_7c3e9a12 deliberation artifact.
- 2026-08-05 — groupthink run `c090565e` (serial, codex + codex): the int_9e5d0c47 deliberation artifact.
- 2026-08-05 — supervisor ac1cb0b6 ("Planning supervisor - planning surface split", responsible for plan_0e1425af): counterparty in the cross-plan boundary negotiation above. Contributed the `constants.ts` collision on their WP-1 that both supervisors had missed, the WP-J acceptance-vs-code dependency correction, the WP-F writer-order gap on the proposal-card files, and the disk ground truth that the promote path stamps nothing today.
