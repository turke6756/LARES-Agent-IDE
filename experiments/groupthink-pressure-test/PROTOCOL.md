# GroupThink Pressure-Test Protocol

**Audience:** agents (workers or supervisors) tasked with understanding, reproducing,
and hardening GroupThink's failure modes.
**Goal:** every session that runs this protocol either (a) confirms a known failure
mode still exists, (b) discovers it was fixed, (c) finds a NEW failure mode, or
(d) validates a recovery recipe — and **records the result in `findings.md`** so the
next agent starts smarter than you did.

You are testing the orchestration machinery, not the planners' intelligence. Use
trivial topics; the deliberation content is disposable.

---

## 0. Ground rules

1. **Append, never rewrite, `findings.md`.** One entry per scenario you ran, using
   the template at the top of that file. Evidence beats narrative: runIds, event
   rows, log paths, file mtimes.
2. **Tiers are ordered by cost.** Tier 1 is free (no tokens, no live agents). Do
   Tier 1 every time. Only go live (Tier 2) with a purpose, and only do Tier 3
   (destructive) with explicit supervisor/human approval.
3. **A failing PROBE is good news.** The sim harness pins known weaknesses as
   passing tests. If one fails, the weakness may have been fixed — verify, flip it
   to an INVARIANT, record it.
4. **Don't fix mid-test.** Reproduce → record → then (separately, if tasked)
   harden. A fix made while the test is half-run contaminates the evidence.
5. **planPath discipline:** always under `plans/` or `experiments/`, never under
   `.claude/` (permission-dialog hang — see project CLAUDE.md), and always a
   FRESH filename per run (PROBE-T2 explains why this matters).

---

## 1. Required reading (Tier 0 — ~15 min, do this first)

Read in this order. Do not skip; half the value of this protocol is calibrated
priors.

| # | File | What you learn |
|---|------|----------------|
| 1 | `src/main/orchestration/groupthink-v2.ts` | The runner: serial relay loop, parallel R1/R2/R3, waitReady / waitReceiverReady / waitTurnComplete, highwater marks, the `fs.existsSync(planPath)` termination contract |
| 2 | `src/main/orchestration/service.ts` | Run lifecycle: detach, persist, stall-vs-error classification (string matching!), boot reconcile, member cleanup, delivery_failed |
| 3 | `src/main/orchestration/types.ts` + `catalog.ts` | The DashboardClient seam (what the sim fakes), run/event schema, public params |
| 4 | `src/main/orchestration/groupthink-v2-prompts.ts` | The deliberation contract the agents are prompted with (approval gate, write-ends-the-run) |
| 5 | `.dashboard/supervisor/memory/groupthink-running-gotchas.md` | 16 numbered gotchas from real runs — the field history |
| 6 | `.dashboard/supervisor/memory/groupthink-premature-stall-no-plan-written.md` | The canonical false-stall incident + the recovery recipe you will validate in L4 |
| 7 | `src/main/orchestration/groupthink-v2.test.ts` | Existing invariants (don't re-test these) and the fake-client pattern |

**Calibration check** (answer to yourself before proceeding; if unsure, re-read):

- What single condition ends a serial run successfully? *(A file existing on disk.)*
- Why is the Reviewer launched only after the Lead's first turn? *(BUG-29 — codex/gemini
  stale-session inheritance.)*
- Why must the kickoff be a submitted message and never a launch-time systemPrompt?
  *(Gotcha #16 — the worker working-status latch only arms on a submitted prompt.)*
- What does the runner trust for turn completion — `agent.status` or the message
  stream? *(The message stream's `turnComplete`; status only for crashed/done and
  stall-clock resets.)*
- How does `service.ts` decide stalled-vs-error? *(String matching on the thrown
  message: `STALL` prefix / `Timeout` substring. Fragile — wording changes
  silently reclassify.)*

---

## 2. Failure-mode catalog (priors)

Status as of 2026-06-12. Update this table (via a findings entry, not in place)
when evidence changes a row.

| ID | Failure mode | Mode | Status | Signature | Probe / scenario |
|----|--------------|------|--------|-----------|------------------|
| F1 | R3 false stall: synthesizer emits turn-complete *analysis* before the write turn → `no_plan_written` while plan lands moments later | parallel | **OPEN — confirmed in sim** | stall event + file appears ≤ minutes later; `resume_hint: null` | PROBE-T4, L4 |
| F2 | Codex R1 turnComplete never detected → timeout stall | parallel | **UNKNOWN post-port** (was script-era; in-process reads ground truth — needs live re-test) | `Timeout waiting for Peer R1` with codex peer idle + full draft | L3 |
| F3 | Supervised claude member shows `idle` while working (systemPrompt kickoff) | both | FIXED 2026-06-08 (unified sendInput kickoff) — verify live | claude card `idle` + live PTY spinner | L1 step 4 |
| F4 | Resume re-relays pre-existing turn-completes → double turns + 409 crash | serial | FIXED (BUG-06, seedLastRelayedTsFromChat) — regression-tested | duplicate drafts in member chats after resume | existing test; L2 |
| F5 | Claude quota exhaustion looks like a stall | both | OPEN (unfixable in-runner; ops recipe) | stall at turn 1; lead chat shows "You've hit your limit" non-turnComplete | L2 checklist |
| F6 | Dashboard restart orphans running rows | both | HANDLED (boot reconcile → aborted + resumeRunId hint) — verify live | `reason: dashboard_restarted` stalled event at boot | L6 (Tier 3) |
| F7 | Double-launch race: two runs, same planPath | both | OPEN (no planPath lock) | two runs racing; each terminates on the other's write | L8 (Tier 3) |
| F8 | Stale pre-existing plan file ends the run instantly as 'complete' with the OLD file | both | **OPEN — confirmed in sim** | run "completes" in ~1 lead turn; plan mtime predates run start | PROBE-T2, L7 |
| F9 | Same-millisecond / non-monotonic message ts → turn silently dropped (`msg.ts <= hw`) | both | **OPEN — confirmed in sim** (live frequency unknown) | timeout stall while the agent's chat shows a fresh unrelayed turn | PROBE-T1 |
| F10 | Status wedged `working` + no messages → stall clock resets forever, run hangs unbounded | both | **OPEN — confirmed in sim** | run `running` for hours, no events; only abort ends it | PROBE-T3 |
| F11 | Stall/error classification by string-matching error messages | service | OPEN (fragility, not yet bitten) | a reworded error flips stalled→error, kills `resume_hint` | code-review; INVARIANT-T5 documents one edge |
| F12 | Supervisor busy → event delivery fails | service | HANDLED (durable `delivery_failed` row) — verify it's actually queryable | `delivery_failed` event row | L9 checklist |

Cross-reference: gotchas #1–#13 in the memory file are script-era and mostly FIXED;
#14/#15/#16 map to F2/F1/F3.

---

## 3. Tier 1 — Deterministic fault-injection sim (free, run every session)

The harness drives the **real runner code** (`runSerial`/`runParallel`) against a
scripted fake `DashboardClient`. No live agents, no tokens, ~3 seconds.

```bash
cd <workspace-root>
npm run build:main
node dist/main/main/orchestration/groupthink-pressure.test.js
```

Also run the invariant suites to separate "I broke it" from "it was broken":

```bash
node dist/main/main/orchestration/groupthink-v2.test.js
node dist/main/main/orchestration/orchestration-service.test.js
```

### Reading the output

- `INVARIANT-*` fails → a **regression**. Stop, investigate, record.
- `PROBE-*` fails → a known weakness may have been **fixed**. Verify the new
  behavior is intentional (check git log for the runner), flip the probe to an
  invariant asserting the new behavior, record in findings.
- All pass → the four confirmed weaknesses (F1, F8, F9, F10) are still present.
  That is itself a data point: record "still reproduces" with the date.

### The one-new-probe rule

Each session that runs Tier 1 should TRY to add **one new probe** — a hypothesis
about a failure mode not yet pinned. Source hypotheses from:

- The catalog rows marked UNKNOWN.
- Code reading: every `await` boundary in the runner is a place where reality can
  shift under it (agent dies, file appears, status flips, ts goes backward).
- The fake's hooks (`onTurn`, `onSend`, `tsFor`, `inFlight`, `frozen`) — each is a
  fault-injection axis; combinations are mostly unexplored.

Unexplored hypotheses, free to claim (design sketch in parentheses):

- **H-A `getMessages limit:1` blind spot:** an agent emits TWO turn-completes
  between polls → the first is never relayed; is "latest wins" safe for the
  approval contract? (Reveal two messages in one poll window; assert the approval
  message is the one lost.)
- **H-B resume + parallel:** `resume_hint` is null for parallel by design, but
  `start_run` with `resumeRunId` of a parallel run will still re-enter
  `runParallel` with stale `leadId`/`reviewerId` set — what happens? (Seed run
  with member ids; parallel runner ignores them and launches FRESH agents —
  orphaning the old ones? Pin it.)
- **H-C abort during launch:** abort while `waitReady` is mid-loop — are
  half-launched members cleaned up? (`cleanupMembers` only knows ids persisted so
  far.)
- **H-D turn-cap off-by-one:** serial `turn` starts at 1 on fresh launch but 0 on
  resume — does a resumed run get 10 or 11 reviewer↔lead exchanges?
- **H-E plan file vs. directory / unwritable path:** planPath's parent doesn't
  exist → lead's Write fails forever → indistinguishable from F10.

Keep probes deterministic: clamp `setTimeout`, use `realSetTimeout`/`realSleep`
for wall-clock assertions, fresh tmp planPath per case (see existing cases for
the pattern).

---

## 4. Tier 2 — Live pressure scenarios (real agents, real tokens)

**Prerequisites:** dashboard running; you know `workspaceId` and `supervisorId`
(`mcp__agent-dashboard__list_agents` or `GET /api/agents`); both providers
installed. Start runs via the `run_orchestration` MCP tool (or
`POST /api/orchestrations`).

**Cost discipline:** use this canonical cheap topic unless the scenario needs
otherwise — it converges in 1–2 turns and exercises real file paths:

> `topic: "Plan adding a --version flag that prints the package.json version to scripts/agent-jobs helper. Keep it under 20 lines of plan."`

**Observation toolkit (use for every scenario):**

| What | How |
|------|-----|
| Run state + member ids | `get_orchestration_run(runId)` / `GET /api/orchestrations/:runId` |
| Event timeline (incl. `delivery_failed`) | same — events are rows on the run |
| Member chat ground truth | `read_agent_chat` — **cross-check unfiltered** (gotcha #10) |
| Member REAL activity (don't trust status) | `read_agent_log` — spinner/braille title = still working (gotcha #16/#15) |
| Plan file truth | existence + **mtime vs. stall-event ts** — the F1 gap measurement |
| Supervisor-side event arrival | supervisor chat `[DASHBOARD EVENT]` lines |

### L1 — Serial baseline (always run first in a live session)

Defaults, cheap topic, fresh planPath. **Watch for:** (1) Reviewer launches only
after Lead's first turn-complete; (2) **the claude Lead's card shows `working`
during its first turn** (F3 fix verification — if it sits `idle` while the PTY
spins, F3 has regressed); (3) `groupthink.complete` arrives in supervisor chat;
(4) plan stamped with `<!-- groupthink_run: ... -->`; (5) members stopped (status
`done`) after completion.
**Record:** wall-clock per turn, total turns, any status flaps.

### L2 — Forced stall + resume (validates F4 fix live + the resume contract)

Serial, `turnTimeoutMs: 60000`, reviewer=codex, a meatier topic (e.g. "plan a
refactor of waitTurnComplete's stall semantics"). A 60s budget will likely
timeout on a codex review turn.
**On the stall event:** confirm `resume_hint` carries `resumeRunId`; **read the
Lead's chat first** (F5 — if you see a quota-limit message, record and stop);
then `run_orchestration` with the `resumeRunId`.
**Pass:** the resume re-attaches (no new launches), no duplicated relay content
in either chat (F4), run completes.
**Record:** stall reason, resume latency, whether highwater seeding held.

### L3 — Parallel with codex peer (F2: is the script-era stall fixed in-process?)

`mode: parallel`, leadProvider=claude, reviewerProvider=codex, cheap topic,
default timeout. The script-era runs stalled on codex R1 detection both times
tried; the in-process port reads ground-truth chat, so the hypothesis is FIXED.
**Pass:** R1 completes for both planners without a timeout.
**Record either way** — this resolves catalog row F2's UNKNOWN. If it stalls:
capture whether codex's chat shows a `turnComplete: true` draft the runner
missed (that distinguishes a reader bug from a codex bug), and check ts ordering
against F9.

### L4 — F1 false-stall hunt + grace-window sizing (run with L3 or after it)

Any parallel run that throws `no_plan_written`. **Follow the recovery recipe
from `groupthink-premature-stall-no-plan-written.md` EXACTLY** — disk first, PTY
second, never send to a working agent, poll for the file.
**The key measurement:** `(plan file mtime) − (stalled event ts)`. This number,
collected across runs, sizes the grace-window fix for F1. Even one data point is
valuable — record it.
**Also validate:** `abort_orchestration(runId)` after the file lands cleans up
members without touching the deliverable.

### L5 — Abort mid-deliberation

Serial, cheap topic. Wait for the Reviewer's first `working`, then
`abort_orchestration(runId)`.
**Pass:** run row `aborted`; both members stopped; `orchestration.groupthink.aborted`
in supervisor chat; **no further relay sends** after abort (check both chats);
no plan file.
**Record:** time from abort call to members actually stopping.

### L7 — Stale plan file, live (F8 confirmation — cheap and dramatic)

Create the planPath file BEFORE starting (`echo "STALE" > plans/gt-stale-test.md`),
then start a serial run pointing at it.
**Expected (current weakness):** run completes after ONE lead turn; the
"deliverable" is your STALE file (possibly with the run stamp appended — note
whether stampPlanMembers wrote into it); supervisor gets a `groupthink.complete`
pointing at garbage.
**Record:** exact behavior — this is the live evidence for the F8 hardening fix.
Clean up the file after.

### L9 — Delivery-failure visibility (piggyback on any scenario)

After any run, list the run's events and grep for `delivery_failed`. If the
supervisor was busy when an event fired, the row should exist with the full text.
**Record:** whether anything was silently lost (an event neither delivered nor
recorded = new failure mode).

---

## 5. Tier 3 — Destructive scenarios (supervisor/human approval REQUIRED)

These disturb shared state (the app process, racing runs). Get an explicit
go-ahead, announce in the findings entry who approved.

### L6 — Dashboard restart mid-run (F6 boot reconcile)

Start a serial run; once both members are deliberating, restart the app
(`npm run restart` — rebuild-first per project CLAUDE.md).
**Pass:** at boot, the orphaned row flips `aborted` with
`reason: dashboard_restarted`; supervisor receives the stalled event with a
`resumeRunId` hint; member agents survive; resume completes the run.
**Watch for:** the resumed run's highwater seeding (members produced turns while
the dashboard was down — are those relayed once, never, or twice?). This edge is
untested anywhere.

### L8 — Double-run race on one planPath (F7)

Start two serial runs with identical planPath (cheap topic). The first write
terminates BOTH (each runner's existsSync gate fires).
**Record:** do both mark `complete`? Do four agents get cleaned up or do two
leak? Does the second run's supervisor event point at a plan its own members
didn't write? This is the evidence for a planPath-lock fix.

---

## 6. Recording findings

Append to `experiments/groupthink-pressure-test/findings.md` using its template.
Rules:

- **One entry per scenario executed**, even (especially) "still reproduces" and
  "couldn't reproduce".
- Evidence: runId, member agent ids, event kinds + timestamps, file mtimes, log
  excerpts (ANSI-stripped), exact error messages.
- Classification: `confirmed-known` / `fixed-confirmed` / `new-failure-mode` /
  `recipe-validated` / `recipe-failed` / `inconclusive`.
- If you found a **new failure mode**: also propose the catalog row (F-next) and
  a probe sketch so the next agent can pin it in Tier 1.
- Surface the session's headline to your supervisor in your turn-end message —
  the supervisor decides what graduates into
  `.dashboard/supervisor/memory/groupthink-running-gotchas.md`. Do not edit
  supervisor memory yourself.

---

## 7. Hardening backlog (what the evidence feeds)

Ordered by (evidence strength × blast radius). When tasked with fixing, take the
top item that has confirmed evidence, fix it, and flip its probe to an invariant.

1. **F1 — grace window for `no_plan_written`** (parallel R3): after synthesizer
   turn-complete with no file, poll planPath (and/or wait for a *later*
   turn-complete) for N minutes before stalling. N comes from L4 measurements.
2. **F8 — refuse/archive a pre-existing planPath in `start_run`** (service.ts):
   cheap fix, removes a silent-garbage-deliverable mode AND mitigates F7.
3. **F10 — hard wall-clock cap in `waitTurnComplete`**: status=`working` may
   extend the stall clock, but bound total wait (e.g. 6× turnTimeoutMs) →
   stall with a distinct `working_no_output` reason instead of hanging forever.
4. **F9 — highwater tie-break**: strictly-greater ts comparison drops legitimate
   turns; compare (ts, content) or add a sequence number to the message read.
5. **F11 — structured error classification**: throw typed errors (e.g.
   `{ code: 'stall_timeout' }`) instead of string-matching messages in
   service.ts; preserves `resume_hint` against rewording.
6. **F7 — planPath uniqueness/lock** across concurrently running runs.
7. **F2 — only if L3 shows it still reproduces** in-process: instrument the
   codex chat reader path under the R1 barrier.

---

## Appendix — file map

| Artifact | Path |
|----------|------|
| This protocol | `experiments/groupthink-pressure-test/PROTOCOL.md` |
| Findings log | `experiments/groupthink-pressure-test/findings.md` |
| Tier-1 sim harness (source) | `src/main/orchestration/groupthink-pressure.test.ts` |
| Tier-1 sim harness (compiled) | `dist/main/main/orchestration/groupthink-pressure.test.js` |
| Runner under test | `src/main/orchestration/groupthink-v2.ts` |
| Service under test | `src/main/orchestration/service.ts` |
| Existing invariants | `src/main/orchestration/groupthink-v2.test.ts`, `orchestration-service.test.ts` |
| Field history | `.dashboard/supervisor/memory/groupthink-running-gotchas.md`, `groupthink-premature-stall-no-plan-written.md` |
