// persona-scanner tests — Agent-type redesign relocates custom-agent personas
// from the legacy .claude/agents/ path to .dashboard/agents/, and #18 adds the
// per-persona kit (managed settings.json + skills), seed-once identity files
// (CLAUDE.md rendered from PERSONA_AGENT_MD_TEMPLATE, MEMORY.md), the
// write-if-absent persona.json lane sidecar, and the launch-input lane mapper.
//
// Covers (windows pathType only — the wsl branch shells out to wsl.exe and is
// not exercised here):
//   1. scaffoldPersona writes the kit + seed-once identity into
//      .dashboard/agents/<name>/ (NOT .claude/agents); the managed sidecar lists
//      only the operational kit, never CLAUDE.md/MEMORY.md/persona.json.
//   2. lane sidecar: write-if-absent persona.json, readPersonaLane, scanPersonas
//      surfacing the declared lane, invalid-lane rejection.
//   3. seed-once: CLAUDE.md (D4) + MEMORY.md are never overwritten; the
//      operational kit (settings.json) still upgrades when deleted.
//   4. applyPersonaLaneToLaunchInput maps the declared lane onto launch flags.
//   5. migratePersonas copies legacy .claude/agents/<name>/ into
//      .dashboard/agents/, skips the supervisor, and never clobbers an existing
//      .dashboard/agents/ entry.
//
//   npm run build:main
//   node dist/main/main/persona-scanner.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  scanPersonas, scaffoldPersona, migratePersonas,
  ensurePersonaScaffold, readPersonaLane, applyPersonaLaneToLaunchInput,
} from './persona-scanner';

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

function agentFile(ws: string, name: string, ...rel: string[]): string {
  return path.join(ws, '.dashboard', 'agents', name, ...rel);
}
function readSidecar(ws: string): Record<string, number> {
  const p = path.join(ws, '.dashboard', '.scaffold-versions.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
}

// ── scaffoldPersona: kit + seed-once identity ────────────────────────

test('scaffoldPersona writes into .dashboard/agents/<name>/, not .claude/agents/', () => {
  const ws = freshWorkspace();
  const persona = scaffoldPersona(ws, 'windows', 'builder', '# Builder');
  const expectedDir = path.join(ws, '.dashboard', 'agents', 'builder');
  assert.equal(persona.directory, expectedDir);
  assert.equal(persona.lane, undefined, 'no lane declared → undefined');
  // Identity (seed-once) + operational kit all present.
  assert.ok(fs.existsSync(agentFile(ws, 'builder', 'CLAUDE.md')), 'CLAUDE.md should exist');
  assert.ok(fs.existsSync(agentFile(ws, 'builder', 'memory', 'MEMORY.md')), 'memory seed should exist');
  assert.ok(fs.existsSync(agentFile(ws, 'builder', '.claude', 'settings.json')), 'settings.json kit should exist');
  assert.ok(fs.existsSync(agentFile(ws, 'builder', '.claude', 'skills', 'create-persona', 'SKILL.md')), 'create-persona skill should exist');
  assert.ok(fs.existsSync(agentFile(ws, 'builder', '.claude', 'skills', 'read-comments', 'SKILL.md')), 'read-comments skill should exist');
  assert.ok(!fs.existsSync(path.join(ws, '.claude', 'agents', 'builder')), 'must NOT write under .claude/agents');
  // CLAUDE.md is rendered from the template: displayName header + role body.
  const claudeMd = fs.readFileSync(agentFile(ws, 'builder', 'CLAUDE.md'), 'utf-8');
  assert.ok(claudeMd.startsWith('# Builder Agent\n'), 'CLAUDE.md carries the rendered displayName header');
  assert.ok(claudeMd.includes('# Builder'), 'CLAUDE.md embeds the role body');
  assert.ok(!claudeMd.includes('${'), 'no unsubstituted template placeholders remain');
  // No persona.json without a declared lane.
  assert.ok(!fs.existsSync(agentFile(ws, 'builder', 'persona.json')), 'no persona.json without a lane');
  // Managed sidecar lists ONLY the operational kit, never identity/sidecar files.
  const sc = readSidecar(ws);
  assert.ok('agents/builder/.claude/settings.json' in sc, 'settings.json is managed');
  assert.ok('agents/builder/.claude/skills/create-persona/SKILL.md' in sc, 'create-persona skill is managed');
  assert.ok('agents/builder/.claude/skills/read-comments/SKILL.md' in sc, 'read-comments skill is managed');
  assert.ok(!('agents/builder/CLAUDE.md' in sc), 'CLAUDE.md must NOT be managed (seed-once)');
  assert.ok(!('agents/builder/memory/MEMORY.md' in sc), 'MEMORY.md must NOT be managed (seed-once)');
  assert.ok(!('agents/builder/persona.json' in sc), 'persona.json must NOT be managed');
});

// ── lane sidecar (D3 / D7) ───────────────────────────────────────────

test('scaffoldPersona(..., "worker") writes persona.json and surfaces the lane', () => {
  const ws = freshWorkspace();
  const persona = scaffoldPersona(ws, 'windows', 'coordinator', undefined, 'worker');
  const pj = agentFile(ws, 'coordinator', 'persona.json');
  assert.ok(fs.existsSync(pj), 'persona.json should exist when a lane is declared');
  assert.deepEqual(JSON.parse(fs.readFileSync(pj, 'utf-8')), { lane: 'worker' });
  assert.equal(persona.lane, 'worker', 'returned persona carries the lane');
  assert.equal(readPersonaLane(ws, 'windows', 'coordinator'), 'worker');
  const scanned = scanPersonas(ws, 'windows').find(p => p.name === 'coordinator');
  assert.equal(scanned?.lane, 'worker', 'scanPersonas surfaces the declared lane');
});

test('scaffoldPersona rejects an invalid lane', () => {
  const ws = freshWorkspace();
  assert.throws(() => scaffoldPersona(ws, 'windows', 'bogus-lane', undefined, 'bogus' as any),
    /Invalid persona lane/);
});

test('persona.json (lane sidecar) is preserved byte-for-byte across kit upgrades', () => {
  const ws = freshWorkspace();
  // Pre-create the persona dir with a hand-declared supervisor lane.
  fs.mkdirSync(agentFile(ws, 'orchestra'), { recursive: true });
  const pj = agentFile(ws, 'orchestra', 'persona.json');
  fs.writeFileSync(pj, '{ "lane": "supervisor" }\n', 'utf-8'); // intentionally non-canonical spacing
  const before = fs.readFileSync(pj, 'utf-8');
  ensurePersonaScaffold(ws, 'windows', 'orchestra');
  ensurePersonaScaffold(ws, 'windows', 'orchestra');
  assert.equal(fs.readFileSync(pj, 'utf-8'), before, 'persona.json is never rewritten by the scaffolder');
  assert.equal(readPersonaLane(ws, 'windows', 'orchestra'), 'supervisor');
});

// ── seed-once identity (D4, MEMORY) ──────────────────────────────────

test('ensurePersonaScaffold leaves a hand-written CLAUDE.md byte-unchanged (D4 seed-once)', () => {
  const ws = freshWorkspace();
  // Simulate a legacy hand-written persona (e.g. mr-job-hunt-agent).
  fs.mkdirSync(agentFile(ws, 'mr-job-hunt-agent'), { recursive: true });
  const claudeMd = agentFile(ws, 'mr-job-hunt-agent', 'CLAUDE.md');
  const handWritten = '# Mr Job Hunt\n\nMy own carefully crafted identity. Do not touch.\n';
  fs.writeFileSync(claudeMd, handWritten, 'utf-8');
  ensurePersonaScaffold(ws, 'windows', 'mr-job-hunt-agent');
  ensurePersonaScaffold(ws, 'windows', 'mr-job-hunt-agent'); // idempotent
  assert.equal(fs.readFileSync(claudeMd, 'utf-8'), handWritten, 'CLAUDE.md is never overwritten');
  // No .bak, no CLAUDE.local.md.
  const entries = fs.readdirSync(agentFile(ws, 'mr-job-hunt-agent'));
  assert.ok(!entries.some(e => e.includes('.bak')), 'no .bak written for CLAUDE.md');
  assert.ok(!entries.includes('CLAUDE.local.md'), 'no CLAUDE.local.md created');
  // CLAUDE.md is absent from the managed sidecar (only the kit is managed).
  assert.ok(!('agents/mr-job-hunt-agent/CLAUDE.md' in readSidecar(ws)), 'CLAUDE.md is not managed');
  // The operational kit was still ensured.
  assert.ok(fs.existsSync(agentFile(ws, 'mr-job-hunt-agent', '.claude', 'settings.json')), 'kit settings.json ensured');
});

test('ensurePersonaScaffold leaves an edited MEMORY.md byte-unchanged (seed-once)', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'notetaker');
  const mem = agentFile(ws, 'notetaker', 'memory', 'MEMORY.md');
  const edited = '# Memory Index\n\n- learned something durable\n';
  fs.writeFileSync(mem, edited, 'utf-8');
  ensurePersonaScaffold(ws, 'windows', 'notetaker');
  assert.equal(fs.readFileSync(mem, 'utf-8'), edited, 'MEMORY.md is never overwritten');
});

test('ensurePersonaScaffold re-writes a deleted operational kit file (plumbing is ensured)', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'worker-bee');
  const settings = agentFile(ws, 'worker-bee', '.claude', 'settings.json');
  fs.rmSync(settings);
  assert.ok(!fs.existsSync(settings));
  ensurePersonaScaffold(ws, 'windows', 'worker-bee');
  assert.ok(fs.existsSync(settings), 'deleted settings.json is restored by the managed kit');
});

// ── applyPersonaLaneToLaunchInput (D6) ───────────────────────────────

test('applyPersonaLaneToLaunchInput maps each declared lane onto launch flags', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'p-sup', undefined, 'supervisor');
  scaffoldPersona(ws, 'windows', 'p-res', undefined, 'researcher');
  scaffoldPersona(ws, 'windows', 'p-wrk', undefined, 'worker');

  const sup: any = { persona: 'p-sup' };
  applyPersonaLaneToLaunchInput(sup, ws, 'windows');
  assert.equal(sup.isSupervisor, true);

  const res: any = { persona: 'p-res', provider: 'codex' };
  applyPersonaLaneToLaunchInput(res, ws, 'windows');
  assert.equal(res.isResearcher, true);
  assert.equal(res.isSupervised, true);
  assert.equal(res.provider, 'claude', 'researcher lane forces provider=claude');

  const wrk: any = { persona: 'p-wrk' };
  applyPersonaLaneToLaunchInput(wrk, ws, 'windows');
  assert.equal(wrk.isWorker, true);
});

test('applyPersonaLaneToLaunchInput is a no-op for a persona with no declared lane', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'plain');
  const input: any = { persona: 'plain' };
  applyPersonaLaneToLaunchInput(input, ws, 'windows');
  assert.deepEqual(input, { persona: 'plain' }, 'no flags added without a declared lane');
});

test('applyPersonaLaneToLaunchInput throws on a conflicting explicit flag, no-ops on a matching one', () => {
  const ws = freshWorkspace();
  scaffoldPersona(ws, 'windows', 'p-worker', undefined, 'worker');
  // Conflict: persona declares worker, launch requested supervisor.
  assert.throws(() => applyPersonaLaneToLaunchInput({ persona: 'p-worker', isSupervisor: true } as any, ws, 'windows'),
    /declares lane "worker"/);
  // Matching: persona declares worker, launch already worker → no-op (no throw).
  const matching: any = { persona: 'p-worker', isWorker: true };
  applyPersonaLaneToLaunchInput(matching, ws, 'windows');
  assert.equal(matching.isWorker, true);
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
  scaffoldPersona(ws, 'windows', 'dup', '# Dashboard version');
  migratePersonas(ws, 'windows');
  const dst = path.join(ws, '.dashboard', 'agents', 'dup', 'CLAUDE.md');
  const body = fs.readFileSync(dst, 'utf-8');
  // The existing dashboard entry (template-rendered, with the dashboard role
  // body) must win — migration must not overwrite it with the legacy content.
  assert.ok(body.includes('# Dashboard version'), 'existing dashboard entry must win');
  assert.ok(!body.includes('# Legacy version'), 'legacy content must NOT clobber the existing entry');
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
