---
name: scaffold-content-needs-version-bump
description: >-
  When editing any scaffold content constant in AgentDashboard src/shared/constants.ts (GUARD_*, WORKER_*, SUPERVISOR_*, RESEARCHER_*, scripts, skills, settings.json bodies) or reviewing/gating such a change — deployment to existing workspaces is NOT automatic.
---
In AgentDashboard, files under `.lares/` in existing workspaces are only rewritten by the version-migration engine when their scaffold-map entry's `version` is BUMPED (map in src/main/supervisor/index.ts, mechanism in plans/scaffold-version-migration.md). Changing the content constant alone ships NOTHING to existing workspaces — the launch-time refresh sees version-current and skips the file. Exception: CODEX_HOME artifacts (dashboard-worker.config.toml + its script copies) regenerate unconditionally every codex launch — so a fix can look deployed on the codex path while every workspace copy silently stays stale (exactly what happened with the 2026-07-29 guard fix: Codex got new bytes, every Claude lane kept the old body).

When you change a scaffold content constant:
1. Bump `version` in its scaffold-map entry.
2. Add a `previousHashes` entry mapping the OLD version to the sha256 of the OLD body (frozen hex literal, per the established *_V*_HASH pattern) so pristine old copies upgrade silently and hand-edited ones get `.bak`-ed, not clobbered.
3. Extend scaffold-version-migration.test.ts (there are precondition tests asserting frozen-old-hash ≠ live-body hash — they catch 'body changed, version didn't' for covered files).
4. Remember deployment needs an app rebuild + relaunch AND then an agent launch in each workspace to trigger the migration.

When gating another agent's scaffold-constant change, check the version bump before approving — the fix worker's diff looking complete in constants.ts is not evidence it deploys.
