// Codex git-discard guard delivery tests — the PreToolUse guard must ride the
// CODEX_HOME `--profile dashboard-worker` file, NOT the worker-cwd
// .lares/workers/codex/.codex/config.toml (which Codex never loads for an
// untrusted project, so its hook blocks are INERT).
//
// Covers:
//   1. CODEX_WORKER_PROFILE_TOML declares a PreToolUse hook, and after __SCRIPT__
//      + __GUARD__ substitution parseCodexProfileHooks returns ALL 4 hooks
//      (stop / user_prompt_submit / session_start / pre_tool_use) pointing at the
//      right scripts.
//   2. The Windows writer (ensureCodexHookProfile) writes BOTH scripts into
//      CODEX_HOME and seeds trust for all 4 hooks.
//   3. The WSL writer builds a bash command that (re)writes BOTH scripts on the
//      trust-intact fast path, and both scripts + the profile on the re-seed path.
//   4. Trust seeding still holds with 4 hooks: a fully-seeded profile is
//      trust-intact; adding a hook makes it NOT intact (→ re-seed, no stall).
//   5. INVARIANT (regression for this exact defect): every hook event declared in
//      the worker-cwd WORKER_CODEX_CONFIG_TOML is also declared in the profile —
//      codex hooks live in the profile, never only in the cwd config.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/codex-guard-hook-profile.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_WORKER_PROFILE_TOML,
  WORKER_CODEX_CONFIG_TOML,
  DASHBOARD_STATUS_SCRIPT_MJS,
  GUARD_GIT_DISCARD_MJS,
} from '../../shared/constants';
import {
  AgentSupervisor,
  parseCodexProfileHooks,
  codexProfileTrustIntact,
  buildCodexHooksStateSection,
  buildCodexWslProfileWriteCmd,
} from './index';

interface TestCase { name: string; run(): void }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Extract the set of `[[hooks.<Event>]]` event names declared in a TOML body
 *  (the outer hook-table headers, NOT the inner `[[hooks.X.hooks]]`). */
function hookEvents(toml: string): Set<string> {
  const set = new Set<string>();
  for (const m of toml.matchAll(/^\[\[hooks\.([A-Za-z]+)\]\]$/gm)) set.add(m[1]);
  return set;
}

// ── 1. Profile declares PreToolUse → guard; 4 hooks after substitution ──────

test('1a. profile declares a [[hooks.PreToolUse]] block pointing at __GUARD__', () => {
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('[[hooks.PreToolUse]]'), 'profile missing [[hooks.PreToolUse]]');
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('[[hooks.PreToolUse.hooks]]'), 'profile missing [[hooks.PreToolUse.hooks]]');
  assert.ok(
    /command = 'node "__GUARD__"'/.test(CODEX_WORKER_PROFILE_TOML),
    `PreToolUse command must invoke node "__GUARD__"; got:\n${CODEX_WORKER_PROFILE_TOML}`,
  );
  // __GUARD__ must be a SEPARATE placeholder from __SCRIPT__ so the guard path
  // substitutes independently of the status script.
  assert.ok(CODEX_WORKER_PROFILE_TOML.includes('__SCRIPT__'), 'profile lost the __SCRIPT__ placeholder');
  assert.notEqual(
    CODEX_WORKER_PROFILE_TOML.indexOf('__GUARD__'), -1,
    'profile missing the __GUARD__ placeholder',
  );
});

test('1b. after substitution parseCodexProfileHooks returns all 4 hooks with correct scripts', () => {
  const body = CODEX_WORKER_PROFILE_TOML
    .replace(/__SCRIPT__/g, '/codex-home/dashboard-status.mjs')
    .replace(/__GUARD__/g, '/codex-home/guard-git-discard.mjs');
  const hooks = parseCodexProfileHooks(body);
  const byEvent = new Map(hooks.map((h) => [h.event, h.command]));
  assert.equal(hooks.length, 4, `expected exactly 4 hooks; got ${hooks.length}: ${JSON.stringify(hooks)}`);
  assert.deepEqual(
    new Set(byEvent.keys()),
    new Set(['stop', 'user_prompt_submit', 'session_start', 'pre_tool_use']),
    'profile must install stop/user_prompt_submit/session_start/pre_tool_use hooks',
  );
  // The pre_tool_use hook must point at the GUARD script, not the status script.
  const guardCmd = byEvent.get('pre_tool_use')!;
  assert.ok(/guard-git-discard\.mjs/.test(guardCmd), `pre_tool_use must call guard-git-discard.mjs; got: ${guardCmd}`);
  assert.ok(!/dashboard-status\.mjs/.test(guardCmd), `pre_tool_use must NOT call dashboard-status.mjs; got: ${guardCmd}`);
  // The status hooks must NOT accidentally have been rewritten to the guard.
  assert.ok(/dashboard-status\.mjs/.test(byEvent.get('stop')!), 'stop hook must still call dashboard-status.mjs');
});

// ── 2. Windows writer writes BOTH scripts + seeds trust for 4 hooks ─────────

test('2. Windows ensureCodexHookProfile writes dashboard-status.mjs AND guard-git-discard.mjs + seeds 4 hooks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;
  try {
    const sup = new AgentSupervisor();
    (sup as unknown as { ensureCodexHookProfile(pt: string): void }).ensureCodexHookProfile('windows');

    const statusPath = path.join(tmp, 'dashboard-status.mjs');
    const guardPath = path.join(tmp, 'guard-git-discard.mjs');
    assert.ok(fs.existsSync(statusPath), 'dashboard-status.mjs must be written into CODEX_HOME');
    assert.ok(fs.existsSync(guardPath), 'guard-git-discard.mjs must be written into CODEX_HOME (the defect: it was not)');
    assert.equal(fs.readFileSync(guardPath, 'utf-8'), GUARD_GIT_DISCARD_MJS, 'guard bytes must match the bundled constant');
    assert.equal(fs.readFileSync(statusPath, 'utf-8'), DASHBOARD_STATUS_SCRIPT_MJS, 'status bytes must match the bundled constant');

    const profile = fs.readFileSync(path.join(tmp, 'dashboard-worker.config.toml'), 'utf-8');
    assert.ok(profile.includes('[[hooks.PreToolUse]]'), 'written profile missing [[hooks.PreToolUse]]');
    // __GUARD__ must have been substituted with the real (forward-slashed) guard path.
    assert.ok(!profile.includes('__GUARD__'), 'written profile still has an unsubstituted __GUARD__');
    assert.ok(!profile.includes('__SCRIPT__'), 'written profile still has an unsubstituted __SCRIPT__');
    assert.ok(
      profile.includes(guardPath.replace(/\\/g, '/')),
      `written profile PreToolUse must point at the guard path; profile:\n${profile}`,
    );
    // Trust seeded for the new hook so a launch never stalls at the trust panel.
    assert.ok(profile.includes(':pre_tool_use:0:0'), 'profile [hooks.state] must seed the pre_tool_use trust key');
    const hashLines = [...profile.matchAll(/trusted_hash = "/g)];
    assert.equal(hashLines.length, 4, `all 4 hooks must be trust-seeded; got ${hashLines.length}`);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. WSL writer command writes BOTH scripts on both branches ──────────────

test('3a. WSL trust-intact command (re)writes BOTH scripts and NOT the profile', () => {
  const cmd = buildCodexWslProfileWriteCmd({
    codexHome: '/home/u/.codex',
    scriptPosix: '/home/u/.codex/dashboard-status.mjs',
    guardPosix: '/home/u/.codex/guard-git-discard.mjs',
    profilePath: '/home/u/.codex/dashboard-worker.config.toml',
    b64Script: 'U0NSSVBU',
    b64Guard: 'R1VBUkQ=',
    // no b64Profile → trust-intact fast path
  });
  assert.ok(cmd.includes('> "/home/u/.codex/dashboard-status.mjs"'), 'trust-intact must write the status script');
  assert.ok(cmd.includes('> "/home/u/.codex/guard-git-discard.mjs"'), 'trust-intact must ALSO write the guard script');
  assert.ok(!cmd.includes('dashboard-worker.config.toml'), 'trust-intact must NOT rewrite the seeded profile');
});

test('3b. WSL re-seed command writes BOTH scripts AND the profile', () => {
  const cmd = buildCodexWslProfileWriteCmd({
    codexHome: '/home/u/.codex',
    scriptPosix: '/home/u/.codex/dashboard-status.mjs',
    guardPosix: '/home/u/.codex/guard-git-discard.mjs',
    profilePath: '/home/u/.codex/dashboard-worker.config.toml',
    b64Script: 'U0NSSVBU',
    b64Guard: 'R1VBUkQ=',
    b64Profile: 'UFJPRklMRQ==',
  });
  assert.ok(cmd.includes('> "/home/u/.codex/dashboard-status.mjs"'), 're-seed must write the status script');
  assert.ok(cmd.includes('> "/home/u/.codex/guard-git-discard.mjs"'), 're-seed must write the guard script');
  assert.ok(cmd.includes('> "/home/u/.codex/dashboard-worker.config.toml"'), 're-seed must write the profile');
});

// ── 4. Trust seeding holds with 4 hooks (no launch-time stall) ──────────────

test('4. a fully-seeded 4-hook profile is trust-intact; adding a hook is NOT (→ re-seed)', () => {
  const body = CODEX_WORKER_PROFILE_TOML
    .replace(/__SCRIPT__/g, '/h/dashboard-status.mjs')
    .replace(/__GUARD__/g, '/h/guard-git-discard.mjs');
  const hooks = parseCodexProfileHooks(body);
  const seeded = body + buildCodexHooksStateSection('/h/dashboard-worker.config.toml', hooks);
  assert.equal(hooks.length, 4, 'sanity: 4 hooks parsed');
  assert.equal(codexProfileTrustIntact(seeded, body, hooks), true, 'a fully-seeded 4-hook profile must be trust-intact');

  // A profile missing the pre_tool_use trust hash (e.g. a pre-guard on-disk
  // file) must NOT be considered intact — the writer must re-seed, or the guard
  // hook would gate at the interactive trust panel forever.
  const preGuardHooks = hooks.filter((h) => h.event !== 'pre_tool_use');
  const preGuardSeeded = body + buildCodexHooksStateSection('/h/dashboard-worker.config.toml', preGuardHooks);
  assert.equal(
    codexProfileTrustIntact(preGuardSeeded, body, hooks), false,
    'a profile whose new pre_tool_use hook is not yet trusted must NOT be trust-intact',
  );
});

// ── 5. INVARIANT: codex hooks live in the profile, not the cwd config ───────

test('5. every hook event declared in WORKER_CODEX_CONFIG_TOML is also in the profile (the DEFECT guard)', () => {
  const cwdEvents = hookEvents(WORKER_CODEX_CONFIG_TOML);
  const profileEvents = hookEvents(CODEX_WORKER_PROFILE_TOML);
  assert.ok(cwdEvents.size > 0, 'sanity: the cwd config declares at least one hook event');
  const missing = [...cwdEvents].filter((e) => !profileEvents.has(e));
  assert.deepEqual(
    missing, [],
    `Codex loads hooks from the CODEX_HOME profile, NOT the worker-cwd config.toml. ` +
    `These hook events are declared in WORKER_CODEX_CONFIG_TOML but MISSING from ` +
    `CODEX_WORKER_PROFILE_TOML, so they would be silently INERT: ${missing.join(', ')}`,
  );
  // In particular the git-discard guard must be present in the profile.
  assert.ok(profileEvents.has('PreToolUse'), 'the profile must declare the PreToolUse git-discard guard');
});

// ── Runner ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); passed++; }
  catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err && (err as Error).stack ? (err as Error).stack : err);
    failed++;
  }
}
console.log(`\ncodex-guard-hook-profile: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
