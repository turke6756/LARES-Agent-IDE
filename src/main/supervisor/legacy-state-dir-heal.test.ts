// Lares-rename regression tests — healLegacyStateDirScaffold.
//
// Defect (live regression, 2026-07-22): the one-time `.dashboard/` → `.lares/`
// state-dir rename moved `.claude/settings.json` + the shared hook script out
// from under every PRE-RENAME agent, whose persisted working_directory keeps
// the legacy spelling on purpose (the Claude project slug — and session
// resume — derives from the cwd). A relaunch/reconcile then re-created the
// legacy folder EMPTY (mkdir + sysprompt only), so Claude Code ran with NO
// hooks: agent-card status froze (hook-owned lanes have PTY inference
// disabled) and sendInput's submit confirmation timed out → a false
// "Send failed" on every successfully delivered chat message.
//
// The fix: at launch, when an agent's cwd carries the legacy spelling while
// the workspace resolves to `.lares/`, write any MISSING lane scaffold files
// into the legacy-spelling location (existence-only — never overwrite, never
// touch the version sidecar).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/legacy-state-dir-heal.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import {
  workspaceStateDirName,
  resetWorkspaceStateDirCacheForTests,
} from '../workspace-state-dir';
import type { Agent } from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Test helpers ─────────────────────────────────────────────────────

function patchDb(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  return () => { db.addEvent = origAddEvent; };
}

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
}
function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

interface SupervisorTestSurface {
  healLegacyStateDirScaffold(agent: Agent, pathType: string): void;
}

function makeSupervisor(): { supervisor: SupervisorTestSurface; cleanup: () => void } {
  const restoreDb = patchDb();
  const raw = new AgentSupervisor();
  (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const supervisor = raw as unknown as SupervisorTestSurface;
  return { supervisor, cleanup: restoreDb };
}

function fakeAgent(workingDirectory: string): Agent {
  return {
    id: 'agent-heal-test',
    workingDirectory,
  } as unknown as Agent;
}

/** A migrated workspace: `.lares/` exists (post-rename), and the agent's
 *  legacy cwd exists as the empty husk a relaunch re-creates. */
function makeMigratedRoot(lane: string): string {
  const root = mktmp('heal');
  fs.mkdirSync(path.join(root, '.lares'), { recursive: true });
  fs.mkdirSync(path.join(root, '.dashboard', ...lane.split('/'), '.claude'), { recursive: true });
  return root;
}

// ── Tests ────────────────────────────────────────────────────────────

test('defect lock: relaunched pre-rename supervisor regains settings.json + hook script in its legacy cwd', () => {
  resetWorkspaceStateDirCacheForTests();
  const root = makeMigratedRoot('supervisor');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const agent = fakeAgent(path.join(root, '.dashboard', 'supervisor'));
    supervisor.healLegacyStateDirScaffold(agent, 'windows');

    const settings = path.join(root, '.dashboard', 'supervisor', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settings), 'supervisor settings.json must be healed into the legacy cwd');
    const content = fs.readFileSync(settings, 'utf-8');
    assert.ok(
      /dashboard-status\.mjs/.test(content),
      'healed settings.json must carry the status hooks',
    );
    assert.ok(
      fs.existsSync(path.join(root, '.dashboard', 'scripts', 'dashboard-status.mjs')),
      'the shared hook script must exist where the legacy hooks resolve it (../scripts)',
    );
    assert.ok(
      fs.existsSync(path.join(root, '.dashboard', 'supervisor', 'CLAUDE.md')),
      'lane CLAUDE.md healed too (native system instructions)',
    );
    // Existence-only heal: the version sidecar is NOT written — the live
    // `.lares/` copies keep sole ownership of version migration.
    assert.ok(
      !fs.existsSync(path.join(root, '.lares', '.scaffold-versions.json')),
      'heal must not create/write the scaffold version sidecar',
    );
  } finally {
    cleanup();
    rmrf(root);
  }
});

test('defect lock: pre-rename claude worker lane heals settings.json + two-up hook script', () => {
  resetWorkspaceStateDirCacheForTests();
  const root = makeMigratedRoot('workers/claude');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const agent = fakeAgent(path.join(root, '.dashboard', 'workers', 'claude'));
    supervisor.healLegacyStateDirScaffold(agent, 'windows');

    assert.ok(
      fs.existsSync(path.join(root, '.dashboard', 'workers', 'claude', '.claude', 'settings.json')),
      'worker settings.json must be healed into the legacy cwd',
    );
    assert.ok(
      fs.existsSync(path.join(root, '.dashboard', 'scripts', 'dashboard-status.mjs')),
      'the shared hook script must exist where the worker hooks resolve it (../../scripts)',
    );
  } finally {
    cleanup();
    rmrf(root);
  }
});

test('never overwrites: an existing legacy-cwd file is left byte-identical', () => {
  resetWorkspaceStateDirCacheForTests();
  const root = makeMigratedRoot('supervisor');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const settings = path.join(root, '.dashboard', 'supervisor', '.claude', 'settings.json');
    const userContent = '{ "hooks": { "custom": "user-modified — must survive the heal" } }\n';
    fs.writeFileSync(settings, userContent, 'utf-8');

    supervisor.healLegacyStateDirScaffold(fakeAgent(path.join(root, '.dashboard', 'supervisor')), 'windows');

    assert.equal(
      fs.readFileSync(settings, 'utf-8'),
      userContent,
      'heal must be existence-only: pre-existing files stay untouched',
    );
    // Missing siblings are still healed around the untouched file.
    assert.ok(
      fs.existsSync(path.join(root, '.dashboard', 'scripts', 'dashboard-status.mjs')),
      'missing sibling files are still written',
    );
  } finally {
    cleanup();
    rmrf(root);
  }
});

test('no-op: a cwd that is not a legacy state-dir lane writes nothing', () => {
  resetWorkspaceStateDirCacheForTests();
  const root = mktmp('heal-noop');
  fs.mkdirSync(path.join(root, '.lares'), { recursive: true });
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Workspace-root cwd (legacy unsupervised lane) — regex must not match.
    supervisor.healLegacyStateDirScaffold(fakeAgent(root), 'windows');
    // `.lares`-spelling cwd (post-rename agent) — regex must not match either.
    supervisor.healLegacyStateDirScaffold(fakeAgent(path.join(root, '.lares', 'supervisor')), 'windows');
    assert.ok(
      !fs.existsSync(path.join(root, '.dashboard')),
      'no legacy dir may be created for agents that never lived there',
    );
  } finally {
    cleanup();
    rmrf(root);
  }
});

test('no-op: workspace still on .dashboard (rename-failed fallback) — spellings agree, no heal', () => {
  resetWorkspaceStateDirCacheForTests();
  const root = mktmp('heal-legacy-ws');
  fs.mkdirSync(path.join(root, '.dashboard', 'supervisor', '.claude'), { recursive: true });
  const { supervisor, cleanup } = makeSupervisor();
  // Force the rename-failed branch: fail the migration rename so the resolver
  // caches `.dashboard` for this root (mirrors Windows EPERM on locked files).
  const origRename = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
    throw Object.assign(new Error('EPERM: simulated locked folder'), { code: 'EPERM' });
  };
  try {
    assert.equal(
      workspaceStateDirName(root, 'windows'),
      '.dashboard',
      'precondition: the workspace must resolve to the legacy spelling',
    );
    (fs as { renameSync: typeof fs.renameSync }).renameSync = origRename;
    supervisor.healLegacyStateDirScaffold(fakeAgent(path.join(root, '.dashboard', 'supervisor')), 'windows');
    assert.ok(
      !fs.existsSync(path.join(root, '.dashboard', 'supervisor', '.claude', 'settings.json')),
      'heal must not run when the workspace itself lives on the legacy spelling ' +
      '(the regular launch scaffold owns that case via translateStateRelPath)',
    );
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = origRename;
    cleanup();
    rmrf(root);
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
