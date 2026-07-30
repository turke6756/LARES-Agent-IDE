// Hook-status-detection P0 tests — HOOK_SYSTEM_DESIGN.md §§A,C.
//
// Covers:
//   1. SessionStart hook present in BOTH provider configs (Claude settings.json,
//      Codex worker config.toml) and the Codex CODEX_HOME profile.
//   2. Codex feature gate ([features] hooks = true) present AND top-level in the
//      Codex profile; deprecated codex_hooks key absent.
//   3. B2: instrumentCodexWorkerCommand injects --profile/--bypass flags into a
//      custom codex command, is idempotent when already present, and reports
//      instrumented:false on an un-instrumentable command (→ caller marks the
//      agent hook_status='degraded').
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/hook-status-detection.test.js

import assert from 'node:assert/strict';
import {
  WORKER_CLAUDE_SETTINGS_JSON,
  WORKER_CODEX_CONFIG_TOML,
  CODEX_WORKER_PROFILE_TOML,
  CODEX_WORKER_PROFILE_NAME,
} from '../../shared/constants';
import { instrumentCodexWorkerCommand } from './index';
import { deriveHookAvailability } from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── A. SessionStart hook present in both provider configs ─────────────

test('A1. Claude worker settings.json has a SessionStart hook → dashboard-status.mjs session-start', () => {
  const parsed = JSON.parse(WORKER_CLAUDE_SETTINGS_JSON) as {
    hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  };
  const sessionStart = parsed.hooks?.SessionStart;
  assert.ok(Array.isArray(sessionStart) && sessionStart.length > 0, 'SessionStart hook array must be present');
  const cmd = sessionStart![0].hooks[0].command;
  assert.ok(/dashboard-status\.mjs/.test(cmd), `SessionStart command must call dashboard-status.mjs; got: ${cmd}`);
  assert.ok(/\bsession-start\b/.test(cmd), `SessionStart command must pass the session-start arg; got: ${cmd}`);
  // The session-start hook must NOT pass the 'working' arg (that would flip status).
  assert.ok(!/\bworking\b/.test(cmd), `SessionStart command must not pass 'working'; got: ${cmd}`);
});

test('A2. Codex worker config.toml has a SessionStart hook → dashboard-status.mjs session-start', () => {
  assert.ok(WORKER_CODEX_CONFIG_TOML.includes('[[hooks.SessionStart]]'), 'config.toml missing [[hooks.SessionStart]]');
  assert.ok(WORKER_CODEX_CONFIG_TOML.includes('[[hooks.SessionStart.hooks]]'), 'config.toml missing [[hooks.SessionStart.hooks]]');
  assert.ok(
    /dashboard-status\.mjs" session-start/.test(WORKER_CODEX_CONFIG_TOML),
    `config.toml SessionStart command must pass session-start; got:\n${WORKER_CODEX_CONFIG_TOML}`,
  );
});

test('A2b. Path A: worker-cwd config.toml carries the feature gate + PreToolUse guard + all script paths', () => {
  // On native Windows this file is the SOLE hook carrier (no profile layer), so
  // it must supply [features] hooks = true itself, top-level (not nested under a
  // [profiles.*] table), using the current key (not the deprecated codex_hooks).
  assert.ok(/^\[features\]$/m.test(WORKER_CODEX_CONFIG_TOML), '[features] must be a top-level table header on its own line');
  assert.ok(/\[features\]\s*\nhooks = true/.test(WORKER_CODEX_CONFIG_TOML), 'config.toml missing hooks = true directly under [features]');
  assert.ok(!/^\s*\[profiles?\./m.test(WORKER_CODEX_CONFIG_TOML), 'worker-cwd config must NOT nest config under a [profiles.*] table');
  assert.ok(!/codex_hooks\s*=/.test(WORKER_CODEX_CONFIG_TOML), 'config.toml must NOT assign the deprecated codex_hooks key');
  // Everything the profile carried must be present here.
  assert.ok(WORKER_CODEX_CONFIG_TOML.includes('[[hooks.PreToolUse]]'), 'config.toml missing the PreToolUse guard block');
  assert.ok(/guard-git-discard\.mjs/.test(WORKER_CODEX_CONFIG_TOML), 'config.toml PreToolUse must call guard-git-discard.mjs');
  assert.ok(WORKER_CODEX_CONFIG_TOML.includes('[[hooks.Stop]]'), 'config.toml missing [[hooks.Stop]]');
  assert.ok(WORKER_CODEX_CONFIG_TOML.includes('[[hooks.UserPromptSubmit]]'), 'config.toml missing [[hooks.UserPromptSubmit]]');
  // The stale "INERT / Codex NEVER loads this" header must be gone.
  assert.ok(!/NEVER loads this/.test(WORKER_CODEX_CONFIG_TOML), 'the stale INERT header must be rewritten for Path A');
});

test('A3. Codex CODEX_HOME profile has a SessionStart hook → __SCRIPT__ session-start', () => {
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('[[hooks.SessionStart]]'), 'profile missing [[hooks.SessionStart]]');
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('[[hooks.SessionStart.hooks]]'), 'profile missing [[hooks.SessionStart.hooks]]');
  assert.ok(
    /__SCRIPT__" session-start/.test(CODEX_WORKER_PROFILE_TOML),
    `profile SessionStart command must pass session-start; got:\n${CODEX_WORKER_PROFILE_TOML}`,
  );
  // All Codex hook timeouts must stay 30 (= 30 SECONDS in Codex's schema —
  // see HOOK_SYSTEM_DESIGN research corrections). Nothing should be bumped.
  const timeouts = [...CODEX_WORKER_PROFILE_TOML.matchAll(/timeout = (\d+)/g)].map((m) => m[1]);
  assert.ok(timeouts.length >= 3, `expected ≥3 timeout entries (Stop/UserPromptSubmit/SessionStart); got: ${timeouts.join(',')}`);
  assert.ok(timeouts.every((t) => t === '30'), `all hook timeouts must be 30; got: ${timeouts.join(',')}`);
});

// ── B1. Codex feature gate present AND top-level ──────────────────────

test('B1. Codex profile sets [features] hooks = true at top level (no codex_hooks, not nested)', () => {
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('[features]'), 'profile missing [features] table');
  assert.ok(/\[features\]\s*\nhooks = true/.test(CODEX_WORKER_PROFILE_TOML), 'profile missing hooks = true directly under [features]');
  // Top-level proof: there is no [profiles.*] table HEADER the [features] table
  // could be nested under. (A profile file loaded via --profile carries
  // top-level keys, so any [profiles.x] header would be wrong here.) Match only
  // real line-start table headers so prose mentioning [profiles.*] doesn't trip.
  assert.ok(!/^\s*\[profiles?\./m.test(CODEX_WORKER_PROFILE_TOML), 'profile must NOT nest config under a [profiles.*] table');
  // And [features] itself must be a line-start header, not buried in prose.
  assert.ok(/^\[features\]$/m.test(CODEX_WORKER_PROFILE_TOML), '[features] must be a top-level table header on its own line');
  // The deprecated key must never be USED (a key assignment or table header).
  // Match real usage, not prose that merely names it.
  assert.ok(!/codex_hooks\s*=/.test(CODEX_WORKER_PROFILE_TOML), 'profile must NOT assign the deprecated codex_hooks key');
  assert.ok(!/^\s*\[[^\]]*codex_hooks/m.test(CODEX_WORKER_PROFILE_TOML), 'profile must NOT use a codex_hooks table');
});

// ── B2. Custom-command instrumentation ────────────────────────────────
//
// Two modes (see instrumentCodexWorkerCommand):
//   • default / injectProfile:true — WSL workers + codex personas: inject BOTH
//     --profile dashboard-worker AND --dangerously-bypass-hook-trust. (B2a–B2f.)
//   • injectProfile:false — Path A native-Windows WORKER lane: hooks ride the
//     worker-cwd trusted-project config.toml, so inject ONLY the bypass flag and
//     STRIP any --profile dashboard-worker (Run D: layers merge → double-fire).
//     (B2g–B2l.)

test('B2a. injects both flags into the pristine default codex command', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand('codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(instrumented, true);
  assert.ok(command.includes(`--profile ${CODEX_WORKER_PROFILE_NAME}`), `missing --profile; got: ${command}`);
  assert.ok(command.includes('--dangerously-bypass-hook-trust'), `missing bypass flag; got: ${command}`);
  // Flags bind to codex (ahead of the original flags), and the original flag survives.
  assert.ok(command.includes('--dangerously-bypass-approvals-and-sandbox'), 'original flag must survive');
});

test('B2b. injects flags AFTER the launcher token, ahead of a subcommand (resume)', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand('ccodex --dangerously-bypass-approvals-and-sandbox resume 0xabc');
  assert.equal(instrumented, true);
  const profIdx = command.indexOf(`--profile ${CODEX_WORKER_PROFILE_NAME}`);
  const resumeIdx = command.indexOf('resume');
  assert.ok(profIdx > -1 && resumeIdx > -1, `both tokens present; got: ${command}`);
  assert.ok(profIdx < resumeIdx, `--profile must precede the resume subcommand; got: ${command}`);
  // The launcher token must stay first.
  assert.ok(command.startsWith('ccodex '), `launcher token must stay first; got: ${command}`);
});

test('B2c. idempotent — does not double-inject when both flags already present', () => {
  const already = `codex --profile ${CODEX_WORKER_PROFILE_NAME} --dangerously-bypass-hook-trust`;
  const { command, instrumented } = instrumentCodexWorkerCommand(already);
  assert.equal(instrumented, true);
  assert.equal(command, already, 'command must be unchanged when already instrumented');
  const profileCount = (command.match(new RegExp(`--profile ${CODEX_WORKER_PROFILE_NAME}`, 'g')) || []).length;
  assert.equal(profileCount, 1, 'must not duplicate the --profile flag');
});

test('B2d. fills only the MISSING flag when one is already present', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand(`codex --profile ${CODEX_WORKER_PROFILE_NAME}`);
  assert.equal(instrumented, true);
  assert.ok(command.includes('--dangerously-bypass-hook-trust'), `bypass flag must be added; got: ${command}`);
  const profileCount = (command.match(new RegExp(`--profile ${CODEX_WORKER_PROFILE_NAME}`, 'g')) || []).length;
  assert.equal(profileCount, 1, 'must not duplicate the existing --profile flag');
});

test('B2e. un-instrumentable command (not recognizably codex) → instrumented:false (caller marks degraded)', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand('my-codex-wrapper.sh --go');
  assert.equal(instrumented, false, 'a non-codex launcher must report instrumented:false');
  assert.equal(command, 'my-codex-wrapper.sh --go', 'command must be returned unchanged');
});

test('B2f. foreign --profile we must not clobber → instrumented:false (caller marks degraded)', () => {
  const { instrumented } = instrumentCodexWorkerCommand('codex --profile someones-custom-profile');
  assert.equal(instrumented, false, 'a foreign --profile must report instrumented:false rather than be clobbered');
});

// ── B2 Path A (injectProfile:false) — native-Windows worker lane ──────

test('B2g. Path A: pristine default gets ONLY the bypass flag, never --profile', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand(
    'codex --dangerously-bypass-approvals-and-sandbox', { injectProfile: false });
  assert.equal(instrumented, true);
  assert.ok(!/--profile/.test(command), `Path A must NOT inject --profile; got: ${command}`);
  assert.ok(command.includes('--dangerously-bypass-hook-trust'), `bypass flag must be present; got: ${command}`);
  assert.ok(command.includes('--dangerously-bypass-approvals-and-sandbox'), 'original flag must survive');
});

test('B2h. Path A: bypass binds after the launcher token, ahead of a subcommand (resume)', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand(
    'ccodex --dangerously-bypass-approvals-and-sandbox resume 0xabc', { injectProfile: false });
  assert.equal(instrumented, true);
  const bypassIdx = command.indexOf('--dangerously-bypass-hook-trust');
  const resumeIdx = command.indexOf('resume');
  assert.ok(bypassIdx > -1 && resumeIdx > -1, `both tokens present; got: ${command}`);
  assert.ok(bypassIdx < resumeIdx, `bypass must precede the resume subcommand; got: ${command}`);
  assert.ok(command.startsWith('ccodex '), `launcher token must stay first; got: ${command}`);
});

test('B2i. Path A: STRIPS a stored/legacy --profile dashboard-worker (Run D double-fire)', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand(
    `codex --profile ${CODEX_WORKER_PROFILE_NAME} --dangerously-bypass-hook-trust`, { injectProfile: false });
  assert.equal(instrumented, true);
  assert.ok(!/--profile/.test(command), `Path A must strip our --profile; got: ${command}`);
  assert.ok(command.includes('--dangerously-bypass-hook-trust'), 'the bypass flag must survive the strip');
});

test('B2j. Path A: idempotent — bypass present, no profile → unchanged', () => {
  const already = 'codex --dangerously-bypass-hook-trust';
  const { command, instrumented } = instrumentCodexWorkerCommand(already, { injectProfile: false });
  assert.equal(instrumented, true);
  assert.equal(command, already, 'a command already in Path A shape must be returned unchanged');
});

test('B2k. Path A: a foreign --profile still degrades (instrumented:false)', () => {
  const { instrumented } = instrumentCodexWorkerCommand(
    'codex --profile someones-custom-profile', { injectProfile: false });
  assert.equal(instrumented, false, 'a foreign --profile is un-reasonable-about in Path A too → degrade');
});

test('B2l. Path A: un-instrumentable (not recognizably codex) → instrumented:false', () => {
  const { command, instrumented } = instrumentCodexWorkerCommand('my-codex-wrapper.sh --go', { injectProfile: false });
  assert.equal(instrumented, false);
  assert.equal(command, 'my-codex-wrapper.sh --go', 'command must be returned unchanged');
});

// ── WP2. deriveHookAvailability — the DTO projection of hook_status ───

test('WP2a. broken → hooksUnavailable with reason canary-timeout', () => {
  const d = deriveHookAvailability('broken');
  assert.equal(d.hooksUnavailable, true, 'broken hooks are unavailable');
  assert.equal(d.hooksUnavailableReason, 'canary-timeout');
});

test('WP2b. degraded → hooksUnavailable with reason instrumentation-unavailable', () => {
  const d = deriveHookAvailability('degraded');
  assert.equal(d.hooksUnavailable, true, 'degraded hooks are unavailable for UI/fallback');
  assert.equal(d.hooksUnavailableReason, 'instrumentation-unavailable');
});

test('WP2c. healthy / unknown / undefined → hooks available, no reason', () => {
  for (const hs of ['healthy', 'unknown', undefined] as const) {
    const d = deriveHookAvailability(hs);
    assert.equal(d.hooksUnavailable, false, `hooks available for ${hs}`);
    assert.equal(d.hooksUnavailableReason, undefined, `no reason for ${hs}`);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
