#!/usr/bin/env node
// Runs the main-process test suite.
//
// The list lives here as data rather than as a `node a && node b && ...` chain
// in package.json: at ~150 files that chain overruns the Windows command-line
// limit (8191 chars) and the suite dies before running a single test.
//
// Add new main-process test files to TESTS below.

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const TESTS = [
  'dist/main/shared/notification-classify.test.js',
  // Edit-loss §4.0/§4.1: shared content-identity hash vectors + the
  // conditional-write (CAS) contract of writeFileContents.
  'dist/main/shared/content-hash.test.js',
  'dist/main/main/file-writer.test.js',
  'dist/main/main/usage-limits-watcher.test.js',
  'dist/main/main/node-runtime.test.js',
  'dist/main/main/supervisor/codex-shell-parser.test.js',
  'dist/main/main/supervisor/codex-resume-command-builder.test.js',
  'dist/main/main/supervisor/context-stats-monitor.test.js',
  'dist/main/main/supervisor/file-activity-tracker.test.js',
  'dist/main/main/supervisor/file-activities-query.test.js',
  'dist/main/main/supervisor/session-id-discovery.test.js',
  'dist/main/main/supervisor/codex-launch-gate.test.js',
  'dist/main/main/supervisor/launch-first-user-message-prefix.test.js',
  'dist/main/main/supervisor/codex-rollout-freshness.test.js',
  'dist/main/main/supervisor/env-sanitize.test.js',
  'dist/main/main/supervisor/provider-resolver.test.js',
  'dist/main/main/runtime-prerequisites.test.js',
  'dist/main/main/supervisor/codex-sid-recovery-on-chat-read.test.js',
  'dist/main/main/supervisor/session-log-dispatcher.test.js',
  // WP3/WP8 (hook-absence-resilience) — turn-evidence tracker + send-outcome copy.
  'dist/main/main/supervisor/turn-evidence.test.js',
  // Git-Native WP-G1.4: turn-completion-tracker — fallback consult order,
  // close-on-first-evidence, bounded metadata-only after_quality upgrade.
  'dist/main/main/supervisor/turn-completion-tracker.test.js',
  'dist/main/shared/send-outcome-copy.test.js',
  'dist/main/main/supervisor/agent-chat-history.test.js',
  // Memory-hardening WP-4: getMessages(limit:1) two-scan short-circuit —
  // parity vs the full path, non-contiguity, user precedence, tool-only skip.
  'dist/main/main/supervisor/agent-chat-service.test.js',
  'dist/main/main/supervisor/claude-clear-rotation.test.js',
  'dist/main/main/supervisor/claude-clear-rotation-integration.test.js',
  'dist/main/main/supervisor/claude-clear-rotation-supervisor.test.js',
  'dist/main/main/supervisor/log-readers/claude-jsonl-reader.test.js',
  // Memory-hardening WP-1 (C): delete-time disk reclamation helper + the runner
  // delete-shutdown contract (disposeForDelete / closeLogStream / _deleting guard).
  'dist/main/main/supervisor/log-readers/reclaim-log-files.test.js',
  'dist/main/main/supervisor/delete-log-reclaim.test.js',
  // Memory-hardening WP-2 (B): bounded async log readers (tail/range/last-lines,
  // rune alignment, page-boundary multibyte, no scan ceiling, ENOENT, fd close)
  // + the whole-file .log readFileSync reintroduction guard.
  'dist/main/main/supervisor/log-readers/tail-file.test.js',
  'dist/main/main/supervisor/log-readers/no-whole-file-log-read.test.js',
  // Memory-hardening WP-3c (A): dead-agent replay snapshot with structured
  // truncation metadata (bounded .scrollback preferred, capped .log tail else;
  // conservative log>scrollback ⇒ truncated). Feeds the renderer dead-reopen banner.
  'dist/main/main/supervisor/log-readers/dead-agent-snapshot.test.js',
  // Terminal-log retention WP-6: reader/IPC structured reclaimed-history metadata —
  // marker-only reclaimed state (never ENOENT), fetch-after-read ordering, racing
  // range read keeps the notice, `missing` iff both fallback files absent, no
  // epoch-ms conversion (corrupt marker → null, never NaN), string readers → ''.
  'dist/main/main/supervisor/log-readers/terminal-history-notice.test.js',
  // Memory-hardening WP-3a (A): runner log byte-offset instrumentation, write
  // barrier (contiguous flushed prefix + degraded-on-error freeze), epoch reset
  // on stream open, and the ring snapshot — both runners.
  'dist/main/main/supervisor/runner-log-offsets.test.js',
  // Memory-hardening WP-3b (A): serialize-checkpoint sidecar I/O (atomic write +
  // tmp cleanup, malformed→null, ENOENT-safe unlink) and the pure epoch/degraded
  // (save) + epoch/cutoff (load) guards.
  'dist/main/main/supervisor/log-readers/terminal-checkpoint.test.js',
  // Memory-hardening WP-3d (A): epoch-scoped active-listener registry — the
  // stale-epoch detach no-op that keeps a reattached epoch-B listener alive.
  'dist/main/main/terminal-listener-registry.test.js',
  // Memory-hardening WP-3e (A): deferred WP-3a attach-path integration —
  // live-attach result shape (barrier cutoff/degraded + live epoch) vs dead
  // attach (fstat cutoff + retained/last epoch, never degraded).
  'dist/main/main/terminal-attach-integration.test.js',
  'dist/main/main/supervisor/log-readers/codex-rollout-reader.test.js',
  'dist/main/main/supervisor/log-readers/gemini-transcript-reader.test.js',
  'dist/main/main/supervisor/log-readers/grok-session-reader.test.js',
  'dist/main/main/supervisor/log-readers/agy-session-reader.test.js',
  'dist/main/main/supervisor/log-readers/wsl-base-dir-lazy.test.js',
  'dist/main/main/supervisor/event-bridge.test.js',
  'dist/main/main/supervisor/event-bridge.integration.test.js',
  'dist/main/main/supervisor/event-payload-builder.test.js',
  'dist/main/main/supervisor/status-monitor.test.js',
  'dist/main/main/supervisor/agent-supervisor.test.js',
  // Idle-agent lifecycle: §B2/§B3 migration + transition writer, §B5/§B6 stop engine.
  'dist/main/main/lifecycle-transition.test.js',
  'dist/main/main/supervisor/lifecycle-stop.test.js',
  'dist/main/main/supervisor/lifecycle-stop-intent.test.js',
  'dist/main/main/lifecycle/guards.test.js',
  'dist/main/main/supervisor/lifecycle-eligible-stop.test.js',
  'dist/main/main/lifecycle/lifecycle-ipc.test.js',
  // Terminal-log retention WP-1: per-field-independent lifecycle-settings
  // validation (autoStopIdleThreshold vs logRetentionCap) + defaults merge.
  'dist/main/main/lifecycle/lifecycle-settings-retention.test.js',
  // Context Window Warning: per-role gauge-cap settings + resolution.
  'dist/main/main/context-gauge/context-gauge-settings.test.js',
  // System-Memory polish: commit attribution completeness + composed view DTO
  // + the getActiveAgents live-registry predicate.
  // Layer 3 crash diagnosability: main-process V8 heap telemetry — JSONL line
  // shape, ~5 MiB rotation, once-per-crossing 75/90% warnings.
  'dist/main/main/watchdog/heap-telemetry.test.js',
  // Layer 3 per-part memory attribution: the analysis script's pure core —
  // parse tolerance (mixed old/new), linear-fit exactness, classify verdicts.
  'scripts/analyze-heap-telemetry.test.mjs',
  'dist/main/main/watchdog/attribution.test.js',
  'dist/main/main/watchdog/attribution-service.test.js',
  'dist/main/main/watchdog/system-memory-view.test.js',
  // Memory-hardening WP-2: fail-CLOSED main-process V8 heap admission gate —
  // 85% boundary, NaN/zero-limit/negative/thrown fail-closed, caps→heap→commit.
  'dist/main/main/watchdog/memory-sampler.test.js',
  'dist/main/main/database.active-agents.test.js',
  // Save-card SC-WP-2A: immutable turn plan-stamp schema, mapper, and guards.
  'dist/main/main/database.turnStamp.test.js',
  // Save-card Stage ③ SC-WP-3A/3B — plan work-package schema/accessors and the
  // finalizations table (WP-3Z registration).
  'dist/main/main/database.planWorkPackages.test.js',
  'dist/main/main/database.finalizations.test.js',
  'dist/main/main/dispatch-binding.boundary.test.js',
  // Save-card SC-WP-2H/2J/2K: pin policy/accounting and commit representation.
  'dist/main/main/git-checkpoints/protection-policy.test.js',
  'dist/main/main/git-checkpoints/pin-accounting.test.js',
  'dist/main/main/commit-candidates/commit-representation.test.js',
  // Terminal-log retention WP-1: reclaimed-marker column — idempotent migration,
  // the WHERE-guarded write (first value preserved, own column only), NULL→null.
  'dist/main/main/log-retention-marker.test.js',
  // Terminal-log retention WP-2: pure bundle summarization + sweep selection
  // (zero IO) — newest-mtime max, empty→null, ineligible-count-toward-totals,
  // age boundary, oldest-first accumulation, target-unmet honesty, path guard.
  'dist/main/main/log-retention/log-retention-policy.test.js',
  // Terminal-log retention WP-4: supervisor executor — lifecycle lock, post-drain
  // live recheck (runner appearing DURING the drain is caught), checkpoint
  // reservation (overlapping-save Set, marker never gates save/load), sequential
  // sweep with a yield every 25 agents, and marker-honesty (hook == unlink).
  'dist/main/main/supervisor/log-retention-executor.test.js',
  // Terminal-log retention WP-5: durable scheduler state — atomic round-trip,
  // corrupt→defaults, and the create-once/immutable first-sweep-notice transform.
  'dist/main/main/lifecycle/log-retention-state.test.js',
  // Terminal-log retention WP-5: on-disk bundle inventory — validate-before-stat,
  // shared-path→shared-reference (counted once, never selected), ENOENT-vs-stat-error.
  'dist/main/main/log-retention/log-retention-inventory.test.js',
  // Terminal-log retention WP-8: first-sweep IPC + broadcast (every window,
  // skip destroyed) + acknowledge round-trip; sweep-event ACTUAL before/after
  // mapping; the LIVE-telemetry-accessor sinks (a sweep before telemetry exists
  // is a no-op, one after is delivered — the "start before sinks" mutation).
  'dist/main/main/lifecycle/log-retention-ipc.test.js',
  // Terminal-log retention WP-8: the load-bearing index.ts SOURCE order —
  // construct scheduler → construct telemetry → START scheduler, and shutdown
  // drain scheduler → stop telemetry → supervisor drain.
  'dist/main/main/log-retention-wiring-order.test.js',
  // Terminal-log retention WP-5: OS-idle scheduler — idle gate (active/unknown/
  // throw skip; idle/locked run), cadence seeded from lastFullScanAt (no restart
  // re-scan), single-flight, resume-no-catch-up, O(1) cached gauges, actual-removal
  // counters (partial never overclaims), 'unlimited' cap, no-repair-pass selection.
  'dist/main/main/log-retention/log-retention-scheduler.test.js',
  // Terminal-log retention WP-9: the END-TO-END backstop — one real OS-idle scan
  // over a mixed fixture wires the real scheduler → inventory → planner →
  // supervisor executor (post-drain live recheck) → reclaim primitive → reader
  // DTOs → durable state. Asserts only eligible bundles are reclaimed (files gone,
  // marker set), live/young/revived-recent/shared untouched, a runner appearing
  // mid-scan is not swept, gauges/first-sweep-notice reflect ACTUAL removals, no
  // retention module calls dbDeleteAgent, and the whole-file-read guard stays green.
  'dist/main/main/log-retention/log-retention-integration.test.js',
  // Git-Native WP-A0: turn_records + recovery_operations schema/accessors.
  'dist/main/main/turn-records.test.js',
  // Git-Native WP-G0.1: MinGit manifest loader + shape validation.
  'dist/main/main/git/mingit-manifest.test.js',
  // Git-Native WP-G0.2: git-runtime dual resolution + capability probe.
  'dist/main/main/git/git-runtime.test.js',
  // Git-Native WP-G0.4: bundled-git shim for agent terminals.
  'dist/main/main/git/git-shim.test.js',
  // Git-Native WP-G0.5: MinGit fetch/verify/unpack (source .mjs, no compile step).
  'scripts/fetch-mingit.test.mjs',
  // Git-Native WP-G1.1: git-command bounded exec + binary blob streaming (real git).
  'dist/main/main/git-checkpoints/git-command.test.js',
  // Git-Native WP-G1.2: per-key priority queue + eager timer-driven deadline expiry.
  'dist/main/main/git-checkpoints/checkpoint-queue.test.js',
  // Git-Native WP-G1.3a: ref encoding round-trip + check-ref-format validation.
  'dist/main/main/git-checkpoints/ref-encoding.test.js',
  // Git-Native WP-G1.3a: capability gate + enumeration preflight + check-ignore trichotomy.
  'dist/main/main/git-checkpoints/checkpoint-gating.test.js',
  // Git-Native WP-G1.3b: snapshot core — full raw capture (real git) + durable finalize.
  'dist/main/main/git-checkpoints/checkpoint-service.test.js',
  // Git-Native WP-G1.3c: guarded blob-write restore (real git) — byte-exact, path-scoped
  // PRE safety ref, directory-transition + symlink-ancestor guards, partial accounting.
  'dist/main/main/git-checkpoints/checkpoint-restore.test.js',
  // Git-Native WP-G1.5: turn-coordinator — before/after boundary state machine,
  // fail-open before edge, never-two-open overlap, delivery-reject, completion
  // via turn-completion-tracker, startup reconciliation.
  'dist/main/main/git-checkpoints/turn-coordinator.test.js',
  // Save-card SC-WP-2B: trusted plan-stamp allocation + overlap re-open inheritance.
  'dist/main/main/git-checkpoints/turn-coordinator.stamp.test.js',
  // Git-Native WP-G1.8: ref/DB crash-consistency reconciliation (create/adopt/conflict
  // on real git) + dangling-open close + paired-ref deletion + temp-artifact sweeper.
  'dist/main/main/git-checkpoints/reconciler.test.js',
  'dist/main/main/git-checkpoints/commit-reconciler.test.js',
  // Git-Native WP-G3.3 + Save-card SC-WP-2K: retention/pinning integration,
  // distill-before-prune ordering + G3 gate back-fill, triggered/bounded loose-object
  // maintenance (idle-only slot, no config mutation, nonfatal on lock), storage report.
  'dist/main/main/git-checkpoints/retention.test.js',
  'dist/main/main/git-checkpoints/retention.pinning.test.js',
  // Save-card Stage ③ SC-WP-3B/3D — finalization refs + crash-consistency
  // reconcile and the boundary-ref retention partition (WP-3Z registration).
  'dist/main/main/git-checkpoints/finalization-refs.test.js',
  'dist/main/main/git-checkpoints/finalization-reconcile.test.js',
  'dist/main/main/git-checkpoints/retention.boundaryRef.test.js',
  // Git-Native WP-G1.7: witness-join recorder + DB choke point (above the live-cache
  // dedupe), dispatch-context builder, and the send-queue → before-checkpoint wiring.
  'dist/main/main/git-checkpoints/witness-recorder.test.js',
  'dist/main/main/git-checkpoints/dispatch-context.test.js',
  // Save-card SC-WP-2B: wire-safe binding resolution + trusted carry seam.
  'dist/main/main/git-checkpoints/dispatch-context.stamp.test.js',
  // Git-Native WP-G2.2: the human renderer's checkpoint IPC registrar + the
  // Open #4 force gate (refuse while an active turn witnesses a requested path).
  'dist/main/main/git-checkpoints/checkpoint-ipc.test.js',
  // Git-Native WP-G3.4: the human-only `git init` consent action (init a non-repo
  // + re-probe; refuse already-repo; error leaves no partial state; human-only).
  'dist/main/main/git-checkpoints/git-init.test.js',
  // Git-Native WP-G3.5: explicit prune (delete a workspace's two encoded namespaces,
  // atomic batch, no gc/prune) + the human-only repo-wide purge that names every
  // affected workspace before clearing (real git).
  'dist/main/main/git-checkpoints/prune.test.js',
  // Save-card WP-0A/Stage 1: shared contract, binary Git seam, canonicalization,
  // repository discovery, dirty inventory, capture health, witness/topology assembly,
  // exact protection, read-only bundle service, and read-only IPC.
  'dist/main/shared/commit-candidates.export-shape.test.js',
  'dist/main/main/git-checkpoints/git-command.runGitBytes.test.js',
  'dist/main/main/commit-candidates/jcs.test.js',
  'dist/main/main/commit-candidates/repository-identity.test.js',
  'dist/main/main/commit-candidates/scope-discovery.test.js',
  'dist/main/main/commit-candidates/dirty-inventory.test.js',
  'dist/main/main/commit-candidates/capture-health.test.js',
  'dist/main/main/git-checkpoints/live-edge.test.js',
  'dist/main/main/commit-candidates/witness-projection.test.js',
  'dist/main/main/commit-candidates/stamp-projection.test.js',
  'dist/main/main/commit-candidates/component-assembler.test.js',
  'dist/main/main/commit-candidates/protection-read.test.js',
  'dist/main/main/commit-candidates/candidate-service.read.test.js',
  'dist/main/main/commit-candidates/work-bundle.test.js',
  'dist/main/main/commit-candidates/save-card-ipc.test.js',
  // Save-card SC-WP-1J: production route wiring — the bootstrap adapter that maps
  // the renderer workspaceId to a repository-scoped request and delegates to the
  // read-only facade (real temp git; only the registry + DB readers are faked).
  'dist/main/main/commit-candidates/save-card-routes.test.js',
  // Save-card SC-WP-W1: production candidate-preview route composition — the
  // bootstrap adapter that stitches the read-only `CandidateBuildContext` (ledger /
  // HEAD / fingerprint / finalizations / per-member temp-index reps) for BOTH
  // lenses. The 1G assembly seam is stubbed; the stitching is exercised directly.
  'dist/main/main/commit-candidates/preview-routes.test.js',
  // Save-card Stage ③ SC-WP-3C/3G — candidate build pipeline + immutable
  // index-fingerprint snapshot, real finalization service, and the finalize/
  // preview IPC facades (WP-3Z registration).
  'dist/main/main/commit-candidates/candidate-service.build.test.js',
  'dist/main/main/commit-candidates/index-fingerprint.test.js',
  'dist/main/main/commit-candidates/finalization-service.test.js',
  'dist/main/main/commit-candidates/save-card-ipc.finalize.test.js',
  'dist/main/main/commit-candidates/save-card-ipc.preview.test.js',
  'dist/main/main/supervisor/send-queue-checkpoint.test.js',
  'dist/main/main/supervisor/initial-user-prompt.test.js',
  'dist/main/main/supervisor/hook-spool-tailer.test.js',
  'dist/main/main/supervisor/send-input-encoder.test.js',
  'dist/main/main/supervisor/key-bytes.test.js',
  'dist/main/main/supervisor/worker-scaffold.test.js',
  // Memory & Lessons v2 WP-F1 — the `remember` skill is provisioned to every
  // WP-R lane/provider skill root (Claude+Codex, supervisor+worker).
  'dist/main/main/supervisor/remember-provisioning.test.js',
  'dist/main/main/supervisor/codex-worker-parity.test.js',
  'dist/main/main/supervisor/role-lane.test.js',
  'dist/main/main/supervisor/resolve-launch-command.test.js',
  'dist/main/main/persona-scanner.test.js',
  'dist/main/main/pasted-image-store.test.js',
  'dist/main/main/path-utils-to-agent.test.js',
  'dist/main/main/supervisor/mcp-config-builder.test.js',
  'dist/main/main/supervisor/scaffold-version-migration.test.js',
  // Free-function scaffold writer branches, incl. the EDR P0.1 retirement
  // (removed: true) entries — silent delete / .bak+delete / never-touch-recreated.
  'dist/main/main/scaffold-writer.test.js',
  // Lares rebrand — one-time .dashboard → .lares state-dir migration.
  'dist/main/main/workspace-state-dir.test.js',
  // Lares-rename regression: legacy-cwd agents regain their hook scaffold at launch.
  'dist/main/main/supervisor/legacy-state-dir-heal.test.js',
  'dist/main/main/supervisor/supervisor-persona-capability-parity.test.js',
  'dist/main/main/supervisor/provider-dir-trust.test.js',
  // Antigravity provider lane Phase 3: raw exact trust keys + add-only native
  // regex permissions merge and atomic settings.json wrappers.
  'dist/main/main/supervisor/agy-settings.test.js',
  // Grok provider lane Phase 3: grokTrustPathKey (canonical git-root key) +
  // mergeGrokFolderTrust (line-aware trusted_folders.toml merge).
  'dist/main/main/supervisor/grok-trust.test.js',
  'dist/main/main/supervisor/handoff-handshake.test.js',
  'dist/main/main/supervisor/hook-status-detection.test.js',
  'dist/main/main/supervisor/codex-guard-hook-profile.test.js',
  'dist/main/main/supervisor/dashboard-status-script.test.js',
  'dist/main/main/supervisor/dashboard-host-injection.test.js',
  'dist/main/main/supervisor/wsl-bridge-base64-wrap.test.js',
  'dist/main/main/supervisor/wsl-bridge-tmux-new-session.test.js',
  'dist/main/main/supervisor/wsl-runner-launch-diagnostic.test.js',
  'dist/main/main/supervisor/wsl-runner-phantom-reconnect.test.js',
  'dist/main/main/supervisor/wsl-attach-cmd.test.js',
  'dist/main/main/supervisor/multi-transport-matrix.test.js',
  'dist/main/main/api-auth.test.js',
  // WP-G2.0 — per-agent capability token store (mint / rotate / revoke / resolve).
  'dist/main/main/security/agent-capabilities.test.js',
  // Cross-workspace collaboration WP0 — the two cross-workspace authorizers +
  // the cross_workspace_audit round-trip (successes AND denials; contents never
  // stored; detail sanitized).
  'dist/main/main/security/cross-workspace-policy.test.js',
  // Cross-workspace collaboration WP0.4/0.5 — fail-closed capability mint + the
  // single-token credential-propagation model (one mint per launch/restart/fork;
  // same token in child env + dashboard + team MCP; never the global bearer).
  'dist/main/main/supervisor/credential-propagation.test.js',
  // Cross-workspace collaboration WP1 — discovery surfaces: GET /api/workspaces +
  // cross-workspace GET /api/agents (supervisor-gated foreign reach, reduced
  // projection, zero-active default, audit on foreign-supervisor + denied-worker)
  // and the MCP shim projection (list_agents lastActivityAt + list_workspaces).
  'dist/main/main/api-cross-workspace-list.test.js',
  // WP2 (plans/cross-workspace-collaboration.md — per-ID intentional gating):
  // authorizeAgentTarget on the five per-ID routes (GET :id/log/messages/
  // file-activities, POST :id/input) — local worker allowed no-audit, foreign
  // worker 403 audited denial, foreign supervisor allowed + audit, global bearer
  // UI-compat no-audit, send arms the one-turn subscription, foreign send stores
  // queued_message_len (length only, never contents), same-workspace input unaudited.
  'dist/main/main/api-agent-target-scope.test.js',
  // WP3 (plans/cross-workspace-collaboration.md — revival lifecycle + revive_agent):
  // AgentSupervisor.reviveAgent (validate → assertResumable → successor guard →
  // ownership gate → stop+verify → stage-after-stop → resume tail); both done/
  // crashed revive, gate matrix, StopResult verification, staged-prompt cleanup on
  // relaunch failure, provider gating, fresh-capability re-mint.
  'dist/main/main/supervisor/revive-agent.test.js',
  // Save-card Stage 2 SC-WP-2E — fork/revive lifecycle stamps are frozen into
  // pending initial prompts and survive unchanged through delivery.
  'dist/main/main/supervisor/supervisor.forkRevive.stamp.test.js',
  // WP3.3 — POST /api/agents/:id/revive authorization + audit (supervisor-only even
  // same-workspace, global-bearer allowed, cross-workspace target gate, audit on
  // success/denial/failure, queued_message_len length-only, revErr status/code map).
  'dist/main/main/api-revive.test.js',
  // WP4 (plans/cross-workspace-collaboration.md — peer-supervisor launch mode):
  // launchAgent's launchMode:'supervisor-peer' canonicalization — resolves the
  // .lares/supervisor cwd, forces isSupervisor / clears isSupervised/isWorker/owner
  // edge, rejects researcher+persona with peer-mode-incompatible, worker mode
  // (owner edge) unchanged.
  'dist/main/main/supervisor/launch-peer-supervisor.test.js',
  // WP4.3 — POST /api/agents launch-scope authorization: mode→launchMode
  // normalization, foreign launch only for supervisor-peer (supervisor-gated,
  // audited), worker mode stays self-scoped via resolveWorkspaceScope.
  'dist/main/main/api-launch-peer-supervisor.test.js',
  // WP6 (plans/cross-workspace-collaboration.md — integration, security matrix):
  // the proposal §5 acceptance scenario end-to-end (discover → list → read →
  // revive → message with a minted supervisor token; worker 403s; global bearer
  // allowed), the consolidated list/read/send/launch/revive × {bearer, supervisor,
  // worker, researcher} × {own, foreign} allow/deny/audit matrix, and the
  // credential rows (no launched agent of any lane holds getApiToken(); mint fails
  // closed).
  'dist/main/main/cross-workspace-integration.test.js',
  'dist/main/main/api-identity.test.js',
  'dist/main/main/api-codex-session-bind.test.js',
  'dist/main/main/continuation-lifecycle.test.js',
  'dist/main/main/continuation-binding.restart.test.js',
  'dist/main/main/supervisor/continuation-watcher.test.js',
  'dist/main/main/supervisor/continuation-phase-authority.test.js',
  'dist/main/main/supervisor/file-activities-retention.test.js',
  'dist/main/main/api-browser-routes.test.js',
  'scripts/mcp-browser-tools.test.js',
  'dist/main/main/security/path-confinement.test.js',
  'dist/main/main/browser/browser-decisions.test.js',
  'dist/main/main/claude-config-repair.test.js',
  'dist/main/main/browser/key-map.test.js',
  'dist/main/main/browser/cdp-driver.test.js',
  'dist/main/main/browser/browser-policy.test.js',
  'dist/main/main/browser/omnibox-suggest.test.js',
  'dist/main/main/browser/history-store.test.js',
  'dist/main/main/browser/access-policy-store.test.js',
  'dist/main/main/browser/browser-manager.test.js',
  'dist/main/main/browser/slice15-zoom-find.test.js',
  'dist/main/main/browser/downloads.test.js',
  'dist/main/main/browser/session-store.test.js',
  'dist/main/main/browser/a11y-snapshot.test.js',
  'dist/main/main/browser/action-audit.test.js',
  'dist/main/main/selection-comments-db.test.js',
  'dist/main/main/selection-comments-send.test.js',
  'dist/main/main/detached-windows.test.js',
  'dist/main/main/detached-view-windows.test.js',
  // Edit-loss §4.3: main-window/app close flush handshake state machine.
  'dist/main/main/close-flush.test.js',
  'dist/main/main/browser/context-menu.test.js',
  'dist/main/main/browser/manager-shortcuts.test.js',
  'dist/main/main/browser/reader-mode.test.js',
  'dist/main/main/research/frontmatter.test.js',
  'scripts/research-write-guard.test.js',
  // Shared PreToolUse git-discard guard — pure-predicate decision table
  // (~60 cases) + spawn harness (deny shape, exit codes, fail-OPEN).
  'scripts/guard-git-discard.test.js',
  // Memory & Lessons v2 WP-A1 — pure core unit tests, the CLI exec suite
  // (shipped MEMORY_INDEX_MJS bytes vs on-disk fixtures), and the stale-artifact
  // drift check (regenerate → byte-identity with the committed generated bundle).
  'dist/main/main/memory-index/core.test.js',
  'dist/main/main/memory-index/review-store.test.js',
  // Memory & Lessons v2 WP-A2 — the I/O validation layer (validateIO +
  // readValidateProject): dangling/escaping/orphan detail HARD classes over real
  // on-disk fixtures, pure+I/O combination, and the shipped CLI's exit codes.
  'dist/main/main/memory-index/io-validate.test.js',
  // Memory & Lessons v2 WP-C — the launch projection + provider-neutral delivery
  // (severity/fallback/runtime flow, reconcile-only-against-valid, MEMORY.md
  // untouched, the compose/predicate helpers, and the autoMemoryEnabled gate).
  'dist/main/main/memory-index/launch-injection.test.js',
  // Memory & Lessons v2 WP-D — the recall_memory detail fetch + recall telemetry:
  // declared-pointer resolution, invalid_id/not_found/read_error structured codes,
  // escaping-pointer refusal, archived-served flag, UTF-8-safe body truncation,
  // bump-only-on-ok, and two-workspace cross-read/cross-increment isolation.
  'dist/main/main/memory-index/recall-tool.test.js',
  // Memory & Lessons v2 WP-F1 — the transactional staged multi-copy writer
  // (clean write, second-rename restore, conflict protection, shared lock) and
  // the publish_lesson state machine + launch recovery (slug/collision/conflict
  // gates, pending-insert-leaves-fs-untouched, and crash recovery from before
  // first rename / between renames / before activation).
  'dist/main/main/memory-index/staged-write.test.js',
  'dist/main/main/memory-index/publisher.test.js',
  // Memory & Lessons v2 WP-F2 — graduation recording (propose_graduation:
  // .lares/** + non-root-doc rejection, ABSENT sentinel, live-hash capture) and
  // the supervisor-only guarded migration ops: publish_lessons_batch (pending
  // rows before fs, atomic activate, whole-batch conflict unwind, launch
  // recovery forward/rollback) + replace_/restore_memory_bundle (proposed-set
  // validation, hash-guarded obsolete removal, CAS, approval gate, archive restore).
  'dist/main/main/memory-index/graduation.test.js',
  'dist/main/main/memory-index/batch-publisher.test.js',
  'dist/main/main/memory-index/bundle-migration.test.js',
  // Memory & Lessons v2 WP-H1 — the renderer-only review READ IPC: the handler
  // projects WP-B's pending queue + WP-C's index state into the summary DTO
  // (pendingCount/capPressure/capPercent/hardInvalid/runtime), bad-workspace-id
  // → empty summary without touching the store, and the plain-node isolation
  // test proving the channel is absent from every MCP toolset + api-server route.
  'dist/main/main/memory-index/memory-ipc.test.js',
  // Memory & Lessons v2 WP-H2 — deterministic janitor brief (byte-identical for
  // identical queue state, honest never-recalled/never-fired/evidence-unavailable
  // wording), the coverage-guarded firing classifier, and dispatch launching a
  // real agent via the injected user launch path with the brief as its prompt.
  'dist/main/main/memory-index/janitor-brief.test.js',
  // Memory & Lessons v2 WP-H3 — the human-only graduation apply (the ONLY
  // applier): CAS on target_hash_at_proposal, UTF-8±BOM + LF/CRLF preservation,
  // marked-append inside the Lares markers, unmarked-heading conflict, symlink/
  // escape reject, idempotency, and concurrent-proposal serialization.
  'dist/main/main/memory-index/graduation-apply.test.js',
  'scripts/memory-index.test.js',
  'scripts/memory-index-cli-generated.test.js',
  'scripts/memory-review-channel-isolation.test.js',
  'scripts/research-store-gitignore.test.js',
  // P0.3 EDR-surface lint (plans/edr-safety-hardening.md): self-test fixtures + real-tree lint.
  'scripts/check-edr-patterns.test.js',
  'scripts/mcp-dashboard.test.js',
  'dist/main/main/shared/max-readable-bytes.test.js',
  'dist/main/main/shared/path-mutability.test.js',
  'dist/main/main/shared/claude-import-resolver.test.js',
  'dist/main/main/shared/frontmatter-split.test.js',
  'dist/main/main/context-overhead/token-estimator.test.js',
  'dist/main/main/context-overhead/walk-up.test.js',
  'dist/main/main/context-overhead/context-overhead-analyzer.test.js',
  'dist/main/main/context-overhead/mcp-tool-inventory.test.js',
  // WP2 (G2) provider-aware guidance sources.
  'dist/main/main/context-overhead/guidance-sources.test.js',
  'dist/main/main/context-overhead/guidance-costing.test.js',
  // WP7 (G7) nested guidance inventory: declared scan contract, budget
  // stopped-reasons, known-vs-unknown omissions, ordering determinism.
  'dist/main/main/context-overhead/guidance-inventory.test.js',
  'dist/main/main/context-optimizer/lane-attribution.test.js',
  'dist/main/main/context-optimizer/behavior-store.test.js',
  'dist/main/main/context-optimizer/file-access-path.test.js',
  'dist/main/main/context-optimizer/file-access-matching.test.js',
  'dist/main/main/context-optimizer/resident-inventory.test.js',
  'dist/main/main/context-optimizer/config-epoch-backfill.test.js',
  'dist/main/main/context-optimizer/guidance-action-model.test.js',
  'dist/main/main/context-optimizer/occurrence-classifier.test.js',
  // WP2 (G2) audience capture-coverage never-gate.
  'dist/main/main/context-optimizer/occurrence-capture-coverage.test.js',
  // WP5 (G5) section-level liveness join: strict lattice + two-axis annotation,
  // and the preserved section identity (shared helper equivalence + regression).
  'dist/main/main/context-optimizer/section-liveness.test.js',
  'dist/main/main/context-overhead/section-identity-join.test.js',
  'dist/main/main/context-optimizer/improvisation-clusters.test.js',
  'dist/main/main/context-optimizer/attribution.test.js',
  'dist/main/main/context-optimizer/config-drift.test.js',
  'dist/main/main/context-optimizer/file-coverage.test.js',
  // WP3 (G3): hot-uncovered candidate allowlist + bounded coverageChecks,
  // recommendation-draft construction bars + target policy, engine integration.
  'dist/main/main/context-optimizer/file-coverage-hot-uncovered.test.js',
  'dist/main/main/context-optimizer/recommendation-draft.test.js',
  'dist/main/main/context-optimizer/recommendation-draft-integration.test.js',
  'dist/main/main/context-optimizer/compiler-parity-gate.test.js',
  'dist/main/main/context-optimizer/context-optimizer.test.js',
  'dist/main/main/context-optimizer/phrase-gap.test.js',
  'dist/main/main/context-optimizer/outcome-tracker.test.js',
  'dist/main/main/context-optimizer/optimizer-pipeline.test.js',
  'dist/main/main/context-optimizer/optimizer-surface.test.js',
  'dist/main/main/context-optimizer/optimizer-scaffold-registry.test.js',
  'dist/main/main/context-optimizer/optimizer-pipeline-seams.test.js',
  // WP9 (G9): sequence/co-touch + command-family association + the pinned
  // stream-identity join (incl. equivalence with optimizer-pipeline's join).
  'dist/main/main/context-optimizer/behavior-sequences.test.js',
  'dist/main/main/context-optimizer/optimizer-corpus-backfill.test.js',
  'dist/main/main/context-optimizer/agent-dto.test.js',
  'dist/main/main/context-optimizer/agent-dto-build.test.js',
  'dist/main/main/context-optimizer/agent-dto-observability.test.js',
  'dist/main/main/context-optimizer/agent-dto-acceptance.test.js',
  'dist/main/main/context-overhead/overhead-dto.test.js',
  'dist/main/main/analytics-export/analytics-exporter.test.js',
  // WP-S schema v2 migration + capability contract.
  'dist/main/main/analytics-export/analytics-schema-v2.test.js',
  // WP3 (G3): recommendation-drafts capability + proposals.csv columns + golden refresh.
  'dist/main/main/analytics-export/recommendation-drafts-export.test.js',
  // WP5 (G5): section-behavior-status capability + DTO projection + SUMMARY + golden refresh.
  'dist/main/main/analytics-export/section-behavior-export.test.js',
  // WP6 (G6): file-heat-extended capability + file-heat.csv columns + per-table
  // truncation metadata + SUMMARY section + golden refresh.
  'dist/main/main/analytics-export/file-heat-export.test.js',
  // WP8 (G8): surface-provenance capability — per-surface provenance, one
  // anchor, comparability keys, computed caveat downgrade, --window, golden.
  'dist/main/main/analytics-export/surface-provenance.test.js',
  // WP9 (G9): file-sequences capability + file-sequences.csv + redaction +
  // WP6-shaped truncation + TOOL_ERROR_RATES_UNAVAILABLE + golden refresh.
  'dist/main/main/analytics-export/file-sequences-export.test.js',
  // WP1 (G1): installation-owned snapshot launcher — argv branch purity,
  // descriptor write/heal, shim passthrough, and the (env-gated, default-skip)
  // source-mode integration run.
  'dist/main/main/analytics-export/analytics-snapshot-argv.test.js',
  'dist/main/main/installation-descriptor.test.js',
  'dist/main/main/analytics-export/analytics-snapshot-shim.test.js',
  'dist/main/main/analytics-export/analytics-snapshot-source-integration.test.js',
  'dist/main/main/api-server-overhead-route.test.js',
  'dist/main/main/api-server-checkpoints.test.js',
  'dist/main/main/agent-dto-routes.test.js',
  'dist/main/main/api-server-optimizer-routes.test.js',
  'scripts/mcp-tools-observability.test.js',
  'dist/main/main/skill-analytics/command-path-extractor.test.js',
  'dist/main/main/skill-analytics/skill-events.test.js',
  'dist/main/main/skill-analytics/mcp-toolset-map.test.js',
  'dist/main/main/skill-analytics/jsonl-scanner.test.js',
  'dist/main/main/skill-analytics/parse-runner.test.js',
  'dist/main/main/skill-analytics/parse-backfill.test.js',
  'dist/main/main/skill-analytics/queries.test.js',
  'dist/main/main/skill-analytics/mcp-tool-usage-queries.test.js',
  'dist/main/main/skill-analytics/workspace-lineage.test.js',
  'dist/main/main/skill-analytics/workspace-lineage-backfill.test.js',
  'dist/main/main/agent-knowledge/knowledge-extractor.test.js',
  'dist/main/main/agent-knowledge/knowledge-behavior-enrichment.test.js',
  'dist/main/main/orchestration/dashboard-client.test.js',
  'dist/main/main/orchestration/orchestration-binding.test.js',
  'dist/main/main/orchestration/orchestration-service.test.js',
  'dist/main/main/orchestration/groupthink-legacy.test.js',
  'dist/main/main/orchestration/groupthink-v2.test.js',
  'dist/main/main/orchestration/groupthink-pressure.test.js',
  'dist/main/main/orchestration/groupthink-plan-rail.test.js',
  'dist/main/main/plans-data-layer.test.js',
  'dist/main/main/api-server-plans.test.js',
  'dist/main/main/api-server-focus.test.js',
  'dist/main/main/plans-watcher.test.js',
  'dist/main/main/plans/plan-touch-tracker.test.js',
  'dist/main/main/plans/plan-events.test.js',
  'dist/main/main/plans/section-cache.test.js',
  'dist/main/main/plans-provenance-db.test.js',
  'dist/main/main/plans/section-reader.test.js',
  'dist/main/main/plans/section-anchors.test.js',
  'dist/main/main/plans/watch-plans.test.js',
  'dist/main/main/plans-snapshot-db.test.js',
  // Planning-surface Wave 1 — main/shared node tests landed this cycle.
  // WP-P0PRE: demand-probe append service (telemetry).
  'dist/main/main/telemetry/demand-probe.test.js',
  // WP-P0B: trusted format-gate scope (assertPlanRailFree) + read-ladder
  // enumeration bounds + the rewritten plan-rail-contract surface.
  'dist/main/main/orchestration/plan-ownership.scope.test.js',
  'dist/main/main/plans/read-ladder.test.js',
  'dist/main/main/plans/plan-rail-contract.test.js',
  // WP-P1A: planning-reader bounded enumeration + safe read IPC.
  'dist/main/main/plans/planning-reader.test.js',
  // Save-card Stage ③ SC-WP-3E — plan-lens finalize IPC facade (WP-3Z registration).
  'dist/main/main/plans/plan-ipc.finalize.test.js',
  // Planning-surface Stage P2 (gate P2Z) — folder-per-plan ingest + proposals.
  // WP-P2A: proposals table schema/accessors.
  'dist/main/main/database.proposals.test.js',
  // WP-P2B: markdown proposal-row adoption into the plans/proposals surface.
  'dist/main/main/md-row-adoption.test.js',
  // WP-P2B: proposals-watcher — .lares/proposals/*.md filesystem ingest.
  'dist/main/main/proposals-watcher.test.js',
  // WP-P2D: plan-gallery projection (date-grouped rows, type/state chips).
  'dist/main/main/plans/plan-gallery.test.js',
  // WP-P2C-compat: structured-format exclusion from the HTML plan-projection path.
  'dist/main/main/plans/structured-exclusion.test.js',
  // WP-P2B-folder: plan-folder-watcher — <workspaceStateDir()>/plans/*/ ingest.
  'dist/main/main/plans/plan-folder-watcher.test.js',
  // Planning-surface Stage P3 (gate P3Z) — proposal→promotion→dispatchable-WP.
  // WP-P3A′: responsibility + promotion_requests schema/accessors.
  'dist/main/main/database.responsibility.test.js',
  'dist/main/main/database.promotion-requests.test.js',
  // WP-P2L-schema: plan-intents table schema. WP-P4D-reply: selection-comment
  // replies DDL.
  'dist/main/main/plan-intents.schema.test.js',
  'dist/main/main/selection-comment-replies.schema.test.js',
  // WP-P3-manifest: plan.json sidecar manifest loader + TS/JS interop.
  'dist/main/main/plans/plan-manifest.test.js',
  'dist/main/main/plans/plan-manifest-interop.test.js',
  // WP-P3B-core: proposal→plan promotion core + supervisor launch binding.
  'dist/main/main/plans/promote-proposal.core.test.js',
  'dist/main/main/supervisor/promotion-launch-binding.test.js',
  // WP-P3B-enrich: post-adoption enrichment (single source-proposal plan_documents row).
  'dist/main/main/plans/promote-proposal.enrich.test.js',
  // WP-P3-reconcile: pending-promotion startup reconstruction.
  'dist/main/main/plans/promotion-reconciler.test.js',
  // WP-P3C′: proposal:promote / proposal:promotionStatus IPC.
  'dist/main/main/plans/proposal-promote-ipc.test.js',
  // WP-P3-wire: promotion claim-scan + service wiring.
  'dist/main/main/plans/promotion-claim-scan.test.js',
  'dist/main/main/plans/promotion-service-wiring.test.js',
  // WP-P2L-ingest: transactional plan-intent ledger scan.
  'dist/main/main/plans/plan-intent-ledger.test.js',
  // WP-P2L-runs: orchestration run links witness the active planning intent.
  'dist/main/main/plans/plan-intent-runs.test.js',
  // WP-P2L-proj: derived plan-intent confidence projection + IPC.
  'dist/main/main/plans/plan-intent-proj.test.js',
  // Planning-surface Stage P4 (gate P4Z) — folder-native tabbed document home +
  // intent lifecycle + overviews + comments.
  // WP-P4A: folder-native tab-model projection (ARC→overview; plan.json/.gitkeep
  // suppressed; membership check; guarded plan_work_packages populated flag).
  'dist/main/main/plans/plan-documents.test.js',
  // WP-P4C-backend: per-tab overview accessors + IPC, keyed to PlanTabKey.
  'dist/main/main/plans/plan-overview.test.js',
  // WP-P4D-create: plan-comment create + routing (durable lares-plan-doc:v1
  // logical-key identity; plan-aware send adapter).
  'dist/main/main/plans/plan-comment-create.test.js',
  // WP-P4D-reply: companion replies table + answer_plan_comment service.
  'dist/main/main/plans/plan-comment-reply.test.js',
  // WP-P4D-proj: dual-source plan-comment projection (logical-key resolution).
  'dist/main/main/plans/plan-comment-list.test.js',
  // Planning-surface Stage P5 (gate P5Z) — work-package layout + lifecycle ledger,
  // execution-run baselines, Implement trigger, pre-Implement gate, gated dispatch
  // defaults, and persisted package dispatch/reconciliation.
  // WP-P5A-schema/paths: plan_work_package_layout + plan_work_package_paths schema/accessors.
  'dist/main/main/database.planWorkPackageLayoutPaths.test.js',
  // WP-P5B: lifecycle-event service (ready/executing/blocked/archived ledger) + Mark-Ready.
  'dist/main/main/plans/plan-lifecycle.test.js',
  // WP-P5C: durable execution-run baseline refs (refs/lares/plans/<planId>/<runId>).
  'dist/main/main/git-checkpoints/plan-baseline-refs.test.js',
  // WP-P5C: Implement eligibility + execution-run mint + baseline pin (human-gated).
  'dist/main/main/plans/plan-implement.test.js',
  // WP-P5-archive: plan archive / resurrection / re-Implement (new run + fresh baseline).
  'dist/main/main/plans/plan-archive.test.js',
  // WP-P5C-gate: pre-Implement enforcement seam — reject structured-plan bindings
  // (explicit or default) before an active execution run.
  'dist/main/main/git-checkpoints/pre-implement-gate.test.js',
  // WP-P5D: gated dispatch default — active plan binds only while its run is executing.
  'dist/main/main/git-checkpoints/dispatch-default.activePlan.test.js',
  // WP-P5-dispatch: package dispatch + persisted attempt/reconciliation (confirmed_turn_id).
  'dist/main/main/plans/package-dispatch.test.js',
  'dist/main/main/browser/credentialed-open-diagnostic.test.js',
  'dist/main/main/browser/browser-signin-workspace-exact.test.js',
  'dist/main/main/browser/browser-signin-expiry.test.js',
  'dist/main/main/browser/browser-signin-migration.test.js',
  'dist/main/main/browser/browser-signin-integration.test.js',
  'dist/main/main/browser/signin-site-adapters.test.js',
  'dist/main/main/spellcheck-context-menu.test.js',
]

let failed = null
const electronRuntime = path.resolve(
  'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'
)
for (const file of TESTS) {
  // The agy reader exercises production's better-sqlite3 binding, which is
  // compiled for Electron's ABI. Run that suite with the bundled Electron in
  // Node mode; every JS-only main test keeps the faster host-Node path.
  const nativeElectronTest = file.endsWith('/agy-session-reader.test.js')
  const r = spawnSync(nativeElectronTest ? electronRuntime : process.execPath, [file], {
    stdio: 'inherit',
    env: nativeElectronTest ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  })
  if (r.status !== 0) {
    failed = file
    break
  }
}

if (failed) {
  console.error(`\nx main-test suite failed at: ${failed}`)
  process.exit(1)
}
console.log(`\nmain-test suite: ${TESTS.length} test files passed`)
