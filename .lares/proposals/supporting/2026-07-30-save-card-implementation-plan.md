# Save-card Implementation Plan

**Status:** executable implementation plan — GroupThink deliberation, Lead Planner ×
Reviewer, eight draft rounds, Reviewer-approved 2026-07-30. Hardens the approved
Save-card proposal (`.lares/proposals/2026-07-30-save-card-commit-ui.md`, Amendments
authoritative) into worker-sized work packages implementing the normative bundle
contract v1 (`.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`)
exactly, behind the adversarial matrix from
`.lares/proposals/supporting/2026-07-30-two-proposal-cross-evaluation-groupthink.md`
§5.2 and the engine grounding in
`.lares/proposals/supporting/save-card-git-native-input-2026-07-30.md`.

**Visual reference (added 2026-07-30, post-approval):**
`.lares/proposals/supporting/2026-07-30-save-card-ui-mockup.html` is the
Edward-approved static mockup of the final-form surface. Any WP that renders UI
(SC-WP-1C and later renderer packages) uses it as the layout/tone reference —
supervisor-unit default grouping, memory-jog description lines, loud-unsaved vs
quiet-saved sections, Push-to-origin row — while sourcing colors from the app's
real tokens in `src/renderer/styles/globals.css`, not the mockup's inlined
copies. Proposal Amendments 9–12 carry the corresponding rulings.

**Anchor policy:** symbolic anchors (function / type / constant / file names) are
**authoritative**; line numbers are orientation only — this repo is actively edited and
numeric anchors drift.

**Per-WP shape:** every package lists **Files · Dep · Do · Accept · §14-owned · Verify**
and fits one worker context.

---

## 0. Principle: contract types are whole; *behavior* is staged

`src/shared/commit-candidates.ts` (WP-0A) defines **every normative export in §§1–9**
(interfaces, unions, constants) — proven by an export-shape test, never a hard-coded
count. `src/shared/constants.ts` gets all five constants below. `BUNDLE_CONTRACT_VERSION`
stays `1` across all four stages because the wire shape never changes — only which fields
real machinery populates. **The pure assembler (WP-1W / 1D) accepts an optional
stamped-association source from the outset:** Stage ① supplies `null`; Stage ② supplies
frozen values — no assembler rewrite between stages.

**Concrete constants (WP-0A), provisional initial values** (mirroring
`RETENTION_DENSE_WINDOW_MS`'s "provisional" status):

- `BUNDLE_CONTRACT_VERSION = 1`
- `COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY = 128`
- `RETENTION_PIN_QUOTA_BYTES = 536_870_912` (512 MiB — **logical pinned-byte budget**,
  the sum of pinned blob sizes, **not** physical object-database disk usage)
- `RETENTION_PIN_MAX_EXTENSION_MS = 2_592_000_000` (30 days)
- `SAVE_CARD_COMMIT_COORDINATOR_ENABLED = false`

## 0.1 Verification command templates

The repository's Vitest config (`vitest.config.ts`) globs **only**
`src/renderer/**/*.test.{ts,tsx}`. Main/shared tests compile to JavaScript and run on
Node. Every WP's *Verify* uses the template matching its test's location:

```powershell
# Main/shared single test
npm run build:main
node dist/main/<compiled-test-path>.js

# Renderer single test
npx vitest run --config vitest.config.ts <renderer-test-file>

# Full main suite
npm run test:supervisor
```

**Registration rule:** every new main/shared test must be registered in
`scripts/run-main-tests.mjs` or `npm run test:supervisor` silently omits it. To avoid every
parallel WP contending on that shared registry, **each stage ends with one serialized
test-registration/gate WP (WP-1Z / 2Z / 3Z / 4Z)** that adds that stage's compiled
main/shared tests and runs the suite green. Renderer-only tests run under Vitest and are
**not** registered in `run-main-tests.mjs`.

---

## WP-0A — Contract types + constants (prerequisite to all)

- **Files:** `src/shared/commit-candidates.ts`, `src/shared/constants.ts`; test
  `src/shared/commit-candidates.export-shape.test.ts`.
- **Dep:** none.
- **Do:** define **every normative export in §§1–9** (interfaces / unions / consts); add
  the five constants above.
- **Accept:** export-shape test asserts every §§1–9 named export exists with expected kind
  (interface / union / const); typecheck clean; no behavior.
- **§14:** none (unblocks all).
- **Verify:** `npm run build` + export-shape test (main/shared template).

---

# STAGE ① — Read-only Save card (no real-index / HEAD / branch writes)

**Non-goals (explicit):** no finalization / tokens / commit-writer / retention-change /
stamp-columns / temp-index-preview / Git-object-or-ref-writes; **no plan attribution for
legacy/unstamped turns** (`planId`/`planItemId` render `null` with explicit "plan
attribution unavailable — legacy-unstamped" UI; `agents.plan_id` must **never** backfill
history); **no Save tear-off**; the card makes **no claim that read-only inspection has
made work safer** — it reveals state only.

### WP-1P — Binary Git seam (prerequisite)
- **Files:** `src/main/git-checkpoints/git-command.ts` (+`runGitBytes`),
  `git-command.runGitBytes.test.ts`.
- **Dep:** 0A.
- **Do:** `runGit` decodes stdout as UTF-8, so it cannot preserve authoritative path bytes.
  Add a bounded `runGitBytes` returning a `Buffer`, retaining the existing timeout,
  `index.lock`/lock classification, environment sanitization, and byte cap. No decode.
- **Accept:** raw bytes returned; non-UTF-8 fixture byte-exact; caps/timeout/lock/env
  preserved.
- **§14:** (enabling — non-UTF-8 / control-char path preservation).
- **Verify:** main/shared template; sibling `git-command.test.js`.

### WP-1C — RFC 8785 JCS encoder
- **Files:** `src/main/commit-candidates/jcs.ts`, `jcs.test.ts`.
- **Dep:** 0A.
- **Do:** RFC 8785 canonical JSON encoder, shipped with the RFC test vectors.
- **Accept:** RFC vectors pass; stable ordering; number/string canonicalization correct.
- **§14:** (underpins topology + candidate digests).
- **Verify:** main/shared template.

### WP-1A — Repository identity + workspace discovery + query-only turn reads
- **Files:** `src/main/commit-candidates/repository-identity.ts`, `scope-discovery.ts`,
  tests `repository-identity.test.ts` / `scope-discovery.test.ts`; query-only `turn_records`
  read accessor in `src/main/database.ts` (free-function `queryAll(...).map` convention).
- **Dep:** 0A.
- **Do:** `repositoryKey` is **net-new** — `git rev-parse --absolute-git-dir` +
  `--git-path index`, realpath-canonicalized, win32 drive-letter normalization consistent
  with the `commonDirQueueKey` idiom in `probeWorkspaceGit` (`src/main/git/git-runtime.ts`);
  `objectDatabaseKey ← capability.commonDirQueueKey` **verbatim** (already case-folded; never
  re-normalize); reject bare repos. Discover **all** workspaces sharing `repositoryKey`;
  expose immutable turn reads (agent, owner/supervisor-if-frozen, `touched[]`). **No
  `agents.plan_id`.**
- **Accept:** real index path; **linked worktree → distinct `repositoryKey`, shared
  `objectDatabaseKey`**; **multiple workspace aliases → one `repositoryKey`**; bare rejected;
  **absent / non-canonicalizable index target handled** (explicit outcome, no crash).
- **§14:** `repositoryKey` from real index path; bare repo rejected; absent-index handled.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-1B — DirtyInventory producer (raw half; inventory only)
- **Files:** `src/main/commit-candidates/dirty-inventory.ts`, `dirty-inventory.test.ts`.
- **Dep:** **1A (RepositoryIdentity) + 1P.**
- **Do:** `git --no-optional-locks status --porcelain=v2 -z --untracked-files=all` via
  `runGitBytes`, split on NUL **bytes**, `pathBytesBase64` authoritative, `displayPath`/
  `utf8Clean` derived after. **Scope via `enumerationPathspec`
  (`checkpoint-gating.ts`) + `--exclude-standard` semantics ONLY — do not call
  `enumerateScope()`** (it string-decodes paths, applies capture path/byte caps, `lstat`s,
  and can reject an oversized inventory the card must still show). Must match raw scoped
  `git status` **even when checkpoint capture would report `oversized`**. Populate all §2
  `DirtyEntry` fields incl. `rawWorktreeBlobOid` (`hash-object --no-filters`),
  `commitPathspecs`, `gitLevelEligibility` (`unmerged`/`160000`/non-UTF-8 ⇒
  `unsupported-git-state`). `entryId = sha256(repositoryKey + pathBytesBase64)`. **No DB
  witness accessor here.** Leaves `unattributedEntryIds`/`topologyDigest` to WP-1D.
- **Accept:** rename (both paths in `commitPathspecs`), copy, deletion-vs-unavailable-hash,
  symlink `120000`, gitlink `160000` ineligible, untracked, ignored-excluded, unmerged
  ineligible, submodule state, non-UTF-8/control-char preserved + unsupported, **raw** hash
  surfaced; tolerates repo-root invalid-char junk dirs.
- **§14:** Git-member semantics **raw half** (the clean-filtered-hash-differs case is 3G).
- **Verify:** main/shared template.

### WP-1E — Capture-health + shared live-edge verifier extraction
- **Files:** `src/main/commit-candidates/capture-health.ts`, `capture-health.test.ts`;
  **extract & export** the private `edgeUsable` (`src/main/git-checkpoints/retention.ts`)
  into a shared `verifyLiveEdge(...)` (new `live-edge.ts` or exported from retention) with
  `live-edge.test.ts`.
- **Dep:** **1A (repo/turn scope) + 1B (dirty members) + retention.**
- **Do:** §7 `TurnCaptureState`/`BundleCaptureHealth` from **live** `rev-parse --verify
  <ref>^{commit} == oid` (never the `after_ready` hint); classify `failureClass`;
  `captureOutage` true only for `capture-outage`. `pathsWithoutFinalizationEdge` = **all**
  dirty members (§7 exact meaning; no finalizations exist yet — truthful degeneracy, not
  "lacks a live checkpoint").
- **Accept:** `after_ready` overridden by live rev-parse; `captureOutage` true only for
  classified outage; field lists all dirty members.
- **§14:** `after_ready` override; `captureOutage` classified-only;
  `pathsWithoutFinalizationEdge` keyed to exact bytes.
- **Verify:** main/shared template.

### WP-1W — Witness projection (accepts optional stamp source)
- **Files:** `src/main/commit-candidates/witness-projection.ts`,
  `witness-projection.test.ts`.
- **Dep:** **1A + 1B.**
- **Do:** **prepend each turn's `workspacePrefix`** to its `touched[].path` (workspace-relative
  POSIX) **before** matching against repository-root Git paths. A **non-UTF-8 Git path cannot
  match a string-valued witness record → stays unattributed/ineligible.** Signature takes an
  **optional `stampSource`**; Stage ① passes null → null associations.
- **Accept:** prefix-prepended match correct across ≥2 workspaces on one repo; non-UTF-8 path
  unattributed; legacy turn null-associated.
- **§14:** unattributed pseudo-set correctness (witness side).
- **Verify:** main/shared template.

### WP-1D — Pure connected-component / topology assembler (optional stamp source)
- **Files:** `src/main/commit-candidates/component-assembler.ts`,
  `component-assembler.test.ts`.
- **Dep:** **1B + 1W + 1C.**
- **Do:** pure graph over `entry —witnessed-by— turn —same-agent/shared-path— entry`,
  transitive fusion; `ConflictComponent`/`BundleOverlap`/`BundleAssociation` (plan fields
  from the optional stamp source — null in ①); `componentTopologyDigest` + inventory
  `topologyDigest` (§3.2 via JCS). Fill `unattributedEntryIds` (never auto-grouped, D-5).
- **Accept:** transitive A–B,B–C ⇒ one; unattributed always present incl. empty; digest
  stable / changes-on-connect / unaffected-by-other-component / distinguishes
  identical-aggregate-different-per-path graphs.
- **§14:** topologyDigest stable / change / inert / distinguish; unrelated unattributed never
  auto-fuse.
- **Verify:** main/shared template.

### WP-1F — Exact checkpoint-protection evaluator
- **Files:** `src/main/commit-candidates/protection-read.ts`, `protection-read.test.ts`.
- **Dep:** **1B (members) + 1E (verifier).**
- **Do:** `ProtectionRung` per member. **`checkpoint-protected` requires the live tree/ref to
  contain the exact `{path, expectedState, raw blob, mode}` — including absence for
  deletion** — a live ref alone is insufficient. `locally-committed`/`remote-reachable` are
  unreachable in ① (no `commit_records`) → correctly `checkpoint-protected`/`unprotected`.
  Bundle weakest = min by `PROTECTION_RUNG_ORDER`.
- **Accept:** rung per exact tuple incl. deletion; higher rungs unreachable in ①.
- **§14:** rung per exact `{path,state,blob,mode}` incl. deletion (checkpoint/unprotected).
- **Verify:** main/shared template.

### WP-1G — WorkBundle DTO + read-only service facade
- **Files:** `src/main/commit-candidates/candidate-service.ts` (read-only:
  `assembleInventory`, `listWorkBundles`), `work-bundle.ts`, tests
  `candidate-service.read.test.ts` / `work-bundle.test.ts`.
- **Dep:** **1A–1F + 1W.**
- **Do:** project the canonical structures → `WorkBundle[]` renderer DTOs + synthetic
  **unattributed pseudo-bundle** + labels; **no topology logic in the projector** (D-1/D-5);
  raw absolute paths never leave main (§1). **Assemble across all workspaces sharing
  `repositoryKey`.**
- **Accept:** DTO carries components + pseudo-bundle + capture-health + weakest protection;
  no raw paths leak; membership matches raw `git status`; **multi-workspace → one component
  graph (integration)**.
- **§14:** membership matches raw `git status`; **same worktree multi-workspace ⇒ ONE
  component graph** (integration).
- **Verify:** main/shared template.

### WP-1H — Save-card IPC + preload
- **Files:** new `src/main/commit-candidates/save-card-ipc.ts`, `save-card-ipc.test.ts`;
  `SAVECARD_CHANNELS` + req/res + `IpcApi.saveCard` in `src/shared/types.ts`; register in
  `src/main/ipc-handlers.ts`; `saveCard:` namespace in `src/preload/index.ts`.
- **Dep:** 1G.
- **Do:** mirror `checkpoint-ipc.ts` (`IpcLike` interface, arg validators,
  `registerSaveCardIpc(ipc, getRoutes)` lazy-getter). Single read channel
  `savecard:getInventory`. **No mutating channel registered.**
- **Accept:** renderer fetches inventory; channel names follow convention; no write channel
  registered (audited).
- **§14:** (transport).
- **Verify:** main/shared template; sibling `checkpoint-ipc.test.js` still green.

### WP-1I — Renderer peer center-surface (Decision 4a)
- **Files:** `src/renderer/components/layout/MainContent.tsx` (**workspace header toolbar** —
  not `TopBar.tsx`, which is the frameless app-menu band), `src/renderer/stores/dashboard-store.ts`,
  new `src/renderer/components/save/SaveCard.tsx` + `SaveBundle.tsx` + `save-card.css`; tests
  `dashboard-store.saveCard.test.ts`, `SaveCard.test.tsx`.
- **Dep:** 1H.
- **Do:** peer button after PlansMenu in the toolbar group (`lucide-react` `Icons.Save`,
  `data-testid="view-btn-save"`, active-button + center-dispatch branch). In the store:
  `saveCardOpen` state + `showSaveCard` action; **explicit mutual exclusion in
  `showDashboard`/`showFileViewer`/`showBrowser`/`showSaveCard`** (each sets the others
  false); `saveCardOpen` in the `WorkspaceViewState` capture/restore; **workspace switch
  restores per-workspace `saveCardOpen`.** Video-game save feel: deliberate, satisfying state
  surface; the ① CTA is **inspect** (no writer exists). Tear-off = explicit non-goal unless
  this WP also extends `DetachableView` (`src/shared/types.ts`) + detached-window routing +
  `DetachedViewShell`.
- **Accept:** button switches the surface; exclusivity holds; view-state survives workspace
  switch; **no tear-off**.
- **§14:** (UI).
- **Verify:** renderer Vitest template for both tests; sibling `MainContent`/store suites.

### WP-1Z — Stage ① main-test registration + gate
- **Files:** `scripts/run-main-tests.mjs`.
- **Dep:** all Stage ① main/shared test producers (1P, 1C, 1A, 1B, 1E, 1W, 1D, 1F, 1G, 1H).
- **Do:** register each new `dist/main/**/*.test.js` path; run the full main suite.
- **Accept:** `npm run test:supervisor` includes and passes every Stage ① main/shared test;
  none silently omitted.
- **Verify:** `npm run build:main && npm run test:supervisor`.

**Stage ① dependency graph:**
```
0A → {1A, 1P, 1C}
1A + 1P      → 1B
1A + 1B      → 1E
1A + 1B      → 1W
1A + 1B + 1E → 1F
1B + 1W + 1C → 1D
1D + 1E + 1F → 1G → 1H → 1I → 1Z
```
First parallel wave after 0A: **1A, 1P, 1C** only.

**Stage ① user-visible acceptance (the gate):**
- **Performance (numeric):** `savecard:getInventory` returns **≤ 750 ms p95** for a fixture of
  **2,000 porcelain-v2 status entries across 3 workspaces + 500 witnessed turns**, on the
  supported dev platform (Windows 11, Node ≥ 20, dev build).
- **Comprehension:** on a fixture of ~12 bundles containing witnessed, unattributed,
  transitive-overlap, capture-outage, exact-checkpoint-protected, and unprotected entries, a
  supervisor locates dirty / unattributed / transitive-overlap / weakest-protection in
  **< 30 s**.
- **Reversibility:** injected Git-command audit proves no path writes the real index / HEAD /
  branch; no mutating IPC; no schema migration; empty / non-repo / unborn / error state
  renders; loading / refresh / stale-result behavior defined.

---

# STAGE ② — Immutable stamping + attribution upgrade + protection ledger + retention pinning

**Non-goals:** no finalization / tokens / preview / coordinator; **plan-only stamps** (item
stamping rejected until 3A). **DDL-serialization rule:** every `database.ts` `initDatabase()`
edit (2A, 2G DDL, binding-cols of 2D/2F) is **serialized** — logical consumer-independence
does not make DDL edits parallel-safe.

### WP-2A — Stamp schema + mapper + immutable accessor surface
- **Files:** `src/main/database.ts`; test `database.turnStamp.test.ts`.
- **Dep:** 0A.
- **Do:** guarded `try { db.exec(ALTER TABLE turn_records ADD COLUMN …) } catch {}` for
  `plan_id`, `plan_item_id`, `plan_stamp_source TEXT NOT NULL DEFAULT 'legacy-unstamped'`;
  workspace-leading indexes `idx_turn_records_ws_plan_seq` / `idx_turn_records_ws_plan_item_seq`;
  **first-ever** `CREATE TRIGGER turn_records_plan_stamp_immutable` (DDL-block style in
  `initDatabase()`); keep the three columns out of `TURN_UPDATABLE_COLUMNS`; extend
  `TurnRecord` / `AllocateTurnFields` / `rowToTurnRecord` / `allocateAndInsertTurn`;
  `AllocateTurnFields.planStampSource` excludes `legacy-unstamped`; accessor enum-validates.
  Keep "plain attribute, NO FK cascade."
- **Accept:** accessor + enum + trigger all block mutation incl. `plan_stamp_source`; legacy
  rows read `legacy-unstamped`; `legacy-unstamped` never allocation-written; deleting an agent
  preserves stamps; non-null `plan_item_id` rejected (no `plan_work_packages`).
- **§14:** those five.
- **Verify:** main/shared template; sibling `database.test.js`.

### WP-2B — Trusted resolver + boundary validation seam
- **Files:** `src/main/git-checkpoints/dispatch-context.ts`,
  `src/main/git-checkpoints/turn-coordinator.ts`; tests `dispatch-context.stamp.test.ts`,
  `turn-coordinator.stamp.test.ts`.
- **Dep:** 2A.
- **Do:** `ResolvedPlanStamp`, `DispatchAgentInfo.planId`, `DispatchDeps.planInWorkspace` +
  item-validity seam; §6.1 resolution modeled on the un-injectable `ownerBrickGeneration`
  pattern (never forgeable through the wire binding). `TurnContext` gains the resolved stamp;
  `openTurn` passes it into `allocateAndInsertTurn`; overlap re-open inherits the new send's
  ctx. Item requests **rejected** this stage.
- **Accept:** a wire `RequestedPlanBinding` cannot forge a `*-carry` source; overlap re-open
  uses the new stamp; explicit `none` vs default distinguished.
- **§14:** those three.
- **Verify:** main/shared template; sibling `turn-coordinator.test.js`.

### WP-2C — Human / API / IPC dispatch wiring
- **Files:** `src/main/api-server.ts`, `src/main/ipc-handlers.ts`; test
  `dispatch-binding.boundary.test.ts`.
- **Dep:** 2B.
- **Do:** validate `RequestedPlanBinding` at the boundary, **before enqueueing delivery**;
  reject invalid **explicit** ids (no PTY bytes, no turn row).
- **Accept:** direct-human `agent-default`; API explicit carried; cross-workspace explicit →
  reject 400 no-fallback; explicit item without/mismatched plan → reject; invalid explicit
  rejected before delivery.
- **§14:** those five.
- **Verify:** main/shared template.

### WP-2D — Orchestration initial + follow-up binding
- **Files:** `src/main/orchestration/dashboard-client.ts`, `groupthink-v2.ts`,
  `orchestration/types.ts`; `orchestrations` binding columns + `getOrchestrationBinding` in
  `database.ts` (DDL serial slot); test `orchestration-binding.test.ts`.
- **Dep:** 2B.
- **Do:** pass an `orchestration` `DispatchContext` carrying the run-frozen stamp, **follow-ups
  included** — stop calling `sendInput(id, text)` bare.
- **Accept:** explicit **plan-only** wins over default; no-explicit → worker default, no item;
  **follow-up messages reuse the run-frozen binding**.
- **§14:** those three.
- **Verify:** main/shared template; sibling orchestration suites.

### WP-2E — Fork / revive pending-prompt binding (plan-only)
- **Files:** `src/main/supervisor/index.ts` (fork + revive producers only); test
  `supervisor.forkRevive.stamp.test.ts`.
- **Dep:** 2B.
- **Do:** freeze the stamp into `pendingInitialPrompts` (shape `{ text, expiresAt, dispatch }`);
  fork copies `source.planId` at creation. **Stage ② scope: revive carries the plan default +
  explicit plan/`none`; item requests REJECTED** (revive item override → 3A).
- **Accept:** `fork-carry` + explicit clear (never read latest turn); `revive-carry` +
  plan/`none`, item rejected; `pendingInitialPrompts` retains metadata through delivery.
- **§14:** fork-carry; revive-carry (plan-only); metadata retained.
- **Verify:** main/shared template; sibling `supervisor/index` suites.

### WP-2F — Continuation persistence + restart reconciliation
- **Files:** `src/main/supervisor/index.ts` (continuation branch),
  `continuation_handoff_attempts` binding columns + `getContinuationAttemptBinding` in
  `database.ts` (DDL serial slot); test `continuation-binding.restart.test.ts`.
- **Dep:** 2B.
- **Do:** freeze the active binding onto the continuation attempt **before teardown**; the
  relaunch/reconciliation rail reads **these columns** — never latest `turn_records`, never
  live `agents.plan_id`.
- **Accept:** continuation freezes binding pre-teardown; **restart test** reads frozen columns;
  manual-terminal raw typing = unattributed inventory (no fabricated turn/stamp).
- **§14:** those two.
- **Verify:** main/shared template.

### WP-2I — Attribution upgrade into the assembler
- **Files:** `src/main/commit-candidates/stamp-projection.ts`, `stamp-projection.test.ts`.
- **Dep:** 2A (+ Stage ① assembler).
- **Do:** read `plan_id` / `plan_item_id` / `plan_stamp_source` from immutable turn rows and
  supply them as the optional stamp source to WP-1W/1D; `legacy-unstamped` → null/unavailable;
  refresh Save-card labels.
- **Accept:** newly-stamped turns show attribution; legacy stays null/unavailable; **a
  mixed-plan transitive component remains ONE component** (stamps present, topology unchanged).
- **§14:** **mixed-plan transitive stays ONE component.**
- **Verify:** main/shared template; rerun `component-assembler.test.js`.

### WP-2J — Read-only current-commit-representation helper
- **Files:** `src/main/commit-candidates/commit-representation.ts`,
  `commit-representation.test.ts`.
- **Dep:** 1B, 1P.
- **Do:** for a path, compute `{ expectedState, rawBlobOid, commitBlobOid, commitMode }` via a
  temporary `GIT_INDEX_FILE` **without creating a candidate or touching the real index**
  (byte-safe algorithm §"Temp-index algorithm" below). Prove real-index preservation by
  capturing the **complete raw binary `git ls-files --stage -z` output** of the real index
  before and after and asserting the two `Buffer`s are **byte-for-byte identical** (no
  dependency on `index-fingerprint.ts`, which lands in 3G).
- **Accept:** representation correct for modify/add/delete/rename incl. clean-filter
  divergence; **real index preserved** by byte-for-byte raw snapshot equality.
- **§14:** (enables 2G exact local protection).
- **Verify:** main/shared template.

### WP-2G — Protection ledger + reconciler; upgrade protection-read
- **Files:** `src/main/database.ts` (`commit_records` / `commit_turn_links` /
  `commit_path_links` DDL + CRUD, serial slot), `src/main/git-checkpoints/commit-reconciler.ts`
  (+`commit-reconciler.test.ts`); upgrade `protection-read.ts`.
- **Dep:** 2J.
- **Do:** record **exact** links for commits Lares creates; detect external HEAD movement and
  label inferred external links conservatively (`relation='metadata_only'` — never claim an
  external commit contains a turn merely on path overlap); compute `pushed_remote_count`
  against configured remote refs (a cached hint). Upgrade `protection-read` to reach
  `locally-committed` (match `commit_path_links` on `{path, expectedState, commitBlobOid ==,
  commitMode ==}` using 2J's current representation) and `remote-reachable` (read-time
  reachability).
- **Accept:** `locally-committed` requires the frozen clean-filtered commit entry (raw match
  alone insufficient); `pushed_remote_count` a hint (remote rung read-time); external never
  claims a turn on overlap.
- **§14:** those three.
- **Verify:** main/shared template; rerun `protection-read.test.js`.

### WP-2H — Pure quota selection policy
- **Files:** `src/main/git-checkpoints/protection-policy.ts` (pure), `protection-policy.test.ts`.
- **Dep:** 0A.
- **Do:** policy input is **edge candidates**, not paths (an edge may protect several paths):
  ```ts
  interface EdgePinCandidate {
    turnId: string; edge: 'before' | 'after';
    dirtyEntryIds: string[]; normalPruneEligibleAt: number; estimatedBytes: number;
  }
  ```
  `pinExpiresAt = normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS`. Order candidates by
  `normalPruneEligibleAt` ascending (soonest-to-expire, still-dirty first), tie-break by
  `turnId`; retain edges **atomically** (full `estimatedBytes`) until cumulative would exceed
  `RETENTION_PIN_QUOTA_BYTES`; **prefer the `after` edge over `before`** when only one fits
  (recoverable end-state). Edges past the quota or past `pinExpiresAt` fall to normal
  `decidePruneEdges`. Emit the weakening warning
  `{ quotaBytes, usedBytes, releasedEdges, willWeakenPaths }` only on forced release of a
  still-dirty edge.
- **Accept:** deterministic edge-atomic selection; after-over-before; warning only on forced
  release.
- **§14:** retention keep/release (pure half).
- **Verify:** main/shared template.

### WP-2K — Pin byte-accounting + retention executor integration
- **Files:** `src/main/git-checkpoints/pin-accounting.ts` (+test),
  `src/main/git-checkpoints/retention.ts` (integration) + `retention.pinning.test.ts`.
- **Dep:** 2H, 2G, 1B.
- **Do:** compute `estimatedBytes` = summed blob sizes (`git cat-file --batch-check`) for the
  edge's `dirtyEntryIds` oids **not reachable from HEAD or an active `boundary_ref`**; dedupe a
  shared oid across the retained set (charge once); on uncertainty **over-account, never
  under-account**. This is a **logical pinned-byte budget, not physical ODB disk**. Feed
  candidates to WP-2H; retain/release edges accordingly; resume normal thinning once a path is
  `locally-committed` (via 2G). **Fallback when dirty enumeration fails:** conservatively treat
  **every live edge that could otherwise prune** as potentially-dirty, bounded by
  `now <= normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS` (i.e. `pinExpiresAt`), then
  apply WP-2H quota selection over that candidate set — do **not** restrict the fallback to
  dense-window edges (those are already retained by normal policy and protect nothing
  additional).
- **Accept:** multi-path edge charged once; shared oids deduped; committed paths resume
  thinning; enumeration-failure fallback pins every otherwise-prunable live edge within the
  `pinExpiresAt` bound, quota-selected.
- **§14:** retention keeps/releases edges (executor half).
- **Verify:** main/shared template; sibling `retention.test.js`.

### WP-2L — Quota-weakening surfacing (main → IPC → DTO → preload → renderer)
- **Files:** `src/main/commit-candidates/candidate-service.ts` (attach the WP-2K warning to the
  inventory result), `src/main/commit-candidates/save-card-ipc.ts` (include it in
  `savecard:getInventory`), `src/shared/commit-candidates.ts` + `src/shared/types.ts` (warning
  DTO field on the inventory response), `src/preload/index.ts` (carry the field),
  `src/renderer/components/save/QuotaWeakeningBanner.tsx` (+`QuotaWeakeningBanner.test.tsx`),
  wired into `SaveCard.tsx`.
- **Dep:** 2K, 1G, 1H, 1I.
- **Do:** thread `{ quotaBytes, usedBytes, releasedEdges, willWeakenPaths }` end-to-end; render
  the single "uncommitted work is eating recovery space — time to save" line **only when at
  least one still-dirty edge will actually weaken** (empty `releasedEdges` ⇒ no banner).
- **Accept:** banner appears iff `releasedEdges` non-empty; hidden otherwise; DTO carries no raw
  absolute paths.
- **§14:** retention weakening-warning **surfaced** (UI half).
- **Verify:** main/shared template for the IPC test; renderer Vitest template for
  `QuotaWeakeningBanner.test.tsx`.

### WP-2Z — Stage ② main-test registration + gate
- **Files:** `scripts/run-main-tests.mjs`.
- **Dep:** all Stage ② main/shared test producers (2A, 2B, 2C, 2D, 2E, 2F, 2I, 2J, 2G, 2H, 2K,
  and 2L's IPC test).
- **Do:** register each new compiled main/shared test path; run the full main suite.
- **Accept:** `npm run test:supervisor` includes and passes every Stage ② main/shared test.
- **Verify:** `npm run build:main && npm run test:supervisor`.

**Stage ② user-visible acceptance:** dirty work retains **exact** recovery edges within quota;
the card shows checkpoint/local/remote state from **exact** evidence; immutable plan attribution
appears **only** for newly stamped turns (legacy unavailable); external commits never acquire
false turn attribution; warnings appear **only** when quota or max-extension will actually weaken
protection.

**Stage ② graph:** DDL serial `2A → 2G-DDL → binding-cols(2D, 2F)`; `2A → 2B → (2C ∥ 2D ∥ 2E ∥
2F)`; `2A → 2I`; `2J → 2G`; `2H` pure (parallel); `2G + 2H + 1B → 2K`; `2K + 1G/1H/1I → 2L`; all
→ `2Z`.

### Temp-index algorithm (byte-safe; WP-2J, reused by WP-3G)
Models `git commit --only` = HEAD + selected worktree paths, never unrelated real-index staged
entries.
1. **Seed** a fresh `GIT_INDEX_FILE=<temp>`: `git read-tree <pinnedHeadOid>`. **Unborn HEAD** →
   `git read-tree --empty` (start empty).
2. **Add/modify** (raw bytes): write selected paths to a NUL-delimited `Buffer` pathspec file;
   `git add --pathspec-from-file=<raw-nul-file> --pathspec-file-nul` (applies the repo's clean
   filter). **Delete** (`expectedState:'absent'`): `git update-index --force-remove -z --stdin`
   fed the raw NUL-delimited `Buffer`. **Rename** = delete(old) + add(new) from `commitPathspecs`.
   **No non-UTF-8 path ever passes through Node string argv.**
3. **Read** result: parse the **complete binary** `git ls-files --stage -z` output; select
   entries by `pathBytesBase64` → `commitMode` + `commitBlobOid`. `rawBlobOid` stays WP-1B's
   `hash-object --no-filters` value.
4. **Cleanup:** unlink `<temp>` **and every pathspec/stdin temp file** in `finally`.
5. **Prove real index unchanged:** WP-2J compares the complete raw binary `ls-files --stage -z`
   snapshots of the real index before/after **byte-for-byte**. WP-3G later introduces the
   canonical JCS `indexFingerprint` for candidate identity (and may additionally reuse the raw
   snapshot check).

---

# STAGE ③ — Finalization + candidate preview from BOTH lenses (no real-index / branch mutation)

Finalize IPC is **not "read-only"** — it writes DB rows, durable refs, and temp-index/Git
objects. The honest promise is **"no real-index or branch mutation."** **Stage ③ is incomplete
until:** `plan_work_packages` exists; item validation is enabled; plan-package `done` creates a
finalization; fleet-adhoc mark-done creates a **distinct** finalization; **both Save and Plan
lenses preview the same canonical candidate.**

### WP-3A — `plan_work_packages` + item-stamping enablement
- **Files:** `src/main/database.ts` (§11 DDL + CRUD, serial slot), test
  `database.planWorkPackages.test.ts`; enable item validation in the 2B item-validity seam.
- **Dep:** 2A.
- **Do:** land the table; enable item validation across **every** dispatch boundary from Stage
  ②; **revive explicit-item override becomes valid + gets its integration test**.
- **Accept:** item validated against `(workspace_id, plan_id, id)`; orchestration explicit
  plan+item wins; revive item override valid.
- **§14:** those three.
- **Verify:** main/shared template; rerun `dispatch-binding.boundary.test.js`.

### WP-3B — `package_finalizations` DDL + accessors
- **Files:** `src/main/database.ts` (§5 DDL + indexes + CRUD, serial slot), test
  `database.finalizations.test.ts`.
- **Dep:** 3A.
- **Do:** the table + `member_manifest_json` column + lifecycle accessors, with the unique
  indexes on `(package_id, revision)` and `(plan_item_id, revision) WHERE
  finalization_kind='plan-package'`.
- **Accept:** CRUD round-trips; unique indexes enforced.
- **§14:** (schema).
- **Verify:** main/shared template.

### WP-3C — Finalization + boundary-ref service (ordering, re-finalization, restart contract)
- **Files:** `src/main/commit-candidates/finalization-service.ts` (+test),
  `src/main/git-checkpoints/finalization-refs.ts` (+test), startup reconciler hook in
  `src/main/git-checkpoints/commit-reconciler.ts`.
- **Dep:** 3B, 2J.
- **Do:** freeze `member_manifest_json` via the temp-index algorithm (raw `hash-object
  --no-filters` + clean-filtered via temp index).
  **Idempotent failure-ordered sequence:** (1) create the durable `boundary_ref`
  (`refs/lares/finalizations/<packageId>/<revision>`) at the computed boundary oid (force to the
  computed oid → idempotent); (2) in **one SQLite transaction** insert the
  `package_finalizations` row `boundary_status='ready'` **and** (plan-package) set
  `plan_work_packages.state='done'`.
  **Compensation:** a DB-txn failure after ref creation leaves an **orphan ref** (safe — no
  active row references it; the reconciler GCs it); **ref creation failure ⇒ never insert a
  `ready` row** (insert `boundary_status='unavailable'` → non-committable, surface "finalization
  incomplete"). **Plan-package `done` must never appear finalized when the boundary is
  unavailable** — the work-package state flips only inside the same txn as a `ready`
  finalization.
  **Re-finalization (retry-idempotent, mechanically defined):**
  1. Read the **latest active finalization** for the stable `package_id`.
  2. **Canonically compare** (JCS) its boundary OID **and** frozen `member_manifest_json` against
     the requested finalization.
  3. **If identical → return the existing finalization unchanged** (no revision increment, no
     supersede).
  4. **Only a differing boundary/manifest** allocates `max(package_revision)+1`, creates the new
     ref/row, and **supersedes the prior active row atomically** (`lifecycle_status='superseded'`
     + `superseded_by_finalization_id` in the same SQLite txn).
  5. This also handles a **retry after ref creation but before the SQLite txn**: revision and
     ref path are pure functions of `(package_id, boundary OID, manifest)`, so the re-run resolves
     to the same ref (idempotent force-create) and either matches an existing row (step 3, no-op)
     or completes the pending allocation exactly once.
  Ref **release** is handed to WP-3F (retention keyed on `lifecycle_status`).
  **Startup reconciliation:** delete `refs/lares/finalizations/*` with no active row; downgrade
  `ready` rows whose ref no longer resolves to `unavailable`/`pruned`.
- **Accept:** ordering holds; orphan ref GC'd; boundary-unavailable never shows done; a
  byte-identical re-finalize returns the existing finalization with no new revision/supersede; a
  changed re-finalize bumps revision + supersedes atomically; retry after ref-before-txn is
  idempotent; restart reconciles orphan refs/rows.
- **§14:** re-finalize bumps `package_revision`; supersede sets `superseded_by_finalization_id`
  (state); ordering/restart invariant.
- **Verify:** main/shared template for both tests + reconciler test.

### WP-3D — Plan-package `done` finalization wiring
- **Files:** `src/main/plans/plan-ipc.ts` (done transition → finalize call), test
  `plan-ipc.finalize.test.ts`.
- **Dep:** 3C.
- **Do:** explicit plan-item `done` transition → `finalization_kind='plan-package'` via 3C.
- **Accept:** `done` creates a `plan-package` finalization (eligibility proven in 3C + 3G
  integration).
- **§14:** plan-package `done` boundary created (match → eligible completes in **3C + 3G**).
- **Verify:** main/shared template.

### WP-3E — Fleet-adhoc mark-done finalization wiring
- **Files:** `src/main/commit-candidates/save-card-ipc.ts` (mark-done channel), test
  `save-card-ipc.finalize.test.ts`.
- **Dep:** 3C.
- **Do:** a **distinct** explicit fleet mark-done/mint step (never silent inside the commit
  mutation); always captures `boundary_ref`.
- **Accept:** fleet-adhoc mark-done creates a distinct finalization with `boundary_ref`.
- **§14:** fleet-adhoc captures `boundary_ref`.
- **Verify:** main/shared template.

### WP-3F — Retention lifecycle integration for `boundary_ref`
- **Files:** `src/main/git-checkpoints/retention.ts` +
  `src/main/git-checkpoints/protection-policy.ts` (boundary-ref set), test
  `retention.boundaryRef.test.ts`.
- **Dep:** 3B, 2K.
- **Do:** retention **only** — keep `boundary_ref` while `lifecycle_status='active'` as a
  **separate protected set that does NOT draw down the pin quota**; **release on
  `committed`/`superseded`/`abandoned`.** Does not compute revisions or set supersede columns
  (that is 3C).
- **Accept:** active ref retained; **release on committed/superseded/abandoned** all tested.
- **§14:** retention releases ref on committed/superseded/abandoned.
- **Verify:** main/shared template.

### WP-3G — Canonical candidate assembly + verification + identity + index fingerprint
- **Files:** `src/main/commit-candidates/candidate-service.ts` (`buildSelectionPreview` /
  `buildCandidate`), `src/main/commit-candidates/index-fingerprint.ts` (+test), test
  `candidate-service.build.test.ts`.
- **Dep:** 3C, 3B, 2J, 1C.
- **Do:** component atomicity (reject `component-subset-not-allowed`); independent unattributed
  selection; coverage (`finalization-conflict` / `extraneous-finalization`);
  `PackageVerificationState` raw **and** clean-filtered (**clean half of "raw ≠ clean" lands
  here**); `.gitattributes`-changes-clean-blob → `verified-mismatch`; **`indexFingerprint`** =
  `git ls-files --stage -z` via `runGitBytes`, **reject unmerged**, JCS fingerprint, optional
  `write-tree` secondary; `candidateId = sha256(JCS(identityDoc))`. **Prior-exact-commit makes a
  remaining candidate eligible here** (closure itself is 4G); **a clean member without exact
  ledger proof → ineligible + `package-not-finalized`, finalization stays active**; **one dirty
  selected member + another prior exact-committed member → eligible.**
- **Accept:** all listed verdicts + identity.
- **§14:** subset rejected; combine-only-when-named; spanning two packages carries both refs +
  full `coveringFinalizationIds`; disagreeing manifests → conflict; `extraneous-finalization`;
  identity ∆ with coverage; raw ≠ clean (clean half); `.gitattributes` → `verified-mismatch`;
  unfinalized = `SelectionPreview`; clean-member-without-proof → ineligible/active; one-dirty +
  one-prior → eligible.
- **Verify:** main/shared template for both tests.

### WP-3H — Save-lens preview IPC/UI
- **Files:** `src/main/commit-candidates/save-card-ipc.ts` (preview channel),
  `src/renderer/components/save/SaveCard.tsx` + `CandidatePreview.tsx`
  (+`CandidatePreview.test.tsx`).
- **Dep:** 3G.
- **Do:** mark-done "save" affordance; preview pane (per-member verdicts, overlap/unattributed
  ack checkboxes). **Message body user-editable; `Lares-*` trailers render as read-only server
  previews** from the immutable snapshot; any user trailers live in a **separately-validated
  namespace** and may **never** override `Lares-*`. Ineligible/degraded work stays visible +
  previewable, never one-click.
- **Accept:** renders verdicts; message editable; `Lares-*` read-only; no one-click for
  mismatch/degraded/unfinalized.
- **§14:** (Save-lens preview).
- **Verify:** renderer Vitest template.

### WP-3I — Plan-lens preview integration
- **Files:** `src/renderer/components/plan/PlanSurfaceContainer.tsx` + `PlanSurfaceView.tsx`,
  `src/main/plans/plan-ipc.ts` (plan-lens preview channel), reuse the shared
  `src/renderer/components/save/CandidatePreview.tsx`; test `PlanSurfaceView.candidate.test.tsx`.
- **Dep:** 3G, 3H.
- **Do:** the plan lens **filters/annotates** components (D-1) — never carves a sub-candidate
  out of a component that connects to other plans; reuse the shared preview UI (no topology
  recompute).
- **Accept:** **identical `candidateId` + member verdicts across both lenses**; message editable,
  `Lares-*` read-only; plan lens never splits a cross-plan component.
- **§14:** identical `candidateId` across both lenses.
- **Verify:** renderer Vitest template.

### WP-3Z — Stage ③ main-test registration + gate
- **Files:** `scripts/run-main-tests.mjs`.
- **Dep:** all Stage ③ main/shared test producers (3A, 3B, 3C, 3D, 3E, 3F, 3G).
- **Do:** register each new compiled main/shared test path; run the full main suite.
- **Accept:** `npm run test:supervisor` includes and passes every Stage ③ main/shared test.
- **Verify:** `npm run build:main && npm run test:supervisor`.

**Stage ③ user-visible gate:** both surfaces finalize their respective package kinds; show the
**same** candidate identity and member verdicts; show an editable message body and read-only
`Lares-*` trailers; **never** enable one-click commit for mismatch/degraded/unfinalized work;
leave the real index fingerprint unchanged.

**Stage ③ graph:** DDL serial `3A → 3B`; `3C ← 3B + 2J`; `3D ← 3C`; `3E ← 3C`; `3F ← 3B + 2K`;
`3G ← 3C + 3B + 2J + 1C`; `3H ← 3G`; `3I ← 3G + 3H`; all → `3Z`.

---

# STAGE ④ — CommitCoordinator (byte-match check + enumerated adversarial matrix)

**Non-goals:** no hunk surgery; no `checkout` / `restore` / `clean` / `reset` / `stash` in any
path (D-6); no auto-commit; no workspace-quiescence gate (the amendment removed it → replaced by
final revalidation + safe abort).

### WP-4A — User-commit Git environment mode
- **Files:** `src/main/git/git-runtime.ts` (add the `user-commit` `GitEnvMode`;
  `GitEnvMode`/`buildGitEnv` live here), `src/main/git/git-runtime.test.ts`;
  `src/main/git-checkpoints/git-command.ts` **only** for propagation through `RunGitOptions`.
- **Dep:** 1P.
- **Do:** the current `commit` mode injects `Lares Checkpoints <checkpoints@lares.local>` as
  author/committer, violating "the user is the committer." Add a `user-commit` mode to
  `buildGitEnv` that **omits** the injected author/committer (leaving resolution to the user's
  Git config) while retaining routing-variable sanitization + noninteractive behavior; thread it
  through `RunGitOptions`.
- **Accept:** the committed object carries the user's Git-configured identity; sanitization +
  noninteractive retained.
- **§14:** (user is the committer).
- **Verify:** main/shared template; sibling `git-command.test.js`.

### WP-4B — Token mint + store + compose-lock registry
- **Files:** `src/main/commit-candidates/candidate-service.ts` (mint/store),
  `src/main/commit-candidates/compose-lock-registry.ts` (+test), test
  `candidate-service.mint.test.ts`.
- **Dep:** 3G.
- **Do:** `MintCandidateTokenRequest` validation (component expansion, coverage, manifest
  agreement, `acknowledgeTopologyDigest`, unattributed acks); immutable server-held snapshot
  (consumes 3G's `indexFingerprint`); per-`repositoryKey` cap `= 128` LRU (never evict a
  `consuming` token); `ComposeLockRegistry` exclusive lock per `repositoryKey`. **Mint refusal
  while a compose lock is held → `{ eligible:false, reason:'compose-in-flight' }`, no token
  minted, inventory still renders. Pre-CAS transient failure does not consume. App-restart
  invalidates the in-memory store.**
- **Accept:** those + TTL + cap-never-`consuming`.
- **§14:** mint validates acks; TTL; cap-evict never touches `consuming`; mint refusal
  `compose-in-flight` inventory renders; pre-CAS-transient no-consume; app-restart invalidation.
- **Verify:** main/shared template for both tests.

### WP-4C — `commit_attempts` persistence
- **Files:** `src/main/database.ts` (`commit_attempts` DDL + CRUD, serial slot), test
  `database.commitAttempts.test.ts`.
- **Dep:** 0A.
- **Do:** persist a pending-attempt row before any mutation; resolve/outcome columns.
- **Accept:** pending row persisted; outcome update round-trips.
- **§14:** (attempt ledger).
- **Verify:** main/shared template.

### WP-4D — CommitCoordinator core
- **Files:** `src/main/git-checkpoints/commit-coordinator.ts` (+`commit-coordinator.test.ts`).
- **Dep:** 4A, 4B, 4C.
- **Do:** **Two named serialization seams:** (1) the **compose lock** (`ComposeLockRegistry`,
  keyed by `repositoryKey`) grants index exclusivity; (2) git worktree/index mutation runs
  through **`CheckpointQueue.withLock(objectDatabaseKey, …)`** (uninterrupted `RESTORE`-priority,
  infinite queue deadline) — commit and restore are both compound real-worktree/index mutations
  that must not interleave; the two keys are complementary, not interchangeable.
  **Ordering (reversed, §9.4-safe):**
  1. Synchronously **try-acquire the compose lock**.
  2. If unavailable → return `compose-in-flight` **before** the token CAS; token remains `issued`.
  3. CAS `issued → consuming`.
  4. If CAS fails (same-token double-click) → **release the lock immediately**.
  5. Begin asynchronous reassembly / Git work.
  Reassemble live; require identical `candidateId` / member manifest / `componentTopologyDigest`;
  **final raw + clean-filtered byte-match revalidation immediately before commit**; persist the
  pending `commit_attempts` row; run git with `GIT_REFLOG_ACTION=lares-commit:<attemptId>`; single
  `git commit --only --pathspec-from-file=<raw-nul-file> --pathspec-file-nul` (raw bytes from
  `commitPathspecs`), **user-commit env (4A)**, hooks un-bypassed (never `--no-verify`);
  **server-side message validation + transport via a temp message file**; **server-derived
  `Lares-*` trailers from the immutable snapshot — never renderer-trusted**; identify the
  attempt's commit from the HEAD reflog marker; classify `CommitOutcome` (§9.4); post-commit
  index-integrity check. **Abort-never-repair** (D-6). **Cleanup:** the coordinator owns and
  unlinks the raw-byte pathspec file and the message temp file in a `finally` on every outcome.
- **Accept:** ordering exact; revalidation before commit; outcomes classified per §9.4; temp files
  cleaned on every path.
- **§14:** two-concurrent-consume CAS; stale topology at consume; contract-version rejection;
  entire Commit-attribution + outcome block.
- **Verify:** main/shared template.

### WP-4G — Finalization closure reconciliation (in the commit response path)
- **Files:** `src/main/git-checkpoints/commit-reconciler.ts` (extend, §5.1), test
  `commit-reconciler.closure.test.ts`.
- **Dep:** 4D.
- **Do:** invoked **synchronously in the coordinator response path**, after WP-4D returns a
  committed outcome and **before the route returns any user-visible state**: verify the marked
  commit's parent/tree; persist exact `commit_records` / `commit_path_links` / `commit_turn_links`;
  evaluate closure over the ENTIRE manifest — each member resolves `selected-in-candidate` |
  `already-locally-committed` (exact ledger proof). Transition `committed` + release `boundary_ref`
  + stamp `released_at` **only when every manifest member is exact-content committed across new +
  prior commits**; a partial candidate leaves the finalization `active`; raw match alone never
  closes. Return the closure result **or an explicit reconciliation error**.
- **Accept:** partial candidate no-release; all-members (new + prior) exact → `committed`, ref
  released, `released_at` stamped; a prior exact commit **closes** the finalization when the
  remaining member lands.
- **§14:** partial no-release; all-members-close; **prior exact commit closes a finalization.**
- **Verify:** main/shared template.

### WP-4E — Coordinator IPC/preload + main-route flag enforcement (lens-agnostic)
- **Files:** `src/main/commit-candidates/commit-coordinator-ipc.ts` (+test), preload commit
  method in `src/preload/index.ts`, channel in `src/shared/types.ts`.
- **Dep:** 4D + 4G.
- **Do:** expose the consume route, **keyed by `candidateId`/token so either surface can call it —
  not a Save-only namespace.** Compose `4D → 4G → return`: the route **must not** return the
  user-visible `saved` state until 4G has (i) parent/tree-verified the marked commit, (ii)
  persisted exact links, and (iii) completed closure or returned an explicit reconciliation error.
  **Enforce `SAVE_CARD_COMMIT_COORDINATOR_ENABLED` in the main-process route — reject direct IPC
  while disabled** (renderer hiding is not a gate), read via an **injected seam**
  `isCoordinatorEnabled(): boolean` (default returns the constant; overridable in tests) so the
  disabled-route test stays runnable after WP-4K flips the production constant.
- **Accept:** route rejects direct IPC while the seam reports disabled; `saved` only reachable via
  the integrated `4D → 4G` path.
- **§14:** flag enforcement; "'saved' only after parent/tree-verify + exact links persisted +
  closure done/errored" (integration).
- **Verify:** main/shared template.

### WP-4F — Renderer post-attempt outcome states (shared component)
- **Files:** `src/renderer/components/save/CommitOutcome.tsx` (+`CommitOutcome.test.tsx`), wired
  into `SaveCard.tsx`.
- **Dep:** 4E.
- **Do:** four distinct states — **saved / stale-refused / integrity-incident /
  repository-uncertain**; "saved" only on a `committed` outcome that is verified + ledgered (via
  the 4E integrated path). Built as a **shared** component (reused by the Plan lens in 4L).
- **Accept:** each `CommitOutcome.status` renders its distinct state; "saved" only after the
  integrated path.
- **§14:** (UI outcomes).
- **Verify:** renderer Vitest template.

### WP-4L — Plan-lens commit affordance + outcome wiring (shared route + component)
- **Files:** `src/renderer/components/plan/PlanSurfaceContainer.tsx` + `PlanSurfaceView.tsx`
  (commit affordance on an eligible finalized plan-lens candidate), reuse
  `src/renderer/components/save/CommitOutcome.tsx`, plan IPC in `src/main/plans/plan-ipc.ts`
  delegating to the shared coordinator route; test `PlanSurfaceView.commit.test.tsx`.
- **Dep:** 4E, 4F.
- **Do:** the Plan lens invokes the **shared** consume route (4E) with the candidate token and
  renders the same four outcome states via the shared `CommitOutcome` component; never recomputes
  topology or forges trailers. Honors the normative two-consumer model — the Plan lens gets shared
  commit capability, not preview-only.
- **Accept:** Plan-lens commit produces identical `CommitOutcome` handling as the Save lens;
  identical `candidateId` path; no Save-only coupling.
- **§14:** two-consumer shared commit capability (Plan lens).
- **Verify:** renderer Vitest template.

### WP-4H — Adversarial: races family
- **Files:** `src/main/git-checkpoints/commit-coordinator.races.test.ts`.
- **Dep:** 4D.
- **Do:** enumerate — agent edits a selected path after preview; edits a non-selected path; HEAD
  moves after preview; index changes after preview; **an active turn begins before confirmation →
  final byte/topology revalidation + safe abort if selected bytes moved** (quiescence-removal
  replacement); restore/revert races confirmation; `index.lock` already present; **distinct-token
  consume race; same-token double-click CAS; pre-CAS transient failure does not consume;
  pre-existing staged content preserved byte-identical.**
- **Accept:** every row either commits exactly the previewed bytes or aborts cleanly with the
  worktree intact.
- **§14:** **pre-existing staged-content preserved byte-identical**; race outcomes.
- **Verify:** main/shared template.

### WP-4I — Adversarial: hooks / outcomes family
- **Files:** `src/main/git-checkpoints/commit-coordinator.hooks-outcomes.test.ts`.
- **Dep:** 4D, 4G.
- **Do:** enumerate — `pre-commit` / `commit-msg` rejects; a hook modifies selected content →
  `committed-integrity-mismatch` recorded, no rollback; a hook alters an unrelated staged entry
  though the committed tree matches → `indexIntegrity='mismatch'` integrity incident, commit
  retained; external HEAD advance during a failed attempt → `repository-state-uncertain`; marked
  commit + subsequent HEAD advance → created commit + `currentHeadDrift`; a marked commit with an
  unexpected parent or unverifiable tree → `repository-state-uncertain`, OID preserved, no exact
  links; `aborted-*` only when HEAD is unchanged and no marked commit exists; failed commit then
  successful candidate regeneration.
- **Accept:** each outcome classified per §9.4; no auto-rollback.
- **§14:** those outcome rows.
- **Verify:** main/shared template.

### WP-4J — Adversarial: path-semantics family
- **Files:** `src/main/git-checkpoints/commit-coordinator.path-semantics.test.ts`.
- **Dep:** 4D.
- **Do:** enumerate — filenames with spaces / newlines / Unicode / leading dashes;
  add/delete/rename/exec-bit/symlink/submodule/CRLF/untracked; transitive overlap (A–B, B–C);
  empty witness sets / missing snapshots.
- **Accept:** each commits exactly the previewed bytes or aborts cleanly.
- **§14:** path-semantics under commit.
- **Verify:** main/shared template.

### WP-4K — Enablement gate
- **Files:** `src/shared/constants.ts` (flip `SAVE_CARD_COMMIT_COORDINATOR_ENABLED` → `true`),
  test `commit-coordinator.enablement.test.ts`.
- **Dep:** **4H + 4I + 4J all green.**
- **Do:** flip the constant **only after** all three adversarial families pass; keep the
  disabled-behavior test green by driving the injected `isCoordinatorEnabled()` seam to `false`
  (not by depending on the constant's value). **Test proves direct IPC invocation is rejected
  while disabled.**
- **Accept:** flag flips only with a green matrix; disabled-route rejection proven via the seam,
  valid post-flip.
- **§14:** (gate).
- **Verify:** full Stage ④ suite green, then `npm run build`.

### WP-4M — Stage ④ main-test registration + gate
- **Files:** `scripts/run-main-tests.mjs`.
- **Dep:** all Stage ④ main/shared test producers (4A, 4B, 4C, 4D, 4G, 4E, 4H, 4I, 4J, 4K).
- **Do:** register each new compiled main/shared test path; run the full main suite.
- **Accept:** `npm run test:supervisor` includes and passes every Stage ④ main/shared test.
- **Verify:** `npm run build:main && npm run test:supervisor`.

**Stage ④ user-visible acceptance:** the user sees exactly one of **saved / stale-refused /
integrity-incident / repository-uncertain**; **"saved" appears only after the marked commit is
parent/tree-verified and ledgered**; a finalization/package shows complete **only when its entire
manifest has exact commit proof**.

**Stage ④ graph:** `4A ∥ 3G`; `4B ← 3G`; `4C`; `4D ← 4A + 4B + 4C`; `4G ← 4D`; `4E ← 4D + 4G`;
`4F ← 4E`; `4L ← 4E + 4F`; `{4H, 4I, 4J} ← 4D` (4I also ← 4G); `4K ← 4H + 4I + 4J`; all → `4M`.

---

## Global dependency graph — logical vs file-contention

```
0A ─► ①: {1A,1P,1C}; 1A+1P→1B; 1A+1B→1E; 1A+1B→1W; 1A+1B+1E→1F; 1B+1W+1C→1D;
         1D+1E+1F→1G→1H→1I; all→1Z
    ─► ②: DDL-serial[2A→2G-DDL→binding-cols]; 2A→2B→(2C∥2D∥2E∥2F); 2A→2I; 2J→2G;
         2H pure; 2G+2H+1B→2K; 2K+1G/1H/1I→2L; all→2Z
    ─► ③: DDL-serial[3A→3B]; 3C←3B+2J; 3D←3C; 3E←3C; 3F←3B+2K; 3G←3C+3B+2J+1C;
         3H←3G; 3I←3G+3H; all→3Z
    ─► ④: 4A∥3G; 4B←3G; 4C; 4D←4A+4B+4C; 4G←4D; 4E←4D+4G; 4F←4E; 4L←4E+4F;
         {4H,4I,4J}←4D; 4K←4H+4I+4J; all→4M
```

Stages are sequential (each consumes the prior's durable shape). **Every `database.ts` DDL edit
is serialized**; disjoint-file consumers parallelize. Each stage's terminal registration/gate WP
(1Z/2Z/3Z/4Z-as-4M) owns `scripts/run-main-tests.mjs` so parallel WPs never contend on it.
`withLock`/compose-lock keys are distinct and complementary.

---

## Row-level §14 ownership ledger (case → first package that can pass it)

| §14 case | First package · Stage |
|---|---|
| Direct human send → `agent-default`, owner null, no item | 2C · ② |
| Orchestration explicit **plan-only** wins over default | 2D · ② |
| Orchestration no-explicit → worker default, no item | 2D · ② |
| Orchestration **follow-up** reuses run-frozen binding | 2D · ② |
| Orchestration explicit **plan+item** wins | 3A · ③ |
| API explicit valid → carried | 2C · ② |
| Cross-workspace explicit → reject 400, no fallback | 2C · ② |
| Explicit item w/o or mismatched plan → reject | 2C (plan-less) / 3A (item-valid) · ②/③ |
| Explicit `none` vs omitted distinguished every path | 2B · ② |
| `pendingInitialPrompts` retains metadata through delivery | 2E · ② |
| Fork → `fork-carry` + explicit clear, never latest turn | 2E · ② |
| Revive → `revive-carry` + plan/none (item rejected) | 2E · ② |
| Revive explicit **item override** valid | 3A · ③ |
| Continuation freeze pre-teardown; **restart** reads frozen cols | 2F · ② |
| Manual-terminal raw typing = unattributed inventory | 2F · ② |
| Invalid explicit rejected BEFORE delivery (no PTY/turn row) | 2C · ② |
| Overlap re-open uses NEW dispatch stamp | 2B · ② |
| Deleting an agent preserves stamps | 2A · ② |
| accessor + enum + trigger block mutation incl. `plan_stamp_source` | 2A · ② |
| Non-null `plan_item_id` rejected until table / accepted after | 2A (reject) / 3A (accept) · ②/③ |
| Legacy rows read `legacy-unstamped`; never allocation-written | 2A · ② |
| Wire `RequestedPlanBinding` cannot forge `*-carry` | 2B · ② |
| **Same worktree multi-workspace ⇒ ONE component graph** | **1G integration** · ① |
| Same worktree ⇒ ONE **latch** | 4B · ④ |
| Linked worktree ⇒ distinct latch, shared object-db serialization | 4B + queue integration test · ④ |
| `repositoryKey` from real index path; bare rejected; absent-index handled | 1A · ① |
| **Mixed-plan transitive stays ONE component** | **2I** · ② |
| Mixed-plan candidate identical across **both lenses** | 3I · ③ |
| `topologyDigest` stable / change / inert / distinguish | 1D · ① |
| Rename/copy/deletion/symlink/gitlink/untracked/ignored/unmerged/submodule/non-UTF-8 (**raw**) | 1B · ① |
| Raw ≠ clean-filtered hash surfaced (**clean**) | 3G · ③ |
| Proper-subset rejected; combine only when named; unattributed independent / no-fuse | 1D / 3G · ①/③ |
| Spanning two packages carries both refs + full `coveringFinalizationIds` | 3G · ③ |
| Disagreeing manifests → `finalization-conflict`; `extraneous-finalization`; identity ∆ with coverage | 3G · ③ |
| **Plan-package `done` → match → eligible** | **3C + 3G integration** · ③ |
| Fleet-adhoc mark-done captures `boundary_ref` | 3E · ③ |
| **`.gitattributes` → `verified-mismatch`** | **3G** · ③ |
| Unfinalized selection = `SelectionPreview`(`package-not-finalized`) | 3G · ③ |
| **Clean manifest member w/o exact ledger proof → ineligible, finalization active** | **3G** · ③ |
| **One dirty selected + another prior exact-committed → eligible** | **3G** · ③ |
| **Prior exact commit closes a finalization** | **4G** · ④ |
| Partial candidate no release; **all members (new+prior) exact → `committed`, ref released** | 4G · ④ |
| Re-finalize bumps revision; supersede sets `superseded_by_finalization_id` (state) | 3C · ③ |
| Retention releases ref on committed/superseded/abandoned | 3F · ③ |
| Retention weakening-warning surfaced (UI) | 2L · ② |
| Mint validates acks; TTL; cap-evict never `consuming`; mint refusal `compose-in-flight` inventory renders; **pre-CAS transient no-consume**; **app-restart invalidation** | 4B · ④ |
| Two concurrent consumes CAS; stale topology at consume; contract-version rejection | 4D · ④ |
| **Pre-existing staged-content preserved byte-identical** | **4H (coordinator adversarial)** · ④ |
| External-HEAD-advance → uncertain; marked+drift; unexpected-parent/unverifiable-tree → uncertain OID-preserved no-links; hook-mutates-tree → `committed-integrity-mismatch` no-rollback; unrelated-staged-mismatch → integrity incident; `aborted-*` only HEAD-unchanged+no-marked | 4I · ④ |
| `'saved'` only after parent/tree-verify + exact links persisted + closure done/errored | 4E integration · ④ |
| Two-consumer shared commit capability (Plan lens) | 4L · ④ |
| Rung per exact `{path,state,blob,mode}` incl. deletion (checkpoint/unprotected) | 1F · ① |
| `locally-committed` requires frozen clean-filtered entry; `pushed_remote_count` a hint | 2G (via 2J) · ② |
| Real index preserved via raw byte-snapshot (temp-index isolation) | 2J · ② |
| Canonical JCS `indexFingerprint` for candidate identity | 3G · ③ |
| `captureOutage` only classified; `after_ready` overridden by live rev-parse; `pathsWithoutFinalizationEdge` exact-bytes | 1E · ① |
| Path-semantics under commit (spaces/newlines/unicode/dashes; add/del/rename/exec/symlink/submodule/CRLF/untracked; transitive overlap; empty-witness) | 4J · ④ |
| Every adversarial §5.2 row enumerated; enablement gate | 4H/4I/4J → 4K · ④ |

---

<!-- groupthink: save-card implementation plan, Lead Planner × Reviewer, 8 rounds, approved 2026-07-30 -->


<!-- groupthink_run: 6d5bb4b0 (mode=serial) -->
