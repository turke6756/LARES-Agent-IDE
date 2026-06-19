// Sysprompt-cleanup tests — Mechanic #3 (plans/persona-productization-impl.md §3).
//
// The CLI v2.1.156 `--append-system-prompt-file` workaround writes a per-launch
// `.sysprompt-<agentId>.txt` into the lane `.claude/` dir and nothing reaps it,
// so they accumulate forever. `sweepStaleSyspromptFiles` runs before each write
// and deletes only the orphans — files whose agent id is no longer live (status
// ∈ done/crashed/stopped, or unknown to the supervisor). A live co-tenant's file
// (lanes like .dashboard/workers/claude are shared by N agents) must survive.
//
// The helper reads liveness from getAllAgents() (module-level DB fn) and touches
// no instance state, so we stub getAllAgents on ../database and invoke the
// private method via the prototype — no AgentSupervisor construction, no DB init.
// Windows branch is the unit target; the WSL branch shells out to wsl.exe (same
// live-set logic) and is not exercised here.
//
//   npm run build:main
//   node dist/main/main/supervisor/sysprompt-cleanup.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as { AgentSupervisor: new () => unknown };

// Invoke the private sweep via the prototype with a bare `this` — it uses no
// instance state, only getAllAgents() + fs/execFileSync.
function sweep(claudeDir: string, pathType: string): void {
  (AgentSupervisor.prototype as unknown as {
    sweepStaleSyspromptFiles(d: string, p: string): void;
  }).sweepStaleSyspromptFiles.call({}, claudeDir, pathType);
}

function withLiveAgents<T>(agents: Array<{ id: string; status: string }>, fn: () => T): T {
  const orig = db.getAllAgents;
  db.getAllAgents = () => agents;
  try { return fn(); } finally { db.getAllAgents = orig; }
}

function freshClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdash-sysprompt-'));
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  return claude;
}
function syspromptName(id: string): string { return `.sysprompt-${id}.txt`; }
function exists(dir: string, name: string): boolean { return fs.existsSync(path.join(dir, name)); }

// ── Tests ────────────────────────────────────────────────────────────

test('sweep deletes a dead agent\'s sysprompt file and keeps a live co-tenant\'s', () => {
  const claude = freshClaudeDir();
  fs.writeFileSync(path.join(claude, syspromptName('live-1')), 'x', 'utf-8');
  fs.writeFileSync(path.join(claude, syspromptName('dead-1')), 'x', 'utf-8');
  withLiveAgents([{ id: 'live-1', status: 'working' }], () => sweep(claude, 'windows'));
  assert.ok(exists(claude, syspromptName('live-1')), 'live agent file must survive');
  assert.ok(!exists(claude, syspromptName('dead-1')), 'dead agent file must be reaped');
});

test('sweep reaps every dead status (done/crashed/stopped) but spares launching/working/idle', () => {
  const claude = freshClaudeDir();
  const ids = ['a-launching', 'b-working', 'c-idle', 'd-done', 'e-crashed', 'f-stopped'];
  for (const id of ids) fs.writeFileSync(path.join(claude, syspromptName(id)), 'x', 'utf-8');
  withLiveAgents([
    { id: 'a-launching', status: 'launching' },
    { id: 'b-working', status: 'working' },
    { id: 'c-idle', status: 'idle' },
    { id: 'd-done', status: 'done' },
    { id: 'e-crashed', status: 'crashed' },
    { id: 'f-stopped', status: 'stopped' },
  ], () => sweep(claude, 'windows'));
  assert.ok(exists(claude, syspromptName('a-launching')), 'launching is live');
  assert.ok(exists(claude, syspromptName('b-working')), 'working is live');
  assert.ok(exists(claude, syspromptName('c-idle')), 'idle is live');
  assert.ok(!exists(claude, syspromptName('d-done')), 'done is reaped');
  assert.ok(!exists(claude, syspromptName('e-crashed')), 'crashed is reaped');
  assert.ok(!exists(claude, syspromptName('f-stopped')), 'stopped is reaped');
});

test('sweep reaps a sysprompt file whose agent is unknown to the supervisor', () => {
  const claude = freshClaudeDir();
  fs.writeFileSync(path.join(claude, syspromptName('ghost')), 'x', 'utf-8');
  // No agents tracked at all → ghost is not live → reaped.
  withLiveAgents([], () => sweep(claude, 'windows'));
  assert.ok(!exists(claude, syspromptName('ghost')), 'untracked agent file is reaped');
});

test('sweep never touches non-sysprompt files (settings.json, prompt files, skills)', () => {
  const claude = freshClaudeDir();
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}', 'utf-8');
  fs.writeFileSync(path.join(claude, '.prompt-dead-1.txt'), 'x', 'utf-8'); // different prefix
  fs.writeFileSync(path.join(claude, syspromptName('dead-1')), 'x', 'utf-8');
  withLiveAgents([], () => sweep(claude, 'windows'));
  assert.ok(exists(claude, 'settings.json'), 'settings.json untouched');
  assert.ok(exists(claude, '.prompt-dead-1.txt'), 'unrelated .prompt- file untouched');
  assert.ok(!exists(claude, syspromptName('dead-1')), 'only the matching sysprompt orphan is removed');
});

test('sweep is best-effort: a missing dir does not throw', () => {
  const missing = path.join(os.tmpdir(), 'agentdash-sysprompt-does-not-exist-xyz', '.claude');
  withLiveAgents([], () => {
    assert.doesNotThrow(() => sweep(missing, 'windows'), 'a readdir failure must be swallowed');
  });
});

// ── Runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
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
