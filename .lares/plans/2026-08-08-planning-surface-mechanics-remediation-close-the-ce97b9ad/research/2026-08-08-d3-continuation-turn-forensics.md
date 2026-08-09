---
plan_artifact_id: plan_ce97b9ad
intent_id: int_d3f8266b
kind: research
---

# D3 continuation-turn forensics

## Verdict

**Recorder bug for these three rows, with one narrow semantic qualification.**

`overlapping-active-turn` is a valid failure classification for a genuinely new
submitted send while the prior model turn is still active. That is not what rows
1774, 1808, and 1836 show. In each case the supervisor had already transitioned
`working -> idle`; the prior turn's completion callback was only finishing its
asynchronous AFTER checkpoint. The continuation watcher is deliberately idle-gated,
so its note request was a legitimate next lifecycle turn, not concurrent work
(`src/main/supervisor/continuation-watcher.ts:371-421`).

The coordinator conflates "a prior row is still present in `openByAgent`" with "a
prior model turn is active" (`src/main/git-checkpoints/turn-coordinator.ts:203-216`).
Worse, its already-closing overlap branch removes the old agent-keyed state without
waiting for that close, opens the handoff turn as degraded, and then the old close's
unconditional `clearAgent(agentId)` removes the new turn's state
(`src/main/git-checkpoints/turn-coordinator.ts:303-320,368-380,449-453`). The handoff
turn is thereby orphaned. Its later open/crashed state is not faithful concurrency
reporting; it is a mechanically reproducible state-ownership race.

The qualification is that the recorded time intervals do overlap by 0.488-1.179
seconds. That overlap is real at the **database-row/checkpoint-close** level, but not
at the **agent-turn** level. It must not be classified as an active-turn conflict.

## Mechanical trace

1. A normal submitted message opens a turn before PTY delivery. `_deliverAndConfirm`
   builds the dispatch context and awaits `beforeCheckpoint` before writing any
   bytes (`src/main/supervisor/index.ts:8043-8073`). `beforeCheckpoint` stores the
   row in the agent-keyed `openByAgent` map and starts the completion tracker
   (`src/main/git-checkpoints/turn-coordinator.ts:219-257`).

2. `working` and `idle` status transitions feed the completion tracker. On the first
   accepted completion signal, `completeTurn` marks the state `closing`, awaits the
   AFTER capture, closes the row `accepted`, and finally clears the agent-keyed map
   entry (`src/main/supervisor/index.ts:2532-2575`; `src/main/git-checkpoints/turn-coordinator.ts:299-320`).

3. The continuation watcher only accumulates trigger ticks while the agent is idle.
   Once triggered it creates a durable attempt, then sends the note request through
   the ordinary confirmed-send rail (`src/main/supervisor/continuation-watcher.ts:371-421,523-571`;
   `src/main/supervisor/continuation-watcher-wiring.ts:105-141`). Thus the note
   request legitimately opens its own checkpoint turn.

4. In all three incidents that send arrived after the prior `working -> idle` event,
   but before the prior AFTER capture callback finished. `beforeCheckpoint` saw an
   existing map entry and called the overlap path. Because the old entry was already
   `closing`, `closePriorForOverlap` merely called `clearAgent` and returned; it did
   not await the old completion promise (`src/main/git-checkpoints/turn-coordinator.ts:368-373`).
   The new note-request row was then opened with mandated
   `failure_reason='overlapping-active-turn'`, even if its BEFORE bytes captured
   successfully (`src/main/git-checkpoints/turn-coordinator.ts:209-216,267-272`).

5. The old completion callback then closed the prior row `accepted` and called
   `clearAgent(oldAgentId)`. Because `clearAgent` deletes by agent id, not by expected
   turn id/state identity, it deleted the newly opened handoff row's in-memory
   ownership (`src/main/git-checkpoints/turn-coordinator.ts:310-320,449-453`). The DB
   ordering below proves this sequence: each target row's `started_at` precedes the
   prior row's `ended_at`. A sequential genuine-overlap close would show the reverse,
   because `beforeCheckpoint` normally awaits `closePriorForOverlap` before calling
   `openTurn` (`src/main/git-checkpoints/turn-coordinator.ts:209-225,368-380`).

6. The predecessor then saved a tool-authored brick. The brick route inserts the row
   and closes the attempt `committed` (`src/main/api-server.ts:2541-2589`). The
   watcher observes the durable brick, waits for the author to be idle, and requests
   relaunch (`src/main/supervisor/continuation-watcher.ts:588-606,678-706`). The
   relaunch route independently rechecks that the agent is not busy and that no
   input is in flight (`src/main/api-server.ts:2768-2800`). Those gates succeeded in
   all three incidents.

7. Relaunch stops the predecessor, atomically mints the successor session/advances
   the generation/closes the attempt `relaunched`, stages the continuation brick and
   automatic orientation prompt, then launches the fresh runner
   (`src/main/supervisor/index.ts:7084-7139,7148-7195`). Normally `restarting` would
   call `markInterrupted` on any open checkpoint turn
   (`src/main/supervisor/index.ts:2566-2572`). Here it could not close the handoff
   row: step 5 had already removed that row from `openByAgent`, so `terminateOpen`
   was a no-op (`src/main/git-checkpoints/turn-coordinator.ts:325-352`). No later
   completion, stop, or successor event could recover the lost association.

8. Each successor received a new-session continuation block containing the brick
   and an auto-submitted orientation-only kickoff (`src/main/supervisor/index.ts:7198-7249`;
   `src/main/supervisor/continuation-watcher.ts:235-245`). The three successor kickoff
   turns (1775, 1809, 1837) closed normally as `accepted`, with `before_ready=1`,
   `after_ready=1`, and `after_quality='idle-fallback'`. This is positive evidence
   that the handoff continued; it does not repair the orphaned predecessor turn.

9. Startup reconciliation converts dangling open rows to `crashed`, but it calls
   `listTurnRecords(workspaceId)` without a limit override
   (`src/main/git-checkpoints/turn-coordinator.ts:385-408`). That accessor defaults
   to only the newest 50 rows (`src/main/database.ts:7574-7627`). At the observed
   reconciliation instant, rows 1808 and 1836 were within that window and were both
   closed `crashed` at 2026-08-07 17:01:08.616/618Z. Row 1774 was already more than
   50 turns behind the newest row, so it was not enumerated and remains `open`.
   This is a second recorder/reconciliation bug, not a different continuation
   outcome.

## Database evidence

The database was opened only with SQLite URI `mode=ro`. Timestamps below are UTC.
All three targets belong to agent `229530a1-04f9-4781-9c8d-a92cae9b7e18` and
workspace `029b5cea-9a4a-4161-8e74-0ba8af5f3580`.

| target | prior same-agent turn | idle evidence | target start vs prior end | target terminal record | successor kickoff |
|---|---|---|---|---|---|
| 1774 | 1773, accepted | event 74963, `working -> idle`, 22:34:40 | 22:34:41.809 vs 22:34:42.297; 488 ms row overlap | still `open`; before ready, after absent, degraded/`overlapping-active-turn` | 1775, session `923979bf-...`, 22:35:43.528-22:36:26.008, accepted/ready both edges |
| 1808 | 1804, accepted | event 75064, `working -> idle`, 23:26:42 | 23:26:43.603 vs 23:26:44.173; 570 ms row overlap | `crashed` at 2026-08-07 17:01:08.616; before ready, after absent, degraded/`overlapping-active-turn` | 1809, session `9ba87cb4-...`, 23:27:51.220-23:28:18.844, accepted/ready both edges |
| 1836 | 1835, accepted | event 75168, `working -> idle`, 01:53:03 | 01:53:04.967 vs 01:53:06.146; 1,179 ms row overlap | `crashed` at 2026-08-07 17:01:08.618; before ready, after absent, degraded/`overlapping-active-turn` | 1837, session `8df29282-...`, 01:54:19.978-01:54:56.993, accepted/ready both edges |

The continuation ledger independently shows success:

| attempt / generation | brick saved | attempt relaunched | launch-settle event | result |
|---|---|---|---|---|
| `5e7a1e7b-...` / 1 | 22:35:15.195, tool, 4,740 bytes | 22:35:32.103 | event 74968 at 22:35:43 | successor kickoff 1775 accepted |
| `37b25052-...` / 2 | 23:27:19.567, tool, 5,215 bytes | 23:27:38.981 | event 75069 at 23:27:51 | successor kickoff 1809 accepted |
| `47147583-...` / 3 | 01:53:47.896, tool, 5,743 bytes | 01:54:07.238 | event 75173 at 01:54:19 | successor kickoff 1837 accepted |

Rows 1774/1808/1836 have a ready BEFORE OID/ref despite their degraded quality;
their degraded label is therefore solely the coordinator's mandated overlap reason.
None has an AFTER OID/ref. The successor session id changes at every handoff, while
the dashboard agent id remains stable, matching the continuation implementation.

Healthy row 1773 also confirms the normalization gap noted in D3. Its `touched` JSON
contains three spellings of the same supplement path, differing only by runs of six,
two, or zero spaces before `-work-packages.md`. `normalizeWitnessPath` resolves path
syntax and separator form but does not trim/canonicalize such ingress whitespace
(`src/main/git-checkpoints/witness-recorder.ts:46-80`), while DB deduplication is only
exact `(path, op)` equality (`src/main/database.ts:7876-7900`). This is independent
of the continuation race but should be fixed at the witness-ingress canonicalization
boundary.

## What the correct fix should record

The checkpoint turn and the continuation attempt are two related but distinct
lifecycles.

For the checkpoint recorder:

- Distinguish `closing` from genuinely active. A new send that arrives while the old
  completion is closing should await/serialize behind that close, then open a normal
  turn with `before_quality='guaranteed'` when capture succeeds and no overlap failure.
- Make cleanup compare-and-delete by turn identity (for example, delete only if the
  current map value is the same `AgentTurnState`/turn id). An old callback must never
  clear a successor turn.
- The continuation note-request turn should close independently on its actual
  completion signal. For these cases the faithful record would be `accepted`, a
  usable AFTER edge when capture succeeds, `after_quality` from the completion
  tracker, and `failure_reason=NULL`. Relaunch must not retroactively make that turn
  failed.
- Preserve `overlapping-active-turn` for a truly active prior model turn, with a test
  that isolates that condition from the already-closing race. Add a production-like
  test where completion's AFTER capture is pending, a new send opens, and the old
  completion resolves afterward.
- Reconcile all dangling open rows, not an implicit newest-50 UI page.

For the continuation lifecycle, D3's proposed durable results are appropriate and
should be keyed to `handoff_attempt_id` (and linked to relevant turn/session ids):

- `brick_saved`: record only after the tool-sourced brick row is durably inserted;
  include brick id, generation, source, bytes, and timestamp. The current
  `committed` attempt plus brick row already supplies most of this fact.
- `successor_started`: record only after the runner-launch tail resolves successfully
  and the fresh session/runner is live, not when the relaunch route merely accepts or
  when the attempt is marked `relaunched`. The code itself states that only the tail
  knows whether the successor came up (`src/main/supervisor/continuation-watcher.ts:704-713`;
  `src/main/supervisor/index.ts:7151-7174`). Include successor session id and start
  timestamp.
- `successor_oriented`: record only after the auto-submitted continuation pre-stage
  turn is correlated to the attempt/session and completes successfully. A launch or
  prompt delivery alone is insufficient. Include the kickoff turn id, completion
  quality, timestamp, and an explicit failed/timed-out disposition when orientation
  does not complete.

Those results should not overwrite checkpoint-turn status. A handoff may save a
brick and fail to start a successor; a successor may start and fail to orient; and
the note-authoring turn may complete normally in all of those cases.

## Limits / not established

- The DB has no current `successor_oriented` field and no attempt-to-kickoff-turn
  foreign key. I infer successful orientation from the exact continuation-pre-stage
  task labels plus accepted, ready-edge kickoff turns; I did not prove the semantic
  content of each successor's assistant reply from transcripts.
- The cited DB timestamps do not reproduce the proposal's exact "~23-24s later"
  figure under a single definition of start. They show launch-settle 11-13 seconds
  after `relaunched`, brick-save to launch-settle in 28-32 seconds, and initiating
  note-request start to successor kickoff in 62-75 seconds. The proposal may have
  measured a provider session-log event not represented in these tables. This timing
  discrepancy does not affect the race verdict.
- I did not establish why the idle event's persisted second-resolution timestamp can
  precede the target start by several seconds while the old checkpoint close lasts
  another 0.5-1.2 seconds beyond it; the completion tracker debounce plus AFTER
  capture mechanically permits it, but the DB does not expose the individual timer
  and capture timings.

