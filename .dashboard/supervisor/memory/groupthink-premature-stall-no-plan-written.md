# GroupThink ops lesson: premature `no_plan_written` stall (2026-06-11)

**Run:** `d9a423ac`, groupthink **parallel** mode (safety deep-dive for the
embedded-browser plan). Lead/synthesizer = claude `ba374bd5`, peer = codex
`b1720987`. Output path `plans/embedded-browser-safety-deepdive.md`.

## What happened

The orchestration fired `orchestration.groupthink.stalled` with
`reason: "no_plan_written"` and `resume_hint: null`, message:
> "STALL: Synthesizer completed R3 but no plan file at <path>."

But the synthesizer had **not actually finished** — it was still working. The
stall detector apparently treated the synthesizer's R3 **reconciliation
message** (a `turnComplete:true` chat turn that summarized how it resolved the
two planners' disagreements) as "R3 done," checked the disk immediately, found
no file, and declared the stall. The synthesizer then kept going on its own and
wrote the full 28.7KB file ~a few minutes later, finishing cleanly with a
proper "Consensus plan written to …" summary and flipping idle→done normally.

So: **the stall was a false positive.** The deliverable was fine; the detector
just checked too early — there's a window where the synthesizer emits a
turn-complete *analysis* message before the turn that actually contains the
`Write` call.

## The trap I nearly fell into

On the stall I tried `send_message_to_agent(synthesizer, "write the file now…")`
→ **HANDSHAKE FAILED: "Cannot send input to agent in working state."** Good
thing — the agent was genuinely mid-write. Had the send landed, I'd have
injected a redundant prompt and likely caused a double-write or a confused turn.

## Correct recovery recipe (do this on a `no_plan_written` stall)

1. **Check the disk first**, not the agent: `ls -la <planPath>`. The file may
   already be there (the detector raced) or may appear within a couple minutes.
2. **Check the agent's real state** via the PTY, not just the `status` field:
   `read_agent_log` and strip ANSI — an animated spinner with the task title
   means it's actively working (it was, here). `status:"working"` after a stall
   is **not necessarily stale** — it can be a genuine in-progress write.
3. **If it's working: do NOT send_message** (it'll be rejected anyway, or worse,
   race the write). **Poll for the file** in the background instead
   (`run_in_background` loop on `[ -f path ]`), 30s cadence, ~20min cap.
4. Only if the file is truly absent AND the agent has gone idle/done with no
   file → *then* nudge the synthesizer to write it (it still has the full
   synthesis in context — cheaper than reconstructing from a truncated
   `read_agent_chat`), or resume the run.
5. The stalled run can be cleaned up with `abort_orchestration(runId)` once the
   file is confirmed on disk — the member agents flip idle→done. Aborting does
   **not** lose the on-disk deliverable.

## Takeaways

- `no_plan_written` + `resume_hint: null` ≠ failure. **Verify the file and the
  PTY before acting.** Treat it as "check, don't panic."
- A `turnComplete:true` chat turn from a planner is **not** proof the whole
  round (incl. the file write) is done. The plan-write may be a *later* turn.
- The handshake guard (reject-send-while-working) saved me from a racing
  double-send — trust it.
- Possible upstream fix worth filing: the parallel-mode stall detector should
  (a) poll the plan path for a grace window (e.g. 2–3 min) after the
  synthesizer's last turn before declaring `no_plan_written`, and/or (b) not
  treat a non-final turn-complete as round completion. Until then, the
  supervisor-side recipe above is the workaround.
