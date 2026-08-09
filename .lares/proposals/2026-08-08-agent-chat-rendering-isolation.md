---
artifact_id: prop_03456d61
title: Isolate chat rendering across agent selection changes
author: "Chat mix up eval" (worker, AgentDashboard)
author_agent_id: e7c7fe93-2f86-4081-ace8-3f32a9c3df1f
author_role: worker
author_provider: codex
authored_at: 2026-08-08T09:15:37.3381776-07:00
---

## In plain terms

When the user switches from one agent to another, the chat panel can briefly keep showing the first agent's conversation under the second agent's name and controls. The agents themselves still receive the correct messages, but the screen gives the user a false and potentially sensitive view of who said what. The chat should become empty or show a loading state immediately on every switch, then display only the newly selected agent's conversation. Previous-session controls must also always belong to the selected agent.

## Observed incident

On 2026-08-07, the same opening transcript from the Claude supervisor `229530a1-04f9-4781-9c8d-a92cae9b7e18` appeared in the chat pane for three different agents:

- Claude supervisor `c30eb66f-fc78-4c86-8974-bf5f8be12196`, "Planning surface Performance Review";
- Antigravity reviewer `8a345895-a22b-48b6-9a6a-c4428754b59b`, "Reviewer (GroupThink)"; and
- Codex worker `e7c7fe93-2f86-4081-ace8-3f32a9c3df1f`, "Chat mix up eval".

The repeated text began with the dashboard's automatic continuation pre-stage notice and the response "Ready. State verified against tools, not the note." A screenshot of the Codex worker showed the wrong Claude transcript beneath the Codex worker's correct title and live status.

Read-only inspection established that the persisted conversations were not crossed:

- the Codex worker was correctly bound to rollout `019fddb1-098c-7663-bcd9-c6caef1b974e`, which contained the user's actual investigation prompts and not the displayed Claude conversation;
- the Antigravity reviewer was correctly bound to conversation `928fd2b1-a971-4377-9322-e0b87f051f58`, whose database contained its GroupThink brief and reviewer response; and
- the repeated text existed in the Claude supervisor's correctly bound session `8df29282-e428-4629-851b-2f735420c3a8`.

There is therefore no evidence that a provider received or acted on another agent's messages. The demonstrated failure is on the dashboard's rendering path.

## Diagnosis

`src/renderer/components/detail/ChatPane.tsx` owns live events, prior-session blocks, lineage, hydration state, comments, scroll state, and related refs as component-local state. Its agent-change effect clears that state with `setEvents([])` and related setters, but `useEffect` runs after React has committed a render. During an agent selection change, React can reuse the existing `ChatPane` instance, render the new agent's title and controls, and still paint the prior agent's transcript before the passive effect clears it.

`src/renderer/components/layout/DetailPanel.tsx` currently renders `ChatPane` without an agent-specific React key. The component instance and its local transcript state are consequently eligible for reuse across distinct agent identities.

The same reuse boundary covers prior-session lineage. That makes the incident relevant to the accompanying report that the continued Claude supervisor's previous session could not be loaded normally. Database inspection showed two valid lineage rows for that supervisor and both Claude JSONL files existed, so missing persisted history did not explain the unavailable or misleading UI.

## Proposed change

Treat the dashboard agent ID as the identity boundary of the complete chat surface.

1. Mount `ChatPane` with an agent-specific key from `DetailPanel`, so selecting a different agent synchronously creates a fresh state container before anything is painted.
2. Preserve the existing async cancellation guards so a late history response from the old agent cannot populate the new instance.
3. During hydration, render an empty or explicit loading state for the selected agent. Never retain another agent's transcript as a placeholder.
4. Keep transcript events, prior-session blocks, lineage, staged selections/comments, history-unavailable state, scroll restoration, and loading refs inside the same identity boundary. No one of these surfaces may carry across to another agent.
5. Confirm that switching agents unsubscribes from the old agent and subscribes to the new agent exactly once, without losing batches emitted during hydration.

The minimal expected production change is an agent-keyed `ChatPane` mount. If testing exposes another cache above that boundary, the implementation must fix that cache as well rather than weakening the invariant.

## Required invariant

At every rendered frame, all chat-derived content and controls must have one identity: the currently selected dashboard agent ID.

It must be impossible for the UI to combine:

- agent B's title, provider, status, input target, or comment target; with
- agent A's live events, disk history, prior-session lineage, session divider, staged selection, or history-unavailable state.

This invariant applies to active, idle, done, crashed, continued, and cross-provider agents.

## Verification and regression coverage

Add renderer coverage that deliberately makes the race visible rather than relying on fast resolved promises.

### Agent-switch isolation test

1. Render agent A and hydrate a recognizable transcript.
2. Switch to agent B while B's `getChatEvents` and `getAgentSessions` calls remain deferred.
3. Assert immediately, before resolving either promise, that agent A's transcript, session dividers, staged state, and history affordances are absent.
4. Assert that agent B's loading or empty state is shown with agent B's controls.
5. Resolve agent A's requests late and prove they do not appear.
6. Resolve agent B's requests and prove only B's content appears.

### Cross-provider terminal-history test

Switch from a live Claude supervisor with continuation lineage to a done Antigravity or Codex reviewer whose history comes from disk. Prove that the terminal agent renders only its exact persisted session and never inherits the supervisor's continuation notice or previous-session controls.

### Previous-session lineage test

Switch between agents with zero, one, and multiple `agent_sessions` rows. Prove that the "Load previous session" affordance, loaded blocks, generation labels, and unavailable state always match the selected agent. Include a continued Claude supervisor with two valid sessions, matching the reported incident shape.

### Interaction safety test

While agent B's hydration is deferred, prove that no stale transcript from agent A can be selected, staged as a comment, quoted, or sent using agent B as the target.

## Likely files

- `src/renderer/components/layout/DetailPanel.tsx`
- `src/renderer/components/detail/ChatPane.tsx` only if an explicit hydration presentation or additional identity guard is needed
- a focused renderer regression test for `ChatPane`/`DetailPanel` agent switching
- existing chat-history or prior-session renderer tests where sibling coverage belongs

No database migration or provider-log rewrite should be necessary. The incident evidence indicates that provider session binding and persisted histories were correct.

## User-visible result

Switching agents immediately clears the prior agent's conversation. The selected agent then shows its own live or persisted history after hydration. Continued supervisors reliably expose their own previous-session control, while done reviewers show only their own frozen transcript. A slow disk read or IPC response may delay content, but it can never display another agent's messages in the meantime.

## Risks and guardrails

- Remounting the chat pane can affect per-agent scroll restoration and prompt-staging presentation. Existing per-agent scroll memory should continue to restore the correct position when returning to an agent, and the regression suite should cover it.
- A remount must not create duplicate subscriptions or drop the first live batch. Subscription cleanup and hydration ordering need explicit assertions.
- Do not solve the visual leak by merely hiding content for a fixed timeout. Correctness must be keyed to agent identity and hydration state, not elapsed time.
- Treat this as an information-boundary bug even though no provider execution crossed wires: the user can otherwise read, attribute, quote, or potentially send content under the wrong agent identity.
