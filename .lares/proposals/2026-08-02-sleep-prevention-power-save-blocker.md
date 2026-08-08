# Proposal: Prevent system sleep while agents are working (powerSaveBlocker)

- artifact_id: prop_9b3e6d54
- date: 2026-08-02
- author: supervisor (workspace 029b5cea)
- status: PROPOSED — back burner (no urgency for Edward's desktop setup; matters for laptop/battery users)
- decision needed: none yet; pick up when there is a natural gap in the Save-card / planning-surface flow

## Problem

Windows counts only keyboard/mouse input as "user activity." Agent work — PTY
processes, in-flight API calls, file writes — does not reset the idle timer. On a
machine with a sleep timeout, an unattended agent run gets suspended mid-turn:
terminals freeze, API requests time out, worker turns stall or crash on wake.

Observed baseline on the primary dev machine (Balanced plan): AC timeout = 0
(never sleeps plugged in — why this has never bitten locally), DC timeout =
10 minutes. Any laptop user running Lares on battery hits this within one
coffee break.

## Proposed fix

Use Electron's built-in `powerSaveBlocker` in the main process; do NOT touch the
user's power settings (`powercfg` edits are invasive and persist if the app
crashes before restoring them).

- `powerSaveBlocker.start('prevent-app-suspension')` when the fleet transitions
  from "no agent working" to "≥1 agent working".
- `powerSaveBlocker.stop(id)` when the last working agent goes idle/done/crashed.
- Mechanism is a temporary kernel power request (same as video players use):
  no admin rights, no settings changed, auto-released on process exit.

Implementation shape: ~20 lines tied to the existing agent status tracker in
`src/main/` (wherever working/idle transitions are already observed — the same
signal that drives `[DASHBOARD EVENT]` idle notifications). Debounce the
stop slightly (e.g. 30–60 s) so rapid turn-to-turn gaps don't flap the blocker.

Note the mode choice: `prevent-app-suspension` keeps the system awake but lets
the display sleep — correct for unattended agent runs. `prevent-display-sleep`
is NOT wanted.

## Nice-to-haves (optional, same package or later)

- Small UI indicator (e.g. tooltip on the fleet status area) showing "sleep
  blocked — N agents working" so the behavior is discoverable.
- Setting to opt out (`preventSleepWhileWorking: true` default) for users who
  deliberately want battery-preserving sleep to win over agents.
- Docs line in SECURITY.md / setup.md noting the behavior.

## Acceptance sketch

- Unit: status-tracker transitions start/stop the blocker exactly once across
  overlapping workers (2 working → 1 → 0 stops only at 0); crash/kill of a
  worker counts as leaving working.
- Manual: with an aggressive sleep timeout set, a long worker turn keeps the
  machine awake; after the fleet is idle past the debounce, sleep resumes
  normally.

## Sizing / routing

One worker-sized WP. No DDL, no scaffold changes, no cross-plan dependencies —
safe to slot anywhere; do not interleave with SC-WP-* dispatching without
checking the save-card execution memory capsule first (peer supervisor owns
that lane).
