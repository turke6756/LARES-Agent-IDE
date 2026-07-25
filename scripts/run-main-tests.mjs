#!/usr/bin/env node
// Runs the main-process test suite.
//
// The list lives here as data rather than as a `node a && node b && ...` chain
// in package.json: at ~150 files that chain overruns the Windows command-line
// limit (8191 chars) and the suite dies before running a single test.
//
// Add new main-process test files to TESTS below.

import { spawnSync } from 'node:child_process'

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
  'dist/main/main/supervisor/claude-clear-rotation.test.js',
  'dist/main/main/supervisor/claude-clear-rotation-integration.test.js',
  'dist/main/main/supervisor/claude-clear-rotation-supervisor.test.js',
  'dist/main/main/supervisor/log-readers/claude-jsonl-reader.test.js',
  'dist/main/main/supervisor/log-readers/codex-rollout-reader.test.js',
  'dist/main/main/supervisor/log-readers/gemini-transcript-reader.test.js',
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
  // Context Window Warning: per-role gauge-cap settings + resolution.
  'dist/main/main/context-gauge/context-gauge-settings.test.js',
  // System-Memory polish: commit attribution completeness + composed view DTO
  // + the getActiveAgents live-registry predicate.
  'dist/main/main/watchdog/attribution.test.js',
  'dist/main/main/watchdog/attribution-service.test.js',
  'dist/main/main/watchdog/system-memory-view.test.js',
  'dist/main/main/database.active-agents.test.js',
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
  // Git-Native WP-G1.8: ref/DB crash-consistency reconciliation (create/adopt/conflict
  // on real git) + dangling-open close + paired-ref deletion + temp-artifact sweeper.
  'dist/main/main/git-checkpoints/reconciler.test.js',
  // Git-Native WP-G1.7: witness-join recorder + DB choke point (above the live-cache
  // dedupe), dispatch-context builder, and the send-queue → before-checkpoint wiring.
  'dist/main/main/git-checkpoints/witness-recorder.test.js',
  'dist/main/main/git-checkpoints/dispatch-context.test.js',
  'dist/main/main/supervisor/send-queue-checkpoint.test.js',
  'dist/main/main/supervisor/initial-user-prompt.test.js',
  'dist/main/main/supervisor/hook-spool-tailer.test.js',
  'dist/main/main/supervisor/send-input-encoder.test.js',
  'dist/main/main/supervisor/key-bytes.test.js',
  'dist/main/main/supervisor/worker-scaffold.test.js',
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
  'dist/main/main/supervisor/handoff-handshake.test.js',
  'dist/main/main/supervisor/hook-status-detection.test.js',
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
  'dist/main/main/api-identity.test.js',
  'dist/main/main/api-codex-session-bind.test.js',
  'dist/main/main/continuation-lifecycle.test.js',
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
  'dist/main/main/browser/credentialed-open-diagnostic.test.js',
  'dist/main/main/browser/browser-signin-workspace-exact.test.js',
  'dist/main/main/browser/browser-signin-expiry.test.js',
  'dist/main/main/browser/browser-signin-migration.test.js',
  'dist/main/main/browser/browser-signin-integration.test.js',
  'dist/main/main/browser/signin-site-adapters.test.js',
  'dist/main/main/spellcheck-context-menu.test.js',
]

let failed = null
for (const file of TESTS) {
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' })
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
