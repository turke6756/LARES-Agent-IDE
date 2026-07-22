// Class IV worker-scaffold tests — plans/class-iv-worker-hook-scaffold.md §12.
//
// Exercises the per-provider branches of AgentSupervisor.ensureWorkerScaffold:
//   1. Claude: writes .lares/scripts/dashboard-status.mjs +
//      .lares/workers/claude/{CLAUDE.md,.claude/settings.json} verbatim
//      (path expansion deferred to Claude Code's ${CLAUDE_PROJECT_DIR}).
//   2. Codex: writes the shared script + .lares/workers/codex/.codex/config.toml
//      with ${WORKSPACE_ROOT} replaced by the absolute workspace path.
//   3. Never-overwrite: re-running on the same workDir does not clobber an
//      existing settings.json / config.toml.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/worker-scaffold.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// Minimal DB patching: ensureWorkerScaffold only calls addEvent on success.
function patchDb(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  return () => {
    db.addEvent = origAddEvent;
  };
}

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
  return dir;
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

type SupervisorWithScaffold = {
  ensureWorkerScaffold: (workDir: string, provider: string, pathType: string) => void;
  ensureSupervisorScaffold: (workDir: string, pathType: string) => void;
};

function makeSupervisor(): { supervisor: SupervisorWithScaffold; cleanup: () => void } {
  const restoreDb = patchDb();
  const raw = new AgentSupervisor();
  (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const supervisor = raw as unknown as SupervisorWithScaffold;
  return { supervisor, cleanup: restoreDb };
}

// ── Tests ────────────────────────────────────────────────────────────

test('Codex: scaffold writes .codex/config.toml with absolute workspace path interpolated', () => {
  const workDir = mktmp('codex-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);

    const content = fs.readFileSync(configPath, 'utf-8');

    // Stop hook table must be present (TOML array-of-tables syntax).
    assert.ok(content.includes('[[hooks.Stop]]'), `config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `config.toml missing [[hooks.Stop.hooks]]: ${content}`);
    assert.ok(content.includes('type = "command"'), `config.toml missing type=command: ${content}`);

    // Absolute path materialized at scaffold time — no unresolved placeholder.
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );

    // Forward-slash normalized workspace path appears in the command.
    const expectedScriptPath = `${workDir.replace(/\\/g, '/')}/.lares/scripts/dashboard-status.mjs`;
    assert.ok(
      content.includes(expectedScriptPath),
      `config.toml does not reference the workspace's dashboard-status.mjs path. Expected substring: ${expectedScriptPath}\nGot: ${content}`,
    );

    // The shared script is also written.
    const scriptPath = path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs');
    assert.ok(fs.existsSync(scriptPath), `expected shared hook script at ${scriptPath}`);

    // Negative: codex scaffold must not write the Claude-side worker files.
    const claudeSettings = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(
      !fs.existsSync(claudeSettings),
      `codex scaffold should not create ${claudeSettings}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: never overwrites existing config.toml on second scaffold call', () => {
  const workDir = mktmp('codex-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    const sentinel = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(configPath, sentinel, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const after = fs.readFileSync(configPath, 'utf-8');
    assert.equal(
      after,
      sentinel,
      `second scaffold call must not overwrite user-edited config.toml; got: ${after}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: WSL scaffold writes config.toml with /mnt-style absolute path', () => {
  const workDir = mktmp('codex-wsl');
  const { supervisor, cleanup } = makeSupervisor();

  // The WSL branch of writeScaffoldMap shells out to wsl.exe — for a unit
  // test we only care about what content WOULD be written. Stub
  // writeScaffoldMap on the instance to capture the file map and skip the
  // actual write.
  const captured: Record<string, string> = {};
  (supervisor as unknown as {
    writeScaffoldMap: (
      wd: string,
      files: Record<string, { content: string; executable?: boolean }>,
      pt: string,
    ) => number;
  }).writeScaffoldMap = (_wd, files, _pt) => {
    for (const [rel, { content }] of Object.entries(files)) {
      captured[rel] = content;
    }
    return Object.keys(files).length;
  };

  try {
    // workDir is a real Windows tmp path (e.g. C:\Users\...\Temp\...). The
    // expected conversion for WSL: drive letter → /mnt/<lowercase>/<rest>.
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'wsl');

    const configRel = '.lares/workers/codex/.codex/config.toml';
    const content = captured[configRel];
    assert.ok(content, `expected captured ${configRel}; got keys: ${Object.keys(captured).join(', ')}`);

    // Derive expected /mnt path from the actual tmp workDir's drive letter.
    const driveMatch = workDir.match(/^([A-Za-z]):\\(.*)/);
    assert.ok(driveMatch, `tmp workDir should look like 'X:\\...'; got: ${workDir}`);
    const expectedDrive = driveMatch![1].toLowerCase();
    const expectedRest = driveMatch![2].replace(/\\/g, '/');
    const expectedPrefix = `/mnt/${expectedDrive}/${expectedRest}`;

    assert.ok(
      content.includes(`${expectedPrefix}/.lares/scripts/dashboard-status.mjs`),
      `WSL config.toml should reference /mnt/${expectedDrive}/... path. Expected substring: ${expectedPrefix}/.lares/scripts/dashboard-status.mjs\nGot: ${content}`,
    );

    // Negative: no leftover Windows-style C:/ in the rendered TOML.
    assert.ok(
      !/[A-Za-z]:\//.test(content),
      `WSL config.toml should not contain Windows drive paths like C:/; got: ${content}`,
    );

    // Standard invariants (placeholder resolved, Stop hook table present).
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `WSL config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );
    assert.ok(content.includes('[[hooks.Stop]]'), `WSL config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `WSL config.toml missing [[hooks.Stop.hooks]]: ${content}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold writes .claude/settings.json verbatim (no path materialization)', () => {
  const workDir = mktmp('claude-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const settingsPath = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `expected ${settingsPath}`);

    const content = fs.readFileSync(settingsPath, 'utf-8');

    // Claude's settings keep ${CLAUDE_PROJECT_DIR} unexpanded — Claude Code
    // expands at hook fire time.
    assert.ok(
      content.includes('${CLAUDE_PROJECT_DIR}'),
      `Claude settings.json should retain \${CLAUDE_PROJECT_DIR}; got: ${content}`,
    );

    // Negative: claude scaffold must not write the codex config.
    const codexConfig = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(
      !fs.existsSync(codexConfig),
      `claude scaffold should not create ${codexConfig}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold seeds the shared behavioral.md worker memory', () => {
  const workDir = mktmp('claude-worker-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const memPath = path.join(workDir, '.lares', 'workers', 'claude', 'behavioral.md');
    assert.ok(fs.existsSync(memPath), `expected ${memPath}`);

    const content = fs.readFileSync(memPath, 'utf-8');
    assert.ok(
      content.includes('# Worker Behavioral Memory'),
      `behavioral.md should carry the seed header; got: ${content.slice(0, 120)}`,
    );
    // Behavioral-only contract must be stated so workers don't dump task state.
    assert.ok(
      content.includes('Behavioral, not project'),
      'behavioral.md seed should state the behavioral-not-project rule',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: behavioral.md is never overwritten once a worker has edited it', () => {
  const workDir = mktmp('claude-worker-memory-durable');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // First launch seeds it.
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    const memPath = path.join(workDir, '.lares', 'workers', 'claude', 'behavioral.md');

    // A worker appends a lesson — exactly the edit the scaffold must preserve.
    const appended = '\n\n## WB-99: test-appended lesson — must survive relaunch\n';
    fs.appendFileSync(memPath, appended, 'utf-8');

    // Second launch (relaunch / another worker) must leave the edit untouched —
    // unlike the version-managed CLAUDE.md, this file is seed-once.
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const after = fs.readFileSync(memPath, 'utf-8');
    assert.ok(
      after.includes('WB-99: test-appended lesson'),
      'worker-appended entry must survive a second scaffold pass',
    );
    // And no .bak file was spawned for it (managed-file overwrite signature).
    const dir = path.dirname(memPath);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('behavioral.md.bak'));
    assert.equal(baks.length, 0, `behavioral.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: scaffold seeds memory/MEMORY.md', () => {
  const workDir = mktmp('supervisor-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');
    assert.ok(fs.existsSync(memPath), `expected ${memPath}`);

    const content = fs.readFileSync(memPath, 'utf-8');
    assert.ok(
      content.includes('# Supervisor Memory'),
      `MEMORY.md should carry the seed header; got: ${content.slice(0, 120)}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: MEMORY.md is seed-once — an edited copy survives relaunch byte-identical, no .bak', () => {
  // Regression guard: MEMORY.md must NOT live in the version-managed
  // SUPERVISOR_FILES map. If it did, a future SUPERVISOR_MEMORY_MD version
  // bump would treat an edited MEMORY.md as "user-modified, unknown hash" and
  // `.bak` + overwrite it, wiping accumulated supervisor memory. The seed-once
  // contract (seedSupervisorMemoryIfAbsent) means a second scaffold pass never
  // touches an existing file regardless of any notional version change.
  const workDir = mktmp('supervisor-memory-durable');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // First launch seeds it.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');

    // The supervisor (or human) curates memory across sessions — simulate an
    // edit that the scaffold must preserve verbatim.
    const edited = '# Supervisor Memory\n\n- [SM-99] curated note that must survive relaunch\n';
    fs.writeFileSync(memPath, edited, 'utf-8');
    const before = fs.readFileSync(memPath); // raw bytes

    // Second launch (relaunch / re-open workspace). Even if SUPERVISOR_MEMORY_MD
    // were bumped to a new version, MEMORY.md is no longer in the managed map,
    // so this pass must leave the edit untouched.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const after = fs.readFileSync(memPath);
    assert.ok(
      before.equals(after),
      `edited MEMORY.md must survive a second scaffold pass byte-identical; before=${before.length}B after=${after.length}B`,
    );

    // And no .bak file was spawned for it (the managed-file overwrite signature).
    const dir = path.dirname(memPath);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('MEMORY.md.bak'));
    assert.equal(baks.length, 0, `MEMORY.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
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
