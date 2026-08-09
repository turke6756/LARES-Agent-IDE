---
name: prove-the-production-entry-point
description: >-
  You're finishing or gating a work package that adds a service, IPC handler, route, job, or any unit of behavior with its own test file, and those tests pass — and you're about to call it complete. Also fires when a renderer/unit test supplies a token, handle, or client that production would itself have to create.
---
A package can be **complete, test-green, and gate-passed while production cannot reach it at all.** This is invisible at completion time, because every signal a package normally emits is green: the code exists, the tests pass, the gate reads real code and real tests. Nothing in that set asks *"can the app get here?"*

It has happened twice in one subsystem (Lares save-card).

**1. Mint (2026-08-05).** `CommitCandidateService.mintCandidateToken` was fully built and unit-tested by `candidate-service.mint.test.ts`. Production's `buildCandidate` always returned `token: null` — the mint step was never wired into a route, and `mintCandidateToken` was dead code. Renderer tests **mocked tokens in**, so the renderer suite proved a flow that could not occur. The live failure was a user-visible "did not produce a committable candidate" on a byte-verified 15-file package. The root-cause review's own words: *"no test drives the whole production chain through real route registration, real token minting, and real coordinator consumption. Unit suites validate each island while mocks conceal the dead bridge."*

**2. Save sweep (2026-08-07, WP-6 `e52ad5fb`).** Added `save-sweep-service.ts` (316 lines) and `save-sweep-service.test.ts` (512 lines, 12 tests). Every test opened with `new SaveSweepService({ ... })` — direct construction with injected dependencies. The commit touched no `ipcMain.handle`, no preload binding, no `src/main/index.ts` registration. It passed its tests **and an initial supervisor gate.** It was dead code. The next package (WP-7) stopped because it could not find the seam; WP-6b `b4617499` then added `ipc-handlers.ts`, `index.ts`, and `preload/index.ts`.

**What separates a live package from a dead one is a single property: does any test obtain the unit the way production obtains it?** In both incidents, every test constructed the unit directly. *Direct construction can never fail from a missing registration* — which is exactly why it stays green while the feature is inert.

## When you finish or gate such a package

- **Name the production entry point explicitly** and say it in your summary — IPC channel, preload binding, HTTP route, UI caller, job registration. Ask: *which line of shipping code calls this?* If the only honest answer is "the test does," it is dead.
- **Write one test that enters through that seam, not through the constructor.** WP-6b's fix is the shape to copy: load the real `registerIpcHandlers` with a fake `ipcMain` that captures registrations, assert the channel *was registered*, then invoke the captured handler:
  `assert.ok(handler, 'the production registerIpcHandlers path must register savecard:sweep')`
  That one line fails on precisely the defect twelve direct-construction tests could not see.
- **Distrust mocks at the bridge you are building.** A mock of the seam under construction silently converts "unreachable" into "passing." If a test hands the code a token, handle, session, or client that production would have to mint or register, that test is asserting your bug away.
- **Run the app-owned `prove_reachability` command** for the package's declared v2 reachability obligations. Inspect every entry-seam link and production construct independently; a baseline that does not pass, an inapplicable/stale mutation, a protected-test mutation, or a mutated run without the declared failure marker is not proof.
- **Gating: a `FAIL` verdict or missing evidence outranks green tests, a real code read, and the worker's summary.** Do not call the package complete until every declared obligation has current passing evidence. The command records evidence for the candidate tree; the future completion executor is what makes that evidence mechanically completion-blocking.
- **Know the weak variant.** Asserting the bridge as *source text* — this repo's `save-card-surface.test.ts` asserts the literal string `'sweep: (req) => ipcRenderer.invoke(SAVE_SWEEP_CHANNEL, req)'` — catches deletion but only proves the line exists, not that it works. Better than nothing; not a reachability test.
- **Worker report (required):** final messages name every entry seam (`symbol` + `path`), every production-created resource, the entering test for each obligation, each obligation's revert-refutation status (`passed` or `not run — reason`), and every unperformed check.
- **If you are the worker and the seam is out of your file scope, stop and say so** rather than shipping a service with no caller. WP-7 stopping is what surfaced incident 2; that stop was correct behavior, not a failure.

## Corroboration and its limits

An independent audit of this workspace's planning surface (`.lares/research/inbox/planning-surface-audit-report.md`) reached the same conclusion from different evidence: finding **F1**, its top-ranked silent failure, and *"make production reachability a mandatory package and gate field"* is its #1 recommendation of nine.

Where this lesson's evidence is better than the audit's: the audit saw only incident 2 (WP-6/WP-6b) and scored it from git plus gate transcripts. The mint incident is first-hand here, and it is the stronger case — there the mocks did not merely fail to catch the gap, they **actively simulated the missing bridge**, so the renderer suite was evidence *for* a flow that did not exist. A reachability rule that only inspects whether a registration exists would have caught incident 2; catching incident 1 also requires distrusting mocks at the seam.
