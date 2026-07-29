# Worker Behavioral Memory

Shared, durable notes for **every** Claude worker that launches in this
workspace. For *behavioral* lessons only — "when X happens, do Y" — the kind of
working habit that helps any worker on any task. Consulted on situation-match,
not loaded as a wall of rules.

**Rules:**

- **Behavioral, not project.** Never record task state, plans, findings, or file
  paths for a specific job, or anything workspace/project-specific. This folder
  is shared by all workers; project detail here is noise — or worse, misleading —
  for the next unrelated worker. Task state lives in your prompt and the
  workspace, not here.
- **Append, don't rewrite.** Add a new entry; don't edit or delete existing ones.
  Each entry stands alone with its own `WB-NN` id.
- **Keep it short.** Trigger + action + a one-line source. If an entry needs three
  paragraphs, it's probably too project-specific to belong here.
- **Promote the universal ones.** A lesson that applies to workers in *every*
  workspace (not just this one) belongs in the `WORKER_CLAUDE_MD` constant in
  `src/shared/constants.ts` — flag it for your supervisor to promote.

---

## WB-01: A tidy theory that a symptom contradicts → say so; don't claim an unproven cause

**Trigger:** You're diagnosing an intermittent or already-resolved bug, you have a
clean root-cause story, and a reported symptom (or a code read) contradicts it —
something your theory cannot mechanically produce.

**Action:** Treat the contradiction as evidence, not noise. Trace the mechanism in
code before asserting it; if you cannot construct a concrete path from code to
symptom, say "I can't explain this yet" rather than stretching one theory to cover
everything. Separate proven-from-code from plausible-hypothesis from
can't-yet-explain. When a bug self-healed and isn't reproducible, the deliverable
is the minimal instrumentation to catch it next time — not a fix against an
unproven cause.

**Source:** 2026-06-12 input-lockout investigation — worker declined to unify a
space-only terminal symptom with a global-lockout theory it could not mechanically
support, and said so. User: "commendable… not going down some unproven path just to
say you did it." Mirror of supervisor behavioral.md B-18.

## WB-02: On a continuation/reconcile task, establish ground truth by building before trusting the prompt's claim about file state

**Trigger:** You inherit a "previous worker ran out of context mid-edit; expect a
non-compiling / half-applied file — finish it" handoff.

**Action:** Reconcile from disk first, then run the actual build/compile before
assuming breakage. The hand-off's description of where the prior worker stopped is
a hint, not fact — they may have left the slice coherent (or broken somewhere else).
A green build immediately tells you the real remaining surface is behavior/tests,
not getting it to compile, and stops you from "rewriting" work that was already
done. Read each named file fully to catch latent logic bugs the compiler can't (e.g.
resolving a rule from the wrong URL), but let the toolchain — not the prose — define
"is it broken."

**Source:** 2026-06-22 signed-in-tabs continuation — prompt warned of a
non-compiling browser-manager mid-edit; `npm run build:main` was already green, so
the job was finishing tests + fixing one cross-origin classify bug, not repair.

## WB-03: Run the whole sibling suite, not just the files your prompt names — a global/shared-DOM change breaks neighbors

**Trigger:** Your task names a few specific test files to finish/green, and your
change (or the prior worker's) adds something to a SHARED surface — a new
control in the same pane, a new global, a new event subscription.

**Action:** After the named suites pass, run the whole sibling directory too
(e.g. the full component/stores folder), not just the listed files. A pre-existing
test that scans broadly (a pane-wide `role="radio"` / querySelectorAll, a global
spy, a shared store) can silently break when a new element lands next to it. The
faithful fix is usually to SCOPE the old test (query within the labelled
subtree) rather than loosen the new code. The narrow run will look green and hide
the regression.

**Source:** 2026-06-22 signed-in-tabs WI-5 — the 4 named suites passed, but the
full renderer browser run caught `WebsiteAccessSettings.discard.test.tsx` failing
because a new WI-8 "Sign-in hold timeout" radiogroup got swept up by its
pane-wide `role="radio"` query; scoping the query to the discard radiogroup fixed it.

## WB-04: Re-derive inherited computed values; calibrate your derivation against a known-good fixture first

**Trigger:** A handoff prompt (or predecessor's notes) hands you a precomputed
value — a hash, a version number, a line count, an ID — to be used in a
load-bearing edit.

**Action:** Re-derive it yourself before use; never paste it in on trust. And
before trusting your OWN derivation, validate the pipeline by reproducing a
value that is already recorded and known-good (e.g. hash an older fixture and
match it to its shipped constant). If your pipeline reproduces the known value
but not the inherited one, the inherited value is wrong — say so and use yours.

**Source:** 2026-07-02 context-brick Inc 1 continuation — predecessor's
precomputed content hash was wrong; re-derivation (validated by reproducing an
older shipped hash exactly) caught it before it shipped into a silent-upgrade
migration that would have .bak'd every pristine workspace instead of upgrading.

## WB-05: Coding against a not-yet-merged parallel contract → mirror it locally with a null-tolerant accessor, not a wait

**Trigger:** You must call names (API methods, payload fields) that a *parallel*
worker owns in files you're forbidden to touch, and those names don't exist yet
at your build time.

**Action:** Don't block or hand-wave. Mirror the contract in a file you own and
reach it through a null-tolerant accessor that structurally probes `window.api`
(cast via `unknown`), returning null until the other side merges — the caller
renders an inert/degraded control instead of crashing. Read absent payload
fields through a tolerant cast (`(x as { f?: T }).f ?? default`) so the same
source compiles both before and after the field lands. Your build stays green
regardless of merge order, and the wiring goes live automatically once the
counterpart merges. State in the handoff whether you compiled against the real
counterpart or the mirror.

**Source:** 2026-07-05 continuation split-button — preload lacked
`setContinuationEnabled` / `forceContinuationHandoff` and Agent lacked
`continuationEnabled`; mirrored the existing `getBrowserApi()` pattern in
stores/browser-store.ts so build:renderer + tsc stayed clean against the
contract alone.

## WB-06: Inheriting a giant multi-module integration you can't finish in one context — land the fully-determined seams first, hand off the coupled remainder

**Trigger:** A handoff hands you a large end-to-end wiring task (compose N modules
into a live pipeline) that plainly exceeds one context, AND part of it is a set of
self-contained, fully-specified leaf pieces (a deterministic composer, DB query
helpers with an exact schema + type contract) while the rest is a tightly-coupled
assembly depending on live/impure state (a workspace scan, registered agents).

**Action:** Land the leaf pieces first and prove them — for DB helpers, unit-test the
SQL against the REAL schema (a build/tsc pass can't catch a wrong column name; a
sql.js+initDatabase stand-in can). Then STOP and hand off the coupled remainder with
the exact contract, rather than starting the big module and leaving it half-compiling
(which the next worker must first untangle before trusting the toolchain — cf. WB-02).
A green, tested slice that the remainder will directly consume beats a larger
incoherent one. Verify the load-bearing acceptance mechanic BEFORE coding against it,
and if it turns on a subtle precondition (e.g. "the candidate must still be resident
on disk, not already trimmed"), confirm that precondition holds in the real source and
state it plainly in the handoff.

## WB-07: A real-corpus acceptance whose spec-expected findings don't appear → trace to the exact gate and assert the true behavior; report the divergence, don't fabricate or weaken

**Trigger:** You're writing an env-gated acceptance test against live data and the
prompt's expected result (a specific proposal, a named rediscovery) does NOT surface
when you run it.

**Action:** Before touching the assertion, instrument the pipeline end-to-end to find
the EXACT reason (a sibling workstream already applied the fix; a guard/gate
downgraded it; the data is cross-workspace; the input compiles to `unmatchable`).
Then assert what is actually TRUE-and-CORRECT over the current code+corpus, and
surface the divergence loudly (console + summary) with the query/paths that prove it.
That is NOT "weakening to pass" — weakening is lowering a threshold to hide a real
defect; this is correcting a stale expectation with evidence. Prefer shape assertions
(`>0`, `exec≥skill`, `==0`) over magic counts so the gated test survives corpus drift.

**Source:** 2026-07-06 context-optimizer WP6 task D — the spec expected notebooks/teams
toolset SUBTRACTs + a read-comments tune proposal; the real run showed (i) QW1 already
dropped those grants, (ii) the Notebook doc section is `unmatchable`, (iii) read-comments
execs are cross-workspace → G6 basename-only watch, not a proposal. Asserted the real
mechanic (git-dated `never` dead-guidance SUBTRACT; 0 notebook/team usage; file-heat +
basename-only watch) and reported the three findings as G3 evidence.

**Source:** 2026-07-06 context-optimizer WP6 acceptance leg — landed the production
birthday-resolver composer + the SEAM #9 file-coverage/bypass query readers (unit-
tested against the real better-sqlite3 DDL, green) and handed off the per-lane
RawLaneInputs assembly (needs runOverheadScan live state) with the verified 4a finding
that the SUBTRACT candidates are currently-resident open-epoch sections, git-dated by
the backfill — NOT the (non-existent) closed-epoch→proposal path.

## WB-08: Multi-line git commit messages via the Bash tool — use `-F <file>`, never the PowerShell `@'...'@` here-string

**Trigger:** You're on Windows and reach for a multi-line `git commit -m` in the
**Bash** tool, and are tempted to wrap the message in the PowerShell here-string
`@'...'@` (which the PowerShell tool's docs advertise).

**Action:** Remember the Bash tool is Git Bash (POSIX sh), NOT PowerShell —
`@'...'@` is not bash syntax there. Bash parses `-m @'...'@` as `@` + a
single-quoted string + a trailing `@`, silently injecting a literal `@` as the
subject's first char and another at the body's end. Instead write the message to
a file and `git commit -F <file>` (or a real bash heredoc). If it already landed,
`git commit --amend -F <file>` fixes it cleanly (safe pre-push). Verify the
subject with `git log -1 --format=%s` before moving on.

**Source:** 2026-07-13 D4 ownership continuation — first checkpoint commit went in
with a `@ `-prefixed subject and trailing `@`; caught by inspecting the message
and fixed with `--amend -F`.

## WB-09: A handoff's claim that coverage is MISSING is a hint too — search by capability, not by the filename the prompt names

**Trigger:** A continuation prompt tells you to add missing coverage/behavior and
names the file to extend ("the predecessor had not yet written X — extend `foo.test`").

**Action:** Before writing, search for the *capability* across the tree, not just
the named file — the predecessor may have landed it under a sibling/adjacent
filename (`foo.pdf.test` next to `foo.test`). Run it and read it. Following the
instruction literally would duplicate a complete, green trunk and create two
divergent suites over one surface. If it already exists, say so in the summary and
redirect the leg to the coverage that is *actually* absent. This is the absence-side
mirror of WB-02: the handoff's account of what is missing is as much a hint as its
account of what is broken.

**Source:** 2026-07-14 PDF dual-viewer Phase 3 continuation — prompt said the
persistence + send coverage was unwritten and to extend the base test file; a
capability grep found it already complete (7 green tests) in a `*.pdf.test.ts`
sibling. The real gap was an untested hook the prompt never mentioned.

## WB-10: A new test that passes on its first run is unproven — mutate the code to make it fail before trusting it

**Trigger:** You write tests for existing (already-working) code and they go green
immediately, so you never observe them fail.

**Action:** Don't bank a green you haven't earned. Temporarily break the specific
behavior each load-bearing test targets (defeat the guard, zero the radius), confirm
the intended test — and ideally *only* that test — fails, then restore from a
byte-compared backup and re-run green. A test written against working code can
assert nothing (wrong mock reached, effect never ran) and still pass forever. One
mutant per invariant also proves the suite is isolated rather than over-coupled.
Never use the VCS to revert the mutation on a dirty shared tree; copy the file
aside and `diff` the restore.

**Source:** 2026-07-14 PDF Phase 3 — 15 hook tests passed first try; mutating the
stale-token guard and the page-warm radius proved each was caught by exactly one
test (14 others stayed green), turning "probably fine" into evidence.

## WB-11: On Windows, `sed -i` rewrites the whole file to LF — use it for scratch edits only, and restore from a byte copy

**Trigger:** You reach for `sed -i` in the Bash tool to make a quick in-place
edit to a source file — typically a WB-10 mutation you intend to revert.

**Action:** Remember Git Bash's `sed -i` writes LF endings, so a CRLF working
copy comes back with EVERY line changed. `git diff` may still look clean (with
`core.autocrlf=true` git normalizes), but the file on disk no longer matches its
neighbours, and a plain `diff` against your backup reports the entire file. Copy
the file aside FIRST and restore with `cp backup original` (not another `sed`),
then verify with `diff --strip-trailing-cr` for content and `file` for the
endings. Prefer the Edit tool over `sed -i` for anything you intend to keep.

**Source:** 2026-07-19 chat-pane dashboard-event task — two mutation/restore
`sed -i` round-trips left ChatPane.tsx fully LF-converted; caught because the
post-restore `diff` against the pre-mutation copy reported 949 changed lines.

## WB-12: A safety/invariant test is only as good as its fixture — build the fixture from the real artifact, not from imagination

**Trigger:** You're writing or extending a test that asserts an ABSENCE ("no X ever
reaches the output") — redaction, sanitization, escaping, leak guards.

**Action:** Before trusting it, enumerate the real vectors out of a real output
artifact (grep it, group the hits by field path) and seed EVERY distinct shape into
the fixture. A fixture built from what you imagined the data looks like will pass
forever while the real vector walks straight through: an absence-assertion over a
fixture that never contained the thing is green by construction. Then WB-10 it —
mutate the fix and watch the assertion fail. Also check that a NEW filter/drop you
add doesn't quietly retire an OLD vector from the fixture (an id that now gets
dropped is no longer proving that it gets redacted) — if it does, re-seed that vector
somewhere the new filter cannot reach.

**Source:** 2026-07-20 analytics snapshot exporter — the redaction fixture used
`streamIds: ['s']` and `contextSamples: []`, so 633 real username occurrences shipped
in published artifacts under a caveat that promised zero. Rebuilding the fixture from
the leaked artifact's own field paths caught it; a new foreign-id drop then had to be
kept away from the pre-existing UNC vector to avoid disarming that older guard.

## WB-13: A spec that names ONE call site for a path/resolution fix is naming a sample, not an inventory — grep the capability, and let the real artifact prove it

**Trigger:** Your task says "fix the packaged path at `<file>:<line>`" (or any
single-site resolution/env/config fix) and gives you exact code to paste there.

**Action:** Apply it, then grep the whole tree for the *thing being resolved*
before declaring done — a second consumer resolving the same asset by its own
relative walk is the normal case, not the exception, and it fails identically.
Then run the real built artifact and read its startup log: an end-to-end smoke
that exercises the shipped layout finds the sites a source read and a green
compile both miss. Prefer collapsing the duplicated resolution into one shared
helper so the next such fix has exactly one site. Report the extra site as a
spec-vs-reality mismatch rather than silently widening scope.

**Source:** 2026-07-20 Windows packaging Phase 1/2 — the plan named one
`native/lares-native` require; the packaged launch smoke surfaced a second one in
the supervisor's ownership store still resolving into `app.asar`. A shared
`getLaresNativeDir()` fixed both, and the packaged app flipped from `native=off`
to `native=on`.

## WB-14: Told "you can't run the live test" — find the sub-process shape of it that CAN'T kill you, and run that

**Trigger:** Your brief says the only sufficient verification is off-limits because
running it would terminate your own host (restart the app, launch the packaged
build, take a single-instance lock), so you're expected to ship static checks plus
a script for a human.

**Action:** Write the human script, then look for the *narrowest* executable slice
of the same evidence that runs as a short-lived side process. A helper the app
spawns is not the app: driving the shipped binary in a non-GUI mode (a `-e` probe,
its own JSON/stdio protocol, one module resolution) exercises the real artifact
without touching the running instance. Do a dry run of your own verification
script too — it will find its own bugs (a stderr redirect that throws, non-ASCII
that mangles) AND may pass real checks outright. Report exactly which legs you
proved and which still need the human; that beats "unit tests pass, please try it."

**Source:** 2026-07-20 bundled-Node packaging — restart/packaged launch were
forbidden, but running the shipped exe as a bare runtime proved module resolution,
a live PTY sentinel, and a full MCP handshake against the real packaged build with
node hidden from PATH. Only the GUI leg was left for the human.

## WB-15: Never `git stash` to get a baseline — you are usually not the only writer of the tree

**Trigger:** You want to know whether a build/typecheck error is yours, and reach
for `git stash push` → measure → `git stash pop` to compare against a clean tree.

**Action:** Don't. A worker tree is routinely dirty with *other people's*
in-progress work (parallel workers, the human, an earlier phase left uncommitted),
and a stash/pop round-trip puts all of it through a checkout you don't control —
a conflict, a hook, or an interrupted pop can lose work that was never yours to
risk. Get the baseline non-destructively instead: `git show HEAD:<file>` into a
temp path, `git diff` the specific file, or simply filter the error list by
filename. If a foreign error blocks your build, name it and route around it — a
compiler that emits despite errors (no `noEmitOnError`) still lets you compile and
run your own module's tests.

**Source:** 2026-07-20 packaging Phase 4 — stashed a 71-entry dirty tree carrying
another worker's live supervisor refactor just to count baseline tsc errors. It
popped cleanly, but the information was available from a filtered grep at zero
risk. The build error turned out to be the other worker's missing import.

## WB-16: A concurrent worker editing your file is a fact to report, not a bug to fix

**Trigger:** Mid-task, a shared file you also edited starts failing to compile
with errors naming symbols you never touched.

**Action:** Confirm ownership before reacting: grep the symbol (often it's
exported from a sibling and just not imported yet — a half-landed refactor), and
re-run your own typecheck filtered to your files. Then leave it alone. "Helpfully"
adding the missing import races their next write and can silently revert their
design. Verify your slice by other means — your own modules' tests, a
leaf-module compile — and state plainly in the summary that the shared file was
red on arrival and why. Your green is still provable; their file is not yours to
land.

**Source:** 2026-07-20 packaging Phase 4 — `supervisor/index.ts` went from clean
to 11 errors mid-task as another worker landed an `applyStatusTransition` /
`AgentStopReason` refactor across it and `database.ts`. Filtering the error list
proved zero errors were mine; the two new test suites compiled and ran green
regardless because they don't import that file.

## WB-17: Committing one slice out of a tree several people are writing — rebuild `HEAD + your hunks` and stage the blob; never `git apply --cached` on Windows

**Trigger:** You must commit only your own change to a shared file that also
carries other workstreams' uncommitted hunks (`git diff --cached --stat` shows
far more than you wrote), and there is no interactive `git add -p`.

**Action:** Don't stage the whole file and don't try `git apply --cached` with a
filtered patch — on a CRLF worktree with `autocrlf` the patch text is LF and the
apply fails "corrupt patch"/"does not apply" for reasons that have nothing to do
with your filtering. Instead reconstruct the intended blob in a scratch file:
take `git show HEAD:<file>`, replay ONLY your hunks onto it as literal
old→new string replacements (assert each old block matches exactly once), then
`git hash-object -w` it and `git update-index --cacheinfo 100644,<sha>,<path>`.
Verify with `git diff --cached -- <file> | grep '^@@'` before committing.
Select hunks by CONTENT (a marker string your change always contains), not by
their `@@` line numbers — offsets shift after every commit and a neighbour's
hunk sitting in the same region is easy to swallow by accident. And read git's
output as UTF-8 bytes: a naive `subprocess(text=True)` on Windows decodes with
the system codepage and silently mangles every em-dash in the file you are about
to commit.

**Source:** 2026-07-20 idle-agent lifecycle leg 2a — 4 incremental commits out of
a ~72-file dirty tree; `git apply --cached` failed outright, line-number hunk
selection nearly committed another worker's provider-resolver refactor, and a
`text=True` git read corrupted every non-ASCII char until the staging was redone.

## WB-18: A green test runner is not a green typechecker — they resolve modules differently

**Trigger:** You add a source file and its tests, the suite passes, and you are
about to commit on that evidence alone.

**Action:** Run the project's typechecker too, filtered to your own files
(`tsc --noEmit | grep <your paths>` — cf. WB-15/WB-16 on a dirty tree). A test
runner and a build tool routinely carry path aliases, JSX settings, and `paths`
mappings that the typechecker's config does NOT, so an import that resolves
perfectly at test time can be a hard type error in the real build. The failure
is invisible in the runner's output and shows up as someone else's broken build
later. Two toolchains, two configs, two greens — get both before committing.

**Source:** 2026-07-20 idle-agent lifecycle UI leg — a new module imported
`@shared/types`; the alias existed in the vite and vitest configs but not in
tsconfig.json, so 11 tests were green while `tsc --noEmit` reported TS2307 on
the same line.

## WB-19: Never bulk-normalize line endings across a file list — a repo can be mixed, and each file's ORIGINAL convention is the only correct target

**Trigger:** A file you wrote or rewrote has different line endings from its
neighbours (git warns "LF will be replaced by CRLF"), and you reach for a loop
that converts a list of touched files to the repo's "standard" ending.

**Action:** Don't assume the repo has one convention. Measure each file's
existing endings FIRST and convert only files that are genuinely mixed, back to
whatever that file already predominantly used — a file that is 100% LF is not
"wrong", it is that file's convention, and flipping it rewrites every line. On a
shared dirty tree that turns your 20-line change into a whole-file diff that
buries your edit and collides with whatever another worker is mid-write on
(cf. WB-16/WB-17). Verify after with `git diff --numstat`: if added+removed is
near the file's total line count, you converted a file you shouldn't have. Fix by
converting that file back, not by committing the churn.

**Source:** 2026-07-21 analytics MCP retirement — a "normalize to CRLF" sweep over
14 touched files flipped 5 pure-LF files (including a 6,560-line index.ts another
worker had uncommitted edits in) to CRLF. Caught by numstat showing whole-file
diffs; reverted to LF before it reached anyone.

## WB-20: "assert nothing was created" through an allocating getter is vacuous — assert the private container

**Trigger:** A spec asks you to prove a rejected operation left NO state behind,
and the class exposes a convenient `getFooState(id)` accessor.

**Action:** Check whether that accessor lazily CREATES the entry (a
get-or-insert `getState`). If it does, calling it in the test manufactures the
state you were about to prove absent, and the assertion passes no matter what
the code does. Assert the private container directly
(`(obj as unknown as {m: Map<string, unknown>}).m.has(id) === false`) BEFORE any
accessor call, then use the public getter only for the value assertions. Same
shape as any observer-with-side-effects: read the raw store first.

**Source:** 2026-07-21 continuation-handoff Slice 1 — `forceHandoff` must reject
a non-watched agent without allocating watcher state; `getAgentState` allocates,
so the spec's suggested assertion would have been green against the old
false-success code too. Mutating the gate away proved the private-map assertion
caught it (exactly 2 of 56 tests failed).

## WB-21: A byte-offset test failing by ±N bytes with a clean `git diff` → suspect autocrlf checkout conversion, and restore the INDEX convention

**Trigger:** A test that hardcodes byte offsets/lengths over a fixture fails by
exactly the fixture's line count (e.g. 2203 vs 2200 for a 3-line file), you never
touched the fixture, and `git diff` reports nothing.

**Action:** Don't assume you (or another worker) broke it — `git diff` is blind
to this class of change because `core.autocrlf=true` normalizes on diff. Run
`git ls-files --eol <fixture>`: `i/lf w/crlf` means the CHECKOUT converted a
committed-LF fixture to CRLF in the working copy (no .gitattributes guard), so
the failure is environmental and pre-existing, not anyone's edit. Fix by
rewriting the working copy back to the index's convention (LF), which keeps
`git diff` clean; the durable fix to propose is a `.gitattributes` eol rule for
the fixture. Extends WB-11 (edit-time conversion) to checkout-time conversion.

**Source:** 2026-07-21 `.lares` rename — jsonl-scanner byte-offset tests failed
694≠693/2203≠2200 mid-task; `git ls-files --eol` showed `i/lf w/crlf` on the
split-line fixture. Restoring LF fixed all 15 tests with zero diff footprint.

## WB-22: An empty tail-piped output file + a missed process-grep is not proof a background run died — the harness notification is ground truth

**Trigger:** You backgrounded a long command whose output runs through a pipe
(`… | tail -N`), the interim output file is empty, and a process listing
doesn't find it, so you conclude it died and relaunch a duplicate.

**Action:** Don't. A pipe like `tail` buffers everything until exit (empty file
= still running, not dead), and a Windows `CommandLine -match` process check
can miss the real child (wrapper shells, different image name). The harness
sends a completion notification for every tracked background task — absence of
that notification means IT IS STILL RUNNING. If you must re-run, TaskStop the
original first; otherwise you pay for two suites and risk interleaved writes.
Avoid the trap at launch: redirect to a file (`> log 2>&1`) instead of piping
through tail, so interim Reads show real progress.

**Source:** 2026-07-21 context-gauge feature — declared a 177-file main suite
"evidently died" on an empty tail-piped file + failed process grep and
relaunched it; the original completed green minutes later and the duplicate
had to be TaskStopped.

## WB-23: On a tree carrying foreign uncommitted workstreams, ARCHITECT for committability — new capability in new/clean modules, thin threading in entangled files

**Trigger:** Your WP touches many files, several of which carry other
workstreams' uncommitted edits (or are wholly untracked foreign work), and your
commit policy says "commit only what is cleanly yours."

**Action:** Decide file placement BEFORE coding, not at staging time. Run
`git status --porcelain` over every planned target first and split the design:
put the new capability's logic + its tests in NEW modules and in files that are
CLEAN at HEAD (those commit as wholly-yours diffs), and keep the edits to
entangled/untracked-foreign files down to thin threading (an import, a field, a
call) that stays worktree-only and is LISTED in the summary. This turns "almost
nothing is committable" into "the substance is committed, the glue is
declared" — and the numstat check (small adds, no whole-file churn) becomes
your staging proof.

**Source:** 2026-07-21 WP-S+WP2 context-analytics — analytics-export/ was
entirely untracked foreign work and shared/types.ts entangled; putting
guidance-sources.ts, the coverage gate, and all tests in new/clean files let
two clean commits land while eleven entangled files stayed worktree-only.

## WB-24: A guard's test must use a fixture where that guard is the ONLY mechanism producing the expected value

**Trigger:** You're testing a rule that overrides or supplements another rule (a
tie-breaker, a disagreement override, a fallback), and your fixture happens to
satisfy the base rule too.

**Action:** Before mutating (WB-10), ask: "if I deleted the guard, would another
code path still produce this expected value on this fixture?" If yes, redesign
the fixture so the guard alone determines the outcome — otherwise the test is
green under the mutation and proves nothing about the guard. State in a comment
WHY the fixture was chosen ("base rule says X; only the override yields Y").

**Source:** 2026-07-21 WP5 section-liveness — the cohort-disagreement→mixed test
first used observed+dead nodes, where the plain lattice already returns 'mixed';
refixtured to observed+insufficient (overall 'live') so removing the override
flipped exactly that test. The subsequent mutation run confirmed it.

## WB-25: Selective-staging via 3-way merge — normalize line endings first, or every line "conflicts"

**Trigger:** You're reconstructing a HEAD+your-hunks blob (partial staging on a
tree with foreign uncommitted edits) using `git merge-file` / diff against
`git show HEAD:file` on a CRLF working tree (`core.autocrlf=true`).

**Action:** `git show` emits the repo-normalized (LF) form while working files
are CRLF — a raw 3-way merge then sees *every* line as changed and drowns you
in bogus conflicts. Convert the `git show` output to the working tree's EOLs
(`sed 's/$/\r/'`) before merging, resolve the few *real* conflicts toward
HEAD + your intended hunks only, and stage with
`git hash-object -w --path=<file>` (which re-applies the clean filter) +
`git update-index --cacheinfo`. Audit with `diff --strip-trailing-cr` against
the EOL-matched HEAD copy. Also snapshot shared files *before* your first edit
— concurrent workers may keep editing them, and post-snapshot foreign edits
surface as real conflicts you must resolve toward HEAD.
(Source: edit-loss Phase 4B commit staging.)

## WB-26: Before changing when instrumentation emits, grep tests for the EMITTED strings, not just the helper's name

**Trigger:** You're gating/removing/renaming diagnostic or log output (a debug
flag, a console.warn helper, a metric line) and you grep tests for the helper
symbol to check nothing depends on it.

**Action:** Also grep for the *payload* strings the instrumentation emits (tag
names, message fragments). A test can assert on a spied `console.warn`'s
arguments without ever importing or naming the helper — a symbol-only grep
reports "no test coverage" while a content grep finds the assertion. If a test
relied on an implicit auto-arm (dev-mode flag, env var), fix it by arming the
gate explicitly in that test, not by weakening the assertion.

**Source:** 2026-07-22 edit-loss Phase 5 — flipping the DIAG gate off in dev
broke a write-ledger test that asserted the `write-ledger-pending-expired`
warn via a console spy; a grep for `diag|DIAG` in tests had found nothing.

## WB-27: A prescribed fix gated on "state X exists" — trace when X is CREATED relative to the gate before implementing literally

**Trigger:** Your brief hands you a verified diagnosis plus a fix keyed to a
state flag ("when an edit session exists, bypass the check"), and separately
demands an invariant that the same check still protects ("entry must stay
gated").

**Action:** Before coding, trace the order of operations: if the state is
created *before* the gate runs on the very path the gate must protect (e.g.
the entry click creates the session, then the check fires), the literal fix
silently disables the protection the brief says to keep. Refine the condition
to the signal that actually distinguishes the two cases (here: a *live/dirty*
draft, not mere session existence), satisfy both stated requirements, and
report the refinement as a spec correction in the summary — don't pick one
requirement over the other in silence.

**Source:** 2026-07-22 edit-loss hotfix — "session exists ⇒ never demote"
would have let raw-HTML docs into the WYSIWYG editor because the Edit click
creates the session before the sniff gate runs; gating on dirty-draft
ownership preserved both the anti-eviction invariant and the entry exclusion.

## When rebuilding is forbidden (live app holds dist/), compile tests standalone to a scratch dir

**Trigger:** The task requires running compiled-output tests (e.g. "build:main
then node dist/.../foo.test.js") but constraints forbid builds because the dev
app is running from `dist/` (or holds native bindings).

**Action:** Don't run the project build and don't skip the tests. Bundle the
test entry standalone with an in-repo transpiler (esbuild/swc:
`esbuild src/x.test.ts --bundle --platform=node --external:electron
--outfile=<scratchpad>/x.test.cjs`) and run it with node from the scratchpad —
the app's `dist/` is never touched. Pair it with `tsc -p <tsconfig> --noEmit`
for type safety, since the bundler doesn't typecheck.

**Source:** 2026-07-22 EDR-hardening P0.2 — workspace-state-dir tests normally
run via `npm run build:main`; a scratchpad esbuild bundle ran all 14 green with
the dev app still up.

## WB-28: When a guard delegates an ambiguous case to a real subprocess (git/file/network), inject a fake for it and assert via the fake — a table row backed by the real thing can be green under a broken guard

**Trigger:** You're testing a decision that, in one branch, shells out to a live
oracle (a `git rev-parse` to tell a branch from a filename, a `stat` to tell a
dir from a file, a DNS/HTTP probe) and you have a plain table row like
`['guard X', deny]` that exercises that branch against the real subprocess.

**Action:** Route the oracle through an injectable seam and write the
ambiguous-branch tests with a FAKE that resolves/rejects deterministically —
plus a spy test asserting the unconditional branches never call the oracle at
all. A table row backed by the real subprocess can pass even when the guard's
own logic is mutated away, because the subprocess independently produces the
same verdict (WB-24, applied to an external oracle rather than a sibling rule).
Mutation-test it: negate the guard's special-case and confirm the *injected*
test — not the real-subprocess row — is the one that fails.

**Source:** 2026-07-27 git-discard guard — deleting the `checkout .` special-case
left the `['git checkout .', deny]` table row green (real `git rev-parse` also
rejects `.`); only the injected-resolver spy test ("unconditional denies never
consult the resolver") caught the mutation.
