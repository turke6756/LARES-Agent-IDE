// persona-scanner tests — Agent-type redesign relocates custom-agent personas
// from the legacy .claude/agents/ path to .dashboard/agents/.
//
// Covers (windows pathType only — the wsl branch shells out to wsl.exe and is
// not exercised here):
//   1. scaffoldPersona writes into .dashboard/agents/<name>/ (NOT .claude/agents).
//   2. scanPersonas reads personas from .dashboard/agents/.
//   3. migratePersonas copies legacy .claude/agents/<name>/ into
//      .dashboard/agents/, skips the supervisor, and never clobbers an existing
//      .dashboard/agents/ entry.
//   4. scanPersonas runs the migration implicitly (legacy persona shows up).
//
//   npm run build:main
//   node dist/main/main/persona-scanner.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanPersonas, scaffoldPersona, migratePersonas } from './persona-scanner';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function freshWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdash-persona-'));
}

function writeLegacyPersona(ws: string, name: string, body = `# ${name}\n`): void {
  const dir = path.join(ws, '.claude', 'agents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body, 'utf-8');
}

// ── scaffoldPersona ──────────────────────────────────────────────────

test('scaffoldPersona writes into .dashboard/agents/<name>/, not .claude/agents/', () => {
  const ws = freshWorkspace();
  const persona = scaffoldPersona(ws, 'windows', 'builder', '# Builder\n');
  const expectedDir = path.join(ws, '.dashboard', 'agents', 'builder');
  assert.equal(persona.directory, expectedDir);
  assert.ok(fs.existsSync(path.join(expectedDir, 'CLAUDE.md')), 'CLAUDE.md should exist in .dashboard/agents');
  assert.ok(fs.existsSync(path.join(expectedDir, 'memory', 'MEMORY.md')), 'memory seed should exist');
  assert.ok(!fs.existsSync(path.join(ws, '.claude', 'agents', 'builder')), 'must NOT write under .claude/agents');
  assert.equal(fs.readFileSync(path.join(expectedDir, 'CLAUDE.md'), 'utf-8'), '# Builder\n');
});

// ── scanPersonas ─────────────────────────────────────────────────────

test('scanPersonas finds personas under .dashboard/agents/', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'alpha');
  scaffoldPersona(ws, 'windows', 'beta');
  const names = scanPersonas(ws, 'windows').map(p => p.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);
});

// ── migratePersonas ──────────────────────────────────────────────────

test('migratePersonas copies legacy .claude/agents personas into .dashboard/agents', () => {
  const ws = freshWorkspace();
  writeLegacyPersona(ws, 'legacy-one', '# Legacy One\n');
  migratePersonas(ws, 'windows');
  const dst = path.join(ws, '.dashboard', 'agents', 'legacy-one', 'CLAUDE.md');
  assert.ok(fs.existsSync(dst), 'legacy persona should be copied to .dashboard/agents');
  assert.equal(fs.readFileSync(dst, 'utf-8'), '# Legacy One\n');
  // Non-destructive: legacy copy is left in place.
  assert.ok(fs.existsSync(path.join(ws, '.claude', 'agents', 'legacy-one', 'CLAUDE.md')));
});

test('migratePersonas does not clobber an existing .dashboard/agents entry', () => {
  const ws = freshWorkspace();
  writeLegacyPersona(ws, 'dup', '# Legacy version\n');
  scaffoldPersona(ws, 'windows', 'dup', '# Dashboard version\n');
  migratePersonas(ws, 'windows');
  const dst = path.join(ws, '.dashboard', 'agents', 'dup', 'CLAUDE.md');
  assert.equal(fs.readFileSync(dst, 'utf-8'), '# Dashboard version\n', 'existing entry must win');
});

test('migratePersonas skips the supervisor persona', () => {
  const ws = freshWorkspace();
  writeLegacyPersona(ws, 'supervisor', '# Supervisor\n');
  migratePersonas(ws, 'windows');
  assert.ok(!fs.existsSync(path.join(ws, '.dashboard', 'agents', 'supervisor')), 'supervisor must not migrate into agents/');
});

test('migratePersonas is a no-op when there is no legacy dir', () => {
  const ws = freshWorkspace();
  migratePersonas(ws, 'windows'); // must not throw
  assert.ok(!fs.existsSync(path.join(ws, '.dashboard', 'agents')));
});

test('scanPersonas implicitly migrates legacy personas', () => {
  const ws = freshWorkspace();
  writeLegacyPersona(ws, 'auto-migrated');
  const names = scanPersonas(ws, 'windows').map(p => p.name);
  assert.deepEqual(names, ['auto-migrated']);
  assert.ok(fs.existsSync(path.join(ws, '.dashboard', 'agents', 'auto-migrated', 'CLAUDE.md')));
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
