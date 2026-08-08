---
artifact_id: prop_24b2d13a
title: Provider-limit waiting kind + discoverable red-bar affordance
author_role: supervisor
author: AgentDashboard workspace supervisor
authored_at: 2026-08-05T20:45:00Z
---

# Provider-limit waiting kind + discoverable red-bar affordance

## Incident (why this exists)

On 2026-08-05 the AgentDashboard workspace showed the red waiting-for-input bar
while, from the human's perspective, no agent was waiting. The cause: a grok
worker (`PROBE-GROK-GUARD`, f2bf79fb) finished its turn, a follow-up prompt
stalled on grok's free-tier quota, and the grok CLI dropped into a full-screen
provider dialog — "You hit your free usage limit" with a SuperGrok upgrade
picker. The dashboard classified that dialog as generic `waiting`, painted the
red bar, and delivered **no** explanatory event. The human could not find the
waiting agent among 100+ mostly-done agents.

A read-only codex investigation (2026-08-05) produced file:line evidence for
three distinct defects. Full report is archived in supervisor memory
(`mb-2026-08-05-redbar-grok-quota`, detail file
`.lares/supervisor/memory/details/mb-2026-08-05-redbar-grok-quota.md`); anchors
below are from that report.

## Defect 1 — waiting events can be silently swallowed (the real bug)

A transition into `waiting` emits kind + excerpt and is provider-neutral
(src/main/supervisor/index.ts:2112, event-payload-builder.ts:203). But **all
non-runner status notifications share a 10-second per-agent cooldown**
(src/shared/constants.ts:46, src/main/supervisor/event-bridge.ts:416). When
`waiting` follows the same agent's `idle` within 10s — exactly this incident —
the bridge drops the waiting event **before recipient resolution**, so neither
the owner nor any turn-subscriber hears about it. The renderer still receives
the raw status change and paints red. Result: red UI, silent supervisors.

## Defect 2 — no concept of a provider quota/limit dialog

- Grok's scaffold maps **every** CLI `Notification` to
  `dashboard-status.mjs waiting` (src/shared/constants.ts:1675); only four
  known informational types are suppressed (constants.ts:2754); unknown types
  are conservatively treated as blocking and latched via
  `forceWaiting(..., 'notification', excerpt)`
  (src/main/supervisor/index.ts:7438).
- Neither kind vocabulary — interactive-screen kinds
  (interactive-prompt-detector.ts:35) nor persisted waiting-latch kinds
  (status-monitor.ts:24) — has a quota/rate-limit/upgrade value.
- Related staleness: commit 0e68dff's VT current-screen classifier is
  send-time only; the **status-driving** PTY fallback still scans append-only
  scrollback (status-monitor.ts:968, 981), so hook-unavailable grok/agy agents
  can latch `waiting` from stale, already-erased TUI frames. Agy has no
  Notification hook at all (constants.ts:1711) and depends entirely on that
  fallback.

## Defect 3 — the red bar is unfindable at scale

The renderer keeps only `{workspaceId, status}` per agent
(dashboard-store.ts:18); any `waitingCount > 0` yields a red dot
(Sidebar.tsx:124) and red outline (Sidebar.tsx:490) whose only explanation is a
native tooltip "N agents waiting" (Sidebar.tsx:528) — no agent title, kind,
excerpt, or navigation. Owner groups default collapsed (agent-grouping.ts:86)
and waiting descendants are **excluded** from the active-descendant visibility
signal (agent-grouping.ts:96), so a waiting worker under a collapsed owner is
practically invisible.

## Proposed work (ranked)

### WP-1 — never cooldown-suppress a transition into `waiting`

Treat entry-into-waiting like `crashed`: exempt it from the shared 10s cooldown
(or give it its own dedupe keyed on the waiting latch, so re-notifications of
the SAME latch are still suppressed). Land at event-bridge.ts:416. This alone
fixes the "red bar but nobody was told" race. Smallest, highest-value change.

### WP-2 — add a `provider-limit` waiting kind

Recognize high-confidence provider-limit text (grok "You hit your free usage
limit" / upgrade picker; equivalent agy/codex phrasings as discovered) **before**
generic notification handling and generic picker classification:

- notification classification: notification-classify.ts:17 + index.ts:7438
- PTY signatures: interactive-prompt-detector.ts:106
- `WaitingKind` union + mapping: status-monitor.ts:24
- event DTO/payload vocabulary: event-payload-builder.ts:66

Include in the same WP: switch the status-driving PTY fallback to
`getCurrentScreen()` (status-monitor.ts:972, 996), matching 0e68dff, so
waiting can no longer latch from erased frames.

### WP-3 — red affordance identifies and navigates to waiting agents

Carry agent id/title/provider + live waiting kind/excerpt to the renderer and
show e.g. "Grok worker X — provider limit" in a popover/tooltip; clicking
selects the workspace, expands the collapsed owner chain, and selects the
agent.

- preserve waiting metadata through IPC: ipc-handlers.ts:1125, types.ts:3113
- expand the status snapshot: dashboard-store.ts:18
- replace the count-only tooltip: Sidebar.tsx:528
- add waiting-descendant visibility beside active-descendant logic:
  agent-grouping.ts:111

### WP-4 — provider-limit policy (behavior, not just labeling)

On a `provider-limit` classification: mark the provider degraded/unavailable
for the session, notify the owner/human **once**, and offer explicit actions
("Dismiss dialog" — grok Shift+x via the interactive-key path,
constants.ts:385 — or "Open terminal"). **Never auto-select a paid upgrade**;
that stays human-only. Policy dispatch sits immediately after classification at
index.ts:7438. Natural tie-in: the provider-inclusive GroupThink plan
(plan_pigt5a83) is designing an availability/degraded taxonomy — WP-4's
degraded signal should use that vocabulary, not invent a parallel one.

## Non-goals

- No auto-dismissal by default (hides the reason without restoring quota).
- No quota purchasing/upgrading flows.
- No rework of the general notification cooldown beyond the waiting exemption.

## Acceptance sketch

1. Simulated idle→waiting within 10s on one agent: owner still receives the
   waiting event (WP-1).
2. Replayed grok quota-dialog PTY frames classify as `provider-limit`, not
   generic `notification` (WP-2).
3. With one waiting agent under a collapsed owner among many done agents, the
   red-bar affordance names it and one click reaches its card (WP-3).
4. Provider-limit event marks grok degraded and produces exactly one
   human-visible notice with dismiss/open-terminal actions (WP-4).
