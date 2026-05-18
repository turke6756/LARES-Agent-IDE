# Playbooks

Recurring technical procedures the supervisor performs. Each entry is a recipe with steps.

Add an entry when you find yourself doing the same multi-step procedure twice. Remove when the procedure is no longer needed (tooling changed, underlying bug fixed, etc.).

---

## P-01: Seed-and-fork for multi-task plans

**When:** N similar tasks share common context (e.g., 5 bug fixes in the same subsystem, 10 file conversions). Rough threshold: tasks share ≥ ~60% of needed context.

**Steps:**

1. Launch ONE seed agent with a "load and orient on the relevant subsystem" prompt — no task yet.
2. Wait for it to idle after orientation. Confirm its context is in a reasonable range (~5–15% — enough to have read the relevant files, not yet bloated).
3. `fork_agent` N times (one per task).
4. Send each fork the task-specific brief via `send_message_to_agent`.
5. Each fork inherits the seed's loaded context but works independently.

**Why:** Avoids N × (codebase re-exploration). A bug-fix sweep would otherwise cost ~5× the read tokens for the same files.

**When NOT to use:** tasks are independent (no shared context) — just launch separately.

---

## P-02: Triage an idled worker

**When:** `[DASHBOARD EVENT]` reports a supervised agent went `working → idle`.

**Steps:**

1. `read_agent_chat(agent_id, role: 'assistant', limit: 1)` — grabs the final assistant message (where summaries land).
2. If empty → `read_agent_log(agent_id, lines: 80)` — fall back to PTY for forensics.
3. Assess: did the agent finish, ask a question, hit an error, or stall on un-submitted input (BUG-10)?
4. Take the obvious next step (per B-01, B-02). If genuinely ambiguous, ask the user with orientation per B-06.

**Cost note:** chat read is 10–50× cheaper than log read. Default to chat.

---

## P-03: Launch a worker with a large prompt (BUG-10 workaround)

**When:** `launch_agent` prompt is multi-paragraph or larger than ~2 KB.

**Steps:**

1. `launch_agent` with the full prompt as today.
2. After ~2 seconds, send `send_keys_to_agent({key: 'enter'})` to force-submit.
3. Monitor for the agent to start producing output. If still in `[Pasted text]` state, send `enter` again.

**Why:** BUG-10 — bracketed-paste body races the auto-submit Enter for large payloads; Enter is dropped mid-paste.

**Until fixed:** this is the safe pattern. Remove this playbook once BUG-10 is closed.

---

## P-04: Stop a wedged or finished agent

**When:** An agent is at high context (>85%), not making progress, or done with work and no longer needed.

**Steps:**

1. `read_agent_chat(agent_id, role: 'assistant', limit: 1)` — capture final state.
2. If the agent has a useful in-progress artifact, document where (often a `plans/` file).
3. `stop_agent(agent_id)`.

**Prefer this to compaction** when the remaining work is independent enough to scope as a fresh task (per B-03).

---

## P-05: Update memory after a notable interaction

**When:** A session surfaced a new behavior pattern, recurring procedure, confirmed bug, or workaround.

**Steps:**

1. **Behavior pattern** → `memory/behavioral.md` (new B-NN entry with trigger, action, source).
2. **Recurring procedure** → `memory/playbooks.md` (new P-NN entry).
3. **Confirmed bug** → `memory/open-bugs.md` (new BUG-NN entry with severity, fix sketch).
4. **Workaround/gotcha** → `memory/gotchas.md` (or a domain-specific file like `groupthink-running-gotchas.md`) **only if** it can't be turned into a bug fix. Always cross-reference the open-bug entry.
5. **Update `memory/MEMORY.md` index** if you added a new file or category.

**Gotcha discipline:** if you're adding a gotcha, you should also be opening a bug. A gotcha with no bug means either (a) the workaround should be promoted to a playbook (it's how the thing works, not a defect), or (b) you forgot to file the bug — file it.

---

## P-06: Recover a wedged GroupThink run

**When:** GroupThink emits `orchestration.groupthink.stalled` event, OR you observe one planner at 100% context with the script still polling.

**Steps:**

1. `read_agent_chat` on both planners (`role: 'assistant'`, `limit: 5`) — see what was actually exchanged.
2. Decide:
   - **Accept partial:** if the deliberation already produced substantive content, write the plan file manually from what's there. Stop both planners.
   - **Steer + resume:** if one planner is wedged but the other has room, send a redirect (`send_message_to_agent`) then re-invoke the script with the `resume_hint` from the stall event.
   - **Abandon:** stop both planners, restart with a tighter topic or different provider mix.
3. Document the decision in `memory/groupthink-running-gotchas.md` if it's a new failure mode.

**Note:** Codex saturates fast as the Reviewer (6–8 turns under heavy relay). If GroupThink consistently stalls on Codex side, consider switching reviewer to Claude or using a `mesh` team instead.

---

## P-07: Close a fixed bug

**When:** A worker reports a verified fix (build clean, tests green, scope held) for an entry in `open-bugs.md`.

**Steps:**

1. Move the bug entry from the open section to the "Closed bugs" section at the bottom.
2. Format the closed entry: `**YYYY-MM-DD** BUG-NN: <one-line summary of fix + key file(s) + commit if known>`.
3. If a matching gotcha exists in `groupthink-running-gotchas.md` (or other gotcha file), mark it `(FIXED YYYY-MM-DD)` or delete it.
4. Update `MEMORY.md` highlights if the fix is notable.
5. Tell the user the fix is ready to commit + (if applicable) requires a `npm run restart` to take effect.
