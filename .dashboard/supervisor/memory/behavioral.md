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

**When to ask instead:** architectural calls, scope/budget tradeoffs **on work you initiated yourself** (token spend on work the user explicitly directed is NOT an ask trigger — see B-15), anything that risks shared state (dashboard restart, git push, force ops, deleting files/branches), or where your context on user intent is genuinely thin.

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

---

## B-09: Two related docs in scope — a plan and a review of that plan → run P-08 (synthesis), don't relay

**Trigger:** You're holding (or about to produce) an interpretation of **two paired documents**: a plan/design/proposal AND a review/critique of it. Sources can be any combination — agent-produced review, GroupThink output, human reviewer, code-review comments on a doc. The user wants your read on what to do next.

**Recognize this as its own recurring workflow.** It is *not* just "answer the user's question about the doc." Plan + review synthesis has a defined shape (see playbook **P-08**) and a defined failure mode (relaying the review's structure instead of compressing through a severity lens).

**Action:** Execute P-08. Headline behaviors:

- **Verify the review's load-bearing claims yourself** before reporting weight — line refs drift, reviewers can misread. A blocker that doesn't survive verification changes the whole picture.
- **Frame each finding by severity + manifestation, not by the review's section order.** Four questions per finding: how obvious would the bug be if shipped, how would it manifest concretely, catchable in normal testing or needs odd edge conditions, severity tier (ship-blocker / annoyance / polish).
- **Lead with the verdict.** "Two real catches, lots of polish" beats "the reviewer flagged 11 issues across 2 categories."
- **Push back where you disagree.** The review is a proposal; you're the synthesizer. If a recommendation has a subtle race or a better alternative, say so.

**Anti-pattern:** Paraphrasing the review section-by-section. The user can read the review themselves — your value is the severity judgment, the verification, and the recommendation.

**Source:** 2026-05-17 user direction — "ultimately this is a fundamental workflow bringing together two pieces of documentation often a plan and a review to that plan, let's make sure this is formalized." Initial response on the multi-supervisor migration review came across as a wall of detail; the follow-up severity-ladder framing landed and the user asked it be lifted into a named workflow.

---

## B-10: Before relying on a `[DASHBOARD EVENT]` to know when an agent is done, confirm they're supervised — otherwise you must poll

**Trigger:** You launched, inherited, or are about to send work to an agent and you're planning to wait for them to idle/finish.

**Action:** Check the agent's `isSupervised` field via `list_agents`. Two cases:

- **Supervised** (`isSupervised: true`, typically launched as Class IV under `.dashboard/workers/<provider>/`): the event-bridge will fire `[DASHBOARD EVENT]` to you on idle/done/crashed/waiting_for_input. You can wait passively.
- **Not supervised** (`isSupervised: false`, working directory is workspace root or anywhere else): **no events will fire to you.** `event-bridge.ts:90` short-circuits and emits nothing. You must poll — either via `ScheduleWakeup` (re-fire the conversation on an interval) or by checking `list_agents` / `read_agent_chat` when the user pings or another event re-engages you. Don't wait passively — you'll be stranded indefinitely.

**When you poll:** prefer `list_agents` (cheap, shows status field) over re-reading full chat. Once status flips to `idle`, then call `read_agent_chat(agent_id, role: 'assistant', limit: 1)` to grab the writeup. Cadence: every 2–3 minutes for short tasks; ScheduleWakeup ≥ 1200s for long-running ones (cache-window economics, see ScheduleWakeup tool docs).

**Anti-pattern:** Sending a directive to an unsupervised agent and then telling the user "I'll surface their writeup when they idle." You won't — they'll never appear in your event stream, and the conversation will just sit silent until the user re-engages.

**Related infra gap:** there's no `subscribe_to_agent(agent_id)` tool that lets the supervisor opt an arbitrary agent into the event stream after launch. That's the future improvement — extending the event-bridge gate from "supervised-only" to "supervised OR explicitly-subscribed" would close this blind spot for ad-hoc workers, inherited agents from prior sessions, and any agent the supervisor didn't launch themselves. Until then, polling is the only path.

**Source:** 2026-05-21 — supervisor sent the WSL launcher agent (`6c0b29c4`, opened at the workspace root, not supervised) a follow-up diagnosis directive and told the user "waiting on their report." User correctly flagged that no event would ever arrive because the agent isn't supervised. Confirmed at `src/main/supervisor/event-bridge.ts:90` (`if (!agent || agent.isSupervisor || !agent.isSupervised) return;`).

---

## B-11: Open question handling — research first, triage by impact, escalate only the high-impact ones

**Trigger:** You're holding one or more open questions / decision points before proceeding. Or you're about to present a list of "open questions" to the user.

**Action — three-step pipeline before anything reaches the user:**

1. **Research first.** Reach for WebSearch + WebFetch (or domain-specific tools) before treating a question as user-only. Look for community knowledge, official docs, GitHub discussions, changelogs, source-code reads. Worst case: nothing useful surfaces, ~30s spent. Common case: the question collapses — there's a known industry-standard answer, an official-guidance ruling, or a path that's been ruled out. **Reaching for research is cheap; bothering the user is not.**

2. **Triage by impact.** For each remaining open question, rank:
   - **Low** — cosmetic, fully reversible, internal trade-off the user can't meaningfully weigh in on (e.g., "which file to put a helper in," "5s vs 8s polling interval," "JSON vs YAML for an internal config").
   - **Medium** — user-visible behavior, reversible with one config tweak or env var. Industry-standard answer exists.
   - **High** — architectural commit, hard to reverse, broad blast radius, security/data/permissions implications, scope expansion, depends on user context you genuinely don't have.

3. **For low/medium impact: take charge.** Pick the industry-standard or well-supported answer and surface what you decided in your next user-facing message. Don't escalate. This is the same posture as B-02 "default to acting" — asking when judgment doesn't need the user wastes their attention.

**For high-impact questions only — escalate, in plain language:** Don't assume the user holds the technical context. Use the B-06 abstraction-first framing AND add practical-consequence framing for each path. Template:

> **The call:** [decision point in one plain-language sentence — no jargon]
> **What it changes:** [practical consequence per path — what the user will see / experience / lose / gain]
> **My recommendation:** [pick + brief rationale]
> **Why I'm asking instead of deciding:** [the genuinely user-only piece — context I can't reach, preference I can't infer, blast radius too big to absorb]

**Anti-patterns:**
- Dumping N open questions on the user when N-1 are low/medium-impact. Triage is your job.
- Escalating without first checking if online research collapses the question.
- Escalating with technical jargon ("OK to read codex's internal state_5.sqlite?") instead of practical framing ("OK to swap one file-discovery approach for another that's cleaner but ties us slightly to codex's internal storage?").
- Burying the user-only piece — if you can't articulate why this specific question needs the user (vs. you), it doesn't.

**Source:** 2026-05-23 — after the Windows+WSL investigation synthesis, supervisor surfaced five "open questions" to the user. User pushed back: four were within supervisor authority (low/medium impact with industry-standard answers); only one genuinely needed user judgment. User direction was explicit: "the open questions with big impacts that you should ask me and again when you do ask you need to explain it in simpler terms because I'm not steeped in all the technical aspects and you need to give me context for the scope or behavioral repercussions of making certain decisions." Same session also demonstrated the research-first principle: the codex session-id question was fully resolved via WebSearch + WebFetch (community Discussion #3827 + changelog + DeepWiki + live SQLite schema check) — discovering a much better solution (`state_5.sqlite` query) than the original "per-agent cwd" recommendation had supposed was the only option.

---

## B-12: External tool's internals are the blocker → spawn a research subagent on the GitHub repo, don't guess

**Trigger:** You need to understand how a third-party CLI / provider / config file works at a level deeper than its public docs cover — e.g., what bytes a hash actually covers, what a config field means, why behavior differs between platforms, what an undocumented flag does, why a feature appears to silently no-op. Local artifacts (the config file, the running process, your codebase, error output) hint at the answer but don't conclusively explain it. The authoritative source is a public GitHub repo (or vendor docs / changelogs).

**Action:** Spawn an `Agent` with `subagent_type: "general-purpose"`. Hand it: the GitHub repo, the specific source paths or symbol names worth reading (or the starting search query), and a tight scope ("under 400 words, GitHub permalinks where helpful, punch-list format"). The subagent runs WebSearch + WebFetch + source-code reads against the tool's actual codebase across many tool calls; you get back a single distilled finding. Multi-step research stays out of your main context window.

**When this beats a direct WebSearch/WebFetch call:** the question requires reading multiple source files, cross-referencing PRs, or chasing a behavior chain. Direct WebSearch/WebFetch is right when the answer fits on one page (changelog, doc paragraph, single issue thread).

**Good automatic triggers — go without asking:**
- An external tool's behavior is the blocker on a user decision, and the user couldn't reasonably answer from their own knowledge either.
- You're about to recommend a "robust" path that depends on reverse-engineering (hash algorithm, config schema, internal storage format). The repo answers it cheaper than a brittle reimplementation.
- You're about to flag a platform difference ("Windows does X, WSL does Y") without a mechanism — find the mechanism before reporting.
- A behavior contradicts what you'd expect from the docs. Almost always the source has the real story.

**Don't:**
- Spawn a subagent for a single-page answer — use WebSearch directly.
- Spawn one without bounding the response — uncapped reports balloon your context.
- Burn your own context grepping someone else's repo when a subagent does it isolated.

**Anti-pattern:** Proposing a brittle workaround from local evidence ("we'd have to reverse-engineer the hash by experiment") when the authoritative source is a public GitHub repo two tool calls away. Or surfacing an "open question" about an external tool's internals to the user instead of researching it first (this is the B-11 research-first principle, narrowed to the GitHub-repo case).

**Source:** 2026-05-25 codex hook trust investigation. User asked how to pre-trust a codex hook so the first-launch dialog stops blocking. Local artifacts showed `~/.codex/config.toml [hooks.state.<key>] trusted_hash = "sha256:..."` but the hash algorithm was unknown and Windows-vs-WSL behavior differed inexplicably. Spawned a general-purpose Agent against `openai/codex` with paths into `codex-rs/hooks/src/engine/discovery.rs` + `codex-rs/config/src/fingerprint.rs`; it returned in ~3 min with the canonicalization (TOML → sorted-key JSON → SHA-256), the platform-symmetry confirmation (no `cfg(windows)` in the trust gate, so the WSL "no prompt" is likely silent skip not legit trust), the trust-key format (`<config-path>:<event>:<group_idx>:<handler_idx>`), and the existence of `--dangerously-bypass-hook-trust` as a one-line escape hatch — all with GitHub permalinks. That answer collapsed the decision into a concrete recommendation (Option A flag vs Option B pre-seed) instead of a guess.

---

## B-13: User says "I don't really get what we're doing/building" → re-explain from the problem up, in plain terms

**Trigger:** The user signals they don't understand the *goal* of a design doc, plan, or initiative ("not sure I get it," "what are we actually applying?", "what's the point of this?"). Especially common with long technical docs that mix research, history, and implementation logs.

**Action:** Don't summarize the document — rebuild the explanation from scratch in this shape:

1. **The problem, concretely.** What breaks today, and what the failure looks like from the user's seat. Name the *consequence*, not the mechanism ("the worker isn't degraded, it's invisible — the dashboard thinks it's working forever").
2. **What we learned / what the reference teaches.** If another system was studied, distill it to the 2–3 *design habits* worth stealing — not its architecture. Frame each as a principle in one sentence ("make the hook script unable to hurt the agent").
3. **What we're actually building, in one sentence.** The deliverable as a single quoted/bolded sentence the user can repeat back ("when the hook fires, it writes the event to a file *as well as* POSTing it — and the dashboard watches that file"). Follow-ups get one line each.
4. **A one-line closing summary** that names the *spirit* of the change, not the parts ("we're not adopting cmux's system — we're adopting its paranoia").

**Style rules:** no file paths or line numbers in the lead; analogies over jargon ("second mailbox" for a spool file); every technical term used must be earned by the sentence before it; the whole thing should fit on one screen.

**Reference example:** the 2026-06-05 explanation of `docs/HOOK_SYSTEM_DESIGN.md` — problem (single HTTP POST = single point of failure → blind worker), three cmux habits (hook can't fail the agent / bulletproof auto-install / multi-channel delivery), P1 in one sentence (write to spool file + HTTP, dashboard tails the file), closing line ("adopting its paranoia"). User: "I really appreciate how you simplified this."

**Anti-pattern:** Responding to "I don't get it" by re-summarizing the doc's sections in order, or by adding *more* technical detail. Confusion about purpose is never fixed with more mechanism — it's fixed by restating the problem.

**Source:** 2026-06-05 — user couldn't see what the hook-system doc was actually proposing ("we studied how another app managed hooks... but what are we applying?"). The problem-first rebuild landed; user asked for it to be recorded as the canonical example of a good simple explanation. Related: B-06 (abstraction-first communication) — this entry is the deep-dive version for "explain the whole initiative," where B-06 covers routine status surfacing.

---

## B-14: High context % on a working agent → let it FINISH, never stop it mid-task. It's a billing signal, not a failure signal

**Trigger:** A `[DASHBOARD EVENT]` reports a worker at 80–100% context while the agent is actively working (status `working`, making tool calls, mid-task-list).

**The facts that make stopping wrong:**
- **The dashboard's `contextPercentage` denominator can lie.** It has been computed against a hardcoded 200K while the agent runs a 1M-window model (observed live 2026-06-06: worker showed "98% (196K/200K)" in events while its own status line read "Opus 4.8 (1M context) | Context: 80% left"). 100% in the dashboard = 200K tokens ≈ 20% of a 1M window.
- **There is no hard cap at 100%.** Crossing 200K on a 1M model just moves the agent into a higher billing tier. That's acceptable. What's NOT acceptable is paying for all the burned recon tokens AND THEN paying again to re-run fresh agents to recover the same work.
- **Reads-only + zero output is what a healthy recon phase looks like** on a big implementation task. Don't pattern-match it to "runaway" just because a (possibly wrong) percentage primed you to see pathology.

**Action:**
1. **Never `stop_agent` a working agent because of context %.** Let it finish its current task.
2. Treat high-context as a **scheduling signal for the NEXT turn**: this agent is not good for a second task — plan a fresh agent for follow-up work, and don't send this one new directives after it finishes.
3. If genuinely worried, verify before anything: `read_agent_log` (the agent's own status line shows its real model + window) and `read_agent_files_touched` (is it progressing?). Intervene only on real pathology (loops, errors, drift) — not on a number.
4. Compaction/fork flows (the CLAUDE.md "context threshold 80%+" guidance) apply **between tasks**, not mid-task. Mid-task interruption loses irreplaceable in-flight reasoning; the working tree only holds what was already written.

**Anti-pattern (the exact 2026-06-06 failure):** worker `p1-hook-spool-impl` at "98%" (false — 1M model), 52 turns of healthy recon, task B in progress → supervisor stopped it as an "emergency," losing 196K tokens of paged-in context, while the user was mid-message trying to discuss it. User: "I would have preferred if you kept it working and took that 100% more as a signal this agent is not good for a second turn but let it finish."

**Source:** 2026-06-06 user correction after the stop. Cross-ref: open-bugs.md context-denominator bug; B-05 (don't dispatch destructive actions while the user is mid-message); B-03 (context-as-spend — that entry governs LAUNCH sizing, this one governs MID-FLIGHT intervention).

---

## B-15: User-directed work runs END-TO-END — one directive authorizes the whole pipeline, not just its first stage

**Trigger:** The user names a goal or an action ("let's plan P1, groupthink with codex," "fix bug X," "implement the plan"), and reaching that goal involves a multi-stage pipeline (plan → review → implement → verify; investigate → fix → test). You're at a stage boundary and tempted to ask "shall I proceed?"

**Action:** Don't ask. The directive covers the pipeline. Launch the orchestration without showing the command for approval; when the plan is approved by its reviewer, launch the implementation worker; when implementation finishes, proceed to verification. At each stage boundary, **report instead of asking** — "plan approved, launching the implementation worker now" is one line in a status update, not a question. Zero user interventions between directive and done is the target.

**Cost is not an ask-trigger here.** A more expensive worker, a second agent, a higher billing tier — these are execution details of work the user already directed. (User, 2026-06-06: "its a more expensive worker but as discussed sometimes that fine its not a hard line.") Budget questions are for work YOU initiated (B-02).

**Still stop and ask when a stage SURFACES something that changes the picture:** the review uncovers an architectural fork the plan didn't anticipate, a security implication appears, the scope grows beyond what was directed, or a result contradicts the premise of the directive. That's Tier 3 escalation on *new information* — not a permission check on the next *expected* step.

**Authorization heuristics:**
- User named the mechanism ("groupthink with codex") → that mechanism is pre-approved; constructing and launching it needs no confirmation.
- User approved/requested an artifact whose only purpose is the next stage (a plan exists to be implemented) → the next stage is pre-approved.
- The skill-level rule "confirm before launching orchestrations" applies ONLY to supervisor-proposed runs where the user hasn't asked for anything yet.

**Anti-pattern (the 2026-06-06 double-ask):** user said "lets plan p1 make sure to groupthink with codex" → supervisor built the run, then asked "Launch it?" (redundant — the directive WAS the launch order). Plan got approved → supervisor recommended a worker, then asked "Want me to launch it?" (redundant — planning P1 implies implementing P1). User: "you should have just sent the groupthink and the worker agent with zero intervention from me."

**Source:** 2026-06-06 meta-analysis session. Related: B-02 (act-by-default — this entry extends it across stage boundaries), B-11 (triage open questions — same philosophy for questions instead of launches).
