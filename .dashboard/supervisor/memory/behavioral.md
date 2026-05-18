# Behavioral Memory

Situational patterns — "when X happens, do Y." Consulted on situation match, not loaded as a wall of rules.

Add an entry when an interaction surfaces a behavior worth repeating (or worth NOT repeating). Each entry has a **trigger** and an **action**. Remove entries when the situation no longer applies (workflow changed, underlying bug fixed, etc.).

---

## B-01: Investigator returned clean root cause + low context → direct them to fix

**Trigger:** A worker agent launched for investigation returns with: (a) clearly named file + line numbers, (b) explained mechanism, (c) one or more fix options described, AND its context is < 30%.

**Action:** Send the fix directive yourself. Don't ask the user. Pick the fix option (durable over quick, by default) and brief the same agent — they have the codebase paged in, much cheaper than spinning a new fixer.

**Source:** 2026-05-17 GroupThink duplicate-relay investigation. Worker (Claude, 10% / 49 turns) delivered a precise writeup; supervisor sent the durable-fix directive without asking; fixer (same agent, grew to 14% / 70 turns) landed 19/19 tests green. Net: one extra agent-turn instead of a fresh launch.

---

## B-02: Default to acting; ask only when judgment genuinely needs the user

**Trigger:** A decision point where the next step is obvious or conservative.

**Action:** Take the step. Surface what you did in the next user-facing message.

**When to ask instead:** architectural calls, scope/budget tradeoffs, anything that risks shared state (dashboard restart, git push, force ops, deleting files/branches), or where your context on user intent is genuinely thin.

**When you do ask:** orient first (situation in 2 lines), then the call to make, then the implication, then your recommendation. Default to your opinion as the answer; "let's research more / spin a small explore agent" is a valid recommendation.

**Source:** 2026-05-17 user feedback — "I want you to take more agency and surface things as they come up."

---

## B-03: Watch each agent's context as the primary spend

**Trigger:** Any agent is doing work, or about to be launched.

**Action:** Before launch — ask "does this fit comfortably in this provider's window?" If no, decompose or pick a different provider. During work — check context regularly via `get_context_stats`. For Claude 1M, treat 88% as the cost ceiling; below = cheap and durable, above = costs spike and judgment frays. For Codex/Gemini, treat their window as scarce from launch — Codex hit 100% at 6 turns in a GroupThink relay.

**Prefer fresh agents over compaction.** Compaction is lossy and unpredictable. A new agent with a tight brief is cleaner. Compact only when in-flight work is genuinely irreplaceable.

**Source:** 2026-05-17 user direction + Codex saturation observed in the multi-supervisor-migration GroupThink.

---

## B-04: Don't keep agents moving for its own sake — keep them moving against a plan

**Trigger:** Tempted to launch an agent, or to keep an existing one busy.

**Action:** First confirm there's a defined task — user-given or part of an active plan. If no plan exists, shape one first. "Keep agents productive" applies WITHIN a plan, not as an end. The job is shepherding agents through a defined goal, not maximizing agent activity.

**Source:** 2026-05-17 user direction — "you cant just keep hammering agents… you should be following a structure."

---

## B-05: User is typing in terminal AND a dashboard event arrives → don't autonomously dispatch

**Trigger:** You're about to act on a `[DASHBOARD EVENT]` but the user's most recent message looks mid-sentence or interrupted (e.g., ends abruptly mid-thought, event text appears mashed into their message, sentence trails off).

**Action:** Acknowledge the event but don't fully dispatch. The dashboard event probably interrupted the user mid-message (BUG-11). Finish the user's thread first, then handle the event.

**Source:** 2026-05-17 — user's workflow-change message was truncated by an incoming event. See `open-bugs.md` BUG-11.

---

## B-06: Communication — high-level abstraction first, technical depth in reserve

**Trigger:** Surfacing a decision, finding, or status to the user.

**Action:** Lead with the abstraction or "what does this mean for us" framing. Put technical detail (file paths, line numbers, error specifics) in support, not in lead. User wants to learn — don't dumb down — but doesn't want to be dragged through weeds they didn't ask for. A two-line orientation + a recommendation usually beats a five-paragraph dump.

**Source:** 2026-05-17 user direction.

---

## B-07: When updating supervisor memory, write to the matching category file

**Trigger:** A new behavior, procedure, bug, or gotcha worth remembering surfaced.

**Action:** Route to the right file per `MEMORY.md` index. Don't create a new top-level file unless the category genuinely doesn't fit. Gotchas in particular should be rare and cross-referenced to an open bug — see playbook P-05.

**Source:** 2026-05-17 user direction on memory organization.

---

## B-08: On agent-returns events, lead with name + task recap before findings

**Trigger:** A `[DASHBOARD EVENT]` reports a supervised agent went idle/done, OR you're surfacing a worker's findings/status to the user.

**Action:** Open with the agent's **title** (not its UUID) and a one-line recap of what they were sent to do. Then findings, then the call to make, then your recommendation. The user is juggling a multi-thread conversation — they don't hold every agent's task in working memory, and UUIDs aren't recognizable to them.

**Template:**

> The **`<agent-title>`** agent — the one I launched [when / why] to [one-line task] — just [finished / idled / hit X] and dropped its [writeup / patch / summary] at `<path>`.
>
> **Key finding(s):** [1–2 sentences]
>
> **The call:** [decision point in one breath]
>
> **My recommendation:** [pick + brief rationale]

**Anti-pattern:** opening with "Substantive finding —" or "Investigation done —" with no agent name and no task recap. From the user's view, an unnamed result appears out of nowhere and they have to mentally scroll back to figure out who and why.

**Source:** 2026-05-17 user feedback after the mcp-context-output-tools-investigation agent returned and the supervisor jumped straight into findings without naming the agent or recapping the task.
