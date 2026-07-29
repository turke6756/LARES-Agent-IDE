// remember-provisioning.test.ts — WP-F1 acceptance: the `remember` skill is
// present at EVERY provisioned lane/provider location from WP-R's verdict.
//
// WP-R proved the per-cwd set of four roots (Claude + Codex, supervisor +
// worker). `lessonTargetRelPaths('remember')` is the canonical enumeration of
// those roots; this test asserts each is actually a scaffold-map entry mapping to
// REMEMBER_SKILL:
//   - Claude supervisor  → SUPERVISOR_FILES       (`.claude/skills/`)
//   - Codex  supervisor  → SUPERVISOR_FILES_CODEX (`.agents/skills/`)
//   - Claude worker      → WORKER_FILES_CLAUDE     (`.claude/skills/`)
//   - Codex  worker      → the codexFiles map, verified by a real scaffold write
//
//   npm run build:main
//   node dist/main/main/supervisor/remember-provisioning.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import { REMEMBER_SKILL } from '../../shared/constants';
import { lessonTargetRelPaths } from '../memory-index/skill-provisioning';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

type ScaffoldMap = Record<string, { content: string; version: number; previousHashes?: Record<number, string> }>;
const statics = AgentSupervisor as unknown as {
  SUPERVISOR_FILES: ScaffoldMap;
  SUPERVISOR_FILES_CODEX: ScaffoldMap;
  WORKER_FILES_CLAUDE: ScaffoldMap;
};

const ROOTS = lessonTargetRelPaths('remember');
const [CLAUDE_SUP, CLAUDE_WORKER, CODEX_SUP, CODEX_WORKER] = ROOTS;

test('lessonTargetRelPaths(remember) enumerates exactly the four WP-R roots', () => {
  assert.deepEqual(ROOTS, [
    '.lares/supervisor/.claude/skills/remember/SKILL.md',
    '.lares/workers/claude/.claude/skills/remember/SKILL.md',
    '.lares/supervisor/.agents/skills/remember/SKILL.md',
    '.lares/workers/codex/.agents/skills/remember/SKILL.md',
  ]);
});

test('the Claude-supervisor remember copy is a new-skill entry in SUPERVISOR_FILES', () => {
  const e = statics.SUPERVISOR_FILES[CLAUDE_SUP];
  assert.ok(e, `SUPERVISOR_FILES has ${CLAUDE_SUP}`);
  assert.equal(e.content, REMEMBER_SKILL);
  assert.equal(e.version, 1);
  assert.equal(e.previousHashes, undefined, 'new-skill shape: no previousHashes');
});

test('the Codex-supervisor remember copy is a new-skill entry in SUPERVISOR_FILES_CODEX', () => {
  const e = statics.SUPERVISOR_FILES_CODEX[CODEX_SUP];
  assert.ok(e, `SUPERVISOR_FILES_CODEX has ${CODEX_SUP}`);
  assert.equal(e.content, REMEMBER_SKILL);
  assert.equal(e.version, 1);
  assert.equal(e.previousHashes, undefined);
});

test('the Claude-worker remember copy is a new-skill entry in WORKER_FILES_CLAUDE', () => {
  const e = statics.WORKER_FILES_CLAUDE[CLAUDE_WORKER];
  assert.ok(e, `WORKER_FILES_CLAUDE has ${CLAUDE_WORKER}`);
  assert.equal(e.content, REMEMBER_SKILL);
  assert.equal(e.version, 1);
  assert.equal(e.previousHashes, undefined);
});

test('a real Codex-worker scaffold write lands the remember copy under .agents/skills/', () => {
  // ensureWorkerScaffold builds the codexFiles map inline, so verify it by
  // actually running a windows-pathType scaffold into a temp workspace and
  // asserting the file materializes with REMEMBER_SKILL content. addEvent is
  // stubbed (no DB), mirroring scaffold-version-migration.test.ts's helper.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-codex-'));
  try {
    const raw = new AgentSupervisor();
    (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
    (raw as unknown as { ensureWorkerScaffold(w: string, p: string, t: string): void })
      .ensureWorkerScaffold(wd, 'codex', 'windows');
    const landed = path.join(wd, CODEX_WORKER);
    assert.ok(fs.existsSync(landed), `${CODEX_WORKER} was scaffolded`);
    assert.equal(fs.readFileSync(landed, 'utf8'), REMEMBER_SKILL);
  } finally {
    db.addEvent = origAddEvent;
    try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Run ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
