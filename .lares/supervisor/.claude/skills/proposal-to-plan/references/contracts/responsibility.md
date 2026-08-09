# Contract reference — responsible supervisor

## Determination

This section is the stable, normative responsibility-determination anchor. Playbooks that gate a
mutation cite this section instead of invoking `orient` or copying the rules.

The current responsible supervisor is the agent named by the **last `assigned` event** in
`plan.json.responsibility_events`. Read it through `scripts/plan-manifest.mjs inspect`, which
surfaces that event as `current_responsible`.

A different supervisor must append a fresh `assigned` event through the manifest helper, under the
lock, **before** any mutation. Read-only orientation is allowed without reassignment. A mutation by
anyone other than the current responsible supervisor, or without the required fresh assignment, is
refused. Judgment-bearing next actions are gated on the current responsible supervisor.
