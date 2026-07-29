<!-- disclosure-format: v2 -->
# Supervisor Memory Index

Open loops only. Every active capsule is complete inline — a cold successor reads
this whole index and sees every open loop with zero on-demand reads. Closed history
lives in git, the DB, and the WP-I1 archive, not here.

## handoff-read-first
1. mb-2026-07-28-gated-work-awaiting-deploy
2. mb-2026-07-28-memory-lessons-v2-execution
3. mb-2026-07-28-git-discard-guard-deploy
4. mb-2026-07-28-codex-worker-auth-unknown
5. mb-2026-07-28-bak-retention-cleanup

## mb-2026-07-28-gated-work-awaiting-deploy: Multiple workstreams DONE+GATED but uncommitted/unpushed
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: A successor may assume landed features are committed and deployed; they are not. ~45 commits' worth of work sits uncommitted in the shared tree, so a destructive git op or a premature relaunch could lose it or ship a stale dist/.
- state: Several workstreams are DONE+GATED but UNCOMMITTED / unpushed (~45 commits ahead of origin/master): git-native envelope, terminal-log retention, memory-hardening, checkpoint-surface, and the git-discard guard hook. Commit+push authorization and an app relaunch (npm run restart) are still pending.
- open-loop: Edward's commit/push authorization plus an app relaunch to deploy the pending features.
- expires-when: Edward authorizes commit/push and relaunches the app to deploy the pending features.
- read-if: you are about to commit, push, relaunch the app, or run any git operation on this shared tree.

## mb-2026-07-28-memory-lessons-v2-execution: Memory & Lessons v2 build in flight
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: A cold successor that doesn't know this build is mid-flight may re-plan or re-implement WPs that already landed, or mistake the strictly-sequential one-turn-per-WP cadence for parallelizable work.
- state: Memory & Lessons v2 build — 15 one-turn WPs, strictly sequential, full autonomy granted. WP-R through H3 landed; WP-I1 (archive + immutable triage) done; the deploy gate is cleared. WP-I2 signed migration is the final step.
- open-loop: WP-I2 signed migration publishes 23 behavioral lessons as skills and replaces this index with the 7 signed survivors.
- expires-when: WP-I2 signed migration lands and the fresh v2 index is live.
- read-if: you are picking up or reasoning about the Memory & Lessons v2 workstream, or about why behavioral.md / MEMORY.md changed shape.

## mb-2026-07-28-git-discard-guard-deploy: git-discard PreToolUse guard hook DONE+GATED, one queued edit
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: Without knowing the guard is not yet deployed, a successor may assume workers are already blocked from destructive git — they are not until it ships. The queued Grok-deny edit and supervisor/researcher coverage are still open.
- state: The git-discard PreToolUse guard hook is DONE+GATED but uncommitted. One queued 1-line edit (add "decision":"deny" for future Grok coverage) is not yet made, and the supervisor+researcher scaffolds are not yet covered (workers only).
- open-loop: land the queued grok-deny edit, extend coverage to the supervisor+researcher scaffolds, then commit + deploy.
- expires-when: the guard is committed + deployed (Edward restart) and the queued grok-deny edit has landed.
- read-if: you are working on the git-discard guard hook, scaffold coverage, or destructive-git protection.

## mb-2026-07-28-codex-worker-auth-unknown: Open question — how do Codex workers authenticate?
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: Adopting per-workspace CODEX_HOME (research "Path B") without knowing the auth mechanism could break every Codex worker, if they rely on a ChatGPT sign-in stored under the default CODEX_HOME.
- state: Open question to Edward: how do our Codex workers authenticate today? OPENAI_API_KEY is absent from src/, so it is likely a ChatGPT sign-in under CODEX_HOME — exactly what a per-workspace CODEX_HOME (Path B) would break.
- open-loop: Edward to confirm the Codex auth mechanism before Path B is adopted.
- expires-when: Edward confirms the Codex auth mechanism / Path B is decided.
- read-if: you are working on Codex worker auth, CODEX_HOME, or the per-workspace-home research (Path B).

## mb-2026-07-28-bak-retention-cleanup: .bak accumulation + WP-J retention cleanup pending
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: A successor may either delete .bak files unsafely (some may hold overwritten user edits) or leave them to accumulate. The D15 / WP-J policy and its authorized cleanup are the sanctioned path and haven't run.
- state: 20 .bak files / 196 KB under .lares/. The D15 / WP-J retention policy (keep newest 3 canonical per target, preserve unknown-hash) is planned and a cleanup is separately authorized, but not yet run.
- open-loop: land WP-J retention and execute the authorized .bak cleanup after its dry-run report.
- expires-when: WP-J .bak retention lands and the authorized cleanup executes.
- read-if: you are working on .bak retention, scaffold-writer cleanup, or reducing .lares/ disk use.

## mb-2026-07-28-behavioral-md-context-tax: behavioral.md context tax (subsumed by v2 migration)
- status: active
- date: 2026-07-28
- owner: supervisor
- consequence: If a successor doesn't know behavioral.md is being retired into lessons, they may keep appending to a 36 KB append-only file every worker reads at task start, re-growing the resident-token tax v2 removes.
- state: .lares/workers/claude/behavioral.md = 36,759 B (about 9.2k tokens), 29 entries, append-only, read by every worker at task start; Codex inherits the identical unbounded contract. Flagged to Edward and being retired into per-lesson skills by the v2 migration.
- open-loop: the v2 migration retires behavioral.md into per-lesson skills; keep this tracker only if a standalone follow-up is wanted.
- expires-when: the v2 migration retires behavioral.md into lessons (subsumed by mb-2026-07-28-memory-lessons-v2-execution).
- read-if: you are reasoning about behavioral.md, worker resident-token cost, or the lessons migration.

## mb-2026-07-28-onedrive-appasar-sweep: OneDrive app.asar duplicate awaiting sweep
- status: note
- date: 2026-07-28
- owner: supervisor
- consequence: A successor doing disk cleanup should know a 774 MiB duplicate app.asar is intentionally left pending (was file-locked) and a ~1.5 GB backup is mid OneDrive sync — deleting or moving these blindly could disrupt the sync or remove a needed artifact.
- state: A release.stale-* backup was moved into OneDrive (~1.5 GB queued for cloud sync); a duplicate 774 MiB app.asar remains physically on disk (was file-locked) awaiting a sweep once the lock clears.
- open-loop: remove the duplicate app.asar once its lock clears and resolve the OneDrive sync location.
- expires-when: the duplicate app.asar is removed and the OneDrive sync location is resolved.
- read-if: you are doing disk cleanup under .lares/ or resolving the OneDrive sync setup.
